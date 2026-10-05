/**
 * 迁移：Schema V5 → V6
 *
 * ## 唯一的变更
 *
 * `Transaction` 新增可选字段：
 * `status?: 'POSTED' | 'VOIDED'`、`voidedAt?`、`voidReason?`。
 *
 * ## 本迁移是「零填充」的（关键约束）
 *
 * 它**不会**给老交易写 `status: 'POSTED'`：
 *
 * ```
 * 存量 v5 交易：status === undefined   ← 保持不动
 * 新录入交易：  status === undefined（未作废）或 'VOIDED'
 * ```
 *
 * 为什么不回填：`undefined` 的语义是「这笔交易没有显式状态」，
 * 而读取层 `lifecycle.transactionStatus()` 统一把 `undefined` 解释为 `POSTED`。
 * 回填等于把推断固化成事实，且会**改写用户的每一笔历史交易**。
 *
 * ## 本迁移不修改任何其它字段
 *
 * 不改金额、不改数量、不改币种、不改时间戳；
 * **不重算历史交易**、**不产生任何冲正交易**、**不修改 Snapshot**。
 */

import type { Portfolio2, Transaction } from '../../../types/portfolio2'
import {
  PORTFOLIO_SCHEMA_VERSION,
  SCHEMA_V5_TO_V6_MIGRATION_ID,
  SCHEMA_VERSION_WITH_TRANSACTION_STATUS,
  schemaVersionLabel,
  type MigrationRecord,
} from '../schema'

export { SCHEMA_V5_TO_V6_MIGRATION_ID }

export interface SchemaV5ToV6Result {
  portfolio: Portfolio2
  record: MigrationRecord
  /** 尚无显式状态、将按 POSTED 解释的交易数（仅供提示，**不回填**） */
  unstatusedTransactionCount: number
}

/** 是否存在尚未显式标记状态的交易 */
export function needsTransactionStatusMigration(portfolio: Portfolio2): boolean {
  return portfolio.transactions.some((t) => t.status === undefined)
}

/**
 * 执行 V5 → V6。
 *
 * 幂等：两次执行结果一致（它什么都不改，只推进版本并记录事实）。
 */
export function migrateV5ToV6(input: {
  portfolio: Portfolio2
  now?: () => string
}): SchemaV5ToV6Result {
  const now = input.now ?? (() => new Date().toISOString())
  const ts = now()

  let unstatused = 0
  const transactions: Transaction[] = input.portfolio.transactions.map((tx) => {
    if (tx.status === undefined) unstatused += 1
    // 刻意原样返回：不回填、不改写、不重算
    return tx
  })

  const record: MigrationRecord = {
    migrationId: SCHEMA_V5_TO_V6_MIGRATION_ID,
    sourceSchemaVersion: SCHEMA_VERSION_WITH_TRANSACTION_STATUS - 1,
    targetSchemaVersion: PORTFOLIO_SCHEMA_VERSION,
    sourceLabel: schemaVersionLabel(SCHEMA_VERSION_WITH_TRANSACTION_STATUS - 1),
    targetLabel: schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION),
    migrationTime: ts,
    status: 'success',
    sourceFamily: 'current',
    note: `已升级到 ${schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION)}；${unstatused} 笔历史交易没有显式状态，将按 POSTED 解释（不回填、不重算、不产生冲正）`,
  }

  return {
    portfolio: { ...input.portfolio, transactions },
    record,
    unstatusedTransactionCount: unstatused,
  }
}
