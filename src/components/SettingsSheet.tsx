import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BarChart3, Check, Landmark, LineChart, Stethoscope, TrendingUp } from 'lucide-react'
import type { Portfolio } from '../types/asset'
import type { TrendRange, TrendTab } from '../lib/netWorthHistory'
import { ALL_TREND_TABS, TREND_RANGE_LABEL, TREND_TAB_LABEL } from '../lib/netWorthHistory'
import type { AppSettings, CashCandidate, FundingSource, TrendsConfig } from '../lib/settings'
import { currentMonth, formatMonth, isPaydayReached } from '../lib/settings'
import { formatCNY } from '../lib/format'
import { collectDiagnostics, resolveSafeTopInset } from '../lib/safeArea'
import Sheet from './Sheet'

interface SettingsSheetProps {
  open: boolean
  settings: AppSettings
  portfolio: Portfolio
  candidates: CashCandidate[]
  onClose: () => void
  onSetFundDefault: (patch: Partial<AppSettings['fund']>) => void
  onSetFundingSource: (source: FundingSource | undefined) => void
  onSetTrends: (patch: Partial<TrendsConfig>) => void
  onSetFixed: (patch: Partial<AppSettings['salary']['fixed']>) => void
  onUpsertSalary: (month: string, amount: number) => void
  onRemoveSalary: (month: string) => void
  onApplySalary: (month: string) => { ok: boolean; message: string }
}

/** 设置的三级菜单：先进列表，再进具体页面 */
type Page = 'menu' | 'fund' | 'salary' | 'trends' | 'diagnostics'

const PAGE_META: Record<Exclude<Page, 'menu'>, { title: string; subtitle: string }> = {
  fund: { title: '股票基金申购方式', subtitle: '买入时资金从哪里来' },
  salary: { title: '薪资', subtitle: '每月记录与固定发薪' },
  trends: { title: '走势图', subtitle: '开关与展示内容' },
  diagnostics: { title: '诊断信息', subtitle: '排查显示问题用' },
}

/* ------------------------------------------------------------------ *
 * 通用开关：状态写在文字上，整行可点
 * ------------------------------------------------------------------ */

