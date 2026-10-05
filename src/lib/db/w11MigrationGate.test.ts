import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPairedTestStore } from './dexieRepository'
import { migrateOnStart } from './migrateOnStart'
import {
  needsMigrationAttention,
  resetReadOnlyMode,
  setStartupMigrationStatus,
  startupMigrationStatus,
} from '../readOnly'

/*
 * Phase 8 / W11 Blocker Patch — P1-6
 *
 * 原缺陷：迁移闸门按「accounts/instruments 表是否有数据」判断是否跳过，
 * 于是「迁移失败 → 用户进入 2.0 空态 → 建了任何数据 → 下次启动永久跳过」，
 * 且 `status`/`reason` 被 `main.tsx` 丢弃、用户完全看不到。
 *
 * 现在：闸门以 migration meta / 迁移日志为准；状态对 UI 可见。
 */

/* ---------------- localStorage stub ---------------- */

function installStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed))
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
    clear: () => map.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  })
  return { storage: storage as unknown as Storage, map }
}

const LEGACY_KEY = 'asset-card-wallet/portfolio/v2'

function legacyPayload(): string {
  return JSON.stringify({
    version: 2,
    history: [],
    categories: [
      {
        id: 'cat_cash', name: '现金', subtitle: '银行', icon: 'banknote',
        color: 'var(--accent-gold)', colorName: 'gold', defaultKind: 'amount',
        items: [{ id: 'c1', kind: 'amount', name: '示例活期', amount: 20000, currency: 'CNY' }],
      },
    ],
  })
}

beforeEach(() => resetReadOnlyMode())
afterEach(() => resetReadOnlyMode())

/* ================================================================== *
 * ① 正常路径
 * ================================================================== */

describe('P1-6 迁移闸门：正常路径', () => {
  it('【核心】首次带旧数据 → 真实迁移成功', async () => {
    const { storage } = installStorage({ [LEGACY_KEY]: legacyPayload() })
    const { repo, db } = await createPairedTestStore(`w11-mig-${Date.now()}`)
    const r = await migrateOnStart({ repo, db, storage })
    expect(r.status).toBe('migrated')
    expect((await repo.counts()).instruments).toBeGreaterThan(0)
    await db.delete()
  })

  it('【核心】迁移成功后再次启动 → skipped（不重复执行）', async () => {
    const { storage } = installStorage({ [LEGACY_KEY]: legacyPayload() })
    const { repo, db } = await createPairedTestStore(`w11-mig2-${Date.now()}`)
    const first = await migrateOnStart({ repo, db, storage })
    expect(first.status).toBe('migrated')
    const before = await repo.counts()

    const second = await migrateOnStart({ repo, db, storage })
    expect(second.status).toBe('skipped')
    const after = await repo.counts()
    expect(after.instruments).toBe(before.instruments)
    expect(after.holdings).toBe(before.holdings)
    await db.delete()
  })

  it('1.0 数据在迁移后仍然完整保留（不删除）', async () => {
    const { storage, map } = installStorage({ [LEGACY_KEY]: legacyPayload() })
    const { repo, db } = await createPairedTestStore(`w11-mig3-${Date.now()}`)
    await migrateOnStart({ repo, db, storage })
    expect(map.get(LEGACY_KEY)).toBe(legacyPayload())
    await db.delete()
  })
})

/* ================================================================== *
 * ② 关键回归：迁移未完成 + 用户已建数据 → 闸门不得永久关闭
 * ================================================================== */

