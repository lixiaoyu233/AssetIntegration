import { describe, expect, it } from 'vitest'
import type { Category, Portfolio } from '../types/asset'
import { detectFundClass, effectiveFundClass, summarize } from './calc'
import {
  ALL_WEATHER_ORIGINAL,
  BUILTIN_STRATEGIES,
  CLASS_EQUIVALENTS,
  createCustomStrategy,
  isStrategyValid,
  strategyTotal,
} from './strategies'
import {
  computeAllocations,
  computeRebalance,
  createDefaultSettings,
  defaultMappingFor,
  effectiveMapping,
  healthFor,
  rebalanceWithSettings,
  resolveStrategy,
  shortStrategyName,
  statusLine,
} from './rebalance'
import { normalizeSettings } from '../hooks/useStrategy'

/* ------------------------------------------------------------------ *
 * 测试数据
 * ------------------------------------------------------------------ */

function makePortfolio(partial: Partial<Record<string, Array<Record<string, unknown>>>>): Portfolio {
  const [cash = [], stock = [], fund = [], gold = [], debt = []] = [
    partial.cash ?? [],
    partial.stock ?? [],
    partial.fund ?? [],
    partial.gold ?? [],
    partial.debt ?? [],
  ]
  return {
    version: 2,
    history: [],
    categories: [
      { id: 'cat_cash', name: '现金与固定资产', subtitle: '', icon: 'banknote', color: '#f0b90b', items: cash as never },
      { id: 'cat_stock', name: '股票', subtitle: '', icon: 'trending-up', color: '#3b82f6', items: stock as never },
      { id: 'cat_fund', name: '基金', subtitle: '', icon: 'chart-pie', color: '#22c55e', items: fund as never },
      { id: 'cat_gold', name: '黄金', subtitle: '', icon: 'gem', color: '#eab308', items: gold as never },
      {
        id: 'cat_debt',
        name: '负债',
        subtitle: '',
        icon: 'credit-card',
        color: '#ef4444',
        isLiability: true,
        items: debt as never,
      },
    ],
  }
}

const amount = (id: string, name: string, value: number) => ({ id, kind: 'amount', name, amount: value })

/** 用「已公布净值」构造基金，避免依赖行情接口 */
const fundItem = (id: string, code: string, name: string, shares: number, costNav: number, nav: number) => ({
  id,
  kind: 'fund',
  name,
  code,
  shares,
  costNav,
  quote: { code, name, publishedNav: nav, fetchedAt: Date.now(), source: 'test' },
})

/** 上一轮实际遇到过的真实组合（178 万） */
function realisticPortfolio(): Portfolio {
  return makePortfolio({
    cash: [amount('a1', '招行活期', 86000), amount('a2', '自住房', 2350000)],
    stock: [amount('s1', '沪深300ETF', 52400)],
    fund: [
      fundItem('f1', '161725', '招商中证白酒指数(LOF)A', 12000, 0.492, 0.5314),
      fundItem('f2', '005827', '易方达蓝筹精选混合', 3000, 1.612, 1.4573),
    ],
    gold: [{ id: 'g1', kind: 'gold', name: '工行积存金', grams: 60, pricePerGram: 618 }],
    debt: [amount('d1', '招行闪电贷', 120000), amount('d2', '信用卡账单', 8400)],
  })
}

/* ------------------------------------------------------------------ *
 * 策略定义
 * ------------------------------------------------------------------ */

