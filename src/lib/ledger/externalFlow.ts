/**
 * 外部现金流归属（Phase 8 / W4）
 *
 * ## 单一来源
 *
 * 这里**只声明「哪些交易类型属于外部资金流动」**，是 Phase 4 语义的
 * 一处显式、可被 UI 与测试共用的表达。实际的现金流计算仍在
 * `performance/cashflow.ts`（`classifyPortfolioFlows`），本模块不参与计算。
 *
 * | 类型 | 是外部现金流 | 原因 |
 * | --- | --- | --- |
 * | `deposit` | ✅ 流入 | 资金从组合外部转入 |
 * | `withdraw` | ✅ 流出 | 资金离开组合 |
 * | `buy` / `sell` | ❌ | 现金 ↔ 证券，组合内部形态转换 |
 * | `transfer` | ❌ | 账户间移动，组合净资产不变 |
 * | `exchange` | ❌ | 币种间转换，组合净资产不变 |
 * | `dividend` / `interest` | ❌ | 组合内部产生的收益 |
 * | `fee` | ❌ | 成本，已体现在净资产里 |
 * | `adjustment` | ❌ | 期初余额，不是现金流 |
 *
 * ⚠️ `transfer` 虽然「一个账户减少、另一个增加」，但**整个组合没有外部流入/流出**。
 */
import type { TransactionType } from '../../types/portfolio2'

export function hasExternalFlow(type: TransactionType): boolean {
  return type === 'deposit' || type === 'withdraw'
}

/** 外部现金流方向；非外部流返回 undefined */
export function externalFlowDirection(type: TransactionType): 'in' | 'out' | undefined {
  if (type === 'deposit') return 'in'
  if (type === 'withdraw') return 'out'
  return undefined
}
