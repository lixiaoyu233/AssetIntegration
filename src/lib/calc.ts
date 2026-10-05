import type {
  AssetItem,
  Category,
  ItemKind,
  FundItem,
  FundQuote,
  GoldItem,
  ItemValuation,
  Portfolio,
  Summary,
} from '../types/asset'
import { type CurrencyCode, type FxRates, toCny } from './currency'
import { HOLDING_MARKET_CURRENCY, type HoldingMarket } from './usStock'

/* ------------------------------------------------------------------ *
 * 类型守卫
 * ------------------------------------------------------------------ */

export function isFund(item: AssetItem): item is FundItem {
  return item.kind === 'fund'
}

export function isGold(item: AssetItem): item is GoldItem {
  return item.kind === 'gold'
}

/* ------------------------------------------------------------------ *
 * 基金资产类型识别
 * ------------------------------------------------------------------ */

/** 基金归属的资产类型：股票型 / 债券型 / 货币 / 黄金商品 / 混合 / 未知 */
export type FundAssetClass = 'equity' | 'bond' | 'money' | 'commodity' | 'mixed' | 'unknown'

export const FUND_ASSET_CLASS_LABEL: Record<FundAssetClass, string> = {
  equity: '股票型',
  bond: '债券型',
  money: '货币型',
  commodity: '黄金 / 商品',
  mixed: '混合型',
  unknown: '未识别',
}

/**
 * 依据基金名称关键词判断资产类型。
 *
 * 为什么不调接口取类型：天天基金的行情接口稳定返回的只有净值相关字段，
 * 基金类型字段会随接口版本变化，纯前端依赖它容易在接口调整后失效。
 * 名称关键词是「永远拿得到」的信息，再配合用户手动标记兜底，稳定性更好。
 */
export function detectFundClass(name: string | undefined): FundAssetClass {
  const n = (name ?? '').trim()
  if (!n) return 'unknown'
  // 可转债基金本质偏债，但名字里同时有「债」和「股」，先单独识别
  if (/可转债|转债/.test(n)) return 'bond'
  if (/(货币|现金宝|活期宝|理财金)/.test(n)) return 'money'
  if (/(债券|纯债|短债|中短债|信用债|利率债|国债|城投债|固收|债基|债[ABCEHI]?\b)/.test(n)) return 'bond'
  if (/(黄金|贵金属|白银|有色|原油|商品|能源化工|豆粕)/.test(n)) return 'commodity'
  if (/(股票|指数|ETF|联接|LOF|增强|成长|价值|红利|消费|医药|科技|新能源|半导体|军工|券商|银行|地产|白酒|沪深|中证|标普|纳斯达克|恒生|MSCI)/i.test(n)) {
    return 'equity'
  }
  if (/(混合|灵活配置|平衡|稳健|绝对收益|养老目标)/.test(n)) return 'mixed'
  return 'unknown'
}

/** 取基金的有效资产类型：用户标记优先，其次按名称识别 */
export function effectiveFundClass(item: FundItem): FundAssetClass {
  return item.assetClass ?? detectFundClass(item.name)
}

/**
 * 把识别出来的基金类型映射到给定策略里的候选类别 id。
 * 返回全部候选（按优先级排序），由调用方结合策略目标比例挑最合适的那个 ——
 * 例如债券型基金在全天候里既有「长期国债」也有「中期国债」，应当归到中期国债。
 */
export function fundClassToStrategyClasses(
  fundClass: FundAssetClass,
  strategyClassIds: string[],
): string[] {
  const has = (id: string) => strategyClassIds.includes(id)
  const pick = (...ids: string[]) => ids.filter(has)
  switch (fundClass) {
    case 'bond':
    case 'money':
      return pick('bond', 'bond-long', 'bond-mid', 'cash')
    case 'commodity':
      return pick('commodity', 'gold')
    case 'equity':
    case 'mixed':
      return pick('stock')
    default:
      return []
  }
}

/* ------------------------------------------------------------------ *
 * 数值工具
 * ------------------------------------------------------------------ */

