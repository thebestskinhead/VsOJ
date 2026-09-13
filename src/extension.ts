import * as vscode from 'vscode';
import * as path from 'path';
import { apiClient } from './api/client';
import { AuthService } from './api/auth';
import { ContestService } from './api/contest';
import { ProblemService } from './api/problem';
import { SubmitService, SubmitOutcome } from './api/submit';
import { StateManager } from './utils/state';
import {
  getBaseUrl, getStatusViewMode, getMcpEnabled, getMcpPort,
  getKeepAliveIntervalMs, getSessionProbeIntervalMs, getAutoRelogin,
  getAutoReplaySubmit, isOfflineMode,
} from './utils/config';
import { ContestTreeProvider } from './views/contestTree';
import { ProblemTreeProvider } from './views/problemTree';
import { StatusPanel } from './views/statusPanel';
import { LoginWebview } from './webview/loginWebview';
import { AccountWebview } from './webview/accountWebview';
import { SubmitWebview } from './webview/submitWebview';
import { ProblemWebview } from './webview/problemWebview';
import { LANGUAGE_EXT } from './types';
import { initDebugChannel, showDebugChannel, clearDebugChannel, setDebugEnabled, isDebugEnabled, logInfo } from './utils/debug';
import { McpServer } from './mcp/server';
import { McpToolHandler } from './mcp/tools';
import { initMcpChannel, showMcpChannel, disposeMcpChannel, clearMcpChannel } from './mcp/logger';
import { initCacheStore } from './cache/store';
import { SessionGuard, needsRelogin, PendingIntent } from './session/guard';
import { SessionKeeper } from './session/keeper';

