import { useCallback, useEffect, useState } from 'react'
import { Home, Layers, PieChart, Plus, TrendingUp, Settings as SettingsIcon } from 'lucide-react'
import { useMemo } from 'react'
import { usePortfolio2 } from '../hooks/usePortfolio2'
import { needsMigrationAttention, startupMigrationStatus } from '../lib/readOnly'
import { ensureDailySnapshot } from '../lib/performance/dailySnapshot'
import { createDexieRepository } from '../lib/db/dexieRepository'
import type { PortfolioRepository } from '../lib/db/repository'
import HomePage from './HomePage'
import AssetsPage from './AssetsPage'
import AnalysisTab from './AnalysisTab'
import HistoryTab from './HistoryTab'
import SettingsTab from './SettingsTab'
import TransactionSheet from '../components/TransactionSheet'

/**
 * W3 正式应用外壳
 *
 * ## 架构
 *
 * ```
 * Repository → Holdings → Valuation → Analysis → Snapshot/History
 *                          ↓
 *                   usePortfolio2（取数 + 派生一次）
 *                          ↓
 *               AppShell（Tab 路由）→ 各 Tab 组件
 * ```
 *
 * Tab 组件**只消费派生结果**，不自行计算金融事实；
 * 所有业务操作必须经 `Repository` / Domain API 后触发 `reload()` 重新派生。
 *
 * ## 五个 Tab
 *
 * | Tab | 数据来源 | 是否可写 |
 * | --- | --- | --- |
 * | 首页 | `totals` + `analysis` | 只读 |
 * | 资产 | `analysis` 六维度 | 可通过 Sheet 修改 Instrument metadata |
 * | 分析 | `analysis` | 只读 |
 * | 历史 | `trend`（Snapshot） | 只读 |
 * | 设置 | 本地 UI 偏好 + 数据说明 | 仅 UI 偏好 |
 */
export type AppTab = 'home' | 'assets' | 'analysis' | 'history' | 'settings'

export const TAB_LABEL: Record<AppTab, string> = {
  home: '首页',
  assets: '资产',
  analysis: '分析',
  history: '历史',
  settings: '设置',
}

const TAB_ICON: Record<AppTab, typeof Home> = {
  home: Home,
  assets: Layers,
  analysis: PieChart,
  history: TrendingUp,
  settings: SettingsIcon,
}

/** 记住上次所在 Tab（纯 UI 偏好，允许写 localStorage） */
const TAB_PREF_KEY = 'wealthcard/ui/active-tab'

function readTabPref(): AppTab {
  try {
    const raw = localStorage.getItem(TAB_PREF_KEY)
    if (raw && raw in TAB_LABEL) return raw as AppTab
  } catch {
    /* 忽略：偏好读取失败不影响使用 */
  }
  return 'home'
}

function writeTabPref(tab: AppTab): void {
  try {
    // 仅 UI 偏好，不属于业务事实
    localStorage.setItem(TAB_PREF_KEY, tab)
  } catch {
    /* 忽略 */
  }
}

