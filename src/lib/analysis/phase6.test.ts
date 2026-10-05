import { describe, expect, it } from 'vitest'
import type { Portfolio2 } from '../../types/portfolio2'
import { calculateTotals } from '../valuation/engine'
import { valuateHolding } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'
import { checkDimensions, deriveAnalysis, dimensionsOfHolding, rowsInBucket } from './index'
import { ASSET_CLASS_LABEL, REGION_LABEL } from './dimensions'
import { classifyInstrument } from './classify'
import {
  NOW,
  makeAccount,
  makeHolding,
  makeInstrument,
  makePortfolio,
  makeQuote,
} from '../valuation/__fixtures__/builders'

/*
 * Phase 6 测试：分析视图
 *
 * 重点验证用户确认的口径：
 * - 各维度合计 == reliableValueCny（不是「理论总额」）
 * - unconfirmed ≠ unavailable，两者可同时存在
 * - 分析不得改变估值结果（守恒）
 * - 同一持仓在每个单独维度中恰好出现一次
 * - byCurrency 不把不同币种相加，FX 缺失保留原币、标缺口
 */

/* ------------------------------------------------------------------ *
 * 构造器
 * ------------------------------------------------------------------ */

/** 一个包含多币种、多地区、多类别的组合 */
function buildPortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [
      makeAccount({ id: 'hk_bank', name: '示例香港银行', currency: 'HKD', region: 'HK', type: 'bank' }),
      makeAccount({ id: 'us_broker', name: '示例美国券商', currency: 'USD', region: 'US', type: 'broker' }),
      makeAccount({ id: 'cn_bank', name: '示例内地银行', currency: 'CNY', region: 'CN', type: 'bank' }),
    ],
    instruments: [
      makeInstrument({ id: 'i_cny_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_usd_cash', name: '美元现金', instrumentType: 'cash', assetClass: 'cash', currency: 'USD', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_hkd_cash', name: '港币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'HKD', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_etf_us', name: '示例美股 ETF', instrumentType: 'etf', assetClass: 'equity', currency: 'USD', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_fund_cn', name: '示例内地基金', instrumentType: 'fund', assetClass: 'fixed_income', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_unknown', name: '示例未确认资产', instrumentType: 'other', assetClass: 'other', currency: 'CNY', classificationStatus: 'unconfirmed' }),
      makeInstrument({ id: 'i_gold', name: '示例黄金', instrumentType: 'gold', assetClass: 'gold', currency: 'CNY', classificationStatus: 'confirmed' }),
    ],
    holdings: [
      // 香港银行：港币现金 + 美股 ETF（地区仍归 HK —— 不猜市场）
      makeHolding({ id: 'h1', accountId: 'hk_bank', instrumentId: 'i_hkd_cash', valuationMode: 'quantity', quantity: 20000 }),
      makeHolding({ id: 'h2', accountId: 'hk_bank', instrumentId: 'i_etf_us', valuationMode: 'quantity', quantity: 100, costBasis: 6000 }),
      // 美国券商：美元现金
      makeHolding({ id: 'h3', accountId: 'us_broker', instrumentId: 'i_usd_cash', valuationMode: 'quantity', quantity: 10000 }),
      // 内地银行：人民币现金 + 基金 + 未确认资产 + 黄金
      makeHolding({ id: 'h4', accountId: 'cn_bank', instrumentId: 'i_cny_cash', valuationMode: 'quantity', quantity: 100000 }),
      makeHolding({ id: 'h5', accountId: 'cn_bank', instrumentId: 'i_fund_cn', valuationMode: 'quantity', quantity: 5000 }),
      makeHolding({ id: 'h6', accountId: 'cn_bank', instrumentId: 'i_unknown', valuationMode: 'manual', manualValue: 30000 }),
      makeHolding({ id: 'h7', accountId: 'cn_bank', instrumentId: 'i_gold', valuationMode: 'quantity', quantity: 50, costBasis: 20000 }),
    ],
    quotes: [
      makeQuote({ id: 'q_etf', instrumentId: 'i_etf_us', marketPrice: 80, currency: 'USD', status: 'LIVE', timestamp: new Date(NOW).toISOString() }),
      // 基金与黄金是数量口径，必须给行情才能可靠估值；单价均设为 1，便于核对金额
      makeQuote({ id: 'q_fund', instrumentId: 'i_fund_cn', marketPrice: 1, currency: 'CNY', status: 'LIVE', timestamp: new Date(NOW).toISOString() }),
      makeQuote({ id: 'q_gold', instrumentId: 'i_gold', marketPrice: 1, currency: 'CNY', status: 'LIVE', timestamp: new Date(NOW).toISOString() }),
    ],
    fxRates: [
      { id: 'fx_usd', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: new Date(NOW).toISOString(), source: 'test', status: 'LIVE' },
      { id: 'fx_hkd', baseCurrency: 'HKD', quoteCurrency: 'CNY', rate: 0.92, timestamp: new Date(NOW).toISOString(), source: 'test', status: 'LIVE' },
    ],
  })
}

