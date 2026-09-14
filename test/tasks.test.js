/**
 * S6.4 自定义任务与终端桥 —— 真实工具链端到端
 *
 * 运行：npm run test:tasks
 *
 * 「不 mock」在这里尤其重要：任务链路的坑全在接缝处 ——
 * 命令占位符有没有被解析、cwd 是不是题目目录、stdin 有没有真的接上样例文件、
 * 写进伪终端的换行是不是 CRLF、关终端会不会留下野进程。
 * 这些只有真跑一遍才看得见。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { installVscodeStub, makeChecker, cleanup, sleep } = require('./helpers/stub');

const GPP = process.env.VSOJ_TEST_GPP || 'D:\\usexxx\\gcc\\versions\\16.2.0\\mingw64\\bin\\g++.exe';
const NODE_EXE = process.execPath;
const HAS_GPP = fs.existsSync(GPP);

const WS = path.join(os.tmpdir(), `vsoj-tasks-${process.pid}`);
const env = installVscodeStub({
  'oj.test.toolchain': 'auto',
  'oj.test.toolchainsFile': '.vsoj/toolchains.json',
  // 本机 g++ 不在 PATH：把它的目录丢进搜索目录，正是给用户准备的那条路
  'oj.test.searchDirs': HAS_GPP ? [path.dirname(GPP)] : [],
}, { workspaceFolder: WS, fresh: true });

const TK = require('../out/test/tasks.js');
const TM = require('../out/test/terminal.js');
const WG = require('../out/test/wiring.js');
const { check, ok, done } = makeChecker();

const PROB = path.join(WS, '3775-新生赛', 'problems', 'A-A+B问题');
const SAMPLES = path.join(PROB, 'samples');

function setupWorkspace() {
  fs.rmSync(WS, { recursive: true, force: true });
  for (const d of [SAMPLES, path.join(PROB, 'temp'), path.join(PROB, 'test'), path.join(WS, '.vsoj')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(PROB, 'main.cpp'), [
    '#include <bits/stdc++.h>',
    'int main(){ long long a,b; if(!(std::cin>>a>>b)) return 0; std::cout<<a+b<<"\\n"; }',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(SAMPLES, '1.in'), '1 2\n');
  fs.writeFileSync(path.join(SAMPLES, '1.out'), '3\n');
  fs.writeFileSync(path.join(SAMPLES, '2.in'), '10 20\n');
  fs.writeFileSync(path.join(SAMPLES, '2.out'), '999\n');   // 故意错的期望 → 用于验证「不通过 → 任务退出码 1」
}
setupWorkspace();

const paths = {
  mainSource: (pid, name) => path.join(PROB, name || 'main.cpp'),
  samplesDir: () => SAMPLES,
  tempDir: () => path.join(PROB, 'temp'),
  testResult: () => path.join(PROB, 'test', 'result.json'),
  testReport: () => path.join(PROB, 'test', 'report.md'),
};

/** 接线层只用到这三个方法 */
const store = {
  resolveContestDir: async () => paths,
  exists: async (f) => fs.existsSync(f),
  cachedContestPaths: () => paths,
};

let target;
const deps = {
  store,
  workspaceRoot: () => WS,
  resolveTarget: () => target,
  listSamples: (t) => WG.listSampleIndexes(store, t.cid, t.pid),
  log: () => {},
};

/** 收集任务写出的文本（不做 CRLF 转换，方便直接断言逻辑文本） */
function makeCtx() {
  const chunks = [];
  let child;
  return {
    ctx: {
      write: (s) => chunks.push(s),
      writeTerminal: (s) => chunks.push(s),
      attach: (c) => { child = c; },
    },
    text: () => chunks.join(''),
    child: () => child,
  };
}

