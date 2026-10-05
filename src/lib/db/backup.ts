/**
 * Backup / Restore（Phase 8 / W7）
 *
 * ## 解决什么问题
 *
 * W7 审计发现：**2.0 侧导出与导入能力均为零**，而 IndexedDB 是唯一事实源。
 * 同时 1.0 遗留的「导出 JSON」走的是 `toLegacyView` 投影，会**丢弃全部交易流水**，
 * 用户以为备份成功、实则拿到的文件无法还原账本。
 *
 * ## 安全顺序（硬约束）
 *
 * ```
 *  校验（结构 + 版本 + 引用完整性 + 总量）
 *        ↓
 *  dry-run 预览（**绝不写入任何数据**）
 *        ↓
 *  暂存备份（把当前事实源快照到 localStorage）
 *        ↓
 *  原子切换（单事务内替换，失败则整体回滚）
 *        ↓
 *  失败 → 原数据完整保留（Dexie 事务保证）
 * ```
 *
 * **`replaceAll` 绝不作为裸导入原语**：本模块的所有写入都经过上述顺序，
 * 并且恢复时会显式要求先成功落一份暂存备份。
 *
 * ## 版本策略
 *
 * | 情况 | 处理 |
 * | --- | --- |
 * | `schemaVersion > 当前` | **硬拒绝**（旧代码无法理解新字段，静默降级会丢语义） |
 * | `schemaVersion < 当前` | 走**显式登记的升级路径**（见 `UPGRADE_PATHS`），不靠结构猜测 |
 * | `schemaVersion === 当前` | 直接接受 |
 *
 * ## 校验依据的是「备份自带版本」而不是「结构形状」
 *
 * W1 的 `detectSchemaFamily` 只能区分 legacy / current 两族，
 * 无法区分 V3…V7 —— 因此备份文件必须自带版本信封，这也是它的存在意义。
 */

import type { Portfolio2 } from '../../types/portfolio2'
import type { PortfolioRepository } from './repository'
import { PORTFOLIO_SCHEMA_VERSION } from './schema'
import { reconcileHoldings } from '../ledger/reconcile'
import { detectDuplicateHoldings } from '../ledger/duplicates'
import { activeTransactions } from '../ledger/lifecycle'
import { DB_VERSION } from './dexie'

/* ------------------------------------------------------------------ *
 * 备份格式
 * ------------------------------------------------------------------ */

export const BACKUP_FORMAT = 'wealthcard-backup' as const
export const BACKUP_FORMAT_VERSION = 1 as const

/** 备份内容：完整的 Portfolio2 + 恢复所需但不在 Portfolio2 里的表 */
export interface BackupPayload {
  /** 组合主体（含 accounts/instruments/holdings/transactions/quotes/fxRates/snapshots/…） */
  portfolio: Portfolio2
  /**
   * 恢复所需的额外数据。
   *
   * `metaKv` 中的迁移记录 / 快照 attempt 属于「操作状态」，
   * 但**恢复后必须与数据版本一致**，否则会出现「记录说已迁移但数据是别的版本」。
   * 因此一并纳入备份。这是 W7 审计指出的 `replaceAll` 范围缺口的修复。
   */
  metaKv?: Record<string, unknown>
}

export interface BackupCounts {
  accounts: number
  instruments: number
  holdings: number
  transactions: number
  quotes: number
  fxRates: number
  snapshots: number
  allocationProfiles: number
  classificationAudit: number
}

export interface BackupEnvelope {
  /** 固定标识，便于识别「这是不是本应用的备份」 */
  format: typeof BACKUP_FORMAT
  /** 备份**文件格式**版本（与数据结构版本无关） */
  formatVersion: number
  /** 数据结构版本（`PORTFOLIO_SCHEMA_VERSION`）—— 兼容判定的唯一依据 */
  schemaVersion: number
  /** Dexie 数据库版本 */
  dbVersion: number
  /** 导出时间 */
  exportedAt: string
  /** 各表条目数（导入时用于总量一致性校验） */
  counts: BackupCounts
  /** 内容校验和（对 data 规范化后的稳定哈希） */
  checksum: string
  /** 导出前体检结果（供用户与导入方参考） */
  health: BackupHealth
  /** 数据 */
  data: BackupPayload
}

