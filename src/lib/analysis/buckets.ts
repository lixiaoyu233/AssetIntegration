/**
 * 分组与聚合
 *
 * ## 不重复统计的结构性保证
 *
 * 所有维度都是对**同一批 `AnalysisRow`**（行数 = 持仓数）做切分：
 *
 * - 每个 Holding 在**任一单独维度**中**恰好出现一次**
 * - 因此任一维度的 `valueCny` 合计**恒等于** `reliableValueCny`
 * - 不同维度之间**允许重复出现**（那是多维切片，不是重复资产）
 *
 * 例：一笔美股 ETF
 * ```
 * byAccount        → 示例香港券商账户
 * byRegion         → HK
 * byCurrency       → USD
 * byInstrumentType → ETF
 * byAssetClass     → Equity
 * ```
 * 这是正常的五维切片，资产并未被算五次。
 */

import type { AnalysisRow, GroupBucket } from './types'

const round2 = (n: number) => Math.round(n * 100) / 100

/** 外币折算缺口标记（币种维度专用） */
export interface BucketOptions {
  /**
   * 判断某行是否存在「原币有值但无法折算人民币」的缺口。
   * 币种维度用它标记 `fxMissing`。
   */
  fxMissing?: (row: AnalysisRow) => boolean
}

/** 空桶 */
function emptyBucket(key: string, label: string): GroupBucket {
  return {
    key,
    label,
    valueCny: 0,
    reliableCount: 0,
    unavailableCount: 0,
    staleCount: 0,
    unconfirmedCount: 0,
    isComplete: true,
  }
}

/**
 * 按某个取值函数分组。
 *
 * 关键实现细节：
 * - 只把 `status === 'ok' && valueCny !== undefined` 的项计入 `valueCny`；
 * - `stale` / `unavailable` **只增加计数**，绝不产生金额；
 * - `unconfirmed` 独立计数，且**与估值状态互不影响**（可同时存在）。
 */
export function bucketBy(
  rows: AnalysisRow[],
  keyOf: (row: AnalysisRow) => string,
  labelOf: (key: string) => string,
  options: BucketOptions = {},
): GroupBucket[] {
  const map = new Map<string, GroupBucket>()

  for (const row of rows) {
    const key = keyOf(row)
    let bucket = map.get(key)
    if (!bucket) {
      bucket = emptyBucket(key, labelOf(key))
      map.set(key, bucket)
    }

    /* ---- 分类未确认：独立计数，不影响金额 ---- */
    if (!row.classConfirmed) bucket.unconfirmedCount += 1

    /* ---- 金额：只有可靠估值才计入 ---- */
    const reliable = row.status === 'ok' && row.valueCny !== undefined
    if (reliable) {
      // 负债行不会进入维度分组（调用方已分离），这里只累加资产
      bucket.valueCny = round2(bucket.valueCny + (row.valueCny ?? 0))
      bucket.reliableCount += 1
    } else if (row.status === 'stale') {
      bucket.staleCount += 1
      bucket.isComplete = false
    } else {
      bucket.unavailableCount += 1
      bucket.isComplete = false
    }

    /* ---- 币种维度：原币合计（与可靠性无关） ---- */
    if (bucket.nativeTotal === undefined && row.nativeValue !== undefined) {
      bucket.nativeTotal = 0
      bucket.nativeCurrency = row.currency
    }
    if (bucket.nativeTotal !== undefined && row.nativeValue !== undefined) {
      bucket.nativeTotal = round2(bucket.nativeTotal + row.nativeValue)
    }

    /* ---- 折算缺口 ---- */
    if (options.fxMissing?.(row)) bucket.fxMissing = true
  }

  return [...map.values()].sort((a, b) => b.valueCny - a.valueCny)
}

/**
 * 计算占比。
 *
 * 分母是 `reliableValueCny`（可靠总额）—— 不是「理论总额」。
 * 因为不可估值资产**不产生金额**，若把它们算进分母，
 * 会让可靠资产的比例被无故摊薄，而用户无从察觉缺口。
 *
 * 分母为 0 时返回 `undefined`（**不填 0**）。
 */
export function withShare(buckets: GroupBucket[], reliableTotal: number): GroupBucket[] {
  return buckets.map((b) => ({
    ...b,
    share: reliableTotal > 0 ? b.valueCny / reliableTotal : undefined,
  }))
}

/** 各维度合计（应当恒等于 reliableValueCny，供自检与测试） */
export function sumDimension(buckets: GroupBucket[]): number {
  return round2(buckets.reduce((s, b) => s + b.valueCny, 0))
}
