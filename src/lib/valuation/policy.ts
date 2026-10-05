/**
 * 估值与行情策略（可配置）
 *
 * 为什么单独抽出来：时效阈值原先散落在估值模块内部，
 * 调整口径就得改估值核心逻辑。集中到这里后：
 *
 * - 阈值只在本文件定义，估值引擎只**读取**策略；
 * - 未来要统一调整（或按行情源区分）只需改这里或传入自定义策略；
 * - 测试可以注入短阈值，不必等待真实时间流逝。
 *
 * 原则（已确认）：**宁可标记 STALE，也不把过期行情冒充实时**。
 */

import type { QuoteStatus } from '../../types/portfolio2'

/** 行情时效策略：每种状态在多长时间内仍视为可用 */
export interface QuotePolicy {
  /** 各状态的新鲜度上限（毫秒）；Infinity 表示不因时间失效 */
  freshnessMs: Record<QuoteStatus, number>
  /** 汇率过期阈值（毫秒） */
  fxStaleMs: number
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * 默认策略。
 *
 * | 状态 | 有效期 | 理由 |
 * | --- | --- | --- |
 * | LIVE | 1 小时 | 盘中价格，超过一小时不再算实时 |
 * | DELAYED | 1 天 | 延迟行情，一天内仍可参考 |
 * | CLOSED | 无限期 | 收盘价在下一个交易时段前都是有效价 |
 * | MANUAL | 无限期 | 用户手填，不因时间失效 |
 * | STALE | 0 | 本身就是过期态 |
 * | ERROR | 0 | 永远不可用 |
 */
export const DEFAULT_QUOTE_POLICY: QuotePolicy = {
  freshnessMs: {
    LIVE: HOUR,
    DELAYED: DAY,
    CLOSED: Number.POSITIVE_INFINITY,
    MANUAL: Number.POSITIVE_INFINITY,
    STALE: 0,
    ERROR: 0,
  },
  fxStaleMs: DAY,
}

/** 便于测试的短阈值策略 */
export function createQuotePolicy(patch: {
  freshnessMs?: Partial<Record<QuoteStatus, number>>
  fxStaleMs?: number
} = {}): QuotePolicy {
  return {
    freshnessMs: { ...DEFAULT_QUOTE_POLICY.freshnessMs, ...patch.freshnessMs },
    fxStaleMs: patch.fxStaleMs ?? DEFAULT_QUOTE_POLICY.fxStaleMs,
  }
}

/** 该状态是否「不因时间失效」 */
export function isTimelessStatus(status: QuoteStatus): boolean {
  return DEFAULT_QUOTE_POLICY.freshnessMs[status] === Number.POSITIVE_INFINITY
}
