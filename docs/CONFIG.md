# VsOJ 配置说明书

> 本文件由 `npm run docs:config` 生成，**请勿手改**。
> 生成源：`package.json`（键名/类型/默认值）+ `src/config/manual.ts`（语义）。
> 与 MCP 工具 `get_config_manual` 的返回值同源，因此不会出现「文档说的和插件做的不一样」。

这是**给 AI 读的插件说明书**：AI 靠它知道本插件能配什么、怎么配、以及哪里一踩就废，
进而自行完成配置（探测本机 → 调 `init_config` 落盘）。

## 1. 初始化配置（给 AI 的操作顺序）

配置本插件的正确姿势是**先读说明书、再由 AI 探测本机、最后调工具写进去**，而不是让用户去设置面板里逐个找。三步：

### 第 1 步：读说明书

调 MCP 工具 `get_config_manual`（`section` 可只取需要的部分：`quickstart` / `settings` / `toolchains` / `files` / `pitfalls`）。

### 第 2 步：探测本机（这一步插件不做，由 AI 自己扫）

插件**不内置任何个人环境路径**，也不会扫盘找编译器 —— 那是 AI 的活：

1. 先试 `PATH` 里有没有：`g++ --version` / `python --version` / `javac -version`；
2. 没有就问用户 / 找常见的便携环境与包管理器目录（MSYS2、MinGW、LLVM、Visual Studio、conda、scoop/choco、homebrew）；
3. 找到**可执行文件的绝对路径**，写进下面第 3 步的 `toolchains`。

### 第 3 步：写进配置

调 MCP 工具 `init_config`。**默认只预览不落盘**（`apply` 省略或 `false`），返回「当前生效值 → 将要写入的值 + 探测/解析结果」；确认无误后再带 `apply: true` 落盘（覆盖旧文件前会自动备份）。

最小可用的一次调用（把 `baseUrl` 与编译器路径换成真实值）：

```json
{
  "settings": { "oj.baseUrl": "http://acm.example.edu.cn", "oj.mcp.enabled": true },
  "toolchains": [
    {
      "id": "cpp-g++",
      "commands": { "gpp": ["D:\\tools\\mingw64\\bin\\g++.exe"] },
      "pathPrepend": ["D:\\tools\\mingw64\\bin"]
    }
  ]
}
```

注意 `toolchains` 里**只写要覆盖的字段**，同 `id` 的其余字段继承内置（不必抄一遍命令模板）。

**必需项**：`oj.baseUrl`。
其余配置项都有合理默认值，不需要在初始化时全部写一遍。

## 2. 全部配置项

共 26 项。**结构**（键名 / 类型 / 默认值）由 `package.json` 生成，**语义**（取值 / 示例 / 坑）来自 `src/config/manual.ts`，两者由一致性测试保证不脱节。

