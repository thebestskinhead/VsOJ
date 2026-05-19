# VsOJ 微软大战OJ

OJ 在线判题平台 VS Code 插件，让你在 VS Code 内完成全部 OJ 操作，方便你大战代码

## 功能特性

- **登录系统** — 支持验证码登录，Cookie 持久化，重启 VS Code 免密登录
- **比赛列表** — 侧边栏 TreeView 展示所有比赛，支持收藏
- **题目列表** — 进入比赛后显示题目清单，标记已 AC 题目
- **题目详情** — Webview Panel 渲染题目 HTML（图片 base64 内联）
- **代码提交** — 一键提交当前编辑器代码（快捷键 `Ctrl+Shift+S`）
- **状态查询** — 底部面板查看提交状态，支持自动轮询刷新

## 配置

在 VS Code 设置中搜索 `oj`或者点击”比赛列表“旁边的设置按钮可配置以下选项：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `oj.baseUrl` | `http://localhost` | OJ 平台的 Base URL |
| `oj.defaultLanguage` | `cpp` | 默认编程语言（c/cpp/java） |
| `oj.autoRefreshStatus` | `true` | 提交后是否自动刷新状态 |
| `oj.statusRefreshInterval` | `5000` | 状态刷新间隔（毫秒） |

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
| `oj.refreshProblems` | — | 刷新题目列表 |
| `oj.debugShow` | — | 显示 Debug 日志（OutputChannel） |
| `oj.debugToggle` | — | 启用/禁用 Debug 日志 |
| `oj.debugClear` | — | 清空 Debug 日志 |

## 使用流程

1. **配置 Base URL**：在 VS Code 设置中将 `oj.baseUrl` 修改为你的 OJ 平台地址
2. **登录**：点击侧边栏 OJ 图标，执行 `oj.login` 命令，输入用户名、密码和验证码
3. **浏览比赛**：侧边栏"比赛列表"自动加载，点击比赛进入
4. **查看题目**：进入比赛后，"题目列表"显示所有题目，点击题目打开详情
5. **编写代码**：在 VS Code 中正常编辑代码文件
6. **提交代码**：选中题目后，在编辑器中按 `Ctrl+Shift+S`，输入验证码提交
7. **查看结果**：提交后在底部"OJ 提交状态"面板查看判题结果

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
