import { useState } from 'react'
import type { AssetClass, InstrumentType, Portfolio2 } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { ASSET_CLASS_LABEL } from '../lib/analysis/dimensions'
import Sheet from './Sheet'

/**
 * 标的属性编辑 Sheet（Phase 8 / W3）
 *
 * ## 允许编辑的字段（**仅 Instrument metadata**）
 *
 * | 字段 | 是否可编辑 | 约束 |
 * | --- | --- | --- |
 * | `name` | ✅ | 展示名 |
 * | `symbol` | ✅ | 代码 / ticker |
 * | `instrumentType` | ✅ | 品类（stock / etf / cash …） |
 * | `region` | ✅ | 标的自带地区（可选） |
 * | `assetClass` | ⚠️ **走确认 API** | 必须经 `confirmOne`，以保留审计链 |
 * | `classificationStatus` | ❌ | 只能由 confirm / unconfirm 改变 |
 *
 * ## 绝不修改
 *
 * `Holding` / `Transaction` / `Snapshot` —— 它们是派生与事实数据，
 * 编辑标的属性只影响估值引擎读取的元信息。
 *
 * > 注意：`instrumentType` 属于**形态描述**（这只标的「是什么」），
 * > 与「估值方式」（`Holding.valuationMode`）是两件事。
 * > 把现金登记成交易驱动持仓属于 Cash 转换，见 `CashConvertSheet`。
 */
export interface AttributeKindSheetProps {
  portfolio: Portfolio2
  repo: PortfolioRepository
  onClose: () => void
  onChanged: () => void
}

const TYPES: InstrumentType[] = [
  'stock',
  'etf',
  'fund',
  'bond',
  'gold',
  'cash',
  'crypto',
  'real_estate',
  'receivable',
  'other',
]

const CLASSES: AssetClass[] = [
  'cash',
  'equity',
  'fixed_income',
  'gold',
  'real_estate',
  'crypto',
  'receivable',
  'other',
]

const TYPE_LABEL: Record<InstrumentType, string> = {
  stock: '股票',
  etf: 'ETF',
  fund: '基金',
  bond: '债券',
  gold: '黄金',
  cash: '现金',
  crypto: '数字资产',
  real_estate: '房产',
  receivable: '应收',
  other: '其他',
}

interface Draft {
  name: string
  symbol: string
  instrumentType: InstrumentType
  region?: string
  /** 用户选择的资产类别；与当前不同才调用确认 API */
  assetClass: AssetClass
}

export default function AttributeKindSheet({
  portfolio,
  repo,
  onClose,
  onChanged,
}: AttributeKindSheetProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(portfolio.instruments[0]?.id)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const inst = portfolio.instruments.find((i) => i.id === selectedId)

  // 选中项变化时初始化草稿
  const draftOf = (id: string | undefined): Draft | null => {
    const target = portfolio.instruments.find((i) => i.id === id)
    if (!target) return null
    return {
      name: target.name,
      symbol: target.symbol ?? '',
      instrumentType: target.instrumentType,
      region: target.region,
      assetClass: target.assetClass,
    }
  }

  const current = draft ?? draftOf(selectedId)

  const pick = (id: string) => {
    setSelectedId(id)
    setDraft(null)
    setError(null)
    setDone(null)
  }

  const save = async () => {
    if (!inst || !current) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const classificationChanged = current.assetClass !== inst.assetClass

      /*
       * 1) 分类变更**必须**走 confirmation API（写审计条目）。
       *    直接 put 会绕过 Phase 7 的审计链，是被禁止的。
       */
      if (classificationChanged) {
        await repo.instruments.confirmOne(inst.id, current.assetClass)
      }

      /*
       * 2) 其余 metadata 用普通写入。
       *    刻意**不**包含 classificationStatus：它只能由 confirm/unconfirm 改变。
       *    也**不**触碰任何 Holding / Transaction / Snapshot。
       */
      const latest = (await repo.instruments.get(inst.id)) ?? inst
      await repo.instruments.put({
        ...latest,
        name: current.name.trim() || latest.name,
        symbol: current.symbol.trim() || undefined,
        instrumentType: current.instrumentType,
        region: (current.region as never) || undefined,
        updatedAt: new Date().toISOString(),
      })

      setDone(
        classificationChanged
          ? '已保存，并更新了资产分类（已记录审计条目）'
          : '已保存标的属性',
      )
      setDraft(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="编辑标的属性"
      subtitle={`共 ${portfolio.instruments.length} 个标的`}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2"
          >
            关闭
          </button>
          <button
            type="button"
            disabled={busy || !current}
            onClick={() => void save()}
            className="flex-1 rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
            data-testid="attr-save"
          >
            保存
          </button>
        </div>
      }
    >
      {portfolio.instruments.length === 0 ? (
        <p className="text-[12px] text-ink4">还没有标的</p>
      ) : (
        <>
          <label className="block text-[11px] text-ink3">
            选择标的
            <select
              value={selectedId ?? ''}
              onChange={(e) => pick(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="attr-instrument"
            >
              {portfolio.instruments.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.symbol ? `（${i.symbol}）` : ''}
                </option>
              ))}
            </select>
          </label>

          {current ? (
            <div className="mt-3 space-y-3">
              <label className="block text-[11px] text-ink3">
                名称
                <input
                  value={current.name}
                  onChange={(e) => setDraft({ ...current, name: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
                  data-testid="attr-name"
                />
              </label>

              <label className="block text-[11px] text-ink3">
                代码 / Ticker（可留空）
                <input
                  value={current.symbol}
                  onChange={(e) => setDraft({ ...current, symbol: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
                  data-testid="attr-symbol"
                />
              </label>

              <label className="block text-[11px] text-ink3">
                品类
                <select
                  value={current.instrumentType}
                  onChange={(e) =>
                    setDraft({ ...current, instrumentType: e.target.value as InstrumentType })
                  }
                  className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
                  data-testid="attr-type"
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[11px] text-ink3">
                资产类别
                {inst && current.assetClass === inst.assetClass && inst.classificationStatus === 'confirmed' ? (
                  <span className="ml-1.5 text-ink4">（已确认）</span>
                ) : (
                  <span className="ml-1.5 tone-warn">（修改将通过确认机制记录审计）</span>
                )}
                <select
                  value={current.assetClass}
                  onChange={(e) => setDraft({ ...current, assetClass: e.target.value as AssetClass })}
                  className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
                  data-testid="attr-class"
                >
                  {CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {ASSET_CLASS_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[11px] text-ink3">
                标的自带地区（可留空，留空表示未知）
                <input
                  value={current.region ?? ''}
                  onChange={(e) => setDraft({ ...current, region: e.target.value })}
                  placeholder="例如 US / HK / CN"
                  className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
                  data-testid="attr-region"
                />
              </label>

              <p className="rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink4">
                这里只修改标的的元信息，<span className="text-ink3">不会改动持仓数量、成本、交易流水或历史快照</span>。
                资产列表的地区维度使用**账户属地**，与此处的标的自带地区是两回事。
              </p>
            </div>
          ) : null}
        </>
      )}

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="attr-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="attr-done">
          {done}
        </p>
      ) : null}
    </Sheet>
  )
}
