/**
 * 总资产月度走势
 *
 * 为什么按月而不是按天：按天存一年就是 365 条，几年后 localStorage 会明显拖慢启动；
 * 按月 10 年也才 120 条，曲线还更干净。
 *
 * 数据模型：
 * - 每个月一条记录，含「总资产 / 负债 / 净资产」三个值（都按当前口径：含外币折算）；
 * - 当月始终处于「暂定」状态，数据一变动就更新，保证图上一直跟到最新；
 * - 每月第一次打开时把「上个月」定稿（final=true），此后不再改动；
 * - 中间整月没打开过，就沿用上一个定稿值补齐，避免曲线断层；
 * - 永久保留，不自动清理。
 */

import type { Portfolio } from '../types/asset'
import { summarize } from './calc'
import { shouldSkipBusinessWrite } from './readOnly'
import type { FxRates } from './currency'

export const SNAPSHOT_STORAGE_KEY = 'asset-card-wallet/networth-history/v1'

/** 每月一条的总资产快照 */
export interface NetWorthPoint {
  /** 年月，YYYY-MM */
  month: string
  /** 总资产（元） */
  assets: number
  /** 负债（元，正数表示欠款规模） */
  liabilities: number
  /** 净资产（元）= assets - liabilities */
  netWorth: number
  /** 是否已定稿：定稿后不再随数据变动而修改 */
  final: boolean
  /** 定稿时间戳 */
  finalizedAt?: number
}

export interface SnapshotFile {
  version: number
  points: NetWorthPoint[]
}

