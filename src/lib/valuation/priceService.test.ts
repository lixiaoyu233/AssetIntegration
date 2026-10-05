import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Portfolio2 } from '../../types/portfolio2'
import { createInMemoryRepository, createPairedTestStore } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import {
  currencyOptions,
  isCurrencyCode,
  missingCurrencies,
  upsertFxRate,
  upsertQuote,
  valuationCompleteness,
} from './priceService'
import { quoteCoverageOf, reasonLabelsOf, VALUATION_STATUS_LABEL, valuationBasisOf } from './basis'
import { judgeQuote, quotePrice } from './quote'
import { createFxTable, resolveRate } from './fx'
import { calculateTotals, valuateHolding } from './engine'
import { deriveLedger } from '../ledger/derive'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { deriveAnalysis } from '../analysis'
import { buildSnapshot } from '../performance/snapshot'
import { buildCompositionTrend } from '../performance/history'
import { migrateV6ToV7 } from '../db/migrations/schema-v6-to-v7'
import { PORTFOLIO_SCHEMA_VERSION } from '../db/schema'
import { resetReadOnlyMode } from '../readOnly'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'

/*
 * Phase 8 / W6 — 估值与行情数据层
 *
 * 重点验证三个不变量：
 *   1. 不可估值 ≠ 0
 *   2. 缺 FX ≠ 1
 *   3. STALE / ERROR 不进入可靠总资产
 */

const NOW = () => new Date('2026-10-04T10:00:00.000Z')
const NOW_MS = NOW().getTime()
const T0 = '2026-10-01T10:00:00.000Z'

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function basePortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [
      makeAccount({ id: 'a_cny', name: '示例人民币账户', currency: 'CNY', region: 'CN' }),
      makeAccount({ id: 'a_usd', name: '示例美元账户', currency: 'USD', region: 'US' }),
    ],
    instruments: [
      makeInstrument({ id: 'i_cny', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_usd_cash', name: '美元现金', instrumentType: 'cash', assetClass: 'cash', currency: 'USD', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_stock', name: '示例股票', symbol: 'TEST', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
    ],
    holdings: [
      makeHolding({ id: 'h_cny', accountId: 'a_cny', instrumentId: 'i_cny', valuationMode: 'quantity', quantity: 100000, costBasis: 100000 }),
      makeHolding({ id: 'h_usd', accountId: 'a_usd', instrumentId: 'i_usd_cash', valuationMode: 'quantity', quantity: 10000, costBasis: 10000 }),
      makeHolding({ id: 'h_stock', accountId: 'a_cny', instrumentId: 'i_stock', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
    ],
    transactions: [
      { id: 't_cny', accountId: 'a_cny', instrumentId: 'i_cny', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: T0 },
      { id: 't_usd', accountId: 'a_usd', instrumentId: 'i_usd_cash', type: 'adjustment', quantity: 10000, amount: 10000, currency: 'USD', timestamp: T0 },
      { id: 't_stock', accountId: 'a_cny', instrumentId: 'i_stock', type: 'adjustment', quantity: 100, amount: 1000, currency: 'CNY', timestamp: T0 },
    ],
    // 刻意没有 fxRates 与 quotes
    fxRates: [],
    quotes: [],
  })
}

async function seedRepo(): Promise<PortfolioRepository> {
  const repo = createInMemoryRepository()
  const p = basePortfolio()
  await repo.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })
  return repo
}

const totalsOf = async (repo: PortfolioRepository, now = NOW_MS) => {
  const portfolio = await repo.loadPortfolio()
  return calculateTotals({ portfolio, fx: createFxTable(portfolio.fxRates), now })
}

beforeEach(() => resetReadOnlyMode())
afterEach(() => resetReadOnlyMode())

/* ================================================================== *
 * 不变量 1：不可估值 ≠ 0
 * ================================================================== */

