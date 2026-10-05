/**
 * FX 汇率模型与换算
 *
 * 与 1.x 的关键差别：
 *
 * 1. **双向换算**：`convert(amount, from, to)`，不再只有 `perCny` 单向。
 * 2. **缺失即 undefined**：不做任何 1:1 兜底（需求第十六条）。
 * 3. **过期有显式状态**：`resolveRate` 返回 `stale` 而不是让调用方自己猜时间。
 *
 * 存储口径：`FxRate` 记录的是「1 base = rate quote」。
 * 由若干条记录构成的汇率表在换算时会尝试：
 *   直接（from→to） → 反向（to→from 取倒数） → 经由 CNY 中转（from→CNY→to）
 * 任意一步缺失，结果就是 undefined —— 不猜、不填 1。
 */

import type { CurrencyCode, FxRate, FxStatus } from '../../types/portfolio2'
import { DEFAULT_QUOTE_POLICY } from './policy'

/**
 * 汇率过期阈值：默认取自 QuotePolicy。
 * 保留此导出仅为兼容；新代码可通过 options 传入自定义策略。
 */
export const FX_RATE_STALE_MS = DEFAULT_QUOTE_POLICY.fxStaleMs

/* ------------------------------------------------------------------ *
 * 汇率表
 * ------------------------------------------------------------------ */

export interface FxTable {
  /** 全部汇率记录 */
  rates: FxRate[]
}

export function createFxTable(rates: FxRate[] = []): FxTable {
  return { rates }
}

export interface ResolvedRate {
  rate: number
  /**
   * 解析出的汇率状态。
   *
   * `SEED` 表示来自用户的兜底种子文件；`MANUAL` 表示用户手填。
   * 两者都不因时间失效（见 `isTimelessFxStatus`）。
   */
  status: Extract<FxStatus, 'LIVE' | 'DELAYED' | 'MANUAL' | 'SEED' | 'STALE'>
  /** 拼接路径，便于排查（如 USD->CNY 直接用，或 USD->HKD->CNY 中转） */
  via: string[]
  asOf: string
}

/**
 * 哪些汇率状态**不因时间失效**。
 *
 * - `MANUAL`：用户在某次操作里手填的汇率，视为长期有效；
 * - `SEED`：用户维护的兜底基准（`public/fx-seed.json`），长期有效。
 *
 * ⚠️ 不能复用行情的 `isTimelessStatus()`：它按 `QuoteStatus` 判定（含 `CLOSED`），
 * 而汇率的过期语义由 `fxStaleMs` 单独决定。两者分开定义，避免互相干扰。
 *
 * 参数用 `ResolvedRate['status']` 而非 `FxStatus`：后者含 `ERROR`，
 * 而 `ERROR` 在 `isUsableRate` 阶段就已被过滤，不会走到这里。
 */
export function isTimelessFxStatus(status: ResolvedRate['status']): boolean {
  return status === 'MANUAL' || status === 'SEED'
}

/**
 * 记录是否可作为汇率使用。
 * 排除 ERROR（获取失败的记录不参与换算）与自反币种对。
 */
function isUsableRate(r: FxRate): boolean {
  return (
    r.status !== 'ERROR' &&
    Number.isFinite(r.rate) &&
    r.rate > 0 &&
    r.baseCurrency !== r.quoteCurrency
  )
}

/** 取「该币种对」在给定方向下最新的可用记录 */
/** 仅取「可参与换算」的记录，类型上排除 ERROR */
type UsableFxRate = FxRate & { status: Exclude<FxStatus, 'ERROR'> }

function pick(
  table: FxTable,
  base: CurrencyCode,
  quote: CurrencyCode,
  isStale: (r: UsableFxRate) => boolean,
): UsableFxRate | undefined {
  const candidates = table.rates.filter(
    (r): r is UsableFxRate =>
      r.baseCurrency === base && r.quoteCurrency === quote && isUsableRate(r),
  )
  if (candidates.length === 0) return undefined
  return candidates.reduce((a, b) => (chooseBetter(a, b, isStale) === a ? a : b))
}

