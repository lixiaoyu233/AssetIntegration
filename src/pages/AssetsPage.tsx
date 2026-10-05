import { useMemo, useState } from 'react'
import { AlertTriangle, BadgeCheck, Coins, LineChart } from 'lucide-react'
import type { Portfolio2 } from '../types/portfolio2'
import type { AnalysisView } from '../lib/analysis'
import type { ValuationResult } from '../lib/valuation/types'
import type { PortfolioRepository } from '../lib/db/repository'
import { detectDuplicateHoldings } from '../lib/ledger/duplicates'
import { findLiabilityConflicts } from '../lib/portfolio/liability'
import {
  quoteOf,
  reasonLabelsOf,
  valuationBasisOf,
  VALUATION_STATUS_LABEL,
} from '../lib/valuation/basis'
import ClassifySheet from '../components/ClassifySheet'
import CashConvertSheet from '../components/CashConvertSheet'
import DuplicateSheet from '../components/DuplicateSheet'
import QuoteSheet from '../components/QuoteSheet'
import AccountSheet from '../components/AccountSheet'
import InstrumentSheet from '../components/InstrumentSheet'
import ManualHoldingSheet from '../components/ManualHoldingSheet'
import ColdStartGuide from '../components/ColdStartGuide'
import { coldStartStateOf } from '../lib/db/creation'
import {
  ACCOUNT_TYPE_LABEL,
  ASSET_CLASS_LABEL,
  INSTRUMENT_TYPE_LABEL,
  REGION_LABEL,
} from '../lib/analysis/dimensions'

/**
 * W2 资产管理只读视图
 *
 * ## 数据来源
 *
 * 全部来自 `Repository → Holdings → Valuation → Analysis`。
 * **绝不**从 localStorage legacy 数据重新计算。
 *
 * ## 组件职责
 *
 * 只做：展示、切维度、排序、下钻。
 * **不做任何金融计算** —— 金额与可用性判断都取自传入的派生结果。
 */
export type AssetDimension =
  | 'holdings'
  | 'accounts'
  | 'currency'
  | 'assetClass'
  | 'region'
  | 'instrumentType'

export interface AssetsPageProps {
  portfolio: Portfolio2
  analysis: AnalysisView
  results: ValuationResult[]
  /** 业务操作必须经 Repository；**不允许**组件直接改派生数据 */
  repo: PortfolioRepository
  /** 业务操作完成后重新派生 */
  onChanged: () => void
  region?: string
  onRegionChange?: (next: string) => void
}

