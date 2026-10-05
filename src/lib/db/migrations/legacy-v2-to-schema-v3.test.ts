import { describe, expect, it } from 'vitest'
import { migrateLegacyToCurrentSchema } from './legacy-v2-to-schema-v3'
import { verifyMigration } from './verify'
import { createLegacyFixture, createLegacyWithFunding, createLegacyWithManualClass } from '../__fixtures__/legacyFixture'

/*
 * Migration 测试（Phase 1 重点）
 *
 * 覆盖需求第二十～二十三条与第四十一条「Migration」部分：
 * 金额 / 币种 / 持仓数量 / 成本 / 行情不丢失；
 * 且**不做金融分类猜测**。
 */

describe('迁移：数量守恒', () => {
  const legacy = createLegacyFixture()
  const result = migrateLegacyToCurrentSchema({ portfolio: legacy })

  it('每个旧条目都得到一个持仓', () => {
    const legacyCount = legacy.categories!.reduce(
      (n: number, c) => n + (c.items?.length ?? 0),
      0,
    )
    expect(legacyCount).toBe(15)
    expect(result.portfolio.holdings).toHaveLength(15)
    expect(result.counts.legacyItems).toBe(15)
    expect(result.counts.migratedHoldings).toBe(15)
  })

  it('每个持仓都能找到对应 Instrument 与 Account', () => {
    const instrumentIds = new Set(result.portfolio.instruments.map((i) => i.id))
    const accountIds = new Set(result.portfolio.accounts.map((a) => a.id))
    for (const h of result.portfolio.holdings) {
      expect(instrumentIds.has(h.instrumentId)).toBe(true)
      expect(accountIds.has(h.accountId)).toBe(true)
    }
  })

  it('校验器通过', () => {
    const report = verifyMigration(legacy, result)
    expect(report.blockers).toEqual([])
    expect(report.ok).toBe(true)
  })
})

describe('迁移：金额与币种不丢失', () => {
  const legacy = createLegacyFixture()
  const result = migrateLegacyToCurrentSchema({ portfolio: legacy })
  const findInstrument = (name: string) => result.portfolio.instruments.find((i) => i.name === name)
  const findHolding = (name: string) => {
    const inst = findInstrument(name)
    return result.portfolio.holdings.find((h) => h.instrumentId === inst?.id)
  }

  it('人民币现金金额原样保留，且走 manual 口径', () => {
    const cmb = findHolding('示例银行 A')
    expect(cmb?.valuationMode).toBe('manual')
    expect(cmb?.manualValue).toBe(20000)
    expect(findHolding('示例银行 B')?.manualValue).toBe(400000)
  })

  it('港币现金保留原币种与金额（不折算、不改写）', () => {
    const hk = findHolding('示例银行 C（香港）')
    expect(hk?.manualValue).toBe(30000)
    expect(findInstrument('示例银行 C（香港）')?.currency).toBe('HKD')
    // 不允许在迁移阶段就换成人民币
    expect(findInstrument('示例银行 C（香港）')?.currency).not.toBe('CNY')
  })

  it('房产金额保留', () => {
    expect(findHolding('示例房产')?.manualValue).toBe(2000000)
  })

  it('负债金额保留，且资产类别为 liability', () => {
    const mortgage = findHolding('示例贷款')
    expect(mortgage?.manualValue).toBe(600000)
    expect(findInstrument('示例贷款')?.assetClass).toBe('liability')
    expect(findInstrument('示例贷款')?.classificationStatus).toBe('confirmed')
  })

  it('非法币种会回落但给出告警，不静默改写', () => {
    const odd = migrateLegacyToCurrentSchema({
      portfolio: {
        version: 2,
        categories: [{ id: 'c', name: '现金', items: [{ id: 'x', kind: 'amount', name: '某外币', amount: 100, currency: 'XYZ' }] }],
      },
    })
    expect(odd.warnings.some((w) => w.code === 'unknown_currency')).toBe(true)
    expect(odd.portfolio.instruments[0].currency).toBe('CNY')
  })
})