export interface BackupHealth {
  /** 账实是否相符 */
  reconcileOk: boolean
  reconcileIssues: Array<{ kind: string; detail: string }>
  /** 是否存在重复持仓 */
  duplicatesOk: boolean
  duplicateGroups: number
  /** 无法可靠估值的持仓数 */
  unavailableCount: number
  /** 数据是否完整 */
  isComplete: boolean
  /** 体检时间 */
  checkedAt: string
}

/* ------------------------------------------------------------------ *
 * 稳定序列化与校验和
 * ------------------------------------------------------------------ */

/**
 * 稳定 JSON（键名排序），保证同一份数据产生同一个字符串。
 *
 * 为什么需要：`JSON.stringify` 的键序依赖对象构造顺序，
 * 同一份数据经过一次读写往返后键序可能变化，导致 checksum 假失败。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const body = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')
  return `{${body}}`
}

/** 简易 64 位 FNV-1a，输出 16 位十六进制 */
export function checksumOf(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= c + i
    h2 = Math.imul(h2, 0x01000193) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

export function countsOf(portfolio: Portfolio2): BackupCounts {
  return {
    accounts: portfolio.accounts.length,
    instruments: portfolio.instruments.length,
    holdings: portfolio.holdings.length,
    transactions: portfolio.transactions.length,
    quotes: portfolio.quotes.length,
    fxRates: portfolio.fxRates.length,
    snapshots: portfolio.snapshots.length,
    allocationProfiles: portfolio.allocationProfiles.length,
    classificationAudit: portfolio.classificationAudit.length,
  }
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

export const BACKUP_SNAPSHOT_KEY = 'wealthcard/restore/staging-backup'

export interface ExportResult {
  ok: true
  envelope: BackupEnvelope
  /** 可直接写文件的 JSON 文本 */
  json: string
}

export interface ExportFailure {
  ok: false
  message: string
}

/**
 * 导出：读全量 → 体检 → 生成带信封的备份。
 *
 * **不写入任何业务数据**（只读）。
 */
export async function exportBackup(
  repo: PortfolioRepository,
  options: { now?: () => Date } = {},
): Promise<ExportResult | ExportFailure> {
  const now = (options.now ?? (() => new Date()))()
  const portfolio = await repo.loadPortfolio()

  /* ---- 导出前体检（复用既有能力，不新造规则） ---- */
  const reconcile = reconcileHoldings(portfolio)
  const duplicates = detectDuplicateHoldings(portfolio)

  let unavailableCount = 0
  for (const snap of portfolio.snapshots) {
    for (const pos of snap.positions) if (!pos.reliable) unavailableCount += 1
  }

  const health: BackupHealth = {
    reconcileOk: reconcile.ok,
    reconcileIssues: reconcile.issues.map((i) => ({ kind: i.kind, detail: i.detail })),
    duplicatesOk: duplicates.ok,
    duplicateGroups: duplicates.duplicates.length,
    unavailableCount,
    // 快照完整性：最近一份快照的 isComplete
    isComplete: portfolio.snapshots.length === 0
      ? true
      : (portfolio.snapshots[portfolio.snapshots.length - 1]?.isComplete ?? true),
    checkedAt: now.toISOString(),
  }

  /* ---- 迁移记录与快照 attempt 一并备份 ---- */
  const metaKv: Record<string, unknown> = {}
  const metaKeys = await repo.metaKv.keysWithPrefix('')
  for (const key of metaKeys) {
    const value = await repo.metaKv.get(key)
    if (value !== undefined) metaKv[key] = value
  }

  const data: BackupPayload = { portfolio, metaKv }
  const envelope: BackupEnvelope = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: PORTFOLIO_SCHEMA_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: now.toISOString(),
    counts: countsOf(portfolio),
    checksum: checksumOf(stableStringify(data)),
    health,
    data,
  }

  return { ok: true, envelope, json: JSON.stringify(envelope, null, 2) }
}

/** 生成下载用的文件名（不含路径） */
export function backupFileName(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `wealthcard-backup-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}.json`
  )
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

export interface ValidationIssue {
  kind:
    | 'format'
    | 'version'
    | 'checksum'
    | 'counts'
    | 'reference'
    | 'structure'
    | 'transaction'
  detail: string
  /** 严重问题必须拒绝导入；提示性问题不阻断 */
  blocking: boolean
}

export interface ValidationReport {
  ok: boolean
  /** 阻断性问题列表（ok=false 时非空） */
  blockers: ValidationIssue[]
  /** 非阻断提示 */
  warnings: ValidationIssue[]
  /** 文件声明的版本信息（能解析出来时） */
  declared?: { schemaVersion: number; dbVersion: number; formatVersion: number; exportedAt: string }
  /** 与当前数据的差异摘要（供 dry-run 预览） */
  preview?: RestorePreview
}

export interface RestorePreview {
  incoming: BackupCounts
  current: BackupCounts
  /** 将被替换的条目数（当前库里的） */
  willReplace: number
  /** 将新增的条目数（备份里的） */
  willAdd: number
}

/**
 * 显式登记的升级路径。
 *
 * **不靠结构猜测**：只有当 `fromVersion` 恰好命中这里，
 * 才允许把该版本的备份升到当前版本；升级函数必须可验证（返回新的 Portfolio2）。
 *
 * 目前 V6 → V7 是**纯零填充**（不改数据），因此可以直接接受。
 * 将来新增版本时必须在此登记，否则低版本备份会被拒绝。
 */
export const UPGRADE_PATHS: Record<number, { to: number; note: string }> = {
  6: { to: 7, note: 'V6 → V7：持仓明细的估值字段改为可缺失，不修改任何历史数据（零填充）' },
  7: {
    to: 8,
    note: 'V7 → V8：新增估值依据/捕获时刻等可选字段，存量数据不回填（缺失=无法追溯，零填充）',
  },
}

/** 该来源版本能否被当前版本安全读取 */
export function canUpgradeFrom(schemaVersion: number): boolean {
  let v = schemaVersion
  const guard = new Set<number>()
  while (v < PORTFOLIO_SCHEMA_VERSION) {
    if (guard.has(v)) return false
    guard.add(v)
    const step = UPGRADE_PATHS[v]
    if (!step) return false
    v = step.to
  }
  return v === PORTFOLIO_SCHEMA_VERSION
}

/** 引用完整性校验：任何悬空引用都必须拒绝 */
export function checkReferences(portfolio: Portfolio2): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const accountIds = new Set(portfolio.accounts.map((a) => a.id))
  const instrumentIds = new Set(portfolio.instruments.map((i) => i.id))

  const push = (kind: string, detail: string) =>
    issues.push({ kind: 'reference', detail: `${kind}：${detail}`, blocking: true })

  for (const h of portfolio.holdings) {
    if (!accountIds.has(h.accountId)) push('持仓→账户', `${h.id} 引用不存在的账户 ${h.accountId}`)
    if (!instrumentIds.has(h.instrumentId)) {
      push('持仓→标的', `${h.id} 引用不存在的标的 ${h.instrumentId}`)
    }
    if (h.valuationMode !== 'manual' && h.valuationMode !== 'quantity') {
      push('持仓口径', `${h.id} 的 valuationMode 非法：${String(h.valuationMode)}`)
    }
  }

  for (const t of portfolio.transactions) {
    if (!accountIds.has(t.accountId)) push('交易→账户', `${t.id} 引用不存在的账户 ${t.accountId}`)
    if (t.instrumentId && !instrumentIds.has(t.instrumentId)) {
      push('交易→标的', `${t.id} 引用不存在的标的 ${t.instrumentId}`)
    }
    if (t.cashInstrumentId && !instrumentIds.has(t.cashInstrumentId)) {
      push('交易→资金标的', `${t.id} 引用不存在的资金标的 ${t.cashInstrumentId}`)
    }
    if (t.toAccountId && !accountIds.has(t.toAccountId)) {
      push('交易→目标账户', `${t.id} 引用不存在的目标账户 ${t.toAccountId}`)
    }
    if (t.toCashInstrumentId && !instrumentIds.has(t.toCashInstrumentId)) {
      push('交易→换入标的', `${t.id} 引用不存在的换入标的 ${t.toCashInstrumentId}`)
    }
  }

  for (const q of portfolio.quotes) {
    if (!instrumentIds.has(q.instrumentId)) {
      push('行情→标的', `${q.id} 引用不存在的标的 ${q.instrumentId}`)
    }
  }

  for (const snap of portfolio.snapshots) {
    for (const pos of snap.positions) {
      if (!instrumentIds.has(pos.instrumentId)) {
        push('快照明细→标的', `${snap.date} 的 ${pos.instrumentId} 不存在`)
      }
      if (!accountIds.has(pos.accountId)) {
        push('快照明细→账户', `${snap.date} 的 ${pos.accountId} 不存在`)
      }
    }
  }

  for (const audit of portfolio.classificationAudit) {
    if (!instrumentIds.has(audit.instrumentId)) {
      push('审计→标的', `${audit.id} 引用不存在的标的 ${audit.instrumentId}`)
    }
  }

  return issues
}

