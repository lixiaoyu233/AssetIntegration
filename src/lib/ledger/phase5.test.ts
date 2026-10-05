import { describe, expect, it } from 'vitest'
import type { Portfolio2, Transaction } from '../../types/portfolio2'
import {
  aggregateByInstrument,
  checkLedgerInvariants,
  deriveLedger,
  deriveLedgerEffects,
  effectsOfTransaction,
  feesByCurrency,
  getPosition,
  incomeByCurrency,
  realizedPnlByCurrency,
  cashFlowByAccount,
} from './derive'
import { reconcileHoldings } from './reconcile'
import { adoptOrphanHolding, rebuildHoldingsFromTransactions } from './rebuild'
import { calculateTotals } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import {
  NOW,
  makeAccount,
  makeHolding,
  makeInstrument,
  makePortfolio,
  makeQuote,
  resetIds,
} from '../valuation/__fixtures__/builders'

/*
 * Phase 5 测试矩阵
 *
 * 覆盖用户点名的全部验收项：
 * Cash / Buy / Sell / Dividend-Interest / Transfer / FX Exchange / Rebuild
 */

/* ------------------------------------------------------------------ *
 * 构造器
 * ------------------------------------------------------------------ */

let seq = 0
const tx = (patch: Partial<Transaction> & Pick<Transaction, 'type' | 'amount'>): Transaction => ({
  id: patch.id ?? `t${++seq}`,
  accountId: patch.accountId ?? 'a1',
  currency: patch.currency ?? 'CNY',
  timestamp: patch.timestamp ?? '2026-10-03T10:00:00.000Z',
  ...patch,
})

const A = 'acct_a'
const B = 'acct_b'