describe('迁移：持仓数量与成本不丢失', () => {
  const legacy = createLegacyFixture()
  const result = migrateLegacyToCurrentSchema({ portfolio: legacy })
  const hold = (name: string) => {
    const inst = result.portfolio.instruments.find((i) => i.name === name)
    return result.portfolio.holdings.find((h) => h.instrumentId === inst?.id)
  }

  it('美股 ETF：份额与成本单价原样保留', () => {
    const qqqm = hold('QQQM')
    expect(qqqm?.quantity).toBe(10)
    expect(qqqm?.averageCost).toBe(200)
    expect(qqqm?.costBasis).toBe(2000)
    expect(qqqm?.valuationMode).toBe('quantity')
  })

  it('境内基金：份额与成本保留', () => {
    const f = hold('示例定开基金')
    expect(f?.quantity).toBe(10000)
    expect(f?.averageCost).toBe(1)
    expect(f?.costBasis).toBe(10000)
  })

  it('黄金：克数作为数量、单价作为成本', () => {
    const gold = hold('示例黄金账户')
    expect(gold?.quantity).toBe(50)
    expect(gold?.averageCost).toBe(600)
    expect(gold?.costBasis).toBe(30000)
  })

  it('BRK.B 这类带点的代码保留', () => {
    expect(result.portfolio.instruments.find((i) => i.name === 'BRK.B')?.symbol).toBe('BRK.B')
  })
})

describe('迁移：行情搬运与状态标注', () => {
  const legacy = createLegacyFixture()
  const result = migrateLegacyToCurrentSchema({ portfolio: legacy })

  it('旧行情生成了对应 Quote', () => {
    // fixture 中 11 条带行情（除负债外），其中部分时间过旧
    expect(result.portfolio.quotes.length).toBeGreaterThan(0)
    for (const q of result.portfolio.quotes) {
      expect(result.portfolio.instruments.some((i) => i.id === q.instrumentId)).toBe(true)
    }
  })

  it('时间过旧的行情被标为 STALE，绝不冒充实时', () => {
    const stale = result.portfolio.quotes.find((q) => q.instrumentId === result.portfolio.instruments.find((i) => i.name === '示例理财基金')?.id)
    expect(stale).toBeDefined()
    expect(stale!.status).toBe('STALE')
  })

  it('估算净值与正式净值分开存放，不混为一谈', () => {
    const spy = result.portfolio.instruments.find((i) => i.name === 'SPYM')!
    const q = result.portfolio.quotes.find((x) => x.instrumentId === spy.id)!
    // 美股走 marketPrice + estimated_nav 口径
    expect(['market_price', 'estimated_nav']).toContain(q.priceKind)
    // nav 与 estimatedNav 不会同时有值
    expect(q.nav === undefined || q.estimatedNav === undefined).toBe(true)
  })

  it('手动净值优先于接口行情', () => {
    const manual = migrateLegacyToCurrentSchema({
      portfolio: {
        version: 2,
        categories: [{
          id: 'c', name: '基金',
          items: [{
            id: 'x', kind: 'fund', name: '手填基金', code: '161725', market: 'cn',
            shares: 100, costNav: 1, manualNav: 2.5,
            quote: { estimatedNav: 9.9, fetchedAt: Date.now(), source: 'fundmobapi' },
          }],
        }],
      },
    })
    const q = manual.portfolio.quotes[0]
    expect(q.priceKind).toBe('manual')
    expect(q.status).toBe('MANUAL')
    expect(q.estimatedNav).toBeUndefined()
  })
})

