import { currencyMeta, isCurrencyCode } from './currency'

/** 展示层数字格式化工具，全部为纯函数，便于单测 */

/** 千分位 + 指定小数位 */
export function formatNumber(value: number, digits = 2): string {
  const v = Number.isFinite(value) ? value : 0
  return v.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** 大额自动折算成「万」，用于顶部大字号金额 */
export function formatCompactCNY(value: number): string {
  const v = Number.isFinite(value) ? value : 0
  const abs = Math.abs(v)
  if (abs >= 100_000_000) return `${formatNumber(v / 100_000_000, 2)}亿`
  if (abs >= 10_000) return `${formatNumber(v / 10_000, 2)}万`
  return formatNumber(v, 2)
}

/** 主金额展示（元，千分位） */
export function formatCNY(value: number, digits = 2): string {
  return formatNumber(value, digits)
}

/** 带符号金额，如 +1,204.55 / -320.00 */
export function formatSigned(value: number, digits = 2): string {
  const v = Number.isFinite(value) ? value : 0
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  return `${sign}${formatNumber(Math.abs(v), digits)}`
}

/** 百分比，输入为小数：0.0212 -> +2.12% */
export function formatRate(rate: number | undefined, digits = 2): string {
  if (rate === undefined || !Number.isFinite(rate)) return '--'
  const pct = rate * 100
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : ''
  return `${sign}${Math.abs(pct).toFixed(digits)}%`
}

/** 净值 / 单价，保留 4 位小数并去掉多余 0 */
export function formatNav(nav: number | undefined): string {
  if (nav === undefined || !Number.isFinite(nav)) return '--'
  return nav.toFixed(4).replace(/\.?0+$/, '')
}

/** 份额 / 克数等数量 */
export function formatQty(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '')
}

const pad = (n: number) => String(n).padStart(2, '0')

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return formatDateTime(ts)
}

/** YYYY-MM-DD（本地时区，避免 toISOString 的 UTC 偏移） */
export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 涨跌配色：A 股习惯 —— 红涨绿跌 */
export function toneClass(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value === 0) return 'text-zinc-400'
  return value > 0 ? 'text-up' : 'text-down'
}

/* ------------------------------------------------------------------ *
 * 多币种展示
 * ------------------------------------------------------------------ */

export interface MoneyDisplay {
  /** 主显示：原币金额（人民币条目就是人民币金额） */
  primary: string
  /** 副显示：外币条目的折算人民币，人民币条目为 null */
  secondary: string | null
  /** 是否是外币条目 */
  isForeign: boolean
}

/**
 * 统一的金额展示：
 * - 人民币条目：主显示就是千分位金额，没有副行；
 * - 外币条目：主显示带币种符号的原币金额，副行显示折算后的人民币。
 *
 * 传入的 cnyValue 已经是折算结果；若 missingRate 为 true，说明汇率缺失，
 * 此时副行给出明确提示而不是显示一个错误的数字。
 */
export function moneyDisplay(
  valueInCurrency: number,
  currency: string,
  cnyValue: number,
  missingRate: boolean,
): MoneyDisplay {
  if (currency === 'CNY') {
    return { primary: formatNumber(valueInCurrency, 2), secondary: null, isForeign: false }
  }
  const meta = isCurrencyCode(currency) ? currencyMeta(currency) : null
  const decimals = meta?.decimals ?? 2
  const symbol = meta?.symbol ?? ''
  return {
    primary: `${symbol}${formatNumber(valueInCurrency, decimals)}`,
    secondary: missingRate ? '汇率不可用' : `≈ ¥${formatNumber(cnyValue, 2)}`,
    isForeign: true,
  }
}
