// 本地测试引擎（test/runner.ts + test/watchdog.ts）—— 真实工具链端到端
// 运行：node test/runner.test.js
//
// 这组测试**不 mock 编译与执行**：用本机真实的 g++ 编译真实源码、跑真实样例、比真实字节。
// 引擎不依赖 VS Code，所以这件事做得到 —— 而它恰好是 S6 里最容易出错的一段
// （PATH 没注入 → 所有用例失败；换行没归一化 → 正确代码全 WA）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeChecker } = require('./helpers/stub');
const R = require('../out/test/runner.js');
const T = require('../out/test/toolchain.js');
const W = require('../out/test/watchdog.js');

const { check, ok, done } = makeChecker();

const GPP = process.env.VSOJ_TEST_GPP || 'D:\\usexxx\\gcc\\versions\\16.2.0\\mingw64\\bin\\g++.exe';
const NODE_EXE = process.execPath;
const HAS_GPP = fs.existsSync(GPP);

const root = path.join(os.tmpdir(), `vsoj-runner-${process.pid}`);
const tempDir = path.join(root, 'temp');
const testDir = path.join(root, 'test');
const samplesDir = path.join(root, 'samples');
const sourceFile = path.join(root, 'main.cpp');
const resultFile = path.join(testDir, 'result.json');
const reportFile = path.join(testDir, 'report.md');

function reset() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(samplesDir, { recursive: true });
}
reset();

const writeSource = (code) => fs.writeFileSync(sourceFile, code, 'utf8');
const writeSample = (i, input, output) => {
  fs.writeFileSync(path.join(samplesDir, `${i}.in`), input, 'utf8');
  if (output !== undefined) { fs.writeFileSync(path.join(samplesDir, `${i}.out`), output, 'utf8'); }
};
const listSamples = () => fs.readdirSync(samplesDir);

function cppToolchain(over = {}) {
  return {
    ...T.builtinToolchains()[0],
    commands: { gpp: [GPP] },
    ...over,
  };
}

function makeRunner(over = {}) {
  const files = listSamples();
  const { cases, skipped } = R.discoverCases({
    files,
    inputFile: (i) => path.join(samplesDir, `${i}.in`),
    outputFile: (i) => path.join(samplesDir, `${i}.out`),
  });
  return new R.LocalTestRunner({
    toolchain: cppToolchain(over.toolchain || {}),
    resolved: { gpp: GPP },
    sourceFile, sourceDir: root, tempDir, resultFile, reportFile,
    cases, skipped,
    meta: { cid: '3775', pid: '0', title: 'A + B Problem' },
    ...over.deps,
  });
}

// ── 1. 用例发现（决策 D9：半对跳过但必须点名） ────────────────────────────
console.log('[1] 用例发现');
const disc = R.discoverCases({
  files: ['1.in', '1.out', '2.in', '2.out', '3.in', 'notes.txt', '10.in', '10.out', '2.err'],
  inputFile: (i) => `in${i}`, outputFile: (i) => `out${i}`,
});
check('成对用例（按序号排序）', disc.cases.map(c => c.index), [1, 2, 10]);
check('半对进 skipped', disc.skipped.map(s => s.index), [3]);
ok('跳过原因说清楚', /缺少 3\.out/.test(disc.skipped[0].reason));
check('非样例文件被忽略', disc.cases.length + disc.skipped.length, 4);
check('空目录不崩', R.discoverCases({ files: [], inputFile: () => '', outputFile: () => '' }).cases, []);

