/**
 * 冷启动：创建账户 / 标的 / 手动口径持仓（Phase 8 / W7）
 *
 * ## 解决什么问题
 *
 * W7 审计发现：2.0 全 UI 对 `accounts` 的写入调用数是 **0**。
 * 结果是**新用户拿到的是一个死应用** —— 打开「记一笔」时账户下拉框为空，
 * 提交只会得到「请选择账户」，而没有任何办法创建账户。
 * 换机、恢复备份后同样如此。
 *
 * 本模块补齐这个**能力断点**。
 *
 * ## 分层（与 W4/W5/W6 完全同构）
 *
 * ```
 * UI → createAccount() / createInstrument() / createManualHolding()
 *        ↓
 *      ① 参数校验（业务前置检查）
 *      ② 构造实体
 *      ③ 校验不变量
 *      ④ 经 Repository 写入 IndexedDB
 *        ↓
 *      IndexedDB（唯一事实源）
 * ```
 *
 * **不建立第二套事实源**：全部复用既有 `PortfolioRepository`。
 *
 * ## 三条硬规则
 *
 * | 规则 | 说明 |
 * | --- | --- |
 * | **资产类别必须用户明确选择** | `assetClass` 是必填入参，**绝不按名称/代码猜测** |
 * | 不创建重复实体 | 同名账户 / 同代码+币种标的拒绝 |
 * | 手动口径持仓不参与 Ledger | `valuationMode: 'manual'`，靠 `manualValue` 表达 |
 *
 * ## 为什么人工创建的标的直接是 `confirmed`
 *
 * 因为类别是**用户自己选的**，不是系统推断的 —— 这正是
 * `ClassificationSource` 的 `user_confirmed` 语义。
 * 这不是「自动分类」，恰恰相反：它是分类确认的唯一合法来源。
 */

import type {
  Account,
  AccountRegion,
  AccountType,
  AssetClass,
  ClassificationSource,
  CurrencyCode,
  Holding,
  Instrument,
  InstrumentType,
  Portfolio2,
  Region,
} from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'

/* ------------------------------------------------------------------ *
 * 结果类型（与 W4/W6 同构）
 * ------------------------------------------------------------------ */

export type CreateFailureCode =
  | 'invalid-input'
  | 'duplicate'
  | 'missing-reference'
  | 'invariant-violated'

export interface CreateFailure {
  ok: false
  code: CreateFailureCode
  message: string
}

/* ------------------------------------------------------------------ *
 * 账户
 * ------------------------------------------------------------------ */

export interface CreateAccountInput {
  name: string
  type: AccountType
  currency: CurrencyCode
  region?: AccountRegion
  institution?: string
  /** 该账户整体属于负债（信用卡 / 贷款） */
  isLiability?: boolean
  note?: string
  now?: () => Date
}

export interface CreateAccountSuccess {
  ok: true
  account: Account
}

