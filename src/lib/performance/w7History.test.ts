import { describe, expect, it } from 'vitest'
import { createInMemoryRepository } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import {
  buildSnapshot,
  captureRange,
  captureSnapshot,
  localDate,
  previousDate,
} from './snapshot'
import { ensureDailySnapshot } from './dailySnapshot'
import { attribute, openingGapDays } from './attribution'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { Portfolio2 } from '../../types/portfolio2'

/*
 * Phase 8 / W7 — P0-9 止血与日期语义
 *
 * 覆盖 W7 审计发现的两个 P0：
 *   P0-9：opening 间隔异常时把「整个期间的收益」写成「当日收益」
 *   P0-8：快照日期用 UTC 导致本地清晨被判「昨天已有快照」而整天不捕获
 */

const T0 = '2026-10-01T10:00:00.000Z'

function simplePortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: 'a1', name: '示例账户', currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({
        id: 'i_cash', name: '人民币现金', instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed',
      }),
    ],
    holdings: [
      makeHolding({
        id: 'h_cash', accountId: 'a1', instrumentId: 'i_cash',
        valuationMode: 'quantity', quantity: 100000, costBasis: 100000,
      }),
    ],
    transactions: [
      { id: 't1', accountId: 'a1', instrumentId: 'i_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: T0 },
    ],
  })
}

async function seed(): Promise<PortfolioRepository> {
  const repo = createInMemoryRepository()
  const p = simplePortfolio()
  await repo.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })
  return repo
}

/* ================================================================== *
 * P0-9：opening 间隔检测
 * ================================================================== */

describe('P0-9 止血：opening 间隔异常必须结构化降级', () => {
  it('openingGapDays 正确计算间隔', () => {
    expect(openingGapDays({ date: '2026-10-03' }, '2026-10-04')).toBe(1)
    expect(openingGapDays({ date: '2026-10-01' }, '2026-10-04')).toBe(3)
    expect(openingGapDays({ date: '2026-10-04' }, '2026-10-04')).toBe(0)
    // 日期缺失 → 无法判断（不因「不知道」而拒绝计算）
    expect(openingGapDays({}, '2026-10-04')).toBeUndefined()
    expect(openingGapDays({ date: '2026-10-03' }, undefined)).toBeUndefined()
  })

  it('【核心】间隔 > 1 天时不计算投资收益（金额一律 undefined）', () => {
    const opening = {
      id: 's0', date: '2026-10-01', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000,
      currency: 'CNY' as const, assetAllocation: {}, attributionStatus: 'complete' as const,
      createdAt: T0, positions: [],
    }
    const ending = {
      id: 's1', date: '2026-10-04', totalAssets: 105000, totalLiabilities: 0, netWorth: 105000,
      currency: 'CNY' as const, assetAllocation: {}, attributionStatus: 'complete' as const,
      createdAt: T0, positions: [],
    }
    const flow = { externalInflow: 0, externalOutflow: 0, classified: [], unconvertible: [], feeTotal: 0, internalTransferCount: 0 }

    const r = attribute({
      opening,
      ending,
      flow: flow as never,
      options: { date: '2026-10-04' },
    })

    expect(r.status).toBe('unavailable')
    // 【核心】不得把 3 天的 5000 元当成「当天收益」
    expect(r.investmentReturn).toBeUndefined()
    expect(r.openingNetWorth).toBeUndefined()
    expect(r.residual).toBeUndefined()
    expect(r.notes.join(' ')).toContain('相隔 3 天')
  })

  it('间隔恰好 1 天 → 正常计算', () => {
    const mk = (date: string, nw: number) => ({
      id: `s-${date}`, date, totalAssets: nw, totalLiabilities: 0, netWorth: nw,
      currency: 'CNY' as const, assetAllocation: {}, attributionStatus: 'complete' as const,
      createdAt: T0, positions: [],
    })
    const flow = { externalInflow: 0, externalOutflow: 0, classified: [], unconvertible: [], feeTotal: 0, internalTransferCount: 0 }
    const r = attribute({
      opening: mk('2026-10-03', 100000) as never,
      ending: mk('2026-10-04', 105000) as never,
      flow: flow as never,
      options: { date: '2026-10-04' },
    })
    // 间隔正常 → 照常计算（状态可能是 partial：这里手工构造的 flow 与净资产变化
    // 不完全吻合，残差会触发 partial，属预期，不影响本次要验证的结论）
    expect(r.investmentReturn).toBe(5000)
    expect(r.status).not.toBe('unavailable')
  })

  it('不传 date 时保持原行为（不因缺少信息而拒绝）', () => {
    const mk = (date: string, nw: number) => ({
      id: `s-${date}`, date, totalAssets: nw, totalLiabilities: 0, netWorth: nw,
      currency: 'CNY' as const, assetAllocation: {}, attributionStatus: 'complete' as const,
      createdAt: T0, positions: [],
    })
    const flow = { externalInflow: 0, externalOutflow: 0, classified: [], unconvertible: [], feeTotal: 0, internalTransferCount: 0 }
    const r = attribute({
      opening: mk('2026-01-01', 100000) as never,
      ending: mk('2026-10-04', 105000) as never,
      flow: flow as never,
    })
    // 未提供 date → 无法判断间隔 → 照常计算（向后兼容）
    expect(r.investmentReturn).toBe(5000)
  })

  it('【核心】buildSnapshot 端到端：缺日时 investmentReturn 为 undefined', () => {
    const p = simplePortfolio()
    // 期初快照是 5 天前（模拟多日未打开 / 刚迁移完）
    const opening = {
      id: 's-old', date: '2026-09-29', totalAssets: 90000, totalLiabilities: 0, netWorth: 90000,
      currency: 'CNY' as const, assetAllocation: {}, attributionStatus: 'complete' as const,
      createdAt: T0, positions: [],
    }
    const { snapshot } = buildSnapshot(p, { date: '2026-10-04', opening, now: Date.parse('2026-10-04T10:00:00Z') })

    expect(snapshot.attributionStatus).toBe('unavailable')
    expect(snapshot.investmentReturn).toBeUndefined()
    // 不得写 0 冒充
    expect(snapshot.investmentReturn).not.toBe(0)
    expect(snapshot.attributionNotes?.join(' ')).toContain('相隔 5 天')
  })
})

