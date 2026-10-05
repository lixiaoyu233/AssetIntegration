import { useMemo, useState } from 'react'
import { Home, Layers } from 'lucide-react'
import { usePortfolio2 } from '../hooks/usePortfolio2'
import { createDexieRepository } from '../lib/db/dexieRepository'
import HomePage from './HomePage'
import AssetsPage from './AssetsPage'

/**
 * W2 应用外壳（`?w2=1`）
 *
 * ## 为什么用查询参数而不是直接替换旧 UI
 *
 * W1 结束时旧 UI 处于「只读可用」状态，且部分回归套件仍依赖它。
 * W2 的目标是**建立新版只读视图**，不是替换 —— 替换属于 W3。
 * 因此新页面挂在 `?w2=1` 下，旧 UI 保持原样，两者互不干扰。
 *
 * ## 数据链路
 *
 * ```
 * Repository → Holdings → Valuation → Analysis → Snapshot/History → usePortfolio2 → 本外壳 → 页面
 * ```
 *
 * 页面组件**只接收派生结果**，不自行计算金融事实。
 */
export type W2Tab = 'home' | 'assets'

export default function App2({ initialTab = 'home' }: { initialTab?: W2Tab }) {
  const [tab, setTab] = useState<W2Tab>(initialTab)
  const repo = useMemo(() => createDexieRepository(), [])
  const { data, loading, error, daily, reload } = usePortfolio2(repo)

  return (
    <div className="min-h-screen bg-app">
      <div className="safe-top">
        {error ? (
          <div className="mx-auto max-w-[480px] px-4 pt-4 text-[12px] tone-warn">
            读取数据失败：{error}
          </div>
        ) : null}

        {tab === 'home' ? (
          data ? (
            <HomePage
              totals={data.totals}
              analysis={data.analysis}
              duplicates={data.duplicates}
              daily={daily}
              loadedAt={data.loadedAt}
              loading={loading}
              error={error}
              onReload={() => void reload()}
            />
          ) : (
            <p className="mx-auto max-w-[480px] px-4 pt-8 text-[12px] text-ink4">
              {loading ? '正在读取数据…' : '暂无数据'}
            </p>
          )
        ) : data ? (
          <AssetsPage
            portfolio={data.portfolio}
            analysis={data.analysis}
            results={data.results}
            repo={repo}
            onChanged={() => void reload()}
          />
        ) : (
          <p className="mx-auto max-w-[480px] px-4 pt-8 text-[12px] text-ink4">
            {loading ? '正在读取数据…' : '暂无数据'}
          </p>
        )}
      </div>

      {/* 底部导航 */}
      <nav
        className="fixed inset-x-0 bottom-0 border-t border-line bg-s1"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        data-testid="bottom-nav"
      >
        <div className="mx-auto flex max-w-[480px]">
          {(
            [
              ['home', '首页', Home],
              ['assets', '资产管理', Layers],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${
                tab === key ? 'text-ink' : 'text-ink4'
              }`}
              data-testid={`nav-${key}`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
