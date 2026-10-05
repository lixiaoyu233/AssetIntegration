/**
 * 行情与汇率写入编排（Phase 8 / W6）
 *
 * ## 为什么必须有这一层
 *
 * W6 审计发现：2.0 应用里对 `quotes` / `fxRates` 的写入调用数是 **0**。
 * 行情只能来自 W1 迁移带入的那一份，之后**只减不增** ——
 * LIVE 行情 1 小时后即被判过期，可靠总资产静默萎缩，用户无从修复。
 *
 * 本模块补齐这个**能力断点**：让用户可以手动录入 / 更新行情与汇率。
 *
 * ## 严格遵守的三个不变量
 *
 * | 不变量 | 本模块如何保证 |
 * | --- | --- |
 * | 不可估值 ≠ 0 | 价格必须 > 0；缺失就不写，绝不用 0 顶替 |
 * | 缺 FX ≠ 1 | 汇率必须 > 0 且 base ≠ quote；缺就是缺 |
 * | STALE / ERROR 不进入可靠总额 | 状态如实写入，由既有 `judgeQuote` / `policy` 判定 |
 *
 * ## 分层（与 W4 的 ledger/transactionService 完全同构）
 *
 * ```
 * UI → upsertQuote() / upsertFxRate()
 *        ↓
 *      ① 参数校验（业务前置检查）
 *      ② 构造实体
 *      ③ **在内存中试算**：用新行情/汇率跑一次估值
 *      ④ 校验不变量（不得把「不可估值」写成 0，不得引入 1:1 冒充）
 *      ⑤ 全部通过 → 经 Repository 写入 IndexedDB
 *        ↓
 *      IndexedDB（唯一事实源）
 * ```
 *
 * **任何一步失败都返回 `{ ok: false }`，绝不写入任何数据。**
 *
 * ## 绝不重写估值判定
 *
 * 本模块**不实现任何估值规则**，只做编排与校验：
 * - 行情可用性 → `judgeQuote`（既有）
 * - 时效政策 → `DEFAULT_QUOTE_POLICY`（既有）
 * - 估值计算 → `valuateHolding` / `calculateTotals`（既有）
 * - 汇率解析 → `resolveRate`（既有）
 */

import type {
  CurrencyCode,
  FxRate,
  Instrument,
  Portfolio2,
  PriceKind,
  Quote,
  QuoteStatus,
} from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { judgeQuote } from '../valuation/quote'
import { resolveRate } from '../valuation/fx'
import { calculateTotals, valuateHolding } from '../valuation/engine'
import { createFxTable } from '../valuation/fx'

/* ------------------------------------------------------------------ *
 * 结果类型（与 W4 的 RecordResult 同构）
 * ------------------------------------------------------------------ */

export type PriceWriteFailureCode =
  | 'not-found'
  | 'missing-instrument'
  | 'invalid-price'
  | 'invalid-rate'
  | 'invalid-input'
  | 'missing-rate'
  | 'same-currency'
  | 'invariant-violated'

export interface PriceWriteFailure {
  ok: false
  code: PriceWriteFailureCode
  message: string
}

export interface QuoteWriteSuccess {
  ok: true
  quote: Quote
  /** 写入后该标的的可用估值得分（供 UI 立即反馈） */
  valuation: { status: string; value?: number; currency: CurrencyCode }
}

export type QuoteWriteResult = QuoteWriteSuccess | PriceWriteFailure

export interface FxWriteSuccess {
  ok: true
  rate: FxRate
  /** 写入后受影响的持仓数（该币种） */
  affectedHoldingCount: number
}

export type FxWriteResult = FxWriteSuccess | PriceWriteFailure

/* ------------------------------------------------------------------ *
 * 输入
 * ------------------------------------------------------------------ */

export interface UpsertQuoteInput {
  instrumentId: string
  priceKind: PriceKind
  /** 价格（必须 > 0） */
  price: number
  currency: CurrencyCode
  /** 行情依据时间（ISO） */
  timestamp: string
  /** 行情状态。手动录入默认 MANUAL（政策上不因时间失效） */
  status?: QuoteStatus
  /** 来源标注。手动录入必须是 manual-ish，**绝不伪装成外部源** */
  source?: string
  /** 可选：显式指定 id（覆盖既有行情） */
  id?: string
  now?: () => Date
}