export type CreateAccountResult = CreateAccountSuccess | CreateFailure

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  // 时间戳 + 自增 + 随机，避免同毫秒内碰撞
  return `${prefix}_${Date.now().toString(36)}_${seq}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 创建账户。
 *
 * 同名账户（同币种）会被拒绝 —— 避免用户误建两份看着一样的账户。
 */
export async function createAccount(
  repo: PortfolioRepository,
  input: CreateAccountInput,
): Promise<CreateAccountResult> {
  const portfolio = await repo.loadPortfolio()

  const name = input.name?.trim()
  if (!name) return { ok: false, code: 'invalid-input', message: '请填写账户名称' }
  if (!input.type) return { ok: false, code: 'invalid-input', message: '请选择账户类型' }
  if (!input.currency) return { ok: false, code: 'invalid-input', message: '请选择账户币种' }

  const dup = portfolio.accounts.find(
    (a) => a.name.trim() === name && a.currency === input.currency,
  )
  if (dup) {
    return {
      ok: false,
      code: 'duplicate',
      message: `已存在同名同币种的账户「${name}（${input.currency}）」，请改名或直接使用它`,
    }
  }

  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  const account: Account = {
    id: nextId('acc'),
    name,
    institution: input.institution?.trim() || undefined,
    type: input.type,
    region: input.region,
    currency: input.currency,
    isLiability: input.isLiability === true,
    note: input.note?.trim() || undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
  }

  await repo.accounts.put(account)
  return { ok: true, account }
}

/* ------------------------------------------------------------------ *
 * 标的
 * ------------------------------------------------------------------ */

export interface CreateInstrumentInput {
  name: string
  instrumentType: InstrumentType
  /**
   * 资产类别 —— **必填，由用户明确选择**。
   *
   * 绝不按名称 / 代码 / 品类猜测。这是核心原则：
   * 「不自动分类」在创建路径上同样是硬约束。
   */
  assetClass: AssetClass
  currency: CurrencyCode
  symbol?: string
  region?: Region
  /** 自住房、应收等属于个人，来源仍记为用户确认 */
  source?: ClassificationSource
  now?: () => Date
}

export interface CreateInstrumentSuccess {
  ok: true
  instrument: Instrument
}

export type CreateInstrumentResult = CreateInstrumentSuccess | CreateFailure

/** 有代码的标的：同「代码 + 币种」视为同一标的，不允许重复 */
export async function createInstrument(
  repo: PortfolioRepository,
  input: CreateInstrumentInput,
): Promise<CreateInstrumentResult> {
  const portfolio = await repo.loadPortfolio()

  const name = input.name?.trim()
  if (!name) return { ok: false, code: 'invalid-input', message: '请填写标的名称' }
  if (!input.instrumentType) {
    return { ok: false, code: 'invalid-input', message: '请选择标的品类' }
  }
  if (!input.assetClass) {
    // 这条分支是刻意保留的防线：UI 不预选、不推断
    return {
      ok: false,
      code: 'invalid-input',
      message: '请明确选择资产类别（系统不会替你猜测）',
    }
  }
  if (!input.currency) return { ok: false, code: 'invalid-input', message: '请选择计价币种' }

  const symbol = input.symbol?.trim() || undefined

  // 有代码时按「代码 + 币种」判重；无代码时按「名称 + 币种」
  const dup = symbol
    ? portfolio.instruments.find(
        (i) => i.symbol && i.symbol.toUpperCase() === symbol.toUpperCase() && i.currency === input.currency,
      )
    : portfolio.instruments.find((i) => i.name.trim() === name && i.currency === input.currency)

  if (dup) {
    return {
      ok: false,
      code: 'duplicate',
      message: symbol
        ? `已存在代码为 ${symbol}（${input.currency}）的标的「${dup.name}」，请直接使用它`
        : `已存在同名同币种的标的「${name}（${input.currency}）」，请改名或直接使用它`,
    }
  }

  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  const instrument: Instrument = {
    id: nextId('inst'),
    symbol,
    name,
    instrumentType: input.instrumentType,
    assetClass: input.assetClass,
    region: input.region,
    currency: input.currency,
    // 类别由用户自己选择 → 直接是已确认状态（这不是「自动分类」）
    classificationStatus: 'confirmed',
    classificationSource: input.source ?? 'user_confirmed',
    createdAt: nowIso,
    updatedAt: nowIso,
  }

  await repo.instruments.put(instrument)
  return { ok: true, instrument }
}

/* ------------------------------------------------------------------ *
 * 手动口径持仓
 * ------------------------------------------------------------------ */

export interface CreateManualHoldingInput {
  accountId: string
  instrumentId: string
  /** 当前价值（原币） */
  manualValue: number
  /** 价值记录时间（用于「多久没更新」提示） */
  manualValueAt?: string
  note?: string
  now?: () => Date
}

export interface CreateManualHoldingSuccess {
  ok: true
  holding: Holding
}

export type CreateManualHoldingResult = CreateManualHoldingSuccess | CreateFailure

/**
 * 创建**手动口径**持仓（房产、应收、未确认分类的现金等）。
 *
 * ## 为什么这类持仓不进入 Ledger
 *
 * 它们不由交易驱动，靠 `manualValue` 表达当前价值。
 * `valuationMode: 'manual'` 使其在 `rebuildHoldingsFromTransactions`
 * 中被**原样保留**，且默认不参与 `reconcileHoldings` 对账
 * （见 `ReconcileOptions.skipManualMode`）。
 *
 * ## 三条校验
 *
 * 1. 账户与标的必须真实存在（**不创建悬空引用**）
 * 2. 同一「账户 + 标的」只能有一条持仓（避免重复持仓）
 * 3. 金额必须是大于等于 0 的有限数字（**不可估值请留空，不要填 0 充数**）
 */
export async function createManualHolding(
  repo: PortfolioRepository,
  input: CreateManualHoldingInput,
): Promise<CreateManualHoldingResult> {
  const portfolio: Portfolio2 = await repo.loadPortfolio()

  if (!input.accountId) return { ok: false, code: 'invalid-input', message: '请选择账户' }
  if (!input.instrumentId) return { ok: false, code: 'invalid-input', message: '请选择标的' }

  const account = portfolio.accounts.find((a) => a.id === input.accountId)
  if (!account) {
    return { ok: false, code: 'missing-reference', message: '所选账户不存在（不会创建悬空引用）' }
  }
  const instrument = portfolio.instruments.find((i) => i.id === input.instrumentId)
  if (!instrument) {
    return { ok: false, code: 'missing-reference', message: '所选标的不存在（不会创建悬空引用）' }
  }

  if (!Number.isFinite(input.manualValue) || input.manualValue < 0) {
    return {
      ok: false,
      code: 'invalid-input',
      message: '金额必须是大于等于 0 的有限数字（无法估值请留空，不要用 0 替代）',
    }
  }

  /*
   * ## 不得与「交易驱动」的持仓冲突（W11 Blocker Patch，P0-1）
   *
   * 持仓表不变量：一个 `(账户, 标的)` 只能有一条持仓。
   *
   * 若该 key 上的持仓由交易所驱动（`valuationMode !== 'manual'`），
   * 再建一条手动持仓就会产生同 key 的第二条 → `duplicate-holding`
   * → **该账户从此无法再记账**（且应用内无修复入口）。
   *
   * 因此在创建前明确拒绝，并告诉用户可行做法。**不静默改动那条持仓**。
   */
  const drivingHolding = portfolio.holdings.find(
    (h) =>
      h.accountId === input.accountId &&
      h.instrumentId === input.instrumentId &&
      h.valuationMode !== 'manual',
  )
  if (drivingHolding) {
    return {
      ok: false,
      code: 'duplicate',
      message:
        `该账户下「${instrument.name}」已经由交易记录驱动（数量口径）。` +
        '同一账户的同一标的只能有一条持仓记录 —— ' +
        '若这笔资产与那笔交易不是同一份，请为它单独建一个账户后登记。',
    }
  }

  const existing = portfolio.holdings.find(
    (h) => h.accountId === input.accountId && h.instrumentId === input.instrumentId,
  )
  if (existing) {
    return {
      ok: false,
      code: 'duplicate',
      message:
        `该账户下已有「${instrument.name}」的持仓` +
        `（${existing.valuationMode === 'manual' ? '手动口径' : '数量口径'}）。` +
        '同一账户的同一标的只能有一条持仓记录。',
    }
  }

  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  const holding: Holding = {
    id: nextId('hold'),
    accountId: input.accountId,
    instrumentId: input.instrumentId,
    valuationMode: 'manual',
    manualValue: input.manualValue,
    manualValueAt: input.manualValueAt ?? nowIso,
    openedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    note: input.note?.trim() || undefined,
  }

  await repo.holdings.put(holding)
  return { ok: true, holding }
}

/* ------------------------------------------------------------------ *
 * 冷启动状态（供空态引导）
 * ------------------------------------------------------------------ */

export interface ColdStartState {
  /** 完全没有账户 */
  noAccounts: boolean
  /** 完全没有标的 */
  noInstruments: boolean
  /** 有账户也有标的，但没有任何持仓 */
  noHoldings: boolean
  /** 可以开始记交易了吗（有账户 + 有非现金标的或有现金标的） */
  canRecordTransaction: boolean
}

export function coldStartStateOf(portfolio: Portfolio2): ColdStartState {
  const noAccounts = portfolio.accounts.length === 0
  const noInstruments = portfolio.instruments.length === 0
  return {
    noAccounts,
    noInstruments,
    noHoldings: portfolio.holdings.length === 0,
    canRecordTransaction: !noAccounts && !noInstruments,
  }
}

export type { AccountRegion, AccountType, AssetClass, InstrumentType }
