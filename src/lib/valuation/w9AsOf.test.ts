import { describe, expect, it } from 'vitest'
import { latestQuoteFor } from './quote'
import { valuateHolding } from './engine'
import { createFxTable } from './fx'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { Portfolio2, Quote } from '../../types/portfolio2'

/*
 * Phase 8 / W9 — P1-2：latestQuoteFor 的 as-of 契约
 *
 * 契约：给出 `asOf` 时，只取 `timestamp <= asOf` 的最新一条。
 */

const T = (iso: string) => new Date(iso).toISOString()

function quote(id: string, ts: string, price: number): Quote {
  return {
    id, instrumentId: 'i1', priceKind: 'market_price', marketPrice: price,
    currency: 'CNY', source: 't', timestamp: ts, status: 'LIVE',
  }
}

describe('latestQuoteFor：as-of 过滤', () => {
  const quotes = [
    quote('q1', '2026-10-01T00:00:00.000Z', 10),
    quote('q2', '2026-10-02T00:00:00.000Z', 11),
    quote('q3', '2026-10-05T00:00:00.000Z', 99), // 未来
  ]

  it('【核心】不给 asOf → 取全局最新（实时估值语义）', () => {
    expect(latestQuoteFor(quotes, 'i1')?.id).toBe('q3')
  })

  it('【核心】给 asOf → 只取 <= asOf 的最新一条（未来行情被排除）', () => {
    expect(latestQuoteFor(quotes, 'i1', '2026-10-03T00:00:00.000Z')?.id).toBe('q2')
  })

  it('asOf 早于全部行情 → undefined（不猜测）', () => {
    expect(latestQuoteFor(quotes, 'i1', '2026-09-30T00:00:00.000Z')).toBeUndefined()
  })

  it('asOf 恰好等于某条行情时间 → 取到该条（闭区间）', () => {
    expect(latestQuoteFor(quotes, 'i1', '2026-10-02T00:00:00.000Z')?.id).toBe('q2')
  })

  it('不同标的互不干扰', () => {
    expect(latestQuoteFor(quotes, 'other')).toBeUndefined()
  })
})

describe('【核心】未来时间的行情不得进入更早时点的估值', () => {
  function portfolio(futureQuote: boolean): Portfolio2 {
    const base = makePortfolio({
      accounts: [makeAccount({ id: 'a1', currency: 'CNY', region: 'CN' })],
      instruments: [
        makeInstrument({
          id: 'i1', name: '股票', instrumentType: 'stock',
          assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed',
        }),
      ],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
      ],
    })
    const now = Date.parse('2026-10-02T12:00:00.000Z')
    const q: Quote[] = futureQuote
      ? [quote('q_future', T('2026-10-05T00:00:00.000Z'), 99)]
      : // 贴近估值时点（LIVE 策略只认 1 小时内），确保走 ok 分支
        [quote('q_now', T('2026-10-02T11:30:00.000Z'), 10)]
    void now
    return { ...base, quotes: q }
  }

  it('估值时点之前有行情 → 正常采用', () => {
    const p = portfolio(false)
    const r = valuateHolding(p.holdings[0], p, {
      fx: createFxTable([]),
      now: Date.parse('2026-10-02T12:00:00.000Z'),
    })
    expect(r.status).toBe('ok')
    expect(r.valueInCurrency).toBe(1000) // 100 × 10
  })

  it('【核心】只有未来行情 → 判定为缺行情（不得采用未来价）', () => {
    const p = portfolio(true)
    const r = valuateHolding(p.holdings[0], p, {
      fx: createFxTable([]),
      now: Date.parse('2026-10-02T12:00:00.000Z'),
    })
    expect(r.status).toBe('unavailable')
    expect(r.reasons).toContain('missing_quote')
    // 绝不用未来价 99 算出 9900
    expect(r.value ?? r.valueInCurrency).not.toBe(9900)
  })

  it('时点推进到未来行情之后 → 该行情即可用', () => {
    const p = portfolio(true)
    const r = valuateHolding(p.holdings[0], p, {
      fx: createFxTable([]),
      now: Date.parse('2026-10-06T00:00:00.000Z'),
    })
    // 2026-10-05 的 LIVE 行情在 10-06 已超过 1 小时 policy → stale
    expect(['ok', 'stale']).toContain(r.status)
    expect(r.reasons).not.toContain('missing_quote')
  })
})
