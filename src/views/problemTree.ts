import * as vscode from 'vscode';
import { ContestService, AccessError } from '../api/contest';
import { OfflineNoCacheError } from '../cache/store';
import { LoginRequiredError } from '../session/access';
import { StateManager } from '../utils/state';
import { ProblemBrief, ProblemStatus } from '../types';
import {
  isOfflineMode, isProjectEnabled, isInitEntryVisible, isLazyInitEnabled,
} from '../utils/config';
import { InitEntryDismissals, decideInitEntry, makeFacts, NO_FOLDER_TEXT } from '../workspace/guard';

/** 题目列表 TreeDataProvider — 复用 workspace.js 题目列表逻辑 */

/**
 * 「初始化项目」条目所需的运行时依赖。
 *
 * 之所以不直接把 `CacheStore` 塞进来：条目要不要出现是一个**决策**，
 * 决策逻辑统一在 `workspace/guard.ts` 里（已单测穷举），这里只负责把事实喂进去。
 */
export interface ProjectEntryDeps {
  /** 是否打开了 `file:` 工作区文件夹 */
  hasFolder: () => boolean;
  /** 该比赛是否已初始化（比赛目录与 `meta.json` 存在） */
  isContestInitialized: (cid: string) => Promise<boolean>;
  /** 本次会话的「暂不」记录（D19） */
  dismissals: InitEntryDismissals;
}

