import { describe, expect, it } from 'vitest'
import { createInMemoryRepository } from '../db/dexieRepository'
import { buildSnapshot, captureSnapshot, localDate, previousDate } from './snapshot'
import { buildCompositionTrend } from './history'
import { loadPortfolio2, TREND_PRECOMPUTE_DAYS } from '../../hooks/usePortfolio2'
import { sortTransactions } from '../ledger/derive'
import { ledgerOptionsFor } from '../ledger/rebuild'
import {
  makeAccount, makeHolding, makeInstrument, makePortfolio, nowForLocalDate,
} from '../valuation/__fixtures__/builders'
import type { Portfolio2, Transaction } from '../../types/portfolio2'

/*
 * Phase 8 / W9 — P1-1 读路径 + P2-1/P2-2 等价性
 */

function basePortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: 'a1', currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({
        id: 'i1', name: '现金', instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed',
      }),
    ],
    holdings: [
      makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 1000 }),
    ],
  })
}

/* ================================================================== *
 * P1-1：previousBefore 索引查询
 * ================================================================== */

describe('【核心】previousBefore：按索引取「目标日期之前最近一份」', () => {
  it('取严格早于目标日期的最近一份（语义与旧的 getAll+sort 完全一致）', async () => {
    const repo = createInMemoryRepository()
    const p = basePortfolio()
    await repo.replaceAll(p)
    for (const d of ['2026-01-01', '2026-03-01', '2026-06-01']) {
      await repo.snapshots.put(buildSnapshot(p, { date: d, now: nowForLocalDate(d) }).snapshot)
    }

    expect((await repo.snapshots.previousBefore('2026-06-01'))?.date).toBe('2026-03-01')
    expect((await repo.snapshots.previousBefore('2026-04-15'))?.date).toBe('2026-03-01')
    expect((await repo.snapshots.previousBefore('2026-07-01'))?.date).toBe('2026-06-01')
  })

  it('无更早快照 → undefined（不猜测、不补齐）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(basePortfolio())
    expect(await repo.snapshots.previousBefore('2026-01-01')).toBeUndefined()
    await repo.snapshots.put(
      buildSnapshot(basePortfolio(), { date: '2026-05-01', now: nowForLocalDate('2026-05-01') }).snapshot,
    )
    // 目标日期之前没有 → undefined（等于目标日期的不算「之前」）
    expect(await repo.snapshots.previousBefore('2026-05-01')).toBeUndefined()
  })

  it('captureSnapshot 通过它找到期初，且不再全表读', async () => {
    const repo = createInMemoryRepository()
    const p = basePortfolio()
    await repo.replaceAll(p)
    const yest = previousDate(localDate())
    await repo.snapshots.put(buildSnapshot(p, { date: yest, now: nowForLocalDate(yest) }).snapshot)

    const r = await captureSnapshot(repo, { date: localDate(), now: Date.now() })
    expect(r.snapshot.openingDate).toBe(yest)
    expect(r.snapshot.openingNetWorth).toBe(1000)
  })
})

/* ================================================================== *
 * P1-1：趋势窗口
 * ================================================================== */

describe('【核心】冷启动趋势窗口：数据不删除，只是不预计算', () => {
  it('窗口外的快照不会被预计算进 trend，但仍在库里', async () => {
    const repo = createInMemoryRepository()
    const p = basePortfolio()
    await repo.replaceAll(p)
    // 一份很老的快照 + 一份今天
    await repo.snapshots.put(buildSnapshot(p, { date: '2020-01-01', now: nowForLocalDate('2020-01-01') }).snapshot)
    await repo.snapshots.put(buildSnapshot(p, { date: localDate(), now: Date.now() }).snapshot)

    const snap = await loadPortfolio2(repo, { now: Date.now() })
    const dates = snap.trend.points.map((x) => x.date)
    expect(dates).toContain(localDate())
    expect(dates).not.toContain('2020-01-01')

    // 【核心】数据仍在库中，可查询范围没有缩短
    const all = await repo.snapshots.getAll()
    expect(all.map((s) => s.date)).toContain('2020-01-01')
    expect(await repo.snapshots.byDate('2020-01-01')).toBeDefined()

    // 按需加载全部历史后，旧点仍可得到
    const full = buildCompositionTrend(await repo.snapshots.getAll())
    expect(full.points.map((x) => x.date)).toContain('2020-01-01')
  })

  it('TREND_PRECOMPUTE_DAYS 是正数且可被覆盖', async () => {
    expect(TREND_PRECOMPUTE_DAYS).toBeGreaterThan(0)
    const repo = createInMemoryRepository()
    await repo.replaceAll(basePortfolio())
    await repo.snapshots.put(buildSnapshot(basePortfolio(), { date: '2020-01-01', now: nowForLocalDate('2020-01-01') }).snapshot)

    const wide = await loadPortfolio2(repo, { now: Date.now(), trendDays: 99999 })
    expect(wide.trend.points.map((x) => x.date)).toContain('2020-01-01')
  })

  it('loadPortfolio2 仍返回完整 portfolio（含 snapshots），估值口径不变', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(basePortfolio())
    const snap = await loadPortfolio2(repo, { now: Date.now() })
    expect(snap.portfolio.snapshots).toBeDefined()
    expect(snap.totals.netWorth).toBe(1000)
  })
})

