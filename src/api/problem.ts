import { apiClient } from './client';
import { parseProblemDetail } from '../utils/parser';
import { ProblemDetail } from '../types';
import { getBaseUrl } from '../utils/config';

/** 题目模块 — 题目详情获取与解析 */

export class ProblemService {
  /** 获取题目结构化数据 — 复用 workspace.js loadProblem */
  async fetchProblem(cid: string, pid: string): Promise<ProblemDetail> {
    try {
      const response = await apiClient.get('/problem.php', {
        params: { cid, pid },
      }, 'problem.fetchProblem');

      const html = typeof response.data === 'string' ? response.data : '';
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

  /** 将题目描述中的相对路径图片转为 base64 内联 */
  async inlineImages(htmlContent: string): Promise<string> {
    const baseUrl = getBaseUrl();
    const imgRegex = /<img\s+[^>]*src=["'](\/[^"']+)["'][^>]*>/gi;
    const matches = [...htmlContent.matchAll(imgRegex)];

    if (matches.length === 0) {
      return htmlContent;
    }

    let result = htmlContent;
    for (const match of matches) {
      const originalSrc = match[1];
      try {
        const fullUrl = originalSrc.startsWith('http') ? originalSrc : `${baseUrl}${originalSrc}`;
        const response = await apiClient.getBuffer(fullUrl, 'problem.inlineImg');
        const mimeType = this.getMimeType(originalSrc);
        const base64 = response.toString('base64');
        const dataUri = `data:${mimeType};base64,${base64}`;
        result = result.replace(match[0], match[0].replace(originalSrc, dataUri));
      } catch (e) {
        console.error(`[OJ] 图片转换失败 (${originalSrc}):`, e);
        // 优雅降级：添加占位提示
        result = result.replace(match[0], match[0].replace(originalSrc, '#') + ' <!-- 图片加载失败 -->');
      }
    }

    return result;
  }

  /** 根据文件扩展名推测 MIME 类型 */
  private getMimeType(src: string): string {
    const ext = src.split('.').pop()?.toLowerCase() || '';
    const mimeTypes: { [key: string]: string } = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
    };
    return mimeTypes[ext] || 'image/png';
  }

  /** 构建题目详情 Webview HTML */
  buildProblemHtml(detail: ProblemDetail): string {
    const baseUrl = getBaseUrl();

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
      color: #333;
      padding: 20px;
      background: #fff;
    }
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
  <h2>${this.escapeHtml(detail.title)}</h2>

  ${detail.description ? `<div class="panel">
    <div class="panel-heading">题目描述</div>
    <div class="panel-body">${detail.description}</div>
  </div>` : ''}

  ${detail.inputDesc ? `<div class="panel">
    <div class="panel-heading">输入</div>
    <div class="panel-body">${detail.inputDesc}</div>
  </div>` : ''}

  ${detail.outputDesc ? `<div class="panel">
    <div class="panel-heading">输出</div>
    <div class="panel-body">${detail.outputDesc}</div>
  </div>` : ''}

  ${detail.sampleInput ? `<div class="sample-block">
    <h4>样例输入</h4>
    <pre>${this.escapeHtml(detail.sampleInput)}</pre>
  </div>` : ''}

  ${detail.sampleOutput ? `<div class="sample-block">
    <h4>样例输出</h4>
    <pre>${this.escapeHtml(detail.sampleOutput)}</pre>
  </div>` : ''}
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
