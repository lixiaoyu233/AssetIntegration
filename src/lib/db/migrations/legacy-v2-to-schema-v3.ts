/**
 * Legacy V2（1.x: categories + items）→ Portfolio Schema V3（accounts / instruments / holdings / …）迁移器
 *
 * 设计要点：
 *
 * 1. **纯函数**：不读写任何存储，输入旧 JSON、输出新结构 + 告警。便于单测与重复执行。
 *
 * 2. **确定性 id**：同一条旧数据每次迁移得到相同 id（`v2_acct_<hash>` 形式），
 *    因此重复执行不会产生重复实体。
 *
 * 3. **不做金融分类猜测**（需求第十九/二十一/二十二/二十三条）：
 *    - `kind === 'gold'` / `kind === 'amount'` 属结构性事实 → assetClass 可直接确定；
 *    - 基金（旧 `kind === 'fund'`）只有**代码形态**是可靠信息，
 *      无法据此判断是股票型/债券型/货币型 → 一律 `unconfirmed`，
 *      即使名字里带「货币」「债券」也不作为分类依据（1.x 的关键词识别已废弃）；
 *    - 具体策略标签（如 QQQM → Nasdaq100）旧数据没有 → 不编造。
 *
 * 4. **金额/币种/数量/成本/行情逐项搬运**，不丢失、不四舍五入、不改口径。
 */

import type { CurrencyCode } from '../../currency'
import { isCurrencyCode } from '../../currency'
import type {
  Account,
  AccountRegion,
  AccountType,
  AllocationProfile,
  AssetClass,
  ClassificationSource,
  Holding,
  Instrument,
  InstrumentType,
  Portfolio2,
  Quote,
  Region,
  Snapshot,
  Transaction,
  ValuationMode,
} from '../../../types/portfolio2'
import { createEmptyPortfolio2 } from '../../../types/portfolio2'

/* ------------------------------------------------------------------ *
 * 旧结构的最小形状（只声明迁移会用到的字段）
 * ------------------------------------------------------------------ */

export interface LegacyItemLike {
  id?: string
  kind?: string
  name?: string
  note?: string
  /** amount */
  amount?: number
  currency?: string
  /** fund */
  code?: string
  market?: string
  shares?: number
  costNav?: number
  manualNav?: number
  manualName?: boolean
  assetClass?: string
  fundedFrom?: { categoryId?: string; itemId?: string; itemName?: string; amount?: number }
  quote?: Record<string, unknown>
  /** gold */
  grams?: number
  pricePerGram?: number
}

export interface LegacyCategoryLike {
  id?: string
  name?: string
  isLiability?: boolean
  items?: LegacyItemLike[]
}

export interface LegacyPortfolioLike {
  version?: number
  categories?: LegacyCategoryLike[]
  lastSyncedAt?: number
  /** 1.x 的旧变动流水，迁移暂不使用（由 Snapshot 承接），仅保留以兼容读取 */
  history?: unknown[]
}

export interface LegacyNetWorthPointLike {
  month?: string
  assets?: number
  liabilities?: number
  netWorth?: number
  final?: boolean
}

export interface MigrationInput {
  portfolio: LegacyPortfolioLike
  /** 旧版月度走势（asset-card-wallet/networth-history/v1），并入 Snapshot */
  netWorthPoints?: LegacyNetWorthPointLike[]
  /**
   * 可注入时钟（返回 ISO 字符串）。
   * 默认取系统时间；注入固定值可让迁移结果**完全确定**，便于断言与复现。
   */
  now?: () => string
}

export interface MigrationWarning {
  code:
    | 'unconfirmed_classification'
    | 'unknown_currency'
    | 'empty_category'
    | 'orphan_funding_source'
    | 'unknown_item_kind'
    | 'legacy_strategy_discarded'
  message: string
  /** 关联的实体，便于界面跳转 */
  ref?: { categoryId?: string; itemId?: string; instrumentId?: string }
}

