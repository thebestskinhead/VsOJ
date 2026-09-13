/**
 * 【工具 · 命名规则】（纯函数，**不依赖 VS Code**）
 *
 * 「目录 / 文件叫什么名字」的规则集合。之所以单独成模块：
 *
 * - `cache/paths.ts`（路径布局）与 `workspace/initializer.ts`（项目初始化）都要用同一套规则，
 *   复制两份迟早会漂移；
 * - `paths.ts` 顶层 `import * as vscode`，初始化模块与单测不该被它拖进 VS Code 运行时。
 *
 * 规则一经定稿**不得随意变更** —— 目录名一旦落盘就不再变化（见 `docs/PROGRESS.md` S1 踩坑），
 * 改规则会让老目录与新推导结果对不上。`test/cache-layout.test.js` 与 `test/init.test.js`
 * 会同时校验两处调用方的一致性。
 */

/** 文件名安全化：去掉文件系统非法字符，压缩空白为 `-`，保留中英文可读性 */
export function slugify(text: string, maxLen: number = 40): string {
  const s = (text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s.length > maxLen ? s.slice(0, maxLen).replace(/-+$/, '') : s;
}

/** 比赛目录名：`<cid>-<slug>`；标题为空时退化为纯 cid */
export function contestDirName(cid: string, title?: string): string {
  const slug = slugify(title || '', 40);
  return slug ? `${cid}-${slug}` : `${cid}`;
}

/**
 * 题目目录名：`<题号字母>-<标题slug>`（如 `A-复杂度分析(Ⅰ)`）。
 *
 * 字母由 pid 确定性推导（0→A … 25→Z → 26→AA），因此命名可复现；
 * 标题为空时退化为纯字母。
 */
export function problemDirName(letter: string, title?: string): string {
  const l = slugify(letter || '', 6) || 'P';
  const slug = slugify(title || '', 40);
  return slug ? `${l}-${slug}` : l;
}

/** 题目 ID 目录名（仅在缺少 `meta.json` 映射时的兜底；数字原样保留） */
export function sanitizePid(pid: string): string {
  const p = (pid || '').trim();
  if (/^\d+$/.test(p)) { return p; }
  return slugify(p, 24) || '0';
}

/** 稳定的 8 位十六进制哈希（djb2），用于让不同 URL 的同名图片不互相覆盖 */
export function hash8(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 图片资源落盘文件名：`<hash8>-<basename>`。
 *
 * 由 URL **确定性推导**，因此不需要任何映射索引文件 —— 渲染时拿原 URL 即可算出本地文件名。
 */
export function assetFileName(url: string): string {
  const clean = (url || '').split('?')[0].split('#')[0];
  const base = clean.split('/').filter(Boolean).pop() || 'image';
  const safe = slugify(base, 60) || 'image';
  return `${hash8(clean)}-${safe}`;
}

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
