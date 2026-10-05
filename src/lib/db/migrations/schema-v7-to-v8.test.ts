import { describe, expect, it } from 'vitest'
import { inspectV7Gaps, migrateV7ToV8 } from './schema-v7-to-v8'
import { PORTFOLIO_SCHEMA_VERSION, MIGRATION_CHAIN } from '../schema'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from '../../valuation/__fixtures__/builders'
import type { Portfolio2, Snapshot } from '../../../types/portfolio2'

/*
 * Phase 8 / W8 — 迁移 V7 → V8
 *
 * 核心约束：**纯零填充**。不得回填历史事实。
 */
const T0 = '2026-10-01T10:00:00.000Z'

function v7Portfolio(): Portfolio2 {
  const p = makePortfolio({
    accounts: [makeAccount({ id: 'a1', name: '示例账户', currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({
        id: 'i_cash', name: '人民币现金', instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed',
      }),
    ],
    holdings: [
      makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000 }),
    ],
    transactions: [
      { id: 't1', accountId: 'a1', instrumentId: 'i_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: T0 },
    ],
  })
  // 模拟 V7 存量快照：没有 V8 字段
  const snap: Snapshot = {
    id: 's1', date: '2026-09-30', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000,
    currency: 'CNY', assetAllocation: { cash: 100000 }, attributionStatus: 'unavailable',
    captureKind: 'REAL', createdAt: T0,
    positions: [{
      instrumentId: 'i_cash', accountId: 'a1', quantity: 100000, price: 1,
      currency: 'CNY', rateToCny: 1, valueCny: 100000, reliable: true,
      assetClassAtCapture: 'cash',
      // 刻意不带 asOf / priceKind / quoteStatus / reasons / isLiabilityAtCapture
    }],
  }
  return { ...p, snapshots: [snap] }
}

describe('迁移 V7 → V8：纯零填充', () => {
  it('版本常量与迁移链正确', () => {
    expect(PORTFOLIO_SCHEMA_VERSION).toBe(8)
    expect(MIGRATION_CHAIN).toContain('schema-v7-to-v8-historical-facts')
    expect(MIGRATION_CHAIN[MIGRATION_CHAIN.length - 1]).toBe('schema-v7-to-v8-historical-facts')
  })

  it('【核心】不改动任何数据（历史快照逐字节不变）', () => {
    const p = v7Portfolio()
    const before = JSON.stringify(p.snapshots)
    const r = migrateV7ToV8({ portfolio: p, now: () => '2026-10-04T00:00:00.000Z' })
    expect(JSON.stringify(r.portfolio.snapshots)).toBe(before)
  })

  it('【核心】不回填 V8 字段（缺失即「无法追溯」）', () => {
    const p = v7Portfolio()
    const r = migrateV7ToV8({ portfolio: p })
    const pos = r.portfolio.snapshots[0].positions[0]
    expect(pos.asOf).toBeUndefined()
    expect(pos.priceKind).toBeUndefined()
    expect(pos.quoteStatus).toBeUndefined()
    expect(pos.reasons).toBeUndefined()
    expect(pos.isLiabilityAtCapture).toBeUndefined()
    expect(r.portfolio.snapshots[0].capturedAt).toBeUndefined()
    expect(r.portfolio.snapshots[0].openingDate).toBeUndefined()
  })

  it('【核心】不改变原有历史数值', () => {
    const p = v7Portfolio()
    const r = migrateV7ToV8({ portfolio: p })
    const snap = r.portfolio.snapshots[0]
    expect(snap.netWorth).toBe(100000)
    expect(snap.totalAssets).toBe(100000)
    expect(snap.positions[0].valueCny).toBe(100000)
    expect(snap.positions[0].price).toBe(1)
  })

  it('如实统计缺口并写入迁移记录', () => {
    const p = v7Portfolio()
    const gaps = inspectV7Gaps(p)
    expect(gaps.positionsWithoutBasis).toBe(1)
    expect(gaps.snapshotsWithoutCapturedAt).toBe(1)

    const r = migrateV7ToV8({ portfolio: p, now: () => 'T' })
    expect(r.record.migrationId).toBe('schema-v7-to-v8-historical-facts')
    expect(r.record.targetSchemaVersion).toBe(8)
    expect(r.record.status).toBe('success')
    expect(r.record.note).toContain('不回填')
    expect(r.record.note).toContain('无法追溯')
  })

  it('幂等：两次执行结果一致', () => {
    const p = v7Portfolio()
    const a = migrateV7ToV8({ portfolio: p, now: () => 'T' })
    const b = migrateV7ToV8({ portfolio: a.portfolio, now: () => 'T' })
    expect(JSON.stringify(b.portfolio)).toBe(JSON.stringify(a.portfolio))
    expect(b.positionsWithoutBasis).toBe(a.positionsWithoutBasis)
  })

  it('不重算快照（迁移不依赖 Quote / FX）', () => {
    const p = v7Portfolio()
    // 加入今天的行情与汇率 —— 迁移结果不应受其影响
    const withMarket: Portfolio2 = {
      ...p,
      quotes: [{ id: 'q1', instrumentId: 'i_cash', priceKind: 'market_price', marketPrice: 999, currency: 'CNY', source: 'manual', timestamp: '2026-10-04T00:00:00.000Z', status: 'MANUAL' }],
      fxRates: [{ id: 'fx1', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 9.9, timestamp: '2026-10-04T00:00:00.000Z', source: 'manual', status: 'MANUAL' }],
    }
    const before = JSON.stringify(withMarket.snapshots)
    const r = migrateV7ToV8({ portfolio: withMarket })
    expect(JSON.stringify(r.portfolio.snapshots)).toBe(before)
    // 快照里的价格没有被今天的 999 覆盖
    expect(r.portfolio.snapshots[0].positions[0].price).toBe(1)
  })
})
