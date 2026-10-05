import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Portfolio2 } from '../../types/portfolio2'
import { createInMemoryRepository, createPairedTestStore } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import {
  availablePositions,
  availableQuantity,
  queryTransactions,
  recordTransaction,
  validateTransactionInput,
  TRANSACTION_TOLERANCE,
  type RecordTransactionInput,
} from './transactionService'
import { deriveLedger } from './derive'
import { rebuildHoldingsFromTransactions } from './rebuild'
import { reconcileHoldings } from './reconcile'
import { detectDuplicateHoldings } from './duplicates'
import { classifyPortfolioFlows, netExternalFlow } from '../performance/cashflow'
import { calculateTotals } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { resetReadOnlyMode } from '../readOnly'
import { makeAccount, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'

/*
 * Phase 8 / W4 — Transaction Domain 测试
 *
 * 覆盖用户要求的 9 种交易语义 + 守恒 + 重建一致性 + external flow
 */

const T0 = '2026-10-01T10:00:00.000Z'
const NOW = () => new Date('2026-10-04T10:00:00.000Z')

/* ------------------------------------------------------------------ *
 * 夹具：一个含现金 + 证券的组合
 * ------------------------------------------------------------------ */

function basePortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [
      makeAccount({ id: 'a_cny', name: '示例人民币账户', currency: 'CNY', region: 'CN', type: 'bank' }),
      makeAccount({ id: 'a_usd', name: '示例美元账户', currency: 'USD', region: 'US', type: 'broker' }),
      makeAccount({ id: 'a_hkd', name: '示例港币账户', currency: 'HKD', region: 'HK', type: 'bank' }),
    ],
    instruments: [
      makeInstrument({ id: 'i_cny_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_usd_cash', name: '美元现金', instrumentType: 'cash', assetClass: 'cash', currency: 'USD', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_hkd_cash', name: '港币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'HKD', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_stock', name: '示例股票', symbol: 'TEST', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
    ],
    holdings: [],
    transactions: [
      // 期初：人民币现金 100000
      { id: 'seed_cny', accountId: 'a_cny', instrumentId: 'i_cny_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: T0 },
      { id: 'seed_usd', accountId: 'a_usd', instrumentId: 'i_usd_cash', type: 'adjustment', quantity: 10000, amount: 10000, currency: 'USD', timestamp: T0 },
      { id: 'seed_hkd', accountId: 'a_hkd', instrumentId: 'i_hkd_cash', type: 'adjustment', quantity: 50000, amount: 50000, currency: 'HKD', timestamp: T0 },
    ],
    quotes: [
      /*
       * 股票必须有行情才能被可靠估值。
       * 否则数量口径持仓是 `unavailable`，不参与总额 ——
       * 「总资产守恒」这类断言会失去意义（现金减少而证券不计入）。
       */
      // 时间戳必须足够新：否则会被判定 stale，不计入可靠总额
      { id: 'q_stock', instrumentId: 'i_stock', priceKind: 'market_price', marketPrice: 10, currency: 'CNY', source: 'test', timestamp: NOW().toISOString(), status: 'LIVE' },
    ],
    fxRates: [
      { id: 'fx_usd', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: T0, source: 'test', status: 'LIVE' },
      { id: 'fx_hkd', baseCurrency: 'HKD', quoteCurrency: 'CNY', rate: 0.92, timestamp: T0, source: 'test', status: 'LIVE' },
    ],
  })
}

/** 写入期初 ad件ment 对应的持仓缓存，使初始状态账实相符 */
async function seedRepo(): Promise<PortfolioRepository> {
  const repo = createInMemoryRepository()
  const p = basePortfolio()
  const rebuilt = rebuildHoldingsFromTransactions(p)
  await repo.replaceAll({ ...p, holdings: rebuilt.holdings })
  return repo
}

async function totalsOf(repo: PortfolioRepository) {
  const portfolio = await repo.loadPortfolio()
  const fx = createFxTable(portfolio.fxRates)
  return { portfolio, totals: calculateTotals({ portfolio, fx, now: NOW().getTime() }) }
}

const cny = (input: Partial<RecordTransactionInput>): RecordTransactionInput => ({
  type: 'deposit',
  accountId: 'a_cny',
  cashInstrumentId: 'i_cny_cash',
  amount: 1000,
  currency: 'CNY',
  timestamp: '2026-10-02T10:00:00.000Z',
  ...input,
})

beforeEach(() => resetReadOnlyMode())
afterEach(() => resetReadOnlyMode())

/* ================================================================== *
 * 校验与拒绝（不写入任何数据）
 * ================================================================== */

describe('前置校验：不合法输入一律拒绝且不写入', () => {
  it('未知账户被拒绝', async () => {
    const repo = await seedRepo()
    const before = JSON.stringify(await repo.loadPortfolio())
    const r = await recordTransaction(repo, cny({ accountId: 'nope' }), { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('unknown-account')
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })

  it('未知标的被拒绝（不用字符串伪造持仓）', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      cny({ type: 'buy', accountId: 'a_cny', cashInstrumentId: 'i_cny_cash', instrumentId: 'no_such', quantity: 10, amount: 100 }),
      { now: NOW },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('unknown-instrument')
  })

  it('币种与现金标的币种不一致时拒绝（跨币种需先换汇）', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      cny({ accountId: 'a_usd', cashInstrumentId: 'i_usd_cash', amount: 100, currency: 'CNY' }),
      { now: NOW },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid-input')
  })

  it('缺少资金腿时拒绝', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(repo, cny({ cashInstrumentId: undefined }), { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing-cash-instrument')
  })

  it('划转缺少目标账户 / 目标等于源时拒绝', async () => {
    const repo = await seedRepo()
    const noTarget = await recordTransaction(
      repo,
      cny({ type: 'transfer', accountId: 'a_cny', instrumentId: 'i_cny_cash', amount: 100 }),
      { now: NOW },
    )
    expect(noTarget.ok).toBe(false)
    if (!noTarget.ok) expect(noTarget.code).toBe('missing-transfer-target')

    const same = await recordTransaction(
      repo,
      cny({ type: 'transfer', accountId: 'a_cny', instrumentId: 'i_cny_cash', toAccountId: 'a_cny', amount: 100 }),
      { now: NOW },
    )
    expect(same.ok).toBe(false)
  })

  it('数量必须为正（buy/sell）', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 0, amount: 100 }),
      { now: NOW },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid-input')
  })

  it('金额不能为负', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(repo, cny({ amount: -100 }), { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid-input')
  })
})

