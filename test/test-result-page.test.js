// 结果页（webview/testResultWebview.ts）—— 两级结构 / 亮色 / 过期标记 / 零脚本
// 运行：node test/test-result-page.test.js
//
// 覆盖契约：C11（不引用 --vscode-* 主题变量）、C12（文案与报告同源）
// 覆盖决策：D12（两级）、D13（弹出与聚焦策略）、D14（过期标记）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installVscodeStub, makeChecker, cleanup } = require('./helpers/stub');

installVscodeStub();

const {
  buildResultHtml, buildResultModel, resultPagePlan, isSetupFailure, escapeHtml,
} = require('../out/webview/testResultWebview.js');
const { casePreviews, runtimeText } = require('../out/test/runner.js');

const { check, ok, done } = makeChecker();

// ───────────────────────────── 造数据 ─────────────────────────────

function caseOf(index, verdict, over = {}) {
  return {
    index,
    verdict,
    expectedBytes: 3,
    actualBytes: verdict === 'pass' ? 3 : 4,
    runtime: {
      exitCode: 0, signal: null, watchdog: null, durationMs: 12,
      rawBytes: 4, normalizedBytes: 4, stderrTail: '',
    },
    diff: verdict === 'fail'
      ? {
        line: 2, byteColumn: 1, offset: 4,
        expectedByte: 0x33, actualByte: 0x34,
        description: '首个差异：第 2 行第 1 个字节（偏移 4） · 期望 3 (0x33)，实际 4 (0x34)',
      }
      : null,
    ...over,
  };
}

function makeRun(over = {}) {
  return {
    version: 1,
    cid: '3772',
    pid: '0',
    title: '复杂度分析(Ⅰ)',
    toolchain: { id: 'cpp-g++', label: 'C/C++ (g++)', kind: 'compiled' },
    source: { file: 'C:/ws/3772-复杂度分析/main.cpp', hash: 'hash-from-run' },
    startedAt: '2026-09-14T09:00:00.000Z',
    durationMs: 1234,
    ok: true,
    build: {
      ok: true, reused: false, durationMs: 800,
      command: 'g++ -O2 main.cpp -o temp/main.exe', runnable: 'C:/ws/x/temp/main.exe', output: '',
    },
    summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
    cases: [caseOf(1, 'pass'), caseOf(2, 'fail')],
    skipped: [],
    resultFile: 'C:/ws/3772-复杂度分析/3772/temp/result.json',
    reportFile: 'C:/ws/3772-复杂度分析/3772/temp/report.md',
    ...over,
  };
}

/** 静默预览（不读盘），内容可指定 */
function previewsOf(map = {}) {
  return (c) => {
    const hit = map[c.index] || {};
    const wrap = (text) => ({ text: text ?? '', truncated: false, missing: text === undefined });
    return {
      input: wrap(hit.input ?? '1 2'),
      expected: wrap(hit.expected ?? '3\n'),
      actual: wrap(hit.actual ?? (c.verdict === 'pass' ? '3\n' : '4\n')),
    };
  };
}

const html = (r, ctx = {}) => buildResultHtml(buildResultModel(r, { previews: previewsOf(), ...ctx }));

// ───────────────────────────── 1. 弹出与聚焦策略（D13）─────────────────────────────
console.log('[1] 弹出与聚焦策略');
{
  const allPass = makeRun({ summary: { total: 2, passed: 2, failed: 0, skipped: 0 } });
  const hasFail = makeRun();
  const notRun = makeRun({ ok: false, reason: 'build-failed', cases: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0 } });

  check('always + 全通过 → 打开但不抢焦点', resultPagePlan('always', allPass), { open: true, focus: false });
  check('always + 有失败 → 打开并抢焦点', resultPagePlan('always', hasFail), { open: true, focus: true });
  check('onFailure + 全通过 → 不打开', resultPagePlan('onFailure', allPass), { open: false, focus: false });
  check('onFailure + 有失败 → 打开并抢焦点', resultPagePlan('onFailure', hasFail), { open: true, focus: true });
  check('onFailure + 没跑起来 → 打开（信息量最大的一屏）', resultPagePlan('onFailure', notRun), { open: true, focus: true });
  check('never → 不打开', resultPagePlan('never', hasFail), { open: false, focus: false });

  // 「还没跑起来」不是判定结果，配了 never 也要开 —— 编译器原文才是要给人看的东西
  const missingTools = makeRun({ ok: false, reason: 'toolchain-missing', cases: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0 } });
  const noCases = makeRun({ ok: false, reason: 'no-cases', cases: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0 } });
  const cancelled = makeRun({ ok: false, reason: 'cancelled', cases: [], summary: { total: 0, passed: 0, failed: 0, skipped: 0 } });
  check('never + 编译失败 → 仍然打开', resultPagePlan('never', notRun), { open: true, focus: true });
  check('never + 工具链缺失 → 仍然打开', resultPagePlan('never', missingTools), { open: true, focus: true });
  check('never + 没有用例 → 尊重配置（不算「还没跑起来」）', resultPagePlan('never', noCases), { open: false, focus: false });
  check('never + 已取消 → 尊重配置', resultPagePlan('never', cancelled), { open: false, focus: false });
  check('always + 编译失败 → 打开并抢焦点', resultPagePlan('always', notRun), { open: true, focus: true });
  check('isSetupFailure 只认这两类', [
    isSetupFailure('build-failed'), isSetupFailure('toolchain-missing'),
    isSetupFailure('no-cases'), isSetupFailure('cancelled'), isSetupFailure(undefined),
  ], [true, true, false, false, false]);
}

