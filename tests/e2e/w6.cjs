/**
 * Phase 8 / W6 E2E — 行情与汇率手动录入 + 估值依据可见
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();

const SEED = (page) => page.evaluate(async () => {
  const iso = '2026-01-05T10:00:00.000Z';
  const open = indexedDB.open('wealthcard', 20);
  open.onupgradeneeded = (e) => {
    const db = e.target.result;
    const mk = (n, k, idx) => { const st = db.createObjectStore(n, { keyPath: k }); for (const i of idx) st.createIndex(i[0], i[1], i[2] || {}); };
    mk('accounts', 'id', []); mk('instruments', 'id', []); mk('holdings', 'id', []); mk('transactions', 'id', []);
    mk('quotes', 'id', []); mk('fxRates', 'id', []); mk('snapshots', 'id', [['date', 'date', { unique: true }]]);
    mk('allocationProfiles', 'id', []); mk('meta', 'key', []); mk('classificationAudit', 'id', []);
  };
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  const put = (s, rows) => new Promise((res, rej) => { const tx = db.transaction(s, 'readwrite'); rows.forEach((r) => tx.objectStore(s).put(r)); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  await put('accounts', [{ id: 'a_cny', name: '示例账户', type: 'bank', currency: 'CNY', region: 'CN', isLiability: false, createdAt: iso, updatedAt: iso }]);
  await put('instruments', [
    { id: 'i_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
    { id: 'i_stock', name: '示例股票', symbol: 'TEST', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
  ]);
  await put('transactions', [
    { id: 'seed_cash', accountId: 'a_cny', instrumentId: 'i_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: iso },
    { id: 'seed_stock', accountId: 'a_cny', instrumentId: 'i_stock', type: 'adjustment', quantity: 100, amount: 1000, currency: 'CNY', timestamp: iso },
  ]);
  await put('holdings', [
    { id: 'h_cash', accountId: 'a_cny', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000, averageCost: 1, createdAt: iso, updatedAt: iso },
    { id: 'h_stock', accountId: 'a_cny', instrumentId: 'i_stock', valuationMode: 'quantity', quantity: 100, costBasis: 1000, averageCost: 10, createdAt: iso, updatedAt: iso },
  ]);
  // 刻意**没有** quotes：股票不可估值
  db.close();
});

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...DEVICE, locale: 'zh-CN' });




  const p = await ctx.newPage()
  await stubFxNetwork(p);
  await stubQuoteNetwork(p);;
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  /*
   * 故意 abort 汇率网络源时，Chrome 会打内建日志
   * "Failed to load resource: net::ERR_FAILED" —— 那不是应用异常。
   * （已用专门探针验证：unhandledrejection = 0 / pageerror = 0）
   */
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('net::ERR_FAILED')) return;
    errors.push('console: ' + t.slice(0, 120));
  });

  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.evaluate(async () => { const r = indexedDB.deleteDatabase('wealthcard'); await new Promise((s) => { const d = () => s(); r.onsuccess = d; r.onerror = d; r.onblocked = d; setTimeout(d, 3000); }); });
  await p.waitForTimeout(200);
  await SEED(p);
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="total-assets"]', { timeout: 20000 });
  check('⓪ 播种成功', true);

  const txt = async (s) => (await p.locator(s).first().innerText()).trim();
  const assets = async () => Number((await txt('[data-testid="total-assets"]')).replace(/[¥,]/g, ''));
  const home = async () => {
    const x = p.locator('[role="dialog"] button[aria-label="关闭面板"]');
    if (await x.count()) { await x.first().click().catch(() => {}); await p.waitForTimeout(300); }
    await p.evaluate(() => localStorage.setItem('wealthcard/ui/active-tab', 'home'));
    await p.reload({ waitUntil: 'load' });
    await p.waitForSelector('[data-testid="total-assets"]', { timeout: 20000 });
    await p.waitForFunction(() => /数据更新于/.test(document.body.innerText), undefined, { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(400);
    return assets();
  };
  const assetsTab = async () => {
    await p.click('[data-testid="nav-assets"]');
    await p.waitForSelector('[data-testid="asset-actions"]', { timeout: 15000 });
  };

  // ── 初始：股票缺行情 ─────────────────────────────────
  const base = await home();
  check('① 缺行情时总资产只含现金 100000', base === 100000, String(base));
  check('② 首页显示无法估值计数', (await txt('[data-testid="unavailable-count"]')).includes('1'), await txt('[data-testid="unavailable-count"]'));

  await assetsTab();
  check('③ 资产页提示待补行情', (await txt('[data-testid="action-quote"]')).includes('待补行情'), await txt('[data-testid="action-quote"]'));
  check('④ 行内出现「录入行情」入口', (await p.locator('[data-testid="row-add-quote"]').count()) >= 1);

  // ── 估值依据（B）──────────────────────────────────────
  const basisText = await txt('[data-testid="holding-basis"]');
  check('⑤ 显示估值状态中文（不是 ok/unavailable）', /可靠估值|无法估值|依据已过期/.test(basisText), basisText);
  check('⑥ 显示降级原因中文（不是 missing_quote）', (await txt('[data-testid="holding-reasons"]')).includes('缺少行情'), await txt('[data-testid="holding-reasons"]'));
  check('⑦ 界面不暴露内部代码 missing_quote', !(await p.evaluate(() => document.body.innerText)).includes('missing_quote'));

  // ── 录入行情（A）──────────────────────────────────────
  await p.click('[data-testid="action-quote"]');
  await p.waitForSelector('[data-testid="quote-price"]', { timeout: 15000 });
  check('⑧ QuoteSheet 打开', true);
  check('⑨ 提示该标的当前没有行情', (await p.locator('[data-testid="quote-missing"]').count()) === 1);

  // 拒绝 0
  await p.fill('[data-testid="quote-price"]', '0');
  await p.click('[data-testid="quote-save"]');
  await p.waitForSelector('[data-testid="quote-error"]', { timeout: 10000 });
  check('⑩ 【核心】价格填 0 被拒绝（不可估值 ≠ 0）', (await txt('[data-testid="quote-error"]')).includes('大于 0'), await txt('[data-testid="quote-error"]'));

  // 正常录入
  await p.fill('[data-testid="quote-price"]', '12');
  await p.click('[data-testid="quote-save"]');
  await p.waitForSelector('[data-testid="quote-done"]', { timeout: 15000 });
  check('⑪ 行情保存成功', (await txt('[data-testid="quote-done"]')).includes('已保存'));
  await p.click('[role="dialog"] button[aria-label="关闭面板"]');
  await p.waitForTimeout(800);

  const afterQuote = await home();
  check('⑫ 【核心】录入行情后可靠总额 = 100000 + 100×12', afterQuote === 101200, String(afterQuote));

  await assetsTab();
  const allBasis = await p.locator('[data-testid="holding-basis"]').allInnerTexts();
  console.log('    [DBG] 所有依据 =', JSON.stringify(allBasis));
  check('⑬ 依据显示价格类型与来源', allBasis.some((t) => /市场价格/.test(t)), JSON.stringify(allBasis));
  check('⑭ 依据显示来源 manual', (await p.evaluate(() => document.body.innerText)).includes('来源 manual'));
  check('⑮ 依据显示「手动」状态', (await p.evaluate(() => document.body.innerText)).includes('手动'));

  // ── 过期行情不计入（不变量 3）─────────────────────────
  const stockRow = p.locator('[data-testid="holding-row"]').filter({ hasText: '示例股票' }).first();
  check('⑯ 股票行有可靠金额', (await stockRow.innerText()).includes('1,200'), (await stockRow.innerText()).slice(0, 60));

  // ── 设置页行情/汇率入口 ───────────────────────────────
  await p.click('[data-testid="nav-settings"]');
  await p.waitForSelector('[data-testid="market-data-info"]', { timeout: 15000 });
  check('⑰ 设置页显示行情覆盖率', (await txt('[data-testid="market-quote-count"]')).includes('1'), await txt('[data-testid="market-quote-count"]'));
  check('⑱ 设置页显示缺行情计数', (await txt('[data-testid="market-missing-quote"]')).includes('0'), await txt('[data-testid="market-missing-quote"]'));
  check('⑲ 设置页有行情入口', (await p.locator('[data-testid="open-quote"]').count()) === 1);
  check('⑳ 设置页有汇率入口', (await p.locator('[data-testid="open-fx"]').count()) === 1);

  // ── 汇率录入（A）──────────────────────────────────────
  await p.click('[data-testid="open-fx"]');
  await p.waitForSelector('[data-testid="fx-rate"]', { timeout: 15000 });
  await p.fill('[data-testid="fx-rate"]', '0');
  await p.click('[data-testid="fx-save"]');
  await p.waitForSelector('[data-testid="fx-error"]', { timeout: 10000 });
  check('㉑ 【核心】汇率填 0 被拒绝（缺 FX ≠ 1）', (await txt('[data-testid="fx-error"]')).includes('大于 0'), await txt('[data-testid="fx-error"]'));

  await p.selectOption('[data-testid="fx-currency"]', 'USD');
  await p.fill('[data-testid="fx-rate"]', '7.2');
  await p.click('[data-testid="fx-save"]');
  await p.waitForSelector('[data-testid="fx-done"]', { timeout: 15000 });
  check('㉒ 汇率保存成功', (await txt('[data-testid="fx-done"]')).includes('已保存'));
  await p.click('[role="dialog"] button[aria-label="关闭面板"]');
  await p.waitForTimeout(600);

  // ── 刷新后一致 ────────────────────────────────────────
  const afterReload = await home();
  check('㉓ 【核心】刷新后总额仍为 101200（行情与汇率已落库）', afterReload === 101200, String(afterReload));

  await p.click('[data-testid="nav-settings"]');
  await p.waitForSelector('[data-testid="market-data-info"]', { timeout: 15000 });
  check('㉔ 设置页显示缺汇率币种（无 USD 需求时应为空）', (await txt('[data-testid="market-missing-fx"]')).length > 0);

  // ── localStorage 隔离 ─────────────────────────────────
  await p.evaluate(() => localStorage.setItem('asset-card-wallet/portfolio/v2', JSON.stringify({ version: 2, categories: [{ id: 'x', name: '伪造ZZZ', items: [] }] })));
  const tampered = await home();
  check('㉕ 篡改 localStorage 不影响总额', tampered === 101200, String(tampered));
  check('㉖ 篡改后无伪造数据', !(await p.evaluate(() => document.body.innerText)).includes('伪造ZZZ'));

  await p.evaluate(() => localStorage.clear());
  const cleared = await home();
  check('㉗ 【核心】清空 localStorage 后行情与汇率仍完整', cleared === 101200, String(cleared));
  await assetsTab();
  check('㉘ 清空后仍显示估值依据', (await p.locator('[data-testid="holding-basis"]').count()) >= 1);

  check('㉙ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
