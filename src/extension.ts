import * as vscode from 'vscode';
import * as path from 'path';
import { apiClient } from './api/client';
import { AuthService } from './api/auth';
import { ContestService } from './api/contest';
import { ProblemService } from './api/problem';
import { SubmitService } from './api/submit';
import { StateManager } from './utils/state';
import { getBaseUrl } from './utils/config';
import { ContestTreeProvider } from './views/contestTree';
import { ProblemTreeProvider } from './views/problemTree';
import { StatusPanel } from './views/statusPanel';
import { LoginWebview } from './webview/loginWebview';
import { AccountWebview } from './webview/accountWebview';
import { SubmitWebview } from './webview/submitWebview';
import { ProblemWebview } from './webview/problemWebview';
import { LANGUAGE_EXT } from './types';
import { initDebugChannel, showDebugChannel, clearDebugChannel, setDebugEnabled, isDebugEnabled, logInfo } from './utils/debug';

/** 插件激活入口 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[OJ] 插件激活中...');

  // 初始化层
  const state = new StateManager(context);
  const auth = new AuthService(state);
  const contestService = new ContestService(auth);
  const problemService = new ProblemService();
  const submitService = new SubmitService(auth);

  // 更新 baseUrl 监听
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('oj.baseUrl')) {
        apiClient.updateBaseUrl(getBaseUrl());
        console.log('[OJ] BaseURL 已更新:', getBaseUrl());
      }
    })
  );

  // 初始化 baseUrl
  apiClient.updateBaseUrl(getBaseUrl());

  // 初始化 Debug 频道
  initDebugChannel();
  logInfo(`OJ 插件启动 — BaseURL: ${getBaseUrl()}`);

  // 视图 Providers
  const contestTreeProvider = new ContestTreeProvider(contestService, state);
  const problemTreeProvider = new ProblemTreeProvider(contestService, state);

  // 注册 TreeView
  const contestTree = vscode.window.createTreeView('oj.contests', {
    treeDataProvider: contestTreeProvider,
    showCollapseAll: false,
  });

  const problemTree = vscode.window.createTreeView('oj.problems', {
    treeDataProvider: problemTreeProvider,
    showCollapseAll: false,
  });

  // Webview 实例
  let loginWebview: LoginWebview | undefined;
  const problemWebview = new ProblemWebview(problemService, state);
  const statusPanel = new StatusPanel(submitService, state);

  // 登录成功回调
  const onLoginSuccess = async (): Promise<void> => {
    await vscode.commands.executeCommand('setContext', 'oj.loggedIn', true);
    contestTreeProvider.refresh();
    vscode.window.showInformationMessage('[OJ] 登录成功');
  };

  // ==========================================
  // 注册命令
  // ==========================================

  // oj.login
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.login', async () => {
      loginWebview = new LoginWebview(auth, state, onLoginSuccess);
      await loginWebview.show();
      loginWebview.updateHtml();
    })
  );

  // oj.openSettings — 直达 OJ 设置
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:thebestskinhead.vsoj');
    })
  );

  // oj.accountSettings — 账号密码设置
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.accountSettings', async () => {
      const accountView = new AccountWebview(state);
      await accountView.show();
    })
  );

  // oj.logout
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.logout', async () => {
      try {
        await auth.logout();
        contestTreeProvider.refresh();
        problemTreeProvider.refresh();
        await vscode.commands.executeCommand('setContext', 'oj.inContest', false);
        vscode.window.showInformationMessage('[OJ] 已登出');
      } catch (e: any) {
        vscode.window.showErrorMessage(`登出失败: ${e.message}`);
      }
    })
  );

  // oj.refreshContests
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.refreshContests', () => {
      contestTreeProvider.clearSearch();
    })
  );

  // oj.searchContests — 搜索比赛
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.searchContests', async () => {
      const keyword = await vscode.window.showInputBox({
        prompt: '输入关键词搜索比赛',
        placeHolder: '比赛名称关键字（留空则显示全部）',
        value: contestTreeProvider.getSearchKeyword(),
      });
      if (keyword === undefined) { return; } // 用户取消
      await contestTreeProvider.search(keyword);
      if (keyword) {
        vscode.window.showInformationMessage(`[OJ] 搜索比赛: "${keyword}"`);
      } else {
        vscode.window.showInformationMessage('[OJ] 已显示全部比赛');
      }
    })
  );

  // oj.enterContest
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.enterContest', async (cid: string) => {
      try {
        await state.setCurrentCid(cid);
        await vscode.commands.executeCommand('setContext', 'oj.inContest', true);
        problemTreeProvider.refresh();
        vscode.window.showInformationMessage(`[OJ] 已进入比赛 ${cid}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`进入比赛失败: ${e.message}`);
      }
    })
  );

  // oj.enterContestWithPid — 进入比赛并指定 PID
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.enterContestWithPid', async () => {
      try {
        // 输入 CID
        const cid = await vscode.window.showInputBox({
          prompt: '请输入比赛 ID（CID）',
          placeHolder: '例如: 1000',
          validateInput: (value: string) => {
            if (!value || !/^\d+$/.test(value)) {
              return '请输入有效的数字 CID';
            }
            return null;
          },
        });
        if (!cid) { return; }

        // 输入 PID
        const pid = await vscode.window.showInputBox({
          prompt: `请输入题目 ID（PID），比赛: ${cid}`,
          placeHolder: '例如: 0',
          validateInput: (value: string) => {
            if (!value || !/^\d+$/.test(value)) {
              return '请输入有效的数字 PID';
            }
            return null;
          },
        });
        if (!pid) { return; }

        // 进入比赛
        await state.setCurrentCid(cid);
        await state.setCurrentPid(pid);
        await vscode.commands.executeCommand('setContext', 'oj.inContest', true);
        problemTreeProvider.refresh();
        vscode.window.showInformationMessage(`[OJ] 已进入比赛 ${cid}，定位题目 ${pid}`);

        // 打开题目详情
        await problemWebview.show(cid, pid);
      } catch (e: any) {
        vscode.window.showErrorMessage(`操作失败: ${e.message}`);
      }
    })
  );

  // oj.exitContest
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.exitContest', async () => {
      await state.setCurrentCid(undefined);
      await state.setCurrentPid(undefined);
      await vscode.commands.executeCommand('setContext', 'oj.inContest', false);
      problemTreeProvider.refresh();
      statusPanel.dispose();
      vscode.window.showInformationMessage('[OJ] 已退出比赛');
    })
  );

  // oj.showProblem
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.showProblem', async (cid: string, pid: string) => {
      try {
        const actualCid = cid || state.getCurrentCid();
        if (!actualCid) {
          vscode.window.showErrorMessage('请先进入比赛');
          return;
        }
        await problemWebview.show(actualCid, pid);
      } catch (e: any) {
        vscode.window.showErrorMessage(`加载题目失败: ${e.message}`);
      }
    })
  );

  // oj.submit
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.submit', async () => {
      try {
        const cid = state.getCurrentCid();
        const pid = state.getCurrentPid();

        if (!cid || !pid) {
          vscode.window.showErrorMessage('请先进入比赛并选择题目');
          return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage('没有打开的编辑器');
          return;
        }

        const source = editor.document.getText();
        if (!source.trim()) {
          vscode.window.showErrorMessage('代码为空');
          return;
        }

        const ext = path.extname(editor.document.fileName).toLowerCase();
        const defaultLang = LANGUAGE_EXT[ext] ?? 1;

        // pid 数字转字母（0→A, 1→B, ...）
        const pidLetter = numToLetter(parseInt(pid, 10));
        const onSubmitSuccess = () => {
          // 提交成功后延迟启动刷新——只显示该题，结果出来后自动停
          setTimeout(() => {
            statusPanel.startSubmitAutoRefresh(pidLetter);
          }, 4000);
        };

        const submitWebview = new SubmitWebview(
          auth,
          submitService,
          state,
          cid,
          pid,
          source,
          defaultLang,
          onSubmitSuccess,
        );
        await submitWebview.show();
        submitWebview.updateHtml();
      } catch (e: any) {
        vscode.window.showErrorMessage(`提交失败: ${e.message}`);
      }
    })
  );

  // oj.refreshStatus
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.refreshStatus', async () => {
      try {
        const cid = state.getCurrentCid();
        if (!cid) {
          vscode.window.showErrorMessage('请先进入比赛');
          return;
        }
        await statusPanel.show();
      } catch (e: any) {
        vscode.window.showErrorMessage(`加载状态失败: ${e.message}`);
      }
    })
  );

  // oj.toggleStatusAutoRefresh — 切换状态自动刷新
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.toggleStatusAutoRefresh', () => {
      statusPanel.toggleAutoRefresh();
    })
  );

  // oj.toggleFavorite (右键菜单触发)
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.toggleFavorite', async (item: { contest?: { cid: string } }) => {
      try {
        const cid = item?.contest?.cid;
        if (!cid) { return; }
        const isFav = await state.toggleFavorite(cid);
        vscode.window.showInformationMessage(`[OJ] ${isFav ? '已收藏' : '已取消收藏'} ${cid}`);
        contestTreeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`操作失败: ${e.message}`);
      }
    })
  );

  // oj.favoriteContest — 手动输入 CID 收藏
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.favoriteContest', async () => {
      try {
        const cid = await vscode.window.showInputBox({
          prompt: '请输入要收藏的比赛 ID（CID）',
          placeHolder: '例如: 1000',
          validateInput: (value: string) => {
            if (!value || !/^\d+$/.test(value)) {
              return '请输入有效的数字 CID';
            }
            return null;
          },
        });
        if (!cid) { return; }

        if (state.isFavorite(cid)) {
          await state.removeFavorite(cid);
          vscode.window.showInformationMessage(`[OJ] 已取消收藏比赛 ${cid}`);
        } else {
          await state.addFavorite(cid);
          vscode.window.showInformationMessage(`[OJ] 已收藏比赛 ${cid}`);
        }
        contestTreeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`操作失败: ${e.message}`);
      }
    })
  );

  // oj.refreshProblems
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.refreshProblems', () => {
      problemTreeProvider.refresh();
    })
  );

  // oj.debugShow — 显示 Debug 频道
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.debugShow', () => {
      showDebugChannel();
    })
  );

  // oj.debugToggle — 启用/禁用 Debug
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.debugToggle', () => {
      const newState = !isDebugEnabled();
      setDebugEnabled(newState);
      vscode.window.showInformationMessage(
        `[OJ] Debug ${newState ? '已启用' : '已禁用'}`,
      );
    })
  );

  // oj.debugClear — 清空 Debug 日志
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.debugClear', () => {
      clearDebugChannel();
      logInfo('日志已清空');
    })
  );

  // ==========================================
  // 启动时恢复登录态
  // ==========================================
  async function restoreSession(): Promise<void> {
    try {
      const cookieString = await state.getSessionCookie();
      if (cookieString) {
        const baseUrl = getBaseUrl();
        const domain = baseUrl.replace(/https?:\/\//, '').split(':')[0];
        await apiClient.restoreCookies(cookieString, domain);
        // 恢复后先锁定，避免并发请求返回新的 PHPSESSID 覆写当前会话
        apiClient.lockCookies();
        console.log('[OJ] Cookie 已恢复');

        const loggedIn = await auth.isLoggedIn();
        if (loggedIn) {
          await vscode.commands.executeCommand('setContext', 'oj.loggedIn', true);
          console.log('[OJ] 登录态有效，免密登录成功');
        } else {
          // 失效会话：解锁并清空，保证后续登录能拿到新会话
          apiClient.unlockCookies();
          apiClient.clearCookies();
          console.log('[OJ] 登录态已过期，需要重新登录');
          await state.clearSessionCookie();
        }
      } else {
        console.log('[OJ] 无已保存的会话，需要登录');
      }
    } catch (e: any) {
      console.error('[OJ] 会话恢复失败:', e);
    }
  }

  await restoreSession();
  // 恢复完成后才允许 TreeView 加载数据，避免启动竞态
  contestTreeProvider.setReady();

  // 注册所有 disposable
  context.subscriptions.push(
    contestTree,
    problemTree,
    { dispose: () => problemWebview.dispose() },
    { dispose: () => statusPanel.dispose() },
  );

  console.log('[OJ] 插件激活完成');
}

/** 数字 PID → 字母编号 */
function numToLetter(n: number): string {
  if (n < 0) { return '?'; }
  let s = '', num = n;
  do { s = String.fromCharCode(65 + (num % 26)) + s; num = Math.floor(num / 26) - 1; } while (num >= 0);
  return s;
}

/** 插件停用 */
export function deactivate(): void {
  console.log('[OJ] 插件已停用');
}
