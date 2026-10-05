/**
 * 交易写入编排（Phase 8 / W4）
 *
 * ## 为什么必须有这一层（Step 1 发现的 Domain 缺口）
 *
 * W4 需要让用户录入 9 种交易。若让每个表单各自编排写入，就会出现
 * **「写了交易但没重建缓存」「重建了但没对账」** 这类不一致 ——
 * 也就是用户明确警告的「在 UI 层打补丁」。
 *
 * 因此把唯一的写入路径收敛到这里：
 *
 * ```
 * UI → TransactionService.recordTransaction()
 *        ↓
 *      ① 参数校验（业务前置检查）
 *      ② 构造 Transaction
 *      ③ **在内存中试算**：追加后跑 deriveLedger
 *      ④ 校验交易语义（超卖 / 币种不一致 / 缺目标账户 …）
 *      ⑤ 校验账户与标的存在、无重复持仓
 *      ⑥ 校验持仓数量不为负
 *      ⑦ rebuildHoldingsFromTransactions()  ← 从 Ledger 重建缓存
 *      ⑧ reconcileHoldings()                ← 账实校验
 *      ⑨ 全部通过 → 一次性整体写入 IndexedDB
 *        ↓
 *      IndexedDB（唯一事实源）
 * ```
 *
 * **任何一步失败都返回 `{ ok: false }`，绝不写入任何数据。**
 * 不存在「交易写进去了但缓存是旧的」这种中间态。
 *
 * ## 为什么先试算再写入
 *
 * `deriveLedger` 对超卖只**记录 issue**、并把数量截断到 0（`Holding.quantity`
 * 的类型不允许负数）。如果直接落库，账本就被写成了一个不可能的状态。
 * 因此本层在**写入前**用试算结果判定，拒绝而不是静默截断。
 *
 * ## 与既有领域逻辑的关系
 *
 * 本层**不重新实现**任何金融计算：
 * - 效果推导 → `deriveLedger` / `deriveLedgerEffects`（Phase 3/5）
 * - 成本口径 → 移动加权平均（Phase 3）
 * - 缓存重建 → `rebuildHoldingsFromTransactions`（Phase 5）
 * - 账实校验 → `reconcileHoldings`（Phase 3/5）
 * - 外部现金流语义 → 由 `TransactionType` 决定（Phase 4）
 */