/** 安全数字：NaN / Infinity / null / undefined 一律归零 */
export function safeNum(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) ? v : 0
}

/**
 * 解析用户输入的金额文本。
 * 支持：千分位逗号、全角数字/句号、¥ 符号、前后空格，以及「万 / w / k」中文数量级。
 * 返回 NaN 表示不可解析，由表单负责校验提示。
 */
export function parseAmount(input: string): number {
  if (typeof input !== 'string') return NaN
  let s = input
    .trim()
    .replace(/[，,]/g, '')
    .replace(/[¥￥\s]/g, '')
    // 全角数字与句号转半角
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/。/g, '.')
    .replace(/[＋]/g, '+')
    .replace(/[－ー—]/g, '-')

  let scale = 1
  if (/[万萬]$/.test(s)) {
    scale = 10_000
    s = s.slice(0, -1)
  } else if (/[kK]$/.test(s)) {
    scale = 1_000
    s = s.slice(0, -1)
  } else if (/[wW]$/.test(s)) {
    scale = 10_000
    s = s.slice(0, -1)
  }

  if (s === '' || s === '-' || s === '+') return NaN
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN
  return Number(s) * scale
}

/* ------------------------------------------------------------------ *
 * 估值
 * ------------------------------------------------------------------ */

/**
 * 基金当前计价净值：
 * 优先取盘中估算净值（GSZ），无则回退到最新公布净值（NAV）。
 */
export function fundCurrentNav(item: FundItem): number | undefined {
  // 手动净值优先：代码查不到时用户可自行维护，市值与盈亏照常计算
  if (typeof item.manualNav === 'number' && item.manualNav > 0) return item.manualNav
  const q = item.quote
  if (!q) return undefined
  if (typeof q.estimatedNav === 'number' && q.estimatedNav > 0) return q.estimatedNav
  if (typeof q.publishedNav === 'number' && q.publishedNav > 0) return q.publishedNav
  return undefined
}

/** 该持仓是否正在使用手动净值（界面据此给出手动维护的提示） */
export function isManualPriced(item: FundItem): boolean {
  return typeof item.manualNav === 'number' && item.manualNav > 0
}

/**
 * 单个条目的市值 / 成本 / 盈亏。
 *
 * 多币种口径：条目金额以原币存储，这里按传入的汇率折算成人民币。
 * 汇率缺失时**不静默当成 0**，而是把原币数值当作人民币返回并标记 missingRate，
 * 由界面提示「汇率不可用」，避免用户把错数字当成真资产。
 */
export function valuate(item: AssetItem, rates?: FxRates | null): ItemValuation {
  /** 把原币金额换成本币（人民币），并给出折算元信息 */
  const convert = (amountInCurrency: number, code: CurrencyCode): Pick<ItemValuation, 'value' | 'valueInCurrency' | 'currency' | 'missingRate'> => {
    const converted = toCny(amountInCurrency, code, rates)
    if (converted === undefined) {
      return {
        value: amountInCurrency,
        valueInCurrency: amountInCurrency,
        currency: code,
        missingRate: code !== 'CNY',
      }
    }
    return { value: converted, valueInCurrency: amountInCurrency, currency: code, missingRate: false }
  }

  if (isFund(item)) {
    /**
     * 基金/持仓的计价币种由市场决定：
     * 境内基金是人民币净值；美股按 USD、港股按 HKD，再按汇率折算成人民币。
     */
    const market: HoldingMarket = item.market ?? 'cn'
    const code: CurrencyCode = HOLDING_MARKET_CURRENCY[market] ?? 'CNY'
    const nav = fundCurrentNav(item)
    const shares = safeNum(item.shares)
    const costNav = safeNum(item.costNav)

    // 成本也要按同一汇率折算，否则盈亏会被汇率放大或缩小
    const convertCost = (costInCurrency: number) => {
      const c = toCny(costInCurrency, code, rates)
      return c === undefined ? costInCurrency : c
    }

    if (nav === undefined) {
      // 尚未同步到行情时，用成本单价兜底，保证净资产不为 0 且不虚报盈亏
      const fallbackInCurrency = shares * costNav
      return {
        ...convert(fallbackInCurrency, code),
        cost: convertCost(fallbackInCurrency),
        profit: 0,
        profitRate: 0,
      }
    }

    const valueInCurrency = shares * nav
    const costInCurrency = shares * costNav
    const valueCny = toCny(valueInCurrency, code, rates)
    const costCny = convertCost(costInCurrency)
    const profit = (valueCny === undefined ? valueInCurrency : valueCny) - costCny
    return {
      ...convert(valueInCurrency, code),
      cost: costCny,
      profit,
      profitRate: costCny > 0 ? profit / costCny : 0,
    }
  }

  if (isGold(item)) {
    const code = item.currency ?? 'CNY'
    const grams = safeNum(item.grams)
    const price = safeNum(item.pricePerGram)
    const valueInCurrency = grams * price
    const converted = toCny(valueInCurrency, code, rates)
    // 黄金只登记当前单价，没有独立成本价时以现价为成本（盈亏 0）。
    // 成本同样折算，保证盈亏在两个币种口径下都自洽。
    const costCny = converted === undefined ? valueInCurrency : converted
    return {
      ...convert(valueInCurrency, code),
      cost: costCny,
      profit: 0,
      profitRate: 0,
    }
  }

  const code = item.currency ?? 'CNY'
  return {
    ...convert(safeNum(item.amount), code),
    cost: undefined,
    profit: undefined,
    profitRate: undefined,
  }
}