/**
 * 同一币种对有多条记录时，谁更该被选中。
 *
 * ## 为什么不能只按时间戳
 *
 * 汇率表里**同时存在多个来源**（自动拉取 / 用户的兜底种子 / 手填）。
 * 若只取「时间戳最大」，会出现一个坏结果：
 * 一条 3 天前拉取的实时汇率会**压住用户今天维护的兜底值** ——
 * 于是自动拉取失败时兜底汇率反而不生效，该持仓继续显示「不可估值」。
 *
 * ## 规则：状态优先级优先，同优先级再比时间
 *
 * | 优先级 | 状态 | 含义 |
 * | --- | --- | --- |
 * | 0 | `LIVE` | 自动拉取，最新鲜 |
 * | 1 | `DELAYED` | 延迟的自动拉取 |
 * | 2 | `SEED` | 用户兜底基准 |
 * | 3 | `MANUAL` | 用户手填 |
 * | 9 | `STALE` | 已过期，最后才用 |
 *
 * ⚠️ 这是**有意为之**的取用顺序，不是「谁新谁赢」。
 * 改动它会让「自动优先 + 失败回落兜底」的整体设计失效。
 */
function rateStatusRank(status: FxStatus): number {
  switch (status) {
    case 'LIVE':
      return 0
    case 'DELAYED':
      return 1
    case 'SEED':
      return 2
    case 'MANUAL':
      return 3
    default:
      // 'STALE'
      return 9
  }
}

function chooseBetter(
  a: UsableFxRate,
  b: UsableFxRate,
  isStale: (r: UsableFxRate) => boolean,
): UsableFxRate {
  /*
   * ⚠️ **顺序很重要：先比「是否过期」，再比状态优先级。**
   *
   * 若先比状态优先级，会出现一个错误结果：
   * 一条已过期的 `LIVE`（排名 0）会**压住**不过期的 `SEED`（排名 2）——
   * 而新鲜度要到 `finish()` 才判定，于是 pick 先把过期 LIVE 挑走，
   * finish 再把它判为过期，最终**连兜底值都用不上**，持仓显示「不可估值」。
   *
   * 「自动拉取失败 → 回落兜底」必须成立，所以新鲜度优先。
   * 「不因时间失效」的状态（MANUAL / SEED）永远算新鲜。
   */
  const sa = isTimelessFxStatus(a.status) ? false : isStale(a)
  const sb = isTimelessFxStatus(b.status) ? false : isStale(b)
  if (sa !== sb) return sa ? b : a

  const ra = rateStatusRank(a.status)
  const rb = rateStatusRank(b.status)
  if (ra !== rb) return ra < rb ? a : b
  return new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b
}

/**
 * 解析 from→to 的汇率。
 *
 * 返回 `undefined` 表示**没有可用汇率**——调用方必须据此标记 unavailable，
 * 不允许退化成 1:1。
 *
 * @param allowStale 为 true 时也接受过期汇率，但 status 会标为 'STALE'
 */
