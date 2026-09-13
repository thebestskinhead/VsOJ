import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as nodePath from 'path';
import {
  CachePaths, ContestPaths, ContestMeta, CacheIndex,
  sanitizePid, contestDirName, metaMatchesBaseUrl,
} from './paths';
import { isCacheEnabled, isOfflineMode, getCacheTtlMs, getBaseUrl } from '../utils/config';
import { Contest, ProblemBrief, ProblemDetail, StatusRecord, Pagination } from '../types';

/**
 * 【缓存层 · 存储】
 *
 * 唯一负责「读写缓存产物」的模块。提供：
 *  - 通用 JSON/文本 读写（含 TTL 新鲜度判定）
 *  - 领域级读写（比赛列表 / 题目列表 / 题目详情 / 状态 / 样例）
 *  - 比赛目录初始化（供 S5 工作区初始化与 S6 本地测试消费）
 *
 * 设计约定：
 *  - **写穿（write-through）**：`api/*` 拿到解析结果后调用 `write*` 落盘
 *  - **先缓存后网络**：`views/*` 调用 `read*` 命中且新鲜则不打网络
 *  - `oj.cache.offline = true` 时，所有 `read*` 允许返回**过期**数据；`write*` 仍然执行（本地测试产物需要落盘）
 *  - 所有失败都**不抛异常**（缓存是增强，不是前提），仅返回 undefined / false
 */
export class CacheStore {
  private paths: CachePaths;
  private context: vscode.ExtensionContext;
  private rootEnsured = false;

  constructor(context: vscode.ExtensionContext, paths?: CachePaths) {
    this.context = context;
    this.paths = paths ?? CachePaths.resolve(context);
  }

  /** 配置/工作区变化后重新解析根目录 */
  public rebind(): void {
    this.paths = CachePaths.resolve(this.context);
    this.rootEnsured = false;
  }

  public get layout(): CachePaths { return this.paths; }
  public get enabled(): boolean { return isCacheEnabled(); }
  public get offline(): boolean { return isOfflineMode(); }

  // ============================================================
  // 通用层
  // ============================================================

  /** 读取 JSON；文件不存在 / 解析失败 → undefined */
  public async readJson<T>(file: string): Promise<T | undefined> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  /** 写入 JSON（自动创建父目录；写失败静默） */
  public async writeJson(file: string, data: unknown): Promise<boolean> {
    try {
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.warn('[OJ][cache] 写入失败:', file, e);
      return false;
    }
  }

  public async readText(file: string): Promise<string | undefined> {
    try { return await fs.readFile(file, 'utf8'); } catch { return undefined; }
  }

  public async writeText(file: string, text: string): Promise<boolean> {
    try {
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      await fs.writeFile(file, text, 'utf8');
      return true;
    } catch (e) {
      console.warn('[OJ][cache] 写入失败:', file, e);
      return false;
    }
  }

  public async exists(target: string): Promise<boolean> {
    try { await fs.access(target); return true; } catch { return false; }
  }

  public async mtimeMs(target: string): Promise<number | undefined> {
    try { return (await fs.stat(target)).mtimeMs; } catch { return undefined; }
  }

