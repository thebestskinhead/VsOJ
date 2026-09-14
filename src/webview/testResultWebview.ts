import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import {
  TestRunResult, CaseResult, CaseVerdict, RunFailureReason, Summary,
  RunnerDeps, casePreviews, runtimeText, sha1, OutputPreview,
} from '../test/runner';
import { formatBytes, escapeHtml } from '../utils/format';
import { getTestResultPageMode, TestResultPageMode } from '../utils/config';

/**
 * 【本地测试 · 结果页】
 *
 * 决策依据（见 `docs/PLAN_S6.md` §5.8）：
 *
 * - **D12 两级结构**：一级 = 用例状态列表；二级 = 该用例的期望 / 实际 / 差异明细。
 * - **D13 每次测试都弹**：由 `oj.test.resultPage` 控制（`always` / `onFailure` / `never`）。
 * - **D14 过期标记**：当前源文件哈希 ≠ `result.json` 里的 `sourceHash` → 标「结果可能已过期」。
 *
 * 两条贯穿设计的约束：
 *
 * 1. **零脚本**：页面全靠原生 `<details>` 展开，不注册任何消息通道。
 *    webview 因此不必开 `enableScripts`，页面里的程序输出也就没有可执行面
 *    （程序输出是不可信内容，能展示但不能执行）。
 * 2. **口径与报告一致**：文案与内容读取都复用引擎层的 `runtimeText()` /
 *    `casePreviews()`，报告里怎么写，页面上就怎么写（契约 C12）。
 *
 * 渲染是纯函数（`buildResultHtml`），面板只是薄壳：读文件 → 组装模型 → 塞 HTML。
 */

/** 单份展示文本（来自引擎层，保持与报告同源） */
export type { OutputPreview };

/** 一个用例在页面上的样子（引擎结构 → 视图结构） */
export interface CaseView {
  index: number;
  verdict: CaseVerdict;
  expectedBytes: number;
  actualBytes: number;
  /** 运行事实一行话（与报告同源） */
  runtimeText: string;
  durationMs: number;
  /** 首个差异的中文描述；通过时为 null */
  diffText: string | null;
  /** 差异定位的三个数（行 / 该行第几字节 / 字节偏移） */
  diffWhere: { line: number; byteColumn: number; offset: number } | null;
  watchdog: string | null;
  killReason: string | null;
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  input: OutputPreview;
  expected: OutputPreview;
  actual: OutputPreview;
}

export interface ResultPageModel {
  title: string;
  cid: string;
  pid: string;
  toolchain: { id: string; label: string; kind: string };
  sourceName: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  reason?: RunFailureReason;
  build: {
    ok: boolean; reused: boolean; durationMs: number;
    command: string; runnable: string; staged: boolean; output: string;
  };
  summary: Summary;
  cases: CaseView[];
  skipped: { index: number; reason: string }[];
  /** 工具链缺失时探测过的位置（让用户知道该往哪放编译器） */
  missingTools: { missing: string[]; tried: string[] } | null;
  /** 代码已改动 → 结果可能过期（D14） */
  stale: boolean;
  resultFile: string;
  reportFile: string;
}

// ─────────────────────────────────────────────────────────────
// 开关策略（纯函数，单测覆盖）
// ─────────────────────────────────────────────────────────────

/** 打开 / 聚焦决策：`always` 全弹，`onFailure` 只在没全过时弹，`never` 不弹 */
export interface ResultPagePlan { open: boolean; focus: boolean }

/**
 * 是否弹出结果页、以及是否把焦点抢过来。
 *
 * **全通过时不抢焦点**（用户还在敲代码，页面自己刷新就行）；有失败或没跑起来才夺焦点 ——
 * 那时用户一定想知道为什么。
 */
export function resultPagePlan(mode: TestResultPageMode, r: Pick<TestRunResult, 'ok' | 'summary'>): ResultPagePlan {
  const passedAll = r.ok && r.summary.failed === 0;
  const open = mode === 'always' ? true : mode === 'onFailure' ? !passedAll : false;
  // 不打开时 focus 无意义，一律 false —— 免得调用方还要判一次 open
  return open ? { open: true, focus: !passedAll } : { open: false, focus: false };
}

// ─────────────────────────────────────────────────────────────
// 模型组装
// ─────────────────────────────────────────────────────────────

