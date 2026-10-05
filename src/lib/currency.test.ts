import { describe, expect, it } from 'vitest'
import type { Portfolio } from '../types/asset'
import {
  CURRENCIES,
  CURRENCY_CODES,
  currencyDecimals,
  currencySymbol,
  describeRates,
  formatCurrencyAmount,
  formatCurrencyWithSymbol,
  fromCny,
  hasUsableRates,
  isCurrencyCode,
  isFxStale,
  scaleHint,
  scaleHintText,
  toCny,
  type FxRates,
} from './currency'
import { parseBackup, parsePrimary } from './fx'
import { categoryTotal, collectCurrencies, fxExposure, summarize, valuate } from './calc'
import { mergeDefaultCategories, createDefaultCategories } from './defaults'
import { normalizePortfolio } from './storage'
import { computeRebalance } from './rebalance'
import { BUILTIN_STRATEGIES } from './strategies'

/** 构造汇率：perCny = 1 人民币 = ? 该币种 */
function rates(perCny: Partial<Record<string, number>>, fetchedAt = Date.now()): FxRates {
  return { perCny: { CNY: 1, ...perCny }, fetchedAt, source: 'test' }
}

describe('币种表', () => {
  it('包含确认过的常用币种，且人民币在首位', () => {
    expect(CURRENCY_CODES.slice(0, 5)).toEqual(['CNY', 'USD', 'HKD', 'SGD', 'JPY'])
    for (const expected of ['EUR', 'GBP', 'AUD', 'KRW', 'TWD', 'CAD']) {
      expect(CURRENCY_CODES).toContain(expected)
    }
    expect(CURRENCY_CODES).toHaveLength(11)
  })

  it('每个币种都有符号与小数位', () => {
    for (const c of CURRENCIES) {
      expect(c.symbol.length).toBeGreaterThan(0)
      expect(c.decimals).toBeGreaterThanOrEqual(2)
    }
    // 日元面额小，原币保留 4 位，避免显示成一堆 0
    expect(currencyDecimals('JPY')).toBe(4)
    expect(currencyDecimals('CNY')).toBe(2)
  })

  it('币种代码校验只认白名单', () => {
    expect(isCurrencyCode('USD')).toBe(true)
    expect(isCurrencyCode('usd')).toBe(false)
    expect(isCurrencyCode('XXX')).toBe(false)
    expect(isCurrencyCode(undefined)).toBe(false)
  })

  it('金额格式化按币种决定小数位并带符号', () => {
    expect(formatCurrencyAmount(1234.5, 'CNY')).toBe('1,234.50')
    expect(formatCurrencyWithSymbol(1234.5, 'USD')).toBe('$1,234.50')
    expect(formatCurrencyAmount(123456.789, 'JPY')).toBe('123,456.7890')
    expect(currencySymbol('HKD')).toBe('HK$')
  })
})

describe('金额量级提示', () => {
  it('按数值落在正确的量级', () => {
    expect(scaleHint(0).label).toBe('元')
    expect(scaleHint(999).label).toBe('元')
    expect(scaleHint(1_000).label).toBe('千')
    expect(scaleHint(9_999).label).toBe('千')
    expect(scaleHint(10_000).label).toBe('万')
    expect(scaleHint(99_999).label).toBe('万')
    expect(scaleHint(100_000).label).toBe('十万')
    expect(scaleHint(999_999).label).toBe('十万')
    expect(scaleHint(1_000_000).label).toBe('百万')
    expect(scaleHint(9_999_999).label).toBe('百万')
    expect(scaleHint(10_000_000).label).toBe('千万')
    expect(scaleHint(88_000_000).label).toBe('千万')
  })

  it('负数与非法值也安全', () => {
    expect(scaleHint(-50_000).label).toBe('万') // 取绝对值后是 5 万
    expect(scaleHint(-1_500_000).label).toBe('百万')
    expect(scaleHint(NaN).label).toBe('元')
    // 非有限值按 0 处理（刻意的防御，避免 NaN 传染到界面）
    expect(scaleHint(Infinity).label).toBe('元')
  })

  it('文案：不足千元时给出友好提示', () => {
    expect(scaleHintText(500)).toBe('不足千元')
    expect(scaleHintText(12_345)).toBe('万位')
    expect(scaleHintText(1_200_000)).toBe('百万位')
  })
})

