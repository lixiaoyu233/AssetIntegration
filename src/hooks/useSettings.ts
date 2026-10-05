import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Portfolio } from '../types/asset'
import { type SnapshotFile, loadSnapshot, saveSnapshot } from '../lib/netWorthHistory'
import {
  type AppSettings,
  type FixedSalary,
  type FundingSource,
  type SalaryRecord,
  applySalaryToPortfolio,
  createDefaultSettings,
  currentMonth,
  listCashCandidates,
  loadSettings,
  normalizeSettings,
  saveSettings,
  shouldAutoApply,
} from '../lib/settings'

/**
 * 设置状态：基金申购的资金来源规则 + 薪资记录。
 *
 * 薪资有两条路径：
 * - 固定薪资：填一次金额与发薪日，每月到点自动写入指定项目（只写一次）；
 * - 变动薪资：每月在设置里手动填一次金额，同样只写一次。
 */
export function useSettings(portfolio: Portfolio, applyPortfolio: (p: Portfolio) => void) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [storageError, setStorageError] = useState<string | null>(null)
  const [autoApplied, setAutoApplied] = useState<{ month: string; amount: number; itemName?: string } | null>(null)
  const ranAutoApply = useRef(false)

  /** 总资产月度快照（与设置同源管理，避免再多一层 hook） */
  const [snapshot, setSnapshot] = useState<SnapshotFile>(() => loadSnapshot())
  /** 上次落库的序列化内容，避免金额没变时反复写盘 */
  const lastSaved = useRef<string>('')

  useEffect(() => {
    const serialized = JSON.stringify(snapshot)
    if (serialized === lastSaved.current) return
    lastSaved.current = serialized
    saveSnapshot(snapshot)
  }, [snapshot])

  useEffect(() => {
    const err = saveSettings(settings)
    if (err) setStorageError(err)
  }, [settings])

  /** 可作为资金来源 / 发薪入账目标的候选项目 */
  const candidates = useMemo(() => listCashCandidates(portfolio), [portfolio])

  const setFundDefault = useCallback((patch: Partial<AppSettings['fund']>) => {
    setSettings((s) => ({ ...s, fund: { ...s.fund, ...patch } }))
  }, [])

  const setTrends = useCallback((patch: Partial<AppSettings['trends']>) => {
    setSettings((s) => ({ ...s, trends: { ...s.trends, ...patch } }))
  }, [])

  const setFixed = useCallback((patch: Partial<FixedSalary>) => {
    setSettings((s) => ({ ...s, salary: { ...s.salary, fixed: { ...s.salary.fixed, ...patch } } }))
  }, [])

  /** 记录/覆盖某月薪资（同月只保留一条） */
  const upsertSalary = useCallback((month: string, amount: number) => {
    setSettings((s) => {
      const rest = s.salary.records.filter((r) => r.month !== month)
      const prev = s.salary.records.find((r) => r.month === month)
      const rec: SalaryRecord = {
        month,
        amount,
        at: Date.now(),
        // 金额被改动过就视为未入账，需要重新写入
        applied: prev?.applied && prev.amount === amount,
        appliedAt: prev?.applied && prev.amount === amount ? prev.appliedAt : undefined,
      }
      return {
        ...s,
        salary: {
          ...s.salary,
          records: [...rest, rec].sort((a, b) => a.month.localeCompare(b.month)),
        },
      }
    })
  }, [])

  const removeSalary = useCallback((month: string) => {
    setSettings((s) => ({
      ...s,
      salary: { ...s.salary, records: s.salary.records.filter((r) => r.month !== month) },
    }))
  }, [])

  /**
   * 把某月薪资写入现金项目。
   * 幂等：写成功后立刻把该月记录标记为 applied，重复调用不会再改余额。
   */
  const applySalary = useCallback(
    (month: string): { ok: boolean; message: string } => {
      const result = applySalaryToPortfolio(portfolio, settings, month)
      if (!result.applied) return { ok: false, message: result.reason ?? '未能写入' }
      applyPortfolio(result.portfolio)
      setSettings((s) => ({
        ...s,
        salary: {
          ...s.salary,
          records: s.salary.records.map((r) =>
            r.month === month ? { ...r, applied: true, appliedAt: Date.now() } : r,
          ),
        },
      }))
      return { ok: true, message: `已写入 ${result.itemName ?? '现金项目'}：+${result.amount}` }
    },
    [portfolio, settings, applyPortfolio],
  )

  /** 固定薪资：首屏检查是否到了发薪日且当月未入账 */
  useEffect(() => {
    if (ranAutoApply.current) return
    const month = currentMonth()
    if (!shouldAutoApply(settings, month)) return
    ranAutoApply.current = true
    const r = applySalary(month)
    if (r.ok) {
      setAutoApplied({
        month,
        amount: settings.salary.fixed.amount,
        itemName: settings.salary.fixed.target?.itemName,
      })
    }
  }, [settings, applySalary])

  /** 供 UI 选择资金来源 */
  const setFundingSource = useCallback(
    (source: FundingSource | undefined) => {
      setSettings((s) => ({ ...s, fund: { ...s.fund, lastFundingSource: source } }))
    },
    [],
  )

  return {
    settings,
    storageError,
    snapshot,
    setSnapshot,
    candidates,
    autoApplied,
    dismissAutoApplied: () => setAutoApplied(null),
    setFundDefault,
    setFundingSource,
    setTrends,
    setFixed,
    upsertSalary,
    removeSalary,
    applySalary,
    /** 便于测试重置 */
    replaceSettings: (next: AppSettings) => setSettings(normalizeSettings(next)),
    defaultSettings: createDefaultSettings(),
  }
}
