/**
 * 编辑既有数据（Post-Release / P1-7）
 *
 * ## 这个模块的边界（重要，别越界）
 *
 * | 允许 | 说明 |
 * | --- | --- |
 * | **账户属性**（名称 / 机构 / 类型 / 地区） | 纯元数据，不参与任何派生计算 |
 * | **手动口径**持仓的金额 / 备注 | `manualValue` 就是这类持仓的事实来源 |
 * | 删除**手动口径**持仓 | 用户明确要求；它是唯一记录，删了就没了 |
 *
 * | 不允许 | 原因 |
 * | --- | --- |
 * | 修改交易 | 交易只增不改，修正只能「作废 + 重录」（不变量 §10-8） |
 * | 修改**由交易派生**的持仓 | 它是缓存，改了也会被 `rebuildHoldingsFromTransactions` 覆盖（§10-1） |
 * | 修改「账户 + 标的」这个键 | 一个键只能有一条持仓（§10-14） |
 * | 写入负数 / NaN / 非有限数 | 负现金不得落库（§10-9） |
 *
 * 因此本模块**只做三件事**，且都能被一条不变量直接解释：
 * `updateAccount` / `updateManualHolding` / `deleteManualHolding`。
 *
 * ## 为什么账户「币种 / 负债标记」不在编辑范围内
 *
 * - `currency` 只是新建持仓时的默认值，**不参与任何校验**，改了没有实际收益；
 * - `isLiability` 会改变 `decideLiability()` 的结果，进而改变净资产口径 ——
 *   那是估值语义变更，应当单独评估，不混在「账户改名」这类编辑里。
 */

import type {
  Account,
  AccountRegion,
  AccountType,
  Holding,
} from '../../types/portfolio2'
import type { PortfolioRepository } from './repository'

/** 编辑失败的原因码（与 `creation.ts` 的 `CreateFailure` 保持同样的粒度） */
export type EditFailureCode =
  | 'invalid-input'
  | 'missing-reference'
  | 'duplicate'
  /** 目标不是手动口径持仓 —— 派生持仓不能直接改 */
  | 'not-manual'

export interface EditFailure {
  ok: false
  code: EditFailureCode
  message: string
}

/* ------------------------------------------------------------------ *
 * 账户
 * ------------------------------------------------------------------ */

export interface UpdateAccountInput {
  id: string
  name: string
  type: AccountType
  institution?: string
  region?: AccountRegion
  now?: () => Date
}

export type UpdateAccountResult = { ok: true; account: Account } | EditFailure

/**
 * 更新账户属性。
 *
 * **只改这四个字段**：`name` / `institution` / `type` / `region`。
 * `id` / `currency` / `isLiability` / `note` / `createdAt` 一律原样保留
 * （用展开原记录保证，而不是逐字段重写 —— 少写一个字段就会静默丢数据）。
 *
 * 判重口径与 `createAccount` 一致：**同名 + 同币种**视为重复（排除自己），
 * 避免用户改出一个和别的账户看着一模一样的名字。
 */
export async function updateAccount(
  repo: PortfolioRepository,
  input: UpdateAccountInput,
): Promise<UpdateAccountResult> {
  const portfolio = await repo.loadPortfolio()

  const current = portfolio.accounts.find((a) => a.id === input.id)
  if (!current) {
    return { ok: false, code: 'missing-reference', message: '账户不存在（可能已被删除或数据已变更）' }
  }

  const name = input.name?.trim()
  if (!name) return { ok: false, code: 'invalid-input', message: '请填写账户名称' }
  if (!input.type) return { ok: false, code: 'invalid-input', message: '请选择账户类型' }

  const dup = portfolio.accounts.find(
    (a) => a.id !== current.id && a.name.trim() === name && a.currency === current.currency,
  )
  if (dup) {
    return {
      ok: false,
      code: 'duplicate',
      message: `已存在同名同币种的账户「${name}（${current.currency}）」，请换一个名称`,
    }
  }

  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  const account: Account = {
    ...current,
    name,
    institution: input.institution?.trim() || undefined,
    type: input.type,
    region: input.region,
    updatedAt: nowIso,
  }

  await repo.accounts.put(account)
  return { ok: true, account }
}

