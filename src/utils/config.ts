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
