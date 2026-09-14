// 提交结果页 —— 亮色主题 + 「不刷新页面」的就地轮询
// 运行：node test/status-webview.test.js
//
// 为什么值得测：
//   1) 这个页面是**唯一开了脚本**的自绘页面（就地更新必须有人在客户端改 DOM），
//      注入内容一律得转义 —— 站点来的结果名 / 编译器原文都属不可信内容；
//   2) 「自动刷新但不重载页面」这条要求很容易被写回成 `webview.html = ...`：
//      那样功能看着正常（状态确实变了），却把滚动位置和展开的详情全丢了。
//      所以这里直接断言「首屏之后 html 只被赋值过一次」，把这条钉死。
const { installVscodeStub, makeChecker, sleep } = require('./helpers/stub');

const env = installVscodeStub();

const { parseStatusAjaxRow, parseJudgementPre, parseStatusTable } = require('../out/utils/parser.js');
const { ProblemService } = require('../out/api/problem.js');
const {
  buildStatusModel, buildStatusHtml, buildStatusErrorHtml,
  rowsHtml, numbersHtml, detailHtml, autoBadge,
  pendingQueue, nextPendingRow, rowUpdatePayload, toRowView, summarize,
  isPending, toneOf, detailKindOf, resultNameOf,
  STATUS_PENDING_MAX, MAX_POLL_INTERVAL_MS,
  StatusWebview,
} = require('../out/webview/statusWebview.js');

const { check, ok, done } = makeChecker();

// ─────────────────────────────────────────────────────────────
// 0. 测试脚手架
// ─────────────────────────────────────────────────────────────

/** 一条解析层的记录（默认：AC） */
function rec(over = {}) {
  return {
    submitId: 4591960,
    userId: '2505050318',
    userHref: '',
    probName: 'W',
    probHref: 'problem.php?cid=3775&pid=22',
    problemId: 'W',
    resultCode: 4,
    resultName: '正确',
    resultClass: 'status-ac',
    resultHref: '',
    memory: 2228,
    time: 55,
    language: 'C++',
    sourceHref: '',
    codeLen: '8446 B',
    submitTime: '2026-09-14 10:08:51',
    ...over,
  };
}

/** 能记住 html 赋值与 postMessage 的面板假件 */
function makeFakePanel() {
  const rec0 = { html: [], messages: [], reveals: 0, disposed: false };
  const webview = {
    postMessage: (m) => { rec0.messages.push(m); },
    onDidReceiveMessage: (h) => { rec0.messageHandler = h; },
  };
  Object.defineProperty(webview, 'html', {
    get: () => rec0.html[rec0.html.length - 1] ?? '',
    set: (v) => { rec0.html.push(v); },
  });
  const panel = {
    title: '',
    webview,
    reveal: () => { rec0.reveals += 1; },
    dispose: () => { rec0.disposed = true; if (rec0.disposeHandler) { rec0.disposeHandler(); } },
    onDidDispose: (h) => { rec0.disposeHandler = h; },
  };
  return { panel, log: rec0 };
}

/** 装一个只返回 `fake` 的 createWebviewPanel */
function useFakePanel() {
  const fake = makeFakePanel();
  env.vscode.window.createWebviewPanel = () => fake.panel;
  return fake;
}

/**
 * status.php 表格夹具 —— 按线上页面的原样结构手抄（只留与解析有关的属性）。
 *
 * 刻意覆盖站点特有的三种写法：
 *   1) 还没判完的行：`<span class="hidden" result="0">`，结果格里没有链接；
 *   2) 比赛里「已被更早的提交通过」的行：`*正确` + 一个原始 sid 标签；
 *   3) 出结果的行：结果格是一个 `label label-*` 链接，指向 `reinfo.php` / `ceinfo.php`。
 */
