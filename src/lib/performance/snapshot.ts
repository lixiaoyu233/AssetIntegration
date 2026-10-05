/**
 * Snapshot 组装与写入
 *
 * 职责：把「当前资产状态 + 当日交易 + 汇率」组装成一份可持久化的 Snapshot。
 *
 * 关键约束（用户确认的口径）：
 *
 * 1. **写快照的职责是记录当天实际算得出来的状态**，因此
 *    即使 `isComplete = false`、有 stale/unavailable、缺 FX、无法完整归因，
 *    **也必须写入**，不能因为归因失败就丢弃历史事实。
 * 2. **同日幂等**：同一天重复执行只更新、不新增（依赖 `upsertForDate`）。
 * 3. **不填假数据**：无法计算的字段一律 `undefined`，绝不用 0 冒充。
 * 4. **positions 只记录实际持仓状态**，交易 / leg 不会再次计入总额。
 */

import type { Portfolio2, Snapshot, SnapshotPosition, Transaction } from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { type FxTable, resolveRate } from '../valuation/fx'
import { valuateHolding } from '../valuation/engine'
import { type QuotePolicy } from '../valuation/policy'
import { classifyPortfolioFlows } from './cashflow'
import { activeTransactions } from '../ledger/lifecycle'
import { type Attribution, attribute, computeExchangeFxEffect } from './attribution'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 取**本地日**（`YYYY-MM-DD`）。
 *
 * ## 为什么必须用本地日（Phase 8 / W7 修正）
 *
 * 此前快照日期用 `toISOString().slice(0,10)`，即 **UTC 日**；
 * 而交易时间戳由 UI 按**本地中午**写入。对 UTC+8 用户：
 *
 * ```
 * 本地 2026-10-05 07:00 打开应用
 *   → UTC 仍是 2026-10-04 → 快照日期 = "2026-10-04"
 *   → byDate("2026-10-04") 命中昨天那份 → already-captured
 *   → 今天的快照**完全不会产生**（且当天稍后也无法补救）
 * ```
 *
 * 用本地日即可消除这一错位：用户在本地哪一天打开，就落在哪一天。
 */