| 配置项 | 类型 | 默认值 | 用途 | 标记 |
|---|---|---|---|---|
| `oj.baseUrl` | string | `"http://localhost"` | OJ 平台的根地址，所有请求的基准 | **必需** |
| `oj.statusPollInterval` | number | `800` | 待判定提交的轮询起始间隔（毫秒） |  |
| `oj.statusViewMode` | string | `"browser"` | 判题状态在哪里显示 |  |
| `oj.mcp.enabled` | boolean | `false` | 插件启动时是否自动启动 MCP 服务器 |  |
| `oj.mcp.port` | number | `9527` | MCP 服务器监听端口 |  |
| `oj.workspace.root` | string | `".vsoj"` | 本地数据根目录名（相对工作区根） |  |
| `oj.cache.enabled` | boolean | `true` | 是否把比赛 / 题目 / 状态写入本地缓存 |  |
| `oj.cache.ttlSeconds` | number | `180` | **同步读**的缓存有效期（秒），负数 = 永不过期 |  |
| `oj.cache.staleSeconds` | number | `900` | **异步刷新**的年龄阈值（秒），负数 = 永不过期 |  |
| `oj.cache.offline` | boolean | `false` | 离线模式：只读本地缓存，不发起网络请求 |  |
| `oj.project.enabled` | boolean | `true` | 是否启用「比赛项目」能力（进比赛自动建目录、左右分栏） |  |
| `oj.project.lazyInit` | boolean | `true` | 点开题目时是否自动把该题落到磁盘（懒初始化） |  |
| `oj.project.sourceFileName` | string | `"main.cpp"` | 题目源文件名（不含扩展名的部分要自己带上） |  |
| `oj.project.initEntryVisible` | boolean | `true` | 侧边栏是否显示「初始化项目」条目 |  |
| `oj.session.keepAliveInterval` | number | `240000` | 会话保活心跳间隔（毫秒），`0` 关闭 |  |
| `oj.session.probeInterval` | number | `600000` | 登录态探测间隔（毫秒），`0` 表示仅跟随心跳探测 |  |
| `oj.session.autoRelogin` | boolean | `true` | 识别到登录失效时自动打开登录页 |  |
| `oj.session.autoReplaySubmit` | boolean | `true` | 重新登录成功后，自动恢复原比赛/题目上下文并回到提交页 |  |
| `oj.test.toolchain` | string | `"auto"` | 使用哪套工具链 |  |
| `oj.test.toolchainsFile` | string | `".vsoj/toolchains.json"` | 工具链定义文件的位置 |  |
| `oj.test.searchDirs` | array | `[]` | 额外的命令搜索目录（编译器不在 PATH 时用） |  |
| `oj.test.reuseBuild` | boolean | `false` | 复用上次的编译产物 |  |
| `oj.test.timeoutMs` | number | `10000` | 单个用例的运行超时（毫秒） |  |
| `oj.test.maxOutputBytes` | number | `67108864` | 单个用例的输出体积上限（字节） |  |
| `oj.test.maxMemoryBytes` | number | `2147483648` | 单个用例的驻留内存上限（字节） |  |
| `oj.test.resultPage` | string | `"always"` | 跑完测试后是否弹出结果页 |  |

### 明细

### 平台接入

#### `oj.baseUrl`

- **用途**：OJ 平台的根地址，所有请求的基准
- **类型**：`string`｜**默认值**：`"http://localhost"`
- **必需**：不配则核心功能不可用
- **取值**：`http://` 或 `https://` 开头的完整地址，不含路径
- **说明**：插件不内置任何站点地址（public 插件不能假设你用哪个 OJ）。必须是能打开 HUSTOJ 首页的地址；末尾多余的 `/` 会被自动去掉。
- **示例**：`"http://acm.example.edu.cn"`
- ⚠️ **坑**：默认值 `http://localhost` 只是占位符，不改它插件等于没配 —— 表现为列表空白、登录页打不开，而不是报错。
- **设置面板原文**：OJ 平台的 Base URL（例如 http://your-oj-server.com）
- **读取处**：`getBaseUrl()`

#### `oj.statusPollInterval`

- **用途**：待判定提交的轮询起始间隔（毫秒）
- **类型**：`number`｜**默认值**：`800`
- **取值**：≥ 100 的整数；小于 100 会被忽略并回落 800
- **说明**：`oj.statusViewMode` 为 `webview` 或 `output` 时都生效：「等待 / 编译中 / 运行并评判」那几条会按这个间隔去查 `status-ajax.php`，**每次翻倍、封顶 8 秒**。站点自己的状态页用 80ms 起步，那是页面直连同机 OJ 的量级；插件每次都要过一层 HTTP 客户端（可能还套 WebVPN），起点因此宽得多。
- **示例**：`800`
- **设置面板原文**：提交状态页里「还没判完」那几条的轮询起始间隔（毫秒）。每次轮询后翻倍、封顶 8 秒 —— 与站点状态页自己的做法一致。
- **读取处**：`getStatusPollInterval()`

