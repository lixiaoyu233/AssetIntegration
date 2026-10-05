/**
 * 外部现金流识别
 *
 * ## 什么算「外部现金流」
 *
 * 只有**跨越组合边界**的资金移动才算：
 * - `deposit` → 外部流入
 * - `withdraw` → 外部流出
 *
 * ## 什么**不算**
 *
 * | 交易 | 为什么不算 |
 * | --- | --- |
 * | `buy` / `sell` | 现金 ↔ 投资的**组合内部转换**，组合总资产只换了形态 |
 * | `dividend` / `interest` | 组合内部产生的**收益**，不是外部投入 |
 * | `fee` | 成本，已体现在净资产里，单列 `feeTotal` 展示 |
 * | `transfer` | 内部划转，见下 |
 * | `adjustment` | 期初余额，不是现金流 |
 *
 * ## transfer 的三个分支
 *
 * ```
 * 目标账户在组合内            → 内部划转，不进 externalFlow
 * 目标账户不在组合内          → 视为 withdraw（流出到外部）
 * 源账户不在组合内            → 视为 deposit（从外部转入）
 * ```
 *
 * 这样才符合「Portfolio 内部划转不能被算成外部资金流入/流出」的要求。
 */

import type { Portfolio2, Transaction } from '../../types/portfolio2'

export interface PortfolioFlow {
  /** 外部流入（正数，CNY） */
  externalInflow: number
  /** 外部流出（正数，CNY） */
  externalOutflow: number
  /** 内部划转笔数（仅记录，不进入恒等式） */
  internalTransferCount: number
  /** 费用合计（原币混合，仅作展示，不进入恒等式） */
  feeTotal: number
  /** 无法折算的现金流（缺汇率），需在归因里标记 partial */
  unconvertible: Array<{ transactionId: string; currency: string; amount: number; reason: string }>
  /** 每笔交易的分类结果，便于 UI 展示与排查 */
  classified: Array<{
    transactionId: string
    type: Transaction['type']
    kind: 'external_in' | 'external_out' | 'internal' | 'income' | 'cost' | 'asset_swap' | 'opening' | 'ignored'
    amountCny?: number
  }>
}

export type FxConverter = (amount: number, currency: string) => number | undefined

/**
 * 分类并汇总组合层面的外部现金流。
 *
 * @param converter 原币 → CNY 的换算函数；返回 undefined 表示缺少汇率
 *                  （此时该笔进入 `unconvertible`，**不按 1:1 计入**）
 */
export function classifyPortfolioFlows(
  portfolio: Portfolio2,
  txs: Transaction[],
  converter: FxConverter,
): PortfolioFlow {
  const accountIds = new Set(portfolio.accounts.map((a) => a.id))

  const out: PortfolioFlow = {
    externalInflow: 0,
    externalOutflow: 0,
    internalTransferCount: 0,
    feeTotal: 0,
    unconvertible: [],
    classified: [],
  }

  for (const tx of txs) {
    const amount = Number.isFinite(tx.amount) ? tx.amount : 0
    /*
     * 费用合计：
     * - `fee` 类型的交易，金额本身就是费用；
     * - 其他类型（buy / sell / dividend / interest）的 `fee` 字段是附加费。
     */
    const fee = Number.isFinite(tx.fee) ? (tx.fee as number) : 0
    if (tx.type === 'fee') out.feeTotal += amount
    else if (fee > 0) out.feeTotal += fee

    switch (tx.type) {
      case 'deposit': {
        const cny = converter(amount, tx.currency)
        if (cny === undefined) {
          out.unconvertible.push({ transactionId: tx.id, currency: tx.currency, amount, reason: 'missing_fx' })
          out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'external_in' })
          break
        }
        out.externalInflow += cny
        out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'external_in', amountCny: cny })
        break
      }

      case 'withdraw': {
        const cny = converter(amount, tx.currency)
        if (cny === undefined) {
          out.unconvertible.push({ transactionId: tx.id, currency: tx.currency, amount, reason: 'missing_fx' })
          out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'external_out' })
          break
        }
        out.externalOutflow += cny
        out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'external_out', amountCny: cny })
        break
      }

      case 'transfer': {
        const target = tx.toAccountId
        const sourceInside = accountIds.has(tx.accountId)
        const targetInside = !!target && accountIds.has(target)

        /*
         * 判断顺序很重要：必须**先看源账户**。
         * 若源在组合外、目标在组合内，那是「从外部转入」，
         * 不能因为目标在组合内就误判为内部划转。
         */
        if (!sourceInside && targetInside) {
          // 从外部转入
          const cny = converter(amount, tx.currency)
          if (cny === undefined) {
            out.unconvertible.push({ transactionId: tx.id, currency: tx.currency, amount, reason: 'missing_fx' })
            out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'external_in' })
            break
          }
          out.externalInflow += cny
          out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'external_in', amountCny: cny })
          break
        }

        if (sourceInside && targetInside) {
          // 组合内部划转：不计外部流
          out.internalTransferCount += 1
          out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'internal' })
          break
        }

        if (sourceInside && !targetInside) {
          // 转出到外部
          const cny = converter(amount, tx.currency)
          if (cny === undefined) {
            out.unconvertible.push({ transactionId: tx.id, currency: tx.currency, amount, reason: 'missing_fx' })
            out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'external_out' })
            break
          }
          out.externalOutflow += cny
          out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'external_out', amountCny: cny })
          break
        }

        // 两端都在组合外：与本次组合无关
        out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'ignored' })
        break
      }

      case 'dividend':
      case 'interest':
        // 组合内部产生的收益，不是外部投入
        out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'income' })
        break

      case 'fee':
        // 成本：已反映在净资产中，单列展示，不进等式
        out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'cost' })
        break

      case 'buy':
      case 'sell':
        // 资产形态转换，不是外部现金流
        out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'asset_swap' })
        break

      case 'adjustment':
        // 期初余额，不是现金流
        out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'opening' })
        break

      default:
        out.classified.push({ transactionId: tx.id, type: tx.type, kind: 'ignored' })
    }
  }

  return out
}

/** 外部净流入 = 流入 − 流出 */
export function netExternalFlow(flow: PortfolioFlow): number {
  return round2(flow.externalInflow - flow.externalOutflow)
}

const round2 = (n: number) => Math.round(n * 100) / 100
