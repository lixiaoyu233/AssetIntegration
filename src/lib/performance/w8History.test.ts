import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createInMemoryRepository, createPairedTestStore } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import {
  buildSnapshot,
  captureSnapshot,
  captureRange,
  localDate,
  previousDate,
} from './snapshot'
import { ensureDailySnapshot } from './dailySnapshot'
import { compositionAtCapture, buildCompositionTrend } from './history'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import {
  makeAccount,
  makeHolding,
  makeInstrument,
  makePortfolio,
  nowForLocalDate,
} from '../valuation/__fixtures__/builders'
import type { Portfolio2 } from '../../types/portfolio2'
import { resetReadOnlyMode } from '../readOnly'

/*
 * Phase 8 / W8 — 历史事实完整性
 *
 * 覆盖：
 *   P0-1 过去/未来日期守卫
 *   P0-2 估值依据落盘
 *   P0-5 gross assets / liabilities / netWorth 口径
 *   P1-2 降级原因不丢失
 *   P1-3 stale 展示价保留
 *   P1-6 openingDate / capturedAt
 */

const TODAY = () => localDate()
const YESTERDAY = () => previousDate(TODAY())

function portfolioWithCash(value = 100000): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: 'a1', name: '示例账户', currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({
        id: 'i_cash', name: '人民币现金', instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed',
      }),
    ],
    holdings: [
      makeHolding({
        id: 'h_cash', accountId: 'a1', instrumentId: 'i_cash',
        valuationMode: 'manual', manualValue: value,
      }),
    ],
  })
}

async function seed(p: Portfolio2 = portfolioWithCash()): Promise<PortfolioRepository> {
  const repo = createInMemoryRepository()
  await repo.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })
  return repo
}

beforeEach(() => resetReadOnlyMode())
afterEach(() => resetReadOnlyMode())

/* ================================================================== *
 * P0-1 日期守卫
 * ================================================================== */

describe('P0-1：captureSnapshot 日期守卫', () => {
  it('【核心】过去日期被拒绝', async () => {
    const repo = await seed()
    // ⚠️ `now` 必须是**真实当下**：守卫比较的是 date 与「now 的本地日」。
    //    若把 now 也设成 2020-01-01，守卫会认为二者同日而放行（测试自身的坑）。
    await expect(
      captureSnapshot(repo, { date: '2020-01-01', now: Date.now() }),
    ).rejects.toThrow(/拒绝为过去日期/)
    expect(await repo.snapshots.count()).toBe(0)
  })

  it('【核心】未来日期被拒绝', async () => {
    const repo = await seed()
    const future = localDate(new Date(Date.now() + 10 * 86_400_000))
    await expect(
      captureSnapshot(repo, { date: future, now: Date.now() }),
    ).rejects.toThrow(/拒绝为未来日期/)
    expect(await repo.snapshots.count()).toBe(0)
  })

  it('今天允许（可创建、可刷新）', async () => {
    const repo = await seed()
    const r = await captureSnapshot(repo, { date: TODAY(), now: Date.now() })
    expect(r.action).toBe('created')
    expect(await repo.snapshots.count()).toBe(1)
  })

  it('【核心】dryRun 不受守卫限制（它不产生历史事实）', async () => {
    const repo = await seed()
    const r = await captureSnapshot(repo, { date: '2020-01-01', now: Date.now(), dryRun: true })
    expect(r.snapshot.netWorth).toBe(100000)
    expect(await repo.snapshots.count()).toBe(0)
  })

  it('captureRange 过去日期同样拒绝（双重防线）', async () => {
    const repo = await seed()
    await expect(captureRange(repo, '2020-01-01', '2020-01-02')).rejects.toThrow(/只支持今天/)
  })

  it('守卫基于本地日（UTC 边界不误判）', async () => {
    const repo = await seed()
    // 本地今天中午 → 一定属于本地今天，不受 UTC 偏移影响
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    const r = await captureSnapshot(repo, { date: localDate(noon), now: noon.getTime() })
    expect(r.snapshot.date).toBe(localDate(noon))
    // 本地今天 00:30 也必须能捕获（UTC 日此时可能是昨天）
    const early = new Date()
    early.setHours(0, 30, 0, 0)
    const r2 = await captureSnapshot(repo, { date: localDate(early), now: early.getTime() })
    expect(r2.snapshot.date).toBe(localDate(early))
  })
})

