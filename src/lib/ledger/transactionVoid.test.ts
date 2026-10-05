import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Portfolio2, Transaction } from '../../types/portfolio2'
import { createInMemoryRepository, createPairedTestStore } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import {
  recordTransaction,
  voidTransaction,
  transactionCounts,
  transactionStatusOf,
  type RecordTransactionInput,
} from './transactionService'
import { activeTransactions, isVoided, transactionStatus } from './lifecycle'
import { deriveLedger } from './derive'
import { rebuildHoldingsFromTransactions } from './rebuild'
import { reconcileHoldings } from './reconcile'
import { detectDuplicateHoldings } from './duplicates'
import { classifyPortfolioFlows } from '../performance/cashflow'
import { buildSnapshot, captureSnapshot, localDate, previousDate } from '../performance/snapshot'
import { ensureDailySnapshot } from '../performance/dailySnapshot'
import { calculateTotals } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { migrateV5ToV6 } from '../db/migrations/schema-v5-to-v6'
import { resetReadOnlyMode } from '../readOnly'
import { makeAccount, makeInstrument, makePortfolio, nowForLocalDate } from '../valuation/__fixtures__/builders'

/*
 * Phase 8 / W5 — 交易作废（Void）测试
 *
 * 覆盖用户列出的 14 项，重点验证作废前后：
 * Holdings / cash / costBasis / realizedPnl / income / externalFlow 保持一致
 */

const T0 = '2026-10-01T10:00:00.000Z'
const NOW = () => new Date('2026-10-04T10:00:00.000Z')

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function basePortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [
      makeAccount({ id: 'a_cny', name: '示例人民币账户', currency: 'CNY', region: 'CN', type: 'bank' }),
      makeAccount({ id: 'a_hkd', name: '示例港币账户', currency: 'HKD', region: 'HK', type: 'bank' }),
    ],
    instruments: [
      makeInstrument({ id: 'i_cny', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_hkd', name: '港币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'HKD', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_stock', name: '示例股票', symbol: 'TEST', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
    ],
    holdings: [],
    transactions: [
      { id: 'seed_cny', accountId: 'a_cny', instrumentId: 'i_cny', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: T0 },
      { id: 'seed_hkd', accountId: 'a_hkd', instrumentId: 'i_hkd', type: 'adjustment', quantity: 50000, amount: 50000, currency: 'HKD', timestamp: T0 },
    ],
    quotes: [
      { id: 'q_stock', instrumentId: 'i_stock', priceKind: 'market_price', marketPrice: 10, currency: 'CNY', source: 'test', timestamp: NOW().toISOString(), status: 'LIVE' },
    ],
    fxRates: [
      { id: 'fx_hkd', baseCurrency: 'HKD', quoteCurrency: 'CNY', rate: 0.92, timestamp: NOW().toISOString(), source: 'test', status: 'LIVE' },
    ],
  })
}

async function seedRepo(): Promise<PortfolioRepository> {
  const repo = createInMemoryRepository()
  const p = basePortfolio()
  await repo.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })
  return repo
}

const ledgerOf = (portfolio: Portfolio2) =>
  deriveLedger(portfolio.transactions, {
    instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
  })

const input = (o: Partial<RecordTransactionInput>): RecordTransactionInput => ({
  type: 'deposit',
  accountId: 'a_cny',
  cashInstrumentId: 'i_cny',
  amount: 1000,
  currency: 'CNY',
  timestamp: '2026-10-02T10:00:00.000Z',
  ...o,
})

/**
 * 外部现金流必须用**已过滤**的有效交易数组来算。
 *
 * `classifyPortfolioFlows(txs)` 是「给你什么就分类什么」的纯函数 ——
 * 它**不自己过滤**已作废交易（过滤发生在 Ledger 入口与 captureSnapshot）。
 * 因此测试里要显式传 `activeTransactions(...)`。
 */
const flowOfActive = (portfolio: Portfolio2) =>
  classifyPortfolioFlows(portfolio, activeTransactions(portfolio.transactions), (a) => a)

