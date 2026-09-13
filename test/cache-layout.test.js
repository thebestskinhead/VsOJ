// 缓存层布局与语义验证
//
// 核心断言：
//   1. 同一 cid 只产生一个目录（S1 的老问题，防回归）
//   2. 缓存里**只有原始信息**（HTML / 图片二进制 / 样例文本），没有解析产物
//   3. 清理缓存保留 code/ 与 test/
//
// 运行：npm run test:cache
const path = require('path');
const os = require('os');
const fs = require('fs');
const { installVscodeStub, makeChecker } = require('./helpers/stub');

const cfg = {
  'workspace.root': '.vsoj',
  'cache.enabled': true,
  'cache.offline': false,
  'cache.ttlSeconds': 180,
  'cache.staleSeconds': 900,
};
const env = installVscodeStub(cfg);
const vscodeStub = env.vscode;
const WORKSPACE = env.workspaceFolder;
const GLOBAL_STORAGE = env.globalStorage;

const P = require('../out/cache/paths.js');
const { CacheStore } = require('../out/cache/store.js');

const context = { globalStorageUri: { fsPath: GLOBAL_STORAGE } };
const { check, ok, done } = makeChecker();

const CONTEST_HTML_LATER = '<html><h3>2025年校赛 初赛:Round/1?</h3><table id="problemset"><tbody>'
  + '<tr><td>1</td><td>0</td><td><a href="problem.php?cid=3772&pid=0">A + B</a></td><td>d</td><td>10</td><td>12</td></tr>'
  + '</tbody></table></html>';

