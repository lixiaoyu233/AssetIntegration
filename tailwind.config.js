/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 主题由 <html data-theme="light|dark"> 驱动，具体色值放在 CSS 变量里
  theme: {
    extend: {
      colors: {
        /** 页面底色 */
        app: 'var(--app)',
        /** 表面层级：s1 卡片 / s2 次级容器 / s3 输入框 / s4 键盘按键 */
        s1: 'var(--s1)',
        s2: 'var(--s2)',
        s3: 'var(--s3)',
        s4: 'var(--s4)',
        /** 文字层级：ink1 最重要 → ink4 最弱 */
        ink1: 'var(--ink1)',
        ink2: 'var(--ink2)',
        ink3: 'var(--ink3)',
        ink4: 'var(--ink4)',
        /** 反色：主按钮底色与其文字色 */
        invert: 'var(--invert)',
        'on-invert': 'var(--on-invert)',
        /** 细边框与强调边框 */
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        /** 涨跌：遵循 A 股习惯，红涨绿跌 */
        up: 'var(--up)',
        down: 'var(--down)',
        /** 语义状态色 */
        warn: 'var(--warn)',
        info: 'var(--info)',
        good: 'var(--good)',
        danger: 'var(--danger)',
        /** 分类主题色，随主题切换以保证对比度 */
        gold: 'var(--accent-gold)',
        blue: 'var(--accent-blue)',
        green: 'var(--accent-green)',
        red: 'var(--accent-red)',
        purple: 'var(--accent-purple)',
        cyan: 'var(--accent-cyan)',
        orange: 'var(--accent-orange)',
        pink: 'var(--accent-pink)',
        slate: 'var(--accent-slate)',
      },
      borderRadius: {
        card: '16px',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        sheet: 'var(--shadow-sheet)',
      },
      /** 半透明蒙层与键盘按键，色值随主题变化 */
      backgroundColor: {
        scrim: 'var(--scrim)',
        keypad: 'var(--s4)',
        'keypad-active': 'var(--s3)',
      },
      accentColor: {
        brand: 'var(--accent-gold)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
      },
      keyframes: {
        'sheet-in': {
          from: { transform: 'translateY(16px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'sheet-in': 'sheet-in 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 160ms ease-out',
      },
    },
  },
  plugins: [
    // standalone: 变体 → 只在「添加到主屏幕」的独立窗口模式下生效
    // 独立模式下系统已为状态栏预留空间，页面不能再叠加 safe-area-inset-top
    function ({ addVariant }) {
      addVariant('standalone', "html[data-standalone='1'] &")
    },
  ],
}

