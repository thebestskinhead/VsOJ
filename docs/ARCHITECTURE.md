# VsOJ Pro 架构分析与演进路线

> 配套文档：`docs/SITE_ANALYSIS.md`（目标站点机制）
> 原则：**按分层扩展，不打补丁**。新增能力一律落在既有分层职责内，禁止在 `extension.ts` 里堆业务逻辑。

## 1. 现有架构（as-is）

```
extension.ts ── 组合根：构造服务 → 注册命令 → 装配 TreeView/Webview/MCP
   │
   ├── api/            【网络层】只做「请求 + 交给 parser」
   │   ├── client.ts     单例 axios + cookieStore(Map) + lockCookies + 调试日志
   │   ├── auth.ts       登录/登出/会话/CSRF/学号/验证码
   │   ├── contest.ts    比赛列表、比赛题目列表（含 AccessError）
   │   ├── problem.ts    题目详情、图片内联、题目 HTML 构建
   │   └── submit.ts     代码提交、状态查询
   │
   ├── utils/          【基础层】
   │   ├── parser.ts     cheerio HTML → 结构化对象（唯一 HTML 解析出口）
   │   ├── state.ts      globalState / secrets 封装（配置与凭据）
   │   ├── config.ts     用户配置读取
   │   ├── crypto.ts     MD5
   │   └── debug.ts      调试 OutputChannel
   │
   ├── views/          【展示层 ①】TreeView：contestTree / problemTree / statusPanel(OutputChannel)
   ├── webview/        【展示层 ②】Panel：login / submit / problem / account
   └── mcp/            【对外层】server(JSON-RPC over HTTP) / tools / logger
```

**职责边界明确**：`api` 不碰 UI，`views/webview` 不直接发请求，`parser` 是唯一 HTML 解析口，`state` 是唯一持久化口。

## 2. 现状缺口（gap）— 逐条对应用户诉求

| # | 诉求 | 现状 | 缺口性质 |
|---|---|---|---|
| G1 | 登录/提交用**静态页面**，不再请求网站页面 | 登录页/提交页 HTML 已内联在 TS 字符串里，但仍是「拼字符串」；`statusPanel.showWebview()` 更进一步——**代理渲染 OJ 原生 `status.php`** | 缺「静态资源层」；缺「页面与数据解耦」 |
| G2 | 其他页面**本地缓存** + **离线功能** | 无任何缓存。每次展开 TreeView / 打开题目都打网络 | 缺「缓存层」 |
| G3 | **验证码机制分析** | 已实现取图 + 会话绑定；`lockCookies()` 处理了覆写 | 已完成，见 `SITE_ANALYSIS.md` §3 |
| G4 | **定时访问避免 cookie 过期** | 无心跳。会话仅在用户操作时才被续期 | 缺「会话保活」 |
| G5 | **更灵活的过期提醒**：题目页能进、提交却失败 | `submit()` 只判 HTTP 状态；500 被 axios 拦截 → 统一报「提交失败」，**无法识别是登录失效**，不跳登录、不恢复上下文 | 缺「失效识别 + 自愈」 |
| G6 | 进入比赛**自动建目录并初始化** | 无。`enterContest` 只写一个 `currentCid` | 缺「工作区产出层」 |
| G7 | **MCP 扩展**：返回题目图片、识别样例、一键本地测试（输入 exe，结果落文件） | MCP 仅 3 个只读工具，`description` 被 `stripHtml` 抹掉图片 | 缺「资源 + 测试执行」能力 |

## 3. 目标架构（to-be）

新增 3 层，均不侵入现有层职责：

