// 缓存层布局验证（桩替换 vscode 模块；重点验证「同一 cid 只产生一个目录」）
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const WORKSPACE = path.join(os.tmpdir(), 'vsoj-cache-test-ws');
const GLOBAL_STORAGE = path.join(os.tmpdir(), 'vsoj-cache-test-gs');
fs.rmSync(WORKSPACE, { recursive: true, force: true });
fs.rmSync(GLOBAL_STORAGE, { recursive: true, force: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(GLOBAL_STORAGE, { recursive: true });

const cfg = { 'workspace.root': '.vsoj', 'cache.enabled': true, 'cache.offline': false, 'cache.ttlSeconds': 180 };
const vscodeStub = {
  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: WORKSPACE } }],
    getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d) }),
  },
  Uri: { file: (p) => ({ fsPath: p }) },
  commands: { executeCommand: () => {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') { return 'vscode-stub'; }
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

const P = require('../out/cache/paths.js');
const { CacheStore } = require('../out/cache/store.js');

const context = { globalStorageUri: { fsPath: GLOBAL_STORAGE } };
let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; }
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}${ok ? '' : `  ← 期望 ${JSON.stringify(expected)}`}`);
};

(async () => {
  const layout = P.CachePaths.resolve(context);
  const store = new CacheStore(context, layout);
  console.log('缓存根:', layout.rootDir, '| 工作区级:', layout.inWorkspace);

  console.log('\n[1] 无标题路径写入（模拟 status / sample / problem）');
  await store.writeStatus('3772', []);
  const p1 = await store.ensureContestDir('3772', '');
  console.log('   目录:', path.relative(WORKSPACE, p1.dir));
  await store.writeProblem({ cid: '3772', pid: '0', title: 'A + B', description: '<p>求和</p>', inputDesc: '两整数', outputDesc: '一整数', sampleInput: '1 2\n', sampleOutput: '3\n' });
  await store.writeSample('3772', '0', 1, '1 2\n', '3\n');
  await store.writeSample('3772', '0', 2, '5 7\n', '12\n');

  console.log('\n[2] 拿到比赛标题后写入题目列表（应重命名目录一次）');
  await store.writeProblemList('3772', '2025年校赛 初赛:Round/1?', [
    { pid: '0', title: 'A + B', cid: '3772', status: 'accepted', acceptedCount: '10', submissionCount: '12' },
  ]);

  const contestsDir = path.join(layout.rootDir, 'contests');
  const contestNames = fs.readdirSync(contestsDir).sort();
  console.log('\n[3] contests/ 下的目录:', contestNames);
  check('同一 cid 只产生一个目录', contestNames.length, 1);
  check('目录名为 <cid>-<slug>', contestNames[0], '3772-2025年校赛-初赛-Round-1');

  const meta = await store.readContestMeta('3772');
  check('meta.cid', meta.cid, '3772');
  check('meta.title', meta.title, '2025年校赛 初赛:Round/1?');
  check('meta.pendingTitle 已清除', !!meta.pendingTitle, false);
  check('meta.problemCount', meta.problemCount, 1);
  check('meta.baseUrl', meta.baseUrl, 'http://localhost');

  console.log('\n[4] 回读校验');
  const list = await store.readProblemList('3772');
  check('题目列表', list && `${list.title}|${list.problems.length}`, '2025年校赛 初赛:Round/1?|1');
  const prob = await store.readProblem('3772', '0');
  check('题目详情 title', prob && prob.title, 'A + B');
  const samples = await store.readSamples('3772', '0');
  check('样例数据集', samples.map(s => `${s.index}:${s.input.trim()}->${s.output.trim()}`), ['1:1 2->3', '2:5 7->12']);
  const cp = await store.resolveContestDir('3772');
  check('isFresh(默认 180s)', await store.isFresh(cp.problemsIndex), true);
  check('isFresh(ttl=-1)', await store.isFresh(cp.problemsIndex, -1), true);
  check('hasContestDir', await store.hasContestDir('3772'), true);

  console.log('\n[5] 索引与磁盘一致性');
  const idx = await store.readIndex();
  check('索引存相对路径', idx.contests['3772'].dir, 'contests/3772-2025年校赛-初赛-Round-1');
  check('resolveContestDir 指向重命名后的目录', path.basename(cp.dir), '3772-2025年校赛-初赛-Round-1');

  console.log('\n[6] 幂等性：重复写入不应新增目录');
  await store.writeProblem({ cid: '3772', pid: '1', title: 'B', description: '', inputDesc: '', outputDesc: '', sampleInput: '', sampleOutput: '' });
  await store.writeProblemList('3772', '2025年校赛 初赛:Round/1?', []);
  await store.ensureContestDir('3772', '');
  check('目录数仍为 1', fs.readdirSync(contestsDir).length, 1);
  check('meta.problemCount 已更新为 0', (await store.readContestMeta('3772')).problemCount, 0);

  console.log('\n[7] 索引丢失后应能靠磁盘兜底');
  fs.rmSync(path.join(GLOBAL_STORAGE, 'cache-index.json'), { force: true });
  check('resolveContestDir 磁盘兜底', !!(await store.resolveContestDir('3772')), true);
  check('hasContestDir(无索引)', await store.hasContestDir('3772'), true);

  console.log('\n[8] 多比赛隔离');
  await store.writeProblemList('4001', '秋季赛', [{ pid: '0', title: 'X', cid: '4001', status: 'pending' }]);
  await store.writeProblem({ cid: '4001', pid: '0', title: 'X', description: '', inputDesc: '', outputDesc: '', sampleInput: '', sampleOutput: '' });
  const names2 = fs.readdirSync(contestsDir).sort();
  console.log('   ', names2);
  check('两个比赛两个目录', names2.length, 2);
  check('4001 读自己的题目列表', (await store.readProblemList('4001')).title, '秋季赛');
  check('4001 目录名不含题目名', names2.includes('4001-秋季赛'), true);

  console.log('\n[9] slug 与路径边界');
  check('slugify 非法字符', P.slugify('a<b>:c"/d\\e|f?g*h', 40), 'a-b-c-d-e-f-g-h');
  check('contestDirName 空标题', P.contestDirName('4001', ''), '4001');
  check('contestDirName 全非法字符', P.contestDirName('4002', '///'), '4002');
  check('sanitizePid 非数字', P.sanitizePid('A/B'), 'A-B');
  check('sanitizePid 数字', P.sanitizePid('12'), '12');
  check('slugify 截断', P.slugify('x'.repeat(80), 10), 'x'.repeat(10));

  console.log('\n[10] cache.enabled=false 时不应落盘');
  const ws2 = path.join(os.tmpdir(), 'vsoj-cache-test-ws2');
  fs.rmSync(ws2, { recursive: true, force: true }); fs.mkdirSync(ws2, { recursive: true });
  vscodeStub.workspace.workspaceFolders[0].uri.fsPath = ws2;
  cfg['cache.enabled'] = false;
  const store2 = new CacheStore(context);
  await store2.ensureRoot();
  await store2.writeProblemList('5001', '禁用测试', []);
  await store2.writeProblem({ cid: '5001', pid: '0', title: 'Y', description: '', inputDesc: '', outputDesc: '', sampleInput: '', sampleOutput: '' });
  const ws2Contests = path.join(ws2, '.vsoj', 'contests');
  const leaked = fs.existsSync(ws2Contests) && fs.readdirSync(ws2Contests).length > 0;
  check('未产生比赛目录', leaked, false);

  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.rmSync(ws2, { recursive: true, force: true });
  fs.rmSync(GLOBAL_STORAGE, { recursive: true, force: true });

  console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
