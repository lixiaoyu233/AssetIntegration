/**
 * 重复 Holding 检测
 *
 * ## 为什么必须检测
 *
 * 派生与重建以 `accountId::instrumentId` 作为持仓唯一键（Phase 6 已锁定该约束）。
 * 如果持仓表里出现两条相同键的记录：
 *
 * | 流程 | 后果 |
 * | --- | --- |
 * | `deriveLedger` | 后一条**覆盖**前一条 |
 * | `rebuildHoldingsFromTransactions` | 合并成一条 |
 * | 分析层 | 显示两行，但键相同 |
 *
 * 也就是说，**重复持仓会导致静默的数据损坏** —— 用户看不到任何报错，
 * 但资产已经算错。因此必须显式检测。
 *
 * ## 处理原则（用户确认）
 *
 * | ❌ 禁止 | ✅ 代替 |
 * | --- | --- |
 * | 静默取后者覆盖前者 | 报错并列出全部重复项 |
 * | 自动相加数量合并 | 报错，等用户选择 |
 * | 自动取第一条 | 报错，等用户选择 |
 * | 未经确认就自动合并 | 提供详情与处理入口，由用户决定 |
 *
 * 检测本身**只读**，不修改任何数据。
 */

import type { Holding, Portfolio2 } from '../../types/portfolio2'
import { positionKey } from '../ledger/derive'

export interface DuplicateGroup {
  /** `accountId::instrumentId` */
  key: string
  accountId: string
  instrumentId: string
  accountName?: string
  instrumentName?: string
  /** 全部冲突持仓的 id（按出现顺序） */
  holdingIds: string[]
  /** 各自的估值口径 */
  valuationModes: Array<Holding['valuationMode']>
  quantities: Array<number | undefined>
  costBasises: Array<number | undefined>
  manualValues: Array<number | undefined>
  /** 数量合计（**仅作参考展示，绝不自动写入**） */
  suggestedQuantitySum: number
  suggestedCostBasisSum: number
  /** 处理建议（描述性，不自动执行） */
  suggestion: string
}

