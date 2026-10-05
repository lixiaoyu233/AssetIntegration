/**
 * 估值引擎
 *
 * 严格按需求第二十八条的六步流程：
 *
 *   Holding → Instrument → Quote → 原币价值 → FX → CNY
 *
 * 任何一步无法可靠完成，就返回 `unavailable`（或 `stale`），
 * **绝不用 0 或 1:1 代替**（见 types.ts 的不变量说明）。
 *
 * 不同 valuationMode 的取值规则：
 *
 * | valuationMode | 原币价值来源 | 缺数据时 |
 * | --- | --- | --- |
 * | `manual`  | `Holding.manualValue`（现金/房产/应收） | `missing_value` → unavailable |
 * | `quantity`| `quantity × 行情价`（基金/股票/黄金） | `missing_quote` → unavailable |
 *
 * 注意：`quantity` 口径**不会**在缺少行情时静默改用成本价当市值 ——
 * 成本价只作为 `fallbackValueInCurrency` 提供给 UI 作线索，不参与总额。
 */

import type {
  AssetClass,
  CurrencyCode,
  Holding,
  Instrument,
  Portfolio2,
  Quote,
  FxStatus,
} from '../../types/portfolio2'
import { type FxTable, convert, createFxTable } from './fx'
import { judgeQuote, latestQuoteFor, quotePrice as quoteDisplayPrice } from './quote'
import { DEFAULT_QUOTE_POLICY, type QuotePolicy } from './policy'
import { decideLiability } from '../portfolio/liability'
import {
  type PortfolioTotals,
  type UnvaluedItem,
  type ValuationReason,
  type ValuationResult,
  createEmptyTotals,
} from './types'

export interface ValuationContext {
  portfolio: Portfolio2
  /** 行情/汇率时效策略；缺省用 DEFAULT_QUOTE_POLICY */
  policy?: QuotePolicy
  /** 汇率表；缺省视为「没有任何汇率」——此时所有外币都不可估值 */
  fx?: FxTable
  /** 当前时间戳，便于测试 */
  now?: number
  /**
   * 是否允许使用过期汇率/行情（标为 stale 但仍给出展示值）。
   * 无论是否允许，**stale 都不会计入总额**。
   */
  allowStale?: boolean
}

/**
 * 现金类标的：数量即金额。
 *
 * ## ⚠️ 判定必须**严格只看 `instrumentType`**
 *
 * 这里**故意不看** `assetClass === 'cash'`，原因是已实测的风险：
 * 若某个交易品种（股票/基金）被误标为 `assetClass: 'cash'`，
 * 估值会走出「数量即金额」路径，于是 **13 股被当成 13 元**，
 * 而且**不再查行情** —— 资产被静默算错，没有任何报错。
 *
 * 分类确认（`assetClass: 'cash'` + `classificationStatus: 'confirmed'`）只用于
 * **迁移与现金转换**的判断；一旦转换成现金持仓，标的的 `instrumentType`
 * 必须是 `'cash'`。两者职责不同，不要在这里放宽。
 */
function isCashInstrument(instrument: Instrument | undefined): boolean {
  return instrument?.instrumentType === 'cash'
}

function buildIndex(portfolio: Portfolio2) {
  return {
    instrumentById: new Map(portfolio.instruments.map((i) => [i.id, i])),
    accountById: new Map(portfolio.accounts.map((a) => [a.id, a])),
  }
}

/* ------------------------------------------------------------------ *
 * 单条持仓估值
 * ------------------------------------------------------------------ */

/**
 * 计算原币价值（与可靠性无关，仅用于按币种展示原币敞口）。
 * 优先级：可用估值原币 → 参考值 → 手动口径的金额。
 */
function nativeValueOf(
  holding: Holding,
  valueInCurrency: number | undefined,
  fallback: number | undefined,
): number | undefined {
  if (typeof valueInCurrency === 'number' && Number.isFinite(valueInCurrency)) return valueInCurrency
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback
  // 现金与手动口径：数量即金额
  if (holding.valuationMode === 'manual') {
    return typeof holding.manualValue === 'number' ? holding.manualValue : undefined
  }
  return undefined
}

/** 单条持仓估值（对外入口）。统一补上 nativeValue 后返回。 */
export function valuateHolding(
  holding: Holding,
  portfolio: Portfolio2,
  options: ValuationOptions = {},
): ValuationResult {
  const result = valuateHoldingInner(holding, portfolio, options)
  return {
    ...result,
    nativeValue: nativeValueOf(holding, result.valueInCurrency, result.fallbackValueInCurrency),
  }
}