// ───────────────────────────── 2. 模型映射 ─────────────────────────────
console.log('\n[2] 引擎结果 → 页面模型');
{
  const m = buildResultModel(makeRun(), { previews: previewsOf(), currentSourceHash: 'changed' });
  check('标题', m.title, '复杂度分析(Ⅰ)');
  check('源文件名（只留基名）', m.sourceName, 'main.cpp');
  check('用例数', m.cases.length, 2);
  check('失败用例的运行事实文案与报告同源', m.cases[1].runtimeText, runtimeText(makeRun().cases[1]));
  check('差异定位透传（行）', m.cases[1].diffWhere.line, 2);
  check('通过用例没有差异定位', m.cases[0].diffWhere, null);
  check('哈希不同 → 过期', m.stale, true);
  check('哈希相同 → 不过期', buildResultModel(makeRun(), { previews: previewsOf(), currentSourceHash: 'hash-from-run' }).stale, false);
  check('拿不到哈希 → 不标过期（不敢瞎说）', buildResultModel(makeRun(), { previews: previewsOf() }).stale, false);
  check('无探测信息 → missingTools 为 null', m.missingTools, null);
  check('探测信息透传',
    buildResultModel(makeRun(), { previews: previewsOf(), missingTools: { missing: ['g++'], tried: ['PATH'] } }).missingTools,
    { missing: ['g++'], tried: ['PATH'] });
}

