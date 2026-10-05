import type { Account, Instrument, Portfolio2, Transaction, TransactionType } from '../types/portfolio2'
import { TRANSACTION_TYPE_LABEL } from '../types/portfolio2'
import { hasExternalFlow } from '../lib/ledger/externalFlow'
import { isVoided, TRANSACTION_STATUS_LABEL } from '../lib/ledger/lifecycle'
import { TX_TYPE_SPECS } from '../lib/ledger/txTypeSpecs'

/**
 * 交易流水列表（Phase 8 / W4）
 *
 * ## 职责
 *
 * 只做**展示与筛选**：不重算金额、不重算持仓。
 * 金额直接来自 `Transaction`；持仓与收入关系见交易详情（Ledger Effects）。
 *
 * ## 为什么放在「历史」Tab 而不是新增第六个底部 Tab
 *
 * 用户明确要求不要再增加底部 Tab。因此流水作为历史 Tab 的二级视图
 * （流水 / 资产快照 切换）。
 */
export interface FlowsViewProps {
  flows: Transaction[]
  accounts: Account[]
  accountById: Map<string, Account>
  instrumentById: Map<string, Instrument>
  accountFilter: string
  typeFilter: string
  /** 'all' 含已作废（默认） | 'active' 仅看有效 */
  statusFilter: 'all' | 'active'
  onAccountFilter: (v: string) => void
  onTypeFilter: (v: string) => void
  onStatusFilter: (v: 'all' | 'active') => void
  onSelect: (tx: Transaction) => void
}

const n = (v: number, currency: string) =>
  `${v.toLocaleString('zh-CN', { maximumFractionDigits: 8 })} ${currency}`

export default function FlowsView({
  flows,
  accounts,
  accountById,
  instrumentById,
  accountFilter,
  typeFilter,
  statusFilter,
  onAccountFilter,
  onTypeFilter,
  onStatusFilter,
  onSelect,
}: FlowsViewProps) {
  return (
    <section className="mt-3" data-testid="flows-view">
      {/* 筛选 */}
      <div className="space-y-2" data-testid="flows-filters">
        <label className="block text-[11px] text-ink3">
          按账户筛选
          <select
            value={accountFilter}
            onChange={(e) => onAccountFilter(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="filter-account"
          >
            <option value="">全部账户</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          按类型筛选
          <select
            value={typeFilter}
            onChange={(e) => onTypeFilter(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="filter-type"
          >
            <option value="">全部类型</option>
            {TX_TYPE_SPECS.map((s) => (
              <option key={s.type} value={s.type}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          状态
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilter(e.target.value as 'all' | 'active')}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="filter-status"
          >
            {/* 默认含已作废：作废是审计事实，用户需要能看到全貌 */}
            <option value="all">含已作废（默认）</option>
            <option value="active">仅看有效</option>
          </select>
        </label>
      </div>

      <p className="mt-2 text-[11px] text-ink4" data-testid="flows-count">
        共 {flows.length} 笔（按日期倒序）
      </p>

      {flows.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-line bg-s1 px-4 py-6 text-center text-[12px] text-ink4" data-testid="flows-empty">
          没有符合条件的交易记录。
          <br />
          用「记一笔」开始建立你的财富流水。
        </p>
      ) : (
        <ul className="mt-2 space-y-2" data-testid="flows-list">
          {flows.map((tx) => {
            const external = hasExternalFlow(tx.type)
            const voided = isVoided(tx)
            return (
              <li key={tx.id}>
                <button
                  type="button"
                  onClick={() => onSelect(tx)}
                  className={`w-full rounded-2xl border border-line p-3 text-left ${
                    voided ? 'bg-s2 opacity-70' : 'bg-s1'
                  }`}
                  data-testid="flow-row"
                  data-tx-id={tx.id}
                  data-tx-type={tx.type}
                  data-tx-status={voided ? 'VOIDED' : 'POSTED'}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className={`text-[13px] ${voided ? 'text-ink3 line-through' : 'text-ink'}`}>
                        {TRANSACTION_TYPE_LABEL[tx.type] ?? tx.type}
                        {/* 状态标签：有效 / 已作废 */}
                        <span
                          className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] ${
                            voided ? 'tone-warn' : 'bg-s2 text-ink3'
                          }`}
                          data-testid="flow-status"
                        >
                          {TRANSACTION_STATUS_LABEL[voided ? 'VOIDED' : 'POSTED']}
                        </span>
                        {external && !voided ? (
                          <span className="ml-1.5 rounded bg-s2 px-1.5 py-0.5 text-[10px] text-ink3">
                            {tx.type === 'deposit' ? '外部流入' : '外部流出'}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-ink4">
                        {tx.timestamp.slice(0, 10)}
                        {' · '}
                        {accountById.get(tx.accountId)?.name ?? tx.accountId}
                        {tx.instrumentId
                          ? ` · ${instrumentById.get(tx.instrumentId)?.name ?? tx.instrumentId}`
                          : ''}
                        {tx.toAccountId
                          ? ` → ${accountById.get(tx.toAccountId)?.name ?? tx.toAccountId}`
                          : ''}
                      </p>
                      {voided ? (
                        <p className="mt-0.5 truncate text-[11px] tone-warn">
                          已作废{tx.voidedAt ? ` · ${tx.voidedAt.slice(0, 10)}` : ''}
                          {tx.voidReason ? ` · ${tx.voidReason}` : ''} · 不参与当前资产计算
                        </p>
                      ) : null}
                      {tx.note ? (
                        <p className="mt-0.5 truncate text-[11px] text-ink4">{tx.note}</p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[13px] text-ink">{n(tx.amount, tx.currency)}</p>
                      {tx.quantity !== undefined ? (
                        <p className="text-[11px] text-ink4">数量 {tx.quantity}</p>
                      ) : null}
                      {tx.fee ? <p className="text-[11px] text-ink4">费用 {tx.fee}</p> : null}
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export type { TransactionType, Portfolio2 }
