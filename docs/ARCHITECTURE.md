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
   test/   【本地测试层 · 新增】runner.ts  编译产物 × 样例 → 结果文件
```

### 3.1 分层落位（禁止越层）

| 新能力 | 归属 | 禁止事项 |
|---|---|---|
| 缓存读写 | `cache/store.ts` | 不允许 `views/*` 自己拼路径、自己 `fs.writeFile` |
| 目录布局 | `cache/paths.ts` | 不允许业务代码硬编码 `.vsoj/contests/...` |
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

  | 信号 | 判定 |
  |---|---|
  | `submit.php` 返回 HTTP 500 且响应体为空 | `SESSION_EXPIRED`（实测） |
  | 响应体含 `Not Invited!` / `不能查看题目` | `NO_PERMISSION`（非失效） |
  | 响应体含 `No such Contest!` | `BAD_CONTEST`（非失效） |
  | 心跳探测到无 `logout.php` 标记 | `SESSION_EXPIRED` |
  | 其余网络异常 | `NETWORK` |

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

在现有 3 个工具基础上新增，**输入输出均结构化**：

| 工具 | 输入 | 输出 |
|---|---|---|
| `get_problem_assets` | `cid, pid` | 题目内图片列表（本地缓存相对路径 + base64 + mime） |
| `get_problem_samples` | `cid, pid` | 从页面解析出的样例对，并已落盘到 `samples/` |
| `run_local_test` | `cid, pid, exePath, [timeout]` | 逐样例执行结果 + 结果文件路径（`result.json` / `report.md`） |

`.vscode/tasks.json` 集成：由 `run_local_test` 生成的约定路径（`test/build.sh`、`test/run.sh`）暴露给 VS Code Task，使同一套逻辑既能被 MCP 调用，也能被编辑器 `Ctrl+Shift+B` 使用；**以「编译好的 exe」为统一输入**，避免把编译工具链耦合进插件。

## 4. 分阶段路线（每阶段一次 commit，可独立验证）

| 阶段 | 内容 | 交付物 | 状态 |
|---|---|---|---|
| **S0** | 站点机制 + 架构分析 | `docs/SITE_ANALYSIS.md`、`docs/ARCHITECTURE.md` | ✅ 本次 |
| **S1** | 缓存层骨架 | `src/cache/paths.ts`、`src/cache/store.ts`、配置项 | ✅ 本次 |
| **S2** | 会话保活 + 失效自愈 | `src/session/keeper.ts`、`src/session/guard.ts`、`submit` 错误分类、`extension.ts` 接线 | ✅ 本次 |
| **S3** | 静态资源层 | `media/login.html`、`media/submit.html`、`media/common.css`、`media/*.js`，webview 改为 `asWebviewUri` 加载 | 待办 |
| **S4** | 缓存接入 views/api + 离线模式 | contestTree / problemTree / problemWebview 走缓存；`oj.cache.offline` 生效 | 待办 |
| **S5** | 进入比赛自动初始化工作区 | `src/workspace/initializer.ts`；`meta.json` / `problem.md` / `samples/` | 待办 |
| **S6** | 本地测试引擎 + MCP 扩展 | `src/test/runner.ts`、3 个新 MCP 工具、`.vscode/tasks.json` 模板 | 待办 |
| **S7** | 状态页静态化 | 用静态页 + 缓存数据替换 `statusPanel` 的 `proxyNavigate` 代理渲染 | 待办 |

### 阶段依赖

```
S0 ─► S1 ─► S2        (S2 依赖 S1 记录心跳/意图)
          └─► S4      (S4 依赖 S1)
   S3 ──────────┘      (S3 与 S1/S2 无耦合，可并行)
S1,S4 ─► S5 ─► S6      (S6 依赖 S5 的目录布局与样例落盘)
S3,S4 ─► S7
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
