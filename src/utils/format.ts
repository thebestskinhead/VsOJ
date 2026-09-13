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
