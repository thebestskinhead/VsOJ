/**
 * S6.3 接线层测试 —— 选工具链 / 发现样例 / 拼路径 / 配置真的生效
 *
 * 运行：npm run test:wiring
 *
 * 这里刻意**不 mock 引擎**：接线层的价值就在于「引擎要的东西能不能被正确凑出来」，
 * 把它再 mock 一遍等于什么都没测。store 用一个只实现两个方法的假对象
 * （`resolveContestDir` / `exists`）—— 接线层只用到这两个。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { installVscodeStub, makeChecker, cleanup } = require('./helpers/stub');

const WS = path.join(os.tmpdir(), `vsoj-wiring-${process.pid}`);
const env = installVscodeStub({
  'oj.test.toolchain': 'auto',
  'oj.test.toolchainsFile': '.vsoj/toolchains.json',
  'oj.test.searchDirs': [],
  'oj.test.reuseBuild': false,
}, { workspaceFolder: WS, fresh: true });

const W = require('../out/test/wiring.js');
const T = require('../out/test/toolchain.js');
const { check, ok, done } = makeChecker();

const CID = '3775';
const PID = '0';
const PROB = path.join(WS, '3775-新生赛', 'problems', 'A-A+B问题');
const SAMPLES = path.join(PROB, 'samples');

function makePaths() {
  return {
    mainSource: (pid, name) => path.join(PROB, name || 'main.cpp'),
    samplesDir: () => SAMPLES,
    tempDir: () => path.join(PROB, 'temp'),
    testResult: () => path.join(PROB, 'test', 'result.json'),
    testReport: () => path.join(PROB, 'test', 'report.md'),
  };
}

/** 接线层只用到 resolveContestDir / exists，所以假 store 只要这两个 */
function makeStore(paths) {
  return {
    resolveContestDir: async () => paths,
    exists: async (f) => fs.existsSync(f),
  };
}

function resetProblemDirs() {
  fs.rmSync(PROB, { recursive: true, force: true });
  fs.mkdirSync(SAMPLES, { recursive: true });
  fs.mkdirSync(path.join(PROB, 'temp'), { recursive: true });
  fs.mkdirSync(path.join(PROB, 'test'), { recursive: true });
  fs.mkdirSync(path.join(WS, '.vsoj'), { recursive: true });
  fs.rmSync(path.join(WS, '.vsoj', 'toolchains.json'), { force: true });
}

async function build(extra = {}) {
  return W.buildTestDeps({
    store: makeStore(makePaths()),
    cid: CID,
    pid: PID,
    workspaceRoot: WS,
    title: 'A + B Problem',
    ...extra,
  });
}

