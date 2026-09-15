// 题目索引同步（cache/store.ts · syncProblemIndex）—— 题集插题 / 删题后的映射重建
//
// 核心断言：
//   1. 题集变动后，同一道题继续用它的目录（身份 = 全局题号，退到**目录名里的题名**）
//   2. 旧索引里的 title 已被后来的题覆盖过，所以身份不能看 title —— 目录名才是不变的
//   3. 一道题在磁盘上留下多个目录时，认「用户产物更多」的那个（源码所在处）
//   4. 位置上换了人的目录，站点缓存作废（下次打开重抓）；用户源码与 test/ 一个字不动
//   5. 新题新建目录；站点上消失的题保留目录但不再参与映射
//
// 运行：node test/sync.test.js
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
const WORKSPACE = env.workspaceFolder;
const GLOBAL_STORAGE = env.globalStorage;

const { CacheStore } = require('../out/cache/store.js');

const context = { globalStorageUri: { fsPath: GLOBAL_STORAGE } };
const { check, ok, done } = makeChecker();

const CID = '3775';
const CONTEST_DIR = path.join(WORKSPACE, `${CID}-数据结构`);
const problemsDir = (...p) => path.join(CONTEST_DIR, 'problems', ...p);

/** 题目目录名（v2 格式：`<字母>-问题-<字母>-<题名>`） */
const v2dir = (letter, title) => `${letter}-问题-${letter}-${title}`;

/** 造一个题目目录：`source`/`work` 是用户产物的字节数，`heading` 是缓存的题面标题 */
function seedProblem(dir, { source = 0, work = 0, cache = true, heading } = {}) {
  const base = problemsDir(dir);
  fs.mkdirSync(base, { recursive: true });
  if (source > 0) { fs.writeFileSync(path.join(base, 'main.cpp'), 'x'.repeat(source)); }
  if (work > 0) {
    fs.mkdirSync(path.join(base, 'test'), { recursive: true });
    fs.writeFileSync(path.join(base, 'test', 'report.md'), 'y'.repeat(work));
  }
  if (cache) {
    for (const sub of ['raw', 'samples', 'assets']) {
      fs.mkdirSync(path.join(base, sub), { recursive: true });
    }
    fs.writeFileSync(path.join(base, 'raw', 'page.html'), `<h3>${heading || dir}</h3>`);
    fs.writeFileSync(path.join(base, 'samples', '1.in'), '1');
    fs.writeFileSync(path.join(base, 'assets', 'a.png'), 'x');
  }
}

/** 写一份 v2 格式的 meta（旧数据：没有 identity 字段，title 可能已被覆盖） */
function writeMeta(problems, extra = {}) {
  fs.mkdirSync(CONTEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTEST_DIR, 'meta.json'), JSON.stringify({
    cid: CID,
    title: '数据结构',
    baseUrl: 'http://oj.example/JudgeOnline',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    layoutVersion: 2,
    problemCount: problems.length,
    problems,
    ...extra,
  }, null, 2));
}

const entryOfPid = (meta, pid) => meta.problems.find(p => String(p.pid) === String(pid));

