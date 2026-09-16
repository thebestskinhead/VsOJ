import { apiClient } from './client';
import { parseContestList, parseProblemList } from '../utils/parser';
import { Contest, ProblemBrief, Pagination } from '../types';
import { AuthService } from './auth';
import { CacheStore, AlignPlan, OfflineNoCacheError } from '../cache/store';
import { AccessGate, LoginRequiredError, throwIfDenied } from '../session/access';

/**
 * 比赛模块 — 比赛列表 / 题目列表。
 *
 * ## 先过闸门
 *
 * 两个方法的第一步都是 `access.check()`：未登录且不处于免登录离线态时**直接拒绝**，
 * 连缓存都不读。站点对公开比赛是免登录渲染的，所以「未登录不给看」只能在这里拦。
 *
 * ## 缓存策略
 *
 * 联网态走**同步 TTL**（`oj.cache.ttlSeconds`，默认 180s）：命中且新鲜就直接用，
 * 不发起任何请求；过期或 `force` 才联网，并**原样落盘原始 HTML**。
 * 离线态只吃缓存且允许过期内容 —— 断网时旧列表也好过一片空白。
 *
 * 拿不到又没有缓存时抛 {@link OfflineNoCacheError}，不返回空列表 ——
 * 空列表会被上层讲成「暂无比赛」，而事实是「离线拿不到」。
 *
 * 题目列表还有一个职责：**每次拿到列表都按身份重建题目索引**
 * （{@link syncIndex}）—— 这是「同一道题始终对应同一个目录」的唯一保证。
 */

export interface FetchOptions {
  /** 忽略缓存，强制联网 */
  force?: boolean;
}

/**
 * 一次取数的来源与年龄。
 *
 * 随结果一起给出，是为了让调用方能**如实说明数据是哪来的**：AI 或用户看到
 * 「本地缓存 · 3 小时前」才会知道该不该刷新，看到「无来源信息」只能靠猜。
 */
export interface FetchMeta {
  source: 'cache' | 'network';
  /** 缓存年龄（毫秒）；`source === 'network'` 时为 0 */
  ageMs: number;
}

/** 上层钩子 */
export interface ContestServiceHooks {
  /**
   * 题目索引按身份对齐后回调。
   *
   * 用途是**提示题集变动**：老师往中间插题后，后面所有题目的序号都会后移，
   * 侧边栏里的字母也跟着变；不明说会让人以为题目被换掉了。
   */
  onIndexSynced?: (cid: string, plan: AlignPlan) => void;
}

export class ContestService {
  private auth: AuthService;
  private access: AccessGate;
  private store?: CacheStore;
  private hooks?: ContestServiceHooks;

  constructor(auth: AuthService, access: AccessGate, store?: CacheStore, hooks?: ContestServiceHooks) {
    this.auth = auth;
    this.access = access;
    this.store = store;
    this.hooks = hooks;
  }

