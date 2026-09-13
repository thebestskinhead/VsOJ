import { ProblemDetail } from '../types';

/**
 * 题面 → Markdown。
 *
 * 注意：这是**工具函数**，不属于缓存层 —— 按「缓存只存原始信息」的原则，
 * 本函数的结果**不落盘**（`problem.md` 已被移除），仅在需要时（AI / MCP / 复制粘贴）
 * 由调用方现场生成。
 */
export function problemToMarkdown(detail: ProblemDetail): string {
  const html2md = (html: string): string => (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines: string[] = [
    `# ${detail.title || `题目 ${detail.pid}`}`,
    '',
    `- cid: \`${detail.cid}\``,
    `- pid: \`${detail.pid}\``,
    '',
    '## 题目描述',
    '',
    html2md(detail.description) || '_（空）_',
    '',
    '## 输入',
    '',
    html2md(detail.inputDesc) || '_（空）_',
    '',
    '## 输出',
    '',
    html2md(detail.outputDesc) || '_（空）_',
    '',
  ];

  if (detail.hint) {
    lines.push('## 提示', '', html2md(detail.hint) || '_（空）_', '');
  }

  lines.push(
    '## 样例输入',
    '',
    '```text',
    detail.sampleInput ?? '',
    '```',
    '',
    '## 样例输出',
    '',
    '```text',
    detail.sampleOutput ?? '',
    '```',
    '',
  );

  return lines.join('\n');
}
