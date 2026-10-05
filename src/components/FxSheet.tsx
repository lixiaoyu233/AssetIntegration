import { useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import type { CurrencyCode, Portfolio2 } from '../types/portfolio2'
import { FX_STATUS_LABEL } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { currencyOptions, upsertFxRate } from '../lib/valuation/priceService'
import { resolveRate } from '../lib/valuation/fx'
import { createFxTable } from '../lib/valuation/fx'
import { missingCurrencies } from '../lib/valuation/priceService'
import Sheet from './Sheet'

/**
 * 汇率录入 / 更新（Phase 8 / W6）
 *
 * ## 为什么需要
 *
 * 与行情同理：2.0 侧对 `fxRates` 的写入调用数为 0。
 * 缺汇率的持仓永远是 `unavailable`（**绝不按 1:1 兜底**），
 * 用户必须有途径补上真实汇率。
 *
 * ## 硬规则
 *
 * - 汇率必须 > 0；**缺就是缺，不要填 1 或 0**
 * - 同币种（base === quote）拒绝 —— 那恒为 1，不需要录入
 * - 只录入「对 CNY」的汇率；跨币种由既有 `resolveRate` 经 CNY 中转推导
 */
export interface FxSheetProps {
  open: boolean
  onClose: () => void
  portfolio: Portfolio2
  repo: PortfolioRepository
  onChanged: () => void
  /**
   * 自动同步状态与「立即刷新」入口（可选）。
   *
   * 不传时本面板退化为「只有手动录入」，便于测试单独渲染。
   */
  fxSync?: {
    busy: boolean
    stale: boolean
    last: { source: string; syncedAt: string; error?: string } | null
    refresh: () => Promise<unknown>
  }
}

/** 自动来源的可读标签（手动录入也在内，便于统一展示） */
const AUTO_SOURCE_LABEL: Record<string, string> = {
  'er-api': '自动 · open.er-api.com',
  jsdelivr: '自动 · jsdelivr',
  seed: '兜底种子文件',
  manual: '手动录入',
}

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

export default function FxSheet({ open, onClose, portfolio, repo, onChanged, fxSync }: FxSheetProps) {
  /** 缺汇率的币种（优先提示这些） */
  const missing = useMemo(() => missingCurrencies(portfolio), [portfolio])
  const options = currencyOptions().filter((c) => c !== 'CNY')

  const [currency, setCurrency] = useState<CurrencyCode>(missing[0] ?? options[0])
  const [rate, setRate] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  /** 现有汇率（对 CNY 的直读或反向） */
  const existing = useMemo(() => {
    const fx = createFxTable(portfolio.fxRates)
    const r = resolveRate(fx, currency, 'CNY', { allowStale: true })
    return r
  }, [portfolio.fxRates, currency])

  /** 该币种对已有多少条历史汇率（W8 起按时间点累积，不再覆盖） */
  const historyCount = portfolio.fxRates.filter(
    (r) => r.baseCurrency === currency && r.quoteCurrency === 'CNY',
  ).length

  /**
   * 当前生效汇率的来源标签。
   *
   * 为什么要显示：自动获取失败时会静默回落到兜底种子，
   * 若不标明来源，用户会以为看到的是实时价 —— 属于「假成功」的变体。
   */
  const existingSourceLabel = useMemo(() => {
    if (!existing) return ''
    const hit = portfolio.fxRates.find(
      (r) =>
        r.baseCurrency === currency &&
        r.quoteCurrency === 'CNY' &&
        r.timestamp === existing.asOf,
    )
    return hit ? (AUTO_SOURCE_LABEL[hit.source] ?? hit.source) : ''
  }, [existing, portfolio.fxRates, currency])

  const submit = async () => {
    setBusy(true)
    setError(null)
    setDone(null)

    // 录入「1 外币 = ? CNY」，因此 base = 外币、quote = CNY
    const result = await upsertFxRate(repo, {
      baseCurrency: currency,
      quoteCurrency: 'CNY',
      rate: Number(rate),
      timestamp: toIso(when),
      status: 'MANUAL',
      source: 'manual',
    })

    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setDone(
      `已保存：1 ${currency} = ${Number(rate).toLocaleString('zh-CN')} CNY` +
        `（影响 ${result.affectedHoldingCount} 项持仓）`,
    )
    setRate('')
    onChanged()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="录入 / 更新汇率"
      subtitle="对人民币（CNY），手动录入"
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
            disabled={busy}
            onClick={() => void submit()}
            className="flex-1 rounded-xl bg-invert py-2.5 text-[13px] text-on-invert disabled:opacity-50"
            data-testid="fx-save"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          汇率会**自动获取**：启动时、页面回到前台时、以及每 6 小时各检查一次，
          依次尝试 open.er-api.com → jsdelivr → 仓库内的兜底种子文件。
          <span className="text-ink2">全部拿不到时用兜底值；再没有则保持「无法估值」，绝不会按 1:1 折算。</span>
        </span>
      </p>

      {/* 立即刷新 + 当前来源：让「这次用的是实时价还是兜底价」一眼可见 */}
      {fxSync ? (
        <div className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2" data-testid="fx-sync-bar">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink3" data-testid="fx-sync-status">
              {fxSync.busy
                ? '正在获取汇率…'
                : fxSync.last
                  ? fxSync.last.source === 'none'
                    ? '自动获取失败，正在使用已有汇率'
                    : `上次获取：${AUTO_SOURCE_LABEL[fxSync.last.source] ?? fxSync.last.source}`
                  : '尚未获取'}
              {fxSync.last?.syncedAt && !fxSync.busy
                ? ` · ${new Date(fxSync.last.syncedAt).toLocaleString('zh-CN')}`
                : ''}
            </span>
            <button
              type="button"
              onClick={() => void fxSync.refresh()}
              disabled={fxSync.busy}
              className="shrink-0 rounded-lg border border-line bg-s1 px-2.5 py-1 text-[11px] text-ink2 disabled:opacity-50"
              data-testid="fx-refresh"
            >
              {fxSync.busy ? '获取中…' : '立即刷新'}
            </button>
          </div>
          {fxSync.last?.error && !fxSync.busy ? (
            <p className="mt-1 text-[10px] text-ink4" data-testid="fx-sync-error">
              自动来源均不可用：{fxSync.last.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {missing.length > 0 ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="fx-missing">
          当前缺少这些币种的汇率：{missing.join('、')} —— 相关持仓暂时无法计入可靠总资产。
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        <label className="block text-[11px] text-ink3">
          币种（1 外币 = ? CNY）
          <select
            value={currency}
            onChange={(e) => {
              setCurrency(e.target.value as CurrencyCode)
              setError(null)
              setDone(null)
            }}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="fx-currency"
          >
            {options.map((c) => (
              <option key={c} value={c}>
                {c}
                {missing.includes(c) ? '（缺汇率）' : ''}
              </option>
            ))}
          </select>
        </label>

        {existing ? (
          <p className="rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink4" data-testid="fx-existing">
            当前汇率：1 {currency} = {existing.rate.toLocaleString('zh-CN')} CNY ·{' '}
            {FX_STATUS_LABEL[existing.status as keyof typeof FX_STATUS_LABEL] ?? existing.status}
            {existingSourceLabel ? ` · 来源 ${existingSourceLabel}` : ''} · 依据{' '}
            {new Date(existing.asOf).toLocaleString('zh-CN')}
          </p>
        ) : (
          <p className="text-[11px] tone-warn" data-testid="fx-none">
            该币种**没有可用汇率**，相关持仓不会被折算（不会按 1:1 兜底）。
          </p>
        )}

        <label className="block text-[11px] text-ink3">
          汇率（1 {currency} = ? CNY）
          <input
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="例如 7.12"
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="fx-rate"
          />
        </label>

        <label className="block text-[11px] text-ink3">
          依据时间
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="fx-timestamp"
          />
        </label>

        <p className="rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink4">
          手填汇率记为 <span className="text-ink3">手动</span> 状态（不因时间失效）并注明来源{' '}
          <span className="text-ink3">manual</span>。
          <br />
          <span className="text-ink3">
            不同时间点的汇率会**各自保留**（当前已记录 {historyCount} 条），
            历史快照因此仍能解释「当时按什么汇率折算」。
          </span>
        </p>
      </div>

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="fx-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="fx-done">
          {done}
        </p>
      ) : null}
    </Sheet>
  )
}
