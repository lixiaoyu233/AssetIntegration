import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Portfolio2 } from '../../types/portfolio2'
import { createEmptyPortfolio2 } from '../../types/portfolio2'
import { createInMemoryRepository, createPairedTestStore } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import { calculateTotals, valuateHolding } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { deriveAnalysis, checkDimensions } from '../analysis'
import {
  ATTEMPT_RETENTION_DAYS,
  describeDailySnapshot,
  ensureDailySnapshot,
  pruneOldAttempts,
  readSnapshotAttempt,
  snapshotAttemptKey,
} from '../performance/dailySnapshot'
import { buildCompositionTrend, compositionAtCapture, snapshotCaptureKind } from '../performance/history'
import { loadPortfolio2 } from '../../hooks/usePortfolio2'
import { resetReadOnlyMode } from '../readOnly'
import {
  NOW,
  makeAccount,
  makeHolding,
  makeInstrument,
  makePortfolio,
  makeQuote,
  makeSnapshot,
} from '../valuation/__fixtures__/builders'
import { localDate } from './snapshot'

/*
 * W8 起 `captureSnapshot` 只允许创建**本地今天**的快照（过去/未来都拒绝），
 * 因为估值使用当前持仓 + 最新行情 + 当前汇率，没有 as-of 能力。
 *
 * 因此测试日期必须与 `NOW` 落在**同一个本地日**：
 *   D0 = NOW 的本地日（= 今天）→ 允许捕获
 *   D1 = 次日                  → 用于「次日可重试」场景
 */
const D0 = localDate(new Date(NOW))
const D1 = localDate(new Date(NOW + 86_400_000))

/*
 * Phase 8 / W2 测试
 *
 * A. 首页指标（totalAssets / liabilities / netWorth / coverage / 不可用不当 0）
 * B. AnalysisView 守恒（每持仓一次、assetClass/account 守恒、currency、region）
 * C. 历史（captureKind 区分、UNKNOWN 不当 REAL、不回填历史分类）
 * D. 每日快照（幂等、崩溃恢复、失败不重试、次日可重试、失败不阻塞）
 * E. 单一事实源
 */

/* ------------------------------------------------------------------ *
 * 构造器
 * ------------------------------------------------------------------ */

/** 含「可靠 / 过期 / 无法估值 / 未确认分类」四类持仓的组合 */
function mixedPortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [
      makeAccount({ id: 'a_cn', name: '示例内地银行', currency: 'CNY', region: 'CN', type: 'bank' }),
      makeAccount({ id: 'a_hk', name: '示例香港券商', currency: 'HKD', region: 'HK', type: 'broker' }),
    ],
    instruments: [
      makeInstrument({ id: 'i_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_etf', name: '示例美股 ETF', instrumentType: 'etf', assetClass: 'equity', currency: 'USD', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_gold', name: '示例黄金', instrumentType: 'gold', assetClass: 'gold', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_unknown', name: '示例待确认资产', instrumentType: 'other', assetClass: 'other', currency: 'CNY', classificationStatus: 'unconfirmed' }),
      makeInstrument({ id: 'i_noquote', name: '示例无行情标的', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
    ],
    holdings: [
      makeHolding({ id: 'h_cash', accountId: 'a_cn', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000 }),
      makeHolding({ id: 'h_etf', accountId: 'a_hk', instrumentId: 'i_etf', valuationMode: 'quantity', quantity: 100, costBasis: 6000 }),
      // 黄金：无行情 → unavailable
      makeHolding({ id: 'h_gold', accountId: 'a_cn', instrumentId: 'i_gold', valuationMode: 'quantity', quantity: 50, costBasis: 20000 }),
      // 未确认分类但可估值
      makeHolding({ id: 'h_unknown', accountId: 'a_cn', instrumentId: 'i_unknown', valuationMode: 'manual', manualValue: 30000 }),
      // 无行情 → unavailable
      makeHolding({ id: 'h_noquote', accountId: 'a_cn', instrumentId: 'i_noquote', valuationMode: 'quantity', quantity: 10, costBasis: 500 }),
    ],
    quotes: [
      makeQuote({ id: 'q_etf', instrumentId: 'i_etf', marketPrice: 80, currency: 'USD', status: 'LIVE', timestamp: new Date(NOW).toISOString() }),
    ],
    fxRates: [
      { id: 'fx_usd', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: new Date(NOW).toISOString(), source: 't', status: 'LIVE' },
    ],
  })
}

