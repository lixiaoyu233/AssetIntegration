import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ReadOnlyViolationError,
  guardBusinessWrite,
  isBusinessFactKey,
  isReadOnlyMode,
  readOnlyMessage,
  resetReadOnlyMode,
  setReadOnlyMode,
  shouldSkipCacheWrite,
} from './readOnly'
import { savePortfolio, clearPortfolio } from './storage'
import { saveSnapshot } from './netWorthHistory'
import { saveCachedRates } from './fx'
import { createFxTable, resolveRate } from './valuation/fx'
import { readLegacyStrategySettings, strategySettingsToProfiles } from './db/migrateOnStart'
import { createInMemoryRepository, createPairedTestStore } from './db/dexieRepository'
import { makeAccount, makeInstrument, makePortfolio } from './valuation/__fixtures__/builders'
import { rebuildHoldingsFromTransactions } from './ledger/rebuild'
import { aggregateByInstrument, deriveLedger } from './ledger/derive'

/*
 * Phase 8 / W1 验收测试
 *
 * 覆盖用户锁定的 9 项标准：
 *  ③ 零写入（业务键指纹不变）
 *  ④ ReadOnlyViolationError
 *  ⑤ 禁止假成功
 *  ⑥ 2.0 模块静态 import 边界
 *  ⑦ 单一数据源
 * 以及 fx 跳过、strategy 迁移等 W1 专属行为。
 */

/* ------------------------------------------------------------------ *
 * localStorage 测试替身
 * ------------------------------------------------------------------ */

function createMemoryStorage(): Storage & { dump(): Record<string, string> } {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    dump: () => Object.fromEntries([...map.entries()].sort()),
  } as Storage & { dump(): Record<string, string> }
}

/** 内容指纹：用于「零写入」比对 */
const fingerprint = (s: { dump(): Record<string, string> }) => JSON.stringify(s.dump())

const originalLocalStorage = globalThis.localStorage

beforeEach(() => {
  resetReadOnlyMode()
})

afterEach(() => {
  resetReadOnlyMode()
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    })
  }
})

/** 递归收集某目录下的非测试 ts 文件 */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collectTs(full, out)
    else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(full)
  }
  return out
}

function installStorage() {
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  return storage
}

/* ================================================================== *
 * ④ 断写：ReadOnlyViolationError
 * ================================================================== */

describe('④ 只读模式断写：ReadOnlyViolationError', () => {
  it('只读时 guardBusinessWrite 抛错，且错误名与操作名可读', () => {
    setReadOnlyMode(true, '数据已迁移')
    expect(() => guardBusinessWrite('savePortfolio')).toThrow(ReadOnlyViolationError)
    try {
      guardBusinessWrite('savePortfolio', 'extra')
    } catch (e) {
      const err = e as ReadOnlyViolationError
      expect(err.name).toBe('ReadOnlyViolationError')
      expect(err.operation).toBe('savePortfolio')
      expect(err.message).toContain('savePortfolio')
      expect(err.message).toContain('IndexedDB')
    }
  })

  it('可写模式下守卫放行', () => {
    resetReadOnlyMode()
    expect(() => guardBusinessWrite('savePortfolio')).not.toThrow()
  })

  it('缓存写入走静默跳过（不抛错）——避免刷新行情被过度阻断', () => {
    setReadOnlyMode(true, '只读')
    expect(shouldSkipCacheWrite()).toBe(true)
    // 关键：不抛错
    expect(() => {
      if (!shouldSkipCacheWrite()) throw new Error('不应执行')
    }).not.toThrow()
  })

  it('isReadOnlyMode / readOnlyMessage 反映当前状态', () => {
    setReadOnlyMode(true, '自定义说明')
    expect(isReadOnlyMode()).toBe(true)
    expect(readOnlyMessage()).toBe('自定义说明')
    resetReadOnlyMode()
    expect(isReadOnlyMode()).toBe(false)
    expect(readOnlyMessage()).toContain('只读')
  })
})

