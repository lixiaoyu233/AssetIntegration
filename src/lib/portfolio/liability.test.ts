import { describe, expect, it } from 'vitest'
import { decideLiability, findLiabilityConflicts } from './liability'
import { calculateTotals, valuateHolding } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { buildSnapshot } from '../performance/snapshot'
import { deriveAnalysis } from '../analysis'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { Portfolio2 } from '../../types/portfolio2'

/*
 * Phase 8 / W8 — 负债统一口径（P0-4）
 *
 * 修复的三重矛盾：
 *   1. UI 禁止选 liability 类别
 *   2. 引擎只认 assetClass === 'liability'
 *   3. Account.isLiability 从未被读取
 *
 * canonical rule：**两者都认**；同时成立只算一次；冲突时按更保守的负债处理并标记。
 */

const NOW = Date.parse('2026-10-04T10:00:00.000Z')

const mkAccount = (over: Record<string, unknown> = {}) =>
  makeAccount({ id: 'a1', name: '示例账户', currency: 'CNY', region: 'CN', ...over })
const mkInstrument = (over: Record<string, unknown> = {}) =>
  makeInstrument({
    id: 'i1', name: '示例标的', instrumentType: 'cash',
    assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed', ...over,
  })

/* ================================================================== *
 * decideLiability
 * ================================================================== */

describe('decideLiability：唯一判定入口', () => {
  it('标的类别是负债 → 负债', () => {
    const d = decideLiability(mkAccount(), mkInstrument({ assetClass: 'liability' }))
    expect(d.isLiability).toBe(true)
    expect(d.reason).toBe('instrument_asset_class')
    expect(d.conflict).toBe(false)
  })

  it('【核心】账户标记为负债 → 负债（原先完全无效）', () => {
    const d = decideLiability(mkAccount({ isLiability: true }), mkInstrument({ assetClass: 'equity' }))
    // 冲突：账户说负债、标的类别是资产
    expect(d.isLiability).toBe(true)
    expect(d.conflict).toBe(true)
  })

  it('账户标记负债 + 标的无明确类别 → 负债，不算冲突', () => {
    const d = decideLiability(mkAccount({ isLiability: true }), undefined)
    expect(d.isLiability).toBe(true)
    expect(d.reason).toBe('account_flag')
    expect(d.conflict).toBe(false)
  })

  it('【核心】两者都是负债 → 只算一次，且不报冲突', () => {
    const d = decideLiability(mkAccount({ isLiability: true }), mkInstrument({ assetClass: 'liability' }))
    expect(d.isLiability).toBe(true)
    expect(d.reason).toBe('both')
    expect(d.conflict).toBe(false)
  })

  it('两者都不是 → 资产', () => {
    const d = decideLiability(mkAccount(), mkInstrument({ assetClass: 'equity' }))
    expect(d.isLiability).toBe(false)
    expect(d.reason).toBe('none')
  })

  it('【核心】冲突时按更保守的负债处理 —— 净资产不虚高', () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', name: '信用卡', currency: 'CNY', region: 'CN', isLiability: true })],
      instruments: [makeInstrument({ id: 'i1', name: '某股票', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' })],
      holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 5000 })],
    })
    const t = calculateTotals({ portfolio: p, fx: createFxTable([]), now: NOW })
    // 按保守处理：计入负债，不进资产
    expect(t.totalAssets).toBe(0)
    expect(t.totalLiabilities).toBe(5000)
    expect(t.netWorth).toBe(-5000)
  })
})

/* ================================================================== *
 * 不重复计算
 * ================================================================== */

describe('负债不重复计算', () => {
  function build(isAccountLiability: boolean, assetClass: string): Portfolio2 {
    return makePortfolio({
      accounts: [makeAccount({ id: 'a1', name: '账户', currency: 'CNY', region: 'CN', isLiability: isAccountLiability })],
      instruments: [makeInstrument({ id: 'i1', name: '标的', instrumentType: 'other', assetClass: assetClass as never, currency: 'CNY', classificationStatus: 'confirmed' })],
      holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 1000 })],
    })
  }

  it('【核心】两者都为负债时，负债合计仍只有 1000（不是 2000）', () => {
    const t = calculateTotals({ portfolio: build(true, 'liability'), fx: createFxTable([]), now: NOW })
    expect(t.totalLiabilities).toBe(1000)
    expect(t.totalAssets).toBe(0)
  })

  it('仅类别为负债', () => {
    const t = calculateTotals({ portfolio: build(false, 'liability'), fx: createFxTable([]), now: NOW })
    expect(t.totalLiabilities).toBe(1000)
    expect(t.totalAssets).toBe(0)
  })

  it('仅账户为负债（类别为资产 → 冲突，按保守处理）', () => {
    const t = calculateTotals({ portfolio: build(true, 'equity'), fx: createFxTable([]), now: NOW })
    expect(t.totalLiabilities).toBe(1000)
    expect(t.totalAssets).toBe(0)
  })

  it('都不是负债 → 全部计入资产', () => {
    const t = calculateTotals({ portfolio: build(false, 'equity'), fx: createFxTable([]), now: NOW })
    expect(t.totalAssets).toBe(1000)
    expect(t.totalLiabilities).toBe(0)
  })
})