/* ================================================================== *
 * P0-2 / P1-2 / P1-3 / P1-6 快照字段
 * ================================================================== */

describe('P0-2 估值依据落盘', () => {
  it('【核心】手动价持仓记录 priceKind / quoteStatus / quoteSource / asOf', async () => {
    const repo = await seed()
    const ts = new Date().toISOString()
    await repo.quotes.put({
      id: 'q1', instrumentId: 'i_cash', priceKind: 'manual', marketPrice: 1,
      currency: 'CNY', source: 'manual', timestamp: ts, status: 'MANUAL',
    })
    const { snapshot } = buildSnapshot(await repo.loadPortfolio(), { date: TODAY(), now: Date.now() })
    const pos = snapshot.positions[0]

    expect(pos.priceKind).toBe('manual')
    expect(pos.quoteStatus).toBe('MANUAL')
    expect(pos.quoteSource).toBe('manual')
    expect(pos.asOf).toBeDefined()
  })

  it('【核心】无行情的标的：依据保持 undefined（不伪造）', async () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', currency: 'CNY', region: 'CN' })],
      instruments: [
        makeInstrument({
          id: 'i_stock', name: '股票', instrumentType: 'stock',
          assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed',
        }),
      ],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i_stock', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
      ],
      quotes: [], // 完全没有行情
    })
    const { snapshot } = buildSnapshot(p, { date: TODAY(), now: Date.now() })
    const pos = snapshot.positions[0]
    // 数量口径 + 无行情 → 根本不存在依据，必须留白（而不是编造一个来源）
    expect(pos.priceKind).toBeUndefined()
    expect(pos.quoteStatus).toBeUndefined()
    expect(pos.quoteSource).toBeUndefined()
  })

  it('手动口径如实记录「来自手动填报」这一真实依据', async () => {
    const repo = await seed()
    const { snapshot } = buildSnapshot(await repo.loadPortfolio(), { date: TODAY(), now: Date.now() })
    const pos = snapshot.positions[0]
    /*
     * manual 口径不读行情，但「价值来自手动填报」本身是必须记录的依据 ——
     * 否则历史快照无法区分「手填的 100 万」与「有行情的 100 万」。
     * 记录的是依据**类型**，不是编造的价格。
     */
    expect(pos.priceKind).toBe('manual')
    expect(pos.quoteStatus).toBe('MANUAL')
    expect(pos.quoteSource).toBe('manual')
  })

  it('可靠估值的项 reasons 为空数组', async () => {
    const repo = await seed()
    const { snapshot } = buildSnapshot(await repo.loadPortfolio(), { date: TODAY(), now: Date.now() })
    expect(snapshot.positions[0].reasons).toEqual([])
  })
})

describe('P1-2 降级原因不丢失', () => {
  it('【核心】缺行情的持仓落盘 reasons', async () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', currency: 'CNY', region: 'CN' })],
      instruments: [
        makeInstrument({
          id: 'i_stock', name: '股票', instrumentType: 'stock',
          assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed',
        }),
      ],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i_stock', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
      ],
      quotes: [], // 故意没有行情
    })
    const { snapshot } = buildSnapshot(p, { date: TODAY(), now: Date.now() })
    const pos = snapshot.positions[0]
    expect(pos.reliable).toBe(false)
    expect(pos.reasons).toContain('missing_quote')
    // 不可估值 → 金额为 undefined，绝不为 0
    expect(pos.valueCny).toBeUndefined()
    expect(pos.price).toBeUndefined()
  })

  it('【核心】缺汇率的持仓落盘 missing_fx（能被区分出来）', async () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', currency: 'USD', region: 'US' })],
      instruments: [
        makeInstrument({
          id: 'i_usd', name: '美元现金', instrumentType: 'cash',
          assetClass: 'cash', currency: 'USD', classificationStatus: 'confirmed',
        }),
      ],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i_usd', valuationMode: 'quantity', quantity: 1000, costBasis: 1000 }),
      ],
      fxRates: [], // 缺汇率
    })
    const { snapshot } = buildSnapshot(p, { date: TODAY(), now: Date.now() })
    const pos = snapshot.positions[0]
    expect(pos.reasons).toContain('missing_fx')
    expect(pos.valueCny).toBeUndefined()
    expect(pos.rateToCny).toBeUndefined() // 不写 1 冒充
  })
})

