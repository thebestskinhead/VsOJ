// 访问闸门 —— 登录态与离线的**状态转换**测试
//
// 站点自己是**不设防**的：公开比赛的 problem.php 匿名即渲染完整题面，
// contest.php 列表匿名也能看，status.php 匿名可见（docs/SITE_ANALYSIS.md §2）。
// 所以「未登录不给看」只能由本机把关，而且必须在**发请求之前**判 —— 事后看响应
// 已经晚了，内容已经拿到手了。本套件就是把这条纪律钉死。
//
// 覆盖：
//   A. 裁决真值表 —— `accessMode` / `decideAccess` 的全组合穷举（纯函数）
//   B. 闸门行为 —— 探测时机、探测异常、会话失效广播的去重与复位
//   C. 状态机端到端 —— 未登录 / 登录 / 过期 / 无权限 / 公开页面，逐态验证
//   D. 离线特例 —— 强制离线与「探测确认不可达」下，**无论是否登录**都可读缓存
//
// 判定「有没有把内容端出去」的方式是在 apiClient 上打桩计数：只要有人绕过闸门
// 直连站点，计数就非零。对「未登录」这条，零请求才是合格。
//
// 运行：npm run test:access

const path = require('path');
const fs = require('fs');
const { installVscodeStub, makeChecker, makeAccessGate, cleanup } = require('./helpers/stub');

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
const { ContestService, AccessError } = require('../out/api/contest.js');
const { ProblemService } = require('../out/api/problem.js');
const { SubmitService } = require('../out/api/submit.js');
const { AuthService } = require('../out/api/auth.js');
const { AccessGate, LoginRequiredError, accessMode, decideAccess } = require('../out/session/access.js');
const { apiClient } = require('../out/api/client.js');
const { StateManager } = require('../out/utils/state.js');
const { ProblemWebview } = require('../out/webview/problemWebview.js');
const { StatusWebview } = require('../out/webview/statusWebview.js');
const { ContestTreeProvider } = require('../out/views/contestTree.js');
const { ProblemTreeProvider } = require('../out/views/problemTree.js');
const { StatusPanel } = require('../out/views/statusPanel.js');
const { StatusRecord } = require('../out/types/index.js');
const { decideOpenProblem, makeFacts } = require('../out/workspace/guard.js');

const context = { globalStorageUri: { fsPath: GLOBAL_STORAGE } };
const layout = CachePaths.resolve(context);
const store = new CacheStore(context, layout);
const { check, ok, done } = makeChecker();

// ============================================================
// 站点桩 —— 如实复刻「站点自己不设防」这一点
// ============================================================
const PUBLIC_CID = '3775';
const PRIVATE_CID = '3762';
const BAD_CID = '4040';

const LOGIN_PAGE = '<html><body><form>'
  + '<input name="user_id"><input name="password"><img src="vcode.php?x=1">'
  + '</form></body></html>';
const LOGGED_IN_PAGE = '<html><body><a href="logout.php">退出登录</a></body></html>';

const CONTEST_LIST_HTML = '<html><body><h3>比赛列表</h3><table><tbody>'
  + `<tr><td>${PUBLIC_CID}</td><td><a href="contest.php?cid=${PUBLIC_CID}">数据结构课</a></td>`
  + '<td>公开</td><td>否</td><td>admin</td></tr>'
  + `<tr><td>${PRIVATE_CID}</td><td><a href="contest.php?cid=${PRIVATE_CID}">班级内部赛</a></td>`
  + '<td>私有</td><td>否</td><td>admin</td></tr>'
  + '</tbody></table></body></html>';

const problemRow = (globalId, letter, pid, title, accepted, submitted) =>
  `<tr><td><span class="green">Y</span></td><td>${globalId} Problem &nbsp;${letter}</td>`
  + `<td><a href="problem.php?cid=${PUBLIC_CID}&amp;pid=${pid}">${title}</a></td><td></td>`
  + `<td>${accepted}</td><td>${submitted}</td></tr>`;

const PROBLEM_LIST_HTML = `<html><body><h3>数据结构课</h3><table id="problemset"><tbody>`
  + problemRow(1722, 'A', 0, '甲', 12, 20)
  + problemRow(1723, 'B', 1, '乙', 3, 7)
  + '</tbody></table></body></html>';

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
  + '<td><span class="hidden" result="4"></span><span class="label green">答案正确</span></td>'
  + '<td>0</td><td>0</td><td><a href="showsource.php?id=4591960">C++</a></td>'
  + '<td>912 B</td><td>2026-09-16 10:00:00</td><td>Judger1</td>'
  + '</tr></tbody></table></body></html>';

/**
 * 站点状态。`loggedIn` 模拟服务端会话 —— 本机可以以为自己是登录的，
 * 服务端那边随时可能已经作废（HUSTOJ 按空闲时间回收会话）。
 */
const site = {
  loggedIn: false,
  /** 服务端在跟随 302 之后把登录页端回来（会话失效的另一个信号） */
  bounceToLogin: false,
  /** 站点整体不可达：所有请求都抛错，用于验证「网络故障不得成为免登录授权」 */
  down: false,
};

/** 请求记账：路径 → 次数。「零请求」是这套纪律唯一的可自动化守卫 */
const hits = {};
function resetHits() { for (const k of Object.keys(hits)) { delete hits[k]; } }
const hit = (p) => hits[p] || 0;
const totalHits = () => Object.values(hits).reduce((a, b) => a + b, 0);

