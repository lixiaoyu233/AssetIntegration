import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_NAME, getDb, requestPersistentStorage, resetDbSingleton } from './dexie'
import { createDexieRepository, createInMemoryRepository } from './dexieRepository'
import type { PortfolioRepository } from './repository'
import { createEmptyPortfolio2 } from '../../types/portfolio2'
import {
  ISO,
  makeAccount,
  makeHolding,
  makeInstrument,
  makePortfolio,
  makeQuote,
  makeFxRate,
  makeSnapshot,
} from '../valuation/__fixtures__/builders'

/*
 * Repository / Dexie 测试
 *
 * 用 fake-indexeddb 真实跑事务、索引与幂等语义（不是内存 mock），
 * 因此这些用例同时验证了表结构与索引是否正确。
 */

let repo: PortfolioRepository

beforeEach(async () => {
  await resetDbSingleton()
  // 每个用例用独立库名，避免互相污染
  const db = getDb(`${DB_NAME}_test_${Math.random().toString(36).slice(2)}`)
  repo = createDexieRepository(db)
  await repo.clearAll()
})

afterEach(async () => {
  await repo.clearAll()
  await resetDbSingleton()
})

/* ------------------------------------------------------------------ *
 * 基础 CRUD
 * ------------------------------------------------------------------ */

