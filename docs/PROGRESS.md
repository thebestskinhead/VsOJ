# 项目进展与决策记录

> 本文件是项目的**长期记忆**：记录每个阶段做了什么、验证到什么程度、以及为什么这么做。
> 面向后续接手的人（或 AI）。架构与路线见 `docs/ARCHITECTURE.md`，站点机制见 `docs/SITE_ANALYSIS.md`。

## 里程碑

| 阶段 | 日期 | 内容 | 验证 |
|---|---|---|---|
| S0 | 2026-09-13 | 站点机制分析、架构分层与演进路线 | 被动探测实测（无登录态写操作） |
| S1 | 2026-09-13 | 本地缓存层骨架 | `npm run test:cache` 29 项断言 |
| S2 | 2026-09-13 | 会话保活 + 登录失效自愈 | `npm run test:session` 71 项断言 |
| S4 | 2026-09-13 | 运行期缓存刷新与离线预览（缓存改为只存原始信息） | `npm test` 7 套件 / 281 项断言 + 真实站点冒烟 |
| S5 | 2026-09-13 | 比赛项目初始化（懒初始化 / 全量预取 / 左代码右题目 / 无工作区守卫） | `npm test` 12 套件 / 520 项断言 + 真实站点冒烟 84 项 |
| S5.8 | 2026-09-13 | 页面固定亮色主题（自绘 Webview 不再跟随编辑器配色） | `npm run test:theme` 10 项断言 |
| S6.0–S6.2 | 2026-09-14 | 本地测试引擎：工具链模型 / 严格比较器 / prepare-run-compare + 三闸看门狗 | `npm test` 16 套件；`test:toolchain` 65、`test:compare` 49、`test:runner` 70（真实 g++ 端到端） |
| S6.2.1 | 2026-09-14 | 中文路径改由**相对路径**根治（MinGW 的 `ld` 写不出非 ASCII 产物路径） | `npm run test:runner` 70 项 |
| S6.3 | 2026-09-14 | 测试接线层：7 个 `oj.test.*` 配置项、选工具链、发现样例、命令与右键菜单 | `npm run test:wiring` 44 项 |
| S6.4 | 2026-09-14 | 自定义任务（`oj` 类型）+ 终端桥：编译 / 本地测试 / 强制重编译 / **跑一下** | `npm run test:tasks` 43 项（真实 g++ 端到端） |
| S6.5 | 2026-09-14 | **配置说明书 + AI 初始化工具**（MCP：`get_config_manual` / `init_config`），`docs/CONFIG.md` 随插件发布 | `npm test` 21 套件；`test:config-manual` 44、`test:config-writer` 85、`test:config-tools` 54 |

---

## S0 — 站点机制分析（2026-09-13）

**做了什么**
- 通过 `docs/SITE_ANALYSIS.md` 固化目标站点机制，避免后续每次改动都要重新猜。
- 产出 `docs/ARCHITECTURE.md`：现有分层 → 7 项 gap → 新增 4 层落位 → S0–S7 路线。

**关键实测结论（后续所有判定都基于这些）**
1. 目标是 **HUSTOJ 定制版**（footer 明示，nginx + PHP，无 REST API）。
2. 验证码服务端会话绑定：`vcode.php` 把答案写入 `$_SESSION['vcode']`，
   `?Math.random()` 只是打缓存；**同会话里最后一次请求的验证码才有效**。
3. `PHPSESSID` 只在客户端无 Cookie 时下发，且**登录时不轮换**。
4. `csrf.php` 返回 `<input type="hidden" name="csrf" value="...">`（85 B）。
5. **`problem.php` 对公开比赛免登录渲染**（cid=3772 / 3775 实测返回样例），
   私有比赛返回 `Not Invited!` —— 这是「题目页能进」的原因。
6. **`submit.php` 会话失效时返回 HTTP 500 + 空响应体** —— 这是「提交却失败」的原因。
7. 登录页可识别特征：含 `name="user_id"` + `vcode.php`，且**不含** `logout.php`。