describe('内置策略', () => {
  it('三档内置策略目标比例合计都是 100%', () => {
    for (const s of BUILTIN_STRATEGIES) {
      expect(isStrategyValid(s).ok, `${s.name} 合计应为 100%，实际 ${strategyTotal(s)}`).toBe(true)
    }
  })

  it('全天候策略：原始五类按 95% 缩放，另加 5% 现金', () => {
    const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!
    const map = Object.fromEntries(aw.classes.map((c) => [c.name, c.target]))
    expect(map).toEqual({
      股票: 28.5,
      长期国债: 38,
      中期国债: 14.25,
      黄金: 7.125,
      大宗商品: 7.125,
      现金: 5,
    })
    // 去掉现金后应还原为桥水的 30/40/15/7.5/7.5 比例
    const scaled = map['股票'] / 0.95
    expect(scaled).toBeCloseTo(30, 6)
    expect(map['长期国债'] / 0.95).toBeCloseTo(40, 6)
    expect(strategyTotal(aw)).toBeCloseTo(100, 6)
    expect(ALL_WEATHER_ORIGINAL).toContain('股票 30%')
  })

  it('永久组合与 60/40 的类别与比例符合需求', () => {
    const pm = BUILTIN_STRATEGIES.find((s) => s.id === 'permanent')!
    expect(Object.fromEntries(pm.classes.map((c) => [c.name, c.target]))).toEqual({
      股票: 25,
      长期国债: 25,
      黄金: 25,
      现金: 25,
    })
    const c64 = BUILTIN_STRATEGIES.find((s) => s.id === 'classic-60-40')!
    expect(Object.fromEntries(c64.classes.map((c) => [c.name, c.target]))).toEqual({ 股票: 60, 债券: 40 })
  })

  it('校验自定义策略：合计必须 100%', () => {
    const s = createCustomStrategy()
    expect(isStrategyValid(s).ok).toBe(true)
    s.classes[0].target = 70
    const bad = isStrategyValid(s)
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('100')
    s.classes = []
    expect(isStrategyValid(s).ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 基金类型识别
 * ------------------------------------------------------------------ */

describe('基金资产类型识别', () => {
  it('识别债券型（含可转债的例外）', () => {
    for (const n of ['易方达纯债债券A', '招商中短债债券C', '博时信用债券', '国债ETF联接', '某某固收+']) {
      expect(detectFundClass(n), n).toBe('bond')
    }
    // 可转债基金本质偏债，不应被「股」字误导
    expect(detectFundClass('兴全可转债混合')).toBe('bond')
  })

  it('识别股票型 / 货币型 / 商品型', () => {
    expect(detectFundClass('招商中证白酒指数(LOF)A')).toBe('equity')
    expect(detectFundClass('易方达蓝筹精选混合')).toBe('mixed')
    expect(detectFundClass('天弘余额宝货币')).toBe('money')
    expect(detectFundClass('华安黄金ETF联接A')).toBe('commodity')
    expect(detectFundClass('')).toBe('unknown')
  })

  it('用户手动标记优先于名称识别', () => {
    const item = {
      id: 'x',
      kind: 'fund' as const,
      name: '招商中证白酒指数(LOF)A',
      code: '161725',
      shares: 1,
      costNav: 1,
      assetClass: 'bond' as const,
    }
    expect(effectiveFundClass(item)).toBe('bond')
    const { assetClass: _drop, ...withoutMark } = item
    void _drop
    expect(effectiveFundClass(withoutMark)).toBe('equity')
  })
})

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */

describe('分类到策略类别的映射', () => {
  const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!
  const cat = (id: string, name: string): Category => ({
    id,
    name,
    subtitle: '',
    icon: 'wallet',
    color: '#f0b90b',
    items: [],
  })
  const cash = cat('cat_cash', '现金与固定资产')

  it('内置分类走默认映射', () => {
    expect(defaultMappingFor(aw, cat('cat_gold', '黄金'))).toEqual([{ strategyClassId: 'gold', percent: 100 }])
    expect(defaultMappingFor(aw, cash)).toEqual([{ strategyClassId: 'cash', percent: 100 }])
    const permanent = BUILTIN_STRATEGIES.find((s) => s.id === 'permanent')!
    expect(defaultMappingFor(permanent, cash)).toEqual([{ strategyClassId: 'cash', percent: 100 }])
  })

  it('自定义分类按名称关键词兜底', () => {
    // 「数字货币」命中「货币」关键词 -> 现金
    expect(defaultMappingFor(aw, cat('cat_x', '数字货币'))).toEqual([{ strategyClassId: 'cash', percent: 100 }])
    // 完全没命中关键词时，兜底到目标占比最大的类别（全天候是长期国债 38%）
    const art = cat('cat_art', '收藏与另类')
    expect(defaultMappingFor(aw, art)).toEqual([{ strategyClassId: 'bond-long', percent: 100 }])

    const bondCat = cat('cat_y', '企业债')
    expect(defaultMappingFor(aw, bondCat)).toEqual([{ strategyClassId: 'bond-long', percent: 100 }])
  })

  it('策略切换后失效的类别 id 会迁移到同义类别', () => {
    // 「债券」在 60/40 里存在，在永久组合里不存在 -> 迁移到长期国债
    const user = { cat_cash: [{ strategyClassId: 'bond', percent: 100 }] }
    const permanent = BUILTIN_STRATEGIES.find((s) => s.id === 'permanent')!
    expect(effectiveMapping(permanent, cash, user)).toEqual([{ strategyClassId: 'bond-long', percent: 100 }])
    expect(CLASS_EQUIVALENTS.bond).toContain('bond-long')
    // 反向：用户映射到「现金」，切到全天候（也有现金）时保持不变
    const aw2 = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!
    expect(effectiveMapping(aw2, cash, { cat_cash: [{ strategyClassId: 'cash', percent: 100 }] })).toEqual([
      { strategyClassId: 'cash', percent: 100 },
    ])
  })

  it('百分比合计不为 100 时自动归一化', () => {
    const user = { cat_cash: [{ strategyClassId: 'stock', percent: 80 }, { strategyClassId: 'gold', percent: 80 }] }
    const entries = effectiveMapping(aw, cash, user)
    expect(entries.reduce((s, e) => s + e.percent, 0)).toBeCloseTo(100, 6)
    expect(entries.map((e) => e.percent)).toEqual([50, 50])
  })
})

/* ------------------------------------------------------------------ *
 * 分配
 * ------------------------------------------------------------------ */

describe('分类市值分配到策略类别', () => {
  it('基金按资产类型拆分到股票与债券', () => {
    const p = makePortfolio({
      cash: [amount('a1', '活期', 300000)],
      stock: [amount('s1', '沪深300ETF', 100000)],
      fund: [
        fundItem('f1', '161725', '招商中证白酒指数A', 1000, 1, 1), // 股票型 1000
        fundItem('f2', '000001', '易方达纯债债券A', 1000, 1, 1), // 债券型 1000
      ],
      gold: [{ id: 'g1', kind: 'gold', name: '黄金', grams: 100, pricePerGram: 100 }], // 10000
    })
    const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!
    const alloc = computeAllocations({
      portfolio: p,
      strategy: aw,
      includeLiabilities: false,
      unmappedPolicy: 'auto',
    })
    expect(alloc.byClass.stock).toBeCloseTo(101000, 6) // 10 万股票 + 1000 股票型基金
    // 债券型基金有「长期国债 / 中期国债」两个候选，取目标占比更大的长期国债（38% > 14.25%）
    expect(alloc.byClass['bond-long']).toBeCloseTo(1000, 6)
    expect(alloc.byClass['bond-mid']).toBeCloseTo(0, 6)
    // 现金类照旧全额进现金
    expect(alloc.byClass.cash).toBeCloseTo(300000, 6)
    expect(alloc.byClass.gold).toBeCloseTo(10000, 6)
    expect(alloc.byClass.cash).toBeCloseTo(300000, 6)
    expect(alloc.total).toBeCloseTo(412000, 6)
  })

  it('负债默认不进分母，开启后从分母扣除', () => {
    const p = makePortfolio({ cash: [amount('a1', '活期', 500000)], debt: [amount('d1', '房贷', 100000)] })
    const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!
    const off = computeAllocations({ portfolio: p, strategy: aw, includeLiabilities: false, unmappedPolicy: 'auto' })
    expect(off.total).toBeCloseTo(500000, 6)
    expect(off.liabilityDeducted).toBe(0)

    const on = computeAllocations({ portfolio: p, strategy: aw, includeLiabilities: true, unmappedPolicy: 'auto' })
    expect(on.liabilityDeducted).toBeCloseTo(100000, 6)
    expect(on.total).toBeCloseTo(400000, 6)
  })
})

/* ------------------------------------------------------------------ *
 * 再平衡
 * ------------------------------------------------------------------ */

describe('再平衡计算', () => {
  const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!

  it('偏离度 = 实际 − 目标，阈值内标为正常', () => {
    // 总资产 100 万，股票 30 万 -> 正好 30%
    const p = makePortfolio({ stock: [amount('s1', '沪深300ETF', 285000)], cash: [amount('a1', '活期', 715000)] })
    const r = computeRebalance(p, aw, { threshold: 5, includeLiabilities: false, unmappedPolicy: 'auto' })
    const stock = r.classes.find((c) => c.classId === 'stock')!
    expect(stock.actualWeight).toBeCloseTo(0.285, 6)
    expect(stock.deviationPoints).toBeCloseTo(0, 6)
    expect(stock.action).toBe('hold')
    // 现金类实际 71.5%，目标 5% -> 超配 66.5 个百分点，建议减仓
    const cash = r.classes.find((c) => c.classId === 'cash')!
    expect(cash.action).toBe('sell')
    expect(cash.deviationPoints).toBeCloseTo(66.5, 6)
  })

  it('总偏离率 = Σ|偏离| / 2，用于健康度', () => {
    const p = makePortfolio({ stock: [amount('s1', '股票', 600000)], cash: [amount('a1', '现金', 400000)] })
    const r = computeRebalance(p, aw, { threshold: 5, includeLiabilities: false, unmappedPolicy: 'auto' })
    // 股票 +31.5、现金 +35、长债 −38、中债 −14.25、黄金 −7.125、商品 −7.125
    // Σ|偏离| = 133 -> 总偏离率 = 66.5
    expect(r.totalDeviationPoints).toBeCloseTo(66.5, 4)
    expect(r.health).toBe('critical')
    expect(r.healthLabel).toBe('严重偏离')
  })

  it('阈值可调：阈值越小越敏感，阈值越高越宽松', () => {
    const p = makePortfolio({
      stock: [amount('s1', '沪深300ETF', 310000)], // 目标 30%，偏离 +1%
      cash: [amount('a1', '活期', 690000)],
    })
    const build = (threshold: number) =>
      computeRebalance(p, aw, { threshold, includeLiabilities: false, unmappedPolicy: 'auto' })
    const actionable = (r: ReturnType<typeof build>) => r.classes.filter((c) => c.action !== 'hold').length

    // 阈值 0：任何非零偏离都要动作（6 个类别）
    expect(actionable(build(0))).toBe(6)
    // 阈值 5：命中目标的股票算正常
    const mid = build(5)
    expect(mid.classes.find((c) => c.classId === 'stock')!.action).toBe('hold')
    // 阈值 100：全部视为正常
    expect(actionable(build(100))).toBe(0)
  })

  it('买入金额受卖出能力约束，不会凭空多出资金', () => {
    // 现金 200 万严重超配，其他为 0 -> 需要减仓现金去补 4 个低配类别
    const p = makePortfolio({ cash: [amount('a1', '活期', 2000000)] })
    const r = computeRebalance(p, aw, { threshold: 5, includeLiabilities: false, unmappedPolicy: 'auto' })
    expect(r.classes.find((c) => c.classId === 'cash')!.action).toBe('sell')
    expect(r.classes.filter((c) => c.action === 'buy').length).toBe(5)
    // 现金类无法提供减仓标的（只有基金能部分卖出），所以买入金额应为 0
    expect(r.plannedBuy).toBeCloseTo(0, 6)
    expect(r.plannedSell).toBeCloseTo(0, 6)
  })

  it('现金 + 基金混合时，能挤出可执行金额并按缺口排序分配', () => {
    // 股票 55 万（超配 25pp）、现金 15 万（低配 15pp）、其余为 0
    const p = makePortfolio({
      stock: [fundItem('s1', '510300', '沪深300ETF', 100000, 5, 5.5)], // 55 万
      cash: [amount('a1', '活期', 150000)],
    })
    const r = computeRebalance(p, aw, { threshold: 5, includeLiabilities: false, unmappedPolicy: 'auto' })
    const stock = r.classes.find((c) => c.classId === 'stock')!
    const cash = r.classes.find((c) => c.classId === 'cash')!
    expect(stock.action).toBe('sell')
    expect(stock.sellCandidates.length).toBe(1)
    expect(stock.sellCandidates[0].name).toBe('沪深300ETF')

    // 总资产 70 万：股票实际 55 万，现金实际 15 万
    const total = 700000
    const stockTarget = 0.285 * total
    const cashTarget = 0.05 * total
    // 可动用资金只算「能卖出的标的」：活期存款不能按比例卖，所以 sellCapacity 只含股票基金
    expect(r.sellCapacity).toBeCloseTo(550000, 4)
    expect(stockTarget).toBeLessThan(550000)
    expect(150000 - cashTarget).toBeGreaterThan(0) // 现金确实超配，但不可动用

    // 低配总额（长债/中债/黄金/商品）大于可卖出的超配金额 -> 只能按比例补一部分
    const totalBuyNeed = r.classes.filter((c) => c.action === 'buy').reduce((s2, c) => s2 + c.gapAmount, 0)
    expect(totalBuyNeed).toBeCloseTo(465500, 2)
    // 卖出合计 = 买入合计 = min(低配缺口, 可卖出市值)
    const fundable = Math.min(totalBuyNeed, 550000)
    expect(r.plannedSell).toBeCloseTo(fundable, 2)
    expect(r.plannedBuy).toBeCloseTo(fundable, 2)
    // 股票类可卖标的充足，减仓额就是实际要卖出的总额
    expect(stock.adjustAmount).toBeCloseTo(-fundable, 2)
    // 现金类超配但没有可卖出标的 -> 不产生减仓金额
    expect(cash.adjustAmount).toBeCloseTo(0, 4)

    // 每类买入额 = 缺口 × (可动用 / 总缺口)
    const scale = fundable / totalBuyNeed
    const longBond = r.classes.find((c) => c.classId === 'bond-long')!
    expect(longBond.adjustAmount).toBeCloseTo(longBond.gapAmount * scale, 2)
  })

  it('减仓明细给出实现盈亏', () => {
    const p = makePortfolio({
      stock: [fundItem('s1', '510300', '沪深300ETF', 100000, 4, 5.5)], // 成本 40 万，市值 55 万，浮盈 15 万
      cash: [amount('a1', '活期', 150000)],
    })
    const r = computeRebalance(p, aw, { threshold: 5, includeLiabilities: false, unmappedPolicy: 'auto' })
    const cand = r.classes.find((c) => c.classId === 'stock')!.sellCandidates[0]
    expect(cand.profit).toBeCloseTo(150000, 4)
    // 股票类是唯一超配类别，减仓额应等于该类的 adjustAmount
    const stockCls = r.classes.find((c) => c.classId === 'stock')!
    expect(cand.sellAmount).toBeCloseTo(Math.abs(stockCls.adjustAmount), 2)
    // 实盈 = 浮盈 × 卖出比例
    expect(cand.realizedProfit).toBeCloseTo(150000 * (cand.sellAmount / cand.value), 2)
    // 绝不能出现「建议卖出 > 持仓市值」
    expect(cand.sellAmount).toBeLessThanOrEqual(cand.value + 0.01)
  })

  it('空组合不崩溃，且提示先登记资产', () => {
    const p = makePortfolio({})
    const r = computeRebalance(p, aw, { threshold: 5, includeLiabilities: false, unmappedPolicy: 'auto' })
    expect(r.totalForAllocation).toBe(0)
    expect(r.classes.every((c) => c.actualWeight === 0)).toBe(true)
    // 所有类别实际占比都是 0，Σ|目标| = 100% -> 总偏离率 = 50%
    expect(r.totalDeviationPoints).toBeCloseTo(50, 6)
    expect(r.classes).toHaveLength(6)
    for (const c of r.classes) expect(Number.isFinite(c.adjustAmount)).toBe(true)
  })

  it('健康度分级边界', () => {
    expect(healthFor(0).level).toBe('healthy')
    expect(healthFor(0.03).level).toBe('healthy')
    expect(healthFor(0.05).level).toBe('watch')
    expect(healthFor(0.1).level).toBe('warning')
    expect(healthFor(0.3).level).toBe('critical')
  })

  it('真实组合：占比之和为 100%，且状态文案包含策略与偏离度', () => {
    const p = realisticPortfolio()
    const r = computeRebalance(p, aw, { threshold: 5, includeLiabilities: false, unmappedPolicy: 'auto' })
    const sum = r.classes.reduce((s, c) => s + c.actualWeight, 0)
    expect(sum).toBeCloseTo(1, 6)
    // 负债默认不计入分母
    expect(r.totalForAllocation).toBeCloseTo(summarize(p).totalAssets, 4)
    const line = statusLine(r)
    expect(line).toMatch(/^当前策略：全天候策略 · 偏离度 \d+\.\d% · /)
    expect(shortStrategyName('全天候策略（桥水）')).toBe('全天候策略')
  })

  it('未映射分类会被兜底，金额不会凭空消失', () => {
    const p = makePortfolio({ cash: [amount('a1', '活期', 100000)] })
    p.categories.push({
      id: 'cat_custom',
      name: '我的另类资产',
      subtitle: '',
      icon: 'wallet',
      color: '#fff',
      items: [amount('c1', '藏品', 50000)],
    } as never)
    const r = computeRebalance(p, aw, { threshold: 99, includeLiabilities: false, unmappedPolicy: 'auto' })
    expect(r.totalForAllocation).toBeCloseTo(150000, 4)
  })
})

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

describe('策略设置持久化结构', () => {
  it('默认设置为全天候 + 5% 阈值', () => {
    const s = createDefaultSettings()
    expect(s.activeStrategyId).toBe('all-weather')
    expect(s.threshold).toBe(5)
    expect(s.includeLiabilities).toBe(false)
    expect(resolveStrategy(s).name).toContain('全天候')
  })

  it('脏数据被规范化，不抛错', () => {
    const s = normalizeSettings({
      activeStrategyId: 'custom_x',
      threshold: 999,
      customStrategies: [{ id: 'custom_x', name: '我的策略', classes: [{ id: 'a', name: '股', target: 100 }] }],
      mappings: { 'all-weather': { cat_cash: [{ strategyClassId: 'stock', percent: 'abc' }, { strategyClassId: 'gold', percent: 20 }] } },
      unmappedPolicy: 'weird',
    })
    expect(s.threshold).toBe(50) // 夹紧到上限
    expect(s.unmappedPolicy).toBe('auto')
    expect(s.mappings['all-weather'].cat_cash).toEqual([{ strategyClassId: 'gold', percent: 20 }])
    expect(resolveStrategy(s).name).toBe('我的策略')
    expect(s.customStrategies[0].kind).toBe('custom')
  })

  it('找不到策略时回退到内置策略', () => {
    const s = normalizeSettings({ activeStrategyId: 'not-exist' })
    const resolved = resolveStrategy(s)
    expect(resolved.id).toBe('all-weather')
    expect(resolved.name).toContain('全天候')
  })

  it('rebalanceWithSettings 与手动 computeRebalance 结果一致', () => {
    const p = realisticPortfolio()
    const settings = { ...createDefaultSettings(), threshold: 3 }
    const viaSettings = rebalanceWithSettings(p, settings)
    const manual = computeRebalance(p, resolveStrategy(settings), {
      threshold: 3,
      includeLiabilities: false,
      unmappedPolicy: 'auto',
      mapping: undefined,
    })
    expect(viaSettings.totalDeviationPoints).toBeCloseTo(manual.totalDeviationPoints, 6)
    expect(viaSettings.plannedSell).toBeCloseTo(manual.plannedSell, 6)
  })
})
