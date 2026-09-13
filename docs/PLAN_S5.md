# S5 比赛项目初始化 — 详细开发计划

> 本文档是 S5 的实施蓝图。动机与决策全部来自本轮与用户逐条确认（§2），
> 本文不含 S6 本地测试引擎、S7 状态页静态化、S3 静态资源外置的实现细节。
> 前置的 S4（网络 + 缓存闭环）已完成，见 `docs/PROGRESS.md`。

---

## 0. 范围

### 0.1 本轮要做

| # | 能力 | 触发源 | 优先级 |
|---|---|---|---|
| A | 比赛项目初始化（全量预取） | 侧边栏题目列表里的「初始化项目」条目（类 git init） | 高 |
| B | 单题懒初始化 | 用户点开某道题 | 高（默认路径） |
| C | LeetCode 式分栏 | 进入题目：左 `main.cpp`（编辑器）+ 右题目（webview） | 高 |
| D | 增量补齐 | 重复进入 / 重复初始化 | 高 |
| E | 无工作区守卫 | 未打开文件夹时的提醒与只读降级 | 高 |

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
| 提交「当前编辑的文件」 | 当前编辑器里是这道题的代码 | 可能是任意文件 |

所以项目初始化**不是可选优化，是这三个功能的共同前置**。这也是本轮必须先把 S5 做掉、
而不是先做测试模块的原因。

---

## 2. 已确认的决策（本轮共 12 次提问）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 派生文件（题面 md / 结构化 json）是否落盘 | **不落盘**，由 parser/api 按需产出。缓存只存原始信息（题面 HTML / 图片 / 样例） |
| D2 | 初始化触发入口 | **不在**原生弹窗；改为**侧边栏题目列表里的条目**，形态类似 Git 面板的「初始化仓库」，提供「初始化 / 暂不」两个动作，且允许关闭该条目 |
| D3 | 前置条件 | 用户需**提前打开一个文件夹**；未打开时先提醒用户打开 |
| D4 | 项目文件夹位置 | **workspace 下一个比赛一个文件夹** |
| D5 | 预取深度 | **全量预取**：题目列表 + 每道题原始题面 + 样例 + 题面图片 |
| D6 | 重复进入的行为 | **增量补齐**：已存在的复用不重拉，只补缺失；新鲜度交给 S4 的重访刷新 |
| D7 | 每题目录内容 | 一个子文件夹，内含：**缓存信息 + 测试文件 + 一个空白源文件 + 一个临时文件夹** |
| D8 | 源文件名 | **`main.cpp`**（空白，0 字节） |
| D9 | 分栏行为 | 进入题目自动分栏，**复用已有**编辑器与面板，不强制重建、不抢已有位置 |
| D10 | 临时文件夹用途 | **编译产物 + 运行临时文件**（含程序运行时 cwd），清理缓存时一并清掉 |
| D11 | 提交逻辑 | **不变**，依然提交当前正在编辑的文件（`activeTextEditor`） |
| D12 | 访问方式 | 站点通信层不变；「更新前的访问逻辑」**不需要**保留，允许重构 |

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
- `pid` = **比赛内序号**，字母 = `numToLetter(pid)`（`parser.ts` 现有实现，0→A…25→Z→AA）→ **命名安全**；
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
<workspaceFolder>/                     # 硬前置：用户必须先打开文件夹
├── .vsoj/                             # 内部数据根（oj.workspace.root，默认 .vsoj）
│   └── lists/
│       └── list-p1.html               # 比赛列表缓存（无比赛归属）
└── <cid>-<比赛标题slug>/                # 比赛项目文件夹（可见、可打包、可 git）
    ├── meta.json                      # 项目元信息（唯一非站点文件）
    ├── contest-raw/
    │   ├── contest.html               # 比赛页原始 HTML
    │   └── status.html                # 提交状态原始 HTML
    └── problems/
        └── A-复杂度分析(Ⅰ)/              # 目录名 = <题号字母>-<标题slug>
            ├── raw/page.html          # [缓存] 题面原始 HTML（题面唯一来源）
            ├── assets/                # [缓存] 题面图片二进制 <hash>-<名>.<ext>
            ├── samples/1.in, 1.out    # [缓存] 样例数据集
            ├── main.cpp               # [用户] 空白源文件（0 字节）
            ├── test/                  # [产物] S6 本地测试结果 result.json / report.md
            └── temp/                  # [产物] 编译产物 + 运行临时文件