/* ------------------------------------------------------------------ *
 * 手动口径持仓
 * ------------------------------------------------------------------ */

export interface UpdateManualHoldingInput {
  id: string
  /** 当前价值（原币） */
  manualValue: number
  note?: string
  now?: () => Date
}

export type UpdateManualHoldingResult = { ok: true; holding: Holding } | EditFailure

/**
 * 改手动口径持仓的金额。
 *
 * ⚠️ **拒绝任何非 `manual` 口径的持仓**：由交易派生的持仓是缓存，
 * 直接改它会被下一次 `rebuildHoldingsFromTransactions` 覆盖，
 * 用户会看到「改完又变回去了」—— 那是比「不能改」更糟的体验。
 * 这类持仓的正确修正方式是作废/重记对应交易。
 *
 * 金额校验与 `createManualHolding` 一致：必须是 **≥ 0 的有限数**。
 * 0 是合法值（余额可以为 0），负数与 NaN 一律拒绝（§10-9）。
 */
export async function updateManualHolding(
  repo: PortfolioRepository,
  input: UpdateManualHoldingInput,
): Promise<UpdateManualHoldingResult> {
  const portfolio = await repo.loadPortfolio()

  const current = portfolio.holdings.find((h) => h.id === input.id)
  if (!current) {
    return { ok: false, code: 'missing-reference', message: '持仓不存在（可能已被删除或数据已变更）' }
  }
  if (current.valuationMode !== 'manual') {
    return {
      ok: false,
      code: 'not-manual',
      message: '这条持仓由交易派生，不能直接改金额。请作废或重记对应的交易。',
    }
  }
  if (!Number.isFinite(input.manualValue) || input.manualValue < 0) {
    return {
      ok: false,
      code: 'invalid-input',
      message: '金额必须是大于等于 0 的有限数字',
    }
  }

  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  const holding: Holding = {
    ...current,
    manualValue: input.manualValue,
    /* 「多久没更新」提示依赖它，必须一起刷新 */
    manualValueAt: nowIso,
    note: input.note?.trim() || undefined,
    updatedAt: nowIso,
  }

  await repo.holdings.put(holding)
  return { ok: true, holding }
}

export interface DeleteManualHoldingInput {
  id: string
}

export type DeleteManualHoldingResult = { ok: true } | EditFailure

/**
 * 删除**手动口径**持仓。
 *
 * ⚠️ 这是本产品里少见的**破坏性**操作，理由与安全边界：
 *
 * - 手动口径持仓**没有交易作为依据**，它是这条资产的唯一记录 ——
 *   删掉就等于这笔资产不存在了，没有账本可以重建出来；
 * - 因此 UI 必须二次确认，并明确告知「此操作不可撤销」；
 * - 派生持仓一律拒绝删除：它们由交易重建，删了也会回来，
 *   真正该做的是作废对应交易。
 *
 * 与 `Transaction` 的「作废而非删除」不同：交易是**事实**（要留痕审计），
 * 手动持仓是**用户录入的当前估值**（本来就随时会被新估值取代）。
 */
export async function deleteManualHolding(
  repo: PortfolioRepository,
  input: DeleteManualHoldingInput,
): Promise<DeleteManualHoldingResult> {
  const portfolio = await repo.loadPortfolio()

  const current = portfolio.holdings.find((h) => h.id === input.id)
  if (!current) {
    return { ok: false, code: 'missing-reference', message: '持仓不存在（可能已被删除）' }
  }
  if (current.valuationMode !== 'manual') {
    return {
      ok: false,
      code: 'not-manual',
      message: '这条持仓由交易派生，不能在这里删除。请作废对应的交易。',
    }
  }

  await repo.holdings.remove(current.id)
  return { ok: true }
}
