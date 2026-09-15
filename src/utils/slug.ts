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
 *
 * 命名里唯一允许"承载身份"的只有 {@link problemDirName} 的前缀，且它取的是
 * **全局题号**（稳定）而不是位置字母（会变）——见 `cache/store.ts`。
 */

/**
 * 布局版本。改动目录结构时递增，便于识别历史遗留目录。
 *
 * 与命名规则放在同一处：版本号标记的正是「这套规则生成的目录长什么样」。
 * `cache/paths.ts` 会把它写进 `meta.json`，并再导出一份以保持既有调用点。
 */
export const LAYOUT_VERSION = 3;

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
 * 题名归一化：剥掉站点加在标题前的**位置前缀**。
 *
 * 站点在题面页把标题写成「问题 A: 复杂度分析(Ⅰ)」/「Problem A: ...」——
 * 那个字母来自题目在比赛内的**位置**，插入 / 删除题目就会整体后移并改写。
 * 凡是用来做身份比较、目录命名的地方都只取题名本身，避免把位置信息混进身份。
 */
export function problemName(text?: string): string {
  return (text || '')
    .replace(/^\s*问题\s*[A-Za-z]{1,3}\s*[:：]\s*/, '')
    .replace(/^\s*Problem\s*[A-Za-z]{1,3}\s*[:：]?\s*/i, '')
    .trim();
}

/**
 * 题名比较键：去掉「问题 X: 」的位置前缀，再抹平空白与标点。
 *
 * 目录名里的题名段与站点标题来自不同来源（前者经 `slugify` 把空白压成 `-`），
 * 直接比较必然不相等；这里统一压成同一形态，供「同一道题」的兜底匹配使用。
 */
export function nameKey(text?: string): string {
  return problemName(text)
    .replace(/[\s\-_—－·、,，.。:：;；()（）[\]【】{}<>《》"'`]/g, '')
    .toLowerCase()
    .replace(/^问题[a-z]{1,3}/, '');
}

/**
 * 题目目录名（**布局 v3**）：`<全局题号>-<题名slug>`（如 `1722-复杂度分析(Ⅰ)`）。
 *
 * 前缀取站点的**全局题号**（比赛页首格 `1722 Problem A` 里的 1722）——它与位置无关、
 * 逐题唯一、随题走，因此题目在比赛内被插队 / 删除 / 重排时，目录名**不需要跟着改**。
 * 旧布局用「位置字母」作前缀，位置一变名字立刻变成谎言（见 `cache/store.ts`）。
 *
 * `identity` 形如 `g:<全局题号>` / `t:<题名比较键>`（见 `cache/store.ts`）；
 * 没有全局题号时退化为 `t<hash8>`，同样是确定性的，改名也不会撞车。
 * 题名缺失时只留前缀。
 */
export function problemDirName(identity: string, title?: string): string {
  const m = /^g:(\d+)$/.exec(identity || '');
  const prefix = m ? m[1] : `t${hash8(identity || '')}`;
  const slug = slugify(problemName(title), 40);
  return slug ? `${prefix}-${slug}` : prefix;
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
