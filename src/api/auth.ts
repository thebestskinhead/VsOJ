import { apiClient } from './client';
import { hex_md5 } from '../utils/crypto';
import { parseCsrfToken, parseStudentId } from '../utils/parser';
import { StateManager } from '../utils/state';
import { getBaseUrl } from '../utils/config';
import { logInfo } from '../utils/debug';

/** 认证模块 — 登录/登出/Session管理 */

export class AuthService {
  private state: StateManager;

  constructor(state: StateManager) {
    this.state = state;
  }

  /**
   * 初始化 OJ 会话 —— 访问任意页面获取 PHPSESSID cookie
   * 这是登录的前提：OJ 不会在登录成功时返回新 cookie，
   * 而是将"现有的 PHPSESSID 对应的会话"标记为已登录。
   * 
   * 在加载验证码之前调用，确保后续所有请求携带同一个 PHPSESSID。
   */
  async initSession(): Promise<boolean> {
    try {
      const response = await apiClient.get('/loginpage.php', {
        headers: { 'Cache-Control': 'no-cache' },
      }, 'auth.initSession');
      const cookies = await apiClient.dumpCookies();
      logInfo(`会话初始化完成 — Cookies: ${cookies}`);
      return true;
    } catch (e: any) {
      console.error('[OJ] 会话初始化失败:', e);
      return false;
    }
  }

  /** 检查当前是否存在有效登录态 — 复用 api.js checkLogin */
  async isLoggedIn(): Promise<boolean> {
    try {
      const cookiesBefore = await apiClient.dumpCookies();
      logInfo(`登录中`);

      const response = await apiClient.get('/loginpage.php', {
        headers: { 'Cache-Control': 'no-cache' },
      }, 'auth.isLoggedIn');
      const text = typeof response.data === 'string' ? response.data : '';
      const loggedIn = text.includes('logout.php');

      logInfo(`isLoggedIn 结果 — ${loggedIn ? '✅ 已登录' : '❌ 未登录'} (${text.includes('<a href=logout.php>') ? '含 logout.php' : '不含 logout.php 标记'})`);
      await this.state.setLoggedIn(loggedIn);
      return loggedIn;
    } catch (e) {
      console.error('[OJ] 登录状态检查失败:', e);
      return false;
    }
  }

