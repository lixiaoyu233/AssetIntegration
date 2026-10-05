import { useMemo, useState } from 'react'
import type { AssetClass, Instrument, Portfolio2 } from '../types/portfolio2'
import type { AnalysisView } from '../lib/analysis'
import type { PortfolioRepository } from '../lib/db/repository'
import { ASSET_CLASS_LABEL } from '../lib/analysis/dimensions'
import { classifyInstrument } from '../lib/analysis/classify'
import Sheet from './Sheet'

/**
 * 分类确认 Sheet（Phase 8 / W3）
 *
 * ## 严格遵守 Phase 7 的确认机制
 *
 * | 允许 | 禁止 |
 * | --- | --- |
 * | 调 `repo.instruments.confirmOne(id, assetClass)` | 直接写 `Instrument.assetClass` |
 * | 调 `repo.instruments.unconfirm(id)` | 修改 `Holding` / `Transaction` / `Snapshot` |
 * | 显示迁移时留下的「线索」 | 用线索**预选**（必须用户主动选择） |
 *
 * **绝不自动分类**：不根据名称、代码、关键词推断类别。
 *
 * ## 确认后会发生什么（已由 Phase 7 测试锁定）
 *
 * ```
 * totalAssets / totalLiabilities / netWorth / reliableValueCny
 * unavailableCount / staleCount   —— 全部不变
 * byAssetClass / unconfirmedCount —— 允许变化
 * ```
 *
 * UI 必须把这个语义告诉用户，避免误以为「确认分类会改动金额」。
 */
export interface ClassifySheetProps {
  open: boolean
  onClose: () => void
  portfolio: Portfolio2
  analysis: AnalysisView
  repo: PortfolioRepository
  /** 变化后重新派生 */
  onChanged: () => void
  /** 只处理指定标的（从持仓行进入时使用） */
  instrumentIds?: string[]
}

/** 可供用户选择的资产类别（排除 liability：负债靠账户 isLiability 表达） */
const SELECTABLE: AssetClass[] = [
  'cash',
  'equity',
  'fixed_income',
  'gold',
  'real_estate',
  'crypto',
  'receivable',
  'other',
]