/** 结构校验：ID 唯一性（重复 ID 会导致 bulkPut 静默覆盖） */
export function checkUniqueness(portfolio: Portfolio2): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const tables: Array<[string, Array<{ id: string }>]> = [
    ['accounts', portfolio.accounts],
    ['instruments', portfolio.instruments],
    ['holdings', portfolio.holdings],
    ['transactions', portfolio.transactions],
    ['quotes', portfolio.quotes],
    ['fxRates', portfolio.fxRates],
    ['snapshots', portfolio.snapshots],
    ['allocationProfiles', portfolio.allocationProfiles],
    ['classificationAudit', portfolio.classificationAudit],
  ]
  for (const [name, rows] of tables) {
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.id)) {
        issues.push({ kind: 'structure', detail: `${name} 存在重复 id：${row.id}`, blocking: true })
      }
      seen.add(row.id)
    }
  }
  // 快照日期唯一（DB 层是 &date 唯一索引，重复会导致导入失败）
  const dates = new Set<string>()
  for (const snap of portfolio.snapshots) {
    if (dates.has(snap.date)) {
      issues.push({ kind: 'structure', detail: `快照日期重复：${snap.date}`, blocking: true })
    }
    dates.add(snap.date)
  }
  return issues
}

/**
 * 校验一份备份文本。
 *
 * **纯函数**：不读取也不写入数据库；`current` 仅用于生成预览。
 */