---

## S1 — 本地缓存层（2026-09-13）

**做了什么**
- 新增 `src/cache/paths.ts`（唯一路径来源）、`src/cache/store.ts`（唯一读写入口）。
- 新增配置 `oj.workspace.root` / `oj.cache.enabled` / `oj.cache.ttlSeconds` / `oj.cache.offline`。
- 新增 `test/cache-layout.test.js`。

**决策：缓存根放在工作区而非 globalStorage**
消费者包含 MCP / AI / 外部本地测试脚本，它们需要**真实 OS 路径**与可被 git 管理的产物。
因此根目录 = `<workspaceFolder>/<oj.workspace.root>`，无工作区时才退化到 `globalStorage/cache`。

**踩坑与修正（由实测发现，值得记住）**
初版 `ensureContestDir(cid, title)` 直接用传入的 `title` 推导目录名，结果：
- `writeStatus('3772')` → `3772`
- `writeProblem({title:'A + B'})` → `3772-A-+-B`（**把题目名当成了比赛名**）
- `writeProblemList('3772','2025年校赛')` → `3772-2025年校赛`

同一个 cid 派生出 **4 个目录**。修正后的规则：
- 目录名**首次落盘后不再变化**；无标题时先建纯 `<cid>` 并标记 `meta.pendingTitle`，
  拿到真实比赛标题后由 `finalizeContestTitle()` 重命名**一次**。
- `writeProblem` / `writeSample` / `writeStatus` 一律传空标题以复用既有目录；
  只有 `writeProblemList` 知道比赛标题并在此时定稿。
- `locateContestDir()` 以磁盘扫描为兜底，索引丢失也能恢复。

---

## S2 — 会话保活与失效自愈（2026-09-13）

**做了什么**
- 新增 `src/session/guard.ts`：`FailureKind` 分类 + 登录页判定 + 待重放意图（30 分钟 TTL）。
- 新增 `src/session/keeper.ts`：心跳（`/csrf.php`）+ 登录态探测，依赖注入、纯时序、可测。
- `SubmitService.submit` 返回结构化 `SubmitOutcome`（含 `kind`），不再用抛异常表达业务失败。
- `extension.ts` 只做编排：抽出 `openSubmitWebview()` 供提交与重放共用。
- 新增 4 个命令 + 会话状态栏 + 登录页 `notice` / 优先快捷登录。

**决策：为什么心跳用 `/csrf.php`**
85 字节、无副作用、任何携带 `PHPSESSID` 的请求都会刷新服务端会话 mtime。
`/status.php` 25 KB 太重，`/loginpage.php` 10 KB 且兼作登录态探测（另用）。

**决策：为什么用「连续失败 3 次 → 升级探测」而不是直接判失效**
心跳失败多数是网络抖动。只有探测（复用既有的 `isLoggedIn()`，判 `logout.php` 标记）
明确返回 false 才判失效，避免误报弹窗。

**踩坑与修正（由端到端测试发现，最重要的一条）**
初版把**裸 302 一律判为 `SESSION_EXPIRED`**。但 `client.ts` 设了 `maxRedirects: 5`，
axios 会自动跟随重定向 —— 而**提交成功后站点同样 302 到 `status.php`**，
于是一次成功提交会被误报成「登录过期」。
修正：分类器不再处理裸 302，改由 `SubmitService` 结合 `Location` 与**最终正文**判定，
并新增 `looksLikeLoginPage()` 识别「跟随后的落点就是登录页」这一形态。

**测试策略**
`test/session.test.js` 启动一个本地 HTTP 服务器，真实复现 500 空体 / 302→loginpage /
302→status / `Not Invited!` / 404 / 连接被拒，验证 `SubmitService` 的分类结果。
这样「登录过期」的判定逻辑有真实网络行为背书，而不是只有纯函数单测。

---

## S4 — 运行期缓存刷新与离线预览（2026-09-13）

**做了什么**

