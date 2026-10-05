/**
 * 汇率自动获取与落库（Phase 8+ / 双版本并存后的新增能力）
 *
 * ## 为什么需要
 *
 * 2.0 早期（W6）刻意只做**手动录入**：当时 `quotes` / `fxRates` 的写入调用数是 0，
 * 先把严格口径建起来，缺汇率的持仓一律 `unavailable`（**绝不 1:1 兜底**）。
 *
 * 但现实里那太费事：多币种用户每次都要手填。于是补上自动获取，
 * 同时**保留 2.0 的全部不变量**——拿不到就如实不可估值，绝不用 1 假冒。
 *
 * ## 三级降级（本文件的核心）
 *
 * ```
 * ① 主源 open.er-api.com   → source: 'er-api'    status: LIVE
 * ② 备源 jsdelivr          → source: 'jsdelivr'  status: DELAYED
 * ③ 兜底 public/fx-seed.json → source: 'seed'    status: SEED（不因时间失效）
 * ```
 *
 * **兜底种子会先落库，再尝试网络源**，有两个好处：
 *
 * 1. **界面不会先闪一下「不可估值」**：静态文件是本地读取，
 *    而网络请求要等几百毫秒甚至超时（10s）。先落种子能让数字立刻可用。
 * 2. **网络失败就是真正的降级**：种子已经在库里，`resolveRate` 自然会解析到它。
 *
 * 网络源成功后，因为状态优先级是 `LIVE(0) < DELAYED(1) < SEED(2)`
 * （见 `fx.ts` 的 `rateStatusRank`），更权威的值会自动接管，
 * **不需要删除种子行**——历史因此完整保留。
 *
 * ## 与账本、快照的关系（重要）
 *
 * 本模块**只写 `fxRates` 表**，不碰交易、持仓、快照。
 * `SnapshotPosition` 在捕获时已冻结 `rateToCny` + `valueCny`，
 * 因此**后续更新汇率不会改写任何历史快照**。
 *
 * ## 想改的时候
 *
 * - 换数据源 / 加第四个源 → 改 `FX_SOURCES` 数组即可，顺序就是优先级
 * - 改刷新频率 → 改 `FX_REFRESH_MS`
 * - 换兜底文件路径 → 改 `FX_SEED_URL`
 * - 改「谁覆盖谁」→ 改 `fx.ts` 的 `rateStatusRank`
 */
import type { CurrencyCode, FxRate, FxStatus, Portfolio2 } from '../../types/portfolio2'
import { CURRENCIES } from '../currency'
import type { PortfolioRepository } from '../db/repository'

/* ------------------------------------------------------------------ *
 * 可调参数（集中在这里，方便修改）
 * ------------------------------------------------------------------ */

/**
 * 自动刷新间隔：6 小时。
 *
 * 为什么不是 1.0 的 5 分钟：1.0 刷的是**基金行情**（盘中会变），
 * 而汇率一天基本只变一次。6 小时足够新鲜，又不会白耗流量。
 */
export const FX_REFRESH_MS = 6 * 60 * 60 * 1000

/** 兜底种子文件（随站点打包，构建时从 `public/` 拷入 `dist/`） */
export const FX_SEED_URL = './fx-seed.json'

/** 单次请求超时。种子是本地文件，不需要等太久；网络源给它 8 秒 */
export const FX_FETCH_TIMEOUT_MS = 8_000

/**
 * 自动拉取的数据源，**数组顺序即优先级**。
 *
 * 想加源就往后追加；每个源提供 `url` 与 `parse`，
 * `parse` 返回「1 外币 = ? CNY」的映射（不含 CNY 自身）。
 */
const FX_SOURCES: readonly {
  /** 写库时记的 `source`，也是去重键的一部分 */
  source: string
  label: string
  status: FxStatus
  url: string
  parse: (payload: unknown) => { rates: Partial<Record<CurrencyCode, number>>; asOf?: string }
}[] = [
  {
    source: 'er-api',
    label: 'open.er-api.com',
    status: 'LIVE',
    url: 'https://open.er-api.com/v6/latest/CNY',
    parse: parseErApi,
  },
  {
    source: 'jsdelivr',
    label: 'jsdelivr/currency-api',
    status: 'DELAYED',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json',
    parse: parseJsdelivr,
  },
]

/** 支持的币种码集合，用于过滤远端返回的大量无关币种 */
const SUPPORTED = new Set<string>(CURRENCIES.map((c) => c.code))

/* ------------------------------------------------------------------ *
 * 解析器
 * ------------------------------------------------------------------ */

/**
 * 主源 `open.er-api.com`：`rates` 是「1 CNY = ? 外币」，因此取倒数。
 * `time_last_update_unix` 是该行情的实际时间，用它做 `asOf` 最准确。
 */
