import { describe, expect, it } from 'vitest'
import { applyCashConversion, convertConfirmedCashHoldings } from './cashConversion'
import { findInvalidExchanges } from './exchange'
import { isVoided } from './lifecycle'
import { activeTransactions } from './lifecycle'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { Portfolio2, Transaction } from '../../types/portfolio2'

/*
 * Phase 8 / W9 — P1-4：VOIDED 交易过滤补漏
 *
 * W5 只把过滤实现在 `deriveLedgerEffects` 入口；仍有消费方直接读原始数组。
 * 这里的测试锁定「已作废交易不得继续阻挡有效业务操作」。
 */

const A = 'a1'
const CASH = 'i_cash'

function portfolioWithCash(classificationStatus: 'confirmed' | 'unconfirmed' = 'confirmed'): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: A, name: '示例账户', currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({
        id: CASH, name: '人民币现金', instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus,
      }),
    ],
    holdings: [
      makeHolding({
        id: 'h_cash', accountId: A, instrumentId: CASH,
        valuationMode: 'manual', manualValue: 20000,
        manualValueAt: '2026-10-03T00:00:00.000Z',
      }),
    ],
  })
}

/* ================================================================== *
 * findInvalidExchanges
 * ================================================================== */

describe('findInvalidExchanges：已作废的换汇不再算作「无效」', () => {
  function withExchange(voided: boolean): Portfolio2 {
    const p = portfolioWithCash()
    const tx: Transaction = {
      id: 'tx_ex', accountId: A, instrumentId: 'i_usd', type: 'exchange',
      amount: 1000, currency: 'CNY', timestamp: '2026-10-04T00:00:00.000Z',
      // 刻意缺少换汇必需字段 → validateExchange 必然判定无效
      ...(voided ? { status: 'VOIDED' as const, voidedAt: '2026-10-05T00:00:00.000Z' } : {}),
    }
    return { ...p, transactions: [tx] }
  }

  it('【核心】有效的无效换汇会被报出（基线，保证测试本身有效）', () => {
    const bad = findInvalidExchanges(withExchange(false))
    expect(bad.length).toBeGreaterThan(0)
  })

  it('【核心】同一笔换汇被作废后，不再报出 —— 不再阻挡操作', () => {
    const after = findInvalidExchanges(withExchange(true))
    expect(after).toEqual([])
  })

  it('作废判定走的是 W5 的 lifecycle 语义', () => {
    const p = withExchange(true)
    expect(isVoided(p.transactions[0])).toBe(true)
    expect(activeTransactions(p.transactions)).toHaveLength(0)
  })
})

/* ================================================================== *
 * cashConversion 幂等
 * ================================================================== */

describe('cashConversion：已作废的 adjustment 不再参与幂等判断', () => {
  it('【核心】作废期初 adjustment 后，转换会重新补上（不被作废记录挡住）', () => {
    const p = portfolioWithCash('confirmed')

    // 第一次转换：补齐期初 adjustment
    const first = applyCashConversion(p, { timestamp: '2026-10-04T00:00:00.000Z' })
    expect(first.result.adjustments).toHaveLength(1)

    // 模拟持仓回到 manual（用户撤销/数据回退），并把那条 adjustment 作废
    const voidedAdjustment: Transaction = {
      ...first.result.adjustments[0],
      status: 'VOIDED',
      voidedAt: '2026-10-05T00:00:00.000Z',
    }
    const reverted: Portfolio2 = {
      ...p,
      transactions: [voidedAdjustment],
    }

    const again = convertConfirmedCashHoldings(reverted)
    // 作废 = 该交易不生效 → 幂等键不应把它算作「已有期初」
    expect(again.adjustments).toHaveLength(1)
    expect(again.convertedCount).toBe(1)
  })

  it('有效的期初 adjustment 仍然保证幂等（未作废时不重复补）', () => {
    const p = portfolioWithCash('confirmed')
    const first = applyCashConversion(p, { timestamp: '2026-10-04T00:00:00.000Z' })
    const second = applyCashConversion(first.portfolio, { timestamp: '2026-10-05T00:00:00.000Z' })
    expect(second.result.adjustments).toHaveLength(0)
  })
})