// ───────────────────────────── 3. 亮色与安全 ─────────────────────────────
console.log('\n[3] 亮色约定与注入防护（C11）');
{
  const page = html(makeRun());
  ok('声明 color-scheme: light', /color-scheme:\s*light/.test(page));
  ok('不含 --vscode- 主题变量', !page.includes('--vscode-'));
  ok('body 白底', /body\s*\{[^}]*background:\s*#fff/.test(page));
  ok('body 深字', /body\s*\{[^}]*color:\s*#333/.test(page));
  ok('是完整页面（DOCTYPE）', page.startsWith('<!DOCTYPE html>'));
  ok('零脚本（没有 <script>）', !/<script/i.test(page));
  ok('没有 emoji（无代理对字符）', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(page));

  // 程序输出是不可信内容：必须转义
  const evil = html(makeRun(), {
    previews: previewsOf({ 1: { actual: '<script>alert(1)</script>', expected: '</pre><img src=x onerror=alert(2)>' } }),
  });
  ok('实际输出里的 <script> 被转义', !/<script>alert/.test(evil));
  ok('转义成实体', evil.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  ok('期望输出里的 </pre> 被转义（不能让内容逃出代码块）', !evil.includes('</pre><img'));
  check('escapeHtml 处理引号', escapeHtml('a"b&c<d>'), 'a&quot;b&amp;c&lt;d&gt;');
}

// ───────────────────────────── 4. 两级结构与文案 ─────────────────────────────
console.log('\n[4] 两级结构（D12）');
{
  const page = html(makeRun());
  ok('一级用 <details> 承载用例', (page.match(/<details class="case/g) || []).length === 2);
  ok('一级有状态徽章', page.includes('<span class="badge pass">通过</span>') && page.includes('<span class="badge fail">不通过</span>'));
  ok('一级有用例序号与耗时', page.includes('用例 1') && page.includes('12 ms'));
  ok('一级有字节数对比', page.includes('期望 3 B / 实际 4 B'));
  ok('二级有三栏（输入 / 期望 / 实际）',
    page.includes('>输入<') && page.includes('>期望输出<') && page.includes('>实际输出（归一化后）<'));
  ok('二级有首个差异定位（行/字节/偏移）', page.includes('第 2 行') && page.includes('该行第 1 个字节') && page.includes('字节偏移 4'));
  ok('二级有差异原因（与报告同一句话）', page.includes('期望 3 (0x33)，实际 4 (0x34)'));
  ok('通过的用例也可展开看输出', page.includes('<span class="badge pass">通过</span>'));

  const allPass = html(makeRun({ summary: { total: 2, passed: 2, failed: 0, skipped: 0 } }));
  ok('全通过 → 顶部「全部通过」', allPass.includes('>全部通过</div>'));
  ok('有失败 → 顶部报不通过组数', page.includes('>1 组不通过</div>'));
}

// ───────────────────────────── 5. 各种「没跑起来」都要说清楚 ─────────────────────────────
console.log('\n[5] 未能开始的三屏');
{
  const missing = html(makeRun({
    ok: false, reason: 'toolchain-missing', cases: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
    build: { ok: false, reused: false, durationMs: 0, command: '', runnable: '', output: '' },
  }), { missingTools: { missing: ['g++', 'gcc'], tried: ['D:/tools/mingw64/bin'] } });
  ok('缺什么：点名命令', missing.includes('g++') && missing.includes('gcc'));
  ok('缺什么：列出找过的位置', missing.includes('D:/tools/mingw64/bin'));
  ok('缺什么：给出可操作建议', missing.includes('oj.test.searchDirs'));
  ok('标题说明是工具链问题', missing.includes('工具链不可用'));

  const buildFail = html(makeRun({
    ok: false, reason: 'build-failed', cases: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
    build: {
      ok: false, reused: false, durationMs: 300,
      command: 'g++ main.cpp -o temp/main.exe',
      runnable: '', output: "main.cpp:3:5: error: 'x' was not declared",
    },
  }));
  ok('编译失败：原样给出编译器输出', buildFail.includes('was not declared'));
  ok('编译失败：标红', buildFail.includes('pre class="err"'));

  const noCases = html(makeRun({
    ok: false, reason: 'no-cases', cases: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 1 },
    skipped: [{ index: 1, reason: '只有 1.in、缺少 1.out，无法判定' }],
  }));
  ok('没有用例：告诉去哪拿样例', noCases.includes('初始化这题'));
  ok('没有用例：跳过项逐条列出（不静默忽略）', noCases.includes('只有 1.in、缺少 1.out，无法判定'));
  ok('没有用例：提示不计入通过率', noCases.includes('不计入通过率'));
}

// ───────────────────────────── 6. 过期标记与截断 ─────────────────────────────
console.log('\n[6] 过期标记（D14）与长输出截断');
{
  ok('过期 → 顶部黄条', html(makeRun(), { currentSourceHash: 'changed' })
    .includes('代码已改动，这份结果可能已过期'));
  ok('不过期 → 没有黄条', !html(makeRun(), { currentSourceHash: 'hash-from-run' })
    .includes('代码已改动'));

  const truncated = html(makeRun(), {
    previews: previewsOf({ 2: { actual: '4\n', expected: '3\n' } }),
  });
  ok('内容正常时不标截断', !truncated.includes('已截断'));

  const withCut = buildResultHtml(buildResultModel(makeRun(), {
    previews: () => ({
      input: { text: '1 2', truncated: true, missing: false },
      expected: { text: '3\n', truncated: false, missing: false },
      actual: { text: '4\n', truncated: false, missing: false },
    }),
  }));
  ok('截断 → 标注', withCut.includes('内容过长，已截断'));
}

// ───────────────────────────── 7. 与报告同源的内容读取 ─────────────────────────────
console.log('\n[7] casePreviews：报告与页面共用同一份读取（C12）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsoj-result-'));
  const tempDir = path.join(dir, 'temp');
  const samples = path.join(dir, 'samples');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(samples, { recursive: true });

  fs.writeFileSync(path.join(samples, '1.in'), '1 2');
  fs.writeFileSync(path.join(samples, '1.out'), '3\n');
  fs.writeFileSync(path.join(tempDir, '1.out'), '4\r\n');   // 归一化后的实际输出

  const deps = {
    tempDir,
    cases: [{
      index: 1,
      inputFile: path.join(samples, '1.in'),
      expectedFile: path.join(samples, '1.out'),
    }],
  };
  const pv = casePreviews(deps, { index: 1 }, 1024);
  check('读到输入', pv.input.text, '1 2');
  check('读到期望', pv.expected.text, '3\n');
  check('读到实际', pv.actual.text, '4\r\n');
  check('都未截断', [pv.input.truncated, pv.expected.truncated, pv.actual.truncated], [false, false, false]);
  check('都不缺失', [pv.input.missing, pv.expected.missing, pv.actual.missing], [false, false, false]);

  // 缺文件 / 超长
  const pv2 = casePreviews({ tempDir, cases: [] }, { index: 9 }, 2);
  check('缺用例规格 → 三份都标记缺失', [pv2.input.missing, pv2.expected.missing, pv2.actual.missing], [true, true, true]);

  const pv3 = casePreviews(deps, { index: 1 }, 2);
  // '1 2'(3B) 与 '4\r\n'(3B) 超上限 → 截断；'3\n'(2B) 正好等于上限 → 不截断
  check('超过上限才截断（等于上限不算）',
    [pv3.input.truncated, pv3.expected.truncated, pv3.actual.truncated], [true, false, true]);

  cleanup(dir);
}

// ───────────────────────────── 8. 零脚本面板 ─────────────────────────────
console.log('\n[8] 面板薄壳：零脚本、不抢焦点');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'testResultWebview.ts'), 'utf8');
  ok('webview 不开 enableScripts', /enableScripts:\s*false/.test(src));
  ok('不注册 onDidReceiveMessage（没有消息通道）', !src.includes('onDidReceiveMessage'));
  ok('面板 reveal 用 preserveFocus 参数', src.includes('preserveFocus'));
}

process.exit(done() ? 0 : 1);