async function seed(repo: PortfolioRepository) {
  await repo.replaceAll(mixedPortfolio())
}

function analyzeOf(portfolio: Portfolio2, now = NOW) {
  const fx = createFxTable(portfolio.fxRates)
  const results = portfolio.holdings.map((h) => valuateHolding(h, portfolio, { fx, now }))
  const totals = calculateTotals({ portfolio, fx, now })
  return { results, totals, analysis: deriveAnalysis({ portfolio, results, totals, now }) }
}

beforeEach(() => resetReadOnlyMode())
afterEach(() => resetReadOnlyMode())

/* ================================================================== *
 * A. 首页指标
 * ================================================================== */

describe('A 首页：指标与完整性', () => {
  it('totalAssets / liabilities / netWorth / coverage 正确且互相自洽', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })

    // 现金 100000 + ETF 100×80×7.2 = 57600 + 未确认 30000
    expect(data.totals.totalAssets).toBe(187600)
    expect(data.totals.totalLiabilities).toBe(0)
    expect(data.totals.netWorth).toBe(187600)

    // 黄金与无行情标的不可估值
    expect(data.totals.unavailableCount).toBe(2)
    expect(data.totals.staleCount).toBe(0)
    expect(data.totals.reliableCount).toBe(3)

    // coverage 与估值引擎一致
    expect(data.analysis.coverage.reliableValueCny).toBe(data.totals.totalAssets)
    expect(data.analysis.coverage.unavailableCount).toBe(2)
    expect(data.analysis.coverage.unconfirmedCount).toBe(1)
    expect(data.analysis.coverage.isComplete).toBe(false)
  })

  it('【关键】unavailable 不被当成 0 计入任何金额', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })

    // 黄金 50×??? 与无行情标的 10×??? 都没有行情 →
    // 若被当 0，总额会等于「可靠部分」；但我们验证的是它们不贡献金额且被计数
    const { analysis, totals } = data
    expect(analysis.reliableValueCny).toBe(totals.totalAssets)

    // 这些持仓在行里 status 为 unavailable，且 valueCny 为 undefined
    const unavailableRows = analysis.rows.filter((r) => r.status === 'unavailable')
    expect(unavailableRows).toHaveLength(2)
    for (const r of unavailableRows) expect(r.valueCny).toBeUndefined()

    // 维度合计仍等于可靠金额（未把不可估值项算进去）
    expect(checkDimensions(analysis).ok).toBe(true)
  })

  it('stale 有旧值但不计入可靠金额，且有独立计数', async () => {
    const p = mixedPortfolio()
    const oldTs = new Date(NOW - 10 * 3600 * 1000).toISOString()
    const stalePortfolio: Portfolio2 = {
      ...p,
      quotes: [{ ...p.quotes[0], timestamp: oldTs }],
      fxRates: p.fxRates.map((f) => ({ ...f, timestamp: oldTs })),
    }
    const { totals, analysis } = analyzeOf(stalePortfolio)

    expect(totals.staleCount).toBeGreaterThan(0)
    expect(analysis.coverage.staleCount).toBe(totals.staleCount)
    const staleRows = analysis.rows.filter((r) => r.status === 'stale')
    for (const r of staleRows) expect(r.valueCny).toBeUndefined()
    expect(checkDimensions(analysis).ok).toBe(true)
  })

  it('unconfirmed 有估值 → 计入金额，且与 unavailable 不互斥', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })

    const unknownRow = data.analysis.rows.find((r) => r.holdingId === 'h_unknown')!
    expect(unknownRow.classConfirmed).toBe(false)
    expect(unknownRow.status).toBe('ok')
    expect(unknownRow.valueCny).toBe(30000)
    // 分类未知但价值计入
    expect(data.totals.totalAssets).toBeGreaterThanOrEqual(30000)
    // 进入「待确认分类」桶
    expect(data.analysis.byAssetClass.some((b) => b.key === 'unconfirmed')).toBe(true)
  })

  it('空组合不崩，且 coverage 合理', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(createEmptyPortfolio2())
    const data = await loadPortfolio2(repo, { now: NOW })
    expect(data.totals.totalAssets).toBe(0)
    expect(data.analysis.rows).toHaveLength(0)
    expect(data.analysis.coverage.coverageRatio).toBe(1)
  })
})