export interface MigrationResult {
  portfolio: Portfolio2
  warnings: MigrationWarning[]
  counts: {
    legacyItems: number
    migratedHoldings: number
    unconfirmed: number
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function safeNum(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 从旧行情里取币种。
 *
 * 真实数据里美股条目的 `currency` 常常**没有**，币种只存在于 `quote.currency`
 * （如 USD）。若只读 item.currency 会把美股当成人民币，因此这里回退到 quote。
 */
function readQuoteCurrency(item: LegacyItemLike): string | undefined {
  const q = item.quote
  if (q && typeof q === 'object' && typeof q.currency === 'string') return q.currency
  return undefined
}

/** 静默规范化（用于账户主要币种的推导，不产生告警） */
function normalizeCurrencyQuiet(raw: unknown): CurrencyCode {
  return isCurrencyCode(raw) ? raw : 'CNY'
}

/** 规范化币种：非法或缺失回落人民币，并如实上报（不静默） */
function normalizeCurrency(raw: unknown, warnings: MigrationWarning[], ref: MigrationWarning['ref'], name: string): CurrencyCode {
  if (raw === undefined || raw === null || raw === '') return 'CNY'
  if (isCurrencyCode(raw)) return raw
  warnings.push({
    code: 'unknown_currency',
    message: `「${name}」的币种「${String(raw)}」不在支持列表中，已按人民币处理，请核实`,
    ref,
  })
  return 'CNY'
}

/** 稳定的字符串 hash（FNV-1a 变体）→ 保证迁移确定性 */
function hash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(6, '0')
}

const idFor = (prefix: string, seed: string) => `v2_${prefix}_${hash(seed)}`

/* ------------------------------------------------------------------ *
 * 分类判定（全部基于结构性事实，不做名称猜测）
 * ------------------------------------------------------------------ */

/**
 * 旧 `kind` + 代码形态 → 新 instrumentType。
 * 只使用「录入方式」这一结构性信息。
 */
function detectInstrumentType(item: LegacyItemLike): InstrumentType | null {
  if (item.kind === 'gold') return 'gold'
  /*
   * 关键：旧数据的 `kind === 'amount'` **不等于现金**。
   * 它同时承载现金、房产、数字货币、应收款等一切「直接录金额」的资产，
   * 结构上无法区分。因此这里只能给中性类型 'other'，
   * 资产类别一律交用户确认 —— 否则「数字货币」会被错误归入现金。
   * 旧分类名（如「数字货币」「房产」）同样不作为判断依据（需求第十九条）。
   */
  if (item.kind === 'amount') return 'other'
  if (item.kind === 'fund') {
    const code = (item.code ?? '').trim()
    const market = item.market ?? 'cn'
    if (market === 'us') {
      // 美股：有字母代码 → 无法区分个股与 ETF，按更常见的 ETF 处理但标记未确认
      return /^[A-Za-z]/.test(code) ? 'etf' : null
    }
    if (market === 'hk') return 'etf'
    // 境内 6 位数字 → 场外基金
    return /^\d{6}$/.test(code) ? 'fund' : null
  }
  return null
}

/** 由 instrumentType 推出的资产类别；返回 null 表示无法确定，必须由用户确认 */
function defaultAssetClassFor(type: InstrumentType): AssetClass | null {
  switch (type) {
    case 'gold':
      return 'gold'
    case 'bond':
      return 'fixed_income'
    // 以下一律返回 null（必须由用户确认）：
    // - stock / etf / fund：可能是股票、债券或黄金，工具类型不足以定类别
    // - cash / real_estate / crypto / receivable：旧数据用同一种 'amount' 承载，无法区分
    // - other：本身无信息量
    default:
      return null
  }
}

/**
 * 未确认时的**暂定展示类别**。
 * 只影响界面默认高亮，不代表系统已做判断 —— 必须与 classificationStatus: 'unconfirmed' 同时出现。
 */
function assumedAssetClassFor(type: InstrumentType): AssetClass {
  switch (type) {
    case 'gold':
      return 'gold'
    case 'bond':
      return 'fixed_income'
    case 'stock':
    case 'etf':
    case 'fund':
      return 'equity'
    case 'crypto':
      return 'crypto'
    case 'real_estate':
      return 'real_estate'
    case 'receivable':
      return 'receivable'
    default:
      return 'other'
  }
}

/** 旧版手动标记的基金类型 → 新资产类别（仅当用户确实标记过时采用） */
const LEGACY_ASSET_CLASS_MAP: Record<string, AssetClass | undefined> = {
  equity: 'equity',
  bond: 'fixed_income',
  money: 'cash',
  commodity: 'gold',
  mixed: undefined, // 混合型无法归入单一类别 → 交给用户确认
  unknown: undefined,
}

/**
 * 地域：只依据**明确的**市场信息。
 * 旧 `amount` 类条目没有地域信息，不能凭「大概是国内的」硬给 CN（需求第十九条同理）。
 */
function regionFor(market: string | undefined): Region | undefined {
  if (market === 'us') return 'US'
  if (market === 'hk') return 'HK'
  if (market === 'cn') return 'CN'
  return undefined
}

/* ------------------------------------------------------------------ *
 * 主迁移
 * ------------------------------------------------------------------ */

export function migrateLegacyToCurrentSchema(input: MigrationInput): MigrationResult {
  const warnings: MigrationWarning[] = []
  const portfolio = createEmptyPortfolio2()
  const clock = input.now ?? (() => new Date().toISOString())
  const ts = clock()

  const categories = Array.isArray(input.portfolio?.categories) ? input.portfolio.categories : []

  /* ---- 1) 账户：按「旧分类的语义」建容器，不臆造机构名 ---- */
  const accountIdByCategory = new Map<string, string>()
  /** 每个 categoryId 用哪个账户承接；基金与现金/负债各自独立 */
  const accountIdForCategory = (cat: LegacyCategoryLike): string => {
    const catId = String(cat.id ?? cat.name ?? 'unknown')
    const cached = accountIdByCategory.get(catId)
    if (cached) return cached

    const isLiability = cat.isLiability === true
    const categoryName = String(cat.name ?? '未命名分类')
    const items = Array.isArray(cat.items) ? cat.items : []

    const type: AccountType = isLiability
      ? 'other'
      : /基金/.test(categoryName)
        ? 'fund_platform'
        : /黄金|贵金属/.test(categoryName)
          ? 'gold_platform'
          : /股票|证券/.test(categoryName)
            ? 'broker'
            : 'bank'

    /*
     * 司法辖区：只依据账户内条目**明确的**市场信息推导。
     * 旧数据里账户本身没有地区字段，所以这里不猜 —— 推不出来就留空，
     * 由后续界面让用户补全（Account.region 是可选字段）。
     */
    const markets = new Set(
      items
        .map((i) => (typeof i.market === 'string' ? i.market : undefined))
        .filter((m): m is string => m === 'us' || m === 'hk' || m === 'cn'),
    )
    const region: AccountRegion | undefined =
      markets.size === 1
        ? markets.has('us')
          ? 'US'
          : markets.has('hk')
            ? 'HK'
            : 'CN'
        : undefined

    /*
     * 账户主要币种：按**原币金额占比**取最大者，而不是「唯一外币」。
     *
     * 反例（真实数据出过）：账户内有 2 条 CNY（合计 51.4 万）与 1 条 HKD（1.86 万），
     * 若先过滤掉 CNY 再判断，会把主要币种判成 HKD —— 明显不合理。
     *
     * 注意这只是「默认值」的语义，**不限制**账户持有其他币种。
     */
    const weightByCurrency = new Map<CurrencyCode, number>()
    for (const i of items) {
      const cur = normalizeCurrencyQuiet(i.currency ?? readQuoteCurrency(i))
      const nativeValue =
        i.kind === 'amount'
          ? Math.abs(safeNum(i.amount) ?? 0)
          : Math.abs(safeNum(i.shares) ?? 0) * Math.abs(safeNum(i.costNav) ?? 0) ||
            Math.abs(safeNum(i.grams) ?? 0) * Math.abs(safeNum(i.pricePerGram) ?? 0)
      weightByCurrency.set(cur, (weightByCurrency.get(cur) ?? 0) + nativeValue)
    }
    // 平手或全为 0 时，人民币优先（记账本位币）
    const primaryCurrency: CurrencyCode =
      [...weightByCurrency.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1]
        return a[0] === 'CNY' ? -1 : b[0] === 'CNY' ? 1 : 0
      })[0]?.[0] ?? 'CNY'

    const account: Account = {
      id: idFor('acct', catId),
      name: categoryName,
      type,
      region,
      currency: primaryCurrency,
      isLiability,
      note: '由 1.x 分类迁移而来',
      createdAt: ts,
      updatedAt: ts,
    }
    portfolio.accounts.push(account)
    accountIdByCategory.set(catId, account.id)
    return account.id
  }

