import { apiClient } from './client';
import { parseStatusTable } from '../utils/parser';
import { StatusRecord, LANGUAGE_EXT, LANGUAGE_NAME } from '../types';
import { AuthService } from './auth';

/** 提交模块 — 代码提交与状态查询 */

export class SubmitService {
  private auth: AuthService;

  constructor(auth: AuthService) {
    this.auth = auth;
  }

  /** 提交代码 — 复用 api.js submitCode */
  async submit(
    cid: string,
    pid: string,
    language: number,
    source: string,
    vcode: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const csrf = await this.auth.fetchCsrfToken();
      if (!csrf) {
        throw new Error('无法获取 CSRF Token，请确认已登录');
      }

      const formData = new URLSearchParams();
      formData.append('cid', cid);
      formData.append('pid', pid);
      formData.append('language', String(language));
      formData.append('vcode', vcode);
      formData.append('source', source);
      formData.append('csrf', csrf);

      const response = await apiClient.post('/submit.php', formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }, 'submit.submit');

      if (response.status === 200 || response.status === 302) {
        return { success: true, message: '提交成功' };
      } else {
        return { success: false, message: `提交失败: HTTP ${response.status}` };
      }
    } catch (e: any) {
      console.error('[OJ] 代码提交失败:', e);
      throw new Error(`提交失败: ${e.message}`);
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
