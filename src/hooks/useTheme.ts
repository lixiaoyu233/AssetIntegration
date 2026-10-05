import { useCallback, useEffect, useState } from 'react'

/** 用户可选的主题：跟随系统 / 强制日间 / 强制夜间 */
export type ThemeMode = 'system' | 'light' | 'dark'
/** 最终生效的主题（system 会被解析成 light 或 dark） */
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'asset-card-wallet/theme'

/** 浏览器状态栏 / 地址栏颜色，与两套主题的页面底色保持一致 */
export const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: '#000000',
  light: '#f5f5f4',
}

function readStoredMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
    // 兼容更早的布尔值写法
    if (raw === 'true') return 'dark'
    if (raw === 'false') return 'light'
  } catch {
    /* 隐私模式下读不到，忽略 */
  }
  return 'system'
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** 把主题写到 <html data-theme> 与主题色 meta 上 */
export function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLOR[theme])
}

/**
 * 主题状态。
 *
 * 默认是 `system`（跟随系统），用户手动切换后记住选择并存进 localStorage。
 * 首屏的防闪白由 index.html 里的一段内联脚本完成，这里负责交互与后续同步。
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => {
    const m = readStoredMode()
    return m === 'system' ? systemTheme() : m
  })

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      /* 存不了也不影响本次使用 */
    }
  }, [])

  /** 跟随系统时，系统切换要实时响应（iOS 的日落自动切换也走这条） */
  useEffect(() => {
    if (mode !== 'system' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setResolved(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  useEffect(() => {
    const next: ResolvedTheme = mode === 'system' ? systemTheme() : mode
    setResolved(next)
  }, [mode])

  /** 应用主题，并加一小段过渡类让换肤柔和（切完就摘掉，避免影响交互） */
  useEffect(() => {
    applyTheme(resolved)
    const root = document.documentElement
    root.classList.add('theme-switching')
    const timer = window.setTimeout(() => root.classList.remove('theme-switching'), 260)
    return () => window.clearTimeout(timer)
  }, [resolved])

  /** 三态循环：跟随系统 → 日间 → 夜间 → 跟随系统 */
  const cycle = useCallback(() => {
    const order: ThemeMode[] = ['system', 'light', 'dark']
    const idx = order.indexOf(mode)
    setMode(order[(idx + 1) % order.length])
  }, [mode, setMode])

  return { mode, resolved, setMode, cycle }
}

/** 给按钮用的文案 */
export const MODE_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '日间模式',
  dark: '夜间模式',
}
