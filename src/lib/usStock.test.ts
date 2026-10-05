import { describe, expect, it } from 'vitest'
import {
  HOLDING_MARKET_CURRENCY,
  buildTencentUrl,
  detectStockMarket,
  isHkTicker,
  isUsTicker,
  normalizeHkCode,
  parseTencentQuotes,
  toTencentSymbol,
} from './usStock'

/** 真实响应片段（已按 GBK 解码后的形态） */
const US_LINE =
  'v_usSPY="200~标普500指数ETF-SPDR~SPY.AM~769.64~763.99~770.58~46335295~0~0~769.75~160~0~0~0~0~0~0~0~0~769.88~40~0~0~0~0~0~0~0~0~~2026-10-02 16:00:01~5.65~0.74~772.65~767.15~USD~35672496746";'
const HK_LINE =
  'v_hk00700="100~腾讯控股~00700~421.200~431.000~422.000~19108045.0~0~0~421.200~0~0~0~0~0~0~0~0~0~421.200~0~0~0~0~0~0~0~0~0~19108045.0~2026/10/02 16:08:10~-9.800~-2.27~425.000~419.800~421.200~8059664706.422";'
const NONE = 'v_pv_none_match="1";'

describe('美股/港股代码识别', () => {
  it('美股代码：字母，允许 . 与 -', () => {
    for (const c of ['SPY', 'QQQ', 'VOO', 'BRK.B', 'BF-B', 'aapl']) {
      expect(isUsTicker(c), c).toBe(true)
    }
    for (const c of ['00700', '161725', '', 'TOOLONGCODE']) {
      expect(isUsTicker(c), c).toBe(false)
    }
  })

  it('港股代码：1~5 位数字，输入自动补零', () => {
    expect(isHkTicker('00700')).toBe(true)
    expect(isHkTicker('700')).toBe(true)
    expect(isHkTicker('161725')).toBe(false) // 6 位视为境内基金
    expect(normalizeHkCode('700')).toBe('00700')
    expect(normalizeHkCode('00700')).toBe('00700')
  })

  it('按代码推断市场', () => {
    expect(detectStockMarket('SPY')).toBe('us')
    expect(detectStockMarket('aapl')).toBe('us')
    expect(detectStockMarket('00700')).toBe('hk')
    expect(detectStockMarket('700')).toBe('hk')
    // 6 位数字属于境内基金，由 fundService 优先分流，不应被当成港股
    expect(detectStockMarket('161725')).toBeNull()
    expect(detectStockMarket('')).toBeNull()
  })

  it('转成腾讯查询符号', () => {
    expect(toTencentSymbol('spy', 'us')).toBe('usSPY')
    expect(toTencentSymbol('700', 'hk')).toBe('hk00700')
    expect(buildTencentUrl(['SPY', 'QQQ'], 'us')).toContain('q=usSPY,usQQQ')
  })

  it('计价币种：美股 USD、港股 HKD、境内 CNY', () => {
    expect(HOLDING_MARKET_CURRENCY.us).toBe('USD')
    expect(HOLDING_MARKET_CURRENCY.hk).toBe('HKD')
    expect(HOLDING_MARKET_CURRENCY.cn).toBe('CNY')
  })
})

describe('腾讯行情解析', () => {
  it('解析美股：名称/现价/涨跌幅/时间/币种', () => {
    const quotes = parseTencentQuotes(US_LINE, 'us')
    expect(quotes).toHaveLength(1)
    const q = quotes[0]
    expect(q.code).toBe('SPY')
    expect(q.name).toBe('标普500指数ETF-SPDR')
    expect(q.estimatedNav).toBeCloseTo(769.64, 4)
    expect(q.publishedNav).toBeCloseTo(763.99, 4)
    // 接口给的是百分数 0.74，这里统一成小数
    expect(q.estimatedRate).toBeCloseTo(0.0074, 6)
    expect(q.estimatedAt).toBe('2026-10-02 16:00')
    expect(q.source).toBe('tencent-us')
    expect(q.market).toBe('us')
    expect(q.currency).toBe('USD')
  })

  it('解析港股：负涨跌幅与斜杠日期格式', () => {
    const quotes = parseTencentQuotes(HK_LINE, 'hk')
    const q = quotes[0]
    expect(q.code).toBe('00700')
    expect(q.name).toBe('腾讯控股')
    expect(q.estimatedNav).toBeCloseTo(421.2, 4)
    expect(q.estimatedRate).toBeCloseTo(-0.0227, 6)
    expect(q.estimatedAt).toBe('2026-10-02 16:08')
    expect(q.source).toBe('tencent-hk')
    expect(q.currency).toBe('HKD')
  })

  it('批量：一次取多只', () => {
    const quotes = parseTencentQuotes(`${US_LINE}\n${HK_LINE}`, 'us')
    // 市场参数只影响 source/currency，两行都能解析出来
    expect(quotes).toHaveLength(2)
    expect(quotes.map((q) => q.code)).toEqual(['SPY', '00700'])
  })

  it('无效代码返回空数组，不抛错', () => {
    expect(parseTencentQuotes(NONE, 'us')).toEqual([])
    expect(parseTencentQuotes('', 'us')).toEqual([])
  })

  it('行情时间为空时不崩', () => {
    const line = US_LINE.replace('2026-10-02 16:00:01', '')
    const q = parseTencentQuotes(line, 'us')[0]
    expect(q.estimatedAt).toBeUndefined()
    expect(q.estimatedNav).toBeCloseTo(769.64, 4)
  })
})