/* ================================================================== *
 * B. AnalysisView 守恒
 * ================================================================== */

describe('B AnalysisView：切分守恒', () => {
  it('每个 Holding 在根集合中恰好出现一次', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })
    expect(data.analysis.rows).toHaveLength(data.portfolio.holdings.length)
    const ids = data.analysis.rows.map((r) => r.holdingId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('assetClass 与 account 维度守恒', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })
    const check = checkDimensions(data.analysis)
    expect(check.ok).toBe(true)
    for (const c of check.checks) expect(c.sum).toBeCloseTo(data.analysis.reliableValueCny, 2)
  })

  it('currency 维度：原币与 CNY 折算都正确', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })

    const usd = data.analysis.byCurrency.find((b) => b.key === 'USD')!
    // ETF 100 股 × 80 USD = 8000 USD
    expect(usd.nativeTotal).toBe(8000)
    expect(usd.valueCny).toBeCloseTo(57600, 2)
    expect(usd.nativeCurrency).toBe('USD')

    const cnyBucket = data.analysis.byCurrency.find((b) => b.key === 'CNY')!
    // 现金 100000 + 未确认 30000（黄金无行情，不计入金额但原币仍有值）
    expect(cnyBucket.valueCny).toBe(130000)
  })

  it('region 维度使用 Account.region（不猜市场）', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })

    const hk = data.analysis.byRegion.find((b) => b.key === 'HK')!
    // 香港账户持有的美股 ETF 仍归 HK
    expect(hk.valueCny).toBeCloseTo(57600, 2)
    const cn = data.analysis.byRegion.find((b) => b.key === 'CN')!
    expect(cn.valueCny).toBe(130000)
  })

  it('unconfirmed 不被自动分类（留在 unconfirmed 桶）', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })
    const bucket = data.analysis.byAssetClass.find((b) => b.key === 'unconfirmed')!
    expect(bucket.valueCny).toBe(30000)
    expect(bucket.unconfirmedCount).toBe(1)
  })
})

/* ================================================================== *
 * C. 历史与 captureKind
 * ================================================================== */

