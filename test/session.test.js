/**
 * 会话层验证（S2）
 *
 * 覆盖三部分：
 *  A. 失效判定纯函数（guard.ts）—— 逐条对齐 docs/SITE_ANALYSIS.md §5 的实测信号
 *  B. 意图重放（SessionGuard）—— 持久化 / 过期 / 一次性消费
 *  C. 保活时序（SessionKeeper）—— 心跳、失败升级探测、去重上报、会话切换、停止
 *  D. 端到端：用本地 HTTP 服务器真实复现站点响应，验证
 *     SubmitService 能把「会话失效」从「其它失败」中区分出来
 *
 * 运行：npm run test:session
 */

const http = require('http');
const { installVscodeStub, makeChecker, makeMemoryMemento, cleanup, sleep } = require('./helpers/stub');

// 必须在 require 业务模块之前安装桩；baseUrl 稍后由本地服务器端口决定，
// 因此先给占位值，再在服务器就绪后调用 apiClient.updateBaseUrl()
const env = installVscodeStub({
  'oj.baseUrl': 'http://127.0.0.1:1',
  'oj.cache.enabled': true,
  'oj.cache.ttlSeconds': 180,
  'oj.workspace.root': '.vsoj',
});

const guard = require('../out/session/guard.js');
const { SessionKeeper } = require('../out/session/keeper.js');
const { apiClient } = require('../out/api/client.js');
const { AuthService } = require('../out/api/auth.js');
const { SubmitService } = require('../out/api/submit.js');

const { check, ok, done } = makeChecker();

// ============================================================
// A. 失效判定
// ============================================================
function testClassify() {
  console.log('\n=== A. 失效判定（guard.classify*） ===');

  const k500 = guard.classifyHttpResponse(500, '', 'submit');
  check('submit 500 + 空体 → SESSION_EXPIRED', k500.kind, 'SESSION_EXPIRED');

  const k500nonEmpty = guard.classifyHttpResponse(500, '<b>Internal Server Error</b>', 'problem');
  check('非 submit 的 500 + 有体 → 不直接判失效', k500nonEmpty.kind, 'UNKNOWN');

  check('500 + 空白字符体 → SESSION_EXPIRED', guard.classifyHttpResponse(500, '   \n  ', 'submit').kind, 'SESSION_EXPIRED');
  check('502 + 空体 → SESSION_EXPIRED', guard.classifyHttpResponse(502, '', undefined).kind, 'SESSION_EXPIRED');

  check('正文 Not Invited! → NO_PERMISSION', guard.classifyHtmlBody('<div>Not Invited!</div>'), 'NO_PERMISSION');
  check('正文 不能查看题目 → NO_PERMISSION', guard.classifyHtmlBody('不能查看题目'), 'NO_PERMISSION');
  check('正文 尚未开始 → NO_PERMISSION', guard.classifyHtmlBody('比赛尚未开始'), 'NO_PERMISSION');
  check('正文 No such Contest! → BAD_TARGET', guard.classifyHtmlBody('No such Contest!'), 'BAD_TARGET');
  check('正文 验证码错误 → INVALID_VCODE', guard.classifyHtmlBody('登录失败，验证码错误'), 'INVALID_VCODE');
  check('正文 Invalid code → INVALID_VCODE', guard.classifyHtmlBody('Invalid vcode'), 'INVALID_VCODE');
  check('正文 loginpage.php → SESSION_EXPIRED', guard.classifyHtmlBody('redirect loginpage.php'), 'SESSION_EXPIRED');
  check('无关正文 → undefined', guard.classifyHtmlBody('<html><body>hello</body></html>'), undefined);
  check('空正文 → undefined', guard.classifyHtmlBody(''), undefined);

  check('403 → NO_PERMISSION', guard.classifyHttpResponse(403, 'denied').kind, 'NO_PERMISSION');
  check('404 → BAD_TARGET', guard.classifyHttpResponse(404, 'nf').kind, 'BAD_TARGET');

  // 登录页判定 —— 决定「302 被自动跟随」场景能否被识别
  check('登录页特征 → 是登录页',
    guard.looksLikeLoginPage('<input name="user_id"><img src="vcode.php?1">'), true);
  check('含 logout.php → 非登录页',
    guard.looksLikeLoginPage('<input name="user_id">vcode.php<a href="logout.php">x</a>'), false);
  check('只有 user_id 无验证码 → 非登录页', guard.looksLikeLoginPage('<input name="user_id">'), false);
  check('空串 → false', guard.looksLikeLoginPage(''), false);
  check('登录页正文 → SESSION_EXPIRED',
    guard.classifyHtmlBody('<input name="user_id"><img src="vcode.php?1">'), 'SESSION_EXPIRED');
  check('裸 302 不再直接判失效（交由调用方按 Location/正文判定）',
    guard.classifyHttpResponse(302, '', undefined).kind, 'UNKNOWN');

  check('抛错 ECONNREFUSED → NETWORK', guard.classifyThrown({ code: 'ECONNREFUSED', message: 'refused' }).kind, 'NETWORK');
  check('抛错 Network Error → NETWORK', guard.classifyThrown({ message: 'Network Error' }).kind, 'NETWORK');
  check('抛错 带 response 500 空体 → SESSION_EXPIRED',
    guard.classifyThrown({ response: { status: 500, data: '' } }).kind, 'SESSION_EXPIRED');
  check('抛错 无信息 → UNKNOWN', guard.classifyThrown({ message: 'boom' }).kind, 'UNKNOWN');

  check('needsRelogin(SESSION_EXPIRED)', guard.needsRelogin('SESSION_EXPIRED'), true);
  check('needsRelogin(OK)', guard.needsRelogin('OK'), false);
  check('needsRelogin(NO_PERMISSION)', guard.needsRelogin('NO_PERMISSION'), false);
}

