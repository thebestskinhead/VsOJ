import { apiClient } from './client';
import { parseContestList, parseProblemList } from '../utils/parser';
import { Contest, ProblemBrief, Pagination } from '../types';
import { AuthService } from './auth';
import { CacheStore } from '../cache/store';

/**
 * 比赛模块 — 比赛列表 / 题目列表。
 *
 * 缓存策略（见 docs/PLAN_S4.md §4.1）：列表走**同步 TTL**
 * （`oj.cache.ttlSeconds`，默认 180s）—— 命中且新鲜就直接用，不发起任何请求；
 * 过期或 `force` 才联网，并**原样落盘原始 HTML**。
 *
 * `oj.cache.offline = true` 时完全跳过网络，只能吃缓存。
 */

export interface FetchOptions {
  /** 忽略缓存，强制联网 */
  force?: boolean;
}

const EMPTY_PAGINATION: Pagination = { current: 1, total: 1, pages: [], first: null, last: null };

export class ContestService {
  private auth: AuthService;
  private store?: CacheStore;

  constructor(auth: AuthService, store?: CacheStore) {
    this.auth = auth;
    this.store = store;
  }

  /** 获取比赛列表 */
  async fetchList(page: number = 1, keyword?: string, opts: FetchOptions = {}):
    Promise<{ rows: Contest[]; pagination: Pagination }> {
    const offline = this.store?.offline ?? false;

    // 缓存优先
    if (this.store && !opts.force) {
      const cached = await this.store.readContestListHtml(page, keyword);
      if (cached !== undefined) {
        return parseContestList(cached);
      }
    }

    if (offline) {
      // 离线且无缓存：返回空结果，由视图层提示
      return { rows: [], pagination: { ...EMPTY_PAGINATION } };
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
      return parseContestList(html);
    } catch (e: any) {
      console.error('[OJ] 比赛列表加载失败:', e);
      throw new Error(`加载比赛列表失败: ${e.message}`);
    }
  }

  /** 获取某比赛下的题目列表 */
  async fetchProblemList(cid: string, opts: FetchOptions = {}):
    Promise<{ title: string; problems: ProblemBrief[] }> {
    const offline = this.store?.offline ?? false;

    // 缓存优先
    if (this.store && !opts.force) {
      const cached = await this.store.readContestPageHtml(cid);
      if (cached !== undefined) {
        const parsed = parseProblemList(cached);
        // 解析出 0 题时不足以判定「真的没题」——可能是受限页或站点结构变化，
        // 在线情况下回退到网络重新确认
        if (parsed.problems.length > 0 || offline) {
          parsed.problems.forEach(p => { p.cid = cid; });
          return parsed;
        }
      }
    }

    if (offline) {
      return { title: '', problems: [] };
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

      // 落盘原始 HTML；比赛标题只在这里能拿到，因此目录名在此定稿
      await this.store?.writeContestPageHtml(cid, html, result.title);

      return result;
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
