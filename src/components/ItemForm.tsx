import { useEffect, useMemo, useRef, useState } from 'react'
import { Calculator, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { AssetItem, Category, FundQuote } from '../types/asset'
import { CURRENCIES, type CurrencyCode, type FxRates, isCurrencyCode, scaleHint, toCny } from '../lib/currency'
import { defaultItemKind, isFund, isGold, parseAmount } from '../lib/calc'
import { HOLDING_MARKET_CURRENCY, detectStockMarket } from '../lib/usStock'
import type { CashCandidate, FundingSource } from '../lib/settings'
import { findCandidate } from '../lib/settings'
import { formatCNY, formatNav, formatRate, formatSigned } from '../lib/format'
import { makeAmountItem, makeFundItem, makeGoldItem } from '../hooks/usePortfolio'
import { fetchFundQuotes } from '../lib/fundService'
import NumberPad from './NumberPad'

interface ItemFormProps {
  category: Category
  /** 汇率：外币录入时实时预览折算金额 */
  rates?: FxRates | null
  /** 可作为资金划拨来源的项目（金额类、余额为正） */
  cashCandidates?: CashCandidate[]
  /** 基金申购默认方式（来自设置） */
  fundDefault?: { useFunding: boolean; lastFundingSource?: FundingSource }
  /** 记住本次选择的资金来源，下次自动带出 */
  onRememberFunding?: (source: FundingSource | undefined) => void
  /** 带资金划拨的提交：由上层在同一动作里完成「基金 +X / 现金 −X」 */
  onSubmitFunded?: (item: AssetItem, source: FundingSource, amount: number) => void
  /** 传入表示编辑，不传表示新增 */
  initial?: AssetItem
  onSubmit: (item: AssetItem) => void
  onDelete?: () => void
  onCancel: () => void
}

type PickerField = 'amount' | 'shares' | 'costNav' | 'grams' | 'pricePerGram' | null

interface FieldMeta {
  label: string
  unit?: string
  quick?: Array<{ label: string; value: string }>
}

/**
 * 分类定制提示词。
 * 按「分类 id 优先、其次分类名关键词」匹配，让提示更贴近真实场景：
 * 银行类给招商银行/支付宝，股票类给指数名，国债类给中美国债。
 */
const HINT_PRESETS: Array<{
  match: (categoryId: string, categoryName: string) => boolean
  name: string
  note: string
  currencyHint?: string
}> = [
  {
    match: (id, n) => id === 'cat_cash' || /现金|存款|银行|固定资产/.test(n),
    name: '招商银行 / 支付宝 / 微信零钱 / 自住房',
    note: '工资卡 / 余额宝 / 活期',
  },
  {
    match: (id, n) => id === 'cat_stock' || /股票|证券/.test(n),
    name: '中证A500 / 标普500 / 纳指100 / 贵州茅台',
    note: '场内ETF / 券商账户',
  },
  {
    match: (id, n) => id === 'cat_fund' || /基金/.test(n),
    name: '招商中证白酒 / 易方达蓝筹',
    note: '定投 / 场外',
  },
  {
    match: (id, n) => id === 'cat_gold' || /黄金|贵金属/.test(n),
    name: '工行积存金 / 支付宝黄金 / 周大福',
    note: '银行积存 / 实物金',
  },
  {
    match: (id, n) => id === 'cat_bond' || /国债|债券/.test(n),
    name: '中国10年期国债 / 美国10年期国债',
    note: '储蓄国债 / 记账式',
  },
  {
    match: (id, n) => id === 'cat_debt' || /负债|贷款|信用卡/.test(n),
    name: '招行房贷 / 信用卡账单 / 花呗',
    note: '等额本息 / 剩余本金',
  },
]

const FIELD_META: Record<Exclude<PickerField, null>, FieldMeta> = {
  amount: {
    label: '金额',
    unit: '元',
    quick: [
      { label: '1千', value: '1000' },
      { label: '1万', value: '10000' },
      { label: '5万', value: '50000' },
      { label: '10万', value: '100000' },
      { label: '50万', value: '500000' },
      { label: '100万', value: '1000000' },
    ],
  },
  shares: { label: '持有份额', unit: '份' },
  costNav: { label: '成本单价', unit: '元/份' },
  grams: {
    label: '持有克数',
    unit: '克',
    quick: [
      { label: '10克', value: '10' },
      { label: '20克', value: '20' },
      { label: '50克', value: '50' },
      { label: '100克', value: '100' },
    ],
  },
  pricePerGram: {
    label: '计价单价',
    unit: '元/克',
    quick: [
      { label: '550', value: '550' },
      { label: '600', value: '600' },
      { label: '650', value: '650' },
      { label: '700', value: '700' },
    ],
  },
}

export default function ItemForm({
  category,
  rates,
  initial,
  cashCandidates = [],
  fundDefault,
  onRememberFunding,
  onSubmitFunded,
  onSubmit,
  onDelete,
  onCancel,
}: ItemFormProps) {
  const editing = Boolean(initial)
  // 编辑时沿用原形态；新增时按分类推断（空分类也能正确给出基金/黄金表单）
  const [kind, setKind] = useState<AssetItem['kind']>(() => initial?.kind ?? defaultItemKind(category))
  /**
   * 是否允许在同一个分类里切换「金额 / 持仓」。
   * 「股票」分类最典型：既能直接记一笔金额，也能登记美股/港股持仓自动同步。
   */
  /**
   * 允许切换「直接记金额 / 持仓」的分类：
   * 股票（美股/港股）与基金都支持 —— 有些人只想记个总额，不想填代码。
   */
  const canPickKind = !editing && /股票|证券|基金/.test(category.name)

  const [name, setName] = useState(initial?.name ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const [amount, setAmount] = useState(initial && !isFund(initial) && !isGold(initial) ? String(initial.amount ?? '') : '')
  const [code, setCode] = useState(initial && isFund(initial) ? initial.code : '')
  const [shares, setShares] = useState(initial && isFund(initial) ? String(initial.shares ?? '') : '')
  const [costNav, setCostNav] = useState(initial && isFund(initial) ? String(initial.costNav ?? '') : '')
  // 手动净值：接口拉不到数据时的兜底
  const [manualNav, setManualNav] = useState(
    initial && isFund(initial) && typeof initial.manualNav === 'number' ? String(initial.manualNav) : '',
  )
  const [grams, setGrams] = useState(initial && isGold(initial) ? String(initial.grams ?? '') : '')
  const [pricePerGram, setPricePerGram] = useState(initial && isGold(initial) ? String(initial.pricePerGram ?? '') : '')

  const [currency, setCurrency] = useState<CurrencyCode>(() => {
    if (initial && !isFund(initial)) {
      const c = (initial as { currency?: string }).currency
      if (isCurrencyCode(c)) return c
    }
    return 'CNY'
  })
  /**
   * 资金划拨：新增基金持仓时可以从某个现金项目扣款，
   * 这样基金 +X、现金 −X，净资产不变。
   * 只在「新增」时提供——编辑旧条目再补划拨会让对账变复杂。
   */
  const [useFunding, setUseFunding] = useState(false)
  const [fundingSourceId, setFundingSourceId] = useState<string>(
    fundDefault?.lastFundingSource?.itemId ?? '',
  )
  const [picker, setPicker] = useState<PickerField>(null)
  const [error, setError] = useState<string | null>(null)
  const [quote, setQuote] = useState<FundQuote | undefined>(initial && isFund(initial) ? initial.quote : undefined)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  /** 记录查失败的代码，避免自动重试打爆接口 */
  const failedCodeRef = useRef<string>('')
  const nameTouched = useRef(false)

  const isFundKind = kind === 'fund'
  const isGoldKind = kind === 'gold'
  /** 非纯基金分类时，代码可以是美股/港股 */
  const allowStockCode = !/基金/.test(category.name)
  /** 根据已输入的代码推断市场（美股/港股），用于币种提示与校验 */
  const detectedMarket = allowStockCode ? detectStockMarket(code) : isFundKind ? 'cn' : null
  /** 用户是否填了手动净值 */
  const manualNavValue = (() => {
    const m = parseAmount(manualNav)
    return Number.isFinite(m) && m > 0 ? m : null
  })()

  // 提示词：命中预设用预设，自定义分类给通用示例
  const preset = HINT_PRESETS.find((h) => h.match(category.id, category.name))
  const namePlaceholder = isFundKind
    ? '留空则自动使用基金全称'
    : preset
      ? `如 ${preset.name}`
      : isGoldKind
        ? '如 工行积存金'
        : '如 名称（可写机构或产品）'
  const notePlaceholder = preset ? `如 ${preset.note}` : '如 备注信息'

  /* ---------------- 基金代码变化：自动查询一次名称与净值 ---------------- */
  const validCode = /^\d{6}$/.test(code)

  const loadQuote = async (silent = false) => {
    const ok = allowStockCode ? code.trim().length >= 2 : validCode
    if (!ok) {
      if (!silent) setQuoteError(allowStockCode ? '请输入基金代码或美股/港股代码' : '请输入 6 位基金代码')
      return
    }
    setQuoteLoading(true)
    setQuoteError(null)
    try {
      const map = await fetchFundQuotes([code])
      const hit = map.get(code)
      if (!hit) {
        /**
         * 接口对不存在的代码会返回 `Datas: null`（HTTP 200），
         * 即「所有通道都成功但没数据」，不会抛错。这里必须显式判断，
         * 否则界面上既不报错也没有结果，用户会以为卡住了。
         */
        failedCodeRef.current = code.trim()
        setQuoteError(`未查询到代码 ${code}，可在下方手动填写当前净值`)
      } else {
        failedCodeRef.current = ''
        setQuote(hit.quote)
        if (!nameTouched.current && !name.trim() && hit.quote.name) {
          setName(hit.quote.name)
        }
      }
    } catch (e) {
      failedCodeRef.current = code.trim()
      setQuoteError(e instanceof Error ? e.message : '查询失败')
      // 用户可见的兜底建议由下方「手动净值」输入框承担，这里不再堆叠开发者措辞
    } finally {
      setQuoteLoading(false)
    }
  }

  useEffect(() => {
    // 境内基金要求 6 位数字；股票分类接受美股/港股代码
    const ready = allowStockCode ? code.trim().length >= 2 : validCode
    // 已手动填净值时不再自动查询，尊重用户输入
    if (!isFundKind || !ready || editing || manualNavValue) return
    const timer = window.setTimeout(() => void loadQuote(true), 600)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, isFundKind, manualNavValue])

  /* ---------------- 实时预览 ---------------- */
  const preview = useMemo(() => {
    if (isFundKind) {
      const s = parseAmount(shares)
      const c = parseAmount(costNav)
      if (!Number.isFinite(s) || s <= 0) return null
      const cost = s * (Number.isFinite(c) ? c : 0)
      const nav = quote?.estimatedNav ?? quote?.publishedNav
      if (nav === undefined) return { cost, value: cost, profit: 0, rate: 0, nav: undefined as number | undefined }
      const value = s * nav
      return { cost, value, profit: value - cost, rate: cost > 0 ? (value - cost) / cost : 0, nav }
    }
    if (isGoldKind) {
      const g = parseAmount(grams)
      const p = parseAmount(pricePerGram)
      if (!Number.isFinite(g) || !Number.isFinite(p)) return null
      return { cost: g * p, value: g * p, profit: 0, rate: 0, nav: undefined as number | undefined }
    }
    return null
  }, [isFundKind, isGoldKind, shares, costNav, quote, grams, pricePerGram])

  /* ---------------- 提交 ---------------- */
  const submit = () => {
    setError(null)

    if (isFundKind) {
      // 境内基金要求 6 位数字；股票分类允许美股（SPY）与港股（00700）
      const isMarketCode = allowStockCode && detectStockMarket(code) !== null
      // 手动填了净值就允许没有代码（例如买了查不到的自营/银行理财）
      if (!manualNavValue && !validCode && !isMarketCode) {
        return setError(
          allowStockCode
            ? '代码格式不对：境内基金填 6 位数字，美股/美股ETF 填字母代码（如 SPY、QQQ），港股填数字（如 00700）'
            : '基金代码必须是 6 位数字',
        )
      }
      const s = parseAmount(shares)
      if (!Number.isFinite(s) || s <= 0) return setError('持有份额必须大于 0')
      const c = parseAmount(costNav)
      if (!Number.isFinite(c) || c < 0) return setError('成本单价不能为空或负数')
      const item = makeFundItem({
        id: initial?.id,
        // 用户没填名称、且自动查询还没回来时，退回基金全称 / 代码，避免出现无名条目
        name: name.trim() || quote?.name || code || '未命名持仓',
        code,
        // 记录市场：决定计价币种（境内 CNY / 美股 USD / 港股 HKD）
        market: quote?.market ?? detectedMarket ?? 'cn',
        shares: s,
        costNav: c,
        manualNav: manualNavValue ?? undefined,
        note: note.trim() || undefined,
        quote,
      })
      // 只有用户真正手填过名称时才锁定，否则允许后续同步用接口全称补全
      item.manualName = nameTouched.current && Boolean(name.trim())
      // 从现金划拨：金额取「份额 × 成本单价」折算后的人民币，作为扣款额
      const costCny = toCny(s * c, HOLDING_MARKET_CURRENCY[item.market ?? 'cn'] ?? 'CNY', rates)
      const deduct = costCny === undefined ? s * c : costCny
      if (useFunding) {
        if (!fundingSource) {
          setError('请选择要扣款的现金项目，或关闭「从现有项目划拨」')
          return
        }
        const cand = cashCandidates.find((x) => x.itemId === fundingSource.itemId)
        if (!cand || cand.amount < deduct) {
          setError(`「${fundingSource.itemName}」余额不足（可用 ${formatCNY(cand?.amount ?? 0)} 元，需 ${formatCNY(deduct)} 元）`)
          return
        }
        onRememberFunding?.(fundingSource)
        const funded = { ...item, fundedFrom: { ...fundingSource, amount: deduct } }
        // 有专门的处理函数时走它（能原子地同时改两处），否则退回普通提交
        if (onSubmitFunded) return onSubmitFunded(funded, fundingSource, deduct)
        return onSubmit(funded)
      }
      onRememberFunding?.(undefined)
      return onSubmit(item)
    }

    if (isGoldKind) {
      const g = parseAmount(grams)
      if (!Number.isFinite(g) || g <= 0) return setError('持有克数必须大于 0')
      const p = parseAmount(pricePerGram)
      if (!Number.isFinite(p) || p <= 0) return setError('计价单价必须大于 0')
      return onSubmit(
        makeGoldItem({
          id: initial?.id,
          name: name.trim() || '黄金持仓',
          grams: g,
          pricePerGram: p,
          note: note.trim() || undefined,
          currency,
        }),
      )
    }

    const a = parseAmount(amount)
    if (!Number.isFinite(a)) return setError('请输入有效金额')
    if (a === 0) return setError('金额不能为 0')
    return onSubmit(
      makeAmountItem({
        // 编辑时复用原 id，否则更新会匹配不到目标条目
        id: initial?.id,
        name: name.trim() || '未命名',
        note: note.trim() || undefined,
        amount: a,
        currency,
      }),
    )
  }

  const nameLabel = isFundKind ? '基金名称（可自定义）' : isGoldKind ? '名称' : '名称'

  const numberField = (
    field: Exclude<PickerField, null>,
    value: string,
    onChange: (v: string) => void,
  ) => {
    const meta = FIELD_META[field]
    const parsed = parseAmount(value)
    const hint = Number.isFinite(parsed) ? scaleHint(parsed) : null
    /** 金额 / 克数 / 单价这三个字段是「原币金额」，展示量级与折算预览 */
    const showScale = field === 'amount' || field === 'grams' || field === 'pricePerGram'
    return (
      <div>
        <label className="field-label">
          {field === 'costNav' && detectedMarket && detectedMarket !== 'cn' ? '成本单价（原币）' : meta.label}
        </label>
        <div className="relative">
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="field-input pr-16 text-[17px] font-medium tabular-nums"
          />
          <button
            type="button"
            onClick={() => setPicker(field)}
            aria-label={`打开数字键盘输入${meta.label}`}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg border border-line bg-s3 p-2 text-ink3 transition hover:text-ink1"
          >
            <Calculator size={15} />
          </button>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink4">
          {meta.unit ? <span>单位：{field === 'costNav' && detectedMarket ? (detectedMarket === 'us' ? 'USD/股' : detectedMarket === 'hk' ? 'HKD/股' : meta.unit) : meta.unit}</span> : null}
          {/* 量级提示：让用户一眼看出「最大那位是万还是十万」 */}
          {showScale && hint && hint.label !== '元' ? (
            <span className="rounded-full border border-line px-1.5 py-0.5 text-ink3">
              {hint.label}位
            </span>
          ) : null}
        </div>
      </div>
    )
  }

  /** 当前选中的资金来源（需校验仍然存在且余额充足） */
  const fundingSource: FundingSource | undefined = (() => {
    if (!useFunding) return undefined
    const hit = findCandidate(cashCandidates, { categoryId: '', itemId: fundingSourceId, itemName: '' } as FundingSource)
      ?? cashCandidates.find((c) => c.itemId === fundingSourceId)
    return hit ? { categoryId: hit.categoryId, itemId: hit.itemId, itemName: hit.itemName } : undefined
  })()

  /** 外币录入时的折算预览（人民币） */
  const convertedPreview = (() => {
    if (currency === 'CNY') return null
    const source = isFundKind ? null : isGoldKind ? grams : amount
    if (source === null) return null
    const parsed = parseAmount(source)
    if (!Number.isFinite(parsed)) return null
    const cny = toCny(parsed, currency, rates)
    return { cny, missing: cny === undefined }
  })()

  /** 本次买入成本（人民币），用于划拨金额提示 */
  const costPreview = (() => {
    const sh = parseAmount(shares)
    const c = parseAmount(costNav)
    if (!Number.isFinite(sh) || sh <= 0 || !Number.isFinite(c) || c < 0) return null
    const market = detectedMarket ?? 'cn'
    const cny = toCny(sh * c, HOLDING_MARKET_CURRENCY[market] ?? 'CNY', rates)
    return cny === undefined ? sh * c : cny
  })()

  const pickerValue = (field: PickerField) => {
    switch (field) {
      case 'amount':
        return amount
      case 'shares':
        return shares
      case 'costNav':
        return costNav
      case 'grams':
        return grams
      case 'pricePerGram':
        return pricePerGram
      default:
        return ''
    }
  }
  const setPickerValue = (field: PickerField, v: string) => {
    switch (field) {
      case 'amount':
        return setAmount(v)
      case 'shares':
        return setShares(v)
      case 'costNav':
        return setCostNav(v)
      case 'grams':
        return setGrams(v)
      case 'pricePerGram':
        return setPricePerGram(v)
    }
  }

  return (
    <div className="space-y-3.5">
      {/*
        「股票」这类分类既可以直接记一笔金额，也可以登记美股/港股持仓。
        不给切换的话，用户会以为这里只能填金额。
      */}
      {canPickKind ? (
        <div>
          <p className="field-label">记录方式</p>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-s2 p-1">
            {(
              [
                ['amount', '直接记金额'],
                ['fund', '持仓（自动同步行情）'],
              ] as Array<[AssetItem['kind'], string]>
            ).map(([k, labelText]) => (
              <button
                key={k}
                type="button"
                data-testid={`kind-${k}`}
                onClick={() => setKind(k)}
                className={`rounded-lg py-2 text-[12.5px] transition ${
                  kind === k ? 'bg-invert text-on-invert' : 'text-ink3 hover:text-ink1'
                }`}
              >
                {labelText}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {isFundKind ? (
        <div>
          <label className="field-label" htmlFor="fund-code">
            {allowStockCode ? '代码（基金 6 位数字 / 美股字母 / 港股数字）' : '基金代码（6 位数字，填完自动查净值）'}
          </label>
          <div className="flex gap-2">
            <input
              id="fund-code"
              data-testid="fund-code"
              value={code}
              onChange={(e) =>
                setCode((() => {
                  const raw = e.target.value
                  // 境内基金分类只允许数字；股票分类允许字母与 . -
                  if (!allowStockCode) return raw.replace(/\D/g, '').slice(0, 6)
                  const cleaned = raw.replace(/[^A-Za-z0-9.\-]/g, '')
                  // 纯数字按港股/境内基金处理，最长 6 位；字母代码转大写，最长 6 位
                  return /^\d*$/.test(cleaned) ? cleaned.slice(0, 6) : cleaned.toUpperCase().slice(0, 6)
                })())
              }
              inputMode={allowStockCode ? 'text' : 'numeric'}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder={allowStockCode ? '如 SPY / QQQ / 00700 / 161725' : '如 161725 招商中证白酒'}
              className="field-input flex-1 tabular-nums"
            />
            <button
              type="button"
              data-testid="query-nav"
              title={manualNavValue ? '已手动填写净值，清空后才会自动查询' : '查询最新净值'}
              onClick={() => void loadQuote()}
              disabled={
                quoteLoading ||
                !!manualNavValue ||
                !(validCode || (allowStockCode && code.trim().length >= 2))
              }
              className="btn-ghost shrink-0 px-3"
            >
              {quoteLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              <span className="text-[13px]">查净值</span>
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink4">
            {allowStockCode ? (
              <>
                支持三类：境内基金（6 位数字，如 161725）、美股 / 美股 ETF（字母，如 SPY、QQQ）、港股（数字，如 00700）。
                <br />
                美股按 <span className="text-ink2">USD</span>、港股按 <span className="text-ink2">HKD</span>
                计价，再用实时汇率折算成人民币。
              </>
            ) : (
              <>
                输入 6 位代码即可，名称与净值会自动填入并持续同步（打开页面 / 每 5 分钟 / 右上角刷新）。
                <br />
                常用示例：161725 招商中证白酒、000001 华夏成长、510300 沪深300ETF
              </>
            )}
          </p>
        </div>
      ) : null}

      {/* 识别到的市场提示：让用户确认代码被正确理解 */}
      {isFundKind && detectedMarket && detectedMarket !== 'cn' ? (
        <p className="flex items-center gap-1.5 text-[11.5px] tone-info" data-testid="market-hint">
          <span className="rounded-full border px-1.5 py-0.5" style={{ borderColor: 'currentColor' }}>
            {detectedMarket === 'us' ? '美股' : '港股'}
          </span>
          将按 {HOLDING_MARKET_CURRENCY[detectedMarket]} 计价，并用实时汇率折算成人民币
        </p>
      ) : null}

      {/* 行情预览 */}
      {isFundKind && (quote || quoteError || quoteLoading) ? (
        <div className="rounded-2xl border border-line bg-s2 px-3.5 py-3">
          {quoteLoading ? (
            <p className="flex items-center gap-2 text-[12px] text-ink4">
              <Loader2 size={13} className="animate-spin" /> 正在获取最新估值…
            </p>
          ) : quoteError ? (
            <p className="text-[12px] tone-warn" data-testid="quote-error">
              {quoteError}
            </p>
          ) : quote ? (
            <div className="space-y-1.5">
              <p className="truncate text-[13px] font-medium text-ink2">{quote.name || code}</p>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
                {quote.estimatedNav !== undefined ? (
                  <span className="text-ink2">
                    盘中估算 <span className="font-medium tabular-nums">{formatNav(quote.estimatedNav)}</span>
                    <span className={`ml-1.5 ${(quote.estimatedRate ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                      {formatRate(quote.estimatedRate)}
                    </span>
                  </span>
                ) : (
                  <span className="text-ink4">暂无盘中估值（非交易时段 / QDII）</span>
                )}
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-ink4">
                {quote.publishedNav !== undefined ? (
                  <span>
                    最新净值 <span className="tabular-nums text-ink2">{formatNav(quote.publishedNav)}</span>
                    <span className={`ml-1.5 ${(quote.publishedRate ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                      {formatRate(quote.publishedRate)}
                    </span>
                  </span>
                ) : null}
                {quote.publishedAt ? <span>{quote.publishedAt}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {numberField(isFundKind ? 'shares' : isGoldKind ? 'grams' : 'amount', isFundKind ? shares : isGoldKind ? grams : amount, isFundKind ? setShares : isGoldKind ? setGrams : setAmount)}

      {/* 币种选择：基金是境内人民币净值，不提供切换 */}
      {!isFundKind ? (
        <div>
          <label className="field-label" htmlFor="item-currency">
            币种
          </label>
          <div className="flex items-center gap-2">
            <select
              id="item-currency"
              data-testid="item-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
              className="field-input flex-1"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}（{c.code}）
                </option>
              ))}
            </select>
            {convertedPreview ? (
              <span
                className={`shrink-0 text-[12px] tabular-nums ${convertedPreview.missing ? 'tone-warn' : 'text-ink3'}`}
              >
                {convertedPreview.missing
                  ? '暂无汇率'
                  : `≈ ¥${formatCNY(convertedPreview.cny as number, 2)}`}
              </span>
            ) : null}
          </div>
          {currency !== 'CNY' ? (
            <p className="mt-1 text-[11px] text-ink4">
              按实时汇率折算成人民币计入总资产，汇率更新后总额会自动跟着变。
              {rates?.perCny?.[currency]
                ? ` 1 ${currency} ≈ ${(1 / (rates.perCny[currency] as number)).toFixed(4)} 元`
                : ' 暂未取到该币种汇率'}
            </p>
          ) : null}
        </div>
      ) : null}

      {isFundKind ? numberField('costNav', costNav, setCostNav) : null}

      {/* 资金划拨：新增基金或美股/港股持仓时都可选（编辑时不可改，避免对账混乱） */}
      {isFundKind && !editing ? (
        <div className="rounded-xl border border-line bg-s2 px-3.5 py-3">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-[13px] text-ink1">从现有项目划拨</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-ink4">
                持仓增加的同时，所选现金项目相应减少（净资产不变）
              </span>
            </span>
            <input
              type="checkbox"
              data-testid="use-funding"
              checked={useFunding}
              onChange={(e) => setUseFunding(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-brand"
            />
          </label>

          {useFunding ? (
            <div className="mt-3">
              {cashCandidates.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[11.5px] leading-relaxed text-ink4">
                  没有可用的现金项目。先到「现金与固定资产」添加一个金额类条目（如「招行活期」）。
                </p>
              ) : (
                <>
                  <select
                    data-testid="funding-source"
                    value={fundingSourceId}
                    onChange={(e) => setFundingSourceId(e.target.value)}
                    className="field-input"
                  >
                    <option value="">请选择扣款项目</option>
                    {cashCandidates.map((c) => (
                      <option key={c.itemId} value={c.itemId}>
                        {c.itemName}（余额 {formatCNY(c.amount, 0)}）
                      </option>
                    ))}
                  </select>
                  {fundingSource && costPreview ? (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-ink4">
                      将扣除 <span className="text-ink2">{formatCNY(costPreview)}</span> 元，
                      「{fundingSource.itemName}」余额变为{' '}
                      {formatCNY((cashCandidates.find((x) => x.itemId === fundingSource.itemId)?.amount ?? 0) - costPreview)} 元
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 编辑已有持仓时，回显它的资金来源，只作说明不可改 */}
      {isFundKind && editing && initial && isFund(initial) && initial.fundedFrom ? (
        <p className="rounded-xl border border-line bg-s2 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink4">
          该持仓由「{initial.fundedFrom.itemName}」划拨 {formatCNY(initial.fundedFrom.amount)} 元买入
          （资金来源在创建时确定，此处不可修改）
        </p>
      ) : null}
      {isGoldKind ? numberField('pricePerGram', pricePerGram, setPricePerGram) : null}

      {isFundKind ? (
        <div>
          <label className="field-label" htmlFor="manual-nav">
            当前净值 / 现价（手动，可留空）
          </label>
          <div className="flex items-center gap-2">
            <input
              id="manual-nav"
              data-testid="manual-nav"
              value={manualNav}
              onChange={(e) => setManualNav(e.target.value)}
              inputMode="decimal"
              placeholder="留空则自动同步"
              className="field-input flex-1 tabular-nums"
            />
            {manualNavValue ? (
              <span className="shrink-0 text-[12px] tone-info">手动</span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink4">
            {manualNavValue
              ? '正在使用你填写的净值估值，自动同步已暂停；清空后恢复自动更新。'
              : '代码搜不到、或接口暂时不可用时，在这里填当前净值，市值与盈亏照常计算。'}
          </p>
        </div>
      ) : null}

      <div>
        <label className="field-label">{nameLabel}</label>
        <input
          value={name}
          onChange={(e) => {
            nameTouched.current = true
            setName(e.target.value)
          }}
          placeholder={namePlaceholder}
          className="field-input"
        />
      </div>

      <div>
        <label className="field-label">备注（可选）</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={notePlaceholder}
          className="field-input"
        />
      </div>

      {/* 提交前预览 */}
      {preview ? (
        <div className="rounded-2xl border border-line bg-s2 px-3.5 py-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-ink4">当前市值</span>
            <span className="font-medium tabular-nums text-ink1">{formatCNY(preview.value)} 元</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[12px]">
            <span className="text-ink4">{isFundKind ? '持仓成本' : '金额'}</span>
            <span className="tabular-nums text-ink2">{formatCNY(preview.cost)} 元</span>
          </div>
          {isFundKind ? (
            <div className="mt-1.5 flex items-center justify-between text-[12px]">
              <span className="text-ink4">浮动盈亏</span>
              <span className={`font-medium tabular-nums ${preview.profit >= 0 ? 'text-up' : 'text-down'}`}>
                {formatSigned(preview.profit)} 元（{formatRate(preview.rate)}）
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-[12px] tone-danger">{error}</p> : null}

      <div className="flex items-center gap-2.5 pt-0.5">
        <button type="button" className="btn-primary flex-1" onClick={submit}>
          {editing ? '保存修改' : '添加'}
        </button>
        {editing && onDelete ? (
          <button type="button" className="btn-danger px-3.5" onClick={onDelete} aria-label="删除该条目">
            <Trash2 size={15} />
          </button>
        ) : null}
        <button type="button" className="btn-ghost px-4" onClick={onCancel}>
          取消
        </button>
      </div>

      <NumberPad
        open={picker !== null}
        label={picker ? FIELD_META[picker].label : ''}
        unit={picker ? FIELD_META[picker].unit : ''}
        quickValues={picker ? FIELD_META[picker].quick : undefined}
        value={pickerValue(picker)}
        currencyCode={isFundKind ? 'CNY' : currency}
        onChange={(v) => setPickerValue(picker, v)}
        onClose={() => setPicker(null)}
      />

      {/* 数值简要说明，帮助理解计价口径 */}
      <p className="text-[11px] leading-relaxed text-ink4">
        {isFundKind
          ? '市值 = 最新估值 × 持有份额；盈亏 = 市值 −（成本单价 × 份额）。打开页面、点击刷新或每 5 分钟会自动更新估值。'
          : isGoldKind
            ? '市值 = 克数 × 计价单价。单价可随时在详情页调整以跟踪金价变化。'
            : category.isLiability
              ? '负债类金额请填正数：该分类已标记为「计入负债」，会自动从净资产中扣减。'
              : '资产类金额填正数即计入总资产；需要抵减时可直接输入负数（如 -5000）。'}
      </p>
    </div>
  )
}
