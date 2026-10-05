import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createInMemoryRepository, createPairedTestStore } from './dexieRepository'
import type { PortfolioRepository } from './repository'
import {
  coldStartStateOf,
  createAccount,
  createInstrument,
  createManualHolding,
} from './creation'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { reconcileHoldings } from '../ledger/reconcile'
import { detectDuplicateHoldings } from '../ledger/duplicates'
import { calculateTotals, valuateHolding } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { deriveAnalysis } from '../analysis'
import { resetReadOnlyMode } from '../readOnly'

/*
 * Phase 8 / W7 — 冷启动：创建账户 / 标的 / 手动口径持仓
 *
 * 解决 W7 审计的 P0-1：2.0 全 UI 对 accounts 的写入调用数为 0，
 * 新用户拿到的是一个**不可用**的应用。
 */

const NOW = () => new Date('2026-10-04T10:00:00.000Z')

beforeEach(() => resetReadOnlyMode())
afterEach(() => resetReadOnlyMode())

/** 空库 */
const empty = () => createInMemoryRepository()

/** 从零建立一套结构（模拟新用户） */
async function bootstrapStructure(repo: PortfolioRepository) {
  const acc = await createAccount(repo, {
    name: '日常储蓄卡', type: 'bank', currency: 'CNY', region: 'CN', now: NOW,
  })
  if (!acc.ok) throw new Error(acc.message)
  const cash = await createInstrument(repo, {
    name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', now: NOW,
  })
  if (!cash.ok) throw new Error(cash.message)
  return { account: acc.account, cash: cash.instrument }
}

/* ================================================================== *
 * 冷启动状态
 * ================================================================== */

describe('冷启动状态：为空库给出明确下一步', () => {
  it('空库 → 无账户、无标的、无持仓、不能记交易', async () => {
    const st = coldStartStateOf(await empty().loadPortfolio())
    expect(st).toEqual({
      noAccounts: true,
      noInstruments: true,
      noHoldings: true,
      canRecordTransaction: false,
    })
  })

  it('建好账户与标的 → 可以记交易', async () => {
    const repo = empty()
    await bootstrapStructure(repo)
    const st = coldStartStateOf(await repo.loadPortfolio())
    expect(st.noAccounts).toBe(false)
    expect(st.noInstruments).toBe(false)
    expect(st.canRecordTransaction).toBe(true)
  })
})

/* ================================================================== *
 * 账户
 * ================================================================== */

describe('创建账户', () => {
  it('【核心】空库能创建第一个账户（原先做不到）', async () => {
    const repo = empty()
    const r = await createAccount(repo, {
      name: '示例银行', type: 'bank', currency: 'CNY', region: 'CN', now: NOW,
    })
    expect(r.ok).toBe(true)
    const p = await repo.loadPortfolio()
    expect(p.accounts).toHaveLength(1)
    expect(p.accounts[0].name).toBe('示例银行')
    expect(p.accounts[0].isLiability).toBe(false)
    expect(p.accounts[0].createdAt).toBe(NOW().toISOString())
  })

  it('拒绝空名称 / 缺类型 / 缺币种', async () => {
    const repo = empty()
    expect((await createAccount(repo, { name: '  ', type: 'bank', currency: 'CNY' })).ok).toBe(false)
    expect((await createAccount(repo, { name: 'A', type: '' as never, currency: 'CNY' })).ok).toBe(false)
    expect((await createAccount(repo, { name: 'A', type: 'bank', currency: '' as never })).ok).toBe(false)
    expect((await repo.loadPortfolio()).accounts).toHaveLength(0)
  })

  it('同名同币种账户被拒绝（避免看着一样的两份）', async () => {
    const repo = empty()
    await createAccount(repo, { name: '示例银行', type: 'bank', currency: 'CNY', now: NOW })
    const dup = await createAccount(repo, { name: ' 示例银行 ', type: 'broker', currency: 'CNY', now: NOW })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.code).toBe('duplicate')
    expect((await repo.loadPortfolio()).accounts).toHaveLength(1)
  })

  it('同名但不同币种允许（是不同账户）', async () => {
    const repo = empty()
    await createAccount(repo, { name: '示例银行', type: 'bank', currency: 'CNY', now: NOW })
    const usd = await createAccount(repo, { name: '示例银行', type: 'bank', currency: 'USD', now: NOW })
    expect(usd.ok).toBe(true)
    expect((await repo.loadPortfolio()).accounts).toHaveLength(2)
  })

  it('可标记负债账户', async () => {
    const repo = empty()
    const r = await createAccount(repo, {
      name: '信用卡', type: 'bank', currency: 'CNY', isLiability: true, now: NOW,
    })
    expect(r.ok && r.account.isLiability).toBe(true)
  })
})