```

`meta.json` 结构（唯一的非站点文件，是 pid ↔ 目录的唯一映射来源）：

```json
{
  "cid": "3775",
  "title": "Contest3775-...",
  "createdAt": "2026-09-13T…",
  "initializedAt": "2026-09-13T…",
  "layoutVersion": 2,
  "problems": [
    { "pid": "0", "letter": "A", "globalId": "1722", "dir": "A-复杂度分析(Ⅰ)", "title": "复杂度分析(Ⅰ)" }
  ]
}
```

---

## 5. 关键设计决策

### 5.1 为什么初始化不做成「硬门槛」（对 D3 + LeetCode 流程的正面回答）

用户指出：不做项目初始化，LeetCode 流程就跑不通。但反过来把初始化做成**前置门槛**
同样会破坏它 —— 「浏览哪题就自动切过去」的即时感，会被「点个题先弹确认框」打断。

**因此设计为：初始化 = 按需 + 可预取，两者共用同一个 `ensureProblem()`。**

| 路径 | 触发 | 行为 | 代价 |
|---|---|---|---|
| **默认（懒初始化单题）** | 点开某题 | 只落这一题（`raw` + `samples` + `main.cpp` + `temp/`），立即分栏 | 几 KB + 一个空文件，无确认、无等待 |
| **预取（初始化项目）** | 点侧边栏条目 | 全量拉 N 题，带进度、可取消 | 首次进入需串行等待 |

- **不做「进入比赛即自动全量初始化」**：`cid=3775` 就有 21 道题，串行首屏等待过久；
  且未打开文件夹时无处落盘。
- **懒初始化也会写盘**，所以提供 `oj.project.lazyInit`（默认 `true`）可关掉；
  关掉后未初始化的题只以只读方式显示题面。

### 5.2 未打开文件夹时（D3）

用户要求「先提醒用户先打开一个项目文件夹」。实现上：

- **提醒而不是干吼**：提示语带「打开文件夹」按钮（`vscode.openFolder`），一键直达。
- **降级为只读题面**：没有文件夹 → 懒初始化无处落盘 → 题目仍以现有 webview 打开
  （S4 的题面渲染不依赖本地磁盘），但**不生成文件、不开分栏、不显示「初始化项目」条目**。
- 侧边栏题目列表在无文件夹时显示一个占位项说明原因，而不是空白。

> 取舍：也可以直接禁止看题，但那样用户连"这题是什么"都看不到，
> 惩罚过重且与「提醒」的定位不符。降级只读更合理。

### 5.3 缓存的边界与清理语义（对 D1 + D10 的落地）

项目文件夹里同时有**可重新获取的缓存**与**不可再生的用户资产**，必须分清
否则「清理缓存」会删掉用户代码：

| 目录 | 性质 | 清理缓存时 |
|---|---|---|
| `raw/` | 缓存（可从站点重拉） | **删除** |
| `assets/` | 缓存（可从站点重拉） | **删除** |
| `samples/` | 缓存（可从题面重新解析） | **删除** |
| `temp/` | 产物（可重建） | **删除** |
| `main.cpp` | **用户资产** | **保留** |
| `test/` | 产物（评测记录） | **保留** |
| `meta.json` | 项目元信息 | **保留** |

保留 `test/` 的理由：它是"我什么时候测过、结果如何"的历史记录，与可重建的编译产物不同。

### 5.4 项目文件夹放在 workspace 根、且可见 —— 这一条最值得你否决

**我的选择**：`<workspaceFolder>/<cid>-<标题slug>/`，即**可见**于资源管理器。

理由：
1. D4 明确选了「workspace 下一个比赛一文件夹」，且 LeetCode 式流程要求用户能在
   资源管理器里看到并手动打开 `main.cpp`；
2. 隐藏的 `.vsoj/` 不适合「当成一个普通项目用」——导出、打包、发给同学都不方便。

**代价（必须让你知道）**：
- 这会**推翻 S1 的「布局已定稿」**：`contestDir` 从 `<ws>/.vsoj/contests/<name>` 搬到
  `<ws>/<name>`，列表缓存从 `.vsoj/contests/list-*.html` 改为 `.vsoj/lists/list-*.html`，
  题目目录从 `problems/<pid>` 改为 `problems/<字母>-<标题slug>`，新增 `temp/`、去掉 `code/`。
- 需要**重写 `test/cache-layout.test.js` 的 57 项断言**并更新 `scripts/smoke-site.js`。
- 插件**不会**自动改你的 `.gitignore`（沿用既有约定），但会在初始化完成后提示
  建议忽略的条目。

**如果你觉得不值**：改回 `<ws>/.vsoj/contests/<name>/` 即可，其余设计完全不变，
且断言改动量降到约 1/3。这是本计划**唯一**一个高代价的可逆选择。

### 5.5 增量补齐（D6）

`ensureProblem(cid, pid)` 是唯一的写盘入口，幂等：

```
若 raw/page.html 存在            → 跳过网络（不判断新鲜度，新鲜度归 S4）
否则                             → 拉题面 → 落 raw/page.html
若 samples/1.in 不存在且题面可解析 → writeSamples（接上 S4 遗留的无调用方）
若 assets/ 为空且题面含图          → 下载图片（约 4% 的题有图）
若 main.cpp 不存在                → 写 0 字节 main.cpp
若 temp/ test/ 不存在             → mkdir
```

全量初始化 = 对题目列表里每个 pid 调用 `ensureProblem`：**串行、不重试、可取消、
失败汇总不中断**（与 S4 的 `ProblemRefresher` 同一套约定，保持行为一致）。

### 5.6 目录名一旦定稿不再变化（沿用 S1 的教训）

S1 踩过「同一 cid 派生出 4 个目录」的坑，结论是**目录名首次落盘后不再变化**。
本轮沿用并扩展到题目目录：

- 题目目录名首次创建时定为 `<字母>-<标题slug>`，之后**即使站点标题改了也不改名**；
- `meta.json.problems[].dir` 是唯一映射来源，不靠重新推导；
- slug 规则复用 S1 的 `contestDirName` 同一套字符处理（Windows 非法字符 `\ / : * ? " < > |` 替换、长度上限）。

