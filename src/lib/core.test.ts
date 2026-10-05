import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Portfolio } from '../types/asset'
import { categoryCountLabel, categoryTotal, collectFundCodes, fundCurrentNav, parseAmount, safeNum, summarize, valuate } from './calc'
import { formatCompactCNY, formatRate, formatSigned, todayKey } from './format'
import { normalizePortfolio } from './storage'
import { buildFundMobUrl, buildPush2Url, exchangePrefix, parseFundGzResponse, parseFundMobBatch, parsePush2Batch, fundGzToQuote } from './fundService'
import { createDefaultCategories } from './defaults'

describe('parseAmount', () => {
  it('解析普通数字与千分位', () => {
    expect(parseAmount('1234.56')).toBe(1234.56)
    expect(parseAmount('1,234.56')).toBe(1234.56)
    expect(parseAmount('¥ 8,800')).toBe(8800)
  })

  it('解析中文数量级与全角字符', () => {
    expect(parseAmount('10万')).toBe(100_000)
    expect(parseAmount('1.5w')).toBe(15_000)
    expect(parseAmount('20k')).toBe(20_000)
    expect(parseAmount('１２３')).toBe(123)
    expect(parseAmount('12。5')).toBe(12.5)
  })

  it('支持负数（负债 / 抵减）', () => {
    expect(parseAmount('-3200')).toBe(-3200)
    expect(parseAmount('－5万')).toBe(-50_000)
  })

  it('非法输入返回 NaN', () => {
    for (const bad of ['', '  ', 'abc', '1.2.3', '--5', '万']) {
      expect(Number.isNaN(parseAmount(bad))).toBe(true)
    }
  })
})

describe('valuate / summarize', () => {
  const portfolio = (): Portfolio => ({
    version: 2,
    history: [],
    categories: [
      {
        id: 'c1',
        name: '现金',
        subtitle: '',
        icon: 'banknote',
        color: '#fff',
        items: [
          { id: 'i1', kind: 'amount', name: '招行', amount: 50_000 },
          { id: 'i2', kind: 'amount', name: '现金', amount: 1_000 },
        ],
      },
      {
        id: 'c2',
        name: '基金',
        subtitle: '',
        icon: 'chart-pie',
        color: '#0f0',
        items: [
          {
            id: 'f1',
            kind: 'fund',
            name: '白酒',
            code: '161725',
            shares: 1000,
            costNav: 0.5,
            quote: { code: '161725', name: '白酒', publishedNav: 0.529, fetchedAt: Date.now(), source: 'test' },
          },
        ],
      },
      {
        id: 'c3',
        name: '负债',
        subtitle: '',
        icon: 'credit-card',
        color: '#f00',
        isLiability: true,
        items: [{ id: 'd1', kind: 'amount', name: '房贷', amount: 20_000 }],
      },
    ],
  })

  it('基金按公布净值计算市值与盈亏', () => {
    const v = valuate(portfolio().categories[1].items[0])
    expect(v.value).toBeCloseTo(529, 6)
    expect(v.cost).toBeCloseTo(500, 6)
    expect(v.profit).toBeCloseTo(29, 6)
    expect(v.profitRate).toBeCloseTo(0.058, 6)
  })

  it('盘中估算净值优先于公布净值', () => {
    const item = portfolio().categories[1].items[0]
    if (item.kind !== 'fund') throw new Error('fixture 类型错误')
    expect(fundCurrentNav({ ...item, quote: { ...item.quote!, estimatedNav: 0.6 } })).toBe(0.6)
  })

  it('净资产 = 总资产 − 总负债', () => {
    const s = summarize(portfolio())
    expect(s.totalAssets).toBeCloseTo(51_529, 6)
    expect(s.totalLiabilities).toBeCloseTo(20_000, 6)
    expect(s.netWorth).toBeCloseTo(31_529, 6)
  })

  it('未知行情时用成本兜底，不虚报盈亏', () => {
    const v = valuate({
      id: 'f2',
      kind: 'fund',
      name: '新基金',
      code: '000001',
      shares: 100,
      costNav: 2,
    })
    expect(v.value).toBe(200)
    expect(v.profit).toBe(0)
  })

  it('负债分类金额取绝对值参与计算', () => {
    const p = portfolio()
    p.categories[2].items = [{ id: 'd1', kind: 'amount', name: '房贷', amount: -20_000 }]
    expect(summarize(p).totalLiabilities).toBeCloseTo(20_000, 6)
  })

  it('分类小计与项数标签', () => {
    const p = portfolio()
    expect(categoryTotal(p.categories[0])).toBeCloseTo(51_000, 6)
    expect(categoryCountLabel(p.categories[0])).toBe('2项')
    expect(categoryCountLabel(p.categories[1])).toBe('1只')
    expect(categoryCountLabel(p.categories[2])).toBe('1笔')
  })

  it('收集基金代码去重且只保留 6 位数字', () => {
    const p = portfolio()
    p.categories[1].items.push({
      id: 'f9',
      kind: 'fund',
      name: '重复',
      code: '161725',
      shares: 1,
      costNav: 1,
    })
    expect(collectFundCodes(p)).toEqual(['161725'])
  })
})

