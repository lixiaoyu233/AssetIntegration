/**
 * Phase 8 / W3 E2E — 正式入口 + 五个 Tab + 业务操作 Sheet
 *
 * 断言的是**业务事实**，不依赖旧 UI 的 DOM 结构。
 */
const { BASE, DEVICE, chromium, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();



/** 自包含播种：Dexie 的 IndexedDB 版本号 = DB_VERSION(2) × 10 = 20 */
const SEED = async (page) => {
  await page.evaluate(async () => {
    const req = indexedDB.deleteDatabase('wealthcard');
    await new Promise((res) => {
      const done = () => res();
      req.onsuccess = done; req.onerror = done; req.onblocked = done;
      setTimeout(done, 3000);
    });
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
      { id: 'a_cn', name: '示例内地银行', type: 'bank', currency: 'CNY', region: 'CN', isLiability: false, createdAt: iso, updatedAt: iso },
      { id: 'a_hk', name: '示例香港券商', type: 'broker', currency: 'HKD', region: 'HK', isLiability: false, createdAt: iso, updatedAt: iso },
    ]);
    await put('instruments', [
      { id: 'i_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
      { id: 'i_etf', name: '示例美股ETF', symbol: 'TESTX', instrumentType: 'etf', assetClass: 'equity', currency: 'USD', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
      { id: 'i_unknown', name: '示例待确认资产', instrumentType: 'other', assetClass: 'other', currency: 'CNY', classificationStatus: 'unconfirmed', createdAt: iso, updatedAt: iso },
      { id: 'i_manualcash', name: '示例活期存款', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
    ]);
    await put('holdings', [
      { id: 'h_cash', accountId: 'a_cn', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000, createdAt: iso, updatedAt: iso },
      { id: 'h_etf', accountId: 'a_hk', instrumentId: 'i_etf', valuationMode: 'quantity', quantity: 100, costBasis: 6000, createdAt: iso, updatedAt: iso },
      { id: 'h_unknown', accountId: 'a_cn', instrumentId: 'i_unknown', valuationMode: 'manual', manualValue: 30000, createdAt: iso, updatedAt: iso },
      { id: 'h_manualcash', accountId: 'a_cn', instrumentId: 'i_manualcash', valuationMode: 'manual', manualValue: 25000, createdAt: iso, updatedAt: iso },
    ]);
    await put('quotes', [{ id: 'q_etf', instrumentId: 'i_etf', priceKind: 'market_price', marketPrice: 80, currency: 'USD', source: 'seed', timestamp: iso, status: 'LIVE' }]);
    await put('fxRates', [{ id: 'fx_usd', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: iso, source: 'e2e', status: 'LIVE' }]);
    await put('transactions', [
      { id: 't1', accountId: 'a_cn', instrumentId: 'i_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: iso },
      { id: 't2', accountId: 'a_hk', instrumentId: 'i_etf', type: 'adjustment', quantity: 100, amount: 6000, currency: 'USD', timestamp: iso },
    ]);
    db.close();
    return 'SEED_OK';
  });
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...require('playwright').devices['iPhone 13 Pro'], locale: 'zh-CN' });




  const p = await ctx.newPage()
  await stubFxNetwork(p);
  await stubQuoteNetwork(p);;
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(`${BASE}/`, { waitUntil: 'load' });
  const seedResult = await SEED(p);
  check('⓪ IndexedDB 播种成功', seedResult === 'SEED_OK', seedResult);

  // ── 1. 正式入口 ────────────────────────────────────────────
  await p.goto(`${BASE}/`, { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 20000 });
  check('① 无参数即进入正式应用（无需 ?w2=1）', true, await p.locator('[data-testid="net-worth"]').first().innerText());

  const tabs = await p.locator('[data-testid^="nav-"]').evaluateAll((els) => els.map((e) => e.dataset.testid));
  check('② 五个正式 Tab', tabs.length === 5, tabs.join(' / '));

  // 金额基线
  const txt = async (sel) => (await p.locator(sel).first().innerText()).trim();
  const baseNetWorth = await txt('[data-testid="net-worth"]');
  const baseAssets = await txt('[data-testid="total-assets"]');
  check('③ 总资产 = 100000 + 57600 + 30000 + 25000', baseAssets.replace(/[¥,]/g, '') === '212600.00', baseAssets);

  // ── 2. 分类确认链路 ────────────────────────────────────────
  await p.click('[data-testid="nav-assets"]');
  await p.waitForSelector('[data-testid="asset-actions"]', { timeout: 15000 });
  check('④ 资产页显示业务操作入口', true);
  check('⑤ 显示待确认数量', (await txt('[data-testid="action-classify"]')).includes('待确认'), await txt('[data-testid="action-classify"]'));

  await p.click('[data-testid="action-classify"]');
  await p.waitForSelector('[data-testid="classify-list"]', { timeout: 15000 });
  check('⑥ ClassifySheet 打开并列出待确认项', (await p.locator('[data-testid="classify-row"]').count()) === 1);

  // 未选择时确认按钮禁用（不会自动分类）
  const disabledBefore = await p.locator('[data-testid="classify-confirm-one"]').first().isDisabled();
  check('⑦ 未选择类别时确认按钮禁用（绝不自动分类）', disabledBefore);

  await p.locator('[data-testid="classify-select"]').first().selectOption('fixed_income');
  await p.click('[data-testid="classify-confirm-one"]');
  await p.waitForSelector('[data-testid="classify-done"]', { timeout: 10000 });
  check('⑧ 确认后给出成功反馈', (await txt('[data-testid="classify-done"]')).includes('已确认'));

  await p.click('[role="dialog"] button[aria-label="关闭面板"]');
  await p.waitForTimeout(600);

  // total-assets 只在首页存在，先回首页再断言
  await p.click('[data-testid="nav-home"]');
  await p.waitForSelector('[data-testid="total-assets"]', { timeout: 15000 });
  const afterClassifyAssets = await txt('[data-testid="total-assets"]');
  check('⑨ 【核心】确认分类后总资产不变', afterClassifyAssets === baseAssets, `${afterClassifyAssets} vs ${baseAssets}`);
  check('⑩ 【核心】首页净资产也不变', (await txt('[data-testid="net-worth"]')) === baseNetWorth);
  check('⑪ 待确认数量降为 0', (await txt('[data-testid="unconfirmed-count"]')) === '0 项');
  check('⑫ 类别分布出现「固收」', (await txt('[data-testid="by-asset-class"]')).includes('固收'));

  // ── 3. 现金转换 ────────────────────────────────────────────
  await p.click('[data-testid="nav-assets"]');
  await p.waitForSelector('[data-testid="asset-actions"]', { timeout: 15000 });
  await p.click('[data-testid="action-cash"]');
  await p.waitForSelector('[data-testid="cash-list"]', { timeout: 15000 });
  const cashRows = await p.locator('[data-testid="cash-row"]').count();
  check('⑬ CashConvertSheet 列出可转换现金', cashRows === 1, `${cashRows} 项`);

  await p.click('[data-testid="cash-convert"]');
  await p.click('[data-testid="cash-confirm"]');
  await p.waitForSelector('[data-testid="cash-done"]', { timeout: 20000 });
  check('⑭ 转换成功并说明金额不变', (await txt('[data-testid="cash-done"]')).includes('保持不变'), await txt('[data-testid="cash-done"]'));

  await p.click('[role="dialog"] button[aria-label="关闭面板"]');
  await p.waitForTimeout(600);
  await p.click('[data-testid="nav-home"]');
  await p.waitForSelector('[data-testid="total-assets"]', { timeout: 15000 });
  check('⑮ 【核心】转换后总资产不变', (await txt('[data-testid="total-assets"]')) === baseAssets, await txt('[data-testid="total-assets"]'));

  // ── 4. 设置 / 重复检测 ─────────────────────────────────────
  await p.click('[data-testid="nav-settings"]');
  await p.waitForSelector('[data-testid="storage-info"]', { timeout: 15000 });
  check('⑯ 设置页显示 Schema 版本', (await txt('[data-testid="schema-version"]')).startsWith('V'), await txt('[data-testid="schema-version"]'));
  check('⑰ 设置页显示 DB 版本', (await txt('[data-testid="db-version"]')).startsWith('DB v'), await txt('[data-testid="db-version"]'));

  await p.click('[data-testid="open-duplicates"]');
  await p.waitForSelector('[data-testid="duplicate-empty"], [data-testid="duplicate-list"]', { timeout: 15000 });
  check('⑱ DuplicateSheet 可打开', true);
  check('⑲ 无重复时给出明确结论', (await p.locator('[data-testid="duplicate-empty"]').count()) === 1);
  await p.click('[data-testid="duplicate-close"]');

  // ── 5. 分析 / 历史 Tab ─────────────────────────────────────
  await p.click('[data-testid="nav-analysis"]');
  await p.waitForSelector('[data-testid="analysis-total"]', { timeout: 15000 });
  const dimCards = await p.locator('[data-testid^="dim-card-"]').count();
  check('⑳ 分析页六个维度卡片', dimCards === 6, `${dimCards} 个`);

  await p.click('[data-testid="nav-history"]');
  // W4 起历史页默认为「交易流水」二级视图；快照视图需切换
  await p.waitForSelector('[data-testid="flows-view"]', { timeout: 15000 });
  check('㉑ 历史页展示交易流水视图', true);
  await p.click('[data-testid="view-snapshots"]');
  await p.waitForSelector('[data-testid="history-empty"], [data-testid="history-list"]', { timeout: 15000 });
  check('㉑b 历史页可切换到资产快照（含空态）', true);

  // ── 6. localStorage 隔离 ───────────────────────────────────
  await p.evaluate(() => {
    localStorage.setItem('asset-card-wallet/portfolio/v2',
      JSON.stringify({ version: 2, categories: [{ id: 'fake', name: '伪造XYZ', items: [] }] }));
  });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.click('[data-testid="nav-home"]');
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 20000 });
  const bodyAfter = await p.evaluate(() => document.body.innerText);
  // 遍历所有 Tab 都不应出现伪造数据
  let sawFake = false;
  for (const t of ['home', 'assets', 'analysis', 'history', 'settings']) {
    await p.click(`[data-testid="nav-${t}"]`);
    await p.waitForTimeout(300);
    if ((await p.evaluate(() => document.body.innerText)).includes('伪造XYZ')) sawFake = true;
  }
  await p.click('[data-testid="nav-home"]');
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 15000 });
  check('㉒ 篡改 localStorage 后所有 Tab 均不出现伪造数据', !sawFake && !bodyAfter.includes('伪造XYZ'));
  check('㉓ 篡改后净资产仍正确', (await txt('[data-testid="net-worth"]')) === baseNetWorth);

  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.click('[data-testid="nav-home"]');
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 20000 });
  check('㉔ 清空 localStorage 后数据仍完整', (await txt('[data-testid="net-worth"]')) === baseNetWorth);

  check('㉕ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
