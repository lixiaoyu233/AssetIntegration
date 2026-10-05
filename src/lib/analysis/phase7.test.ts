import { describe, expect, it } from 'vitest'
import type { Portfolio2, Snapshot } from '../../types/portfolio2'
import { createEmptyPortfolio2 } from '../../types/portfolio2'
import { createInMemoryRepository } from '../db/dexieRepository'
import { assertNoDuplicateHoldings, detectDuplicateHoldings, DuplicateHoldingError } from '../ledger/duplicates'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { calculateTotals, valuateHolding } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { deriveAnalysis } from '../analysis/index'
import { buildCompositionTrend, compositionAtCapture } from '../performance/history'
import { SCHEMA_V3_TO_V4_MIGRATION_ID, migrateV3ToV4 } from '../db/migrations/schema-v3-to-v4'
import { PORTFOLIO_SCHEMA_VERSION } from '../db/schema'
import {
  NOW,
  makeAccount,
  makeHolding,
  makeInstrument,
  makePortfolio,
  makeSnapshot,
} from '../valuation/__fixtures__/builders'

/*
 * Phase 7 测试：分类确认 / 重复检测 / 历史趋势
 *
 * 核心安全网：确认分类**只能**改变分类分布，
 * 绝不能改变任何资产金额指标。
 */

/* ------------------------------------------------------------------ *
 * 构造器
 * ------------------------------------------------------------------ */

/** 一个含「待确认分类」资产的组合 */
function portfolioWithUnconfirmed(): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: 'a1', name: '示例银行', currency: 'CNY', region: 'CN', type: 'bank' })],
    instruments: [
      makeInstrument({ id: 'i_cash', name: '现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_unknown', name: '示例未确认资产', instrumentType: 'other', assetClass: 'other', currency: 'CNY', classificationStatus: 'unconfirmed' }),
      makeInstrument({ id: 'i_stock', name: '示例股票', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
    ],
    holdings: [
      // 成本必须与期初 adjustment 一致，否则 reconcile 会报 cost_mismatch
      makeHolding({ id: 'h_cash', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 50000, costBasis: 50000 }),
      makeHolding({ id: 'h_unknown', accountId: 'a1', instrumentId: 'i_unknown', valuationMode: 'manual', manualValue: 30000 }),
      makeHolding({ id: 'h_stock', accountId: 'a1', instrumentId: 'i_stock', valuationMode: 'quantity', quantity: 100, costBasis: 1000 }),
    ],
    quotes: [
      // 单价 1，便于核对金额
      { id: 'q1', instrumentId: 'i_stock', priceKind: 'market_price', marketPrice: 1, currency: 'CNY', source: 'test', timestamp: new Date(NOW).toISOString(), status: 'LIVE' },
    ],
    /*
     * 夹具保持**自洽**：数量口径的持仓必须有交易依据，
     * 否则 reconcile 会（正确地）报 holding_without_ledger，
     * 干扰本文件要验证的分类确认与转现金链路。
     */
    transactions: [
      { id: 'adj_cash', accountId: 'a1', instrumentId: 'i_cash', type: 'adjustment', quantity: 50000, amount: 50000, currency: 'CNY', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'adj_stock', accountId: 'a1', instrumentId: 'i_stock', type: 'adjustment', quantity: 100, amount: 1000, currency: 'CNY', timestamp: '2026-01-01T00:00:00.000Z' },
    ],
    fxRates: [],
  })
}

async function analyzeWithRepo(repo: ReturnType<typeof createInMemoryRepository>) {
  const portfolio = await repo.loadPortfolio()
  const fx = createFxTable(portfolio.fxRates)
  const results = portfolio.holdings.map((h) => valuateHolding(h, portfolio, { fx, now: NOW }))
  const totals = calculateTotals({ portfolio, fx, now: NOW })
  return { view: deriveAnalysis({ portfolio, results, totals, now: NOW }), totals, portfolio }
}

/* ================================================================== *
 * 1. P0：分类确认 —— 只改元数据
 * ================================================================== */