import type {
  AllocationProfile,
  Holding,
  Portfolio2,
  Transaction,
  TransactionType,
  CurrencyCode,
} from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { type LedgerIssue, deriveLedger, positionKey } from '../ledger/derive'
import { detectDuplicateHoldings } from '../ledger/duplicates'
import { ledgerOptionsFor, rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { reconcileHoldings } from '../ledger/reconcile'
import { TRANSACTION_SEMANTICS } from '../ledger/types'
import { isVoided, transactionStatus } from './lifecycle'

/* ------------------------------------------------------------------ *
 * 精度
 * ------------------------------------------------------------------ */

/**
 * 金额/数量比较容差（人民币与原币数量共用）。
 *
 * 与项目既有约定一致（Phase 4/5 使用 0.01 级别的容差）。
 * **UI 层不得另创一套 rounding** —— 一律引用这里。
 */
export const TRANSACTION_TOLERANCE = 0.01

const EPS = 1e-8

/* ------------------------------------------------------------------ *
 * 输入
 * ------------------------------------------------------------------ */

export interface RecordTransactionInput {
  type: TransactionType
  accountId: string
  /** 投资标的（buy/sell/dividend/interest/adjustment 必填） */
  instrumentId?: string
  /** 资金腿现金标的（buy/sell/deposit/withdraw/dividend/interest/fee/exchange 用） */
  cashInstrumentId?: string
  /** 划转目标账户 */
  toAccountId?: string
  /** 部分划转数量 */
  transferQuantity?: number
  /** 换汇目标现金标的 */
  toCashInstrumentId?: string
  /** 金额（原币） */
  amount: number
  /** 数量（buy/sell/adjustment） */
  quantity?: number
  /** 手续费（原币） */
  fee?: number
  /** 币种 */
  currency: CurrencyCode
  /** 换汇到账金额 */
  toAmount?: number
  /** 换汇目标币种 */
  toCurrency?: CurrencyCode
  /** ISO 时间戳 */
  timestamp: string
  note?: string
  /** 可选：显式指定交易 id（测试用） */
  id?: string
}

export type RecordFailureCode =
  | 'unknown-type'
  | 'missing-account'
  | 'unknown-account'
  | 'missing-instrument'
  | 'unknown-instrument'
  | 'missing-cash-instrument'
  | 'missing-transfer-target'
  | 'unknown-transfer-target'
  | 'not-enough-holding'
  | 'negative-holding'
  | 'ledger-issue'
  | 'duplicate-holding'
  | 'reconcile-failed'
  | 'invalid-input'
  /** 交易不存在 */
  | 'not-found'
  /** 交易已经作废（防止重复作废） */
  | 'already-voided'
  /** 作废会导致负数持仓 / 负成本 */
  | 'would-cause-negative'

export interface RecordFailure {
  ok: false
  code: RecordFailureCode
  /** 面向用户的可读说明 */
  message: string
  /** 原始领域问题（便于排查） */
  issues?: LedgerIssue[]
}

export interface RecordSuccess {
  ok: true
  transaction: Transaction
  /** 写入后的组合（已含重建的持仓缓存） */
  portfolio: Portfolio2
  /** 重建摘要 */
  rebuilt: { rebuiltCount: number; createdCount: number; preservedCount: number }
  /** 对账摘要 */
  reconcile: { ok: boolean; matchedCount: number; holdingCount: number }
}

export type RecordResult = RecordSuccess | RecordFailure

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */


let seq = 0
function nextId(type: string, now: string): string {
  seq += 1
  return `tx_${type}_${new Date(now).getTime()}_${seq}`
}

/**
 * 生成一笔交易（不做校验）。
 *
 * ## 划转的数量语义（重要）
 *
 * `transferQuantity` **未指定时领域层默认移动整仓**。
 * 因此必须显式决定：
 *
 * | 标的类型 | 数量来源 |
 * | --- | --- |
 * | 现金（quantity 即金额） | `transferQuantity = amount` |
 * | 其他数量口径 | 必须由调用方提供 `quantity` |
 *
 * 否则「从 A 划 20000 到 B」会变成「把 A 的全部余额都划到 B」。
 */
export function buildTransaction(input: RecordTransactionInput): Transaction {
  /*
   * 直接采用 `transferQuantity`。
   *
   * **不在这里猜数量**：现金「数量即金额」的判定需要 `Portfolio2`，
   * 由 `recordTransaction` 在读取组合后解析并写回（见其步骤 3）。
   * 保持本函数为纯构造器，便于测试与复用。
   */
  const tx: Transaction = {
    id: input.id ?? nextId(input.type, input.timestamp),
    accountId: input.accountId,
    instrumentId: input.instrumentId,
    cashInstrumentId: input.cashInstrumentId,
    toAccountId: input.toAccountId,
    transferQuantity: input.transferQuantity,
    toCashInstrumentId: input.toCashInstrumentId,
    type: input.type,
    amount: input.amount,
    quantity: input.quantity,
    fee: input.fee,
    currency: input.currency,
    toAmount: input.toAmount,
    toCurrency: input.toCurrency,
    timestamp: input.timestamp,
    note: input.note,
  }
  return tx
}

/** 该交易是否要求指定标的（由语义表决定，避免各处硬编码） */
function requiresInstrument(type: TransactionType): boolean {
  return TRANSACTION_SEMANTICS[type].quantity !== 'none' || type === 'dividend' || type === 'interest'
}

/**
 * 该交易是否要求资金腿。
 *
 * ⚠️ `transfer` **不在其中**：划转的语义是「标的在账户间移动」
 * （由 `toAccountId` 驱动），不需要也不应该有资金腿 ——
 * 若同时提供 `cashInstrumentId === instrumentId`，
 * 领域层会报 `cash_leg_same_as_instrument` 而拒绝。
 */
function requiresCashLeg(type: TransactionType): boolean {
  return (
    type === 'buy' ||
    type === 'sell' ||
    type === 'deposit' ||
    type === 'withdraw' ||
    type === 'fee' ||
    type === 'exchange'
  )
}

/* ------------------------------------------------------------------ *
 * 前置校验（不依赖试算）
 * ------------------------------------------------------------------ */

export function validateTransactionInput(
  input: RecordTransactionInput,
  portfolio: Portfolio2,
): RecordFailure | null {
  const fail = (code: RecordFailureCode, message: string): RecordFailure => ({ ok: false, code, message })

  const semantic = TRANSACTION_SEMANTICS[input.type]
  if (!semantic) return fail('unknown-type', `未知的交易类型：${input.type}`)

  /* ---- 账户 ---- */
  if (!input.accountId) return fail('missing-account', '请选择账户')
  if (!portfolio.accounts.some((a) => a.id === input.accountId)) {
    return fail('unknown-account', '所选账户不存在（不会临时创建假账户）')
  }

  /* ---- 标的 ---- */
  if (requiresInstrument(input.type)) {
    if (!input.instrumentId) return fail('missing-instrument', '请选择标的')
    if (!portfolio.instruments.some((i) => i.id === input.instrumentId)) {
      return fail('unknown-instrument', '所选标的不存在（不会用字符串伪造持仓）')
    }
  } else if (input.instrumentId && !portfolio.instruments.some((i) => i.id === input.instrumentId)) {
    return fail('unknown-instrument', '所选标的不存在')
  }

  /*
   * 利息 / 分红：资金腿是可选的。
   *
   * - 标的**不是**现金（例如债券利息）→ 需要资金腿，收钱进现金账户；
   * - 标的**就是**现金（例如活期利息）→ **不要**资金腿，
   *   否则同一标的会同时产生投资腿与现金腿，被领域层拒绝
   *   （`cash_leg_same_as_instrument`）。
   */
  if (
    (input.type === 'dividend' || input.type === 'interest') &&
    input.cashInstrumentId &&
    input.cashInstrumentId === input.instrumentId
  ) {
    return fail(
      'invalid-input',
      '利息 / 分红的标的与资金腿不能是同一个标的；若收益来自该现金本身，请不要选择「资金来源」',
    )
  }

  /* ---- 资金腿 ---- */
  if (requiresCashLeg(input.type)) {
    if (!input.cashInstrumentId) {
      return fail('missing-cash-instrument', '请选择资金所在的现金账户')
    }
    if (!portfolio.instruments.some((i) => i.id === input.cashInstrumentId)) {
      return fail('missing-cash-instrument', '所选现金标的不存在')
    }
    // 单笔交易只有一种币种：交易币种必须与资金腿币种一致
    const cashInst = portfolio.instruments.find((i) => i.id === input.cashInstrumentId)!
    if (cashInst.currency !== input.currency && input.type !== 'exchange') {
      return fail(
        'invalid-input',
        `交易币种 ${input.currency} 与现金标的币种 ${cashInst.currency} 不一致；跨币种请先做一次换汇`,
      )
    }
  }

  /* ---- 划转目标 ---- */
  if (input.type === 'transfer') {
    if (!input.toAccountId) return fail('missing-transfer-target', '请选择目标账户')
    if (input.toAccountId === input.accountId) {
      return fail('missing-transfer-target', '源账户与目标账户不能相同')
    }
    if (!portfolio.accounts.some((a) => a.id === input.toAccountId)) {
      return fail('unknown-transfer-target', '目标账户不存在')
    }
  }

  /* ---- 金额 / 数量 ---- */
  if (!Number.isFinite(input.amount)) return fail('invalid-input', '金额无效')
  if (input.type !== 'transfer' && input.amount < 0) {
    return fail('invalid-input', '金额不能为负（负债请在负债账户中记录）')
  }
  if ((input.type === 'buy' || input.type === 'sell') && !(Number(input.quantity) > 0)) {
    return fail('invalid-input', '数量必须大于 0')
  }
  if (input.type === 'exchange') {
    if (!input.toCashInstrumentId) return fail('missing-cash-instrument', '请选择换入的现金标的')
    if (!portfolio.instruments.some((i) => i.id === input.toCashInstrumentId)) {
      return fail('missing-cash-instrument', '换入的现金标的不存在')
    }
    if (input.toCashInstrumentId === input.cashInstrumentId) {
      return fail('invalid-input', '换出与换入的现金标的不能相同')
    }
    if (!(Number(input.toAmount) > 0)) return fail('invalid-input', '请填写换汇到账金额')
  }
  if (!input.timestamp) return fail('invalid-input', '缺少交易日期')

  return null
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export interface RecordContext {
  /** 注入时钟便于测试；缺省真实时间 */
  now?: () => Date
}

/**
 * 记录一笔交易。
 *
 * **要么整体成功、要么什么都不写。** 详见文件头的数据流说明。
 */
export async function recordTransaction(
  repo: PortfolioRepository,
  input: RecordTransactionInput,
  context: RecordContext = {},
): Promise<RecordResult> {
  const now = context.now ?? (() => new Date())

  /* ---- 1) 读取当前事实 ---- */
  const portfolio = await repo.loadPortfolio()

  /* ---- 2) 前置校验 ---- */
  const invalid = validateTransactionInput(input, portfolio)
  if (invalid) return invalid

  /* ---- 3) 解析划转数量，再构造交易并**在内存中试算** ---- */
  const resolved: RecordTransactionInput = { ...input }
  if (resolved.type === 'transfer' && resolved.transferQuantity === undefined && resolved.quantity === undefined) {
    const inst = portfolio.instruments.find((i) => i.id === resolved.instrumentId)
    if (inst?.instrumentType === 'cash') {
      // 现金：数量即金额
      resolved.transferQuantity = resolved.amount
    } else {
      return {
        ok: false,
        code: 'invalid-input',
        message: '划转非现金标的时必须填写划转数量（否则会被理解为整体移仓）',
      }
    }
  }

  const tx = buildTransaction(resolved)
  const withTx: Portfolio2 = { ...portfolio, transactions: [...portfolio.transactions, tx] }

  /*
   * 复用 `ledgerOptionsFor()`（其内部为 Map 查表）。
   *
   * 原先这里内联 `.find()` 闭包，会在 `deriveLedgerEffects` 里**逐笔交易**
   * 被调用 → `O(T × I)`（W9/P2-2）。改为复用同一实现，语义完全一致。
   */
  const { instrumentCurrency, isConfirmedCash } = ledgerOptionsFor(portfolio)

  const trial = deriveLedger(withTx.transactions, { instrumentCurrency, isConfirmedCash })

  /* ---- 4) 交易语义校验：领域层报告的 issue 一律拒绝 ---- */
  const blocking = trial.issues.filter((i) => i.transactionId === tx.id)
  if (blocking.length > 0) {
    // 超卖单独给出更友好的提示
    const oversell = blocking.find((i) => i.reason === 'sell_exceeds_holding')
    if (oversell) {
      return {
        ok: false,
        code: 'not-enough-holding',
        message: `可卖数量不足：${oversell.detail}`,
        issues: blocking,
      }
    }
    return {
      ok: false,
      code: 'ledger-issue',
      message: blocking[0].detail,
      issues: blocking,
    }
  }

  /* ---- 5) 数量不得为负（防御性：类型上不允许，但不能静默） ---- */
  for (const pos of trial.positions.values()) {
    if (pos.quantity < -EPS || pos.costBasis < -EPS) {
      return {
        ok: false,
        code: 'negative-holding',
        message:
          `交易会导致「${pos.instrumentId}」出现负数持仓或负成本` +
          `（数量 ${pos.quantity}，成本 ${pos.costBasis}），已拒绝`,
      }
    }
  }

  /* ---- 6) 重复持仓：拒绝在脏数据上继续叠加 ---- */
  const dup = detectDuplicateHoldings(withTx)
  if (!dup.ok) {
    return { ok: false, code: 'duplicate-holding', message: dup.summary }
  }

  /*
   * ## 前置校验：不得与**手动持仓**在同一 (账户, 标的) 上冲突
   * （W11 Blocker Patch，P0-1）
   *
   * 手动持仓与交易派生持仓是两套事实来源，而持仓表的不变量是
   * 「一个 (账户, 标的) 只能有一条」（见 `duplicates.ts` 的 `buildSuggestion`：
   * 口径不一致属数据质量问题，必须由用户消解）。
   *
   * 若该 key 上已有 `valuationMode: 'manual'` 的持仓，这笔交易会产生
   * 同 key 的第二条 → 触发 `duplicate-holding` → **该账户从此无法再记账**，
   * 且应用内没有修复入口。
   *
   * 因此在写入前明确拒绝，并告诉用户怎么做 —— 不静默合并、不丢弃手动值。
   */
  const manualConflict = findManualHoldingConflict(withTx, tx)
  if (manualConflict) return manualConflict

  /* ---- 7) 从 Ledger 重建持仓缓存 ---- */
  const rebuilt = rebuildHoldingsFromTransactions(withTx)
  if (rebuilt.blocked) {
    return {
      ok: false,
      code: 'duplicate-holding',
      message: rebuilt.duplicateReport?.summary ?? '重建被阻断：存在重复持仓',
    }
  }
  const next: Portfolio2 = { ...withTx, holdings: rebuilt.holdings }

  /* ---- 8) 账实校验 ---- */
  const rec = reconcileHoldings(next)
  if (!rec.ok) {
    return {
      ok: false,
      code: 'reconcile-failed',
      message: `账实校验未通过（${rec.issues.length} 项）：${rec.issues[0]?.detail ?? ''}`,
    }
  }

  /* ---- 9) 全部通过：整体写入 ---- */
  await repo.replaceAll(next)
  void now

  return {
    ok: true,
    transaction: tx,
    portfolio: next,
    rebuilt: {
      rebuiltCount: rebuilt.rebuiltCount,
      createdCount: rebuilt.createdCount,
      preservedCount: rebuilt.preservedCount,
    },
    reconcile: { ok: rec.ok, matchedCount: rec.matchedCount, holdingCount: rec.holdingCount },
  }
}


/**
 * 检查这笔交易会不会与**手动持仓**在同一 `(accountId, instrumentId)` 上冲突。
 *
 * 返回 `null` 表示无冲突；否则返回可直接返回给 UI 的失败结果。
 */
function findManualHoldingConflict(
  portfolio: Portfolio2,
  tx: Transaction,
): RecordFailure | null {
  const manualKeys = new Set(
    portfolio.holdings
      .filter((h) => h.valuationMode === 'manual')
      .map((h) => positionKey(h.accountId, h.instrumentId)),
  )
  if (manualKeys.size === 0) return null

  // 该交易可能触及的键：投资腿、资金腿、划转/换汇的目标侧
  const touched = new Set<string>()
  if (tx.accountId && tx.instrumentId) touched.add(positionKey(tx.accountId, tx.instrumentId))
  if (tx.accountId && tx.cashInstrumentId) touched.add(positionKey(tx.accountId, tx.cashInstrumentId))
  if (tx.toAccountId && tx.instrumentId) touched.add(positionKey(tx.toAccountId, tx.instrumentId))
  if (tx.toAccountId && tx.toCashInstrumentId) {
    touched.add(positionKey(tx.toAccountId, tx.toCashInstrumentId))
  }

  for (const key of touched) {
    if (!manualKeys.has(key)) continue
    const [accountId, instrumentId] = key.split('::')
    const account = portfolio.accounts.find((a) => a.id === accountId)
    const instrument = portfolio.instruments.find((i) => i.id === instrumentId)
    return {
      ok: false,
      code: 'duplicate-holding',
      message:
        `「${account?.name ?? accountId}」下的「${instrument?.name ?? instrumentId}」` +
        '已经有一条手动持仓。同一账户的同一标的只能有一条持仓记录 —— ' +
        '若要改用交易记录这个标的，请换一个账户，' +
        '或先处理掉那条手动持仓再重试。',
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 作废（Phase 8 / W5）—— 交易唯一的修正手段
 * ------------------------------------------------------------------ */

export interface VoidOptions {
  /** 作废原因（可选，便于审计） */
  reason?: string
  now?: () => Date
}

export interface VoidSuccess {
  ok: true
  /** 作废后的交易（status = VOIDED） */
  transaction: Transaction
  /** 写入后的组合（已含重建的持仓缓存） */
  portfolio: Portfolio2
  rebuilt: { rebuiltCount: number; createdCount: number; preservedCount: number }
  reconcile: { ok: boolean; matchedCount: number; holdingCount: number }
  /** 因失去全部交易依据而被清理的持仓键（便于排查与测试断言） */
  droppedOrphans: string[]
}

export type VoidResult = VoidSuccess | RecordFailure

/* ------------------------------------------------------------------ *
 * 作废前预检（Phase 8 / W10-Patch，P0-3）
 * ------------------------------------------------------------------ */

export interface VoidImpact {
  /** 作废后**会失去全部账本依据而被清理**的持仓键（`accountId::instrumentId`） */
  willDropHoldingKeys: string[]
  /**
   * 是否会因此**静默删除真实持仓**。
   *
   * 为 true 时 UI **必须**在确认前明确告知用户，
   * 不能只显示普通的「已作废」。
   */
  dropsRealPositions: boolean
  /** 面向用户的说明（可直接展示） */
  warning?: string
}

/**
 * 预检「作废这笔交易会造成什么后果」——**只读，不写任何数据**。
 *
 * ## 为什么需要它（P0-3）
 *
 * `voidTransaction` 会清理「在作废后已无任何有效交易支撑」的持仓缓存
 * （`droppedOrphans`）。对由**期初 `adjustment`** 支撑的持仓（1.0 迁移期初、
 * 现金转换期初），这意味着**整条真实资产被静默删除**：
 * 作废成功、UI 显示「已作废」、资产从净资产消失，且 `adjustment`
 * **不在用户可录入的 9 类交易里**，无法重新录回。
 *
 * 该预检复用与 `voidTransaction` **完全同一套**判定逻辑
 * （同一 `deriveLedger` + 同一 `stillBacked` 规则），因此不会出现
 * 「预检说没事、实际却删了」的口径分裂。
 *
 * 注意：预检**不阻断**作废（不改变 W5 的语义），只负责如实告知。
 */
export function inspectVoidImpact(
  portfolio: Portfolio2,
  transactionId: string,
): VoidImpact {
  const target = portfolio.transactions.find((t) => t.id === transactionId)
  if (!target) return { willDropHoldingKeys: [], dropsRealPositions: false }
  if (isVoided(target)) return { willDropHoldingKeys: [], dropsRealPositions: false }

  const ledgerOptions = ledgerOptionsFor(portfolio)
  const withVoid: Portfolio2 = {
    ...portfolio,
    transactions: portfolio.transactions.map((t) =>
      t.id === transactionId
        ? { ...t, status: 'VOIDED' as const, voidedAt: new Date().toISOString() }
        : t,
    ),
  }

  const preVoidLedger = deriveLedger(portfolio.transactions, ledgerOptions)
  const effectKeys = new Set<string>()
  for (const e of preVoidLedger.entries) {
    if (e.transactionId !== transactionId) continue
    effectKeys.add(positionKey(e.accountId, e.instrumentId))
  }
  if (target.toAccountId) {
    if (target.instrumentId) effectKeys.add(positionKey(target.toAccountId, target.instrumentId))
    if (target.toCashInstrumentId) {
      effectKeys.add(positionKey(target.toAccountId, target.toCashInstrumentId))
    }
  }
  if (target.toCashInstrumentId) {
    effectKeys.add(positionKey(target.accountId, target.toCashInstrumentId))
  }

  const activeTx = withVoid.transactions.filter((t) => !isVoided(t))
  const stillBacked = (key: string) => {
    const [accountId, instrumentId] = key.split('::')
    return activeTx.some(
      (t) =>
        t.accountId === accountId &&
        (t.instrumentId === instrumentId ||
          t.cashInstrumentId === instrumentId ||
          t.toCashInstrumentId === instrumentId),
    )
  }

  const willDropHoldingKeys: string[] = []
  for (const h of withVoid.holdings) {
    if (h.valuationMode === 'manual') continue
    const key = positionKey(h.accountId, h.instrumentId)
    if (!effectKeys.has(key)) continue
    if (stillBacked(key)) continue
    willDropHoldingKeys.push(key)
  }

  const dropsRealPositions = willDropHoldingKeys.length > 0
  return {
    willDropHoldingKeys,
    dropsRealPositions,
    warning: dropsRealPositions
      ? `作废这笔交易后，有 ${willDropHoldingKeys.length} 项持仓将失去全部账本依据，` +
        '系统会把这些持仓缓存一并清理 —— 资产会从净资产中消失。' +
        (target.type === 'adjustment'
          ? '该交易是「期初余额」，而期初余额不在可录入的交易类型中，作废后无法重新录入；' +
            '如需保留这部分资产，请在作废后用手动持仓重新登记。'
          : '如需保留这部分资产，请在作废后重新录入对应交易或用手动持仓登记。')
      : undefined,
  }
}

/**
 * **作废一笔交易**（Phase 8 / W5）。
 *
 * ## 为什么是「作废」而不是「删除」
 *
 * Transaction 是事实源。物理删除会让 `rebuild` 推出不同结果，
 * 且丢失审计轨迹。因此只把状态改成 `VOIDED`，原记录完整保留。
 *
 * ## 流程（与 `recordTransaction` 同样严格）
 *
 * ```
 * ① 交易存在性检查        → 不存在即拒绝，不写任何数据
 * ② 防止重复作废          → 已 VOIDED 即拒绝
 * ③ 内存试算：作废后跑 deriveLedger
 * ④ Ledger 校验：无 issue、不产生负持仓 / 负成本
 * ⑤ rebuildHoldingsFromTransactions（从 Ledger 重建缓存）
 * ⑥ reconcileHoldings（账实校验）
 * ⑦ **全部通过才整体写入**
 * ```
 *
 * 任一步失败都返回 `{ ok: false }`，**绝不产生半状态**。
 *
 * ## 为什么需要试算
 *
 * 作废一笔 `buy` 可能让后续的 `sell` 变成超卖。
 * 直接落库会把账本写成不可能的状态（`Holding.quantity` 不允许负数），
 * 因此必须在写入前用试算结果判定并拒绝。
 */
export async function voidTransaction(
  repo: PortfolioRepository,
  transactionId: string,
  options: VoidOptions = {},
): Promise<VoidResult> {
  const now = options.now ?? (() => new Date())

  /* ---- 1) 读取当前事实 ---- */
  const portfolio = await repo.loadPortfolio()

  /* ---- 2) 存在性检查 ---- */
  const target = portfolio.transactions.find((t) => t.id === transactionId)
  if (!target) {
    return { ok: false, code: 'not-found', message: '找不到该交易（数据未做任何修改）' }
  }

  /* ---- 3) 防止重复作废 ---- */
  if (isVoided(target)) {
    return {
      ok: false,
      code: 'already-voided',
      message: `该交易已于 ${target.voidedAt ?? '此前'} 作废，不能重复作废`,
    }
  }

  /* ---- 4) 构造作废后的组合（仅改状态，不动其它字段） ---- */
  const voidedAt = now().toISOString()
  const voidedTx: Transaction = {
    ...target,
    status: 'VOIDED',
    voidedAt,
    voidReason: options.reason?.trim() || undefined,
  }
  const withVoid: Portfolio2 = {
    ...portfolio,
    transactions: portfolio.transactions.map((t) => (t.id === transactionId ? voidedTx : t)),
  }

  /* ---- 5) 内存试算 ---- */
  /*
   * 复用 `ledgerOptionsFor()`（其内部为 Map 查表）。
   *
   * 原先这里内联 `.find()` 闭包，会在 `deriveLedgerEffects` 里**逐笔交易**
   * 被调用 → `O(T × I)`（W9/P2-2）。改为复用同一实现，语义完全一致。
   */
  const { instrumentCurrency, isConfirmedCash } = ledgerOptionsFor(portfolio)

  const trial = deriveLedger(withVoid.transactions, { instrumentCurrency, isConfirmedCash })

  // 作废会移除一笔交易的效果；若因此暴露其它交易的 issue（例如超卖），一律拒绝
  if (trial.issues.length > 0) {
    return {
      ok: false,
      code: 'ledger-issue',
      message: `作废后账本出现问题，已拒绝：${trial.issues[0].detail}`,
      issues: trial.issues,
    }
  }

  /*
   * ## 为什么这里**不**做「负数持仓」检查
   *
   * `sortTransactions` 把 `adjustment` 排在普通交易**之后**
   * （其语义是「期末设定」）。因此处理过程中持仓可能短暂为负：
   *
   * ```
   * buy:        -1000              → 中间态：现金 -1000
   * adjustment: 设定为 100000       → 最终态：99000  ✅ 完全正常
   * ```
   *
   * 实现过程中真实踩到这个坑：作废一笔买入被误报成
   * 「会导致 i_cny_cash 出现负数持仓（-1000）」而被拒绝 ——
   * 那其实是**合法的最终状态**，只是中间过程为负。
   *
   * 真正的非法状态由领域层负责：
   * - `deriveLedger` 对超卖等非法操作产出 **issue**（上一步已统一拒绝）
   * - `reconcileHoldings` 在第 9 步做**账实校验**（缓存与 Ledger 是否一致）
   *
   * 因此作废路径只依赖这两个权威判定，不自行发明第三套规则。
   */

  /*
   * ## 但**最终态**为负必须拦（这是真正的不变量破坏）
   *
   * 与上面的中间态不同：如果处理完所有交易后仍然是负数，
   * 那这个组合本身就是不合法的 —— 典型场景是**作废掉期初 adjustment**：
   *
   * ```
   * adjustment +100000（期初，排在最后）
   * buy        -1000
   * 作废 adjustment 后 → 只剩 buy → 最终现金 -1000 ❌ 无任何报错
   * ```
   *
   * `deriveLedger` 对现金腿只做累加、不检查余额，所以必须在这里拦。
   * 用例见 `transactionVoid.test.ts` 的「作废期初余额」。
   */
  const negatives = [...trial.positions.values()].filter(
    (pos) => pos.quantity < -EPS || pos.costBasis < -EPS,
  )
  if (negatives.length > 0) {
    const worst = negatives[0]
    return {
      ok: false,
      code: 'would-cause-negative',
      message:
        `作废该交易会让「${worst.instrumentId}」的最终持仓变成负数` +
        `（数量 ${worst.quantity}，成本 ${worst.costBasis}）。` +
        '如果它是期初余额，请改为补录一笔新的期初 adjustment，而不是作废旧的那笔。',
    }
  }

  /* ---- 6) 重复持仓检查 ---- */
  const dup = detectDuplicateHoldings(withVoid)
  if (!dup.ok) {
    return { ok: false, code: 'duplicate-holding', message: dup.summary }
  }

  /* ---- 7) 丢弃「因本次作废而失去全部交易依据」的持仓缓存 ---- */
  /*
   * ## 为什么需要这一步（W5 发现的关键缺陷）
   *
   * `rebuildFromLedger` 有一条**刻意的保护**：交易里找不到依据的持仓
   * 会被**保留并标记 orphan**，而不是删除 —— 目的是防止静默丢失用户的资产
   * （例如手工导入或历史遗留的持仓）。
   *
   * 但作废场景下这条保护会误伤：
   *
   * ```
   * 唯一的一笔 BUY 100 股 → 作废 → Ledger 里该持仓归零
   *   → rebuild 仍保留缓存里的 100 股（视为 orphan）
   *   → reconcile 报「孤立持仓」
   *   → 作废被拒绝（作废功能完全不可用）
   * ```
   *
   * 因此：只有当一个持仓键**在作废后不再有任何有效交易依据**、
   * 且**本次作废正是移除其最后依据的交易**时，才明确丢弃该缓存。
   *
   * ⚠️ 这里的删除是**有依据的清理**，不是「为了让测试通过而删数据」：
   * 该持仓在新的事实集（有效交易）下已不存在，保留它才会造成账实不符。
   *
   * manual 口径持仓（房产 / 应收）不受影响 —— 它们本就不由交易驱动。
   */
  /*
   * ⚠️ 效果键必须取自**作废前**的 Ledger。
   *
   * 不能问 `trial`（作废后）——那笔交易已被过滤，`entries` 里没有它的效果，
   * 结果必然是空集，修剪就会失效（这是实现过程中真实踩到的坑）。
   */
  const preVoidLedger = deriveLedger(portfolio.transactions, { instrumentCurrency, isConfirmedCash })
  const effectKeys = new Set<string>()
  for (const e of preVoidLedger.entries) {
    if (e.transactionId !== transactionId) continue
    effectKeys.add(positionKey(e.accountId, e.instrumentId))
  }

  /*
   * 划转 / 换汇的**目标侧**效果由 `toAccountId` 推导，
   * 不在 `entries` 的账户维度里完整体现 —— 必须显式补上，
   * 否则目标账户上那个只由本交易支撑的持仓会变成孤儿（作废被拒绝）。
   */
  if (target.toAccountId) {
    if (target.instrumentId) {
      effectKeys.add(positionKey(target.toAccountId, target.instrumentId))
    }
    if (target.toCashInstrumentId) {
      effectKeys.add(positionKey(target.toAccountId, target.toCashInstrumentId))
    }
  }
  // 换汇的换入腿落在**同一账户**的另一个现金标的上
  if (target.toCashInstrumentId) {
    effectKeys.add(positionKey(target.accountId, target.toCashInstrumentId))
  }

  const activeTx = withVoid.transactions.filter((t) => !isVoided(t))
  const stillBacked = (key: string) => {
    const [accountId, instrumentId] = key.split('::')
    return activeTx.some(
      (t) =>
        t.accountId === accountId &&
        (t.instrumentId === instrumentId ||
          t.cashInstrumentId === instrumentId ||
          t.toCashInstrumentId === instrumentId),
    )
  }

  const droppedOrphans: string[] = []
  const prunedHoldings = withVoid.holdings.filter((h) => {
    if (h.valuationMode === 'manual') return true
    const key = positionKey(h.accountId, h.instrumentId)
    if (!effectKeys.has(key)) return true
    if (stillBacked(key)) return true
    droppedOrphans.push(key)
    return false
  })
  const pruned: Portfolio2 = { ...withVoid, holdings: prunedHoldings }

  /* ---- 8) 从 Ledger 重建缓存 ---- */
  const rebuilt = rebuildHoldingsFromTransactions(pruned)
  if (rebuilt.blocked) {
    return {
      ok: false,
      code: 'duplicate-holding',
      message: rebuilt.duplicateReport?.summary ?? '重建被阻断：存在重复持仓',
    }
  }
      /*
     * 重建产物的最终不变量校验（W11 Blocker Patch，P0-1）。
     *
     * 入口的重复检测查的是**重建前**的组合，不会覆盖重建新产生的行。
     * 若重建自身产出重复 `(accountId, instrumentId)`，必须**拒绝写入**
     * 而不是把重复静默持久化 —— 那会让该账户从此无法再记账。
     */
    if (rebuilt.duplicateKeys?.length) {
      return {
        ok: false,
        code: 'duplicate-holding',
        message:
          `重建持仓出现重复键（${rebuilt.duplicateKeys.join('、')}），已拒绝写入以避免损坏账本。` +
          '请导出备份后反馈该问题。',
      }
    }
    const next: Portfolio2 = { ...pruned, holdings: rebuilt.holdings }

  /* ---- 9) 账实校验 ---- */
  const rec = reconcileHoldings(next)
  if (!rec.ok) {
    return {
      ok: false,
      code: 'reconcile-failed',
      message: `账实校验未通过（${rec.issues.length} 项）：${rec.issues[0]?.detail ?? ''}`,
    }
  }

  /* ---- 10) 全部通过：整体写入 ---- */
  await repo.replaceAll(next)

  return {
    ok: true,
    transaction: voidedTx,
    /** 因失去全部交易依据而被清理的持仓键（便于排查） */
    droppedOrphans,
    portfolio: next,
    rebuilt: {
      rebuiltCount: rebuilt.rebuiltCount,
      createdCount: rebuilt.createdCount,
      preservedCount: rebuilt.preservedCount,
    },
    reconcile: { ok: rec.ok, matchedCount: rec.matchedCount, holdingCount: rec.holdingCount },
  }
}

/** 查询某笔交易的状态（归一化：undefined → POSTED） */
export function transactionStatusOf(tx: Transaction): 'POSTED' | 'VOIDED' {
  return transactionStatus(tx)
}

/** 供 UI：统计有效 / 已作废数量 */
export function transactionCounts(txs: Transaction[]): { posted: number; voided: number } {
  let posted = 0
  let voided = 0
  for (const tx of txs) {
    if (isVoided(tx)) voided += 1
    else posted += 1
  }
  return { posted, voided }
}

/* ------------------------------------------------------------------ *
 * 查询辅助（供交易历史 UI）
 * ------------------------------------------------------------------ */

export interface TransactionQuery {
  accountId?: string
  instrumentId?: string
  type?: TransactionType
  currency?: CurrencyCode
  /** 起始日期（含），YYYY-MM-DD */
  from?: string
  /** 结束日期（含），YYYY-MM-DD */
  to?: string
}

/**
 * 按条件筛选交易（纯函数，**只筛选不计算**）。
 *
 * 金额与效果由 `deriveLedger` 提供，本函数不做任何金融计算。
 */
export function queryTransactions(
  transactions: Transaction[],
  query: TransactionQuery = {},
): Transaction[] {
  return transactions
    .filter((t) => (query.accountId ? t.accountId === query.accountId : true))
    .filter((t) => (query.instrumentId ? t.instrumentId === query.instrumentId : true))
    .filter((t) => (query.type ? t.type === query.type : true))
    .filter((t) => (query.currency ? t.currency === query.currency : true))
    .filter((t) => (query.from ? t.timestamp.slice(0, 10) >= query.from : true))
    .filter((t) => (query.to ? t.timestamp.slice(0, 10) <= query.to : true))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp)) // 默认最新在前
}

/* ------------------------------------------------------------------ *
 * 可用持仓（供卖出表单限制可卖数量）
 * ------------------------------------------------------------------ */

export interface AvailablePosition {
  accountId: string
  instrumentId: string
  quantity: number
  costBasis: number
  averageCost: number
}

/**
 * 计算某账户下所有可卖持仓（由 Ledger 推导，**不读 Holding 缓存**）。
 *
 * 卖出表单用这个结果限制可卖数量，避免提交后才被拒绝。
 */
export function availablePositions(portfolio: Portfolio2): AvailablePosition[] {
  const { instrumentCurrency } = ledgerOptionsFor(portfolio)
  const ledger = deriveLedger(portfolio.transactions, { instrumentCurrency })

  const out: AvailablePosition[] = []
  for (const [key, pos] of ledger.positions) {
    if (pos.quantity <= EPS) continue
    const [accountId, instrumentId] = key.split('::')
    out.push({
      accountId,
      instrumentId,
      quantity: pos.quantity,
      costBasis: pos.costBasis,
      averageCost: pos.averageCost,
    })
  }
  return out
}

/** 某账户某标的的可卖数量 */
export function availableQuantity(
  portfolio: Portfolio2,
  accountId: string,
  instrumentId: string,
): number {
  const { instrumentCurrency } = ledgerOptionsFor(portfolio)
  const ledger = deriveLedger(portfolio.transactions, { instrumentCurrency })
  return ledger.positions.get(positionKey(accountId, instrumentId))?.quantity ?? 0
}

/**
 * 某账户下**全部标的**的可卖数量（Phase 8 / W8，P1-1）。
 *
 * ## 为什么需要它
 *
 * `availableQuantity()` **每次调用都会完整跑一遍 `deriveLedger`**。
 * 卖出表单需要「本账户每个标的各有多少」——若逐标的调用它，
 * 复杂度是 `O(I × T log T)`，打开表单即触发（实测 I=120/T=5000 时桌面 ~460ms）。
 *
 * 本函数只派生**一次**，然后按 instrumentId 建索引返回 → `O(T log T + I)`。
 *
 * ## 与 `availablePositions` 的关系
 *
 * `availablePositions` 已经做到「一次派生」，但它返回的是**扁平列表**，
 * 且**不过滤**任何东西。用于表单时仍需按账户+标的查表，
 * 因此这里提供按 `instrumentId` 索引的形态，便于直接替换逐标的调用。
 *
 * ⚠️ 调用方**仍需自行过滤**（例如卖出表单要排除现金标的）——
 * 本函数只回答「有多少」，不决定「能不能卖」。
 */
export function availableQuantities(
  portfolio: Portfolio2,
  accountId: string,
): Map<string, number> {
  const { instrumentCurrency } = ledgerOptionsFor(portfolio)
  const ledger = deriveLedger(portfolio.transactions, { instrumentCurrency })

  const out = new Map<string, number>()
  const prefix = `${accountId}::`
  for (const [key, pos] of ledger.positions) {
    if (!key.startsWith(prefix)) continue
    out.set(key.slice(prefix.length), pos.quantity)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 供 UI 展示的持仓类型收窄
 * ------------------------------------------------------------------ */

/** 现金类标的（estimating 用），与估值引擎的口径一致：只看 instrumentType */
export function cashInstruments(portfolio: Portfolio2) {
  return portfolio.instruments.filter(
    (i) => i.instrumentType === 'cash' && i.classificationStatus === 'confirmed',
  )
}

export type { AllocationProfile, Holding }