function analyze(portfolio: Portfolio2, now = NOW) {
  const fx = createFxTable(portfolio.fxRates)
  const results = portfolio.holdings.map((h) => valuateHolding(h, portfolio, { fx, now }))
  const totals = calculateTotals({ portfolio, fx, now })
  return { view: deriveAnalysis({ portfolio, results, totals, now }), totals, results }
}

/* ================================================================== *
 * 1. 核心不变量：各维度合计 == reliableValueCny
 * ================================================================== */

describe('核心不变量：各维度合计 === reliableValueCny', () => {
  it('六个维度的合计全部等于 reliableValueCny', () => {
    const { view } = analyze(buildPortfolio())
    const check = checkDimensions(view)
    expect(check.ok).toBe(true)
    for (const c of check.checks) expect(c.sum).toBeCloseTo(view.reliableValueCny, 2)
  })

  it('reliableValueCny 等于估值引擎的 totalAssets（不重算）', () => {
    const { view, totals } = analyze(buildPortfolio())
    expect(view.reliableValueCny).toBe(totals.totalAssets)
    expect(view.totalAssets).toBe(totals.totalAssets)
    expect(view.totalLiabilities).toBe(totals.totalLiabilities)
    expect(view.netWorth).toBe(totals.netWorth)
  })

  it('不能把「不可估值资产」算进任何维度金额', () => {
    const p = buildPortfolio()
    /*
     * 追加一个不可估值的持仓：**数量口径 + 无行情**。
     * 注意不能用 i_usd_cash —— 同一账户下的同一标的与 h3 共用持仓键，
     * 会发生键冲突。这里用一个全新的 CNY 标的。
     */
    const bad = makeInstrument({
      id: 'i_bad', name: '示例无行情标的', instrumentType: 'stock',
      assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed',
    })
    const withUnvalued: Portfolio2 = {
      ...p,
      instruments: [...p.instruments, bad],
      holdings: [
        ...p.holdings,
        makeHolding({ id: 'h_bad', accountId: 'us_broker', instrumentId: 'i_bad', valuationMode: 'quantity', quantity: 99999 }),
      ],
    }
    const { view, totals } = analyze(withUnvalued)

    expect(totals.unavailableCount).toBe(1)
    // 99999 元**没有**被计进任何金额
    expect(view.reliableValueCny).toBe(totals.totalAssets)
    expect(view.byAccount.find((b) => b.key === 'us_broker')!.valueCny).toBe(72000) // 只有 h3
    expect(view.byAccount.find((b) => b.key === 'us_broker')!.unavailableCount).toBe(1)
    expect(view.byAssetClass.find((b) => b.key === 'equity')!.isComplete).toBe(false)
    // 合计仍等于可靠金额
    expect(checkDimensions(view).ok).toBe(true)
  })

  it('重复持仓：分析层如实展示，检测与阻断由 Phase 7 负责', () => {
    /*
     * 职责分工（Phase 7 明确）：
     *
     * | 层 | 对重复持仓的态度 |
     * | --- | --- |
     * | 分析层 | **如实展示**每一行，不偷偷去重（让用户看见问题） |
     * | 检测 | `detectDuplicateHoldings()` 明确报错 |
     * | 重建 / 写入 | **直接阻断**，不静默覆盖 |
     *
     * 本用例锁定「分析层不去重」这一点；
     * 阻断行为由 phase7.test.ts 覆盖。
     */
    const p = buildPortfolio()
    const dup: Portfolio2 = {
      ...p,
      holdings: [
        ...p.holdings,
        makeHolding({ id: 'h_dup', accountId: 'us_broker', instrumentId: 'i_usd_cash', valuationMode: 'quantity', quantity: 1 }),
      ],
    }
    const { view } = analyze(dup)
    // 两条记录都出现在 rows 中（分析层按持仓行展示，不做键去重）
    expect(view.rows.filter((r) => r.instrumentId === 'i_usd_cash')).toHaveLength(2)
    // 但它们的持仓键相同 —— 这正是需要被检测出来的数据问题
    const keys = view.rows
      .filter((r) => r.instrumentId === 'i_usd_cash')
      .map((r) => `${r.accountId}::${r.instrumentId}`)
    expect(new Set(keys).size).toBe(1)

    // Phase 7 的检测器必须能识别出来
    return import('../ledger/duplicates').then(({ detectDuplicateHoldings }) => {
      const report = detectDuplicateHoldings(dup)
      expect(report.ok).toBe(false)
      expect(report.duplicates[0].key).toBe('us_broker::i_usd_cash')
    })
  })

  it('行数等于持仓数（根集合唯一）', () => {
    const p = buildPortfolio()
    const { view } = analyze(p)
    expect(view.rows).toHaveLength(p.holdings.length)
    expect(view.assetRows.length + view.liabilityRows.length).toBe(p.holdings.length)
  })
})

