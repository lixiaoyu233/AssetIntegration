/**
 * Dexie / IndexedDB 库定义
 *
 * 定位：**正式数据存储**。从 Phase 2 起，资产数据（账户/标的/持仓/交易/行情/汇率/快照/配置）
 * 全部存放于 IndexedDB；localStorage 只保留设置类数据与迁移兼容数据。
 *
 * ## 两套「版本号」不要混淆
 *
 * | 名称 | 含义 |
 * | --- | --- |
 * | `PORTFOLIO_SCHEMA_VERSION` | **领域模型**版本（Legacy V2 → Portfolio Schema V3） |
 * | `DB_VERSION` | **Dexie 表结构**版本，只在索引/表变化时递增 |
 *
 * 领域模型升级不等于表结构升级，两者独立演进。
 */

import Dexie, { type Table } from 'dexie'
import type {
  Account,
  AllocationProfile,
  FxRate,
  Holding,
  Instrument,
  Quote,
  Snapshot,
  Transaction,
} from '../../types/portfolio2'
import type { ClassificationAuditEntry } from './repository'

/** Dexie 表结构版本（与 PORTFOLIO_SCHEMA_VERSION 无关） */
export const DB_VERSION = 2

/*
 * 版本历史
 * - v1：初始 8 张业务表 + meta
 * - v2：新增 classificationAudit（分类变更审计）。
 *       仅新增表，不改动既有表结构，因此无需数据搬迁。
 */

export const DB_NAME = 'wealthcard'

/**
 * 表名常量：避免各处硬编码字符串。
 * 注意 holdings / quotes 这类名字与类型名一致，便于对照。
 */
export const TABLES = {
  accounts: 'accounts',
  instruments: 'instruments',
  holdings: 'holdings',
  transactions: 'transactions',
  quotes: 'quotes',
  fxRates: 'fxRates',
  snapshots: 'snapshots',
  allocationProfiles: 'allocationProfiles',
  classificationAudit: 'classificationAudit',
  meta: 'meta',
} as const

export class WealthCardDb extends Dexie {
  accounts!: Table<Account, string>
  instruments!: Table<Instrument, string>
  holdings!: Table<Holding, string>
  transactions!: Table<Transaction, string>
  quotes!: Table<Quote, string>
  fxRates!: Table<FxRate, string>
  snapshots!: Table<Snapshot, string>
  allocationProfiles!: Table<AllocationProfile, string>
  /** 分类变更审计（confirm / unconfirm 都留痕） */
  classificationAudit!: Table<ClassificationAuditEntry, string>
  /** 轻量元信息（已应用的迁移等），与 localStorage 的镜像保持同步 */
  meta!: Table<{ key: string; value: unknown }, string>

  constructor(name = DB_NAME) {
    super(name)
    this.version(DB_VERSION).stores({
      [TABLES.accounts]: 'id, type, region, isLiability',
      [TABLES.instruments]: 'id, symbol, instrumentType, assetClass, currency, region, classificationStatus',
      // accountId / instrumentId 建索引：账户移动、按标的查询、按账户统计都靠它
      [TABLES.holdings]: 'id, accountId, instrumentId, valuationMode',
      [TABLES.transactions]: 'id, accountId, instrumentId, type, timestamp, [accountId+timestamp]',
      [TABLES.quotes]: 'id, instrumentId, status, timestamp, [instrumentId+timestamp]',
      [TABLES.fxRates]: 'id, baseCurrency, quoteCurrency, status, timestamp, [baseCurrency+quoteCurrency]',
      // date 唯一：保证「同一天只有一个 snapshot」
      [TABLES.snapshots]: 'id, &date, createdAt',
      [TABLES.allocationProfiles]: 'id, name',
      [TABLES.meta]: 'key',
    })

    /*
     * v2：新增分类审计表。
     * 只加表，不触碰既有表，Dexie 会自动完成升级。
     */
    this.version(2).stores({
      [TABLES.classificationAudit]: 'id, instrumentId, at, action',
    })
  }
}

let instance: WealthCardDb | null = null

/** 单例：避免同一页面打开多个连接 */
export function getDb(name?: string): WealthCardDb {
  if (!instance || (name && instance.name !== name)) {
    instance = new WealthCardDb(name)
  }
  return instance
}

/** 仅供测试：关闭并重置单例 */
export async function resetDbSingleton(): Promise<void> {
  if (instance) {
    instance.close()
    instance = null
  }
}

/**
 * 请求持久化存储。
 *
 * 为什么需要：iOS Safari 对长期未访问的站点可能清理 IndexedDB。
 * `persist()` 在部分浏览器（尤其 Safari）可能不支持或返回 false —— 这**不阻塞使用**，
 * 由调用方决定是否提示用户「建议定期导出备份」。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** 估算可用空间（供设置页展示），不支持时返回 null */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
    const e = await navigator.storage.estimate()
    if (typeof e.usage !== 'number' || typeof e.quota !== 'number') return null
    return { usage: e.usage, quota: e.quota }
  } catch {
    return null
  }
}
