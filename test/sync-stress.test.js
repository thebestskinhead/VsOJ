// 题目索引同步的激进测试（cache/store.ts · syncProblemIndex）
//
// 场景：比赛数据集**高频、大范围**变动 —— 尾插 / 尾删 / 中间插入 / 中间删除 /
// 头部插入 / 头部删除 / 整体重排 / 截断（模拟受限页只解析出前几题）/ 重复行；
// 前提：题目标题不变（题名是身份的兜底依据，必须唯一且稳定）。
//
// 每轮同步后核对的不变量（任一条被破坏即视为数据事故）：
//   A 目录不乱认：题目只能拿自己的目录 —— 序号怎么平移、题集怎么增删，都不换主人，
//                 也不能占用「本轮之前就存在、且不属于自己」的陌生目录
//   B 用户产物零改动：main.cpp / test/** 逐字节不变，任何目录都不被删掉
//   C 缓存可刷新：按 pid 读到的题面要么是本道题的、要么读不到（→ 重抓落盘），
//                 刷新后每道题都能读回自己的题面，且题面只落进本道题自己的目录
//
// 题面身份只认**与位置无关**的标记（全局题号 + 题目 id）：位置字母会随题集变动，
// 缓存的题面里留着旧字母是正常的（同一道题的题名没变，这份缓存继续有效）。
//
// 随机序列用固定种子，失败可复现（断言里带轮次与操作名）。
//
// 运行：node test/sync-stress.test.js
const path = require('path');
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

const { CacheStore, letterOf } = require('../out/cache/store.js');

const context = { globalStorageUri: { fsPath: GLOBAL_STORAGE } };
const { check, ok, done } = makeChecker();

const CID = '3775';
const CTITLE = '数据结构';
const CONTEST_DIR = path.join(WORKSPACE, `${CID}-${CTITLE}`);
const problemsRoot = () => path.join(CONTEST_DIR, 'problems');

// ────────────────────────── 随机源（固定种子，可复现） ──────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 当前随机源（分阶段换种子，失败可复现） */
let rand = mulberry32(20260915);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const intIn = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
// ────────────────────────── 站点数据集（模型 / 判定基准） ──────────────────────────
let uid = 0;
/** 造一道新题：题名唯一、全局题号唯一，二者都不随时间变化 */
function newProblem() {
  uid += 1;
  return {
    id: `p${uid}`,
    globalId: String(3000 + uid),
    title: `题${uid}·规模(${['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'][uid % 4]})`,
  };
}
let site = [];                       // 当前站点题目列表（顺序即 pid 序号）
const listOf = (s) => s.map((p, i) => ({ pid: String(i), title: p.title, globalId: p.globalId }));

/** 这份题面是不是这道题的 —— 只认与位置无关的标记 */
const isPageOf = (html, p) => typeof html === 'string'
  && html.includes(`globalId=${p.globalId}`) && html.includes(`>${p.id}<`);
const htmlFor = (p, pid) => `<html><body><h3>问题 ${letterOf(pid)}: ${p.title}</h3>`
  + `<p>globalId=${p.globalId}</p><p>${p.id}</p></body></html>`;

// ────────────────────────── 磁带机（磁盘事实） ──────────────────────────
const dirOwner = new Map();          // 目录名 → 题目 id（谁的东西在里头，永不变更）
const userArtifacts = new Map();     // `目录/相对路径` → 内容（用户产物，永不变更）

function writeUserArtifact(dir, rel, content) {
  const p = path.join(problemsRoot(), dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  userArtifacts.set(`${dir}/${rel}`, content);
}

function seedDir(dir, p) {
  writeUserArtifact(dir, 'main.cpp', `// ${p.id}\nint main(){return ${p.globalId.length};}\n`);
  writeUserArtifact(dir, 'test/report.md', `# ${p.id} ${p.title}\n${'y'.repeat(p.globalId.length * 3)}\n`);
  dirOwner.set(dir, p.id);
  (p.ownDirs = p.ownDirs || new Set()).add(dir);
}

/** 磁盘上的题目目录清单 */
function dirsOnDisk() {
  const root = problemsRoot();
  if (!fs.existsSync(root)) { return []; }
  return fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory());
}

