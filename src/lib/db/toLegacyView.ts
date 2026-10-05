/**
 * `Portfolio2` → 1.0 视图适配器
 *
 * @transitional Phase 8 / W1 引入，**W3 完成后删除**
 *
 * ## 为什么需要它
 *
 * Phase 1–7 建成的 2.0 引擎（`Portfolio2` + IndexedDB）与 1.0 遗留 UI
 * （`Portfolio` + `Category/AssetItem`）的数据模型不同。
 * W1/W2 要在**不重写全部组件**的前提下让 1.0 UI 显示 2.0 的数据，
 * 因此需要一层投影。
 *
 * ## 严格约束（不可放宽）
 *
 * | 约束 | 说明 |
 * | --- | --- |
 * | **单向** | 只允许 `Portfolio2 → Portfolio`，**绝不允许反向** |
 * | **只读** | 本文件不做任何写入 —— 不碰 IndexedDB，不碰 localStorage |
 * | **无业务逻辑** | 只做字段映射；**不做估值、不做分类推断、不补默认值以外的加工** |
 * | **临时** | W3 完成后整文件删除 |
 *
 * ## 一个必须知道的口径差异
 *
 * 1.0 UI 用自己的 `calc.ts` 汇总金额，2.0 用 `valuation/engine`。
 * 两者的可用性判断不同（1.0 没有 stale/unavailable 概念）。
 * 因此**本适配器产出的视图金额不保证等于 2.0 的 `reliableValueCny`**。
 *
 * W1 期间旧页面只是「预览」，最终金额一律以 2.0 分析页为准。
 * `summarizeLegacyView()` 会显式返回这一差异，便于排查与测试。
 */

import type { AssetItem, Category, HistoryPoint, Portfolio } from '../../types/asset'
import type {
  Account,
  AssetClass,
  Holding,
  Instrument,
  Portfolio2,
  Quote,
  Snapshot,
} from '../../types/portfolio2'

const ISO = (t?: number) => new Date(t ?? Date.now()).toISOString()

/* ------------------------------------------------------------------ *
 * 账户 → 分类
 * ------------------------------------------------------------------ */

interface CategoryStyle {
  subtitle: string
  icon: string
  colorName: string
  color: string
}

const ACCENT = (name: string) => `var(--accent-${name})`

/**
 * 账户类型 → 分类外观。
 *
 * 纯展示映射，**不参与任何业务判断**。
 */
function styleForAccount(account: Account): CategoryStyle {
  switch (account.type) {
    case 'bank':
      return { subtitle: '银行 / 现金', icon: 'banknote', colorName: 'gold', color: ACCENT('gold') }
    case 'broker':
      return { subtitle: '券商 / 证券', icon: 'trending-up', colorName: 'blue', color: ACCENT('blue') }
    case 'fund_platform':
      return { subtitle: '基金平台', icon: 'chart-pie', colorName: 'green', color: ACCENT('green') }
    case 'gold_platform':
      return { subtitle: '黄金账户', icon: 'gem', colorName: 'amber', color: ACCENT('amber') }
    case 'real_estate':
      return { subtitle: '房产', icon: 'landmark', colorName: 'slate', color: ACCENT('slate') }
    case 'crypto':
      return { subtitle: '数字资产', icon: 'bitcoin', colorName: 'purple', color: ACCENT('purple') }
    default:
      return { subtitle: '其他账户', icon: 'wallet', colorName: 'slate', color: ACCENT('slate') }
  }
}

/* ------------------------------------------------------------------ *
 * 持仓 → 条目
 * ------------------------------------------------------------------ */

function isCashInstrument(inst: Instrument | undefined): boolean {
  return inst?.instrumentType === 'cash'
}

function isGoldInstrument(inst: Instrument | undefined): boolean {
  return inst?.instrumentType === 'gold'
}