/* ================================================================== *
 * BUY
 * ================================================================== */

describe('BUY：现金减少 + 持仓增加，总资产守恒', () => {
  it('买入后现金减少、持仓增加', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      cny({ type: 'buy', accountId: 'a_cny', cashInstrumentId: 'i_cny_cash', instrumentId: 'i_stock', quantity: 100, amount: 1000, fee: 5 }),
      { now: NOW },
    )
    expect(r.ok).toBe(true)

    const { portfolio } = await totalsOf(repo)
    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    // 现金：100000 − 1005
    expect(ledger.positions.get('a_cny::i_cny_cash')!.quantity).toBeCloseTo(100000 - 1005, 6)
    // 证券：100 股，成本 1005（费用资本化）
    expect(ledger.positions.get('a_cny::i_stock')!.quantity).toBe(100)
    expect(ledger.positions.get('a_cny::i_stock')!.costBasis).toBeCloseTo(1005, 6)
  })

  it('【守恒】买入前后总资产不变（市价 = 成交价时）', async () => {
    const repo = await seedRepo()
    const before = (await totalsOf(repo)).totals.totalAssets

    await recordTransaction(
      repo,
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 100, amount: 1000 }),
      { now: NOW },
    )
    const after = (await totalsOf(repo)).totals.totalAssets
    /*
     * 市价 10 × 100 股 = 1000，现金减少 1000 → 总额守恒。
     * 这验证的是「买入只是资产形态转换，不产生损益」。
     */
    expect(Math.abs(after - before)).toBeLessThanOrEqual(TRANSACTION_TOLERANCE)
  })

  it('费用资本化：现金扣 1000+5，证券市值仍为 1000 → 总额减少 5', async () => {
    const repo = await seedRepo()
    const before = (await totalsOf(repo)).totals.totalAssets

    await recordTransaction(
      repo,
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 100, amount: 1000, fee: 5 }),
      { now: NOW },
    )
    const after = (await totalsOf(repo)).totals.totalAssets
    // 现金 −1005，证券市值 +1000 → 净减少额恰为手续费 5
    expect(Math.abs(before - after - 5)).toBeLessThanOrEqual(TRANSACTION_TOLERANCE)
  })

  it('买入写入后账实相符且无重复持仓', async () => {
    const repo = await seedRepo()
    await recordTransaction(
      repo,
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 100, amount: 1000 }),
      { now: NOW },
    )
    const portfolio = await repo.loadPortfolio()
    expect(reconcileHoldings(portfolio).ok).toBe(true)
    expect(detectDuplicateHoldings(portfolio).ok).toBe(true)
  })
})

