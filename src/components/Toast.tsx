import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastMessage {
  id: number
  text: string
  tone: ToastTone
}

const icons = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const

const tones = {
  info: 'border-line bg-s2 text-ink2',
  success: 'border-down/25 bg-down/10 tone-good',
  error: 'border-danger/25 bg-danger/10 tone-danger',
} as const

/** 顶部轻提示，自动消失 */
export default function Toast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(onDismiss, toast.tone === 'error' ? 5200 : 2600)
    return () => window.clearTimeout(timer)
  }, [toast, onDismiss])

  if (!toast) return null
  const Icon = icons[toast.tone]

  return (
    /*
      位置：屏幕上方约 1/4 处。
      放这里的理由：顶部紧贴边缘会被 Safari 地址栏 / 灵动岛遮挡
      （env(safe-area-inset-top) 在 Safari 里是 0），而底部又离视线太远、
      容易和底部按钮打架。1/4 处既在安全区内，也在视线焦点附近。
      用 flex 撑满 + 顶部 25% 的 padding 实现，不依赖具体像素值。
    */
    <div
      className="pointer-events-none fixed inset-0 z-[80] flex items-start justify-center px-4"
      style={{ paddingTop: 'max(25vh, calc(var(--safe-top, 0px) + 56px))' }}
    >
      <div
        role="status"
        className={`pointer-events-auto flex max-w-[440px] animate-sheet-in items-start gap-2 rounded-2xl border px-3.5 py-3
          text-[13px] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.9)] backdrop-blur ${tones[toast.tone]}`}
      >
        <Icon size={15} className="mt-0.5 shrink-0" />
        <span className="flex-1 leading-snug">{toast.text}</span>
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 transition hover:opacity-100" aria-label="关闭提示">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
