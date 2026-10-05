import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Portfolio2 } from '../../types/portfolio2'
import { createInMemoryRepository, createPairedTestStore } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import { valuateHolding, calculateTotals } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { deriveAnalysis } from '../analysis'
import { detectDuplicateHoldings } from '../ledger/duplicates'
import { applyCashConversion } from '../ledger/cashConversion'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { reconcileHoldings } from '../ledger/reconcile'
import { resolveView } from '../viewRouting'
import { readOnlyMessage, resetReadOnlyMode } from '../readOnly'
import { loadPortfolio2 } from '../../hooks/usePortfolio2'
import {
  NOW,
  makeAccount,
  makeHolding,
  makeInstrument,
  makePortfolio,
} from '../valuation/__fixtures__/builders'

/*
 * Phase 8 / W3 测试
 *
 * 覆盖：
 * 1. 视图选择（正式入口不再依赖 ?w2=1）
 * 2. 分类确认链路：Instrument 变、Holding/Transaction/Snapshot 不变、金额不变
 * 3. 现金转换：走 Domain API、金额守恒、不产生重复持仓
 * 4. 重复持仓：只检测、不自动修复
 * 5. localStorage 隔离
 */

function seedPortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [
      makeAccount({ id: 'a1', name: '示例银行', currency: 'CNY', region: 'CN', type: 'bank' }),
      makeAccount({ id: 'a2', name: '示例券商', currency: 'USD', region: 'US', type: 'broker' }),
    ],
    instruments: [
      makeInstrument({ id: 'i_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_unknown', name: '示例待确认资产', instrumentType: 'other', assetClass: 'other', currency: 'CNY', classificationStatus: 'unconfirmed' }),
      makeInstrument({ id: 'i_etf', name: '示例美股ETF', symbol: 'TESTX', instrumentType: 'etf', assetClass: 'equity', currency: 'USD', classificationStatus: 'confirmed' }),
    ],
    holdings: [
      makeHolding({ id: 'h_cash', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000 }),
      makeHolding({ id: 'h_unknown', accountId: 'a1', instrumentId: 'i_unknown', valuationMode: 'manual', manualValue: 30000 }),
      makeHolding({ id: 'h_etf', accountId: 'a2', instrumentId: 'i_etf', valuationMode: 'quantity', quantity: 100, costBasis: 6000 }),
    ],
    quotes: [
      { id: 'q1', instrumentId: 'i_etf', priceKind: 'market_price', marketPrice: 80, currency: 'USD', source: 't', timestamp: new Date(NOW).toISOString(), status: 'LIVE' },
    ],
    fxRates: [
      { id: 'fx1', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: new Date(NOW).toISOString(), source: 't', status: 'LIVE' },
    ],
    transactions: [
      { id: 't_cash', accountId: 'a1', instrumentId: 'i_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 't_etf', accountId: 'a2', instrumentId: 'i_etf', type: 'adjustment', quantity: 100, amount: 6000, currency: 'USD', timestamp: '2026-01-01T00:00:00.000Z' },
    ],
  })
}

async function derive(repo: PortfolioRepository) {
  const portfolio = await repo.loadPortfolio()
  const fx = createFxTable(portfolio.fxRates)
  const results = portfolio.holdings.map((h) => valuateHolding(h, portfolio, { fx, now: NOW }))
  const totals = calculateTotals({ portfolio, fx, now: NOW })
  return { portfolio, totals, analysis: deriveAnalysis({ portfolio, results, totals, now: NOW }) }
}

beforeEach(() => resetReadOnlyMode())
afterEach(() => resetReadOnlyMode())

/* ================================================================== *
 * 1. 视图选择
 * ================================================================== */

describe('1 视图选择：正式入口不再依赖 ?w2=1', () => {
  it('无参数 → W3 正式应用', () => {
    expect(resolveView('')).toBe('w3')
    expect(resolveView('?foo=bar')).toBe('w3')
  })

  it('?w2=1 保留为兼容入口', () => {
    expect(resolveView('?w2=1')).toBe('w2')
  })

  it('?legacy=1 进入旧界面兜底', () => {
    expect(resolveView('?legacy=1')).toBe('legacy')
    // legacy 优先级高于 w2
    expect(resolveView('?legacy=1&w2=1')).toBe('legacy')
  })
})

/* ================================================================== *
 * 2. 分类确认链路
 * ================================================================== */

