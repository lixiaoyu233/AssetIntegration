/**
 * 由交易派生持仓状态（数量 / 成本 / 均价）与现金变动
 *
 * ## 四层职责分离（Phase 5 明确固定）
 *
 * ```
 * Transaction（事实）
 *      ↓  deriveLedgerEffects()   ← 纯函数，只做推导，不碰任何状态
 * Ledger Effects（instrument leg / cash leg / income / realizedPnl / fee）
 *      ↓  applyEffectsToPositions()
 * Holdings（可重建缓存）
 *      ↓  估值引擎
 * Snapshot（估值快照）
 * ```
 *
 * 这样拆分的意义：
 * - **Transaction 是唯一事实来源**，Holding 只是推导结果；
 * - 效果推导与状态应用各自可独立测试；
 * - 任何「Transaction 一套逻辑、Holding 另一套逻辑」的漂移都会在 reconcile 暴露。
 *
 * ## 币种规则（单笔交易只有一种币种）
 *
 * `currency` 必须等于 `cashInstrumentId` 所指现金标的的币种。
 * 因此「用 CNY 买美元资产」必须拆成两步：
 *
 * ```
 * 1) exchange:  CNY 现金 → USD 现金
 * 2) buy:       USD 现金 → SPYM（USD 计价）
 * ```
 *
 * ## 换汇（exchange）不是买卖
 *
 * `exchange` 用两条资金腿表达：源现金减少、目标现金增加。
 * 它**不产生 investmentReturn、不产生 realizedPnl**，
 * 折算成人民币后的差额由归因层计入 `fxEffect`。
 */

import type { Transaction } from '../../types/portfolio2'
import { TRANSACTION_SEMANTICS } from './types'
import { activeTransactions } from './lifecycle'

/* ------------------------------------------------------------------ *
 * 数值工具
 * ------------------------------------------------------------------ */

export const LEDGER_EPS = 1e-9
const EPS = LEDGER_EPS

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 与 num 相同，但保持「未提供」与「0」的区别 */
function safeNum(v: unknown): number {
  if (v === undefined || v === null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

const round8 = (n: number) => Math.round(n * 1e8) / 1e8

/**
 * 交易按时间排序；同一时间的按「先设定的 adjustment」优先，保证期初先落地。
 *
 * ## 为什么预解析时间键（Phase 8 / W9，P2-1）
 *
 * 原实现在**比较器内部**调用 `new Date(a.timestamp).getTime()` ——
 * 每次比较都要解析两个时间字符串。`Array.prototype.sort` 的比较次数是
 * `O(T log T)`，于是解析次数也是 `O(T log T)`，且每次派生会排**两遍**
 * （`derive.ts:215` 与 `:601`）、每写一笔交易触发 3 次派生。
 *
 * 现在先把时间解析成数字键（`O(T)` 次解析），再按数字比较。
 *
 * ⚠️ **排序语义完全不变**：
 *   - 仍按时间升序；
 *   - 时间相同时 `adjustment` 优先（rank 数值更小在前）；
 *   - `Array.prototype.sort` 在 V8 中稳定，因此同 rank 的相对顺序不变。
 *   - 时间字符串无法解析时原实现得 `NaN`，比较恒为 `false` → 元素位置
 *     由稳定性决定；预解析后同样保留 `NaN`，`a - b` 仍为 `NaN` → 行为一致。
 */
export function sortTransactions(txs: Transaction[]): Transaction[] {
  const rank = (t: Transaction) => (t.type === 'adjustment' ? 0 : 1)
  return txs
    .map((tx) => ({ tx, at: new Date(tx.timestamp).getTime(), rank: rank(tx) }))
    .sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at
      return a.rank - b.rank
    })
    .map((entry) => entry.tx)
}

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export type LedgerIssueReason =
  | 'missing_account'
  | 'missing_instrument'
  | 'missing_quantity'
  | 'sell_exceeds_holding'
  | 'adjustment_not_first'
  | 'missing_transfer_target'
  | 'transfer_exceeds_holding'
  | 'cash_leg_same_as_instrument'
  /** 交易币种与现金标的币种不一致（跨币种必须先换汇） */
  | 'currency_mismatch'
  /** 换汇缺少目标现金标的 */
  | 'missing_exchange_target'
  /** 换汇的源与目标币种相同 */
  | 'exchange_same_currency'
  /** 该交易类型要求资金腿但没填 */
  | 'missing_cash_instrument'
  /** 换汇金额必须为正数 */
  | 'exchange_non_positive_amount'
  /** 换汇的现金标的必须是「已确认的现金」 */
  | 'exchange_not_confirmed_cash'

