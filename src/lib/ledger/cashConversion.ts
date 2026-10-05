/**
 * 迁移：把**已确认为现金**的持仓从 manual 口径转换为交易驱动
 *
 * ## 为什么需要它
 *
 * 迁移阶段旧数据的 `kind === 'amount'` 无法区分现金 / 房产 / 数字货币，
 * 因此一律迁成 `valuationMode: 'manual'`（不猜）。
 * 但按 Phase 5 的架构，**现金应当是交易驱动的 Holding**（数量即金额）。
 *
 * 所以在用户**明确确认**某个持仓的 `assetClass === 'cash'` 之后，
 * 需要把它转换成：
 *
 * ```
 * manualValue: 20000  →  valuationMode: 'quantity', quantity: 20000
 *                     +  一条 adjustment 期初交易
 * ```
 *
 * ## 严格约束（用户确认）
 *
 * - **只转换已确认 cash 的持仓**；`unconfirmed` 或非现金类别一律不动；
 * - 转换**幂等**：已有 adjustment 的持仓不再补；
 * - **不改变原始金额**（原币金额守恒）；
 * - 转换失败**不得删除**原 Holding；
 * - 房产 / 应收（manual 口径且非现金）**保持不变**。
 */

import type { Holding, Instrument, Portfolio2, Transaction } from '../../types/portfolio2'
import { positionKey } from './derive'
import { activeTransactions } from './lifecycle'

export interface CashConversionAction {
  holdingId: string
  accountId: string
  instrumentId: string
  /** 转换前的原币金额 */
  amountBefore: number
  /** 该持仓是否已经是交易驱动（无需转换） */
  alreadyDriven: boolean
  /** 是否产出期初交易 */
  createdAdjustment: boolean
  /** 未转换的原因（若未转换） */
  skippedReason?: string
}

export interface CashConversionResult {
  /** 转换后的持仓（未转换的原样保留） */
  holdings: Holding[]
  /**
   * 规范化后的标的：被转换的现金标的 `instrumentType` 会补成 `'cash'`。
   * 估值引擎严格只看 `instrumentType`，所以这一步**必不可少**。
   */
  instruments: Instrument[]
  /** 需要新增的期初交易 */
  adjustments: Transaction[]
  /** 每个候选持仓的处理结果，便于审计 */
  actions: CashConversionAction[]
  /** 实际转换的数量 */
  convertedCount: number
  /** 原币金额是否守恒（转换前后合计一致） */
  amountPreserved: boolean
}

const iso = (t?: number) => new Date(t ?? Date.now()).toISOString()
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 判断某个持仓是否属于「已确认的现金」。
 *
 * 条件（缺一不可）：
 * - `classificationStatus === 'confirmed'` —— **必须由用户确认**，系统绝不自动推断；
 * - 标的是现金工具（`instrumentType === 'cash'`）
 *   **或**用户已把类别确认为现金（`assetClass === 'cash'`）。
 *
 * 之所以这里比估值引擎宽：迁移过来的旧数据 `instrumentType` 只能是 `'other'`，
 * 用户确认分类时只会改 `assetClass`。若这里也严格，用户确认了也无法转换。
 *
 * 但**转换的同时必须把 `instrumentType` 一并规范为 `'cash'`**（见返回值），
 * 否则估值引擎不会按现金处理，会出现「股数当金额」的错误。
 */
function isConfirmedCash(holding: Holding, portfolio: Portfolio2): boolean {
  const inst = portfolio.instruments.find((i) => i.id === holding.instrumentId)
  if (!inst) return false
  const looksLikeCash = inst.instrumentType === 'cash' || inst.assetClass === 'cash'
  return looksLikeCash && inst.classificationStatus === 'confirmed'
}

/**
 * 执行转换。
 *
 * @param options.timestamp 期初交易时间（缺省为现在）
 * @param options.dryRun 只计算不产出（供预览）
 */
