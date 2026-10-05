import { ChevronRight, CreditCard, TrendingDown, TrendingUp } from 'lucide-react'
import type { Category } from '../types/asset'
import type { FxRates } from '../lib/currency'
import { categoryCountLabel, categoryTotal, isFund, valuate } from '../lib/calc'
import { formatCNY, formatRate } from '../lib/format'
import { resolveIcon } from '../lib/icons'

interface CategoryCardProps {
  category: Category
  hidden?: boolean
  /** 汇率：外币条目折算用 */
  rates?: FxRates | null
  onOpen: (category: Category) => void
}

/**
 * 资产分类卡片：左侧彩色半透明图标 + 名称 + 副标题，右侧金额 + 项数标签。
 * 基金分类额外展示持仓盈亏（红涨绿跌）。
 */
export default function CategoryCard({ category, hidden, rates, onOpen }: CategoryCardProps) {
  const Icon = resolveIcon(category.icon)
  const total = categoryTotal(category, rates)
  const count = categoryCountLabel(category)

  // 基金分类的持仓盈亏合计
  const fundStats = category.items.filter(isFund).reduce(
    (acc, item) => {
      const v = valuate(item, rates)
      return { profit: acc.profit + (v.profit ?? 0), cost: acc.cost + (v.cost ?? 0) }
    },
    { profit: 0, cost: 0 },
  )

  /**
   * 外币敞口：卡片上补一行「含外币 ¥xxx」，并在汇率缺失时明确提示。
   * 基金/持仓类条目也要算进来 —— 美股按 USD、港股按 HKD，属于外币资产。
   */
  const foreign = category.items.reduce(
    (acc, item) => {
      const v = valuate(item, rates)
      if (v.currency === 'CNY') return acc
      acc.count += 1
      acc.cny += v.value
      if (v.missingRate) acc.missing = true
      return acc
    },
    { count: 0, cny: 0, missing: false },
  )
  const hasFunds = category.items.some(isFund)
  const profitRate = fundStats.cost > 0 ? fundStats.profit / fundStats.cost : 0
  const display = category.isLiability ? -Math.abs(total) : total

  return (
    <button
      type="button"
      onClick={() => onOpen(category)}
      className="card-surface group block w-full px-4 py-3.5 text-left transition duration-200 hover:border-line-strong active:scale-[0.985]"
    >
      {/* 分类主题色的极淡径向光晕，保持暗黑质感的同时呼应图标颜色 */}
      <span
        aria-hidden
        className="pointer-events-none absolute -left-8 -top-10 h-28 w-28 rounded-full opacity-[0.14] blur-2xl"
        style={{ background: category.color }}
      />

      <div className="relative flex items-center gap-3.5">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px]"
          style={{
            backgroundColor: category.colorName
              ? `var(--accent-${category.colorName}-soft)`
              : 'var(--s2)',
            color: category.color,
          }}
        >
          <Icon size={20} strokeWidth={2} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-ink1">{category.name}</p>
          <p className="mt-0.5 truncate text-[12px] text-ink4">{category.subtitle || '—'}</p>
        </div>

        <div className="flex shrink-0 flex-col items-end">
          <span className="text-[16px] font-semibold tabular-nums text-ink1">
            {hidden ? '••••' : formatCNY(display)}
          </span>
          <span className="mt-1 inline-flex items-center gap-1.5">
            {category.isLiability ? <CreditCard size={11} className="tone-danger/70" /> : null}
            <span className="chip">{count}</span>
          </span>
          {foreign.count > 0 && !hidden ? (
            <span className="mt-1 text-[10.5px] text-ink4">
              {foreign.missing ? '含外币（汇率不可用）' : `含外币 ¥${formatCNY(foreign.cny, 0)}`}
            </span>
          ) : null}
        </div>

        <ChevronRight size={16} className="shrink-0 text-ink4 transition group-hover:text-ink4" />
      </div>

      {hasFunds ? (
        <div className="relative mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5 text-[11.5px]">
          {hidden ? (
            <span className="text-ink4">持仓盈亏已隐藏</span>
          ) : (
            <>
              <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${fundStats.profit >= 0 ? 'text-up' : 'text-down'}`}>
                {fundStats.profit >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {fundStats.profit >= 0 ? '+' : '-'}
                {formatCNY(Math.abs(fundStats.profit))}
              </span>
              <span className={fundStats.profit >= 0 ? 'text-up/80' : 'text-down/80'}>{formatRate(profitRate)}</span>
              <span className="text-ink4">持仓盈亏</span>
            </>
          )}
        </div>
      ) : null}
    </button>
  )
}