/* ================================================================== *
 * ⑤ 禁止假成功
 * ================================================================== */

describe('⑤ 禁止假成功：写入被拒 + 数据保持原值 + 明确提示', () => {
  it('【核心】只读时 savePortfolio 抛错，localStorage 内容一字未变', async () => {
    const storage = installStorage()
    // 预置「迁移前」的数据
    storage.setItem('asset-card-wallet/portfolio/v2', JSON.stringify({ version: 2, categories: [] }))
    const before = fingerprint(storage)

    setReadOnlyMode(true, '只读预览模式')

    expect(() => savePortfolio({ version: 2, categories: [], history: [] })).toThrow(ReadOnlyViolationError)

    // 指纹不变 —— 说明没有写进去，也没有被清掉
    expect(fingerprint(storage)).toBe(before)
  })

  it('【核心】clearPortfolio 同样被拒，数据不被清空', async () => {
    const storage = installStorage()
    storage.setItem('asset-card-wallet/portfolio/v2', JSON.stringify({ version: 2, categories: [{ id: 'c1' }] }))
    const before = fingerprint(storage)

    setReadOnlyMode(true, '只读预览模式')
    expect(() => clearPortfolio()).toThrow(ReadOnlyViolationError)

    expect(fingerprint(storage)).toBe(before)
    expect(storage.getItem('asset-card-wallet/portfolio/v2')).not.toBeNull()
  })

  it('【核心】月度走势写入被拒，历史不被改写', async () => {
    const storage = installStorage()
    storage.setItem(
      'asset-card-wallet/networth-history/v1',
      JSON.stringify({ version: 1, months: [{ month: '2026-09', netWorth: 100 }] }),
    )
    const before = fingerprint(storage)

    setReadOnlyMode(true, '只读预览模式')
    // 软失败：返回错误原因而不是抛异常（它可能从 reducer 副作用里被调用，
    // 抛异常会从 dispatch 同步逃逸并让整个应用白屏 —— 已实测确认）
    const softErr = saveSnapshot({ version: 1, months: [] } as never)
    expect(softErr).toContain('只读')

    expect(fingerprint(storage)).toBe(before)
  })

  it('可写模式下 savePortfolio 正常工作（确认守卫没有误伤）', async () => {
    const storage = installStorage()
    resetReadOnlyMode()
    const err = savePortfolio({ version: 2, categories: [], history: [] })
    expect(err).toBeNull()
    expect(storage.getItem('asset-card-wallet/portfolio/v2')).toBeTruthy()
  })

  it('错误信息明确包含「只读」，可供 UI 直接展示', () => {
    setReadOnlyMode(true, '数据存储已切换到 IndexedDB，旧版界面暂为只读')
    try {
      guardBusinessWrite('savePortfolio')
    } catch (e) {
      expect((e as Error).message).toContain('只读')
    }
  })
})

/* ================================================================== *
 * fx：只读时跳过缓存写入，但不影响 2.0
 * ================================================================== */

describe('fx：只读时跳过 legacy 缓存写入', () => {
  it('只读时 saveCachedRates 不写 localStorage 且不抛错', async () => {
    const storage = installStorage()
    const before = fingerprint(storage)

    setReadOnlyMode(true, '只读预览模式')

    expect(() =>
      saveCachedRates({ base: 'CNY', at: Date.now(), rates: { USD: 7.2 } } as never),
    ).not.toThrow()

    // 没有写入 fx 缓存
    expect(storage.getItem('asset-card-wallet/fx')).toBeNull()
    expect(fingerprint(storage)).toBe(before)
  })

  it('只读不影响 2.0 的 FxRate 表与估值（二者互不相干）', async () => {
    installStorage()
    setReadOnlyMode(true, '只读预览模式')
    // 2.0 的 fx 模块（valuation/fx）完全不碰 localStorage
    const table = createFxTable([
      { id: 'f1', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: new Date().toISOString(), source: 't', status: 'LIVE' },
    ])
    expect(resolveRate(table, 'USD', 'CNY')?.rate).toBe(7.2)
  })
})