const STATUS_PAGE_FIXTURE = `<html><body>
<table id=result-tab class="table table-striped content-box-header">
<thead><tr class='toprow'><th >提交编号<th >用户<th >问题<th >结果<th >内存(KB)<th >耗时(MS)<th >语言<th >代码长度<th >提交时间<th >判题机</tr></thead>
<tbody>
<tr class='evenrow'><td>4591960</td><td><a href="contestrank.php?cid=3775&amp;user_id=2505050318#2505050318">2505050318</a></td><td><div class=center><a href="problem.php?cid=3775&amp;pid=22">W</div></a></td><td><span class="hidden" style="display:none" result="0"></span><span class='label gray'>等待</span></td><td class='hidden-xs'><div id=center class=red>0</div></td><td class='hidden-xs'><div id=center class=red>0</div></td><td class='hidden-xs'><a target="_blank" href="showsource.php?id=4591960">C++</a></td><td class='hidden-xs'>8446 B</td><td>2026-09-14 10:08:51</td><td class='hidden-xs'>Judger1</td></tr>
<tr class='oddrow'><td>4590028</td><td><a href="contestrank.php?cid=3775&amp;user_id=2505050318#2505050318">2505050318</a></td><td><div class=center><a href="problem.php?cid=3775&amp;pid=19">T</div></a></td><td><span class="hidden" style="display:none" result="4"></span><span class='label label-success' title='答案正确，请再接再厉。'>*正确</span><span class='label label-info'>4585878</span></td><td class='hidden-xs'><div id=center class=red>2656</div></td><td class='hidden-xs'><div id=center class=red>16</div></td><td class='hidden-xs'><a target="_blank" href="showsource.php?id=4590028">C++</a></td><td class='hidden-xs'>1038 B</td><td>2026-09-13 21:52:52</td><td class='hidden-xs'>Judger1</td></tr>
<tr class='evenrow'><td>4589966</td><td><a href="contestrank.php?cid=3775&amp;user_id=2505050318#2505050318">2505050318</a></td><td><div class=center><a href="problem.php?cid=3775&amp;pid=19">T</div></a></td><td><span class="hidden" style="display:none" result="6"></span><a href="reinfo.php?sid=4589966" class="label label-danger" title="答案不对。">答案错误0</a></td><td class='hidden-xs'><div id=center class=red>2188</div></td><td class='hidden-xs'><div id=center class=red>0</div></td><td class='hidden-xs'><a target="_blank" href="showsource.php?id=4589966">C++</a></td><td class='hidden-xs'>1094 B</td><td>2026-09-13 20:30:55</td><td class='hidden-xs'>Judger1</td></tr>
<tr class='oddrow'><td>4589601</td><td><a href="contestrank.php?cid=3775&amp;user_id=2505050318#2505050318">2505050318</a></td><td><div class=center><a href="problem.php?cid=3775&amp;pid=22">W</div></a></td><td><span class="hidden" style="display:none" result="11"></span><a href="ceinfo.php?sid=4589601" class="label label-warning" title="编译错误">编译错误0</a></td><td class='hidden-xs'><div id=center class=red>0</div></td><td class='hidden-xs'><div id=center class=red>0</div></td><td class='hidden-xs'><a target="_blank" href="showsource.php?id=4589601">C++</a></td><td class='hidden-xs'>9569 B</td><td>2026-09-12 19:35:11</td><td class='hidden-xs'>Judger1</td></tr>
<tr class='evenrow'><td>4589604</td><td><a href="contestrank.php?cid=3775&amp;user_id=2505050318#2505050318">2505050318</a></td><td><div class=center><a href="problem.php?cid=3775&amp;pid=22">W</div></a></td><td><span class="hidden" style="display:none" result="9"></span><a href="reinfo.php?sid=4589604" class="label label-warning" title="输出超过限制">输出超限94</a></td><td class='hidden-xs'><div id=center class=red>2228</div></td><td class='hidden-xs'><div id=center class=red>34</div></td><td class='hidden-xs'><a target="_blank" href="showsource.php?id=4589604">C++</a></td><td class='hidden-xs'>9506 B</td><td>2026-09-12 19:38:00</td><td class='hidden-xs'>Judger1</td></tr>
<tr class='oddrow'><td>4589606</td><td><a href="contestrank.php?cid=3775&amp;user_id=2505050318#2505050318">2505050318</a></td><td><div class=center><a href="problem.php?cid=3775&amp;pid=22">W</div></a></td><td><span class="hidden" style="display:none" result="4"></span><a href="reinfo.php?sid=4589606" class="label label-success" title="答案正确，请再接再厉。">正确100</a></td><td class='hidden-xs'><div id=center class=red>2228</div></td><td class='hidden-xs'><div id=center class=red>40</div></td><td class='hidden-xs'><a target="_blank" href="showsource.php?id=4589606">C++</a></td><td class='hidden-xs'>9584 B</td><td>2026-09-12 19:42:07</td><td class='hidden-xs'>Judger1</td></tr>
</tbody></table>
</body></html>`;

