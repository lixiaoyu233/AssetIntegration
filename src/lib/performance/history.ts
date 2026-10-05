/**
 * 历史配置趋势
 *
 * ## 数据来源
 *
 * 直接使用 Phase 4 已保存的 **`Snapshot.positions`**，不重算、不插值。
 * 这正是当初坚持保存持仓级明细的回报。
 *
 * ## 关键约束：绝不伪造历史分类
 *
 * `SnapshotPosition.assetClassAtCapture` 是 Schema V4 才引入的字段。
 * v3 存量快照**没有**它，且**不会被回填**（回填等于用今天的分类伪造历史）。
 *
 * 因此本模块严格遵守：
 *
 * | 情况 | 行为 |
 * | --- | --- |
 * | 快照有 `assetClassAtCapture` | 按**当时**的分类统计 |
 * | 快照缺少该字段 | **明确标记「历史分类数据不可用」**，不产出分类构成 |
 * | 区间内缺日期 | **不插值**，只用真实存在的快照 |
 *
 * 宁可历史图存在缺口，也不把今天确认的分类倒填到过去。
 *
 * ## 不影响金额
 *
 * 本模块只做**构成比例**统计；金额与可靠性完全沿用快照里已存的值，
 * 因此不会改变 Phase 4 的任何口径。
 */

import type { Snapshot } from '../../types/portfolio2'

const round2 = (n: number) => Math.round(n * 100) / 100

/* ------------------------------------------------------------------ *
 * captureKind 解析
 * ------------------------------------------------------------------ */

/**
 * 快照来源标记。
 *
 * | 值 | 含义 |
 * | --- | --- |
 * | `REAL` | 当日真实捕获 |
 * | `BACKFILLED` | 历史补齐 |
 * | `ESTIMATED` | 估算 |
 * | `UNKNOWN` | **未标记来源**（旧快照没有 `captureKind` 字段） |
 *
 * ## 为什么 `undefined` 是 UNKNOWN 而不是 REAL
 *
 * `undefined` 表达的语义是「这条历史记录没有记录 provenance」。
 * 把它解释成 `REAL` 等于**把「未知」推断成「真实」**，
 * 与「不伪造、不回填、不推测」的原则冲突。
 *
 * 而且本项目的历史数据**确实不是 REAL**：生产代码中创建快照的唯一位置是
 * `legacy-v2-to-schema-v3.ts`（旧版**月度走势**，无持仓明细，position 为空）。
 * 因此 `undefined → UNKNOWN` 是有依据的判定，不是保守猜测。
 */
export type CaptureKind = 'REAL' | 'BACKFILLED' | 'ESTIMATED' | 'UNKNOWN'

export function snapshotCaptureKind(snapshot: Snapshot): CaptureKind {
  return snapshot.captureKind ?? 'UNKNOWN'
}

/** 供 UI 展示的来源文案 */
export const CAPTURE_KIND_LABEL: Record<CaptureKind, string> = {
  REAL: '当日真实捕获',
  BACKFILLED: '历史补齐',
  ESTIMATED: '估算值',
  UNKNOWN: '历史快照 · 来源未标记',
}

/* ------------------------------------------------------------------ *
 * 单点构成
 * ------------------------------------------------------------------ */

export type CompositionResult =
  | {
      ok: true
      date: string
      /** @deprecated 语义已明确为 **grossAssets**（不含负债）；保留以兼容既有调用方 */
      totalCny: number
      /** 资产合计（**不含**负债）—— 资产类别占比的分母 */
      grossAssets: number
      /** 负债合计（绝对值），单独展示、不混入资产分母 */
      totalLiabilities: number
      /** 净资产 = grossAssets − totalLiabilities */
      netWorth: number
      byClass: Record<string, number>
      byClassShare: Record<string, number>
      /** 该快照整体是否完整（无 stale / unavailable） */
      isComplete: boolean
    }
  | {
      ok: false
      date: string
      /** 明确的原因，UI 直接展示 */
      reason: string
      /** 缺口的具体条数，便于提示 */
      missingClassCount: number
      isComplete: boolean
    }

/**
 * 计算某份快照的资产类别构成。
 *
 * ⚠️ 若快照缺少 `assetClassAtCapture`，返回 `ok: false` 而**不是**退化成
 * 「用当前分类补上」—— 那会让历史趋势随分类确认而整体重画。
 */
