import { describe, expect, it } from 'vitest'
import { calculateTotals, describeTotals, valuateHolding } from './engine'
import { createFxTable } from './fx'
import { judgeQuote } from './quote'
import type { QuoteStatus } from '../../types/portfolio2'
import {
  ISO,
  NOW,
  assetClassMix,
  cnyRates,
  makeAccount,
  makeFxRate,
  makeHolding,
  makeInstrument,
  makePortfolio,
  makeQuote,
  multiCurrencyAccount,
} from './__fixtures__/builders'

/*
 * 估值引擎测试
 *
 * 核心不变量（需求明确要求）：
 * - 不可估值 ≠ 价值为 0
 * - FX 缺失时外币资产**不得**按 1:1 计入 CNY
 * - 汇总必须结构化返回，让 UI 能区分「可靠 / 不可估值 / 过期」三部分
 */

describe('单条估值：手动口径（现金 / 房产 / 应收）', () => {
  const acct = makeAccount({ id: 'a1' })

  it('人民币现金直接取值', () => {
    const inst = makeInstrument({ id: 'i1', currency: 'CNY', assetClass: 'cash' })
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', manualValue: 20000 })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h] })
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('ok')
    expect(r.value).toBe(20000)
  })

  it('金额为 0 是合法值，不算缺失', () => {
    const inst = makeInstrument({ id: 'i1', currency: 'CNY' })
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', manualValue: 0 })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h] })
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('ok')
    expect(r.value).toBe(0)
  })

  it('未记录金额 → unavailable（不是 0）', () => {
    const inst = makeInstrument({ id: 'i1', currency: 'CNY' })
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1' })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h] })
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('unavailable')
    expect(r.value).toBeUndefined()
    expect(r.reasons).toContain('missing_value')
  })

  it('【核心】USD 现金 + FX 缺失 → unavailable，且 value 为 undefined 而非 0 或 10000', () => {
    const inst = makeInstrument({ id: 'i1', currency: 'USD', assetClass: 'cash' })
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', manualValue: 10000 })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h] })

    const r = valuateHolding(h, p, { now: NOW, fx: createFxTable([]) })
    expect(r.status).toBe('unavailable')
    expect(r.value).toBeUndefined()
    expect(r.value).not.toBe(0)
    expect(r.value).not.toBe(10000) // 不是 1:1
    expect(r.reasons).toContain('missing_fx')
    // 原币金额仍然保留，供 UI 展示「USD 10,000（暂无法折算）」
    expect(r.valueInCurrency).toBe(10000)
    expect(r.currency).toBe('USD')
  })

  it('USD 现金 + FX 正常 → 正确折算', () => {
    const inst = makeInstrument({ id: 'i1', currency: 'USD', assetClass: 'cash' })
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', manualValue: 10000 })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h] })
    const r = valuateHolding(h, p, { now: NOW, fx: createFxTable(cnyRates()) })
    expect(r.status).toBe('ok')
    expect(r.value).toBeCloseTo(72000, 6)
  })
})

