# VsOJ 微软大战OJ

OJ 在线判题平台 VS Code 插件，让你在 VS Code 内完成全部 OJ 操作，方便你大战代码

## 功能特性

- **登录系统** — 支持验证码登录，Cookie 持久化，重启 VS Code 免密登录。支持「记住我」快捷登录，免去重复输入账号密码。**密码仅存储哈希值，不会明文保存；插件不连接开发者服务器，你的账号信息不会上传至任何第三方**
- **会话保活** — 定时发送极轻量心跳（`/csrf.php`，约 85 字节）刷新服务端会话，避免长时间不操作导致 Cookie 过期
- **登录失效自愈** — 精准识别「登录过期」并区别于普通失败：自动提示重新登录，**登录成功后自动恢复原来的比赛与题目并回到提交页**，无需重新逐级点进去
- **比赛列表** — 侧边栏 TreeView 展示所有比赛，支持收藏、搜索、分页翻页
- **题目列表** — 进入比赛后显示题目清单，标记已 AC 题目
- **题目详情** — Webview Panel 渲染题目 HTML（图片 base64 内联）
- **代码提交** — 一键提交当前编辑器代码（快捷键 `Ctrl+Shift+S`）
- **状态查询** — 三合一状态查看：内嵌 Webview 页面 / 底部 Output 文本表格 / 系统浏览器打开，支持自动轮询刷新
- **本地缓存** — 比赛 / 题目 / 状态写入工作区缓存目录（默认 `.vsoj/`），支撑离线浏览与后续的本地测试能力
- **本地测试** — 对着站点样例跑自己的代码：编译 → 逐用例严格比对（先归一化换行，等价站点 Linux 判题环境）→ 结果页两级展示（用例列表 → 期望 / 实际 / 差异定位）。带超时 / 输出体积 / 内存三道看门狗，也能作为 `oj` 任务在终端里实时看输出；**AI 也能跑这条路**（MCP：`compile_problem` / `run_local_test` / `get_last_test_result`，见 [可用的 MCP 工具](#可用的-mcp-工具)）

## 配置

完整配置说明（每一项的类型、默认值、取值、示例、常见坑）见 **[docs/CONFIG.md](docs/CONFIG.md)**
—— 这份文档由 `npm run docs:config` 从源码生成，随插件一起发布，因此不会与插件实际行为脱节。

**最省事的配法：让 AI 来配。** 插件通过 MCP 提供了 `get_config_manual`（读说明书）与
`init_config`（探测后写入）两个工具，AI 可以自己完成配置，不需要你逐个翻设置面板。见
[MCP 服务器 → 让 AI 自己配置插件](#让-ai-自己配置插件)。

也可以手动在 VS Code 设置里搜索 `oj`，或点“比赛列表”旁边的设置按钮。**只有一项是必配的**：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `oj.baseUrl` | `http://localhost` | OJ 平台的 Base URL。默认值只是占位符，不改它插件等于没配 |
| `oj.mcp.enabled` | `false` | 建议配合上面那项一起打开：AI 靠 MCP 通道读题、跑测试、写配置 |

其余 24 项都有合理默认值，按需再调。

工具链（本地测试用哪个编译器）不在 VS Code 设置里，而在 `.vsoj/toolchains.json`：
内置 C/C++、Java、Python 四套，你只需要写**要覆盖的字段**，例如把 g++ 指到你的便携环境：

```json
{
  "toolchains": [
    { "id": "cpp-g++", "commands": { "gpp": ["D:\\tools\\mingw64\\bin\\g++.exe"] } }
  ]
}
```

不想手写这份文件，就在命令面板跑「**OJ: 编辑工具链配置**」：每条工具链一行，能看到它认领哪些
源文件、命令在这台机器上探测到了哪个路径、缺哪个命令，点开就能改，也能加新语言。
「恢复默认」把某条改回内置的样子（那份覆盖随之移除）；改动只写进文件里被改过的字段。


## 命令清单

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| `oj.login` | — | 打开登录页面 |
| `oj.logout` | — | 登出并清除会话 |
| `oj.openSettings` | — | 打开插件设置 |
| `oj.accountSettings` | — | 账号设置（保存账号密码以启用快捷登录，密码只存哈希） |
| `oj.refreshContests` | — | 刷新比赛列表（清除搜索） |
| `oj.searchContests` | — | 搜索比赛（输入关键词筛选） |
| `oj.enterContest` | — | 进入选中的比赛 |
| `oj.enterContestWithPid` | — | 进入比赛并指定题目（输入 CID + PID） |
| `oj.exitContest` | — | 退出当前比赛 |
| `oj.showProblem` | — | 查看题目详情 |
| `oj.submit` | `Ctrl+Shift+S` | 提交当前编辑器代码 |
| `oj.refreshStatus` | — | 查看提交结果（按 `oj.statusViewMode` 决定形态：结果页 / OutputChannel / 外部浏览器） |
| `oj.toggleStatusAutoRefresh` | — | 开启/停止状态自动刷新（轮询待判定的提交） |
| `oj.toggleFavorite` | — | 收藏/取消收藏比赛（右键菜单） |
| `oj.favoriteContest` | — | 收藏比赛（手动输入 CID） |
| `oj.prevContestPage` | — | 比赛列表上一页 |
| `oj.nextContestPage` | — | 比赛列表下一页 |
| `oj.jumpContestPage` | — | 比赛列表跳转到指定页 |
| `oj.refreshProblems` | — | 刷新题目列表 |
| `oj.project.openFolder` | — | 打开当前比赛的项目文件夹 |
| `oj.project.initialize` | — | 初始化比赛项目（全量预取，带进度、可取消） |
| `oj.project.initializeProblem` | — | 初始化本题（题面 / 样例 / 图片 / 源码骨架） |
| `oj.project.dismissInitEntry` | — | 暂不初始化（本次会话隐藏该条目） |
| `oj.cache.refreshProblem` | — | 强制刷新本题缓存（重新拉取题面 / 样例 / 图片） |
| `oj.cache.refreshAllProblems` | — | 强制刷新全部题目缓存（串行执行，可取消） |
| `oj.cache.status` | — | 查看缓存与网络状态 |
| `oj.cache.purge` | — | 清理缓存（可多选；保留源码、`test/` 与 `meta.json`） |
| `oj.test.compile` | — | 编译当前题目（按 `oj.test.reuseBuild` 决定是否复用上次产物） |
| `oj.test.compileForce` | — | 强制重新编译（忽略复用配置） |
| `oj.test.run` | — | 本地测试：编译 + 跑全部样例 + 判定，结果页展示 |
| `oj.test.editToolchains` | — | 打开工具链配置页（改命令路径、加语言、恢复默认） |
| `oj.debugShow` | — | 显示 Debug 日志（OutputChannel） |
| `oj.debugToggle` | — | 启用/禁用 Debug 日志 |
| `oj.debugClear` | — | 清空 Debug 日志 |
| `oj.mcp.start` | — | 启动 MCP 服务器 |
| `oj.mcp.stop` | — | 停止 MCP 服务器 |
| `oj.mcp.showLog` | — | 显示 MCP 服务器日志 |
| `oj.mcp.clearLog` | — | 清空 MCP 服务器日志 |
| `oj.session.status` | — | 查看会话状态（登录态 / 心跳 / 探测 / 待重放任务） |
| `oj.session.probeNow` | — | 立即探测登录态是否有效 |
| `oj.session.resumePending` | — | 恢复因登录过期而中断的提交任务 |
| `oj.session.clearPending` | — | 清除待恢复的提交任务 |

## 会话保活与登录失效自愈

### 为什么需要保活

OJ 的登录态完全绑定 `PHPSESSID`，服务端会话有效期取决于 `session.gc_maxlifetime`（通常约 24 分钟**空闲**）。
判定依据是会话文件 mtime，**任何携带该 Cookie 的请求都会刷新 mtime**，因此定时发一次极轻量请求即可续期。

- 心跳：每 `oj.session.keepAliveInterval`（默认 4 分钟）请求 `/csrf.php`（约 85 字节、无副作用）
- 探测：每 `oj.session.probeInterval`（默认 10 分钟）复用插件既有的登录态判定逻辑
- 心跳连续失败 3 次才会升级为一次探测，避免网络抖动被误判成「登录过期」

状态栏右下角常驻显示会话状态：`✅ OJ 已登录` / `⚠️ OJ 登录已过期` / `⛔ OJ 未登录`，点击可查看详情。

### 为什么「提交页能进、提交却失败」

OJ 的题目页 `problem.php` 对**公开比赛**不校验登录，所以登录过期后题目照常打开；
但 `submit.php` 一旦会话失效会直接返回 HTTP 500 空响应。插件现在会把这种失败识别为
**登录过期**（而不是笼统的「提交失败」），并：

1. 记住你正在提交的比赛、题目与代码文件
2. 提示「登录已过期，是否重新登录并继续？」
3. 打开登录页（账号已保存时只需再输一次验证码）
4. 登录成功后**自动恢复比赛与题目、打开原题目、回到提交页**，输入验证码即可继续

若中途关闭了 VS Code，任务会保留 30 分钟，可随时执行 `OJ: 恢复待提交任务` 手动恢复。

## 本地缓存与比赛项目

插件把数据分成**两处**存放：

- **比赛项目文件夹** —— 建在**工作区根目录下、可见**，形如 `<cid>-<比赛标题>/`，
  可以当作普通项目打开、导出、打包或纳入 git
- **内部数据根** —— `oj.workspace.root`（默认 `.vsoj/`，隐藏），只放没有比赛归属的
  内部数据（如比赛列表缓存）

缓存**只存原始信息**：题面 HTML、图片二进制、样例文本。结构化数据（题目详情、题目列表、
提交状态）由解析层按需产出，**不落盘**，避免解析口径变更后留下脏数据。

```
<workspace>/
├── .vsoj/                                      内部数据根（隐藏）
│   └── lists/list-p<页码>[-kw<词>].html        比赛列表原始 HTML
└── <cid>-<比赛标题>/                            比赛项目文件夹（可见）
    ├── meta.json                               项目元信息（唯一的非站点文件）
    ├── contest-raw/contest.html                比赛页原始 HTML（题目列表来源）
    ├── contest-raw/status.html                 提交状态原始 HTML
    └── problems/<题号字母>-<标题>/
        ├── raw/page.html                       题目页原始 HTML（题面的唯一来源）
        ├── assets/<hash>-<文件名>.<ext>        题面图片二进制
        ├── samples/1.in, 1.out                 样例数据集
        ├── main.cpp                            你的源码（清理缓存时保留）
        ├── temp/                               编译产物与运行临时文件
        └── test/result.json, report.md         本地测试结果
```

- **目录名一旦确定不再变化**：比赛目录为 `<cid>-<标题>`，题目目录为
  `<题号字母>-<标题>`（字母由比赛内 `pid` 确定性推导，`0→A`）。站点标题后来改了也
  **不重命名**，映射关系以 `meta.json.problems` 为准
- **清理缓存**只删除可重新获取的部分与 `temp/`，**保留** `main.cpp`、`test/` 与 `meta.json`
- 插件**不会**修改你的 `.gitignore`；如需忽略缓存请自行添加

## 使用流程

1. **配置 Base URL**：在 VS Code 设置中将 `oj.baseUrl` 修改为你的 OJ 平台地址
2. **登录**：点击侧边栏 OJ 图标，执行 `oj.login` 命令，输入用户名、密码和验证码。勾选「记住我」后下次只需输入验证码即可快捷登录
3. **浏览比赛**：侧边栏"比赛列表"自动加载，点击比赛进入
4. **查看题目**：进入比赛后，"题目列表"显示所有题目，点击题目打开详情
5. **编写代码**：在 VS Code 中正常编辑代码文件
6. **提交代码**：选中题目后，在编辑器中按 `Ctrl+Shift+S`，输入验证码提交
7. **查看结果**：提交后会自动打开「提交结果」页（把 `oj.statusViewMode` 设为 `webview`）——
   待判定的提交会在页面里**就地轮询刷新**，不用手动重开；点「结果」那一格还能看判题详情

## MCP 服务器

VsOJ Pro 内置 MCP (Model Context Protocol) 服务器，允许 AI Agent（如 VS Code Chat、Cline、Continue 等）通过 HTTP JSON-RPC 2.0 协议直接调用插件的比赛和题目数据。

### 启动方式

**方式一：状态栏按钮**

插件激活后，底部状态栏右侧会显示 MCP 服务器状态按钮。点击即可启动/停止服务器。

**方式二：命令面板**

按 `Ctrl+Shift+P` 打开命令面板，搜索并执行：
- `OJ: 启动 MCP 服务器`
- `OJ: 停止 MCP 服务器`

**方式三：自动启动**

在设置中将 `oj.mcp.enabled` 设为 `true`，每次打开 VS Code 后 MCP 服务器会自动启动。

**方式四：查看日志**

执行命令 `OJ: 显示 MCP 日志` 可打开独立的 `OJ MCP` OutputChannel，查看服务器启动、客户端连接、工具调用等完整日志。

### 配置 IDE 接入

MCP 服务器启动后监听 `http://127.0.0.1:{port}/mcp`（默认 9527 端口）。你需要在所用 Agent 插件的 MCP 配置文件中添加服务器配置。

各 Agent 插件的 MCP 配置文件位置：

| Agent 插件 | 配置文件 |
|---|---|
| VS Code Chat (mcpServers) | `.vscode/mcp.json` 或用户设置 `mcpServers` |
| Cline | `.vscode/mcp.json` |
| Continue | `~/.continue/config.json` 中的 `mcpServer` 字段 |

在对应配置文件中添加如下内容（JSON）：

```json
{
  "mcpServers": {
    "VsOJ": {
      "url": "http://127.0.0.1:9527/mcp"
    }
  }
}
```

如果你的 MCP 端口不是默认的 9527，请将 URL 中的端口号改为你配置的值。

### 可用的 MCP 工具

MCP 协议提供了以下工具供 AI Agent 调用：

**1. get_config_manual** ⭐ 配置本插件前先读这个

读取本插件的配置说明书：全部配置项的类型 / 默认值 / 取值 / 示例 / 常见坑、
`toolchains.json` 的字段与文件格式、命令查找与 PATH 注入规则、初始化配置的标准步骤。

参数（可选）：`section` - `all`（默认）/ `quickstart` / `settings` / `toolchains` / `files` / `pitfalls`；
`format` - `markdown`（默认）或 `json`（更省 token）。

**2. init_config** ⭐ 让 AI 自己把配置写好

初始化 / 更新配置。插件**不猜你的机器**（不内置个人环境路径、也不扫盘找编译器），
编译器位置由 AI 探测后通过 `toolchains` 传入。默认**只预览不落盘**，确认后带 `apply: true` 才写，
覆盖旧文件前自动备份；计划里有错误（键名打错、类型不对、定义非法）时**拒绝落盘**。

参数（可选）：`settings` - 要写入的 `oj.*` 项（键可省 `oj.` 前缀，值写 `null` 表示重置回默认）、
`toolchains` - 工具链覆盖/新增（只写要覆盖的字段）、`toolchainMode` - `merge`/`replace`、
`scope` - `workspace`/`global`、`apply` - 是否真的落盘。

**3. get_contest_problems**

获取比赛题目列表。包含题目编号、标题、AC 状态等。

参数（可选）：`cid` - 比赛 ID，不传则使用当前已进入的比赛。

**4. get_current_problem**

获取题目详细内容。默认返回当前在插件中打开的题目，也可通过参数指定任意比赛和题目。包括题目描述、输入说明、输出说明、样例等。

返回值里还有一段 `local` —— **这道题在本机的落点**：源文件、样例（`1.in` / `1.out` …，
成对的会被本地测试执行）、题面图片、`temp/`、结果与报告，**全是绝对路径**。
题面图片只给路径，需要时直接读 `local.assets` 里的文件。

参数（可选）：`cid` - 比赛 ID、`pid` - 题目 ID。均不传则使用当前题目。

**5. get_contest_list**

分页获取比赛列表，支持关键词搜索。

参数（可选）：`page` - 页码（默认 1）、`keyword` - 搜索关键词。

**6. compile_problem** ⭐ 只编译，最快的一条反馈

编译当前题目，**不跑样例、不判定、不写结果文件**。编译失败时直接返回编译器原文
（不用去翻插件日志），成功时返回实际命令、产物路径与运行命令。
改完代码想先确认「编译过不过」用它，比 `run_local_test` 快。

参数（可选）：`cid` / `pid`、`rebuild` - 强制重新编译。

**7. run_local_test** ⭐ AI 的本地验证主入口

编译 + 跑 `samples/` 下全部成对样例 + 逐字节判定，落盘 `result.json` 与 `report.md`，
返回**与 `report.md` 逐字一致**的报告文本（每条用例判定、不通过用例的期望/实际与首个差异定位）。
判定口径与站点一致（CRLF 归一化后严格逐字节）。

**不会弹出结果页** —— MCP 是给 AI 的通道，只回文本；想看页面走命令面板的「本地测试」。

参数（可选）：`cid` / `pid`、`rebuild` - 强制重新编译。

**8. get_last_test_result** ⭐ 复核上次结论，不重跑

读上一次本地测试的结果，**不重跑、不编译**。返回那次报告，并比对源码哈希判断结果是否已过期
（源文件改过会在开头标出来）。「刚才结论是什么」「用户说改了代码，结果还作数吗」用它。

参数（可选）：`cid` / `pid`、`format` - `markdown`（默认）/ `json`。

### 让 AI 自己配置插件

配置本插件不需要人工去设置面板里逐个找。标准流程是：

1. AI 调 `get_config_manual` 读说明书；
2. AI **自己探测本机**（`g++ --version`、找常见安装目录、或问你）拿到编译器绝对路径；
3. AI 调 `init_config` 先看预览，确认后再带 `apply: true` 落盘。

第二次以后的调用是幂等的：已经一致的内容不会被重复写入。

### MCP 调用示例

```bash
# 初始化（AI Agent 框架自动完成）
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"MyAgent"}}}'

# 列出可用工具
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 读配置说明书（只取初始化步骤，省 token）
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_config_manual","arguments":{"section":"quickstart"}}}'

# 预览一次配置（不落盘）
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"init_config","arguments":{"settings":{"oj.baseUrl":"http://acm.example.edu.cn"},"toolchains":[{"id":"cpp-g++","commands":{"gpp":["D:\\\\tools\\\\mingw64\\\\bin\\\\g++.exe"]}}]}}}'

# 确认无误后落盘（把同一份 arguments 再加上 apply:true）
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"init_config","arguments":{"apply":true,"settings":{"oj.baseUrl":"http://acm.example.edu.cn"}}}}'

# 获取当前打开题目的内容（不传参数）
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_current_problem"}}'

# 获取指定比赛和题目的内容
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_current_problem","arguments":{"cid":"1000","pid":"0"}}}'

# 获取指定比赛的题目列表
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get_contest_problems","arguments":{"cid":"1000"}}}'
```

## 常见问题

**Q: 登录后验证码显示不出来？**
A: 检查 `oj.baseUrl` 是否配置正确，确保 OJ 服务器可访问。

**Q: 提交代码时提示"无 CSRF Token"？**
A: 确保已正确登录，CSRF Token 在首次访问 OJ 页面时获取。

**Q: 题目中的图片显示为裂图？**
A: 图片加载失败时会显示占位符，检查网络连接和 OJ 服务器状态。

**Q: 重启 VS Code 后需要重新登录？**
A: 如果 Cookie 未过期会自动恢复登录态。如果过期，重新登录即可。

## 开发者文档

- 构建与测试、项目结构、分阶段路线：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 架构分层与职责边界：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 配置项逐项说明：[docs/CONFIG.md](docs/CONFIG.md)
- 目标站点机制分析：[docs/SITE_ANALYSIS.md](docs/SITE_ANALYSIS.md)