describe('C 历史：captureKind 与不回填', () => {
  it('REAL 快照正常可用', () => {
    const snap = makeSnapshot({
      id: 's1', date: '2026-10-01', netWorth: 1000, isComplete: true,
      captureKind: 'REAL',
      positions: [
        { instrumentId: 'i', accountId: 'a', quantity: 1, price: 1000, currency: 'CNY', rateToCny: 1, valueCny: 1000, reliable: true, assetClassAtCapture: 'equity' },
      ],
    })
    const series = buildCompositionTrend([snap])
    expect(series.points[0].hasClassification).toBe(true)
    expect(series.points[0].usable).toBe(true)
  })

  it('【关键】captureKind 缺失 → 视为 UNKNOWN，而不是 REAL', () => {
    const snap = makeSnapshot({
      id: 's1', date: '2026-10-01', netWorth: 1000, isComplete: true,
      // 刻意不设置 captureKind（模拟 v3 旧快照）
      positions: [],
    })
    // 领域层不把 undefined 改写成 REAL
    expect(snap.captureKind).toBeUndefined()

    expect(snapshotCaptureKind(snap)).toBe('UNKNOWN')
  })

  it('【关键】没有 assetClassAtCapture 时不伪造历史分类', () => {
    const snap = makeSnapshot({
      id: 's1', date: '2026-10-01', netWorth: 1000, isComplete: true, captureKind: 'REAL',
      positions: [
        // 缺 assetClassAtCapture
        { instrumentId: 'i', accountId: 'a', quantity: 1, price: 1000, currency: 'CNY', rateToCny: 1, valueCny: 1000, reliable: true },
      ],
    })
    const r = compositionAtCapture(snap)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('历史分类数据不可用')
      expect(r.missingClassCount).toBe(1)
    }
  })

  it('【关键】当前 Instrument 的分类不会覆盖历史（无回填）', () => {
    // 历史快照没有分类，即使当前 Instrument 有分类也不得使用
    const snap = makeSnapshot({
      id: 'old', date: '2026-09-01', netWorth: 1000, isComplete: true,
      positions: [
        { instrumentId: 'i_etf', accountId: 'a_hk', quantity: 1, price: 1000, currency: 'CNY', rateToCny: 1, valueCny: 1000, reliable: true },
      ],
    })
    const portfolio = { ...mixedPortfolio(), snapshots: [snap] }
    const series = buildCompositionTrend(portfolio.snapshots)
    // 即使 i_etf 在当前 instruments 里是 equity，也不得回填
    expect(series.points[0].hasClassification).toBe(false)
    expect(series.points[0].unavailableReason).toContain('历史分类数据不可用')
    expect(series.points[0].usable).toBe(false)
    expect(series.gaps).toHaveLength(1)
  })

  it('BACKFILLED / ESTIMATED 保留其标记，不被改写成 REAL', () => {
    for (const kind of ['BACKFILLED', 'ESTIMATED'] as const) {
      const snap = makeSnapshot({ id: `s_${kind}`, date: '2026-10-01', netWorth: 1, captureKind: kind, positions: [] })
      expect(snap.captureKind).toBe(kind)
    }
  })
})

/* ================================================================== *
 * D. 每日快照
 * ================================================================== */

