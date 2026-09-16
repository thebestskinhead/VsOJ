/**
 * 【测试 · MCP 工具服务】
 *
 * MCP 通道里的四个测试工具（编译 / 本地测试 / 补测试用例 / 读最近结果）的实现。
 *
 * 分工与 `config/tools.ts` 一致：**零 vscode 依赖、全部靠注入**，「怎么装配依赖」
 * 留给 `extension.ts`。这样「编译报错时该说什么」「没跑过测试该说什么」这类文案
 * 与判定逻辑可以在纯 Node 里端到端测（真 g++、真样例文件）。
 *
 * ## 三条刻意的口径
 *
 * 1. **复用命令面板的同一条路径**：装配走 `buildTestDeps`、执行走 `LocalTestRunner`、
 *    描述走 `buildReport` —— MCP 与命令面板不会是两套行为，
 *    绝不会出现「AI 跑出来是通过、用户点一下是不通过」。
 * 2. **不弹结果页**：MCP 是给 AI 的通道，结果以文本返回。用户界面里刷屏会打断刷题；
 *    想看图，命令面板里有。（`result.json` / `report.md` 照常落盘。）
 * 3. **读最近结果不重跑**：`getLastTestResult` 只读盘 + 判过期，不触发编译/执行 ——
 *    否则「复核一下刚才的结论」这种动作会变成每次几秒的重新编译。
 */

import { BuildTestDepsResult } from './wiring';
import { LocalTestRunner, RunnerDeps, TestRunResult, buildReport, sha1 } from './runner';
import { ProblemLocalResources } from '../workspace/resources';

export interface TestToolDeps {
  /** 装配一次测试的全部依赖（扩展侧包 `buildTestDeps`） */
  buildDeps: (
    cid: string,
    pid: string,
    opts: { forceRebuild?: boolean; title?: string; sourceFileName?: string },
  ) => Promise<BuildTestDepsResult>;
  /**
   * 写入一组样例（`samples/<index>.in` / `.out`）。
   *
   * 「路径怎么拼、写进哪个目录」由扩展侧决定（这里只认序号与内容），
   * 与 `resources` 同一条分工：本模块不拼路径。
   */
  writeSample: (opts: {
    cid: string;
    pid: string;
    index: number;
    input: string;
    output: string;
  }) => Promise<{ ok: boolean; inputFile: string; outputFile: string; error?: string }>;
  /** 当前题目（AI 不传 cid/pid 时用） */
  currentTarget: () => { cid?: string; pid?: string; title?: string };
  /** 题目本地资源（样例与产物路径）；比赛目录未建立时返回 undefined */
  resources: (cid: string, pid: string) => Promise<ProblemLocalResources | undefined>;
  /** 读文本文件（不存在返回 undefined） */
  readText: (file: string) => string | undefined;
  /** 读源码文本（判过期用）；优先取未保存的内存文档 */
  readSource: (file: string) => string | undefined;
  log?: (msg: string) => void;
}

/** 题目定位结果：要么给出 cid/pid，要么给一段可操作的话 */
type TargetResolution = { cid: string; pid: string; title: string } | { error: string };

/** `RunFailureReason` 的中文话（与结果页 / 报告同一套说法） */
const REASON_LABEL: Record<string, string> = {
  'toolchain-missing': '工具链不可用',
  'build-failed': '编译失败',
  'no-cases': '没有可用的用例',
  cancelled: '已取消',
};

export class TestToolService {
  constructor(private readonly deps: TestToolDeps) {}

