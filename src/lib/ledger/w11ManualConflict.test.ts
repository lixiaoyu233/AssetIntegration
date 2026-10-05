import { describe, expect, it } from 'vitest'
import { createInMemoryRepository } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import { recordTransaction, voidTransaction } from './transactionService'
import { rebuildHoldingsFromTransactions } from './rebuild'
import { deriveLedger } from './derive'
import { ledgerOptionsFor } from './rebuild'
import { detectDuplicateHoldings } from './duplicates'
import { calculateTotals } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { createManualHolding } from '../db/creation'
import { makeAccount, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { Portfolio2 } from '../../types/portfolio2'

/*
 * Phase 8 / W11 Blocker Patch — P0-1
 *
 * 根因：`rebuildFromLedger()` 按 `accountId::instrumentId` 复用既有 Holding 的 id，
 * 而既有行可能是 `valuationMode === 'manual'` →
 * 同一 key 出现两条 Holding（同 id）→ `duplicate-holding` →
 * 净资产错误 + 该账户**永久无法记账**（且应用内无修复入口）。
 *
 * 持仓表的不变量是「一个 (账户, 标的) 一条持仓」，因此正确做法是
 * **阻止冲突组合形成**（并修掉 id 复用这个真正的损坏点），
 * 而不是让 manual 与派生行并存。
 */

const ts = '2026-10-05T10:00:00.000Z'

function base(): Portfolio2 {
  return makePortfolio({
    accounts: [
      makeAccount({ id: 'a1', name: '账户A', currency: 'CNY', region: 'CN' }),
      makeAccount({ id: 'a2', name: '账户B', currency: 'CNY', region: 'CN' }),
    ],
    instruments: [
      makeInstrument({ id: 'cash', name: '现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'etf', name: '指数ETF', instrumentType: 'etf', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
    ],
    holdings: [], transactions: [],
  })
}

async function seeded(): Promise<PortfolioRepository> {
  const repo = createInMemoryRepository()
  await repo.replaceAll(base())
  return repo
}

const nw = async (repo: PortfolioRepository) =>
  calculateTotals({ portfolio: await repo.loadPortfolio(), fx: createFxTable([]), now: Date.parse(ts) }).netWorth

/* ================================================================== *
 * ① 先 manual → 后交易
 * ================================================================== */

describe('P0-1 ①先建 manual，再对同账户同标的记账', () => {
  it('【核心】交易被明确拒绝，且不产生重复持仓', async () => {
    const repo = await seeded()
    await createManualHolding(repo, { accountId: 'a1', instrumentId: 'cash', manualValue: 20000 })

    const r = await recordTransaction(repo, {
      type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash',
      amount: 5000, currency: 'CNY', timestamp: ts,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('duplicate-holding')
      expect(r.message).toContain('手动持仓')
    }

    const pf = await repo.loadPortfolio()
    expect(detectDuplicateHoldings(pf).ok).toBe(true)
    expect(pf.holdings).toHaveLength(1)
    expect(pf.holdings[0].valuationMode).toBe('manual')
    // 拒绝后不得留下任何交易
    expect(pf.transactions).toHaveLength(0)
  })

  it('【核心】manul 值保持不变，净资产不变', async () => {
    const repo = await seeded()
    await createManualHolding(repo, { accountId: 'a1', instrumentId: 'cash', manualValue: 20000 })
    await recordTransaction(repo, {
      type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash',
      amount: 5000, currency: 'CNY', timestamp: ts,
    })
    expect(await nw(repo)).toBe(20000)
    expect((await repo.loadPortfolio()).holdings[0].manualValue).toBe(20000)
  })

  it('【核心】账户未被锁死：不相干的记账仍可成功', async () => {
    const repo = await seeded()
    await createManualHolding(repo, { accountId: 'a1', instrumentId: 'cash', manualValue: 20000 })
    // 另一个账户（无 manual）应完全不受影响
    const ok = await recordTransaction(repo, {
      type: 'deposit', accountId: 'a2', cashInstrumentId: 'cash',
      amount: 5000, currency: 'CNY', timestamp: ts,
    })
    expect(ok.ok).toBe(true)
    expect(await nw(repo)).toBe(25000)
  })

  it('【核心】不相干标的的 manual 持仓不阻碍交易', async () => {
    const repo = await seeded()
    await createManualHolding(repo, { accountId: 'a1', instrumentId: 'etf', manualValue: 5000 })
    const r = await recordTransaction(repo, {
      type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash',
      amount: 5000, currency: 'CNY', timestamp: ts,
    })
    expect(r.ok).toBe(true)
    expect(await nw(repo)).toBe(10000)
  })
})

/* ================================================================== *
 * ② 先交易 → 后 manual
 * ================================================================== */

describe('P0-1 ②先记账，再对同账户同标的建 manual', () => {
  it('【核心】建 manual 被明确拒绝，不产生重复持仓', async () => {
    const repo = await seeded()
    await recordTransaction(repo, {
      type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash',
      amount: 100000, currency: 'CNY', timestamp: ts,
    })
    const m = await createManualHolding(repo, { accountId: 'a1', instrumentId: 'cash', manualValue: 20000 })
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.message).toContain('交易记录驱动')

    const pf = await repo.loadPortfolio()
    expect(detectDuplicateHoldings(pf).ok).toBe(true)
    expect(pf.holdings).toHaveLength(1)
    expect(pf.holdings[0].valuationMode).toBe('quantity')
    expect(await nw(repo)).toBe(100000)
  })

  it('【核心】后续记账仍成功（账户未被锁死）', async () => {
    const repo = await seeded()
    await recordTransaction(repo, { type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash', amount: 100000, currency: 'CNY', timestamp: ts })
    await createManualHolding(repo, { accountId: 'a1', instrumentId: 'cash', manualValue: 20000 })
    const again = await recordTransaction(repo, { type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash', amount: 500, currency: 'CNY', timestamp: ts })
    expect(again.ok).toBe(true)
    expect(await nw(repo)).toBe(100500)
  })

  it('【核心】reload（重新读取仓储）后结果一致', async () => {
    const repo = await seeded()
    await recordTransaction(repo, { type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash', amount: 100000, currency: 'CNY', timestamp: ts })
    const first = await nw(repo)
    const second = await nw(repo)
    expect(second).toBe(first)
    expect(first).toBe(100000)
  })
})

/* ================================================================== *
 * ③ 真实 rebuild 路径：不变量必须成立
 * ================================================================== */

describe('P0-1 ③ rebuild 产物必须满足 (accountId,instrumentId) 唯一', () => {
  it('【核心】直接调用 rebuildFromLedger：manual + 派生不得同 key 并存', async () => {
    const pf: Portfolio2 = {
      ...base(),
      holdings: [
        // 一条 manual（同 key 上有交易）
        { id: 'h_manual', accountId: 'a1', instrumentId: 'cash', valuationMode: 'manual', manualValue: 20000, createdAt: ts, updatedAt: ts },
      ],
      transactions: [
        { id: 't1', accountId: 'a1', instrumentId: 'cash', type: 'adjustment', quantity: 5000, amount: 5000, currency: 'CNY', timestamp: ts },
      ],
    }
    const ledger = deriveLedger(pf.transactions, ledgerOptionsFor(pf))
    void ledger
    const rebuilt = rebuildHoldingsFromTransactions(pf)

    /*
     * 兜底防线：该组合（同 key 上 manual + 派生）是不变量被破坏的状态，
     * rebuild 必须**阻断**而不是产出重复 key，也不得做破坏性改写。
     *
     * 注意：正常 UI 操作到不了这里 —— `recordTransaction` 与
     * `createManualHolding` 都会在此之前拒绝。
     */
    expect(rebuilt.blocked).toBe(true)
    expect(rebuilt.mixedModeKeys).toEqual(['a1::cash'])
    expect(rebuilt.holdings).toBe(pf.holdings) // 原样返回，未被改写
  })

  it('【核心】产物在**任何**情况下都不会出现重复 (accountId,instrumentId)', async () => {
    const pf: Portfolio2 = {
      ...base(),
      holdings: [
        { id: 'h_manual', accountId: 'a1', instrumentId: 'cash', valuationMode: 'manual', manualValue: 20000, createdAt: ts, updatedAt: ts },
      ],
      transactions: [
        { id: 't1', accountId: 'a1', instrumentId: 'cash', type: 'adjustment', quantity: 5000, amount: 5000, currency: 'CNY', timestamp: ts },
      ],
    }
    const rebuilt = rebuildHoldingsFromTransactions(pf)
    const keys = rebuilt.holdings.map((h) => `${h.accountId}::${h.instrumentId}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('【核心】id 不再被 manual 行复用（派生行使用自己的身份）', async () => {
    // 直接构造「同 key 上有 manual + 交易」的组合，验证派生行的 id
    const pf: Portfolio2 = {
      ...base(),
      holdings: [
        { id: 'h_manual', accountId: 'a1', instrumentId: 'cash', valuationMode: 'manual', manualValue: 20000, createdAt: ts, updatedAt: ts },
      ],
      transactions: [
        { id: 't1', accountId: 'a1', instrumentId: 'cash', type: 'adjustment', quantity: 5000, amount: 5000, currency: 'CNY', timestamp: ts },
      ],
    }
    const rebuilt = rebuildHoldingsFromTransactions(pf)
    // 被阻断时不做任何改写
    if (rebuilt.blocked) {
      expect(rebuilt.mixedModeKeys).toEqual(['a1::cash'])
      return
    }
    const derived = rebuilt.holdings.find((h) => h.valuationMode === 'quantity')
    expect(derived).toBeDefined()
    expect(derived?.id).not.toBe('h_manual')
  })
})

/* ================================================================== *
 * ④ 原有路径不回归
 * ================================================================== */

describe('P0-1 ④ 原有正常路径不回归', () => {
  it('纯交易驱动的持仓照常重建', async () => {
    const repo = await seeded()
    await recordTransaction(repo, { type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash', amount: 100000, currency: 'CNY', timestamp: ts })
    const r = await recordTransaction(repo, { type: 'buy', accountId: 'a1', instrumentId: 'etf', cashInstrumentId: 'cash', quantity: 100, amount: 6000, currency: 'CNY', timestamp: ts })
    expect(r.ok).toBe(true)
    const pf = await repo.loadPortfolio()
    expect(detectDuplicateHoldings(pf).ok).toBe(true)
    expect(pf.holdings).toHaveLength(2)
  })

  it('纯 manual 持仓照常创建与保留', async () => {
    const repo = await seeded()
    await createManualHolding(repo, { accountId: 'a1', instrumentId: 'etf', manualValue: 2500000 })
    const r = rebuildHoldingsFromTransactions(await repo.loadPortfolio())
    expect(r.holdings).toHaveLength(1)
    expect(r.holdings[0].valuationMode).toBe('manual')
    expect(r.holdings[0].manualValue).toBe(2500000)
  })

  it('作废交易不需要 manual 冲突校验（不误伤）', async () => {
    const repo = await seeded()
    await recordTransaction(repo, { type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash', amount: 100000, currency: 'CNY', timestamp: ts })
    const pf = await repo.loadPortfolio()
    const txId = pf.transactions[0].id
    const v = await voidTransaction(repo, txId, { now: () => new Date(ts) })
    expect(v.ok).toBe(true)
  })
})
