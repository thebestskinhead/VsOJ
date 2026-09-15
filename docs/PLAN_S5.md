# S5 比赛项目初始化 — 详细开发计划

> **状态：已实施完成（2026-09-13）**。S5.0–S5.7 全部落地并提交
> （`302c29f` → `8befccd` → `97cf269` → `9781b28` → `888d4a2` → `46acba7` → `af58e80`）。
> 验收：`npm test` 12 套件 / 520 项断言 + `npm run smoke:site` 84 项真实站点断言全绿。
> 实施结果与偏差见 `docs/PROGRESS.md` 的「S5 — 比赛项目初始化」一节。
>
> 本文档是 S5 的实施蓝图。**所有决策均由用户在 3 轮询问中逐条确认**（共 20 条，见 §2），
> 本文不含 S6 本地测试引擎、S7 状态页静态化、S3 静态资源外置的实现细节。
> 前置的 S4（网络 + 缓存闭环）已完成，见 `docs/PROGRESS.md`。

---

## 0. 范围

### 0.1 本轮要做

| # | 能力 | 触发源 | 优先级 |
|---|---|---|---|
| A | 单题懒初始化 | 用户点开某道题 | 高（默认路径） |
| B | 比赛全量预取 | 侧边栏题目列表的「初始化项目」条目（类 git init） | 高 |
| C | LeetCode 式分栏 | 进入题目：左 `main.cpp`（编辑器）+ 右题目（webview） | 高 |
| D | 增量补齐 | 重复进入 / 重复初始化 | 高 |
| E | 无工作区守卫 | 未打开文件夹时的提醒与只读降级 | 高 |
| F | 清理缓存语义按新布局收敛 | `oj.cache.purge` | 中 |

### 0.2 本轮不做

- **S6 本地测试引擎**：编译 `main.cpp`、跑样例、比对、写 `test/result.json`。
  本轮只**把目录与文件准备好**（`main.cpp`、`samples/`、`temp/`、`test/`），不引入评测逻辑。
- **MCP 工具扩展**：现有 3 个工具（`get_contest_problems` / `get_current_problem` /
  `get_contest_list`）本轮**不动**。图片本地路径、样例识别、一键测试留待 S6。
- S3 静态资源外置、S7 状态页静态化。

---

## 1. 动机：为什么 S5 是 LeetCode 流程的地基

用户明确的目标形态是 **LeetCode 模式**：浏览题目 → 自动切到这道题的源文件 → 左代码、右题目。

这套流程的每一步都**隐含假设磁盘上有这道题的文件**：

| 流程步骤 | 隐含依赖 | 没有初始化时 |
|---|---|---|
| 自动切到源文件 | 磁盘上存在源文件 | 没有文件可切 |
| 左代码 / 右题目 | 左边要有个真文件占位 | 只能两栏都是 webview |
| 一键本地测试 | 样例 + 可执行文件落盘 | 测试无处运行 |
| 提交「当前编辑的文件」 | 当前编辑器里是这道题的代码 | 没有文件，无法提交 |

所以项目初始化**不是可选优化，是这三个功能的共同前置**。这也是本轮必须先把 S5 做掉、
而不是先做测试模块的原因。

---

