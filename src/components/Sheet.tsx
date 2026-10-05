import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock'

interface SheetProps {
  open: boolean
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  /** 底部固定操作区 */
  footer?: ReactNode
  /** 标题左侧自定义节点（如分类图标） */
  leading?: ReactNode
  maxWidth?: string
}

/**
 * 移动端风格的底部弹出面板（同时兼容 PC：居中 + 最大宽度 480px）。
 * 负责：遮罩点击关闭、Esc 关闭、打开时锁定 body 滚动、底部安全区适配。
 */
export default function Sheet({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  leading,
  maxWidth = 'max-w-[480px]',
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    /*
     * 用引用计数的滚动锁，而不是「保存上一次的 overflow 再还原」：
     * 面板会叠加（详情 → 删除确认），后开的那个读到的是 hidden，
     * 当成原值存下来后关闭时会还原成 hidden，滚动就永久失效了。
     */
    lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlockBodyScroll()
    }
  }, [open, onClose])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in cursor-default bg-scrim backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative flex max-h-[92vh] w-full ${maxWidth} animate-sheet-in flex-col overflow-hidden
          rounded-t-[22px] border border-line bg-s1 shadow-[0_-8px_40px_-12px_rgba(0,0,0,0.95)]
          outline-none sm:rounded-[22px]`}
      >
        {/* 面板头部同样避开刘海，避免标题被状态栏压住 */}
        <div className="safe-top flex items-start gap-3 border-b border-line px-5 pb-4">
          {leading}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[16px] font-semibold text-ink1">{title}</h2>
            {subtitle ? <p className="mt-0.5 truncate text-[12px] text-ink4">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭面板"
            className="-mr-1 -mt-1 rounded-full p-2 text-ink4 transition hover:bg-s3 hover:text-ink2"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>

        {footer ? (
          <div className="safe-bottom border-t border-line bg-s1 px-5 pt-3">{footer}</div>
        ) : (
          <div className="safe-bottom" />
        )}
      </div>
    </div>
  )
}
