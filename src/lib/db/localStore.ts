/**
 * 迁移存储适配器（localStorage 过渡实现）
 *
 * ⚠️ Phase 8 / W1 起**只读**：业务事实已归 IndexedDB（见 `src/lib/readOnly.ts`）。
 * 本文件目前**零引用**（Phase 1–7 均未接线），保留仅为兼容历史测试；
 * 其写入路径已加入守卫，防止未来被误接入后绕过断写。
 *
 * ⚠️⚠️ **这是过渡层，禁止新的业务逻辑依赖它** ⚠️⚠️
 *
 * 正式存储自 Phase 2 起是 Dexie / IndexedDB（见 `dexie.ts` 与 `dexieRepository.ts`）。
 * 本文件仅保留两个用途：
 *   1. 环境不支持 IndexedDB 时的降级路径；
 *   2. 迁移回归测试中作为「无 Dexie」场景的对照实现。
 *
 * 不要在这里新增业务方法，也不要把估值 / 分析 / 交易逻辑接到本文件上。
 * 分层约定：
 *
 *   Dexie/IndexedDB → Repository（repository.ts） → 业务层 → UI
 *
 * 与旧数据的关系：本文件**只读写自己的键**（wealthcard/*），绝不触碰 1.x 的任何键。
 */

import type { Portfolio2 } from '../../types/portfolio2'
import { guardBusinessWrite } from '../readOnly'
import { createEmptyPortfolio2 } from '../../types/portfolio2'
import type { DbMeta, MigrationRecord } from './schema'
import { DB_META_KEY, MIGRATION_LOG_KEY } from './schema'
import type { MigrationStore } from './migrations'

/** 迁移后的新数据（Phase 2 起由 IndexedDB 接管） */
export const V2_PORTFOLIO_KEY = 'wealthcard/portfolio/v2'

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): string | null {
  if (typeof window === 'undefined') return '当前环境不支持本地存储'
  try {
    // 只读模式：拒绝写入（与 storage.ts 同一守卫，避免被绕过）
    guardBusinessWrite('localStore.setItem', key)
    window.localStorage.setItem(key, JSON.stringify(value))
    return null
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
      return '本地存储空间已满，迁移数据无法写入（旧数据未受影响）'
    }
    return e instanceof Error ? `写入失败：${e.message}` : '写入失败'
  }
}

export function createLocalStorageMigrationStore(): MigrationStore {
  return {
    readMeta: async () => readJson<DbMeta>(DB_META_KEY),
    writeMeta: async (meta) => {
      const err = writeJson(DB_META_KEY, meta)
      if (err) throw new Error(err)
    },
    readLog: async () => readJson<MigrationRecord[]>(MIGRATION_LOG_KEY) ?? [],
    writeLog: async (records) => {
      const err = writeJson(MIGRATION_LOG_KEY, records)
      if (err) throw new Error(err)
    },
    writePortfolio: async (portfolio) => {
      const err = writeJson(V2_PORTFOLIO_KEY, portfolio)
      if (err) throw new Error(err)
    },
    readPortfolio: async () => {
      const raw = readJson<Partial<Portfolio2>>(V2_PORTFOLIO_KEY)
      if (!raw) return null
      // 结构不完整时补齐空数组，避免上层拿到 undefined
      return { ...createEmptyPortfolio2(), ...raw } as Portfolio2
    },
  }
}

/** 供设置页展示迁移状态 */
export function readMigrationLog(): MigrationRecord[] {
  return readJson<MigrationRecord[]>(MIGRATION_LOG_KEY) ?? []
}

export function readDbMeta(): DbMeta | null {
  return readJson<DbMeta>(DB_META_KEY)
}