// ─────────────────────────────────────────────────────────────
// 1. 结果语义映射
// ─────────────────────────────────────────────────────────────
console.log('[1] 结果码 → 待判定 / 配色 / 详情页');

check('待判定的上限', STATUS_PENDING_MAX, 4);
for (const c of [0, 1, 2, 3]) { ok(`结果码 ${c} 判为待判定`, isPending(c)); }
for (const c of [4, 6, 11]) { ok(`结果码 ${c} 已出结果`, !isPending(c)); }
ok('NaN 不算待判定（否则会无限轮询）', !isPending(NaN));
ok('-1 不算待判定', !isPending(-1));

check('AC 配色', toneOf(4), 'pass');
check('WA 配色', toneOf(6), 'fail');
check('PE 同 WA 走红', toneOf(5), 'fail');
check('CE 配色', toneOf(11), 'warn');
check('TLE 配色', toneOf(7), 'warn');
check('等待配色', toneOf(0), 'wait');
check('编译成功（12）落 muted', toneOf(12), 'muted');
check('未知结果码落 muted', toneOf(99), 'muted');

check('CE 走 ceinfo', detailKindOf(11), 'ceinfo');
check('WA 走 reinfo', detailKindOf(6), 'reinfo');
check('AC 也走 reinfo（有时间 / 内存表）', detailKindOf(4), 'reinfo');
check('待判定没有详情页', detailKindOf(3), null);
check('未知结果码没有详情页', detailKindOf(99), null);

check('结果名沿用站点文案', resultNameOf(6), '答案错误');
ok('未知结果码给得出名字', resultNameOf(99).includes('99'));

// ─────────────────────────────────────────────────────────────
// 2. status-ajax 解析（真响应）
// ─────────────────────────────────────────────────────────────
console.log('\n[2] status-ajax.php 响应解析');
check('AC 行', parseStatusAjaxRow('4,2228,55,Judger1,100'), {
  resultCode: 4, memory: 2228, time: 55, judger: 'Judger1', extra: '100',
});
check('CE 行（内存 / 耗时都是 0）', parseStatusAjaxRow('11,0,0,Judger1,0'), {
  resultCode: 11, memory: 0, time: 0, judger: 'Judger1', extra: '0',
});
check('末尾多一个换行也能解析', parseStatusAjaxRow('9,2228,34,Judger1,94\n'), {
  resultCode: 9, memory: 2228, time: 34, judger: 'Judger1', extra: '94',
});
check('带空格', parseStatusAjaxRow(' 0 , 0 , 0 ,  , '), {
  resultCode: 0, memory: 0, time: 0, judger: '', extra: '',
});
// 会话失效时这个地址会吐登录页 / 或 q=user_id 那种纯文本 —— 必须返回 null，
// 否则会把「登录页」当成「结果码 0」一路空转轮询下去
check('登录页 HTML → null', parseStatusAjaxRow('<!DOCTYPE html><html><body>login</body></html>'), null);
check('纯文本（q=user_id 形态）→ null', parseStatusAjaxRow('2505050318'), null);
check('空响应 → null', parseStatusAjaxRow(''), null);
check('两段逗号缺字段 → null', parseStatusAjaxRow('4,2228'), null);

