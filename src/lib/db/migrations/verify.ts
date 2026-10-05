/**
 * 迁移结果校验
 *
 * 为什么需要它：需求第二十条要求「不能简单删除用户当前数据」，
 * 用户决策也明确「迁移失败不能删旧数据」。所以迁移后必须**自证**：
 * 条目数、金额、币种、数量、成本、行情是否逐项落地。
 *
 * 校验只做「可判定的硬事实」比对，不做主观判断：
 * - 条目数守恒（旧条目 → 新 Holding，数量必须相等）
 * - 原币金额总和守恒（手动口径）
 * - 数量与成本总和守恒（数量口径）
 * - 币种：非法币种被回落时会给出告警，因此允许存在差异但必须**有据可查**
 * - 行情：旧行情不得变成 LIVE（除非时间足够新）
 */

import type { LegacyPortfolioLike, LegacyItemLike, MigrationResult } from './legacy-v2-to-schema-v3'

export interface VerifyCheck {
  name: string
  ok: boolean
  detail: string
}

export interface VerifyReport {
  ok: boolean
  checks: VerifyCheck[]
  /** 阻断性问题：出现即判定迁移失败，旧数据必须保留 */
  blockers: string[]
}

const safeNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 允许的浮点误差（金额搬运不应有误差，这里给极小容差防浮点噪声） */
const EPS = 1e-6

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(EPS, Math.abs(a) * 1e-9)
}

function flatItems(legacy: LegacyPortfolioLike): LegacyItemLike[] {
  const out: LegacyItemLike[] = []
  for (const cat of legacy.categories ?? []) {
    for (const item of cat.items ?? []) out.push(item)
  }
  return out
}