/* ================================================================== *
 * P0-8：本地日语义
 * ================================================================== */

describe('P0-8 止血：快照日期使用本地日', () => {
  it('localDate 返回本地日而非 UTC 日', () => {
    // 本地时间 2026-10-05 07:00 时，UTC 可能还是 10-04
    const local = new Date(2026, 9, 5, 7, 0, 0)
    expect(localDate(local)).toBe('2026-10-05')
    // 与 UTC 日对比（仅当本地偏移为正时才不同，这里只断言格式与自身一致）
    expect(localDate(local)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('localDate 在本地日末尾仍返回当天', () => {
    expect(localDate(new Date(2026, 9, 5, 23, 59, 59))).toBe('2026-10-05')
  })

  it('localDate 补零正确', () => {
    expect(localDate(new Date(2026, 0, 3, 12, 0, 0))).toBe('2026-01-03')
  })

  it('【核心】捕获的 date 与传入的本地日一致（不再被 UTC 偏移改写）', async () => {
    const repo = await seed()
    const today = localDate()
    const r = await captureSnapshot(repo, { date: today })
    expect(r.snapshot.date).toBe(today)
  })

  it('previousDate 仍按日推进（期初选取依赖它）', () => {
    expect(previousDate('2026-10-04')).toBe('2026-10-03')
    expect(previousDate('2026-03-01')).toBe('2026-02-28')
  })
})

/* ================================================================== *
 * captureRange：禁止过去日期（防伪造历史）
 * ================================================================== */

describe('captureRange：W7 起禁止对过去日期补录', () => {
  it('【核心】过去日期 → 明确抛错，不产出假历史', async () => {
    const repo = await seed()
    await expect(captureRange(repo, '2020-01-01', '2020-01-03')).rejects.toThrow(/只支持今天/)
    // 抛错后不留下任何快照
    expect(await repo.snapshots.count()).toBe(0)
  })

  it('区间起点在过去也拒绝（不部分执行）', async () => {
    const repo = await seed()
    const today = localDate()
    await expect(captureRange(repo, '2020-01-01', today)).rejects.toThrow(/只支持今天/)
    expect(await repo.snapshots.count()).toBe(0)
  })
})

/* ================================================================== *
 * 当日刷新不破坏历史
 * ================================================================== */

describe('当日刷新：只影响今天，历史一动不动', () => {
  it('历史快照内容与 id 完全不变', async () => {
    const repo = await seed()
    const past = await captureSnapshot(repo, { date: '2026-09-01', now: Date.parse('2026-09-01T10:00:00Z') })
    const pastJson = JSON.stringify(past.snapshot)

    // 触发今天的捕获
    await ensureDailySnapshot(repo, { date: localDate(), now: Date.now() })

    const stored = await repo.snapshots.byDate('2026-09-01')
    expect(JSON.stringify(stored)).toBe(pastJson)
  })
})
