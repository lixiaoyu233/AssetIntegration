/**
 * 迁移：Schema V6 → V7
 *
 * ## 唯一的语义变更
 *
 * `SnapshotPosition` 的 `price` / `rateToCny` / `valueCny` 从「必填 number」
 * 变为「可选」：`undefined` 表示**不可估值 / 汇率不可解析**。
 *
 * ## 本迁移是「零填充」的（关键约束）
 *
 * 它**不会**改写任何历史快照：
 *
 * ```
 * 存量 V6 快照：valueCny: 0（当时用 0 伪造缺失）
 *              ↓ 保持原样
 *              valueCny: 0 + reliable: false   ← 语义仍可读：reliable=false 表示不计入
 *
 * 新生成的 V7 快照：不可估值 → valueCny 缺失（undefined）
 * ```
 *
 * ## 为什么不回填历史
 *
 * 1. **历史快照是「当时的事实」**。当时写下的 `0` 是当时的产物，
 *    事后改写成 `undefined` 等于重写历史。
 * 2. 无法可靠地反推：`valueCny: 0` 既可能是「不可估值被写成 0」，
 *    也可能是「真的值 0」。**猜测性回填会制造假数据**。
 * 3. 下游已经正确处理：所有读取方都先看 `reliable`，
 *    因此存量数据仍然是安全、可解释的。
 *
 * 本迁移只推进版本号并如实记录这个差异。
 */

import type { Portfolio2 } from '../../../types/portfolio2'
import {
  PORTFOLIO_SCHEMA_VERSION,
  SCHEMA_V6_TO_V7_MIGRATION_ID,
  SCHEMA_VERSION_WITH_NULLABLE_VALUATION,
  schemaVersionLabel,
  type MigrationRecord,
} from '../schema'

export { SCHEMA_V6_TO_V7_MIGRATION_ID }

export interface SchemaV6ToV7Result {
  portfolio: Portfolio2
  record: MigrationRecord
  /** 存量快照中含「用 0 伪造不可估值」痕迹的持仓数（仅供提示，**不回填**） */
  legacyFabricatedPositionCount: number
}

/** 是否存在仍带 V6 伪造痕迹的持仓（`reliable: false` 但金额为 0） */
export function needsNullableValuationMigration(portfolio: Portfolio2): number {
  let n = 0
  for (const snap of portfolio.snapshots) {
    for (const pos of snap.positions) {
      if (!pos.reliable && pos.valueCny === 0) n += 1
    }
  }
  return n
}

/**
 * 执行 V6 → V7。
 *
 * 幂等：不改动任何数据，只推进版本并记录事实。
 */
export function migrateV6ToV7(input: {
  portfolio: Portfolio2
  now?: () => string
}): SchemaV6ToV7Result {
  const now = input.now ?? (() => new Date().toISOString())
  const ts = now()

  const legacyCount = needsNullableValuationMigration(input.portfolio)

  const record: MigrationRecord = {
    migrationId: SCHEMA_V6_TO_V7_MIGRATION_ID,
    sourceSchemaVersion: SCHEMA_VERSION_WITH_NULLABLE_VALUATION - 1,
    targetSchemaVersion: PORTFOLIO_SCHEMA_VERSION,
    sourceLabel: schemaVersionLabel(SCHEMA_VERSION_WITH_NULLABLE_VALUATION - 1),
    targetLabel: schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION),
    migrationTime: ts,
    status: 'success',
    sourceFamily: 'current',
    note:
      `已升级到 ${schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION)}：` +
      `持仓明细的 price / rateToCny / valueCny 起可为缺失（表示不可估值）。` +
      `存量快照不回填、不改写、不重算${legacyCount > 0 ? `；检测到 ${legacyCount} 条 V6 期间以 0 记录的不可估值持仓，其语义仍由 reliable=false 表达` : ''}`,
  }

  // 刻意原样返回：不触碰任何快照数据
  return {
    portfolio: input.portfolio,
    record,
    legacyFabricatedPositionCount: legacyCount,
  }
}
