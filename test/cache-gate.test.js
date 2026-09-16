// 缓存闸门 —— 「凡是要站点数据的地方都先问缓存」这条纪律的回归测试
//
// 覆盖三个取数入口（api/contest.ts、api/problem.ts、api/submit.ts）与缓存层的边界：
//   1. 有新鲜缓存 → **零网络请求**，结果里如实标明来源与缓存年龄
//   2. 缓存过期 → 联网一次并原样落盘（同步 TTL 口径）
//   3. 离线且无缓存 → 抛 OfflineNoCacheError，而不是返回空列表冒充「站点上没有」
//   4. 题面走闸门（缓存优先、过期先给缓存再后台补拉），而纯网络原语**不读缓存**
//   5. 状态页：新鲜缓存零请求、force 绕过、**提交成功即作废缓存**
//
// 判定「零请求」的方式是在 apiClient 上打桩计数 —— 只要有人绕过缓存直连站点，
// 计数就非零，测试即失败。这是这套纪律唯一可自动化的守卫。
//
// 运行：node test/cache-gate.test.js
const path = require('path');
const fs = require('fs');
const { installVscodeStub, makeChecker, sleep, makeAccessGate, makeMemoryMemento } = require('./helpers/stub');

const cfg = {
  'workspace.root': '.vsoj',
  'cache.enabled': true,
  'cache.offline': false,
  'cache.ttlSeconds': 180,
  'cache.staleSeconds': 900,
  baseUrl: 'http://oj.test/JudgeOnline',
};
const env = installVscodeStub(cfg);
const WORKSPACE = env.workspaceFolder;
const GLOBAL_STORAGE = env.globalStorage;

const { CachePaths } = require('../out/cache/paths.js');
const { CacheStore, OfflineNoCacheError } = require('../out/cache/store.js');
const { ContestService } = require('../out/api/contest.js');
const { ProblemService } = require('../out/api/problem.js');
const { SubmitService } = require('../out/api/submit.js');
const { apiClient } = require('../out/api/client.js');
const { LoginRequiredError } = require('../out/session/access.js');
const { StateManager } = require('../out/utils/state.js');
const { ProblemWebview } = require('../out/webview/problemWebview.js');
const { StatusWebview } = require('../out/webview/statusWebview.js');

const context = { globalStorageUri: { fsPath: GLOBAL_STORAGE } };
const layout = CachePaths.resolve(context);
const store = new CacheStore(context, layout);
const { check, ok, done } = makeChecker();

// ──────────────────── 站点响应桩（同时统计请求次数） ────────────────────
const net = { calls: [], route: () => ({ status: 200, data: '', headers: {} }) };
apiClient.get = async (url, config, caller) => {
  net.calls.push({ url, params: (config && config.params) || {}, caller });
  const r = net.route(url, config) || {};
  if (r.throw) { throw new Error(r.throw); }
  return { status: r.status ?? 200, data: r.data ?? '', headers: r.headers ?? {} };
};
apiClient.post = async (url) => {
  net.calls.push({ url, method: 'POST' });
  return { status: 302, data: '', headers: {} };
};
const resetNet = (route) => { net.calls.length = 0; net.route = route || (() => ({ status: 200 })); };

// ──────────────────── 夹具 ────────────────────
const CID = '3775';

const CONTEST_LIST_HTML = '<html><body><h3>比赛列表</h3><table><tbody>'
  + '<tr><td>3775</td><td><a href="contest.php?cid=3775">数据结构课</a></td>'
  + '<td>公开</td><td>否</td><td>admin</td></tr>'
  + '</tbody></table></body></html>';

const problemRow = (globalId, letter, pid, title, accepted, submitted) =>
  `<tr><td><span class="green">Y</span></td><td>${globalId} Problem &nbsp;${letter}</td>`
  + `<td><a href="problem.php?cid=${CID}&amp;pid=${pid}">${title}</a></td><td></td>`
  + `<td>${accepted}</td><td>${submitted}</td></tr>`;

