/**
 * 【工作区 · 守卫】
 *
 * 回答一个前置问题：**当前环境允许做什么？**
 *
 * 引入原因（见 `docs/PLAN_S5.md` §5.2）：初始化产物全部落在
 * `<工作区根>/<cid>-<标题>/` 里，所以「有没有打开文件夹」会直接改变插件的能力边界 ——
 * 没有工作区时既无缓存根、也无处写 `main.cpp`，分栏与一键测试都失去地基。
 *
 * 本模块是**纯决策层**：只吃事实、只吐结论，不读 vscode、不碰磁盘。
 * 这样「无文件夹时到底能干什么」可以被单测穷举，而不是散落在各命令的 if 里。
 * 真正的副作用（弹提醒、打开文件夹、写盘）由调用方按结论执行。
 *
 * 能力边界（D15，用户确认的矩阵）：
 *
 * | 能力 | 无文件夹 | 有文件夹 |
 * |---|---|---|
 * | 查看题目（只读题面） | ✅ | ✅ |
 * | 使用本地缓存 | ❌（无缓存根，直连站点） | ✅ |
 * | 懒初始化 / 全量初始化（写盘） | ❌ | ✅ |
 * | 左代码右题目分栏 | ❌（磁盘上没有可打开的源文件） | ✅ |
 * | 提交代码 | ❌（明确提示并阻止） | ✅ |
 * | 显示「初始化项目」条目 | ❌（显示占位项说明原因） | 视初始化状态而定 |
 */

/** 决策所需的事实。全部由调用方从 vscode / 磁盘 / 配置读出后传入 */
export interface WorkspaceFacts {
  /** 是否打开了 `file:` 工作区文件夹（等价于 `CachePaths.inWorkspace`） */
  hasFolder: boolean;
  /** `oj.project.enabled` —— 关掉后本项目所有写盘行为都不发生 */
  projectEnabled: boolean;
  /** `oj.project.lazyInit` —— 点题是否自动落盘（D14，默认开） */
  lazyInit: boolean;
  /** `oj.project.initEntryVisible` —— 「初始化项目」条目是否允许出现 */
  initEntryVisible: boolean;
  /** 本次会话中用户是否对该比赛点过「暂不」（D19） */
  initEntryDismissed: boolean;
  /** 该比赛是否已初始化（比赛目录存在且 `meta.json` 可读） */
  contestInitialized: boolean;
  /** 该题是否已在磁盘上落地（`main.cpp` 存在） */
  problemOnDisk: boolean;
}

/** 打开一道题时应当采取的动作集合 */
export interface OpenProblemDecision {
  /** 弹「请先打开文件夹」提醒（带「打开文件夹」按钮） */
  promptOpenFolder: boolean;
  /** 执行懒初始化（写盘：题面 / 样例 / 图片 / main.cpp / temp / test） */
  lazyInit: boolean;
  /** 打开 `main.cpp` 到左栏并把题目面板开到右栏 */
  split: boolean;
  /**
   * 题面渲染走「无缓存」路径 —— **只有没有工作区时才是 true**。
   *
   * 无工作区时缓存根会退化到 `globalStorage`，那是跨窗口共享的兜底目录，
   * 既不该读也不该写（D15）。而「懒初始化关闭」只是不写项目目录，
   * 题面照样可以走 `.vsoj/` 缓存 —— 两者不是一回事，因此拆成独立字段。
   */
  noCache: boolean;
  /** 结论原因，用于日志与文案选择 */
  reason: OpenProblemReason;
}

export type OpenProblemReason =
  /** 没有打开文件夹（C1） */
  | 'no-folder'
  /** 项目功能被配置关闭 */
  | 'project-disabled'
  /** 该题已在磁盘上，直接用（C6） */
  | 'already-on-disk'
  /** 需要懒初始化后再分栏（C3） */
  | 'needs-lazy-init'
  /** 懒初始化被关掉且该题未落地 → 只读（C4） */
  | 'lazy-init-off';

/** 提交闸门结论（C2） */
export interface SubmitDecision {
  allowed: boolean;
  /** 被拒原因（当前只有一种：没有打开文件夹） */
  reason?: 'no-folder';
  /** 与用户沟通的文案（含「打开文件夹」指引） */
  message?: string;
}

/** 「初始化项目」条目的可见性结论（C7） */
export interface InitEntryDecision {
  visible: boolean;
  /** `visible=false` 时的原因，便于侧边栏决定是隐藏还是显示占位项 */
  reason?: 'no-folder' | 'project-disabled' | 'already-initialized'
    | 'entry-disabled' | 'dismissed-this-session';
}

