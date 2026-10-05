/**
 * 估值引擎与 FX 的测试数据构造器
 *
 * 只构造结构化数据，不含任何真实财务信息。
 */

import type {
  Account,
  AllocationProfile,
  CurrencyCode,
  FxRate,
  FxStatus,
  Holding,
  Instrument,
  Portfolio2,
  Quote,
  Snapshot,
  Transaction,
} from '../../../types/portfolio2'

export const ISO = '2026-10-03T10:00:00.000Z'
export const NOW = new Date(ISO).getTime()

/**
 * 由「本地日」求一个落在**同一天**的时间戳（本地中午）。
 *
 * ## 为什么需要（Phase 8 / W8）
 *
 * `captureSnapshot` 现在有日期守卫：只允许创建**本地今天**的快照
 * （过去/未来都会抛错，因为估值没有 as-of 能力）。
 *
 * 而测试常写 `{ date: '2026-10-03', now: NOW }` —— 若 `NOW` 解析出的
 * 本地日与 `date` 不同，守卫就会（正确地）拒绝。这**不是**守卫的 bug，
 * 而是测试的时钟与它声称的日期不一致。
 *
 * 用这个辅助函数即可让两者一致，从而在**尊重守卫**的前提下
 * 测试「同一天幂等 / 刷新」等行为。
 *
 * ⚠️ 它**不能**用来测试「为过去日期创建快照」—— 那正是守卫要拦的行为，
 * 该类场景必须改为直接写入仓储（模拟「当时已存在的历史」）。
 */
export function nowForLocalDate(date: string): number {
  return new Date(`${date}T12:00:00`).getTime()
}

/** 本地今天（与 `snapshot.localDate()` 同口径） */
export function todayLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

let seq = 0
const nextId = (prefix: string) => `${prefix}_${++seq}`

/** 每个测试文件重置序号，保证 id 可预测 */
export function resetIds(): void {
  seq = 0
}

export function makeAccount(patch: Partial<Account> = {}): Account {
  return {
    id: patch.id ?? nextId('acct'),
    name: patch.name ?? '测试账户',
    type: patch.type ?? 'bank',
    currency: patch.currency ?? 'CNY',
    isLiability: patch.isLiability ?? false,
    createdAt: ISO,
    updatedAt: ISO,
    ...patch,
  }
}

export function makeInstrument(patch: Partial<Instrument> = {}): Instrument {
  return {
    id: patch.id ?? nextId('inst'),
    name: patch.name ?? '测试标的',
    instrumentType: patch.instrumentType ?? 'cash',
    assetClass: patch.assetClass ?? 'cash',
    currency: patch.currency ?? 'CNY',
    classificationStatus: patch.classificationStatus ?? 'confirmed',
    createdAt: ISO,
    updatedAt: ISO,
    ...patch,
  }
}

export function makeHolding(patch: Partial<Holding> = {}): Holding {
  return {
    id: patch.id ?? nextId('hold'),
    accountId: patch.accountId ?? 'acct_1',
    instrumentId: patch.instrumentId ?? 'inst_1',
    valuationMode: patch.valuationMode ?? 'manual',
    createdAt: ISO,
    updatedAt: ISO,
    ...patch,
  }
}

export function makeQuote(patch: Partial<Quote> = {}): Quote {
  return {
    id: patch.id ?? nextId('quote'),
    instrumentId: patch.instrumentId ?? 'inst_1',
    priceKind: patch.priceKind ?? 'market_price',
    marketPrice: patch.marketPrice,
    nav: patch.nav,
    estimatedNav: patch.estimatedNav,
    currency: patch.currency ?? 'CNY',
    source: patch.source ?? 'test',
    timestamp: patch.timestamp ?? ISO,
    status: patch.status ?? 'LIVE',
    ...patch,
  }
}

export function makeFxRate(
  base: CurrencyCode,
  quote: CurrencyCode,
  rate: number,
  patch: Partial<FxRate> = {},
): FxRate {
  return {
    id: patch.id ?? nextId('fx'),
    baseCurrency: base,
    quoteCurrency: quote,
    rate,
    timestamp: patch.timestamp ?? ISO,
    source: patch.source ?? 'test',
    status: (patch.status ?? 'LIVE') as FxStatus,
    ...patch,
  }
}