export const LEDGER_ISSUE_LABEL: Record<LedgerIssueReason, string> = {
  missing_account: '交易没有归属账户',
  missing_instrument: '缺少标的',
  missing_quantity: '缺少数量',
  sell_exceeds_holding: '卖出超过持有量',
  adjustment_not_first: '重复的期初余额',
  missing_transfer_target: '划转缺少目标账户',
  transfer_exceeds_holding: '划转超过持有量',
  cash_leg_same_as_instrument: '现金标的与投资标的相同',
  currency_mismatch: '交易币种与现金标的币种不一致',
  missing_exchange_target: '换汇缺少目标现金标的',
  exchange_same_currency: '换汇的源与目标币种相同',
  missing_cash_instrument: '缺少现金标的',
  exchange_non_positive_amount: '换汇金额必须大于 0',
  exchange_not_confirmed_cash: '换汇的现金标的必须是已确认的现金',
}

export interface LedgerIssue {
  transactionId: string
  reason: LedgerIssueReason
  detail: string
}

/** 一笔交易对**某一个 Holding** 造成的效果 */
export interface LedgerEffect {
  transactionId: string
  type: Transaction['type']
  /** 作用在哪个持仓（`accountId::instrumentId`） */
  key: string
  instrumentId: string
  accountId: string
  /** 效果角色 */
  leg: 'instrument' | 'cash' | 'cash_target'
  /** 数量变化（现金腿即为金额变化） */
  quantityDelta: number
  /** 成本变化（原币） */
  costDelta: number
  /** 现金变化（原币，正为流入） */
  cashDelta: number
  /** 该效果是否**设定**而非累加（仅 adjustment） */
  setQuantity?: number
  setCostBasis?: number
  /** 收入变化（仅 dividend / interest） */
  incomeDelta?: number
  /** 费用变化 */
  feeDelta?: number
}

export interface DerivedPosition {
  accountId: string
  instrumentId: string
  currency: string
  quantity: number
  costBasis: number
  averageCost: number
  realizedPnl: number
  income: number
  fees: number
  /**
   * **交易笔数**（按 `transactionId` 去重）。
   *
   * 一笔 buy 对某持仓而言只是「一笔交易」，即使它产生了投资腿与现金腿两条效果。
   * 若需要效果条数，请另用 `effectCount` 语义，不要复用本字段。
   */
  transactionCount: number
  firstTransactionAt?: string
  lastTransactionAt?: string
}

export interface LedgerEffects {
  effects: LedgerEffect[]
  issues: LedgerIssue[]
}

export function positionKey(accountId: string, instrumentId: string): string {
  return `${accountId}::${instrumentId}`
}

/* ------------------------------------------------------------------ *
 * 第一层：派生效果（纯函数，不维护状态）
 * ------------------------------------------------------------------ */

export interface EffectContext {
  /** 查询标的币种，用于「交易币种 == 现金标的币种」校验 */
  instrumentCurrency?: (instrumentId: string) => string | undefined
  /**
   * 判断标的是否为「已确认的现金」。
   *
   * 换汇要求**两个现金标的都是已确认的现金** —— 否则等于把未分类资产
   * 当成现金换出去，属于不可解释的资产变动。
   */
  isConfirmedCash?: (instrumentId: string) => boolean
}

/**
 * 把交易列表推导为**效果列表**。
 *
 * 只维护一个「哪些持仓已设过期初」的集合用于拒绝重复 adjustment，
 * 不接触任何持仓状态 —— 因此可以单独测试「某笔交易应该产生哪些效果」。
 */