export interface BuildModelContext {
  /** 读用例的输入 / 期望 / 实际（注入以便单测） */
  previews?: (c: CaseResult) => { input: OutputPreview; expected: OutputPreview; actual: OutputPreview };
  /** 当前源文件哈希（判过期）；拿不到就传 undefined，页面不标过期 */
  currentSourceHash?: string;
  /** 工具链占位符探测情况（来自 `RunnerDeps`） */
  missingTools?: { missing?: string[]; tried?: string[] } | undefined;
}

/** 引擎结果 + 补充事实 → 页面模型 */
export function buildResultModel(r: TestRunResult, ctx: BuildModelContext = {}): ResultPageModel {
  const previewOf = ctx.previews ?? ((c: CaseResult) => ({
    input: { text: '', truncated: false, missing: true },
    expected: { text: '', truncated: false, missing: true },
    actual: { text: '', truncated: false, missing: true },
  }));

  const cases: CaseView[] = r.cases.map((c) => {
    const pv = previewOf(c);
    return {
      index: c.index,
      verdict: c.verdict,
      expectedBytes: c.expectedBytes,
      actualBytes: c.actualBytes,
      runtimeText: runtimeText(c),
      durationMs: c.runtime.durationMs,
      diffText: c.diff?.description ?? null,
      diffWhere: c.diff
        ? { line: c.diff.line, byteColumn: c.diff.byteColumn, offset: c.diff.offset }
        : null,
      watchdog: c.runtime.watchdog,
      killReason: c.runtime.killReason ?? null,
      exitCode: c.runtime.exitCode,
      signal: c.runtime.signal,
      stderrTail: c.runtime.stderrTail,
      input: pv.input,
      expected: pv.expected,
      actual: pv.actual,
    };
  });

  const missing = ctx.missingTools;
  return {
    title: r.title || `${r.cid}-${r.pid}`,
    cid: r.cid,
    pid: r.pid,
    toolchain: r.toolchain,
    sourceName: nodePath.basename(r.source.file),
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    ok: r.ok,
    reason: r.reason,
    build: {
      ok: r.build.ok,
      reused: r.build.reused,
      durationMs: r.build.durationMs,
      command: r.build.command,
      runnable: r.build.runnable,
      staged: !!r.build.staged,
      output: r.build.output,
    },
    summary: r.summary,
    cases,
    skipped: r.skipped.map(s => ({ index: s.index, reason: s.reason })),
    missingTools: missing && (missing.missing?.length || missing.tried?.length)
      ? { missing: missing.missing ?? [], tried: missing.tried ?? [] }
      : null,
    stale: !!ctx.currentSourceHash && ctx.currentSourceHash !== r.source.hash,
    resultFile: r.resultFile ?? '',
    reportFile: r.reportFile ?? '',
  };
}

// ─────────────────────────────────────────────────────────────
// 渲染（纯函数）
// ─────────────────────────────────────────────────────────────

// 转义只有一份实现（`utils/format`）。此处再导出，保持既有调用点的写法不变。
export { escapeHtml };

/** 一级列表上的那枚状态徽章 */
function verdictBadge(c: CaseView): string {
  return c.verdict === 'pass'
    ? '<span class="badge pass">通过</span>'
    : '<span class="badge fail">不通过</span>';
}

/** 整页结论（顶部大字 + 配色） */
function overallVerdict(m: ResultPageModel): { text: string; cls: string } {
  if (m.reason === 'toolchain-missing') { return { text: '没能跑起来：工具链不可用', cls: 'error' }; }
  if (m.reason === 'build-failed') { return { text: '没能跑起来：编译失败', cls: 'error' }; }
  if (m.reason === 'no-cases') { return { text: '没有可用的用例', cls: 'warn' }; }
  if (m.reason === 'cancelled') { return { text: '已取消', cls: 'warn' }; }
  if (!m.ok) { return { text: '没能跑起来', cls: 'error' }; }
  if (m.summary.total > 0 && m.summary.failed === 0) { return { text: '全部通过', cls: 'pass' }; }
  return { text: `${m.summary.failed} 组不通过`, cls: 'fail' };
}

/** `<pre>` 块：带截断标注，空内容要说明白「是空的」而不是给一片留白 */
function preBlock(p: OutputPreview, emptyText: string): string {
  if (p.missing) { return `<pre class="io-empty">${escapeHtml(emptyText)}</pre>`; }
  const tail = p.truncated ? '<div class="cut">…（内容过长，已截断）</div>' : '';
  const body = p.text.length === 0 ? '<span class="io-empty">（空）</span>' : escapeHtml(p.text);
  return `<pre>${body}</pre>${tail}`;
}

