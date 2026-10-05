import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Portfolio2 } from '../../types/portfolio2'
import { createInMemoryRepository, createPairedTestStore } from './dexieRepository'
import type { PortfolioRepository } from './repository'
import {
  BACKUP_FORMAT,
  BACKUP_SNAPSHOT_KEY,
  canUpgradeFrom,
  checksumOf,
  countsOf,
  exportBackup,
  parseBackupPayload,
  readStagingBackup,
  restoreBackup,
  rollbackFromStaging,
  stableStringify,
  validateBackupText,
} from './backup'
import { createAccount, createInstrument, createManualHolding } from './creation'
import { PORTFOLIO_SCHEMA_VERSION } from './schema'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { resetReadOnlyMode } from '../readOnly'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'

/*
 * Phase 8 / W7 — Backup / Restore
 *
 * 核心安全要求：
 *   1. dry-run 不写任何数据
 *   2. 高版本硬拒绝；低版本走显式升级路径（不靠结构猜测）
 *   3. 坏数据即使结构合法也必须拒绝，且原数据完整保留
 *   4. 导入前必须落暂存备份，可回滚
 */

const NOW = () => new Date('2026-10-04T10:00:00.000Z')
const T0 = '2026-10-01T10:00:00.000Z'

function samplePortfolio(): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: 'a1', name: '示例人民币账户', currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({ id: 'i_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed' }),
      makeInstrument({ id: 'i_stock', name: '示例股票', symbol: 'T', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed' }),
    ],
    holdings: [
      makeHolding({ id: 'h_cash', accountId: 'a1', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000 }),
    ],
    transactions: [
      { id: 't1', accountId: 'a1', instrumentId: 'i_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: T0 },
    ],
  })
}

async function seedRepo(p: Portfolio2 = samplePortfolio()): Promise<PortfolioRepository> {
  const repo = createInMemoryRepository()
  await repo.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })
  return repo
}

/*
 * node 测试环境没有 localStorage。
 *
 * 这里注入一个最小替身（与 `readOnly.test.ts` 的做法一致），
 * 因为暂存备份依赖它 —— 而「暂存失败必须中止导入」是 W7 的核心安全要求，
 * 必须能被真实地测到。
 */
function installLocalStorageStub(): void {
  const map = new Map<string, string>()
  const stub: Storage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  resetReadOnlyMode()
  installLocalStorageStub()
})
afterEach(() => resetReadOnlyMode())

/* ================================================================== *
 * 稳定序列化与校验和
 * ================================================================== */

describe('稳定序列化与校验和', () => {
  it('键序不同但内容相同的对象产生同一校验和', () => {
    const a = { x: 1, y: [1, 2], z: { p: 1, q: 2 } }
    const b = { z: { q: 2, p: 1 }, y: [1, 2], x: 1 }
    expect(checksumOf(stableStringify(a))).toBe(checksumOf(stableStringify(b)))
  })

  it('内容变化 → 校验和变化', () => {
    expect(checksumOf(stableStringify({ x: 1 }))).not.toBe(checksumOf(stableStringify({ x: 2 })))
  })

  it('数组顺序敏感（不能把顺序差异当同一份数据）', () => {
    expect(checksumOf(stableStringify([1, 2]))).not.toBe(checksumOf(stableStringify([2, 1])))
  })
})

/* ================================================================== *
 * 导出
 * ================================================================== */

describe('导出：带版本信封 + 体检', () => {
  it('信封包含 format / 版本 / 时间 / 计数 / 校验和 / 体检', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const env = r.envelope
    expect(env.format).toBe(BACKUP_FORMAT)
    expect(env.schemaVersion).toBe(PORTFOLIO_SCHEMA_VERSION)
    expect(env.dbVersion).toBeGreaterThan(0)
    expect(env.exportedAt).toBe(NOW().toISOString())
    expect(env.counts.transactions).toBe(1)
    expect(env.counts.accounts).toBe(1)
    expect(env.checksum).toHaveLength(16)
    expect(env.health.reconcileOk).toBe(true)
    expect(env.health.duplicatesOk).toBe(true)
  })

  it('【核心】导出包含完整交易流水（1.0 的导出会丢这些）', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    expect(r.envelope.data.portfolio.transactions).toHaveLength(1)
    expect(r.envelope.data.portfolio.transactions[0].id).toBe('t1')
    // 币种、汇率、快照、审计字段齐全
    expect(r.envelope.data.portfolio).toHaveProperty('fxRates')
    expect(r.envelope.data.portfolio).toHaveProperty('snapshots')
    expect(r.envelope.data.portfolio).toHaveProperty('classificationAudit')
  })

  it('导出会带出 meta（迁移记录），供恢复时保持版本一致', async () => {
    const repo = await seedRepo()
    await repo.metaKv.set('applied-migrations', ['x'])
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    expect(r.envelope.data.metaKv?.['applied-migrations']).toEqual(['x'])
  })
})

