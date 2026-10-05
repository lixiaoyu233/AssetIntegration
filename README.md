# 资产整合 · AssetIntegration

> **本地优先（local-first）、隐私优先、纯静态**的个人资产归集与账本工具。
> 所有业务数据只保存在你自己的浏览器 **IndexedDB** 里，**没有任何后端、没有登录、没有云同步**。

| 项 | 值 |
| --- | --- |
| 产品名 | 资产整合 |
| 英文名 | AssetIntegration |
| 线上地址 | https://lixiaoyu233.github.io/AssetIntegration/ |
| 数据事实源 | IndexedDB（Dexie），库名 `wealthcard` |
| Portfolio Schema | `PORTFOLIO_SCHEMA_VERSION = 8` |
| IndexedDB 版本 | `DB_VERSION = 2` |
| 部署形态 | GitHub Pages 静态站点（无服务端） |

> ⚠️ **这是与 1.0（`WealthCard`）并存的独立产品。** 两者同源但**互不读取、互不迁移、互不覆盖**。详见 [§9 与 1.0 的关系](#9-与-10-wealthcard-的关系)。

---

## 1. 十五分钟读懂：这套系统的中心思想

一句话：**把「发生过的事实」和「由事实算出来的东西」严格分开。**

```
Transaction（交易流水）   ← 唯一事实源。用户录入，只增不改（只能作废）
        │
        │  deriveLedgerEffects()  纯函数派生
        ▼
Ledger Effects（账本效果）  ← 每笔交易在「标的腿 / 现金腿」上产生的增量
        │
        │  rebuildFromLedger()  可重复执行
        ▼
Holdings（持仓缓存）      ← 【可重建】不是事实，删了能重算出来
        │
        │  valuateHolding()  读行情 / 汇率
        ▼
Valuation（估值）         ← 每个持仓的可靠值 / 不可用 / 过期
        │
        ├──► Snapshot（每日快照）  ← 把「当天的事实」冻结存档，此后永不改写
        │
        ├──► Analysis（分析）      ← 六维度切分（类别/账户/账户类型/币种/地区/工具）
        │
        └──► History（历史趋势）    ← 只读已落盘的 Snapshot，不重算、不插值
```

**核心推论（改代码前必须理解）**

1. **只有 `Transaction` 是事实。** `Holding` 是缓存 —— 任何时候都能从交易重放得到。
   因此**不要**为了修一个数字去直接改 `Holding`；要改就改交易（或新增交易）。
2. **历史快照不可回溯改写。** 一旦某天的 `Snapshot` 落盘，之后无论行情/汇率/分类怎么变，
   那天的数字**都不变**。这是「历史可信」的前提。
3. **不可估值 ≠ 价值为 0。** 拿不到行情/汇率时，字段写 `undefined` 并标 `unreliable`，
   **绝不写 0 或 1**。
4. **禁止假成功。** UI 的成功提示必须出现在 Domain 真正写入之后。

---

## 2. 目录结构

```
src/
├── types/
│   └── portfolio2.ts          # ★ 全部数据模型（Account / Instrument / Holding /
│                              #   Transaction / Quote / FxRate / Snapshot …）+ 不变量注释
├── lib/
│   ├── db/                    # 数据层
│   │   ├── dexie.ts           #   Dexie 表与索引定义（★ 改索引要动 DB_VERSION）
│   │   ├── schema.ts          #   Schema 版本常量 + 迁移链定义
│   │   ├── migrations/        #   V2→V3→V4→V5→V6→V7→V8 迁移链 + verify.ts
│   │   ├── repository.ts      #   ★ 仓储**接口**（Domain 只依赖接口，不依赖 Dexie）
│   │   ├── dexieRepository.ts #   Dexie 实现 + 内存实现（测试用）
│   │   ├── backup.ts          #   导出 / 校验 / 恢复 / 回滚
│   │   ├── creation.ts        #   冷启动创建（账户 / 标的 / 手动持仓）
│   │   └── legacyStore.ts     #   1.x localStorage 读取器（本产品**不调用**，见 §9）
│   ├── ledger/                # 账本层（事实 → 效果 → 持仓）
│   │   ├── types.ts           #   ★ TRANSACTION_SEMANTICS：10 种交易类型的语义表
│   │   ├── derive.ts          #   ★ deriveLedgerEffects / deriveLedger（纯函数）
│   │   ├── rebuild.ts         #   从 Ledger 重建 Holdings
│   │   ├── reconcile.ts       #   账实校验（一致性诊断）
│   │   ├── transactionService.ts # ★ 记账 / 作废的唯一写入口
│   │   ├── cashConversion.ts  #   现金口径转换
│   │   ├── duplicates.ts      #   重复持仓检测
│   │   └── lifecycle.ts       #   POSTED / VOIDED
│   ├── valuation/             # 估值层
│   │   ├── engine.ts          #   ★ 六步估值流程 + calculateTotals
│   │   ├── quote.ts           #   行情选取（含 as-of 语义）
│   │   ├── fx.ts              #   汇率解析（缺汇率绝不 1:1）
│   │   ├── policy.ts          #   ★ 报价新鲜度策略（LIVE 1h / DELAYED 1d / CLOSED ∞ …）
│   │   ├── basis.ts           #   估值依据（给 UI 展示「这个数怎么来的」）
│   │   ├── priceService.ts    #   手动行情 / 汇率录入
│   │   ├── fxAutoFetch.ts     #   汇率自动获取（三级降级：er-api → jsdelivr → 种子）
│   │   └── quoteAutoFetch.ts  #   行情自动获取（按 instrumentType 路由：腾讯 / 天天基金）
│   ├── performance/           # 快照与归因
│   │   ├── snapshot.ts        #   ★ buildSnapshot / captureSnapshot（含日期守卫）
│   │   ├── dailySnapshot.ts   #   每日快照的幂等与崩溃恢复
│   │   ├── attribution.ts     #   归因恒等式与 openingGapDays
│   │   ├── history.ts         #   趋势与资产构成
│   │   ├── cashflow.ts        #   现金流分类
│   │   └── basisView.ts       #   历史估值依据的展示转换
│   ├── analysis/              # 六维度分析 + 覆盖率
│   └── portfolio/
│       └── liability.ts       # ★ 负债判定的**唯一入口** decideLiability()
├── pages/                     # 五个 Tab：首页 / 资产 / 分析 / 历史 / 设置
├── components/                # 各 Sheet（录入 / 确认 / 备份 …）
└── hooks/usePortfolio2.ts     # ★ 唯一的派生入口 loadPortfolio2()
```

**分层依赖方向（不要反向）**

```
types ← 所有层
db（仓储）        ← ledger / valuation / performance
ledger / valuation ← performance / analysis
performance / analysis ← pages / components
```

`pages` / `components` **不得**直接操作 Dexie，必须走 `PortfolioRepository`。

---

## 3. 数据层

### 3.1 表与索引（`src/lib/db/dexie.ts`）

| 表 | 索引 | 说明 |
| --- | --- | --- |
| `accounts` | `id, type, region, isLiability` | |
| `instruments` | `id, symbol, instrumentType, assetClass, currency, region, classificationStatus` | |
| `holdings` | `id, accountId, instrumentId, valuationMode` | ⚠️ **没有** `&[accountId+instrumentId]` 唯一索引（刻意的，见下） |
| `transactions` | `id, accountId, instrumentId, type, timestamp, [accountId+timestamp]` | |
| `quotes` | `id, instrumentId, status, timestamp, [instrumentId+timestamp]` | |
| `fxRates` | `id, baseCurrency, quoteCurrency, status, timestamp, [baseCurrency+quoteCurrency]` | |
| `snapshots` | `id, &date, createdAt` | **`&date` 是唯一索引**：一天只能有一条快照 |
| `allocationProfiles` | `id, name` | |
| `meta` | `key` | 操作状态（迁移记录、快照 attempt），**不是业务事实** |
| `classificationAudit` | `id, instrumentId, at, action` | 分类变更审计 |

> ⚠️ **绝不要给 `holdings` 加 `&[accountId+instrumentId]` 唯一索引。**
> 存量数据（尤其 1.x 迁移来的）可能有重复持仓，加唯一索引会让 Dexie 升级直接抛错 →
> **数据库打不开**。重复持仓由 `duplicates.ts` 检测并由用户自行处理。

### 3.2 版本与迁移

```
LEGACY_PORTFOLIO_VERSION = 2      // 1.x 的存储版本
PORTFOLIO_SCHEMA_VERSION = 8      // 当前 Schema
DB_VERSION               = 2      // Dexie 版本（2 即 dexie 的 version(2)）
```

迁移链（每一步在 `meta` 里各留一条 `MigrationRecord`）：

```
Legacy V2 → V3 → V4 → V5 → V6 → V7 → V8
            │      │      │      │      └─ historical-facts（W8：快照依据字段）
            │      │      │      └─ nullable-valuation（快照金额字段可缺失）
            │      │      └─ transaction-status（POSTED/VOIDED）
            │      └─ capture-kind（快照来源标记）
            └─ asset-class-at-capture（捕获当时的分类）
```

**改 Schema 的规则**

1. 只加**可选**字段，**零填充**（不给历史数据猜值）。
2. 提升 `PORTFOLIO_SCHEMA_VERSION`，并新建 `migrations/schema-vN-to-vN+1.ts`，
   在 `migrations/index.ts` 的迁移链里注册。
3. 只有**加表 / 加索引**才需要提升 `DB_VERSION`。
4. **不要回填历史事实** —— 缺失就保持 `undefined`，含义是「无法追溯」，不是「值为 0」。

### 3.3 仓储接口

Domain 层只依赖 `PortfolioRepository`（`src/lib/db/repository.ts`），有两个实现：
`createDexieRepository()`（生产）与 `createInMemoryRepository()`（测试）。
**测试几乎全部用内存实现**，因此又快又能断言内部状态。

```ts
repo.loadPortfolio()                // 一次性读出估值/分析所需全部数据
repo.replaceAll(portfolio, opts?)   // ⚠️ 全量替换：单事务 clear + bulkPut
repo.clearAll()                     // 全清
```

`replaceAll()` 在**一个 Dexie 事务**内先 `clear()` 再 `bulkPut()`，默认清理 9 张表：

```
accounts · instruments · holdings · transactions · quotes · fxRates
snapshots · allocationProfiles · classificationAudit（options.replaceAudit !== false 时）
```

`meta` 表**默认不动**（迁移记录必须保留）；只有显式传 `options.metaKv` 才会一并替换。

> ⚠️ `replaceAll()` **不是「导入」原语**。它是「先清空再写入」——
> 事务原子性只保证「不产生半套数据」，**不保证不丢数据**。
> 恢复流程必须走 `backup.ts` 的「校验 → dry-run → 暂存备份 → 原子切换」。

---

## 4. 账本层：事实如何变成持仓

### 4.1 十种交易类型（`src/lib/ledger/types.ts` 的 `TRANSACTION_SEMANTICS`）

| 类型 | 数量语义 | 成本语义 | 现金流 | 说明 |
| --- | --- | --- | --- | --- |
| `adjustment` | `set` | `set` | 无 | **期初余额**（不是增量！见下） |
| `buy` | delta | 增加 | 出 | |
| `sell` | delta | 按均价结转 | 入 | |
| `deposit` | 无 | 无 | 入（**外部**） | |
| `withdraw` | 无 | 无 | 出（**外部**） | |
| `dividend` | 无 | 不变 | 入 | 收益，不动成本 |
| `interest` | 无 | 不变 | 入 | 同上 |
| `fee` | 无 | 无 | 出 | |
| `transfer` | 账户间移动 | 按均价平移 | **无**（内部） | |
| `exchange` | 换汇两腿 | 无 | **无**（内部） | |

**`adjustment` 是 `set`（设定），不是 delta（增量）。**
它在派生时**先于所有 delta 无条件落地**（忽略日期顺序），
因此它的语义是「期初基线」，而不是「某天的余额修正」。
`recordTransaction` 会先做内存试算，任何领域 issue 都会**拒绝写入**。

### 4.2 派生过程（`derive.ts`）

```
deriveLedgerEffects(txs, { instrumentCurrency, isConfirmedCash })
  ├─ 过滤 VOIDED（唯一入口，下游不用再过滤）
  ├─ 排序：时间升序；同一时间 adjustment 优先
  ├─ 第一遍：落地所有 adjustment 的 set
  └─ 第二遍：按时间应用所有 delta（buy/sell/deposit/…/transfer）
```

`deriveLedger()` 在此之上再算出每个 `(accountId, instrumentId)` 的
`quantity / costBasis / averageCost / realizedPnl / income / fees`。

### 4.3 重建与账实校验

- `rebuildHoldingsFromTransactions()` —— 从 Ledger 重建 `holdings`。
  会**原样保留** `manual` 口径持仓与孤立持仓。
- `reconcileHoldings()` —— 账实一致性诊断，失败则**拒绝写入**。

**写入路径的完整顺序**（`transactionService.recordTransaction`）：

```
1 读取当前事实（repo.loadPortfolio）
2 前置校验（validateTransactionInput）
3 解析划转数量（transferQuantity）
4 构造交易 + 内存试算（deriveLedger）
5 领域 issue 一律拒绝
6 重复持仓检测
  ← 手动持仓冲突检测（同一 (账户,标的) 不能既有 manual 又有派生持仓）
7 重建持仓缓存
  ← 重建产物唯一性校验（发现重复键即拒绝写入）
8 reconcile 账实校验
9 全部通过才 repo.replaceAll(next)   ← 写入是**全有或全无**
```

### 4.4 作废（VOID）而非删除

`Transaction` **永不物理删除**。修正方式是「作废」：只改 `status = 'VOIDED'`。
`voidTransaction()` 会：

1. 试算并拒绝任何 issue；2. 终态负数检查；3. 清理「因本次作废失去最后依据」的持仓
（`droppedOrphans`）；4. 重建 + 对账；5. 整体写入。

> ⚠️ 作废「期初 `adjustment`」会让该持仓失去全部依据而被清理。
> `inspectVoidImpact()` 提供**只读预检**，UI 必须在确认前明确告知用户，
> 并给用户可操作的补救入口（补录为手动持仓）。

---

## 5. 估值层

### 5.1 六步流程（`engine.ts`）

```
Holding → Instrument → Quote → 原币价值 → FX → CNY
```

任一步无法可靠完成 → 返回 `unavailable` 或 `stale`，**绝不用 0 / 1 代替**。

### 5.2 估值状态

| 状态 | 含义 | 是否计入可靠总额 |
| --- | --- | --- |
| `ok` | 可靠估值 | ✅ |
| `stale` | 数据过期，但有展示值（`staleDisplayValueCny`） | ❌ |
| `unavailable` | 无法估值 | ❌ |

### 5.3 报价新鲜度策略（`policy.ts`）

| `QuoteStatus` | 新鲜度上限 | 说明 |
| --- | --- | --- |
| `LIVE` | 1 小时 | 盘中价 |
| `DELAYED` | 1 天 | 延迟行情 |
| `CLOSED` | ∞ | 收盘价，到下一交易时段前有效 |
| `MANUAL` | ∞ | 用户手填，不因时间失效 |
| `STALE` | 0 | 本身就是过期态 |
| `ERROR` | 0 | 永远不可用 |

**原则：宁可标 STALE，也不把过期行情冒充实时。**

### 5.4 汇率（`fx.ts`）

- 缺汇率 → `missing_fx` → `unavailable`，**绝不按 1:1 折算**。
- 过期汇率 → `stale_fx`。
- 支持反向与 CNY 中转。

### 5.5 as-of 语义（重要）

`latestQuoteFor(quotes, instrumentId, asOf?)`：
- **实时估值**：省略 `asOf` → 取全局最新。
- **快照捕获**：传 `asOf = 捕获时刻` → 只取 `timestamp <= asOf` 的最新行情。

这样**未来时间的行情不会进入更早时点的估值**。

> ⚠️ **已知缺口（Post-Release 待修）**：`fx.ts` 的汇率选取**没有** as-of 上界，
> 未来日期的汇率会被采用。修法是在 `pick()` 加 cutoff。

---

## 6. 负债判定（唯一入口）

`src/lib/portfolio/liability.ts` 的 `decideLiability(account, instrument)` 是
**全系统唯一的负债判据**：

| 情况 | 判定 |
| --- | --- |
| `instrument.assetClass === 'liability'` | 负债 |
| `account.isLiability === true` | 负债 |
| 两者都成立 | 负债（**只算一次**，返回布尔，结构上不可能重复计入） |
| 两者冲突（账户负债但标的是资产类别） | **按负债计入（更保守）** + 标记 `conflict` 供 UI 提示 |

判定结果随 `ValuationResult.isLiability` 向下传递，
`calculateTotals` / `buildSnapshot` / `deriveAnalysis` **全部只读它** ——
**禁止**在任何别处重写 `assetClass === 'liability'` 或 `account.isLiability` 判断。

**口径三分（不要混淆）**：

```
grossAssets      = 资产合计（不含负债）
totalLiabilities = 负债合计
netWorth         = grossAssets − totalLiabilities
```

资产类别占比的分母是 **`grossAssets`**，负债**不进**资产占比。

---

## 7. 快照与归因

### 7.1 快照的不可变性与日期守卫

`captureSnapshot()` **只允许创建「本地今天」的快照**：

| 日期 | 处理 |
| --- | --- |
| 本地今天 | 允许（同日可刷新，保留 `id` 与 `createdAt`） |
| 过去 | **抛错**（估值用的是当前持仓 + 最新行情，没有 as-of 能力） |
| 未来 | **抛错**（未来尚未发生） |

`dryRun: true` 不受限（不产生历史事实）。

**历史快照永不重算。** `ensureDailySnapshot()` 只在「目标日期是今天」时才刷新。

### 7.2 归因恒等式

```
netWorth = openingNetWorth
         + externalInflow − externalOutflow
         + investmentReturn
         + fxEffect
         + otherAdjustment
```

- `residual` 超容差时写入 `otherAdjustment` **并降级为 `partial`**，绝不静默塞进收益。
- `openingGapDays(opening, date)`：期初与目标日期**不相邻**时（间隔 > 1 天），
  归因降级为 `unavailable`，金额字段留 `undefined` —— **不摊平、不猜测**。

### 7.3 快照持仓的「依据」字段（Schema V8）

为了让历史能自证「这一天这个价为什么是这个数」，
`SnapshotPosition` 落盘了：`asOf` / `priceKind` / `quoteStatus` / `quoteSource` /
`fxStatus` / `fxSource` / `reasons` / `staleValueCny` / `isLiabilityAtCapture`。

`Snapshot` 还有 `openingDate`（期初是哪天）与 `capturedAt`（内容对应的捕获时刻）。

> ⚠️ V7 及以前的快照**没有**这些字段，**不回填** —— 缺失 = 「无法追溯」。
> 展示时用 `basisView.ts`，缺失一律显示「无法追溯」，**绝不补值**。

---

## 8. 开发与构建

### 8.1 命令

```bash
pnpm install            # 安装依赖
pnpm dev                # 开发服务器（默认 http://localhost:5173）
pnpm typecheck          # tsc -b --noEmit
pnpm test               # vitest run（46 个测试文件 / 约 1080 条）
pnpm build              # tsc -b && vite build → dist/
pnpm preview            # 本地预览构建产物
```

**Node 必须 ≥ 22.13**（`pnpm@11.7.0` 用到 `node:sqlite`；Node 20 会抛
`ERR_UNKNOWN_BUILTIN_MODULE`）。

### 8.2 图标（与 1.0 刻意区分）

图标不是手画的位图，而是**同一份视觉稿**的两个形态：

| 文件 | 作用 |
| --- | --- |
| `public/favicon.svg` | 矢量稿，浏览器标签页图标 |
| `public/icons/*.png` | 位图稿，由脚本从同一视觉稿渲染（iOS 只认 PNG） |
| `scripts/gen-icons.cjs` | 渲染脚本：`node scripts/gen-icons.cjs`（用 2.0 **自己的** `playwright` devDependency） |

视觉语义：**三根青→靛蓝的层叠上升柱 + 底部聚合底盘 + 顶端金色圆点**
（= 多个来源汇总成一个数），底板深墨蓝 `#070b14`。
与 1.0「纯黑底 + 金色单张卡片」在桌面上一眼可区分。

> ⚠️ 改图标时**必须同时更新** `favicon.svg`（矢量）与 `gen-icons.cjs`（位图渲染），
> 然后重跑脚本，否则标签页图标与桌面图标会不一致。

### 8.3 测试约定

- 框架 Vitest，环境 `node`，`src/test/setup.ts` 注入 `fake-indexeddb`。
- 测试文件与源码同目录：`*.test.ts`。
- 绝大多数领域测试用 `createInMemoryRepository()`；
  需要验证 Dexie 真实行为时用 `createPairedTestStore(name)`。
- 联网接口用例用 `describe.skipIf / it.skipIf` 条件跳过，CI 设 `ACW_SKIP_API=1`。

### 8.4 E2E 回归测试（`tests/e2e/`）

用 Playwright 驱动**真实浏览器**打开**真实构建的站点**，断言界面与 IndexedDB ——
补单元测试的盲区（样式失效、布局遮挡、跨版本存储串味等，只有真开浏览器才能发现）。

```bash
# 先构建并起本地 preview（端口 4173），再跑
cd tests/e2e && node w6.cjs
```

- 12 个脚本，覆盖各阶段功能与汇率/行情自动获取；详见 `tests/e2e/README.md`
- ⚠️ **新增联网功能时必须扩展 `tests/e2e/_helpers.cjs` 里的网络桩**，
  否则预置的固定汇率/行情会被真实抓取覆盖，断言随机失败
- 这套测试**不在 CI 里跑**（需要先起 preview 服务），由本地开发时手动执行
- `/tmp/acw-verify/` 是这套脚本进入仓库**之前**的旧存放地，**已废弃，不要再用**

### 8.5 部署（GitHub Pages）

`.github/workflows/deploy.yml` 在 `push main` 时执行：

```
checkout → setup pnpm → setup node 22 → pnpm install --frozen-lockfile
→ typecheck → test → build → touch dist/.nojekyll
→ configure-pages → upload-pages-artifact(dist) → deploy-pages
```

- `vite.config.ts` 的 **`base: './'`** → 产物全部相对路径，可在任意子目录部署。
- **无 SPA history 路由**（Tab 是 React state + localStorage），刷新不需要 404 兜底。
- **无 Service Worker、无 cache API** → 不存在缓存互顶问题。
- **无外部字体 / CDN**。

### 8.6 网络行为（重要，容易误判）

**汇率和行情都会自动获取**；两者都可以再用「手动录入」覆盖。

| 数据类型 | 来源 | 是否联网 |
| --- | --- | --- |
| **汇率** | 自动拉取（三级降级，见下） | ✅ 联网 |
| **行情（价格 / 净值）** | 自动拉取（按 `instrumentType` 路由，见下） | ✅ 联网 |
| 手动行情 / 手动汇率 | `valuation/priceService.ts`（写入 `source: 'manual'`） | ❌ 不联网 |

**汇率的三级降级**（`src/lib/valuation/fxAutoFetch.ts`）：

```
① open.er-api.com     → source 'er-api'    status LIVE
② jsdelivr            → source 'jsdelivr'  status DELAYED
③ public/fx-seed.json → source 'seed'      status SEED（不因时间失效）
```

- **兜底种子先落库、再尝试网络源**：种子是本地静态文件（毫秒级），
  网络源可能要等到超时。先落种子能让数字立刻可用，不会先闪一下「不可估值」。
- 网络源成功后，因为状态优先级 `LIVE(0) < DELAYED(1) < SEED(2)`
  （`fx.ts` 的 `rateStatusRank`），更权威的值自动接管，**不删除种子行**。
- 触发时机：启动 / 页面回到前台 / 每 6 小时（`FX_REFRESH_MS`），
  另有汇率面板里的「立即刷新」按钮。间隔用 `meta` 里的 `fx/last-sync` 节流，
  跨刷新、跨标签页都不会重复请求。
- **失败不抛错**：汇率不是核心依赖，全失败时如实返回并在 UI 标注来源。

> ⚠️ **候选比较的顺序很关键**（`fx.ts` 的 `chooseBetter`）：
> **先比「是否过期」，再比状态优先级**，最后比时间。
> 若先比状态优先级，一条已过期的 `LIVE` 会压住不过期的 `SEED`，
> 导致「拉取失败回落兜底」失效。改这里前请先读该函数的注释。

**行情的路由与兜底**（`src/lib/valuation/quoteAutoFetch.ts`，经 `hooks/useQuoteAutoSync.ts` 接入）：

| `instrumentType` | 数据源 | 价格字段 | `priceKind` |
| --- | --- | --- | --- |
| `fund`（场外基金） | `fundmobapi.eastmoney.com` | `NAV` 单位净值 | `nav` |
| `stock` / `etf`（含境内 sh/sz） | `qt.gtimg.cn`（**GBK 编码**） | 现价 | `market_price` |
| 其它（bond / gold / crypto …） | 不自动获取，保持手动 | — | — |

- 代码格式（6 位数字 / 1~6 位字母 / 1~5 位数字）**只用来决定「去哪个接口取数」**，
  **不决定「这是什么资产」** —— 资产类别始终由用户明确选择（见 §10 第 13 条）。
- 腾讯对无效代码返回 `v_pv_none_match="1";` —— **必须识别**，否则会被当成空结果误报成功。
- 触发时机：**打开应用 / 用户点「更新全部行情」**，不做定时轮询（与汇率不同）。
- **行情刻意不做静态种子文件**：你有多少标的就有多少条，且盘中分钟级变化，
  手工维护必然过期。兜底由 `quotes` 表自身承担 —— 拉取成功的记录留在库里，
  网络失败时 `policy.ts` 自动把它降级为 `STALE`，引擎给出「仅供展示」的过期价。

⚠️ **生产 bundle 里还有 1.0 视图的联网代码**：`src/main.tsx` 同时导入了
1.0 的 legacy 视图与 2.0 的正式外壳，由 `resolveView()` 运行时选择
（默认 `w3` = 2.0；`?legacy=1` 或 `?w2=1` 才是 1.0）。因此
`src/lib/fundService.ts` / `src/lib/usStock.ts` / `src/lib/fx.ts`
（各含一处 `fetch`，属 1.0 的基金与美股实时行情）会被打进同一个 chunk。

**结论**：
- 2.0 会自动发起的网络请求有**两类：汇率、行情**；
- ⚠️ 因此**新增联网模块时必须同步扩展回归脚本的网络桩**，
  且汇率、行情两类都要桩（见 [`tests/e2e/README.md`](tests/e2e/README.md)）——
  否则自动拉取会覆盖脚本预置的固定值，断言随机失败；
- 1.0 的联网模块**不要**在 2.0 的新功能里调用；
- 若要彻底移除，需要拆分入口或做代码分割 —— 属已知 P2（见 §11）。

### 8.7 兜底汇率文件（`public/fx-seed.json`）

网络源都拿不到时使用。**你只需要维护这一个文件**：

```json
{
  "asOf": "2026-10-05",
  "rates": { "CNY": 1, "USD": 6.71, "HKD": 0.855, "JPY": 0.0425 }
}
```

- 方向是**直读**的「1 外币 = ? CNY」（与 `FxRate` 的 base=外币 / quote=CNY 一致，
  **不做倒数**；两个网络源给的是反向数据，代码里会取倒数）。
- `asOf` 该值**不会**随时间被判为过期
  （`status: 'SEED'` 在 `resolveRate` 里短路过期判定）。
- 改完直接 commit，CI 约 2 分钟部署生效。
- 建议覆盖全部受支持币种（见 `src/lib/currency.ts` 的 `CURRENCIES`），
  否则未覆盖的币种在网络失败时仍会显示「不可估值」。

---

## 9. 与 1.0 WealthCard 的关系

| 维度 | 1.0 `WealthCard` | 2.0 `AssetIntegration` |
| --- | --- | --- |
| URL | `https://lixiaoyu233.github.io/WealthCard/` | `https://lixiaoyu233.github.io/AssetIntegration/` |
| 仓库 | `lixiaoyu233/WealthCard` | `lixiaoyu233/AssetIntegration` |
| 事实源 | **localStorage** | **IndexedDB** |
| 键 / 库名 | `asset-card-wallet/*` | `wealthcard` |
| PWA `id` | `/WealthCard/` | `/AssetIntegration/` |

**两者是独立产品，必须互不干扰。** 关键实现：

```ts
// src/main.tsx —— 2.0 的启动路径
const result = await migrateOnStart({ repo, db, readLegacyData: false })
```

⚠️ **`localStorage` 与 `IndexedDB` 是按 origin 隔离、不按路径隔离的。**
两个站点同属 `lixiaoyu233.github.io`，因此 2.0 **默认能读到** 1.0 的
`asset-card-wallet/*` 键。若不加这个开关，2.0 启动会把 1.0 数据迁移进自己的
IndexedDB，并调用 `setReadOnlyMode(true)` 把 **1.0 界面变成只读**。

**`readLegacyData` 的默认值是 `false`（不迁移）**，迁移必须显式传 `true`：

- **不读取**任何 `asset-card-wallet/*` 键；
- **不删除、不改写**任何键；
- 只开启只读（2.0 自身的事实源是 IndexedDB，不写 localStorage 业务键）；
- 如实返回 `status: 'no-legacy'`，不谎报迁移成功。

> ⚠️ **这个默认值是踩过事故才改的。**
> 2026-10-05 11:30–12:02，2.0 的构建被临时部署到了 1.0 的 URL（`/WealthCard/`）下，
> 而那时启动路径还没显式传 `false`、默认又是 `true` —— **一次页面加载**就把用户的
> 1.0 数据**复制**进了同 origin 的 `wealthcard` 库，两个产品从此共用一份数据。
> （1.0 的 localStorage 原件未被删除，只是被复制。）
>
> 改成默认 `false` 之后，**即使再发生同类误部署，也不可能跨版本污染**；
> 迁移能力保留，但必须显式开启。回归测试在
> `lib/db/w11MigrationGate.test.ts` 的「双版本隔离：缺省不迁移」。

> **改这一块时的红线**：不要让 2.0 读写 `asset-card-wallet/*`。
> `legacyStore.ts` 里的读取器与 `removeLegacyData()` 是给 1.x 迁移场景用的，
> 在本产品里**不应被调用**。

### 本地文件 / 仓库层面的隔离（已完全分开）

| 项 | 1.0 | 2.0 |
| --- | --- | --- |
| 本地目录 | `~/Documents/WealthCard` | `~/Documents/AssetIntegration` |
| 依赖 | 各自 `pnpm install`，**互不共用 `node_modules`** | 同左 |
| E2E 浏览器缓存 | 各自 `.cache/ms-playwright` | 同左 |
| Git remote | `lixiaoyu233/WealthCard` | `lixiaoyu233/AssetIntegration` |

> ⚠️ 这两条**曾经是共用的**：2.0 用 `node_modules` 软链复用 1.0 的依赖，
> E2E 的浏览器缓存与 `playwright` 也指向 1.0 目录。
> 2026-10-05，1.0 切回 v1.0.0 工作树并重装依赖（1.0 的依赖集里没有
> `dexie` / `fake-indexeddb`），2.0 立刻无法类型检查、无法构建、测试全挂。
> 现已各自独立：`playwright` 是 2.0 自己的 devDependency，
> 浏览器在 2.0 自己的 `.cache/` 下。

### ⚠️ 唯一无法靠代码消除的耦合：**同一个 origin**

两个站点都在 `lixiaoyu233.github.io` 下。而 **`localStorage` 与 `IndexedDB`
按 origin 隔离、不按路径隔离** —— 浏览器层面这两个产品**天生共用一份存储**。
代码能做的只有「约定不碰对方的键」，做不到物理隔离。

已做到的：
- 键 / 库名分开（`asset-card-wallet/*` vs `wealthcard`）；
- PWA `id` 分开（`/WealthCard/` vs `/AssetIntegration/`）；
- 启动迁移默认关闭（`readLegacyData` 默认 `false`，见上方事故记录）。

**要做到零风险，只能换 origin**，三选一：
1. 给 2.0 挂自定义域名（GitHub Pages 支持）；
2. 把 2.0 部署到别的托管（Cloudflare Pages / Vercel / Netlify）；
3. 换一个 GitHub 账号或组织，用 `<org>.github.io`。

在换之前，请把「**不要把 2.0 的构建部署到 1.0 的 URL 下**」当作硬约束 ——
2026-10-05 那次数据被迁移的事故就是这么发生的。

---

## 10. 不可违反的不变量（改代码前请逐条确认）

1. **`Transaction` 是唯一事实源**，`Holding` 是可重建缓存。
   不要为了让数字好看而直接改 `Holding`。
2. **不可估值 ≠ 价值为 0。** 拿不到就写 `undefined`，**绝不写 0**。
3. **缺汇率 ≠ 1。** 缺 `missing_fx`，**绝不 1:1 折算**。
4. **`STALE` / `ERROR` 不进可靠总额。** 过期只给展示值。
5. **历史快照不可回溯改写。** 不回填、不重算、不插值。
6. **负债判定只有 `decideLiability()` 一个入口。** 下游只读 `isLiability`。
7. **禁止假成功。** UI 成功提示必须晚于 Domain 写入；写入失败必须如实报错。
8. **作废不物理删除。** 只改 `status`，保留记录用于审计。
9. **负数量 / 负现金 / NaN 不得落库。** 写入前必须有终态检查。
10. **不给 `holdings` 加唯一索引。**
11. **`captureSnapshot` 不接受过去 / 未来日期。**
12. **恢复流程必须走「校验 → dry-run → 暂存备份 → 原子切换」**，不得直接 `replaceAll`。

---

## 11. 已知待办（Post-Release，不要顺手改）

以下是**已审计确认、明确延期**的项目。修改它们之前请先与产品负责人确认：

| 编号 | 问题 | 影响 |
| --- | --- | --- |
| P1-1 | 暂存备份写在 `localStorage`（约 5MB 配额） | 数据量约 1.4 年后导入会失败 |
| P1-2 | 回滚入口常驻、一键不可逆、无二次确认 | 误点会丢弃导入后的数据 |
| P1-3 | 每笔交易 `replaceAll` 全库重写（含整张 snapshots） | 3 年后单笔写入秒级卡顿 |
| P1-4 | 导入脏备份后写入锁死（校验只警告、写入却硬拒） | 需先修导入校验口径 |
| P1-5 | 负债冲突有提示但无修复入口（账户不可编辑） | 冲突无法消除 |
| P1-7 | **已部分修复**：账户可编辑（名称 / 机构 / 类型 / 地区，入口在「资产 → 账户维度 → 编辑」）、**手动口径**持仓可改金额 / 删除。**仍未做**：派生持仓的编辑删除、手工持仓留空会存成 0 占用唯一键 | 数据整理仍有缺口 |
| FX as-of | 汇率选取没有 cutoff，未来汇率会被采用 | 需在 `fx.ts` 的 `pick()` 加上界 |
| 收益类交易 | 利息 / 分红在「仅持有现金类标的」时 UI 无可选标的 | 领域层支持但 UI 死路 |
| P2 | 首屏体积（主 chunk 约 1.02 MB / gzip 311 kB，含 2.0 不使用的 recharts） | 纯性能 |

---

## 12. 修改建议

- **改账本语义** → 先读 `src/lib/ledger/types.ts` 的 `TRANSACTION_SEMANTICS`
  与 `derive.ts` 的两遍派生，再动任何东西。
- **改估值** → 先读 `src/lib/valuation/policy.ts` 与 `engine.ts` 的六步流程。
- **改 Schema** → 读 `src/lib/db/schema.ts` 顶部的不变量说明与
  `migrations/` 里已有迁移的写法（**零填充**是硬要求）。
- **改 UI 数字** → 确认它来自 `loadPortfolio2()` 的派生结果，
  而不是页面自己又算一遍。
- **任何「让数字更好看」的改动** → 先回来读 §10 的不变量清单。

---

## 附：许可与隐私

本工具**不上传任何数据**。所有资产信息只存在你自己浏览器的 IndexedDB 中，
清空站点数据即彻底删除。请自行定期使用「设置 → 备份与恢复」导出 JSON 备份。
