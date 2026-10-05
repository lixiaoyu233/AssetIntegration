import { describe, expect, it } from 'vitest'
import type { Portfolio } from '../types/asset'
import {
  type AppSettings,
  applySalaryToPortfolio,
  createDefaultSettings,
  currentMonth,
  formatMonth,
  isPaydayReached,
  listCashCandidates,
  normalizeSettings,
  shouldAutoApply,
} from './settings'

/** 取金额类条目的数值，顺便收窄联合类型，避免测试里到处断言 */
const amountOf = (p: Portfolio, catId: string, itemId: string): number => {
  const item = p.categories.find((c) => c.id === catId)?.items.find((i) => i.id === itemId)
  if (!item || item.kind !== 'amount') throw new Error(`未找到金额条目 ${catId}/${itemId}`)
  return item.amount
}

const portfolio = (cashAmount = 100000): Portfolio => ({
  version: 2,
  history: [],
  categories: [
    {
      id: 'cat_cash', name: '现金与固定资产', subtitle: '', icon: 'banknote',
      color: 'var(--accent-gold)', colorName: 'gold',
      items: [{ id: 'a1', kind: 'amount', name: '招行活期', amount: cashAmount }],
    },
    {
      id: 'cat_fund', name: '基金', subtitle: '', icon: 'chart-pie',
      color: 'var(--accent-green)', colorName: 'green',
      items: [
        { id: 'f1', kind: 'fund', name: '某基金', code: '161725', shares: 100, costNav: 1, manualNav: 2 },
      ],
    },
    {
      id: 'cat_debt', name: '负债', subtitle: '', icon: 'scale',
      color: 'var(--accent-red)', colorName: 'red',
      isLiability: true,
      items: [{ id: 'd1', kind: 'amount', name: '房贷', amount: 500000 }],
    },
  ],
})

const withSalary = (patch: Partial<AppSettings['salary']> = {}): AppSettings => {
  const base = createDefaultSettings()
  return { ...base, salary: { ...base.salary, ...patch } }
}

describe('薪资：时间工具', () => {
  it('currentMonth 输出 YYYY-MM', () => {
    expect(currentMonth(new Date(2026, 9, 3))).toBe('2026-10')
    expect(currentMonth(new Date(2026, 0, 1))).toBe('2026-01')
  })

  it('formatMonth 转成中文', () => {
    expect(formatMonth('2026-10')).toBe('2026年10月')
    expect(formatMonth('2026-01')).toBe('2026年1月')
    expect(formatMonth('坏数据')).toBe('坏数据')
  })

  it('发薪日判定：当天及之后算到', () => {
    expect(isPaydayReached(10, new Date(2026, 9, 9))).toBe(false)
    expect(isPaydayReached(10, new Date(2026, 9, 10))).toBe(true)
    expect(isPaydayReached(10, new Date(2026, 9, 28))).toBe(true)
    // 上限 28：29~31 在小月不存在，按 28 处理
    expect(isPaydayReached(31, new Date(2026, 9, 29))).toBe(true)
  })
})

describe('设置规范化', () => {
  it('空数据回落到默认值', () => {
    const s = normalizeSettings(null)
    expect(s.fund.useFunding).toBe(false)
    expect(s.salary.records).toEqual([])
    expect(s.salary.fixed.payday).toBe(10)
  })

  it('脏薪资记录被过滤，同月只保留最后一条', () => {
    const s = normalizeSettings({
      salary: {
        records: [
          { month: '2026-09', amount: 100 },
          { month: '坏', amount: 1 },
          { month: '2026-09', amount: 200 },
          { month: '2026-08', amount: 'x' },
        ],
      },
    })
    expect(s.salary.records).toHaveLength(1)
    expect(s.salary.records[0]).toEqual(expect.objectContaining({ month: '2026-09', amount: 200 }))
  })

  it('发薪日被限制在 1~28', () => {
    expect(normalizeSettings({ salary: { fixed: { payday: 99 } } }).salary.fixed.payday).toBe(28)
    expect(normalizeSettings({ salary: { fixed: { payday: 0 } } }).salary.fixed.payday).toBe(1)
    expect(normalizeSettings({ salary: { fixed: { payday: 15 } } }).salary.fixed.payday).toBe(15)
  })

  it('不完整的资金来源被丢弃', () => {
    const s = normalizeSettings({ salary: { fixed: { target: { itemId: 'a1' } } } })
    expect(s.salary.fixed.target).toBeUndefined()
  })
})

