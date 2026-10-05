/**
 * Schema 版本与迁移元信息
 *
 * ## 命名约定（重要）
 *
 * 这里存在**两套互不相干的版本号**，早期命名曾把它们混在一起，故在此明确：
 *
 * | 名称 | 含义 | 取值 |
 * | --- | --- | --- |
 * | `LEGACY_PORTFOLIO_VERSION` | **旧应用数据版本**：1.x 时期 `Portfolio.version`，旧数据里就是 `2` | `2` |
 * | `PORTFOLIO_SCHEMA_VERSION` | **新持久化 Schema 版本**：accounts/holdings/… 这套结构 | `6` |
 *
 * 因此迁移链条是 **Legacy V2 → V3 → V4 → V5 → V6 → V7 → V8**。
 *
 * ### V3 → V4 的唯一变更
 *
 * `SnapshotPosition` 增加可选字段 `assetClassAtCapture`，
 * 用于让**未来的**历史配置趋势使用「当时的分类」而不是今天的分类。
 *
 * ⚠️ 该迁移是**零填充**的：存量 v3 快照**不会**被回填该字段，
 * 因为那等于用今天的分类伪造历史事实。
 * 旧快照的 `assetClassAtCapture` 保持 `undefined`，
 * UI 必须明确显示「历史分类数据不可用」，允许历史图存在数据缺口。
 * 之所以新 schema 从 3 开始：旧数据的 `version: 2` 已经占用了 2，
 * 若新 schema 也叫 2，迁移记录与诊断信息里会出现两个「2」而无法区分。
 *
 * 迁移 id 形如 `legacy-v2-to-schema-v3`，可读且无歧义。
 */

import type { IsoDateTime } from '../../types/portfolio2'

/* ------------------------------------------------------------------ *
 * 版本常量
 * ------------------------------------------------------------------ */

/** 旧应用数据版本（1.x 的 Portfolio.version，实际为 2） */
export const LEGACY_PORTFOLIO_VERSION = 2

/** 新持久化 Schema 版本 */
export const PORTFOLIO_SCHEMA_VERSION = 8

/** 引入 Snapshot.captureKind 的版本（v4 及以前没有该字段） */
export const SCHEMA_VERSION_WITH_CAPTURE_KIND = 5

/** 引入 Transaction.status（作废机制）的版本（v5 及以前没有该字段） */
export const SCHEMA_VERSION_WITH_TRANSACTION_STATUS = 6

/**
 * 引入「不可估值字段可缺失」的版本（Schema V7）。
 *
 * 从 V7 起 `SnapshotPosition` 的 `price` / `rateToCny` / `valueCny` 可以为 `undefined`，
 * 表示「不可估值 / 汇率不可解析」，**不再用 0 或 1 伪造**。
 *
 * 为什么必须区分：`valueCny: 0` 脱离 `reliable` 标记后与「真的不值钱」无法区分，
 * 违反核心不变量「不可估值 ≠ 价值为 0」。
 */
export const SCHEMA_VERSION_WITH_NULLABLE_VALUATION = 7

/**
 * 引入「历史事实完整性」字段的版本（Schema V8 / Phase 8 W8）。
 *
 * 新增的全部是**可选字段**，用于让历史快照能够自证：
 *
 * `SnapshotPosition`
 * - `asOf` / `priceKind` / `quoteStatus` / `quoteSource` —— 估值依据
 * - `fxStatus` / `fxSource` —— 汇率依据
 * - `reasons` —— 降级原因（不再是单一 `reliable` 布尔）
 * - `staleValueCny` —— 过期时的展示价（不参与总额）
 * - `isLiabilityAtCapture` —— 捕获当时是否负债
 *
 * `Snapshot`
 * - `openingDate` —— 期初快照日期（可自证间隔）
 * - `capturedAt` —— 内容对应的捕获时刻
 */
export const SCHEMA_VERSION_WITH_HISTORICAL_FACTS = 8

/** 引入 assetClassAtCapture 的版本（v3 及以前没有该字段） */
export const SCHEMA_VERSION_WITH_ASSET_CLASS_AT_CAPTURE = 4

/** V3 → V4 迁移的幂等标识（与 migrations/schema-v3-to-v4.ts 保持一致） */
export const SCHEMA_V3_TO_V4_MIGRATION_ID = 'schema-v3-to-v4-asset-class-at-capture'

/** 兼容别名：早期代码引用 SCHEMA_VERSION，语义等同 PORTFOLIO_SCHEMA_VERSION */
export const SCHEMA_VERSION = PORTFOLIO_SCHEMA_VERSION

/** 新库在 localStorage 中只保留轻量元信息 */
export const DB_META_KEY = 'wealthcard/db-meta/v1'

/** 迁移记录单独存放，便于失败排查与重复执行判断 */
export const MIGRATION_LOG_KEY = 'wealthcard/migration-log/v1'

/* ------------------------------------------------------------------ *
 * 结构族与迁移记录
 * ------------------------------------------------------------------ */

/** 结构族：用来判断「这份数据是哪一代」，不依赖 version 字段 */
export type SchemaFamily = 'legacy' | 'current' | 'unknown'

export type MigrationStatus = 'success' | 'partial' | 'failed' | 'skipped'

/**
 * 一次迁移的完整记录。
 * 至少包含 sourceSchemaVersion / targetSchemaVersion / migrationTime / migrationStatus。
 */