describe('不变量：不可估值 ≠ 0', () => {
  it('缺行情时持仓为 unavailable，value 为 undefined（不是 0）', async () => {
    const repo = await seedRepo()
    const portfolio = await repo.loadPortfolio()
    const h = portfolio.holdings.find((x) => x.instrumentId === 'i_stock')!
    const r = valuateHolding(h, portfolio, { fx: createFxTable([]), now: NOW_MS })

    expect(r.status).toBe('unavailable')
    expect(r.value).toBeUndefined()
    expect(r.reasons).toContain('missing_quote')
  })

  it('缺行情的持仓不参与可靠总额', async () => {
    const repo = await seedRepo()
    const t = await totalsOf(repo)
    // 只有现金可估值（CNY 100000）；股票缺行情、美元缺汇率
    expect(t.totalAssets).toBe(100000)
    expect(t.unavailableCount).toBe(2)
    expect(t.isComplete).toBe(false)
  })

  it('录入价格必须 > 0，填 0 被拒绝', async () => {
    const repo = await seedRepo()
    const zero = await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 0,
      currency: 'CNY', timestamp: NOW().toISOString(), now: NOW,
    })
    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.code).toBe('invalid-price')

    const negative = await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: -5,
      currency: 'CNY', timestamp: NOW().toISOString(), now: NOW,
    })
    expect(negative.ok).toBe(false)
  })

  it('【核心】快照中不可估值项不写 0（Schema V7 起为 undefined）', () => {
    const p = basePortfolio()
    const { snapshot } = buildSnapshot(p, { date: '2026-10-04', now: NOW_MS })

    const stock = snapshot.positions.find((x) => x.instrumentId === 'i_stock')!
    expect(stock.reliable).toBe(false)
    expect(stock.valueCny).toBeUndefined()
    expect(stock.price).toBeUndefined()

    const usd = snapshot.positions.find((x) => x.instrumentId === 'i_usd_cash')!
    expect(usd.reliable).toBe(false)
    expect(usd.valueCny).toBeUndefined()
    // 缺汇率不得写 1 冒充
    expect(usd.rateToCny).toBeUndefined()

    // 可靠项照常有值
    const cny = snapshot.positions.find((x) => x.instrumentId === 'i_cny')!
    expect(cny.reliable).toBe(true)
    expect(cny.valueCny).toBe(100000)
    expect(cny.rateToCny).toBe(1)
  })
})

/* ================================================================== *
 * 不变量 2：缺 FX ≠ 1
 * ================================================================== */

describe('不变量：缺 FX ≠ 1', () => {
  it('缺汇率时外币持仓为 unavailable（不按 1:1 折算）', async () => {
    const repo = await seedRepo()
    const portfolio = await repo.loadPortfolio()
    const h = portfolio.holdings.find((x) => x.instrumentId === 'i_usd_cash')!
    const r = valuateHolding(h, portfolio, { fx: createFxTable([]), now: NOW_MS })

    expect(r.status).toBe('unavailable')
    expect(r.value).toBeUndefined()
    expect(r.reasons).toContain('missing_fx')
    // 绝不能等于 10000（原值）——那是 1:1
    expect(r.value).not.toBe(10000)
  })

  it('resolveRate 缺币种返回 undefined', () => {
    const fx = createFxTable([])
    expect(resolveRate(fx, 'USD', 'CNY', { now: NOW_MS })).toBeUndefined()
  })

  it('录入汇率必须是 > 0 且币种不同', async () => {
    const repo = await seedRepo()
    const zero = await upsertFxRate(repo, {
      baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 0, timestamp: NOW().toISOString(), now: NOW,
    })
    expect(zero.ok).toBe(false)

    const same = await upsertFxRate(repo, {
      baseCurrency: 'CNY', quoteCurrency: 'CNY', rate: 1, timestamp: NOW().toISOString(), now: NOW,
    })
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.code).toBe('same-currency')
  })

  it('录入汇率后外币可折算（10000 × 7.2 = 72000）', async () => {
    const repo = await seedRepo()
    const r = await upsertFxRate(repo, {
      baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2,
      timestamp: NOW().toISOString(), now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.affectedHoldingCount).toBe(1)

    const t = await totalsOf(repo)
    expect(t.totalAssets).toBe(100000 + 72000)
    // 换算：10000 USD × 7.2 = 72000
    expect(Math.abs(t.totalAssets - 172000)).toBeLessThan(0.01)
  })

  it('missingCurrencies 能列出缺汇率的币种', async () => {
    const repo = await seedRepo()
    const before = missingCurrencies(await repo.loadPortfolio(), NOW_MS)
    expect(before).toContain('USD')

    await upsertFxRate(repo, { baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: NOW().toISOString(), now: NOW })
    const after = missingCurrencies(await repo.loadPortfolio(), NOW_MS)
    expect(after).not.toContain('USD')
  })
})

