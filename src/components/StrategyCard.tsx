import { Suspense, lazy, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Minus,
  Settings2,
  Sparkles,
} from 'lucide-react'
import type { RebalanceResult } from '../types/strategy'
import { HEALTH_META } from '../lib/rebalance'
import { formatCNY, formatSigned } from '../lib/format'

interface StrategyCardProps {
  result: RebalanceResult
  hidden?: boolean
  onOpenSettings: () => void
}

// recharts 体积较大，懒加载以免拖慢首屏
const AllocationChart = lazy(() => import('./AllocationChart'))

/** 图表骨架，加载期间占位避免布局跳动 */
function ChartSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 px-2 py-2" style={{ minHeight: Math.max(96, rows * 46 + 8) }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="h-2.5 w-[62px] shrink-0 rounded-full bg-s3" />
          <span className="h-2.5 flex-1 rounded-full bg-s3" />
        </div>
      ))}
    </div>
  )
}

/**
 * 徽标只反映「这次是否要动手」：
 * - 偏离在阈值内 -> 正常；
 * - 超/低配但既没有可执行金额、也无法手动调整（按阈值内处理）-> 正常。
 * 这样不会出现「标着低配、建议却写无需操作」的自相矛盾。
 */
function stateOf(c: { action: 'buy' | 'sell' | 'hold'; adjustAmount: number; manualAmount: number }) {
  if (c.action === 'hold') return STATE_META.hold
  return Math.abs(c.adjustAmount) < 1 && c.manualAmount < 1 ? STATE_META.hold : STATE_META[c.action]
}

/** 超配 / 低配 / 正常的展示样式 */
const STATE_META = {
  sell: { label: '超配', cls: 'badge-warn', Icon: ArrowUpRight },
  buy: { label: '低配', cls: 'badge-info', Icon: ArrowDownRight },
  hold: { label: '正常', cls: 'badge-good', Icon: Check },
} as const