describe('P1-3 stale 展示价保留', () => {
  it('【核心】过期行情仍保留展示价（但不计入总额）', async () => {
    const old = new Date(Date.now() - 10 * 3600 * 1000).toISOString()
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', currency: 'CNY', region: 'CN' })],
      instruments: [
        makeInstrument({
          id: 'i_stock', name: '股票', instrumentType: 'stock',
          assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed',
        }),
      ],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i_stock', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
      ],
      quotes: [
        { id: 'q1', instrumentId: 'i_stock', priceKind: 'market_price', marketPrice: 12, currency: 'CNY', source: 't', timestamp: old, status: 'LIVE' },
      ],
    })
    const { snapshot } = buildSnapshot(p, { date: TODAY(), now: Date.now() })
    const pos = snapshot.positions[0]

    expect(pos.reliable).toBe(false) // 不计入总额
    expect(pos.valueCny).toBeUndefined()
    // 【核心】当时的过期价被保留，历史仍可解释
    expect(pos.staleValueCny).toBe(1200)
    // 且总额确实不含它
    expect(snapshot.totalAssets).toBe(0)
  })

  it('不可估值（无价可读）时不写 staleValueCny —— 不用成本价冒充', async () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', currency: 'CNY', region: 'CN' })],
      instruments: [
        makeInstrument({ id: 'i_stock', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
      ],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i_stock', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
      ],
      quotes: [],
    })
    const { snapshot } = buildSnapshot(p, { date: TODAY(), now: Date.now() })
    // 有成本价 1000，但**不得**当作展示价
    expect(snapshot.positions[0].staleValueCny).toBeUndefined()
  })
})

describe('P1-6 openingDate / capturedAt', () => {
  it('【核心】捕获今天时记录 openingDate 与 capturedAt', async () => {
    const repo = await seed()
    const yesterday = YESTERDAY()
    await repo.snapshots.put(
      buildSnapshot(await repo.loadPortfolio(), { date: yesterday, now: nowForLocalDate(yesterday) }).snapshot,
    )

    const r = await captureSnapshot(repo, { date: TODAY(), now: Date.now() })
    expect(r.snapshot.openingDate).toBe(yesterday)
    expect(r.snapshot.capturedAt).toBeDefined()
    // createdAt 与 capturedAt 一致（同一份内容）
    expect(r.snapshot.capturedAt).toBe(r.snapshot.createdAt)
  })

  it('没有期初时 openingDate 为 undefined（不猜测）', async () => {
    const repo = await seed()
    const r = await captureSnapshot(repo, { date: TODAY(), now: Date.now() })
    expect(r.snapshot.openingDate).toBeUndefined()
  })

  it('历史快照（v7 及以前）缺这些字段 → 明确表示「无法追溯」', async () => {
    const legacy = buildSnapshot(portfolioWithCash(), { date: '2020-01-01', now: nowForLocalDate('2020-01-01') }).snapshot
    // 模拟 v7 存量：剥掉 V8 字段
    const v7 = { ...legacy, capturedAt: undefined, openingDate: undefined }
    expect(v7.capturedAt).toBeUndefined()
    expect(v7.openingDate).toBeUndefined()
  })
})

/* ================================================================== *
 * 历史不可变
 * ================================================================== */

describe('历史快照不可变', () => {
  it('【核心】修改今天的行情不改变历史快照', async () => {
    const repo = await seed()
    const past = YESTERDAY()
    const snap = buildSnapshot(await repo.loadPortfolio(), { date: past, now: nowForLocalDate(past) }).snapshot
    await repo.snapshots.put(snap)
    const frozen = JSON.stringify(await repo.snapshots.byDate(past))

    // 今天录入 / 修改行情
    await repo.quotes.put({
      id: 'q_new', instrumentId: 'i_cash', priceKind: 'manual', marketPrice: 999,
      currency: 'CNY', source: 'manual', timestamp: new Date().toISOString(), status: 'MANUAL',
    })

    expect(JSON.stringify(await repo.snapshots.byDate(past))).toBe(frozen)
  })

  it('【核心】修改汇率不改变历史快照', async () => {
    const repo = await seed()
    const past = YESTERDAY()
    await repo.snapshots.put(
      buildSnapshot(await repo.loadPortfolio(), { date: past, now: nowForLocalDate(past) }).snapshot,
    )
    const frozen = JSON.stringify(await repo.snapshots.byDate(past))

    await repo.fxRates.put({
      id: 'fx_new', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 9.99,
      timestamp: new Date().toISOString(), source: 'manual', status: 'MANUAL',
    })

    expect(JSON.stringify(await repo.snapshots.byDate(past))).toBe(frozen)
  })

  it('ensureDailySnapshot 不会改写历史（逐字节）', async () => {
    const repo = await seed()
    const past = YESTERDAY()
    await repo.snapshots.put(
      buildSnapshot(await repo.loadPortfolio(), { date: past, now: nowForLocalDate(past) }).snapshot,
    )
    const frozen = JSON.stringify(await repo.snapshots.byDate(past))

    await ensureDailySnapshot(repo, { date: past, now: nowForLocalDate(past) })
    expect(JSON.stringify(await repo.snapshots.byDate(past))).toBe(frozen)
  })
})

