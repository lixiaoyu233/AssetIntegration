import { Delete, X } from 'lucide-react'
import { scaleHintText } from '../lib/currency'

interface NumberPadProps {
  open: boolean
  /** 当前编辑的输入值（字符串，允许中途出现 "12." 这种非法中间态） */
  value: string
  /** 字段标题，如「金额 / 份额 / 单价」 */
  label: string
  /** 右侧单位，如 元 / 份 / 元/克 */
  unit?: string
  onChange: (next: string) => void
  onClose: () => void
  /** 快捷填入，如黄金常用克数 */
  quickValues?: Array<{ label: string; value: string }>
  /** 币种代码，非人民币时在顶部标出，避免误读成人民币 */
  currencyCode?: string
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'] as const

/**
 * 自研数字键盘：移动端录入金额比系统键盘更快，
 * 并且规避了部分输入法把 '.' 替换成 '。' 的问题。
 */
export default function NumberPad({
  open,
  value,
  label,
  unit,
  onChange,
  onClose,
  quickValues,
  currencyCode,
}: NumberPadProps) {
  if (!open) return null

  // 量级提示：把当前输入换算成数值后判断「最大一位是千/万/十万/百万」
  const parsed = Number(value.replace(/,/g, ''))
  const scale = Number.isFinite(parsed) && value !== '' ? scaleHintText(parsed) : '待输入'

  const press = (key: string) => {
    if (key === '.') {
      if (value.includes('.')) return
      onChange(value === '' ? '0.' : `${value}.`)
      return
    }
    // 避免 "007" 这类前导零
    if (value === '0') {
      onChange(key)
      return
    }
    // 限制整数部分长度，防止溢出
    const [intPart] = value.split('.')
    if (!value.includes('.') && intPart.length >= 12) return
    onChange(value + key)
  }

  const backspace = () => onChange(value.slice(0, -1))

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="收起键盘"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in cursor-default bg-scrim"
      />
      <div
        className="relative w-full max-w-[480px] animate-sheet-in overflow-hidden rounded-t-[22px] border border-line
          bg-s1 sm:rounded-[22px]"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5" style={{ paddingTop: 'max(var(--safe-top, 0px), 10px)' }}>
          <span className="flex items-center gap-1.5 text-[12px] text-ink4">
            {label}
            {/* 量级提示：直接告诉用户最大的那位是「万」还是「十万」 */}
            <span
              data-testid="numpad-scale"
              className="rounded-full border border-line px-1.5 py-0.5 text-[10.5px] text-ink3"
            >
              {scale}
            </span>
            {currencyCode && currencyCode !== 'CNY' ? (
              <span className="rounded-full border border-line px-1.5 py-0.5 text-[10.5px] tone-info">
                {currencyCode}
              </span>
            ) : null}
          </span>
          <div className="flex items-center gap-2">
            <span className="max-w-[210px] truncate text-right text-[20px] font-semibold tabular-nums text-ink1">
              {value || '0'}
              {unit ? <span className="ml-1 text-[12px] font-normal text-ink4">{unit}</span> : null}
            </span>
            <button type="button" onClick={onClose} className="rounded-full p-1.5 text-ink4 hover:text-ink2" aria-label="完成">
              <X size={16} />
            </button>
          </div>
        </div>

        {quickValues && quickValues.length > 0 ? (
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 py-2">
            {quickValues.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => onChange(q.value)}
                className="shrink-0 rounded-full border border-line bg-s2 px-3 py-1 text-[12px] text-ink2 active:scale-95"
              >
                {q.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-px bg-s3 p-px">
          {KEYS.slice(0, 9).map((k) => (
            <PadKey key={k} label={k} onClick={() => press(k)} />
          ))}
          <PadKey label="." onClick={() => press('.')} />
          <PadKey label="0" onClick={() => press('0')} />
          <PadKey label="⌫" aria-label="退格" onClick={backspace}>
            <Delete size={20} />
          </PadKey>
        </div>

        <div className="safe-bottom grid grid-cols-2 gap-px bg-s3 p-px pt-0">
          <button
            type="button"
            onClick={() => onChange('')}
            className="bg-s4 py-3.5 text-[15px] text-ink3 transition active:bg-keypad-active"
          >
            清空
          </button>
          <button
            type="button"
            onClick={onClose}
            className="bg-gold py-3.5 text-[15px] font-semibold text-on-invert transition active:bg-gold"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}

function PadKey({
  label,
  onClick,
  children,
  ...rest
}: {
  label: string
  onClick: () => void
  children?: React.ReactNode
} & React.AriaAttributes) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[58px] items-center justify-center bg-s2 text-[22px] font-medium text-ink1
        transition active:bg-keypad-active"
      {...rest}
    >
      {children ?? label}
    </button>
  )
}