  public async ensureDir(dir: string): Promise<void> {
    try { await fs.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
  }

  /** 文件是否在 TTL 内（ttlMs < 0 视为永不过期） */
  public async isFresh(file: string, ttlMs?: number): Promise<boolean> {
    const ttl = ttlMs ?? getCacheTtlMs();
    if (ttl < 0) { return await this.exists(file); }
    const m = await this.mtimeMs(file);
    if (m === undefined) { return false; }
    return Date.now() - m < ttl;
  }

  /**
   * 领域统一读取入口：命中且新鲜 → 返回数据
   *  - `offline = true`：跳过新鲜度要求，有文件就返回
   *  - `allowStale = true`：返回过期数据（调用方可自行降级展示）
   */
  private async readCached<T>(file: string, opts?: { allowStale?: boolean }): Promise<T | undefined> {
    const data = await this.readJson<T>(file);
    if (data === undefined) { return undefined; }
    if (opts?.allowStale || this.offline) { return data; }
    return (await this.isFresh(file)) ? data : undefined;
  }

  /** 领域统一写入入口：`oj.cache.enabled = false` 时跳过 */
  private async writeCached(file: string, data: unknown): Promise<boolean> {
    if (!this.enabled) { return false; }
    await this.ensureRoot();
    return this.writeJson(file, data);
  }

  // ============================================================
  // 根目录初始化
  // ============================================================

  /** 首次写入前初始化缓存根（写 README 说明布局，便于外部工具/AI 直接消费） */
  public async ensureRoot(): Promise<void> {
    if (this.rootEnsured) { return; }
    try {
      await fs.mkdir(nodePath.join(this.paths.rootDir, 'contests'), { recursive: true });
      const readme = nodePath.join(this.paths.rootDir, 'README.md');
      if (!(await this.exists(readme))) {
        await fs.writeFile(readme, CACHE_README, 'utf8');
      }
      this.rootEnsured = true;
    } catch (e) {
      console.warn('[OJ][cache] 初始化缓存根失败:', e);
    }
  }

  // ============================================================
  // 缓存索引（全局 → 工作区映射）
  // ============================================================

  private get indexFile(): string {
    return nodePath.join(this.context.globalStorageUri.fsPath, 'cache-index.json');
  }

  public async readIndex(): Promise<CacheIndex> {
    const idx = await this.readJson<CacheIndex>(this.indexFile);
    if (idx && idx.version === 1 && idx.contests) { return idx; }
    return { version: 1, contests: {} };
  }

  private async writeIndex(idx: CacheIndex): Promise<void> {
    await this.writeJson(this.indexFile, idx);
  }

  // ============================================================
  // 比赛
  // ============================================================

  /** 比赛目录是否已初始化 */
  public async hasContestDir(cid: string): Promise<boolean> {
    return (await this.locateContestDir(cid)) !== undefined;
  }

  /**
   * 定位比赛目录（绝对路径）。查找优先级：
   *   1) 索引（`cache-index.json`）登记项，且目录仍存在
   *   2) 磁盘扫描 `contests/`：先精确匹配 `<cid>`，再匹配 `<cid>-*`
   *
   * 之所以要做磁盘兜底：索引位于 globalStorage，工作区可能被单独拷贝/清理，
   * 此时索引与磁盘不同步，必须以磁盘为准。
   */
  private async locateContestDir(cid: string): Promise<string | undefined> {
    const base = nodePath.join(this.paths.rootDir, 'contests');

    const idx = await this.readIndex();
    const entry = idx.contests[cid];
    if (entry) {
      const dir = nodePath.join(this.paths.rootDir, ...entry.dir.split('/'));
      if (await this.exists(nodePath.join(dir, 'meta.json'))) { return dir; }
    }

    try {
      const names = await fs.readdir(base);
      const exact = names.find(n => n === cid);
      const prefixed = names.filter(n => n.startsWith(`${cid}-`)).sort();
      for (const name of [...(exact ? [exact] : []), ...prefixed]) {
        const dir = nodePath.join(base, name);
        if (await this.exists(nodePath.join(dir, 'meta.json'))) { return dir; }
      }
    } catch { /* ignore */ }

    return undefined;
  }

  /** 解析比赛目录（只读；不存在则 undefined） */
  public async resolveContestDir(cid: string): Promise<ContestPaths | undefined> {
    const dir = await this.locateContestDir(cid);
    return dir ? this.contestPathsFromDir(dir) : undefined;
  }

  private contestPathsFromDir(dir: string): ContestPaths {
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

  /**
   * 初始化（或复用）比赛目录，并登记索引。
   *
   * **目录名一旦确定不再变化**：首次落盘时用 `<cid>-<slug(标题)>`；
   * 若首次落盘时尚无标题，则先建为纯 `<cid>` 目录并标记 `pendingTitle`，
   * 待后续拿到标题时由 {@link finalizeContestTitle} 重命名一次。
   *
   * 这样可避免「同一 cid 因不同调用点传入不同/缺失标题而派生出多个目录」。
   */
  public async ensureContestDir(cid: string, title: string): Promise<ContestPaths> {
    if (!this.enabled) { return this.paths.contest(cid, title); }

    await this.ensureRoot();
    const now = new Date().toISOString();

    const existingDir = await this.locateContestDir(cid);
    if (existingDir) {
      const paths = this.contestPathsFromDir(existingDir);
      const meta = await this.readJson<ContestMeta>(paths.meta);
      const merged: ContestMeta = {
        cid,
        // 绝不用空标题覆盖已有标题
        title: (title || meta?.title || '').trim() || meta?.title || '',
        baseUrl: getBaseUrl(),
        createdAt: meta?.createdAt || now,
        lastSyncAt: now,
        problemCount: meta?.problemCount,
        pendingTitle: meta?.pendingTitle,
      };
      if (merged.title && merged.pendingTitle) {
        // 标题补齐 → 定稿目录名
        return this.finalizeContestTitle(cid, merged.title);
      }
      await this.writeJson(paths.meta, merged);
      await this.registerIndex(cid, paths.dir, merged.title, now);
      return paths;
    }

    // 全新创建
    const paths = this.paths.contest(cid, title);
    await this.ensureDir(paths.dir);
    await this.ensureDir(paths.assetsDir);
    const meta: ContestMeta = {
      cid,
      title: (title || '').trim(),
      baseUrl: getBaseUrl(),
      createdAt: now,
      lastSyncAt: now,
      pendingTitle: !title,
    };
    await this.writeJson(paths.meta, meta);
    await this.registerIndex(cid, paths.dir, meta.title, now);
    return paths;
  }

  /**
   * 目录名定稿：仅当目录当前为纯 `<cid>`（`pendingTitle = true`）时，
   * 重命名为 `<cid>-<slug>` 并同步更新索引。目标目录已存在则放弃重命名。
   */
  public async finalizeContestTitle(cid: string, title: string): Promise<ContestPaths> {
    const currentDir = await this.locateContestDir(cid);
    if (!currentDir) { return this.ensureContestDir(cid, title); }

    const paths = this.contestPathsFromDir(currentDir);
    const meta = await this.readJson<ContestMeta>(paths.meta);
    const cleanTitle = (title || '').trim();
    const now = new Date().toISOString();

    const shouldRename = !!cleanTitle
      && meta?.pendingTitle === true
      && nodePath.basename(currentDir) === cid;

    let finalDir = currentDir;
    if (shouldRename) {
      const target = nodePath.join(nodePath.dirname(currentDir), contestDirName(cid, cleanTitle));
      if (target !== currentDir && !(await this.exists(target))) {
        try {
          await fs.rename(currentDir, target);
          finalDir = target;
        } catch (e) {
          console.warn('[OJ][cache] 比赛目录重命名失败，保持原名:', e);
        }
      }
    }

    const finalPaths = this.contestPathsFromDir(finalDir);
    const merged: ContestMeta = {
      cid,
      title: cleanTitle || meta?.title || '',
      baseUrl: getBaseUrl(),
      createdAt: meta?.createdAt || now,
      lastSyncAt: now,
      problemCount: meta?.problemCount,
      pendingTitle: nodePath.basename(finalDir) === cid,
    };
    await this.writeJson(finalPaths.meta, merged);
    await this.registerIndex(cid, finalDir, merged.title, now);
    return finalPaths;
  }

  /** 登记 / 刷新索引中的比赛目录映射（存相对路径，避免把本机绝对路径写进工作区） */
  private async registerIndex(cid: string, dir: string, title: string, now: string): Promise<void> {
    const rel = nodePath.relative(this.paths.rootDir, dir).split(nodePath.sep).join('/');
    const idx = await this.readIndex();
    idx.contests[cid] = { dir: rel, title, lastSyncAt: now };
    await this.writeIndex(idx);
  }

  public async readContestMeta(cid: string): Promise<ContestMeta | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    return this.readJson<ContestMeta>(paths.meta);
  }

  // ============================================================
  // 比赛列表
  // ============================================================

  public async readContestList(page: number, keyword?: string, opts?: { allowStale?: boolean }):
    Promise<{ rows: Contest[]; pagination: Pagination } | undefined> {
    return this.readCached(this.paths.contestListFile(page, keyword), opts);
  }

  public async writeContestList(page: number, keyword: string | undefined,
    data: { rows: Contest[]; pagination: Pagination }): Promise<void> {
    await this.writeCached(this.paths.contestListFile(page, keyword), data);
  }

  // ============================================================
  // 题目列表
  // ============================================================

  public async readProblemList(cid: string, opts?: { allowStale?: boolean }):
    Promise<{ title: string; problems: ProblemBrief[] } | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    return this.readCached(paths.problemsIndex, opts);
  }

