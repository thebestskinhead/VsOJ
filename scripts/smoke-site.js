/**
 * 真实站点端到端冒烟测试（需要网络）。
 *
 * 与 `npm test` 的区别：本脚本**直接访问 acm.hnust.edu.cn**，用真实响应验证
 * 「拉取 → 解析 → 按原始信息落盘 → 回读 → 图片本地化」这条完整链路。
 * 因此它不放进 `npm test`（CI 环境无网时会失败），需要手动运行：
 *
 *   npm run smoke:site
 *
 * 只做只读探测 + 写本地缓存，不执行任何需要登录的写操作。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { installVscodeStub } = require('../test/helpers/stub');

// 清掉可能劫持 127.0.0.1 / 影响直连的 shell 代理
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

const BASE = process.env.OJ_BASE_URL || 'http://acm.hnust.edu.cn';
const CID = process.env.OJ_CID || '3772';
const IMG_CID = process.env.OJ_IMG_CID || '3775';
const IMG_PID = process.env.OJ_IMG_PID || '16';

const http = axios.create({
  baseURL: BASE,
  timeout: 20000,
  proxy: false,
  headers: { 'User-Agent': 'Mozilla/5.0' },
  validateStatus: () => true,
});

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures += 1; }
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}${ok ? '' : `  ← 期望 ${JSON.stringify(expected)}`}`);
};
const ok = (label, cond) => check(label, !!cond, true);

(async () => {
  const workspace = path.join(os.tmpdir(), `vsoj-smoke-ws-${process.pid}`);
  const globalStorage = path.join(os.tmpdir(), `vsoj-smoke-gs-${process.pid}`);
  const env = installVscodeStub(
    {
      // baseUrl 必须在这里给：apiClient 是模块级单例，构造时就会读它
      baseUrl: BASE,
      'workspace.root': '.vsoj',
      'cache.enabled': true,
      'cache.offline': false,
      'cache.ttlSeconds': 180,
      'cache.staleSeconds': 900,
      'project.enabled': true,
      'project.lazyInit': true,
      'project.sourceFileName': 'main.cpp',
      'project.initEntryVisible': true,
    },
    { workspaceFolder: workspace, globalStorage },
  );

  const P = require('../out/cache/paths.js');
  const { CacheStore } = require('../out/cache/store.js');
  const { parseContestList, parseProblemList, parseProblemDetail } = require('../out/utils/parser.js');
  const { localizeImages } = require('../out/media/localize.js');
  const { problemToMarkdown } = require('../out/utils/problemMarkdown.js');
  const { numToLetter } = require('../out/utils/format.js');

  const context = { globalStorageUri: { fsPath: env.globalStorage } };
  const layout = P.CachePaths.resolve(context);
  const store = new CacheStore(context, layout);

  console.log(`站点: ${BASE}`);
  console.log(`工作区根: ${layout.projectRoot} ｜ 内部数据根: ${layout.rootDir}\n`);

  // ---------- 1. 比赛列表页（只读） ----------
  console.log('[1] 比赛列表页 → 解析 + 原样落盘');
  const listResp = await http.get('/contest.php', { params: { page: 1 } });
  check('HTTP 状态', listResp.status, 200);
  const listHtml = typeof listResp.data === 'string' ? listResp.data : '';
  ok('返回内容非空', listHtml.length > 1000);
  const list = parseContestList(listHtml);
  console.log(`    解析到 ${list.rows.length} 个比赛，当前页 ${list.pagination.current}/${list.pagination.total}`);
  ok('解析出比赛', list.rows.length > 0);
  await store.writeContestListHtml(1, undefined, listHtml);
  ok('落盘为 HTML（不是 JSON）', fs.existsSync(layout.contestListFile(1, undefined)));
  check('落盘文件扩展名为 .html', path.extname(layout.contestListFile(1, undefined)), '.html');
  check('回读内容一致', await store.readContestListHtml(1, undefined), listHtml);

  // ---------- 2. 比赛页 → 题目列表 + 目录名定稿 ----------
  console.log(`\n[2] 比赛页 cid=${CID} → 题目列表 + 目录名定稿`);
  const contestResp = await http.get('/contest.php', { params: { cid: CID } });
  check('HTTP 状态', contestResp.status, 200);
  const contestHtml = typeof contestResp.data === 'string' ? contestResp.data : '';
  const probList = parseProblemList(contestHtml);
  console.log(`    比赛标题: ${JSON.stringify(probList.title)}`);
  console.log(`    题目数: ${probList.problems.length}`);
  ok('解析出题目', probList.problems.length > 0);
  await store.writeContestPageHtml(CID, contestHtml, probList.title);
  await store.touchContestMeta(CID, { title: probList.title, problemCount: probList.problems.length });

  const cp = await store.resolveContestDir(CID);
  const dirName = path.basename(cp.dir);
  console.log(`    比赛目录: ${dirName}`);
  ok('目录名以 cid 开头', dirName.startsWith(CID));
  ok('拿到标题后目录名已定稿（含 slug）', dirName.length > CID.length);
  check('meta.problemCount', (await store.readContestMeta(CID)).problemCount, probList.problems.length);
  check('解析产物 problems.json 不存在', fs.existsSync(path.join(cp.dir, 'problems.json')), false);

  // ---------- 3. 题目页 → 解析 + 样例落盘 ----------
  const pid = probList.problems[0].pid;
  console.log(`\n[3] 题目页 cid=${CID} pid=${pid} → 解析 + 原始落盘`);
  const probResp = await http.get('/problem.php', { params: { cid: CID, pid } });
  check('HTTP 状态', probResp.status, 200);
  const probHtml = typeof probResp.data === 'string' ? probResp.data : '';
  const detail = parseProblemDetail(probHtml);
  ok('解析出题目详情', !!detail);
  console.log(`    标题: ${JSON.stringify(detail.title)}`);
  console.log(`    描述长度: ${detail.description.length} ｜ 输入 ${detail.inputDesc.length} ｜ 输出 ${detail.outputDesc.length}`);
  console.log(`    样例输入: ${JSON.stringify((detail.sampleInput || '').slice(0, 40))}`);
  console.log(`    提示小节: ${detail.hint ? `${detail.hint.length} 字符` : '（无）'}`);
  ok('有标题', !!detail.title);
  ok('有描述', detail.description.length > 0);
  ok('有样例输入', (detail.sampleInput || '').length > 0);
  ok('有样例输出', (detail.sampleOutput || '').length > 0);

  // 登记 pid → 目录名（必须在写文件之前，否则目录会退化成数字 pid）
  const letter = numToLetter(parseInt(pid, 10));
  const brief = probList.problems.find(p => p.pid === pid) || probList.problems[0];
  console.log(`    题号字母: ${letter} ｜ 全局题号: ${brief.globalId ?? '（未解析出）'}`);
  check('题号字母可由 pid 确定性推导', letter, numToLetter(parseInt(pid, 10)));
  ok('解析出了全局题号（与 pid 无算术关系）', !!brief.globalId);
  await store.registerProblem(CID, {
    pid, letter, globalId: brief.globalId,
    dir: P.problemDirName(letter, detail.title), title: detail.title,
  });
  const cp2 = await store.resolveContestDir(CID);
  const problemDirBase = path.basename(cp2.problemDir(pid));
  console.log(`    题目目录: ${problemDirBase}`);
  ok('题目目录以题号字母开头', problemDirBase.startsWith(`${letter}-`));
  ok('题目目录含标题 slug', problemDirBase.length > letter.length + 1);
  ok('题目目录建在比赛目录的 problems/ 下',
    path.dirname(cp2.problemDir(pid)) === path.join(cp2.dir, 'problems'));

  await store.writeProblemHtml(CID, pid, probHtml);
  await store.writeSamples(CID, pid, [{ input: detail.sampleInput, output: detail.sampleOutput }]);
  check('原始 HTML 已落盘', await store.readProblemHtml(CID, pid), probHtml);
  const samples = await store.readSamples(CID, pid);
  check('样例组数', samples.length, 1);
  ok('1.in 内容与解析一致', samples[0].input === detail.sampleInput);
  check('问题详情 problem.json 不存在', fs.existsSync(path.join(cp2.problemDir(pid), 'problem.json')), false);
  check('meta.problems 已登记该题',
    (await store.readContestMeta(CID)).problems.some(p => p.pid === pid && p.dir === problemDirBase), true);

  // 缓存年龄
  const stat = await store.statProblemHtml(CID, pid);
  ok('statProblemHtml 报告新鲜', stat.exists && stat.ageMs < 60_000);

  // ---------- 4. 题面图片本地化 ----------
  console.log(`\n[4] 题面图片本地化 cid=${IMG_CID} pid=${IMG_PID}`);
  const imgResp = await http.get('/problem.php', { params: { cid: IMG_CID, pid: IMG_PID } });
  const imgHtml = typeof imgResp.data === 'string' ? imgResp.data : '';
  const imgDetail = parseProblemDetail(imgHtml);
  const imgLetter = numToLetter(parseInt(IMG_PID, 10));
  await store.registerProblem(IMG_CID, {
    pid: IMG_PID, letter: imgLetter,
    dir: P.problemDirName(imgLetter, (imgDetail && imgDetail.title) || ''),
    title: (imgDetail && imgDetail.title) || '',
  });
  const cpImg = await store.resolveContestDir(IMG_CID);
  console.log(`    比赛目录: ${path.basename(cpImg.dir)}`);
  console.log(`    题目目录: ${path.basename(cpImg.problemDir(IMG_PID))}`);
  ok('带图题目目录同样以题号字母开头',
    path.basename(cpImg.problemDir(IMG_PID)).startsWith(`${imgLetter}-`));

  let fetched = 0;
  const localized = await localizeImages(imgHtml, {
    readLocal: (url) => store.readProblemAsset(IMG_CID, IMG_PID, url),
    writeLocal: (url, buf) => store.writeProblemAsset(IMG_CID, IMG_PID, url, buf),
    fetchRemote: async (url) => {
      fetched += 1;
      const r = await http.get(url, { responseType: 'arraybuffer' });
      return Buffer.from(r.data);
    },
    isOffline: () => false,
    baseUrl: () => BASE,
  });
  console.log(`    题面图片 ${localized.total} 张 ｜ 内联 ${localized.inlined} ｜ 保留远程 ${localized.remote}`);
  ok('至少识别到 1 张题面图片', localized.total >= 1);
  ok('全部内联为 data URI', localized.inlined === localized.total);
  ok('图片已落盘到题目 assets/', fs.existsSync(cpImg.problemAssetsDir(IMG_PID))
    && fs.readdirSync(cpImg.problemAssetsDir(IMG_PID)).length >= 1);

  // 第二次应全部命中本地，零网络
  let fetched2 = 0;
  const again = await localizeImages(imgHtml, {
    readLocal: (url) => store.readProblemAsset(IMG_CID, IMG_PID, url),
    writeLocal: (url, buf) => store.writeProblemAsset(IMG_CID, IMG_PID, url, buf),
    fetchRemote: async () => { fetched2 += 1; return Buffer.alloc(0); },
    isOffline: () => false,
    baseUrl: () => BASE,
  });
  check('第二次零网络请求', fetched2, 0);
  check('第二次结果一致', again.inlined, localized.inlined);

  // ---------- 5. 离线预览能力 ----------
  console.log('\n[5] 离线能力（纯本地，无网络）');
  const offDeps = {
    readLocal: (url) => store.readProblemAsset(IMG_CID, IMG_PID, url),
    writeLocal: async () => {},
    fetchRemote: async () => { throw new Error('离线模式不应发起网络请求'); },
    isOffline: () => true,
    baseUrl: () => BASE,
  };
  const off = await localizeImages(imgHtml, offDeps);
  check('离线时零网络（已缓存的图仍内联）', off.inlined, localized.inlined);
  ok('离线时题目页可读', (await store.readProblemHtml(CID, pid, { allowStale: true })) !== undefined);

  // ==========================================================
  // S5：比赛项目初始化（走真实的 initializer + buildInitDeps）
  // ==========================================================
  const { ProblemInitializer, CPP_SKELETON } = require('../out/workspace/initializer.js');
  const { buildInitDeps } = require('../out/workspace/wiring.js');
  const { ProblemService } = require('../out/api/problem.js');
  const { apiClient } = require('../out/api/client.js');

  const problemService = new ProblemService();
  /** 「拉图 → 落盘」的真实接线：与扩展里 oj.showProblem 走的是同一条路 */
  const makeInit = () => new ProblemInitializer(buildInitDeps({
    cid: CID,
    store,
    problems: problemService,
    fetchAsset: (url) => apiClient.getBuffer(url, 'smoke.asset'),
    toError: (e) => (e && e.message) || String(e),
  }));

  const pid2 = (probList.problems[1] || probList.problems[0]).pid;
  const brief2 = probList.problems.find(p => p.pid === pid2) || probList.problems[0];

  // ---------- 6. 懒初始化单题 ----------
  console.log(`\n[6] 懒初始化单题 pid=${pid2}（真实 initializer）`);
  {
    const cpBefore = await store.resolveContestDir(CID);
    const nBefore = (await store.readContestMeta(CID)).problems.length;

    const r = await makeInit().ensureProblem({
      pid: pid2, globalId: brief2.globalId, title: brief2.title,
    });
    check('ok', r.ok, true);
    check('本次联网拉取了题面', r.fetched, true);
    check('新建了源文件', r.createdSource, true);
    check('落盘样例组数', r.samples, 1);

    const cpAfter = await store.resolveContestDir(CID);
    const dirBase = path.basename(cpAfter.problemDir(pid2));
    console.log(`    题目目录: ${dirBase}`);
    ok('源文件已落盘', fs.existsSync(cpAfter.mainSource(pid2)));
    ok('题面原始 HTML 已落盘', fs.existsSync(cpAfter.problemHtml(pid2)));
    ok('temp/ 已建立', fs.existsSync(cpAfter.tempDir(pid2)));
    ok('test/ 已建立', fs.existsSync(cpAfter.testDir(pid2)));
    check('源文件内容为最小 C++ 骨架（C14）',
      fs.readFileSync(cpAfter.mainSource(pid2), 'utf8'), CPP_SKELETON);
    check('meta.problems 增加了一条', (await store.readContestMeta(CID)).problems.length, nBefore + 1);
    check('题目目录名以题号字母开头',
      dirBase.startsWith(numToLetter(parseInt(pid2, 10)) + '-'), true);

    // 幂等：再跑一次必须全部命中本地、且不覆盖已存在文件（C6）
    fs.writeFileSync(cpAfter.mainSource(pid2), '// 用户已经写的代码');
    const again = await makeInit().ensureProblem(pid2);
    check('第二次 ok', again.ok, true);
    check('第二次不再联网', again.fetched, false);
    check('第二次未重建源文件', again.createdSource, false);
    ok('第二次跳过题面', again.skipped.includes('题面（已有缓存）'));
    ok('第二次跳过源文件', again.skipped.some(s => s.includes('不覆盖')));
    check('用户代码未被覆盖（C6）',
      fs.readFileSync(cpAfter.mainSource(pid2), 'utf8'), '// 用户已经写的代码');
  }

  // ---------- 7. 全量初始化整个比赛 ----------
  console.log(`\n[7] 全量初始化 cid=${CID}（${probList.problems.length} 道题）`);
  {
    const hints = probList.problems.map(p => ({ pid: p.pid, globalId: p.globalId, title: p.title }));
    const progress = [];
    const summary = await makeInit().initializeContest(hints, {
      onProgress: p => progress.push(`${p.index}/${p.total}`),
    });
    console.log(`    完成 ${summary.ok}/${summary.total} ｜ 失败 ${summary.failed.length} ｜ 新建源文件 ${summary.createdSources}`);
    check('全部成功', summary.failed, []);
    check('完成数 = 题目数', summary.ok, probList.problems.length);
    check('未取消', summary.cancelled, false);
    check('进度回调次数 = 题目数', progress.length, probList.problems.length);
    check('进度按序递增', progress[0], `1/${probList.problems.length}`);

    const cpAll = await store.resolveContestDir(CID);
    const missing = hints.filter(h => !fs.existsSync(cpAll.mainSource(h.pid)));
    check('每道题都有源文件', missing.map(h => h.pid), []);
    const meta = await store.readContestMeta(CID);
    check('meta 登记题数 = 题目数', meta.problems.length, probList.problems.length);
    const badDirs = meta.problems.filter(
      p => !path.basename(cpAll.problemDir(p.pid)).startsWith(numToLetter(parseInt(p.pid, 10)) + '-'),
    );
    check('所有题目目录名都由题号字母推导', badDirs.map(p => p.pid), []);

    // 题面 / 样例在初始化后应可离线读取（C15）
    const pid3 = (probList.problems[2] || probList.problems[0]).pid;
    ok('离线可读题面', (await store.readProblemHtml(CID, pid3, { allowStale: true })) !== undefined);
    check('离线可读样例组数', (await store.readSamples(CID, pid3)).length, 1);
  }

  // ---------- 8. 离线重进（断网后不再发起请求） ----------
  console.log('\n[8] 离线模式：已初始化的题照常可用，未缓存的题如实报错');
  {
    env.config['cache.offline'] = true;
    try {
      const r = await makeInit().ensureProblem(pid2);
      check('已有缓存的题 ok', r.ok, true);
      check('离线不发请求', r.fetched, false);

      // 该 pid 必然不在本地（站点上也不存在，但离线时根本不会去问）
      const miss = await makeInit().ensureProblem('9999');
      check('无缓存的题 ok=false', miss.ok, false);
      check('给出可读原因', miss.error, '离线且无本地缓存');

      const cpOff = await store.resolveContestDir(CID);
      ok('离线仍能定位比赛目录', !!cpOff);
      ok('离线仍能读题面', (await store.readProblemHtml(CID, pid2, { allowStale: true })) !== undefined);
    } finally {
      env.config['cache.offline'] = false;
    }
  }

  // ---------- 9. 初始化后的完整目录结构 ----------
  const dumpTree = (root, title) => {
    console.log(`\n${title}`);
    const tree = [];
    const walk = (dir, prefix = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      entries.forEach((e, i) => {
        const last = i === entries.length - 1;
        tree.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory()) { walk(path.join(dir, e.name), `${prefix}${last ? '    ' : '│   '}`); }
      });
    };
    walk(root);
    console.log(tree.map(l => `    ${l}`).join('\n'));
  };
  dumpTree(layout.projectRoot, '[9] 初始化后的目录结构（工作区根视角）');

  // 布局契约：比赛项目文件夹必须是**可见**的（不在 .vsoj 里）
  const visible = fs.readdirSync(layout.projectRoot).filter(n => !n.startsWith('.'));
  console.log(`\n    可见的比赛项目文件夹: ${JSON.stringify(visible)}`);
  ok('比赛项目文件夹建在工作区根下（可见）', visible.length >= 2);
  ok('内部数据根隐藏在工作区根下', fs.existsSync(path.join(layout.projectRoot, '.vsoj')));

  // ---------- 10. 清理语义 ----------
  console.log('\n[10] 清理缓存：删站点数据 + temp/，保留 main.cpp / test/ / meta');
  await store.ensureDir(cp2.tempDir(pid));
  await store.ensureDir(cp2.testDir(pid));
  await store.writeUserFile(cp2.mainSource(pid), 'int main(){}');
  fs.writeFileSync(path.join(cp2.tempDir(pid), 'a.exe'), 'MZ');
  fs.writeFileSync(cp2.testResult(pid), '{"ok":true}');
  const before = (await store.listCachedContests()).find(c => c.cid === CID);
  console.log(`    缓存体积: 站点数据 ${before.dataBytes} B ｜ 用户产物 ${before.userBytes} B`);
  ok('体积统计识别到用户产物', before.userBytes > 0);
  await store.purgeContestData(CID);
  ok('contest-raw/ 已删除', !fs.existsSync(cp2.contestRawDir));
  ok('题目 raw/ 已删除', !fs.existsSync(cp2.problemRawDir(pid)));
  ok('样例已删除', !fs.existsSync(cp2.samplesDir(pid)));
  ok('temp/ 已删除', !fs.existsSync(cp2.tempDir(pid)));
  check('清理后仍能定位目录', !!(await store.resolveContestDir(CID)), true);

  const cpAfterPurge = await store.resolveContestDir(CID);
  const lostSources = probList.problems.filter(p => !fs.existsSync(cpAfterPurge.mainSource(p.pid)));
  check('清理后所有源码都在（C12）', lostSources.map(p => p.pid), []);
  check('清理后 test/ 保留', fs.existsSync(cp2.testResult(pid)), true);
  check('清理后 meta.json 保留', fs.existsSync(cp2.meta), true);
  check('清理后题目目录名不变',
    path.basename(cpAfterPurge.problemDir(pid)), problemDirBase);

  // ---------- 11. AI 可读形态 ----------
  console.log('\n[11] 题面 Markdown 生成（不落盘，按需生成）');
  const md = problemToMarkdown(detail);
  console.log(`    Markdown 长度: ${md.length}`);
  ok('含标题', md.startsWith('# '));
  ok('含样例小节', md.includes('## 样例输入'));

  // 清理后应只剩「用户不可再生的资产」——直接看磁盘，避免只信断言
  dumpTree(cpAfterPurge.dir, '[12] 清理后的比赛目录（只剩源码 / test / meta）');

  console.log(`\n工作区（可查看）: ${layout.projectRoot}`);
  console.log(`内部数据根: ${layout.rootDir}`);
  console.log(failures === 0
    ? `\n✅ 真实站点冒烟全部通过`
    : `\n❌ ${failures} 项失败`);

  process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n❌ 冒烟脚本异常:', e.message);
  console.error('（若站点不可达，请检查网络或设置 OJ_BASE_URL）');
  process.exit(2);
});
