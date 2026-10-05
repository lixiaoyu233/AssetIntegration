/**
 * 分析层入口
 *
 * ## 严格的数据流（不得偏离）
 *
 * ```
 * Holding → ValuationResult → AnalysisView
 * ```
 *
 * `AnalysisView` 是**纯派生视图**：
 * - **只切分与展示**，不重新计算任何资产价值；
 * - **不反向修改 Portfolio**（本模块全部是纯函数，不接触存储）；
 * - 因此 `deriveAnalysis()` 前后的估值结果必须**完全一致**。
 *
 * 这条不变量由测试锁定：`totalAssets` / `totalLiabilities` / `netWorth` /
 * `reliableValueCny` / `unavailableCount` / `staleCount` 必须与估值引擎逐一相等。
 */

import type { Holding, Portfolio2 } from '../../types/portfolio2'
import type { PortfolioTotals } from '../valuation/types'
import type { ValuationResult } from '../valuation/types'
import { buildClassificationIndex, classifyInstrument, resolveRegion } from './classify'
import { buildCoverage } from './coverage'
import {
  byAccount,
  byAccountType,
  byAssetClass,
  byCurrency,
  byInstrumentType,
  byRegion,
} from './dimensions'
import { withShare } from './buckets'
import type { AnalysisRow, AnalysisView } from './types'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface DeriveAnalysisInput {
  portfolio: Portfolio2
  /** 估值结果（与 `totals` 必须来自同一次 `calculateTotals` 调用） */
  results: ValuationResult[]
  /** 估值汇总（用于对齐总额，**不重算**） */
  totals: PortfolioTotals
  /** 时间戳，用于 asOf */
  now?: number
}

/**
 * 由估值结果构建分析视图。
 *
 * 注意：本函数**不调用估值引擎**。调用方应传入同一次的 `results` 与 `totals`，
 * 保证分析与估值看到的完全是同一批数字。
 */
export function deriveAnalysis(input: DeriveAnalysisInput): AnalysisView {
  const { portfolio, results, totals } = input
  const { instrumentById, accountById } = buildClassificationIndex(portfolio)
  const holdingById = new Map(portfolio.holdings.map((h) => [h.id, h]))

  /* ---- 组装行：一行对应一个持仓，行数 === 持仓数 ---- */
  const rows: AnalysisRow[] = results.map((r) => {
    const holding = holdingById.get(r.holdingId)
    const instrument = instrumentById.get(holding?.instrumentId ?? '')
    const account = accountById.get(holding?.accountId ?? '')
    const cls = classifyInstrument(instrument)

    return {
      holdingId: r.holdingId,
      accountId: holding?.accountId ?? '',
      accountName: account?.name ?? '未知账户',
      instrumentId: holding?.instrumentId ?? '',
      instrumentName: instrument?.name ?? '未知标的',
      assetClass: cls.assetClass,
      instrumentType: instrument?.instrumentType ?? 'other',
      region: resolveRegion(account),
      accountType: account?.type ?? 'other',
      currency: r.currency,
      status: r.status,
      reasons: r.reasons,
      valueCny: r.status === 'ok' ? r.value : undefined,
      nativeValue: r.nativeValue,
      quantity: holding?.quantity ?? 0,
      classConfirmed: cls.confirmed,
      /*
       * 负债判定**只读估值结果**（W8 统一口径）。
       *
       * 原先这里自己拼 `r.assetClass === 'liability' || instrument?.assetClass === 'liability'`，
       * 完全不看账户的 `isLiability`，与引擎/快照可能得出不同结论。
       */
      isLiability: r.isLiability,
    }
  })

  /*
   * 资产与负债分离。
   *
   * `totalAssets` 不含负债，因此六个维度**只能对资产行切分**，
   * 否则有负债时「维度合计 ≠ reliableValueCny」。
   */
  const assetRows = rows.filter((r) => !r.isLiability)
  const liabilityRows = rows.filter((r) => r.isLiability)

  /* ---- 各维度：同一批资产行，多种切分 ---- */
  const reliableValueCny = round2(totals.totalAssets)
  const coverage = buildCoverage(rows)

  const classBuckets = withShare(byAssetClass(assetRows), reliableValueCny)
  const accountBuckets = withShare(byAccount(assetRows), reliableValueCny)
  const accountTypeBuckets = withShare(byAccountType(assetRows), reliableValueCny)
  const currencyBuckets = withShare(byCurrency(assetRows), reliableValueCny)
  const regionBuckets = withShare(byRegion(assetRows), reliableValueCny)
  const instrumentTypeBuckets = withShare(byInstrumentType(assetRows), reliableValueCny)

  return {
    asOf: new Date(input.now ?? Date.now()).toISOString(),
    // 直接采用估值引擎的数字，绝不重算
    totalAssets: totals.totalAssets,
    totalLiabilities: totals.totalLiabilities,
    netWorth: totals.netWorth,
    reliableValueCny,
    rows,
    assetRows,
    liabilityRows,
    byAssetClass: classBuckets,
    byAccount: accountBuckets,
    byAccountType: accountTypeBuckets,
    byCurrency: currencyBuckets,
    byRegion: regionBuckets,
    byInstrumentType: instrumentTypeBuckets,
    coverage,
  }
}