async function main() {
  resetProblemDirs();

  // ── 1. 选工具链 ──────────────────────────────────────────────
  console.log('\n[1] 选工具链（配置指定 vs 按扩展名匹配）');
  const defs = T.builtinToolchains();
  check('auto 认领 .cpp', W.selectToolchain(defs, 'auto', '/x/main.cpp').id, 'cpp-g++');
  check('auto 认领 .c', W.selectToolchain(defs, 'auto', '/x/main.c').id, 'c-gcc');
  check('auto 认领 .java', W.selectToolchain(defs, 'auto', '/x/Main.java').id, 'java');
  check('auto 认领 .py', W.selectToolchain(defs, 'auto', '/x/sol.py').id, 'python');
  check('不认识的扩展名 → 无匹配', W.selectToolchain(defs, 'auto', '/x/sol.rb'), undefined);
  check('指定 id 优先于扩展名', W.selectToolchain(defs, 'python', '/x/main.cpp').id, 'python');
  check('指定的 id 不存在 → 无匹配', W.selectToolchain(defs, 'nope', '/x/main.cpp'), undefined);

  // ── 2. 「跑一下」用哪组样例 ─────────────────────────────────
  console.log('\n[2] pickSampleInput');
  const fakeCases = { cases: [{ index: 1, inputFile: '/a/1.in' }, { index: 3, inputFile: '/a/3.in' }] };
  check('取指定序号', W.pickSampleInput(fakeCases, 3), '/a/3.in');
  check('序号不存在退回第一组', W.pickSampleInput(fakeCases, 9), '/a/1.in');
  check('一组样例都没有 → undefined', W.pickSampleInput({ cases: [] }, 1), undefined);

  // ── 3. 比赛目录还没建立 ──────────────────────────────────────
  console.log('\n[3] 比赛目录没建立 → 可操作的错误');
  const noDir = await W.buildTestDeps({
    store: { resolveContestDir: async () => undefined, exists: async () => false },
    cid: CID, pid: PID, workspaceRoot: WS,
  });
  check('给出 ok:false', noDir.ok, false);
  ok('文案指出去哪儿建目录', /进入这场比赛/.test(noDir.error));

  // ── 4. 源文件还没写 ─────────────────────────────────────────
  console.log('\n[4] 源文件不存在 → 可操作的错误');
  const noSrc = await build();
  check('给出 ok:false', noSrc.ok, false);
  ok('文案指到具体路径', noSrc.error.includes(path.join('A-A+B问题', 'main.cpp')));
  ok('文案说明怎么建', /点开这道题/.test(noSrc.error));

  // ── 5. 正常装配 ─────────────────────────────────────────────
  console.log('\n[5] 正常装配（样例成对 + 半对跳过）');
  fs.writeFileSync(path.join(PROB, 'main.cpp'), 'int main(){return 0;}\n');
  fs.writeFileSync(path.join(SAMPLES, '1.in'), '1 2\n');
  fs.writeFileSync(path.join(SAMPLES, '1.out'), '3\n');
  fs.writeFileSync(path.join(SAMPLES, '2.in'), '5 5\n');           // 半对：没有 2.out
  fs.writeFileSync(path.join(SAMPLES, 'readme.txt'), 'x');          // 无关文件

  const good = await build();
  check('装配成功', good.ok, true);
  if (good.ok) {
    const d = good.deps;
    check('源文件路径', d.sourceFile, path.join(PROB, 'main.cpp'));
    check('cwd 就是题目目录', d.sourceDir, PROB);
    check('temp 目录', d.tempDir, path.join(PROB, 'temp'));
    check('结果文件', d.resultFile, path.join(PROB, 'test', 'result.json'));
    check('报告文件', d.reportFile, path.join(PROB, 'test', 'report.md'));
    check('元信息带 cid/pid/title', [d.meta.cid, d.meta.pid, d.meta.title], [CID, PID, 'A + B Problem']);
    check('成对样例被发现', d.cases.map((c) => c.index), [1]);
    check('半对被跳过（不静默）', d.skipped.map((s) => s.index), [2]);
    ok('跳过原因可读', !!d.skipped[0].reason);
    check('无关文件不参与', d.cases.length + d.skipped.length, 2);
  }

  // ── 6. 产物复用开关 → forceRebuild ──────────────────────────
  console.log('\n[6] reuseBuild 配置 → forceRebuild 语义');
  env.config['oj.test.reuseBuild'] = false;
  const fresh1 = await build();
  check('默认（不复用）→ 每次重编', fresh1.ok && fresh1.deps.forceRebuild, true);
  env.config['oj.test.reuseBuild'] = true;
  const fresh2 = await build();
  check('开启复用 → 允许命中缓存', fresh2.ok && fresh2.deps.forceRebuild, false);
  const forced = await build({ forceRebuild: true });
  check('显式强制 → 覆盖配置', forced.ok && forced.deps.forceRebuild, true);
  env.config['oj.test.reuseBuild'] = false;

  // ── 7. 工具链不匹配 ─────────────────────────────────────────
  console.log('\n[7] 认领不了的文件类型 → 列出可用 id');
  fs.writeFileSync(path.join(PROB, 'sol.rb'), 'puts 1\n');
  env.config['oj.test.toolchain'] = 'auto';
  const noMatch = await W.buildTestDeps({
    store: makeStore({
      mainSource: () => path.join(PROB, 'sol.rb'),
      samplesDir: () => SAMPLES,
      tempDir: () => path.join(PROB, 'temp'),
      testResult: () => path.join(PROB, 'test', 'result.json'),
      testReport: () => path.join(PROB, 'test', 'report.md'),
    }),
    cid: CID, pid: PID, workspaceRoot: WS,
  });
  check('不给匹配结果', noMatch.ok, false);
  ok('文案列出可用工具链', /cpp-g\+\+/.test(noMatch.error) && /python/.test(noMatch.error));
  ok('文案指向配置文件', /toolchains\.json/.test(noMatch.error));

  env.config['oj.test.toolchain'] = 'no-such-id';
  const noSuch = await build();
  check('指定了不存在的 id → 失败', noSuch.ok, false);
  ok('文案点出是配置里指定的 id 不存在', /不存在/.test(noSuch.error));
  env.config['oj.test.toolchain'] = 'auto';

  // ── 8. toolchains.json：覆盖内置 + 坏条目只记账 ─────────────
  console.log('\n[8] toolchains.json 覆盖与容错');
  const tcFile = path.join(WS, '.vsoj', 'toolchains.json');
  fs.writeFileSync(tcFile, JSON.stringify({
    toolchains: [
      // 覆盖内置：把 gpp 指到一个必然存在的可执行文件（Node 本体），顺便验证命令解析
      { id: 'cpp-g++', extensions: ['.cpp'], compile: '"{gpp}" -o "{output}" "{source}"', run: '"{runnable}"', timeoutMs: 4242,
        commands: { gpp: [process.execPath] } },
      { id: 'broken-one' },   // 坏条目：缺 run
    ],
  }, null, 2), 'utf8');

  const withFile = await build();
  check('仍然装配成功（一份坏 json 不该让功能瘫痪）', withFile.ok, true);
  if (withFile.ok) {
    check('内置项被覆盖（timeoutMs）', withFile.deps.toolchain.timeoutMs, 4242);
    check('覆盖项的命令解析到绝对路径', withFile.deps.resolved.gpp, process.execPath);
    ok('坏条目被记进 notes 而不是抛异常', withFile.notes.some((n) => n.includes('toolchains.json：')));
  }
  fs.rmSync(tcFile, { force: true });

  // ── 9. 全局阈值并进工具链（工具链自身声明优先） ──────────────
  console.log('\n[9] 看门狗阈值：全局默认 vs 工具链覆盖');
  env.config['oj.test.timeoutMs'] = 1234;
  env.config['oj.test.maxOutputBytes'] = 5678;
  const limited = await build();
  if (limited.ok) {
    check('全局超时并进工具链', limited.deps.toolchain.timeoutMs, 1234);
    check('全局输出上限并进工具链', limited.deps.toolchain.maxOutputBytes, 5678);
  }
  fs.writeFileSync(tcFile, JSON.stringify({
    toolchains: [{ id: 'cpp-g++', extensions: ['.cpp'], commands: { gpp: [process.execPath] }, run: '"{runnable}"', timeoutMs: 99 }],
  }), 'utf8');
  const overridden = await build();
  if (overridden.ok) {
    check('工具链自己声明的优先', overridden.deps.toolchain.timeoutMs, 99);
  }
  fs.rmSync(tcFile, { force: true });
  delete env.config['oj.test.timeoutMs'];
  delete env.config['oj.test.maxOutputBytes'];

  // ── 10. 样例目录为空时的提示 ────────────────────────────────
  console.log('\n[10] 没有样例时不静默');
  fs.rmSync(SAMPLES, { recursive: true, force: true });
  const empty = await build();
  check('装配仍然成功（用例为空交给引擎报 no-cases）', empty.ok, true);
  if (empty.ok) {
    check('用例为空', empty.deps.cases.length, 0);
    ok('notes 提示 samples/ 是空的', empty.notes.some((n) => /samples\//.test(n)));
  }
}

main().then(() => {
  cleanup(WS);
  process.exit(done() ? 0 : 1);
}).catch((e) => {
  console.error(e);
  cleanup(WS);
  process.exit(1);
});
