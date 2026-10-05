import type { DuplicateGroup, DuplicateReport } from '../lib/ledger/duplicates'
import { describeDuplicate } from '../lib/ledger/duplicates'
import Sheet from './Sheet'

/**
 * 重复持仓 Sheet（Phase 8 / W3）
 *
 * ## 本阶段**只做**：检测 → 展示 → 提示
 *
 * 明确**不做**（延续 Phase 7 / W2 的约定）：
 *
 * | ❌ 禁止 | 原因 |
 * | --- | --- |
 * | 自动 merge | 会凭空改写用户的资产事实 |
 * | 自动 delete | 删除后 `rebuild` 会按 Ledger 重新造出来，删除本身无效 |
 * | 自动 overwrite | 掩盖不一致，用户看不到问题 |
 * | 直接改 Ledger | Transaction 是事实源，不能为了「让数据好看」而改写 |
 *
 * ## 为什么删除无效（已完成实测）
 *
 * ```
 * 【删一条后 rebuild】→ 被删的那条又回来了，orphan=false
 * ```
 *
 * 因为派生以 `accountId::instrumentId` 为键，Ledger 里的事实决定了必然存在一条持仓。
 * 因此真正的修复需要「以 Ledger 为准恢复唯一性」或「合并成一条 adjustment」，
 * 这属于 **duplicate repair**，留给后续 Phase。
 *
 * ## 提供的能力
 *
 * 用户可以看到每一组的全部记录（id、估值方式、数量、成本），
 * 以及 Ledger 层面的建议（仅供参考，不自动执行）。
 */
export interface DuplicateSheetProps {
  duplicates: DuplicateReport
  onClose: () => void
}

function GroupCard({ group }: { group: DuplicateGroup }) {
  const lines = describeDuplicate(group)
  return (
    <li className="rounded-2xl border border-line bg-s1 p-3" data-testid="duplicate-row" data-key={group.key}>
      <p className="text-[13px] text-ink">
        {group.accountName ?? group.accountId}
        <span className="mx-1 text-ink4">·</span>
        {group.instrumentName ?? group.instrumentId}
      </p>
      <p className="mt-0.5 text-[11px] text-ink4">
        持仓键 <span className="text-ink3">{group.key}</span> · {group.holdingIds.length} 条记录
      </p>

      <ul className="mt-2 space-y-1 border-t border-line pt-2">
        {lines.map((line, i) => (
          <li key={group.holdingIds[i]} className="text-[11px] text-ink2">
            · {line}
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[11px] leading-relaxed text-ink4">
        建议：{group.suggestion}
      </p>
    </li>
  )
}

export default function DuplicateSheet({ duplicates, onClose }: DuplicateSheetProps) {
  return (
    <Sheet
      open
      onClose={onClose}
      title="重复持仓检查"
      subtitle={duplicates.ok ? '未发现重复' : `${duplicates.duplicates.length} 组需处理`}
      footer={
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2"
          data-testid="duplicate-close"
        >
          关闭
        </button>
      }
    >
      {duplicates.ok ? (
        <p className="text-[12px] text-ink4" data-testid="duplicate-empty">
          {duplicates.summary}
          <br />
          <br />
          同一账户下的同一标的只能保留一条持仓记录。
        </p>
      ) : (
        <>
          <p className="rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed tone-warn">
            {duplicates.summary}
          </p>

          <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
            <span className="font-medium text-ink2">本阶段只检测、不修复。</span>
            <br />
            自动合并或删除可能凭空改写你的资产事实，因此需要单独的处理流程。
            请先核对下方记录，确认哪一条才是正确的。
          </p>

          <ul className="mt-3 space-y-2" data-testid="duplicate-list">
            {duplicates.duplicates.map((g) => (
              <GroupCard key={g.key} group={g} />
            ))}
          </ul>
        </>
      )}
    </Sheet>
  )
}
