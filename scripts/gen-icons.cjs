#!/usr/bin/env node
/**
 * 生成「资产整合 / AssetIntegration」的 PWA 图标（PNG）。
 *
 * 为什么用脚本生成而不是手画：iOS 的 apple-touch-icon 只认 PNG，
 * 而项目里只有 SVG；这里用 Chromium 把同一份视觉稿渲染成多尺寸 PNG，
 * 保证桌面图标 / 启动图 / maskable 三种用途完全一致。
 *
 * ## 视觉语义（与 1.0「WealthCard」刻意区分）
 *
 * 1.0 的图标是「纯黑底 + 金色单张卡片 + 绿色涨势点」= 一个人一张卡。
 * 2.0 是「多账户 / 多标的 → 层叠整合成一个数」，因此：
 *
 *   - 三根**层叠上升柱**（青 → 天蓝 → 靛蓝渐变）= 多个来源汇总到一起
 *   - 底部一道**聚合底盘** = 收拢到同一视图
 *   - 顶端一颗**金色圆点** = 汇总出来的那个数（唯一保留的品牌金）
 *   - 底板是**深墨蓝**（#070b14）而非 1.0 的纯黑，主色是青蓝而非金色
 *
 * 这样在手机桌面上两个 App 图标一眼可区分：金色卡片 vs 蓝色柱状。
 *
 * ⚠️ 修改本文件后必须同时更新 `public/favicon.svg`（同一视觉稿，
 *    一个是矢量、一个是位图渲染），保持两者一致。
 *
 * 用法：node scripts/gen-icons.cjs
 * 需要：playwright（仅作为本地工具，不进 package.json 依赖）
 */
const path = require('path')
const fs = require('fs')
const { chromium } = require('playwright')

const OUT = path.join(__dirname, '..', 'public', 'icons')

/** 图标视觉稿：深墨蓝底 + 青蓝层叠柱 + 金色顶点 */
function iconHtml(size, { padding = 0 } = {}) {
  const s = size
  const r = s * 0.22 // 圆角（非 maskable 时用，maskable 由系统裁切）
  const inner = s - padding * 2
  const k = inner / 64 // 以 64 为设计基准缩放
  const o = padding

  // 柱位：三根柱 x=[15, 27.5, 40]，宽 9，圆角 4
  const bar = (x, y, h) =>
    `left:${o + x * k}px;top:${o + y * k}px;width:${9 * k}px;height:${h * k}px;border-radius:${4 * k}px;`
  const GRAD = 'linear-gradient(45deg,#2dd4bf,#38bdf8 55%,#818cf8)'

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${s}px;height:${s}px;background:transparent}
    .wrap{position:relative;width:${s}px;height:${s}px;background:#070b14;border-radius:${padding ? 0 : r}px;overflow:hidden}
    .glow{position:absolute;left:${o + 6 * k}px;top:${o + 4 * k}px;width:${52 * k}px;height:${52 * k}px;
      border-radius:9999px;background:radial-gradient(circle,#38bdf8 0%,rgba(56,189,248,0) 70%);opacity:.45}
    .base{position:absolute;${bar(15, 41.5, 5.5)}background:#ffffff;opacity:.07}
    .bar1{position:absolute;${bar(15, 36, 12)}background:${GRAD}}
    .bar2{position:absolute;${bar(27.5, 28, 20)}background:${GRAD}}
    .bar3{position:absolute;${bar(40, 20, 28)}background:${GRAD}}
    .apex{position:absolute;left:${o + 40.3 * k}px;top:${o + 9.8 * k}px;
      width:${8.4 * k}px;height:${8.4 * k}px;border-radius:9999px;background:#f0b90b}
  </style></head><body>
    <div class="wrap">
      <div class="glow"></div>
      <div class="base"></div>
      <div class="bar1"></div><div class="bar2"></div><div class="bar3"></div>
      <div class="apex"></div>
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
    // maskable：内容收进中心 80%，四周留安全区，避免被系统裁成圆形时切到柱子
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
