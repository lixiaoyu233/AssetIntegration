import type { Category, Portfolio } from '../types/asset'
import { accentVar, ACCENT_NAMES } from './strategies'

export const SCHEMA_VERSION = 2

/**
 * 默认分类（严格对齐产品需求）：
 * 现金与固定资产 / 股票 / 基金 / 黄金 / 负债
 * color 为主题色，用于图标底色与卡片强调；icon 为 lib/icons.ts 白名单键名。
 */
export function createDefaultCategories(): Category[] {
  return [
    {
      id: 'cat_cash',
      name: '现金与固定资产',
      subtitle: '银行 / 房产 / 现金',
      icon: 'banknote',
      color: accentVar('gold'),
      colorName: 'gold',
      items: [],
    },
    {
      id: 'cat_stock',
      name: '股票',
      subtitle: '全球市场 / 场内基金',
      icon: 'trending-up',
      color: accentVar('blue'),
      colorName: 'blue',
      // 股票分类既可直接记金额，也可登记美股/港股持仓（表单里有切换）
      defaultKind: 'amount',
      items: [],
    },
    {
      id: 'cat_fund',
      name: '基金',
      subtitle: '场外基金 / 持仓 / 净值',
      icon: 'chart-pie',
      color: accentVar('green'),
      colorName: 'green',
      // 空分类也要知道该用「基金」表单，否则第一次添加会错给成金额表单
      defaultKind: 'fund',
      items: [],
    },
    {
      id: 'cat_gold',
      name: '黄金',
      subtitle: '银行积存金 / 平台 / 克数',
      icon: 'gem',
      color: accentVar('gold'),
      colorName: 'gold',
      defaultKind: 'gold',
      items: [],
    },
    {
      id: 'cat_bond',
      name: '国债',
      subtitle: '中国国债 / 美国10年期国债',
      icon: 'landmark',
      color: accentVar('cyan'),
      colorName: 'cyan',
      items: [],
    },
    {
      id: 'cat_debt',
      name: '负债',
      subtitle: '房贷 / 信用卡 / 消费贷',
      icon: 'credit-card',
      color: accentVar('red'),
      colorName: 'red',
      isLiability: true,
      items: [],
    },
  ]
}

/**
 * 版本升级用的分类补齐。
 *
 * 场景：老用户的 localStorage 里没有后来新增的默认分类（例如「国债」）。
 * 这里把缺失的内置分类插到默认顺序对应的位置，**不动任何已有分类**，
 * 也不覆盖用户改过的名称 / 图标 / 颜色，避免升级把用户数据搞乱。
 */
export function mergeDefaultCategories(categories: Category[]): { categories: Category[]; added: string[] } {
  const existingIds = new Set(categories.map((c) => c.id))
  const defaults = createDefaultCategories()
  const missing = defaults.filter((d) => !existingIds.has(d.id))
  if (missing.length === 0) return { categories, added: [] }

  const order = defaults.map((d) => d.id)
  const out = [...categories]
  for (const miss of missing) {
    const targetIdx = order.indexOf(miss.id)
    // 找到「在默认顺序里排在它前面、且当前确实存在」的最后一个分类，插到它后面
    let insertAt = 0
    for (let i = 0; i < targetIdx; i++) {
      const idx = out.findIndex((c) => c.id === order[i])
      if (idx >= 0) insertAt = Math.max(insertAt, idx + 1)
    }
    out.splice(insertAt, 0, miss)
  }
  // 只有确实缺失、又不在用户分类里的才算「新增」
  return { categories: out, added: missing.map((m) => m.id) }
}

export function createEmptyPortfolio(): Portfolio {
  return {
    version: SCHEMA_VERSION,
    categories: createDefaultCategories(),
    history: [],
  }
}

/** 新增自定义分类时轮换使用的主题色（CSS 变量，自动适配白天/夜间） */
export const CATEGORY_COLORS: string[] = ACCENT_NAMES.map(accentVar)

/** 可选的预设分类模板，方便一键添加 */
export const CATEGORY_TEMPLATES: Array<
  Pick<Category, 'name' | 'subtitle' | 'icon' | 'color' | 'colorName' | 'isLiability'>
> = [
  { name: '股票', subtitle: '全球市场 / 场内基金', icon: 'trending-up', color: accentVar('blue'), colorName: 'blue' },
  { name: '基金', subtitle: '场外基金 / 持仓 / 净值', icon: 'chart-pie', color: accentVar('green'), colorName: 'green' },
  { name: '黄金', subtitle: '银行积存金 / 平台 / 克数', icon: 'gem', color: accentVar('gold'), colorName: 'gold' },
  {
    name: '国债',
    subtitle: '中国国债 / 美国10年期国债',
    icon: 'landmark',
    color: accentVar('cyan'),
    colorName: 'cyan',
  },
  { name: '现金与固定资产', subtitle: '银行 / 房产 / 现金', icon: 'banknote', color: accentVar('gold'), colorName: 'gold' },
  { name: '数字货币', subtitle: '交易所 / 冷钱包', icon: 'bitcoin', color: accentVar('orange'), colorName: 'orange' },
  { name: '保险与年金', subtitle: '储蓄险 / 年金 / 现金价值', icon: 'shield', color: accentVar('cyan'), colorName: 'cyan' },
  { name: '应收账款', subtitle: '借出款 / 待结算', icon: 'receipt', color: accentVar('purple'), colorName: 'purple' },
  { name: '负债', subtitle: '房贷 / 信用卡 / 消费贷', icon: 'credit-card', color: accentVar('red'), colorName: 'red', isLiability: true },
]