describe('汇率换算', () => {
  const r = rates({ USD: 0.15, HKD: 1.17, SGD: 0.19, JPY: 23.5 })

  it('人民币原样返回', () => {
    expect(toCny(100, 'CNY', r)).toBe(100)
    expect(toCny(100, 'CNY', null)).toBe(100)
  })

  it('外币按 perCny 折算（用除法）', () => {
    // 1 USD = 1/0.15 ≈ 6.6667 元
    expect(toCny(100, 'USD', r)).toBeCloseTo(100 / 0.15, 6)
    expect(toCny(1000, 'HKD', r)).toBeCloseTo(1000 / 1.17, 6)
    expect(toCny(10000, 'JPY', r)).toBeCloseTo(10000 / 23.5, 6)
  })

  it('反向换算可用于校验', () => {
    expect(fromCny(666.6667, 'USD', r)).toBeCloseTo(100, 3)
  })

  it('缺少汇率时返回 undefined，而不是静默当成 0 或原值', () => {
    expect(toCny(100, 'USD', null)).toBeUndefined()
    expect(toCny(100, 'USD', rates({}))).toBeUndefined()
    expect(toCny(100, 'USD', rates({ USD: 0 }))).toBeUndefined()
    expect(toCny(NaN, 'USD', r)).toBeUndefined()
  })

  it('过期判断与可用性', () => {
    const now = Date.now()
    expect(isFxStale(rates({ USD: 0.15 }, now), now)).toBe(false)
    // 25 小时前
    expect(isFxStale(rates({ USD: 0.15 }, now - 25 * 60 * 60 * 1000), now)).toBe(true)
    // 23 小时前仍算新鲜
    expect(isFxStale(rates({ USD: 0.15 }, now - 23 * 60 * 60 * 1000), now)).toBe(false)
    expect(isFxStale(null, now)).toBe(true)
    expect(hasUsableRates(rates({ USD: 0.15 }))).toBe(true)
    expect(hasUsableRates(rates({}))).toBe(false)
    expect(hasUsableRates(null)).toBe(false)
  })

  it('来源时间可读', () => {
    expect(describeRates(null)).toBe('暂无汇率')
    expect(describeRates(rates({ USD: 0.15 }, new Date(2026, 9, 3, 14, 5).getTime()))).toBe('2026-10-03 14:05')
  })
})

describe('汇率接口解析', () => {
  it('主接口：只保留白名单币种', () => {
    const parsed = parsePrimary({
      result: 'success',
      time_last_update_utc: 'Sat, 03 Oct 2026 00:02:32 +0000',
      rates: { USD: 0.1489, HKD: 1.1686, SGD: 0.1902, JPY: 23.4948, XXX: 9, VND: 3900 },
    })
    expect(parsed.perCny.USD).toBeCloseTo(0.1489, 6)
    expect(parsed.perCny.JPY).toBeCloseTo(23.4948, 6)
    expect(parsed.perCny.CNY).toBe(1)
    // 不在白名单里的币种不应被写进缓存
    expect((parsed.perCny as Record<string, number>).VND).toBeUndefined()
    expect(parsed.source).toBe('open.er-api.com')
  })

  it('备用接口：小写键名也能解析', () => {
    const parsed = parseBackup({ date: '2026-10-03', cny: { usd: 0.1489, hkd: 1.1686, jpy: 23.4948 } })
    expect(parsed.perCny.USD).toBeCloseTo(0.1489, 6)
    expect(parsed.source).toBe('jsdelivr/currency-api')
    expect(parsed.updatedAt).toBe('2026-10-03')
  })

  it('格式异常时抛错（由上层降级处理）', () => {
    expect(() => parsePrimary({ result: 'error' })).toThrow()
    expect(() => parsePrimary(null)).toThrow()
    expect(() => parseBackup({ foo: 1 })).toThrow()
    // 只有一个 CNY 说明没拿到任何目标币种，也视为失败
    expect(() => parsePrimary({ result: 'success', rates: { VND: 3900 } })).toThrow()
  })
})

