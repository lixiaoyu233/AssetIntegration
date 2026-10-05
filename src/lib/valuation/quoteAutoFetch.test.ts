import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryRepository } from '../db/dexieRepository'
import type { PortfolioRepository } from '../db/repository'
import {
  canAutoFetchQuote,
  detectCodeKind,
  normalizeHkCode,
  parseFundNav,
  parseTencentQuotes,
  routeFor,
  syncQuotes,
  toTencentSymbol,
  wallClockToIso,
} from './quoteAutoFetch'
import { judgeQuote } from './quote'
import { makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { Instrument, Portfolio2 } from '../../types/portfolio2'

/*
 * 行情自动获取测试
 *
 * 路由（已与用户确认 A1）：按 `instrumentType` 决定
 *   fund            → 场外净值（eastmoney）
 *   stock / etf     → 腾讯行情（现价）
 *   其它            → 不自动获取
 *
 * 代码格式沿用 1.0：6 位数字=境内 / 1~6 字母=美股 / 1~5 数字=港股
 */

/** 造一个 Instrument（只补测试需要的字段） */
function inst(partial: Partial<Instrument> & { id: string; name: string }): Instrument {
  return makeInstrument({
    instrumentType: 'stock',
    assetClass: 'equity',
    currency: 'CNY',
    classificationStatus: 'confirmed',
    ...partial,
  } as never)
}

/**
 * 构造腾讯返回体的一行。
 *
 * ⚠️ 必须是**真实字段数**（35 个 `~` 分隔字段），否则解析器会按「残缺响应」丢弃。
 * 这里按真实响应把 [1]名称 [2]代码 [3]现价 [4]昨收 … [30]时间 放好，其余留空。
 */
function tencentLine(prefix: string, fields: { name: string; code: string; price: string; prev: string; time: string }): string {
  const f = new Array(35).fill('')
  f[0] = '200'
  f[1] = fields.name
  f[2] = fields.code
  f[3] = fields.price
  f[4] = fields.prev
  f[5] = fields.prev
  f[30] = fields.time
  return `v_${prefix}="${f.join('~')}";`
}

/* ================================================================== *
 * ① 代码格式与接口符号
 * ================================================================== */

describe('行情自动获取 · 代码格式', () => {
  it('6 位数字 → 境内；1~5 位数字 → 港股；字母 → 美股', () => {
    expect(detectCodeKind('161725')).toBe('cn')
    expect(detectCodeKind('510300')).toBe('cn')
    expect(detectCodeKind('00700')).toBe('hk')
    expect(detectCodeKind('700')).toBe('hk')
    expect(detectCodeKind('SPY')).toBe('us')
    expect(detectCodeKind('BRK.B')).toBe('us')
    expect(detectCodeKind('')).toBeNull()
    expect(detectCodeKind('中文名')).toBeNull()
  })

  it('港股代码补零到 5 位', () => {
    expect(normalizeHkCode('700')).toBe('00700')
    expect(normalizeHkCode('00700')).toBe('00700')
  })

  it('构造腾讯查询符号：美股 us / 港股 hk / 境内按首位分 sh·sz', () => {
    expect(toTencentSymbol('SPY', 'us')).toBe('usSPY')
    expect(toTencentSymbol('spy', 'us')).toBe('usSPY')
    expect(toTencentSymbol('700', 'hk')).toBe('hk00700')
    // 6/5/9 开头 → 沪市
    expect(toTencentSymbol('600519', 'cn')).toBe('sh600519')
    expect(toTencentSymbol('510300', 'cn')).toBe('sh510300')
    // 0/1/2/3 开头 → 深市
    expect(toTencentSymbol('159915', 'cn')).toBe('sz159915')
    expect(toTencentSymbol('000001', 'cn')).toBe('sz000001')
  })
})

/* ================================================================== *
 * ② 路由（按 instrumentType）
 * ================================================================== */

describe('行情自动获取 · 路由', () => {
  it('fund → 场外净值', () => {
    const r = routeFor(inst({ id: 'i1', name: '白酒', instrumentType: 'fund', symbol: '161725' }))
    expect(r).toEqual({ source: 'eastmoney-fund', priceKind: 'nav', query: '161725' })
  })

  it('etf / stock → 腾讯行情（现价）', () => {
    expect(routeFor(inst({ id: 'i2', name: '沪深300', instrumentType: 'etf', symbol: '510300' })))
      .toEqual({ source: 'tencent', priceKind: 'market_price', query: 'sh510300' })
    expect(routeFor(inst({ id: 'i3', name: '标普', instrumentType: 'etf', symbol: 'SPY' })))
      .toEqual({ source: 'tencent', priceKind: 'market_price', query: 'usSPY' })
    expect(routeFor(inst({ id: 'i4', name: '腾讯', instrumentType: 'stock', symbol: '700' })))
      .toEqual({ source: 'tencent', priceKind: 'market_price', query: 'hk00700' })
  })

  it('其它类型不自动获取（bond / gold / crypto）', () => {
    expect(routeFor(inst({ id: 'i5', name: '国债', instrumentType: 'bond', symbol: '019547' }))).toBeNull()
    expect(routeFor(inst({ id: 'i6', name: '金条', instrumentType: 'gold' }))).toBeNull()
    expect(routeFor(inst({ id: 'i7', name: 'BTC', instrumentType: 'crypto', symbol: 'BTC' }))).toBeNull()
    expect(canAutoFetchQuote(inst({ id: 'i8', name: '国债', instrumentType: 'bond' }))).toBe(false)
  })

  it('没有代码时不自动获取（保持手动录入）', () => {
    expect(routeFor(inst({ id: 'i9', name: '自营理财', instrumentType: 'fund' }))).toBeNull()
    expect(routeFor(inst({ id: 'i10', name: '某股票', instrumentType: 'stock', symbol: '' }))).toBeNull()
  })

  it('fund 的代码格式不对时拒绝（不猜）', () => {
    expect(routeFor(inst({ id: 'i11', name: 'x', instrumentType: 'fund', symbol: 'SPY' }))).toBeNull()
    expect(routeFor(inst({ id: 'i12', name: 'x', instrumentType: 'fund', symbol: '123' }))).toBeNull()
  })
})

/* ================================================================== *
 * ③ 解析（用真实返回体的形态）
 * ================================================================== */

describe('行情自动获取 · 解析', () => {
  it('腾讯：解析美股 / 港股 / 境内，三种时间格式都归一化', () => {
    // 真实返回体（字段位置已核对）：[1]名称 [2]代码 [3]现价 [4]昨收 … [30]时间
    const text = [
      tencentLine('usSPY', { name: '标普500指数ETF-SPDR', code: 'SPY.AM', price: '769.64', prev: '763.99', time: '2026-10-02 16:00:01' }),
      tencentLine('hk00700', { name: '腾讯控股', code: '00700', price: '422.600', prev: '421.200', time: '2026/10/05 13:10:49' }),
      tencentLine('sh510300', { name: '沪深300ETF华泰柏瑞', code: '510300', price: '4.432', prev: '4.416', time: '20260930161443' }),
    ].join('\n')
    const out = parseTencentQuotes(text)
    expect(out).toHaveLength(3)

    const [us, hk, cn] = out
    expect(us).toMatchObject({ code: 'SPY.AM', name: '标普500指数ETF-SPDR', price: 769.64 })
    expect(us.timestamp).toBe('2026-10-02T20:00:01.000Z')
    expect(hk).toMatchObject({ name: '腾讯控股', price: 422.6 })
    expect(hk.timestamp).toBe('2026-10-05T05:10:49.000Z')
    expect(cn).toMatchObject({ name: '沪深300ETF华泰柏瑞', price: 4.432 })
    expect(cn.timestamp).toBe('2026-09-30T08:14:43.000Z')
  })

  it('腾讯：无效代码返回 none_match，必须解析出空数组（不能被当成成功）', () => {
    expect(parseTencentQuotes('v_pv_none_match="1";')).toEqual([])
  })

  it('腾讯：价格缺失/为 0 的条目被丢弃（不可估值 ≠ 0）', () => {
    const text = tencentLine('usXXX', { name: '某标的', code: 'XXX', price: '0', prev: '1', time: '2026-10-02 16:00:01' })
    expect(parseTencentQuotes(text)).toEqual([])
  })

  it('腾讯：字段不足的残缺响应被丢弃（不崩）', () => {
    expect(parseTencentQuotes('v_usSPY="200~名称";')).toEqual([])
  })

  it('场外基金：解析净值（NAV）与名称', () => {
    const payload = {
      Datas: [
        { FCODE: '161725', SHORTNAME: '招商中证白酒指数(LOF)A', NAV: '0.5314', PDATE: '2026-09-30' },
      ],
    }
    const out = parseFundNav(payload)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: '161725', name: '招商中证白酒指数(LOF)A', price: 0.5314 })
    expect(out[0].timestamp).toBe('2026-09-30T00:00:00.000+08:00')
  })

  it('场外基金：Datas 为 null / 结构异常时返回空数组（不崩）', () => {
    expect(parseFundNav({ Datas: null })).toEqual([])
    expect(parseFundNav(null)).toEqual([])
    expect(parseFundNav({ unexpected: 1 })).toEqual([])
  })

  it('场外基金：NAV 缺失或为 0 的条目被丢弃', () => {
    const payload = { Datas: [{ FCODE: '1', SHORTNAME: 'x', NAV: '0' }, { FCODE: '2', SHORTNAME: 'y' }] }
    expect(parseFundNav(payload)).toEqual([])
  })
})

