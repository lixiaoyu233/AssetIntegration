/**
 * Dexie 版 Repository 实现
 *
 * 只在本文件里出现 Dexie；业务层通过 `repository.ts` 的接口使用。
 */

import type {
  Account,
  AllocationProfile,
  FxRate,
  Holding,
  Instrument,
  Portfolio2,
  Quote,
  Snapshot,
  Transaction,
} from '../../types/portfolio2'
import { createEmptyPortfolio2 } from '../../types/portfolio2'
import { type WealthCardDb, getDb } from './dexie'
import type {
  ClassificationAuditEntry,
  MetaKeyValueRepository,
  FxRateRepository,
  HoldingRepository,
  InstrumentRepository,
  PortfolioRepository,
  QuoteRepository,
  ReplaceAllOptions,
  Repository,
  SnapshotRepository,
  TransactionRepository,
} from './repository'

/* ------------------------------------------------------------------ *
 * 通用实现
 * ------------------------------------------------------------------ */

function createRepository<T extends { id: string }>(
  table: () => import('dexie').Table<T, string>,
): Repository<T> {
  return {
    get: (id) => table().get(id),
    getAll: () => table().toArray(),
    put: async (entity) => {
      await table().put(entity)
    },
    putMany: async (entities) => {
      if (entities.length === 0) return
      await table().bulkPut(entities)
    },
    remove: async (id) => {
      await table().delete(id)
    },
    count: () => table().count(),
    clear: async () => {
      await table().clear()
    },
  }
}

/* ------------------------------------------------------------------ *
 * 各自的扩展实现
 * ------------------------------------------------------------------ */

function createHoldingRepository(db: () => WealthCardDb): HoldingRepository {
  const base = createRepository<Holding>(() => db().holdings)
  return {
    ...base,
    byAccount: (accountId) => db().holdings.where('accountId').equals(accountId).toArray(),
    byInstrument: (instrumentId) => db().holdings.where('instrumentId').equals(instrumentId).toArray(),
    /**
     * 账户拆分：**原地修改 accountId**。
     * 只改这一个字段，因此 Holding 总数、id、金额都不变 —— 不会产生重复资产。
     */
    moveToAccount: async (holdingId, accountId) => {
      const h = await db().holdings.get(holdingId)
      if (!h) throw new Error(`持仓不存在：${holdingId}`)
      await db().holdings.put({ ...h, accountId, updatedAt: new Date().toISOString() })
    },
  }
}

