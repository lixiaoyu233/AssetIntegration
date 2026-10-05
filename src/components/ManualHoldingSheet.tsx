import { useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import type { Portfolio2 } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { createManualHolding } from '../lib/db/creation'
import Sheet from './Sheet'

/**
 * 创建手动口径持仓（Phase 8 / W7 冷启动）
 *
 * 适用：房产、应收、未确认分类的现金等 —— **不由交易驱动**的资产。
 *
 * ## 为什么不进 Ledger
 *
 * `valuationMode: 'manual'` 让它在 `rebuildHoldingsFromTransactions`
 * 中被原样保留，且默认不参与 `reconcileHoldings` 对账。
 * 价值靠 `manualValue` 表达，而不是靠交易累加。
 */
export interface ManualHoldingSheetProps {
  open: boolean
  onClose: () => void
  portfolio: Portfolio2
  repo: PortfolioRepository
  onCreated: () => void
  /**
   * 预定账户/标的（Phase 8 / W10-Patch，P0-3）。
   *
   * 用于「作废后补录」场景：作废让某项持仓失去全部账本依据并被清理后，
   * 用户可从这里一键带着原账户/标的打开登记表单，无需自己回忆。
   * 只作为**初始值**，用户仍可修改。
   */
  preset?: { accountId?: string; instrumentId?: string }
}

export default function ManualHoldingSheet({
  open,
  onClose,
  portfolio,
  repo,
  onCreated,
  preset,
}: ManualHoldingSheetProps) {
  const [accountId, setAccountId] = useState(
    preset?.accountId ?? portfolio.accounts[0]?.id ?? '',
  )
  const [instrumentId, setInstrumentId] = useState(preset?.instrumentId ?? '')
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  /** 已被该账户占用的标的（同一账户同一标的只能一条持仓） */
  const usedInAccount = useMemo(
    () => new Set(portfolio.holdings.filter((h) => h.accountId === accountId).map((h) => h.instrumentId)),
    [portfolio.holdings, accountId],
  )
  const available = portfolio.instruments.filter((i) => !usedInAccount.has(i.id))

  const submit = async () => {
    setBusy(true)
    setError(null)
    setDone(null)
    const r = await createManualHolding(repo, {
      accountId,
      instrumentId,
      manualValue: Number(value),
      note,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    const inst = portfolio.instruments.find((i) => i.id === instrumentId)
    setDone(`已记录手动持仓：${inst?.name ?? ''} ${r.holding.manualValue} ${inst?.currency ?? ''}`)
    setValue('')
    setNote('')
    onCreated()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="记录手动持仓"
      subtitle="房产 / 应收 / 未确认现金等，不由交易驱动"
      footer={
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2">
            关闭
          </button>
          <button
            type="button"
            disabled={busy || !instrumentId}
            onClick={() => void submit()}
            className="flex-1 rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
            data-testid="manual-save"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          这类持仓**不参与交易账本**，直接以「当前价值」表达。
          金额必须是**大于等于 0** 的有效数字 —— 无法估值时请不要记录，而不是填 0。
        </span>
      </p>

      {portfolio.accounts.length === 0 ? (
        <p className="mt-3 text-[12px] tone-warn" data-testid="manual-no-account">
          还没有账户。请先创建账户，再记录它的持仓。
        </p>
      ) : portfolio.instruments.length === 0 ? (
        <p className="mt-3 text-[12px] tone-warn" data-testid="manual-no-instrument">
          还没有标的。请先创建标的，再记录它的持仓。
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <label className="block text-[11px] text-ink3">
            账户
            <select
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value)
                setInstrumentId('')
              }}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="manual-account"
            >
              {portfolio.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}（{a.currency}）
                </option>
              ))}
            </select>
          </label>

          <label className="block text-[11px] text-ink3">
            标的
            <select
              value={instrumentId}
              onChange={(e) => setInstrumentId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="manual-instrument"
            >
              <option value="">请选择…</option>
              {available.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}（{i.currency}）
                </option>
              ))}
            </select>
            {available.length === 0 ? (
              <span className="mt-1 block text-[11px] tone-warn">
                该账户下所有标的都已有持仓。同一账户的同一标的只能有一条记录。
              </span>
            ) : null}
          </label>

          <label className="block text-[11px] text-ink3">
            当前价值（原币）
            <input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="例如 2500000"
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="manual-value"
            />
          </label>

          <label className="block text-[11px] text-ink3">
            备注（可留空）
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="manual-note"
            />
          </label>
        </div>
      )}

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="manual-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="manual-done">
          {done}
        </p>
      ) : null}
    </Sheet>
  )
}
