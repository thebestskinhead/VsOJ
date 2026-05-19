import * as vscode from 'vscode';
import { ProblemService } from '../api/problem';
import { ProblemDetail } from '../types';
import { StateManager } from '../utils/state';

/** 题目详情 Webview — Panel 渲染 HTML，复用 workspace.js loadProblem 逻辑 */

export class ProblemWebview {
  private panel: vscode.WebviewPanel | undefined;
  private problemService: ProblemService;
  private state: StateManager;

  constructor(problemService: ProblemService, state: StateManager) {
    this.problemService = problemService;
    this.state = state;
  }

  async show(cid: string, pid: string): Promise<void> {
    // 保存当前上下文
    await this.state.setCurrentPid(pid);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'ojProblemDetail',
        '题目详情',
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    // 显示加载状态
    this.panel.webview.html = this.getLoadingHtml();

    try {
      const detail = await this.problemService.fetchProblem(cid, pid);

      // 处理图片内联
      const processedDescription = await this.problemService.inlineImages(detail.description);
      const processedInputDesc = await this.problemService.inlineImages(detail.inputDesc);
      const processedOutputDesc = await this.problemService.inlineImages(detail.outputDesc);

      const processedDetail: ProblemDetail = {
        ...detail,
        description: processedDescription,
        inputDesc: processedInputDesc,
        outputDesc: processedOutputDesc,
      };

      this.panel.title = detail.title || `题目 ${pid}`;
      this.panel.webview.html = this.problemService.buildProblemHtml(processedDetail);
    } catch (e: any) {
      console.error('[OJ] 题目详情加载失败:', e);
      this.panel.webview.html = this.getErrorHtml(e.message);
    }
  }

  private getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #888; background: #fff; }
  .spinner { border: 3px solid #e0e0e0; border-top: 3px solid #4CAF50; border-radius: 50%; width: 32px; height: 32px; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body><div style="text-align:center;"><div class="spinner"></div><p>正在加载题目详情...</p></div></body></html>`;
  }

  private getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #c62828; background: #fff; }
</style></head>
<body><div style="text-align:center;"><h3>加载失败</h3><p>${this.escapeHtml(message)}</p></div></body></html>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