describe('多币种汇总', () => {
  const r = rates({ USD: 0.15, JPY: 23.5 })

  const portfolio = (): Portfolio => ({
    version: 2,
    history: [],
    categories: [
      {
        id: 'cat_cash',
        name: '现金与固定资产',
        subtitle: '',
        icon: 'banknote',
        color: 'var(--accent-gold)',
        items: [
          { id: 'a1', kind: 'amount', name: '人民币活期', amount: 100_000 },
          { id: 'a2', kind: 'amount', name: '美元存款', amount: 10_000, currency: 'USD' },
        ],
      },
      {
        id: 'cat_debt',
        name: '负债',
        subtitle: '',
        icon: 'credit-card',
        color: 'var(--accent-red)',
        isLiability: true,
        items: [{ id: 'd1', kind: 'amount', name: '房贷', amount: 50_000 }],
      },
    ],
  })

  it('外币条目按汇率折算后再汇总', () => {
    const p = portfolio()
    const v = valuate(p.categories[0].items[1], r)
    expect(v.currency).toBe('USD')
    expect(v.valueInCurrency).toBe(10_000)
    expect(v.value).toBeCloseTo(10_000 / 0.15, 6)
    expect(v.missingRate).toBe(false)

    const s = summarize(p, r)
    expect(s.totalAssets).toBeCloseTo(100_000 + 10_000 / 0.15, 6)
    expect(s.netWorth).toBeCloseTo(100_000 + 10_000 / 0.15 - 50_000, 6)
  })

  it('没有汇率时按原币数值计入并标记 missingRate（界面据此提示）', () => {
    const p = portfolio()
    const v = valuate(p.categories[0].items[1], null)
    expect(v.missingRate).toBe(true)
    expect(v.value).toBe(10_000)
    expect(categoryTotal(p.categories[0], null)).toBe(110_000)
  })

  it('人民币条目不受汇率影响，也不标 missing', () => {
    const p = portfolio()
    const v = valuate(p.categories[0].items[0], null)
    expect(v.currency).toBe('CNY')
    expect(v.missingRate).toBe(false)
    expect(v.value).toBe(100_000)
  })

  it('外币敞口统计', () => {
    const p = portfolio()
    const e = fxExposure(p, r)
    expect(e.foreignItemCount).toBe(1)
    expect(e.missingRateCount).toBe(0)
    expect(e.byCurrency).toEqual([{ currency: 'USD', valueInCurrency: 10_000 }])

    const missing = fxExposure(p, null)
    expect(missing.missingRateCount).toBe(1)
  })

  it('收集组合里用到的币种（基金恒为人民币）', () => {
    const p = portfolio()
    p.categories[0].items.push({
      id: 'f1',
      kind: 'fund',
      name: '白酒',
      code: '161725',
      shares: 100,
      costNav: 1,
    })
    expect(collectCurrencies(p)).toEqual(['USD'])
  })
})

describe('旧数据兼容（币种字段）', () => {
  it('没有 currency 字段的旧条目默认人民币', () => {
    const p = normalizePortfolio({
      categories: [{ id: 'cat_cash', name: '现金', items: [{ id: 'a1', kind: 'amount', name: '存款', amount: 100 }] }],
    })!
    const item = p.categories[0].items[0]
    expect(item.kind).toBe('amount')
    expect(item.kind === 'amount' ? item.currency : 'x').toBeUndefined()
    expect(valuate(item, null).currency).toBe('CNY')
  })

  it('保留合法币种，非法币种回落人民币', () => {
    const p = normalizePortfolio({
      categories: [
        {
          id: 'cat_cash',
          name: '现金',
          items: [
            { id: 'a1', kind: 'amount', name: '美元', amount: 100, currency: 'USD' },
            { id: 'a2', kind: 'amount', name: '假币', amount: 100, currency: 'XYZ' },
          ],
        },
      ],
    })!
    const [a1, a2] = p.categories[0].items
    expect(a1.kind === 'amount' && a1.currency).toBe('USD')
    expect(a2.kind === 'amount' ? a2.currency : 'x').toBeUndefined()
  })

  it('CNY 不落库（保持数据干净）', () => {
    const p = normalizePortfolio({
      categories: [{ id: 'cat_cash', name: '现金', items: [{ id: 'a1', kind: 'amount', amount: 1, currency: 'CNY' }] }],
    })!
    expect(p.categories[0].items[0].kind === 'amount' ? p.categories[0].items[0].currency : 'x').toBeUndefined()
  })
})

