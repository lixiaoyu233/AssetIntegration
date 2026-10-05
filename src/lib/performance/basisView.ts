/**
 * 历史快照「估值依据」的展示转换（Phase 8 / W9，P1-5）
 *
 * ## 为什么需要这一层
 *
 * W8 把估值依据落盘进了 `SnapshotPosition`（`asOf` / `priceKind` /
 * `quoteStatus` / `quoteSource` / `fxStatus` / `fxSource` / `reasons` /
 * `staleValueCny` / `isLiabilityAtCapture`），但**没有任何 UI 消费它们** ——
 * 用户依然无法回答「2026-10-01 这一天，这个资产为什么是这个价值」。
 * 数据在库里，没有出口。W9 补上这个出口。
 *
 * ## 核心规则：缺失 = 无法追溯，绝不补值
 *
 * V7 及以前的历史快照**没有**这些字段（V8 migration 刻意零填充、不回填）。
 * 因此绝大多数字段在旧快照上是 `undefined`。
 *
 * ⚠️ 这里**绝不能**：
 * - 用「今天的行情」补出 `priceKind` / `quoteSource`；
 * - 用 `1` / `0` / 成本价补出缺失的价格或汇率；
 * - 用当前 `Instrument` 的分类补出历史依据。
 *
 * 缺失必须**明确显示为「无法追溯」**，而不是留空让用户以为「没有特别之处」。
 * 这与项目的核心不变量一致：**不可估值 ≠ 价值为 0**。
 */

import type { AssetClass, SnapshotPosition } from '../../types/portfolio2'
import {
  FX_STATUS_LABEL,
  PRICE_KIND_LABEL,
  QUOTE_STATUS_LABEL,
} from '../../types/portfolio2'

/** 无法追溯时统一使用的文案（不允许留空、不允许猜测） */
export const UNTRACEABLE = '无法追溯'

export interface BasisField {
  /** 字段名（中文，直接展示） */
  label: string
  /** 展示值；缺失时为 `UNTRACEABLE` */
  value: string
  /** 该字段在历史数据中是否缺失（供 UI 弱化显示并提示「无法追溯」） */
  missing: boolean
  /** 是否值得突出（例如降级原因、过期展示价） */
  tone?: 'warn'
}

/** 单条持仓的历史依据视图 */
export interface PositionBasisView {
  instrumentId: string
  accountId: string
  /** 数量（原币） */
  quantity: number
  currency: string
  /** 该条是否可靠估值 */
  reliable: boolean
  /** 捕获当时是否负债（缺失 = 无法追溯，绝不当成「资产」） */
  liability: boolean | 'untraceable'
  /** 捕获当时的资产类别（缺失 = 无法追溯） */
  assetClassAtCapture: AssetClass | 'untraceable'
  /** 已落盘的依据字段 */
  fields: BasisField[]
  /** 缺失依据的字段数（>0 时 UI 应提示「无法追溯」） */
  missingCount: number
}

function field(label: string, raw: string | undefined, tone?: 'warn'): BasisField {
  if (raw === undefined || raw === '') {
    return { label, value: UNTRACEABLE, missing: true }
  }
  return { label, value: raw, missing: false, tone }
}

/** 数值展示：缺失 → 无法追溯（**绝不显示 0**） */
function moneyField(label: string, raw: number | undefined, tone?: 'warn'): BasisField {
  if (raw === undefined || !Number.isFinite(raw)) {
    return { label, value: UNTRACEABLE, missing: true }
  }
  return { label, value: `¥${raw.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, missing: false, tone }
}

/** 依据时间：ISO → 可读本地时间；缺失 → 无法追溯 */
function timeField(label: string, iso: string | undefined): BasisField {
  if (iso === undefined || iso === '') return { label, value: UNTRACEABLE, missing: true }
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return { label, value: UNTRACEABLE, missing: true }
  return { label, value: t.toLocaleString('zh-CN'), missing: false }
}

/**
 * 把一条 `SnapshotPosition` 转换为其历史依据视图。
 *
 * 纯函数、不产生任何新事实 —— 只把**已落盘**的字段整理成可展示形式。
 */
export function positionBasisView(pos: SnapshotPosition): PositionBasisView {
  const priceKindLabel = pos.priceKind ? PRICE_KIND_LABEL[pos.priceKind] : undefined
  const quoteStatusLabel = pos.quoteStatus ? QUOTE_STATUS_LABEL[pos.quoteStatus] : undefined
  const fxStatusLabel = pos.fxStatus ? FX_STATUS_LABEL[pos.fxStatus] : undefined

  const fields: BasisField[] = [
    timeField('依据时间', pos.asOf),
    field('价格类型', priceKindLabel),
    field('行情状态', quoteStatusLabel),
    field('行情来源', pos.quoteSource),
  ]

  /*
   * 汇率依据：**只对外币持仓有意义**。
   * CNY 持仓恒为 1，不存在「汇率依据」，因此不展示这组字段
   * （展示成「无法追溯」会误导用户以为缺数据）。
   */
  if (pos.currency !== 'CNY') {
    fields.push(field('汇率状态', fxStatusLabel), field('汇率来源', pos.fxSource))
  }

  /*
   * 降级原因：仅在**不可靠**时展示。
   * 可靠估值的 `reasons` 是空数组，展示成「无法追溯」是错的 ——
   * 那不是「缺失」，而是「本来就没有降级」。
   */
  if (!pos.reliable) {
    const reasons = pos.reasons && pos.reasons.length > 0 ? pos.reasons.join('、') : undefined
    fields.push(field('降级原因', reasons, 'warn'))
  }

  /*
   * 过期展示价（P1-3）：只有真正读到过期价才有值。
   * 缺失时**明确说明**它不参与总额、且不猜测 —— 而不是显示 0。
   */
  if (pos.staleValueCny !== undefined) {
    fields.push(moneyField('过期展示价（不计入总额）', pos.staleValueCny, 'warn'))
  }

  const missingCount = fields.filter((f) => f.missing).length

  return {
    instrumentId: pos.instrumentId,
    accountId: pos.accountId,
    quantity: pos.quantity,
    currency: pos.currency,
    reliable: pos.reliable,
    /*
     * 负债标记：`undefined` 表示「当时的判定没有记录」= 无法追溯。
     * **绝不**把它当成 `false`（那等于宣称「当时是资产」）。
     */
    liability: pos.isLiabilityAtCapture === undefined ? 'untraceable' : pos.isLiabilityAtCapture,
    assetClassAtCapture: pos.assetClassAtCapture ?? 'untraceable',
    fields,
    missingCount,
  }
}

/** 整个快照的依据视图统计（供卡片头部提示「依据是否完整」） */
export interface SnapshotBasisSummary {
  positions: PositionBasisView[]
  /** 完全无法追溯的持仓数（所有依据字段都缺失） */
  untraceableCount: number
  /** 依据完整（没有缺失字段）的持仓数 */
  completeCount: number
}

export function snapshotBasisSummary(positions: SnapshotPosition[]): SnapshotBasisSummary {
  const views = positions.map(positionBasisView)
  return {
    positions: views,
    // 「无法追溯」= 连依据时间都没有，等同于整条没有依据
    untraceableCount: views.filter((v) => v.fields.every((f) => f.missing)).length,
    completeCount: views.filter((v) => v.missingCount === 0).length,
  }
}
