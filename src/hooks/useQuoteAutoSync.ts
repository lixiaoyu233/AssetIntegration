/**
 * 行情自动同步的编排
 *
 * ## 触发时机（已确认：只在「打开」和「点更新」时，不做定时轮询）
 *
 * | 时机 | 行为 |
 * | --- | --- |
 * | 应用启动 | 拉一次全部可自动获取的标的 |
 * | 用户点「更新行情」 | `refresh()` 强制拉取（可指定只更新某个标的） |
 *
 * **刻意不做定时轮询**：行情不像汇率那样需要定时刷新，
 * 用户主动触发即可，也更省流量。若将来要加，参照 `useFxAutoSync` 的写法。
 *
 * ## 与汇率的关键差别
 *
 * 汇率是「固定 10 个币种」，一次拉全；行情是「每个标的各自一个价」，
 * 且只有 `fund` / `stock` / `etf` 三类能自动获取（见 `quoteAutoFetch.routeFor`）。
 *
 * ⚠️ 本 hook **只写 `quotes`**，不碰交易 / 持仓 / 快照 / 汇率。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PortfolioRepository } from '../lib/db/repository'
import type { QuoteSyncResult } from '../lib/valuation/quoteAutoFetch'
import { syncQuotes } from '../lib/valuation/quoteAutoFetch'

export interface UseQuoteAutoSyncResult {
  /** 最近一次同步结果（未同步过为 null） */
  last: QuoteSyncResult | null
  /** 正在同步 */
  busy: boolean
  /**
   * 立即拉取。
   * @param instrumentIds 只拉这些标的（不传则拉全部可自动获取的）
   */
  refresh: (instrumentIds?: string[]) => Promise<QuoteSyncResult | null>
}

/**
 * @param repo 仓储；为 null 时不做任何事
 * @param onSynced 有写入时的回调，用于触发界面重载
 */
export function useQuoteAutoSync(
  repo: PortfolioRepository | null,
  onSynced?: () => void,
): UseQuoteAutoSyncResult {
  const [last, setLast] = useState<QuoteSyncResult | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const onSyncedRef = useRef(onSynced)
  onSyncedRef.current = onSynced

  const refresh = useCallback(
    async (instrumentIds?: string[]): Promise<QuoteSyncResult | null> => {
      if (!repo) return null
      if (running.current) return null
      running.current = true
      setBusy(true)
      try {
        const result = await syncQuotes(repo, { instrumentIds })
        setLast(result)
        // 只有真的写入了才通知界面重载，避免无意义的重算
        if (result.written > 0) onSyncedRef.current?.()
        return result
      } catch {
        // syncQuotes 本身不抛错；这里只是最后一道保险
        return null
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [repo],
  )

  /* 启动时拉一次（不做定时轮询） */
  useEffect(() => {
    if (!repo) return
    // 不 await：后台进行，失败由 refresh 内部吞掉，绝不影响启动
    void refresh()
  }, [repo, refresh])

  return { last, busy, refresh }
}
