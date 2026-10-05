import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  BACKUP_SNAPSHOT_KEY,
  exportBackup,
  parseBackupPayload,
  readStagingBackup,
  restoreBackup,
  rollbackFromStaging,
} from './backup'
import { createInMemoryRepository } from './dexieRepository'
import type { PortfolioRepository } from './repository'
import { makeAccount, makeHolding, makeInstrument, makePortfolio } from '../valuation/__fixtures__/builders'
import type { Portfolio2 } from '../../types/portfolio2'

/*
 * Phase 8 / W10-Patch — P0-2：回滚必须按真实返回值判定，且不得销毁唯一暂存
 *
 * 原实现在 `restoreBackup()` 返回 `{ok:false}` 时仍然
 * `clearStagingBackup()` + `return true`（谎报成功并删掉回滚点）。
 */

function pf(name: string): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: 'a1', name, currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({
        id: 'i1', name, instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed',
      }),
    ],
    holdings: [
      makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 12345 }),
    ],
  })
}

const nameOf = async (repo: PortfolioRepository) => (await repo.loadPortfolio()).accounts[0]?.name

let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
})
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage
})

/** 让下一次（或持续）replaceAll 抛错，用于注入写入失败 */
function failNextWrites(repo: PortfolioRepository, times: number) {
  const real = repo.replaceAll.bind(repo)
  let left = times
  ;(repo as unknown as { replaceAll: typeof real }).replaceAll = async (...args) => {
    if (left > 0) {
      left -= 1
      throw new Error('模拟写入失败（配额/多标签事务 Abort）')
    }
    return real(...args)
  }
  return () => {
    ;(repo as unknown as { replaceAll: typeof real }).replaceAll = real
  }
}

describe('P0-2 回滚：失败必须如实返回并保留暂存', () => {
  it('【核心】写入失败时 rollback 返回 false、数据未变、暂存仍存在', async () => {
    const repo = createInMemoryRepository()
    // ① 有效数据 GOOD
    await repo.replaceAll(pf('GOOD'))
    const exp = await exportBackup(repo)
    if (!exp.ok) throw new Error('导出失败：' + exp.message)
    const goodFile = exp.json

    // ② 导入坏数据 BAD（此时暂存保存 GOOD）
    const payload = parseBackupPayload(goodFile)!
    const imported = await restoreBackup(repo, { ...payload, portfolio: pf('BAD') })
    expect(imported.ok).toBe(true)
    expect(await nameOf(repo)).toBe('BAD')
    expect(JSON.parse(store.get(BACKUP_SNAPSHOT_KEY)!).payload.portfolio.accounts[0].name).toBe('GOOD')

    // ③ 注入写入失败
    const restore = failNextWrites(repo, 1)
    const rolled = await rollbackFromStaging(repo)

    // ④ 必须返回 false，且不得谎报成功
    expect(rolled).toBe(false)
    // ⑤ 数据必须仍是 BAD（未被部分写入）
    expect(await nameOf(repo)).toBe('BAD')
    // ⑥ 暂存必须仍存在，且内容仍是 GOOD
    expect(store.has(BACKUP_SNAPSHOT_KEY)).toBe(true)
    expect(JSON.parse(store.get(BACKUP_SNAPSHOT_KEY)!).payload.portfolio.accounts[0].name).toBe('GOOD')

    // ⑦ 故障排除后仍可继续尝试，并成功恢复 GOOD
    restore()
    const second = await rollbackFromStaging(repo)
    expect(second).toBe(true)
    expect(await nameOf(repo)).toBe('GOOD')
  })

  it('【核心】回滚成功后暂存才被清除（成功路径）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(pf('GOOD'))
    const exp = await exportBackup(repo)
    if (!exp.ok) throw new Error('导出失败：' + exp.message)
    const goodFile = exp.json
    const payload = parseBackupPayload(goodFile)!
    await restoreBackup(repo, { ...payload, portfolio: pf('BAD') })

    expect(await rollbackFromStaging(repo)).toBe(true)
    expect(await nameOf(repo)).toBe('GOOD')
    expect(store.has(BACKUP_SNAPSHOT_KEY)).toBe(false)
  })

  it('【核心】回滚不会用「当前坏数据」覆盖唯一正确的暂存', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(pf('GOOD'))
    const exp = await exportBackup(repo)
    if (!exp.ok) throw new Error('导出失败：' + exp.message)
    const goodFile = exp.json
    const payload = parseBackupPayload(goodFile)!
    await restoreBackup(repo, { ...payload, portfolio: pf('BAD') })

    // 连续多次回滚尝试（含失败），暂存内容必须始终是 GOOD
    const restore = failNextWrites(repo, 2)
    await rollbackFromStaging(repo)
    expect(JSON.parse(store.get(BACKUP_SNAPSHOT_KEY)!).payload.portfolio.accounts[0].name).toBe('GOOD')
    await rollbackFromStaging(repo)
    expect(JSON.parse(store.get(BACKUP_SNAPSHOT_KEY)!).payload.portfolio.accounts[0].name).toBe('GOOD')
    restore()
    expect(await rollbackFromStaging(repo)).toBe(true)
    expect(await nameOf(repo)).toBe('GOOD')
  })

  it('暂存缺失时回滚返回 false（不谎报）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(pf('GOOD'))
    expect(await rollbackFromStaging(repo)).toBe(false)
    expect(await nameOf(repo)).toBe('GOOD')
  })

  it('readStagingBackup 能报告暂存存在（供 UI 展示可回滚）', async () => {
    const repo = createInMemoryRepository()
    await repo.replaceAll(pf('GOOD'))
    const exp = await exportBackup(repo)
    if (!exp.ok) throw new Error('导出失败：' + exp.message)
    const goodFile = exp.json
    const payload = parseBackupPayload(goodFile)!
    await restoreBackup(repo, { ...payload, portfolio: pf('BAD') })
    expect(readStagingBackup()).not.toBeNull()
  })
})