## 2. 已确认的决策（共 20 条，全部由用户拍板）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 派生文件（题面 md / 结构化 json）是否落盘 | **不落盘**，由 parser/api 按需产出。缓存只存原始信息（题面 HTML / 图片 / 样例） |
| D2 | 初始化入口 | **不在**原生弹窗；改为**侧边栏题目列表里的条目**，形态类似 Git 面板的「初始化仓库」，提供「初始化 / 暂不」两个动作 |
| D3 | 前置条件 | 用户需**提前打开一个文件夹** |
| D4 | 项目文件夹位置 | **`<workspaceFolder>/<cid>-<标题slug>/`**（可见、可打包、可 git） |
| D5 | 全量预取范围 | 比赛页 HTML + 每题题面 + 样例 + 题面图片。**不含提交状态** |
| D6 | 重复进入的行为 | **增量补齐**：已存在的复用不重拉，只补缺失；新鲜度交给 S4 的重访刷新 |
| D7 | 每题目录内容 | 缓存信息 + 测试文件 + 一个源文件 + 一个临时文件夹 |
| D8 | 源文件名 | **`main.cpp`** |
| D9 | 分栏行为 | 进入题目自动分栏，**复用已有**编辑器与面板，不强制重建、不抢已有位置 |
| D10 | 临时文件夹用途 | **编译产物 + 运行临时文件**（含程序运行时 cwd） |
| D11 | 提交逻辑 | **不变**，依然提交当前正在编辑的文件（`activeTextEditor`） |
| D12 | 访问方式 | 站点通信层不变；「更新前的访问逻辑」不需要保留，允许重构 |
| D13 | 初始化路径形态 | **懒初始化单题（默认）+ 侧边栏条目做全量预取**，两条路共用同一个 `ensureProblem()` |
| D14 | 懒初始化默认状态 | **默认开启**，并提供 `oj.project.lazyInit` 开关；关掉后未初始化的题只读显示、不分栏 |
| D15 | 未打开文件夹时 | 提醒用户先打开文件夹；此时**只能查看题目**（不写盘、无缓存、不分栏），**且无法提交代码** |
| D16 | 题目目录名 | **`<全局题号>-<标题slug>`**（如 `1722-复杂度分析(Ⅰ)`） |
| D17 | 比赛目录名 | **`<cid>-<标题slug>`**（沿用 S1 规则） |
| D18 | 清理缓存的边界 | **删** `raw/`、`assets/`、`samples/`、`temp/`；**保留** `main.cpp`、`test/`、`meta.json` |
| D19 | 条目「暂不」的语义 | **本次会话隐藏**，下次启动 VS Code 或重新进入比赛时再出现一次 |
| D20 | `main.cpp` 初始内容 | **最小 C++ 骨架**（`#include <bits/stdc++.h>` + `main` 函数），不是 0 字节 |

> 另有一条**沿用 S1 的既有约定**（非本轮新决定）：目录名一旦首次落盘**不再变化**，
> 即使站点标题后来改了也不改名。原因见 S1 的踩坑记录（同一 cid 曾派生出 4 个目录）。

---

## 3. 本轮新增的实测事实

这些都是判定依据，不是假设。

### 3.1 `pid` 是比赛内 0 起序号，题号字母可由它确定性推导

抓 `contest.php?cid=3775` 的 `#problemset` 原始行：

```html
<td>1722 Problem &nbsp;A</td><td><a href='problem.php?cid=3775&pid=0'>复杂度分析(Ⅰ)</a></td>
<td>1723 Problem &nbsp;B</td><td><a href='problem.php?cid=3775&pid=1'>复杂度分析(Ⅱ)</a></td>
<td>1719 Problem &nbsp;C</td><td><a href='problem.php?cid=3775&pid=2'>Josephus问题(I)</a></td>
<td>2551 Problem &nbsp;D</td><td><a href='problem.php?cid=3775&pid=3'>Josephus问题(Ⅱ)</a></td>
```

- 该比赛 `pid` 取值 **0–20 共 21 道题**；
- `pid` = **比赛内序号**，字母 = `numToLetter(pid)`（`parser.ts` 现有实现，0→A…25→Z→AA）
  → **D16 的命名方式安全**；
- 单元格里的 **全局题号（1722 / 1723 / 1719 / 2551）与 `pid` 无算术关系**，
  是独立信息 → 单独存进 `meta.json`，不参与目录命名。

### 3.2 题目 webview 已经开在右栏

`src/webview/problemWebview.ts` 现有：

```ts
this.panel.reveal(vscode.ViewColumn.Two, true);
this.panel = vscode.window.createWebviewPanel(
  ..., { viewColumn: vscode.ViewColumn.Two, preserveFocus: true }, ...);
```

→ 「右题目」**已成立**，「左代码」只差把 `main.cpp` 打开到 `ViewColumn.One`。

### 3.3 S5 前置缺口已收敛到 1 项

S4 期间复核了 `PLAN_S4.md` §8 的四项，三项已落地（`test/` 路径出口、`hint` 字段、
图片落盘），**只剩「样例未落盘」**（`store.writeSamples` 至今无调用方）。
S5 的懒初始化正好接上这条线。

---

## 4. 目标目录布局