/** 无工作区时的统一文案（提醒 / 占位项 / 提交阻断共用同一套措辞，避免口径漂移） */
export const NO_FOLDER_TEXT = {
  /** 提醒标题 */
  message: '[OJ] 请先打开一个文件夹',
  /** 提醒正文：说清「为什么」与「不打开会怎样」 */
  detail:
    '题目初始化会把题面、样例与 main.cpp 写入你打开的文件夹。'
    + '未打开文件夹时可以查看题目，但无法保存代码、无法分栏、也无法提交。',
  /** 提醒按钮（点击调用 `vscode.openFolder`） */
  openFolderAction: '打开文件夹',
  /** 提交被拦截时的提示 */
  submitBlocked:
    '[OJ] 需要先打开一个文件夹才能提交。\n'
    + '代码需要落成文件（main.cpp）后才可提交，请先打开文件夹并初始化题目。',
  /** 题目列表里的占位项 */
  treePlaceholder: '未打开文件夹 — 点击此处打开（无法保存 / 提交代码）',
  /** 占位项的悬浮说明 */
  treePlaceholderTooltip:
    '打开一个文件夹后即可初始化比赛项目：题面、样例与 main.cpp 会写入该文件夹。',
} as const;

/** 由事实推导「打开一道题」的动作 */
export function decideOpenProblem(f: WorkspaceFacts): OpenProblemDecision {
  if (!f.hasFolder) {
    // C1：只读看题 + 提醒，不写盘、不开分栏、不用缓存
    return { promptOpenFolder: true, lazyInit: false, split: false, noCache: true, reason: 'no-folder' };
  }
  if (!f.projectEnabled) {
    // 项目功能关闭 → 退化为纯网页客户端（题面仍可走 .vsoj 缓存）
    return { promptOpenFolder: false, lazyInit: false, split: false, noCache: false, reason: 'project-disabled' };
  }
  if (f.problemOnDisk) {
    // C6：已经在磁盘上就不再写盘，直接分栏
    return { promptOpenFolder: false, lazyInit: false, split: true, noCache: false, reason: 'already-on-disk' };
  }
  if (f.lazyInit) {
    // C3：懒初始化该题后立即分栏，不弹确认框
    return { promptOpenFolder: false, lazyInit: true, split: true, noCache: false, reason: 'needs-lazy-init' };
  }
  // C4：懒初始化关掉且该题未落地 → 不分栏，等用户显式初始化整个比赛
  return { promptOpenFolder: false, lazyInit: false, split: false, noCache: false, reason: 'lazy-init-off' };
}

/**
 * 由事实推导提交闸门结论（C2）。
 *
 * **刻意只拦一种情况**：没有工作区。契约 C13 明确要求「提交行为不变 —— 提交
 * `activeTextEditor` 的内容」，所以这里不额外校验「编辑器里的是不是 main.cpp」之类，
 * 否则就是借着守卫之名改了既有行为。
 */
export function decideSubmit(f: WorkspaceFacts): SubmitDecision {
  if (!f.hasFolder) {
    return {
      allowed: false,
      reason: 'no-folder',
      message: NO_FOLDER_TEXT.submitBlocked,
    };
  }
  return { allowed: true };
}

/** 由事实推导「初始化项目」条目是否出现（C7） */
export function decideInitEntry(f: WorkspaceFacts): InitEntryDecision {
  if (!f.hasFolder) { return { visible: false, reason: 'no-folder' }; }
  if (!f.projectEnabled) { return { visible: false, reason: 'project-disabled' }; }
  if (!f.initEntryVisible) { return { visible: false, reason: 'entry-disabled' }; }
  if (f.contestInitialized) { return { visible: false, reason: 'already-initialized' }; }
  if (f.initEntryDismissed) { return { visible: false, reason: 'dismissed-this-session' }; }
  return { visible: true };
}

/**
 * 「暂不」只管本次会话（D19）。
 *
 * 存在内存里而不是 `globalState`：语义就是「这次先别烦我」，
 * 下次启动 VS Code 或重新进入比赛自然重来一次，不需要持久化。
 */
export class InitEntryDismissals {
  private readonly dismissed = new Set<string>();

  /** 用户点「暂不」 */
  public dismiss(cid: string): void {
    this.dismissed.add(cid);
  }

  /**
   * 标记「进入比赛」。
   *
   * D19 要求：下次启动或**重新进入比赛**时条目再出现一次 ——
   * 所以每次进入比赛都清掉该比赛的「暂不」记录，视为一次全新的查看会话。
   * 注意只清当前 cid：进别的比赛不该影响本比赛的隐藏状态。
   */
  public onEnterContest(cid: string): void {
    this.dismissed.delete(cid);
  }

  public isDismissed(cid: string): boolean {
    return this.dismissed.has(cid);
  }

  /** 供测试与「恢复默认」使用 */
  public clear(): void {
    this.dismissed.clear();
  }
}

/** 便捷构造：从零散输入拼一份事实（缺省按「最保守」取值） */
export function makeFacts(partial: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
  return {
    hasFolder: false,
    projectEnabled: true,
    lazyInit: true,
    initEntryVisible: true,
    initEntryDismissed: false,
    contestInitialized: false,
    problemOnDisk: false,
    ...partial,
  };
}
