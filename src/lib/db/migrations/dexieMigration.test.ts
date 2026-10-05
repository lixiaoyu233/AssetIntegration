import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_NAME, getDb, resetDbSingleton } from '../dexie'
import { createDexieRepository } from '../dexieRepository'
import { createDexieMigrationStore } from '../dexieMigrationStore'
import { migrate } from './index'
import { MIGRATION_CHAIN, PORTFOLIO_SCHEMA_VERSION } from '../schema'
import type { PortfolioRepository } from '../repository'
import { createLegacyFixture } from '../__fixtures__/legacyFixture'

/*
 * Dexie 版迁移端到端测试
 *
 * 验证 Phase 2 的迁移链路：旧 JSON → 迁移器 → IndexedDB，
 * 且元信息 / 迁移日志 / 数据都落在 IndexedDB（不再写 localStorage 整块 JSON）。
 */

let repo: PortfolioRepository
let store: ReturnType<typeof createDexieMigrationStore>

beforeEach(async () => {
  await resetDbSingleton()
  const db = getDb(`${DB_NAME}_mig_${Math.random().toString(36).slice(2)}`)
  repo = createDexieRepository(db)
  store = createDexieMigrationStore(repo, db)
  await repo.clearAll()
})

afterEach(async () => {
  await repo.clearAll()
  await resetDbSingleton()
})

describe('迁移写入 IndexedDB', () => {
  it('旧数据迁移后可从 IndexedDB 完整读回', async () => {
    const legacy = createLegacyFixture()
    const outcome = await migrate({ legacy, store })
    expect(outcome.status).toBe('success')

    const loaded = await repo.loadPortfolio()
    expect(loaded.accounts.length).toBeGreaterThan(0)
    expect(loaded.holdings).toHaveLength(15)
    expect(loaded.instruments).toHaveLength(15)
    expect(loaded.quotes.length).toBeGreaterThan(0)

    // 抽查关键字段是否真的落库
    const hk = loaded.instruments.find((i) => i.name === '示例银行 C（香港）')
    expect(hk?.currency).toBe('HKD')
    const gold = loaded.instruments.find((i) => i.name === '示例黄金账户')
    expect(gold?.assetClass).toBe('gold')
  })

  it('元信息写入 IndexedDB，记录已应用的迁移', async () => {
    await migrate({ legacy: createLegacyFixture(), store })
    const meta = await store.readMeta()
    // 迁移链：Legacy V2 → Schema V3 → Schema V4
    // 由迁移链常量推导，避免每次升版都改测试字面量
    expect(meta?.appliedMigrations).toEqual([...MIGRATION_CHAIN])
    expect(meta?.schemaVersion).toBe(PORTFOLIO_SCHEMA_VERSION)
  })

  it('迁移日志写入 IndexedDB，含版本与计数', async () => {
    await migrate({ legacy: createLegacyFixture(), store })
    const log = await store.readLog()
    // 迁移链有两个步骤：v2→v4（内部经 v3）+ v3→v4（快照分类快照）
    expect(log).toHaveLength(MIGRATION_CHAIN.length)
    expect(log[0]).toMatchObject({
      migrationId: `legacy-v2-to-schema-v${PORTFOLIO_SCHEMA_VERSION}`,
      sourceSchemaVersion: 2,
      targetSchemaVersion: PORTFOLIO_SCHEMA_VERSION,
      sourceFamily: 'legacy',
      sourceLabel: 'Legacy V2',
      targetLabel: `Portfolio Schema V${PORTFOLIO_SCHEMA_VERSION}`,
      status: 'success',
    })
    expect(log[0].counts?.legacyItems).toBe(15)
    expect(log[0].counts?.holdings).toBe(15)
    // 第二条是 v3→v4 的独立步骤，且**不回填**历史分类
    expect(log[1].migrationId).toBe('schema-v3-to-v4-asset-class-at-capture')
    expect(log[1].note).toContain('不回填')
    // 第三条是 v4→v5：仅记录来源未标记，不回填 REAL
    expect(log[2].migrationId).toBe('schema-v4-to-v5-capture-kind')
    expect(log[2].note).toContain('不回填')
    // 第四条是 v5→v6：交易状态零填充，不回填 POSTED
    expect(log[3].migrationId).toBe('schema-v5-to-v6-transaction-status')
    expect(log[3].note).toContain('不回填')
    // 第五条是 v6→v7：不可估值字段可缺失，历史快照不回填
    expect(log[4].migrationId).toBe('schema-v6-to-v7-nullable-valuation')
    expect(log[4].note).toContain('不回填')
  })

  it('幂等：重复迁移不重复写入，且不新增实体', async () => {
    await migrate({ legacy: createLegacyFixture(), store })
    const before = await repo.counts()

    const second = await migrate({ legacy: createLegacyFixture(), store })
    expect(second.status).toBe('skipped')

    const after = await repo.counts()
    expect(after).toEqual(before)
    // 迁移链两个步骤各一条，重复执行不再增长
    expect(await store.readLog()).toHaveLength(MIGRATION_CHAIN.length)
  })

  it('再次启动（已有数据、旧数据仍在）时判定已迁移', async () => {
    await migrate({ legacy: createLegacyFixture(), store })
    // 模拟「新数据在，但 localStorage 旧数据没删」
    const again = await migrate({ legacy: createLegacyFixture(), store })
    expect(again.status).toBe('skipped')
    if (again.status === 'skipped') expect(again.reason).toBe('already-migrated')
  })
})