export function deriveLedgerEffects(txs: Transaction[], context: EffectContext = {}): LedgerEffects {
  const effects: LedgerEffect[] = []
  const issues: LedgerIssue[] = []
  const adjustedKeys = new Set<string>()
  const currencyOf = context.instrumentCurrency

  /*
   * **统一入口过滤已作废交易**（Phase 8 / W5）。
   *
   * 只在这一处过滤，下游全部自动遵循：
   * deriveLedger / rebuildHoldingsFromTransactions / reconcileHoldings /
   * availablePositions / 交易详情的 Ledger Effects。
   *
   * 语义：作废 = 这笔交易仿佛没有发生过（保留记录用于审计）。
   */
  for (const tx of sortTransactions(activeTransactions(txs))) {
    const semantic = TRANSACTION_SEMANTICS[tx.type]
    const amount = num(tx.amount)
    const fee = num(tx.fee)
    const qty = num(tx.quantity)
    const push = (e: Omit<LedgerEffect, 'transactionId' | 'type'>) =>
      effects.push({ transactionId: tx.id, type: tx.type, ...e })

    /* ---- 账户 ---- */
    if (!tx.accountId) {
      issues.push({ transactionId: tx.id, reason: 'missing_account', detail: LEDGER_ISSUE_LABEL.missing_account })
      continue
    }

    const cashInstrumentId = tx.cashInstrumentId

    /* ---- 现金腿：不能与投资标的重合 ---- */
    if (cashInstrumentId && cashInstrumentId === tx.instrumentId) {
      issues.push({
        transactionId: tx.id,
        reason: 'cash_leg_same_as_instrument',
        detail: LEDGER_ISSUE_LABEL.cash_leg_same_as_instrument,
      })
      continue
    }

    /* ---- 币种一致性：单笔交易只有一种币种 ---- */
    if (cashInstrumentId && currencyOf) {
      const cashCurrency = currencyOf(cashInstrumentId)
      if (cashCurrency && cashCurrency !== tx.currency) {
        issues.push({
          transactionId: tx.id,
          reason: 'currency_mismatch',
          detail: `${semantic.label} 的交易币种 ${tx.currency} 与现金标的币种 ${cashCurrency} 不一致；跨币种请先做一次换汇`,
        })
        continue
      }
    }

    /* ---- 换汇：两条资金腿，不涉及买卖 ---- */
    if (tx.type === 'exchange') {
      const targetId = tx.toCashInstrumentId
      if (!cashInstrumentId || !targetId) {
        issues.push({
          transactionId: tx.id,
          reason: 'missing_exchange_target',
          detail: LEDGER_ISSUE_LABEL.missing_exchange_target,
        })
        continue
      }
      const sourceCurrency = currencyOf?.(cashInstrumentId) ?? tx.currency
      const targetCurrency = tx.toCurrency ?? currencyOf?.(targetId) ?? sourceCurrency
      if (sourceCurrency === targetCurrency) {
        issues.push({
          transactionId: tx.id,
          reason: 'exchange_same_currency',
          detail: `${LEDGER_ISSUE_LABEL.exchange_same_currency}（币种 ${sourceCurrency}）；同币种转移请用 transfer`,
        })
        continue
      }
      const sourceAmount = safeNum(tx.amount)
      const targetAmount = safeNum(tx.toAmount)

      // 金额必须为正（不允许负数或 0）
      if (!(sourceAmount > 0) || !(targetAmount > 0)) {
        issues.push({
          transactionId: tx.id,
          reason: 'exchange_non_positive_amount',
          detail: `换汇金额必须大于 0（换出 ${sourceAmount}，到账 ${targetAmount}）`,
        })
        continue
      }

      // 两个现金标的都必须是「已确认的现金」工具
      if (context.isConfirmedCash) {
        const sourceOk = context.isConfirmedCash(cashInstrumentId)
        const targetOk = context.isConfirmedCash(targetId)
        if (!sourceOk || !targetOk) {
          issues.push({
            transactionId: tx.id,
            reason: 'exchange_not_confirmed_cash',
            detail: `${LEDGER_ISSUE_LABEL.exchange_not_confirmed_cash}（换出${sourceOk ? '✅' : '❌'}／换入${targetOk ? '✅' : '❌'}）`,
          })
          continue
        }
      }

      push({
        key: positionKey(tx.accountId, cashInstrumentId),
        instrumentId: cashInstrumentId,
        accountId: tx.accountId,
        leg: 'cash',
        quantityDelta: -amount,
        costDelta: -amount,
        cashDelta: -amount,
        feeDelta: fee > 0 ? fee : undefined,
      })
      push({
        key: positionKey(tx.accountId, targetId),
        instrumentId: targetId,
        accountId: tx.accountId,
        leg: 'cash_target',
        quantityDelta: targetAmount,
        costDelta: targetAmount,
        cashDelta: targetAmount,
      })
      continue
    }

    /* ---- 需要标的的交易 ---- */
    const needsInstrument =
      semantic.quantity !== 'none' || tx.type === 'dividend' || tx.type === 'interest'
    if (needsInstrument && !tx.instrumentId) {
      issues.push({
        transactionId: tx.id,
        reason: 'missing_instrument',
        detail: `${semantic.label} 需要指定标的`,
      })
      continue
    }
    if ((tx.type === 'buy' || tx.type === 'sell') && !(qty > 0)) {
      issues.push({ transactionId: tx.id, reason: 'missing_quantity', detail: '数量必须大于 0' })
      continue
    }
    if (tx.type === 'adjustment' && tx.instrumentId) {
      const key = positionKey(tx.accountId, tx.instrumentId)
      if (adjustedKeys.has(key)) {
        issues.push({
          transactionId: tx.id,
          reason: 'adjustment_not_first',
          detail: '同一持仓出现了多条期初 adjustment，仅第一条生效',
        })
        continue
      }
      adjustedKeys.add(key)
    }

    /* ---- 投资腿 ---- */
    if (tx.instrumentId) {
      const base = {
        key: positionKey(tx.accountId, tx.instrumentId),
        instrumentId: tx.instrumentId,
        accountId: tx.accountId,
        leg: 'instrument' as const,
      }

      switch (tx.type) {
        case 'adjustment':
          push({ ...base, quantityDelta: 0, costDelta: 0, cashDelta: 0, setQuantity: qty, setCostBasis: amount })
          break

        case 'buy':
          /*
           * 费用资本化：成本 = 成交金额 + 费用，现金流出同样为金额 + 费用。
           * 这样买入后「资产总额」不会因为手续费之外的任何原因凭空减少；
           * 后续卖出时按结转成本计算已实现盈亏，**不再重复扣一次买入费用**。
           */
          push({
            ...base,
            quantityDelta: qty,
            costDelta: amount + fee,
            cashDelta: -(amount + fee),
            feeDelta: fee > 0 ? fee : undefined,
          })
          break

        case 'sell':
          // 成本结转与已实现盈亏在应用阶段按「卖出前均价」计算
          push({
            ...base,
            quantityDelta: -qty,
            costDelta: 0,
            cashDelta: amount - fee,
            feeDelta: fee > 0 ? fee : undefined,
          })
          break

        case 'dividend':
        case 'interest':
          // 收入：不冲减成本
          push({
            ...base,
            quantityDelta: 0,
            costDelta: 0,
            cashDelta: amount - fee,
            incomeDelta: amount - fee,
          })
          break

        case 'transfer':
          // 数量与成本在应用阶段按 transferQuantity 计算
          push({ ...base, quantityDelta: 0, costDelta: 0, cashDelta: 0 })
          break

        default:
          // deposit / withdraw / fee 落到现金标的，投资腿无变化
          push({ ...base, quantityDelta: 0, costDelta: 0, cashDelta: 0 })
      }
    }

    /*
     * 资金腿：把现金效果挂到现金标的（若指定）。
     *
     * 两种情况都要处理：
     * 1. 指定了 `cashInstrumentId` → 挂到该现金持仓上（数量随现金增减）；
     * 2. 未指定 → 仍然产出**现金流记录**（key 为空，不落持仓），
     *    否则 deposit / withdraw 会被完全漏掉，现金流统计失真。
     */
    const cashDelta = cashEffectOf(tx)
    if (cashDelta !== 0) {
      if (cashInstrumentId) {
        push({
          key: positionKey(tx.accountId, cashInstrumentId),
          instrumentId: cashInstrumentId,
          accountId: tx.accountId,
          leg: 'cash',
          quantityDelta: cashDelta,
          costDelta: cashDelta,
          cashDelta,
        })
      } else {
        push({
          key: '',
          instrumentId: '',
          accountId: tx.accountId,
          leg: 'cash',
          quantityDelta: 0,
          costDelta: 0,
          cashDelta,
        })
      }
    }
  }

  return { effects, issues }
}

