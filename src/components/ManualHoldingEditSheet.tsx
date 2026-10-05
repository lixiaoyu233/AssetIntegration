import { useState } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import type { Holding, Instrument } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { deleteManualHolding, updateManualHolding } from '../lib/db/editing'
import Sheet from './Sheet'

/**
 * 编辑 / 删除**手动口径**持仓（Post-Release / P1-7）
 *
 * ## 为什么只对手动口径开放
 *
 * 手动口径持仓（房产、应收、未确认现金…）**没有交易作为依据**，
 * `manualValue` 就是它的事实来源，所以可以直接改。
 *
 * 由交易派生的持仓是**缓存**：改了会被下一次重建覆盖，
 * 用户会看到「改完又变回去」。领域层 `updateManualHolding` 会直接拒绝，
 * 本组件只是把这条规则翻译成界面语言（并告诉用户正确做法）。
 *
 * ## 删除必须二次确认
 *
 * 手动持仓是这笔资产的**唯一记录**，删掉没有任何账本可以把它重建出来。
 * 因此按钮走两步：先「删除」→ 展开确认区 → 才真正执行，并写明不可撤销。
 */
export interface ManualHoldingEditSheetProps {
  open: boolean
  holding: Holding
  instrument?: Instrument
  repo: PortfolioRepository
  onClose: () => void
  onSaved: () => void
}

export default function ManualHoldingEditSheet({
  open,
  holding,
  instrument,
  repo,
  onClose,
  onSaved,
}: ManualHoldingEditSheetProps) {
  const [value, setValue] = useState(String(holding.manualValue ?? ''))
  const [note, setNote] = useState(holding.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const label = instrument?.name ?? holding.instrumentId
  const currency = instrument?.currency ?? ''

  const submit = async () => {
    setBusy(true)
    setError(null)
    const r = await updateManualHolding(repo, {
      id: holding.id,
      manualValue: Number(value),
      note,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    onSaved()
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    const r = await deleteManualHolding(repo, { id: holding.id })
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      setConfirmingDelete(false)
      return
    }
    onSaved()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="编辑手动持仓"
      subtitle={label}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2"
          >
            关闭
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="flex-1 rounded-xl bg-invert py-2.5 text-[13px] text-on-invert disabled:opacity-50"
            data-testid="manual-edit-save"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          这类持仓不参与交易账本，直接以「当前价值」表达。
          金额必须是大于等于 0 的有效数字；无法估值时请删除这条记录，而不是填 0。
        </span>
      </p>

      <div className="mt-3 space-y-3">
        <label className="block text-[11px] text-ink3">
          当前价值（{currency || '原币'}）
          <input
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="manual-edit-value"
          />
        </label>

        <label className="block text-[11px] text-ink3">
          备注（可留空）
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="manual-edit-note"
          />
        </label>
      </div>

      {error ? (
        <p
          className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn"
          data-testid="manual-edit-error"
        >
          {error}
        </p>
      ) : null}

      {/* 危险区：删除走两步，不可撤销必须写清楚 */}
      <div className="mt-4 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2.5">
        {!confirmingDelete ? (
          <>
            <p className="text-[11px] leading-relaxed tone-warn">
              删除后这条持仓与它的金额将不再存在。
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
              className="mt-2 w-full rounded-lg border border-warn/30 bg-s1 py-2 text-[12px] tone-warn disabled:opacity-50"
              data-testid="manual-edit-delete"
            >
              删除这条手动持仓
            </button>
          </>
        ) : (
          <>
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed tone-warn">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span>
                确认删除「{label}」？这条资产没有交易依据，删除后无法从账本重建，
                <span className="text-ink2">此操作不可撤销</span>。
              </span>
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
                className="flex-1 rounded-lg border border-line bg-s1 py-2 text-[12px] text-ink2 disabled:opacity-50"
                data-testid="manual-edit-delete-cancel"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                className="flex-1 rounded-lg border border-warn/30 bg-warn/15 py-2 text-[12px] tone-warn disabled:opacity-50"
                data-testid="manual-edit-delete-confirm"
              >
                {busy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}
