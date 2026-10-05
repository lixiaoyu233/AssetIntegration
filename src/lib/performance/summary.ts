/**
 * 绩效指标（基础版）
 *
 * ## 本阶段**不做**什么（用户明确排除）
 *
 * ❌ IRR / XIRR / 年化收益率 / Sharpe / Alpha / 归因精细化
 *
 * ## 本阶段**做**什么
 *
 * 只回答「资产变化是多少、由什么构成」：
 * - 日变化（与上一份快照相比）
 * - 月变化（与本月第一份快照相比）
 * - 年初至今（与今年第一份快照相比）
 * - 外部资金流、投资收益、FX 影响、费用、完整性
 *
 * ## 完整性优先
 *
 * 只要区间内**任意一天**不完整（stale/unavailable/归因 partial），
 * 对应指标一律标记 `reliable: false`，UI 不得当作确定数字展示。
 */

import type { Snapshot } from '../../types/portfolio2'
import { canShowReturn, externalNetFlow } from './snapshot'

const round2 = (n: number) => Math.round(n * 100) / 100

/* ------------------------------------------------------------------ *
 * 区间与变化
 * ------------------------------------------------------------------ */

export interface ChangeSet {
  /** 期末净资产 */
  netWorth: number
  /** 期初净资产 */
  openingNetWorth?: number
  /** 净资产变化（期末 − 期初） */
  netWorthChange?: number
  /** 变化率（小数） */
  netWorthChangeRate?: number
  /** 外部净流入 */
  externalNetFlow?: number
  /** 投资收益（扣费后） */
  investmentReturn?: number
  /** 汇率影响 */
  fxEffect?: number
  /** 其他调整 */
  otherAdjustment?: number
  /** 费用合计 */
  feeTotal?: number
  /** 区间起点与终点日期 */
  from?: string
  to: string
  /**
   * 该指标是否**可靠**。
   * 区间内任一天不完整、或归因非 complete、或缺少必要字段时均为 false。
   */
  reliable: boolean
  /** 不可靠的原因 */
  notes: string[]
}

export interface PerformanceSummary {
  /** 最新一份快照 */
  latest: Snapshot
  /** 日变化（相对上一份有效快照） */
  day: ChangeSet
  /** 本月变化（相对本月第一份快照） */
  month: ChangeSet
  /** 年初至今 */
  ytd: ChangeSet
  /** 历史完整性概览 */
  completeness: {
    total: number
    complete: number
    partial: number
    unavailable: number
    /** 最近一次不完整的日期 */
    lastIncompleteDate?: string
  }
}

function rate(change: number | undefined, base: number | undefined): number | undefined {
  if (change === undefined || base === undefined || base === 0) return undefined
  return change / Math.abs(base)
}

/**
 * 计算从 `opening` 到 `closing` 的变化。
 *
 * `scope` 内的所有快照都会参与完整性判断：任一天不完整 → `reliable = false`。
 */
export function computeChange(
  closing: Snapshot,
  opening: Snapshot | undefined,
  scope: Snapshot[] = [],
): ChangeSet {
  const notes: string[] = []

  if (!opening) {
    return {
      netWorth: closing.netWorth,
      to: closing.date,
      reliable: false,
      notes: ['没有可对比的期初快照'],
    }
  }

  const netWorthChange = round2(closing.netWorth - opening.netWorth)

  // 完整性：区间内任一天不完整即不可靠
  const incomplete = scope.filter((s) => s.isComplete === false)
  if (incomplete.length > 0) {
    notes.push(`区间内有 ${incomplete.length} 天数据不完整（存在无法估值或已过期的持仓）`)
  }
  const partial = scope.filter((s) => s.attributionStatus !== 'complete')
  if (partial.length > 0) {
    notes.push(`区间内有 ${partial.length} 天无法完整归因`)
  }
  if (!canShowReturn(closing)) {
    notes.push('最新一天不满足「可展示收益」的条件')
  }

  return {
    netWorth: closing.netWorth,
    openingNetWorth: opening.netWorth,
    netWorthChange,
    netWorthChangeRate: rate(netWorthChange, opening.netWorth),
    externalNetFlow: externalNetFlow(closing),
    investmentReturn: closing.investmentReturn,
    fxEffect: closing.fxEffect,
    otherAdjustment: closing.otherAdjustment,
    feeTotal: closing.feeTotal,
    from: opening.date,
    to: closing.date,
    reliable: notes.length === 0,
    notes,
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

/** 取某月第一份快照 */
export function firstOfMonth(snapshots: Snapshot[], monthPrefix: string): Snapshot | undefined {
  return snapshots
    .filter((s) => s.date.startsWith(monthPrefix))
    .sort((a, b) => a.date.localeCompare(b.date))[0]
}

/** 取某年第一份快照 */
export function firstOfYear(snapshots: Snapshot[], year: string): Snapshot | undefined {
  return snapshots
    .filter((s) => s.date.startsWith(year))
    .sort((a, b) => a.date.localeCompare(b.date))[0]
}

/**
 * 汇总日 / 月 / 年初至今的变化。
 *
 * @param snapshots 全部快照（任意顺序）
 */
export function summarizePerformance(snapshots: Snapshot[]): PerformanceSummary | undefined {
  if (snapshots.length === 0) return undefined

  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date))
  const latest = sorted[sorted.length - 1]

  /* 日变化：上一份快照 */
  const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : undefined
  const day = computeChange(latest, prev, prev ? [prev, latest] : [latest])

  /* 月变化 */
  const monthPrefix = latest.date.slice(0, 7)
  const monthOpen = firstOfMonth(sorted, monthPrefix)
  const monthScope = sorted.filter((s) => s.date.startsWith(monthPrefix))
  const month = computeChange(latest, monthOpen, monthScope)

  /* 年初至今 */
  const yearPrefix = latest.date.slice(0, 4)
  const yearOpen = firstOfYear(sorted, yearPrefix)
  const yearScope = sorted.filter((s) => s.date.startsWith(yearPrefix))
  const ytd = computeChange(latest, yearOpen, yearScope)

  /* 完整性概览 */
  const completeness = {
    total: sorted.length,
    complete: sorted.filter((s) => s.isComplete === true).length,
    partial: sorted.filter((s) => s.attributionStatus === 'partial').length,
    unavailable: sorted.filter((s) => s.attributionStatus === 'unavailable').length,
    lastIncompleteDate: [...sorted].reverse().find((s) => s.isComplete === false)?.date,
  }

  return { latest, day, month, ytd, completeness }
}

/* ------------------------------------------------------------------ *
 * 展示
 * ------------------------------------------------------------------ */

/** 供 UI 使用的「今日」文案；不可靠时明确说明而不是给一个数字 */
export function describeDay(snapshot: Snapshot, change: ChangeSet): string {
  if (!change.reliable || snapshot.investmentReturn === undefined) {
    return `数据不完整，暂不展示当日收益（${change.notes[0] ?? '原因未知'}）`
  }
  const v = snapshot.investmentReturn
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `今日投资收益 ${sign}${Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
}

/** 历史趋势图上该点是否应标记为不完整 */
export function isIncompletePoint(snapshot: Snapshot): boolean {
  return snapshot.isComplete === false || snapshot.attributionStatus !== 'complete'
}
