import type { HistoryPoint, Portfolio } from '../types/asset'
import { guardBusinessWrite } from './readOnly'
import { SCHEMA_VERSION, createDefaultCategories, createEmptyPortfolio, mergeDefaultCategories } from './defaults'
import { isCurrencyCode } from './currency'
import { safeNum } from './calc'

// 键名刻意保留早期前缀（项目曾用名 asset-card-wallet）：改名不迁移数据，老用户无感
export const STORAGE_KEY = 'asset-card-wallet/portfolio/v2'
/** 兜底：旧版本键名，迁移后保留只读读取 */
const LEGACY_KEYS = ['asset-card-wallet/portfolio/v1', 'assetCardWallet', 'asset-card-wallet']

export interface StorageResult {
  portfolio: Portfolio
  /** 是否从损坏数据中恢复（用于给用户提示） */
  recovered: boolean
  /** 版本升级时自动补上的内置分类名称（用于一次性提示） */
  addedCategories?: string[]
  error?: string
}

/** localStorage 可用性探测（隐私模式 / 禁用 Cookie 时会抛错） */
export function isStorageAvailable(): boolean {
  try {
    const k = '__acw_probe__'
    window.localStorage.setItem(k, '1')
    window.localStorage.removeItem(k)
    return true
  } catch {
    return false
  }
}

function isCategoryLike(v: unknown): v is { id: string; name: string; items: unknown[] } {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.items)
}

/**
 * 把任意来源的数据（localStorage / 旧版本 / 手工导入）规范化为当前 Schema。
 * 任何字段缺失都补默认值，保证 UI 永远不会因为脏数据崩溃。
 */
export function normalizePortfolio(raw: unknown): Portfolio | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const rawCategories = Array.isArray(obj.categories) ? obj.categories : null
  if (!rawCategories) return null

  const categories = rawCategories.filter(isCategoryLike).map((c, idx) => {
    const raw0 = c as unknown as Record<string, unknown>
    const fallback = createDefaultCategories()[idx]
    const items = (c.items as unknown[]).map(normalizeItem).filter((i): i is NonNullable<typeof i> => i !== null)
    return {
      id: String(c.id),
      name: String(c.name || fallback?.name || '未命名分类'),
      subtitle: typeof raw0.subtitle === 'string' ? raw0.subtitle : (fallback?.subtitle ?? ''),
      icon: typeof raw0.icon === 'string' ? raw0.icon : (fallback?.icon ?? 'wallet'),
      color: typeof raw0.color === 'string' && raw0.color ? raw0.color : (fallback?.color ?? 'var(--accent-blue)'),
      colorName: typeof raw0.colorName === 'string' ? raw0.colorName : fallback?.colorName,
      isLiability: raw0.isLiability === true,
      defaultKind:
        raw0.defaultKind === 'fund' || raw0.defaultKind === 'gold' || raw0.defaultKind === 'amount'
          ? raw0.defaultKind
          : fallback?.defaultKind,
      items,
    }
  })

  const history: HistoryPoint[] = Array.isArray(obj.history)
    ? (obj.history as unknown[])
        .map((h) => {
          if (!h || typeof h !== 'object') return null
          const p = h as Record<string, unknown>
          if (typeof p.date !== 'string') return null
          return {
            date: p.date,
            netWorth: safeNum(p.netWorth),
            totalAssets: safeNum(p.totalAssets),
            totalLiabilities: safeNum(p.totalLiabilities),
            at: safeNum(p.at) || Date.now(),
          }
        })
        .filter((h): h is HistoryPoint => h !== null)
        .slice(-120)
    : []

  return {
    version: SCHEMA_VERSION,
    categories: categories.length > 0 ? categories : createDefaultCategories(),
    history,
    lastSyncedAt: typeof obj.lastSyncedAt === 'number' ? obj.lastSyncedAt : undefined,
  }
}

