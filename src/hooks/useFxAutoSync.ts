/**
 * 汇率自动同步的编排（定时 + 手动刷新）
 *
 * ## 触发时机（已确认的选择）
 *
 * | 时机 | 行为 |
 * | --- | --- |
 * | 应用启动 | 检查「距上次同步是否超过 6 小时」，超过才拉（见 `shouldSyncFx`） |
 * | 页面重新可见 | 同上检查（切回来不会白拉一次） |
 * | 每 6 小时 | 页面可见时定时检查 |
 * | 用户点「立即刷新」 | `refresh()` 强制拉取，忽略时间判断 |
 *
 * ## 为什么定时器里要「检查」而不是「直接拉」
 *
 * 定时器会被浏览器节流、也可能被多次注册。用 `shouldSyncFx` 基于
 * `meta` 里的持久化时间判断，可以保证**跨刷新、跨标签页**都不会重复请求。
 *
 * ## 想改的时候
 *
 * - 改频率 → `fxAutoFetch.ts` 的 `FX_REFRESH_MS`
 * - 改触发时机 → 本文件下方的三个 `useEffect`
 *
 * ⚠️ 本 hook **只写 `fxRates` 与 `meta`**，不碰交易 / 持仓 / 快照。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PortfolioRepository } from '../lib/db/repository'
import type { FxSyncResult } from '../lib/valuation/fxAutoFetch'
import {
  FX_REFRESH_MS,
  markFxSynced,
  shouldSyncFx,
  syncFxRates,
} from '../lib/valuation/fxAutoFetch'

/** 定时检查的最小间隔：即使配置改小了，也不会低于这个值 */
const MIN_TICK_MS = 60 * 1000

export interface UseFxAutoSyncResult {
  /** 最近一次同步结果（未同步过为 null） */
  last: FxSyncResult | null
  /** 正在同步 */
  busy: boolean
  /** 立即强制刷新（忽略「刚同步过」的判断） */
  refresh: () => Promise<FxSyncResult | null>
  /** 距上次成功同步是否已超过刷新间隔 */
  stale: boolean
}

/**
 * @param repo  仓储；为 null 时不做任何事（启动早期 repo 可能还没准备好）
 * @param onSynced 同步完成后的回调，用于触发界面重载（有写入时才调用）
 */
export function useFxAutoSync(
  repo: PortfolioRepository | null,
  onSynced?: () => void,
): UseFxAutoSyncResult {
  const [last, setLast] = useState<FxSyncResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)

  /** 防止并发重复拉取（定时器 + 用户点击可能同时发生） */
  const running = useRef(false)
  /** 用 ref 持有回调，避免它变化导致定时器反复重建 */
  const onSyncedRef = useRef(onSynced)
  onSyncedRef.current = onSynced

  const run = useCallback(
    async (force: boolean): Promise<FxSyncResult | null> => {
      if (!repo) return null
      if (running.current) return null
      running.current = true
      setBusy(true)
      try {
        if (!force && !(await shouldSyncFx(repo))) {
          setStale(false)
          return null
        }
        const result = await syncFxRates(repo, { force })
        await markFxSynced(repo, result)
        setLast(result)
        setStale(result.source === 'none')
        /*
         * 只有真的写入了才通知界面重载。
         * 全部失败且没写入时不必刷新，避免无意义的整页重算。
         */
        if (result.written > 0) onSyncedRef.current?.()
        return result
      } catch {
        // syncFxRates 本身不抛错；这里只是最后一道保险
        setStale(true)
        return null
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [repo],
  )

  const refresh = useCallback(() => run(true), [run])

  /* ① 启动时检查一次（不强制：刚同步过就跳过） */
  useEffect(() => {
    if (!repo) return
    // 不 await：同步在后台进行，失败也由 run() 内部吞掉（绝不影响启动）
    void run(false)
  }, [repo, run])

  /* ② 页面重新可见时检查一次 */
  useEffect(() => {
    if (!repo) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run(false)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [repo, run])

  /* ③ 定时检查（页面可见时才真正发请求） */
  useEffect(() => {
    if (!repo) return
    const tick = Math.max(MIN_TICK_MS, FX_REFRESH_MS / 12)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void run(false)
    }, tick)
    return () => window.clearInterval(timer)
  }, [repo, run])

  return { last, busy, refresh, stale }
}