export function compositionAtCapture(snapshot: Snapshot): CompositionResult {
  /*
   * 只累加**可靠且确有金额**的项。
   * V7 起 `valueCny` 可缺失（不可估值），必须显式处理而不是把 undefined 当 0。
   */
  /*
   * ## 口径（Phase 8 / W8，P0-5）
   *
   * 三个量必须分清：
   *
   * | 量 | 定义 |
   * | --- | --- |
   * | **grossAssets** | 资产合计（**不含**负债） |
   * | **totalLiabilities** | 负债合计（绝对值） |
   * | **netWorth** | grossAssets − totalLiabilities |
   *
   * ### 修复了什么
   *
   * 原先 `totalCny` 把**全部**可靠持仓（含负债）加成正数，
   * 于是有负债时出现 `totalCny = 1,300,000` 而 `netWorth = 700,000`，
   * 资产类别占比的分母因此错误（实测现金被算成 76.9% 而非 100%）。
   *
   * ### 现在的规则
   *
   * - **资产类别占比以 grossAssets 为分母**（负债不属于「资产类别构成」）；
   * - 负债单独汇总，不混进资产分母；
   * - 若某条持仓**没有** `isLiabilityAtCapture`（v7 及以前的历史快照），
   *   视为**资产** —— 这与当时的实现一致（v7 时负债判定存在缺陷，
   *   不可能凭空补出一个负债标记；用 `assetClassAtCapture === 'liability'`
   *   作为当年唯一的负债线索来还原，而不是猜测）。
   */
  const reliablePositions = snapshot.positions.filter(
    (p) => p.reliable && p.valueCny !== undefined,
  )
  /** 该条在**捕获当时**是否负债（历史快照用当时的类别兜底还原） */
  const liabilityOf = (p: (typeof snapshot.positions)[number]): boolean =>
    p.isLiabilityAtCapture ?? p.assetClassAtCapture === 'liability'

  const grossAssets = round2(
    reliablePositions.filter((p) => !liabilityOf(p)).reduce((s, p) => s + (p.valueCny ?? 0), 0),
  )
  const totalLiabilities = round2(
    reliablePositions.filter((p) => liabilityOf(p)).reduce((s, p) => s + Math.abs(p.valueCny ?? 0), 0),
  )
  const netWorthCalc = round2(grossAssets - totalLiabilities)
  const totalCny = grossAssets
  const isComplete = snapshot.isComplete ?? true

  if (snapshot.positions.length === 0) {
    return {
      ok: false,
      date: snapshot.date,
      reason: '该快照没有持仓明细，历史分类数据不可用',
      missingClassCount: 0,
      isComplete,
    }
  }

  const missing = snapshot.positions.filter((p) => p.assetClassAtCapture === undefined)
  if (missing.length > 0) {
    return {
      ok: false,
      date: snapshot.date,
      reason: `该快照有 ${missing.length} / ${snapshot.positions.length} 条持仓未记录当时的分类，历史分类数据不可用`,
      missingClassCount: missing.length,
      isComplete,
    }
  }

  /*
   * 资产类别构成：**只含资产**，负债单独成键（`liability`）。
   * 占比分母固定为 `grossAssets`，因此 Σ(资产类占比) = 100%。
   */
  const byClass: Record<string, number> = {}
  for (const p of reliablePositions) {
    const cls = liabilityOf(p) ? 'liability' : (p.assetClassAtCapture as string)
    byClass[cls] = round2((byClass[cls] ?? 0) + Math.abs(p.valueCny ?? 0))
  }

  const byClassShare: Record<string, number> = {}
  for (const [k, v] of Object.entries(byClass)) {
    // 负债不参与「资产类别」分母；资产类以 grossAssets 为分母
    byClassShare[k] = k === 'liability' ? 0 : grossAssets > 0 ? v / grossAssets : 0
  }

  return {
    ok: true,
    date: snapshot.date,
    totalCny,
    grossAssets,
    totalLiabilities,
    netWorth: netWorthCalc,
    byClass,
    byClassShare,
    isComplete,
  }
}

/* ------------------------------------------------------------------ *
 * 趋势序列
 * ------------------------------------------------------------------ */