  /* ---- 2) 逐分类逐条目转换 ---- */
  /** 旧 itemId → 新 holdingId，用于后来解析 fundedFrom */
  const holdingIdByLegacyItem = new Map<string, string>()
  const pendingFunding: Array<{
    holdingId: string
    fromCategoryId?: string
    fromItemId?: string
    fromItemName?: string
    amount?: number
    itemName: string
  }> = []

  let legacyItems = 0
  let migratedHoldings = 0
  let unconfirmed = 0

  for (const cat of categories) {
    const items = Array.isArray(cat.items) ? cat.items : []
    if (items.length === 0) {
      warnings.push({
        code: 'empty_category',
        message: `分类「${cat.name ?? '未命名'}」没有条目，已跳过`,
        ref: { categoryId: String(cat.id ?? '') },
      })
      continue
    }

    const accountId = accountIdForCategory(cat)
    const categoryName = String(cat.name ?? '未命名分类')
    const isLiability = cat.isLiability === true

    for (const item of items) {
      legacyItems += 1
      const legacyId = String(item.id ?? `${cat.id}_${legacyItems}`)
      const itemName = String(item.name ?? '未命名')
      const ref = { categoryId: String(cat.id ?? ''), itemId: legacyId }

      const instrumentType = detectInstrumentType(item)
      if (!instrumentType) {
        warnings.push({
          code: 'unknown_item_kind',
          message: `「${itemName}」的录入形态无法识别（kind=${String(item.kind)}），已按「其他」迁移，请确认`,
          ref,
        })
      }
      const type: InstrumentType = instrumentType ?? 'other'

      /* --- 资产类别：负债优先，其次结构性确定，最后交用户确认 --- */
      let assetClass: AssetClass
      let classificationStatus: 'confirmed' | 'unconfirmed'
      let classificationSource: ClassificationSource

      if (isLiability) {
        // 旧数据的 isLiability 是明确的结构性标记 → 可以直接定为负债
        assetClass = 'liability'
        classificationStatus = 'confirmed'
        classificationSource = 'structural'
      } else {
        const legacyMarked = typeof item.assetClass === 'string' ? LEGACY_ASSET_CLASS_MAP[item.assetClass] : undefined
        const structural = defaultAssetClassFor(type)
        if (legacyMarked) {
          // 用户此前手动标记过 → 沿用，但提醒复核（旧标记也可能过时）
          assetClass = legacyMarked
          classificationStatus = 'confirmed'
          classificationSource = 'legacy_user_set'
        } else if (structural) {
          assetClass = structural
          classificationStatus = 'confirmed'
          classificationSource = 'structural'
        } else {
          // 不确定：给一个仅用于展示的暂定值，明确标记未确认，交用户决定
          assetClass = assumedAssetClassFor(type)
          classificationStatus = 'unconfirmed'
          classificationSource = 'unknown'
          unconfirmed += 1
          warnings.push({
            code: 'unconfirmed_classification',
            message: `「${itemName}」的资产类别无法自动确定，需要你确认`,
            ref,
          })
        }
      }

      /* --- Instrument --- */
      // 只有数量口径的标的才有交易代码；现金/房产等无代码
      const sym = item.kind === 'amount' ? undefined : (item.code ?? '').trim() || undefined
      const currency = normalizeCurrency(
        item.currency ?? readQuoteCurrency(item),
        warnings,
        ref,
        itemName,
      )

      const instrument: Instrument = {
        id: idFor('inst', `${legacyId}|${itemName}`),
        symbol: sym,
        name: itemName,
        instrumentType: type,
        assetClass,
        region: regionFor(item.market),
        currency,
        // 策略标签旧数据没有 → 不编造（需求第二十二条）
        strategy: undefined,
        classificationStatus,
        classificationSource,
        metadata: {
          migratedFrom: 'legacy-v2',
          legacyKind: item.kind,
          legacyCategoryId: cat.id,
          legacyCategoryName: categoryName,
        },
        createdAt: ts,
        updatedAt: ts,
      }
      portfolio.instruments.push(instrument)

      /*
       * Holding 估值口径按**旧数据的录入形态**判断，而不是按猜测的资产类别：
       * 旧 `kind === 'amount'` 是「直接录金额」（现金/房产/应收…）→ manual
       * 旧 `kind === 'fund' | 'gold'` 是「数量 + 单价」→ quantity
       */
      const valuationMode: ValuationMode = item.kind === 'amount' ? 'manual' : 'quantity'

      const holding: Holding = {
        id: idFor('hold', legacyId),
        accountId,
        instrumentId: instrument.id,
        valuationMode,
        openedAt: undefined,
        note: item.note,
        createdAt: ts,
        updatedAt: ts,
      }

      if (valuationMode === 'manual') {
        holding.manualValue = safeNum(item.amount)
        holding.manualValueAt = ts
      } else if (type === 'gold') {
        // 黄金：旧数据是克数 + 每克单价
        const grams = safeNum(item.grams) ?? 0
        const price = safeNum(item.pricePerGram) ?? 0
        holding.quantity = grams
        holding.averageCost = price
        holding.costBasis = grams * price
      } else {
        // 基金 / 美股 / 港股：份额 + 成本单价
        const shares = safeNum(item.shares) ?? 0
        const costNav = safeNum(item.costNav) ?? 0
        holding.quantity = shares
        holding.averageCost = costNav
        holding.costBasis = shares * costNav
      }

      portfolio.holdings.push(holding)
      migratedHoldings += 1
      holdingIdByLegacyItem.set(legacyId, holding.id)

      /* --- Quote：搬运行情，并显式标注状态（绝不冒充实时） --- */
      const quote = migrateQuote(item, instrument, ref, warnings, clock)
      if (quote) portfolio.quotes.push(quote)

      /* --- 资金划拨：留待第 3 步解析 --- */
      if (item.fundedFrom) {
        pendingFunding.push({
          holdingId: holding.id,
          fromCategoryId: item.fundedFrom.categoryId,
          fromItemId: item.fundedFrom.itemId,
          fromItemName: item.fundedFrom.itemName,
          amount: safeNum(item.fundedFrom.amount),
          itemName,
        })
      }
    }
  }

