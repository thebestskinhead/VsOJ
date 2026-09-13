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
    { 'workspace.root': '.vsoj', 'cache.enabled': true, 'cache.offline': false, 'cache.ttlSeconds': 180, 'cache.staleSeconds': 900 },
    { workspaceFolder: workspace, globalStorage },
  );

  const P = require('../out/cache/paths.js');
  const { CacheStore } = require('../out/cache/store.js');
  const { parseContestList, parseProblemList, parseProblemDetail } = require('../out/utils/parser.js');
  const { localizeImages } = require('../out/media/localize.js');
  const { problemToMarkdown } = require('../out/utils/problemMarkdown.js');

  const context = { globalStorageUri: { fsPath: env.globalStorage } };
  const layout = P.CachePaths.resolve(context);
  const store = new CacheStore(context, layout);

  console.log(`站点: ${BASE} ｜ 缓存根: ${layout.rootDir}\n`);

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

  await store.writeProblemHtml(CID, pid, probHtml);
  await store.writeSamples(CID, pid, [{ input: detail.sampleInput, output: detail.sampleOutput }]);
  check('原始 HTML 已落盘', await store.readProblemHtml(CID, pid), probHtml);
  const samples = await store.readSamples(CID, pid);
  check('样例组数', samples.length, 1);
  ok('1.in 内容与解析一致', samples[0].input === detail.sampleInput);
  check('问题详情 problem.json 不存在', fs.existsSync(path.join(cp.problemDir(pid), 'problem.json')), false);

  // 缓存年龄
  const stat = await store.statProblemHtml(CID, pid);
  ok('statProblemHtml 报告新鲜', stat.exists && stat.ageMs < 60_000);

  // ---------- 4. 题面图片本地化 ----------
  console.log(`\n[4] 题面图片本地化 cid=${IMG_CID} pid=${IMG_PID}`);
  const imgResp = await http.get('/problem.php', { params: { cid: IMG_CID, pid: IMG_PID } });
  const imgHtml = typeof imgResp.data === 'string' ? imgResp.data : '';
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

  // ---------- 6. 清理语义 ----------
  console.log('\n[6] 清理缓存：保留 meta / code / test');
  await store.ensureDir(cp.codeDir(pid));
  fs.writeFileSync(path.join(cp.codeDir(pid), 'main.cpp'), 'int main(){}');
  const before = (await store.listCachedContests()).find(c => c.cid === CID);
  console.log(`    缓存体积: 站点数据 ${before.dataBytes} B ｜ 用户产物 ${before.userBytes} B`);
  await store.purgeContestData(CID);
  ok('题目 raw/ 已删除', !fs.existsSync(cp.problemRawDir(pid)));
  ok('样例已删除', !fs.existsSync(cp.samplesDir(pid)));
  ok('code/ 保留', fs.existsSync(path.join(cp.codeDir(pid), 'main.cpp')));
  ok('meta.json 保留', fs.existsSync(cp.meta));

  // ---------- 7. AI 可读形态 ----------
  console.log('\n[7] 题面 Markdown 生成（不落盘，按需生成）');
  const md = problemToMarkdown(detail);
  console.log(`    Markdown 长度: ${md.length}`);
  ok('含标题', md.startsWith('# '));
  ok('含样例小节', md.includes('## 样例输入'));

  // 目录树
  console.log('\n[8] 生成的目录结构');
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
  walk(layout.rootDir);
  console.log(tree.map(l => `    ${l}`).join('\n'));

  console.log(`\n缓存根（可查看）: ${layout.rootDir}`);
  console.log(failures === 0
    ? `\n✅ 真实站点冒烟全部通过`
    : `\n❌ ${failures} 项失败`);

  process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n❌ 冒烟脚本异常:', e.message);
  console.error('（若站点不可达，请检查网络或设置 OJ_BASE_URL）');
  process.exit(2);
});