#### `oj.statusViewMode`

- **用途**：判题状态在哪里显示
- **类型**：`string`｜**默认值**：`"browser"`｜**可选值**：`output` / `webview` / `browser`
- **取值**：`browser` 外部浏览器 / `webview` 编辑器内结果页 / `output` 文本表格
- **说明**：`browser` 打开站点原页面最完整，但会跳出编辑器；`webview` 是插件自绘的结果页，**待判定的提交会在页面里就地轮询刷新**（不整页重载），并且能点开每一条看判题详情；`output` 是 Output 面板里的文本表格，同样会轮询待判定的提交，只是整屏重绘。
- ⚠️ **坑**：填了三个之外的值不会报错，会静默按 `browser` 走。
- **设置面板原文**：提交状态查看模式
- **读取处**：`getStatusViewMode()`

### 会话与登录

#### `oj.session.keepAliveInterval`

- **用途**：会话保活心跳间隔（毫秒），`0` 关闭
- **类型**：`number`｜**默认值**：`240000`
- **取值**：非负整数；`0` = 完全关闭心跳
- **说明**：HUSTOJ 的登录态会过期；定时发一次轻量请求把会话续上，避免「提交到一半发现已登出」。
- **示例**：`240000（4 分钟）`
- **设置面板原文**：会话保活心跳间隔（毫秒）。定时访问轻量页面以防止 Cookie 过期。填 0 关闭
- **读取处**：`getKeepAliveIntervalMs()`

#### `oj.session.probeInterval`

- **用途**：登录态探测间隔（毫秒），`0` 表示仅跟随心跳探测
- **类型**：`number`｜**默认值**：`600000`
- **取值**：非负整数；`0` = 不做独立探测
- **说明**：探测会**真发一个需要登录的请求**来判断登录态，比心跳重，所以默认间隔更长。
- **示例**：`600000（10 分钟）`
- **设置面板原文**：登录态探测间隔（毫秒）。定期检查登录是否失效，填 0 表示仅跟随心跳探测
- **读取处**：`getSessionProbeIntervalMs()`

#### `oj.session.autoRelogin`

- **用途**：识别到登录失效时自动打开登录页
- **类型**：`boolean`｜**默认值**：`true`
- **设置面板原文**：识别到登录失效时，自动打开登录页
- **读取处**：`getAutoRelogin()`

#### `oj.session.autoReplaySubmit`

- **用途**：重新登录成功后，自动恢复原比赛/题目上下文并回到提交页
- **类型**：`boolean`｜**默认值**：`true`
- **说明**：配合 `autoRelogin` 形成闭环：登出 → 自动登录 → 回到刚才那题 → 继续提交。
- **设置面板原文**：重新登录成功后，自动恢复原来的比赛与题目并回到提交页
- **读取处**：`getAutoReplaySubmit()`

### 缓存与工作区

#### `oj.workspace.root`

- **用途**：本地数据根目录名（相对工作区根）
- **类型**：`string`｜**默认值**：`".vsoj"`
- **取值**：目录名，相对工作区根；建议保持 `.vsoj` 以便加进 `.gitignore`
- **说明**：缓存、比赛项目、工具链配置都放在它下面。空值回退 `.vsoj`。
- ⚠️ **坑**：改这里等于换了一个数据根，**旧缓存不会再被读到**（不会迁移）。
- **设置面板原文**：本地缓存与比赛工作目录的名称（相对工作区根目录）。缓存内容、样例数据集、本地测试产物都放在这里，便于外部工具与 AI 直接消费
- **读取处**：`getWorkspaceRootName()`

#### `oj.cache.enabled`