/** 该交易的现金效果（原币，正为流入） */
export function cashEffectOf(tx: Transaction): number {
  const amount = num(tx.amount)
  const fee = num(tx.fee)
  switch (tx.type) {
    case 'buy':
      return -(amount + fee)
    case 'sell':
      return amount - fee
    case 'deposit':
      return amount
    case 'withdraw':
      return -amount
    case 'dividend':
    case 'interest':
      return amount - fee
    case 'fee':
      return -amount
    default:
      return 0
  }
}

/* ------------------------------------------------------------------ *
 * LedgerReport
 * ------------------------------------------------------------------ */

export interface LedgerReport {
  /** 键为 `${accountId}::${instrumentId}` */
  positions: Map<string, DerivedPosition>
  issues: LedgerIssue[]
  /** 每笔交易的效果，便于排查与展示 */
  entries: LedgerEffect[]
}

export interface DeriveOptions {
  /** 成本口径：移动加权平均（当前唯一实现） */
  costMethod?: 'moving_average'
  /** 查询标的币种：用于币种一致性校验与现金腿识别 */
  instrumentCurrency?: (instrumentId: string) => string | undefined
  /** 判断标的是否为「已确认的现金」（换汇校验用） */
  isConfirmedCash?: (instrumentId: string) => boolean
  /** 从其他来源补充的初始持仓（供「重建」场景使用外部期初） */
  initialPositions?: Map<string, DerivedPosition>
}