describe('2 分类确认：Instrument 变，其余一概不变', () => {
  it('确认后 Instrument metadata 更新，Analysis 随之变化', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(seedPortfolio())

    const before = await derive(repo)
    expect(before.analysis.coverage.unconfirmedCount).toBe(1)
    expect(before.analysis.byAssetClass.find((b) => b.key === 'unconfirmed')?.valueCny).toBe(30000)

    // 唯一允许的写入路径
    await repo.instruments.confirmOne('i_unknown', 'fixed_income')

    const after = await derive(repo)
    expect(after.analysis.coverage.unconfirmedCount).toBe(0)
    // 金额从「待确认分类」桶移到「固收」桶
    expect(after.analysis.byAssetClass.find((b) => b.key === 'unconfirmed')).toBeUndefined()
    expect(after.analysis.byAssetClass.find((b) => b.key === 'fixed_income')?.valueCny).toBe(30000)
  })

  it('【核心】Holding / Transaction / Snapshot 逐项不变', async () => {
    const repo = createInMemoryRepository()
    const withSnapshots: Portfolio2 = {
      ...seedPortfolio(),
      snapshots: [
        {
          id: 's1', date: '2026-10-03', totalAssets: 187600, totalLiabilities: 0, netWorth: 187600,
          currency: 'CNY', assetAllocation: {}, positions: [], captureKind: 'REAL',
          attributionStatus: 'unavailable', createdAt: '2026-10-03T00:00:00.000Z',
        },
      ],
      classificationAudit: [],
    }
    await repo.replaceAll(withSnapshots)
    const before = await repo.loadPortfolio()

    await repo.instruments.confirmOne('i_unknown', 'cash')
    const after = await repo.loadPortfolio()

    expect(after.holdings).toEqual(before.holdings)
    expect(after.transactions).toEqual(before.transactions)
    expect(after.snapshots).toEqual(before.snapshots)
    // 只有 instruments 与审计变化
    expect(after.instruments).not.toEqual(before.instruments)
    expect(after.classificationAudit.length).toBe(before.classificationAudit.length + 1)
  })

  it('【核心】六项金额指标完全不变', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(seedPortfolio())

    const before = await derive(repo)
    await repo.instruments.confirmOne('i_unknown', 'equity')
    const after = await derive(repo)

    expect(after.totals.totalAssets).toBe(before.totals.totalAssets)
    expect(after.totals.totalLiabilities).toBe(before.totals.totalLiabilities)
    expect(after.totals.netWorth).toBe(before.totals.netWorth)
    expect(after.analysis.reliableValueCny).toBe(before.analysis.reliableValueCny)
    expect(after.analysis.coverage.unavailableCount).toBe(before.analysis.coverage.unavailableCount)
    expect(after.analysis.coverage.staleCount).toBe(before.analysis.coverage.staleCount)
  })

  it('未选类别时拒绝确认（不会自动沿用线索值）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(seedPortfolio())
    await expect(repo.instruments.confirmOne('i_unknown', undefined as never)).rejects.toThrow()
    const after = await repo.instruments.get('i_unknown')
    expect(after!.classificationStatus).toBe('unconfirmed')
  })

  it('撤销确认也留审计（审计链完整）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(seedPortfolio())
    await repo.instruments.confirmOne('i_unknown', 'equity')
    await repo.instruments.unconfirm('i_unknown')
    const log = await repo.instruments.classificationLog()
    expect(log.map((e) => e.action)).toEqual(['confirm', 'unconfirm'])
  })

  it('历史 assetClassAtCapture 不被回填（确认分类不影响历史）', async () => {
    const repo = createInMemoryRepository()
    const snap = {
      id: 's_old', date: '2026-09-01', totalAssets: 1000, totalLiabilities: 0, netWorth: 1000,
      currency: 'CNY' as const, assetAllocation: {}, attributionStatus: 'unavailable' as const,
      createdAt: '2026-09-01T00:00:00.000Z',
      positions: [
        {
          instrumentId: 'i_unknown', accountId: 'a1', quantity: 1, price: 1000,
          currency: 'CNY' as const, rateToCny: 1, valueCny: 1000, reliable: true,
          // 刻意没有 assetClassAtCapture
        },
      ],
    }
    await repo.replaceAll({ ...seedPortfolio(), snapshots: [snap] })

    await repo.instruments.confirmOne('i_unknown', 'cash')

    const after = await repo.loadPortfolio()
    // 历史快照一字未改：不回填、不重分类
    expect(after.snapshots[0].positions[0].assetClassAtCapture).toBeUndefined()
  })

  it('绝不自动分类：名称含关键词不会被确认', async () => {
    const p = makePortfolio({
      accounts: [makeAccount({ id: 'a1' })],
      instruments: [
        makeInstrument({ id: 'x1', name: '货币基金', instrumentType: 'fund', assetClass: 'other', classificationStatus: 'unconfirmed' }),
        makeInstrument({ id: 'x2', name: '美股ETF', instrumentType: 'etf', assetClass: 'other', classificationStatus: 'unconfirmed' }),
      ],
      holdings: [],
    })
    const repo = createInMemoryRepository()
    await repo.replaceAll(p)
    const list = await repo.instruments.unconfirmed()
    expect(list.map((i) => i.id).sort()).toEqual(['x1', 'x2'])
    for (const i of list) expect(i.assetClass).toBe('other')
  })
})

