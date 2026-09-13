/** 通用格式化工具 */

/**
 * 数字序号 → 题号字母：0→A, 1→B, ..., 25→Z, 26→AA, ...
 *
 * 站点实测（`contest.php?cid=3775`）：比赛内 `pid` 就是 0 起序号，
 * 而表格里的题号字母正是由它推导 —— 所以目录命名可以安全地复用这个规则。
 */
export function numToLetter(n: number): string {
  if (!Number.isFinite(n) || n < 0) { return '?'; }
  let s = '';
  let num = Math.floor(n);
  do {
    s = String.fromCharCode(65 + (num % 26)) + s;
    num = Math.floor(num / 26) - 1;
  } while (num >= 0);
  return s;
}

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
