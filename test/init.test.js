// 比赛项目初始化（workspace/initializer.ts）— 全部依赖注入，无需 vscode 运行时
// 运行：node test/init.test.js
const { installVscodeStub, makeChecker, sleep } = require('./helpers/stub');

// initializer 本身不依赖 vscode，但第 [13] 组要与 cache/paths.ts 对比命名规则，
// 而 paths.ts 顶层 import 了 vscode —— 因此先装桩。
installVscodeStub();

const {
  ProblemInitializer, CPP_SKELETON, collectImageUrls, problemDirName,
} = require('../out/workspace/initializer.js');

const { check, ok, done } = makeChecker();

const DETAIL_HTML_SIMPLE = '<html>simple</html>';
const DETAIL_HTML_WITH_IMG = '<html><img src="/JudgeOnline/upload/image/a.png"></html>';

/** 造一个可编程的假环境（内存盘 + 可控网络） */
function makeEnv(opts = {}) {
  const disk = new Map();          // path -> string | Buffer
  const calls = [];                // 调用序列，用于断言顺序
  const log = [];
  const savedSamples = new Map();  // pid -> samples
  const registered = new Map();    // pid -> entry
  const failFetchPids = new Set(opts.failFetchPids || []);
  const failAssetUrls = new Set(opts.failAssetUrls || []);
  const assetBytes = new Map(opts.assetBytes || []);   // url -> Buffer
  const fetchCounts = { problem: 0, asset: 0 };
  let concurrent = 0;
  let peakConcurrent = 0;

  const detailFor = (html) => {
    if (/(fetch-fail)/.test(html)) { return null; }
    const withSample = !opts.noSample;
    return {
      title: opts.title === undefined
        ? (/with-img/.test(html) ? '带图题' : '示例题目')
        : opts.title,
      description: 'desc',
      inputDesc: 'in',
      outputDesc: 'out',
      sampleInput: withSample ? '1 2\n' : '',
      sampleOutput: withSample ? '3\n' : '',
      hint: '',
    };
  };

  const deps = {
    // ---- 题面 HTML ----
    readProblemHtml: async (pid) => disk.get(`raw/${pid}/page.html`),
    fetchProblemHtml: async (pid) => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await sleep(3);
      concurrent -= 1;
      fetchCounts.problem += 1;
      calls.push(`fetch:${pid}`);
      if (failFetchPids.has(pid)) { throw new Error(`题目 ${pid} 超时`); }
      return pid === '9' ? DETAIL_HTML_WITH_IMG : DETAIL_HTML_SIMPLE;
    },
    saveProblemHtml: async (pid, html) => {
      calls.push(`saveHtml:${pid}`);
      disk.set(`raw/${pid}/page.html`, html);
    },
    parseDetail: detailFor,
    registerProblem: async (entry) => {
      calls.push(`register:${entry.pid}`);
      registered.set(entry.pid, entry);
    },

    // ---- 样例 ----
    readSamples: async (pid) => savedSamples.get(pid) || [],
    saveSamples: async (pid, list) => { savedSamples.set(pid, list); },

    // ---- 图片 ----
    listAssets: async (pid) => {
      const out = [];
      for (const k of disk.keys()) {
        if (k.startsWith(`assets/${pid}/`)) { out.push(k); }
      }
      return out;
    },
    fetchAsset: async (url) => {
      fetchCounts.asset += 1;
      if (failAssetUrls.has(url)) { throw new Error('图片 404'); }
      return assetBytes.get(url) || Buffer.from('PNGDATA');
    },
    saveAsset: async (pid, url, data) => { disk.set(`assets/${pid}/${url}`, data); },

    // ---- 源文件与目录 ----
    sourceFile: (pid) => `p${pid}/main.cpp`,
    writeSourceFile: async (pid, content) => {
      calls.push(`writeSource:${pid}`);
      disk.set(`p${pid}/main.cpp`, content);
    },
    fileExists: async (file) => disk.has(file),
    ensureDir: async (dir) => { disk.set(`dir:${dir}`, ''); },
    tempDir: (pid) => `p${pid}/temp`,
    testDir: (pid) => `p${pid}/test`,

    // ---- 环境 ----
    isOffline: () => !!opts.offline,
    toError: (e) => (e && e.message) || String(e),
    letterOf: (pid) => {
      const n = parseInt(pid, 10);
      if (!Number.isFinite(n) || n < 0) { return '?'; }
      let s = '', num = n;
      do { s = String.fromCharCode(65 + (num % 26)) + s; num = Math.floor(num / 26) - 1; } while (num >= 0);
      return s;
    },
    log: (m) => log.push(m),
  };

  return {
    deps, disk, calls, log, registered, savedSamples, fetchCounts,
    stats: () => ({ peakConcurrent }),
    seed: (pid, html) => disk.set(`raw/${pid}/page.html`, html),
    seedSource: (pid, content) => disk.set(`p${pid}/main.cpp`, content),
    has: (k) => disk.has(k),
  };
}