/* ================================================================== *
 * 不变量 3：STALE / ERROR 不进入可靠总额
 * ================================================================== */

describe('不变量：STALE / ERROR 不进入可靠总资产', () => {
  it('显式 STALE 行情有值但不可用，且不计入总额', async () => {
    const repo = await seedRepo()
    const r = await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 12,
      currency: 'CNY', timestamp: NOW().toISOString(), status: 'STALE', now: NOW,
    })
    expect(r.ok).toBe(true)

    const portfolio = await repo.loadPortfolio()
    const q = portfolio.quotes[0]
    const judged = judgeQuote(q, NOW_MS)
    expect(judged.usable).toBe(false)
    if (!judged.usable) expect(judged.reason).toBe('stale_quote')
    // 值仍在（供展示），但不可用于累计
    expect(quotePrice(q)).toBe(12)

    const t = await totalsOf(repo)
    expect(t.totalAssets).toBe(100000) // 不含 100 × 12 = 1200
    expect(t.staleCount).toBe(1)
  })

  it('ERROR 行情永远不可用', async () => {
    const repo = await seedRepo()
    await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 12,
      currency: 'CNY', timestamp: NOW().toISOString(), status: 'ERROR', now: NOW,
    })
    const portfolio = await repo.loadPortfolio()
    const judged = judgeQuote(portfolio.quotes[0], NOW_MS)
    expect(judged.usable).toBe(false)
    if (!judged.usable) expect(judged.reason).toBe('error_quote')

    const t = await totalsOf(repo)
    expect(t.totalAssets).toBe(100000)
  })

  it('过旧的 LIVE 行情被判 STALE（不冒充实时）', async () => {
    const repo = await seedRepo()
    const old = new Date(NOW_MS - 10 * 3600 * 1000).toISOString()
    await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 12,
      currency: 'CNY', timestamp: old, status: 'LIVE', now: NOW,
    })
    const portfolio = await repo.loadPortfolio()
    // 写入时已按政策降级为 STALE，避免「显示有价却进不了总额」的困惑
    expect(portfolio.quotes[0].status).toBe('STALE')

    const t = await totalsOf(repo)
    expect(t.totalAssets).toBe(100000)
  })
})

/* ================================================================== *
 * 行情写入
 * ================================================================== */

