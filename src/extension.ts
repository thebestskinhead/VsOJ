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
  getAutoReplaySubmit, isOfflineMode, isCacheEnabled, getCacheTtlMs, getStaleTtlMs,
  isProjectEnabled, isLazyInitEnabled, getSourceFileName,
} from './utils/config';
import { ContestTreeProvider } from './views/contestTree';
import { ProblemTreeProvider } from './views/problemTree';
import { StatusPanel } from './views/statusPanel';
import { LoginWebview } from './webview/loginWebview';
import { AccountWebview } from './webview/accountWebview';
import { SubmitWebview } from './webview/submitWebview';
import { ProblemWebview } from './webview/problemWebview';
import { LANGUAGE_EXT, ProblemBrief } from './types';
import { initDebugChannel, showDebugChannel, clearDebugChannel, setDebugEnabled, isDebugEnabled, logInfo } from './utils/debug';
import { McpServer } from './mcp/server';
import { McpToolHandler } from './mcp/tools';
import { initMcpChannel, showMcpChannel, disposeMcpChannel, clearMcpChannel } from './mcp/logger';
import { initCacheStore } from './cache/store';
import { ProblemRefresher } from './cache/refresher';
import { ConnectivityProbe } from './session/connectivity';
import { SessionGuard, needsRelogin, PendingIntent, classifyThrown } from './session/guard';
import { SessionKeeper } from './session/keeper';
import { parseProblemList } from './utils/parser';
import { formatBytes, numToLetter } from './utils/format';
import { ProblemInitializer } from './workspace/initializer';
import { buildInitDeps } from './workspace/wiring';
import { openSourceInLeftColumn as openLeftSource } from './workspace/openSource';
import { buildTestDeps } from './test/wiring';
import { LocalTestRunner, RunnerDeps, TestRunResult } from './test/runner';
import {
  InitEntryDismissals, NO_FOLDER_TEXT, decideOpenProblem, decideSubmit, makeFacts,
} from './workspace/guard';

