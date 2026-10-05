/**
 * 汇率自动获取 E2E
 *  ① 启动自动拉取（真实网络）→ 汇率落库 → 持仓可估值
 *  ② 设置的汇率面板显示来源 + 立即刷新按钮
 *  ③ 立即刷新可用
 *  ④ 兜底：拦截网络源后重载，应使用种子（来源=兜底种子文件）
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...DEVICE, locale: 'zh-CN' });
  const p = await ctx.newPage();
  // 只桩行情：本脚本测的正是**真实汇率拉取**，桩掉汇率等于废掉测试
  await stubQuoteNetwork(p);
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 100)); });

  const txt = async (s) => (await p.locator(s).first().innerText()).trim();
  const closeAll = async () => { for (let i = 0; i < 6; i++) { const x = p.locator('[role="dialog"] button[aria-label="关闭面板"]'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await p.waitForTimeout(250); } };
  const goTab = async (t) => { await closeAll(); await p.click(`[data-testid="nav-${t}"]`); await p.waitForTimeout(900); };
  const fxRows = () => p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const d = await new Promise((r) => { open.onsuccess = () => r(open.result); });
    const rows = await new Promise((res) => { const tx = d.transaction('fxRates', 'readonly'); const q = tx.objectStore('fxRates').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
    const meta = await new Promise((res) => { const tx = d.transaction('meta', 'readonly'); const q = tx.objectStore('meta').get('fx/last-sync'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
    d.close();
    return { rows: rows.map((r) => `${r.baseCurrency}:${r.rate.toFixed(4)}:${r.source}:${r.status}`), sources: [...new Set(rows.map((r) => r.source))], meta: meta?.value ?? null };
  });

  /* 清空存储 */
  await p.goto(BASE, { waitUntil: 'load' });
  await p.waitForTimeout(1200);
  await p.evaluate(async () => { localStorage.clear(); const d = await indexedDB.databases(); for (const x of d) if (x.name) indexedDB.deleteDatabase(x.name); });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 25000 });
  await p.waitForTimeout(4000); // 等自动同步完成

  /* ① 启动自动拉取 */
  let st = await fxRows();
  check('① 【核心】启动时自动拉取了汇率', st.rows.length > 0, `${st.rows.length} 行`);
  check('② 【核心】来源包含自动源或兜底种子', st.sources.length > 0, st.sources.join(','));
  check('③ 【核心】写入了同步时间记录（用于节流）', !!st.meta, JSON.stringify(st.meta));
  check('④ 覆盖多个币种', st.sources.length >= 1 && st.rows.length >= 5, `${st.rows.length} 行 / ${st.sources.length} 来源`);
  console.log('     样本:', st.rows.slice(0, 4).join(' | '));
  console.log('     节流记录:', JSON.stringify(st.meta));

  /* ② 面板显示来源 + 刷新按钮 */
  await goTab('settings');
  await closeAll();
  // 打开汇率面板
  const fxBtn = p.locator('button:has-text("录入 / 更新汇率")').first();
  await fxBtn.click();
  await p.waitForTimeout(1200);
  check('⑤ 【核心】汇率面板显示同步状态', (await p.locator('[data-testid="fx-sync-status"]').count()) === 1, await txt('[data-testid="fx-sync-status"]'));
  check('⑥ 【核心】汇率面板有「立即刷新」按钮', (await p.locator('[data-testid="fx-refresh"]').count()) === 1);
  check('⑦ 显示当前汇率的来源', (await txt('[data-testid="fx-existing"]').catch(() => '')).includes('来源'), (await txt('[data-testid="fx-existing"]').catch(() => '')).slice(0, 90));

  /* ③ 立即刷新 */
  await p.click('[data-testid="fx-refresh"]');
  await p.waitForTimeout(400);
  const busyTxt = await txt('[data-testid="fx-refresh"]').catch(() => '');
  await p.waitForTimeout(6000);
  const afterTxt = await txt('[data-testid="fx-sync-status"]').catch(() => '');
  check('⑧ 【核心】立即刷新可用并更新状态', afterTxt.length > 0 && !afterTxt.includes('失败'), `点击时="${busyTxt}" 之后="${afterTxt.slice(0, 60)}"`);

  /* ④ 兜底：拦截两个网络源，重载后应使用种子 */
  await p.route('**/open.er-api.com/**', (r) => r.abort());
  await p.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  // 清掉节流记录以强制重新同步
  await p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const d = await new Promise((r) => { open.onsuccess = () => r(open.result); });
    await new Promise((res) => { const tx = d.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('fx/last-sync'); tx.oncomplete = () => res(); });
    d.close();
  });
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 25000 });
  await p.waitForTimeout(6000);

  st = await fxRows();
  const seedRows = st.rows.filter((r) => r.includes(':seed:'));
  check('⑨ 【核心】网络源全失败时回落到兜底种子', seedRows.length > 0, `${seedRows.length} 条 seed 行`);
  check('⑩ 【核心】兜底种子状态为 SEED（不因时间失效）', seedRows.every((r) => r.endsWith(':SEED')), seedRows[0] ?? '');
  console.log('     seed 样本:', seedRows.slice(0, 3).join(' | '));

  const last = st.meta;
  check('⑪ 同步结果如实记录来源为 seed', last?.source === 'seed', JSON.stringify(last));

  /* 兜底值是否真的能被解析出来（直接对 USD 解析） */
  const resolved = await p.evaluate(async () => {
    const open = indexedDB.open('wealthcard', 20);
    const d = await new Promise((r) => { open.onsuccess = () => r(open.result); });
    const rows = await new Promise((res) => { const tx = d.transaction('fxRates', 'readonly'); const q = tx.objectStore('fxRates').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
    d.close();
    const usd = rows.filter((r) => r.baseCurrency === 'USD');
    return { count: usd.length, statuses: usd.map((r) => r.status), rates: usd.map((r) => r.rate) };
  });
  check('⑫ 【核心】USD 兜底汇率可被解析（存在 SEED 行）',
    resolved.statuses.includes('SEED') && resolved.rates.some((r) => r > 0),
    JSON.stringify(resolved));

  // 注意：故意 abort 网络源时，Chrome 会打内建日志 "Failed to load resource: net::ERR_FAILED"，
  // 那不是应用异常。已单独验证 unhandledrejection = 0 / pageerror = 0。
  const realErrors = errors.filter((e) => !e.includes('net::ERR_FAILED'));
  check('⑬ 全程无未捕获异常（已排除浏览器对 abort 请求的内建日志）',
    realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