const PROBLEM_LIST_HTML = `<html><body><h3>数据结构课</h3><table id="problemset"><tbody>`
  + problemRow(1722, 'A', 0, '甲', 12, 20)
  + problemRow(1723, 'B', 1, '乙', 3, 7)
  + '</tbody></table></body></html>';

/** 题目页：`h3` 是题名（读缓存时用它核对题目身份），面板结构按站点原样 */
const problemPage = (title, body) => `<html><body><h3>${title}</h3>`
  + '<div class="panel panel-default"><div class="panel-heading"><h4>题目描述</h4></div>'
  + `<div class="panel-body"><p>${body}</p></div></div>`
  + '<div class="panel panel-default"><div class="panel-heading"><h4>输入</h4></div>'
  + '<div class="panel-body"><p>一行。</p></div></div>'
  + '<div class="panel panel-default"><div class="panel-heading"><h4>输出</h4></div>'
  + '<div class="panel-body"><p>一个整数。</p></div></div>'
  + '<pre id="sampleinput">1 2</pre><pre id="sampleoutput">3</pre></body></html>';

const STATUS_HTML = '<html><body><table id="result-tab"><tbody><tr>'
  + '<td>4591960</td><td><a href="contestrank.php?cid=3775&amp;user_id=1">学号</a></td>'
  + '<td><div class="center"><a href="problem.php?cid=3775&amp;pid=0">A</div></a></td>'
  + '<td><span class="hidden" result="0"></span><span class="label gray">等待</span></td>'
  + '<td>0</td><td>0</td><td><a href="showsource.php?id=4591960">C++</a></td>'
  + '<td>912 B</td><td>2026-09-16 10:00:00</td><td>Judger1</td>'
  + '</tr></tbody></table></body></html>';

/** 把文件 mtime 改成 `msOld` 毫秒之前（模拟「上次同步已过去很久」） */
function ageFile(file, msOld) {
  const t = (Date.now() - msOld) / 1000;
  fs.utimesSync(file, t, t);
}

// 闸门默认档：已登录 + 站点可达（本套件验的是缓存口径，不是登录闸门）
const { gate } = makeAccessGate();
const contest = new ContestService({ fetchCsrfToken: async () => 'tok' }, gate, store);
const problems = new ProblemService(gate, store);
const submits = new SubmitService({ fetchCsrfToken: async () => 'tok' }, gate, store);