```
                        ┌─────────────────────────────┐
                        │  cache/  【缓存层 · 新增】      │
                        │  store.ts  工作区级 JSON/文件缓存 │
                        │  paths.ts  目录布局与 slug 规则  │
                        └──────────┬──────────────────┘
                                   │ 被 api / views / mcp 共同读取
   api/ ──(写穿写缓存)──► cache/ ◄──(读缓存/离线)── views/
                                   │
                        ┌──────────┴──────────────────┐
                        │  session/  【会话层 · 新增】    │
                        │  keeper.ts  心跳保活 + 状态探测  │
                        │  guard.ts   失效识别 + 意图重放  │
                        └─────────────────────────────┘
   media/  【静态资源层 · 新增】login.html / submit.html / *.css / *.js
   workspace/ 【项目初始化层 · 新增】initializer.ts 落盘 · guard.ts 能力边界 · wiring.ts 接线
   test/   【本地测试层 · 新增】runner.ts  编译产物 × 样例 → 结果文件
```

### 3.1 分层落位（禁止越层）

| 新能力 | 归属 | 禁止事项 |
|---|---|---|
| 缓存读写 | `cache/store.ts` | 不允许 `views/*` 自己拼路径、自己 `fs.writeFile` |
| 目录布局 | `cache/paths.ts` | 不允许业务代码硬编码 `<cid>-<标题>/problems/...` |
| 命名规则（slug / 题号字母 / 资产文件名） | `utils/slug.ts` | 不允许在 `paths.ts` 与 `initializer.ts` 各留一份实现 |
| 项目初始化落盘 | `workspace/initializer.ts` | 不允许直接 `require('vscode')`；网络与磁盘动作必须依赖注入 |
| 能力边界判定 | `workspace/guard.ts` | 不允许在命令实现里散写 `if (!workspaceFolders)` 之类的判断 |
| 心跳与探测 | `session/keeper.ts` | 不允许在 `extension.ts` 里 `setInterval` |
| 失效识别与重放 | `session/guard.ts` | 不允许 `webview/*` 直接调 `auth.login()` 后再自己跳转 |
| 静态页面 | `media/*.html` | 不允许继续在 TS 里拼大段 HTML 字符串 |
| 本地测试 | `test/runner.ts` | 不允许 MCP 工具层自己 `child_process.spawn` |

### 3.2 缓存层设计要点

- **根目录**：工作区内的 `oj.workspace.root`（默认 `.vsoj`），而非 VS Code `globalStorage`。
  理由：G6/G7 要求「数据集存入对应文件夹」供 AI/MCP/本地测试直接消费，产物必须**在用户的工作文件夹里、可被外部工具和 git 直接使用**。
- **两级数据**：
  - 工作区级（内容）：比赛目录、题目 markdown、样例 `.in/.out`、图片资源
  - 全局级（索引，`context.globalStorageUri`）：`cid → 目录相对路径`、`lastSyncAt`、心跳时间戳 —— 避免把「本机路径」写进可提交的工作区
- **写穿（write-through）**：`api/*` 拿到解析结果后顺手写缓存；`views/*` 读时**先缓存后网络**，带 TTL。
- **离线开关**：`oj.cache.offline` = 强制只读缓存；`oj.cache.enabled` = 是否写缓存。

### 3.3 会话层设计要点

- **心跳**：默认 4 分钟一次（`oj.session.keepAliveInterval`，0 = 关闭）。请求 `/csrf.php`（85 B，无副作用，实测可刷新会话 mtime）。
- **探测**：低频（默认 10 分钟）请求 `/loginpage.php`，判 `logout.php` 标记 —— 与现有 `isLoggedIn()` **同一判定口径**，不新增第二套标准。
- **失效识别**（G5 核心）：把「登录失效」从「其他失败」中**结构化**出来，而不是靠字符串：

  | 信号 | 判定 | 强度 |
  |---|---|---|
  | `submit.php` 返回 HTTP 5xx 且响应体为空 | `SESSION_EXPIRED` | 主（实测） |
  | 请求最终落到**登录页**（含 `name="user_id"` + `vcode.php`，且不含 `logout.php`） | `SESSION_EXPIRED` | 主 |
  | `302/303` 且 `Location` 指向 `loginpage` | `SESSION_EXPIRED` | 主（未跟随重定向时） |
  | 响应体含 `Not Invited!` / `不能查看题目` / `尚未开始` | `NO_PERMISSION` | 辅 |
  | 响应体含 `No such Contest!` | `BAD_TARGET` | 辅 |
  | 响应体含「验证码…错误」 | `INVALID_VCODE` | 辅 |
  | 连接被拒 / DNS / 超时 | `NETWORK` | 主 |

  **重要修正（由测试发现）**：初版把**裸 `302` 一律判为失效**，但 `client.ts` 的
  `maxRedirects: 5` 会自动跟随重定向，成功提交后同样会 302 到 `status.php` —— 直接判失效会
  把「提交成功」误报成「登录过期」。因此：
  - 分类器**不再**处理裸 302，改由 `SubmitService` 结合 `Location` 与**最终正文**判定；
  - 新增 `looksLikeLoginPage()`：登录页有 `name="user_id"` + `vcode.php` 且**无** `logout.php`，
    这是「跟随后的落点就是登录页」这一形态的可靠判据（实测确认）。