(async () => {
  const store = new CacheStore(context, require('../out/cache/paths.js').CachePaths.resolve(context));

  // ---------- 1. 中间插题：序号集体后移，目录必须跟着题目走 ----------
  console.log('[1] 题集中间插题 —— 后续题号后移');
  {
    writeMeta([
      { pid: '0', dir: v2dir('A', '甲'), title: '问题 A: 甲' },
      { pid: '1', dir: v2dir('B', '乙'), title: '问题 B: 乙' },
    ]);
    seedProblem(v2dir('A', '甲'), { source: 500, heading: '问题 A: 甲' });
    seedProblem(v2dir('B', '乙'), { source: 500, heading: '问题 B: 乙' });

    const plan = await store.syncProblemIndex(CID, [
      { pid: '0', title: '丙' },
      { pid: '1', title: '甲' },
      { pid: '2', title: '乙' },
    ]);
    const meta = await store.readContestMeta(CID);

    check('甲的题号 0 → 1', entryOfPid(meta, '1').dir, v2dir('A', '甲'));
    check('乙的题号 1 → 2', entryOfPid(meta, '2').dir, v2dir('B', '乙'));
    check('新题「丙」拿到新目录', entryOfPid(meta, '0').dir !== v2dir('A', '甲'), true);
    check('新题目录名带身份前缀', entryOfPid(meta, '0').dir.startsWith('t'), true);
    check('新增 1 题', plan.added.length, 1);
    check('按题名命中 2 题', plan.matchedBy.title, 2);
    check('两道题的题号都变了', plan.moved.length, 2);
    ok('甲的源码没被动', fs.existsSync(path.join(problemsDir(v2dir('A', '甲')), 'main.cpp')));
    ok('甲的题面仍可读（内容就是甲的）',
      typeof (await store.readProblemHtml(CID, '1')) === 'string');
  }

  // ---------- 2. 删题：目录保留，只从映射里摘掉 ----------
  console.log('\n[2] 中间删题 —— 目录保留（源码不可再生）');
  {
    writeMeta([
      { pid: '0', dir: v2dir('A', '甲'), title: '问题 A: 甲' },
      { pid: '1', dir: v2dir('B', '乙'), title: '问题 B: 乙' },
      { pid: '2', dir: v2dir('C', '丙'), title: '问题 C: 丙' },
    ]);
    seedProblem(v2dir('A', '甲'), { source: 500, heading: '问题 A: 甲' });
    seedProblem(v2dir('B', '乙'), { source: 700, heading: '问题 B: 乙' });
    seedProblem(v2dir('C', '丙'), { source: 500, heading: '问题 C: 丙' });

    await store.syncProblemIndex(CID, [
      { pid: '0', title: '甲' },
      { pid: '1', title: '丙' },
    ]);
    const meta = await store.readContestMeta(CID);

    check('索引只剩 2 条', meta.problems.length, 2);
    check('丙的题号 2 → 1', entryOfPid(meta, '1').dir, v2dir('C', '丙'));
    check('被删的题登记为孤儿', (meta.orphans || []).map(o => o.dir), [v2dir('B', '乙')]);
    ok('孤儿目录连同源码留在磁盘上', fs.existsSync(path.join(problemsDir(v2dir('B', '乙')), 'main.cpp')));
  }

  // ---------- 3. 旧 title 被覆盖 → 身份只能看目录名 ----------
  console.log('\n[3] 旧索引的 title 已被后来的题覆盖');
  {
    // 实测形态：同一序号换了人，title 连同目录一起被改写，但**目录名不会变**
    writeMeta([
      { pid: '20', dir: v2dir('U', '仿真器-(Emulator)'), title: '问题 U: 24点游戏(Ⅲ)' },
    ]);
    seedProblem(v2dir('U', '仿真器-(Emulator)'), { source: 8000, heading: '问题 U: 24点游戏(Ⅲ)' });

    await store.syncProblemIndex(CID, [{ pid: '28', title: '仿真器 (Emulator)' }]);
    const meta = await store.readContestMeta(CID);

    check('按目录名认亲 → 复用原目录', entryOfPid(meta, '28').dir, v2dir('U', '仿真器-(Emulator)'));
    check('题号已刷新为 28', entryOfPid(meta, '28').pid, '28');
    check('没有当成新题', (meta.orphans || []).length, 0);
    ok('用户代码原地不动', fs.existsSync(path.join(problemsDir(v2dir('U', '仿真器-(Emulator)')), 'main.cpp')));
    check('目录里那份 24点(Ⅲ) 的题面读不出来（会重抓仿真器的）',
      await store.readProblemHtml(CID, '28'), undefined);
  }

  // ---------- 4. 一道题留下多个目录 → 认用户产物多的那个 ----------
  console.log('\n[4] 同名目录多份 —— 认用户真正动过的那个');
  {
    const uDir = v2dir('U', '仿真器-(Emulator)');   // 目录名说仿真器，title 已被 24点(Ⅲ) 覆盖
    const wDir = v2dir('W', '仿真器-(Emulator)');   // 用户在这里写了仿真器代码
    const acDir = v2dir('AC', '仿真器-(Emulator)'); // 又一份重复登记

    writeMeta([
      { pid: '20', dir: uDir, title: '问题 U: 24点游戏(Ⅲ)' },
      { pid: '22', dir: wDir, title: '问题 W: 仿真器 (Emulator)' },
      { pid: '28', dir: acDir, title: '问题 AC: 仿真器 (Emulator)' },
    ]);
    seedProblem(uDir, { source: 132, heading: '问题 U: 24点游戏(Ⅲ)' });
    seedProblem(wDir, { source: 8446, work: 900, heading: '问题 W: 推箱子游戏-广度优先搜索版本' });
    seedProblem(acDir, { source: 132, heading: '问题 AC: 仿真器 (Emulator)' });

    await store.syncProblemIndex(CID, [
      { pid: '20', title: '24点游戏(Ⅲ)' },
      { pid: '22', title: '推箱子游戏-广度优先搜索版本' },
      { pid: '28', title: '仿真器 (Emulator)' },
    ]);
    const meta = await store.readContestMeta(CID);

    check('仿真器认在 W（用户代码所在）', entryOfPid(meta, '28').dir, wDir);
    check('24点(Ⅲ) 用 U 目录（题面本来就在那儿）', entryOfPid(meta, '20').dir, uDir);
    ok('推箱子-广度新建目录', ![uDir, wDir, acDir].includes(entryOfPid(meta, '22').dir));
    check('落选的重复目录登记为孤儿', (meta.orphans || []).map(o => o.dir), [acDir]);

    const wSource = path.join(problemsDir(wDir), 'main.cpp');
    ok('W 里的源码还在', fs.existsSync(wSource));
    check('W 里的源码字节数未变', fs.statSync(wSource).size, 8446);
    ok('W 里的测试记录还在', fs.existsSync(path.join(problemsDir(wDir), 'test', 'report.md')));
    ok('U 的题面可读（就是这道题的）', typeof (await store.readProblemHtml(CID, '20')) === 'string');
    check('W 里那份属于别的题的题面读不出来（会重抓仿真器的）',
      await store.readProblemHtml(CID, '28'), undefined);
  }

  // ---------- 5. 幂等：列表没变时不产生任何变化 ----------
  console.log('\n[5] 幂等性 —— 同一列表再同步一次');
  {
    const meta0 = await store.readContestMeta(CID);
    const list = meta0.problems
      .filter(p => !p.dir.startsWith('t'))
      .map(p => ({ pid: p.pid, title: p.title, ...(p.globalId ? { globalId: p.globalId } : {}) }));

    const plan = await store.syncProblemIndex(CID, list);
    const meta1 = await store.readContestMeta(CID);

    check('无新增', plan.added.length, 0);
    check('无题号变动', plan.moved.length, 0);
    check('映射逐条不变',
      meta1.problems.map(p => p.dir), meta0.problems.filter(p => !p.dir.startsWith('t')).map(p => p.dir));
  }

  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.rmSync(GLOBAL_STORAGE, { recursive: true, force: true });
  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
