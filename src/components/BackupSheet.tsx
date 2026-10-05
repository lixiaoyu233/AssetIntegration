import { useState } from 'react'
import { AlertTriangle, Download, Info, Upload } from 'lucide-react'
import type { PortfolioRepository } from '../lib/db/repository'
import {
  backupFileName,
  exportBackup,
  parseBackupPayload,
  readStagingBackup,
  restoreBackup,
  rollbackFromStaging,
  validateBackupText,
  type ValidationReport,
} from '../lib/db/backup'
import Sheet from './Sheet'

/**
 * 备份 / 恢复（Phase 8 / W7）
 *
 * ## 安全顺序（不可颠倒）
 *
 * ```
 * 选文件 → 校验（纯函数、不碰数据库）→ dry-run 预览
 *        → 二次确认 → 暂存备份 → 原子切换
 * ```
 *
 * ## 两条硬规则
 *
 * 1. **dry-run 绝不写入任何数据**：校验是纯函数，预览只展示差异
 * 2. **坏数据必须被拒绝**：版本高于当前、校验和不符、引用悬空、ID 重复
 *    一律阻断；即使结构合法、内容错误的文件也不能写入
 */
export interface BackupSheetProps {
  open: boolean
  onClose: () => void
  repo: PortfolioRepository
  onChanged: () => void
}

type Stage = 'idle' | 'previewed' | 'restored'

