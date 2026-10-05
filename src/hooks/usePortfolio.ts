import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  AssetItem,
  Category,
  FundItem,
  FundQuote,
  GoldItem,
  HistoryPoint,
  Portfolio,
} from '../types/asset'
import { CATEGORY_COLORS, SCHEMA_VERSION, createDefaultCategories } from '../lib/defaults'
import { collectCurrencies, collectFundCodes, fxExposure, isFund, safeNum, summarize } from '../lib/calc'
/** 允许的行情代码：境内基金 6 位数字，或美股字母 / 港股数字 */
const STOCK_CODE_RE = /^[A-Za-z][A-Za-z.\-]{0,5}$|^\d{1,5}$/
import { loadPortfolio, savePortfolio } from '../lib/storage'
import { ReadOnlyViolationError, isReadOnlyMode, readOnlyMessage } from '../lib/readOnly'
import { getPreloadedLegacyView } from '../lib/db/toLegacyView'
import { describeRates, hasUsableRates, isFxStale, type CurrencyCode, type FxRates } from '../lib/currency'
import type { HoldingMarket } from '../lib/usStock'
import { fetchRates, loadCachedRates } from '../lib/fx'
import { todayKey } from '../lib/format'
import { uid } from '../lib/id'
import { FundServiceError, fetchFundQuotes } from '../lib/fundService'

/* ------------------------------------------------------------------ *
 * Reducer
 * ------------------------------------------------------------------ */

type Action =
  | { type: 'replace'; portfolio: Portfolio }
  | { type: 'addCategory'; category: Category }
  | { type: 'updateCategory'; id: string; patch: Partial<Omit<Category, 'items' | 'id'>> }
  | { type: 'removeCategory'; id: string }
  | { type: 'moveCategory'; id: string; dir: -1 | 1 }
  | { type: 'addItem'; categoryId: string; item: AssetItem }
  | {
      type: 'addFundedItem'
      categoryId: string
      item: AssetItem
      /** 从哪个现金项目扣款 */
      sourceCategoryId: string
      sourceItemId: string
      /** 扣减金额（正数） */
      amount: number
    }
  | { type: 'updateItem'; categoryId: string; itemId: string; item: AssetItem }
  | { type: 'removeItem'; categoryId: string; itemId: string }
  | { type: 'mergeQuotes'; quotes: FundQuote[]; at: number }
  | { type: 'snapshot'; point: HistoryPoint }

function mapCategory(portfolio: Portfolio, id: string, fn: (c: Category) => Category): Portfolio {
  return { ...portfolio, categories: portfolio.categories.map((c) => (c.id === id ? fn(c) : c)) }
}