export function localDate(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 由日期字符串取上一日（用于找期初快照） */
export function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export interface BuildSnapshotOptions {
  /** 快照日期 YYYY-MM-DD；缺省为今天（UTC） */
  date?: string
  /** 汇率表；缺省用 portfolio.fxRates */
  fx?: FxTable
  policy?: QuotePolicy
  now?: number
  /** 期初快照；缺省视为首日 */
  opening?: Snapshot
}

export interface SnapshotBuildResult {
  snapshot: Snapshot
  attribution: Attribution
  /** 当日参与计算的交易 */
  transactions: Transaction[]
}

/* ------------------------------------------------------------------ *
 * 构建
 * ------------------------------------------------------------------ */

/**
 * 组装快照。**纯函数**：不读写存储，便于测试与预览。
 */
export function buildSnapshot(
  portfolio: Portfolio2,
  options: BuildSnapshotOptions = {},
): SnapshotBuildResult {
  // 缺省用**本地日**（见 localDate 的说明）
  const date = options.date ?? localDate(new Date(options.now ?? Date.now()))
  const fx = options.fx ?? { rates: portfolio.fxRates }
  const policy = options.policy

  /* ---- 1) 逐持仓估值，并生成持仓级明细 ---- */
  const positions: SnapshotPosition[] = []
  let totalAssets = 0
  let totalLiabilities = 0
  const assetAllocation: Record<string, number> = {}
  let unavailableCount = 0
  let staleCount = 0

  for (const holding of portfolio.holdings) {
    const r = valuateHolding(holding, portfolio, {
      fx,
      now: options.now,
      policy,
    })
    const instrument = portfolio.instruments.find((i) => i.id === holding.instrumentId)
    const currency = r.currency

    // 汇率：CNY 恒为 1；外币取实际可用汇率（缺失则不写数字，标 unreliable）
    const resolved = currency === 'CNY' ? 1 : resolveRate(fx, currency, 'CNY', { now: options.now })?.rate

    const isCash = instrument?.instrumentType === 'cash' || instrument?.assetClass === 'cash'

    /*
     * ## 原币价值与单价（Schema V7 起不再用数字伪造缺失）
     *
     * V7 之前的写法是：
     * ```
     * const nativeValue = r.valueInCurrency ?? r.fallbackValueInCurrency ?? 0
     * price: round2(price) || 1
     * valueCny: reliable && r.value !== undefined ? round2(r.value) : 0
     * ```
     * 这会把「不可估值」写成 `0` / `1`，**违反核心不变量「不可估值 ≠ 价值为 0」**：
     * 一个 `valueCny: 0` 的持仓脱离 `reliable` 标记后，与「真的不值钱」无法区分。
     *
     * 现在的规则：
     * - 有可用原币价值（ok / stale）→ 如实写；
     * - 无可用价值 → `price` / `valueCny` 写 **`undefined`**，靠 `reliable: false` 表达；
     * - 现金与手动口径的单价确实是 1（数量即金额），那不是伪造而是事实。
     */
    /*
     * ⚠️ `price` **只来自真实可用估值**（`valueInCurrency`），
     * 绝不使用 `fallbackValueInCurrency`。
     *
     * 后者是引擎给出的**成本价线索**（缺行情时的展示兜底）。
     * 若用它算单价，快照里就会出现一个「看起来有价格、却无法证明来源」的数字 ——
     * 这正是 W6 审计指出的问题（例：成本 1000 / 100 股 → price 10，
     * 与真实市价 10 在快照里完全无法区分）。
     */
    const price =
      holding.valuationMode === 'manual' || isCash
        ? 1
        : r.valueInCurrency !== undefined && holding.quantity
          ? r.valueInCurrency / holding.quantity
          : undefined

    const reliable = r.status === 'ok'
    if (r.status === 'unavailable') unavailableCount += 1
    if (r.status === 'stale') staleCount += 1

    if (reliable && r.value !== undefined) {
      /*
       * 负债判定**只读估值结果**（W8 统一口径）。
       *
       * 原先这里写 `r.assetClass === 'liability'`，同样忽略账户的 isLiability，
       * 导致「负债账户下的持仓」被算进总资产 —— 净资产虚高。
       */
      if (r.isLiability) {
        totalLiabilities += Math.abs(r.value)
      } else {
        totalAssets += r.value
        const cls = r.assetClass ?? 'other'
        assetAllocation[cls] = (assetAllocation[cls] ?? 0) + r.value
      }
    }

    // 数量：数量口径用 quantity；现金/手动口径用金额表达（数量即金额）
    const quantity =
      holding.valuationMode === 'manual' || isCash ? round2(holding.manualValue ?? holding.quantity ?? 0) : (holding.quantity ?? 0)

    /*
     * 记录**捕获当时**的资产类别（Schema V4）。
     *
     * 只写用户**已确认**的分类；未确认时保持 `undefined` ——
     * 不能把「迁移时的线索」当成历史事实写进快照。
     */
    const classAtCapture =
      instrument && instrument.classificationStatus === 'confirmed' ? instrument.assetClass : undefined

    /*
     * 记录**捕获当时**的负债判定（W8）。
     *
     * 与 `assetClassAtCapture` 同理：负债判定依赖账户与标的的当前状态，
     * 事后用今天的状态回溯会重画历史。因此把结论固化进快照，
     * 让「历史资产占比」能够按 gross assets 正确切分。
     */
    const isLiabilityAtCapture = r.isLiability

    /*
     * ---- 估值依据（Schema V8 / W8）----
     *
     * 记录**当时实际用到**的依据，让历史快照能够自证：
     * 「这一天这个价，来自哪个来源、什么类型、哪一刻、什么状态」。
     *
     * 原则：
     * - 只记录**真实存在**的依据；取不到就留 `undefined`（`UNKNOWN`），
     *   **绝不用今天的值、成本价或 0/1 伪造**；
     * - 不因为「新字段存在」就强行填值 —— 那会制造看起来很完整的假依据。
     */
    /*
     * 依据直接来自**估值引擎上报的 `r.basis`**。
     *
     * 为什么不让快照自己查：引擎是唯一握着「实际用到的 quote」的地方；
     * 快照若自己按 instrumentId 反查，会拿到「最新的」而不是「当时用的」，
     * 那正是历史不可自证的根源。
     */
    const basis = {
      /*
       * 降级原因（P1-2）：不可估值时如实落盘，供历史解释。
       * 可靠估值时为空数组 —— 不写无意义的占位。
       */
      reasons: reliable ? [] : r.reasons,
      asOf: r.asOf,
      priceKind: r.basis?.priceKind,
      quoteStatus: r.basis?.quoteStatus,
      quoteSource: r.basis?.quoteSource,
      fxStatus: r.basis?.fxStatus,
      fxSource: r.basis?.fxSource,
    }

    positions.push({
      instrumentId: holding.instrumentId,
      accountId: holding.accountId,
      quantity,
      price: price === undefined ? undefined : round2(price),
      currency,
      // 汇率不可解析 → undefined（既不写 1 冒充，也不写 0）；CNY 恒为 1
      rateToCny: resolved,
      // 不可估值 → undefined（**绝不写 0**）
      valueCny: reliable && r.value !== undefined ? round2(r.value) : undefined,
      /*
       * stale 的展示价（P1-3）：只记录「当时确实读到、但已过期」的价格，
       * 让历史快照仍能解释「那天大概值多少」。**不参与总额**。
       * 不可估值（无价可读）时保持 undefined —— 绝不用成本价冒充。
       */
      staleValueCny:
        r.status === 'stale' && r.staleDisplayValueCny !== undefined
          ? round2(r.staleDisplayValueCny)
          : undefined,
      reliable,
      assetClassAtCapture: classAtCapture,
      isLiabilityAtCapture,
      ...basis,
    })
  }

  const netWorth = round2(totalAssets - totalLiabilities)

  /*
   * 捕获时刻（Schema V8）。
   *
   * 刻意用一次 `new Date()` 取值并复用给 `createdAt` 与 `capturedAt`，
   * 避免同一份快照里出现两个不同时刻（`createdAt` 与 `capturedAt` 互相矛盾）。
   */
  const capturedAtIso = new Date(options.now ?? Date.now()).toISOString()

  /* ---- 2) 当日交易 → 外部现金流 ---- */
  /*
   * 快照的当日交易（Phase 8 / W5）。
   *
   * ⚠️ 这里**不经过** `deriveLedger`，是一条独立路径 ——
   * 因此必须**同样过滤已作废交易**，否则 Ledger 与 Snapshot 会不一致：
   * 已作废交易仍会被算进当日的现金流归因。
   *
   * 注意：**已生成的历史快照不回溯修改**（快照是「当时的事实」）。
   */
  const transactions = activeTransactions(portfolio.transactions).filter(
    (t) => t.timestamp.slice(0, 10) === date,
  )

  const converter = (amount: number, currency: string): number | undefined => {
    if (currency === 'CNY') return amount
    const r = resolveRate(fx, currency as never, 'CNY', { now: options.now })
    return r ? amount * r.rate : undefined
  }
  const flow = classifyPortfolioFlows(portfolio, transactions, converter)

  /* ---- 3) 组装快照外壳（归因字段先留空，由 attribute 填充） ---- */
  const base: Snapshot = {
    id: `snap_${date}`,
    date,
    totalAssets: round2(totalAssets),
    totalLiabilities: round2(totalLiabilities),
    netWorth,
    currency: 'CNY',
    assetAllocation: assetAllocation as Snapshot['assetAllocation'],
    positions,
    unavailableCount,
    staleCount,
    isComplete: unavailableCount === 0 && staleCount === 0,
    /*
     * `captureKind` 只在此处产生 `REAL`。
     *
     * `BACKFILLED` / `ESTIMATED` 是**为未来的回填能力预留**的取值 ——
     * 当前没有任何路径会写它们，因为历史回填需要 as-of 估值能力（尚未具备）。
     * 一旦将来实现回填，必须写入相应取值，**不得再标 REAL**。
     */
    captureKind: 'REAL',
    attributionStatus: 'unavailable',
    createdAt: capturedAtIso,
    // ---- Schema V8：时间语义 ----
    /*
     * 期初快照的日期。取不到就留 undefined（不回填、不猜测）。
     * 有了它，`openingNetWorth` 才能自证「从哪一天开始算」。
     */
    openingDate: options.opening?.date,
    /*
     * 本次内容对应的捕获时刻。
     * 与 `createdAt` 的区别：当日快照可被多次刷新，`createdAt` 是首次创建时间。
     */
    capturedAt: capturedAtIso,
  }

  /* ---- 4) 归因 ---- */
  // 换汇的已实现汇率差额：归入 fxEffect，不计入投资收益
  const exchangeFx = computeExchangeFxEffect(transactions, converter)

  const attribution = attribute({
    opening: options.opening,
    ending: base,
    flow,
    exchangeFx,
    // 传入目标日期：触发 opening 间隔检测，避免把「整个间隔期的收益」写成当日收益
    options: { date },
  })

  const snapshot: Snapshot = {
    ...base,
    openingNetWorth: attribution.openingNetWorth,
    externalInflow: attribution.externalInflow,
    externalOutflow: attribution.externalOutflow,
    investmentReturn: attribution.investmentReturn,
    fxEffect: attribution.fxEffect,
    otherAdjustment: attribution.otherAdjustment,
    residual: attribution.residual,
    otherAdjustmentReason: attribution.otherAdjustmentReason,
    internalTransferCount: attribution.internalTransferCount,
    feeTotal: attribution.feeTotal,
    attributionStatus: attribution.status,
    attributionNotes: attribution.notes.length > 0 ? attribution.notes : undefined,
  }

  return { snapshot, attribution, transactions }
}

/* ------------------------------------------------------------------ *
 * 便捷派生量
 * ------------------------------------------------------------------ */

/** 外部净流入 */
export function externalNetFlow(snapshot: Snapshot): number | undefined {
  if (snapshot.externalInflow === undefined || snapshot.externalOutflow === undefined) return undefined
  return round2(snapshot.externalInflow - snapshot.externalOutflow)
}

/** 该快照是否可用于展示「今天赚了多少」 */
export function canShowReturn(snapshot: Snapshot): boolean {
  return (
    snapshot.attributionStatus === 'complete' &&
    snapshot.investmentReturn !== undefined &&
    snapshot.isComplete === true
  )
}

/* ------------------------------------------------------------------ *
 * 写入（幂等）
 * ------------------------------------------------------------------ */

export interface CaptureResult {
  snapshot: Snapshot
  /** 是新建还是更新了已有记录 */
  action: 'created' | 'updated'
  attribution: Attribution
}

export interface CaptureOptions extends BuildSnapshotOptions {
  /** 仅预览不写入 */
  dryRun?: boolean
}

/**
 * 生成并写入当日快照。
 *
 * 幂等：同一天重复调用只会更新同一条记录（`id` 与 `createdAt` 保留）。
 * 即使归因不完整也会写入 —— 快照的首要职责是记录事实。
 */
export async function captureSnapshot(
  repo: PortfolioRepository,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const portfolio = await repo.loadPortfolio()
  // 缺省用**本地日**（与 buildSnapshot 一致；此前这里是 UTC 日，两者口径不同）
  const date = options.date ?? localDate(new Date(options.now ?? Date.now()))

  /*
   * ## 日期守卫（Phase 8 / W8，P0-1）
   *
   * ### 为什么必须拦
   *
   * `buildSnapshot` 用的是**当前**持仓、**最新**行情、**当前**汇率 ——
   * 它没有 as-of 能力。因此对**过去或未来**的日期调用它，会产出一份
   * 「日期在过去/未来、数据却是现在、`captureKind` 标为 `REAL`」的快照。
   * 那是**伪造历史事实**，正是本项目明确禁止的行为。
   *
   * ### 为什么守卫放在这里而不是只在 captureRange
   *
   * `captureRange` 只是 `captureSnapshot` 的一个调用方。若只在那一层拦，
   * 任何直接调用 `captureSnapshot({ date: 过去 })` 的代码（API / UI / 未来功能）
   * 都能绕过它 —— W8 审计确认这正是当时唯一的破口。
   * 因此守卫必须落在**唯一的写入原语**上。
   *
   * ### 规则
   *
   * | 日期 | 处理 |
   * | --- | --- |
   * | 本地今天 | 允许（当日可刷新） |
   * | 过去 | **拒绝**（需要 as-of 能力，尚未具备） |
   * | 未来 | **拒绝**（未来尚未发生，不可能有事实） |
   *
   * `dryRun`（仅预览、不写入）**不受限**，因为它不产生任何历史事实。
   */
  if (!options.dryRun) {
    const today = localDate(new Date(options.now ?? Date.now()))
    if (date < today) {
      throw new Error(
        `拒绝为过去日期（${date}）创建快照：估值使用的是当前持仓、最新行情与当前汇率，` +
          '不具备「按当时价格重建」的 as-of 能力。历史日期补录会产出伪造历史，' +
          '因此必须来自当时真实发生的事实，而不是事后重算。',
      )
    }
    if (date > today) {
      throw new Error(
        `拒绝为未来日期（${date}）创建快照：未来尚未发生，不可能存在资产事实。`,
      )
    }
  }

  /*
   * 期初：优先用传入值，否则取「目标日期之前最近的一份」快照。
   *
   * W9/P1-1：原实现 `getAll()` + filter + sort 会把**整张快照表**读进内存。
   * 快照表每天 +1 且无裁剪，而这条路径每次开 App、每次写入都要走，
   * 于是「找期初」的代价随使用年限线性上升。
   *
   * 现在交给 `previousBefore()` 用 `date` 索引直接定位。
   *
   * ⚠️ W10-Patch/P1-2 更正：W9 的实现用了 `.below(date).reverse().sortBy('date')`，
   * 而 Dexie 的 `sortBy` 会 `toArray()` 后全排序 —— 优化**当时并未生效**
   * （实测与全表读同阶）。现已改为 `.reverse().first()`，真正只读一条。
   *
   * ⚠️ 语义完全不变：仍是「date 严格小于目标日期的**最新**一份」。
   * 刻意**不做**间隔补齐（那会变成猜测历史）。
   */
  let opening = options.opening
  if (!opening) {
    opening = await repo.snapshots.previousBefore(date)
  }

  const existing = await repo.snapshots.byDate(date)
  const { snapshot, attribution } = buildSnapshot(portfolio, { ...options, date, opening })

  // 保留原有的 id 与 createdAt，体现「更新而非新增」
  const toSave: Snapshot = existing
    ? { ...snapshot, id: existing.id, createdAt: existing.createdAt }
    : snapshot

  if (options.dryRun) {
    return { snapshot: toSave, action: existing ? 'updated' : 'created', attribution }
  }

  await repo.snapshots.upsertForDate(toSave)
  return { snapshot: toSave, action: existing ? 'updated' : 'created', attribution }
}

/** 批量补齐一段日期区间缺失的快照（用于导入后回填），同日幂等 */
/**
 * 批量补齐一段日期区间的快照。
 *
 * ## ⚠️ W7 起**禁止对过去日期补录**
 *
 * 原因：`buildSnapshot` 的估值遍历的是**当前** `portfolio.holdings`、
 * 取全局**最新**行情、用**当前**汇率 —— 它没有 as-of 能力。
 * 因此对过去日期调用它，会批量产出
 * 「日期在过去、数据是现在」的记录，且 `captureKind` 仍被标为 `REAL`。
 * 那是**伪造历史**，正是本项目明确禁止的行为。
 *
 * 在真正的 as-of 重建能力具备之前，本函数只接受「今天」，
 * 并且在被误用时**明确抛错**而不是静默降级。
 */
export async function captureRange(
  repo: PortfolioRepository,
  fromDate: string,
  toDate: string,
  options: Omit<CaptureOptions, 'date'> = {},
): Promise<CaptureResult[]> {
  /*
   * W7 止血：只允许「今天」。过去日期需要 as-of 估值能力，当前不具备。
   * 明确抛错优于静默产出假历史。
   */
  const today = localDate(new Date(options.now ?? Date.now()))
  if (fromDate < today || toDate < today) {
    throw new Error(
      'captureRange 目前只支持今天：历史日期需要「按当时价格与持仓」重建（as-of），' +
        '当前不具备该能力。对过去日期补录会产出伪造历史，因此已拒绝。',
    )
  }
  const dates: string[] = []
  const cursor = new Date(`${fromDate}T00:00:00.000Z`)
  const end = new Date(`${toDate}T00:00:00.000Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  const out: CaptureResult[] = []
  for (const d of dates) {
    out.push(await captureSnapshot(repo, { ...options, date: d }))
  }
  return out
}
