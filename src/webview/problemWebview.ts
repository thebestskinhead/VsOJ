import * as vscode from 'vscode';
import { ProblemService } from '../api/problem';
import { StateManager } from '../utils/state';
import { parseProblemDetail } from '../utils/parser';
import { CacheStore, OfflineNoCacheError } from '../cache/store';
import { ProblemRefresher, RefreshOneResult } from '../cache/refresher';
import { resolveRevisitPlan } from '../cache/revalidate';
import { formatAge } from '../cache/freshness';
import { ConnectivityProbe } from '../session/connectivity';
import { AccessGate, AccessReason, LoginRequiredError } from '../session/access';
import { localizeImages } from '../media/localize';
import { getStaleTtlMs, getBaseUrl } from '../utils/config';
import { escapeHtml } from '../utils/format';

/**
 * 题目详情 Webview —— **缓存优先 + 离线预览**。
 *
 * 打开题目页的完整流程（决策依据见 `cache/revalidate.ts`）：
 *
 *   1) 首屏**永不阻塞在网络**上：有缓存就先渲染缓存，并显示「更新于 X 分钟前」
 *   2) 缓存超过 `oj.cache.staleSeconds`（默认 15 分钟）且网络可达 → 后台刷新，
 *      内容有变化才替换（保留滚动位置），无变化只更新时间戳
 *   3) 离线 / 网络不可达 → 纯缓存渲染，信息栏标注「离线预览」
 *   4) 无缓存 → 走网络；失败且无缓存时给出明确提示
 *
 * 所有网络与存储动作都从外部注入，因此本类只负责「编排 + 渲染」。
 */

export interface ProblemWebviewDeps {
  store: CacheStore;
  probe: ConnectivityProbe;
  refresher: ProblemRefresher;
  /** 访问闸门：未登录时题目页一个字都不渲染，直接换成登录提示 */
  access: AccessGate;
  /** 抓取题面图片（传入绝对 URL） */
  fetchAsset: (absoluteUrl: string) => Promise<Buffer>;
  log?: (msg: string) => void;
}

/** 信息栏状态 */
interface BannerState {
  text: string;
  kind: 'cache' | 'offline' | 'fresh' | 'error';
}

export class ProblemWebview {
  private panel: vscode.WebviewPanel | undefined;
  private problemService: ProblemService;
  private state: StateManager;
  private deps: ProblemWebviewDeps;

  private cid = '';
  private pid = '';
  /** 上次渲染的内容区 HTML，用于判断后台刷新是否真的带来了变化 */
  private lastContentHtml = '';
  /** 防止并发刷新（页面按钮连点 / 后台刷新撞车） */
  private refreshing = false;
  /**
   * 只读模式（D15：未打开文件夹）。
   *
   * 此时**不使用本地缓存**：没有工作区就没有缓存根，读到的将是 globalStorage 里的
   * 兜底目录，那与本机其他窗口的缓存混在一起，既不该读也不该写。因此直连站点、
   * 图片也只走网络，并且不显示「刷新」按钮（无缓存可刷）。
   */
  private readOnly = false;

  constructor(problemService: ProblemService, state: StateManager, deps: ProblemWebviewDeps) {
    this.problemService = problemService;
    this.state = state;
    this.deps = deps;
  }

  /** 当前面板显示的题目（供命令判断作用对象） */
  public get current(): { cid: string; pid: string } {
    return { cid: this.cid, pid: this.pid };
  }

  /** 题目面板当前是否打开（供状态收口判断是否要重新裁决，避免凭空开新面板） */
  public get isOpen(): boolean { return !!this.panel; }

