// 比赛上下文同步（utils/state.ts + extension.ts 启动恢复）
// 运行：node test/context-sync.test.js
//
// 背景（真实事故）：`view/title` 里题目列表那三个按钮的 `when` 全都要求 `oj.inContest`。
// 这个 context key 只在「进入比赛」等运行时命令里设置，而 cid 存在 globalState 里是持久的。
// 结果：重启 VS Code 后题目列表照常显示题目（cid 还在），标题栏按钮却**全部消失**
// （context key 回到未定义）。本套件锁死「cid 是唯一真相、上下文由它派生、启动必须补一次」。
const fs = require('fs');
const path = require('path');
const { installVscodeStub, makeChecker, makeMemoryMemento } = require('./helpers/stub');

const env = installVscodeStub();

const { StateManager } = require('../out/utils/state.js');

const { check, ok, done } = makeChecker();
const root = path.join(__dirname, '..');

/** 造一个最小的 ExtensionContext（只用到 globalState / secrets） */
function makeContext(initial = {}) {
  const globalState = makeMemoryMemento();
  for (const [k, v] of Object.entries(initial)) { globalState.update(k, v); }
  return {
    globalState,
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    },
  };
}

/** 最后一次 setContext 的值（只看 oj.inContest） */
function lastInContest() {
  const hits = env.commandLog.filter(c => c.cmd === 'setContext' && c.args[0] === 'oj.inContest');
  return hits.length ? hits[hits.length - 1].args[1] : undefined;
}

function resetLog() { env.commandLog.length = 0; }

async function main() {
  // ─────────────────────────────────────────────
  console.log('\n── 1. setCurrentCid 派生上下文（写 cid 必然带动 when 条件）──');
  {
    resetLog();
    const state = new StateManager(makeContext());

    await state.setCurrentCid('3772');
    check('进入比赛 → oj.inContest', lastInContest(), true);
    check('cid 已落盘', state.getCurrentCid(), '3772');

    await state.setCurrentCid(undefined);
    check('退出比赛 → oj.inContest', lastInContest(), false);
    check('cid 已清空', state.getCurrentCid(), undefined);
  }

  // ─────────────────────────────────────────────
  console.log('\n── 2. 启动恢复：globalState 有 cid，context key 是空的 ──');
  {
    // 模拟「上次会话进入了比赛 3772」：只有持久化状态，没有任何 context
    resetLog();
    const state = new StateManager(makeContext({ oj_current_cid: '3772' }));

    check('构造后尚未同步（模拟重启瞬间）', lastInContest(), undefined);
    check('题目列表能读到 cid（所以列表照常显示）', state.getCurrentCid(), '3772');

    await state.syncContestContext();
    check('启动补一次 → oj.inContest 恢复', lastInContest(), true);
  }

  // ─────────────────────────────────────────────
  console.log('\n── 3. 启动恢复：没有 cid 时不得误报「在比赛中」──');
  {
    resetLog();
    const state = new StateManager(makeContext());
    await state.syncContestContext();
    check('无 cid → oj.inContest', lastInContest(), false);
  }

  // ─────────────────────────────────────────────
  console.log('\n── 4. 单一真相：inContest 只允许从 state.ts 一处发出 ──');
  {
    const offenders = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { walk(p); continue; }
        if (!name.endsWith('.ts')) { continue; }
        const src = fs.readFileSync(p, 'utf8');
        // 手写 setContext('oj.inContest', ...) 只允许出现在 state.ts
        if (/'oj\.inContest'/.test(src) && path.basename(p) !== 'state.ts') {
          offenders.push(path.relative(root, p).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(root, 'src'));
    check('视图/命令层不再手写 oj.inContest', offenders, []);
  }

  // ─────────────────────────────────────────────
  console.log('\n── 5. 启动必须同步：activate 里恢复 cid 与离线开关 ──');
  {
    const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    ok('activate 调用 syncContestContext()', /await state\.syncContestContext\(\)/.test(ext));
    ok('activate 调用 syncOfflineContext()', /await syncOfflineContext\(\)/.test(ext));
    ok('syncOfflineContext 不是死代码（启动 + 配置变更 ≥2 处调用）',
      (ext.match(/(await |void )syncOfflineContext\(\)/g) || []).length >= 2);
  }

  // ─────────────────────────────────────────────
  console.log('\n── 6. 登出即离开比赛：不残留 cid ──');
  {
    const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const start = ext.indexOf("registerCommand('oj.logout'");
    const next = ext.indexOf('registerCommand(', start + 1);
    const logoutBlock = ext.slice(start, next > start ? next : start + 1500);
    ok('oj.logout 清掉了 cid', /setCurrentCid\(undefined\)/.test(logoutBlock));
  }

  process.exit(done() ? 0 : 1);
}

main();