/* ================================================================== *
 * 三层口径一致（engine / snapshot / analysis）
 * ================================================================== */

describe('【核心】engine / snapshot / analysis 三层负债口径一致', () => {
  it('账户负债标记在三个层都被识别', () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [
        makeAccount({ id: 'a_asset', name: '资产账户', currency: 'CNY', region: 'CN' }),
        makeAccount({ id: 'a_debt', name: '负债账户', currency: 'CNY', region: 'CN', isLiability: true }),
      ],
      instruments: [
        makeInstrument({ id: 'i_cash', name: '现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
        makeInstrument({ id: 'i_loan', name: '贷款', instrumentType: 'other', assetClass: 'other', currency: 'CNY', classificationStatus: 'confirmed' }),
      ],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a_asset', instrumentId: 'i_cash', valuationMode: 'manual', manualValue: 10000 }),
        // 账户是负债账户，标的类别是 other → 必须被识别为负债
        makeHolding({ id: 'h2', accountId: 'a_debt', instrumentId: 'i_loan', valuationMode: 'manual', manualValue: 3000 }),
      ],
    })
    const withHoldings = { ...p, holdings: rebuildHoldingsFromTransactions(p).holdings }
    const fx = createFxTable([])

    // ① engine
    const totals = calculateTotals({ portfolio: withHoldings, fx, now: NOW })
    expect(totals.totalAssets).toBe(10000)
    expect(totals.totalLiabilities).toBe(3000)
    expect(totals.netWorth).toBe(7000)

    // ② snapshot
    const { snapshot } = buildSnapshot(withHoldings, { date: '2026-10-04', now: NOW })
    expect(snapshot.totalAssets).toBe(10000)
    expect(snapshot.totalLiabilities).toBe(3000)
    expect(snapshot.netWorth).toBe(7000)

    // ③ analysis
    const results = withHoldings.holdings.map((h) => valuateHolding(h, withHoldings, { fx, now: NOW }))
    const analysis = deriveAnalysis({ portfolio: withHoldings, results, totals, now: NOW })
    expect(analysis.liabilityRows).toHaveLength(1)
    expect(analysis.assetRows).toHaveLength(1)
    expect(analysis.liabilityRows[0].holdingId).toBe('h2')
    expect(analysis.reliableValueCny).toBe(10000) // 资产口径，不含负债
  })

  it('快照记录捕获当时的负债判定（供历史占比不重画）', () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', name: '负债账户', currency: 'CNY', region: 'CN', isLiability: true })],
      instruments: [makeInstrument({ id: 'i1', name: '贷款', instrumentType: 'other', assetClass: 'other', currency: 'CNY', classificationStatus: 'confirmed' })],
      holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 3000 })],
    })
    const { snapshot } = buildSnapshot(p, { date: '2026-10-04', now: NOW })
    expect(snapshot.positions[0].isLiabilityAtCapture).toBe(true)
  })
})

/* ================================================================== *
 * 冲突提示
 * ================================================================== */

describe('liability 冲突提示', () => {
  it('findLiabilityConflicts 报出具体冲突项', () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', name: '信用卡', currency: 'CNY', region: 'CN', isLiability: true })],
      instruments: [makeInstrument({ id: 'i1', name: '股票', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' })],
      holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 1 })],
    })
    const conflicts = findLiabilityConflicts(p)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].detail).toContain('信用卡')
    expect(conflicts[0].detail).toContain('equity')
  })

  it('无冲突时返回空数组', () => {
    const p: Portfolio2 = makePortfolio({
      accounts: [makeAccount({ id: 'a1', currency: 'CNY', region: 'CN' })],
      instruments: [makeInstrument({ id: 'i1', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' })],
      holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 1 })],
    })
    expect(findLiabilityConflicts(p)).toEqual([])
  })
})