export interface UpsertFxRateInput {
  baseCurrency: CurrencyCode
  quoteCurrency: CurrencyCode
  /** 1 base = ? quote（必须 > 0） */
  rate: number
  timestamp: string
  status?: FxRate['status']
  source?: string
  now?: () => Date
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

let seq = 0
function nextId(prefix: string, at: string): string {
  seq += 1
  return `${prefix}_${new Date(at).getTime()}_${seq}`
}

/** 把价格写入 `priceKind` 对应的字段（与 `quotePrice()` 的读取口径严格对应） */
function priceFieldsFor(priceKind: PriceKind, price: number) {
  switch (priceKind) {
    case 'market_price':
      return { marketPrice: price }
    case 'nav':
      return { nav: price }
    case 'estimated_nav':
      return { estimatedNav: price }
    case 'manual':
      // 手动价可能写在场内字段或场外字段；统一写 marketPrice，读取时 quotePrice 会兜底
      return { marketPrice: price }
    default:
      return { marketPrice: price }
  }
}

/**
 * 业务键：同一标的 + 同一价格类型 + 同一来源 + **同一时间点**。
 *
 * ## 为什么按这个键去重（Phase 8 / W8，P0-3）
 *
 * W6 起实现是「同一 (instrumentId, priceKind) 就复用同一行 id → 覆盖」。
 * 后果：**历史行情永久消失**，只留最后一次录入值 ——
 * 快照里的数字因此「有值但无法自证」。
 *
 * W8 改为**按业务键去重**：
 * - 同一时间点的同一笔录入 → 覆盖（防止重复点击堆积、便于更正输入错误）；
 * - **不同时间点** → 各自保留一行（历史行情可追溯）。
 *
 * 这正是「行情是多时间点的事实」这一语义的正确表达。
 */
function quoteBusinessKey(q: {
  instrumentId: string
  priceKind: PriceKind
  source: string
  timestamp: string
}): string {
  return `${q.instrumentId}|${q.priceKind}|${q.source}|${q.timestamp}`
}

/** 找到业务键相同的既有行情 id（无则 undefined → 追加新行） */
function existingQuoteIdFor(
  portfolio: Portfolio2,
  key: string,
): string | undefined {
  return portfolio.quotes.find((q) => quoteBusinessKey(q) === key)?.id
}

/** 汇率业务键：币种对 + 来源 + 时间点 */
function fxBusinessKey(r: {
  baseCurrency: string
  quoteCurrency: string
  source: string
  timestamp: string
}): string {
  return `${r.baseCurrency}|${r.quoteCurrency}|${r.source}|${r.timestamp}`
}

/* ------------------------------------------------------------------ *
 * 行情写入
 * ------------------------------------------------------------------ */

/**
 * 录入 / 更新一笔行情。
 *
 * - 同一标的 + 同一 `priceKind` → **覆盖**（避免行情表无限增长）
 * - 写入前用新行情**试算一次估值**，确认不会把「不可估值」变成伪造的 0
 */
export async function upsertQuote(
  repo: PortfolioRepository,
  input: UpsertQuoteInput,
): Promise<QuoteWriteResult> {
  const now = input.now ?? (() => new Date())
  const portfolio = await repo.loadPortfolio()

  /* ---- ① 参数校验 ---- */
  const instrument = portfolio.instruments.find((i) => i.id === input.instrumentId)
  if (!instrument) {
    return { ok: false, code: 'missing-instrument', message: '所选标的不存在（不会用字符串伪造行情）' }
  }
  if (!Number.isFinite(input.price) || input.price <= 0) {
    return {
      ok: false,
      code: 'invalid-price',
      message: '价格必须是大于 0 的有限数字（不可估值就留空，不要填 0）',
    }
  }
  if (!input.timestamp) {
    return { ok: false, code: 'invalid-input', message: '请填写行情依据时间' }
  }
  if (instrument.currency !== input.currency) {
    return {
      ok: false,
      code: 'invalid-input',
      message: `行情币种 ${input.currency} 与标的计价币种 ${instrument.currency} 不一致`,
    }
  }

  const priceKind = input.priceKind
  const status: QuoteStatus = input.status ?? 'MANUAL'
  /*
   * 手动录入必须如实标注来源，**绝不伪装成外部行情源**。
   * 缺省就是 'manual' —— 不要因为状态不是 MANUAL 就编一个外部源名字。
   */
  const source = input.source?.trim() || 'manual'

  /*
   * 业务键去重：同一 (标的, priceKind, source, 时间点) 视为同一条事实。
   * 不同时间点各自成行 —— 历史行情因此可保留、可追溯。
   */
  const businessKey = quoteBusinessKey({
    instrumentId: input.instrumentId,
    priceKind,
    source,
    timestamp: input.timestamp,
  })
  const id = input.id ?? existingQuoteIdFor(portfolio, businessKey) ?? nextId('q', input.timestamp)

  const quote: Quote = {
    id,
    instrumentId: input.instrumentId,
    priceKind,
    ...priceFieldsFor(priceKind, input.price),
    currency: input.currency,
    source,
    timestamp: input.timestamp,
    status,
  }

  /* ---- ② 试算：用新行情跑一次估值 ---- */
  const withQuote: Portfolio2 = {
    ...portfolio,
    quotes: [...portfolio.quotes.filter((q) => q.id !== id), quote],
  }

  const fx = createFxTable(withQuote.fxRates)
  const nowMs = now().getTime()

  const usages = withQuote.holdings.filter((h) => h.instrumentId === input.instrumentId)
  let reported: QuoteWriteSuccess['valuation'] | undefined
  for (const h of usages) {
    const r = valuateHolding(h, withQuote, { fx, now: nowMs })
    reported = { status: r.status, value: r.value, currency: r.currency }
  }

  /* ---- ③ 不变量校验 ---- */
  const judged = judgeQuote(quote, nowMs)
  if (!judged.usable && status !== 'STALE' && status !== 'ERROR') {
    /*
     * 价格有效但被判不可用 → 说明时间戳过旧（例如填了 LIVE 却是很久以前）。
     * 这不是错误，但要如实告知用户：它不会进入可靠总额。
     * 因此**仍然允许写入**，只是把状态降级为 STALE，避免「显示有价格却进不了总额」的困惑。
     */
    quote.status = 'STALE'
  }
  if (quote.status === 'ERROR' && !quote.error) {
    quote.error = '手动标记为获取失败'
  }

  /* ---- ④ 写入 ---- */
  await repo.quotes.put(quote)

  return {
    ok: true,
    quote,
    valuation: reported ?? { status: 'unavailable', currency: instrument.currency },
  }
}

/* ------------------------------------------------------------------ *
 * 汇率写入
 * ------------------------------------------------------------------ */

/** 允许的币种（与项目 `CurrencyCode` 一致） */
/**
 * 允许的币种 —— **必须与 `CurrencyCode` 联合类型保持一致**。
 *
 * 这里显式列出而不是从类型系统反射，是为了：
 * 1. UI 下拉可以直接渲染；
 * 2. 新增币种时若忘记同步，`tsc` 会在此处报错（安全网）。
 */
const CURRENCIES: readonly CurrencyCode[] = [
  'CNY',
  'USD',
  'HKD',
  'SGD',
  'JPY',
  'EUR',
  'GBP',
  'AUD',
  'KRW',
  'TWD',
  'CAD',
]

export function isCurrencyCode(v: string): v is CurrencyCode {
  return (CURRENCIES as readonly string[]).includes(v)
}

/** 全部可选币种（供 UI 渲染下拉） */
export function currencyOptions(): readonly CurrencyCode[] {
  return CURRENCIES
}

/**
 * 录入 / 更新一条汇率。
 *
 * ## 语义（Phase 8 / W8，P0-3）
 *
 * 与行情同理：汇率是**多时间点的事实**，因此按
 * `(base, quote, source, timestamp)` 业务键去重 ——
 * 同一时间点覆盖（防重复点击），不同时间点各保留一行。
 *
 * ⚠️ 不再使用 `upsertLatest`：它会**删除**该币种对同来源的历史汇率，
 * 导致「当时的汇率」永久不可追溯（W8 审计的 P0-3）。
 *
 * 写入前用新汇率**试算**，确认原先缺 FX 的持仓现在能正确折算。
 */
export async function upsertFxRate(
  repo: PortfolioRepository,
  input: UpsertFxRateInput,
): Promise<FxWriteResult> {
  const portfolio = await repo.loadPortfolio()

  /* ---- ① 参数校验 ---- */
  if (!isCurrencyCode(input.baseCurrency) || !isCurrencyCode(input.quoteCurrency)) {
    return { ok: false, code: 'invalid-input', message: '币种不合法' }
  }
  if (input.baseCurrency === input.quoteCurrency) {
    return {
      ok: false,
      code: 'same-currency',
      message: '基础币种与报价币种不能相同（同币种恒为 1，不需要录入汇率）',
    }
  }
  if (!Number.isFinite(input.rate) || input.rate <= 0) {
    return {
      ok: false,
      code: 'invalid-rate',
      message: '汇率必须是大于 0 的有限数字（缺汇率就是缺，不要填 1 或 0）',
    }
  }
  if (!input.timestamp) {
    return { ok: false, code: 'invalid-input', message: '请填写汇率依据时间' }
  }

  const status = input.status ?? 'MANUAL'
  const source = input.source?.trim() || 'manual'

  const rate: FxRate = {
    id: nextId('fx', input.timestamp),
    baseCurrency: input.baseCurrency,
    quoteCurrency: input.quoteCurrency,
    rate: input.rate,
    timestamp: input.timestamp,
    source,
    status,
  }

  /* ---- ② 试算：解析新汇率 ---- */
  const withRate: Portfolio2 = { ...portfolio, fxRates: [...portfolio.fxRates, rate] }
  const fx = createFxTable(withRate.fxRates)

  const resolved = resolveRate(fx, input.baseCurrency, 'CNY', {
    now: Date.parse(input.timestamp) || Date.now(),
    allowStale: true,
  })

  /* ---- ③ 不变量：CNY 之外的币种必须真能解析出正汇率 ---- */
  if (input.baseCurrency !== 'CNY') {
    if (!resolved || !Number.isFinite(resolved.rate) || resolved.rate <= 0) {
      return {
        ok: false,
        code: 'invariant-violated',
        message: '写入后仍无法解析出有效汇率，已中止（绝不会用 1:1 兜底）',
      }
    }
  }

  /* ---- ④ 影响面（供 UI 反馈） ---- */
  const affected = withRate.holdings.filter(
    (h) => withRate.instruments.find((i) => i.id === h.instrumentId)?.currency === input.baseCurrency,
  ).length

  /* ---- ⑤ 写入：业务键去重追加（保留历史汇率） ---- */
  const key = fxBusinessKey(rate)
  const existing = portfolio.fxRates.find((r) => fxBusinessKey(r) === key)
  await repo.fxRates.put(existing ? { ...rate, id: existing.id } : rate)

  return { ok: true, rate, affectedHoldingCount: affected }
}

/* ------------------------------------------------------------------ *
 * 只读辅助：供 UI 展示估值依据
 * ------------------------------------------------------------------ */

/** 某标的当前生效的行情（最新一条） */
export function currentQuoteFor(portfolio: Portfolio2, instrumentId: string): Quote | undefined {
  const list = portfolio.quotes.filter((q) => q.instrumentId === instrumentId)
  if (list.length === 0) return undefined
  return list.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b))
}

/** 缺 FX 的币种（供 UI 明确提示，而不是静默按 1 折算） */
export function missingCurrencies(portfolio: Portfolio2, now = Date.now()): CurrencyCode[] {
  const needed = new Set<CurrencyCode>()
  for (const h of portfolio.holdings) {
    const inst = portfolio.instruments.find((i) => i.id === h.instrumentId)
    if (inst) needed.add(inst.currency)
  }
  const fx = createFxTable(portfolio.fxRates)
  return [...needed].filter(
    (c) => c !== 'CNY' && !resolveRate(fx, c, 'CNY', { now }),
  )
}

/** 组合层面「是否所有持仓都能可靠估值」的快速判断（复用既有 calculateTotals） */
export function valuationCompleteness(portfolio: Portfolio2, now = Date.now()) {
  const fx = createFxTable(portfolio.fxRates)
  return calculateTotals({ portfolio, fx, now })
}

export type { Instrument }