export default function AppShell({
  initialTab,
  repo,
}: {
  initialTab?: AppTab
  repo?: PortfolioRepository
}) {
  const [tab, setTab] = useState<AppTab>(initialTab ?? readTabPref())
  const [txOpen, setTxOpen] = useState(false)
  // 仓储只建一次，并向所有子组件注入同一实例（避免读写不同实例）
  const activeRepo = useMemo(() => repo ?? createDexieRepository(), [repo])
  const { data, loading, error, daily, reload } = usePortfolio2(activeRepo)

  useEffect(() => {
    writeTabPref(tab)
  }, [tab])

  /**
   * 业务操作完成后重新派生 + **刷新当日快照**。
   *
   * ## 关键：写入后必须刷新派生结果
   *
   * 派生结果（AnalysisView / totals / trend）一律由 Repository 重新读取后重算，
   * 绝不在组件内直接改。
   *
   * ## 为什么还要刷新当日快照（Phase 8 / W8 修复）
   *
   * `ensureDailySnapshot` 原先只在 `usePortfolio2` 的**挂载 effect** 里调用一次。
   * 于是「首次打开应用（数据还是空的）→ 建立账户/持仓」这条最常见的路径会
   * 把**空的当日快照**冻结一整天：当天快照永久为 0，而首页仍显示
   * 「今日快照：已生成」。
   *
   * 现在每次业务写入后重新 `ensureDailySnapshot`：
   * - 目标日期是今天 → 允许刷新（同日 upsert，保留 id/createdAt）；
   * - **历史快照永不触碰**（守卫在 `ensureDailySnapshot` 与 `captureSnapshot` 内）。
   *
   * 这样「今天」的快照始终反映今天的最新事实，而历史保持不可变。
   */
  const handleChanged = useCallback(() => {
    void (async () => {
      try {
        await ensureDailySnapshot(activeRepo)
      } catch {
        // 快照失败不阻断业务刷新
      }
      await reload()
    })()
  }, [reload, activeRepo])

  /*
   * 启动迁移状态（W11 Blocker Patch，P1-6）。
   * `main.tsx` 在启动编排后写入；这里读取并在 UI 上明确展示。
   */
  const migrationStatus = startupMigrationStatus()
  const migrationNotice = needsMigrationAttention(migrationStatus) ? migrationStatus : null

  return (
    <div className="min-h-screen bg-app">
      {/* 顶部留白：内容区避开状态栏；底部给导航留出空间 */}
      <div className="safe-top pb-20">
        {/*
          旧版数据迁移未成功 / 未完成时必须**明确提示**（W11 Blocker Patch，P1-6）。
          否则 1.0 用户只看到空应用 + 冷启动引导，会误以为数据丢了，
          也可能把「空库」当成正常状态。
        */}
        {migrationNotice ? (
          <div
            className="mx-auto mt-3 max-w-[480px] rounded-2xl border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-[12px] leading-relaxed tone-warn"
            data-testid="migration-notice"
          >
            <p className="font-medium">旧版本数据没有完成迁移</p>
            <p className="mt-1 text-ink2">
              你的旧版本资产数据仍然完整保存在本机，没有被删除，也没有被改动。
              下面这个界面里暂时看不到它们。
            </p>
            <p className="mt-1 text-ink2">
              这里显示的是 2.0 的数据存储。请先不要把它当成空库使用 ——
              在迁移问题处理之前新建数据，会让旧数据更难恢复。
            </p>
            {migrationNotice.reason ? (
              <p className="mt-1 text-[11px] text-ink4">原因：{migrationNotice.reason}</p>
            ) : null}
            <p className="mt-1 text-[11px] text-ink4">
              可用 ?legacy=1 打开旧界面只读查看原有数据，或先导出一份 2.0 备份再处理。
            </p>
          </div>
        ) : null}

        {error ? (
          <div className="mx-auto max-w-[480px] px-4 pt-4 text-[12px] tone-warn">
            读取数据失败：{error}
          </div>
        ) : null}

        {!data ? (
          <p className="mx-auto max-w-[480px] px-4 pt-10 text-[12px] text-ink4">
            {loading ? '正在读取数据…' : '暂无数据'}
          </p>
        ) : tab === 'home' ? (
          <HomePage
            totals={data.totals}
            analysis={data.analysis}
            duplicates={data.duplicates}
            daily={daily}
            loadedAt={data.loadedAt}
            loading={loading}
            error={error}
            onReload={() => void reload()}
            coldStart={
              data.portfolio.accounts.length === 0 && data.portfolio.instruments.length === 0
            }
            onGoAssets={() => setTab('assets')}
          />
        ) : tab === 'assets' ? (
          <AssetsPage
            portfolio={data.portfolio}
            analysis={data.analysis}
            results={data.results}
            repo={activeRepo}
            onChanged={handleChanged}
          />
        ) : tab === 'analysis' ? (
          <AnalysisTab analysis={data.analysis} duplicates={data.duplicates} />
        ) : tab === 'history' ? (
          <HistoryTab
            trend={data.trend}
            portfolio={data.portfolio}
            repo={activeRepo}
            onChanged={handleChanged}
          />
        ) : (
          <SettingsTab
            portfolio={data.portfolio}
            analysis={data.analysis}
            repo={activeRepo}
            onChanged={handleChanged}
          />
        )}
      </div>

      {/* 全局「记一笔」入口 */}
      <button
        type="button"
        onClick={() => setTxOpen(true)}
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+62px)] left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[13px] text-s1 shadow-lg"
        data-testid="fab-record"
        aria-label="记一笔"
      >
        <Plus size={15} />
        记一笔
      </button>

      {txOpen && data ? (
        <TransactionSheet
          open
          onClose={() => setTxOpen(false)}
          portfolio={data.portfolio}
          repo={activeRepo}
          onChanged={handleChanged}
        />
      ) : null}

      {/* 底部导航 */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-s1"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        data-testid="bottom-nav"
      >
        <div className="mx-auto flex max-w-[480px]">
          {(Object.keys(TAB_LABEL) as AppTab[]).map((key) => {
            const Icon = TAB_ICON[key]
            const badge =
              key === 'assets' && data && !data.duplicates.ok
                ? '!'
                : key === 'assets' && data && data.analysis.coverage.unconfirmedCount > 0
                  ? '?'
                  : null
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${
                  tab === key ? 'text-ink' : 'text-ink4'
                }`}
                data-testid={`nav-${key}`}
                aria-current={tab === key ? 'page' : undefined}
              >
                <Icon size={16} />
                {TAB_LABEL[key]}
                {badge ? (
                  <span className="absolute right-1/4 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-warn/20 text-[9px] tone-warn">
                    {badge}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
