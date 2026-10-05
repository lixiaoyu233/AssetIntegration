/**
 * 迁移调度
 *
 * 职责：
 * 1. 检测源数据结构与版本；
 * 2. 判断是否已迁移过（幂等，可重复执行）；
 * 3. 执行迁移 → 校验；
 * 4. 落库并记录 MigrationRecord（含 sourceSchemaVersion / targetSchemaVersion /
 *    migrationTime / migrationStatus）。
 *
 * 关键约束：
 * - **校验不通过则视为失败**：不写入已迁移标记，旧数据保持可用；
 * - **不删除任何旧数据**（清理由用户主动触发，见设置页）；
 * - 通过注入的 `MigrationStore` 读写，Phase 1 用 localStorage + 内存实现，
 *   后续换 IndexedDB 时只需替换实现，调度逻辑不变。
 */

import type { IsoDateTime, Portfolio2 } from '../../../types/portfolio2'
import {
  type MigrationRecord,
  LEGACY_VERSION_LABEL,
  PORTFOLIO_SCHEMA_VERSION,
  SCHEMA_VERSION_LABEL,
  detectSchemaFamily,
  detectSourceVersion,
  migrationIdFor,
} from '../schema'
import {
  migrateLegacyToCurrentSchema,
  type LegacyNetWorthPointLike,
  type LegacyPortfolioLike,
} from './legacy-v2-to-schema-v3'
import {
  SCHEMA_VERSION_WITH_ASSET_CLASS_AT_CAPTURE,
  SCHEMA_VERSION_WITH_CAPTURE_KIND,
  SCHEMA_VERSION_WITH_TRANSACTION_STATUS,
  SCHEMA_VERSION_WITH_NULLABLE_VALUATION,
  SCHEMA_VERSION_WITH_HISTORICAL_FACTS,
} from '../schema'
import { SCHEMA_V3_TO_V4_MIGRATION_ID, migrateV3ToV4 } from './schema-v3-to-v4'
import { SCHEMA_V4_TO_V5_MIGRATION_ID, migrateV4ToV5 } from './schema-v4-to-v5'
import { SCHEMA_V5_TO_V6_MIGRATION_ID, migrateV5ToV6 } from './schema-v5-to-v6'
import { SCHEMA_V6_TO_V7_MIGRATION_ID, migrateV6ToV7 } from './schema-v6-to-v7'
import { SCHEMA_V7_TO_V8_MIGRATION_ID, migrateV7ToV8 } from './schema-v7-to-v8'
import { summarizeVerify, verifyMigration, type VerifyReport } from './verify'

import type { MigrationStore } from '../repository'

export type { MigrationStore }
export {
  SCHEMA_V3_TO_V4_MIGRATION_ID,
  SCHEMA_V4_TO_V5_MIGRATION_ID,
  SCHEMA_V5_TO_V6_MIGRATION_ID,
  SCHEMA_V6_TO_V7_MIGRATION_ID,
  SCHEMA_V7_TO_V8_MIGRATION_ID,
}

export type MigrateOutcome =
  | { status: 'skipped'; reason: 'no-data' | 'already-migrated'; record?: MigrationRecord }
  | { status: 'success'; record: MigrationRecord; portfolio: Portfolio2; verify: VerifyReport }
  | { status: 'failed'; record: MigrationRecord; verify: VerifyReport }

export interface MigrateOptions {
  /** 旧数据（通常来自 localStorage 的 asset-card-wallet/portfolio/v2） */
  legacy: unknown
  /** 旧版月度走势（可选） */
  netWorthPoints?: LegacyNetWorthPointLike[]
  store: MigrationStore
  /** 注入时钟便于测试 */
  now?: () => Date
}

function isLegacyPortfolio(v: unknown): v is LegacyPortfolioLike {
  return detectSchemaFamily(v) === 'legacy'
}

/** 取最近一条迁移记录（不依赖 Array.prototype.at，兼容当前 lib 配置） */
async function lastLog(store: MigrationStore): Promise<MigrationRecord | undefined> {
  const log = await store.readLog()
  return log.length > 0 ? log[log.length - 1] : undefined
}

/** 追加一条迁移记录 */
async function appendLog(store: MigrationStore, record: MigrationRecord): Promise<void> {
  const log = await store.readLog()
  await store.writeLog([...log, record])
}

