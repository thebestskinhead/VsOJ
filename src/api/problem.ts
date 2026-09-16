import { apiClient } from './client';
import { parseProblemDetail } from '../utils/parser';
import { ProblemDetail } from '../types';
import { getBaseUrl, getStaleTtlMs } from '../utils/config';
import { escapeHtml } from '../utils/format';
import { CacheStore, OfflineNoCacheError } from '../cache/store';
import { planRevisit } from '../cache/revalidate';
import { AccessGate, LoginRequiredError, throwIfDenied } from '../session/access';
import { classifyHtmlBody } from '../session/guard';
import { AccessError } from './contest';

/**
 * 题目模块 — 题目详情获取与解析（渲染产物的构建也在此，历史原因）。
 *
 * ## 题面是**过缓存**的
 *
 * 本模块区分两类取数：
 *
 * - {@link ProblemService.fetchProblemHtml} —— **纯网络原语**，直连站点、不读不写缓存。
 *   全插件只有刷新执行器（`cache/refresher.ts`）该用它，因为"刷新"的语义就是"绕过缓存"。
 * - {@link ProblemService.loadProblemHtml} —— 闸门后的取数：命中缓存就零网络返回，
 *   过期才在后台补拉一次，离线且无缓存则抛 {@link OfflineNoCacheError}。
 *   凡是要**给用户或 AI 看题面**的地方都走这条（题目页、MCP 工具）。
 *
 * 这条分工不能含糊：一旦让 `fetchProblemHtml` 也去读缓存，刷新命令就会变成空操作。
 *
 * 「纯网络」不等于「不看响应」：取回的若是一张登录页，那就不是题面，
 * 原语必须当场识破并抛出 {@link LoginRequiredError}，否则刷新器会把登录页
 * 当成最新题面写进缓存。
 */

/** 题目页渲染选项 */
export interface ProblemViewOptions {
  /** 顶部信息栏文案（如「本地缓存 · 更新于 3 分钟前」） */
  banner?: string;
  /** 信息栏样式类别 */
  bannerKind?: 'cache' | 'offline' | 'fresh' | 'error';
  /** 是否显示右侧「刷新」按钮 */
  enableRefresh?: boolean;
}

/** 取到题面的同时说明它的来源与年龄 */
export interface ProblemHtmlResult {
  html: string;
  /** `cache` = 本地命中（可能已过期，看 `ageMs`）；`network` = 本次联网取得 */
  source: 'cache' | 'network';
  /** 缓存年龄（毫秒）；联网取得时为 0 */
  ageMs: number;
  /** 是否已安排后台刷新（缓存过期且允许联网） */
  refreshing: boolean;
}

/** 结构化详情 + 来源信息 */
export interface ProblemDetailResult extends ProblemHtmlResult {
  detail: ProblemDetail;
}

export interface ProblemLoadOptions {
  /** 忽略缓存直接联网（用户显式刷新时用） */
  force?: boolean;
  /** 后台刷新完成后的回调；只有「缓存过期且允许联网」时才会触发 */
  onRefreshed?: (html: string) => void;
  log?: (msg: string) => void;
}

export class ProblemService {
  private access: AccessGate;
  private store?: CacheStore;

  /** `store` 不传 = 没有缓存层（未接线 / 工作区外只读预览），闸门退化为直连站点 */
  constructor(access: AccessGate, store?: CacheStore) {
    this.access = access;
    this.store = store;
  }