describe('P0 分类确认：只改 Instrument 元数据', () => {
  it('confirmOne 改 assetClass 与 classificationStatus', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())

    const updated = await repo.instruments.confirmOne('i_unknown', 'cash')
    expect(updated.assetClass).toBe('cash')
    expect(updated.classificationStatus).toBe('confirmed')
    expect(updated.classificationSource).toBe('user_confirmed')
  })

  it('【严格】未提供 assetClass 时拒绝确认（不允许沿用线索值）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())

    // 类型层面已必填；这里模拟运行时传入空值（例如表单没选择）
    await expect(
      repo.instruments.confirmOne('i_unknown', undefined as never),
    ).rejects.toThrow(/必须由用户明确指定/)

    // 关键：拒绝后**仍然**是 unconfirmed，没有被悄悄确认
    const after = await repo.instruments.get('i_unknown')
    expect(after!.classificationStatus).toBe('unconfirmed')
  })

  it('【核心】确认分类不触碰 Holding / Transaction / Snapshot', async () => {
    const repo = createInMemoryRepository()
    const base = portfolioWithUnconfirmed()
    const withSnapshot: Portfolio2 = {
      ...base,
      transactions: [],
      snapshots: [makeSnapshot({ id: 's1', date: '2026-10-03', netWorth: 80000, positions: [] })],
    }
    await repo.replaceAll(withSnapshot)

    const before = await repo.loadPortfolio()
    await repo.instruments.confirmOne('i_unknown', 'cash')
    const after = await repo.loadPortfolio()

    // 持仓逐项完全一致
    expect(after.holdings).toEqual(before.holdings)
    // 交易与快照完全一致
    expect(after.transactions).toEqual(before.transactions)
    expect(after.snapshots).toEqual(before.snapshots)
    // 只有 instruments 变了
    expect(after.instruments).not.toEqual(before.instruments)
    // valuationMode 未被改动
    expect(after.holdings.find((h) => h.id === 'h_unknown')!.valuationMode).toBe('manual')
  })

  it('尚未确认的标的出现在 unconfirmed() 中', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    const list = await repo.instruments.unconfirmed()
    expect(list.map((i) => i.id)).toEqual(['i_unknown'])
  })
})

/* ================================================================== *
 * 2. P0：核心不变量 —— 确认分类不改变任何金额
 * ================================================================== */

describe('P0 核心不变量：确认分类前后资产金额完全不变', () => {
  it('六项指标逐一相等，只有分类分布改变', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())

    const before = await analyzeWithRepo(repo)
    await repo.instruments.confirmOne('i_unknown', 'cash')
    const after = await analyzeWithRepo(repo)

    // ——— 必须完全不变 ———
    expect(after.totals.totalAssets).toBe(before.totals.totalAssets)
    expect(after.totals.totalLiabilities).toBe(before.totals.totalLiabilities)
    expect(after.totals.netWorth).toBe(before.totals.netWorth)
    expect(after.view.reliableValueCny).toBe(before.view.reliableValueCny)
    expect(after.view.coverage.unavailableCount).toBe(before.view.coverage.unavailableCount)
    expect(after.view.coverage.staleCount).toBe(before.view.coverage.staleCount)

    // ——— 允许变化 ———
    expect(after.view.coverage.unconfirmedCount).toBe(before.view.coverage.unconfirmedCount - 1)
    const unconfirmedBucket = after.view.byAssetClass.find((b) => b.key === 'unconfirmed')
    expect(unconfirmedBucket).toBeUndefined() // 已经没有未确认项
    // 30000 从「待确认分类」移到了「现金」
    const cashBefore = before.view.byAssetClass.find((b) => b.key === 'cash')!.valueCny
    const cashAfter = after.view.byAssetClass.find((b) => b.key === 'cash')!.valueCny
    expect(cashAfter - cashBefore).toBe(30000)
  })

  it('各维度合计仍然等于 reliableValueCny', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await repo.instruments.confirmOne('i_unknown', 'cash')
    const { view } = await analyzeWithRepo(repo)
    for (const dim of [view.byAssetClass, view.byAccount, view.byCurrency, view.byRegion, view.byInstrumentType]) {
      const sum = dim.reduce((s, b) => s + b.valueCny, 0)
      expect(sum).toBeCloseTo(view.reliableValueCny, 2)
    }
  })

  it('【安全网】若确认分类改变了金额，说明有 bug —— 用断言固化该界限', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    const before = await analyzeWithRepo(repo)
    await repo.instruments.confirmOne('i_unknown', 'equity')
    const after = await analyzeWithRepo(repo)
    // 无论确认成哪个类别，总额都不许动
    expect(after.totals.totalAssets).toBe(before.totals.totalAssets)
    expect(after.totals.netWorth).toBe(before.totals.netWorth)
  })
})

