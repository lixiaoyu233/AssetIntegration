/**
 * W2 只读数据源 hook
 *
 * ## 职责边界（严格）
 *
 * ```
 * Repository → Holdings → Valuation → Analysis → Snapshot/History → **本 hook** → UI
 * ```
 *
 * 本 hook **只做「取数 + 派生一次」**：
 * - 从 Repository 读 `Portfolio2`
 * - 调用一次 `calculateTotals` 与 `deriveAnalysis`
 * - 把结果交给 UI
 *
 * **UI 组件不得重新计算金融事实**（不得自己加总、不得自己判可用性）。
 * 组件只负责展示、筛选、排序、下钻。
 *
 * ## 为什么不复用 W1 的 `usePortfolio`
 *
 * W1 的 `usePortfolio` 面向 1.0 的数据形态（`Portfolio`），属于过渡层。
 * W2 直接消费 2.0 的 `Portfolio2` + `AnalysisView`，避免多一层投影带来的口径漂移。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Portfolio2 } from '../types/portfolio2'
import { createEmptyPortfolio2 } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { calculateTotals, valuateHolding } from '../lib/valuation/engine'
import { createFxTable } from '../lib/valuation/fx'
import type { PortfolioTotals, ValuationResult } from '../lib/valuation/types'
import { type AnalysisView, deriveAnalysis } from '../lib/analysis'
import { detectDuplicateHoldings, type DuplicateReport } from '../lib/ledger/duplicates'
import { ensureDailySnapshot, type DailySnapshotOutcome } from '../lib/performance/dailySnapshot'
import { buildCompositionTrend, type TrendSeries } from '../lib/performance/history'

export interface Portfolio2Snapshot {
  portfolio: Portfolio2
  totals: PortfolioTotals
  results: ValuationResult[]
  analysis: AnalysisView
  duplicates: DuplicateReport
  trend: TrendSeries
  loadedAt: number
}

export interface UsePortfolio2State {
  data: Portfolio2Snapshot | null
  loading: boolean
  error: string | null
  /** 每日快照的结果（供 UI 提示，不影响主流程） */
  daily: DailySnapshotOutcome | null
  reload: () => Promise<void>
}

/**
 * 一次性把 2.0 数据派生到位。
 *
 * **纯函数**（除了读 Repository）：不写任何存储，便于测试与复用。
 */
/**
 * 趋势默认预计算窗口（天）。
 *
 * ## 为什么需要窗口（Phase 8 / W9，P1-1）
 *
 * `buildCompositionTrend` 会对**每一个**快照调用 `compositionAtCapture`，
 * 做 5 遍历 `positions`。而快照表每天 +1 且**无任何裁剪**，于是在冷启动时
 * 反复预计算「全部历史」（数年 = 数千份快照 × 每份数十条持仓）。
 *
 * 这里给它一个窗口，让**预计算**代价与使用年限脱钩。
 *
 * ⚠️ 这**不是**删除历史、也不是缩短可查询范围：
 * - 数据仍完整保存在 IndexedDB 中（`snapshots` 一条不少）；
 * - 历史页需要更早的点时，用 `repo.snapshots.range()` / `buildCompositionTrend`
 *   自行按范围读取（`since` / `until` 参数已支持）；
 * - 不降采样、不改历史语义。
 */
export const TREND_PRECOMPUTE_DAYS = 365

/** 由「今天」推 N 天前的日期（本地日） */
function daysAgoLocal(days: number, now: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function loadPortfolio2(
  repo: PortfolioRepository,
  options: { now?: number; trendDays?: number } = {},
): Promise<Portfolio2Snapshot> {
  const now = options.now ?? Date.now()
  const portfolio = await repo.loadPortfolio()
  const fx = createFxTable(portfolio.fxRates)

  const results = portfolio.holdings.map((h) => valuateHolding(h, portfolio, { fx, now }))
  const totals = calculateTotals({ portfolio, fx, now })
  const analysis = deriveAnalysis({ portfolio, results, totals, now })

  const trendDays = options.trendDays ?? TREND_PRECOMPUTE_DAYS
  return {
    portfolio,
    totals,
    results,
    analysis,
    duplicates: detectDuplicateHoldings(portfolio),
    // 只预计算最近 trendDays 天（数据仍在库里，不删除、不降采样）
    trend: buildCompositionTrend(portfolio.snapshots, {
      since: trendDays > 0 ? daysAgoLocal(trendDays, now) : undefined,
    }),
    loadedAt: now,
  }
}

export function usePortfolio2(repo: PortfolioRepository): UsePortfolio2State {
  /*
   * 仓储由调用方注入，**不在内部静默新建**。
   *
   * 原因：如果 hook 自己建一个实例，而上层组件用另一个实例写数据，
   * 就会出现「写入 A 实例、读取 B 实例」的不一致（W1 已踩过同类坑：
   * migrateOnStart 曾在 repo 与 db 不同库时误判「已迁移」）。
   */
  const activeRepo = repo

  const [data, setData] = useState<Portfolio2Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [daily, setDaily] = useState<DailySnapshotOutcome | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await loadPortfolio2(activeRepo)
      setData(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取数据失败')
    } finally {
      setLoading(false)
    }
  }, [activeRepo])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      /*
       * 每日快照先跑：它可能与读取并发，但**失败不影响读取**。
       * 刻意放在读取之前，这样首次加载就能看到今日快照。
       */
      let outcome: DailySnapshotOutcome | null = null
      try {
        outcome = await ensureDailySnapshot(activeRepo)
      } catch {
        // ensureDailySnapshot 本身不抛出；这里只是最后保险
        outcome = null
      }
      if (cancelled) return
      setDaily(outcome)

      setLoading(true)
      try {
        const next = await loadPortfolio2(activeRepo)
        if (cancelled) return
        setData(next)
        setError(null)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '读取数据失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeRepo])

  return useMemo(
    () => ({ data, loading, error, daily, reload }),
    [data, loading, error, daily, reload],
  )
}

/** 空组合常量，供 UI 在无数据时安全渲染 */
export const EMPTY_PORTFOLIO2 = createEmptyPortfolio2()
