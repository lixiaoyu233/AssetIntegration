/**
 * 每日快照编排（Phase 8 / W2）
 *
 * ## 语义链（严格保持 Phase 4 已确定的规则）
 *
 * ```
 * 打开 App
 *   ↓
 * 今天已有 REAL 快照？
 *   ├─ 有 → 补齐 attempt = success（崩溃恢复），不做任何捕获
 *   └─ 无 → 今天已经尝试过？
 *            ├─ 尝试过（无论成败）→ 不再重试
 *            └─ 未尝试 → captureSnapshot()
 *                         ├─ 成功 → attempt = success
 *                         └─ 失败 → attempt = failed（当天不再重试）
 * ```
 *
 * ## 为什么需要 attempt 状态
 *
 * 「今天有没有快照」不足以保证「今天只尝试一次」：
 *
 * ```
 * 第 1 次启动：byDate(today) = none → captureSnapshot() → 失败
 * 第 2 次启动：byDate(today) = none → 又 captureSnapshot()   ← 违反约束
 * ```
 *
 * 因此必须**持久化**记录「今天是否已尝试过」。存在 `meta` 表里
 * （键值状态，**不是资产事实**），不为此新建表。
 *
 * ## attempt 与 captureKind 是两件事
 *
 * | 概念 | 位置 | 含义 |
 * | --- | --- | --- |
 * | `captureKind` | 快照记录内 | 这份快照**怎么来的**：REAL / BACKFILLED / ESTIMATED |
 * | `attempt` | meta 键值 | 今天**是否尝试过**捕获（不论成败） |
 *
 * `failed` 的尝试**不产生快照**，因此没有 `captureKind` 可言；
 * 二者描述的是不同问题，不可互相替代。
 *
 * ## 六条硬约束
 *
 * 1. 同一天最多一个 REAL 快照（依赖 `upsertForDate` 的 `date` 唯一索引）
 * 2. 不补历史（只捕获「今天」，绝不遍历过去日期）
 * 3. 不插值（缺失日期就是缺失）
 * 4. 失败不阻断 App 启动
 * 5. 当天失败不重复尝试
 * 6. 第二天允许重新尝试（键按日期区分）
 */

import type { Snapshot } from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { type CaptureOptions, captureSnapshot, localDate } from '../performance/snapshot'

/** 尝试状态 */
export type SnapshotAttemptStatus = 'success' | 'failed'

export interface SnapshotAttempt {
  date: string
  attemptedAt: string
  status: SnapshotAttemptStatus
  error?: string
  /** 是否由「快照已存在、仅补记状态」产生（崩溃恢复路径） */
  recovered?: boolean
}

/** meta 表键前缀；按日期区分，天然支持「第二天重新尝试」 */
export const SNAPSHOT_ATTEMPT_PREFIX = 'snapshot-attempt/'

export function snapshotAttemptKey(date: string): string {
  return `${SNAPSHOT_ATTEMPT_PREFIX}${date}`
}

/** 保留最近 N 天的尝试记录，避免 meta 表无限增长 */
export const ATTEMPT_RETENTION_DAYS = 30

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