// ─────────────────────────────────────────────────────────────
// 3. 判题详情解析（reinfo / ceinfo 的真片段）
// ─────────────────────────────────────────────────────────────
console.log('\n[3] 判题详情 <pre id=errtxt> 提取');
const WA_FIXTURE = `<html><body><div class="jumbotron">
<pre id='errtxt' class="alert alert-error">========[exp1.out]=========
Expected						      |	Yours
(1+(2+(3+4)))						      &lt;
</pre><div id='errexp'>Explain:</div></div></body></html>`;
const wa = parseJudgementPre(WA_FIXTURE);
ok('取到 WA 对照正文', wa && wa.includes('[exp1.out]'));
ok('实体被还原（&lt; → <）', wa.includes('<') && !wa.includes('&lt;'));
check('没有 errtxt 的页面 → null', parseJudgementPre('<html><body>no pre here</body></html>'), null);

const CE_FIXTURE = `<html><body><pre class="brush:c;" id='errtxt' >Main.cc:38:33: error: declaration of &lsquo;val&rsquo;
     vector&lt;pair&lt;kind,val&gt;&gt; val={};
</pre></body></html>`;
const ce = parseJudgementPre(CE_FIXTURE);
ok('取到编译器原文', ce.includes('Main.cc:38:33'));
ok('实体被还原', ce.includes('vector<pair<kind,val>>'));

// ─────────────────────────────────────────────────────────────
// 4. 页面模型
// ─────────────────────────────────────────────────────────────
console.log('\n[4] 模型组装：汇总 / 过滤标记 / 待判定');
const rows = [
  rec({ submitId: 3, resultCode: 3, problemId: 'W' }),
  rec({ submitId: 2, resultCode: 6, problemId: 'W' }),
  rec({ submitId: 1, resultCode: 11, problemId: 'T' }),
];
const model = buildStatusModel(rows, { cid: '3775', userId: '2505050318', filterPid: 'W', pollIntervalMs: 800 });
check('总数', model.summary.total, 3);
check('AC 计数', model.summary.ac, 0);
check('WA 计数', model.summary.wa, 1);
check('CE 计数', model.summary.ce, 1);
check('待判定计数', model.summary.pending, 1);
check('匹配当前题目的行数', model.records.filter(r => r.match).length, 2);
check('不过滤时全部匹配', buildStatusModel(rows, { cid: 'c', userId: 'u' }).records.every(r => r.match), true);
check('summarize 单测', summarize([toRowView(rec({ resultCode: 7 }), ''), toRowView(rec({ resultCode: 10 }), '')]),
  { total: 2, ac: 0, wa: 0, ce: 0, tle: 1, re: 1, pending: 0 });

// ─────────────────────────────────────────────────────────────
// 5. 轮询队列（对齐站点 auto_refresh 的自下而上取法）
// ─────────────────────────────────────────────────────────────
console.log('\n[5] 轮询队列');
const queueRows = [
  rec({ submitId: 30, resultCode: 0 }),   // 最新，等待（表格最上）
  rec({ submitId: 20, resultCode: 4 }),
  rec({ submitId: 10, resultCode: 2 }),   // 最旧，编译中（表格最下）
];
const qm = buildStatusModel(queueRows, { cid: 'c', userId: 'u' });
check('队列自下而上（与站点一致：先问最下面那条）', pendingQueue(qm).map(r => r.submitId), [10, 30]);
check('队首', nextPendingRow(qm).submitId, 10);
check('放弃过的会跳过', nextPendingRow(qm, new Set([10])).submitId, 30);
check('全部放弃 → null', nextPendingRow(qm, new Set([10, 30])), null);

const scoped = buildStatusModel(
  [rec({ submitId: 2, resultCode: 0, problemId: 'W' }), rec({ submitId: 1, resultCode: 0, problemId: 'T' })],
  { cid: 'c', userId: 'u', filterPid: 'W' },
);
check('只看本题时队列只含本题的提交', pendingQueue(scoped).map(r => r.submitId), [2]);