export function validateBackupText(
  text: string,
  current?: Portfolio2,
): ValidationReport {
  const blockers: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  /* ---- ① JSON 解析 ---- */
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      blockers: [{ kind: 'format', detail: '不是合法的 JSON 文件', blocking: true }],
      warnings,
    }
  }

  const env = parsed as Partial<BackupEnvelope>

  /* ---- ② 格式标识 ---- */
  if (env?.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      blockers: [
        {
          kind: 'format',
          detail:
            `这不是 WealthCard 2.0 的备份文件（format=${String(env?.format)}）。` +
            '注意：1.0 的「导出 JSON」不包含交易流水，无法用于恢复 2.0 数据。',
          blocking: true,
        },
      ],
      warnings,
    }
  }
  if (typeof env.formatVersion !== 'number') {
    blockers.push({ kind: 'format', detail: '缺少 formatVersion', blocking: true })
  } else if (env.formatVersion > BACKUP_FORMAT_VERSION) {
    blockers.push({
      kind: 'version',
      detail: `备份文件格式版本 ${env.formatVersion} 高于本应用支持的 ${BACKUP_FORMAT_VERSION}`,
      blocking: true,
    })
  }

  /* ---- ③ 数据版本：高于当前硬拒绝；低版本走显式升级路径 ---- */
  const declared = {
    schemaVersion: Number(env.schemaVersion),
    dbVersion: Number(env.dbVersion),
    formatVersion: Number(env.formatVersion ?? 0),
    exportedAt: String(env.exportedAt ?? ''),
  }

  if (!Number.isFinite(declared.schemaVersion) || declared.schemaVersion <= 0) {
    blockers.push({ kind: 'version', detail: '缺少有效的 schemaVersion', blocking: true })
  } else if (declared.schemaVersion > PORTFOLIO_SCHEMA_VERSION) {
    blockers.push({
      kind: 'version',
      detail:
        `备份数据版本 V${declared.schemaVersion} **高于**当前应用支持的 V${PORTFOLIO_SCHEMA_VERSION}。` +
        '为避免静默降级读取（丢失语义），已拒绝导入。请升级应用后再恢复。',
      blocking: true,
    })
  } else if (declared.schemaVersion < PORTFOLIO_SCHEMA_VERSION) {
    if (!canUpgradeFrom(declared.schemaVersion)) {
      blockers.push({
        kind: 'version',
        detail:
          `备份数据版本 V${declared.schemaVersion} 没有登记的升级路径（目标 V${PORTFOLIO_SCHEMA_VERSION}）。` +
          '为避免猜测性转换，已拒绝导入。',
        blocking: true,
      })
    } else {
      warnings.push({
        kind: 'version',
        detail:
          `备份是 V${declared.schemaVersion}，将按登记的升级路径升级到 V${PORTFOLIO_SCHEMA_VERSION}（不修改历史数据）`,
        blocking: false,
      })
    }
  }

  /* ---- ④ 数据体结构 ---- */
  const data = env.data as BackupPayload | undefined
  const portfolio = data?.portfolio
  if (!portfolio || typeof portfolio !== 'object') {
    blockers.push({ kind: 'structure', detail: '缺少 data.portfolio', blocking: true })
    return { ok: false, blockers, warnings, declared }
  }

  const required: Array<keyof Portfolio2> = [
    'accounts',
    'instruments',
    'holdings',
    'transactions',
    'quotes',
    'fxRates',
    'snapshots',
    'allocationProfiles',
  ]
  for (const key of required) {
    if (!Array.isArray(portfolio[key])) {
      blockers.push({
        kind: 'structure',
        detail: `data.portfolio.${String(key)} 不是数组`,
        blocking: true,
      })
    }
  }
  if (blockers.some((b) => b.kind === 'structure')) return { ok: false, blockers, warnings, declared }

  // classificationAudit 缺失不阻断（老备份可能没有），但明确提示
  if (!Array.isArray(portfolio.classificationAudit)) {
    warnings.push({
      kind: 'structure',
      detail: '备份不含分类审计记录（classificationAudit），恢复后审计链为空',
      blocking: false,
    })
    portfolio.classificationAudit = []
  }

  /* ---- ⑤ 校验和 ---- */
  const expected = env.checksum
  if (typeof expected !== 'string' || expected.length === 0) {
    warnings.push({ kind: 'checksum', detail: '备份没有校验和，无法验证完整性', blocking: false })
  } else {
    const actual = checksumOf(stableStringify(data))
    if (actual !== expected) {
      blockers.push({
        kind: 'checksum',
        detail: `校验和不匹配（期望 ${expected}，实际 ${actual}）—— 文件可能被修改或损坏`,
        blocking: true,
      })
    }
  }

  /* ---- ⑥ 总量一致性 ---- */
  if (env.counts) {
    const actual = countsOf(portfolio)
    for (const key of Object.keys(actual) as Array<keyof BackupCounts>) {
      if (env.counts[key] !== actual[key]) {
        blockers.push({
          kind: 'counts',
          detail: `条目数不一致：${String(key)} 声明 ${env.counts[key]}，实际 ${actual[key]}`,
          blocking: true,
        })
      }
    }
  } else {
    warnings.push({ kind: 'counts', detail: '备份没有条目数清单', blocking: false })
  }

  /* ---- ⑦ 唯一性 + 引用完整性（坏数据即使结构合法也必须拒绝） ---- */
  blockers.push(...checkUniqueness(portfolio))
  blockers.push(...checkReferences(portfolio))

  /* ---- ⑧ 账本自洽（提示，不阻断：历史数据可能有孤儿持仓需用户处理） ---- */
  const reconcile = reconcileHoldings(portfolio)
  if (!reconcile.ok) {
    warnings.push({
      kind: 'transaction',
      detail: `备份内部账实校验未通过（${reconcile.issues.length} 项）：${reconcile.issues[0]?.detail ?? ''}`,
      blocking: false,
    })
  }
  const duplicates = detectDuplicateHoldings(portfolio)
  if (!duplicates.ok) {
    warnings.push({
      kind: 'transaction',
      detail: `备份内部存在 ${duplicates.duplicates.length} 组重复持仓，需要手工处理`,
      blocking: false,
    })
  }

  /* ---- ⑨ dry-run 预览 ---- */
  let preview: RestorePreview | undefined
  if (current) {
    const incoming = countsOf(portfolio)
    const cur = countsOf(current)
    preview = {
      incoming,
      current: cur,
      willReplace:
        cur.accounts +
        cur.instruments +
        cur.holdings +
        cur.transactions +
        cur.quotes +
        cur.fxRates +
        cur.snapshots +
        cur.allocationProfiles,
      willAdd:
        incoming.accounts +
        incoming.instruments +
        incoming.holdings +
        incoming.transactions +
        incoming.quotes +
        incoming.fxRates +
        incoming.snapshots +
        incoming.allocationProfiles,
    }
  }

  return { ok: blockers.length === 0, blockers, warnings, declared, preview }
}

