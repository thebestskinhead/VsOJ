// 缓存层布局与语义验证（布局 v3）
//
// 核心断言：
//   1. 同一 cid 只产生一个目录（S1 的老问题，防回归）
//   2. 比赛项目文件夹建在**工作区根下、可见**；列表缓存在隐藏的 .vsoj/ 里
//   3. 题目目录名 = <全局题号>-<标题>，由 meta.json.problems 唯一映射
//   4. 缓存里**只有原始信息**（HTML / 图片二进制 / 样例文本），没有解析产物
//   5. 清理缓存删站点数据 + temp/，保留 main.cpp + test/ + meta.json
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
  + '<tr><td>1722 Problem &nbsp;A</td><td><a href="problem.php?cid=3772&pid=0">A + B</a></td></tr>'
  + '</tbody></table></html>';

/** 工作区根下的可见目录（即比赛项目文件夹），排除隐藏的内部数据根 */
const visibleDirs = () => fs.readdirSync(WORKSPACE).filter(n => !n.startsWith('.')).sort();
/** 隐藏目录（内部数据根） */
const hiddenDirs = () => fs.readdirSync(WORKSPACE).filter(n => n.startsWith('.')).sort();

(async () => {
  const layout = P.CachePaths.resolve(context);
  const store = new CacheStore(context, layout);
  console.log('工作区根:', layout.projectRoot);
  console.log('内部数据根:', layout.rootDir, '| 工作区级:', layout.inWorkspace);

  console.log('\n[1] 无标题写入（模拟直接打开题目页）');
  // 新语义：比赛根目录只由「用户同意初始化」创建（缓存写穿不再顺手建目录），
  // 所以这里先显式建目录，再写缓存。
  await store.ensureContestDir('3772', '');
  await store.writeStatusHtml('3772', '<html>status</html>');
  await store.writeProblemHtml('3772', '0', '<html>page-0</html>');
  const p1 = await store.resolveContestDir('3772');
  check('尚无标题时目录名退化为纯 cid', path.basename(p1.dir), '3772');
  check('meta.pendingTitle 标记为真', (await store.readContestMeta('3772')).pendingTitle, true);
  check('比赛目录建在工作区根下（可见）', path.dirname(p1.dir), WORKSPACE);
  ok('内部数据根是隐藏的 .vsoj', hiddenDirs().includes('.vsoj'));
  check('meta.layoutVersion 写入 3', (await store.readContestMeta('3772')).layoutVersion, 3);
  ok('尚未登记题目时目录退化为数字 pid', path.basename(p1.problemDir('0')) === '0');

  console.log('\n[2] 拿到比赛标题后写入比赛页（目录应重命名且只重命名一次）');
  await store.writeContestPageHtml('3772', CONTEST_HTML_LATER, '2025年校赛 初赛:Round/1?');
  const names = visibleDirs();
  console.log('   工作区根下的比赛目录:', names);
  check('同一 cid 只产生一个目录', names.length, 1);
  check('目录名为 <cid>-<slug>', names[0], '3772-2025年校赛-初赛-Round-1');
  ok('比赛页落在可见目录里', fs.existsSync(path.join(WORKSPACE, names[0], 'contest-raw', 'contest.html')));

  const meta = await store.readContestMeta('3772');
  check('meta.title', meta.title, '2025年校赛 初赛:Round/1?');
  check('meta.pendingTitle 已清除', !!meta.pendingTitle, false);
  check('meta.cid', meta.cid, '3772');

  console.log('\n[3] 登记题目（身份 → 目录名 的唯一映射）');
  const cp0 = await store.resolveContestDir('3772');
  await store.registerProblem('3772', { pid: '0', globalId: '1722', title: 'A + B' });
  const cp = await store.resolveContestDir('3772');
  check('题目目录名 = <全局题号>-<标题>', path.basename(cp.problemDir('0')), '1722-A-+-B');
  ok('历史遗留的数字 pid 目录已迁移（不产生孤儿）', !fs.existsSync(path.join(cp.dir, 'problems', '0')));
  ok('迁移后原有的 raw/page.html 仍在', fs.existsSync(cp.problemHtml('0')));
  check('meta.problems 记录 globalId', (await store.readContestMeta('3772')).problems[0].globalId, '1722');
  check('meta.problemCount 更新', (await store.readContestMeta('3772')).problemCount, 1);
  check('contest-raw 路径出口正确', path.basename(path.dirname(cp.contestHtml)), 'contest-raw');
  check('赛事级原始目录与题目级原始目录同名不同层',
    [path.basename(cp.contestRawDir), path.basename(cp.problemRawDir('0'))], ['contest-raw', 'raw']);
  ok('旧路径对象仍指向同一比赛目录', cp0.dir === cp.dir);

  console.log('\n[4] 落盘的必须是原始信息');
  ok('contest-raw/contest.html 存在', fs.existsSync(cp.contestHtml));
  ok('contest-raw/status.html 存在', fs.existsSync(cp.statusHtml));
  ok('problems/1722-A-+-B/raw/page.html 存在', fs.existsSync(cp.problemHtml('0')));
  check('contest.html 内容为原始 HTML', await store.readText(cp.contestHtml), CONTEST_HTML_LATER);

  // 解析产物不得落盘
  ok('problem.json 不存在（解析产物不落盘）', !fs.existsSync(path.join(cp.problemDir('0'), 'problem.json')));
  ok('problem.md 不存在（派生文本不落盘）', !fs.existsSync(path.join(cp.problemDir('0'), 'problem.md')));
  ok('problems.json 不存在（解析产物不落盘）', !fs.existsSync(path.join(cp.dir, 'problems.json')));
  ok('status.json 不存在（解析产物不落盘）', !fs.existsSync(path.join(cp.dir, 'status.json')));
  ok('比赛顶层不再有 raw/（已收敛为 contest-raw/）', !fs.existsSync(path.join(cp.dir, 'raw')));

  console.log('\n[5] 回到原始 HTML');
  check('readProblemHtml', await store.readProblemHtml('3772', '0'), '<html>page-0</html>');
  check('readStatusHtml', await store.readStatusHtml('3772'), '<html>status</html>');
  check('hasProblemHtml（不看新鲜度）', await store.hasProblemHtml('3772', '0'), true);
  check('hasProblemHtml 未缓存的题', await store.hasProblemHtml('3772', '9'), false);

  console.log('\n[6] 样例与图片（原始文本 / 原始二进制）');
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

  console.log('\n[7] 新鲜度与年龄');
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

  console.log('\n[8] 索引与磁盘一致性');
  const idx = await store.readIndex();
  check('索引版本为 2', idx.version, 2);
  check('索引存相对工作区根的路径', idx.contests['3772'].dir, '3772-2025年校赛-初赛-Round-1');
  fs.rmSync(path.join(GLOBAL_STORAGE, 'cache-index.json'), { force: true });
  check('索引丢失后磁盘兜底', !!(await store.resolveContestDir('3772')), true);
  fs.writeFileSync(path.join(WORKSPACE, '3772-notes'), 'not a contest');
  fs.mkdirSync(path.join(WORKSPACE, '3772-decoy'), { recursive: true });
  check('只靠目录名前缀不算亲（须 meta.cid 一致）',
    path.basename((await store.resolveContestDir('3772')).dir), '3772-2025年校赛-初赛-Round-1');
  fs.rmSync(path.join(WORKSPACE, '3772-notes'), { force: true });
  fs.rmSync(path.join(WORKSPACE, '3772-decoy'), { recursive: true, force: true });

  console.log('\n[9] 幂等性：重复写入不应新增目录');
  await store.writeProblemHtml('3772', '1', '<html>page-1</html>');
  await store.writeContestPageHtml('3772', '<html>x</html>', '');
  await store.ensureContestDir('3772', '');
  await store.registerProblem('3772', { pid: '0', globalId: '1722', title: '改名了吧' });
  check('目录数仍为 1', visibleDirs().length, 1);
  check('目录名定稿后不随标题变化（C11）',
    path.basename((await store.resolveContestDir('3772')).problemDir('0')), '1722-A-+-B');

  console.log('\n[10] 多比赛隔离');
  await store.ensureContestDir('4001', '');
  await store.writeContestPageHtml('4001', '<html>c4001</html>', '秋季赛');
  await store.writeProblemHtml('4001', '0', '<html>p4001</html>');
  const names2 = visibleDirs();
  console.log('   ', names2);
  check('两个比赛两个目录', names2.length, 2);
  check('4001 目录名只含比赛标题', names2.includes('4001-秋季赛'), true);
  check('互不串味', await store.readProblemHtml('4001', '0'), '<html>p4001</html>');
  check('3772 的题 0 未被污染', await store.readProblemHtml('3772', '0'), undefined); // 已过期

  console.log('\n[10.5] 缓存写穿不建比赛目录（目录只由「同意初始化」创建）');
  {
    const cid = '7001';
    // 目录不存在时：所有缓存写入都跳过，且**不建目录**
    await store.writeContestPageHtml(cid, '<html>c</html>', '不该建目录');
    await store.writeProblemHtml(cid, '0', '<html>p</html>');
    await store.writeStatusHtml(cid, '<html>s</html>');
    await store.writeSamples(cid, '0', [{ input: '1\n', output: '1\n' }]);
    check('没有生成 <cid>-<标题> 目录',
      fs.existsSync(path.join(WORKSPACE, `${cid}-不该建目录`)), false);
    check('也没有生成纯 <cid> 目录', fs.existsSync(path.join(WORKSPACE, cid)), false);
    check('resolveContestDir 仍为 undefined', await store.resolveContestDir(cid), undefined);

    // 索引同步同样不建目录 —— 否则删掉目录后，一次题目列表刷新就会让它「复活」
    const plan = await store.syncProblemIndex(cid, [{ pid: '0', title: '甲' }]);
    check('目录不存在 → 空计划', [plan.entries.length, plan.added.length], [0, 0]);
    check('同步后依旧未初始化', await store.readContestMeta(cid), undefined);

    // 同意初始化（建目录）之后，缓存写穿照常工作
    await store.ensureContestDir(cid, '');
    await store.writeProblemHtml(cid, '0', '<html>p</html>');
    check('目录已存在 → 缓存正常落盘', await store.readProblemHtml(cid, '0'), '<html>p</html>');

    // 删掉整个比赛目录 → 又回到「需要重新征求同意」
    const dir = (await store.resolveContestDir(cid)).dir;
    fs.rmSync(dir, { recursive: true, force: true });
    check('目录删掉后 → 未初始化（下次打开会重新问）', await store.readContestMeta(cid), undefined);
  }

  console.log('\n[11] slug 与路径边界');
  check('slugify 非法字符', P.slugify('a<b>:c"/d\\e|f?g*h', 40), 'a-b-c-d-e-f-g-h');
  check('contestDirName 空标题', P.contestDirName('4001', ''), '4001');
  check('contestDirName 全非法字符', P.contestDirName('4002', '///'), '4002');
  check('sanitizePid 非数字', P.sanitizePid('A/B'), 'A-B');
  check('sanitizePid 数字', P.sanitizePid('12'), '12');
  check('slugify 截断', P.slugify('x'.repeat(80), 10), 'x'.repeat(10));
  check('problemDirName 全局题号+标题', P.problemDirName('g:1722', '复杂度分析(Ⅰ)'), '1722-复杂度分析(Ⅰ)');
  check('problemDirName 空标题只留前缀', P.problemDirName('g:1722', ''), '1722');
  check('numToLetter 0 → A', require('../out/utils/format.js').numToLetter(0), 'A');
  check('numToLetter 25 → Z', require('../out/utils/format.js').numToLetter(25), 'Z');
  check('numToLetter 26 → AA', require('../out/utils/format.js').numToLetter(26), 'AA');
  check('LAYOUT_VERSION', P.LAYOUT_VERSION, 3);
  check('默认源文件名', P.DEFAULT_SOURCE_FILE, 'main.cpp');
  check('mainSource 用默认源文件名', path.basename(cp.mainSource('0')), 'main.cpp');
  check('mainSource 可指定文件名', path.basename(cp.mainSource('0', 'sol.py')), 'sol.py');

  console.log('\n[12] 清理缓存：删站点数据 + temp/，保留 main.cpp + test/');
  await store.ensureDir(cp.tempDir('0'));
  await store.ensureDir(cp.testDir('0'));
  await store.writeUserFile(cp.mainSource('0'), 'int main(){}');
  fs.writeFileSync(path.join(cp.tempDir('0'), 'a.exe'), 'MZ');
  fs.writeFileSync(cp.testResult('0'), '{"ok":true}');

  const before = await store.listCachedContests();
  const entry = before.find(c => c.cid === '3772');
  ok('listCachedContests 能列出比赛', !!entry);
  ok('体积统计含用户产物', entry.userBytes > 0);
  ok('体积统计含站点数据', entry.dataBytes > 0);
  check('listCachedContests 不把 .vsoj 当比赛', before.some(c => c.dirName.startsWith('.')), false);

  await store.purgeContestData('3772');
  ok('contest-raw/ 已删除', !fs.existsSync(cp.contestRawDir));
  ok('题目 raw/ 已删除', !fs.existsSync(cp.problemRawDir('0')));
  ok('图片 assets/ 已删除', !fs.existsSync(cp.problemAssetsDir('0')));
  ok('样例 samples/ 已删除', !fs.existsSync(cp.samplesDir('0')));
  ok('temp/ 已删除', !fs.existsSync(cp.tempDir('0')));
  ok('meta.json 保留（目录定位依赖）', fs.existsSync(cp.meta));
  ok('main.cpp 保留（用户资产）', fs.existsSync(cp.mainSource('0')));
  ok('test/ 保留（评测历史）', fs.existsSync(cp.testResult('0')));
  check('清理后仍能定位目录', !!(await store.resolveContestDir('3772')), true);
  check('清理后题目目录名不变（仍由 meta 映射）',
    path.basename((await store.resolveContestDir('3772')).problemDir('0')), '1722-A-+-B');

  console.log('\n[13] cache.enabled=false 时站点数据不落盘，但用户资产仍可写');
  const ws2 = path.join(os.tmpdir(), `vsoj-cache-test-ws2-${process.pid}`);
  fs.rmSync(ws2, { recursive: true, force: true }); fs.mkdirSync(ws2, { recursive: true });
  vscodeStub.workspace.workspaceFolders[0].uri.fsPath = ws2;
  cfg['cache.enabled'] = false;
  const store2 = new CacheStore(context);
  await store2.ensureRoot();
  await store2.writeContestPageHtml('5001', '<html>y</html>', '禁用测试');
  await store2.writeProblemHtml('5001', '0', '<html>y0</html>');
  const leaked = fs.existsSync(path.join(ws2, '5001-禁用测试'));
  check('未产生比赛目录', leaked, false);
  const ws2Root = path.join(ws2, '.vsoj', 'lists');
  check('未产生列表缓存文件', fs.existsSync(ws2Root) && fs.readdirSync(ws2Root).length > 0, false);

  // 关掉缓存不该连带阻止「项目初始化」生成源文件
  const ws2Paths = P.CachePaths.resolve({ globalStorageUri: { fsPath: GLOBAL_STORAGE } });
  const lone = ws2Paths.contestAt(path.join(ws2, '5001-x'), { '0': 'A-Hello' });
  await store2.writeUserFile(lone.mainSource('0'), 'int main(){}');
  ok('writeUserFile 不受 cache.enabled 阻断', fs.existsSync(lone.mainSource('0')));
  ok('writeUserFile 会创建父目录', fs.existsSync(lone.problemDir('0')));

  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.rmSync(ws2, { recursive: true, force: true });
  fs.rmSync(GLOBAL_STORAGE, { recursive: true, force: true });

  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