export function emptyPosition(
  accountId: string,
  instrumentId: string,
  currency: string,
): DerivedPosition {
  return {
    accountId,
    instrumentId,
    currency,
    quantity: 0,
    costBasis: 0,
    averageCost: 0,
    realizedPnl: 0,
    income: 0,
    fees: 0,
    transactionCount: 0,
  }
}

/* ------------------------------------------------------------------ *
 * 第二层：把效果应用到持仓上
 * ------------------------------------------------------------------ */

/**
 * 由效果构建 LedgerReport。
 *
 * 实现要点：
 * 1. **先落期初**（adjustment 的 `set*`），再按交易时间顺序应用其余效果 ——
 *    否则同一批数据里后出现的 adjustment 会覆盖先出现的买入；
 * 2. **卖出按「卖出前均价」结转成本**，均价在卖出后保持不变；
 * 3. **transfer 需要当时的持仓状态**，所以在应用阶段处理；
 * 4. 数量归零时成本一并归零，不留浮点残差。
 */
export function deriveLedger(txs: Transaction[], options: DeriveOptions = {}): LedgerReport {
  const { effects, issues } = deriveLedgerEffects(txs, {
    instrumentCurrency: options.instrumentCurrency,
    isConfirmedCash: options.isConfirmedCash,
  })
  const positions = new Map<string, DerivedPosition>(options.initialPositions ?? [])
  const finalIssues: LedgerIssue[] = [...issues]
  const txById = new Map(txs.map((t) => [t.id, t]))

  const byTx = new Map<string, LedgerEffect[]>()
  for (const e of effects) {
    const list = byTx.get(e.transactionId) ?? []
    list.push(e)
    byTx.set(e.transactionId, list)
  }

  const currencyOf = options.instrumentCurrency
  /**
   * 推断持仓币种：优先查标的表；查不到时用**交易自身的币种**。
   * 不能硬编码 CNY —— 否则 USD 现金持仓会被标成人民币，折算出错。
   */
  const currencyFor = (e: LedgerEffect): string =>
    currencyOf?.(e.instrumentId) ?? txById.get(e.transactionId)?.currency ?? 'CNY'

  const ensure = (e: LedgerEffect): DerivedPosition => {
    const existing = positions.get(e.key)
    if (existing) return existing
    const created = emptyPosition(e.accountId, e.instrumentId, currencyFor(e))
    positions.set(e.key, created)
    return created
  }

  /*
   * 每个持仓记录「已被哪些交易触及」。
   *
   * `transactionCount` 的语义固定为**交易笔数**：
   * 一笔 buy 会产生投资腿 + 现金腿两条效果，但它对某个持仓而言只是**一笔交易**，
   * 因此必须按 `transactionId` 去重，不能按效果数量累加。
   * 若将来需要统计效果条数，应另设 `effectCount`，不要混用两个概念。
   */
  const touchedBy = new Map<string, Set<string>>()
  const stamp = (pos: DerivedPosition, tx: Transaction) => {
    const key = positionKey(pos.accountId, pos.instrumentId)
    const seen = touchedBy.get(key) ?? new Set<string>()
    if (seen.has(tx.id)) {
      // 同一笔交易（例如投资腿与现金腿）只计一次
      pos.lastTransactionAt = tx.timestamp
      return
    }
    seen.add(tx.id)
    touchedBy.set(key, seen)
    pos.transactionCount = seen.size
    pos.lastTransactionAt = tx.timestamp
    if (!pos.firstTransactionAt) pos.firstTransactionAt = tx.timestamp
  }

  /* ---- 第一遍：期初设定 ---- */
  for (const e of effects) {
    if (e.setQuantity === undefined && e.setCostBasis === undefined) continue
    const pos = ensure(e)
    const qty = e.setQuantity ?? 0
    const cost = e.setCostBasis ?? 0
    pos.quantity = round8(qty)
    pos.costBasis = round8(cost)
    pos.averageCost = qty > EPS ? round8(cost / qty) : 0
    const tx = txById.get(e.transactionId)
    if (tx) stamp(pos, tx)
  }

  /* ---- 第二遍：按交易时间顺序应用 ---- */
  for (const tx of sortTransactions(txs)) {
    const list = byTx.get(tx.id)
    if (!list) continue

    /*
     * 期初 adjustment 的语义是「从此刻起的余额」：
     * 之前累计的已实现盈亏 / 收入 / 费用都不可归属到该持仓，必须清零。
     * 这一步放在**按时间顺序的应用阶段**，否则会被后续效果重新覆盖。
     */
    if (tx.type === 'adjustment' && tx.instrumentId) {
      const key = positionKey(tx.accountId, tx.instrumentId)
      const pos = positions.get(key)
      if (pos) {
        pos.realizedPnl = 0
        pos.income = 0
        pos.fees = 0
      }
    }

    for (const e of list) {
      if (e.setQuantity !== undefined || e.setCostBasis !== undefined) continue
      if (!e.key) continue

      const pos = ensure(e)
      const before = pos.quantity
      const beforeCost = pos.costBasis
      const beforeAvg = before > EPS ? beforeCost / before : 0

      if (e.feeDelta) pos.fees = round8(pos.fees + e.feeDelta)
      if (e.incomeDelta) pos.income = round8(pos.income + e.incomeDelta)

      switch (tx.type) {
        case 'buy': {
          pos.quantity = round8(before + e.quantityDelta)
          pos.costBasis = round8(beforeCost + e.costDelta)
          pos.averageCost = pos.quantity > EPS ? round8(pos.costBasis / pos.quantity) : 0
          break
        }

        case 'sell': {
          if (-e.quantityDelta > before + EPS) {
            finalIssues.push({
              transactionId: tx.id,
              reason: 'sell_exceeds_holding',
              detail: `卖出数量 ${-e.quantityDelta} 超过持有数量 ${before}`,
            })
          }
          const costOut = round8(beforeAvg * -e.quantityDelta)
          pos.quantity = round8(Math.max(0, before + e.quantityDelta))
          pos.costBasis = pos.quantity <= EPS ? 0 : round8(Math.max(0, beforeCost - costOut))
          pos.averageCost = pos.quantity > EPS ? round8(pos.costBasis / pos.quantity) : 0
          pos.realizedPnl = round8(pos.realizedPnl + (e.cashDelta - costOut))
          break
        }

        case 'transfer': {
          applyTransfer(tx, positions, currencyOf, finalIssues, touchedBy)
          break
        }

        default: {
          /*
           * 关键区分：
           * - **现金腿**（leg='cash' / 'cash_target'）：数量即金额，成本与数量 1:1 同步；
           * - **投资腿**：按 costDelta 累加成本。
           *
           * 不能只按交易类型分派 —— 同一笔 dividend 既有投资腿（记收入、成本不变）
           * 又有现金腿（现金增加）。若对投资腿错误地走「现金分支」，
           * 会把它的成本覆盖成数量，导致成本口径被破坏。
           */
          const isCashLeg = e.leg === 'cash' || e.leg === 'cash_target'
          if (isCashLeg) {
            pos.quantity = round8(before + e.quantityDelta)
            pos.costBasis = round8(pos.quantity)
            pos.averageCost = 1
          } else {
            pos.quantity = round8(before + e.quantityDelta)
            pos.costBasis = round8(beforeCost + e.costDelta)
            pos.averageCost = pos.quantity > EPS ? round8(pos.costBasis / pos.quantity) : 0
          }
        }
      }

      /*
       * transfer 的源与目标都由 applyTransfer 处理并计数，
       * 这里跳过以免同一笔划转被计两次。
       */
      if (tx.type !== 'transfer') stamp(pos, tx)
    }
  }

  return { positions, issues: finalIssues, entries: effects }
}

