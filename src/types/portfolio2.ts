/**
 * WealthCard 2.0 数据模型
 *
 * 设计原则（与 1.x 的关键差异）：
 *
 * 1. **三层分离**：Account（账户容器）→ Holding（持有）→ Instrument（标的）。
 *    账户余额不再直接挂在 Account 上，避免「Account.balance」与「Holding.manualValue」
 *    两个数据源并存导致不一致。
 *
 * 2. **资产类别与投资工具解耦**：`instrumentType`（stock/etf/fund/…）描述「这是什么工具」，
 *    `assetClass`（equity/fixed_income/…）描述「它算什么资产」。
 *    例如 QQQM：instrumentType = 'etf'，assetClass = 'equity'。
 *    因此「股票」「基金」不会再被当成资产类别。
 *
 * 3. **不做金融分类猜测**：无法可靠判断时保持 `classificationStatus = 'unconfirmed'`，
 *    由界面提示用户确认，而不是按名称关键词猜（1.x 的 `detectFundClass` 已废弃）。
 *
 * 4. **金额一律「原币存储 + 显式状态」**：估值结果区分 ok / unavailable / stale，
 *    缺少汇率时绝不退化为 1:1。
 */

import type { CurrencyCode } from '../lib/currency'

export type { CurrencyCode }

/* ------------------------------------------------------------------ *
 * 通用
 * ------------------------------------------------------------------ */

/** ISO 8601 时间戳字符串（如 2026-10-03T14:30:00.000Z） */
export type IsoDateTime = string

/** 日期字符串（如 2026-10-03） */
export type IsoDate = string

/* ------------------------------------------------------------------ *
 * Account 账户
 * ------------------------------------------------------------------ */

export type AccountType =
  | 'bank'
  | 'broker'
  | 'fund_platform'
  | 'gold_platform'
  | 'real_estate'
  | 'crypto'
  | 'other'

/**
 * 账户的司法辖区。
 *
 * 用于「美国账户资产 / 香港账户资产 / 全部 USD 资产」这类统计，
 * 与 Instrument 的 `region`（资产投向地域）**不是同一个概念**：
 * 例如「香港银行账户」（region = HK）里持有美股 ETF（instrument.region = US）。
 */
export type AccountRegion = 'CN' | 'HK' | 'SG' | 'US' | 'OTHER'

export const ACCOUNT_REGION_LABEL: Record<AccountRegion, string> = {
  CN: '中国内地',
  HK: '香港',
  SG: '新加坡',
  US: '美国',
  OTHER: '其他',
}

/**
 * 账户：独立的「金融账户 / 资产容器」。
 *
 * 关键约束（与资产类别彻底解耦）：
 * - 一个 Account **可以同时持有多种 Instrument、多种 AssetClass、多种币种**；
 * - `currency` 只是该账户的**默认 / 主要币种**，用于新建持仓时的默认值，
 *   **绝不是限制**——它不参与任何校验，也不影响账户内其他币种资产的估值；
 * - `type` 表达「这是什么机构」，不表达「装了什么资产」。
 *
 * 例如（机构名为示意）：
 *   美股券商账户 (type=broker, region=US, currency=USD)
 *     ├── USD 现金      (assetClass=cash)
 *     ├── 美股 ETF      (assetClass=equity)
 *     └── 个股          (assetClass=equity)
 *
 *   香港银行账户 (type=bank, region=HK, currency=HKD)
 *     ├── HKD 现金      (assetClass=cash)
 *     └── USD 现金      (assetClass=cash)   ← 与主要币种不同，允许
 */
export interface Account {
  id: string
  name: string
  institution?: string
  type: AccountType
  /** 司法辖区，用于按地区统计 */
  region?: AccountRegion
  /**
   * 默认 / 主要币种。仅作为新建持仓时的默认值，**不限制**账户可持有的币种。
   */
  currency: CurrencyCode
  /** 该账户整体属于负债（如信用卡、贷款账户） */
  isLiability: boolean
  note?: string
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  bank: '银行',
  broker: '券商',
  fund_platform: '基金平台',
  gold_platform: '黄金平台',
  real_estate: '房产',
  crypto: '加密资产',
  other: '其他',
}

