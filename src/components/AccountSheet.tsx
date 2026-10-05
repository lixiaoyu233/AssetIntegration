import { useState } from 'react'
import { Info } from 'lucide-react'
import type { AccountRegion, AccountType, CurrencyCode } from '../types/portfolio2'
import { ACCOUNT_TYPE_LABEL, ACCOUNT_REGION_LABEL } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { createAccount } from '../lib/db/creation'
import { currencyOptions } from '../lib/valuation/priceService'
import Sheet from './Sheet'

/**
 * 创建账户（Phase 8 / W7 冷启动）
 *
 * 走 `createAccount()` → Repository → IndexedDB。**不建立第二套事实源。**
 */
export interface AccountSheetProps {
  open: boolean
  onClose: () => void
  repo: PortfolioRepository
  onCreated: () => void
}

const TYPES: AccountType[] = ['bank', 'broker', 'fund_platform', 'gold_platform', 'real_estate', 'crypto', 'other']
const REGIONS: AccountRegion[] = ['CN', 'HK', 'SG', 'US', 'OTHER']

export default function AccountSheet({ open, onClose, repo, onCreated }: AccountSheetProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('bank')
  const [currency, setCurrency] = useState<CurrencyCode>('CNY')
  const [region, setRegion] = useState<AccountRegion | ''>('CN')
  const [institution, setInstitution] = useState('')
  const [isLiability, setIsLiability] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setDone(null)
    const r = await createAccount(repo, {
      name,
      type,
      currency,
      region: region || undefined,
      institution,
      isLiability,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    setDone(`已创建账户：${r.account.name}（${r.account.currency}）`)
    setName('')
    setInstitution('')
    onCreated()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="创建账户"
      subtitle="账户是持仓与交易的归属单位"
      footer={
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2">
            关闭
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="flex-1 rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
            data-testid="account-save"
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      }
    >
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>账户的**币种**决定其现金口径；**负债账户**（信用卡、贷款）在统计中单独归类。</span>
      </p>

      <div className="mt-3 space-y-3">
        <label className="block text-[11px] text-ink3">
          账户名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：日常储蓄卡"
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="account-name"
          />
        </label>

        <label className="block text-[11px] text-ink3">
          账户类型
          <select
            value={type}
            onChange={(e) => setType(e.target.value as AccountType)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="account-type"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          币种
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="account-currency"
          >
            {currencyOptions().map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          地区（可留空）
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value as AccountRegion | '')}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="account-region"
          >
            <option value="">不指定</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {ACCOUNT_REGION_LABEL[r]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-[11px] text-ink3">
          机构（可留空）
          <input
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-s1 px-2 py-2 text-[12px] text-ink"
            data-testid="account-institution"
          />
        </label>

        <label className="flex items-center gap-2 text-[12px] text-ink2">
          <input
            type="checkbox"
            checked={isLiability}
            onChange={(e) => setIsLiability(e.target.checked)}
            data-testid="account-liability"
          />
          这是负债账户（信用卡 / 贷款）
        </label>
      </div>

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="account-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="account-done">
          {done}
        </p>
      ) : null}
    </Sheet>
  )
}
