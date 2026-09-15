import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as nodePath from 'path';
import {
  CachePaths, ContestPaths, ContestMeta, CacheIndex, ProblemMetaEntry,
  sanitizePid, contestDirName, metaMatchesBaseUrl, assetFileName,
} from './paths';
import { nameKey, problemDirName, problemName, slugify } from '../utils/slug';
import { isCacheEnabled, isOfflineMode, getCacheTtlMs, getBaseUrl } from '../utils/config';
import { CacheStat, computeStat } from './freshness';

/**
 * 【缓存层 · 存储】
 *
 * 唯一负责「读写缓存产物」的模块。
 *
 * ## 只存原始信息
 *
 * `write*` 一律只接收**来自站点的原始内容**：页面 HTML / 图片二进制 / 样例文本。
 * 结构化对象（题目详情、状态记录、比赛列表）**不进缓存** —— 读取方拿到原始 HTML 后
 * 自行解析（`utils/parser.ts`）。详见 `cache/paths.ts` 顶部的原则说明。
 *
 * 唯一的非站点产物是 `meta.json`，它是插件自身的元信息。
 *
 * ## 目录归属
 *
 * - **比赛项目文件夹**建在工作区根目录下、**可见**（`<cid>-<标题>`），可直接当项目打开 / git；
 * - **比赛列表缓存**这类没有比赛归属的内部数据留在 `.vsoj/` 里。
 *
 * 因此「定位比赛目录」从「扫 `.vsoj/contests/`」变成「按索引 + 扫工作区根」——
 * 工作区根可能有任意多的无关目录，扫描时**只认带合法 `meta.json` 的目录**。
 *
 * ## 题目索引（为什么不能拿序号当身份）
 *
 * `meta.json.problems` 是「身份 → 目录」的映射，身份的推导与对齐见文件末尾的
 * {@link alignProblems}。命门是**位置不能当身份**：站点往题集中间插题 / 删题之后，
 * 比赛内序号（`pid`）上的题目会换人、后续题目整体平移；一旦拿序号做持久化的键，
 * 题面 / 样例 / 图片 / 用户源码 / 测试历史会集体错位，症状就是"打开甲题看到乙题的题面、
 * 提交时把甲的代码交到乙题"。
 *
 * 所以每次拿到题目列表（{@link CacheStore.syncProblemIndex}）都按身份与本地目录重新对齐：
 * 同一道题继续用它的目录，新题新建目录，站点上消失的题保留目录（用户源码不可再生）。
 *
 * ## 读语义
 *
 * - 默认 `read*` 只返回**新鲜**（TTL 内）的内容；过期视为未命中
 * - `allowStale: true` 或 `oj.cache.offline = true` 时允许返回过期内容（离线预览）
 * - 需要「知道有多旧」时用 {@link statCached}
 *
 * ## 失败语义
 *
 * 所有失败都**不抛异常**（缓存是增强，不是前提），返回 undefined / false。
 */
export class CacheStore {
  private paths: CachePaths;
  private context: vscode.ExtensionContext;
  private rootEnsured = false;
  /**
   * cid → 目录 + `pid → 目录名` 映射的同步快照。
   *
   * 为什么需要：`CacheStore` 的公开读取接口都是异步的（要读磁盘），但
   * `initializer` 里「拼路径」的几个函数（`sourceFile` / `tempDir` / `testDir`）
   * 签名是同步的 —— 它们只是字符串拼接，不该为了拿一个目录名就变成 async。
   *
   * 一致性由写入点保证：凡是改动目录或 `meta.problems` 的地方
   * （`pathsForDir` / `ensureContestDir` / `registerProblem` / `finalizeContestTitle`）
   * 都会刷新这里；`rebind()` 会整体作废。
   */
  private contestCache = new Map<string, { dir: string; problemDirs?: Record<string, string> }>();

  constructor(context: vscode.ExtensionContext, paths?: CachePaths) {
    this.context = context;
    this.paths = paths ?? CachePaths.resolve(context);
  }

  /** 配置/工作区变化后重新解析根目录 */
  public rebind(): void {
    this.paths = CachePaths.resolve(this.context);
    this.rootEnsured = false;
    this.contestCache.clear();
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
    return this.writeRaw(file, JSON.stringify(data, null, 2));
  }

  public async readText(file: string): Promise<string | undefined> {
    try { return await fs.readFile(file, 'utf8'); } catch { return undefined; }
  }