export interface MigrationRecord {
  /** 幂等标识，形如 legacy-v2-to-schema-v3 */
  migrationId: string
  /** 源：旧应用数据版本 */
  sourceSchemaVersion: number
  /** 目标：新持久化 Schema 版本 */
  targetSchemaVersion: number
  /** 人类可读的源结构标识 */
  sourceFamily: SchemaFamily
  /** 源版本可读名，如 "Legacy V2" */
  sourceLabel: string
  /** 目标版本可读名，如 "Portfolio Schema V3" */
  targetLabel: string
  migrationTime: IsoDateTime
  status: MigrationStatus
  /** 补充说明（例如「未回填历史分类」） */
  note?: string
  error?: string
  warnings?: string[]
  counts?: MigrationCounts
}

export interface MigrationCounts {
  accounts: number
  instruments: number
  holdings: number
  transactions: number
  quotes: number
  /** 旧数据条目总数 */
  legacyItems: number
  /** 迁移后落到 Holding 的数量，正常应等于 legacyItems */
  migratedHoldings: number
  /** 未确认分类的数量 */
  unconfirmed: number
}

/** 新库元信息 */
export interface DbMeta {
  schemaVersion: number
  /** 已完成的迁移 id，保证可重复执行 */
  appliedMigrations: string[]
  updatedAt: IsoDateTime
}

export function createDefaultDbMeta(): DbMeta {
  return {
    schemaVersion: PORTFOLIO_SCHEMA_VERSION,
    appliedMigrations: [],
    updatedAt: new Date().toISOString(),
  }
}

/** 版本可读名，用于日志与诊断 */
export const LEGACY_VERSION_LABEL = `Legacy V${LEGACY_PORTFOLIO_VERSION}`
export const SCHEMA_VERSION_LABEL = `Portfolio Schema V${PORTFOLIO_SCHEMA_VERSION}`

/** 按版本号取标签，便于迁移记录里标注任意版本 */
export function schemaVersionLabel(v: number): string {
  return `Portfolio Schema V${v}`
}

/**
 * 迁移 id 约定：`legacy-v{source}-to-schema-v{target}`。
 *
 * ⚠️ 注意 target 是**当前 schema 目标版本**，未必是一步到位的版本。
 * 例如 Legacy V2 → Schema V4 的实际执行是链式的：
 *
 * ```
 * legacy-v2-to-schema-v3  →  schema-v3-to-v4-asset-class-at-capture
 * ```
 *
 * 因此迁移 id 只表达「从哪来、到哪去」，
 * 中间步骤由 `MigrationRecord` 日志逐条记录（见 MIGRATION_CHAIN_LABEL）。
 */
export function migrationIdFor(source: number, target: number): string {
  return `legacy-v${source}-to-schema-v${target}`
}

/**
 * 当前**完整迁移链**的可读描述，供诊断与 UI 展示。
 * 每一步都在 migration log 里各有一条记录，便于精确排查是哪一步失败。
 */
export const SCHEMA_V4_TO_V5_MIGRATION_ID = 'schema-v4-to-v5-capture-kind'
export const SCHEMA_V5_TO_V6_MIGRATION_ID = 'schema-v5-to-v6-transaction-status'
export const SCHEMA_V6_TO_V7_MIGRATION_ID = 'schema-v6-to-v7-nullable-valuation'
export const SCHEMA_V7_TO_V8_MIGRATION_ID = 'schema-v7-to-v8-historical-facts'

export const MIGRATION_CHAIN: readonly string[] = [
  /*
   * ⚠️ 首项必须与运行时实际写入的 id **一致**：
   * `migrate()` 用 `migrationIdFor(LEGACY_PORTFOLIO_VERSION, PORTFOLIO_SCHEMA_VERSION)`。
   * 早期这里硬编码为 `legacy-v2-to-schema-v3`，一旦 Schema 版本升到 V7
   * 就与真实记录不符 —— 常量与运行时会静默分叉。
   * 因此改为由同一个函数推导，彻底消除不一致。
   */
  migrationIdFor(LEGACY_PORTFOLIO_VERSION, PORTFOLIO_SCHEMA_VERSION),
  SCHEMA_V3_TO_V4_MIGRATION_ID,
  SCHEMA_V4_TO_V5_MIGRATION_ID,
  SCHEMA_V5_TO_V6_MIGRATION_ID,
  SCHEMA_V6_TO_V7_MIGRATION_ID,
  SCHEMA_V7_TO_V8_MIGRATION_ID,
]

/** 迁移链条的一句话说明 */
export function describeMigrationChain(): string {
  return `Legacy V${LEGACY_PORTFOLIO_VERSION} → ${schemaVersionLabel(3)} → ${schemaVersionLabel(4)} → ${schemaVersionLabel(5)} → ${schemaVersionLabel(6)} → ${schemaVersionLabel(7)} → ${schemaVersionLabel(PORTFOLIO_SCHEMA_VERSION)}`
}

/* ------------------------------------------------------------------ *
 * 结构识别
 * ------------------------------------------------------------------ */

/**
 * 判断一份原始数据的结构族。
 *
 * 必须靠**结构特征**而不是 `version` 字段：旧数据的 `version` 是 2，
 * 单靠数字无法区分新旧结构。
 */
export function detectSchemaFamily(raw: unknown): SchemaFamily {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown'
  const o = raw as Record<string, unknown>

  // 新结构特征：有 accounts + holdings 数组
  if (Array.isArray(o.accounts) && Array.isArray(o.holdings)) return 'current'

  // 旧结构特征：有 categories 数组
  if (Array.isArray(o.categories)) return 'legacy'

  return 'unknown'
}

/** 由结构族推断源版本；current 返回当前 schema 版本 */
export function detectSourceVersion(raw: unknown): number | null {
  const family = detectSchemaFamily(raw)
  if (family === 'legacy') return LEGACY_PORTFOLIO_VERSION
  if (family === 'current') return PORTFOLIO_SCHEMA_VERSION
  return null
}