describe('行情写入：经 Repository 持久化并保留来源与状态', () => {
  it('写入后可用，且可靠总额随之增加', async () => {
    const repo = await seedRepo()
    const before = await totalsOf(repo)

    const r = await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 12,
      currency: 'CNY', timestamp: NOW().toISOString(), now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.valuation.status).toBe('ok')
      expect(r.valuation.value).toBe(1200)
    }

    const after = await totalsOf(repo)
    expect(after.totalAssets).toBe(before.totalAssets + 1200)
    expect(after.unavailableCount).toBe(before.unavailableCount - 1)
  })

  it('【核心】手填行情如实标注为 manual，绝不伪装成外部源', async () => {
    const repo = await seedRepo()
    await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 12,
      currency: 'CNY', timestamp: NOW().toISOString(), now: NOW,
    })
    const q = (await repo.loadPortfolio()).quotes[0]
    expect(q.status).toBe('MANUAL')
    expect(q.source).toBe('manual')
  })

  it('【W8】不同时间点的行情各自保留（历史可追溯）', async () => {
    const repo = await seedRepo()
    /*
     * W8 起行情按 (标的, priceKind, source, 时间点) 业务键去重**追加**：
     * 不同时间点必须各自成行，否则「当时的行情」会被永久覆盖，
     * 快照里的数字就无法自证（W8 审计 P0-3）。
     */
    const t1 = '2026-10-01T10:00:00.000Z'
    const t2 = '2026-10-02T10:00:00.000Z'
    const t3 = '2026-10-03T10:00:00.000Z'
    for (const [price, ts] of [[10, t1], [11, t2], [12, t3]] as const) {
      await upsertQuote(repo, {
        instrumentId: 'i_stock', priceKind: 'market_price', price,
        currency: 'CNY', timestamp: ts, now: NOW,
      })
    }
    const quotes = (await repo.loadPortfolio()).quotes
    expect(quotes).toHaveLength(3)
    // 每个时间点都能查回当时的价格
    expect(quotes.find((q) => q.timestamp === t1 && quotePrice(q) === 10)).toBeDefined()
    expect(quotes.find((q) => q.timestamp === t2 && quotePrice(q) === 11)).toBeDefined()
    expect(quotes.find((q) => q.timestamp === t3 && quotePrice(q) === 12)).toBeDefined()
  })

  it('【W8】同一时间点重复录入只保留一条（防重复点击堆积）', async () => {
    const repo = await seedRepo()
    const ts = '2026-10-02T10:00:00.000Z'
    for (const price of [10, 11, 12]) {
      await upsertQuote(repo, {
        instrumentId: 'i_stock', priceKind: 'market_price', price,
        currency: 'CNY', timestamp: ts, now: NOW,
      })
    }
    const quotes = (await repo.loadPortfolio()).quotes
    expect(quotes).toHaveLength(1)
    expect(quotePrice(quotes[0])).toBe(12) // 最后一次更正生效
  })

  it('币种与标的不一致时拒绝', async () => {
    const repo = await seedRepo()
    const r = await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 12,
      currency: 'USD', timestamp: NOW().toISOString(), now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid-input')
  })

  it('不存在的标的被拒绝', async () => {
    const repo = await seedRepo()
    const r = await upsertQuote(repo, {
      instrumentId: 'nope', priceKind: 'market_price', price: 12,
      currency: 'CNY', timestamp: NOW().toISOString(), now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing-instrument')
  })

  it('不同 priceKind 分别存储（nav 与 market_price 互不覆盖）', async () => {
    const repo = await seedRepo()
    await upsertQuote(repo, { instrumentId: 'i_stock', priceKind: 'market_price', price: 12, currency: 'CNY', timestamp: NOW().toISOString(), now: NOW })
    await upsertQuote(repo, { instrumentId: 'i_stock', priceKind: 'nav', price: 1.5, currency: 'CNY', timestamp: NOW().toISOString(), now: NOW })
    expect((await repo.loadPortfolio()).quotes).toHaveLength(2)
  })
})

/* ================================================================== *
 * 汇率写入
 * ================================================================== */

