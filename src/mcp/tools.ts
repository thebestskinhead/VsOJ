import { ContestService, FetchMeta } from '../api/contest';
import { ProblemService } from '../api/problem';
import { StateManager } from '../utils/state';
import { Contest, ProblemBrief, ProblemDetail } from '../types';
import { ConfigToolService } from '../config/tools';
import { TestToolService } from '../test/tools';
import { ProblemLocalResources } from '../workspace/resources';
import { OfflineNoCacheError } from '../cache/store';
import { LoginRequiredError } from '../session/access';

/**
 * 工具取数失败的文案。
 *
 * 三类失败必须讲成三件事，AI 才不会统统转述成"失败了"：
 *  - **未登录**：内容与缓存都不提供，得让用户先登录
 *  - **离线且无缓存**：先联网（或关掉离线模式）把缓存刷出来
 *  - 其它（无权限 / 不存在 / 网络）：照实说
 */
function describeToolError(prefix: string, e: any): string {
  if (e instanceof LoginRequiredError || e?.code === 'LOGIN_REQUIRED') {
    return `${prefix}：${e.message}。未登录时不提供比赛列表与题面，本地缓存也不会被读出 —— `
      + '请先在 VS Code 里执行「OJ: 登录」（或点侧边栏的比赛/题目条目），登录后重试。';
  }
  if (e instanceof OfflineNoCacheError || e?.code === 'OFFLINE_NO_CACHE') {
    return `${prefix}：${e.message}。当前处于离线状态，需联网刷新缓存后再试。`;
  }
  return `${prefix}: ${e.message}`;
}

