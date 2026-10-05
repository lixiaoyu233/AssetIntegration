import { useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import type { Portfolio2, TransactionType } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import {
  availableQuantities,
  recordTransaction,
  type RecordTransactionInput,
} from '../lib/ledger/transactionService'
import { cashInstruments } from '../lib/ledger/transactionService'
import { groupedSpecs, specFor } from '../lib/ledger/txTypeSpecs'
import { findInvalidExchanges } from '../lib/ledger/exchange'
import Sheet from './Sheet'

/**
 * 「记一笔」— 统一交易录入 Sheet（Phase 8 / W4）
 *
 * ## 数据流（唯一允许的路径）
 *
 * ```
 * 表单 → recordTransaction()（Transaction Domain API）
 *          ↓ 前置校验 → 内存试算 → rebuild → reconcile
 *       Repository → IndexedDB
 *          ↓
 *       onChanged() → 重新 derive
 * ```
 *
 * **绝不在 UI 里直接改 Holding / Snapshot**。
 *
 * ## 按类型动态显示字段
 *
 * 字段集合由 `txTypeSpecs.ts` 声明，避免把 9 种交易的字段堆在一个大表单里，
 * 也降低「把存入误记成买入」的概率。
 */
export interface TransactionSheetProps {
  open: boolean
  onClose: () => void
  portfolio: Portfolio2
  repo: PortfolioRepository
  onChanged: () => void
  /** 预设交易类型（例如从卖出入口进入） */
  initialType?: TransactionType
}

/** 本地日期 → ISO（取当天中午，避免时区把日期推到前一天） */
function todayIso(): string {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

function toDateInput(iso: string): string {
  return iso.slice(0, 10)
}

/** 由「日期 + 时间」拼回 ISO */
function fromDateInput(date: string): string {
  return new Date(`${date}T12:00:00`).toISOString()
}

export default function TransactionSheet({
  open,
  onClose,
  portfolio,
  repo,
  onChanged,
  initialType = 'deposit',
}: TransactionSheetProps) {
  const [type, setType] = useState<TransactionType>(initialType)
  const [accountId, setAccountId] = useState(portfolio.accounts[0]?.id ?? '')
  const [instrumentId, setInstrumentId] = useState('')
  const [cashInstrumentId, setCashInstrumentId] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [toCashInstrumentId, setToCashInstrumentId] = useState('')
  const [quantity, setQuantity] = useState('')
  /*
   * 「整仓划转」显式开关（Phase 8 / W10-Patch，P0-1）。
   *
   * 领域层把 `transferQuantity` **未指定**解释为「整仓搬运」。
   * 原先表单把用户填的「划转数量」写进 `quantity` 而从不写 `transferQuantity`，
   * 于是「整仓」这个语义被**普通数量输入隐式触发** —— 用户填 20000
   * 却被整仓搬走。现在：
   * - 默认（false）：必须填数量 → 映射到 `transferQuantity`（部分划转）；
   * - 勾选（true）：显式整仓搬运，数量输入被禁用。
   */
  const [transferAll, setTransferAll] = useState(false)
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [toAmount, setToAmount] = useState('')
  const [fee, setFee] = useState('')
  const [date, setDate] = useState(toDateInput(todayIso()))
  const [note, setNote] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const spec = specFor(type)

  /** 现金标的候选：只在该账户下挑，避免跨账户误配 */
  const cashOptions = useMemo(
    () => cashInstruments(portfolio).filter((i) => !accountId || i.currency !== undefined),
    [portfolio],
  )

  /**
   * 标的候选。
   *
   * - **买入 / 卖出 / 分红 / 利息**：排除现金（现金走资金腿，不是投资标的）
   * - **划转**：现金是合法标的（「把 20000 从 A 账户划到 B 账户」），
   *   因此划转时**必须包含现金**，否则用户无法做现金划转 ——
   *   而现金划转正是最常见的用法。
   */
  const instrumentOptions = useMemo(
    () =>
      type === 'transfer'
        ? portfolio.instruments
        : portfolio.instruments.filter((i) => i.instrumentType !== 'cash'),
    [portfolio, type],
  )

  /**
   * 当前账户下可卖持仓（供卖出限制）。
   *
   * ⚠️ 必须用 `availableQuantities()`（**一次**派生）而不是逐标的调用
   * `availableQuantity()`（每次调用都完整派生一遍账本，O(I × T log T)）。
   * 注意仍以 `instrumentOptions` 作为过滤源 —— 它在卖出场景排除现金标的，
   * 换成 `availablePositions` 会把现金混进可卖列表。
   */
  const sellable = useMemo(() => {
    if (type !== 'sell' || !accountId) return []
    const qtyByInstrument = availableQuantities(portfolio, accountId)
    return instrumentOptions
      .map((i) => ({ inst: i, qty: qtyByInstrument.get(i.id) ?? 0 }))
      .filter((x) => x.qty > 0)
  }, [type, accountId, instrumentOptions, portfolio])

  /** 换汇校验提示（复用领域校验器，不在 UI 重写规则） */
  const exchangeProblems = useMemo(
    () => (type !== 'exchange' ? 0 : findInvalidExchanges(portfolio).length),
    [type, portfolio],
  )

  const reset = () => {
    setInstrumentId('')
    setCashInstrumentId('')
    setToAccountId('')
    setToCashInstrumentId('')
    setQuantity('')
    setPrice('')
    setAmount('')
    setToAmount('')
    setFee('')
    setNote('')
    setError(null)
    setTransferAll(false)
  }

  const changeType = (next: TransactionType) => {
    setType(next)
    reset()
    setDone(null)
  }

  /** 数量 × 单价 → 自动填金额（用户仍可手改） */
  const syncAmountFromPrice = (q: string, p: string) => {
    const qn = Number(q)
    const pn = Number(p)
    if (Number.isFinite(qn) && Number.isFinite(pn) && qn > 0 && pn >= 0) {
      setAmount(String(Math.round(qn * pn * 100) / 100))
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    setDone(null)

    // 币种以资金腿（或标的）为准，避免用户手填与数据不一致
    const cashInst = portfolio.instruments.find((i) => i.id === cashInstrumentId)
    const inst = portfolio.instruments.find((i) => i.id === instrumentId)
    const currency = (cashInst?.currency ?? inst?.currency ?? 'CNY') as RecordTransactionInput['currency']

    const input: RecordTransactionInput = {
      type,
      accountId,
      instrumentId: instrumentId || undefined,
      cashInstrumentId: spec.fields.cashInstrument ? cashInstrumentId || undefined : undefined,
      toAccountId: spec.fields.toAccount ? toAccountId || undefined : undefined,
      toCashInstrumentId: spec.fields.toCashInstrument ? toCashInstrumentId || undefined : undefined,
      amount: Number(amount),
      /*
       * ## transfer 的数量映射（Phase 8 / W10-Patch，P0-1）
       *
       * 领域层用 `transferQuantity` 表达「部分划转」，**未指定**才表示整仓搬运。
       * 原先把用户填的数量写进 `quantity`，于是：
       * - 兜底逻辑（`quantity === undefined` 时才把 `amount` 当划转量）不生效；
       * - `applyTransfer` 读不到 `transferQuantity` → `moveQty = before` → **整仓搬走**。
       *
       * 现在显式区分：
       * - 勾选「整仓划转」→ **不传** `transferQuantity`（唯一的整仓表达方式）；
       * - 否则把用户填的数量写入 `transferQuantity`（部分划转）。
       */
      transferQuantity:
        type === 'transfer'
          ? transferAll
            ? undefined
            : quantity
              ? Number(quantity)
              : undefined
          : undefined,
      quantity: spec.fields.quantity && quantity ? Number(quantity) : undefined,
      fee: fee ? Number(fee) : undefined,
      currency,
      toAmount: spec.fields.toAmount ? Number(toAmount) : undefined,
      toCurrency: toCashInstrumentId
        ? (portfolio.instruments.find((i) => i.id === toCashInstrumentId)?.currency as RecordTransactionInput['currency'])
        : undefined,
      timestamp: fromDateInput(date),
      note: note.trim() || undefined,
    }

    const result = await recordTransaction(repo, input)
    setBusy(false)

    if (!result.ok) {
      setError(result.message)
      return
    }

    setDone(`已记录：${spec.label}`)
    reset()
    onChanged()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="记一笔"
      subtitle={spec.hint}
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
            className="flex-1 rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
            data-testid="tx-submit"
          >
            {busy ? '记录中…' : '记录'}
          </button>
        </div>
      }
    >
      {/* 类型选择：按分组，避免一长串 */}
      <div className="space-y-2" data-testid="tx-type-picker">
        {groupedSpecs().map((g) => (
          <div key={g.group}>
            <p className="mb-1 text-[11px] text-ink4">{g.label}</p>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((s) => (
                <button
                  key={s.type}
                  type="button"
                  onClick={() => changeType(s.type)}
                  className={`rounded-full border px-3 py-1 text-[12px] ${
                    type === s.type ? 'border-ink bg-ink text-s1' : 'border-line bg-s1 text-ink2'
                  }`}
                  data-testid={`tx-type-${s.type}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 语义提示：帮助用户区分存入 / 买入等易混类型 */}
      <p className="mt-3 flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>{spec.hint}</span>
      </p>

      <div className="mt-3 space-y-3">
        {/* 账户 */}
        <label className="block text-[11px] text-ink3">
          {type === 'transfer' ? '源账户' : '账户'}
          <select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value)
              setInstrumentId('')
              setCashInstrumentId('')
            }}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="tx-account"
          >
            {portfolio.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.currency}）
              </option>
            ))}
          </select>
        </label>

        {/* 资金腿 */}
        {spec.fields.cashInstrument ? (
          <label className="block text-[11px] text-ink3">
            {type === 'exchange' ? '换出现金' : '资金来源 / 去向'}
            <select
              value={cashInstrumentId}
              onChange={(e) => setCashInstrumentId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="tx-cash"
            >
              <option value="">请选择…</option>
              {cashOptions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}（{i.currency}）
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {/* 换入现金 */}
        {spec.fields.toCashInstrument ? (
          <label className="block text-[11px] text-ink3">
            换入现金
            <select
              value={toCashInstrumentId}
              onChange={(e) => setToCashInstrumentId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="tx-to-cash"
            >
              <option value="">请选择…</option>
              {cashOptions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}（{i.currency}）
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {/* 标的 */}
        {spec.fields.instrument ? (
          <label className="block text-[11px] text-ink3">
            标的
            <select
              value={instrumentId}
              onChange={(e) => setInstrumentId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="tx-instrument"
            >
              <option value="">请选择…</option>
              {(type === 'sell' ? sellable.map((s) => s.inst) : instrumentOptions).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {type === 'sell'
                    ? `（可卖 ${sellable.find((s) => s.inst.id === i.id)?.qty ?? 0}）`
                    : ''}
                </option>
              ))}
            </select>
            {type === 'sell' ? (
              <span className="mt-1 block text-[11px] text-ink4">
                只会列出当前有持仓的标的；可卖数量由 Ledger 推导。
              </span>
            ) : null}
          </label>
        ) : null}

        {/* 划转目标账户 */}
        {spec.fields.toAccount ? (
          <label className="block text-[11px] text-ink3">
            目标账户
            <select
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="tx-to-account"
            >
              <option value="">请选择…</option>
              {portfolio.accounts
                .filter((a) => a.id !== accountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}（{a.currency}）
                  </option>
                ))}
            </select>
          </label>
        ) : null}

        {/* 数量 + 单价 */}
        {spec.fields.quantity ? (
          <div className="flex gap-2">
            <label className="flex-1 text-[11px] text-ink3">
              {type === 'transfer'
                ? transferAll
                  ? '划转数量（整仓：全部转出）'
                  : '划转数量'
                : '数量'}
              <input
                inputMode="decimal"
                value={quantity}
                disabled={type === 'transfer' && transferAll}
                onChange={(e) => {
                  setQuantity(e.target.value)
                  if (spec.fields.price) syncAmountFromPrice(e.target.value, price)
                  else if (type === 'transfer') setAmount(e.target.value)
                }}
                className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink disabled:opacity-50"
                data-testid="tx-quantity"
              />
              {type === 'transfer' ? (
                <label className="mt-1.5 flex items-start gap-1.5 text-[11px] text-ink3">
                  <input
                    type="checkbox"
                    checked={transferAll}
                    onChange={(e) => {
                      setTransferAll(e.target.checked)
                      if (e.target.checked) setQuantity('')
                    }}
                    className="mt-0.5"
                    data-testid="tx-transfer-all"
                  />
                  <span>
                    整仓划转（把该标的在源账户的全部数量转出）
                    <span className="block text-[10px] text-ink4">
                      不勾选时必须填写划转数量；勾选后按全部数量转出。
                    </span>
                  </span>
                </label>
              ) : null}
            </label>
            {spec.fields.price ? (
              <label className="flex-1 text-[11px] text-ink3">
                成交单价
                <input
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => {
                    setPrice(e.target.value)
                    syncAmountFromPrice(quantity, e.target.value)
                  }}
                  className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
                  data-testid="tx-price"
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {/* 金额 */}
        {spec.fields.amount ? (
          <label className="block text-[11px] text-ink3">
            {type === 'transfer' ? '金额（等于划转数量）' : '金额'}
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="tx-amount"
            />
          </label>
        ) : null}

        {/* 换汇到账金额 */}
        {spec.fields.toAmount ? (
          <label className="block text-[11px] text-ink3">
            到账金额
            <input
              inputMode="decimal"
              value={toAmount}
              onChange={(e) => setToAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="tx-to-amount"
            />
            {Number(amount) > 0 && Number(toAmount) > 0 ? (
              <span className="mt-1 block text-[11px] text-ink4">
                有效汇率 ≈ {(Number(toAmount) / Number(amount)).toFixed(4)}（仅记录，不写回汇率表）
              </span>
            ) : null}
          </label>
        ) : null}

        {/* 手续费 */}
        {spec.fields.fee ? (
          <label className="block text-[11px] text-ink3">
            手续费（可留空）
            <input
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
              data-testid="tx-fee"
            />
          </label>
        ) : null}

        {/* 日期 */}
        <label className="block text-[11px] text-ink3">
          交易日期
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="tx-date"
          />
        </label>

        {/* 备注 */}
        <label className="block text-[11px] text-ink3">
          备注（可留空）
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="tx-note"
          />
        </label>
      </div>

      {exchangeProblems > 0 ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn">
          已有 {exchangeProblems} 笔换汇存在问题（例如缺少目标现金标的），换汇校验会照常执行。
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="tx-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="tx-done">
          {done}
        </p>
      ) : null}
    </Sheet>
  )
}