/* ------------------------------------------------------------------ *
 * Instrument 投资标的
 * ------------------------------------------------------------------ */

/** 投资工具类型：描述「这是什么」，不是资产类别 */
export type InstrumentType =
  | 'stock'
  | 'etf'
  | 'fund'
  | 'bond'
  | 'gold'
  | 'real_estate'
  | 'crypto'
  | 'cash'
  | 'receivable'
  | 'other'

/**
 * 资产类别：描述「算什么资产」，是配置分析与再平衡的唯一依据。
 * 注意：`equity` 涵盖个股与股票型基金/ETF —— 工具类型不参与类别划分。
 */
export type AssetClass =
  | 'cash'
  | 'equity'
  | 'fixed_income'
  | 'gold'
  | 'real_estate'
  | 'crypto'
  | 'receivable'
  | 'other'
  | 'liability'

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  cash: '现金',
  equity: '股票',
  fixed_income: '固收',
  gold: '黄金',
  real_estate: '房产',
  crypto: '加密资产',
  receivable: '应收',
  other: '其他',
  liability: '负债',
}

export const INSTRUMENT_TYPE_LABEL: Record<InstrumentType, string> = {
  stock: '个股',
  etf: 'ETF',
  fund: '基金',
  bond: '债券',
  gold: '黄金',
  real_estate: '房产',
  crypto: '加密资产',
  cash: '现金',
  receivable: '应收',
  other: '其他',
}

export type Region = 'CN' | 'US' | 'HK' | 'JP' | 'EU' | 'GLOBAL' | 'OTHER'

export const REGION_LABEL: Record<Region, string> = {
  CN: '中国',
  US: '美国',
  HK: '香港',
  JP: '日本',
  EU: '欧洲',
  GLOBAL: '全球',
  OTHER: '其他',
}

/** 分类确认状态：只有用户确认过（或结构上无歧义）才允许是 confirmed */
export type ClassificationStatus = 'confirmed' | 'unconfirmed'

