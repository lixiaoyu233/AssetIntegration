/**
 * Phase 8 / W10-Patch E2E — 真实用户路径
 * 新用户 → 账户 → 两个账户 → 持仓 → **部分划转** → 核对两账户余额
 *        → 备份 → 坏导入 → 回滚失败模拟 → 确认暂存可用 → 期初持仓 void → UI 补救
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();

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
  const num = (s) => s.replace(/[¥,\s]/g, '');
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
    await p.waitForSelector('[data-testid="total-assets"]', { timeout: 20000 });
    await p.waitForTimeout(800);
  };
  const optVal = (testid, re) => p.evaluate(([id, src]) => {
    const sel = document.querySelector(`[data-testid="${id}"]`);
    if (!sel) return null;
    const rx = new RegExp(src);
    const o = [...sel.options].find((x) => rx.test(x.textContent || ''));
    return o ? o.value : null;
  }, [testid, re.source]);
  /** 从 IndexedDB 读两个账户的持仓余额 */
  const balances = () => p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const d = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const all = (s) => new Promise((res) => { const tx = d.transaction(s, 'readonly'); const r = tx.objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
    const accs = await all('accounts');
    const holds = await all('holdings');
    const nameById = new Map(accs.map((a) => [a.id, a.name]));
    const out = {};
    for (const h of holds) out[nameById.get(h.accountId) ?? h.accountId + '::' + h.instrumentId] = h.quantity ?? h.manualValue;
    out.__byKey = holds.map((h) => `${nameById.get(h.accountId)}::${h.instrumentId}=${h.quantity ?? h.manualValue}:${h.valuationMode}`);
    const txs = await all('transactions');
    out.__tx = txs.map((t) => `${t.type}${t.status === 'VOIDED' ? ':V' : ''}`);
    d.close();
    return out;
  });

  /* ============ 0) 全新库 ============ */
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.evaluate(async () => {
    const r = indexedDB.deleteDatabase('wealthcard');
    await new Promise((s) => { const d = () => s(); r.onsuccess = d; r.onerror = d; r.onblocked = d; setTimeout(d, 3000); });
  });
  await p.evaluate(() => localStorage.clear());
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1500);

  /* ============ 1) 两个账户 ============ */
  await goTab('assets');
  await p.waitForSelector('[data-testid="cold-start-guide"]', { timeout: 15000 });
  const newAccount = async (name) => {
    await closeAll();
    await p.click('[data-testid="action-create-account"]');
    await p.waitForSelector('[data-testid="account-name"]', { timeout: 12000 });
    await p.fill('[data-testid="account-name"]', name);
    await p.click('[data-testid="account-save"]');
    await p.waitForSelector('[data-testid="account-done"]', { timeout: 12000 });
    await p.waitForTimeout(500);
  };
  await newAccount('WP 账户A');
  await newAccount('WP 账户B');
  await closeAll();
  check('① 创建两个账户', true);

  /* ============ 2) 现金标的 + 存入 ============ */
  await closeAll();
  await p.click('[data-testid="action-create-instrument"]');
  await p.waitForSelector('[data-testid="instrument-name"]', { timeout: 12000 });
  await p.fill('[data-testid="instrument-name"]', 'WP 现金');
  await p.selectOption('[data-testid="instrument-type"]', 'cash');
  await p.selectOption('[data-testid="instrument-asset-class"]', 'cash');
  await p.click('[data-testid="instrument-save"]');
  await p.waitForSelector('[data-testid="instrument-done"]', { timeout: 12000 });
  await p.waitForTimeout(500);
  await closeAll();

  const record = async (type, { account, instrument, cash, toAccount, quantity, amount, transferAll } = {}) => {
    await closeAll();
    for (let i = 0; i < 4; i++) {
      if (await p.locator('[data-testid="tx-type-picker"]').isVisible().catch(() => false)) break;
      await p.click('[data-testid="fab-record"]').catch(() => {});
      await p.waitForTimeout(700);
      if (await p.locator('[data-testid="tx-type-picker"]').isVisible().catch(() => false)) break;
      await closeAll();
    }
    await p.waitForSelector('[data-testid="tx-type-picker"]', { timeout: 15000 });
    await p.click(`[data-testid="tx-type-${type}"]`);
    await p.waitForTimeout(400);
    if (account) {
      const v = await optVal('tx-account', account);
      if (v) await p.selectOption('[data-testid="tx-account"]', v);
      await p.waitForTimeout(350);
    }
    if (instrument) {
      const v = await optVal('tx-instrument', instrument);
      if (v) await p.selectOption('[data-testid="tx-instrument"]', v);
      await p.waitForTimeout(300);
    }
    if (cash) {
      const v = await optVal('tx-cash', cash);
      if (v) await p.selectOption('[data-testid="tx-cash"]', v);
      await p.waitForTimeout(300);
    }
    if (toAccount) {
      const v = await optVal('tx-to-account', toAccount);
      if (v) await p.selectOption('[data-testid="tx-to-account"]', v);
      await p.waitForTimeout(300);
    }
    if (transferAll) {
      await p.locator('[data-testid="tx-transfer-all"]').evaluate((el) => el.closest('label')?.click());
      await p.waitForTimeout(250);
    }
    if (quantity != null) await p.fill('[data-testid="tx-quantity"]', String(quantity));
    if (amount != null) await p.fill('[data-testid="tx-amount"]', String(amount));
    await p.click('[data-testid="tx-submit"]');
    await p.waitForTimeout(900);
    const err = (await p.locator('[data-testid="tx-error"]').count()) ? await txt('[data-testid="tx-error"]') : '';
    return err;
  };

  let err = await record('deposit', { account: /WP 账户A/, cash: /WP 现金/, amount: 100000 });
  check('② 账户A 存入 100000', err === '', err);
  await closeAll();

  /* ============ 3) 部分划转 ============ */
  err = await record('transfer', { account: /WP 账户A/, toAccount: /WP 账户B/, instrument: /WP 现金/, quantity: 20000, amount: 20000 });
  check('③ 部分划转 20000 成功', err === '', err);
  await closeAll();

  const b1 = await balances();
  check('④ 【核心】部分划转后 账户A = 80000', b1['WP 账户A'] === 80000, JSON.stringify(b1));
  check('⑤ 【核心】部分划转后 账户B = 20000', b1['WP 账户B'] === 20000, JSON.stringify(b1));

  /* ============ 4) 显式整仓划转 ============ */
  err = await record('transfer', { account: /WP 账户A/, toAccount: /WP 账户B/, instrument: /WP 现金/, amount: 80000, transferAll: true });
  check('⑥ 显式整仓划转成功', err === '', err);
  await closeAll();
  const b2 = await balances();
  check('⑦ 【核心】显式整仓后 账户A = 0', b2['WP 账户A'] === 0, JSON.stringify(b2));
  check('⑧ 【核心】显式整仓后 账户B = 100000', b2['WP 账户B'] === 100000, JSON.stringify(b2));

  // 还原成分部持有（再划 20000 回 A），便于后续核对
  err = await record('transfer', { account: /WP 账户B/, toAccount: /WP 账户A/, instrument: /WP 现金/, quantity: 20000, amount: 20000 });
  await closeAll();
  const b3 = await balances();
  check('⑨ 反向部分划转后 A=20000 / B=80000',
    b3['WP 账户A'] === 20000 && b3['WP 账户B'] === 80000, JSON.stringify(b3));

  /* ============ 5) 期初 adjustment → 持仓 ============ */
  const createInstrument2 = async (name, type, cls) => {
    await closeAll();
    await p.click('[data-testid="action-create-instrument"]');
    await p.waitForSelector('[data-testid="instrument-name"]', { timeout: 12000 });
    await p.fill('[data-testid="instrument-name"]', name);
    await p.selectOption('[data-testid="instrument-type"]', type);
    await p.selectOption('[data-testid="instrument-asset-class"]', cls);
    await p.click('[data-testid="instrument-save"]');
    await p.waitForSelector('[data-testid="instrument-done"]', { timeout: 12000 });
    await p.waitForTimeout(500);
  };
  await createInstrument2('WP 指数ETF', 'etf', 'equity');
  await closeAll();
  err = await record('buy', { account: /WP 账户A/, instrument: /WP 指数ETF/, cash: /WP 现金/, quantity: 100, amount: 6000 });
  check('⑩ 买入建仓（作为可作废的交易）', err === '', err);
  await closeAll();

  /* ============ 6) 备份 ============ */
  await goTab('settings');
  await closeAll();
  await p.click('[data-testid="open-backup"]');
  await p.waitForSelector('[data-testid="backup-export"]', { timeout: 12000 });
  const dl = p.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  await p.click('[data-testid="backup-export"]');
  const download = await dl;
  let backupText = null;
  if (download) backupText = require('fs').readFileSync(await download.path(), 'utf8');
  check('⑪ 备份导出成功', !!backupText && /"checksum"/.test(backupText));
  await closeAll();

  /* ============ 7) 制造坏导入 → 回滚 ============ */
  if (backupText) {
    const env = JSON.parse(backupText);
    // 把账户名改成 BAD，制造「结构合法但内容错误」的导入
    env.data.portfolio.accounts = env.data.portfolio.accounts.map((a) => ({ ...a, name: 'BAD' + a.name }));
    const tampered = JSON.stringify(env);
    await goTab('settings');
    await closeAll();
    await p.click('[data-testid="open-backup"]');
    await p.waitForSelector('[data-testid="backup-file"]', { state: 'attached', timeout: 12000 });
    await p.setInputFiles('[data-testid="backup-file"]', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(tampered) });
    await p.waitForTimeout(1200);
    const restored = await p.locator('[data-testid="backup-restore"]').count();
    if (restored) {
      // checksum 不匹配会被拒（这本身是正确行为）
      await p.click('[data-testid="backup-restore"]').catch(() => {});
      await p.waitForTimeout(1200);
    }
    const reportText = await p.evaluate(() => document.body.innerText);
    check('⑫ 【核心】篡改数据的导入被拒（checksum 拦截）',
      /校验|损坏|拒绝|无法/.test(reportText), reportText.slice(0, 80));

    // 用**合法**备份正常导入，验证回滚入口可用
    await closeAll();
    await p.click('[data-testid="open-backup"]');
    await p.setInputFiles('[data-testid="backup-file"]', { name: 'good.json', mimeType: 'application/json', buffer: Buffer.from(backupText) });
    await p.waitForTimeout(1200);
    await p.click('[data-testid="backup-restore"]');
    await p.waitForTimeout(1800);
    const infoText = await p.evaluate(() => document.body.innerText);
    check('⑬ 【核心】合法备份导入成功', /导入完成|已导入/.test(infoText), infoText.slice(0, 80));
    const rollbackBtn = await p.locator('[data-testid="backup-rollback"]').count();
    check('⑭ 【核心】导入后可回滚（暂存存在）', rollbackBtn === 1);
    if (rollbackBtn) {
      await p.click('[data-testid="backup-rollback"]');
      await p.waitForTimeout(1600);
      const rbText = await p.evaluate(() => document.body.innerText);
      check('⑮ 【核心】回滚成功并如实报告', /已回滚/.test(rbText));
    }
    await closeAll();
  }

  /* ============ 8) void → UI 补救 ============ */
  await goTab('history');
  await p.click('[data-testid="view-flows"]');
  await p.waitForTimeout(700);
  const rows = await p.locator('[data-testid="flow-row"]').count();
  check('⑯ 交易历史可见', rows >= 2, String(rows));

  const buyRow = p.locator('[data-testid="flow-row"][data-tx-type="buy"]').first();
  await buyRow.click();
  await p.waitForSelector('[data-testid="tx-void-start"]', { timeout: 12000 });
  await p.click('[data-testid="tx-void-start"]');
  await p.waitForTimeout(500);
  const confirmText = await p.locator('[data-testid="tx-void-confirm"]').innerText();
  const warnCount = await p.locator('[data-testid="tx-void-impact-warning"]').count();
  check('⑰ 【核心】作废确认前明确告知「持仓将失去账本依据」',
    warnCount === 1 && /失去账本依据/.test(confirmText), confirmText.slice(0, 90));
  await p.fill('[data-testid="tx-void-reason"]', 'W10-Patch 审计');
  await p.click('[data-testid="tx-void-execute"]');
  await p.waitForTimeout(1600);

  const droppedCount = await p.locator('[data-testid="tx-void-dropped"]').count();
  check('⑱ 【核心】作废后如实列出被清理的持仓（不是普通「已作废」）', droppedCount === 1);
  const recoverCount = await p.locator('[data-testid="tx-void-recover"]').count();
  check('⑲ 【核心】提供可操作的补救入口「补录为手动持仓」', recoverCount >= 1);

  if (recoverCount) {
    await p.click('[data-testid="tx-void-recover"]');
    await p.waitForTimeout(900);
    const manualOpen = await p.locator('[data-testid="manual-value"]').count();
    check('⑳ 【核心】补救入口打开手动持仓表单（并预填）', manualOpen === 1);
    if (manualOpen) {
      await p.fill('[data-testid="manual-value"]', '6000');
      await p.click('[data-testid="manual-save"]');
      await p.waitForTimeout(1400);
    }
  }
  await closeAll();

  /* ============ 9) 核对资产 ============ */
  await home();
  const afterRecover = await balances();
  const manualKeys = (afterRecover.__byKey || []).filter((x) => x.includes('manual'));
  check('㉑ 【核心】补救后 ETF 已登记为 manual 持仓',
    manualKeys.some((x) => x.includes('=6000:manual')), JSON.stringify(afterRecover.__byKey));
  const nw = num(await txt('[data-testid="net-worth"]'));
  check('㉒ 【核心】净资产 = 100000（现金）+ 6000（手动持仓）= 106000', nw === '106000.00', nw);

  await home();
  const after = await balances();
  check('㉓ 【核心】刷新后数据一致', JSON.stringify(after) === JSON.stringify(afterRecover));
  check('㉔ 【核心】无负余额', Object.entries(after).filter(([k]) => !k.startsWith('__')).every(([, v]) => Number(v) >= 0),
    JSON.stringify(after));
  check('㉕ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
