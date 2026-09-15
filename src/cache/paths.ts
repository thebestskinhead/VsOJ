import * as vscode from 'vscode';
import * as nodePath from 'path';
import { getWorkspaceRootName, getBaseUrl } from '../utils/config';
import {
  slugify, sanitizePid, contestDirName, problemDirName, assetFileName, LAYOUT_VERSION,
} from '../utils/slug';

// 命名规则集中在 `utils/slug.ts`（纯函数，不依赖 VS Code），此处再导出以保持既有调用点
export { slugify, sanitizePid, contestDirName, problemDirName, assetFileName, LAYOUT_VERSION };

/**
 * 【缓存层 · 路径】
 *
 * 唯一负责「产物放在哪、叫什么名字」的模块。
 * 其它任何层（api / views / webview / mcp / test）都不允许自行拼接路径。
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
 * 唯一例外是 `meta.json` —— 它是插件自身的元信息（cid / 标题 / 题目索引 / 时间戳），
 * 不是站点内容的拆解产物，必须保留。
 *
 * ## 布局（layoutVersion = 3）
 *
 * 「比赛项目文件夹」直接建在**工作区根目录下、可见**，便于当作普通项目打开、
 * 导出、打包、纳入 git；插件的内部数据（比赛列表缓存、修复备份）留在隐藏的 `.vsoj/` 里。
 *
 *   <workspaceFolder>/
 *   ├── <oj.workspace.root>/                       内部数据根（默认 .vsoj，隐藏）
 *   │   ├── README.md                              布局说明（首次初始化写入）
 *   │   └── lists/list-p<页码>[-kw<词>].html       比赛列表页原始 HTML
 *   └── <cid>-<标题slug>/                           比赛项目文件夹（可见）
 *       ├── meta.json                              插件元信息（唯一非站点内容）
 *       ├── contest-raw/
 *       │   ├── contest.html                       比赛页原始 HTML（题目列表来源）
 *       │   └── status.html                        状态页原始 HTML
 *       └── problems/<目录名>/
 *           ├── raw/page.html                      题目页原始 HTML
 *           ├── assets/<hash>-<name>.<ext>         题面图片原始二进制
 *           ├── samples/1.in, 1.out                原始样例文本
 *           ├── <源文件名>                          用户源码（默认 main.cpp）
 *           ├── test/result.json, report.md        本地测试产物
 *           └── temp/                              编译产物 + 运行临时文件
 *
 * 目录名只是**标签**：某道题的缓存放在哪个目录，由 `meta.json.problems` 里
 * 「身份 → 目录」的映射决定（读题目文件一律经该映射解析）。新目录按
 * `<全局题号>-<题名slug>` 命名 —— 全局题号与位置无关，题集插入 / 删除题目时
 * 名字不必跟着改；历史目录保持原名不动即可。
 *
 * ## 清理语义
 *
 * 清理缓存删除「可重新获取」的部分，保留「不可再生」的部分：
 *   删除 → contest-raw/、raw/、assets/、samples/、temp/
 *   保留 → meta.json、源文件、test/
 */

/** 默认源文件名（可通过 `oj.project.sourceFileName` 修改） */
export const DEFAULT_SOURCE_FILE = 'main.cpp';

/** 比赛目录内的子路径集合 */
export interface ContestPaths {
  /** 比赛目录绝对路径 */
  dir: string;
  /** 该目录所用的布局版本（写入 meta.json，便于识别历史遗留目录） */
  layoutVersion: number;
  /** 插件元信息（唯一保留的非站点内容） */
  meta: string;
  /** 比赛级原始响应目录 */
  contestRawDir: string;
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
  /** 用户源文件路径（清理缓存时保留，已存在则永不覆盖） */
  mainSource(pid: string, fileName?: string): string;
  /** 编译产物 + 运行临时文件目录（清理缓存时删除） */
  tempDir(pid: string): string;
  /** 本地测试产物目录（清理缓存时保留） */
  testDir(pid: string): string;
  /** 本地测试结果文件 */
  testResult(pid: string): string;
  /** 本地测试报告文件 */
  testReport(pid: string): string;
}

/** 路径解析与布局计算 */
export class CachePaths {
  /** 比赛项目文件夹的父目录（工作区根） */
  public readonly projectRoot: string;
  /** 内部数据根（比赛列表缓存等） */
  public readonly rootDir: string;
  /** 是否为工作区级（true）/ 全局兜底（false） */
  public readonly inWorkspace: boolean;

  private constructor(projectRoot: string, rootDir: string, inWorkspace: boolean) {
    this.projectRoot = projectRoot;
    this.rootDir = rootDir;
    this.inWorkspace = inWorkspace;
  }