- **自愈流程**（用户明确要求的行为）：

  ```
  提交 → 识别 SESSION_EXPIRED
        → 记录 pendingIntent { cid, pid, sourceFile, language }
        → 弹窗「登录已过期，是否重新登录并继续提交？」
        → 打开登录页（静态）
        → 登录成功 → 恢复 context(oj.inContest=true) → 重放 pendingIntent
        → 自动打开原题目 → 自动回到提交页（验证码需人工输入）
  ```

  注意：**验证码必须人工输入**，故「自动回到提交页」= 自动打开提交页并预填语言/代码，不代替用户提交。

### 3.4 MCP 扩展要点（G7）

> **本节已按 S6.7 落地情况改写。** S0 时的设想是「`get_problem_assets` 返回 base64 +
> 让 `run_local_test` 生成 `.vscode/tasks.json` 里的 `test/build.sh` / `test/run.sh`、
> 以编译好的 exe 为统一输入」—— 那三条后来都被否掉了，原因见本节末尾。

当前 MCP 共 **8 个**工具：5 个只读 / 配置类 + 3 个测试类。

| 工具 | 输入 | 输出 | 落地于 |
|---|---|---|---|
| `get_contest_problems` | `cid?` | 题目列表（编号 / 标题 / AC 状态） | S0 |
| `get_current_problem` | `cid?, pid?` | 题面各段 + 样例 + **`local` 段（本机绝对路径）** | S0，S6.7 扩 |
| `get_contest_list` | `page?, keyword?` | 分页比赛列表 | S0 |
| `get_config_manual` | `section?, format?` | 配置说明书（结构来自 `package.json`） | S6.5 |
| `init_config` | `settings?, toolchains?, scope?, apply?` | 预览 / 落盘结果 | S6.5 |
| `compile_problem` | `cid?, pid?, rebuild?` | 编译器原文 / 命令 / 产物路径 | S6.7 |
| `run_local_test` | `cid?, pid?, rebuild?` | 与 `report.md` 逐字一致的报告文本 | S6.7 |
| `get_last_test_result` | `cid?, pid?, format?` | 上次报告 + 过期标记（**不重跑**） | S6.7 |

**三条被否掉的 S0 设想，以及为什么**

1. ~~图片内联 base64~~ → **只给本地路径**（决策 D11）。图片是**静态资源**，
   已经落盘在 `problems/<pid>/assets/`（初始化这题时抓的，离线也在），
   再搬一遍二进制只是浪费 token；也不需要「读图片」这个工具 —— 路径就够了。
   于是 `get_problem_assets` / `get_problem_samples` 两个工具**取消**，
   路径并进 `get_current_problem` 的 `local` 段（契约 C33）。
2. ~~由插件生成 `.vscode/tasks.json` 里的 `build.sh` / `run.sh`~~ → **不写用户文件**。
   那样会把命令**固化**进任务定义，而 Windows / Linux / macOS 的命令并不相同，
   同一份 `tasks.json` 不可能三平台通用（契约 C17）。现在命令**在运行时由工具链层解析**：
   `oj` 类型的自定义任务只声明「做什么」，具体命令每次现算。
