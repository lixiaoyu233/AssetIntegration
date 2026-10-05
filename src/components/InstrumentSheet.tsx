import { useState } from 'react'
import { Info } from 'lucide-react'
import type { AssetClass, CurrencyCode, InstrumentType, Region } from '../types/portfolio2'
import {
  ASSET_CLASS_LABEL,
  INSTRUMENT_TYPE_LABEL,
  REGION_LABEL,
} from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { createInstrument } from '../lib/db/creation'
import { currencyOptions } from '../lib/valuation/priceService'
import Sheet from './Sheet'

/**
 * 创建标的（Phase 8 / W7 冷启动）
 *
 * ## 核心原则：资产类别**必须用户明确选择**
 *
 * UI **不预选、不推断、不按名称猜测**。
 * `assetClass` 初始为空，用户不选就无法提交 ——
 * 这是「禁止自动分类」在创建路径上的硬约束。
 */
export interface InstrumentSheetProps {
  open: boolean
  onClose: () => void
  repo: PortfolioRepository
  onCreated: () => void
}

const TYPES: InstrumentType[] = [
  'stock', 'etf', 'fund', 'bond', 'gold', 'cash', 'crypto', 'real_estate', 'receivable', 'other',
]
const CLASSES: AssetClass[] = [
  'cash', 'equity', 'fixed_income', 'gold', 'real_estate', 'crypto', 'receivable', 'other', 'liability',
]
const REGIONS: Region[] = ['CN', 'US', 'HK', 'JP', 'EU', 'GLOBAL', 'OTHER']

export default function InstrumentSheet({ open, onClose, repo, onCreated }: InstrumentSheetProps) {
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [instrumentType, setInstrumentType] = useState<InstrumentType>('stock')
  // 刻意留空：用户必须主动选择，系统不代劳
  const [assetClass, setAssetClass] = useState<AssetClass | ''>('')
  const [currency, setCurrency] = useState<CurrencyCode>('CNY')
  const [region, setRegion] = useState<Region | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = async () => {
    if (!assetClass) {
      setError('请明确选择资产类别（系统不会替你猜测）')
      return
    }
    setBusy(true)
    setError(null)
    setDone(null)
    const r = await createInstrument(repo, {
      name,
      symbol,
      instrumentType,
      assetClass,
      currency,
      region: region || undefined,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    setDone(`已创建标的：${r.instrument.name}（该分类已标记为「用户确认」）`)
    setName('')
    setSymbol('')
    setAssetClass('')
    onCreated()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="创建标的"
      subtitle="标的代表「持有什么」，与账户是两个维度"
      footer={
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2">
            关闭
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="flex-1 rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
            data-testid="instrument-save"
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      }
    >
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          <span className="text-ink2">资产类别必须由你选择</span>，系统不会根据名称或代码自动判断。
          你选择的结果会记为「用户确认」。
        </span>
      </p>

      <div className="mt-3 space-y-3">
        <label className="block text-[11px] text-ink3">
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：某指数基金"
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="instrument-name"
          />
        </label>

        <label className="block text-[11px] text-ink3">
          代码（可留空；有代码时按「代码 + 币种」判重）
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="instrument-symbol"
          />
        </label>

        <label className="block text-[11px] text-ink3">
          品类
          <select
            value={instrumentType}
            onChange={(e) => setInstrumentType(e.target.value as InstrumentType)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="instrument-type"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {INSTRUMENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          资产类别 <span className="tone-warn">（必选，系统不猜）</span>
          <select
            value={assetClass}
            onChange={(e) => {
              setAssetClass(e.target.value as AssetClass)
              setError(null)
            }}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="instrument-asset-class"
          >
            <option value="">请选择…</option>
            {CLASSES.map((c) => (
              <option key={c} value={c}>
                {ASSET_CLASS_LABEL[c]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          计价币种
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="instrument-currency"
          >
            {currencyOptions().map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          标的自带地区（可留空）
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value as Region | '')}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="instrument-region"
          >
            <option value="">不指定</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {REGION_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="instrument-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="instrument-done">
          {done}
        </p>
      ) : null}
    </Sheet>
  )
}