  /**
   * 只编译，不跑样例、不判定、不写 `result.json`。
   *
   * 存在的理由：AI 改完代码想知道「编译过不过」，不该被迫付「跑完所有样例」的时间；
   * 编译错误原文在这里直接拿到，不用去翻 Debug 频道。
   */
  async compileProblem(args: Record<string, any>): Promise<string> {
    const t = this.resolveTarget(args);
    if ('error' in t) { return t.error; }

    const built = await this.deps.buildDeps(t.cid, t.pid, this.buildOpts(args, t.title));
    if (!built.ok) {
      return `编译没能开始 · ${this.nameOf(t)}\n\n${built.error}`;
    }

    const def = built.def;
    const prepared = await new LocalTestRunner(built.deps).prepareOnly();
    const notes = this.notesOf(built.notes);

    if (!prepared.ok) {
      return [
        `编译失败 · ${this.nameOf(t)} · 工具链 ${def.label}（${def.id}）`,
        prepared.build.command ? `命令：${prepared.build.command}` : '命令：（未执行）',
        notes,
        '',
        '编译器输出：',
        '```',
        prepared.message || prepared.build.output || '（编译器没有输出）',
        '```',
      ].filter((x) => x !== '').join('\n');
    }

    return [
      `编译成功 · ${this.nameOf(t)} · 工具链 ${def.label}（${def.id}）`,
      `命令：${prepared.build.command}`
        + `（${prepared.build.reused ? '复用上次产物' : `${prepared.build.durationMs} ms`}）`,
      `产物：${prepared.build.runnable}`,
      `运行命令：${prepared.argv.join(' ')}`,
      `工作目录：${prepared.cwd}`,
      notes,
    ].filter((x) => x !== '').join('\n');
  }

  /**
   * 编译 + 跑样例 + 逐例判定 + 落盘 `result.json` / `report.md`。
   *
   * 正文直接用 `buildReport()` —— 与用户在 `report.md` 里看到的逐字一致，
   * 不另写一份「给 AI 看的简版」（两套说法迟早在措辞或字段上分叉）。
   */
  async runLocalTest(args: Record<string, any>): Promise<string> {
    const t = this.resolveTarget(args);
    if ('error' in t) { return t.error; }

    const built = await this.deps.buildDeps(t.cid, t.pid, this.buildOpts(args, t.title));
    if (!built.ok) {
      return `测试没能开始 · ${this.nameOf(t)}\n\n${built.error}`;
    }

    const deps = built.deps;
    const r = await new LocalTestRunner(deps).run();
    const summary = `共 ${r.summary.total} 组，通过 ${r.summary.passed}，不通过 ${r.summary.failed}`
      + (r.summary.skipped ? `，跳过 ${r.summary.skipped}` : '');

    return [
      `本地测试 · ${this.nameOf(t)} · 工具链 ${r.toolchain.label}（${r.toolchain.id}）`,
      r.ok ? summary : `测试没能跑起来：${REASON_LABEL[r.reason ?? ''] ?? r.reason}`,
      this.notesOf(built.notes),
      '',
      buildReport(r, deps),
      '',
      `- 结果产物：${r.resultFile ?? deps.resultFile}`,
      `- 报告（含期望/实际全文）：${r.reportFile ?? deps.reportFile}`,
      '- 结果页未自动打开（MCP 通道只回文本）；要看页面用命令面板的「本地测试」。',
    ].filter((x) => x !== '').join('\n');
  }

  /**
   * 读最近一次本地测试的结果，**不重跑**。
   *
   * 正常情况直接回 `report.md` 原文（它就是那次运行落下的唯一权威文本）；
   * 报告被删了就退回用 `result.json` 重新渲染（`buildReport` 是同一个函数）。
   * 无论哪条路，都会比对源码哈希判断结果是否已过期。
   */
  async getLastTestResult(args: Record<string, any>): Promise<string> {
    const t = this.resolveTarget(args);
    if ('error' in t) { return t.error; }

    const res = await this.deps.resources(t.cid, t.pid);
    if (!res) {
      return `比赛 ${t.cid} 的工作目录还没建立：先在侧边栏进入这场比赛。`;
    }
    if (!res.hasResult) {
      return [
        `这道题还没跑过本地测试 · ${this.nameOf(t)}`,
        `结果文件还不存在：${res.resultFile}`,
        `先让 AI 或用户跑一次（MCP 的 run_local_test，或命令面板的「本地测试」）。`,
        `样例目录：${res.samplesDir}（当前成对可跑的序号：${res.runnableSampleIndexes.join('、') || '无'}）`,
      ].join('\n');
    }

    const raw = this.deps.readText(res.resultFile);
    if (!raw) {
      return `读不到结果文件（可能存在但无权限）：${res.resultFile}`;
    }
    let r: TestRunResult;
    try {
      r = JSON.parse(raw) as TestRunResult;
    } catch {
      return `结果文件不是合法 JSON（可能被外部改动过）：${res.resultFile}`;
    }

    const stale = this.isStale(r);

    if (String(args?.format ?? 'markdown') === 'json') {
      return JSON.stringify({ stale, fetchedFrom: res.resultFile, result: r }, null, 2);
    }

    const head: string[] = [];
    if (stale) {
      head.push('⚠ 源文件在那次测试之后被改动过 —— 这份结果可能已过期（结果不会被自动删除或更新）。');
      head.push('');
    }
    const body = this.deps.readText(res.reportFile) ?? buildReport(r, this.depsFor(res, r));
    return [
      ...head,
      body,
      '',
      `- 结果产物：${res.resultFile}`,
      `- 报告：${res.reportFile}`,
    ].join('\n');
  }