/* ================================================================== *
 * ④ 端到端同步（含 GBK 解码）
 * ================================================================== */

describe('行情自动获取 · 同步', () => {
  let repo: PortfolioRepository

  const portfolioOf = (instruments: Instrument[]): Portfolio2 =>
    makePortfolio({ accounts: [], instruments, holdings: [], transactions: [] })

  beforeEach(() => {
    vi.restoreAllMocks()
    repo = createInMemoryRepository()
  })
  afterEach(() => vi.restoreAllMocks())

  it('【核心】按路由分别打两个源，并把行情写进 quotes', async () => {
    await repo.replaceAll(
      portfolioOf([
        inst({ id: 'i_etf', name: '沪深300', instrumentType: 'etf', symbol: '510300', currency: 'CNY' }),
        inst({ id: 'i_fund', name: '白酒', instrumentType: 'fund', symbol: '161725', currency: 'CNY' }),
        inst({ id: 'i_bond', name: '国债', instrumentType: 'bond', symbol: '019547', currency: 'CNY' }),
      ]),
    )

    const tencentBody = tencentLine('sh510300', { name: '沪深300ETF华泰柏瑞', code: '510300', price: '4.432', prev: '4.416', time: '20260930161443' })
    const fundBody = { Datas: [{ FCODE: '161725', SHORTNAME: '招商中证白酒指数(LOF)A', NAV: '0.5314', PDATE: '2026-09-30' }] }

    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('gtimg.cn')) {
        // 真实接口是 GBK：这里用 GBK 编码回传，验证解码链路
        const buf = new TextEncoder().encode(tencentBody) // ASCII 部分与 GBK 兼容
        return { ok: true, arrayBuffer: async () => buf.buffer } as unknown as Response
      }
      return { ok: true, json: async () => fundBody } as unknown as Response
    }))

    // 固定参考时刻，避免断言随真实时钟漂移
    const r = await syncQuotes(repo, { now: () => Date.parse('2026-10-05T00:00:00.000Z') })
    expect(r.written).toBe(2)
    expect(calls.some((u) => u.includes('gtimg.cn'))).toBe(true)
    expect(calls.some((u) => u.includes('fundmobapi'))).toBe(true)

    const rows = await repo.quotes.getAll()
    expect(rows).toHaveLength(2)
    /*
     * ⚠️ 状态**不再一律 LIVE**（LIVE 的寿命只有 1 小时）。
     * 这两条的时间戳都远早于参考时刻 → 都是「收盘价」语义的 CLOSED。
     */
    const etf = rows.find((q) => q.instrumentId === 'i_etf')!
    expect(etf).toMatchObject({ priceKind: 'market_price', marketPrice: 4.432, source: 'tencent', status: 'CLOSED' })
    const fund = rows.find((q) => q.instrumentId === 'i_fund')!
    expect(fund).toMatchObject({ priceKind: 'nav', nav: 0.5314, source: 'eastmoney-fund', status: 'CLOSED' })

    // bond 不在结果里（不自动获取）
    expect(r.outcomes.every((o) => o.instrumentId !== 'i_bond')).toBe(true)
  })

  it('【核心】接口返回的名称带回来，供用户确认「是不是这只」', async () => {
    await repo.replaceAll(portfolioOf([inst({ id: 'i_fund', name: '我记的名字', instrumentType: 'fund', symbol: '161725' })]))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ Datas: [{ FCODE: '161725', SHORTNAME: '招商中证白酒指数(LOF)A', NAV: '0.5314', PDATE: '2026-09-30' }] }),
    } as unknown as Response)))

    const r = await syncQuotes(repo)
    expect(r.outcomes[0]).toMatchObject({
      ok: true,
      fetchedName: '招商中证白酒指数(LOF)A',
      price: 0.5314,
    })
  })

  it('【核心】代码不存在时如实报错，不静默成功', async () => {
    await repo.replaceAll(portfolioOf([inst({ id: 'i_etf', name: 'X', instrumentType: 'etf', symbol: '510300' })]))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('v_pv_none_match="1";').buffer,
    } as unknown as Response)))

    const r = await syncQuotes(repo)
    expect(r.written).toBe(0)
    expect(r.outcomes[0].ok).toBe(false)
    expect(r.outcomes[0].error).toContain('未查询到代码')
    expect(await repo.quotes.count()).toBe(0)
  })

  it('【核心】网络失败时如实报错，且不影响其它标的的结构', async () => {
    await repo.replaceAll(portfolioOf([inst({ id: 'i_etf', name: 'X', instrumentType: 'etf', symbol: '510300' })]))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const r = await syncQuotes(repo)
    expect(r.written).toBe(0)
    expect(r.outcomes[0].ok).toBe(false)
    expect(r.outcomes[0].error).toContain('行情源不可用')
  })

  it('【核心】自动拉取不覆盖手填行情（source 不同）', async () => {
    await repo.replaceAll(portfolioOf([inst({ id: 'i_etf', name: 'X', instrumentType: 'etf', symbol: '510300' })]))
    await repo.quotes.put({
      id: 'manual1', instrumentId: 'i_etf', priceKind: 'manual', marketPrice: 9.99,
      currency: 'CNY', source: 'manual', timestamp: '2026-09-01T00:00:00.000Z', status: 'MANUAL',
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(tencentLine('sh510300', { name: 'ETF', code: '510300', price: '4.432', prev: '4.416', time: '20260930161443' })).buffer,
    } as unknown as Response)))

    await syncQuotes(repo)
    const manual = (await repo.quotes.getAll()).find((q) => q.source === 'manual')
    expect(manual?.marketPrice).toBe(9.99) // 手填值原样保留
  })

  it('没有任何可自动获取的标的时，不发请求', async () => {
    await repo.replaceAll(portfolioOf([inst({ id: 'i_bond', name: '国债', instrumentType: 'bond' })]))
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await syncQuotes(repo)
    expect(spy).not.toHaveBeenCalled()
    expect(r.written).toBe(0)
  })

  it('只拉指定标的（instrumentIds 过滤）', async () => {
    await repo.replaceAll(portfolioOf([
      inst({ id: 'i_a', name: 'A', instrumentType: 'etf', symbol: '510300' }),
      inst({ id: 'i_b', name: 'B', instrumentType: 'etf', symbol: '159915' }),
    ]))
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url))
      return {
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(tencentLine('sh510300', { name: 'ETF', code: '510300', price: '4.432', prev: '4.416', time: '20260930161443' })).buffer,
      } as unknown as Response
    }))

    await syncQuotes(repo, { instrumentIds: ['i_a'] })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('sh510300')
    expect(seen[0]).not.toContain('sz159915')
  })

  it('【核心】交易时段内 → LIVE；已闭市 → CLOSED', async () => {
    await repo.replaceAll(portfolioOf([inst({ id: 'i_cn', name: '沪深300', instrumentType: 'etf', symbol: '510300' })]))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(
        // 2026-10-05（周一）10:00 北京时间
        tencentLine('sh510300', { name: 'ETF', code: '510300', price: '4.432', prev: '4.416', time: '20261005100000' }),
      ).buffer,
    } as unknown as Response)))

    // 参考时刻 = 10:05 北京时间（02:05Z）→ 开盘中，距行情 5 分钟 → 盘中价
    await syncQuotes(repo, { now: () => Date.parse('2026-10-05T02:05:00.000Z') })
    expect((await repo.quotes.getAll())[0].status).toBe('LIVE')

    // 参考时刻 = 次日同一时刻 → 不在交易时段 → 收盘价
    await syncQuotes(repo, { now: () => Date.parse('2026-10-06T02:05:00.000Z') })
    const rows = await repo.quotes.getAll()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('CLOSED')
  })

  it('【核心】收盘后取到的收盘价记为 CLOSED，数小时后判读仍可用', async () => {
    await repo.replaceAll(portfolioOf([inst({ id: 'i_cn', name: '沪深300', instrumentType: 'etf', symbol: '510300' })]))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(
        // 2026-10-05 15:00 北京时间收盘
        tencentLine('sh510300', { name: 'ETF', code: '510300', price: '4.432', prev: '4.416', time: '20261005150000' }),
      ).buffer,
    } as unknown as Response)))

    /*
     * 收盘后 3 分钟抓取。
     * 回归：只看「距现在多久」会把这条记成 LIVE（寿命 1 小时），
     * 于是 16:00 之后首页又冒出一排「估值已过期」—— 而它本来就是收盘价。
     */
    const AT = Date.parse('2026-10-05T15:03:00+08:00')
    await syncQuotes(repo, { now: () => AT })
    const q = (await repo.quotes.getAll())[0]
    expect(q.status).toBe('CLOSED')

    // 当天深夜再判读，仍然可用（收盘价到下一个交易时段前都有效）
    expect(judgeQuote(q, Date.parse('2026-10-05T23:00:00+08:00')).usable).toBe(true)
  })

  it('【核心】自动获取的基金净值不会被误判「估值已过期」', async () => {
    await repo.replaceAll(portfolioOf([inst({ id: 'i_fund', name: '白酒', instrumentType: 'fund', symbol: '161725' })]))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ Datas: [{ FCODE: '161725', SHORTNAME: '白酒', NAV: '0.5314', PDATE: '2026-10-05' }] }),
    } as unknown as Response)))

    const NOW = Date.parse('2026-10-05T15:00:00+08:00')
    await syncQuotes(repo, { now: () => NOW })
    const q = (await repo.quotes.getAll())[0]

    /*
     * 回归：旧行为一律写 LIVE（寿命 1 小时），而净值日 00:00 已是「15 小时前」
     * → 刚拉完就被判过期，「数据完整度」凭空多出「估值已过期 N 项」。
     */
    expect(q.status).toBe('CLOSED')
    expect(judgeQuote(q, NOW).usable).toBe(true)
  })
})