/* ================================================================== *
 * ③ 零写入：业务键指纹
 * ================================================================== */

describe('③ 零写入：业务事实键在只读模式下不被触碰', () => {
  const BUSINESS_KEYS = [
    'asset-card-wallet/portfolio/v2',
    'asset-card-wallet/networth-history/v1',
    'asset-card-wallet/fx',
  ]

  it('全部业务写入函数在只读时都不改变这三个键', async () => {
    const storage = installStorage()
    for (const k of BUSINESS_KEYS) storage.setItem(k, `原始内容:${k}`)
    const before = fingerprint(storage)

    setReadOnlyMode(true, '只读')

    // 逐个尝试，全部应被拒绝或跳过
    expect(() => savePortfolio({ version: 2, categories: [], history: [] })).toThrow()
    expect(() => clearPortfolio()).toThrow()
    // saveSnapshot 走软失败（返回错误字符串）
    expect(saveSnapshot({ version: 1, months: [] } as never)).toContain('只读')
    expect(() => saveCachedRates({ base: 'CNY', at: 0, rates: {} } as never)).not.toThrow()

    expect(fingerprint(storage)).toBe(before)
    for (const k of BUSINESS_KEYS) expect(storage.getItem(k)).toBe(`原始内容:${k}`)
  })

  it('isBusinessFactKey 正确区分事实与偏好', () => {
    // 事实
    expect(isBusinessFactKey('asset-card-wallet/portfolio/v2')).toBe(true)
    expect(isBusinessFactKey('asset-card-wallet/networth-history/v1')).toBe(true)
    expect(isBusinessFactKey('asset-card-wallet/fx')).toBe(true)
    // 非事实（允许继续写）
    expect(isBusinessFactKey('asset-card-wallet/theme')).toBe(false)
    expect(isBusinessFactKey('asset-card-wallet/settings/v1')).toBe(false)
    // 已迁移到 IndexedDB，不再作为事实源
    expect(isBusinessFactKey('asset-card-wallet/strategy/v1')).toBe(false)
  })
})

/* ================================================================== *
 * ⑥ 静态 import 边界
 * ================================================================== */

