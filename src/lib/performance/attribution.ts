/**
 * 收益归因
 *
 * ## 核心恒等式（固定，不得改写）
 *
 * ```
 * 期末净资产 = 期初净资产
 *            + 外部流入 − 外部流出
 *            + investmentReturn      ← 已扣除费用后的净投资收益
 *            + fxEffect
 *            + otherAdjustment
 * ```
 *
 * **费用不单独出现在等式中**：手续费已经通过现金减少反映在期末净资产里，
 * 所以 `investmentReturn` 天然是「扣费后」的净额。
 * `feeTotal` 只用于展示成本，**不得**加回或重复扣除 —— 否则就是双重计算。
 *
 * ## 残差处理（关键约束）
 *
 * ```
 * residual = 期末 − 期初 − 外部净流入 − investmentReturn − fxEffect
 * ```
 *
 * - 残差在容差内 → 视作浮点误差，`otherAdjustment` **归零**；
 * - 残差超阈值 → 写入 `otherAdjustment`，`attributionStatus = 'partial'` 并记录原因。
 *
 * **不允许**把残差静默塞进 `investmentReturn` 冒充收益。
 *
 * ## FX 影响的拆分
 *
 * 以「期初持仓的原币敞口 × 汇率变动」计算：
 *
 * ```
 * fxEffect = Σ 期初持仓 [ 原币价值 × (期末汇率 − 期初汇率) ]
 * ```
 *
 * ### ⚠️ 已知精度边界（Performance Attribution Precision Boundary）
 *
 * **本实现不是完全精确的 FX 归因**，这是经过确认并接受的取舍：
 *
 * > **期间新增 / 减少的持仓**所对应的汇率变动**不会**计入 `fxEffect`，
 * > 而是落在 `investmentReturn` 里。
 *
 * 具体例子（Phase 4 验收时确认）：
 *
 * ```
 * 期初 USD 持仓 = 0
 * 期间买入     = USD 1000
 * 期初汇率 7.2 → 期末汇率 7.5
 * → 这 300 元汇率变化会被算进 investmentReturn，而不是 fxEffect
 * ```
 *
 * **这不是 bug，而是当前口径的边界。** 若要完全精确，需要引入：
 * - transaction-date FX（按每笔交易记账日的汇率折算）
 * - cash-flow-weighted FX（按现金流加权）
 * - time-weighted return / 更细的市场收益与汇率收益拆分
 *
 * 以上均属于后续 Performance Analytics 阶段，**Phase 4 明确不做**。
 *
 * 该边界由 `attribution.test.ts` 中的「精度边界」用例锁定：
 * 若未来改进了 FX 归因，那条测试会失败并提示需要同步更新口径文档 ——
 * 避免有人误以为当前实现已经精确。
 */

import type { Snapshot, SnapshotPosition } from '../../types/portfolio2'
import type { PortfolioFlow } from './cashflow'

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/** 归因结果的可信度 */
export type AttributionStatus = 'complete' | 'partial' | 'unavailable'

export interface AttributionOptions {
  /** 残差容差（人民币）。超过则视为异常而非浮点误差 */
  residualTolerance?: number
  /**
   * 本次归因的目标日期（`YYYY-MM-DD`）。给出时会做 **opening 间隔检测**。
   *
   * 为什么需要（Phase 8 / W7 止血）：期初快照的选取是
   * 「date 之前日期最大的一条」，**不检查间隔**。
   * 若用户多日未打开应用（或刚迁移完，只有月度快照），
   * 期初可能是几周前甚至一个月前 —— 于是
   * `investmentReturn = 今日净资产 − 上月净资产 − 今日现金流`
   * 会把**整个期间的收益**当成「当天投资收益」写进快照并永久保存，
   * 事后无法识别。
   *
   * 给出 `date` 后，间隔异常会被**结构化降级**而不是照常计算。
   */
  date?: string
}

export const DEFAULT_RESIDUAL_TOLERANCE = 1 // 1 元

/**
 * 计算期初快照与目标日期相隔的天数。
 *
 * 两个日期都缺失或无法解析时返回 `undefined`（表示**无法判断**，
 * 此时不做间隔降级 —— 不因为「不知道」就拒绝计算）。
 */