/* ================================================================== *
 * 2. 守恒：分析不得改变估值结果
 * ================================================================== */

describe('守恒：deriveAnalysis 不得改变估值结果', () => {
  it('六项指标与估值引擎逐一一致', () => {
    const { view, totals } = analyze(buildPortfolio())
    expect(view.totalAssets).toBe(totals.totalAssets)
    expect(view.totalLiabilities).toBe(totals.totalLiabilities)
    expect(view.netWorth).toBe(totals.netWorth)
    expect(view.reliableValueCny).toBe(totals.totalAssets)
    expect(view.coverage.unavailableCount).toBe(totals.unavailableCount)
    expect(view.coverage.staleCount).toBe(totals.staleCount)
  })

  it('分析不修改输入组合（纯函数）', () => {
    const p = buildPortfolio()
    const before = JSON.stringify(p)
    analyze(p)
    expect(JSON.stringify(p)).toBe(before)
  })

  it('分析不修改估值结果对象', () => {
    const p = buildPortfolio()
    const fx = createFxTable(p.fxRates)
    const results = p.holdings.map((h) => valuateHolding(h, p, { fx, now: NOW }))
    const totals = calculateTotals({ portfolio: p, fx, now: NOW })
    const snapshot = JSON.stringify(results)
    deriveAnalysis({ portfolio: p, results, totals, now: NOW })
    expect(JSON.stringify(results)).toBe(snapshot)
  })

  it('重复调用结果稳定', () => {
    const p = buildPortfolio()
    const a = analyze(p).view
    const b = analyze(p).view
    expect(a.reliableValueCny).toBe(b.reliableValueCny)
    expect(JSON.stringify(a.byAssetClass)).toBe(JSON.stringify(b.byAssetClass))
  })
})

/* ================================================================== *
 * 3. 多维切片：同一持仓在每个单独维度恰好一次
 * ================================================================== */