/* ================================================================== *
 * 校验：版本
 * ================================================================== */

describe('校验：版本策略', () => {
  it('V6 → V7 有登记路径，可升级', () => {
    expect(canUpgradeFrom(6)).toBe(true)
    expect(canUpgradeFrom(PORTFOLIO_SCHEMA_VERSION)).toBe(true)
    // 未知版本无路径
    expect(canUpgradeFrom(3)).toBe(false)
  })

  it('【核心】schemaVersion 高于当前 → 硬拒绝', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    const env = JSON.parse(r.json)
    env.schemaVersion = PORTFOLIO_SCHEMA_VERSION + 1

    const rep = validateBackupText(JSON.stringify(env))
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.kind === 'version' && b.detail.includes('高于'))).toBe(true)
  })

  it('低版本无登记路径 → 拒绝（不靠结构猜测）', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    const env = JSON.parse(r.json)
    env.schemaVersion = 3

    const rep = validateBackupText(JSON.stringify(env))
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.kind === 'version')).toBe(true)
  })

  it('低版本有登记路径 → 通过但给出提示', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    const env = JSON.parse(r.json)
    env.schemaVersion = 6

    const rep = validateBackupText(JSON.stringify(env))
    expect(rep.ok).toBe(true)
    expect(rep.warnings.some((wn) => wn.kind === 'version')).toBe(true)
  })
})

/* ================================================================== *
 * 校验：格式 / 校验和 / 结构
 * ================================================================== */

describe('校验：格式与完整性', () => {
  it('非 JSON → 拒绝', () => {
    const rep = validateBackupText('not json at all')
    expect(rep.ok).toBe(false)
    expect(rep.blockers[0].kind).toBe('format')
  })

  it('【核心】1.0 备份被明确拒绝并解释原因', () => {
    const legacy = JSON.stringify({ version: 2, categories: [{ id: 'c1', name: 'x', items: [] }] })
    const rep = validateBackupText(legacy)
    expect(rep.ok).toBe(false)
    expect(rep.blockers[0].detail).toContain('不是 WealthCard 2.0 的备份文件')
    expect(rep.blockers[0].detail).toContain('交易流水')
  })

  it('校验和不匹配 → 拒绝（文件被改过或损坏）', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    const env = JSON.parse(r.json)
    env.data.portfolio.accounts[0].name = '被篡改'

    const rep = validateBackupText(JSON.stringify(env))
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.kind === 'checksum')).toBe(true)
  })

  it('条目数不一致 → 拒绝', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    const env = JSON.parse(r.json)
    env.counts.accounts = 99 // 与 data 不符，但 checksum 只覆盖 data，故此处专测 counts

    const rep = validateBackupText(JSON.stringify(env))
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.kind === 'counts')).toBe(true)
  })

  it('缺少 data.portfolio → 拒绝', () => {
    const rep = validateBackupText(
      JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 1, schemaVersion: PORTFOLIO_SCHEMA_VERSION, dbVersion: 2, exportedAt: 'x' }),
    )
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.kind === 'structure')).toBe(true)
  })
})

/* ================================================================== *
 * 校验：引用完整性与唯一性（坏数据即使结构合法也必须拒绝）
 * ================================================================== */