3. ~~以「编译好的 exe」为统一输入~~ → **输入是「题目 + 工具链」**。
   「统一输入是 exe」等于把解释型语言排除在外（Python 没有 exe），
   与「引入工具链屏蔽编译/解释差异」的初衷冲突。现在引擎只认 `ToolchainDef` 的
   `kind` 与命令模板，`prepare` 对解释型是空操作、`runnable` 就是源文件本身（契约 C2）。

**两条通道（用户决策）**：只保留 **VS Code Task + MCP**。曾考虑直连
`launch.json` / cppdbg，但调试器经 MI 协议驱动 gdb、不接受外部 stdin，
且要把各语言调试适配器的差异都吞掉，适配成本爆炸；自研运行器（喂样例 stdin、
集成终端实时输出）才是可控的那条路（契约 C19）。

## 4. 分阶段路线（每阶段一次 commit，可独立验证）

| 阶段 | 内容 | 交付物 | 状态 |
|---|---|---|---|
| **S0** | 站点机制 + 架构分析 | `docs/SITE_ANALYSIS.md`、`docs/ARCHITECTURE.md` | ✅ |
| **S1** | 缓存层骨架 | `src/cache/paths.ts`、`src/cache/store.ts`、配置项、`test/cache-layout.test.js` | ✅ |
| **S2** | 会话保活 + 失效自愈 | `src/session/keeper.ts`、`src/session/guard.ts`、`submit` 错误分类、4 个会话命令、状态栏、`test/session.test.js` | ✅ |
| **S3** | 静态资源层 | `media/login.html`、`media/submit.html`、`media/common.css`、`media/*.js`，webview 改为 `asWebviewUri` 加载 | 待办 |
| **S4** | 运行期缓存刷新 + 离线模式 | 详见 `docs/PLAN_S4.md`（契约 / 阶段 / 测试） | ✅ |
| **S5** | 比赛项目初始化（懒初始化 / 全量预取 / 左代码右题目 / 无工作区守卫） | `src/workspace/initializer.ts`、`guard.ts`、`wiring.ts`、`openSource.ts`；布局 v2；`test/{init,workspace-guard,project-tree,open-source}.test.js` | ✅ |
| **S6** | 本地测试引擎 + MCP 扩展 | `src/test/*`、`src/config/*`、`src/workspace/resources.ts`、`src/webview/{testResult,status}Webview.ts`；**8 个 MCP 工具**（3 个测试类）；`docs/PLAN_S6.md`（S6.0–S6.7 已闭环，剩工具链编辑页） | 🔶 |
| **S7** | 状态页静态化 | 由 S6.6.1 提前完成：`statusPanel` 的代理渲染下线，改为自绘 `StatusWebview` | ✅ |

### 测试与验证

`npm test` 一次性跑完全部套件（**25 套件 / 1298 项断言**），全部脱离 VS Code 运行时
（`vscode` 模块桩 + 本地 HTTP 服务器）。S6 之后多了一条更强的做法：
**引擎套件不 mock 编译与执行** —— 用本机真实的 g++ 编译真实源码、跑真实样例、比真实字节
（找不到编译器时该组用例降级为 skip 并说明，不伪装成通过）。