(async () => {
  // ---------- 1. 全新初始化 ----------
  console.log('[1] ensureProblem — 全新初始化');
  {
    const env = makeEnv();
    const init = new ProblemInitializer(env.deps);
    const r = await init.ensureProblem({ pid: '0', globalId: '1722', title: '复杂度分析(Ⅰ)' });

    check('ok', r.ok, true);
    check('本次联网', r.fetched, true);
    check('新建源文件', r.createdSource, true);
    check('落盘样例组数', r.samples, 1);
    check('无跳过项', r.skipped, []);
    check('写入题面原始 HTML', env.has('raw/0/page.html'), true);
    check('写入样例 1.in/1.out 含义（input/output）', env.savedSamples.get('0'), [{ input: '1 2\n', output: '3\n' }]);
    check('登记目录名（字母-标题）', env.registered.get('0').dir, 'A-示例题目');
    check('登记全局题号', env.registered.get('0').globalId, '1722');
    check('登记标题取自题面（比列表页更权威）', env.registered.get('0').title, '示例题目');
    check('登记字母', env.registered.get('0').letter, 'A');
    check('临时目录已建', env.has('dir:p0/temp'), true);
    check('测试目录已建', env.has('dir:p0/test'), true);
  }
  {
    // 题面解析不出标题时，回退到列表页给的标题
    const env = makeEnv({ title: '' });
    const r = await new ProblemInitializer(env.deps).ensureProblem({ pid: '3', title: '列表页标题' });
    check('ok', r.ok, true);
    check('回退到列表页标题', env.registered.get('3').dir, 'D-列表页标题');
  }

  // ---------- 2. 顺序契约：先登记目录名，再写任何文件 ----------
  console.log('\n[2] 顺序 —— 先 registerProblem 再落盘（避免 orphan 目录）');
  {
    const env = makeEnv();
    await new ProblemInitializer(env.deps).ensureProblem('0');
    const iReg = env.calls.indexOf('register:0');
    const iHtml = env.calls.indexOf('saveHtml:0');
    const iSrc = env.calls.indexOf('writeSource:0');
    ok('register 先于 saveProblemHtml', iReg >= 0 && iReg < iHtml);
    ok('register 先于 writeSourceFile', iReg >= 0 && iReg < iSrc);
    check('调用序列', env.calls, ['fetch:0', 'register:0', 'saveHtml:0', 'writeSource:0']);
  }

  // ---------- 3. 幂等 / 增量补齐（C6） ----------
  console.log('\n[3] 幂等 —— 重复初始化不重拉、不覆盖源文件（C6）');
  {
    const env = makeEnv();
    const init = new ProblemInitializer(env.deps);
    await init.ensureProblem('0');
    env.seedSource('0', '// 用户已经写的代码');
    const before = env.fetchCounts.problem;

    const r2 = await init.ensureProblem('0');
    check('第二次 ok', r2.ok, true);
    check('第二次未联网', r2.fetched, false);
    check('题目页请求次数未增加', env.fetchCounts.problem, before);
    check('未新建源文件', r2.createdSource, false);
    ok('跳过项含题面', r2.skipped.includes('题面（已有缓存）'));
    ok('跳过项含源文件', r2.skipped.some(s => s.includes('不覆盖')));
    ok('跳过项含样例', r2.skipped.some(s => s.includes('样例')));
    check('用户代码原样保留（C6 绝不覆盖）', env.disk.get('p0/main.cpp'), '// 用户已经写的代码');
  }

  // ---------- 4. 增量：只补缺失项 ----------
  console.log('\n[4] 增量补缺 —— 题面在、样例缺');
  {
    const env = makeEnv();
    env.seed('0', DETAIL_HTML_SIMPLE);           // 题面已有
    const r = await new ProblemInitializer(env.deps).ensureProblem('0');
    check('ok', r.ok, true);
    check('未联网（题面命中本地）', r.fetched, false);
    check('样例已补上', r.samples, 1);
    ok('题面记入跳过', r.skipped.includes('题面（已有缓存）'));
  }

  // ---------- 5. 离线行为 ----------
  console.log('\n[5] 离线 —— 有缓存可继续，无缓存如实报告');
  {
    const env = makeEnv({ offline: true });
    const r = await new ProblemInitializer(env.deps).ensureProblem('0');
    check('无缓存时 ok=false', r.ok, false);
    check('错误文案', r.error, '离线且无本地缓存');
    check('未发任何请求', env.fetchCounts.problem, 0);
    check('未写源文件', env.has('p0/main.cpp'), false);
  }
  {
    const env = makeEnv({ offline: true });
    env.seed('0', DETAIL_HTML_SIMPLE);
    const r = await new ProblemInitializer(env.deps).ensureProblem('0');
    check('有缓存时 ok=true', r.ok, true);
    check('离线不联网', r.fetched, false);
    check('样例仍可落盘', r.samples, 1);
    check('源文件仍会建（离线也应能写代码）', env.has('p0/main.cpp'), true);
  }

  // ---------- 6. 图片题 ----------
  console.log('\n[6] 题面图片 —— 相对路径图片落盘');
  {
    const env = makeEnv();
    const r = await new ProblemInitializer(env.deps).ensureProblem('9');
    check('落盘图片数', r.assets, 1);
    check('图片请求次数', env.fetchCounts.asset, 1);
    ok('图片二进制已存', env.has('assets/9//JudgeOnline/upload/image/a.png'));
  }
  {
    const env = makeEnv();
    env.deps.listAssets = async () => ['已经有图'];
    const r = await new ProblemInitializer(env.deps).ensureProblem('9');
    check('已有图片则不重抓', env.fetchCounts.asset, 0);
    ok('记入跳过', r.skipped.some(s => s.includes('图片')));
  }
  {
    const env = makeEnv({ failAssetUrls: ['/JudgeOnline/upload/image/a.png'] });
    const r = await new ProblemInitializer(env.deps).ensureProblem('9');
    check('单张图片失败不影响整题', r.ok, true);
    check('图片数为 0', r.assets, 0);
    ok('失败已记日志', env.log.some(m => m.includes('图片抓取失败')));
  }

  // ---------- 7. 题面未给样例 ----------
  console.log('\n[7] 题面未给样例');
  {
    const env = makeEnv({ noSample: true });
    const r = await new ProblemInitializer(env.deps).ensureProblem('0');
    check('ok', r.ok, true);
    check('样例数', r.samples, 0);
    ok('记入跳过', r.skipped.some(s => s.includes('题面未给出')));
  }

  // ---------- 8. 骨架内容（C14） ----------
  console.log('\n[8] main.cpp 骨架（C14：可直接编译）');
  {
    ok('含 bits/stdc++.h', CPP_SKELETON.includes('#include <bits/stdc++.h>'));
    ok('含 using namespace std', CPP_SKELETON.includes('using namespace std;'));
    ok('含 main 函数', /int main\s*\(\s*\)/.test(CPP_SKELETON));
    ok('含 return 0', CPP_SKELETON.includes('return 0;'));
    ok('无题目信息注释（D20：用户选了纯骨架）', !CPP_SKELETON.includes('//'));

    const env = makeEnv();
    await new ProblemInitializer(env.deps).ensureProblem('0');
    check('落盘的骨架与常量一致', env.disk.get('p0/main.cpp'), CPP_SKELETON);
  }

  // ---------- 9. initializeContest：串行 / 进度 / 汇总 ----------
  console.log('\n[9] initializeContest — 串行 + 进度 + 汇总');
  {
    const env = makeEnv();
    const progress = [];
    const s = await new ProblemInitializer(env.deps).initializeContest(
      [{ pid: '0' }, { pid: '1' }, { pid: '2' }],
      { onProgress: p => progress.push(`${p.index}/${p.total}@${p.pid}`) },
    );
    check('total', s.total, 3);
    check('ok', s.ok, 3);
    check('失败列表为空', s.failed, []);
    check('未取消', s.cancelled, false);
    check('新建源文件数', s.createdSources, 3);
    check('进度回调序列', progress, ['1/3@0', '2/3@1', '3/3@2']);
    check('串行执行（峰值并发=1）', env.stats().peakConcurrent, 1);
  }

  // ---------- 10. 单题失败不中断（C10） ----------
  console.log('\n[10] 单题失败不中断整体（C10）');
  {
    const env = makeEnv({ failFetchPids: ['1'] });
    const s = await new ProblemInitializer(env.deps).initializeContest(['0', '1', '2']);
    check('ok 数', s.ok, 2);
    check('失败条目数', s.failed.length, 1);
    check('失败 pid', s.failed[0].pid, '1');
    check('失败原因', s.failed[0].error, '题目 1 超时');
    check('后续题目仍执行', env.has('p2/main.cpp'), true);
  }

  // ---------- 11. 取消（C9） ----------
  console.log('\n[11] 取消 —— 已完成的题保留（C9）');
  {
    const env = makeEnv();
    const token = { isCancellationRequested: false };
    const s = await new ProblemInitializer(env.deps).initializeContest(
      ['0', '1', '2', '3'],
      {
        token,
        onProgress: p => { if (p.index === 2) { token.isCancellationRequested = true; } },
      },
    );
    check('标记已取消', s.cancelled, true);
    check('完成数（含被取消那次在跑）', s.ok, 2);
    check('已完成的题保留', env.has('p0/main.cpp'), true);
    ok('后续题目未执行', !env.has('p3/main.cpp'));
  }

  // ---------- 12. 会抛异常的 deps 也不外泄 ----------
  console.log('\n[12] 依赖抛异常 → 收敛为 ok=false，不外泄');
  {
    const env = makeEnv();
    env.deps.parseDetail = () => { throw new Error('解析器炸了'); };
    const r = await new ProblemInitializer(env.deps).ensureProblem('0');
    check('ok=false', r.ok, false);
    check('错误已转换', r.error, '解析器炸了');
  }

  // ---------- 13. 目录命名规则（与 paths.ts 共用 slug.ts） ----------
  console.log('\n[13] 目录命名规则');
  {
    check('0 → A-标题', problemDirName('A', '复杂度分析(Ⅰ)'), 'A-复杂度分析(Ⅰ)');
    check('标题为空 → 纯字母', problemDirName('B', ''), 'B');
    check('非法字符被替换', problemDirName('C', 'a/b:c*d?e'), 'C-a-b-c-d-e');
    check('26 → AA', problemDirName('AA', 'x'), 'AA-x');
    check('超长截断', problemDirName('D', 'x'.repeat(60)).length, 2 + 40);

    // 与 cache/paths.ts 的同名函数必须一致（同一实现的两处出口）
    const paths = require('../out/cache/paths.js');
    check('与 paths.problemDirName 一致',
      paths.problemDirName('E', '双指针 (Ⅱ)'), problemDirName('E', '双指针 (Ⅱ)'));
  }

  // ---------- 14. collectImageUrls ----------
  console.log('\n[14] 题面图片 URL 采集');
  {
    check('只认站内相对路径', collectImageUrls('<img src="/a/b.png"><img src="http://x/c.png">'), ['/a/b.png']);
    check('去重', collectImageUrls('<img src="/a.png"><img src="/a.png">'), ['/a.png']);
    check('空 HTML', collectImageUrls(''), []);
    check('单引号属性', collectImageUrls("<img alt='x' src='/q.png'>"), ['/q.png']);
  }

  process.exit(done() ? 0 : 1);
})();