  /**
   * 【补测试数据】添加一组测试用例（标准输入 + 期望输出），写入 `samples/<序号>.in` / `.out`。
   *
   * 站点样例不够用时（只有一组、或想补边界数据）由 AI 自己造 —— 补完 `run_local_test`
   * 会把它一起跑。不传 `index` 时**追加到最后一组之后**；显式传 `index` 则覆盖 / 新建该序号。
   *
   * 成功也要把「现在的用例清单」一并回去：AI 需要知道下一组该用几号、有没有半对的。
   */
  async addTestCase(args: Record<string, any>): Promise<string> {
    const t = this.resolveTarget(args);
    if ('error' in t) { return t.error; }

    const input = args?.input;
    const output = args?.output;
    if (typeof input !== 'string' || typeof output !== 'string') {
      return '添加失败：input 与 output 都必须是字符串（没有输入时传空字符串 ""，不能省略）。';
    }

    const res = await this.deps.resources(t.cid, t.pid);
    if (!res) {
      return `比赛 ${t.cid} 的工作目录还没建立：先在侧边栏进入这场比赛（会建目录），再补测试用例。`;
    }

    const index = this.pickSampleIndex(args, res.samples.map((s) => s.index));
    if (typeof index === 'string') { return index; }

    const existed = res.samples.some((s) => s.index === index);
    const w = await this.deps.writeSample({ cid: t.cid, pid: t.pid, index, input, output });
    if (!w.ok) {
      return `添加测试用例失败 · ${this.nameOf(t)}\n${w.error ?? '写入样例文件失败。'}`;
    }

    // 写完重新读一次：清单以磁盘为准（成对 / 半对由同一套 discoverCases 判定，不自己算）
    const after = (await this.deps.resources(t.cid, t.pid)) ?? res;
    const pairs = after.samples.filter((s) => s.hasInput && s.hasOutput).map((s) => s.index);
    const half = after.samples.filter((s) => !(s.hasInput && s.hasOutput));

    return [
      `已添加测试用例 ${index}（${existed ? '覆盖原有用例' : '新增'}）· ${this.nameOf(t)}`,
      `- 输入：${w.inputFile}`,
      `- 期望输出：${w.outputFile}`,
      `- 当前成对可跑：${pairs.join('、') || '无'}`,
      ...(half.length
        ? [`- 半对（会被跳过）：${half.map((s) => `${s.index}（缺 ${s.hasInput ? '.out' : '.in'}）`).join('、')}`]
        : []),
      '',
      '下一步：run_local_test 会执行全部成对样例。',
      '注意：samples/ 属于缓存目录，「清理缓存」会删除它（源文件与 test/ 里的结果会保留）。',
    ].join('\n');
  }

  // ─────────────────────────────────────────────────────────
  // 内部
  // ─────────────────────────────────────────────────────────