describe('多维切片：每个维度中恰好出现一次，维度之间允许重复', () => {
  it('同一笔美股 ETF 在五个维度中分别归属正确的组', () => {
    const { view } = analyze(buildPortfolio())
    const dims = dimensionsOfHolding(view, 'h2')
    expect(dims.byAccount).toBe('hk_bank')
    expect(dims.byRegion).toBe('HK') // 香港账户持美股 → 仍归 HK
    expect(dims.byCurrency).toBe('USD')
    expect(dims.byInstrumentType).toBe('etf')
    expect(dims.byAssetClass).toBe('equity')
    expect(dims.byAccountType).toBe('bank')
  })

  it('每个持仓在每个维度中只出现一次（不会重复计入）', () => {
    const { view } = analyze(buildPortfolio())
    const dimensions: Array<[string, (r: (typeof view.rows)[number]) => string]> = [
      ['byAssetClass', (r) => r.assetClass],
      ['byAccount', (r) => r.accountId],
      ['byAccountType', (r) => r.accountType],
      ['byCurrency', (r) => r.currency],
      ['byRegion', (r) => r.region],
      ['byInstrumentType', (r) => r.instrumentType],
    ]
    for (const [name, pick] of dimensions) {
      // 对每个持仓，在「该维度的行集合」中计数必须恰好为 1
      const counts = new Map<string, number>()
      for (const row of view.assetRows) {
        const key = `${row.holdingId}|${pick(row)}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      for (const [key, n] of counts) {
        expect(n, `${name} 中 ${key} 出现了 ${n} 次`).toBe(1)
      }
    }
  })

  it('下钻：分组的行集合能还原该组金额', () => {
    const { view } = analyze(buildPortfolio())
    for (const bucket of view.byAssetClass) {
      const rows = rowsInBucket(view, 'byAssetClass', bucket.key)
      const sum = rows
        .filter((r) => r.status === 'ok' && r.valueCny !== undefined)
        .reduce((s, r) => s + (r.valueCny ?? 0), 0)
      expect(sum).toBeCloseTo(bucket.valueCny, 2)
    }
  })
})

/* ================================================================== *
 * 4. unconfirmed ≠ unavailable（可同时存在）
 * ================================================================== */

describe('unconfirmed 与 unavailable 是两个独立维度', () => {
  it('unconfirmed + ok：计入金额，进入「待确认分类」桶', () => {
    const { view, totals } = analyze(buildPortfolio())
    // i_unknown 是 unconfirmed 但可估值（manual 30000）
    const unconfirmedBucket = view.byAssetClass.find((b) => b.key === 'unconfirmed')!
    expect(unconfirmedBucket).toBeDefined()
    expect(unconfirmedBucket.valueCny).toBe(30000)
    expect(unconfirmedBucket.unconfirmedCount).toBe(1)
    // 关键：分类未知但价值计入总额
    expect(totals.totalAssets).toBeGreaterThanOrEqual(30000)
    expect(view.coverage.unconfirmedCount).toBe(1)
    expect(view.coverage.unavailableCount).toBe(0)
  })

  it('【关键】unconfirmed + unavailable 可以同时成立，且不产生任何金额', () => {
    const p = buildPortfolio()
    // 未确认分类 + 无汇率（美元手动口径 → 不可估值）
    const portfolio: Portfolio2 = {
      ...p,
      fxRates: [], // 去掉全部汇率
      holdings: [
        makeHolding({ id: 'h_mix', accountId: 'us_broker', instrumentId: 'i_usd_cash', valuationMode: 'quantity', quantity: 5000 }),
      ],
    }
    // 让该标的变成未确认分类
    const mixed: Portfolio2 = {
      ...portfolio,
      instruments: portfolio.instruments.map((i) =>
        i.id === 'i_usd_cash' ? { ...i, classificationStatus: 'unconfirmed' as const } : i,
      ),
    }
    const { view } = analyze(mixed)

    // 同时属于两个集合
    expect(view.coverage.unconfirmedCount).toBe(1)
    expect(view.coverage.unavailableCount).toBe(1)
    expect(view.coverage.unconfirmedAndUnavailableIds).toContain('h_mix')

    // 但不产生任何金额
    expect(view.coverage.reliableValueCny).toBe(0)
    expect(view.byAssetClass.every((b) => b.valueCny === 0)).toBe(true)
    expect(view.byAssetClass.find((b) => b.key === 'unconfirmed')!.unavailableCount).toBe(1)
  })

  it('【关键】分类未知 ≠ 没有价值：有可靠估值就必须计入', () => {
    const p = buildPortfolio()
    const { view, totals } = analyze(p)
    const unknownRow = view.rows.find((r) => r.holdingId === 'h6')!
    expect(unknownRow.classConfirmed).toBe(false)
    expect(unknownRow.status).toBe('ok')
    expect(unknownRow.valueCny).toBe(30000)
    // 计入总额
    expect(totals.totalAssets).toBeGreaterThanOrEqual(30000)
  })

  it('绝不根据名称/代码自动分类：名称含「基金」但未确认仍归 unconfirmed', () => {
    const inst = makeInstrument({ id: 'x', name: '示例货币基金A', instrumentType: 'fund', assetClass: 'other', classificationStatus: 'unconfirmed' })
    const r = classifyInstrument(inst)
    expect(r.assetClass).toBe('unconfirmed')
    expect(r.confirmed).toBe(false)
  })

  it('已确认但 assetClass 有值 → 采用该值', () => {
    const inst = makeInstrument({ id: 'x', name: '示例标的', instrumentType: 'etf', assetClass: 'equity', classificationStatus: 'confirmed' })
    expect(classifyInstrument(inst).assetClass).toBe('equity')
  })

  it('标的不存在时归 unconfirmed（不猜）', () => {
    expect(classifyInstrument(undefined).assetClass).toBe('unconfirmed')
  })

  it('blockedAnalyses 明确列出因缺口而不可用的分析', () => {
    const p = buildPortfolio()
    const { view } = analyze(p)
    expect(view.coverage.blockedAnalyses.some((x) => x.includes('分类未确认'))).toBe(true)
  })
})

/* ================================================================== *
 * 5. byCurrency：不同币种绝不直接相加
 * ================================================================== */

describe('byCurrency：原币与人民币分开，FX 缺失标缺口', () => {
  it('每个币种分别给出原币合计与折算后人民币', () => {
    const { view } = analyze(buildPortfolio())
    const usd = view.byCurrency.find((b) => b.key === 'USD')!
    const hkd = view.byCurrency.find((b) => b.key === 'HKD')!
    const cny = view.byCurrency.find((b) => b.key === 'CNY')!

    // USD：现金 10000 + ETF 100×80 = 18000 USD
    expect(usd.nativeCurrency).toBe('USD')
    expect(usd.nativeTotal).toBe(18000)
    expect(usd.valueCny).toBeCloseTo(18000 * 7.2, 2)

    // HKD：现金 20000
    expect(hkd.nativeTotal).toBe(20000)
    expect(hkd.valueCny).toBeCloseTo(20000 * 0.92, 2)

    // CNY：现金 100000 + 基金 5000×1 + 未确认 30000 + 黄金 50×1 = 135050
    expect(cny.nativeCurrency).toBe('CNY')
    expect(cny.nativeTotal).toBe(135050)
    expect(cny.valueCny).toBe(135050)
  })

  it('不同币种不会被相加成同一个数字', () => {
    const { view } = analyze(buildPortfolio())
    const usd = view.byCurrency.find((b) => b.key === 'USD')!
    const hkd = view.byCurrency.find((b) => b.key === 'HKD')!
    // 原币金额彼此独立
    expect(usd.nativeTotal).not.toBe(hkd.nativeTotal)
    expect(usd.nativeCurrency).toBe('USD')
    expect(hkd.nativeCurrency).toBe('HKD')
  })

  it('【关键】FX 缺失：保留原币，valueCny 不计入，标 fxMissing', () => {
    const p = buildPortfolio()
    // 只留纯外币持仓，确保不可折算的原因确实是「缺汇率」而不是「缺行情」
    const foreignOnly: Portfolio2 = {
      ...p,
      fxRates: [],
      holdings: p.holdings.filter((h) => h.instrumentId === 'i_usd_cash' || h.instrumentId === 'i_hkd_cash'),
    }
    const { view } = analyze(foreignOnly)

    const usd = view.byCurrency.find((b) => b.key === 'USD')!
    // 原币仍在
    expect(usd.nativeTotal).toBe(10000)
    // 人民币不计入（不用 1:1 fallback）
    expect(usd.valueCny).toBe(0)
    expect(usd.fxMissing).toBe(true)

    const hkd = view.byCurrency.find((b) => b.key === 'HKD')!
    expect(hkd.nativeTotal).toBe(20000)
    expect(hkd.valueCny).toBe(0)
    expect(hkd.fxMissing).toBe(true)

    // 全部不可折算 → 可靠总额为 0，且各维度合计仍与之相等
    expect(view.reliableValueCny).toBe(0)
    expect(checkDimensions(view).ok).toBe(true)
  })

  it('【精确性】缺行情不会被误报成「缺汇率」', () => {
    const p = buildPortfolio()
    // 去掉基金与黄金的行情 → 它们是 missing_quote，不是 missing_fx
    const noQuote: Portfolio2 = {
      ...p,
      quotes: p.quotes.filter((q) => q.instrumentId === 'i_etf_us'),
    }
    const { view } = analyze(noQuote)
    const cny = view.byCurrency.find((b) => b.key === 'CNY')!
    // 人民币项不存在汇率问题
    expect(cny.fxMissing).toBeFalsy()
    // 但它们确实不可估值
    expect(cny.unavailableCount).toBeGreaterThan(0)
  })

  it('FX 齐全时 CNY 桶不应标记折算缺口', () => {
    const { view } = analyze(buildPortfolio())
    const cny = view.byCurrency.find((b) => b.key === 'CNY')!
    expect(cny.fxMissing).toBeFalsy()
    expect(cny.valueCny).toBe(cny.nativeTotal)
  })

  it('FX 缺失时维度合计仍等于 reliableValueCny（不含未折算部分）', () => {
    const p = buildPortfolio()
    const { view } = analyze({ ...p, fxRates: [] })
    expect(checkDimensions(view).ok).toBe(true)
  })
})

/* ================================================================== *
 * 6. byRegion：账户属地，不猜市场
 * ================================================================== */

describe('byRegion：使用账户属地，绝不猜测市场', () => {
  it('香港账户持有的美股 ETF 归 HK（不强行归 US）', () => {
    const { view } = analyze(buildPortfolio())
    const hk = view.byRegion.find((b) => b.key === 'HK')!
    const hkHoldings = rowsInBucket(view, 'byRegion', 'HK').map((r) => r.holdingId)
    expect(hkHoldings).toContain('h2') // 美股 ETF 在 HK
    expect(hk.valueCny).toBeGreaterThan(0)
  })

  it('地区标签完整，含未标注地区', () => {
    const p = buildPortfolio()
    const noRegion: Portfolio2 = {
      ...p,
      accounts: p.accounts.map((a) => ({ ...a, region: undefined })),
    }
    const { view } = analyze(noRegion)
    expect(view.byRegion.some((b) => b.key === 'unknown')).toBe(true)
    expect(REGION_LABEL.unknown).toBe('未标注地区')
  })

  it('地区维度合计等于 reliableValueCny', () => {
    const { view } = analyze(buildPortfolio())
    const sum = view.byRegion.reduce((s, b) => s + b.valueCny, 0)
    expect(sum).toBeCloseTo(view.reliableValueCny, 2)
  })
})

/* ================================================================== *
 * 7. 资产类别与工具暴露
 * ================================================================== */

describe('资产类别与工具暴露', () => {
  it('byAssetClass 覆盖现金 / 股票 / 固收 / 黄金 / 待确认', () => {
    const { view } = analyze(buildPortfolio())
    const keys = view.byAssetClass.map((b) => b.key).sort()
    expect(keys).toContain('cash')
    expect(keys).toContain('equity')
    expect(keys).toContain('fixed_income')
    expect(keys).toContain('gold')
    expect(keys).toContain('unconfirmed')
  })

  it('占比之和为 1（可靠部分）', () => {
    const { view } = analyze(buildPortfolio())
    const shareSum = view.byAssetClass.reduce((s, b) => s + (b.share ?? 0), 0)
    expect(shareSum).toBeCloseTo(1, 6)
  })

  it('可靠总额为 0 时 share 为 undefined（不填 0）', () => {
    const p = buildPortfolio()
    const { view } = analyze({ ...p, fxRates: [], holdings: p.holdings.filter((h) => h.instrumentId === 'i_usd_cash' || h.instrumentId === 'i_hkd_cash') })
    expect(view.reliableValueCny).toBe(0)
    for (const b of view.byAssetClass) expect(b.share).toBeUndefined()
  })

  it('byInstrumentType 统计工具暴露（ETF / 基金 / 黄金 / 现金）', () => {
    const { view } = analyze(buildPortfolio())
    const keys = view.byInstrumentType.map((b) => b.key)
    expect(keys).toContain('etf')
    expect(keys).toContain('fund')
    expect(keys).toContain('gold')
    expect(keys).toContain('cash')
  })

  it('标签复用官方定义，不重复维护', () => {
    expect(ASSET_CLASS_LABEL.unconfirmed).toBe('待确认分类')
    expect(ASSET_CLASS_LABEL.equity).toBe('股票')
    expect(ASSET_CLASS_LABEL.fixed_income).toBe('固收')
  })
})

/* ================================================================== *
 * 8. 完整性
 * ================================================================== */

describe('完整性报告', () => {
  it('stale 项计入 staleCount、不计入金额、标记该组不完整', () => {
    const p = buildPortfolio()
    const staleQuote = new Date(NOW - 10 * 3600 * 1000).toISOString()
    const withStale: Portfolio2 = {
      ...p,
      quotes: [{ ...p.quotes[0], timestamp: staleQuote }],
      fxRates: p.fxRates.map((f) => ({ ...f, timestamp: staleQuote })),
    }
    const { view, totals } = analyze(withStale, NOW)
    expect(totals.staleCount).toBeGreaterThan(0)
    expect(view.coverage.staleCount).toBe(totals.staleCount)
    expect(view.coverage.isComplete).toBe(false)
    // 该组被标记为不完整
    const equity = view.byAssetClass.find((b) => b.key === 'equity')
    if (equity) expect(equity.isComplete).toBe(false)
  })

  it('coverageRatio = 可靠项数 / 总项数', () => {
    const { view } = analyze(buildPortfolio())
    expect(view.coverage.coverageRatio).toBe(view.coverage.reliableCount / view.coverage.totalHoldings)
  })

  it('空组合：各项为 0，share 为 undefined，不崩', () => {
    const p = buildPortfolio()
    const { view } = analyze({ ...p, holdings: [] })
    expect(view.rows).toHaveLength(0)
    expect(view.reliableValueCny).toBe(0)
    expect(view.coverage.coverageRatio).toBe(1)
    expect(view.byAssetClass).toHaveLength(0)
  })
})

/* ================================================================== *
 * 9. 资产负债分离
 * ================================================================== */

describe('资产与负债分离（保证守恒在有负债时仍成立）', () => {
  it('负债不进入资产维度，但计入 totalLiabilities', () => {
    const p = buildPortfolio()
    const loan = makeInstrument({ id: 'i_loan', name: '示例贷款', instrumentType: 'other', assetClass: 'liability', currency: 'CNY', classificationStatus: 'confirmed' })
    const withLoan: Portfolio2 = {
      ...p,
      instruments: [...p.instruments, loan],
      holdings: [
        ...p.holdings,
        makeHolding({ id: 'h_loan', accountId: 'cn_bank', instrumentId: 'i_loan', valuationMode: 'manual', manualValue: 50000 }),
      ],
    }
    const { view, totals } = analyze(withLoan)

    expect(totals.totalLiabilities).toBeGreaterThan(0)
    expect(view.liabilityRows).toHaveLength(1)
    expect(view.assetRows).toHaveLength(p.holdings.length)
    // 负债不影响资产维度守恒
    expect(checkDimensions(view).ok).toBe(true)
    expect(view.reliableValueCny).toBe(totals.totalAssets)
    expect(view.netWorth).toBe(totals.totalAssets - totals.totalLiabilities)
    // 负债不在任何资产维度桶里被计入
    for (const b of view.byAssetClass) expect(b.valueCny).toBeGreaterThanOrEqual(0)
    expect(view.byAssetClass.some((b) => b.key === 'liability')).toBe(false)
  })
})

/* ================================================================== *
 * 10. 现金腿不重复统计（与 Phase 5 打通）
 * ================================================================== */

describe('现金腿不重复统计', () => {
  it('买入后总资产不变（现金减少与证券增加抵消）', async () => {
    const { rebuildHoldingsFromTransactions } = await import('../ledger/rebuild')

    const p = makePortfolio({
      accounts: [makeAccount({ id: 'a', currency: 'CNY', region: 'CN' })],
      instruments: [
        makeInstrument({ id: 'CASH', name: '现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
        makeInstrument({ id: 'STK', name: '示例股票', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
      ],
      holdings: [],
      quotes: [makeQuote({ id: 'q', instrumentId: 'STK', marketPrice: 10, currency: 'CNY', status: 'LIVE', timestamp: new Date(NOW).toISOString() })],
      transactions: [
        { id: 'a1', accountId: 'a', instrumentId: 'CASH', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: '2026-09-01T00:00:00.000Z' },
        { id: 'b1', accountId: 'a', instrumentId: 'STK', cashInstrumentId: 'CASH', type: 'buy', quantity: 1000, amount: 10000, currency: 'CNY', timestamp: '2026-09-02T00:00:00.000Z' },
      ],
    })

    const rebuilt = { ...p, holdings: rebuildHoldingsFromTransactions(p).holdings }
    // 现金 90000 + 股票 10000 = 100000
    const { view, totals } = analyze(rebuilt)
    expect(totals.totalAssets).toBe(100000)
    expect(checkDimensions(view).ok).toBe(true)
    // 现金与股票各计一次，没有因为「现金腿」再算一遍
    expect(view.byAssetClass.find((b) => b.key === 'cash')!.valueCny).toBe(90000)
    expect(view.byAssetClass.find((b) => b.key === 'equity')!.valueCny).toBe(10000)
  })
})
