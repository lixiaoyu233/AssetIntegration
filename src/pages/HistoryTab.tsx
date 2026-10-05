import { useCallback, useMemo, useState } from 'react'
import type { Portfolio2, Snapshot, Transaction, TransactionType } from '../types/portfolio2'
import { positionBasisView, UNTRACEABLE } from '../lib/performance/basisView'
import type { TrendSeries } from '../lib/performance/history'
import { buildCompositionTrend } from '../lib/performance/history'
import { ASSET_CLASS_LABEL } from '../lib/analysis/dimensions'
import {
  queryTransactions,
  transactionCounts,
  type TransactionQuery,
} from '../lib/ledger/transactionService'
import { isVoided } from '../lib/ledger/lifecycle'
import type { PortfolioRepository } from '../lib/db/repository'
import { deriveLedger } from '../lib/ledger/derive'
import FlowsView from '../components/FlowsView'
import TransactionDetailSheet from '../components/TransactionDetailSheet'
import ManualHoldingSheet from '../components/ManualHoldingSheet'

/**
 * 历史 Tab（Phase 8 / W4 扩展）
 *
 * ## 二级视图
 *
 * | 视图 | 数据来源 |
 * | --- | --- |
 * | **交易流水** | `Transaction`（事实源）+ Ledger Effects 详情 |
 * | **资产快照** | `Snapshot`（Phase 4/7），含 captureKind 与历史分类缺口 |
 *
 * 按用户要求**不新增第六个底部 Tab**，流水放在这里作为二级视图。
 *
 * ## 保持的语义
 *
 * - `captureKind` 缺失 → UNKNOWN，绝不当 REAL
 * - 历史 `assetClassAtCapture` 缺失 → 显示「历史分类数据不可用」，不用当前分类回填
 * - 不插值、不补缺失日期
 */
export interface HistoryTabProps {
  trend: TrendSeries
  portfolio: Portfolio2
  /** 作废交易需要经 Repository 写入 */
  repo: PortfolioRepository
  /** 写入后重新派生 */
  onChanged: () => void
}