  /** 定位题目：显式参数优先，否则用当前打开的题目 */
  private resolveTarget(args: Record<string, any>): TargetResolution {
    const cur = this.deps.currentTarget();
    const cid = String(args?.cid ?? cur.cid ?? '').trim();
    const pid = String(args?.pid ?? cur.pid ?? '').trim();
    if (!cid) {
      return { error: '未指定比赛（cid），且当前没有进入任何比赛。请先在侧边栏进入一场比赛，或显式传 cid。' };
    }
    if (!pid) {
      return { error: `未指定题目（pid），且当前没有打开任何题目。请先打开这道题的题面，或显式传 pid。` };
    }
    const isCurrent = String(cur.cid ?? '') === cid && String(cur.pid ?? '') === pid;
    return { cid, pid, title: isCurrent ? (cur.title ?? '') : '' };
  }

  private nameOf(t: { cid: string; pid: string; title: string }): string {
    return t.title ? `题目 ${t.cid}-${t.pid}《${t.title}》` : `题目 ${t.cid}-${t.pid}`;
  }

  /**
   * 装配参数。
   *
   * **`rebuild` 只在显式为 `true` 时才传**：`buildTestDeps` 用
   * `opts.forceRebuild ?? !isBuildReuseEnabled()` 决定要不要复用产物，
   * 一旦传了 `false` 就等于「显式要求不复用」，会把 `oj.test.reuseBuild` 静默压掉 ——
   * MCP 于是与命令面板行为相反（配置说复用，MCP 每次重编；配置说不复用，MCP 偷偷复用）。
   * 所以「没传 / 传 false」一律当**没有意见**，让配置说了算。
   */
  private buildOpts(
    args: Record<string, any>,
    title: string,
  ): { forceRebuild?: boolean; title?: string; sourceFileName?: string } {
    // `source` 只做去空白：是不是「题目目录内的文件名」由 buildTestDeps 判定 ——
    // 只有它知道题目目录在哪，拒绝的理由也该在那一层给。
    const source = typeof args?.source === 'string' ? args.source.trim() : '';
    return {
      ...(args?.rebuild === true ? { forceRebuild: true } : {}),
      ...(title ? { title } : {}),
      ...(source ? { sourceFileName: source } : {}),
    };
  }

  /**
   * 决定写到第几号。
   *
   * 不传 `index` = 追加到最后一组之后（站点的单组样例是 1，所以下一条是 2）；
   * 传了就必须是 ≥ 1 的整数，否则返回一段可操作的文案（而不是抛错）。
   */
  private pickSampleIndex(args: Record<string, any>, existing: number[]): number | string {
    const raw = args?.index;
    if (raw === undefined || raw === null || raw === '') {
      return existing.reduce((m, i) => Math.max(m, i), 0) + 1;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      return `添加失败：index 必须是不小于 1 的整数（收到 ${JSON.stringify(raw)}）。`
        + '不传 index 则自动追加到最后一组之后。';
    }
    return n;
  }

  /** `toolchains.json` 的问题（文件不存在等）不静默 —— 它会让工具链「看起来」不对 */
  private notesOf(notes: string[]): string {
    return notes.map((n) => `提示：${n}`).join('\n');
  }

  /** 结果是否已过期（源文件哈希对不上）；读不到源码时按「不过期」处理，不误报 */
  private isStale(r: TestRunResult): boolean {
    const file = r?.source?.file;
    const hash = r?.source?.hash;
    if (!file || !hash) { return false; }
    const text = this.deps.readSource(file);
    if (text === undefined) { return false; }
    return sha1(text) !== hash;
  }

  /** 用题目资源重建「报告渲染」所需的最小依赖（样例路径取真实值，不靠推断） */
  private depsFor(res: ProblemLocalResources, r: TestRunResult): Pick<RunnerDeps, 'tempDir' | 'cases'> {
    const byIndex = new Map(res.samples.map((s) => [s.index, s]));
    return {
      tempDir: res.tempDir,
      cases: (r.cases ?? []).map((c) => {
        const s = byIndex.get(c.index);
        return { index: c.index, inputFile: s?.input ?? '', expectedFile: s?.output ?? '' };
      }),
    };
  }
}
