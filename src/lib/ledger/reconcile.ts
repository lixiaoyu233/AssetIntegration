/**
 * 对账：派生持仓（由交易算出） vs 存储持仓（Holding 表里的值）
 *
 * 用途（用户要求第 10 点「交易流水与当前 Holding 可以互相校验」）：
 * - 界面上告诉用户「账实是否相符」；
 * - 迁移后立即发现遗漏（例如某条持仓没有期初 adjustment）；
 * - 交易录入错误时给出可定位的差异，而不是让用户自己猜。
 *
 * 本模块只做**比对与报告**，不自动改写任何数据 ——
 * 是否以派生值为准应由用户决定。
 */

import type { Holding, Portfolio2 } from '../../types/portfolio2'
import { type LedgerReport, deriveLedger, positionKey } from './derive'

export type ReconcileIssueKind =
  /** 有持仓但没有对应的期初交易（迁移遗漏或手工新增未记账） */
  | 'holding_without_ledger'
  /** 有交易但持仓表里找不到对应记录 */
  | 'ledger_without_holding'
  /** 数量不一致 */
  | 'quantity_mismatch'
  /** 成本不一致 */
  | 'cost_mismatch'
  /** 持仓表里存在但未设定估值口径 */
  | 'missing_valuation_mode'
  /** 孤立持仓：交易流水里没有依据（需要用户处理，**不可自动删除**） */
  | 'orphan_holding'

export interface ReconcileIssue {
  kind: ReconcileIssueKind
  accountId?: string
  instrumentId?: string
  holdingId?: string
  /** 存储值（Holding 表） */
  stored?: number
  /** 派生值（由交易算出） */
  derived?: number
  /** 差异 = derived − stored */
  diff?: number
  detail: string
}

export interface ReconcileReport {
  /** 账实相符 */
  ok: boolean
  issues: ReconcileIssue[]
  /** 参与比对的持仓数 */
  holdingCount: number
  /** 交易派生出的持仓数 */
  derivedCount: number
  /** 完全一致的数量 */
  matchedCount: number
}

export interface ReconcileOptions {
  /** 数量容差（默认 1e-8，覆盖浮点噪声） */
  quantityTolerance?: number
  /** 成本容差（原币） */
  costTolerance?: number
  /** 外部传入的派生结果，避免重复计算 */
  ledger?: LedgerReport
  /**
   * 现金/房产等 manual 口径的持仓没有交易流水，
   * 默认**不参与对账**（它们靠 manualValue 表达，而非交易）。
   */
  skipManualMode?: boolean
}

export function reconcileHoldings(
  portfolio: Portfolio2,
  options: ReconcileOptions = {},
): ReconcileReport {
  const qtyTol = options.quantityTolerance ?? 1e-8
  const costTol = options.costTolerance ?? 0.01
  const skipManual = options.skipManualMode ?? true
  const ledger = options.ledger ?? deriveLedger(portfolio.transactions)

  const issues: ReconcileIssue[] = []
  let matched = 0

  const seenKeys = new Set<string>()

  for (const h of portfolio.holdings) {
    const isManual = h.valuationMode === 'manual'
    if (isManual && skipManual) continue

    const key = positionKey(h.accountId, h.instrumentId)
    seenKeys.add(key)
    const derived = ledger.positions.get(key)

    if (!derived) {
      issues.push({
        kind: 'holding_without_ledger',
        accountId: h.accountId,
        instrumentId: h.instrumentId,
        holdingId: h.id,
        stored: h.quantity ?? 0,
        detail: h.orphan
          ? '孤立持仓：交易流水里没有依据，已保留原值。可补一条期初 adjustment 纳入账本，或明确删除'
          : '该持仓没有对应的交易记录（迁移时应生成一条期初 adjustment）',
      })
      continue
    }

    const storedQty = h.quantity ?? 0
    const storedCost = h.costBasis ?? 0

    const qtyDiff = derived.quantity - storedQty
    const costDiff = derived.costBasis - storedCost

    if (Math.abs(qtyDiff) > qtyTol) {
      issues.push({
        kind: 'quantity_mismatch',
        accountId: h.accountId,
        instrumentId: h.instrumentId,
        holdingId: h.id,
        stored: storedQty,
        derived: derived.quantity,
        diff: qtyDiff,
        detail: `数量不一致：持仓表 ${storedQty}，交易派生 ${derived.quantity}`,
      })
    }
    if (Math.abs(costDiff) > costTol) {
      issues.push({
        kind: 'cost_mismatch',
        accountId: h.accountId,
        instrumentId: h.instrumentId,
        holdingId: h.id,
        stored: storedCost,
        derived: derived.costBasis,
        diff: costDiff,
        detail: `成本不一致：持仓表 ${storedCost}，交易派生 ${derived.costBasis}`,
      })
    }
    if (Math.abs(qtyDiff) <= qtyTol && Math.abs(costDiff) <= costTol) matched += 1
  }

  /* 有交易但没有持仓记录 */
  for (const [key, pos] of ledger.positions) {
    if (seenKeys.has(key)) continue
    // 完全没有数量的派生位置（例如只有一笔卖出的残留）不报
    if (Math.abs(pos.quantity) < 1e-8 && Math.abs(pos.costBasis) < 0.005) continue
    issues.push({
      kind: 'ledger_without_holding',
      accountId: pos.accountId,
      instrumentId: pos.instrumentId,
      derived: pos.quantity,
      detail: '交易流水里有该持仓，但持仓表缺少对应记录',
    })
  }

  return {
    ok: issues.length === 0,
    issues,
    holdingCount: portfolio.holdings.filter((h) => !(skipManual && h.valuationMode === 'manual')).length,
    derivedCount: ledger.positions.size,
    matchedCount: matched,
  }
}

/** 一句话摘要，供 UI 展示 */
export function describeReconcile(report: ReconcileReport): string {
  if (report.ok) return `账实相符（已核对 ${report.matchedCount} 项持仓）`
  const kinds = new Map<ReconcileIssueKind, number>()
  for (const i of report.issues) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1)
  const parts = [...kinds.entries()].map(([k, n]) => `${RECONCILE_KIND_LABEL[k]} ${n} 项`)
  return `发现 ${report.issues.length} 处不一致：${parts.join('、')}`
}

export const RECONCILE_KIND_LABEL: Record<ReconcileIssueKind, string> = {
  holding_without_ledger: '缺少期初交易',
  ledger_without_holding: '缺少持仓记录',
  quantity_mismatch: '数量不一致',
  cost_mismatch: '成本不一致',
  missing_valuation_mode: '未设定估值口径',
  orphan_holding: '孤立持仓（无交易依据）',
}

/** 供 Holding 表使用：判断该持仓是否应由交易驱动 */
export function isLedgerDriven(h: Holding): boolean {
  return h.valuationMode === 'quantity'
}