/* ------------------------------------------------------------------ *
 * 暂存备份（可回滚）
 * ------------------------------------------------------------------ */

interface StagingBackup {
  savedAt: string
  schemaVersion: number
  payload: BackupPayload
}

/**
 * 把当前事实源快照到 localStorage（**操作状态**，不是业务事实源）。
 *
 * ⚠️ 这是导入前的安全网，因此**任何失败都必须抛出**，
 * 由 `restoreBackup` 捕获并中止导入 —— 绝不允许「没有回滚点就覆盖数据」。
 *
 * `localStorage` 在隐私模式 / 某些环境下可能不可用（甚至未定义），
 * 此时 `getStorage()` 会抛出，从而正确地中止导入。
 */
export async function saveStagingBackup(repo: PortfolioRepository): Promise<string> {
  const portfolio = await repo.loadPortfolio()
  const metaKv: Record<string, unknown> = {}
  for (const key of await repo.metaKv.keysWithPrefix('')) {
    const value = await repo.metaKv.get(key)
    if (value !== undefined) metaKv[key] = value
  }
  const staging: StagingBackup = {
    savedAt: new Date().toISOString(),
    schemaVersion: PORTFOLIO_SCHEMA_VERSION,
    payload: { portfolio, metaKv },
  }
  const text = JSON.stringify(staging)
  getStorage().setItem(BACKUP_SNAPSHOT_KEY, text)
  return staging.savedAt
}

