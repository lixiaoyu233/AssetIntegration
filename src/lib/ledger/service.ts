/**
 * Ledger 服务：把 Repository 与派生引擎连起来
 *
 * 分层位置：
 *
 *   Repository（交易/持仓） → **LedgerService** → 业务层 / UI
 *
 * 本层只做「读交易 → 派生持仓状态 → 对账」，
 * 不做收益率等绩效计算（留给后续 Analytics 阶段）。
 */

import type { Portfolio2, Transaction } from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { type LedgerReport, deriveLedger, getPosition } from './derive'
import { type ReconcileReport, reconcileHoldings } from './reconcile'

export interface LedgerSnapshot {
  /** 由交易派生的持仓状态 */
  ledger: LedgerReport
  /** 与持仓表的对账结果 */
  reconcile: ReconcileReport
  /** 参与派生的交易条数 */
  transactionCount: number
}

/**
 * 由仓储层的数据构建账本快照。
 *
 * 传入 `portfolio` 可避免重复读取（估值与对账常一起使用）。
 */
export function buildLedgerSnapshot(
  portfolio: Portfolio2,
  options: { skipManualMode?: boolean } = {},
): LedgerSnapshot {
  const ledger = deriveLedger(portfolio.transactions)
  const reconcile = reconcileHoldings(portfolio, {
    ledger,
    skipManualMode: options.skipManualMode ?? true,
  })
  return { ledger, reconcile, transactionCount: portfolio.transactions.length }
}

/** 从 Repository 读取并构建（业务层常用入口） */
export async function loadLedgerSnapshot(
  repo: PortfolioRepository,
  options: { skipManualMode?: boolean } = {},
): Promise<LedgerSnapshot> {
  const portfolio = await repo.loadPortfolio()
  return buildLedgerSnapshot(portfolio, options)
}

/* ------------------------------------------------------------------ *
 * 便捷查询（供 UI 展示某账户 / 某标的的交易明细与派生状态）
 * ------------------------------------------------------------------ */

export interface HoldingLedgerView {
  accountId: string
  instrumentId: string
  /** 派生状态（可能为 undefined：该持仓还没有任何交易） */
  position: ReturnType<typeof getPosition>
  /** 相关交易，按时间升序 */
  transactions: Transaction[]
}

export async function loadHoldingLedger(
  repo: PortfolioRepository,
  accountId: string,
  instrumentId: string,
): Promise<HoldingLedgerView> {
  const [byAccount, byInstrument] = await Promise.all([
    repo.transactions.byAccount(accountId),
    repo.transactions.byInstrument(instrumentId),
  ])
  // 取交集：既属于该账户、又属于该标的
  const ids = new Set(byInstrument.map((t) => t.id))
  const transactions = byAccount.filter((t) => ids.has(t.id))

  const portfolio = await repo.loadPortfolio()
  const ledger = deriveLedger(portfolio.transactions)

  return {
    accountId,
    instrumentId,
    position: getPosition(ledger, accountId, instrumentId),
    transactions: [...transactions].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  }
}

/** 供 UI 展示的交易摘要行 */
export interface TransactionRow {
  id: string
  type: Transaction['type']
  date: string
  accountId: string
  instrumentId?: string
  quantity?: number
  amount: number
  fee?: number
  currency: string
  /** 该笔造成的现金变化（正为流入） */
  cashDelta: number
  note?: string
}

export function toTransactionRows(ledger: LedgerReport, txs: Transaction[]): TransactionRow[] {
  const byTx = new Map(ledger.entries.map((e) => [e.transactionId, e]))
  return [...txs]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((t) => ({
      id: t.id,
      type: t.type,
      date: t.timestamp,
      accountId: t.accountId,
      instrumentId: t.instrumentId,
      quantity: t.quantity,
      amount: t.amount,
      fee: t.fee,
      currency: t.currency,
      cashDelta: byTx.get(t.id)?.cashDelta ?? 0,
      note: t.note,
    }))
}
