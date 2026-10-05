# E2E 回归测试

用 Playwright 驱动**真实浏览器**打开**真实构建的站点**，像用户一样点击输入，
然后断言界面与 IndexedDB。

## 为什么需要（单元测试抓不到的）

单元测试测函数逻辑（内存数据库、毫秒级）；E2E 测「用户实际看到和经历的东西」。
以下都是**单元测试没发现、E2E 抓到**的真实缺陷：

| 缺陷 | 单元测试为什么没发现 |
| --- | --- |
| `bg-ink` / `text-s1` 类名不存在 → 所有主按钮看不见 | 那是 CSS，测试不看样式 |
| `text-ink` 类名不存在 → 100 处文字色失效 | 同上 |
| 主题与 1.0 共用 `localStorage` 键 → 跨版本串味 | 需要真实 origin + localStorage |
| 小屏上面板遮罩中心点被内容拦截 → 关不掉面板 | 需要真实布局几何 |
| 划转数量映射错（UI 传错字段） | 单元测试直接调 service，绕过了 UI |

**共同点**：代码逻辑没错，但用户体验是坏的。

## 怎么跑

### 1. 准备

```bash
cd <项目根>
pnpm install           # 装本仓库**自己的**依赖（playwright 也在其中）
```

Playwright 浏览器缓存在**本仓库自己的** `.cache/ms-playwright`（已在 `.gitignore` 中）。
若提示缺失（换机器、清过缓存）：

```bash
pnpm exec playwright install chromium
```

⚠️ **不要复用其它项目（尤其 1.0 `WealthCard`）的 `node_modules` 或浏览器缓存。**
两者依赖集不同（1.0 没有 `dexie` / `fake-indexeddb`），共用会让本项目无法
类型检查 / 构建 —— 2026-10-05 就这么坏过一次。

### 2. 构建并起本地服务

```bash
pkill -f "vite.js preview"
npm run build
(nohup node node_modules/vite/bin/vite.js preview \
   --port 4173 --strictPort --host 127.0.0.1 >/tmp/p.log 2>&1 &)
sleep 4
```

### 3. 跑测试

```bash
cd tests/e2e
export PLAYWRIGHT_BROWSERS_PATH=<项目>/.cache/ms-playwright
node w6.cjs          # 单个
```

脚本会打印逐项结果与汇总，退出码 `0` = 全通过。

> **只跑受影响的**。全量 12 个要十几分钟，小改动没必要。
> 推送前跑一次全量。

## 脚本一览

| 脚本 | 覆盖 |
| --- | --- |
| `w2` | 只读视图业务断言（`?w2=1`） |
| `w3` | 正式入口 + 五个 Tab + 分类确认 + 现金转换 |
| `w4` | 交易录入 / 流水 / 详情；买入卖出划转守恒 |
| `w5` | 交易作废（VOID）语义 |
| `w6` | 行情与汇率录入 + 估值依据可见 |
| `w7` | 存储与只读模式 |
| `w8` | 快照与归因、历史估值依据 |
| `w9` | 历史依据展示、asOf 语义 |
| `w10patch` | 划转数量、回滚、作废影响预检 |
| `w11` | 手动持仓与账本冲突、**1.0/2.0 数据隔离** |
| `fxauto` | 汇率自动获取三级降级（**真实网络**） |
| `quoteauto` | 行情自动获取（**真实网络**） |

## ⚠️ 新增联网功能时，必须扩展网络桩

**这是本项目最容易踩的坑，已踩过两次。**

应用会自动拉取**汇率**（`open.er-api.com` → `jsdelivr` → `public/fx-seed.json`）
和**行情**（`qt.gtimg.cn`、`fundmobapi.eastmoney.com`）。
回归脚本预置的是固定汇率/行情，联网抓取会**覆盖它们**，导致金额断言随机失败。

`_helpers.cjs` 里有两个桩，按需调用：

```js
const { stubFxNetwork, stubQuoteNetwork } = require('./_helpers.cjs');

const p = await ctx.newPage();
await stubFxNetwork(p);      // 让汇率源「不可用」
await stubQuoteNetwork(p);   // 让行情源「不可用」
```

### 但两个专项脚本要反着来

`fxauto` / `quoteauto` 测的**就是**真实拉取，只能桩掉**无关的那一类**：

| 脚本 | 只桩 | 原因 |
| --- | --- | --- |
| `fxauto` | `stubQuoteNetwork` | 它要测真实汇率拉取，桩掉汇率等于废掉测试 |
| `quoteauto` | `stubFxNetwork` | 它要测真实行情拉取 |

### 另外两条约定

**① 关闭面板要点面板内的按钮，不要点全屏遮罩**

```js
// ✅ 稳
await p.click('[role="dialog"] button[aria-label="关闭面板"]');
// ❌ 不稳：遮罩是全屏按钮，Playwright 点它的中心点，
//    而面板 max-h-[92vh] 在小屏上几乎占满 → 中心点被面板内容拦截
await p.click('button[aria-label="关闭"]');
```

**② 不要删掉 `_helpers.cjs` 里对 `net::ERR_FAILED` 的过滤**

故意 abort 网络时 Chrome 会打内建日志 `net::ERR_FAILED`，
那**不是应用异常**（已验证 `unhandledrejection = 0` / `pageerror = 0`）。
过滤在 `collectErrors()` 里，删掉会让所有脚本报「存在未捕获异常」。

## 写新断言时注意

- **不要断言绝对行数**。新功能常会往表里写新行（如自动汇率每天每源一行），
  断言「`fxRates` 应有 3 条」会失效。**按自己写入的数据过滤后计数**。
- 播种时若 `snapshots.date` 有唯一索引，**同日期要先删再插**；
  且「今天」的快照会被应用重捕覆盖，播种历史请用**过去的日期**。
- 选择器的 label 要传字符串；用正则匹配选项文本时用
  `page.evaluate` + `new RegExp` 取 `option.value`。
- 复选框要用**点击它的 `<label>`** 触发 React 的 `onChange`，
  直接设 `checked = true` + `dispatchEvent` 不会生效。

## 文件结构

```
tests/e2e/
├── README.md          ← 本文件
├── _helpers.cjs       ← 公共：计分、网络桩、错误采集、关面板、切 Tab
├── w2.cjs … w11.cjs   ← 各阶段回归
└── fxauto.cjs / quoteauto.cjs
```