/**
 * 把一条持仓映射成 1.0 的条目。
 *
 * 口径选择（**只做形态映射，不做估值**）：
 * - 现金 / 手动口径 → `amount`（金额）
 * - 黄金 → `gold`（克数 × 单价）
 * - 其余数量口径 → `fund`（份额 × 成本单价）
 *
 * 注意：`fund` 条目在 1.0 里会去拉行情；W1 期间不触发刷新，
 * 因此显示的是**成本价**，与 2.0 的市值不同属于预期差异。
 */
function toAssetItem(
  holding: Holding,
  instrument: Instrument | undefined,
  account: Account,
  latestQuote?: Quote,
): AssetItem | null {
  const name = instrument?.name ?? '未知标的'

  // 现金 或 手动口径 → 金额条目
  if (holding.valuationMode === 'manual' || isCashInstrument(instrument)) {
    const amount = holding.valuationMode === 'manual' ? (holding.manualValue ?? 0) : (holding.quantity ?? 0)
    return {
      id: holding.id,
      kind: 'amount',
      name,
      note: holding.note,
      amount,
      currency: (instrument?.currency ?? account.currency) as never,
    }
  }

  // 黄金 → 克数条目
  if (isGoldInstrument(instrument)) {
    const grams = holding.quantity ?? 0
    const pricePerGram = grams > 0 ? (holding.costBasis ?? 0) / grams : 0
    return {
      id: holding.id,
      kind: 'gold',
      name,
      note: holding.note,
      grams,
      pricePerGram,
      currency: (instrument?.currency ?? account.currency) as never,
    }
  }

  /*
   * 其余数量口径 → 基金/证券条目。
   *
   * 成本单价写 `costNav`；若已有行情价，同时写入 `manualNav`，
   * 使 1.0 视图显示**市值**而不是成本 —— 这样过渡期旧页面的金额
   * 才与 2.0 估值引擎接近，避免用户看到两个不同的数字。
   * 这里只做映射，**不自行报价**：没有行情就不写。
   */
  const quantity = holding.quantity ?? 0
  const costNav = quantity > 0 ? (holding.costBasis ?? 0) / quantity : 0
  const marketPrice = latestQuote?.marketPrice

  return {
    id: holding.id,
    kind: 'fund',
    name,
    note: holding.note,
    code: instrument?.symbol ?? instrument?.id ?? '',
    market: inferMarket(account, instrument),
    shares: quantity,
    costNav,
    ...(typeof marketPrice === 'number' && Number.isFinite(marketPrice) ? { manualNav: marketPrice } : {}),
    assetClass: undefined,
  } as AssetItem
}

/**
 * 推断 1.0 的市场枚举。
 *
 * 只依据**已有字段**（标的币种 + 账户属地），不做名称/代码猜测。
 */
function inferMarket(account: Account, instrument: Instrument | undefined): 'cn' | 'us' | 'hk' {
  const currency = instrument?.currency ?? account.currency
  if (currency === 'USD') return 'us'
  if (currency === 'HKD') return 'hk'
  return 'cn'
}

/* ------------------------------------------------------------------ *
 * 快照 → history
 * ------------------------------------------------------------------ */