describe('汇率写入：经 Repository 覆盖写入', () => {
  it('【W8】不同时间点的汇率各自保留', async () => {
    const repo = await seedRepo()
    const days = ['2026-10-01', '2026-10-02', '2026-10-03']
    for (const [i, rate] of [7.0, 7.1, 7.2].entries()) {
      await upsertFxRate(repo, {
        baseCurrency: 'USD', quoteCurrency: 'CNY', rate,
        timestamp: `${days[i]}T10:00:00.000Z`, now: NOW,
      })
    }
    const rates = (await repo.loadPortfolio()).fxRates
    expect(rates).toHaveLength(3)
    expect(rates.map((r) => r.rate).sort()).toEqual([7.0, 7.1, 7.2])
  })

  it('【W8】同一时间点重复录入汇率只保留一条', async () => {
    const repo = await seedRepo()
    const ts = '2026-10-02T10:00:00.000Z'
    for (const rate of [7.0, 7.1, 7.2]) {
      await upsertFxRate(repo, {
        baseCurrency: 'USD', quoteCurrency: 'CNY', rate, timestamp: ts, now: NOW,
      })
    }
    const rates = (await repo.loadPortfolio()).fxRates
    expect(rates).toHaveLength(1)
    expect(rates[0].rate).toBe(7.2)
  })

  it('手填汇率如实标注 manual', async () => {
    const repo = await seedRepo()
    await upsertFxRate(repo, {
      baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2,
      timestamp: NOW().toISOString(), now: NOW,
    })
    const r = (await repo.loadPortfolio()).fxRates[0]
    expect(r.source).toBe('manual')
    expect(r.status).toBe('MANUAL')
  })

  it('汇率影响着估值（写入前后对比）', async () => {
    const repo = await seedRepo()
    const before = await valuationCompleteness(await repo.loadPortfolio(), NOW_MS)

    await upsertFxRate(repo, {
      baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2,
      timestamp: NOW().toISOString(), now: NOW,
    })

    const after = await valuationCompleteness(await repo.loadPortfolio(), NOW_MS)
    expect(after.totalAssets).toBeGreaterThan(before.totalAssets)
    expect(after.unavailableCount).toBeLessThan(before.unavailableCount)
  })

  it('币种工具函数有效', () => {
    expect(isCurrencyCode('USD')).toBe(true)
    expect(isCurrencyCode('XYZ')).toBe(false)
    expect(currencyOptions()).toContain('CNY')
  })
})

/* ================================================================== *
 * 估值依据展示（B）
 * ================================================================== */

describe('估值依据（B）：把来源 / 时间 / 状态变得可见', () => {
  it('内部 reason code 映射为中文（不再暴露 missing_fx）', () => {
    expect(reasonLabelsOf(['missing_fx'])).toEqual(['缺少汇率'])
    expect(reasonLabelsOf(['stale_quote'])).toEqual(['行情已过期'])
    expect(reasonLabelsOf(['missing_quote', 'missing_account'])).toEqual(['缺少行情', '未归属账户'])
    // 未知代码原样保留（不隐藏问题）
    expect(reasonLabelsOf(['weird_code' as never])).toEqual(['weird_code'])
  })

  it('估值状态有中文标签', () => {
    expect(VALUATION_STATUS_LABEL.ok).toBe('可靠估值')
    expect(VALUATION_STATUS_LABEL.stale).toBe('依据已过期')
    expect(VALUATION_STATUS_LABEL.unavailable).toBe('无法估值')
  })

  it('依据包含价格类型、状态、来源与时间', async () => {
    const repo = await seedRepo()
    await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 12,
      currency: 'CNY', timestamp: NOW().toISOString(), now: NOW,
    })
    const portfolio = await repo.loadPortfolio()
    const h = portfolio.holdings.find((x) => x.instrumentId === 'i_stock')!
    const r = valuateHolding(h, portfolio, { fx: createFxTable([]), now: NOW_MS })
    const basis = valuationBasisOf(r, portfolio, 'i_stock')

    expect(basis.reliable).toBe(true)
    expect(basis.priceKindLabel).toBe('市场价格')
    expect(basis.quoteStatusLabel).toBe('手动')
    expect(basis.source).toBe('manual')
    expect(basis.summary).toContain('市场价格')
    expect(basis.summary).toContain('manual')
  })

  it('覆盖率摘要如实报告缺行情 / 缺汇率', async () => {
    const repo = await seedRepo()
    const cov = quoteCoverageOf(await repo.loadPortfolio(), NOW_MS)
    expect(cov.missingQuote).toBe(1) // 股票缺行情（现金不算）
    expect(cov.missingFxCurrencies).toContain('USD')
    expect(cov.hasStale).toBe(false)
  })
})

