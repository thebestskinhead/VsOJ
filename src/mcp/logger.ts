import * as vscode from 'vscode';

/**
 * MCP 专用日志系统 — 独立的 OutputChannel
 * 记录 MCP 服务器启动/停止、客户端连接、工具调用等所有事件
 */

let _channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('OJ MCP', { log: true });
  }
  return _channel;
}

/** 初始化（extension 激活时调用） */
export function initMcpChannel(): void {
  getChannel();
}

/** 显示 MCP 日志面板 */
export function showMcpChannel(): void {
  getChannel().show(true);
}

/** 清空日志 */
export function clearMcpChannel(): void {
  if (_channel) {
    _channel.clear();
  }
}

/** 销毁 */
export function disposeMcpChannel(): void {
  if (_channel) {
    _channel.dispose();
    _channel = undefined;
  }
}

// ==========================================
// 日志辅助
// ==========================================

function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

function fmt(kind: string, icon: string): string {
  return `[${ts()}] ${icon} [${kind}]`;
}

// ==========================================
// MCP 专用日志 API
// ==========================================

/** 服务器启动 */
export function logMcpStart(port: number): void {
  getChannel().appendLine(`${fmt('START', '🚀')} MCP 服务器已启动 → http://127.0.0.1:${port}/mcp`);
}

/** 服务器停止 */
export function logMcpStop(): void {
  getChannel().appendLine(`${fmt('STOP', '🛑')} MCP 服务器已停止`);
}

/** 服务器启动失败 */
export function logMcpStartFailed(err: string): void {
  getChannel().appendLine(`${fmt('ERROR', '❌')} MCP 启动失败: ${err}`);
}

/** 客户端连接（initialize） */
export function logMcpClientConnected(clientInfo: { name?: string; version?: string }): void {
  const name = clientInfo.name || 'Unknown';
  const ver = clientInfo.version || '?';
  getChannel().appendLine(`${fmt('CONN', '🔗')} 客户端连接: ${name} v${ver}`);
}

/** 工具列表请求 */
export function logMcpListTools(): void {
  getChannel().appendLine(`${fmt('LIST', '📋')} 列出工具`);
}

/** 工具调用 */
export function logMcpToolCall(toolName: string, args?: Record<string, any>): void {
  const argsStr = args && Object.keys(args).length > 0
    ? ` 参数: ${JSON.stringify(args)}`
    : ' (无参数)';
  getChannel().appendLine(`${fmt('CALL', '🔧')} 调用工具: ${toolName}${argsStr}`);
}

/** 工具调用成功 */
export function logMcpToolSuccess(toolName: string, resultLen?: number): void {
  const lenInfo = resultLen !== undefined ? ` (响应 ${resultLen} 字符)` : '';
  getChannel().appendLine(`${fmt('OK', '✅')} 工具 ${toolName} 执行成功${lenInfo}`);
}

/** 工具调用失败 */
export function logMcpToolError(toolName: string, err: string): void {
  getChannel().appendLine(`${fmt('ERR', '❌')} 工具 ${toolName} 执行失败: ${err}`);
}

/** 未找到方法 */
export function logMcpMethodNotFound(method: string): void {
  getChannel().appendLine(`${fmt('404', '⚠️')} 未知方法: ${method}`);
}

/** 解析错误 */
export function logMcpParseError(err: string): void {
  getChannel().appendLine(`${fmt('PARSE', '💥')} JSON 解析失败: ${err}`);
}

/** HTTP 请求日志 */
export function logMcpHttp(method: string, url: string, status: number): void {
  const icon = status >= 400 ? '⚠️' : '📨';
  getChannel().appendLine(`${fmt('HTTP', icon)} ${method} ${url} → ${status}`);
}

/** 通用信息日志 */
export function logMcpInfo(msg: string): void {
  getChannel().appendLine(`${fmt('INFO', 'ℹ️')} ${msg}`);
}