export interface DuplicateReport {
  ok: boolean
  duplicates: DuplicateGroup[]
  /** 涉及冲突的持仓总数 */
  affectedHoldingCount: number
  /** 一句话说明，供 UI 直接展示 */
  summary: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 检测重复持仓。
 *
 * **纯只读**：不修改传入的组合，也不产生任何写入副作用。
 */
export function detectDuplicateHoldings(portfolio: Portfolio2): DuplicateReport {
  const groups = new Map<string, Holding[]>()

  for (const h of portfolio.holdings) {
    const key = positionKey(h.accountId, h.instrumentId)
    const list = groups.get(key) ?? []
    list.push(h)
    groups.set(key, list)
  }

  const duplicates: DuplicateGroup[] = []
  let affected = 0

  for (const [key, list] of groups) {
    if (list.length <= 1) continue
    affected += list.length

    const accountId = list[0].accountId
    const instrumentId = list[0].instrumentId
    const account = portfolio.accounts.find((a) => a.id === accountId)
    const instrument = portfolio.instruments.find((i) => i.id === instrumentId)

    const qtySum = list.reduce((s, h) => s + (h.quantity ?? 0), 0)
    const costSum = list.reduce((s, h) => s + (h.costBasis ?? 0), 0)

    const hasManual = list.some((h) => h.valuationMode === 'manual')
    const mixedMode = new Set(list.map((h) => h.valuationMode)).size > 1

    duplicates.push({
      key,
      accountId,
      instrumentId,
      accountName: account?.name,
      instrumentName: instrument?.name,
      holdingIds: list.map((h) => h.id),
      valuationModes: list.map((h) => h.valuationMode),
      quantities: list.map((h) => h.quantity),
      costBasises: list.map((h) => h.costBasis),
      manualValues: list.map((h) => h.manualValue),
      suggestedQuantitySum: round2(qtySum),
      suggestedCostBasisSum: round2(costSum),
      suggestion: buildSuggestion({ hasManual, mixedMode, count: list.length }),
    })
  }

  // 稳定排序：按持仓数降序，便于先处理影响最大的
  duplicates.sort((a, b) => b.holdingIds.length - a.holdingIds.length || a.key.localeCompare(b.key))

  return {
    ok: duplicates.length === 0,
    duplicates,
    affectedHoldingCount: affected,
    summary:
      duplicates.length === 0
        ? '未发现重复持仓'
        : `发现 ${duplicates.length} 组重复持仓（共涉及 ${affected} 条记录）。同一账户下的同一标的只能保留一条，请选择保留哪一条或明确合并。`,
  }
}

function buildSuggestion(input: { hasManual: boolean; mixedMode: boolean; count: number }): string {
  if (input.mixedMode) {
    return '这几条的估值口径不一致（手动 / 数量），请先确认正确的口径，再决定保留哪一条或合并为一条期初调整'
  }
  if (input.hasManual) {
    return '手动口径的持仓不能直接相加；请确认正确的金额后，删除多余记录或合并为一条期初调整'
  }
  return `请选择保留哪一条，或确认合并后的数量与成本（合并会生成一条期初 adjustment 留痕，不会直接改写持仓）`
}

/* ------------------------------------------------------------------ *
 * 写入前校验（供仓储与重建调用）
 * ------------------------------------------------------------------ */

export class DuplicateHoldingError extends Error {
  readonly report: DuplicateReport
  constructor(report: DuplicateReport) {
    super(report.summary)
    this.name = 'DuplicateHoldingError'
    this.report = report
  }
}

/**
 * 写入前校验：有重复则抛错，**拒绝写入**。
 *
 * 用于：
 * - `replaceAll` / 导入流程
 * - `rebuildHoldingsFromTransactions` 的入口
 * - 任何新增 Holding 的写入路径
 */
export function assertNoDuplicateHoldings(holdings: Holding[]): void {
  const seen = new Map<string, string[]>()
  for (const h of holdings) {
    const key = positionKey(h.accountId, h.instrumentId)
    const list = seen.get(key) ?? []
    list.push(h.id)
    seen.set(key, list)
  }
  const conflicts = [...seen.entries()].filter(([, ids]) => ids.length > 1)
  if (conflicts.length === 0) return

  assertNoDuplicatesReport(conflicts)
}

function assertNoDuplicatesReport(conflicts: Array<[string, string[]]>): never {
  const report: DuplicateReport = {
    ok: false,
    duplicates: conflicts.map(([key, ids]) => {
      const [accountId, instrumentId] = key.split('::')
      return {
        key,
        accountId,
        instrumentId,
        holdingIds: ids,
        valuationModes: [],
        quantities: [],
        costBasises: [],
        manualValues: [],
        suggestedQuantitySum: 0,
        suggestedCostBasisSum: 0,
        suggestion: '请先处理重复持仓，写入已被拒绝',
      }
    }),
    affectedHoldingCount: conflicts.reduce((s, [, ids]) => s + ids.length, 0),
    summary: `检测到 ${conflicts.length} 组重复持仓（accountId + instrumentId 冲突），写入已拒绝。请先处理这些冲突。`,
  }
  throw new DuplicateHoldingError(report)
}

/** 供 UI 展示的详情行 */
export function describeDuplicate(group: DuplicateGroup): string[] {
  return group.holdingIds.map((id, i) => {
    const mode = group.valuationModes[i] === 'manual' ? '手动金额' : '数量口径'
    const value =
      group.valuationModes[i] === 'manual'
        ? `金额 ${group.manualValues[i] ?? 0}`
        : `数量 ${group.quantities[i] ?? 0}，成本 ${group.costBasises[i] ?? 0}`
    return `${id}（${mode}：${value}）`
  })
}