function createInstrumentRepository(db: () => WealthCardDb): InstrumentRepository {
  const base = createRepository<Instrument>(() => db().instruments)
  return {
    ...base,
    bySymbol: (symbol) => db().instruments.where('symbol').equals(symbol).toArray(),
    unconfirmed: () => db().instruments.where('classificationStatus').equals('unconfirmed').toArray(),

    /* ---------------- 确认单个分类 ---------------- */
    confirmOne: async (instrumentId, assetClass) => {
      /*
       * `assetClass` 是必填参数（类型层面就无法省略）。
       * 这里**刻意不做** `assetClass ?? inst.assetClass` 兜底 ——
       * 那会在用户没有做出选择的情况下自动确认，属于「自动分类」，明令禁止。
       */
      if (!assetClass) {
        throw new Error('确认分类必须由用户明确指定 assetClass，不允许沿用未确认的线索值')
      }
      let updated: Instrument | undefined
      await db().transaction('rw', db().instruments, db().classificationAudit, async () => {
        const inst = await db().instruments.get(instrumentId)
        if (!inst) throw new Error(`标的不存在: ${instrumentId}`)
        updated = {
          ...inst,
          assetClass,
          classificationStatus: 'confirmed',
          classificationSource: 'user_confirmed',
          updatedAt: new Date().toISOString(),
        }
        await db().instruments.put(updated)
        await appendAudit(db, { instrumentId, from: inst, to: updated, action: 'confirm' })
      })
      return updated as Instrument
    },

    /* ---------------- 撤销确认 ---------------- */
    unconfirm: async (instrumentId) => {
      let updated: Instrument | undefined
      await db().transaction('rw', db().instruments, db().classificationAudit, async () => {
        const inst = await db().instruments.get(instrumentId)
        if (!inst) throw new Error(`标的不存在: ${instrumentId}`)
        updated = {
          ...inst,
          // 回到未确认；assetClass 保留原值**仅作线索**，不再被当成事实
          classificationStatus: 'unconfirmed',
          classificationSource: undefined,
          updatedAt: new Date().toISOString(),
        }
        await db().instruments.put(updated)
        await appendAudit(db, { instrumentId, from: inst, to: updated, action: 'unconfirm' })
      })
      // 审计链必须完整：unconfirm 同样留痕
      return updated as Instrument
    },

    /* ---------------- 批量确认 ---------------- */
    confirmMany: async (entries) => {
      if (entries.length === 0) return []
      for (const e of entries) {
        if (!e.assetClass) {
          throw new Error(`批量确认必须为 ${e.id} 明确指定 assetClass`)
        }
      }
      const out: Instrument[] = []
      await db().transaction('rw', db().instruments, db().classificationAudit, async () => {
        for (const e of entries) {
          const inst = await db().instruments.get(e.id)
          if (!inst) continue
          const next: Instrument = {
            ...inst,
            assetClass: e.assetClass,
            classificationStatus: 'confirmed',
            classificationSource: 'user_confirmed',
            updatedAt: new Date().toISOString(),
          }
          await db().instruments.put(next)
          await appendAudit(db, { instrumentId: e.id, from: inst, to: next, action: 'confirm_many' })
          out.push(next)
        }
      })
      return out
    },

    /* ---------------- 审计日志 ---------------- */
    classificationLog: async () => {
      const list = await db().classificationAudit.toArray()
      return list.sort((a, b) => a.at.localeCompare(b.at))
    },

    /**
     * @deprecated 兼容别名。
     *
     * 内部实现与 `confirmMany` 相同（同一事务 + 审计留痕），
     * 但**直接写实现**而不是再调 `createInstrumentRepository`，避免递归建对象。
     */
    confirmClassification: async (ids, assetClass) => {
      if (ids.length === 0) return
      await db().transaction('rw', db().instruments, db().classificationAudit, async () => {
        for (const id of ids) {
          const inst = await db().instruments.get(id)
          if (!inst) continue
          const next: Instrument = {
            ...inst,
            assetClass,
            classificationStatus: 'confirmed',
            classificationSource: 'user_confirmed',
            updatedAt: new Date().toISOString(),
          }
          await db().instruments.put(next)
          await appendAudit(db, { instrumentId: id, from: inst, to: next, action: 'confirm_many' })
        }
      })
    },
  }
}

/**
 * `meta` 表的键值仓储实现。
 *
 * ⚠️ 只放操作状态，不放资产事实。
 */
function createMetaKvRepository(db: () => WealthCardDb): MetaKeyValueRepository {
  return {
    get: async <T,>(key: string) => {
      const row = await db().meta.get(key)
      return row?.value as T | undefined
    },
    set: async (key, value) => {
      await db().meta.put({ key, value })
    },
    remove: async (key) => {
      await db().meta.delete(key)
    },
    keysWithPrefix: async (prefix) => {
      const keys = await db().meta.toCollection().primaryKeys()
      return (keys as string[]).filter((k) => k.startsWith(prefix))
    },
  }
}