describe('迁移：分类不得靠名称关键词猜测（需求第十九/二十三条）', () => {
  const legacy = createLegacyFixture()
  const result = migrateLegacyToCurrentSchema({ portfolio: legacy })
  const inst = (name: string) => result.portfolio.instruments.find((i) => i.name === name)!

  it('「数字货币」不得因为含「货币」被归为现金', () => {
    const btc = inst('示例数字资产')
    expect(btc.assetClass).not.toBe('cash')
    expect(btc.classificationStatus).toBe('unconfirmed')
    expect(btc.classificationSource).toBe('unknown')
  })

  it('房产不得被归为现金', () => {
    const house = inst('示例房产')
    expect(house.assetClass).not.toBe('cash')
    expect(house.classificationStatus).toBe('unconfirmed')
  })

  it('旧 kind=amount 的资产一律未确认（现金/房产/数字货币结构上无法区分）', () => {
    for (const name of ['示例银行 A', '示例银行 B', '示例银行 C（香港）', '示例房产', '示例数字资产']) {
      const x = inst(name)
      expect(x.classificationStatus).toBe('unconfirmed')
      // 也不得凭分类名硬给地域
      expect(x.region).toBeUndefined()
    }
  })

  it('现金也不会被自动认定（避免误判，交用户确认）', () => {
    expect(inst('示例银行 A').assetClass).not.toBe('cash')
  })

  it('境内基金的资产类别必须未确认，不能按名字猜（示例定开基金 / 示例理财基金）', () => {
    for (const name of ['示例定开基金', '示例理财基金']) {
      const f = inst(name)
      expect(f.classificationStatus).toBe('unconfirmed')
      expect(f.classificationSource).toBe('unknown')
      // 名字里有「月月宝」，旧逻辑会命中「活期宝/货币」关键词 → 这里必须没有
      expect(f.strategy).toBeUndefined()
    }
  })

  it('未确认分类有可读告警，便于界面提示用户确认', () => {
    const codes = result.warnings.map((w) => w.code)
    expect(codes).toContain('unconfirmed_classification')
    const msg = result.warnings.find((w) => w.message.includes('示例理财基金'))
    expect(msg?.ref?.itemId).toBe('i_yyb')
  })

  it('未确认数量与实际上报一致', () => {
    const actual = result.portfolio.instruments.filter((i) => i.classificationStatus === 'unconfirmed').length
    expect(result.counts.unconfirmed).toBe(actual)
  })

  it('美股/港股 ETF 的 region 与 instrumentType 正确，但类别仍需确认', () => {
    const qqqm = inst('QQQM')
    expect(qqqm.instrumentType).toBe('etf')
    expect(qqqm.region).toBe('US')
    expect(qqqm.currency).toBe('USD')
    // 策略标签旧数据没有 → 不得编造（需求第二十二条）
    expect(qqqm.strategy).toBeUndefined()
    // ETF 可能是股票/债券/黄金，必须用户确认
    expect(qqqm.classificationStatus).toBe('unconfirmed')
  })

  it('黄金是结构性事实，可直接确认（需求第二十四条）', () => {
    const gold = inst('示例黄金账户')
    expect(gold.assetClass).toBe('gold')
    expect(gold.classificationStatus).toBe('confirmed')
    expect(gold.classificationSource).toBe('structural')
  })

  it('境内 6 位数字基金识别为 fund 类型', () => {
    expect(inst('示例定开基金').instrumentType).toBe('fund')
  })

  it('旧 amount 类条目的 instrumentType 为 other（不冒充 cash）', () => {
    expect(inst('示例银行 A').instrumentType).toBe('other')
    expect(inst('示例数字资产').instrumentType).toBe('other')
  })
})

describe('迁移：沿用用户此前的标记，但不猜混合型', () => {
  const result = migrateLegacyToCurrentSchema({ portfolio: createLegacyWithManualClass() })
  const inst = (name: string) => result.portfolio.instruments.find((i) => i.name === name)!

  it('用户标记过的 bond → fixed_income，并标为沿用', () => {
    const f = inst('示例债券基金')
    expect(f.assetClass).toBe('fixed_income')
    expect(f.classificationStatus).toBe('confirmed')
    expect(f.classificationSource).toBe('legacy_user_set')
  })

  it('混合型无法归入单一类别 → 必须未确认', () => {
    const f = inst('示例混合基金')
    expect(f.classificationStatus).toBe('unconfirmed')
  })
})