// ─────────────────────────────────────────────────────────────
// 6. 单行更新载荷（首屏与轮询共用同一套文案）
// ─────────────────────────────────────────────────────────────
console.log('\n[6] 行更新载荷');
const upd = rowUpdatePayload(4591960, { resultCode: 4, memory: 2228, time: 55, judger: 'Judger1' });
check('结果码带过去', upd.resultCode, 4);
check('不再是待判定', upd.pending, false);
ok('AC 标签可点开详情', upd.labelHtml.includes('data-act="detail"'));
ok('AC 标签用绿系', upd.labelHtml.includes('label pass'));
ok('悬停提示带判题机', upd.title.includes('Judger1'));

const updWait = rowUpdatePayload(77, { resultCode: 2, memory: 0, time: 0, judger: '' });
ok('编译中显示转圈', updWait.labelHtml.includes('class="spin"'));
ok('编译中不可点开详情', !updWait.labelHtml.includes('data-act="detail"'));
check('编译中标记', updWait.pending, true);

const evil = rowUpdatePayload(1, { resultCode: 6, memory: 1, time: 1, judger: '<img src=x onerror=1>' });
// 这里的 title 是给 `setAttribute('title', …)` 用的（不是 innerHTML），所以原样带过即可，
// 不需要也不应该转义 —— 转义了反而会在悬停提示里显示成 `&lt;img`
ok('判题机名不做 HTML 转义（走 setAttribute 不走 innerHTML）', evil.title.includes('<img'));
ok('判题机名只是普通文本，没有拼进 labelHtml', !evil.labelHtml.includes('img'));