function route(url, config) {
  const params = (config && config.params) || {};
  hits[url] = (hits[url] || 0) + 1;

  // 站点整体不可达：请求照样记账（「有没有发出去」必须可观测），然后抛错
  if (site.down) { return { throw: 'network down' }; }

  if (url === '/csrf.php') { return { status: 200, data: '<html><body>x</body></html>' }; }
  if (url === '/loginpage.php') { return { status: 200, data: site.loggedIn ? LOGGED_IN_PAGE : LOGIN_PAGE }; }
  if (url === '/logout.php') { site.loggedIn = false; return { status: 200, data: LOGGED_IN_PAGE }; }
  if (url === '/vcode.php' || url.startsWith('/vcode.php')) { return { status: 200, data: 'PNG' }; }

  // 会话失效时，跟随 302 之后落到登录页
  if (site.bounceToLogin) { return { status: 200, data: LOGIN_PAGE }; }

  if (url === '/contest.php') {
    if (params.cid === PRIVATE_CID) {
      // 私有比赛：未登录被挡；已登录但未受邀同样被挡（站点文案一致）
      return { status: 200, data: '<html><body>不能查看题目</body></html>' };
    }
    return { status: 200, data: params.cid ? PROBLEM_LIST_HTML : CONTEST_LIST_HTML };
  }
  if (url === '/problem.php') {
    if (params.cid === PRIVATE_CID) { return { status: 200, data: '<html><body>Not Invited!</body></html>' }; }
    if (params.cid === BAD_CID) { return { status: 200, data: '<html><body>No such Problem!</body></html>' }; }
    return { status: 200, data: problemPage('甲', '读两个数。') };
  }
  if (url === '/status.php') { return { status: 200, data: STATUS_HTML }; }
  return { status: 200, data: '' };
}

apiClient.get = async (url, config) => {
  const r = route(url, config);
  if (r.throw) { throw new Error(r.throw); }
  return { status: r.status ?? 200, data: r.data ?? '', headers: r.headers ?? {} };
};
apiClient.post = async (url, body) => {
  hits[url] = (hits[url] || 0) + 1;
  if (url === '/login.php') {
    // 只有验证码正确才把服务端会话标记为已登录
    site.loggedIn = /vcode=GOOD/.test(String(body));
    return { status: 302, data: '', headers: { location: '/' } };
  }
  if (url === '/submit.php') {
    if (!site.loggedIn) { return { status: 500, data: '', headers: {} }; }
    return { status: 200, data: '<html><body>提交成功</body></html>', headers: {} };
  }
  return { status: 200, data: '', headers: {} };
};

// ──────────────────── 应用侧状态 ────────────────────
/** 本机记录的登录态 —— 与扩展里的 `state.isLoggedIn()` 同一件事 */
const app = { loggedIn: false, studentId: undefined };

/** StateManager 的最小替身：只实现 AuthService 用到的那几个口子 */
const stateStub = {
  setLoggedIn: async (v) => { app.loggedIn = v; },
  setSessionCookie: async () => {},
  setStudentId: async (v) => { app.studentId = v; },
  clearSessionCookie: async () => {},
};

const auth = new AuthService(stateStub);

/** 给 tree/webview provider 用的「真」状态管理器（替身 ExtensionContext，确定性、无需 VS Code 运行时） */
const memMemento = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    update: (k, v) => { if (v === undefined) { m.delete(k); } else { m.set(k, v); } },
    _m: m,
  };
};
const fakeCtx = {
  globalState: memMemento(),
  secrets: memMemento(),
  subscriptions: [],
};
const realState = new StateManager(fakeCtx);

/**
 * 按给定闸门装配三个取数口。
 *
 * 之所以每次重建而不是「换掉 service 里的闸门字段」：真实装配就是构造时注入的，
 * 测试也该走同一条路，否则测的是另一种接线方式。
 */
function services(gate) {
  return {
    contest: new ContestService(auth, gate, store),
    problems: new ProblemService(gate, store),
    submits: new SubmitService(auth, gate, store),
    /** 没有缓存层（工作区外只读预览）的档位 */
    noCacheContest: new ContestService(auth, gate, undefined),
  };
}

let contest;
let problems;
let submits;
let noCacheContest;
function useGate(gate) {
  ({ contest, problems, submits, noCacheContest } = services(gate));
}

/** 直接造闸门（不走 helper 的默认档） */
function gateOf(opts) {
  return new AccessGate({
    isLoggedIn: () => app.loggedIn,
    isForcedOffline: () => !!opts.forcedOffline,
    onSessionLost: opts.onSessionLost,
  });
}

/** 跑一个取数动作，把结果归一成 { ok, kind, error } —— 便于逐态比对 */
async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const kind = e instanceof LoginRequiredError ? 'LOGIN_REQUIRED'
      : e instanceof OfflineNoCacheError ? 'OFFLINE_NO_CACHE'
        : e instanceof AccessError ? 'NO_PERMISSION'
          : 'OTHER';
    return { ok: false, kind, error: e, message: e.message };
  }
}

