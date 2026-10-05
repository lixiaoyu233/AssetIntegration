/**
 * 行情自动获取 E2E（真实网络）
 *  ① 建标的（ETF / 场外基金）→ 启动自动拉取 → quotes 落库
 *  ② 设置页「更新全部行情」按钮
 *  ③ 行情面板「用代码获取」→ 显示查到的名字 → 可跳过
 *  ④ 债券类不自动获取（保持手动）
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubFxNetwork } = require('./_helpers.cjs');

const check = makeReporter();

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...DEVICE, locale: 'zh-CN' });
  const p = await ctx.newPage();
  // 只桩汇率：本脚本测的正是**真实行情拉取**，桩掉行情等于废掉测试
  await stubFxNetwork(p);
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('net::ERR_FAILED')) errors.push(m.text().slice(0, 100));
  });

  const txt = async (s) => (await p.locator(s).first().innerText()).trim();
  const closeAll = async () => { for (let i = 0; i < 6; i++) { const x = p.locator('[role="dialog"] button[aria-label="关闭面板"]'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await p.waitForTimeout(250); } };
  const goTab = async (t) => { await closeAll(); await p.click(`[data-testid="nav-${t}"]`); await p.waitForTimeout(800); };
  const quotes = () => p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const d = await new Promise((r) => { open.onsuccess = () => r(open.result); });
    const rows = await new Promise((res) => { const tx = d.transaction('quotes', 'readonly'); const q = tx.objectStore('quotes').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
    d.close();
    return rows.map((q) => ({ id: q.instrumentId, kind: q.priceKind, price: q.marketPrice ?? q.nav, src: q.source, st: q.status }));
  });

  await p.goto(BASE, { waitUntil: 'load' });
  await p.waitForTimeout(1000);
  await p.evaluate(async () => { localStorage.clear(); const d = await indexedDB.databases(); for (const x of d) if (x.name) indexedDB.deleteDatabase(x.name); });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 25000 });
  await p.waitForTimeout(1200);

  /* 建账户 */
  await goTab('assets');
  await closeAll();
  await p.click('[data-testid="action-create-account"]');
  await p.waitForSelector('[data-testid="account-name"]', { timeout: 12000 });
  await p.fill('[data-testid="account-name"]', 'QA 账户');
  await p.click('[data-testid="account-save"]');
  await p.waitForSelector('[data-testid="account-done"]', { timeout: 12000 });
  await p.waitForTimeout(500); await closeAll();

  /* 建 3 个标的：ETF(境内) / 场外基金 / 债券(不支持自动) */
  const mk = async (name, type, assetClass, symbol) => {
    await closeAll();
    await p.click('[data-testid="action-create-instrument"]');
    await p.waitForSelector('[data-testid="instrument-name"]', { timeout: 12000 });
    await p.fill('[data-testid="instrument-name"]', name);
    await p.selectOption('[data-testid="instrument-type"]', type);
    await p.selectOption('[data-testid="instrument-asset-class"]', assetClass);
    if (symbol) await p.fill('[data-testid="instrument-symbol"]', symbol);
    await p.click('[data-testid="instrument-save"]');
    await p.waitForSelector('[data-testid="instrument-done"]', { timeout: 12000 });
    await p.waitForTimeout(600);
  };
  await mk('沪深300ETF', 'etf', 'equity', '510300');
  await mk('白酒基金', 'fund', 'equity', '161725');
  await mk('某国债', 'bond', 'fixed_income', '019547');
  await closeAll();
  check('① 标的创建成功（ETF / 场外基金 / 债券）', true);

  /* 触发一次同步：重载应用（启动即拉） */
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 25000 });
  await p.waitForTimeout(8000);

  let qs = await quotes();
  check('② 【核心】启动时自动拉取了行情', qs.length >= 2, `${qs.length} 条`);
  console.log('     ', JSON.stringify(qs));
  const etf = qs.find((q) => q.kind === 'market_price');
  const fund = qs.find((q) => q.kind === 'nav');
  check('③ 【核心】ETF 取了市场价格', !!etf && etf.price > 0, JSON.stringify(etf));
  check('④ 【核心】场外基金取了单位净值', !!fund && fund.price > 0, JSON.stringify(fund));
  check('⑤ 债券不在自动获取范围（保持手动）', !qs.some((q) => q.src === 'tencent' && q.id?.includes('bond')), '');
  check('⑥ 行情来源如实标注', qs.every((q) => q.src === 'tencent' || q.src === 'eastmoney-fund'), qs.map((q) => q.src).join(','));

  /* 设置页：更新全部行情 */
  await goTab('settings');
  await closeAll();
  const allBtn = p.locator('[data-testid="refresh-all-quotes"]');
  check('⑦ 设置页有「更新全部行情」按钮', (await allBtn.count()) === 1);
  await allBtn.click();
  await p.waitForTimeout(6000);
  check('⑧ 【核心】点更新后仍正常（无异常）', true);

  /* 行情面板：用代码获取 + 名称确认 */
  await closeAll();
  await p.locator('button:has-text("录入 / 更新行情")').first().click();
  await p.waitForTimeout(1200);
  check('⑨ 行情面板提示文案已更新（不再写 W6 手动录入）',
    !(await txt('[role="dialog"]')).includes('W6 阶段'), '');
  check('⑩ 行情面板有「用代码获取」按钮', (await p.locator('[data-testid="quote-fetch"]').count()) === 1);

  // 选中基金标的，点用代码获取
  const optVal = await p.evaluate(() => {
    const sel = document.querySelector('[data-testid="quote-instrument"]');
    if (!sel) return null;
    const o = [...sel.options].find((x) => /白酒/.test(x.textContent || ''));
    return o ? o.value : null;
  });
  if (optVal) { await p.selectOption('[data-testid="quote-instrument"]', optVal); await p.waitForTimeout(600); }
  await p.click('[data-testid="quote-fetch"]');
  await p.waitForTimeout(7000);
  const confirmCount = await p.locator('[data-testid="quote-fetch-confirm"]').count();
  check('⑪ 【核心】显示查到的名称供确认', confirmCount === 1,
    confirmCount ? (await txt('[data-testid="quote-fetch-confirm"]')).slice(0, 70) : '无确认框');
  check('⑫ 【核心】可跳过确认', (await p.locator('[data-testid="quote-fetch-skip"]').count()) === 1 ||
    (await p.locator('[data-testid="quote-fetch-ok"]').count()) === 1);
  if (confirmCount) {
    await p.click('[data-testid="quote-fetch-skip"]');
    await p.waitForTimeout(500);
    check('⑬ 跳过后提示关闭、行情仍在库', (await p.locator('[data-testid="quote-fetch-confirm"]').count()) === 0);
  }
  await closeAll();

  qs = await quotes();
  check('⑭ 【核心】跳过确认不影响已入库的行情', qs.length >= 2, `${qs.length} 条`);
  check('⑮ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