// ============================================================
// B. 意图重放
// ============================================================
async function testGuard() {
  console.log('\n=== B. 意图重放（SessionGuard） ===');

  const memento = makeMemoryMemento();
  const sg = new guard.SessionGuard(memento);

  check('初始无待重放', await sg.peekPending(), undefined);

  await sg.setPending({ kind: 'submit', cid: '3772', pid: '0', sourceFile: 'E:/a.cpp', language: 1 });
  const p = await sg.peekPending();
  check('写入后可读', `${p.cid}/${p.pid}/${p.language}`, '3772/0/1');
  ok('createdAt 已填充', !!p.createdAt);

  let received = null;
  const replayed = await sg.replay(async (intent) => { received = intent; });
  check('replay 返回 true', replayed, true);
  check('handler 收到意图', received && received.cid, '3772');
  check('replay 后已消费', await sg.peekPending(), undefined);
  check('无意图时 replay 返回 false', await sg.replay(async () => {}), false);

  // 过期清理
  await sg.setPending({ kind: 'submit', cid: '1', pid: '0' });
  const raw = memento.get('oj_pending_intent');
  raw.createdAt = new Date(Date.now() - guard.INTENT_TTL_MS - 60_000).toISOString();
  memento.update('oj_pending_intent', raw);
  check('超时意图自动清除', await sg.peekPending(), undefined);

  // 陈旧时间戳（非法值）也视为过期
  memento.update('oj_pending_intent', { kind: 'submit', cid: '1', pid: '0', createdAt: 'not-a-date' });
  check('非法时间戳视为过期', await sg.peekPending(), undefined);

  await sg.setPending({ kind: 'submit', cid: '9', pid: '1' });
  await sg.clearPending();
  check('clearPending 生效', await sg.peekPending(), undefined);
}

