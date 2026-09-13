/**
 * 【资源层 · 图片本地化】
 *
 * 把题面 HTML 里的相对路径图片转成 **data URI**，使题目页在无网络时也能正常显示。
 *
 * 优先级：
 *   1. 本地缓存（`problems/<pid>/assets/`）→ 直接内联，**零网络**
 *   2. 未缓存且在线 → 抓取 → **落盘** → 内联
 *   3. 未缓存且离线 / 抓取失败 → 保留绝对 URL（webview 会尝试加载，失败则破图）
 *
 * 之所以要「落盘」：按缓存原则，图片是**原始二进制资源**，属于缓存内容。
 * 站点实测题面带图约 4%（24 道中 1 道），所以这条路径开销很小，
 * 但一旦命中就能显著改善离线体验。
 *
 * 全部依赖注入，可脱离 VS Code 单测。
 */

export interface AssetLocalizerDeps {
  /** 读本地已缓存的图片 */
  readLocal: (url: string) => Promise<Buffer | undefined>;
  /** 落盘图片（原始二进制） */
  writeLocal: (url: string, data: Buffer) => Promise<void>;
  /** 联网抓取图片 */
  fetchRemote: (url: string) => Promise<Buffer>;
  /** 是否处于离线模式（离线时不做任何网络请求） */
  isOffline: () => boolean;
  /** 站点根地址，用于把相对路径补成绝对 URL */
  baseUrl: () => string;
  log?: (msg: string) => void;
}

export interface LocalizeResult {
  html: string;
  /** 题面中出现的图片总数（去重后） */
  total: number;
  /** 成功内联为 data URI 的数量（含本地命中与新抓取） */
  inlined: number;
  /** 保留远程 URL 的数量 */
  remote: number;
}

/** 题面图片：只认站点内的**相对路径**（`/JudgeOnline/upload/...`），
 *  页脚脚本里的绝对 URL 二维码不会被误抓（该脚本在 <script> 中） */
const IMG_TAG_RE = /<img\s+[^>]*>/gi;
const IMG_SRC_IN_TAG_RE = /src=["']([^"']*)["']/i;
const IMG_SRC_RE = /<img\s+[^>]*src=["'](\/[^"']+)["'][^>]*>/gi;

/** 按扩展名推测 MIME 类型 */
export function mimeOf(url: string): string {
  const ext = (url || '').split('?')[0].split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };
  return map[ext] || 'image/png';
}

/** 收集题面中出现的所有相对路径图片 URL（去重、保持出现顺序） */
export function collectImageUrls(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of (html || '').matchAll(IMG_SRC_RE)) {
    const url = m[1];
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

export async function localizeImages(html: string, deps: AssetLocalizerDeps): Promise<LocalizeResult> {
  const urls = collectImageUrls(html);
  if (urls.length === 0) {
    return { html, total: 0, inlined: 0, remote: 0 };
  }

  const replacements = new Map<string, string>();
  let inlined = 0;
  let remote = 0;

  for (const url of urls) {
    // 1) 本地缓存优先（零网络）
    let buf = await deps.readLocal(url);
    if (buf) {
      deps.log?.(`[assets] 命中本地缓存：${url}`);
    } else if (!deps.isOffline()) {
      // 2) 在线 → 抓取并落盘
      try {
        buf = await deps.fetchRemote(url);
        await deps.writeLocal(url, buf);
        deps.log?.(`[assets] 已抓取并落盘：${url}（${buf.length} 字节）`);
      } catch (e: any) {
        deps.log?.(`[assets] 抓取失败，保留远程 URL：${url}（${e?.message ?? e}）`);
      }
    }

    if (buf) {
      replacements.set(url, `data:${mimeOf(url)};base64,${buf.toString('base64')}`);
      inlined += 1;
    } else {
      // 3) 离线且未缓存 → 绝对 URL，至少让在线时还有机会加载
      replacements.set(url, `${deps.baseUrl()}${url}`);
      remote += 1;
    }
  }

  // 只在 <img> 标签内部替换 src —— 不能对整个 HTML 做字符串替换，
  // 否则同一个 URL 出现在 <a href> 或正文文本里时会被误伤。
  const out = html.replace(IMG_TAG_RE, (tag) => {
    const m = tag.match(IMG_SRC_IN_TAG_RE);
    if (!m) { return tag; }
    const replacement = replacements.get(m[1]);
    if (!replacement) { return tag; }
    return tag.replace(m[0], `src="${replacement}"`);
  });

  return { html: out, total: urls.length, inlined, remote };
}
