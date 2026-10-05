/**
 * 换汇（exchange）的校验与派生量
 *
 * ## 为什么需要独立模块
 *
 * 换汇是唯一「不产生损益、只改变币种构成」的交易。
 * 它极易被误建模成 `sell + buy`，从而污染收益归因；
 * 也容易漏掉校验，导致把未分类资产当现金换出去。
 *
 * ## `effectiveRate` 的定位（**必须严格遵守**）
 *
 * ```
 * effectiveRate = toAmount / amount
 * ```
 *
 * 它**只是展示与审计用的派生量**：
 *
 * - ❌ 不写入 `FxRate` 表
 * - ❌ 不覆盖任何汇率
 * - ❌ 不作为估值汇率来源
 *
 * 估值只认 `FxRate` 表。这样 Transaction 里就不会出现第二套汇率事实来源。
 */

import type { Portfolio2, Transaction } from '../../types/portfolio2'
import { activeTransactions } from './lifecycle'

const round8 = (n: number) => Math.round(n * 1e8) / 1e8

/* ------------------------------------------------------------------ *
 * effectiveRate（仅展示/审计）
 * ------------------------------------------------------------------ */

export interface EffectiveRate {
  /** 换出金额 */
  fromAmount: number
  fromCurrency: string
  /** 到账金额 */
  toAmount: number
  toCurrency: string
  /** toAmount / amount；金额非法时为 undefined */
  rate?: number
  /** 1 / rate，方便反向查看 */
  inverseRate?: number
}

/**
 * 计算换汇的**有效汇率**。
 *
 * ⚠️ 这是纯派生量，**绝不写回 `FxRate`，也绝不参与估值**。
 * 它只用于展示（「本次换汇实际按 7.2 成交」）与审计对账。
 */
export function computeEffectiveRate(tx: Transaction): EffectiveRate {
  const fromAmount = tx.amount ?? 0
  const toAmount = tx.toAmount ?? 0
  const fromCurrency = tx.currency
  const toCurrency = tx.toCurrency ?? tx.currency

  const valid = fromAmount > 0 && toAmount > 0
  const rate = valid ? round8(toAmount / fromAmount) : undefined

  return {
    fromAmount,
    fromCurrency,
    toAmount,
    toCurrency,
    rate,
    inverseRate: rate !== undefined && rate !== 0 ? round8(1 / rate) : undefined,
  }
}

