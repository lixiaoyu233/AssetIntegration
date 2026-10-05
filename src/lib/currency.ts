/**
 * 币种基础模块（纯函数，无副作用，便于单测）
 *
 * 约定：
 * - 条目金额默认以「原币」存储，展示与汇总时按汇率折算成人民币；
 * - 汇率统一用 `perCny`（1 人民币 = ? 该币种）存储，与 open.er-api 的返回口径一致；
 *   折算时用除法：CNY = 原币金额 / perCny。
 */

export const CURRENCY_STORAGE_KEY = 'asset-card-wallet/fx'

/** 支持的币种（按常用度排序，人民币置首） */
export const CURRENCIES = [
  { code: 'CNY', label: '人民币', symbol: '¥', decimals: 2 },
  { code: 'USD', label: '美元', symbol: '$', decimals: 2 },
  { code: 'HKD', label: '港币', symbol: 'HK$', decimals: 2 },
  { code: 'SGD', label: '新加坡元', symbol: 'S$', decimals: 2 },
  // 日元面额小：1 日元≈0.043 元，若按 2 位小数显示会有大量 0，故原币保留 4 位
  { code: 'JPY', label: '日元', symbol: '¥', decimals: 4 },
  { code: 'EUR', label: '欧元', symbol: '€', decimals: 2 },
  { code: 'GBP', label: '英镑', symbol: '£', decimals: 2 },
  { code: 'AUD', label: '澳元', symbol: 'A$', decimals: 2 },
  { code: 'KRW', label: '韩元', symbol: '₩', decimals: 2 },
  { code: 'TWD', label: '新台币', symbol: 'NT$', decimals: 2 },
  { code: 'CAD', label: '加元', symbol: 'C$', decimals: 2 },
] as const

export type CurrencyCode = (typeof CURRENCIES)[number]['code']

export const CURRENCY_CODES: CurrencyCode[] = CURRENCIES.map((c) => c.code)

export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return typeof v === 'string' && CURRENCIES.some((c) => c.code === v)
}

export function currencyMeta(code: CurrencyCode) {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0]
}

/** 原币金额的小数位（日元等小面额币种需要更多位） */
export function currencyDecimals(code: CurrencyCode): number {
  return currencyMeta(code).decimals
}

/** 币种符号，如 ¥ / $ / HK$ */
export function currencySymbol(code: CurrencyCode): string {
  return currencyMeta(code).symbol
}

/* ------------------------------------------------------------------ *
 * 金额量级提示（千 / 万 / 十万 / 百万 / 千万）
 * ------------------------------------------------------------------ */

export interface ScaleHint {
  /** 展示文案，如「万」；金额太小时为「元」 */
  label: string
  /** 该量级对应的数值，便于测试与高亮判断 */
  threshold: number
}

const SCALE_STEPS: ScaleHint[] = [
  { label: '千万', threshold: 10_000_000 },
  { label: '百万', threshold: 1_000_000 },
  { label: '十万', threshold: 100_000 },
  { label: '万', threshold: 10_000 },
  { label: '千', threshold: 1_000 },
  { label: '元', threshold: 0 },
]

/**
 * 判断当前输入的金额处在哪个量级。
 * 用于数字键盘与输入框上方的提示：让用户一眼知道「最大那位是万还是十万」。
 */
export function scaleHint(amount: number): ScaleHint {
  const abs = Math.abs(Number.isFinite(amount) ? amount : 0)
  return SCALE_STEPS.find((s) => abs >= s.threshold) ?? SCALE_STEPS[SCALE_STEPS.length - 1]
}

/** 输入框/键盘上方显示的完整提示，如「万位 · 12,345」 */
export function scaleHintText(amount: number): string {
  const hint = scaleHint(amount)
  return hint.label === '元' ? '不足千元' : `${hint.label}位`
}

/* ------------------------------------------------------------------ *
 * 汇率
 * ------------------------------------------------------------------ */

/** 1 人民币 = ? 各币种 */
export interface FxRates {
  /** 币种代码 -> perCny 汇率 */
  perCny: Partial<Record<CurrencyCode, number>>
  /** 数据时间戳（毫秒） */
  fetchedAt: number
  /** 数据来源标识，便于排查 */
  source: string
  /** 接口自带的更新日期（若有） */
  updatedAt?: string
}

const round = (n: number, digits: number) => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/**
 * 原币金额 -> 人民币。
 * 汇率为 0 / 缺失 / 非法时返回 undefined，由调用方决定回退策略（不要静默当成 0）。
 */
export function toCny(amount: number, code: CurrencyCode, rates?: FxRates | null): number | undefined {
  if (!Number.isFinite(amount)) return undefined
  if (code === 'CNY') return amount
  const rate = rates?.perCny?.[code]
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return undefined
  return amount / rate
}

/** 人民币 -> 原币（手动填汇率等场景反向使用） */
export function fromCny(amountCny: number, code: CurrencyCode, rates?: FxRates | null): number | undefined {
  if (!Number.isFinite(amountCny)) return undefined
  if (code === 'CNY') return amountCny
  const rate = rates?.perCny?.[code]
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return undefined
  return amountCny * rate
}

/** 汇率是否过期（默认 24 小时） */
export const FX_STALE_MS = 24 * 60 * 60 * 1000

export function isFxStale(rates: FxRates | null | undefined, now = Date.now()): boolean {
  if (!rates || !rates.fetchedAt) return true
  return now - rates.fetchedAt > FX_STALE_MS
}

/**
 * 汇率缓存是否可用。
 *
 * 注意：只含 `CNY: 1` 的兜底对象**不算可用** —— 它折算了任何外币，
 * 若判为可用会导致「有外币但永不联网拉汇率」。
 */
export function hasUsableRates(rates: FxRates | null | undefined): boolean {
  if (!rates) return false
  return Object.entries(rates.perCny).some(
    ([code, v]) => code !== 'CNY' && typeof v === 'number' && Number.isFinite(v) && v > 0,
  )
}

/* ------------------------------------------------------------------ *
 * 展示
 * ------------------------------------------------------------------ */

/** 带千分位的原币金额，按币种决定小数位 */
export function formatCurrencyAmount(amount: number, code: CurrencyCode): string {
  const v = Number.isFinite(amount) ? amount : 0
  return v.toLocaleString('zh-CN', {
    minimumFractionDigits: currencyDecimals(code),
    maximumFractionDigits: currencyDecimals(code),
  })
}

/** 带符号的原币金额，如 `$1,200.00` */
export function formatCurrencyWithSymbol(amount: number, code: CurrencyCode): string {
  const meta = currencyMeta(code)
  return `${meta.symbol}${formatCurrencyAmount(amount, code)}`
}

/** 汇率来源说明，如「汇率更新于 2026-10-03」 */
export function describeRates(rates: FxRates | null | undefined): string {
  if (!rates) return '暂无汇率'
  const d = new Date(rates.fetchedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 四舍五入到指定精度（用于展示层统一处理） */
export function roundTo(n: number, digits = 2): number {
  return round(n, digits)
}
