/**
 * 只读模式守卫（Phase 8 / W1）
 *
 * ## 为什么需要它
 *
 * W1 把业务事实源从 localStorage 迁到 IndexedDB。
 * 但 1.0 遗留 UI 仍然会调用 `savePortfolio()` 等写入函数 ——
 * 如果不拦住，就会出现**两个可被用户修改的数据源**：
 *
 * ```
 * IndexedDB  ← 2.0 引擎
 * localStorage ← 1.0 UI        ← 二者会分叉
 * ```
 *
 * 这与 Phase 1–7 锁定的「Ledger 是唯一事实源」「禁止双轨同步」直接冲突。
 *
 * ## 断写放在持久化层，而不是按钮层
 *
 * 按钮禁用会被遗漏（14 个组件里任何一处漏拦就失效）；
 * 而持久化函数是**收口**。因此：
 *
 * ```
 * 旧 UI 点击保存 → 组件更新 state → savePortfolio() → 抛 ReadOnlyViolationError
 * ```
 *
 * ## 禁止「假成功」
 *
 * 抛出异常**不足以**避免数据幻觉 —— 组件可能已经把自己的 state 改成了新值，
 * 界面看起来「保存成功」了。因此调用方（`usePortfolio`）必须：
 *
 * 1. 捕获异常后**回滚组件 state**（或干脆不先改 state）；
 * 2. 显示「只读模式，当前无法修改」；
 * 3. **绝不**显示保存成功。
 *
 * 该行为由 `src/lib/readOnly.test.ts` 的「禁止假成功」用例锁定。
 */

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

let readOnly = false
let readOnlyReason = ''

/**
 * 开启只读模式。
 *
 * 由启动迁移在**业务数据已确定归属 IndexedDB** 之后调用。
 * 一旦开启，本进程内不再关闭（重新加载页面会重新判定）。
 */
export function setReadOnlyMode(on: boolean, reason = ''): void {
  readOnly = on
  readOnlyReason = reason
}

export function isReadOnlyMode(): boolean {
  return readOnly
}

export function readOnlyMessage(): string {
  return readOnlyReason || '当前为只读模式，无法修改数据'
}

/** 仅供测试：重置守卫状态 */
/* ------------------------------------------------------------------ *
 * 启动迁移状态（W11 Blocker Patch，P1-6）
 * ------------------------------------------------------------------ */

/**
 * 启动迁移的结果摘要，供**正式 2.0 UI** 感知并展示。
 *
 * ## 为什么必须存在
 *
 * `migrateOnStart()` 一直会返回 `status` / `reason`，但 `main.tsx` 只取了
 * `readOnly`，其余全部丢弃 —— 于是**迁移失败对用户完全不可见**：
 * 1.0 用户看到的是一个空应用 + 冷启动引导，会以为数据丢了。
 *
 * 更糟的是旧闸门按「账户/标的计数」判断是否跳过迁移，用户一旦在这个
 * 空态里建了任何数据，下次启动迁移就**永久不再执行**。
 *
 * 现在把状态存下来并展示，明确告诉用户：
 * - 迁移没有成功；
 * - 原 1.0 数据仍然存在（没有被删除）；
 * - 不要在未处理迁移问题前把「空库」当成正常状态。
 */
export interface StartupMigrationStatus {
  status: 'migrated' | 'skipped' | 'no-legacy' | 'incomplete' | 'failed' | 'unavailable'
  reason?: string
}

let migrationStatus: StartupMigrationStatus | null = null

/** 由 `main.tsx` 在启动编排后写入 */
export function setStartupMigrationStatus(next: StartupMigrationStatus | null): void {
  migrationStatus = next
}

/** 供 UI 读取；未启动迁移时为 null */
export function startupMigrationStatus(): StartupMigrationStatus | null {
  return migrationStatus
}