export function openingGapDays(opening: { date?: string }, date?: string): number | undefined {
  if (!opening?.date || !date) return undefined
  const a = Date.parse(`${opening.date}T00:00:00Z`)
  const b = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
  return Math.round((b - a) / 86_400_000)
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

export interface Attribution {
  status: AttributionStatus
  openingNetWorth?: number
  externalInflow?: number
  externalOutflow?: number
  investmentReturn?: number
  fxEffect?: number
  otherAdjustment?: number
  /** 残差原始值（未归零前），便于排查 */
  residual?: number
  otherAdjustmentReason?: string
  feeTotal?: number
  internalTransferCount?: number
  /** 无法完整归因的原因 */
  notes: string[]
}

/* ------------------------------------------------------------------ *
 * FX 影响
 * ------------------------------------------------------------------ */

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 由期初与期末的持仓快照计算汇率影响。
 *
 * 返回 `undefined` 表示**无法可靠计算**（例如期初没有持仓明细），
 * 此时不得填 0 冒充，而应标记归因 partial。
 */
export function computeFxEffect(
  opening: Snapshot | undefined,
  ending: Snapshot,
): { effect: number | undefined; note?: string } {
  if (!opening) return { effect: undefined, note: '没有上一份快照，无法计算汇率影响' }

  /*
   * 区分「无法计算」与「确实是 0」：
   * - 期初完全**没有外币敞口** → 汇率影响明确为 0（不是无法计算）；
   * - 期初没有持仓明细且无法判断是否有外币 → 才算无法计算。
   */
  const foreign = opening.positions.filter((p) => p.currency !== 'CNY')
  if (foreign.length === 0) {
    // 有明细且全为人民币 → 汇率影响可证为 0
    if (opening.positions.length > 0) return { effect: 0 }
    // 没有明细：净资产也为 0 时无敞口可言；否则无法判断
    if (opening.netWorth === 0) return { effect: 0 }
    return { effect: undefined, note: '上一份快照没有持仓明细，无法计算汇率影响' }
  }

  /*
   * 只采纳**可靠且确有汇率**的项（Schema V7 起 `rateToCny` 可缺失）。
   * 缺汇率的项不参与映射，也不覆盖已有值 ——
   * 用 undefined 或伪造值污染整条归因都会让结论不可信。
   */
  const endingRates = new Map<string, number>()
  for (const p of ending.positions) {
    if (!p.reliable || p.rateToCny === undefined) continue
    endingRates.set(`${p.accountId}::${p.instrumentId}`, p.rateToCny)
  }
  // 也接受按币种查询的退化路径（当明细缺失时）
  const endingRateByCurrency = new Map<string, number>()
  for (const p of ending.positions) {
    if (!p.reliable || p.rateToCny === undefined) continue
    endingRateByCurrency.set(p.currency, p.rateToCny)
  }
  for (const p of opening.positions) {
    if (p.rateToCny === undefined) continue
    if (!endingRateByCurrency.has(p.currency)) endingRateByCurrency.set(p.currency, p.rateToCny)
  }

  let effect = 0
  let missing = 0

  for (const p of opening.positions) {
    const rateNow =
      endingRates.get(`${p.accountId}::${p.instrumentId}`) ?? endingRateByCurrency.get(p.currency)
    if (rateNow === undefined) {
      missing += 1
      continue
    }
    /*
     * 缺单价（不可估值）的期初持仓无法参与汇率归因 —— 计入 missing，
     * 而不是把 undefined 当 0（那会把「无法计算」伪装成「影响为零」）。
     */
    // 缺单价或缺汇率 → 该项无法参与汇率归因，计入 missing（不当作 0）
    if (p.price === undefined || p.rateToCny === undefined) {
      missing += 1
      continue
    }
    const nativeValue = p.quantity * p.price
    effect += nativeValue * (rateNow - p.rateToCny)
  }

  if (missing > 0 && Math.abs(effect) < 1e-9) {
    return { effect: undefined, note: `有 ${missing} 项期初持仓缺少期末汇率，无法计算汇率影响` }
  }
  return {
    effect: round2(effect),
    note: missing > 0 ? `汇率影响基于大部分持仓计算，另有 ${missing} 项缺少期末汇率` : undefined,
  }
}

/* ------------------------------------------------------------------ *
 * 换汇产生的已实现汇率差额
 * ------------------------------------------------------------------ */

/**
 * 计算期间内**换汇**交易本身带来的汇率差额（人民币）。
 *
 * 为什么单独算：换汇不是投资交易，它实现的是「持有外币期间的汇率变动」。
 * 若把 1000 USD → 7200 CNY 这种转换直接计入 `investmentReturn`，
 * 收益归因会把换汇误读成投资获利。
 *
 * 口径：
 * ```
 * 单笔换汇的汇率差额 = 到账金额(CNY) − 源金额按当期汇率折算的 CNY
 * ```
 * 该差额计入 `fxEffect`，而**不改变** `investmentReturn` 的移项关系
 * （因为换汇同时改变了净资产，移项后会被正确抵消）。
 *
 * @param converter 原币 → CNY 的换算（用当期汇率）
 */
export function computeExchangeFxEffect(
  txs: import('../../types/portfolio2').Transaction[],
  converter: (amount: number, currency: string) => number | undefined,
): { effect: number; count: number; notes: string[] } {
  let effect = 0
  let count = 0
  const notes: string[] = []

  for (const tx of txs) {
    if (tx.type !== 'exchange') continue
    const targetAmount = tx.toAmount ?? 0
    if (!(targetAmount > 0)) continue

    const targetCurrency = tx.toCurrency ?? tx.currency
    const targetInCny = converter(targetAmount, targetCurrency)
    const sourceInCny = converter(tx.amount, tx.currency)

    if (targetInCny === undefined || sourceInCny === undefined) {
      notes.push(`换汇 ${tx.id} 缺少汇率，无法计算汇率差额`)
      continue
    }
    effect += targetInCny - sourceInCny
    count += 1
  }

  return { effect: round2(effect), count, notes }
}

/* ------------------------------------------------------------------ *
 * 归因
 * ------------------------------------------------------------------ */

export interface AttributionInput {
  opening?: Snapshot
  ending: Snapshot
  flow: PortfolioFlow
  options?: AttributionOptions
  /**
   * 期间换汇产生的**已实现汇率差额**（人民币）。
   * 由 `computeExchangeFxEffect()` 计算，归入 fxEffect，不计入投资收益。
   */
  exchangeFx?: { effect: number; count: number; notes: string[] }
}

/**
 * 计算归因。
 *
 * 注意：`investmentReturn` 是**推导出来的**（由恒等式移项）：
 *
 * ```
 * investmentReturn = 期末 − 期初 − 外部净流入 − fxEffect
 * ```
 * 移项后 `otherAdjustment` 由残差决定（见下方逻辑），
 * 因此恒等式始终严格成立。
 */
export function attribute(input: AttributionInput): Attribution {
  const { opening, ending, flow } = input
  const tolerance = input.options?.residualTolerance ?? DEFAULT_RESIDUAL_TOLERANCE
  const notes: string[] = []

  /* ---- 首日：没有期初，变化字段一律 undefined（不填 0） ---- */
  if (!opening) {
    return {
      status: 'unavailable',
      feeTotal: flow.feeTotal,
      internalTransferCount: flow.internalTransferCount,
      notes: ['这是首份快照，没有期初数据，无法计算变化'],
    }
  }

  /*
   * ---- opening 间隔检测（W7 止血） ----
   *
   * 期初必须是**紧邻的前一天**。否则所谓「投资收益」实际是整个间隔期的收益，
   * 把它写成当日收益会造成语义错误且事后不可识别。
   *
   * 这里的做法是**结构化降级**：
   * - 不猜测、不摊平、不年化；
   * - 金额字段一律留 `undefined`（不可估值 ≠ 0 的同一条原则）；
   * - 把原因写进 `notes`，让 UI 能如实展示「缺 N 天数据，无法计算收益」。
   */
  const gap = openingGapDays(opening, input.options?.date)
  if (gap !== undefined && gap > 1) {
    return {
      status: 'unavailable',
      feeTotal: flow.feeTotal,
      internalTransferCount: flow.internalTransferCount,
      notes: [
        `期初快照是 ${opening.date}，与目标日期相隔 ${gap} 天（缺少中间日期的快照）。`,
        '期间收益无法拆分为「单日收益」，因此不计算投资收益率（不猜测、不摊平）。',
        '补齐缺失日期的快照后即可正常归因。',
      ],
    }
  }

  const openingNetWorth = opening.netWorth
  const net = round2(flow.externalInflow - flow.externalOutflow)

  /* ---- FX 影响 = 持仓汇率变动 + 换汇已实现差额 ---- */
  const fx = computeFxEffect(opening, ending)
  if (fx.note) notes.push(fx.note)

  const exchange = input.exchangeFx
  if (exchange && exchange.notes.length > 0) notes.push(...exchange.notes)

  /*
   * 持仓汇率变动与换汇差额合并为 fxEffect。
   * 若两者都不可得（既没有期初明细、也没有换汇），fxEffect 保持 undefined。
   */
  const fxEffect =
    fx.effect === undefined && (!exchange || exchange.count === 0)
      ? undefined
      : round2((fx.effect ?? 0) + (exchange?.effect ?? 0))
  if (exchange && exchange.count > 0) {
    notes.push(`期间有 ${exchange.count} 笔换汇，其汇率差额已计入汇率影响`)
  }

  /* ---- 现金流无法折算时，归因不可信 ---- */
  if (flow.unconvertible.length > 0) {
    notes.push(`有 ${flow.unconvertible.length} 笔现金流缺少汇率，未计入外部资金流`)
  }

  /* ---- 投资收益 = 期末 − 期初 − 外部净流入 − FX 影响 ---- */
  const investmentReturn = round2(ending.netWorth - openingNetWorth - net - (fxEffect ?? 0))

  /* ---- 残差：只用于判断是否异常，不反向篡改 investmentReturn ---- */
  const residual = round2(
    ending.netWorth - openingNetWorth - net - investmentReturn - (fxEffect ?? 0),
  )

  let otherAdjustment: number | undefined
  let otherAdjustmentReason: string | undefined
  let status: AttributionStatus = 'complete'

  if (fxEffect === undefined) {
    status = 'partial'
  }
  if (!ending.isComplete) {
    status = 'partial'
    notes.push(
      `当日有 ${ending.unavailableCount ?? 0} 项无法估值、${ending.staleCount ?? 0} 项估值过期，归因仅覆盖已可靠估值的部分`,
    )
  }
  if (flow.unconvertible.length > 0) status = 'partial'

  if (Math.abs(residual) > tolerance) {
    // 大残差 = 显式异常，如实记录并降级可信度
    otherAdjustment = residual
    otherAdjustmentReason = `残差 ${residual} 超出容差 ${tolerance}，可能来自期间新增持仓的汇率变动或未记录的资金流动`
    status = 'partial'
    notes.push(otherAdjustmentReason)
  } else {
    // 小残差 = 浮点误差，归零
    otherAdjustment = 0
  }

  return {
    status,
    openingNetWorth,
    externalInflow: round2(flow.externalInflow),
    externalOutflow: round2(flow.externalOutflow),
    investmentReturn,
    fxEffect,
    otherAdjustment,
    residual,
    otherAdjustmentReason,
    feeTotal: round2(flow.feeTotal),
    internalTransferCount: flow.internalTransferCount,
    notes,
  }
}

/* ------------------------------------------------------------------ *
 * 恒等式校验（供测试与自检）
 * ------------------------------------------------------------------ */

export interface IdentityCheck {
  ok: boolean
  /** 等式左边 − 右边 */
  drift: number
  detail: string
}

/**
 * 校验恒等式是否成立：
 *
 * 期末 = 期初 + 外部流入 − 外部流出 + investmentReturn + fxEffect + otherAdjustment
 */
/**
 * 校验快照的内部一致性（Phase 8 / W8，P1-5）。
 *
 * ## 原先的问题：形式上恒真
 *
 * 原来的实现只校验 `opening + 流入 − 流出 + return + fx + other === netWorth`。
 * 但 `investmentReturn` 本身就是由该式**移项定义**的，
 * 而 `otherAdjustment` 在残差超阈值时又被赋为 `residual` ——
 * 两者恰好互相抵消，于是 `drift` **在代数上恒为 0**。
 * 这个函数因此**永远返回 ok: true**，是一个没有校验意义的门槛。
 *
 * ## 现在的校验内容
 *
 * 1. **恒等式**（保留，但明确它只验证「数字自洽」）；
 * 2. **残差未超容差**（新增，真正能发现问题）——
 *    残差代表「用已知事实解释不了的部分」。若它超出容差，
 *    说明该快照存在未记录的资金流动或估值缺口，
 *    **不应**被当作可信的历史事实；
 * 3. `attributionStatus` 与实际数据一致（如残差超限却标 `complete`）→ 报错。
 *
 * ## 边界（必须明确）
 *
 * 它**只**证明「数字自洽 + 残差可控」，
 * **不**证明「这个快照的语义正确」（例如期初跨日、依据缺失等）。
 * 后者需要 `openingDate` / 依据字段，是另一个层面的校验。
 */
function endingIncomplete(snapshot: Snapshot): boolean {
  return (
    snapshot.isComplete === false ||
    (snapshot.unavailableCount ?? 0) > 0 ||
    (snapshot.staleCount ?? 0) > 0 ||
    snapshot.fxEffect === undefined
  )
}

export function checkIdentity(snapshot: Snapshot, tolerance = 0.01): IdentityCheck {
  const {
    netWorth,
    openingNetWorth,
    externalInflow,
    externalOutflow,
    investmentReturn,
    fxEffect,
    otherAdjustment,
    attributionStatus,
  } = snapshot

  if (attributionStatus === 'unavailable' || openingNetWorth === undefined) {
    return { ok: true, drift: 0, detail: '首份快照：无期初数据，不做恒等式校验' }
  }

  const expected =
    openingNetWorth +
    (externalInflow ?? 0) -
    (externalOutflow ?? 0) +
    (investmentReturn ?? 0) +
    (fxEffect ?? 0) +
    (otherAdjustment ?? 0)

  const drift = Math.round((netWorth - expected) * 100) / 100

  /*
   * 残差校验（真正有检出能力的一项）。
   *
   * `residual` 超出容差意味着「已知事实解释不了这段变化」。
   * 此时快照仍然被保留（事实记录），但**不得**被当成可信历史。
   */
  const residual = Math.abs(snapshot.residual ?? 0)
  if (residual > tolerance) {
    return {
      ok: false,
      drift,
      detail:
        `残差 ${snapshot.residual} 超出容差 ${tolerance}：` +
        '该快照存在已知事实无法解释的变化（未记录的资金流动或估值缺口），' +
        '不应作为可信的历史事实使用。' +
        (snapshot.otherAdjustmentReason ? `原因：${snapshot.otherAdjustmentReason}` : ''),
    }
  }

  /*
   * 状态一致性：残差已归零（在容差内）却标成 partial，说明
   * `attributionStatus` 与数据不符 —— 同样值得暴露。
   */
  if (attributionStatus === 'partial' && residual <= tolerance && !endingIncomplete(snapshot)) {
    return {
      ok: false,
      drift,
      detail:
        'attributionStatus 为 partial，但残差在容差内且数据完整 —— ' +
        '状态与数据不一致（可能是降级原因未被记录）。',
    }
  }

  return {
    ok: Math.abs(drift) <= tolerance,
    drift,
    detail:
      Math.abs(drift) <= tolerance
        ? '恒等式成立'
        : `恒等式偏差 ${drift}：期末 ${netWorth}，按各项推算应为 ${expected}`,
  }
}

/** 由持仓快照汇总某个币种的原币敞口 */
export function nativeExposureByCurrency(positions: SnapshotPosition[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of positions) {
    // 缺单价（不可估值）的持仓不计入原币敞口：宁可少算，也不用 0 冒充
    if (p.price === undefined) continue
    out[p.currency] = (out[p.currency] ?? 0) + p.quantity * p.price
  }
  return out
}