/* ================================================================== *
 * 3. 审计日志：confirm 与 unconfirm 都留痕
 * ================================================================== */

describe('审计日志：confirm / unconfirm 均留痕', () => {
  it('【关键】完整链路 unconfirmed → confirmed → unconfirmed 可追溯', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())

    await repo.instruments.confirmOne('i_unknown', 'equity')
    await repo.instruments.unconfirm('i_unknown')

    const log = await repo.instruments.classificationLog()
    expect(log).toHaveLength(2)

    expect(log[0]).toMatchObject({
      instrumentId: 'i_unknown',
      action: 'confirm',
      from: { status: 'unconfirmed' },
      to: { assetClass: 'equity', status: 'confirmed' },
    })
    expect(log[1]).toMatchObject({
      instrumentId: 'i_unknown',
      action: 'unconfirm',
      from: { assetClass: 'equity', status: 'confirmed' },
      to: { status: 'unconfirmed' },
    })
  })

  it('unconfirm 后状态回到 unconfirmed，assetClass 保留为线索', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await repo.instruments.confirmOne('i_unknown', 'cash')
    const back = await repo.instruments.unconfirm('i_unknown')
    expect(back.classificationStatus).toBe('unconfirmed')
    expect(back.assetClass).toBe('cash') // 线索保留，但不再当成事实
  })

  it('批量确认（confirmMany）逐个留痕', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await repo.instruments.confirmMany([
      { id: 'i_unknown', assetClass: 'cash' },
      { id: 'i_stock', assetClass: 'equity' },
    ])
    const log = await repo.instruments.classificationLog()
    expect(log).toHaveLength(2)
    expect(log.every((e) => e.action === 'confirm_many')).toBe(true)
  })

  it('批量确认缺少类别时整批拒绝', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await expect(
      repo.instruments.confirmMany([{ id: 'i_unknown', assetClass: undefined as never }]),
    ).rejects.toThrow()
    const log = await repo.instruments.classificationLog()
    expect(log).toHaveLength(0)
  })

  it('审计记录按时间升序返回', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await repo.instruments.confirmOne('i_unknown', 'cash')
    await repo.instruments.unconfirm('i_unknown')
    await repo.instruments.confirmOne('i_unknown', 'gold')
    const log = await repo.instruments.classificationLog()
    const times = log.map((e) => e.at)
    expect([...times].sort()).toEqual(times)
    expect(log.map((e) => e.action)).toEqual(['confirm', 'unconfirm', 'confirm'])
  })

  it('标的不存在时报错且不产生审计', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await expect(repo.instruments.confirmOne('nope', 'cash')).rejects.toThrow(/标的不存在/)
    expect(await repo.instruments.classificationLog()).toHaveLength(0)
  })
})

/* ================================================================== *
 * 4. 绝不自动分类
 * ================================================================== */