- **S4.0 缓存语义重定义**：布局与 `store` 全面改为**只存原始信息**
  （题面 HTML、图片二进制、样例文本）；`problem.json` / `problem.md` /
  `problems.json` / `status.json` 一律不再落盘，改由 parser/api 按需解析。
  `meta.json` 是唯一保留的非站点文件。
- **S4.1 两级 TTL 分工**：新增 `oj.cache.staleSeconds`（默认 900）。
  原 `ttlSeconds`（默认 180）用于**列表同步读**，`staleSeconds` 用于**题目详情后台异步刷新**。
- **S4.2 网络可达性探测** `src/session/connectivity.ts`：30 秒结果缓存、
  并发合并、`validateStatus: () => true`（只要拿到 HTTP 响应即视为可达），探测点用 `/csrf.php`。
- **S4.3 重访决策层** `src/cache/revalidate.ts`：`resolveRevisitPlan` 输出
  offline / no-cache / fresh / stale / unreachable 五态，**只在「在线 + 有缓存 + 已过期」时才探网**。
- **S4.4/4.5 刷新执行器** `src/cache/refresher.ts`：`refreshOne` / `refreshAll`，
  串行、不重试、可取消、失败汇总。
- **S4.6 接入与命令**：题目页缓存优先渲染 + 后台刷新 + 常驻「更新于 X 分钟前」；
  新增 4 个命令（单题刷新 / 全量刷新 / 缓存状态 / 清理缓存）；
  新增 `oj.offline` context key（离线时全量刷新按钮置灰）。

**关键决策**

1. **缓存只存原始信息**（用户确认）。派生数据是「解析结果」，随时可从原始 HTML 重算，
   落盘只会带来口径不一致与脏数据。消费者（MCP / AI / 本地测试脚本）要结构化数据时，
   走 parser/api 按需产出。
2. **列表缓存优先，状态网络优先**。列表体积小、变化慢 → 缓存优先；
   提交状态要求实时性 → 网络优先、失败才降级到缓存（并在 UI 标注「离线缓存」）。
3. **静默降级只适用于被动重访**（C10）。用户显式点击的刷新失败**必须报错**，
   不能让一次手动操作悄无声息地什么都没发生。
4. **图片本地化只在 `<img>` 标签内替换 `src`**。初版对整段 HTML 做字符串替换，
   会把共用同一 URL 的 `<a href>` 一起改掉 —— 由 `test/localize.test.js` 用例 [9] 锁定。

**测试策略**

7 个套件 / 281 项断言，全部脱离 VS Code 运行时（`vscode` 模块桩 + 本地 HTTP 服务器）。
另新增 `scripts/smoke-site.js`（`npm run smoke:site`），对真实站点跑完整链路：
拉取 → 解析 → 原始落盘 → 回读 → 图片本地化 → 离线降级 → 清理。

---

## S5 — 比赛项目初始化（2026-09-13）

**动机**：用户要的是 **LeetCode 式流程**（点开题目 → 自动切到源文件 → 左代码右题目）
与一键本地测试，二者都**隐含假设磁盘上有文件**。所以初始化不是可选优化，是它们的地基。

**做了什么**（计划与 20 条决策见 `docs/PLAN_S5.md`）

- **S5.0 布局 v2**：比赛项目文件夹从 `.vsoj/contests/` 移到**工作区可见根**
  （`<工作区>/<cid>-<标题>/`），题目目录改为 `<题号字母>-<标题>/`；
  列表缓存迁到 `.vsoj/lists/`；新增 `tempDir` / `mainSource` / `contestRawDir`，
  去掉 `codeDir`；`LAYOUT_VERSION = 2`。
- **S5.1 初始化模块** `src/workspace/initializer.ts`：`ensureProblem` / `initializeContest`。
  幂等、增量、串行、可取消、单题失败不中断；`main.cpp` 写最小 C++ 骨架且**已存在绝不覆盖**。
- **S5.2 工作区守卫** `src/workspace/guard.ts`：纯决策层，把「有没有工作区」换算成能力矩阵
  （能否用缓存 / 能否写盘 / 能否分栏 / 能否提交 / 条目是否出现），已穷举单测。
