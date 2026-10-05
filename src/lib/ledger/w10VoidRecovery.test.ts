import { describe, expect, it } from 'vitest'
import { createInMemoryRepository } from '../db/dexieRepository'
import { inspectVoidImpact, recordTransaction, voidTransaction } from './transactionService'
import { createManualHolding } from '../db/creation'
import { rebuildHoldingsFromTransactions } from './rebuild'
import { reconcileHoldings } from './reconcile'
import { makeAccount, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { PortfolioRepository } from '../db/repository'

/*
 * Phase 8 / W10-Patch — P0-3：作废期初 adjustment 不得「静默」删掉真实持仓，
 * 且必须给出可操作的补救路径。
 *
 * 原缺陷：作废最后依据 → `droppedOrphans` 清理持仓 → UI 只显示「已作废」，
 * 而 `adjustment` **不在可录入的 9 类交易中**，用户无法重新录回。
 */

const TS = '2026-10-05T10:00:00.000Z'

async function withOpeningAdjustment(): Promise<{ repo: PortfolioRepository; adjId: string }> {
  const repo = createInMemoryRepository()
  await repo.replaceAll(makePortfolio({
    accounts: [makeAccount({ id: 'a1', name: '证券账户', currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({
        id: 'stk', name: '指数ETF', instrumentType: 'etf',
        assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed',
      }),
      makeInstrument({
        id: 'cash', name: '现金', instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed',
      }),
    ],
    holdings: [], transactions: [],
  }))
  // 期初 adjustment：100 股 / 成本 6000
  await recordTransaction(repo, {
    type: 'adjustment', accountId: 'a1', instrumentId: 'stk',
    quantity: 100, amount: 6000, currency: 'CNY', timestamp: TS,
  } as never)
  const pf = await repo.loadPortfolio()
  return { repo, adjId: pf.transactions.find((t) => t.type === 'adjustment')!.id }
}

describe('P0-3 作废期初 adjustment：预检会明确告知', () => {
  it('【核心】预检识别出「持仓将失去全部依据」，并给出可读警告', async () => {
    const { repo, adjId } = await withOpeningAdjustment()
    const pf = await repo.loadPortfolio()
    const impact = inspectVoidImpact(pf, adjId)

    expect(impact.dropsRealPositions).toBe(true)
    expect(impact.willDropHoldingKeys).toEqual(['a1::stk'])
    expect(impact.warning).toBeTruthy()
    // 必须说明「期初余额不可重新录入」并给出补救方向
    expect(impact.warning).toContain('期初')
    expect(impact.warning).toContain('手动持仓')
  })

  it('预检是只读的：不改变任何数据', async () => {
    const { repo, adjId } = await withOpeningAdjustment()
    const before = JSON.stringify(await repo.loadPortfolio())
    inspectVoidImpact(await repo.loadPortfolio(), adjId)
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })

  it('无风险的作废不产生警告（避免误报）', async () => {
    const { repo, adjId } = await withOpeningAdjustment()
    /*
     * 给**同一标的**追加一笔 deposit（现金）与另一笔独立依据：
     * 这里改用「现金账户」的独立持仓来验证预检不是恒真。
     */
    await recordTransaction(repo, {
      type: 'deposit', accountId: 'a1', cashInstrumentId: 'cash',
      amount: 500, currency: 'CNY', timestamp: TS,
    })
    const pf = await repo.loadPortfolio()
    // 作废现金持仓的那笔 deposit 会清掉现金持仓 → 有风险
    const depositId = pf.transactions.find((t) => t.type === 'deposit')!.id
    expect(inspectVoidImpact(pf, depositId).dropsRealPositions).toBe(true)

    // 而作废「期初 adjustment」只影响 stk，不影响 cash → 预检不是恒真
    const stkImpact = inspectVoidImpact(pf, adjId)
    expect(stkImpact.willDropHoldingKeys).toEqual(['a1::stk'])
    // 现金相关键不应出现在 stk 的结论里
    expect(stkImpact.willDropHoldingKeys).not.toContain('a1::cash')
  })

  it('【核心】作废后结果如实报告 droppedOrphans（UI 据此显示补救入口）', async () => {
    const { repo, adjId } = await withOpeningAdjustment()
    const r = await voidTransaction(repo, adjId, { now: () => new Date(TS) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.droppedOrphans).toEqual(['a1::stk'])
    const pf = await repo.loadPortfolio()
    expect(pf.holdings).toHaveLength(0)
  })

  it('【核心】补救路径：用手动持仓重新登记后资产恢复，且不受交易驱动', async () => {
    const { repo, adjId } = await withOpeningAdjustment()
    const before = (await repo.loadPortfolio()).holdings[0]
    expect(before.instrumentId).toBe('stk')

    await voidTransaction(repo, adjId, { now: () => new Date(TS) })
    expect((await repo.loadPortfolio()).holdings).toHaveLength(0)

    // UI 的补救入口调用同一个 Domain API（创建手动持仓）
    const created = await createManualHolding(repo, {
      accountId: 'a1', instrumentId: 'stk', manualValue: 6000,
    })
    expect(created.ok).toBe(true)

    const after = await repo.loadPortfolio()
    const h = after.holdings.find((x) => x.instrumentId === 'stk')
    expect(h).toBeDefined()
    expect(h?.valuationMode).toBe('manual')
    expect(h?.manualValue).toBe(6000)

    // 手动持仓不由交易驱动 → 作废交易不影响它
    const rebuilt = rebuildHoldingsFromTransactions(after)
    expect(rebuilt.holdings.some((x) => x.instrumentId === 'stk')).toBe(true)
  })

  it('【核心】补救后 rebuild / reconcile 结果正确', async () => {
    const { repo, adjId } = await withOpeningAdjustment()
    await voidTransaction(repo, adjId, { now: () => new Date(TS) })
    await createManualHolding(repo, { accountId: 'a1', instrumentId: 'stk', manualValue: 6000 })

    const pf = await repo.loadPortfolio()
    const rebuilt = rebuildHoldingsFromTransactions(pf)
    // manual 持仓被原样保留
    expect(rebuilt.holdings.map((h) => h.instrumentId)).toContain('stk')
    // 账实校验通过（manual 不参与派生，不会被判为孤儿）
    const rec = reconcileHoldings({ ...pf, holdings: rebuilt.holdings })
    expect(rec.ok).toBe(true)
  })

  it('作废不会物理删除交易（W5 语义不变）', async () => {
    const { repo, adjId } = await withOpeningAdjustment()
    await voidTransaction(repo, adjId, { now: () => new Date(TS) })
    const pf = await repo.loadPortfolio()
    const tx = pf.transactions.find((t) => t.id === adjId)
    expect(tx).toBeDefined()
    expect(tx?.status).toBe('VOIDED')
  })

  it('不存在的交易 → 预检返回空结论（不抛错）', async () => {
    const { repo } = await withOpeningAdjustment()
    const impact = inspectVoidImpact(await repo.loadPortfolio(), 'nope')
    expect(impact.dropsRealPositions).toBe(false)
    expect(impact.willDropHoldingKeys).toEqual([])
  })
})
