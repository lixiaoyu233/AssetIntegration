/**
 * 迁移：Schema V4 → V5
 *
 * ## 唯一的变更
 *
 * `Snapshot` 新增可选字段 `captureKind`，用于标记快照来源：
 * `REAL` / `BACKFILLED` / `ESTIMATED`。
 *
 * ## 本迁移是「零填充」的（关键约束）
 *
 * 它**不会**给存量快照写 `REAL`，也不会把 `undefined` 改写成任何值：
 *
 * ```
 * 存量 v4 快照：captureKind === undefined        ← 保持不动
 * 新捕获 v5 快照：captureKind === 'REAL'
 * ```
 *
 * 为什么不回填：`undefined` 的语义是「这条历史记录没有记录 provenance」。
 * 把它写成 `REAL` 等于**把「未知」推断成「真实」**。
 *
 * 而且本项目的旧快照**可证明不是 REAL**：生产代码中创建快照的唯一位置是
 * `legacy-v2-to-schema-v3.ts`（旧版**月度走势**，`positions: []`，无持仓明细）。
 * 因此读取层统一解析 `undefined → UNKNOWN`，而不是默认 REAL。
 *
 * ## 本迁移不修改任何金额字段
 *
 * `totalAssets` / `netWorth` / `positions[].valueCny` 等**一律不动**，
 * 因此迁移前后资产总额必须完全一致（有测试锁定）。
 */

import type { Portfolio2, Snapshot } from '../../../types/portfolio2'
import {
  PORTFOLIO_SCHEMA_VERSION,
  SCHEMA_V4_TO_V5_MIGRATION_ID,
  SCHEMA_VERSION_WITH_CAPTURE_KIND,
  schemaVersionLabel,
  type MigrationRecord,
} from '../schema'

export { SCHEMA_V4_TO_V5_MIGRATION_ID }

export interface SchemaV4ToV5Result {
  portfolio: Portfolio2
  record: MigrationRecord
  /** 未标记来源的快照 id（仅供 UI 提示「来源未标记」，**不做回填**） */
  unmarkedSnapshotIds: string[]
}

/** 是否存在尚未标记来源的快照 */
export function needsCaptureKindMigration(portfolio: Portfolio2): boolean {
  return portfolio.snapshots.some((s) => s.captureKind === undefined)
}

/**
 * 执行 V4 → V5。
 *
 * 幂等：两次执行结果一致（它什么都不改，只推进版本并记录事实）。
 */
export function migrateV4ToV5(input: {
  portfolio: Portfolio2
  now?: () => string
}): SchemaV4ToV5Result {
  const now = input.now ?? (() => new Date().toISOString())
  const ts = now()

  const unmarkedSnapshotIds: string[] = []
  const snapshots: Snapshot[] = input.portfolio.snapshots.map((snap) => {
    if (snap.captureKind === undefined) unmarkedSnapshotIds.push(snap.id)
    // 刻意原样返回：不回填、不改写、不重算
    return snap
  })

  const record: MigrationRecord = {
    migrationId: SCHEMA_V4_TO_V5_MIGRATION_ID,
    sourceSchemaVersion: SCHEMA_VERSION_WITH_CAPTURE_KIND - 1,
    targetSchemaVersion: PORTFOLIO_SCHEMA_VERSION,
    sourceLabel: schemaVersionLabel(SCHEMA_VERSION_WITH_CAPTURE_KIND - 1),
    targetLabel: schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION),
    migrationTime: ts,
    status: 'success',
    sourceFamily: 'current',
    note: `已升级到 ${schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION)}；${unmarkedSnapshotIds.length} 份历史快照没有来源标记，将按 UNKNOWN 解释（不回填为 REAL）`,
  }

  return { portfolio: { ...input.portfolio, snapshots }, record, unmarkedSnapshotIds }
}
