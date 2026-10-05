import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type SafeAreaProbe,
  estimateTopInset,
  isStandalone,
  probeSafeArea,
  resolveSafeTopInset,
} from './safeArea'

/*
 * iOS 独立窗口模式下 env(safe-area-inset-top) 不可靠（可能返回 0），
 * 所以顶部间距改为「实测 + 兜底」。这组测试盯住兜底的分档与生效范围，
 * 避免再出现「被状态栏遮住」或「平白多留一大块」。
 */

const baseProbe = (patch: Partial<SafeAreaProbe> = {}): SafeAreaProbe => ({
  envTop: 0,
  envBottom: 0,
  standalone: false,
  screenW: 393,
  screenH: 852,
  innerW: 393,
  innerH: 664,
  visualH: 664,
  dpr: 3,
  gap: 188,
  ...patch,
})

describe('兜底估算（按屏宽分档）', () => {
  it('灵动岛机型给 59px', () => {
    expect(estimateTopInset(baseProbe({ screenW: 430, innerW: 430 }))).toBe(59)
    expect(estimateTopInset(baseProbe({ screenW: 420, innerW: 420 }))).toBe(59)
  })

  it('较新刘海机型给 54px', () => {
    expect(estimateTopInset(baseProbe({ screenW: 393, innerW: 393 }))).toBe(54)
    expect(estimateTopInset(baseProbe({ screenW: 390, innerW: 390 }))).toBe(54)
  })

  it('较早刘海机型给 47px', () => {
    expect(estimateTopInset(baseProbe({ screenW: 375, innerW: 375 }))).toBe(47)
  })

  it('窄屏（无刘海小机型）给 20px', () => {
    expect(estimateTopInset(baseProbe({ screenW: 320, innerW: 320 }))).toBe(20)
  })

  it('取屏幕与视口的较小值，避免横屏误判', () => {
    // 横屏时 screenW 很大但 innerW 仍是短边
    expect(estimateTopInset(baseProbe({ screenW: 852, innerW: 393 }))).toBe(54)
  })

  it('未知尺寸也不返回 0（必须有避让余量）', () => {
    expect(estimateTopInset(baseProbe({ screenW: 0, innerW: 0 }))).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ *
 * 以下用例需要 DOM：用最小 stub 替代 jsdom
 * ------------------------------------------------------------------ */

interface StubOptions {
  envTop?: number
  standalone?: boolean
  screenWidth?: number
  innerWidth?: number
}

function installDomStub(opts: StubOptions = {}) {
  const { envTop = 0, standalone = false, screenWidth = 393, innerWidth = 393 } = opts
  const styleStore: Record<string, string> = {}

  const root = {
    style: {
      setProperty: (k: string, v: string) => {
        styleStore[k] = v
      },
      getPropertyValue: (k: string) => styleStore[k] ?? '',
    },
    setAttribute: vi.fn(),
    getAttribute: vi.fn(() => null),
  }

  const doc = {
    documentElement: root,
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    createElement: () => ({
      style: { cssText: '' },
      remove: vi.fn(),
      parentNode: null,
    }),
    // 探针读到的 env() 值在这里固定住
    defaultView: {},
  }

  const win = {
    screen: { width: screenWidth, height: 852 },
    innerWidth,
    innerHeight: 664,
    devicePixelRatio: 3,
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', standalone },
    matchMedia: () => ({ matches: standalone }),
    visualViewport: { height: 664 },
  }

  // Node 里 navigator 只有 getter，必须用 defineProperty 才能覆盖
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })

  define('document', doc)
  define('window', win)
  define('navigator', win.navigator)
  define('getComputedStyle', () => ({
    getPropertyValue: (k: string) => (k.startsWith('padding-top') ? `${envTop}px` : '0px'),
    paddingTop: `${envTop}px`,
  }))

  return { styleStore, root, doc, win }
}

function removeDomStub() {
  for (const k of ['document', 'window', 'navigator', 'getComputedStyle']) {
    delete (globalThis as unknown as Record<string, unknown>)[k]
  }
}

describe('独立模式判定', () => {
  afterEach(removeDomStub)

  it('navigator.standalone 为 true 时算独立模式', () => {
    installDomStub({ standalone: true })
    expect(isStandalone()).toBe(true)
  })

  it('display-mode: standalone 也算', () => {
    installDomStub({ standalone: false })
    ;(globalThis as unknown as { window: { matchMedia: () => { matches: boolean } } }).window.matchMedia = () => ({ matches: true })
    expect(isStandalone()).toBe(true)
  })

  it('普通浏览器返回 false', () => {
    installDomStub({ standalone: false })
    expect(isStandalone()).toBe(false)
  })

  it('没有 window 时不报错', () => {
    removeDomStub()
    expect(() => isStandalone()).not.toThrow()
    expect(isStandalone()).toBe(false)
  })
})

describe('解析顶部安全区', () => {
  afterEach(removeDomStub)

  it('env() 有值时优先使用它', () => {
    const { styleStore } = installDomStub({ envTop: 47, standalone: true })
    const r = resolveSafeTopInset()
    expect(r.source).toBe('env')
    expect(r.inset).toBe(47)
    expect(styleStore['--safe-top']).toBe('47px')
  })

  it('独立模式 + env() 为 0 → 使用兜底估算', () => {
    const { styleStore } = installDomStub({ envTop: 0, standalone: true, screenWidth: 393, innerWidth: 393 })
    const r = resolveSafeTopInset()
    expect(r.source).toBe('estimate')
    expect(r.inset).toBe(54)
    expect(styleStore['--safe-top']).toBe('54px')
  })

  it('普通 Safari + env() 为 0 → 不额外留白（这是回归重点）', () => {
    const { styleStore } = installDomStub({ envTop: 0, standalone: false })
    const r = resolveSafeTopInset()
    expect(r.inset).toBe(0)
    expect(styleStore['--safe-top']).toBe('0px')
  })

  it('没有 DOM 时返回 0 且不抛错', () => {
    removeDomStub()
    expect(() => resolveSafeTopInset()).not.toThrow()
    expect(resolveSafeTopInset().inset).toBe(0)
  })
})

describe('探针读数', () => {
  afterEach(removeDomStub)

  it('没有 DOM 时返回全 0 的安全默认值', () => {
    removeDomStub()
    const p = probeSafeArea()
    expect(p.envTop).toBe(0)
    expect(p.standalone).toBe(false)
    expect(p.dpr).toBe(1)
  })
})

describe('诊断信息', () => {
  beforeEach(() => {
    installDomStub({ envTop: 0, standalone: true })
  })
  afterEach(removeDomStub)

  it('包含排查所需的关键字段', async () => {
    const { collectDiagnostics } = await import('./safeArea')
    const info = collectDiagnostics()
    expect(info).toHaveProperty("env(safe-area-inset-top)")
    expect(info).toHaveProperty('独立模式')
    expect(info).toHaveProperty('屏幕')
    expect(info).toHaveProperty('视口')
    expect(info).toHaveProperty('UA')
  })
})