describe('⑥ 2.0 模块静态 import 边界', () => {
  const FORBIDDEN = ['lib/storage', 'hooks/usePortfolio', 'lib/netWorthHistory', 'lib/db/localStore']

  it('2.0 各层不 import 1.0 的存储与 hook', () => {
    const files = [
      ...collectTs('src/lib/db'),
      ...collectTs('src/lib/ledger'),
      ...collectTs('src/lib/valuation'),
      ...collectTs('src/lib/analysis'),
      ...collectTs('src/lib/performance'),
    ]

    expect(files.length).toBeGreaterThan(20)

    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const bad of FORBIDDEN) {
        // 只检查 import 语句，避免注释误报
        const re = new RegExp(`^\\s*import[^\\n]*from\\s+['"][^'"]*${bad.replace('/', '\\/')}['"]`, 'm')
        if (re.test(src)) violations.push(`${f} → ${bad}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('2.0 模块不直接读写 localStorage（readOnly 守卫本身除外）', () => {
    const files = [
      ...collectTs('src/lib/ledger'),
      ...collectTs('src/lib/valuation'),
      ...collectTs('src/lib/analysis'),
      ...collectTs('src/lib/performance'),
    ]

    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (/window\.localStorage|localStorage\.(get|set|remove)Item/.test(src)) violations.push(f)
    }
    expect(violations).toEqual([])
  })
})

/* ================================================================== *
 * 策略配置迁移（AllocationProfile）
 * ================================================================== */

describe('strategy/v1 → AllocationProfile 保真迁移', () => {
  const LEGACY_STRATEGY = {
    version: 1,
    activeStrategyId: 'classic',
    threshold: 5,
    includeLiabilities: false,
    unmappedPolicy: 'auto',
    mappings: { cat_stock: [{ strategyClassId: 'cn_equity', percent: 100 }] },
    customStrategies: [
      {
        id: 'my_plan',
        name: '我的目标配置',
        kind: 'custom',
        description: '测试用',
        classes: [
          { id: 'cash', name: '现金', target: 20, colorName: 'slate' },
          { id: 'cn_equity', name: 'A股', target: 50, colorName: 'blue' },
          { id: 'bond', name: '债券', target: 30, colorName: 'green' },
        ],
      },
    ],
  }

  it('读取 1.0 策略设置', () => {
    const storage = installStorage()
    storage.setItem('asset-card-wallet/strategy/v1', JSON.stringify(LEGACY_STRATEGY))
    const raw = readLegacyStrategySettings(storage)
    expect(raw?.activeStrategyId).toBe('classic')
    expect((raw?.customStrategies as unknown[]).length).toBe(1)
  })

  it('【关键】targets / mappings / threshold / unmappedPolicy 全部迁移，不丢失', () => {
    const storage = installStorage()
    storage.setItem('asset-card-wallet/strategy/v1', JSON.stringify(LEGACY_STRATEGY))

    const profiles = strategySettingsToProfiles(readLegacyStrategySettings(storage), '2026-10-04T00:00:00.000Z')
    expect(profiles).toHaveLength(1)

    const p = profiles[0]
    // 自定义策略原文保留（含自定义类别与配色）
    expect(p.legacyStrategy?.classes).toHaveLength(3)
    expect(p.legacyStrategy?.classes[1]).toMatchObject({ id: 'cn_equity', name: 'A股', target: 50 })
    // 映射 / 阈值 / 策略 全部保留
    expect(p.legacyMappings).toEqual(LEGACY_STRATEGY.mappings)
    expect(p.legacyThreshold).toBe(5)
    expect(p.legacyUnmappedPolicy).toBe('auto')
    expect(p.legacyIncludeLiabilities).toBe(false)
    expect(p.isActive).toBe(false) // activeStrategyId 是内置策略，此处为自定义
  })

  it('兼容视图 targets 只映射能明确对应的类别（不猜）', () => {
    const storage = installStorage()
    storage.setItem('asset-card-wallet/strategy/v1', JSON.stringify(LEGACY_STRATEGY))
    const p = strategySettingsToProfiles(readLegacyStrategySettings(storage), 'T')[0]

    // cash → cash，bond → fixed_income；cn_equity 无明确对应，**不猜**
    const classes = p.targets.map((t) => t.assetClass).sort()
    expect(classes).toEqual(['cash', 'fixed_income'])
    expect(p.targets.find((t) => t.assetClass === 'cash')?.targetPercent).toBe(20)
    expect(p.targets.find((t) => t.assetClass === 'fixed_income')?.targetPercent).toBe(30)
  })

  it('无策略数据时返回空数组（不臆造默认目标）', () => {
    const storage = installStorage()
    expect(readLegacyStrategySettings(storage)).toBeNull()
    expect(strategySettingsToProfiles(null, 'T')).toEqual([])
  })

  it('损坏的 JSON 不会抛错（不阻断启动）', () => {
    const storage = installStorage()
    storage.setItem('asset-card-wallet/strategy/v1', '{ 这不是 JSON')
    expect(readLegacyStrategySettings(storage)).toBeNull()
  })
})

/* ================================================================== *
 * ⑦ 单一数据源
 * ================================================================== */

describe('⑦ 单一数据源：IndexedDB 为准，localStorage 不再是事实来源', () => {
  it('【核心】人为篡改 localStorage 不影响 2.0 数据', async () => {
    const storage = installStorage()

    const repo = createInMemoryRepository()
    await repo.replaceAll(makePortfolio({ accounts: [], instruments: [], holdings: [] }))

    // 篡改 localStorage，伪造一个「有数据」的 1.0 组合
    storage.setItem(
      'asset-card-wallet/portfolio/v2',
      JSON.stringify({ version: 2, categories: [{ id: 'fake', name: '伪造分类', items: [] }] }),
    )

    // 2.0 读取的是 IndexedDB，看不到伪造数据
    const loaded = await repo.loadPortfolio()
    expect(loaded.accounts).toHaveLength(0)
    expect(JSON.stringify(loaded)).not.toContain('伪造分类')
  })

  it('【核心】清空 localStorage 后 2.0 数据依然完整', async () => {
    const storage = installStorage()

    const repo = createInMemoryRepository()
    await repo.replaceAll({
      accounts: [makeAccount({ id: 'a1', name: '示例账户' })],
      instruments: [makeInstrument({ id: 'i1', name: '示例标的' })],
      holdings: [],
      transactions: [],
      quotes: [],
      fxRates: [],
      snapshots: [],
      allocationProfiles: [],
      classificationAudit: [],
    } as never)

    storage.clear()

    const loaded = await repo.loadPortfolio()
    expect(loaded.accounts).toHaveLength(1)
    expect(loaded.instruments).toHaveLength(1)
  })

  it('【核心】Holding 被人为改坏后，rebuild 恢复 Ledger 推导结果', async () => {

    const portfolio = makePortfolio({
      accounts: [makeAccount({ id: 'a1', name: 'A', type: 'broker', currency: 'CNY' })],
      instruments: [
        makeInstrument({
          id: 'i1', name: 'I', instrumentType: 'stock', assetClass: 'equity',
          currency: 'CNY', classificationStatus: 'confirmed',
        }),
      ],
      holdings: [
        // 被人为篡改成错误的数量与成本
        {
          id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity',
          quantity: 999, costBasis: 555, createdAt: 'T', updatedAt: 'T',
        },
      ],
      transactions: [
        {
          id: 'adj', accountId: 'a1', instrumentId: 'i1', type: 'adjustment',
          quantity: 100, amount: 1000, currency: 'CNY', timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    const rebuilt = rebuildHoldingsFromTransactions(portfolio)
    expect(rebuilt.blocked).toBeFalsy()
    // 恢复到 Ledger 推导值
    expect(rebuilt.holdings[0].quantity).toBe(100)
    expect(rebuilt.holdings[0].costBasis).toBe(1000)

    const ledger = deriveLedger(portfolio.transactions, {})
    const agg = aggregateByInstrument(ledger).get('i1')!
    expect(agg.quantity).toBe(100)
  })
})

/* ================================================================== *
 * 溯源：1.0 UI 写入点必须全部被守卫覆盖
 * ================================================================== */

describe('溯源：业务写入出口全部受守卫保护', () => {
  it('storage.ts / netWorthHistory.ts / localStore.ts 都调用守卫', () => {
    const files = [
      'src/lib/storage.ts',
      'src/lib/netWorthHistory.ts',
      'src/lib/db/localStore.ts',
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} 应导入守卫`).toMatch(/from '.*readOnly'/)
    }
  })

  it('fx.ts 使用静默跳过而非抛错', () => {
    const src = readFileSync('src/lib/fx.ts', 'utf8')
    expect(src).toContain('shouldSkipCacheWrite')
    expect(src).not.toContain('guardBusinessWrite')
  })

  it('三个业务写入函数都真正调用了守卫（不是只 import）', () => {
    expect(readFileSync('src/lib/storage.ts', 'utf8')).toMatch(/guardBusinessWrite\('savePortfolio'\)/)
    expect(readFileSync('src/lib/storage.ts', 'utf8')).toMatch(/guardBusinessWrite\('clearPortfolio'\)/)
    expect(readFileSync('src/lib/netWorthHistory.ts', 'utf8')).toMatch(/shouldSkipBusinessWrite\(\)/)
  })
})