/** 一个包含多币种现金 + 股票标的的组合骨架 */
function skeleton(): Portfolio2 {
  const cnyCash = makeInstrument({ id: 'CASH_CNY', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY' })
  const usdCash = makeInstrument({ id: 'CASH_USD', name: '美元现金', instrumentType: 'cash', assetClass: 'cash', currency: 'USD' })
  const hkdCash = makeInstrument({ id: 'CASH_HKD', name: '港币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'HKD' })
  const spym = makeInstrument({ id: 'SPYM', name: '示例美股 ETF', instrumentType: 'etf', assetClass: 'equity', currency: 'USD' })
  return makePortfolio({
    accounts: [
      makeAccount({ id: A, name: '示例券商', currency: 'USD', region: 'US', type: 'broker' }),
      makeAccount({ id: B, name: '示例银行', currency: 'CNY' }),
    ],
    instruments: [cnyCash, usdCash, hkdCash, spym],
    holdings: [],
    transactions: [],
  })
}

const currencyOf = (p: Portfolio2) => (id: string) => p.instruments.find((i) => i.id === id)?.currency

/* ================================================================== *
 * 1. Cash Holding
 * ================================================================== */

describe('Cash Holding：数量即金额，不需要行情', () => {
  it('cash quantity 可以直接估值（无 Quote）', () => {
    const p = skeleton()
    const holding = makeHolding({
      id: 'h_cash', accountId: A, instrumentId: 'CASH_CNY',
      valuationMode: 'quantity', quantity: 20000,
    })
    const portfolio = { ...p, holdings: [holding] }
    const totals = calculateTotals({ portfolio, now: NOW })
    expect(totals.totalAssets).toBe(20000)
    expect(totals.reliableCount).toBe(1)
    expect(totals.unavailableCount).toBe(0)
  })

  it('cash 不需要 Quote：没有行情也能可靠估值', () => {
    const p = skeleton()
    const portfolio = {
      ...p,
      holdings: [makeHolding({ id: 'h1', accountId: A, instrumentId: 'CASH_USD', valuationMode: 'quantity', quantity: 1000 })],
      quotes: [], // 完全没有行情
      fxRates: [{ id: 'f1', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: new Date(NOW).toISOString(), source: 't', status: 'LIVE' }],
    } as Portfolio2
    const totals = calculateTotals({ portfolio, now: NOW })
    expect(totals.totalAssets).toBeCloseTo(7200, 6)
  })

  it('cash 不会被错误识别成 investment（有行情也不查行情）', () => {
    const p = skeleton()
    const portfolio = {
      ...p,
      holdings: [makeHolding({ id: 'h1', accountId: A, instrumentId: 'CASH_CNY', valuationMode: 'quantity', quantity: 5000 })],
      // 故意给一个离谱的行情，若被当成投资品种则会用到它
      quotes: [makeQuote({ id: 'q1', instrumentId: 'CASH_CNY', marketPrice: 999999, status: 'LIVE', timestamp: new Date(NOW).toISOString() })],
    } as Portfolio2
    expect(calculateTotals({ portfolio, now: NOW }).totalAssets).toBe(5000)
  })

  it('多币种现金分别独立（同一账户三家币种）', () => {
    const p = skeleton()
    const portfolio = {
      ...p,
      holdings: [
        makeHolding({ id: 'h1', accountId: A, instrumentId: 'CASH_CNY', valuationMode: 'quantity', quantity: 10000 }),
        makeHolding({ id: 'h2', accountId: A, instrumentId: 'CASH_USD', valuationMode: 'quantity', quantity: 1000 }),
        makeHolding({ id: 'h3', accountId: A, instrumentId: 'CASH_HKD', valuationMode: 'quantity', quantity: 50000 }),
      ],
      fxRates: [
        { id: 'f1', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: new Date(NOW).toISOString(), source: 't', status: 'LIVE' },
        { id: 'f2', baseCurrency: 'HKD', quoteCurrency: 'CNY', rate: 0.92, timestamp: new Date(NOW).toISOString(), source: 't', status: 'LIVE' },
      ],
    } as Portfolio2
    const t = calculateTotals({ portfolio, now: NOW })
    expect(t.totalAssets).toBeCloseTo(10000 + 7200 + 46000, 6)
    expect(t.reliableCount).toBe(3)
  })

  it('由交易驱动的现金：adjustment 期初 + deposit 增加', () => {
    const p = skeleton()
    const txs = [
      tx({ id: 'a1', type: 'adjustment', accountId: A, instrumentId: 'CASH_CNY', quantity: 10000, amount: 10000, timestamp: '2026-10-01T00:00:00.000Z' }),
      tx({ id: 'd1', type: 'deposit', accountId: A, cashInstrumentId: 'CASH_CNY', amount: 5000, timestamp: '2026-10-02T00:00:00.000Z' }),
    ]
    const report = deriveLedger(txs, { instrumentCurrency: currencyOf(p) })
    const pos = getPosition(report, A, 'CASH_CNY')!
    expect(pos.quantity).toBe(15000)
    expect(pos.costBasis).toBe(15000)
    expect(pos.averageCost).toBe(1)
  })

  it('现金持仓币种取自交易/标的，不会被标成 CNY', () => {
    const p = skeleton()
    const report = deriveLedger(
      [tx({ type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 1000, amount: 1000, currency: 'USD' })],
      { instrumentCurrency: currencyOf(p) },
    )
    expect(getPosition(report, A, 'CASH_USD')!.currency).toBe('USD')
  })
})

/* ================================================================== *
 * 2. Buy
 * ================================================================== */

describe('Buy：投资腿 + 现金腿，费用资本化，不重复计量', () => {
  const setup = () => {
    const p = skeleton()
    const txs = [
      tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 10000, amount: 10000, currency: 'USD', timestamp: '2026-10-01T00:00:00.000Z' }),
      tx({
        id: 'buy1', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD',
        quantity: 13, amount: 1000, fee: 5, currency: 'USD', timestamp: '2026-10-02T00:00:00.000Z',
      }),
    ]
    return { p, txs, report: deriveLedger(txs, { instrumentCurrency: currencyOf(p) }) }
  }

  it('同币种 buy 合法', () => {
    const { report } = setup()
    expect(report.issues).toHaveLength(0)
  })

  it('【非法】跨币种 buy 直接报 Issue（SPYM USD + CNY 现金）', () => {
    const p = skeleton()
    const report = deriveLedger(
      [
        tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_CNY', quantity: 10000, amount: 10000 }),
        tx({ id: 'bad', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_CNY', quantity: 1, amount: 1000, currency: 'USD' }),
      ],
      { instrumentCurrency: currencyOf(p) },
    )
    expect(report.issues.some((i) => i.reason === 'currency_mismatch')).toBe(true)
    // 被拒绝的交易不产生任何效果
    expect(getPosition(report, A, 'SPYM')).toBeUndefined()
  })

  it('同时产生 investment leg + cash leg', () => {
    const { report } = setup()
    const effects = effectsOfTransaction(report, 'buy1')
    expect(effects.filter((e) => e.leg === 'instrument')).toHaveLength(1)
    expect(effects.filter((e) => e.leg === 'cash')).toHaveLength(1)
  })

  it('证券：数量 +13，成本 +1005（费用资本化）', () => {
    const { report } = setup()
    const spym = getPosition(report, A, 'SPYM')!
    expect(spym.quantity).toBe(13)
    expect(spym.costBasis).toBeCloseTo(1005, 6)
    expect(spym.averageCost).toBeCloseTo(1005 / 13, 6)
  })

  it('现金：数量 −1005（金额 + 费用）', () => {
    const { report } = setup()
    expect(getPosition(report, A, 'CASH_USD')!.quantity).toBeCloseTo(10000 - 1005, 6)
  })

  it('【核心】不重复计算现金：现金流只算一次', () => {
    const { report, txs } = setup()
    // 投资腿与现金腿都记录了 −1005，但统计时按交易去重
    const flow = cashFlowByAccount(report, txs)
    expect(flow.get(A)!.USD).toBeCloseTo(-1005, 6)
  })

  it('【核心】fee 不重复计算：费用合计等于 5', () => {
    const { report } = setup()
    expect(feesByCurrency(report).USD).toBe(5)
    // 且已资本化进证券成本，没有额外扣减资产
    expect(getPosition(report, A, 'SPYM')!.costBasis).toBe(1005)
  })

  it('买入前后「现金 + 证券」总价值守恒（忽略费用）', () => {
    const p = skeleton()
    const before = [
      tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 10000, amount: 10000, currency: 'USD' }),
    ]
    const after = [
      ...before,
      tx({ id: 'buy0', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', quantity: 10, amount: 1000, currency: 'USD' }),
    ]
    const r1 = deriveLedger(before, { instrumentCurrency: currencyOf(p) })
    const r2 = deriveLedger(after, { instrumentCurrency: currencyOf(p) })
    const sum = (r: ReturnType<typeof deriveLedger>) =>
      [...r.positions.values()].reduce((s, pos) => s + pos.costBasis, 0)
    // 无费用时总额完全不变
    expect(sum(r2)).toBeCloseTo(sum(r1), 6)
  })
})

/* ================================================================== *
 * 3. Sell
 * ================================================================== */

describe('Sell：按均价结转、均价不变、已实现盈亏、费用进净收益', () => {
  const setup = (sellQty: number, sellAmount: number, fee = 0) => {
    const p = skeleton()
    const txs = [
      // 100 股，costBasis 10000 → 均价 100
      tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'SPYM', quantity: 100, amount: 10000, currency: 'USD', timestamp: '2026-10-01T00:00:00.000Z' }),
      tx({
        id: 'sell1', type: 'sell', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD',
        quantity: sellQty, amount: sellAmount, fee, currency: 'USD', timestamp: '2026-10-02T00:00:00.000Z',
      }),
    ]
    return { report: deriveLedger(txs, { instrumentCurrency: currencyOf(p) }), txs, p }
  }

  it('部分卖出：剩余数量与成本正确，均价不变', () => {
    const { report } = setup(30, 3500, 5)
    const pos = getPosition(report, A, 'SPYM')!
    expect(pos.quantity).toBe(70)
    expect(pos.costBasis).toBeCloseTo(7000, 6) // 结转 30 × 100 = 3000
    expect(pos.averageCost).toBeCloseTo(100, 6)
  })

  it('realizedPnl = 3495 − 3000 = +495（费用已进净收益）', () => {
    const { report } = setup(30, 3500, 5)
    expect(getPosition(report, A, 'SPYM')!.realizedPnl).toBeCloseTo(495, 6)
  })

  it('realizedPnl 为负的情况', () => {
    const { report } = setup(30, 2500, 0)
    expect(getPosition(report, A, 'SPYM')!.realizedPnl).toBeCloseTo(-500, 6)
  })

  it('cash 腿收到净额 3495', () => {
    const { report } = setup(30, 3500, 5)
    expect(getPosition(report, A, 'CASH_USD')!.quantity).toBeCloseTo(3495, 6)
  })

  it('全部卖出：quantity = 0 且 costBasis = 0（不留浮点残差）', () => {
    const { report } = setup(100, 12000, 6)
    const pos = getPosition(report, A, 'SPYM')!
    expect(pos.quantity).toBe(0)
    expect(pos.costBasis).toBe(0)
    expect(pos.averageCost).toBe(0)
    expect(pos.realizedPnl).toBeCloseTo(12000 - 6 - 10000, 6)
  })

  it('卖出不产生收入（income 保持 0）', () => {
    const { report } = setup(30, 3500, 5)
    expect(getPosition(report, A, 'SPYM')!.income).toBe(0)
    expect(incomeByCurrency(report).USD ?? 0).toBe(0)
  })
})

/* ================================================================== *
 * 4. Dividend / Interest
 * ================================================================== */

describe('Dividend / Interest：现金增加、成本不变、收入正确、费用扣减收入', () => {
  const setup = (type: 'dividend' | 'interest', amount: number, fee = 0) => {
    const p = skeleton()
    const txs = [
      tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'SPYM', quantity: 100, amount: 10000, currency: 'USD', timestamp: '2026-10-01T00:00:00.000Z' }),
      tx({ id: 'inc1', type, accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', amount, fee, currency: 'USD', timestamp: '2026-10-02T00:00:00.000Z' }),
    ]
    return deriveLedger(txs, { instrumentCurrency: currencyOf(p) })
  }

  it('分红：cash 增加', () => {
    expect(getPosition(setup('dividend', 50), A, 'CASH_USD')!.quantity).toBeCloseTo(50, 6)
  })

  it('分红：costBasis 不变（不冲减成本）', () => {
    const pos = getPosition(setup('dividend', 50), A, 'SPYM')!
    expect(pos.costBasis).toBe(10000)
    expect(pos.quantity).toBe(100)
    expect(pos.averageCost).toBeCloseTo(100, 6)
  })

  it('分红：income 正确', () => {
    expect(getPosition(setup('dividend', 50), A, 'SPYM')!.income).toBeCloseTo(50, 6)
    expect(incomeByCurrency(setup('dividend', 50)).USD).toBeCloseTo(50, 6)
  })

  it('分红：费用扣减收入', () => {
    const r = setup('dividend', 50, 2)
    expect(getPosition(r, A, 'SPYM')!.income).toBeCloseTo(48, 6)
    expect(getPosition(r, A, 'CASH_USD')!.quantity).toBeCloseTo(48, 6)
  })

  it('利息：同样计入收入且不动成本', () => {
    const r = setup('interest', 30, 1)
    const pos = getPosition(r, A, 'SPYM')!
    expect(pos.income).toBeCloseTo(29, 6)
    expect(pos.costBasis).toBe(10000)
  })

  it('分红不产生 realizedPnl', () => {
    expect(getPosition(setup('dividend', 50), A, 'SPYM')!.realizedPnl).toBe(0)
    expect(realizedPnlByCurrency(setup('dividend', 50)).USD ?? 0).toBe(0)
  })
})

/* ================================================================== *
 * 5. Transfer
 * ================================================================== */

describe('Transfer：整体与部分，成本按均价转移，不产生损益', () => {
  const setup = (transferQuantity?: number) => {
    const p = skeleton()
    const txs = [
      tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'SPYM', quantity: 100, amount: 6000, currency: 'USD', timestamp: '2026-10-01T00:00:00.000Z' }),
      tx({
        id: 'tr1', type: 'transfer', accountId: A, toAccountId: B, instrumentId: 'SPYM',
        quantity: 100, amount: 6000, currency: 'USD', transferQuantity, timestamp: '2026-10-02T00:00:00.000Z',
      }),
    ]
    return deriveLedger(txs, { instrumentCurrency: currencyOf(p) })
  }

  it('同币种完整 transfer：源归零、目标承接', () => {
    const r = setup()
    expect(getPosition(r, A, 'SPYM')!.quantity).toBe(0)
    expect(getPosition(r, B, 'SPYM')!.quantity).toBe(100)
    expect(getPosition(r, B, 'SPYM')!.costBasis).toBeCloseTo(6000, 6)
  })

  it('同币种部分 transfer：源保留余额', () => {
    const r = setup(30)
    expect(getPosition(r, A, 'SPYM')!.quantity).toBe(70)
    expect(getPosition(r, B, 'SPYM')!.quantity).toBe(30)
  })

  it('成本按平均成本转移（均价 60）', () => {
    const r = setup(30)
    expect(getPosition(r, B, 'SPYM')!.costBasis).toBeCloseTo(1800, 6)
    expect(getPosition(r, A, 'SPYM')!.costBasis).toBeCloseTo(4200, 6)
    expect(getPosition(r, A, 'SPYM')!.averageCost).toBeCloseTo(60, 6)
    expect(getPosition(r, B, 'SPYM')!.averageCost).toBeCloseTo(60, 6)
  })

  it('realizedPnl = 0', () => {
    const r = setup(30)
    expect(getPosition(r, A, 'SPYM')!.realizedPnl).toBe(0)
    expect(realizedPnlByCurrency(r).USD ?? 0).toBe(0)
  })

  it('总数量与总成本守恒', () => {
    for (const q of [undefined, 30, 100]) {
      const agg = aggregateByInstrument(setup(q)).get('SPYM')!
      expect(agg.quantity).toBe(100)
      expect(agg.costBasis).toBeCloseTo(6000, 6)
    }
  })

  it('不产生现金流', () => {
    const r = setup(30)
    expect(r.entries.every((e) => e.cashDelta === 0)).toBe(true)
  })
})