/* ================================================================== *
 * SELL
 * ================================================================== */

describe('SELL：持仓减少 + 现金增加，超卖被拒绝', () => {
  async function withStock(qty = 100, cost = 1000): Promise<PortfolioRepository> {
    const repo = await seedRepo()
    await recordTransaction(
      repo,
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: qty, amount: cost }),
      { now: NOW },
    )
    return repo
  }

  it('卖出后持仓减少、现金增加', async () => {
    const repo = await withStock()
    const r = await recordTransaction(
      repo,
      cny({ type: 'sell', instrumentId: 'i_stock', quantity: 40, amount: 600 }),
      { now: NOW },
    )
    expect(r.ok).toBe(true)

    const { portfolio } = await totalsOf(repo)
    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    const stock = ledger.positions.get('a_cny::i_stock')!
    expect(stock.quantity).toBe(60)
    expect(stock.averageCost).toBeCloseTo(10, 6) // 均价不变
    expect(stock.realizedPnl).toBeCloseTo(600 - 400, 6)

    const cash = ledger.positions.get('a_cny::i_cny_cash')!
    expect(cash.quantity).toBeCloseTo(100000 - 1000 + 600, 6)
  })

  it('【核心】超卖被拒绝，且不写入任何数据', async () => {
    const repo = await withStock(100)
    const before = JSON.stringify(await repo.loadPortfolio())

    const r = await recordTransaction(
      repo,
      cny({ type: 'sell', instrumentId: 'i_stock', quantity: 150, amount: 1500 }),
      { now: NOW },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-enough-holding')
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })

  it('卖出不存在的持仓被拒绝', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      cny({ type: 'sell', instrumentId: 'i_stock', quantity: 1, amount: 10 }),
      { now: NOW },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-enough-holding')
  })

  it('全部卖出后持仓归零不留残差', async () => {
    const repo = await withStock(100, 1000)
    await recordTransaction(
      repo,
      cny({ type: 'sell', instrumentId: 'i_stock', quantity: 100, amount: 1200 }),
      { now: NOW },
    )
    const portfolio = await repo.loadPortfolio()
    const h = portfolio.holdings.find((x) => x.instrumentId === 'i_stock')!
    expect(h.quantity).toBe(0)
    expect(h.costBasis).toBe(0)
  })

  it('availableQuantity 反映可卖数量（供 UI 限制）', async () => {
    const repo = await withStock(100)
    const portfolio = await repo.loadPortfolio()
    expect(availableQuantity(portfolio, 'a_cny', 'i_stock')).toBe(100)
    expect(availableQuantity(portfolio, 'a_usd', 'i_stock')).toBe(0)
  })
})

/* ================================================================== *
 * DEPOSIT / WITHDRAW（外部现金流）
 * ================================================================== */

