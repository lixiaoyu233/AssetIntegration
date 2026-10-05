import { useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import type { Portfolio2, PriceKind } from '../types/portfolio2'
import { PRICE_KIND_LABEL, QUOTE_STATUS_LABEL } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { upsertQuote } from '../lib/valuation/priceService'
import { quoteOf } from '../lib/valuation/basis'
import Sheet from './Sheet'

/**
 * 行情录入 / 更新（Phase 8 / W6）
 *
 * ## 为什么需要手动录入
 *
 * W6 审计发现 2.0 侧对 `quotes` 的写入调用数为 0 ——
 * 行情只能来自 W1 迁移，之后只减不增，一旦过期可靠总资产静默萎缩。
 * 本 Sheet 补齐这个**能力断点**（W6 不做自动获取）。
 *
 * ## 三条硬规则
 *
 * 1. 价格必须 > 0 —— **不可估值就留空，绝不填 0**
 * 2. 币种必须与标的计价币种一致（跨币种是估值时折算的事，不是填价时的事）
 * 3. 手填默认 `MANUAL` 状态并如实标注来源 `manual`，
 *    **绝不伪装成外部行情源**
 */
export interface QuoteSheetProps {
  open: boolean
  onClose: () => void
  portfolio: Portfolio2
  repo: PortfolioRepository
  onChanged: () => void
  /** 预设标的 */
  initialInstrumentId?: string
}

const KINDS: PriceKind[] = ['market_price', 'nav', 'estimated_nav', 'manual']

/** 本地日期时间 → ISO */
function nowLocalInput(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toIso(local: string): string {
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function fromIso(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function QuoteSheet({
  open,
  onClose,
  portfolio,
  repo,
  onChanged,
  initialInstrumentId,
}: QuoteSheetProps) {
  /** 需要行情的标的（排除现金：现金数量即金额，不需要行情） */
  const candidates = useMemo(
    () => portfolio.instruments.filter((i) => i.instrumentType !== 'cash'),
    [portfolio.instruments],
  )

  const [instrumentId, setInstrumentId] = useState(initialInstrumentId ?? candidates[0]?.id ?? '')
  const instrument = portfolio.instruments.find((i) => i.id === instrumentId)
  const existing = instrument ? quoteOf(portfolio, instrument.id) : undefined
  /** 该标的历史行情条数（W8 起按时间点累积，不再覆盖） */
  const historyCount = instrument
    ? portfolio.quotes.filter((q) => q.instrumentId === instrument.id).length
    : 0

  const [priceKind, setPriceKind] = useState<PriceKind>(existing?.priceKind ?? 'market_price')
  const [price, setPrice] = useState(
    existing ? String(existing.marketPrice ?? existing.nav ?? existing.estimatedNav ?? '') : '',
  )
  const [when, setWhen] = useState(nowLocalInput())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const pickInstrument = (id: string) => {
    setInstrumentId(id)
    const q = quoteOf(portfolio, id)
    setPriceKind(q?.priceKind ?? 'market_price')
    setPrice(q ? String(q.marketPrice ?? q.nav ?? q.estimatedNav ?? '') : '')
    setWhen(q ? fromIso(q.timestamp) : nowLocalInput())
    setError(null)
    setDone(null)
  }

  const submit = async () => {
    if (!instrument) return
    setBusy(true)
    setError(null)
    setDone(null)

    const result = await upsertQuote(repo, {
      instrumentId: instrument.id,
      priceKind,
      price: Number(price),
      currency: instrument.currency,
      timestamp: toIso(when),
      // 手填 → MANUAL（政策上不因时间失效）+ 如实标注来源
      status: 'MANUAL',
      source: 'manual',
    })

    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setDone(
      `已保存：${instrument.name} ${Number(price).toLocaleString('zh-CN')} ${instrument.currency}` +
        `（${PRICE_KIND_LABEL[priceKind]}）`,
    )
    onChanged()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="录入 / 更新行情"
      subtitle="手动录入，不联网获取"
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
            disabled={busy || !instrument}
            onClick={() => void submit()}
            className="flex-1 rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
            data-testid="quote-save"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          W6 阶段为**手动录入**：不会联网获取行情。
          价格必须大于 0 —— <span className="text-ink2">无法估值时请留空，不要填 0</span>。
        </span>
      </p>

      {candidates.length === 0 ? (
        <p className="mt-3 text-[12px] text-ink4" data-testid="quote-empty">
          还没有需要行情的标的（现金不需要行情）。
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <label className="block text-[11px] text-ink3">
            标的
            <select
              value={instrumentId}
              onChange={(e) => pickInstrument(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="quote-instrument"
            >
              {candidates.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.symbol ? `（${i.symbol}）` : ''} · {i.currency}
                </option>
              ))}
            </select>
          </label>

          {existing ? (
            <p className="rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink4" data-testid="quote-existing">
              当前行情：{PRICE_KIND_LABEL[existing.priceKind]}{' '}
              {existing.marketPrice ?? existing.nav ?? existing.estimatedNav} {existing.currency}
              {' · '}
              {QUOTE_STATUS_LABEL[existing.status]}
              {' · '}
              来源 {existing.source}
              {' · '}
              {new Date(existing.timestamp).toLocaleString('zh-CN')}
            </p>
          ) : (
            <p className="text-[11px] tone-warn" data-testid="quote-missing">
              该标的当前**没有行情**，因此无法估值（不会按成本或 0 顶替）。
            </p>
          )}

          <label className="block text-[11px] text-ink3">
            价格类型
            <select
              value={priceKind}
              onChange={(e) => setPriceKind(e.target.value as PriceKind)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="quote-kind"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {PRICE_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-[11px] text-ink3">
            价格（{instrument?.currency}）
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="留空表示暂无行情"
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="quote-price"
            />
          </label>

          <label className="block text-[11px] text-ink3">
            依据时间
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="quote-timestamp"
            />
          </label>

          <p className="rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink4">
            手填价格会记为 <span className="text-ink3">手动</span> 状态并注明来源为
            <span className="text-ink3"> manual</span>，不会伪装成外部行情。
            行情过期后不会再计入可靠总资产。
            <br />
            <span className="text-ink3">
              不同时间点的行情会**各自保留**（当前已记录 {historyCount} 条），
              因此历史快照仍能解释「当时为什么是这个价值」。
            </span>
          </p>
        </div>
      )}

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="quote-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="quote-done">
          {done}
        </p>
      ) : null}
    </Sheet>
  )
}