(async () => {
  // ─────────── 铺初始数据 ───────────
  // 顺序按真实流程走：同意初始化（建目录）→ 比赛页落盘（目录名定稿）→
  // 拉一次题目列表（索引定稿）→ 再写题目页与状态页。反过来写会把题面落到
  // 「还没有索引时的数字 pid 目录」里，索引一建就换目录，题面随之失联。
  // 注：比赛目录只有「用户同意初始化」才会建，缓存写穿不再顺手建目录。
  await store.ensureContestDir(CID, '');
  await store.writeContestPageHtml(CID, PROBLEM_LIST_HTML, '数据结构课');
  resetNet(() => { throw new Error('不该联网'); });
  await contest.fetchProblemList(CID);
  await store.writeProblemHtml(CID, '0', problemPage('甲', '读两个数。'));
  await store.writeStatusHtml(CID, STATUS_HTML);
  const cp = await store.resolveContestDir(CID);
  console.log('比赛目录:', path.relative(WORKSPACE, cp.dir));
  console.log('缓存根:', path.relative(WORKSPACE, layout.rootDir));

  // ─────────── 1. 比赛列表：新鲜缓存 → 零请求 ───────────
  console.log('\n[1] 比赛列表 · 新鲜缓存');
  await store.writeContestListHtml(1, undefined, CONTEST_LIST_HTML);
  {
    resetNet(() => { throw new Error('不该联网'); });
    const r = await contest.fetchList(1);
    check('来源标为缓存', r.meta.source, 'cache');
    check('零网络请求', net.calls.length, 0);
    check('解析出的比赛数', r.rows.length, 1);
    check('比赛标题', r.rows[0].title, '数据结构课');
    ok('缓存年龄已给出', typeof r.meta.ageMs === 'number' && r.meta.ageMs >= 0);
  }

  // ─────────── 2. 比赛列表：过期 → 联网一次并落盘 ───────────
  console.log('\n[2] 比赛列表 · 缓存过期');
  {
    const file = layout.contestListFile(1);
    ageFile(file, 3600_000);           // 1 小时前 → 远超 TTL(180s)
    resetNet(() => ({ status: 200, data: CONTEST_LIST_HTML }));
    const r = await contest.fetchList(1);
    check('来源标为站点', r.meta.source, 'network');
    check('恰好联网一次', net.calls.length, 1);
    check('请求路径', net.calls[0].url, '/contest.php');
    check('不带 force 也走了网络（因为过期）', net.calls[0].params.page, 1);

    resetNet(() => { throw new Error('不该联网'); });
    const again = await contest.fetchList(1);
    check('落盘后立刻再读 → 命中，零请求', net.calls.length, 0);
    check('且来源回到缓存', again.meta.source, 'cache');
  }

  // ─────────── 3. 题目列表：命中缓存，索引照常重建 ───────────
  console.log('\n[3] 题目列表 · 命中缓存 + 索引重建');
  {
    resetNet(() => { throw new Error('不该联网'); });
    const r = await contest.fetchProblemList(CID);
    check('零网络请求', net.calls.length, 0);
    check('来源标为缓存', r.meta.source, 'cache');
    check('题目数', r.problems.length, 2);
    check('全局题号解析出来了', r.problems.map(p => p.globalId), ['1722', '1723']);

    const meta = await store.readContestMeta(CID);
    check('缓存命中路径同样重建了索引', meta.problems.length, 2);
    check('索引里带着全局题号', meta.problems.map(p => p.globalId), ['1722', '1723']);
    check('目录名按全局题号定名', meta.problems.map(p => p.dir), ['1722-甲', '1723-乙']);
  }

  // ─────────── 4. 离线模式：有缓存照常交付 / 无缓存抛错 ───────────
  console.log('\n[4] 离线模式');
  {
    cfg['cache.offline'] = true;

    resetNet(() => { throw new Error('离线模式不该联网'); });
    const cached = await contest.fetchProblemList(CID);
    check('离线但有缓存 → 照常交付', cached.problems.length, 2);
    check('仍如实标明来源', cached.meta.source, 'cache');
    check('且一次请求都没发', net.calls.length, 0);

    // 抽掉比赛页缓存与比赛列表缓存，模拟「这台机器从没同步过」
    fs.rmSync(cp.contestHtml, { force: true });
    fs.rmSync(layout.contestListFile(1), { force: true });

    try {
      await contest.fetchProblemList(CID);
      check('离线无缓存 · 题目列表 → 抛错', 'no-throw', 'throw');
    } catch (e) {
      check('离线无缓存 · 题目列表 → 抛可识别错误', e instanceof OfflineNoCacheError, true);
      check('错误码稳定（给程序看）', e.code, 'OFFLINE_NO_CACHE');
      check('错误里说明拿不到什么', e.target, '题目列表');
      ok('错误文案不是空话', /离线/.test(e.message));
    }
    try {
      await contest.fetchList(1);
      check('离线无缓存 · 比赛列表 → 抛错', 'no-throw', 'throw');
    } catch (e) {
      check('离线无缓存 · 比赛列表 → 抛可识别错误', e instanceof OfflineNoCacheError, true);
      check('目标为比赛列表', e.target, '比赛列表');
    }
    ok('全程零请求（离线含义就是不发包）', net.calls.length === 0);

    cfg['cache.offline'] = false;
  }

  // ─────────── 5. 题面闸门：命中缓存零请求；纯网络原语不吃缓存 ───────────
  console.log('\n[5] 题面 · 缓存优先与「纯网络原语」的分工');
  {
    resetNet(() => { throw new Error('不该联网'); });
    const r = await problems.loadProblemHtml(CID, '0');
    check('题面走闸门 → 命中缓存', r.source, 'cache');
    check('零网络请求', net.calls.length, 0);
    check('缓存新鲜 → 不安排后台刷新', r.refreshing, false);
    ok('拿到的是题目自己的题面', /甲/.test(r.html));

    resetNet(() => ({ status: 200, data: problemPage('甲', '联网版') }));
    const raw = await problems.fetchProblemHtml(CID, '0');
    check('纯网络原语即使有缓存也直连站点', net.calls.length, 1);
    ok('返回的是网络内容', /联网版/.test(raw));

    resetNet(() => { throw new Error('不该联网'); });
    const d = await problems.fetchProblem(CID, '0');
    check('结构化详情同样走闸门（零请求）', net.calls.length, 0);
    check('详情来源', d.source, 'cache');
    check('详情标题', d.detail.title, '甲');
  }

  // ─────────── 6. 题面闸门：过期先给缓存，再后台补拉 ───────────
  console.log('\n[6] 题面 · 过期时的「先渲染、后台补」');
  {
    const htmlFile = cp.problemHtml('0');
    ageFile(htmlFile, 3600_000);        // 1 小时 → 超过 staleSeconds(900s)
    resetNet(() => ({ status: 200, data: problemPage('甲', '补拉后的正文') }));

    const r = await problems.loadProblemHtml(CID, '0');
    check('首屏仍用缓存（不阻塞在网络）', r.source, 'cache');
    ok('首屏内容就是旧缓存', /读两个数/.test(r.html));
    check('已安排后台刷新', r.refreshing, true);

    await sleep(30);
    check('后台补拉发生了', net.calls.length, 1);
    ok('缓存已被新内容覆盖', /补拉后的正文/.test(fs.readFileSync(htmlFile, 'utf8')));
    const stat = await store.statProblemHtml(CID, '0');
    ok('缓存年龄被刷新（不再是 1 小时）', stat.ageMs < 60_000);

    resetNet(() => { throw new Error('不该联网'); });
    const after = await problems.loadProblemHtml(CID, '0');
    check('补拉后回到「零请求」', net.calls.length, 0);
    check('且不再安排刷新', after.refreshing, false);
  }

  // ─────────── 7. 题面闸门：离线且无缓存 ───────────
  console.log('\n[7] 题面 · 离线且无缓存');
  {
    const htmlFile = cp.problemHtml('0');
    const backup = fs.readFileSync(htmlFile, 'utf8');
    fs.rmSync(htmlFile, { force: true });
    cfg['cache.offline'] = true;
    resetNet(() => { throw new Error('离线模式不该联网'); });

    try {
      await problems.loadProblemHtml(CID, '0');
      check('离线无缓存 · 题面 → 抛错', 'no-throw', 'throw');
    } catch (e) {
      check('离线无缓存 · 题面 → 抛可识别错误', e instanceof OfflineNoCacheError, true);
      check('目标为题面内容', e.target, '题目内容');
    }
    check('零请求', net.calls.length, 0);

    cfg['cache.offline'] = false;
    fs.writeFileSync(htmlFile, backup);
  }

  // ─────────── 8. 状态页：TTL / force / 提交后作废 ───────────
  console.log('\n[8] 状态页');
  {
    resetNet(() => { throw new Error('不该联网'); });
    const r = await submits.queryStatus('2505050318', CID);
    check('新鲜缓存 → 零请求', net.calls.length, 0);
    check('标明来自缓存', r.fromCache, true);
    check('解析出的记录数', r.records.length, 1);

    resetNet(() => ({ status: 200, data: STATUS_HTML }));
    await submits.queryStatus('2505050318', CID, { force: true });
    check('force 绕过缓存直取站点', net.calls.length, 1);
    check('请求路径', net.calls[0].url, '/status.php');

    resetNet(() => ({ status: 200, data: STATUS_HTML }));
    const outcome = await submits.submit(CID, '0', 0, 'int main(){}', 'vcode');
    check('提交成功', outcome.success, true);
    ok('提交成功后状态缓存被作废', !fs.existsSync(cp.statusHtml));

    resetNet(() => ({ status: 200, data: STATUS_HTML }));
    const after = await submits.queryStatus('2505050318', CID);
    check('作废后必然联网（不会读到残快照）', net.calls.length, 1);
    check('来源标为站点', after.fromCache, false);
  }

  // ─────────── 9. 状态页 · 离线且无缓存：抛错而非返回空表 ───────────
  console.log('\n[9] 状态页 · 离线且无缓存');
  {
    try { fs.rmSync(cp.statusHtml, { force: true }); } catch { /* ignore */ }
    cfg['cache.offline'] = true;
    resetNet(() => { throw new Error('离线模式不该联网'); });
    try {
      await submits.queryStatus('2505050318', CID);
      check('离线无缓存 · 状态 → 抛错', 'no-throw', 'throw');
    } catch (e) {
      check('离线无缓存 · 状态 → 抛可识别错误', e instanceof OfflineNoCacheError, true);
      check('错误码稳定（给程序看）', e.code, 'OFFLINE_NO_CACHE');
      check('错误里说明拿不到什么', e.target, '提交状态');
      ok('错误文案不是空话', /离线/.test(e.message));
    }
    check('零请求', net.calls.length, 0);
    cfg['cache.offline'] = false;
  }

  // ─────────── 10. 轮询 / 详情路径的会话失效读时校验 ───────────
  console.log('\n[10] 轮询 / 详情路径 · 会话失效读时校验');
  {
    // 独立闸门：带 onSessionLost 计数器，且已登录（轮询接口本就不走 check）
    const lost = { n: 0 };
    const gate = makeAccessGate({ onSessionLost: () => { lost.n += 1; } });
    const svc = new SubmitService({ fetchCsrfToken: async () => 'tok' }, gate.gate, store);

    // 登录页形状：复用站点实测特征（user_id 输入框 + vcode.php，无 logout.php），不臆造
    const LOGIN_BODY = '<html><body><form method="post">'
      + '<input name="user_id" placeholder="用户名">'
      + '<img src="vcode.php?1">'
      + '</form></body></html>';

    // fetchStatusAjax 拿到登录页 → 抛 LoginRequiredError 且触发一次 onSessionLost
    resetNet(() => ({ status: 200, data: LOGIN_BODY }));
    try {
      await svc.fetchStatusAjax(4591960);
      check('fetchStatusAjax 登录页 → 抛错', 'no-throw', 'throw');
    } catch (e) {
      check('抛的是 LoginRequiredError', e instanceof LoginRequiredError, true);
      check('错误码为 LOGIN_REQUIRED', e.code, 'LOGIN_REQUIRED');
    }
    check('fetchStatusAjax 触发了一次 onSessionLost', lost.n, 1);

    // 重新登录复位后，fetchJudgementDetail 同样要抛且触发一次
    gate.gate.sessionRenewed();
    resetNet(() => ({ status: 200, data: LOGIN_BODY }));
    try {
      await svc.fetchJudgementDetail(4591960, 6);
      check('fetchJudgementDetail 登录页 → 抛错', 'no-throw', 'throw');
    } catch (e) {
      check('抛的是 LoginRequiredError', e instanceof LoginRequiredError, true);
      check('错误码为 LOGIN_REQUIRED', e.code, 'LOGIN_REQUIRED');
    }
    check('fetchJudgementDetail 触发了一次 onSessionLost', lost.n, 2);

    // 正常判题内容：不触发 onSessionLost，行为不回归
    const before = lost.n;
    resetNet(() => ({ status: 200, data: '4,2228,55,Judger1,100' }));
    const row = await svc.fetchStatusAjax(4591960);
    check('正常判题内容能解析出结果码', row.resultCode, 4);
    check('正常内容不触发 onSessionLost', lost.n, before);
  }

  // ─────────── 11. 缓存关闭 / 清理 → 已渲染 surface 必须重新对齐现态 ───────────
  console.log('\n[11] 缓存关闭 / 清理 · 已渲染 surface 收回（缺口二）');
  {
    // 捕获 webview 面板最后渲染的 html —— 「内容有没有真的在屏上 / 被收回」的唯一证据
    const realCreatePanel = env.vscode.window.createWebviewPanel;
    const panels = {};
    env.vscode.window.createWebviewPanel = (viewType, ...rest) => {
      const p = realCreatePanel(viewType, ...rest);
      panels[viewType] = p;
      return p;
    };

    const fakeCtx = {
      globalState: makeMemoryMemento(), secrets: makeMemoryMemento(), subscriptions: [],
    };
    const realState = new StateManager(fakeCtx);
    const gate = makeAccessGate({}).gate;

    const pwv = new ProblemWebview(new ProblemService(gate, store), realState, {
      store,
      probe: { isReachable: () => true },
      refresher: { refreshOne: async (pid) => ({ pid, ok: true }) },
      access: gate,
      fetchAsset: async () => Buffer.from(''),
      log: () => {},
    });
    const mkStatusRecord = () => ({
      submitId: 4591960, problemId: 'A', probName: '甲', resultCode: 4,
      resultName: '答案正确', memory: 1, time: 1, language: 'C++',
      codeLen: '912 B', submitTime: '2026-09-16',
    });
    const swv = new StatusWebview({
      loadRecords: async () => ({ records: [mkStatusRecord()], fromCache: false }),
      pollRow: async () => ({ resultCode: 4, memory: 1, time: 1, judger: 'J' }),
      loadDetail: async () => ({ page: 'reinfo.php', text: 'x' }),
      pollIntervalMs: () => 800,
      currentCid: () => CID,
      currentUser: () => '1',
      currentPid: () => '0',
      log: () => {},
    });

    // 先渲染：题面来自缓存（「读两个数」），状态页含真实记录 4591960
    resetNet(() => ({ status: 200, data: problemPage('甲', '读两个数。') }));
    await pwv.show(CID, '0');
    await swv.show({ focus: true });
    ok('题面已渲染（含「甲」）', /甲/.test(panels['ojProblemDetail'].webview.html));
    ok('状态页已渲染（含真实记录 4591960）', /4591960/.test(panels['ojStatus'].webview.html));

    // 模拟「清理缓存」：删掉本地题面 / 状态数据（数据已不在屏所对应的磁盘上）
    fs.rmSync(cp.problemHtml('0'), { force: true });
    fs.rmSync(cp.statusHtml, { force: true });

    // 网络返回与缓存不同的内容，便于辨认「屏上已是重抓后的新内容、旧缓存已不在」
    resetNet(() => ({ status: 200, data: problemPage('甲', '清理后重抓') }));
    const netBefore = net.calls.length;
    // 走 syncSurfacesToState 的同一套动作：题面重走 show、状态页 applyAccessLoss
    await pwv.show(CID, '0');
    await swv.applyAccessLoss();
    ok('清理缓存后 · 题面旧缓存内容已从屏上消失', !/读两个数/.test(panels['ojProblemDetail'].webview.html));
    ok('清理缓存后 · 题面已重抓为最新内容', /清理后重抓/.test(panels['ojProblemDetail'].webview.html));
    ok('清理缓存后 · 题面确实联网重抓（未静默沿用已删数据）', net.calls.length > netBefore);
    ok('清理缓存后 · 状态页已收回为登录提示', /需要登录后才能查看提交状态/.test(panels['ojStatus'].webview.html));
    ok('清理缓存后 · 状态页真实记录已收回', !/4591960/.test(panels['ojStatus'].webview.html));

    // 模拟「关闭缓存」（oj.cache.enabled=false）：站点数据不再落盘，但已落盘数据仍可读
    // 收口语义：状态页收回为登录提示；题面按现态重判（缓存仍可读，重渲染同一份缓存题面，不凭空消失）
    cfg['cache.enabled'] = false;
    resetNet(() => { throw new Error('关闭缓存后不应联网（缓存仍可读）'); });
    const netBefore2 = net.calls.length;
    await pwv.show(CID, '0');
    await swv.applyAccessLoss();
    ok('关闭缓存后 · 状态页已收回为登录提示', /需要登录后才能查看提交状态/.test(panels['ojStatus'].webview.html));
    ok('关闭缓存后 · 题面按现态重判、零请求（不静默沿用也不误联网）', net.calls.length === netBefore2);
    ok('关闭缓存后 · 题面仍呈现（缓存可读，不凭空消失）', /甲/.test(panels['ojProblemDetail'].webview.html));
    cfg['cache.enabled'] = true;

    env.vscode.window.createWebviewPanel = realCreatePanel;
  }

  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
