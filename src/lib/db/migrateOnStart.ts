/**
 * 启动迁移：localStorage → IndexedDB（Phase 8 / W1）
 *
 * ## 职责
 *
 * 1. 读取 1.0 遗留数据（`portfolio/v2` + 月度走势 + `strategy/v1`）；
 * 2. 走既有迁移链写入 IndexedDB（`migrate()`，幂等）；
 * 3. 把策略目标配置迁入 `AllocationProfile`；
 * 4. **保留** localStorage 原数据不删（用户可主动清理）；
 * 5. 迁移完成后开启**只读模式**，断开旧 UI 的业务写入。
 *
 * ## 幂等
 *
 * 重复执行不会重复写入：以 `MigrationRecord`（meta 表）为判据。
 *
 * ## 只读模式的时机
 *
 * **只有确认 2.0 数据可用之后**才开启只读。若迁移失败或 IndexedDB 不可用，
 * 不开启只读 —— 此时旧 UI 仍需可用（降级路径），总比彻底不能改数据好。
 */

import type { AllocationProfile, Portfolio2 } from '../../types/portfolio2'
import type { Strategy, StrategySettings } from '../../types/strategy'
import { createDefaultSettings } from '../rebalance'
import type { PortfolioRepository } from './repository'
import { createDexieMigrationStore } from './dexieMigrationStore'
import type { WealthCardDb } from './dexie'
import { hasLegacyData, readLegacyNetWorthPoints, readLegacyPortfolio } from './legacyStore'
import { migrate } from './migrations'
import { setReadOnlyMode } from '../readOnly'

/* ------------------------------------------------------------------ *
 * 策略配置 → AllocationProfile
 * ------------------------------------------------------------------ */

/** `strategy/v1` 的原始形状（只声明我们读取的字段，其余原样保留） */
interface LegacyStrategyClassLike {
  id?: unknown
  name?: unknown
  target?: unknown
  color?: unknown
  colorName?: unknown
}

interface LegacyStrategyLike {
  id?: unknown
  name?: unknown
  kind?: unknown
  description?: unknown
  classes?: unknown
}

interface LegacyStrategySettingsLike {
  version?: unknown
  activeStrategyId?: unknown
  customStrategies?: unknown
  mappings?: unknown
  threshold?: unknown
  includeLiabilities?: unknown
  unmappedPolicy?: unknown
}

export const STRATEGY_STORAGE_KEY = 'asset-card-wallet/strategy/v1'

/**
 * 读取 1.0 的策略配置。读取失败一律返回 `null`（不阻断启动）。
 */