/* ================================================================== *
 * 6. FX Exchange
 * ================================================================== */

describe('FX Exchange：不是买卖，不产生 investmentReturn / realizedPnl', () => {
  const setup = (from: string, to: string, amount: number, toAmount: number, toCurrency?: string) => {
    const p = skeleton()
    const txs = [
      tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: from, quantity: 10000, amount: 10000, currency: from === 'CASH_USD' ? 'USD' : 'CNY', timestamp: '2026-10-01T00:00:00.000Z' }),
      tx({
        id: 'fx1', type: 'exchange', accountId: A,
        cashInstrumentId: from, toCashInstrumentId: to,
        amount, toAmount, toCurrency: toCurrency as never,
        currency: from === 'CASH_USD' ? 'USD' : 'CNY',
        timestamp: '2026-10-02T00:00:00.000Z',
      }),
    ]
    return { report: deriveLedger(txs, { instrumentCurrency: currencyOf(p) }), txs, p }
  }

  it('USD → CNY：源减少、目标增加', () => {
    const { report } = setup('CASH_USD', 'CASH_CNY', 1000, 7200, 'CNY')
    expect(getPosition(report, A, 'CASH_USD')!.quantity).toBeCloseTo(9000, 6)
    expect(getPosition(report, A, 'CASH_CNY')!.quantity).toBeCloseTo(7200, 6)
  })

  it('CNY → USD：反向同样成立', () => {
    const { report } = setup('CASH_CNY', 'CASH_USD', 7200, 1000, 'USD')
    expect(getPosition(report, A, 'CASH_CNY')!.quantity).toBeCloseTo(2800, 6)
    expect(getPosition(report, A, 'CASH_USD')!.quantity).toBeCloseTo(1000, 6)
  })

  it('不产生 realizedPnl', () => {
    const { report } = setup('CASH_USD', 'CASH_CNY', 1000, 7200, 'CNY')
    expect(getPosition(report, A, 'CASH_USD')!.realizedPnl).toBe(0)
    expect(getPosition(report, A, 'CASH_CNY')!.realizedPnl).toBe(0)
    expect(realizedPnlByCurrency(report).CNY ?? 0).toBe(0)
    expect(realizedPnlByCurrency(report).USD ?? 0).toBe(0)
  })

  it('不产生 income', () => {
    const { report } = setup('CASH_USD', 'CASH_CNY', 1000, 7200, 'CNY')
    expect(incomeByCurrency(report).CNY ?? 0).toBe(0)
    expect(incomeByCurrency(report).USD ?? 0).toBe(0)
  })

  it('不依赖 Transaction 内的 settlementRate（只用到账金额与两腿）', () => {
    const { report } = setup('CASH_USD', 'CASH_CNY', 1000, 7200, 'CNY')
    const effects = effectsOfTransaction(report, 'fx1')
    expect(effects).toHaveLength(2)
    expect(effects.map((e) => e.leg).sort()).toEqual(['cash', 'cash_target'])
    // 效果里没有任何汇率字段
    expect(effects.every((e) => !('rate' in e))).toBe(true)
  })

  it('产生两条资金腿，一增一减', () => {
    const { report } = setup('CASH_USD', 'CASH_CNY', 1000, 7200, 'CNY')
    const effects = effectsOfTransaction(report, 'fx1')
    const out = effects.find((e) => e.leg === 'cash')!
    const inn = effects.find((e) => e.leg === 'cash_target')!
    expect(out.quantityDelta).toBe(-1000)
    expect(inn.quantityDelta).toBe(7200)
  })

  it('【非法】缺少目标现金标的时报 Issue', () => {
    const p = skeleton()
    const report = deriveLedger(
      [tx({ id: 'bad', type: 'exchange', accountId: A, cashInstrumentId: 'CASH_USD', amount: 100, currency: 'USD' })],
      { instrumentCurrency: currencyOf(p) },
    )
    expect(report.issues.some((i) => i.reason === 'missing_exchange_target')).toBe(true)
  })

  it('【非法】源与目标同币种时报 Issue（同币种应用 transfer）', () => {
    const report = deriveLedger(
      [
        tx({
          id: 'bad', type: 'exchange', accountId: A,
          cashInstrumentId: 'CASH_USD', toCashInstrumentId: 'CASH_USD2',
          amount: 100, toAmount: 100, currency: 'USD',
        }),
      ],
      { instrumentCurrency: (id) => (id === 'CASH_USD' || id === 'CASH_USD2' ? 'USD' : undefined) },
    )
    expect(report.issues.some((i) => i.reason === 'exchange_same_currency')).toBe(true)
  })

  it('换汇跨组合边界不产生 externalFlow（属于内部）', async () => {
    const { txs, p } = setup('CASH_USD', 'CASH_CNY', 1000, 7200, 'CNY')
    void p
    const { classifyPortfolioFlows } = await import('../performance/cashflow')
    const flow = classifyPortfolioFlows(p, txs, (a) => a)
    expect(flow.externalInflow).toBe(0)
    expect(flow.externalOutflow).toBe(0)
  })
})