describe('P1-6 闸门不再被「已有数据」永久关闭', () => {
  it('【核心】有旧数据 + IndexedDB 已有账户 → 报 incomplete（不是 skipped）', async () => {
    const { storage } = installStorage({ [LEGACY_KEY]: legacyPayload() })
    const { repo, db } = await createPairedTestStore(`w11-gate-${Date.now()}`)

    // 模拟：上次迁移失败后，用户在 2.0 空态里建了一个账户
    await repo.accounts.put({
      id: 'acc_user', name: '用户新建账户', type: 'bank', currency: 'CNY', region: 'CN',
      isLiability: false, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    } as never)

    const r = await migrateOnStart({ repo, db, storage })
    // 关键：绝不能是 skipped（那会让迁移永久不再执行）
    expect(r.status).not.toBe('skipped')
    expect(r.status).toBe('incomplete')
    expect(r.reason).toContain('尚未完成迁移')

    // 用户的 2.0 数据未被覆盖
    expect((await repo.counts()).accounts).toBe(1)
    await db.delete()
  })

  it('【核心】incomplete 状态下，下一次启动仍然识别为未完成（可继续处理）', async () => {
    const { storage } = installStorage({ [LEGACY_KEY]: legacyPayload() })
    const { repo, db } = await createPairedTestStore(`w11-gate2-${Date.now()}`)
    await repo.accounts.put({
      id: 'acc_user', name: 'A', type: 'bank', currency: 'CNY', region: 'CN',
      isLiability: false, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    } as never)

    for (let i = 0; i < 3; i++) {
      const r = await migrateOnStart({ repo, db, storage })
      expect(r.status).toBe('incomplete')
    }
    await db.delete()
  })

  it('【核心】旧数据仍完整保留（incomplete 不删不改）', async () => {
    const { storage, map } = installStorage({ [LEGACY_KEY]: legacyPayload() })
    const { repo, db } = await createPairedTestStore(`w11-gate3-${Date.now()}`)
    await repo.accounts.put({
      id: 'acc_user', name: 'A', type: 'bank', currency: 'CNY', region: 'CN',
      isLiability: false, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    } as never)
    await migrateOnStart({ repo, db, storage })
    expect(map.get(LEGACY_KEY)).toBe(legacyPayload())
    await db.delete()
  })

  it('【核心】incomplete 不会被 needsMigrationAttention 漏掉', () => {
    setStartupMigrationStatus({ status: 'incomplete', reason: 'x' })
    expect(needsMigrationAttention(startupMigrationStatus())).toBe(true)
    setStartupMigrationStatus({ status: 'failed', reason: 'y' })
    expect(needsMigrationAttention(startupMigrationStatus())).toBe(true)
    setStartupMigrationStatus({ status: 'unavailable' })
    expect(needsMigrationAttention(startupMigrationStatus())).toBe(true)
    // 正常状态不打扰用户
    setStartupMigrationStatus({ status: 'migrated' })
    expect(needsMigrationAttention(startupMigrationStatus())).toBe(false)
    setStartupMigrationStatus({ status: 'skipped' })
    expect(needsMigrationAttention(startupMigrationStatus())).toBe(false)
    setStartupMigrationStatus({ status: 'no-legacy' })
    expect(needsMigrationAttention(startupMigrationStatus())).toBe(false)
  })
})

/* ================================================================== *
 * ③ 无旧数据：全新用户不受影响
 * ================================================================== */

describe('P1-6 全新用户路径不受影响', () => {
  it('无旧数据 + 空库 → no-legacy（不提示）', async () => {
    const { storage } = installStorage()
    const { repo, db } = await createPairedTestStore(`w11-fresh-${Date.now()}`)
    const r = await migrateOnStart({ repo, db, storage })
    expect(r.status).toBe('no-legacy')
    expect(needsMigrationAttention({ status: r.status, reason: r.reason })).toBe(false)
    await db.delete()
  })

  it('无旧数据 + 已有数据 → skipped（正常幂等）', async () => {
    const { storage } = installStorage()
    const { repo, db } = await createPairedTestStore(`w11-fresh2-${Date.now()}`)
    await repo.accounts.put({
      id: 'acc_user', name: 'A', type: 'bank', currency: 'CNY', region: 'CN',
      isLiability: false, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    } as never)
    const r = await migrateOnStart({ repo, db, storage })
    expect(r.status).toBe('skipped')
    await db.delete()
  })
})
