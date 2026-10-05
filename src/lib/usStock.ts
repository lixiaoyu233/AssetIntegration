/**
 * 美股 / 港股行情（腾讯行情接口）
 *
 * 为什么用它：需求里的天天基金接口只覆盖境内场外基金（6 位数字代码），
 * 而 QQQ / SPY 这类美股 ETF 是字母代码、港股是 5 位数字，必须另找数据源。
 *
 * 实测（2026-10）：
 * - `https://qt.gtimg.cn/q=usSPY`      → 200，且 `Access-Control-Allow-Origin: *`，浏览器可直连
 * - `https://qt.gtimg.cn/q=hk00700`    → 200，同样带 CORS
 * - 返回体是 JS 赋值语句，且为 **GBK** 编码，需要按 GBK 解码后再解析
 * - 支持一次批量查询（`q=usSPY,usQQQ,hk00700`）
 * - 无效代码返回 `v_pv_none_match="1";`，不会报错，需自行识别
 * - 新浪 `hq.sinajs.cn` 无 CORS，浏览器直连会被拦，故不采用
 *
 * 字段索引（美股与港股完全一致，已逐项核对）：
 *   [1] 名称  [2] 代码  [3] 现价  [4] 昨收  [5] 今开
 *   [30] 行情时间  [31] 涨跌额  [32] 涨跌幅(%)  [33] 最高  [34] 最低
 */

import type { FundQuote } from '../types/asset'

/** 需要走腾讯行情接口的市场 */
export type StockMarket = 'us' | 'hk'

/** 持仓市场的完整取值：境内基金 + 美股 + 港股 */
export type HoldingMarket = 'cn' | StockMarket

export const STOCK_MARKET_LABEL: Record<StockMarket, string> = {
  us: '美股',
  hk: '港股',
}

export const HOLDING_MARKET_LABEL: Record<HoldingMarket, string> = {
  cn: '境内基金',
  us: '美股',
  hk: '港股',
}

/** 各市场的计价币种 */
export const HOLDING_MARKET_CURRENCY: Record<HoldingMarket, 'CNY' | 'USD' | 'HKD'> = {
  cn: 'CNY',
  us: 'USD',
  hk: 'HKD',
}

/** 该市场的计价币种：美股 USD、港股 HKD（由此接入已有的汇率折算） */
export const STOCK_MARKET_CURRENCY: Record<StockMarket, 'USD' | 'HKD'> = {
  us: 'USD',
  hk: 'HKD',
}

export const TENCENT_QUOTE_ENDPOINT = 'https://qt.gtimg.cn/q='

/* ------------------------------------------------------------------ *
 * 代码校验
 * ------------------------------------------------------------------ */

/**
 * 美股代码：1~6 位字母，可带 `.` 或 `-`（如 BRK.B、BF-B）。
 * 港股代码：5 位数字（如 00700），也接受用户输入的 700（自动补零）。
 */
export function isUsTicker(code: string): boolean {
  return /^[A-Z]{1,6}([.-][A-Z])?$/.test(code.trim().toUpperCase())
}

export function isHkTicker(code: string): boolean {
  const c = code.trim()
  return /^\d{1,5}$/.test(c)
}

/** 把用户输入的港股代码补成 5 位，如 700 -> 00700 */
export function normalizeHkCode(code: string): string {
  const digits = code.replace(/\D/g, '')
  return digits.padStart(5, '0').slice(-5)
}

/** 推断代码属于哪个市场；无法判断返回 null */
export function detectStockMarket(code: string): StockMarket | null {
  const c = code.trim()
  if (!c) return null
  if (isHkTicker(c)) return 'hk'
  if (isUsTicker(c)) return 'us'
  return null
}

/** 规范化为腾讯接口的查询符号，如 SPY -> usSPY、700 -> hk00700 */
export function toTencentSymbol(code: string, market: StockMarket): string {
  return market === 'us' ? `us${code.trim().toUpperCase()}` : `hk${normalizeHkCode(code)}`
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v.replace(/,/g, '').trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 涨跌幅字段是「百分数」形式（0.74 表示 +0.74%），统一换算成小数 */
function rate(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number(v.trim())
  return Number.isFinite(n) ? n / 100 : undefined
}

/** 腾讯的时间格式：美股 `2026-10-02 16:00:01`，港股 `2026/10/02 16:08:10` */
function normalizeTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const s = raw.trim().replace(/\//g, '-')
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : undefined
}

/**
 * 解析腾讯返回的脚本文本。
 * @param text 已按 GBK 解码为字符串的响应体
 * @param market 该批代码所属市场
 */
export function parseTencentQuotes(text: string, market: StockMarket): FundQuote[] {
  const now = Date.now()
  const currency = STOCK_MARKET_CURRENCY[market]
  const out: FundQuote[] = []

  for (const line of text.split('\n')) {
    const m = line.match(/v_(us|hk)([A-Za-z0-9.\-]+)\s*=\s*"([^"]*)"/)
    if (!m) continue
    const parts = m[3].split('~')
    if (parts.length < 35) continue

    const code = m[2].toUpperCase()
    const name = (parts[1] || code).trim()
    const price = num(parts[3])
    if (!price) continue

    out.push({
      code,
      name,
      // 美股/港股取到的是实时成交价，作为「当前价」使用（与基金的估算净值同义）
      estimatedNav: price,
      estimatedRate: rate(parts[32]),
      estimatedAt: normalizeTime(parts[30]),
      // 昨收作为参考，便于未来算日内涨跌
      publishedNav: num(parts[4]),
      fetchedAt: now,
      source: market === 'us' ? 'tencent-us' : 'tencent-hk',
      market,
      currency,
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

/** 腾讯接口返回 GBK，必须按 GBK 解码，否则中文名称会乱码 */
export async function decodeTencentResponse(res: Response): Promise<string> {
  const buf = await res.arrayBuffer()
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    // 极少数环境不支持 gbk 解码器时退回 utf-8，至少价格可用
    return new TextDecoder('utf-8').decode(buf)
  }
}

export function buildTencentUrl(codes: string[], market: StockMarket): string {
  const symbols = codes.map((c) => toTencentSymbol(c, market)).join(',')
  return `${TENCENT_QUOTE_ENDPOINT}${symbols}&_=${Date.now()}`
}

export async function fetchTencentQuotes(
  codes: string[],
  market: StockMarket,
  timeout = 12_000,
): Promise<FundQuote[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(buildTencentUrl(codes, market), {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await decodeTencentResponse(res)
    const quotes = parseTencentQuotes(text, market)
    if (quotes.length === 0) throw new Error('未返回匹配的行情（代码可能不存在）')
    return quotes
  } finally {
    clearTimeout(timer)
  }
}
