import * as vscode from 'vscode';
import { ContestService, AccessError } from '../api/contest';
import { StateManager } from '../utils/state';
import { ProblemBrief, ProblemStatus } from '../types';

/** 题目列表 TreeDataProvider — 复用 workspace.js 题目列表逻辑 */

export class ProblemTreeProvider implements vscode.TreeDataProvider<ProblemTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProblemTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private contestService: ContestService;
  private state: StateManager;
  private problems: ProblemBrief[] = [];
  private contestTitle: string = '';
  private isLoading: boolean = false;

  constructor(contestService: ContestService, state: StateManager) {
    this.contestService = contestService;
    this.state = state;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: ProblemTreeItem): Promise<ProblemTreeItem[]> {
    if (element) { return []; }

    const cid = this.state.getCurrentCid();
    if (!cid) {
      return [new ProblemTreeItem('未进入比赛', 'no-contest', vscode.TreeItemCollapsibleState.None)];
    }

    if (this.isLoading) {
      return [new ProblemTreeItem('加载中...', 'loading', vscode.TreeItemCollapsibleState.None)];
    }

    try {
      this.isLoading = true;
      const result = await this.contestService.fetchProblemList(cid);
      this.problems = result.problems;
      this.contestTitle = result.title;

      if (this.problems.length === 0) {
        return [new ProblemTreeItem('暂无题目', 'empty', vscode.TreeItemCollapsibleState.None)];
      }

      return this.problems.map(p => {
        const label = `#${p.pid} ${p.title}`;
        const item = new ProblemTreeItem(
          label,
          'problem',
          vscode.TreeItemCollapsibleState.None,
          p,
        );
        return item;
      });
    } catch (e: any) {
      if (e instanceof AccessError) {
        await this.state.setCurrentCid(undefined);
        await this.state.setCurrentPid(undefined);
        await vscode.commands.executeCommand('setContext', 'oj.inContest', false);
        vscode.commands.executeCommand('oj.refreshContests');
        vscode.window.showErrorMessage(`[OJ] ${e.message}`);
        return [new ProblemTreeItem(e.message, 'error', vscode.TreeItemCollapsibleState.None)];
      }
      console.error('[OJ] 题目列表加载失败:', e);
      return [new ProblemTreeItem(`加载失败: ${e.message}`, 'error', vscode.TreeItemCollapsibleState.None)];
    } finally {
      this.isLoading = false;
    }
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

  private getCidFromContext(): string {
    return '';
  }
}