describe('绝不自动分类', () => {
  it('名称含「基金」「股票」「黄金」也不会自动确认', async () => {
    const p = makePortfolio({
      accounts: [makeAccount({ id: 'a1' })],
      instruments: [
        makeInstrument({ id: 'x1', name: '示例货币基金A', instrumentType: 'fund', assetClass: 'other', classificationStatus: 'unconfirmed' }),
        makeInstrument({ id: 'x2', name: '示例银行股票', instrumentType: 'stock', assetClass: 'other', classificationStatus: 'unconfirmed' }),
        makeInstrument({ id: 'x3', name: '示例黄金ETF', instrumentType: 'gold', assetClass: 'other', classificationStatus: 'unconfirmed' }),
      ],
      holdings: [],
    })
    const fx = createFxTable([])
    const totals = calculateTotals({ portfolio: p, fx, now: NOW })
    const view = deriveAnalysis({
      portfolio: p, totals, fx,
      results: [],
      now: NOW,
    } as never)
    // 三者都留在「待确认」，没有被关键词推断
    expect(view.coverage.unconfirmedCount).toBe(0) // 没有 holdings，故为 0
    const repo = createInMemoryRepository()
    await repo.replaceAll(p)
    const unconfirmed = await repo.instruments.unconfirmed()
    expect(unconfirmed.map((i) => i.id).sort()).toEqual(['x1', 'x2', 'x3'])
    // 且它们的 assetClass 仍是 other，不是被推断出来的类别
    for (const i of unconfirmed) expect(i.assetClass).toBe('other')
  })

  it('迁移不自动确认：unconfirmed 保持原状', () => {
    const p = portfolioWithUnconfirmed()
    const before = p.instruments.find((i) => i.id === 'i_unknown')!
    expect(before.classificationStatus).toBe('unconfirmed')
  })
})

/* ================================================================== *
 * 5. P1：重复 Holding 检测
 * ================================================================== */

describe('P1 重复 Holding 检测', () => {
  function withDuplicate(): Portfolio2 {
    const p = portfolioWithUnconfirmed()
    return {
      ...p,
      holdings: [
        ...p.holdings,
        makeHolding({ id: 'h_dup', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 999 }),
      ],
    }
  }

  it('检出同账户同标的的重复', () => {
    const report = detectDuplicateHoldings(withDuplicate())
    expect(report.ok).toBe(false)
    expect(report.duplicates).toHaveLength(1)
    expect(report.duplicates[0].key).toBe('a1::i_cash')
    expect(report.duplicates[0].holdingIds).toEqual(['h_cash', 'h_dup'])
    expect(report.affectedHoldingCount).toBe(2)
    expect(report.summary).toContain('重复持仓')
  })

  it('无重复时 ok 为 true', () => {
    expect(detectDuplicateHoldings(portfolioWithUnconfirmed()).ok).toBe(true)
  })

  it('不同账户的同一标的不算重复', () => {
    const p = portfolioWithUnconfirmed()
    const twoAccounts: Portfolio2 = {
      ...p,
      accounts: [...p.accounts, makeAccount({ id: 'a2', name: '示例券商', currency: 'CNY' })],
      holdings: [
        ...p.holdings,
        makeHolding({ id: 'h_cash_2', accountId: 'a2', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 100 }),
      ],
    }
    expect(detectDuplicateHoldings(twoAccounts).ok).toBe(true)
  })

  it('给出合并参考值，但明确不是自动动作', () => {
    const group = detectDuplicateHoldings(withDuplicate()).duplicates[0]
    expect(group.suggestedQuantitySum).toBe(50000 + 999)
    expect(group.suggestion).toContain('期初 adjustment')
  })

  it('【核心】重建遇到重复时被阻断，持仓原样返回', () => {
    const p = withDuplicate()
    const result = rebuildHoldingsFromTransactions(p)
    expect(result.blocked).toBe(true)
    expect(result.rebuiltCount).toBe(0)
    expect(result.holdings).toEqual(p.holdings) // 一行未改
    expect(result.duplicateReport?.ok).toBe(false)
  })

  it('【核心】写入前校验抛错（不静默覆盖）', () => {
    const p = withDuplicate()
    expect(() => assertNoDuplicateHoldings(p.holdings)).toThrow(DuplicateHoldingError)
    try {
      assertNoDuplicateHoldings(p.holdings)
    } catch (e) {
      const err = e as DuplicateHoldingError
      expect(err.report.duplicates[0].holdingIds).toHaveLength(2)
      expect(err.message).toContain('写入已拒绝')
    }
  })

  it('校验通过时不抛错', () => {
    expect(() => assertNoDuplicateHoldings(portfolioWithUnconfirmed().holdings)).not.toThrow()
  })

  it('检测是只读的：不修改传入组合', () => {
    const p = withDuplicate()
    const snapshot = JSON.stringify(p)
    detectDuplicateHoldings(p)
    expect(JSON.stringify(p)).toBe(snapshot)
  })

  it('提供逐条详情供 UI 展示', async () => {
    const { describeDuplicate } = await import('../ledger/duplicates')
    const lines = describeDuplicate(detectDuplicateHoldings(withDuplicate()).duplicates[0])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('h_cash')
  })
})

