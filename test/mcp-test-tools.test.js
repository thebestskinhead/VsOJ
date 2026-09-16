/**
 * S6.7 MCP 测试工具 —— 编译 / 本地测试 / 读最近结果
 *
 * 运行：npm run test:mcp-test-tools
 *
 * 这个套件走 **真实的 `McpToolHandler`**（MCP 的真实入口），配 **真实的引擎**
 * （`buildTestDeps` → `LocalTestRunner` → 真 g++ 编译真源码跑真样例），
 * 唯一假的是 store（只实现 `resolveContestDir` / `exists` / `listProblemAssets`）
 * 与 `ContestService` / `ProblemService`（会走网络的那两个）。
 *
 * 所以它验证的是「AI 调到 MCP、MCP 调到引擎」这条链路真的通 —— 而不是「函数能返回字符串」。
 * 找不到 g++ 时相关用例降级为 skip 并显式说明，不伪装成通过。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { installVscodeStub, makeChecker, cleanup } = require('./helpers/stub');

const WS = path.join(os.tmpdir(), `vsoj-mcp-test-${process.pid}`);
const env = installVscodeStub({
  'oj.test.toolchain': 'auto',
  'oj.test.toolchainsFile': '.vsoj/toolchains.json',
  'oj.test.searchDirs': [],
  'oj.test.reuseBuild': false,
  'oj.project.sourceFileName': 'main.cpp',
}, { workspaceFolder: WS, fresh: true });

const H = require('../out/mcp/tools.js');
const TT = require('../out/test/tools.js');
const W = require('../out/test/wiring.js');
const RES = require('../out/workspace/resources.js');

const { check, ok, done } = makeChecker();

const CID = '3775';
const PID = '0';
const PROB = path.join(WS, '3775-数据结构课', 'problems', 'A-A+B问题');
const SAMPLES = path.join(PROB, 'samples');
const ASSETS = path.join(PROB, 'assets');
const TESTDIR = path.join(PROB, 'test');
const RESULT_FILE = path.join(TESTDIR, 'result.json');
const REPORT_FILE = path.join(TESTDIR, 'report.md');
const SOURCE = path.join(PROB, 'main.cpp');
const TC_FILE = path.join(WS, '.vsoj', 'toolchains.json');

const GPP = process.env.VSOJ_TEST_GPP || 'D:\\usexxx\\gcc\\versions\\16.2.0\\mingw64\\bin\\g++.exe';
const HAS_GPP = fs.existsSync(GPP);

/** 假 store：只实现接线层与资源层真正用到的那三个方法 */
function makeStore(available = true) {
  const paths = available ? makePaths() : undefined;
  return {
    resolveContestDir: async () => paths,
    exists: async (f) => fs.existsSync(f),
    listProblemAssets: async () => {
      try { return fs.readdirSync(ASSETS); } catch { return []; }
    },
  };
}

function makePaths() {
  return {
    problemDir: () => PROB,
    problemAssetsDir: () => ASSETS,
    samplesDir: () => SAMPLES,
    mainSource: (pid, name) => path.join(PROB, name || 'main.cpp'),
    tempDir: () => path.join(PROB, 'temp'),
    testResult: () => RESULT_FILE,
    testReport: () => REPORT_FILE,
  };
}

/** 当前题目（可切换，用来验证「不传 cid/pid 时用当前题目」） */
let current = { cid: CID, pid: PID, title: 'A + B Problem' };

function collect(cid, pid, available = true) {
  return RES.collectProblemResources({
    store: makeStore(available), cid, pid, sourceFileName: 'main.cpp',
  });
}

