import { useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { TrendingDown, TrendingUp } from 'lucide-react'
import {
  type NetWorthPoint,
  type TrendMetric,
  type TrendRange,
  TREND_RANGE_LABEL,
  longMonth,
  shortMonth,
  sliceByRange,
} from '../lib/netWorthHistory'
import type { SalaryRecord } from '../lib/settings'
import { formatCNY, formatRate } from '../lib/format'

export type TrendTab = TrendMetric | 'salary'

const TAB_LABEL: Record<TrendTab, string> = {
  netWorth: '净资产',
  assets: '总资产',
  liabilities: '负债',
  salary: '薪资',
}

interface TrendsPanelProps {
  points: NetWorthPoint[]
  salaryRecords: SalaryRecord[]
  /** 展示哪些标签页（在设置里选，卡片内不再选） */
  metrics: TrendTab[]
  /** 打开时的默认时间范围 */
  defaultRange?: TrendRange
  /** 是否在点上显示数值 */
  showLabels?: boolean
  /** 是否显示环比 */
  showMom?: boolean
  /** 是否按涨跌着色 */
  colorByTrend?: boolean
}

/** 统一的图内数据形状 */
interface ChartRow {
  label: string
  value: number
  month?: string
}

export default function TrendsPanel({
  points,
  salaryRecords,
  metrics,
  defaultRange = '1y',
  showLabels = true,
  showMom = true,
  colorByTrend = true,
}: TrendsPanelProps) {
  /** 只展示设置里勾选的指标；设置变更时自动回落到第一个可用项 */
  const visible = metrics.length > 0 ? metrics : (['netWorth'] as TrendTab[])
  const [tab, setTab] = useState<TrendTab>(visible[0])
  const [range, setRange] = useState<TrendRange>(defaultRange)
  const [active, setActive] = useState<ChartRow | null>(null)

  const currentTab = visible.includes(tab) ? tab : visible[0]
  const isSalary = currentTab === 'salary'

  const rows: ChartRow[] = useMemo(() => {
    if (isSalary) {
      // 薪资不补月份：只画真实填过的月份
      const sorted = [...salaryRecords].sort((a, b) => a.month.localeCompare(b.month))
      const sliced = range === 'all' ? sorted : sorted.slice(-rangeMonths(range))
      return sliced.map((r) => ({ label: shortMonth(r.month), value: r.amount, month: r.month }))
    }
    const metric = currentTab as TrendMetric
    const sliced = sliceByRange(points, range)
    return sliced.map((p) => ({ label: shortMonth(p.month), value: p[metric], month: p.month }))
  }, [isSalary, salaryRecords, points, range, currentTab])

  const stats = useMemo(() => {
    if (rows.length < 2) return null
    const first = rows[0].value
    const last = rows[rows.length - 1].value
    const delta = last - first
    const rate = first !== 0 ? delta / Math.abs(first) : 0
    const momDelta = rows.length >= 2 ? last - rows[rows.length - 2].value : 0
    const prev = rows[rows.length - 2]?.value ?? 0
    const values = rows.map((r) => r.value)
    return {
      delta,
      rate,
      momDelta,
      momRate: prev !== 0 ? momDelta / Math.abs(prev) : 0,
      max: Math.max(...values),
      min: Math.min(...values),
    }
  }, [rows])

  // 点数少时用清晰度更高的面积图，点数多时用柱状更易读
  const useBar = rows.length <= 4
  const rising = (stats?.delta ?? 0) >= 0
  // 关闭「按涨跌着色」时用中性色，避免颜色误导
  const lineColor = colorByTrend ? (rising ? 'var(--up)' : 'var(--down)') : 'var(--chart-tick)'

  const viewPoint = useMemo(() => {
    if (!active?.month) return null
    return points.find((p) => p.month === active.month) ?? null
  }, [active, points])

  return (
    <section className="card-surface px-4 py-3.5" data-testid="trends-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink1">走势</p>
          {stats && showMom ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink4">
              <span>较上期</span>
              <span className={`tabular-nums ${stats.momDelta >= 0 ? 'tone-up' : 'tone-down'}`}>
                {stats.momDelta >= 0 ? '+' : '−'}
                {formatCNY(Math.abs(stats.momDelta), 0)}
              </span>
              <span className={stats.momDelta >= 0 ? 'tone-up' : 'tone-down'}>
                ({formatRate(stats.momRate)})
              </span>
              <span>· {TREND_RANGE_LABEL[range]}</span>
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-ink4">
              {stats ? `${TREND_RANGE_LABEL[range]}` : isSalary ? '先在设置里记录每月薪资' : '再积累一个月就能看到变化'}
            </p>
          )}
        </div>
        {stats ? (
          <span
            className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] tabular-nums ${
              rising ? 'tone-up' : 'tone-down'
            }`}
            style={{ borderColor: 'currentColor' }}
          >
            {rising ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {formatRate(stats.rate)}
          </span>
        ) : null}
      </div>

      {/* 指标切换 */}
      <div className="mt-3 flex gap-1 overflow-x-auto rounded-xl border border-line bg-s2 p-1">
        {visible.map((key) => (
          <button
            key={key}
            type="button"
            data-testid={`trend-tab-${key}`}
            onClick={() => {
              setTab(key)
              setActive(null)
            }}
            className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] transition ${
              currentTab === key ? 'bg-invert text-on-invert' : 'text-ink3 hover:text-ink1'
            }`}
          >
            {TAB_LABEL[key]}
          </button>
        ))}
      </div>

      {/* 时间范围 */}
      <div className="mt-2 flex items-center gap-1">
        {(Object.keys(TREND_RANGE_LABEL) as TrendRange[]).map((key) => (
          <button
            key={key}
            type="button"
            data-testid={`trend-range-${key}`}
            onClick={() => setRange(key)}
            className={`rounded-full px-2.5 py-1 text-[11px] transition ${
              range === key ? 'bg-s3 text-ink1' : 'text-ink4 hover:text-ink2'
            }`}
          >
            {TREND_RANGE_LABEL[key]}
          </button>
        ))}
      </div>

      {/* 图表 */}
      <div className="mt-2" style={{ height: 168 }}>
        {rows.length === 0 ? (
          <p className="flex h-full items-center justify-center text-center text-[12px] leading-relaxed text-ink4">
            {isSalary
              ? '还没有薪资记录\n到设置 → 薪资里填一条试试'
              : '还没有历史数据\n每月第一次打开应用时会记录一次'}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {useBar ? (
              <BarChart data={rows} margin={{ top: 18, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: 'var(--chart-tick)', fontSize: 10 }} />
                <YAxis hide domain={['dataMin', 'auto']} />
                <Tooltip content={() => null} cursor={{ fill: 'var(--chart-grid)' }} />
                <Bar
                  dataKey="value"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                  onClick={(_, i) => setActive(rows[i] ?? null)}
                >
                  {rows.map((_, i) => (
                    <Cell
                      key={i}
                      fill={colorByTrend ? (rising ? 'var(--up)' : 'var(--down)') : 'var(--chart-tick)'}
                      opacity={active && active.label !== rows[i].label ? 0.5 : 1}
                    />
                  ))}
                  {showLabels ? (
                    <LabelList
                      dataKey="value"
                      position="top"
                      formatter={(v: number) => formatCNY(v, 0)}
                      style={{ fill: 'var(--ink3)', fontSize: 9 }}
                    />
                  ) : null}
                </Bar>
              </BarChart>
            ) : (
              <AreaChart data={rows} margin={{ top: 18, right: 10, bottom: 0, left: 10 }}>
                <defs>
                  <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'var(--chart-tick)', fontSize: 10 }}
                  interval="preserveStartEnd"
                />
                <YAxis hide domain={['dataMin - 1', 'auto']} />
                <Tooltip content={() => null} cursor={{ stroke: 'var(--chart-grid)' }} />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={lineColor}
                  strokeWidth={2}
                  fill="url(#trendFill)"
                  isAnimationActive={false}
                  dot={(props: { cx?: number; cy?: number; index?: number }) => {
                    const i = props.index ?? 0
                    const on = active?.month && rows[i]?.month === active.month
                    return (
                      <circle
                        key={i}
                        cx={props.cx}
                        cy={props.cy}
                        r={on ? 4 : 2.5}
                        fill={lineColor}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setActive(rows[i] ?? null)}
                      />
                    )
                  }}
                  activeDot={false}
                />
                {showLabels ? (
                  <LabelList
                    dataKey="value"
                    position="top"
                    formatter={(v: number) => formatCNY(v, 0)}
                    style={{ fill: 'var(--ink3)', fontSize: 9 }}
                  />
                ) : null}
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {/* 点按后的该月明细 */}
      {active ? (
        <div className="mt-2 rounded-xl border border-line bg-s2 px-3.5 py-2.5" data-testid="trend-detail">
          <div className="flex items-center justify-between">
            <p className="text-[12.5px] font-medium text-ink1">
              {active.month ? longMonth(active.month) : active.label}
              {isSalary ? ' 薪资' : ''}
            </p>
            <button
              type="button"
              onClick={() => setActive(null)}
              className="text-[11px] text-ink4 hover:text-ink2"
            >
              收起
            </button>
          </div>
          {viewPoint ? (
            <dl className="mt-1.5 grid grid-cols-3 gap-2">
              {(
                [
                  ['总资产', viewPoint.assets],
                  ['负债', viewPoint.liabilities],
                  ['净资产', viewPoint.netWorth],
                ] as Array<[string, number]>
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[10.5px] text-ink4">{label}</dt>
                  <dd className="mt-0.5 text-[12.5px] tabular-nums text-ink2">{formatCNY(value, 0)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-1 text-[12.5px] tabular-nums text-ink2">{formatCNY(active.value, 0)} 元</p>
          )}
        </div>
      ) : null}

      {/* 区间统计 */}
      {stats && rows.length >= 2 ? (
        <p className="mt-2 border-t border-line pt-2 text-[11px] text-ink4" data-testid="trend-stats">
          区间 {stats.delta >= 0 ? '+' : '−'}
          {formatCNY(Math.abs(stats.delta), 0)}（{formatRate(stats.rate)}）· 最高{' '}
          {formatCNY(stats.max, 0)} · 最低 {formatCNY(stats.min, 0)}
        </p>
      ) : null}
    </section>
  )
}

function rangeMonths(range: TrendRange): number {
  switch (range) {
    case '6m':
      return 6
    case '1y':
      return 12
    case '3y':
      return 36
    default:
      return Number.MAX_SAFE_INTEGER
  }
}

/** 供测试与调试：把图内数据算出来（不渲染） */
export function buildTrendRows(
  points: NetWorthPoint[],
  metric: TrendMetric,
  range: TrendRange,
): ChartRow[] {
  return sliceByRange(points, range).map((p) => ({
    label: shortMonth(p.month),
    value: p[metric],
    month: p.month,
  }))
}