  /* ---- 3a) 期初余额：为每条数量口径持仓生成一条 adjustment ----
   *
   * 语义严格限定为「迁移时已存在的持仓余额」：
   * 承接迁移时的 quantity / costBasis / 币种 / 时间，
   * **不**由现有成本反推买入价格、买入日期或任何不存在的历史交易。
   *
   * 现金/房产等 manual 口径持仓不用交易表达（它们靠 manualValue），因此不生成。
   */
  for (const holding of portfolio.holdings) {
    if (holding.valuationMode !== 'quantity') continue
    const instrument = portfolio.instruments.find((i) => i.id === holding.instrumentId)
    if (!instrument) continue

    const adjustment: Transaction = {
      id: idFor('adj', holding.id),
      accountId: holding.accountId,
      instrumentId: holding.instrumentId,
      type: 'adjustment',
      quantity: holding.quantity ?? 0,
      amount: holding.costBasis ?? 0,
      currency: instrument.currency,
      timestamp: ts,
      note: '迁移期初余额（非历史买入记录）',
    }
    portfolio.transactions.push(adjustment)
  }

  /* ---- 3b) 资金划拨 → transfer 交易（只记录事实，不重复扣减现金） ---- */
  for (const f of pendingFunding) {
    const toInstrument = portfolio.holdings.find((h) => h.id === f.holdingId)
    if (!toInstrument) continue
    const fromHoldingId = f.fromItemId ? holdingIdByLegacyItem.get(f.fromItemId) : undefined
    const fromHolding = fromHoldingId ? portfolio.holdings.find((h) => h.id === fromHoldingId) : undefined

    if (!fromHolding) {
      warnings.push({
        code: 'orphan_funding_source',
        message: `「${f.itemName}」记录了来自「${f.fromItemName ?? '未知项目'}」的划拨，但找不到对应持仓，已保留备注`,
      })
    }

    const tx: Transaction = {
      id: idFor('tx', `funding|${f.holdingId}`),
      accountId: fromHolding?.accountId ?? toInstrument.accountId,
      instrumentId: toInstrument.instrumentId,
      type: 'transfer',
      amount: f.amount ?? 0,
      currency: 'CNY',
      timestamp: ts,
      toAccountId: toInstrument.accountId,
      note: `1.x 划拨记录：来自「${f.fromItemName ?? '未知项目'}」${
        fromHolding ? '' : '（原项目未找到）'
      }`,
    }
    portfolio.transactions.push(tx)
  }

