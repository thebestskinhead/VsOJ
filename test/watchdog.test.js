// 看门狗（src/test/watchdog.ts）—— 内存探测的三条平台路径 + 三闸端到端
// 运行：node test/watchdog.test.js
//
// 内存那一闸失效是**静默**的：程序照跑不误，只是泄漏时不再被砍。所以探测函数
// （Windows `tasklist` / Linux `/proc` / macOS `ps`，以及 `/proc` 读不到时的回退）
// 值得单独钉住 —— 它出问题的表现是「看门狗还在、但什么都不拦」。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeChecker } = require('./helpers/stub');
const W = require('../out/test/watchdog.js');

const { check, ok, done } = makeChecker();
const root = path.join(os.tmpdir(), `vsoj-watchdog-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

// ── 1. 内存探测：三条平台路径 + 回退 ────────────────────────────────────────
console.log('[1] 内存探测');
const io = (over = {}) => ({
  platform: 'linux',
  pageSize: 4096,
  readStatmPages: () => 100,
  readPsRssKb: () => 2048,
  readTasklistKb: () => 1024,
  ...over,
});

check('Linux 读 /proc（页数 × 页大小）', W.probeMemory(1234, io()), 100 * 4096);
check('Windows 用 tasklist', W.probeMemory(1234, io({ platform: 'win32' })), 1024 * 1024);
check('macOS 用 ps', W.probeMemory(1234, io({ platform: 'darwin' })), 2048 * 1024);
check('没有 /proc 时回退 ps（容器 / macOS）',
  W.probeMemory(1234, io({ readStatmPages: () => { throw new Error('ENOENT'); } })), 2048 * 1024);
check('statm 读出 0 也回退 ps', W.probeMemory(1234, io({ readStatmPages: () => 0 })), 2048 * 1024);
check('statm 读出 NaN 也回退 ps', W.probeMemory(1234, io({ readStatmPages: () => NaN })), 2048 * 1024);

check('ps 拿不到 → undefined', W.probeMemory(1234, io({ platform: 'darwin', readPsRssKb: () => undefined })), undefined);
check('ps 读出 0 → undefined', W.probeMemory(1234, io({ platform: 'darwin', readPsRssKb: () => 0 })), undefined);
check('tasklist 拿不到 → undefined', W.probeMemory(1234, io({ platform: 'win32', readTasklistKb: () => undefined })), undefined);
check('pid 为 0 → undefined', W.probeMemory(0, io()), undefined);
check('pid 为负 → undefined', W.probeMemory(-1, io()), undefined);
check('Windows 上不碰 /proc', W.probeMemory(1234, io({
  platform: 'win32',
  readStatmPages: () => { throw new Error('不该被调用'); },
})), 1024 * 1024);

const real = W.defaultMemoryProbe(process.pid);
if (typeof real === 'number' && real > 0) {
  ok(`本机真探测读到自己的驻留内存（${Math.round(real / 1024 / 1024)} MB）`, true);
} else {
  console.log('  skip  本机探测不到（tasklist / ps 不可用），跨平台路径改由上面的注入用例覆盖');
}
check('对不存在的 pid 真探测返回 undefined', W.defaultMemoryProbe(999999), undefined);

// ── 2. killTree / readErrorTail ─────────────────────────────────────────────
console.log('\n[2] 进程树与错误尾部');
ok('pid 非法时 killTree 静默返回', (() => {
  try { W.killTree(0); W.killTree(-1); return true; } catch { return false; }
})());

const errFile = path.join(root, 'err.txt');
fs.writeFileSync(errFile, 'short', 'utf8');
check('短内容原样返回', W.readErrorTail(errFile), 'short');
fs.writeFileSync(errFile, 'x'.repeat(3000) + 'TAIL', 'utf8');
const tail = W.readErrorTail(errFile, 100);
ok('长内容只留尾部', tail.endsWith('TAIL'));
ok('注明省略了多少字节', tail.includes('前面省略 2904 字节'));
check('文件不存在 → 空串', W.readErrorTail(path.join(root, 'nope.txt')), '');

// ── 3. 三闸端到端（真起进程） ────────────────────────────────────────────────
console.log('\n[3] 三闸');
const baseLimits = { timeoutMs: 5000, maxOutputBytes: 1024 * 1024, maxMemoryBytes: 1024 * 1024 * 1024 };
const run = (over) => W.runProcess({
  command: process.execPath,
  args: ['-e', 'setInterval(function(){}, 1000);'],
  cwd: root,
  env: process.env,
  limits: baseLimits,
  ...over,
});

(async () => {
  const byMemory = await run({
    // 驻留 4KB > 阈值 1KB → 立刻触发；不注入 kill 实现，真去杀进程树
    limits: { ...baseLimits, maxMemoryBytes: 1024 },
    memoryPollMs: 20,
    memoryProbe: () => 4096,
  });
  check('内存闸触发', byMemory.watchdog, 'memory');
  ok('内存闸给出人读原因', /内存占用超过/.test(byMemory.killReason || ''));
  ok('被砍的进程没有残留（有退出信号或退出码）',
    byMemory.signal !== null || byMemory.exitCode !== null);

  const byTime = await run({ limits: { ...baseLimits, timeoutMs: 200 } });
  check('时间闸触发', byTime.watchdog, 'time');
  ok('时间闸给出人读原因', /运行超过/.test(byTime.killReason || ''));
  check('时间闸不误报为内存', byTime.watchdog === 'memory', false);

  const noProbe = await run({
    args: ['-e', 'process.exit(0);'],
    memoryProbe: () => undefined,
    memoryPollMs: 10,
  });
  check('探测不到内存时不误杀', noProbe.watchdog, null);
  check('正常跑完', noProbe.exitCode, 0);

  const normal = await run({ args: ['-e', 'console.log(1);'] });
  check('正常退出没有闸被触发', normal.watchdog, null);

  fs.rmSync(root, { recursive: true, force: true });
  process.exit(done() ? 0 : 1);
})();