export function makeSnapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    id: patch.id ?? nextId('snap'),
    date: patch.date ?? '2026-10-03',
    totalAssets: patch.totalAssets ?? 0,
    totalLiabilities: patch.totalLiabilities ?? 0,
    netWorth: patch.netWorth ?? 0,
    currency: 'CNY',
    assetAllocation: patch.assetAllocation ?? {},
    positions: patch.positions ?? [],
    attributionStatus: patch.attributionStatus ?? 'unavailable',
    createdAt: patch.createdAt ?? ISO,
    ...patch,
  }
}

export function makePortfolio(patch: Partial<Portfolio2> = {}): Portfolio2 {
  return {
    accounts: patch.accounts ?? [],
    instruments: patch.instruments ?? [],
    holdings: patch.holdings ?? [],
    transactions: (patch.transactions ?? []) as Transaction[],
    quotes: patch.quotes ?? [],
    fxRates: patch.fxRates ?? [],
    classificationAudit: patch.classificationAudit ?? [],
    snapshots: (patch.snapshots ?? []) as Snapshot[],
    allocationProfiles: (patch.allocationProfiles ?? []) as AllocationProfile[],
  }
}

/* ------------------------------------------------------------------ *
 * 常用组合构造器
 * ------------------------------------------------------------------ */

/**
 * 一个「多币种 + 多资产类别」的账户，用于验证：
 * 同一账户可同时容纳多种币种与多种 assetClass。
 */
export function multiCurrencyAccount(): {
  portfolio: Portfolio2
  accountId: string
} {
  const account = makeAccount({ id: 'acct_multi', name: '国际账户', type: 'broker', currency: 'USD', region: 'US' })

  const cashCny = makeInstrument({ id: 'i_cny', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY' })
  const cashUsd = makeInstrument({ id: 'i_usd', name: '美元现金', instrumentType: 'cash', assetClass: 'cash', currency: 'USD' })
  const cashHkd = makeInstrument({ id: 'i_hkd', name: '港币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'HKD' })
  const cashSgd = makeInstrument({ id: 'i_sgd', name: '新币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'SGD' })

  const holdings = [
    makeHolding({ id: 'h_cny', accountId: account.id, instrumentId: cashCny.id, manualValue: 10000 }),
    makeHolding({ id: 'h_usd', accountId: account.id, instrumentId: cashUsd.id, manualValue: 1000 }),
    makeHolding({ id: 'h_hkd', accountId: account.id, instrumentId: cashHkd.id, manualValue: 5000 }),
    makeHolding({ id: 'h_sgd', accountId: account.id, instrumentId: cashSgd.id, manualValue: 2000 }),
  ]

  return {
    accountId: account.id,
    portfolio: makePortfolio({
      accounts: [account],
      instruments: [cashCny, cashUsd, cashHkd, cashSgd],
      holdings,
    }),
  }
}

/** 汇率表：USD 7.2 / HKD 0.92 / SGD 5.4（对 CNY） */
export function cnyRates(now = NOW): FxRate[] {
  return [
    makeFxRate('USD', 'CNY', 7.2, { timestamp: new Date(now - 60_000).toISOString() }),
    makeFxRate('HKD', 'CNY', 0.92, { timestamp: new Date(now - 60_000).toISOString() }),
    makeFxRate('SGD', 'CNY', 5.4, { timestamp: new Date(now - 60_000).toISOString() }),
  ]
}

/** 一个按资产类别构成的组合（用于按类别汇总断言） */
export function assetClassMix(): Portfolio2 {
  const acct = makeAccount({ id: 'acct_mix', name: '混合账户' })
  const cash = makeInstrument({ id: 'i1', name: '现金', assetClass: 'cash', instrumentType: 'cash', currency: 'CNY' })
  const equity = makeInstrument({ id: 'i2', name: '股票', assetClass: 'equity', instrumentType: 'etf', currency: 'CNY' })
  const fixed = makeInstrument({ id: 'i3', name: '固收', assetClass: 'fixed_income', instrumentType: 'bond', currency: 'CNY' })
  const gold = makeInstrument({ id: 'i4', name: '黄金', assetClass: 'gold', instrumentType: 'gold', currency: 'CNY' })

  return makePortfolio({
    accounts: [acct],
    instruments: [cash, equity, fixed, gold],
    holdings: [
      makeHolding({ id: 'h1', accountId: acct.id, instrumentId: cash.id, manualValue: 50000 }),
      makeHolding({ id: 'h2', accountId: acct.id, instrumentId: equity.id, manualValue: 30000 }),
      makeHolding({ id: 'h3', accountId: acct.id, instrumentId: fixed.id, manualValue: 15000 }),
      makeHolding({ id: 'h4', accountId: acct.id, instrumentId: gold.id, manualValue: 5000 }),
    ],
  })
}