export interface Instrument {
  id: string
  /** 交易代码（场内标的、基金代码）；现金等无代码的标的留空 */
  symbol?: string
  name: string
  instrumentType: InstrumentType
  assetClass: AssetClass
  region?: Region
  currency: CurrencyCode
  /** 投资策略标签（如 Nasdaq100 / Dividend）；无法可靠判断时留空 */
  strategy?: string
  classificationStatus: ClassificationStatus
  /** 分类来源，便于排查与界面说明 */
  classificationSource?: ClassificationSource
  metadata?: Record<string, unknown>
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

/** 资产类别是从哪来的 —— 用于向用户解释「为什么算作这一类」 */
export type ClassificationSource =
  /** 用户明确确认 */
  | 'user_confirmed'
  /** 从用户手动标记的旧字段迁移而来 */
  | 'legacy_user_set'
  /** 结构上无歧义（如旧数据的 gold 类型条目、isLiability 分类） */
  | 'structural'
  /** 系统默认，需用户复核 */
  | 'default'
  /** 无法判断，等待用户确认 */
  | 'unknown'

export const CLASSIFICATION_SOURCE_LABEL: Record<ClassificationSource, string> = {
  user_confirmed: '已由你确认',
  legacy_user_set: '沿用你此前的标记',
  structural: '由录入方式确定',
  default: '系统默认，建议复核',
  unknown: '尚未确认',
}

/* ------------------------------------------------------------------ *
 * Holding 持仓
 * ------------------------------------------------------------------ */

/**
 * 持仓。
 *
 * 数量口径按资产性质选择，不强迫所有资产使用股票式的 quantity：
 * - `quantity` + `averageCost`：股票 / ETF / 基金 / 债券 / 黄金（按克）
 * - `manualValue`：现金余额、房产估值、应收款
 * 两者不可同时使用；由 `valuationMode` 显式声明。
 */
export type ValuationMode = 'quantity' | 'manual'

export interface Holding {
  id: string
  accountId: string
  instrumentId: string
  /** 估值口径，决定下面哪组字段有效 */
  valuationMode: ValuationMode
  /** 数量口径：持有数量（基金为份额、黄金为克） */
  quantity?: number
  /** 数量口径：总成本（原币） */
  costBasis?: number
  /** 数量口径：平均成本单价（原币） */
  averageCost?: number
  /** 手动口径：当前价值（原币） */
  manualValue?: number
  /** 手动口径：手动记录的价值时间，便于提示「多久没更新」 */
  manualValueAt?: IsoDateTime
  openedAt?: IsoDateTime
  note?: string
  /**
   * **孤立持仓标记**：交易流水里找不到依据时由重建流程置位。
   *
   * 语义是「需要用户处理」，**不是**「可以删除」——
   * 重建绝不能因为一次执行就丢掉资产。
   * 处理方式：补一条期初 `adjustment` 纳入账本，或由用户明确删除。
   */
  orphan?: boolean
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

/* ------------------------------------------------------------------ *
 * Transaction 交易流水
 * ------------------------------------------------------------------ */

export type TransactionType =
  | 'buy'
  | 'sell'
  | 'deposit'
  | 'withdraw'
  | 'dividend'
  | 'interest'
  | 'fee'
  | 'transfer'
  /** **换汇**：一种现金资产换成另一种币种的现金资产（USD → CNY） */
  | 'exchange'
  | 'adjustment'

export const TRANSACTION_TYPE_LABEL: Record<TransactionType, string> = {
  buy: '买入',
  sell: '卖出',
  deposit: '存入',
  withdraw: '取出',
  dividend: '股息',
  interest: '利息',
  fee: '手续费',
  transfer: '划转',
  exchange: '换汇',
  adjustment: '调整',
}

/** 现金流方向：用于区分「投入本金」与「投资收益」 */
export type CashFlowDirection = 'in' | 'out' | 'internal' | 'none'

export interface Transaction {
  id: string
  accountId: string
  instrumentId?: string
  type: TransactionType
  quantity?: number
  price?: number
  /** 交易金额（原币，正数；方向由 type 决定） */
  amount: number
  currency: CurrencyCode
  fee?: number
  timestamp: IsoDateTime
  /** 划转目标账户（type = 'transfer'） */
  toAccountId?: string
  /**
   * **部分划转**的转移数量（type = 'transfer' 时有效）。
   * - 省略或等于持有数量 → 整体移动（默认）
   * - 小于持有数量 → 按移动加权平均成本转移对应比例的成本
   *
   * 语义仍是「移动」：不减记 realizedPnl、不产生买卖、不产生收入，
   * 组合层面的总数量与总成本保持不变。
   */
  transferQuantity?: number
  /**
   * 该笔交易所涉及的**现金标的**（资金腿）。
   *
   * 一笔真实交易会同时影响两个 Holding（例如买入：投资 Holding 增加、现金 Holding 减少），
   * 字段用于让派生引擎知道钱从哪个现金标的进出，**避免重复计量**。
   * 省略时不产生现金腿（仅记录流水）。
   *
   * 约束：`currency` 必须等于该现金标的的币种（单笔交易只有一种币种）。
   */
  cashInstrumentId?: string
  /**
   * **换汇目标现金标的**（type = 'exchange' 时必填）。
   *
   * 换汇不能被建模成「sell + buy」——那会让收益归因把换汇误认为投资交易。
   * 这里用两条资金腿表达：`cashInstrumentId` 减少、`toCashInstrumentId` 增加。
   */
  toCashInstrumentId?: string
  /**
   * 换汇目标币种（type = 'exchange' 且需要校验时使用）。
   * 缺省时取目标现金标的的币种。
   */
  toCurrency?: CurrencyCode
  /** 该笔交易对现金标的的**目标金额**（换汇时的到账金额，原币） */
  toAmount?: number
  note?: string

  /* ---- 生命周期（Schema V6 / Phase 8 W5） ---- */

