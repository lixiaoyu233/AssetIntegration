import { describe, expect, it } from 'vitest'
import {
  UNTRACEABLE,
  positionBasisView,
  snapshotBasisSummary,
} from './basisView'
import type { SnapshotPosition } from '../../types/portfolio2'

/*
 * Phase 8 / W9 — P1-5：历史估值依据展示
 *
 * 核心规则：**缺失 = 无法追溯，绝不补值**。
 */

const base: SnapshotPosition = {
  instrumentId: 'i1',
  accountId: 'a1',
  quantity: 100,
  currency: 'CNY',
  reliable: true,
}

describe('positionBasisView：依据完整时如实展示', () => {
  it('展示 asOf / priceKind / quoteStatus / quoteSource', () => {
    const pos: SnapshotPosition = {
      ...base,
      price: 12,
      valueCny: 1200,
      asOf: '2026-10-01T02:00:00.000Z',
      priceKind: 'market_price',
      quoteStatus: 'LIVE',
      quoteSource: 'fundgz',
      reasons: [],
    }
    const v = positionBasisView(pos)
    const byLabel = new Map(v.fields.map((f) => [f.label, f]))
    expect(byLabel.get('依据时间')?.missing).toBe(false)
    expect(byLabel.get('价格类型')?.value).toBe('市场价格')
    expect(byLabel.get('行情来源')?.value).toBe('fundgz')
    expect(v.missingCount).toBe(0)
  })

  it('外币持仓展示 fxStatus / fxSource；CNY 持仓不展示这组字段', () => {
    const usd = positionBasisView({
      ...base, currency: 'USD', rateToCny: 7.2,
      fxStatus: 'LIVE', fxSource: 'ecb',
    })
    expect(usd.fields.map((f) => f.label)).toContain('汇率状态')
    expect(usd.fields.map((f) => f.label)).toContain('汇率来源')

    // CNY 恒为 1，不存在「汇率依据」——展示成无法追溯会误导
    const cny = positionBasisView({ ...base, currency: 'CNY' })
    expect(cny.fields.map((f) => f.label)).not.toContain('汇率状态')
  })

  it('可靠估值时**不**展示降级原因（空数组不是缺失）', () => {
    const v = positionBasisView({ ...base, asOf: '2026-10-01T00:00:00.000Z', reasons: [] })
    expect(v.fields.map((f) => f.label)).not.toContain('降级原因')
  })

  it('不可估值时展示降级原因', () => {
    const v = positionBasisView({
      ...base, reliable: false, reasons: ['missing_quote'],
    })
    const f = v.fields.find((x) => x.label === '降级原因')
    expect(f?.missing).toBe(false)
    expect(f?.value).toContain('missing_quote')
    expect(f?.tone).toBe('warn')
  })

  it('展示过期展示价（明确标注不计入总额）', () => {
    const v = positionBasisView({
      ...base, reliable: false, reasons: ['stale_quote'], staleValueCny: 1200,
    })
    const f = v.fields.find((x) => x.label.includes('过期展示价'))
    // 标签明确标注「不计入总额」，值只放金额（避免语义混在数字里）
    expect(f?.label).toContain('不计入总额')
    expect(f?.value).toContain('1,200.00')
    expect(f?.tone).toBe('warn')
  })
})

describe('【核心】缺失依据必须显示「无法追溯」，不得补值', () => {
  it('v7 及以前的快照：所有依据字段都缺失', () => {
    // 刻意不带任何 V8 字段
    const v = positionBasisView({ ...base })
    expect(v.missingCount).toBeGreaterThan(0)
    for (const f of v.fields) {
      expect(f.missing).toBe(true)
      expect(f.value).toBe(UNTRACEABLE)
    }
  })

  it('【核心】缺失时不显示 0（不可估值 ≠ 价值为 0）', () => {
    const v = positionBasisView({ ...base, staleValueCny: undefined })
    for (const f of v.fields) {
      expect(f.value).not.toBe('¥0.00')
      expect(f.value).not.toBe('0')
    }
    // 没有过期价时**根本不展示**该行，而不是展示 0
    expect(v.fields.map((f) => f.label)).not.toContain('过期展示价（不计入总额）')
  })

  it('【核心】负债标记缺失时为 untraceable —— 绝不当成「资产」', () => {
    const v = positionBasisView({ ...base })
    expect(v.liability).toBe('untraceable')
    expect(v.liability).not.toBe(false)
  })

  it('负债标记存在时如实反映', () => {
    expect(positionBasisView({ ...base, isLiabilityAtCapture: true }).liability).toBe(true)
    expect(positionBasisView({ ...base, isLiabilityAtCapture: false }).liability).toBe(false)
  })

  it('当时类别缺失时为 untraceable', () => {
    expect(positionBasisView({ ...base }).assetClassAtCapture).toBe('untraceable')
    expect(positionBasisView({ ...base, assetClassAtCapture: 'equity' }).assetClassAtCapture).toBe('equity')
  })

  it('依据时间非法字符串也视为缺失（不抛错、不显示 Invalid Date）', () => {
    const v = positionBasisView({ ...base, asOf: 'not-a-date' })
    const f = v.fields.find((x) => x.label === '依据时间')
    expect(f?.missing).toBe(true)
    expect(f?.value).toBe(UNTRACEABLE)
  })
})

describe('snapshotBasisSummary：整份快照的依据完整性', () => {
  it('区分「完整」与「完全无法追溯」', () => {
    const complete: SnapshotPosition = {
      ...base, asOf: '2026-10-01T00:00:00.000Z', priceKind: 'market_price',
      quoteStatus: 'LIVE', quoteSource: 'x',
    }
    const untraceable: SnapshotPosition = { ...base, instrumentId: 'i2' }
    const s = snapshotBasisSummary([complete, untraceable])
    expect(s.completeCount).toBe(1)
    expect(s.untraceableCount).toBe(1)
  })

  it('空 positions → 全 0（迁移来的月度快照）', () => {
    const s = snapshotBasisSummary([])
    expect(s.positions).toEqual([])
    expect(s.completeCount).toBe(0)
    expect(s.untraceableCount).toBe(0)
  })
})