export function resolveRate(
  table: FxTable,
  from: CurrencyCode,
  to: CurrencyCode,
  options: { now?: number; allowStale?: boolean; fxStaleMs?: number } = {},
): ResolvedRate | undefined {
  if (from === to) {
    return { rate: 1, status: 'LIVE', via: [from], asOf: new Date(options.now ?? Date.now()).toISOString() }
  }
  const now = options.now ?? Date.now()
  const staleMsForPick = options.fxStaleMs ?? FX_RATE_STALE_MS
  /** 供 `pick` 的候选比较使用（「不因时间失效」的状态已在 chooseBetter 里豁免） */
  const isStaleRate = (r: UsableFxRate): boolean =>
    now - new Date(r.timestamp).getTime() > staleMsForPick

  const finish = (
    rate: number,
    status: ResolvedRate['status'],
    via: string[],
    asOf: string,
  ): ResolvedRate | undefined => {
    /*
     * 不因时间失效的状态（手填 / 兜底种子）必须在时间判定**之前**短路。
     *
     * 这正是「自动拉取失败就用兜底值」能生效的地方：
     * 种子汇率哪怕是一年前填的也仍然可用，不会退化成「不可估值」。
     */
    if (isTimelessFxStatus(status)) return { rate, status, via, asOf }

    const staleMs = options.fxStaleMs ?? FX_RATE_STALE_MS
    const isStale = now - new Date(asOf).getTime() > staleMs
    if (isStale && !options.allowStale) return undefined
    return { rate, status: isStale ? 'STALE' : status, via, asOf }
  }

  // ① 直接
  const direct = pick(table, from, to, isStaleRate)
  if (direct) return finish(direct.rate, direct.status, [from, to], direct.timestamp)

  // ② 反向取倒数
  const reverse = pick(table, to, from, isStaleRate)
  if (reverse) return finish(1 / reverse.rate, reverse.status, [to, from], reverse.timestamp)

  // ③ 经由 CNY 中转
  if (from !== 'CNY' && to !== 'CNY') {
    const fromCny = pick(table, from, 'CNY', isStaleRate) ?? pick(table, 'CNY', from, isStaleRate)
    const toCny = pick(table, to, 'CNY', isStaleRate) ?? pick(table, 'CNY', to, isStaleRate)
    if (fromCny && toCny) {
      const rateFrom = fromCny.baseCurrency === from ? fromCny.rate : 1 / fromCny.rate
      const rateTo = toCny.baseCurrency === to ? toCny.rate : 1 / toCny.rate
      if (rateFrom > 0 && rateTo > 0) {
        // from→CNY→to ：先乘 rateFrom 得到 CNY，再除以 rateTo
        const viaRate = rateFrom / rateTo
        const older = [fromCny, toCny].reduce((a, b) =>
          new Date(a.timestamp).getTime() <= new Date(b.timestamp).getTime() ? a : b,
        )
        const statuses = [fromCny.status, toCny.status]
        const status = statuses.includes('MANUAL') ? 'MANUAL' : older.status
        return finish(viaRate, status, [from, 'CNY', to], older.timestamp)
      }
    }
  }

  return undefined
}

/* ------------------------------------------------------------------ *
 * 换算
 * ------------------------------------------------------------------ */

export interface ConvertOk {
  ok: true
  amount: number
  rate: ResolvedRate
}
export interface ConvertFail {
  ok: false
  /** 失败原因：缺少汇率，或汇率已过期且未被允许 */
  reason: 'missing_fx' | 'stale_fx'
}
export type ConvertResult = ConvertOk | ConvertFail

/**
 * 金额换算。
 *
 * **不变量**：缺少汇率时返回 `{ ok: false, reason: 'missing_fx' }`，
 * **不会**返回原金额，也不会返回 0。
 * （1.x 的 `toCny` 返回 undefined 也正确，但这里额外区分「缺失」与「过期」。）
 */
export function convert(
  amount: number,
  from: CurrencyCode,
  to: CurrencyCode,
  table: FxTable,
  options: { now?: number; allowStale?: boolean; fxStaleMs?: number } = {},
): ConvertResult {
  if (!Number.isFinite(amount)) return { ok: false, reason: 'missing_fx' }
  if (from === to) {
    return {
      ok: true,
      amount,
      rate: {
        rate: 1,
        status: 'LIVE',
        via: [from],
        asOf: new Date(options.now ?? Date.now()).toISOString(),
      },
    }
  }

  // 先尝试不允许过期；失败后再判断是否因为过期而失败（用于区分 missing / stale）
  const fresh = resolveRate(table, from, to, options)
  if (fresh) return { ok: true, amount: amount * fresh.rate, rate: fresh }

  const stale = resolveRate(table, from, to, { now: options.now, allowStale: true })
  if (stale) return { ok: false, reason: 'stale_fx' }
  return { ok: false, reason: 'missing_fx' }
}

/** 便捷包装：只要数字，失败返回 undefined（绝不返回 0 或原值） */
export function convertToCny(
  amount: number,
  from: CurrencyCode,
  table: FxTable,
  options: { now?: number; allowStale?: boolean; fxStaleMs?: number } = {},
): number | undefined {
  const r = convert(amount, from, 'CNY', table, options)
  return r.ok ? r.amount : undefined
}

/** 由现有汇率表推导：某币种对 CNY 是否可用（供 UI 提示缺哪个币种） */
export function missingCurrencyForCny(
  table: FxTable,
  currencies: CurrencyCode[],
  options: { now?: number } = {},
): CurrencyCode[] {
  return currencies.filter((c) => c !== 'CNY' && !resolveRate(table, c, 'CNY', options))
}