(async () => {
  const layout = P.CachePaths.resolve(context);
  const store = new CacheStore(context, layout);
  console.log('缓存根:', layout.rootDir, '| 工作区级:', layout.inWorkspace);

  console.log('\n[1] 无标题写入（模拟直接打开题目页）');
  await store.writeStatusHtml('3772', '<html>status</html>');
  await store.writeProblemHtml('3772', '0', '<html>page-0</html>');
  const p1 = await store.resolveContestDir('3772');
  console.log('   目录:', path.relative(WORKSPACE, p1.dir));
  check('尚无标题时目录名退化为纯 cid', path.basename(p1.dir), '3772');
  check('meta.pendingTitle 标记为真', (await store.readContestMeta('3772')).pendingTitle, true);

  console.log('\n[2] 拿到比赛标题后写入比赛页（目录应重命名且只重命名一次）');
  await store.writeContestPageHtml('3772', CONTEST_HTML_LATER, '2025年校赛 初赛:Round/1?');
  const contestsDir = path.join(layout.rootDir, 'contests');
  const names = fs.readdirSync(contestsDir).sort();
  console.log('   contests/ 下的目录:', names);
  check('同一 cid 只产生一个目录', names.length, 1);
  check('目录名为 <cid>-<slug>', names[0], '3772-2025年校赛-初赛-Round-1');

  const meta = await store.readContestMeta('3772');
  check('meta.title', meta.title, '2025年校赛 初赛:Round/1?');
  check('meta.pendingTitle 已清除', !!meta.pendingTitle, false);
  check('meta.cid', meta.cid, '3772');

  console.log('\n[3] 落盘的必须是原始信息');
  const cp = await store.resolveContestDir('3772');
  ok('raw/contest.html 存在', fs.existsSync(cp.contestHtml));
  ok('raw/status.html 存在', fs.existsSync(cp.statusHtml));
  ok('problems/0/raw/page.html 存在', fs.existsSync(cp.problemHtml('0')));
  check('contest.html 内容为原始 HTML', await store.readText(cp.contestHtml), CONTEST_HTML_LATER);

  // 解析产物不得落盘
  ok('problem.json 不存在（解析产物不落盘）', !fs.existsSync(path.join(cp.problemDir('0'), 'problem.json')));
  ok('problem.md 不存在（派生文本不落盘）', !fs.existsSync(path.join(cp.problemDir('0'), 'problem.md')));
  ok('problems.json 不存在（解析产物不落盘）', !fs.existsSync(path.join(cp.dir, 'problems.json')));
  ok('status.json 不存在（解析产物不落盘）', !fs.existsSync(path.join(cp.dir, 'status.json')));

  console.log('\n[4] 回到原始 HTML');
  check('readProblemHtml', await store.readProblemHtml('3772', '0'), '<html>page-0</html>');
  check('readStatusHtml', await store.readStatusHtml('3772'), '<html>status</html>');

  console.log('\n[5] 样例与图片（原始文本 / 原始二进制）');
  await store.writeSamples('3772', '0', [{ input: '1 2\n', output: '3\n' }]);
  const samples = await store.readSamples('3772', '0');
  check('样例数据集', samples.map(s => `${s.index}:${s.input.trim()}->${s.output.trim()}`), ['1:1 2->3']);
  ok('样例落盘为 1.in', fs.existsSync(path.join(cp.samplesDir('0'), '1.in')));
  ok('样例落盘为 1.out', fs.existsSync(path.join(cp.samplesDir('0'), '1.out')));

  const imgUrl = '/JudgeOnline/upload/image/20170611/20170611222431_16939.png';
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await store.writeProblemAsset('3772', '0', imgUrl, payload);
  const back = await store.readProblemAsset('3772', '0', imgUrl);
  ok('图片可回读且字节一致', back && Buffer.compare(back, payload) === 0);
  check('图片文件名由 URL 确定性推导', P.assetFileName(imgUrl), P.assetFileName(imgUrl));
  check('不同 URL 同名图片不冲突',
    P.assetFileName('/a/x.png') !== P.assetFileName('/b/x.png'), true);
  ok('图片位于题目级 assets/', fs.existsSync(path.join(cp.problemAssetsDir('0'), P.assetFileName(imgUrl))));

  console.log('\n[6] 新鲜度与年龄');
  const st = await store.statProblemHtml('3772', '0');
  check('exists', st.exists, true);
  ok('ageMs 是小正数', st.ageMs >= 0 && st.ageMs < 5000);
  check('isFresh(默认 180s)', await store.isFresh(cp.problemHtml('0')), true);
  check('isFresh(ttl=-1)', await store.isFresh(cp.problemHtml('0'), -1), true);

  // 把 mtime 拨到 20 分钟前 → 超过 staleSeconds(900)
  const old = (Date.now() - 20 * 60 * 1000) / 1000;
  fs.utimesSync(cp.problemHtml('0'), old, old);
  const st2 = await store.statProblemHtml('3772', '0');
  ok('拨旧后 ageMs ≈ 20 分钟', st2.ageMs > 19 * 60 * 1000 && st2.ageMs < 21 * 60 * 1000);
  check('超期后 isFresh=false', await store.isFresh(cp.problemHtml('0')), false);
  check('allowStale 仍能读到', !!(await store.readProblemHtml('3772', '0', { allowStale: true })), true);
  check('非 allowStale 视为未命中', await store.readProblemHtml('3772', '0'), undefined);

  console.log('\n[7] 索引与磁盘一致性');
  const idx = await store.readIndex();
  check('索引存相对路径', idx.contests['3772'].dir, 'contests/3772-2025年校赛-初赛-Round-1');
  fs.rmSync(path.join(GLOBAL_STORAGE, 'cache-index.json'), { force: true });
  check('索引丢失后磁盘兜底', !!(await store.resolveContestDir('3772')), true);

  console.log('\n[8] 幂等性：重复写入不应新增目录');
  await store.writeProblemHtml('3772', '1', '<html>page-1</html>');
  await store.writeContestPageHtml('3772', '<html>x</html>', '');
  await store.ensureContestDir('3772', '');
  check('目录数仍为 1', fs.readdirSync(contestsDir).length, 1);

  console.log('\n[9] 多比赛隔离');
  await store.writeContestPageHtml('4001', '<html>c4001</html>', '秋季赛');
  await store.writeProblemHtml('4001', '0', '<html>p4001</html>');
  const names2 = fs.readdirSync(contestsDir).sort();
  console.log('   ', names2);
  check('两个比赛两个目录', names2.length, 2);
  check('4001 目录名只含比赛标题', names2.includes('4001-秋季赛'), true);
  check('互不串味', await store.readProblemHtml('4001', '0'), '<html>p4001</html>');
  check('3772 的题 0 未被污染', await store.readProblemHtml('3772', '0'), undefined); // 已过期

  console.log('\n[10] slug 与路径边界');
  check('slugify 非法字符', P.slugify('a<b>:c"/d\\e|f?g*h', 40), 'a-b-c-d-e-f-g-h');
  check('contestDirName 空标题', P.contestDirName('4001', ''), '4001');
  check('contestDirName 全非法字符', P.contestDirName('4002', '///'), '4002');
  check('sanitizePid 非数字', P.sanitizePid('A/B'), 'A-B');
  check('sanitizePid 数字', P.sanitizePid('12'), '12');
  check('slugify 截断', P.slugify('x'.repeat(80), 10), 'x'.repeat(10));

  console.log('\n[11] 清理缓存：删站点数据，保留用户产物');
  await store.ensureDir(cp.codeDir('0'));
  await store.ensureDir(cp.testDir('0'));
  fs.writeFileSync(path.join(cp.codeDir('0'), 'main.cpp'), 'int main(){}');
  fs.writeFileSync(cp.testResult('0'), '{"ok":true}');

  const before = await store.listCachedContests();
  const entry = before.find(c => c.cid === '3772');
  ok('listCachedContests 能列出比赛', !!entry);
  ok('体积统计含用户产物', entry.userBytes > 0);
  ok('体积统计含站点数据', entry.dataBytes > 0);

  await store.purgeContestData('3772');
  ok('raw/ 已删除', !fs.existsSync(cp.rawDir));
  ok('题目 raw/ 已删除', !fs.existsSync(cp.problemRawDir('0')));
  ok('图片 assets/ 已删除', !fs.existsSync(cp.problemAssetsDir('0')));
  ok('样例 samples/ 已删除', !fs.existsSync(cp.samplesDir('0')));
  ok('meta.json 保留（目录定位依赖）', fs.existsSync(cp.meta));
  ok('code/ 保留', fs.existsSync(path.join(cp.codeDir('0'), 'main.cpp')));
  ok('test/ 保留', fs.existsSync(cp.testResult('0')));
  check('清理后仍能定位目录', !!(await store.resolveContestDir('3772')), true);

  console.log('\n[12] cache.enabled=false 时不应落盘');
  const ws2 = path.join(os.tmpdir(), `vsoj-cache-test-ws2-${process.pid}`);
  fs.rmSync(ws2, { recursive: true, force: true }); fs.mkdirSync(ws2, { recursive: true });
  vscodeStub.workspace.workspaceFolders[0].uri.fsPath = ws2;
  cfg['cache.enabled'] = false;
  const store2 = new CacheStore(context);
  await store2.ensureRoot();
  await store2.writeContestPageHtml('5001', '<html>y</html>', '禁用测试');
  await store2.writeProblemHtml('5001', '0', '<html>y0</html>');
  const ws2Contests = path.join(ws2, '.vsoj', 'contests');
  const leaked = fs.existsSync(ws2Contests) && fs.readdirSync(ws2Contests).length > 0;
  check('未产生比赛目录', leaked, false);

  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.rmSync(ws2, { recursive: true, force: true });
  fs.rmSync(GLOBAL_STORAGE, { recursive: true, force: true });

  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