/** 只把某一笔交易送进现金流分类（用于断言单笔的影响） */
const flowOfOne = (portfolio: Portfolio2, txId: string) => {
  const tx = portfolio.transactions.find((t) => t.id === txId)!
  return classifyPortfolioFlows(portfolio, activeTransactions([tx]), (a) => a)
}

/** 录一笔并返回其 id */
async function record(repo: PortfolioRepository, o: Partial<RecordTransactionInput>): Promise<string> {
  const r = await recordTransaction(repo, input(o), { now: NOW })
  if (!r.ok) throw new Error(`录入失败：${r.message}`)
  return r.transaction.id
}

beforeEach(() => resetReadOnlyMode())
afterEach(() => resetReadOnlyMode())

/* ================================================================== *
 * 1) POSTED 正常进入 Ledger
 * ================================================================== */

describe('1 POSTED：正常交易仍进入 Ledger', () => {
  it('无 status 的交易按 POSTED 处理并参与计算', async () => {
    const repo = await seedRepo()
    const portfolio = await repo.loadPortfolio()
    // 老数据（seed）没有 status
    expect(portfolio.transactions.every((t) => t.status === undefined)).toBe(true)
    // 但全部按 POSTED 参与计算
    expect(transactionStatus(portfolio.transactions[0])).toBe('POSTED')
    expect(isVoided(portfolio.transactions[0])).toBe(false)
    expect(activeTransactions(portfolio.transactions)).toHaveLength(2)

    const ledger = ledgerOf(portfolio)
    expect(ledger.positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
  })
})

/* ================================================================== *
 * 2) VOIDED 不进入 Ledger
 * ================================================================== */

describe('2 VOIDED：作废后不再进入 Ledger', () => {
  it('作废后该交易从 Ledger 效果中消失', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'deposit', amount: 5000 })

    const before = await repo.loadPortfolio()
    expect(ledgerOf(before).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(105000, 6)

    const r = await voidTransaction(repo, id, { reason: '录错了', now: NOW })
    expect(r.ok).toBe(true)

    const after = await repo.loadPortfolio()
    expect(ledgerOf(after).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
    // 记录保留（不是删除）
    expect(after.transactions).toHaveLength(before.transactions.length)
    expect(after.transactions.find((t) => t.id === id)!.status).toBe('VOIDED')
  })

  it('作废后不再产生任何 Ledger Effect', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'deposit', amount: 5000 })
    await voidTransaction(repo, id, { now: NOW })

    const portfolio = await repo.loadPortfolio()
    const ledger = ledgerOf(portfolio)
    expect(ledger.entries.filter((e) => e.transactionId === id)).toHaveLength(0)
  })
})

/* ================================================================== *
 * 3) BUY 作废
 * ================================================================== */