function makeHandler(storeAvailable = true) {
  const service = new TT.TestToolService({
    buildDeps: (cid, pid, o) => W.buildTestDeps({
      store: makeStore(storeAvailable),
      cid, pid,
      workspaceRoot: WS,
      title: o.title ?? '',
      ...(o.forceRebuild === undefined ? {} : { forceRebuild: o.forceRebuild }),
      ...(o.sourceFileName ? { sourceFileName: o.sourceFileName } : {}),
    }),
    currentTarget: () => current,
    resources: (cid, pid) => collect(cid, pid, storeAvailable),
    // 写样例：这里直接落盘到题目的 samples/（生产路径由 extension 包 CacheStore + cache/paths）
    writeSample: async ({ index, input, output }) => {
      const inputFile = path.join(SAMPLES, `${index}.in`);
      const outputFile = path.join(SAMPLES, `${index}.out`);
      try {
        fs.mkdirSync(SAMPLES, { recursive: true });
        fs.writeFileSync(inputFile, input, 'utf8');
        fs.writeFileSync(outputFile, output, 'utf8');
        return { ok: true, inputFile, outputFile };
      } catch (e) {
        return { ok: false, inputFile, outputFile, error: String(e) };
      }
    },
    readText: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } },
    readSource: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } },
  });

  // 只用到 fetchProblem 的网络服务用桩顶掉；其余走真实实现
  const contest = {
    fetchProblemList: async () => ({
      title: '数据结构课', problems: [], meta: { source: 'network', ageMs: 0 },
    }),
    fetchList: async () => ({
      rows: [], pagination: { current: 1, total: 1 }, meta: { source: 'network', ageMs: 0 },
    }),
  };
  const problem = {
    fetchProblem: async (cid, pid) => ({
      detail: {
        cid, pid, title: 'A + B Problem',
        description: '<p>读两个数，输出它们的和。</p>',
        inputDesc: '<p>一行两个整数。</p>',
        outputDesc: '<p>一个整数。</p>',
        sampleInput: '1 2', sampleOutput: '3',
      },
      html: '<html></html>',
      source: 'network',
      ageMs: 0,
      refreshing: false,
    }),
  };
  const state = { getCurrentCid: () => current.cid, getCurrentPid: () => current.pid };

  return new H.McpToolHandler(contest, problem, state, undefined, service,
    (c, p) => collect(c, p, storeAvailable));
}

/** 调一次工具，取回文本 */
async function call(handler, name, args = {}) {
  const r = await handler.callTool(name, args);
  return r.content[0].text;
}