/* ================================================================== *
 * 估值链一致性（不重复计算、不改账本）
 * ================================================================== */

describe('估值链：不重复计算，且不影响 Ledger', () => {
  it('录入行情不改变任何账本事实（价格不是账本事实）', async () => {
    const repo = await seedRepo()
    const before = await repo.loadPortfolio()

    await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 12,
      currency: 'CNY', timestamp: NOW().toISOString(), now: NOW,
    })

    const after = await repo.loadPortfolio()
    expect(after.transactions).toEqual(before.transactions)
    expect(after.holdings).toEqual(before.holdings)
  })

  it('录入汇率不改变账本与持仓', async () => {
    const repo = await seedRepo()
    const before = await repo.loadPortfolio()
    await upsertFxRate(repo, {
      baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2,
      timestamp: NOW().toISOString(), now: NOW,
    })
    const after = await repo.loadPortfolio()
    expect(after.transactions).toEqual(before.transactions)
    expect(after.holdings).toEqual(before.holdings)
  })

  it('deriveAnalysis 与 calculateTotals 同源（可靠总额一致）', async () => {
    const repo = await seedRepo()
    await upsertFxRate(repo, { baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: NOW().toISOString(), now: NOW })

    const portfolio = await repo.loadPortfolio()
    const fx = createFxTable(portfolio.fxRates)
    const results = portfolio.holdings.map((h) => valuateHolding(h, portfolio, { fx, now: NOW_MS }))
    const totals = calculateTotals({ portfolio, fx, now: NOW_MS })
    const analysis = deriveAnalysis({ portfolio, results, totals, now: NOW_MS })

    expect(analysis.reliableValueCny).toBe(totals.totalAssets)
  })

  it('Ledger 与行情无关：rebuild 结果不受行情影响', async () => {
    const repo = await seedRepo()
    const before = await repo.loadPortfolio()
    await upsertQuote(repo, {
      instrumentId: 'i_stock', priceKind: 'market_price', price: 99,
      currency: 'CNY', timestamp: NOW().toISOString(), now: NOW,
    })
    const after = await repo.loadPortfolio()

    const key = (h: { instrumentId: string; quantity?: number }) => `${h.instrumentId}::${h.quantity ?? 0}`
    const ledgerBefore = deriveLedger(before.transactions, {
      instrumentCurrency: (id) => before.instruments.find((i) => i.id === id)?.currency,
    })
    const ledgerAfter = deriveLedger(after.transactions, {
      instrumentCurrency: (id) => after.instruments.find((i) => i.id === id)?.currency,
    })
    expect([...ledgerAfter.positions.keys()].sort()).toEqual([...ledgerBefore.positions.keys()].sort())
    expect(rebuildHoldingsFromTransactions(after).holdings.map(key).sort()).toEqual(
      rebuildHoldingsFromTransactions(before).holdings.map(key).sort(),
    )
  })
})

/* ================================================================== *
 * 历史趋势与 V7 契约
 * ================================================================== */

describe('历史趋势：不把不可估值当 0', () => {
  it('缺金额的历史快照不参与分类汇总', () => {
    const p = basePortfolio()
    const { snapshot } = buildSnapshot(p, { date: '2026-10-04', now: NOW_MS })
    const trend = buildCompositionTrend([snapshot])

    expect(trend.points).toHaveLength(1)
    // 可靠总额只含人民币现金
    expect(trend.points[0].netWorth).toBe(100000)
    // 缺金额的项不贡献分类占比
    const sum = Object.values(trend.points[0].byClass ?? {}).reduce((s, v) => s + v, 0)
    expect(Math.abs(sum - 100000)).toBeLessThan(0.01)
  })
})

