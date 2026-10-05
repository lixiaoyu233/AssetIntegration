/** 资产条目形态 */
export type ItemKind = 'amount' | 'fund' | 'gold'

import type { CurrencyCode } from '../lib/currency'
import type { HoldingMarket } from '../lib/usStock'

/** 基金归属的资产类型（与 calc.FUND_ASSET_CLASS_LABEL 对应） */
export type FundAssetClass = 'equity' | 'bond' | 'money' | 'commodity' | 'mixed' | 'unknown'

/** 币种（实际取值见 lib/currency.ts 的 CURRENCIES） */
export type Currency = 'CNY'

/** 金额形态条目（现金 / 房产 / 负债等直接录入金额的场景） */
export interface AmountItem extends BaseItem {
  kind: 'amount'
  /** 金额（可为负，负债通常以正数录入并由分类的 isLiability 扣减），以 currency 指定的币种计价 */
  amount: number
  /**
   * 币种，缺省视为人民币。
   * 汇总时按实时汇率折算成人民币，因此总资产会随汇率变动。
   */
  currency?: CurrencyCode
}

export interface BaseItem {
  id: string
  /**
   * 所属分类由 Portfolio.categories[].id 承载，条目内部不再冗余存储，
   * 便于分类改名 / 排序时不产生数据不一致。
   */
  kind: ItemKind
  name: string
  /** 备注，展示为卡片列表里的小字 */
  note?: string
}

/** 基金条目：以真实基金代码 + 份额 + 成本单价登记 */
export interface FundItem extends BaseItem {
  kind: 'fund'
  /**
   * 代码：境内基金为 6 位数字；美股/港股为字母或 1~5 位数字。
   * 由 market 字段决定如何解释。
   */
  code: string
  /**
   * 持仓市场：
   * - `cn`（默认，视为境内场外基金，走天天基金接口）
   * - `us` 美股 / 美股 ETF（腾讯行情，USD 计价）
   * - `hk` 港股（腾讯行情，HKD 计价）
   */
  market?: HoldingMarket
  /** 持有份额 */
  shares: number
  /** 成本单价（每份成本） */
  costNav: number
  /**
   * 手动填写的当前净值 / 现价。
   * 优先于自动同步的结果，用于接口查不到代码或数据源不可用时的兜底。
   */
  manualNav?: number
  /** 用户是否自定义过名称；未自定义时用接口返回的基金全称自动补全 */
  manualName?: boolean
  /**
   * 该持仓的资金来源（从哪个现金/固资项目划拨买入）。
   * 金额已从来源项目扣减，这里只作记录与对账。
   */
  fundedFrom?: { categoryId: string; itemId: string; itemName: string; amount: number }
  /**
   * 用户手动标记的资产类型；不填时由基金名称关键词自动识别（见 calc.effectiveFundClass）。
   * 再平衡计算会用它把基金归到「股票」或「债券」等策略类别。
   */
  assetClass?: FundAssetClass
  /** 最近一次同步到的行情快照 */
  quote?: FundQuote
}

/** 黄金条目：按克数 + 单价登记，支持实时金价手工刷新 */
export interface GoldItem extends BaseItem {
  kind: 'gold'
  /** 持有克数 */
  grams: number
  /** 计价单价（每克），以 currency 指定的币种计价 */
  pricePerGram: number
  /** 币种，缺省视为人民币 */
  currency?: CurrencyCode
}

export type AssetItem = AmountItem | FundItem | GoldItem

/** 基金行情快照，由天天基金接口回填 */
export interface FundQuote {
  code: string
  /** 基金全称，如「招商中证白酒指数(LOF)A」 */
  name: string
  /** 交易日盘中估算净值（接口 GSZ），QDII / 非交易时段为空 */
  estimatedNav?: number
  /** 盘中估算涨跌幅（小数，如 0.0212 表示 +2.12%） */
  estimatedRate?: number
  /** 估算时间，如 2026-10-03 14:30 */
  estimatedAt?: string
  /** 最新公布单位净值（接口 NAV） */
  publishedNav?: number
  /** 最新公布净值的涨跌幅（小数） */
  publishedRate?: number
  /** 净值公布日期，如 2026-09-30 */
  publishedAt?: string
  /** 最近一次估值更新时间戳（毫秒） */
  fetchedAt: number
  /** 数据来源，便于排查 */
  source: string
  /** 行情所属市场（美股/港股时由接口回填，境内基金为 cn） */
  market?: HoldingMarket
  /** 行情计价币种（境内基金人民币、美股 USD、港股 HKD） */
  currency?: CurrencyCode
}

/** 资产分类（卡片） */
export interface Category {
  id: string
  name: string
  /** 副标题描述，如「银行 / 房产 / 现金」 */
  subtitle: string
  /** lucide 图标名，见 lib/icons.ts 的映射白名单 */
  icon: string
  /** 主题色（形如 `var(--accent-gold)`），随主题切换 */
  color: string
  /** 色名（gold/blue/…），用于取对应的半透明底色变量；自定义颜色时为空 */
  colorName?: string
  /** 是否计入负债（负债类金额取负参与净资产计算） */
  isLiability?: boolean
  /**
   * 该分类新增条目时的默认形态。
   * 空分类无法靠已有条目推断，必须显式声明，否则「基金」会错给成金额表单。
   */
  defaultKind?: ItemKind
  items: AssetItem[]
}

/** 净资产历史快照，用于「较上次」变化提示 */
export interface HistoryPoint {
  /** 快照日期 YYYY-MM-DD */
  date: string
  netWorth: number
  totalAssets: number
  totalLiabilities: number
  /** 快照时间戳 */
  at: number
}

export interface Portfolio {
  version: number
  categories: Category[]
  history: HistoryPoint[]
  /** 最近一次整体刷新时间戳 */
  lastSyncedAt?: number
}

/** 汇总结果 */
export interface Summary {
  netWorth: number
  totalAssets: number
  totalLiabilities: number
}

/** 单个条目的估值结果 */
export interface ItemValuation {
  /** 当前市值（人民币） */
  value: number
  /** 成本 */
  cost?: number
  /** 盈亏金额（仅 fund / gold 有意义） */
  profit?: number
  /** 盈亏比例（小数） */
  profitRate?: number
  /** 该条目使用的币种（基金恒为 CNY） */
  currency: CurrencyCode
  /** 原币市值（currency 为 CNY 时与 value 相同） */
  valueInCurrency: number
  /**
   * 是否缺少汇率导致未能折算（true 时 value 退化为原币数值）。
   * 界面需要据此提示「汇率不可用」，而不是悄悄给出错误的人民币金额。
   */
  missingRate: boolean
}