/* ------------------------------------------------------------------ *
 * 时间工具
 * ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0')

/** 年月字符串 */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** 上一个月 */
export function prevMonth(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/)
  if (!m) return month
  const y = Number(m[1])
  const mo = Number(m[2])
  return mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`
}

/** 月份差（a 比 b 晚几个月） */
export function monthDiff(a: string, b: string): number {
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  if (pa.length < 2 || pb.length < 2) return 0
  return (pa[0] - pb[0]) * 12 + (pa[1] - pb[1])
}

/** 「2026-10」→「26/10」，横轴用 */
export function shortMonth(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/)
  return m ? `${m[1].slice(2)}/${m[2]}` : month
}

/** 「2026-10」→「2026年10月」 */
export function longMonth(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/)
  return m ? `${m[1]}年${Number(m[2])}月` : month
}

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function normalizeSnapshot(raw: unknown): SnapshotFile {
  const base: SnapshotFile = { version: 1, points: [] }
  if (!isRecord(raw) || !Array.isArray(raw.points)) return base

  const byMonth = new Map<string, NetWorthPoint>()
  for (const p of raw.points as unknown[]) {
    if (!isRecord(p)) continue
    const month = typeof p.month === 'string' ? p.month : ''
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const assets = Number(p.assets)
    const liabilities = Number(p.liabilities)
    const netWorth = Number(p.netWorth)
    if (![assets, liabilities, netWorth].every(Number.isFinite)) continue
    byMonth.set(month, {
      month,
      assets,
      liabilities,
      netWorth,
      final: p.final === true,
      finalizedAt: typeof p.finalizedAt === 'number' ? p.finalizedAt : undefined,
    })
  }
  return {
    version: 1,
    points: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
  }
}

export function loadSnapshot(): SnapshotFile {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY)
    if (!raw) return { version: 1, points: [] }
    return normalizeSnapshot(JSON.parse(raw))
  } catch {
    return { version: 1, points: [] }
  }
}

export function saveSnapshot(file: SnapshotFile): string | null {
  /*
   * 月度走势属于业务事实（资产历史），Phase 8 / W1 起由 IndexedDB 的
   * Snapshot 表承接，因此只读模式下拒绝写入。
   *
   * ⚠️ 这里**返回错误字符串而不是抛出**。
   * 原因：`saveSnapshot` 会在 reducer 的副作用里被调用
   * （`usePortfolio` 的 `takeSnapshot` → `dispatch`），
   * 异常会从 `dispatch` **同步逃逸**并让整个应用白屏 ——
   * 实测确认过。业务语义上「返回失败原因」与「抛异常」等价，
   * 但不会把一次写入失败升级成应用崩溃。
   * 仍会显式上报错误（不静默），符合「禁止假成功」的要求。
   */
  if (shouldSkipBusinessWrite()) {
    return '只读模式：月度走势已由 IndexedDB 的 Snapshot 承接，不再写入 localStorage'
  }
  try {
    window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(file))
    return null
  } catch (e) {
    return e instanceof Error ? `走势数据保存失败：${e.message}` : '走势数据保存失败'
  }
}

/* ------------------------------------------------------------------ *
 * 取值
 * ------------------------------------------------------------------ */

export interface SnapshotInput {
  portfolio: Portfolio
  rates?: FxRates | null
  /** 是否把负债计入（与首页口径一致） */
  includeLiabilities: boolean
}

/**
 * 按当前口径算出这一时刻的三个数值。
 *
 * 「不含负债」时：净资产与总资产都取资产侧合计，负债记 0 ——
 * 这样图上不会出现一个看起来像「凭空消失」的负债曲线。
 */
export function measure(input: SnapshotInput): { assets: number; liabilities: number; netWorth: number } {
  const s = summarize(input.portfolio, input.rates)
  const totalAssets = s.totalAssets
  const totalLiabilities = Math.abs(s.totalLiabilities)
  if (!input.includeLiabilities) {
    // 不计负债：资产侧就是净资产，负债记 0（而不是漏掉资产）
    return { assets: round2(totalAssets), liabilities: 0, netWorth: round2(totalAssets) }
  }
  return {
    assets: round2(totalAssets),
    liabilities: round2(totalLiabilities),
    netWorth: round2(totalAssets - totalLiabilities),
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/* ------------------------------------------------------------------ *
 * 推进：更新当月 + 定稿上月 + 补齐跳过的月份
 * ------------------------------------------------------------------ */

export interface AdvanceResult {
  file: SnapshotFile
  /** 本次新定稿的月份 */
  finalized: string[]
  /** 是否有变化（用于决定要不要写回 localStorage） */
  changed: boolean
}

/**
 * 用当前数值推进快照。
 *
 * 规则：
 * 1. 当月记录总是更新为最新值（暂定），所以图上一直能看到「本月至」；
 * 2. 早于当月的暂定记录一律定稿（每月第一次打开时完成上月的定稿）；
 * 3. 定稿值与上一个定稿值之间如果有整月缺口，用上一个值补齐。
 */
export function advanceSnapshot(
  file: SnapshotFile,
  input: SnapshotInput,
  now = new Date(),
): AdvanceResult {
  const current = monthKey(now)
  const measured = measure(input)
  const byMonth = new Map(file.points.map((p) => [p.month, { ...p }]))
  const finalized: string[] = []
  let changed = false

  // 1) 定稿所有早于当月的记录
  for (const point of byMonth.values()) {
    if (point.month < current && !point.final) {
      point.final = true
      point.finalizedAt = now.getTime()
      finalized.push(point.month)
      changed = true
    }
  }

  /*
   * 2) 逐月补齐缺口。
   *
   * 必须从「最早一条」一路走到「当月」，不能只在已有月份之间找空档——
   * 缺失的月份此时还不在集合里，两两比较永远发现不了它。
   */
  const sorted = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
  const first = sorted[0]
  if (first) {
    let cursor = first.month
    let carry = first
    while (cursor < current) {
      const existing = byMonth.get(cursor)
      if (existing) {
        carry = existing
      } else {
        // 该月完全没打开过：沿用上一个月（已定稿）的值
        const filled: NetWorthPoint = {
          month: cursor,
          assets: carry.assets,
          liabilities: carry.liabilities,
          netWorth: carry.netWorth,
          final: true,
          finalizedAt: now.getTime(),
        }
        byMonth.set(cursor, filled)
        carry = filled
        finalized.push(cursor)
        changed = true
      }
      cursor = addMonths(cursor, 1)
    }
  }

  // 3) 写入/更新当月（始终暂定）
  const existing = byMonth.get(current)
  const same =
    existing &&
    existing.assets === measured.assets &&
    existing.liabilities === measured.liabilities &&
    existing.netWorth === measured.netWorth
  if (!same) {
    byMonth.set(current, {
      month: current,
      assets: measured.assets,
      liabilities: measured.liabilities,
      netWorth: measured.netWorth,
      final: false,
    })
    changed = true
  }

  return {
    file: { version: 1, points: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)) },
    finalized: finalized.sort(),
    changed,
  }
}

function addMonths(month: string, delta: number): string {
  const m = month.match(/^(\d{4})-(\d{2})$/)
  if (!m) return month
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta
  const y = Math.floor(total / 12)
  const mo = (total % 12) + 1
  return `${y}-${pad(mo)}`
}

/* ------------------------------------------------------------------ *
 * 展示：区间筛选与统计
 * ------------------------------------------------------------------ */

export type TrendMetric = 'netWorth' | 'assets' | 'liabilities'

/** 面板上可切换的全部标签页（薪资与资产口径不同，但在同一个面板里展示） */
export type TrendTab = TrendMetric | 'salary'

export const ALL_TREND_TABS: TrendTab[] = ['netWorth', 'assets', 'liabilities', 'salary']

export const TREND_TAB_LABEL: Record<TrendTab, string> = {
  netWorth: '净资产',
  assets: '总资产',
  liabilities: '负债',
  salary: '薪资',
}

export const TREND_METRIC_LABEL: Record<TrendMetric, string> = {
  netWorth: '净资产',
  assets: '总资产',
  liabilities: '负债',
}

export type TrendRange = '6m' | '1y' | '3y' | 'all'

export const TREND_RANGE_LABEL: Record<TrendRange, string> = {
  '6m': '近 6 月',
  '1y': '近 1 年',
  '3y': '近 3 年',
  all: '全部',
}

const RANGE_MONTHS: Record<Exclude<TrendRange, 'all'>, number> = {
  '6m': 6,
  '1y': 12,
  '3y': 36,
}

/** 初值：沿用现有薪资走势开关的语义，默认关闭 */
export interface TrendSettings {
  enabled: boolean
  range: TrendRange
  showLabels: boolean
}

/** 按范围截取（永远包含当月那个点） */
export function sliceByRange(points: NetWorthPoint[], range: TrendRange): NetWorthPoint[] {
  if (range === 'all') return points
  const n = RANGE_MONTHS[range]
  return points.length <= n ? points : points.slice(-n)
}

export interface RangeStats {
  max?: NetWorthPoint
  min?: NetWorthPoint
  /** 区间累计变化（末值 − 首值） */
  delta: number
  /** 区间累计变化率 */
  rate: number
  /** 与上一个月相比的变化 */
  mom: { delta: number; rate: number } | null
}

/** 区间统计：最高/最低/累计变化/环比 */
export function computeStats(points: NetWorthPoint[], metric: TrendMetric): RangeStats {
  if (points.length === 0) return { delta: 0, rate: 0, mom: null }
  const values = points.map((p) => p[metric])
  const first = values[0]
  const last = values[values.length - 1]
  const delta = last - first
  const rate = first !== 0 ? delta / Math.abs(first) : 0

  const maxIdx = values.indexOf(Math.max(...values))
  const minIdx = values.indexOf(Math.min(...values))

  let mom: { delta: number; rate: number } | null = null
  if (points.length >= 2) {
    const prev = values[values.length - 2]
    const d = last - prev
    mom = { delta: d, rate: prev !== 0 ? d / Math.abs(prev) : 0 }
  }

  return { max: points[maxIdx], min: points[minIdx], delta, rate, mom }
}