```
<workspaceFolder>/                     # D3 硬前置：用户必须先打开文件夹
├── .vsoj/                             # 内部数据根（oj.workspace.root，默认 .vsoj）
│   └── lists/
│       └── list-p1.html               # 比赛列表缓存（无比赛归属，留在内部根）
└── 3775-Contest3775-.../              # D4 + D17 比赛项目文件夹（可见、可打包、可 git）
    ├── meta.json                      # 项目元信息（唯一非站点文件）
    ├── contest-raw/
    │   ├── contest.html               # 比赛页原始 HTML
    │   └── status.html                # 提交状态原始 HTML（S4 的按需缓存，非初始化预取）
    └── problems/
        └── 1722-复杂度分析(Ⅰ)/          # D16 目录名 = <全局题号>-<标题slug>
            ├── raw/page.html          # [缓存] 题面原始 HTML（题面唯一来源）
            ├── assets/                # [缓存] 题面图片二进制 <hash>-<名>.<ext>
            ├── samples/1.in, 1.out    # [缓存] 样例数据集
            ├── main.cpp               # [用户] 最小 C++ 骨架（D20）
            ├── test/                  # [产物] S6 本地测试结果 result.json / report.md
            └── temp/                  # [产物] 编译产物 + 运行临时文件（D10）
```

**清理语义（D18）**：

| 目录 | 性质 | `oj.cache.purge` 时 |
|---|---|---|
| `raw/` | 缓存（可从站点重拉） | **删除** |
| `assets/` | 缓存（可从站点重拉） | **删除** |
| `samples/` | 缓存（可从题面重新解析） | **删除** |
| `temp/` | 产物（可重建） | **删除** |
| `main.cpp` | **用户资产** | **保留** |
| `test/` | 产物（评测历史） | **保留** |
| `meta.json` | 项目元信息 | **保留** |

> 保留 `test/` 的理由：它是「我什么时候测过、结果如何」的历史记录，
> 与可重建的编译产物不同。用户已确认。

`meta.json` 结构（唯一的非站点文件，是身份 ↔ 目录的唯一映射来源）：

```json
{
  "cid": "3775",
  "title": "Contest3775-...",
  "createdAt": "2026-09-13T…",
  "initializedAt": "2026-09-13T…",
  "layoutVersion": 3,
  "problems": [
    { "pid": "0", "letter": "A", "identity": "g:1722", "globalId": "1722", "dir": "1722-复杂度分析(Ⅰ)", "title": "复杂度分析(Ⅰ)" }
  ]
}
```

---

## 5. 设计与理由

### 5.1 初始化路径：懒初始化单题 + 条目预取（D13/D14）

用户的目标是 LeetCode 式「浏览哪题就自动切过去」。若把初始化做成**硬门槛**
（必须先全量初始化才能点题），这个即时感就被打断了。因此：

| 路径 | 触发 | 行为 | 代价 |
|---|---|---|---|
| **默认（懒初始化单题）** | 点开某题 | 只落这一题（`raw` + `samples` + `main.cpp` + `temp/`），立即分栏 | 几 KB + 一个源文件，无确认、无等待 |
| **预取（初始化项目）** | 点侧边栏条目 | 全量拉 N 题，带进度、可取消 | 首次进入需串行等待 |

- 两条路**共用同一个 `ensureProblem()`**，不存在两套逻辑。
- **不做「进入比赛即自动全量初始化」**：`cid=3775` 就有 21 道题，串行首屏等待过久；
  且未打开文件夹时无处落盘。
- 懒初始化会写盘，故提供 `oj.project.lazyInit` 开关（D14）；关掉后未初始化的题
  只读显示、不分栏。

### 5.2 未打开文件夹时（D3/D15）

- **提醒而不是干吼**：提示语带「打开文件夹」按钮（`vscode.openFolder`），一键直达。
- **能力边界**（用户确认）：
  - ✅ 可以查看题目（S4 的题面渲染不依赖本地磁盘）
  - ❌ 不写盘、**无缓存**（无缓存根，题面直连站点）
  - ❌ 不开分栏
  - ❌ **无法提交代码**（提交入口给出明确提示并阻止）
  - ❌ 不显示「初始化项目」条目
