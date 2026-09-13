// 工作区守卫（workspace/guard.ts）— 纯决策层，无需 vscode 运行时
// 运行：node test/workspace-guard.test.js
const { makeChecker } = require('./helpers/stub');
const G = require('../out/workspace/guard.js');

const { check, ok, done } = makeChecker();
const { makeFacts } = G;

(async () => {
  // ---------- 1. 无工作区 ----------
  console.log('[1] 无文件夹 —— 只能看题（C1 / D15）');
  {
    const f = makeFacts({ hasFolder: false });
    const d = G.decideOpenProblem(f);
    check('弹提醒', d.promptOpenFolder, true);
    check('只读渲染', d.readOnly, true);
    check('不写盘', d.lazyInit, false);
    check('不分栏', d.split, false);
    check('原因', d.reason, 'no-folder');
  }
  {
    const f = makeFacts({ hasFolder: false });
    const d = G.decideSubmit(f);
    check('提交被拒（C2）', d.allowed, false);
    check('拒绝原因', d.reason, 'no-folder');
    ok('提示里指明「打开文件夹」', d.message.includes('打开文件夹'));
    check('不触发落盘', d.ensureProblemFirst, false);
  }
  {
    const d = G.decideInitEntry(makeFacts({ hasFolder: false }));
    check('不显示初始化条目', d.visible, false);
    check('原因', d.reason, 'no-folder');
  }
  {
    ok('提醒文案标题', G.NO_FOLDER_TEXT.message.includes('打开') && G.NO_FOLDER_TEXT.message.includes('文件夹'));
    ok('提醒按钮文案', G.NO_FOLDER_TEXT.openFolderAction === '打开文件夹');
    ok('提醒正文说明后果', G.NO_FOLDER_TEXT.detail.includes('无法提交'));
    ok('占位项文案说明原因', G.NO_FOLDER_TEXT.treePlaceholder.includes('未打开文件夹'));
    ok('占位项有悬浮说明', G.NO_FOLDER_TEXT.treePlaceholderTooltip.length > 0);
  }

  // ---------- 2. 项目功能被关闭 ----------
  console.log('\n[2] 有文件夹但项目功能关闭 —— 退化为纯网页客户端');
  {
    const f = makeFacts({ hasFolder: true, projectEnabled: false });
    const d = G.decideOpenProblem(f);
    check('只读', d.readOnly, true);
    check('不写盘', d.lazyInit, false);
    check('不分栏', d.split, false);
    check('不弹「打开文件夹」', d.promptOpenFolder, false);
    check('原因', d.reason, 'project-disabled');

    const s = G.decideSubmit(f);
    check('提交仍放行（不因关闭项目而阻断）', s.allowed, true);
    check('不强制落盘', s.ensureProblemFirst, false);

    check('不显示初始化条目', G.decideInitEntry(f).visible, false);
    check('原因', G.decideInitEntry(f).reason, 'project-disabled');
  }

  // ---------- 3. 懒初始化开 → 落盘 + 分栏 ----------
  console.log('\n[3] 有文件夹 + 未初始化 + 懒初始化开 → 懒初始化后分栏（C3）');
  {
    const f = makeFacts({ hasFolder: true, contestInitialized: false, problemOnDisk: false, lazyInit: true });
    const d = G.decideOpenProblem(f);
    check('写盘', d.lazyInit, true);
    check('分栏', d.split, true);
    check('非只读', d.readOnly, false);
    check('不弹确认框式提醒', d.promptOpenFolder, false);
    check('原因', d.reason, 'needs-lazy-init');
  }

  // ---------- 4. 懒初始化关 → 只读 ----------
  console.log('\n[4] 懒初始化关 + 未初始化 → 只读（C4）');
  {
    const f = makeFacts({ hasFolder: true, lazyInit: false, contestInitialized: false, problemOnDisk: false });
    const d = G.decideOpenProblem(f);
    check('不写盘', d.lazyInit, false);
    check('不分栏', d.split, false);
    check('只读', d.readOnly, true);
    check('原因', d.reason, 'lazy-init-off');
  }

  // ---------- 5. 已在磁盘 → 不重复写盘（C6） ----------
  console.log('\n[5] 该题已落地 → 直接分栏、绝不重写（C6）');
  {
    const f = makeFacts({ hasFolder: true, problemOnDisk: true, contestInitialized: true, lazyInit: true });
    const d = G.decideOpenProblem(f);
    check('不写盘', d.lazyInit, false);
    check('分栏', d.split, true);
    check('原因', d.reason, 'already-on-disk');
  }
  {
    // 即使懒初始化关掉，已落地的题也应该能分栏（磁盘上确实有文件）
    const f = makeFacts({ hasFolder: true, lazyInit: false, problemOnDisk: true, contestInitialized: true });
    const d = G.decideOpenProblem(f);
    check('懒初始化关也照样分栏', d.split, true);
    check('原因', d.reason, 'already-on-disk');
  }
  {
    // 项目功能关闭时，即使文件在磁盘上也不碰（用户要的是纯客户端）
    const f = makeFacts({ hasFolder: true, projectEnabled: false, problemOnDisk: true });
    check('项目关闭 → 仍只读', G.decideOpenProblem(f).readOnly, true);
  }

  // ---------- 6. 提交闸门 ----------
  console.log('\n[6] 提交闸门（C2 / D11）');
  {
    const f = makeFacts({ hasFolder: true, projectEnabled: true, problemOnDisk: true });
    const s = G.decideSubmit(f);
    check('放行', s.allowed, true);
    check('无需先落盘', s.ensureProblemFirst, false);
    check('无拒绝原因', s.reason, undefined);
  }
  {
    const f = makeFacts({ hasFolder: true, projectEnabled: true, problemOnDisk: false });
    const s = G.decideSubmit(f);
    check('放行', s.allowed, true);
    ok('但要求先把该题落盘（否则会提交到别的文件）', s.ensureProblemFirst);
  }

  // ---------- 7. 「初始化项目」条目可见性（C7） ----------
  console.log('\n[7] 初始化条目可见性（C7）');
  {
    const base = { hasFolder: true, projectEnabled: true, initEntryVisible: true, contestInitialized: false, initEntryDismissed: false };
    check('正常出现', G.decideInitEntry(makeFacts(base)).visible, true);
    check('已初始化 → 隐藏', G.decideInitEntry(makeFacts({ ...base, contestInitialized: true })).visible, false);
    check('已初始化原因', G.decideInitEntry(makeFacts({ ...base, contestInitialized: true })).reason, 'already-initialized');
    check('配置关闭 → 隐藏', G.decideInitEntry(makeFacts({ ...base, initEntryVisible: false })).visible, false);
    check('配置关闭原因', G.decideInitEntry(makeFacts({ ...base, initEntryVisible: false })).reason, 'entry-disabled');
    check('本次会话已「暂不」→ 隐藏', G.decideInitEntry(makeFacts({ ...base, initEntryDismissed: true })).visible, false);
    check('暂不原因', G.decideInitEntry(makeFacts({ ...base, initEntryDismissed: true })).reason, 'dismissed-this-session');
  }

  // ---------- 8. 「暂不」只作用于本次会话（D19） ----------
  console.log('\n[8] 暂不的语义（D19：本次会话隐藏 / 重进比赛再现）');
  {
    const d = new G.InitEntryDismissals();
    check('初始未暂不', d.isDismissed('3772'), false);

    d.onEnterContest('3772');
    d.dismiss('3772');
    check('点暂不后隐藏', d.isDismissed('3772'), true);

    d.onEnterContest('3772');
    check('重新进入比赛 → 条目再现', d.isDismissed('3772'), false);

    d.dismiss('3772');
    check('再次暂不', d.isDismissed('3772'), true);
    d.onEnterContest('3775');
    check('进入别的比赛不影响本比赛', d.isDismissed('3772'), true);

    d.clear();
    check('clear 后重置', d.isDismissed('3772'), false);
  }

  // ---------- 9. makeFacts 默认取最保守值 ----------
  console.log('\n[9] makeFacts 缺省值');
  {
    const f = makeFacts();
    check('默认无文件夹', f.hasFolder, false);
    check('默认项目开启', f.projectEnabled, true);
    check('默认懒初始化开', f.lazyInit, true);
    check('默认条目允许', f.initEntryVisible, true);
    check('默认未暂不', f.initEntryDismissed, false);
    check('默认未初始化', f.contestInitialized, false);
    check('默认题未落地', f.problemOnDisk, false);
    check('默认即只读看题', G.decideOpenProblem(f).readOnly, true);
  }

  // ---------- 10. 穷举：无文件夹时能力恒定 ----------
  console.log('\n[10] 穷举 —— 无文件夹时无论其它事实如何，行为恒定');
  {
    let violations = 0;
    for (const projectEnabled of [true, false]) {
      for (const lazyInit of [true, false]) {
        for (const problemOnDisk of [true, false]) {
          for (const contestInitialized of [true, false]) {
            const d = G.decideOpenProblem(makeFacts({
              hasFolder: false, projectEnabled, lazyInit, problemOnDisk, contestInitialized,
            }));
            if (d.split || d.lazyInit || !d.readOnly || !d.promptOpenFolder) { violations++; }
          }
        }
      }
    }
    check('16 种组合全部只读且不写盘（违反数）', violations, 0);

    let submitViolations = 0;
    for (const projectEnabled of [true, false]) {
      for (const problemOnDisk of [true, false]) {
        const s = G.decideSubmit(makeFacts({ hasFolder: false, projectEnabled, problemOnDisk }));
        if (s.allowed || s.ensureProblemFirst) { submitViolations++; }
      }
    }
    check('无文件夹时提交一律被拒（违反数）', submitViolations, 0);
  }

  process.exit(done() ? 0 : 1);
})();
