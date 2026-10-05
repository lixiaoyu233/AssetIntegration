#!/usr/bin/env node
/**
 * 生成 PWA 图标（PNG）。
 *
 * 为什么用脚本生成而不是手画：iOS 的 apple-touch-icon 只认 PNG，
 * 而项目里只有 SVG；这里用 Chromium 把同一份视觉稿渲染成多尺寸 PNG，
 * 保证桌面图标 / 启动图 / maskable 三种用途完全一致。
 *
 * 用法：node scripts/gen-icons.cjs
 * 需要：playwright（仅作为本地工具，不进 package.json 依赖）
 */
const path = require('path')
const fs = require('fs')
const { chromium } = require('playwright')

const OUT = path.join(__dirname, '..', 'public', 'icons')

/** 图标视觉稿：深色底 + 金色卡片 + 绿色涨势点 */
function iconHtml(size, { padding = 0 } = {}) {
  const s = size
  const r = s * 0.22 // 圆角（非 maskable 时用，maskable 由系统裁切）
  const inner = s - padding * 2
  const k = inner / 64 // 以 64 为设计基准缩放
  const o = padding
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${s}px;height:${s}px;background:transparent}
    .wrap{position:relative;width:${s}px;height:${s}px;background:#0b0b0c;border-radius:${padding ? 0 : r}px;overflow:hidden}
    .glow{position:absolute;left:${-s * 0.1}px;top:${-s * 0.18}px;width:${s * 0.8}px;height:${s * 0.8}px;
      border-radius:9999px;background:#f0b90b;opacity:.16;filter:blur(${s * 0.14}px)}
    .card{position:absolute;left:${o + 11 * k}px;top:${o + 16 * k}px;width:${42 * k}px;height:${32 * k}px;
      box-sizing:border-box;border:${3.4 * k}px solid #f0b90b;border-radius:${8 * k}px}
    .stripe{position:absolute;left:${o + 11 * k}px;top:${o + 25 * k}px;width:${42 * k}px;height:${3.4 * k}px;background:#f0b90b}
    .chip{position:absolute;left:${o + 35 * k}px;top:${o + 30 * k}px;width:${16 * k}px;height:${9 * k}px;
      border-radius:${5 * k}px;background:#f0b90b}
    .dot{position:absolute;left:${o + 19 * k}px;top:${o + 19 * k}px;width:${5 * k}px;height:${5 * k}px;
      border-radius:9999px;background:#22c55e}
  </style></head><body>
    <div class="wrap"><div class="glow"></div>
      <div class="card"></div><div class="stripe"></div><div class="chip"></div><div class="dot"></div>
    </div>
  </body></html>`
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const targets = [
    { file: 'apple-touch-icon.png', size: 180, padding: 0 },
    { file: 'icon-192.png', size: 192, padding: 0 },
    { file: 'icon-512.png', size: 512, padding: 0 },
    // maskable：内容收进中心 80%，四周留安全区，避免被系统裁成圆形时切到卡片
    { file: 'icon-maskable-512.png', size: 512, padding: 52 },
  ]
  for (const t of targets) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 })
    await page.setContent(iconHtml(t.size, { padding: t.padding }), { waitUntil: 'load' })
    const buf = await page.screenshot({ omitBackground: true })
    fs.writeFileSync(path.join(OUT, t.file), buf)
    await page.close()
    console.log(`  ✅ ${t.file.padEnd(26)} ${t.size}×${t.size}  ${(buf.length / 1024).toFixed(1)} KB`)
  }
  await browser.close()
  console.log(`\n图标已输出到 public/icons/`)
})()