describe('迁移：资金划拨 → transfer 交易', () => {
  const result = migrateLegacyToCurrentSchema({ portfolio: createLegacyWithFunding() })

  it('生成了 transfer 交易，金额与来源可追溯', () => {
    const transfers = result.portfolio.transactions.filter((t) => t.type === 'transfer')
    expect(transfers).toHaveLength(1)
    expect(transfers[0].amount).toBe(500)
    expect(transfers[0].note).toContain('示例活期')
  })

  it('同时为数量口径持仓生成期初 adjustment（不臆造历史买入）', () => {
    const adjs = result.portfolio.transactions.filter((t) => t.type === 'adjustment')
    expect(adjs).toHaveLength(1)
    expect(adjs[0].quantity).toBe(1000)
    expect(adjs[0].amount).toBe(500) // 1000 份 × 成本 0.5
    expect(adjs[0].note).toContain('非历史买入记录')
    // 语义必须明确：adjustment 承接余额，而不是伪造一笔 buy
    expect(result.portfolio.transactions.some((t) => t.type === 'buy')).toBe(false)
    expect(result.portfolio.transactions.some((t) => t.type === 'sell')).toBe(false)
  })

  it('来源持仓找不到时给出告警而不是丢数据', () => {
    const orphan = migrateLegacyToCurrentSchema({
      portfolio: {
        version: 2,
        categories: [{
          id: 'c', name: '基金',
          items: [{
            id: 'f', kind: 'fund', name: '某基金', code: '161725', shares: 1, costNav: 1,
            fundedFrom: { categoryId: 'gone', itemId: 'gone', itemName: '缺失项目', amount: 100 },
          }],
        }],
      },
    })
    expect(orphan.warnings.some((w) => w.code === 'orphan_funding_source')).toBe(true)
    expect(orphan.portfolio.transactions.filter((t) => t.type === 'transfer')).toHaveLength(1)
  })
})

describe('迁移：确定性（重复执行结果一致）', () => {
  const legacy = createLegacyFixture()
  /** 固定时钟：否则两次迁移跨越毫秒边界会导致断言偶发失败 */
  const fixedClock = () => '2026-10-03T10:00:00.000Z'

  it('注入同一时钟时两次迁移结果逐字节相同', () => {
    const a = migrateLegacyToCurrentSchema({ portfolio: legacy, now: fixedClock })
    const b = migrateLegacyToCurrentSchema({ portfolio: legacy, now: fixedClock })
    expect(a.portfolio.instruments.map((i) => i.id)).toEqual(b.portfolio.instruments.map((i) => i.id))
    expect(a.portfolio.holdings.map((h) => h.id)).toEqual(b.portfolio.holdings.map((h) => h.id))
    expect(a.portfolio.accounts.map((x) => x.id)).toEqual(b.portfolio.accounts.map((x) => x.id))
    expect(JSON.stringify(a.portfolio)).toBe(JSON.stringify(b.portfolio))
  })

  it('迁移是纯函数，不修改输入', () => {
    const snapshot = JSON.stringify(legacy)
    migrateLegacyToCurrentSchema({ portfolio: legacy, now: fixedClock })
    expect(JSON.stringify(legacy)).toBe(snapshot)
  })

  it('不注入时钟也能跑（默认取系统时间）', () => {
    expect(() => migrateLegacyToCurrentSchema({ portfolio: legacy })).not.toThrow()
  })
})

