import { apiClient } from './client';
import { parseContestList, parseProblemList } from '../utils/parser';
import { Contest, ProblemBrief, Pagination } from '../types';
import { AuthService } from './auth';
import { CacheStore, AlignPlan, OfflineNoCacheError } from '../cache/store';

/**
 * 比赛模块 — 比赛列表 / 题目列表。
 *
 * 缓存策略（见 docs/PLAN_S4.md §4.1）：列表走**同步 TTL**
 * （`oj.cache.ttlSeconds`，默认 180s）—— 命中且新鲜就直接用，不发起任何请求；
 * 过期或 `force` 才联网，并**原样落盘原始 HTML**。
 *
 * `oj.cache.offline = true` 时完全跳过网络，只能吃缓存；**连缓存都没有则抛
 * {@link OfflineNoCacheError}**，不返回空列表 —— 空列表会被上层讲成「暂无比赛」，
 * 而事实是「离线拿不到」，两者必须分开（见 `cache/store.ts` 的失败语义）。
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
  private store?: CacheStore;
  private hooks?: ContestServiceHooks;

  constructor(auth: AuthService, store?: CacheStore, hooks?: ContestServiceHooks) {
    this.auth = auth;
    this.store = store;
    this.hooks = hooks;
  }

  /** 获取比赛列表 */
  async fetchList(page: number = 1, keyword?: string, opts: FetchOptions = {}):
    Promise<{ rows: Contest[]; pagination: Pagination; meta: FetchMeta }> {
    const offline = this.store?.offline ?? false;

    // 缓存优先
    if (this.store && !opts.force) {
      const stat = await this.store.statContestListHtml(page, keyword);
      const cached = await this.store.readContestListHtml(page, keyword);
      if (cached !== undefined) {
        return { ...parseContestList(cached), meta: { source: 'cache', ageMs: stat.ageMs ?? 0 } };
      }
    }

    if (offline) {
      // 离线且无缓存：给不出数据就把话说清楚，别让上层显示成「暂无比赛」
      throw new OfflineNoCacheError('比赛列表');
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
      await this.store?.writeContestListHtml(page, keyword, html);
      return { ...parseContestList(html), meta: { source: 'network', ageMs: 0 } };
    } catch (e: any) {
      console.error('[OJ] 比赛列表加载失败:', e);
      throw new Error(`加载比赛列表失败: ${e.message}`);
    }
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
    const offline = this.store?.offline ?? false;

    // 缓存优先
    if (this.store && !opts.force) {
      const stat = await this.store.statContestPageHtml(cid);
      const cached = await this.store.readContestPageHtml(cid);
      if (cached !== undefined) {
        const parsed = parseProblemList(cached);
        // 解析出 0 题时不足以判定「真的没题」——可能是受限页或站点结构变化，
        // 在线情况下回退到网络重新确认
        if (parsed.problems.length > 0 || offline) {
          parsed.problems.forEach(p => { p.cid = cid; });
          await this.syncIndex(cid, parsed.problems);
          return { ...parsed, meta: { source: 'cache', ageMs: stat.ageMs ?? 0 } };
        }
      }
    }

    if (offline) {
      throw new OfflineNoCacheError('题目列表');
    }

    try {
      const response = await apiClient.get('/contest.php', {
        params: { cid },
      }, 'contest.fetchProblemList');

      const html = typeof response.data === 'string' ? response.data : '';

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
      if (e instanceof AccessError) {
        throw e;
      }
      console.error('[OJ] 题目列表加载失败:', e);
      throw new Error(`加载题目列表失败: ${e.message}`);
    }
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
    return typeof response.data === 'string' ? response.data : '';
  }
}

/** 权限/登录失效专用错误 */
export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}
