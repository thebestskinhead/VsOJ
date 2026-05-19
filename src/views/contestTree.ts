import * as vscode from 'vscode';
import { ContestService } from '../api/contest';
import { StateManager } from '../utils/state';
import { Contest } from '../types';
import { getBaseUrl } from '../utils/config';

/** 比赛列表 TreeDataProvider — 复用 home.js 比赛显示逻辑 */

export class ContestTreeProvider implements vscode.TreeDataProvider<ContestTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ContestTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private contestService: ContestService;
  private state: StateManager;
  private contests: Contest[] = [];
  private isLoading: boolean = false;
  private searchKeyword: string = '';
  private ready: boolean = false; // restoreSession 完成后才允许加载

  constructor(contestService: ContestService, state: StateManager) {
    this.contestService = contestService;
    this.state = state;
  }

  /** 标记就绪（restoreSession 完成后调用） */
  setReady(): void {
    this.ready = true;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 搜索比赛 */
  async search(keyword: string): Promise<void> {
    this.searchKeyword = keyword;
    this.refresh();
  }

  /** 清除搜索 */
  clearSearch(): void {
    this.searchKeyword = '';
    this.refresh();
  }

  async getChildren(element?: ContestTreeItem): Promise<ContestTreeItem[]> {
    if (element) {
      return [];
    }

    if (!this.ready) {
      return [new ContestTreeItem('正在初始化...', 'loading', vscode.TreeItemCollapsibleState.None)];
    }

    if (this.isLoading) {
      return [new ContestTreeItem('加载中...', 'loading', vscode.TreeItemCollapsibleState.None)];
    }

    if (getBaseUrl() === 'http://localhost') {
      return [new ContestTreeItem('请先设置 OJ 平台地址，然后重启VSCode', 'config-hint', vscode.TreeItemCollapsibleState.None)];
    }

    if (!this.state.isLoggedIn()) {
      return [new ContestTreeItem('请先登录 OJ 系统', 'login-hint', vscode.TreeItemCollapsibleState.None)];
    }

    try {
      this.isLoading = true;
      const { rows } = await this.contestService.fetchList(1, this.searchKeyword || undefined);
      this.contests = rows;

      const favorites = this.state.getFavorites();
      const favSet = new Set(favorites);

      // 标记收藏
      this.contests.forEach(c => { c.isFavorite = favSet.has(c.cid); });

      // 排序：收藏置顶
      this.contests.sort((a, b) => {
        if (a.isFavorite && !b.isFavorite) { return -1; }
        if (!a.isFavorite && b.isFavorite) { return 1; }
        return 0;
      });

      if (this.contests.length === 0) {
        const msg = this.searchKeyword
          ? `未找到匹配"${this.searchKeyword}"的比赛`
          : '暂无比赛数据';
        return [new ContestTreeItem(msg, 'empty', vscode.TreeItemCollapsibleState.None)];
      }

      const headerLabel = this.searchKeyword
        ? `搜索: "${this.searchKeyword}"（${this.contests.length} 个结果）`
        : undefined;

      const items: ContestTreeItem[] = [];

      // 搜索时显示结果数量
      if (headerLabel) {
        items.push(new ContestTreeItem(headerLabel, 'search-header', vscode.TreeItemCollapsibleState.None));
      }

      items.push(...this.contests.map(c => new ContestTreeItem(
        `${c.isFavorite ? '★ ' : ''}${c.title}`,
        'contest',
        vscode.TreeItemCollapsibleState.None,
        c,
      )));

      return items;
    } catch (e: any) {
      console.error('[OJ] 比赛列表加载失败:', e);
      return [new ContestTreeItem(`加载失败: ${e.message}`, 'error', vscode.TreeItemCollapsibleState.None)];
    } finally {
      this.isLoading = false;
    }
  }

  getTreeItem(element: ContestTreeItem): vscode.TreeItem {
    return element;
  }

  getSearchKeyword(): string {
    return this.searchKeyword;
  }
}

export class ContestTreeItem extends vscode.TreeItem {
  public contest?: Contest;

  constructor(
    label: string,
    public itemType: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    contest?: Contest,
  ) {
    super(label, collapsibleState);
    this.contest = contest;

    if (contest) {
      this.tooltip = `${contest.title}\n状态: ${contest.status}\n创建者: ${contest.creator}`;
      this.description = `CID: ${contest.cid} | ${contest.status}`;
      this.iconPath = contest.isFavorite
        ? new vscode.ThemeIcon('star-full')
        : new vscode.ThemeIcon('symbol-event');
      this.command = {
        command: 'oj.enterContest',
        title: '进入比赛',
        arguments: [contest.cid],
      };
      this.contextValue = 'contest';
    } else if (itemType === 'loading') {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
      this.contextValue = '';
    } else if (itemType === 'login-hint') {
      this.iconPath = new vscode.ThemeIcon('warning');
      this.command = { command: 'oj.login', title: '登录' };
      this.contextValue = '';
    } else if (itemType === 'config-hint') {
      this.iconPath = new vscode.ThemeIcon('warning');
      this.command = {
        command: 'workbench.action.openSettings',
        title: '打开设置',
        arguments: ['@ext:thebestskinhead.vsoj'],
      };
      this.contextValue = '';
    } else if (itemType === 'empty') {
      this.iconPath = new vscode.ThemeIcon('info');
      this.contextValue = '';
    } else if (itemType === 'error') {
      this.iconPath = new vscode.ThemeIcon('error');
      this.contextValue = '';
    } else if (itemType === 'search-header') {
      this.iconPath = new vscode.ThemeIcon('search');
      this.contextValue = '';
      this.description = '';
    }
  }
}
