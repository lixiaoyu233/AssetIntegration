/**
 * 顶部安全区的实测与兜底
 *
 * 背景：iOS 添加到主屏幕（独立窗口模式）下，`env(safe-area-inset-top)` 不可靠 ——
 * 实测遇到过两种错法：
 *   1. 页面确实延伸到了状态栏后面，`env()` 却返回 0 → 内容被状态栏遮住、按钮点不到；
 *   2. 页面没有延伸，但布局里已经预留过，`env()` 仍返回值 → 顶部多出一大块。
 *
 * 所以这里不再盲信 `env()`：先**实测**，测不到再用设备信息**兜底估算**。
 * 宁可多留几像素，也不能让标题和按钮落在状态栏后面。
 */

/** 当前生效的顶部安全区（px），由 resolveSafeTopInset 计算 */
export const SAFE_TOP_VAR = '--safe-top'

export interface SafeAreaProbe {
  /** getComputedStyle 读到的 env(safe-area-inset-top) */
  envTop: number
  /** 同上，底部（用于诊断） */
  envBottom: number
  /** 是否为独立窗口模式 */
  standalone: boolean
  /** 屏幕尺寸（CSS px）与视口尺寸，用于估算缺口 */
  screenW: number
  screenH: number
  innerW: number
  innerH: number
  visualH: number
  dpr: number
  /** 估算出的顶部缺口（屏幕比视口高出的部分） */
  gap: number
}

function readEnvInset(side: 'top' | 'bottom'): number {
  if (typeof document === 'undefined') return 0
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none;' +
    `padding-${side}:env(safe-area-inset-${side}, 0px)`
  document.body.appendChild(probe)
  const v = parseFloat(getComputedStyle(probe).getPropertyValue(`padding-${side}`)) || 0
  probe.remove()
  return Number.isFinite(v) ? v : 0
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  try {
    // navigator.standalone 是 iOS Safari 的私有属性，TS 标准库没有声明
    const nav = window.navigator as Navigator & { standalone?: boolean }
    return (
      nav.standalone === true ||
      (typeof window.matchMedia === 'function' &&
        (window.matchMedia('(display-mode: standalone)').matches ||
          window.matchMedia('(display-mode: fullscreen)').matches))
    )
  } catch {
    return false
  }
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

export function probeSafeArea(): SafeAreaProbe {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      envTop: 0, envBottom: 0, standalone: false,
      screenW: 0, screenH: 0, innerW: 0, innerH: 0, visualH: 0, dpr: 1, gap: 0,
    }
  }
  const screenH = window.screen?.height ?? 0
  const innerH = window.innerHeight
  return {
    envTop: readEnvInset('top'),
    envBottom: readEnvInset('bottom'),
    standalone: isStandalone(),
    screenW: window.screen?.width ?? 0,
    screenH,
    innerW: window.innerWidth,
    innerH,
    visualH: window.visualViewport?.height ?? innerH,
    dpr: window.devicePixelRatio || 1,
    gap: Math.max(0, Math.round(screenH - innerH)),
  }
}

/**
 * 兜底估算：`env()` 为 0、但页面明显延伸进状态栏时使用。
 *
 * 依据：iPhone 有刘海的机型状态栏约 44~59px，无刘海机型约 20px。
 * 判断方式用屏幕宽度（CSS px）—— 刘海机型普遍 ≥ 375 且屏占比高；
 * 拿不准时统一给 47px，偏大一点只会多留少量空白，不会遮住内容。
 */
export function estimateTopInset(probe: SafeAreaProbe): number {
  const w = Math.min(probe.screenW, probe.innerW)
  // 带灵动岛的机型（屏宽 393/402/430 等）状态栏更高
  if (w >= 420) return 59
  if (w >= 390) return 54
  if (w >= 375) return 47
  return 20
}

/**
 * 解析出应当使用的顶部安全区，并写入 CSS 变量。
 *
 * 规则：
 * - `env()` 有值 → 直接用（最准确）；
 * - `env()` 为 0 且**处于独立窗口模式** → 兜底估算，避免内容被状态栏遮住；
 * - 其余情况（桌面、普通 Safari）→ 0。
 *
 * 为什么兜底不能对「所有 iOS」生效：普通 Safari 里地址栏本来就不会压住内容，
 * 若也按状态栏高度补内边距，顶部会平白多出一大块（实测 h1 会被推到 86px）。
 */
export function resolveSafeTopInset(): { inset: number; probe: SafeAreaProbe; source: string } {
  const probe = probeSafeArea()
  let inset = 0
  let source = 'env'

  if (probe.envTop > 0) {
    inset = probe.envTop
  } else if (probe.standalone) {
    // 只有独立窗口模式才需要自己避让状态栏
    inset = estimateTopInset(probe)
    source = 'estimate'
  }

  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty(SAFE_TOP_VAR, `${inset}px`)
    document.documentElement.setAttribute('data-safe-top-source', source)
  }
  return { inset, probe, source }
}

/** 供设置页展示的设备诊断信息（iOS 上无法真机调试，靠它回报实际情况） */
export function collectDiagnostics(): Record<string, string | number | boolean> {
  const probe = probeSafeArea()
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return {
    平台: isIOS() ? 'iOS' : '其他',
    独立模式: probe.standalone,
    'env(safe-area-inset-top)': `${probe.envTop}px`,
    'env(safe-area-inset-bottom)': `${probe.envBottom}px`,
    当前顶部间距: getComputedStyle(document.documentElement).getPropertyValue(SAFE_TOP_VAR).trim() || '(未设置)',
    来源: document.documentElement.getAttribute('data-safe-top-source') ?? '(未知)',
    屏幕: `${probe.screenW}×${probe.screenH}`,
    视口: `${probe.innerW}×${probe.innerH}`,
    可见视口高: `${Math.round(probe.visualH)}`,
    屏幕高出视口: `${probe.gap}px`,
    像素比: probe.dpr,
    UA: ua,
  }
}