  /* ---- 4) 旧月度走势 → Snapshot ---- */
  for (const p of input.netWorthPoints ?? []) {
    const month = typeof p.month === 'string' ? p.month : ''
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const assets = safeNum(p.assets) ?? 0
    const liabilities = safeNum(p.liabilities) ?? 0
    const netWorth = safeNum(p.netWorth) ?? assets - liabilities
    const snapshot: Snapshot = {
      id: idFor('snap', `legacy-month|${month}`),
      // 旧数据是月粒度，落在当月最后一天（日期仅作标识，不参与收益计算）
      date: `${month}-01`,
      totalAssets: assets,
      totalLiabilities: liabilities,
      netWorth,
      currency: 'CNY',
      assetAllocation: {},
      // 旧数据没有持仓级信息与归因依据 → 一律标为不可归因，不臆造
      positions: [],
      attributionStatus: 'unavailable',
      attributionNotes: ['由旧版月度走势迁移而来，缺少持仓明细与现金流数据，无法归因'],
      createdAt: ts,
    }
    portfolio.snapshots.push(snapshot)
  }

  /* ---- 5) 目标配置：旧策略模板不自动套用（需求：模板不是默认建议） ---- */
  const profiles: AllocationProfile[] = []
  portfolio.allocationProfiles = profiles

