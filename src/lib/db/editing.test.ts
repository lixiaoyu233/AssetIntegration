import { describe, expect, it } from 'vitest'
import { createInMemoryRepository } from './dexieRepository'
import { createAccount, createInstrument, createManualHolding } from './creation'
import {
  deleteManualHolding,
  updateAccount,
  updateManualHolding,
} from './editing'
import type { PortfolioRepository } from './repository'
import type { Holding } from '../../types/portfolio2'

/*
 * 编辑既有数据（P1-7）
 *
 * 这里锁定的是**边界**，不只是「能改」：
 * - 只改该改的字段，其余原样保留（少写一个字段就是静默丢数据）；
 * - 由交易派生的持仓**必须拒绝** —— 改了也会被 rebuild 覆盖；
 * - 负数 / NaN 一律拒绝（不变量 §10-9）。
 */

const NOW = () => new Date('2026-10-05T08:00:00.000Z')
const LATER = () => new Date('2026-10-06T09:30:00.000Z')

interface Setup {
  repo: PortfolioRepository
  accountId: string
  instrumentId: string
  holdingId: string
}

async function setup(): Promise<Setup> {
  const repo = createInMemoryRepository()
  const acc = await createAccount(repo, {
    name: '示例银行',
    type: 'bank',
    currency: 'CNY',
    region: 'CN',
    institution: '示例机构',
    now: NOW,
  })
  if (!acc.ok) throw new Error(acc.message)

  const inst = await createInstrument(repo, {
    name: '活期存款',
    instrumentType: 'cash',
    assetClass: 'cash',
    currency: 'CNY',
    now: NOW,
  })
  if (!inst.ok) throw new Error(inst.message)

  const holding = await createManualHolding(repo, {
    accountId: acc.account.id,
    instrumentId: inst.instrument.id,
    manualValue: 20_000,
    note: '原备注',
    now: NOW,
  })
  if (!holding.ok) throw new Error(holding.message)

  return {
    repo,
    accountId: acc.account.id,
    instrumentId: inst.instrument.id,
    holdingId: holding.holding.id,
  }
}

/* ================================================================== *
 * ① 账户
 * ================================================================== */

