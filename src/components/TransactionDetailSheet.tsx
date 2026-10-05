import { useMemo, useState } from 'react'
import type { Account, Instrument, Portfolio2, Transaction } from '../types/portfolio2'
import { TRANSACTION_TYPE_LABEL } from '../types/portfolio2'
import { hasExternalFlow } from '../lib/ledger/externalFlow'
import { isVoided, TRANSACTION_STATUS_LABEL } from '../lib/ledger/lifecycle'
import { inspectVoidImpact, voidTransaction } from '../lib/ledger/transactionService'
import type { PortfolioRepository } from '../lib/db/repository'
import Sheet from './Sheet'

/**
 * 交易详情 Sheet（Phase 8 / W4）
 *
 * ## 展示的是**真实派生关系**，不是另算一套
 *
 * 「这笔交易产生了什么效果」直接展示 `deriveLedger` 产出的
 * Ledger Effects（投资腿 / 现金腿 / 收入 / 已实现盈亏 / 费用），
 * 而不是在 UI 里重新推导一遍。
 *
 * ## 外部现金流归属
 *
 * 明确标注该交易是否属于外部流入 / 流出 —— 这是 Phase 4 的语义，
 * 关系到期初/期末净资产的归因，用户需要能看懂。
 */
export interface TransactionDetailSheetProps {
  transaction: Transaction
  portfolio: Portfolio2
  /** 作废需要经 Repository 写入 */
  repo: PortfolioRepository
  accountById: Map<string, Account>
  instrumentById: Map<string, Instrument>
  /** 该交易对应的 Ledger Effects（由调用方从 deriveLedger 取出） */
  effects: Array<{
    leg: 'instrument' | 'cash' | 'cash_target'
    instrumentId: string
    accountId: string
    quantityDelta: number
    costDelta: number
    cashDelta: number
    incomeDelta?: number
    feeDelta?: number
  }>
  /**
   * 作废成功后回调。
   *
   * `droppedOrphans` 是**因失去全部账本依据而被清理的持仓键**（P0-3）。
   * 父组件据此引导用户补录，避免「资产静默消失且无补救」。
   */
  onVoided: (transactionId: string, droppedOrphans: string[]) => void
  onClose: () => void
  /**
   * 补救入口：打开「手动持仓」登记表单（P0-3）。
   *
   * 由父组件提供，避免本组件直接依赖创建流程。
   */
  onRecoverManual?: (preset: { accountId: string; instrumentId: string }) => void
}

const n = (v: number) => v.toLocaleString('zh-CN', { maximumFractionDigits: 8 })
const signed = (v: number) => (v > 0 ? `+${n(v)}` : n(v))

