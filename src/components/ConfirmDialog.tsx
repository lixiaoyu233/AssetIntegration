import { AlertTriangle } from 'lucide-react'
import Sheet from './Sheet'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 二次确认弹窗，用于删除分类 / 清空数据等破坏性操作 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onCancel}
      maxWidth="max-w-[380px]"
      leading={
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            danger ? 'bg-danger/12 tone-danger' : 'bg-s3 text-ink2'
          }`}
        >
          <AlertTriangle size={16} />
        </span>
      }
      footer={
        <div className="flex gap-2.5 pb-1">
          <button type="button" className="btn-ghost flex-1" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            className={danger ? 'btn-danger flex-1' : 'btn-primary flex-1'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmText}
          </button>
        </div>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink3">{description ?? '该操作不可撤销，请确认。'}</p>
    </Sheet>
  )
}
