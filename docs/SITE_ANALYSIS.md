# 目标站点机制分析 — http://acm.hnust.edu.cn

> 分析时间：2026-09-13 ｜ 方法：无登录态被动探测 + 页面结构解析（未使用任何账号做写操作）
> 结论精度标注：✅ 实测确认 ｜ ⚠️ 推断（需登录态进一步验证）

## 1. 平台识别

| 项 | 值 |
|---|---|
| Web 服务器 | nginx/1.10.3 (Ubuntu) |
| 应用框架 | **HUSTOJ**（页面 footer 明示 `GPLv2 licensed by HUSTOJ`，日志亦提示 `db_info.inc.php` / `$OJ_TEMPLATE`） |
| 模板 | `template/bs3/`（Bootstrap 3，green 主题） |
| 前端依赖 | jQuery、`include/md5-min.js`、`include/jquery.flot.js`、katex/mathjax |
| 编码 | UTF-8 |

HUSTOJ 是单入口 PHP 多脚本架构，**没有 REST API**，所有数据都靠「请求 PHP 页面 → 解析 HTML」获得。这是本插件全部 API 层只做 HTML 解析的根本原因。

## 2. 端点清单（实测）

| 端点 | 方法 | 匿名访问 | 说明 |
|---|---|---|---|
| `/` `/index.php` | GET | 200, 9.7KB | 首页 |
| `/loginpage.php` | GET | 200, 10.4KB | 登录页（表单 + 验证码 + CSRF 挂载点） |
| `/login.php` | POST | — | 登录提交 |
| `/logout.php` | GET | — | 登出 |
| `/csrf.php` | GET | 200, **85B** | 返回 `<input type="hidden" name="csrf" value="XXX" class="1">` |
| `/vcode.php?<rand>` | GET | 200, **image/gif**, ~509B | 验证码图片 |
| `/contest.php` | GET | 200 | 比赛列表（`?cid=` 时为该比赛的题目列表）；**需登录** |
| `/problem.php?cid=&pid=` | GET | **200** ⚠️关键 | 题目详情；公开比赛**免登录渲染**，私有比赛返回 `Not Invited!` |
| `/submit.php` | POST | **500** ⚠️关键 | 提交入口；未登录 / 会话失效时返回 **HTTP 500 空响应体** |
| `/status.php` | GET | 200 | 提交状态列表，匿名亦可见 |
| `/problemset.php` `/ranklist.php` `/contest_reg.php` | GET | — | 题库 / 排行榜 / 竞赛列表 |
| `/modifypage.php` | GET | — | 个人信息页（用于解析学号） |
| `/submitpage.php` | GET | — | 提交页（HUSTOJ 标准入口） |

## 3. 验证码机制（重点）

### 3.1 触发与刷新

```html
<img id="vcode-img" onclick="this.src='vcode.php?'+Math.random()" height="30px">
```

```js
$(document).ready(function () {
  $("#vcode-img").attr("src", "vcode.php?" + Math.random());
});
```

- 验证码是**服务端会话绑定**的：`vcode.php` 把明文答案写入 `$_SESSION['vcode']`，再输出 GIF。
- `?Math.random()` 纯粹是**打破浏览器缓存**，不参与服务端逻辑。✅
- 因此**每次请求 `vcode.php` 都会重写 `$_SESSION['vcode']`** → 同一个会话里只有「最后一次请求」的验证码有效。

### 3.2 会话绑定（实测）

```
1) 无 Cookie 访问 loginpage.php → Set-Cookie: PHPSESSID=h2sb...
2) 携带该 Cookie 访问 vcode.php → 无 Set-Cookie（会话复用）
3) 再携带该 Cookie 访问 vcode.php → 无 Set-Cookie（会话复用）
```

结论：
- 服务器**仅在客户端无 Cookie 时下发 `PHPSESSID`**；已有会话不会被轮换。
- `PHPSESSID` 是**唯一的身份凭证**，`path=/`，无 `Expires`（浏览器会话 Cookie）。
- 验证码 → 登录 → 提交 **必须共用同一个 `PHPSESSID`**，否则验证码校验必然失败。这正是插件 `client.ts` 里 `cookieStore` 简单 Map + `lockCookies()` 设计的原因。

### 3.3 验证码的消费语义

PostgreSQL/MySQL 后端不落盘验证码，答案只在 `$_SESSION`；校验后通常立即 `unset($_SESSION['vcode'])`。
⇒ **验证码一次性**：登录失败或提交失败后必须重新拉取，插件现有 `loadVcode()` 在失败分支重取是正确行为。✅

## 4. CSRF 机制

- 登录页 / 提交页不内联 token，而是异步加载：