// ── 2. 全链路：正确代码 → 全通过（含 CRLF 归一化） ────────────────────────
// 引擎是异步的，用 main() 包起来（顶层 await 与 require 不能共存）
async function main() {
if (HAS_GPP) {
  console.log('\n[2] 真实编译 + 真实运行 + 严格比对');
  writeSource([
    '#include <bits/stdc++.h>',
    'using namespace std;',
    'int main(){ long long a,b; if(!(cin>>a>>b)) return 0; cout<<a+b<<"\\n"; return 0; }',
    '',
  ].join('\n'));
  writeSample(1, '1 2\n', '3\n');
  writeSample(2, '1000000000 2000000000\n', '3000000000\n');
  writeSample(3, '5 7\n');                        // 半对：只有输入
  writeSample(4, '1 2\n', '4\n');                 // 期望故意写错 → 必不通过

  const r1 = await makeRunner().run();
  check('工具链识别为编译型', r1.toolchain.kind, 'compiled');
  check('判定：通过 2 组（1、2）', r1.summary.passed, 2);
  check('判定：不通过 1 组（期望故意写错的第 4 组）', r1.summary.failed, 1);
  check('跳过的半对进入 summary', r1.summary.skipped, 1);
  check('整体 ok', r1.ok, true);
  check('编译成功', r1.build.ok, true);
  check('首次编译非复用', r1.build.reused, false);
  ok('编译命令可核对', r1.build.command.includes('-std=c++17'));
  check('通过用例的 diff 为 null', r1.cases.filter(c => c.verdict === 'pass').every(c => c.diff === null), true);

  const failCase = r1.cases.find(c => c.verdict === 'fail');
  check('失败用例定位到第 1 行第 1 字节', [failCase.diff.line, failCase.diff.byteColumn], [1, 1]);

  console.log('\n[3] 换行归一化的真实证据（决策 D6/D15）');
  const rawFile = path.join(tempDir, '1.raw.out');
  const normFile = path.join(tempDir, '1.out');
  check('原始输出确实是 CRLF（Windows 文本模式）', fs.readFileSync(rawFile).toString('hex'), '330d0a');
  check('归一化副本是 LF', fs.readFileSync(normFile).toString('hex'), '330a');
  check('原始字节数', r1.cases.find(c => c.index === 1).runtime.rawBytes, 3);
  check('归一化后字节数', r1.cases.find(c => c.index === 1).runtime.normalizedBytes, 2);
  check('用例 1 判定为通过（否则说明归一化没生效）', r1.cases.find(c => c.index === 1).verdict, 'pass');

  console.log('\n[4] 结果产物');
  const json = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  check('result.json 版本', json.version, 1);
  check('result.json 记源文件哈希（供过期判定 D14）', json.source.hash.length, 40);
  check('result.json 的源路径与 deps 一致', json.source.file, sourceFile);
  check('result.json 只有 pass/fail 两种判定',
    [...new Set(json.cases.map(c => c.verdict))].sort(), ['fail', 'pass']);
  const md = fs.readFileSync(reportFile, 'utf8');
  ok('report.md 是中文报告', md.includes('# 本地测试报告'));
  ok('report.md 写出结论', /结论：1 组不通过/.test(md));
  ok('report.md 写出跳过说明（不得静默忽略）', /第 3 组/.test(md) && /缺少 3\.out/.test(md));
  ok('report.md 声明判定口径', /严格逐字节比较/.test(md));
  ok('report.md 含期望/实际对照', md.includes('期望输出') && md.includes('实际输出'));

  console.log('\n[5] 产物复用（决策 D5：按内容哈希）');
  const r2 = await makeRunner().run();
  check('第二次命中复用', r2.build.reused, true);
  check('复用后仍全量跑用例', r2.summary.total, 3);
  check('复用不改变判定', [r2.summary.passed, r2.summary.failed], [2, 1]);

  writeSource([
    '#include <bits/stdc++.h>',
    'using namespace std;',
    'int main(){ long long a,b; if(!(cin>>a>>b)) return 0; cout<<a*b<<"\\n"; return 0; }',
    '',
  ].join('\n'));
  const r3 = await makeRunner().run();
  check('改了源文件 → 重新编译', r3.build.reused, false);
  check('改成乘法后样例 1、2 都不通过', [r3.summary.passed, r3.summary.failed], [0, 3]);

  console.log('\n[6] 看门狗：死循环（决策 D8）');
  reset();
  writeSource('#include <bits/stdc++.h>\nint main(){ volatile long long x=0; while(1) x++; return 0; }\n');
  writeSample(1, '1 2\n', '3\n');
  const rLoop = await makeRunner({ toolchain: { timeoutMs: 1500 } }).run();
  const loopCase = rLoop.cases[0];
  check('死循环判为不通过', loopCase.verdict, 'fail');
  check('触发的是时间闸', loopCase.runtime.watchdog, 'time');
  ok('给出触发原因', /超过 1500 ms/.test(loopCase.runtime.killReason || ''));
  ok('报告里如实记录运行事实', /看门狗终止/.test(fs.readFileSync(reportFile, 'utf8')));
  ok('进程确实结束了（没有残留）', loopCase.runtime.durationMs < 8000);

  console.log('\n[7] 看门狗：狂打印（输出体积闸）');
  reset();
  writeSource('#include <bits/stdc++.h>\nint main(){ for(;;) printf("0123456789012345678901234567890123456789\\n"); }\n');
  writeSample(1, 'x\n', 'never\n');
  const rPrint = await makeRunner({ toolchain: { timeoutMs: 20000, maxOutputBytes: 256 * 1024 } }).run();
  check('狂打印被体积闸拦住', rPrint.cases[0].runtime.watchdog, 'size');
  ok('报告说明是体积闸', /输出超过/.test(rPrint.cases[0].runtime.killReason || ''));

  console.log('\n[8] 编译失败（契约 C3：原样回传编译器输出，不进入运行阶段）');
  reset();
  writeSource('#include <bits/stdc++.h>\nint main(){ this is not c++ }\n');
  writeSample(1, '1 2\n', '3\n');
  const rBad = await makeRunner().run();
  check('原因标记为 build-failed', rBad.reason, 'build-failed');
  check('不产出任何用例结论', rBad.cases, []);
  check('整体 ok=false', rBad.ok, false);
  ok('编译器报错原样回传', /error/.test(rBad.build.output));
  ok('report.md 写明编译失败', /未能开始：编译失败/.test(fs.readFileSync(reportFile, 'utf8')));

  console.log('\n[9] 工具链不可用时不装死，给出可操作的指引');
  reset();
  writeSource('#include <bits/stdc++.h>\nint main(){ return 0; }\n');
  writeSample(1, '1 2\n', '3\n');
  const rMissing = await makeRunner({ deps: { missing: ['gpp'], tried: ['C:\\bin\\g++.exe', 'D:\\bin\\g++.exe'] } }).run();
  check('原因标记为 toolchain-missing', rMissing.reason, 'toolchain-missing');
  ok('提示里含「写成绝对路径」的引导', /绝对路径/.test(rMissing.build.output));
  ok('提示里列了探测过的位置', /已探测过 2 个位置/.test(rMissing.build.output));

  console.log('\n[10] 解释型工具链：prepare 是空转（差异被关在工具链里）');
  reset();
  fs.writeFileSync(path.join(root, 'main.js'), 'process.stdout.write("3\\n");\n', 'utf8');
  writeSample(1, '1 2\n', '3\n');
  const jsRunner = new R.LocalTestRunner({
    toolchain: {
      id: 'node', label: 'Node.js', kind: 'interpreted', extensions: ['.js'],
      commands: { node: [NODE_EXE] }, run: '"{node}" "{runnable}"',
    },
    resolved: { node: NODE_EXE },
    sourceFile: path.join(root, 'main.js'), sourceDir: root, tempDir, resultFile, reportFile,
    cases: [{ index: 1, inputFile: path.join(samplesDir, '1.in'), expectedFile: path.join(samplesDir, '1.out') }],
    meta: { cid: '3775', pid: '0', title: 'JS 题目' },
  });
  const rJs = await jsRunner.run();
  check('解释型不需要编译', [rJs.build.ok, rJs.build.reused], [true, true]);
  check('runnable 就是源文件本身', rJs.build.runnable, path.join(root, 'main.js'));
  check('解释型同样能判定通过', rJs.summary.passed, 1);

  console.log('\n[11] PATH 注入的必要性（这条是实测踩出来的坑）');
  reset();
  writeSource('#include <bits/stdc++.h>\nint main(){ long long a,b; std::cin>>a>>b; std::cout<<a+b<<"\\n"; }\n');
  writeSample(1, '1 2\n', '3\n');
  await makeRunner().run();                       // 先正常编译一次
  const exe = path.join(tempDir, 'main.exe');
  ok('产物已生成', fs.existsSync(exe));

  const brokenOut = path.join(tempDir, 'broken.out');
  const brokenErr = path.join(tempDir, 'broken.err');
  const broken = await W.runProcess({
    command: exe, args: [], cwd: root,
    env: { ...process.env, PATH: 'C:\\Windows' },   // 故意不给 mingw 的 bin
    inFile: path.join(samplesDir, '1.in'), outFile: brokenOut, errFile: brokenErr,
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 * 1024, maxMemoryBytes: 1024 * 1024 * 1024 },
  });
  const brokenText = fs.existsSync(brokenOut) ? fs.readFileSync(brokenOut, 'utf8') : '';
  ok('不给 mingw bin 时产物起不来（正是「所有样例都失败」的成因）',
    broken.exitCode !== 0 || brokenText.trim() === '');

  const okOut = path.join(tempDir, 'ok.out');
  const good = await W.runProcess({
    command: exe, args: [], cwd: root,
    env: T.buildEnv(cppToolchain(), { gpp: GPP }),   // 工具链推导出的 PATH
    inFile: path.join(samplesDir, '1.in'), outFile: okOut, errFile: path.join(tempDir, 'ok.err'),
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 * 1024, maxMemoryBytes: 1024 * 1024 * 1024 },
  });
  check('注入推导出的 PATH 后正常退出', good.exitCode, 0);
  check('注入后输出正确', fs.readFileSync(okOut, 'utf8').replace(/\r/g, '').trim(), '3');
} else {
  console.log(`\n  skip  未找到本机 g++（${GPP}），[2]–[11] 组跳过。`);
  console.log('       这组测试刻意不 mock：没有真实工具链就说明「测不了」，而不是伪装成通过。');
}
}

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(done() ? 0 : 1);
});