/* ================================================================== *
 * 7. Rebuild 闭环（最重要的一组）
 * ================================================================== */

describe('Rebuild：Transaction → deriveLedger → rebuildHoldings → reconcile 必须闭环', () => {
  function richPortfolio(): Portfolio2 {
    const p = skeleton()
    const txs = [
      tx({ id: 'a1', type: 'adjustment', accountId: A, instrumentId: 'SPYM', quantity: 100, amount: 10000, currency: 'USD', timestamp: '2026-01-01T00:00:00.000Z' }),
      tx({ id: 'a2', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 50000, amount: 50000, currency: 'USD', timestamp: '2026-01-01T00:00:00.000Z' }),
      tx({ id: 'b1', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', quantity: 20, amount: 2200, fee: 10, currency: 'USD', timestamp: '2026-02-01T00:00:00.000Z' }),
      tx({ id: 's1', type: 'sell', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', quantity: 50, amount: 6000, fee: 8, currency: 'USD', timestamp: '2026-03-01T00:00:00.000Z' }),
      tx({ id: 'd1', type: 'dividend', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', amount: 120, fee: 2, currency: 'USD', timestamp: '2026-04-01T00:00:00.000Z' }),
      tx({ id: 't1', type: 'transfer', accountId: A, toAccountId: B, instrumentId: 'SPYM', quantity: 30, amount: 3000, currency: 'USD', transferQuantity: 30, timestamp: '2026-05-01T00:00:00.000Z' }),
      tx({ id: 'x1', type: 'exchange', accountId: A, cashInstrumentId: 'CASH_USD', toCashInstrumentId: 'CASH_CNY', amount: 1000, toAmount: 7200, toCurrency: 'CNY', currency: 'USD', timestamp: '2026-06-01T00:00:00.000Z' }),
    ]
    return { ...p, transactions: txs }
  }

  it('没有任何持仓时也能从交易完整重建', () => {
    const portfolio = richPortfolio()
    const r = rebuildHoldingsFromTransactions(portfolio)
    expect(r.holdings.length).toBeGreaterThan(0)
    expect(r.createdCount).toBeGreaterThan(0)
    expect(r.orphans).toHaveLength(0)
  })

  it('【核心】重建前后 calculateTotals 完全一致（重建不丢资产）', () => {
    const portfolio = richPortfolio()
    const fx = createFxTable([
      { id: 'f1', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: new Date(NOW).toISOString(), source: 't', status: 'LIVE' },
    ])
    // 基线：先由交易派生出一份持仓（这是「缓存已有」的状态）
    const baseline = { ...portfolio, holdings: rebuildHoldingsFromTransactions(portfolio).holdings }

    // 再重建一次：缓存应当保持不变
    const rebuilt = { ...baseline, holdings: rebuildHoldingsFromTransactions(baseline).holdings }

    const before = calculateTotals({ portfolio: baseline, fx, now: NOW })
    const after = calculateTotals({ portfolio: rebuilt, fx, now: NOW })

    expect(before.totalAssets).toBeGreaterThan(0) // 基线确实有资产
    expect(after.totalAssets).toBeCloseTo(before.totalAssets, 6)
    expect(after.totalLiabilities).toBeCloseTo(before.totalLiabilities, 6)
    expect(after.netWorth).toBeCloseTo(before.netWorth, 6)
  })

  it('【核心】重建不会因为「持仓表为空」而凭空产生或丢失资产', () => {
    const portfolio = richPortfolio()
    const fx = createFxTable([
      { id: 'f1', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: new Date(NOW).toISOString(), source: 't', status: 'LIVE' },
    ])
    const empty = calculateTotals({ portfolio, fx, now: NOW })
    expect(empty.totalAssets).toBe(0) // 还没有持仓缓存

    const rebuilt = { ...portfolio, holdings: rebuildHoldingsFromTransactions(portfolio).holdings }
    const afterRebuild = calculateTotals({ portfolio: rebuilt, fx, now: NOW })
    expect(afterRebuild.totalAssets).toBeGreaterThan(0) // 重建从交易还原出资产

    // 再重建一次保持不变（幂等，不增长）
    const again = { ...rebuilt, holdings: rebuildHoldingsFromTransactions(rebuilt).holdings }
    expect(calculateTotals({ portfolio: again, fx, now: NOW }).totalAssets).toBeCloseTo(afterRebuild.totalAssets, 6)
  })

  it('【核心】重建后再对账必须完全一致（闭环）', () => {
    const portfolio = richPortfolio()
    const rebuilt = { ...portfolio, holdings: rebuildHoldingsFromTransactions(portfolio).holdings }
    const report = reconcileHoldings(rebuilt)
    expect(report.ok).toBe(true)
    expect(report.issues).toHaveLength(0)
  })

  it('重建幂等：连续两次结果一致', () => {
    const portfolio = richPortfolio()
    const once = rebuildHoldingsFromTransactions(portfolio).holdings
    const twice = rebuildHoldingsFromTransactions({ ...portfolio, holdings: once }).holdings
    expect(twice.map((h) => `${h.accountId}:${h.instrumentId}:${h.quantity}:${h.costBasis}`).sort()).toEqual(
      once.map((h) => `${h.accountId}:${h.instrumentId}:${h.quantity}:${h.costBasis}`).sort(),
    )
  })

  it('manual 持仓不参与重建，原样保留', () => {
    const portfolio = { ...richPortfolio(), holdings: [makeHolding({ id: 'm1', accountId: B, instrumentId: 'CASH_CNY', valuationMode: 'manual', manualValue: 88888 })] }
    const r = rebuildHoldingsFromTransactions(portfolio)
    expect(r.preservedCount).toBe(1)
    expect(r.holdings.find((h) => h.id === 'm1')!.manualValue).toBe(88888)
  })

  it('【核心】孤立持仓被保留并标记，绝不静默删除', () => {
    const portfolio = richPortfolio()
    // 一个没有任何交易依据的持仓（模拟迁移不完整 / 历史流水缺失）
    const orphan = makeHolding({
      id: 'orphan_h', accountId: A, instrumentId: 'SPYM',
      valuationMode: 'quantity', quantity: 999, costBasis: 12345,
    })
    const withOrphan = { ...portfolio, holdings: [orphan] }

    rebuildHoldingsFromTransactions(withOrphan)
    void orphan
    // 真正孤立的：换一个没有交易的账户
    const realOrphan = makeHolding({
      id: 'orphan_h2', accountId: 'acct_unknown', instrumentId: 'CASH_CNY',
      valuationMode: 'quantity', quantity: 5000, costBasis: 5000,
    })
    const r2 = rebuildHoldingsFromTransactions({ ...portfolio, holdings: [realOrphan] })
    expect(r2.orphans).toHaveLength(1)
    expect(r2.orphans[0].holdingId).toBe('orphan_h2')
    expect(r2.orphans[0].quantity).toBe(5000)
    // 仍在结果里，且被标记
    const kept = r2.holdings.find((h) => h.id === 'orphan_h2')!
    expect(kept.orphan).toBe(true)
    expect(kept.quantity).toBe(5000)
  })

  it('孤立持仓在 reconcile 中被明确报告', () => {
    const p = skeleton()
    const orphan = makeHolding({
      id: 'orphan_h', accountId: A, instrumentId: 'CASH_CNY',
      valuationMode: 'quantity', quantity: 5000, costBasis: 5000, orphan: true,
    })
    const report = reconcileHoldings({ ...p, holdings: [orphan], transactions: [] })
    const issue = report.issues.find((i) => i.kind === 'holding_without_ledger')!
    expect(issue.detail).toContain('孤立持仓')
  })

  it('adoptOrphanHolding 生成 adjustment（留痕而非直接改 Holding）', () => {
    const p = skeleton()
    const orphan = makeHolding({
      id: 'orphan_h', accountId: A, instrumentId: 'CASH_CNY',
      valuationMode: 'quantity', quantity: 5000, costBasis: 5000, orphan: true,
    })
    const portfolio = { ...p, holdings: [orphan], transactions: [] }
    const { transaction, reason } = adoptOrphanHolding(portfolio, 'orphan_h')

    expect(reason).toBeUndefined()
    expect(transaction?.type).toBe('adjustment')
    expect(transaction?.quantity).toBe(5000)
    expect(transaction?.amount).toBe(5000)
    expect(transaction?.note).toContain('补记期初余额')

    // 纳入后再重建即不再孤立
    const fixed = { ...portfolio, transactions: [transaction!] }
    const r = rebuildHoldingsFromTransactions(fixed)
    expect(r.orphans).toHaveLength(0)
    expect(reconcileHoldings({ ...fixed, holdings: r.holdings }).ok).toBe(true)
  })

  it('adoptOrphanHolding 对已有依据的持仓拒绝重复补期初', () => {
    const portfolio = richPortfolio()
    const rebuilt = { ...portfolio, holdings: rebuildHoldingsFromTransactions(portfolio).holdings }
    const target = rebuilt.holdings[0]
    const { transaction, reason } = adoptOrphanHolding(rebuilt, target.id)
    expect(transaction).toBeNull()
    expect(reason).toContain('已有交易依据')
  })
})

/* ================================================================== *
 * 8. 账本级不变量
 * ================================================================== */

describe('账本级不变量', () => {
  it('同一交易在同一持仓上最多产生一条效果', () => {
    const p = skeleton()
    const report = deriveLedger(
      [
        tx({ id: 'a', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 1000, amount: 1000, currency: 'USD' }),
        tx({ id: 'b', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', quantity: 1, amount: 100, currency: 'USD' }),
      ],
      { instrumentCurrency: currencyOf(p) },
    )
    expect(checkLedgerInvariants(report).ok).toBe(true)
  })

  it('现金腿与投资标的重合时被拒绝', () => {
    const p = skeleton()
    const report = deriveLedger(
      [tx({ id: 'x', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'SPYM', quantity: 1, amount: 100, currency: 'USD' })],
      { instrumentCurrency: currencyOf(p) },
    )
    expect(report.issues.some((i) => i.reason === 'cash_leg_same_as_instrument')).toBe(true)
  })

  it('adjustment 之前的累计量被清零（期初之前的收入不可归属）', () => {
    const p = skeleton()
    const report = deriveLedger(
      [
        tx({ id: 'i1', type: 'interest', accountId: A, instrumentId: 'CASH_USD', amount: 50, currency: 'USD', timestamp: '2026-01-01T00:00:00.000Z' }),
        tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 1000, amount: 1000, currency: 'USD', timestamp: '2026-02-01T00:00:00.000Z' }),
      ],
      { instrumentCurrency: currencyOf(p) },
    )
    const pos = getPosition(report, A, 'CASH_USD')!
    expect(pos.quantity).toBe(1000) // 期初设定的数量
    expect(pos.income).toBe(0) // 期初之前的收入被清零
  })

  it('adjustment 之后的收入正常累计', () => {
    const p = skeleton()
    const report = deriveLedger(
      [
        tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 1000, amount: 1000, currency: 'USD', timestamp: '2026-01-01T00:00:00.000Z' }),
        tx({ id: 'i1', type: 'interest', accountId: A, instrumentId: 'CASH_USD', amount: 50, currency: 'USD', timestamp: '2026-02-01T00:00:00.000Z' }),
      ],
      { instrumentCurrency: currencyOf(p) },
    )
    expect(getPosition(report, A, 'CASH_USD')!.income).toBe(50)
  })

  it('deriveLedgerEffects 是纯函数：不修改输入数组', () => {
    const p = skeleton()
    const txs = [tx({ id: 'a', type: 'adjustment', accountId: A, instrumentId: 'CASH_CNY', quantity: 100, amount: 100 })]
    const snapshot = JSON.stringify(txs)
    deriveLedgerEffects(txs, { instrumentCurrency: currencyOf(p) })
    expect(JSON.stringify(txs)).toBe(snapshot)
  })

  it('效果推导与应用分离：可以只测效果', () => {
    const p = skeleton()
    const { effects } = deriveLedgerEffects(
      [tx({ id: 'b', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', quantity: 2, amount: 200, fee: 1, currency: 'USD' })],
      { instrumentCurrency: currencyOf(p) },
    )
    const instrumentLeg = effects.find((e) => e.leg === 'instrument')!
    const cashLeg = effects.find((e) => e.leg === 'cash')!
    expect(instrumentLeg.quantityDelta).toBe(2)
    expect(instrumentLeg.costDelta).toBe(201)
    expect(cashLeg.quantityDelta).toBe(-201)
    // 不变量：投资腿成本增 + 现金腿数量减 = 0
    expect(instrumentLeg.costDelta + cashLeg.quantityDelta).toBe(0)
  })

  it('【核心】全账本：买入前后总成本守恒（无费用）', () => {
    const p = skeleton()
    const before = deriveLedger(
      [tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 10000, amount: 10000, currency: 'USD' })],
      { instrumentCurrency: currencyOf(p) },
    )
    const after = deriveLedger(
      [
        tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 10000, amount: 10000, currency: 'USD' }),
        tx({ id: 'b', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', quantity: 5, amount: 500, currency: 'USD' }),
      ],
      { instrumentCurrency: currencyOf(p) },
    )
    const total = (r: ReturnType<typeof deriveLedger>) =>
      [...r.positions.values()].reduce((s, x) => s + x.costBasis, 0)
    expect(total(after)).toBeCloseTo(total(before), 6)
  })
})

/* ================================================================== *
 * 9. 迁移期初 adjustment 参与重建
 * ================================================================== */

describe('迁移 adjustment 参与重建', () => {
  it('迁移生成的期初 adjustment 能让重建完全还原持仓', () => {
    resetIds()
    const p = skeleton()
    // 模拟迁移：现金与证券各一条期初
    const txs = [
      tx({ id: 'm1', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 24680, amount: 24680, currency: 'USD', note: '迁移期初余额（非历史买入记录）' }),
      tx({ id: 'm2', type: 'adjustment', accountId: A, instrumentId: 'SPYM', quantity: 100, amount: 6000, currency: 'USD', note: '迁移期初余额（非历史买入记录）' }),
    ]
    const portfolio = { ...p, transactions: txs }
    const r = rebuildHoldingsFromTransactions(portfolio)

    expect(r.orphans).toHaveLength(0)
    expect(getPosition(deriveLedger(txs, { instrumentCurrency: currencyOf(p) }), A, 'CASH_USD')!.quantity).toBe(24680)
    expect(reconcileHoldings({ ...portfolio, holdings: r.holdings }).ok).toBe(true)
  })

  it('期初 adjustment 的数量与成本被原样承接（不做任何推断）', () => {
    const p = skeleton()
    const report = deriveLedger(
      [tx({ id: 'a', type: 'adjustment', accountId: A, instrumentId: 'SPYM', quantity: 37, amount: 1234.56, currency: 'USD' })],
      { instrumentCurrency: currencyOf(p) },
    )
    const pos = getPosition(report, A, 'SPYM')!
    expect(pos.quantity).toBe(37)
    expect(pos.costBasis).toBeCloseTo(1234.56, 6)
    expect(pos.averageCost).toBeCloseTo(1234.56 / 37, 6)
  })
})

/* ================================================================== *
 * 10. 迁移：已确认现金的 manual → quantity 转换
 * ================================================================== */

describe('迁移现金转换：只转已确认 cash，幂等且金额守恒', async () => {
  const { convertConfirmedCashHoldings, applyCashConversion, countPendingCashConfirmation } = await import('./cashConversion')

  function withCash(instrumentPatch: Record<string, unknown>, manualValue = 20000) {
    const p = skeleton()
    const inst = {
      ...p.instruments.find((i) => i.id === 'CASH_CNY')!,
      ...instrumentPatch,
    } as (typeof p.instruments)[number]
    return {
      ...p,
      instruments: p.instruments.map((i) => (i.id === 'CASH_CNY' ? inst : i)),
      holdings: [
        makeHolding({
          id: 'h_cash', accountId: A, instrumentId: 'CASH_CNY',
          valuationMode: 'manual', manualValue, manualValueAt: '2026-10-03T00:00:00.000Z',
        }),
      ],
    }
  }

  it('【不猜】未确认分类的现金保持不变', () => {
    const portfolio = withCash({ instrumentType: 'cash', classificationStatus: 'unconfirmed' })
    const r = convertConfirmedCashHoldings(portfolio)
    expect(r.convertedCount).toBe(0)
    expect(r.holdings[0].valuationMode).toBe('manual')
    expect(r.holdings[0].manualValue).toBe(20000)
    expect(r.actions[0].skippedReason).toContain('未确认是现金')
    expect(countPendingCashConfirmation(portfolio)).toBe(1)
  })

  it('已确认 cash → 转为 quantity，并补一条期初 adjustment', () => {
    const portfolio = withCash({ instrumentType: 'cash', classificationStatus: 'confirmed' })
    const { portfolio: converted, result } = applyCashConversion(portfolio, { timestamp: '2026-10-04T00:00:00.000Z' })

    expect(result.convertedCount).toBe(1)
    const h = converted.holdings[0]
    expect(h.valuationMode).toBe('quantity')
    expect(h.quantity).toBe(20000)
    expect(h.costBasis).toBe(20000)
    expect(h.averageCost).toBe(1)
    // manualValue 保留作审计线索
    expect(h.manualValue).toBe(20000)

    expect(result.adjustments).toHaveLength(1)
    expect(result.adjustments[0].type).toBe('adjustment')
    expect(result.adjustments[0].quantity).toBe(20000)
    expect(result.adjustments[0].amount).toBe(20000)
    expect(converted.transactions).toHaveLength(1)
  })

  it('【幂等】已有期初交易时不再重复补', () => {
    const portfolio = withCash({ instrumentType: 'cash', classificationStatus: 'confirmed' })
    const first = applyCashConversion(portfolio, { timestamp: '2026-10-04T00:00:00.000Z' })
    const second = applyCashConversion(first.portfolio, { timestamp: '2026-10-05T00:00:00.000Z' })

    expect(second.result.adjustments).toHaveLength(0) // 不再新增
    expect(second.portfolio.transactions).toHaveLength(1) // 仍只有一条
    expect(second.result.holdings[0].quantity).toBe(20000) // 金额不变
  })

  it('【金额守恒】转换前后原币金额一致', () => {
    for (const value of [0, 1, 12345.67, 500000.55, 98765.43]) {
      const portfolio = withCash({ instrumentType: 'cash', classificationStatus: 'confirmed' }, value)
      const r = convertConfirmedCashHoldings(portfolio)
      expect(r.amountPreserved).toBe(true)
      expect(r.holdings[0].quantity).toBeCloseTo(value, 2)
    }
  })

  it('房产 / 应收（非现金类别）保持不变', () => {
    const p = skeleton()
    const houseInst = makeInstrument({ id: 'HOUSE', name: '示例房产', instrumentType: 'real_estate', assetClass: 'real_estate', currency: 'CNY', classificationStatus: 'confirmed' })
    const portfolio = {
      ...p,
      instruments: [...p.instruments, houseInst],
      holdings: [makeHolding({ id: 'h_house', accountId: A, instrumentId: 'HOUSE', valuationMode: 'manual', manualValue: 2000000 })],
    }
    const r = convertConfirmedCashHoldings(portfolio)
    expect(r.convertedCount).toBe(0)
    expect(r.holdings[0].valuationMode).toBe('manual')
    expect(r.holdings[0].manualValue).toBe(2000000)
  })

  it('用户已把类别确认为 cash 时，即使 instrumentType 是 fund 也会转换', () => {
    // 依据：用户确认的分类才是权威信号；instrumentType 在迁移数据里可能只是 'other'/'fund'
    const portfolio = withCash({ instrumentType: 'fund', assetClass: 'cash', classificationStatus: 'confirmed' })
    const r = convertConfirmedCashHoldings(portfolio)
    expect(r.convertedCount).toBe(1)
    expect(r.holdings[0].valuationMode).toBe('quantity')
  })

  it('fund 类型且类别不是现金时不转换', () => {
    const portfolio = withCash({ instrumentType: 'fund', assetClass: 'equity', classificationStatus: 'confirmed' })
    const r = convertConfirmedCashHoldings(portfolio)
    expect(r.convertedCount).toBe(0)
    expect(r.actions[0].skippedReason).toBeTruthy()
  })

  it('【迁移真实情形】instrumentType=other + 用户确认 cash → 可以转换', () => {
    // 迁移后旧现金的 instrumentType 是 'other'，只有 assetClass 能表达「这是现金」
    const portfolio = withCash({ instrumentType: 'other', assetClass: 'cash', classificationStatus: 'confirmed' })
    const r = convertConfirmedCashHoldings(portfolio)
    expect(r.convertedCount).toBe(1)
    expect(r.holdings[0].quantity).toBe(20000)
  })

  it('转换失败不得删除原 Holding（标的不存在时保留）', () => {
    const p = skeleton()
    const portfolio = {
      ...p,
      instruments: [], // 标的全部缺失
      holdings: [makeHolding({ id: 'h1', accountId: A, instrumentId: 'GONE', valuationMode: 'manual', manualValue: 5000 })],
    }
    const r = convertConfirmedCashHoldings(portfolio)
    expect(r.holdings).toHaveLength(1)
    expect(r.holdings[0].manualValue).toBe(5000)
    expect(r.actions[0].skippedReason).toContain('标的缺失')
  })

  it('dryRun 只计算不改动', () => {
    const portfolio = withCash({ instrumentType: 'cash', classificationStatus: 'confirmed' })
    const r = convertConfirmedCashHoldings(portfolio, { dryRun: true })
    expect(r.convertedCount).toBe(1) // 会转换
    expect(r.holdings[0].valuationMode).toBe('manual') // 但没改
    expect(r.adjustments).toHaveLength(0)
  })

  it('多币种现金分别转换，各自保留原币金额', () => {
    const p = skeleton()
    const portfolio = {
      ...p,
      instruments: p.instruments.map((i) =>
        i.instrumentType === 'cash' ? { ...i, classificationStatus: 'confirmed' as const } : i,
      ),
      holdings: [
        makeHolding({ id: 'c1', accountId: A, instrumentId: 'CASH_CNY', valuationMode: 'manual', manualValue: 10000 }),
        makeHolding({ id: 'c2', accountId: A, instrumentId: 'CASH_USD', valuationMode: 'manual', manualValue: 1000 }),
        makeHolding({ id: 'c3', accountId: A, instrumentId: 'CASH_HKD', valuationMode: 'manual', manualValue: 50000 }),
      ],
    }
    const { portfolio: converted, result } = applyCashConversion(portfolio)
    expect(result.convertedCount).toBe(3)
    expect(result.amountPreserved).toBe(true)
    expect(converted.holdings.find((h) => h.id === 'c1')!.quantity).toBe(10000)
    expect(converted.holdings.find((h) => h.id === 'c2')!.quantity).toBe(1000)
    expect(converted.holdings.find((h) => h.id === 'c3')!.quantity).toBe(50000)
    // 每种币种一条期初交易
    expect(converted.transactions).toHaveLength(3)
  })

  it('转换后重建与对账均一致（与 Phase 5 主链打通）', () => {
    const portfolio = withCash({ instrumentType: 'cash', classificationStatus: 'confirmed' })
    const { portfolio: converted } = applyCashConversion(portfolio, { timestamp: '2026-10-04T00:00:00.000Z' })
    const rebuilt = { ...converted, holdings: rebuildHoldingsFromTransactions(converted).holdings }
    expect(reconcileHoldings(rebuilt).ok).toBe(true)
    expect(rebuilt.holdings.find((h) => h.id === 'h_cash')!.quantity).toBe(20000)
  })
})

/* ================================================================== *
 * 11. 换汇校验与 effectiveRate（Phase 5 收尾确认项）
 * ================================================================== */

describe('换汇校验：金额、币种、已确认现金、标的不同', async () => {
  const { validateExchange } = await import('./exchange')

  /** 两个已确认的现金标的 + 一个未确认的 */
  function cashPortfolio() {
    const p = skeleton()
    return {
      ...p,
      instruments: p.instruments.map((i) =>
        i.id === 'CASH_USD' || i.id === 'CASH_CNY' || i.id === 'CASH_HKD'
          ? { ...i, instrumentType: 'cash' as const, classificationStatus: 'confirmed' as const }
          : i, // SPYM 仍是 etf
      ),
    }
  }

  const fx = (patch: Partial<Transaction> = {}): Transaction => ({
    id: 'fx1', accountId: A, type: 'exchange',
    cashInstrumentId: 'CASH_USD', toCashInstrumentId: 'CASH_CNY',
    amount: 1000, toAmount: 7200, currency: 'USD', toCurrency: 'CNY',
    timestamp: '2026-10-03T10:00:00.000Z',
    ...patch,
  })

  it('合法换汇通过校验，并给出有效汇率', () => {
    const v = validateExchange(fx(), cashPortfolio())
    expect(v.ok).toBe(true)
    expect(v.effectiveRate?.rate).toBeCloseTo(7.2, 8)
    expect(v.effectiveRate?.inverseRate).toBeCloseTo(1 / 7.2, 8)
  })

  it('amount 必须大于 0', () => {
    for (const amount of [0, -100]) {
      const v = validateExchange(fx({ amount }), cashPortfolio())
      expect(v.ok).toBe(false)
      expect(v.issues.map((i) => i.code)).toContain('amount_not_positive')
    }
  })

  it('toAmount 必须大于 0', () => {
    for (const toAmount of [0, -7200]) {
      const v = validateExchange(fx({ toAmount }), cashPortfolio())
      expect(v.ok).toBe(false)
      expect(v.issues.map((i) => i.code)).toContain('to_amount_not_positive')
    }
  })

  it('换出与换入币种必须不同', () => {
    const v = validateExchange(
      fx({ toCashInstrumentId: 'CASH_USD', toCurrency: 'USD' }), // 同 USD
      cashPortfolio(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.code)).toContain('same_currency')
  })

  it('换出与换入标的不能相同', () => {
    const v = validateExchange(
      fx({ toCashInstrumentId: 'CASH_USD', toCurrency: 'USD' }),
      cashPortfolio(),
    )
    const codes = v.issues.map((i) => i.code)
    expect(codes).toContain('same_instrument')
    expect(codes).toContain('same_currency')
  })

  it('【关键】换出标的必须是已确认的现金', () => {
    const p = cashPortfolio()
    // 把 USD 现金改成未确认
    const unconfirmed = { ...p, instruments: p.instruments.map((i) => (i.id === 'CASH_USD' ? { ...i, classificationStatus: 'unconfirmed' as const } : i)) }
    const v = validateExchange(fx(), unconfirmed)
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.code)).toContain('source_not_confirmed_cash')
  })

  it('【关键】换入标的必须是已确认的现金', () => {
    const p = cashPortfolio()
    const unconfirmed = { ...p, instruments: p.instruments.map((i) => (i.id === 'CASH_CNY' ? { ...i, classificationStatus: 'unconfirmed' as const } : i)) }
    const v = validateExchange(fx(), unconfirmed)
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.code)).toContain('target_not_confirmed_cash')
  })

  it('【关键】股票标的不能作为换汇的现金腿', () => {
    const v = validateExchange(fx({ toCashInstrumentId: 'SPYM', toCurrency: 'CNY' }), cashPortfolio())
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.code)).toContain('target_not_confirmed_cash')
  })

  it('标的不能在组合中缺失', () => {
    const v = validateExchange(fx({ cashInstrumentId: 'GONE' }), cashPortfolio())
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.code)).toContain('source_instrument_missing_in_portfolio')
  })

  it('交易币种必须与换出标的币种一致', () => {
    const v = validateExchange(fx({ currency: 'HKD' }), cashPortfolio())
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.code)).toContain('currency_mismatch_with_instrument')
  })

  it('deriveLedger 层同样会拦住未确认现金的换汇', () => {
    const p = cashPortfolio()
    const unconfirmed = { ...p, instruments: p.instruments.map((i) => (i.id === 'CASH_USD' ? { ...i, classificationStatus: 'unconfirmed' as const } : i)) }
    const report = deriveLedger([fx()], {
      instrumentCurrency: currencyOf(unconfirmed),
      isConfirmedCash: (id) => {
        const inst = unconfirmed.instruments.find((i) => i.id === id)
        return !!inst && inst.instrumentType === 'cash' && inst.classificationStatus === 'confirmed'
      },
    })
    expect(report.issues.some((i) => i.reason === 'exchange_not_confirmed_cash')).toBe(true)
    // 被拒绝的换汇不产生任何持仓变化
    expect(report.positions.size).toBe(0)
  })

  it('deriveLedger 层拒绝非正金额', () => {
    const p = cashPortfolio()
    const report = deriveLedger([fx({ amount: -100 })], {
      instrumentCurrency: currencyOf(p),
      isConfirmedCash: () => true,
    })
    expect(report.issues.some((i) => i.reason === 'exchange_non_positive_amount')).toBe(true)
  })
})