- **用途**：是否把比赛 / 题目 / 状态写入本地缓存
- **类型**：`boolean`｜**默认值**：`true`
- **说明**：关掉后退化为「纯网页客户端」：每次都要联网，但也不会有残留文件。
- **设置面板原文**：是否将比赛/题目/状态写入本地缓存（关闭后不影响网络请求，只是不再落盘）
- **读取处**：`isCacheEnabled()`

#### `oj.cache.ttlSeconds`

- **用途**：**同步读**的缓存有效期（秒），负数 = 永不过期
- **类型**：`number`｜**默认值**：`180`
- **取值**：整数；负数表示永不过期
- **说明**：管的是「命中且新鲜就直接用，**不发任何请求**」这条快路径，用于比赛列表 / 题目列表 / 提交状态这类轻量数据。题面**不走**它（走 `staleSeconds`）。
- **示例**：`180`
- **设置面板原文**：缓存有效期（秒）。超期后重新请求网络。填 -1 表示永不过期
- **读取处**：`getCacheTtlMs()`

#### `oj.cache.staleSeconds`

- **用途**：**异步刷新**的年龄阈值（秒），负数 = 永不过期
- **类型**：`number`｜**默认值**：`900`
- **取值**：整数；负数表示永不过期
- **说明**：与 `ttlSeconds` 分工不同、**不冲突**：这里管的是「先渲染缓存，超过这个年龄才在后台重新拉」。题面用的就是它。
- **示例**：`900`
- **设置面板原文**：「异步刷新」阈值（秒）。打开题目页时**先渲染本地缓存**，超过该年龄才在后台重新拉取。填 `-1` 表示永不后台刷新。

与 `oj.cache.ttlSeconds` 的分工：`ttlSeconds` 管**同步读**（命中且新鲜就不发任何请求，用于比赛/题目列表），本项只管**题目详情**的后台刷新。
- **读取处**：`getStaleTtlMs()`

#### `oj.cache.offline`

- **用途**：离线模式：只读本地缓存，不发起网络请求
- **类型**：`boolean`｜**默认值**：`false`
- **说明**：适合断网/机房无网时翻已缓存过的题目。缓存里没有的内容会明确报错（「离线拿不到」而不是「站点上没有」），不会偷偷联网。
- **设置面板原文**：离线模式：只读本地缓存，不发起网络请求（用于无网络环境浏览已缓存的题目）
- **读取处**：`isOfflineMode()`

### 比赛项目

#### `oj.project.enabled`

- **用途**：是否启用「比赛项目」能力（进比赛自动建目录、左右分栏）
- **类型**：`boolean`｜**默认值**：`true`
- **说明**：关掉后退化为纯网页客户端：**不写盘、不分栏**，题目只在 webview 里看。
- ⚠️ **坑**：关掉它之后 `project.*` 其余项与 `test.*` 整套都会失效 ——本地测试依赖题目目录里的 `samples/` 与 `main.cpp`。
- **设置面板原文**：启用「比赛项目」能力：把题面、样例与 main.cpp 写入你打开的文件夹。关闭后退化为纯网页客户端（只读看题，不写盘、不分栏）
- **读取处**：`isProjectEnabled()`

#### `oj.project.lazyInit`

- **用途**：点开题目时是否自动把该题落到磁盘（懒初始化）
- **类型**：`boolean`｜**默认值**：`true`
- **说明**：开 = 看哪题建哪题，省磁盘；关 = 进入比赛时一次性预取全部题目。
- **设置面板原文**：**懒初始化**：点开某道题时自动把该题落到磁盘，随后左侧打开源文件、右侧显示题目。关闭后未初始化的题只读显示，需先在侧边栏点「初始化比赛项目」。
- **读取处**：`isLazyInitEnabled()`

#### `oj.project.sourceFileName`