/** 分类小计（人民币口径；负债类金额本身以负数存储，直接累加） */
export function categoryTotal(category: Category, rates?: FxRates | null): number {
  return category.items.reduce((sum, item) => sum + valuate(item, rates).value, 0)
}

/**
 * 推断某个分类新增条目时应使用哪种表单形态。
 *
 * 优先级：分类显式声明 > 分类内已有条目的形态 > 按分类名猜（基金/黄金）> 金额。
 * 为什么不能只看「分类内是否已有基金」：空分类没有任何条目，
 * 会导致第一次添加基金时错给成金额表单，用户根本填不了基金代码。
 */
export function defaultItemKind(category: Category): ItemKind {
  if (category.defaultKind) return category.defaultKind
  const kinds = new Set(category.items.map((i) => i.kind))
  if (kinds.size === 1 && kinds.has('fund')) return 'fund'
  if (kinds.size === 1 && kinds.has('gold')) return 'gold'
  // 兜底：按分类名猜，覆盖用户自建的「基金」「黄金」分类
  if (/基金/.test(category.name)) return 'fund'
  if (/黄金|贵金属/.test(category.name)) return 'gold'
  return 'amount'
}

/** 分类项数标签文案，如「3项」「1只」「1笔」 */
export function categoryCountLabel(category: Category): string {
  const n = category.items.length
  if (n === 0) return '暂无'
  if (category.isLiability) return `${n}笔`
  const kinds = new Set(category.items.map((i) => i.kind))
  if (kinds.size === 1) {
    const only = [...kinds][0]
    if (only === 'fund') return `${n}只`
    if (only === 'gold') return `${n}笔`
  }
  return `${n}项`
}

/**
 * 全量汇总：
 * - 「负债」分类内的条目按绝对值计入 totalLiabilities；
 * - 其余分类按正负号计入 totalAssets（金额为正视为资产，为负则抵减资产）；
 * - 净资产 = 总资产 − 总负债。
 */
export function summarize(portfolio: Portfolio, rates?: FxRates | null): Summary {
  let assets = 0
  let liabilities = 0

  for (const category of portfolio.categories) {
    const subtotal = categoryTotal(category, rates)
    if (category.isLiability) {
      liabilities += Math.abs(subtotal)
    } else {
      assets += subtotal
    }
  }

  return {
    netWorth: assets - liabilities,
    totalAssets: assets,
    totalLiabilities: liabilities,
  }
}

/**
 * 外币敞口统计：供界面提示「其中含外币资产」以及「有 N 条因缺少汇率未能折算」。
 */