const cny = (n: number) =>
  `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const DIMENSION_LABEL: Record<AssetDimension, string> = {
  holdings: '持仓',
  accounts: '账户',
  currency: '币种',
  assetClass: '资产类别',
  region: '地区',
  instrumentType: '工具类型',
}

/** 估值状态徽章 —— stale 与 unavailable 必须与 ok 视觉可分 */
function StatusBadge({ result }: { result: ValuationResult | undefined }) {
  if (!result) return <span className="rounded bg-s2 px-1.5 py-0.5 text-[10px] text-ink4">无估值</span>
  if (result.status === 'ok') {
    return <span className="rounded bg-s2 px-1.5 py-0.5 text-[10px] text-ink2">可靠</span>
  }
  if (result.status === 'stale') {
    return (
      <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] tone-warn" title="有旧值但不代表当前可靠值">
        估值已过期
      </span>
    )
  }
  return (
    <span
      className="rounded bg-s2 px-1.5 py-0.5 text-[10px] text-ink4"
      title={result.reasons.join('、') || '无法可靠估值'}
    >
      无法估值
    </span>
  )
}

export default function AssetsPage({
  portfolio,
  analysis,
  results,
  repo,
  onChanged,
  region,
  onRegionChange,
}: AssetsPageProps) {
  const [dimension, setDimension] = useState<AssetDimension>('holdings')
  const [classifyOpen, setClassifyOpen] = useState(false)
  const [classifyFor, setClassifyFor] = useState<string[] | undefined>(undefined)
  const [cashOpen, setCashOpen] = useState(false)
  const [dupOpen, setDupOpen] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [quoteFor, setQuoteFor] = useState<string | undefined>(undefined)
  const [accountOpen, setAccountOpen] = useState(false)
  const [instrumentOpen, setInstrumentOpen] = useState(false)

  /**
   * 负债判定冲突（W9 / P1-3）。
   *
   * W8 已确定「两者都认」的保守口径：账户 `isLiability` 与标的
   * `assetClass` 冲突时按**负债**计（宁可少算净资产，也不虚高），
   * 并产出 `conflict` 标记。但该标记此前**没有任何 UI 消费** ——
   * 用户拿到正确的数字，却不知道自己有一处设置错了。
   *
   * ⚠️ 这里**只提示、不修改**：不自动替用户改分类，
   * 也不会改变 W8 已确定的计算口径。
   */
  const liabilityConflicts = useMemo(() => findLiabilityConflicts(portfolio), [portfolio])
  const [manualOpen, setManualOpen] = useState(false)

  const coldStart = useMemo(() => coldStartStateOf(portfolio), [portfolio])

  const duplicates = useMemo(() => detectDuplicateHoldings(portfolio), [portfolio])
  const unconfirmedCount = analysis.coverage.unconfirmedCount

  /** 该持仓是否需要补录行情（数量口径、非现金、且当前无行情） */
  const needsQuote = (row: { valuationMode?: string; instrumentId: string; instrumentType?: string }) => {
    if (row.instrumentType === 'cash') return false
    const h = portfolio.holdings.find((x) => x.instrumentId === row.instrumentId)
    if (!h || h.valuationMode !== 'quantity') return false
    return !quoteOf(portfolio, row.instrumentId)
  }

  /** 估值依据（价格类型 / 状态 / 来源 / 时间 / 汇率状态） */
  const basisOf = (
    pf: Portfolio2,
    result: ValuationResult,
    instrumentId: string,
  ) => valuationBasisOf(result, pf, instrumentId)

  /** 需要行情但当前没有行情的标的数（现金不需要行情） */
  const needsQuoteCount = useMemo(() => {
    let n = 0
    for (const h of portfolio.holdings) {
      if (h.valuationMode !== 'quantity') continue
      const inst = portfolio.instruments.find((i) => i.id === h.instrumentId)
      if (!inst || inst.instrumentType === 'cash') continue
      if (!quoteOf(portfolio, h.instrumentId)) n += 1
    }
    return n
  }, [portfolio])

  /** 可转换的现金：已确认现金 + 手动口径 */
  const cashCandidates = useMemo(() => {
    const byId = new Map(portfolio.instruments.map((i) => [i.id, i]))
    return portfolio.holdings.filter((h) => {
      if (h.valuationMode !== 'manual') return false
      const inst = byId.get(h.instrumentId)
      if (!inst) return false
      return (inst.instrumentType === 'cash' || inst.assetClass === 'cash') && inst.classificationStatus === 'confirmed'
    }).length
  }, [portfolio.holdings, portfolio.instruments])

  const resultByHolding = useMemo(
    () => new Map(results.map((r) => [r.holdingId, r])),
    [results],
  )
  const instrumentById = useMemo(
    () => new Map(portfolio.instruments.map((i) => [i.id, i])),
    [portfolio.instruments],
  )
  const accountById = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, a])),
    [portfolio.accounts],
  )

  /** 当前维度下的分组（只做分组，不做金额重算 —— 金额取自 AnalysisView） */
  const buckets = useMemo(() => {
    switch (dimension) {
      case 'assetClass':
        return analysis.byAssetClass
      case 'accounts':
        return analysis.byAccount
      case 'currency':
        return analysis.byCurrency
      case 'region':
        return analysis.byRegion
      case 'instrumentType':
        return analysis.byInstrumentType
      default:
        return []
    }
  }, [dimension, analysis])

  return (
    <div className="mx-auto w-full max-w-[480px] px-4 pb-24">
      {/* 冷启动引导（W7）：没有数据时明确告诉用户下一步做什么 */}
      <ColdStartGuide
        state={coldStart}
        onCreateAccount={() => setAccountOpen(true)}
        onCreateInstrument={() => setInstrumentOpen(true)}
        onCreateManualHolding={() => setManualOpen(true)}
      />

      {/* 业务操作入口 —— 全部走 Repository / Domain API */}
      <section className="mt-4 space-y-2" data-testid="asset-actions">
        <button
          type="button"
          onClick={() => {
            setClassifyFor(undefined)
            setClassifyOpen(true)
          }}
          className="flex w-full items-center gap-2 rounded-2xl border border-line bg-s1 px-3.5 py-2.5 text-left text-[12px] text-ink2"
          data-testid="action-classify"
        >
          <BadgeCheck size={14} className="shrink-0 text-ink3" />
          <span className="flex-1">
            确认资产分类
            {unconfirmedCount > 0 ? (
              <span className="ml-1.5 tone-warn">{unconfirmedCount} 项待确认</span>
            ) : (
              <span className="ml-1.5 text-ink4">全部已确认</span>
            )}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setCashOpen(true)}
          className="flex w-full items-center gap-2 rounded-2xl border border-line bg-s1 px-3.5 py-2.5 text-left text-[12px] text-ink2"
          data-testid="action-cash"
        >
          <Coins size={14} className="shrink-0 text-ink3" />
          <span className="flex-1">
            转为交易驱动现金
            <span className="ml-1.5 text-ink4">{cashCandidates} 项可转换</span>
          </span>
        </button>

        {/*
          负债判定冲突提示（W9 / P1-3）。
          只展示「需要核实」，并提供到账户/标的编辑的入口 —— 由用户自己决定改哪一处。
        */}
        {liabilityConflicts.length > 0 ? (
          <div
            className="rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] tone-warn"
            data-testid="liability-conflict"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} className="shrink-0" />
              <span className="flex-1 font-medium">
                有 {liabilityConflicts.length} 项负债判定需要核实
              </span>
            </div>
            <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed">
              {liabilityConflicts.slice(0, 3).map((c) => (
                <li key={c.holdingId} data-testid="liability-conflict-item">
                  · {c.detail}
                </li>
              ))}
              {liabilityConflicts.length > 3 ? (
                <li className="text-ink4">· 另有 {liabilityConflicts.length - 3} 项</li>
              ) : null}
            </ul>
            <p className="mt-1.5 text-[10px] text-ink4">
              当前按**负债**计入（更保守，净资产不会虚高）。请核实是账户还是标的设置需要修正 ——
              系统不会替你改动。
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setAccountOpen(true)}
                className="rounded-lg border border-warn/30 bg-s1 px-2.5 py-1 text-[11px] text-ink2"
                data-testid="liability-conflict-account"
              >
                检查账户
              </button>
              <button
                type="button"
                onClick={() => setInstrumentOpen(true)}
                className="rounded-lg border border-warn/30 bg-s1 px-2.5 py-1 text-[11px] text-ink2"
                data-testid="liability-conflict-instrument"
              >
                检查标的
              </button>
            </div>
          </div>
        ) : null}

        {!duplicates.ok ? (
          <button
            type="button"
            onClick={() => setDupOpen(true)}
            className="flex w-full items-center gap-2 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-left text-[12px] tone-warn"
            data-testid="action-duplicates"
          >
            <AlertTriangle size={14} className="shrink-0" />
            <span className="flex-1">
              发现 {duplicates.duplicates.length} 组重复持仓 · 查看详情
            </span>
          </button>
        ) : null}

        {/* W7：冷启动创建入口 */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAccountOpen(true)}
            className="flex-1 rounded-2xl border border-line bg-s1 px-3 py-2.5 text-left text-[12px] text-ink2"
            data-testid="action-create-account"
          >
            创建账户
          </button>
          <button
            type="button"
            onClick={() => setInstrumentOpen(true)}
            className="flex-1 rounded-2xl border border-line bg-s1 px-3 py-2.5 text-left text-[12px] text-ink2"
            data-testid="action-create-instrument"
          >
            创建标的
          </button>
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="flex-1 rounded-2xl border border-line bg-s1 px-3 py-2.5 text-left text-[12px] text-ink2"
            data-testid="action-create-manual"
          >
            手动持仓
          </button>
        </div>

        {/* W6：行情录入入口（补齐「行情只减不增」的能力断点） */}
        <button
          type="button"
          onClick={() => {
            setQuoteFor(undefined)
            setQuoteOpen(true)
          }}
          className="flex w-full items-center gap-2 rounded-2xl border border-line bg-s1 px-3.5 py-2.5 text-left text-[12px] text-ink2"
          data-testid="action-quote"
        >
          <LineChart size={14} className="shrink-0 text-ink3" />
          <span className="flex-1">
            录入 / 更新行情
            <span className="ml-1.5 text-ink4">
              {needsQuoteCount > 0 ? `${needsQuoteCount} 项待补行情` : '全部已有行情'}
            </span>
          </span>
        </button>
      </section>

      {/* 维度切换 */}
      <div className="mt-4 flex flex-wrap gap-1.5" data-testid="dimension-tabs">
        {(Object.keys(DIMENSION_LABEL) as AssetDimension[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDimension(d)}
            className={`rounded-full border px-3 py-1 text-[12px] ${
              dimension === d ? 'border-ink bg-ink text-s1' : 'border-line bg-s1 text-ink2'
            }`}
            data-testid={`dim-${d}`}
          >
            {DIMENSION_LABEL[d]}
          </button>
        ))}
      </div>

      {/* 分组视图 */}
      {dimension !== 'holdings' ? (
        <section className="mt-4 rounded-2xl border border-line bg-s1 p-4" data-testid="bucket-view">
          <h2 className="text-[13px] font-medium text-ink2">
            {DIMENSION_LABEL[dimension]} · 合计 {cny(analysis.reliableValueCny)}
          </h2>
          {buckets.length === 0 ? (
            <p className="mt-3 text-[12px] text-ink4">暂无数据</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {buckets.map((b) => (
                <li key={b.key} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-ink2">{b.label}</span>
                    <span className="text-ink">{cny(b.valueCny)}</span>
                    <span className="w-12 text-right text-ink3">
                      {b.share === undefined ? '—' : `${(b.share * 100).toFixed(1)}%`}
                    </span>
                  </div>
                  {/* 币种维度额外展示原币，避免不同币种被直接相加 */}
                  {b.nativeTotal !== undefined ? (
                    <p className="mt-0.5 text-[11px] text-ink4">
                      原币 {b.nativeTotal.toLocaleString('zh-CN')} {b.nativeCurrency}
                      {b.fxMissing ? ' · ⚠️ 缺汇率，未折算' : ''}
                    </p>
                  ) : null}
                  {!b.isComplete ? (
                    <p className="mt-0.5 text-[11px] tone-warn">
                      {b.unavailableCount > 0 ? `${b.unavailableCount} 项无法估值` : ''}
                      {b.staleCount > 0 ? ` ${b.staleCount} 项估值已过期` : ''}
                      （未计入金额）
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* 持仓明细 */}
      <section className="mt-4" data-testid="holdings-list">
        <h2 className="px-1 text-[13px] font-medium text-ink2">
          持仓（{analysis.assetRows.length + analysis.liabilityRows.length}）
        </h2>

        {analysis.rows.length === 0 ? (
          <p className="mt-3 px-1 text-[12px] text-ink4">还没有持仓数据</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {analysis.rows.map((row) => {
              const result = resultByHolding.get(row.holdingId)
              const inst = instrumentById.get(row.instrumentId)
              const account = accountById.get(row.accountId)
              return (
                <li
                  key={row.holdingId}
                  className="rounded-2xl border border-line bg-s1 p-3"
                  data-testid="holding-row"
                  data-holding-id={row.holdingId}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink">{inst?.name ?? row.instrumentName}</p>
                      <p className="mt-0.5 text-[11px] text-ink4">
                        {account?.name ?? row.accountName}
                        {' · '}
                        {REGION_LABEL[row.region] ?? row.region}
                        {' · '}
                        {ASSET_CLASS_LABEL[row.assetClass as keyof typeof ASSET_CLASS_LABEL] ?? row.assetClass}
                        {row.classConfirmed ? '' : '（待确认）'}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink4">
                        {INSTRUMENT_TYPE_LABEL[row.instrumentType]}
                        {' · '}
                        {row.currency}
                        {row.quantity ? ` · 数量 ${row.quantity}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* stale 与 unavailable 绝不显示成 0 */}
                      {row.status === 'ok' && row.valueCny !== undefined ? (
                        <p className="text-[13px] text-ink">{cny(row.valueCny)}</p>
                      ) : row.status === 'stale' ? (
                        <>
                          {/*
                            绝不用 `?? 0` 伪造金额：没有最后已知值时就如实说明，
                            而不是显示 ¥0.00（那与「真的不值钱」无法区分）。
                          */}
                          {result?.nativeValue !== undefined ? (
                            <p className="text-[12px] text-ink3">
                              最后已知 {cny(result.nativeValue)}
                            </p>
                          ) : (
                            <p className="text-[12px] text-ink4">依据已过期</p>
                          )}
                          <p className="text-[10px] tone-warn">未计入可靠总额</p>
                        </>
                      ) : (
                        <p className="text-[12px] text-ink4">无法估值</p>
                      )}
                      <div className="mt-1">
                        <StatusBadge result={result} />
                      </div>
                      {!row.classConfirmed ? (
                        <button
                          type="button"
                          onClick={() => {
                            setClassifyFor([row.instrumentId])
                            setClassifyOpen(true)
                          }}
                          className="mt-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink3"
                          data-testid="row-classify"
                        >
                          确认分类
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/*
                    估值依据（W6）：让每个金额都能回答「价格从哪来、几点的、可不可靠」。
                    展示价格类型 / 行情状态 / 来源 / 依据时间 / 汇率状态。
                  */}
                  {result ? (
                    <p className="mt-1.5 text-[10px] text-ink4" data-testid="holding-basis">
                      {VALUATION_STATUS_LABEL[result.status]}
                      {(() => {
                        const basis = basisOf(portfolio, result, row.instrumentId)
                        return basis.summary && basis.summary !== VALUATION_STATUS_LABEL[result.status]
                          ? ` · ${basis.summary}`
                          : ''
                      })()}
                    </p>
                  ) : null}

                  {/* 降级原因用中文标签，不再暴露 missing_fx 这类内部代码 */}
                  {row.status !== 'ok' && result?.reasons.length ? (
                    <p className="mt-1 text-[10px] text-ink4" data-testid="holding-reasons">
                      原因：{reasonLabelsOf(result.reasons).join('、')}
                    </p>
                  ) : null}

                  {/* 缺行情时给出直接入口（W6 的能力断点修复） */}
                  {needsQuote(row) ? (
                    <button
                      type="button"
                      onClick={() => {
                        setQuoteFor(row.instrumentId)
                        setQuoteOpen(true)
                      }}
                      className="mt-1.5 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink3"
                      data-testid="row-add-quote"
                    >
                      录入行情
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* 地区维度来源说明 */}
      <p className="mt-3 px-1 text-[11px] leading-relaxed text-ink4">
        地区维度使用 <span className="text-ink3">Account.region</span>（资产存放地），
        不根据证券名称或代码猜测所属市场。
      </p>
      <p className="mt-1 px-1 text-[11px] text-ink4">
        账户类型示例：{[...new Set(portfolio.accounts.map((a) => ACCOUNT_TYPE_LABEL[a.type]))].join(' / ') || '—'}
      </p>

      {onRegionChange && region !== undefined ? (
        <p className="mt-1 px-1 text-[11px] text-ink4">当前地区筛选：{region || '全部'}</p>
      ) : null}

      {classifyOpen ? (
        <ClassifySheet
          open
          onClose={() => setClassifyOpen(false)}
          portfolio={portfolio}
          analysis={analysis}
          repo={repo}
          onChanged={onChanged}
          instrumentIds={classifyFor}
        />
      ) : null}

      {cashOpen ? (
        <CashConvertSheet
          open
          onClose={() => setCashOpen(false)}
          portfolio={portfolio}
          repo={repo}
          onChanged={onChanged}
        />
      ) : null}

      {dupOpen ? <DuplicateSheet duplicates={duplicates} onClose={() => setDupOpen(false)} /> : null}

      {accountOpen ? (
        <AccountSheet open onClose={() => setAccountOpen(false)} repo={repo} onCreated={onChanged} />
      ) : null}

      {instrumentOpen ? (
        <InstrumentSheet open onClose={() => setInstrumentOpen(false)} repo={repo} onCreated={onChanged} />
      ) : null}

      {manualOpen ? (
        <ManualHoldingSheet
          open
          onClose={() => setManualOpen(false)}
          portfolio={portfolio}
          repo={repo}
          onCreated={onChanged}
        />
      ) : null}

      {quoteOpen ? (
        <QuoteSheet
          open
          onClose={() => setQuoteOpen(false)}
          portfolio={portfolio}
          repo={repo}
          onChanged={onChanged}
          initialInstrumentId={quoteFor}
        />
      ) : null}
    </div>
  )
}
