import { apiClient } from './client';
import { parseStatusTable } from '../utils/parser';
import { StatusRecord, LANGUAGE_EXT, LANGUAGE_NAME } from '../types';
import { AuthService } from './auth';
import { CacheStore } from '../cache/store';
import {
  classifyHtmlBody, classifyHttpResponse, classifyThrown, looksLikeLoginPage, FailureKind,
} from '../session/guard';

/** 提交模块 — 代码提交与状态查询 */

/**
 * 提交结果。
 *
 * `kind` 让上层能区分「登录过期」与「其它失败」—— 这是
 * 「题目页能进、提交却失败」场景下必须拿到的信息，见 docs/SITE_ANALYSIS.md §5。
 */
export interface SubmitOutcome {
  success: boolean;
  /** 成功时为 'OK' */
  kind: FailureKind | 'OK';
  /** 面向用户的提示 */
  message: string;
  /** 服务端原始响应片段（诊断用） */
  rawSnippet?: string;
}

/** 状态查询结果（含数据来源，便于 UI 标注「离线缓存」） */
export interface StatusQueryResult {
  records: StatusRecord[];
  /** 数据是否来自本地缓存（网络不可用 / 离线模式） */
  fromCache: boolean;
  /** 离线模式且本地无缓存 */
  offlineNoCache?: boolean;
}

export class SubmitService {
  private auth: AuthService;
  private store?: CacheStore;

  constructor(auth: AuthService, store?: CacheStore) {
    this.auth = auth;
    this.store = store;
  }

  /**
   * 提交代码 — 复用 api.js submitCode
   *
   * 与旧实现的关键差异：
   *  - 使用 `validateStatus: () => true` 拿到 5xx 响应体，而不是让 axios 直接抛错，
   *    这样才能按 docs/SITE_ANALYSIS.md §5 的实测信号判定「会话失效」
   *  - 不再抛异常表达业务失败，统一返回 {@link SubmitOutcome}
   */
  async submit(
    cid: string,
    pid: string,
    language: number,
    source: string,
    vcode: string,
  ): Promise<SubmitOutcome> {
    // CSRF 缺失意味着会话/登录态不可用 —— 与站点「需要登录才能提交」一致
    let csrf = '';
    try {
      csrf = await this.auth.fetchCsrfToken();
    } catch {
      csrf = '';
    }
    if (!csrf) {
      return {
        success: false,
        kind: 'SESSION_EXPIRED',
        message: '无法获取 CSRF Token，请确认已登录',
      };
    }

    const formData = new URLSearchParams();
    formData.append('cid', cid);
    formData.append('pid', pid);
    formData.append('language', String(language));
    formData.append('vcode', vcode);
    formData.append('source', source);
    formData.append('csrf', csrf);

    try {
      const response = await apiClient.post('/submit.php', formData.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // 关键：自行接管状态码判定，避免 5xx 被 axios 拦截后丢失响应体
        validateStatus: () => true,
      }, 'submit.submit');

      const status = response.status;
      const body = typeof response.data === 'string' ? response.data : '';
      const location = String((response.headers as Record<string, unknown>)?.['location'] ?? '');

      // 站点把未登录的提交重定向到登录页。axios 默认跟随 302，因此有两种形态：
      //   a) 未跟随 → Location 可见
      //   b) 已跟随 → 最终正文就是登录页
      if ((status === 302 || status === 303) && /loginpage/i.test(location)) {
        return { success: false, kind: 'SESSION_EXPIRED', message: '登录已过期，请重新登录后继续提交' };
      }
      if (looksLikeLoginPage(body)) {
        return {
          success: false,
          kind: 'SESSION_EXPIRED',
          message: '登录已过期，请重新登录后继续提交',
          rawSnippet: body.slice(0, 200),
        };
      }

      // 成功口径与旧实现保持一致（200 / 302），且正文无失败特征
      const bodyKind = classifyHtmlBody(body);
      if ((status === 200 || status === 302 || status === 303) && !bodyKind) {
        return { success: true, kind: 'OK', message: '提交成功' };
      }

      const c = classifyHttpResponse(status, body, 'submit');
      console.warn(`[OJ] 提交失败 kind=${c.kind} status=${status}`);
      return { success: false, kind: c.kind, message: c.message, rawSnippet: c.rawSnippet };
    } catch (e: any) {
      const c = classifyThrown(e);
      console.error('[OJ] 代码提交异常:', c.kind, c.message);
      return { success: false, kind: c.kind, message: c.message, rawSnippet: c.rawSnippet };
    }
  }

  /**
   * 拉取状态页**原始 HTML**（不走缓存）。
   * 供刷新执行器 `cache/refresher.ts` 使用。
   */
  async fetchStatusHtml(userId: string, cid: string): Promise<string> {
    const response = await apiClient.get('/status.php', {
      params: { user_id: userId, cid },
      headers: { 'Cache-Control': 'no-cache' },
    }, 'submit.fetchStatusHtml');
    return typeof response.data === 'string' ? response.data : '';
  }

  /**
   * 查询提交状态。
   *
   * 缓存策略：**网络优先，缓存降级**。状态数据的时效性要求高于题目内容，
   * 所以网络可访问时一律实时请求（顺带把原始 HTML 落盘）；只有请求失败
   * 或 `oj.cache.offline = true` 时才使用本地缓存，并通过 `fromCache` 告知上层。
   */
  async queryStatus(userId: string, cid: string): Promise<StatusQueryResult> {
    const offline = this.store?.offline ?? false;

    if (offline) {
      const cached = await this.store?.readStatusHtml(cid, { allowStale: true });
      if (cached !== undefined) {
        return { records: parseStatusTable(cached), fromCache: true };
      }
      return { records: [], fromCache: true, offlineNoCache: true };
    }

    try {
      const html = await this.fetchStatusHtml(userId, cid);
      await this.store?.writeStatusHtml(cid, html);
      return { records: parseStatusTable(html), fromCache: false };
    } catch (e: any) {
      // 降级：网络不可用 → 读本地缓存（宁肯看到略旧的记录，也好过空白）
      const cached = await this.store?.readStatusHtml(cid, { allowStale: true });
      if (cached !== undefined) {
        console.warn('[OJ] 状态查询失败，降级使用本地缓存:', e.message);
        return { records: parseStatusTable(cached), fromCache: true };
      }
      console.error('[OJ] 状态查询失败:', e);
      throw new Error(`查询状态失败: ${e.message}`);
    }
  }

  /** 从当前激活编辑器推断语言编号 */
  getLanguageFromEditor(): number {
    const extMap = LANGUAGE_EXT;
    // 返回值中包含了 .cc 和 .cxx 的映射
    return 1; // 默认 C++
  }

  /** 根据文件扩展名获取语言编号 */
  static getLanguageFromExt(ext: string): number {
    return LANGUAGE_EXT[ext.toLowerCase()] ?? 1;
  }

  /** 获取语言名称 */
  static getLanguageName(lang: number): string {
    return LANGUAGE_NAME[lang] || 'C++';
  }
}