describe('D 每日快照：幂等与崩溃一致性', () => {
  const DB = () => `w2-daily-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  it('① 第一次打开 → 创建 REAL 快照', async () => {
    const { repo, db } = await createPairedTestStore(DB())
    await seed(repo)

    const r = await ensureDailySnapshot(repo, { now: NOW, date: D0 })
    expect(r.action).toBe('captured')
    expect(await repo.snapshots.count()).toBe(1)

    const attempt = await readSnapshotAttempt(repo, D0)
    expect(attempt?.status).toBe('success')
    await db.delete()
  })

  it('② 同一天再次打开 → 不创建第二个', async () => {
    const { repo, db } = await createPairedTestStore(DB())
    await seed(repo)
    const first = await ensureDailySnapshot(repo, { now: NOW, date: D0 })
    expect(first.action).toBe('captured')

    /*
     * W7 起当日快照**允许刷新**（否则当天录入/作废后曲线不更新，
     * 而首页仍显示「今日快照：已生成」）。刷新是同日 upsert：
     * 记录数不变、id 不变，只更新内容。
     */
    const again = await ensureDailySnapshot(repo, { now: NOW + 1000, date: D0 })
    expect(again.action).toBe('recaptured')
    expect(await repo.snapshots.count()).toBe(1)
    if (first.action === 'captured' && again.action === 'recaptured') {
      expect(again.snapshot.id).toBe(first.snapshot.id)
      expect(again.snapshot.createdAt).toBe(first.snapshot.createdAt)
    }
    await db.delete()
  })

  it('③ 快照存在但 attempt 缺失 → 补 success（崩溃恢复）', async () => {
    const { repo, db } = await createPairedTestStore(DB())
    await seed(repo)
    await ensureDailySnapshot(repo, { now: NOW, date: D0 })

    /*
     * 模拟「快照已写入、attempt 尚未写入就崩溃」。
     *
     * W7 起 attempt **缺失**被明确定义为崩溃恢复场景：
     * 补记 success 并返回 already-captured（**不重算**），
     * 区别于「当天正常生成过（attempt=success）→ 需要刷新跟上后续录入」。
     */
    await repo.metaKv.remove(snapshotAttemptKey(D0))
    expect(await readSnapshotAttempt(repo, D0)).toBeUndefined()

    const r = await ensureDailySnapshot(repo, { now: NOW + 2000, date: D0 })
    expect(r.action).toBe('already-captured')
    if (r.action === 'already-captured') expect(r.recoveredAttempt).toBe(true)
    expect((await readSnapshotAttempt(repo, D0))?.status).toBe('success')
    // 没有创建第二份
    expect(await repo.snapshots.count()).toBe(1)
    await db.delete()
  })

  it('④ 当天失败 → 不重复尝试', async () => {
    const { repo, db } = await createPairedTestStore(DB())
    await seed(repo)
    // 预置一条 failed attempt（模拟第一次尝试失败）
    await repo.metaKv.set(snapshotAttemptKey(D0), {
      date: D0, attemptedAt: new Date(NOW).toISOString(), status: 'failed', error: '模拟失败',
    })

    const r = await ensureDailySnapshot(repo, { now: NOW, date: D0 })
    expect(r.action).toBe('attempted-failed')
    expect(await repo.snapshots.count()).toBe(0) // 没有创建
    await db.delete()
  })

  it('⑤ 第二天 → 允许重新尝试', async () => {
    const { repo, db } = await createPairedTestStore(DB())
    await seed(repo)
    await repo.metaKv.set(snapshotAttemptKey(D0), {
      date: D0, attemptedAt: new Date(NOW).toISOString(), status: 'failed', error: 'x',
    })

    // 同一天不重试
    expect((await ensureDailySnapshot(repo, { now: NOW, date: D0 })).action).toBe('attempted-failed')
    // 第二天正常创建
    const next = await ensureDailySnapshot(repo, { now: NOW + 86_400_000, date: D1 })
    expect(next.action).toBe('captured')
    expect(await repo.snapshots.count()).toBe(1)
    await db.delete()
  })

  it('⑥ 快照捕获失败不抛错（App 仍可启动）', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    // 让 loadPortfolio 抛错，模拟仓储故障
    const broken: PortfolioRepository = {
      ...repo,
      loadPortfolio: async () => {
        throw new Error('模拟仓储故障')
      },
    }
    const r = await ensureDailySnapshot(broken, { now: NOW, date: D0 })
    expect(r.action).toBe('capture-failed')
    if (r.action === 'capture-failed') expect(r.error).toContain('模拟仓储故障')
    // 失败被记录，当天不再重试
    expect((await ensureDailySnapshot(broken, { now: NOW, date: D0 })).action).toBe('attempted-failed')
  })

  it('每天最多一个 REAL 快照（并发重复调用也只有一个）', async () => {
    const { repo, db } = await createPairedTestStore(DB())
    await seed(repo)
    await Promise.all([
      ensureDailySnapshot(repo, { now: NOW, date: D0 }),
      ensureDailySnapshot(repo, { now: NOW, date: D0 }),
    ])
    // 允许并发下都尝试一次，但数据库唯一索引保证只有一条
    expect(await repo.snapshots.count()).toBe(1)
    await db.delete()
  })

  it('不做自动 backfill：只捕获指定日期，不生成其他日期', async () => {
    const { repo, db } = await createPairedTestStore(DB())
    await seed(repo)
    await ensureDailySnapshot(repo, { now: NOW, date: D0 })
    const all = await repo.snapshots.getAll()
    expect(all.map((s) => s.date)).toEqual([D0])
    await db.delete()
  })

  it('attempt 保留期清理：只删过期键', async () => {
    const repo = createInMemoryRepository()
    await repo.metaKv.set(snapshotAttemptKey('2026-01-01'), { date: '2026-01-01', attemptedAt: 'x', status: 'failed' })
    await repo.metaKv.set(snapshotAttemptKey('2026-10-03'), { date: '2026-10-03', attemptedAt: 'x', status: 'success' })

    const removed = await pruneOldAttempts(repo, D0, ATTEMPT_RETENTION_DAYS)
    expect(removed).toBe(1)
    expect(await readSnapshotAttempt(repo, '2026-01-01')).toBeUndefined()
    expect(await readSnapshotAttempt(repo, '2026-10-03')).toBeDefined()
  })

  it('describeDailySnapshot 给出可读文案', () => {
    expect(describeDailySnapshot({ action: 'captured', date: 'd', snapshot: makeSnapshot({ id: 'x', date: 'd' }) })).toContain('已记录')
    expect(describeDailySnapshot({ action: 'capture-failed', date: 'd', error: 'E' })).toContain('E')
  })
})

/* ================================================================== *
 * E. 单一事实源
 * ================================================================== */

describe('E 单一事实源：W2 数据只来自 IndexedDB', () => {
  it('篡改 localStorage 不改变 W2 派生结果', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const before = await loadPortfolio2(repo, { now: NOW })

    // 伪造 localStorage
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.setItem(
        'asset-card-wallet/portfolio/v2',
        JSON.stringify({ version: 2, categories: [{ id: 'fake', name: '伪造分类', items: [] }] }),
      )
    }

    const after = await loadPortfolio2(repo, { now: NOW })
    expect(after.totals.totalAssets).toBe(before.totals.totalAssets)
    expect(JSON.stringify(after.analysis)).toBe(JSON.stringify(before.analysis))
  })

  it('清空 localStorage 后 W2 数据仍完整', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    if (typeof globalThis.localStorage !== 'undefined') globalThis.localStorage.clear()
    const data = await loadPortfolio2(repo, { now: NOW })
    expect(data.portfolio.holdings).toHaveLength(5)
    expect(data.totals.totalAssets).toBe(187600)
  })

  it('loadPortfolio2 不产生任何写入（只读）', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const before = await repo.counts()
    await loadPortfolio2(repo, { now: NOW })
    const after = await repo.counts()
    expect(after).toEqual(before)
  })
})

/* ================================================================== *
 * 重复持仓：只检测、不自动修复
 * ================================================================== */

describe('重复持仓：W2 只检测与提示', () => {
  it('检出重复但不做任何修改', async () => {
    const repo = createInMemoryRepository()
    const p = mixedPortfolio()
    const dup: Portfolio2 = {
      ...p,
      holdings: [
        ...p.holdings,
        makeHolding({ id: 'h_dup', accountId: 'a_cn', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 999, costBasis: 999 }),
      ],
    }
    await repo.replaceAll(dup)
    const before = JSON.stringify(await repo.loadPortfolio())

    const data = await loadPortfolio2(repo, { now: NOW })
    expect(data.duplicates.ok).toBe(false)
    expect(data.duplicates.duplicates[0].key).toBe('a_cn::i_cash')

    // 数据一字未改（无自动 merge / delete / overwrite）
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })

  it('无重复时报告 ok', async () => {
    const repo = createInMemoryRepository()
    await seed(repo)
    const data = await loadPortfolio2(repo, { now: NOW })
    expect(data.duplicates.ok).toBe(true)
    expect(data.duplicates.summary).toContain('未发现')
  })
})
