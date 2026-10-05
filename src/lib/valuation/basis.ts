/**
 * 估值依据（Phase 8 / W6）
 *
 * ## 解决什么问题
 *
 * W6 审计发现：「显示有价格，但无法证明来源 / 状态」。
 *
 * 具体证据：
 * - `PRICE_KIND_LABEL` / `QUOTE_STATUS_LABEL` / `FX_STATUS_LABEL` /
 *   `VALUATION_REASON_LABEL` 四张中文标签表**全部零引用**；
 * - `ValuationResult.asOf`（依据时间）、`Quote.source`、`Quote.timestamp`
 *   在 2.0 全部页面零展示；
 * - 资产页直接输出内部代码（`missing_fx`、`stale_quote`）。
 *
 * 本模块把这些信息**组装成可直接展示的一句话**，让每个金额都能回答：
 * 「价格从哪来、几点的、可不可靠」。
 *
 * ## 纯函数，不参与任何估值计算
 *
 * 它只读取既有的 `ValuationResult` 与 `Quote`，**不改变任何金额**。
 */

import type { Portfolio2, Quote } from '../../types/portfolio2'
import type { ValuationResult } from './types'
import { VALUATION_REASON_LABEL, type ValuationReason } from './types'
import { PRICE_KIND_LABEL, QUOTE_STATUS_LABEL, FX_STATUS_LABEL } from '../../types/portfolio2'

/** 估值状态的中文标签（补齐之前缺失的这张表） */
export const VALUATION_STATUS_LABEL: Record<ValuationResult['status'], string> = {
  ok: '可靠估值',
  stale: '依据已过期',
  unavailable: '无法估值',
}

export interface ValuationBasis {
  /** 一句话依据，例如「市场价格 ¥12.30 · 2026-10-04 15:20 · 来源 manual · 手动」 */
  summary: string
  /** 价格类型（市场价 / 净值 / 估算净值 / 手动价） */
  priceKindLabel?: string
  /** 行情状态（实时 / 延迟 / 已收盘 / 手动 / 已过期 / 获取失败） */
  quoteStatusLabel?: string
  /** 行情来源（如 manual / fundgz） */
  source?: string
  /** 依据时间（ISO） */
  asOf?: string
  /** 该金额是否进入可靠总额 */
  reliable: boolean
  /** 中文降级原因（**不再是 `missing_fx` 这类内部代码**） */
  reasonLabels: string[]
}

function fmtTime(iso?: string): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 把内部 reason code 映射为中文；未知代码原样保留（不隐藏问题） */
export function reasonLabelsOf(reasons: ValuationReason[]): string[] {
  return reasons.map((r) => VALUATION_REASON_LABEL[r] ?? r)
}

/** 某标的当前生效的行情 */
export function quoteOf(portfolio: Portfolio2, instrumentId: string): Quote | undefined {
  const list = portfolio.quotes.filter((q) => q.instrumentId === instrumentId)
  if (list.length === 0) return undefined
  return list.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b))
}

/**
 * 组装某条持仓的估值依据。
 *
 * @param result   该持仓的估值结果（来自既有估值引擎）
 * @param portfolio 用于查行情与汇率状态
 * @param fxStatus  该持仓币种对 CNY 的汇率状态（由调用方从 fx 表解析；缺失表示缺汇率）
 */
export function valuationBasisOf(
  result: ValuationResult,
  portfolio: Portfolio2,
  /** 该持仓的标的 id（调用方本来就知道，避免从 holdingId 反查） */
  instrumentId: string,
  fxStatus?: { status: string; asOf: string; via?: string[] },
): ValuationBasis {
  const quote = quoteOf(portfolio, instrumentId)

  const reliable = result.status === 'ok'
  const reasonLabels = reasonLabelsOf(result.reasons)

  const priceKindLabel = quote ? PRICE_KIND_LABEL[quote.priceKind] : undefined
  const quoteStatusLabel = quote ? QUOTE_STATUS_LABEL[quote.status] : undefined

  /*
   * 依据时间优先取估值结果自带的 `asOf`
   * （它由引擎按「实际用到的依据」写入，比从行情反推更准确）。
   */
  const asOf = result.asOf ?? quote?.timestamp

  const parts: string[] = []
  if (priceKindLabel) parts.push(priceKindLabel)
  if (quoteStatusLabel) parts.push(quoteStatusLabel)
  if (quote?.source) parts.push(`来源 ${quote.source}`)
  const t = fmtTime(asOf)
  if (t) parts.push(t)

  if (fxStatus) {
    const fxLabel = FX_STATUS_LABEL[fxStatus.status as keyof typeof FX_STATUS_LABEL] ?? fxStatus.status
    parts.push(`汇率 ${fxLabel}`)
  }

  const summary = parts.length > 0 ? parts.join(' · ') : VALUATION_STATUS_LABEL[result.status]

  return {
    summary,
    priceKindLabel,
    quoteStatusLabel,
    source: quote?.source,
    asOf,
    reliable,
    reasonLabels,
  }
}

/** 组合层面的「行情覆盖率」摘要（供设置页/首页展示） */
export interface QuoteCoverageSummary {
  /** 有行情的标的数 */
  withQuote: number
  /** 需要行情但缺行情的标的数（现金与手动口径不需行情） */
  missingQuote: number
  /** 缺汇率的外币币种 */
  missingFxCurrencies: string[]
  /** 是否存在过期行情 */
  hasStale: boolean
}

export function quoteCoverageOf(portfolio: Portfolio2, now = Date.now()): QuoteCoverageSummary {
  const needQuote = portfolio.holdings.filter((h) => h.valuationMode === 'quantity')
  let withQuote = 0
  let missingQuote = 0
  let hasStale = false

  for (const h of needQuote) {
    const inst = portfolio.instruments.find((i) => i.id === h.instrumentId)
    if (inst?.instrumentType === 'cash') continue
    const q = quoteOf(portfolio, h.instrumentId)
    if (!q) {
      missingQuote += 1
      continue
    }
    withQuote += 1
    if (q.status === 'STALE') hasStale = true
  }

  // 缺汇率币种
  const needed = new Set<string>()
  for (const h of portfolio.holdings) {
    const inst = portfolio.instruments.find((i) => i.id === h.instrumentId)
    if (inst && inst.currency !== 'CNY') needed.add(inst.currency)
  }
  const missingFxCurrencies: string[] = []
  for (const c of needed) {
    const any = portfolio.fxRates.some((r) => r.baseCurrency === c || r.quoteCurrency === c)
    if (!any) missingFxCurrencies.push(c)
  }

  void now
  return { withQuote, missingQuote, missingFxCurrencies, hasStale }
}