describe('单条估值：数量口径（股票 / 基金 / 黄金）', () => {
  const acct = makeAccount({ id: 'a1' })

  const setup = (quoteStatus: QuoteStatus, quantity = 10) => {
    const inst = makeInstrument({ id: 'i1', currency: 'CNY', assetClass: 'equity', instrumentType: 'etf' })
    const h = makeHolding({
      id: 'h1', accountId: 'a1', instrumentId: 'i1',
      valuationMode: 'quantity', quantity, costBasis: 100 * quantity,
    })
    const q = makeQuote({ id: 'q1', instrumentId: 'i1', marketPrice: 120, status: quoteStatus ?? 'LIVE', timestamp: ISO })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h], quotes: [q] })
    return { h, p }
  }

  it('LIVE 行情 → 按市价估值', () => {
    const { h, p } = setup('LIVE')
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('ok')
    expect(r.value).toBe(1200)
  })

  it('MANUAL 行情 → 按手动价估值', () => {
    const { h, p } = setup('MANUAL')
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('ok')
    expect(r.value).toBe(1200)
  })

  it('CLOSED 行情在有效期内仍可用', () => {
    const { h, p } = setup('CLOSED')
    expect(valuateHolding(h, p, { now: NOW }).status).toBe('ok')
  })

  it('STALE 行情 → stale，不计入总额，但作为展示值保留', () => {
    const { h, p } = setup('STALE')
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('stale')
    expect(r.reasons).toContain('stale_quote')
  })

  it('ERROR 行情 → unavailable', () => {
    const { h, p } = setup('ERROR')
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('unavailable')
    expect(r.reasons).toContain('error_quote')
  })

  it('没有任何行情 → unavailable，且成本价只作线索不参与总额', () => {
    const inst = makeInstrument({ id: 'i1', currency: 'CNY', assetClass: 'equity', instrumentType: 'etf' })
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 10, costBasis: 1000 })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h] })
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('unavailable')
    expect(r.value).toBeUndefined() // 不得用成本价冒充市值
    expect(r.reasons).toContain('missing_quote')
    expect(r.fallbackValueInCurrency).toBe(1000) // 仅作线索
  })

  it('行情时间过旧（即使状态是 LIVE）也判为 stale', () => {
    const inst = makeInstrument({ id: 'i1', currency: 'CNY', assetClass: 'equity', instrumentType: 'etf' })
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 10 })
    const old = makeQuote({
      id: 'q1', instrumentId: 'i1', marketPrice: 120, status: 'LIVE',
      timestamp: new Date(NOW - 10 * 60 * 60 * 1000).toISOString(), // 10 小时前 > LIVE 阈值 1 小时
    })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h], quotes: [old] })
    expect(valuateHolding(h, p, { now: NOW }).status).toBe('stale')
  })

  it('外币持仓：行情可用但 FX 缺失 → unavailable（不按 1:1）', () => {
    const inst = makeInstrument({ id: 'i1', currency: 'USD', assetClass: 'equity', instrumentType: 'etf' })
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity', quantity: 1 })
    const q = makeQuote({ id: 'q1', instrumentId: 'i1', marketPrice: 100.5, status: 'LIVE', timestamp: ISO, currency: 'USD' })
    const p = makePortfolio({ accounts: [acct], instruments: [inst], holdings: [h], quotes: [q] })
    const r = valuateHolding(h, p, { now: NOW, fx: createFxTable([]) })
    expect(r.status).toBe('unavailable')
    expect(r.value).toBeUndefined()
    expect(r.valueInCurrency).toBeCloseTo(100.5, 6)
    expect(r.reasons).toContain('missing_fx')
  })

  it('标的不存在 → unavailable 且给出原因', () => {
    const h = makeHolding({ id: 'h1', accountId: 'a1', instrumentId: '不存在' })
    const p = makePortfolio({ accounts: [acct], holdings: [h] })
    const r = valuateHolding(h, p, { now: NOW })
    expect(r.status).toBe('unavailable')
    expect(r.reasons).toContain('missing_instrument')
  })
})

describe('Quote 可用性判定', () => {
  it('六种状态各自的行为', () => {
    const t = (status: QuoteStatus) =>
      judgeQuote(makeQuote({ marketPrice: 10, status, timestamp: ISO }), NOW).usable

    expect(t('LIVE')).toBe(true)
    expect(t('DELAYED')).toBe(true)
    expect(t('MANUAL')).toBe(true)
    expect(t('CLOSED')).toBe(true)
    expect(t('STALE')).toBe(false)
    expect(t('ERROR')).toBe(false)
  })

  it('价格缺失或非正时不可用', () => {
    expect(judgeQuote(makeQuote({ marketPrice: 0, status: 'LIVE', timestamp: ISO }), NOW).usable).toBe(false)
    expect(judgeQuote(makeQuote({ status: 'LIVE', timestamp: ISO }), NOW).usable).toBe(false)
  })

  it('缺行情返回 missing_quote', () => {
    const j = judgeQuote(undefined, NOW)
    expect(j.usable).toBe(false)
    if (!j.usable) expect(j.reason).toBe('missing_quote')
  })
})