describe('Repository：基础 CRUD', () => {
  it('存取账户', async () => {
    const a = makeAccount({ id: 'a1', name: '示例银行', type: 'bank', region: 'CN' })
    await repo.accounts.put(a)
    expect((await repo.accounts.get('a1'))?.name).toBe('示例银行')
    expect((await repo.accounts.get('a1'))?.region).toBe('CN')
    expect(await repo.accounts.count()).toBe(1)
  })

  it('批量写入与覆盖', async () => {
    await repo.instruments.putMany([
      makeInstrument({ id: 'i1', name: 'A' }),
      makeInstrument({ id: 'i2', name: 'B' }),
    ])
    expect(await repo.instruments.count()).toBe(2)
    await repo.instruments.putMany([makeInstrument({ id: 'i1', name: 'A2' })])
    expect(await repo.instruments.count()).toBe(2)
    expect((await repo.instruments.get('i1'))?.name).toBe('A2')
  })

  it('删除与清空', async () => {
    await repo.accounts.put(makeAccount({ id: 'a1' }))
    await repo.accounts.remove('a1')
    expect(await repo.accounts.get('a1')).toBeUndefined()
    await repo.accounts.putMany([makeAccount({ id: 'a2' }), makeAccount({ id: 'a3' })])
    await repo.accounts.clear()
    expect(await repo.accounts.count()).toBe(0)
  })

  it('loadPortfolio 返回完整组合', async () => {
    const p = makePortfolio({
      accounts: [makeAccount({ id: 'a1' })],
      instruments: [makeInstrument({ id: 'i1' })],
      holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', manualValue: 100 })],
    })
    await repo.replaceAll(p)
    const loaded = await repo.loadPortfolio()
    expect(loaded.accounts).toHaveLength(1)
    expect(loaded.holdings).toHaveLength(1)
    expect(loaded.holdings[0].manualValue).toBe(100)
  })

  it('counts 返回各表条数', async () => {
    await repo.replaceAll(
      makePortfolio({
        accounts: [makeAccount({ id: 'a1' })],
        holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1' })],
      }),
    )
    const c = await repo.counts()
    expect(c.accounts).toBe(1)
    expect(c.holdings).toBe(1)
    expect(c.quotes).toBe(0)
  })

  it('replaceAll 会清掉旧数据（不残留）', async () => {
    await repo.accounts.put(makeAccount({ id: 'old' }))
    await repo.replaceAll(makePortfolio({ accounts: [makeAccount({ id: 'new' })] }))
    expect(await repo.accounts.get('old')).toBeUndefined()
    expect(await repo.accounts.count()).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * 索引查询
 * ------------------------------------------------------------------ */

describe('Repository：索引', () => {
  it('按账户查持仓', async () => {
    await repo.holdings.putMany([
      makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1' }),
      makeHolding({ id: 'h2', accountId: 'a1', instrumentId: 'i2' }),
      makeHolding({ id: 'h3', accountId: 'a2', instrumentId: 'i1' }),
    ])
    expect((await repo.holdings.byAccount('a1')).map((h) => h.id).sort()).toEqual(['h1', 'h2'])
  })

  it('按标的查持仓（同一标的可在多个账户持有）', async () => {
    await repo.holdings.putMany([
      makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'QQQM' }),
      makeHolding({ id: 'h2', accountId: 'a2', instrumentId: 'QQQM' }),
    ])
    expect(await repo.holdings.byInstrument('QQQM')).toHaveLength(2)
  })

  it('查未确认分类的标的（供 UI 提示用户确认）', async () => {
    await repo.instruments.putMany([
      makeInstrument({ id: 'i1', classificationStatus: 'unconfirmed' }),
      makeInstrument({ id: 'i2', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i3', classificationStatus: 'unconfirmed' }),
    ])
    expect((await repo.instruments.unconfirmed()).map((i) => i.id).sort()).toEqual(['i1', 'i3'])
  })

  it('取某标的最新行情', async () => {
    await repo.quotes.putMany([
      makeQuote({ id: 'q1', instrumentId: 'i1', marketPrice: 100, timestamp: new Date(Date.now() - 60_000).toISOString() }),
      makeQuote({ id: 'q2', instrumentId: 'i1', marketPrice: 110, timestamp: new Date().toISOString() }),
    ])
    expect((await repo.quotes.latestFor('i1'))?.marketPrice).toBe(110)
  })

  it('按状态查行情', async () => {
    await repo.quotes.putMany([
      makeQuote({ id: 'q1', instrumentId: 'i1', status: 'STALE' }),
      makeQuote({ id: 'q2', instrumentId: 'i2', status: 'LIVE' }),
    ])
    expect((await repo.quotes.byStatus('STALE')).map((q) => q.id)).toEqual(['q1'])
  })

  it('按币种对查汇率', async () => {
    await repo.fxRates.putMany([
      makeFxRate('USD', 'CNY', 7.2),
      makeFxRate('HKD', 'CNY', 0.92),
    ])
    expect(await repo.fxRates.pair('USD', 'CNY')).toHaveLength(1)
    expect(await repo.fxRates.pair('SGD', 'CNY')).toHaveLength(0)
  })

  it('汇率 upsert 不产生重复（同币种对 + 同来源只留最新）', async () => {
    await repo.fxRates.upsertLatest(makeFxRate('USD', 'CNY', 7.0, { source: 'er-api' }))
    await repo.fxRates.upsertLatest(makeFxRate('USD', 'CNY', 7.2, { source: 'er-api' }))
    const list = await repo.fxRates.pair('USD', 'CNY')
    expect(list).toHaveLength(1)
    expect(list[0].rate).toBeCloseTo(7.2, 10)
  })

  it('按时间范围查交易', async () => {
    await repo.transactions.putMany([
      { id: 't1', accountId: 'a1', type: 'deposit', amount: 1, currency: 'CNY', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 't2', accountId: 'a1', type: 'deposit', amount: 2, currency: 'CNY', timestamp: '2026-06-01T00:00:00.000Z' },
      { id: 't3', accountId: 'a1', type: 'deposit', amount: 3, currency: 'CNY', timestamp: '2026-12-01T00:00:00.000Z' },
    ])
    const r = await repo.transactions.range('2026-03-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    expect(r.map((t) => t.id)).toEqual(['t2'])
  })
})

/* ------------------------------------------------------------------ *
 * Snapshot 幂等
 * ------------------------------------------------------------------ */

describe('Repository：Snapshot 幂等', () => {
  it('同一天重复写入只保留一条，且是更新而非新增', async () => {
    await repo.snapshots.upsertForDate(
      makeSnapshot({ id: 's1', date: '2026-10-03', netWorth: 100, createdAt: '2026-10-03T01:00:00.000Z' }),
    )
    await repo.snapshots.upsertForDate(makeSnapshot({ id: 's2', date: '2026-10-03', netWorth: 200 }))

    expect(await repo.snapshots.count()).toBe(1)
    const saved = await repo.snapshots.byDate('2026-10-03')
    expect(saved?.netWorth).toBe(200)
    // 保留原 id 与 createdAt，便于追踪「这一天最早是什么时候记的」
    expect(saved?.id).toBe('s1')
    expect(saved?.createdAt).toBe('2026-10-03T01:00:00.000Z')
  })

  it('不同日期各自独立', async () => {
    await repo.snapshots.upsertForDate(makeSnapshot({ id: 's1', date: '2026-10-03', netWorth: 100 }))
    await repo.snapshots.upsertForDate(makeSnapshot({ id: 's2', date: '2026-10-04', netWorth: 110 }))
    expect(await repo.snapshots.count()).toBe(2)
  })

  it('连续写入 5 次仍是 1 条（幂等）', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.snapshots.upsertForDate(makeSnapshot({ id: `s${i}`, date: '2026-10-03', netWorth: i }))
    }
    expect(await repo.snapshots.count()).toBe(1)
    expect((await repo.snapshots.byDate('2026-10-03'))?.netWorth).toBe(4)
  })

  it('按日期范围查询', async () => {
    for (const d of ['2026-01-01', '2026-06-15', '2026-12-31']) {
      await repo.snapshots.upsertForDate(makeSnapshot({ id: `s_${d}`, date: d, netWorth: 1 }))
    }
    const r = await repo.snapshots.range('2026-02-01', '2026-11-01')
    expect(r.map((s) => s.date)).toEqual(['2026-06-15'])
  })
})

/* ------------------------------------------------------------------ *
 * 账户移动不变量（用户明确要求）
 * ------------------------------------------------------------------ */

describe('Repository：账户移动不变量', () => {
  /**
   * 需求：「账户拆分应该是改变 Holding 所属 Account，而不是新建一份资产」。
   * 因此移动后必须满足：总数不变、id 不变、金额不变。
   */
  it('移动后 Holding 总数不变、id 不变、金额不变', async () => {
    const legacy = makeAccount({ id: 'acct_legacy', name: '股票' })
    const real = makeAccount({ id: 'acct_broker_real', name: '示例券商账户', type: 'broker', region: 'US' })
    await repo.accounts.putMany([legacy, real])
    await repo.holdings.putMany([
      makeHolding({ id: 'h1', accountId: 'acct_legacy', instrumentId: 'i1', manualValue: 1000 }),
      makeHolding({ id: 'h2', accountId: 'acct_legacy', instrumentId: 'i2', manualValue: 2000 }),
    ])

    const before = await repo.holdings.getAll()
    const totalBefore = before.reduce((s, h) => s + (h.manualValue ?? 0), 0)
    expect(before).toHaveLength(2)

    await repo.holdings.moveToAccount('h1', 'acct_broker_real')

    const after = await repo.holdings.getAll()
    // ① 总数不变（没有复制出新资产）
    expect(after).toHaveLength(2)
    // ② id 不变（不是新建一条）
    expect(after.map((h) => h.id).sort()).toEqual(['h1', 'h2'])
    expect(after.find((h) => h.id === 'h1')?.accountId).toBe('acct_broker_real')
    // ③ 金额不变（不会重复计算）
    expect(after.reduce((s, h) => s + (h.manualValue ?? 0), 0)).toBe(totalBefore)
  })

  it('移动后按账户查询正确归属', async () => {
    await repo.accounts.putMany([makeAccount({ id: 'a1' }), makeAccount({ id: 'a2' })])
    await repo.holdings.put(makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1' }))
    await repo.holdings.moveToAccount('h1', 'a2')
    expect(await repo.holdings.byAccount('a1')).toHaveLength(0)
    expect((await repo.holdings.byAccount('a2')).map((h) => h.id)).toEqual(['h1'])
  })

  it('移动不存在的持仓会报错（而不是静默新建）', async () => {
    await expect(repo.holdings.moveToAccount('不存在', 'a1')).rejects.toThrow()
  })
})

/* ------------------------------------------------------------------ *
 * 分类确认（用户主动触发）
 * ------------------------------------------------------------------ */

describe('Repository：分类确认', () => {
  it('单个确认', async () => {
    await repo.instruments.put(makeInstrument({ id: 'i1', classificationStatus: 'unconfirmed', assetClass: 'other' }))
    await repo.instruments.confirmClassification(['i1'], 'equity')
    const i = await repo.instruments.get('i1')
    expect(i?.assetClass).toBe('equity')
    expect(i?.classificationStatus).toBe('confirmed')
    expect(i?.classificationSource).toBe('user_confirmed')
  })

  it('批量确认（6 只美股 ETF 一次确认）', async () => {
    const ids = ['SPYM', 'QQQM', 'JEPI', 'QQQI', 'SCHD', 'BRK.B']
    await repo.instruments.putMany(
      ids.map((id) =>
        makeInstrument({ id, name: id, instrumentType: 'etf', classificationStatus: 'unconfirmed', assetClass: 'other' }),
      ),
    )
    await repo.instruments.confirmClassification(ids, 'equity')
    for (const id of ids) {
      const i = await repo.instruments.get(id)
      expect(i?.assetClass).toBe('equity')
      expect(i?.classificationStatus).toBe('confirmed')
    }
    expect(await repo.instruments.unconfirmed()).toHaveLength(0)
  })

  it('修改已有分类（已确认的也能改）', async () => {
    await repo.instruments.put(makeInstrument({ id: 'i1', assetClass: 'equity', classificationStatus: 'confirmed' }))
    await repo.instruments.confirmClassification(['i1'], 'fixed_income')
    expect((await repo.instruments.get('i1'))?.assetClass).toBe('fixed_income')
  })

  it('空数组不报错', async () => {
    await expect(repo.instruments.confirmClassification([], 'equity')).resolves.toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * 存储能力
 * ------------------------------------------------------------------ */

describe('存储能力', () => {
  it('requestPersistentStorage 在不支持时返回 false 而不抛错', async () => {
    await expect(requestPersistentStorage()).resolves.toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 接口可替换性：业务层只依赖接口
 * ------------------------------------------------------------------ */

describe('Repository 抽象：可替换实现', () => {
  it('内存实现满足同一套接口（证明业务层不依赖 Dexie）', async () => {
    const mem = createInMemoryRepository()
    await mem.accounts.put(makeAccount({ id: 'a1', name: '内存账户' }))
    await mem.holdings.put(makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', manualValue: 500 }))
    await mem.holdings.moveToAccount('h1', 'a2')

    const loaded = await mem.loadPortfolio()
    expect(loaded.accounts).toHaveLength(1)
    expect(loaded.holdings[0].accountId).toBe('a2')
    expect(loaded.holdings).toHaveLength(1)
    expect(await mem.counts()).toMatchObject({ accounts: 1, holdings: 1 })

    mem.replaceAll(createEmptyPortfolio2())
    expect((await mem.loadPortfolio()).holdings).toHaveLength(0)
  })

  it('内存实现的 snapshot 同样幂等', async () => {
    const mem = createInMemoryRepository()
    await mem.snapshots.upsertForDate(makeSnapshot({ id: 's1', date: '2026-10-03', netWorth: 1 }))
    await mem.snapshots.upsertForDate(makeSnapshot({ id: 's2', date: '2026-10-03', netWorth: 9 }))
    expect(await mem.snapshots.count()).toBe(1)
    expect((await mem.snapshots.byDate('2026-10-03'))?.netWorth).toBe(9)
  })
})

/* ------------------------------------------------------------------ *
 * ISO 常量被使用，避免 lint 报未使用
 * ------------------------------------------------------------------ */
describe('fixture 常量可用', () => {
  it('ISO 为合法时间', () => {
    expect(new Date(ISO).getTime()).toBeGreaterThan(0)
  })
})
