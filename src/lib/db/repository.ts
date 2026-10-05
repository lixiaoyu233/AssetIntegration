/**
 * Repository 抽象
 *
 * 业务层（估值 / 分析 / 交易）**只依赖本文件的接口**，不直接依赖 Dexie 或 IndexedDB。
 * 这样做的目的：
 * - 测试可以注入内存实现，不必启动 IndexedDB；
 * - 未来若要换存储（或加一层同步/导出），业务层无需改动；
 * - 迁移层只需要 `MigrationStore` 的少量方法，不必知道底层是 Dexie。
 */

import type {
  Account,
  ClassificationAuditEntry,
  AllocationProfile,
  FxRate,
  Holding,
  Instrument,
  Portfolio2,
  Quote,
  Snapshot,
  Transaction,
} from '../../types/portfolio2'

/* ------------------------------------------------------------------ *
 * 通用仓储
 * ------------------------------------------------------------------ */

export interface Repository<T> {
  get(id: string): Promise<T | undefined>
  getAll(): Promise<T[]>
  put(entity: T): Promise<void>
  putMany(entities: T[]): Promise<void>
  remove(id: string): Promise<void>
  count(): Promise<number>
  clear(): Promise<void>
}

export interface HoldingRepository extends Repository<Holding> {
  byAccount(accountId: string): Promise<Holding[]>
  byInstrument(instrumentId: string): Promise<Holding[]>
  /**
   * 把持仓移动/归属到另一个账户。
   *
   * **设计不变量（重要）**：账户拆分 = 修改 `Holding.accountId`，
   * 绝不新建 Holding、绝不复制资产。因此：
   * - 移动后 Holding 总数不变；
   * - 移动后该 holdingId 不变；
   * - 移动前后总资产不变（防止重复计算）。
   */
  moveToAccount(holdingId: string, accountId: string): Promise<void>
}

export interface InstrumentRepository extends Repository<Instrument> {
  bySymbol(symbol: string): Promise<Instrument[]>
  /** 未确认分类的标的，供 UI 提示用户确认 */
  unconfirmed(): Promise<Instrument[]>

  /**
   * **确认单个标的的分类**（用户主动操作）。
   *
   * `assetClass` 是**必填**的：对未确认的标的，
   * **绝不允许**用 `assetClass ?? 现有值` 这种方式在用户没做出选择时自动确认。
   * 用户必须明确指定类别，这一步才成立。
   *
   * 只修改两个字段：`assetClass` 与 `classificationStatus`。
   * **绝不触碰** Holding.quantity / Holding.costBasis / Transaction / Snapshot / valuationMode。
   *
   * 必须产生一条 `ClassificationAuditEntry`。
   */
  confirmOne(instrumentId: string, assetClass: Instrument['assetClass']): Promise<Instrument>

  /**
   * **撤销确认**（用户主动操作，用于纠错）。
   *
   * 回到 `classificationStatus = 'unconfirmed'`，`assetClass` 保持原值作为线索。
   * 同样必须产生审计条目 —— 审计链不能只有 confirm 而没有 unconfirm。
   */
  unconfirm(instrumentId: string): Promise<Instrument>

  /**
   * 批量确认（要求每个 id 都明确给出目标类别，不接受「沿用现有值」）。
   */
  confirmMany(entries: Array<{ id: string; assetClass: Instrument['assetClass'] }>): Promise<Instrument[]>

  /** 分类变更审计记录（按时间升序） */
  classificationLog(): Promise<ClassificationAuditEntry[]>

  /**
   * @deprecated 兼容别名，内部等价于 `confirmMany`。
   * 新代码请使用 `confirmOne` / `confirmMany` —— 它们要求明确指定类别，
   * 且同样产生审计条目。
   */
  confirmClassification(ids: string[], assetClass: Instrument['assetClass']): Promise<void>
}

/**
 * 分类变更审计条目。
 *
 * 定义在领域模型里（`types/portfolio2.ts`），此处仅做 re-export，
 * 避免同一结构两处维护而漂移。
 */
export type { ClassificationAuditEntry } from '../../types/portfolio2'

export interface QuoteRepository extends Repository<Quote> {
  latestFor(instrumentId: string): Promise<Quote | undefined>
  byStatus(status: Quote['status']): Promise<Quote[]>
}

export interface FxRateRepository extends Repository<FxRate> {
  pair(base: string, quote: string): Promise<FxRate[]>
  /**
   * 覆盖写入「同一币种对同来源」的记录。
   *
   * ⚠️ **Phase 8 / W8 起不再用于正常录入路径**：它会删除该币种对同来源的
   * **全部历史汇率**，使「当时的汇率」不可追溯（W8 审计 P0-3）。
   * 录入请改用 `upsertFxRate()`（按业务键去重追加）。
   * 本方法保留给「清理重复来源」这类显式运维场景。
   */
  upsertLatest(rate: FxRate): Promise<void>
}

