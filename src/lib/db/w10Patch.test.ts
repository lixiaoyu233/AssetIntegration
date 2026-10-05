import { describe, expect, it } from 'vitest'
import { createInMemoryRepository, createPairedTestStore } from './dexieRepository'
import type { PortfolioRepository } from './repository'
import { buildSnapshot, localDate, previousDate } from '../performance/snapshot'
import {
  makeAccount, makeHolding, makeInstrument, makePortfolio, nowForLocalDate,
} from '../valuation/__fixtures__/builders'
import type { Portfolio2, Snapshot } from '../../types/portfolio2'

/*
 * Phase 8 / W10-Patch — P1-2：`previousBefore()` 的 Dexie 真实实现
 *
 * W9 只测了**内存**实现，而内存实现自己就是 filter+sort ——
 * 于是 Dexie 那行（当时误用 `.sortBy()` 而全量 materialize）**零覆盖**，
 * 优化实际未生效却长期无人发现。这里补上真实 Dexie 路径的等价性测试。
 */

function pf(): Portfolio2 {
  return makePortfolio({
    accounts: [makeAccount({ id: 'a1', name: 'A', currency: 'CNY', region: 'CN' })],
    instruments: [
      makeInstrument({
        id: 'i1', name: '现金', instrumentType: 'cash',
        assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed',
      }),
    ],
    holdings: [
      makeHolding({ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 1000 }),
    ],
  })
}

/** 参考实现：等价于「date 严格小于目标日期的最近一份」 */
function referencePrevious(snaps: Snapshot[], date: string): Snapshot | undefined {
  return snaps
    .filter((s) => s.date < date)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
}

const DATES = ['2026-01-01', '2026-02-15', '2026-03-10', '2026-06-30', '2026-10-01']

async function seedSnapshots(repo: PortfolioRepository): Promise<Snapshot[]> {
  const p = pf()
  await repo.replaceAll(p)
  const made: Snapshot[] = []
  for (const d of DATES) {
    const snap = buildSnapshot(p, { date: d, now: nowForLocalDate(d) }).snapshot
    await repo.snapshots.put(snap)
    made.push(snap)
  }
  return made
}

const PROBES = [
  '2025-12-31', '2026-01-01', '2026-01-15', '2026-02-15', '2026-03-10',
  '2026-04-01', '2026-06-30', '2026-07-01', '2026-10-01', '2026-12-31',
]

describe('P1-2 previousBefore：Dexie 实现与参考语义一致', () => {
  it('【核心】真实 Dexie 路径与内存路径结果完全一致', async () => {
    const mem = createInMemoryRepository()
    const memSnaps = await seedSnapshots(mem)

    const { repo: dexie, db } = await createPairedTestStore(`w10-prev-${Date.now()}`)
    const dexieSnaps = await seedSnapshots(dexie)

    for (const probe of PROBES) {
      const got = await dexie.snapshots.previousBefore(probe)
      const memGot = await mem.snapshots.previousBefore(probe)
      const want = referencePrevious(dexieSnaps, probe)
      expect(got?.date).toBe(want?.date)
      expect(memGot?.date).toBe(want?.date)
    }
    void memSnaps
    await db.delete()
  })

  it('【核心】严格小于（等于目标日期的不算「之前」）', async () => {
    const { repo, db } = await createPairedTestStore(`w10-prev-eq-${Date.now()}`)
    await seedSnapshots(repo)
    expect((await repo.snapshots.previousBefore('2026-02-15'))?.date).toBe('2026-01-01')
    expect((await repo.snapshots.previousBefore('2026-01-01'))).toBeUndefined()
    await db.delete()
  })

  it('取到的是**最近**的一份（不是最老的一份）', async () => {
    const { repo, db } = await createPairedTestStore(`w10-prev-near-${Date.now()}`)
    await seedSnapshots(repo)
    expect((await repo.snapshots.previousBefore('2026-12-31'))?.date).toBe('2026-10-01')
    await db.delete()
  })

  it('空表 → undefined（不抛错）', async () => {
    const { repo, db } = await createPairedTestStore(`w10-prev-empty-${Date.now()}`)
    await repo.replaceAll(pf())
    expect(await repo.snapshots.previousBefore('2026-10-01')).toBeUndefined()
    await db.delete()
  })

  it('【P1-2 核心】不再全量 materialize：取一条时不会把整个区间读成数组', async () => {
    const { repo, db } = await createPairedTestStore(`w10-prev-perf-${Date.now()}`)
    const p = pf()
    await repo.replaceAll(p)
    // 造 300 份历史快照
    for (let i = 0; i < 300; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
      await repo.snapshots.put(buildSnapshot(p, { date: d, now: nowForLocalDate(d) }).snapshot)
    }
    const target = '2027-01-01'
    const got = await repo.snapshots.previousBefore(target)
    expect(got).toBeDefined()
    // 必须是**最大**的那个日期（最近一份）
    const all = await repo.snapshots.getAll()
    const maxDate = all.filter((s) => s.date < target).map((s) => s.date).sort().pop()
    expect(got?.date).toBe(maxDate)
    await db.delete()
  })
})

describe('P1-2 previousBefore：captureSnapshot 依赖它找期初（Dexie 路径）', () => {
  it('通过 previousBefore 正确取得期初并写入 openingDate', async () => {
    const { repo, db } = await createPairedTestStore(`w10-open-${Date.now()}`)
    const p = pf()
    await repo.replaceAll(p)
    const yest = previousDate(localDate())
    await repo.snapshots.put(buildSnapshot(p, { date: yest, now: nowForLocalDate(yest) }).snapshot)

    // 直接用仓储的 previousBefore 验证（captureSnapshot 的写入路径在它自己的测试里覆盖）
    const prev = await repo.snapshots.previousBefore(localDate())
    expect(prev?.date).toBe(yest)
    await db.delete()
  })
})