  public async writeProblemList(cid: string, title: string, problems: ProblemBrief[]): Promise<void> {
    // 只有这里知道「比赛标题」，目录名在此定稿；其余写入点一律传空标题以复用既有目录
    const paths = await this.ensureContestDir(cid, title);
    await this.writeCached(paths.problemsIndex, { title, problems });
    const meta = await this.readJson<ContestMeta>(paths.meta);
    if (meta) {
      if (!meta.title && title) { meta.title = title; }
      meta.problemCount = problems.length;
      meta.lastSyncAt = new Date().toISOString();
      await this.writeJson(paths.meta, meta);
    }
  }

  // ============================================================
  // 题目详情
  // ============================================================

  public async readProblem(cid: string, pid: string, opts?: { allowStale?: boolean }):
    Promise<ProblemDetail | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    return this.readCached<ProblemDetail>(paths.problemJson(pid), opts);
  }

  public async writeProblem(detail: ProblemDetail): Promise<void> {
    // 注意：detail.title 是**题目**标题，不是比赛标题，绝不可用于推导比赛目录名
    const paths = await this.ensureContestDir(detail.cid, '');
    await this.writeCached(paths.problemJson(detail.pid), detail);
    await this.writeTextIfEnabled(paths.problemMd(detail.pid), problemToMarkdown(detail));
  }

  private async writeTextIfEnabled(file: string, text: string): Promise<void> {
    if (!this.enabled) { return; }
    await this.ensureRoot();
    await this.writeText(file, text);
  }

  // ============================================================
  // 状态
  // ============================================================

  public async readStatus(cid: string, opts?: { allowStale?: boolean }): Promise<StatusRecord[] | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    return this.readCached<StatusRecord[]>(paths.status, opts);
  }

  public async writeStatus(cid: string, records: StatusRecord[]): Promise<void> {
    const paths = await this.ensureContestDir(cid, '');
    await this.writeCached(paths.status, records);
  }

  // ============================================================
  // 样例数据集
  // ============================================================

  /** 写入第 index 组样例（index 从 1 开始） */
  public async writeSample(cid: string, pid: string, index: number, input: string, output: string): Promise<void> {
    const paths = await this.ensureContestDir(cid, '');
    const dir = paths.samplesDir(pid);
    await this.ensureDir(dir);
    if (!this.enabled) { return; }
    await this.writeText(CachePaths.sampleIn(dir, index), input);
    await this.writeText(CachePaths.sampleOut(dir, index), output);
  }

  /** 读取某题全部样例数据集 */
  public async readSamples(cid: string, pid: string): Promise<Array<{ index: number; input: string; output: string }>> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return []; }
    const dir = paths.samplesDir(pid);
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { return []; }

    const indexes = names
      .filter(n => n.endsWith('.in'))
      .map(n => parseInt(n.replace(/\.in$/, ''), 10))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);

    const out: Array<{ index: number; input: string; output: string }> = [];
    for (const i of indexes) {
      const input = (await this.readText(CachePaths.sampleIn(dir, i))) ?? '';
      const output = (await this.readText(CachePaths.sampleOut(dir, i))) ?? '';
      out.push({ index: i, input, output });
    }
    return out;
  }
}

