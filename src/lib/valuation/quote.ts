/**
 * Quote 可用性判定
 *
 * 需求第二十九条：必须有 LIVE / DELAYED / STALE / CLOSED / ERROR / MANUAL，
 * 且**不能因为 API 失败就继续显示「实时」**。
 *
 * 本模块只回答一个问题：这条行情**能不能用来估值**，以及不能用时原因是什么。
 */

import type { Quote, QuoteStatus } from '../../types/portfolio2'
import type { ValuationReason } from './types'
import { DEFAULT_QUOTE_POLICY, type QuotePolicy } from './policy'

/**
 * 各状态的新鲜度阈值：统一来自可配置的 QuotePolicy。
 * 保留此导出仅为兼容；新代码请直接使用 policy。
 */
export const QUOTE_FRESHNESS_MS: Record<QuoteStatus, number> = DEFAULT_QUOTE_POLICY.freshnessMs

export type QuoteUsability =
  | { usable: true; price: number; status: QuoteStatus }
  | { usable: false; reason: ValuationReason; status: QuoteStatus }

/** 取该行情实际代表的价格（按 priceKind 决定哪个字段有效） */
export function quotePrice(q: Quote): number | undefined {
  switch (q.priceKind) {
    case 'market_price':
      return q.marketPrice
    case 'nav':
      return q.nav
    case 'estimated_nav':
      return q.estimatedNav
    case 'manual':
      // 手动价可能写在 marketPrice（场内）或 nav（场外）
      return q.marketPrice ?? q.nav
    default:
      return undefined
  }
}

/**
 * 判定行情是否可用于估值。
 *
 * @param now 当前时间戳，便于测试
 * @param policy 时效策略；缺省用 DEFAULT_QUOTE_POLICY
 */
export function judgeQuote(
  q: Quote | undefined,
  now = Date.now(),
  policy: QuotePolicy = DEFAULT_QUOTE_POLICY,
): QuoteUsability {
  if (!q) return { usable: false, reason: 'missing_quote', status: 'ERROR' }

  if (q.status === 'ERROR') {
    return { usable: false, reason: 'error_quote', status: 'ERROR' }
  }

  const price = quotePrice(q)
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    return { usable: false, reason: 'missing_quote', status: q.status }
  }

  // 显式标成 STALE 的行情：有值但不可用于累计（由估值层决定是否作为展示值）
  if (q.status === 'STALE') {
    return { usable: false, reason: 'stale_quote', status: 'STALE' }
  }

  const t = new Date(q.timestamp).getTime()
  const age = Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY
  if (age > policy.freshnessMs[q.status]) {
    return { usable: false, reason: 'stale_quote', status: 'STALE' }
  }

  return { usable: true, price, status: q.status }
}

/**
 * 从一组行情里取「该标的最新的一条」。
 *
 * ## as-of 语义（Phase 8 / W8）
 *
 * 给出 `asOf` 时，只在 `timestamp <= asOf` 的行情里取最新一条 ——
 * 即「**在那一刻可用的**最新行情」。
 *
 * ### 为什么必须显式定义这一点
 *
 * W8 起行情**按时间点累积**（不再覆盖），因此「最新一条」在
 * 两个不同语境下含义不同：
 *
 * | 语境 | 应取 |
 * | --- | --- |
 * | **实时估值**（当前净值） | 全部行情里最新的（`asOf` 省略） |
 * | **快照捕获**（当时价值） | **`<= 捕获时刻`** 里最新的（传 `asOf`） |
 *
 * 传 `asOf` 可防止「未来日期的行情」影响今天的捕获；
 * 而**历史快照一旦写下就不再重算**（W8 的不变量），
 * 因此事后修改行情不会改变过去的快照。
 *
 * 同一 `timestamp` 有多条时不在此处裁决 ——
 * 业务键去重已保证同 (标的, priceKind, source, 时间点) 只有一条。
 */
export function latestQuoteFor(
  quotes: Quote[],
  instrumentId: string,
  asOf?: string,
): Quote | undefined {
  const cutoff = asOf === undefined ? Number.POSITIVE_INFINITY : new Date(asOf).getTime()
  let best: Quote | undefined
  let bestAt = Number.NEGATIVE_INFINITY
  for (const q of quotes) {
    if (q.instrumentId !== instrumentId) continue
    const t = new Date(q.timestamp).getTime()
    if (!Number.isFinite(t) || t > cutoff) continue
    if (t > bestAt) {
      best = q
      bestAt = t
    }
  }
  return best
}

/** 供 UI 展示的行情状态文案补充（例如「已收盘」与「已过期」含义不同） */
export function describeQuoteStatus(status: QuoteStatus): string {
  switch (status) {
    case 'LIVE':
      return '实时'
    case 'DELAYED':
      return '延迟'
    case 'STALE':
      return '已过期'
    case 'CLOSED':
      return '已收盘'
    case 'ERROR':
      return '获取失败'
    case 'MANUAL':
      return '手动'
  }
}