// ============================================================
// C. 保活时序
// ============================================================
async function testKeeper() {
  console.log('\n=== C. 保活时序（SessionKeeper） ===');

  // C1 正常心跳
  {
    let beats = 0;
    const k = new SessionKeeper({
      beat: async () => { beats++; },
      probe: async () => true,
      shouldRun: () => true,
      onExpired: () => {},
      log: () => {},
    }, { keepAliveIntervalMs: 20, probeIntervalMs: 0 });
    k.start();
    await sleep(75);
    k.stop();
    ok(`心跳被周期调用（${beats} 次 >= 3）`, beats >= 3);
    check('lastBeatOk', k.snapshot().lastBeatOk, true);
    const frozen = beats;
    await sleep(50);
    check('stop() 后不再心跳', beats, frozen);
  }

  // C2 心跳失败 → 达阈值升级为探测 → 探测确认失效 → 只上报一次
  {
    let expiredCount = 0;
    let probeCalls = 0;
    const k = new SessionKeeper({
      beat: async () => { throw new Error('ECONNREFUSED'); },
      probe: async () => { probeCalls++; return false; },
      shouldRun: () => true,
      onExpired: () => { expiredCount++; },
      log: () => {},
    }, { keepAliveIntervalMs: 15, probeIntervalMs: 0, failureThreshold: 3 });
    k.start();
    await sleep(120);
    k.stop();
    ok(`探测被调用（${probeCalls} 次 >= 1）`, probeCalls >= 1);
    check('失效只上报一次', expiredCount, 1);
    ok('连续失败计数 >= 3', k.snapshot().consecutiveBeatFailures >= 3);
    check('lastBeatOk=false', k.snapshot().lastBeatOk, false);
    ok('记录了错误信息', !!k.snapshot().lastError);
  }

  // C3 心跳低于阈值时不触发探测（避免网络抖动误报）
  {
    let probeCalls = 0;
    let expired = 0;
    let n = 0;
    const k = new SessionKeeper({
      beat: async () => { if (++n === 1) { throw new Error('flaky'); } },
      probe: async () => { probeCalls++; return true; },
      shouldRun: () => true,
      onExpired: () => { expired++; },
      log: () => {},
    }, { keepAliveIntervalMs: 20, probeIntervalMs: 0, failureThreshold: 3 });
    k.start();
    await sleep(90);
    k.stop();
    check('仅 1 次失败不触发探测', probeCalls, 0);
    check('无失效上报', expired, 0);
    check('失败计数已归零', k.snapshot().consecutiveBeatFailures, 0);
  }

  // C4 探测本身异常不应判失效
  {
    let expired = 0;
    const k = new SessionKeeper({
      beat: async () => {},
      probe: async () => { throw new Error('network down'); },
      shouldRun: () => true,
      onExpired: () => { expired++; },
      log: () => {},
    }, { keepAliveIntervalMs: 0, probeIntervalMs: 0 });
    k.start();
    await k.probeNow();
    check('探测异常不上报失效', expired, 0);
    check('lastProbeOk 保持 undefined', k.snapshot().lastProbeOk, undefined);
    k.stop();
  }

  // C5 shouldRun=false 时完全静默
  {
    let beats = 0;
    const k = new SessionKeeper({
      beat: async () => { beats++; },
      probe: async () => true,
      shouldRun: () => false,
      onExpired: () => {},
      log: () => {},
    }, { keepAliveIntervalMs: 15, probeIntervalMs: 15 });
    k.start();
    await sleep(70);
    k.stop();
    check('未登录/离线时不心跳', beats, 0);
  }

  // C6 探测恢复后允许再次上报
  {
    let expired = 0;
    let loggedIn = false;
    const k = new SessionKeeper({
      beat: async () => {},
      probe: async () => loggedIn,
      shouldRun: () => true,
      onExpired: () => { expired++; },
      log: () => {},
    }, { keepAliveIntervalMs: 0, probeIntervalMs: 0 });
    k.start();
    await k.probeNow();
    check('第一次失效上报', expired, 1);
    await k.probeNow();
    check('重复失效不重复上报', expired, 1);
    loggedIn = true;
    await k.probeNow();
    loggedIn = false;
    await k.probeNow();
    check('恢复后再次失效可再上报', expired, 2);
    k.stop();
  }

  // C7 restart 应用新间隔
  {
    let beats = 0;
    const k = new SessionKeeper({
      beat: async () => { beats++; },
      probe: async () => true,
      shouldRun: () => true,
      onExpired: () => {},
      log: () => {},
    }, { keepAliveIntervalMs: 1000, probeIntervalMs: 0 });
    k.start();
    const before = beats;
    await sleep(40);
    check('长间隔下 40ms 内不心跳', beats, before);
    k.restart({ keepAliveIntervalMs: 15, probeIntervalMs: 0 });
    await sleep(60);
    k.stop();
    ok('restart 后按新间隔心跳', beats > before);
  }

  // C8 登录成功（会话换新）→ 上一会话的判定作废
  {
    let serverLoggedIn = true;
    let stateLoggedIn = true;
    let expired = 0;
    const k = new SessionKeeper({
      beat: async () => {},
      // 与 AuthService.isLoggedIn() 同口径：读站点，再把结果写回登录态
      probe: async () => { stateLoggedIn = serverLoggedIn; return serverLoggedIn; },
      shouldRun: () => stateLoggedIn,
      onExpired: () => { expired++; },
      log: () => {},
    }, { keepAliveIntervalMs: 0, probeIntervalMs: 0 });
    k.start();

    serverLoggedIn = false;          // 会话在窗口期过期
    await k.probeNow();
    check('过期后 lastProbeOk=false', k.snapshot().lastProbeOk, false);
    check('过期上报一次', expired, 1);

    serverLoggedIn = true;           // 用户重新登录成功
    stateLoggedIn = true;
    k.sessionRenewed();
    check('登录后 lastProbeOk 不再挂着旧结论', k.snapshot().lastProbeOk, true);
    ok('登录后 lastProbeAt 已刷新', !!k.snapshot().lastProbeAt);
    check('登录后清掉上一会话的错误', k.snapshot().lastError, undefined);
    check('登录后失败计数归零', k.snapshot().consecutiveBeatFailures, 0);

    serverLoggedIn = false;          // 新会话再次过期
    await k.probeNow();
    check('新会话失效仍能再上报', expired, 2);
    k.stop();
  }

  // C9 登录时会话切换的连带动作：未保活则接管、离线则只重画 UI
  {
    let beats = 0;
    let ticks = 0;
    const k = new SessionKeeper({
      beat: async () => { beats++; },
      probe: async () => true,
      shouldRun: () => true,
      onExpired: () => {},
      onTick: () => { ticks++; },
      log: () => {},
    }, { keepAliveIntervalMs: 60000, probeIntervalMs: 0 });
    k.sessionRenewed();
    await sleep(20);
    check('未在保活时登录 → 保活接管', k.isRunning, true);
    ok('登录即补一次心跳', beats >= 1);
    ok('登录后立刻重画一次状态栏', ticks >= 1);
    check('登录即视为刚验证过', k.snapshot().lastProbeOk, true);
    k.stop();

    let ticks2 = 0;
    const k2 = new SessionKeeper({
      beat: async () => {},
      probe: async () => true,
      shouldRun: () => false,        // 离线 / 未登录
      onExpired: () => {},
      onTick: () => { ticks2++; },
      log: () => {},
    }, { keepAliveIntervalMs: 20, probeIntervalMs: 20 });
    k2.sessionRenewed();
    await sleep(40);
    check('离线时不启动保活', k2.isRunning, false);
    ok('离线时仍重画一次状态栏', ticks2 >= 1);
    k2.stop();
  }
}

