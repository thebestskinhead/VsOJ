import { ContestService } from '../api/contest';
import { ProblemService } from '../api/problem';
import { StateManager } from '../utils/state';
import { Contest, ProblemBrief, ProblemDetail } from '../types';
import { ConfigToolService } from '../config/tools';

/** MCP Tool 定义 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, {
      type: string;
      description: string;
      default?: any;
      /** 数组/对象的元素声明（`init_config` 的 toolchains 需要） */
      items?: any;
      enum?: any[];
      additionalProperties?: any;
    }>;
    required: string[];
  };
}

/** MCP Tool 调用结果 */
export interface McpToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

/** 工具注册表 */
const TOOLS: McpTool[] = [
  {
    name: 'get_contest_problems',
    description: '获取比赛题目列表。如果不指定cid，则返回当前已进入的比赛的所有题目。包含题目编号、标题、AC状态等信息。',
    inputSchema: {
      type: 'object',
      properties: {
        cid: {
          type: 'string',
          description: '比赛ID（可选，不传则使用当前比赛）',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_current_problem',
    description: '获取题目详细内容。默认返回当前打开的题目，也可通过参数指定任意比赛和题目。包括题目描述、输入说明、输出说明、样例输入输出等。',
    inputSchema: {
      type: 'object',
      properties: {
        cid: {
          type: 'string',
          description: '比赛ID（可选，不传则使用当前比赛）',
        },
        pid: {
          type: 'string',
          description: '题目ID（可选，不传则使用当前题目）',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_contest_list',
    description: '获取比赛列表。可以分页获取所有可见的比赛信息，包含比赛ID、标题、状态等。',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'number',
          description: '页码，从1开始（默认: 1）',
          default: 1,
        },
        keyword: {
          type: 'string',
          description: '搜索关键词（可选）',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_config_manual',
    description: '【配置本插件前先读这个】读取 VsOJ 插件的配置说明书：全部 oj.* 配置项的类型/默认值/取值/示例/常见坑、'
      + 'toolchains.json 的字段与文件格式、命令查找与 PATH 注入规则、以及初始化配置的标准步骤。'
      + '插件不内置任何个人环境路径，配置它需要先知道「有哪些可配、怎么配、哪里一踩就废」——这份说明书就是答案。',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: '只取某一部分（默认 all 全文）：quickstart 初始化步骤 / settings 全部配置项 / '
            + 'toolchains 工具链定义格式 / files 配置文件位置 / pitfalls 常见坑 / all 全部',
          default: 'all',
          enum: ['all', 'quickstart', 'settings', 'toolchains', 'files', 'pitfalls'],
        },
        format: {
          type: 'string',
          description: 'markdown（默认，含语义、示例与坑）或 json（机器可读、更省 token，但不含解释性文字）',
          default: 'markdown',
          enum: ['markdown', 'json'],
        },
      },
      required: [],
    },
  },
  {
    name: 'init_config',
    description: '初始化 / 更新 VsOJ 配置。**插件不猜你的机器**：它不内置任何个人环境路径、也不扫盘找编译器，'
      + '编译器位置由调用方探测后通过 toolchains 传入（只写要覆盖的字段即可，其余继承内置定义）。'
      + '默认**只预览不落盘**，返回「当前值 → 将写入值 + 命令解析结果」；确认后带 apply:true 再调一次才写盘，'
      + '覆盖旧文件前会自动备份。计划中存在错误（键名打错、值类型不对、工具链定义非法）时**拒绝落盘**。'
      + '`settings` 的值写 null 表示该项重置回默认。',
    inputSchema: {
      type: 'object',
      properties: {
        settings: {
          type: 'object',
          description: '要写入的 oj.* 配置项。键可带或不带 `oj.` 前缀（如 baseUrl 或 oj.baseUrl）。'
            + '值写 null 表示重置回默认值。例：{"oj.baseUrl":"http://acm.example.edu.cn","oj.mcp.enabled":true}',
          additionalProperties: true,
        },
        toolchains: {
          type: 'array',
          description: '工具链覆盖 / 新增。只需写要覆盖的字段，其余继承内置定义。'
            + '例：[{"id":"cpp-g++","commands":{"gpp":["D:\\\\tools\\\\mingw64\\\\bin\\\\g++.exe"]},'
            + '"pathPrepend":["D:\\\\tools\\\\mingw64\\\\bin"]}]',
          items: { type: 'object' },
        },
        toolchainMode: {
          type: 'string',
          description: 'merge（默认）保留文件里已有的其它定义；replace 整份重写',
          default: 'merge',
          enum: ['merge', 'replace'],
        },
        scope: {
          type: 'string',
          description: 'workspace（默认）写当前工作区设置；global 写全局 User 设置（所有项目生效）',
          default: 'workspace',
          enum: ['workspace', 'global'],
        },
        apply: {
          type: 'boolean',
          description: '省略或 false = 只预览不落盘；true = 真的写入配置',
          default: false,
        },
      },
      required: [],
    },
  },
];

/**
 * MCP 工具处理器
 * 负责执行 tool 调用并返回结果
 */
export class McpToolHandler {
  private contestService: ContestService;
  private problemService: ProblemService;
  private state: StateManager;
  private configService?: ConfigToolService;

  constructor(
    contestService: ContestService,
    problemService: ProblemService,
    state: StateManager,
    configService?: ConfigToolService,
  ) {
    this.contestService = contestService;
    this.problemService = problemService;
    this.state = state;
    this.configService = configService;
  }

  /** 返回所有注册的 tool 列表 */
  listTools(): McpTool[] {
    return TOOLS;
  }

  /** 执行 tool 调用 */
  async callTool(name: string, args: Record<string, any>): Promise<McpToolResult> {
    switch (name) {
      case 'get_contest_problems':
        return this.handleGetContestProblems(args);
      case 'get_current_problem':
        return this.handleGetCurrentProblem(args);
      case 'get_contest_list':
        return this.handleGetContestList(args);
      case 'get_config_manual':
        return this.handleGetConfigManual(args);
      case 'init_config':
        return this.handleInitConfig(args);
      default:
        return {
          content: [{ type: 'text', text: `未知工具: ${name}` }],
        };
    }
  }

  /** 配置说明书 —— 纯读，不碰磁盘 */
  private handleGetConfigManual(args: Record<string, any>): McpToolResult {
    if (!this.configService) {
      return {
        content: [{
          type: 'text',
          text: '配置工具不可用：插件未提供配置目录（通常是安装包不含 package.json）。',
        }],
      };
    }
    const r = this.configService.getManual(args);
    return { content: [{ type: 'text', text: r.text }] };
  }

  /** 初始化配置 —— 默认只预览，`apply: true` 才落盘 */
  private async handleInitConfig(args: Record<string, any>): Promise<McpToolResult> {
    if (!this.configService) {
      return {
        content: [{
          type: 'text',
          text: '配置工具不可用：插件未接线配置读写 IO。',
        }],
      };
    }
    try {
      const r = await this.configService.initConfig(args);
      return { content: [{ type: 'text', text: r.text }] };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `初始化配置失败: ${e?.message ?? e}` }],
      };
    }
  }

  /** 获取比赛题目列表 */
  private async handleGetContestProblems(args: Record<string, any>): Promise<McpToolResult> {
    try {
      const cid = args.cid || this.state.getCurrentCid();
      if (!cid) {
        return {
          content: [{
            type: 'text',
            text: '错误: 未指定比赛ID，且当前没有进入任何比赛。请先在插件中进入一个比赛，或指定cid参数。',
          }],
        };
      }

      const { title, problems } = await this.contestService.fetchProblemList(cid);

      const problemList: unknown[] = problems.map((p: ProblemBrief) => ({
        pid: p.pid,
        title: p.title,
        status: p.status,
        acceptedCount: p.acceptedCount,
        submissionCount: p.submissionCount,
      }));

      const result = {
        cid,
        contestTitle: title,
        problemCount: problems.length,
        problems: problemList,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `获取题目列表失败: ${e.message}` }],
      };
    }
  }

  /** 获取题目详情 — 默认当前题目，也可通过参数指定 */
  private async handleGetCurrentProblem(args: Record<string, any>): Promise<McpToolResult> {
    try {
      const cid = args.cid || this.state.getCurrentCid();
      const pid = args.pid || this.state.getCurrentPid();

      if (!cid || !pid) {
        return {
          content: [{
            type: 'text',
            text: '错误: 未指定比赛ID和题目ID，且当前没有打开任何题目。请先在插件中打开一个题目，或指定cid和pid参数。',
          }],
        };
      }

      const detail: ProblemDetail = await this.problemService.fetchProblem(cid, pid);

      const result = {
        cid: detail.cid,
        pid: detail.pid,
        title: detail.title,
        description: stripHtml(detail.description),
        inputDesc: stripHtml(detail.inputDesc),
        outputDesc: stripHtml(detail.outputDesc),
        sampleInput: detail.sampleInput,
        sampleOutput: detail.sampleOutput,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `获取题目内容失败: ${e.message}` }],
      };
    }
  }

  /** 获取比赛列表 */
  private async handleGetContestList(args: Record<string, any>): Promise<McpToolResult> {
    try {
      const page = args.page ?? 1;
      const keyword = args.keyword;

      const { rows, pagination } = await this.contestService.fetchList(page, keyword);

      const contestList: unknown[] = rows.map((c: Contest) => ({
        cid: c.cid,
        title: c.title,
        status: c.status,
        private: c.private,
        creator: c.creator,
      }));

      const result = {
        page: pagination.current,
        totalPages: pagination.total,
        contests: contestList,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `获取比赛列表失败: ${e.message}` }],
      };
    }
  }
}

/** 去除 HTML 标签，保留纯文本 */
function stripHtml(html: string): string {
  if (!html) { return ''; }
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