describe('新增「国债」分类的升级迁移', () => {
  it('默认分类里国债排在黄金之后、负债之前', () => {
    const ids = createDefaultCategories().map((c) => c.id)
    expect(ids).toEqual(['cat_cash', 'cat_stock', 'cat_fund', 'cat_gold', 'cat_bond', 'cat_debt'])
  })

  it('给老数据补上国债，且插入位置正确', () => {
    // 模拟升级前的数据：没有 cat_bond
    const old = createDefaultCategories().filter((c) => c.id !== 'cat_bond')
    const { categories, added } = mergeDefaultCategories(old)
    expect(added).toEqual(['cat_bond'])
    expect(categories.map((c) => c.id)).toEqual([
      'cat_cash',
      'cat_stock',
      'cat_fund',
      'cat_gold',
      'cat_bond',
      'cat_debt',
    ])
  })

  it('不覆盖用户已有的分类内容与自定义分类', () => {
    const old = createDefaultCategories().filter((c) => c.id !== 'cat_bond')
    old[0] = { ...old[0], name: '我的现金', color: 'var(--accent-pink)', items: [] }
    old.push({
      id: 'cat_diy',
      name: '数字货币',
      subtitle: '',
      icon: 'bitcoin',
      color: 'var(--accent-orange)',
      items: [],
    })
    const { categories } = mergeDefaultCategories(old)
    expect(categories.find((c) => c.id === 'cat_cash')?.name).toBe('我的现金')
    expect(categories.find((c) => c.id === 'cat_cash')?.color).toBe('var(--accent-pink)')
    expect(categories.some((c) => c.id === 'cat_diy')).toBe(true)
    // 国债插在黄金之后，自定义分类保持在最后
    expect(categories[categories.length - 1].id).toBe('cat_diy')
  })

  it('幂等：已经补齐过的数据不会再改动', () => {
    const full = createDefaultCategories()
    const { categories, added } = mergeDefaultCategories(full)
    expect(added).toEqual([])
    expect(categories.map((c) => c.id)).toEqual(full.map((c) => c.id))
  })

  it('用户把国债重命名后不会被改回去', () => {
    const full = createDefaultCategories().map((c) =>
      c.id === 'cat_bond' ? { ...c, name: '中国国债' } : c,
    )
    const { categories, added } = mergeDefaultCategories(full)
    expect(added).toEqual([])
    expect(categories.find((c) => c.id === 'cat_bond')?.name).toBe('中国国债')
  })
})

describe('再平衡把国债纳入计算', () => {
  const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!

  it('国债默认归入中期国债', () => {
    const p: Portfolio = {
      version: 2,
      history: [],
      categories: [
        {
          id: 'cat_bond',
          name: '国债',
          subtitle: '',
          icon: 'landmark',
          color: 'var(--accent-cyan)',
          items: [{ id: 'b1', kind: 'amount', name: '中国10年期国债', amount: 200_000 }],
        },
      ],
    }
    const r = computeRebalance(p, aw, { threshold: 5, includeLiabilities: false, unmappedPolicy: 'auto' })
    const mid = r.classes.find((c) => c.classId === 'bond-mid')!
    expect(mid.currentValue).toBeCloseTo(200_000, 6)
    expect(r.totalForAllocation).toBeCloseTo(200_000, 6)
  })

  it('外币国债按汇率折算后再参与占比', () => {
    const r = rates({ USD: 0.15 })
    const p: Portfolio = {
      version: 2,
      history: [],
      categories: [
        {
          id: 'cat_bond',
          name: '国债',
          subtitle: '',
          icon: 'landmark',
          color: 'var(--accent-cyan)',
          items: [{ id: 'b1', kind: 'amount', name: '美国10年期国债', amount: 30_000, currency: 'USD' }],
        },
      ],
    }
    const result = computeRebalance(p, aw, {
      threshold: 5,
      includeLiabilities: false,
      unmappedPolicy: 'auto',
      rates: r,
    })
    expect(result.totalForAllocation).toBeCloseTo(30_000 / 0.15, 6)
  })
})