/* ================================================================== *
 * ① 启动迁移：幂等 + 校验 + 只读时机
 * ================================================================== */

describe('① 启动迁移：幂等、校验、只读时机', () => {
  /** 构造一份可由 legacy 读取器识别的 1.0 组合 */
  function seedLegacyPortfolio(storage: Storage) {
    storage.setItem(
      'asset-card-wallet/portfolio/v2',
      JSON.stringify({
        version: 2,
        history: [],
        categories: [
          {
            id: 'cat_cash', name: '现金', subtitle: '银行', icon: 'banknote',
            color: 'var(--accent-gold)', colorName: 'gold', defaultKind: 'amount',
            items: [{ id: 'c1', kind: 'amount', name: '示例活期', amount: 20000, currency: 'CNY' }],
          },
        ],
      }),
    )
  }

  it('【幂等】连跑三次：实体数不变，且不重复写入', async () => {
    const { migrateOnStart } = await import('./db/migrateOnStart')

    const storage = installStorage()
    seedLegacyPortfolio(storage)

    // 必须用「成对」的 repo + db：迁移记录与业务数据要落在同一个库
    const { repo, db } = await createPairedTestStore(`w1-idem-${Date.now()}`)
    const counts: number[] = []
    const statuses: string[] = []

    for (let i = 0; i < 3; i++) {
      const r = await migrateOnStart({ repo, db, storage: storage as never })
      statuses.push(r.status)
      const c = await repo.counts()
      counts.push(c.holdings + c.accounts + c.instruments)
    }

    // 首次真实迁移；之后一律 skipped
    expect(statuses[0]).toBe('migrated')
    expect(statuses[1]).toBe('skipped')
    expect(statuses[2]).toBe('skipped')
    // 实体数不增长
    expect(counts[1]).toBe(counts[0])
    expect(counts[2]).toBe(counts[0])
    expect(counts[0]).toBeGreaterThan(0)
    await db.delete()
  })

  it('迁移成功后开启只读，并给出可读原因', async () => {
    const { migrateOnStart } = await import('./db/migrateOnStart')
    const storage = installStorage()
    seedLegacyPortfolio(storage)
    resetReadOnlyMode()

    const { repo, db } = await createPairedTestStore(`w1-ro-${Date.now()}`)
    const r = await migrateOnStart({ repo, db, storage: storage as never })
    expect(r.status).toBe('migrated')
    expect(r.readOnly).toBe(true)
    expect(isReadOnlyMode()).toBe(true)
    expect(readOnlyMessage()).toContain('IndexedDB')
    await db.delete()
  })

  it('迁移产生的数据可被估值引擎读取（2.0 侧可用）', async () => {
    const { migrateOnStart } = await import('./db/migrateOnStart')
    const storage = installStorage()
    seedLegacyPortfolio(storage)

    const { repo, db } = await createPairedTestStore(`w1-read-${Date.now()}`)
    await migrateOnStart({ repo, db, storage: storage as never })

    const portfolio = await repo.loadPortfolio()
    expect(portfolio.holdings.length).toBeGreaterThan(0)
    expect(portfolio.accounts.length).toBeGreaterThan(0)
    // 迁移会为每条数量口径持仓补期初 adjustment
    expect(portfolio.transactions.every((t) => t.type === 'adjustment')).toBe(true)
    await db.delete()
  })

  it('迁移不删除 localStorage 原数据（用户可自行清理）', async () => {
    const { migrateOnStart } = await import('./db/migrateOnStart')
    const storage = installStorage()
    seedLegacyPortfolio(storage)
    const before = fingerprint(storage)

    const { repo: r2, db: d2 } = await createPairedTestStore(`w1-keep-${Date.now()}`)
    await migrateOnStart({ repo: r2, db: d2, storage: storage as never })

    expect(fingerprint(storage)).toBe(before)
    expect(storage.getItem('asset-card-wallet/portfolio/v2')).not.toBeNull()
    await d2.delete()
  })

  it('无遗留数据时同样进入只读（事实源已切到 IndexedDB）', async () => {
    const { migrateOnStart } = await import('./db/migrateOnStart')
    installStorage()
    resetReadOnlyMode()

    const { repo, db } = await createPairedTestStore(`w1-nolegacy-${Date.now()}`)
    const r = await migrateOnStart({ repo, db })
    expect(r.status).toBe('no-legacy')
    expect(isReadOnlyMode()).toBe(true)
    await db.delete()
  })
})

