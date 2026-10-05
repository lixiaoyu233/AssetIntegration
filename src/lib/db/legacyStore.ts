/**
 * 旧数据读取器（Legacy V2 localStorage → 迁移输入）
 *
 * 只读：本模块**绝不写入或删除**旧键。
 * 迁移后的新数据写入 IndexedDB（Phase 1 暂以内存/localStorage 适配器承接），
 * 旧键原样保留，直到用户在设置里主动清理。
 */

import type { LegacyNetWorthPointLike, LegacyPortfolioLike } from './migrations/legacy-v2-to-schema-v3'

/** 1.x 的资产数据键（含更早的历史键名） */
export const LEGACY_PORTFOLIO_KEYS = [
  'asset-card-wallet/portfolio/v2',
  'asset-card-wallet/portfolio/v1',
  'assetCardWallet',
  'asset-card-wallet',
] as const

/** 1.x 的月度走势键 */
export const LEGACY_NETWORTH_KEY = 'asset-card-wallet/networth-history/v1'

/** 1.x 的设置键（薪资 / 走势开关），迁移后仍可读取用于后续阶段的设置搬运 */
export const LEGACY_SETTINGS_KEY = 'asset-card-wallet/settings/v1'

export interface LegacySnapshotInput {
  portfolio: LegacyPortfolioLike | null
  netWorthPoints: LegacyNetWorthPointLike[]
  /** 实际命中的键，便于展示与排查 */
  sourceKey?: string
  /** 解析失败时的原因 */
  error?: string
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 取存储实现。
 *
 * 支持注入是为了**测试与迁移编排**：启动迁移可以传入指定 storage，
 * 而不是被迫依赖全局 `window.localStorage`（否则测试无法注入替身）。
 */
function resolveStorage(storage?: Pick<Storage, 'getItem'>): Pick<Storage, 'getItem'> | null {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    // 隐私模式 / 禁用 Cookie 时，访问 window.localStorage 本身就可能抛错
    return window.localStorage
  } catch {
    return null
  }
}

/** 读取旧资产数据；数据损坏时返回 error 而不是抛错 */
export function readLegacyPortfolio(
  storage?: Pick<Storage, 'getItem'>,
): LegacySnapshotInput {
  const store = resolveStorage(storage)
  if (!store) return { portfolio: null, netWorthPoints: [] }

  for (const key of LEGACY_PORTFOLIO_KEYS) {
    let raw: string | null = null
    try {
      raw = store.getItem(key)
    } catch {
      return { portfolio: null, netWorthPoints: [], error: '当前浏览器禁用了本地存储，无法读取旧数据' }
    }
    if (!raw) continue

    const parsed = safeParse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { portfolio: null, netWorthPoints: [], sourceKey: key, error: '旧数据格式异常，已跳过，原数据未改动' }
    }
    const points = readLegacyNetWorthPoints(storage)
    return {
      portfolio: parsed as LegacyPortfolioLike,
      netWorthPoints: points,
      sourceKey: key,
    }
  }

  return { portfolio: null, netWorthPoints: readLegacyNetWorthPoints(storage) }
}

export function readLegacyNetWorthPoints(
  storage?: Pick<Storage, 'getItem'>,
): LegacyNetWorthPointLike[] {
  const store = resolveStorage(storage)
  if (!store) return []
  try {
    const parsed = safeParse(store.getItem(LEGACY_NETWORTH_KEY))
    if (!parsed || typeof parsed !== 'object') return []
    const points = (parsed as { points?: unknown }).points
    return Array.isArray(points) ? (points as LegacyNetWorthPointLike[]) : []
  } catch {
    return []
  }
}

/** 旧数据是否仍在本地（供设置页显示「清理旧版数据」入口） */
export function hasLegacyData(storage?: Pick<Storage, 'getItem'>): boolean {
  const store = resolveStorage(storage)
  if (!store) return false
  try {
    return LEGACY_PORTFOLIO_KEYS.some((k) => store.getItem(k) !== null)
  } catch {
    return false
  }
}

/**
 * 清理旧数据。
 *
 * 只在用户**明确二次确认**后调用（设置页按钮），且调用方必须先确认新数据可用。
 * 这里额外做一道防线：若传入 `newDataHealthy` 为 false，直接拒绝执行。
 */
export function removeLegacyData(newDataHealthy: boolean): { ok: boolean; reason?: string; removed: string[] } {
  if (!newDataHealthy) {
    return { ok: false, reason: '新数据尚未确认可用，已拒绝清理旧数据', removed: [] }
  }
  if (typeof window === 'undefined') return { ok: false, reason: '当前环境不支持', removed: [] }

  const removed: string[] = []
  for (const key of [...LEGACY_PORTFOLIO_KEYS, LEGACY_NETWORTH_KEY]) {
    try {
      if (window.localStorage.getItem(key) !== null) {
        window.localStorage.removeItem(key)
        removed.push(key)
      }
    } catch {
      return { ok: false, reason: '清理过程中出错，部分数据可能未删除', removed }
    }
  }
  return { ok: true, removed }
}
