/**
 * 负债判定 Policy（Phase 8 / W8）
 *
 * ## 为什么必须有这一层
 *
 * W8 审计发现负债有**双重矛盾**：
 *
 * 1. `ClassifySheet` 明说「负债靠账户 `isLiability` 表达」，因此**禁止**用户
 *    选择 `assetClass: 'liability'`；
 * 2. 而估值引擎的唯一判据是 `assetClass === 'liability'`（`engine.ts`）；
 * 3. `Account.isLiability` 虽然被 W7 的创建流程写入，却**从未被任何
 *    估值/分析逻辑读取**。
 *
 * 结果是：用户勾选「这是负债账户」，净资产**没有任何变化**。
 * 更糟的是三处各写一套判据时会出现「一个地方认账户、另一个地方认类别」的口径漂移。
 *
 * ## canonical rule（唯一判定）
 *
 * 本模块是负债判定的**唯一来源**，规则如下：
 *
 * | 情况 | 判定 | 理由 |
 * | --- | --- | --- |
 * | `instrument.assetClass === 'liability'` | **负债** | 类别是资产性质的直接事实 |
 * | `account.isLiability === true` | **负债** | 账户性质也是用户的明确声明 |
 * | 两者同时为真 | **负债（只算一次）** | 见下方「为什么不会重复计算」 |
 * | 两者冲突（账户是负债但标的类别是资产） | **负债** + **标记数据质量问题** | 负债口径以「更保守」为准；不允许静默猜测 |
 *
 * ## 为什么「两者同时为真」不会重复计算
 *
 * 判定返回的是**布尔**（这条持仓是不是负债），而不是「累加次数」。
 * `calculateTotals` / `buildSnapshot` 对每条持仓只调用一次本函数，
 * 结果为真则计入 `totalLiabilities`、为假则计入 `totalAssets` ——
 * 因此在结构上**不可能既进资产又进负债**。
 *
 * ## 冲突为什么不静默处理
 *
 * 例如：账户被标记为负债（信用卡），但用户把某标的的类别设成了 `equity`。
 * 两种可能都存在（用户改错了账户，或改错了标的）。系统**不能替用户猜**，
 * 因此按更保守的「负债」计入，并产出 `issue` 让 UI 明确提示用户核实。
 */

import type { Account, AssetClass, Instrument, Portfolio2 } from '../../types/portfolio2'

/* ------------------------------------------------------------------ *
 * 判定结果
 * ------------------------------------------------------------------ */

export interface LiabilityDecision {
  /** 该持仓是否计入负债 */
  isLiability: boolean
  /** 判定依据（便于 UI 与排查解释「为什么算作负债」） */
  reason: LiabilityReason
  /**
   * 数据质量问题：两个来源给出**冲突**的结论。
   *
   * 出现时必须由 UI 提示用户核实，**不得静默处理**。
   */
  conflict: boolean
  /** 冲突说明（conflict = true 时给出） */
  conflictDetail?: string
}

export type LiabilityReason =
  /** 标的类别明确是负债 */
  | 'instrument_asset_class'
  /** 账户明确是负债账户 */
  | 'account_flag'
  /** 两者都是负债 */
  | 'both'
  /** 两者冲突，按更保守的负债处理 */
  | 'conflict'
  /** 都不是 */
  | 'none'

/**
 * **唯一**的负债判定入口。
 *
 * 所有需要判断「这条持仓算不算负债」的地方都必须调用它 ——
 * 禁止在别处写 `assetClass === 'liability'` 或 `account.isLiability`。
 */
export function decideLiability(
  account: Account | undefined,
  instrument: Instrument | undefined,
): LiabilityDecision {
  const byClass = instrument?.assetClass === 'liability'
  const byAccount = account?.isLiability === true

  if (byClass && byAccount) {
    return { isLiability: true, reason: 'both', conflict: false }
  }
  if (byClass) {
    return { isLiability: true, reason: 'instrument_asset_class', conflict: false }
  }
  if (byAccount) {
    /*
     * 账户是负债，但标的类别是资产（或未确认）→ 冲突。
     *
     * 按更保守的「负债」计入（宁可少算净资产，也不要虚高），
     * 同时明确标记，让 UI 提示用户核实到底哪一处设错了。
     */
    const assetClass = instrument?.assetClass
    if (assetClass !== undefined) {
      return {
        isLiability: true,
        reason: 'conflict',
        conflict: true,
        conflictDetail:
          `账户「${account?.name ?? ''}」被标记为负债，但标的` +
          `「${instrument?.name ?? ''}」的类别是「${assetClass}」。` +
          '已按负债计入（更保守），请核实其中一处是否设置有误。',
      }
    }
    // 标的缺失或类别未知 → 按账户标记为准，不算冲突
    return { isLiability: true, reason: 'account_flag', conflict: false }
  }
  return { isLiability: false, reason: 'none', conflict: false }
}

/* ------------------------------------------------------------------ *
 * 组合级汇总（供 UI 提示数据质量问题）
 * ------------------------------------------------------------------ */

export interface LiabilityConflict {
  holdingId: string
  accountId: string
  instrumentId: string
  detail: string
}

/** 扫描整个组合的负债判定冲突（供设置页/资产页提示） */
export function findLiabilityConflicts(portfolio: Portfolio2): LiabilityConflict[] {
  const accountById = new Map(portfolio.accounts.map((a) => [a.id, a]))
  const instrumentById = new Map(portfolio.instruments.map((i) => [i.id, i]))
  const out: LiabilityConflict[] = []

  for (const h of portfolio.holdings) {
    const d = decideLiability(accountById.get(h.accountId), instrumentById.get(h.instrumentId))
    if (d.conflict) {
      out.push({
        holdingId: h.id,
        accountId: h.accountId,
        instrumentId: h.instrumentId,
        detail: d.conflictDetail ?? '负债判定存在冲突',
      })
    }
  }
  return out
}

/** 该资产类别在 UI 中是否应当视为负债（供选择器提示用） */
export function isLiabilityClass(cls: AssetClass | undefined): boolean {
  return cls === 'liability'
}
