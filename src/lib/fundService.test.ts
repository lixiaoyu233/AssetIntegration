/**
 * 联网集成测试：直接打真实接口，验证「基金实时估值同步」的解析链路。
 *
 * 运行：npm run test:api
 * 说明：需要网络；在 CI 或离线环境会整组跳过，避免拖动整体测试失败。
 * 这里刻意使用 fetch 通道来校验数据格式，与浏览器里的行为一致
 * （浏览器端优先走 fetch + CORS，失败后自动降级到 JSONP）。
 */
import { describe, expect, it } from 'vitest'
import { buildFundMobUrl, buildPush2Url, fetchFundQuotes, parsePush2Batch } from './fundService'
import { collectFundCodes, summarize } from './calc'
import { normalizePortfolio } from './storage'

const OFFLINE = process.env.ACW_SKIP_API === '1'

async function networkOk(): Promise<boolean> {
  try {
    const res = await fetch(buildFundMobUrl(['161725']), { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

const online = OFFLINE ? false : await networkOk()

/** 网络抖动（IPv6 socket 被重置等）时重试几次，避免集成测试误报 */
async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url)
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

/**
 * 部分网络环境下 push2 的 IPv6 通道不可用（curl 正常、node fetch 报 socket closed），
 * 因此这里单独做一次探测，不可用就跳过该用例而不是让整组测试失败。
 */
async function push2Reachable(): Promise<boolean> {
  if (!online) return false
  try {
    const res = await fetchWithRetry(buildPush2Url(['510300']), 2)
    return res.ok
  } catch {
    return false
  }
}

const push2Online = await push2Reachable()

describe.skipIf(!online)('真实接口：天天基金估值同步', () => {
  it('批量拉取两只基金，返回净值与名称', async () => {
    const map = await fetchFundQuotes(['161725', '000001'])
    expect(map.size).toBeGreaterThan(0)

    const hit = map.get('161725')
    expect(hit).toBeDefined()
    const q = hit!.quote
    expect(q.code).toBe('161725')
    expect(q.name.length).toBeGreaterThan(0)
    // 至少要有盘中估值或公布净值其中之一
    expect(q.estimatedNav ?? q.publishedNav).toBeGreaterThan(0)
    // 涨跌幅统一为小数
    for (const rate of [q.estimatedRate, q.publishedRate]) {
      if (rate !== undefined) expect(Math.abs(rate)).toBeLessThan(1)
    }
    console.log(
      `[161725] ${q.name} 来源=${q.source} 估算=${q.estimatedNav ?? '-'} 估算涨幅=${q.estimatedRate ?? '-'} 公布净值=${q.publishedNav ?? '-'} 日期=${q.publishedAt ?? '-'}`,
    )
  }, 25_000)

  it('无效基金代码不会崩溃（返回空或抛业务错误）', async () => {
    try {
      const map = await fetchFundQuotes(['999999'])
      const q = map.get('999999')?.quote
      if (q) expect(q.estimatedNav ?? q.publishedNav).toBeGreaterThan(0)
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
    }
  }, 25_000)

  it.skipIf(!push2Online)('JSONP 通道（push2 cb=）返回的数据可被解析', async () => {
    // Node 里用 fetch 取回带 cb 包裹的脚本文本，再按 JSONP 的解析口径处理，
    // 验证「脚本包裹 → 数据解析 → 净值口径」整条链路。
    const url = buildPush2Url(['510300'])
    const res = await fetchWithRetry(url)
    const text = await res.text()
    const match = text.match(/^[^(]*\((.*)\);?\s*$/s)
    expect(match, `回调包裹格式异常：${text.slice(0, 120)}`).not.toBeNull()
    const quotes = parsePush2Batch(JSON.parse(match![1]))
    expect(quotes.length).toBeGreaterThan(0)
    expect(quotes[0].code).toBe('510300')
    expect(quotes[0].estimatedNav).toBeGreaterThan(0)
    console.log(`[push2] ${quotes[0].code} ${quotes[0].name} 价格=${quotes[0].estimatedNav} 涨跌=${quotes[0].estimatedRate}`)
  }, 25_000)

  it('端到端：登记持仓 → 同步行情 → 净资产随之变化', async () => {
    const portfolio = normalizePortfolio({
      categories: [
        {
          id: 'cat_fund',
          name: '基金',
          subtitle: '场外基金 / 持仓 / 净值',
          icon: 'chart-pie',
          color: '#22c55e',
          items: [{ id: 'f1', kind: 'fund', name: '', code: '161725', shares: 1000, costNav: 0.5 }],
        },
        {
          id: 'cat_cash',
          name: '现金与固定资产',
          subtitle: '银行 / 房产 / 现金',
          icon: 'banknote',
          color: '#f0b90b',
          items: [{ id: 'a1', kind: 'amount', name: '招行活期', amount: 10_000 }],
        },
      ],
    })!
    const before = summarize(portfolio)

    const map = await fetchFundQuotes(collectFundCodes(portfolio))
    const quote = map.get('161725')!.quote

    const merged = normalizePortfolio({
      ...portfolio,
      categories: portfolio.categories.map((c) => ({
        ...c,
        items: c.items.map((i) => (i.kind === 'fund' ? { ...i, quote } : i)),
      })),
    })!
    const after = summarize(merged)

    // 现金 10000 不变，基金部分由成本兜底 500 变为真实市值
    expect(after.totalAssets).toBeGreaterThan(before.totalAssets)
    expect(after.totalAssets).toBeCloseTo(10_000 + 1000 * (quote.estimatedNav ?? quote.publishedNav!), 2)
    console.log(`净资产：${before.netWorth.toFixed(2)} → ${after.netWorth.toFixed(2)} 元`)
  }, 25_000)
})

describe.skipIf(online)('真实接口：离线跳过', () => {
  it('当前环境无网络，已跳过联网用例', () => {
    expect(true).toBe(true)
  })
})

describe.skipIf(push2Online || !online)('真实接口：push2 IPv6 不可达时跳过', () => {
  it('push2 通道在当前网络不可达，已跳过（浏览器端 JSONP 与 fetch 通道不受影响）', () => {
    expect(true).toBe(true)
  })
})
