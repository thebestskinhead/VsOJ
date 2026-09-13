import { apiClient } from './client';
import { parseProblemDetail } from '../utils/parser';
import { ProblemDetail } from '../types';
import { getBaseUrl } from '../utils/config';

/** 题目模块 — 题目详情获取与解析（渲染产物的构建也在此，历史原因） */

/** 题目页渲染选项 */
export interface ProblemViewOptions {
  /** 顶部信息栏文案（如「本地缓存 · 更新于 3 分钟前」） */
  banner?: string;
  /** 信息栏样式类别 */
  bannerKind?: 'cache' | 'offline' | 'fresh' | 'error';
  /** 是否显示右侧「刷新」按钮 */
  enableRefresh?: boolean;
}

export class ProblemService {
  /**
   * 拉取题目页**原始 HTML**。
   *
   * 缓存层保存的就是这份 HTML（见 `cache/paths.ts` 的「只存原始信息」原则），
   * 因此这是拉取与落盘的共同入口。
   */
  async fetchProblemHtml(cid: string, pid: string): Promise<string> {
    const response = await apiClient.get('/problem.php', {
      params: { cid, pid },
      headers: { 'Cache-Control': 'no-cache' },
    }, 'problem.fetchProblemHtml');
    return typeof response.data === 'string' ? response.data : '';
  }

  /** 获取题目结构化数据（内存解析产物，不落盘） */
  async fetchProblem(cid: string, pid: string): Promise<ProblemDetail> {
    try {
      const html = await this.fetchProblemHtml(cid, pid);
      const detail = parseProblemDetail(html);

      if (!detail) {
        throw new Error('无法解析题目内容');
      }

      detail.cid = cid;
      detail.pid = pid;
      return detail;
    } catch (e: any) {
      console.error('[OJ] 题目详情加载失败:', e);
      throw new Error(`加载题目详情失败: ${e.message}`);
    }
  }

  /** 仅题目内容区（用于增量替换，不含信息栏与脚本） */
  buildProblemContentHtml(detail: ProblemDetail): string {
    const panel = (title: string, body: string) => body ? `<div class="panel">
    <div class="panel-heading">${title}</div>
    <div class="panel-body">${body}</div>
  </div>` : '';

    const sample = (title: string, text: string) => text ? `<div class="sample-block">
    <h4>${title}</h4>
    <pre>${this.escapeHtml(text)}</pre>
  </div>` : '';

    return [
      `<h2>${this.escapeHtml(detail.title)}</h2>`,
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
  <title>${this.escapeHtml(detail.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: var(--vscode-foreground, #333);
      padding: 0 20px 20px;
      background: var(--vscode-editor-background, #fff);
    }
    .oj-bar {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px;
      margin: 0 -20px 16px; padding: 7px 14px;
      font-size: 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #ddd);
      background: var(--vscode-editorWidget-background, #f7f7f7);
      color: var(--vscode-descriptionForeground, #666);
    }
    .oj-bar-fresh { border-bottom-color: #4CAF50; color: #2e7d32; }
    .oj-bar-cache { border-bottom-color: #c8a800; }
    .oj-bar-offline { border-bottom-color: #d9822b; color: #b35c00; font-weight: 600; }
    .oj-bar-error { border-bottom-color: #c62828; color: #c62828; font-weight: 600; }
    .oj-bar-right { display: flex; align-items: center; gap: 8px; }
    .oj-bar button {
      font: inherit; font-size: 11px; padding: 2px 10px; cursor: pointer;
      border: 1px solid var(--vscode-button-border, #ccc); border-radius: 3px;
      background: var(--vscode-button-secondaryBackground, #f0f0f0);
      color: var(--vscode-button-secondaryForeground, #333);
    }
    .oj-bar button:hover { background: var(--vscode-button-secondaryHoverBackground, #e0e0e0); }
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
    <span id="ojBarText">${this.escapeHtml(banner)}</span>
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

  private escapeHtml(text: string): string {
    return (text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