  /** 使用账号密码登录 — 复用 login.js handleLoginSubmit */
  async login(username: string, password: string, vcode: string): Promise<boolean> {
    try {
      const cookiesBefore = await apiClient.dumpCookies();
      logInfo(`login 开始 — 当前 Cookie: ${cookiesBefore}`);

      // 密码 MD5 加密
      const encryptedPwd = hex_md5(password);

      // 获取 CSRF Token（携带当前会话 cookie）
      const csrfToken = await this.fetchCsrfToken();

      const formData = new URLSearchParams();
      formData.append('user_id', username);
      formData.append('password', encryptedPwd);
      formData.append('vcode', vcode);
      formData.append('submit', '');
      formData.append('csrf', csrfToken);

      logInfo(`login POST`);

      await apiClient.post('/login.php', formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }, 'auth.login');

      const cookiesAfter = await apiClient.dumpCookies();
      logInfo(`login POST 完成 — Cookie: ${cookiesAfter}`);

      // 登录后的检查 —— 必须使用与 login 请求相同的 CookieJar
      // 因为服务器只是把现有的 PHPSESSID 会话标记为"已登录"
      // 如果这里换了一个新会话，就检查不到登录状态
      const loggedIn = await this.isLoggedIn();

      if (loggedIn) {
        // 保存 Cookie 到 secrets（用于下次启动时恢复）
        const cookieString = await apiClient.getCookieString();
        logInfo(`登录成功`);
        apiClient.lockCookies();
        await this.state.setSessionCookie(cookieString);

        // 获取并保存学号
        try {
          const studentId = await this.fetchStudentId();
          if (studentId) {
            await this.state.setStudentId(studentId);
            logInfo(`学号已保存: ${studentId}`);
          }
        } catch (e) {
          console.error('[OJ] 获取学号失败:', e);
        }
      } else {
        logInfo(`登录失败`);
      }

      return loggedIn;
    } catch (e: any) {
      console.error('[OJ] 登录失败:', e);
      throw new Error(`登录失败: ${e.message}`);
    }
  }

  /** 获取 CSRF Token（60s 缓存避免重复请求） */
  private _csrfToken = '';
  private _csrfTime = 0;

  async fetchCsrfToken(): Promise<string> {
    const now = Date.now();
    if (this._csrfToken && now - this._csrfTime < 60_000) {
      return this._csrfToken;
    }
    try {
      const response = await apiClient.get('/csrf.php', undefined, 'auth.fetchCsrf');
      const html = typeof response.data === 'string' ? response.data : '';
      this._csrfToken = parseCsrfToken(html);
      this._csrfTime = now;
      return this._csrfToken;
    } catch (e) {
      console.error('[OJ] CSRF 获取失败:', e);
      return this._csrfToken || '';
    }
  }

  /** 获取学号 — 复用 api.js fetchStudentId */
  async fetchStudentId(): Promise<string | null> {
    try {
      const response = await apiClient.get('/modifypage.php', {
        headers: { 'Cache-Control': 'no-cache' },
      }, 'auth.fetchStudentId');
      const html = typeof response.data === 'string' ? response.data : '';
      return parseStudentId(html);
    } catch (e) {
      console.error('[OJ] 获取学号失败:', e);
      return null;
    }
  }

  /** 获取验证码图片（返回 base64） */
  async fetchVcodeImage(): Promise<string> {
    try {
      // getBuffer 内部使用 responseType='text' + binary encoding
      // 这样才能确保 cookiejar-support 正确捕获 Set-Cookie
      const buffer = await apiClient.getBuffer('/vcode.php?' + Math.random(), 'auth.fetchVcode');
      const base64 = buffer.toString('base64');
      return `data:image/png;base64,${base64}`;
    } catch (e: any) {
      console.error('[OJ] 验证码获取失败:', e);
      throw new Error(`验证码加载失败: ${e.message}`);
    }
  }

  /** 快捷登录 — 使用预存的密码哈希（不再次 MD5），只需输入验证码 */
  async quickLogin(username: string, passwordHash: string, vcode: string): Promise<boolean> {
    try {
      logInfo(`quickLogin — user: ${username}`);

      const csrfToken = await this.fetchCsrfToken();

      const formData = new URLSearchParams();
      formData.append('user_id', username);
      formData.append('password', passwordHash); // 直接发哈希，不再次 MD5
      formData.append('vcode', vcode);
      formData.append('submit', '');
      formData.append('csrf', csrfToken);

      await apiClient.post('/login.php', formData.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, 'auth.quickLogin');

      const loggedIn = await this.isLoggedIn();

      if (loggedIn) {
        const cookieString = await apiClient.getCookieString();
        apiClient.lockCookies();
        await this.state.setSessionCookie(cookieString);
        try {
          const studentId = await this.fetchStudentId();
          if (studentId) { await this.state.setStudentId(studentId); }
        } catch (e) { /* ignore */ }
      }

      return loggedIn;
    } catch (e: any) {
      console.error('[OJ] 快捷登录失败:', e);
      throw new Error(`快捷登录失败: ${e.message}`);
    }
  }

  /** 登出 */
  async logout(): Promise<void> {
    apiClient.unlockCookies();
    apiClient.clearCookies();
    try {
      await apiClient.get('/logout.php', undefined, 'auth.logout');
    } catch (e) {
      console.error('[OJ] 登出请求失败:', e);
    }
    await this.state.clearSessionCookie();
    await this.state.setLoggedIn(false);
    await this.state.setStudentId(undefined);
    logInfo('已登出');
  }
}