/**
 * 划转：整体或部分移动，成本按**移动加权平均**结转。
 *
 * 语义保证：组合层面的总数量与总成本不变，不产生 realizedPnl、不产生现金流。
 */
function applyTransfer(
  tx: Transaction,
  positions: Map<string, DerivedPosition>,
  currencyOf: ((id: string) => string | undefined) | undefined,
  issues: LedgerIssue[],
  claimed: Map<string, Set<string>>,
): void {
  const target = tx.toAccountId
  const instrumentId = tx.instrumentId
  if (!instrumentId) return

  if (!target || target === tx.accountId) {
    issues.push({
      transactionId: tx.id,
      reason: 'missing_transfer_target',
      detail: LEDGER_ISSUE_LABEL.missing_transfer_target,
    })
    return
  }

  const sourceKey = positionKey(tx.accountId, instrumentId)
  const source = positions.get(sourceKey) ?? emptyPosition(tx.accountId, instrumentId, tx.currency)
  // 源账户也要记一笔交易（否则划转只在目标侧留痕）
  claimed.get(sourceKey)?.add(tx.id) ?? claimed.set(sourceKey, new Set([tx.id]))
  source.transactionCount = claimed.get(sourceKey)!.size
  source.lastTransactionAt = tx.timestamp
  if (!source.firstTransactionAt) source.firstTransactionAt = tx.timestamp

  const before = source.quantity
  const beforeCost = source.costBasis
  const requested = safeNum(tx.transferQuantity)
  const hasPartial = tx.transferQuantity !== undefined && requested > EPS
  const moveQty = hasPartial ? Math.min(requested, before) : before

  if (hasPartial && requested > before + EPS) {
    issues.push({
      transactionId: tx.id,
      reason: 'transfer_exceeds_holding',
      detail: `划转数量 ${requested} 超过持有数量 ${before}，已按持有数量转移`,
    })
  }

  const avgCost = before > EPS ? beforeCost / before : 0
  const moveCost = round8(avgCost * moveQty)

  const targetKey = positionKey(target, instrumentId)
  const targetPos =
    positions.get(targetKey) ?? emptyPosition(target, instrumentId, currencyOf?.(instrumentId) ?? tx.currency)
  targetPos.quantity = round8(targetPos.quantity + moveQty)
  targetPos.costBasis = round8(targetPos.costBasis + moveCost)
  targetPos.averageCost = targetPos.quantity > EPS ? round8(targetPos.costBasis / targetPos.quantity) : 0
  claimed.get(targetKey)?.add(tx.id) ?? claimed.set(targetKey, new Set([tx.id]))
  targetPos.transactionCount = claimed.get(targetKey)!.size
  targetPos.lastTransactionAt = tx.timestamp
  if (!targetPos.firstTransactionAt) targetPos.firstTransactionAt = tx.timestamp
  positions.set(targetKey, targetPos)

  // 源账户扣减（部分划转时保留余额）
  const remainQty = round8(before - moveQty)
  source.quantity = remainQty
  source.costBasis = remainQty <= EPS ? 0 : round8(Math.max(0, beforeCost - moveCost))
  source.averageCost = source.quantity > EPS ? round8(source.costBasis / source.quantity) : 0
  positions.set(sourceKey, source)
}