  /**
   * 交易状态。
   *
   * | 值 | 含义 |
   * | --- | --- |
   * | `POSTED` | 正常有效交易，参与 Ledger 计算 |
   * | `VOIDED` | **已作废**，不再参与 Ledger 计算 |
   * | `undefined` | **按 `POSTED` 处理**（V6 之前的老数据） |
   *
   * ⚠️ 作废是**唯一**的修正手段：**禁止物理删除 Transaction**。
   * 原记录必须保留，只把状态改成 `VOIDED`。
   */
  status?: TransactionStatus
  /** 作废时间 */
  voidedAt?: IsoDateTime
  /** 作废原因（可选，便于审计） */
  voidReason?: string
}

/**
 * 交易生命周期状态。
 *
 * 读取层统一用 `transactionStatus()` 归一化：`undefined → 'POSTED'`。
 * **不要在各处直接判断 `tx.status === 'POSTED'`** —— 那会漏掉老数据。
 */
export type TransactionStatus = 'POSTED' | 'VOIDED'

/* ------------------------------------------------------------------ *
 * Quote 行情
 * ------------------------------------------------------------------ */

/**
 * 行情状态。
 * 严格区分「市场价格 / 正式 NAV / 估算 NAV / 手动价格」，
 * 不允许把旧数据或失败结果继续标成 LIVE。
 */
export type QuoteStatus = 'LIVE' | 'DELAYED' | 'STALE' | 'CLOSED' | 'ERROR' | 'MANUAL'

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  LIVE: '实时',
  DELAYED: '延迟',
  STALE: '已过期',
  CLOSED: '已收盘',
  ERROR: '获取失败',
  MANUAL: '手动',
}

/** 价格种类 */
export type PriceKind = 'market_price' | 'nav' | 'estimated_nav' | 'manual'

export const PRICE_KIND_LABEL: Record<PriceKind, string> = {
  market_price: '市场价格',
  nav: '单位净值',
  estimated_nav: '估算净值',
  manual: '手动价格',
}

export interface Quote {
  id: string
  instrumentId: string
  /** 按 priceKind 决定哪个字段有效 */
  priceKind: PriceKind
  /** 市场价格（场内） */
  marketPrice?: number
  /** 正式单位净值（场外基金） */
  nav?: number
  /** 盘中估算净值 */
  estimatedNav?: number
  currency: CurrencyCode
  source: string
  timestamp: IsoDateTime
  status: QuoteStatus
  /** 失败原因（status = 'ERROR' 时） */
  error?: string
}

/* ------------------------------------------------------------------ *
 * FxRate 汇率
 * ------------------------------------------------------------------ */

export type FxStatus = 'LIVE' | 'DELAYED' | 'STALE' | 'MANUAL' | 'ERROR'

export const FX_STATUS_LABEL: Record<FxStatus, string> = {
  LIVE: '实时',
  DELAYED: '延迟',
  STALE: '已过期',
  MANUAL: '手动',
  ERROR: '获取失败',
}

export interface FxRate {
  id: string
  baseCurrency: CurrencyCode
  quoteCurrency: CurrencyCode
  /** 1 base = rate quote */
  rate: number
  timestamp: IsoDateTime
  source: string
  status: FxStatus
}

/* ------------------------------------------------------------------ *
 * Snapshot 资产快照
 * ------------------------------------------------------------------ */

/**
 * 快照中的单条持仓明细。
 *
 * 为什么要存到持仓级：只有记录「期初的数量/价格/汇率」，
 * 才能把期间变化拆成**投资收益**与**汇率影响**；
 * 同时也为未来的历史资产分析、归因与审计保留原始依据。
 *
 * ⚠️ positions 只描述**当日实际持仓状态**。
 * 交易 / leg **不会**再次计入资产总额 —— 它们只解释「持仓为何变化」。
 */
export interface SnapshotPosition {
  instrumentId: string
  accountId: string
  /** 数量（现金口径下即金额） */
  quantity: number
  /**
   * 单价（原币）；现金恒为 1。
   *
   * ⚠️ **不可估值时必须是 `undefined`，绝不写 0 或 1**
   * （Schema V7 起为可选字段）。
   * 用数字伪造缺失会违反核心不变量「不可估值 ≠ 价值为 0」：
   * 一个 `price: 0` 的持仓脱离 `reliable` 标记后，与「真的不值钱」无法区分。
   */
  price?: number
  currency: CurrencyCode
  /**
   * 该币种对 CNY 的汇率（1 原币 = ? CNY）；CNY 恒为 1。
   *
   * 为什么**保持必填**：Phase 4 的汇率归因恒等式
   * （`computeFxEffect` / `netWorth = opening + flow + return + fx + other`）
   * 在结构上按数字参与运算，改为可空会改变已验收的归因语义。
   * 因此汇率未解析时用 **1（中性占位，不改变任何乘积）**，
   * 该条的可信度由 `reliable = false` 负责表达。
   */
  rateToCny?: number
  /**
   * 折算后的人民币价值。
   *
   * ⚠️ **不可估值时必须是 `undefined`，绝不写 0**（Schema V7 起为可选字段）。
   * 下游必须显式处理缺失，而不是把 0 当成「价值为零」。
   */
  valueCny?: number
  /**
   * **仅供展示**的过期价（Schema V8，P1-3）。
   *
   * 为什么需要：`stale` 持仓的 `price` / `valueCny` 都是 `undefined`
   * （不可靠、不计入总额），于是历史快照里**连当时的过期价都没留下** ——
   * 事后无法回答「那天大概值多少」，也无法判断缺口有多大。
   *
   * ⚠️ 严格约束：
   * - **绝不参与任何总额计算**（与 `ValuationResult.nativeValue` 同一性质）；
   * - 仅在行情**确实过期但可读**时写入；
   * - **绝不使用成本价兜底** —— 成本价不是市价，用它冒充会误导。
   */
  staleValueCny?: number
  /** 该条是否可靠估值（false 时不参与总额） */
  reliable: boolean
  /**
   * **捕获当时的**资产类别（Schema V4 新增）。
   *
   * 为什么需要：`Instrument.assetClass` 是**当前**值。
   * 如果用户今天确认了某个标的的分类，那么用它回溯历史，
   * 会让过去所有快照都显示成「今天的分类」——
   * 历史趋势因此被整体重画，反映的不是当时的事实。
   *
   * ⚠️ **v3 存量快照没有这个字段，也不回填**：
   * 回填等于用今天的分类伪造历史。此时该值为 `undefined`，
   * 历史趋势必须明确标注「历史分类数据不可用」，宁可留缺口也不伪造。
   */
  assetClassAtCapture?: AssetClass