describe('迁移 V6 → V7：零填充，历史快照不回填', () => {
  it('不改写历史快照，只推进版本并统计', () => {
    const p: Portfolio2 = {
      ...basePortfolio(),
      snapshots: [
        {
          id: 's1', date: '2026-10-01', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000,
          currency: 'CNY', assetAllocation: {}, attributionStatus: 'unavailable',
          captureKind: 'REAL', createdAt: '2026-10-01T00:00:00.000Z',
          positions: [
            // V6 期间用 0 伪造的不可估值项
            { instrumentId: 'i_stock', accountId: 'a_cny', quantity: 100, price: 1, currency: 'CNY', rateToCny: 1, valueCny: 0, reliable: false },
          ],
        },
      ],
    }
    const before = JSON.stringify(p.snapshots)
    const r = migrateV6ToV7({ portfolio: p, now: () => '2026-10-04T00:00:00.000Z' })

    // 【核心】历史快照一字未改
    expect(JSON.stringify(r.portfolio.snapshots)).toBe(before)
    expect(r.legacyFabricatedPositionCount).toBe(1)
    expect(r.record.migrationId).toBe('schema-v6-to-v7-nullable-valuation')
    expect(r.record.note).toContain('不回填')
    expect(r.record.targetSchemaVersion).toBe(PORTFOLIO_SCHEMA_VERSION)
  })

  it('幂等：两次执行结果一致', () => {
    const p = basePortfolio()
    const a = migrateV6ToV7({ portfolio: p, now: () => 'T1' })
    const b = migrateV6ToV7({ portfolio: a.portfolio, now: () => 'T1' })
    expect(JSON.stringify(b.portfolio)).toBe(JSON.stringify(a.portfolio))
  })

  it('V7 快照的新字段可缺失（类型层已放开）', () => {
    const p = basePortfolio()
    const { snapshot } = buildSnapshot(p, { date: '2026-10-04', now: NOW_MS })
    const unreliable = snapshot.positions.filter((x) => !x.reliable)
    expect(unreliable.length).toBeGreaterThan(0)
    for (const pos of unreliable) {
      expect(pos.valueCny).toBeUndefined()
    }
  })
})

/* ================================================================== *
 * localStorage 隔离
 * ================================================================== */

describe('localStorage：行情与汇率来自 IndexedDB', () => {
  it('清空 localStorage 后行情与汇率仍完整', async () => {
    const repo = await seedRepo()
    await upsertQuote(repo, { instrumentId: 'i_stock', priceKind: 'market_price', price: 12, currency: 'CNY', timestamp: NOW().toISOString(), now: NOW })
    await upsertFxRate(repo, { baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: NOW().toISOString(), now: NOW })

    if (typeof globalThis.localStorage !== 'undefined') globalThis.localStorage.clear()

    const portfolio = await repo.loadPortfolio()
    expect(portfolio.quotes).toHaveLength(1)
    expect(portfolio.fxRates).toHaveLength(1)
    const t = await totalsOf(repo)
    expect(t.totalAssets).toBe(100000 + 72000 + 1200)
  })
})

/* ================================================================== *
 * IndexedDB 持久化
 * ================================================================== */

describe('IndexedDB 持久化：行情与汇率真正落库', () => {
  it('重新读取后行情与汇率仍在，且估值一致', async () => {
    const { repo, db } = await createPairedTestStore(`w6-price-${Date.now()}`)
    const p = basePortfolio()
    await repo.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })

    await upsertQuote(repo, { instrumentId: 'i_stock', priceKind: 'market_price', price: 12, currency: 'CNY', timestamp: NOW().toISOString(), now: NOW })
    await upsertFxRate(repo, { baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: NOW().toISOString(), now: NOW })

    // 从 IndexedDB 重新读取
    expect(await repo.quotes.getAll()).toHaveLength(1)
    expect(await repo.fxRates.getAll()).toHaveLength(1)

    const t = await totalsOf(repo)
    expect(t.totalAssets).toBe(100000 + 72000 + 1200)
    await db.delete()
  })
})