// ============================================================
// D. 端到端：本地服务器复现站点响应
// ============================================================
function startFakeServer() {
  const LOGIN_PAGE = `<!DOCTYPE html><html><body>
    <form id="login" action="login.php" method="post">
      <input name="user_id" type="text"><input name="password" type="password">
      <input name="vcode" type="text">
    </form>
    <img id="vcode-img" src="vcode.php?0.1">
  </body></html>`;

  const STATUS_PAGE = `<!DOCTYPE html><html><body>
    <a href="logout.php">[退出]</a>
    <form><input name="user_id" type="text"><input name="problem_id" type="text"></form>
    <table id="result-tab"><tbody></tbody></table>
  </body></html>`;

  let mode = { status: 500, body: '', headers: {} };
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/csrf.php')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<input type="hidden" name="csrf" value="TESTTOKEN" class="1">');
      return;
    }
    if (url.startsWith('/submit.php')) {
      res.writeHead(mode.status, { 'Content-Type': 'text/html', ...mode.headers });
      res.end(mode.body);
      return;
    }
    // 模拟站点真实落点：未登录被重定向后的落点是登录页
    if (url.startsWith('/loginpage.php')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(LOGIN_PAGE);
      return;
    }
    if (url.startsWith('/status.php')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(STATUS_PAGE);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        setMode(m) { mode = m; },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function testEndToEnd() {
  console.log('\n=== D. 端到端：SubmitService 对站点响应的分类 ===');

  const srv = await startFakeServer();
  apiClient.updateBaseUrl(`http://127.0.0.1:${srv.port}`);

  const stateStub = { setLoggedIn: async () => {} };
  const auth = new AuthService(stateStub);
  const svc = new SubmitService(auth);

  const call = () => svc.submit('3772', '0', 1, 'int main(){}', 'abcd');

  // D1 会话失效：500 + 空体（实测量测到的核心信号）
  srv.setMode({ status: 500, body: '', headers: {} });
  let r = await call();
  check('500 空体 → success=false', r.success, false);
  check('500 空体 → kind=SESSION_EXPIRED', r.kind, 'SESSION_EXPIRED');

  // D2 未登录被重定向到登录页（axios 自动跟随 → 正文为登录页）
  srv.setMode({ status: 302, body: '', headers: { Location: '/loginpage.php' } });
  r = await call();
  check('302→loginpage（跟随）→ SESSION_EXPIRED', r.kind, 'SESSION_EXPIRED');

  // D3 404 落点仍应可诊断（不能因为跟随丢失状态）
  srv.setMode({ status: 302, body: '', headers: { Location: '/nope.php' } });
  r = await call();
  ok(`302→未知落点 → ${r.kind}（非 success）`, r.success === false);

  // D4 正常提交：302 跳状态页，跟随后的 status.php 含 logout.php
  srv.setMode({ status: 302, body: '', headers: { Location: '/status.php?cid=3772' } });
  r = await call();
  check('302→status 视为成功', r.success, true);
  check('成功 kind=OK', r.kind, 'OK');

  // D5 200 直出
  srv.setMode({ status: 200, body: '<script>alert("提交成功");</script>', headers: {} });
  r = await call();
  check('200 无失败特征 → 成功', r.success, true);

  srv.setMode({ status: 200, body: '<div class="alert">验证码错误</div>', headers: {} });
  r = await call();
  check('200 + 验证码错误 → INVALID_VCODE', r.kind, 'INVALID_VCODE');
  ok('保留 rawSnippet 供诊断', !!r.rawSnippet);

  srv.setMode({ status: 200, body: '<h2>Not Invited!</h2>', headers: {} });
  r = await call();
  check('200 + Not Invited! → NO_PERMISSION', r.kind, 'NO_PERMISSION');
  check('NO_PERMISSION 不要求重新登录', guard.needsRelogin(r.kind), false);

  srv.setMode({ status: 404, body: 'nf', headers: {} });
  r = await call();
  check('404 → BAD_TARGET', r.kind, 'BAD_TARGET');

  // D6 服务器不可达 → NETWORK（不应误判为登录失效）
  await srv.close();
  r = await call();
  check('连接被拒 → NETWORK', r.kind, 'NETWORK');
  check('NETWORK 不要求重新登录', guard.needsRelogin(r.kind), false);
}

(async () => {
  try {
    testClassify();
    await testGuard();
    await testKeeper();
    await testEndToEnd();
  } catch (e) {
    console.error('\n❌ 测试异常:', e);
    cleanup(env.workspaceFolder, env.globalStorage);
    process.exit(2);
  }
  cleanup(env.workspaceFolder, env.globalStorage);
  process.exit(done() ? 0 : 1);
})();