- **用途**：题目源文件名（不含扩展名的部分要自己带上）
- **类型**：`string`｜**默认值**：`"main.cpp"`
- **示例**：`"main.cpp"`
- ⚠️ **坑**：**已存在的主源文件永远不会被覆盖**（这是硬契约），所以改这个值只会影响**之后新建**的题目目录，不会重命名已有文件。
- **设置面板原文**：每道题新建的源文件名。提交时提交的是当前正在编辑的文件，因此改这里不影响提交逻辑
- **读取处**：`getSourceFileName()`

#### `oj.project.initEntryVisible`

- **用途**：侧边栏是否显示「初始化项目」条目
- **类型**：`boolean`｜**默认值**：`true`
- **说明**：`false` = 彻底关闭这个入口（不是隐藏按钮而是不注册），界面更干净。
- **设置面板原文**：在侧边栏「题目列表」中显示「初始化比赛项目」条目。关闭后该条目不再出现（仍可用命令面板手动初始化）
- **读取处**：`isInitEntryVisible()`

### 本地测试

#### `oj.test.toolchain`

- **用途**：使用哪套工具链
- **类型**：`string`｜**默认值**：`"auto"`
- **取值**：`auto` = 按源文件扩展名自动匹配；或填 `toolchains.json` 里某个定义的 `id`
- **说明**：内置四套：`cpp-g++` / `c-gcc` / `java` / `python`。指定了不存在的 id 会明确报错并列出现有 id（不会静默回退到 auto）。
- ⚠️ **坑**：文件扩展名不在任何工具链的 `extensions` 里时，`auto` 会失败并列出可用组合。
- **设置面板原文**：本地测试使用的工具链 id。`auto` 按源文件扩展名自动匹配；也可填 `toolchains.json` 里自定义的 id。
- **读取处**：`getTestToolchainId()`

#### `oj.test.toolchainsFile`

- **用途**：工具链定义文件的位置
- **类型**：`string`｜**默认值**：`".vsoj/toolchains.json"`
- **取值**：相对工作区根的路径，或绝对路径
- **说明**：内置工具链写在代码里、**不需要**在这个文件里重复声明；这里只放你的覆盖与新增（同 `id` 覆盖内置，并保留「内置」标记）。
- **示例**：`".vsoj/toolchains.json"`
- **设置面板原文**：工具链定义文件的位置（相对工作区根或绝对路径）。内置工具链写在代码里，此文件只放你的覆盖与新增。
- **读取处**：`getToolchainsFile()`

#### `oj.test.searchDirs`

- **用途**：额外的命令搜索目录（编译器不在 PATH 时用）
- **类型**：`array`｜**默认值**：`[]`
- **取值**：目录绝对路径数组
- **说明**：查找顺序：配置里的绝对路径 → PATH → `searchDirs` → 内置通用目录。也可以不写这里，直接在 `toolchains.json` 里把命令写成绝对路径。
- **示例**：`["D:\\tools\\mingw64\\bin", "/opt/homebrew/opt/llvm/bin"]`
- ⚠️ **坑**：**这是「AI 扫描本机后最该写的地方」**：插件不内置任何个人环境路径，编译器不在 PATH 时只有靠它或绝对路径才找得到。
- **设置面板原文**：额外的命令搜索目录（如便携环境 `D://tools//mingw64//bin`）。不填也能用：在 `toolchains.json` 里把命令写成绝对路径即可。
- **读取处**：`getTestSearchDirs()`

#### `oj.test.reuseBuild`

- **用途**：复用上次的编译产物
- **类型**：`boolean`｜**默认值**：`false`
- **说明**：默认 **false**（每次重新编译）。开起来后按「源文件内容 + 工具链 + 编译模板」的哈希复用，改完再改回去也能命中 —— 是内容哈希而非时间戳。
- ⚠️ **坑**：开着它时，改的是**别的文件**（如被 include 的头文件）不会让哈希变化，可能跑到旧产物；调试前想要 100% 新鲜就用「强制重新编译」。
- **设置面板原文**：复用上次编译产物：源文件内容没变就跳过编译。默认关闭（每次都重编），避免调试到旧产物。
- **读取处**：`isBuildReuseEnabled()`

