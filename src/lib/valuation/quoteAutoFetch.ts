/**
 * 行情自动获取（Phase 8+ / 双版本并存后的新增能力）
 *
 * ## 背景
 *
 * 2.0 早期（W6）行情只做手动录入 —— 当时 `quotes` 的写入调用数是 0。
 * 本模块补上自动获取，沿用 1.0 已验证的代码格式约定与数据源。
 *
 * ## 路由表（按 `instrumentType`，已与用户确认）
 *
 * | `instrumentType` | 数据源 | 价格字段 | `priceKind` |
 * | --- | --- | --- | --- |
 * | `fund`（场外基金） | `fundmobapi.eastmoney.com` | `NAV` 单位净值 | `nav` |
 * | `stock` / `etf`（含境内 sh/sz） | `qt.gtimg.cn` | 现价 | `market_price` |
 * | 其它（bond / gold / crypto …） | 不自动获取，保持手动 | — | — |
 *
 * ## 代码格式约定（沿用 1.0，用户已习惯）
 *
 * ```
 * 6 位数字    → 境内（场外基金 161725 / 场内 510300、600519）
 * 1~6 位字母   → 美股（SPY、QQQ、BRK.B）
 * 1~5 位数字   → 港股（700 → 自动补成 00700）
 * ```
 *
 * ⚠️ **格式只用来决定「去哪个接口取数」，不用来决定「这是什么资产」。**
 * 资产类别（equity / bond / …）在 2.0 里始终由用户明确选择
 * （见 `creation.ts` 的「不自动分类」硬约束）。两者是不同层面的事：
 * 前者是传输层寻址，后者是语义分类。
 *
 * ## 兜底策略：**不做种子文件**
 *
 * 汇率做了 `public/fx-seed.json`（10 个币种、一天一变，值得手维护）。
 * 行情**不能照搬**：你有多少标的就有多少条、且交易时段内分钟级变化，
 * 手工维护必然过期。
 *
 * 行情的兜底由**数据库自身**承担：`quotes` 是带时间戳的时间序列，
 * 拉取成功的记录会留在库里，网络失败时 `policy.ts` 自动把它降级为
 * `STALE`，引擎给出「仅供展示」的过期价（`staleDisplayValueCny`）。
 * → 零维护、自动兜底。
 *
 * ## 刷新时机（已与用户确认）
 *
 * **只在「打开应用」和「用户点更新」时拉取，不做定时轮询。**
 * 行情不像汇率那样需要定时刷新，用户主动触发即可，也更省流量。
 *
 * ## 想改的时候
 *
 * - 加数据源 / 改路由 → 改下方 `QUOTE_ROUTES`
 * - 改代码格式约定 → 改 `detectCodeKind`
 * - 换兜底策略 → 见上文注释，慎重（行情不适合静态种子）
 */
import type {
  CurrencyCode,
  Instrument,
  Portfolio2,
  PriceKind,
  Quote,
  QuoteStatus,
} from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { DEFAULT_QUOTE_POLICY } from './policy'

/* ------------------------------------------------------------------ *
 * 可调参数
 * ------------------------------------------------------------------ */

/** 单次请求超时（毫秒） */
export const QUOTE_FETCH_TIMEOUT_MS = 10_000

/** 场外基金净值接口（支持批量 `Fcodes=a,b,c`，CORS 已开启） */
const FUND_NAV_ENDPOINT = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo'

/** 腾讯行情接口（美股 / 港股 / 境内场内，CORS 已开启，**GBK 编码**） */
const TENCENT_ENDPOINT = 'https://qt.gtimg.cn/q='

/* ------------------------------------------------------------------ *
 * 代码格式约定（1.0 已在用，用户已习惯）
 * ------------------------------------------------------------------ */

export type CodeKind = 'us' | 'hk' | 'cn'

export function isUsTicker(code: string): boolean {
  return /^[A-Z]{1,6}([.-][A-Z])?$/.test(code.trim().toUpperCase())
}

export function isNumericCode(code: string): boolean {
  return /^\d{1,6}$/.test(code.trim())
}

/** 把港股代码补成 5 位（700 → 00700） */
export function normalizeHkCode(code: string): string {
  const digits = code.replace(/\D/g, '')
  return digits.padStart(5, '0').slice(-5)
}

/**
 * 按格式推断代码属于哪一类。
 *
 * ⚠️ 只用于**选接口**，不用于资产分类。
 */