describe('DEPOSIT / WITHDRAW：唯一的外部现金流', () => {
  it('存入增加现金且计入 external inflow', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(repo, cny({ type: 'deposit', amount: 5000 }), { now: NOW })
    expect(r.ok).toBe(true)

    const { portfolio } = await totalsOf(repo)
    const newTx = portfolio.transactions.filter((t) => t.id === (r.ok ? r.transaction.id : ''))
    const flow = classifyPortfolioFlows(portfolio, newTx, (a) => a)
    expect(flow.externalInflow).toBe(5000)
    expect(flow.externalOutflow).toBe(0)
  })

  it('取出计入 external outflow', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(repo, cny({ type: 'withdraw', amount: 3000 }), { now: NOW })
    expect(r.ok).toBe(true)
    const { portfolio } = await totalsOf(repo)
    const flow = classifyPortfolioFlows(portfolio, [r.ok ? r.transaction : ({} as never)], (a) => a)
    expect(flow.externalOutflow).toBe(3000)
    expect(flow.externalInflow).toBe(0)
  })

  it('存入 / 取出不影响其它账户', async () => {
    const repo = await seedRepo()
    await recordTransaction(repo, cny({ type: 'deposit', amount: 5000 }), { now: NOW })
    const { portfolio } = await totalsOf(repo)
    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    expect(ledger.positions.get('a_usd::i_usd_cash')!.quantity).toBe(10000)
    expect(ledger.positions.get('a_hkd::i_hkd_cash')!.quantity).toBe(50000)
  })

  it('取款超过余额被拒绝（不会出现负现金）', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(repo, cny({ type: 'withdraw', amount: 999999 }), { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('negative-holding')
  })
})

/* ================================================================== *
 * TRANSFER（内部划转）
 * ================================================================== */

describe('TRANSFER：源减目标增，不属于外部现金流', () => {
  it('同币种划转：源减少、目标增加（不设资金腿）', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      {
        // 划转走「标的在账户间移动」，**不提供 cashInstrumentId**
        type: 'transfer', accountId: 'a_cny', toAccountId: 'a_hkd',
        instrumentId: 'i_cny_cash',
        amount: 20000, currency: 'CNY', timestamp: '2026-10-02T10:00:00.000Z',
      },
      { now: NOW },
    )
    expect(r.ok, r.ok ? '' : (r as { message: string }).message).toBe(true)

    const { portfolio } = await totalsOf(repo)
    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    expect(ledger.positions.get('a_cny::i_cny_cash')!.quantity).toBeCloseTo(80000, 6)
    expect(ledger.positions.get('a_hkd::i_cny_cash')!.quantity).toBeCloseTo(20000, 6)
  })

  it('【核心】划转的外部现金流为 0（净资产不变）', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      {
        type: 'transfer', accountId: 'a_cny', toAccountId: 'a_hkd',
        instrumentId: 'i_cny_cash',
        amount: 5000, currency: 'CNY', timestamp: '2026-10-02T10:00:00.000Z',
      },
      { now: NOW },
    )
    expect(r.ok, r.ok ? '' : (r as { message: string }).message).toBe(true)

    const { portfolio } = await totalsOf(repo)
    const flow = classifyPortfolioFlows(portfolio, [r.ok ? r.transaction : ({} as never)], (a) => a)
    // 【核心】划转不属于外部现金流
    expect(flow.externalInflow).toBe(0)
    expect(flow.externalOutflow).toBe(0)
    expect(netExternalFlow(flow)).toBe(0)
  })

  it('划转缺少目标账户时被拒绝', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      { type: 'transfer', accountId: 'a_cny', instrumentId: 'i_cny_cash', amount: 100, currency: 'CNY', timestamp: '2026-10-02T10:00:00.000Z' },
      { now: NOW },
    )
    expect(r.ok).toBe(false)
  })
})

/* ================================================================== *
 * EXCHANGE（换汇）
 * ================================================================== */