#### `oj.test.timeoutMs`

- **用途**：单个用例的运行超时（毫秒）
- **类型**：`number`｜**默认值**：`10000`
- **取值**：正整数
- **说明**：属于「宽松看门狗」：触发只会终止运行并把超时记为**运行事实**，判定依旧只看输出文件比对结果。
- **示例**：`10000`
- ⚠️ **坑**：调太小会让正常但偏慢的解法（暴力枚举）频繁被砍，看起来像程序有 bug。
- **设置面板原文**：单个用例的运行超时（毫秒）。超时会上报为运行事实，不参与判定。
- **读取处**：`getTestLimits()`

#### `oj.test.maxOutputBytes`

- **用途**：单个用例的输出体积上限（字节）
- **类型**：`number`｜**默认值**：`67108864`
- **取值**：正整数
- **说明**：防死循环狂打印把磁盘写爆的那道闸。超出即终止运行。
- **示例**：`67108864（64 MB）`
- **设置面板原文**：单个用例的输出上限（字节）。超出会终止运行，防止死循环把磁盘写满。
- **读取处**：`getTestLimits()`

#### `oj.test.maxMemoryBytes`

- **用途**：单个用例的驻留内存上限（字节）
- **类型**：`number`｜**默认值**：`2147483648`
- **取值**：正整数
- **说明**：**这是看门狗不是硬限制**：Windows 没有 cgroup，只能轮询（约 1 秒一次），存在误差、也可能误杀。想要精确限制得靠容器/沙箱，不在本插件范围内。
- **示例**：`2147483648（2 GB）`
- **设置面板原文**：单个用例的驻留内存上限（字节，宽松看门狗，1 秒轮询一次）。
- **读取处**：`getTestLimits()`

#### `oj.test.resultPage`

- **用途**：跑完测试后是否弹出结果页
- **类型**：`string`｜**默认值**：`"always"`｜**可选值**：`always` / `onFailure` / `never`
- **取值**：`always` / `onFailure` / `never`
- **说明**：结果页是插件自绘的页面（两级：用例列表 → 期望 / 实际 / 差异明细），`always` 每次都弹、`onFailure` 只在有失败或没跑起来时弹、`never` 不弹。**全通过时页面不抢焦点**，只有失败或异常才把光标夺过去。
- **示例**：`always`
- ⚠️ **坑**：设成 `never` 不影响判定与产物 —— `result.json` 与 `report.md` 照常写入，只是不再自动开页面。
- **设置面板原文**：跑完本地测试后是否弹出结果页：`always` 每次都弹（全通过也不抢焦点）、`onFailure` 只在有失败或没跑起来时弹、`never` 不弹（结果仍写入 `result.json` / `report.md`）。
- **读取处**：`getTestResultPageMode()`

### MCP 服务器

#### `oj.mcp.enabled`

- **用途**：插件启动时是否自动启动 MCP 服务器
- **类型**：`boolean`｜**默认值**：`false`
- **说明**：MCP 是 AI 与本插件交互的通道（AI 靠它读题、跑测试、写配置）。也可用状态栏按钮或命令手动启停。
- **设置面板原文**：是否在插件启动时自动启动 MCP 服务器（供 AI Agent 调用）
- **读取处**：`getMcpEnabled()`

#### `oj.mcp.port`

- **用途**：MCP 服务器监听端口
- **类型**：`number`｜**默认值**：`9527`
- **说明**：只监听 `127.0.0.1`，不对外暴露。
- **示例**：`9527`
- ⚠️ **坑**：端口被占用时启动会失败并提示换端口 —— 那时 AI 客户端的 MCP 配置里也要同步改。
- **设置面板原文**：MCP 服务器监听端口
- **读取处**：`getMcpPort()`

## 3. 配置文件放在哪

