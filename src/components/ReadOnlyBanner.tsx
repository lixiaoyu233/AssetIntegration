import { Lock } from 'lucide-react'

/**
 * 只读模式提示横幅（Phase 8 / W1）
 *
 * ## 为什么必须常驻且不可关闭
 *
 * W1 把业务事实源切到 IndexedDB 后，旧界面的编辑功能被停用。
 * 如果用户看不到任何说明，会以为「应用坏了」或「数据丢了」——
 * 实际上数据完好，只是编辑入口暂时关闭。
 *
 * 同时它也是「禁止假成功」的一部分：
 * 用户尝试编辑时除了错误提示，界面上必须始终能看出当前是只读状态。
 *
 * ## 为什么用固定定位（Phase 8 / W2 修复）
 *
 * W1 最初把它放在内容流里，结果把 `h1` 从 ≤95px 推到了 **182px** ——
 * 这是 W1 遗留的真实 UI 回归（safearea 用例 ①⑤ 失败）。
 *
 * 改为 `position: fixed` 后：
 * - **不占用文档流** → 不再推挤首页布局，safearea 回归消除；
 * - 仍然**常驻可见** → 保留「必须让用户看见只读状态」的语义；
 * - 顶部细条 + 可展开详情，避免长期遮挡内容。
 *
 * 注意：它固定在**顶部**而不是底部 —— 底部已被 W2 的底部导航占用。
 */
export default function ReadOnlyBanner({ message }: { message?: string }) {
  return (
    <div
      className="fixed inset-x-0 top-0 z-50 border-b border-line bg-s2/95 backdrop-blur"
      data-testid="readonly-banner"
      role="status"
    >
      <div className="mx-auto flex max-w-[480px] items-center gap-1.5 px-4 py-1.5 text-[11px] text-ink2">
        <Lock size={12} className="shrink-0 text-ink3" />
        <span className="font-medium text-ink">只读预览模式</span>
        <span className="truncate text-ink4">
          · 数据已迁移，暂无法修改{message ? `（${message}）` : ''}
        </span>
      </div>
    </div>
  )
}

export { ReadOnlyBanner }
