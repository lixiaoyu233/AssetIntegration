/**
 * E2E 公共辅助（CommonJS）
 *
 * 这些脚本用 Playwright 驱动**真实浏览器**打开**真实构建的站点**，
 * 像用户一样点击输入，然后断言界面与 IndexedDB —— 补单元测试的盲区：
 * 单元测试测函数逻辑，E2E 测「用户实际看到和经历的东西」。
 *
 * 历史战绩（都是单元测试没发现、E2E 抓到的真实缺陷）：
 *   - `bg-ink` / `text-ink` 类名不存在 → 按钮与文字不可见
 *   - 主题与 1.0 共用 localStorage 键 → 跨版本串味
 *   - 小屏上面板遮罩中心点被内容拦截 → 关闭面板失败
 *   - 划转数量映射错（UI 传错字段，service 单测绕过 UI）
 *
 * 用法：
 *   const { BASE, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');
 */
const { chromium, devices } = require('playwright')

/** 本地 preview 地址。可用 E2E_BASE 覆盖（例如指向线上做冒烟） */
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173'

/** iPhone 13 Pro —— 本项目移动端优先（PC 居中 480px），故用移动视口 */
const DEVICE = devices['iPhone 13 Pro']

/* ------------------------------------------------------------------ *
 * 断言与计分
 * ------------------------------------------------------------------ */

/**
 * 造一个计分器。
 *
 * 各脚本的 check/收尾逻辑原本是复制粘贴的，这里统一；
 * 但各脚本内部习惯的名字不同（`check` / `failures` / `pass` / `fail`），
 * 所以返回一组绑定好的函数，让脚本保持原有代码形态。
 */
function makeReporter() {
  let pass = 0
  let fail = 0
  const failures = []

  /** 记一项断言（也作为返回的可调用对象本体） */
  function check(name, ok, detail = '') {
    if (ok) {
      pass++
      console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`)
    } else {
      fail++
      failures.push(name)
      console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`)
    }
  }

  /** 打印汇总；返回退出码（0 = 全通过） */
  check.printSummary = () => {
    console.log(`\n${pass}/${pass + fail} 项通过`)
    if (failures.length) console.log('失败项：\n - ' + failures.join('\n - '))
    return fail === 0 ? 0 : 1
  }

  /*
   * 返回**可调用的函数**，并把汇总方法与计数挂在它上面。
   *
   * 为什么不是普通对象：各脚本里既有 `check(...)`（函数调用），
   * 也有 `check.printSummary()`。做成函数 + 属性，两种用法都成立，
   * 脚本侧几乎不用改。
   */
  check.failures = failures
  Object.defineProperty(check, 'pass', { get: () => pass })
  Object.defineProperty(check, 'fail', { get: () => fail })
  return check
}

/* ------------------------------------------------------------------ *
 * 网络桩（新增联网功能时，务必扩展这里）
 * ------------------------------------------------------------------ */

/**
 * 汇率网络桩。
 *
 * ⚠️ 为什么必须有：应用会自动获取汇率并写入 `fxRates`
 * （主源 → 备源 → `public/fx-seed.json`）。回归脚本预置的是**固定汇率**，
 * 联网抓取会覆盖它们，导致金额断言随机失败。
 *
 * 这里让汇率源「不可用」：两个实时源 abort，种子文件返回只有 CNY 的最小内容
 * → 本轮不写入任何非 CNY 的自动汇率行，脚本预置的汇率即唯一来源。
 */
async function stubFxNetwork(page) {
  await page.route('**/open.er-api.com/**', (r) => r.abort())
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort())
  await page.route('**/fx-seed.json*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ asOf: '2020-01-01', rates: { CNY: 1 } }),
    }),
  )
}

/**
 * 行情网络桩。
 *
 * ⚠️ 同上：应用会按代码格式自动获取行情（`TEST` / `TESTX` 这类**测试用的
 * 假代码**在格式上匹配美股，会被真的拿去查腾讯并拿到数据），
 * 从而覆盖脚本预置的「缺行情 / 过期行情」场景。
 */
async function stubQuoteNetwork(page) {
  await page.route('**/qt.gtimg.cn/**', (r) => r.abort())
  await page.route('**/fundmobapi.eastmoney.com/**', (r) => r.abort())
  await page.route('**/push2.eastmoney.com/**', (r) => r.abort())
}

/* ------------------------------------------------------------------ *
 * 断言辅助
 * ------------------------------------------------------------------ */

/**
 * 采集控制台 / 页面错误。
 *
 * ⚠️ 故意 abort 网络时 Chrome 会打内建日志 `net::ERR_FAILED`，
 * 那**不是应用异常**（已单独验证过 unhandledrejection = 0 / pageerror = 0），
 * 因此这里过滤掉。**不要删掉这个过滤**。
 */
function collectErrors(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (t.includes('net::ERR_FAILED')) return
    errors.push('console: ' + t.slice(0, 120))
  })
  return errors
}

/** 去掉货币符号与千分位，便于和数字比较 */
const numOf = (s) => String(s).replace(/[¥,\s]/g, '')

/** 读取某元素的文本（已 trim） */
const textOf = (page, selector) => page.locator(selector).first().innerText().then((t) => t.trim())

/**
 * 关闭当前面板。
 *
 * ⚠️ 必须点**面板内**的关闭按钮，不要点全屏遮罩：
 * 遮罩是一个 `aria-label="关闭"` 的全屏按钮，Playwright 点它的**中心点**，
 * 而面板 `max-h-[92vh]` 在小屏上几乎占满 —— 中心点会落在面板内容上被拦截。
 */
async function closeSheet(page) {
  const btn = page.locator('[role="dialog"] button[aria-label="关闭面板"]')
  if (await btn.count()) {
    await btn.first().click().catch(() => {})
    await page.waitForTimeout(300)
  }
}

/** 反复调用 closeSheet，直到没有面板 */
async function closeAll(page) {
  for (let i = 0; i < 6; i++) {
    const x = page.locator('[role="dialog"] button[aria-label="关闭面板"]')
    if (!(await x.count())) break
    await x.first().click().catch(() => {})
    await page.waitForTimeout(250)
  }
}

/** 切到某个 Tab（先关掉所有面板） */
async function goTab(page, tab) {
  await closeAll(page)
  await page.click(`[data-testid="nav-${tab}"]`)
  await page.waitForTimeout(800)
}

/** 清掉站点全部本地数据（localStorage + IndexedDB），用于干净起步 */
async function resetStorage(page) {
  await page.evaluate(async () => {
    localStorage.clear()
    const dbs = await indexedDB.databases()
    for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name)
  })
}

module.exports = {
  BASE,
  DEVICE,
  chromium,
  devices,
  makeReporter,
  stubFxNetwork,
  stubQuoteNetwork,
  collectErrors,
  numOf,
  textOf,
  closeSheet,
  closeAll,
  goTab,
  resetStorage,
}
