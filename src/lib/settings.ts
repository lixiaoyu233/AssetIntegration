/**
 * 应用设置：基金申购的资金来源规则 + 薪资记录
 *
 * 两类内容放在一起，因为都属于「一次性配置、长期生效」的东西，
 * 与资产数据分开存放（localStorage 独立键），互不污染。
 */

import type { Portfolio } from '../types/asset'
import type { TrendRange, TrendTab } from './netWorthHistory'

export const SETTINGS_STORAGE_KEY = 'asset-card-wallet/settings/v1'

/** 资金划拨来源：从某个现金/固资项目扣款买入基金 */
export interface FundingSource {
  /** 目标分类 id（通常是「现金与固定资产」里的某个条目所在分类） */
  categoryId: string
  /** 目标条目 id（金额类项目） */
  itemId: string
  /** 该项目的展示名，便于在基金条目上回显 */
  itemName: string
}

/** 走势可选指标 */

/** 基金/股票申购默认设置 */
export interface FundDefaults {
  /** 默认是否启用「从现有项目划拨」 */
  useFunding: boolean
  /** 上次选择的划拨来源，下次自动带出 */
  lastFundingSource?: FundingSource
}

/** 一条薪资记录 */
export interface SalaryRecord {
  /** 年月，格式 YYYY-MM */
  month: string
  amount: number
  /** 录入时间戳 */
  at: number
  /** 是否已经写入到现金项（避免重复入账） */
  applied?: boolean
  /** 写入时间 */
  appliedAt?: number
}

/** 固定薪资配置 */
export interface FixedSalary {
  enabled: boolean
  amount: number
  /** 每月发薪日 1~28（避开月末差异） */
  payday: number
  /** 发薪后写入哪个项目 */
  target?: FundingSource
}

/** 走势面板外观配置 */
export interface TrendsConfig {
  /** 是否在首页显示走势面板 */
  enabled: boolean
  /** 面板里展示哪几个标签页（至少保留一个） */
  metrics: TrendTab[]
  /** 打开时的默认时间范围 */
  range: TrendRange
  /** 是否在点上显示数值 */
  showLabels: boolean
  /** 是否显示环比 */
  showMom: boolean
  /** 是否按涨跌着色 */
  colorByTrend: boolean
}

export interface AppSettings {
  version: number
  fund: FundDefaults
  /** 走势面板配置（在设置里选指标，卡片内不再选） */
  trends: TrendsConfig
  salary: {
    /** 按月存档的薪资记录 */
    records: SalaryRecord[]
    fixed: FixedSalary
  }
}

export function createDefaultSettings(): AppSettings {
  return {
    version: 1,
    trends: {
      enabled: false,
      metrics: ['netWorth'],
      range: '1y',
      showLabels: true,
      showMom: true,
      colorByTrend: true,
    },
    fund: { useFunding: false },
    salary: {
      records: [],
      fixed: { enabled: false, amount: 0, payday: 10 },
    },
  }
}

/* ------------------------------------------------------------------ *
 * 时间工具
 * ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0')

/** 当前年月，YYYY-MM */
export function currentMonth(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** 「2026-10」→「2026年10月」 */
export function formatMonth(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/)
  return m ? `${m[1]}年${Number(m[2])}月` : month
}

/** 当月是否已到发薪日（含） */
export function isPaydayReached(payday: number, d = new Date()): boolean {
  return d.getDate() >= Math.min(28, Math.max(1, payday))
}