- 侧边栏题目列表在无文件夹时显示一个占位项说明原因，而不是空白。

### 5.3 侧边栏「初始化项目」条目（D2/D19）

- 出现条件：**已打开文件夹 + 该比赛未初始化 + 条目未被本次会话隐藏**。
- 形态：题目列表里的一个条目（类 Git 面板的「初始化仓库」），带两个动作：
  - **初始化** → 触发全量预取（带进度通知、可取消）
  - **暂不** → **本次会话隐藏**该条目；下次启动 VS Code 或重新进入比赛时再出现一次
- 配置项 `oj.project.initEntryVisible`（默认 `true`）可彻底关掉该条目。

### 5.4 增量补齐（D6）

`ensureProblem(cid, pid)` 是唯一的写盘入口，幂等：

```
若 raw/page.html 存在              → 跳过网络（不判断新鲜度，新鲜度归 S4）
否则                               → 拉题面 → 落 raw/page.html
若 samples/1.in 不存在且题面可解析   → writeSamples（接上 S4 遗留的无调用方）
若 assets/ 为空且题面含图            → 下载图片（约 4% 的题有图）
若 main.cpp 不存在                  → 写最小 C++ 骨架（D20）；已存在则绝不覆盖
若 temp/ test/ 不存在               → mkdir
```

全量初始化 = 对题目列表里每个 pid 调用 `ensureProblem`：**串行、不重试、可取消、
失败汇总不中断**（与 S4 的 `ProblemRefresher` 同一套约定，保持行为一致）。

### 5.5 目录名一旦定稿不再变化（沿用 S1）

- 比赛目录名首次创建时定为 `<cid>-<标题slug>`，题目目录名定为 `<全局题号>-<标题slug>`，
  之后**即使站点标题改了也不改名**；
- `meta.json.problems[].dir` 是唯一映射来源，不靠重新推导；
- slug 规则复用 S1 的同一套字符处理（Windows 非法字符 `\ / : * ? " < > |` 替换、长度上限）。

---

## 6. 阶段切分

| 阶段 | 内容 | 可独立验证 | 状态 |
|---|---|---|---|
| **S5.0** | 布局改造：`paths.ts` 新增 `contestRawDir` / `tempDir` / `mainSource(pid)`；比赛目录移到 workspace 根；题目目录改字母命名；列表缓存迁至 `.vsoj/lists/`；`layoutVersion: 2` | 重写后的 `test:cache` 全绿 | ✅ 91 项 |
| **S5.1** | `src/workspace/initializer.ts`：`ensureProblem` / `initializeContest`，依赖注入（fetcher / store / paths / progress / isCancelled），失败汇总，最小 C++ 骨架 | 新增 `test/init.test.js` | ✅ 83 项 |
| **S5.2** | 工作区守卫：未打开文件夹的检测、提醒（带「打开文件夹」按钮）、只读降级、**提交阻断** | 新增 `test/workspace-guard.test.js` | ✅ 65 项 |
| **S5.3** | 侧边栏「初始化项目」条目：「初始化 / 暂不（本次会话隐藏）」、`oj.project.initEntryVisible`、无文件夹占位项 | 断言条目的决策函数 | ✅ 35 项 |
| **S5.4** | 懒初始化接入 `oj.showProblem`：确保文件 → 打开 `main.cpp`（Column One）→ 题目面板（Column Two，已存在） | `test:opensource` + 手工验证分栏 | ✅ 11 项 |
| **S5.5** | 配置项 + 清理缓存语义按 §4 表更新 | `test:config` 一致性 + `test:cache` 清理用例 | ✅ 11 项 |
| **S5.6** | 真实站点冒烟扩展：懒初始化单题 → 全量初始化整个比赛 → 校验目录树 → 离线重进 → 清理后 `main.cpp` 仍在 | `npm run smoke:site` | ✅ 84 项 |
| **S5.7** | 文档收口（README / PROGRESS / ARCHITECTURE） | — | ✅ |

---

## 7. 行为契约（验收依据）

