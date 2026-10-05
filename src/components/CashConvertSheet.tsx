import { useMemo, useState } from 'react'
import type { Portfolio2 } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { applyCashConversion } from '../lib/ledger/cashConversion'
import { rebuildHoldingsFromTransactions } from '../lib/ledger/rebuild'
import { reconcileHoldings } from '../lib/ledger/reconcile'
import { calculateTotals } from '../lib/valuation/engine'
import { createFxTable } from '../lib/valuation/fx'
import Sheet from './Sheet'

/**
 * 现金转换 Sheet（Phase 8 / W3）
 *
 * ## 目标
 *
 * 把「已确认为现金、但仍是手动金额」的标的，
 * 转换成**交易驱动**的现金持仓：
 *
 * ```
 * Cash = Instrument(instrumentType='cash') + Holding(valuationMode='quantity')
 *        quantity = 金额（原币）
 *        price = 1
 *        averageCost = 1
 * ```
 *
 * ## 执行链（复用 Phase 5 已实现并验收的逻辑）
 *
 * ```
 * applyCashConversion()            ← 生成期初 adjustment + 切口径 + 规范 instrumentType
 *   ↓
 * rebuildHoldingsFromTransactions()  ← 从 Ledger 重建持仓缓存
 *   ↓
 * reconcileHoldings()                ← 账实校验
 *   ↓
 * 资产总额必须不变（否则视为 bug，报错并中止写入）
 * ```
 *
 * ## 硬约束
 *
 * - **绝不**在 UI 里直接写 `Holding`
 * - **绝不**产生重复持仓（转换前先做重复检测）
 * - 金额在转换前后必须守恒
 */
export interface CashConvertSheetProps {
  open: boolean
  onClose: () => void
  portfolio: Portfolio2
  repo: PortfolioRepository
  onChanged: () => void
}