describe('迁移失败保护', () => {
  it('结构无法识别时不写数据、不标记已迁移，旧数据不受影响', async () => {
    const outcome = await migrate({ legacy: { foo: 'bar' }, store })
    expect(outcome.status).toBe('failed')

    const counts = await repo.counts()
    expect(Object.values(counts).every((n) => n === 0)).toBe(true)
    expect(await store.readMeta()).toBeNull()
    expect(await store.readLog()).toHaveLength(1)
  })

  it('失败后再次尝试仍会重跑（幂等标记未写入）', async () => {
    await migrate({ legacy: { foo: 'bar' }, store })
    await migrate({ legacy: { foo: 'bar' }, store })
    // 两次失败尝试各一条记录；失败时不会执行 v3→v4 / v4→v5 步骤
    expect(await store.readLog()).toHaveLength(2)
    expect(await store.readMeta()).toBeNull()
  })
})

describe('迁移数据的可用性', () => {
  it('迁移后的持仓可由 Repository 按账户查询（账户移动的前提）', async () => {
    await migrate({ legacy: createLegacyFixture(), store })
    const accounts = await repo.accounts.getAll()
    const broker = accounts.find((a) => a.type === 'broker')
    expect(broker).toBeDefined()

    const holdings = await repo.holdings.byAccount(broker!.id)
    expect(holdings.length).toBeGreaterThan(0)
  })

  it('迁移后未确认分类可通过 Repository 查出并确认（用户主动操作）', async () => {
    await migrate({ legacy: createLegacyFixture(), store })
    const unconfirmed = await repo.instruments.unconfirmed()
    expect(unconfirmed.length).toBeGreaterThan(0)

    // 模拟用户批量确认这 6 只美股 ETF 为 equity
    const etfIds = unconfirmed
      .filter((i) => i.instrumentType === 'etf')
      .map((i) => i.id)
    expect(etfIds.length).toBeGreaterThan(0)
    await repo.instruments.confirmClassification(etfIds, 'equity')

    const stillUnconfirmed = await repo.instruments.unconfirmed()
    expect(stillUnconfirmed.some((i) => etfIds.includes(i.id))).toBe(false)
  })

  it('迁移后持仓可移动到真实账户，且不产生重复资产', async () => {
    await migrate({ legacy: createLegacyFixture(), store })
    const accounts = await repo.accounts.getAll()
    const broker = accounts.find((a) => a.type === 'broker')!

    // 新建一个真实账户
    await repo.accounts.put({
      id: 'acct_broker_real',
      name: '示例券商账户',
      type: 'broker',
      region: 'US',
      currency: 'USD',
      isLiability: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const before = await repo.holdings.byAccount(broker.id)
    const totalBefore = (await repo.holdings.getAll()).length

    await repo.holdings.moveToAccount(before[0].id, 'acct_broker_real')

    expect((await repo.holdings.getAll())).toHaveLength(totalBefore) // 未新建
    expect((await repo.holdings.byAccount(broker.id))).toHaveLength(before.length - 1)
    expect((await repo.holdings.byAccount('acct_broker_real')).map((h) => h.id)).toEqual([before[0].id])
  })
})