| 套件 | 断言数 | 覆盖 |
|---|---|---|
| `status-webview` | 143 | 提交结果页：结果码映射、轮询队列、注入转义、亮色、**首屏只赋值一次 `webview.html`** |
| `cache-layout` | 91 | 布局 v2、字母目录命名、幂等、重命名、索引兜底、多比赛隔离、slug 边界、清理语义 |
| `mcp-test-tools` | 91 | MCP 三工具（真 `McpToolHandler` + 真 g++）、`get_current_problem` 的 `local` 段、读结果不重跑 |
| `config-writer` | 85 | `planConfigWrite` 纯函数：键名容错、类型转换、错误拒绝落盘 |
| `init` | 83 | `ensureProblem` 幂等 / 增量 / 离线 / 取消 / 失败汇总 / 骨架内容 / 目录命名 |
| `session` | 71 | 失效分类、登录页判定、意图重放与过期、保活时序、对本地 HTTP 服务器端到端验证提交分类 |
| `runner` | 70 | 引擎：prepare/run/看门狗/复用/落盘，**真实 g++ 端到端**（含中文目录相对路径） |
| `toolchain` | 65 | 工具链模型、命令解析与 PATH 推导、模板展开、部分覆盖 |
| `workspace-guard` | 65 | 无工作区穷举、提交闸门、条目可见性、暂不语义 |
| `test-result-page` | 61 | 本地测试结果页：策略表、三种「未能开始」屏、注入转义、零脚本静态检查 |
| `config-tools` | 54 | 走真实 `McpToolHandler` 的配置说明书与初始化（临时工作区真文件读写） |
| `compare` | 49 | 严格逐字节比较 + 首个差异定位（行 / 列 / hex） |
| `config-manual` | 44 | 说明书结构↔语义双向核对（抓死配置、防漂移） |
| `test-wiring` | 44 | 接线层：选工具链、发现样例、拼路径、配置真的生效 |
| `tasks` | 43 | 自定义 `oj` 任务 + 终端桥（真实 g++ 端到端） |
| `localize` | 38 | 图片本地化（含 `<a href>` 误伤回归用例） |
| `refresh` | 38 | 刷新执行器串行 / 取消 / 失败可见性 |
| `revalidate` | 38 | 重访五态决策 |
| `project-tree` | 35 | 头部条目、占位项、列表失败降级 |
| `cache-freshness` | 23 | TTL 边界 |
| `config-consistency` | 16 | 声明的配置项 / 命令 / 菜单必须真的被消费（排除说明书本身） |
| `connectivity` | 16 | 可达性探测与结果缓存 |
| `context-sync` | 13 | `cid` ↔ 上下文派生、启动恢复、无 cid 不误报、静态防回归 |
| `theme` | 11 | 全部内联页面必须是亮色（无 `--vscode-*`、有亮色配色声明） |
| `open-source` | 11 | 左栏打开源码的复用判定 |

另有真实站点冒烟：`npm run smoke:site`（**84 项断言**，驱动真实的
`initializer` + `buildInitDeps` 跑完整链路）。


### 阶段依赖

```
S0 ─► S1 ─► S2        (S2 依赖 S1 记录心跳/意图)
          └─► S4      (S4 依赖 S1)
   S3 ──────────┘      (S3 与 S1/S2 无耦合，可并行)
S1,S4 ─► S5 ─► S6      (S6 依赖 S5 的目录布局、样例与 temp/ 落位)
S3,S4,S5 ─► S7
```

## 5. 兼容性与风险

| 风险 | 应对 |
|---|---|
| 站点为 HUSTOJ 定制版，响应体形态可能变化 | 失效判定**以「HTTP 状态 + 空体」为主信号**，字符串信号仅作辅助；判定集中在 `session/guard.ts` 单点，便于后续按登录态实测结果收紧 |
| 心跳增加服务器负担 | 默认 4 分钟 / 单请求 85 B ≈ 每天 < 40 KB；提供开关与间隔配置 |
| 缓存污染工作区 | 缓存根可配、`cache.enabled=false` 可全关；根目录自动写入 `.gitignore` 建议（不强制） |
| 用户机器无编译环境 | 本地测试**以 exe 为输入**，插件不引入编译器依赖 |
| 静态页面 CSP | `media/` 资源通过 `webview.asWebviewUri` + `localResourceRoots` 加载，避免内联 script 被 CSP 拦截 |

## 6. 不变更承诺

- 不改 `parser.ts` 的解析口径（站点结构未变，改动会引发全链路回归）。
- 不改 `client.ts` 的 cookie 策略（`lockCookies` 已正确解决会话覆写）。
- 不引入新的 HTTP 客户端 / 不引入 REST 假设（站点无 API）。