| 文件 | 位置 | 谁写 | 说明 |
|---|---|---|---|
| 插件设置 | 工作区 `.vscode/settings.json`（或全局 User settings） | AI（`init_config`）或用户 | `oj.*` 全部配置项 |
| 工具链定义 | `.vsoj/toolchains.json`（可配 `oj.test.toolchainsFile` 改） | AI / 用户 | 只放覆盖与新增，内置四套在代码里 |
| 本地数据 | `.vsoj/`（可配 `oj.workspace.root` 改） | 插件 | 缓存、比赛项目、题目目录 |
| 题目工作目录 | `<工作区>/<cid>-<标题>/problems/<全局题号>-<标题>/` | 插件 | 该题的 `main.cpp` / `samples/` / `temp/` / `test/` |

**优先级**：工作区设置 > 全局 User 设置 > `package.json` 里的默认值。
`init_config` 默认写**工作区**级（`scope` 可用 `global` 改成全局）。

`.vsoj/toolchains.json` 的形状：

```json
{
  "toolchains": [
    { "id": "cpp-g++", "commands": { "gpp": ["D:\\tools\\mingw64\\bin\\g++.exe"] } }
  ]
}
```

坏 JSON 或坏条目**不会让测试功能整体瘫痪**：解析器只记账并跳过，`init_config` 的预览里会把问题列出来。

## 4. 工具链（本地测试的语言差异都关在这里）

测试引擎对语言**一无所知**：它只做三件事 —— `prepare`（交给工具链）、`run`（传入输入/输出文件地址）、`compare`（比输出文件）。编译型与解释型的区别全由工具链定义吸收。

### 内置四套

| id | label | 认领扩展名 | 类型 |
|---|---|---|---|
| `cpp-g++` | C++ (g++) | `.cpp .cc .cxx .c++` | 编译型（`asciiSafeOutput`） |
| `c-gcc` | C (gcc) | `.c` | 编译型（`asciiSafeOutput`） |
| `java` | Java (javac/java) | `.java` | 编译型 |
| `python` | Python | `.py` | 解释型 |

### 字段

| 字段 | 说明 |
|---|---|
| `id` **必需** | 唯一标识。与内置 `id` 相同 = 覆盖内置（保留「内置」标记，不可删） |
| `label` | 显示名，只用于展示 |
| `kind` | `compiled` 编译型 / `interpreted` 解释型。不写时按有无 `compile` 自动推断 |
| `extensions` **必需** | 认领哪些源文件扩展名（含点），如 `[".cpp", ".cc"]` |
| `commands` **必需** | 命令名 → 候选列表。每个候选按「绝对路径 → PATH → searchDirs → 通用目录」解析，第一个存在的胜出 |
| `compile` | 编译命令模板（编译型必需）。占位符：`{source}` `{output}` `{dir}` `{stem}` `{ext}` `{<命令名>}` |
| `run` **必需** | 运行命令模板。占位符：`{runnable}` `{dir}` `{stem}` 与各命令名 |
| `env` | 额外环境变量。**写了 `env.PATH` 就完全采纳它**（逃生口），不再自动推导 |
| `pathPrepend` | 追加到子进程 PATH 前面的目录（在自动推导之上追加） |
| `timeoutMs` | 覆盖全局超时 |
| `maxOutputBytes` | 覆盖全局输出上限 |
| `maxMemoryBytes` | 覆盖全局内存看门狗阈值 |
| `asciiSafeOutput` | 声明「传给编译器的产物路径必须纯 ASCII」。MinGW 的 `ld` 实测有这毛病，内置 C/C++ 已声明；Java/Python 不需要 |

### 命令是怎么找到的（顺序）

1. 命令候选本身写成绝对路径且该文件存在
2. `PATH` 环境变量里的目录（Windows 按 `.exe` → `.cmd` → `.bat` 依次试）
3. `oj.test.searchDirs` 里的目录（按数组顺序）
4. 内置通用目录（`C:\mingw64\bin`、`/usr/bin`、`/opt/homebrew/bin` 等）