export default function BackupSheet({ open, onClose, repo, onChanged }: BackupSheetProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [report, setReport] = useState<ValidationReport | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const [staging, setStaging] = useState(() => readStagingBackup())

  /* ---------------- 导出 ---------------- */
  const doExport = async () => {
    setBusy(true)
    setError(null)
    setInfo(null)
    const r = await exportBackup(repo)
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    const blob = new Blob([r.json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = backupFileName()
    a.click()
    URL.revokeObjectURL(url)

    const h = r.envelope.health
    setInfo(
      `已导出 ${r.envelope.counts.transactions} 笔交易 / ${r.envelope.counts.instruments} 个标的；` +
        `账实校验${h.reconcileOk ? '通过' : `有 ${h.reconcileIssues.length} 项问题`}、` +
        `重复持仓${h.duplicatesOk ? '无' : `${h.duplicateGroups} 组`}。` +
        `校验和 ${r.envelope.checksum}`,
    )
  }

  /* ---------------- 选择文件（只校验，不写入） ---------------- */
  const onPickFile = async (file: File) => {
    setError(null)
    setInfo(null)
    setReport(null)
    setPendingText(null)
    setStage('idle')

    const text = await file.text()
    const current = await repo.loadPortfolio()
    const rep = validateBackupText(text, current)
    setReport(rep)

    if (rep.ok) {
      setPendingText(text)
      setStage('previewed')
    }
  }

  /* ---------------- 正式导入 ---------------- */
  const doRestore = async () => {
    if (!pendingText) return
    setBusy(true)
    setError(null)
    const payload = parseBackupPayload(pendingText)
    if (!payload) {
      setBusy(false)
      setError('备份内容无法解析，已中止（未修改任何数据）')
      return
    }
    const r = await restoreBackup(repo, payload)
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    setStaging(readStagingBackup())
    setStage('restored')
    setInfo(
      `导入完成：${r.counts.transactions} 笔交易 / ${r.counts.instruments} 个标的 / ` +
        `${r.counts.snapshots} 份快照。导入前的数据已暂存（${new Date(r.stagingSavedAt).toLocaleString('zh-CN')}），可回滚。`,
    )
    setPendingText(null)
    onChanged()
  }

  /* ---------------- 回滚 ---------------- */
  const doRollback = async () => {
    setBusy(true)
    setError(null)
    const ok = await rollbackFromStaging(repo)
    setBusy(false)
    if (!ok) {
      /*
       * W10-Patch / P0-2：回滚现在**按 `restoreBackup` 的真实返回值**判定。
       * 失败时暂存备份**不会被删除**，因此用户可以稍后重试
       * （例如暂时性的存储配额/多标签页事务冲突）。
       */
      setError('回滚失败：写入未成功（暂存备份已保留，可稍后重试）；当前数据未被修改')
      return
    }
    setStaging(readStagingBackup())
    setInfo('已回滚到导入前的数据。')
    setReport(null)
    setStage('idle')
    onChanged()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="备份与恢复"
      subtitle="数据只在本机，建议定期导出"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2"
          data-testid="backup-close"
        >
          关闭
        </button>
      }
    >
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          数据保存在本机浏览器中。<span className="text-ink2">浏览器清理站点数据会导致数据丢失</span>，
          而本机是唯一副本 —— 请定期导出备份。
        </span>
      </p>

      {/* ---------------- 导出 ---------------- */}
      <section className="mt-3 rounded-2xl border border-line bg-s1 p-3">
        <h3 className="text-[13px] font-medium text-ink">导出备份</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-ink4">
          包含完整数据（账户 / 标的 / 持仓 / <span className="text-ink3">全部交易流水</span> /
          行情 / 汇率 / 快照 / 分类审计），并附带版本信封与校验和。
          导出前会先做一次数据体检。
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void doExport()}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
          data-testid="backup-export"
        >
          <Download size={14} />
          {busy ? '处理中…' : '导出 JSON 备份'}
        </button>
      </section>

      {/* ---------------- 导入 ---------------- */}
      <section className="mt-3 rounded-2xl border border-line bg-s1 p-3">
        <h3 className="text-[13px] font-medium text-ink">导入 / 恢复</h3>
        <p className="mt-1 rounded-xl border border-warn/25 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed tone-warn">
          <AlertTriangle size={11} className="mr-1 inline" />
          <span className="text-ink2">导入会替换当前全部数据</span>
          （导入前会自动暂存一份，可回滚）。
        </p>

        <label className="mt-2 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-line bg-s2 py-2.5 text-[13px] text-ink2">
          <Upload size={14} />
          选择备份文件
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="backup-file"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onPickFile(f)
              e.target.value = ''
            }}
          />
        </label>

        {/* dry-run 预览 */}
        {report ? (
          <div className="mt-2" data-testid="backup-report">
            {report.blockers.length > 0 ? (
              <div className="rounded-xl border border-warn/25 bg-warn/10 px-3 py-2">
                <p className="text-[11px] font-medium tone-warn">
                  已拒绝导入（{report.blockers.length} 项阻断问题），当前数据未被修改
                </p>
                <ul className="mt-1 space-y-0.5 text-[11px] text-ink3">
                  {report.blockers.slice(0, 6).map((b, i) => (
                    <li key={i}>· {b.detail}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-xl border border-line bg-s2 px-3 py-2">
                <p className="text-[11px] font-medium text-ink2">校验通过（尚未写入）</p>
                {report.declared ? (
                  <p className="mt-0.5 text-[11px] text-ink4">
                    备份版本 V{report.declared.schemaVersion} · 导出于{' '}
                    {new Date(report.declared.exportedAt).toLocaleString('zh-CN')}
                  </p>
                ) : null}
                {report.preview ? (
                  <p className="mt-1 text-[11px] text-ink3" data-testid="backup-preview">
                    将替换现有 {report.preview.willReplace} 条记录，写入{' '}
                    {report.preview.willAdd} 条；其中交易 {report.preview.incoming.transactions} 笔、
                    快照 {report.preview.incoming.snapshots} 份。
                  </p>
                ) : null}
                {report.warnings.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-[11px] text-ink4">
                    {report.warnings.slice(0, 4).map((wn, i) => (
                      <li key={i}>· {wn.detail}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </div>
        ) : null}

        {stage === 'previewed' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void doRestore()}
            className="mt-2 w-full rounded-xl bg-ink py-2.5 text-[13px] text-s1 disabled:opacity-50"
            data-testid="backup-restore"
          >
            {busy ? '导入中…' : '确认导入（将替换当前数据）'}
          </button>
        ) : null}

        {/* 回滚 */}
        {staging ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void doRollback()}
            className="mt-2 w-full rounded-xl border border-line bg-s2 py-2.5 text-[12px] text-ink2 disabled:opacity-50"
            data-testid="backup-rollback"
          >
            回滚到导入前（暂存于 {new Date(staging.savedAt).toLocaleString('zh-CN')}）
          </button>
        ) : null}
      </section>

      {error ? (
        <p className="mt-2 rounded-xl border border-warn/25 bg-warn/10 px-3 py-2 text-[11px] tone-warn" data-testid="backup-error">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="mt-2 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink2" data-testid="backup-info">
          {info}
        </p>
      ) : null}
    </Sheet>
  )
}