export default function StrategyCard({ result, hidden, onOpenSettings }: StrategyCardProps) {
  const [expanded, setExpanded] = useState(false)
  const health = HEALTH_META[result.health]
  const hasData = result.totalForAllocation > 0

  /** 图表数据：目标 vs 实际，转成百分数便于直接显示 */
  /** 各类别最终展示的状态计数（与徽标口径一致），用于图例 */
  const activeStates: Partial<Record<'sell' | 'buy' | 'hold', number>> = {}
  for (const c of result.classes) {
    const meta = stateOf(c)
    const key = meta === STATE_META.sell ? 'sell' : meta === STATE_META.buy ? 'buy' : 'hold'
    activeStates[key] = (activeStates[key] ?? 0) + 1
  }

  const chartData = result.classes.map((c) => ({
    classId: c.classId,
    name: c.name,
    color: c.color,
    target: Number((c.targetWeight * 100).toFixed(2)),
    actual: Number((c.actualWeight * 100).toFixed(2)),
  }))

  /**
   * 不可执行缺口：
   * 超配类别「应该卖」的钱和低配类别「应该买」的钱取较大者，减去实际能执行的部分。
   * 之所以会出现缺口，是因为活期存款、房产这类资产没法按比例卖出，
   * 低配只能靠新增投入或后续现金流慢慢补。
   */
  const needSell = result.classes.filter((c) => c.action === 'sell').reduce((s2, c) => s2 + -c.gapAmount, 0)
  const needBuy = result.classes.filter((c) => c.action === 'buy').reduce((s2, c) => s2 + c.gapAmount, 0)
  const exposedGap = Math.max(0, Math.max(needSell, needBuy) - Math.max(result.plannedSell, result.plannedBuy))

  return (
    <section className="card-surface">
      {/* ---------------- 头部 ---------------- */}
      <div className="flex items-start gap-3 border-b border-line px-4 py-3.5">
        <span
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-s3 text-ink2"
          aria-hidden
        >
          <Sparkles size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink1">{result.strategyName}</p>
          <p className="mt-0.5 text-[11.5px] text-ink4">
            总偏离率{' '}
            <span className="font-medium tabular-nums text-ink2">{result.totalDeviationPoints.toFixed(1)}%</span>
            <span className="mx-1.5 text-ink4">·</span>
            阈值 {result.threshold}%
            <span className="mx-1.5 text-ink4">·</span>
            {result.classes.length} 类资产
          </p>
        </div>
        <span className={`${health.badge} shrink-0 px-2 py-1 text-[11px] font-medium`}>
          {result.healthLabel}
        </span>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="策略设置"
          className="-mr-1 shrink-0 rounded-full p-2 text-ink4 transition hover:bg-s3 hover:text-ink2"
        >
          <Settings2 size={16} />
        </button>
      </div>

      {/* ---------------- 目标 vs 实际 对比图 ---------------- */}
      <div className="px-2 pt-3">
        {hasData ? (
          <Suspense fallback={<ChartSkeleton rows={chartData.length} />}>
            <AllocationChart
              data={chartData.map((d, i) => ({ ...d, state: result.classes[i]?.action ?? 'hold' }))}
            />
          </Suspense>
        ) : (
          <p className="px-2 py-6 text-center text-[12px] text-ink4">
            先在卡片里登记资产，才能计算与策略目标的偏离
          </p>
        )}

        {/* 图例 */}
        <div className="flex items-center gap-3 px-2 pb-2 pt-1 text-[10.5px] text-ink4">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-4 rounded-full bg-line-strong/60" /> 目标占比
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-4 rounded-full bg-ink3" /> 实际占比
          </span>
          <span className="ml-auto">粗条颜色表示偏离状态</span>
        </div>
      </div>

      {/* ---------------- 每类资产明细 ---------------- */}
      <div className="border-t border-line px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-[11px] text-ink4">
          <span>目标 vs 实际</span>
          <span>市值 / 偏离</span>
        </div>
        <ul className="space-y-2">
          {result.classes.map((c) => {
            const state = stateOf(c)
            return (
              <li key={c.classId} className="flex items-center gap-2.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                <span className="w-[62px] shrink-0 truncate text-[12.5px] text-ink2">{c.name}</span>

                {/* 占比进度条：灰色为实际，白色刻度为目标 */}
                <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-s3">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${Math.min(100, c.actualWeight * 100)}%`,
                      backgroundColor: state.cls.includes('amber')
                        ? '#fbbf24'
                        : state.cls.includes('sky')
                          ? '#38bdf8'
                          : c.color,
                    }}
                  />
                  <span
                    className="absolute top-[-2px] h-[10px] w-[2px] rounded-full bg-s3"
                    style={{ left: `calc(${Math.min(100, c.targetWeight * 100)}% - 1px)` }}
                    aria-hidden
                  />
                </span>

                <span className="w-[92px] shrink-0 text-right text-[12px] tabular-nums text-ink2">
                  {hidden ? '••••' : formatCNY(c.currentValue, 0)}
                </span>
                <span className={`inline-flex w-[64px] shrink-0 items-center justify-end gap-0.5 text-[11.5px] tabular-nums ${
                  c.action === 'hold' ? 'text-ink4' : c.action === 'sell' ? 'tone-warn' : 'tone-info'
                }`}>
                  {c.action !== 'hold' ? <state.Icon size={11} /> : <Minus size={11} className="opacity-40" />}
                  {formatSigned(c.deviationPoints, 1)}%
                </span>
              </li>
            )
          })}
        </ul>

        {/*
          图例只展示「当前组合真实出现过的状态」，
          否则在全都正常的时候还挂着「超配/低配」两个彩色标签，容易让人误以为有超配。
        */}
        <div data-testid="state-legend" className="mt-3 flex flex-wrap items-center gap-1.5 text-[10.5px]">
          {(['sell', 'buy', 'hold'] as const)
            .filter((k) => { const n = activeStates[k]; return n !== undefined && n > 0 })
            .map((k) => (
              <span key={k} className={STATE_META[k].cls}>
                {STATE_META[k].label} {activeStates[k]}
              </span>
            ))}
          <span className="text-ink4">| 偏离超过 ±{result.threshold}% 才会建议操作</span>
        </div>
      </div>

      {/* ---------------- 展开：具体加减仓金额 ---------------- */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between border-t border-line px-4 py-3 text-[12.5px] text-ink2 transition hover:bg-s2"
      >
        <span className="inline-flex items-center gap-1.5">
          <Sparkles size={13} className="text-ink4" />
          {expanded ? '收起再平衡建议' : '查看再平衡建议'}
        </span>
        <ChevronDown size={15} className={`text-ink4 transition ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-line px-4 py-3.5">
          <p className="text-[11.5px] leading-relaxed text-ink4">{result.healthHint}</p>

          {/* 汇总 */}
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-line bg-s2 px-3 py-2.5 text-center">
            <Summary label="需卖出" value={hidden ? '••••' : formatCNY(result.plannedSell, 0)} tone="tone-warn" />
            <Summary label="需买入" value={hidden ? '••••' : formatCNY(result.plannedBuy, 0)} tone="tone-info" />
            <Summary
              label="可动用"
              value={hidden ? '••••' : formatCNY(result.sellCapacity, 0)}
              tone="text-ink2"
            />
          </div>

          {/* 逐类建议 */}
          <ul className="space-y-2.5">
            {result.classes.map((c) => {
              const state = stateOf(c)
              const hasPlan = c.action !== 'hold'
              const executable = Math.abs(c.adjustAmount) >= 1
              // 超配但卖不动（如活期存款）：给出手动调整金额
              const manualSell = hasPlan && !executable ? c.manualAmount : 0
              return (
                <li
                  key={c.classId}
                  data-testid={`class-detail-${c.classId}`}
                  className="rounded-xl border border-line bg-s2 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
                    <span className="flex-1 truncate text-[13px] text-ink2">{c.name}</span>
                    <span className={state.cls}>{state.label}</span>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
                    <Row label="当前市值" value={hidden ? '••••' : `${formatCNY(c.currentValue, 0)} 元`} />
                    <Row label="目标市值" value={hidden ? '••••' : `${formatCNY(c.targetValue, 0)} 元`} />
                    <Row label="理论缺口" value={hidden ? '••••' : `${formatSigned(c.gapAmount, 0)} 元`} />
                    <Row
                      label="建议操作"
                      value={
                        executable
                          ? `${c.adjustAmount > 0 ? '买入' : '卖出'} ${formatCNY(Math.abs(c.adjustAmount), 0)} 元`
                          : manualSell > 0
                            ? `手动减仓 ${formatCNY(manualSell, 0)} 元`
                            : '无需操作'
                      }
                      tone={
                        !hasPlan ? 'text-ink4' : c.action === 'buy' ? 'tone-info' : 'tone-warn'
                      }
                    />
                  </div>

                  {/* 减仓明细 */}
                  {c.sellCandidates.length > 0 && executable && c.adjustAmount < 0 ? (
                    <ul className="mt-2 space-y-1 border-t border-line pt-2">
                      {c.sellCandidates.map((s) => (
                        <li key={s.itemId} className="flex items-center gap-2 text-[11px]">
                          <span className="min-w-0 flex-1 truncate text-ink3">
                            {s.name}
                            {s.code ? <span className="ml-1 text-ink4">{s.code}</span> : null}
                          </span>
                          {s.realizedProfit !== undefined ? (
                            <span className={`tabular-nums ${s.realizedProfit >= 0 ? 'text-up/80' : 'text-down/80'}`}>
                              {formatSigned(s.realizedProfit, 0)}
                            </span>
                          ) : null}
                          <span className="w-[76px] text-right tabular-nums tone-warn/90">
                            卖 {hidden ? '•••' : formatCNY(s.sellAmount, 0)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              )
            })}
          </ul>

          {/* 提示 */}
          {exposedGap > 1 ? (
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed tone-warn/90">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              有 {formatCNY(exposedGap, 0)} 元的缺口无法靠卖出自动完成（活期存款、房产等无法按比例卖出），
              需要手动减仓或追加投入才能完全对齐目标。
            </p>
          ) : null}
          {result.unclassifiedItemCount > 0 ? (
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink4">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              有 {result.unclassifiedItemCount} 只基金无法从名称识别类型（已按分类默认映射处理）。在基金详情里可手动标记为股票型 / 债券型。
            </p>
          ) : null}
          {result.unmappedCategories.length > 0 ? (
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink4">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              未映射分类：{result.unmappedCategories.map((c) => c.name).join('、')}
              {result.unmappedCategories.length > 0 ? '（已在设置里按默认规则兜底）' : ''}
            </p>
          ) : null}
          {result.liabilityDeducted > 0 ? (
            <p className="text-[11px] text-ink4">
              占比按「可投资资产」计算，已扣除负债 {formatCNY(result.liabilityDeducted, 0)} 元。
            </p>
          ) : null}

          <button type="button" className="btn-ghost w-full" onClick={onOpenSettings}>
            <Settings2 size={14} /> 调整策略与映射
          </button>
        </div>
      ) : null}
    </section>
  )
}

function Summary({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <p className="text-[10.5px] text-ink4">{label}</p>
      <p className={`mt-0.5 text-[13px] font-medium tabular-nums ${tone}`}>{value}</p>
    </div>
  )
}

function Row({ label, value, tone = 'text-ink2' }: { label: string; value: string; tone?: string }) {
  return (
    <span className="flex items-center justify-between gap-2">
      <span className="text-ink4">{label}</span>
      <span className={`tabular-nums ${tone}`}>{value}</span>
    </span>
  )
}