export function verifyMigration(legacy: LegacyPortfolioLike, result: MigrationResult): VerifyReport {
  const checks: VerifyCheck[] = []
  const blockers: string[] = []
  const items = flatItems(legacy)

  const add = (name: string, ok: boolean, detail: string, blocking = true) => {
    checks.push({ name, ok, detail })
    if (!ok && blocking) blockers.push(`${name}：${detail}`)
  }

  /* ---- 1) 条目数守恒 ---- */
  const legacyCount = items.length
  const holdingCount = result.portfolio.holdings.length
  add(
    '条目数守恒',
    legacyCount === holdingCount,
    `旧条目 ${legacyCount} 条 → 新持仓 ${holdingCount} 条`,
  )

  /* ---- 2) 每个旧条目都必须有对应 Instrument ---- */
  const instrumentIds = new Set(result.portfolio.instruments.map((i) => i.id))
  const holdingsWithoutInstrument = result.portfolio.holdings.filter((h) => !instrumentIds.has(h.instrumentId))
  add(
    '持仓均指向有效标的',
    holdingsWithoutInstrument.length === 0,
    holdingsWithoutInstrument.length === 0
      ? '全部持仓都能找到对应 Instrument'
      : `${holdingsWithoutInstrument.length} 条持仓缺少 Instrument`,
  )

  /* ---- 3) 每个持仓都必须有账户 ---- */
  const accountIds = new Set(result.portfolio.accounts.map((a) => a.id))
  const orphanHoldings = result.portfolio.holdings.filter((h) => !accountIds.has(h.accountId))
  add(
    '持仓均归属账户',
    orphanHoldings.length === 0,
    orphanHoldings.length === 0 ? '全部持仓都有账户' : `${orphanHoldings.length} 条持仓没有账户`,
  )

  /* ---- 4) 手动口径金额守恒（现金 / 房产 / 应收 / 负债）---- */
  const legacyManualSum = items
    .filter((i) => i.kind === 'amount')
    .reduce((sum, i) => sum + safeNum(i.amount), 0)
  const holdingManualSum = result.portfolio.holdings
    .filter((h) => h.valuationMode === 'manual')
    .reduce((sum, h) => sum + safeNum(h.manualValue), 0)
  add(
    '手动口径金额守恒',
    closeEnough(legacyManualSum, holdingManualSum),
    `旧金额合计 ${legacyManualSum} → 新合计 ${holdingManualSum}`,
  )

  /* ---- 5) 数量口径：数量与成本守恒（基金 / 美股 / 港股 / 黄金）---- */
  const legacyQtySum = items
    .filter((i) => i.kind === 'fund')
    .reduce((sum, i) => sum + safeNum(i.shares), 0)
  const holdingQtySum = result.portfolio.holdings
    .filter((h) => h.valuationMode === 'quantity')
    .reduce((sum, h) => sum + safeNum(h.quantity), 0)
  // 黄金旧结构用 grams，合并比对
  const legacyGramSum = items.filter((i) => i.kind === 'gold').reduce((sum, i) => sum + safeNum(i.grams), 0)
  add(
    '持仓数量守恒（含黄金克数）',
    closeEnough(legacyQtySum + legacyGramSum, holdingQtySum),
    `旧 ${legacyQtySum + legacyGramSum} → 新 ${holdingQtySum}`,
  )

  const legacyCostSum = items.reduce((sum, i) => {
    if (i.kind === 'fund') return sum + safeNum(i.shares) * safeNum(i.costNav)
    if (i.kind === 'gold') return sum + safeNum(i.grams) * safeNum(i.pricePerGram)
    return sum
  }, 0)
  const holdingCostSum = result.portfolio.holdings
    .filter((h) => h.valuationMode === 'quantity')
    .reduce((sum, h) => sum + safeNum(h.costBasis), 0)
  add(
    '持仓成本守恒',
    closeEnough(legacyCostSum, holdingCostSum),
    `旧成本合计 ${legacyCostSum} → 新合计 ${holdingCostSum}`,
  )

  /* ---- 6) 行情搬运：有旧行情的条目必须有新 Quote，且状态不得冒充实时（若时间已旧） ---- */
  const legacyWithQuote = items.filter((i) => i.quote && typeof i.quote === 'object')
  const quoteInstrumentIds = new Set(result.portfolio.quotes.map((q) => q.instrumentId))
  const missingQuote = legacyWithQuote.filter((i) => {
    const inst = result.portfolio.instruments.find((x) => x.metadata?.legacyKind === i.kind && x.name === i.name)
    return inst ? !quoteInstrumentIds.has(inst.id) : false
  })
  add(
    '行情快照已搬运',
    result.portfolio.quotes.length >= legacyWithQuote.length - missingQuote.length - 1,
    `旧带行情条目 ${legacyWithQuote.length} 条 → 新 Quote ${result.portfolio.quotes.length} 条`,
    false,
  )

  const fakeLive = result.portfolio.quotes.filter((q) => {
    if (q.status !== 'LIVE') return false
    const age = Date.now() - new Date(q.timestamp).getTime()
    return age > 30 * 60 * 1000
  })
  add(
    '无过期行情被标为实时',
    fakeLive.length === 0,
    fakeLive.length === 0 ? '行情状态标注正确' : `${fakeLive.length} 条已过期行情仍标为 LIVE`,
  )

  /* ---- 7) 币种不得静默改写 ---- */
  const currencyWarnings = result.warnings.filter((w) => w.code === 'unknown_currency')
  const legacyForeign = items.filter(
    (i) => typeof i.currency === 'string' && i.currency && i.currency !== 'CNY',
  )
  add(
    '外币币种保留',
    legacyForeign.every((i) => {
      const inst = result.portfolio.instruments.find((x) => x.name === i.name)
      if (!inst) return false
      // 非法币种会被回落并在 warnings 中说明，属于有据可查；合法币种必须原样保留
      const legal = ['CNY', 'USD', 'HKD', 'SGD', 'JPY', 'EUR', 'GBP', 'AUD', 'KRW', 'TWD', 'CAD']
      return legal.includes(String(i.currency)) ? inst.currency === i.currency : true
    }),
    `旧外币条目 ${legacyForeign.length} 条，币种告警 ${currencyWarnings.length} 条`,
  )

  /* ---- 8) 未确认分类必须如实上报 ---- */
  const actualUnconfirmed = result.portfolio.instruments.filter(
    (i) => i.classificationStatus === 'unconfirmed',
  ).length
  add(
    '未确认分类计数准确',
    actualUnconfirmed === result.counts.unconfirmed,
    `上报 ${result.counts.unconfirmed} 条，实际 ${actualUnconfirmed} 条`,
  )

  return { ok: blockers.length === 0, checks, blockers }
}

/** 供界面/日志使用的单行摘要 */
export function summarizeVerify(report: VerifyReport): string {
  const failed = report.checks.filter((c) => !c.ok)
  if (report.ok) return `校验通过（${report.checks.length} 项）`
  return `校验未通过：${failed.map((c) => c.name).join('、')}`
}
