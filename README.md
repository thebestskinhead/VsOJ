# VsOJ 微软大战OJ

OJ 在线判题平台 VS Code 插件，让你在 VS Code 内完成全部 OJ 操作，方便你大战代码

## 功能特性

- **登录系统** — 支持验证码登录，Cookie 持久化，重启 VS Code 免密登录。支持「记住我」快捷登录，免去重复输入账号密码。**密码仅存储哈希值，不会明文保存；插件不连接开发者服务器，你的账号信息不会上传至任何第三方**
- **比赛列表** — 侧边栏 TreeView 展示所有比赛，支持收藏、搜索、分页翻页
- **题目列表** — 进入比赛后显示题目清单，标记已 AC 题目
- **题目详情** — Webview Panel 渲染题目 HTML（图片 base64 内联）
- **代码提交** — 一键提交当前编辑器代码（快捷键 `Ctrl+Shift+S`）
- **状态查询** — 三合一状态查看：内嵌 Webview 页面 / 底部 Output 文本表格 / 系统浏览器打开，支持自动轮询刷新

## 配置

在 VS Code 设置中搜索 `oj`或者点击”比赛列表“旁边的设置按钮可配置以下选项：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `oj.baseUrl` | `http://localhost` | OJ 平台的 Base URL |
| `oj.defaultLanguage` | `cpp` | 默认编程语言（c/cpp/java） |
| `oj.autoRefreshStatus` | `true` | 提交后是否自动刷新状态 |
| `oj.statusRefreshInterval` | `5000` | 状态刷新间隔（毫秒） |
| `oj.statusViewMode` | `browser` | 状态查看方式：`browser`（外部浏览器）、`webview`（内嵌页面）、`output`（文本表格） |
| `oj.mcp.enabled` | `false` | 插件启动时是否自动启动 MCP 服务器 |
| `oj.mcp.port` | `9527` | MCP 服务器监听端口 |

## 命令清单

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| `oj.login` | — | 打开登录页面 |
| `oj.logout` | — | 登出并清除会话 |
| `oj.refreshContests` | — | 刷新比赛列表（清除搜索） |
| `oj.searchContests` | — | 搜索比赛（输入关键词筛选） |
| `oj.enterContest` | — | 进入选中的比赛 |
| `oj.enterContestWithPid` | — | 进入比赛并指定题目（输入 CID + PID） |
| `oj.exitContest` | — | 退出当前比赛 |
| `oj.showProblem` | — | 查看题目详情 |
| `oj.submit` | `Ctrl+Shift+S` | 提交当前编辑器代码 |
| `oj.refreshStatus` | — | 刷新提交状态（OutputChannel 底部输出） |
| `oj.toggleStatusAutoRefresh` | — | 开启/停止状态自动刷新（5秒间隔） |
| `oj.toggleFavorite` | — | 收藏/取消收藏比赛（右键菜单） |
| `oj.favoriteContest` | — | 收藏比赛（手动输入 CID） |
| `oj.prevContestPage` | — | 比赛列表上一页 |
| `oj.nextContestPage` | — | 比赛列表下一页 |
| `oj.jumpContestPage` | — | 比赛列表跳转到指定页 |
| `oj.refreshProblems` | — | 刷新题目列表 |
| `oj.debugShow` | — | 显示 Debug 日志（OutputChannel） |
| `oj.debugToggle` | — | 启用/禁用 Debug 日志 |
| `oj.debugClear` | — | 清空 Debug 日志 |
| `oj.mcp.start` | — | 启动 MCP 服务器 |
| `oj.mcp.stop` | — | 停止 MCP 服务器 |
| `oj.mcp.showLog` | — | 显示 MCP 服务器日志 |
| `oj.mcp.clearLog` | — | 清空 MCP 服务器日志 |

## 使用流程

1. **配置 Base URL**：在 VS Code 设置中将 `oj.baseUrl` 修改为你的 OJ 平台地址
2. **登录**：点击侧边栏 OJ 图标，执行 `oj.login` 命令，输入用户名、密码和验证码。勾选「记住我」后下次只需输入验证码即可快捷登录
3. **浏览比赛**：侧边栏"比赛列表"自动加载，点击比赛进入
4. **查看题目**：进入比赛后，"题目列表"显示所有题目，点击题目打开详情
5. **编写代码**：在 VS Code 中正常编辑代码文件
6. **提交代码**：选中题目后，在编辑器中按 `Ctrl+Shift+S`，输入验证码提交
7. **查看结果**：提交后在底部"OJ 提交状态"面板查看判题结果

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

**1. get_contest_problems**

获取比赛题目列表。包含题目编号、标题、AC 状态等。

参数（可选）：`cid` - 比赛 ID，不传则使用当前已进入的比赛。

**2. get_current_problem**

获取题目详细内容。默认返回当前在插件中打开的题目，也可通过参数指定任意比赛和题目。包括题目描述、输入说明、输出说明、样例等。

参数（可选）：`cid` - 比赛 ID、`pid` - 题目 ID。均不传则使用当前题目。

**3. get_contest_list**

分页获取比赛列表，支持关键词搜索。

参数（可选）：`page` - 页码（默认 1）、`keyword` - 搜索关键词。

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

# 获取当前打开题目的内容（不传参数）
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_current_problem"}}'

# 获取指定比赛和题目的内容
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_current_problem","arguments":{"cid":"1000","pid":"0"}}}'

# 获取指定比赛的题目列表
curl -X POST http://127.0.0.1:9527/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_contest_problems","arguments":{"cid":"1000"}}}'
```

## 项目结构

```
VsOJ/
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts         
│   ├── api/               
│   │   ├── client.ts        
│   │   ├── auth.ts           # 身份管理
│   │   ├── contest.ts        # 比赛/题目列表
│   │   ├── problem.ts        # 题目详情
│   │   └── submit.ts         # 代码提交/状态查询
│   ├── views/               
│   │   ├── contestTree.ts    # 比赛 TreeView
│   │   ├── problemTree.ts    # 题目 TreeView
│   │   └── statusPanel.ts    # 状态面板
│   ├── webview/              
│   │   ├── loginWebview.ts   # 登录页面
│   │   └── problemWebview.ts # 题目详情
│   ├── utils/                # 工具层
│   │   ├── parser.ts         
│   │   ├── crypto.ts         # MD5 加密
│   │   ├── state.ts         
│   │   └── config.ts         
│   └── types/
│       └── index.ts          
└── out/                      
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