export interface FxExposure {
  /** 有外币计价的条目数 */
  foreignItemCount: number
  /** 因缺少汇率而未能折算成人民币的条目数 */
  missingRateCount: number
  /** 按币种汇总的原币金额（便于展示「约合」） */
  byCurrency: Array<{ currency: CurrencyCode; valueInCurrency: number }>
}

export function fxExposure(portfolio: Portfolio, rates?: FxRates | null): FxExposure {
  const byCurrency = new Map<CurrencyCode, number>()
  let foreignItemCount = 0
  let missingRateCount = 0

  for (const category of portfolio.categories) {
    for (const item of category.items) {
      const v = valuate(item, rates)
      // 美股/港股持仓同样属于外币敞口
      if (v.currency === 'CNY') continue
      foreignItemCount += 1
      if (v.missingRate) missingRateCount += 1
      byCurrency.set(v.currency, (byCurrency.get(v.currency) ?? 0) + v.valueInCurrency)
    }
  }

  return {
    foreignItemCount,
    missingRateCount,
    byCurrency: [...byCurrency.entries()].map(([currency, valueInCurrency]) => ({ currency, valueInCurrency })),
  }
}

/**
 * 收集组合里用到的外币（用于决定是否需要拉汇率）。
 *
 * 注意：不能只看金额类条目 —— 美股/港股持仓的计价币种来自 market 字段
 * （美股 USD、港股 HKD），漏掉它们会导致汇率不拉取、持仓折算不出来。
 */
export function collectCurrencies(portfolio: Portfolio): CurrencyCode[] {
  const set = new Set<CurrencyCode>()
  for (const category of portfolio.categories) {
    for (const item of category.items) {
      if (isFund(item)) {
        const market = item.market ?? 'cn'
        if (market !== 'cn') set.add(HOLDING_MARKET_CURRENCY[market])
        continue
      }
      const code = (item as { currency?: CurrencyCode }).currency
      if (code && code !== 'CNY') set.add(code)
    }
  }
  return [...set]
}

/** 分类内是否含有需要联网刷新行情的条目 */
export function categoryNeedsSync(category: Category): boolean {
  return category.items.some((i) => isFund(i))
}

/**
 * 收集所有需要拉行情的代码（去重）。
 *
 * 包含三类：
 * - 境内基金：6 位数字（天天基金接口）
 * - 美股 / 美股 ETF：字母代码，如 SPY、QQQ（腾讯行情）
 * - 港股：1~5 位数字，如 00700（腾讯行情）
 *
 * 注意：早期只收 6 位数字，导致美股/港股持仓拿不到行情。
 */
export function collectFundCodes(portfolio: Portfolio): string[] {
  const codes = new Set<string>()
  for (const category of portfolio.categories) {
    for (const item of category.items) {
      if (!isFund(item)) continue
      const code = (item.code ?? '').trim()
      if (!code) continue
      const market = item.market ?? 'cn'
      // 6 位数字属于境内基金；其余交给市场识别（字母=美股，1~5 位数字=港股）
      const isDomestic = /^\d{6}$/.test(code)
      const isStock = market === 'us' ? /^[A-Za-z][A-Za-z.\-]{0,5}$/.test(code) : /^\d{1,5}$/.test(code)
      if (isDomestic || isStock) codes.add(code)
    }
  }
  return [...codes]
}

/** 查询某只基金在所有分类中的持仓分布 */
export function findFundHoldings(
  portfolio: Portfolio,
  code: string,
): Array<{ category: Category; item: FundItem }> {
  const out: Array<{ category: Category; item: FundItem }> = []
  for (const category of portfolio.categories) {
    for (const item of category.items) {
      if (isFund(item) && item.code === code) out.push({ category, item })
    }
  }
  return out
}

/** 判断行情是否需要刷新（默认 30 分钟视为过期） */
export const QUOTE_STALE_MS = 30 * 60 * 1000

export function isQuoteStale(quote: FundQuote | undefined, now = Date.now()): boolean {
  if (!quote?.fetchedAt) return true
  return now - quote.fetchedAt > QUOTE_STALE_MS
}