// ─────────────────────────────────────────────────────────────
// 7. 整页渲染：亮色 + 转义
// ─────────────────────────────────────────────────────────────
console.log('\n[7] 整页渲染');
const page = buildStatusHtml(model);
ok('声明 color-scheme: light', /color-scheme:\s*light/.test(page));
ok('不含编辑器主题变量', !page.includes('--vscode-'));
ok('白底', /body\s*\{[^}]*background:\s*#fff/.test(page));
ok('深字', /body\s*\{[^}]*color:\s*#333/.test(page));
ok('默认「只看本题」（body 带 only-current）', /<body class="only-current">/.test(page));
ok('过滤规则用 data-match 而非动态选择器', page.includes('body.only-current tr[data-match="0"]'));
ok('首屏徽章说明在刷新', /id="auto" class="auto on"/.test(page));
ok('页脚写明走 status-ajax', page.includes('status-ajax.php'));
ok('唯一开脚本的页面：注入脚本在用 acquireVsCodeApi', page.includes('acquireVsCodeApi()'));
ok('表格列与站点一致（提交编号 / 题目 / 结果 …）', page.includes('<th>提交编号</th>') && page.includes('<th>提交时间</th>'));
ok('AC 行可点开详情', page.includes('data-act="detail"'));
check('numbers 里待判定计数', numbersHtml(model).includes('1</b> 判题中'), true);

// 整页不得出现「不转义就把站点文本插进去」的痕迹
const dirty = buildStatusModel([
  rec({ probName: '<script>alert(1)</script>', problemId: 'A<b', language: '"><img src=x>', codeLen: '<b>1</b>', submitTime: 'a"b' }),
], { cid: '3771"', userId: 'u<', filterPid: '' });
const dirtyPage = buildStatusHtml(dirty);
ok('题名里的脚本被转义', !dirtyPage.includes('<script>alert(1)'));
ok('语言列里的标签被转义', !dirtyPage.includes('"><img src=x>'));
ok('代码长度里的标签被转义', dirtyPage.includes('&lt;b&gt;1&lt;/b&gt;'));
ok('cid 里的引号被转义', dirtyPage.includes('3771&quot;'));
ok('题号里的尖括号被转义', dirtyPage.includes('A&lt;b'));

// 「没有当前题目」时不渲染过滤按钮（按钮存在但 hidden，脚本负责显隐）
const noPid = buildStatusHtml(buildStatusModel([rec()], { cid: 'c', userId: 'u' }));
ok('无当前题目时按钮隐藏', noPid.includes('id="toggleBtn" data-act="toggle" hidden'));
ok('无当前题目时不过滤', !noPid.includes('<body class="only-current"'));

// 空表、离线提示、连不上时的兜底页
check('空表文案', rowsHtml(buildStatusModel([], { cid: 'c', userId: 'u' })).includes('还没有你的提交记录'), true);
const offline = buildStatusHtml(buildStatusModel([rec()], { cid: 'c', userId: 'u', fromCache: true }));
ok('缓存降级有提示', offline.includes('本地缓存里的记录'));
const noCache = buildStatusHtml(buildStatusModel([], { cid: 'c', userId: 'u', offlineNoCache: true }));
ok('离线和无缓存有提示', noCache.includes('离线模式'));
const errPage = buildStatusErrorHtml('连接超时 & 失败');
ok('兜底页也是亮色', /color-scheme:\s*light/.test(errPage) && !errPage.includes('--vscode-'));
ok('兜底页转义了错误信息', errPage.includes('连接超时 &amp; 失败'));

// 详情面板
const dh = detailHtml('ceinfo.php', 11, 'Main.cc:1: error: <bad>');
ok('CE 详情标题', dh.includes('编译输出'));
ok('详情正文转义', dh.includes('&lt;bad&gt;'));
ok('CE 正文标红', dh.includes('<pre class="err">'));
ok('有收起按钮', dh.includes('data-act="close-detail"'));
const dh2 = detailHtml('reinfo.php', 4, 'time_space_table:');
ok('AC 的 reinfo 不标红', dh2.includes('<pre>') && !dh2.includes('<pre class="err">'));

// autoBadge
check('有待判定时徽章是「刷新中」', autoBadge(model).state, 'on');
check('没有待判定时徽章是 off', autoBadge(buildStatusModel([rec()], { cid: 'c', userId: 'u' })).state, 'off');
const away = buildStatusModel(
  [rec({ submitId: 2, resultCode: 0, problemId: 'T' })],
  { cid: 'c', userId: 'u', filterPid: 'W' },
);
check('徽章不谎报数量（被过滤掉的待判定不算）', autoBadge(away).state, 'off');
ok('徽章说清是「不在当前范围」', autoBadge(away).text.includes('不在当前范围'));

// ─────────────────────────────────────────────────────────────
// 8. 面板：首屏整页渲染，之后只发消息（「不刷新页面」的核心）
// ─────────────────────────────────────────────────────────────
console.log('\n[8] 面板轮询：只在首屏赋值 html，其余全靠消息');
const POLL_MS = 100;   // 下限 100ms，测试里用最小值
const HOLD = 900;

(async () => {
  const fake = useFakePanel();
  const calls = { poll: [], detail: [], load: 0 };
  const wv = new StatusWebview({
    loadRecords: async () => {
      calls.load += 1;
      return {
        records: [rec({ submitId: 900, resultCode: 0, problemId: 'W' }), rec({ submitId: 800, resultCode: 4, problemId: 'W' })],
        fromCache: false,
      };
    },
    pollRow: async (sid) => {
      calls.poll.push(sid);
      return { resultCode: 4, memory: 2228, time: 55, judger: 'Judger1', extra: '100' };
    },
    loadDetail: async (sid, code) => { calls.detail.push([sid, code]); return { page: 'reinfo.php', text: '期望 | 你的' }; },
    pollIntervalMs: () => POLL_MS,
    currentCid: () => '3775',
    currentUser: () => '2505050318',
    currentPid: () => '22',
  });

  await wv.show({ focus: true });
  check('首屏渲染了整页', fake.log.html.length, 1);
  ok('首屏 HTML 是结果页', fake.log.html[0].includes('提交结果'));
  check('面板标题带题目', fake.panel.title, '提交结果 · 3775-W');
  ok('页面脚本会发 ready 握手', fake.log.html[0].includes("command: 'ready'"));

  // 首屏是整页赋值，DOM 还没建好 —— 这时候不许开轮询（消息会丢）
  await sleep(POLL_MS * 2);
  check('脚本发 ready 之前不轮询', calls.poll.length, 0);

  await fake.log.messageHandler({ command: 'ready' });
  await sleep(HOLD);

  check('轮询次数（问到出结果就停）', calls.poll.length, 1);
  check('轮的是那条待判定的提交', calls.poll[0], 900);
  ok('把结果作为消息发回页面', fake.log.messages.some(m => m.command === 'row' && m.submitId === 900));
  const rowMsg = fake.log.messages.find(m => m.command === 'row');
  check('行消息带回结果码', rowMsg.resultCode, 4);
  check('行消息不再是待判定', rowMsg.pending, false);
  ok('行消息里的标签是转义好的 HTML', rowMsg.labelHtml.includes('label pass'));
  ok('出了结果后续报「已全部出结果」', fake.log.messages.some(m => m.command === 'auto' && m.text.includes('没有待判定')));

  // 关键断言：整个轮询过程不得再整页赋值
  check('轮询期间没有重新整页渲染', fake.log.html.length, 1);

  // 手动「刷新列表」→ 允许整页替换（用户主动要求重来），但仍只赋值一次
  fake.log.messages.length = 0;
  await fake.log.messageHandler({ command: 'refresh' });
  await sleep(120);
  check('手动刷新后仍是 1 次整页赋值', fake.log.html.length, 1);
  ok('手动刷新走 table 消息', fake.log.messages.some(m => m.command === 'table'));
  const tableMsg = fake.log.messages.find(m => m.command === 'table');
  check('table 消息带上过滤状态', tableMsg.onlyCurrent, true);
  check('table 消息带上 hasFilter', tableMsg.hasFilter, true);
  ok('table 消息里的表体是渲染好的行', tableMsg.rowsHtml.includes('data-sid="800"'));

  // 「显示全部题目」→ 过滤范围变化，模型跟着变
  await fake.log.messageHandler({ command: 'filter', onlyCurrent: false });
  check('切到全部后不再过滤', fake.panel ? fake.log.messages.filter(m => m.command === 'auto').pop().state : '', 'off');

  // 详情
  fake.log.messages.length = 0;
  await fake.log.messageHandler({ command: 'detail', submitId: 800, resultCode: 4 });
  check('详情请求带上 sid 与结果码', calls.detail, [[800, 4]]);
  const dmsg = fake.log.messages.find(m => m.command === 'detail');
  check('详情回包 ok', dmsg.ok, true);
  ok('详情回包带转义好的 HTML', dmsg.html.includes('判题详情'));

  // 详情失败要回报错误而不是静默
  const fake2 = useFakePanel();
  const wv2 = new StatusWebview({
    loadRecords: async () => ({ records: [rec()], fromCache: false }),
    pollRow: async () => ({ resultCode: 4, memory: 1, time: 1, judger: '' }),
    loadDetail: async () => { throw new Error('会话已失效'); },
    pollIntervalMs: () => POLL_MS,
    currentCid: () => 'c', currentUser: () => 'u', currentPid: () => '22',
  });
  await wv2.show();
  await fake2.log.messageHandler({ command: 'detail', submitId: 4591960, resultCode: 4 });
  const failMsg = fake2.log.messages.find(m => m.command === 'detail');
  check('详情失败 ok=false', failMsg.ok, false);
  ok('详情失败带上原因', failMsg.message.includes('会话已失效'));

  // 拉不到状态表 → 兜底页（而不是空白面板）
  const fake3 = useFakePanel();
  const wv3 = new StatusWebview({
    loadRecords: async () => { throw new Error('网络不可达'); },
    pollRow: async () => ({ resultCode: 4, memory: 0, time: 0, judger: '' }),
    loadDetail: async () => ({ page: 'reinfo.php', text: '' }),
    pollIntervalMs: () => POLL_MS,
    currentCid: () => 'c', currentUser: () => 'u', currentPid: () => '22',
  });
  await wv3.show();
  check('拉取失败也渲染了一次', fake3.log.html.length, 1);
  ok('失败页说明原因', fake3.log.html[0].includes('网络不可达'));
  ok('失败页是亮色', fake3.log.html[0].includes('color-scheme: light'));

  // 连不上时手动刷新 → 走消息提示，不整页替换
  await fake3.log.messageHandler({ command: 'refresh' });
  check('失败后手动刷新不整页替换', fake3.log.html.length, 1);
  ok('失败后手动刷新给提示', fake3.log.messages.some(m => m.command === 'notice' && m.kind === 'err'));

  // 关闭面板：在途轮询要自己退出，且不再发消息
  const fake4 = useFakePanel();
  let pollCount = 0;
  const wv4 = new StatusWebview({
    loadRecords: async () => ({ records: [rec({ submitId: 500, resultCode: 0 })], fromCache: false }),
    pollRow: async () => { pollCount += 1; return { resultCode: 0, memory: 0, time: 0, judger: '' }; },
    loadDetail: async () => ({ page: 'reinfo.php', text: '' }),
    pollIntervalMs: () => POLL_MS,
    currentCid: () => 'c', currentUser: () => 'u', currentPid: () => '22',
  });
  await wv4.show();
  await fake4.log.messageHandler({ command: 'ready' });
  await sleep(POLL_MS + 80);
  const beforeDispose = pollCount;
  wv4.dispose();
  const msgsAtDispose = fake4.log.messages.length;
  await sleep(POLL_MS * 3);
  check('关闭后在途轮询停下', pollCount, beforeDispose);
  check('关闭后不再发消息', fake4.log.messages.length, msgsAtDispose);

  // 重复 show() 复用同一个面板（不新开）
  const fake5 = useFakePanel();
  const wv5 = new StatusWebview({
    loadRecords: async () => ({ records: [rec()], fromCache: false }),
    pollRow: async () => ({ resultCode: 4, memory: 1, time: 1, judger: '' }),
    loadDetail: async () => ({ page: 'reinfo.php', text: '' }),
    pollIntervalMs: () => 60,   // 会被夹到下限
    currentCid: () => 'c', currentUser: () => 'u', currentPid: () => '22',
  });
  await wv5.show();
  const htmlAfterFirst = fake5.log.html.length;
  await wv5.show();
  check('第二次 show 不重开面板', fake5.log.reveals, 1);
  check('第二次 show 只发消息', fake5.log.html.length, htmlAfterFirst);

  // ─────────────────────────────────────────────────────────────
  // 9. 转义实现只有一份（题目页也走 utils/format）
  // ─────────────────────────────────────────────────────────────
  console.log('\n[9] 共用的转义实现');
  const svc = new ProblemService();
  const p = svc.buildProblemHtml({
    cid: '3775', pid: '0', title: 'A "quote" & <tag>', description: '<p>x</p>',
    inputDesc: '', outputDesc: '', sampleInput: '', sampleOutput: '',
  }, { banner: '缓存', enableRefresh: false });
  ok('题目页标题里的引号被转义（合并前漏转）', p.includes('A &quot;quote&quot; &amp; &lt;tag&gt;'));

  // 站点真 markup → 解析 → 渲染 的整链路（不依赖网络）
  // 夹具按线上 status.php 的原样结构手抄：含「待判定」「*正确 + 原始 sid」
  // 「reinfo / ceinfo 链接」这几种站点特有的写法
  const records = parseStatusTable(STATUS_PAGE_FIXTURE);
  check('夹具记录数', records.length, 6);
  check('待判定的行', [records[0].resultCode, records[0].problemId], [0, 'W']);
  check('比赛里已 AC 的行仍读作正确', records[1].resultCode, 4);
  check('WA 行', records[2].resultCode, 6);
  check('CE 行带 ceinfo 链接', records[3].resultHref, 'ceinfo.php?sid=4589601');
  check('OLE 行', records[4].resultCode, 9);
  const chain = buildStatusHtml(buildStatusModel(records, { cid: '3775', userId: '2505050318', filterPid: 'W' }));
  ok('整链路渲染成功', chain.includes('提交结果') && chain.includes('data-sid="4591960"'));
  ok('整链路里没有未转义的站点脚本', !chain.includes('<marquee'));
  ok('整链路里待判定的那行带转圈', chain.includes('class="spin"'));
  ok('整链路里 CE 行可点开详情', /data-code="11"[^>]*title="查看判题详情"/.test(chain));

  const okAll = done();
  process.exit(okAll ? 0 : 1);
})();