function parseErApi(payload: unknown): {
  rates: Partial<Record<CurrencyCode, number>>
  asOf?: string
} {
  const p = payload as { result?: string; rates?: Record<string, number>; time_last_update_unix?: number }
  if (!p || p.result !== 'success' || !p.rates || typeof p.rates !== 'object') {
    throw new Error('主源返回结构不可识别')
  }
  const rates = invert(p.rates)
  const asOf = Number.isFinite(p.time_last_update_unix)
    ? new Date((p.time_last_update_unix as number) * 1000).toISOString()
    : undefined
  return { rates, asOf }
}

/**
 * 备源 `jsdelivr/currency-api`：`cny` 是「1 CNY = ? 外币」，同样取倒数。
 * 它只给到「日期」粒度，因此 `asOf` 为当天 00:00 UTC。
 */
function parseJsdelivr(payload: unknown): {
  rates: Partial<Record<CurrencyCode, number>>
  asOf?: string
} {
  const p = payload as { date?: string; cny?: Record<string, number> }
  if (!p || !p.cny || typeof p.cny !== 'object') throw new Error('备源返回结构不可识别')
  const rates = invert(p.cny)
  const asOf = typeof p.date === 'string' && p.date ? `${p.date}T00:00:00.000Z` : undefined
  return { rates, asOf }
}