- **S5.3 侧边栏条目**：题目列表顶部出现「初始化比赛项目」（类 git init），
  整条可点 + 行内「初始化 / 暂不」；无工作区时显示占位项（整条可点 → 打开文件夹）。
- **S5.4 懒初始化 + 分栏**：`oj.showProblem` 读事实 → 守卫结论 → 落盘该题 →
  左栏开 `main.cpp`、右栏开题目面板（复用已有，不重建）。
- **S5.5 配置与清理**：新增 `oj.project.*` 四项；清理缓存删 `raw/` `assets/` `samples/` `temp/`，
  保留 `main.cpp` / `test/` / `meta.json`。
- **S5.6 冒烟扩展**：`npm run smoke:site` 改为驱动**真实的** `initializer` + `buildInitDeps`，
  覆盖懒初始化 / 全量初始化 / 离线重进 / 清理后源码仍在，断言 41 → 84 项。

**关键决策（用户拍板，共 20 条）**

1. **两条路，一个入口**：懒初始化单题（默认）+ 侧边栏条目全量预取，共用 `ensureProblem()`。
   不做「必须先全量初始化」的硬门槛 —— 那会破坏 LeetCode 的即时感。
2. **增量补齐，不判断新鲜度**。初始化只问「有没有」，新不新交给 S4 的重访刷新。
   两套机制不共用触发路径，避免互相打架。
3. **先登记目录名再写文件**。否则 `raw/` 会落在数字 pid 目录下，等标题拿到后改名就成孤儿。
4. **无工作区只降级，不封死**。仍可只读看题（题面渲染本就不依赖磁盘），
   但不写盘、不用缓存、不分栏，并在提交时明确阻止（`decideSubmit`）。
5. **`readOnly` 拆成 `noCache`**。初版把「无工作区不用缓存」与「懒初始化关闭不写盘」
   塞进同一个字段，导致关掉懒初始化时连 `.vsoj` 缓存也一并关掉了 —— 两者不是一回事。
6. **提交闸门只拦「没有工作区」**。C13 明确要求提交行为不变，
   所以不去校验「编辑器里的是不是 main.cpp」—— 那是借守卫之名改既有行为。

**测试策略**

12 个套件 / 520 项断言，全部脱离 VS Code 运行时。S5 新增 4 个套件：
`init`（83）、`workspace-guard`（65）、`project-tree`（35）、`open-source`（11），
外加 `config-consistency`（11：声明的配置项/命令/菜单必须真的被代码消费，防死配置）。

---

## S5.8 — 页面固定亮色主题（2026-09-13）

**用户要求**：*"页面保持亮色主题"*。

**做了什么**

扩展自绘的 **6 个源文件 / 7 个内联页面**（题目详情、加载中、加载失败、登录、
账号设置、提交、状态页加载失败）全部**去掉对编辑器配色的依赖**：

- 删除全部 `var(--vscode-*)` 主题变量（这是唯一会让页面跟着 VS Code 变黑的东西）；
- 每个页面加 `html { color-scheme: light }`，否则深色主题下原生控件
  （`<select>` 下拉、checkbox、滚动条、日期选择器）会渲染成深色，与白底页面割裂；
- 题目页的 `body` 显式写死 `background:#fff; color:#333`，信息栏与「刷新」按钮
  的边框/底色也一并写死（原先这几个位置正好是主题变量最集中的地方）。

**没动的地方（判断依据）**

站点自己的页面（`status.php` 走 webview 代理渲染）**不注入任何样式**：
抓了真实页面确认它加载 Bootstrap 3 的 `bootstrap.min.css`，其中
`body{color:#333;background-color:#fff}` 是站点自己写死的，本来就是亮色。
凭空注入反而会盖掉站点配色。

**测试策略**

新增 `test/theme.test.js`（10 项断言），三层防回归：

