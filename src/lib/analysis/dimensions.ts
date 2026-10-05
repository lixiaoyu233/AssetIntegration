/**
 * 六个分析维度
 *
 * | 维度 | 依据 | 说明 |
 * | --- | --- | --- |
 * | `byAssetClass` | `Instrument.assetClass` | 未确认 → 「待确认分类」桶 |
 * | `byAccount` | `Holding.accountId` | 资产分布在哪里 |
 * | `byAccountType` | `Account.type` | 银行 / 券商 / 平台… |
 * | `byCurrency` | **标的币种** | 原币合计 + 人民币折算，**不同币种绝不直接相加** |
 * | `byRegion` | `Account.region` | 账户属地（存放地） |
 * | `byInstrumentType` | `Instrument.instrumentType` | 工具暴露 |
 */

import type { AccountRegion, AccountType, AssetClass, InstrumentType } from '../../types/portfolio2'
import {
  ACCOUNT_TYPE_LABEL as OFFICIAL_ACCOUNT_TYPE_LABEL,
  ASSET_CLASS_LABEL as OFFICIAL_ASSET_CLASS_LABEL,
  INSTRUMENT_TYPE_LABEL as OFFICIAL_INSTRUMENT_TYPE_LABEL,
} from '../../types/portfolio2'
import type { AnalysisRow, GroupBucket } from './types'
import { bucketBy } from './buckets'

/* ------------------------------------------------------------------ *
 * 标签
 * ------------------------------------------------------------------ */

/**
 * 资产类别标签。
 *
 * **复用 `types/portfolio2.ts` 的官方标签**，只补一个分析层专有的
 * `'unconfirmed'`（待确认分类）。避免两处维护同一套文案而漂移。
 */
export const ASSET_CLASS_LABEL: Record<AssetClass | 'unconfirmed', string> = {
  ...OFFICIAL_ASSET_CLASS_LABEL,
  unconfirmed: '待确认分类',
}

/** 复用官方标签，避免重复维护 */
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = OFFICIAL_ACCOUNT_TYPE_LABEL

export const REGION_LABEL: Record<AccountRegion | 'unknown', string> = {
  CN: '中国大陆',
  HK: '中国香港',
  SG: '新加坡',
  US: '美国',
  OTHER: '其他地区',
  unknown: '未标注地区',
}

/** 复用官方标签 */
export const INSTRUMENT_TYPE_LABEL: Record<InstrumentType, string> = OFFICIAL_INSTRUMENT_TYPE_LABEL

const CURRENCY_LABEL: Record<string, string> = {
  CNY: '人民币 CNY',
  USD: '美元 USD',
  HKD: '港币 HKD',
  SGD: '新加坡元 SGD',
  EUR: '欧元 EUR',
  JPY: '日元 JPY',
}

/* ------------------------------------------------------------------ *
 * 各维度
 * ------------------------------------------------------------------ */

export function byAssetClass(rows: AnalysisRow[]): GroupBucket[] {
  return bucketBy(
    rows,
    (r) => r.assetClass,
    (k) => ASSET_CLASS_LABEL[k as AssetClass | 'unconfirmed'] ?? k,
  )
}

export function byAccount(rows: AnalysisRow[]): GroupBucket[] {
  return bucketBy(
    rows,
    (r) => r.accountId,
    (k) => rows.find((r) => r.accountId === k)?.accountName ?? k,
  )
}

export function byAccountType(rows: AnalysisRow[]): GroupBucket[] {
  return bucketBy(
    rows,
    (r) => r.accountType,
    (k) => ACCOUNT_TYPE_LABEL[k as AccountType] ?? k,
  )
}

/**
 * 按币种分组。
 *
 * **不同币种绝不直接相加**：每个桶给出
 * - `nativeTotal` + `nativeCurrency`：原币金额（FX 缺失时仍然保留）
 * - `valueCny`：折算后的人民币金额（**仅可靠估值**）
 *
 * FX 不可用时 `fxMissing = true`，`nativeTotal` 有值而 `valueCny` 不计入。
 */
export function byCurrency(rows: AnalysisRow[]): GroupBucket[] {
  return bucketBy(
    rows,
    (r) => r.currency,
    (k) => CURRENCY_LABEL[k] ?? k,
    {
      /*
       * 折算缺口**只在该项因缺汇率而无法折算时**成立。
       *
       * 不能简单用「原币有值 + 人民币无值」，因为还有另一种情况：
       * 数量口径的持仓**没有行情**（missing_quote），它同样算不出金额，
       * 但那不是汇率问题。若混为一谈，用户会看到「缺汇率」的错误提示。
       */
      fxMissing: (row) =>
        row.valueCny === undefined &&
        (row.reasons.includes('missing_fx') || row.reasons.includes('stale_fx')),
    },
  )
}

/**
 * 按账户属地分组。
 *
 * 严格使用 `Account.region`，**绝不从证券名称/代码推断市场**。
 * 香港账户持美股 ETF → 归 HK。
 */
export function byRegion(rows: AnalysisRow[]): GroupBucket[] {
  return bucketBy(
    rows,
    (r) => r.region,
    (k) => REGION_LABEL[k as AccountRegion | 'unknown'] ?? k,
  )
}

export function byInstrumentType(rows: AnalysisRow[]): GroupBucket[] {
  return bucketBy(
    rows,
    (r) => r.instrumentType,
    (k) => INSTRUMENT_TYPE_LABEL[k as InstrumentType] ?? k,
  )
}