function caseHtml(c: CaseView): string {
  const cls = c.verdict === 'pass' ? 'pass' : 'fail';
  const head = [
    verdictBadge(c),
    `<span class="idx">用例 ${c.index}</span>`,
    `<span class="num">${c.durationMs} ms</span>`,
    `<span class="num">期望 ${formatBytes(c.expectedBytes)} / 实际 ${formatBytes(c.actualBytes)}</span>`,
    `<span class="fact">${escapeHtml(c.runtimeText)}</span>`,
  ].join('');

  const diff = c.diffText
    ? `<div class="diff">
        <div class="diff-where">首个差异：第 ${c.diffWhere!.line} 行 · 该行第 ${c.diffWhere!.byteColumn} 个字节 · 字节偏移 ${c.diffWhere!.offset}</div>
        <div class="diff-why">${escapeHtml(c.diffText)}</div>
      </div>`
    : '';

  const stderr = c.stderrTail
    ? `<div class="sub">程序错误输出（stderr 尾部）</div><pre class="err">${escapeHtml(c.stderrTail)}</pre>`
    : '';

  const io = `<div class="io">
      <div class="col"><div class="sub">输入</div>${preBlock(c.input, '（无输入文件）')}</div>
      <div class="col"><div class="sub">期望输出</div>${preBlock(c.expected, '（缺期望文件，无法判定）')}</div>
      <div class="col"><div class="sub">实际输出（归一化后）</div>${preBlock(c.actual, '（空 —— 程序没有产出任何内容）')}</div>
    </div>`;

  return `<details class="case ${cls}">
    <summary>${head}</summary>
    <div class="detail">${diff}${io}${stderr}</div>
  </details>`;
}

/** 引擎没能跑起来时的整页说明（比只留一句「失败」有用得多） */
function reasonHtml(m: ResultPageModel): string {
  if (!m.reason) { return ''; }

  if (m.reason === 'toolchain-missing') {
    const missing = m.missingTools?.missing ?? [];
    const tried = m.missingTools?.tried ?? [];
    return `<section class="panel">
      <h3>缺什么</h3>
      <p>工具链「${escapeHtml(m.toolchain.label)}」需要这些命令，但都没找到：</p>
      <pre>${escapeHtml(missing.join('\n') || '（未声明）')}</pre>
      ${tried.length ? `<div class="sub">已经找过这些位置</div><pre>${escapeHtml(tried.join('\n'))}</pre>` : ''}
      <p class="hint">装好编译器，或把安装目录加进 <code>oj.test.searchDirs</code>；也可以换一条工具链（<code>oj.test.toolchain</code>）。</p>
    </section>`;
  }

  if (m.reason === 'build-failed') {
    return `<section class="panel">
      <h3>编译器输出</h3>
      <div class="sub">命令</div>
      <pre>${escapeHtml(m.build.command)}</pre>
      <div class="sub">输出</div>
      <pre class="err">${escapeHtml(m.build.output || '（编译器没有输出）')}</pre>
      <p class="hint">编译失败不进入运行阶段；先修好编译错误再测。</p>
    </section>`;
  }

  if (m.reason === 'no-cases') {
    return `<section class="panel">
      <h3>没有可用的用例</h3>
      <p><code>samples/</code> 里没有「<code>.in</code> 与 <code>.out</code> 成对」的数据。</p>
      <p class="hint">在侧边栏对这道题点「初始化这题」会把站点样例抓下来，也可以自己放 <code>1.in</code> / <code>1.out</code>。</p>
    </section>`;
  }

  if (m.reason === 'cancelled') {
    return `<section class="panel"><h3>已取消</h3><p>后续用例没有执行。</p></section>`;
  }
  return '';
}

/**
 * 整页 HTML。
 *
 * 亮色固定（S5.8 约定）：不引用编辑器主题变量、在 `html` 上显式声明亮色配色方案、
 * 白底深字、状态色只用绿 / 红 / 琥珀 / 灰，无 emoji、无蓝紫。
 */