export function readLegacyStrategySettings(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): LegacyStrategySettingsLike | null {
  try {
    const raw = storage.getItem(STRATEGY_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as LegacyStrategySettingsLike
  } catch {
    return null
  }
}

/**
 * 把 1.0 策略设置转换为 `AllocationProfile`。
 *
 * ## 为什么不能只填 `targets`
 *
 * `AllocationProfile.targets` 用的是 `AssetClass`（cash/equity/fixed_income/…），
 * 而 1.0 的 `StrategyClass.id` 是**任意字符串**（`'cash'`、`'cn_equity'`…），
 * 且每个 `StrategyClass` 自带 `name` 与 `color`。
 * 两者**不能无损映射**：强行映射会丢掉用户的自定义类别与配色。
 *
 * 因此这里**原样保留** `customStrategies` / `mappings` / `threshold` /
 * `unmappedPolicy` / `includeLiabilities`，只把 `targets` 作为兼容视图
 * 填给「能对上的」类别（`cash` 与 `equity` 之外的策略类不猜）。
 *
 * 这样既满足「目标配置归 IndexedDB」，又**不丢失也不臆造**任何用户配置。
 */
export function strategySettingsToProfiles(
  raw: LegacyStrategySettingsLike | null,
  now: string,
): AllocationProfile[] {
  if (!raw) return []

  const profiles: AllocationProfile[] = []
  const activeId = typeof raw.activeStrategyId === 'string' ? raw.activeStrategyId : undefined

  const collect = (list: unknown, kind: string): void => {
    if (!Array.isArray(list)) return
    for (const item of list as LegacyStrategyLike[]) {
      if (!item || typeof item !== 'object') continue
      const id = typeof item.id === 'string' ? item.id : ''
      if (!id) continue

      const classes = Array.isArray(item.classes) ? (item.classes as LegacyStrategyClassLike[]) : []
      // 兼容视图：只映射能明确对应 AssetClass 的两类，其余留空（不猜）
      const targets = classes
        .map((c) => {
          const cid = typeof c.id === 'string' ? c.id : ''
          const target = Number(c.target)
          if (!Number.isFinite(target)) return null
          const mapped = cid === 'cash' ? 'cash' : cid === 'bond' ? 'fixed_income' : null
          return mapped ? { assetClass: mapped as 'cash' | 'fixed_income', targetPercent: target } : null
        })
        .filter((x): x is { assetClass: 'cash' | 'fixed_income'; targetPercent: number } => x !== null)

      profiles.push({
        id: `alloc_${kind}_${id}`,
        name: typeof item.name === 'string' && item.name ? item.name : '迁移的目标配置',
        targets,
        fromTemplateId: id,
        createdAt: now,
        updatedAt: now,
        // 原样保留 1.0 的策略定义与映射，绝不丢失
        legacyStrategy: {
          id,
          name: typeof item.name === 'string' ? item.name : '',
          kind: typeof item.kind === 'string' ? item.kind : kind,
          description: typeof item.description === 'string' ? item.description : '',
          classes: classes.map((c) => ({
            id: typeof c.id === 'string' ? c.id : '',
            name: typeof c.name === 'string' ? c.name : '',
            target: Number(c.target) || 0,
            color: typeof c.color === 'string' ? c.color : undefined,
            colorName: typeof c.colorName === 'string' ? c.colorName : undefined,
          })),
        },
        legacyMappings: raw.mappings ?? undefined,
        legacyThreshold: typeof raw.threshold === 'number' ? raw.threshold : undefined,
        legacyIncludeLiabilities: typeof raw.includeLiabilities === 'boolean' ? raw.includeLiabilities : undefined,
        legacyUnmappedPolicy:
          raw.unmappedPolicy === 'auto' || raw.unmappedPolicy === 'ignore' ? raw.unmappedPolicy : undefined,
        isActive: activeId === id,
      })
    }
  }

  collect(raw.customStrategies, 'custom')
  return profiles
}

/* ------------------------------------------------------------------ *
 * 启动编排
 * ------------------------------------------------------------------ */

export interface StartupResult {
  status:
      | 'migrated'
      | 'skipped'
      | 'no-legacy'
      /**
       * `incomplete`：旧版数据尚未迁移完成，但 IndexedDB 里已有部分数据
       * （上次迁移中断/失败后用户又建了东西）。
       * ⚠️ 必须让用户看到 —— 绝不能当作 `skipped`（那会让迁移闸门永久关闭）。
       */
      | 'incomplete'
      | 'failed'
      | 'unavailable'
  /** 是否开启了只读模式 */
  readOnly: boolean
  reason?: string
  /** 迁移校验摘要（成功时） */
  verifyOk?: boolean
  profilesMigrated?: number
}

/**
 * 执行启动迁移。
 *
 * 刻意**不抛出**：启动流程不应因为迁移失败而白屏。
 * 失败时返回 `status: 'failed'` 且**不开启**只读模式（旧 UI 保持可写作为降级）。
 */
export async function migrateOnStart(options: {
  repo: PortfolioRepository
  /**
   * 与 `repo` **同一个**数据库实例。
   *
   * ⚠️ 必须传，不能省。
   *
   * 因为迁移记录（meta 表）与业务数据必须落在**同一个存储**里：
   * 早期实现允许省略 `db`，于是回落到 Dexie 单例 ——
   * 结果是「业务数据写进传入的 repo，迁移记录写进另一个数据库」，
   * 二者不一致：下次启动会读到「已迁移」而跳过，业务数据却是空的。
   * 这个 bug 在测试里表现为第二次迁移得到 0 条持仓。
   */
  db: WealthCardDb
  storage?: Storage
  /**
   * 是否读取并迁移 **1.x 的 localStorage 遗留数据**（默认 `true`）。
   *
   * ## 为什么需要这个开关（双版本并存）
   *
   * 2.0「资产整合」与 1.0 是两个**独立产品**，可部署在同一 origin 的
   * 不同子路径下（例如 `/AssetIntegration/` 与 `/WealthCard/`）。
   *
   * ⚠️ `localStorage` **按 origin 隔离、不按路径隔离** —— 因此 2.0 一旦启动
   * 就会读到 1.0 的 `asset-card-wallet/*` 键，把 1.0 数据迁移进自己的
   * IndexedDB，并 `setReadOnlyMode(true)` 让 **1.0 界面变成只读**。
   *
   * 这违反「两版本不互读、不迁移、不覆盖」，因此在 2.0 启动路径上显式传 `false`。
   *
   * ⚠️ **默认仍是 `true`**：保留本函数原有行为（已被测试覆盖）。
   * 传 `false` 时不读取任何 1.x 数据、**不删除也不写入任何键**。
   */
  readLegacyData?: boolean
  now?: () => Date
}): Promise<StartupResult> {
  const now = options.now ?? (() => new Date())
  const iso = now().toISOString()

  try {
    /* ---- 1) 无遗留数据：读 IndexedDB 现状判断 ---- */
    // 命名刻意区别于下面的 MigrationStore，避免混淆
    const legacyStorage =
      options.storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)

    /*
     * 双版本并存：不读、不迁移、不触碰 1.x 的遗留数据。
     *
     * 只开启只读（2.0 自身的事实源是 IndexedDB，不写 localStorage 业务键），
     * 并如实返回 `no-legacy` —— 既不谎报迁移成功，也不改动任何既有数据。
     */
    if (options.readLegacyData === false) {
      setReadOnlyMode(true, '独立部署：不读取旧版 localStorage 数据')
      return { status: 'no-legacy', readOnly: true, reason: '已关闭遗留数据迁移（独立部署）' }
    }

    const hasLegacy = hasLegacyData(legacyStorage as never)
    const existing = await options.repo.counts()

    if (!hasLegacy) {
      // 没有遗留数据：若 IndexedDB 里也什么都没有，建空组合
      if (existing.instruments === 0 && existing.accounts === 0) {
        setReadOnlyMode(true, '数据存储已切换到 IndexedDB（本机暂无可迁移的旧数据）')
        return { status: 'no-legacy', readOnly: true }
      }
      setReadOnlyMode(true, '数据存储已切换到 IndexedDB')
      return { status: 'skipped', readOnly: true, reason: '已迁移过' }
    }

    /*
     * ---- 2) 是否**已经迁移完成**：以 migration meta 为准 ----
     *
     * ## 为什么不能再看账户/标的计数（W11 Blocker Patch，P1-6）
     *
     * 原实现是 `existing.instruments > 0 || existing.accounts > 0` → 跳过。
     * 问题：用户在**迁移失败**后进入 2.0 空态、随手建了一个账户，
     * 下次启动就会命中该条件 → 迁移闸门**永久关闭**，
     * 他的 1.0 资产（仍在 localStorage）**再也不会被导入**，
     * 且应用内没有任何入口重开。
     *
     * 现在改为读 `meta` 的 `appliedMigrations` 与迁移日志 ——
     * 只有**确实迁移成功过**才跳过。
     */
    const gateStore = createDexieMigrationStore(options.repo, options.db)
    const startupMeta = await gateStore.readMeta()
    const migrationCompleted =
      startupMeta?.appliedMigrations?.some((id) => id.startsWith('legacy-')) ?? false
    const migrationLog = await gateStore.readLog()
    const hasSuccessfulRecord = migrationLog.some((r) => r.status === 'success')

    if (migrationCompleted || hasSuccessfulRecord) {
      setReadOnlyMode(true, '数据存储已切换到 IndexedDB')
      return { status: 'skipped', readOnly: true, reason: '已迁移过' }
    }

    /*
     * 未迁移完成，但 IndexedDB 里已有数据（上次中断/失败后用户建了东西）。
     * 如实报告 `incomplete`，**绝不谎报 skipped**、也不覆盖用户已有数据。
     */
    if (existing.instruments > 0 || existing.accounts > 0) {
      setReadOnlyMode(true, '数据存储已切换到 IndexedDB')
      return {
        status: 'incomplete',
        readOnly: true,
        reason:
          '检测到旧版本数据尚未完成迁移，但 IndexedDB 中已有部分数据。' +
          '旧数据仍完整保留在本机，未做任何改动。',
      }
    }

    /* ---- 3) 执行迁移 ---- */
    const legacy = readLegacyPortfolio(legacyStorage as never)
    if (!legacy.portfolio) {
      setReadOnlyMode(true, '数据存储已切换到 IndexedDB')
      return { status: 'skipped', readOnly: true, reason: '未找到旧版组合数据' }
    }

    const store = createDexieMigrationStore(options.repo, options.db)
    const outcome = await migrate({
      legacy: legacy.portfolio,
      netWorthPoints: readLegacyNetWorthPoints(legacyStorage as never),
      store,
      now,
    })

    if (outcome.status === 'failed') {
      // 迁移失败：保持旧 UI 可写（降级），不开启只读
      return { status: 'failed', readOnly: false, reason: '迁移校验未通过，旧数据保持可用' }
    }

    /* ---- 4) 策略目标配置 → AllocationProfile ---- */
    const profiles = strategySettingsToProfiles(
      readLegacyStrategySettings((legacyStorage ?? window.localStorage) as Storage),
      iso,
    )
    if (profiles.length > 0) {
      const portfolio = await options.repo.loadPortfolio()
      const merged: Portfolio2 = {
        ...portfolio,
        allocationProfiles: [...portfolio.allocationProfiles, ...profiles],
      }
      await options.repo.replaceAll(merged)
    }

    /* ---- 5) 注入策略设置，让旧策略界面从 IndexedDB 读 ---- */
    if (profiles.length > 0) {
      setPreloadedStrategySettings(profilesToStrategySettings(profiles))
    }

    /* ---- 6) 迁移完成，开启只读 ---- */
    setReadOnlyMode(true, '数据存储已切换到 IndexedDB，旧版界面暂为只读')

    return {
      status: 'migrated',
      readOnly: true,
      verifyOk: outcome.status === 'success' ? outcome.verify.ok : undefined,
      profilesMigrated: profiles.length,
    }
  } catch (e) {
    // 任何异常都不阻断启动，且不开启只读（保守：宁可旧 UI 可写，也不要彻底不能改）
    return {
      status: 'failed',
      readOnly: false,
      reason: e instanceof Error ? e.message : '启动迁移失败',
    }
  }
}


