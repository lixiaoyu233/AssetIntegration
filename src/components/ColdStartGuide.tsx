import { ArrowRight, Building2, Coins, Tag } from 'lucide-react'
import type { ColdStartState } from '../lib/db/creation'

/**
 * 冷启动引导（Phase 8 / W7）
 *
 * ## 为什么必须有
 *
 * W7 审计发现：2.0 全 UI 对 `accounts` 的写入调用数是 0。
 * 新用户打开应用时**没有任何账户** ——
 * 点「记一笔」只会看到空的下拉框和「请选择账户」，
 * 却找不到任何创建入口。那不是一个「缺功能」的应用，而是一个**不可用的**应用。
 *
 * 这个面板把「下一步该做什么」明确说清楚，并把创建入口放在最显眼的位置。
 */
export interface ColdStartGuideProps {
  state: ColdStartState
  onCreateAccount: () => void
  onCreateInstrument: () => void
  onCreateManualHolding: () => void
}

export default function ColdStartGuide({
  state,
  onCreateAccount,
  onCreateInstrument,
  onCreateManualHolding,
}: ColdStartGuideProps) {
  // 数据已经齐备时不需要引导
  if (!state.noAccounts && !state.noInstruments && !state.noHoldings) return null

  const steps: Array<{
    key: string
    done: boolean
    title: string
    desc: string
    icon: typeof Building2
    action?: () => void
    testid: string
  }> = [
    {
      key: 'account',
      done: !state.noAccounts,
      title: '创建账户',
      desc: '账户是持仓与交易的归属单位（银行 / 券商 / 房产）',
      icon: Building2,
      action: onCreateAccount,
      testid: 'guide-account',
    },
    {
      key: 'instrument',
      done: !state.noInstruments,
      title: '创建标的',
      desc: '标的代表持有什么；资产类别由你选择，系统不会猜',
      icon: Tag,
      action: onCreateInstrument,
      testid: 'guide-instrument',
    },
    {
      key: 'holding',
      done: !state.noHoldings,
      title: '记录持仓',
      desc: '记一笔交易，或用手动持仓登记房产 / 应收',
      icon: Coins,
      action: onCreateManualHolding,
      testid: 'guide-holding',
    },
  ]

  return (
    <section
      className="mt-3 rounded-2xl border border-line bg-s1 p-4"
      data-testid="cold-start-guide"
    >
      <h2 className="text-[14px] font-medium text-ink">先建立你的资产结构</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-ink4">
        现在还没有数据。按下面三步建立结构后，就可以开始记录交易流水了。
      </p>

      <ol className="mt-3 space-y-2">
        {steps.map((s, i) => {
          const Icon = s.icon
          return (
            <li key={s.key}>
              <button
                type="button"
                disabled={s.done || !s.action}
                onClick={s.action}
                className={`flex w-full items-start gap-2.5 rounded-2xl border px-3 py-2.5 text-left ${
                  s.done ? 'border-line bg-s2 opacity-60' : 'border-line bg-s1'
                }`}
                data-testid={s.testid}
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-s3 text-[11px] text-ink2">
                  {s.done ? '✓' : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] text-ink">
                    <Icon size={13} className="text-ink3" />
                    {s.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-ink4">{s.desc}</span>
                </span>
                {!s.done && s.action ? (
                  <ArrowRight size={14} className="mt-1 shrink-0 text-ink3" />
                ) : null}
              </button>
            </li>
          )
        })}
      </ol>

      <p className="mt-2 text-[11px] leading-relaxed text-ink4">
        手动持仓（房产、应收、未确认现金）不进入交易账本，直接以当前价值表达。
      </p>
    </section>
  )
}