function toHistoryPoint(snap: Snapshot): HistoryPoint {
  return {
    date: snap.date,
    netWorth: snap.netWorth,
    totalAssets: snap.totalAssets,
    totalLiabilities: snap.totalLiabilities,
    at: new Date(`${snap.date}T00:00:00.000Z`).getTime(),
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export interface LegacyViewOptions {
  /** 覆盖 version 字段（1.0 期望 2） */
  version?: number
}

/**
 * 把 2.0 组合投影为 1.0 视图。
 *
 * **纯函数**：不读写任何存储。
 */
export function toLegacyView(portfolio: Portfolio2, options: LegacyViewOptions = {}): Portfolio {
  const instrumentById = new Map(portfolio.instruments.map((i) => [i.id, i]))
  const latestQuoteByInstrument = new Map<string, Quote>()
  for (const q of portfolio.quotes) {
    const prev = latestQuoteByInstrument.get(q.instrumentId)
    if (!prev || q.timestamp > prev.timestamp) latestQuoteByInstrument.set(q.instrumentId, q)
  }

  const categories: Category[] = portfolio.accounts.map((account) => {
    const style = styleForAccount(account)
    const items = portfolio.holdings
      .filter((h) => h.accountId === account.id)
      .map((h) =>
        toAssetItem(h, instrumentById.get(h.instrumentId), account, latestQuoteByInstrument.get(h.instrumentId)),
      )
      .filter((x): x is AssetItem => x !== null)

    return {
      id: account.id,
      name: account.name,
      subtitle: style.subtitle,
      icon: style.icon,
      color: style.color,
      colorName: style.colorName,
      isLiability: account.isLiability,
      defaultKind: 'amount',
      items,
    }
  })

  const history = [...portfolio.snapshots]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(toHistoryPoint)

  return {
    version: options.version ?? 2,
    categories,
    history,
    // 1.0 用它显示「最近同步」；2.0 的行情时间不在组合上，故留空
    lastSyncedAt: undefined,
  }
}

/* ------------------------------------------------------------------ *
 * 差异提示（供测试与诊断）
 * ------------------------------------------------------------------ */

export interface LegacyViewSummary {
  categoryCount: number
  itemCount: number
  historyCount: number
  /** 适配器**不保证**该金额等于 2.0 的 reliableValueCny */
  note: string
}

export function summarizeLegacyView(view: Portfolio): LegacyViewSummary {
  return {
    categoryCount: view.categories.length,
    itemCount: view.categories.reduce((s, c) => s + c.items.length, 0),
    historyCount: view.history.length,
    note:
      '1.0 视图用 calc.ts 汇总，口径与 2.0 估值引擎不同（无 stale/unavailable 概念）。' +
      '金额一律以 2.0 分析页为准。',
  }
}

/** 校验适配器没有丢条目（分类数 = 账户数，条目数 = 持仓数） */
export function checkLegacyViewFidelity(
  portfolio: Portfolio2,
  view: Portfolio,
): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  if (view.categories.length !== portfolio.accounts.length) {
    issues.push(`分类数 ${view.categories.length} ≠ 账户数 ${portfolio.accounts.length}`)
  }
  const itemCount = view.categories.reduce((s, c) => s + c.items.length, 0)
  if (itemCount !== portfolio.holdings.length) {
    issues.push(`条目数 ${itemCount} ≠ 持仓数 ${portfolio.holdings.length}`)
  }
  if (view.history.length !== portfolio.snapshots.length) {
    issues.push(`历史点数 ${view.history.length} ≠ 快照数 ${portfolio.snapshots.length}`)
  }
  return { ok: issues.length === 0, issues }
}

/* ------------------------------------------------------------------ *
 * 预加载注入（W1 读路径）
 * ------------------------------------------------------------------ */

let preloaded: Portfolio | null = null

/**
 * 启动时把迁移后的数据投影结果注入，供 `usePortfolio` **同步**读取。
 *
 * 为什么必须同步：`usePortfolio` 的初始状态是模块级 `loadPortfolio()` 的结果，
 * 若改成异步加载，首帧会先渲染 localStorage 的旧数据再切换 ——
 * 用户会看到数字跳动，且期间的状态可能被误写。
 *
 * 因此 `main.tsx` 在渲染前先 await 迁移，再把投影结果放进来。
 */
export function setPreloadedLegacyView(view: Portfolio | null): void {
  preloaded = view
}

/** 取预加载的投影结果（未设置时返回 null，调用方回退到 localStorage） */
export function getPreloadedLegacyView(): Portfolio | null {
  return preloaded
}

/** 仅供测试 */
export function resetPreloadedLegacyView(): void {
  preloaded = null
}

/** 仅用于类型收窄的占位导出，避免未使用告警 */
export type { AssetClass }
export const _iso = ISO