/* ------------------------------------------------------------------ *
 * 规范化
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normalizeSource(raw: unknown): FundingSource | undefined {
  if (!isRecord(raw)) return undefined
  const categoryId = typeof raw.categoryId === 'string' ? raw.categoryId : ''
  const itemId = typeof raw.itemId === 'string' ? raw.itemId : ''
  if (!categoryId || !itemId) return undefined
  return {
    categoryId,
    itemId,
    itemName: typeof raw.itemName === 'string' ? raw.itemName : '现金项目',
  }
}

const ALL_METRICS: TrendTab[] = ['netWorth', 'assets', 'liabilities', 'salary']
const ALL_RANGES: TrendRange[] = ['6m', '1y', '3y', 'all']

/** 走势配置：兼容 v1 的顶层开关与旧 showChart 字段 */
function normalizeTrends(raw: Record<string, unknown>, salary: Record<string, unknown>): TrendsConfig {
  const base = createDefaultSettings().trends
  const t = isRecord(raw.trends) ? raw.trends : {}
  const legacyEnabled = raw.trendsEnabled === true || salary.showChart === true

  const metricsRaw = Array.isArray(t.metrics) ? (t.metrics as unknown[]) : null
  const metrics = metricsRaw
    ? metricsRaw.filter((m): m is TrendTab => typeof m === 'string' && ALL_METRICS.includes(m as TrendTab))
    : // 旧数据：开关打开时曾经固定展示全部指标
      legacyEnabled
      ? ALL_METRICS
      : base.metrics

  const rangeRaw = typeof t.range === 'string' ? (t.range as TrendRange) : base.range

  return {
    enabled: typeof t.enabled === 'boolean' ? t.enabled : legacyEnabled,
    // 至少保留一个指标，否则面板会空白
    metrics: metrics.length > 0 ? metrics : ['netWorth'],
    range: ALL_RANGES.includes(rangeRaw) ? rangeRaw : base.range,
    showLabels: t.showLabels === undefined ? base.showLabels : t.showLabels === true,
    showMom: t.showMom === undefined ? base.showMom : t.showMom === true,
    colorByTrend: t.colorByTrend === undefined ? base.colorByTrend : t.colorByTrend === true,
  }
}

/** 把任意来源的数据规范化为当前 Schema（脏数据不影响使用） */
export function normalizeSettings(raw: unknown): AppSettings {
  const base = createDefaultSettings()
  if (!isRecord(raw)) return base

  const fund = isRecord(raw.fund) ? raw.fund : {}
  const salary = isRecord(raw.salary) ? raw.salary : {}
  const fixed = isRecord(salary.fixed) ? salary.fixed : {}

  const parsed: SalaryRecord[] = []
  if (Array.isArray(salary.records)) {
    for (const r of salary.records as unknown[]) {
      if (!isRecord(r)) continue
      const month = typeof r.month === 'string' ? r.month : ''
      const amount = Number(r.amount)
      if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(amount)) continue
      parsed.push({
        month,
        amount,
        at: Number(r.at) || Date.now(),
        applied: r.applied === true,
        appliedAt: typeof r.appliedAt === 'number' ? r.appliedAt : undefined,
      })
    }
  }
  // 同月只保留最后一条，避免脏数据出现重复月份
  const byMonth = new Map<string, SalaryRecord>()
  for (const rec of parsed) byMonth.set(rec.month, rec)
  const records = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))

  const paydayRaw = Number(fixed.payday)

  return {
    version: 1,
    fund: {
      useFunding: fund.useFunding === true,
      lastFundingSource: normalizeSource(fund.lastFundingSource),
    },
    // 兼容旧数据：v1 用顶层 trendsEnabled / salary.showChart 表示开关，
    // 且当时面板固定展示全部四个指标
    trends: normalizeTrends(raw, salary),
    salary: {
      records,
      fixed: {
        enabled: fixed.enabled === true,
        amount: Number.isFinite(Number(fixed.amount)) ? Number(fixed.amount) : 0,
        // 限制在 1~28：避免 29~31 在小月不存在
        payday: Number.isFinite(paydayRaw) ? Math.min(28, Math.max(1, Math.round(paydayRaw))) : 10,
        target: normalizeSource(fixed.target),
      },
    },
  }
}

export function loadSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return createDefaultSettings()
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return createDefaultSettings()
  }
}

export function saveSettings(settings: AppSettings): string | null {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    return null
  } catch (e) {
    return e instanceof Error ? `设置保存失败：${e.message}` : '设置保存失败'
  }
}

