import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryRepository } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import { parseSeedFile, syncFxRates, shouldSyncFx, markFxSynced, FX_REFRESH_MS } from './fxAutoFetch'
import { createFxTable, resolveRate } from './fx'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from './__fixtures__/builders'
import type { Portfolio2 } from '../../types/portfolio2'

/*
 * 汇率自动获取（三级降级）测试
 *
 * 设计要点：
 *   ① 主源 open.er-api.com  → source 'er-api'   status LIVE
 *   ② 备源 jsdelivr         → source 'jsdelivr' status DELAYED
 *   ③ 兜底 public/fx-seed.json → source 'seed'  status SEED（不因时间失效）
 *
 * 关键不变量：
 *   - 兜底值**永不**因时间被判为过期（否则「失败回落兜底」就是空话）
 *   - 自动拉取**绝不覆盖**手填值（手填是不同 source → 不同行）
 *   - 同一天重复拉取只更新一行，不堆记录
 *   - 更新汇率**不改写**任何历史快照
 */

const SEED = {
  asOf: '2020-01-01',
  rates: { CNY: 1, USD: 7.0, HKD: 0.9, SGD: 5.4, JPY: 0.045, EUR: 7.5, GBP: 8.8, AUD: 4.6, KRW: 0.005, TWD: 0.21, CAD: 4.7 },
}

/** 「1 CNY = ? 外币」形态的主源响应（与真实 open.er-api.com 一致） */
function erApiPayload(asOfSec: number, usdPerCny = 0.14) {
  return {
    result: 'success',
    base_code: 'CNY',
    time_last_update_unix: asOfSec,
    rates: { USD: usdPerCny, HKD: 1.16, SGD: 0.19, JPY: 22, EUR: 0.13, GBP: 0.11, AUD: 0.21, KRW: 200, TWD: 4.7, CAD: 0.2 },
  }
}

function jsdelivrPayload(date: string, usdPerCny = 0.145) {
  return { date, cny: { usd: usdPerCny, hkd: 1.17 } }
}

function base(): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: 'a1', name: '账户', currency: 'USD', region: 'US' })],
    instruments: [
      makeInstrument({ id: 'usd', name: '美元现金', instrumentType: 'cash', assetClass: 'cash', currency: 'USD', classificationStatus: 'confirmed' }),
    ],
    holdings: [
      makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'usd', valuationMode: 'quantity', quantity: 1000, costBasis: 1000 }),
    ],
  })
}

/** 造一个只对给定 URL 返回数据的 fetch stub */
function stubFetch(routes: Record<string, unknown | 'fail'>) {
  return vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k))
    if (!key) throw new Error(`no route for ${url}`)
    const v = routes[key]
    if (v === 'fail') throw new Error('network down')
    return { ok: true, json: async () => v } as unknown as Response
  })
}

let repo: PortfolioRepository

beforeEach(async () => {
  vi.restoreAllMocks()
  repo = createInMemoryRepository()
  await repo.replaceAll(base())
})

afterEach(() => {
  vi.restoreAllMocks()
})

/* ================================================================== *
 * ① 解析器
 * ================================================================== */

describe('汇率自动获取 · 解析器', () => {
  it('种子文件解析：直读方向（1 外币 = ? CNY），不做倒数', () => {
    const r = parseSeedFile(SEED)
    expect(r.rates.USD).toBe(7.0)
    expect(r.rates.KRW).toBe(0.005)
    expect(r.rates.CNY).toBeUndefined() // CNY 自身不建行
    expect(r.asOf).toBe('2020-01-01T00:00:00.000Z')
  })

  it('种子文件非法值被忽略，且不整体失效', () => {
    const r = parseSeedFile({ asOf: '2026-01-01', rates: { USD: 7, BAD: 0, NEG: -1, STR: 'x' } })
    const rates = r.rates as Record<string, number | undefined>
    expect(rates.USD).toBe(7)
    expect(rates.BAD).toBeUndefined()
    expect(rates.NEG).toBeUndefined()
  })

  it('种子 asOf 非法时退回今天（不因格式问题整份失效）', () => {
    const r = parseSeedFile({ asOf: '不是日期', rates: { USD: 7 } })
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)
  })

  it('种子结构不可识别时抛错', () => {
    expect(() => parseSeedFile(null)).toThrow()
    expect(() => parseSeedFile({})).toThrow()
  })
})

/* ================================================================== *
 * ② 三级降级
 * ================================================================== */

