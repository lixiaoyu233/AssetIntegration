import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_NETWORTH_KEY,
  LEGACY_PORTFOLIO_KEYS,
  hasLegacyData,
  readLegacyNetWorthPoints,
  readLegacyPortfolio,
  removeLegacyData,
} from './legacyStore'

/*
 * 旧数据读取器测试。
 * 重点：只读、不删、损坏数据不抛错、清理必须显式确认。
 */

/** 最小 localStorage stub（node 环境没有 DOM） */
function installLocalStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed))
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
    clear: () => map.clear(),
  }
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  define('window', { localStorage: storage })
  return map
}

function removeStub() {
  delete (globalThis as unknown as Record<string, unknown>).window
}

const sampleLegacy = JSON.stringify({
  version: 2,
  categories: [{ id: 'c', name: '现金', items: [{ id: 'a', kind: 'amount', name: '招行', amount: 100 }] }],
})

describe('读取旧资产数据', () => {
  afterEach(removeStub)

  it('从主键读到数据并返回命中的键名', () => {
    installLocalStorage({ [LEGACY_PORTFOLIO_KEYS[0]]: sampleLegacy })
    const r = readLegacyPortfolio()
    expect(r.portfolio).not.toBeNull()
    expect(r.sourceKey).toBe(LEGACY_PORTFOLIO_KEYS[0])
    expect(r.error).toBeUndefined()
  })

  it('主键缺失时回退到更早的历史键', () => {
    installLocalStorage({ 'assetCardWallet': sampleLegacy })
    const r = readLegacyPortfolio()
    expect(r.sourceKey).toBe('assetCardWallet')
  })

  it('没有任何旧数据时返回 null 而不是报错', () => {
    installLocalStorage()
    const r = readLegacyPortfolio()
    expect(r.portfolio).toBeNull()
    expect(r.error).toBeUndefined()
  })

  it('数据损坏时返回 error 且不抛异常（原数据不动）', () => {
    const map = installLocalStorage({ [LEGACY_PORTFOLIO_KEYS[0]]: '{ not json' })
    const r = readLegacyPortfolio()
    expect(r.portfolio).toBeNull()
    expect(r.error).toContain('格式异常')
    // 关键：读取失败不得顺手删掉旧数据
    expect(map.get(LEGACY_PORTFOLIO_KEYS[0])).toBe('{ not json')
  })

  it('localStorage 被禁用时不崩', () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        get localStorage() {
          throw new Error('disabled')
        },
      },
      configurable: true,
      writable: true,
    })
    expect(() => readLegacyPortfolio()).not.toThrow()
  })

  it('没有 window（SSR）时返回空', () => {
    removeStub()
    const r = readLegacyPortfolio()
    expect(r.portfolio).toBeNull()
    expect(r.netWorthPoints).toEqual([])
  })
})

describe('读取旧月度走势', () => {
  afterEach(removeStub)

  it('解析 points 数组', () => {
    installLocalStorage({
      [LEGACY_NETWORTH_KEY]: JSON.stringify({ version: 1, points: [{ month: '2026-09', netWorth: 1 }] }),
    })
    expect(readLegacyNetWorthPoints()).toHaveLength(1)
  })

  it('points 不是数组时返回空', () => {
    installLocalStorage({ [LEGACY_NETWORTH_KEY]: JSON.stringify({ points: 'oops' }) })
    expect(readLegacyNetWorthPoints()).toEqual([])
  })
})

describe('旧数据存在性检测', () => {
  afterEach(removeStub)

  it('有旧数据返回 true', () => {
    installLocalStorage({ [LEGACY_PORTFOLIO_KEYS[0]]: sampleLegacy })
    expect(hasLegacyData()).toBe(true)
  })

  it('无旧数据返回 false', () => {
    installLocalStorage()
    expect(hasLegacyData()).toBe(false)
  })
})

describe('清理旧数据（必须显式确认）', () => {
  beforeEach(() => {
    installLocalStorage({
      [LEGACY_PORTFOLIO_KEYS[0]]: sampleLegacy,
      [LEGACY_NETWORTH_KEY]: JSON.stringify({ version: 1, points: [] }),
    })
  })
  afterEach(removeStub)

  it('未确认新数据可用时拒绝清理', () => {
    const r = removeLegacyData(false)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('拒绝')
    expect(r.removed).toEqual([])
    // 数据仍在
    expect(hasLegacyData()).toBe(true)
  })

  it('明确确认后才会删除', () => {
    const r = removeLegacyData(true)
    expect(r.ok).toBe(true)
    expect(r.removed.length).toBeGreaterThan(0)
    expect(hasLegacyData()).toBe(false)
  })

  it('没有旧数据时也是成功且删除列表为空', () => {
    removeLegacyData(true)
    const again = removeLegacyData(true)
    expect(again.ok).toBe(true)
    expect(again.removed).toEqual([])
  })
})
