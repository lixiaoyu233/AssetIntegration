import type { TransactionType } from '../../types/portfolio2'

/**
 * 交易类型的表单配置（Phase 8 / W4）
 *
 * ## 为什么不做一个大表单
 *
 * 9 种交易的字段差异很大（买入要数量+价格，存入只要金额）。
 * 把全部字段都堆出来会让用户填到无关字段，也容易把 DEPOSIT 误记成 BUY。
 * 因此每种类型声明自己需要哪些字段，表单据此动态渲染。
 *
 * ## 与领域语义表的对应关系
 *
 * 这里**只描述 UI 需要什么**，不承载任何金融语义 ——
 * 语义（数量/成本/现金流/是否收入）以 `ledger/types.ts` 的
 * `TRANSACTION_SEMANTICS` 为唯一来源。
 */

export interface TxTypeFormSpec {
  type: TransactionType
  label: string
  /** 分组，便于选择器归类 */
  group: 'external' | 'trade' | 'internal' | 'income' | 'cost'
  /** 一句话解释，避免用户误用（例如把 DEPOSIT 当 BUY） */
  hint: string
  fields: {
    /** 投资标的 */
    instrument?: boolean
    /** 资金腿（现金标的） */
    cashInstrument?: boolean
    /** 划转目标账户 */
    toAccount?: boolean
    /** 数量（股/份/克） */
    quantity?: boolean
    /** 成交单价（用于自动算金额） */
    price?: boolean
    /** 金额 */
    amount: boolean
    /** 手续费 */
    fee?: boolean
    /** 换汇目标现金标的 */
    toCashInstrument?: boolean
    /** 换汇到账金额 */
    toAmount?: boolean
  }
  /** 属于外部现金流（与 Phase 4 分类一致，仅用于提示文案） */
  isExternalFlow: boolean
}

export const TX_TYPE_SPECS: TxTypeFormSpec[] = [
  {
    type: 'deposit',
    label: '存入',
    group: 'external',
    hint: '外部资金转入某个账户。属于「外部流入」，不是买入。',
    fields: { cashInstrument: true, amount: true },
    isExternalFlow: true,
  },
  {
    type: 'withdraw',
    label: '取出',
    group: 'external',
    hint: '资金离开你的资产体系。属于「外部流出」，不是卖出。',
    fields: { cashInstrument: true, amount: true },
    isExternalFlow: true,
  },
  {
    type: 'transfer',
    label: '账户间划转',
    group: 'internal',
    hint: '同一资产在两个账户之间移动。不属于外部流入或流出，净资产不变。',
    fields: { instrument: true, toAccount: true, amount: true, quantity: true },
    isExternalFlow: false,
  },
  {
    type: 'exchange',
    label: '换汇',
    group: 'internal',
    hint: '一种货币换成另一种（例如 USD → HKD）。不属于外部现金流。',
    fields: { cashInstrument: true, toCashInstrument: true, amount: true, toAmount: true },
    isExternalFlow: false,
  },
  {
    type: 'buy',
    label: '买入',
    group: 'trade',
    hint: '现金换成证券。只是资产形态转换，本身不是收益。',
    fields: { instrument: true, cashInstrument: true, quantity: true, price: true, amount: true, fee: true },
    isExternalFlow: false,
  },
  {
    type: 'sell',
    label: '卖出',
    group: 'trade',
    hint: '证券换成现金。卖出数量不能超过当前持有量。',
    fields: { instrument: true, cashInstrument: true, quantity: true, price: true, amount: true, fee: true },
    isExternalFlow: false,
  },
  {
    type: 'dividend',
    label: '分红',
    group: 'income',
    hint: '持仓产生的现金分红。属于投资收益，不是外部入金。',
    fields: { instrument: true, cashInstrument: true, amount: true, fee: true },
    isExternalFlow: false,
  },
  {
    type: 'interest',
    label: '利息',
    group: 'income',
    hint: '利息收入。属于投资收益，不是外部入金。',
    fields: { instrument: true, cashInstrument: true, amount: true, fee: true },
    isExternalFlow: false,
  },
  {
    type: 'fee',
    label: '费用',
    group: 'cost',
    hint: '独立支出（账户管理费、托管费等）。会减少现金，但不算外部流出。',
    fields: { cashInstrument: true, amount: true },
    isExternalFlow: false,
  },
]

export const TX_GROUP_LABEL: Record<TxTypeFormSpec['group'], string> = {
  external: '外部资金',
  trade: '买卖',
  internal: '账户内部',
  income: '收益',
  cost: '费用',
}

export function specFor(type: TransactionType): TxTypeFormSpec {
  const found = TX_TYPE_SPECS.find((s) => s.type === type)
  if (!found) throw new Error(`未配置的交易类型：${type}`)
  return found
}

/** 按分组整理，供选择器渲染 */
export function groupedSpecs(): Array<{ group: TxTypeFormSpec['group']; label: string; items: TxTypeFormSpec[] }> {
  const order: TxTypeFormSpec['group'][] = ['external', 'trade', 'income', 'cost', 'internal']
  return order
    .map((group) => ({
      group,
      label: TX_GROUP_LABEL[group],
      items: TX_TYPE_SPECS.filter((s) => s.group === group),
    }))
    .filter((g) => g.items.length > 0)
}