/* ------------------------------------------------------------------ *
 * AllocationProfile → StrategySettings（W1 读路径）
 * ------------------------------------------------------------------ */

let preloadedStrategySettings: StrategySettings | null = null

/**
 * 把迁移过来的 `AllocationProfile` 还原成 1.0 的 `StrategySettings`。
 *
 * 为什么需要：W1 把目标配置迁进了 IndexedDB，但旧策略界面仍按
 * `StrategySettings` 读取。若不注入，界面会继续读 localStorage 副本 ——
 * 那就等于 **localStorage 仍是业务读取来源**，与 W1 目标冲突。
 *
 * 由于迁移时**原样保留**了 `legacyStrategy` / `legacyMappings` /
 * `legacyThreshold` / `legacyUnmappedPolicy` / `legacyIncludeLiabilities`，
 * 这里是**无损反向还原**。
 */
export function profilesToStrategySettings(profiles: AllocationProfile[]): StrategySettings | null {
  if (profiles.length === 0) return null

  const customStrategies: Strategy[] = []
  const mappings: StrategySettings['mappings'] = {}
  let activeStrategyId: string | undefined
  let threshold: number | undefined
  let includeLiabilities: boolean | undefined
  let unmappedPolicy: 'auto' | 'ignore' | undefined

  for (const p of profiles) {
    if (p.legacyStrategy) {
      customStrategies.push({
        id: p.legacyStrategy.id,
        name: p.legacyStrategy.name,
        kind: 'custom',
        description: p.legacyStrategy.description,
        classes: p.legacyStrategy.classes.map((c) => ({
          id: c.id,
          name: c.name,
          target: c.target,
          color: c.color ?? `var(--accent-blue)`,
          colorName: c.colorName,
        })),
      })
    }
    if (p.legacyMappings && typeof p.legacyMappings === 'object') {
      Object.assign(mappings, p.legacyMappings as StrategySettings['mappings'])
    }
    if (p.legacyThreshold !== undefined) threshold = p.legacyThreshold
    if (p.legacyIncludeLiabilities !== undefined) includeLiabilities = p.legacyIncludeLiabilities
    if (p.legacyUnmappedPolicy !== undefined) unmappedPolicy = p.legacyUnmappedPolicy
    if (p.isActive) activeStrategyId = p.legacyStrategy?.id
  }

  // 没有任何可用内容时不注入，让调用方回退默认值
  if (customStrategies.length === 0 && Object.keys(mappings).length === 0 && !activeStrategyId) {
    return null
  }

  const base = createDefaultSettings()
  return {
    ...base,
    activeStrategyId: activeStrategyId ?? base.activeStrategyId,
    customStrategies,
    mappings,
    threshold: threshold ?? base.threshold,
    includeLiabilities: includeLiabilities ?? base.includeLiabilities,
    unmappedPolicy: unmappedPolicy ?? base.unmappedPolicy,
  }
}

/** 启动时注入从 IndexedDB 还原的策略设置 */
export function setPreloadedStrategySettings(settings: StrategySettings | null): void {
  preloadedStrategySettings = settings
}

/** 取预加载的策略设置（未设置时返回 null，调用方回退 localStorage） */
export function getPreloadedStrategySettings(): StrategySettings | null {
  return preloadedStrategySettings
}

/** 仅供测试 */
export function resetPreloadedStrategySettings(): void {
  preloadedStrategySettings = null
}