function SwitchRow({
  label,
  desc,
  checked,
  onChange,
  testId,
}: {
  label: string
  desc?: string
  checked: boolean
  onChange: (v: boolean) => void
  testId: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-s2 px-3.5 py-3 text-left transition hover:bg-s3"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] text-ink1">{label}</span>
        {desc ? <span className="mt-0.5 block text-[11px] leading-relaxed text-ink4">{desc}</span> : null}
      </span>
      {/* 明确的开关：滑块 + 文字状态，避免看不出开没开 */}
      <span className="flex shrink-0 items-center gap-2">
        <span className={`text-[11.5px] ${checked ? 'tone-down' : 'text-ink4'}`}>
          {checked ? '已开启' : '已关闭'}
        </span>
        <span className={`relative h-[22px] w-[38px] rounded-full transition ${checked ? 'bg-green' : 'bg-s4'}`}>
          <span
            className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all ${
              checked ? 'left-[19px]' : 'left-[3px]'
            }`}
          />
        </span>
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * 主面板
 * ------------------------------------------------------------------ */

export default function SettingsSheet(props: SettingsSheetProps) {
  const { open, onClose } = props
  const [page, setPage] = useState<Page>('menu')

  useEffect(() => {
    if (open) setPage('menu')
  }, [open])

  const meta = page === 'menu' ? null : PAGE_META[page]

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={meta?.title ?? '设置'}
      subtitle={meta?.subtitle ?? '选择要修改的项目'}
      leading={
        page === 'menu' ? (
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-s2 text-ink2">
            <TrendingUp size={17} />
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setPage('menu')}
            aria-label="返回设置"
            data-testid="settings-back"
            className="-ml-1 mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink2 transition hover:bg-s3"
          >
            <ArrowLeft size={18} />
          </button>
        )
      }
    >
      {page === 'menu' ? (
        <MenuPage settings={props.settings} onGo={setPage} />
      ) : page === 'fund' ? (
        <FundPage {...props} />
      ) : page === 'salary' ? (
        <SalaryPage {...props} />
      ) : page === 'trends' ? (
        <TrendsPage {...props} />
      ) : (
        <DiagnosticsPage />
      )}
    </Sheet>
  )
}

function MenuPage({ settings, onGo }: { settings: AppSettings; onGo: (p: Page) => void }) {
  const items: Array<{
    key: Exclude<Page, 'menu'>
    icon: typeof BarChart3
    title: string
    desc: string
    state: string
  }> = [
    {
      key: 'fund',
      icon: Landmark,
      title: '股票基金申购方式',
      desc: '直接添加，或从现金项目划拨',
      state: settings.fund.useFunding ? '从项目划拨' : '直接添加',
    },
    {
      key: 'salary',
      icon: TrendingUp,
      title: '薪资',
      desc: '每月薪资记录、固定发薪与走势',
      state: settings.salary.records.length > 0 ? `${settings.salary.records.length} 个月记录` : '未记录',
    },
    {
      key: 'trends',
      icon: LineChart,
      title: '走势图',
      desc: '是否显示，以及展示哪些内容',
      state: settings.trends.enabled ? `已开启 · ${settings.trends.metrics.length} 项` : '已关闭',
    },
    {
      key: 'diagnostics',
      icon: Stethoscope,
      title: '诊断信息',
      desc: '屏幕尺寸、安全区实测值等',
      state: '查看',
    },
  ]

  return (
    <ul className="space-y-2" data-testid="settings-menu">
      {items.map((it) => {
        const Icon = it.icon
        return (
          <li key={it.key}>
            <button
              type="button"
              data-testid={`settings-menu-${it.key}`}
              onClick={() => onGo(it.key)}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-s2 px-3.5 py-3 text-left transition hover:bg-s3"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-s3 text-ink2">
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium text-ink1">{it.title}</span>
                <span className="mt-0.5 block text-[11.5px] text-ink4">{it.desc}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[11.5px] text-ink3">{it.state}</span>
                <span className="mt-0.5 block text-ink4">›</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/* ------------------------------------------------------------------ *
 * 一、股票基金申购方式
 * ------------------------------------------------------------------ */

function SourcePicker({
  candidates,
  value,
  onChange,
  testId,
}: {
  candidates: CashCandidate[]
  value?: FundingSource
  onChange: (s: FundingSource | undefined) => void
  testId: string
}) {
  const grouped = useMemo(() => {
    const m = new Map<string, CashCandidate[]>()
    for (const c of candidates) {
      if (!m.has(c.categoryId)) m.set(c.categoryId, [])
      m.get(c.categoryId)!.push(c)
    }
    return [...m.entries()]
  }, [candidates])

  if (candidates.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-[12px] leading-relaxed text-ink4">
        还没有可作为资金来源的项目。先到「现金与固定资产」添加一个金额类条目（如「招行活期」），
        之后就能选它来划拨。
      </p>
    )
  }

  return (
    <select
      data-testid={testId}
      value={value?.itemId ?? ''}
      onChange={(e) => {
        const id = e.target.value
        const hit = candidates.find((c) => c.itemId === id)
        onChange(hit ? { categoryId: hit.categoryId, itemId: hit.itemId, itemName: hit.itemName } : undefined)
      }}
      className="field-input"
    >
      <option value="">请选择项目</option>
      {grouped.map(([catId, list]) => (
        <optgroup key={catId} label={list[0]?.categoryName ?? ''}>
          {list.map((c) => (
            <option key={c.itemId} value={c.itemId}>
              {c.itemName}（余额 {formatCNY(c.amount, 0)}）
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function FundPage({ settings, candidates, onSetFundDefault, onSetFundingSource }: SettingsSheetProps) {
  return (
    <div className="space-y-5">
      <div>
        <p className="field-label">默认方式</p>
        <div className="space-y-2">
          {(
            [
              [false, '直接添加', '只增加持仓，现金余额不变'],
              [true, '从现有项目划拨', '持仓 +X，所选现金项 −X，净资产不变'],
            ] as Array<[boolean, string, string]>
          ).map(([useFunding, title, desc]) => {
            const active = settings.fund.useFunding === useFunding
            return (
              <button
                key={title}
                type="button"
                data-testid={`fund-default-${useFunding ? 'funding' : 'direct'}`}
                onClick={() => onSetFundDefault({ useFunding })}
                className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
                  active ? 'border-line-strong bg-s3' : 'border-line bg-s2 hover:bg-s3'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="flex-1 text-[13.5px] font-medium text-ink1">{title}</span>
                  {active ? <Check size={15} className="tone-down" /> : null}
                </span>
                <span className="mt-1 block text-[11.5px] leading-relaxed text-ink4">{desc}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <p className="field-label">默认扣款项目</p>
        <SourcePicker
          testId="settings-funding-source"
          candidates={candidates}
          value={settings.fund.lastFundingSource}
          onChange={onSetFundingSource}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink4">
          选定后，添加基金或美股/港股持仓时会自动带出（每次仍可临时改）。划拨会让该项目的余额相应减少，
          所以净资产保持不变——钱只是从现金变成了投资。已保存的持仓可以点进去改成本与份额。
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 二、薪资
 * ------------------------------------------------------------------ */

function SalaryPage({
  settings,
  candidates,
  onSetTrends,
  onSetFixed,
  onUpsertSalary,
  onRemoveSalary,
  onApplySalary,
}: SettingsSheetProps) {
  const month = currentMonth()
  const existing = settings.salary.records.find((r) => r.month === month)
  const [draft, setDraft] = useState('')
  const [fixedDraft, setFixedDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setDraft(existing ? String(existing.amount) : '')
  }, [existing?.amount, existing?.month])

  useEffect(() => {
    setFixedDraft(settings.salary.fixed.amount ? String(settings.salary.fixed.amount) : '')
  }, [settings.salary.fixed.amount])

  const saveMonth = () => {
    const v = Number(draft.replace(/[,\s]/g, ''))
    if (!Number.isFinite(v) || v <= 0) return setMessage('请输入大于 0 的金额')
    onUpsertSalary(month, v)
    setMessage(`已记录 ${formatMonth(month)}：${formatCNY(v)} 元`)
  }
  const saveFixed = () => {
    const v = Number(fixedDraft.replace(/[,\s]/g, ''))
    if (!Number.isFinite(v) || v <= 0) return setMessage('固定薪资金额需要大于 0')
    onSetFixed({ amount: v })
    setMessage(`固定薪资已设为 ${formatCNY(v)} 元 / 月`)
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="field-label">本月薪资（{formatMonth(month)}）</p>
        <div className="flex gap-2">
          <input
            data-testid="salary-month-amount"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="decimal"
            placeholder="如 20000"
            className="field-input flex-1 tabular-nums"
          />
          <button type="button" data-testid="salary-save" className="btn-primary shrink-0 px-4" onClick={saveMonth}>
            保存
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink4">
          只记录年月与金额，存档后可回看走势；修改金额会把该月标记为「未入账」，需要重新写入。
        </p>
        {existing ? (
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-line bg-s2 px-3.5 py-2.5 text-[12px]">
            <span className="text-ink3">
              {formatMonth(existing.month)} · {formatCNY(existing.amount)} 元
            </span>
            <span className={`ml-auto ${existing.applied ? 'tone-down' : 'tone-warn'}`}>
              {existing.applied ? '已入账' : '未入账'}
            </span>
            {!existing.applied ? (
              <button
                type="button"
                data-testid="salary-apply"
                className="btn-ghost px-3 py-1.5 text-[12px]"
                onClick={() => setMessage(onApplySalary(month).message)}
              >
                写入现金项
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="border-t border-line pt-4">
        <SwitchRow
          testId="salary-fixed-enabled"
          label="固定薪资"
          desc="填一次金额与发薪日，之后每月到点自动记入指定项目（不会重复入账）"
          checked={settings.salary.fixed.enabled}
          onChange={(v) => onSetFixed({ enabled: v })}
        />

        {settings.salary.fixed.enabled ? (
          <div className="mt-3 space-y-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="field-label" htmlFor="fixed-amount">
                  每月金额
                </label>
                <input
                  id="fixed-amount"
                  data-testid="salary-fixed-amount"
                  value={fixedDraft}
                  onChange={(e) => setFixedDraft(e.target.value)}
                  inputMode="decimal"
                  placeholder="如 20000"
                  className="field-input tabular-nums"
                />
              </div>
              <div className="w-[104px]">
                <label className="field-label" htmlFor="fixed-payday">
                  发薪日
                </label>
                <input
                  id="fixed-payday"
                  data-testid="salary-fixed-payday"
                  value={String(settings.salary.fixed.payday)}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/\D/g, ''))
                    onSetFixed({ payday: Number.isFinite(n) && n > 0 ? Math.min(28, n) : 1 })
                  }}
                  inputMode="numeric"
                  className="field-input tabular-nums"
                />
              </div>
              <button type="button" className="btn-ghost mt-6 shrink-0 px-3" onClick={saveFixed}>
                保存
              </button>
            </div>

            <div>
              <p className="field-label">发薪后写入哪个项目</p>
              <SourcePicker
                testId="salary-fixed-target"
                candidates={candidates}
                value={settings.salary.fixed.target}
                onChange={(s) => onSetFixed({ target: s })}
              />
              {settings.salary.fixed.target ? (
                <p className="mt-1.5 text-[11px] text-ink4">
                  到达每月 {settings.salary.fixed.payday} 日后，会把这笔钱加到「
                  {settings.salary.fixed.target.itemName}」；若该月已入账则跳过。
                  {isPaydayReached(settings.salary.fixed.payday) ? '（本月已到发薪日）' : '（本月还没到发薪日）'}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-line pt-4">
        <SwitchRow
          testId="trends-enabled"
          label="在主界面显示走势面板"
          desc="薪资曲线会出现在走势面板里，展示内容可在「走势图」里调整"
          checked={settings.trends.enabled}
          onChange={(v) => onSetTrends({ enabled: v })}
        />
      </div>

      {settings.salary.records.length > 0 ? (
        <div className="border-t border-line pt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="field-label mb-0">历史记录</p>
            <span className="text-[11px] text-ink4">共 {settings.salary.records.length} 个月</span>
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {[...settings.salary.records].reverse().map((rec) => (
              <li key={rec.month} className="flex items-center gap-2 bg-s2 px-3.5 py-2.5">
                <span className="text-[12.5px] text-ink2">{formatMonth(rec.month)}</span>
                <span className="ml-auto text-[12.5px] tabular-nums text-ink1">{formatCNY(rec.amount)}</span>
                <span className={`w-[52px] text-right text-[11px] ${rec.applied ? 'tone-down' : 'text-ink4'}`}>
                  {rec.applied ? '已入账' : '仅记录'}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveSalary(rec.month)}
                  aria-label={`删除 ${rec.month} 记录`}
                  className="shrink-0 rounded-full px-1.5 py-1 text-[11px] text-ink4 transition hover:tone-danger"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <p className="text-[12px] tone-info" data-testid="salary-message">
          {message}
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 三、走势图
 * ------------------------------------------------------------------ */

function TrendsPage({ settings, onSetTrends }: SettingsSheetProps) {
  const t = settings.trends

  const toggleMetric = (m: TrendTab) => {
    const has = t.metrics.includes(m)
    // 至少保留一个指标，否则面板会空着
    if (has && t.metrics.length === 1) return
    const next = has
      ? t.metrics.filter((x) => x !== m)
      : ALL_TREND_TABS.filter((x) => t.metrics.includes(x) || x === m)
    onSetTrends({ metrics: next })
  }

  const dim = t.enabled ? '' : 'pointer-events-none opacity-45'

  return (
    <div className="space-y-5">
      <SwitchRow
        testId="trends-toggle"
        label="在主界面显示走势面板"
        desc="每月第一次打开应用时记录一次（按月聚合，不会拖慢应用）"
        checked={t.enabled}
        onChange={(v) => onSetTrends({ enabled: v })}
      />

      <div className={dim}>
        <p className="field-label">面板里展示哪些（至少选一个）</p>
        <div className="grid grid-cols-2 gap-2">
          {ALL_TREND_TABS.map((m) => {
            const on = t.metrics.includes(m)
            return (
              <button
                key={m}
                type="button"
                data-testid={`trends-metric-${m}`}
                aria-pressed={on}
                onClick={() => toggleMetric(m)}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[12.5px] transition ${
                  on ? 'border-line-strong bg-s3 text-ink1' : 'border-line bg-s2 text-ink4 hover:bg-s3'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    on ? 'border-transparent bg-green text-white' : 'border-line-strong'
                  }`}
                >
                  {on ? <Check size={11} /> : null}
                </span>
                {TREND_TAB_LABEL[m]}
              </button>
            )
          })}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink4">
          只勾选想要的：比如只留「净资产」和「薪资」，面板里就只会出现这两个标签页。
        </p>
      </div>

      <div className={`border-t border-line pt-4 ${dim}`}>
        <p className="field-label">打开时默认时间范围</p>
        <div className="flex gap-1">
          {(Object.keys(TREND_RANGE_LABEL) as TrendRange[]).map((r) => (
            <button
              key={r}
              type="button"
              data-testid={`trends-range-${r}`}
              onClick={() => onSetTrends({ range: r })}
              className={`flex-1 rounded-lg border px-2 py-2 text-[12px] transition ${
                t.range === r ? 'border-line-strong bg-s3 text-ink1' : 'border-line bg-s2 text-ink4 hover:bg-s3'
              }`}
            >
              {TREND_RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <div className={`space-y-2 border-t border-line pt-4 ${dim}`}>
        <p className="field-label">图上显示什么</p>
        <SwitchRow
          testId="trends-show-labels"
          label="显示数值"
          desc="在每个数据点上方标出金额"
          checked={t.showLabels}
          onChange={(v) => onSetTrends({ showLabels: v })}
        />
        <SwitchRow
          testId="trends-show-mom"
          label="显示环比"
          desc="标题下显示「较上期 +3,200（+2.1%）」"
          checked={t.showMom}
          onChange={(v) => onSetTrends({ showMom: v })}
        />
        <SwitchRow
          testId="trends-color-by-trend"
          label="按涨跌着色"
          desc="区间是涨就绿色、跌就红色"
          checked={t.colorByTrend}
          onChange={(v) => onSetTrends({ colorByTrend: v })}
        />
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink4">
          <BarChart3 size={12} className="mt-0.5 shrink-0" />
          「点按数据点看该月明细」和「区间统计」默认开启。
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 四、诊断信息（iOS 独立模式无法真机调试，靠它回报实际数值）
 * ------------------------------------------------------------------ */

function DiagnosticsPage() {
  const [info, setInfo] = useState<Record<string, string | number | boolean>>({})
  const [copied, setCopied] = useState(false)

  const refresh = () => setInfo(collectDiagnostics())

  useEffect(() => {
    refresh()
  }, [])

  const text = Object.entries(info)
    .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? (v ? '是' : '否') : v}`)
    .join('\n')

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-line bg-s2 px-3.5 py-3 text-[11.5px] leading-relaxed text-ink4">
        如果出现「顶部被状态栏遮住」或「顶部留白过宽」，把下面的信息发给我，我就能按你设备的实际数值校准，
        而不用靠猜。
      </p>

      <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line" data-testid="diagnostics">
        {Object.entries(info).map(([k, v]) => (
          <div key={k} className="flex items-start gap-3 bg-s2 px-3.5 py-2.5">
            <dt className="w-[132px] shrink-0 text-[11.5px] text-ink4">{k}</dt>
            <dd className="min-w-0 flex-1 break-all text-[11.5px] tabular-nums text-ink2">
              {typeof v === 'boolean' ? (v ? '是' : '否') : v}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="diagnostics-refresh"
          className="btn-ghost flex-1"
          onClick={() => {
            // 重新实测一次（模拟「下拉一下恢复」后的状态）
            resolveSafeTopInset()
            refresh()
          }}
        >
          重新实测
        </button>
        <button
          type="button"
          data-testid="diagnostics-copy"
          className="btn-primary flex-1"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? '已复制' : '复制信息'}
        </button>
      </div>

      <pre className="overflow-x-auto rounded-xl border border-line bg-s2 p-3 text-[10.5px] leading-relaxed text-ink3">
        {text}
      </pre>
    </div>
  )
}