/** 写入一条审计记录（confirm / unconfirm 共用，保证链路完整） */
async function appendAudit(
  db: () => WealthCardDb,
  input: {
    instrumentId: string
    from: Instrument
    to: Instrument
    action: ClassificationAuditEntry['action']
  },
): Promise<void> {
  const entry: ClassificationAuditEntry = {
    id: `cls_${input.instrumentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    instrumentId: input.instrumentId,
    from: { assetClass: input.from.assetClass, status: input.from.classificationStatus },
    to: { assetClass: input.to.assetClass, status: input.to.classificationStatus },
    at: new Date().toISOString(),
    action: input.action,
  }
  await db().classificationAudit.put(entry)
}

function createQuoteRepository(db: () => WealthCardDb): QuoteRepository {
  const base = createRepository<Quote>(() => db().quotes)
  return {
    ...base,
    latestFor: async (instrumentId) => {
      const list = await db().quotes.where('instrumentId').equals(instrumentId).toArray()
      if (list.length === 0) return undefined
      return list.reduce((a, b) =>
        new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b,
      )
    },
    byStatus: (status) => db().quotes.where('status').equals(status).toArray(),
  }
}

function createFxRateRepository(db: () => WealthCardDb): FxRateRepository {
  const base = createRepository<FxRate>(() => db().fxRates)
  return {
    ...base,
    pair: (base_, quote) =>
      db().fxRates.where('[baseCurrency+quoteCurrency]').equals([base_, quote]).toArray(),
    /** 同一币种对 + 同来源只保留最新一条，防止汇率记录无限膨胀 */
    upsertLatest: async (rate) => {
      const existing = await db()
        .fxRates.where('[baseCurrency+quoteCurrency]')
        .equals([rate.baseCurrency, rate.quoteCurrency])
        .toArray()
      const stale = existing.filter((r) => r.source === rate.source)
      await db().transaction('rw', db().fxRates, async () => {
        if (stale.length > 0) await db().fxRates.bulkDelete(stale.map((r) => r.id))
        await db().fxRates.put(rate)
      })
    },
  }
}

function createSnapshotRepository(db: () => WealthCardDb): SnapshotRepository {
  const base = createRepository<Snapshot>(() => db().snapshots)
  return {
    ...base,
    byDate: (date) => db().snapshots.where('date').equals(date).first(),
    /*
     * 借 `&date` 索引反向取「小于目标日期」的**第一条**（= 最近的一份）。
     *
     * ## 为什么必须用 `.first()` 而不是 `.sortBy()`（Phase 8 / W10-Patch，P1-2）
     *
     * W9 曾写 `.below(date).reverse().sortBy('date').then(r => r[0])`，
     * 并注释「不读取整表，代价与快照总数脱钩」—— **该断言不成立**：
     * Dexie 的 `Collection.sortBy` 实现是 `this.toArray(...)` 后再
     * `slice().sort(...)`，即**把整个区间 materialize 到内存并全排序**，
     * 与旧实现（`getAll()` + filter + sort）同阶。
     *
     * `.reverse()` 只改变游标方向、不改变「取多少」；真正让它只读一条的是
     * **`.first()`** —— 它直接让游标取第一条即停止。
     */
    previousBefore: (date) =>
      db()
        .snapshots.where('date')
        .below(date)
        .reverse()
        .first(),
    /**
     * 幂等：同一天只保留一条。
     * 已存在则更新（保留原 id 与 createdAt），否则插入 —— 满足「重复生成不新增」的要求。
     */
    upsertForDate: async (snapshot) => {
      const existing = await db().snapshots.where('date').equals(snapshot.date).first()
      if (existing) {
        await db().snapshots.put({ ...snapshot, id: existing.id, createdAt: existing.createdAt })
      } else {
        await db().snapshots.put(snapshot)
      }
    },
    range: (fromDate, toDate) =>
      db().snapshots.where('date').between(fromDate, toDate, true, true).sortBy('date'),
  }
}

function createTransactionRepository(db: () => WealthCardDb): TransactionRepository {
  const base = createRepository<Transaction>(() => db().transactions)
  return {
    ...base,
    byAccount: (accountId) => db().transactions.where('accountId').equals(accountId).toArray(),
    byInstrument: (instrumentId) => db().transactions.where('instrumentId').equals(instrumentId).toArray(),
    range: (fromISO, toISO) =>
      db().transactions.where('timestamp').between(fromISO, toISO, true, true).sortBy('timestamp'),
  }
}

/* ------------------------------------------------------------------ *
 * 聚合实现
 * ------------------------------------------------------------------ */

export function createDexieRepository(db: WealthCardDb = getDb()): PortfolioRepository {
  const get = () => db

  const repo: PortfolioRepository = {
    accounts: createRepository<Account>(() => get().accounts),
    instruments: createInstrumentRepository(get),
    holdings: createHoldingRepository(get),
    transactions: createTransactionRepository(get),
    quotes: createQuoteRepository(get),
    fxRates: createFxRateRepository(get),
    snapshots: createSnapshotRepository(get),
    allocationProfiles: createRepository<AllocationProfile>(() => get().allocationProfiles),
    classificationAudit: createRepository<ClassificationAuditEntry>(() => get().classificationAudit),
    metaKv: createMetaKvRepository(get),

    async loadPortfolio(): Promise<Portfolio2> {
      const [accounts, instruments, holdings, transactions, quotes, fxRates, snapshots, allocationProfiles, classificationAudit] =
        await Promise.all([
          get().accounts.toArray(),
          get().instruments.toArray(),
          get().holdings.toArray(),
          get().transactions.toArray(),
          get().quotes.toArray(),
          get().fxRates.toArray(),
          get().snapshots.toArray(),
          get().allocationProfiles.toArray(),
          get().classificationAudit.toArray(),
        ])
      return {
        accounts, instruments, holdings, transactions, quotes, fxRates, snapshots, allocationProfiles,
        classificationAudit,
      }
    },

    /**
     * 整批替换：在单个事务内完成，避免中途失败留下半套数据。
     *
     * ## ⚠️ 这不是「导入」原语
     *
     * 它是**先 clear 再 bulkPut** 的全量替换：事务原子性只保证「不产生半状态」，
     * **不保证不丢数据** —— 结构合法但内容错误的输入会成功提交，旧数据永久消失。
     *
     * 因此恢复流程**禁止**直接调用它，必须走
     * `lib/db/backup.ts` 的「校验 → dry-run → 暂存备份 → 原子切换」顺序。
     *
     * ## 覆盖范围（W7 修正）
     *
     * 原实现漏掉了 `classificationAudit` 与 `meta`，导致恢复后
     * 审计悬空、迁移记录与数据版本错配。现在按 `options` 一并处理。
     */
    async replaceAll(portfolio: Portfolio2, options: ReplaceAllOptions = {}): Promise<void> {
      const replaceAudit = options.replaceAudit !== false
      const tables = [
        get().accounts, get().instruments, get().holdings, get().transactions,
        get().quotes, get().fxRates, get().snapshots, get().allocationProfiles,
        ...(replaceAudit ? [get().classificationAudit] : []),
        ...(options.metaKv ? [get().meta] : []),
      ]
      await get().transaction('rw', tables, async () => {
        await Promise.all(tables.map((table) => table.clear()))
        await get().accounts.bulkPut(portfolio.accounts)
        await get().instruments.bulkPut(portfolio.instruments)
        await get().holdings.bulkPut(portfolio.holdings)
        await get().transactions.bulkPut(portfolio.transactions)
        await get().quotes.bulkPut(portfolio.quotes)
        await get().fxRates.bulkPut(portfolio.fxRates)
        await get().snapshots.bulkPut(portfolio.snapshots)
        await get().allocationProfiles.bulkPut(portfolio.allocationProfiles)
        if (replaceAudit) {
          await get().classificationAudit.bulkPut(portfolio.classificationAudit ?? [])
        }
        if (options.metaKv) {
          await get().meta.bulkPut(
            Object.entries(options.metaKv).map(([key, value]) => ({ key, value })),
          )
        }
      })
    },

    async clearAll(): Promise<void> {
      const t = [
        get().accounts, get().instruments, get().holdings, get().transactions,
        get().quotes, get().fxRates, get().snapshots, get().allocationProfiles,
      ]
      await get().transaction('rw', t, async () => {
        await Promise.all(t.map((table) => table.clear()))
      })
    },

    async counts(): Promise<Record<string, number>> {
      const [accounts, instruments, holdings, transactions, quotes, fxRates, snapshots, allocationProfiles] =
        await Promise.all([
          get().accounts.count(), get().instruments.count(), get().holdings.count(),
          get().transactions.count(), get().quotes.count(), get().fxRates.count(),
          get().snapshots.count(), get().allocationProfiles.count(),
        ])
      return { accounts, instruments, holdings, transactions, quotes, fxRates, snapshots, allocationProfiles }
    },
  }

  return repo
}

/** 供测试使用：内存版（不落 IndexedDB），验证业务层只依赖接口 */

/** 内存版审计写入 */
function appendMemoryAudit(
  store: Portfolio2,
  input: { instrumentId: string; from: Instrument; to: Instrument; action: ClassificationAuditEntry['action'] },
): Portfolio2 {
  const entry: ClassificationAuditEntry = {
    id: `cls_${input.instrumentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    instrumentId: input.instrumentId,
    from: { assetClass: input.from.assetClass, status: input.from.classificationStatus },
    to: { assetClass: input.to.assetClass, status: input.to.classificationStatus },
    at: new Date().toISOString(),
    action: input.action,
  }
  return { ...store, classificationAudit: [...store.classificationAudit, entry] }
}

/**
 * 供测试使用：**成对**的内存仓储与 Dexie 库。
 *
 * 为什么必须成对：`migrateOnStart` 会把迁移记录写进 `db.meta`，
 * 业务数据写进 `repo`。若二者不是同一个库，就会出现
 * 「记录说已迁移、数据却是空的」这类不一致。
 */
export async function createPairedTestStore(name: string): Promise<{
  repo: PortfolioRepository
  db: WealthCardDb
}> {
  const { WealthCardDb } = await import('./dexie')
  const db = new WealthCardDb(name)
  await db.open()
  return { repo: createDexieRepository(db), db }
}

/** 内存版 meta 键值仓储（与 Dexie 版语义一致） */
function createMemoryMetaKv(): MetaKeyValueRepository {
  const map = new Map<string, unknown>()
  return {
    get: async <T,>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => void map.set(key, value),
    remove: async (key) => void map.delete(key),
    keysWithPrefix: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  }
}

export function createInMemoryRepository(): PortfolioRepository {
  let store: Portfolio2 = createEmptyPortfolio2()
  // 与 `metaKv` 属性共用同一个实例，保证 replaceAll({ metaKv }) 能真正生效
  const metaKv = createMemoryMetaKv()

  const mk = <T extends { id: string }>(getList: () => T[], setList: (l: T[]) => void): Repository<T> => ({
    get: async (id) => getList().find((x) => x.id === id),
    getAll: async () => [...getList()],
    put: async (e) => {
      const list = getList().filter((x) => x.id !== e.id)
      setList([...list, e])
    },
    putMany: async (es) => {
      const ids = new Set(es.map((e) => e.id))
      setList([...getList().filter((x) => !ids.has(x.id)), ...es])
    },
    remove: async (id) => setList(getList().filter((x) => x.id !== id)),
    count: async () => getList().length,
    clear: async () => setList([]),
  })

  const holdings = mk<Holding>(() => store.holdings, (l) => (store = { ...store, holdings: l }))
  const instruments = mk<Instrument>(() => store.instruments, (l) => (store = { ...store, instruments: l }))
  const quotes = mk<Quote>(() => store.quotes, (l) => (store = { ...store, quotes: l }))
  const snapshots = mk<Snapshot>(() => store.snapshots, (l) => (store = { ...store, snapshots: l }))

  return {
    accounts: mk<Account>(() => store.accounts, (l) => (store = { ...store, accounts: l })),
    instruments: Object.assign(instruments, {
      bySymbol: async (s: string) => store.instruments.filter((i) => i.symbol === s),
      unconfirmed: async () => store.instruments.filter((i) => i.classificationStatus === 'unconfirmed'),

      confirmOne: async (instrumentId: string, assetClass: Instrument['assetClass']) => {
        // 与 Dexie 版一致：必须由用户明确指定类别，不做「沿用现有值」兜底
        if (!assetClass) {
          throw new Error('确认分类必须由用户明确指定 assetClass，不允许沿用未确认的线索值')
        }
        const inst = store.instruments.find((i) => i.id === instrumentId)
        if (!inst) throw new Error(`标的不存在: ${instrumentId}`)
        const next: Instrument = {
          ...inst,
          assetClass,
          classificationStatus: 'confirmed',
          classificationSource: 'user_confirmed',
          updatedAt: new Date().toISOString(),
        }
        store = { ...store, instruments: store.instruments.map((i) => (i.id === instrumentId ? next : i)) }
        store = appendMemoryAudit(store, { instrumentId, from: inst, to: next, action: 'confirm' })
        return next
      },

      unconfirm: async (instrumentId: string) => {
        const inst = store.instruments.find((i) => i.id === instrumentId)
        if (!inst) throw new Error(`标的不存在: ${instrumentId}`)
        const next: Instrument = {
          ...inst,
          classificationStatus: 'unconfirmed',
          classificationSource: undefined,
          updatedAt: new Date().toISOString(),
        }
        store = { ...store, instruments: store.instruments.map((i) => (i.id === instrumentId ? next : i)) }
        store = appendMemoryAudit(store, { instrumentId, from: inst, to: next, action: 'unconfirm' })
        return next
      },

      confirmMany: async (entries: Array<{ id: string; assetClass: Instrument['assetClass'] }>) => {
        const out: Instrument[] = []
        for (const e of entries) {
          if (!e.assetClass) throw new Error(`批量确认必须为 ${e.id} 明确指定 assetClass`)
          const inst = store.instruments.find((i) => i.id === e.id)
          if (!inst) continue
          const next: Instrument = {
            ...inst,
            assetClass: e.assetClass,
            classificationStatus: 'confirmed',
            classificationSource: 'user_confirmed',
            updatedAt: new Date().toISOString(),
          }
          store = { ...store, instruments: store.instruments.map((i) => (i.id === e.id ? next : i)) }
          store = appendMemoryAudit(store, { instrumentId: e.id, from: inst, to: next, action: 'confirm_many' })
          out.push(next)
        }
        return out
      },

      classificationLog: async () =>
        [...store.classificationAudit].sort((a, b) => a.at.localeCompare(b.at)),

      /** @deprecated 兼容别名 */
      confirmClassification: async (ids: string[], assetClass: Instrument['assetClass']) => {
        for (const id of ids) {
          const inst = store.instruments.find((i) => i.id === id)
          if (!inst) continue
          const next: Instrument = {
            ...inst,
            assetClass,
            classificationStatus: 'confirmed',
            classificationSource: 'user_confirmed',
            updatedAt: new Date().toISOString(),
          }
          store = { ...store, instruments: store.instruments.map((i) => (i.id === id ? next : i)) }
          store = appendMemoryAudit(store, { instrumentId: id, from: inst, to: next, action: 'confirm_many' })
        }
      },
    }),
    holdings: Object.assign(holdings, {
      byAccount: async (id: string) => store.holdings.filter((h) => h.accountId === id),
      byInstrument: async (id: string) => store.holdings.filter((h) => h.instrumentId === id),
      moveToAccount: async (holdingId: string, accountId: string) => {
        store = {
          ...store,
          holdings: store.holdings.map((h) => (h.id === holdingId ? { ...h, accountId } : h)),
        }
      },
    }),
    transactions: Object.assign(
      mk<Transaction>(() => store.transactions, (l) => (store = { ...store, transactions: l })),
      {
        byAccount: async (id: string) => store.transactions.filter((t) => t.accountId === id),
        byInstrument: async (id: string) => store.transactions.filter((t) => t.instrumentId === id),
        range: async (a: string, b: string) =>
          store.transactions.filter((t) => t.timestamp >= a && t.timestamp <= b),
      },
    ),
    quotes: Object.assign(quotes, {
      latestFor: async (id: string) => {
        const list = store.quotes.filter((q) => q.instrumentId === id)
        return list.length ? list.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b)) : undefined
      },
      byStatus: async (s: Quote['status']) => store.quotes.filter((q) => q.status === s),
    }),
    fxRates: Object.assign(
      mk<FxRate>(() => store.fxRates, (l) => (store = { ...store, fxRates: l })),
      {
        pair: async (b: string, q: string) =>
          store.fxRates.filter((r) => r.baseCurrency === b && r.quoteCurrency === q),
        upsertLatest: async (rate: FxRate) => {
          store = {
            ...store,
            fxRates: [
              ...store.fxRates.filter(
                (r) =>
                  !(r.baseCurrency === rate.baseCurrency &&
                    r.quoteCurrency === rate.quoteCurrency &&
                    r.source === rate.source),
              ),
              rate,
            ],
          }
        },
      },
    ),
    snapshots: Object.assign(snapshots, {
      byDate: async (d: string) => store.snapshots.find((s) => s.date === d),
      previousBefore: async (d: string) =>
        [...store.snapshots]
          .filter((s) => s.date < d)
          .sort((a, b) => b.date.localeCompare(a.date))[0],
      upsertForDate: async (s: Snapshot) => {
        const existing = store.snapshots.find((x) => x.date === s.date)
        store = {
          ...store,
          snapshots: existing
            ? store.snapshots.map((x) => (x.date === s.date ? { ...s, id: existing.id, createdAt: existing.createdAt } : x))
            : [...store.snapshots, s],
        }
      },
      range: async (a: string, b: string) =>
        store.snapshots.filter((s) => s.date >= a && s.date <= b).sort((x, y) => x.date.localeCompare(y.date)),
    }),
    allocationProfiles: mk<AllocationProfile>(
      () => store.allocationProfiles,
      (l) => (store = { ...store, allocationProfiles: l }),
    ),
    classificationAudit: mk<ClassificationAuditEntry>(
      () => store.classificationAudit,
      (l) => (store = { ...store, classificationAudit: l }),
    ),
    metaKv,
    loadPortfolio: async () => store,
    /**
     * 内存实现的整批替换（测试用）。
     *
     * 与 Dexie 实现保持**相同语义**：`classificationAudit` 默认一并替换，
     * `metaKv` 给出时覆盖。避免测试与生产行为分叉。
     */
    replaceAll: async (p, options: ReplaceAllOptions = {}) => {
      const next = options.replaceAudit === false ? { ...p, classificationAudit: store.classificationAudit } : p
      store = next
      if (options.metaKv) {
        for (const [key, value] of Object.entries(options.metaKv)) {
          await metaKv.set(key, value)
        }
      }
    },
    clearAll: async () => {
      store = createEmptyPortfolio2()
    },
    counts: async () => ({
      accounts: store.accounts.length,
      instruments: store.instruments.length,
      holdings: store.holdings.length,
      transactions: store.transactions.length,
      quotes: store.quotes.length,
      fxRates: store.fxRates.length,
      snapshots: store.snapshots.length,
      allocationProfiles: store.allocationProfiles.length,
      classificationAudit: store.classificationAudit.length,
    }),
  }
}