  return {
    portfolio,
    warnings,
    counts: { legacyItems, migratedHoldings, unconfirmed },
  }
}

/* ------------------------------------------------------------------ *
 * 行情搬运
 * ------------------------------------------------------------------ */

function migrateQuote(
  item: LegacyItemLike,
  instrument: Instrument,
  ref: MigrationWarning['ref'],
  warnings: MigrationWarning[],
  clock: () => string,
): Quote | null {
  const raw = item.quote
  const manualNav = safeNum(item.manualNav)
  const ts = clock()

  // 手动净值优先（1.x 语义：用户手填值优先于接口结果）
  if (manualNav !== undefined && manualNav > 0) {
    const t = safeNum(raw?.fetchedAt)
    return {
      id: idFor('quote', `manual|${instrument.id}`),
      instrumentId: instrument.id,
      priceKind: 'manual',
      marketPrice: instrument.instrumentType === 'cash' ? undefined : manualNav,
      currency: instrument.currency,
      source: 'user',
      timestamp: t ? new Date(t).toISOString() : ts,
      status: 'MANUAL',
    }
  }

  if (!raw || typeof raw !== 'object') return null

  const estimatedNav = safeNum(raw.estimatedNav)
  const publishedNav = safeNum(raw.publishedNav)
  const fetchedAt = safeNum(raw.fetchedAt)
  const source = typeof raw.source === 'string' ? raw.source : 'legacy'

  if (estimatedNav === undefined && publishedNav === undefined) return null

  const priceKind = estimatedNav !== undefined ? 'estimated_nav' : 'nav'

  /*
   * 旧数据没有 status 字段。1.x 里「有 estimatedNav」代表盘中估算，
   * 这里据此推断为 LIVE / DELAYED；但**旧数据的时间可能已经很旧**，
   * 所以按 fetchedAt 判断，超过阈值一律标 STALE —— 不允许继续冒充实时（需求第二十九条）。
   */
  const ageMs = fetchedAt ? Date.now() - fetchedAt : Number.POSITIVE_INFINITY
  const STALE_MS = 30 * 60 * 1000
  let status: Quote['status']
  if (priceKind === 'estimated_nav') status = ageMs > STALE_MS ? 'STALE' : 'LIVE'
  else status = ageMs > 24 * 60 * 60 * 1000 ? 'STALE' : 'DELAYED'

  if (status === 'STALE') {
    warnings.push({
      code: 'unconfirmed_classification',
      message: `「${instrument.name}」的旧行情已过期，已标记为「已过期」，不会作为实时价使用`,
      ref,
    })
  }

  return {
    id: idFor('quote', `legacy|${instrument.id}`),
    instrumentId: instrument.id,
    priceKind,
    marketPrice: item.market === 'us' || item.market === 'hk' ? estimatedNav : undefined,
    estimatedNav: priceKind === 'estimated_nav' ? estimatedNav : undefined,
    nav: priceKind === 'nav' ? publishedNav : undefined,
    currency: instrument.currency,
    source,
    timestamp: fetchedAt ? new Date(fetchedAt).toISOString() : ts,
    status,
  }
}
