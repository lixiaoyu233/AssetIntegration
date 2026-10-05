/**
 * 迁移存储：Dexie / IndexedDB 实现
 *
 * 元信息与迁移日志放在 IndexedDB 的 `meta` 表（键值对），
 * 迁移后的正式数据写入各业务表。
 *
 * 与旧数据的关系：**只读写自己的键/表**，绝不触碰 1.x 的 localStorage 键。
 */

import type { Portfolio2 } from '../../types/portfolio2'
import { createEmptyPortfolio2 } from '../../types/portfolio2'
import type { PortfolioRepository, MigrationStore } from './repository'
import type { DbMeta, MigrationRecord } from './schema'

const META_KEY = 'db-meta'
const LOG_KEY = 'migration-log'

export function createDexieMigrationStore(repo: PortfolioRepository, db: {
  meta: { get(k: string): Promise<{ key: string; value: unknown } | undefined>; put(v: { key: string; value: unknown }): Promise<unknown> }
}): MigrationStore {
  return {
    async readMeta(): Promise<DbMeta | null> {
      const row = await db.meta.get(META_KEY)
      return (row?.value as DbMeta) ?? null
    },
    async writeMeta(meta: DbMeta): Promise<void> {
      await db.meta.put({ key: META_KEY, value: meta })
    },
    async readLog(): Promise<MigrationRecord[]> {
      const row = await db.meta.get(LOG_KEY)
      return (row?.value as MigrationRecord[]) ?? []
    },
    async writeLog(records: MigrationRecord[]): Promise<void> {
      await db.meta.put({ key: LOG_KEY, value: records })
    },
    async writePortfolio(portfolio: Portfolio2): Promise<void> {
      await repo.replaceAll(portfolio)
    },
    async readPortfolio(): Promise<Portfolio2 | null> {
      const counts = await repo.counts()
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      if (total === 0) return null
      const p = await repo.loadPortfolio()
      return { ...createEmptyPortfolio2(), ...p }
    },
  }
}
