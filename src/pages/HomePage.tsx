import { AlertTriangle, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { AnalysisView } from '../lib/analysis'
import type { PortfolioTotals } from '../lib/valuation/types'
import type { DailySnapshotOutcome } from '../lib/performance/dailySnapshot'
import type { DuplicateReport } from '../lib/ledger/duplicates'
import { ASSET_CLASS_LABEL } from '../lib/analysis/dimensions'

/**
 * W2 首页（只读）
 *
 * ## 展示层职责
 *
 * 本组件**不做任何金融计算** —— 所有数字都来自 `totals` 与 `analysis`。
 * 组件只负责格式化与呈现。
 *
 * ## unavailable / stale / unconfirmed 的三态语义（不可混淆）
 *
 * | 状态 | 含义 | 是否计入可靠金额 |
 * | --- | --- | --- |
 * | `ok` | 当前可靠估值 | ✅ 计入 |
 * | `stale` | **有旧值，但不冒充当前可靠值** | ❌ 不计入，展示「最后已知」+ 明确标注 |
 * | `unavailable` | 无法可靠估值 | ❌ 不计入，**绝不显示成 0** |
 * | `unconfirmed` | 有估值，但分类未确认 | ✅ 计入（分类未知 ≠ 没有价值） |
 *
 * `unconfirmed ≠ unavailable`：前者是分类问题，后者是估值问题，可以同时成立。
 */
export interface HomePageProps {
  totals: PortfolioTotals
  analysis: AnalysisView
  duplicates: DuplicateReport
  daily: DailySnapshotOutcome | null
  loadedAt: number
  loading: boolean
  error: string | null
  onReload: () => void
  /** 冷启动：还没有任何数据时，指向「资产」页建立结构（Phase 8 / W7） */
  coldStart?: boolean
  onGoAssets?: () => void
}

const cny = (n: number) =>
  `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

export default function HomePage({
  totals,
  analysis,
  duplicates,
  daily,
  loadedAt,
  loading,
  error,
  onReload,
  coldStart,
  onGoAssets,
}: HomePageProps) {
  const cov = analysis.coverage
  const classBuckets = analysis.byAssetClass.filter((b) => b.key !== 'liability')

  return (
    <div className="mx-auto w-full max-w-[480px] px-4 pb-24">
      {/* 顶部：净资产 */}
      <section className="mt-4 rounded-2xl border border-line bg-s1 p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[12px] text-ink3">净资产 CNY</p>
            <p className="mt-1 text-[30px] font-semibold leading-none text-ink" data-testid="net-worth">
              {cny(totals.netWorth)}
            </p>
          </div>
          <button
            type="button"
            onClick={onReload}
            disabled={loading}
            className="rounded-lg border border-line p-1.5 text-ink3 disabled:opacity-50"
            aria-label="刷新"
            data-testid="reload"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="mt-3 flex gap-4 text-[12px]">
          <span className="text-ink2">
            总资产 <span className="text-ink" data-testid="total-assets">{cny(totals.totalAssets)}</span>
          </span>
          <span className="text-ink2">
            负债 <span className="text-ink" data-testid="total-liabilities">{cny(totals.totalLiabilities)}</span>
          </span>
        </div>

        <p className="mt-2 text-[11px] text-ink4" data-testid="loaded-at">
          数据更新于 {new Date(loadedAt).toLocaleTimeString('zh-CN')}
        </p>
      </section>

      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] tone-warn">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>读取数据失败：{error}</span>
        </div>
      ) : null}

      {/* 每日快照状态 */}
      {daily ? (
        <p className="mt-2 px-1 text-[11px] text-ink4" data-testid="daily-snapshot">
          {daily.action === 'captured'
            ? '今日快照：已生成'
            : daily.action === 'recaptured'
              ? '今日快照：已按最新数据刷新'
              : daily.action === 'already-captured'
                ? '今日快照：已存在'
                : `今日快照：未生成（${daily.error ?? '原因未知'}）`}
        </p>
      ) : null}

      {/* 冷启动引导（W7）：还没有数据时明确指向「资产」页建立结构 */}
      {coldStart ? (
        <button
          type="button"
          onClick={onGoAssets}
          className="mt-3 w-full rounded-2xl border border-line bg-s1 p-4 text-left"
          data-testid="home-cold-start"
        >
          <p className="text-[14px] font-medium text-ink">先建立你的资产结构</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink4">
            现在还没有任何数据。去「资产」页创建账户与标的，就可以开始记录交易了。
          </p>
          <p className="mt-2 text-[12px] text-ink2">前往资产页 →</p>
        </button>
      ) : null}

      {/* 只读提示 */}
      <div className="mt-3 flex items-start gap-2 rounded-2xl border border-line bg-s2 px-3.5 py-2.5 text-[12px] text-ink2">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-ink3" />
        <span>
          数据来自 IndexedDB（本机），与旧版 localStorage 无关。
          资产操作均在「资产」页进行，所有写入经 Repository 后重新派生。
        </span>
      </div>

      {/* 资产类别分布 */}
      <section className="mt-4 rounded-2xl border border-line bg-s1 p-4" data-testid="by-asset-class">
        <h2 className="text-[13px] font-medium text-ink2">资产类别分布</h2>

        {classBuckets.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink4">暂无可展示的资产</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {classBuckets.map((b) => (
              <li key={b.key} className="flex items-center gap-2 text-[12px]">
                <span className="w-24 shrink-0 text-ink2">
                  {ASSET_CLASS_LABEL[b.key as keyof typeof ASSET_CLASS_LABEL] ?? b.label}
                </span>
                <span className="w-28 shrink-0 text-right text-ink">{cny(b.valueCny)}</span>
                <span className="w-12 shrink-0 text-right text-ink3">
                  {b.share === undefined ? '—' : pct(b.share)}
                </span>
                {/* 缺口必须在同一行可见，不允许只显示百分比 */}
                <span className="shrink-0 text-[11px] text-ink4">
                  {b.unavailableCount > 0 ? `⚠${b.unavailableCount} 不可估值` : ''}
                  {b.staleCount > 0 ? ` ⏳${b.staleCount} 已过期` : ''}
                  {b.unconfirmedCount > 0 ? ` ?${b.unconfirmedCount} 待确认` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 数据完整度 */}
      <section className="mt-3 rounded-2xl border border-line bg-s1 p-4" data-testid="coverage">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-ink2">
          {cov.isComplete ? null : <AlertTriangle size={13} className="tone-warn" />}
          数据完整度
        </h2>

        <dl className="mt-3 space-y-1.5 text-[12px]">
          <div className="flex justify-between">
            <dt className="text-ink3">可靠资产金额</dt>
            <dd className="text-ink" data-testid="reliable-value">{cny(analysis.reliableValueCny)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">可靠持仓数</dt>
            <dd className="text-ink" data-testid="reliable-count">
              {cov.reliableCount} / {cov.totalHoldings}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">无法估值</dt>
            <dd className={cov.unavailableCount > 0 ? 'tone-warn' : 'text-ink'} data-testid="unavailable-count">
              {cov.unavailableCount} 项
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">估值已过期</dt>
            <dd className={cov.staleCount > 0 ? 'tone-warn' : 'text-ink'} data-testid="stale-count">
              {cov.staleCount} 项
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">分类待确认</dt>
            <dd className={cov.unconfirmedCount > 0 ? 'tone-warn' : 'text-ink'} data-testid="unconfirmed-count">
              {cov.unconfirmedCount} 项
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-[11px] leading-relaxed text-ink4">
          无法估值与已过期项**未计入**可靠资产金额，不会按 0 计算。
          分类待确认项**已计入**金额（分类未知不等于没有价值）。
        </p>

        {cov.blockedAnalyses.length > 0 ? (
          <ul className="mt-2 space-y-1 text-[11px] tone-warn">
            {cov.blockedAnalyses.map((t) => (
              <li key={t}>· {t}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* 重复持仓：只检测、只提示，绝不自动修复 */}
      {!duplicates.ok ? (
        <section
          className="mt-3 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] tone-warn"
          data-testid="duplicates"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlert size={13} className="shrink-0" />
            发现重复持仓
          </p>
          <p className="mt-1 text-[11px] leading-relaxed">{duplicates.summary}</p>
          <p className="mt-1 text-[11px] text-ink4">
            暂不自动修复：合并 / 删除需要单独的确认流程。
          </p>
        </section>
      ) : null}

      {/* 加载中占位（避免数字从 0 跳到真实值造成误解） */}
      {loading && !totals.totalHoldings ? (
        <p className="mt-3 px-1 text-[11px] text-ink4">正在读取数据…</p>
      ) : null}
    </div>
  )
}