describe('effectiveRate：仅展示与审计，绝不参与估值', async () => {
  const { computeEffectiveRate, describeEffectiveRate, buildExchangeAudit, exchangeTotalsByInstrument } =
    await import('./exchange')

  const txFx: Transaction = {
    id: 'fx1', accountId: 'a', type: 'exchange',
    cashInstrumentId: 'CASH_USD', toCashInstrumentId: 'CASH_CNY',
    amount: 1000, toAmount: 7200, currency: 'USD', toCurrency: 'CNY',
    timestamp: '2026-10-03T10:00:00.000Z',
  }

  it('effectiveRate = toAmount / amount', () => {
    expect(computeEffectiveRate(txFx).rate).toBeCloseTo(7.2, 8)
  })

  it('金额非法时 rate 为 undefined（不填 0）', () => {
    expect(computeEffectiveRate({ ...txFx, amount: 0 }).rate).toBeUndefined()
    expect(computeEffectiveRate({ ...txFx, toAmount: 0 }).rate).toBeUndefined()
    expect(computeEffectiveRate({ ...txFx, toAmount: -1 }).rate).toBeUndefined()
  })

  it('展示文案在不可计算时明确说明', () => {
    expect(describeEffectiveRate(txFx)).toContain('7.2')
    expect(describeEffectiveRate({ ...txFx, amount: 0 })).toContain('不可计算')
  })

  it('【关键】effectiveRate 不会被写入 FxRate 表', () => {
    const p = skeleton()
    const before = JSON.stringify(p.fxRates)
    const withFx = { ...p, transactions: [txFx] }
    computeEffectiveRate(txFx)
    buildExchangeAudit(withFx)
    // 组合的 fxRates 完全没变
    expect(JSON.stringify(withFx.fxRates)).toBe(before)
    expect(withFx.fxRates).toHaveLength(0)
  })

  it('审计摘要按时间排序并保留成交汇率', () => {
    const p = { ...skeleton(), transactions: [txFx, { ...txFx, id: 'fx2', timestamp: '2026-11-01T00:00:00.000Z', toAmount: 7100 }] }
    const audit = buildExchangeAudit(p)
    expect(audit).toHaveLength(2)
    expect(audit[0].transactionId).toBe('fx1')
    expect(audit[0].rate).toBeCloseTo(7.2, 8)
    expect(audit[1].rate).toBeCloseTo(7.1, 8)
  })

  it('换入换出合计可用于核账', () => {
    const p = { ...skeleton(), transactions: [txFx] }
    const totals = exchangeTotalsByInstrument(p)
    expect(totals.get('CASH_USD')!.out).toBe(1000)
    expect(totals.get('CASH_CNY')!.in).toBe(7200)
    expect(totals.get('CASH_USD')!.net).toBe(-1000)
  })
})