describe('迁移：账户容器生成规则', () => {
  const result = migrateLegacyToCurrentSchema({ portfolio: createLegacyFixture() })

  it('按旧分类生成账户，负债分类对应负债账户', () => {
    const debt = result.portfolio.accounts.find((a) => a.name === '负债')
    expect(debt?.isLiability).toBe(true)
    const house = result.portfolio.accounts.find((a) => a.name === '房产')
    expect(house?.isLiability).toBe(false)
  })

  it('账户类型按分类语义给出合理默认', () => {
    expect(result.portfolio.accounts.find((a) => a.name === '基金')?.type).toBe('fund_platform')
    expect(result.portfolio.accounts.find((a) => a.name === '黄金')?.type).toBe('gold_platform')
    expect(result.portfolio.accounts.find((a) => a.name === '股票')?.type).toBe('broker')
  })

  it('账户数量等于含条目的旧分类数量', () => {
    expect(result.portfolio.accounts).toHaveLength(7)
  })

  it('账户 region 由账户内明确的市场信息推导，推不出则留空', () => {
    // 股票账户内是美股 → US
    expect(result.portfolio.accounts.find((a) => a.name === '股票')?.region).toBe('US')
    // 现金/房产/数字货币账户没有市场信息 → 不猜
    expect(result.portfolio.accounts.find((a) => a.name === '现金与固定资产')?.region).toBeUndefined()
    expect(result.portfolio.accounts.find((a) => a.name === '房产')?.region).toBeUndefined()
  })

  it('账户主要币种取账户内的外币（美股账户为 USD），但仍只是默认值', () => {
    expect(result.portfolio.accounts.find((a) => a.name === '股票')?.currency).toBe('USD')
  })

  it('账户名沿用旧分类名，不臆造机构名', () => {
    expect(result.portfolio.accounts.map((a) => a.name).sort()).toEqual(
      ['数字货币', '房产', '现金与固定资产', '股票', '基金', '负债', '黄金'].sort(),
    )
  })

  it('空分类不生成账户，但会给出提示', () => {
    const empty = migrateLegacyToCurrentSchema({
      portfolio: { version: 2, categories: [{ id: 'e', name: '空分类', items: [] }] },
    })
    expect(empty.portfolio.accounts).toHaveLength(0)
    expect(empty.warnings.some((w) => w.code === 'empty_category')).toBe(true)
  })
})

describe('迁移：旧月度走势并入 Snapshot', () => {
  const result = migrateLegacyToCurrentSchema({
    portfolio: createLegacyFixture(),
    netWorthPoints: [
      { month: '2026-08', assets: 400000, liabilities: 600000, netWorth: -200000 },
      { month: '2026-09', assets: 420000, liabilities: 600000, netWorth: -180000 },
      { month: 'bad', assets: 1, liabilities: 1, netWorth: 0 },
    ],
  })

  it('合法月份被迁移为 Snapshot，非法月份被忽略', () => {
    expect(result.portfolio.snapshots).toHaveLength(2)
    expect(result.portfolio.snapshots.map((s) => s.date)).toEqual(['2026-08-01', '2026-09-01'])
  })

  it('三个金额字段都保留', () => {
    const s = result.portfolio.snapshots[0]
    expect(s.totalAssets).toBe(400000)
    expect(s.totalLiabilities).toBe(600000)
    expect(s.netWorth).toBe(-200000)
    expect(s.currency).toBe('CNY')
  })
})

/* ------------------------------------------------------------------ *
 * 真实数据回归（不包含任何真实资产数据）
 *
 * 下面的用例复刻了真实导出数据暴露出的两个问题：
 * 1. 美股条目的 `currency` 为空，币种只存在于 `quote.currency`；
 * 2. 账户的 region / 主要币种只能从账户内条目的市场信息推导。
 * 若这两点被改坏，真实迁移会把美股当成人民币。
 * ------------------------------------------------------------------ */