export class ProblemTreeProvider implements vscode.TreeDataProvider<ProblemTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProblemTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private contestService: ContestService;
  private state: StateManager;
  private project?: ProjectEntryDeps;
  private problems: ProblemBrief[] = [];
  private contestTitle: string = '';
  private isLoading: boolean = false;
  /** 下一次加载是否绕过缓存（「刷新题目列表」按钮用） */
  private forceNext: boolean = false;

  constructor(contestService: ContestService, state: StateManager, project?: ProjectEntryDeps) {
    this.contestService = contestService;
    this.state = state;
    this.project = project;
  }

  /**
   * 刷新列表。
   * @param force 忽略缓存强制联网
   */
  refresh(force: boolean = false): void {
    if (force) { this.forceNext = true; }
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: ProblemTreeItem): Promise<ProblemTreeItem[]> {
    if (element) { return []; }

    const cid = this.state.getCurrentCid();
    if (!cid) {
      return [new ProblemTreeItem('未进入比赛', 'no-contest', vscode.TreeItemCollapsibleState.None)];
    }

    const hasFolder = this.project ? this.project.hasFolder() : true;
    // 占位项只取决于「有没有文件夹」，与列表加载无关（§5.2：说明能力边界）
    const placeholder = this.project && !hasFolder ? [ProblemTreeItem.openFolderPlaceholder()] : [];

    // 先取列表再算条目：条目的「N 道题」要用到列表长度。
    // 列表失败也不影响条目出现（C7）—— 失败被 loadBody 收敛成一个 error 项。
    const body = this.isLoading
      ? [new ProblemTreeItem('加载中...', 'loading', vscode.TreeItemCollapsibleState.None)]
      : await this.loadBody(cid);

    // 未登录就只剩这一条：题目列表、初始化入口都不该出现 ——
    // 列表里连题目名字都不该露出来
    if (body.length === 1 && body[0].itemType === 'login-required') {
      return body;
    }

    const entry = await this.buildInitEntry(cid, hasFolder);
    return [...placeholder, ...entry, ...body];
  }

  /** 加载题目列表，把一切失败收敛成可展示的条目（不向外抛） */
  private async loadBody(cid: string): Promise<ProblemTreeItem[]> {
    try {
      this.isLoading = true;
      const force = this.forceNext;
      this.forceNext = false;
      const result = await this.contestService.fetchProblemList(cid, { force });
      this.problems = result.problems;
      this.contestTitle = result.title;

      if (this.problems.length === 0) {
        const msg = isOfflineMode() ? '离线模式 · 无本地缓存的题目列表' : '暂无题目';
        return [new ProblemTreeItem(msg, 'empty', vscode.TreeItemCollapsibleState.None)];
      }

      return this.problems.map(p => new ProblemTreeItem(
        `#${p.pid} ${p.title}`,
        'problem',
        vscode.TreeItemCollapsibleState.None,
        p,
      ));
    } catch (e: any) {
      // 未登录：题目列表在闸门处就被拒了，这里只给登录提示
      if (e instanceof LoginRequiredError) {
        return [ProblemTreeItem.loginRequired()];
      }
      if (e instanceof AccessError) {
        await this.state.setCurrentCid(undefined);
        await this.state.setCurrentPid(undefined);
        vscode.commands.executeCommand('oj.refreshContests');
        vscode.window.showErrorMessage(`[OJ] ${e.message}`);
        return [new ProblemTreeItem(e.message, 'error', vscode.TreeItemCollapsibleState.None)];
      }
      // 离线且无缓存：说清是「拿不到」而不是「这个比赛没题」
      if (e instanceof OfflineNoCacheError) {
        return [new ProblemTreeItem('离线模式 · 无本地缓存的题目列表', 'empty', vscode.TreeItemCollapsibleState.None)];
      }
      console.error('[OJ] 题目列表加载失败:', e);
      const hint = isOfflineMode() ? '（离线模式）' : '';
      return [new ProblemTreeItem(`加载失败${hint}: ${e.message}`, 'error', vscode.TreeItemCollapsibleState.None)];
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * 「初始化项目」条目。
   *
   * 出现条件完全交给 `guard.decideInitEntry`（见 `test/workspace-guard.test.js` 的穷举），
   * 这里只负责把事实读出来，避免在视图层再写一遍规则。
   */
  private async buildInitEntry(cid: string, hasFolder: boolean): Promise<ProblemTreeItem[]> {
    if (!this.project) { return []; }
    const contestInitialized = await this.project.isContestInitialized(cid).catch(() => false);
    const decision = decideInitEntry(makeFacts({
      hasFolder,
      projectEnabled: isProjectEnabled(),
      lazyInit: isLazyInitEnabled(),
      initEntryVisible: isInitEntryVisible(),
      initEntryDismissed: this.project.dismissals.isDismissed(cid),
      contestInitialized,
    }));
    if (!decision.visible) { return []; }
    return [ProblemTreeItem.initEntry(cid, this.problems.length, hasFolder)];
  }

  getTreeItem(element: ProblemTreeItem): vscode.TreeItem {
    return element;
  }

  getContestTitle(): string {
    return this.contestTitle;
  }
}

/** 三种状态的图标和文字 */
const STATUS_INFO: Record<ProblemStatus, { icon: string; color: string; text: string }> = {
  accepted: { icon: 'check', color: 'charts.green', text: '✓ AC' },
  wrong:   { icon: 'error', color: 'charts.red',   text: '✗ WA' },
  pending: { icon: 'circle-large-outline', color: 'foreground', text: '' },
};

export class ProblemTreeItem extends vscode.TreeItem {
  public problem?: ProblemBrief;
  /** 「初始化项目」条目挂着的 cid（命令参数用） */
  public cid?: string;

  constructor(
    label: string,
    public itemType: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    problem?: ProblemBrief,
  ) {
    super(label, collapsibleState);
    this.problem = problem;

    if (problem) {
      const info = STATUS_INFO[problem.status];
      this.tooltip = `${problem.title}\n通过: ${problem.acceptedCount} | 提交: ${problem.submissionCount}`;
      this.description = info.text;
      this.iconPath = new vscode.ThemeIcon(info.icon, new vscode.ThemeColor(info.color));

      this.command = {
        command: 'oj.showProblem',
        title: '查看题目',
        arguments: [problem.cid || this.getCidFromContext(), problem.pid],
      };
      this.contextValue = 'problem';
    } else if (itemType === 'loading') {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
      this.contextValue = '';
    } else if (itemType === 'no-contest') {
      this.iconPath = new vscode.ThemeIcon('info');
      this.contextValue = '';
    } else if (itemType === 'empty') {
      this.iconPath = new vscode.ThemeIcon('info');
      this.contextValue = '';
    } else if (itemType === 'error') {
      this.iconPath = new vscode.ThemeIcon('error');
      this.contextValue = '';
    }
  }

  /**
   * 无文件夹时的占位项（§5.2）。
   *
   * 整条可点 → 直接触发「打开文件夹」，把「为什么用不了」和「怎么解决」
   * 合并在同一个可交互元素里，而不是只在界面上丢一句说明。
   */
  static openFolderPlaceholder(): ProblemTreeItem {
    const item = new ProblemTreeItem(
      NO_FOLDER_TEXT.treePlaceholder,
      'no-folder',
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon('folder-opened', new vscode.ThemeColor('charts.orange'));
    item.tooltip = NO_FOLDER_TEXT.treePlaceholderTooltip;
    item.contextValue = 'ojNoFolder';
    item.command = {
      command: 'oj.project.openFolder',
      title: '打开文件夹',
      arguments: [],
    };
    return item;
  }

  /**
   * 未登录时的**唯一**条目。
   *
   * 整条可点 → 打开登录页。这里不放题目列表的「残影」：站点对公开比赛是免登录
   * 渲染的，本机不把内容端出去才是唯一的闸门，而题目名字本身也算内容。
   */
  static loginRequired(): ProblemTreeItem {
    const item = new ProblemTreeItem(
      '未登录 · 点击登录后查看题目',
      'login-required',
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon('account');
    item.tooltip = '未登录时不提供比赛列表与题面。登录成功后会回到你刚才打开的比赛。';
    item.contextValue = '';
    item.command = { command: 'oj.login', title: '登录' };
    return item;
  }

  /**
   * 「初始化项目」条目（D2）—— 形态对齐 Git 面板的「初始化仓库」：
   * 整条可点 = 初始化；右侧另有两个行内动作（初始化 / 暂不），
   * 由 `package.json` 的 `view/item/context` 以 `viewItem == ojInitEntry` 挂上。
   */
  static initEntry(cid: string, problemCount: number, hasFolder: boolean): ProblemTreeItem {
    const item = new ProblemTreeItem(
      '初始化比赛项目',
      'init-entry',
      vscode.TreeItemCollapsibleState.None,
    );
    item.cid = cid;
    item.iconPath = new vscode.ThemeIcon('cloud-download');
    item.description = hasFolder && problemCount > 0 ? `${problemCount} 道题` : '';
    item.tooltip = hasFolder
      ? `把该比赛的题面、样例与 main.cpp 写入 <工作区>/${cid}-<标题>/（可取消）`
      : NO_FOLDER_TEXT.treePlaceholderTooltip;
    item.contextValue = 'ojInitEntry';
    item.command = {
      command: 'oj.project.initialize',
      title: '初始化项目',
      arguments: [cid],
    };
    return item;
  }

  private getCidFromContext(): string {
    return '';
  }
}