1. **运行时产物**：真调 `ProblemService.buildProblemHtml`，断言含 `color-scheme: light`、
   不含 `--vscode-`、`body` 是白底深字、信息栏区域另有固定配色；
2. **源码扫描**：`src/**/*.ts` 里任何文件出现 `--vscode-` 即失败；
3. **页面清点**：含 `<!DOCTYPE html>` 的文件数 × 内联页面数，必须与 `color-scheme` 数量
   一一对应、且都指定了白底 —— 防止以后新加页面漏掉。

选这三条而不是只看截图：主题类回归**在浅色主题下肉眼完全看不出来**，
只有在用户切到深色主题时才暴露。

---

## S6.5 — 配置说明书与 AI 初始化工具（2026-09-14）

**起因**：用户的判断是 **「这个肯定不能是人来配了」**。工具链路径、`baseUrl` 这些
散在三个地方（`package.json` 声明、`toolchains.json` 文件格式、只有读代码才知道的语义差别），
让用户去设置面板里逐个翻既不现实，也解释不了「`cache.ttlSeconds` 和 `cache.staleSeconds`
谁管谁」这类问题。于是改成：**说明书给 AI 读，配置由 AI 探测后自己写进去**。

**做了什么**

1. **单一真相源** `src/config/manual.ts`
   - 结构（键名 / 类型 / 默认值 / 枚举）**运行时**从 `package.json` 的
     `contributes.configuration` 读取 → 加配置项自动进说明书，不可能漏；
   - 语义（用途 / 取值 / 示例 / 坑 / 是否必需 / 对应 getter）写在同一文件的 `CONFIG_SEMANTICS`；
   - `renderManual()` 同时供 MCP 工具与 `docs/CONFIG.md` 使用，两边内容必定一致。
2. **两个 MCP 工具**
   - `get_config_manual`：读说明书。`section` 可只取一节（`quickstart` / `settings` /
     `toolchains` / `files` / `pitfalls`），`format: json` 给机器可读版省 token。
   - `init_config`：写配置。**默认只预览**，`apply: true` 才落盘；
     计划有 error 时拒绝落盘；覆盖 `toolchains.json` 前自动备份。
3. **写配置的决策层纯函数化** `src/config/writer.ts`
   - `planConfigWrite()` 不碰磁盘、不依赖 VS Code → 「AI 给错了会怎样」能在纯 Node 里测；
   - 落盘副作用全部经 `ConfigWriteIo` 注入。
4. **`docs/CONFIG.md`**（`npm run docs:config` 生成）随插件发布 —— `docs/` 不在 `.vscodeignore` 里。

**修掉的两个既有缺陷**

1. **部分覆盖根本不被接受**：`normalizeDef` 要求 `run` / `extensions` 必填，
   而 `parseToolchains` 直接校验原始条目 —— 于是「只改一下 g++ 路径」
   （`{"id":"cpp-g++","commands":{"gpp":["…"]}}`）会被当成坏条目**丢掉**。
   这是最自然的写法，也是 AI 最可能给出来的形态。现在按内置定义补全后再校验；
   非内置 `id` 仍要求完整定义。写回文件时也只写覆盖字段，内置模板以后改进能自动继承。
2. **`config-consistency` 的检查被说明书削弱**：它判断「配置项有没有人读」靠
   「键名字符串在源码里出现过」，而说明书里每个键都作为引号键名出现 → 会对所有项假通过。
   现已把 `manual.ts` 从扫描里排除（**说明书不是消费方**）。

**顺带抓出两个死配置**（说明书如实标 `unused`，README 也点名）

| 配置项 | 情况 |
|---|---|
| `oj.defaultLanguage` | `getDefaultLanguage()` 全项目零调用方 |
| `oj.autoRefreshStatus` | 自动刷新实由命令 `oj.toggleStatusAutoRefresh` 的内存标志控制，与该设置无关 |

> 抓法是新加的一致性断言：数「读取函数的调用次数」，只有定义没有调用方的判为未生效。
> 原有检查只在源码里找键名字符串，抓不到「有 getter 但没人用」——两者互补。