/* ------------------------------------------------------------------ *
 * 薪资：写入现金项（幂等）
 * ------------------------------------------------------------------ */

export interface ApplyResult {
  portfolio: Portfolio
  /** 本次是否真的写入了 */
  applied: boolean
  /** 写入金额 */
  amount: number
  /** 写入到哪个项目 */
  itemName?: string
  /** 未能写入的原因 */
  reason?: string
}

/**
 * 把某月的薪资写入指定现金项目。
 *
 * 幂等保证：
 * 1. 该月记录已标记 applied 时直接返回，不会重复入账；
 * 2. 调用方（reducer）在同一动作里完成「加余额 + 标记 applied」。
 */
export function applySalaryToPortfolio(
  portfolio: Portfolio,
  settings: AppSettings,
  month: string,
): ApplyResult {
  const record = settings.salary.records.find((r) => r.month === month)
  if (!record) return { portfolio, applied: false, amount: 0, reason: `${month} 没有薪资记录` }
  if (record.applied) return { portfolio, applied: false, amount: 0, reason: '该月薪资已入账，未重复添加' }

  const target = settings.salary.fixed.target
  if (!target) return { portfolio, applied: false, amount: 0, reason: '还没选择发薪写入的项目' }
  if (!(record.amount > 0)) return { portfolio, applied: false, amount: 0, reason: '薪资金额需要大于 0' }

  let found = false
  const categories = portfolio.categories.map((c) => {
    if (c.id !== target.categoryId) return c
    const items = c.items.map((i) => {
      if (i.id !== target.itemId || i.kind !== 'amount') return i
      found = true
      return { ...i, amount: i.amount + record.amount }
    })
    return { ...c, items }
  })

  if (!found) return { portfolio, applied: false, amount: 0, reason: '目标项目已不存在，请在设置里重新选择' }
  return { portfolio: { ...portfolio, categories }, applied: true, amount: record.amount, itemName: target.itemName }
}

/** 判断某月薪资是否应该自动入账（到了发薪日、有金额、且未入账） */
export function shouldAutoApply(
  settings: AppSettings,
  month: string,
  now = new Date(),
): boolean {
  const { fixed, records } = settings.salary
  if (!fixed.enabled || !fixed.target || fixed.amount <= 0) return false
  const record = records.find((r) => r.month === month)
  if (!record || record.applied) return false
  return isPaydayReached(fixed.payday, now)
}

/* ------------------------------------------------------------------ *
 * 现金项目候选（可划拨 / 可入账的来源）
 * ------------------------------------------------------------------ */

export interface CashCandidate {
  categoryId: string
  categoryName: string
  itemId: string
  itemName: string
  amount: number
}

/**
 * 列出可作为资金划拨来源的条目。
 *
 * 规则（与用户确认过）：只列出「金额类」条目，且当前金额为正 ——
 * 基金持仓、黄金这类本身是投资品的条目不能当资金来源；
 * 余额为负（欠款）的项目也不适合再扣。
 */
export function listCashCandidates(portfolio: Portfolio): CashCandidate[] {
  const out: CashCandidate[] = []
  for (const category of portfolio.categories) {
    if (category.isLiability) continue
    for (const item of category.items) {
      if (item.kind !== 'amount') continue
      const amount = Number(item.amount) || 0
      if (amount <= 0) continue
      out.push({
        categoryId: category.id,
        categoryName: category.name,
        itemId: item.id,
        itemName: item.name,
        amount,
      })
    }
  }
  return out.sort((a, b) => b.amount - a.amount)
}

/** 按 id 找候选项目，便于回显与校验 */
export function findCandidate(
  candidates: CashCandidate[],
  source: FundingSource | undefined,
): CashCandidate | undefined {
  if (!source) return undefined
  return candidates.find((c) => c.itemId === source.itemId && c.categoryId === source.categoryId)
}