```js
$("form").append("<div id='csrf' />");
$("#csrf").load("csrf.php");
```

- `csrf.php` 返回的是一段带 `name="csrf"` 的 hidden input（85 字节）。插件 `fetchCsrfToken()` 用 cheerio 取 `input[name=csrf]` 的 `value` —— 与站点实现完全对齐。✅
- Token 与会话绑定，插件做了 60s 缓存，安全窗口合理。✅

## 5. 登录态边界（本次分析最关键的发现）

| 页面 | 未登录 / 会话失效时的行为 |
|---|---|
| `problem.php`（公开比赛，如 cid=3772 / 3775） | **HTTP 200，完整渲染题目与样例** — 完全不校验登录 |
| `problem.php`（私有比赛，如 cid=3762–3771） | HTTP 200，正文位置输出 `Not Invited!` |
| `problem.php`（不存在） | HTTP 200，正文位置输出 `No such Contest!` |
| `contest.php?cid=`（私有） | HTTP 200，正文输出 `不能查看题目` / `尚未开始` |
| `status.php` | HTTP 200，匿名可见 |
| `submit.php` | **HTTP 500，响应体为空（0 字节）** |

### 5.1 实测证据

```
problem.php?cid=3772&pid=0  → HTTP 200, 含 sampleinput      ← 公开比赛，免登录可读
problem.php?cid=3762&pid=0  → HTTP 200, 正文 "Not Invited!"  ← 私有比赛，未登录被挡
contest.php?cid=3777        → HTTP 200, 正文 "不能查看题目" "尚未开始"
submit.php (匿名 POST)      → HTTP 500, size 0
submit.php (GET)            → HTTP 500, size 0
```

### 5.2 对插件行为的直接推论

用户反馈的现象 **「题目提交页依然可以正常进入，但是无法正常提交」** 根因确认为：

1. `problem.php`（公开比赛）**不校验登录**，所以登录过期后题目照常打开；
2. `problem.php` / `problem.php` 的题目内容可以被**缓存**，即使不缓存也能重新拉；
3. 但 `submit.php` 一旦会话失效就返回 **HTTP 500 空体**，插件 `SubmitService.submit()` 的判定是：

```ts
validateStatus: (status) => status < 500      // client.ts — 500 直接走 error 分支
if (response.status === 200 || response.status === 302) return { success: true }
```

⇒ 现有代码**能感知失败**（axios 抛错 → 弹「提交失败: Request failed with status code 500」），但：
- **无法区分**「登录失效」与「OJ 服务器故障 / 比赛未开始」；
- **不会** 引导重新登录；
- **不会** 在登录成功后回到原来的比赛与题目并**自动重新发起提交**。

这正是本次要补的第一个缺口。

## 6. 会话生命周期与保活

- PHP 侧会话超时取决于 `session.gc_maxlifetime`（HUSTOJ 系默认 1440s = 24 分钟**空闲**）。
- 判定依据是**会话文件 mtime**，任何**携带该 `PHPSESSID` 的请求**都会刷新 mtime。
- ⇒ **定时访问任意页面即可续期**，无需登录态写入。这就是「通过定时访问页面避免 cookie 过期」的可行依据。✅

保活请求选型建议（成本从低到高）：

| 候选 | 体积 | 是否刷 mtime | 备注 |
|---|---|---|---|
| `/csrf.php` | 85 B | ✅ | **推荐**：极小、无副作用、不做任何状态变更 |
| `/loginpage.php` | 10.4 KB | ✅ | 兼作登录态探测（含 `logout.php` 标记） |
| `/status.php` | 25 KB | ✅ | 体积大，不推荐用于心跳 |

⇒ 心跳用 `/csrf.php`，**登录态探测用 `/loginpage.php` 是否含 `logout.php`**（与现有 `AuthService.isLoggedIn()` 一致，无需改判定口径）。

## 7. 未验证 / 待补充（需登录态）

- ⚠️ 已登录时 `submit.php` 失败（验证码错 / 比赛未开始 / 重复提交）的响应体形态：是 HTTP 200 + alert，还是仍然 500。**这决定「提交结果解析」要不要做 HTML 判定**。
- ⚠️ `submit.php` 成功后是 302 跳转 `status.php` 还是 200 + JS 跳转。
- ⚠️ `$_SESSION` 在多次 `vcode.php` 请求下的准确超时秒数（建议登录后实测一次）。

> 上述三项不影响本阶段实现：本阶段的失效判定以「HTTP 500 / 空体 / 无 logout.php 标记 / `Not Invited!`」这四类**确定性信号**为准，并保留后续按登录态响应体扩展解析的接口。