describe('可划拨的现金项目', () => {
  it('只列出金额类且余额为正的条目', () => {
    const list = listCashCandidates(portfolio())
    expect(list.map((c) => c.itemId)).toEqual(['a1'])
  })

  it('排除负债分类与投资类条目', () => {
    const list = listCashCandidates(portfolio())
    expect(list.some((c) => c.itemId === 'd1')).toBe(false) // 负债
    expect(list.some((c) => c.itemId === 'f1')).toBe(false) // 基金持仓
  })

  it('排除余额为 0 或负的条目', () => {
    expect(listCashCandidates(portfolio(0))).toHaveLength(0)
    expect(listCashCandidates(portfolio(-5))).toHaveLength(0)
  })
})

describe('薪资写入现金项', () => {
  const target = { categoryId: 'cat_cash', itemId: 'a1', itemName: '招行活期' }

  it('写入后余额增加，标记已入账', () => {
    const settings = withSalary({
      records: [{ month: '2026-10', amount: 20000, at: 1 }],
      fixed: { enabled: true, amount: 20000, payday: 1, target },
    })
    const res = applySalaryToPortfolio(portfolio(), settings, '2026-10')
    expect(res.applied).toBe(true)
    expect(res.amount).toBe(20000)
    expect(amountOf(res.portfolio, 'cat_cash', 'a1')).toBe(120000)
  })

  it('已入账的记录不会再次写入（幂等）', () => {
    const settings = withSalary({
      records: [{ month: '2026-10', amount: 20000, at: 1, applied: true }],
      fixed: { enabled: true, amount: 20000, payday: 1, target },
    })
    const res = applySalaryToPortfolio(portfolio(), settings, '2026-10')
    expect(res.applied).toBe(false)
    expect(res.reason).toContain('未重复添加')
    expect(amountOf(res.portfolio, 'cat_cash', 'a1')).toBe(100000)
  })

  it('没有目标项目时拒绝写入', () => {
    const settings = withSalary({ records: [{ month: '2026-10', amount: 1, at: 1 }] })
    const res = applySalaryToPortfolio(portfolio(), settings, '2026-10')
    expect(res.applied).toBe(false)
    expect(res.reason).toContain('项目')
  })

  it('目标项目不存在时给出可操作原因', () => {
    const settings = withSalary({
      records: [{ month: '2026-10', amount: 1, at: 1 }],
      fixed: { enabled: true, amount: 1, payday: 1, target: { ...target, itemId: '不存在' } },
    })
    const res = applySalaryToPortfolio(portfolio(), settings, '2026-10')
    expect(res.applied).toBe(false)
    expect(res.reason).toContain('重新选择')
  })

  it('不修改原对象（纯函数）', () => {
    const before = portfolio()
    const settings = withSalary({
      records: [{ month: '2026-10', amount: 5000, at: 1 }],
      fixed: { enabled: true, amount: 5000, payday: 1, target },
    })
    applySalaryToPortfolio(before, settings, '2026-10')
    expect(amountOf(before, 'cat_cash', 'a1')).toBe(100000)
  })
})

describe('是否应自动入账', () => {
  const target = { categoryId: 'cat_cash', itemId: 'a1', itemName: '招行活期' }
  const base = (patch: Partial<AppSettings['salary']> = {}) =>
    withSalary({
      records: [{ month: '2026-10', amount: 20000, at: 1 }],
      fixed: { enabled: true, amount: 20000, payday: 10, target },
      ...patch,
    })

  it('开了固定薪资 + 到发薪日 + 未入账 → 应写入', () => {
    expect(shouldAutoApply(base(), '2026-10', new Date(2026, 9, 10))).toBe(true)
    expect(shouldAutoApply(base(), '2026-10', new Date(2026, 9, 20))).toBe(true)
  })

  it('未到发薪日不写入', () => {
    expect(shouldAutoApply(base(), '2026-10', new Date(2026, 9, 9))).toBe(false)
  })

  it('未开启固定薪资 / 未选目标 / 金额为 0 都不写入', () => {
    expect(
      shouldAutoApply(base({ fixed: { enabled: false, amount: 1, payday: 1, target } }), '2026-10', new Date(2026, 9, 20)),
    ).toBe(false)
    expect(
      shouldAutoApply(base({ fixed: { enabled: true, amount: 1, payday: 1 } }), '2026-10', new Date(2026, 9, 20)),
    ).toBe(false)
    expect(
      shouldAutoApply(base({ fixed: { enabled: true, amount: 0, payday: 1, target } }), '2026-10', new Date(2026, 9, 20)),
    ).toBe(false)
  })

  it('该月已入账则不写入', () => {
    const s = base({ records: [{ month: '2026-10', amount: 20000, at: 1, applied: true }] })
    expect(shouldAutoApply(s, '2026-10', new Date(2026, 9, 20))).toBe(false)
  })

  it('没有该月记录就不写入（避免凭空加钱）', () => {
    expect(shouldAutoApply(base({ records: [] }), '2026-10', new Date(2026, 9, 20))).toBe(false)
  })
})