  /* ---- 估值依据（Schema V8 / Phase 8 W8）---- */

  /**
   * 该价格的**依据时间**（行情 / 汇率 / 手动价的 asOf）。
   *
   * 为什么必须落盘：`quotes` / `fxRates` 是可更新的，
   * 只存数字会让历史快照「有值但无法自证」。
   * 有了它才能回答「2026-10-01 这一天，这个资产为什么是这个价值」。
   *
   * ⚠️ **v7 及以前的历史快照没有这个字段，也不回填** —— 回填等于伪造依据。
   */
  asOf?: IsoDateTime
  /**
   * 价格类型（市场价格 / 单位净值 / 估算净值 / 手动价格）。
   *
   * 事后必须能区分「这是市价还是估算」，否则历史解释会失真。
   */
  priceKind?: PriceKind
  /**
   * 捕获当时该行情/估值的状态。
   *
   * 区分 `LIVE` / `DELAYED` / `CLOSED` / `MANUAL` / `STALE` / `ERROR`
   * 以及「根本没有行情」。此前这些信息被压成 `reliable` 布尔，
   * 导致「当时是收盘价」与「当时缺行情」在历史里完全同形。
   */
  quoteStatus?: QuoteStatus
  /** 行情来源（如 `manual` / `fundgz`），便于事后核对 */
  quoteSource?: string
  /** 汇率状态（`LIVE` / `DELAYED` / `STALE` / `MANUAL` / `ERROR`） */
  fxStatus?: FxStatus
  /** 汇率来源 */
  fxSource?: string
  /**
   * **捕获当时**不可估值 / 降级的具体原因（Schema V8）。
   *
   * 为什么必须落盘：`reliable` 只是一个布尔，无法区分
   * 「当时缺行情」「当时汇率过期」「当时行情报错」。
   * 缺少它，历史快照就只能说「这项不可靠」，却说不清**为什么**，
   * 事后也无法判断当年的数据缺口是暂时性的还是系统性的。
   *
   * 取值与 `ValuationReason` 一致（如 `missing_quote` / `stale_fx`）；
   * 可靠估值的项为空数组。
   */
  reasons?: string[]
  /**
   * **捕获当时**该持仓是否负债（Schema V8）。
   *
   * 与 `assetClassAtCapture` 同理：负债判定依赖账户与标的的当前状态，
   * 事后用今天的状态回溯会把历史占比重画。
   *
   * ⚠️ v7 及以前没有该字段，不回填；`undefined` 表示「无法判断」，
   * 历史占比必须明确标注，而不是假定为资产。
   */
  isLiabilityAtCapture?: boolean
}

/**
 * 快照归因可信度。
 *
 * | 值 | 含义 |
 * | --- | --- |
 * | `complete` | 全部字段可靠且完整 |
 * | `partial` | 有 stale / unavailable / 缺汇率 / 残差超阈值 |
 * | `unavailable` | 首日快照，没有上一份快照，变化字段一律为 undefined |
 */
export type AttributionStatus = 'complete' | 'partial' | 'unavailable'

/**
 * 每日资产快照。
 *
 * ## 核心恒等式（固定，不得改写）
 *
 * ```
 * 期末净资产 = 期初净资产
 *            + 外部流入 − 外部流出
 *            + investmentReturn      ← 已扣除费用后的净投资收益
 *            + fxEffect
 *            + otherAdjustment
 * ```
 *
 * **费用不单独出现在等式中**：手续费已经通过现金减少反映在期末净资产里，
 * 因此 `investmentReturn` 天然是「扣费后」的净额。
 * `feeTotal` 只用于展示成本，**不得**再从等式里加回或重复扣除。
 *
 * ## 残差的处理
 *
 * ```
 * residual = 期末 − 期初 − 外部净流入 − investmentReturn − fxEffect
 * ```
 * - 残差在容差内 → 视为浮点误差，`otherAdjustment` 归零；
 * - 残差超阈值 → 写入 `otherAdjustment` 并记 `attributionStatus = 'partial'` + 原因，
 *   **不允许**把残差静默塞进 `investmentReturn` 冒充收益。
 *
 * 约束：同一天只能存在一个有效 snapshot —— 重复生成必须**更新**而非新增。
 */
export interface Snapshot {
  id: string
  /** YYYY-MM-DD，唯一 */
  date: IsoDate
  totalAssets: number
  totalLiabilities: number
  netWorth: number
  /** 记账本位币，固定人民币 */
  currency: 'CNY'
  /** 资产类别 -> 人民币金额（仅可靠估值部分） */
  assetAllocation: Partial<Record<AssetClass, number>>
  /** 持仓级明细，用于 FX 拆分与历史审计 */
  positions: SnapshotPosition[]

