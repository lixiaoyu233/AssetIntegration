import { describe, expect, it } from 'vitest'
import { createFxTable, convert, convertToCny, missingCurrencyForCny, resolveRate } from './fx'
import { FX_RATE_STALE_MS } from './fx'
import { ISO, NOW, cnyRates, makeFxRate } from './__fixtures__/builders'

/*
 * FX 测试
 *
 * 核心不变量：**缺少汇率时绝不退化为 1:1 或原值**（需求第十六条）。
 */

describe('汇率解析', () => {
  const table = createFxTable(cnyRates())

  it('同币种恒为 1', () => {
    const r = resolveRate(table, 'CNY', 'CNY', { now: NOW })
    expect(r?.rate).toBe(1)
  })

  it('直接命中', () => {
    const r = resolveRate(table, 'USD', 'CNY', { now: NOW })
    expect(r?.rate).toBeCloseTo(7.2, 10)
    expect(r?.via).toEqual(['USD', 'CNY'])
  })

  it('反向命中取倒数', () => {
    const r = resolveRate(table, 'CNY', 'USD', { now: NOW })
    expect(r?.rate).toBeCloseTo(1 / 7.2, 10)
    expect(r?.via).toEqual(['USD', 'CNY'])
  })

  it('经 CNY 中转（USD→HKD）', () => {
    const r = resolveRate(table, 'USD', 'HKD', { now: NOW })
    // 1 USD = 7.2 CNY，1 HKD = 0.92 CNY → 7.2 / 0.92
    expect(r?.rate).toBeCloseTo(7.2 / 0.92, 6)
    expect(r?.via).toEqual(['USD', 'CNY', 'HKD'])
  })

  it('没有该币种对时返回 undefined（不猜）', () => {
    const only = createFxTable([makeFxRate('USD', 'CNY', 7.2, { timestamp: ISO })])
    expect(resolveRate(only, 'SGD', 'CNY', { now: NOW })).toBeUndefined()
  })

  it('过期汇率默认不可用', () => {
    const old = createFxTable([
      makeFxRate('USD', 'CNY', 7.2, { timestamp: new Date(NOW - FX_RATE_STALE_MS - 1000).toISOString() }),
    ])
    expect(resolveRate(old, 'USD', 'CNY', { now: NOW })).toBeUndefined()
  })

  it('显式允许时可取过期汇率，但状态标为 STALE', () => {
    const old = createFxTable([
      makeFxRate('USD', 'CNY', 7.2, { timestamp: new Date(NOW - FX_RATE_STALE_MS - 1000).toISOString() }),
    ])
    const r = resolveRate(old, 'USD', 'CNY', { now: NOW, allowStale: true })
    expect(r?.status).toBe('STALE')
    expect(r?.rate).toBeCloseTo(7.2, 10)
  })

  it('MANUAL 汇率不因时间被判过期', () => {
    const manual = createFxTable([
      makeFxRate('USD', 'CNY', 7.0, { status: 'MANUAL', timestamp: new Date(NOW - 999 * 86400000).toISOString() }),
    ])
    const r = resolveRate(manual, 'USD', 'CNY', { now: NOW })
    expect(r?.status).toBe('MANUAL')
    expect(r?.rate).toBe(7)
  })

  it('status=ERROR 的记录不参与换算', () => {
    const err = createFxTable([makeFxRate('USD', 'CNY', 7.2, { status: 'ERROR', timestamp: ISO })])
    expect(resolveRate(err, 'USD', 'CNY', { now: NOW })).toBeUndefined()
  })

  it('非法 rate（0 / 负数 / NaN）被忽略', () => {
    for (const bad of [0, -1, Number.NaN]) {
      const t = createFxTable([makeFxRate('USD', 'CNY', bad, { timestamp: ISO })])
      expect(resolveRate(t, 'USD', 'CNY', { now: NOW })).toBeUndefined()
    }
  })

  it('同一币种对多条记录时取最新', () => {
    const t = createFxTable([
      makeFxRate('USD', 'CNY', 7.0, { timestamp: new Date(NOW - 120_000).toISOString() }),
      makeFxRate('USD', 'CNY', 7.3, { timestamp: new Date(NOW - 30_000).toISOString() }),
    ])
    expect(resolveRate(t, 'USD', 'CNY', { now: NOW })?.rate).toBeCloseTo(7.3, 10)
  })
})

describe('换算：缺失与过期必须显式失败', () => {
  const table = createFxTable(cnyRates())

  it('正常换算', () => {
    const r = convert(1000, 'USD', 'CNY', table, { now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.amount).toBeCloseTo(7200, 6)
  })

  it('【核心】缺少汇率时返回失败，而不是 1:1，也不是原值', () => {
    const empty = createFxTable([])
    const r = convert(10000, 'USD', 'CNY', empty, { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing_fx')
    // 明确断言：不会等于 10000（1:1），也不会等于 0
    expect(r.ok ? r.amount : undefined).toBeUndefined()
  })

  it('【核心】汇率过期时返回 stale_fx，而非静默使用', () => {
    const stale = createFxTable([
      makeFxRate('USD', 'CNY', 7.2, { timestamp: new Date(NOW - FX_RATE_STALE_MS - 1).toISOString() }),
    ])
    const r = convert(10000, 'USD', 'CNY', stale, { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('stale_fx')
  })

  it('允许过期时可用，但 rate.status 为 STALE 以便上层标记', () => {
    const stale = createFxTable([
      makeFxRate('USD', 'CNY', 7.2, { timestamp: new Date(NOW - FX_RATE_STALE_MS - 1).toISOString() }),
    ])
    const r = convert(10000, 'USD', 'CNY', stale, { now: NOW, allowStale: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rate.status).toBe('STALE')
  })

  it('convertToCny 失败返回 undefined（不是 0）', () => {
    expect(convertToCny(10000, 'USD', createFxTable([]), { now: NOW })).toBeUndefined()
    expect(convertToCny(100, 'CNY', createFxTable([]), { now: NOW })).toBe(100)
  })

  it('非有限金额直接失败', () => {
    expect(convert(Number.NaN, 'CNY', 'CNY', table, { now: NOW }).ok).toBe(false)
  })

  it('能列出缺少哪些币种的汇率', () => {
    const partial = createFxTable([makeFxRate('USD', 'CNY', 7.2, { timestamp: ISO })])
    const missing = missingCurrencyForCny(partial, ['CNY', 'USD', 'HKD', 'SGD'], { now: NOW })
    expect(missing.sort()).toEqual(['HKD', 'SGD'])
  })
})
