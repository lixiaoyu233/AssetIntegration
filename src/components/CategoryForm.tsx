import { useEffect, useState } from 'react'
import { Check, Info, Trash2 } from 'lucide-react'
import type { Category } from '../types/asset'
import { CATEGORY_TEMPLATES } from '../lib/defaults'
import { ACCENT_NAMES } from '../lib/strategies'
import { ICON_NAMES, resolveIcon } from '../lib/icons'
import Sheet from './Sheet'

interface CategoryFormProps {
  open: boolean
  /** 传入表示编辑分类 */
  initial?: Category | null
  onSubmit: (patch: Pick<Category, 'name' | 'subtitle' | 'icon' | 'color' | 'colorName' | 'isLiability'>) => void
  onDelete?: () => void
  onClose: () => void
}

export default function CategoryForm({ open, initial, onSubmit, onDelete, onClose }: CategoryFormProps) {
  const [name, setName] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [icon, setIcon] = useState('wallet')
  const [colorName, setColorName] = useState<string | undefined>(ACCENT_NAMES[0])
  const [isLiability, setIsLiability] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setSubtitle(initial?.subtitle ?? '')
    setIcon(initial?.icon ?? 'wallet')
    setColorName(
      initial?.colorName ??
        ACCENT_NAMES[Math.floor(Math.random() * ACCENT_NAMES.length)],
    )
    setIsLiability(initial?.isLiability ?? false)
    setError(null)
  }, [open, initial])

  const applyTemplate = (t: (typeof CATEGORY_TEMPLATES)[number]) => {
    setName(t.name)
    setSubtitle(t.subtitle)
    setIcon(t.icon)
    setColorName(t.colorName)
    setIsLiability(t.isLiability ?? false)
  }

  const submit = () => {
    if (!name.trim()) {
      setError('请填写分类名称')
      return
    }
    onSubmit({
      name: name.trim(),
      subtitle: subtitle.trim(),
      icon,
      color: `var(--accent-${colorName ?? 'blue'})`,
      colorName,
      isLiability,
    })
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={initial ? '编辑分类' : '新增分类'}
      subtitle={initial ? initial.name : '自定义一个资产分类卡片'}
      footer={
        <div className="flex items-center gap-2.5 pb-1">
          <button type="button" className="btn-primary flex-1" onClick={submit}>
            {initial ? '保存' : '创建分类'}
          </button>
          {initial && onDelete ? (
            <button type="button" className="btn-danger px-3.5" onClick={onDelete} aria-label="删除分类">
              <Trash2 size={15} />
            </button>
          ) : null}
          <button type="button" className="btn-ghost px-4" onClick={onClose}>
            取消
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {!initial ? (
          <div>
            <p className="field-label">快速模板</p>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className="rounded-full border border-line bg-s2 px-3 py-1.5 text-[12px] text-ink2 transition hover:bg-s3 active:scale-95"
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <label className="field-label">名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 数字货币" className="field-input" />
        </div>

        <div>
          <label className="field-label">副标题描述</label>
          <input
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="如 交易所 / 冷钱包"
            className="field-input"
          />
        </div>

        <div>
          <p className="field-label">图标</p>
          <div className="grid grid-cols-6 gap-2">
            {ICON_NAMES.map((key) => {
              const Icon = resolveIcon(key)
              const active = key === icon
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setIcon(key)}
                  aria-label={key}
                  className={`flex h-11 items-center justify-center rounded-xl border transition ${
                    active ? 'border-line-strong bg-s3' : 'border-line bg-s2 hover:bg-s3'
                  }`}
                  style={active ? { color: `var(--accent-${colorName ?? 'blue'})` } : { color: 'var(--ink3)' }}
                >
                  <Icon size={18} />
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <p className="field-label">主题色</p>
          <div className="flex flex-wrap gap-2.5">
            {ACCENT_NAMES.map((name) => {
              const active = colorName === name
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setColorName(name)}
                  aria-label={`主题色 ${name}`}
                  className="flex h-8 w-8 items-center justify-center rounded-full border transition"
                  style={{
                    backgroundColor: `var(--accent-${name}-soft)`,
                    borderColor: active ? `var(--accent-${name})` : 'transparent',
                  }}
                >
                  {active ? <Check size={14} style={{ color: `var(--accent-${name})` }} /> : null}
                </button>
              )
            })}
          </div>
        </div>

        <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-line bg-s2 px-3.5 py-3">
          <span>
            <span className="block text-[13px] text-ink2">计入负债</span>
            <span className="mt-0.5 block text-[11px] text-ink4">开启后该分类合计会从净资产中扣减</span>
          </span>
          <input
            type="checkbox"
            checked={isLiability}
            onChange={(e) => setIsLiability(e.target.checked)}
            className="h-4 w-4 accent-brand"
          />
        </label>

        {error ? <p className="text-[12px] tone-danger">{error}</p> : null}

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink4">
          <Info size={12} className="mt-0.5 shrink-0" />
          分类与条目全部保存在浏览器 localStorage，不会上传到任何服务器。
        </p>
      </div>
    </Sheet>
  )
}
