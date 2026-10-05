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
  status: Extract<FxStatus, 'LIVE' | 'DELAYED' | 'MANUAL' | 'STALE'>
  /** 拼接路径，便于排查（如 USD->CNY 直接用，或 USD->HKD->CNY 中转） */
  via: string[]
  asOf: string
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

function pick(table: FxTable, base: CurrencyCode, quote: CurrencyCode): UsableFxRate | undefined {
  const candidates = table.rates.filter(
    (r): r is UsableFxRate =>
      r.baseCurrency === base && r.quoteCurrency === quote && isUsableRate(r),
  )
  if (candidates.length === 0) return undefined
  return candidates.reduce((a, b) =>
    new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b,
  )
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

  const finish = (
    rate: number,
    status: ResolvedRate['status'],
    via: string[],
    asOf: string,
  ): ResolvedRate | undefined => {
    // MANUAL 是用户明确设置的手动汇率，不因时间判为过期 —— 必须在时间判定之前短路
    if (status === 'MANUAL') return { rate, status: 'MANUAL', via, asOf }

    const staleMs = options.fxStaleMs ?? FX_RATE_STALE_MS
    const isStale = now - new Date(asOf).getTime() > staleMs
    if (isStale && !options.allowStale) return undefined
    return { rate, status: isStale ? 'STALE' : status, via, asOf }
  }

  // ① 直接
  const direct = pick(table, from, to)
  if (direct) return finish(direct.rate, direct.status, [from, to], direct.timestamp)

  // ② 反向取倒数
  const reverse = pick(table, to, from)
  if (reverse) return finish(1 / reverse.rate, reverse.status, [to, from], reverse.timestamp)

  // ③ 经由 CNY 中转
  if (from !== 'CNY' && to !== 'CNY') {
    const fromCny = pick(table, from, 'CNY') ?? pick(table, 'CNY', from)
    const toCny = pick(table, to, 'CNY') ?? pick(table, 'CNY', to)
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