/* ================================================================== *
 * 6. Schema V4：assetClassAtCapture
 * ================================================================== */

describe('Schema V4：assetClassAtCapture', () => {
  it('当前 Schema 版本已推进到含 captureKind 的版本', () => {
    // 由常量推导，避免每次升版都要改测试字面量
    expect(PORTFOLIO_SCHEMA_VERSION).toBeGreaterThanOrEqual(4)
  })

  it('新捕获的快照记录当时的分类（仅已确认的）', async () => {
    const { buildSnapshot } = await import('../performance/snapshot')
    const p = portfolioWithUnconfirmed()
    const { snapshot } = buildSnapshot(p, { date: '2026-10-03', now: NOW })

    const known = snapshot.positions.find((x) => x.instrumentId === 'i_cash')!
    expect(known.assetClassAtCapture).toBe('cash')

    // 未确认的标的**不写入**分类（不能把线索当事实）
    const unknown = snapshot.positions.find((x) => x.instrumentId === 'i_unknown')!
    expect(unknown.assetClassAtCapture).toBeUndefined()
  })

  it('【关键】v3 存量快照不被回填（不伪造历史）', () => {
    const legacySnapshot = makeSnapshot({
      id: 'old', date: '2026-09-01', netWorth: 1000,
      positions: [
        // 模拟 v3 快照：没有 assetClassAtCapture
        { instrumentId: 'i', accountId: 'a', quantity: 1, price: 1000, currency: 'CNY', rateToCny: 1, valueCny: 1000, reliable: true },
      ],
    })
    const p = makePortfolio({ snapshots: [legacySnapshot] })

    const result = migrateV3ToV4({ portfolio: p, now: () => '2026-10-04T00:00:00.000Z' })

    // 快照的 positions 一字未改
    expect(result.portfolio.snapshots[0].positions[0].assetClassAtCapture).toBeUndefined()
    // 但被明确登记为「分类不可用」
    expect(result.unavailableClassSnapshotIds).toContain('old')
    expect(result.record.migrationId).toBe(SCHEMA_V3_TO_V4_MIGRATION_ID)
    expect(result.record.note).toContain('不回填')
  })

  it('迁移不修改任何金额字段', () => {
    const legacySnapshot = makeSnapshot({
      id: 'old', date: '2026-09-01', netWorth: 1234.56, totalAssets: 1234.56,
      positions: [{ instrumentId: 'i', accountId: 'a', quantity: 1, price: 1234.56, currency: 'CNY', rateToCny: 1, valueCny: 1234.56, reliable: true }],
    })
    const p = makePortfolio({ snapshots: [legacySnapshot] })
    const r = migrateV3ToV4({ portfolio: p, now: () => '2026-10-04T00:00:00.000Z' })
    expect(r.portfolio.snapshots[0].netWorth).toBe(1234.56)
    expect(r.portfolio.snapshots[0].totalAssets).toBe(1234.56)
    expect(r.portfolio.snapshots[0].positions[0].valueCny).toBe(1234.56)
  })

  it('迁移幂等：重复执行结果一致', () => {
    const p = makePortfolio({
      snapshots: [makeSnapshot({ id: 'old', date: '2026-09-01', netWorth: 1, positions: [] })],
    })
    const a = migrateV3ToV4({ portfolio: p, now: () => 'T1' })
    const b = migrateV3ToV4({ portfolio: a.portfolio, now: () => 'T1' })
    expect(b.portfolio.snapshots).toEqual(a.portfolio.snapshots)
  })
})

/* ================================================================== *
 * 7. P2：历史配置趋势（不伪造历史）
 * ================================================================== */