describe('3 BUY 作废：持仓与现金完全恢复', () => {
  it('BUY 100 @ 10 作废后 quantity = 0、cash 恢复', async () => {
    const repo = await seedRepo()
    const id = await record(repo, {
      type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny',
      quantity: 100, amount: 1000,
    })

    const before = await repo.loadPortfolio()
    expect(ledgerOf(before).positions.get('a_cny::i_stock')!.quantity).toBe(100)
    expect(ledgerOf(before).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(99000, 6)

    await voidTransaction(repo, id, { now: NOW })

    const after = await repo.loadPortfolio()
    const pos = ledgerOf(after).positions.get('a_cny::i_stock')
    // 持仓数量归 0（或该键不再存在）
    expect(pos?.quantity ?? 0).toBe(0)
    expect(ledgerOf(after).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
    // 持仓缓存中的该标的数量为 0
    const h = after.holdings.find((x) => x.instrumentId === 'i_stock')
    expect(h?.quantity ?? 0).toBe(0)
  })
})

/* ================================================================== *
 * 4) SELL 作废
 * ================================================================== */

describe('4 SELL 作废：quantity / costBasis / realizedPnl 全部恢复', () => {
  it('卖出作废后回到未卖出状态', async () => {
    const repo = await seedRepo()
    await record(repo, { type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny', quantity: 100, amount: 1000 })
    const sellId = await record(repo, {
      type: 'sell', instrumentId: 'i_stock', cashInstrumentId: 'i_cny', quantity: 40, amount: 600,
    })

    const before = await repo.loadPortfolio()
    const posBefore = ledgerOf(before).positions.get('a_cny::i_stock')!
    expect(posBefore.quantity).toBe(60)
    expect(posBefore.realizedPnl).toBeCloseTo(200, 6)
    expect(posBefore.costBasis).toBeCloseTo(600, 6)

    await voidTransaction(repo, sellId, { now: NOW })

    const after = await repo.loadPortfolio()
    const posAfter = ledgerOf(after).positions.get('a_cny::i_stock')!
    // 【核心】数量 / 成本 / 已实现盈亏全部恢复
    expect(posAfter.quantity).toBe(100)
    expect(posAfter.costBasis).toBeCloseTo(1000, 6)
    expect(posAfter.realizedPnl).toBeCloseTo(0, 6)
    // 现金恢复到买入后的状态
    expect(ledgerOf(after).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(99000, 6)
  })
})

/* ================================================================== *
 * 5) DEPOSIT / 6) WITHDRAW 作废
 * ================================================================== */

describe('5/6 DEPOSIT / WITHDRAW 作废：外部现金流被移除', () => {
  it('存入作废后 externalInflow 归零', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'deposit', amount: 5000 })
    const before = await repo.loadPortfolio()
    expect(flowOfOne(before, id).externalInflow).toBe(5000)
    expect(flowOfActive(before).externalInflow).toBe(5000)

    await voidTransaction(repo, id, { now: NOW })

    const after = await repo.loadPortfolio()
    // 【核心】作废后不再计入外部流入（有效交易集合里已无该笔）
    expect(flowOfOne(after, id).externalInflow).toBe(0)
    expect(flowOfActive(after).externalInflow).toBe(0)
    // 记录保留，只是不再参与
    expect(after.transactions.find((t) => t.id === id)!.status).toBe('VOIDED')
  })

  it('取出作废后 externalOutflow 归零', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'withdraw', amount: 3000 })
    await voidTransaction(repo, id, { now: NOW })

    const after = await repo.loadPortfolio()
    expect(flowOfActive(after).externalOutflow).toBe(0)
    expect(flowOfOne(after, id).externalOutflow).toBe(0)
  })
})

/* ================================================================== *
 * 7) DIVIDEND / INTEREST 作废
 * ================================================================== */