/* ================================================================== *
 * ⑤ 时区归一化
 * ================================================================== */

describe('行情自动获取 · 时区归一化', () => {
  it('交易所当地时间 → 绝对时刻（夏令时 / 冬令时都正确）', () => {
    // 美股：2026-10-02 属夏令时 EDT（UTC-4）
    expect(wallClockToIso('2026-10-02T16:00:01', 'America/New_York')).toBe('2026-10-02T20:00:01.000Z')
    // 美股：2026-12-02 属冬令时 EST（UTC-5）
    expect(wallClockToIso('2026-12-02T16:00:01', 'America/New_York')).toBe('2026-12-02T21:00:01.000Z')
    // 港股 / 境内：UTC+8
    expect(wallClockToIso('2026-10-05T13:10:49', 'Asia/Hong_Kong')).toBe('2026-10-05T05:10:49.000Z')
    expect(wallClockToIso('2026-09-30T16:14:43', 'Asia/Shanghai')).toBe('2026-09-30T08:14:43.000Z')
  })

  it('无法解析的墙钟时间返回 undefined（不编造时刻）', () => {
    expect(wallClockToIso('bad', 'Asia/Shanghai')).toBeUndefined()
    expect(wallClockToIso('', 'Asia/Shanghai')).toBeUndefined()
  })

  it('腾讯返回的时间带上了正确时区（不再依赖运行环境本地时区）', () => {
    // 同一份返回体，在任何时区的机器上都应解析出同一个绝对时刻
    const text = tencentLine('usSPY', { name: 'SPY', code: 'SPY.AM', price: '769.64', prev: '763.99', time: '2026-10-02 16:00:01' })
    expect(parseTencentQuotes(text)[0].timestamp).toBe('2026-10-02T20:00:01.000Z')
  })
})