function normalizeItem(raw: unknown): Portfolio['categories'][number]['items'][number] | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id : `item_${Math.random().toString(36).slice(2, 10)}`
  const kind = o.kind === 'fund' || o.kind === 'gold' ? o.kind : 'amount'
  const name = typeof o.name === 'string' && o.name ? o.name : '未命名'

  if (kind === 'fund') {
    /**
     * 代码清洗必须区分市场：早期统一按「只留数字」处理，
     * 会把 SPY / QQQ 这类美股字母代码清成空字符串，导致持仓永远拿不到行情。
     */
    const rawCode = typeof o.code === 'string' ? o.code.trim() : ''
    const rawMarket = o.market === 'us' || o.market === 'hk' || o.market === 'cn' ? o.market : undefined
    const code =
      rawMarket === 'us'
        ? rawCode.toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 6)
        : rawCode.replace(/\D/g, '').slice(0, 6)
    return {
      id,
      kind: 'fund',
      name,
      note: typeof o.note === 'string' ? o.note : undefined,
      code,
      market:
        o.market === 'us' || o.market === 'hk' || o.market === 'cn' ? o.market : undefined,
      shares: safeNum(o.shares),
      costNav: safeNum(o.costNav),
      manualNav:
        typeof o.manualNav === 'number' && Number.isFinite(o.manualNav) && o.manualNav > 0
          ? o.manualNav
          : undefined,
      manualName: o.manualName === true,
      fundedFrom: (() => {
        const f = o.fundedFrom
        if (!f || typeof f !== 'object') return undefined
        const r = f as Record<string, unknown>
        if (typeof r.categoryId !== 'string' || typeof r.itemId !== 'string') return undefined
        return {
          categoryId: r.categoryId,
          itemId: r.itemId,
          itemName: typeof r.itemName === 'string' ? r.itemName : '现金项目',
          amount: safeNum(r.amount),
        }
      })(),
      quote: normalizeQuote(o.quote),
    }
  }

  // 币种只接受白名单内的取值；非法/缺失一律回落人民币，保证旧数据兼容
  const currency = typeof o.currency === 'string' && o.currency !== 'CNY' && isCurrencyCode(o.currency)
    ? o.currency
    : undefined

  if (kind === 'gold') {
    return {
      id,
      kind: 'gold',
      name,
      note: typeof o.note === 'string' ? o.note : undefined,
      grams: safeNum(o.grams),
      pricePerGram: safeNum(o.pricePerGram),
      currency,
    }
  }

  return {
    id,
    kind: 'amount',
    name,
    note: typeof o.note === 'string' ? o.note : undefined,
    amount: safeNum(o.amount),
    currency,
  }
}

function normalizeQuote(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined
  const q = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return {
    code: str(q.code) ?? '',
    name: str(q.name) ?? '',
    estimatedNav: num(q.estimatedNav),
    estimatedRate: num(q.estimatedRate),
    estimatedAt: str(q.estimatedAt),
    publishedNav: num(q.publishedNav),
    publishedRate: num(q.publishedRate),
    publishedAt: str(q.publishedAt),
    fetchedAt: num(q.fetchedAt) ?? 0,
    source: str(q.source) ?? 'cache',
  }
}

/** 读取本地数据；损坏时自动回退默认值并标记 recovered */
export function loadPortfolio(): StorageResult {
  if (!isStorageAvailable()) {
    return { portfolio: createEmptyPortfolio(), recovered: true, error: '当前浏览器禁用了本地存储，数据无法保存' }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = normalizePortfolio(JSON.parse(raw))
      if (parsed) {
        // 升级兼容：补上后来新增的内置分类（如「国债」）
        const merged = mergeDefaultCategories(parsed.categories)
        const addedNames = merged.added
          .map((id) => merged.categories.find((c) => c.id === id)?.name ?? id)
        return {
          portfolio: { ...parsed, categories: merged.categories },
          recovered: false,
          addedCategories: addedNames.length > 0 ? addedNames : undefined,
        }
      }
      return { portfolio: createEmptyPortfolio(), recovered: true, error: '本地数据格式异常，已重置为默认分类' }
    }
    // 迁移旧键
    for (const key of LEGACY_KEYS) {
      const legacy = window.localStorage.getItem(key)
      if (!legacy) continue
      const parsed = normalizePortfolio(JSON.parse(legacy))
      if (parsed) return { portfolio: parsed, recovered: false }
    }
    return { portfolio: createEmptyPortfolio(), recovered: false }
  } catch (e) {
    return {
      portfolio: createEmptyPortfolio(),
      recovered: true,
      error: e instanceof Error ? `本地数据读取失败：${e.message}` : '本地数据读取失败',
    }
  }
}

/** 写入本地数据，返回 null 表示成功，否则返回错误文案 */
export function savePortfolio(portfolio: Portfolio): string | null {
  /*
   * 只读模式（Phase 8 / W1）：业务事实已归 IndexedDB，这里**必须拒绝**。
   * 抛错而不是静默返回 —— 静默会让旧 UI 显示「保存成功」，形成数据幻觉。
   */
  guardBusinessWrite('savePortfolio')
  if (!isStorageAvailable()) return '当前浏览器禁用了本地存储，数据无法保存'
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio))
    return null
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
      return '本地存储空间已满，请清理浏览器数据后重试'
    }
    return e instanceof Error ? `保存失败：${e.message}` : '保存失败'
  }
}

export function exportPortfolio(portfolio: Portfolio): string {
  return JSON.stringify(portfolio, null, 2)
}

export function clearPortfolio(): void {
  // 清空同样是破坏性业务操作，只读模式下必须拒绝
  guardBusinessWrite('clearPortfolio')
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 忽略 */
  }
}
