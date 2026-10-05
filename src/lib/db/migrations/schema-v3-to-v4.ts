/**
 * 迁移：Schema V3 → V4
 *
 * ## 唯一的变更
 *
 * `SnapshotPosition` 新增可选字段 `assetClassAtCapture`，
 * 使**未来的**历史配置趋势能够使用「捕获当时的分类」。
 *
 * ## 本迁移是「零填充」的（关键约束）
 *
 * 它**不会**给存量快照回填任何分类：
 *
 * ```
 * 存量 v3 快照：positions[i].assetClassAtCapture === undefined   ← 保持不动
 * 新捕获 v4 快照：positions[i].assetClassAtCapture === <当时的 assetClass>
 * ```
 *
 * 为什么不回填：`Instrument.assetClass` 是**当前**值，
 * 用它回填历史等于**用今天的分类伪造历史事实**。
 * 用户可能是在几个月后才确认分类的，那时过去的历史并非如此。
 *
 * 因此旧快照保留 `undefined`，由 UI 明确显示
 * 「历史分类数据不可用」，允许历史图存在数据缺口。
 *
 * ## 本迁移不修改任何金额字段
 *
 * `totalAssets` / `netWorth` / `positions[].valueCny` 等**一律不动**，
 * 因此迁移前后资产总额必须完全一致（有测试锁定）。
 */

import type { Portfolio2, Snapshot, SnapshotPosition } from '../../../types/portfolio2'
import {
  PORTFOLIO_SCHEMA_VERSION,
  SCHEMA_V3_TO_V4_MIGRATION_ID,
  SCHEMA_VERSION_WITH_ASSET_CLASS_AT_CAPTURE,
  schemaVersionLabel,
  type MigrationRecord,
} from '../schema'

export { SCHEMA_V3_TO_V4_MIGRATION_ID }

export interface SchemaV3ToV4Result {
  portfolio: Portfolio2
  record: MigrationRecord
  /** 受影响的快照数（仅统计，表示「已确认无需回填」） */
  snapshotCount: number
  /** 明确标记为「历史分类不可用」的快照 id */
  unavailableClassSnapshotIds: string[]
}

/** 检测是否是 v3（尚无 assetClassAtCapture 的形态） */
export function needsAssetClassAtCaptureMigration(portfolio: Portfolio2): boolean {
  return portfolio.snapshots.some((snap) =>
    snap.positions.some((p) => !('assetClassAtCapture' in p) || p.assetClassAtCapture === undefined),
  )
}

/**
 * 执行 V3 → V4。
 *
 * 该函数**不注入时钟**也没有随机性 —— 它是**幂等的纯数据结构声明**：
 * 两次执行结果完全一致，因为它**什么都不改**，只是把版本号推到 v4
 * 并记录「旧快照的分类不可用」这一事实。
 */
export function migrateV3ToV4(input: {
  portfolio: Portfolio2
  now?: () => string
}): SchemaV3ToV4Result {
  const now = input.now ?? (() => new Date().toISOString())
  const ts = now()

  const shortageIds: string[] = []

  const snapshots: Snapshot[] = input.portfolio.snapshots.map((snap) => {
    let touched = false
    const positions: SnapshotPosition[] = snap.positions.map((p) => {
      if (p.assetClassAtCapture !== undefined) return p
      /*
       * 这里**刻意什么都不写**。
       *
       * 不从 `Instrument` 查当前分类来回填 —— 那会伪造历史。
       * 只记录「这条快照的分类数据不可用」这一事实。
       */
      touched = true
      return p
    })
    if (touched) shortageIds.push(snap.id)
    return { ...snap, positions }
  })

  const record: MigrationRecord = {
    migrationId: SCHEMA_V3_TO_V4_MIGRATION_ID,
    sourceSchemaVersion: SCHEMA_VERSION_WITH_ASSET_CLASS_AT_CAPTURE - 1,
    targetSchemaVersion: PORTFOLIO_SCHEMA_VERSION,
    sourceLabel: schemaVersionLabel(SCHEMA_VERSION_WITH_ASSET_CLASS_AT_CAPTURE - 1),
    targetLabel: schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION),
    migrationTime: ts,
    status: 'success',
    sourceFamily: 'current',
    // 便于诊断：明确写出「未回填」而不是留空
    note: `已升级到 ${schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION)}；${shortageIds.length} 份历史快照缺少分类快照，标记为「历史分类数据不可用」（不回填，避免伪造历史）`,
  }

  return {
    portfolio: { ...input.portfolio, snapshots },
    record,
    snapshotCount: snapshots.length,
    unavailableClassSnapshotIds: shortageIds,
  }
}

/* ------------------------------------------------------------------ *
 * 读取辅助：历史趋势必须能识别缺口
 * ------------------------------------------------------------------ */

/**
 * 某份快照是否具备可用的历史分类。
 *
 * `false` 表示该快照的 `positions` 里**至少有一条**没有 `assetClassAtCapture`，
 * 因此**不能**用于按分类统计历史趋势 —— 否则就会用到今天的分类。
 */
export function hasHistoricalClassification(snapshot: Snapshot): boolean {
  if (snapshot.positions.length === 0) return false
  return snapshot.positions.every((p) => p.assetClassAtCapture !== undefined)
}

/** 该快照按分类聚合的结果；缺分类时返回 `undefined` 并说明原因 */
export function assetClassCompositionAtCapture(
  snapshot: Snapshot,
): { ok: true; byClass: Partial<Record<string, number>> } | { ok: false; reason: string } {
  if (snapshot.positions.length === 0) {
    return { ok: false, reason: '该快照没有持仓明细' }
  }
  const missing = snapshot.positions.filter((p) => p.assetClassAtCapture === undefined)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `该快照有 ${missing.length} 条持仓未记录当时的分类，历史分类数据不可用`,
    }
  }
  const byClass: Partial<Record<string, number>> = {}
  for (const p of snapshot.positions) {
    // 不可靠 / 缺金额的项不参与分类汇总（缺金额不得当 0）
    if (!p.reliable || p.valueCny === undefined) continue
    const cls = p.assetClassAtCapture as string
    byClass[cls] = (byClass[cls] ?? 0) + p.valueCny
  }
  return { ok: true, byClass }
}
