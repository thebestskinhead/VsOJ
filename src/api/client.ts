import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { CookieJar } from 'tough-cookie';
import { getBaseUrl } from '../utils/config';
import { logRequest, logResponse, logError, nextId } from '../utils/debug';

/**
 * 全局 HTTP 客户端 — 单例模式
 *
 * Cookie 运行时：用简单 Map（不走 tough-cookie domain/path 匹配）
 * Cookie 持久化：用 tough-cookie CookieJar 序列化/反序列化
 */
class ApiClient {
  private static instance: ApiClient;
  private client: AxiosInstance;
  private jar: CookieJar;                      // 仅用于持久化
  private cookieStore = new Map<string, string>(); // 运行时缓存
  private cookieLocked = false;                  // 登录后锁定，不再被 Set-Cookie 覆写

  private constructor() {
    this.jar = new CookieJar();
    this.client = axios.create({
      baseURL: getBaseUrl(),
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      maxRedirects: 5,
      validateStatus: (status: number) => status < 500,
    });

    // ==== 请求拦截器：从 cookieStore 读 → 写 Cookie header ====
    this.client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      (config as any)._startTime = Date.now();
      (config as any)._debugId = nextId();

      // 组装 Cookie header
      const parts: string[] = [];
      for (const [k, v] of this.cookieStore) { parts.push(`${k}=${v}`); }
      if (parts.length > 0) {
        config.headers = config.headers || {};
        const existing = (config.headers as Record<string, string>)['Cookie'] || '';
        config.headers['Cookie'] = existing ? `${parts.join('; ')}; ${existing}` : parts.join('; ');
      }

      // debug 日志
      let bodyStr: string | undefined;
      if (config.data) {
        if (typeof config.data === 'string') bodyStr = config.data;
        else if (Buffer.isBuffer(config.data)) bodyStr = `[Binary ${config.data.length} bytes]`;
        else bodyStr = JSON.stringify(config.data);
      }
      logRequest(
        (config as any)._debugId,
        config.method?.toUpperCase() || 'GET',
        `${config.baseURL || ''}${config.url || ''}`,
        config.headers as Record<string, any>,
        bodyStr,
        (config as any)._caller || '',
      );
      return config;
    });

    // ==== 响应拦截器：提取 Set-Cookie → 写入 cookieStore ====
    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        const startTime = (response.config as any)._startTime;
        const debugId = (response.config as any)._debugId;
        const duration = startTime ? Date.now() - startTime : undefined;

        // 直接取所有 set-cookie 头（axios 可能是数组）
        const sc = response.headers['set-cookie'];
        if (sc) {
          const list = Array.isArray(sc) ? sc : [sc];
          for (const raw of list) {
            if (typeof raw !== 'string') continue;
            const m = raw.match(/^(\w+)=([^;]+)/);
            if (m) {
              const key = m[1];
              const val = m[2].trim();
              // 锁定期不覆盖已有 cookie（登录后防止被新响应换掉 PHPSESSID）
              if (!this.cookieLocked || !this.cookieStore.has(key)) {
                this.cookieStore.set(key, val);
              }
            }
          }
        }

        console.log(
          `[OJ] ${response.config.method?.toUpperCase()} ${response.config.url} -> ${response.status}` +
          (duration ? ` (${duration}ms)` : ''),
        );

        let bodyStr: string | undefined;
        if (response.data) {
          if (typeof response.data === 'string') bodyStr = response.data;
          else if (Buffer.isBuffer(response.data)) bodyStr = `[Binary ${response.data.length} bytes]`;
          else bodyStr = JSON.stringify(response.data);
        }
        logResponse(debugId, response.status, response.headers as Record<string, any>, bodyStr, duration, (response.config as any)._caller || '');
        return response;
      },
      (error: any) => {
        const config = error.config || {};
        const msg = error.response
          ? `HTTP ${error.response.status} ${error.response.statusText}`
          : error.message;
        console.error(`[OJ] HTTP Error:`, msg);
        logError((config as any)._debugId, msg, config._startTime ? Date.now() - config._startTime : undefined);
        return Promise.reject(error);
      },
    );
  }

  public static getInstance(): ApiClient {
    if (!ApiClient.instance) { ApiClient.instance = new ApiClient(); }
    return ApiClient.instance;
  }

  /** 更新 baseURL */
  public updateBaseUrl(url: string): void {
    this.client.defaults.baseURL = url.replace(/\/+$/, '');
  }

  /** 登录成功后锁定 cookie，防止被服务器返回的新 PHPSESSID 覆写 */
  public lockCookies(): void { this.cookieLocked = true; }

  /** 登出或主动重置时解锁并清空 */
  public unlockCookies(): void { this.cookieLocked = false; }

  /** 清空运行时缓存 */
  public clearCookies(): void { this.cookieStore.clear(); }

  public async get<T = any>(url: string, config?: AxiosRequestConfig, caller?: string): Promise<AxiosResponse<T>> {
    if (caller) { config = { ...config }; (config as any)._caller = caller; }
    return this.client.get<T>(url, config);
  }

  public async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig, caller?: string): Promise<AxiosResponse<T>> {
    if (caller) { config = { ...config }; (config as any)._caller = caller; }
    return this.client.post<T>(url, data, config);
  }

  public async getBuffer(url: string, caller?: string): Promise<Buffer> {
    const config: AxiosRequestConfig = { responseType: 'text', responseEncoding: 'binary' };
    if (caller) { (config as any)._caller = caller; }
    const resp = await this.client.get(url, config);
    const data = typeof resp.data === 'string' ? resp.data : '';
    return Buffer.from(data, 'binary');
  }

  /** 获取当前 Cookie 调试信息 */
  public dumpCookies(): string {
    if (this.cookieStore.size === 0) return '(无 Cookie)';
    return [...this.cookieStore].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** 序列化当前 Cookie（JSON）用于持久化 */
  public async getCookieString(): Promise<string> {
    // 同时写入 jar（用于持久化 JSON 中的 domain/path）
    const baseUrl = getBaseUrl();
    for (const [k, v] of this.cookieStore) {
      await this.jar.setCookie(`${k}=${v}; Path=/; Domain=${new URL(baseUrl).hostname}`, `${baseUrl}/`);
    }
    const cookies = await this.jar.getCookies(baseUrl);
    if (cookies.length === 0) return '[]';
    return JSON.stringify(cookies.map(c => ({ key: c.key, value: c.value, domain: c.domain || '', path: c.path || '/' })));
  }

  /** 从 JSON 恢复 Cookie（同时填充 cookieStore 和 jar） */
  public async restoreCookies(jsonStr: string, domain: string): Promise<void> {
    try {
      const list: Array<{ key: string; value: string; domain: string; path: string }> = JSON.parse(jsonStr);
      if (!Array.isArray(list)) return;
      for (const c of list) {
        this.cookieStore.set(c.key, c.value);
        try {
          const d = c.domain || domain;
          const p = c.path || '/';
          await this.jar.setCookie(`${c.key}=${c.value}; Domain=${d}; Path=${p}`, `${getBaseUrl()}/`);
        } catch (_) { /* ignore */ }
      }
    } catch {
      // 兼容旧格式
      if (jsonStr && !jsonStr.startsWith('[')) {
        for (const part of jsonStr.split(';').map(s => s.trim()).filter(Boolean)) {
          const eq = part.indexOf('=');
          if (eq > 0) this.cookieStore.set(part.substring(0, eq), part.substring(eq + 1));
        }
      }
    }
  }
}

export const apiClient = ApiClient.getInstance();