export function buildResultHtml(m: ResultPageModel): string {
  const v = overallVerdict(m);
  const buildText = m.build.reused
    ? '复用上次产物（源文件未变）'
    : m.build.ok
      ? `重新编译 ${m.build.durationMs} ms`
      : '编译未完成';

  const numbers = [
    `<span class="kv"><b>${m.summary.total}</b> 用例</span>`,
    `<span class="kv pass"><b>${m.summary.passed}</b> 通过</span>`,
    `<span class="kv ${m.summary.failed ? 'fail' : ''}"><b>${m.summary.failed}</b> 不通过</span>`,
    m.summary.skipped ? `<span class="kv warn"><b>${m.summary.skipped}</b> 跳过</span>` : '',
  ].filter(Boolean).join('');

  const stale = m.stale
    ? `<div class="stale">代码已改动，这份结果可能已过期 —— 重新跑一次以确认</div>`
    : '';

  const casesSection = m.cases.length
    ? `<section class="cases"><h3>用例（点开看明细）</h3>${m.cases.map(caseHtml).join('')}</section>`
    : '';

  const skippedSection = m.skipped.length
    ? `<section class="panel"><h3>跳过的用例</h3><ul>${m.skipped
      .map(s => `<li>第 ${s.index} 组：${escapeHtml(s.reason)}（不计入通过率）</li>`).join('')}</ul></section>`
    : '';

  const staged = m.build.staged
    ? `<p class="hint">产物经 ASCII 中转目录编译后拷回 <code>temp/</code>：本次相对路径不可用（产物与源文件不在同一盘）。</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<style>
  /* 固定亮色主题：不跟随 VS Code 配色（结果页与题目页同一约定） */
  html { color-scheme: light; }
  body { margin: 0; padding: 18px 20px 40px; background: #fff; color: #333;
         font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.6; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  h3 { font-size: 14px; margin: 22px 0 8px; color: #333; }
  code, pre { font-family: Consolas, "Courier New", monospace; }
  .verdict { display: inline-block; padding: 3px 12px; border-radius: 3px; font-weight: 600; font-size: 15px; }
  .verdict.pass { background: #e8f5e9; color: #2e7d32; border-left: 4px solid #43a047; }
  .verdict.fail { background: #fdecea; color: #c62828; border-left: 4px solid #e53935; }
  .verdict.error { background: #fff3e0; color: #b26a00; border-left: 4px solid #ef6c00; }
  .verdict.warn { background: #f5f5f5; color: #555; border-left: 4px solid #9e9e9e; }
  .meta { color: #666; margin: 8px 0 4px; }
  .stale { margin: 10px 0; padding: 7px 12px; background: #fff8e1; color: #8d6e00; border-left: 4px solid #ffb300; }
  .panel, .cases { margin-top: 14px; padding: 12px 14px; background: #fafafa; border: 1px solid #e6e6e6; border-radius: 4px; }
  .numbers { margin: 10px 0 0; }
  .kv { display: inline-block; margin-right: 16px; color: #555; }
  .kv b { font-size: 15px; }
  .kv.pass b { color: #2e7d32; }
  .kv.fail b { color: #c62828; }
  .kv.warn b { color: #b26a00; }
  .case { margin: 8px 0; background: #fff; border: 1px solid #e6e6e6; border-radius: 4px; }
  .case.pass { border-left: 4px solid #43a047; }
  .case.fail { border-left: 4px solid #e53935; }
  .case > summary { cursor: pointer; padding: 9px 12px; display: block; }
  .case > summary::marker { color: #999; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; margin-right: 10px; }
  .badge.pass { background: #e8f5e9; color: #2e7d32; }
  .badge.fail { background: #fdecea; color: #c62828; }
  .idx { font-weight: 600; margin-right: 12px; }
  .num { color: #666; margin-right: 12px; }
  .fact { color: #8d6e00; }
  .detail { padding: 4px 12px 14px; border-top: 1px dashed #e6e6e6; }
  .sub { color: #777; font-size: 12px; margin: 10px 0 4px; }
  .io { display: flex; gap: 10px; flex-wrap: wrap; }
  .col { flex: 1 1 240px; min-width: 200px; }
  pre { margin: 0; padding: 8px 10px; background: #f7f7f7; border: 1px solid #e6e6e6;
        border-radius: 3px; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; }
  pre.err { color: #c62828; }
  .io-empty { color: #999; }
  .cut { color: #999; font-size: 12px; margin-top: 2px; }
  .diff { margin: 10px 0 0; padding: 8px 12px; background: #fdecea; border-left: 4px solid #e53935; border-radius: 3px; }
  .diff-where { color: #c62828; font-weight: 600; }
  .diff-why { color: #555; }
  .hint { color: #777; font-size: 12px; }
  ul { margin: 6px 0 0 18px; padding: 0; color: #555; }
</style></head>
<body>
  <div class="verdict ${v.cls}">${v.text}</div>
  <h1>${escapeHtml(m.title)}</h1>
  <div class="meta">
    题目 <code>${escapeHtml(m.cid)}</code> / <code>${escapeHtml(m.pid)}</code>
    · 工具链 ${escapeHtml(m.toolchain.label)}（<code>${escapeHtml(m.toolchain.id)}</code>，${m.toolchain.kind === 'compiled' ? '编译执行' : '解释执行'}）
    · 源文件 <code>${escapeHtml(m.sourceName)}</code>
    · 开始于 ${escapeHtml(m.startedAt)}（总耗时 ${m.durationMs} ms）
  </div>
  ${stale}
  <div class="numbers">${numbers}</div>

  <section class="panel">
    <h3>编译</h3>
    <div>${escapeHtml(buildText)}</div>
    ${m.build.command ? `<div class="sub">命令</div><pre>${escapeHtml(m.build.command)}</pre>` : ''}
    ${staged}
  </section>

  ${reasonHtml(m)}
  ${casesSection}
  ${skippedSection}
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// 面板（薄壳）
// ─────────────────────────────────────────────────────────────

export interface TestResultWebviewDeps {
  /** 读当前源文件内容（判过期用）；返回 undefined 表示读不到 */
  readSource: (file: string) => string | undefined;
  log?: (msg: string) => void;
}

/**
 * 展示一次测试结果所需的路径来源。
 *
 * 直接收引擎的 `RunnerDeps` 子集（`tempDir` + `cases`），而不是从 `result.json` 路径
 * 反推目录 —— 路径的**唯一来源是 `cache/paths.ts`**，反推一份就等于多一个会漂移的真相（契约 C6）。
 */
export type ResultPaths = Pick<RunnerDeps, 'tempDir' | 'cases'>;

export class TestResultWebview {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private deps: TestResultWebviewDeps) {}

  /**
   * 展示一次测试结果。
   *
   * @param opts.focus  是否把焦点抢到结果页（由 `resultPagePlan` 决定；
   *                    全通过时不抢，免得打断正在敲代码的用户）
   * @param opts.paths  引擎依赖（临时目录 + 样例路径）；缺省则页面只显示汇总与判定，
   *                    二级的输入 / 期望 / 实际留空
   * @param opts.missingTools 工具链探测情况，用于「缺什么」那一屏
   */
  async show(
    r: TestRunResult,
    opts: {
      focus?: boolean;
      paths?: ResultPaths;
      missingTools?: { missing?: string[]; tried?: string[] };
    } = {},
  ): Promise<void> {
    const paths = opts.paths;
    const model = buildResultModel(r, {
      previews: paths
        ? (c) => casePreviews(paths, c, RESULT_PREVIEW_BYTES)
        : undefined,
      currentSourceHash: this.currentHash(r),
      missingTools: opts.missingTools,
    });
    const html = buildResultHtml(model);
    const title = `本地测试 · ${model.title}`;
    const preserveFocus = !(opts.focus ?? false);

    if (this.panel) {
      this.panel.title = title;
      this.panel.webview.html = html;
      this.panel.reveal(vscode.ViewColumn.Two, preserveFocus);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'ojTestResult',
      title,
      { viewColumn: vscode.ViewColumn.Two, preserveFocus },
      // 零脚本：页面用原生 <details> 展开，不需要 enableScripts
      { enableScripts: false, retainContextWhenHidden: true },
    );
    this.panel.webview.html = html;
    this.panel.onDidDispose(() => { this.panel = undefined; });
  }

  /** 结果页只展示，不接受任何来自页面的指令（零脚本） */
  public get isOpen(): boolean { return !!this.panel; }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private currentHash(r: TestRunResult): string | undefined {
    if (!r.source.file) { return undefined; }
    try {
      const text = this.deps.readSource(r.source.file);
      if (text === undefined) { return undefined; }
      return sha1(text);
    } catch {
      return undefined;
    }
  }
}

/** 结果页里每份内容的展示上限（比报告宽一些，页面可滚动） */
const RESULT_PREVIEW_BYTES = 4096;

/** 读取源文件（默认实现，供接线层直接用） */
export function readSourceFile(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}