describe('汇总：总资产 / 总负债 / 净资产', () => {
  it('按资产类别拆分已可靠估值部分', () => {
    const p = assetClassMix()
    const t = calculateTotals({ portfolio: p, fx: createFxTable(cnyRates()), now: NOW })
    expect(t.totalAssets).toBe(100000)
    expect(t.reliableByAssetClass.cash).toBe(50000)
    expect(t.reliableByAssetClass.equity).toBe(30000)
    expect(t.reliableByAssetClass.fixed_income).toBe(15000)
    expect(t.reliableByAssetClass.gold).toBe(5000)
    expect(t.reliableCount).toBe(4)
    expect(t.isComplete).toBe(true)
  })

  it('负债不计入资产，净资产正确', () => {
    const acct = makeAccount({ id: 'a1' })
    const cash = makeInstrument({ id: 'i1', assetClass: 'cash', currency: 'CNY' })
    const debt = makeInstrument({ id: 'i2', assetClass: 'liability', currency: 'CNY', instrumentType: 'other' })
    const p = makePortfolio({
      accounts: [acct],
      instruments: [cash, debt],
      holdings: [
        makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', manualValue: 100000 }),
        makeHolding({ id: 'h2', accountId: 'a1', instrumentId: 'i2', manualValue: 40000 }),
      ],
    })
    const t = calculateTotals({ portfolio: p, now: NOW })
    expect(t.totalAssets).toBe(100000)
    expect(t.totalLiabilities).toBe(40000)
    expect(t.netWorth).toBe(60000)
    // 负债不进入按类别拆分
    expect(t.reliableByAssetClass.liability).toBeUndefined()
  })

  it('负债的正负号不影响口径（按绝对值计入）', () => {
    const acct = makeAccount({ id: 'a1' })
    const debt = makeInstrument({ id: 'i2', assetClass: 'liability', currency: 'CNY' })
    const p = makePortfolio({
      accounts: [acct],
      instruments: [debt],
      holdings: [makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i2', manualValue: -40000 })],
    })
    const t = calculateTotals({ portfolio: p, now: NOW })
    expect(t.totalLiabilities).toBe(40000)
    expect(t.netWorth).toBe(-40000)
  })
})

describe('汇总：多币种（CNY + USD + HKD + SGD）', () => {
  it('FX 齐全时四币种正确折算', () => {
    const { portfolio } = multiCurrencyAccount()
    const t = calculateTotals({ portfolio, fx: createFxTable(cnyRates()), now: NOW })
    // 10000 CNY + 1000×7.2 + 5000×0.92 + 2000×5.4 = 10000 + 7200 + 4600 + 10800
    expect(t.totalAssets).toBeCloseTo(10000 + 7200 + 4600 + 10800, 6)
    expect(t.isComplete).toBe(true)
    expect(t.unavailableCount).toBe(0)
  })

  it('【核心】FX 全部缺失时，外币不得按 1:1 计入，且如实上报不可估值', () => {
    const { portfolio } = multiCurrencyAccount()
    const t = calculateTotals({ portfolio, fx: createFxTable([]), now: NOW })

    // 只有人民币那 10000 计入
    expect(t.totalAssets).toBe(10000)
    // 关键断言：绝不是 10000+1000+5000+2000 = 18000（1:1 的错误结果）
    expect(t.totalAssets).not.toBe(18000)
    expect(t.unavailableCount).toBe(3)
    expect(t.isComplete).toBe(false)
    expect(t.unavailableItems.map((i) => i.currency).sort()).toEqual(['HKD', 'SGD', 'USD'])
    for (const item of t.unavailableItems) {
      expect(item.reasons).toContain('missing_fx')
    }
  })

  it('【核心】部分币种缺失时，只缺的那部分不计入', () => {
    const { portfolio } = multiCurrencyAccount()
    // 只给 USD 汇率
    const partial = createFxTable([makeFxRate('USD', 'CNY', 7.2, { timestamp: ISO })])
    const t = calculateTotals({ portfolio, fx: partial, now: NOW })
    expect(t.totalAssets).toBeCloseTo(10000 + 7200, 6)
    expect(t.unavailableCount).toBe(2) // HKD, SGD
    expect(t.reliableCount).toBe(2)
  })

  it('FX 过期 → 标记 stale，且不计入总额', () => {
    const { portfolio } = multiCurrencyAccount()
    const stale = createFxTable([
      makeFxRate('USD', 'CNY', 7.2, { timestamp: new Date(NOW - 48 * 3600 * 1000).toISOString() }),
      makeFxRate('HKD', 'CNY', 0.92, { timestamp: new Date(NOW - 48 * 3600 * 1000).toISOString() }),
      makeFxRate('SGD', 'CNY', 5.4, { timestamp: new Date(NOW - 48 * 3600 * 1000).toISOString() }),
    ])
    const t = calculateTotals({ portfolio, fx: stale, now: NOW })
    expect(t.totalAssets).toBe(10000)
    expect(t.staleCount).toBe(3)
    expect(t.unavailableCount).toBe(0)
    expect(t.isComplete).toBe(false)
  })
})

describe('汇总：多资产类别同一账户', () => {
  it('一个账户内的多类别资产被正确分类汇总', () => {
    const p = assetClassMix()
    const accountIds = new Set(p.holdings.map((h) => h.accountId))
    expect(accountIds.size).toBe(1) // 全部持仓在同一账户
    const t = calculateTotals({ portfolio: p, now: NOW })
    expect(Object.keys(t.reliableByAssetClass).sort()).toEqual(['cash', 'equity', 'fixed_income', 'gold'])
  })
})

describe('汇总：结构化输出让 UI 能区分三类', () => {
  it('同时存在 可靠 / 不可估值 / 过期 三种项目', () => {
    const acct = makeAccount({ id: 'a1' })
    const okInst = makeInstrument({ id: 'i_ok', assetClass: 'cash', currency: 'CNY' })
    const noFxInst = makeInstrument({ id: 'i_nofx', assetClass: 'cash', currency: 'USD' })
    const staleInst = makeInstrument({ id: 'i_stale', assetClass: 'equity', currency: 'CNY', instrumentType: 'etf' })

    const p = makePortfolio({
      accounts: [acct],
      instruments: [okInst, noFxInst, staleInst],
      holdings: [
        makeHolding({ id: 'h_ok', accountId: 'a1', instrumentId: 'i_ok', manualValue: 5000 }),
        makeHolding({ id: 'h_nofx', accountId: 'a1', instrumentId: 'i_nofx', manualValue: 1000 }),
        makeHolding({ id: 'h_stale', accountId: 'a1', instrumentId: 'i_stale', valuationMode: 'quantity', quantity: 10 }),
      ],
      quotes: [makeQuote({ id: 'q1', instrumentId: 'i_stale', marketPrice: 100, status: 'STALE', timestamp: ISO })],
    })

    const t = calculateTotals({ portfolio: p, fx: createFxTable([]), now: NOW })
    expect(t.reliableCount).toBe(1)
    expect(t.reliableByAssetClass.cash).toBe(5000)
    expect(t.unavailableCount).toBe(1)
    expect(t.staleCount).toBe(1)
    expect(t.totalAssets).toBe(5000)
    expect(t.totalHoldings).toBe(3)
    expect(t.isComplete).toBe(false)

    // UI 需要的三组信息都在
    expect(t.unavailableItems[0].reasons).toContain('missing_fx')
    expect(t.staleItems[0].reasons).toContain('stale_quote')
    expect(t.staleItems[0].displayValue).toBe(1000) // 展示值保留，但不计入
  })

  it('describeTotals 明确告知未计入的项目数', () => {
    const { portfolio } = multiCurrencyAccount()
    const t = calculateTotals({ portfolio, fx: createFxTable([]), now: NOW })
    const text = describeTotals(t)
    expect(text).toContain('3 项无法估值')
    expect(text).toContain('未计入总额')

    const complete = calculateTotals({ portfolio, fx: createFxTable(cnyRates()), now: NOW })
    expect(describeTotals(complete)).toContain('已全部可靠估值')
  })

  it('空组合返回全 0 且 isComplete 为 true', () => {
    const t = calculateTotals({ portfolio: makePortfolio(), now: NOW })
    expect(t.totalAssets).toBe(0)
    expect(t.netWorth).toBe(0)
    expect(t.totalHoldings).toBe(0)
    expect(t.isComplete).toBe(true)
  })
})
