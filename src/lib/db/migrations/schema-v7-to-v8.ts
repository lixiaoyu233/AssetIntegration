/**
 * 迁移：Schema V7 → V8（Phase 8 / W8）
 *
 * ## 唯一的变更
 *
 * 为历史事实完整性新增**可选字段**：
 *
 * `SnapshotPosition`
 * - `asOf` / `priceKind` / `quoteStatus` / `quoteSource`（估值依据）
 * - `fxStatus` / `fxSource`（汇率依据）
 * - `reasons`（降级原因）
 * - `staleValueCny`（过期展示价，不参与总额）
 * - `isLiabilityAtCapture`（捕获当时是否负债）
 *
 * `Snapshot`
 * - `openingDate`（期初快照日期）
 * - `capturedAt`（内容对应的捕获时刻）
 *
 * ## 本迁移是**纯零填充**：不改动任何数据
 *
 * 关键约束（不可协商）：
 *
 * | 禁止 | 原因 |
 * | --- | --- |
 * | 回填 `asOf` / `priceKind` / `quoteStatus` | 「当时的依据」已经不在库里（V7 之前行情是覆盖写的），任何回填都是**编造依据** |
 * | 回填 `isLiabilityAtCapture` | 当时的负债判定有缺陷，无法反推用户当时的意图 |
 * | 回填 `openingDate` | 无法可靠判断当时的期初是哪一天 |
 * | 重算历史快照 | 历史是「当时的事实」，重算等于改写历史 |
 * | 用今天的 Quote / FX 回填 | 这正是本阶段要根除的污染 |
 *
 * 因此本迁移只推进版本号并如实记录差异 ——
 * 历史快照的 V8 字段**保持 `undefined`**，其含义是
 * 「**无法追溯**」，而不是「值为零」。UI 与历史分析必须显式处理这种缺失。
 */

import type { Portfolio2 } from '../../../types/portfolio2'
import {
  PORTFOLIO_SCHEMA_VERSION,
  SCHEMA_V7_TO_V8_MIGRATION_ID,
  SCHEMA_VERSION_WITH_HISTORICAL_FACTS,
  schemaVersionLabel,
  type MigrationRecord,
} from '../schema'

export { SCHEMA_V7_TO_V8_MIGRATION_ID }

export interface SchemaV7ToV8Result {
  portfolio: Portfolio2
  record: MigrationRecord
  /** 缺少依据字段的持仓数（仅供提示，**不回填**） */
  positionsWithoutBasis: number
  /** 缺少捕获时刻的快照数（仅供提示，**不回填**） */
  snapshotsWithoutCapturedAt: number
}

/** 统计历史数据中缺失 V8 字段的数量（只读，不改数据） */
export function inspectV7Gaps(portfolio: Portfolio2): {
  positionsWithoutBasis: number
  snapshotsWithoutCapturedAt: number
} {
  let positionsWithoutBasis = 0
  let snapshotsWithoutCapturedAt = 0
  for (const snap of portfolio.snapshots) {
    if (snap.capturedAt === undefined) snapshotsWithoutCapturedAt += 1
    for (const pos of snap.positions) {
      if (pos.asOf === undefined) positionsWithoutBasis += 1
    }
  }
  return { positionsWithoutBasis, snapshotsWithoutCapturedAt }
}

/**
 * 执行 V7 → V8。
 *
 * **幂等**：它不修改任何数据，因此重复执行结果完全一致。
 */
export function migrateV7ToV8(input: {
  portfolio: Portfolio2
  now?: () => string
}): SchemaV7ToV8Result {
  const now = input.now ?? (() => new Date().toISOString())
  const { positionsWithoutBasis, snapshotsWithoutCapturedAt } = inspectV7Gaps(input.portfolio)

  const record: MigrationRecord = {
    migrationId: SCHEMA_V7_TO_V8_MIGRATION_ID,
    sourceSchemaVersion: SCHEMA_VERSION_WITH_HISTORICAL_FACTS - 1,
    targetSchemaVersion: PORTFOLIO_SCHEMA_VERSION,
    sourceLabel: schemaVersionLabel(SCHEMA_VERSION_WITH_HISTORICAL_FACTS - 1),
    targetLabel: schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION),
    migrationTime: now(),
    status: 'success',
    sourceFamily: 'current',
    note:
      `已升级到 ${schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION)}：` +
      '快照新增「估值依据 / 捕获时刻 / 当时是否负债」等可选字段。' +
      '存量数据**不回填**（当时的依据已不可考，回填即是编造）——' +
      `缺失含义为「无法追溯」；其中 ${snapshotsWithoutCapturedAt} 份快照缺 capturedAt、` +
      `${positionsWithoutBasis} 条持仓缺 asOf。`,
  }

  // 刻意原样返回：不触碰任何快照数据
  return { portfolio: input.portfolio, record, positionsWithoutBasis, snapshotsWithoutCapturedAt }
}