export async function migrate(options: MigrateOptions): Promise<MigrateOutcome> {
  const { legacy, store } = options
  const clock = options.now ?? (() => new Date())
  const iso = (): IsoDateTime => clock().toISOString()

  const meta = await store.readMeta()
  const sourceVersion = detectSourceVersion(legacy)
  const target = PORTFOLIO_SCHEMA_VERSION
  const migrationId = migrationIdFor(sourceVersion ?? 1, target)

  /* ---- 无数据：不写任何东西 ---- */
  if (!legacy) {
    // 但可能已经有迁移过的数据（用户清过 localStorage）
    const existing = await store.readPortfolio()
    if (existing) {
      return { status: 'skipped', reason: 'already-migrated', record: await lastLog(store) }
    }
    return { status: 'skipped', reason: 'no-data' }
  }

  /* ---- 已经迁移过：直接放行，不重复执行 ---- */
  if (meta?.appliedMigrations?.includes(migrationId)) {
    return { status: 'skipped', reason: 'already-migrated', record: await lastLog(store) }
  }

  /* ---- 已经是新结构：无需迁移 ---- */
  if (detectSchemaFamily(legacy) === 'current') {
    return { status: 'skipped', reason: 'already-migrated' }
  }

  /* ---- 结构不认识：记为失败，保留旧数据 ---- */
  if (!isLegacyPortfolio(legacy)) {
    const record: MigrationRecord = {
      migrationId,
      sourceSchemaVersion: sourceVersion ?? -1,
      targetSchemaVersion: target,
      sourceFamily: 'unknown',
      sourceLabel: '未知结构',
      targetLabel: SCHEMA_VERSION_LABEL,
      migrationTime: iso(),
      status: 'failed',
      error: '无法识别的旧数据结构，已保留原数据不做改动',
    }
    await appendLog(store, record)
    return {
      status: 'failed',
      record,
      verify: { ok: false, checks: [], blockers: ['无法识别的旧数据结构'] },
    }
  }

  /* ---- 执行迁移 ---- */
  const result = migrateLegacyToCurrentSchema({ portfolio: legacy, netWorthPoints: options.netWorthPoints })
  const verify = verifyMigration(legacy, result)

  const record: MigrationRecord = {
    migrationId,
    sourceSchemaVersion: sourceVersion ?? 1,
    targetSchemaVersion: target,
    sourceFamily: 'legacy',
    sourceLabel: LEGACY_VERSION_LABEL,
    targetLabel: SCHEMA_VERSION_LABEL,
    migrationTime: iso(),
    status: verify.ok ? 'success' : 'failed',
    error: verify.ok ? undefined : verify.blockers.join('；'),
    warnings: result.warnings.map((w) => w.message),
    counts: {
      accounts: result.portfolio.accounts.length,
      instruments: result.portfolio.instruments.length,
      holdings: result.portfolio.holdings.length,
      transactions: result.portfolio.transactions.length,
      quotes: result.portfolio.quotes.length,
      legacyItems: result.counts.legacyItems,
      migratedHoldings: result.counts.migratedHoldings,
      unconfirmed: result.counts.unconfirmed,
    },
  }

  /* ---- 校验失败：只记日志，不写新数据、不标记已迁移 → 旧数据不受影响 ---- */
  if (!verify.ok) {
    await appendLog(store, record)
    return { status: 'failed', record, verify }
  }

  /* ---- 成功：写新数据 + 元信息 + 日志 ---- */
  await store.writePortfolio(result.portfolio)
  await appendLog(store, record)

  const applied = [...(meta?.appliedMigrations ?? []), migrationId]

  /*
   * V3 → V4：为 SnapshotPosition 补齐 assetClassAtCapture 的**声明**。
   *
   * 这一步**不回填任何历史分类**（那会伪造历史），
   * 只是把版本推进到 v4，让**今后**捕获的快照带上当时的分类。
   * 因为不改任何金额字段，资产总额不受影响。
   */
  /*
   * 闸门必须按**版本**判断，而不是按数据形态。
   *
   * 早期实现用了 needsAssetClassAtCaptureMigration()（检查快照 positions 是否缺字段），
   * 但迁移产生的快照 positions 为空（旧月度走势没有持仓明细），
   * 于是条件为 false → 这一步被错误跳过，迁移链不完整。
   *
   * 正确判据：源版本低于引入该字段的版本，且该迁移尚未应用过（幂等）。
   */
  let current = result.portfolio

  const alreadyAppliedV4 = applied.includes(SCHEMA_V3_TO_V4_MIGRATION_ID)
  const sourceBelowV4 = (sourceVersion ?? 0) < SCHEMA_VERSION_WITH_ASSET_CLASS_AT_CAPTURE
  if (!alreadyAppliedV4 && sourceBelowV4) {
    const upgraded = migrateV3ToV4({ portfolio: current, now: iso })
    current = upgraded.portfolio
    await store.writePortfolio(current)
    await appendLog(store, upgraded.record)
    applied.push(SCHEMA_V3_TO_V4_MIGRATION_ID)
  }

  /*
   * V4 → V5：快照来源标记（captureKind）。
   * 同样是**零填充**：不给存量快照写 REAL，只推进版本并记录「未标记」事实。
   */
  const alreadyAppliedV5 = applied.includes(SCHEMA_V4_TO_V5_MIGRATION_ID)
  const sourceBelowV5 = (sourceVersion ?? 0) < SCHEMA_VERSION_WITH_CAPTURE_KIND
  if (!alreadyAppliedV5 && sourceBelowV5) {
    const upgraded = migrateV4ToV5({ portfolio: current, now: iso })
    current = upgraded.portfolio
    await store.writePortfolio(current)
    await appendLog(store, upgraded.record)
    applied.push(SCHEMA_V4_TO_V5_MIGRATION_ID)
  }

  /*
   * V5 → V6：交易生命周期字段（作废机制）。
   * 同样是**零填充**：不给老交易写 POSTED，读取层把 undefined 解释为 POSTED。
   */
  const alreadyAppliedV6 = applied.includes(SCHEMA_V5_TO_V6_MIGRATION_ID)
  const sourceBelowV6 = (sourceVersion ?? 0) < SCHEMA_VERSION_WITH_TRANSACTION_STATUS
  if (!alreadyAppliedV6 && sourceBelowV6) {
    const upgraded = migrateV5ToV6({ portfolio: current, now: iso })
    current = upgraded.portfolio
    await store.writePortfolio(current)
    await appendLog(store, upgraded.record)
    applied.push(SCHEMA_V5_TO_V6_MIGRATION_ID)
  }

  /*
   * V6 → V7：持仓明细的不可估值字段改为可缺失。
   * **零填充**：不触碰任何历史快照（只推进版本并记录事实）。
   */
  const alreadyAppliedV7 = applied.includes(SCHEMA_V6_TO_V7_MIGRATION_ID)
  const sourceBelowV7 = (sourceVersion ?? 0) < SCHEMA_VERSION_WITH_NULLABLE_VALUATION
  if (!alreadyAppliedV7 && sourceBelowV7) {
    const upgraded = migrateV6ToV7({ portfolio: current, now: iso })
    current = upgraded.portfolio
    await store.writePortfolio(current)
    await appendLog(store, upgraded.record)
    applied.push(SCHEMA_V6_TO_V7_MIGRATION_ID)
  }

  /*
   * V7 → V8：快照的历史事实字段（估值依据 / 捕获时刻 / 当时是否负债）。
   * **纯零填充**：不改动任何数据 —— 存量快照的新字段保持 undefined，
   * 含义是「无法追溯」，而不是「值为零」。
   */
  const alreadyAppliedV8 = applied.includes(SCHEMA_V7_TO_V8_MIGRATION_ID)
  const sourceBelowV8 = (sourceVersion ?? 0) < SCHEMA_VERSION_WITH_HISTORICAL_FACTS
  if (!alreadyAppliedV8 && sourceBelowV8) {
    const upgraded = migrateV7ToV8({ portfolio: current, now: iso })
    current = upgraded.portfolio
    await store.writePortfolio(current)
    await appendLog(store, upgraded.record)
    applied.push(SCHEMA_V7_TO_V8_MIGRATION_ID)
  }

  await store.writeMeta({
    schemaVersion: target,
    appliedMigrations: applied,
    updatedAt: iso(),
  })
  return { status: 'success', record, portfolio: current, verify }

}

/** 迁移结果的一句话说明，供界面提示 */
export function describeOutcome(outcome: MigrateOutcome): string {
  switch (outcome.status) {
    case 'success':
      return `已迁移 ${outcome.record.counts?.legacyItems ?? 0} 条资产，${summarizeVerify(outcome.verify)}`
    case 'failed':
      return `迁移未完成，已保留原有数据：${outcome.record.error ?? '未知原因'}`
    case 'skipped':
      return outcome.reason === 'already-migrated' ? '数据已是最新结构，无需迁移' : '暂无可迁移的数据'
  }
}
