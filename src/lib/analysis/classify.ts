/**
 * 分类解析
 *
 * ## 唯一来源原则
 *
 * 分类**只从 `Instrument` 读取**，不在分析层重新推断：
 *
 * ```
 * Instrument.assetClass + classificationStatus
 *         ↓  （不做任何推断）
 * AnalysisRow.assetClass
 * ```
 *
 * ## 绝不自动分类
 *
 * 严禁根据以下信息猜测分类：
 * - 标的名称 / 代码 / 关键词
 * - 金额大小
 * - 账户类型
 *
 * 未确认的一律进入 `'unconfirmed'` 桶，并在完整性报告里单列。
 */

import type { Instrument, Portfolio2 } from '../../types/portfolio2'
import type { AccountRegion } from '../../types/portfolio2'
import type { ClassifiedAssetClass } from './types'

export interface ClassificationResult {
  assetClass: ClassifiedAssetClass
  /** 是否已由用户确认 */
  confirmed: boolean
}

/**
 * 解析标的的资产类别。
 *
 * 规则：
 * 1. `classificationStatus === 'confirmed'` → 使用 `assetClass`
 * 2. 未确认 → `'unconfirmed'`（**不猜**）
 * 3. 标的不存在 → `'unconfirmed'`
 *
 * 注意：即使 `assetClass` 有值但状态是 `unconfirmed`，也**不采用**该值 ——
 * 那只是迁移时留下的线索，不是用户确认的事实。
 */
export function classifyInstrument(instrument: Instrument | undefined): ClassificationResult {
  if (!instrument) return { assetClass: 'unconfirmed', confirmed: false }
  if (instrument.classificationStatus === 'confirmed') {
    return { assetClass: instrument.assetClass, confirmed: true }
  }
  return { assetClass: 'unconfirmed', confirmed: false }
}

/** 是否为现金（分析层只做展示归类，判定沿用「已确认」语义） */
export function isCashInstrument(instrument: Instrument | undefined): boolean {
  return instrument?.instrumentType === 'cash'
}

/* ------------------------------------------------------------------ *
 * 地区
 * ------------------------------------------------------------------ */

/**
 * 解析「资产存放地」= **账户属地**。
 *
 * 明确约定：这里**绝不根据证券名称/代码推断市场**。
 * 香港账户持有美股 ETF → 属地仍为 HK。
 * 未来若有可靠的 `Instrument` 市场信息，应作为独立维度（见 README 说明）。
 */
export function resolveRegion(account: { region?: AccountRegion } | undefined): AccountRegion | 'unknown' {
  return account?.region ?? 'unknown'
}

/* ------------------------------------------------------------------ *
 * 汇总入口
 * ------------------------------------------------------------------ */

export interface ClassificationIndex {
  instrumentById: Map<string, Instrument>
  accountById: Map<string, Portfolio2['accounts'][number]>
}

export function buildClassificationIndex(portfolio: Portfolio2): ClassificationIndex {
  return {
    instrumentById: new Map(portfolio.instruments.map((i) => [i.id, i])),
    accountById: new Map(portfolio.accounts.map((a) => [a.id, a])),
  }
}
