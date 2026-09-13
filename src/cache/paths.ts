import * as vscode from 'vscode';
import * as nodePath from 'path';
import { getWorkspaceRootName, getBaseUrl } from '../utils/config';

/**
 * 【缓存层 · 路径】
 *
 * 唯一负责「缓存产物放在哪、叫什么名字」的模块。
 * 其它任何层（api / views / webview / mcp / test）都不允许自行拼接缓存路径。
 *
 * ## 缓存内容原则（重要，勿违背）
 *
 * 缓存**只保存来自站点的原始信息**：
 *   - 原始页面 HTML（比赛列表页、比赛页、题目页、状态页）
 *   - 原始图片二进制（题面图片）
 *   - 原始样例文本（1.in / 1.out）
 *
 * **解析产物一律不落盘**。结构化对象（题目详情、状态记录、比赛列表）由消费方
 * 现场从原始 HTML 解析得到 —— 缓存不承担「拆解」职责，拆解属于 api / parser 层。
 *
 * 这样做的收益：站点改版或解析逻辑升级后，**已缓存内容立刻受益**，无需等缓存过期；
 * 也不会出现「缓存里的结构化字段与当前解析逻辑不一致」这种脏数据。
 *
 * 唯一例外是 `meta.json` —— 它是插件自身的元信息（cid / 标题 / baseUrl / 时间戳），
 * 不是站点内容的拆解产物，必须保留。
 *
 * ## 布局
 *
 *   <workspaceFolder>/<root>/                        ← 工作区级（可被外部工具 / AI / git 直接消费）
 *   ├── README.md                                    布局说明（首次初始化写入）
 *   └── contests/
 *       ├── list-p<页码>[-kw<关键词>].html           比赛列表页原始 HTML
 *       └── <cid>-<slug>/                            每场比赛一个目录
 *           ├── meta.json                            插件元信息（非站点内容）
 *           ├── raw/
 *           │   ├── contest.html                     比赛页原始 HTML（题目列表来源）
 *           │   └── status.html                      状态页原始 HTML
 *           ├── problems/<pid>/
 *           │   ├── raw/page.html                    题目页原始 HTML
 *           │   ├── assets/<hash>-<name>.<ext>       题面图片原始二进制
 *           │   └── samples/1.in, 1.out              原始样例文本
 *           ├── code/                                用户代码 / 编译产物（清理缓存时保留）
 *           └── test/                                本地测试产物（清理缓存时保留）
 */

/** 题目 ID 目录名（pid 为数字字符串，保持原样；非数字时做 slug 化） */
export function sanitizePid(pid: string): string {
  const p = (pid || '').trim();
  if (/^\d+$/.test(p)) { return p; }
  return slugify(p, 24) || '0';
}

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