/**
 * 该启动状态是否需要**明确提示用户**（迁移未成功 / 未完成）。
 *
 * `migrated` 与 `no-legacy`（全新用户）属正常，不提示。
 * `failed` / `incomplete` / `unavailable` 必须提示。
 */
export function needsMigrationAttention(
  s: StartupMigrationStatus | null,
): boolean {
  if (!s) return false
  return s.status === 'failed' || s.status === 'incomplete' || s.status === 'unavailable'
}

/** 仅供测试：重置守卫状态（并清掉启动迁移状态，保证测试间隔离） */
export function resetReadOnlyMode(): void {
  migrationStatus = null
  readOnly = false
  readOnlyReason = ''
}

/* ------------------------------------------------------------------ *
 * 错误
 * ------------------------------------------------------------------ */

/**
 * 只读模式下尝试写入业务事实时抛出。
 *
 * 刻意**不是**静默返回：静默会让 UI 误以为写入成功（数据幻觉），
 * 而显式抛出能被上层捕获、提示用户、并让测试断言。
 */
export class ReadOnlyViolationError extends Error {
  /** 触发写入的函数名，便于定位遗漏的写入路径 */
  readonly operation: string
  constructor(operation: string, detail?: string) {
    super(
      `只读模式：拒绝执行 ${operation}。业务数据已迁移到 IndexedDB，localStorage 不再是事实来源。${detail ? `（${detail}）` : ''}`,
    )
    this.name = 'ReadOnlyViolationError'
    this.operation = operation
  }
}

/* ------------------------------------------------------------------ *
 * 守卫
 * ------------------------------------------------------------------ */

/**
 * 业务事实写入守卫：只读模式下**抛错**。
 *
 * 用于：`savePortfolio` / `clearPortfolio` / `saveSnapshot`（月度走势）/ localStore。
 */
export function guardBusinessWrite(operation: string, detail?: string): void {
  if (readOnly) throw new ReadOnlyViolationError(operation, detail)
}

/**
 * 业务事实写入的**软失败**判定：只读模式下返回 `true`。
 *
 * 与 `guardBusinessWrite` 的区别（两者都需要，场景不同）：
 *
 * | 函数 | 行为 | 适用 |
 * | --- | --- | --- |
 * | `guardBusinessWrite` | **抛异常** | 用户直接触发的写入（保存表单），需要显式失败 |
 * | `shouldSkipBusinessWrite` | **返回 true** | 可能从 React reducer 副作用里调用的写入，抛异常会白屏 |
 *
 * 两者都**不静默**：调用方仍必须把失败原因上报给用户。
 */
export function shouldSkipBusinessWrite(): boolean {
  return readOnly
}

/**
 * 非事实性缓存写入守卫：只读模式下**静默跳过**（返回 false）。
 *
 * 用于汇率缓存这类「丢了也能重新拉」的数据。
 * 刻意不抛错 —— 否则刷新行情会因为无法写缓存而报错，属于过度阻断。
 */
export function shouldSkipCacheWrite(): boolean {
  return readOnly
}

/* ------------------------------------------------------------------ *
 * 允许在只读模式写入的键（UI 偏好与用户配置）
 * ------------------------------------------------------------------ */

/**
 * 这些键**不属于资产事实**，只读模式下仍然可以写入。
 *
 * 判据：**它是否描述「用户拥有什么资产」**。
 * 不是的（主题、显示偏好、薪资记录、走势显示配置）可以留。
 */
export const NON_FACT_STORAGE_KEYS: readonly string[] = [
  'asset-card-wallet/theme',
  'asset-card-wallet/settings/v1',
  '__acw_hidden__',
]

/**
 * 判断某个 localStorage 键是否属于「业务事实」。
 * 供测试穷尽检查使用 —— 新增键时会被测试提醒。
 */
export function isBusinessFactKey(key: string): boolean {
  if (NON_FACT_STORAGE_KEYS.includes(key)) return false
  // 迁移后的策略配置也不再是事实来源
  if (key === 'asset-card-wallet/strategy/v1') return false
  return true
}
