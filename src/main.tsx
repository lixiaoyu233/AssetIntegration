import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import App2 from './pages/App2'
import AppShell from './pages/AppShell'
import { migrateOnStart } from './lib/db/migrateOnStart'
import { createDexieRepository } from './lib/db/dexieRepository'
import { getDb, requestPersistentStorage } from './lib/db/dexie'
import { setPreloadedLegacyView, toLegacyView } from './lib/db/toLegacyView'
import { setStartupMigrationStatus } from './lib/readOnly'
import { resolveView } from './lib/viewRouting'
import './index.css'


/**
 * 启动流程（Phase 8 / W1 建立，W3 扩展视图选择）
 *
 * ```
 * 1. 启动迁移：localStorage → IndexedDB（幂等）
 * 2. 迁移成功 → 开启只读模式，旧 UI 转为只读预览
 * 3. 渲染所选视图（默认 W3 AppShell）
 * ```
 *
 * ## 为什么在渲染前 await
 *
 * 只读标记必须在首次渲染前就位 —— 否则会先按可写模式挂载一次，
 * 可能出现「先写入再被拦」的窗口。
 *
 * ## 为什么不因为失败而白屏
 *
 * `migrateOnStart` 内部吞掉所有异常并返回状态。
 * 迁移失败时**不开启只读**，旧 UI 保持可写 —— 这是刻意的降级。
 */
async function bootstrap(): Promise<void> {
  // repo 与 db 必须是同一个数据库实例（否则迁移记录与业务数据会分裂到两处）
  let repo = createDexieRepository()

  /*
   * ## 请求持久化存储（Phase 8 / W7）
   *
   * ### 为什么必须做
   *
   * IndexedDB 是 2.0 的**唯一事实源**（W1 已断写 localStorage 业务事实），
   * 而浏览器在存储压力下可以**静默清除**它。iOS Safari 尤其会清理
   * 长期未访问站点的数据。请求 `persist()` 不能保证一定被授予，
   * 但能显著降低被自动回收的概率。
   *
   * ### 为什么放在迁移之前且不阻塞
   *
   * - `requestPersistentStorage` 内部吞掉所有异常，不支持时返回 false；
   * - 结果写入 meta 供设置页展示诚实状态（**绝不假成功**）；
   * - 无论成功与否都继续启动 —— 绝不让存储权限阻断正常使用。
   */
  try {
    const persisted = await requestPersistentStorage()
    await repo.metaKv.set('storage/persisted', {
      persisted,
      checkedAt: new Date().toISOString(),
    })
  } catch {
    // 存储状态记录失败不影响启动；也不谎报成功
  }

  try {
    const db = getDb()
    repo = createDexieRepository(db)
    /*
     * ⚠️ `readLegacyData: false` —— 本产品（2.0「资产整合」）**不读取**
     * 1.0 的 `asset-card-wallet/*` localStorage 遗留数据。
     *
     * 两者可部署在同一 origin 的不同子路径下，而 localStorage 按 origin
     * 隔离（不按路径）。若读取，会把 1.0 数据迁移进 2.0 的 IndexedDB，
     * 并让 1.0 界面被 `setReadOnlyMode` 变成只读 ——
     * 违反「两版本不互读、不迁移、不覆盖」。
     *
     * 1.0 的数据与界面完全不受影响。
     */
    const result = await migrateOnStart({ repo, db, readLegacyData: false })
    /*
     * 把迁移状态交给正式 2.0 UI（W11 Blocker Patch，P1-6）。
     *
     * 以前这里只用了 `result.readOnly`，`status` / `reason` 全部丢弃 ——
     * 迁移失败时用户只看得到一个「空应用 + 冷启动引导」，
     * 会以为 1.0 数据丢了，也不知道迁移其实没有成功。
     */
    setStartupMigrationStatus({ status: result.status, reason: result.reason })

    /*
     * 只读模式下的读路径（旧 UI 专用）：
     * 把 IndexedDB 里的 2.0 数据投影成 1.0 视图并**同步**注入，
     * 让 `usePortfolio` 首帧就读到迁移后的数据（而不是 localStorage 的旧副本）。
     */
    if (result.readOnly) {
      const portfolio = await repo.loadPortfolio()
      setPreloadedLegacyView(toLegacyView(portfolio))
    }
  } catch (e) {
    // 迁移编排本身不应抛出；这里只是最后一道保险，绝不阻断渲染
    console.warn('[wealthcard] 启动迁移失败，将以 1.0 行为继续运行：', e)
    setStartupMigrationStatus({
      status: 'failed',
      reason: e instanceof Error ? e.message : '启动迁移出现未知异常',
    })
  }

  const container = document.getElementById('root')
  if (!container) throw new Error('#root 容器不存在')

  /*
   * 视图选择。`VITE_FORCE_VIEW` 供旧版 E2E 套件在根路径强制回到 1.0 界面，
   * 不影响产品的默认入口（默认始终是 W3 正式应用）。
   */
  const forced = (import.meta.env.VITE_FORCE_VIEW as string | undefined) as
    | 'w3'
    | 'w2'
    | 'legacy'
    | undefined
  const view = resolveView(
    typeof window !== 'undefined' ? window.location.search : '',
    forced,
  )

  createRoot(container).render(
    <StrictMode>
      {view === 'legacy' ? <App /> : view === 'w2' ? <App2 /> : <AppShell repo={repo} />}
    </StrictMode>,
  )
}

void bootstrap()
