// 打开源码到左栏（workspace/openSource.ts）— 纯依赖注入，无需 vscode 运行时
// 运行：node test/open-source.test.js
const { makeChecker } = require('./helpers/stub');
const { openSourceInLeftColumn } = require('../out/workspace/openSource.js');

const { check, done } = makeChecker();

function makeDeps(opts = {}) {
  const shown = [];
  return {
    shown,
    deps: {
      visibleFilePaths: () => opts.visible || [],
      openAndReveal: async (f) => { shown.push(f); },
    },
  };
}

(async () => {
  const FILE = 'C:/ws/3772-示例/problems/A-复杂度分析/main.cpp';

  console.log('[1] 文件不存在 → 不打开');
  {
    const env = makeDeps();
    const r = await openSourceInLeftColumn(FILE, false, env.deps);
    check('结果', r, 'missing');
    check('未打开任何文件', env.shown, []);
  }

  console.log('\n[2] 路径拿不到（比赛目录未建立）→ 不打开');
  {
    const env = makeDeps();
    const r = await openSourceInLeftColumn(undefined, true, env.deps);
    check('结果', r, 'missing');
    check('未打开任何文件', env.shown, []);
  }

  console.log('\n[3] 文件已可见 → 复用，什么都不做（D9）');
  {
    const env = makeDeps({ visible: ['C:/other/x.cpp', FILE] });
    const r = await openSourceInLeftColumn(FILE, true, env.deps);
    check('结果', r, 'reused');
    check('未重复打开', env.shown, []);
  }

  console.log('\n[4] 文件存在但未打开 → 打开');
  {
    const env = makeDeps({ visible: ['C:/other/x.cpp'] });
    const r = await openSourceInLeftColumn(FILE, true, env.deps);
    check('结果', r, 'opened');
    check('打开的是该题源文件', env.shown, [FILE]);
  }

  console.log('\n[5] 路径比较按精确匹配（不被前缀目录误判为已打开）');
  {
    const env = makeDeps({ visible: ['C:/ws/3772-示例/problems/A-复杂度分析/main.cpp.bak'] });
    const r = await openSourceInLeftColumn(FILE, true, env.deps);
    check('结果', r, 'opened');
  }

  console.log('\n[6] 可见列表为空 → 打开');
  {
    const env = makeDeps({ visible: [] });
    const r = await openSourceInLeftColumn(FILE, true, env.deps);
    check('结果', r, 'opened');
    check('打开次数', env.shown.length, 1);
  }

  process.exit(done() ? 0 : 1);
})();