**验证**：`npm test` → 21 套件全通过。其中 `test/config-tools.test.js` 走的是 MCP 真实入口
（`McpToolHandler`），用临时工作区里的**真文件**做 `settings.json` / `toolchains.json` 读写，
再用真实 loader（`effectiveToolchains`）读回确认覆盖生效 —— 也就是端到端验证了
「AI 读说明书 → 探测本机 → `init_config` → 配置真的生效」这条链路。

**经验**
- 「不会过期的文档」只能靠**生成 + 断言**：结构从声明生成，语义由双向核对兜底，
  渲染产物再由漂移断言钉死。三者缺一，文档迟早和代码说两样话。
- **给 AI 用的工具，报错信息就是产品本身**：键名打错要给「是不是想写 X」、
  命令解析失败要列「探测过哪些位置」，否则 AI 只能靠猜。
- **自动纠正必须留痕**：省前缀、大小写能自动修，但要出提示 ——
  静默纠正会让 AI 以为自己写对了，这个错下次还会犯。

---

## 比赛目录初始化：现状与缺口（S5 开工前评审 · 已全部闭环）

> 本节是 S5 开工前的评审记录，**保留作为决策依据**。
> 表中最后一条「样例未落盘」已由 S5.1 的 `ensureProblem` 接上（`writeSamples` 有了调用方）。

**已落地（属于 S1，不是 S5）**

- `src/cache/paths.ts` 是路径的**唯一来源**，布局已定稿并被 29 项断言锁定。
- `CacheStore.ensureContestDir(cid, title)`：建 `<cid>-<slug>` 目录、写 `meta.json`、
  建 `assets/`、登记索引；幂等，且目录名一旦定稿不再变化。
- 领域写入口：`writeProblemList` / `writeProblem` / `writeSample` / `writeStatus`
  —— 这些是**被动的按需写盘**，谁调用谁触发。

**未落地（S5 本体的工作）**

- 没有任何 `src/workspace/initializer.ts`；
- 没有「进入比赛即自动初始化」的触发点。注：S4 已把缓存接进运行期链路
  （列表缓存优先、题目页缓存优先 + 后台刷新），所以缓存**不再是空转**；
  但「一进比赛就把整个比赛铺到本地」这件事仍无人做；
- 样例数据集**不会自动落盘**，`writeSamples` 至今无调用方。

**已识别缺口的最终状态（S4 收尾后复核）**

> 初版这里的三条结论有两条是**基于假设**写的，已用实测推翻（见 `docs/PLAN_S4.md` §2）。
> 下表更新为 S4 完成后的实际状态。

| 缺口 | 实测结论 | S4 后状态 |
|---|---|---|
| ~~多样例缺失~~ | **不成立**。`cid=3772`/`3775` 共 40 个 pid 位置、24 个有效题目页，**24/24 均为单组样例** | 无缺口。布局保留 `1.in/2.in` 仅为前瞻，**不需要**多样例解析 |
| 图片未落盘 | 题面图为相对路径，约 **4%** 的题带图（24 道中 1 道） | ✅ **已修**。`writeProblemAsset/readProblemAsset` 已落地，由 `media/localize.ts` 在题目页渲染时调用 |
| `test/` 目录未纳入 `ContestPaths` | 静态方法，调用方需自行拼路径 | ✅ **已修**。`ContestPaths.testDir/testResult/testReport` 已收进路径唯一来源 |
| 「提示」小节被丢弃 | 24 道有效题中 4 道含 `<h4>提示</h4>` | ✅ **已修**。`ProblemDetail.hint` + parser 解析 + 题目页渲染 + markdown 导出 |
| **样例未落盘** | `store.writeSamples` **至今无调用方** | ❌ **仍是缺口**，正是 S5 初始化要接的第一条线 |

**S5 剩余工作（评审时列出 · 均已完成）**

