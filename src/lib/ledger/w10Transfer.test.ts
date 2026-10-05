import { describe, expect, it } from 'vitest'
import { createInMemoryRepository } from '../db/dexieRepository'
import { recordTransaction } from './transactionService'
import { makeAccount, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { PortfolioRepository } from '../db/repository'

/*
 * Phase 8 / W10-Patch — P0-1：划转数量映射
 *
 * 原缺陷：表单把「划转数量」写进 `quantity`，而领域层的部分划转字段是
 * `transferQuantity`。`applyTransfer` 读不到它 → `moveQty = before` → **整仓搬走**。
 * 实测曾是：填 20000 → 源=0 / 目标=100000（金额被忽略）。
 */

const TS = '2026-10-05T10:00:00.000Z'

async function seeded(): Promise<PortfolioRepository> {
  const repo = createInMemoryRepository()
  await repo.replaceAll(makePortfolio({
    accounts: [
      makeAccount({ id: 'a1', name: '源', currency: 'CNY', region: 'CN' }),
      makeAccount({ id: 'a2', name: '目标', currency: 'CNY', region: 'CN' }),
    ],
    instruments: [
      makeInstrument({
        id: 'cash', name: '现金', instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed',
      }),
    ],
    holdings: [], transactions: [],
  }))
  await recordTransaction(repo, {
    type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash',
    amount: 100000, currency: 'CNY', timestamp: TS,
  })
  return repo
}

const balance = async (repo: PortfolioRepository, accountId: string): Promise<number> => {
  const pf = await repo.loadPortfolio()
  return pf.holdings.find((h) => h.accountId === accountId)?.quantity ?? 0
}

describe('P0-1 划转：部分 / 整仓必须可区分', () => {
  it('【核心】划转 20000 → 源=80000、目标=20000', async () => {
    const repo = await seeded()
    const r = await recordTransaction(repo, {
      type: 'transfer', accountId: 'a1', toAccountId: 'a2', instrumentId: 'cash',
      // 表单修复后提交的形态：数量进入 transferQuantity
      transferQuantity: 20000, amount: 20000, currency: 'CNY', timestamp: TS,
    })
    expect(r.ok).toBe(true)
    expect(await balance(repo, 'a1')).toBe(80000)
    expect(await balance(repo, 'a2')).toBe(20000)
  })

  it('【核心】只有**显式**整仓（不传 transferQuantity）才源=0、目标=100000', async () => {
    const repo = await seeded()
    const r = await recordTransaction(repo, {
      type: 'transfer', accountId: 'a1', toAccountId: 'a2', instrumentId: 'cash',
      amount: 100000, currency: 'CNY', timestamp: TS,
    })
    expect(r.ok).toBe(true)
    expect(await balance(repo, 'a1')).toBe(0)
    expect(await balance(repo, 'a2')).toBe(100000)
  })

  it('【核心】填了数量就不会被解释成整仓（回归原缺陷）', async () => {
    const repo = await seeded()
    await recordTransaction(repo, {
      type: 'transfer', accountId: 'a1', toAccountId: 'a2', instrumentId: 'cash',
      transferQuantity: 20000,
      // 即使同时带着 quantity（旧表单行为），也**不得**整仓搬走
      quantity: 20000, amount: 20000, currency: 'CNY', timestamp: TS,
    } as never)
    expect(await balance(repo, 'a1')).toBe(80000)
    expect(await balance(repo, 'a2')).toBe(20000)
  })

  it('【核心】reload（重新读取仓储）后结果一致', async () => {
    const repo = await seeded()
    await recordTransaction(repo, {
      type: 'transfer', accountId: 'a1', toAccountId: 'a2', instrumentId: 'cash',
      transferQuantity: 20000, amount: 20000, currency: 'CNY', timestamp: TS,
    })
    const first = [await balance(repo, 'a1'), await balance(repo, 'a2')]
    const second = [await balance(repo, 'a1'), await balance(repo, 'a2')]
    expect(second).toEqual(first)
    expect(first).toEqual([80000, 20000])
  })

  it('【核心】资产守恒：两端之和不变', async () => {
    const repo = await seeded()
    await recordTransaction(repo, {
      type: 'transfer', accountId: 'a1', toAccountId: 'a2', instrumentId: 'cash',
      transferQuantity: 20000, amount: 20000, currency: 'CNY', timestamp: TS,
    })
    expect((await balance(repo, 'a1')) + (await balance(repo, 'a2'))).toBe(100000)
  })

  it('部分划转不会产生负数', async () => {
    const repo = await seeded()
    await recordTransaction(repo, {
      type: 'transfer', accountId: 'a1', toAccountId: 'a2', instrumentId: 'cash',
      transferQuantity: 999999, amount: 999999, currency: 'CNY', timestamp: TS,
    })
    const a1 = await balance(repo, 'a1')
    const pf = await repo.loadPortfolio()
    for (const h of pf.holdings) expect(h.quantity ?? 0).toBeGreaterThanOrEqual(0)
    void a1
  })
})
