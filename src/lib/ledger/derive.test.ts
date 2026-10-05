import { describe, expect, it } from 'vitest'
import type { Transaction } from '../../types/portfolio2'
import {
  aggregateByInstrument,
  cashFlowByAccount,
  deriveLedger,
  getPosition,
  incomeByCurrency,
  realizedPnlByCurrency,
  sortTransactions,
} from './derive'
import { TRANSACTION_SEMANTICS, requiresInstrument, requiresQuantity } from './types'
import { describeReconcile, reconcileHoldings } from './reconcile'
import { makeHolding, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'

/* ------------------------------------------------------------------ *
 * 构造器
 * ------------------------------------------------------------------ */

let seq = 0
const tx = (patch: Partial<Transaction> & Pick<Transaction, 'type' | 'amount'>): Transaction => ({
  id: patch.id ?? `t${++seq}`,
  accountId: patch.accountId ?? 'acct1',
  instrumentId: patch.instrumentId,
  currency: patch.currency ?? 'CNY',
  timestamp: patch.timestamp ?? '2026-01-01T00:00:00.000Z',
  ...patch,
})

const T = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`

/* ------------------------------------------------------------------ *
 * 交易语义表
 * ------------------------------------------------------------------ */

describe('交易语义', () => {
  it('十种交易类型都有明确定义（含换汇）', () => {
    const types = Object.keys(TRANSACTION_SEMANTICS)
    expect(types.sort()).toEqual(
      ['adjustment', 'buy', 'deposit', 'dividend', 'exchange', 'fee', 'interest', 'sell', 'transfer', 'withdraw'].sort(),
    )
  })

  it('adjustment 是「置为」而不是「累加」', () => {
    expect(TRANSACTION_SEMANTICS.adjustment.quantity).toBe('set')
    expect(TRANSACTION_SEMANTICS.adjustment.cost).toBe('set')
  })

  it('buy / sell 影响数量，deposit / dividend 不影响', () => {
    expect(TRANSACTION_SEMANTICS.buy.quantity).toBe('delta')
    expect(TRANSACTION_SEMANTICS.sell.quantity).toBe('delta')
    expect(TRANSACTION_SEMANTICS.deposit.quantity).toBe('none')
    expect(TRANSACTION_SEMANTICS.dividend.quantity).toBe('none')
  })

  it('只有分红与利息是收入', () => {
    const income = Object.entries(TRANSACTION_SEMANTICS).filter(([, v]) => v.isIncome).map(([k]) => k)
    expect(income.sort()).toEqual(['dividend', 'interest'])
  })

  it('transfer 的现金流是内部移动，不产生损益', () => {
    expect(TRANSACTION_SEMANTICS.transfer.cashFlow).toBe('internal')
    expect(TRANSACTION_SEMANTICS.transfer.isIncome).toBe(false)
  })

  it('需要标的 / 数量的判定', () => {
    expect(requiresInstrument('buy')).toBe(true)
    expect(requiresInstrument('deposit')).toBe(false)
    expect(requiresQuantity('buy')).toBe(true)
    expect(requiresQuantity('adjustment')).toBe(true)
    expect(requiresQuantity('dividend')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 期初 adjustment
 * ------------------------------------------------------------------ */

describe('派生：期初 adjustment', () => {
  it('直接设定数量与成本，不做任何推断', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'inst1', accountId: 'a1', quantity: 1000, amount: 500 }),
    ])
    const pos = getPosition(report, 'a1', 'inst1')!
    expect(pos.quantity).toBe(1000)
    expect(pos.costBasis).toBe(500)
    expect(pos.averageCost).toBeCloseTo(0.5, 10)
  })

  it('adjustment 之后再买入，按加权平均累加', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a', quantity: 100, amount: 1000, timestamp: T(1) }),
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 100, amount: 2000, timestamp: T(2) }),
    ])
    const pos = getPosition(report, 'a', 'i')!
    expect(pos.quantity).toBe(200)
    expect(pos.costBasis).toBe(3000)
    expect(pos.averageCost).toBeCloseTo(15, 10)
  })

  it('同一持仓的第二条 adjustment 被拒绝（避免覆盖期初）', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a', quantity: 100, amount: 1000, timestamp: T(1) }),
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a', quantity: 999, amount: 999, timestamp: T(2) }),
    ])
    expect(getPosition(report, 'a', 'i')!.quantity).toBe(100)
    expect(report.issues.some((x) => x.reason === 'adjustment_not_first')).toBe(true)
  })

  it('adjustment 不产生现金流', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a', quantity: 100, amount: 1000 }),
    ])
    expect(report.entries[0].cashDelta).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * 买入 / 费用资本化
 * ------------------------------------------------------------------ */

describe('派生：买入与手续费', () => {
  it('买入金额与费用一并计入成本', () => {
    const report = deriveLedger([
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 10, amount: 1000, fee: 5 }),
    ])
    const pos = getPosition(report, 'a', 'i')!
    expect(pos.quantity).toBe(10)
    expect(pos.costBasis).toBe(1005) // 1000 + 5
    expect(pos.averageCost).toBeCloseTo(100.5, 10)
    expect(pos.fees).toBe(5)
  })

  it('买入产生的现金流出 = 金额 + 费用', () => {
    const report = deriveLedger([
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 10, amount: 1000, fee: 5 }),
    ])
    expect(report.entries[0].cashDelta).toBe(-1005)
  })

  it('多次买入的加权平均成本正确', () => {
    const report = deriveLedger([
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 10, amount: 1000, timestamp: T(1) }),
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 30, amount: 3600, timestamp: T(2) }),
    ])
    const pos = getPosition(report, 'a', 'i')!
    expect(pos.quantity).toBe(40)
    expect(pos.costBasis).toBe(4600)
    expect(pos.averageCost).toBeCloseTo(115, 10)
  })
})

/* ------------------------------------------------------------------ *
 * 卖出：按均价结转、均价不变、已实现盈亏
 * ------------------------------------------------------------------ */

describe('派生：卖出', () => {
  const setup = () =>
    deriveLedger([
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 100, amount: 1000, timestamp: T(1) }), // 均价 10
      tx({ type: 'sell', instrumentId: 'i', accountId: 'a', quantity: 40, amount: 600, timestamp: T(2) }), // 卖 40，成交 600
    ])

  it('数量减少，均价保持不变', () => {
    const pos = getPosition(setup(), 'a', 'i')!
    expect(pos.quantity).toBe(60)
    expect(pos.averageCost).toBeCloseTo(10, 10)
    expect(pos.costBasis).toBeCloseTo(600, 10) // 60 × 10
  })

  it('已实现盈亏 = 成交净额 − 结转成本', () => {
    const pos = getPosition(setup(), 'a', 'i')!
    expect(pos.realizedPnl).toBeCloseTo(200, 10) // 600 − 400
  })

  it('卖出扣除手续费后的现金流入正确', () => {
    const txs = [
      tx({ id: 'b1', type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 100, amount: 1000, timestamp: T(1) }),
      tx({ id: 's1', type: 'sell', instrumentId: 'i', accountId: 'a', quantity: 40, amount: 600, fee: 3, timestamp: T(2) }),
    ]
    const report = deriveLedger(txs)
    expect(report.entries.find((e) => e.transactionId === 's1' && e.leg === 'instrument')!.cashDelta).toBe(597)
    // 费用计入总费用，并从已实现盈亏里扣除
    expect(getPosition(report, 'a', 'i')!.realizedPnl).toBeCloseTo(197, 10)
  })

  it('全部卖出后数量与成本都归零（不留浮点残留）', () => {
    const report = deriveLedger([
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 3, amount: 100, timestamp: T(1) }),
      tx({ type: 'sell', instrumentId: 'i', accountId: 'a', quantity: 3, amount: 120, timestamp: T(2) }),
    ])
    const pos = getPosition(report, 'a', 'i')!
    expect(pos.quantity).toBe(0)
    expect(pos.costBasis).toBe(0)
    expect(pos.averageCost).toBe(0)
    expect(pos.realizedPnl).toBeCloseTo(20, 10)
  })

  it('卖出超过持有量会报问题但不崩', () => {
    const report = deriveLedger([
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 10, amount: 100, timestamp: T(1) }),
      tx({ type: 'sell', instrumentId: 'i', accountId: 'a', quantity: 50, amount: 500, timestamp: T(2) }),
    ])
    expect(report.issues.some((x) => x.reason === 'sell_exceeds_holding')).toBe(true)
    expect(getPosition(report, 'a', 'i')!.quantity).toBe(0)
  })

  it('先卖后买（无期初）时按均价为 0 处理并给出提示', () => {
    const report = deriveLedger([
      tx({ type: 'sell', instrumentId: 'i', accountId: 'a', quantity: 10, amount: 100 }),
    ])
    expect(report.issues.some((x) => x.reason === 'sell_exceeds_holding')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 现金类交易
 * ------------------------------------------------------------------ */

describe('派生：存入 / 取出 / 费用', () => {
  it('deposit 与 withdraw 只影响现金（指定现金标的）', () => {
    const txs = [
      tx({ id: 'd1', type: 'deposit', accountId: 'a', cashInstrumentId: 'CASH', amount: 10000, timestamp: T(1) }),
      tx({ id: 'w1', type: 'withdraw', accountId: 'a', cashInstrumentId: 'CASH', amount: 3000, timestamp: T(2) }),
    ]
    const report = deriveLedger(txs)
    // 现金持仓数量即金额：10000 − 3000
    expect(getPosition(report, 'a', 'CASH')!.quantity).toBe(7000)
    // 且只产生现金持仓，没有投资持仓
    expect(report.positions.size).toBe(1)
    expect(cashFlowByAccount(report, txs).get('a')?.CNY).toBe(7000)
  })

  it('未指定现金标的时仍记录现金流，只是不落持仓', () => {
    const txs = [
      tx({ id: 'd2', type: 'deposit', accountId: 'a', amount: 10000, timestamp: T(1) }),
      tx({ id: 'w2', type: 'withdraw', accountId: 'a', amount: 3000, timestamp: T(2) }),
    ]
    const report = deriveLedger(txs)
    // 不落任何持仓（key 为空），但现金流仍可统计
    expect(report.positions.size).toBe(0)
    expect(cashFlowByAccount(report, txs).get('a')?.CNY).toBe(7000)
  })

  it('独立 fee 是现金流出，不改变任何持仓数量', () => {
    const report = deriveLedger([tx({ type: 'fee', accountId: 'a', amount: 20 })])
    expect(report.entries[0].cashDelta).toBe(-20)
  })
})

/* ------------------------------------------------------------------ *
 * 分红 / 利息：收入，不冲减成本
 * ------------------------------------------------------------------ */

describe('派生：分红与利息', () => {
  it('分红计入收入，但成本口径不变', () => {
    const txs = [
      tx({ id: 'b1', type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 100, amount: 1000, timestamp: T(1) }),
      tx({ id: 'dv1', type: 'dividend', instrumentId: 'i', accountId: 'a', amount: 50, fee: 2, timestamp: T(2) }),
    ]
    const report = deriveLedger(txs)
    const pos = getPosition(report, 'a', 'i')!
    // 关键：成本不被分红冲减
    expect(pos.costBasis).toBe(1000)
    expect(pos.averageCost).toBeCloseTo(10, 10)
    // 收入为净额
    expect(pos.income).toBeCloseTo(48, 10)
    expect(report.entries.find((e) => e.type === 'dividend' && e.leg === 'instrument')!.cashDelta).toBe(48)
  })

  it('利息同样计入收入', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'bond', accountId: 'a', quantity: 1000, amount: 1000, timestamp: T(1) }),
      tx({ type: 'interest', instrumentId: 'bond', accountId: 'a', amount: 30, timestamp: T(2) }),
    ])
    expect(getPosition(report, 'a', 'bond')!.income).toBeCloseTo(30, 10)
    expect(incomeByCurrency(report).CNY).toBeCloseTo(30, 10)
  })

  it('已实现盈亏与收入分开统计', () => {
    const report = deriveLedger([
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 10, amount: 100, timestamp: T(1) }),
      tx({ type: 'sell', instrumentId: 'i', accountId: 'a', quantity: 10, amount: 150, timestamp: T(2) }),
      tx({ type: 'dividend', instrumentId: 'i', accountId: 'a', amount: 20, timestamp: T(3) }),
    ])
    expect(realizedPnlByCurrency(report).CNY).toBeCloseTo(50, 10)
    expect(incomeByCurrency(report).CNY).toBeCloseTo(20, 10)
  })
})

/* ------------------------------------------------------------------ *
 * transfer：不重复计算
 * ------------------------------------------------------------------ */

describe('派生：账户间划转不重复计算资产', () => {
  it('划转不改变组合层的总数量与总成本（单条原子移动）', () => {
    const txs = [
      tx({ type: 'buy', instrumentId: 'i', accountId: 'a1', quantity: 100, amount: 1000, timestamp: T(1) }),
      tx({ type: 'transfer', instrumentId: 'i', accountId: 'a1', quantity: 100, amount: 1000, toAccountId: 'a2', timestamp: T(2) }),
    ]
    const report = deriveLedger(txs)
    expect(report.issues).toHaveLength(0)

    // 源账户归零，目标账户承接；组合层面总量不变
    expect(getPosition(report, 'a1', 'i')!.quantity).toBe(0)
    expect(getPosition(report, 'a1', 'i')!.costBasis).toBe(0)
    expect(getPosition(report, 'a2', 'i')!.quantity).toBe(100)
    expect(getPosition(report, 'a2', 'i')!.costBasis).toBeCloseTo(1000, 10)

    const total = aggregateByInstrument(report).get('i')!
    expect(total.quantity).toBe(100) // 未被重复计量
    expect(total.costBasis).toBeCloseTo(1000, 10)
  })

  it('划转缺少目标账户时给出问题而不是静默吞掉', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a1', quantity: 10, amount: 100, timestamp: T(1) }),
      tx({ type: 'transfer', instrumentId: 'i', accountId: 'a1', amount: 100, timestamp: T(2) }),
    ])
    expect(report.issues.some((x) => x.reason === 'missing_transfer_target')).toBe(true)
    // 未指定目标时保持原状，不丢资产
    expect(getPosition(report, 'a1', 'i')!.quantity).toBe(10)
  })

  it('划转本身不产生已实现盈亏', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a1', quantity: 10, amount: 100, timestamp: T(1) }),
      tx({ type: 'transfer', instrumentId: 'i', accountId: 'a1', quantity: 10, amount: 100, toAccountId: 'a2', timestamp: T(2) }),
    ])
    expect(getPosition(report, 'a1', 'i')!.realizedPnl).toBe(0)
  })

  it('划转不产生现金流', () => {
    const report = deriveLedger([
      tx({ type: 'transfer', instrumentId: 'i', accountId: 'a1', quantity: 10, amount: 100, toAccountId: 'a2' }),
    ])
    expect(report.entries[0].cashDelta).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * 缺失与异常
 * ------------------------------------------------------------------ */

describe('派生：异常处理', () => {
  it('缺账户 / 缺标的 / 缺数量会被记录为问题', () => {
    const report = deriveLedger([
      tx({ type: 'buy', accountId: '', instrumentId: 'i', quantity: 1, amount: 1 }),
      tx({ type: 'buy', accountId: 'a', quantity: 1, amount: 1 }),
      tx({ type: 'buy', accountId: 'a', instrumentId: 'i', quantity: 0, amount: 1 }),
    ])
    const reasons = report.issues.map((i) => i.reason)
    expect(reasons).toContain('missing_account')
    expect(reasons).toContain('missing_instrument')
    expect(reasons).toContain('missing_quantity')
  })

  it('排序：时间升序，同一时间 adjustment 优先', () => {
    const t = [
      tx({ id: 'b', type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 1, amount: 1, timestamp: T(2) }),
      tx({ id: 'a', type: 'adjustment', instrumentId: 'i', accountId: 'a', quantity: 1, amount: 1, timestamp: T(2) }),
      tx({ id: 'c', type: 'buy', instrumentId: 'i', accountId: 'a', quantity: 1, amount: 1, timestamp: T(1) }),
    ]
    expect(sortTransactions(t).map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('空交易列表返回空结果', () => {
    const report = deriveLedger([])
    expect(report.positions.size).toBe(0)
    expect(report.issues).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * 对账
 * ------------------------------------------------------------------ */

describe('对账：交易派生 vs 持仓表', () => {
  const instrument = makeInstrument({ id: 'i1', name: '测试标的', currency: 'CNY' })

  it('一致时报告 ok', () => {
    const portfolio = makePortfolio({
      instruments: [instrument],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
      ],
      transactions: [
        tx({ type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 100, amount: 1000 }),
      ],
    })
    const report = reconcileHoldings(portfolio)
    expect(report.ok).toBe(true)
    expect(report.matchedCount).toBe(1)
    expect(describeReconcile(report)).toContain('账实相符')
  })

  it('数量不一致时给出可定位差异', () => {
    const portfolio = makePortfolio({
      instruments: [instrument],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
      ],
      transactions: [
        tx({ type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 80, amount: 1000 }),
      ],
    })
    const report = reconcileHoldings(portfolio)
    expect(report.ok).toBe(false)
    const issue = report.issues.find((i) => i.kind === 'quantity_mismatch')!
    expect(issue.stored).toBe(100)
    expect(issue.derived).toBe(80)
    expect(issue.diff).toBeCloseTo(-20, 10)
    expect(issue.holdingId).toBe('h1')
  })

  it('成本不一致时分别报告', () => {
    const portfolio = makePortfolio({
      instruments: [instrument],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 100, costBasis: 900 }),
      ],
      transactions: [
        tx({ type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 100, amount: 1000 }),
      ],
    })
    const report = reconcileHoldings(portfolio)
    expect(report.issues.some((i) => i.kind === 'cost_mismatch')).toBe(true)
  })

  it('持仓缺少期初交易时被识别（迁移遗漏）', () => {
    const portfolio = makePortfolio({
      instruments: [instrument],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
      ],
      transactions: [],
    })
    const report = reconcileHoldings(portfolio)
    expect(report.issues[0].kind).toBe('holding_without_ledger')
    expect(describeReconcile(report)).toContain('缺少期初交易')
  })

  it('默认跳过 manual 口径持仓（现金 / 房产靠 manualValue，不用交易表达）', () => {
    const cash = makeInstrument({ id: 'cash1', name: '现金', currency: 'CNY' })
    const portfolio = makePortfolio({
      instruments: [cash],
      holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'cash1', valuationMode: 'manual', manualValue: 5000 })],
      transactions: [],
    })
    expect(reconcileHoldings(portfolio).ok).toBe(true)
    expect(reconcileHoldings(portfolio).holdingCount).toBe(0)
    // 显式要求纳入时必须报出问题
    expect(reconcileHoldings(portfolio, { skipManualMode: false }).ok).toBe(false)
  })

  it('交易有记录但持仓缺失时报告', () => {
    const portfolio = makePortfolio({
      instruments: [instrument],
      holdings: [],
      transactions: [tx({ type: 'buy', instrumentId: 'i1', accountId: 'a1', quantity: 10, amount: 100 })],
    })
    const report = reconcileHoldings(portfolio)
    expect(report.issues.some((i) => i.kind === 'ledger_without_holding')).toBe(true)
  })

  it('浮点噪声不会误报（容差内视为一致）', () => {
    const portfolio = makePortfolio({
      instruments: [instrument],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 100.000000001, costBasis: 1000.001 }),
      ],
      transactions: [tx({ type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 100, amount: 1000 })],
    })
    expect(reconcileHoldings(portfolio).ok).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Ledger 服务层（Repository → 派生 → 对账）
 * ------------------------------------------------------------------ */

describe('LedgerService：从 Repository 构建账本快照', () => {
  it('内存仓储可完整走通（证明服务层不依赖 Dexie）', async () => {
    const { createInMemoryRepository } = await import('../db/dexieRepository')
    const { loadLedgerSnapshot, loadHoldingLedger, toTransactionRows } = await import('./service')
    const repo = createInMemoryRepository()

    const inst = makeInstrument({ id: 'i1', name: '测试标的', currency: 'CNY' })
    await repo.instruments.put(inst)
    await repo.accounts.put({
      id: 'a1', name: '示例账户', type: 'broker', currency: 'CNY', isLiability: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await repo.holdings.put(
      makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
    )
    await repo.transactions.putMany([
      tx({ id: 'x1', type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 100, amount: 1000, timestamp: T(1) }),
      tx({ id: 'x2', type: 'buy', instrumentId: 'i1', accountId: 'a1', quantity: 10, amount: 120, timestamp: T(2) }),
    ])

    // 持仓表仍写 100/1000，而交易派生为 110/1120 → 应报告不一致
    const snapshot = await loadLedgerSnapshot(repo)
    expect(snapshot.transactionCount).toBe(2)
    expect(snapshot.reconcile.ok).toBe(false)
    expect(snapshot.reconcile.issues.some((i) => i.kind === 'quantity_mismatch')).toBe(true)

    // 单持仓视图
    const view = await loadHoldingLedger(repo, 'a1', 'i1')
    expect(view.transactions).toHaveLength(2)
    expect(view.position?.quantity).toBe(110)
    expect(view.position?.costBasis).toBeCloseTo(1120, 10)

    // 展示行
    const rows = toTransactionRows(snapshot.ledger, await repo.transactions.getAll())
    expect(rows[0].date).toBe(T(2)) // 倒序：最新在前
    expect(rows.find((r) => r.id === 'x2')?.cashDelta).toBe(-120)
    expect(rows.find((r) => r.id === 'x1')?.cashDelta).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * 部分划转（用户确认的新能力）
 * ------------------------------------------------------------------ */

describe('派生：部分划转', () => {
  const base = (extra: Partial<Transaction> = {}) => [
    tx({ type: 'adjustment', instrumentId: 'SPYM', accountId: 'schwab', quantity: 100, amount: 6000, timestamp: T(1) }),
    tx({
      type: 'transfer', instrumentId: 'SPYM', accountId: 'schwab', toAccountId: 'yingli',
      amount: 1800, transferQuantity: 30, timestamp: T(2), ...extra,
    }),
  ]

  it('源账户保留余额，目标账户获得转移部分', () => {
    const report = deriveLedger(base())
    // 100 股 → 移 30 股：源 70、目标 30
    expect(getPosition(report, 'schwab', 'SPYM')!.quantity).toBe(70)
    expect(getPosition(report, 'yingli', 'SPYM')!.quantity).toBe(30)
  })

  it('【核心】组合层总数量与总成本完全不变', () => {
    const report = deriveLedger(base())
    const total = aggregateByInstrument(report).get('SPYM')!
    expect(total.quantity).toBe(100)
    expect(total.costBasis).toBeCloseTo(6000, 8)
  })

  it('成本按移动加权平均随数量转移', () => {
    const report = deriveLedger(base())
    // 均价 60 → 移 30 股带 1800 成本
    expect(getPosition(report, 'yingli', 'SPYM')!.costBasis).toBeCloseTo(1800, 8)
    expect(getPosition(report, 'schwab', 'SPYM')!.costBasis).toBeCloseTo(4200, 8)
    // 两边均价一致（因为按均价结转）
    expect(getPosition(report, 'yingli', 'SPYM')!.averageCost).toBeCloseTo(60, 8)
    expect(getPosition(report, 'schwab', 'SPYM')!.averageCost).toBeCloseTo(60, 8)
  })

  it('【核心】不产生已实现盈亏、收入或现金流', () => {
    const report = deriveLedger(base())
    expect(getPosition(report, 'schwab', 'SPYM')!.realizedPnl).toBe(0)
    expect(getPosition(report, 'yingli', 'SPYM')!.realizedPnl).toBe(0)
    expect(realizedPnlByCurrency(report).CNY ?? 0).toBe(0)
    expect(incomeByCurrency(report).CNY ?? 0).toBe(0)
    for (const e of report.entries) expect(e.cashDelta).toBe(0)
  })

  it('不产生 buy / sell 交易（交易类型仍是 transfer）', () => {
    const report = deriveLedger(base())
    const types = new Set(report.entries.map((e) => e.type))
    expect(types.has('buy')).toBe(false)
    expect(types.has('sell')).toBe(false)
    expect(types.has('transfer')).toBe(true)
  })

  it('部分划转后仍可继续交易，均价保持自洽', () => {
    const report = deriveLedger([
      ...base(),
      tx({ type: 'buy', instrumentId: 'SPYM', accountId: 'yingli', quantity: 10, amount: 700, timestamp: T(3) }),
    ])
    // yingli: 30 股 / 1800 + 10 股 / 700 = 40 股 / 2500 → 均价 62.5
    const y = getPosition(report, 'yingli', 'SPYM')!
    expect(y.quantity).toBe(40)
    expect(y.costBasis).toBeCloseTo(2500, 8)
    expect(y.averageCost).toBeCloseTo(62.5, 8)
    // schwab 不受影响
    expect(getPosition(report, 'schwab', 'SPYM')!.quantity).toBe(70)
  })

  it('划转数量超过持有量时按持有量转移并报问题', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a1', quantity: 10, amount: 100, timestamp: T(1) }),
      tx({ type: 'transfer', instrumentId: 'i', accountId: 'a1', toAccountId: 'a2', amount: 100, transferQuantity: 99, timestamp: T(2) }),
    ])
    expect(report.issues.some((x) => x.reason === 'transfer_exceeds_holding')).toBe(true)
    expect(getPosition(report, 'a1', 'i')!.quantity).toBe(0)
    expect(getPosition(report, 'a2', 'i')!.quantity).toBe(10)
  })

  it('transferQuantity 等于持有量等同于整体移动', () => {
    const a = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a1', quantity: 10, amount: 100, timestamp: T(1) }),
      tx({ type: 'transfer', instrumentId: 'i', accountId: 'a1', toAccountId: 'a2', amount: 100, transferQuantity: 10, timestamp: T(2) }),
    ])
    const b = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'i', accountId: 'a1', quantity: 10, amount: 100, timestamp: T(1) }),
      tx({ type: 'transfer', instrumentId: 'i', accountId: 'a1', toAccountId: 'a2', amount: 100, timestamp: T(2) }),
    ])
    expect(getPosition(a, 'a1', 'i')!.quantity).toBe(getPosition(b, 'a1', 'i')!.quantity)
    expect(getPosition(a, 'a2', 'i')!.costBasis).toBeCloseTo(getPosition(b, 'a2', 'i')!.costBasis, 8)
  })
})

/* ------------------------------------------------------------------ *
 * 现金腿：一笔交易影响两个 Holding，但不重复计量
 * ------------------------------------------------------------------ */

describe('派生：现金腿（避免重复计量）', () => {
  const buyWithCash = () =>
    deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'CASH_USD', accountId: 'a1', quantity: 10000, amount: 10000, currency: 'USD', timestamp: T(1) }),
      tx({
        type: 'buy', instrumentId: 'SPYM', accountId: 'a1', cashInstrumentId: 'CASH_USD',
        quantity: 13, amount: 1000, currency: 'USD', timestamp: T(2),
      }),
    ])

  it('买入同时：投资持仓增加、现金持仓减少', () => {
    const report = buyWithCash()
    expect(getPosition(report, 'a1', 'SPYM')!.quantity).toBe(13)
    expect(getPosition(report, 'a1', 'SPYM')!.costBasis).toBe(1000)
    expect(getPosition(report, 'a1', 'CASH_USD')!.quantity).toBe(9000)
  })

  it('【核心】一笔买入产生两个 leg，但总额不重复计量', () => {
    const report = buyWithCash()
    const legs = report.entries.filter((e) => e.transactionId === 't2' || e.type === 'buy')
    // 恰好两个 leg：instrument + cash
    expect(legs.filter((e) => e.leg === 'instrument')).toHaveLength(1)
    expect(legs.filter((e) => e.leg === 'cash')).toHaveLength(1)

    // 投资 −（现金减少）= 0：净资产变化为 0（忽略费用与价格变动）
    const investmentDelta = legs.find((e) => e.leg === 'instrument')!.costDelta
    const cashDelta = legs.find((e) => e.leg === 'cash')!.quantityDelta
    expect(investmentDelta + cashDelta).toBe(0)
  })

  it('现金持仓的数量即金额，均价恒为 1', () => {
    const report = buyWithCash()
    const cash = getPosition(report, 'a1', 'CASH_USD')!
    expect(cash.quantity).toBe(9000)
    expect(cash.costBasis).toBe(9000)
    expect(cash.averageCost).toBe(1)
  })

  it('卖出 / 分红 / 利息让现金增加，费用让现金减少', () => {
    const mk = (type: Transaction['type'], amount: number, fee?: number) =>
      deriveLedger([
        tx({ type: 'adjustment', instrumentId: 'CASH', accountId: 'a', quantity: 1000, amount: 1000, timestamp: T(1) }),
        tx({ type, instrumentId: 'X', accountId: 'a', cashInstrumentId: 'CASH', quantity: 1, amount, fee, timestamp: T(2) }),
      ])
    expect(getPosition(mk('sell', 300), 'a', 'CASH')!.quantity).toBe(1300)
    expect(getPosition(mk('dividend', 50), 'a', 'CASH')!.quantity).toBe(1050)
    expect(getPosition(mk('interest', 30), 'a', 'CASH')!.quantity).toBe(1030)
    expect(getPosition(mk('fee', 20), 'a', 'CASH')!.quantity).toBe(980)
  })

  it('deposit / withdraw 直接作用于现金持仓', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'CASH', accountId: 'a', quantity: 1000, amount: 1000, timestamp: T(1) }),
      tx({ type: 'deposit', accountId: 'a', cashInstrumentId: 'CASH', amount: 500, timestamp: T(2) }),
      tx({ type: 'withdraw', accountId: 'a', cashInstrumentId: 'CASH', amount: 200, timestamp: T(3) }),
    ])
    expect(getPosition(report, 'a', 'CASH')!.quantity).toBe(1300)
  })

  it('同一账户可同时存在多币种现金持仓', () => {
    const report = deriveLedger([
      tx({ type: 'adjustment', instrumentId: 'CASH_USD', accountId: 'a', quantity: 10000, amount: 10000, currency: 'USD', timestamp: T(1) }),
      tx({ type: 'adjustment', instrumentId: 'CASH_HKD', accountId: 'a', quantity: 50000, amount: 50000, currency: 'HKD', timestamp: T(1) }),
      tx({ type: 'adjustment', instrumentId: 'CASH_CNY', accountId: 'a', quantity: 20000, amount: 20000, currency: 'CNY', timestamp: T(1) }),
    ])
    expect(getPosition(report, 'a', 'CASH_USD')!.currency).toBe('USD')
    expect(getPosition(report, 'a', 'CASH_HKD')!.quantity).toBe(50000)
    expect(getPosition(report, 'a', 'CASH_CNY')!.quantity).toBe(20000)
  })

  it('未指定 cashInstrumentId 时不产生现金持仓（只记流水）', () => {
    const report = deriveLedger([
      tx({ type: 'buy', instrumentId: 'X', accountId: 'a', quantity: 1, amount: 100, timestamp: T(1) }),
    ])
    // 设计变更：现金流仍会被记录（key 为空），但**不会**新建现金持仓
    expect(report.positions.size).toBe(1) // 只有投资持仓
    expect(report.positions.has('a::X')).toBe(true)
    expect(report.entries.filter((e) => e.leg === 'cash' && e.key !== '')).toHaveLength(0)
  })

  it('现金标的与投资标的相同时跳过现金腿并报问题', () => {
    const report = deriveLedger([
      tx({ type: 'buy', instrumentId: 'X', accountId: 'a', cashInstrumentId: 'X', quantity: 1, amount: 100, timestamp: T(1) }),
    ])
    expect(report.issues.some((x) => x.reason === 'cash_leg_same_as_instrument')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 从交易重建 Holding
 * ------------------------------------------------------------------ */

describe('重建：从交易派生 Holding（单一真相来源）', () => {
  it('缓存与交易不一致时，以交易为准重建', async () => {
    const { rebuildHoldingFromTransactions } = await import('./rebuild')
    const portfolio = makePortfolio({
      instruments: [makeInstrument({ id: 'i1', currency: 'CNY' })],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 80, costBasis: 999 }),
      ],
      transactions: [
        tx({ type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 100, amount: 1000, timestamp: T(1) }),
        tx({ type: 'buy', instrumentId: 'i1', accountId: 'a1', quantity: 10, amount: 120, timestamp: T(2) }),
      ],
    })
    const rebuilt = rebuildHoldingFromTransactions(portfolio, 'a1', 'i1')!
    // 交易派生的 110 / 1120 覆盖了错误的手工值 80 / 999
    expect(rebuilt.quantity).toBe(110)
    expect(rebuilt.costBasis).toBeCloseTo(1120, 8)
    expect(rebuilt.id).toBe('h1') // 保留原 id，不新建
  })

  it('重建保留 id 与非派生字段（note / manualValue 等）', async () => {
    const { rebuildHoldingsFromTransactions } = await import('./rebuild')
    const portfolio = makePortfolio({
      instruments: [makeInstrument({ id: 'i1', currency: 'CNY' })],
      holdings: [
        makeHolding({
          id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity',
          quantity: 1, costBasis: 1, note: '我的备注', openedAt: '2025-01-01T00:00:00.000Z',
        }),
      ],
      transactions: [tx({ type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 50, amount: 500 })],
    })
    const r = rebuildHoldingsFromTransactions(portfolio)
    const h = r.holdings.find((x) => x.id === 'h1')!
    expect(h.note).toBe('我的备注')
    expect(h.openedAt).toBe('2025-01-01T00:00:00.000Z')
    expect(h.quantity).toBe(50)
    expect(r.rebuiltCount).toBe(1)
  })

  it('manual 口径持仓原样保留，不被重建清空', async () => {
    const { rebuildHoldingsFromTransactions } = await import('./rebuild')
    const portfolio = makePortfolio({
      instruments: [makeInstrument({ id: 'cash', currency: 'CNY', assetClass: 'cash' })],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'cash', valuationMode: 'manual', manualValue: 50000 }),
      ],
      transactions: [],
    })
    const r = rebuildHoldingsFromTransactions(portfolio)
    expect(r.preservedCount).toBe(1)
    expect(r.rebuiltCount).toBe(0)
    expect(r.holdings[0].manualValue).toBe(50000)
  })

  it('交易里有、持仓表没有 → 新建', async () => {
    const { rebuildHoldingsFromTransactions } = await import('./rebuild')
    const portfolio = makePortfolio({
      instruments: [makeInstrument({ id: 'i1', currency: 'CNY' })],
      holdings: [],
      transactions: [tx({ type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 10, amount: 100 })],
    })
    const r = rebuildHoldingsFromTransactions(portfolio)
    expect(r.createdCount).toBe(1)
    expect(r.holdings).toHaveLength(1)
    expect(r.holdings[0].accountId).toBe('a1')
  })

  it('缺少 Instrument 时跳过并记录，不静默丢失', async () => {
    const { rebuildHoldingsFromTransactions } = await import('./rebuild')
    const portfolio = makePortfolio({
      instruments: [],
      transactions: [tx({ type: 'adjustment', instrumentId: 'missing', accountId: 'a1', quantity: 10, amount: 100 })],
    })
    const r = rebuildHoldingsFromTransactions(portfolio)
    expect(r.skipped).toEqual(['a1::missing'])
    expect(r.holdings).toHaveLength(0)
  })

  it('重建后立即对账应当完全一致（闭环）', async () => {
    const { rebuildHoldingsFromTransactions } = await import('./rebuild')
    const original = makePortfolio({
      instruments: [makeInstrument({ id: 'i1', currency: 'CNY' })],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 999, costBasis: 999 }),
      ],
      transactions: [
        tx({ type: 'adjustment', instrumentId: 'i1', accountId: 'a1', quantity: 100, amount: 1000, timestamp: T(1) }),
        tx({ type: 'buy', instrumentId: 'i1', accountId: 'a1', quantity: 20, amount: 300, timestamp: T(2) }),
        tx({ type: 'sell', instrumentId: 'i1', accountId: 'a1', quantity: 50, amount: 900, timestamp: T(3) }),
      ],
    })
    const rebuilt = { ...original, holdings: rebuildHoldingsFromTransactions(original).holdings }
    const report = reconcileHoldings(rebuilt)
    expect(report.ok).toBe(true)
    expect(report.matchedCount).toBe(1)
  })
})