  /* ---- 归因字段：无数据时为 undefined，**不填 0** ---- */
  /** 期初净资产（上一份快照的 netWorth） */
  openingNetWorth?: number
  /** 外部流入（跨组合边界转入） */
  externalInflow?: number
  /** 外部流出（跨组合边界转出） */
  externalOutflow?: number
  /** 扣费后的净投资收益 */
  investmentReturn?: number
  /** 汇率变化影响 */
  fxEffect?: number
  /** 无法归入上述类别的明确调整（残差超阈值时才有值） */
  otherAdjustment?: number
  /** 残差原始值，便于排查；容差内会被归零 */
  residual?: number
  /** 其他调整的原因说明 */
  otherAdjustmentReason?: string
  /** 当日内部划转笔数（仅记录，**不进入等式**） */
  internalTransferCount?: number
  /** 费用合计（成本展示用，**不参与等式**） */
  feeTotal?: number

  /* ---- 完整性 ---- */
  /** 未能可靠估值的持仓数量，> 0 时该日不完整 */
  unavailableCount?: number
  /** 估值依据已过期的持仓数量 */
  staleCount?: number
  /** 是否全部可靠估值（unavailable 与 stale 都为 0） */
  isComplete?: boolean
  /**
   * **快照来源标记**（Schema V5 新增）。
   *
   * | 值 | 含义 |
   * | --- | --- |
   * | `REAL` | 当日真实捕获 |
   * | `BACKFILLED` | 历史补齐 |
   * | `ESTIMATED` | 估算 |
   * | `undefined` | **来源未标记**（v4 及以前的旧快照） |
   *
   * ⚠️ `undefined` **不得**按 `REAL` 解释 —— 那等于把「未知」推断成「真实」。
   * 读取层统一解析为 `UNKNOWN`（见 `performance/history.ts` 的 `snapshotCaptureKind`）。
   * 本阶段只产生 `REAL`，不实现 BACKFILLED / ESTIMATED。
   */
  captureKind?: 'REAL' | 'BACKFILLED' | 'ESTIMATED'
  /**
   * 期初快照的日期（Schema V8）。
   *
   * 为什么需要：`openingNetWorth` 等金额只说明「从哪个数开始」，
   * 不说明**期初是哪一天**。若期初不是紧邻前一日（缺日、迁移的月度点），
   * 事后无法识别 —— 只能看到一组看起来正常的收益数字。
   * 有了它就能自证间隔。
   *
   * ⚠️ v7 及以前不回填（回填等于伪造）。
   */
  openingDate?: IsoDate
  /**
   * 实际捕获 / 刷新时刻（Schema V8，ISO 时间）。
   *
   * 与 `createdAt` 的区别：`createdAt` 是**首次**创建时间；
   * 当日快照可能在同一天被多次刷新（W7 起允许），
   * `capturedAt` 记录的是**内容所对应**的那次捕获。
   *
   * ⚠️ v7 及以前不回填。
   */
  capturedAt?: IsoDateTime
  /** 归因可信度 */
  attributionStatus: AttributionStatus
  /** 无法完整归因时的原因清单 */
  attributionNotes?: string[]