(async () => {
  // ============================================================
  // A. 裁决真值表 —— 全组合穷举
  // ============================================================
  console.log('\n[A] 裁决真值表（accessMode / decideAccess 穷举）');
  {
    // 登录 × 强制离线（可达性不参与裁决）
    const modeCases = [
      // [loggedIn, forcedOffline, 期望]
      [true, true, 'offline'],
      [true, false, 'site'],
      [false, true, 'offline'],
      [false, false, 'login-required'],
    ];
    const bad = modeCases
      .filter(([loggedIn, forcedOffline, want]) =>
        accessMode({ loggedIn, forcedOffline }) !== want)
      .map(([l, f, want]) => `L=${l} O=${f} 期望 ${want}、得到 ${accessMode({ loggedIn: l, forcedOffline: f })}`);
    check('accessMode 4 种组合全部符合', bad, []);

    // 拒绝原因 × 目标：登录态优先于一切，离线写操作单独成一类
    const verdictCases = [
      ['contest-list', 'login-required', true, 'deny/LOGIN_REQUIRED'],
      ['problem', 'login-required', true, 'deny/LOGIN_REQUIRED'],   // 有缓存也不给
      ['contest-list', 'offline', true, 'cache'],
      ['problem', 'offline', true, 'cache'],
      ['status', 'offline', true, 'cache'],
      ['contest-list', 'offline', false, 'deny/OFFLINE_NO_CACHE'],
      ['submit', 'offline', false, 'deny/OFFLINE_WRITE'],
      ['submit', 'offline', true, 'deny/OFFLINE_WRITE'],           // 写操作没有「读缓存」这回事
      ['submit', 'login-required', false, 'deny/LOGIN_REQUIRED'],
      ['submit', 'site', false, 'site'],
    ];
    const badV = verdictCases.filter(([target, mode, hasCache, want]) => {
      const v = decideAccess(target, mode, hasCache);
      const got = v.kind === 'deny' ? `deny/${v.reason}` : v.kind;
      return got !== want;
    }).map(([target, mode, hasCache, want]) => `${target}/${mode}/cache=${hasCache} 期望 ${want}`);
    check('decideAccess 各目标裁决符合', badV, []);
  }

  // ============================================================
  // B. 闸门行为 —— 探测时机与失效广播
  // ============================================================
  console.log('\n[B] 闸门行为');
  {
    // B1 已登录：放行联网，且不依赖探测
    {
      const { gate } = makeAccessGate({ loggedIn: true });
      const v = await gate.check('contest-list', () => false);
      check('已登录 → 放行联网', v.kind, 'site');
    }
    // B2 未登录 + 未开强制离线：一律拒绝，且完全不依赖网络
    {
      const { gate } = makeAccessGate({ loggedIn: false });
      const v = await gate.check('contest-list', () => true);
      check('未登录 + 未开离线 → 拒绝登录', v.kind === 'deny' && v.reason, 'LOGIN_REQUIRED');
    }
    // B3 未登录 + 强制离线：允许读缓存（唯一例外）
    {
      const { gate } = makeAccessGate({ loggedIn: false, forcedOffline: true });
      const v = await gate.check('contest-list', () => true);
      check('未登录 + 强制离线 → 读缓存', v.kind, 'cache');
    }
    // B4 强制离线：读缓存（闸门已不再探测）
    {
      const { gate } = makeAccessGate({ loggedIn: true, forcedOffline: true });
      const v = await gate.check('contest-list', () => true);
      check('强制离线 → 读缓存', v.kind, 'cache');
    }
    // B5 回归：未登录时是否放行缓存**只**由强制离线开关决定，与网络无关
    {
      check('未登录 + 未开离线 → login-required（无论网络）',
        accessMode({ loggedIn: false, forcedOffline: false }), 'login-required');
      check('未登录 + 强制离线 → offline（允许读缓存）',
        accessMode({ loggedIn: false, forcedOffline: true }), 'offline');
      check('已登录 + 未开离线 → site',
        accessMode({ loggedIn: true, forcedOffline: false }), 'site');
      check('已登录 + 强制离线 → offline',
        accessMode({ loggedIn: true, forcedOffline: true }), 'offline');
    }
    // B6 会话失效广播：只报一次，重新登录后可再报
    {
      let lost = 0;
      const gate = gateOf({ onSessionLost: () => { lost += 1; } });
      check('正常页不误报', gate.noteResponse(problemPage('甲', '正文')), false);
      check('列表页不误报', gate.noteResponse(PROBLEM_LIST_HTML), false);
      check('空响应不误报', gate.noteResponse(undefined), false);
      check('登录页被识别', gate.noteResponse(LOGIN_PAGE), true);
      check('失效回调被触发', lost, 1);
      gate.noteResponse(LOGIN_PAGE);
      gate.noteResponse(LOGIN_PAGE);
      check('同一失效只广播一次', lost, 1);
      ok('失效状态可查询', gate.sessionLost);
      gate.sessionRenewed();
      ok('重新登录后复位', !gate.sessionLost);
      gate.noteResponse(LOGIN_PAGE);
      check('复位后新会话失效会再广播', lost, 2);
    }
  }

  // ============================================================
  // C. 状态机端到端
  // ============================================================
  console.log('\n[C] 状态机：未登录 → 登录 → 过期 → 无权限');

  // 起始闸门（后面每个场景都会重装）
  useGate(gateOf({}));

  // 先把缓存铺满（模拟「用户此前登录过、本地已有全部缓存」）——
  // 这正是 bug 的场景：登出之后侧边栏还照常显示上次的题目列表。
  // 注意：缓存只在**已同意初始化**（比赛目录已存在）时落盘，
  // 所以先显式建目录，等价于用户点过「初始化并打开」。
  await store.ensureContestDir(PUBLIC_CID, '');
  await store.writeContestPageHtml(PUBLIC_CID, PROBLEM_LIST_HTML, '数据结构课');
  await store.writeProblemHtml(PUBLIC_CID, '0', problemPage('甲', '读两个数。'));
  await store.writeContestListHtml(1, undefined, CONTEST_LIST_HTML);
  await store.writeStatusHtml(PUBLIC_CID, STATUS_HTML);

  // ── C1 未登录 + 站点可达：一律拒绝，且**零请求** ──
  {
    app.loggedIn = false;
    site.loggedIn = false;
    site.bounceToLogin = false;
    useGate(gateOf({}));

    resetHits();
    const list = await attempt(() => contest.fetchList(1));
    check('未登录 · 比赛列表 → 拒绝', list.kind, 'LOGIN_REQUIRED');
    const plist = await attempt(() => contest.fetchProblemList(PUBLIC_CID));
    check('未登录 · 题目列表 → 拒绝', plist.kind, 'LOGIN_REQUIRED');
    const prob = await attempt(() => problems.fetchProblem(PUBLIC_CID, '0'));
    check('未登录 · 题面 → 拒绝', prob.kind, 'LOGIN_REQUIRED');
    const status = await attempt(() => submits.queryStatus('2505050318', PUBLIC_CID));
    check('未登录 · 提交状态 → 拒绝', status.kind, 'LOGIN_REQUIRED');
    check('未登录时**一个请求都没发**', totalHits(), 0);
    ok('缓存确实存在（否则这条断言没有意义）',
      (await store.readContestPageHtml(PUBLIC_CID, { allowStale: true })) !== undefined
      && (await store.hasProblemHtml(PUBLIC_CID, '0')));
  }

  // ── C2 未登录访问「站点上本来就公开」的页面：站点会给，但本机不给 ──
  {
    // 站点侧确认真的是公开的：匿名拉一次，能拿到内容
    app.loggedIn = false;
    resetHits();
    apiClient.get('/contest.php', { params: {} });
    check('站点侧：匿名确实能拿到比赛列表', hit('/contest.php'), 1);

    useGate(gateOf({}));
    resetHits();
    const r = await attempt(() => contest.fetchList(1));
    check('本机侧：同一页面未登录被拒', r.kind, 'LOGIN_REQUIRED');
    check('本机侧：没有替用户去取', totalHits(), 0);
  }

  // ── C3 登录：登录成功后同一批页面全部可用 ──
  {
    app.loggedIn = false;
    site.loggedIn = false;
    resetHits();
    const okLogin = await auth.login('student', 'pw', 'GOOD');
    ok('登录成功', okLogin);
    check('登录态已落到本机状态', app.loggedIn, true);

    useGate(gateOf({}));
    resetHits();
    const list = await attempt(() => contest.fetchList(1));
    ok('已登录 · 比赛列表可访问', list.ok);
    check('已登录 · 比赛列表有内容', list.value.rows.length, 2);
    const plist = await attempt(() => contest.fetchProblemList(PUBLIC_CID));
    ok('已登录 · 题目列表可访问', plist.ok);
    check('已登录 · 题目列表题数', plist.value.problems.length, 2);
    const prob = await attempt(() => problems.fetchProblem(PUBLIC_CID, '0'));
    ok('已登录 · 题面可访问', prob.ok);
    check('已登录 · 题面标题', prob.value.detail.title, '甲');
    const status = await attempt(() => submits.queryStatus('2505050318', PUBLIC_CID));
    ok('已登录 · 提交状态可访问', status.ok);
    ok('确实联网取过（不是全靠缓存）', totalHits() > 0);
  }

  // ── C4 已登录访问无权限页面：是「无权限」，不是「请登录」 ──
  {
    useGate(gateOf({}));
    resetHits();
    const r = await attempt(() => contest.fetchProblemList(PRIVATE_CID));
    check('已登录 · 私有比赛 → 无权限', r.kind, 'NO_PERMISSION');
    ok('文案说的是权限不是登录', /权限/.test(r.message));
    const p = await attempt(() => problems.fetchProblem(PUBLIC_CID, '0'));
    ok('同一登录态下公开比赛照常可读', p.ok);
  }

  // ── C5 会话过期：服务端不再认这个会话 ──
  {
    // 服务端把会话回收掉，本机还以为自己登录着
    site.loggedIn = false;
    app.loggedIn = true;

    const probed = await auth.probeLogin();
    check('探测到服务端已不认这个会话', probed, false);
    check('本机登录态随之降级', app.loggedIn, false);

    // 降级之后，之前能访问的一律变回「拒绝」
    useGate(gateOf({}));
    resetHits();
    const list = await attempt(() => contest.fetchList(1));
    check('过期后 · 比赛列表被拒', list.kind, 'LOGIN_REQUIRED');
    const plist = await attempt(() => contest.fetchProblemList(PUBLIC_CID));
    check('过期后 · 题目列表被拒', plist.kind, 'LOGIN_REQUIRED');
    const prob = await attempt(() => problems.fetchProblem(PUBLIC_CID, '0'));
    check('过期后 · 题面被拒（缓存不兜底）', prob.kind, 'LOGIN_REQUIRED');
    check('过期后同样零请求', totalHits(), 0);
    ok('过期后已缓存题面也不再提供',
      !prob.ok && !String(JSON.stringify(prob.value || '')).includes('读两个数'));
  }

  // ── C6 响应体本身就是登录页（跟随 302 之后的落点）──
  {
    app.loggedIn = true;
    site.loggedIn = false;
    site.bounceToLogin = true;
    let lost = 0;
    useGate(gateOf({ onSessionLost: () => { lost += 1; } }));

    resetHits();
    const r = await attempt(() => problems.loadProblemHtml(PUBLIC_CID, '0', { force: true }));
    check('取回登录页 → 拒答', r.kind, 'LOGIN_REQUIRED');
    check('广播了一次会话失效', lost, 1);

    // 登录页绝不能被当成题面写进缓存
    const cached = await store.readProblemHtml(PUBLIC_CID, '0', { allowStale: true });
    ok('缓存里仍是真题面，没有被登录页覆盖', /读两个数/.test(cached || ''));
    site.bounceToLogin = false;
  }

  // ── C7 退出登录 → 回到 C1 的未登录态 ──
  {
    app.loggedIn = true;
    site.loggedIn = true;
    await auth.logout();
    check('登出后本机登录态为否', app.loggedIn, false);
    check('登出后服务端会话为否', site.loggedIn, false);

    useGate(gateOf({}));
    resetHits();
    const plist = await attempt(() => contest.fetchProblemList(PUBLIC_CID));
    check('登出后 · 题目列表回到被拒', plist.kind, 'LOGIN_REQUIRED');
    check('登出后 · 零请求', totalHits(), 0);
  }

  // ── C8 题面受限识别：Not Invited! / No such Problem! 不可当正文，且区分「无权限」与「需登录」 ──
  {
    // 正常题面不回归：登录态可正常取到题面正文
    app.loggedIn = true;
    site.loggedIn = true;
    useGate(gateOf({}));
    resetHits();
    const okP = await attempt(() => problems.fetchProblemHtml(PUBLIC_CID, '0'));
    ok('正常题面 · fetchProblemHtml 返回正文', okP.ok && /读两个数/.test(okP.value));
  }
  {
    // 已登录 + 私有比赛（Not Invited!）→ 无权限（AccessError），不渲染也不落盘
    app.loggedIn = true;
    site.loggedIn = true;
    useGate(gateOf({}));
    resetHits();
    const r = await attempt(() => problems.fetchProblemHtml(PRIVATE_CID, '0'));
    check('已登录 · 私有比赛题面 → 无权限', r.kind, 'NO_PERMISSION');
    ok('文案说明权限而非登录', /权限|未开始|私有/.test(r.message));
    // 过闸门入口同样识别，且受限页不会覆盖已有缓存
    const viaLoad = await attempt(() => problems.loadProblemHtml(PRIVATE_CID, '0', { force: true }));
    check('过闸门入口同样判无权限', viaLoad.kind, 'NO_PERMISSION');
    const cached = await store.readProblemHtml(PRIVATE_CID, '0', { allowStale: true });
    ok('受限页未被写进缓存', cached === undefined || !/Not Invited!/.test(cached));
  }
  {
    // 未登录 + 私有比赛（Not Invited!）→ 登录态已失效（LoginRequiredError）
    app.loggedIn = false;
    site.loggedIn = false;
    let lost = 0;
    useGate(gateOf({ onSessionLost: () => { lost += 1; } }));
    resetHits();
    const r = await attempt(() => problems.fetchProblemHtml(PRIVATE_CID, '0'));
    check('未登录 · 私有比赛题面 → 需登录', r.kind, 'LOGIN_REQUIRED');
    check('判定会话失效并广播一次', lost, 1);
  }
  {
    // No such Problem!（BAD_TARGET）→ 题目不存在；登录有效时给无权限类提示
    app.loggedIn = true;
    site.loggedIn = true;
    useGate(gateOf({}));
    resetHits();
    const r = await attempt(() => problems.fetchProblemHtml(BAD_CID, '0'));
    check('题目不存在 → 无权限类错误', r.kind, 'NO_PERMISSION');
    ok('文案指出题目不存在', /题目不存在/.test(r.message));
  }

  // ============================================================
  // D. 离线特例 —— 仅强制离线开关授权未登录读缓存
  // ============================================================
  console.log('\n[D] 离线：仅强制离线开关授权未登录读缓存');

  const offlineCases = [
    // [标签, 本机登录态, 闸门选项, 期望：比赛列表 / 题目列表]
    ['强制离线 · 未登录', false, { forcedOffline: true }, ['cache', 'cache']],
    ['强制离线 · 已登录', true, { forcedOffline: true }, ['cache', 'cache']],
  ];

  for (const [label, loggedIn, opts, want] of offlineCases) {
    app.loggedIn = loggedIn;
    useGate(gateOf(opts));
    resetHits();

    const list = await attempt(() => contest.fetchList(1));
    check(`${label} · 比赛列表读缓存`, list.ok ? list.value.meta.source : 'x', want[0]);
    const plist = await attempt(() => contest.fetchProblemList(PUBLIC_CID));
    check(`${label} · 题目列表读缓存`, plist.ok ? plist.value.meta.source : 'x', want[1]);
    const prob = await attempt(() => problems.loadProblemHtml(PUBLIC_CID, '0'));
    ok(`${label} · 题面可读`, prob.ok);
    check(`${label} · 题面来源是缓存`, prob.ok ? prob.value.source : 'x', 'cache');
    check(`${label} · 全程零请求`, totalHits(), 0);
  }

  // 这次要修掉的错误行为：未登录 + 没开强制离线，即使网络不可达也**不得**读缓存
  {
    app.loggedIn = false;
    useGate(gateOf({}));
    resetHits();
    const list = await attempt(() => contest.fetchList(1));
    check('未登录 + 未开离线 · 比赛列表 → 拒绝', list.kind, 'LOGIN_REQUIRED');
    const plist = await attempt(() => contest.fetchProblemList(PUBLIC_CID));
    check('未登录 + 未开离线 · 题目列表 → 拒绝', plist.kind, 'LOGIN_REQUIRED');
    check('未登录 + 未开离线 · 零请求', totalHits(), 0);
  }

  // 离线 + 未登录：连提交都不该发生（写操作没有缓存可读）
  {
    useGate(gateOf({ forcedOffline: true }));
    resetHits();
    const r = await submits.submit(PUBLIC_CID, '0', 0, 'int main(){}', 'GOOD');
    check('离线 · 提交失败', r.success, false);
    check('离线 · 不归到「登录过期」', r.kind, 'NETWORK');
    ok('文案说清是离线', /离线/.test(r.message));
    check('离线 · 提交零请求', totalHits(), 0);
  }

  // 离线且本地没有这份东西：说清「拿不到」，不是「没有」
  {
    useGate(gateOf({ forcedOffline: true }));
    resetHits();
    const r = await attempt(() => contest.fetchProblemList('9999'));
    check('离线无缓存 · 题目列表 → 可识别错误', r.kind, 'OFFLINE_NO_CACHE');
    ok('文案指明是题目列表', /题目列表/.test(r.message));
    const p = await attempt(() => problems.loadProblemHtml(PUBLIC_CID, '9'));
    check('离线无缓存 · 题面 → 可识别错误', p.kind, 'OFFLINE_NO_CACHE');
    check('离线无缓存 · 零请求', totalHits(), 0);
  }

  // 会话过期 + 强制离线：离线授权优先——这正是「离线做题」的用法
  {
    app.loggedIn = false;
    site.loggedIn = false;
    useGate(gateOf({ forcedOffline: true }));
    resetHits();
    const prob = await attempt(() => problems.loadProblemHtml(PUBLIC_CID, '0'));
    ok('未登录 + 强制离线 → 缓存题面仍可读', prob.ok);
    check('未登录 + 强制离线 → 零请求', totalHits(), 0);
  }

  // 「可达但请求失败」的隐式降级**不得**放宽登录要求 —— 这条是本次改动的核心
  {
    app.loggedIn = false;
    useGate(gateOf({}));
    resetHits();
    const r = await attempt(() => contest.fetchList(1));
    check('可达但未登录 → 仍然拒绝（不许悄悄吃缓存）', r.kind, 'LOGIN_REQUIRED');
    check('可达但未登录 → 零请求', totalHits(), 0);
  }

  // 没有缓存层时（工作区外只读预览）闸门照样生效
  {
    useGate(gateOf({}));
    resetHits();
    const r = await attempt(() => noCacheContest.fetchList(1));
    check('无缓存层 · 未登录照样被拒', r.kind, 'LOGIN_REQUIRED');
    check('无缓存层 · 零请求', totalHits(), 0);
  }

  // 离线开关在运行中翻转：闸门读的是实时配置，不是启动时的快照
  {
    app.loggedIn = false;
    useGate(gateOf({}));
    // 用真实配置驱动（helper 的默认档）
    const { gate } = makeAccessGate({ loggedIn: false });
    useGate(gate);

    cfg['cache.offline'] = false;
    resetHits();
    const before = await attempt(() => contest.fetchList(1));
    check('离线关闭 + 未登录 → 拒绝', before.kind, 'LOGIN_REQUIRED');
    check('离线关闭 · 零请求', totalHits(), 0);

    cfg['cache.offline'] = true;
    resetHits();
    const after = await attempt(() => contest.fetchList(1));
    ok('打开离线开关后同一次调用改为读缓存', after.ok);
    check('打开离线开关后零请求', totalHits(), 0);
    cfg['cache.offline'] = false;
  }

  // ============================================================
  // E. 状态变化的收口 —— 驱动真实 webview / tree provider
  // ============================================================
  console.log('\n[E] 状态一变，屏幕上已有内容必须跟着变（收口）');
  {
    // 捕获 webview 面板最后渲染的 html —— 这是「内容有没有真的上屏/被收回」的唯一证据
    const realCreatePanel = env.vscode.window.createWebviewPanel;
    let capturedPanel = null;
    const posted = [];
    env.vscode.window.createWebviewPanel = (...a) => {
      const p = realCreatePanel(...a);
      capturedPanel = p;
      const realPost = p.webview.postMessage;
      p.webview.postMessage = (m) => { posted.push(m); return realPost ? realPost(m) : undefined; };
      return p;
    };
    const mkPwv = (gate) => new ProblemWebview(new ProblemService(gate, store), realState, {
      store,
      probe: { isReachable: () => true },
      refresher: { refreshOne: async (pid) => ({ pid, ok: true }) },
      access: gate,
      fetchAsset: async () => Buffer.from(''),
      log: () => {},
    });

    // E1 题面整页：先以缓存渲染，会话失效后 applyAccessLoss 必须收回旧题面
    {
      app.loggedIn = true;
      cfg['cache.offline'] = true;
      const gate = gateOf({ forcedOffline: true });
      const pwv = mkPwv(gate);
      resetHits();
      await pwv.show(PUBLIC_CID, '0');
      ok('题面已渲染上屏（含标题「甲」）', /甲/.test(capturedPanel.webview.html));
      ok('题面渲染走离线缓存（零请求）', totalHits() === 0);

      // 会话失效：状态收口把整屏换成登录提示，旧题面不得残留
      app.loggedIn = false;
      cfg['cache.offline'] = false;
      await pwv.applyAccessLoss();
      ok('applyAccessLoss → 改为登录提示', /需要登录/.test(capturedPanel.webview.html));
      ok('applyAccessLoss → 旧题面内容已收回', !/甲/.test(capturedPanel.webview.html));
    }

    // E2 状态整页：会话失效后 applyAccessLoss 收口为登录提示并停轮询
    {
      const mkStatusRecord = () => ({
        submitId: 4591960, problemId: 'A', probName: '甲', resultCode: 4,
        resultName: '答案正确', memory: 1, time: 1, language: 'C++',
        codeLen: '912 B', submitTime: '2026-09-16',
      });
      app.loggedIn = true;
      const swv = new StatusWebview({
        loadRecords: async () => ({ records: [mkStatusRecord()], fromCache: false }),
        pollRow: async () => ({ resultCode: 4, memory: 1, time: 1, judger: 'J' }),
        loadDetail: async () => ({ page: 'reinfo.php', text: 'x' }),
        pollIntervalMs: () => 800,
        currentCid: () => PUBLIC_CID,
        currentUser: () => '1',
        currentPid: () => '0',
        log: () => {},
      });
      await swv.show({ focus: true });
      ok('状态页已渲染（含比赛 cid）', /3775/.test(capturedPanel.webview.html));
      await swv.applyAccessLoss();
      ok('statusWebview.applyAccessLoss → 登录提示',
        /需要登录后才能查看提交状态/.test(capturedPanel.webview.html));
      ok('statusWebview.applyAccessLoss → 旧提交记录已收回',
        !/4591960/.test(capturedPanel.webview.html));
    }

    // E3 离线开关运行中翻转：关掉后未登录再次 show 必须重新裁决为登录提示
    {
      app.loggedIn = false;
      cfg['cache.offline'] = true;
      const gate = new AccessGate({
        isLoggedIn: () => app.loggedIn,
        isForcedOffline: () => !!cfg['cache.offline'],
      });
      const pwv = mkPwv(gate);
      resetHits();
      await pwv.show(PUBLIC_CID, '0');
      ok('离线开 + 未登录 → 渲染缓存题面', /甲/.test(capturedPanel.webview.html));
      ok('离线开 + 未登录 → 零请求', totalHits() === 0);

      cfg['cache.offline'] = false;
      app.loggedIn = false;
      resetHits();
      await pwv.show(PUBLIC_CID, '0');
      ok('离线关 + 未登录 → 重新裁决为登录提示', /需要登录/.test(capturedPanel.webview.html));
      ok('离线关 + 未登录 → 旧题面已收回', !/甲/.test(capturedPanel.webview.html));
      ok('离线关 + 未登录 → 仍零请求（被拦在发请求前）', totalHits() === 0);
      cfg['cache.offline'] = false;
    }

    // ── 缺口一：后台刷新失败必须按「会话是否失效」分两路，与手动刷新同口径 ──
    {
      // refreshOne 可控，用来构造「后台更新失败」
      const refresher = { refreshOne: async () => ({ pid: '0', ok: true }) };
      const mkPwv = (gate) => new ProblemWebview(new ProblemService(gate, store), realState, {
        store,
        probe: { isReachable: () => true },
        refresher,
        access: gate,
        fetchAsset: async () => Buffer.from(''),
        log: () => {},
      });

      // 1) 会话在后台刷新途中失效：整屏换成登录提示，旧题面收回（不再只换一句说明）
      {
        app.loggedIn = true;
        cfg['cache.offline'] = true;
        const gate = gateOf({ forcedOffline: true });
        const pwv = mkPwv(gate);
        await pwv.show(PUBLIC_CID, '0');
        ok('题面已渲染（含「甲」）', /甲/.test(capturedPanel.webview.html));

        // 模拟会话在后台刷新途中失效
        gate.noteResponse(LOGIN_PAGE);
        ok('会话已判定失效', gate.sessionLost);
        refresher.refreshOne = async () => ({ pid: '0', ok: false });
        posted.length = 0;
        await pwv.backgroundRefresh();

        ok('后台刷新会话失效 → 整屏换成登录提示', /需要登录/.test(capturedPanel.webview.html));
        ok('后台刷新会话失效 → 旧题面已从屏上收回', !/甲/.test(capturedPanel.webview.html));
      }

      // 2) 后台刷新失败但非会话失效：只更新 banner 文案，不换成登录提示（保持 C8 静默契约）
      {
        app.loggedIn = true;
        cfg['cache.offline'] = true;
        const gate = gateOf({ forcedOffline: true });
        const pwv = mkPwv(gate);
        await pwv.show(PUBLIC_CID, '0');
        ok('题面已渲染（含「甲」）', /甲/.test(capturedPanel.webview.html));
        ok('会话未失效', !gate.sessionLost);

        refresher.refreshOne = async () => ({ pid: '0', ok: false });
        posted.length = 0;
        await pwv.backgroundRefresh();

        ok('后台刷新普通失败 → 仍显示题面（未换成登录提示）', /甲/.test(capturedPanel.webview.html));
        ok('后台刷新普通失败 → 未出现登录提示', !/需要登录/.test(capturedPanel.webview.html));
        ok('后台刷新普通失败 → 仅以 banner 提示「后台更新失败」',
          posted.some((m) => m.command === 'banner' && /后台更新失败/.test(m.text || '')));
        cfg['cache.offline'] = false;
      }
    }

    // ── 缺口三：工作区文件夹变化 → 题面只读结论重算，已打开面板按新结论重渲染 ──
    {
      // 决策来源就是 workspace/guard.ts 的 decideOpenProblem(...).noCache：
      // 无文件夹 → noCache=true（只读、不读不写缓存）；有文件夹 → noCache=false
      check('无文件夹 → 题面判定为只读', decideOpenProblem(makeFacts({ hasFolder: false })).noCache, true);
      check('有文件夹 → 题面判定为非只读', decideOpenProblem(makeFacts({ hasFolder: true })).noCache, false);

      // 复用 show() 重走一次，模拟扩展里 onDidChangeWorkspaceFolders 的处理：
      // readOnly = decideOpenProblem(projectFacts).noCache；按该结论重渲染当前面板
      const rejudge = async (pwv, hasFolder) => {
        const readOnly = decideOpenProblem(makeFacts({ hasFolder })).noCache;
        await pwv.show(PUBLIC_CID, '0', { readOnly });
      };

      const gate = gateOf({});
      const pwv = new ProblemWebview(new ProblemService(gate, store), realState, {
        store,
        probe: { isReachable: () => true },
        refresher: { refreshOne: async (pid) => ({ pid, ok: true }) },
        access: gate,
        fetchAsset: async () => Buffer.from(''),
        log: () => {},
      });

      // 先在无工作区窗口里打开题目（readOnly = true，只走网络、不读不写缓存）
      app.loggedIn = true;
      await rejudge(pwv, false);
      ok('无文件夹 → 面板以只读预览渲染（不读不写缓存）', /只读预览/.test(capturedPanel.webview.html));

      // 随后打开一个文件夹：结论应反转，面板按「非只读」重渲染（缓存路径可用）
      await rejudge(pwv, true);
      ok('打开文件夹后 → 面板重渲染、不再是以只读预览', !/只读预览/.test(capturedPanel.webview.html));
      ok('打开文件夹后 → 题面仍正常呈现（含「甲」）', /甲/.test(capturedPanel.webview.html));

      // 反向：关闭文件夹 → 结论回到只读，面板再次按新结论重渲染
      await rejudge(pwv, false);
      ok('关闭文件夹后 → 面板重新以只读预览渲染', /只读预览/.test(capturedPanel.webview.html));
    }
    env.vscode.window.createWebviewPanel = realCreatePanel;
  }

  // E4/E5 两个 side-tree 未登录时只给登录提示，不得把「上次列表」露出来
  {
    app.loggedIn = false;
    useGate(gateOf({})); // login-required 闸门
    await realState.setCurrentCid(PUBLIC_CID);

    const ptp = new ProblemTreeProvider(contest, realState);
    resetHits();
    const pItems = await ptp.getChildren();
    check('未登录 · 题目列表只返回一条', pItems.length, 1);
    check('未登录 · 该条是 login-required', pItems[0].itemType, 'login-required');
    ok('未登录 · 不泄露任何题目名（无「甲/乙」）',
      !pItems.some((i) => /甲|乙/.test(i.label)));
    ok('未登录 · 取题目列表零请求', totalHits() === 0);

    const ctp = new ContestTreeProvider(contest, realState);
    ctp.setReady();
    resetHits();
    const cItems = await ctp.getChildren();
    check('未登录 · 比赛列表只返回登录提示', cItems[0].itemType, 'login-hint');
    ok('未登录 · 不泄露任何比赛名（无「数据结构课」）',
      !cItems.some((i) => /数据结构课|班级内部赛/.test(i.label)));
    ok('未登录 · 取比赛列表零请求', totalHits() === 0);
  }

  // E6 状态 OutputChannel：未登录只讲「需要登录」，不得渲染记录残影
  {
    app.loggedIn = false;
    useGate(gateOf({}));
    let channelText = '';
    const realChannel = env.vscode.window.createOutputChannel;
    env.vscode.window.createOutputChannel = (name) => {
      const ch = realChannel(name);
      return {
        ...ch,
        clear: () => { channelText = ''; },
        append: (t) => { channelText += t; },
        appendLine: (t) => { channelText += t + '\n'; },
        replace: (t) => { channelText = t; },
      };
    };
    await realState.setCurrentCid(PUBLIC_CID);
    await realState.setStudentId('1');
    const sp = new StatusPanel(submits, realState);
    await sp.show();
    ok('未登录 · 状态面板只讲「需要登录」', /需要登录/.test(channelText));
    ok('未登录 · 状态面板不泄露任何记录', !/答案正确|4591960/.test(channelText));
    env.vscode.window.createOutputChannel = realChannel;
  }

  // ============================================================
  // F. 离线矩阵 —— 5 target × 登录态 × 缓存有无
  // ============================================================
  console.log('\n[F] 离线矩阵：5 target × 登录态 × 缓存有无');
  {
    for (const loggedIn of [false, true]) {
      app.loggedIn = loggedIn;
      cfg['cache.offline'] = true;
      useGate(gateOf({ forcedOffline: true }));
      const tag = loggedIn ? '已登录' : '未登录';

      resetHits();
      const list = await attempt(() => contest.fetchList(1));
      const plist = await attempt(() => contest.fetchProblemList(PUBLIC_CID));
      const prob = await attempt(() => problems.loadProblemHtml(PUBLIC_CID, '0'));
      const status = await attempt(() => submits.queryStatus('2505050318', PUBLIC_CID));
      const sub = await submits.submit(PUBLIC_CID, '0', 0, 'int main(){}', 'GOOD');
      check(`离线·有缓存·${tag} 比赛列表读缓存`, list.ok ? list.value.meta.source : 'x', 'cache');
      check(`离线·有缓存·${tag} 题目列表读缓存`, plist.ok ? plist.value.meta.source : 'x', 'cache');
      check(`离线·有缓存·${tag} 题面读缓存`, prob.ok ? prob.value.source : 'x', 'cache');
      check(`离线·有缓存·${tag} 状态读缓存`, status.ok ? (status.value.fromCache ? 'cache' : 'x') : 'x', 'cache');
      check(`离线·有缓存·${tag} 提交被拒`, sub.success, false);
      ok(`离线·有缓存·${tag} 提交文案说清离线`, /离线/.test(sub.message));
      check(`离线·有缓存·${tag} 全程零请求`, totalHits(), 0);

      resetHits();
      const ncList = await attempt(() => contest.fetchList(99));
      const ncPlist = await attempt(() => contest.fetchProblemList('9999'));
      const ncProb = await attempt(() => problems.loadProblemHtml(PUBLIC_CID, '9'));
      const ncStatus = await attempt(() => submits.queryStatus('x', '9999'));
      const ncSub = await submits.submit('9999', '0', 0, 'int main(){}', 'GOOD');
      check(`离线·无缓存·${tag} 比赛列表→OFFLINE_NO_CACHE`, ncList.kind, 'OFFLINE_NO_CACHE');
      check(`离线·无缓存·${tag} 题目列表→OFFLINE_NO_CACHE`, ncPlist.kind, 'OFFLINE_NO_CACHE');
      check(`离线·无缓存·${tag} 题面→OFFLINE_NO_CACHE`, ncProb.kind, 'OFFLINE_NO_CACHE');
      check(`离线·无缓存·${tag} 状态→OFFLINE_NO_CACHE`, ncStatus.kind, 'OFFLINE_NO_CACHE');
      check(`离线·无缓存·${tag} 提交→仍 OFFLINE_WRITE`, ncSub.success, false);
      ok(`离线·无缓存·${tag} 提交文案说清离线`, /离线/.test(ncSub.message));
      check(`离线·无缓存·${tag} 全程零请求`, totalHits(), 0);
    }
    cfg['cache.offline'] = false;
  }

  // ============================================================
  // G. 反隐式降级 —— 未登录 + 站点不可达 / 探测异常 → 仍是 login-required
  // ============================================================
  console.log('\n[G] 反隐式降级：网络结论绝不构成免登录授权');
  {
    // 情形1：请求直接失败 —— 未登录仍拒绝，不得悄悄吃缓存
    app.loggedIn = false;
    cfg['cache.offline'] = false;
    useGate(gateOf({}));
    site.down = true;
    try {
      resetHits();
      const r = await attempt(() => contest.fetchList(1));
      check('未登录 + 请求失败 → 仍 login-required', r.kind, 'LOGIN_REQUIRED');
      check('未登录 + 请求失败 → 一个请求都没发（没去探缓存）', totalHits(), 0);
    } finally {
      site.down = false;
    }

    // 情形2：「可达性探测」返回不可达，也绝不能构成免登录授权
    const g = new AccessGate({ isLoggedIn: () => false, isForcedOffline: () => false });
    const v = await g.check('contest-list', async () => false);
    check('未登录 + 探测不可达 → 仍 deny/LOGIN_REQUIRED', v.kind === 'deny' && v.reason, 'LOGIN_REQUIRED');

    // 情形3：探测本身抛错也不能放行（闸门根本不读探测结果）
    const g2 = new AccessGate({ isLoggedIn: () => false, isForcedOffline: () => false });
    const v2 = await g2.check('problem', () => { throw new Error('probe boom'); });
    check('未登录 + 探测抛错 → 仍 deny/LOGIN_REQUIRED', v2.kind === 'deny' && v2.reason, 'LOGIN_REQUIRED');
  }

  // ============================================================
  // H. 公开比赛（站点匿名渲染题面）—— 本机未登录仍拦
  // ============================================================
  console.log('\n[H] 公开比赛匿名可渲染，但本机未登录仍拦');
  {
    app.loggedIn = false;
    resetHits();
    const anon = await apiClient.get('/problem.php', { params: { cid: PUBLIC_CID, pid: '0' } });
    ok('站点侧：匿名确实能拿到公开比赛题面', /读两个数/.test(anon.data));

    useGate(gateOf({}));
    resetHits();
    const r = await attempt(() => problems.fetchProblem(PUBLIC_CID, '0'));
    check('本机侧：公开比赛题面未登录被拒', r.kind, 'LOGIN_REQUIRED');
    check('本机侧：没有替用户去取', totalHits(), 0);
  }

  cleanup(WORKSPACE, GLOBAL_STORAGE);
  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
