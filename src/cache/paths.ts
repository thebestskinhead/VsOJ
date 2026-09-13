import * as vscode from 'vscode';
import * as nodePath from 'path';
import { getWorkspaceRootName, getBaseUrl } from '../utils/config';

/**
 * 【缓存层 · 路径】
 *
 * 唯一负责「缓存产物放在哪、叫什么名字」的模块。
 * 其它任何层（api / views / mcp / test）都不允许自行拼接缓存路径。
 *
 * 布局：
 *   <workspaceFolder>/<root>/                     ← 工作区级（可被外部工具 / AI / git 直接消费）
 *   ├── README.md                                 布局说明（首次初始化写入）
 *   ├── contests/list-p<页码>[-kw<关键词>].json     比赛列表缓存（按页/关键词分片）
 *   └── contests/<cid>-<slug>/                    每场比赛一个目录
 *       ├── meta.json                             cid / title / baseUrl / 时间戳
 *       ├── problems.json                         题目列表
 *       ├── status.json                           提交状态缓存
 *       ├── assets/                               比赛级资源（题面图片等）
 *       └── problems/<pid>/
 *           ├── problem.json                      结构化题目详情
 *           ├── problem.md                        题面 markdown（供 AI 阅读）
 *           ├── code/                             用户代码 / 编译产物（由本地测试层使用）
 *           └── samples/
 *               ├── 1.in / 1.out                  样例数据集
 *               └── ...
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

/** 比赛目录内的子路径集合 */
export interface ContestPaths {
  /** 比赛目录绝对路径 */
  dir: string;
  meta: string;
  problemsIndex: string;
  status: string;
  assetsDir: string;
  /** 题目目录绝对路径 */
  problemDir(pid: string): string;
  problemJson(pid: string): string;
  problemMd(pid: string): string;
  codeDir(pid: string): string;
  samplesDir(pid: string): string;
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

  /** 按当前配置重新解析（工作区切换 / 配置变更后调用） */
  public static revalidate(context: vscode.ExtensionContext, prev?: CachePaths): CachePaths {
    const next = CachePaths.resolve(context);
    void prev;
    return next;
  }

  /** 比赛列表缓存文件（按页与关键词分片） */
  public contestListFile(page: number, keyword?: string): string {
    const kw = keyword ? `-kw${slugify(keyword, 24) || 'x'}` : '';
    return nodePath.join(this.rootDir, 'contests', `list-p${page}${kw}.json`);
  }

  /** 比赛目录路径集合 */
  public contest(cid: string, title?: string): ContestPaths {
    const dir = nodePath.join(this.rootDir, 'contests', contestDirName(cid, title));
    const problemDir = (pid: string) => nodePath.join(dir, 'problems', sanitizePid(pid));
    return {
      dir,
      meta: nodePath.join(dir, 'meta.json'),
      problemsIndex: nodePath.join(dir, 'problems.json'),
      status: nodePath.join(dir, 'status.json'),
      assetsDir: nodePath.join(dir, 'assets'),
      problemDir,
      problemJson: (pid: string) => nodePath.join(problemDir(pid), 'problem.json'),
      problemMd: (pid: string) => nodePath.join(problemDir(pid), 'problem.md'),
      codeDir: (pid: string) => nodePath.join(problemDir(pid), 'code'),
      samplesDir: (pid: string) => nodePath.join(problemDir(pid), 'samples'),
    };
  }

  /** 样例数据集文件（序号从 1 开始） */
  public static sampleIn(samplesDir: string, index: number): string {
    return nodePath.join(samplesDir, `${index}.in`);
  }

  public static sampleOut(samplesDir: string, index: number): string {
    return nodePath.join(samplesDir, `${index}.out`);
  }

  /** 本地测试结果文件 */
  public static resultJson(problemDir: string): string {
    return nodePath.join(problemDir, 'test', 'result.json');
  }

  public static reportMd(problemDir: string): string {
    return nodePath.join(problemDir, 'test', 'report.md');
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
