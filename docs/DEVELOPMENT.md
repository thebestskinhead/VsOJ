# VsOJ Pro 开发说明

构建与测试、项目结构、分阶段路线。使用说明见 [README](../README.md)，
架构分层与职责边界见 [ARCHITECTURE.md](ARCHITECTURE.md)，配置项逐项说明见 [CONFIG.md](CONFIG.md)。

## 构建与测试

```bash
npm install
npm run compile      # 编译
npm test             # 编译 + 运行全部测试（28 套件 / 1482 项断言，无需 VS Code 运行时）
npm run smoke:site   # 真实站点端到端冒烟（需要能访问目标 OJ）
npm run test:cache   # 仅缓存层（布局 / 新鲜度 / 清理语义）
npm run test:session # 仅会话层
npm run test:init    # 仅项目初始化
npm run test:guard   # 仅工作区守卫决策
npm run test:tree    # 仅侧边栏条目
```

测试通过替换 `vscode` 模块桩在 Node 中直接运行编译产物；会话层测试还会启动一个本地
HTTP 服务器真实复现 OJ 的各类响应（500 空体 / 302 重定向 / 验证码错误 / 连接被拒等）。

## 项目结构

```
VsOJ/
├── package.json
├── tsconfig.json
├── docs/
│   ├── ARCHITECTURE.md       # 架构分层、职责边界与分阶段演进路线
│   ├── CONFIG.md             # 配置项逐项说明（由 npm run docs:config 生成）
│   ├── DEVELOPMENT.md        # 本文件
│   ├── PLAN_S4/S5/S6.md      # 各阶段的计划与契约
│   ├── PROGRESS.md           # 各阶段的实施记录
│   └── SITE_ANALYSIS.md      # 目标 OJ 站点机制分析（验证码/会话/CSRF/登录态边界）
├── scripts/
│   ├── gen-config-docs.js    # 由源码生成 docs/CONFIG.md
│   └── smoke-site.js         # 真实站点端到端冒烟
├── test/                     # 脱离 VS Code 运行时的自动化测试
│   ├── run-all.js            # 一次跑完全部套件并汇总
│   ├── helpers/stub.js       # vscode 模块桩
│   └── *.test.js
├── src/
│   ├── extension.ts          # 组合根：装配服务/命令/视图，只做编排不做判定
│   ├── api/                  # 网络层：请求 + 交给 parser
│   │   ├── client.ts         # axios 单例 + Cookie 管理
│   │   ├── auth.ts           # 身份管理
│   │   ├── contest.ts        # 比赛/题目列表
│   │   ├── problem.ts        # 题目详情
│   │   └── submit.ts         # 代码提交/状态查询
│   ├── cache/                # 缓存层：离线能力的数据源
│   │   ├── paths.ts          # 目录布局与命名规则（唯一路径来源）
│   │   └── store.ts          # 缓存读写（唯一读写入口）
│   ├── session/              # 会话层：保活与失效自愈
│   │   ├── guard.ts          # 失效判定（唯一判定点）+ 意图重放
│   │   └── keeper.ts         # 心跳保活与登录态探测
│   ├── views/                # 展示层①：TreeView / OutputChannel
│   │   ├── contestTree.ts
│   │   ├── problemTree.ts
│   │   └── statusPanel.ts
│   ├── webview/              # 展示层②：Webview Panel
│   │   ├── loginWebview.ts
│   │   ├── accountWebview.ts
│   │   ├── submitWebview.ts
│   │   ├── problemWebview.ts
│   │   ├── testResultWebview.ts   # 本地测试结果页
│   │   ├── statusWebview.ts       # 提交结果页
│   │   └── toolchainWebview.ts    # 工具链配置页
│   ├── test/                 # 本地测试引擎
│   │   ├── toolchain.ts      # 工具链模型 + 内置四套
│   │   ├── compare.ts        # 严格逐字节比较 + 首个差异定位
│   │   ├── runner.ts         # 编译 / 运行 / 判定三步 + 结果与报告
│   │   ├── watchdog.ts       # 三闸看门狗（时间 / 输出体积 / 内存）
│   │   ├── terminal.ts       # 终端输出桥
│   │   ├── tasks.ts          # 自定义 `oj` 任务
│   │   ├── wiring.ts         # 装配：选工具链、发现样例、拼路径
│   │   └── tools.ts          # 测试类 MCP 工具的服务层
│   ├── config/               # 配置说明书与 AI 初始化
│   │   ├── manual.ts         # 配置说明书的字段与语义
│   │   ├── writer.ts         # 配置写入计划
│   │   ├── wiring.ts         # 配置工具的扩展侧接线
│   │   └── tools.ts          # MCP get_config_manual / init_config
│   ├── workspace/            # 工作区侧装配
│   │   ├── initializer.ts    # 比赛项目初始化策略
│   │   ├── guard.ts          # 工作区守卫（无工作区时只读看题）
│   │   ├── openSource.ts     # 左栏打开源码的复用判定
│   │   ├── wiring.ts         # 初始化依赖接线
│   │   └── resources.ts      # 题目本地路径清单（供 MCP 返回）
│   ├── mcp/                  # 对外层：MCP 服务器与工具
│   ├── media/                # 题面图片本地化
│   ├── utils/                # 基础层
│   │   ├── parser.ts         # 唯一 HTML 解析出口
│   │   ├── problemMarkdown.ts # 题面 → Markdown
│   │   ├── format.ts         # 输出转义与字节数格式化
│   │   ├── slug.ts           # 目录 / 文件名生成规则
│   │   ├── crypto.ts         # MD5 加密
│   │   ├── state.ts          # 唯一持久化出口
│   │   ├── config.ts
│   │   └── debug.ts
│   └── types/
│       └── index.ts
└── out/                      # 编译产物
```

分层约定：`api` 不碰 UI，`views`/`webview` 不直接发请求，`parser` 是唯一 HTML 解析口，
`state` 是唯一持久化口，`cache/paths.ts` 是唯一缓存路径来源。

## 各阶段能力

阶段划分、交付物与依赖见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 的「分阶段路线」。

S4 已闭环的能力：缓存只存原始信息（题面 HTML / 图片二进制 / 样例）、侧边栏列表缓存优先、
题目页缓存优先渲染 + 后台异步刷新（超 15 分钟且网络可达才刷新）、图片本地化（离线可看图）、
单题 / 全量强制刷新、清理缓存（保留源码 `main.cpp`、`test/` 与 `meta.json`）。

S5 已闭环的能力：进入题目即落地该题（题面 / 样例 / 图片 / `main.cpp` / `temp/` / `test/`）、
侧边栏「初始化比赛项目」条目做全量预取（带进度、可取消）、左侧源码右侧题目、
无工作区时只读看题并阻断提交。

S6 已闭环的能力（本地测试引擎）：**工具链抽象**（内置 C / C++ / Java / Python，
可用 `.vsoj/toolchains.json` 覆盖或新增）、**严格逐字节判定**（先做换行归一化，等价站点 Linux 判题环境）、
**三闸看门狗**（超时 / 输出体积 / 驻留内存）、**编译器产物复用**（源码与工具链没变就不重复编译）、
**三个触发入口**（命令面板与题目项右键菜单 / 侧边栏标题栏下拉 / `oj` 类型自定义任务在终端里跑）、
以及**结果页**（两级：用例列表 → 期望 / 实际 / 差异定位；代码改动后自动标「结果可能已过期」）。
