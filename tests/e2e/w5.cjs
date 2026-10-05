/**
 * Phase 8 / W5 E2E — 交易作废（Void）
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();

const SEED = async (page) => {
  await page.evaluate(async () => {
    const req = indexedDB.deleteDatabase('wealthcard');
    await new Promise((r) => { const d = () => r(); req.onsuccess = d; req.onerror = d; req.onblocked = d; setTimeout(d, 3000); });
  });
  await page.waitForTimeout(200);
  return page.evaluate(async () => {
    const iso = new Date().toISOString();
    const open = indexedDB.open('wealthcard', 20);
    open.onupgradeneeded = (e) => {
      const db = e.target.result;
      const mk = (n, k, idx) => {
        if (db.objectStoreNames.contains(n)) return;
        const st = db.createObjectStore(n, { keyPath: k });
        for (const i of idx) st.createIndex(i[0], i[1], i[2] || {});
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
    const put = (s, rows) => new Promise((res, rej) => {
      const tx = db.transaction(s, 'readwrite');
      rows.forEach((r) => tx.objectStore(s).put(r));
      tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
    });
    await put('accounts', [
      { id: 'a_cny', name: '示例人民币银行', type: 'bank', currency: 'CNY', region: 'CN', isLiability: false, createdAt: iso, updatedAt: iso },
    ]);
    await put('instruments', [
      { id: 'i_cny_cash', name: '人民币现金', instrumentType: 'cash', assetClass: 'cash', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
      { id: 'i_stock', name: '示例股票', symbol: 'TEST', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso },
    ]);
    await put('transactions', [
      /*
       * 期初余额刻意用**明显更早**的日期。
       * 若与买入同为「今天」，倒序排序结果不确定，
       * 测试点 `first()` 可能点到 adjustment —— 那会作废期初余额
       * （踩过：导致现金 -1000、总资产错误地变成 0）。
       */
      { id: 'seed_cash', accountId: 'a_cny', instrumentId: 'i_cny_cash', type: 'adjustment', quantity: 100000, amount: 100000, currency: 'CNY', timestamp: '2026-01-05T10:00:00.000Z' },
    ]);
    await put('holdings', [
      { id: 'h_cash', accountId: 'a_cny', instrumentId: 'i_cny_cash', valuationMode: 'quantity', quantity: 100000, costBasis: 100000, averageCost: 1, createdAt: iso, updatedAt: iso },
    ]);
    await put('quotes', [{ id: 'q_stock', instrumentId: 'i_stock', priceKind: 'market_price', marketPrice: 10, currency: 'CNY', source: 'seed', timestamp: iso, status: 'LIVE' }]);
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

  const txt = async (s) => (await p.locator(s).first().innerText()).trim();
  /** 轮询等待某条件成立（异步 reload 完成需要时间，固定 sleep 不可靠） */
  const until = async (fn, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await fn()) return true;
      await p.waitForTimeout(150);
    }
    return false;
  };
  const statusList = () =>
    p.locator('[data-testid="flow-status"]').evaluateAll((els) => els.map((e) => e.textContent.trim()));
  const homeAssets = async () => {
    /*
     * 确定性回到首页并读取总资产。
     *
     * 踩过的四个坑：
     * 1) 点底部导航会被打开的 Sheet 遮挡
     * 2) `goto` 同 URL 不会重挂载 AppShell，会停留在历史页
     * 3) reload 后首页会先以空数据首帧渲染（显示 ¥0.00）
     * 4) 首次 reload 偶尔仍读到未就绪状态 → 加重试
     */
    for (let attempt = 0; attempt < 3; attempt++) {
      const x = p.locator('[role="dialog"] button[aria-label="关闭面板"]');
      if (await x.count()) { await x.first().click().catch(() => {}); await p.waitForTimeout(300); }
      await p.evaluate(() => localStorage.setItem('wealthcard/ui/active-tab', 'home'));
      await p.reload({ waitUntil: 'load' });
      await p.waitForSelector('[data-testid="total-assets"]', { timeout: 20000 });
      await p.waitForFunction(
        () => /数据更新于/.test(document.body.innerText),
        undefined,
        { timeout: 20000 },
      ).catch(() => {});
      await p.waitForTimeout(600);
      const raw = await txt('[data-testid="total-assets"]');
      if (raw !== '¥0.00') return Number(raw.replace(/[¥,]/g, ''));
    }
    return 0;
  };
  const goHistory = async () => {
    await p.click('[data-testid="nav-history"]');
    await p.waitForSelector('[data-testid="flows-view"]', { timeout: 15000 });
  };

  await p.goto(`${BASE}/`, { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="net-worth"]', { timeout: 20000 });
  const base = await homeAssets();
  check('① 期初总资产 = 100000', base === 100000, String(base));

  // ── 录一笔 BUY ────────────────────────────────────────
  await p.click('[data-testid="fab-record"]');
  await p.waitForSelector('[data-testid="tx-type-picker"]', { timeout: 15000 });
  await p.click('[data-testid="tx-type-buy"]');
  await p.selectOption('[data-testid="tx-account"]', 'a_cny');
  await p.selectOption('[data-testid="tx-cash"]', 'i_cny_cash');
  await p.selectOption('[data-testid="tx-instrument"]', 'i_stock');
  await p.fill('[data-testid="tx-quantity"]', '100');
  await p.fill('[data-testid="tx-price"]', '10');
  await p.click('[data-testid="tx-submit"]');
  await p.waitForSelector('[data-testid="tx-done"]', { timeout: 15000 });
  await p.click('button[aria-label="关闭面板"]');
  await p.waitForTimeout(600);

  const afterBuy = await homeAssets();
  check('② 买入后市价=成交价，总资产不变', afterBuy === base, String(afterBuy));

  // ── 流水显示状态 ──────────────────────────────────────
  await goHistory();
  const rows = await p.locator('[data-testid="flow-row"]').count();
  check('③ 流水列出 2 笔', rows === 2, `${rows} 笔`);
  const statuses = await p.locator('[data-testid="flow-status"]').evaluateAll((els) => els.map((e) => e.textContent.trim()));
  check('④ 流水显示「有效」状态', statuses.every((s) => s === '有效'), statuses.join('/'));
  check('⑤ 头部统计有效/已作废', (await txt('[data-testid="tx-counts"]')).includes('2 笔有效'), await txt('[data-testid="tx-counts"]'));

  // ── 打开详情并作废 ────────────────────────────────────
  // 必须明确点「买入」那一行：first() 可能点到 adjustment（作废期初余额 = 灾难）
  await p.locator('[data-testid="flow-row"][data-tx-type="buy"]').first().click();
  await p.waitForSelector('[data-testid="tx-detail-fields"]', { timeout: 15000 });
  check('⑥ 详情显示状态', (await txt('[data-testid="tx-detail-fields"]')).includes('有效'));
  check('⑥b 打开的是买入交易', (await txt('[data-testid="tx-detail-fields"]')).includes('买入'));
  check('⑦ POSTED 显示「作废交易」入口', (await p.locator('[data-testid="tx-void-start"]').count()) === 1);

  await p.click('[data-testid="tx-void-start"]');
  await p.waitForSelector('[data-testid="tx-void-confirm"]', { timeout: 10000 });
  check('⑧ 作废需二次确认', true);
  await p.fill('[data-testid="tx-void-reason"]', '金额录错');
  await p.click('[data-testid="tx-void-execute"]');
  // 等待派生结果刷新（reload 是异步的）
  const voidedAppeared = await until(async () => (await statusList()).includes('已作废'));
  const statuses2 = await statusList();
  check('⑨ 流水出现「已作废」', voidedAppeared && statuses2.filter((x) => x === '已作废').length === 1, statuses2.join('/'));

  const countsAppeared = await until(async () => (await txt('[data-testid="tx-counts"]')).includes('已作废'));
  check('⑩ 头部统计已作废数量', countsAppeared, await txt('[data-testid="tx-counts"]'));

  // 作废后详情 Sheet 关闭，才能点导航
  if (await p.locator('[data-testid="tx-detail-close"]').count()) {
    await p.click('[data-testid="tx-detail-close"]');
    await p.waitForTimeout(500);
  }
  const afterVoid = await homeAssets();
  check('⑪ 【核心】作废 BUY 后总资产恢复 100000', afterVoid === 100000, String(afterVoid));

  // ── 已作废不可重复操作 ────────────────────────────────
  await goHistory();
  await p.waitForSelector('[data-testid="flow-row"][data-tx-status="VOIDED"]', { timeout: 20000 });
  await p.locator('[data-testid="flow-row"][data-tx-status="VOIDED"]').first().click();
  await p.waitForSelector('[data-testid="tx-voided-notice"]', { timeout: 15000 });
  check('⑫ 【核心】已作废详情显示作废提示', (await txt('[data-testid="tx-voided-notice"]')).includes('已作废'));
  check('⑬ 已作废显示作废时间', (await txt('[data-testid="tx-detail-fields"]')).includes('作废时间'));
  check('⑭ 已作废显示作废原因', (await txt('[data-testid="tx-detail-fields"]')).includes('金额录错'));
  check('⑮ 【核心】已作废不可再次作废（无作废按钮）', (await p.locator('[data-testid="tx-void-start"]').count()) === 0);
  check('⑯ 已作废不再展示 Ledger Effects', (await p.locator('[data-testid="tx-detail-voided-effects"]').count()) === 1);
  await p.click('[data-testid="tx-detail-close"]');

  // ── 状态筛选 ──────────────────────────────────────────
  await p.selectOption('[data-testid="filter-status"]', 'active');
  await p.waitForTimeout(400);
  check('⑰ 「仅看有效」只剩 1 笔', (await p.locator('[data-testid="flow-row"]').count()) === 1);
  await p.selectOption('[data-testid="filter-status"]', 'all');
  await p.waitForTimeout(400);
  check('⑱ 「含已作废」恢复 2 笔', (await p.locator('[data-testid="flow-row"]').count()) === 2);

  // ── 刷新后一致（reload → rebuild）────────────────────
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await goHistory();
  await until(async () => (await statusList()).length >= 2);
  const afterReload = await statusList();
  check('⑲ 【核心】刷新后作废状态保持', afterReload.filter((x) => x === '已作废').length === 1, afterReload.join('/'));
  check('⑳ 【核心】刷新后总资产仍为 100000', (await homeAssets()) === 100000);

  // ── localStorage 隔离 ─────────────────────────────────
  await p.evaluate(() => localStorage.setItem('asset-card-wallet/portfolio/v2', JSON.stringify({ version: 2, categories: [{ id: 'x', name: '伪造ZZZ', items: [] }] })));
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  check('㉑ 篡改 localStorage 不出现伪造数据', !(await p.evaluate(() => document.body.innerText)).includes('伪造ZZZ'));
  check('㉒ 篡改后总资产仍正确', (await homeAssets()) === 100000);

  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  check('㉓ 清空 localStorage 后作废状态仍完整', (await homeAssets()) === 100000);
  await goHistory();
  await until(async () => (await statusList()).length >= 2);
  const final = await statusList();
  check('㉔ 清空 localStorage 后仍显示已作废', final.filter((x) => x === '已作废').length === 1, final.join('/'));

  check('㉕ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