export function detectCodeKind(code: string): CodeKind | null {
  const c = code.trim()
  if (!c) return null
  // 纯数字：6 位是境内基金/股票；1~5 位按港股处理（补零）
  if (isNumericCode(c)) return c.length === 6 ? 'cn' : 'hk'
  if (isUsTicker(c)) return 'us'
  return null
}

/**
 * 构造腾讯查询符号。
 *
 * - 美股：`usSPY`
 * - 港股：`hk00700`
 * - 境内：按首位判断交易所 —— `6`/`5` → `sh`，`0`/`3`/`1` → `sz`
 */
export function toTencentSymbol(code: string, kind: CodeKind): string | null {
  const c = code.trim().toUpperCase()
  if (kind === 'us') return `us${c}`
  if (kind === 'hk') return `hk${normalizeHkCode(c)}`
  // 境内
  const digits = c.replace(/\D/g, '')
  if (digits.length !== 6) return null
  const first = digits[0]
  if (first === '6' || first === '5' || first === '9') return `sh${digits}`
  if (first === '0' || first === '1' || first === '2' || first === '3') return `sz${digits}`
  return null
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * 腾讯行情时间格式有三种，先统一归一化成「墙钟时间」（`YYYY-MM-DDTHH:mm:ss`）：
 * - 美股：`2026-10-02 16:00:01`
 * - 港股：`2026/10/05 13:10:49`
 * - 境内：`20260930161443`（紧凑型）
 *
 * ⚠️ 这里产出的**仍然是不带时区的墙上时间**，必须再经 `wallClockToIso()`
 * 才能变成绝对时刻 —— 详见下方「时区归一化」。
 */
function normalizeTencentWallClock(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const s = raw.trim()
  // 紧凑型：YYYYMMDDHHmmss
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (compact) {
    const [, y, mo, d, h, mi, sec] = compact
    return `${y}-${mo}-${d}T${h}:${mi}:${sec}`
  }
  const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return undefined
  const [, y, mo, d, h, mi, sec = '00'] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${sec}`
}

/* ------------------------------------------------------------------ *
 * 时区归一化：交易所当地时间 → 绝对时刻
 * ------------------------------------------------------------------ */

/**
 * 各市场的 IANA 时区。
 *
 * ⚠️ 腾讯 / 天天基金返回的时间都是**交易所当地时间**且**不带时区**。
 * 直接 `new Date('2026-10-02T16:00:01')` 会按**运行环境本地时区**解析：
 * 在中国（UTC+8）打开时，美东 16:00 被当成北京 16:00 ——
 * 比真实时刻**早 12 小时**，于是刚拉到的行情立刻被判「已过期」。
 * 更糟的是同一份数据在不同时区的设备上会得到不同结果，不可复现。
 */
const MARKET_TIME_ZONE: Record<CodeKind, string> = {
  us: 'America/New_York',
  hk: 'Asia/Hong_Kong',
  cn: 'Asia/Shanghai',
}

/** 某个 UTC 时刻在指定时区的偏移（毫秒；东八区 = +28800000） */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return asIfUtc - utcMs
}

/**
 * 把「某时区的墙钟时间」转成带 `Z` 的绝对时刻。
 *
 * 两遍求偏移：第一遍用「把墙钟当 UTC」得到的近似时刻查偏移，
 * 第二遍用修正后的时刻再查一次 —— 这样跨夏令时切换日也不会差一小时。
 */
export function wallClockToIso(wall: string, timeZone: string): string | undefined {
  const naive = Date.parse(`${wall}Z`)
  if (!Number.isFinite(naive)) return undefined
  const first = naive - zoneOffsetMs(naive, timeZone)
  const second = naive - zoneOffsetMs(first, timeZone)
  return new Date(second).toISOString()
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export interface ParsedQuote {
  /** 代码（用于回填/展示） */
  code: string
  /** 接口返回的名称 —— 用于让用户确认「是不是这只」 */
  name: string
  price: number
  /** 行情时间（ISO） */
  timestamp: string
}

/**
 * 解析腾讯返回体。
 *
 * 返回体是 **GBK 编码的 JS 赋值语句**：
 * ```
 * v_usSPY="200~标普500指数ETF-SPDR~SPY.AM~769.64~763.99~...";
 * ```
 * 字段索引：`[1]` 名称 `[2]` 代码 `[3]` 现价 `[4]` 昨收 `[30]` 行情时间
 *
 * 无效代码返回 `v_pv_none_match="1";` —— **必须识别**，否则会被当成空结果误报成功。
 *
 * @param text 已按 GBK 解码后的文本
 */
export function parseTencentQuotes(text: string): ParsedQuote[] {
  const out: ParsedQuote[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/v_(us|hk|sh|sz)([A-Za-z0-9.\-]+)\s*=\s*"([^"]*)"/)
    if (!m) continue
    const [, varPrefix, varCode, body] = m
    const f = body.split('~')
    /*
     * 字段数不足即视为残缺响应。
     *
     * 真实返回体有 35 个 `~` 分隔字段；这里要求至少到 [30]（行情时间）为止，
     * 否则时间无从取得、也无法确认它是一条完整行情。
     */
    if (f.length < 31) continue
    const name = (f[1] ?? '').trim()
    const price = num(f[3])
    if (!name || price === undefined) continue
    /*
     * 代码取哪个？
     * - 变量名（`v_usSPY` → `SPY`）是**查询用的代码**；
     * - 字段 [2] 是**交易所代码**，可能带后缀（美股 `SPY.AM`）。
     *
     * 优先用字段 [2]（更完整），缺失时回落到变量名。回配到标的时两者都会尝试。
     */
    const code = (f[2] ?? '').trim() || `${varPrefix === 'us' || varPrefix === 'hk' ? '' : varPrefix}${varCode}`
    /*
     * 变量名前缀（`us` / `hk` / `sh` / `sz`）决定这是哪个市场，
     * 也就决定了该用哪个时区解释这条时间。
     */
    const kind: CodeKind = varPrefix === 'us' ? 'us' : varPrefix === 'hk' ? 'hk' : 'cn'
    const wall = normalizeTencentWallClock(f[30])
    // 时间缺失/无法解析时退回「抓取时刻」，而不是写一个错的绝对时刻
    const timestamp =
      (wall ? wallClockToIso(wall, MARKET_TIME_ZONE[kind]) : undefined) ?? new Date().toISOString()
    out.push({ code, name, price, timestamp })
  }
  return out
}

/** 解析场外基金净值接口返回体 */
export function parseFundNav(payload: unknown): ParsedQuote[] {
  const p = payload as { Datas?: { FCODE?: string; SHORTNAME?: string; NAV?: string; PDATE?: string }[] }
  const rows = p?.Datas
  if (!Array.isArray(rows)) return []
  const out: ParsedQuote[] = []
  for (const r of rows) {
    const code = (r.FCODE ?? '').trim()
    const name = (r.SHORTNAME ?? '').trim()
    const price = num(r.NAV)
    if (!code || !name || price === undefined) continue
    /*
     * 净值只给日期（收盘后公布）。`PDATE` 是**北京时间**的日期，
     * 因此按 `+08:00` 解析 —— 写成 `Z` 等于把它当成 UTC 00:00，
     * 即北京时间当天 08:00，凭空偏移 8 小时。
     */
    const timestamp = r.PDATE
      ? `${r.PDATE.slice(0, 10)}T00:00:00.000+08:00`
      : new Date().toISOString()
    out.push({ code, name, price, timestamp })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 取数
 * ------------------------------------------------------------------ */

async function fetchTencent(codes: string[]): Promise<string> {
  const url = TENCENT_ENDPOINT + codes.join(',')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QUOTE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // 腾讯返回 GBK，不能声明 Accept: application/json
      headers: { Accept: '*/*' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    /*
     * ⚠️ 必须按 GBK 解码：返回体里的中文名称是 GBK 编码。
     * 用默认 UTF-8 解会得到乱码 —— 乱码会被写进 Instrument.name，
     * 属于「污染用户数据」，必须避免。
     */
    const buf = await res.arrayBuffer()
    return new TextDecoder('gbk').decode(buf)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchFundNav(codes: string[]): Promise<unknown> {
  const url =
    `${FUND_NAV_ENDPOINT}?pageIndex=1&pageSize=${codes.length}` +
    `&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=wc2` +
    `&Fcodes=${encodeURIComponent(codes.join(','))}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QUOTE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/** 某个标的该走哪条路；返回 null 表示不自动获取 */
export interface QuoteRoute {
  /** 数据源标识（写入 `Quote.source`） */
  source: 'tencent' | 'eastmoney-fund'
  priceKind: PriceKind
  /** 查询用的代码 */
  query: string
}

/**
 * 按 `instrumentType` 决定路由（**已与用户确认的方案 A1**）。
 *
 * ⚠️ 这里的判断依据是**用户建标的时选择的工具类型**，不是从名字/代码
 * 猜测资产类别 —— 不违反「不自动分类」。
 */
export function routeFor(instrument: Instrument): QuoteRoute | null {
  const symbol = (instrument.symbol ?? '').trim()
  if (!symbol) return null

  // 场外基金：走净值
  if (instrument.instrumentType === 'fund') {
    if (!/^\d{6}$/.test(symbol)) return null
    return { source: 'eastmoney-fund', priceKind: 'nav', query: symbol }
  }

  // 场内（股票 / ETF）：走腾讯行情
  if (instrument.instrumentType === 'stock' || instrument.instrumentType === 'etf') {
    const kind = detectCodeKind(symbol)
    if (!kind) return null
    const q = toTencentSymbol(symbol, kind)
    if (!q) return null
    return { source: 'tencent', priceKind: 'market_price', query: q }
  }

  // 其余（bond / gold / crypto / real_estate / …）保持手动录入
  return null
}

/* ------------------------------------------------------------------ *
 * 落库
 * ------------------------------------------------------------------ */

/**
 * 自动获取的行情该以什么状态落库。
 *
 * ⚠️ **绝不能一律写 `LIVE`**。
 *
 * `policy.ts` 给 `LIVE` 的新鲜度上限只有 **1 小时**，而自动获取拿到的
 * 往往不是「此刻的盘中价」：
 *
 * - **场外基金**给的是**正式单位净值**，一天只公布一条，时间戳就是净值日；
 * - **场内**闭市后的收盘价也不再变化。
 *
 * 一律写 LIVE 的后果：**刚拉完就已经「过期几小时」**，
 * 「数据完整度」里凭空多出一排「估值已过期」，而数据其实是最新的。
 *
 * 因此按语义定状态：
 * - 场外基金净值 → `CLOSED`（正式收盘净值，到下一个交易日之前都有效）；
 * - 场内：距现在 ≤ `LIVE` 上限 → `LIVE`（盘中价）；否则 → `CLOSED`（收盘价）。
 */
function statusForQuote(source: QuoteRoute['source'], quoteAt: string, nowMs: number): QuoteStatus {
  if (source === 'eastmoney-fund') return 'CLOSED'
  const t = new Date(quoteAt).getTime()
  if (!Number.isFinite(t)) return 'CLOSED'
  // age < 0（轻微时钟偏差造成的「未来时间」）按最新处理，不因此判过期
  return nowMs - t <= DEFAULT_QUOTE_POLICY.freshnessMs.LIVE ? 'LIVE' : 'CLOSED'
}

/**
 * 写入一条行情。
 *
 * 与汇率同理：`source` 区分来源，因此**自动拉取不会覆盖手填值**
 * （手填的 `source` 是 `'manual'`）。
 *
 * @param nowMs 本次同步的参考时刻，用于判定「盘中价」还是「收盘价」
 */
async function persistQuote(
  repo: PortfolioRepository,
  instrumentId: string,
  route: QuoteRoute,
  parsed: ParsedQuote,
  currency: CurrencyCode,
  nowMs: number,
): Promise<void> {
  const status = statusForQuote(route.source, parsed.timestamp, nowMs)
  const quote: Quote = {
    id: `q_auto_${route.source}_${instrumentId}_${parsed.timestamp.slice(0, 10)}`,
    instrumentId,
    priceKind: route.priceKind,
    currency,
    source: route.source,
    timestamp: parsed.timestamp,
    status,
  }
  if (route.priceKind === 'nav') quote.nav = parsed.price
  else quote.marketPrice = parsed.price

  await repo.quotes.put(quote)
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

export interface QuoteSyncOutcome {
  instrumentId: string
  instrumentName: string
  ok: boolean
  /** 成功时：接口返回的名称（供用户确认「是不是这只」） */
  fetchedName?: string
  price?: number
  priceKind?: PriceKind
  /** 成功时：依据时间 */
  asOf?: string
  /** 失败原因 */
  error?: string
}

export interface QuoteSyncResult {
  /** 本次拉取了哪些标的 */
  outcomes: QuoteSyncOutcome[]
  /** 成功写入的条数 */
  written: number
  /** 成功写入的标的 id（供调用方刷新） */
  updatedIds: string[]
  syncedAt: string
}

/**
 * 拉取全部「可自动获取」标的的行情。
 *
 * **永不抛错** —— 行情不是核心依赖，失败也要能正常记账；
 * 每个标的的成功/失败都单独返回，供 UI 如实展示。
 *
 * @param options.instrumentIds 只拉这些标的（不传则拉全部可自动获取的）
 */
export async function syncQuotes(
  repo: PortfolioRepository,
  options: { instrumentIds?: string[]; now?: () => number } = {},
): Promise<QuoteSyncResult> {
  const now = options.now ?? (() => Date.now())
  /*
   * 本次同步的统一参考时刻。
   * 状态判定（`statusForQuote`）与 `syncedAt` 必须用**同一个** now，
   * 否则同一条行情可能按两个不同时点得出互相矛盾的状态。
   */
  const nowMs = now()
  const syncedAt = new Date(nowMs).toISOString()
  const portfolio: Portfolio2 = await repo.loadPortfolio()

  const wanted = options.instrumentIds ? new Set(options.instrumentIds) : null
  const targets = portfolio.instruments
    .filter((i) => (wanted ? wanted.has(i.id) : true))
    .map((i) => ({ instrument: i, route: routeFor(i) }))
    .filter((t): t is { instrument: Instrument; route: QuoteRoute } => t.route !== null)

  const outcomes: QuoteSyncOutcome[] = []
  const updatedIds: string[] = []
  if (targets.length === 0) {
    return { outcomes, written: 0, updatedIds, syncedAt }
  }

  /* 按源分组，尽量一次请求拿多个（两个接口都支持批量） */
  const tencent = targets.filter((t) => t.route.source === 'tencent')
  const funds = targets.filter((t) => t.route.source === 'eastmoney-fund')

  if (tencent.length > 0) {
    try {
      const parsed = parseTencentQuotes(await fetchTencent(tencent.map((t) => t.route.query)))
      // 腾讯返回的代码是 `SPY.AM` / `00700` / `510300` 形态，需回配到标的
      const byCode = new Map(parsed.map((p) => [p.code.toUpperCase(), p]))
      for (const t of tencent) {
        const symbol = (t.instrument.symbol ?? '').trim()
        const key = t.route.query.replace(/^(us|hk|sh|sz)/i, '').toUpperCase()
        const hit =
          byCode.get(key) ??
          byCode.get(symbol.toUpperCase()) ??
          // 腾讯给美股加了 `.AM` 之类的后缀，做一次前缀匹配
          parsed.find((p) => p.code.toUpperCase().startsWith(symbol.toUpperCase()))
        if (!hit) {
          outcomes.push({
            instrumentId: t.instrument.id,
            instrumentName: t.instrument.name,
            ok: false,
            error: `未查询到代码 ${symbol}（请确认代码是否正确）`,
          })
          continue
        }
        await persistQuote(repo, t.instrument.id, t.route, hit, t.instrument.currency, nowMs)
        updatedIds.push(t.instrument.id)
        outcomes.push({
          instrumentId: t.instrument.id,
          instrumentName: t.instrument.name,
          ok: true,
          fetchedName: hit.name,
          price: hit.price,
          priceKind: t.route.priceKind,
          asOf: hit.timestamp,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      for (const t of tencent) {
        outcomes.push({
          instrumentId: t.instrument.id,
          instrumentName: t.instrument.name,
          ok: false,
          error: `行情源不可用：${msg}`,
        })
      }
    }
  }

  if (funds.length > 0) {
    try {
      const parsed = parseFundNav(await fetchFundNav(funds.map((t) => t.route.query)))
      const byCode = new Map(parsed.map((p) => [p.code.toUpperCase(), p]))
      for (const t of funds) {
        const hit = byCode.get(t.route.query.toUpperCase())
        if (!hit) {
          outcomes.push({
            instrumentId: t.instrument.id,
            instrumentName: t.instrument.name,
            ok: false,
            error: `未查询到基金代码 ${t.route.query}`,
          })
          continue
        }
        await persistQuote(repo, t.instrument.id, t.route, hit, t.instrument.currency, nowMs)
        updatedIds.push(t.instrument.id)
        outcomes.push({
          instrumentId: t.instrument.id,
          instrumentName: t.instrument.name,
          ok: true,
          fetchedName: hit.name,
          price: hit.price,
          priceKind: t.route.priceKind,
          asOf: hit.timestamp,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      for (const t of funds) {
        outcomes.push({
          instrumentId: t.instrument.id,
          instrumentName: t.instrument.name,
          ok: false,
          error: `行情源不可用：${msg}`,
        })
      }
    }
  }

  return { outcomes, written: updatedIds.length, updatedIds, syncedAt }
}

/** 该标的能否自动获取行情（供 UI 决定是否显示「更新行情」入口） */
export function canAutoFetchQuote(instrument: Instrument): boolean {
  return routeFor(instrument) !== null
}