function reducer(state: Portfolio, action: Action): Portfolio {
  switch (action.type) {
    case 'replace':
      return action.portfolio

    case 'addCategory':
      return { ...state, categories: [...state.categories, action.category] }

    case 'updateCategory':
      return mapCategory(state, action.id, (c) => ({ ...c, ...action.patch }))

    case 'removeCategory':
      return { ...state, categories: state.categories.filter((c) => c.id !== action.id) }

    case 'moveCategory': {
      const idx = state.categories.findIndex((c) => c.id === action.id)
      const target = idx + action.dir
      if (idx < 0 || target < 0 || target >= state.categories.length) return state
      const categories = [...state.categories]
      ;[categories[idx], categories[target]] = [categories[target], categories[idx]]
      return { ...state, categories }
    }

    case 'addItem':
      return mapCategory(state, action.categoryId, (c) => ({ ...c, items: [...c.items, action.item] }))

    case 'addFundedItem': {
      /**
       * 「买入基金 + 从现金扣款」必须是一个原子动作：
       * 分两次 dispatch 时，两次渲染之间会出现「两个项目都还是旧值」的中间态，
       * 刷新够快就可能把中间态写进 localStorage。
       */
      const afterAdd = mapCategory(state, action.categoryId, (c) => ({
        ...c,
        items: [...c.items, action.item],
      }))
      const found = afterAdd.categories
        .find((c) => c.id === action.sourceCategoryId)
        ?.items.some((i) => i.id === action.sourceItemId && i.kind === 'amount')
      if (!found) return afterAdd

      return mapCategory(afterAdd, action.sourceCategoryId, (c) => ({
        ...c,
        items: c.items.map((i) =>
          i.id === action.sourceItemId && i.kind === 'amount'
            ? { ...i, amount: i.amount - action.amount }
            : i,
        ),
      }))
    }

    case 'updateItem':
      return mapCategory(state, action.categoryId, (c) => ({
        ...c,
        items: c.items.map((i) => (i.id === action.itemId ? action.item : i)),
      }))

    case 'removeItem':
      return mapCategory(state, action.categoryId, (c) => ({
        ...c,
        items: c.items.filter((i) => i.id !== action.itemId),
      }))

    case 'mergeQuotes': {
      if (action.quotes.length === 0) return state
      const byCode = new Map<string, FundQuote>()
      for (const q of action.quotes) byCode.set(q.code, q)
      let touched = false
      const categories = state.categories.map((c) => {
        let nextItems: AssetItem[] | null = null
        c.items.forEach((item, i) => {
          if (!isFund(item)) return
          const quote = byCode.get(item.code)
          if (!quote) return
          if (!nextItems) nextItems = [...c.items]
          nextItems[i] = {
            ...item,
            quote,
            // 注意：manualNav 不动 —— 用户手动维护的净值优先，不能被同步覆盖
            // 接口回填的市场写回条目，估值时据此选择币种
            market: quote.market ?? item.market ?? 'cn',
            name: item.manualName ? item.name : quote.name || item.name,
          } as FundItem
          touched = true
        })
        return nextItems ? { ...c, items: nextItems } : c
      })
      return touched ? { ...state, categories, lastSyncedAt: action.at } : { ...state, lastSyncedAt: action.at }
    }

    case 'snapshot': {
      const rest = state.history.filter((h) => h.date !== action.point.date)
      return { ...state, history: [...rest, action.point].slice(-120) }
    }

    default:
      return state
  }
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

export interface SyncState {
  loading: boolean
  lastError?: string
  lastSuccessAt?: number
  /** 最后一次命中的行情通道 */
  source?: string
}

/**
 * 初始数据来源（Phase 8 / W1）
 *
 * 优先使用启动时注入的 2.0 投影结果；没有时回退到 localStorage。
 *
 * 注意 fallback 的理由：迁移失败时**不开启只读**（旧 UI 保持可写），
 * 此时必须继续从 localStorage 读，否则用户会看到空数据却还能编辑。
 */
function resolveInitialLoad() {
  const preloaded = getPreloadedLegacyView()
  if (preloaded) {
    return { portfolio: preloaded, error: null as string | null, recovered: false, addedCategories: undefined }
  }
  return loadPortfolio()
}

const initialLoad = resolveInitialLoad()

/**
 * 组合状态与持久化，并统一负责汇率。
 *
 * 汇率放在这里而不是单独的 hook：汇率要参与汇总与快照，
 * 而汇率又需要「组合里有哪些外币」这一信息，放一起可以避免两个 hook 互相依赖。
 */
export function usePortfolio() {
  const [portfolio, dispatch] = useReducer(reducer, initialLoad.portfolio)
  const [storageError, setStorageError] = useState<string | null>(initialLoad.error ?? null)
  const [recovered, setRecovered] = useState(initialLoad.recovered)
  const [addedCategories] = useState<string[] | undefined>(initialLoad.addedCategories)
  const [sync, setSync] = useState<SyncState>({ loading: false })
  const bootstrapped = useRef(false)
  const inFlight = useRef(false)

  /* ---------- 汇率状态（外币条目折算用） ---------- */
  const [rates, setRates] = useState<FxRates | null>(() => loadCachedRates())
  const [fxLoading, setFxLoading] = useState(false)
  const [fxError, setFxError] = useState<string | undefined>()
  const fxInFlight = useRef(false)

  /*
   * ---------- 持久化：任何变更都写入 localStorage ----------
   *
   * Phase 8 / W1：只读模式下 `savePortfolio` 会抛 `ReadOnlyViolationError`。
   * 这里做**防御性兜底** —— 正常流程下变更函数已在入口拦住（见 `guardMutation`），
   * 不会走到这里。若仍然走到，说明有遗漏的写入路径，必须显式暴露而不是静默。
   */
  useEffect(() => {
    if (isReadOnlyMode()) return
    try {
      const err = savePortfolio(portfolio)
      if (err) setStorageError(err)
    } catch (e) {
      if (e instanceof ReadOnlyViolationError) {
        setStorageError(readOnlyMessage())
        return
      }
      throw e
    }
  }, [portfolio])

  /**
   * 禁止「假成功」的核心守卫。
   *
   * 为什么必须在**变更函数入口**拦截，而不是等持久化 effect 失败：
   * reducer 一旦 dispatch，React state 立刻变成新值，界面看起来「保存成功」了 ——
   * 即使随后 localStorage 写入失败，用户也已经看到假数据。
   *
   * 因此：只读模式下**先拒绝，再不动 state**，并给出明确提示。
   */
  const blockedByReadOnly = useCallback((): boolean => {
    if (!isReadOnlyMode()) return false
    setStorageError(readOnlyMessage())
    return true
  }, [])

  const foreignCurrencies = useMemo(() => collectCurrencies(portfolio), [portfolio])
  const hasForeign = foreignCurrencies.length > 0
  /** 汇率是否可用于折算：人民币组合恒为可用 */
  const fxReady = !hasForeign || hasUsableRates(rates)

  const summary = useMemo(() => summarize(portfolio, rates), [portfolio, rates])
  const exposure = useMemo(() => fxExposure(portfolio, rates), [portfolio, rates])
  const fundCodes = useMemo(() => collectFundCodes(portfolio), [portfolio])

  /** 拉取汇率（缓存未过期时默认跳过） */
  const syncFx = useCallback(async (opts: { force?: boolean; silent?: boolean } = {}) => {
    if (fxInFlight.current) return
    fxInFlight.current = true
    if (!opts.silent) setFxLoading(true)
    try {
      const result = await fetchRates({ force: opts.force, skipIfFresh: !opts.force })
      setRates(result.rates)
      setFxError(result.error)
    } catch (e) {
      setFxError(e instanceof Error ? e.message : '汇率获取失败')
    } finally {
      fxInFlight.current = false
      setFxLoading(false)
    }
  }, [])

  /** 首屏：有外币且汇率过期（>24h）时才联网 */
  useEffect(() => {
    if (!hasForeign) return
    if (hasUsableRates(rates) && !isFxStale(rates)) return
    void syncFx({ silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasForeign])

  /**
   * 汇率就绪标记（内部状态，供自动化测试与线上排查使用）：
   * `data-fx-ready="1"` 表示「有外币且已拿到可用汇率」，外币折算已经准确。
   */
  useEffect(() => {
    const ready = hasForeign && hasUsableRates(rates) && !isFxStale(rates)
    if (ready) document.documentElement.setAttribute('data-fx-ready', '1')
    else document.documentElement.removeAttribute('data-fx-ready')
  }, [hasForeign, rates])

  /** 记录当日净资产快照，用于「较上次」变化提示 */
  const takeSnapshot = useCallback(
    (p: Portfolio) => {
      // 只读模式下月度走势已由 IndexedDB 的 Snapshot 承接，不再写 localStorage
      if (isReadOnlyMode()) return
      const s = summarize(p, rates)
      dispatch({
        type: 'snapshot',
        point: {
          date: todayKey(),
          netWorth: s.netWorth,
          totalAssets: s.totalAssets,
          totalLiabilities: s.totalLiabilities,
          at: Date.now(),
        },
      })
    },
    [rates],
  )

  /** 拉取基金行情并回填 */
  const syncQuotes = useCallback(
    async (codes?: string[], opts: { silent?: boolean } = {}) => {
      const list = (codes ?? fundCodes).filter((c) => /^\d{6}$/.test(c) || STOCK_CODE_RE.test(c))
      if (list.length === 0) return
      if (inFlight.current) return
      inFlight.current = true
      if (!opts.silent) setSync((s) => ({ ...s, loading: true, lastError: undefined }))
      try {
        const map = await fetchFundQuotes(list)
        const quotes: FundQuote[] = []
        let source: string | undefined
        for (const [code, hit] of map) {
          quotes.push(hit.quote)
          if (code === list[0]) source = hit.source
        }
        dispatch({ type: 'mergeQuotes', quotes, at: Date.now() })
        setSync({ loading: false, lastSuccessAt: Date.now(), source })
      } catch (e) {
        const msg =
          e instanceof FundServiceError
            ? `${e.message}${e.attempts.length ? `（${e.attempts.map((a) => a.error).join('；')}）` : ''}`
            : e instanceof Error
              ? e.message
              : '行情同步失败'
        setSync({ loading: false, lastError: msg })
      } finally {
        inFlight.current = false
      }
    },
    [fundCodes],
  )

  /* ---------- 启动：首屏自动同步一次（有基金时） ---------- */
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    if (fundCodes.length > 0) void syncQuotes(fundCodes, { silent: true })
    // 仅在首次挂载运行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------- 每 5 分钟静默刷新（页面可见时） ---------- */
  useEffect(() => {
    if (fundCodes.length === 0) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void syncQuotes(fundCodes, { silent: true })
    }, 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [fundCodes, syncQuotes])

  /** 记录快照（净资产变化时）。汇率未就绪时跳过，避免把未折算的数字写进历史 */
  useEffect(() => {
    // 只读模式下月度走势已由 IndexedDB 的 Snapshot 承接，不再写 localStorage
    if (isReadOnlyMode()) return
    // 汇率未就绪时写入的快照会把外币按原币数值记账，等折算完成再写
    if (!fxReady) return
    const timer = window.setTimeout(() => takeSnapshot(portfolio), 1200)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.netWorth, fxReady])

  /* ---------- 分类操作 ---------- */
  const addCategory = useCallback((patch?: Partial<Category>) => {
    if (blockedByReadOnly()) return null
    const category: Category = {
      id: uid('cat'),
      name: patch?.name?.trim() || '新分类',
      subtitle: patch?.subtitle ?? '',
      icon: patch?.icon ?? 'wallet',
      color: patch?.color ?? CATEGORY_COLORS[Math.floor(Math.random() * CATEGORY_COLORS.length)],
      isLiability: patch?.isLiability ?? false,
      items: [],
    }
    dispatch({ type: 'addCategory', category })
    return category.id
  }, [blockedByReadOnly])

  const updateCategory = useCallback(
    (id: string, patch: Partial<Omit<Category, 'items' | 'id'>>) => {
      if (blockedByReadOnly()) return
      dispatch({ type: 'updateCategory', id, patch })
    },
    [blockedByReadOnly],
  )
  const removeCategory = useCallback(
    (id: string) => {
      if (blockedByReadOnly()) return
      dispatch({ type: 'removeCategory', id })
    },
    [blockedByReadOnly],
  )
  const moveCategory = useCallback(
    (id: string, dir: -1 | 1) => {
      if (blockedByReadOnly()) return
      dispatch({ type: 'moveCategory', id, dir })
    },
    [blockedByReadOnly],
  )

  /* ---------- 条目操作 ---------- */
  const addItem = useCallback(
    (categoryId: string, item: AssetItem) => {
      if (blockedByReadOnly()) return
      dispatch({ type: 'addItem', categoryId, item })
    },
    [blockedByReadOnly],
  )

  /**
   * 新增条目并同时从某个现金项目扣款。
   * 用于「买入基金时从现金划拨」：基金 +X，现金 −X，净资产不变。
   */
  const addFundedItem = useCallback(
    (categoryId: string, item: AssetItem, sourceCategoryId: string, sourceItemId: string, amount: number) => {
      if (blockedByReadOnly()) return
      dispatch({ type: 'addFundedItem', categoryId, item, sourceCategoryId, sourceItemId, amount })
    },
    [blockedByReadOnly],
  )
  const updateItem = useCallback(
    (categoryId: string, item: AssetItem) => {
      if (blockedByReadOnly()) return
      dispatch({ type: 'updateItem', categoryId, itemId: item.id, item })
    },
    [blockedByReadOnly],
  )
  const removeItem = useCallback(
    (categoryId: string, itemId: string) => {
      if (blockedByReadOnly()) return
      dispatch({ type: 'removeItem', categoryId, itemId })
    },
    [blockedByReadOnly],
  )

  /** 清空全部数据，恢复默认分类 */
  const resetAll = useCallback(() => {
    if (blockedByReadOnly()) return
    dispatch({
      type: 'replace',
      portfolio: { version: SCHEMA_VERSION, categories: createDefaultCategories(), history: [] },
    })
    setRecovered(false)
  }, [])

  const importPortfolio = useCallback(
    (p: Portfolio) => {
      if (blockedByReadOnly()) return
      dispatch({ type: 'replace', portfolio: p })
    },
    [blockedByReadOnly],
  )

  return {
    portfolio,
    summary,
    /** 外币敞口统计（条数 / 未折算条数 / 各币种原币合计） */
    exposure,
    fundCodes,
    /** 汇率状态：供界面标注来源与日期 */
    fx: {
      rates,
      loading: fxLoading,
      stale: isFxStale(rates),
      ready: fxReady,
      error: fxError,
      hasForeign,
      currencies: foreignCurrencies,
      sourceLabel: hasUsableRates(rates) ? describeRates(rates) : '暂无汇率',
      sync: syncFx,
    },
    sync,
    storageError,
    recovered,
    /** 版本升级时自动补上的内置分类（如「国债」） */
    addedCategories,
    dismissRecovered: () => setRecovered(false),
    syncQuotes,
    addCategory,
    updateCategory,
    removeCategory,
    moveCategory,
    addItem,
    addFundedItem,
    updateItem,
    removeItem,
    resetAll,
    importPortfolio,
  }
}

/** 表单提交时构造条目；金额与份额的数值解析在表单层完成 */
export function makeAmountItem(input: {
  /** 编辑时必须传入原 id：reducer 按 id 匹配，传新 id 会导致「保存了但没改」 */
  id?: string
  name: string
  note?: string
  amount: number
  currency?: CurrencyCode
}): AssetItem {
  return {
    id: input.id ?? uid('item'),
    kind: 'amount',
    name: input.name,
    note: input.note,
    amount: safeNum(input.amount),
    // 人民币是默认值，不落库，保持数据干净
    currency: input.currency && input.currency !== 'CNY' ? input.currency : undefined,
  }
}

export function makeFundItem(input: {
  id?: string
  name?: string
  code: string
  /** 市场：决定计价币种（境内 CNY / 美股 USD / 港股 HKD） */
  market?: HoldingMarket
  shares: number
  costNav: number
  /** 手动净值：填了优先使用，留空走自动同步 */
  manualNav?: number
  note?: string
  quote?: FundQuote
}): FundItem {
  return {
    id: input.id ?? uid('fund'),
    kind: 'fund',
    name: input.name?.trim() || input.code,
    note: input.note,
    code: input.code,
    market: input.market ?? 'cn',
    shares: safeNum(input.shares),
    costNav: safeNum(input.costNav),
    manualNav:
      typeof input.manualNav === 'number' && Number.isFinite(input.manualNav) && input.manualNav > 0
        ? input.manualNav
        : undefined,
    quote: input.quote,
  }
}

export function makeGoldItem(input: {
  id?: string
  name: string
  grams: number
  pricePerGram: number
  note?: string
  currency?: CurrencyCode
}): GoldItem {
  return {
    id: input.id ?? uid('gold'),
    kind: 'gold',
    name: input.name,
    note: input.note,
    grams: safeNum(input.grams),
    pricePerGram: safeNum(input.pricePerGram),
    currency: input.currency && input.currency !== 'CNY' ? input.currency : undefined,
  }
}