describe('format', () => {
  it('金额与符号格式化', () => {
    expect(formatSigned(1204.5)).toBe('+1,204.50')
    expect(formatSigned(-320)).toBe('-320.00')
    expect(formatSigned(0)).toBe('0.00')
    expect(formatCompactCNY(3_456_700)).toBe('345.67万')
  })

  it('涨跌比例格式化（红涨绿跌由 CSS 决定）', () => {
    expect(formatRate(0.0212)).toBe('+2.12%')
    expect(formatRate(-0.0193)).toBe('-1.93%')
    expect(formatRate(undefined)).toBe('--')
  })

  it('todayKey 使用本地时区', () => {
    expect(todayKey(new Date(2026, 9, 3))).toBe('2026-10-03')
  })
})

describe('normalizePortfolio', () => {
  it('修复脏数据并补默认值', () => {
    const p = normalizePortfolio({
      categories: [
        { id: 'a', name: '自定义', items: [{ id: 'x', kind: 'fund', name: '基金', code: '161725x', shares: '100', costNav: '0.5' }] },
      ],
    })
    expect(p).not.toBeNull()
    const item = p!.categories[0].items[0]
    expect(item.kind).toBe('fund')
    if (item.kind !== 'fund') throw new Error('类型错误')
    expect(item.code).toBe('161725')
    expect(item.shares).toBe(100)
    expect(item.costNav).toBe(0.5)
  })

  it('非对象 / 缺少 categories 返回 null', () => {
    expect(normalizePortfolio(null)).toBeNull()
    expect(normalizePortfolio({ foo: 1 })).toBeNull()
  })

  it('损坏条目被丢弃但分类保留', () => {
    const p = normalizePortfolio({ categories: [{ id: 'a', name: 'A', items: [null, 42, { id: 'ok', kind: 'amount', amount: '3' }] }] })
    expect(p!.categories[0].items).toHaveLength(1)
    expect(p!.categories[0].items[0]).toMatchObject({ id: 'ok', amount: 3 })
  })

  it('safeNum 处理各类脏值', () => {
    expect(safeNum('ab')).toBe(0)
    expect(safeNum(NaN)).toBe(0)
    expect(safeNum(Infinity)).toBe(0)
    expect(safeNum('12')).toBe(12)
  })
})