> **PATH 注入**：子进程的 `PATH` **不继承外层环境**，只由「已解析命令所在目录」+ `pathPrepend` 拼成。原因：MinGW 的产物依赖同目录的 `libstdc++-6.dll`，实测不注入就直接 exit 127（表现为「所有样例都失败」）。要完全接管就在 `env.PATH` 里写死。

### 固定约定（写死，别试图绕）

- **产物名固定为 `main(.exe)`**，不派生自源文件名 —— 源文件名用户可配、可能含中文，派生会重新踩到下面的坑。
- **产物落在题目目录的 `temp/`**，报告与 `test/result.json` 也写在 `test/`。
- **非 ASCII 路径**：Windows 上 MinGW 的 `ld` 无法在含中文的产物路径下创建文件（`cannot open output file ...: No such file or directory`）。引擎用**相对路径**根治（命令行里因此不含任何非 ASCII 字符）；声明了 `asciiSafeOutput` 的工具链才会走这条路径，跨盘等无解情况才退回 ASCII 中转目录。
- **用例发现**：`samples/` 下按序号成对的 `N.in` / `N.out` 全跑；只有 `N.in` 没有 `N.out` 的「半对」会跳过并在报告里点名（不静默忽略）。
- **判定只有通过 / 不通过**：退出码、耗时、是否被看门狗砍都只是**运行事实**，不参与判定。

### 新增一套语言

在 `.vsoj/toolchains.json` 里加一个 `id` 不在内置列表里的定义即可，例如：

```json
{
  "toolchains": [
    {
      "id": "go",
      "label": "Go",
      "extensions": [".go"],
      "commands": { "go": ["go"] },
      "compile": "\"{go}\" build -o \"{output}\" \"{source}\"",
      "run": "\"{runnable}\""
    }
  ]
}
```

写完把 `oj.test.toolchain` 设为 `"go"`（或保持 `auto` 让它按扩展名匹配）。

## 5. 常见坑（都是踩过的）

- **`oj.baseUrl`**：默认值 `http://localhost` 只是占位符，不改它插件等于没配 —— 表现为列表空白、登录页打不开，而不是报错。
- **`oj.statusViewMode`**：填了三个之外的值不会报错，会静默按 `browser` 走。
- **`oj.mcp.port`**：端口被占用时启动会失败并提示换端口 —— 那时 AI 客户端的 MCP 配置里也要同步改。
- **`oj.workspace.root`**：改这里等于换了一个数据根，**旧缓存不会再被读到**（不会迁移）。
- **`oj.project.enabled`**：关掉它之后 `project.*` 其余项与 `test.*` 整套都会失效 ——本地测试依赖题目目录里的 `samples/` 与 `main.cpp`。
- **`oj.project.sourceFileName`**：**已存在的主源文件永远不会被覆盖**（这是硬契约），所以改这个值只会影响**之后新建**的题目目录，不会重命名已有文件。
- **`oj.test.toolchain`**：文件扩展名不在任何工具链的 `extensions` 里时，`auto` 会失败并列出可用组合。
- **`oj.test.searchDirs`**：**这是「AI 扫描本机后最该写的地方」**：插件不内置任何个人环境路径，编译器不在 PATH 时只有靠它或绝对路径才找得到。
- **`oj.test.reuseBuild`**：开着它时，改的是**别的文件**（如被 include 的头文件）不会让哈希变化，可能跑到旧产物；调试前想要 100% 新鲜就用「强制重新编译」。
- **`oj.test.timeoutMs`**：调太小会让正常但偏慢的解法（暴力枚举）频繁被砍，看起来像程序有 bug。
- **`oj.test.resultPage`**：设成 `never` 不影响判定与产物 —— `result.json` 与 `report.md` 照常写入，只是不再自动开页面。
