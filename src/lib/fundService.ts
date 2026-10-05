/**
 * 基金行情服务
 *
 * ⚠️ 重要调研结论（2026-10 实测，见 README「接口说明」）：
 * 需求中给出的 `https://fundgz.1234567.com.cn/js/{code}.js?rt=...` 那个 JSONP 接口
 * **已经下线**，现在返回东方财富的「页面未找到」HTML，解析不到任何数据。
 *
 * 因此这里实现了「多通道自动降级」，按顺序尝试，任一通道成功即返回：
 *
 *   1. fundmobapi（fetch，CORS 已开启）—— 天天基金 App 接口，批量、最稳
 *        https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?...&Fcodes=161725,000001
 *   2. push2 JSONP（cb=）—— 东方财富行情接口，返回场内实时价与涨跌幅
 *        https://push2.eastmoney.com/api/qt/ulist.np/get?secids=...&cb=...
 *   3. fundgz JSONP（历史接口，保留以便接口恢复后自动启用）
 *        https://fundgz.1234567.com.cn/js/{code}.js?rt=...
 */

import { JsonpError, jsonp } from './jsonp'
import type { FundQuote } from '../types/asset'
import {
  detectStockMarket,
  fetchTencentQuotes,
  type StockMarket,
} from './usStock'

export interface FundQuoteResult {
  quote: FundQuote
  /** 实际命中的通道 */
  source: QuoteSource
}

export type QuoteSource = 'fundmobapi' | 'fundmobapiJsonp' | 'push2' | 'fundgz' | 'tencent'

export interface FundServiceOptions {
  /** 为 true 时把 JSONP 通道放在最前（默认先用 CORS fetch） */
  preferJsonp?: boolean
  /** 单次请求超时（毫秒） */
  timeout?: number
  /** 允许的通道白名单，默认全部启用 */
  providers?: QuoteSource[]
}

const ENDPOINTS = {
  fundmobapi: 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo',
  push2: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
  fundgz: 'https://fundgz.1234567.com.cn/js',
} as const

export class FundServiceError extends Error {
  constructor(
    message: string,
    readonly attempts: Array<{ source: QuoteSource; error: string }> = [],
  ) {
    super(message)
    this.name = 'FundServiceError'
  }
}

/** 把内部通道名换成用户能看懂的说法，细节仍留在 attempts 里供排查 */
function friendlyMessage(attempts: Array<{ source: QuoteSource; error: string }>): string {
  const hasNotFound = attempts.some((a) => /未返回匹配|不存在|未找到/.test(a.error))
  if (hasNotFound) return '未查到该代码的行情，可能代码不存在；可手动填写当前净值后保存'
  return '行情数据源暂时不可用，可先保存，稍后刷新或手动填写当前净值'
}

/* ------------------------------------------------------------------ *
 * 解析工具
 * ------------------------------------------------------------------ */

const isCode = (v: unknown): v is string => typeof v === 'string' && /^\d{6}$/.test(v)

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** 把任意形式的涨跌幅统一成小数：2.12(%) -> 0.0212 */
function toRate(v: unknown): number | undefined {
  const n = num(v)
  if (n === undefined) return undefined
  return n / 100
}

function trimCode(v: unknown): string {
  const s = String(v ?? '').trim()
  const m = s.match(/\d{6}/)
  return m ? m[0] : ''
}

/** 从 "2026-10-03 14:30" 这类字符串里取出合法日期，非法则丢弃 */
function safeDateStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s || s === '--' || /^0+[-: ]?0*/.test(s)) return undefined
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : undefined
}

/* ------------------------------------------------------------------ *
 * 通道 1：fundmobapi（fetch + CORS）
 * ------------------------------------------------------------------ */

interface FundMobRow {
  FCODE?: string
  SHORTNAME?: string
  NAV?: string | number
  NAVCHGRT?: string | number
  GSZ?: string | number | null
  GSZZL?: string | number | null
  GZTIME?: string | null
  PDATE?: string
}