/**
 * 取 localStorage；不可用时**抛错**（调用方据此中止危险操作）。
 *
 * 与读取路径的「静默返回 null」不同：写不进去就不能继续，
 * 否则用户会在毫无回滚点的情况下列被覆盖掉数据。
 */
function getStorage(): Storage {
  const ls = (globalThis as { localStorage?: Storage }).localStorage
  if (!ls) throw new Error('本浏览器环境不可用本地存储，无法创建回滚点')
  return ls
}

/** 读取 localStorage；不可用时返回 null（只读路径可以静默降级） */
function tryStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    return null
  }
}

export function readStagingBackup(): { savedAt: string; schemaVersion: number } | null {
  try {
    const raw = tryStorage()?.getItem(BACKUP_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StagingBackup
    if (!parsed?.savedAt || !parsed.payload?.portfolio) return null
    return { savedAt: parsed.savedAt, schemaVersion: parsed.schemaVersion }
  } catch {
    return null
  }
}

export function clearStagingBackup(): void {
  try {
    tryStorage()?.removeItem(BACKUP_SNAPSHOT_KEY)
  } catch {
    /* 忽略 */
  }
}

/**
 * 用暂存备份把数据回滚到导入前。
 *
 * ## 修复的三个缺陷（Phase 8 / W10-Patch，P0-2）
 *
 * 原实现是：
 * ```ts
 * await restoreBackup(repo, parsed.payload)   // ← 返回值被丢弃
 * clearStagingBackup()                        // ← 无条件清除
 * return true                                 // ← 无条件成功
 * ```
 * 由于 `restoreBackup()` 把写入失败表达为 **`{ok:false}` 返回值**（不是抛异常），
 * 上述写法在写入失败时会：
 * 1. **谎报成功**（`return true`），UI 显示「已回滚到导入前的数据」；
 * 2. **删除唯一的回滚副本**（`clearStagingBackup()`），用户彻底无法恢复；
 * 3. 且回滚内部的 `saveStagingBackup()` 早已用**当前坏数据**覆盖了那份正确副本。
 *
 * 现在：
 * - 传 `preserveExistingStaging: true` → **不重写暂存**；
 * - **只有 `result.ok === true` 才清除暂存**；
 * - 失败时保留暂存并返回 false，**可以反复重试**。
 */
export async function rollbackFromStaging(repo: PortfolioRepository): Promise<boolean> {
  try {
    const raw = tryStorage()?.getItem(BACKUP_SNAPSHOT_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as StagingBackup
    if (!parsed?.payload?.portfolio) return false

    const result = await restoreBackup(repo, parsed.payload, {
      // 关键：回滚绝不能用「当前（坏）数据」重写这份唯一正确的副本
      preserveExistingStaging: true,
    })

    // 只有真的写进去了才允许销毁回滚点
    if (!result.ok) return false
    clearStagingBackup()
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 恢复
 * ------------------------------------------------------------------ */

export interface RestoreResult {
  ok: true
  /** 导入前暂存备份的时间 */
  stagingSavedAt: string
  counts: BackupCounts
}

export interface RestoreFailure {
  ok: false
  message: string
  report?: ValidationReport
}

/**
 * **写入数据库**（原子切换）。
 *
 * ## 为什么必须走这个顺序
 *
 * `replaceAll` 在单事务内**先 clear 8 张表再 bulkPut**。
 * 事务原子性只保证「不产生半状态」，**不保证不丢数据**：
 * 结构合法但内容错误的 JSON 会成功提交，旧数据永久消失。
 *
 * 因此这里强制：
 * ```
 * ① 先落暂存备份（失败即中止，不碰数据）
 * ② 再整体替换（含 classificationAudit 与 meta，修复 W7 审计的范围缺口）
 * ```
 *
 * 调用方必须先跑过 `validateBackupText` 的 dry-run。
 */
export interface RestoreOptions {
  /**
   * 保留**既有**暂存备份，不重新创建。
   *
   * ## 为什么必须存在这个选项（Phase 8 / W10-Patch，P0-2）
   *
   * `saveStagingBackup()` 每调用一次，就用**当前库里的数据**覆盖同名暂存键。
   * 而回滚时库里的数据正是**坏数据** —— 于是「准备回滚」这个动作本身
   * 会把唯一一份正确的回滚副本覆盖掉。随后无论回滚成败，
   * 用户都永久失去了回到导入前状态的能力。
   *
   * 因此回滚路径必须传 `true`：**读取并使用既有暂存，绝不重写它**。
   */
  preserveExistingStaging?: boolean
}

export async function restoreBackup(
  repo: PortfolioRepository,
  payload: BackupPayload,
  options: RestoreOptions = {},
): Promise<RestoreResult | RestoreFailure> {
  /* ---- ① 暂存备份：失败则绝不进入写入 ---- */
  let stagingSavedAt: string
  if (options.preserveExistingStaging) {
    /*
     * 回滚路径：**不重写暂存**（那会毁掉唯一副本）。
     * 但仍要确认它确实存在 —— 没有回滚点就不该继续。
     */
    const existing = readStagingBackup()
    if (!existing) {
      return {
        ok: false,
        message: '找不到导入前的暂存备份，已中止（不会修改任何数据）',
      }
    }
    stagingSavedAt = existing.savedAt
  } else {
    try {
      stagingSavedAt = await saveStagingBackup(repo)
    } catch (e) {
      return {
        ok: false,
        message: `无法创建导入前的暂存备份，已中止（不会修改任何数据）：${
          e instanceof Error ? e.message : '未知错误'
        }`,
      }
    }
  }

  /* ---- ② 原子替换（含 classificationAudit / meta） ---- */
  try {
    await repo.replaceAll(payload.portfolio, { metaKv: payload.metaKv })
  } catch (e) {
    return {
      ok: false,
      message: `写入失败，原数据保持不变（事务已回滚）：${
        e instanceof Error ? e.message : '未知错误'
      }`,
    }
  }

  return { ok: true, stagingSavedAt, counts: countsOf(payload.portfolio) }
}

/* ------------------------------------------------------------------ *
 * 便捷：解析备份文本为载荷
 * ------------------------------------------------------------------ */

export function parseBackupPayload(text: string): BackupPayload | null {
  try {
    const env = JSON.parse(text) as BackupEnvelope
    if (env?.format !== BACKUP_FORMAT) return null
    if (!env.data?.portfolio) return null
    // 低版本走零填充升级：V6 备份的持仓明细字段本就是可选的，直接可用
    const payload: BackupPayload = {
      portfolio: { ...env.data.portfolio, classificationAudit: env.data.portfolio.classificationAudit ?? [] },
      metaKv: env.data.metaKv,
    }
    return payload
  } catch {
    return null
  }
}

export { activeTransactions }