/* ================================================================== *
 * 标的
 * ================================================================== */

describe('创建标的：资产类别必须用户明确选择', () => {
  it('【核心】缺少 assetClass 时拒绝（绝不自动猜测）', async () => {
    const repo = empty()
    const r = await createInstrument(repo, {
      name: '某基金', instrumentType: 'fund', assetClass: '' as never, currency: 'CNY', now: NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('不会替你猜测')
    expect((await repo.loadPortfolio()).instruments).toHaveLength(0)
  })

  it('用户选择类别后直接记为「用户确认」（这不是自动分类）', async () => {
    const repo = empty()
    const r = await createInstrument(repo, {
      name: '某指数基金', instrumentType: 'fund', assetClass: 'equity', currency: 'CNY', now: NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.instrument.classificationStatus).toBe('confirmed')
      expect(r.instrument.classificationSource).toBe('user_confirmed')
    }
  })

  it('有代码时按「代码 + 币种」判重（大小写无关）', async () => {
    const repo = empty()
    await createInstrument(repo, {
      name: 'A', symbol: 'spy', instrumentType: 'etf', assetClass: 'equity', currency: 'USD', now: NOW,
    })
    const dup = await createInstrument(repo, {
      name: 'B', symbol: 'SPY', instrumentType: 'etf', assetClass: 'equity', currency: 'USD', now: NOW,
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.code).toBe('duplicate')
  })

  it('无代码时按「名称 + 币种」判重', async () => {
    const repo = empty()
    await createInstrument(repo, {
      name: '自住房', instrumentType: 'real_estate', assetClass: 'real_estate', currency: 'CNY', now: NOW,
    })
    const dup = await createInstrument(repo, {
      name: '自住房', instrumentType: 'real_estate', assetClass: 'real_estate', currency: 'CNY', now: NOW,
    })
    expect(dup.ok).toBe(false)
  })

  it('拒绝空名称与缺品类', async () => {
    const repo = empty()
    expect((await createInstrument(repo, { name: '', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY' })).ok).toBe(false)
    expect((await createInstrument(repo, { name: 'X', instrumentType: '' as never, assetClass: 'equity', currency: 'CNY' })).ok).toBe(false)
  })
})

/* ================================================================== *
 * 手动口径持仓
 * ================================================================== */

describe('创建手动口径持仓', () => {
  async function withStructure() {
    const repo = empty()
    const { account } = await bootstrapStructure(repo)
    const house = await createInstrument(repo, {
      name: '自住房', instrumentType: 'real_estate', assetClass: 'real_estate', currency: 'CNY', now: NOW,
    })
    if (!house.ok) throw new Error(house.message)
    return { repo, accountId: account.id, instrumentId: house.instrument.id }
  }

  it('【核心】manual 口径，不参与 Ledger 对账', async () => {
    const { repo, accountId, instrumentId } = await withStructure()
    const r = await createManualHolding(repo, { accountId, instrumentId, manualValue: 2_500_000, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.holding.valuationMode).toBe('manual')

    const p = await repo.loadPortfolio()
    // 手动持仓没有交易依据，但**不应**被对账判为不一致
    expect(reconcileHoldings(p).ok).toBe(true)
    expect(detectDuplicateHoldings(p).ok).toBe(true)
  })

  it('手动持仓计入总资产', async () => {
    const { repo, accountId, instrumentId } = await withStructure()
    await createManualHolding(repo, { accountId, instrumentId, manualValue: 2_500_000, now: NOW })
    const p = await repo.loadPortfolio()
    const totals = calculateTotals({ portfolio: p, fx: createFxTable([]), now: NOW().getTime() })
    expect(totals.totalAssets).toBe(2_500_000)
  })

  it('manual 持仓在 rebuild 中被原样保留（不被交易重建抹掉）', async () => {
    const { repo, accountId, instrumentId } = await withStructure()
    await createManualHolding(repo, { accountId, instrumentId, manualValue: 999, now: NOW })
    const p = await repo.loadPortfolio()
    const rebuilt = rebuildHoldingsFromTransactions(p)
    expect(rebuilt.blocked).toBeFalsy()
    const kept = rebuilt.holdings.find((h) => h.instrumentId === instrumentId)
    expect(kept?.valuationMode).toBe('manual')
    expect(kept?.manualValue).toBe(999)
  })

  it('【核心】引用不存在的账户 / 标的 → 拒绝（不创建悬空引用）', async () => {
    const { repo, instrumentId } = await withStructure()
    const badAcc = await createManualHolding(repo, {
      accountId: 'nope', instrumentId, manualValue: 1, now: NOW,
    })
    expect(badAcc.ok).toBe(false)
    if (!badAcc.ok) expect(badAcc.code).toBe('missing-reference')

    const badInst = await createManualHolding(repo, {
      accountId: (await repo.loadPortfolio()).accounts[0].id, instrumentId: 'nope', manualValue: 1, now: NOW,
    })
    expect(badInst.ok).toBe(false)
    expect((await repo.loadPortfolio()).holdings).toHaveLength(0)
  })

  it('金额必须 >= 0（负数拒绝；0 允许但需明确）', async () => {
    const { repo, accountId, instrumentId } = await withStructure()
    const neg = await createManualHolding(repo, { accountId, instrumentId, manualValue: -1, now: NOW })
    expect(neg.ok).toBe(false)
    const nan = await createManualHolding(repo, { accountId, instrumentId, manualValue: Number.NaN, now: NOW })
    expect(nan.ok).toBe(false)
    const zero = await createManualHolding(repo, { accountId, instrumentId, manualValue: 0, now: NOW })
    expect(zero.ok).toBe(true)
  })

  it('同一账户同一标的只能有一条持仓（拒绝重复持仓）', async () => {
    const { repo, accountId, instrumentId } = await withStructure()
    await createManualHolding(repo, { accountId, instrumentId, manualValue: 100, now: NOW })
    const dup = await createManualHolding(repo, { accountId, instrumentId, manualValue: 200, now: NOW })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.code).toBe('duplicate')
    expect((await repo.loadPortfolio()).holdings).toHaveLength(1)
  })
})

/* ================================================================== *
 * 完整冷启动链路
 * ================================================================== */

describe('完整冷启动链路：空库 → 可用', () => {
  it('建账户 → 建标的 → 建持仓 → 估值 → 分析，全链路可用', async () => {
    const repo = empty()
    expect(coldStartStateOf(await repo.loadPortfolio()).canRecordTransaction).toBe(false)

    const { account, cash } = await bootstrapStructure(repo)
    // 补一个投资标的与手动持仓
    const fund = await createInstrument(repo, {
      name: '某基金', instrumentType: 'fund', assetClass: 'equity', currency: 'CNY', now: NOW,
    })
    if (!fund.ok) throw new Error(fund.message)

    await createManualHolding(repo, {
      accountId: account.id, instrumentId: fund.instrument.id, manualValue: 50_000, now: NOW,
    })
    await createManualHolding(repo, {
      accountId: account.id, instrumentId: cash.id, manualValue: 10_000, now: NOW,
    })

    const p = await repo.loadPortfolio()
    const state = coldStartStateOf(p)
    expect(state.canRecordTransaction).toBe(true)
    expect(state.noHoldings).toBe(false)

    // 估值 + 分析链路
    const fx = createFxTable([])
    const results = p.holdings.map((h) => valuateHolding(h, p, { fx, now: NOW().getTime() }))
    const totals = calculateTotals({ portfolio: p, fx, now: NOW().getTime() })
    const analysis = deriveAnalysis({ portfolio: p, results, totals, now: NOW().getTime() })

    expect(totals.totalAssets).toBe(60_000)
    expect(analysis.reliableValueCny).toBe(60_000)
    // 现金与基金分属不同类别
    const classes = analysis.byAssetClass.map((b) => b.key).sort()
    expect(classes).toContain('cash')
    expect(classes).toContain('equity')
  })

  it('数据真正落库（IndexedDB）', async () => {
    const { repo, db } = await createPairedTestStore(`w7-create-${Date.now()}`)
    await bootstrapStructure(repo)
    const reloaded = await repo.loadPortfolio()
    expect(reloaded.accounts).toHaveLength(1)
    expect(reloaded.instruments).toHaveLength(1)
    await db.delete()
  })
})