describe('7 DIVIDEND / INTEREST 作废：income 不再计算，成本不变', () => {
  it('分红作废后 income 归零、costBasis 不变', async () => {
    const repo = await seedRepo()
    await record(repo, { type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny', quantity: 100, amount: 1000 })
    const divId = await record(repo, { type: 'dividend', instrumentId: 'i_stock', cashInstrumentId: 'i_cny', amount: 50 })

    const before = await repo.loadPortfolio()
    const posBefore = ledgerOf(before).positions.get('a_cny::i_stock')!
    expect(posBefore.income).toBeCloseTo(50, 6)
    const cashBefore = ledgerOf(before).positions.get('a_cny::i_cny')!.quantity

    await voidTransaction(repo, divId, { now: NOW })

    const after = await repo.loadPortfolio()
    const posAfter = ledgerOf(after).positions.get('a_cny::i_stock')!
    expect(posAfter.income).toBeCloseTo(0, 6)
    expect(posAfter.costBasis).toBeCloseTo(1000, 6) // 成本自始至终未被改动
    expect(ledgerOf(after).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(cashBefore - 50, 6)
  })

  it('利息作废后 income 归零', async () => {
    const repo = await seedRepo()
    // 现金利息：标的即现金，不设资金腿
    const id = await record(repo, { type: 'interest', instrumentId: 'i_cny', cashInstrumentId: undefined, amount: 30 })
    expect(ledgerOf(await repo.loadPortfolio()).positions.get('a_cny::i_cny')!.income).toBeCloseTo(30, 6)

    await voidTransaction(repo, id, { now: NOW })
    expect(ledgerOf(await repo.loadPortfolio()).positions.get('a_cny::i_cny')!.income).toBeCloseTo(0, 6)
  })
})

/* ================================================================== *
 * 8) FEE 作废
 * ================================================================== */

describe('8 FEE 作废：费用不再计算，现金恢复', () => {
  it('独立费用作废后 cash 恢复、feeTotal 归零', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'fee', amount: 20 })

    const before = await repo.loadPortfolio()
    expect(ledgerOf(before).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(99980, 6)
    expect(flowOfOne(before, id).feeTotal).toBe(20)

    await voidTransaction(repo, id, { now: NOW })

    const after = await repo.loadPortfolio()
    expect(ledgerOf(after).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
    // 【核心】作废后该交易不再贡献费用，也不重复扣除
    expect(flowOfOne(after, id).feeTotal).toBe(0)
    expect(flowOfActive(after).feeTotal).toBe(0)
  })

  it('买入附带费用随买入一起作废（不残留）', async () => {
    const repo = await seedRepo()
    const id = await record(repo, {
      type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny',
      quantity: 10, amount: 100, fee: 5,
    })
    expect(ledgerOf(await repo.loadPortfolio()).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(99895, 6)

    await voidTransaction(repo, id, { now: NOW })
    expect(ledgerOf(await repo.loadPortfolio()).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
  })
})

/* ================================================================== *
 * 9) TRANSFER 作废
 * ================================================================== */

describe('9 TRANSFER 作废：源与目标都恢复，总资产不变', () => {
  it('划转作废后两侧账户恢复', async () => {
    const repo = await seedRepo()
    const id = await record(repo, {
      // 划转不设资金腿（标的在账户间移动）
      type: 'transfer', accountId: 'a_cny', toAccountId: 'a_hkd',
      instrumentId: 'i_cny', cashInstrumentId: undefined, amount: 20000,
      timestamp: '2026-10-02T10:00:00.000Z',
    })

    const before = await repo.loadPortfolio()
    expect(ledgerOf(before).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(80000, 6)
    expect(ledgerOf(before).positions.get('a_hkd::i_cny')!.quantity).toBeCloseTo(20000, 6)

    const assetsBefore = calculateTotals({
      portfolio: before, fx: createFxTable(before.fxRates), now: NOW().getTime(),
    }).totalAssets

    await voidTransaction(repo, id, { now: NOW })

    const after = await repo.loadPortfolio()
    expect(ledgerOf(after).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
    // 目标账户不再持有该标的
    expect(ledgerOf(after).positions.get('a_hkd::i_cny')?.quantity ?? 0).toBe(0)

    const assetsAfter = calculateTotals({
      portfolio: after, fx: createFxTable(after.fxRates), now: NOW().getTime(),
    }).totalAssets
    expect(Math.abs(assetsAfter - assetsBefore)).toBeLessThan(0.01)
  })
})

/* ================================================================== *
 * 10) EXCHANGE 作废
 * ================================================================== */

describe('10 EXCHANGE 作废：两侧币种恢复，external flow = 0', () => {
  it('换汇作废后源币种与目标币种都恢复', async () => {
    const repo = await seedRepo()
    const id = await record(repo, {
      type: 'exchange', accountId: 'a_cny',
      cashInstrumentId: 'i_cny', toCashInstrumentId: 'i_hkd',
      // 换汇是单币种记录的：currency 必须等于**源**现金腿币种
      amount: 10000, toAmount: 9200, currency: 'CNY', toCurrency: 'HKD',
      timestamp: '2026-10-02T10:00:00.000Z',
    })

    const before = await repo.loadPortfolio()
    expect(ledgerOf(before).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(90000, 6)
    expect(ledgerOf(before).positions.get('a_cny::i_hkd')!.quantity).toBeCloseTo(9200, 6)

    await voidTransaction(repo, id, { now: NOW })

    const after = await repo.loadPortfolio()
    expect(ledgerOf(after).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
    expect(ledgerOf(after).positions.get('a_cny::i_hkd')?.quantity ?? 0).toBe(0)

    // 换汇不属于外部现金流（作废后依然成立）
    expect(flowOfActive(after).externalInflow).toBe(0)
    expect(flowOfActive(after).externalOutflow).toBe(0)
  })
})

/* ================================================================== *
 * 11) 重复作废
 * ================================================================== */

describe('11 重复作废：必须拒绝', () => {
  it('二次作废被拒绝且数据不再变化', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'deposit', amount: 5000 })

    const first = await voidTransaction(repo, id, { now: NOW })
    expect(first.ok).toBe(true)
    const afterFirst = JSON.stringify(await repo.loadPortfolio())

    const second = await voidTransaction(repo, id, { now: NOW })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('already-voided')

    expect(JSON.stringify(await repo.loadPortfolio())).toBe(afterFirst)
  })

  it('不存在的交易被拒绝且不写任何数据', async () => {
    const repo = await seedRepo()
    const before = JSON.stringify(await repo.loadPortfolio())
    const r = await voidTransaction(repo, 'no_such_tx', { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-found')
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })

  it('作废会导致负数持仓时被拒绝（不产生半状态）', async () => {
    const repo = await seedRepo()
    // 先买 100，再卖 80 —— 若作废那笔买入，卖出会变成超卖
    const buyId = await record(repo, {
      type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny', quantity: 100, amount: 1000,
      timestamp: '2026-10-02T10:00:00.000Z',
    })
    await record(repo, {
      type: 'sell', instrumentId: 'i_stock', cashInstrumentId: 'i_cny', quantity: 80, amount: 900,
      timestamp: '2026-10-03T10:00:00.000Z',
    })

    const before = JSON.stringify(await repo.loadPortfolio())
    const r = await voidTransaction(repo, buyId, { now: NOW })
    expect(r.ok).toBe(false)
    expect(['ledger-issue', 'would-cause-negative', 'not-enough-holding']).toContain(
      (r as { code: string }).code,
    )
    // 【核心】拒绝后数据一字未改
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })
})

/* ================================================================== *
 * 12) rebuild 一致性
 * ================================================================== */

describe('12 rebuild 一致性：作废后清空缓存重建结果一致', () => {
  it('作废前后 A/B 与新的有效交易集合一致', async () => {
    const repo = await seedRepo()
    await record(repo, { type: 'deposit', amount: 5000, timestamp: '2026-10-02T10:00:00.000Z' })
    await record(repo, {
      type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny',
      quantity: 100, amount: 1000, timestamp: '2026-10-02T11:00:00.000Z',
    })
    const sellId = await record(repo, {
      type: 'sell', instrumentId: 'i_stock', cashInstrumentId: 'i_cny',
      quantity: 30, amount: 400, timestamp: '2026-10-03T10:00:00.000Z',
    })
    await record(repo, {
      type: 'dividend', instrumentId: 'i_stock', cashInstrumentId: 'i_cny',
      amount: 20, timestamp: '2026-10-03T11:00:00.000Z',
    })

    await voidTransaction(repo, sellId, { now: NOW })

    const portfolioA = await repo.loadPortfolio()
    const rebuilt = rebuildHoldingsFromTransactions({ ...portfolioA, holdings: [] })
    expect(rebuilt.blocked).toBeFalsy()

    const key = (h: { accountId: string; instrumentId: string; quantity?: number; costBasis?: number }) =>
      `${h.accountId}::${h.instrumentId}::${h.quantity ?? 0}::${h.costBasis ?? 0}`

    const a = portfolioA.holdings.map(key).filter((k) => !k.endsWith('::0::0')).sort()
    const b = rebuilt.holdings.map(key).filter((k) => !k.endsWith('::0::0')).sort()
    expect(b).toEqual(a)
  })

  it('作废后账实相符且无重复持仓', async () => {
    const repo = await seedRepo()
    const id = await record(repo, {
      type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny', quantity: 100, amount: 1000,
    })
    await voidTransaction(repo, id, { now: NOW })

    const portfolio = await repo.loadPortfolio()
    expect(reconcileHoldings(portfolio).ok).toBe(true)
    expect(detectDuplicateHoldings(portfolio).ok).toBe(true)
  })
})

/* ================================================================== *
 * 最终态负数守卫（实现过程中发现的真实缺口）
 * ================================================================== */

describe('作废期初余额：最终态为负必须被拒绝', () => {
  it('【核心】作废 adjustment 导致最终现金为负时被拒绝，且不写任何数据', async () => {
    const repo = await seedRepo()

    /*
     * 场景：期初 adjustment +100000 排在最后（语义是「期末设定」）。
     * 作废掉它之后，只剩一笔买入 -1000 → **最终态现金 -1000**。
     *
     * `deriveLedger` 对现金腿只做累加、不检查余额，因此不会报 issue；
     * 若没有这道守卫，账本会被写成不可能的负数状态
     * （实测：总资产静默变成 0，用户不会收到任何提示）。
     */
    await record(repo, {
      type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny',
      quantity: 100, amount: 1000, timestamp: '2026-10-03T10:00:00.000Z',
    })

    const before = JSON.stringify(await repo.loadPortfolio())
    const r = await voidTransaction(repo, 'seed_cny', { now: NOW })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('would-cause-negative')
      expect(r.message).toContain('期初')
    }
    // 【核心】拒绝后数据一字未改（不留半状态）
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })

  it('【反例】中间态为负但最终态正常时**不应**被拒绝', async () => {
    const repo = await seedRepo()

    /*
     * buy 日期早于 adjustment → 处理顺序上 buy 先扣款，
     * 中间态现金为负，但 adjustment 最后会把余额设为 100000，
     * 最终态是 99000 —— 完全合法，必须允许。
     *
     * 这防止守卫退化成「一切中间负数都拒绝」（那会误杀正常组合）。
     */
    const buyId = await record(repo, {
      type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny',
      quantity: 100, amount: 1000, timestamp: '2026-09-20T10:00:00.000Z',
    })
    const r = await voidTransaction(repo, buyId, { now: NOW })
    expect(r.ok).toBe(true)

    const portfolio = await repo.loadPortfolio()
    expect(ledgerOf(portfolio).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
  })
})

/* ================================================================== *
 * 13) reload（IndexedDB 持久化）
 * ================================================================== */

describe('13 reload：重新读取后 rebuild 结果一致', () => {
  it('作废状态真正落库，重新加载后一致', async () => {
    const { repo, db } = await createPairedTestStore(`w5-void-${Date.now()}`)
    const p = basePortfolio()
    await repo.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })

    const id = await record(repo, {
      type: 'buy', instrumentId: 'i_stock', cashInstrumentId: 'i_cny', quantity: 100, amount: 1000,
    })
    await voidTransaction(repo, id, { now: NOW })

    // 从 IndexedDB 重新读取
    const reloaded = await repo.loadPortfolio()
    const tx = reloaded.transactions.find((t) => t.id === id)!
    expect(tx.status).toBe('VOIDED')
    expect(tx.voidedAt).toBeTruthy()

    const rebuilt = rebuildHoldingsFromTransactions({ ...reloaded, holdings: [] })
    const after = await repo.loadPortfolio()
    const key = (h: { instrumentId: string; quantity?: number }) => `${h.instrumentId}::${h.quantity ?? 0}`
    expect(rebuilt.holdings.map(key).sort()).toEqual(after.holdings.map(key).sort())
    await db.delete()
  })
})

/* ================================================================== *
 * 14) localStorage 隔离
 * ================================================================== */

describe('14 localStorage：清空不影响业务事实', () => {
  it('localStorage.clear() 后交易与作废状态仍完整', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'deposit', amount: 5000 })
    await voidTransaction(repo, id, { now: NOW })
    const before = await repo.loadPortfolio()

    if (typeof globalThis.localStorage !== 'undefined') globalThis.localStorage.clear()

    const after = await repo.loadPortfolio()
    expect(after.transactions).toHaveLength(before.transactions.length)
    expect(after.transactions.find((t) => t.id === id)!.status).toBe('VOIDED')
    expect(ledgerOf(after).positions.get('a_cny::i_cny')!.quantity).toBeCloseTo(100000, 6)
  })
})

/* ================================================================== *
 * Snapshot 与 Ledger 一致性（发现 2）
 * ================================================================== */

describe('Snapshot：已作废交易不进入当日现金流归因', () => {
  it('作废后新生成的快照不再把该交易算进现金流', async () => {
    const repo = await seedRepo()

    /*
     * 历史 opening 快照**直接写入仓储**（W8 起不能为过去日期调用
     * `captureSnapshot` —— 那会产出伪造历史）。
     * 这恰好模拟真实情形：它本来就是当时捕获的。
     */
    const today = localDate()
    const yesterday = previousDate(today)
    await repo.snapshots.put(
      buildSnapshot(await repo.loadPortfolio(), { date: yesterday, now: nowForLocalDate(yesterday) }).snapshot,
    )

    const id = await record(repo, { type: 'deposit', amount: 5000, timestamp: `${today}T10:00:00.000Z` })

    const withDeposit = await captureSnapshot(repo, { date: today, now: Date.now() })
    expect(withDeposit.snapshot.attributionStatus).not.toBe('unavailable')
    expect(withDeposit.snapshot.externalInflow).toBe(5000)

    await voidTransaction(repo, id, { now: NOW })

    const storedBefore = await repo.snapshots.byDate(today)
    expect(storedBefore!.externalInflow).toBe(5000)

    /*
     * 【核心】作废后**新生成**的快照不再把已作废交易算进现金流
     * （与 Ledger 的过滤保持一致）。
     *
     * 若这一条不成立，说明 `captureSnapshot` 的独立交易路径没跟上
     * `deriveLedger` 的过滤 —— 正是 W5 审计发现的第二个缺口。
     */
    const afterVoid = await captureSnapshot(repo, { date: today, now: Date.now() })
    expect(afterVoid.snapshot.externalInflow).toBe(0)
  })

  it('【不变量】ensureDailySnapshot 不会改写已存在的历史快照', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'deposit', amount: 5000, timestamp: '2026-10-02T10:00:00.000Z' })

    /*
     * 建立一份**历史**快照（W8 起改为直接写入仓储，因为不能为过去日期捕获）。
     * 它代表「当时已经记下的历史事实」。
     */
    const pastDate = previousDate(localDate())
    const past = buildSnapshot(await repo.loadPortfolio(), { date: pastDate, now: nowForLocalDate(pastDate) }).snapshot
    await repo.snapshots.put(past)
    const frozen = JSON.stringify(past)
    const frozenId = past.id

    // 作废该笔交易
    await voidTransaction(repo, id, { now: NOW })

    /*
     * W7 起语义细化为：
     * - **当天**快照允许刷新（否则当天录入/作废后曲线不更新，而 UI 谎报「已生成」）；
     * - **历史**快照永不触碰。
     *
     * 2026-10-02 相对 NOW()=2026-10-04 是**历史**，因此必须原样保留。
     */
    const again = await ensureDailySnapshot(repo, { date: pastDate, now: nowForLocalDate(pastDate) })
    expect(again.action).toBe('already-captured')
    if (again.action === 'already-captured') {
      expect(again.snapshot.id).toBe(frozenId)
    }
    // 【核心】历史快照**逐字节**未被回溯修改（含作废后也不重算）
    expect(JSON.stringify(await repo.snapshots.byDate(pastDate))).toBe(frozen)
  })

  it('【W7】当天快照会被刷新，但仍保留同一条记录（不新增）', async () => {
    const repo = await seedRepo()
    const today = localDate(new Date(NOW().getTime()))

    /*
     * 走**真实生产路径**生成当天快照（而不是直接调 captureSnapshot）——
     * 这样 attempt 才会记为 success，后续才会走「刷新」而不是「崩溃恢复」。
     */
    const firstOutcome = await ensureDailySnapshot(repo, { date: today, now: NOW().getTime() })
    expect(firstOutcome.action).toBe('captured')
    const first = await captureSnapshot(repo, { date: today, now: NOW().getTime() })
    const before = await repo.snapshots.getAll()
    expect(before).toHaveLength(1)

    // 当天写入一笔交易后，走生产路径刷新
    const id = await record(repo, { type: 'deposit', amount: 7777, timestamp: `${today}T10:00:00.000Z` })
    const outcome = await ensureDailySnapshot(repo, { date: today, now: NOW().getTime() })
    expect(outcome.action).toBe('recaptured')

    const after = await repo.snapshots.getAll()
    // 【核心】仍然是同一条记录（&date 唯一索引），只是内容被刷新
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(first.snapshot.id)
    expect(after[0].netWorth).toBe(first.snapshot.netWorth + 7777)

    // 作废后再次刷新 → 金额随之回落
    await voidTransaction(repo, id, { now: NOW })
    await ensureDailySnapshot(repo, { date: today, now: NOW().getTime() })
    expect((await repo.snapshots.getAll())[0].netWorth).toBe(first.snapshot.netWorth)
  })
})