/** 插件激活入口 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[OJ] 插件激活中...');

  // 初始化层
  const state = new StateManager(context);
  const auth = new AuthService(state);

  // 缓存层（S1）— 所有离线能力的数据源。
  // 必须先于 api 层构造：api 层现在承担「缓存优先 + 原样写穿」的职责。
  const cache = initCacheStore(context);

  const contestService = new ContestService(auth, cache);
  const problemService = new ProblemService();
  const submitService = new SubmitService(auth, cache);

  // 网络可达性（S4.2）— 判定口径：拿到 HTTP 响应即视为可达，
  // 因此这里用 validateStatus 放行所有状态码，只在网络层失败时才抛错。
  const probe = new ConnectivityProbe({
    ping: async () => {
      await apiClient.get('/csrf.php', {
        timeout: 4000,
        headers: { 'Cache-Control': 'no-cache' },
        validateStatus: () => true,
      }, 'cache.ping');
    },
    log: (m) => logInfo(m),
  });

  // providers 在下方创建；配置监听注册得比它们早，因此用可变引用占位
  let contestTreeRef: ContestTreeProvider | undefined;
  let problemTreeRef: ProblemTreeProvider | undefined;

  // ==========================================
  // 会话层（S2）— 失效识别 + 意图重放
  // ==========================================
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

  // ==========================================
  // 比赛项目（S5）—— 本地工作区的写盘侧
  //
  // 「能不能写盘」由 workspace/guard.ts 判定（已单测穷举），这里只做编排：
  // 读事实 → 问守卫 → 按结论执行副作用。所有提示文案取自 guard 的常量，
  // 避免同一条规则在三个地方写出三种措辞。
  // ==========================================
  const initDismissals = new InitEntryDismissals();

  /** 该比赛是否已初始化（比赛目录 + `meta.json` 存在） */
  const isContestInitialized = async (cid: string): Promise<boolean> => {
    try { return !!(await cache.readContestMeta(cid)); } catch { return false; }
  };

  /** 组装某一比赛的初始化器（依赖全部来自真实实现，见 wiring.ts） */
  function buildInitializer(cid: string): ProblemInitializer {
    return new ProblemInitializer(buildInitDeps({
      cid,
      store: cache,
      problems: problemService,
      fetchAsset: (url) => apiClient.getBuffer(url, 'project.asset'),
      toError: (e) => describeThrown(e),
      log: (m) => logInfo(m),
    }));
  }

  /**
   * 是否有可写的工作区。没有就按 D15 提醒（带「打开文件夹」按钮）并返回 false。
   *
   * 提醒而不是干吼：把「为什么不行」与「怎么解决」放在同一个交互里。
   */
  async function ensureFolderForProject(): Promise<boolean> {
    if (vscode.workspace.workspaceFolders?.length) { return true; }
    const pick = await vscode.window.showWarningMessage(
      NO_FOLDER_TEXT.message,
      { detail: NO_FOLDER_TEXT.detail, modal: false },
      NO_FOLDER_TEXT.openFolderAction,
    );
    if (pick === NO_FOLDER_TEXT.openFolderAction) {
      await vscode.commands.executeCommand('vscode.openFolder');
    }
    return false;
  }

  /** 读取当前环境事实（守卫的唯一输入） */
  async function projectFacts(cid: string, pid?: string) {
    const hasFolder = !!vscode.workspace.workspaceFolders?.length;
    let problemOnDisk = false;
    if (hasFolder && pid !== undefined) {
      const paths = await cache.resolveContestDir(cid);
      problemOnDisk = paths ? await cache.exists(paths.mainSource(pid, getSourceFileName())) : false;
    }
    return makeFacts({
      hasFolder,
      projectEnabled: isProjectEnabled(),
      lazyInit: isLazyInitEnabled(),
      initEntryVisible: true,
      initEntryDismissed: initDismissals.isDismissed(cid),
      contestInitialized: hasFolder ? await isContestInitialized(cid) : false,
      problemOnDisk,
    });
  }

  /**
   * 把该题的源文件开到左栏（C5：左代码右题目）。复用判定见 `workspace/openSource.ts`。
   */
  async function openSourceInLeftColumn(cid: string, pid: string): Promise<void> {
    const paths = await cache.resolveContestDir(cid);
    const file = paths?.mainSource(pid, getSourceFileName());
    await openLeftSource(file, !!file && await cache.exists(file), {
      visibleFilePaths: () => vscode.window.visibleTextEditors
        .filter(e => e.document.uri.scheme === 'file')
        .map(e => e.document.uri.fsPath),
      openAndReveal: async (target) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        // preview: false —— 每个题目的源文件都该是「固定标签」，否则点下一题就把它顶掉了
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
          preview: false,
        });
      },
    });
  }

  // 视图 Providers
  const contestTreeProvider = new ContestTreeProvider(contestService, state);
  const problemTreeProvider = new ProblemTreeProvider(contestService, state, {
    hasFolder: () => !!vscode.workspace.workspaceFolders?.length,
    isContestInitialized,
    dismissals: initDismissals,
  });
  contestTreeRef = contestTreeProvider;
  problemTreeRef = problemTreeProvider;

  // 注册 TreeView
  const contestTree = vscode.window.createTreeView('oj.contests', {
    treeDataProvider: contestTreeProvider,
    showCollapseAll: false,
  });

  const problemTree = vscode.window.createTreeView('oj.problems', {
    treeDataProvider: problemTreeProvider,
    showCollapseAll: false,
  });

  // ==========================================
  // 刷新执行器（S4.4 / S4.5）
  //
  // refresher 只做「拉原始 HTML → 落盘」，不做判定、不弹提示，因此可以按不同
  // 作用域重复构造：单题刷新的 cid 来自题目页，全量刷新的 cid 来自当前比赛。
  // ==========================================
  function buildRefresher(cidProvider: () => string): ProblemRefresher {
    return new ProblemRefresher({
      fetchContestHtml: () => contestService.fetchProblemListRawHtml(cidProvider()),
      fetchProblemHtml: (pid) => problemService.fetchProblemHtml(cidProvider(), pid),
      fetchStatusHtml: () => submitService.fetchStatusHtml(state.getStudentId() || '', cidProvider()),
      saveContestHtml: async (html) => {
        const cid = cidProvider();
        const parsed = parseProblemList(html);
        // 比赛标题只存在于比赛页里 → 目录名在此定稿
        await cache.writeContestPageHtml(cid, html, parsed.title);
        await cache.touchContestMeta(cid, { title: parsed.title, problemCount: parsed.problems.length });
      },
      saveProblemHtml: (pid, html) => cache.writeProblemHtml(cidProvider(), pid, html),
      saveStatusHtml: (html) => cache.writeStatusHtml(cidProvider(), html),
      listPids: (html) => parseProblemList(html).problems.map(p => p.pid),
      toError: (e) => describeThrown(e),
      log: (m) => logInfo(m),
    });
  }

  // Webview 实例
  let loginWebview: LoginWebview | undefined;
  /**
   * ProblemWebview 在构造时就需要 refresher，而 refresher 又需要知道「当前题目属于哪场比赛」，
   * 因此用一个**延迟求值**的 provider 打破循环（provider 只在刷新动作真正发生时求值）。
   */
  let problemWebviewRef: ProblemWebview | undefined;
  const resolveProblemCid = (): string =>
    problemWebviewRef?.current.cid || state.getCurrentCid() || '';

  const problemWebview = new ProblemWebview(problemService, state, {
    store: cache,
    probe,
    refresher: buildRefresher(resolveProblemCid),
    fetchAsset: (url) => apiClient.getBuffer(url, 'problem.asset'),
    log: (m) => logInfo(m),
  });
  problemWebviewRef = problemWebview;
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

  // oj.refreshContests — 刷新比赛列表（忽略缓存强制联网）
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.refreshContests', () => {
      contestTreeProvider.clearSearch(true);
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
        // 「暂不」只管本次会话：重新进入比赛时条目再出现一次（D19）
        initDismissals.onEnterContest(cid);
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

        // 打开题目详情（走 showProblem，以便享受懒初始化 + 左代码右题目）
        await vscode.commands.executeCommand('oj.showProblem', cid, pid);
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

  // ==========================================
  // 比赛项目命令（S5.3）
  // ==========================================

  // oj.project.openFolder — 无文件夹占位项 / 提醒按钮的落点
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.project.openFolder', async () => {
      await vscode.commands.executeCommand('vscode.openFolder');
    })
  );

  // oj.project.dismissInitEntry — 「暂不」= 本次会话隐藏（D19）
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.project.dismissInitEntry', async (cid?: string) => {
      const target = cid || state.getCurrentCid();
      if (!target) { return; }
      initDismissals.dismiss(target);
      problemTreeProvider.refresh();
    })
  );

  // oj.project.initializeProblem — 懒初始化单题（S5.4 与 MCP 共用）
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.project.initializeProblem', async (cid: string, pid: string) => {
      const facts = await projectFacts(cid, pid);
      const decision = decideOpenProblem(facts);
      if (decision.promptOpenFolder) {
        await ensureFolderForProject();
        return;
      }
      if (!decision.lazyInit) { return; }

      const r = await buildInitializer(cid).ensureProblem({ pid });
      if (!r.ok) {
        vscode.window.showWarningMessage(`[OJ] 题目 ${pid} 初始化失败：${r.error ?? '未知错误'}`);
        return;
      }
      problemTreeProvider.refresh();
    })
  );

  // oj.project.initialize — 全量初始化（侧边栏「初始化项目」条目）
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.project.initialize', async (cidArg?: string) => {
      const cid = cidArg || state.getCurrentCid();
      if (!cid) {
        vscode.window.showInformationMessage('[OJ] 请先进入一场比赛');
        return;
      }
      if (!(await ensureFolderForProject())) { return; }

      // 题目列表缓存优先（离线且无缓存时给出可读失败，而不是空跑）
      let briefs: ProblemBrief[] = [];
      try {
        briefs = (await contestService.fetchProblemList(cid, {})).problems;
      } catch (e) {
        vscode.window.showErrorMessage(`[OJ] 无法获取题目列表：${describeThrown(e)}`);
        return;
      }
      if (briefs.length === 0) {
        vscode.window.showInformationMessage('[OJ] 该比赛没有可初始化的题目');
        return;
      }

      const hints = briefs.map(p => ({ pid: p.pid, globalId: p.globalId, title: p.title }));
      const init = buildInitializer(cid);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `[OJ] 正在初始化比赛 ${cid}`,
        cancellable: true,
      }, async (progress, token) => {
        const summary = await init.initializeContest(hints, {
          token,
          onProgress: p => progress.report({
            increment: 100 / Math.max(1, p.total),
            message: `${p.index}/${p.total}　${p.title || '题目 ' + p.pid}`,
          }),
        });

        const parts: string[] = [`完成 ${summary.ok}/${summary.total} 道题`];
        if (summary.createdSources) { parts.push(`新建源文件 ${summary.createdSources}`); }
        if (summary.assets) { parts.push(`落盘图片 ${summary.assets}`); }

        if (summary.failed.length) {
          const first = summary.failed.slice(0, 3)
            .map(f => `· 题目 ${f.pid}：${f.error}`).join('\n');
          const more = summary.failed.length > 3 ? `\n…等共 ${summary.failed.length} 道失败` : '';
          vscode.window.showWarningMessage(`[OJ] ${parts.join(' ｜ ')}\n${first}${more}`, { modal: true });
        } else if (summary.cancelled) {
          vscode.window.showWarningMessage(`[OJ] 已取消，${parts.join(' ｜ ')}（已完成的题目保留）`);
        } else {
          vscode.window.showInformationMessage(`[OJ] 初始化完成：${parts.join(' ｜ ')}`);
        }
      });

      problemTreeProvider.refresh();
      contestTreeProvider.refresh();
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

        const facts = await projectFacts(actualCid, pid);
        const decision = decideOpenProblem(facts);

        // C1：无文件夹 → 提醒（带按钮）后仍以只读方式展示题面
        if (decision.promptOpenFolder) {
          await ensureFolderForProject();
        }

        // C3：懒初始化该题（失败不阻断看题，只是没有本地文件）
        if (decision.lazyInit) {
          const r = await buildInitializer(actualCid).ensureProblem({ pid });
          if (r.ok) {
            if (r.createdSource || r.fetched) { problemTreeProvider.refresh(); }
          } else {
            vscode.window.showWarningMessage(
              `[OJ] 本题本地初始化失败：${r.error ?? '未知错误'}（仍可查看题面）`,
            );
          }
        }

        // C5：左侧源码、右侧题目 —— 先开源码再开面板，保证栏位顺序
        if (decision.split) {
          await openSourceInLeftColumn(actualCid, pid);
        }

        await problemWebview.show(actualCid, pid, { readOnly: decision.noCache });
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

        // C2：无工作区时明确提示并阻止提交
        const gate = decideSubmit(await projectFacts(cid, pid));
        if (!gate.allowed) {
          vscode.window.showWarningMessage(gate.message ?? '[OJ] 当前无法提交');
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

  // oj.refreshProblems — 刷新题目列表（忽略缓存强制联网）
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.refreshProblems', () => {
      problemTreeProvider.refresh(true);
    })
  );

  // ==========================================
  // 缓存刷新与清理（S4）
  // ==========================================

  // oj.cache.refreshProblem — 单题强制刷新（入口：题目页按钮 / 题目项右键菜单）
  // 契约 C4：无视 15 分钟阈值、不弹确认；契约 C10：失败必须可见。
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.cache.refreshProblem', async (item?: { problem?: ProblemBrief }) => {
      const pid = item?.problem?.pid || problemWebview.current.pid;
      const cid = item?.problem?.cid || problemWebview.current.cid || state.getCurrentCid() || '';
      if (!cid || !pid) {
        vscode.window.showErrorMessage('[OJ] 请先进入比赛并选择题目');
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `刷新题目 ${pid} 缓存` },
        async () => {
          const result = await buildRefresher(() => cid).refreshOne(pid);
          if (!result.ok) {
            vscode.window.showErrorMessage(`[OJ] 刷新题目 ${pid} 缓存失败：${result.error ?? '未知错误'}`);
            return;
          }
          // 若题目页正显示该题，就地更新（保留滚动位置）
          if (problemWebview.current.cid === cid && problemWebview.current.pid === pid) {
            await problemWebview.reloadFromCache();
          }
          vscode.window.showInformationMessage(`[OJ] 题目 ${pid} 缓存已刷新`);
        },
      );
    })
  );

  // oj.cache.refreshAllProblems — 全量强制刷新（入口：侧边栏「题目」标题栏按钮）
  // 契约 C5/C6/C7：确认框 → 串行逐题 → 可取消进度 → 失败汇总
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.cache.refreshAllProblems', async () => {
      const cid = state.getCurrentCid();
      if (!cid) {
        vscode.window.showErrorMessage('[OJ] 请先进入比赛');
        return;
      }
      if (isOfflineMode()) {
        vscode.window.showWarningMessage('[OJ] 离线模式已开启，无法刷新缓存。请先关闭设置 oj.cache.offline');
        return;
      }
      if (!(await probe.isReachable(true))) {
        vscode.window.showWarningMessage('[OJ] 网络不可用，无法刷新缓存');
        return;
      }

      // 取题目数以支撑确认框（走缓存优先，成本低）
      let total = 0;
      try {
        total = (await contestService.fetchProblemList(cid)).problems.length;
      } catch {
        total = 0;
      }

      const hit = await vscode.window.showWarningMessage(
        `将刷新比赛 ${cid} 全部 ${total || '?'} 道题的缓存（题目列表 + 题目详情 + 提交状态），继续？`,
        { modal: true },
        '继续',
      );
      if (hit !== '继续') { return; }

      const refresher = buildRefresher(() => cid);
      const summary = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `OJ 缓存刷新（${cid}）`, cancellable: true },
        async (progress, token) => refresher.refreshAll({
          token,
          onProgress: (p) => progress.report({
            message: `${p.index}/${p.total} 题目 ${p.pid}`,
            increment: 100 / Math.max(1, p.total),
          }),
        }),
      );

      problemTreeProvider.refresh();
      contestTreeProvider.refresh();

      const problems: string[] = [];
      if (!summary.contestListOk) { problems.push('题目列表刷新失败'); }
      if (!summary.statusOk) { problems.push('提交状态刷新失败'); }
      if (summary.failed.length) { problems.push(`${summary.failed.length} 道题刷新失败`); }

      if (problems.length === 0) {
        vscode.window.showInformationMessage(
          summary.cancelled
            ? `[OJ] 已取消，已刷新 ${summary.ok}/${summary.total} 道题`
            : `[OJ] 缓存刷新完成：${summary.ok} 道题`,
        );
        return;
      }

      const detail = [
        `比赛：${cid}`,
        `结果：${summary.cancelled ? '已取消' : '已完成'} ｜ 成功 ${summary.ok}/${summary.total}`,
        summary.failed.length
          ? `失败题目：\n${summary.failed.map(f => `  · ${f.pid}：${f.error}`).join('\n')}`
          : '',
        !summary.contestListOk ? '题目列表刷新失败（后续题目刷新已跳过）' : '',
        !summary.statusOk ? '提交状态刷新失败' : '',
      ].filter(Boolean).join('\n');

      const choice = await vscode.window.showWarningMessage(
        `[OJ] 缓存刷新：${problems.join('、')}`,
        '查看详情',
      );
      if (choice === '查看详情') {
        logInfo(`[cache] 刷新汇总\n${detail}`);
        showDebugChannel();
      }
    })
  );

  // oj.cache.status — 缓存与网络状态诊断
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.cache.status', async () => {
      const layout = cache.layout;
      const list = await cache.listCachedContests();
      const dataBytes = list.reduce((a, c) => a + c.dataBytes, 0);
      const userBytes = list.reduce((a, c) => a + c.userBytes, 0);
      const snap = probe.snapshot();
      const sec = (ms: number) => (ms < 0 ? '永不过期' : `${Math.round(ms / 1000)}s`);

      const detail = [
        `工作区：${layout.projectRoot}${layout.inWorkspace ? '' : '（全局兜底：当前无工作区）'}`,
        `内部数据根：${layout.rootDir}`,
        `比赛项目文件夹：建在工作区根下（可见），共 ${list.length} 个`,
        `开关：cache.enabled=${isCacheEnabled()} ｜ cache.offline=${isOfflineMode()}`,
        `TTL：同步读 ${sec(getCacheTtlMs())} ｜ 异步刷 ${sec(getStaleTtlMs())}`,
        `已缓存比赛：${list.length} 场（站点数据 ${formatBytes(dataBytes)} ｜ 用户产物 ${formatBytes(userBytes)}）`,
        `网络：${snap.lastOk === undefined ? '尚未探测' : snap.lastOk ? '可达' : '不可达'}` +
          ` ｜ 探测 ${snap.probeCount} 次（结果缓存命中 ${snap.cachedHitCount} 次）`,
      ].join('\n');

      const choice = await vscode.window.showInformationMessage(
        'OJ 缓存状态',
        { modal: true, detail },
        '打开缓存目录', '复制详情',
      );
      if (choice === '打开缓存目录') {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(layout.rootDir));
      } else if (choice === '复制详情') {
        await vscode.env.clipboard.writeText(detail);
        vscode.window.showInformationMessage('[OJ] 缓存详情已复制到剪贴板');
      }
    })
  );

  // oj.cache.purge — 清理缓存（契约：多选清理 + 全部清空；保留源码、test/ 与 meta.json）
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.cache.purge', async () => {
      const list = await cache.listCachedContests();
      if (list.length === 0) {
        vscode.window.showInformationMessage('[OJ] 暂无本地缓存');
        return;
      }

      type PurgeItem = vscode.QuickPickItem & { cid: string };
      const items: PurgeItem[] = list.map(c => ({
        label: `$(database) ${c.cid}${c.title ? ' · ' + c.title : ''}`,
        description: `缓存 ${formatBytes(c.dataBytes)}` +
          (c.userBytes ? ` ｜ 用户产物 ${formatBytes(c.userBytes)}（保留）` : ''),
        detail: `目录：${c.dirName} ｜ 题目数：${c.problemCount ?? '—'} ｜ 最近同步：${c.lastSyncAt}`,
        cid: c.cid,
      }));
      items.push({
        label: '$(trash) 清空全部比赛的缓存',
        description: `合计 ${formatBytes(list.reduce((a, c) => a + c.dataBytes, 0))}`,
        detail: '仅删除可重新获取的数据，保留源码、test/ 与 meta.json',
        cid: '__ALL__',
      });

      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: '清理缓存：选择要清理的比赛',
        placeHolder: '删除题面 / 样例 / 图片 / 状态 / 编译产物，保留源码与 test/',
      });
      if (!picked || picked.length === 0) { return; }

      const purgeAll = picked.some(p => p.cid === '__ALL__');
      const targets = purgeAll ? list.map(c => c.cid) : picked.map(p => p.cid);
      const bytes = purgeAll
        ? list.reduce((a, c) => a + c.dataBytes, 0)
        : list.filter(c => targets.includes(c.cid)).reduce((a, c) => a + c.dataBytes, 0);

      const hit = await vscode.window.showWarningMessage(
        `将清理 ${targets.length} 场比赛的缓存，预计释放 ${formatBytes(bytes)}。\n` +
        '删除：题面、样例、图片、状态、编译产物（temp/）。\n' +
        '保留：你的源码（main.cpp）、test/（测试结果）与 meta.json。此操作不可撤销。',
        { modal: true },
        '清理',
      );
      if (hit !== '清理') { return; }

      let done = 0;
      for (const cid of targets) {
        if (await cache.purgeContestData(cid)) { done += 1; }
      }
      problemTreeProvider.refresh();
      contestTreeProvider.refresh();
      vscode.window.showInformationMessage(
        `[OJ] 已清理 ${done} 场比赛的缓存，释放约 ${formatBytes(bytes)}`,
      );
    })
  );

  // ==========================================
  // 本地测试（S6）
  // ==========================================

  /** 「要对哪道题动手」：题目条目右键 → 当前打开的题目 → 都说不清就不要瞎猜 */
  function resolveProblemTarget(
    item?: { problem?: ProblemBrief },
  ): { cid: string; pid: string; title: string } | undefined {
    const p = item?.problem;
    if (p && p.cid !== undefined && p.pid !== undefined) {
      return { cid: String(p.cid), pid: String(p.pid), title: p.title ?? '' };
    }
    const cur = problemWebviewRef?.current;
    if (cur?.cid && cur?.pid !== undefined) {
      return { cid: String(cur.cid), pid: String(cur.pid), title: '' };
    }
    return undefined;
  }

  /**
   * 测试类命令的公共前半段：定位题目 → 装配依赖 → 交给回调。
   *
   * `forceRebuild` 三态：`undefined` = 按 `oj.test.reuseBuild` 走；`true` = 无视配置强制重编。
   */
  async function withTestDeps(
    item: { problem?: ProblemBrief } | undefined,
    title: string,
    forceRebuild: boolean | undefined,
    fn: (deps: RunnerDeps, token: vscode.CancellationToken) => Promise<void>,
  ): Promise<void> {
    const target = resolveProblemTarget(item);
    if (!target) {
      void vscode.window.showWarningMessage('[OJ] 请先在侧边栏的题目条目上右键运行，或先打开这道题的题面。');
      return;
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (_progress, token) => {
        const built = await buildTestDeps({
          store: cache, cid: target.cid, pid: target.pid,
          workspaceRoot: wsRoot, title: target.title,
          forceRebuild, log: logInfo,
        });
        if (!built.ok) {
          void vscode.window.showWarningMessage(`[OJ] ${built.error}`);
          return;
        }
        for (const n of built.notes) { logInfo(`[test] ${n}`); }
        built.deps.isCancelled = () => token.isCancellationRequested;
        await fn(built.deps, token);
      },
    );
  }

  /** 相对工作区根的路径，便于在消息里显示（不在工作区内则给绝对路径） */
  function displayPath(p: string): string {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return wsRoot ? path.relative(wsRoot, p) || p : p;
  }

  /** 编译（不判定、不跑样例）；失败时把编译器原文送进 Debug 频道并弹出来 */
  async function compileOnly(item: unknown, forceRebuild: boolean | undefined): Promise<void> {
    await withTestDeps(item as { problem?: ProblemBrief }, '[OJ] 正在编译…', forceRebuild, async (deps) => {
      const r = await new LocalTestRunner(deps).prepareOnly();
      if (!r.ok) {
        logInfo(`[test] 编译失败：\n${r.message}`);
        showDebugChannel();
        void vscode.window.showErrorMessage('[OJ] 编译失败：编译器输出见「OJ Debug」频道。');
        return;
      }
      logInfo(`[test] 编译成功：${r.build.command}${r.build.reused ? '（复用上次产物）' : ''}`);
      void vscode.window.showInformationMessage(
        `[OJ] 编译成功${r.build.reused ? '（复用上次产物）' : `（${r.build.durationMs} ms）`}：`
        + displayPath(r.build.runnable),
      );
    });
  }

  /** 本地测试：编译 + 跑样例 + 逐例判定 + 落盘报告 */
  async function runLocalTests(item: unknown): Promise<void> {
    await withTestDeps(item as { problem?: ProblemBrief }, '[OJ] 正在本地测试…', undefined, async (deps) => {
      const r: TestRunResult = await new LocalTestRunner(deps).run();
      const relReport = r.reportFile ? displayPath(r.reportFile) : '';
      const summary = `共 ${r.summary.total} 组，通过 ${r.summary.passed}，不通过 ${r.summary.failed}`
        + (r.summary.skipped ? `，跳过 ${r.summary.skipped}` : '');

      logInfo([
        `[test] ${summary}`,
        `[test] 编译：${r.build.reused ? '复用上次产物' : `${r.build.durationMs} ms`}（${r.build.command}）`,
        ...r.cases.map((c) => `[test] 用例 ${c.index}：${c.verdict === 'pass' ? '通过' : '不通过'}`
          + `（${c.runtime.durationMs} ms${c.diff ? ` · ${c.diff.description}` : ''}）`),
        ...r.skipped.map((s) => `[test] 跳过用例 ${s.index}：${s.reason}`),
      ].join('\n'));

      if (!r.ok) {
        showDebugChannel();
        void vscode.window.showErrorMessage(
          `[OJ] ${r.build.ok ? summary : '测试没能跑起来'}` + (relReport ? `　报告：${relReport}` : ''),
        );
        return;
      }

      if (r.summary.failed === 0) {
        void vscode.window.showInformationMessage(`[OJ] ${summary}：全部通过`);
        return;
      }
      const pick = await vscode.window.showWarningMessage(`[OJ] ${summary}`, '打开报告');
      if (pick === '打开报告' && r.reportFile) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(r.reportFile));
      }
    });
  }

  // oj.test.compile — 编译当前题目（按配置决定是否复用产物）
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.test.compile', async (item?: { problem?: ProblemBrief }) => {
      await compileOnly(item, undefined);
    })
  );

  // oj.test.compileForce — 无视复用配置，强制重新编译
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.test.compileForce', async (item?: { problem?: ProblemBrief }) => {
      await compileOnly(item, true);
    })
  );

  // oj.test.run — 编译 + 跑样例 + 判定
  context.subscriptions.push(
    vscode.commands.registerCommand('oj.test.run', async (item?: { problem?: ProblemBrief }) => {
      await runLocalTests(item);
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

/**
 * 离线状态同步到 context key，供菜单 `when` 条件使用
 * （离线 / 无网时把「强制刷新全部题目缓存」按钮置灰，见契约 C8）。
 */
async function syncOfflineContext(): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'oj.offline', isOfflineMode());
}

/** 异常 → 用户可读文案；复用会话层的失败分类，保证全插件口径一致 */
function describeThrown(e: unknown): string {
  const classified = classifyThrown(e);
  if (classified?.message) { return classified.message; }
  return (e as any)?.message || '未知错误';
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