describe('fundService 解析与 URL 构造（离线）', () => {
  it('parseFundMobBatch 解析 GSZ / NAV', () => {
    const quotes = parseFundMobBatch({
      Datas: [
        {
          FCODE: '161725',
          SHORTNAME: '招商中证白酒指数(LOF)A',
          PDATE: '2026-09-30',
          NAV: '0.5314',
          NAVCHGRT: '2.81',
          GSZ: '0.5390',
          GSZZL: '1.43',
          GZTIME: '2026-10-03 14:30',
        },
      ],
      ErrCode: 0,
    })
    expect(quotes).toHaveLength(1)
    expect(quotes[0].code).toBe('161725')
    expect(quotes[0].estimatedNav).toBe(0.539)
    expect(quotes[0].estimatedRate).toBeCloseTo(0.0143, 6)
    expect(quotes[0].publishedNav).toBe(0.5314)
    expect(quotes[0].publishedRate).toBeCloseTo(0.0281, 6)
    expect(quotes[0].publishedAt).toBe('2026-09-30')
    expect(quotes[0].source).toBe('fundmobapi')
  })

  it('GSZ 为空（非交易时段 / QDII）时不报错', () => {
    const quotes = parseFundMobBatch({
      Datas: [{ FCODE: '161725', SHORTNAME: '白酒', NAV: '0.5314', NAVCHGRT: '2.81', GSZ: null, GSZZL: null, GZTIME: null }],
    })
    expect(quotes[0].estimatedNav).toBeUndefined()
    expect(quotes[0].publishedNav).toBe(0.5314)
  })

  it('空数据 / 非法响应抛错', () => {
    expect(() => parseFundMobBatch({ Datas: null, ErrMsg: '参数错误' })).toThrow(/参数错误/)
    expect(() => parseFundMobBatch(null)).toThrow()
    expect(() => parsePush2Batch({ data: {} })).toThrow()
  })

  it('parsePush2Batch 按 fltt=2 的口径解析（元 / 百分数）', () => {
    const quotes = parsePush2Batch({
      data: {
        diff: [
          { f2: 0.529, f3: 2.12, f12: '161725', f13: 0, f14: '白酒基金LOF' },
          { f2: 4.432, f3: 0.36, f12: '510300', f13: 1, f14: '沪深300ETF' },
        ],
      },
    })
    expect(quotes).toHaveLength(2)
    expect(quotes[0].estimatedNav).toBe(0.529)
    expect(quotes[0].estimatedRate).toBeCloseTo(0.0212, 6)
    expect(quotes[1].estimatedNav).toBe(4.432)
  })

  it('交易所前缀推断', () => {
    expect(exchangePrefix('510300')).toBe('1')
    expect(exchangePrefix('161725')).toBe('0')
    expect(exchangePrefix('007301')).toBe('0')
  })

  it('URL 构造包含批量基金代码与时间戳', () => {
    const url = buildFundMobUrl(['161725', '000001'])
    expect(url).toContain('Fcodes=161725%2C000001')
    expect(url).toContain('FundMNFInfo')
    expect(buildPush2Url(['510300'])).toContain('secids=1.510300')
  })

  it('URL 里不应出现两个 callback 参数（曾导致 JSONP 回调未定义）', () => {
    // jsonp() 会自动追加回调名，provider 不能再自己加
    const url = buildFundMobUrl(['161725'])
    expect(url).not.toContain('callback=')
    expect(url.match(/callback/g) ?? []).toHaveLength(0)
  })

  it('兼容已下线的 fundgz 脚本格式（便于接口恢复后自动启用）', () => {
    const payload = parseFundGzResponse('jsonpgz({"fundcode":"161725","name":"白酒","jzrq":"2026-09-30","dwjz":"0.5314","gsz":"0.5390","gszzl":"1.43","gztime":"2026-10-03 14:30"});')
    expect(payload).not.toBeNull()
    const quote = fundGzToQuote(payload!)
    expect(quote?.estimatedNav).toBe(0.539)
    expect(quote?.source).toBe('fundgz')
    expect(parseFundGzResponse('<html>404</html>')).toBeNull()
  })

  it('默认分类符合需求定义', () => {
    const names = createDefaultCategories().map((c) => c.name)
    expect(names).toEqual(['现金与固定资产', '股票', '基金', '黄金', '国债', '负债'])
    expect(createDefaultCategories().find((c) => c.name === '负债')?.isLiability).toBe(true)
    // 国债用 landmark 图标，主题色为青色系
    const bond = createDefaultCategories().find((c) => c.id === 'cat_bond')!
    expect(bond.icon).toBe('landmark')
    expect(bond.subtitle).toContain('国债')
  })
})

describe('jsonp（模拟浏览器环境）', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('注入 script、执行回调、清理全局函数与标签', async () => {
    const appended: Array<{ src: string; remove: () => void }> = []
    const fakeScript = {
      src: '',
      async: false,
      charset: '',
      onerror: null as null | (() => void),
      remove: vi.fn(),
    }

    vi.stubGlobal('document', {
      head: {
        appendChild: (el: typeof fakeScript) => {
          appended.push(el)
          // 模拟服务端返回：解析出回调名后异步调用全局回调
          const cbName = new URL(el.src).searchParams.get('cb')
          setTimeout(() => {
            const fn = (globalThis as Record<string, unknown>)[cbName!] as (d: unknown) => void
            fn({ ok: true })
          }, 0)
        },
      },
      createElement: () => fakeScript,
    })
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })

    const { jsonp } = await import('./jsonp')
    const data = await jsonp<{ ok: boolean }>('https://example.com/api', { params: { a: 1 } })

    expect(data).toEqual({ ok: true })
    expect(appended).toHaveLength(1)
    expect(appended[0].src).toContain('a=1')
    expect(fakeScript.remove).toHaveBeenCalled()
    const leaked = Object.keys(globalThis).filter((k) => k.startsWith('__acw_jsonp'))
    expect(leaked).toHaveLength(0)
  })

  it('脚本加载失败时 reject', async () => {
    const fakeScript = {
      src: '',
      async: false,
      charset: '',
      onerror: null as null | (() => void),
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      head: {
        appendChild: (el: typeof fakeScript) => {
          setTimeout(() => el.onerror?.(), 0)
        },
      },
      createElement: () => fakeScript,
    })
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })

    const { jsonp, JsonpError } = await import('./jsonp')
    await expect(jsonp('https://example.com/bad')).rejects.toBeInstanceOf(JsonpError)
  })
})