  createdAt: IsoDateTime
}

/* ------------------------------------------------------------------ *
 * AllocationProfile 目标配置
 * ------------------------------------------------------------------ */

export interface AllocationTarget {
  assetClass: AssetClass
  targetPercent: number
}

export interface AllocationProfile {
  id: string
  name: string
  /** 兼容视图：只填能明确对应 `AssetClass` 的类别 */
  targets: AllocationTarget[]
  /** 是否由内置模板套用而来（模板本身不构成投资建议） */
  fromTemplateId?: string
  createdAt: IsoDateTime
  updatedAt: IsoDateTime

  /* ---- 以下为 1.0 策略配置的**保真迁移字段**（Phase 8 / W1） ---- */

  /**
   * 1.0 的 `Strategy` 原文。
   *
   * 为什么保留：1.0 的 `StrategyClass.id` 是**任意字符串**，
   * 与 `AssetClass` 不能无损映射（强行映射会丢用户自定义类别与配色）。
   * 因此原样保存，避免迁移过程中丢失用户配置。
   */
  legacyStrategy?: {
    id: string
    name: string
    kind: string
    description: string
    classes: Array<{
      id: string
      name: string
      target: number
      color?: string
      colorName?: string
    }>
  }
  /** 1.0 的分类 → 策略类映射（`strategy/v1` 的 `mappings`） */
  legacyMappings?: unknown
  /** 1.0 的偏离阈值（百分点） */
  legacyThreshold?: number
  /** 1.0 的「负债是否计入分母」设置 */
  legacyIncludeLiabilities?: boolean
  /** 1.0 的未映射分类处理策略 */
  legacyUnmappedPolicy?: 'auto' | 'ignore'
  /** 是否为 1.0 中当前启用的策略 */
  isActive?: boolean
}

/* ------------------------------------------------------------------ *
 * 汇总容器
 * ------------------------------------------------------------------ */

export interface Portfolio2 {
  accounts: Account[]
  instruments: Instrument[]
  holdings: Holding[]
  transactions: Transaction[]
  quotes: Quote[]
  fxRates: FxRate[]
  snapshots: Snapshot[]
  allocationProfiles: AllocationProfile[]
  /**
   * **分类变更审计**（Schema V4 / DB v2 引入）。
   *
   * `confirm` 与 `unconfirm` **都**必须留痕，以便追踪完整链路：
   * ```
   * unconfirmed → confirmed/equity → unconfirmed
   * ```
   * 该表**只增不改**，任何重建/迁移流程都不得清空它。
   */
  classificationAudit: ClassificationAuditEntry[]
}

/** 一次分类变更的审计记录 */
export interface ClassificationAuditEntry {
  id: string
  instrumentId: string
  from: { assetClass: AssetClass; status: ClassificationStatus }
  to: { assetClass: AssetClass; status: ClassificationStatus }
  at: IsoDateTime
  /** 变更来源：单条确认 / 批量确认 / 撤销 */
  action: 'confirm' | 'confirm_many' | 'unconfirm'
}

export function createEmptyPortfolio2(): Portfolio2 {
  return {
    accounts: [],
    instruments: [],
    holdings: [],
    transactions: [],
    quotes: [],
    fxRates: [],
    snapshots: [],
    allocationProfiles: [],
    classificationAudit: [],
  }
}

/* ------------------------------------------------------------------ *
 * 账户维度分析
 * ------------------------------------------------------------------ */

/**
 * 账户的多维汇总。
 *
 * 因为一个账户可同时持有多种资产类别与币种，所以这里按四个维度分别聚合，
 * 而不是给账户打一个「类型」标签 —— 那样会重演 1.x「账户=资产类别」的问题。
 */
export interface AccountBreakdown {
  accountId: string
  /** 账户内资产类别 → 金额（原币混合，仅供结构展示；估值请走估值引擎） */
  byAssetClass: Partial<Record<AssetClass, number>>
  /** 账户内币种 → 金额（原币） */
  byCurrency: Partial<Record<CurrencyCode, number>>
  instrumentCount: number
}

export function isMultiCurrencyAccount(accountId: string, byCurrency: Record<string, number>): boolean {
  return Object.keys(byCurrency).length > 1 && !!accountId
}

/* ------------------------------------------------------------------ *
 * 未确认分类：供界面提示用户复核
 * ------------------------------------------------------------------ */

export interface UnconfirmedItem {
  instrumentId: string
  name: string
  /** 系统暂定的类别（可能不正确，仅供选择时的默认高亮） */
  assumedAssetClass: AssetClass
  /** 建议的候选类别，由界面按 instrumentType 给出，不由系统替用户决定 */
  candidates: AssetClass[]
}

/**
 * 按「投资工具类型」给出候选资产类别。
 *
 * 这里只列**可能性**，不替用户下结论 —— 例如基金既可能是股票型也可能是债券型，
 * 所以候选里同时包含两类，由用户确认。
 */
export function candidateAssetClasses(instrumentType: InstrumentType): AssetClass[] {
  switch (instrumentType) {
    case 'cash':
      return ['cash', 'other']
    case 'stock':
    case 'etf':
      // ETF 也可能是债券/黄金 ETF，故一并列出
      return ['equity', 'fixed_income', 'gold', 'other']
    case 'fund':
      return ['equity', 'fixed_income', 'cash', 'gold', 'other']
    case 'bond':
      return ['fixed_income', 'cash', 'other']
    case 'gold':
      return ['gold', 'other']
    case 'real_estate':
      return ['real_estate', 'other']
    case 'crypto':
      return ['crypto', 'other']
    case 'receivable':
      return ['receivable', 'other']
    default:
      return ['cash', 'equity', 'fixed_income', 'gold', 'real_estate', 'crypto', 'receivable', 'other']
  }
}
