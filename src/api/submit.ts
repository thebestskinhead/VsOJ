import { apiClient } from './client';
import { parseStatusTable } from '../utils/parser';
import { StatusRecord, LANGUAGE_EXT, LANGUAGE_NAME } from '../types';
import { AuthService } from './auth';
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

export class SubmitService {
  private auth: AuthService;

  constructor(auth: AuthService) {
    this.auth = auth;
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

  /** 查询提交状态 — 复用 status.js loadStatusData */
  async queryStatus(userId: string, cid: string): Promise<StatusRecord[]> {
    try {
      const response = await apiClient.get('/status.php', {
        params: { user_id: userId, cid },
        headers: { 'Cache-Control': 'no-cache' },
      }, 'submit.queryStatus');

      const html = typeof response.data === 'string' ? response.data : '';
      return parseStatusTable(html);
    } catch (e: any) {
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