/* ------------------------------------------------------------------ *
 * 自检：各维度合计必须等于 reliableValueCny
 * ------------------------------------------------------------------ */

export interface DimensionCheck {
  dimension: string
  sum: number
  expected: number
  ok: boolean
}

/**
 * 校验「每个维度的合计 == reliableValueCny」。
 *
 * 这是分析层最重要的不变量：
 * 若某个维度的合计对不上，说明有持仓被漏掉或被重复计入。
 */
export function checkDimensions(view: AnalysisView): { ok: boolean; checks: DimensionCheck[] } {
  const expected = view.reliableValueCny
  const dims: Array<[string, AnalysisView['byAssetClass']]> = [
    ['byAssetClass', view.byAssetClass],
    ['byAccount', view.byAccount],
    ['byAccountType', view.byAccountType],
    ['byCurrency', view.byCurrency],
    ['byRegion', view.byRegion],
    ['byInstrumentType', view.byInstrumentType],
  ]
  const checks = dims.map(([dimension, buckets]) => {
    const sum = round2(buckets.reduce((s, b) => s + b.valueCny, 0))
    return { dimension, sum, expected, ok: Math.abs(sum - expected) < 0.01 }
  })
  return { ok: checks.every((c) => c.ok), checks }
}

/** 供 UI 下钻：某个分组的持仓行 */
export function rowsInBucket(view: AnalysisView, dimension: keyof AnalysisView, key: string): AnalysisRow[] {
  const pickers: Record<string, (r: AnalysisRow) => string> = {
    byAssetClass: (r) => r.assetClass,
    byAccount: (r) => r.accountId,
    byAccountType: (r) => r.accountType,
    byCurrency: (r) => r.currency,
    byRegion: (r) => r.region,
    byInstrumentType: (r) => r.instrumentType,
  }
  const pick = pickers[dimension as string]
  if (!pick) return []
  return view.rows.filter((r) => pick(r) === key)
}

/** 派生量：某个持仓在哪些维度里出现（用于验证「多维切片」语义） */
export function dimensionsOfHolding(view: AnalysisView, holdingId: string): Record<string, string> {
  const row = view.rows.find((r) => r.holdingId === holdingId)
  if (!row) return {}
  return {
    byAssetClass: row.assetClass,
    byAccount: row.accountId,
    byAccountType: row.accountType,
    byCurrency: row.currency,
    byRegion: row.region,
    byInstrumentType: row.instrumentType,
  }
}

export { buildCoverage } from './coverage'
export type { AnalysisView, AnalysisRow, GroupBucket, Coverage, DimensionKey, ClassifiedAssetClass } from './types'
export type { Holding }
