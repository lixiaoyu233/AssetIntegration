import type { AnalysisView } from '../lib/analysis'
import type { DuplicateReport } from '../lib/ledger/duplicates'
import {
  ACCOUNT_TYPE_LABEL,
  ASSET_CLASS_LABEL,
  INSTRUMENT_TYPE_LABEL,
  REGION_LABEL,
} from '../lib/analysis/dimensions'

/**
 * 分析 Tab（只读）
 *
 * 直接展示 Phase 6 已验收的 `AnalysisView` 六个维度。
 *
 * ## 保持 Phase 6 的完整性规则
 *
 * - 分母是 `reliableValueCny`（可靠部分），**不是**任何「理论总额」
 * - `unavailable` / `stale` 不计入金额，只计数
 * - 每个维度都必须能看到缺口，不允许只显示占比
 */
export interface AnalysisTabProps {
  analysis: AnalysisView
  duplicates: DuplicateReport
}

const cny = (n: number) =>
  `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const DIMENSION_TITLE: Record<string, string> = {
  byAssetClass: '资产类别',
  byAccount: '账户',
  byAccountType: '账户类型',
  byCurrency: '币种',
  byRegion: '地区',
  byInstrumentType: '投资品种',
}

export default function AnalysisTab({ analysis, duplicates }: AnalysisTabProps) {
  const cov = analysis.coverage

  const dimensions = [
    { key: 'byAssetClass', buckets: analysis.byAssetClass },
    { key: 'byAccount', buckets: analysis.byAccount },
    { key: 'byAccountType', buckets: analysis.byAccountType },
    { key: 'byCurrency', buckets: analysis.byCurrency },
    { key: 'byRegion', buckets: analysis.byRegion },
    { key: 'byInstrumentType', buckets: analysis.byInstrumentType },
  ] as const

  return (
    <div className="mx-auto w-full max-w-[480px] px-4">
      <header className="pt-4">
        <h1 className="text-[15px] font-medium text-ink">资产分析</h1>
        <p className="mt-1 text-[11px] text-ink4" data-testid="analysis-total">
          可靠金额基准 {cny(analysis.reliableValueCny)} · {cov.reliableCount}/{cov.totalHoldings} 项
        </p>
      </header>

      {/* 缺口汇总：分析结论的可信度前提 */}
      {!cov.isComplete || cov.unconfirmedCount > 0 ? (
        <section
          className="mt-3 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] tone-warn"
          data-testid="analysis-gaps"
        >
          <p className="font-medium">数据存在缺口，占比仅覆盖可靠部分</p>
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {cov.unavailableCount > 0 ? <li>· {cov.unavailableCount} 项无法估值（未计入）</li> : null}
            {cov.staleCount > 0 ? <li>· {cov.staleCount} 项估值已过期（未计入）</li> : null}
            {cov.unconfirmedCount > 0 ? <li>· {cov.unconfirmedCount} 项分类待确认（已计入金额）</li> : null}
          </ul>
        </section>
      ) : null}

      {!duplicates.ok ? (
        <section
          className="mt-3 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[11px] tone-warn"
          data-testid="analysis-duplicates"
        >
          {duplicates.summary}
        </section>
      ) : null}

      {dimensions.map(({ key, buckets }) => (
        <section
          key={key}
          className="mt-3 rounded-2xl border border-line bg-s1 p-4"
          data-testid={`dim-card-${key}`}
        >
          <h2 className="text-[13px] font-medium text-ink2">{DIMENSION_TITLE[key]}</h2>
          {buckets.length === 0 ? (
            <p className="mt-2 text-[12px] text-ink4">暂无数据</p>
          ) : (
            <ul className="mt-2.5 space-y-2">
              {buckets.map((b) => (
                <li key={b.key} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-ink2">{b.label}</span>
                    <span className="text-ink">{cny(b.valueCny)}</span>
                    <span className="w-12 shrink-0 text-right text-ink3">
                      {b.share === undefined ? '—' : `${(b.share * 100).toFixed(1)}%`}
                    </span>
                  </div>
                  {/* 币种维度：原币与折算分开，不同币种绝不相加 */}
                  {b.nativeTotal !== undefined ? (
                    <p className="mt-0.5 text-[11px] text-ink4">
                      原币 {b.nativeTotal.toLocaleString('zh-CN')} {b.nativeCurrency}
                      {b.fxMissing ? ' · ⚠️ 缺汇率未折算' : ''}
                    </p>
                  ) : null}
                  {!b.isComplete ? (
                    <p className="mt-0.5 text-[11px] tone-warn">
                      {b.unavailableCount > 0 ? `${b.unavailableCount} 项无法估值 ` : ''}
                      {b.staleCount > 0 ? `${b.staleCount} 项已过期 ` : ''}
                      未计入金额
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <p className="mt-3 px-1 pb-4 text-[11px] leading-relaxed text-ink4">
        地区维度使用账户属地（Account.region）；不根据证券名称、代码或关键词推测地区与分类。
        标签映射：
        {Object.values(ASSET_CLASS_LABEL).slice(0, 3).join(' / ')} … ·
        {Object.values(REGION_LABEL).slice(0, 2).join(' / ')} … ·
        {Object.values(INSTRUMENT_TYPE_LABEL).slice(0, 3).join(' / ')} … ·
        {Object.values(ACCOUNT_TYPE_LABEL).slice(0, 2).join(' / ')} …
      </p>
    </div>
  )
}
