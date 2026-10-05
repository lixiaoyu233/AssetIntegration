import { useEffect, useMemo, useState } from 'react'
import { Database, Info, Lock, RefreshCw, ShieldCheck } from 'lucide-react'
import type { Portfolio2 } from '../types/portfolio2'
import type { AnalysisView } from '../lib/analysis'
import type { PortfolioRepository } from '../lib/db/repository'
import { quoteCoverageOf } from '../lib/valuation/basis'
import { estimateStorage } from '../lib/db/dexie'
import BackupSheet from '../components/BackupSheet'
import QuoteSheet from '../components/QuoteSheet'
import FxSheet from '../components/FxSheet'
import { PORTFOLIO_SCHEMA_VERSION, describeMigrationChain } from '../lib/db/schema'
import { DB_VERSION } from '../lib/db/dexie'
import AttributeKindSheet from '../components/AttributeKindSheet'
import DuplicateSheet from '../components/DuplicateSheet'
import { detectDuplicateHoldings } from '../lib/ledger/duplicates'

/**
 * 设置 Tab
 *
 * ## 允许写什么
 *
 * **只允许写 UI 偏好**（非业务事实）。本 Tab 目前不写任何业务数据。
 *
 * ## 明确展示的事实
 *
 * - 业务事实源是 IndexedDB（Schema 版本、DB 版本、迁移链）
 * - localStorage 只保存 UI 偏好
 * - 历史分类是否可用
 * - 重复持仓状态（只检测，不修复）
 */
export interface SettingsTabProps {
  portfolio: Portfolio2
  analysis: AnalysisView
  repo: PortfolioRepository
  onChanged: () => void
}

