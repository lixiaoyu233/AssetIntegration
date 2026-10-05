/**
 * Phase 8 / W9 E2E — 历史依据展示 / 负债冲突提示 / 扩展历史
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

/** 直接播种：一个资产账户 + 一个「账户负债但标的类别是资产」的冲突组合 */
const seedConflict = (page) => page.evaluate(async () => {
  const iso = new Date().toISOString();
  const open = indexedDB.open('wealthcard', 20);
  open.onupgradeneeded = (e) => {
    const db = e.target.result;
    const mk = (n, k, idx) => { const st = db.createObjectStore(n, { keyPath: k }); for (const i of idx) st.createIndex(i[0], i[1], i[2] || {}); };
    mk('accounts','id',[]); mk('instruments','id',[]); mk('holdings','id',[]); mk('transactions','id',[]);
    mk('quotes','id',[]); mk('fxRates','id',[]); mk('snapshots','id',[['date','date',{unique:true}]]);
    mk('allocationProfiles','id',[]); mk('meta','key',[]); mk('classificationAudit','id',[]);
  };
  /*
   * ⚠️ 必须等**升级事务**提交后再操作/关闭：
   * 在 `open.onsuccess` 立刻 db.close() 会让 versionchange 事务未提交，
   * 应用启动时再开库会触发重开/迁移 → 页面导航 → evaluate 上下文被销毁。
   */
  if (open.transaction) await new Promise((res) => { open.transaction.oncomplete = () => res(); });
  const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
  const put = (s, rows) => new Promise((res) => { const tx = db.transaction(s, 'readwrite'); rows.forEach((r) => tx.objectStore(s).put(r)); tx.oncomplete = () => res(); });
  // 【冲突】账户 isLiability=true，但标的 assetClass='equity'
  await put('accounts', [{ id: 'a1', name: 'E2E 信用卡', type: 'bank', currency: 'CNY', region: 'CN', isLiability: true, createdAt: iso, updatedAt: iso }]);
  await put('instruments', [{ id: 'i1', name: 'E2E 股票', instrumentType: 'stock', assetClass: 'equity', currency: 'CNY', classificationStatus: 'confirmed', createdAt: iso, updatedAt: iso }]);
  await put('holdings', [{ id: 'h1', accountId: 'a1', instrumentId: 'i1', valuationMode: 'manual', manualValue: 5000, createdAt: iso, updatedAt: iso }]);
  db.close();
});

/**
 * 带重试的 evaluate：应用启动后可能仍有一次自动刷新（当日快照），
 * 期间导航会让 evaluate 的上下文被销毁 —— 重试即可稳定。
 */
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
    if (m.type() === 'error') {
      const t = m.text();
      if (!t.includes('net::ERR_FAILED')) errors.push('console: ' + t.slice(0, 100));
    }
  });


  const goTab = async (t) => { await p.click(`[data-testid="nav-${t}"]`); await p.waitForTimeout(800); };
  const home = async () => {
    await p.evaluate(() => localStorage.setItem('wealthcard/ui/active-tab', 'home'));
    await p.reload({ waitUntil: 'load' });
    await p.waitForSelector('[data-testid="total-assets"]', { timeout: 20000 });
    await p.waitForTimeout(700);
  };
  const txt = async (s) => (await p.locator(s).first().innerText()).trim();

  /* ============ ① 负债冲突提示（P1-3） ============ */
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await wipe(p);
  await seedConflict(p);
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1200);
  await goTab('assets');
  await p.waitForSelector('[data-testid="liability-conflict"]', { timeout: 15000 });

  const conflictText = await txt('[data-testid="liability-conflict"]');
  check('① 【核心】负债冲突提示可见', /需要核实/.test(conflictText));
  check('② 提示说明冲突来源（账户 vs 标的类别）', /信用卡/.test(conflictText) && /equity/.test(conflictText));
  check('③ 提示说明按更保守的负债口径计入', /负债/.test(conflictText) && /保守/.test(conflictText));
  check('④ 提示明确「系统不会替你改动」', /不会替你改动/.test(conflictText));
  check('⑤ 提供检查账户/标的的入口',
    (await p.locator('[data-testid="liability-conflict-account"]').count()) === 1 &&
    (await p.locator('[data-testid="liability-conflict-instrument"]').count()) === 1);

  // 冲突按保守处理：计入负债而非资产
  await home();
  const liab = (await txt('[data-testid="total-liabilities"]')).replace(/[¥,]/g, '');
  check('⑥ 【核心】冲突仍按负债计入（净资产不虚高）', liab === '5000.00', liab);

  /* ============ ② 历史依据展示（P1-5） ============ */
  /*
   * 这里只验证「**今天**快照」的依据面板 —— 它由应用真实捕获，
   * 依据字段由估值引擎上报，因此能验证端到端接线。
   *
   * 「缺失依据 → 显示无法追溯」由单测覆盖
   * （`src/lib/performance/w9Basis.test.ts`），因为要构造 V7 历史快照
   * 需要绕过应用自身的捕获流程，放进 E2E 只会让测试变脆。
   */
  await goTab('history');
  await p.waitForSelector('[data-testid="view-snapshots"]', { timeout: 15000 });
  await p.click('[data-testid="view-snapshots"]');
  await p.waitForTimeout(900);

  const togglesAll = p.locator('[data-testid="toggle-basis"]');
  check('⑦ 快照卡片有「查看估值依据」入口', (await togglesAll.count()) >= 1);

  await togglesAll.first().click();
  await p.waitForSelector('[data-testid="basis-panel"]', { timeout: 10000 });
  await p.waitForTimeout(400);
  const panel = await txt('[data-testid="basis-panel"]');
  check('⑧ 【核心】依据面板展示「依据时间」', /依据时间/.test(panel));
  check('⑨ 【核心】依据面板展示价格类型/行情状态/行情来源',
    /价格类型/.test(panel) && /行情状态/.test(panel) && /行情来源/.test(panel));
  check('⑩ 【核心】依据面板展示「当时是否负债」「当时资产类别」',
    /当时是否负债/.test(panel) && /当时资产类别/.test(panel));
  check('⑪ 【核心】依据为真实落盘值（非无法追溯）',
    !/依据时间[\s\S]{0,20}无法追溯/.test(panel), panel.replace(/\n/g, ' | ').slice(0, 90));
  check('⑫ 【核心】面板明确说明缺失含义：不会用今天的数据补',
    /不会用今天/.test(panel) && /无法追溯/.test(panel));
  check('⑬ 面板显示持仓标的名称', /E2E 股票/.test(panel));

  /* ============ ③ 扩展历史（P1-1 不缩短可查询范围） ============ */
  check('⑭ 提供「加载更早的历史」入口',
    (await p.locator('[data-testid="load-earlier-history"]').count()) === 1);
  await p.click('[data-testid="load-earlier-history"]');
  await p.waitForTimeout(1500);
  check('⑮ 【核心】按需加载后展示全部时点',
    (await p.locator('[data-testid="history-extended"]').count()) === 1);

  /* ============ ④ 数据完整性 ============ */
  await home();
  check('⑲ 刷新后净资产不变', (await txt('[data-testid="net-worth"]')).replace(/[¥,]/g, '') === '-5000.00');
  check('⑳ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