---

## 6. 阶段切分

| 阶段 | 内容 | 可独立验证 |
|---|---|---|
| **S5.0** | 布局改造：`paths.ts` 新增 `contestRawDir` / `tempDir` / `mainSource(pid)`；题目目录改字母命名；列表缓存迁至 `lists/`；`layoutVersion: 2` | 重写后的 `test:cache` 全绿 |
| **S5.1** | `src/workspace/initializer.ts`：`ensureProblem` / `initializeContest`，依赖注入（fetcher / store / paths / progress / isCancelled），失败汇总 | 新增 `test/init.test.js` |
| **S5.2** | 工作区守卫：未打开文件夹的检测、提醒（带「打开文件夹」按钮）、只读降级 | `test:init` 覆盖三态 |
| **S5.3** | 侧边栏「初始化项目」条目：未初始化时出现在题目列表；提供「初始化 / 暂不」；可关闭（`oj.project.initEntryVisible`） | 手工 + 断言 `contestTree/problemTree` 的条目决策函数 |
| **S5.4** | 懒初始化接入 `oj.showProblem`：确保文件 → 打开 `main.cpp`（Column One）→ 题目面板（Column Two，已存在） | `test:init` + 手工验证分栏 |
| **S5.5** | 配置项 + 清理缓存语义更新（按 §5.3 的保留/删除表）+ 文档同步 | `test:cache` 清理用例 |
| **S5.6** | 真实站点冒烟扩展：初始化整个比赛 → 校验目录树 → 离线重进 → 清理 | `npm run smoke:site` |