/** 「1 CNY = ? 外币」→「1 外币 = ? CNY」，只保留受支持且为正的币种 */
function invert(perCny: Record<string, number>): Partial<Record<CurrencyCode, number>> {
  const out: Partial<Record<CurrencyCode, number>> = {}
  for (const [rawCode, value] of Object.entries(perCny)) {
    const code = rawCode.toUpperCase()
    if (!SUPPORTED.has(code) || code === 'CNY') continue
    if (!Number.isFinite(value) || value <= 0) continue
    out[code as CurrencyCode] = 1 / value
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 兜底种子
 * ------------------------------------------------------------------ */

export interface FxSeedFile {
  asOf?: string
  rates?: Record<string, number>
  _说明?: string[]
}

/**
 * 解析兜底种子文件。
 *
 * 方向是**直读**的「1 外币 = ? CNY」，与 `FxRate` 的 `base=外币, quote=CNY` 一致，
 * 因此这里**不做倒数**——这跟两个网络源相反，是刻意为了让你填数字时更直觉。
 */
export function parseSeedFile(payload: unknown): { rates: Partial<Record<CurrencyCode, number>>; asOf: string } {
  const p = payload as FxSeedFile
  if (!p || typeof p !== 'object' || !p.rates || typeof p.rates !== 'object') {
    throw new Error('兜底种子文件结构不可识别')
  }
  const rates: Partial<Record<CurrencyCode, number>> = {}
  for (const [rawCode, value] of Object.entries(p.rates)) {
    const code = rawCode.toUpperCase()
    if (!SUPPORTED.has(code) || code === 'CNY') continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    rates[code as CurrencyCode] = value
  }
  // 日期无效则退回今天（种子是用户手维护的，不该因格式问题整份失效）
  const asOf =
    typeof p.asOf === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.asOf)
      ? `${p.asOf.slice(0, 10)}T00:00:00.000Z`
      : `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
  return { rates, asOf }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 去重键：币种对 + 来源 + **日期**（同一天内重复拉取只更新那一行，不堆记录） */
function fxRowKey(base: string, quote: string, source: string, asOf: string): string {
  return `${base}|${quote}|${source}|${asOf.slice(0, 10)}`
}

/** 本地日期（YYYY-MM-DD），用于给没有时间戳的源兜底 */
function todayLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // 兜底种子随站点发布，允许浏览器缓存，避免每次启动都重复下载
      cache: url.includes('fx-seed') ? 'default' : 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 落库
 * ------------------------------------------------------------------ */

/**
 * 把一批汇率写进 `fxRates`。
 *
 * **绝不覆盖手填值**：手填的 `source` 是 `'manual'`，
 * 与这里的 `'seed'` / `'er-api'` / `'jsdelivr'` 是不同的去重键 → 各占一行。
 * 谁最终生效由 `resolveRate` 的状态优先级决定。
 *
 * @returns 实际写入（新增或同键更新）的行数
 */
async function persistRates(
  repo: PortfolioRepository,
  portfolio: Portfolio2,
  source: string,
  status: FxStatus,
  asOfIso: string,
  rates: Partial<Record<CurrencyCode, number>>,
  quote: CurrencyCode = 'CNY',
): Promise<number> {
  // 现有行索引：去重键 → 已有 id（同键更新而不是新增）
  const existing = new Map<string, string>()
  for (const r of portfolio.fxRates) {
    existing.set(fxRowKey(r.baseCurrency, r.quoteCurrency, r.source, r.timestamp), r.id)
  }

  let written = 0
  for (const [code, rate] of Object.entries(rates)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) continue
    const key = fxRowKey(code, quote, source, asOfIso)
    const id = existing.get(key) ?? `fx_auto_${source}_${code}_${asOfIso.slice(0, 10)}`
    const row: FxRate = {
      id,
      baseCurrency: code as CurrencyCode,
      quoteCurrency: quote,
      rate,
      timestamp: asOfIso,
      source,
      status,
    }
    await repo.fxRates.put(row)
    existing.set(key, id)
    written += 1
  }
  return written
}

/**
 * 读取并落库兜底种子。**这是最先执行的一步**（本地文件，无网络等待）。
 *
 * @returns 写入行数；`0` 表示种子不可用（不应阻塞后续网络源）
 */
async function applySeed(repo: PortfolioRepository, portfolio: Portfolio2): Promise<number> {
  try {
    const payload = await fetchJson(FX_SEED_URL, 5_000)
    const { rates, asOf } = parseSeedFile(payload)
    if (Object.keys(rates).length === 0) return 0
    return await persistRates(repo, portfolio, 'seed', 'SEED', asOf, rates)
  } catch {
    // 种子缺失/损坏不是错误：网络源仍是主路径
    return 0
  }
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

export interface FxSyncResult {
  /** 实际生效的来源 */
  source: 'er-api' | 'jsdelivr' | 'seed' | 'none'
  /** 写入（新增或同键更新）的行数 */
  written: number
  /** 是否来自网络 */
  fromNetwork: boolean
  /** 尝试失败的原因（全部失败时才有意义） */
  error?: string
  /** 同步完成时间 */
  syncedAt: string
}

/**
 * 执行一次汇率同步。
 *
 * **永不抛错**——汇率不是本应用的核心依赖，失败也要能正常记账，
 * 由调用方根据 `result.source` 决定怎么提示。
 *
 * @param options.force 忽略「刚同步过」的判断，直接拉取（供「立即刷新」按钮使用）
 */
export async function syncFxRates(
  repo: PortfolioRepository,
  options: { force?: boolean; now?: () => number } = {},
): Promise<FxSyncResult> {
  const now = options.now ?? (() => Date.now())
  const syncedAt = new Date(now()).toISOString()

  const portfolio = await repo.loadPortfolio()

  /*
   * ① 兜底种子先落库。
   *
   * 为什么放最前面：它是**本地静态文件**（毫秒级），而网络源可能要等到超时。
   * 先落种子能让估值立刻有值，不会先闪一下「不可估值」。
   */
  const seedWritten = await applySeed(repo, portfolio)

  // 种子落库后重新读一次，避免后续 persistRates 的去重索引漏掉刚写的行
  let current = await repo.loadPortfolio()

  /* ② 依次尝试网络源，**第一个成功的就停**（数组顺序即优先级） */
  const attempts: string[] = []
  for (const src of FX_SOURCES) {
    try {
      const payload = await fetchJson(src.url, FX_FETCH_TIMEOUT_MS)
      const parsed = src.parse(payload)
      const codes = Object.keys(parsed.rates)
      if (codes.length === 0) throw new Error('没有解析出任何受支持的币种')

      // 远端没给时间就退回「今天本地日期」，避免写入无时间戳的行
      const asOf = parsed.asOf ?? `${todayLocal()}T00:00:00.000Z`
      const written = await persistRates(repo, current, src.source, src.status, asOf, parsed.rates)

      return {
        source: src.source as FxSyncResult['source'],
        written,
        fromNetwork: true,
        syncedAt,
      }
    } catch (e) {
      attempts.push(`${src.label}: ${e instanceof Error ? e.message : String(e)}`)
      // 继续尝试下一个源
    }
  }

  /* ③ 网络源全失败：用已落库的种子兜底 */
  if (seedWritten > 0) {
    return { source: 'seed', written: seedWritten, fromNetwork: false, error: attempts.join('；'), syncedAt }
  }

  current = await repo.loadPortfolio()
  if (current.fxRates.length > 0) {
    // 库里还有历史汇率（会自动被判为 STALE 但仍可用于展示与归因）
    return { source: 'none', written: 0, fromNetwork: false, error: attempts.join('；'), syncedAt }
  }

  return { source: 'none', written: 0, fromNetwork: false, error: attempts.join('；'), syncedAt }
}

/**
 * 是否需要发起一次同步。
 *
 * 「刚同步过」的判定基于 `meta` 里的记录，而不是内存状态 ——
 * 这样刷新页面后不会立刻又打一次网络请求。
 */
export async function shouldSyncFx(
  repo: PortfolioRepository,
  options: { now?: () => number } = {},
): Promise<boolean> {
  const now = options.now ?? (() => Date.now())
  try {
    const kv = await repo.metaKv.get('fx/last-sync')
    const at = (kv as { syncedAt?: string } | undefined)?.syncedAt
    if (!at) return true
    return now() - Date.parse(at) >= FX_REFRESH_MS
  } catch {
    return true
  }
}

/** 记录本次同步时间（供 `shouldSyncFx` 判定） */
export async function markFxSynced(
  repo: PortfolioRepository,
  result: FxSyncResult,
): Promise<void> {
  try {
    await repo.metaKv.set('fx/last-sync', { ...result })
  } catch {
    // 记录失败不影响汇率本身，也不谎报成功
  }
}
