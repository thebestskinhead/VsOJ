import * as vscode from 'vscode';
import { ContestService } from '../api/contest';
import { StateManager } from '../utils/state';
import { Contest, Pagination } from '../types';
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
  private currentPage: number = 1; // 当前页码（非搜索模式使用，无需持久化）
  private pagination: Pagination | null = null;

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
    this.currentPage = 1; // 搜索时重置页码
    this.refresh();
  }

  /** 清除搜索 */
  clearSearch(): void {
    this.searchKeyword = '';
    this.currentPage = 1; // 清除搜索时重置页码
    this.refresh();
  }

  /** 上一页 */
  prevPage(): void {
    if (this.isLoading) { return; } // 互斥锁：上一个请求未完成时忽略
    if (this.currentPage > 1) {
      this.currentPage--;
      this.refresh();
    }
  }

  /** 下一页 */
  nextPage(): void {
    if (this.isLoading) { return; } // 互斥锁：上一个请求未完成时忽略
    if (this.pagination && this.currentPage < this.pagination.total) {
      this.currentPage++;
      this.refresh();
    }
  }

  /** 跳转到指定页 */
  jumpToPage(page: number): void {
    if (this.isLoading) { return; } // 互斥锁：上一个请求未完成时忽略
    if (page >= 1) {
      this.currentPage = page;
      this.refresh();
    }
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
      const { rows, pagination } = await this.contestService.fetchList(this.currentPage, this.searchKeyword || undefined);
      this.contests = rows;
      this.pagination = pagination;
      // 用服务器返回的实际页码同步（防止请求超出范围时不一致）
      if (pagination && pagination.current) {
        this.currentPage = pagination.current;
      }

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

      // 搜索模式 — 顶部添加"返回首页"，然后显示搜索结果
      if (headerLabel) {
        const homeItem = new ContestTreeItem(
          '← 返回首页',
          'nav-home',
          vscode.TreeItemCollapsibleState.None,
        );
        homeItem.command = { command: 'oj.refreshContests', title: '返回首页' };
        items.push(homeItem);
        items.push(new ContestTreeItem(headerLabel, 'search-header', vscode.TreeItemCollapsibleState.None));
      } else {
        // 非搜索模式 — 首页显示当前页码
        const totalPages = this.pagination ? this.pagination.total : 1;
        items.push(new ContestTreeItem(
          `第 ${this.currentPage} 页，共 ${totalPages} 页`,
          'page-info',
          vscode.TreeItemCollapsibleState.None,
        ));
      }

      // 比赛列表
      items.push(...this.contests.map(c => new ContestTreeItem(
        `${c.isFavorite ? '★ ' : ''}${c.title}`,
        'contest',
        vscode.TreeItemCollapsibleState.None,
        c,
      )));

      // 非搜索模式 — 底部显示翻页导航
      if (!this.searchKeyword) {
        // 上一页
        const hasPrev = this.currentPage > 1;
        const prevItem = new ContestTreeItem(
          hasPrev ? '← 上一页' : '← 已是第一页',
          hasPrev ? 'nav-prev' : 'nav-prev-disabled',
          vscode.TreeItemCollapsibleState.None,
        );
        if (hasPrev) {
          prevItem.command = { command: 'oj.prevContestPage', title: '上一页' };
        }
        items.push(prevItem);

        // 下一页
        const hasNext = this.pagination && this.currentPage < this.pagination.total;
        const nextItem = new ContestTreeItem(
          hasNext ? '下一页 →' : '→ 已是最后一页',
          hasNext ? 'nav-next' : 'nav-next-disabled',
          vscode.TreeItemCollapsibleState.None,
        );
        if (hasNext) {
          nextItem.command = { command: 'oj.nextContestPage', title: '下一页' };
        }
        items.push(nextItem);

        // 跳转到指定页
        const jumpItem = new ContestTreeItem(
          '跳转到指定页...',
          'nav-jump',
          vscode.TreeItemCollapsibleState.None,
        );
        jumpItem.command = { command: 'oj.jumpContestPage', title: '跳转页码' };
        items.push(jumpItem);
      }

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
        arguments: ['@ext:thebestskinhead.vsoj-pro'],
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
    } else if (itemType === 'page-info') {
      this.iconPath = new vscode.ThemeIcon('list-flat');
      this.contextValue = '';
    } else if (itemType === 'nav-home') {
      this.iconPath = new vscode.ThemeIcon('home');
      this.contextValue = '';
    } else if (itemType === 'nav-prev') {
      this.iconPath = new vscode.ThemeIcon('arrow-left');
      this.contextValue = '';
    } else if (itemType === 'nav-prev-disabled') {
      this.iconPath = new vscode.ThemeIcon('circle-slash');
      this.contextValue = '';
    } else if (itemType === 'nav-next') {
      this.iconPath = new vscode.ThemeIcon('arrow-right');
      this.contextValue = '';
    } else if (itemType === 'nav-next-disabled') {
      this.iconPath = new vscode.ThemeIcon('circle-slash');
      this.contextValue = '';
    } else if (itemType === 'nav-jump') {
      this.iconPath = new vscode.ThemeIcon('go-to-file');
      this.contextValue = '';
    }
  }
}