describe('updateAccount', () => {
  it('改名 / 类型 / 地区 / 机构，其余字段原样保留', async () => {
    const { repo, accountId } = await setup()
    const before = (await repo.accounts.get(accountId))!

    const r = await updateAccount(repo, {
      id: accountId,
      name: '  新名字  ',
      type: 'broker',
      region: 'US',
      institution: '新机构',
      now: LATER,
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.account.name).toBe('新名字') // 两端空白被裁掉
    expect(r.account.type).toBe('broker')
    expect(r.account.region).toBe('US')
    expect(r.account.institution).toBe('新机构')

    // 不允许被改动的字段必须原样（少写一个就是静默丢数据）
    expect(r.account.id).toBe(before.id)
    expect(r.account.currency).toBe(before.currency)
    expect(r.account.isLiability).toBe(before.isLiability)
    expect(r.account.createdAt).toBe(before.createdAt)
    expect(r.account.updatedAt).toBe('2026-10-06T09:30:00.000Z')
    expect(r.account.updatedAt).not.toBe(before.updatedAt)
  })

  it('机构与地区可清空（留空即 undefined，不是空串）', async () => {
    const { repo, accountId } = await setup()
    const r = await updateAccount(repo, {
      id: accountId,
      name: '示例银行',
      type: 'bank',
      institution: '   ',
      region: undefined,
      now: LATER,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.account.institution).toBeUndefined()
    expect(r.account.region).toBeUndefined()
  })

  it('空名称 / 不存在的账户 → 拒绝', async () => {
    const { repo, accountId } = await setup()
    const empty = await updateAccount(repo, { id: accountId, name: '   ', type: 'bank' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe('invalid-input')

    const missing = await updateAccount(repo, { id: 'nope', name: 'x', type: 'bank' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('missing-reference')
  })

  it('【核心】判重口径与创建一致：同名同币种拒绝，但改回自己的名字必须允许', async () => {
    const { repo, accountId, instrumentId } = await setup()
    void instrumentId

    // 另一个同币种账户
    const other = await createAccount(repo, { name: '另一个银行', type: 'bank', currency: 'CNY', now: NOW })
    expect(other.ok).toBe(true)

    const dup = await updateAccount(repo, { id: accountId, name: '另一个银行', type: 'bank' })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.code).toBe('duplicate')

    // 排除自己 —— 否则「只改机构」这种操作会被自己的名字挡住
    const self = await updateAccount(repo, {
      id: accountId,
      name: '示例银行',
      type: 'bank',
      institution: '改了机构',
      now: LATER,
    })
    expect(self.ok).toBe(true)
  })
})

/* ================================================================== *
 * ② 手动口径持仓
 * ================================================================== */

describe('updateManualHolding', () => {
  it('改金额与备注，刷新 manualValueAt，其余字段原样保留', async () => {
    const { repo, holdingId } = await setup()
    const before = (await repo.holdings.get(holdingId))!

    const r = await updateManualHolding(repo, {
      id: holdingId,
      manualValue: 25_000,
      note: '新备注',
      now: LATER,
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.holding.manualValue).toBe(25_000)
    expect(r.holding.note).toBe('新备注')
    expect(r.holding.manualValueAt).toBe('2026-10-06T09:30:00.000Z')
    expect(r.holding.updatedAt).toBe('2026-10-06T09:30:00.000Z')

    expect(r.holding.id).toBe(before.id)
    expect(r.holding.accountId).toBe(before.accountId)
    expect(r.holding.instrumentId).toBe(before.instrumentId)
    expect(r.holding.valuationMode).toBe('manual')
    expect(r.holding.createdAt).toBe(before.createdAt)
  })

  it('0 是合法金额（余额可以为 0），负数与 NaN 拒绝', async () => {
    const { repo, holdingId } = await setup()

    const zero = await updateManualHolding(repo, { id: holdingId, manualValue: 0, now: LATER })
    expect(zero.ok).toBe(true)

    const neg = await updateManualHolding(repo, { id: holdingId, manualValue: -1, now: LATER })
    expect(neg.ok).toBe(false)
    if (!neg.ok) expect(neg.code).toBe('invalid-input')

    const nan = await updateManualHolding(repo, { id: holdingId, manualValue: Number.NaN, now: LATER })
    expect(nan.ok).toBe(false)

    const inf = await updateManualHolding(repo, { id: holdingId, manualValue: Number.POSITIVE_INFINITY, now: LATER })
    expect(inf.ok).toBe(false)
  })

  it('【核心】由交易派生的持仓必须拒绝（改了也会被 rebuild 覆盖）', async () => {
    const { repo, accountId } = await setup()
    const derived: Holding = {
      id: 'h_derived',
      accountId,
      instrumentId: 'i_derived',
      valuationMode: 'quantity',
      quantity: 100,
      costBasis: 1000,
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    }
    await repo.holdings.put(derived)

    const r = await updateManualHolding(repo, { id: 'h_derived', manualValue: 999, now: LATER })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-manual')

    // 数据一个字节都没动
    expect((await repo.holdings.get('h_derived'))!.manualValue).toBeUndefined()
  })

  it('不存在的持仓 → 拒绝', async () => {
    const { repo } = await setup()
    const r = await updateManualHolding(repo, { id: 'nope', manualValue: 1, now: LATER })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing-reference')
  })
})

/* ================================================================== *
 * ③ 删除
 * ================================================================== */

describe('deleteManualHolding', () => {
  it('手动口径持仓可删除', async () => {
    const { repo, holdingId } = await setup()
    expect(await repo.holdings.count()).toBe(1)

    const r = await deleteManualHolding(repo, { id: holdingId })
    expect(r.ok).toBe(true)
    expect(await repo.holdings.count()).toBe(0)
  })

  it('【核心】派生持仓拒绝删除（删了也会被重建回来，正确做法是作废交易）', async () => {
    const { repo, accountId } = await setup()
    await repo.holdings.put({
      id: 'h_derived',
      accountId,
      instrumentId: 'i_derived',
      valuationMode: 'quantity',
      quantity: 1,
      costBasis: 1,
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    } as Holding)

    const r = await deleteManualHolding(repo, { id: 'h_derived' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not-manual')
    expect(await repo.holdings.get('h_derived')).toBeDefined()
  })

  it('不存在的持仓 → 拒绝', async () => {
    const { repo } = await setup()
    const r = await deleteManualHolding(repo, { id: 'nope' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing-reference')
  })
})