/** 用户产物现状（新增目录不算改动；只看已登记的每一份是否原样还在） */
function auditUserArtifacts() {
  const bad = [];
  for (const [key, content] of userArtifacts) {
    const p = path.join(problemsRoot(), key);
    if (!fs.existsSync(p)) { bad.push(`丢失 ${key}`); continue; }
    if (fs.readFileSync(p, 'utf8') !== content) { bad.push(`被改写 ${key}`); }
  }
  return bad;
}

// ────────────────────────── 一轮 ──────────────────────────
const metaFile = () => path.join(CONTEST_DIR, 'meta.json');
const entryOfPid = (meta, pid) => (meta.problems || []).find(p => String(p.pid) === String(pid));

/**
 * 同步索引 → 核对不变量 → 刷新全部题面。
 * @param opts.legacy 本轮列表不带全局题号（模拟旧站点 / 解析退化）
 * @param opts.skipRefresh 不做题面刷新（用于「列表为空」这类极端轮）
 */
async function round(store, label, opts = {}) {
  const tag = `[${label}]`;
  const dirsBefore = new Set(dirsOnDisk());

  const list = listOf(site).map(x => (opts.legacy ? { pid: x.pid, title: x.title } : x));
  const plan = await store.syncProblemIndex(CID, list);
  const meta = await store.readContestMeta(CID);

  // ── A 目录不乱认 ──
  const anchorBad = [];
  for (let i = 0; i < site.length; i += 1) {
    const p = site[i];
    const e = entryOfPid(meta, String(i));
    if (!e) { anchorBad.push(`pid=${i} 无条目`); continue; }
    const owner = dirOwner.get(e.dir);
    if (owner !== undefined && owner !== p.id) {
      anchorBad.push(`pid=${i}(${p.id}) 拿到别人的目录 ${e.dir}（本属 ${owner}）`);
    } else if (owner === undefined && dirsBefore.has(e.dir)) {
      anchorBad.push(`pid=${i}(${p.id}) 占用了先于本轮存在的陌生目录 ${e.dir}`);
    }
  }
  check(`${tag} A 目录不乱认（不夺舍、不占陌生目录）`, anchorBad, []);

  const dirToId = new Map();
  const dupBad = [];
  for (let i = 0; i < site.length; i += 1) {
    const e = entryOfPid(meta, String(i));
    if (!e) { continue; }
    if (dirToId.has(e.dir) && dirToId.get(e.dir) !== site[i].id) {
      dupBad.push(`目录 ${e.dir} 同时属于 ${dirToId.get(e.dir)} 与 ${site[i].id}`);
    }
    dirToId.set(e.dir, site[i].id);
    if (!dirOwner.has(e.dir)) { dirOwner.set(e.dir, site[i].id); }
    (site[i].ownDirs = site[i].ownDirs || new Set()).add(e.dir);
  }
  check(`${tag} A 目录唯一归属`, dupBad, []);
  check(`${tag} 索引条数与列表条数一致`, (meta.problems || []).length, list.length);

  // ── B 用户产物零改动 ──
  check(`${tag} B 用户源码与测试记录逐字节不变`, auditUserArtifacts(), []);

  // ── C 缓存可刷新 ──
  if (!opts.skipRefresh) {
    const wrong = [];
    for (let i = 0; i < site.length; i += 1) {
      const got = await store.readProblemHtml(CID, String(i));
      if (got !== undefined && !isPageOf(got, site[i])) { wrong.push(`pid=${i} 读到了别的题的题面`); }
    }
    check(`${tag} C 读缓存只会读到本道题的题面`, wrong, []);

    const dirty = [];
    for (let i = 0; i < site.length; i += 1) {
      const pid = String(i);
      if ((await store.readProblemHtml(CID, pid)) === undefined) {
        await store.writeProblemHtml(CID, pid, htmlFor(site[i], pid));
      }
      const back = await store.readProblemHtml(CID, pid);
      if (back === undefined) { dirty.push(`pid=${pid} 落盘后仍读不到题面`); }
      else if (!isPageOf(back, site[i])) { dirty.push(`pid=${pid} 落盘后读到的是别的题`); }
    }
    check(`${tag} C 刷新后每道题都能读回自己的题面`, dirty, []);

    const misplaced = [];
    for (let i = 0; i < site.length; i += 1) {
      const e = entryOfPid(meta, String(i));
      const file = path.join(problemsRoot(), e.dir, 'raw', 'page.html');
      if (!fs.existsSync(file)) { misplaced.push(`pid=${i} 题面没落在自己目录 ${e.dir}`); continue; }
      if (!isPageOf(fs.readFileSync(file, 'utf8'), site[i])) {
        misplaced.push(`pid=${i} 自己目录里是别人的题面`);
      }
    }
    check(`${tag} C 题面只写进本道题自己的目录`, misplaced, []);
  }

  // ── 孤儿登记 ──
  const orph = (meta.orphans || []).map(o => o.dir);
  check(`${tag} 孤儿目录登记无重复`, orph.length - new Set(orph).size, 0);
  check(`${tag} 孤儿目录连同内容留在磁盘上`,
    orph.filter(d => !fs.existsSync(path.join(problemsRoot(), d))), []);
  check(`${tag} 命中统计自洽（fresh = added）`, plan.matchedBy.fresh - plan.added.length, 0);
  return { plan, meta };
}