/* ================================================================== *
 * Migration：V5 → V6 零填充
 * ================================================================== */

describe('Migration V5→V6：老数据零填充', () => {
  it('不给老交易写 POSTED，不改其它字段，不产生冲正', () => {
    const p = basePortfolio()
    const before = JSON.stringify(p.transactions)

    const r = migrateV5ToV6({ portfolio: p, now: () => '2026-10-04T00:00:00.000Z' })

    // 交易内容一字未改（只统计，不回填）
    expect(JSON.stringify(r.portfolio.transactions)).toBe(before)
    expect(r.portfolio.transactions.every((t) => t.status === undefined)).toBe(true)
    expect(r.unstatusedTransactionCount).toBe(2)
    expect(r.record.migrationId).toBe('schema-v5-to-v6-transaction-status')
    expect(r.record.note).toContain('不回填')
  })

  it('迁移不修改 Snapshot', () => {
    const p = basePortfolio()
    const withSnap = {
      ...p,
      snapshots: [
        {
          id: 's1', date: '2026-10-01', totalAssets: 1, totalLiabilities: 0, netWorth: 1,
          currency: 'CNY' as const, assetAllocation: {}, attributionStatus: 'unavailable' as const,
          captureKind: 'REAL' as const, createdAt: '2026-10-01T00:00:00.000Z', positions: [],
        },
      ],
    }
    const r = migrateV5ToV6({ portfolio: withSnap })
    expect(r.portfolio.snapshots).toEqual(withSnap.snapshots)
  })

  it('幂等：两次执行结果一致', () => {
    const p = basePortfolio()
    const a = migrateV5ToV6({ portfolio: p, now: () => 'T1' })
    const b = migrateV5ToV6({ portfolio: a.portfolio, now: () => 'T1' })
    expect(b.portfolio.transactions).toEqual(a.portfolio.transactions)
  })
})