function resetProblem() {
  fs.rmSync(PROB, { recursive: true, force: true });
  fs.mkdirSync(SAMPLES, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(TESTDIR, { recursive: true });
  fs.mkdirSync(path.join(PROB, 'temp'), { recursive: true });
  fs.mkdirSync(path.join(WS, '.vsoj'), { recursive: true });
  fs.rmSync(TC_FILE, { force: true });
}

/** 把 g++ 指到真实路径（用户环境的典型样子：不在 PATH 里，靠 toolchains.json 指定） */
function writeGppToolchain() {
  fs.writeFileSync(TC_FILE, JSON.stringify({
    toolchains: [{
      id: 'cpp-g++', extensions: ['.cpp'],
      commands: { gpp: [GPP] },
    }],
  }, null, 2), 'utf8');
}

const CORRECT = '#include <cstdio>\nint main(){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);return 0;}\n';
const OFF_BY_ONE = '#include <cstdio>\nint main(){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b+1);return 0;}\n';
const BROKEN = '#include <cstdio>\nint main(){ this is not c++ }\n';

const sample = (i, input, output) => {
  fs.writeFileSync(path.join(SAMPLES, `${i}.in`), input, 'utf8');
  if (output !== undefined) { fs.writeFileSync(path.join(SAMPLES, `${i}.out`), output, 'utf8'); }
};

async function main() {
  resetProblem();
  const handler = makeHandler();

  // ── 1. 工具注册表 ────────────────────────────────────────────
  console.log('\n[1] 工具注册表');
  const names = handler.listTools().map((t) => t.name);
  ok('注册了 compile_problem', names.includes('compile_problem'));
  ok('注册了 run_local_test', names.includes('run_local_test'));
  ok('注册了 get_last_test_result', names.includes('get_last_test_result'));
  ok('注册了 add_test_case', names.includes('add_test_case'));
  check('工具总数（原 5 + 新 4）', names.length, 9);
  check('工具名不重复', names.length, new Set(names).size);
  ok('没有「读图片」的独立工具（图片走 get_current_problem 的路径）',
    !names.some((n) => /asset|image|图片/i.test(n)));

  const tool = (n) => handler.listTools().find((t) => t.name === n);
  ok('get_last_test_result 支持 format 枚举',
    JSON.stringify((tool('get_last_test_result').inputSchema.properties.format.enum)) === '["markdown","json"]');
  ok('四个工具都声明了 cid/pid', ['compile_problem', 'run_local_test', 'add_test_case', 'get_last_test_result']
    .every((n) => 'cid' in tool(n).inputSchema.properties && 'pid' in tool(n).inputSchema.properties));
  ok('三个执行工具都不需要必填 cid/pid',
    ['compile_problem', 'run_local_test', 'get_last_test_result']
      .every((n) => tool(n).inputSchema.required.length === 0));
  check('add_test_case 必填 input/output', tool('add_test_case').inputSchema.required, ['input', 'output']);
  ok('compile_problem / run_local_test 支持 source 参数',
    ['compile_problem', 'run_local_test'].every((n) => 'source' in tool(n).inputSchema.properties));
  ok('add_test_case 的 input/output 都有说明', ['input', 'output']
    .every((k) => typeof tool('add_test_case').inputSchema.properties[k].description === 'string'));

  // ── 2. get_current_problem 的 local 段 ───────────────────────
  console.log('\n[2] get_current_problem 补本地路径（决策 D11：不内联图片）');
  const noDirHandler = makeHandler(false);
  const noDir = JSON.parse(await call(noDirHandler, 'get_current_problem'));
  check('比赛目录没建立 → local.available=false', noDir.local.available, false);
  ok('说明去哪儿建目录', /进入这场比赛/.test(noDir.local.note));
  ok('题面本身照常返回', noDir.description.includes('读两个数'));

  sample(1, '1 2\n', '3\n');
  sample(2, '5 5\n');                       // 半对：没有 2.out
  fs.writeFileSync(path.join(SAMPLES, 'note.txt'), 'x', 'utf8');  // 无关文件
  fs.writeFileSync(path.join(ASSETS, 'abc-main.png'), 'fake', 'utf8');
  fs.writeFileSync(SOURCE, CORRECT, 'utf8');

  const withLocal = JSON.parse(await call(handler, 'get_current_problem'));
  const L = withLocal.local;
  check('local.available', L.available, true);
  check('题目目录', L.dir, PROB);
  check('源文件路径', L.sourceFile, SOURCE);
  check('源文件已存在', L.sourceFileExists, true);
  check('样例目录', L.samplesDir, SAMPLES);
  check('图片目录', L.assetsDir, ASSETS);
  check('结果文件路径', L.resultFile, RESULT_FILE);
  check('报告文件路径', L.reportFile, REPORT_FILE);
  check('还没跑过测试', L.hasTestResult, false);

  const s1 = L.samples.find((s) => s.index === 1);
  const s2 = L.samples.find((s) => s.index === 2);
  check('样例 1 的输入路径', s1.input, path.join(SAMPLES, '1.in'));
  check('样例 1 的期望路径', s1.output, path.join(SAMPLES, '1.out'));
  check('样例 1 成对 → 会被执行', s1.runnable, true);
  check('样例 2 是半对（缺 .out）', [s2.hasInput, s2.hasOutput], [true, false]);
  check('半对样例不会被执行', s2.runnable, false);
  check('半对样例也进跳过清单', L.skippedSamples.map((s) => s.index), [2]);
  check('样例清单不含 note.txt', L.samples.length, 2);
  check('图片给出绝对路径', L.assets, [path.join(ASSETS, 'abc-main.png')]);
  ok('local 里没有任何 base64 图片数据', !/base64|data:image/.test(JSON.stringify(L)));

  // ── 3. compile_problem ──────────────────────────────────────
  console.log('\n[3] compile_problem');

  // 3a 工具链缺失：gpp 指向一个不存在的路径
  fs.writeFileSync(TC_FILE, JSON.stringify({
    toolchains: [{ id: 'cpp-g++', extensions: ['.cpp'], commands: { gpp: [path.join(PROB, 'no-such-gpp.exe')] } }],
  }, null, 2), 'utf8');
  const noTool = await call(handler, 'compile_problem');
  ok('工具链缺失 → 文案说清缺什么', /找不到工具链/.test(noTool) && /编译失败/.test(noTool));
  ok('工具链缺失 → 给出探测位置', /已探测过/.test(noTool));

  if (!HAS_GPP) {
    console.log(`\n  ~ 跳过真编译用例：找不到 g++（${GPP}），可设 VSOJ_TEST_GPP 指定\n`);
  } else {
    writeGppToolchain();

    // 3b 编译失败：语法错，要原样回传编译器输出
    fs.writeFileSync(SOURCE, BROKEN, 'utf8');
    const bad = await call(handler, 'compile_problem');
    ok('编译失败 → 标题明确', /^编译失败 · 题目 3775-0《A \+ B Problem》/.test(bad));
    ok('编译失败 → 带编译器原文（不是只说「失败了」）', /error|错误/.test(bad));
    ok('编译失败 → 给出实际执行的命令', /命令：/.test(bad));
    ok('编译失败 → 没有谎报产物', !/产物：/.test(bad));

    // 3c 编译成功
    fs.writeFileSync(SOURCE, CORRECT, 'utf8');
    const good = await call(handler, 'compile_problem');
    ok('编译成功 → 文案', /编译成功 · 题目 3775-0《A \+ B Problem》/.test(good));
    ok('编译成功 → 给产物路径', good.includes(path.join(PROB, 'temp', process.platform === 'win32' ? 'main.exe' : 'main')));
    ok('编译成功 → 给运行命令', /运行命令：/.test(good));
    ok('编译成功 → 给工作目录', good.includes(`工作目录：${PROB}`));
    ok('只编译不判定：不产生结果文件', !fs.existsSync(RESULT_FILE));
    check('强制重编译参数被接受', typeof (await call(handler, 'compile_problem', { rebuild: true })), 'string');
  }

  // ── 4. run_local_test ───────────────────────────────────────
  console.log('\n[4] run_local_test');
  if (!HAS_GPP) {
    console.log('  ~ 跳过（无 g++）');
  } else {
    fs.writeFileSync(SOURCE, CORRECT, 'utf8');
    sample(3, '7 8\n', '15\n');            // 第二组成对样例

    const pass = await call(handler, 'run_local_test');
    ok('全通过 → 结论行', /全部通过/.test(pass));
    ok('全通过 → 汇总（跳过第 2 组）', /共 2 组，通过 2，不通过 0，跳过 1/.test(pass));
    ok('全通过 → 带工具链', /C\+\+ \(g\+\+\)/.test(pass));
    ok('跳过用例被点名', /第 2 组：/.test(pass));
    ok('正文与 report.md 同源（逐字包含）',
      pass.includes(fs.readFileSync(REPORT_FILE, 'utf8')));
    ok('给出结果产物路径', pass.includes(RESULT_FILE));
    ok('给出报告路径', pass.includes(REPORT_FILE));
    ok('说明 MCP 不弹结果页', /结果页未自动打开/.test(pass));
    ok('结果文件真的落盘了', fs.existsSync(RESULT_FILE));
    const saved = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
    check('落盘结果里判定正确', [saved.summary.total, saved.summary.passed, saved.summary.failed], [2, 2, 0]);

    // 差一字节：定位必须精确
    fs.writeFileSync(SOURCE, OFF_BY_ONE, 'utf8');
    const fail = await call(handler, 'run_local_test', { rebuild: true });
    ok('不通过 → 结论里点出组数', /2 组不通过/.test(fail));
    ok('不通过 → 给出首个差异定位', /首个差异|第 1 行/.test(fail));
    ok('不通过 → 给出期望与实际', /期望输出/.test(fail) && /实际输出/.test(fail));
    ok('不通过 → 直接可读到「4」而不是「3」', /实际输出[\s\S]*4/.test(fail));
    ok('报告文件同步更新', fs.readFileSync(REPORT_FILE, 'utf8').includes('2 组不通过'));

    // 全部样例都变成半对（只剩 .in）→ 没有可跑用例
    fs.writeFileSync(SOURCE, CORRECT, 'utf8');
    const kept = [1, 3].map((i) => fs.readFileSync(path.join(SAMPLES, `${i}.out`), 'utf8'));
    for (const i of [1, 3]) { fs.rmSync(path.join(SAMPLES, `${i}.out`), { force: true }); }
    const noCases = await call(handler, 'run_local_test', { rebuild: true });
    ok('没有成对样例 → 指出这一点', /没有可用的用例/.test(noCases));
    [1, 3].forEach((i, k) => fs.writeFileSync(path.join(SAMPLES, `${i}.out`), kept[k], 'utf8'));
  }

  // ── 4.5 rebuild 参数必须让位给 oj.test.reuseBuild ──────────
  console.log('\n[4.5] rebuild 参数不能压掉 oj.test.reuseBuild');
  if (HAS_GPP) {
    fs.writeFileSync(SOURCE, CORRECT, 'utf8');
    env.config['oj.test.reuseBuild'] = false;
    await call(handler, 'compile_problem');
    const c2 = await call(handler, 'compile_problem');
    ok('配置说不复用 → 每次都重编（MCP 不越过配置）', !c2.includes('复用'));
    const c3 = await call(handler, 'compile_problem', { rebuild: false });
    ok('显式 rebuild:false 也只当「没意见」，不压掉配置', !c3.includes('复用'));

    env.config['oj.test.reuseBuild'] = true;
    await call(handler, 'compile_problem');
    const c4 = await call(handler, 'compile_problem');
    ok('配置说复用 → 第二次命中复用', c4.includes('复用上次产物'));
    const c5 = await call(handler, 'compile_problem', { rebuild: true });
    ok('显式 rebuild:true 仍能强制重编', !c5.includes('复用'));
    env.config['oj.test.reuseBuild'] = false;
  } else {
    console.log('  ~ 跳过（无 g++）');
  }

  // ── 5. get_last_test_result（不重跑） ───────────────────────
  console.log('\n[5] get_last_test_result');
  fs.rmSync(RESULT_FILE, { force: true });
  fs.rmSync(REPORT_FILE, { force: true });
  const never = await call(handler, 'get_last_test_result');
  ok('没跑过 → 明说没跑过', /还没跑过本地测试/.test(never));
  ok('没跑过 → 给出结果文件该在哪', never.includes(RESULT_FILE));
  ok('没跑过 → 提示怎么跑', /run_local_test/.test(never));

  if (HAS_GPP) {
    fs.writeFileSync(SOURCE, CORRECT, 'utf8');
    sample(1, '1 2\n', '3\n');
    const mtimeBefore = fs.statSync(SOURCE).mtimeMs;
    await call(handler, 'run_local_test');
    const before = fs.statSync(RESULT_FILE).mtimeMs;

    const last = await call(handler, 'get_last_test_result');
    ok('读得到上次结论', /全部通过/.test(last));
    ok('未改动 → 不打过期标记', !/可能已过期/.test(last));
    ok('正文就是 report.md 原文', last.includes(fs.readFileSync(REPORT_FILE, 'utf8')));

    // 读最近结果绝不能触发重跑：结果文件的时间戳必须没动
    check('没有重跑（结果文件时间戳未变）', fs.statSync(RESULT_FILE).mtimeMs, before);
    ok('源码也没被写过', fs.statSync(SOURCE).mtimeMs === mtimeBefore);

    const asJson = JSON.parse(await call(handler, 'get_last_test_result', { format: 'json' }));
    check('json 模式带过期标记', asJson.stale, false);
    check('json 模式带来源路径', asJson.fetchedFrom, RESULT_FILE);
    check('json 模式带原始结果', asJson.result.summary.passed, 2);

    // 改源码 → 标过期（D14：标出来，但不删结果）
    fs.writeFileSync(SOURCE, `${CORRECT}\n// touch\n`, 'utf8');
    const staleText = await call(handler, 'get_last_test_result');
    ok('改过源码 → 打过期标记', /可能已过期/.test(staleText));
    ok('过期也照常给旧结论（不删）', /全部通过/.test(staleText));
    const staleJson = JSON.parse(await call(handler, 'get_last_test_result', { format: 'json' }));
    check('json 模式同样报过期', staleJson.stale, true);

    // 报告被删 → 退回用 result.json 重渲染（同一 buildReport）
    fs.rmSync(REPORT_FILE, { force: true });
    const rebuilt = await call(handler, 'get_last_test_result');
    ok('报告没了两样能读结果（不报错）', /全部通过/.test(rebuilt));
    ok('重渲染也带用例明细', /用例明细/.test(rebuilt));
  } else {
    console.log('  ~ 跳过读结果用例（无 g++）');
  }

  // ── 6. 目标解析 ─────────────────────────────────────────────
  console.log('\n[6] 不传 cid/pid → 用当前题目；都没有 → 可操作文案');
  if (HAS_GPP) {
    const byCurrent = await call(handler, 'compile_problem');
    ok('默认用当前题目', /题目 3775-0/.test(byCurrent));
    const explicit = await call(handler, 'compile_problem', { cid: '3775', pid: '0' });
    ok('显式指定同样可用', /编译成功/.test(explicit));
  }
  current = { cid: '', pid: '', title: '' };
  const noCid = await call(handler, 'run_local_test');
  ok('没有 cid → 说清怎么给', /未指定比赛/.test(noCid));
  const noCidCompile = await call(handler, 'compile_problem');
  ok('编译同样要求 cid', /未指定比赛/.test(noCidCompile));
  const noCidLast = await call(handler, 'get_last_test_result');
  ok('读结果同样要求 cid', /未指定比赛/.test(noCidLast));
  current = { cid: CID, pid: '', title: '' };
  const noPid = await call(handler, 'run_local_test');
  ok('没有 pid → 说清怎么给', /未指定题目/.test(noPid));
  current = { cid: CID, pid: PID, title: 'A + B Problem' };

  // ── 7. 口径与静态约束 ───────────────────────────────────────
  console.log('\n[7] 口径静态检查');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'test', 'tools.ts'), 'utf8');
  ok('MCP 测试工具不弹任何界面',
    !/createWebviewPanel|showInformationMessage|showWarningMessage|showErrorMessage|withProgress/.test(src));
  ok('复用 buildReport（不另写一份「给 AI 看的简版」）', /import[\s\S]*buildReport[\s\S]*from '\.\/runner'/.test(src));
  ok('复用引擎（不自己 spawn 编译器）', /LocalTestRunner/.test(src) && !/spawn|execFile/.test(src));
  ok('读最近结果与「跑」是两条路', /不重跑/.test(src) && /getLastTestResult/.test(src));

  const mcpSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'tools.ts'), 'utf8');
  ok('图片没有独立工具', !/get_problem_assets|get_problem_samples/.test(mcpSrc));
  ok('get_current_problem 返回 local 段', /local: await this\.collectLocal/.test(mcpSrc));

  // ── 8. add_test_case：AI 自己补测试用例 ─────────────────────
  console.log('\n[8] add_test_case');
  {
    resetProblem();
    sample(1, '1 2\n', '3\n');
    fs.writeFileSync(SOURCE, CORRECT, 'utf8');
    const h2 = makeHandler();

    // 8a 不传 index → 追加到最后一组之后（已有 1 → 新的是 2）
    const added = await call(h2, 'add_test_case', { input: '7 8\n', output: '15\n' });
    ok('回执说明是新增', /已添加测试用例 2（新增）/.test(added));
    ok('回执给出输入路径', added.includes(path.join(SAMPLES, '2.in')));
    ok('回执给出期望路径', added.includes(path.join(SAMPLES, '2.out')));
    check('2.in 真的落盘', fs.readFileSync(path.join(SAMPLES, '2.in'), 'utf8'), '7 8\n');
    check('2.out 真的落盘', fs.readFileSync(path.join(SAMPLES, '2.out'), 'utf8'), '15\n');
    ok('回执列出成对可跑', /当前成对可跑：1、2/.test(added));
    ok('回执提醒「清理缓存会删 samples/」', /清理缓存/.test(added));

    // 8b 显式 index → 覆盖
    const override = await call(h2, 'add_test_case', { index: 1, input: '2 3\n', output: '5\n' });
    ok('显式 index → 覆盖原有用例', /已添加测试用例 1（覆盖原有用例）/.test(override));
    check('1.out 被覆盖', fs.readFileSync(path.join(SAMPLES, '1.out'), 'utf8'), '5\n');

    // 8c 非法参数
    const badIndex = await call(h2, 'add_test_case', { index: 0, input: 'x', output: 'y' });
    ok('index 0 → 拒绝并说清', /index 必须是不小于 1 的整数/.test(badIndex));
    const noOutput = await call(h2, 'add_test_case', { input: 'x' });
    ok('缺 output → 拒绝', /都必须是字符串/.test(noOutput));

    // 8d 题目目录未建立 → 可操作文案（不是抛错）
    const noDirAdd = await call(makeHandler(false), 'add_test_case', { input: 'x', output: 'y' });
    ok('目录未建立 → 说清怎么办', /工作目录还没建立/.test(noDirAdd));

    // 8e 补完用例后 run_local_test 真的会跑它
    if (HAS_GPP) {
      writeGppToolchain();
      const ran = await call(h2, 'run_local_test', { rebuild: true });
      ok('补的两组都参与判定', /共 2 组，通过 2，不通过 0/.test(ran));
    } else {
      console.log('  ~ 跳过「补完用例再跑」用例（无 g++）');
    }
  }

  // ── 9. source 参数：指定编译文件（默认 main.cpp） ───────────
  console.log('\n[9] source 参数');
  {
    resetProblem();
    const h3 = makeHandler();
    const otherSrc = path.join(PROB, 'other.cpp');

    // 9a 默认仍是 main.cpp（不存在 → 提示还没写代码）
    const noMain = await call(h3, 'compile_problem');
    ok('默认找 main.cpp', /还没写代码/.test(noMain) && noMain.includes('main.cpp'));

    // 9b 指定 other.cpp（main.cpp 始终不存在 → 一旦退回默认就会报「还没写代码」）
    fs.writeFileSync(otherSrc, CORRECT, 'utf8');
    sample(1, '1 2\n', '3\n');
    if (HAS_GPP) {
      writeGppToolchain();
      const c = await call(h3, 'compile_problem', { source: 'other.cpp', rebuild: true });
      ok('指定 source 后编译的是它', /编译成功/.test(c) && c.includes('other.cpp'));
      const r = await call(h3, 'run_local_test', { source: 'other.cpp', rebuild: true });
      ok('本地测试同样认 source（没退回 main.cpp）', !/还没写代码/.test(r) && /共 1 组，通过 1/.test(r));
    } else {
      const c = await call(h3, 'compile_problem', { source: 'other.cpp' });
      ok('装配阶段认 source（不因缺 main.cpp 报错）', !/还没写代码/.test(c));
      console.log('  ~ 跳过真编译用例（无 g++）');
    }

    // 9c 路径安全：不允许带路径 / 越界
    const escapeArg = await call(h3, 'compile_problem', { source: '..\\..\\evil.cpp' });
    ok('带路径的 source 被拒绝', /不能带路径/.test(escapeArg));
    const absArg = await call(h3, 'compile_problem', { source: path.join(PROB, 'other.cpp') });
    ok('绝对路径的 source 被拒绝', /不能带路径/.test(absArg));
    fs.rmSync(otherSrc, { force: true });
  }

  // 未知工具照旧有回复
  const unknown = await call(handler, 'no_such_tool');
  ok('未知工具给明文错误', /未知工具/.test(unknown));
}

main().then(() => {
  cleanup(WS);
  process.exit(done() ? 0 : 1);
}).catch((e) => {
  console.error(e);
  cleanup(WS);
  process.exit(1);
});
