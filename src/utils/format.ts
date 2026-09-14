/** 通用格式化工具 */

/**
 * 数字序号 → 题号字母（0→A … 25→Z → 26→AA）。
 *
 * 实现已移至 `utils/slug.ts`（命名规则模块，纯函数）。此处保留再导出，
 * 以兼容既有 `from './utils/format'` 的调用点。
 */
export { numToLetter } from './slug';

/** 字节数 → 人类可读（`512 B` / `1.2 KB` / `3.4 MB` / `1.1 GB`） */
export function formatBytes(bytes: number): string {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n < 1024) { return `${Math.round(n)} B`; }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * 把任意文本转成可以安全插进 HTML 的片段（`&` `<` `>` `"` 四个字符）。
 *
 * **只此一份**：题目页、提交结果页、本地测试结果页都要把「站点来的 / 用户产的」
 * 文本插进自绘页面，各写一份迟早会在「谁多转义了一个引号」上分叉 ——
 * 而这类分叉在浅色主题下肉眼看不出来，只会变成 XSS。
 */
export function escapeHtml(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