describe('校验：引用完整性与唯一性', () => {
  /** 构造「结构合法但引用悬空」的备份 */
  async function backupWithMutation(mutate: (p: Portfolio2) => void): Promise<string> {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    const env = JSON.parse(r.json)
    mutate(env.data.portfolio)
    // 重新计算校验和，使「校验和」不再成为阻断原因 —— 专门测试引用完整性
    env.checksum = checksumOf(stableStringify(env.data))
    env.counts = countsOf(env.data.portfolio)
    return JSON.stringify(env)
  }

  it('【核心】持仓引用不存在的标的 → 拒绝', async () => {
    const text = await backupWithMutation((p) => {
      p.holdings[0].instrumentId = 'ghost'
    })
    const rep = validateBackupText(text)
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.kind === 'reference' && b.detail.includes('持仓→标的'))).toBe(true)
  })

  it('交易引用不存在的账户 → 拒绝', async () => {
    const text = await backupWithMutation((p) => {
      p.transactions[0].accountId = 'ghost'
    })
    const rep = validateBackupText(text)
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.detail.includes('交易→账户'))).toBe(true)
  })

  it('行情引用不存在的标的 → 拒绝', async () => {
    const text = await backupWithMutation((p) => {
      p.quotes.push({
        id: 'q1', instrumentId: 'ghost', priceKind: 'market_price', marketPrice: 1,
        currency: 'CNY', source: 'manual', timestamp: T0, status: 'MANUAL',
      })
    })
    const rep = validateBackupText(text)
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.detail.includes('行情→标的'))).toBe(true)
  })

  it('分类审计引用不存在的标的 → 拒绝（W7 审计发现的悬空审计）', async () => {
    const text = await backupWithMutation((p) => {
      p.classificationAudit = [
        {
          id: 'au1', instrumentId: 'ghost', action: 'confirm', at: T0,
          from: { assetClass: 'other', status: 'unconfirmed' },
          to: { assetClass: 'equity', status: 'confirmed' },
        },

      ]
    })
    const rep = validateBackupText(text)
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.detail.includes('审计→标的'))).toBe(true)
  })

  it('重复 ID → 拒绝（bulkPut 会静默覆盖）', async () => {
    const text = await backupWithMutation((p) => {
      p.accounts.push({ ...p.accounts[0] })
    })
    const rep = validateBackupText(text)
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.kind === 'structure' && b.detail.includes('重复 id'))).toBe(true)
  })

  it('快照日期重复 → 拒绝（&date 唯一索引会失败）', async () => {
    const text = await backupWithMutation((p) => {
      const snap = {
        id: 's1', date: '2026-10-01', totalAssets: 1, totalLiabilities: 0, netWorth: 1,
        currency: 'CNY' as const, assetAllocation: {}, attributionStatus: 'unavailable' as const,
        createdAt: T0, positions: [],
      }
      p.snapshots = [snap, { ...snap, id: 's2' }]
    })
    const rep = validateBackupText(text)
    expect(rep.ok).toBe(false)
    expect(rep.blockers.some((b) => b.detail.includes('快照日期重复'))).toBe(true)
  })
})

/* ================================================================== *
 * dry-run：绝不写入
 * ================================================================== */

describe('dry-run：校验与预览绝不写入任何数据', () => {
  it('【核心】校验前后数据指纹完全一致', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')

    const before = JSON.stringify(await repo.loadPortfolio())
    const rep = validateBackupText(r.json, await repo.loadPortfolio())
    expect(rep.ok).toBe(true)
    expect(rep.preview).toBeDefined()
    // 数据一字未改
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })

  it('预览给出「将替换 / 将写入」的条目数', async () => {
    const repo = await seedRepo()
    const r = await exportBackup(repo, { now: NOW })
    if (!r.ok) throw new Error('导出失败')

    const current = await repo.loadPortfolio()
    const rep = validateBackupText(r.json, current)
    expect(rep.preview?.incoming.transactions).toBe(1)
    expect(rep.preview?.current.transactions).toBe(1)
    expect(rep.preview?.willAdd).toBeGreaterThan(0)
  })

  it('被拒绝的备份同样不写任何数据', async () => {
    const repo = await seedRepo()
    const before = JSON.stringify(await repo.loadPortfolio())
    validateBackupText('garbage')
    expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
  })
})

/* ================================================================== *
 * 恢复：暂存备份 + 原子切换 + 回滚
 * ================================================================== */