export interface TrendPoint {
  date: string
  /** 净资产（直接取快照值，不重算） */
  netWorth: number
  /**
   * 资产合计（**不含**负债）—— 资产类别占比的分母（W8）。
   *
   * 与 `netWorth` 的区别：有负债时 `grossAssets > netWorth`。
   * 占比必须以 `grossAssets` 为分母，否则百分比会失真。
   */
  grossAssets?: number
  /** 负债合计（W8）。负债单独展示，不混入资产分母 */
  totalLiabilities?: number
  /** 快照来源（REAL / BACKFILLED / ESTIMATED / UNKNOWN） */
  captureKind: CaptureKind
  /** 来源文案，可直接展示 */
  captureKindLabel: string
  /** 是否有可用的历史分类 */
  hasClassification: boolean
  /** 无分类时的原因 */
  unavailableReason?: string
  byClass?: Record<string, number>
  byClassShare?: Record<string, number>
  /** 该点是否完整（不完整时 UI 必须显式标注） */
  isComplete: boolean
  /** 是否可用于展示（完整 + 有分类） */
  usable: boolean
}

export interface TrendSeries {
  points: TrendPoint[]
  /** 出现的全部类别（跨所有可用点），用于图例 */
  classes: string[]
  /** 有分类缺口的时间段 */
  gaps: Array<{ date: string; reason: string }>
  /** 一句话说明，可直接展示 */
  summary: string
}

/**
 * 构建历史配置趋势。
 *
 * @param snapshots 全部快照（任意顺序）；缺失日期**不会**被补齐
 * @param options.since 可选的起始日期（含）
 */
export function buildCompositionTrend(
  snapshots: Snapshot[],
  options: { since?: string; until?: string } = {},
): TrendSeries {
  const filtered = snapshots
    .filter((s) => (options.since ? s.date >= options.since : true))
    .filter((s) => (options.until ? s.date <= options.until : true))
    .sort((a, b) => a.date.localeCompare(b.date))

  const points: TrendPoint[] = []
  const gaps: TrendPoint['date'][] = []
  const gapDetails: Array<{ date: string; reason: string }> = []
  const classSet = new Set<string>()

  for (const snap of filtered) {
    const comp = compositionAtCapture(snap)
    if (comp.ok) {
      for (const k of Object.keys(comp.byClass)) classSet.add(k)
      points.push({
        date: snap.date,
        netWorth: snap.netWorth,
        grossAssets: comp.grossAssets,
        totalLiabilities: comp.totalLiabilities,
        captureKind: snapshotCaptureKind(snap),
        captureKindLabel: CAPTURE_KIND_LABEL[snapshotCaptureKind(snap)],
        hasClassification: true,
        byClass: comp.byClass,
        byClassShare: comp.byClassShare,
        isComplete: comp.isComplete,
        usable: comp.isComplete,
      })
    } else {
      gaps.push(snap.date)
      gapDetails.push({ date: snap.date, reason: comp.reason })
      points.push({
        date: snap.date,
        netWorth: snap.netWorth,
        captureKind: snapshotCaptureKind(snap),
        captureKindLabel: CAPTURE_KIND_LABEL[snapshotCaptureKind(snap)],
        hasClassification: false,
        unavailableReason: comp.reason,
        isComplete: comp.isComplete,
        usable: false,
      })
    }
  }

  const usableCount = points.filter((p) => p.usable).length
  const summary =
    points.length === 0
      ? '还没有历史快照，无法展示趋势'
      : gaps.length === 0
        ? `${points.length} 个历史时点，其中 ${usableCount} 个可用于构成趋势`
        : `${points.length} 个历史时点；${gaps.length} 个因未记录当时的分类而标记为「历史分类数据不可用」（不回填、不插值）`

  return {
    points,
    classes: [...classSet].sort(),
    gaps: gapDetails,
    summary,
  }
}

/* ------------------------------------------------------------------ *
 * 下钻：某个时点的明细
 * ------------------------------------------------------------------ */

/** 某份快照里按类别归组的持仓（仅在分类可用时） */
export function positionsByClass(
  snapshot: Snapshot,
): Array<{ assetClass: string; valueCny: number; instrumentId: string; accountId: string }> {
  return snapshot.positions
    .filter((p) => p.reliable && p.assetClassAtCapture !== undefined)
    .map((p) => ({
      assetClass: p.assetClassAtCapture as string,
      valueCny: p.valueCny as number,
      instrumentId: p.instrumentId,
      accountId: p.accountId,
    }))
}

/** 供 UI 提示：这些日期需要重新捕获快照才能获得分类趋势 */
export function datesNeedingRecapture(series: TrendSeries): string[] {
  return series.gaps.map((g) => g.date)
}