export async function readSnapshotAttempt(
  repo: PortfolioRepository,
  date: string,
): Promise<SnapshotAttempt | undefined> {
  return repo.metaKv.get<SnapshotAttempt>(snapshotAttemptKey(date))
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

export type DailySnapshotOutcome =
  /** 快照已存在，本次不做捕获 */
  | { action: 'already-captured'; date: string; snapshot: Snapshot; recoveredAttempt: boolean }
  /** 本次成功捕获 */
  | { action: 'captured'; date: string; snapshot: Snapshot }
  /**
   * 当天快照已存在、本次**刷新**了它（Phase 8 / W7）。
   *
   * 与 `captured` 的区别：`captured` 是当天首次生成，`recaptured` 是同日重算。
   * 历史快照**永远不会**产生这个动作。
   */
  | { action: 'recaptured'; date: string; snapshot: Snapshot }
  /** 今天已尝试过且失败，不再重试 */
  | { action: 'attempted-failed'; date: string; error?: string }
  /** 捕获失败（首次尝试），App 必须继续正常运行 */
  | { action: 'capture-failed'; date: string; error: string }

export interface DailySnapshotOptions extends CaptureOptions {
  /** 注入时钟便于测试 */
  now?: number
}

/* ------------------------------------------------------------------ *
 * 编排
 * ------------------------------------------------------------------ */

/**
 * 确保今天有一份 REAL 快照（幂等）。
 *
 * **本函数绝不抛出**：任何失败都转换为 `capture-failed` 结果，
 * 由调用方决定是否提示，但**不阻断应用启动**。
 */
export async function ensureDailySnapshot(
  repo: PortfolioRepository,
  options: DailySnapshotOptions = {},
): Promise<DailySnapshotOutcome> {
  const now = options.now ?? Date.now()
  // 用**本地日**：UTC 日会让 UTC+8 用户在清晨被判「昨天已有快照」而整天不捕获
  const date = options.date ?? localDate(new Date(now))
  const attemptedAt = new Date(now).toISOString()

  try {
    /* ---- 1) 已有当天快照 ---- */
    const existing = await repo.snapshots.byDate(date)
    if (existing) {
      /*
       * ## 当日快照允许刷新（Phase 8 / W7 修正）
       *
       * ### 原行为及其问题
       *
       * 原实现「已存在即返回 already-captured，不做任何捕获」。
       * 后果：快照在**当天首次打开应用**时被冻结 ——
       * 之后录入交易、作废交易、改行情、改分类，
       * 当天快照都仍是清晨那份，而首页却显示「今日快照：已生成」。
       * 用户会误信当天数据。这与项目「禁止假成功」的原则冲突。
       *
       * ### 修正后的语义
       *
       * | 情形 | 行为 |
       * | --- | --- |
       * | 当天已有快照 | **允许刷新**（同日 upsert，保留 id/createdAt，并记录 capturedAt） |
       * | 历史已存在的快照 | **绝不触碰**（历史是当时的事实） |
       * | 月度迁移快照（`positions: []`） | **不刷新**，避免把它改写成日快照 |
       *
       * 刷新是幂等的：`captureSnapshot` 按 `&date` 覆盖同一条记录。
       */
      /*
       * 只有「目标日期 === 今天」才刷新。
       *
       * 显式传入历史日期（补录/测试）时必须**原样返回** ——
       * 否则就违反了「历史快照不被回溯改写」这条不变量。
       */
      const today = localDate(new Date(now))
      const prior = await readSnapshotAttempt(repo, date)

      /*
       * ### ① 崩溃恢复（先于一切判断）
       *
       * 「快照已写入、attempt 尚未写入就崩溃」时，attempt **缺失**。
       * 此时补记 success 并如实返回 —— 这是事实修复，与日期无关，
       * 因此必须放在 `date !== today` 判断**之前**。
       *
       * `failed` 同理：快照既然在，事实就是成功的。
       *
       * ⚠️ 顺序很关键：若先判 `date !== today` 直接返回，
       * 历史日期的恢复路径就永远不会走到这里（实现过程中真实踩到）。
       */
      if (!prior || prior.status !== 'success') {
        await repo.metaKv.set(snapshotAttemptKey(date), {
          date,
          attemptedAt,
          status: 'success',
          recovered: true,
        } satisfies SnapshotAttempt)
        return { action: 'already-captured', date, snapshot: existing, recoveredAttempt: true }
      }

      /*
       * ### ② 可否刷新
       *
       * | 条件 | 处理 |
       * | --- | --- |
       * | 迁移来的月度点（`positions: []`） | **不刷新**，保持原样 |
       * | 目标日期不是今天 | **不刷新**（历史快照是当时的事实） |
       * | 今天 + attempt=success | **刷新**（跟上当天后续的录入/作废/改行情） |
       */
      /*
       * ### 迁移来的月度快照：用 `capturedAt` 判定，而不是 `positions.length`
       *
       * ⚠️ 这里曾经写 `isMigratedMonthly = existing.positions.length === 0`，
       * 于是「**今天刚捕获的空快照**」被误判为「迁移来的月度点」→
       * 整天拒绝刷新 → 当天快照永久为 0，而首页仍显示「今日快照：已生成」。
       *
       * 该误判最常发生在**首次使用**：应用在挂载时就捕获了一份空快照
       * （此时还没有任何持仓），随后用户建立账户/持仓，却再也刷不动它。
       *
       * 正确判据：**迁移快照没有 `capturedAt`**（V8 之前由旧代码写入，
       * 或由 `legacy-v2-to-schema-v3` 生成），
       * 而今天由 `captureSnapshot` 产生的快照一定带 `capturedAt`。
       */
      const isLegacySnapshot = existing.capturedAt === undefined
      if (isLegacySnapshot || date !== today) {
        return { action: 'already-captured', date, snapshot: existing, recoveredAttempt: false }
      }

      const refreshed = await captureSnapshot(repo, { ...options, date, now })
      await repo.metaKv.set(snapshotAttemptKey(date), {
        date,
        attemptedAt,
        status: 'success',
      } satisfies SnapshotAttempt)
      return { action: 'recaptured', date, snapshot: refreshed.snapshot }
    }

    /* ---- 2) 今天已经尝试过：不再重试 ---- */
    const prior = await readSnapshotAttempt(repo, date)
    if (prior) {
      return { action: 'attempted-failed', date, error: prior.error }
    }

    /* ---- 3) 首次尝试捕获 ---- */
    let snapshot: Snapshot
    try {
      const result = await captureSnapshot(repo, { ...options, date, now })
      snapshot = result.snapshot
    } catch (e) {
      const message = e instanceof Error ? e.message : '快照捕获失败'
      // 记录失败，确保当天不再重试
      await repo.metaKv.set(snapshotAttemptKey(date), {
        date,
        attemptedAt,
        status: 'failed',
        error: message,
      } satisfies SnapshotAttempt)
      return { action: 'capture-failed', date, error: message }
    }

    await repo.metaKv.set(snapshotAttemptKey(date), {
      date,
      attemptedAt,
      status: 'success',
    } satisfies SnapshotAttempt)

    await pruneOldAttempts(repo, date)
    return { action: 'captured', date, snapshot }
  } catch (e) {
    // 最后一道保险：编排本身也不抛出
    return {
      action: 'capture-failed',
      date,
      error: e instanceof Error ? e.message : '快照编排失败',
    }
  }
}

/* ------------------------------------------------------------------ *
 * 清理
 * ------------------------------------------------------------------ */

/** 删除超过保留期的尝试记录（按日期字符串比较，天然有序） */
export async function pruneOldAttempts(
  repo: PortfolioRepository,
  today: string,
  retentionDays = ATTEMPT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(`${today}T00:00:00.000Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
  const cutoffKey = cutoff.toISOString().slice(0, 10)

  const keys = await repo.metaKv.keysWithPrefix(SNAPSHOT_ATTEMPT_PREFIX)
  let removed = 0
  for (const key of keys) {
    const date = key.slice(SNAPSHOT_ATTEMPT_PREFIX.length)
    if (date < cutoffKey) {
      await repo.metaKv.remove(key)
      removed += 1
    }
  }
  return removed
}

/* ------------------------------------------------------------------ *
 * 展示辅助
 * ------------------------------------------------------------------ */

/** 供 UI 展示的一句话状态 */
export function describeDailySnapshot(outcome: DailySnapshotOutcome): string {
  switch (outcome.action) {
    case 'captured':
      return '今日资产快照已记录'
    case 'recaptured':
      return '今日资产快照已按最新数据刷新'
    case 'already-captured':
      return outcome.recoveredAttempt ? '今日快照已存在（已补记状态）' : '今日快照已记录'
    case 'attempted-failed':
      return `今日快照未能生成：${outcome.error ?? '原因未知'}`
    case 'capture-failed':
      return `今日快照未能生成：${outcome.error}`
  }
}
