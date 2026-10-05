import { useState } from 'react'
import { Info } from 'lucide-react'
import type { Account, AccountRegion, AccountType } from '../types/portfolio2'
import { ACCOUNT_REGION_LABEL, ACCOUNT_TYPE_LABEL } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { updateAccount } from '../lib/db/editing'
import Sheet from './Sheet'

/**
 * 编辑账户属性（Post-Release / P1-7）
 *
 * ## 只改四个字段
 *
 * `名称 / 类型 / 地区 / 机构` —— 都是纯元数据，不参与任何派生计算，
 * 改完只需重新派生一次界面。
 *
 * **币种与负债标记这里只读展示**，原因写在 `lib/db/editing.ts` 顶部：
 * 前者不影响任何校验、后者会改变净资产口径（属于估值语义变更），
 * 都不该混进「改个账户名」这种操作里。
 *
 * ⚠️ 本组件按「每次打开都重新挂载」使用（父组件用条件渲染），
 * 因此 `useState` 直接取 `account` 的当前值即可，不需要同步 effect。
 */

const TYPES: AccountType[] = ['bank', 'broker', 'fund_platform', 'gold_platform', 'real_estate', 'crypto', 'other']
const REGIONS: AccountRegion[] = ['CN', 'HK', 'SG', 'US', 'OTHER']

export interface AccountEditSheetProps {
  open: boolean
  account: Account
  repo: PortfolioRepository
  onClose: () => void
  onSaved: () => void
}

export default function AccountEditSheet({
  open,
  account,
  repo,
  onClose,
  onSaved,
}: AccountEditSheetProps) {
  const [name, setName] = useState(account.name)
  const [type, setType] = useState<AccountType>(account.type)
  const [region, setRegion] = useState<AccountRegion | ''>(account.region ?? '')
  const [institution, setInstitution] = useState(account.institution ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const r = await updateAccount(repo, {
      id: account.id,
      name,
      type,
      region: region || undefined,
      institution,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    onSaved()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="编辑账户"
      subtitle={account.name}
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
            className="flex-1 rounded-xl bg-invert py-2.5 text-[13px] text-on-invert disabled:opacity-50"
            data-testid="account-edit-save"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          这里只改账户的名称、类型、地区与机构。
          <span className="text-ink2">币种与负债标记不在编辑范围内</span>
          —— 前者只是新建持仓时的默认值，后者会改变净资产口径，需要单独处理。
        </span>
      </p>

      <div className="mt-3 space-y-3">
        <label className="block text-[11px] text-ink3">
          账户名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="account-edit-name"
          />
        </label>

        <label className="block text-[11px] text-ink3">
          账户类型
          <select
            value={type}
            onChange={(e) => setType(e.target.value as AccountType)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="account-edit-type"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          地区（可留空）
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value as AccountRegion | '')}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="account-edit-region"
          >
            <option value="">不指定</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {ACCOUNT_REGION_LABEL[r]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[10px] text-ink4">
            影响「资产分析 → 地区」维度的归属。留空会显示为「未标注地区」。
          </span>
        </label>

        <label className="block text-[11px] text-ink3">
          机构（可留空）
          <input
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink1"
            data-testid="account-edit-institution"
          />
        </label>

        <div className="rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink4">
          <p data-testid="account-edit-currency">币种：{account.currency}（不可修改）</p>
          <p className="mt-0.5" data-testid="account-edit-liability">
            负债标记：{account.isLiability ? '是（负债账户）' : '否'}（不可修改）
          </p>
        </div>
      </div>

      {error ? (
        <p
          className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn"
          data-testid="account-edit-error"
        >
          {error}
        </p>
      ) : null}
    </Sheet>
  )
}