  /** 获取比赛列表 */
  async fetchList(page: number = 1, keyword?: string, opts: FetchOptions = {}):
    Promise<{ rows: Contest[]; pagination: Pagination; meta: FetchMeta }> {
    const verdict = await this.access.check('contest-list', async () =>
      (await this.store?.statContestListHtml(page, keyword))?.exists ?? false);
    throwIfDenied(verdict, 'contest-list');

    // 离线态：只吃缓存，过期内容也照给
    if (verdict.kind === 'cache') {
      const hit = await this.readListCache(page, keyword, true);
      if (hit) { return hit; }
      throw new OfflineNoCacheError('比赛列表');
    }

    // 联网态：TTL 内命中零请求
    if (this.store && !opts.force) {
      const fresh = await this.readListCache(page, keyword, false);
      if (fresh) { return fresh; }
    }

    try {
      let response;

      if (keyword) {
        const csrf = await this.auth.fetchCsrfToken();
        const formData = new URLSearchParams();
        formData.append('keyword', keyword);
        formData.append('csrf', csrf);

        response = await apiClient.post('/contest.php', formData.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }, 'contest.fetchList(search)');
      } else {
        response = await apiClient.get('/contest.php', {
          params: { page },
        }, 'contest.fetchList');
      }

      const html = typeof response.data === 'string' ? response.data : '';
      // 读时校验：站点把这次请求当成未登录处理了。这不是数据，也不许退回缓存
      if (this.access.noteResponse(html)) {
        throw new LoginRequiredError('contest-list', '登录已过期，请重新登录后继续');
      }

      await this.store?.writeContestListHtml(page, keyword, html);
      return { ...parseContestList(html), meta: { source: 'network', ageMs: 0 } };
    } catch (e: any) {
      if (e instanceof LoginRequiredError || e instanceof AccessError) { throw e; }
      // 已登录但网络不通：翻出过期缓存顶上，别让整页变成一行错误
      const stale = await this.readListCache(page, keyword, true);
      if (stale) {
        console.warn('[OJ] 比赛列表联网失败，降级使用本地缓存:', e.message);
        return stale;
      }
      console.error('[OJ] 比赛列表加载失败:', e);
      throw new Error(`加载比赛列表失败: ${e.message}`);
    }
  }

  /** 从缓存取比赛列表；`allowStale=false` 时过期视为未命中 */
  private async readListCache(
    page: number, keyword: string | undefined, allowStale: boolean,
  ): Promise<{ rows: Contest[]; pagination: Pagination; meta: FetchMeta } | undefined> {
    if (!this.store) { return undefined; }
    const html = await this.store.readContestListHtml(
      page, keyword, allowStale ? { allowStale: true } : undefined,
    );
    if (html === undefined) { return undefined; }
    const stat = await this.store.statContestListHtml(page, keyword);
    return { ...parseContestList(html), meta: { source: 'cache', ageMs: stat.ageMs ?? 0 } };
  }

  /**
   * 把最新题目列表同步进题目索引。
   *
   * 站点会往题集中间插题 / 删题，之后同一序号上的题目就换人了。索引按**身份**
   * （全局题号，退化到题名）重排，保证每道题始终指向它自己的目录；新题拿新目录，
   * 站点上消失的题保留目录（用户源码不可再生）。详见 `cache/store.ts`。
   *
   * 列表本身为空时不动索引 —— 那通常是受限页或解析失败，不能据此判定"题目都没了"。
   */
  private async syncIndex(cid: string, problems: ProblemBrief[]): Promise<void> {
    if (!this.store || problems.length === 0) { return; }
    try {
      const plan = await this.store.syncProblemIndex(cid, problems);
      this.hooks?.onIndexSynced?.(cid, plan);
    } catch (e) {
      // 索引对齐失败不该阻断看题：退化成"用现状"，题面身份校验仍会兜住错配
      console.warn('[OJ] 题目索引对齐失败:', e);
    }
  }

  /** 获取某比赛下的题目列表 */
  async fetchProblemList(cid: string, opts: FetchOptions = {}):
    Promise<{ title: string; problems: ProblemBrief[]; meta: FetchMeta }> {
    const verdict = await this.access.check('problem-list', async () =>
      (await this.store?.statContestPageHtml(cid))?.exists ?? false);
    throwIfDenied(verdict, 'problem-list');

    // 离线态：只吃缓存，解析出 0 题也照样返回（受限页就是受限页，没得挑）
    if (verdict.kind === 'cache') {
      const hit = await this.readProblemListCache(cid, true);
      if (hit) { return this.attach(cid, hit); }
      throw new OfflineNoCacheError('题目列表');
    }

    // 联网态：TTL 内且解析出题目的缓存才算命中 —— 0 题可能只是受限页，值得再确认
    if (this.store && !opts.force) {
      const fresh = await this.readProblemListCache(cid, false);
      if (fresh && fresh.problems.length > 0) { return this.attach(cid, fresh); }
    }

    try {
      const response = await apiClient.get('/contest.php', {
        params: { cid },
      }, 'contest.fetchProblemList');

      const html = typeof response.data === 'string' ? response.data : '';

      // 读时校验：登录态在本机是缓存的，服务端可能早已作废
      if (this.access.noteResponse(html)) {
        throw new LoginRequiredError('problem-list', '登录已过期，请重新登录后继续');
      }

      // 检测受限提示：比赛尚未开始 / 私有 / 未受邀 / 无权限
      // `Not Invited!` 与 `尚未开始` 为依据 docs/SITE_ANALYSIS.md §5 实测补充的信号
      if (html.includes('比赛尚未开始或私有')
        || html.includes('不能查看题目')
        || html.includes('尚未开始')
        || html.includes('Not Invited!')) {
        // 先检查登录状态是否失效
        const loggedIn = await this.auth.isLoggedIn();

        if (!loggedIn) {
          // 登录态失效 → 自动登出，清理残留状态
          await this.auth.logout();
          throw new AccessError('登录态已失效，已自动登出，请重新登录');
        } else {
          // 登录有效但无权限
          throw new AccessError('当前无权限查看该比赛，可能未开始或为私有比赛');
        }
      }

      const result = parseProblemList(html);
      result.problems.forEach(p => { p.cid = cid; });

      // 索引先按身份对齐，再落盘：目录名不随序号漂移
      await this.syncIndex(cid, result.problems);

      // 落盘原始 HTML；比赛标题只在这里能拿到，因此目录名在此定稿
      await this.store?.writeContestPageHtml(cid, html, result.title);

      return { ...result, meta: { source: 'network', ageMs: 0 } };
    } catch (e: any) {
      if (e instanceof AccessError || e instanceof LoginRequiredError) {
        throw e;
      }
      // 已登录但网络不通：翻出过期缓存顶上
      const stale = await this.readProblemListCache(cid, true);
      if (stale) {
        console.warn('[OJ] 题目列表联网失败，降级使用本地缓存:', e.message);
        return this.attach(cid, stale);
      }
      console.error('[OJ] 题目列表加载失败:', e);
      throw new Error(`加载题目列表失败: ${e.message}`);
    }
  }

  /** 从缓存取题目列表；`allowStale=false` 时过期视为未命中 */
  private async readProblemListCache(cid: string, allowStale: boolean):
    Promise<{ title: string; problems: ProblemBrief[]; meta: FetchMeta } | undefined> {
    if (!this.store) { return undefined; }
    const html = await this.store.readContestPageHtml(
      cid, allowStale ? { allowStale: true } : undefined,
    );
    if (html === undefined) { return undefined; }
    const stat = await this.store.statContestPageHtml(cid);
    return { ...parseProblemList(html), meta: { source: 'cache', ageMs: stat.ageMs ?? 0 } };
  }

  /** 补齐题目列表上的 cid 并重建索引（缓存与联网两条路都要走一遍） */
  private async attach(
    cid: string,
    result: { title: string; problems: ProblemBrief[]; meta: FetchMeta },
  ): Promise<{ title: string; problems: ProblemBrief[]; meta: FetchMeta }> {
    result.problems.forEach(p => { p.cid = cid; });
    await this.syncIndex(cid, result.problems);
    return result;
  }

  /**
   * 拉取比赛页**原始 HTML**（不走缓存、不解析、不落盘）。
   * 供刷新执行器 `cache/refresher.ts` 使用：解析与落盘由调用方按顺序完成。
   */
  async fetchProblemListRawHtml(cid: string): Promise<string> {
    const response = await apiClient.get('/contest.php', {
      params: { cid },
      headers: { 'Cache-Control': 'no-cache' },
    }, 'contest.rawProblemList');
    const html = typeof response.data === 'string' ? response.data : '';
    // 刷新是"绕过缓存取最新"，但取回登录页就不是题列表 —— 它会覆盖掉好数据
    if (this.access.noteResponse(html)) {
      throw new LoginRequiredError('problem-list', '登录已过期，刷新已中止');
    }
    return html;
  }
}

/** 权限/登录失效专用错误 */
export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}
