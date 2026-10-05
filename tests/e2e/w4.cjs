/**
 * Phase 8 / W4 E2E — 交易录入 / 流水 / 详情
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();



/** 播种：含现金 + 一个有行情的股票 */
const SEED = async (page) => {
  await page.evaluate(async () => {
    const req = indexedDB.deleteDatabase('wealthcard');
    await new Promise((res) => { const d = () => res(); req.onsuccess = d; req.onerror = d; req.onblocked = d; setTimeout(d, 3000); });
  });
  await page.waitForTimeout(200);
  return page.evaluate(async () => {
    const iso = new Date().toISOString();
    const open = indexedDB.open('wealthcard', 20);
    open.onupgradeneeded = (e) => {
      const db = e.target.result;
      const mk = (name, keyPath, indexes) => {
        if (db.objectStoreNames.contains(name)) return;
        const st = db.createObjectStore(name, { keyPath });
        for (const ix of indexes) st.createIndex(ix[0], ix[1], ix[2] || {});
      };
      mk('accounts', 'id', [['type','type'],['region','region']]);
      mk('instruments', 'id', [['instrumentType','instrumentType'],['assetClass','assetClass'],['currency','currency'],['classificationStatus','classificationStatus']]);
      mk('holdings', 'id', [['accountId','accountId'],['instrumentId','instrumentId'],['valuationMode','valuationMode']]);
      mk('transactions', 'id', [['accountId','accountId'],['instrumentId','instrumentId'],['type','type']]);
      mk('quotes', 'id', [['instrumentId','instrumentId'],['status','status']]);
      mk('fxRates', 'id', [['baseCurrency','baseCurrency'],['quoteCurrency','quoteCurrency']]);
      mk('snapshots', 'id', [['date','date',{unique:true}],['createdAt','createdAt']]);
      mk('allocationProfiles', 'id', []);
      mk('meta', 'key', []);
      mk('classificationAudit', 'id', [['instrumentId','instrumentId']]);
    };
    const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
    const put = (store, rows) => new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      rows.forEach((r) => tx.objectStore(store).put(r));
      tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
    });

    await put('accounts', [
      { id: 'a_cny', name: '示例人民币银行', type: 'bank', currency: 'CNY', region: 'CN', isLiability: false, createdAt: iso, updatedAt: iso },
      { id: 'a_hkd', name: '示例港币银行', type: 'bank', currency: 'HKD', region: 'HK', isLiability: false, createdAt: iso, updatedAt: iso },
    ]);
    await put('instruments', [
      { id: 'i_cny_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
      { id: 'i_hkd_cash', name: '港币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'HKD', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
      { id: 'i_stock', name: '示例股票', symbol: 'TEST', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
    ]);
    // 期初现金
    await put('transactions', [
      { id: 'seed1', accountId: 'a_cny', instrumentId: 'i_cny_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: iso },
      { id: 'seed2', accountId: 'a_hkd', instrumentId: 'i_hkd_cash', type: 'adjustment', quantity: 50000, amount: 50000, currency: 'HKD', timestamp: iso },
    ]);
    await put('holdings', [
      { id: 'h_cny', accountId: 'a_cny', instrumentId: 'i_cny_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000, averageCost: 1, createdAt: iso, updatedAt: iso },
      { id: 'h_hkd', accountId: 'a_hkd', instrumentId: 'i_hkd_cash', valuationMode: 'quantity', quantity: 50000, costBasis: 50000, averageCost: 1, createdAt: iso, updatedAt: iso },
    ]);
    await put('quotes', [{ id: 'q_stock', instrumentId: 'i_stock', priceKind: 'market_price', marketPrice: 10, currency: 'CNY', source: 'seed', timestamp: iso, status: 'LIVE' }]);
    await put('fxRates', [{ id: 'fx_hkd', baseCurrency: 'HKD', quoteCurrency: 'CNY', rate: 0.92, timestamp: iso, source: 'e2e', status: 'LIVE' }]);
    db.close();
    return 'SEED_OK';
  });
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...DEVICE, locale: 'zh-CN' });




  const p = await ctx.newPage()
  await stubFxNetwork(p);
  await stubQuoteNetwork(p);;
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(`${BASE}/`, { waitUntil: 'load' });
  check('⓪ 播种', (await SEED(p)) === 'SEED_OK');

  const txt = async (sel) => (await p.locator(sel).first().innerText()).trim();
  const assetsNum = async () => Number((await txt('[data-testid="total-assets"]')).replace(/[¥,]/g, ''));
  /** 先回首页再读总资产（total-assets 只在首页存在） */
  const homeAssetsNum = async () => {
    await p.click('[data-testid="nav-home"]');
    await p.waitForSelector('[data-testid="total-assets"]', { timeout: 15000 });
    return assetsNum();
  };

  await p.goto(`${BASE}/`, { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 20000 });
  const base = await assetsNum();
  check('① 期初总资产 = 100000 + 50000×0.92', base === 146000, String(base));

  const openSheet = async (type) => {
    await p.click('[data-testid="fab-record"]');
    await p.waitForSelector('[data-testid="tx-type-picker"]', { timeout: 15000 });
    await p.click(`[data-testid="tx-type-${type}"]`);
  };
  const closeSheet = async () => {
    await p.click('button[aria-label="关闭面板"]');
    await p.waitForTimeout(700);
    await p.click('[data-testid="nav-home"]');
    await p.waitForSelector('[data-testid="total-assets"]', { timeout: 15000 });
  };

  // ── DEPOSIT ────────────────────────────────────────────
  await openSheet('deposit');
  await p.selectOption('[data-testid="tx-account"]', 'a_cny');
  await p.selectOption('[data-testid="tx-cash"]', 'i_cny_cash');
  await p.fill('[data-testid="tx-amount"]', '5000');
  await p.click('[data-testid="tx-submit"]');
  await p.waitForSelector('[data-testid="tx-done"]', { timeout: 15000 });
  check('② 存入成功', (await txt('[data-testid="tx-done"]')).includes('存入'), await txt('[data-testid="tx-done"]'));
  await closeSheet();
  check('③ 存入后总资产 +5000', (await assetsNum()) === base + 5000, String(await assetsNum()));

  // ── BUY ────────────────────────────────────────────────
  await openSheet('buy');
  await p.selectOption('[data-testid="tx-account"]', 'a_cny');
  await p.selectOption('[data-testid="tx-cash"]', 'i_cny_cash');
  await p.selectOption('[data-testid="tx-instrument"]', 'i_stock');
  await p.fill('[data-testid="tx-quantity"]', '100');
  await p.fill('[data-testid="tx-price"]', '10');
  await p.click('[data-testid="tx-submit"]');
  await p.waitForSelector('[data-testid="tx-done"]', { timeout: 15000 });
  check('④ 买入成功（金额由数量×单价自动算出）', (await txt('[data-testid="tx-done"]')).includes('买入'));
  await closeSheet();
  check('⑤ 【守恒】买入后总资产不变（市价=成交价）', (await assetsNum()) === base + 5000, String(await assetsNum()));

  // ── SELL ───────────────────────────────────────────────
  await openSheet('sell');
  await p.selectOption('[data-testid="tx-account"]', 'a_cny');
  await p.selectOption('[data-testid="tx-cash"]', 'i_cny_cash');
  await p.selectOption('[data-testid="tx-instrument"]', 'i_stock');
  await p.fill('[data-testid="tx-quantity"]', '40');
  await p.fill('[data-testid="tx-price"]', '12');
  await p.click('[data-testid="tx-submit"]');
  await p.waitForSelector('[data-testid="tx-done"]', { timeout: 15000 });
  check('⑥ 卖出成功', (await txt('[data-testid="tx-done"]')).includes('卖出'));
  await closeSheet();
  const afterSell = await assetsNum();
  check('⑦ 卖出 40@12（市价 10）：现金 +480，持仓 −400 → 净 +80', afterSell === base + 5000 + 80, String(afterSell));

  // ── 超卖拒绝 ───────────────────────────────────────────
  await openSheet('sell');
  await p.selectOption('[data-testid="tx-account"]', 'a_cny');
  await p.selectOption('[data-testid="tx-cash"]', 'i_cny_cash');
  await p.selectOption('[data-testid="tx-instrument"]', 'i_stock');
  await p.fill('[data-testid="tx-quantity"]', '9999');
  await p.fill('[data-testid="tx-price"]', '10');
  await p.click('[data-testid="tx-submit"]');
  await p.waitForSelector('[data-testid="tx-error"]', { timeout: 15000 });
  check('⑧ 【核心】超卖被拒绝并给出原因', (await txt('[data-testid="tx-error"]')).includes('可卖'), await txt('[data-testid="tx-error"]'));
  await p.click('button[aria-label="关闭面板"]');
  await p.waitForTimeout(500);
  await p.click('[data-testid="nav-home"]');
  await p.waitForSelector('[data-testid="total-assets"]', { timeout: 15000 });
  check('⑨ 【核心】被拒后总资产不变', (await assetsNum()) === afterSell, String(await assetsNum()));

  // ── TRANSFER ───────────────────────────────────────────
  await openSheet('transfer');
  await p.selectOption('[data-testid="tx-account"]', 'a_cny');
  await p.selectOption('[data-testid="tx-instrument"]', 'i_cny_cash');
  await p.selectOption('[data-testid="tx-to-account"]', 'a_hkd');
  await p.fill('[data-testid="tx-quantity"]', '20000');
  await p.click('[data-testid="tx-submit"]');
  await p.waitForSelector('[data-testid="tx-done"]', { timeout: 15000 });
  check('⑩ 划转成功', (await txt('[data-testid="tx-done"]')).includes('划转'));
  await closeSheet();
  check('⑪ 【核心】划转后总资产不变（非外部现金流）', (await assetsNum()) === afterSell, String(await assetsNum()));

  // ── 流水与详情 ─────────────────────────────────────────
  await p.click('[data-testid="nav-history"]');
  await p.waitForSelector('[data-testid="flows-view"]', { timeout: 15000 });
  const rows = await p.locator('[data-testid="flow-row"]').count();
  check('⑫ 流水列出全部交易', rows === 6, `${rows} 笔`);

  await p.selectOption('[data-testid="filter-type"]', 'buy');
  await p.waitForTimeout(400);
  check('⑬ 按类型筛选生效', (await p.locator('[data-testid="flow-row"]').count()) === 1);
  await p.selectOption('[data-testid="filter-type"]', '');

  await p.locator('[data-testid="flow-row"]').first().click();
  await p.waitForSelector('[data-testid="tx-detail-fields"]', { timeout: 15000 });
  check('⑭ 交易详情可打开', true);
  check('⑮ 详情显示外部现金流归属', (await txt('[data-testid="tx-detail-flow"]')).includes('外部现金流'));
  check('⑯ 详情显示 Ledger Effects', (await p.locator('[data-testid="tx-detail-effects"]').count()) > 0
    || (await p.locator('[data-testid="tx-detail-no-effects"]').count()) > 0);
  await p.click('[data-testid="tx-detail-close"]');

  // ── localStorage 隔离 ──────────────────────────────────
  const beforeTamper = await homeAssetsNum();
  await p.evaluate(() => localStorage.setItem('asset-card-wallet/portfolio/v2', JSON.stringify({ version: 2, categories: [{ id: 'x', name: '伪造ZZZ', items: [] }] })));
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  // 应用会记住上次所在 Tab，因此先遍历所有 Tab 检查，再回首页断言金额
  let sawFake = false;
  for (const t of ['home', 'assets', 'analysis', 'history', 'settings']) {
    await p.click(`[data-testid="nav-${t}"]`);
    await p.waitForTimeout(250);
    if ((await p.evaluate(() => document.body.innerText)).includes('伪造ZZZ')) sawFake = true;
  }
  await p.click('[data-testid="nav-home"]');
  await p.waitForSelector('[data-testid="total-assets"]', { timeout: 15000 });
  check('⑰ 篡改 localStorage 后所有 Tab 均无伪造数据', !sawFake);
  check('⑱ 篡改后总资产仍正确', (await assetsNum()) === beforeTamper, String(await assetsNum()));

  await p.evaluate(() => localStorage.clear());
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.click('[data-testid="nav-home"]');
  await p.waitForSelector('[data-testid="total-assets"]', { timeout: 15000 });
  check('⑲ 清空 localStorage 后数据仍完整', (await assetsNum()) === beforeTamper, String(await assetsNum()));

  check('⑳ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