  /**
   * 拉取题目页**原始 HTML**（直连站点，不读也不写缓存）。
   *
   * 缓存层保存的就是这份 HTML（见 `cache/paths.ts` 的「只存原始信息」原则），
   * 因此这是拉取与落盘的共同入口 —— 也正因如此，它必须保持"纯粹"。
   *
   * 唯一一处例外是**回应内容的核对**：取回登录页说明会话已失效，此时抛错
   * 而不是把登录页交出去（见类注释）。
   */
  async fetchProblemHtml(cid: string, pid: string): Promise<string> {
    const response = await apiClient.get('/problem.php', {
      params: { cid, pid },
      headers: { 'Cache-Control': 'no-cache' },
    }, 'problem.fetchProblemHtml');
    const html = typeof response.data === 'string' ? response.data : '';
    // 登录页特征：会话已在服务端失效，登录页不是题面，绝不可交出去
    if (this.access.noteResponse(html)) {
      throw new LoginRequiredError('problem', '登录已过期，请重新登录后继续');
    }
    // 受限页（私有比赛 / 未开始 / 题目不存在）同样不是题面：既不可渲染，也不可落盘。
    // 先判断本地登录态是否已失效——站点把本应授权的请求判为未授权，说明会话早已作废，
    // 应当走登录提示而非权限提示。
    const kind = classifyHtmlBody(html);
    if (kind === 'NO_PERMISSION' || kind === 'BAD_TARGET') {
      if (!this.access.isLoggedIn()) {
        this.access.noteSessionLost('题面受限且本地登录态已不可用');
        throw new LoginRequiredError('problem', '登录已过期，请重新登录后继续');
      }
      throw new AccessError(kind === 'BAD_TARGET'
        ? '题目不存在'
        : '当前无权限查看该题目（可能未开始或为私有比赛）');
    }
    return html;
  }

  /**
   * 过闸门取题面：命中缓存零网络返回，过期后台补拉，离线无缓存抛错。
   *
   * 后台刷新是 **fire-and-forget**：首屏用缓存渲染，新内容到了再由 `onRefreshed`
   * 通知调用方按需替换（避免整页重绘打断阅读）。刷新失败不抛出 —— 缓存还在，
   * 网络抖动不该让已经能看的内容变成错误页。
   */
  async loadProblemHtml(cid: string, pid: string, opts: ProblemLoadOptions = {}):
    Promise<ProblemHtmlResult> {
    const store = this.store;

    const verdict = await this.access.check('problem', async () =>
      (await this.store?.statProblemHtml(cid, pid))?.exists ?? false);
    throwIfDenied(verdict, 'problem');

    if (!store) {
      const html = await this.fetchProblemHtml(cid, pid);
      return { html, source: 'network', ageMs: 0, refreshing: false };
    }

    const stat = await store.statProblemHtml(cid, pid);

    // 1) 离线态：只吃缓存，过期也照给 —— 这正是离线做题的意义，不排后台刷新
    if (verdict.kind === 'cache') {
      const html = await store.readProblemHtml(cid, pid, { allowStale: true });
      if (html !== undefined) {
        return { html, source: 'cache', ageMs: stat.ageMs ?? 0, refreshing: false };
      }
      throw new OfflineNoCacheError('题目内容');
    }

    const plan = planRevisit({
      offline: store.offline,
      hasCache: stat.exists,
      ageMs: stat.ageMs,
      staleMs: getStaleTtlMs(),
    });

    // 2) 缓存路径：首屏绝不阻塞在网络
    if (!opts.force && plan.source === 'cache') {
      const html = await store.readProblemHtml(cid, pid, { allowStale: true });
      // 读得到才算命中：文件可能属于别的题（题集重排留下的），此时按未命中处理
      if (html !== undefined) {
        if (plan.backgroundRefresh) {
          opts.log?.(`[problem] 缓存已过期，后台刷新 ${pid}`);
          void this.refreshInBackground(cid, pid, opts);
        }
        return {
          html,
          source: 'cache',
          ageMs: stat.ageMs ?? 0,
          refreshing: plan.backgroundRefresh,
        };
      }
    }

    // 3) 网络路径
    const html = await this.fetchProblemHtml(cid, pid);
    await store.writeProblemHtml(cid, pid, html);
    return { html, source: 'network', ageMs: 0, refreshing: false };
  }