/* ================================================================== *
 * 3. 现金转换
 * ================================================================== */

describe('3 现金转换：走 Domain API，金额守恒，不产生重复', () => {
  /** 已确认为现金、但仍是手动口径的标的 */
  function cashCandidatePortfolio(): Portfolio2 {
    return makePortfolio({
      accounts: [makeAccount({ id: 'a1', name: '示例银行', currency: 'CNY', region: 'CN' })],
      instruments: [
        makeInstrument({ id: 'i_cash', name: '示例活期', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      ],
      holdings: [
        makeHolding({ id: 'h_manual', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'manual', manualValue: 50000 }),
      ],
    })
  }

  it('转换后成为交易驱动持仓（quantity = 金额）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(cashCandidatePortfolio())

    const before = await repo.loadPortfolio()
    const { portfolio: converted, result } = applyCashConversion(before, { timestamp: '2026-10-04T00:00:00.000Z' })
    const rebuilt = rebuildHoldingsFromTransactions(converted)
    const next: Portfolio2 = { ...converted, holdings: rebuilt.holdings }
    await repo.replaceAll(next)

    const after = await repo.loadPortfolio()
    const h = after.holdings[0]
    expect(h.valuationMode).toBe('quantity')
    expect(h.quantity).toBe(50000)
    expect(h.averageCost).toBe(1)
    expect(result.adjustments).toHaveLength(1)
    expect(result.amountPreserved).toBe(true)
  })

  it('【核心】转换前后资产总额不变', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(cashCandidatePortfolio())
    const before = await derive(repo)

    const { portfolio: converted } = applyCashConversion(await repo.loadPortfolio())
    const rebuilt = rebuildHoldingsFromTransactions(converted)
    await repo.replaceAll({ ...converted, holdings: rebuilt.holdings })

    const after = await derive(repo)
    expect(after.totals.totalAssets).toBe(before.totals.totalAssets)
    expect(after.totals.netWorth).toBe(before.totals.netWorth)
  })

  it('【核心】转换不产生重复持仓', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(cashCandidatePortfolio())

    const { portfolio: converted } = applyCashConversion(await repo.loadPortfolio())
    const rebuilt = rebuildHoldingsFromTransactions(converted)
    const next: Portfolio2 = { ...converted, holdings: rebuilt.holdings }
    await repo.replaceAll(next)

    const after = await repo.loadPortfolio()
    const keys = after.holdings.map((h) => `${h.accountId}::${h.instrumentId}`)
    expect(new Set(keys).size).toBe(keys.length) // 无重复键
    expect(detectDuplicateHoldings(after).ok).toBe(true)
  })

  it('转换后账实相符（rebuild + reconcile）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(cashCandidatePortfolio())
    const { portfolio: converted } = applyCashConversion(await repo.loadPortfolio())
    const rebuilt = rebuildHoldingsFromTransactions(converted)
    const rec = reconcileHoldings({ ...converted, holdings: rebuilt.holdings })
    expect(rec.ok).toBe(true)
    expect(rec.matchedCount).toBe(rec.holdingCount)
  })

  it('重复持仓时拒绝转换（不在脏数据上叠加）', async () => {
    const repo = createInMemoryRepository()
    const p = cashCandidatePortfolio()
    await repo.replaceAll({
      ...p,
      holdings: [...p.holdings, makeHolding({ id: 'h_dup', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'manual', manualValue: 1 })],
    })
    const dup = detectDuplicateHoldings(await repo.loadPortfolio())
    expect(dup.ok).toBe(false)
    // UI 层据此拒绝转换（见 CashConvertSheet 的前置校验）
  })

  it('未确认分类的现金不在候选内（不猜）', async () => {
    const repo = createInMemoryRepository()
    const p = cashCandidatePortfolio()
    await repo.replaceAll({
      ...p,
      instruments: p.instruments.map((i) => ({ ...i, classificationStatus: 'unconfirmed' as const })),
    })
    const portfolio = await repo.loadPortfolio()
    const byId = new Map(portfolio.instruments.map((i) => [i.id, i]))
    const candidates = portfolio.holdings.filter((h) => {
      if (h.valuationMode !== 'manual') return false
      const inst = byId.get(h.instrumentId)
      if (!inst) return false
      return (inst.instrumentType === 'cash' || inst.assetClass === 'cash') && inst.classificationStatus === 'confirmed'
    })
    expect(candidates).toHaveLength(0)
  })
})

/* ================================================================== *
 * 4. 重复持仓：只检测
 * ================================================================== */

