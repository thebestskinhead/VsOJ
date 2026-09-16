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
    check('不使用本地缓存', d.noCache, true);
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
    check('不写盘', d.lazyInit, false);
    check('不分栏', d.split, false);
    check('不弹「打开文件夹」', d.promptOpenFolder, false);
    check('原因', d.reason, 'project-disabled');
    check('仍可使用 .vsoj 缓存（项目关闭 ≠ 关缓存）', d.noCache, false);

    const s = G.decideSubmit(f);
    check('提交仍放行（不因关闭项目而阻断）', s.allowed, true);

    check('不显示初始化条目', G.decideInitEntry(f).visible, false);
    check('原因', G.decideInitEntry(f).reason, 'project-disabled');
  }

  // ---------- 3. 懒初始化开 → 先问一次，同意后才落盘 + 分栏 ----------
  console.log('\n[3] 有文件夹 + 未初始化 + 懒初始化开 → 先征求同意（D21）');
  {
    const f = makeFacts({ hasFolder: true, contestInitialized: false, problemOnDisk: false, lazyInit: true });
    const d = G.decideOpenProblem(f);
    check('没表态就不写盘', d.lazyInit, false);
    check('没表态就不分栏', d.split, false);
    check('要求先确认', d.confirmInit, true);
    check('原因', d.reason, 'needs-confirm');
    check('不弹「请先打开文件夹」提醒', d.promptOpenFolder, false);
    check('未表态仍可使用 .vsoj 缓存', d.noCache, false);
  }
  {
    // 「同意写盘」的凭据就是**比赛目录已经存在** —— 所以确认与否只差这一个事实
    const f = makeFacts({
      hasFolder: true, contestInitialized: true, problemOnDisk: false,
      lazyInit: true,
    });
    const d = G.decideOpenProblem(f);
    check('目录已存在（= 已同意）→ 写盘', d.lazyInit, true);
    check('目录已存在 → 分栏', d.split, true);
    check('目录已存在 → 不再问', d.confirmInit, false);
    check('原因', d.reason, 'needs-lazy-init');
  }

  // ---------- 4. 懒初始化关 → 只读 ----------
  console.log('\n[4] 懒初始化关 + 未初始化 → 只读（C4）');
  {
    const f = makeFacts({ hasFolder: true, lazyInit: false, contestInitialized: false, problemOnDisk: false });
    const d = G.decideOpenProblem(f);
    check('不写盘', d.lazyInit, false);
    check('不分栏', d.split, false);
    check('仍可使用 .vsoj 缓存（关懒初始化 ≠ 关缓存）', d.noCache, false);
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
    check('项目关闭 → 不分栏', G.decideOpenProblem(f).split, false);
  }

  // ---------- 6. 提交闸门（只拦「没有工作区」） ----------
  console.log('\n[6] 提交闸门（C2：只拦没有工作区）');
  {
    const f = makeFacts({ hasFolder: true, projectEnabled: true, problemOnDisk: true });
    const s = G.decideSubmit(f);
    check('放行', s.allowed, true);
    check('无拒绝原因', s.reason, undefined);
  }
  {
    // C13：提交行为不变 —— 题目是否已落地都不影响放行
    const f = makeFacts({ hasFolder: true, projectEnabled: true, problemOnDisk: false });
    check('题目未落盘也照常放行（C13）', G.decideSubmit(f).allowed, true);
  }
  {
    // 项目功能关闭 = 纯网页客户端，同样放行
    const f = makeFacts({ hasFolder: true, projectEnabled: false });
    check('项目关闭也放行', G.decideSubmit(f).allowed, true);
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

  // ---------- 8. 两个回答都只作用于本次会话（D19 / D21） ----------
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
  {
    console.log('  —— 写盘许可以「比赛目录是否存在」为准（D21：不单独存同意状态）');
    ok('不再导出 InitConfirmations（同意状态不额外存一份）', !('InitConfirmations' in G));

    const base = { hasFolder: true, lazyInit: true, problemOnDisk: false, contestInitialized: false };
    const need = G.decideOpenProblem(makeFacts(base));
    check('目录不存在 → 每次都要先同意', need.confirmInit, true);
    check('目录不存在 → 原因', need.reason, 'needs-confirm');

    const allowed = G.decideOpenProblem(makeFacts({ ...base, contestInitialized: true }));
    check('目录已存在 → 视为已同意，不再问', allowed.confirmInit, false);
    check('目录已存在 → 直接懒初始化', allowed.reason, 'needs-lazy-init');

    ok('确认文案：两个按钮',
      !!G.INIT_CONFIRM_TEXT.initAction && !!G.INIT_CONFIRM_TEXT.viewOnlyAction);
    ok('确认文案：不再提供「本次不再问」', !('dismissAction' in G.INIT_CONFIRM_TEXT));
    ok('确认文案：说明会写入什么', G.INIT_CONFIRM_TEXT.detail.includes('写'));
    ok('确认文案：说明不写会怎样', G.INIT_CONFIRM_TEXT.detail.includes('只看题面'));
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
    check('默认未初始化（= 未同意写盘）', f.contestInitialized, false);
    check('默认题未落地', f.problemOnDisk, false);
    check('默认无缓存可用', G.decideOpenProblem(f).noCache, true);
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
            if (d.split || d.lazyInit || d.confirmInit || !d.noCache || !d.promptOpenFolder) { violations++; }
          }
        }
      }
    }
    check('16 种组合全部只读、不写盘、也不问初始化（违反数）', violations, 0);

    let submitViolations = 0;
    for (const projectEnabled of [true, false]) {
      for (const problemOnDisk of [true, false]) {
        const s = G.decideSubmit(makeFacts({ hasFolder: false, projectEnabled, problemOnDisk }));
        if (s.allowed) { submitViolations++; }
      }
    }
    check('无文件夹时提交一律被拒（违反数）', submitViolations, 0);
  }

  process.exit(done() ? 0 : 1);
})();
