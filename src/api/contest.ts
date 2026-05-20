import { apiClient } from './client';
import { parseContestList, parseProblemList } from '../utils/parser';
import { Contest, ProblemBrief } from '../types';
import { AuthService } from './auth';

/** 比赛模块 — 比赛列表获取与解析 */

export class ContestService {
  private auth: AuthService;

  constructor(auth: AuthService) {
    this.auth = auth;
  }

  /** 获取比赛列表 — 复用 home.js fetchContestList */
  async fetchList(page: number = 1, keyword?: string): Promise<{ rows: Contest[]; pagination: any }> {
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
      return parseContestList(html);
    } catch (e: any) {
      console.error('[OJ] 比赛列表加载失败:', e);
      throw new Error(`加载比赛列表失败: ${e.message}`);
    }
  }

  /** 获取某比赛下的题目列表 — 复用 workspace.js loadProblems */
  async fetchProblemList(cid: string): Promise<{ title: string; problems: ProblemBrief[] }> {
    try {
      const response = await apiClient.get('/contest.php', {
        params: { cid },
      }, 'contest.fetchProblemList');

      const html = typeof response.data === 'string' ? response.data : '';

      // 检测受限提示：比赛尚未开始/私有/无权限
      if (html.includes('比赛尚未开始或私有') || html.includes('不能查看题目')) {
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

      // 填充 cid
      result.problems.forEach(p => { p.cid = cid; });

      return result;
    } catch (e: any) {
      if (e instanceof AccessError) {
        throw e;
      }
      console.error('[OJ] 题目列表加载失败:', e);
      throw new Error(`加载题目列表失败: ${e.message}`);
    }
  }
}

/** 权限/登录失效专用错误 */
export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}