const cny = (n: number) =>
  `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function HistoryTab({ trend, portfolio, repo, onChanged }: HistoryTabProps) {
  const [view, setView] = useState<'flows' | 'snapshots'>('flows')
  const [showAll, setShowAll] = useState(false)
  const [accountFilter, setAccountFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active'>('all')
  const [selected, setSelected] = useState<Transaction | null>(null)

  /*
   * 展开的「估值依据」快照日期（W9/P1-5）。
   *
   * 为什么按需读取而不是从 portfolio 拿：
   * `portfolio` 刻意**不携带完整 snapshots**（W9/P1-1 的读路径纪律），
   * 因此这里在用户展开时用 `repo.snapshots.byDate()` 只读那一份。
   */
  /*
   * 扩展趋势范围（W9/P1-1）。
   *
   * 冷启动只**预计算**最近 365 天（数据仍全在 IndexedDB）。
   * 用户需要看更早的历史时，按需从这里把完整历史读出来 ——
   * 因此**可查询范围没有缩短**，只是把代价从「每次开 App」推迟到「用户主动要看」。
   */
  const [extendedTrend, setExtendedTrend] = useState<TrendSeries | null>(null)
  const [extending, setExtending] = useState(false)

  const loadEarlierHistory = useCallback(async () => {
    setExtending(true)
    try {
      const all = await repo.snapshots.getAll()
      setExtendedTrend(buildCompositionTrend(all))
    } finally {
      setExtending(false)
    }
  }, [repo])

  const shownTrend = extendedTrend ?? trend

  /**
   * 「作废后补录」表单的状态（Phase 8 / W10-Patch，P0-3）。
   *
   * 作废让某项持仓失去全部账本依据时，`voidTransaction` 会清理该持仓缓存。
   * 这里提供一条**可操作**的补救路径：带着原账户/标的打开手动持仓登记，
   * 用户无需自己回忆，也**不需要编辑 JSON**。
   */
  const [recoverPreset, setRecoverPreset] = useState<
    { accountId: string; instrumentId: string } | null
  >(null)

  const [basisDate, setBasisDate] = useState<string | null>(null)
  const [basisSnapshot, setBasisSnapshot] = useState<Snapshot | null>(null)
  const [basisLoading, setBasisLoading] = useState(false)

  const toggleBasis = useCallback(
    async (date: string) => {
      if (basisDate === date) {
        setBasisDate(null)
        setBasisSnapshot(null)
        return
      }
      setBasisDate(date)
      setBasisSnapshot(null)
      setBasisLoading(true)
      try {
        const snap = await repo.snapshots.byDate(date)
        // 只有仍然展开的是这一份时才写入（避免竞态覆盖）
        setBasisSnapshot(snap ?? null)
      } finally {
        setBasisLoading(false)
      }
    },
    [basisDate, repo],
  )

  const accountById = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, a])),
    [portfolio.accounts],
  )
  const instrumentById = useMemo(
    () => new Map(portfolio.instruments.map((i) => [i.id, i])),
    [portfolio.instruments],
  )

  /** 筛选后的交易（只筛选，不重算金额） */
  const flows = useMemo(() => {
    const query: TransactionQuery = {}
    if (accountFilter) query.accountId = accountFilter
    if (typeFilter) query.type = typeFilter as TransactionType
    const list = queryTransactions(portfolio.transactions, query)
    // 状态筛选：默认「含已作废」（作废是审计事实，用户需要看到全貌）
    return statusFilter === 'active' ? list.filter((t) => !isVoided(t)) : list
  }, [portfolio.transactions, accountFilter, typeFilter, statusFilter])

  const counts = useMemo(() => transactionCounts(portfolio.transactions), [portfolio.transactions])

  /** 每笔交易的 Ledger Effects（真实派生关系，供详情展示） */
  const entriesByTx = useMemo(() => {
    const ledger = deriveLedger(portfolio.transactions, {
      /*
       * 复用上面已建好的 Map（W9/P2-2）。
       * 原先每次调用都 `.find()` 扫一遍标的表 → O(T×I)。
       */
      instrumentCurrency: (id) => instrumentById.get(id)?.currency,
    })
    const m = new Map<string, typeof ledger.entries>()
    for (const e of ledger.entries) {
      const list = m.get(e.transactionId) ?? []
      list.push(e)
      m.set(e.transactionId, list)
    }
    return m
  }, [portfolio.transactions, instrumentById])

  const points = showAll ? shownTrend.points : [...shownTrend.points].reverse().slice(0, 12)

  return (
    <div className="mx-auto w-full max-w-[480px] px-4">
      <header className="pt-4">
        <h1 className="text-[15px] font-medium text-ink">资产历史</h1>
        <p className="mt-1 text-[11px] text-ink4" data-testid="tx-counts">
          {counts.posted} 笔有效
          {counts.voided > 0 ? ` · ${counts.voided} 笔已作废` : ''} · {shownTrend.points.length} 个快照
        </p>
      </header>

      {/* 二级视图切换 */}
      <div className="mt-3 flex gap-1.5" data-testid="history-view-tabs">
        <button
          type="button"
          onClick={() => setView('flows')}
          className={`rounded-full border px-3 py-1 text-[12px] ${
            view === 'flows' ? 'border-ink bg-ink text-s1' : 'border-line bg-s1 text-ink2'
          }`}
          data-testid="view-flows"
        >
          交易流水
        </button>
        <button
          type="button"
          onClick={() => setView('snapshots')}
          className={`rounded-full border px-3 py-1 text-[12px] ${
            view === 'snapshots' ? 'border-ink bg-ink text-s1' : 'border-line bg-s1 text-ink2'
          }`}
          data-testid="view-snapshots"
        >
          资产快照
        </button>
      </div>

      {view === 'flows' ? (
        <FlowsView
          flows={flows}
          accounts={portfolio.accounts}
          accountById={accountById}
          instrumentById={instrumentById}
          accountFilter={accountFilter}
          typeFilter={typeFilter}
          statusFilter={statusFilter}
          onAccountFilter={setAccountFilter}
          onTypeFilter={setTypeFilter}
          onStatusFilter={setStatusFilter}
          onSelect={setSelected}
        />
      ) : (
        <>
          <p className="mt-3 text-[11px] text-ink4" data-testid="history-summary">
            {trend.summary}
          </p>

          {trend.points.length === 0 ? (
            <div
              className="mt-3 rounded-2xl border border-line bg-s1 p-4 text-[12px] text-ink3"
              data-testid="history-empty"
            >
              <p className="font-medium text-ink2">还没有历史快照</p>
              <p className="mt-1.5 leading-relaxed text-ink4">
                配置趋势需要积累数据，从今天起每天会自动记录一次。
                <br />
                缺失的日期不会补数据，也不会用当前分类推测过去。
              </p>
            </div>
          ) : (
            <>
              {trend.gaps.length > 0 ? (
                <section
                  className="mt-3 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] tone-warn"
                  data-testid="history-gaps"
                >
                  <p className="font-medium">部分历史快照缺少分类信息</p>
                  <p className="mt-1 text-[11px] leading-relaxed">
                    {trend.gaps.length} 个时点没有记录当时的资产分类，这些时点不展示类别占比
                    （不使用今天的分类回填历史）。
                  </p>
                  <ul className="mt-1 space-y-0.5 text-[11px] text-ink4">
                    {trend.gaps.slice(0, 5).map((g) => (
                      <li key={g.date}>
                        · {g.date}：{g.reason}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <ul className="mt-3 space-y-2" data-testid="history-list">
                {points.map((pt) => (
                  <li
                    key={pt.date}
                    className="rounded-2xl border border-line bg-s1 p-3"
                    data-testid="history-point"
                    data-date={pt.date}
                    data-capture-kind={pt.captureKind}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-ink">{pt.date}</p>
                        <p className="mt-0.5 text-[11px]" data-testid="capture-kind">
                          <span
                            className={
                              pt.captureKind === 'REAL'
                                ? 'text-ink4'
                                : pt.captureKind === 'UNKNOWN'
                                  ? 'tone-warn'
                                  : 'text-ink3'
                            }
                          >
                            {pt.captureKindLabel}
                          </span>
                          {!pt.isComplete ? (
                            <span className="ml-1.5 tone-warn">· 数据不完整</span>
                          ) : null}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[13px] text-ink" data-testid="history-networth">
                          {cny(pt.netWorth)}
                        </p>
                        <p className="text-[10px] text-ink4">净资产</p>
                        {pt.totalLiabilities !== undefined && pt.totalLiabilities > 0 ? (
                          <p className="mt-0.5 text-[10px] text-ink4" data-testid="history-liability">
                            资产 {cny(pt.grossAssets ?? 0)} · 负债 {cny(pt.totalLiabilities)}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    {pt.hasClassification && pt.byClass ? (
                      <ul className="mt-2 space-y-0.5 border-t border-line pt-2 text-[11px]">
                        {/*
                          资产类别构成（W8）。
                          负债单独成行、不参与资产占比分母 —— 占比分母是 grossAssets。
                        */}
                        {Object.entries(pt.byClass)
                          .sort((a, b) => b[1] - a[1])
                          .map(([cls, v]) => (
                            <li key={cls} className="flex justify-between">
                              <span className={cls === 'liability' ? 'tone-warn' : 'text-ink3'}>
                                {ASSET_CLASS_LABEL[cls as keyof typeof ASSET_CLASS_LABEL] ?? cls}
                              </span>
                              <span className="text-ink2">
                                {cny(v)}
                                <span className="ml-1.5 text-ink4">
                                  {cls === 'liability'
                                    ? '（不计入资产占比）'
                                    : pt.byClassShare?.[cls] !== undefined
                                      ? `${((pt.byClassShare[cls] ?? 0) * 100).toFixed(0)}%`
                                      : ''}
                                </span>
                              </span>
                            </li>
                          ))}
                      </ul>
                    ) : (
                      <p
                        className="mt-2 border-t border-line pt-2 text-[11px] text-ink4"
                        data-testid="class-unavailable"
                      >
                        历史分类数据不可用（当时未记录分类）
                      </p>
                    )}

                    {/* ---- 估值依据（W9 / P1-5）---- */}
                    <button
                      type="button"
                      onClick={() => void toggleBasis(pt.date)}
                      data-testid="toggle-basis"
                      data-date={pt.date}
                      className="mt-2 w-full border-t border-line pt-2 text-left text-[11px] text-ink3"
                    >
                      {basisDate === pt.date ? '收起估值依据' : '查看估值依据'}
                      <span className="ml-1 text-ink4">
                        （这一段为什么是这个价值）
                      </span>
                    </button>

                    {basisDate === pt.date ? (
                      <div
                        className="mt-2 space-y-2 rounded-xl border border-line bg-s2 p-2"
                        data-testid="basis-panel"
                      >
                        {basisLoading ? (
                          <p className="text-[11px] text-ink4">读取中…</p>
                        ) : !basisSnapshot || basisSnapshot.positions.length === 0 ? (
                          <p
                            className="text-[11px] text-ink4"
                            data-testid="basis-empty"
                          >
                            这份快照没有持仓明细（例如迁移来的月度点），因此**没有可追溯的估值依据**。
                          </p>
                        ) : (
                          <>
                            <p className="text-[10px] text-ink4">
                              以下为**捕获当时**实际落盘的依据。显示「{UNTRACEABLE}」表示
                              该字段在当年**没有记录**（V8 之前的快照不含这些字段），
                              系统不会用今天的行情或分类去补它。
                            </p>
                            <ul className="space-y-2">
                              {basisSnapshot.positions.map((pos, i) => {
                                const v = positionBasisView(pos)
                                return (
                                  <li
                                    key={`${pos.accountId}::${pos.instrumentId}::${i}`}
                                    className="rounded-lg border border-line bg-s1 p-2"
                                    data-testid="basis-position"
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                                        {instrumentById.get(pos.instrumentId)?.name ?? pos.instrumentId}
                                      </span>
                                      <span className="shrink-0 text-[10px] text-ink4">
                                        {v.reliable
                                          ? '可靠估值'
                                          : pos.quoteStatus === 'STALE'
                                            ? '估值已过期'
                                            : '无法估值'}
                                      </span>
                                    </div>
                                    <dl className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
                                      {v.fields.map((f) => (
                                        <div key={f.label} className="flex justify-between gap-1">
                                          <dt className="text-ink4">{f.label}</dt>
                                          <dd
                                            className={
                                              f.missing
                                                ? 'text-ink4'
                                                : f.tone === 'warn'
                                                  ? 'tone-warn'
                                                  : 'text-ink2'
                                            }
                                            data-missing={f.missing ? '1' : '0'}
                                          >
                                            {f.value}
                                          </dd>
                                        </div>
                                      ))}
                                      <div className="flex justify-between gap-1">
                                        <dt className="text-ink4">当时是否负债</dt>
                                        <dd
                                          className={v.liability === 'untraceable' ? 'text-ink4' : 'text-ink2'}
                                          data-missing={v.liability === 'untraceable' ? '1' : '0'}
                                        >
                                          {v.liability === 'untraceable'
                                            ? UNTRACEABLE
                                            : v.liability
                                              ? '负债'
                                              : '资产'}
                                        </dd>
                                      </div>
                                      <div className="flex justify-between gap-1">
                                        <dt className="text-ink4">当时资产类别</dt>
                                        <dd
                                          className={
                                            v.assetClassAtCapture === 'untraceable' ? 'text-ink4' : 'text-ink2'
                                          }
                                          data-missing={v.assetClassAtCapture === 'untraceable' ? '1' : '0'}
                                        >
                                          {v.assetClassAtCapture === 'untraceable'
                                            ? UNTRACEABLE
                                            : (ASSET_CLASS_LABEL[v.assetClassAtCapture] ??
                                              v.assetClassAtCapture)}
                                        </dd>
                                      </div>
                                    </dl>
                                  </li>
                                )
                              })}
                            </ul>
                          </>
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>

              {shownTrend.points.length > 12 ? (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="mt-3 w-full rounded-xl border border-line bg-s1 py-2 text-[12px] text-ink2"
                >
                  {showAll ? '收起' : `显示全部 ${shownTrend.points.length} 个时点`}
                </button>
              ) : null}

              {/*
                冷启动只预计算最近 365 天；更早的历史按需加载。
                数据从未被删除 —— 这只是把读取代价推迟到用户真的要看的时候。
              */}
              {!extendedTrend ? (
                <button
                  type="button"
                  onClick={() => void loadEarlierHistory()}
                  disabled={extending}
                  data-testid="load-earlier-history"
                  className="mt-2 w-full rounded-xl border border-line bg-s1 py-2 text-[12px] text-ink3 disabled:opacity-50"
                >
                  {extending ? '读取中…' : '加载更早的历史（全部时点）'}
                </button>
              ) : (
                <p
                  className="mt-2 text-center text-[11px] text-ink4"
                  data-testid="history-extended"
                >
                  已加载全部 {shownTrend.points.length} 个时点
                </p>
              )}
            </>
          )}

          <p className="mt-3 px-1 pb-4 text-[11px] leading-relaxed text-ink4">
            只展示真实存在的快照，缺失日期不插值。
            来源未标记的历史快照不会被当作 REAL。
          </p>
        </>
      )}

      {selected ? (
        <TransactionDetailSheet
          transaction={selected}
          portfolio={portfolio}
          repo={repo}
          accountById={accountById}
          instrumentById={instrumentById}
          effects={entriesByTx.get(selected.id) ?? []}
          onVoided={() => {
            /*
             * ⚠️ 刻意**不关闭**详情面板（W10-Patch，P0-3）。
             *
             * 作废可能清理掉失去全部账本依据的持仓；若立刻关闭面板，
             * 那条「已清理哪些持仓 + 补录为手动持仓」的补救入口
             * 会一闪而过、用户根本看不到 —— 补救路径等于不存在。
             * 详情内部已用本地 state 反映「已作废」，因此保持打开是安全的。
             */
            onChanged()
          }}
          onRecoverManual={(preset) => {
            // 关掉详情，打开手动持仓表单并预填原账户/标的（P0-3 的补救入口）
            setSelected(null)
            setRecoverPreset(preset)
          }}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {/*
        作废后补救入口（P0-3）：`key` 保证每次换预设都重新挂载，
        否则 useState 的初始值不会随 preset 变化。
      */}
      {recoverPreset ? (
        <ManualHoldingSheet
          key={`${recoverPreset.accountId}::${recoverPreset.instrumentId}`}
          open
          portfolio={portfolio}
          repo={repo}
          preset={recoverPreset}
          onClose={() => setRecoverPreset(null)}
          onCreated={() => {
            setRecoverPreset(null)
            onChanged()
          }}
        />
      ) : null}
    </div>
  )
}
