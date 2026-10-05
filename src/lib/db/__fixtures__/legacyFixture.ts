/**
 * 迁移测试数据（fixture）
 *
 * ⚠️⚠️ **本文件必须只含虚构数据** ⚠️⚠️
 *
 * 测试价值在于**结构**（categories → items，kind ∈ amount | fund | gold、
 * 各字段名称与嵌套层级、币种放置位置），而不在于具体金额。
 * 因此这里统一使用明显虚构的账户名（示例银行 / 示例平台）与整数金额，
 * **禁止**写入任何真实用户的机构名或金额。
 *
 * 真实数据的验证走本地临时脚本（不落仓库），见 Phase 1 / Phase 2 的迁移验证报告。
 */

import type { LegacyPortfolioLike } from '../migrations/legacy-v2-to-schema-v3'

/** 一个交易日内的行情时间，用于验证「新鲜行情」判定 */
export const FRESH_TS = 1700000000000
/** 很久以前的时间，用于验证「过期行情不得标为 LIVE」 */
export const STALE_TS = 1600000000000

/**
 * 代表性旧数据（全部虚构）：
 * - 现金：三种币种各一条，验证原币保留
 * - 美股 ETF 若干（字母代码 + market=us，币种只在 quote 里）
 * - 境内基金：名称含「月月宝」类字样，但**不得**据此判为现金
 * - 黄金：按克数
 * - 负债账户
 * - 数字货币：验证不会因为名字里有「货币」被归为现金
 * - 房产：验证不会被归为现金
 */
export function createLegacyFixture(): LegacyPortfolioLike {
  return {
    version: 2,
    lastSyncedAt: FRESH_TS,
    history: [],
    categories: [
      {
        id: 'cat_cash',
        name: '现金与固定资产',
        isLiability: false,
        items: [
          { id: 'i_cmb', kind: 'amount', name: '示例银行 A', amount: 20000, currency: 'CNY' },
          { id: 'i_scb', kind: 'amount', name: '示例银行 B', amount: 400000, currency: 'CNY' },
          { id: 'i_scb_hk', kind: 'amount', name: '示例银行 C（香港）', amount: 30000, currency: 'HKD' },
        ],
      },
      {
        id: 'cat_house',
        name: '房产',
        isLiability: false,
        items: [{ id: 'i_house', kind: 'amount', name: '示例房产', amount: 2000000, currency: 'CNY' }],
      },
      {
        id: 'cat_crypto',
        name: '数字货币',
        isLiability: false,
        items: [{ id: 'i_btc', kind: 'amount', name: '示例数字资产', amount: 10000, currency: 'CNY' }],
      },
      {
        id: 'cat_stock',
        name: '股票',
        isLiability: false,
        items: [
          {
            id: 'i_spym', kind: 'fund', name: 'SPYM', code: 'SPYM', market: 'us', currency: 'USD',
            shares: 100, costNav: 60, quote: { estimatedNav: 70, fetchedAt: FRESH_TS, source: 'tencent-us' },
          },
          {
            id: 'i_qqqm', kind: 'fund', name: 'QQQM', code: 'QQQM', market: 'us', currency: 'USD',
            shares: 10, costNav: 200, quote: { estimatedNav: 220, fetchedAt: FRESH_TS, source: 'tencent-us' },
          },
          {
            id: 'i_jepi', kind: 'fund', name: 'JEPI', code: 'JEPI', market: 'us', currency: 'USD',
            shares: 20, costNav: 55, quote: { estimatedNav: 58, fetchedAt: FRESH_TS, source: 'tencent-us' },
          },
          {
            id: 'i_qqqi', kind: 'fund', name: 'QQQI', code: 'QQQI', market: 'us', currency: 'USD',
            shares: 30, costNav: 50, quote: { estimatedNav: 51, fetchedAt: FRESH_TS, source: 'tencent-us' },
          },
          {
            id: 'i_schd', kind: 'fund', name: 'SCHD', code: 'SCHD', market: 'us', currency: 'USD',
            shares: 40, costNav: 25, quote: { estimatedNav: 28, fetchedAt: FRESH_TS, source: 'tencent-us' },
          },
          {
            id: 'i_brkb', kind: 'fund', name: 'BRK.B', code: 'BRK.B', market: 'us', currency: 'USD',
            shares: 5, costNav: 400, quote: { estimatedNav: 450, fetchedAt: FRESH_TS, source: 'tencent-us' },
          },
        ],
      },
      {
        id: 'cat_fund',
        name: '基金',
        isLiability: false,
        items: [
          {
            id: 'i_zsy12', kind: 'fund', name: '示例定开基金', code: '003003', market: 'cn',
            shares: 10000, costNav: 1.0, quote: { publishedNav: 1.05, fetchedAt: FRESH_TS, source: 'fundmobapi' },
          },
          {
            id: 'i_yyb', kind: 'fund', name: '示例理财基金', code: '000009', market: 'cn',
            shares: 20000, costNav: 1.0, quote: { publishedNav: 1.02, fetchedAt: STALE_TS, source: 'fundmobapi' },
          },
        ],
      },
      {
        id: 'cat_gold',
        name: '黄金',
        isLiability: false,
        items: [{ id: 'i_gold', kind: 'gold', name: '示例黄金账户', grams: 50, pricePerGram: 600, currency: 'CNY' }],
      },
      {
        id: 'cat_debt',
        name: '负债',
        isLiability: true,
        items: [{ id: 'i_mortgage', kind: 'amount', name: '示例贷款', amount: 600000, currency: 'CNY' }],
      },
    ],
  }
}

/** 带资金划拨记录的旧数据（验证 fundedFrom → transfer 交易） */
export function createLegacyWithFunding(): LegacyPortfolioLike {
  return {
    version: 2,
    categories: [
      {
        id: 'cat_cash',
        name: '现金与固定资产',
        items: [{ id: 'cash1', kind: 'amount', name: '示例活期', amount: 100000, currency: 'CNY' }],
      },
      {
        id: 'cat_fund',
        name: '基金',
        items: [
          {
            id: 'fund1', kind: 'fund', name: '示例基金', code: '161725', market: 'cn',
            shares: 1000, costNav: 0.5,
            fundedFrom: { categoryId: 'cat_cash', itemId: 'cash1', itemName: '示例活期', amount: 500 },
          },
        ],
      },
    ],
  }
}

/** 用户此前手动标记过资产类型的旧数据 */
export function createLegacyWithManualClass(): LegacyPortfolioLike {
  return {
    version: 2,
    categories: [
      {
        id: 'cat_fund',
        name: '基金',
        items: [
          { id: 'f1', kind: 'fund', name: '示例债券基金', code: '000001', market: 'cn', shares: 100, costNav: 1, assetClass: 'bond' },
          { id: 'f2', kind: 'fund', name: '示例混合基金', code: '000002', market: 'cn', shares: 100, costNav: 1, assetClass: 'mixed' },
        ],
      },
    ],
  }
}
