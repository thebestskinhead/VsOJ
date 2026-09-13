# 项目进展与决策记录

> 本文件是项目的**长期记忆**：记录每个阶段做了什么、验证到什么程度、以及为什么这么做。
> 面向后续接手的人（或 AI）。架构与路线见 `docs/ARCHITECTURE.md`，站点机制见 `docs/SITE_ANALYSIS.md`。

## 里程碑

| 阶段 | 日期 | 内容 | 验证 |
|---|---|---|---|
| S0 | 2026-09-13 | 站点机制分析、架构分层与演进路线 | 被动探测实测（无登录态写操作） |
| S1 | 2026-09-13 | 本地缓存层骨架 | `npm run test:cache` 29 项断言 |
| S2 | 2026-09-13 | 会话保活 + 登录失效自愈 | `npm run test:session` 71 项断言 |

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

## 比赛目录初始化：现状与缺口（S5 前置评审）

> 本节用于澄清「比赛目录初始化」到底落到什么程度，避免把「路径布局已定稿」
> 误当成「初始化已实现」。

**已落地（属于 S1，不是 S5）**

- `src/cache/paths.ts` 是路径的**唯一来源**，布局已定稿并被 29 项断言锁定。
- `CacheStore.ensureContestDir(cid, title)`：建 `<cid>-<slug>` 目录、写 `meta.json`、
  建 `assets/`、登记索引；幂等，且目录名一旦定稿不再变化。
- 领域写入口：`writeProblemList` / `writeProblem` / `writeSample` / `writeStatus`
  —— 这些是**被动的按需写盘**，谁调用谁触发。

**未落地（S5 本体的工作）**

- 没有任何 `src/workspace/initializer.ts`；
- 没有任何「进入比赛即自动初始化」的触发点（`contestTree` / `problemTree` 走的是
  原有网络路径，S4 未做，所以缓存目前基本是空转）；
- 样例数据集**不会自动落盘**，`writeSample` 至今无调用方。

**已识别的缺口（含实测修正）**

> 初版这里的三条结论有两条是**基于假设**写的，已用实测推翻。修正后的口径与数据见
> `docs/PLAN_S4.md` §2。

| 缺口 | 实测结论 | 影响 |
|---|---|---|
| ~~多样例缺失~~ | **不成立**。扫描 `cid=3772`/`3775` 共 40 个 pid 位置、其中 24 个是有效题目页，**24/24 均为单组样例**（`#sampleinput` / `#sampleoutput` 各一） | 无。布局保留 `1.in/2.in` 仅为前瞻，本轮**不需要**多样例解析 |
| 图片未落盘 | **成立，但成因与初版描述不同**。题面图是相对路径 `/JudgeOnline/upload/image/…png`，现有 `inlineImages()` 正则**能正常命中**，且调用点只作用于 `description`/`inputDesc`/`outputDesc`，页脚脚本里的二维码不会被误抓（实测那 4 个 `<img>` 全在 `<script>` 内且为绝对 URL）。真正缺的是**已抓到的 Buffer 没落盘、也没有结构化字段** | MCP 拿不到图片本地路径。另：题面带图**仅约 4%**（24 道有效题中 1 道，`cid=3775&pid=16`） |
| `test/` 目录未纳入 `ContestPaths` | 成立。`CachePaths.resultJson/reportMd` 是静态方法，调用方需自行拼 `problemDir(pid)` | 与「路径只在 `paths.ts` 拼接」的约定有缝隙，S6 前应收进 `ContestPaths` |
| 「提示」小节被丢弃 | **新发现**。24 道有效题中有 4 道含 `<h4>提示</h4>` 小节，而 `ProblemDetail` 没有对应字段 | 题面信息丢失 |

**结论**：目录布局对缓存自身够用（题目 / 状态 / 列表都有落点），但对**本地测试与 MCP**
尚缺三项（样例落盘、`test/` 出口、图片资产），且都是 S6 的前置，不是可选优化。
执行顺序与取舍见 `docs/PLAN_S4.md` §8。

---

## 待办（后续阶段）

优先级与依赖见 `docs/ARCHITECTURE.md` §4。当前执行中：

- **S4 运行期缓存刷新与离线预览** —— 已细化为 `docs/PLAN_S4.md`（含 10 条已确认的行为契约、
  S4.1–S4.6 阶段切分、测试策略）。范围：重访自动刷新、单题强制刷新、全量强制刷新、
  题目页过期可见性。
- **S3 静态资源层** —— 把登录/提交页从 TS 字符串外置到 `media/`，用 `asWebviewUri` 加载。
- **S5 比赛目录初始化** —— 进入比赛自动建目录、写 `problem.md`、落样例数据集。
  **与 S4 在语义上解耦**：初始化是阶段性的"建立工作区"动作，运行期刷新是"保持数据新鲜"，
  两者不共用触发路径，S4 不引入任何"进入比赛即触发"的代码。
- **S6 本地测试引擎 + MCP 扩展** —— 题目图片返回、样例识别、以 exe 为输入的一键本地测试，
  并支持通过 `.vscode/tasks.json` 接入编辑器流水线。
- **S7 状态页静态化** —— 替换 `statusPanel` 中代理渲染 OJ 原生 `status.php` 的做法。

## 未验证项（需要账号才能确认）

- 已登录时 `submit.php` 失败（验证码错 / 重复提交）的真实响应形态。
- 会话在多次 `vcode.php` 请求下的准确超时秒数。

> 这两项不影响现有实现：当前判定以「HTTP 5xx + 空体」「落点为登录页」这些
> **结构性主信号**为准，字符串信号仅作辅助，且判定集中在 `session/guard.ts` 单点，
> 便于拿到实测结果后收紧。