  /**
   * 打开题目。
   *
   * @param opts.readOnly 无工作区时由 `workspace/guard.ts` 的结论传入（C1）
   */
  async show(cid: string, pid: string, opts: { readOnly?: boolean } = {}): Promise<void> {
    await this.state.setCurrentPid(pid);
    this.cid = cid;
    this.pid = pid;
    this.readOnly = !!opts.readOnly;

    this.ensurePanel();

    // 闸门先过：未登录时题目一个字都不给 —— 站点对公开比赛是免登录渲染的，
    // 拦不住就会把题面端给未登录用户，等他写完代码点提交才发现要登录
    const verdict = await this.deps.access.check('problem', async () =>
      (await this.deps.store.statProblemHtml(cid, pid)).exists);
    if (verdict.kind === 'deny') {
      await this.renderDenied(verdict.reason);
      return;
    }

    if (this.readOnly) {
      await this.renderFromNetwork();
      return;
    }

    // 离线态：只吃缓存，不排后台刷新
    if (verdict.kind === 'cache') {
      const cached = await this.deps.store.readProblemHtml(cid, pid, { allowStale: true });
      if (cached !== undefined) {
        const stat = await this.deps.store.statProblemHtml(cid, pid);
        await this.render(cached, { text: this.bannerText('offline', stat.ageMs, false), kind: 'offline' });
        return;
      }
      await this.renderDenied('OFFLINE_NO_CACHE');
      return;
    }

    // 会话式决策：首屏来源 + 是否需要后台刷新
    const stat = await this.deps.store.statProblemHtml(cid, pid);
    const plan = await resolveRevisitPlan({
      isOffline: () => this.deps.store.offline,
      hasCache: () => stat.exists,
      ageMs: () => stat.ageMs,
      staleMs: () => getStaleTtlMs(),
      isReachable: () => this.deps.probe.isReachable(),
      log: this.deps.log,
    });

    // ---------- 缓存路径：首屏立即渲染，零等待 ----------
    if (plan.source === 'cache') {
      const rawHtml = await this.deps.store.readProblemHtml(cid, pid, { allowStale: true });
      if (rawHtml !== undefined) {
        const kind: BannerState['kind'] = plan.reason === 'offline' ? 'offline' : 'cache';
        await this.render(rawHtml, {
          text: this.bannerText(plan.reason, stat.ageMs, plan.backgroundRefresh),
          kind,
        });
        if (plan.backgroundRefresh) {
          void this.backgroundRefresh();
        }
        return;
      }
      // 缓存刚好被清掉 → 落到网络路径
    }

    await this.renderFromNetwork();
  }

  /** 网络路径：直接拉题面渲染（只读模式下不落盘） */
  private async renderFromNetwork(): Promise<void> {
    this.panel!.webview.html = this.getLoadingHtml();
    try {
      const rawHtml = await this.problemService.fetchProblemHtml(this.cid, this.pid);
      if (!this.readOnly) {
        await this.deps.store.writeProblemHtml(this.cid, this.pid, rawHtml);
      }
      await this.render(rawHtml, this.readOnly
        ? { text: '只读预览 · 未打开文件夹（不写盘、不使用缓存）', kind: 'offline' }
        : { text: '已更新 · 刚刚', kind: 'fresh' });
    } catch (e: any) {
      // 取回的是登录页 —— 与「取不到」不是一回事，得引导去登录
      if (e instanceof LoginRequiredError || e instanceof OfflineNoCacheError) {
        this.deps.log?.(`[problem] ${e.name}：${e.message}`);
        await this.renderDenied(e instanceof LoginRequiredError ? 'LOGIN_REQUIRED' : 'OFFLINE_NO_CACHE');
        return;
      }
      const offline = this.deps.store.offline;
      this.deps.log?.(`[problem] 加载失败：${e?.message ?? e}`);
      this.panel!.webview.html = this.getErrorHtml(
        offline
          ? '无法获取题目内容（离线模式已开启，且本地无该题缓存）'
          : `加载题目失败：${e?.message ?? e}`,
      );
    }
  }

  /**
   * 闸门拒答时把面板换成登录提示（或被拒原因的说明）。
   *
   * 侧边栏那类列表可以只留一行占位，题目页不行 —— 它整屏都是内容，
   * 留着上一次渲染的题面等于「未登录也能看题」。
   */
  private async renderDenied(reason: AccessReason): Promise<void> {
    this.lastContentHtml = '';
    this.panel!.title = 'OJ 登录';
    this.panel!.webview.html = this.getLoginRequiredHtml(reason);
  }

  /**
   * 会话在别处失效时，把已经打开的题目页一并收走。
   *
   * 由闸门发现响应为登录页、或保活探测确认失效时调用：正在看的题面属于
   * 「登录态下才该看到」的内容，登录掉了就得跟着消失，不能等用户下次点击。
   */
  public async applyAccessLoss(): Promise<void> {
    if (!this.panel) { return; }
    await this.renderDenied('LOGIN_REQUIRED');
  }