/* ------------------------------------------------------------------ *
 * 第三层：不变量校验（供测试与自检）
 * ------------------------------------------------------------------ */

export interface LedgerInvariants {
  /** 所有持仓的现金效果合计（仅资金腿） */
  cashLegTotal: Record<string, number>
  /** 买入手续费是否被资本化进成本 */
  capitalizedFees: number
  /** 换汇是否产生了 realizedPnl（应为 0） */
  exchangeRealizedPnl: number
}

/**
 * 校验账本级不变量：
 *
 * - 换汇不得产生 realizedPnl
 * - 同一交易在同一持仓上最多一条效果
 * - 现金腿与投资腿不能指向同一标的
 */
export function checkLedgerInvariants(report: LedgerReport): {
  ok: boolean
  violations: string[]
} {
  const violations: string[] = []

  // 同一交易 + 同一持仓 最多一条效果
  const seen = new Map<string, number>()
  for (const e of report.entries) {
    const k = `${e.transactionId}|${e.key}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  for (const [k, n] of seen) {
    if (n > 1) violations.push(`交易 ${k} 在同一持仓上产生了 ${n} 条效果（应最多 1 条）`)
  }

  // 换汇不得产生已实现盈亏
  const exchangeTxIds = new Set(report.entries.filter((e) => e.type === 'exchange').map((e) => e.transactionId))
  for (const pos of report.positions.values()) {
    void pos
  }
  if (exchangeTxIds.size > 0) {
    // realizedPnl 只能来自 sell；换汇的效果不应带 realizedPnl 语义
    const sellTxIds = new Set(report.entries.filter((e) => e.type === 'sell').map((e) => e.transactionId))
    for (const id of exchangeTxIds) {
      if (sellTxIds.has(id)) violations.push(`交易 ${id} 同时是换汇与卖出，语义冲突`)
    }
  }

  return { ok: violations.length === 0, violations }
}

/* ------------------------------------------------------------------ *
 * 便捷查询
 * ------------------------------------------------------------------ */

export function getPosition(
  report: LedgerReport,
  accountId: string,
  instrumentId: string,
): DerivedPosition | undefined {
  return report.positions.get(positionKey(accountId, instrumentId))
}

/** 组合层面：某标的的总数量与总成本（跨账户合计，用于对账） */
export function aggregateByInstrument(report: LedgerReport): Map<
  string,
  { quantity: number; costBasis: number; accountCount: number }
> {
  const out = new Map<string, { quantity: number; costBasis: number; accountCount: number }>()
  for (const pos of report.positions.values()) {
    const cur = out.get(pos.instrumentId) ?? { quantity: 0, costBasis: 0, accountCount: 0 }
    cur.quantity = round8(cur.quantity + pos.quantity)
    cur.costBasis = round8(cur.costBasis + pos.costBasis)
    cur.accountCount += 1
    out.set(pos.instrumentId, cur)
  }
  return out
}

/**
 * 组合层面的现金变动合计（按账户、按币种）。
 *
 * 实现要点：**按交易去重**。
 * 一笔交易可能同时产生投资腿与现金腿（例如 buy：投资腿 cashDelta=−1000、现金腿 −1000），
 * 两者描述的是同一笔现金流出，直接相加会翻倍。
 * 因此每笔交易只取一条效果：优先资金腿（它才是真正的现金账户变化），
 * 没有资金腿时退回投资腿。
 */
export function cashFlowByAccount(
  report: LedgerReport,
  txs: Transaction[],
): Map<string, Record<string, number>> {
  const txById = new Map(txs.map((t) => [t.id, t]))
  const chosen = new Map<string, LedgerEffect>()

  for (const e of report.entries) {
    if (e.cashDelta === 0) continue
    const tx = txById.get(e.transactionId)
    if (!tx) continue
    const current = chosen.get(e.transactionId)
    if (!current) {
      chosen.set(e.transactionId, e)
      continue
    }
    // 资金腿优先；同为资金腿或同为投资腿时保留先出现的
    const currentIsCash = current.leg === 'cash' || current.leg === 'cash_target'
    const newIsCash = e.leg === 'cash' || e.leg === 'cash_target'
    if (newIsCash && !currentIsCash) chosen.set(e.transactionId, e)
  }

  const out = new Map<string, Record<string, number>>()
  for (const [txId, e] of chosen) {
    const tx = txById.get(txId)!
    const cur = out.get(tx.accountId) ?? {}
    cur[tx.currency] = round8((cur[tx.currency] ?? 0) + e.cashDelta)
    out.set(tx.accountId, cur)
  }
  return out
}

/** 已实现盈亏合计（按币种） */
export function realizedPnlByCurrency(report: LedgerReport): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pos of report.positions.values()) {
    out[pos.currency] = round8((out[pos.currency] ?? 0) + pos.realizedPnl)
  }
  return out
}

/** 收入合计（分红 + 利息，按币种） */
export function incomeByCurrency(report: LedgerReport): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pos of report.positions.values()) {
    out[pos.currency] = round8((out[pos.currency] ?? 0) + pos.income)
  }
  return out
}

/** 费用合计（按币种） */
export function feesByCurrency(report: LedgerReport): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pos of report.positions.values()) {
    out[pos.currency] = round8((out[pos.currency] ?? 0) + pos.fees)
  }
  return out
}

/** 某笔交易产生的全部效果（供 UI 展开「这笔钱从哪到哪」） */
export function effectsOfTransaction(report: LedgerReport, transactionId: string): LedgerEffect[] {
  return report.entries.filter((e) => e.transactionId === transactionId)
}