/**
 * 轻量键值状态仓储（`meta` 表）。
 *
 * ⚠️ **只允许放「操作状态」，绝不允许放资产事实**。
 *
 * 当前用途：每日快照的「今日是否已尝试」标记。
 * 为什么放这里而不是新建表：它就是一个键值状态，
 * `meta` 表本来就是干这个的（迁移记录也在其中），
 * 不为一个标记再建立一套体系。
 */
export interface MetaKeyValueRepository {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  /** 按前缀列出键（用于清理过期状态） */
  keysWithPrefix(prefix: string): Promise<string[]>
}

export interface SnapshotRepository extends Repository<Snapshot> {
  byDate(date: string): Promise<Snapshot | undefined>
  /**
   * 目标日期**之前**最近的一份快照（不含该日）。
   *
   * 为什么需要（Phase 8 / W9，P1-1）：`captureSnapshot` 找期初时
   * 原先调用 `getAll()` 把**整张快照表**读进内存再排序取首 ——
   * 而每次开 App / 每次写入都会走这条路。快照表是随时间无界增长的
   * （每天 +1，全仓无裁剪），这让「找期初」的代价随使用年限线性上升。
   *
   * 有了它就能**借助 `date` 索引直接定位**，不materialize 全表。
   */
  previousBefore(date: string): Promise<Snapshot | undefined>
  /**
   * 幂等写入：同一天只保留一条。
   * 已存在则**更新**（保留原 createdAt），不存在才插入。
   */
  upsertForDate(snapshot: Snapshot): Promise<void>
  range(fromDate: string, toDate: string): Promise<Snapshot[]>
}

export interface TransactionRepository extends Repository<Transaction> {
  byAccount(accountId: string): Promise<Transaction[]>
  byInstrument(instrumentId: string): Promise<Transaction[]>
  range(fromISO: string, toISO: string): Promise<Transaction[]>
}

/* ------------------------------------------------------------------ *
 * 聚合入口
 * ------------------------------------------------------------------ */

/**
 * 业务层使用的主入口。
 *
 * `loadPortfolio()` 一次性取出估值/分析所需的全部数据。
 * 之所以允许整取：个人资产规模有限（数百条持仓），
 * 一次性读取比多次异步往返更简单可靠；数据量增长后可再分片。
 */
/**
 * `replaceAll` 的可选参数（Phase 8 / W7）。
 *
 * W7 审计发现：原实现只替换 8 张表，**不含 `classificationAudit` 与 `meta`**。
 * 后果：从旧备份恢复后，审计条目指向已不存在的标的（引用悬空），
 * 且 `meta` 里的迁移记录与导入数据的版本错配
 * （会出现「记录说已迁移但数据是旧版本」）。
 *
 * 因此恢复路径必须能够一并替换这两张表。
 */
export interface ReplaceAllOptions {
  /**
   * 是否连同 `classificationAudit` 一起替换。
   * 缺省 `true`（恢复语义：整体替换）；迁移/转换等场景可显式传 `false` 保留审计。
   */
  replaceAudit?: boolean
  /**
   * 要写入的 `meta` 键值。给出时**先清空 meta 再写入**，保证版本标记与数据一致。
   * 不给出时保持 meta 不变（迁移场景需要保留 appliedMigrations）。
   */
  metaKv?: Record<string, unknown>
}

export interface PortfolioRepository {
  /** 分类审计（独立于 Instrument，便于追溯全部历史变更） */
  classificationAudit: Repository<ClassificationAuditEntry>
  accounts: Repository<Account>
  instruments: InstrumentRepository
  holdings: HoldingRepository
  transactions: TransactionRepository
  quotes: QuoteRepository
  fxRates: FxRateRepository
  snapshots: SnapshotRepository
  allocationProfiles: Repository<AllocationProfile>
  /** 轻量操作状态（非资产事实），见 `MetaKeyValueRepository` 注释 */
  metaKv: MetaKeyValueRepository

  /** 取出完整组合（供估值/分析使用） */
  loadPortfolio(): Promise<Portfolio2>
  /** 整批替换（迁移用）；实现方应在事务中完成 */
  replaceAll(portfolio: Portfolio2, options?: ReplaceAllOptions): Promise<void>
  /** 全清（导入前备份等场景） */
  clearAll(): Promise<void>
  /** 统计各表条数，供诊断与迁移校验 */
  counts(): Promise<Record<string, number>>
}

/* ------------------------------------------------------------------ *
 * 迁移层所需的最小接口
 * ------------------------------------------------------------------ */

/**
 * 迁移调度只依赖这个窄接口。
 *
 * 与 1.x 的 `MigrationStore` 相比，方法变为异步（Dexie 是 Promise API），
 * 但语义不变：**迁移失败时不写元信息、不删除旧数据**。
 */
export interface MigrationStore {
  readMeta(): Promise<{ schemaVersion: number; appliedMigrations: string[]; updatedAt: string } | null>
  writeMeta(meta: { schemaVersion: number; appliedMigrations: string[]; updatedAt: string }): Promise<void>
  readLog(): Promise<import('./schema').MigrationRecord[]>
  writeLog(records: import('./schema').MigrationRecord[]): Promise<void>
  writePortfolio(portfolio: Portfolio2): Promise<void>
  readPortfolio(): Promise<Portfolio2 | null>
}