describe('恢复：校验 → 暂存 → 原子切换 → 可回滚', () => {
  it('【核心】导入前必落暂存备份，且可回滚', async () => {
    const repo = await seedRepo()
    const before = await repo.loadPortfolio()

    // 构造一份不同的备份
    const other = createInMemoryRepository()
    const acc = await createAccount(other, { name: '另一个账户', type: 'bank', currency: 'CNY', now: NOW })
    if (!acc.ok) throw new Error(acc.message)
    const cash = await createInstrument(other, { name: 'USD现金', instrumentType: 'cash', assetClass: 'cash', currency: 'USD', now: NOW })
    if (!cash.ok) throw new Error(cash.message)
    const exported = await exportBackup(other, { now: NOW })
    if (!exported.ok) throw new Error('导出失败')

    const payload = parseBackupPayload(exported.json)
    if (!payload) throw new Error('解析失败')

    const res = await restoreBackup(repo, payload)
    expect(res.ok).toBe(true)
    expect(readStagingBackup()).not.toBeNull()

    const after = await repo.loadPortfolio()
    expect(after.accounts[0].name).toBe('另一个账户')

    // 回滚
    const rolled = await rollbackFromStaging(repo)
    expect(rolled).toBe(true)
    const restored = await repo.loadPortfolio()
    expect(restored.accounts[0].name).toBe(before.accounts[0].name)
  })

  it('【核心】导出 → 导入 往返一致（含交易与审计）', async () => {
    const source = await seedRepo()
    await source.instruments.confirmOne('i_stock', 'equity')
    const r = await exportBackup(source, { now: NOW })
    if (!r.ok) throw new Error('导出失败')
    const payload = parseBackupPayload(r.json)!

    const target = createInMemoryRepository()
    const res = await restoreBackup(target, payload)
    expect(res.ok).toBe(true)

    const a = await source.loadPortfolio()
    const b = await target.loadPortfolio()
    expect(b.transactions).toEqual(a.transactions)
    expect(b.accounts).toEqual(a.accounts)
    expect(b.instruments).toEqual(a.instruments)
    expect(b.holdings).toEqual(a.holdings)
    // 分类审计一并还原（否则审计悬空）
    expect(b.classificationAudit).toEqual(a.classificationAudit)
  })

  it('【核心】replaceAll 覆盖 classificationAudit 与 meta（W7 范围修复）', async () => {
    const repo = await seedRepo()
    const keep = await repo.loadPortfolio()
    await repo.instruments.confirmOne('i_stock', 'equity')
    expect((await repo.loadPortfolio()).classificationAudit).toHaveLength(1)

    // 用「没有审计记录」的数据恢复
    await repo.replaceAll(keep, { metaKv: { 'applied-migrations': ['x'] } })

    const after = await repo.loadPortfolio()
    // 审计被替换为空（引用不会悬空）
    expect(after.classificationAudit).toHaveLength(0)
    // meta 被覆盖写入
    expect(await repo.metaKv.get('applied-migrations')).toEqual(['x'])
  })

  it('replaceAudit=false 时保留既有审计（迁移/转换场景）', async () => {
    const repo = await seedRepo()
    await repo.instruments.confirmOne('i_stock', 'equity')
    const withAudit = await repo.loadPortfolio()

    await repo.replaceAll({ ...withAudit, classificationAudit: [] }, { replaceAudit: false })
    expect((await repo.loadPortfolio()).classificationAudit).toHaveLength(1)
  })

  it('暂存备份写入失败时中止，不碰数据', async () => {
    const repo = await seedRepo()
    const before = JSON.stringify(await repo.loadPortfolio())
    const stub = globalThis.localStorage as Storage
    const original = stub.setItem
    stub.setItem = () => {
      throw new Error('模拟存储配额耗尽')
    }
    try {
      const r = await exportBackup(repo, { now: NOW })
      if (!r.ok) throw new Error('导出失败')
      const payload = parseBackupPayload(r.json)!
      const res = await restoreBackup(repo, payload)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.message).toContain('暂存备份')
      // 原数据完整保留
      expect(JSON.stringify(await repo.loadPortfolio())).toBe(before)
    } finally {
      stub.setItem = original
    }
  })
})

/* ================================================================== *
 * IndexedDB 持久化
 * ================================================================== */

describe('IndexedDB：导出与恢复真正落库', () => {
  it('导出真实库 → 恢复到另一个库，数据一致', async () => {
    const { repo: src, db: db1 } = await createPairedTestStore(`w7-b1-${Date.now()}`)
    const p = samplePortfolio()
    await src.replaceAll({ ...p, holdings: rebuildHoldingsFromTransactions(p).holdings })
    const manual = await createManualHolding(src, {
      accountId: 'a1', instrumentId: 'i_stock', manualValue: 1234, now: NOW,
    })
    expect(manual.ok).toBe(true)

    const r = await exportBackup(src, { now: NOW })
    if (!r.ok) throw new Error('导出失败')

    const { repo: dst, db: db2 } = await createPairedTestStore(`w7-b2-${Date.now()}`)
    const res = await restoreBackup(dst, parseBackupPayload(r.json)!)
    expect(res.ok).toBe(true)
    expect((await dst.loadPortfolio()).holdings).toHaveLength(2)

    await db1.delete()
    await db2.delete()
  })
})

/* ================================================================== *
 * 暂存备份的 UI 状态读取
 * ================================================================== */

describe('暂存备份状态', () => {
  it('没有暂存时返回 null', () => {
    localStorage.removeItem(BACKUP_SNAPSHOT_KEY)
    expect(readStagingBackup()).toBeNull()
  })
})