async function main() {
  // ── 1. 任务命名（launch.json 的 preLaunchTask 就按这个名字匹配） ──
  console.log('\n[1] 任务命名');
  check('编译', TK.taskLabel({ task: 'compile' }), 'oj: 编译当前题目');
  check('测试', TK.taskLabel({ task: 'test' }), 'oj: 本地测试');
  check('强制重编译', TK.taskLabel({ task: 'compileForce' }), 'oj: 强制重新编译');
  check('跑一下带样例号', TK.taskLabel({ task: 'run', sample: 2 }), 'oj: 跑一下（样例 2）');
  check('跑一下没给序号时不带括号', TK.taskLabel({ task: 'run' }), 'oj: 跑一下');

  // ── 2. 任务列表随当前题目变化 ────────────────────────────────
  console.log('\n[2] provideTasks');
  const provider = new TK.OjTaskProvider(deps);
  target = { cid: '3775', pid: '0', title: 'A + B Problem' };
  const tasks = provider.provideTasks();
  check('三个基础任务', tasks.slice(0, 3).map((t) => t.name),
    ['oj: 编译当前题目', 'oj: 本地测试', 'oj: 强制重新编译']);
  check('按样例生成「跑一下」', tasks.slice(3).map((t) => t.name),
    ['oj: 跑一下（样例 1）', 'oj: 跑一下（样例 2）']);
  ok('全部是 oj 类型', tasks.every((t) => t.definition.type === 'oj'));

  target = undefined;
  check('没有当前题目时只给基础任务', provider.provideTasks().length, 3);

  const stub = env.vscode;
  const handWritten = new stub.Task({ type: 'oj', task: 'run', sample: 5 }, stub.TaskScope.Workspace, '随便写', 'oj', null);
  check('tasks.json 手写的定义能补全', provider.resolveTask(handWritten).name, 'oj: 跑一下（样例 5）');
  check('非 oj 类型不接管',
    provider.resolveTask(new stub.Task({ type: 'shell' }, stub.TaskScope.Workspace, 'x', 'y', null)), undefined);

  // ── 3. 终端文本：CRLF 与跨块 ────────────────────────────────
  console.log('\n[3] 终端文本转换');
  check('LF → CRLF', TM.toTerminalText('a\nb'), 'a\r\nb');
  check('已是 CRLF 不重复转换', TM.toTerminalText('a\r\nb'), 'a\r\nb');
  check('幂等', TM.toTerminalText(TM.toTerminalText('a\nb')), 'a\r\nb');

  const chunks = [];
  const write = TM.makeTerminalWriter((s) => chunks.push(s));
  write('第一行\r');
  write('\n第二行\n');
  check('跨数据块的 CRLF 不会多出一个回车', chunks.join(''), '第一行\r\n第二行\r\n');

  const half = [];
  const write2 = TM.makeTerminalWriter((s) => half.push(s));
  write2('尾巴是孤立的 CR\r');
  check('孤立的 CR 挂起到下一块', half.join(''), '尾巴是孤立的 CR');

  // ── 4. 伪终端：写入、关闭、退出码 ───────────────────────────
  console.log('\n[4] ProcessTerminal');
  const term = new TM.ProcessTerminal(async (ctx) => {
    ctx.write('第一行\n第二行\n');
    return 7;
  });
  let termText = '';
  let termCode = null;
  term.onDidWrite((s) => { termText += s; });
  term.onDidClose((c) => { termCode = c; });
  term.open();
  await sleep(60);
  check('写进去的是 CRLF', termText, '第一行\r\n第二行\r\n');
  check('关闭时带退出码', termCode, 7);

  const boom = new TM.ProcessTerminal(async () => { throw new Error('故意炸'); });
  let boomText = '';
  let boomCode = null;
  boom.onDidWrite((s) => { boomText += s; });
  boom.onDidClose((c) => { boomCode = c; });
  boom.open();
  await sleep(60);
  ok('任务抛异常也被兜住并说明', /故意炸/.test(boomText));
  check('异常退出码为 1', boomCode, 1);

  // ── 5. 关终端杀掉子进程（不留野进程） ────────────────────────
  console.log('\n[5] 关终端 → 杀掉正在跑的子进程');
  let sleeperExited = false;
  const sleeper = new TM.ProcessTerminal(async (ctx) => {
    ctx.write('长命进程启动\n');
    const child = TM.spawnToTerminal({
      argv: [NODE_EXE, '-e', 'setTimeout(()=>{}, 30000)'],   // 自己要跑 30 秒
      cwd: WS, env: process.env, sink: ctx.writeTerminal,
    });
    ctx.attach(child);
    const code = await child.done;
    sleeperExited = true;
    return code;
  });
  sleeper.open();
  await sleep(400);
  const t0 = Date.now();
  sleeper.close();                       // 模拟用户关掉任务终端
  while (!sleeperExited && Date.now() - t0 < 5000) { await sleep(50); }
  ok('关终端后子进程很快结束（被杀了，而不是等它自己跑完 30 秒）',
    sleeperExited && Date.now() - t0 < 5000);

  const silent = new TM.ProcessTerminal(async (ctx) => {
    await sleep(120);
    ctx.write('关闭之后才写的内容\n');
    return 0;
  });
  let silentText = '';
  silent.onDidWrite((s) => { silentText += s; });
  silent.open();
  silent.close();                        // 立刻关
  await sleep(250);
  check('关闭后不再往终端写', silentText, '');

  // ── 6. 找不到当前题目 ───────────────────────────────────────
  console.log('\n[6] 没有当前题目 → 说清楚');
  target = undefined;
  const noTarget = makeCtx();
  check('退出码 1', await TK.runOjTask({ task: 'compile' }, deps, noTarget.ctx), 1);
  ok('指出去哪儿点开题目', /侧边栏/.test(noTarget.text()));

  target = { cid: '3775', pid: '0', title: 'A + B Problem' };

  if (!HAS_GPP) {
    console.log(`\n  skip  未找到本机 g++（${GPP}），[7]–[10] 组跳过（不伪装成通过）。`);
    return;
  }

  // ── 7. 编译任务（真实 g++，且题目目录含中文） ────────────────
  console.log('\n[7] 编译任务（真实编译，题目目录含中文）');
  const c = makeCtx();
  check('编译成功 → 退出码 0', await TK.runOjTask({ task: 'compile' }, deps, c.ctx), 0);
  ok('回显了工具链', /g\+\+/.test(c.text()));
  ok('报出产物路径', /main\.exe/.test(c.text()));
  ok('产物真的落地了', fs.existsSync(path.join(PROB, 'temp', 'main.exe')));

  // ── 8. 跑一下：喂样例、实时输出、不判定 ─────────────────────
  console.log('\n[8] 跑一下（样例 2 → 10+20）');
  const r2 = makeCtx();
  check('跑完 → 退出码 0（不判定）', await TK.runOjTask({ task: 'run', sample: 2 }, deps, r2.ctx), 0);
  ok('输出里有程序的结果 30（流式写入，且是 CRLF）', /(^|\n)30\r\n/.test(r2.text()));
  ok('说明了输入来自哪组样例', /2\.in/.test(r2.text()));
  ok('说明了不支持手动输入', /不支持手动输入/.test(r2.text()));
  ok('给了退出码与耗时', /\[退出码 0，用时 \d+ ms\]/.test(r2.text()));

  // ── 9. 跑一下：样例序号越界退回第一组 ───────────────────────
  console.log('\n[9] 跑一下（越界序号退回样例 1）');
  const r9 = makeCtx();
  check('仍然跑成功', await TK.runOjTask({ task: 'run', sample: 99 }, deps, r9.ctx), 0);
  ok('实际用的是样例 1（输出 3）', /1\.in/.test(r9.text()) && /(^|\n)3\r\n/.test(r9.text()));

  // ── 10. 本地测试：判定结果反映到退出码 ──────────────────────
  console.log('\n[10] 本地测试（样例 2 期望是错的 → 退出码 1）');
  const t10 = makeCtx();
  check('有样例不通过 → 退出码 1', await TK.runOjTask({ task: 'test' }, deps, t10.ctx), 1);
  ok('列出了逐例结论', /用例 1\s+通过/.test(t10.text()) && /用例 2\s+不通过/.test(t10.text()));
  ok('给出了总览', /共 2 组：通过 1，不通过 1/.test(t10.text()));
  ok('落盘了报告', fs.existsSync(path.join(PROB, 'test', 'report.md')));

  // 把期望改对 → 应该全通过、退出码 0
  fs.writeFileSync(path.join(SAMPLES, '2.out'), '30\n');
  const t10b = makeCtx();
  check('全通过 → 退出码 0', await TK.runOjTask({ task: 'test' }, deps, t10b.ctx), 0);
  ok('报告全通过', /共 2 组：通过 2，不通过 0/.test(t10b.text()));

  // ── 11. 没有样例时给出可操作提示 ────────────────────────────
  console.log('\n[11] 没有样例');
  fs.rmSync(SAMPLES, { recursive: true, force: true });
  const t11 = makeCtx();
  check('跑一下 → 退出码 1', await TK.runOjTask({ task: 'run' }, deps, t11.ctx), 1);
  ok('提示去哪儿拿样例', /初始化本题/.test(t11.text()));
}

main().then(() => {
  cleanup(WS);
  process.exit(done() ? 0 : 1);
}).catch((e) => {
  console.error(e);
  cleanup(WS);
  process.exit(1);
});