describe('汇率自动获取 · 三级降级', () => {
  it('主源可用 → 用主源（LIVE），并同时落了种子兜底', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'fx-seed': SEED,
      'open.er-api.com': erApiPayload(Date.parse('2026-10-05T00:00:00Z') / 1000, 0.14),
    }))
    const r = await syncFxRates(repo, { force: true })
    expect(r.source).toBe('er-api')
    expect(r.fromNetwork).toBe(true)

    const rows = (await repo.loadPortfolio()).fxRates
    expect(rows.some((x) => x.source === 'er-api')).toBe(true)
    expect(rows.some((x) => x.source === 'seed')).toBe(true) // 兜底也落了库

    // 生效值应为 LIVE 的 1/0.14
    const resolved = resolveRate(createFxTable(rows), 'USD', 'CNY', { now: Date.parse('2026-10-05T00:00:00Z') })
    expect(resolved?.status).toBe('LIVE')
    expect(resolved?.rate).toBeCloseTo(1 / 0.14, 6)
  })

  it('主源失败 → 回落到备源（DELAYED）', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'fx-seed': SEED,
      'open.er-api.com': 'fail',
      'jsdelivr': jsdelivrPayload('2026-10-05', 0.145),
    }))
    const r = await syncFxRates(repo, { force: true })
    expect(r.source).toBe('jsdelivr')
    expect(r.fromNetwork).toBe(true)
  })

  it('两个网络源都失败 → 回落到种子（SEED），并带上失败原因', async () => {
    vi.stubGlobal('fetch', stubFetch({ 'fx-seed': SEED, 'open.er-api.com': 'fail', 'jsdelivr': 'fail' }))
    const r = await syncFxRates(repo, { force: true })
    expect(r.source).toBe('seed')
    expect(r.fromNetwork).toBe(false)
    expect(r.error).toContain('open.er-api.com')

    const resolved = resolveRate(createFxTable((await repo.loadPortfolio()).fxRates), 'USD', 'CNY', {})
    expect(resolved?.rate).toBe(7.0)
    expect(resolved?.status).toBe('SEED')
  })

  it('连种子都没有 → source none，且不抛错', async () => {
    vi.stubGlobal('fetch', stubFetch({ 'open.er-api.com': 'fail', 'jsdelivr': 'fail' }))
    const r = await syncFxRates(repo, { force: true })
    expect(r.source).toBe('none')
    expect(r.written).toBe(0)
  })

  it('【核心】兜底种子即使非常旧也永不失效（不因时间判为过期）', async () => {
    // 种子 asOf 是 2020 年；现在用 2026 年去解析
    vi.stubGlobal('fetch', stubFetch({ 'fx-seed': SEED, 'open.er-api.com': 'fail', 'jsdelivr': 'fail' }))
    await syncFxRates(repo, { force: true })

    const rows = (await repo.loadPortfolio()).fxRates
    const now = Date.parse('2026-10-05T00:00:00Z')

    // allowStale=false（不允许过期）也仍应解析成功 —— 这是「兜底」的意义
    const resolved = resolveRate(createFxTable(rows), 'USD', 'CNY', { now, allowStale: false })
    expect(resolved).toBeDefined()
    expect(resolved?.status).toBe('SEED')
    expect(resolved?.rate).toBe(7.0)
  })

  it('【核心】过期的实时汇率不会压住兜底种子', async () => {
    // 先写一条很久以前的 LIVE 行，再只落种子
    await repo.fxRates.put({
      id: 'old', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 6.0,
      timestamp: '2026-01-01T00:00:00.000Z', source: 'er-api', status: 'LIVE',
    })
    vi.stubGlobal('fetch', stubFetch({ 'fx-seed': SEED, 'open.er-api.com': 'fail', 'jsdelivr': 'fail' }))
    await syncFxRates(repo, { force: true })

    const rows = (await repo.loadPortfolio()).fxRates
    // 旧 LIVE 行仍在（不删历史）；种子会为每个受支持币种各落一行
    expect(rows.some((r) => r.id === 'old')).toBe(true)
    const resolved = resolveRate(createFxTable(rows), 'USD', 'CNY', { now: Date.parse('2026-10-05T00:00:00Z') })
    // 状态优先级：SEED(2) 优先于 STALE(9)，因此种子接管
    expect(resolved?.rate).toBe(7.0)
    expect(resolved?.status).toBe('SEED')
  })
})

/* ================================================================== *
 * ③ 去重与不覆盖手填
 * ================================================================== */