export interface ValuationOptions {
  fx?: FxTable
  now?: number
  allowStale?: boolean
  policy?: QuotePolicy
}

function valuateHoldingInner(
  holding: Holding,
  portfolio: Portfolio2,
  options: ValuationOptions = {},
): ValuationResult {
  const now = options.now ?? Date.now()
  const policy = options.policy ?? DEFAULT_QUOTE_POLICY
  const fx = options.fx ?? createFxTable(portfolio.fxRates)
  const { instrumentById, accountById } = buildIndex(portfolio)

  const instrument: Instrument | undefined = instrumentById.get(holding.instrumentId)
  const account = accountById.get(holding.accountId)
  const reasons: ValuationReason[] = []

  /*
   * 负债判定只做一次（Phase 8 / W8）。
   *
   * 这是**唯一**的判定点：结果随 `ValuationResult` 向下游传递，
   * `calculateTotals` / `buildSnapshot` / `deriveAnalysis` 都读它，
   * 从而杜绝「一个地方认账户、另一个地方认类别」的口径漂移。
   */
  const liability = decideLiability(account, instrument)

  if (!instrument) {
    return {
      holdingId: holding.id,
      status: 'unavailable',
      currency: 'CNY',
      reasons: ['missing_instrument'],
      isLiability: liability.isLiability,
      liabilityReason: liability.reason,
      liabilityConflict: liability.conflict,
    }
  }
  // 归属账户缺失不阻断估值（金额仍可计算），但如实上报，便于 UI 提示用户补全
  if (!accountById.has(holding.accountId)) reasons.push('missing_account')

  const currency: CurrencyCode = instrument.currency

  /* ---- 第 4 步：原币价值 ---- */
  let valueInCurrency: number | undefined
  let asOf: string | undefined
  let fallbackValueInCurrency: number | undefined
  let quoteUnusableReason: ValuationReason | undefined
  /** 本次估值实际读到的行情记录（供 basis 上报） */
  let basisQuote: Quote | undefined
  /*
   * 非行情口径的**声明式依据**（Phase 8 / W8，P0-2）。
   *
   * `manual` 与「现金」两条路径**不读行情**，因此没有 `Quote` 可上报。
   * 但「价值来自手动填报」本身就是必须记录的依据 ——
   * 否则历史快照无法区分「手填的 100 万」与「有行情的 100 万」。
   *
   * ⚠️ 这里记录的是**真实存在的依据类型**（MANUAL / 数量即金额），
   * 不是编造的价格来源。
   */
  let declaredBasis:
    | { priceKind: 'manual'; quoteStatus: 'MANUAL'; quoteSource: string }
    | undefined

  if (holding.valuationMode === 'manual') {
    const v = holding.manualValue
    // 注意：0 是合法值（账户余额可以为 0），只有 undefined/NaN 才算缺失
    if (typeof v === 'number' && Number.isFinite(v)) {
      valueInCurrency = v
      asOf = holding.manualValueAt
      // 依据 = 用户手动填报（真实依据，非编造）
      declaredBasis = { priceKind: 'manual', quoteStatus: 'MANUAL', quoteSource: 'manual' }
    } else {
      reasons.push('missing_value')
    }
  } else if (isCashInstrument(instrument)) {
    /*
     * 现金持仓：`quantity` 即金额（原币），**不需要行情**。
     * 例如 USD 现金 quantity = 10000 → 原币价值 10000 USD，再按汇率折算。
     * 若走行情路径会因「没有报价」而被判为不可估值，那是错的。
     */
    const q = holding.quantity
    if (typeof q === 'number' && Number.isFinite(q)) {
      valueInCurrency = q
      asOf = holding.updatedAt
      /*
       * 现金的数量即金额 —— 这是**事实**（不是行情）。
       * 依据记为 `manual`（无外部价格来源），以便与「有行情的持仓」区分。
       */
      declaredBasis = { priceKind: 'manual', quoteStatus: 'MANUAL', quoteSource: 'quantity' }
    } else {
      reasons.push('missing_value')
    }
  } else {
    /*
     * ## as-of 接线（Phase 8 / W9，P1-2）
     *
     * `latestQuoteFor` 的 `asOf` 形参在 W8 就已定义（契约是
     * 「只取 timestamp <= 该时点 的最新行情」），但**调用点没有传**，
     * 于是它一直退化为「取全局最新」—— 一份**未来日期**的行情会
     * 被今天的估值/快照采用，W8 写下的契约实际不存在。
     *
     * 这里传入本次估值的时点 `now`：
     * - 实时估值：`now` = 当前时刻 → 只取「此刻已存在」的行情；
     * - 快照捕获：`now` = 捕获时刻 → 只取「捕获时已存在」的行情。
     *
     * ⚠️ 必须与 `judgeQuote` 用**同一个** `now`，
     * 否则「取到的行情」与「判定其是否过期」会基于不同时点。
     */
    const asOfIso = new Date(now).toISOString()
    const quote = latestQuoteFor(portfolio.quotes, holding.instrumentId, asOfIso)
    const judged = judgeQuote(quote, now, policy)
    // 无论可用与否都先记下依据（供快照落盘），取不到则为 undefined
    basisQuote = quote
    if (judged.usable) {
      valueInCurrency = (holding.quantity ?? 0) * judged.price
      asOf = quote?.timestamp
    } else {
      quoteUnusableReason = judged.reason
      reasons.push(judged.reason)

      // 过期行情：价格本身可以读出来，作为「展示值」提供给 UI（明确标记过期，不计入总额）
      if (judged.reason === 'stale_quote') {
        const price = quote ? quoteDisplayPrice(quote) : undefined
        if (price !== undefined) {
          fallbackValueInCurrency = (holding.quantity ?? 0) * price
        }
      } else if (typeof holding.costBasis === 'number' && Number.isFinite(holding.costBasis)) {
        // 其余情况（缺行情 / 行情失败）：成本价只作线索，同样不参与总额
        fallbackValueInCurrency = holding.costBasis
      }
    }
  }

  /* ---- 第 5、6 步：折算为 CNY ---- */
  // 只有拿到原币价值才谈得上折算；否则直接 unavailable
  if (valueInCurrency === undefined) {
    const isStaleCase = quoteUnusableReason === 'stale_quote' || quoteUnusableReason === 'stale_fx'
    /*
     * stale：行情过期但价格可读 → 额外给出**折后展示值**，
     * 供历史快照保留「当时的过期价」（P1-3）。
     * 它绝不参与总额（`status` 是 stale，下游只把它当展示值）。
     */
    let staleDisplayValueCny: number | undefined
    if (isStaleCase && fallbackValueInCurrency !== undefined) {
      const convertedFallback = convert(fallbackValueInCurrency, currency, 'CNY', fx, {
        now,
        allowStale: true,
        fxStaleMs: policy.fxStaleMs,
      })
      if (convertedFallback.ok) staleDisplayValueCny = convertedFallback.amount
    }

    return {
      holdingId: holding.id,
      status: isStaleCase ? 'stale' : 'unavailable',
      currency,
      reasons,
      assetClass: instrument.assetClass,
      fallbackValueInCurrency,
      asOf,
      staleDisplayValueCny,
      isLiability: liability.isLiability,
      liabilityReason: liability.reason,
      liabilityConflict: liability.conflict,
      basis: {
        priceKind: basisQuote?.priceKind ?? declaredBasis?.priceKind,
        quoteStatus: basisQuote?.status ?? declaredBasis?.quoteStatus,
        quoteSource: basisQuote?.source ?? declaredBasis?.quoteSource,
      },
    }
  }

  const converted = convert(valueInCurrency, currency, 'CNY', fx, {
    now,
    allowStale: options.allowStale,
    fxStaleMs: policy.fxStaleMs,
  })
  /*
   * 汇率依据：仅外币持仓记录。
   * `converted.rate.status` 是解析出的状态（LIVE/DELAYED/STALE/MANUAL），
   * `via` 为经过的币种路径。CNY→CNY 恒为 1，不算外部汇率依据。
   */
  const fxBasis =
    currency === 'CNY' || !converted.ok
      ? undefined
      : { fxStatus: converted.rate.status as FxStatus, fxSource: undefined }

  if (!converted.ok) {
    // 换算失败：明确区分「缺汇率」与「汇率过期」，并且**不给出 CNY 值**
    const reason: ValuationReason = converted.reason === 'stale_fx' ? 'stale_fx' : 'missing_fx'
    const allReasons = [...reasons, reason]
    return {
      holdingId: holding.id,
      status: converted.reason === 'stale_fx' ? 'stale' : 'unavailable',
      // 原币价值仍保留，便于 UI 展示「USD 10,000（暂无法折算）」
      valueInCurrency,
      currency,
      reasons: allReasons,
      assetClass: instrument.assetClass,
      fallbackValueInCurrency,
      asOf,
      isLiability: liability.isLiability,
      liabilityReason: liability.reason,
      liabilityConflict: liability.conflict,
    }
  }

  return {
    holdingId: holding.id,
    status: 'ok',
    value: converted.amount,
    valueInCurrency,
    currency,
    reasons,
    assetClass: instrument.assetClass,
    asOf: asOf ?? converted.rate.asOf,
    isLiability: liability.isLiability,
    liabilityReason: liability.reason,
    liabilityConflict: liability.conflict,
    basis: {
      priceKind: basisQuote?.priceKind ?? declaredBasis?.priceKind,
      quoteStatus: basisQuote?.status ?? declaredBasis?.quoteStatus,
      quoteSource: basisQuote?.source ?? declaredBasis?.quoteSource,
      ...fxBasis,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 组合汇总
 * ------------------------------------------------------------------ */

/**
 * 计算总资产 / 总负债 / 净资产。
 *
 * 返回**结构化**结果，让 UI 能区分：
 * ① 已可靠估值的金额（含按类别拆分）
 * ② 不可估值的项目数与明细
 * ③ 估值依据已过期的项目数与明细
 *
 * `totalAssets` / `totalLiabilities` / `netWorth` **只包含 status === 'ok' 的部分**；
 * 存在不可估值项时 `isComplete === false`，UI 必须提示用户。
 */
export function calculateTotals(context: ValuationContext): PortfolioTotals {
  const { portfolio } = context
  const totals = createEmptyTotals()
  totals.totalHoldings = portfolio.holdings.length

  const fx = context.fx ?? createFxTable(portfolio.fxRates)

  for (const holding of portfolio.holdings) {
    const r = valuateHolding(holding, portfolio, {
      fx,
      now: context.now,
      allowStale: context.allowStale,
      policy: context.policy,
    })

    if (r.status === 'ok' && r.value !== undefined) {
      /*
       * 负债判定**只读估值结果**（Phase 8 / W8 统一口径）。
       *
       * 原先这里自己写 `r.assetClass === 'liability'`，与账户的
       * `isLiability` 标记脱节 —— 用户勾选「这是负债账户」后净资产不变。
       * 现在由 `decideLiability()` 统一判定并随结果传递。
       */
      if (r.isLiability) {
        // 负债金额按绝对值计入，避免录入正负号不一致导致口径漂移
        totals.totalLiabilities += Math.abs(r.value)
      } else {
        totals.totalAssets += r.value
        const cls: AssetClass = r.assetClass ?? 'other'
        totals.reliableByAssetClass[cls] = (totals.reliableByAssetClass[cls] ?? 0) + r.value
      }
      totals.reliableCount += 1
      continue
    }

    const item: UnvaluedItem = {
      holdingId: holding.id,
      status: r.status === 'stale' ? 'stale' : 'unavailable',
      reasons: r.reasons,
      assetClass: r.assetClass,
      isLiability: r.isLiability,
      currency: r.currency,
      // stale 项的展示值：已是人民币则用它，否则用原币展示值（明确标注过期，不计入总额）
      displayValue: r.status === 'stale' ? (r.value ?? r.valueInCurrency ?? r.fallbackValueInCurrency) : undefined,
    }

    if (item.status === 'stale') {
      totals.staleCount += 1
      totals.staleItems.push(item)
    } else {
      totals.unavailableCount += 1
      totals.unavailableItems.push(item)
    }
  }

  totals.netWorth = totals.totalAssets - totals.totalLiabilities
  totals.isComplete = totals.unavailableCount === 0 && totals.staleCount === 0
  return totals
}

/**
 * 供 UI 使用的一句话摘要。
 * 明确告知「有多少项没被算进去」，避免用户误以为总额完整。
 */
export function describeTotals(t: PortfolioTotals): string {
  if (t.isComplete) return `共 ${t.totalHoldings} 项，已全部可靠估值`
  const parts: string[] = []
  if (t.unavailableCount > 0) parts.push(`${t.unavailableCount} 项无法估值`)
  if (t.staleCount > 0) parts.push(`${t.staleCount} 项估值依据已过期`)
  return `共 ${t.totalHoldings} 项，其中 ${t.reliableCount} 项已可靠估值；${parts.join('、')}（未计入总额）`
}
