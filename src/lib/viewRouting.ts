/**
 * 视图选择（Phase 8 / W3）
 *
 * 从 `main.tsx` 抽出为独立模块，原因：
 * 测试需要断言路由规则，但不应把 `main.tsx` 的 `bootstrap()` 副作用拖进测试。
 *
 * | 参数 | 视图 | 说明 |
 * | --- | --- | --- |
 * | （无） | **W3 AppShell** | 正式入口：首页 / 资产 / 分析 / 历史 / 设置 |
 * | `?w2=1` | W2 只读视图 | 兼容保留（W2 已验证的页面） |
 * | `?legacy=1` | 1.0 旧界面 | W1 的只读降级状态，显式选择的兜底 |
 *
 * ## 为什么三套视图并存不会产生两套业务事实源
 *
 * W2/W3 页面是**纯只读派生 + Repository 写入**，不含任何 localStorage 业务写入；
 * W1 已对旧 UI 做物理断写。因此三者共享同一个 IndexedDB 事实源。
 */
export type ViewKind = 'w3' | 'w2' | 'legacy'

/**
 * 构建时/运行时注入的视图覆盖。
 *
 * 存在的意义：**旧版 E2E 套件**在根路径寻找 1.0 的 DOM 结构。
 * W3 把根路径让给了正式应用后，这些套件需要一个不改动应用默认行为的开关。
 *
 * 用法：
 * - 测试环境变量：`VITE_FORCE_VIEW=legacy`（见 `resolveView` 的 `fallback` 参数）
 * - 或在页面加载前写入 `localStorage['wealthcard/ui/force-view']`
 *
 * ⚠️ 这是**诊断/测试开关**，不是产品功能；默认值始终是 `w3`。
 */
export const FORCE_VIEW_KEY = 'wealthcard/ui/force-view'

export type ForceViewHint = ViewKind | undefined

/**
 * 解析要渲染哪个视图。
 *
 * @param search  `location.search`
 * @param forced  强制视图（测试/诊断用）。**优先级最高**。
 *
 * 优先级：forced > localStorage 强制项 > `?legacy=1` > `?w2=1` > 默认 w3
 */
export function resolveView(search: string, forced?: ForceViewHint): ViewKind {
  if (forced === 'legacy' || forced === 'w2' || forced === 'w3') return forced

  const params = new URLSearchParams(search)

  // 页面加载前写入的强制项（E2E 用 addInitScript 注入）
  try {
    const stored = localStorage.getItem(FORCE_VIEW_KEY)
    if (stored === 'legacy' || stored === 'w2' || stored === 'w3') return stored
  } catch {
    /* 忽略：隐私模式下不可读，走默认 */
  }

  // legacy 优先：便于在排查时强制回到旧界面
  if (params.get('legacy') === '1') return 'legacy'
  if (params.get('w2') === '1') return 'w2'
  return 'w3'
}
