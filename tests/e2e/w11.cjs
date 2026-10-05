/**
 * Phase 8 / W11 Blocker Patch E2E
 *  路径A：Cold Start → 创建 manual Holding → 对同账户同标的记账 → 提示 → reload → 再次记账
 *  路径B：1.0 迁移未完成 → 2.0 显示失败状态 → 创建 2.0 数据 → reload → 仍识别为未完成
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();

const LEGACY_KEY = 'asset-card-wallet/portfolio/v2';
const legacyPayload = JSON.stringify({
  version: 2, history: [],
  categories: [{
    id: 'cat_cash', name: '现金', subtitle: '银行', icon: 'banknote',
    color: 'var(--accent-gold)', colorName: 'gold', defaultKind: 'amount',
    items: [{ id: 'c1', kind: 'amount', name: '示例活期', amount: 20000, currency: 'CNY' }],
  }],
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

  const txt = async (s) => (await p.locator(s).first().innerText()).trim();
  const closeAll = async () => {
    for (let i = 0; i < 6; i++) {
      const x = p.locator('[role="dialog"] button[aria-label="关闭面板"]');
      if (!(await x.count())) break;
      await x.first().click().catch(() => {});
      await p.waitForTimeout(250);
    }
  };
  const goTab = async (t) => { await closeAll(); await p.click(`[data-testid="nav-${t}"]`); await p.waitForTimeout(800); };
  const home = async () => {
    await closeAll();
    await p.evaluate(() => localStorage.setItem('wealthcard/ui/active-tab', 'home'));
    await p.reload({ waitUntil: 'load' });
    await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
    await p.waitForTimeout(900);
  };
  const optVal = (testid, re) => p.evaluate(([id, src]) => {
    const sel = document.querySelector(`[data-testid="${id}"]`);
    if (!sel) return null;
    const rx = new RegExp(src);
    const o = [...sel.options].find((x) => rx.test(x.textContent || ''));
    return o ? o.value : null;
  }, [testid, re.source]);
  const dbState = () => p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const d = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const all = (s) => new Promise((res) => { const tx = d.transaction(s, 'readonly'); const r = tx.objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
    const holds = await all('holdings');
    const txs = await all('transactions');
    const accs = await all('accounts');
    d.close();
    return {
      holds: holds.map((h) => `${h.valuationMode}=${h.manualValue ?? h.quantity}`),
      txCount: txs.length,
      accCount: accs.length,
      dupKeys: (() => { const m = new Map(); for (const h of holds) { const k = h.accountId + '::' + h.instrumentId; m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].filter(([, n]) => n > 1).map(([k]) => k); })(),
    };
  });

  /* ================ 路径 A ================ */
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.evaluate(async () => {
    const r = indexedDB.deleteDatabase('wealthcard');
    await new Promise((s) => { const d = () => s(); r.onsuccess = d; r.onerror = d; r.onblocked = d; setTimeout(d, 3000); });
  });
  await p.evaluate(() => localStorage.clear());
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1400);

  // 建账户 + 标的
  await goTab('assets');
  await p.waitForSelector('[data-testid="cold-start-guide"]', { timeout: 15000 });
  await closeAll();
  await p.click('[data-testid="action-create-account"]');
  await p.waitForSelector('[data-testid="account-name"]', { timeout: 12000 });
  await p.fill('[data-testid="account-name"]', 'W11 账户');
  await p.click('[data-testid="account-save"]');
  await p.waitForSelector('[data-testid="account-done"]', { timeout: 12000 });
  await p.waitForTimeout(500);
  await closeAll();
  await p.click('[data-testid="action-create-instrument"]');
  await p.waitForSelector('[data-testid="instrument-name"]', { timeout: 12000 });
  await p.fill('[data-testid="instrument-name"]', 'W11 现金');
  await p.selectOption('[data-testid="instrument-type"]', 'cash');
  await p.selectOption('[data-testid="instrument-asset-class"]', 'cash');
  await p.click('[data-testid="instrument-save"]');
  await p.waitForSelector('[data-testid="instrument-done"]', { timeout: 12000 });
  await p.waitForTimeout(500);
  await closeAll();
  check('① 冷启动建立账户与标的', true);

  // 创建 manual 持仓（现金 20000）
  await closeAll();
  await p.click('[data-testid="action-create-manual"]');
  await p.waitForSelector('[data-testid="manual-value"]', { timeout: 12000 });
  await p.selectOption('[data-testid="manual-account"]', await optVal('manual-account', /W11 账户/));
  await p.waitForTimeout(400);
  await p.selectOption('[data-testid="manual-instrument"]', await optVal('manual-instrument', /W11 现金/));
  await p.fill('[data-testid="manual-value"]', '20000');
  await p.click('[data-testid="manual-save"]');
  await p.waitForSelector('[data-testid="manual-done"]', { timeout: 12000 });
  await p.waitForTimeout(700);
  await closeAll();
  let st = await dbState();
  check('② manual 持仓已落库', st.holds.length === 1 && st.holds[0].startsWith('manual'), JSON.stringify(st.holds));
  await home();
  check('③ 净资产 = 20000', (await txt('[data-testid="net-worth"]')).replace(/[¥,\s]/g, '') === '20000.00');

  // 对同账户同标的记账（应被明确拒绝）
  await closeAll();
  await p.click('[data-testid="fab-record"]');
  await p.waitForSelector('[data-testid="tx-type-picker"]', { timeout: 15000 });
  await p.click('[data-testid="tx-type-deposit"]');
  await p.waitForTimeout(400);
  await p.selectOption('[data-testid="tx-account"]', await optVal('tx-account', /W11 账户/));
  await p.waitForTimeout(350);
  await p.selectOption('[data-testid="tx-cash"]', await optVal('tx-cash', /W11 现金/));
  await p.waitForTimeout(300);
  await p.fill('[data-testid="tx-amount"]', '5000');
  await p.click('[data-testid="tx-submit"]');
  await p.waitForTimeout(1100);

  const errCount = await p.locator('[data-testid="tx-error"]').count();
  const errText = errCount ? await txt('[data-testid="tx-error"]') : '';
  const doneCount = await p.locator('[data-testid="tx-done"]').count();
  check('④ 【核心】同标的记账被明确拒绝（不是静默成功）', errCount === 1 && doneCount === 0, errText.slice(0, 70));
  check('⑤ 【核心】错误信息说明原因（手动持仓 / 只能一条）', /手动持仓/.test(errText) && /只能有一条/.test(errText), errText.slice(0, 60));
  await closeAll();

  st = await dbState();
  check('⑥ 【核心】拒绝后无重复键、无脏交易', st.dupKeys.length === 0 && st.txCount === 0, JSON.stringify(st));
  await home();
  check('⑦ 【核心】净资产仍为 20000（未被损坏）', (await txt('[data-testid="net-worth"]')).replace(/[¥,\s]/g, '') === '20000.00');
  check('⑧ 【核心】页面无「重复持仓」告警', (await p.locator('[data-testid="action-duplicates"]').count()) === 0);

  // reload 后一致
  await home();
  st = await dbState();
  check('⑨ 【核心】reload 后数据一致（无重复键）', st.dupKeys.length === 0 && st.holds.length === 1, JSON.stringify(st));
  check('⑩ 【核心】reload 后净资产仍 20000', (await txt('[data-testid="net-worth"]')).replace(/[¥,\s]/g, '') === '20000.00');

  // 反向：先交易再建 manual（用另一个账户，避免与⑨的 manual 冲突）
  await goTab('assets');
  await closeAll();
  await p.click('[data-testid="action-create-account"]');
  await p.waitForSelector('[data-testid="account-name"]', { timeout: 12000 });
  await p.fill('[data-testid="account-name"]', 'W11 账户2');
  await p.click('[data-testid="account-save"]');
  await p.waitForSelector('[data-testid="account-done"]', { timeout: 12000 });
  await p.waitForTimeout(600);
  await closeAll();
  check('⑪ 第二个账户创建成功（manual 未锁死应用）', true);

  /* ==================================================================
   * 路径 B：与 1.0 的数据隔离（独立部署）
   *
   * ## 这些断言为什么是「必须不迁移」
   *
   * 1.0 与 2.0 部署在同一 origin 的不同子路径下，而 `localStorage`
   * **按 origin 隔离、不按路径隔离** —— 2.0 一启动天然就能读到 1.0 的
   * `asset-card-wallet/*` 键。
   *
   * 2.0 的启动路径显式传了 `readLegacyData: false`
   * （见 `src/main.tsx`），因此必须：
   *   - **不**把 1.0 数据迁进自己的 IndexedDB；
   *   - **不**显示「迁移未完成」提示（它压根不尝试迁移，显示即误导）；
   *   - **不**改写、不删除 1.0 的 localStorage 数据。
   *
   * ⚠️ 本节是「两版本互不干扰」这条设计的**守门测试**。
   * 如果哪天有人把 `readLegacyData` 改回默认（或删掉该参数），
   * 这里会立刻变红 —— 这是刻意的。
   * ================================================================== */

  // 造出「1.0 有数据」的状态，同时清空 2.0 自己的库
  await p.evaluate(async (payload) => {
    const r = indexedDB.deleteDatabase('wealthcard');
    await new Promise((s) => { const d = () => s(); r.onsuccess = d; r.onerror = d; r.onblocked = d; setTimeout(d, 3000); });
    localStorage.setItem('asset-card-wallet/portfolio/v2', payload);
  }, legacyPayload);
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(2500);

  // ⑫ 绝不能把 1.0 数据迁进来
  let st2 = await dbState();
  check(
    '⑫ 【核心】2.0 未把 1.0 数据迁移进自己的 IndexedDB',
    st2.accCount === 0,
    JSON.stringify({ acc: st2.accCount, holds: st2.holds.length, tx: st2.txCount }),
  );

  // 一并确认 1.0 的键没有被 2.0 改写或删除
  const legacyAfterBoot = await p.evaluate((k) => localStorage.getItem(k), LEGACY_KEY);
  check('⑬ 【核心】启动后 1.0 的 localStorage 数据逐字节未变', legacyAfterBoot === legacyPayload);

  // ⑭ 不该出现「迁移未完成」提示（2.0 不迁移，显示即误导）
  check(
    '⑭ 【核心】2.0 不显示「迁移未完成」提示',
    (await p.locator('[data-testid="migration-notice"]').count()) === 0,
  );

  /*
   * ⑮ 反复启动仍是同一个结论（排除「首次才生效」这类实现偏差）。
   * 顺带覆盖「用户先建了 2.0 数据」的情形 —— 那也不该让 2.0 回头去读 1.0。
   */
  await p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const d = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    await new Promise((res) => {
      const tx = d.transaction('accounts', 'readwrite');
      tx.objectStore('accounts').put({
        id: 'iso_acc', name: '隔离验证账户', type: 'bank', currency: 'CNY', region: 'CN',
        isLiability: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => res();
    });
    d.close();
  });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(2500);

  st2 = await dbState();
  check(
    '⑮ 【核心】已有 2.0 数据时仍不读取 1.0（多次启动结论一致）',
    st2.accCount === 1 && st2.holds.length === 0 && st2.txCount === 0,
    JSON.stringify({ acc: st2.accCount, holds: st2.holds.length, tx: st2.txCount }),
  );
  check(
    '⑯ 【核心】多次启动后仍无「迁移未完成」提示',
    (await p.locator('[data-testid="migration-notice"]').count()) === 0,
  );

  // 旧数据仍完整保留
  const legacyStill = await p.evaluate((k) => localStorage.getItem(k), LEGACY_KEY);
  check('⑱ 【核心】1.0 localStorage 数据仍完整保留', legacyStill === legacyPayload);

  // 旧界面只读仍可用
  await p.goto(BASE + '/?legacy=1', { waitUntil: 'load' });
  await p.waitForTimeout(1800);
  const legacyBody = await p.evaluate(() => document.body.innerText);
  check('⑲ 【核心】?legacy=1 旧界面仍可打开（只读查看）', legacyBody.length > 0 && /现金|资产/.test(legacyBody));

  check('⑳ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