describe('transactionCount：语义固定为交易笔数（按 transactionId 去重）', () => {
  it('一笔 buy 同时产生投资腿与现金腿，但每个持仓只计 1 笔', () => {
    const p = skeleton()
    const report = deriveLedger(
      [
        tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 10000, amount: 10000, currency: 'USD', timestamp: '2026-10-01T00:00:00.000Z' }),
        tx({ id: 'buy1', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', quantity: 13, amount: 1000, fee: 5, currency: 'USD', timestamp: '2026-10-02T00:00:00.000Z' }),
      ],
      { instrumentCurrency: currencyOf(p) },
    )
    expect(getPosition(report, A, 'SPYM')!.transactionCount).toBe(1)
    // 现金：1 笔期初 + 1 笔买入 = 2
    expect(getPosition(report, A, 'CASH_USD')!.transactionCount).toBe(2)
    // 效果条数确实是 2（投资腿 + 现金腿），不受 transactionCount 影响
    expect(effectsOfTransaction(report, 'buy1')).toHaveLength(2)
  })

  it('dividend 同时产生投资腿与现金腿：各持仓各计 1 笔', () => {
    const report = deriveLedger(
      [
        tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'SPYM', quantity: 100, amount: 1000, timestamp: '2026-10-01T00:00:00.000Z' }),
        tx({ id: 'dv', type: 'dividend', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', amount: 50, currency: 'CNY', timestamp: '2026-10-02T00:00:00.000Z' }),
      ],
      { instrumentCurrency: () => 'CNY' },
    )
    expect(getPosition(report, A, 'SPYM')!.transactionCount).toBe(2) // 期初 + 分红
    expect(report.entries.filter((e) => e.transactionId === 'dv')).toHaveLength(2)
  })

  it('一笔 transfer 对源与目标各计 1 笔（不重复计）', () => {
    const p = skeleton()
    const report = deriveLedger(
      [
        tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'SPYM', quantity: 100, amount: 6000, currency: 'USD', timestamp: '2026-10-01T00:00:00.000Z' }),
        tx({ id: 'tr', type: 'transfer', accountId: A, toAccountId: B, instrumentId: 'SPYM', quantity: 100, amount: 6000, currency: 'USD', transferQuantity: 30, timestamp: '2026-10-02T00:00:00.000Z' }),
      ],
      { instrumentCurrency: currencyOf(p) },
    )
    expect(getPosition(report, A, 'SPYM')!.transactionCount).toBe(2) // 期初 + 划转
    expect(getPosition(report, B, 'SPYM')!.transactionCount).toBe(1) // 仅划转
  })

  it('effectCount 与 transactionCount 是两个独立概念', () => {
    const report = deriveLedger(
      [
        tx({ id: 'adj', type: 'adjustment', accountId: A, instrumentId: 'CASH_USD', quantity: 10000, amount: 10000, currency: 'USD', timestamp: '2026-10-01T00:00:00.000Z' }),
        tx({ id: 'b1', type: 'buy', accountId: A, instrumentId: 'SPYM', cashInstrumentId: 'CASH_USD', quantity: 10, amount: 500, currency: 'USD', timestamp: '2026-10-02T00:00:00.000Z' }),
      ],
      { instrumentCurrency: () => 'USD' },
    )
    const spym = getPosition(report, A, 'SPYM')!
    const effectCount = report.entries.filter((e) => e.key === 'acct_a::SPYM').length
    expect(spym.transactionCount).toBe(1)
    expect(effectCount).toBe(1) // SPYM 只有投资腿
    const cash = getPosition(report, A, 'CASH_USD')!
    const cashEffects = report.entries.filter((e) => e.key === 'acct_a::CASH_USD').length
    expect(cash.transactionCount).toBe(2)
    expect(cashEffects).toBe(2)
  })
})