/* ================================================================== *
 * P2-1：sortTransactions 等价性
 * ================================================================== */

describe('【核心】P2-1 sortTransactions：结果与原实现完全一致', () => {
  /** 原实现（比较器内解析 Date）—— 作为等价性基准 */
  function original(txs: Transaction[]): Transaction[] {
    return [...txs].sort((a, b) => {
      const ta = new Date(a.timestamp).getTime()
      const tb = new Date(b.timestamp).getTime()
      if (ta !== tb) return ta - tb
      const rank = (t: Transaction) => (t.type === 'adjustment' ? 0 : 1)
      return rank(a) - rank(b)
    })
  }

  const mk = (id: string, type: Transaction['type'], timestamp: string): Transaction =>
    ({ id, accountId: 'a', instrumentId: 'i', type, quantity: 1, amount: 1, currency: 'CNY', timestamp })

  it('按时间升序', () => {
    const txs = [
      mk('c', 'buy', '2026-10-03T00:00:00.000Z'),
      mk('a', 'buy', '2026-10-01T00:00:00.000Z'),
      mk('b', 'sell', '2026-10-02T00:00:00.000Z'),
    ]
    expect(sortTransactions(txs).map((t) => t.id)).toEqual(original(txs).map((t) => t.id))
  })

  it('同一时间：adjustment 优先', () => {
    const ts = '2026-10-01T00:00:00.000Z'
    const txs = [
      mk('buy', 'buy', ts),
      mk('adj', 'adjustment', ts),
      mk('sell', 'sell', ts),
    ]
    const got = sortTransactions(txs).map((t) => t.id)
    const want = original(txs).map((t) => t.id)
    expect(got).toEqual(want)
    expect(got[0]).toBe('adj')
  })

  it('随机 200 组与基准逐一致（包含非法时间戳）', () => {
    const types: Transaction['type'][] = ['buy', 'sell', 'dividend', 'adjustment', 'fee', 'transfer']
    let seed = 42
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let round = 0; round < 200; round++) {
      const n = 1 + Math.floor(rnd() * 12)
      const txs: Transaction[] = []
      for (let i = 0; i < n; i++) {
        const bad = rnd() < 0.1
        const ts = bad ? 'not-a-date' : new Date(Date.UTC(2026, 9, 1 + Math.floor(rnd() * 5), Math.floor(rnd() * 24))).toISOString()
        txs.push(mk(`t${i}`, types[Math.floor(rnd() * types.length)], ts))
      }
      expect(sortTransactions(txs).map((t) => t.id)).toEqual(original(txs).map((t) => t.id))
    }
  })

  it('不修改入参数组', () => {
    const txs = [mk('b', 'buy', '2026-10-02T00:00:00.000Z'), mk('a', 'buy', '2026-10-01T00:00:00.000Z')]
    const snapshot = txs.map((t) => t.id)
    sortTransactions(txs)
    expect(txs.map((t) => t.id)).toEqual(snapshot)
  })
})

/* ================================================================== *
 * P2-2：ledgerOptionsFor 等价性
 * ================================================================== */

describe('【核心】P2-2 ledgerOptionsFor：Map 查表与原 .find 结果一致', () => {
  it('有无标的、现金/非现金、已确认/未确认都一致', () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [],
      instruments: [
        makeInstrument({ id: 'c1', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
        makeInstrument({ id: 'c2', instrumentType: 'cash', assetClass: 'cash', currency: 'USD', classificationStatus: 'unconfirmed' }),
        makeInstrument({ id: 's1', instrumentType: 'stock', assetClass: 'equity', currency: 'HKD', classificationStatus: 'confirmed' }),
      ],
      holdings: [],
    })
    const opts = ledgerOptionsFor(p)
    // 原实现语义
    const origCurrency = (id: string) => p.instruments.find((i) => i.id === id)?.currency
    const origCash = (id: string) => {
      const inst = p.instruments.find((i) => i.id === id)
      return !!inst && inst.instrumentType === 'cash' && inst.classificationStatus === 'confirmed'
    }
    for (const id of ['c1', 'c2', 's1', 'missing']) {
      expect(opts.instrumentCurrency(id)).toBe(origCurrency(id))
      expect(opts.isConfirmedCash(id)).toBe(origCash(id))
    }
  })

  it('查不到时返回 undefined / false（不抛错）', () => {
    const opts = ledgerOptionsFor(basePortfolio())
    expect(opts.instrumentCurrency('nope')).toBeUndefined()
    expect(opts.isConfirmedCash('nope')).toBe(false)
  })
})
