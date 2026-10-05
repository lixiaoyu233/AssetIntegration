/**
 * 分析层类型定义
 *
 * ## 最重要的语义分层（Phase 6 修正后固定）
 *
 * | 字段 | 含义 |
 * | --- | --- |
 * | `totalAssets` | 当前**可计算到的**资产总额（= 估值为 `ok` 的部分） |
 * | `reliableValueCny` | **各维度合计必须等于它**，等于 `totalAssets` |
 * | `unavailableCount` / `staleCount` | 无法计入金额的持仓数 |
 *
 * 也就是说：
 *
 * ```
 * Σ(任一维度的 GroupBucket.valueCny) === reliableValueCny === totalAssets
 * ```
 *
 * **不是**「各维度合计 = 某个包含不可估值资产的理论总额」——
 * 不可估值资产**永远不产生金额**，只产生计数与缺口标记。
 *
 * > ⚠️ 如果未来引入「理论总值」概念，必须另立字段（如 `theoreticalValueCny`），
 * > **绝不能复用 `totalAssets`**，否则会重现「不可估值被当成 0」的问题。
 *
 * ## unconfirmed ≠ unavailable
 *
 * 两个维度**互相独立，可以同时成立**：
 *
 * | classificationStatus | valuationStatus | 计入金额 | 归属 |
 * | --- | --- | --- | --- |
 * | `unconfirmed` | `ok` | ✅ `reliableValueCny` | 「待确认分类」桶 |
 * | `unconfirmed` | `unavailable` | ❌ | `unconfirmedCount` **且** `unavailableCount` |
 * | `confirmed` | `unavailable` | ❌ | `unavailableCount` |
 * | `confirmed` | `ok` | ✅ | 正常分类桶 |
 *
 * 「分类未知」不等于「没有价值」——只要有可靠估值就计入金额。
 */

import type {
  AccountRegion,
  AccountType,
  AssetClass,
  CurrencyCode,
  InstrumentType,
} from '../../types/portfolio2'
import type { ValuationReason, ValuationStatus } from '../valuation/types'

/* ------------------------------------------------------------------ *
 * 行：分析的基本单元
 * ------------------------------------------------------------------ */

/** 分类解析结果 */
export type ClassifiedAssetClass = AssetClass | 'unconfirmed'

export interface AnalysisRow {
  holdingId: string
  accountId: string
  accountName: string
  instrumentId: string
  instrumentName: string

  /* ---- 分类（来源唯一，见 classify.ts） ---- */
  assetClass: ClassifiedAssetClass
  instrumentType: InstrumentType
  /** 账户属地（资产**存放**在哪里） */
  region: AccountRegion | 'unknown'
  accountType: AccountType
  /** 标的计价币种 */
  currency: CurrencyCode

  /* ---- 估值（直接来自 ValuationResult，不做任何重算） ---- */
  status: ValuationStatus
  /** 不可估值 / 降级原因（原样透传，用于区分「缺行情」与「缺汇率」） */
  reasons: ValuationReason[]
  /** 人民币可靠金额；仅 `status === 'ok'` 时有值 */
  valueCny?: number
  /** 原币价值（不可估值时也可能有，仅用于按币种展示敞口） */
  nativeValue?: number
  quantity: number

  /* ---- 标记 ---- */
  /** 分类是否已由用户确认 */
  classConfirmed: boolean
  isLiability: boolean
}

/**
 * 资产行与负债行**必须分开**。
 *
 * 原因：`totalAssets` 不含负债，若负债行参与资产维度分组，
 * 就会出现「某维度合计 = 资产 + 负债 ≠ totalAssets」的错账。
 * 因此：
 * - `rows` 保留全部持仓（含负债）
 * - `assetRows` / `liabilityRows` 是它的两个互斥子集
 * - 六个维度**只对 assetRows 切分**
 */
export interface RowSplit {
  assetRows: AnalysisRow[]
  liabilityRows: AnalysisRow[]
}

/* ------------------------------------------------------------------ *
 * 分组
 * ------------------------------------------------------------------ */

export type DimensionKey =
  | 'assetClass'
  | 'account'
  | 'accountType'
  | 'currency'
  | 'region'
  | 'instrumentType'

export interface GroupBucket {
  key: string
  label: string
  /**
   * 该分组的**可靠金额合计**（人民币）。
   * 所有分组之和 === `AnalysisView.reliableValueCny`。
   */
  valueCny: number
  /** 占可靠总额的比例；可靠总额为 0 时 undefined（**不填 0**） */
  share?: number
  reliableCount: number
  unavailableCount: number
  staleCount: number
  /** 该组内分类未确认的项数 */
  unconfirmedCount: number
  /** 该组是否完整（无 unavailable / stale） */
  isComplete: boolean
  /** 仅币种维度：原币金额 */
  nativeTotal?: number
  nativeCurrency?: CurrencyCode
  /**
   * 币种维度专用：无法折算成人民币时的缺口标记。
   * 此时 `valueCny` 不含该项，`nativeTotal` 仍保留。
   */
  fxMissing?: boolean
}

/* ------------------------------------------------------------------ *
 * 完整性
 * ------------------------------------------------------------------ */

export interface Coverage {
  /** 可靠估值金额（各维度合计的基准） */
  reliableValueCny: number
  reliableCount: number
  unavailableCount: number
  unavailableHoldingIds: string[]
  staleCount: number
  staleHoldingIds: string[]
  /** 分类未确认的持仓数（与 unavailable **不互斥**） */
  unconfirmedCount: number
  unconfirmedHoldingIds: string[]
  /** 既未确认分类、又无法估值的持仓（同时属于两个集合） */
  unconfirmedAndUnavailableIds: string[]
  /** 负债金额 */
  liabilityValueCny: number
  totalHoldings: number
  /** 可靠项 / 总项 */
  coverageRatio: number
  isComplete: boolean
  /** 无法支撑的分析类型（分类相关的分析） */
  blockedAnalyses: string[]
}

/* ------------------------------------------------------------------ *
 * 视图
 * ------------------------------------------------------------------ */

export interface AnalysisView {
  asOf: string
  /** 估值为 ok 的资产金额（人民币） */
  totalAssets: number
  totalLiabilities: number
  netWorth: number
  /** 各维度合计的基准，等于 totalAssets */
  reliableValueCny: number

  /** 根集合：所有持仓（含负债），行数 === 持仓数 */
  rows: AnalysisRow[]
  /** 资产行（六个维度的唯一数据来源） */
  assetRows: AnalysisRow[]
  /** 负债行（单独统计，不参与资产维度） */
  liabilityRows: AnalysisRow[]

  byAssetClass: GroupBucket[]
  byAccount: GroupBucket[]
  byAccountType: GroupBucket[]
  byCurrency: GroupBucket[]
  byRegion: GroupBucket[]
  byInstrumentType: GroupBucket[]

  coverage: Coverage
}