/** 插件激活入口 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[OJ] 插件激活中...');

  // 初始化层
  const state = new StateManager(context);
  const auth = new AuthService(state);
  const contestService = new ContestService(auth);
  const problemService = new ProblemService();
  const submitService = new SubmitService(auth);

  // 缓存层（S1）— 所有离线能力的数据源
  const cache = initCacheStore(context);

  // 会话层（S2）— 失效识别 + 意图重放
  const sessionGuard = new SessionGuard(context.globalState);

  // 会话状态栏（「更灵活的过期提醒」的常驻可见入口）
  const sessionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  sessionStatusBar.command = 'oj.session.status';
  sessionStatusBar.text = '$(circle-slash) OJ 未登录';
  sessionStatusBar.tooltip = 'OJ 会话状态 — 点击查看详情';
  sessionStatusBar.show();
  context.subscriptions.push(sessionStatusBar);

  // 会话保活（心跳 + 登录态探测）
  // 心跳只发一次 /csrf.php（85B、无副作用），依据 docs/SITE_ANALYSIS.md §6：
  // 任何携带 PHPSESSID 的请求都会刷新服务端会话 mtime，从而避免 Cookie 过期。
  const sessionKeeper = new SessionKeeper(
    {
      beat: async () => {
        await apiClient.get('/csrf.php', { headers: { 'Cache-Control': 'no-cache' } }, 'session.beat');
      },
      probe: async () => auth.isLoggedIn(),
      shouldRun: () => state.isLoggedIn() && !isOfflineMode(),
      onExpired: () => { void handleSessionExpired(); },
      onTick: () => renderSessionStatus(),
      log: (m) => logInfo(m),
    },
    {
      keepAliveIntervalMs: getKeepAliveIntervalMs(),
      probeIntervalMs: getSessionProbeIntervalMs(),
    },
  );
  context.subscriptions.push({ dispose: () => sessionKeeper.dispose() });

  // 配置变更监听
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('oj.baseUrl')) {
        apiClient.updateBaseUrl(getBaseUrl());
        console.log('[OJ] BaseURL 已更新:', getBaseUrl());
      }
      if (e.affectsConfiguration('oj.workspace.root') || e.affectsConfiguration('oj.cache')) {
        cache.rebind();
        logInfo('[OJ] 缓存层已按新配置重新绑定');
      }
      if (e.affectsConfiguration('oj.session')) {
        sessionKeeper.restart({
          keepAliveIntervalMs: getKeepAliveIntervalMs(),
          probeIntervalMs: getSessionProbeIntervalMs(),
        });
        renderSessionStatus();
        logInfo('[OJ] 会话保活已按新配置重启');
      }
    })
  );

  // 初始化 baseUrl
  apiClient.updateBaseUrl(getBaseUrl());

  // 启动时检测是否配置了 OJ 地址
  if (getBaseUrl() === 'http://localhost') {
    vscode.window.showWarningMessage(
      'VsOJ Pro: 请先设置 OJ 平台地址，然后重启 VSCode',
      '打开设置',
    ).then(selection => {
      if (selection === '打开设置') {
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:thebestskinhead.vsoj-pro');
      }
    });
  }

  // 初始化 Debug 频道
  initDebugChannel();
  logInfo(`OJ 插件启动 — BaseURL: ${getBaseUrl()}`);

  // 初始化 MCP 日志频道
  initMcpChannel();

  // ==========================================
  // MCP 服务器
  // ==========================================
  const mcpToolHandler = new McpToolHandler(contestService, problemService, state);

  // 状态栏按钮
  const mcpStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  mcpStatusBar.command = 'oj.mcp.start';
  mcpStatusBar.text = '$(debug-start) MCP 已停止';
  mcpStatusBar.tooltip = 'MCP 服务器未启动 — 点击启动';
  mcpStatusBar.show();
  context.subscriptions.push(mcpStatusBar);

  const mcpServer = new McpServer(
    mcpToolHandler,
    getMcpPort(),
    (running: boolean, port: number) => {
      if (running) {
        mcpStatusBar.text = `$(radio-tower) MCP :${port}`;
        mcpStatusBar.tooltip = `MCP 服务器运行中 → http://127.0.0.1:${port}/mcp — 点击停止`;
        mcpStatusBar.command = 'oj.mcp.stop';
      } else {
        mcpStatusBar.text = '$(debug-start) MCP 已停止';
        mcpStatusBar.tooltip = 'MCP 服务器未启动 — 点击启动';
        mcpStatusBar.command = 'oj.mcp.start';
      }
    },
  );

  // 将 mcpServer 添加到清理列表
  context.subscriptions.push({
    dispose: () => { mcpServer.stop().catch(() => {}); },
  });

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

  // ==========================================
  // 会话自愈编排
  // 说明：以下均为函数声明（提升），便于被早期注册的监听器/命令引用。
  //       业务判定一律委托给 session/guard.ts，此处只做「编排 + 提示」。
  // ==========================================

  /** 刷新会话状态栏 */
  function renderSessionStatus(): void {
    const snap = sessionKeeper.snapshot();
    if (!state.isLoggedIn() || snap.lastProbeOk === false) {
      sessionStatusBar.text = snap.lastProbeOk === false
        ? '$(warning) OJ 登录已过期'
        : '$(circle-slash) OJ 未登录';
      sessionStatusBar.tooltip = snap.lastProbeOk === false
        ? 'OJ 登录已过期 — 点击重新登录'
        : 'OJ 未登录 — 点击查看会话详情';
      sessionStatusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      return;
    }
    const lastBeat = snap.lastBeatAt ? new Date(snap.lastBeatAt).toLocaleTimeString() : '—';
    sessionStatusBar.text = '$(check) OJ 已登录';
    sessionStatusBar.tooltip = `OJ 会话正常 ｜ 最近心跳 ${lastBeat} ｜ 心跳 ${snap.beatCount} 次`;
    sessionStatusBar.color = undefined;
  }

  /** 登录态可用时启动保活 */
  function startKeeperIfNeeded(): void {
    renderSessionStatus();
    if (state.isLoggedIn() && !isOfflineMode()) {
      sessionKeeper.start();
    }
  }

  /** 登录成功统一回调（所有登录入口共用） */
  async function onLoginSuccess(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'oj.loggedIn', true);
    contestTreeProvider.refresh();
    startKeeperIfNeeded();
    vscode.window.showInformationMessage('[OJ] 登录成功');
    await replayPendingIntent();
  }

  /**
   * 打开提交 Webview。
   * `oj.submit` 命令与「登录后重放」共用此函数，避免出现两套提交入口。
   */
  async function openSubmitWebview(params: {
    cid: string;
    pid: string;
    source: string;
    language: number;
    sourceFile?: string;
  }): Promise<void> {
    const { cid, pid, source, language, sourceFile } = params;
    const pidLetter = numToLetter(parseInt(pid, 10));

    const onSubmitSuccess = () => {
      setTimeout(() => {
        const mode = getStatusViewMode();
        if (mode === 'browser') {
          openStatusInBrowser(state);
        } else if (mode === 'webview') {
          statusPanel.startSubmitWebviewRefresh();
        } else {
          statusPanel.startSubmitAutoRefresh(pidLetter);
        }
      }, 4000);
    };

    const onSubmitFailure = (outcome: SubmitOutcome) => {
      if (!needsRelogin(outcome.kind)) { return; }
      // 提交入口是唯一需要「保留意图后重放」的地方：
      // 题目页能进、提交却失败时，登录完成后应回到这里继续。
      void handleSessionExpired({ cid, pid, sourceFile, language });
    };

    const submitWebview = new SubmitWebview(
      auth, submitService, state,
      cid, pid, source, language,
      onSubmitSuccess, onSubmitFailure,
    );
    await submitWebview.show();
    submitWebview.updateHtml();
  }

  /**
   * 登录失效统一处理。
   *
   * @param intent 需要保留并重放的意图；仅由提交失败触发时传入。
   *               心跳/探测发现失效（用户处于空闲）时无意图，只做提醒。
   */
  async function handleSessionExpired(intent?: Omit<PendingIntent, 'kind' | 'createdAt'>): Promise<void> {
    await state.setLoggedIn(false);
    renderSessionStatus();

    if (intent) {
      await sessionGuard.setPending({ kind: 'submit', ...intent });
      logInfo(`[session] 已记录待重放提交意图 cid=${intent.cid} pid=${intent.pid}`);
    }

    if (!getAutoRelogin()) {
      vscode.window.showWarningMessage(
        '[OJ] 登录已过期：题目仍可浏览，但无法提交。请执行「OJ: 登录」后重试。',
      );
      return;
    }

    const message = intent
      ? '[OJ] 登录已过期，本次提交未成功。重新登录后将自动返回原题目并继续提交。'
      : '[OJ] 登录已过期，请重新登录。';
    const hit = await vscode.window.showWarningMessage(message, '重新登录', '稍后处理');
    if (hit !== '重新登录') { return; }

    await openLoginWebview(intent
      ? '登录已过期 — 登录成功后将自动返回原题目并打开提交页。'
      : '登录已过期 — 登录成功后将自动恢复保活与状态刷新。');
  }

  /** 打开登录页；账号已保存时优先快捷登录（只需验证码） */
  async function openLoginWebview(notice?: string): Promise<void> {
    loginWebview = new LoginWebview(auth, state, onLoginSuccess, {
      notice,
      preferQuick: state.hasAccount(),
    });
    await loginWebview.show();
    loginWebview.updateHtml();
  }

  /** 读取重放所需源码：优先取内存中的文档（保留未保存修改），否则读盘 */
  async function readSourceForReplay(sourceFile?: string): Promise<string> {
    if (!sourceFile) { return ''; }
    const open = vscode.workspace.textDocuments.find(d => d.fileName === sourceFile);
    if (open) { return open.getText(); }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFile));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return '';
    }
  }

  /** 重新登录成功后：恢复比赛/题目上下文 → 打开原题目 → 回到提交页 */
  async function replayPendingIntent(force: boolean = false): Promise<void> {
    if (!force && !getAutoReplaySubmit()) { return; }

    const replayed = await sessionGuard.replay(async (intent) => {
      await state.setCurrentCid(intent.cid);
      await state.setCurrentPid(intent.pid);
      await vscode.commands.executeCommand('setContext', 'oj.inContest', true);
      problemTreeProvider.refresh();

      // 自动选择刚才的题目
      await problemWebview.show(intent.cid, intent.pid);

      const source = await readSourceForReplay(intent.sourceFile);
      if (!source.trim()) {
        vscode.window.showWarningMessage(
          `[OJ] 已恢复比赛 ${intent.cid} 题目 ${intent.pid}，但未能读取源码文件，请打开文件后按 Ctrl+Shift+S 重新提交`,
        );
        return;
      }

      const language = intent.language
        ?? LANGUAGE_EXT[path.extname(intent.sourceFile || '').toLowerCase()]
        ?? 1;

      await openSubmitWebview({
        cid: intent.cid,
        pid: intent.pid,
        source,
        language,
        sourceFile: intent.sourceFile,
      });
      vscode.window.showInformationMessage('[OJ] 已回到原题目并打开提交页，请输入验证码继续');
    });

    if (replayed) {
      logInfo('[session] 待重放意图已执行');
    }
  }

  // ==========================================
  // 注册命令
  // ==========================================

  // oj.login
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.login', async () => {
      await openLoginWebview();
    })
  );

  // oj.openSettings — 直达 OJ 设置
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:thebestskinhead.vsoj-pro');
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
        sessionKeeper.stop();
        await sessionGuard.clearPending();
        renderSessionStatus();
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

  // oj.prevContestPage — 翻到上一页
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.prevContestPage', () => {
      contestTreeProvider.prevPage();
    })
  );

  // oj.nextContestPage — 翻到下一页
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.nextContestPage', () => {
      contestTreeProvider.nextPage();
    })
  );

  // oj.jumpContestPage — 跳转到指定页
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.jumpContestPage', async () => {
      const pageStr = await vscode.window.showInputBox({
        prompt: '输入要跳转的页码',
        placeHolder: '输入页码（数字）',
        validateInput: (value: string) => {
          if (!value || !/^\d+$/.test(value)) {
            return '请输入有效的数字页码';
          }
          const page = parseInt(value, 10);
          if (page < 1) {
            return '页码必须大于 0';
          }
          return null;
        },
      });
      if (pageStr === undefined) { return; } // 用户取消
      const page = parseInt(pageStr, 10);
      contestTreeProvider.jumpToPage(page);
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

        await openSubmitWebview({
          cid,
          pid,
          source,
          language: defaultLang,
          sourceFile: editor.document.fileName,
        });
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
        const mode = getStatusViewMode();
        if (mode === 'browser') {
          await openStatusInBrowser(state);
        } else if (mode === 'webview') {
          await statusPanel.showWebview();
        } else {
          await statusPanel.show();
        }
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

  // oj.mcp.start — 启动 MCP 服务器
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.mcp.start', async () => {
      if (mcpServer.running) {
        vscode.window.showInformationMessage(`[OJ-MCP] 服务器已在运行 → http://127.0.0.1:${mcpServer.currentPort}/mcp`);
        return;
      }
      try {
        const port = getMcpPort();
        await mcpServer.start(port);
        vscode.window.showInformationMessage(`[OJ-MCP] MCP 服务器已启动 → http://127.0.0.1:${port}/mcp`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`[OJ-MCP] 启动失败: ${e.message}`);
      }
    })
  );

  // oj.mcp.stop — 停止 MCP 服务器
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.mcp.stop', async () => {
      if (!mcpServer.running) {
        vscode.window.showInformationMessage('[OJ-MCP] 服务器未在运行');
        return;
      }
      try {
        await mcpServer.stop();
        vscode.window.showInformationMessage('[OJ-MCP] MCP 服务器已停止');
      } catch (e: any) {
        vscode.window.showErrorMessage(`[OJ-MCP] 停止失败: ${e.message}`);
      }
    })
  );

  // oj.mcp.showLog — 显示 MCP 日志
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.mcp.showLog', () => {
      showMcpChannel();
    })
  );

  // oj.mcp.clearLog — 清空 MCP 日志
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.mcp.clearLog', () => {
      clearMcpChannel();
      vscode.window.showInformationMessage('[OJ-MCP] 日志已清空');
    })
  );

  // ==========================================
  // 会话相关命令（S2）
  // ==========================================

  // oj.session.status — 会话状态详情
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.session.status', async () => {
      const snap = sessionKeeper.snapshot();
      const pending = await sessionGuard.peekPending();
      const ago = (t?: number) => {
        if (!t) { return '—'; }
        const s = Math.round((Date.now() - t) / 1000);
        return `${new Date(t).toLocaleTimeString()}（${s}s 前）`;
      };
      const detail = [
        `登录态：${state.isLoggedIn() ? '已登录' : '未登录'}`,
        `保活：${snap.running ? '运行中' : '已停止'}，间隔 ${Math.round(getKeepAliveIntervalMs() / 1000)}s，探测间隔 ${Math.round(getSessionProbeIntervalMs() / 1000)}s`,
        `心跳：${ago(snap.lastBeatAt)} ｜ ${snap.lastBeatOk === undefined ? '—' : (snap.lastBeatOk ? '成功' : `失败（连续 ${snap.consecutiveBeatFailures} 次）`)} ｜ 累计 ${snap.beatCount} 次`,
        `探测：${ago(snap.lastProbeAt)} ｜ ${snap.lastProbeOk === undefined ? '—' : (snap.lastProbeOk ? '登录有效' : '登录已失效')}`,
        `待重放：${pending ? `提交 cid=${pending.cid} pid=${pending.pid}（${pending.createdAt}）` : '无'}`,
        snap.lastError ? `最近错误：${snap.lastError}` : '',
      ].filter(Boolean).join('\n');

      const hit = await vscode.window.showInformationMessage(
        'OJ 会话状态',
        { modal: true, detail },
        '立即探测', '复制详情',
      );
      if (hit === '立即探测') {
        const ok = await sessionKeeper.probeNow();
        renderSessionStatus();
        vscode.window.showInformationMessage(`[OJ] 探测结果：${ok ? '登录有效' : '登录已失效'}`);
      } else if (hit === '复制详情') {
        await vscode.env.clipboard.writeText(detail);
        vscode.window.showInformationMessage('[OJ] 会话详情已复制到剪贴板');
      }
    })
  );

  // oj.session.probeNow — 立即探测登录态
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.session.probeNow', async () => {
      if (!state.isLoggedIn()) {
        vscode.window.showWarningMessage('[OJ] 当前未登录');
        return;
      }
      const ok = await sessionKeeper.probeNow();
      renderSessionStatus();
      if (ok) {
        vscode.window.showInformationMessage('[OJ] 登录有效');
      } else {
        vscode.window.showWarningMessage('[OJ] 登录已失效');
      }
    })
  );

  // oj.session.resumePending — 恢复待重放的提交任务
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.session.resumePending', async () => {
      const pending = await sessionGuard.peekPending();
      if (!pending) {
        vscode.window.showInformationMessage('[OJ] 没有待恢复的任务');
        return;
      }
      if (!state.isLoggedIn()) {
        const hit = await vscode.window.showWarningMessage(
          `[OJ] 待恢复任务：比赛 ${pending.cid} 题目 ${pending.pid}。需先登录。`,
          '前往登录', '取消',
        );
        if (hit === '前往登录') {
          await openLoginWebview('登录成功后将自动恢复待提交任务。');
        }
        return;
      }
      await replayPendingIntent(true);
    })
  );

  // oj.session.clearPending — 清除待重放任务
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.session.clearPending', async () => {
      await sessionGuard.clearPending();
      vscode.window.showInformationMessage('[OJ] 已清除待恢复任务');
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
  // 登录态有效则启动保活心跳
  startKeeperIfNeeded();

  // MCP 自动启动（如果设置中启用了）
  if (getMcpEnabled()) {
    try {
      const port = getMcpPort();
      await mcpServer.start(port);
      logInfo(`MCP 服务器已自动启动 → http://127.0.0.1:${port}/mcp`);
    } catch (e: any) {
      console.error('[OJ-MCP] 自动启动失败:', e.message);
    }
  }

  // 注册所有 disposable
  context.subscriptions.push(
    contestTree,
    problemTree,
    { dispose: () => problemWebview.dispose() },
    { dispose: () => statusPanel.dispose() },
    { dispose: () => { disposeMcpChannel(); } },
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

/** 浏览器模式：构建 status 页面 URL 并用外部浏览器打开 */
async function openStatusInBrowser(state: StateManager): Promise<void> {
  const baseUrl = getBaseUrl();
  const cid = state.getCurrentCid() || '';
  const userId = state.getStudentId() || '';
  const pid = state.getCurrentPid();

  const params = new URLSearchParams();
  if (userId) { params.set('user_id', userId); }
  if (cid) { params.set('cid', cid); }
  if (pid) { params.set('problem_id', String.fromCharCode(65 + parseInt(pid, 10))); }

  const query = params.toString();
  const url = query ? `${baseUrl}/status.php?${query}` : `${baseUrl}/status.php`;
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
}

/** 插件停用 */
export function deactivate(): void {
  disposeMcpChannel();
  console.log('[OJ] 插件已停用');
}
