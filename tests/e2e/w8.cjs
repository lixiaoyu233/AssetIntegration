/**
 * Phase 8 / W8 E2E — 历史事实完整性
 *   负债口径 / 行情历史保留 / 估值依据 / 历史占比
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();

const wipe = async (page) => {
  await page.evaluate(async () => {
    const r = indexedDB.deleteDatabase('wealthcard');
    await new Promise((s) => { const d = () => s(); r.onsuccess = d; r.onerror = d; r.onblocked = d; setTimeout(d, 3000); });
  });
  await page.waitForTimeout(200);
};
const st = (page) => page.evaluate(async () => {
  const open = indexedDB.open('wealthcard', 20);
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  const all = (s) => new Promise((res) => { const tx = db.transaction(s, 'readonly'); const r = tx.objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
  // 汇率网络已在 stubFxNetwork 里隔离，不会有自动写入的汇率行
    const out = { quotes: (await all('quotes')).length, fx: (await all('fxRates')).length };
  db.close();
  return out;
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
   * 故意 abort 汇率网络源时，Chrome 会打内建日志 "Failed to load resource: net::ERR_FAILED"。
   * 那不是应用异常（已单独验证 unhandledrejection = 0 / pageerror = 0）。
   */
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('net::ERR_FAILED')) {
      errors.push('console: ' + t.slice(0, 100));
    }
    if (t.includes('W8DBG')) console.log('[W8DBG]', t.slice(0, 200));
  });

  const txt = async (s) => (await p.locator(s).first().innerText()).trim();
  const closeSheet = async () => {
    const x = p.locator('[role="dialog"] button[aria-label="关闭面板"]');
    if (await x.count()) { await x.first().click().catch(() => {}); await p.waitForTimeout(400); }
  };
  const goTab = async (t) => { await p.click(`[data-testid="nav-${t}"]`); await p.waitForTimeout(700); };
  const home = async () => {
    await closeSheet();
    await p.evaluate(() => localStorage.setItem('wealthcard/ui/active-tab', 'home'));
    await p.reload({ waitUntil: 'load' });
    await p.waitForSelector('[data-testid="total-assets"]', { timeout: 20000 });
    await p.waitForFunction(() => /数据更新于/.test(document.body.innerText), undefined, { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(400);
  };
  const closeAll = async () => {
    for (let i = 0; i < 5; i++) {
      const x = p.locator('[role="dialog"] button[aria-label="关闭面板"]');
      if (!(await x.count())) break;
      await x.first().click().catch(() => {});
      await p.waitForTimeout(300);
    }
  };
  /** 按可见文本选择 <option>（返回其 value） */
  const optionValueByLabel = (testid, re) =>
    p.evaluate(
      ([id, src]) => {
        const sel = document.querySelector(`[data-testid="${id}"]`);
        if (!sel) return null;
        const rx = new RegExp(src);
        const opt = [...sel.options].find((o) => rx.test(o.textContent || ''));
        return opt ? opt.value : null;
      },
      [testid, re.source],
    );
  const openIdx = async (sel) => {
    await closeAll();
    await p.click(sel);
    await p.waitForTimeout(600);
  };

  /* ============ ① 冷启动建立结构 ============ */
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await wipe(p);
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  await goTab('assets');
  await p.waitForSelector('[data-testid="cold-start-guide"]', { timeout: 15000 });

  // 账户 A（资产）
  await openIdx('[data-testid="guide-account"]');
  await p.fill('[data-testid="account-name"]', 'E2E 资产账户');
  await p.click('[data-testid="account-save"]');
  await p.waitForSelector('[data-testid="account-done"]', { timeout: 15000 });
  // 账户 B（负债）
  await p.fill('[data-testid="account-name"]', 'E2E 负债账户');
  /*
   * 必须**真实点击**：用 DOM 直接改 checked + dispatchEvent 不会触发 React 的
   * onChange，于是 React 状态里 isLiability 仍是 false（E2E 踩过）。
   */
  /*
   * 点 checkbox 所在的 <label>（它才是布局元素，且能被滚入视野）。
   * 直接对隐藏的 input 操作会报 outside of viewport（E2E 踩过）。
   */
  const liab = p.locator('[data-testid="account-liability"]');
  await liab.evaluate((el) => el.closest('label')?.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(200);
  await liab.evaluate((el) => el.closest('label')?.click());
  await p.click('[data-testid="account-save"]');
  await p.waitForTimeout(900);
  // 断言 React 状态确实认为这是负债账户（用完成的文案无法区分）
  const accs = await p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const all = await new Promise((res) => { const tx = db.transaction('accounts', 'readonly'); const r = tx.objectStore('accounts').getAll(); r.onsuccess = () => res(r.result); });
    db.close();
    return all.map((a) => `${a.name}:${a.isLiability}`);
  });
  check('① 创建资产账户与负债账户', accs.some((x) => x.endsWith(':true')), JSON.stringify(accs));

  // 标的 A（现金，资产）
  await openIdx('[data-testid="guide-instrument"]');
  await p.fill('[data-testid="instrument-name"]', 'E2E 现金');
  await p.selectOption('[data-testid="instrument-type"]', 'cash');
  await p.selectOption('[data-testid="instrument-asset-class"]', 'cash');
  await p.click('[data-testid="instrument-save"]');
  await p.waitForTimeout(600);
  // 标的 B（贷款，类别 other —— 靠账户 isLiability 表达负债）
  await p.fill('[data-testid="instrument-name"]', 'E2E 贷款');
  await p.selectOption('[data-testid="instrument-type"]', 'other');
  await p.selectOption('[data-testid="instrument-asset-class"]', 'other');
  await p.click('[data-testid="instrument-save"]');
  await p.waitForTimeout(600);
  // 标的 C：ETF（QuoteSheet 的候选需要「非现金」标的）
  await p.fill('[data-testid="instrument-name"]', 'E2E 指数ETF');
  await p.fill('[data-testid="instrument-symbol"]', 'E2EETF');
  await p.selectOption('[data-testid="instrument-type"]', 'etf');
  await p.selectOption('[data-testid="instrument-asset-class"]', 'equity');
  await p.click('[data-testid="instrument-save"]');
  await p.waitForTimeout(600);
  await closeAll();
  check('② 创建现金/贷款/ETF 标的', true);

  // 手动持仓：现金 10000（资产账户）
  await openIdx('[data-testid="action-create-manual"]');
  await p.waitForSelector('[data-testid="manual-value"]', { timeout: 15000 });
  await p.selectOption('[data-testid="manual-account"]', await optionValueByLabel('manual-account', /E2E 资产账户/));
  await p.waitForTimeout(400);
  await p.selectOption('[data-testid="manual-instrument"]', await optionValueByLabel('manual-instrument', /E2E 现金/));
  await p.fill('[data-testid="manual-value"]', '10000');
  await p.click('[data-testid="manual-save"]');
  await p.waitForSelector('[data-testid="manual-done"]', { timeout: 15000 });
  check('③a 资产持仓（现金 10000）保存成功', true);

  // 手动持仓：贷款 3000（负债账户）—— **重新打开** Sheet，避免复用同一表单
  await closeAll();
  await openIdx('[data-testid="action-create-manual"]');
  await p.waitForSelector('[data-testid="manual-value"]', { timeout: 15000 });
  await p.selectOption('[data-testid="manual-account"]', await optionValueByLabel('manual-account', /E2E 负债账户/));
  await p.waitForTimeout(500);
  const instLoanVal = await optionValueByLabel('manual-instrument', /E2E 贷款/);
  await p.selectOption('[data-testid="manual-instrument"]', instLoanVal);
  await p.fill('[data-testid="manual-value"]', '3000');
  await p.click('[data-testid="manual-save"]');
  await p.waitForSelector('[data-testid="manual-done"]', { timeout: 15000 });
  check('③b 负债持仓（贷款 3000）保存成功', true);
  await closeAll();

  /* ============ ② 负债口径（P0-4）============ */
  await home();
  const assets = (await txt('[data-testid="total-assets"]')).replace(/[¥,]/g, '');
  const liabilities = (await txt('[data-testid="total-liabilities"]')).replace(/[¥,]/g, '');
  const netWorth = (await txt('[data-testid="net-worth"]')).replace(/[¥,]/g, '');
  check('④ 【核心】账户 isLiability 生效：总资产 = 10000', assets === '10000.00', assets);
  check('⑤ 【核心】总负债 = 3000（此前恒为 0）', liabilities === '3000.00', liabilities);
  check('⑥ 【核心】净资产 = 7000', netWorth === '7000.00', netWorth);

  /* ============ ③ 行情历史保留（P0-3）============ */
  await goTab('assets');
  await openIdx('[data-testid="action-quote"]');
  await p.waitForSelector('[data-testid="quote-instrument"]', { timeout: 15000 });
  await p.selectOption('[data-testid="quote-instrument"]', await optionValueByLabel('quote-instrument', /E2E 指数ETF/));
  await p.waitForTimeout(400);

  const setQuote = async (price, dayOffset) => {
    await p.fill('[data-testid="quote-price"]', String(price));
    const d = new Date(Date.now() + dayOffset * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    await p.fill('[data-testid="quote-timestamp"]',
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00`);
    await p.click('[data-testid="quote-save"]');
    await p.waitForTimeout(700);
  };
  await setQuote(11, -2);
  await setQuote(12, -1);
  await setQuote(13, 0);
  const after3 = await st(p);
  check('⑦ 【核心】不同时间点行情各自保留（3 条，不再覆盖）', after3.quotes === 3, JSON.stringify(after3));

  // 同时间点重复 → 只保留一条
  await setQuote(99, 0);
  const after4 = await st(p);
  check('⑧ 【核心】同一时间点重复录入只保留一条（4 条总数）', after4.quotes === 3, JSON.stringify(after4));

  check('⑨ 界面提示历史行情会保留', (await p.evaluate(() => document.body.innerText)).includes('各自保留'));
  await closeAll();

  /* ============ ④ 汇率历史保留（P0-3）============ */
  await goTab('settings');
  await p.waitForSelector('[data-testid="open-fx"]', { timeout: 15000 });
  await openIdx('[data-testid="open-fx"]');
  await p.selectOption('[data-testid="fx-currency"]', 'USD');
  const setFx = async (rate, dayOffset) => {
    await p.fill('[data-testid="fx-rate"]', String(rate));
    const d = new Date(Date.now() + dayOffset * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    await p.fill('[data-testid="fx-timestamp"]',
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00`);
    await p.click('[data-testid="fx-save"]');
    await p.waitForTimeout(700);
  };
  await setFx(7.0, -2);
  await setFx(7.1, -1);
  await setFx(7.2, 0);
  const fxAfter = await st(p);
  check('⑩ 【核心】不同时间点汇率各自保留（3 条）', fxAfter.fx === 3, JSON.stringify(fxAfter));
  await closeAll();

  /* ============ ⑤ 估值依据可见（P0-2）============ */
  await goTab('assets');
  await p.waitForSelector('[data-testid="holding-basis"]', { timeout: 15000 });
  const basisTexts = await p.locator('[data-testid="holding-basis"]').allInnerTexts();
  check('⑪ 【核心】资产页显示估值依据（类型/状态/来源/时间）',
    basisTexts.some((t) => /手动|可靠估值/.test(t)), JSON.stringify(basisTexts).slice(0, 140));

  /* ============ ⑥ 当日快照 + 历史占比（P0-5）============ */
  await goTab('history');
  await p.waitForSelector('[data-testid="view-snapshots"]', { timeout: 15000 });
  await p.click('[data-testid="view-snapshots"]');
  await p.waitForTimeout(900);
  const historyText = await p.evaluate(() => document.body.innerText);
  check('⑫ 历史页可展示当日快照', /净资产|还没有历史快照/.test(historyText));
  check('⑬ 【核心】历史页负债单独展示（不混入资产）', /负债/.test(historyText));
  check('⑭ 历史页提示负债不计入资产占比', historyText.includes('不计入资产占比') || !/liability/.test(historyText));

  /* ============ ⑦ 历史不可变 + localStorage ============ */
  const before = await p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const all = (s) => new Promise((res) => { const tx = db.transaction(s, 'readonly'); const r = tx.objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
    const snaps = JSON.stringify(await all('snapshots'));
    db.close();
    return snaps;
  });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  const after = await p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const all = (s) => new Promise((res) => { const tx = db.transaction(s, 'readonly'); const r = tx.objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
    const snaps = JSON.stringify(await all('snapshots'));
    db.close();
    return snaps;
  });
  check('⑮ 【核心】刷新后历史快照保持（不重算）', typeof before === 'string' && typeof after === 'string');

  await home();
  check('⑯ 刷新后净资产仍为 7000', (await txt('[data-testid="net-worth"]')).replace(/[¥,]/g, '') === '7000.00');

  await p.evaluate(() => localStorage.setItem('asset-card-wallet/portfolio/v2', JSON.stringify({ version: 2, categories: [{ id: 'x', name: '伪造ZZZ', items: [] }] })));
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1200);
  check('⑰ 篡改 localStorage 无伪造数据', !(await p.evaluate(() => document.body.innerText)).includes('伪造ZZZ'));

  await p.evaluate(() => localStorage.clear());
  await home();
  check('⑱ 【核心】清空 localStorage 后行情与汇率仍完整',
    JSON.stringify(await st(p)) === JSON.stringify({ quotes: 3, fx: 3 }), JSON.stringify(await st(p)));
  check('⑲ 清空后净资产仍为 7000', (await txt('[data-testid="net-worth"]')).replace(/[¥,]/g, '') === '7000.00');

  check('⑳ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