> 下面四条的落地情况见上面的 S5 章节。其中「在 `oj.enterContest` 挂触发点」一条
> 最终**没有采纳** —— 用户拍板改为「懒初始化单题 + 侧边栏条目全量预取」（D13），
> 进入比赛不再自动铺全量。

- 新增 `src/workspace/initializer.ts`：建目录、逐题拉原始题面、
  **把 `sampleInput/sampleOutput` 落成 `samples/1.in` / `1.out`**（接上 `writeSamples`）、
  拉取题面图片到 `assets/`、回填 `meta.json`。幂等 / 增量。→ ✅ S5.1
- ~~在 `oj.enterContest` 挂触发点~~ → 改为懒初始化（D13/D14）
- 触发时机、派生文件边界、预取深度、重复进入行为 → ✅ 20 条决策全部经用户拍板
- 注：`test/result.json` / `report.md` 属 S6 本地测试的产物，S5 只负责把目录空出来。

---

## 待办（后续阶段）

优先级与依赖见 `docs/ARCHITECTURE.md` §4。**S4、S5 已闭环**，当前推进 S6：

- ✅ **S4 运行期缓存刷新与离线预览** —— 已完成并提交（`ffcf7f9` → `8f822e7` →
  `1e533e1` → `8a52ac0` → `49e9cf8`），计划见 `docs/PLAN_S4.md`。
- ✅ **S5 比赛项目初始化** —— 已完成并提交（`302c29f` → `8befccd` → `97cf269` →
  `9781b28` → `888d4a2` → `46acba7` → `af58e80`），计划见 `docs/PLAN_S5.md`
  （**20 条决策全部经用户拍板**、S5.0–S5.7 阶段切分、15 条行为契约）。
  核心形态：**懒初始化单题（默认）+ 侧边栏条目全量预取**，共用同一个 `ensureProblem()`；
  比赛目录建在 **workspace 可见根**（`<cid>-<标题>/`），题目目录用 `<字母>-<标题>/`。
- 🔄 **S6 本地测试引擎 + MCP 扩展** —— 进行中。已完成 S6.0–S6.5：
  - ✅ 引擎与工具链：`prepare` / `run` / `compare` 三步 + 三闸看门狗（`src/test/`）
  - ✅ 接线层 + 自定义任务（`oj` 类型）：编译 / 本地测试 / 强制重编译 / **跑一下**
  - ✅ 配置说明书与 AI 初始化：MCP `get_config_manual` / `init_config` + `docs/CONFIG.md`
  - ⏳ 待做：**S6.6 结果页 webview**（两级、亮色）、**S6.7 MCP 三工具**
    （编译 / 本地测试 / 读最近结果 + 读题目图片）、**S6.8 工具链编辑页 +
    macOS 内存探测回退 + 文档收口**
  - MCP 工具现状：共 **5 个**（`get_config_manual` / `init_config` /
    `get_contest_problems` / `get_current_problem` / `get_contest_list`）。
- **注意：两个配置项当前不生效** —— `oj.defaultLanguage` 与 `oj.autoRefreshStatus`
  声明了但没有代码消费（详见 `docs/CONFIG.md` 的「声明了但当前版本没生效」）。
  要么接上，要么从声明里摘掉，别让它继续误导。
- **S3 静态资源层** —— 把登录/提交页从 TS 字符串外置到 `media/`，用 `asWebviewUri` 加载。
  **经复核：尚未落地**（无 `media/` 目录，`asWebviewUri` 零引用）。
- **S7 状态页静态化** —— 替换 `statusPanel` 中代理渲染 OJ 原生 `status.php` 的做法。

## 未验证项（需要账号才能确认）

- 已登录时 `submit.php` 失败（验证码错 / 重复提交）的真实响应形态。
- 会话在多次 `vcode.php` 请求下的准确超时秒数。

> 这两项不影响现有实现：当前判定以「HTTP 5xx + 空体」「落点为登录页」这些
> **结构性主信号**为准，字符串信号仅作辅助，且判定集中在 `session/guard.ts` 单点，
> 便于拿到实测结果后收紧。