/** 供 UI 展示的文案；无法计算时明确说明而不是显示 0 */
export function describeEffectiveRate(tx: Transaction): string {
  const r = computeEffectiveRate(tx)
  if (r.rate === undefined) return '换汇汇率不可计算（金额缺失或非正）'
  return `1 ${r.fromCurrency} ≈ ${r.rate} ${r.toCurrency}（本次成交有效汇率）`
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

export type ExchangeIssueCode =
  | 'amount_not_positive'
  | 'to_amount_not_positive'
  | 'same_currency'
  | 'same_instrument'
  | 'missing_source_instrument'
  | 'missing_target_instrument'
  | 'source_not_confirmed_cash'
  | 'target_not_confirmed_cash'
  | 'source_instrument_missing_in_portfolio'
  | 'target_instrument_missing_in_portfolio'
  | 'currency_mismatch_with_instrument'

export const EXCHANGE_ISSUE_LABEL: Record<ExchangeIssueCode, string> = {
  amount_not_positive: '换出金额必须大于 0',
  to_amount_not_positive: '到账金额必须大于 0',
  same_currency: '换出与换入币种相同（同币种转移应使用划转）',
  same_instrument: '换出与换入的现金标的不允许相同',
  missing_source_instrument: '缺少换出现金标的',
  missing_target_instrument: '缺少换入现金标的',
  source_not_confirmed_cash: '换出标的不是已确认的现金',
  target_not_confirmed_cash: '换入标的不是已确认的现金',
  source_instrument_missing_in_portfolio: '换出标的在标的中不存在',
  target_instrument_missing_in_portfolio: '换入标的在标的中不存在',
  currency_mismatch_with_instrument: '交易币种与现金标的币种不一致',
}

export interface ExchangeValidation {
  ok: boolean
  issues: Array<{ code: ExchangeIssueCode; message: string }>
  /** 通过校验时的有效汇率（展示用） */
  effectiveRate?: EffectiveRate
}

/**
 * 校验一笔换汇交易。
 *
 * 完整校验清单（用户确认）：
 * 1. `amount > 0`
 * 2. `toAmount > 0`
 * 3. 换出币种 ≠ 换入币种
 * 4. 换出标的是**已确认的现金**
 * 5. 换入标的是**已确认的现金**
 * 6. 换出标的 ≠ 换入标的
 * 7. 不允许负数
 */
export function validateExchange(tx: Transaction, portfolio: Portfolio2): ExchangeValidation {
  const issues: ExchangeValidation['issues'] = []
  const add = (code: ExchangeIssueCode) => issues.push({ code, message: EXCHANGE_ISSUE_LABEL[code] })

  if (tx.type !== 'exchange') {
    return { ok: false, issues: [{ code: 'missing_source_instrument', message: '该交易不是换汇' }] }
  }

  const sourceId = tx.cashInstrumentId
  const targetId = tx.toCashInstrumentId

  /* ---- 1/2/7. 金额必须为正 ---- */
  const amount = tx.amount ?? 0
  const toAmount = tx.toAmount ?? 0
  if (!(amount > 0)) add('amount_not_positive')
  if (!(toAmount > 0)) add('to_amount_not_positive')

  /* ---- 3. 币种必须不同 ---- */
  const sourceInst = sourceId ? portfolio.instruments.find((i) => i.id === sourceId) : undefined
  const targetInst = targetId ? portfolio.instruments.find((i) => i.id === targetId) : undefined

  const sourceCurrency = sourceInst?.currency ?? tx.currency
  const targetCurrency = tx.toCurrency ?? targetInst?.currency ?? tx.currency
  if (sourceCurrency === targetCurrency) add('same_currency')

  /* ---- 4/5. 必须是已确认的现金 ---- */
  const isConfirmedCash = (inst: typeof sourceInst): boolean =>
    !!inst && inst.instrumentType === 'cash' && inst.classificationStatus === 'confirmed'

  if (sourceId) {
    if (!sourceInst) add('source_instrument_missing_in_portfolio')
    else if (!isConfirmedCash(sourceInst)) add('source_not_confirmed_cash')
  }
  if (targetId) {
    if (!targetInst) add('target_instrument_missing_in_portfolio')
    else if (!isConfirmedCash(targetInst)) add('target_not_confirmed_cash')
  }

  /* ---- 6. 标的不能相同 ---- */
  if (sourceId && targetId && sourceId === targetId) add('same_instrument')
  if (!sourceId) add('missing_source_instrument')
  if (!targetId) add('missing_target_instrument')

  /* ---- 币种与标的必须自洽 ---- */
  if (sourceInst && sourceInst.currency !== tx.currency) add('currency_mismatch_with_instrument')

  const ok = issues.length === 0
  return {
    ok,
    issues,
    effectiveRate: ok ? computeEffectiveRate(tx) : undefined,
  }
}

/**
 * 批量校验：只返回**仍然有效**的问题换汇。
 *
 * ## 为什么必须过滤已作废（Phase 8 / W9，P1-4）
 *
 * 原先这里直接遍历 `portfolio.transactions`，把 **VOIDED** 的换汇也算进来。
 * 后果：用户作废了一笔曾无效的换汇后，**换汇表单依然提示「有 N 笔无效换汇」
 * 并阻止提交** —— 一条已经没有账本效果的历史记录挡住了有效操作。
 *
 * 作废的语义是「这笔交易不生效」（W5 已确定），因此校验也必须只看有效交易。
 * 保留 `findInvalidExchanges` 这个「不含已作废」的口径与
 * `deriveLedgerEffects`（`derive.ts:215` 经 `activeTransactions` 过滤）保持一致。
 */
export function findInvalidExchanges(
  portfolio: Portfolio2,
): Array<{ transactionId: string; validation: ExchangeValidation }> {
  return activeTransactions(portfolio.transactions)
    .filter((t) => t.type === 'exchange')
    .map((t) => ({ transactionId: t.id, validation: validateExchange(t, portfolio) }))
    .filter((x) => !x.validation.ok)
}

/**
 * 换汇的审计摘要：便于「每笔换汇实际按什么汇率成交」的历史回溯。
 *
 * 注意：返回的 `rate` **只是历史成交记录**，不得用于估值。
 */
export interface ExchangeAuditRow extends EffectiveRate {
  transactionId: string
  accountId: string
  timestamp: string
  note?: string
}

export function buildExchangeAudit(portfolio: Portfolio2): ExchangeAuditRow[] {
  return portfolio.transactions
    .filter((t) => t.type === 'exchange')
    .map((t) => ({
      transactionId: t.id,
      accountId: t.accountId,
      timestamp: t.timestamp,
      note: t.note,
      ...computeEffectiveRate(t),
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

/** 对某个现金标的，换入与换出的合计（原币），用于核对账实 */
export function exchangeTotalsByInstrument(
  portfolio: Portfolio2,
): Map<string, { in: number; out: number; net: number }> {
  const out = new Map<string, { in: number; out: number; net: number }>()
  const bump = (id: string, deltaIn: number, deltaOut: number) => {
    const cur = out.get(id) ?? { in: 0, out: 0, net: 0 }
    cur.in = round8(cur.in + deltaIn)
    cur.out = round8(cur.out + deltaOut)
    cur.net = round8(cur.in - cur.out)
    out.set(id, cur)
  }
  for (const t of portfolio.transactions) {
    if (t.type !== 'exchange') continue
    if (t.cashInstrumentId) bump(t.cashInstrumentId, 0, t.amount ?? 0)
    if (t.toCashInstrumentId) bump(t.toCashInstrumentId, t.toAmount ?? 0, 0)
  }
  return out
}