export function parseFundMobBatch(payload: unknown): FundQuote[] {
  const root = payload as { Datas?: unknown; ErrCode?: number; ErrMsg?: string } | null
  if (!root || !Array.isArray(root.Datas)) {
    throw new Error(root?.ErrMsg || '接口未返回 Datas 字段')
  }
  const now = Date.now()
  return (root.Datas as FundMobRow[])
    .map((row) => {
      const code = trimCode(row.FCODE)
      if (!isCode(code)) return null
      const quote: FundQuote = {
        code,
        name: typeof row.SHORTNAME === 'string' ? row.SHORTNAME : code,
        estimatedNav: num(row.GSZ) && num(row.GSZ)! > 0 ? num(row.GSZ) : undefined,
        estimatedRate: toRate(row.GSZZL),
        estimatedAt: safeDateStr(row.GZTIME),
        publishedNav: num(row.NAV) && num(row.NAV)! > 0 ? num(row.NAV) : undefined,
        publishedRate: toRate(row.NAVCHGRT),
        publishedAt: safeDateStr(row.PDATE),
        fetchedAt: now,
        source: 'fundmobapi',
        market: 'cn',
        currency: 'CNY',
      }
      if (!quote.publishedNav && !quote.estimatedNav) return null
      return quote
    })
    .filter((q): q is FundQuote => q !== null)
}

export function buildFundMobUrl(codes: string[], base = ENDPOINTS.fundmobapi, callback?: string): string {
  const params = new URLSearchParams({
    pageIndex: '1',
    pageSize: String(Math.max(codes.length, 1)),
    plat: 'Android',
    appType: 'ttjj',
    product: 'EFund',
    Version: '1',
    deviceid: 'asset-card-wallet',
    Fcodes: codes.join(','),
    _: String(Date.now()),
  })
  // 该接口同时支持 JSONP（callback=），用于 fetch 被网络策略拦掉时的兜底
  if (callback) params.set('callback', callback)
  return `${base}?${params.toString()}`
}