| 编号 | 契约 |
|---|---|
| C1 | 未打开文件夹时，点题目 → 提醒（带「打开文件夹」按钮）+ 只读题面；不写盘、不开分栏、不使用缓存 |
| C2 | 未打开文件夹时，执行提交 → 明确提示需先打开文件夹并初始化题目，**阻止提交** |
| C3 | 已打开文件夹、未初始化时，点题目 → 只懒初始化该题，**不弹确认框** |
| C4 | 懒初始化默认开启；`oj.project.lazyInit=false` 时未初始化的题只读显示、不分栏 |
| C5 | 初始化完成后，左侧打开 `main.cpp`，右侧显示题目面板；两者都**复用已有**，不重建 |
| C6 | 同一题重复进入 → 不重复拉取、**不覆盖** `main.cpp`（哪怕用户已写代码） |
| C7 | 「初始化项目」条目仅在「已打开文件夹 + 未初始化 + 未被本次会话隐藏」时出现 |
| C8 | 点「暂不」→ 该条目本次会话隐藏，下次启动或重新进入比赛时再出现一次 |
| C9 | 全量初始化串行执行，带进度通知，可取消；取消后已完成的题**保留** |
| C10 | 全量初始化中单题失败不中断整体，结束时汇总失败题目 |
| C11 | 站点标题变化**不改**已定稿的目录名（比赛与题目两级都适用） |
| C12 | 清理缓存按 §4 表执行，**绝不动** `main.cpp` 与 `test/` |
| C13 | 提交行为不变：提交 `activeTextEditor` 的内容（左右分栏下 webview 不是文本编辑器，故仍指向 `main.cpp`） |
| C14 | 新建的 `main.cpp` 含最小 C++ 骨架，可被编译器直接接受 |
| C15 | 题面「提示」小节、题面图片在初始化后仍然可用（离线可看） |

---

## 8. 测试策略

沿用 S4 的做法：**脱离 VS Code 运行时**（`vscode` 模块桩 + 本地 HTTP 服务器）。

| 套件 | 覆盖 |
|---|---|
| `test/cache-layout.test.js`（重写） | 新布局、字母目录命名、`mainSource` / `tempDir`、清理语义保留项 |
| `test/init.test.js`（新增） | `ensureProblem` 幂等 / 增量 / 已存在不覆盖 `main.cpp`；骨架内容（C14）；全量初始化的串行、取消、失败汇总；slug 字符处理 |
| `test/workspace-guard.test.js`（新增） | 无文件夹 / 已打开未初始化 / 已初始化 三态的决策函数；提交阻断判定（C2） |
| `scripts/smoke-site.js`（扩展） | 真实站点：懒初始化 → 全量初始化 `cid=3772` → 校验目录树与文件 → 断网重进 → 清理后 `main.cpp` 仍在 |

---

## 9. 需要改动的文件清单

**新增**
- `src/workspace/initializer.ts`、`src/workspace/guard.ts`（工作区守卫）
- `test/init.test.js`、`test/workspace-guard.test.js`

**修改**
- `src/cache/paths.ts`（布局 v2）、`src/cache/store.ts`（`tempDir`、清理表、`layoutVersion`）
- `src/views/problemTree.ts`（「初始化项目」条目 + 无文件夹占位）
- `src/views/contestTree.ts`（触发编排）
- `src/extension.ts`（`oj.showProblem` 懒初始化 + 分栏；提交阻断；新增
  `oj.project.initialize` / `oj.project.initializeProblem` / `oj.project.dismissInitEntry` 命令）
- `src/utils/config.ts`（`oj.project.*` 配置）
- `package.json`（配置项 + 命令）
- `test/cache-layout.test.js`、`scripts/smoke-site.js`、`README.md`、`docs/*`

---

## 10. 决策状态

§2 的 **20 条决策已全部由用户确认**，无待定项。

两条**已知代价**，由用户明确接受：

1. **D4（比赛目录移到 workspace 可见根）推翻 S1 的布局定稿**，
   需要重写 `test/cache-layout.test.js` 的 57 项断言并更新 `scripts/smoke-site.js`
   与 README 布局图。插件**不会**自动修改用户的 `.gitignore`（沿用既有约定）。
2. **D8 + D20**：`main.cpp` 用最小 C++ 骨架而非 0 字节空白，
   因此该文件**不是**纯空文件；已存在时永不覆盖（C6）。