// ────────────────────────── 站点变更操作 ──────────────────────────
const KINDS = ['tail', 'tailDel', 'head', 'headDel', 'mid', 'midDel', 'reorder', 'dup'];

function mutate(kind, n) {
  const len = site.length;
  switch (kind) {
    case 'tail': site.push(...Array.from({ length: n }, () => newProblem())); break;
    case 'tailDel': site.splice(Math.max(0, len - n), n); break;
    case 'head': site.unshift(...Array.from({ length: n }, () => newProblem())); break;
    case 'headDel': site.splice(0, n); break;
    case 'mid': site.splice(intIn(0, len), 0, ...Array.from({ length: n }, () => newProblem())); break;
    case 'midDel': site.splice(intIn(0, Math.max(0, len - n)), n); break;
    case 'cut': site = site.slice(0, Math.max(0, n)); break;   // 截断：模拟受限页只解析出前几题
    case 'reorder': site.reverse(); break;                     // 整体重排：所有 pid 一起变
    case 'dup': if (len) { site.splice(intIn(0, len), 0, site[intIn(0, len - 1)]); } break;
    default: break;
  }
}

// ────────────────────────── 主流程 ──────────────────────────
(async () => {
  const store = new CacheStore(context, require('../out/cache/paths.js').CachePaths.resolve(context));

  // ---------- 1. 起始状态：30 道题，每道题都带着自己的源码与测试记录 ----------
  console.log('[1] 建初始数据集（30 题，题题有源码 + 测试记录）');
  site = Array.from({ length: 30 }, (_, i) => ({ id: `p${i + 1}`, globalId: String(3000 + i), title: '' }));
  uid = 30;
  site.forEach((p, i) => { p.title = `题${i + 1}·规模(${['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'][i % 4]})`; });
  fs.mkdirSync(path.join(CONTEST_DIR, 'problems'), { recursive: true });
  // 布局 v2 遗留：目录名是 `<字母>-问题-<字母>-<题名>`，meta 里没有身份字段
  const legacyDirs = site.map((p, i) => `${letterOf(i)}-问题-${letterOf(i)}-${p.title}`);
  site.forEach((p, i) => { seedDir(legacyDirs[i], p); });
  fs.writeFileSync(metaFile(), JSON.stringify({
    cid: CID, title: CTITLE, baseUrl: 'http://oj.example/JudgeOnline',
    createdAt: '2026-01-01T00:00:00.000Z', lastSyncAt: '2026-01-01T00:00:00.000Z',
    layoutVersion: 2, problemCount: site.length,
    // 旧条目的题名字段已被后来的题改写（同一序号换了人时题名一起被覆盖），
    // 只有目录名里的题名可信 —— 这是「按题名认亲」必须成立的前提
    problems: site.map((p, i) => ({
      pid: String(i), dir: legacyDirs[i], letter: letterOf(i),
      title: site[(i + 1) % site.length].title,
    })),
  }, null, 2));

  await round(store, '旧数据首轮对齐');
  const meta0 = await store.readContestMeta(CID);
  check('全部题目沿用老目录（题名兜底命中）',
    meta0.problems.filter((p, i) => p.dir !== legacyDirs[i]).length, 0);
  check('没有题目被当成新题', meta0.problems.length, 30);

  // ---------- 2. 大范围操作序列（确定性覆盖四种基本形态 + 极端形态） ----------
  console.log('\n[2] 确定性大范围操作序列');
  mutate('tail', 6); await round(store, '尾插 6');
  mutate('mid', 5); await round(store, '中间插 5');
  mutate('head', 4); await round(store, '头插 4');
  mutate('tailDel', 7); await round(store, '尾删 7');
  mutate('midDel', 6); await round(store, '中间删 6');
  mutate('headDel', 3); await round(store, '头删 3');
  mutate('reorder', 0); await round(store, '整体重排');
  {
    const full = site.slice();
    mutate('cut', 5);
    await round(store, '截断到 5 题（模拟受限页）');
    check('截断期间目录一个没少', dirsOnDisk().length >= 30, true);
    check('截断后索引只剩 5 条', (await store.readContestMeta(CID)).problems.length, 5);
    check('被截掉的题都登记为孤儿',
      (await store.readContestMeta(CID)).orphans.length >= full.length - 5, true);
    site = full;
    await round(store, '放回整份名单');
    const back = (await store.readContestMeta(CID)).problems;
    const wrong = full.filter((p, i) => !p.ownDirs.has(entryOfPid({ problems: back }, String(i)).dir));
    check('恢复后每道题都回到自己的目录', wrong.map(p => p.id), []);
  }

  // ---------- 3. 随机高频变动（固定种子，两种规模各来一轮） ----------
  console.log('\n[3] 随机高频变动');
  const randomPhase = async (tag, seed, rounds, maxOps, batch) => {
    rand = mulberry32(seed);
    for (let r = 1; r <= rounds; r += 1) {
      const ops = Array.from({ length: intIn(1, maxOps) }, () => pick(KINDS));
      const detail = [];
      for (const k of ops) {
        const n = k === 'reorder' ? 0 : intIn(batch[0], batch[1]);
        mutate(k, n);
        detail.push(`${k}${n || ''}`);
      }
      await round(store, `${tag}${r} ${detail.join('+')}`);
    }
  };
  // 高频：每轮 1~3 次操作，每次 1~8 道
  await randomPhase('r', 20260915, 40, 3, [1, 8]);
  // 大范围：每轮 1~2 次操作，每次 5~20 道（一次动掉半份名单）
  await randomPhase('big', 777001, 15, 2, [5, 20]);

  // ---------- 4. 旧数据形态（列表不带全局题号） ----------
  console.log('\n[4] 列表不带全局题号（旧站点 / 解析退化）');
  mutate('mid', 4);
  await round(store, '旧形态 + 中间插 4', { legacy: true });
  mutate('midDel', 5);
  await round(store, '旧形态 + 中间删 5', { legacy: true });
  mutate('tail', 3);
  await round(store, '旧形态 + 尾插 3', { legacy: true });

  // ---------- 5. 极端：空列表（受限页）不得摧毁任何东西 ----------
  console.log('\n[5] 极端 —— 空列表');
  {
    const before = dirsOnDisk().length;
    const bak = site;
    site = [];
    await round(store, '空列表', { skipRefresh: true });
    check('空列表后目录一个没少', dirsOnDisk().length, before);
    check('空列表不删用户产物', auditUserArtifacts(), []);
    site = bak;
    await round(store, '空列表后恢复');
    check('恢复后索引回到原样', (await store.readContestMeta(CID)).problems.length, site.length);
  }

  // ---------- 6. 幂等：同一列表连跑两次，映射逐条不变 ----------
  console.log('\n[6] 幂等性');
  {
    const a = (await store.readContestMeta(CID)).problems.map(p => `${p.pid}|${p.dir}`);
    await round(store, '幂等复跑');
    const b = (await store.readContestMeta(CID)).problems.map(p => `${p.pid}|${p.dir}`);
    check('两次同步的 pid→目录映射逐条相同', b, a);
  }

  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.rmSync(GLOBAL_STORAGE, { recursive: true, force: true });
  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