  /**
   * 用户显式触发的强制刷新（页面按钮 / `oj.cache.refreshProblem` 命令）。
   *
   * 与后台刷新的关键差别（契约 C10）：**失败必须可见**，不能静默吞掉。
   */
  public async refreshCurrent(): Promise<RefreshOneResult> {
    if (this.readOnly) {
      return { pid: this.pid, ok: false, error: '未打开文件夹，当前为只读预览，无缓存可刷新' };
    }
    if (!this.cid || !this.pid) {
      return { pid: '', ok: false, error: '当前没有打开的题目' };
    }
    if (this.refreshing) {
      return { pid: this.pid, ok: false, error: '正在刷新中，请稍候' };
    }

    this.refreshing = true;
    this.post({ command: 'refreshing', text: '正在刷新…' });
    try {
      const result = await this.deps.refresher.refreshOne(this.pid);
      // 会话失效是刷新失败的一种特殊性质：应当换成登录提示，而不是只弹一句错误
      if (!result.ok) {
        if (this.deps.access.sessionLost) {
          await this.applyAccessLoss();
          return result;
        }
        this.post({
          command: 'banner',
          text: `刷新失败：${result.error ?? '未知错误'}`,
          kind: 'error',
        });
        return result;
      }

      const rawHtml = await this.deps.store.readProblemHtml(this.cid, this.pid, { allowStale: true });
      if (rawHtml !== undefined) {
        await this.applyRefreshResult(rawHtml, '已更新 · 刚刚');
      }
      return result;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 外部刷新完成后就地重载内容（**不再联网**，只读刚写入的缓存）。
   * 供 `oj.cache.refreshProblem` 命令使用，避免同一次刷新触发两次请求。
   */
  public async reloadFromCache(bannerText: string = '已更新 · 刚刚'): Promise<void> {
    if (!this.cid || !this.pid) { return; }
    const rawHtml = await this.deps.store.readProblemHtml(this.cid, this.pid, { allowStale: true });
    if (rawHtml === undefined) { return; }
    await this.applyRefreshResult(rawHtml, bannerText);
  }

  /**
   * 后台刷新（被动触发，失败**静默**——契约 C8）。
   * 内容无变化时只更新时间戳，避免整页重绘导致滚动跳动。
   */
  private async backgroundRefresh(): Promise<void> {
    if (this.refreshing) { return; }
    this.refreshing = true;
    try {
      const result = await this.deps.refresher.refreshOne(this.pid);
      if (!result.ok) {
        // 静默降级：回落到「缓存 + 更新失败」的表述，不弹窗
        const stat = await this.deps.store.statProblemHtml(this.cid, this.pid);
        this.post({
          command: 'banner',
          text: `本地缓存 · 更新于 ${formatAge(stat.ageMs)}（后台更新失败）`,
          kind: 'cache',
        });
        return;
      }
      const rawHtml = await this.deps.store.readProblemHtml(this.cid, this.pid, { allowStale: true });
      if (rawHtml !== undefined) {
        await this.applyRefreshResult(rawHtml, '已更新 · 刚刚');
      }
    } finally {
      this.refreshing = false;
    }
  }

  /** 刷新成功后：内容有变化才替换，无变化只更新信息栏 */
  private async applyRefreshResult(rawHtml: string, bannerText: string): Promise<void> {
    const detail = await this.toDetail(rawHtml);
    if (!detail) {
      this.post({ command: 'banner', text: bannerText, kind: 'fresh' });
      return;
    }
    const contentHtml = this.problemService.buildProblemContentHtml(detail);

    if (contentHtml === this.lastContentHtml) {
      // 内容未变 —— 只更新时间戳，保留用户的滚动位置与选区
      this.post({ command: 'banner', text: bannerText, kind: 'fresh' });
      return;
    }

    this.lastContentHtml = contentHtml;
    this.panel!.title = detail.title || `题目 ${this.pid}`;
    this.post({ command: 'content', html: contentHtml, banner: bannerText, kind: 'fresh' });
  }

  /** 首屏渲染（整页 HTML 替换） */
  private async render(rawHtml: string, banner: BannerState): Promise<void> {
    const detail = await this.toDetail(rawHtml);
    if (!detail) {
      this.panel!.webview.html = this.getErrorHtml('题目页解析失败（站点结构可能已变化）');
      return;
    }
    this.lastContentHtml = this.problemService.buildProblemContentHtml(detail);
    this.panel!.title = detail.title || `题目 ${this.pid}`;
    this.panel!.webview.html = this.problemService.buildProblemHtml(detail, {
      banner: banner.text,
      bannerKind: banner.kind,
      // 只读模式下没有缓存可刷，按钮只会误导
      enableRefresh: !this.readOnly,
    });
  }

  /** 原始 HTML → 结构化详情（图片先本地化，优先本地缓存） */
  private async toDetail(rawHtml: string) {
    const localized = await localizeImages(rawHtml, {
      // 只读模式不读也不写本地图片：没有工作区就没有该比赛对应的资产目录
      readLocal: (url) => (this.readOnly
        ? Promise.resolve(undefined)
        : this.deps.store.readProblemAsset(this.cid, this.pid, url)),
      writeLocal: async (url, buf) => {
        if (!this.readOnly) {
          await this.deps.store.writeProblemAsset(this.cid, this.pid, url, buf);
        }
      },
      fetchRemote: (url) => this.deps.fetchAsset(`${getBaseUrl()}${url}`),
      isOffline: () => this.deps.store.offline,
      baseUrl: () => getBaseUrl(),
      log: this.deps.log,
    });

    const detail = parseProblemDetail(localized.html);
    if (!detail) { return null; }
    detail.cid = this.cid;
    detail.pid = this.pid;
    return detail;
  }

  private bannerText(reason: string, ageMs: number | undefined, refreshing: boolean): string {
    const age = formatAge(ageMs);
    if (reason === 'offline') { return `离线预览 · 缓存于 ${age}`; }
    if (reason === 'unreachable') { return `离线预览 · 网络不可用，缓存于 ${age}`; }
    const base = `本地缓存 · 更新于 ${age}`;
    return refreshing ? `${base} · 正在更新…` : base;
  }

  private post(message: unknown): void {
    this.panel?.webview.postMessage(message);
  }

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two, true);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ojProblemDetail',
      '题目详情',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    // 页面内「刷新」按钮（C3①）
    this.panel.webview.onDidReceiveMessage(async (msg: any) => {
      // 登录提示页上的按钮：改登录页与「登录后回到本题」由扩展层编排
      if (msg?.command === 'login') {
        vscode.commands.executeCommand('oj.login');
        return;
      }
      if (msg?.command !== 'refreshProblem') { return; }
      const result = await this.refreshCurrent();
      // 会话失效已由面板内的登录提示承接，不必再弹重复的失败提示
      if (!result.ok && !this.deps.access.sessionLost) {
        vscode.window.showErrorMessage(`[OJ] 刷新题目失败：${result.error ?? '未知错误'}`);
      } else if (result.ok) {
        vscode.window.showInformationMessage('[OJ] 题目缓存已刷新');
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.lastContentHtml = '';
      this.cid = '';
      this.pid = '';
    });
  }

  private getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  /* 固定亮色主题：不跟随 VS Code 配色 */
  html { color-scheme: light; }
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #888; background: #fff; }
  .spinner { border: 3px solid #e0e0e0; border-top: 3px solid #4CAF50; border-radius: 50%; width: 32px; height: 32px; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body><div style="text-align:center;"><div class="spinner"></div><p>正在加载题目详情...</p></div></body></html>`;
  }

  private getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  html { color-scheme: light; }
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #c62828; background: #fff; }
  .hint { color: #888; font-size: 12px; margin-top: 8px; }
</style></head>
<body><div style="text-align:center;">
  <h3>加载失败</h3>
  <p>${escapeHtml(message)}</p>
  <p class="hint">网络恢复后重新打开本题即可自动重建缓存</p>
</div></body></html>`;
  }

  /**
   * 登录提示页 —— 被闸门拦下时题目页位置显示的就是它。
   *
   * 「打开登录页」按钮不在这里直接开面板，而是把动作交回扩展（`oj.login`）：
   * 登录页与「登录成功后回到这道题」都是扩展层的编排，webview 只管讲清楚
   * 为什么看不了、以及下一步点哪。
   */
  private getLoginRequiredHtml(reason: AccessReason): string {
    const title = reason === 'LOGIN_REQUIRED' ? '需要登录' : '离线且无本地缓存';
    const detail = reason === 'LOGIN_REQUIRED'
      ? '未登录时不提供比赛列表与题面。登录后会回到这道题。'
      : '当前处于离线状态，而这道题在本机没有缓存，无法显示。';
    const hint = reason === 'LOGIN_REQUIRED'
      ? '本地已经写好的代码不受影响；登录后即可继续。'
      : '联网打开过一次的题目，之后离线也能看。';
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  html { color-scheme: light; }
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #333; background: #fff; }
  h3 { color: #b35c00; }
  .detail { color: #555; }
  .hint { color: #888; font-size: 12px; margin-top: 8px; }
  button {
    font: inherit; padding: 6px 18px; cursor: pointer; margin-top: 14px;
    border: 1px solid #4CAF50; border-radius: 4px; background: #4CAF50; color: #fff;
  }
  button:hover { background: #43a047; }
</style></head>
<body><div style="text-align:center;">
  <h3>${escapeHtml(title)}</h3>
  <p class="detail">${escapeHtml(detail)}</p>
  ${reason === 'LOGIN_REQUIRED'
    ? '<button id="ojLoginBtn">打开登录页</button>'
    : '<p class="hint">可在设置里关闭 <code>oj.cache.offline</code> 后重试，或等网络恢复。</p>'}
  <p class="hint">${escapeHtml(hint)}</p>
  <script>
    (function () {
      var vscode = acquireVsCodeApi();
      var btn = document.getElementById('ojLoginBtn');
      if (btn) {
        btn.addEventListener('click', function () { vscode.postMessage({ command: 'login' }); });
      }
    })();
  </script>
</div></body></html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
