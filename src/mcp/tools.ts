import { ContestService } from '../api/contest';
import { ProblemService } from '../api/problem';
import { StateManager } from '../utils/state';
import { Contest, ProblemBrief, ProblemDetail } from '../types';

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
];

/**
 * MCP 工具处理器
 * 负责执行 tool 调用并返回结果
 */
export class McpToolHandler {
  private contestService: ContestService;
  private problemService: ProblemService;
  private state: StateManager;

  constructor(
    contestService: ContestService,
    problemService: ProblemService,
    state: StateManager,
  ) {
    this.contestService = contestService;
    this.problemService = problemService;
    this.state = state;
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
      default:
        return {
          content: [{ type: 'text', text: `未知工具: ${name}` }],
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