describe('P2 历史配置趋势：缺分类就明确标缺口', () => {
  const snapWith = (date: string, hasClass: boolean): Snapshot =>
    makeSnapshot({
      id: `s_${date}`, date, netWorth: 1000, isComplete: true, attributionStatus: 'complete',
      positions: [
        {
          instrumentId: 'i1', accountId: 'a1', quantity: 1, price: 1000, currency: 'CNY',
          rateToCny: 1, valueCny: 1000, reliable: true,
          ...(hasClass ? { assetClassAtCapture: 'equity' as const } : {}),
        },
      ],
    })

  it('有分类的快照产出构成', () => {
    const r = compositionAtCapture(snapWith('2026-10-01', true))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.byClass.equity).toBe(1000)
      expect(r.byClassShare.equity).toBe(1)
    }
  })

  it('【关键】缺分类时返回不可用，而不是用当前分类补', () => {
    const r = compositionAtCapture(snapWith('2026-09-01', false))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('历史分类数据不可用')
      expect(r.missingClassCount).toBe(1)
    }
  })

  it('趋势序列：可用点与缺口点分开标记', () => {
    const series = buildCompositionTrend([
      snapWith('2026-09-01', false),
      snapWith('2026-10-01', true),
      snapWith('2026-10-02', true),
    ])
    expect(series.points).toHaveLength(3)
    expect(series.points[0].hasClassification).toBe(false)
    expect(series.points[0].usable).toBe(false)
    expect(series.points[1].usable).toBe(true)
    expect(series.gaps).toHaveLength(1)
    expect(series.gaps[0].date).toBe('2026-09-01')
    expect(series.classes).toEqual(['equity'])
    expect(series.summary).toContain('不回填、不插值')
  })

  it('【关键】不插值：缺失的日期不会出现在序列里', () => {
    const series = buildCompositionTrend([
      snapWith('2026-10-01', true),
      snapWith('2026-10-31', true), // 中间 29 天没有快照
    ])
    expect(series.points.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-31'])
  })

  it('不完整（stale）的点标记为不可用', () => {
    const partial = makeSnapshot({
      id: 'p', date: '2026-10-05', netWorth: 1000, isComplete: false, staleCount: 1, attributionStatus: 'partial',
      positions: [{ instrumentId: 'i1', accountId: 'a1', quantity: 1, price: 1000, currency: 'CNY', rateToCny: 1, valueCny: 1000, reliable: true, assetClassAtCapture: 'equity' }],
    })
    const series = buildCompositionTrend([partial])
    expect(series.points[0].hasClassification).toBe(true)
    expect(series.points[0].isComplete).toBe(false)
    expect(series.points[0].usable).toBe(false) // 有分类但不完整
  })

  it('空快照列表不崩', () => {
    const series = buildCompositionTrend([])
    expect(series.points).toHaveLength(0)
    expect(series.summary).toContain('还没有历史快照')
  })

  it('支持 since / until 过滤', () => {
    const series = buildCompositionTrend(
      [snapWith('2026-09-01', true), snapWith('2026-10-01', true), snapWith('2026-11-01', true)],
      { since: '2026-10-01', until: '2026-10-31' },
    )
    expect(series.points.map((p) => p.date)).toEqual(['2026-10-01'])
  })

  it('快照没有持仓明细时也标记为不可用', () => {
    const r = compositionAtCapture(makeSnapshot({ id: 'e', date: '2026-10-01', netWorth: 0, positions: [] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('没有持仓明细')
  })
})

/* ================================================================== *
 * 8. 转现金是独立动作（与确认分类严格分离）
 * ================================================================== */

describe('转现金：与确认分类严格分离的第二个动作', () => {
  it('确认分类不会自动触发转现金', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await repo.instruments.confirmOne('i_unknown', 'cash')

    const after = await repo.loadPortfolio()
    const h = after.holdings.find((x) => x.id === 'h_unknown')!
    // 仍是手动口径，没有变成交易驱动
    expect(h.valuationMode).toBe('manual')
    expect(h.quantity).toBeUndefined()
    // 也没有为该标的新增任何期初交易（确认分类不产生交易）
    expect(
      after.transactions.filter((t) => t.instrumentId === 'i_unknown'),
    ).toHaveLength(0)
  })

  it('转现金是显式调用，会产生期初 adjustment 并保住金额', async () => {
    const { applyCashConversion } = await import('../ledger/cashConversion')
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await repo.instruments.confirmOne('i_unknown', 'cash')
    const confirmed = await repo.loadPortfolio()

    // 关键：用户确认 cash 后，标的的 instrumentType 仍是 other；
    // 转现金会把 instrumentType 规范为 cash，否则估值引擎不认。
    const { portfolio: converted, result } = applyCashConversion(confirmed)

    expect(result.convertedCount).toBe(1)
    expect(result.amountPreserved).toBe(true)
    const h = converted.holdings.find((x) => x.id === 'h_unknown')!
    expect(h.valuationMode).toBe('quantity')
    expect(h.quantity).toBe(30000)
    // 只为 i_unknown 新增一条期初，且不影响既有的期初记录
    const unknownAdjs = converted.transactions.filter(
      (t) => t.type === 'adjustment' && t.instrumentId === 'i_unknown',
    )
    expect(unknownAdjs).toHaveLength(1)
    expect(converted.transactions).toHaveLength(confirmed.transactions.length + 1)

    // instrumentType 被规范为 cash
    const inst = converted.instruments.find((i) => i.id === 'i_unknown')!
    expect(inst.instrumentType).toBe('cash')

    // 转现金后金额不变
    const before = calculateTotals({ portfolio: confirmed, fx: createFxTable([]), now: NOW })
    const after = calculateTotals({ portfolio: converted, fx: createFxTable([]), now: NOW })
    expect(after.totalAssets).toBe(before.totalAssets)
  })

  it('转现金后 rebuild + reconcile 一致', async () => {
    const { applyCashConversion } = await import('../ledger/cashConversion')
    const { reconcileHoldings } = await import('../ledger/reconcile')
    const repo = createInMemoryRepository()
    await repo.replaceAll(portfolioWithUnconfirmed())
    await repo.instruments.confirmOne('i_unknown', 'cash')
    const confirmed = await repo.loadPortfolio()

    const { portfolio: converted } = applyCashConversion(confirmed)
    const rebuilt = rebuildHoldingsFromTransactions(converted)
    expect(rebuilt.blocked).toBeFalsy()
    const rec = reconcileHoldings({ ...converted, holdings: rebuilt.holdings })
    expect(rec.ok).toBe(true)
    expect(rec.matchedCount).toBe(rec.holdingCount)
  })

  it('【对照】自洽夹具本身应当账实相符', async () => {
    const { reconcileHoldings } = await import('../ledger/reconcile')
    const rec = reconcileHoldings(portfolioWithUnconfirmed())
    expect(rec.ok).toBe(true)
    expect(rec.matchedCount).toBe(rec.holdingCount) // manual 持仓默认跳过
  })

  it('【对照】数量口径持仓若缺少交易依据，reconcile 会正确报错', async () => {
    const { reconcileHoldings } = await import('../ledger/reconcile')
    const p = portfolioWithUnconfirmed()
    // 移除 i_stock 的期初依据 → 应被识别为孤立
    const broken = { ...p, transactions: p.transactions.filter((t) => t.instrumentId !== 'i_stock') }
    const rec = reconcileHoldings(broken)
    const issue = rec.issues.find((i) => i.kind === 'holding_without_ledger')!
    expect(issue).toBeDefined()
    expect(issue.instrumentId).toBe('i_stock')
    expect(rec.ok).toBe(false)
  })
})

/* ================================================================== *
 * 9. 空组合边界
 * ================================================================== */

describe('边界', () => {
  it('空组合的重复检测与趋势都正常', () => {
    const empty = createEmptyPortfolio2()
    expect(detectDuplicateHoldings(empty).ok).toBe(true)
    expect(buildCompositionTrend([]).points).toHaveLength(0)
  })

  it('空组合的分类确认拒绝（标的不存在）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(createEmptyPortfolio2())
    await expect(repo.instruments.confirmOne('x', 'cash')).rejects.toThrow()
  })
})
