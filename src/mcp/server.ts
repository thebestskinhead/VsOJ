import * as http from 'http';
import { McpToolHandler, McpTool, McpToolResult } from './tools';
import {
  logMcpStart, logMcpStop, logMcpStartFailed,
  logMcpClientConnected, logMcpListTools, logMcpToolCall,
  logMcpToolSuccess, logMcpToolError, logMcpMethodNotFound,
  logMcpParseError, logMcpHttp, logMcpInfo,
} from './logger';

/**
 * MCP (Model Context Protocol) HTTP Server
 * 实现 JSON-RPC 2.0 over HTTP 协议
 *
 * MCP 协议核心方法:
 * - initialize       握手/能力协商
 * - tools/list       列出可用工具
 * - tools/call       调用工具
 */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;  // 通知没有 id
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

const SERVER_NAME = 'VsOJ-MCP';
const SERVER_VERSION = '1.0.0';

export class McpServer {
  private server: http.Server | null = null;
  private toolHandler: McpToolHandler;
  private port: number;
  private isRunning: boolean = false;
  private onStatusChange?: (running: boolean, port: number) => void;

  constructor(
    toolHandler: McpToolHandler,
    port: number = 9527,
    onStatusChange?: (running: boolean, port: number) => void,
  ) {
    this.toolHandler = toolHandler;
    this.port = port;
    this.onStatusChange = onStatusChange;
  }

  get running(): boolean {
    return this.isRunning;
  }

  get currentPort(): number {
    return this.port;
  }

  /** 启动 MCP 服务器 */
  async start(port?: number): Promise<void> {
    if (this.isRunning) {
      throw new Error('MCP 服务器已在运行中');
    }

    if (port !== undefined) {
      this.port = port;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 已被占用，请更换端口`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.isRunning = true;
        this.onStatusChange?.(true, this.port);
        logMcpStart(this.port);
        resolve();
      });
    });
  }

  /** 停止 MCP 服务器 */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server || !this.isRunning) {
        this.isRunning = false;
        resolve();
        return;
      }

      this.server.close(() => {
        this.isRunning = false;
        this.server = null;
        this.onStatusChange?.(false, this.port);
        logMcpStop();
        resolve();
      });
    });
  }

  /** 处理 HTTP 请求 */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS 预检
    if (req.method === 'OPTIONS') {
      this.setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // GET 根路径 → 返回服务器信息
    if (req.method === 'GET' && (req.url === '/' || req.url === '/mcp')) {
      logMcpHttp('GET', req.url || '/', 200);
      this.setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: SERVER_NAME,
        version: SERVER_VERSION,
        status: 'running',
        endpoint: '/mcp',
        method: 'POST',
      }));
      return;
    }

    // 只接受 POST /mcp 或 /
    if (req.method !== 'POST' || (req.url !== '/mcp' && req.url !== '/')) {
      logMcpHttp(req.method || '?', req.url || '/', 404);
      this.setCorsHeaders(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    // 读取请求体
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      this.setCorsHeaders(res);
      res.setHeader('Content-Type', 'application/json');

      try {
        const request = JSON.parse(body) as JsonRpcRequest;

        if (request.jsonrpc !== '2.0') {
          logMcpParseError('非 JSON-RPC 2.0 请求');
          throw new Error('仅支持 JSON-RPC 2.0');
        }

        // 通知（无 id）→ 不返回响应体
        if (request.id === undefined || request.id === null) {
          await this.handleNotification(request);
          logMcpHttp('POST', req.url || '/mcp', 202);
          res.writeHead(202);
          res.end();
          return;
        }

        const response = await this.dispatchRequest(request);
        logMcpHttp('POST', req.url || '/mcp', 200);
        res.writeHead(200);
        res.end(JSON.stringify(response));
      } catch (e: any) {
        logMcpParseError(e.message);
        res.writeHead(400);
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${e.message}`,
          },
        }));
      }
    });
  }

  /** 处理通知（无 id 的 JSON-RPC 消息） */
  private async handleNotification(request: JsonRpcRequest): Promise<void> {
    const { method, params } = request;

    switch (method) {
      case 'notifications/initialized':
        logMcpInfo('客户端初始化完成');
        break;

      case 'notifications/cancelled':
        logMcpInfo(`工具调用被取消: ${params?.requestId || '?'}`);
        break;

      default:
        logMcpInfo(`收到通知: ${method}`);
    }
  }

  /** 分发 JSON-RPC 请求 */
  private async dispatchRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method, params } = request;

    try {
      let result: any;

      switch (method) {
        case 'initialize':
          logMcpClientConnected(params?.clientInfo || {});
          result = this.handleInitialize(params);
          break;

        case 'tools/list':
          logMcpListTools();
          result = this.handleToolsList();
          break;

        case 'tools/call':
          result = await this.handleToolsCall(params);
          break;

        case 'prompts/list':
          result = { prompts: [] };
          break;

        case 'resources/list':
          result = { resources: [] };
          break;

        case 'ping':
          logMcpInfo('收到 ping');
          result = { pong: true };
          break;

        default:
          logMcpMethodNotFound(method);
          return {
            jsonrpc: '2.0',
            id: id!,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }

      return { jsonrpc: '2.0', id: id!, result };
    } catch (e: any) {
      logMcpToolError(method, e.message);
      return {
        jsonrpc: '2.0',
        id: id!,
        error: {
          code: -32603,
          message: `Internal error: ${e.message}`,
        },
      };
    }
  }

  /** 处理 initialize 握手 */
  private handleInitialize(params?: Record<string, any>): any {
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    };
  }

  /** 处理 tools/list */
  private handleToolsList(): any {
    const tools: McpTool[] = this.toolHandler.listTools();
    return { tools };
  }

  /** 处理 tools/call */
  private async handleToolsCall(params?: Record<string, any>): Promise<any> {
    if (!params?.name) {
      throw new Error('缺少 tool name');
    }

    const toolName = params.name;
    const toolArgs = params.arguments || {};

    logMcpToolCall(toolName, toolArgs);

    const result: McpToolResult = await this.toolHandler.callTool(toolName, toolArgs);
    const text = result.content?.[0]?.text || '';
    logMcpToolSuccess(toolName, text.length);
    return result;
  }

  /** 设置 CORS 头 */
  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}