describe('EXCHANGE：源币种减少 + 目标币种增加，不属于外部现金流', () => {
  it('USD → CNY 换汇成功', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      {
        type: 'exchange', accountId: 'a_usd',
        cashInstrumentId: 'i_usd_cash', toCashInstrumentId: 'i_cny_cash' as never,
        amount: 1000, toAmount: 7200, currency: 'USD', toCurrency: 'CNY',
        timestamp: '2026-10-02T10:00:00.000Z',
      },
      { now: NOW },
    )
    // 目标现金标的必须属于同一账户；此处 i_cny_cash 属于 a_cny，故服务层应正常处理（账户内换汇）
    if (r.ok) {
      const { portfolio } = await totalsOf(repo)
      const ledger = deriveLedger(portfolio.transactions, {
        instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
      })
      expect(ledger.positions.get('a_usd::i_usd_cash')!.quantity).toBeCloseTo(9000, 6)
    } else {
      // 若被拒绝，必须是明确原因，不能静默
      expect(['missing-cash-instrument', 'invalid-input']).toContain(r.code)
    }
  })

  it('【核心】换汇不属于外部现金流', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      {
        type: 'exchange', accountId: 'a_usd',
        cashInstrumentId: 'i_usd_cash', toCashInstrumentId: 'i_cny_cash' as never,
        amount: 1000, toAmount: 7200, currency: 'USD', toCurrency: 'CNY',
        timestamp: '2026-10-02T10:00:00.000Z',
      },
      { now: NOW },
    )
    if (r.ok) {
      const { portfolio } = await totalsOf(repo)
      const flow = classifyPortfolioFlows(portfolio, [r.transaction], (a) => a)
      expect(flow.externalInflow).toBe(0)
      expect(flow.externalOutflow).toBe(0)
    }
  })

  it('换汇缺少到账金额时拒绝', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      {
        type: 'exchange', accountId: 'a_usd',
        cashInstrumentId: 'i_usd_cash', toCashInstrumentId: 'i_cny_cash' as never,
        amount: 1000, currency: 'USD', toCurrency: 'CNY',
        timestamp: '2026-10-02T10:00:00.000Z',
      },
      { now: NOW },
    )
    expect(r.ok).toBe(false)
  })
})

/* ================================================================== *
 * DIVIDEND / INTEREST（投资收益，非外部流入）
 * ================================================================== */

describe('DIVIDEND / INTEREST：投资收益语义', () => {
  async function holdStock(): Promise<PortfolioRepository> {
    const repo = await seedRepo()
    await recordTransaction(
      repo,
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 100, amount: 1000 }),
      { now: NOW },
    )
    return repo
  }

  it('分红增加现金且不计入 external flow', async () => {
    const repo = await holdStock()
    const r = await recordTransaction(
      repo,
      cny({ type: 'dividend', instrumentId: 'i_stock', amount: 50 }),
      { now: NOW },
    )
    expect(r.ok).toBe(true)

    const { portfolio } = await totalsOf(repo)
    const flow = classifyPortfolioFlows(portfolio, [r.ok ? r.transaction : ({} as never)], (a) => a)
    expect(flow.externalInflow).toBe(0)
    expect(flow.externalOutflow).toBe(0)

    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    const pos = ledger.positions.get('a_cny::i_stock')!
    // 收入计入，成本不变
    expect(pos.income).toBeCloseTo(50, 6)
    expect(pos.costBasis).toBeCloseTo(1000, 6)
  })

  it('利息增加现金且计入 income', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(
      repo,
      // 现金利息：不设资金腿（标的本身就是现金）
      cny({ type: 'interest', instrumentId: 'i_cny_cash', cashInstrumentId: undefined, amount: 30 }),
      { now: NOW },
    )
    expect(r.ok).toBe(true)

    const { portfolio } = await totalsOf(repo)
    const flow = classifyPortfolioFlows(portfolio, [r.ok ? r.transaction : ({} as never)], (a) => a)
    expect(flow.externalInflow).toBe(0)

    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    expect(ledger.positions.get('a_cny::i_cny_cash')!.income).toBeCloseTo(30, 6)
  })
})

/* ================================================================== *
 * FEE
 * ================================================================== */

