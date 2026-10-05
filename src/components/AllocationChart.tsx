import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'

export interface AllocationChartDatum {
  classId: string
  name: string
  color: string
  target: number
  actual: number
  /** 偏离状态，用于给实际占比的柱子上色 */
  state: 'buy' | 'sell' | 'hold'
}

/**
 * 目标 vs 实际 占比对比图。
 * 单独成文件是为了用 React.lazy 懒加载 —— recharts 体积不小（约 400KB），
 * 首屏只加载「资产卡包」主体，图表在进入页面后再拉取，避免拖慢首屏。
 */
export default function AllocationChart({ data }: { data: AllocationChartDatum[] }) {
  // 实际占比可能远超 100%（例如全部现金），若不强收敛，柱子会被画到图表外面
  const CHART_MAX = 100
  const clamp = (v: number) => Math.max(0, Math.min(CHART_MAX, v))
  // 目标占比天然 ≤100，实际占比可能超出（例如全部是现金），统一收敛后再画
  const clamped = data.map((d) => ({ ...d, target: clamp(d.target), actual: clamp(d.actual) }))
  return (
    <div style={{ height: Math.max(96, data.length * 46 + 8) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={clamped} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 4 }} barGap={2}>
          <XAxis type="number" hide domain={[0, CHART_MAX]} />
          <YAxis
            type="category"
            dataKey="name"
            width={74}
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'var(--chart-tick)', fontSize: 11 }}
          />
          <ReferenceLine x={0} stroke="var(--chart-grid)" />
          {/* 目标占比：细条 + 主题色半透明 */}
          <Bar dataKey="target" name="目标" barSize={6} radius={[0, 3, 3, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={`t-${d.classId}`} fill={d.color} fillOpacity={0.55} />
            ))}
            <LabelList
              dataKey="target"
              position="right"
              offset={6}
              formatter={(v: number) => `${v}%`}
              style={{ fill: 'var(--chart-label)', fontSize: 10 }}
            />
          </Bar>
          {/* 实际占比：粗条 + 按偏离状态着色 */}
          <Bar dataKey="actual" name="实际" barSize={11} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell
                key={`a-${d.classId}`}
                // 超过 100% 的部分截断显示，避免柱子溢出绘图区
                fill={d.state === 'sell' ? 'var(--warn)' : d.state === 'buy' ? 'var(--info)' : d.color}
              />
            ))}
            <LabelList
              dataKey="actual"
              position="right"
              offset={6}
              formatter={(v: number) => `${v}%`}
              style={{ fill: 'var(--ink1)', fontSize: 10, fontWeight: 500 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