  /** 读取二进制（图片等原始资源） */
  public async readBuffer(file: string): Promise<Buffer | undefined> {
    try { return await fs.readFile(file); } catch { return undefined; }
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

  /** 目录是否为空（不存在也算空） */
  public async isEmptyDir(dir: string): Promise<boolean> {
    try {
      const names = await fs.readdir(dir);
      return names.length === 0;
    } catch {
      return true;
    }
  }

  /**
   * 写入**用户资产**（源文件骨架等）。
   *
   * 与 `write*` 领域写不同，这里**不做 `oj.cache.enabled` 判定** ——
   * 关掉缓存只是「不存站点数据」，不应该连带阻止项目初始化生成源文件。
   */
  public async writeUserFile(file: string, data: string | Buffer): Promise<boolean> {
    return this.writeRaw(file, data);
  }

  /** 底层写文件（不做 enabled 判定，供 meta / 索引 / 用户资产使用） */
  private async writeRaw(file: string, data: string | Buffer): Promise<boolean> {
    try {
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      await fs.writeFile(file, data as any);
      return true;
    } catch (e) {
      console.warn('[OJ][cache] 写入失败:', file, e);
      return false;
    }
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
   * 缓存状态快照（供「更新于 X 分钟前」与重访决策使用）。
   * 时间基准是**文件 mtime**，即上次成功从网络同步的时间。
   */
  public async statCached(file: string): Promise<CacheStat> {
    const m = await this.mtimeMs(file);
    return computeStat(file, m, Date.now());
  }

  /** 领域读：按 TTL 判定；offline 或 allowStale 时放行过期内容 */
  private async readCachedText(file: string, opts?: { allowStale?: boolean }): Promise<string | undefined> {
    const text = await this.readText(file);
    if (text === undefined) { return undefined; }
    if (opts?.allowStale || this.offline) { return text; }
    return (await this.isFresh(file)) ? text : undefined;
  }

  /** 领域写：`oj.cache.enabled = false` 时整体跳过 */
  private async writeCachedText(file: string, text: string): Promise<boolean> {
    if (!this.enabled) { return false; }
    await this.ensureRoot();
    return this.writeRaw(file, text);
  }

  // ============================================================
  // 根目录初始化
  // ============================================================

  /** 首次写入前初始化内部数据根（写 README 说明布局，便于外部工具/AI 直接消费） */
  public async ensureRoot(): Promise<void> {
    if (this.rootEnsured) { return; }
    try {
      await fs.mkdir(this.paths.listDir, { recursive: true });
      const readme = this.paths.readme;
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
    if (idx && idx.version === 2 && idx.contests) { return idx; }
    return { version: 2, contests: {} };
  }

  private async writeIndex(idx: CacheIndex): Promise<void> {
    await this.writeJson(this.indexFile, idx);
  }

  // ============================================================
  // 比赛目录
  // ============================================================

  /** 比赛目录是否已初始化 */
  public async hasContestDir(cid: string): Promise<boolean> {
    return (await this.locateContestDir(cid)) !== undefined;
  }

  /**
   * 定位比赛目录（绝对路径）。查找优先级：
   *   1) 索引（`cache-index.json`）登记项，且目录仍存在、`meta.json` 的 cid 对得上
   *   2) 扫描**工作区根**：先精确匹配 `<cid>`，再匹配 `<cid>-*`
   *
   * 之所以要做磁盘兜底：索引位于 globalStorage，工作区可能被单独拷贝 / 清理 / 换机器，
   * 此时索引与磁盘不同步，必须以磁盘为准。
   *
   * 之所以要校验 `meta.cid`：工作区根是用户目录，`<cid>-*` 前缀命中可能是巧合
   * （如用户自己有个 `3775-notes` 目录），不能只凭目录名认亲。
   */
  private async locateContestDir(cid: string): Promise<string | undefined> {
    const idx = await this.readIndex();
    const entry = idx.contests[cid];
    if (entry) {
      const dir = nodePath.join(this.paths.projectRoot, ...entry.dir.split('/'));
      if (await this.isContestDir(dir, cid)) { return dir; }
    }

    try {
      const names = await fs.readdir(this.paths.projectRoot);
      const exact = names.find(n => n === cid);
      const prefixed = names.filter(n => n.startsWith(`${cid}-`)).sort();
      for (const name of [...(exact ? [exact] : []), ...prefixed]) {
        const dir = nodePath.join(this.paths.projectRoot, name);
        if (await this.isContestDir(dir, cid)) { return dir; }
      }
    } catch { /* ignore */ }

    return undefined;
  }

  /** 目录是否为该 cid 的比赛目录（`meta.json` 存在且 cid 一致） */
  private async isContestDir(dir: string, cid: string): Promise<boolean> {
    const meta = await this.readJson<ContestMeta>(nodePath.join(dir, 'meta.json'));
    return !!meta && String(meta.cid) === String(cid);
  }

  /** 解析比赛目录（只读；不存在则 undefined） */
  public async resolveContestDir(cid: string): Promise<ContestPaths | undefined> {
    const dir = await this.locateContestDir(cid);
    if (!dir) { return undefined; }
    return this.pathsForDir(dir);
  }

  /**
   * 由目录构造路径集合。
   *
   * 关键：读 `meta.json.problems` 得到 **pid → 目录名** 的映射后再构造，
   * 否则 `problemDir(pid)` 只能退化成数字 pid，与实际目录名不一致。
   */
  private async pathsForDir(dir: string): Promise<ContestPaths> {
    const meta = await this.readJson<ContestMeta>(nodePath.join(dir, 'meta.json'));
    const problemDirs = pidDirMap(meta);
    if (meta?.cid) {
      this.contestCache.set(String(meta.cid), { dir, problemDirs });
    }
    return this.paths.contestAt(dir, problemDirs);
  }

  /**
   * 同步取已解析的比赛路径（未解析过则 undefined）。
   *
   * 仅供「只拼路径、不需要 IO」的调用点使用；拿不到说明该比赛还没被
   * `resolveContestDir` / `ensureContestDir` 解析过，调用方应先走异步入口。
   */
  public cachedContestPaths(cid: string): ContestPaths | undefined {
    const entry = this.contestCache.get(String(cid));
    if (!entry) { return undefined; }
    return this.paths.contestAt(entry.dir, entry.problemDirs);
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
      const paths = await this.pathsForDir(existingDir);
      const meta = await this.readJson<ContestMeta>(paths.meta);
      const merged: ContestMeta = {
        cid,
        // 绝不用空标题覆盖已有标题
        title: (title || meta?.title || '').trim() || meta?.title || '',
        baseUrl: getBaseUrl(),
        createdAt: meta?.createdAt || now,
        lastSyncAt: now,
        layoutVersion: paths.layoutVersion,
        problemCount: meta?.problemCount,
        problems: meta?.problems,
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
    await this.ensureDir(paths.contestRawDir);
    const meta: ContestMeta = {
      cid,
      title: (title || '').trim(),
      baseUrl: getBaseUrl(),
      createdAt: now,
      lastSyncAt: now,
      layoutVersion: paths.layoutVersion,
      pendingTitle: !title,
    };
    await this.writeJson(paths.meta, meta);
    await this.registerIndex(cid, paths.dir, meta.title, now);
    this.contestCache.set(String(cid), { dir: paths.dir, problemDirs: undefined });
    return paths;
  }

  /**
   * 目录名定稿：仅当目录当前为纯 `<cid>`（`pendingTitle = true`）时，
   * 重命名为 `<cid>-<slug>` 并同步更新索引。目标目录已存在则放弃重命名。
   */
  public async finalizeContestTitle(cid: string, title: string): Promise<ContestPaths> {
    const currentDir = await this.locateContestDir(cid);
    if (!currentDir) { return this.ensureContestDir(cid, title); }

    const paths = await this.pathsForDir(currentDir);
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

    const finalPaths = await this.pathsForDir(finalDir);
    const merged: ContestMeta = {
      cid,
      title: cleanTitle || meta?.title || '',
      baseUrl: getBaseUrl(),
      createdAt: meta?.createdAt || now,
      lastSyncAt: now,
      layoutVersion: finalPaths.layoutVersion,
      problemCount: meta?.problemCount,
      problems: meta?.problems,
      pendingTitle: nodePath.basename(finalDir) === cid,
    };
    await this.writeJson(finalPaths.meta, merged);
    await this.registerIndex(cid, finalDir, merged.title, now);
    return finalPaths;
  }

  /** 登记 / 刷新索引中的比赛目录映射（存相对路径，避免把本机绝对路径写进工作区） */
  private async registerIndex(cid: string, dir: string, title: string, now: string): Promise<void> {
    const rel = nodePath.relative(this.paths.projectRoot, dir).split(nodePath.sep).join('/');
    const idx = await this.readIndex();
    idx.contests[cid] = { dir: rel, title, lastSyncAt: now };
    await this.writeIndex(idx);
  }

  public async readContestMeta(cid: string): Promise<ContestMeta | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    return this.readJson<ContestMeta>(paths.meta);
  }

  /**
   * 登记一道题的目录（`meta.json.problems` 是「身份 → 目录」的唯一映射来源）。
   *
   * **必须在写题目文件之前调用** —— 否则 `problemDir(pid)` 只能退化成数字 pid，
   * 等标题拿到后再改名会让已写入的 `raw/` 变成孤儿目录。
   *
   * 定位方式是**身份**（全局题号，退到目录名里的题名）而不是 `pid`：站点插入 / 删除
   * 题目会让序号整体平移，用 `pid` 定位会把新题的内容写进旧题的目录、并让旧题的内容
   * 被当成新题的缓存继续复用。命中已有条目时**只刷新位置与题名、沿用其目录名**；
   * 未命中才新起目录（避开已被占用的目录名）。
   *
   * 常态下索引已由 {@link syncProblemIndex} 建好，这里服务于「只打开单道题、
   * 没走过列表同步」的入口。
   */
  public async registerProblem(cid: string, entry: {
    pid: string; globalId?: string; title: string;
  }): Promise<ProblemMetaEntry> {
    const paths = await this.ensureContestDir(cid, '');
    const meta = (await this.readJson<ContestMeta>(paths.meta)) ?? {
      cid, title: '', baseUrl: getBaseUrl(),
      createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(),
    };

    const fresh = entryOf({ pid: String(entry.pid), title: entry.title, globalId: entry.globalId });
    const identity = fresh.identity;
    const list = meta.problems ? [...meta.problems] : [];

    // 身份优先；旧数据（没有 identity 字段）按「目录名里的题名 → 题名」兜底
    const wantKey = nameKey(entry.title);
    const i = list.findIndex(p => {
      if (p.identity && p.identity === identity) { return true; }
      if (p.globalId && entry.globalId && String(p.globalId) === String(entry.globalId)) { return true; }
      if (!wantKey) { return false; }
      return nameKey(nameFromDir(p.dir)) === wantKey || nameKey(p.title) === wantKey;
    });

    let saved: ProblemMetaEntry;
    if (i >= 0) {
      // 目录名已定稿 → 只刷新位置与题名
      saved = {
        ...list[i],
        identity,
        ...(entry.globalId ? { globalId: String(entry.globalId) } : {}),
        pid: String(entry.pid),
        letter: letterOf(entry.pid),
        title: fresh.title,
      };
      list[i] = saved;
    } else {
      const taken = new Set(list.map(p => p.dir));
      saved = { ...fresh, dir: uniqueProblemDir(fresh.dir, taken) };
      list.push(saved);
    }
    list.sort((a, b) => Number(a.pid) - Number(b.pid));

    meta.problems = list;
    meta.problemCount = list.length;
    meta.layoutVersion = paths.layoutVersion;
    meta.lastSyncAt = new Date().toISOString();
    await this.writeJson(paths.meta, meta);

    // 同步快照：新建的题目目录名要立刻能被同步入口（initializer 拼路径）看到
    this.contestCache.set(String(cid), { dir: paths.dir, problemDirs: pidDirMap(meta) });

    // 「先打开题目页、后拿到列表」会留下数字 pid 目录；把它归位到正式目录名，
    // 否则那份题面缓存与用户代码会失联（目标已存在时不动，绝不覆盖）
    const legacy = nodePath.join(paths.dir, 'problems', sanitizePid(entry.pid));
    const target = nodePath.join(paths.dir, 'problems', saved.dir);
    if (legacy !== target && (await this.exists(legacy)) && !(await this.exists(target))) {
      try { await fs.rename(legacy, target); } catch { /* ignore */ }
    }
    return saved;
  }

  /**
   * 用**题目列表**重建题目索引（对齐的唯一入口）。
   *
   * 每次拿到列表（无论来自缓存还是网络）都调一次：按身份把站点上的题与本地目录对上，
   * 同一道题继续用它的目录，新题新建，站点上消失的题保留目录但不再映射。
   * 返回对齐计划，供上层判断"题集是否发生变动"并通知用户。
   *
   * 旧条目（布局 v2 及更早）没有身份字段，且其**题名字段可能已被后来的题覆盖**
   * （同一序号换了人时题名会一起被改写），因此身份优先取**目录名里的题名** ——
   * 目录名是建目录那一刻定下的，之后不会再变。一道题在磁盘上留下多个目录时
   * （历史错位造成），按内容分量排序让「有你的源码、缓存更完整」的那个先参与匹配。
   *
   * 幂等：列表没变时结果逐字段相同，只刷新 `lastSyncAt`。
   */
  public async syncProblemIndex(cid: string, list: ProblemLike[]): Promise<AlignPlan> {
    const paths = await this.ensureContestDir(cid, '');
    const meta = (await this.readJson<ContestMeta>(paths.meta)) ?? {
      cid, title: '', baseUrl: getBaseUrl(),
      createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(),
    };

    const prev = await this.orderByContent(paths, meta.problems ?? []);
    const plan = alignProblems(prev, list);

    meta.problems = plan.entries;
    meta.problemCount = plan.entries.length;
    meta.layoutVersion = paths.layoutVersion;
    meta.lastSyncAt = new Date().toISOString();
    // 孤儿目录只登记一次，避免每轮同步重复堆积
    const known = new Set((meta.orphans ?? []).map(o => o.dir));
    const merged = [...(meta.orphans ?? [])];
    for (const o of plan.orphans) {
      if (known.has(o.dir)) { continue; }
      known.add(o.dir);
      merged.push({ dir: o.dir, ...(o.title ? { title: o.title } : {}) });
    }
    if (merged.length) { meta.orphans = merged; }
    await this.writeJson(paths.meta, meta);
    this.contestCache.set(String(cid), { dir: paths.dir, problemDirs: pidDirMap(meta) });
    return plan;
  }

  /**
   * 把旧条目按「目录内容的分量」重排：有用户源码的最重，其次有测试历史，再次有站点缓存。
   *
   * 只影响同名目录的决胜 —— 一道题在磁盘上留下多个目录时（历史错位造成），对齐只认一个，
   * 认哪个决定了用户的代码留在哪儿。有源码的目录最不该被放弃。
   */
  private async orderByContent(paths: ContestPaths, list: ProblemMetaEntry[]): Promise<ProblemMetaEntry[]> {
    if (list.length < 2) { return list; }
    const scored = await Promise.all(list.map(async (e, i) => ({
      e, i, w: await this.weighDir(nodePath.join(paths.dir, 'problems', e.dir)),
    })));
    scored.sort((a, b) => (b.w - a.w) || (a.i - b.i));
    return scored.map(x => x.e);
  }

  /**
   * 目录分量 = **用户产物的体积**（题目目录下的直接文件 + `test/` 子树）。
   *
   * 只影响同名目录的决胜：一道题在磁盘上留下多个目录时（历史错位造成）对齐只认一个，
   * 认哪个决定了用户的代码留在哪儿。骨架源文件只有百来字节，真写过的代码与测试记录
   * 都是 KB 级 —— 按体积排序就能把「用户真正动过」的那个挑出来，站点缓存不计入。
   */
  private async weighDir(dir: string): Promise<number> {
    let entries: import('fs').Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
    let total = 0;
    for (const e of entries) {
      const target = nodePath.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'test') { total += await this.treeBytes(target); }
        continue;
      }
      total += await fs.stat(target).then(s => s.size).catch(() => 0);
    }
    return total;
  }

  /** 目录树内所有文件的字节和 */
  private async treeBytes(dir: string): Promise<number> {
    let entries: import('fs').Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
    let total = 0;
    for (const e of entries) {
      const target = nodePath.join(dir, e.name);
      if (e.isDirectory()) { total += await this.treeBytes(target); continue; }
      total += await fs.stat(target).then(s => s.size).catch(() => 0);
    }
    return total;
  }

  /** `meta.json` 里该 pid 对应的题目条目 */
  public async problemEntry(cid: string, pid: string): Promise<ProblemMetaEntry | undefined> {
    const meta = await this.readContestMeta(cid);
    return (meta?.problems ?? []).find(p => String(p.pid) === String(pid));
  }

  /** 回写 meta 的同步信息（题目数量 / 时间），不覆盖已有标题 */
  public async touchContestMeta(cid: string, patch: { title?: string; problemCount?: number }): Promise<void> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return; }
    const meta = await this.readJson<ContestMeta>(paths.meta);
    if (!meta) { return; }
    if (patch.title && !meta.title) { meta.title = patch.title; }
    if (patch.problemCount !== undefined) { meta.problemCount = patch.problemCount; }
    meta.lastSyncAt = new Date().toISOString();
    await this.writeJson(paths.meta, meta);
  }

  // ============================================================
  // 比赛列表（原始 HTML）
  // ============================================================

  public async readContestListHtml(page: number, keyword?: string, opts?: { allowStale?: boolean }):
    Promise<string | undefined> {
    return this.readCachedText(this.paths.contestListFile(page, keyword), opts);
  }

  public async writeContestListHtml(page: number, keyword: string | undefined, html: string): Promise<void> {
    await this.writeCachedText(this.paths.contestListFile(page, keyword), html);
  }

  // ============================================================
  // 比赛页（题目列表来源，原始 HTML）
  // ============================================================

  public async readContestPageHtml(cid: string, opts?: { allowStale?: boolean }): Promise<string | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    return this.readCachedText(paths.contestHtml, opts);
  }

  /**
   * 落盘比赛页原始 HTML。
   *
   * `title` 用于把比赛目录名定稿为 `<cid>-<slug>`：比赛标题只存在于比赛页里，
   * 因此这里是**唯一**能把目录名定稿的写入点（其余写入点一律传空标题以复用既有目录）。
   */
  public async writeContestPageHtml(cid: string, html: string, title?: string): Promise<void> {
    const paths = await this.ensureContestDir(cid, title ?? '');
    await this.writeCachedText(paths.contestHtml, html);
  }

  // ============================================================
  // 题目页（原始 HTML）
  // ============================================================

  /**
   * 读取题目页原始 HTML（路径经 `meta.json` 的 pid → 目录映射解析）。
   *
   * 读到之后还要**核对标题**：题集被重排过时，同一序号上的题目换了人，而缓存是按序号
   * 写入的，目录里可能留着**别人的题面**。对不上就当作未命中（返回 `undefined`），
   * 上层会重新联网拉取并覆盖。题面自带题名，所以不需要额外的身份文件。
   */
  public async readProblemHtml(cid: string, pid: string, opts?: { allowStale?: boolean }):
    Promise<string | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    const html = await this.readCachedText(paths.problemHtml(pid), opts);
    if (html === undefined) { return undefined; }
    return (await this.isOwnProblem(cid, pid, html)) ? html : undefined;
  }

  /**
   * 目录里的题面是不是这道题的。
   *
   * 判据是**标题比较键**（剥掉「问题 X: 」位置前缀再压平）：题目页里写着题名，
   * `meta.json` 里也记着题名，两者对不上说明这份缓存属于别的题。任一侧拿不到题名
   * （页面没有标题、索引里没有这条记录）时放行 —— 无法判定就不误伤。
   */
  private async isOwnProblem(cid: string, pid: string, html: string): Promise<boolean> {
    const entry = await this.problemEntry(cid, pid);
    const want = nameKey(entry?.title);
    if (!want) { return true; }
    const got = nameKey(firstHeading(html));
    return !got || got === want;
  }

  public async writeProblemHtml(cid: string, pid: string, html: string): Promise<void> {
    const paths = await this.ensureContestDir(cid, '');
    await this.writeCachedText(paths.problemHtml(pid), html);
  }

  /** 题目页是否已有原始 HTML（不看新鲜度；初始化用它做「增量补齐」判定） */
  public async hasProblemHtml(cid: string, pid: string): Promise<boolean> {
    const paths = await this.resolveContestDir(cid);
    return paths ? this.exists(paths.problemHtml(pid)) : false;
  }

  /** 题目页缓存状态（供「更新于 X 分钟前」与重访决策使用） */
  public async statProblemHtml(cid: string, pid: string): Promise<CacheStat> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return computeStat('', undefined, Date.now()); }
    return this.statCached(paths.problemHtml(pid));
  }

  // ============================================================
  // 状态页（原始 HTML）
  // ============================================================

  public async readStatusHtml(cid: string, opts?: { allowStale?: boolean }): Promise<string | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    return this.readCachedText(paths.statusHtml, opts);
  }

  public async writeStatusHtml(cid: string, html: string): Promise<void> {
    const paths = await this.ensureContestDir(cid, '');
    await this.writeCachedText(paths.statusHtml, html);
  }

  // ============================================================
  // 样例数据集（原始文本）
  // ============================================================

  /** 写入样例数据集。站点固定单组样例，因此写为 1.in / 1.out；序号保留以兼容未来多组 */
  public async writeSamples(cid: string, pid: string, samples: Array<{ index?: number; input: string; output: string }>): Promise<void> {
    const paths = await this.ensureContestDir(cid, '');
    const dir = paths.samplesDir(pid);
    await this.ensureDir(dir);
    if (!this.enabled) { return; }
    let i = 0;
    for (const s of samples) {
      i += 1;
      const index = s.index ?? i;
      await this.writeRaw(CachePaths.sampleIn(dir, index), s.input ?? '');
      await this.writeRaw(CachePaths.sampleOut(dir, index), s.output ?? '');
    }
  }

  /** 读取某题全部样例数据集（离线场景下本地测试的数据来源） */
  public async readSamples(cid: string, pid: string): Promise<Array<{ index: number; input: string; output: string }>> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return []; }
    return this.readSamplesAt(paths.samplesDir(pid));
  }

  /** 由样例目录直接读取（供已持有 ContestPaths 的调用方复用，避免重复定位） */
  public async readSamplesAt(dir: string): Promise<Array<{ index: number; input: string; output: string }>> {
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

  // ============================================================
  // 题面图片（原始二进制）
  // ============================================================

  /**
   * 落盘题面图片。文件名由 URL 确定性推导（见 `paths.assetFileName`），
   * 因此渲染时用原 URL 即可反查本地文件，无需任何索引。
   */
  public async writeProblemAsset(cid: string, pid: string, url: string, data: Buffer | Uint8Array): Promise<void> {
    const paths = await this.ensureContestDir(cid, '');
    await this.writeProblemAssetAt(paths.problemAssetsDir(pid), url, data);
  }

  /** 由 assets 目录直接写入（供已持有 ContestPaths 的调用方复用） */
  public async writeProblemAssetAt(dir: string, url: string, data: Buffer | Uint8Array): Promise<void> {
    await this.ensureDir(dir);
    if (!this.enabled) { return; }
    await this.writeRaw(nodePath.join(dir, assetFileName(url)), Buffer.from(data));
  }

  /** 读取已落盘的题面图片；未缓存 → undefined（调用方决定是否联网） */
  public async readProblemAsset(cid: string, pid: string, url: string): Promise<Buffer | undefined> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return undefined; }
    return this.readBuffer(nodePath.join(paths.problemAssetsDir(pid), assetFileName(url)));
  }

  /**
   * 列出该题已落盘的图片文件名（**非空即认为已抓取过**）。
   *
   * 判据刻意只看「有没有」而不比对 URL 集合：题面图片属于「抓一次就够」的资源，
   * 逐 URL 比对只会让增量初始化在题面改动时反复重下（见 `docs/PLAN_S5.md` §5.4）。
   */
  public async listProblemAssets(cid: string, pid: string): Promise<string[]> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return []; }
    try { return await fs.readdir(paths.problemAssetsDir(pid)); } catch { return []; }
  }

  // ============================================================
  // 缓存清理
  // ============================================================

  /** 列出工作区根下所有已初始化的比赛项目（含体积统计），供清理命令 / 侧边栏使用 */
  public async listCachedContests(): Promise<CachedContestInfo[]> {
    let names: string[] = [];
    try { names = await fs.readdir(this.paths.projectRoot); } catch { return []; }

    const out: CachedContestInfo[] = [];
    for (const name of names) {
      // 跳过隐藏目录（含 .vsoj 自身）——比赛项目文件夹是可见的
      if (name.startsWith('.')) { continue; }
      const dir = nodePath.join(this.paths.projectRoot, name);
      const meta = await this.readJson<ContestMeta>(nodePath.join(dir, 'meta.json'));
      if (!meta || !meta.cid) { continue; }
      const { dataBytes, userBytes } = await this.measureContest(dir);
      out.push({
        cid: String(meta.cid),
        title: meta.title || '',
        dir,
        dirName: name,
        lastSyncAt: meta.lastSyncAt,
        problemCount: meta.problemCount,
        dataBytes,
        userBytes,
      });
    }
    return out.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  }

  /**
   * 清理单场比赛的**站点原始数据**（D18 / C12）：
   *
   *   删除 → `contest-raw/`、题目级 `raw/` + `assets/` + `samples/` + `temp/`
   *   保留 → `meta.json`、源文件（`main.cpp`）、`test/`
   *
   * 保留 `meta.json` 的原因：目录定位以它为准，删掉会导致下次进入比赛新建一个目录，
   * 使用户保留的源码与测试历史变成孤儿。保留 `test/` 的原因：它是评测历史，不可再生。
   */
  public async purgeContestData(cid: string): Promise<boolean> {
    const paths = await this.resolveContestDir(cid);
    if (!paths) { return false; }
    await this.purgeContestDir(paths);
    return true;
  }

  /** 按目录清理（供批量清理复用，避免重复定位） */
  private async purgeContestDir(paths: ContestPaths): Promise<void> {
    await this.removeRecursive(paths.contestRawDir);

    const problemsDir = nodePath.join(paths.dir, 'problems');
    let names: string[] = [];
    try { names = await fs.readdir(problemsDir); } catch { names = []; }
    for (const name of names) {
      const pdir = nodePath.join(problemsDir, name);
      await this.removeRecursive(nodePath.join(pdir, 'raw'));
      await this.removeRecursive(nodePath.join(pdir, 'assets'));
      await this.removeRecursive(nodePath.join(pdir, 'samples'));
      await this.removeRecursive(nodePath.join(pdir, 'temp'));
    }
  }

  /** 清理全部比赛的缓存数据 */
  public async purgeAllContests(): Promise<number> {
    const list = await this.listCachedContests();
    let n = 0;
    for (const c of list) {
      const paths = await this.pathsForDir(c.dir);
      await this.purgeContestDir(paths);
      n += 1;
    }
    return n;
  }

  private async removeRecursive(target: string): Promise<void> {
    try { await fs.rm(target, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /**
   * 统计比赛目录体积：
   *   userBytes = `test/` 子树 + 题目目录下的**直接文件**（源文件）
   *   dataBytes = 其余（`contest-raw/`、`raw/`、`assets/`、`samples/`、`temp/`、`meta.json`）
   */
  private async measureContest(dir: string): Promise<{ dataBytes: number; userBytes: number }> {
    let dataBytes = 0;
    let userBytes = 0;

    const problemsDir = nodePath.join(dir, 'problems');
    const walk = async (cur: string, isUser: boolean): Promise<void> => {
      let entries: import('fs').Dirent[] = [];
      try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = nodePath.join(cur, e.name);
        if (e.isDirectory()) {
          await walk(p, isUser || e.name === 'test');
        } else {
          // 用户产物 = test/ 子树内的一切 + 题目目录下的直接文件（源文件）
          const user = isUser || nodePath.dirname(cur) === problemsDir;
          const size = await fs.stat(p).then(s => s.size).catch(() => 0);
          if (user) { userBytes += size; } else { dataBytes += size; }
        }
      }
    };

    await walk(dir, false);
    return { dataBytes, userBytes };
  }
}

// ============================================================
// 题目身份与对齐（纯函数，不碰 IO）
// ============================================================

/** 站点的题目列表项（`utils/parser.ts` 的解析产物） */
export interface ProblemLike {
  pid: string;
  title: string;
  globalId?: string;
}

/** `meta.json.problems` 里的一项 —— 目录归属的唯一来源 */
export interface AlignEntry {
  /** 稳定身份：`g:<全局题号>` / `t:<题名比较键>` */
  identity: string;
  /** 站点全局题号（身份的来源，展示 / 追溯用） */
  globalId?: string;
  /** 当前在比赛内的序号（**会随题集变动**，只用于请求与展示） */
  pid: string;
  /** 当前序号对应的字母（展示用） */
  letter: string;
  /** 题目目录名（首次落盘后不再变化） */
  dir: string;
  /** 题名（已剥掉「问题 X: 」位置前缀） */
  title: string;
}

/**
 * 可作为「上一次的映射」输入的最小形状（`meta.json.problems` 的历史数据）。
 *
 * `identity` 允许缺失 —— 布局 v3 之前的条目没有这个字段，对齐时按目录名 / 题名兜底匹配。
 */
export interface PrevEntry {
  identity?: string;
  globalId?: string;
  pid: string;
  title: string;
  dir: string;
}

/** 对齐结果 */
export interface AlignPlan {
  /** 当前列表对应的完整条目（已钉住各自目录） */
  entries: AlignEntry[];
  /** 站点上新增、本地还没有目录的题 */
  added: AlignEntry[];
  /** 站点上已消失、但目录被保留的题（用户源码 / 测试历史不可再生） */
  orphans: Array<{ dir: string; title?: string }>;
  /** 序号发生变化的题（题集被插队 / 删除的痕迹，供通知文案使用） */
  moved: AlignEntry[];
  /** 命中方式统计，便于诊断 */
  matchedBy: { globalId: number; title: number; position: number; fresh: number };
}

/**
 * 由题目信息推导身份。
 *
 * 优先级：全局题号 → **目录名里的题名** → 题名字段。
 *
 * 中间那一级是给旧数据（布局 v2 及更早）用的：旧条目的 `title` 会被后来的题改写
 * （同一序号换了人时题名一起被覆盖），而**目录名不会** —— 它是建目录那一刻定下的，
 * 之后只增不改。所以判"这个目录里装的是谁"要看目录名，不能看 `title`。
 */
export function problemIdentity(src: { globalId?: string; title?: string; dir?: string }): string {
  const g = (src.globalId || '').trim();
  if (/^\d+$/.test(g)) { return `g:${g}`; }
  const fromDir = src.dir ? nameKey(nameFromDir(src.dir)) : '';
  if (fromDir && !/^\d+$/.test(fromDir)) { return `t:${fromDir}`; }
  const k = nameKey(src.title);
  return `t:${k || slugify(src.title || '', 40) || 'unknown'}`;
}

/** 目录名 → 题名（剥掉目录名的题号前缀，再剥掉题目自带的「问题 X: 」位置前缀） */
function nameFromDir(dir: string): string {
  return (dir || '')
    .replace(/^[A-Za-z]{1,3}-/, '')
    .replace(/^问题-[A-Za-z]{1,3}-/, '');
}

/** 位置序号 → 展示用字母（0→A、25→Z、26→AA） */
export function letterOf(pid: string | number): string {
  const n = typeof pid === 'number' ? pid : parseInt(String(pid), 10);
  if (!Number.isFinite(n) || n < 0) { return '?'; }
  let s = '';
  let num = Math.floor(n);
  do {
    s = String.fromCharCode(65 + (num % 26)) + s;
    num = Math.floor(num / 26) - 1;
  } while (num >= 0);
  return s;
}

/** 题目列表项 → 条目骨架（`dir` 用身份推导，匹配到旧条目时会沿用旧 `dir`） */
export function entryOf(p: ProblemLike): AlignEntry {
  const identity = problemIdentity(p);
  const title = problemName(p.title) || p.title || '';
  return {
    identity,
    ...(p.globalId ? { globalId: String(p.globalId) } : {}),
    pid: String(p.pid),
    letter: letterOf(p.pid),
    dir: problemDirName(identity, title),
    title,
  };
}

/**
 * 按身份对齐：把「站点当前的题目列表」与「本地已有的目录」对上。
 *
 * 匹配顺序（逐级降级，越靠前越可信）：
 *   1. 全局题号相同 —— 题目的真实身份（插队 / 删除 / 换位都不受影响）
 *   2. 题名相同 —— 覆盖「本地是旧数据、压根没记全局题号」的历史目录
 *      （题名取自目录名，见 {@link problemIdentity}）
 *   3. 位置配对 —— 两侧剩余数量相等时按序号一一对应（题名被改、内容被替换）
 * 前两轮都匹配不上的，才按第 3 轮处理；数量不等则如实认作「新增」与「消失」。
 *
 * 已匹配的题目**一律沿用旧目录名**（目录名定稿后不再变化），只有新增题目才新起目录。
 *
 * @param prev 旧映射。**顺序有意义**：同一道题对应多个目录时，排在前面的胜出，
 *             调用方按内容分量排序（见 `CacheStore.orderByContent`）。
 */
export function alignProblems(prev: PrevEntry[], list: ProblemLike[]): AlignPlan {
  const items = list.map(entryOf);
  const matchedBy = { globalId: 0, title: 0, position: 0, fresh: 0 };

  const usedPrev = new Set<number>();
  /** 每个列表项命中的旧条目下标（新题为 undefined） */
  const hitOf: Array<number | undefined> = items.map(() => undefined);

  // 1) 全局题号
  const byGlobalId = new Map<string, number>();
  prev.forEach((e, i) => {
    const g = (e.globalId || '').trim();
    if (g && !byGlobalId.has(g)) { byGlobalId.set(g, i); }
  });
  items.forEach((it, i) => {
    const g = (it.globalId || '').trim();
    if (!g) { return; }
    const j = byGlobalId.get(g);
    if (j !== undefined && !usedPrev.has(j)) {
      usedPrev.add(j); hitOf[i] = j; matchedBy.globalId += 1;
    }
  });

  // 2) 题名（旧数据没有全局题号时的主要依据）
  const byName = new Map<string, number>();
  prev.forEach((e, i) => {
    for (const k of entryKeys(e)) {
      if (!byName.has(k)) { byName.set(k, i); }
    }
  });
  items.forEach((it, i) => {
    if (hitOf[i] !== undefined) { return; }
    const k = nameKey(it.title);
    if (!k) { return; }
    const j = byName.get(k);
    if (j !== undefined && !usedPrev.has(j)) {
      usedPrev.add(j); hitOf[i] = j; matchedBy.title += 1;
    }
  });

  // 3) 位置配对：仅当两侧剩余数量相等（既不是插入也不是删除）
  const restItems = items.map((it, i) => ({ it, i })).filter(x => hitOf[x.i] === undefined);
  const restPrev = prev.map((e, j) => ({ e, j })).filter(x => !usedPrev.has(x.j));
  if (restItems.length > 0 && restItems.length === restPrev.length) {
    const prevByPid = new Map(restPrev.map(x => [String(x.e.pid), x] as const));
    for (const { it, i } of restItems) {
      const hit = prevByPid.get(String(it.pid));
      if (!hit) { continue; }
      usedPrev.add(hit.j); hitOf[i] = hit.j; matchedBy.position += 1;
    }
  }

  // 仍未匹配的列表项 = 新题
  const entries: AlignEntry[] = [];
  const added: AlignEntry[] = [];
  const takenDirs = new Set(prev.filter((_, j) => usedPrev.has(j)).map(e => e.dir));
  items.forEach((it, i) => {
    const j = hitOf[i];
    if (j !== undefined) { entries.push(keepDir(prev[j], it)); return; }
    matchedBy.fresh += 1;
    const fresh = { ...it, dir: uniqueProblemDir(it.dir, takenDirs) };
    takenDirs.add(fresh.dir);
    entries.push(fresh);
    added.push(fresh);
  });

  // 未被认领的旧条目 = 站点上已消失（目录保留）
  const orphans = prev
    .filter((_, j) => !usedPrev.has(j))
    .map(e => ({ dir: e.dir, ...(nameKey(e.title) ? { title: problemName(e.title) } : {}) }));

  // 序号变了的题：题集被插队 / 删除的痕迹
  const moved = entries.filter((e, i) => {
    const j = hitOf[i];
    return j !== undefined && String(prev[j].pid) !== String(e.pid);
  });

  entries.sort((a, b) => Number(a.pid) - Number(b.pid));
  return { entries, added, orphans, moved, matchedBy };
}

/** 旧条目的匹配键：目录名里的题名优先（不会被后来的题改名覆盖），再补题名字段 */
function entryKeys(e: PrevEntry): string[] {
  const out: string[] = [];
  const a = nameKey(nameFromDir(e.dir));
  const b = nameKey(e.title);
  if (a) { out.push(a); }
  if (b && b !== a) { out.push(b); }
  return out;
}

/**
 * 沿用旧目录名，只刷新位置 / 题名 / 全局题号。
 *
 * 身份以**本次列表**为准（它带全局题号）；列表这次没给出全局题号时，沿用旧条目
 * 记下的那个（`g:` 形式比题名兜底更可靠）。
 */
function keepDir(old: PrevEntry, it: AlignEntry): AlignEntry {
  const oldG = (old.identity || '').startsWith('g:') ? old.identity : undefined;
  return {
    ...it,
    dir: old.dir,
    identity: it.identity.startsWith('g:') ? it.identity : (oldG ?? it.identity),
    ...(it.globalId ? { globalId: it.globalId } : (old.globalId ? { globalId: old.globalId } : {})),
  };
}

/** 目标目录名已被占用时加后缀（同题重名，极少见） */
export function uniqueProblemDir(dir: string, taken: Set<string>): string {
  if (!taken.has(dir)) { return dir; }
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${dir}~${i}`;
    if (!taken.has(candidate)) { return candidate; }
  }
  return `${dir}~x`;
}

/** 页面 HTML 里的第一个标题（题目页的题名所在）——去掉标签与多余空白 */
function firstHeading(html: string): string {
  const m = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(html || '');
  if (!m) { return ''; }
  return m[1]
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** pid → 目录名 映射（`meta.json.problems` 的唯一消费点） */
function pidDirMap(meta: ContestMeta | undefined): Record<string, string> | undefined {
  const list = meta?.problems;
  if (!list || !list.length) { return undefined; }
  const map: Record<string, string> = {};
  for (const p of list) {
    if (p && p.pid !== undefined && p.dir) { map[String(p.pid)] = p.dir; }
  }
  return Object.keys(map).length ? map : undefined;
}

/** 已缓存比赛的信息摘要 */
export interface CachedContestInfo {
  cid: string;
  title: string;
  dir: string;
  dirName: string;
  lastSyncAt: string;
  problemCount?: number;
  /** 站点缓存数据体积（清理会释放这部分） */
  dataBytes: number;
  /** 用户产物体积（源文件与 test/，清理时保留） */
  userBytes: number;
}

/** 内部数据根 README（帮助外部工具 / AI 理解目录语义） */
const CACHE_README = `# VsOJ Pro 内部数据

本目录是插件的内部数据根，默认隐藏（\`.vsoj\`），可安全删除。

## 里面有什么

- \`lists/list-p<页码>[-kw<关键词>].html\` —— 比赛列表页的**原始 HTML** 缓存

## 不在里面

**比赛项目文件夹不在这里** —— 它们建在工作区根目录下、**可见**，形如 \`<cid>-<标题>/\`，
便于你当作普通项目打开、导出、打包或纳入 git。

## 缓存只存原始信息

缓存**只保存来自 OJ 站点的原始内容**：页面 HTML、图片二进制、样例文本。
结构化数据（题目详情、状态记录、比赛列表）**不落盘** —— 读取方拿到原始 HTML 后自行解析。
这样站点改版或解析逻辑升级后，已缓存内容会立刻生效，无需等待缓存过期。

## 比赛项目文件夹布局

\`\`\`
<cid>-<标题>/
├── meta.json                          插件元信息（唯一非站点内容）
├── contest-raw/
│   ├── contest.html                   比赛页原始 HTML（题目列表来源）
│   └── status.html                    提交状态原始 HTML
└── problems/<全局题号>-<标题>/
    ├── raw/page.html                  题目页原始 HTML
    ├── assets/<hash>-<name>.<ext>     题面图片原始二进制
    ├── samples/1.in, 1.out            原始样例文本
    ├── main.cpp                       你的代码（清理缓存时保留）
    ├── temp/                          编译产物与运行临时文件
    └── test/result.json, report.md    本地测试产物（清理缓存时保留）
\`\`\`

## 清理语义

执行「清理缓存」命令只会删除**站点原始数据**与 \`temp/\`：

- 删除：\`contest-raw/\`、\`raw/\`、\`assets/\`、\`samples/\`、\`temp/\`
- 保留：\`meta.json\`、源文件（\`main.cpp\`）、\`test/\`

插件**不会**修改你的 \`.gitignore\`，如需忽略缓存请自行调整。
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

export { metaMatchesBaseUrl, sanitizePid };
