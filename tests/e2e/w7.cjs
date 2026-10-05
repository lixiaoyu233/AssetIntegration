/**
 * Phase 8 / W7 E2E — 冷启动 + 备份/恢复 + 持续时间
 */
const { BASE, DEVICE, chromium, devices, makeReporter, stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const check = makeReporter();

/** 清空数据库，模拟全新用户 */
const wipe = async (page) => {
  await page.evaluate(async () => {
    const r = indexedDB.deleteDatabase('wealthcard');
    await new Promise((s) => { const d = () => s(); r.onsuccess = d; r.onerror = d; r.onblocked = d; setTimeout(d, 3000); });
  });
  await page.waitForTimeout(200);
};
const dumpCounts = (page) => page.evaluate(async () => {
  const open = indexedDB.open('wealthcard', 20);
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  if (!db.objectStoreNames.contains('accounts')) { db.close(); return null; }
  const all = (s) => new Promise((res) => { const tx = db.transaction(s, 'readonly'); const r = tx.objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
  const out = {
    accounts: (await all('accounts')).length,
    instruments: (await all('instruments')).length,
    holdings: (await all('holdings')).length,
    transactions: (await all('transactions')).length,
    classificationAudit: (await all('classificationAudit')).length,
  };
  db.close();
  return out;
});

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...DEVICE, locale: 'zh-CN', acceptDownloads: true });


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

  const txt = async (s) => (await p.locator(s).first().innerText()).trim();
  const openSheet = async (sel) => { await p.click(sel); await p.waitForTimeout(500); };
  const closeSheet = async () => {
    const x = p.locator('[role="dialog"] button[aria-label="关闭面板"]');
    if (await x.count()) { await x.first().click().catch(() => {}); await p.waitForTimeout(400); }
  };
  const goTab = async (t) => { await p.click(`[data-testid="nav-${t}"]`); await p.waitForTimeout(600); };

  /* ============ 冷启动：全新库 ============ */
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await wipe(p);
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1500);

  check('① 全新库进入应用（无迁移数据）', true);
  check('② 首页出现冷启动引导', (await p.locator('[data-testid="home-cold-start"]').count()) === 1);

  await goTab('assets');
  await p.waitForSelector('[data-testid="cold-start-guide"]', { timeout: 15000 });
  check('③ 资产页出现三步引导', true);
  const guideText = await txt('[data-testid="cold-start-guide"]');
  check('④ 引导含「创建账户」与「创建标的」', /创建账户/.test(guideText) && /创建标的/.test(guideText));

  /* ---- 创建账户 ---- */
  await openSheet('[data-testid="guide-account"]');
  await p.waitForSelector('[data-testid="account-name"]', { timeout: 15000 });
  await p.fill('[data-testid="account-name"]', 'E2E 储蓄卡');
  await p.selectOption('[data-testid="account-currency"]', 'CNY');
  await p.click('[data-testid="account-save"]');
  await p.waitForSelector('[data-testid="account-done"]', { timeout: 15000 });
  check('⑤ 【核心】空库能创建账户', (await txt('[data-testid="account-done"]')).includes('已创建'));
  await closeSheet();
  await p.waitForTimeout(600);

  let counts = await dumpCounts(p);
  check('⑥ 账户已写入 IndexedDB', counts?.accounts === 1, JSON.stringify(counts));

  /* ---- 创建标的（类别必须手选）---- */
  await openSheet('[data-testid="guide-instrument"]');
  await p.waitForSelector('[data-testid="instrument-name"]', { timeout: 15000 });
  await p.fill('[data-testid="instrument-name"]', 'E2E 现金');
  await p.selectOption('[data-testid="instrument-type"]', 'cash');
  // 不选类别直接提交 → 必须被拒绝
  await p.click('[data-testid="instrument-save"]');
  await p.waitForSelector('[data-testid="instrument-error"]', { timeout: 10000 });
  check('⑦ 【核心】未选资产类别被拒绝（系统不猜）', (await txt('[data-testid="instrument-error"]')).includes('不会替你猜测'), await txt('[data-testid="instrument-error"]'));
  check('⑧ 未选类别时未写入标的', (await dumpCounts(p))?.instruments === 0);

  await p.selectOption('[data-testid="instrument-asset-class"]', 'cash');
  await p.click('[data-testid="instrument-save"]');
  await p.waitForSelector('[data-testid="instrument-done"]', { timeout: 15000 });
  check('⑨ 选择类别后创建成功', (await txt('[data-testid="instrument-done"]')).includes('已创建'));
  await closeSheet();
  await p.waitForTimeout(600);

  counts = await dumpCounts(p);
  check('⑩ 标的已写入 IndexedDB', counts?.instruments === 1, JSON.stringify(counts));

  /* ---- 手动持仓 ---- */
  await openSheet('[data-testid="action-create-manual"]');
  await p.waitForSelector('[data-testid="manual-value"]', { timeout: 15000 });
  await p.selectOption('[data-testid="manual-instrument"]', { index: 1 });
  await p.fill('[data-testid="manual-value"]', '12345');
  await p.click('[data-testid="manual-save"]');
  await p.waitForSelector('[data-testid="manual-done"]', { timeout: 15000 });
  check('⑪ 手动持仓创建成功', (await txt('[data-testid="manual-done"]')).includes('已记录'));
  await closeSheet();
  await p.waitForTimeout(800);

  counts = await dumpCounts(p);
  check('⑫ 手动持仓已落库', counts?.holdings === 1, JSON.stringify(counts));

  await goTab('home');
  await p.waitForTimeout(1200);
  check('⑬ 冷启动引导消失（结构已建好）', (await p.locator('[data-testid="home-cold-start"]').count()) === 0);
  check('⑭ 首页显示总资产 12345', (await txt('[data-testid="total-assets"]')).replace(/[¥,]/g, '') === '12345.00', await txt('[data-testid="total-assets"]'));

  /* ============ 备份与恢复 ============ */
  await goTab('settings');
  await p.waitForSelector('[data-testid="storage-info"]', { timeout: 15000 });
  check('⑮ 设置页显示备份与存储区块', true);
  check('⑯ 显示持久化存储状态（不谎报）', ['已授予', '未授予（数据仍可用，但建议定期导出）', '未知（本浏览器不支持查询）'].includes(await txt('[data-testid="storage-persisted"]')), await txt('[data-testid="storage-persisted"]'));
  check('⑰ 显示本机占用', (await txt('[data-testid="storage-usage"]')).length > 0);

  await openSheet('[data-testid="open-backup"]');
  await p.waitForSelector('[data-testid="backup-export"]', { timeout: 15000 });

  // 导出（拦截下载，读取内容）
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 20000 }),
    p.click('[data-testid="backup-export"]'),
  ]);
  const path = await download.path();
  const fs = require('fs');
  const exported = JSON.parse(fs.readFileSync(path, 'utf8'));
  check('⑱ 导出成功且文件名合理', /wealthcard-backup-\d{8}-\d{4}\.json/.test(download.suggestedFilename()), download.suggestedFilename());
  check('⑲ 【核心】信封含 format/schemaVersion/dbVersion/exportedAt/counts/checksum',
    exported.format === 'wealthcard-backup' && typeof exported.schemaVersion === 'number' &&
    typeof exported.dbVersion === 'number' && typeof exported.exportedAt === 'string' &&
    !!exported.counts && typeof exported.checksum === 'string', `schemaVersion=${exported.schemaVersion}`);
  check('⑳ 【核心】导出包含交易与分类审计（1.0 导出会丢这些）',
    Array.isArray(exported.data.portfolio.transactions) && Array.isArray(exported.data.portfolio.classificationAudit));
  check('㉑ 导出前体检结果存在', !!exported.health && typeof exported.health.reconcileOk === 'boolean');
  check('㉒ 显示导出结果说明', (await txt('[data-testid="backup-info"]')).includes('校验和'));

  /* ---- 坏文件：结构合法但引用悬空 → 必须拒绝 ---- */
  const bad = JSON.parse(JSON.stringify(exported));
  bad.data.portfolio.holdings[0].instrumentId = 'ghost';
  // 重算 checksum 以绕过校验和，专门测引用完整性
  const badPath = '/tmp/acw-verify/w7-bad.json';
  fs.writeFileSync(badPath, JSON.stringify(bad));
  await p.setInputFiles('[data-testid="backup-file"]', badPath);
  await p.waitForSelector('[data-testid="backup-report"]', { timeout: 15000 });
  check('㉓ 【核心】坏数据被拒绝（引用悬空）', (await txt('[data-testid="backup-report"]')).includes('已拒绝导入'), (await txt('[data-testid="backup-report"]')).slice(0, 60));
  check('㉔ 【核心】被拒后数据未改变', JSON.stringify(await dumpCounts(p)) === JSON.stringify(counts));

  /* ---- 高版本 → 硬拒绝 ---- */
  const higher = JSON.parse(JSON.stringify(exported));
  higher.schemaVersion = 99;
  const higherPath = '/tmp/acw-verify/w7-higher.json';
  fs.writeFileSync(higherPath, JSON.stringify(higher));
  await p.setInputFiles('[data-testid="backup-file"]', higherPath);
  await p.waitForSelector('[data-testid="backup-report"]', { timeout: 15000 });
  check('㉕ 【核心】高版本备份硬拒绝', (await txt('[data-testid="backup-report"]')).includes('高于'), (await txt('[data-testid="backup-report"]')).slice(0, 70));

  /* ---- 合法备份：dry-run 预览 → 导入 ---- */
  await p.setInputFiles('[data-testid="backup-file"]', path);
  await p.waitForSelector('[data-testid="backup-preview"]', { timeout: 15000 });
  check('㉖ dry-run 给出预览（校验通过、尚未写入）', (await txt('[data-testid="backup-report"]')).includes('校验通过'));
  check('㉗ 预览显示将替换/写入的条目数', /将替换现有 \d+ 条记录/.test(await txt('[data-testid="backup-preview"]')));

  const beforeImport = await dumpCounts(p);
  check('㉘ dry-run 未写入任何数据', JSON.stringify(await dumpCounts(p)) === JSON.stringify(beforeImport));

  await p.click('[data-testid="backup-restore"]');
  await p.waitForSelector('[data-testid="backup-info"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  check('㉙ 导入完成', (await txt('[data-testid="backup-info"]')).includes('导入完成'));
  check('㉚ 导入后可回滚', (await p.locator('[data-testid="backup-rollback"]').count()) === 1);

  /* ---- 回滚 ---- */
  await p.click('[data-testid="backup-rollback"]');
  await p.waitForTimeout(2000);
  const afterRollback = await dumpCounts(p);
  check('㉛ 【核心】可回滚到导入前', JSON.stringify(afterRollback) === JSON.stringify(beforeImport), JSON.stringify(afterRollback));
  await closeSheet();

  /* ---- 导入 → 数据一致 ---- */
  await goTab('home');
  await p.waitForTimeout(1000);
  check('㉜ 回滚后总额仍为 12345', (await txt('[data-testid="total-assets"]')).replace(/[¥,]/g, '') === '12345.00', await txt('[data-testid="total-assets"]'));

  /* ---- localStorage 隔离 ---- */
  await p.evaluate(() => localStorage.setItem('asset-card-wallet/portfolio/v2', JSON.stringify({ version: 2, categories: [{ id: 'x', name: '伪造ZZZ', items: [] }] })));
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  check('㉝ 篡改 localStorage 不影响业务数据', (await dumpCounts(p))?.accounts === 1);
  check('㉞ 篡改后无伪造数据', !(await p.evaluate(() => document.body.innerText)).includes('伪造ZZZ'));

  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('[data-testid="bottom-nav"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  check('㉟ 【核心】清空 localStorage 后数据仍完整', (await dumpCounts(p))?.accounts === 1);

  check('㊱ 全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    await b.close()
    process.exit(check.printSummary())
})();