export default function TransactionDetailSheet({
  transaction,
  portfolio,
  repo,
  accountById,
  instrumentById,
  effects,
  onVoided,
  onClose,
  onRecoverManual,
}: TransactionDetailSheetProps) {
  /*
   * 用本地 state 承载当前交易：作废后需要立刻反映状态，
   * 但**不直接改 props**（props 来自父组件派生结果）。
   */
  const [tx, setTx] = useState<Transaction>(transaction)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const voided = isVoided(tx)
  const external = useMemo(() => hasExternalFlow(tx.type), [tx.type])

  /*
   * 作废**前**预检（P0-3）：只读，复用与 `voidTransaction` 同一套判定。
   * 若作废会让某些持仓失去全部账本依据，必须在确认前明确告知 ——
   * 不能让用户以为这是一次普通的「已作废」。
   */
  const impact = useMemo(
    () => (voided ? { willDropHoldingKeys: [], dropsRealPositions: false } : inspectVoidImpact(portfolio, tx.id)),
    [portfolio, tx.id, voided],
  )

  /** 本次作废实际清理掉的持仓键（作废成功后填充，用于给出补救入口） */
  const [droppedOrphans, setDroppedOrphans] = useState<string[]>([])

  const doVoid = async () => {
    setBusy(true)
    setError(null)
    try {
      // 唯一允许的修正路径：作废（Phase 8 / W5）
      const result = await voidTransaction(repo, tx.id, { reason })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setTx(result.transaction)
      setConfirming(false)
      setDroppedOrphans(result.droppedOrphans)
      onVoided(result.transaction.id, result.droppedOrphans)
    } catch (e) {
      setError(e instanceof Error ? e.message : '作废失败')
    } finally {
      setBusy(false)
    }
  }

  const rows: Array<[string, string]> = [
    ['状态', TRANSACTION_STATUS_LABEL[voided ? 'VOIDED' : 'POSTED']],
    ['交易类型', TRANSACTION_TYPE_LABEL[tx.type] ?? tx.type],
    ['日期', new Date(tx.timestamp).toLocaleString('zh-CN')],
    ['账户', accountById.get(tx.accountId)?.name ?? tx.accountId],
  ]
  if (tx.toAccountId) rows.push(['目标账户', accountById.get(tx.toAccountId)?.name ?? tx.toAccountId])
  if (tx.instrumentId) rows.push(['标的', instrumentById.get(tx.instrumentId)?.name ?? tx.instrumentId])
  if (tx.cashInstrumentId) {
    rows.push(['资金账户', instrumentById.get(tx.cashInstrumentId)?.name ?? tx.cashInstrumentId])
  }
  if (tx.toCashInstrumentId) {
    rows.push(['换入账户', instrumentById.get(tx.toCashInstrumentId)?.name ?? tx.toCashInstrumentId])
  }
  if (tx.quantity !== undefined) rows.push(['数量', n(tx.quantity)])
  if (tx.transferQuantity !== undefined) rows.push(['划转数量', n(tx.transferQuantity)])
  rows.push(['金额', `${n(tx.amount)} ${tx.currency}`])
  if (tx.toAmount !== undefined) {
    rows.push(['到账金额', `${n(tx.toAmount)} ${tx.toCurrency ?? tx.currency}`])
  }
  if (tx.fee) rows.push(['手续费', n(tx.fee)])
  if (tx.note) rows.push(['备注', tx.note])
  if (tx.voidedAt) rows.push(['作废时间', new Date(tx.voidedAt).toLocaleString('zh-CN')])
  if (tx.voidReason) rows.push(['作废原因', tx.voidReason])

  return (
    <Sheet
      open
      onClose={onClose}
      title="交易详情"
      subtitle={TRANSACTION_TYPE_LABEL[tx.type] ?? tx.type}
      footer={
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2"
          data-testid="tx-detail-close"
        >
          关闭
        </button>
      }
    >
      <dl className="space-y-1.5 text-[12px]" data-testid="tx-detail-fields">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="shrink-0 text-ink3">{k}</dt>
            <dd className="min-w-0 break-all text-right text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      {/* 作废状态与操作 */}
      {voided ? (
        <div
          className="mt-3 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed tone-warn"
          data-testid="tx-voided-notice"
        >
          <p className="font-medium">该交易已作废</p>
          <p className="mt-0.5 text-ink4">
            已作废的交易**不参与当前 Ledger 计算**，仅保留记录用于审计。
            {tx.voidedAt ? `作废于 ${new Date(tx.voidedAt).toLocaleString('zh-CN')}。` : ''}
            {tx.voidReason ? `原因：${tx.voidReason}。` : ''}
          </p>
          <p className="mt-0.5 text-ink4">已作废交易不能再作废。</p>

          {/* P0-3：如实告知被清理的持仓，并给出可操作的补救入口 */}
          {droppedOrphans.length > 0 ? (
            <div
              className="mt-2 rounded-lg border border-warn/30 bg-s1 px-2 py-1.5 text-[11px] leading-relaxed"
              data-testid="tx-void-dropped"
            >
              <p className="font-medium tone-warn">
                以下持仓已失去全部账本依据，已被清理：
              </p>
              <ul className="mt-1 space-y-1">
                {droppedOrphans.map((k) => {
                  const [acc, inst] = k.split('::')
                  return (
                    <li key={k} className="flex items-center justify-between gap-2">
                      <span className="text-ink3">
                        {accountById.get(acc)?.name ?? acc} /{' '}
                        {instrumentById.get(inst)?.name ?? inst}
                      </span>
                      {onRecoverManual ? (
                        <button
                          type="button"
                          onClick={() => onRecoverManual({ accountId: acc, instrumentId: inst })}
                          className="shrink-0 rounded-lg border border-line bg-s2 px-2 py-0.5 text-[11px] text-ink2"
                          data-testid="tx-void-recover"
                          data-holding-key={k}
                        >
                          补录为手动持仓
                        </button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              <p className="mt-1 text-[10px] text-ink4">
                手动持仓不受交易驱动，登记后会立即计入资产（不会被作废影响）。
              </p>
            </div>
          ) : null}
        </div>
      ) : confirming ? (
        <div className="mt-3 rounded-xl border border-line bg-s2 px-3 py-2.5" data-testid="tx-void-confirm">
          <p className="text-[11px] leading-relaxed text-ink2">
            确认作废这笔交易？
            <br />
            作废后它不再参与资产计算，但记录会保留（不删除）。
            {!impact.dropsRealPositions ? ' 如果只是录错了，请作废后重新录入正确的一笔。' : ''}
          </p>

          {/* P0-3：会让持仓失去全部依据时，必须在确认前明确告知 */}
          {impact.dropsRealPositions ? (
            <div
              className="mt-2 rounded-lg border border-warn/30 bg-s1 px-2 py-1.5 text-[11px] leading-relaxed tone-warn"
              data-testid="tx-void-impact-warning"
            >
              <p className="font-medium">⚠️ 作废后该持仓将失去账本依据</p>
              <p className="mt-0.5">{impact.warning}</p>
              <ul className="mt-1 space-y-0.5 text-ink3">
                {impact.willDropHoldingKeys.map((k) => {
                  const [acc, inst] = k.split('::')
                  return (
                    <li key={k}>
                      · {accountById.get(acc)?.name ?? acc} /{' '}
                      {instrumentById.get(inst)?.name ?? inst}
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="作废原因（可选）"
            className="mt-2 w-full rounded-lg border border-line bg-s1 px-2 py-1.5 text-[12px] text-ink"
            data-testid="tx-void-reason"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="flex-1 rounded-lg border border-line py-1.5 text-[12px] text-ink2"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void doVoid()}
              className="flex-1 rounded-lg bg-ink py-1.5 text-[12px] text-s1 disabled:opacity-50"
              data-testid="tx-void-execute"
            >
              {busy ? '处理中…' : '确认作废'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-3 w-full rounded-xl border border-line bg-s1 py-2.5 text-[12px] tone-warn"
          data-testid="tx-void-start"
        >
          作废交易
        </button>
      )}

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="tx-void-error">
          {error}
        </p>
      ) : null}

      {/* 外部现金流归属：Phase 4 语义 */}
      <p
        className="mt-3 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3"
        data-testid="tx-detail-flow"
      >
        外部现金流：
        <span className={external ? 'text-ink' : 'text-ink3'}>
          {external
            ? tx.type === 'deposit'
              ? '属于外部流入'
              : '属于外部流出'
            : '不属于（不影响净资产的外部增减）'}
        </span>
      </p>

      {/* Ledger Effects：真实派生结果 */}
      <h3 className="mt-4 text-[12px] font-medium text-ink2">账本效果（Ledger Effects）</h3>
      {voided ? (
        <p className="mt-1 text-[11px] text-ink4" data-testid="tx-detail-voided-effects">
          该交易已作废，不再产生任何账本效果（原有效果已从 Ledger 中移除）。
        </p>
      ) : effects.length === 0 ? (
        <p className="mt-1 text-[11px] text-ink4" data-testid="tx-detail-no-effects">
          该交易没有产生持仓效果（或仅记录流水）。
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1.5" data-testid="tx-detail-effects">
          {effects.map((e, i) => {
            const inst = instrumentById.get(e.instrumentId)
            const legLabel =
              e.leg === 'instrument' ? '投资腿' : e.leg === 'cash' ? '资金腿（转出）' : '资金腿（转入）'
            return (
              <li
                key={`${e.instrumentId}-${e.leg}-${i}`}
                className="rounded-xl border border-line bg-s1 px-3 py-2 text-[11px]"
              >
                <p className="text-ink2">
                  {legLabel} · {inst?.name ?? e.instrumentId}
                </p>
                <p className="mt-0.5 text-ink3">
                  数量 {signed(e.quantityDelta)}
                  {e.costDelta !== 0 ? ` · 成本 ${signed(e.costDelta)}` : ''}
                  {e.cashDelta !== 0 ? ` · 现金 ${signed(e.cashDelta)}` : ''}
                  {e.incomeDelta ? ` · 收入 ${signed(e.incomeDelta)}` : ''}
                  {e.feeDelta ? ` · 费用 ${signed(e.feeDelta)}` : ''}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </Sheet>
  )
}