describe('汇率自动获取 · 去重与不覆盖', () => {
  it('【核心】同一天重复同步只更新一行，不堆记录', async () => {
    vi.stubGlobal('fetch', stubFetch({
      'fx-seed': SEED,
      'open.er-api.com': erApiPayload(Date.parse('2026-10-05T00:00:00Z') / 1000),
    }))
    await syncFxRates(repo, { force: true })
    const after1 = (await repo.loadPortfolio()).fxRates.length
    await syncFxRates(repo, { force: true })
    await syncFxRates(repo, { force: true })
    const after3 = (await repo.loadPortfolio()).fxRates.length
    expect(after3).toBe(after1)
  })

  it('【核心】自动拉取绝不覆盖手填汇率（不同 source 各占一行）', async () => {
    await repo.fxRates.put({
      id: 'm1', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.77,
      timestamp: '2026-10-05T00:00:00.000Z', source: 'manual', status: 'MANUAL',
    })
    vi.stubGlobal('fetch', stubFetch({
      'fx-seed': SEED,
      'open.er-api.com': erApiPayload(Date.parse('2026-10-05T00:00:00Z') / 1000, 0.14),
    }))
    await syncFxRates(repo, { force: true })

    const rows = (await repo.loadPortfolio()).fxRates
    const manual = rows.find((r) => r.source === 'manual')
    expect(manual).toBeDefined()
    expect(manual?.rate).toBe(7.77) // 手填值原样保留
  })

  it('不同日期各保留一行（保留历史，供归因计算 fxEffect）', async () => {
    vi.stubGlobal('fetch', stubFetch({ 'fx-seed': SEED, 'open.er-api.com': 'fail', 'jsdelivr': 'fail' }))
    await syncFxRates(repo, { force: true })
    // 手动补一条不同 asOf 的自动行，模拟隔天同步
    await repo.fxRates.put({
      id: 'er-2', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.1,
      timestamp: '2026-10-06T00:00:00.000Z', source: 'er-api', status: 'LIVE',
    })
    const rows = (await repo.loadPortfolio()).fxRates
    expect(rows.filter((r) => r.baseCurrency === 'USD')).toHaveLength(2)
  })
})

/* ================================================================== *
 * ④ 与快照 / 账本无关
 * ================================================================== */

describe('汇率自动获取 · 不影响账本与快照', () => {
  it('【核心】同步只写 fxRates，不动交易 / 持仓 / 快照', async () => {
    const before = await repo.loadPortfolio()
    await repo.snapshots.put({
      id: 's1', date: '2026-10-04', createdAt: '2026-10-04T00:00:00.000Z',
      positions: [{
        instrumentId: 'usd', accountId: 'a1', quantity: 1000, currency: 'USD',
        rateToCny: 6.9, valueCny: 6900, reliable: true,
      }],
      // 其余字段由测试不关心，运行时不会读取
    } as never)
    const snapBefore = JSON.stringify((await repo.loadPortfolio()).snapshots)

    vi.stubGlobal('fetch', stubFetch({
      'fx-seed': SEED,
      'open.er-api.com': erApiPayload(Date.parse('2026-10-05T00:00:00Z') / 1000, 0.14),
    }))
    await syncFxRates(repo, { force: true })

    const after = await repo.loadPortfolio()
    expect(after.transactions).toHaveLength(before.transactions.length)
    expect(after.holdings).toEqual(before.holdings)
    expect(after.instruments).toEqual(before.instruments)
    // 历史快照里的 rateToCny / valueCny 是冻结值，不因汇率更新而改变
    expect(JSON.stringify(after.snapshots)).toBe(snapBefore)
    expect(after.snapshots[0].positions[0].rateToCny).toBe(6.9)
    expect(after.snapshots[0].positions[0].valueCny).toBe(6900)
  })
})

/* ================================================================== *
 * ⑤ 节流判断
 * ================================================================== */

describe('汇率自动获取 · 节流', () => {
  it('没有同步记录时需要同步', async () => {
    expect(await shouldSyncFx(repo)).toBe(true)
  })

  it('刚同步过时不需要同步；超过间隔后需要', async () => {
    const t0 = Date.parse('2026-10-05T00:00:00.000Z')
    await markFxSynced(repo, { source: 'er-api', written: 5, fromNetwork: true, syncedAt: new Date(t0).toISOString() })

    expect(await shouldSyncFx(repo, { now: () => t0 + 1000 })).toBe(false)
    expect(await shouldSyncFx(repo, { now: () => t0 + FX_REFRESH_MS - 1000 })).toBe(false)
    expect(await shouldSyncFx(repo, { now: () => t0 + FX_REFRESH_MS + 1000 })).toBe(true)
  })
})
