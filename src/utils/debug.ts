import * as vscode from 'vscode';

/** API Debug 工具 — OutputChannel 监控所有 OJ API 请求与响应 */

let _channel: vscode.OutputChannel | undefined;
let _enabled: boolean = true;

function getChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('OJ Debug', { log: true });
  }
  return _channel;
}

/** 初始化（extension 激活时调用） */
export function initDebugChannel(): void {
  getChannel();
}

/** 启用/禁用 debug */
export function setDebugEnabled(on: boolean): void {
  _enabled = on;
  if (on && _channel) {
    _channel.appendLine(`[${timestamp()}] 🔍 DEBUG 已启用`);
  }
}

export function isDebugEnabled(): boolean {
  return _enabled;
}

/** 显示 debug 面板 */
export function showDebugChannel(): void {
  getChannel().show(true);
}

/** 清空日志 */
export function clearDebugChannel(): void {
  if (_channel) {
    _channel.clear();
  }
}

/** 销毁 */
export function disposeDebugChannel(): void {
  if (_channel) {
    _channel.dispose();
    _channel = undefined;
  }
}

// ==========================================
// 日志函数
// ==========================================

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) { return s; }
  return s.substring(0, max) + `…(截断, 总长 ${s.length})`;
}

function headersString(headers: Record<string, any>): string {
  if (!headers) { return '(无)'; }
  const keys = Object.keys(headers);
  if (keys.length === 0) { return '(无)'; }
  return keys.map(k => `    ${k}: ${headers[k]}`).join('\n');
}

/** 记录请求 */
export function logRequest(
  id: string,
  method: string,
  url: string,
  headers?: Record<string, any>,
  body?: string,
  caller?: string,
): void {
  if (!_enabled) { return; }
  const ch = getChannel();
  const ts = timestamp();

  ch.appendLine('');
  ch.appendLine(`┌── REQUEST  #${id}${caller ? `  [${caller}]` : ''} ────── ${ts}`);
  ch.appendLine(`│  ${method}  ${url}`);
  ch.appendLine(`│  Headers:`);
  ch.appendLine(headersString(headers || {}));
  if (body) {
    ch.appendLine(`│  Body (${body.length} 字节):`);
    ch.appendLine(truncate(body, 1000).split('\n').map(l => `│  │ ${l}`).join('\n'));
  }
  ch.appendLine(`└────────────────────────────────────────────────`);
}

/** 记录响应 */
export function logResponse(
  id: string,
  status: number,
  headers?: Record<string, any>,
  body?: string,
  duration?: number,
  caller?: string,
): void {
  if (!_enabled) { return; }
  const ch = getChannel();
  const ts = timestamp();
  const durStr = duration !== undefined ? `  ⏱ ${duration}ms` : '';

  const statusIcon = status >= 200 && status < 300 ? '✅'
    : status >= 300 && status < 400 ? '↪️'
    : status >= 400 && status < 500 ? '⚠️'
    : '❌';

  ch.appendLine(`┌── RESPONSE #${id}${caller ? `  [${caller}]` : ''} ────── ${ts}${durStr}`);
  ch.appendLine(`│  ${statusIcon} Status: ${status}`);
  ch.appendLine(`│  Headers:`);
  ch.appendLine(headersString(headers || {}));
  if (body) {
    ch.appendLine(`│  Body (${body.length} 字节):`);
    ch.appendLine(truncate(body, 1000).split('\n').map(l => `│  │ ${l}`).join('\n'));
  }
  ch.appendLine(`└────────────────────────────────────────────────`);
  ch.appendLine('');
}

/** 记录错误 */
export function logError(
  id: string,
  message: string,
  duration?: number,
): void {
  if (!_enabled) { return; }
  const ch = getChannel();
  const ts = timestamp();
  const durStr = duration !== undefined ? `  ⏱ ${duration}ms` : '';

  ch.appendLine(`┌── ERROR    #${id} ─────────────────── ${ts}${durStr}`);
  ch.appendLine(`│  ❌ ${message}`);
  ch.appendLine(`└────────────────────────────────────────────────`);
  ch.appendLine('');
}

/** 记录系统信息 */
export function logInfo(msg: string): void {
  if (!_enabled) { return; }
  getChannel().appendLine(`[${timestamp()}] ℹ️  ${msg}`);
}

let _requestCounter = 0;
export function nextId(): string {
  return String(++_requestCounter).padStart(4, '0');
}