---

## 7. 行为契约（验收依据）

| 编号 | 契约 |
|---|---|
| C1 | 未打开文件夹时，点题目 → 提示（带「打开文件夹」按钮）+ 只读题面；不写盘、不开分栏 |
| C2 | 已打开文件夹、未初始化时，点题目 → 只懒初始化该题，**不弹确认框** |
| C3 | 懒初始化完成后，左侧打开 `main.cpp`，右侧显示题目面板；两者都**复用已有**，不重建 |
| C4 | 同一题重复进入 → 不重复拉取、不覆盖 `main.cpp`（哪怕用户已写代码） |
| C5 | 「初始化项目」条目仅在「已打开文件夹 + 未初始化 + 条目未关闭」时出现 |
| C6 | 全量初始化串行执行，带进度通知，可取消；取消后已完成的题**保留** |
| C7 | 全量初始化中单题失败不中断整体，结束时汇总失败题目 |
| C8 | 站点标题变化**不改**已定稿的目录名 |
| C9 | 清理缓存按 §5.3 的表执行，**绝不动** `main.cpp` 与 `test/` |
| C10 | 提交行为不变：提交 `activeTextEditor` 的内容（左右分栏下 webview 不是文本编辑器，故仍指向 `main.cpp`） |
| C11 | 题面「提示」小节、题面图片在初始化后仍然可用（离线可看） |

---

## 8. 测试策略

沿用 S4 的做法：**脱离 VS Code 运行时**（`vscode` 模块桩 + 本地 HTTP 服务器）。

| 套件 | 覆盖 |
|---|---|
| `test/cache-layout.test.js`（重写） | 新布局、字母目录命名、`mainSource` / `tempDir`、清理语义保留项 |
| `test/init.test.js`（新增） | `ensureProblem` 幂等 / 增量 / 已存在不覆盖 `main.cpp`；全量初始化的串行、取消、失败汇总；slug 字符处理 |
| `test/workspace-guard.test.js`（新增） | 无文件夹 / 已打开未初始化 / 已初始化 三态的决策函数 |
| `scripts/smoke-site.js`（扩展） | 真实站点：初始化 `cid=3772` 全量 → 校验目录树与文件 → 断网重进 → 清理缓存后 `main.cpp` 仍在 |

---

## 9. 需要改动的文件清单

**新增**
- `src/workspace/initializer.ts`、`src/workspace/guard.ts`（工作区守卫）
- `test/init.test.js`、`test/workspace-guard.test.js`

**修改**
- `src/cache/paths.ts`（布局 v2）、`src/cache/store.ts`（`tempDir`、清理表、`layoutVersion`）
- `src/views/problemTree.ts`（「初始化项目」条目 + 无文件夹占位）
- `src/views/contestTree.ts`（同上的触发编排）
- `src/extension.ts`（`oj.showProblem` 懒初始化 + 分栏；新增 `oj.project.initialize` /
  `oj.project.initializeProblem` 命令）
- `src/utils/config.ts`（`oj.project.*` 配置）
- `package.json`（配置项 + 命令）
- `test/cache-layout.test.js`、`scripts/smoke-site.js`、`README.md`、`docs/*`

---

## 10. 需要你拍板的事项

| # | 事项 | 我的选择 | 影响面 |
|---|---|---|---|
| P1 | 项目文件夹是否放 workspace **可见**根目录（§5.4） | 是（`<ws>/<cid>-<标题>/`） | **高**：决定是否重写 57 项断言。否决则改回 `.vsoj/contests/` |
| P2 | 未打开文件夹时是否允许只读看题（§5.2） | 允许（提醒 + 降级） | 低 |
| P3 | 懒初始化默认开启（`oj.project.lazyInit=true`） | 开启 | 中：决定点题是否自动写盘 |
| P4 | 题号字母参与目录命名（`A-复杂度分析(Ⅰ)`） | 是 | 低：若你更想要 `problems/0/` 也容易改 |

> P1 是唯一会推翻既有定稿的选择。其余三项改动都很局部。