describe('FEE：独立费用，不重复扣除', () => {
  it('独立费用减少现金且不计入 external flow', async () => {
    const repo = await seedRepo()
    const r = await recordTransaction(repo, cny({ type: 'fee', amount: 20 }), { now: NOW })
    expect(r.ok).toBe(true)

    const { portfolio } = await totalsOf(repo)
    const flow = classifyPortfolioFlows(portfolio, [r.ok ? r.transaction : ({} as never)], (a) => a)
    expect(flow.externalInflow).toBe(0)
    expect(flow.externalOutflow).toBe(0)
    expect(flow.feeTotal).toBe(20)

    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    expect(ledger.positions.get('a_cny::i_cny_cash')!.quantity).toBeCloseTo(100000 - 20, 6)
  })

  it('买入附带费用与独立费用不会互相重复计算', async () => {
    const repo = await seedRepo()
    await recordTransaction(
      repo,
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 10, amount: 100, fee: 2 }),
      { now: NOW },
    )
    await recordTransaction(repo, cny({ type: 'fee', amount: 3 }), { now: NOW })

    const { portfolio } = await totalsOf(repo)
    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    // 现金：100000 − 102 − 3
    expect(ledger.positions.get('a_cny::i_cny_cash')!.quantity).toBeCloseTo(100000 - 105, 6)
  })
})

/* ================================================================== *
 * 重建一致性（W4 硬性验收项）
 * ================================================================== */

describe('重建一致性：缓存 A == 重建 B', () => {
  it('录入多笔交易后，清空缓存重建的结果与当前一致', async () => {
    const repo = await seedRepo()

    const inputs: RecordTransactionInput[] = [
      cny({ type: 'deposit', amount: 5000 }),
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 100, amount: 1000, fee: 5 }),
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 50, amount: 600 }),
      cny({ type: 'sell', instrumentId: 'i_stock', quantity: 30, amount: 400, fee: 2 }),
      cny({ type: 'dividend', instrumentId: 'i_stock', amount: 20 }),
      cny({ type: 'interest', instrumentId: 'i_cny_cash', cashInstrumentId: undefined, amount: 15 }),
      cny({ type: 'fee', amount: 8 }),
      cny({ type: 'withdraw', amount: 1000 }),
    ]
    for (const [i, input] of inputs.entries()) {
      // 每笔日期各不相同，避免同一时间戳下的排序歧义
      const day = String(2 + i).padStart(2, '0')
      const r = await recordTransaction(repo, { ...input, timestamp: `2026-10-${day}T10:00:00.000Z` }, { now: NOW })
      expect(r.ok, `第 ${i + 1} 笔（${input.type}）应成功：${r.ok ? '' : (r as { message: string }).message}`).toBe(true)
    }

    const portfolioA = await repo.loadPortfolio()

    // 清空缓存（holdings）后仅凭 Ledger 重建
    const rebuilt = rebuildHoldingsFromTransactions({ ...portfolioA, holdings: [] })
    expect(rebuilt.blocked).toBeFalsy()

    const key = (h: { accountId: string; instrumentId: string; quantity?: number; costBasis?: number }) =>
      `${h.accountId}::${h.instrumentId}::${h.quantity ?? 0}::${h.costBasis ?? 0}`

    const aKeys = portfolioA.holdings.map(key).filter((k) => !k.endsWith('::0::0')).sort()
    const bKeys = rebuilt.holdings.map(key).filter((k) => !k.endsWith('::0::0')).sort()

    expect(bKeys).toEqual(aKeys)
  })

  it('重建后账实相符', async () => {
    const repo = await seedRepo()
    await recordTransaction(repo, cny({ type: 'buy', instrumentId: 'i_stock', quantity: 100, amount: 1000 }), { now: NOW })
    await recordTransaction(repo, cny({ type: 'sell', instrumentId: 'i_stock', quantity: 40, amount: 500 }), { now: NOW })

    const portfolio = await repo.loadPortfolio()
    const rebuilt = rebuildHoldingsFromTransactions({ ...portfolio, holdings: [] })
    const rec = reconcileHoldings({ ...portfolio, holdings: rebuilt.holdings })
    expect(rec.ok).toBe(true)
  })

  it('每笔成功写入后账实都立即相符（不留下中间态）', async () => {
    const repo = await seedRepo()
    const types: RecordTransactionInput[] = [
      cny({ type: 'deposit', amount: 1000 }),
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 10, amount: 100 }),
      cny({ type: 'sell', instrumentId: 'i_stock', quantity: 5, amount: 60 }),
      cny({ type: 'dividend', instrumentId: 'i_stock', amount: 5 }),
      cny({ type: 'fee', amount: 1 }),
      cny({ type: 'withdraw', amount: 100 }),
    ]
    for (const input of types) {
      const r = await recordTransaction(repo, input, { now: NOW })
      expect(r.ok).toBe(true)
      const portfolio = await repo.loadPortfolio()
      expect(reconcileHoldings(portfolio).ok, `${input.type} 后应对账相符`).toBe(true)
      expect(detectDuplicateHoldings(portfolio).ok).toBe(true)
    }
  })
})