async function fetchViaFundMobApi(codes: string[], timeout: number): Promise<FundQuote[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(buildFundMobUrl(codes), {
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
      // 该接口返回 `Access-Control-Allow-Origin: *`，无需携带凭据
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const quotes = parseFundMobBatch(JSON.parse(text))
    return quotes
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 通道 1b：fundmobapi JSONP（同一个接口，用 <script> 绕开可能存在的 fetch 拦截）
 * ------------------------------------------------------------------ */

/**
 * 注意：这里**不要**自己往 URL 里塞 callback 参数，
 * jsonp() 会用 callbackKey 自动追加唯一回调名；重复会出现
 * `callback=__acw_cb&callback=__acw_xxx`，服务端返回两个调用导致 `__acw_cb is not defined`。
 */
async function fetchViaFundMobJsonp(codes: string[], timeout: number): Promise<FundQuote[]> {
  const payload = await jsonp(buildFundMobUrl(codes), {
    callbackKey: 'callback',
    timeout,
    prefix: '__acw_fundmob',
  })
  return parseFundMobBatch(payload)
}

/* ------------------------------------------------------------------ *
 * 通道 2：push2 JSONP（场内实时价）
 * ------------------------------------------------------------------ */

interface Push2Row {
  f2?: number
  f3?: number
  f12?: string
  f13?: number
  f14?: string
}

/**
 * 交易所前缀推断：场内基金 / LOF / ETF 代码首位决定交易所。
 * 5 开头 -> 上交所(1)，1 / 0 / 3 开头 -> 深交所(0)，其他按深市兜底。
 */
export function exchangePrefix(code: string): '0' | '1' {
  return code.startsWith('5') ? '1' : '0'
}

/**
 * 解析 push2 行情。
 * 请求时带了 `fltt=2`，该接口会把价格直接返回成元（如 0.529），涨跌幅返回成百分数（如 2.12）。
 * 因此这里只需把百分数换算成小数，不要再除以 100。
 * （若去掉 fltt=2，价格会变成「分」，涨跌幅放大 100 倍，需要另外缩放。）
 */
export function parsePush2Batch(payload: unknown): FundQuote[] {
  const root = payload as { data?: { diff?: unknown } } | null
  const diff = root?.data?.diff
  if (!Array.isArray(diff)) throw new Error('接口未返回行情列表')
  const now = Date.now()
  return (diff as Push2Row[])
    .map((row) => {
      const code = trimCode(row.f12)
      if (!isCode(code)) return null
      const price = num(row.f2)
      const rate = num(row.f3)
      const quote: FundQuote = {
        code,
        name: typeof row.f14 === 'string' ? row.f14 : code,
        // push2 返回的是二级市场交易价，作为盘中「估算净值」使用
        estimatedNav: price && price > 0 ? price : undefined,
        estimatedRate: rate !== undefined ? rate / 100 : undefined,
        estimatedAt: new Date(now).toISOString().slice(0, 16).replace('T', ' '),
        fetchedAt: now,
        source: 'push2',
      }
      if (!quote.estimatedNav) return null
      return quote
    })
    .filter((q): q is FundQuote => q !== null)
}

export function buildPush2Url(codes: string[]): string {
  const secids = codes.map((c) => `${exchangePrefix(c)}.${c}`).join(',')
  return `${ENDPOINTS.push2}?fltt=2&secids=${secids}&fields=f2,f3,f12,f13,f14&_=${Date.now()}`
}

async function fetchViaPush2Jsonp(codes: string[], timeout: number): Promise<FundQuote[]> {
  const payload = await jsonp(buildPush2Url(codes), { callbackKey: 'cb', timeout, prefix: '__acw_push2' })
  return parsePush2Batch(payload)
}

/* ------------------------------------------------------------------ *
 * 通道 3：fundgz（历史 JSONP 接口，保留兼容）
 * ------------------------------------------------------------------ */

interface FundGzPayload {
  fundcode?: string
  name?: string
  jzrq?: string
  dwjz?: string
  gsz?: string
  gszzl?: string
  gztime?: string
}

/** 解析 `jsonpgz({"fundcode":...});` 形态的脚本内容 */
export function parseFundGzResponse(text: string): FundGzPayload | null {
  const m = text.match(/jsonpgz\s*\(\s*(\{[\s\S]*?\})\s*\)/)
  if (!m) return null
  try {
    return JSON.parse(m[1]) as FundGzPayload
  } catch {
    return null
  }
}

export function fundGzToQuote(payload: FundGzPayload): FundQuote | null {
  const code = trimCode(payload.fundcode)
  if (!isCode(code)) return null
  const quote: FundQuote = {
    code,
    name: payload.name || code,
    estimatedNav: num(payload.gsz) && num(payload.gsz)! > 0 ? num(payload.gsz) : undefined,
    estimatedRate: toRate(payload.gszzl),
    estimatedAt: safeDateStr(payload.gztime),
    publishedNav: num(payload.dwjz) && num(payload.dwjz)! > 0 ? num(payload.dwjz) : undefined,
    publishedAt: safeDateStr(payload.jzrq),
    fetchedAt: Date.now(),
    source: 'fundgz',
  }
  if (!quote.publishedNav && !quote.estimatedNav) return null
  return quote
}

async function fetchViaFundGzJsonp(code: string, timeout: number): Promise<FundQuote[]> {
  const payload = await jsonp<FundGzPayload>(`${ENDPOINTS.fundgz}/${code}.js`, {
    callbackKey: 'callback',
    timeout,
    prefix: '__acw_fundgz',
    params: { rt: Date.now() },
  })
  const quote = fundGzToQuote(payload)
  if (!quote) throw new Error('返回数据缺少有效净值')
  return [quote]
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

/**
 * 默认通道顺序：
 * 1. fundmobapi（fetch + CORS）   —— 最快、可批量
 * 2. fundmobapiJsonp            —— 同源数据，fetch 被拦时的可靠 JSONP 兜底
 * 3. push2（JSONP）             —— 场内实时价
 * 4. fundgz（JSONP）            —— 历史接口，已下线，保留以便恢复后自动启用
 */
const DEFAULT_ORDER: QuoteSource[] = ['fundmobapi', 'fundmobapiJsonp', 'push2', 'fundgz']

/** preferJsonp = true 时的顺序：纯 JSONP 通道优先，fetch 放最后 */
const JSONP_FIRST_ORDER: QuoteSource[] = ['fundmobapiJsonp', 'push2', 'fundgz', 'fundmobapi']

/**
 * 批量拉取基金行情（自动多通道降级）。
 * 返回命中通道的行情；全部通道失败时抛 FundServiceError，并带上每通道的失败原因。
 */
export async function fetchFundQuotes(
  codes: string[],
  options: FundServiceOptions = {},
): Promise<Map<string, FundQuoteResult>> {
  const { timeout = 12_000, preferJsonp = false } = options
  const all = [...new Set(codes.map((c) => c.trim()).filter(Boolean))]

  // 境内基金（6 位数字）走天天基金；美股/港股代码走腾讯行情
  const wanted = all.filter(isCode)
  const stockCodes = all.filter((c) => !isCode(c) && detectStockMarket(c) !== null)

  const result = new Map<string, FundQuoteResult>()

  // 先把美股/港股取回来（含各自市场），失败的记入 attempts
  const stockAttempts: Array<{ source: QuoteSource; error: string }> = []
  if (stockCodes.length > 0) {
    const groups: Record<StockMarket, string[]> = { us: [], hk: [] }
    for (const c of stockCodes) {
      const m = detectStockMarket(c)
      if (m) groups[m].push(c)
    }
    for (const market of ['us', 'hk'] as StockMarket[]) {
      if (groups[market].length === 0) continue
      try {
        const quotes = await fetchTencentQuotes(groups[market], market, timeout)
        for (const q of quotes) result.set(q.code, { quote: q, source: 'tencent' })
      } catch (e) {
        stockAttempts.push({ source: 'tencent', error: `${market}: ${describeError(e)}` })
      }
    }
  }

  if (wanted.length === 0) {
    if (result.size === 0 && stockAttempts.length > 0) {
      throw new FundServiceError(friendlyMessage(stockAttempts), stockAttempts)
    }
    return result
  }

  const order = options.providers ?? (preferJsonp ? JSONP_FIRST_ORDER : DEFAULT_ORDER)
  const attempts: Array<{ source: QuoteSource; error: string }> = [...stockAttempts]
  let remaining = wanted

  for (const source of order) {
    if (remaining.length === 0) break
    try {
      let quotes: FundQuote[] = []
      if (source === 'fundgz') {
        // fundgz 只支持单代码，逐个请求
        const settled = await Promise.all(
          remaining.map(async (code) => {
            try {
              const list = await fetchViaFundGzJsonp(code, timeout)
              return list[0] ?? null
            } catch {
              return null
            }
          }),
        )
        quotes = settled.filter((q): q is FundQuote => q !== null)
      } else if (source === 'push2') {
        quotes = await fetchViaPush2Jsonp(remaining, timeout)
      } else if (source === 'fundmobapiJsonp') {
        quotes = await fetchViaFundMobJsonp(remaining, timeout)
      } else {
        quotes = await fetchViaFundMobApi(remaining, timeout)
      }

      for (const q of quotes) {
        if (!result.has(q.code)) result.set(q.code, { quote: q, source })
      }
      const covered = new Set([...result.keys()])
      const next = wanted.filter((c) => !covered.has(c))
      // 若某通道一个都没拿到，记为一次失败，继续降级
      if (quotes.length === 0) attempts.push({ source, error: '未返回匹配的基金数据' })
      remaining = next
    } catch (e) {
      attempts.push({ source, error: describeError(e) })
    }
  }

  if (result.size === 0) {
    throw new FundServiceError(friendlyMessage(attempts), attempts)
  }
  return result
}

/** 单只基金行情（内部走批量通道） */
export async function fetchFundQuote(code: string, options?: FundServiceOptions): Promise<FundQuoteResult> {
  const map = await fetchFundQuotes([code], options)
  const hit = map.get(trimCode(code))
  if (!hit) throw new FundServiceError(`未找到基金 ${code} 的行情数据`)
  return hit
}

function describeError(e: unknown): string {
  if (e instanceof JsonpError) return e.message
  if (e instanceof DOMException && e.name === 'AbortError') return '请求超时'
  if (e instanceof Error) return e.message
  return String(e)
}

export const FUND_ENDPOINTS = ENDPOINTS