  /** 后台刷新：拉最新题面覆盖缓存（失败静默，缓存保留） */
  private async refreshInBackground(cid: string, pid: string, opts: ProblemLoadOptions): Promise<void> {
    try {
      const html = await this.fetchProblemHtml(cid, pid);
      await this.store?.writeProblemHtml(cid, pid, html);
      opts.onRefreshed?.(html);
    } catch (e: any) {
      opts.log?.(`[problem] 后台刷新失败，保留缓存：${e?.message ?? e}`);
    }
  }

  /** 获取题目结构化数据（内存解析产物，不落盘；题面走闸门） */
  async fetchProblem(cid: string, pid: string, opts: ProblemLoadOptions = {}):
    Promise<ProblemDetailResult> {
    let html: string;
    let source: 'cache' | 'network';
    let ageMs: number;
    let refreshing: boolean;

    try {
      ({ html, source, ageMs, refreshing } = await this.loadProblemHtml(cid, pid, opts));
    } catch (e: any) {
      // 闸门拒答 / 受限页原样上抛：调用方要能区分「离线拿不到 / 要登录 / 无权限」与「站点上没有」
      if (e instanceof OfflineNoCacheError || e instanceof LoginRequiredError || e instanceof AccessError) { throw e; }
      console.error('[OJ] 题目详情加载失败:', e);
      throw new Error(`加载题目详情失败: ${e.message}`);
    }

    const detail = parseProblemDetail(html);
    if (!detail) {
      throw new Error('加载题目详情失败: 无法解析题目内容');
    }

    detail.cid = cid;
    detail.pid = pid;
    return { detail, html, source, ageMs, refreshing };
  }

  /** 仅题目内容区（用于增量替换，不含信息栏与脚本） */
  buildProblemContentHtml(detail: ProblemDetail): string {
    const panel = (title: string, body: string) => body ? `<div class="panel">
    <div class="panel-heading">${title}</div>
    <div class="panel-body">${body}</div>
  </div>` : '';

    const sample = (title: string, text: string) => text ? `<div class="sample-block">
    <h4>${title}</h4>
    <pre>${escapeHtml(text)}</pre>
  </div>` : '';

    return [
      `<h2>${escapeHtml(detail.title)}</h2>`,
      panel('题目描述', detail.description),
      panel('输入', detail.inputDesc),
      panel('输出', detail.outputDesc),
      detail.hint ? panel('提示', detail.hint) : '',
      sample('样例输入', detail.sampleInput),
      sample('样例输出', detail.sampleOutput),
    ].filter(Boolean).join('\n  ');
  }