/** 取数来源（缓存 / 站点 + 缓存年龄），随结果一起交给 AI，便于其判断数据新旧 */
function dataSourceOf(meta?: FetchMeta): Record<string, unknown> | undefined {
  if (!meta) { return undefined; }
  return { from: meta.source === 'cache' ? 'local-cache' : 'site', cacheAgeMs: meta.ageMs };
}

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
    description: '获取比赛题目列表。如果不指定cid，则返回当前已进入的比赛的所有题目。包含题目编号、标题、AC状态等信息。'
      + '需要登录：未登录时一律拒绝（题目名也算内容），离线时改读本地缓存并支持读取过期内容。'
      + '结果里的 `dataSource` 标明来自本地缓存还是站点、缓存了多久；'
      + '离线且本地无缓存时会明确报错，而不是返回空列表。',
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
    description: '获取题目详细内容。默认返回当前打开的题目，也可通过参数指定任意比赛和题目。'
      + '包括题目描述、输入说明、输出说明、样例输入输出；'
      + '以及 `local` 段 —— 这道题在本机的落点：源文件、样例（成对的会被本地测试执行）、'
      + '题面图片、测试产物与报告的**绝对路径**。'
      + '题面里的图只看路径（不内联图片数据）：直接读 `local.assets` 里的文件即可。'
      + '需要登录：未登录时一律拒绝，本地缓存的题面也不会被读出；离线时改读本地缓存'
      + '（这正是离线做题的用法）。超过 `oj.cache.staleSeconds` 时会在后台补拉一次最新。'
      + '结果里的 `dataSource` 标明来自本地缓存还是站点、缓存了多久 —— 拿它判断该不该提示用户刷新。',
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
    description: '获取比赛列表。可以分页获取所有可见的比赛信息，包含比赛ID、标题、状态等。'
      + '需要登录：未登录时一律拒绝（站点对未登录用户是放开的，拒绝由本机把关），'
      + '离线时改读本地缓存并支持读取过期内容。结果里的 `dataSource` 标明来自本地缓存还是站点、缓存了多久。',
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
  {
    name: 'add_test_case',
    description: '【补测试数据】为题目添加一组测试用例（标准输入 + 期望输出），'
      + '写入 samples/<序号>.in 与 .out；之后 run_local_test 会把所有成对样例一起跑。'
      + '站点样例不够用时用它补（只有一组、或想加边界数据）。'
      + '不传 index 时自动追加到最后一组之后；传 index 则覆盖 / 新建该序号。'
      + '注意：samples/ 属于缓存目录，执行「清理缓存」会删除它（源文件与 test/ 结果不受影响）。',
    inputSchema: {
      type: 'object',
      properties: {
        cid: {
          type: 'string',
          description: '比赛ID（可选，不传则用当前比赛）',
        },
        pid: {
          type: 'string',
          description: '题目ID（可选，不传则用当前打开的题目）',
        },
        index: {
          type: 'number',
          description: '用例序号，从 1 开始（可选，不传则追加到最后一组之后）',
        },
        input: {
          type: 'string',
          description: '标准输入全文（没有输入时传空字符串 ""）',
        },
        output: {
          type: 'string',
          description: '期望输出全文（判定时先做换行归一化，再逐字节比对）',
        },
      },
      required: ['input', 'output'],
    },
  },
  {
    name: 'compile_problem',
    description: '【本地验证第一步】只编译当前题目，不跑样例、不判定、不写结果文件。'
      + '用来快速确认「编译过不过」：编译失败时直接返回编译器原文（不用去翻插件日志），'
      + '成功时返回实际执行的命令、产物路径与运行命令。'
      + '比 run_local_test 快（不跑样例），适合改完代码先探一次。',
    inputSchema: {
      type: 'object',
      properties: {
        cid: {
          type: 'string',
          description: '比赛ID（可选，不传则用当前比赛）',
        },
        pid: {
          type: 'string',
          description: '题目ID（可选，不传则用当前打开的题目）',
        },
        source: {
          type: 'string',
          description: '要编译的源文件名（可选，默认用 oj.project.sourceFileName，通常 main.cpp）。'
            + '只能是题目目录内的文件名，不能带路径 —— 编译只发生在这道题的目录里。',
        },
        rebuild: {
          type: 'boolean',
          description: 'true = 无视产物复用配置强制重新编译（默认 false，按 oj.test.reuseBuild 走）',
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: 'run_local_test',
    description: '【本地验证第二步 · 主入口】把题目的源码编译、跑 samples/ 下的全部成对样例、'
      + '逐字节比对判定，并落盘 result.json 与 report.md，返回与 report.md 逐字一致的报告文本'
      + '（含每条用例判定、不通过用例的期望/实际输出与首个差异定位）。'
      + '判定口径与站点一致（CRLF 归一化后严格逐字节）。'
      + '**不会弹出结果页**；想让用户看到页面走命令面板的「本地测试」。'
      + '跑之前先确认题目已初始化（samples/ 有成对样例），否则会返回「没有可用的用例」。',
    inputSchema: {
      type: 'object',
      properties: {
        cid: {
          type: 'string',
          description: '比赛ID（可选，不传则用当前比赛）',
        },
        pid: {
          type: 'string',
          description: '题目ID（可选，不传则用当前打开的题目）',
        },
        source: {
          type: 'string',
          description: '要编译 / 运行的源文件名（可选，默认用 oj.project.sourceFileName，通常 main.cpp）。'
            + '只能是题目目录内的文件名，不能带路径。',
        },
        rebuild: {
          type: 'boolean',
          description: 'true = 强制重新编译（默认 false，源文件未变则可能复用上次产物）',
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: 'get_last_test_result',
    description: '【复核用】读上一次本地测试的结果，**不重跑、不编译**。'
      + '返回那次测试的报告文本，并比对源码哈希判断结果是否已过期（源文件改过会在开头标出来）。'
      + '适合「刚才结论是什么」「用户说改了代码，结果还作数吗」这类追问。'
      + '还没跑过时返回可操作提示（结果文件路径 + 当前可跑样例序号）。',
    inputSchema: {
      type: 'object',
      properties: {
        cid: {
          type: 'string',
          description: '比赛ID（可选，不传则用当前比赛）',
        },
        pid: {
          type: 'string',
          description: '题目ID（可选，不传则用当前打开的题目）',
        },
        format: {
          type: 'string',
          description: 'markdown（默认，报告全文）或 json（原始 result.json + 过期标记，机器可读）',
          default: 'markdown',
          enum: ['markdown', 'json'],
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
  private testService?: TestToolService;
  private problemResources?: (cid: string, pid: string) => Promise<ProblemLocalResources | undefined>;

  constructor(
    contestService: ContestService,
    problemService: ProblemService,
    state: StateManager,
    configService?: ConfigToolService,
    testService?: TestToolService,
    problemResources?: (cid: string, pid: string) => Promise<ProblemLocalResources | undefined>,
  ) {
    this.contestService = contestService;
    this.problemService = problemService;
    this.state = state;
    this.configService = configService;
    this.testService = testService;
    this.problemResources = problemResources;
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
      case 'compile_problem':
        return this.handleCompileProblem(args);
      case 'run_local_test':
        return this.handleRunLocalTest(args);
      case 'add_test_case':
        return this.handleAddTestCase(args);
      case 'get_last_test_result':
        return this.handleGetLastTestResult(args);
      default:
        return {
          content: [{ type: 'text', text: `未知工具: ${name}` }],
        };
    }
  }

  /** 测试工具不可用时的统一回复（插件没接线时不该静默返回空结果） */
  private testServiceMissing(): McpToolResult {
    return {
      content: [{
        type: 'text',
        text: '测试工具不可用：插件未接线本地测试引擎。',
      }],
    };
  }

  /** 只编译 */
  private async handleCompileProblem(args: Record<string, any>): Promise<McpToolResult> {
    if (!this.testService) { return this.testServiceMissing(); }
    try {
      return { content: [{ type: 'text', text: await this.testService.compileProblem(args) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `编译失败（引擎异常）: ${e?.message ?? e}` }] };
    }
  }

  /** 编译 + 跑样例 + 判定 */
  private async handleRunLocalTest(args: Record<string, any>): Promise<McpToolResult> {
    if (!this.testService) { return this.testServiceMissing(); }
    try {
      return { content: [{ type: 'text', text: await this.testService.runLocalTest(args) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `本地测试失败（引擎异常）: ${e?.message ?? e}` }] };
    }
  }

  /** 读最近结果（不重跑） */
  private async handleGetLastTestResult(args: Record<string, any>): Promise<McpToolResult> {
    if (!this.testService) { return this.testServiceMissing(); }
    try {
      return { content: [{ type: 'text', text: await this.testService.getLastTestResult(args) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `读取最近结果失败: ${e?.message ?? e}` }] };
    }
  }

  /** 补一组测试用例（写入 samples/） */
  private async handleAddTestCase(args: Record<string, any>): Promise<McpToolResult> {
    if (!this.testService) { return this.testServiceMissing(); }
    try {
      return { content: [{ type: 'text', text: await this.testService.addTestCase(args) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `添加测试用例失败: ${e?.message ?? e}` }] };
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

      const { title, problems, meta } = await this.contestService.fetchProblemList(cid);

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
        dataSource: dataSourceOf(meta),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: describeToolError('获取题目列表失败', e) }],
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

      const loaded = await this.problemService.fetchProblem(cid, pid);
      const detail: ProblemDetail = loaded.detail;

      const result = {
        cid: detail.cid,
        pid: detail.pid,
        title: detail.title,
        description: stripHtml(detail.description),
        inputDesc: stripHtml(detail.inputDesc),
        outputDesc: stripHtml(detail.outputDesc),
        sampleInput: detail.sampleInput,
        sampleOutput: detail.sampleOutput,
        // 本地落点：题面图片与样例都已在本地缓存（初始化这题时抓的），
        // 直接给绝对路径，需要时自己读 —— 不内联 base64（决策 D11），也不另开读图工具
        local: await this.collectLocal(cid, pid),
        dataSource: {
          from: loaded.source === 'cache' ? 'local-cache' : 'site',
          cacheAgeMs: loaded.ageMs,
          /** 缓存已过期、已在后台补拉：需要最新的话稍后再读一次 */
          refreshing: loaded.refreshing,
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: describeToolError('获取题目内容失败', e) }],
      };
    }
  }

  /**
   * 题目的本地资源（源文件 / 样例 / 题面图片 / 产物路径）。
   *
   * 比赛目录还没建立时**不报错**：题面本身仍然有价值，这里只说明「还没有本地目录」
   * 以及怎么建 —— 拿不到路径不是失败，是「还没初始化」。
   */
  private async collectLocal(cid: string, pid: string): Promise<unknown> {
    if (!this.problemResources) {
      return { available: false, note: '插件未接线本地资源查询。' };
    }
    let res: ProblemLocalResources | undefined;
    try {
      res = await this.problemResources(cid, pid);
    } catch (e: any) {
      return { available: false, note: `读取本地资源失败：${e?.message ?? e}` };
    }
    if (!res) {
      return {
        available: false,
        note: `比赛 ${cid} 的本地目录还没建立：先在侧边栏进入这场比赛`
          + '（会建目录，并抓下样例与题面图片）。',
      };
    }

    const runnable = new Set(res.runnableSampleIndexes);
    return {
      available: true,
      dir: res.dir,
      sourceFile: res.sourceFile,
      sourceFileExists: res.sourceFileExists,
      samplesDir: res.samplesDir,
      assetsDir: res.assetsDir,
      tempDir: res.tempDir,
      resultFile: res.resultFile,
      reportFile: res.reportFile,
      hasTestResult: res.hasResult,
      samples: res.samples.map((s) => ({
        index: s.index,
        input: s.input,
        output: s.output,
        hasInput: s.hasInput,
        hasOutput: s.hasOutput,
        runnable: runnable.has(s.index),
      })),
      skippedSamples: res.skipped.map((s) => ({ index: s.index, reason: s.reason })),
      assets: res.assets,
      note: '题面图片与样例都已在本地（初始化这题时抓取，离线也在）；'
        + '要看图片直接读 assets 里的绝对路径。样例只有成对的（runnable=true）会被本地测试执行。',
    };
  }

  /** 获取比赛列表 */
  private async handleGetContestList(args: Record<string, any>): Promise<McpToolResult> {
    try {
      const page = args.page ?? 1;
      const keyword = args.keyword;

      const { rows, pagination, meta } = await this.contestService.fetchList(page, keyword);

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
        dataSource: dataSourceOf(meta),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: describeToolError('获取比赛列表失败', e) }],
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
