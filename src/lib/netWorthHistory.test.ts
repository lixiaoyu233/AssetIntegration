import { describe, expect, it } from 'vitest'
import type { Portfolio } from '../types/asset'
import {
  advanceSnapshot,
  computeStats,
  longMonth,
  measure,
  monthDiff,
  monthKey,
  normalizeSnapshot,
  prevMonth,
  shortMonth,
  sliceByRange,
  type NetWorthPoint,
  type SnapshotFile,
} from './netWorthHistory'

/* ------------------------------------------------------------------ *
 * 测试数据
 * ------------------------------------------------------------------ */

/** 资产 10 万 + 负债 4 万 → 净资产 6 万 */
const portfolio = (assets = 100000, liabilities = 40000): Portfolio => ({
  version: 2,
  history: [],
  categories: [
    {
      id: 'cat_cash', name: '现金与固定资产', subtitle: '', icon: 'banknote',
      color: 'var(--accent-gold)', colorName: 'gold',
      items: [{ id: 'a1', kind: 'amount', name: '活期', amount: assets }],
    },
    {
      id: 'cat_debt', name: '负债', subtitle: '', icon: 'scale',
      color: 'var(--accent-red)', colorName: 'red', isLiability: true,
      items: [{ id: 'd1', kind: 'amount', name: '房贷', amount: liabilities }],
    },
  ],
})

/** 无负债组合：净资产 == 总资产，便于断言 */
const noDebt = (assets: number) => portfolio(assets, 0)

const point = (month: string, netWorth: number, final = true): NetWorthPoint => ({
  month,
  assets: netWorth,
  liabilities: 0,
  netWorth,
  final,
})

const file = (...points: NetWorthPoint[]): SnapshotFile => ({ version: 1, points })

/* ------------------------------------------------------------------ *
 * 时间工具
 * ------------------------------------------------------------------ */

describe('月份工具', () => {
  it('monthKey / prevMonth 处理跨年', () => {
    expect(monthKey(new Date(2026, 9, 3))).toBe('2026-10')
    expect(prevMonth('2026-01')).toBe('2025-12')
    expect(prevMonth('2026-10')).toBe('2026-09')
  })

  it('monthDiff 计算月份差', () => {
    expect(monthDiff('2026-10', '2026-08')).toBe(2)
    expect(monthDiff('2026-01', '2025-11')).toBe(2)
    expect(monthDiff('2026-10', '2026-10')).toBe(0)
  })

  it('月份格式化', () => {
    expect(shortMonth('2026-10')).toBe('26/10')
    expect(longMonth('2026-10')).toBe('2026年10月')
    expect(longMonth('2026-01')).toBe('2026年1月')
  })
})

/* ------------------------------------------------------------------ *
 * 规范化
 * ------------------------------------------------------------------ */

describe('快照规范化', () => {
  it('空数据返回空文件', () => {
    expect(normalizeSnapshot(null).points).toEqual([])
    expect(normalizeSnapshot({ points: 'x' }).points).toEqual([])
  })

  it('过滤脏记录并按月份排序', () => {
    const f = normalizeSnapshot({
      points: [
        { month: '2026-10', assets: 1, liabilities: 0, netWorth: 1 },
        { month: '坏月份', assets: 1, liabilities: 0, netWorth: 1 },
        { month: '2026-08', assets: 2, liabilities: 0, netWorth: 2 },
        { month: '2026-09', assets: 'x', liabilities: 0, netWorth: 0 },
      ],
    })
    expect(f.points.map((p) => p.month)).toEqual(['2026-08', '2026-10'])
  })

  it('同月重复时保留最后一条', () => {
    const f = normalizeSnapshot({
      points: [
        { month: '2026-10', assets: 1, liabilities: 0, netWorth: 1 },
        { month: '2026-10', assets: 9, liabilities: 0, netWorth: 9 },
      ],
    })
    expect(f.points).toHaveLength(1)
    expect(f.points[0].netWorth).toBe(9)
  })
})

/* ------------------------------------------------------------------ *
 * 口径
 * ------------------------------------------------------------------ */

