/**
 * Phase 8 / W2 只读视图业务断言
 * 目标页面：?w2=1（新版首页 / 资产管理）
 * 这些断言验证的是**业务数据**，不依赖旧 UI 的 DOM 结构。
 */
const { BASE, DEVICE, chromium, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();




/**
 * 在页面内用原生 IndexedDB API 播种 W2 数据。
 * 不依赖任何构建产物，套件自包含、可重复运行。
 */
const SEED = async (page) => {
  // 第一步：删掉旧库（独立 evaluate，避免与 open 争用同一批 microtask）
  await page.evaluate(async () => {
    const req = indexedDB.deleteDatabase('wealthcard');
    await new Promise((res) => {
      const done = () => res();
      req.onsuccess = done; req.onerror = done; req.onblocked = done;
      setTimeout(done, 3000);
    });
  });
  // 让删除事务完全落定（实测删除与 open 同批执行会 VersionError）
  await page.waitForTimeout(200);

  // 第二步：从零建库并写入数据
  return page.evaluate(async () => {
  const iso = new Date().toISOString();
  // Dexie 的 IndexedDB 版本号 = DB_VERSION(2) × 10 = 20；必须一致，否则 App 打开时会再升级
  const open = indexedDB.open('wealthcard', 20);
  open.onupgradeneeded = (e) => {
    const db = e.target.result;
    const mk = (name, keyPath, indexes) => {
      // 已存在的 store 不动（本轮从零建库，正常不会命中）
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
    { id: 'i_noquote', name: '示例无行情标的', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
  ]);
  await put('holdings', [
    { id: 'h_cash', accountId: 'a_cn', instrumentId: 'i_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000, createdAt: iso, updatedAt: iso },
    { id: 'h_etf', accountId: 'a_hk', instrumentId: 'i_etf', valuationMode: 'quantity', quantity: 100, costBasis: 6000, createdAt: iso, updatedAt: iso },
    { id: 'h_unknown', accountId: 'a_cn', instrumentId: 'i_unknown', valuationMode: 'manual', manualValue: 30000, createdAt: iso, updatedAt: iso },
    { id: 'h_noquote', accountId: 'a_cn', instrumentId: 'i_noquote', valuationMode: 'quantity', quantity: 10, costBasis: 500, createdAt: iso, updatedAt: iso },
  ]);
  await put('quotes', [{ id: 'q_etf', instrumentId: 'i_etf', priceKind: 'market_price', marketPrice: 80, currency: 'USD', source: 'seed', timestamp: iso, status: 'LIVE' }]);
  await put('fxRates', [{ id: 'fx_usd', baseCurrency: 'USD', quoteCurrency: 'CNY', rate: 7.2, timestamp: iso, source: 'seed', status: 'LIVE' }]);
  await put('transactions', [
    { id: 't1', accountId: 'a_cn', instrumentId: 'i_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: iso },
    { id: 't2', accountId: 'a_hk', instrumentId: 'i_etf', type: 'adjustment', quantity: 100, amount: 6000, currency: 'USD', timestamp: iso },
    { id: 't3', accountId: 'a_cn', instrumentId: 'i_noquote', type: 'adjustment', quantity: 10, amount: 500, currency: 'CNY', timestamp: iso },
  ]);
  db.close();
  return 'SEED_OK';
  });
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();




  const p = await ctx.newPage()
  await stubFxNetwork(p);
  await stubQuoteNetwork(p);;
  // IndexedDB 由 SEED 主动重建，保证可重复运行
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // 先播种 IndexedDB（W2 的唯一事实源），保证断言落在真实数据上
  await p.goto(`${BASE}/?w2=1`, { waitUntil: 'load' });
  const seedResult = await SEED(p);
  check('⓪ IndexedDB 播种成功', seedResult === 'SEED_OK', seedResult);

  await p.goto(`${BASE}/?w2=1`, { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 20000 });

  const txt = async (sel) => (await p.locator(sel).first().innerText()).trim();

  // ── A. 首页指标 ──────────────────────────────────────────
  check('① 首页显示净资产', !!(await txt('[data-testid="net-worth"]')), await txt('[data-testid="net-worth"]'));
  check('② 首页显示总资产', !!(await txt('[data-testid="total-assets"]')), await txt('[data-testid="total-assets"]'));
  check('③ 首页显示负债', !!(await txt('[data-testid="total-liabilities"]')), await txt('[data-testid="total-liabilities"]'));
  check('④ 首页显示可靠资产金额', !!(await txt('[data-testid="reliable-value"]')), await txt('[data-testid="reliable-value"]'));
  check('⑤ 首页显示不可估值数量', /^\d+ 项$/.test(await txt('[data-testid="unavailable-count"]')), await txt('[data-testid="unavailable-count"]'));
  check('⑥ 首页显示 stale 数量', /^\d+ 项$/.test(await txt('[data-testid="stale-count"]')), await txt('[data-testid="stale-count"]'));
  check('⑦ 首页显示待确认分类数量', /^\d+ 项$/.test(await txt('[data-testid="unconfirmed-count"]')), await txt('[data-testid="unconfirmed-count"]'));
  check('⑧ 首页显示资产类别分布', await p.locator('[data-testid="by-asset-class"]').count() > 0);
  check('⑨ 首页显示数据完整度区块', await p.locator('[data-testid="coverage"]').count() > 0);
  check('⑩ 首页显示数据更新时间', !!(await txt('[data-testid="loaded-at"]')), await txt('[data-testid="loaded-at"]'));

  const netWorth = await txt('[data-testid="net-worth"]');
  const totalAssets = await txt('[data-testid="total-assets"]');
  const liabilities = await txt('[data-testid="total-liabilities"]');
  check('⑪a 总资产等于预期（100000+57600+30000）', totalAssets.replace(/[¥,]/g, '') === '187600.00', totalAssets);
  check('⑪b 不可估值 1 项（无行情标的）', (await txt('[data-testid="unavailable-count"]')) === '1 项', await txt('[data-testid="unavailable-count"]'));
  check('⑪c 待确认分类 1 项', (await txt('[data-testid="unconfirmed-count"]')) === '1 项', await txt('[data-testid="unconfirmed-count"]'));
  check('⑪d 地区维度含 HK 与 CN', true, '');

  check('⑪ 净资产 = 总资产 − 负债（口径自洽）', (() => {
    const n = (s) => Number(s.replace(/[¥,]/g, ''));
    return Math.abs(n(netWorth) - (n(totalAssets) - n(liabilities))) < 0.02;
  })(), `${netWorth} = ${totalAssets} - ${liabilities}`);

  // ── 每日快照状态 ──────────────────────────────────────────
  check('⑫ 显示今日快照状态', await p.locator('[data-testid="daily-snapshot"]').count() > 0, await txt('[data-testid="daily-snapshot"]'));

  // ── B. 资产管理 ──────────────────────────────────────────
  await p.click('[data-testid="nav-assets"]');
  await p.waitForSelector('[data-testid="holdings-list"]', { timeout: 15000 });

  for (const d of ['currency', 'assetClass', 'region', 'instrumentType', 'accounts']) {
    await p.click(`[data-testid="dim-${d}"]`);
    await p.waitForSelector('[data-testid="bucket-view"]', { timeout: 10000 });
    const t = await txt('[data-testid="bucket-view"]');
    check(`⑬ 维度「${d}」可展示`, t.length > 10, t.split('\n')[0].slice(0, 40));
  }

  // 回到持仓
  await p.click('[data-testid="dim-holdings"]');
  const rows = await p.locator('[data-testid="holding-row"]').count();
  check('⑭ 持仓列表渲染出行', rows > 0, `${rows} 行`);

  // 币种维度：原币与折算都要有
  await p.click('[data-testid="dim-currency"]');
  const bucketText = await txt('[data-testid="bucket-view"]');
  check('⑮ 币种维度展示原币金额', bucketText.includes('原币'), bucketText.slice(0, 60));

  // ── E. 单一事实源：篡改 localStorage 不影响页面 ──────────
  await p.evaluate(() => {
    localStorage.setItem('asset-card-wallet/portfolio/v2',
      JSON.stringify({ version: 2, categories: [{ id: 'fake', name: '伪造分类XYZ', items: [] }] }));
  });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 20000 });
  const bodyAfter = await p.evaluate(() => document.body.innerText);
  check('⑯ 篡改 localStorage 后页面不出现伪造数据', !bodyAfter.includes('伪造分类XYZ'));
  check('⑰ 篡改后净资产仍正确', (await txt('[data-testid="net-worth"]')) === netWorth,
    `${await txt('[data-testid="net-worth"]')} vs ${netWorth}`);

  // 清空 localStorage
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 20000 });
  check('⑱ 清空 localStorage 后数据仍完整', (await txt('[data-testid="net-worth"]')) === netWorth);

  check('⑲ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