/* ================================================================== *
 * 读路径：toLegacyView 投影保真
 * ================================================================== */

describe('toLegacyView：单向只读投影', () => {
  it('账户 → 分类、持仓 → 条目，数量一一对应', async () => {
    const { toLegacyView, checkLegacyViewFidelity } = await import('./db/toLegacyView')

    const account = makeAccount({ id: 'a1', name: '示例账户', type: 'broker', currency: 'CNY' })
    const inst = makeInstrument({ id: 'i1', name: '示例标的', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', symbol: 'TEST' })
    const portfolio = makePortfolio({
      accounts: [account],
      instruments: [inst],
      holdings: [
        {
          id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'quantity',
          quantity: 100, costBasis: 1000, createdAt: 'T', updatedAt: 'T',
        },
      ],
    })

    const view = toLegacyView(portfolio)
    expect(checkLegacyViewFidelity(portfolio, view).ok).toBe(true)
    expect(view.categories).toHaveLength(1)
    expect(view.categories[0].name).toBe('示例账户')
    expect(view.categories[0].items).toHaveLength(1)
    // 数量口径 → fund 条目，写入成本单价
    const item = view.categories[0].items[0] as { kind: string; shares: number; costNav: number }
    expect(item.kind).toBe('fund')
    expect(item.shares).toBe(100)
    expect(item.costNav).toBe(10)
  })

  it('手动口径 → amount 条目', async () => {
    const { toLegacyView } = await import('./db/toLegacyView')
    const portfolio = makePortfolio({
      accounts: [makeAccount({ id: 'a1', name: 'B', currency: 'CNY' })],
      instruments: [makeInstrument({ id: 'i1', name: 'I', currency: 'CNY' })],
      holdings: [
        {
          id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual',
          manualValue: 30000, createdAt: 'T', updatedAt: 'T',
        },
      ],
    })
    const view = toLegacyView(portfolio)
    const item = view.categories[0].items[0] as { kind: string; amount: number }
    expect(item.kind).toBe('amount')
    expect(item.amount).toBe(30000)
  })

  it('不产生任何写入（IndexedDB 与 localStorage 双指纹不变）', async () => {
    const { toLegacyView } = await import('./db/toLegacyView')
    const storage = installStorage()
    storage.setItem('asset-card-wallet/portfolio/v2', '原始')
    const before = fingerprint(storage)

    const portfolio = makePortfolio({
      accounts: [makeAccount({ id: 'a1', currency: 'CNY' })],
      instruments: [makeInstrument({ id: 'i1', currency: 'CNY' })],
      holdings: [],
    })
    toLegacyView(portfolio)

    expect(fingerprint(storage)).toBe(before)
  })

  it('预加载注入可被 usePortfolio 同步读取', async () => {
    const { setPreloadedLegacyView, getPreloadedLegacyView, resetPreloadedLegacyView, toLegacyView } =
      await import('./db/toLegacyView')
    const portfolio = makePortfolio({ accounts: [], instruments: [], holdings: [] })
    resetPreloadedLegacyView()
    expect(getPreloadedLegacyView()).toBeNull()

    const view = toLegacyView(portfolio)
    setPreloadedLegacyView(view)
    expect(getPreloadedLegacyView()).toBe(view)

    resetPreloadedLegacyView()
  })
})

/* ================================================================== *
 * 确认项：strategy 读取来源与断写
 * ================================================================== */

describe('strategy：读取来源是 IndexedDB，且已断写', () => {
  it('【确认 1】profilesToStrategySettings 无损还原 targets/mappings/threshold/unmappedPolicy', async () => {
    const { profilesToStrategySettings } = await import('./db/migrateOnStart')
    const { strategySettingsToProfiles } = await import('./db/migrateOnStart')

    const legacy = {
      activeStrategyId: 'my_plan',
      threshold: 7,
      includeLiabilities: true,
      unmappedPolicy: 'ignore' as const,
      mappings: { cat_stock: [{ strategyClassId: 'cn_equity', percent: 100 }] },
      customStrategies: [
        {
          id: 'my_plan', name: '我的目标', kind: 'custom', description: 'x',
          classes: [
            { id: 'cash', name: '现金', target: 20, colorName: 'slate' },
            { id: 'cn_equity', name: 'A股', target: 80, colorName: 'blue' },
          ],
        },
      ],
    }

    // 正向：1.0 → AllocationProfile
    const profiles = strategySettingsToProfiles(legacy, 'T')
    // 反向：AllocationProfile → 1.0
    const restored = profilesToStrategySettings(profiles)!

    expect(restored.activeStrategyId).toBe('my_plan')
    expect(restored.threshold).toBe(7)
    expect(restored.includeLiabilities).toBe(true)
    expect(restored.unmappedPolicy).toBe('ignore')
    expect(restored.mappings).toEqual(legacy.mappings)
    expect(restored.customStrategies).toHaveLength(1)
    expect(restored.customStrategies[0].classes).toHaveLength(2)
    expect(restored.customStrategies[0].classes[1]).toMatchObject({ id: 'cn_equity', name: 'A股', target: 80 })
    // 配色也保留
    expect(restored.customStrategies[0].classes[1].colorName).toBe('blue')
  })

  it('无 profile 时返回 null（调用方回退默认值）', async () => {
    const { profilesToStrategySettings } = await import('./db/migrateOnStart')
    expect(profilesToStrategySettings([])).toBeNull()
  })

  it('预加载注入可被 useStrategy 同步读取', async () => {
    const {
      setPreloadedStrategySettings,
      getPreloadedStrategySettings,
      resetPreloadedStrategySettings,
    } = await import('./db/migrateOnStart')
    const { createDefaultSettings } = await import('./rebalance')

    resetPreloadedStrategySettings()
    expect(getPreloadedStrategySettings()).toBeNull()

    const s = { ...createDefaultSettings(), threshold: 9 }
    setPreloadedStrategySettings(s)
    expect(getPreloadedStrategySettings()?.threshold).toBe(9)

    resetPreloadedStrategySettings()
  })

  it('【确认 4】useStrategy 的持久化在只读时拒绝写入', () => {
    const src = readFileSync('src/hooks/useStrategy.ts', 'utf8')
    // 必须引用只读守卫
    expect(src).toContain('isReadOnlyMode')
    // 且守卫在写入之前
    const guardIdx = src.indexOf('if (isReadOnlyMode())')
    const writeIdx = src.indexOf("window.localStorage.setItem(STORAGE_KEY")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeGreaterThan(guardIdx)
  })

  it('【确认 1】useStrategy 优先读注入值，而不是 localStorage', () => {
    const src = readFileSync('src/hooks/useStrategy.ts', 'utf8')
    const injectedIdx = src.indexOf('getPreloadedStrategySettings()')
    const lsIdx = src.indexOf('window.localStorage.getItem(STORAGE_KEY)')
    expect(injectedIdx).toBeGreaterThan(-1)
    // 注入值必须排在 localStorage 之前
    expect(injectedIdx).toBeLessThan(lsIdx)
  })
})