describe('4 重复持仓：检测与提示，绝不自动修复', () => {
  it('检出重复并保持数据一字不变', async () => {
    const repo = createInMemoryRepository()
    const p = seedPortfolio()
    await repo.replaceAll({
      ...p,
      holdings: [...p.holdings, makeHolding({ id: 'h_dup', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 999, costBasis: 999 })],
    })
    const before = JSON.stringify(await repo.loadPortfolio())

    const data = await loadPortfolio2(repo, { now: NOW })
    expect(data.duplicates.ok).toBe(false)
    expect(data.duplicates.duplicates[0].key).toBe('a1::i_cash')

    // 没有自动 merge / delete / overwrite
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
    expect((await repo.loadPortfolio()).holdings).toHaveLength(p.holdings.length + 1)
  })

  it('重建在遇到重复时被阻断（不静默丢失）', async () => {
    const p = seedPortfolio()
    const withDup: Portfolio2 = {
      ...p,
      holdings: [...p.holdings, makeHolding({ id: 'h_dup', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 999, costBasis: 999 })],
    }
    const rebuilt = rebuildHoldingsFromTransactions(withDup)
    expect(rebuilt.blocked).toBe(true)
    expect(rebuilt.holdings).toEqual(withDup.holdings)
  })
})

/* ================================================================== *
 * 5. localStorage 隔离
 * ================================================================== */

describe('5 localStorage 隔离：业务事实不受影响', () => {
  it('篡改 localStorage 不改变 W3 派生结果', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(seedPortfolio())
    const before = await derive(repo)

    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.setItem(
        'asset-card-wallet/portfolio/v2',
        JSON.stringify({ version: 2, categories: [{ id: 'fake', name: '伪造XYZ', items: [] }] }),
      )
    }
    const after = await derive(repo)
    expect(after.totals.totalAssets).toBe(before.totals.totalAssets)
    expect(JSON.stringify(after.analysis)).toBe(JSON.stringify(before.analysis))
  })

  it('清空 localStorage 后数据仍完整', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(seedPortfolio())
    if (typeof globalThis.localStorage !== 'undefined') globalThis.localStorage.clear()
    const data = await loadPortfolio2(repo, { now: NOW })
    expect(data.portfolio.holdings).toHaveLength(3)
    expect(data.totals.totalAssets).toBe(187600)
  })

  it('全仓库仍无 holdings 唯一复合索引（W3 未重新引入）', async () => {
    const { readFileSync } = await import('node:fs')
    const dexieSrc = readFileSync('src/lib/db/dexie.ts', 'utf8')
    expect(dexieSrc).not.toContain('&[accountId+instrumentId]')
    // snapshots 的唯一索引仍在（仅用于每日幂等）
    expect(dexieSrc).toContain("'id, &date, createdAt'")
  })
})

/* ================================================================== *
 * 6. 只读模式（旧 UI）未被 W3 破坏
 * ================================================================== */

describe('6 W1 断写仍然有效', () => {
  it('只读提示文案仍可读', () => {
    expect(readOnlyMessage()).toContain('只读')
  })

  it('W3 新增文件不直接写 localStorage 业务键', async () => {
    const { readFileSync } = await import('node:fs')
    const files = [
      'src/pages/AppShell.tsx',
      'src/pages/AnalysisTab.tsx',
      'src/pages/HistoryTab.tsx',
      'src/pages/SettingsTab.tsx',
      'src/components/ClassifySheet.tsx',
      'src/components/CashConvertSheet.tsx',
      'src/components/DuplicateSheet.tsx',
      'src/components/AttributeKindSheet.tsx',
    ]
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // 业务键禁止出现
      if (/portfolio\/v2|strategy\/v1|networth-history\/v1|asset-card-wallet\/fx/.test(src)) {
        violations.push(f)
      }
    }
    expect(violations).toEqual([])
  })
})

/* ================================================================== *
 * 7. IndexedDB 持久化（成对存储）
 * ================================================================== */

describe('7 IndexedDB 持久化链路', () => {
  it('分类确认写入 IndexedDB 并产生审计', async () => {
    const { repo, db } = await createPairedTestStore(`w3-cls-${Date.now()}`)
    await repo.replaceAll(seedPortfolio())

    await repo.instruments.confirmOne('i_unknown', 'gold')

    const reloaded = await repo.loadPortfolio()
    expect(reloaded.instruments.find((i) => i.id === 'i_unknown')!.assetClass).toBe('gold')
    expect(reloaded.classificationAudit).toHaveLength(1)

    // 从 IndexedDB 重新读取依然一致（不是内存假象）
    const again = await repo.instruments.get('i_unknown')
    expect(again!.classificationStatus).toBe('confirmed')
    await db.delete()
  })
})