  /**
   * 解析路径根：
   * 1) 有 `file:` 工作区 → projectRoot = 工作区根，rootDir = `<工作区根>/<oj.workspace.root>`
   * 2) 无工作区（或非 file scheme）→ 全部退化到 `<globalStorage>` 下
   *
   * 之所以坚持真实 OS 路径而非 `workspace.fs` 虚拟路径：
   * 消费者包含 MCP / AI / 外部本地测试脚本，它们需要真实路径。
   *
   * 注：真实使用中「无工作区」由 `workspace/guard.ts` 拦截（用户必须先打开文件夹）；
   * 这里的兜底主要服务于脱离 VS Code 的自动化测试。
   */
  public static resolve(context: vscode.ExtensionContext): CachePaths {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder && folder.uri.scheme === 'file') {
      const projectRoot = folder.uri.fsPath;
      return new CachePaths(
        projectRoot,
        nodePath.join(projectRoot, getWorkspaceRootName()),
        true,
      );
    }
    const base = context.globalStorageUri.fsPath;
    return new CachePaths(nodePath.join(base, 'project'), nodePath.join(base, 'cache'), false);
  }

  /** 内部数据根的布局说明文件 */
  public get readme(): string {
    return nodePath.join(this.rootDir, 'README.md');
  }

  /** 比赛列表缓存目录 */
  public get listDir(): string {
    return nodePath.join(this.rootDir, 'lists');
  }

  /** 比赛列表缓存文件（按页与关键词分片）— 存原始 HTML */
  public contestListFile(page: number, keyword?: string): string {
    const kw = keyword ? `-kw${slugify(keyword, 24) || 'x'}` : '';
    return nodePath.join(this.listDir, `list-p${page}${kw}.html`);
  }

  /**
   * 比赛目录路径集合。
   *
   * @param problemDirs pid → 题目目录名 的映射（来自 `meta.json`）。
   *        传入后才能把 `problemDir(pid)` 解析到实际目录名；缺失时退化为 `<pid>`
   *        （只应在尚未初始化的场景出现）。
   */
  public contest(cid: string, title?: string, problemDirs?: Record<string, string>): ContestPaths {
    return this.contestAt(nodePath.join(this.projectRoot, contestDirName(cid, title)), problemDirs);
  }

  /** 由已知的目录绝对路径构造（磁盘兜底场景复用同一套子路径规则） */
  public contestAt(dir: string, problemDirs?: Record<string, string>): ContestPaths {
    const nameOf = (pid: string) => problemDirs?.[pid] ?? sanitizePid(pid);
    const problemDir = (pid: string) => nodePath.join(dir, 'problems', nameOf(pid));
    const problemRawDir = (pid: string) => nodePath.join(problemDir(pid), 'raw');
    const tempDir = (pid: string) => nodePath.join(problemDir(pid), 'temp');
    const testDir = (pid: string) => nodePath.join(problemDir(pid), 'test');
    const contestRawDir = nodePath.join(dir, 'contest-raw');

    return {
      dir,
      layoutVersion: LAYOUT_VERSION,
      meta: nodePath.join(dir, 'meta.json'),
      contestRawDir,
      contestHtml: nodePath.join(contestRawDir, 'contest.html'),
      statusHtml: nodePath.join(contestRawDir, 'status.html'),
      problemDir,
      problemRawDir,
      problemHtml: (pid: string) => nodePath.join(problemRawDir(pid), 'page.html'),
      problemAssetsDir: (pid: string) => nodePath.join(problemDir(pid), 'assets'),
      samplesDir: (pid: string) => nodePath.join(problemDir(pid), 'samples'),
      mainSource: (pid: string, fileName?: string) =>
        nodePath.join(problemDir(pid), fileName || DEFAULT_SOURCE_FILE),
      tempDir,
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

/** 题目条目（`meta.json`）— pid ↔ 目录 的唯一映射来源 */
export interface ProblemMetaEntry {
  /**
   * 稳定身份（`g:<全局题号>` / `t:<题名比较键>`）——见 `cache/store.ts`。
   * 缺失视为旧数据（布局 v2 及更早），对齐时按**目录名里的题名**兜底匹配。
   */
  identity?: string;
  /**
   * 站点上的全局题号（如 `1722`）。身份的来源；与 `pid` 无算术关系。
   */
  globalId?: string;
  /** 比赛内序号（0 起）。**会随题集变动**，只用于拼请求 URL 与展示 */
  pid: string;
  /** 当前序号对应的字母（0→A），展示用 */
  letter: string;
  /** 题目目录名（`<全局题号>-<题名slug>`），定稿后不再变化 */
  dir: string;
  /** 题名（已剥掉「问题 X: 」位置前缀） */
  title: string;
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
  /** 布局版本；缺失视为 1（S4 及更早） */
  layoutVersion?: number;
  /** 题目数量（最近一次同步结果） */
  problemCount?: number;
  /** 题目索引：pid → 目录名 的唯一映射来源 */
  problems?: ProblemMetaEntry[];
  /**
   * 站点上已消失、但目录被保留的题（用户源码 / 测试历史不可再生，不做删除）。
   * 不参与 pid 映射，仅用于通知与追溯。
   */
  orphans?: Array<{ dir: string; title?: string; globalId?: string }>;
  /**
   * 目录名尚未定稿（创建时还没有标题，目录名为纯 cid）。
   * 后续拿到真实标题时由 `finalizeContestTitle` 重命名为 `<cid>-<slug>` 并清除此标记。
   */
  pendingTitle?: boolean;
}

/** 缓存索引（全局，记录 cid → 相对路径，避免把本机绝对路径写进工作区） */
export interface CacheIndex {
  version: 2;
  contests: Record<string, {
    /** 相对 `projectRoot` 的路径 */
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