export default function ClassifySheet({
  open,
  onClose,
  portfolio,
  analysis,
  repo,
  onChanged,
  instrumentIds,
}: ClassifySheetProps) {
  const [pending, setPending] = useState<Record<string, AssetClass | undefined>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const holdingsByInstrument = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of portfolio.holdings) m.set(h.instrumentId, (m.get(h.instrumentId) ?? 0) + 1)
    return m
  }, [portfolio.holdings])

  /** 待确认清单：未确认的标的（可按 instrumentIds 过滤） */
  const rows = useMemo(() => {
    const list = portfolio.instruments.filter((i) => {
      if (instrumentIds && !instrumentIds.includes(i.id)) return false
      return classifyInstrument(i).confirmed === false
    })
    // 有关联持仓的、金额大的排前面，便于优先处理
    return list.sort((a, b) => (holdingsByInstrument.get(b.id) ?? 0) - (holdingsByInstrument.get(a.id) ?? 0))
  }, [portfolio.instruments, instrumentIds, holdingsByInstrument])

  const reliableByInstrument = useMemo(() => {
    const m = new Map<string, number>()
    for (const row of analysis.rows) {
      if (row.status === 'ok' && row.valueCny !== undefined) {
        m.set(row.instrumentId, (m.get(row.instrumentId) ?? 0) + row.valueCny)
      }
    }
    return m
  }, [analysis.rows])

  /** 已确认的标的（用于展示「撤销」入口） */
  const confirmedRows = useMemo(
    () => portfolio.instruments.filter((i) => classifyInstrument(i).confirmed),
    [portfolio.instruments],
  )

  const confirm = async (inst: Instrument) => {
    const picked = pending[inst.id]
    if (!picked) {
      setError(`请先为「${inst.name}」选择资产类别`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      // 唯一允许的分类写入路径：Phase 7 的 confirmation API（会写审计条目）
      await repo.instruments.confirmOne(inst.id, picked)
      setDone(`「${inst.name}」已确认为${ASSET_CLASS_LABEL[picked]}`)
      setPending((p) => ({ ...p, [inst.id]: undefined }))
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '确认失败')
    } finally {
      setBusy(false)
    }
  }

  const confirmAllPicked = async () => {
    const entries = rows
      .filter((i) => pending[i.id])
      .map((i) => ({ id: i.id, assetClass: pending[i.id] as AssetClass }))
    if (entries.length === 0) {
      setError('还没有选择任何类别')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await repo.instruments.confirmMany(entries)
      setDone(`已确认 ${entries.length} 项`)
      setPending({})
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '批量确认失败')
    } finally {
      setBusy(false)
    }
  }

  const undo = async (inst: Instrument) => {
    setBusy(true)
    setError(null)
    try {
      await repo.instruments.unconfirm(inst.id)
      setDone(`「${inst.name}」已撤销确认`)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤销失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="确认资产分类"
      subtitle={`${rows.length} 项待确认`}
      footer={
        rows.length > 0 ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2"
            >
              全部暂不处理
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmAllPicked()}
              className="flex-1 rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
              data-testid="confirm-picked"
            >
              确认已选类别
            </button>
          </div>
        ) : undefined
      }
    >
      {/* 语义说明：确认分类不改金额 */}
      <p className="rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        确认分类只记录「这个资产属于哪一类」，
        <span className="text-ink2">不会改动任何金额</span>，
        也不会修改持仓、交易流水或历史快照。
      </p>

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="classify-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="classify-done">
          {done}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-3 text-[12px] text-ink4" data-testid="classify-empty">
          没有待确认分类的资产。已确认 {confirmedRows.length} 项。
        </p>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="classify-list">
          {rows.map((inst) => {
            const holdingCount = holdingsByInstrument.get(inst.id) ?? 0
            const value = reliableByInstrument.get(inst.id)
            return (
              <li
                key={inst.id}
                className="rounded-2xl border border-line bg-s1 p-3"
                data-testid="classify-row"
                data-instrument-id={inst.id}
              >
                <p className="truncate text-[13px] text-ink">{inst.name}</p>
                <p className="mt-0.5 text-[11px] text-ink4">
                  {holdingCount} 个持仓
                  {value !== undefined ? ` · 可估值 ¥${value.toLocaleString('zh-CN')}` : ' · 无法估值'}
                  {' · 当前线索：'}
                  <span className="text-ink3">
                    {ASSET_CLASS_LABEL[inst.assetClass] ?? inst.assetClass}
                  </span>
                  <span className="tone-warn">（未确认）</span>
                </p>

                <div className="mt-2 flex items-center gap-2">
                  <select
                    value={pending[inst.id] ?? ''}
                    onChange={(e) =>
                      setPending((p) => ({ ...p, [inst.id]: (e.target.value || undefined) as AssetClass | undefined }))
                    }
                    className="flex-1 rounded-lg border border-line bg-s1 px-2 py-1.5 text-[12px] text-ink"
                    data-testid="classify-select"
                    aria-label={`${inst.name} 的资产类别`}
                  >
                    {/* 刻意不预选：必须由用户主动选择 */}
                    <option value="">请选择类别…</option>
                    {SELECTABLE.map((c) => (
                      <option key={c} value={c}>
                        {ASSET_CLASS_LABEL[c]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || !pending[inst.id]}
                    onClick={() => void confirm(inst)}
                    className="rounded-lg bg-ink px-3 py-1.5 text-[12px] text-s1 disabled:opacity-40"
                    data-testid="classify-confirm-one"
                  >
                    确认
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* 撤销确认（审计链的另一半） */}
      {confirmedRows.length > 0 ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-[12px] text-ink3" data-testid="undo-summary">
            已确认 {confirmedRows.length} 项 · 点此撤销
          </summary>
          <ul className="mt-2 space-y-1.5">
            {confirmedRows.map((inst) => (
              <li key={inst.id} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-ink2">{inst.name}</span>
                <span className="shrink-0 text-[11px] text-ink4">
                  {ASSET_CLASS_LABEL[inst.assetClass] ?? inst.assetClass}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void undo(inst)}
                  className="shrink-0 rounded-lg border border-line px-2 py-1 text-[11px] text-ink3 disabled:opacity-50"
                  data-testid="classify-undo"
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Sheet>
  )
}