/** 题面 → Markdown（供 AI / MCP 直接阅读，S6 起被 MCP 工具引用） */
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
  ];
  return lines.join('\n');
}

/** 缓存根 README（帮助外部工具 / AI 理解目录语义） */
const CACHE_README = `# VsOJ Pro 本地缓存

本目录由 VsOJ Pro 插件自动生成与维护，用于：

- 缓存比赛 / 题目 / 提交状态，支持离线浏览
- 为「一键本地测试」提供样例数据集
- 为 AI Agent（MCP）提供结构化题面与资源

## 布局

\`\`\`
contests.json                       比赛列表缓存（按页/关键词分片）
contests/<cid>-<标题>/
├── meta.json                       比赛元信息
├── problems.json                   题目列表
├── status.json                     提交状态缓存
├── assets/                         比赛级资源（题面图片等）
└── problems/<pid>/
    ├── problem.json                结构化题目详情
    ├── problem.md                  题面 Markdown（供 AI 阅读）
    ├── code/                       用户代码 / 编译产物
    ├── samples/1.in, 1.out ...     样例数据集
    └── test/result.json            本地测试结果
\`\`\`

## 说明

- 可安全删除：删除后插件会自动重建。
- 如需纳入版本管理请自行调整 \`<workspace>/.gitignore\`，插件不会修改你的 \`.gitignore\`。
- 缓存根目录可通过 VS Code 设置 \`oj.workspace.root\` 修改。
`;

/** 便捷单例访问（延迟初始化，配置变更时调用 rebind） */
let storeSingleton: CacheStore | undefined;

export function initCacheStore(context: vscode.ExtensionContext): CacheStore {
  storeSingleton = new CacheStore(context);
  return storeSingleton;
}

export function cacheStore(): CacheStore | undefined {
  return storeSingleton;
}

export { metaMatchesBaseUrl };
