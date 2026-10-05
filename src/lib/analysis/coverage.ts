/**
 * 完整性报告
 *
 * 分析层必须能回答「这个分布可靠吗、缺口在哪」。
 *
 * ## 两个独立维度，可以同时成立
 *
 * ```
 * classificationStatus = unconfirmed   ┐
 *                                      ├─ 同一持仓可以同时属于两者
 * valuationStatus      = unavailable   ┘
 * ```
 *
 * 因此 `unconfirmedCount` 与 `unavailableCount` **不是互斥的**，
 * 交集单独用 `unconfirmedAndUnavailableIds` 表达。
 *
 * ## 只有「已确认分类 + 可靠估值」才能支撑推断性分析
 *
 * 分类未确认的资产虽然计入金额，但**不能**用于：
 * - 策略配置偏离
 * - 资产市场暴露
 * 因为它们都依赖可靠的分类。
 */

import type { AnalysisRow, Coverage } from './types'

const round2 = (n: number) => Math.round(n * 100) / 100

export function buildCoverage(rows: AnalysisRow[]): Coverage {
  const unavailableHoldingIds: string[] = []
  const staleHoldingIds: string[] = []
  const unconfirmedHoldingIds: string[] = []
  const unconfirmedAndUnavailableIds: string[] = []

  let reliableValueCny = 0
  let reliableCount = 0
  let liabilityValueCny = 0
  let unavailableCount = 0
  let staleCount = 0

  for (const row of rows) {
    if (!row.classConfirmed) unconfirmedHoldingIds.push(row.holdingId)

    const reliable = row.status === 'ok' && row.valueCny !== undefined
    if (reliable) {
      reliableCount += 1
      if (row.isLiability) liabilityValueCny = round2(liabilityValueCny + (row.valueCny ?? 0))
      else reliableValueCny = round2(reliableValueCny + (row.valueCny ?? 0))
    } else if (row.status === 'stale') {
      staleCount += 1
      staleHoldingIds.push(row.holdingId)
      if (!row.classConfirmed) unconfirmedAndUnavailableIds.push(row.holdingId)
    } else {
      unavailableCount += 1
      unavailableHoldingIds.push(row.holdingId)
      if (!row.classConfirmed) unconfirmedAndUnavailableIds.push(row.holdingId)
    }
  }

  const totalHoldings = rows.length
  const coverageRatio = totalHoldings > 0 ? reliableCount / totalHoldings : 1

  /* ---- 哪些分析因缺口而不可用 ---- */
  const blockedAnalyses: string[] = []
  if (unconfirmedHoldingIds.length > 0) {
    blockedAnalyses.push(
      `有 ${unconfirmedHoldingIds.length} 项分类未确认，策略配置与市场暴露分析不完整`,
    )
  }
  if (unavailableCount > 0) {
    blockedAnalyses.push(`有 ${unavailableCount} 项无法估值，相关类别占比仅覆盖可靠部分`)
  }
  if (staleCount > 0) {
    blockedAnalyses.push(`有 ${staleCount} 项估值依据已过期，未计入金额`)
  }

  return {
    reliableValueCny,
    reliableCount,
    unavailableCount,
    unavailableHoldingIds,
    staleCount,
    staleHoldingIds,
    unconfirmedCount: unconfirmedHoldingIds.length,
    unconfirmedHoldingIds,
    unconfirmedAndUnavailableIds,
    liabilityValueCny,
    totalHoldings,
    coverageRatio,
    isComplete: unavailableCount === 0 && staleCount === 0,
    blockedAnalyses,
  }
}
