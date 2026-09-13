// 网络可达性探测（session/connectivity.ts）
//
// 用真实本地 HTTP 服务器验证：能拿到响应就算可达（含 4xx/5xx），
// 只有网络层失败（连接拒绝 / 超时）才算不可达。
//
// 运行：node test/connectivity.test.js
const http = require('http');
const axios = require('axios');
const { makeChecker, sleep } = require('./helpers/stub');
const { ConnectivityProbe } = require('../out/session/connectivity.js');

const { check, ok, done } = makeChecker();

function startServer() {
  const state = { mode: 'ok' };
  const server = http.createServer((req, res) => {
    if (state.mode === 'hang') { return; }            // 不响应 → 触发超时
    const status = state.mode === 'err' ? 500 : 200;
    res.writeHead(status, { 'Content-Type': 'text/html' });
    res.end(status === 200 ? 'ok' : 'boom');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/csrf.php`,
        setMode: (m) => { state.mode = m; },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

/** 与生产接线同口径：validateStatus 放行一切状态码，只看网络层是否成功 */
const pingTo = (url, timeout = 400) => async () => {
  await axios.get(url, { timeout, validateStatus: () => true });
};

(async () => {
  const srv = await startServer();

  console.log('[1] 可达判定');
  {
    const probe = new ConnectivityProbe({ ping: pingTo(srv.url), ttlMs: 30_000 });
    check('HTTP 200 → 可达', await probe.isReachable(), true);

    probe.invalidate();
    srv.setMode('err');
    check('HTTP 500 → 仍算可达（只看是否拿到响应）', await probe.isReachable(), true);
    srv.setMode('ok');
  }

  console.log('\n[2] 不可达判定');
  {
    const dead = new ConnectivityProbe({ ping: pingTo('http://127.0.0.1:1/') , ttlMs: 30_000 });
    check('连接拒绝 → 不可达', await dead.isReachable(), false);
    ok('快照记录失败', dead.snapshot().lastOk === false);
  }
  {
    srv.setMode('hang');
    const slow = new ConnectivityProbe({ ping: pingTo(srv.url, 300), ttlMs: 30_000 });
    check('超时 → 不可达', await slow.isReachable(), false);
    srv.setMode('ok');
  }

  console.log('\n[3] 结果缓存（30s 内不重复探测）');
  {
    let calls = 0;
    const probe = new ConnectivityProbe({
      ping: async () => { calls += 1; },
      ttlMs: 30_000,
    });
    await probe.isReachable();
    await probe.isReachable();
    await probe.isReachable();
    check('三次调用只真实探测一次', calls, 1);
    check('probeCount', probe.snapshot().probeCount, 1);
    check('cachedHitCount', probe.snapshot().cachedHitCount, 2);

    await probe.isReachable(true);
    check('force=true 强制重探', calls, 2);

    probe.invalidate();
    await probe.isReachable();
    check('invalidate 后重探', calls, 3);
  }

  console.log('\n[4] 并发合并：同一时刻只探测一次');
  {
    let calls = 0;
    const probe = new ConnectivityProbe({
      ping: async () => { calls += 1; await sleep(50); },
      ttlMs: 30_000,
    });
    const results = await Promise.all([
      probe.isReachable(true), probe.isReachable(true), probe.isReachable(true),
    ]);
    check('三个并发请求合并为一次探测', calls, 1);
    check('全部拿到同一结果', results, [true, true, true]);
  }

  console.log('\n[5] TTL 过期后重新探测');
  {
    let calls = 0;
    const probe = new ConnectivityProbe({
      ping: async () => { calls += 1; },
      ttlMs: 40,
    });
    await probe.isReachable();
    await sleep(60);
    await probe.isReachable();
    check('超过 TTL 后重新探测', calls, 2);
  }

  console.log('\n[6] 状态从可达变不可达（缓存期内维持旧结论）');
  {
    const probe = new ConnectivityProbe({ ping: pingTo(srv.url), ttlMs: 60_000 });
    check('先可达', await probe.isReachable(), true);
    await srv.close();
    check('缓存期内仍报告可达（避免抖动）', await probe.isReachable(), true);
    check('force 后报告不可达', await probe.isReachable(true), false);
  }

  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
