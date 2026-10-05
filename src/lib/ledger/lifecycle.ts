/**
 * 交易生命周期（Phase 8 / W5）
 *
 * ## 为什么必须集中归一化
 *
 * `status` 是 V6 才引入的字段，**V6 之前的老交易没有它**。
 * 若各处直接写 `tx.status === 'POSTED'`，老数据会被误判为「非有效」而
 * **整批从 Ledger 消失** —— 那是灾难性回归。
 *
 * 因此规定：**所有状态判断必须经过本模块**，`undefined → POSTED`。
 *
 * ## 作废是唯一修正手段
 *
 * 禁止物理删除 Transaction；也禁止编辑。
 * 录错了就「作废原交易 + 重新录入正确交易」。
 */

import type { Transaction, TransactionStatus } from '../../types/portfolio2'

/** 交易是否已作废（`undefined` 视为未作废） */
export function isVoided(tx: Transaction): boolean {
  return tx.status === 'VOIDED'
}

/**
 * 归一化交易状态。
 *
 * `undefined`（V6 之前的老数据）**必须**按 `POSTED` 处理。
 */
export function transactionStatus(tx: Transaction): TransactionStatus {
  return tx.status === 'VOIDED' ? 'VOIDED' : 'POSTED'
}

/** 过滤出有效交易（供 Ledger 与现金流计算复用） */
export function activeTransactions(txs: Transaction[]): Transaction[] {
  return txs.filter((tx) => !isVoided(tx))
}

/** 供 UI 展示的状态文案 */
export const TRANSACTION_STATUS_LABEL: Record<TransactionStatus, string> = {
  POSTED: '有效',
  VOIDED: '已作废',
}
