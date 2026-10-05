/**
 * Transaction Ledger：类型与语义
 *
 * ## 交易类型的语义（务必区分）
 *
 * | 类型 | 语义 | quantity | costBasis | 现金（原币） |
 * | --- | --- | --- | --- | --- |
 * | `adjustment` | **期初余额 / 迁移余额**（不是历史买入） | 直接**置为**给定值 | 直接**置为**给定值 | 不产生现金流 |
 * | `buy` | 实际买入 | +quantity | +amount + fee | −amount − fee |
 * | `sell` | 实际卖出 | −quantity | −按均价比例扣减 | +amount − fee |
 * | `deposit` | 存入资金 | — | — | +amount |
 * | `withdraw` | 取出资金 | — | — | −amount |
 * | `dividend` | 分红（**收入**，不冲减成本） | — | — | +amount − fee |
 * | `interest` | 利息（**收入**，不冲减成本） | — | — | +amount − fee |
 * | `fee` | 独立费用 | — | — | −amount |
 * | `transfer` | 账户间划转（**不产生损益、不重复计量**） | 标的原样移动 | 成本原样移动 | 账户间移动 |
 * | `exchange` | **换汇**（USD → CNY） | — | — | 两种币种现金之间转换，**不产生 investmentReturn / realizedPnl** |
 *
 * **关于 adjustment 的严格约束**（用户明确要求）：
 * 迁移过来的持仓只生成一条 adjustment，承接迁移时已有的 quantity / costBasis / 币种 / 时间，
 * 语义是「迁移时已存在的持仓余额」。
 * **不得**由现有 costBasis 反推出买入价格、买入日期或任何不存在的历史交易。
 *
 * ## 成本口径
 *
 * 采用**移动加权平均成本**：
 * - 买入：`newCost = cost + amount + fee`，`newQty = qty + quantity`，
 *   均价 = `newCost / newQty`；
 * - 卖出：按卖出前的均价结转成本（`cost -= averageCost × quantity`），均价**不变**；
 * - 均价在卖出后归零时，剩余成本一并归零，避免残留浮点尾数。
 */

import type { Transaction, TransactionType } from '../../types/portfolio2'

export type { Transaction, TransactionType }

/* ------------------------------------------------------------------ *
 * 交易对持仓的影响
 * ------------------------------------------------------------------ */

export type QuantityEffect =
  /** 直接置为给定值（仅 adjustment） */
  | 'set'
  /** 累加 / 扣减 */
  | 'delta'
  /** 不影响数量 */
  | 'none'

export type CostEffect =
  /** 直接置为给定值（仅 adjustment） */
  | 'set'
  /** 增加成本（含费用资本化） */
  | 'increase'
  /** 按均价比例结转扣减 */
  | 'reduce_by_average'
  /** 不影响成本 */
  | 'none'

export interface TransactionSemantics {
  /** 是否影响持仓数量 */
  quantity: QuantityEffect
  /** 是否影响持仓成本 */
  cost: CostEffect
  /** 是否产生现金流动 */
  cashFlow: 'in' | 'out' | 'internal' | 'none'
  /** 是否属于「收入」（分红 / 利息），用于后续收益分析，不计入成本 */
  isIncome: boolean
  /** 是否可能产生手续费 */
  allowsFee: boolean
  /** 中文说明，供 UI 与文档使用 */
  label: string
}

export const TRANSACTION_SEMANTICS: Record<TransactionType, TransactionSemantics> = {
  adjustment: {
    quantity: 'set',
    cost: 'set',
    cashFlow: 'none',
    isIncome: false,
    allowsFee: false,
    label: '期初余额',
  },
  buy: {
    quantity: 'delta',
    cost: 'increase',
    cashFlow: 'out',
    isIncome: false,
    allowsFee: true,
    label: '买入',
  },
  sell: {
    quantity: 'delta',
    cost: 'reduce_by_average',
    cashFlow: 'in',
    isIncome: false,
    allowsFee: true,
    label: '卖出',
  },
  deposit: {
    quantity: 'none',
    cost: 'none',
    cashFlow: 'in',
    isIncome: false,
    allowsFee: false,
    label: '存入',
  },
  withdraw: {
    quantity: 'none',
    cost: 'none',
    cashFlow: 'out',
    isIncome: false,
    allowsFee: false,
    label: '取出',
  },
  dividend: {
    quantity: 'none',
    cost: 'none',
    cashFlow: 'in',
    isIncome: true,
    allowsFee: true,
    label: '分红',
  },
  interest: {
    quantity: 'none',
    cost: 'none',
    cashFlow: 'in',
    isIncome: true,
    allowsFee: true,
    label: '利息',
  },
  fee: {
    quantity: 'none',
    cost: 'none',
    cashFlow: 'out',
    isIncome: false,
    allowsFee: false,
    label: '费用',
  },
  transfer: {
    quantity: 'none',
    cost: 'none',
    cashFlow: 'internal',
    isIncome: false,
    allowsFee: false,
    label: '划转',
  },
  exchange: {
    quantity: 'none',
    cost: 'none',
    /**
     * 换汇跨越了「币种」这条边界，但组合边界没变：
     * 因此对外部现金流的贡献是 0（internal），折算差额由归因层计入 fxEffect。
     */
    cashFlow: 'internal',
    isIncome: false,
    allowsFee: true,
    label: '换汇',
  },
}

/** 该交易是否需要指定标的 */
export function requiresInstrument(type: TransactionType): boolean {
  return type === 'buy' || type === 'sell' || type === 'adjustment' || type === 'dividend'
}

/** 该交易是否需要指定现金标的（资金腿） */
export function requiresCashInstrument(type: TransactionType): boolean {
  return (
    type === 'buy' ||
    type === 'sell' ||
    type === 'deposit' ||
    type === 'withdraw' ||
    type === 'dividend' ||
    type === 'interest' ||
    type === 'fee' ||
    type === 'exchange'
  )
}

/**
 * 该交易的币种是否必须与现金标的币种一致。
 *
 * 单笔交易只有一种币种 —— 跨币种必须先换汇再买卖，
 * 这样每笔交易的现金流无歧义，也避免在 Transaction 里引入第二套汇率来源。
 */
export function requiresMatchingCurrency(type: TransactionType): boolean {
  return type !== 'exchange'
}

/** 该交易是否需要数量 */
export function requiresQuantity(type: TransactionType): boolean {
  const s = TRANSACTION_SEMANTICS[type]
  return s.quantity !== 'none'
}