  /** 构建题目详情 Webview 完整 HTML（含信息栏与刷新按钮） */
  buildProblemHtml(detail: ProblemDetail, opts: ProblemViewOptions = {}): string {
    const banner = opts.banner ?? '';
    const kind = opts.bannerKind ?? 'cache';
    const content = this.buildProblemContentHtml(detail);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(detail.title)}</title>
  <style>
    /* 固定亮色主题：不跟随 VS Code 配色（深色主题下题目页仍保持白底深字） */
    html { color-scheme: light; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      padding: 0 20px 20px;
      background: #fff;
    }
    .oj-bar {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px;
      margin: 0 -20px 16px; padding: 7px 14px;
      font-size: 12px;
      border-bottom: 1px solid #ddd;
      background: #f7f7f7;
      color: #666;
    }
    .oj-bar-fresh { border-bottom-color: #4CAF50; color: #2e7d32; }
    .oj-bar-cache { border-bottom-color: #c8a800; }
    .oj-bar-offline { border-bottom-color: #d9822b; color: #b35c00; font-weight: 600; }
    .oj-bar-error { border-bottom-color: #c62828; color: #c62828; font-weight: 600; }
    .oj-bar-right { display: flex; align-items: center; gap: 8px; }
    .oj-bar button {
      font: inherit; font-size: 11px; padding: 2px 10px; cursor: pointer;
      border: 1px solid #ccc; border-radius: 3px;
      background: #f0f0f0;
      color: #333;
    }
    .oj-bar button:hover { background: #e0e0e0; }
    .oj-spin {
      width: 10px; height: 10px; border-radius: 50%;
      border: 2px solid #bbb; border-top-color: #4CAF50;
      animation: ojspin 0.7s linear infinite; display: inline-block;
    }
    @keyframes ojspin { to { transform: rotate(360deg); } }
    h2 { color: #2e7d32; border-bottom: 2px solid #4CAF50; padding-bottom: 8px; margin-bottom: 16px; font-size: 20px; }
    h3 { color: #4CAF50; margin: 20px 0 10px; font-size: 16px; }
    .panel { border: 1px solid #c8e6c9; border-radius: 6px; margin-bottom: 16px; background: #f8fff8; }
    .panel-heading {
      background: #e8f5e9; padding: 8px 15px; border-bottom: 1px solid #c8e6c9;
      font-weight: 600; color: #2e7d32; border-radius: 6px 6px 0 0;
    }
    .panel-body { padding: 15px; }
    .sample-block { margin: 15px 0; }
    .sample-block h4 { color: #4CAF50; margin-bottom: 6px; font-size: 14px; }
    .sample-block pre {
      background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px;
      padding: 12px; overflow-x: auto; white-space: pre;
      font-family: "Courier New", Consolas, monospace; font-size: 13px;
      line-height: 1.5;
    }
    table { border-collapse: collapse; width: 100%; margin: 10px 0; }
    table td, table th { border: 1px solid #c8e6c9; padding: 6px 10px; text-align: left; }
    th { background: #e8f5e9; }
    img { max-width: 100%; height: auto; }
    code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-family: Consolas, monospace; font-size: 13px; }
    pre code { background: none; padding: 0; }
    a { color: #4CAF50; }
  </style>
</head>
<body>
  <div class="oj-bar oj-bar-${kind}" id="ojBar">
    <span id="ojBarText">${escapeHtml(banner)}</span>
    <span class="oj-bar-right">
      <span class="oj-spin" id="ojSpin" style="display:none"></span>
      ${opts.enableRefresh ? '<button id="ojRefreshBtn" title="强制刷新本题缓存（忽略 15 分钟阈值）">刷新</button>' : ''}
    </span>
  </div>
  <div id="ojContent">
  ${content}
  </div>
  <script>
    (function () {
      var vscode = acquireVsCodeApi();
      var bar = document.getElementById('ojBar');
      var barText = document.getElementById('ojBarText');
      var spin = document.getElementById('ojSpin');
      var btn = document.getElementById('ojRefreshBtn');
      if (btn) {
        btn.addEventListener('click', function () {
          spin.style.display = 'inline-block';
          barText.textContent = '正在刷新…';
          vscode.postMessage({ command: 'refreshProblem' });
        });
      }
      window.addEventListener('message', function (e) {
        var d = e.data || {};
        if (d.command === 'banner') {
          barText.textContent = d.text || barText.textContent;
          if (d.kind) { bar.className = 'oj-bar oj-bar-' + d.kind; }
          spin.style.display = 'none';
        } else if (d.command === 'refreshing') {
          spin.style.display = 'inline-block';
          if (d.text) { barText.textContent = d.text; }
        } else if (d.command === 'content') {
          // 增量替换：保留滚动位置，避免刷新后跳到顶部
          var top = window.scrollY || document.documentElement.scrollTop || 0;
          document.getElementById('ojContent').innerHTML = d.html || '';
          window.scrollTo(0, top);
          if (d.banner) {
            barText.textContent = d.banner;
            if (d.kind) { bar.className = 'oj-bar oj-bar-' + d.kind; }
          }
          spin.style.display = 'none';
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  // 转义实现只有一份：`utils/format`（题目页 / 结果页 / 提交状态页共用）
}