export function convertConfirmedCashHoldings(
  portfolio: Portfolio2,
  options: { timestamp?: string; dryRun?: boolean } = {},
): CashConversionResult {
  const timestamp = options.timestamp ?? iso()

  /*
   * 已有的期初交易（用于幂等判断）。
   *
   * ⚠️ 必须排除**已作废**的 adjustment（Phase 8 / W9，P1-4）：
   * 否则一笔被作废的转换会被当成「已经转换过」，导致幂等判断认为
   * 无需再转换 —— 用户作废转换后重新执行却发现什么都没发生。
   *
   * 作废的语义是「这笔交易不生效」（W5），因此幂等判断只能看有效交易。
   */
  const adjustmentKeys = new Set(
    activeTransactions(portfolio.transactions)
      .filter((t) => t.type === 'adjustment' && !!t.instrumentId)
      .map((t) => positionKey(t.accountId, t.instrumentId as string)),
  )

  const holdings: Holding[] = []
  const adjustments: Transaction[] = []
  const actions: CashConversionAction[] = []
  const normalizedInstruments = new Map<string, Instrument>()
  let convertedCount = 0

  for (const h of portfolio.holdings) {
    const key = positionKey(h.accountId, h.instrumentId)
    const inst = portfolio.instruments.find((i) => i.id === h.instrumentId)
    const amount = round2(h.manualValue ?? 0)

    /* ---- 非 manual 口径：拒绝转换（不删除，原样保留） ---- */
    if (h.valuationMode !== 'manual') {
      holdings.push(h)
      actions.push({
        holdingId: h.id, accountId: h.accountId, instrumentId: h.instrumentId,
        amountBefore: amount, alreadyDriven: true, createdAdjustment: false,
        skippedReason: undefined,
      })
      continue
    }

    /* ---- 不是已确认的现金：原样保留（不猜） ---- */
    if (!isConfirmedCash(h, portfolio)) {
      holdings.push(h)
      actions.push({
        holdingId: h.id, accountId: h.accountId, instrumentId: h.instrumentId,
        amountBefore: amount, alreadyDriven: false, createdAdjustment: false,
        skippedReason: inst
          ? `标的类型为 ${inst.instrumentType}／分类状态 ${inst.classificationStatus}，未确认是现金，保持手动口径`
          : '标的缺失，保持原样',
      })
      continue
    }

    /* ---- 金额非法：不转换（避免把 0 或 NaN 写成持仓数量） ---- */
    if (!Number.isFinite(amount)) {
      holdings.push(h)
      actions.push({
        holdingId: h.id, accountId: h.accountId, instrumentId: h.instrumentId,
        amountBefore: amount, alreadyDriven: false, createdAdjustment: false,
        skippedReason: '金额非法，保持原样',
      })
      continue
    }

    /* ---- 幂等：已有期初交易则只切口径，不再补交易 ---- */
    const needsAdjustment = !adjustmentKeys.has(key)

    if (!options.dryRun) {
      /*
       * 关键：把标的的 instrumentType 规范为 'cash'。
       * 估值引擎严格只认 instrumentType，若只改 assetClass，
       * 转换后的持仓会被当成「有数量的投资品种」，股数被当金额。
       */
      if (inst && inst.instrumentType !== 'cash') {
        normalizedInstruments.set(inst.id, { ...inst, instrumentType: 'cash' })
      }

      holdings.push({
        ...h,
        valuationMode: 'quantity',
        // 数量即金额；不改变原币金额
        quantity: amount,
        costBasis: amount,
        averageCost: amount !== 0 ? 1 : 0,
        // manualValue 保留作为审计线索（不再参与估值）
        manualValueAt: h.manualValueAt ?? timestamp,
        updatedAt: timestamp,
      })

      if (needsAdjustment) {
        adjustments.push({
          id: `adj_cash_${h.id}`,
          accountId: h.accountId,
          instrumentId: h.instrumentId,
          type: 'adjustment',
          quantity: amount,
          amount,
          currency: inst?.currency ?? 'CNY',
          timestamp,
          note: '现金转为交易驱动时的期初余额（金额不可变）',
        })
      }
    } else {
      holdings.push(h)
    }

    convertedCount += 1
    actions.push({
      holdingId: h.id, accountId: h.accountId, instrumentId: h.instrumentId,
      amountBefore: amount, alreadyDriven: false, createdAdjustment: needsAdjustment,
    })
  }

  /* ---- 金额守恒校验：转换前后「manual 金额 + 现金数量」合计必须一致 ---- */
  const beforeTotal = portfolio.holdings.reduce((sum, h) => {
    if (h.valuationMode === 'manual') return sum + round2(h.manualValue ?? 0)
    return sum + round2(h.quantity ?? 0)
  }, 0)
  const afterTotal = holdings.reduce((sum, h) => {
    if (h.valuationMode === 'manual') return sum + round2(h.manualValue ?? 0)
    return sum + round2(h.quantity ?? 0)
  }, 0)

  const instruments = portfolio.instruments.map((i) => normalizedInstruments.get(i.id) ?? i)

  return {
    holdings,
    instruments,
    adjustments,
    actions,
    convertedCount,
    amountPreserved: Math.abs(beforeTotal - afterTotal) < 0.01,
  }
}

/** 便捷：一次拿转换后的完整组合（持仓 + 新增交易），供直接替换 */
export function applyCashConversion(
  portfolio: Portfolio2,
  options: { timestamp?: string } = {},
): { portfolio: Portfolio2; result: CashConversionResult } {
  const result = convertConfirmedCashHoldings(portfolio, options)
  return {
    portfolio: {
      ...portfolio,
      instruments: result.instruments,
      holdings: result.holdings,
      transactions: [...portfolio.transactions, ...result.adjustments],
    },
    result,
  }
}

/** 供 UI 提示：还有多少持仓等待用户确认分类 */
export function countPendingCashConfirmation(portfolio: Portfolio2): number {
  return portfolio.holdings.filter((h) => {
    if (h.valuationMode !== 'manual') return false
    const inst = portfolio.instruments.find((i) => i.id === h.instrumentId)
    return !!inst && inst.classificationStatus === 'unconfirmed'
  }).length
}