/* ================================================================== *
 * P0-5 占比口径
 * ================================================================== */

describe('P0-5：历史占比以 gross assets 为分母', () => {
  function withLiability(): Portfolio2 {
    return makePortfolio({
      accounts: [
        makeAccount({ id: 'a1', name: '资产账户', currency: 'CNY', region: 'CN' }),
        makeAccount({ id: 'a2', name: '负债账户', currency: 'CNY', region: 'CN', isLiability: true }),
      ],
      instruments: [
        makeInstrument({ id: 'i_cash', name: '现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
        makeInstrument({ id: 'i_loan', name: '贷款', instrumentType: 'other', assetClass: 'other', currency: 'CNY', classificationStatus: 'confirmed' }),
      ],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'manual', manualValue: 1000000 }),
        makeHolding({ id: 'h2', accountId: 'a2', instrumentId: 'i_loan', valuationMode: 'manual', manualValue: 300000 }),
      ],
    })
  }

  it('【核心】totalCny = grossAssets（不含负债），不再出现 1,300,000', async () => {
    const repo = await seed(withLiability())
    const { snapshot } = buildSnapshot(await repo.loadPortfolio(), { date: TODAY(), now: Date.now() })
    const comp = compositionAtCapture(snapshot)
    expect(comp.ok).toBe(true)
    if (!comp.ok) return

    expect(comp.grossAssets).toBe(1000000)
    expect(comp.totalLiabilities).toBe(300000)
    expect(comp.netWorth).toBe(700000)
    // 曾经的错误值
    expect(comp.totalCny).not.toBe(1300000)
    expect(comp.totalCny).toBe(1000000)
  })

  it('【核心】资产类占比分母为 grossAssets，Σ 资产占比 = 100%', async () => {
    const repo = await seed(withLiability())
    const { snapshot } = buildSnapshot(await repo.loadPortfolio(), { date: TODAY(), now: Date.now() })
    const comp = compositionAtCapture(snapshot)
    if (!comp.ok) throw new Error('composition 不可用')

    expect(comp.byClassShare['cash']).toBeCloseTo(1, 6)
    // 负债不参与资产占比
    expect(comp.byClassShare['liability']).toBe(0)
    // 负债仍单独汇总
    expect(comp.byClass['liability']).toBe(300000)
  })

  it('趋势点暴露 grossAssets / totalLiabilities / netWorth', async () => {
    const repo = await seed(withLiability())
    await captureSnapshot(repo, { date: TODAY(), now: Date.now() })
    const trend = buildCompositionTrend(await repo.snapshots.getAll())
    const pt = trend.points[0]
    expect(pt.grossAssets).toBe(1000000)
    expect(pt.totalLiabilities).toBe(300000)
    expect(pt.netWorth).toBe(700000)
  })
})

/* ================================================================== *
 * IndexedDB 持久化
 * ================================================================== */

describe('IndexedDB：V8 字段真正落库', () => {
  it('依据字段持久化后可读回', async () => {
    const { repo, db } = await createPairedTestStore(`w8-${Date.now()}`)
    await repo.replaceAll(portfolioWithCash())
    await repo.quotes.put({
      id: 'q1', instrumentId: 'i_cash', priceKind: 'manual', marketPrice: 1,
      currency: 'CNY', source: 'manual', timestamp: new Date().toISOString(), status: 'MANUAL',
    })
    await captureSnapshot(repo, { date: TODAY(), now: Date.now() })

    const stored = await repo.snapshots.byDate(TODAY())
    expect(stored?.positions[0].priceKind).toBe('manual')
    expect(stored?.capturedAt).toBeDefined()
    await db.delete()
  })
})