export default function SettingsTab({ portfolio, analysis, repo, onChanged }: SettingsTabProps) {
  /** 行情 / 汇率覆盖率（纯读取，不改金额） */
  const coverage = useMemo(() => quoteCoverageOf(portfolio), [portfolio])

  /*
   * 读取存储状态（W7）。
   *
   * 刻意**不谎报**：`persisted` 读不到就是 `null`（未知），
   * 不假定为 true；`estimate` 不支持就是 null。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const persisted = await repo.metaKv.get<{ persisted: boolean }>('storage/persisted')
      const est = await estimateStorage()
      if (cancelled) return
      setStorage({ persisted: persisted?.persisted ?? null, estimate: est })
    })()
    return () => {
      cancelled = true
    }
  }, [repo])
  const [dupOpen, setDupOpen] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [fxOpen, setFxOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  /** 存储状态（持久化 + 用量）：挂载时读一次，失败一律如实显示「未知」 */
  const [storage, setStorage] = useState<{
    persisted: boolean | null
    estimate: { usage: number; quota: number } | null
  }>({ persisted: null, estimate: null })
  const [attrOpen, setAttrOpen] = useState(false)

  const duplicates = useMemo(() => detectDuplicateHoldings(portfolio), [portfolio])

  /** 历史分类可用性统计（只读事实，不修改） */
  const historyStats = useMemo(() => {
    const total = portfolio.snapshots.length
    const withClass = portfolio.snapshots.filter(
      (s) => s.positions.length > 0 && s.positions.every((p) => p.assetClassAtCapture !== undefined),
    ).length
    const unmarked = portfolio.snapshots.filter((s) => s.captureKind === undefined).length
    return { total, withClass, unmarked }
  }, [portfolio.snapshots])

  return (
    <div className="mx-auto w-full max-w-[480px] px-4">
      <header className="pt-4">
        <h1 className="text-[15px] font-medium text-ink">设置</h1>
        <p className="mt-1 text-[11px] text-ink4">数据来源与状态说明</p>
      </header>

      {/* 数据存储 */}
      <section className="mt-3 rounded-2xl border border-line bg-s1 p-4" data-testid="storage-info">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-ink2">
          <Database size={13} /> 数据存储
        </h2>
        <dl className="mt-3 space-y-1.5 text-[12px]">
          <div className="flex justify-between">
            <dt className="text-ink3">业务事实源</dt>
            <dd className="text-ink">IndexedDB（本地）</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">Portfolio Schema</dt>
            <dd className="text-ink" data-testid="schema-version">
              V{PORTFOLIO_SCHEMA_VERSION}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">数据库版本</dt>
            <dd className="text-ink" data-testid="db-version">
              DB v{DB_VERSION}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">账户 / 标的 / 持仓</dt>
            <dd className="text-ink">
              {portfolio.accounts.length} / {portfolio.instruments.length} / {portfolio.holdings.length}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">交易 / 快照</dt>
            <dd className="text-ink">
              {portfolio.transactions.length} / {portfolio.snapshots.length}
            </dd>
          </div>
        </dl>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink4">
          <Lock size={12} className="mt-0.5 shrink-0" />
          <span>
            localStorage 只保存界面偏好（主题、当前 Tab），不再保存任何业务数据。
            <br />
            迁移链：{describeMigrationChain()}
          </span>
        </p>
      </section>

      {/* 完整度 */}
      {/* W7：备份与数据耐久性 */}
      <section className="mt-3 rounded-2xl border border-line bg-s1 p-4" data-testid="storage-info">
        <h2 className="text-[13px] font-medium text-ink">备份与数据保存</h2>
        <dl className="mt-2 space-y-1 text-[12px]">
          <div className="flex justify-between">
            <dt className="text-ink3">持久化存储</dt>
            <dd className="text-right" data-testid="storage-persisted">
              {storage.persisted === true ? (
                <span className="text-ink">已授予</span>
              ) : storage.persisted === false ? (
                <span className="tone-warn">未授予（数据仍可用，但建议定期导出）</span>
              ) : (
                <span className="text-ink4">未知（本浏览器不支持查询）</span>
              )}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">本机占用</dt>
            <dd className="text-ink" data-testid="storage-usage">
              {storage.estimate
                ? `${(storage.estimate.usage / 1024 / 1024).toFixed(2)} MB / 可用 ${(
                    storage.estimate.quota /
                    1024 /
                    1024
                  ).toFixed(0)} MB`
                : '—'}
            </dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={() => setBackupOpen(true)}
          className="mt-3 flex w-full items-center justify-between rounded-2xl border border-line bg-s2 px-4 py-3 text-left text-[13px] text-ink2"
          data-testid="open-backup"
        >
          <span>备份与恢复</span>
          <span className="text-[11px] text-ink4">导出 / 导入</span>
        </button>

        <p className="mt-2 text-[11px] leading-relaxed text-ink4">
          数据只保存在本机浏览器。<span className="text-ink3">浏览器清理站点数据会导致数据丢失</span>，
          且本机是唯一副本 —— 请定期导出备份。
        </p>
      </section>

      {/* W6：行情与汇率覆盖率 —— 让「为什么某项无法估值」一眼可见 */}
      <section className="mt-3 rounded-2xl border border-line bg-s1 p-4" data-testid="market-data-info">
        <h2 className="text-[13px] font-medium text-ink">行情与汇率</h2>
        <p className="mt-1 text-[11px] text-ink4">
          W6 阶段为手动录入，不联网获取行情。
        </p>
        <dl className="mt-2 space-y-1 text-[12px]">
          <div className="flex justify-between">
            <dt className="text-ink3">已有行情</dt>
            <dd className="text-ink" data-testid="market-quote-count">
              {coverage.withQuote} 项
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">缺行情（无法估值）</dt>
            <dd className={coverage.missingQuote > 0 ? 'tone-warn' : 'text-ink'} data-testid="market-missing-quote">
              {coverage.missingQuote} 项
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">缺汇率币种</dt>
            <dd
              className={coverage.missingFxCurrencies.length > 0 ? 'tone-warn' : 'text-ink'}
              data-testid="market-missing-fx"
            >
              {coverage.missingFxCurrencies.length > 0
                ? coverage.missingFxCurrencies.join('、')
                : '无'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">存在过期行情</dt>
            <dd className={coverage.hasStale ? 'tone-warn' : 'text-ink'} data-testid="market-stale">
              {coverage.hasStale ? '是（不计入可靠总额）' : '否'}
            </dd>
          </div>
        </dl>

        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={() => setQuoteOpen(true)}
            className="flex w-full items-center justify-between rounded-2xl border border-line bg-s2 px-4 py-3 text-left text-[13px] text-ink2"
            data-testid="open-quote"
          >
            <span>录入 / 更新行情</span>
            <span className="text-[11px] text-ink4">
              {coverage.missingQuote > 0 ? `${coverage.missingQuote} 项待补` : '按需更新'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFxOpen(true)}
            className="flex w-full items-center justify-between rounded-2xl border border-line bg-s2 px-4 py-3 text-left text-[13px] text-ink2"
            data-testid="open-fx"
          >
            <span>录入 / 更新汇率</span>
            <span className="text-[11px] text-ink4">
              {coverage.missingFxCurrencies.length > 0
                ? `缺 ${coverage.missingFxCurrencies.length} 个币种`
                : '按需更新'}
            </span>
          </button>
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-ink4">
          缺行情或缺失汇率时，该项**保持「无法估值」**，不会按成本、0 或 1:1 折算；
          过期行情也不会进入可靠总资产。
        </p>
      </section>

      <section className="mt-3 rounded-2xl border border-line bg-s1 p-4" data-testid="coverage-info">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-ink2">
          <ShieldCheck size={13} /> 数据完整度
        </h2>
        <dl className="mt-3 space-y-1.5 text-[12px]">
          <div className="flex justify-between">
            <dt className="text-ink3">可靠持仓</dt>
            <dd className="text-ink">
              {analysis.coverage.reliableCount} / {analysis.coverage.totalHoldings}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">无法估值</dt>
            <dd className={analysis.coverage.unavailableCount ? 'tone-warn' : 'text-ink'}>
              {analysis.coverage.unavailableCount} 项
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">估值已过期</dt>
            <dd className={analysis.coverage.staleCount ? 'tone-warn' : 'text-ink'}>
              {analysis.coverage.staleCount} 项
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">分类待确认</dt>
            <dd className={analysis.coverage.unconfirmedCount ? 'tone-warn' : 'text-ink'}>
              {analysis.coverage.unconfirmedCount} 项
            </dd>
          </div>
        </dl>
      </section>

      {/* 数据维护入口 */}
      <section className="mt-3 space-y-2">
        <button
          type="button"
          onClick={() => setAttrOpen(true)}
          className="flex w-full items-center justify-between rounded-2xl border border-line bg-s1 px-4 py-3 text-left text-[13px] text-ink2"
          data-testid="open-attributes"
        >
          <span>
            编辑标的属性
            <span className="ml-1.5 text-[11px] text-ink4">
              （名称 / 代码 / 品类 / 类别）
            </span>
          </span>
          <span className="text-[11px] text-ink4">{portfolio.instruments.length}</span>
        </button>

        <button
          type="button"
          onClick={() => setDupOpen(true)}
          className="flex w-full items-center justify-between rounded-2xl border border-line bg-s1 px-4 py-3 text-left text-[13px] text-ink2"
          data-testid="open-duplicates"
        >
          <span>
            检查重复持仓
            {!duplicates.ok ? (
              <span className="ml-1.5 text-[11px] tone-warn">发现 {duplicates.duplicates.length} 组</span>
            ) : (
              <span className="ml-1.5 text-[11px] text-ink4">未发现</span>
            )}
          </span>
          <span className="text-[11px] text-ink4">{duplicates.ok ? '正常' : '需处理'}</span>
        </button>
      </section>

      {/* 历史数据状态 */}
      <section className="mt-3 rounded-2xl border border-line bg-s1 p-4" data-testid="history-info">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-ink2">
          <Info size={13} /> 历史快照
        </h2>
        <dl className="mt-3 space-y-1.5 text-[12px]">
          <div className="flex justify-between">
            <dt className="text-ink3">快照总数</dt>
            <dd className="text-ink">{historyStats.total}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">含历史分类</dt>
            <dd className="text-ink">{historyStats.withClass}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink3">来源未标记</dt>
            <dd className={historyStats.unmarked ? 'tone-warn' : 'text-ink'}>
              {historyStats.unmarked}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-ink4">
          来源未标记的历史快照按 UNKNOWN 处理，**不会**被当作 REAL。
          缺少历史分类的快照不展示类别占比，也不使用今天的分类回填。
        </p>
      </section>

      <p className="mt-3 flex items-center justify-center gap-1.5 pb-4 text-[11px] text-ink4">
        <RefreshCw size={11} /> 数据仅保存在本机浏览器
      </p>

      {dupOpen ? <DuplicateSheet duplicates={duplicates} onClose={() => setDupOpen(false)} /> : null}

      {quoteOpen ? (
        <QuoteSheet
          open
          onClose={() => setQuoteOpen(false)}
          portfolio={portfolio}
          repo={repo}
          onChanged={onChanged}
        />
      ) : null}

      {backupOpen ? (
        <BackupSheet open onClose={() => setBackupOpen(false)} repo={repo} onChanged={onChanged} />
      ) : null}

      {fxOpen ? (
        <FxSheet
          open
          onClose={() => setFxOpen(false)}
          portfolio={portfolio}
          repo={repo}
          onChanged={onChanged}
        />
      ) : null}
      {attrOpen ? (
        <AttributeKindSheet
          portfolio={portfolio}
          repo={repo}
          onClose={() => setAttrOpen(false)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  )
}