/** 稳定的 8 位十六进制哈希（djb2），用于让不同 URL 的同名图片不互相覆盖 */
function hash8(text: string): string {
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

/** 比赛目录内的子路径集合 */
export interface ContestPaths {
  /** 比赛目录绝对路径 */
  dir: string;
  /** 插件元信息（唯一保留的非站点内容） */
  meta: string;
  /** 原始响应目录 */
  rawDir: string;
  /** 比赛页原始 HTML（题目列表来源） */
  contestHtml: string;
  /** 状态页原始 HTML */
  statusHtml: string;
  /** 题目目录绝对路径 */
  problemDir(pid: string): string;
  /** 题目原始响应目录 */
  problemRawDir(pid: string): string;
  /** 题目页原始 HTML */
  problemHtml(pid: string): string;
  /** 题目图片二进制目录 */
  problemAssetsDir(pid: string): string;
  /** 原始样例数据集目录 */
  samplesDir(pid: string): string;
  /** 用户代码 / 编译产物（清理缓存时保留） */
  codeDir(pid: string): string;
  /** 本地测试产物目录（清理缓存时保留） */
  testDir(pid: string): string;
  /** 本地测试结果文件 */
  testResult(pid: string): string;
  /** 本地测试报告文件 */
  testReport(pid: string): string;
}

/** 缓存根路径解析与布局计算 */
export class CachePaths {
  /** 缓存根目录绝对路径 */
  public readonly rootDir: string;
  /** 是否为工作区级（true）/ 全局兜底（false） */
  public readonly inWorkspace: boolean;

  private constructor(rootDir: string, inWorkspace: boolean) {
    this.rootDir = rootDir;
    this.inWorkspace = inWorkspace;
  }

  /**
   * 解析缓存根：
   * 1) 有 `file:` 工作区 → `<workspaceFolder>/<oj.workspace.root>`
   * 2) 无工作区（或非 file scheme）→ `<globalStorage>/cache`
   *
   * 之所以坚持真实 OS 路径而非 `workspace.fs` 虚拟路径：
   * 缓存的消费者包含 MCP / AI / 外部本地测试脚本，它们需要真实路径。
   */
  public static resolve(context: vscode.ExtensionContext): CachePaths {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder && folder.uri.scheme === 'file') {
      const rootName = getWorkspaceRootName();
      return new CachePaths(nodePath.join(folder.uri.fsPath, rootName), true);
    }
    return new CachePaths(nodePath.join(context.globalStorageUri.fsPath, 'cache'), false);
  }

  /** 比赛列表缓存文件（按页与关键词分片）— 存原始 HTML */
  public contestListFile(page: number, keyword?: string): string {
    const kw = keyword ? `-kw${slugify(keyword, 24) || 'x'}` : '';
    return nodePath.join(this.rootDir, 'contests', `list-p${page}${kw}.html`);
  }

  /** 比赛目录路径集合 */
  public contest(cid: string, title?: string): ContestPaths {
    const dir = nodePath.join(this.rootDir, 'contests', contestDirName(cid, title));
    const problemDir = (pid: string) => nodePath.join(dir, 'problems', sanitizePid(pid));
    const problemRawDir = (pid: string) => nodePath.join(problemDir(pid), 'raw');
    const testDir = (pid: string) => nodePath.join(problemDir(pid), 'test');
    return {
      dir,
      meta: nodePath.join(dir, 'meta.json'),
      rawDir: nodePath.join(dir, 'raw'),
      contestHtml: nodePath.join(dir, 'raw', 'contest.html'),
      statusHtml: nodePath.join(dir, 'raw', 'status.html'),
      problemDir,
      problemRawDir,
      problemHtml: (pid: string) => nodePath.join(problemRawDir(pid), 'page.html'),
      problemAssetsDir: (pid: string) => nodePath.join(problemDir(pid), 'assets'),
      samplesDir: (pid: string) => nodePath.join(problemDir(pid), 'samples'),
      codeDir: (pid: string) => nodePath.join(problemDir(pid), 'code'),
      testDir,
      testResult: (pid: string) => nodePath.join(testDir(pid), 'result.json'),
      testReport: (pid: string) => nodePath.join(testDir(pid), 'report.md'),
    };
  }

  /** 样例数据集文件（序号从 1 开始） */
  public static sampleIn(samplesDir: string, index: number): string {
    return nodePath.join(samplesDir, `${index}.in`);
  }

  public static sampleOut(samplesDir: string, index: number): string {
    return nodePath.join(samplesDir, `${index}.out`);
  }
}

/** 比赛元信息（`meta.json`） */
export interface ContestMeta {
  cid: string;
  title: string;
  baseUrl: string;
  /** 目录创建时间 */
  createdAt: string;
  /** 最近一次同步时间 */
  lastSyncAt: string;
  /** 题目数量（最近一次同步结果） */
  problemCount?: number;
  /**
   * 目录名尚未定稿（创建时还没有标题，目录名为纯 cid）。
   * 后续拿到真实标题时由 `finalizeContestTitle` 重命名为 `<cid>-<slug>` 并清除此标记。
   */
  pendingTitle?: boolean;
}

/** 缓存索引（全局，记录 cid → 相对路径，避免把本机绝对路径写进工作区） */
export interface CacheIndex {
  version: 1;
  contests: Record<string, {
    dir: string;
    title: string;
    lastSyncAt: string;
  }>;
}

/** 校验缓存是否属于当前 OJ 站点（baseUrl 变更时避免读入脏数据） */
export function metaMatchesBaseUrl(meta: ContestMeta | undefined): boolean {
  if (!meta) { return false; }
  return (meta.baseUrl || '') === getBaseUrl();
}
