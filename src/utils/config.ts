import * as vscode from 'vscode';

/** 用户配置读取 */

export function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('oj');
}

export function getBaseUrl(): string {
  const url = getConfig().get<string>('baseUrl', 'http://localhost');
  return url.replace(/\/+$/, '');
}

export function getDefaultLanguage(): string {
  return getConfig().get<string>('defaultLanguage', 'cpp');
}

export function getAutoRefreshStatus(): boolean {
  return getConfig().get<boolean>('autoRefreshStatus', true);
}

export function getStatusRefreshInterval(): number {
  return getConfig().get<number>('statusRefreshInterval', 5000);
}

export function getStatusViewMode(): 'output' | 'webview' | 'browser' {
  return getConfig().get<'output' | 'webview' | 'browser'>('statusViewMode', 'browser');
}

export function getMcpEnabled(): boolean {
  return getConfig().get<boolean>('mcp.enabled', false);
}

export function getMcpPort(): number {
  return getConfig().get<number>('mcp.port', 9527);
}

// ============================================================
// 缓存 / 工作区
// ============================================================

/** 缓存根目录名（相对工作区根）；空值回退 `.vsoj` */
export function getWorkspaceRootName(): string {
  const v = getConfig().get<string>('workspace.root', '.vsoj').trim();
  return v || '.vsoj';
}

export function isCacheEnabled(): boolean {
  return getConfig().get<boolean>('cache.enabled', true);
}

export function isOfflineMode(): boolean {
  return getConfig().get<boolean>('cache.offline', false);
}

/** 缓存 TTL（毫秒）；负数表示永不过期 */
export function getCacheTtlMs(): number {
  const sec = getConfig().get<number>('cache.ttlSeconds', 180);
  return sec < 0 ? -1 : sec * 1000;
}

// ============================================================
// 会话保活
// ============================================================

/** 心跳间隔（毫秒）；0 表示关闭 */
export function getKeepAliveIntervalMs(): number {
  return Math.max(0, getConfig().get<number>('session.keepAliveInterval', 240000));
}

/** 登录态探测间隔（毫秒）；0 表示只跟随心跳探测 */
export function getSessionProbeIntervalMs(): number {
  return Math.max(0, getConfig().get<number>('session.probeInterval', 600000));
}

/** 识别到登录失效时，是否自动打开登录页 */
export function getAutoRelogin(): boolean {
  return getConfig().get<boolean>('session.autoRelogin', true);
}

/** 重新登录成功后，是否自动恢复比赛/题目上下文并回到提交页 */
export function getAutoReplaySubmit(): boolean {
  return getConfig().get<boolean>('session.autoReplaySubmit', true);
}