describe('真实数据结构回归', () => {
  /** 复刻真实导出：条目字段与真实一致（amount 无 quote，fund 有 quote.currency） */
  const realistic = {
    version: 2,
    categories: [
      {
        id: 'cat_cash',
        name: '现金与固定资产',
        items: [
          { id: 'c1', kind: 'amount', name: '银行A', amount: 11111 },
          { id: 'c2', kind: 'amount', name: '银行B', amount: 22222 },
          { id: 'c3', kind: 'amount', name: '银行C', amount: 33333, currency: 'HKD' },
        ],
      },
      {
        id: 'cat_stock',
        name: '股票',
        items: [
          {
            id: 's1', kind: 'fund', name: '美股ETF', code: 'SPYM', market: 'us',
            shares: 0.5, costNav: 60, manualName: false,
            // 注意：条目本身没有 currency
            quote: { code: 'SPYM', name: 'SPYM', currency: 'USD', market: 'us', estimatedNav: 70, fetchedAt: Date.now(), source: 'tencent-us' },
          },
        ],
      },
      { id: 'cat_fund', name: '基金', items: [{ id: 'f1', kind: 'amount', name: '某理财', amount: 444.4 }] },
    ],
  }

  const result = migrateLegacyToCurrentSchema({ portfolio: realistic })
  const inst = (name: string) => result.portfolio.instruments.find((i) => i.name === name)!
  const acct = (name: string) => result.portfolio.accounts.find((a) => a.name === name)!

  it('条目自身没有币种时，从 quote.currency 继承（美股不得变成人民币）', () => {
    expect(inst('美股ETF').currency).toBe('USD')
  })

  it('HKD 现金保留港币', () => {
    expect(inst('银行C').currency).toBe('HKD')
  })

  it('账户 region 由账户内明确的市场信息推导', () => {
    expect(acct('股票').region).toBe('US')
    // 现金账户没有市场信息 → 不猜
    expect(acct('现金与固定资产').region).toBeUndefined()
  })

  it('账户主要币种取账户内的外币', () => {
    expect(acct('股票').currency).toBe('USD')
    expect(acct('现金与固定资产').currency).toBe('CNY')
  })

  it('Account.type 使用 fund_platform / gold_platform 命名', () => {
    const withNames = migrateLegacyToCurrentSchema({
      portfolio: {
        version: 2,
        categories: [
          { id: 'a', name: '基金', items: [{ id: 'x', kind: 'amount', name: 'x', amount: 1 }] },
          { id: 'b', name: '黄金', items: [{ id: 'y', kind: 'gold', name: 'y', grams: 1, pricePerGram: 1 }] },
        ],
      },
    })
    expect(withNames.portfolio.accounts.find((a) => a.name === '基金')?.type).toBe('fund_platform')
    expect(withNames.portfolio.accounts.find((a) => a.name === '黄金')?.type).toBe('gold_platform')
  })

  it('一个账户可以同时容纳多种资产类别与币种（结构上不设限）', () => {
    // 真实场景：美国券商账户里既有 USD 现金，也有美股 ETF
    const mixed = migrateLegacyToCurrentSchema({
      portfolio: {
        version: 2,
        categories: [
          {
            id: 'cat_broker',
            name: '券商',
            items: [
              { id: 'm1', kind: 'amount', name: 'USD现金', amount: 1000, currency: 'USD' },
              {
                id: 'm2', kind: 'fund', name: 'QQQM', code: 'QQQM', market: 'us',
                shares: 1, costNav: 100, quote: { currency: 'USD', estimatedNav: 110, fetchedAt: Date.now(), source: 'tencent-us' },
              },
            ],
          },
        ],
      },
    })
    const accountId = mixed.portfolio.accounts[0].id
    const holdings = mixed.portfolio.holdings.filter((h) => h.accountId === accountId)
    expect(holdings).toHaveLength(2)

    const instruments = holdings.map((h) => mixed.portfolio.instruments.find((i) => i.id === h.instrumentId)!)
    // 同一账户内：manual（现金）与 quantity（持仓）两种口径并存
    expect(new Set(holdings.map((h) => h.valuationMode))).toEqual(new Set(['manual', 'quantity']))
    // 币种相同但口径不同，且账户不因 currency 而限制持仓
    expect(instruments.every((i) => i.currency === 'USD')).toBe(true)
  })
})