describe('取值口径', () => {
  it('含负债：分开统计再相减', () => {
    const m = measure({ portfolio: portfolio(100000, 40000), includeLiabilities: true })
    expect(m.assets).toBe(100000)
    expect(m.liabilities).toBe(40000)
    expect(m.netWorth).toBe(60000)
  })

  it('不含负债：净资产与总资产都取资产侧，负债记 0', () => {
    const m = measure({ portfolio: portfolio(100000, 40000), includeLiabilities: false })
    expect(m.assets).toBe(100000)
    expect(m.liabilities).toBe(0)
    expect(m.netWorth).toBe(100000)
  })

  it('金额保留两位小数', () => {
    const mk = (amount: number): Portfolio => ({
      version: 2, history: [], categories: [{
        id: 'c', name: '现金', subtitle: '', icon: 'banknote', color: 'x', colorName: 'gold',
        items: [{ id: 'i', kind: 'amount', name: 'x', amount }],
      }],
    })
    expect(measure({ portfolio: mk(1234.567), includeLiabilities: true }).netWorth).toBe(1234.57)
    expect(measure({ portfolio: mk(0.004), includeLiabilities: true }).netWorth).toBe(0)
    // 注意：1.005 在二进制浮点里是 1.00499999...，乘 100 后四舍五入得到 1 而非 1.01，
    // 这是 IEEE754 的正常行为，不作为缺陷处理
    expect(measure({ portfolio: mk(1.005), includeLiabilities: true }).netWorth).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * 推进：定稿 / 补月 / 幂等
 * ------------------------------------------------------------------ */

describe('推进快照', () => {
  it('首次使用写入当月（暂定）', () => {
    const r = advanceSnapshot(file(), { portfolio: portfolio(100000, 40000), includeLiabilities: true }, new Date(2026, 9, 5))
    expect(r.file.points).toHaveLength(1)
    expect(r.file.points[0]).toMatchObject({ month: '2026-10', netWorth: 60000, final: false })
  })

  it('当月数据变动时更新同一个点，不新增月份', () => {
    const first = advanceSnapshot(file(), { portfolio: noDebt(100000), includeLiabilities: true }, new Date(2026, 9, 5))
    const second = advanceSnapshot(first.file, { portfolio: noDebt(120000), includeLiabilities: true }, new Date(2026, 9, 20))
    expect(second.file.points).toHaveLength(1)
    expect(second.file.points[0].netWorth).toBe(120000)
    expect(second.file.points[0].final).toBe(false)
  })

  it('数据没变时不标记 changed（避免无谓写盘）', () => {
    const first = advanceSnapshot(file(), { portfolio: noDebt(100000), includeLiabilities: true }, new Date(2026, 9, 5))
    const same = advanceSnapshot(first.file, { portfolio: noDebt(100000), includeLiabilities: true }, new Date(2026, 9, 20))
    expect(same.changed).toBe(false)
  })

  it('进入新月份时把上个月定稿', () => {
    const oct = advanceSnapshot(file(), { portfolio: noDebt(100000), includeLiabilities: true }, new Date(2026, 9, 5))
    const nov = advanceSnapshot(oct.file, { portfolio: noDebt(110000), includeLiabilities: true }, new Date(2026, 10, 3))
    const byMonth = new Map(nov.file.points.map((p) => [p.month, p]))
    expect(byMonth.get('2026-10')).toMatchObject({ final: true, netWorth: 100000 })
    expect(byMonth.get('2026-11')).toMatchObject({ final: false, netWorth: 110000 })
    expect(nov.finalized).toContain('2026-10')
  })

  it('跳过整月时沿用上一个定稿值补齐', () => {
    const oct = advanceSnapshot(file(), { portfolio: noDebt(100000), includeLiabilities: true }, new Date(2026, 9, 5))
    // 11 月整月没打开，12 月才打开
    const dec = advanceSnapshot(oct.file, { portfolio: noDebt(130000), includeLiabilities: true }, new Date(2026, 11, 2))
    const byMonth = new Map(dec.file.points.map((p) => [p.month, p]))
    expect([...byMonth.keys()].sort()).toEqual(['2026-10', '2026-11', '2026-12'])
    expect(byMonth.get('2026-11')).toMatchObject({ netWorth: 100000, final: true })
    expect(byMonth.get('2026-12')).toMatchObject({ netWorth: 130000, final: false })
    expect(dec.finalized).toContain('2026-11')
  })

  it('连跳多个月会逐月补齐', () => {
    const jan = advanceSnapshot(file(), { portfolio: noDebt(100000), includeLiabilities: true }, new Date(2026, 0, 5))
    const may = advanceSnapshot(jan.file, { portfolio: noDebt(150000), includeLiabilities: true }, new Date(2026, 4, 3))
    const months = may.file.points.map((p) => p.month)
    expect(months).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'])
    expect(may.file.points.filter((p) => p.final).map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
  })

  it('定稿后的历史点不会被后续数据变动改写', () => {
    const oct = advanceSnapshot(file(), { portfolio: noDebt(100000), includeLiabilities: true }, new Date(2026, 9, 5))
    const nov = advanceSnapshot(oct.file, { portfolio: noDebt(110000), includeLiabilities: true }, new Date(2026, 10, 3))
    // 11 月里资产又变了，10 月的历史值必须保持
    const nov2 = advanceSnapshot(nov.file, { portfolio: noDebt(90000), includeLiabilities: true }, new Date(2026, 10, 20))
    const byMonth = new Map(nov2.file.points.map((p) => [p.month, p]))
    expect(byMonth.get('2026-10')?.netWorth).toBe(100000)
    expect(byMonth.get('2026-11')?.netWorth).toBe(90000)
  })

  it('跨年定稿正确（1 月定稿去年 12 月）', () => {
    const dec = advanceSnapshot(file(), { portfolio: noDebt(100000), includeLiabilities: true }, new Date(2025, 11, 10))
    const jan = advanceSnapshot(dec.file, { portfolio: noDebt(120000), includeLiabilities: true }, new Date(2026, 0, 4))
    const byMonth = new Map(jan.file.points.map((p) => [p.month, p]))
    expect(byMonth.get('2025-12')).toMatchObject({ final: true, netWorth: 100000 })
    expect(byMonth.get('2026-01')).toMatchObject({ final: false, netWorth: 120000 })
  })

  it('重复推进不会产生重复月份', () => {
    let f = file()
    for (let i = 0; i < 5; i++) {
      f = advanceSnapshot(f, { portfolio: noDebt(100000 + i), includeLiabilities: true }, new Date(2026, 9, 5)).file
    }
    expect(f.points).toHaveLength(1)
    expect(new Set(f.points.map((p) => p.month)).size).toBe(f.points.length)
  })
})

/* ------------------------------------------------------------------ *
 * 区间筛选与统计
 * ------------------------------------------------------------------ */

describe('区间与统计', () => {
  const points = Array.from({ length: 40 }, (_, i) => {
    const y = 2023 + Math.floor(i / 12)
    const m = (i % 12) + 1
    return point(`${y}-${String(m).padStart(2, '0')}`, 1000 * (i + 1))
  })

  it('按范围截取，永远保留最后一个月', () => {
    expect(sliceByRange(points, 'all')).toHaveLength(40)
    expect(sliceByRange(points, '6m')).toHaveLength(6)
    expect(sliceByRange(points, '1y')).toHaveLength(12)
    expect(sliceByRange(points, '3y')).toHaveLength(36)
    expect(sliceByRange(points, '6m').slice(-1)[0]).toBe(points.slice(-1)[0])
  })

  it('点数少于范围时原样返回', () => {
    expect(sliceByRange(points.slice(0, 3), '1y')).toHaveLength(3)
  })

  it('统计最高/最低/累计变化/环比', () => {
    const stats = computeStats(sliceByRange(points, '6m'), 'netWorth')
    const slice = points.slice(-6)
    expect(stats.max?.netWorth).toBe(Math.max(...slice.map((p) => p.netWorth)))
    expect(stats.min?.netWorth).toBe(Math.min(...slice.map((p) => p.netWorth)))
    const last = slice.slice(-1)[0]
    expect(stats.delta).toBeCloseTo(last.netWorth - slice[0].netWorth, 6)
    expect(stats.rate).toBeGreaterThan(0)
    expect(stats.mom?.delta).toBeCloseTo(last.netWorth - slice.slice(-2)[0].netWorth, 6)
  })

  it('单点时没有环比', () => {
    const stats = computeStats([point('2026-10', 100)], 'netWorth')
    expect(stats.mom).toBeNull()
    expect(stats.delta).toBe(0)
  })

  it('空数组不崩', () => {
    const stats = computeStats([], 'netWorth')
    expect(stats.max).toBeUndefined()
    expect(stats.mom).toBeNull()
  })

  it('首值为 0 时变化率为 0（不产生 Infinity）', () => {
    const stats = computeStats([point('2026-09', 0), point('2026-10', 100)], 'netWorth')
    expect(Number.isFinite(stats.rate)).toBe(true)
    expect(stats.rate).toBe(0)
  })

  it('可按不同指标统计', () => {
    const mixed: NetWorthPoint[] = [
      { month: '2026-09', assets: 100, liabilities: 10, netWorth: 90, final: true },
      { month: '2026-10', assets: 200, liabilities: 30, netWorth: 170, final: false },
    ]
    expect(computeStats(mixed, 'assets').delta).toBe(100)
    expect(computeStats(mixed, 'liabilities').delta).toBe(20)
    expect(computeStats(mixed, 'netWorth').delta).toBe(80)
  })
})