export default function CashConvertSheet({
  open,
  onClose,
  portfolio,
  repo,
  onChanged,
}: CashConvertSheetProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const instrumentById = useMemo(
    () => new Map(portfolio.instruments.map((i) => [i.id, i])),
    [portfolio.instruments],
  )

  /** 候选：已确认现金 + 仍为手动口径的持仓 */
  const candidates = useMemo(() => {
    return portfolio.holdings
      .filter((h) => {
        if (h.valuationMode !== 'manual') return false
        const inst = instrumentById.get(h.instrumentId)
        if (!inst) return false
        const looksCash = inst.instrumentType === 'cash' || inst.assetClass === 'cash'
        return looksCash && inst.classificationStatus === 'confirmed'
      })
      .map((h) => ({
        holding: h,
        instrument: instrumentById.get(h.instrumentId)!,
        amount: h.manualValue ?? 0,
      }))
  }, [portfolio.holdings, instrumentById])

  const convert = async () => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const latest = await repo.loadPortfolio()

      /*
       * ① 转换前重复检测：同一账户同一标的只能有一条持仓。
       *    若已有重复，拒绝转换 —— 不允许在脏数据上继续叠加。
       */
      const keys = new Map<string, number>()
      for (const h of latest.holdings) {
        const k = `${h.accountId}::${h.instrumentId}`
        keys.set(k, (keys.get(k) ?? 0) + 1)
      }
      const dupKeys = [...keys.entries()].filter(([, n]) => n > 1)
      if (dupKeys.length > 0) {
        throw new Error(
          `检测到 ${dupKeys.length} 组重复持仓（${dupKeys.map(([k]) => k).join('、')}）。` +
            '转换会加剧数据不一致，请先处理重复持仓。',
        )
      }

      /* ② 记录转换前的资产总额，用于守恒校验 */
      const beforeFx = createFxTable(latest.fxRates)
      const beforeTotals = calculateTotals({ portfolio: latest, fx: beforeFx })

      /* ③ 走 Phase 5 的 Domain API 完成转换（含期初 adjustment） */
      const { portfolio: converted, result } = applyCashConversion(latest, {
        timestamp: new Date().toISOString(),
      })
      if (result.convertedCount === 0) {
        throw new Error('没有可转换的现金持仓（可能已被转换过）')
      }
      if (!result.amountPreserved) {
        throw new Error('转换前后金额不守恒，已中止（不会写入任何数据）')
      }

      /* ④ 从 Ledger 重建持仓缓存，而不是信任转换结果本身 */
      const rebuilt = rebuildHoldingsFromTransactions(converted)
      if (rebuilt.blocked) {
        throw new Error(`重建被阻断：${rebuilt.duplicateReport?.summary ?? '存在重复持仓'}`)
      }
      const next: Portfolio2 = { ...converted, holdings: rebuilt.holdings }

      /* ⑤ 账实校验：不一致则中止 */
      const rec = reconcileHoldings(next)
      if (!rec.ok) {
        throw new Error(
          `账实校验未通过（${rec.issues.length} 项），已中止写入：${rec.issues[0]?.detail ?? ''}`,
        )
      }

      /* ⑥ 资产总额守恒校验：变化即视为 bug */
      const afterFx = createFxTable(next.fxRates)
      const afterTotals = calculateTotals({ portfolio: next, fx: afterFx })
      if (Math.abs(afterTotals.totalAssets - beforeTotals.totalAssets) > 0.01) {
        throw new Error(
          `转换会导致资产总额变化（${beforeTotals.totalAssets} → ${afterTotals.totalAssets}），已中止`,
        )
      }

      /* ⑦ 全部校验通过后才整体写入 */
      await repo.replaceAll(next)

      setDone(
        `已转换为交易驱动现金：${result.convertedCount} 项，` +
          `新增期初调整 ${result.adjustments.length} 条，金额 ${beforeTotals.totalAssets} 保持不变`,
      )
      setConfirming(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '转换失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="转为交易驱动现金"
      subtitle={`${candidates.length} 项可转换`}
    >
      <p className="rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        此操作将会：
        <br />· 为该现金创建一条**期初调整**记录（期初余额 = 当前金额）
        <br />· 之后该现金余额由**交易流水**驱动（存入 / 取出 / 买入扣款等）
        <br />· **不会**改变当前资产总额
      </p>

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="cash-error">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] text-ink2" data-testid="cash-done">
          {done}
        </p>
      ) : null}

      {candidates.length === 0 ? (
        <p className="mt-3 text-[12px] text-ink4" data-testid="cash-empty">
          没有可转换的现金持仓。
          <br />
          只有当标的已确认为现金、且持仓仍是手动金额时，才会出现在这里。
        </p>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="cash-list">
          {candidates.map(({ holding, instrument, amount }) => (
            <li
              key={holding.id}
              className="rounded-2xl border border-line bg-s1 p-3"
              data-testid="cash-row"
              data-holding-id={holding.id}
            >
              <p className="truncate text-[13px] text-ink">{instrument.name}</p>
              <p className="mt-0.5 text-[11px] text-ink4">
                手动金额 {amount.toLocaleString('zh-CN')} {instrument.currency}
              </p>

              {confirming === holding.id ? (
                <div className="mt-2 rounded-xl border border-line bg-s2 p-2.5">
                  <p className="text-[11px] leading-relaxed text-ink3">
                    确认把「{instrument.name}」转为交易驱动现金？
                    <br />
                    将创建期初调整 {amount.toLocaleString('zh-CN')} {instrument.currency}。
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="flex-1 rounded-lg border border-line py-1.5 text-[12px] text-ink2"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void convert()}
                      className="flex-1 rounded-lg bg-ink py-1.5 text-[12px] text-s1 disabled:opacity-50"
                      data-testid="cash-confirm"
                    >
                      确认转换
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(holding.id)}
                  className="mt-2 rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink2"
                  data-testid="cash-convert"
                >
                  转为交易驱动现金
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