/* ================================================================== *
 * 生命周期工具
 * ================================================================== */

describe('生命周期工具：状态归一化', () => {
  it('undefined 按 POSTED 处理（老数据兼容的关键）', () => {
    const tx = { id: 'x', accountId: 'a', type: 'deposit', amount: 1, currency: 'CNY', timestamp: T0 } as Transaction
    expect(transactionStatus(tx)).toBe('POSTED')
    expect(isVoided(tx)).toBe(false)
    expect(transactionStatusOf(tx)).toBe('POSTED')
  })

  it('transactionCounts 正确统计', () => {
    const txs: Transaction[] = [
      { id: '1', accountId: 'a', type: 'deposit', amount: 1, currency: 'CNY', timestamp: T0 },
      { id: '2', accountId: 'a', type: 'deposit', amount: 1, currency: 'CNY', timestamp: T0, status: 'VOIDED' },
      { id: '3', accountId: 'a', type: 'deposit', amount: 1, currency: 'CNY', timestamp: T0, status: 'POSTED' },
    ]
    expect(transactionCounts(txs)).toEqual({ posted: 2, voided: 1 })
  })

  it('作废保留 voidReason', async () => {
    const repo = await seedRepo()
    const id = await record(repo, { type: 'deposit', amount: 100 })
    await voidTransaction(repo, id, { reason: '金额录错', now: NOW })
    const tx = (await repo.loadPortfolio()).transactions.find((t) => t.id === id)!
    expect(tx.voidReason).toBe('金额录错')
    expect(tx.voidedAt).toBeTruthy()
  })
})