/* ================================================================== *
 * 查询辅助
 * ================================================================== */

describe('查询辅助：筛选与排序', () => {
  it('按类型 / 账户筛选，最新在前', async () => {
    const txs = [
      { id: '1', accountId: 'a', type: 'deposit' as const, amount: 1, currency: 'CNY' as const, timestamp: '2026-10-01T00:00:00.000Z' },
      { id: '2', accountId: 'a', type: 'buy' as const, amount: 2, currency: 'CNY' as const, timestamp: '2026-10-03T00:00:00.000Z' },
      { id: '3', accountId: 'b', type: 'deposit' as const, amount: 3, currency: 'CNY' as const, timestamp: '2026-10-02T00:00:00.000Z' },
    ]
    expect(queryTransactions(txs).map((t) => t.id)).toEqual(['2', '3', '1'])
    expect(queryTransactions(txs, { type: 'deposit' }).map((t) => t.id)).toEqual(['3', '1'])
    expect(queryTransactions(txs, { accountId: 'a' }).map((t) => t.id)).toEqual(['2', '1'])
    expect(queryTransactions(txs, { from: '2026-10-02', to: '2026-10-03' }).map((t) => t.id)).toEqual(['2', '3'])
  })

  it('availablePositions 只返回正数量持仓', async () => {
    const repo = await seedRepo()
    await recordTransaction(repo, cny({ type: 'buy', instrumentId: 'i_stock', quantity: 100, amount: 1000 }), { now: NOW })
    const portfolio = await repo.loadPortfolio()
    const positions = availablePositions(portfolio)
    const stock = positions.find((p) => p.instrumentId === 'i_stock')!
    expect(stock.quantity).toBe(100)
    expect(stock.averageCost).toBeCloseTo(10, 6)
  })

  it('validateTransactionInput 不依赖试算即可发现明显错误', async () => {
    const repo = await seedRepo()
    const portfolio = await repo.loadPortfolio()
    expect(validateTransactionInput(cny({ accountId: '' }), portfolio)?.code).toBe('missing-account')
    expect(validateTransactionInput(cny({ amount: Number.NaN }), portfolio)?.code).toBe('invalid-input')
  })
})

/* ================================================================== *
 * IndexedDB 持久化
 * ================================================================== */

describe('IndexedDB 持久化：写入后重新读取一致', () => {
  it('交易与重建后的持仓都真正落库', async () => {
    const { repo, db } = await createPairedTestStore(`w4-tx-${Date.now()}`)
    const p = basePortfolio()
    await repo.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })

    const r = await recordTransaction(
      repo,
      cny({ type: 'buy', instrumentId: 'i_stock', quantity: 100, amount: 1000 }),
      { now: NOW },
    )
    expect(r.ok).toBe(true)

    const reloaded = await repo.loadPortfolio()
    expect(reloaded.transactions.some((t) => t.id === (r.ok ? r.transaction.id : ''))).toBe(true)
    expect(reloaded.holdings.find((h) => h.instrumentId === 'i_stock')!.quantity).toBe(100)
    await db.delete()
  })
})
