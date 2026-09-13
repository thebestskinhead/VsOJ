// 题目树头部条目（views/problemTree.ts）—— 无文件夹占位项 + 「初始化项目」条目
// 运行：node test/project-tree.test.js
//
// 覆盖 C1（无文件夹只读看题）、C7（条目出现条件）、C8（暂不本次会话隐藏）
const { installVscodeStub, makeChecker } = require('./helpers/stub');

const env = installVscodeStub();

const { ProblemTreeProvider, ProblemTreeItem } = require('../out/views/problemTree.js');
const { InitEntryDismissals } = require('../out/workspace/guard.js');

const { check, ok, done } = makeChecker();

const PROBLEMS = [
  { pid: '0', title: '复杂度分析(Ⅰ)', cid: '3772', status: 'accepted', acceptedCount: '3', submissionCount: '5' },
  { pid: '1', title: 'Josephus问题(Ⅱ)', cid: '3772', status: 'pending' },
];

function makeEnv(opts = {}) {
  const state = {
    getCurrentCid: () => (opts.cid === null ? undefined : (opts.cid ?? '3772')),
    getCurrentPid: () => undefined,
    setCurrentCid: async () => {},
    setCurrentPid: async () => {},
  };
  const contestService = {
    fetchProblemList: async () => {
      if (opts.listFails) { throw new Error('题目列表拉取失败'); }
      return { problems: opts.problems ?? PROBLEMS, title: '示例比赛' };
    },
  };
  const project = {
    hasFolder: () => !!opts.hasFolder,
    isContestInitialized: async () => !!opts.initialized,
    dismissals: opts.dismissals ?? new InitEntryDismissals(),
  };
  return new ProblemTreeProvider(contestService, state, project);
}

const types = items => items.map(i => i.itemType);
const findType = (items, t) => items.find(i => i.itemType === t);

(async () => {
  // ---------- 1. 未进入比赛 ----------
  console.log('[1] 未进入比赛');
  {
    const p = makeEnv({ cid: null });
    const items = await p.getChildren();
    check('只给一个提示项', items.length, 1);
    check('类型', items[0].itemType, 'no-contest');
  }

  // ---------- 2. 无文件夹（C1） ----------
  console.log('\n[2] 无文件夹 —— 占位项在首位，题目仍可查看（C1）');
  {
    const p = makeEnv({ hasFolder: false, initialized: false });
    const items = await p.getChildren();
    check('首位是占位项', items[0].itemType, 'no-folder');
    ok('占位项可点（点击打开文件夹）', items[0].command && items[0].command.command === 'oj.project.openFolder');
    check('占位项 contextValue', items[0].contextValue, 'ojNoFolder');
    ok('占位项说明原因', String(items[0].label).includes('未打开文件夹'));
    check('题目照常列出（只读看题）', items.filter(i => i.itemType === 'problem').length, 2);
    ok('无文件夹时不出「初始化项目」条目（C7）', !findType(items, 'init-entry'));
    check('完整类型序列', types(items).join(','), 'no-folder,problem,problem');
  }

  // ---------- 3. 有文件夹但未初始化（C7） ----------
  console.log('\n[3] 有文件夹 + 未初始化 → 出现「初始化项目」条目');
  {
    const p = makeEnv({ hasFolder: true, initialized: false });
    const items = await p.getChildren();
    const entry = findType(items, 'init-entry');
    ok('条目存在', !!entry);
    check('条目在题目之前（便于发现）', types(items).join(','), 'init-entry,problem,problem');
    check('条目 contextValue', entry.contextValue, 'ojInitEntry');
    check('点击即初始化该比赛', entry.command.command, 'oj.project.initialize');
    check('命令参数为 cid', entry.command.arguments, ['3772']);
    ok('条目说明题量', String(entry.description).includes('2'));
    ok('无占位项', !findType(items, 'no-folder'));
  }

  // ---------- 4. 已初始化 → 条目消失 ----------
  console.log('\n[4] 已初始化 → 条目消失');
  {
    const p = makeEnv({ hasFolder: true, initialized: true });
    const items = await p.getChildren();
    ok('无初始化条目', !findType(items, 'init-entry'));
    ok('题目仍在', items.some(i => i.itemType === 'problem'));
  }

  // ---------- 5. 「暂不」→ 本次会话隐藏（C8） ----------
  console.log('\n[5] 暂不 → 本次会话隐藏（C8）');
  {
    const dismissals = new InitEntryDismissals();
    const p = makeEnv({ hasFolder: true, initialized: false, dismissals });
    ok('初始可见', !!findType(await p.getChildren(), 'init-entry'));

    dismissals.dismiss('3772');
    ok('暂不后隐藏', !findType(await p.getChildren(), 'init-entry'));

    // 重新进入比赛 → 条目再现
    dismissals.onEnterContest('3772');
    ok('重新进入比赛后恢复', !!findType(await p.getChildren(), 'init-entry'));
  }

  // ---------- 6. 配置彻底关闭条目 ----------
  console.log('\n[6] oj.project.initEntryVisible = false → 彻底不出现');
  {
    const p = makeEnv({ hasFolder: true, initialized: false });
    const original = env.vscode.workspace.getConfiguration;
    env.vscode.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'project.initEntryVisible' ? false : d) });
    try {
      ok('条目被配置关闭', !findType(await p.getChildren(), 'init-entry'));
    } finally {
      env.vscode.workspace.getConfiguration = original;
    }
  }

  // ---------- 7. 列表加载失败时条目仍在（C7 的健壮性要求） ----------
  console.log('\n[7] 题目列表加载失败 → 条目仍必须出现');
  {
    const p = makeEnv({ hasFolder: true, initialized: false, listFails: true });
    const items = await p.getChildren();
    ok('条目仍在', !!findType(items, 'init-entry'));
    ok('错误项也在', !!findType(items, 'error'));
  }

  // ---------- 8. 题目条目本身未受影响 ----------
  console.log('\n[8] 题目条目');
  {
    const p = makeEnv({ hasFolder: true, initialized: true });
    const item = findType(await p.getChildren(), 'problem');
    check('类型', item.itemType, 'problem');
    check('点击查看题目', item.command.command, 'oj.showProblem');
    check('命令参数', item.command.arguments, ['3772', '0']);
    check('contextValue', item.contextValue, 'problem');
  }

  // ---------- 9. 空列表 ----------
  console.log('\n[9] 空题目列表');
  {
    const p = makeEnv({ hasFolder: true, initialized: false, problems: [] });
    const items = await p.getChildren();
    ok('有「暂无题目」项', !!findType(items, 'empty'));
    ok('条目仍在', !!findType(items, 'init-entry'));
  }

  // ---------- 10. 工厂方法 ----------
  console.log('\n[10] ProblemTreeItem 工厂');
  {
    const ph = ProblemTreeItem.openFolderPlaceholder();
    check('占位项类型', ph.itemType, 'no-folder');
    check('占位项可点', ph.command.command, 'oj.project.openFolder');

    const e = ProblemTreeItem.initEntry('3775', 21, true);
    check('条目类型', e.itemType, 'init-entry');
    check('条目 cid', e.cid, '3775');
    check('条目命令参数', e.command.arguments, ['3775']);
  }

  process.exit(done() ? 0 : 1);
})();
