/**
 * 【本地测试 · 引擎】
 *
 * 用户对这一步的描述就是本文件的骨架：
 *
 * > 引入一个「工具链」的概念屏蔽底层差异，测试平台仅调用工具链并传入输入输出文件地址，
 * > 等返回 ok 后再对比输入输出文件。
 *
 * 因此引擎只做三件事，且**不出现任何语言特判**（契约 C1）：
 *
 * 1. `prepare` —— 交给工具链（编译型编译 / 解释型空转）
 * 2. `run`     —— 逐用例传入「输入文件 / 输出文件」，工具链把 stdout 落到输出文件
 * 3. `compare` —— 与期望文件**严格逐字节**比较（归一化换行后）
 *
 * ## 判定语义（用户决策 D7）
 *
 * 判定只有 `通过` / `不通过`。**不做错误分类**：非零退出码、崩溃、被看门狗砍掉，
 * 一律不改变判定逻辑，只作为「运行事实」（`runtime` 字段）记录并在报告里如实注明 ——
 * 否则用户看到「不通过」会不知道为什么。
 *
 * ## 产物
 *
 * - `test/result.json`：机器 / MCP / AI 读（含 `sourceHash`，供「结果已过期」判定 D14）
 * - `test/report.md`  ：人读（中文）
 *
 * 本模块不依赖 VS Code，也不自己拼路径（路径一律由调用方 [`RunnerDeps`] 传入），
 * 所以既能脱离运行时装进单测，也守住了「`cache/paths.ts` 是路径唯一来源」的既有约定。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import * as crypto from 'crypto';
import {
  ToolchainDef, expandTemplate, buildEnv,
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_MEMORY_BYTES,
} from './toolchain';
import { compareFiles, writeNormalizedCopy, describeDiff, describeByte, preview } from './compare';
import { runProcess, readErrorTail, WatchdogKind, WatchdogLimits, RunProcessOutcome } from './watchdog';

const IS_WINDOWS = process.platform === 'win32';

/**
 * 编译产物的固定文件名（不含扩展名）。
 *
 * 刻意不派生自源文件名：源文件名是用户可配的，一旦含中文，产物名会跟着含中文，
 * 而 MinGW 的 `ld` 恰好写不出非 ASCII 路径的产物（详见 `relativeArg`）。
 */
const PRODUCT_STEM = 'main';

/** 编译的超时与输出上限单独放宽：编译慢是正常的，不该被运行的 10s 闸误杀 */
export const DEFAULT_BUILD_TIMEOUT_MS = 60_000;
export const BUILD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type CaseVerdict = 'pass' | 'fail';

export interface TestCaseSpec {
  /** 用例序号（= `samples/<N>.in` 的 N） */
  index: number;
  inputFile: string;
  expectedFile: string;
}

/** 只有 `.in` 没有 `.out` 的用例（决策 D9：跳过但必须点名说明，不得静默忽略） */
export interface SkippedCase { index: number; reason: string }

/**
 * 用例发现（纯函数，路径由调用方拼好传进来）。
 *
 * 「半对」= 只有 `N.in` 没有 `N.out`：无法判定对错，所以跳过，
 * 但必须进 `skipped` 让报告写出来 —— 静默忽略会让人以为没加过这组数据。
 */
export function discoverCases(opts: {
  files: string[];
  inputFile: (index: number) => string;
  outputFile: (index: number) => string;
}): { cases: TestCaseSpec[]; skipped: SkippedCase[] } {
  const present = new Set(opts.files);
  const indexes = opts.files
    .filter(f => /^\d+\.in$/.test(f))
    .map(f => parseInt(f.slice(0, -3), 10))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  const cases: TestCaseSpec[] = [];
  const skipped: SkippedCase[] = [];
  for (const i of indexes) {
    if (present.has(`${i}.out`)) {
      cases.push({ index: i, inputFile: opts.inputFile(i), expectedFile: opts.outputFile(i) });
    } else {
      skipped.push({ index: i, reason: `只有 ${i}.in、缺少 ${i}.out，无法判定` });
    }
  }
  return { cases, skipped };
}

/** 运行事实（不参与判定，只记录） */
export interface CaseRuntime {
  exitCode: number | null;
  signal: string | null;
  /** 触发的那道闸；null = 正常结束 */
  watchdog: WatchdogKind | null;
  killReason?: string;
  durationMs: number;
  /** 程序吐出的原始字节数（`temp/N.raw.out`） */
  rawBytes: number;
  /** 归一化后的字节数（`temp/N.out`，比较用的那份） */
  normalizedBytes: number;
  /** stderr 尾部（截断） */
  stderrTail: string;
}

export interface CaseResult {
  index: number;
  verdict: CaseVerdict;
  expectedBytes: number;
  actualBytes: number;
  runtime: CaseRuntime;
  /** 通过时为 null */
  diff: {
    line: number;
    byteColumn: number;
    offset: number;
    expectedByte: number | null;
    actualByte: number | null;
    description: string;
  } | null;
}

export interface BuildResult {
  ok: boolean;
  /** 命中产物复用（决策 D5） */
  reused: boolean;
  durationMs: number;
  /** 实际执行的编译命令（让用户能核对自己配的工具链对不对） */
  command: string;
  /** 编译产物路径（解释型 = 源文件本身） */
  runnable: string;
  /** 产物是否经 ASCII 中转目录编译后拷回（仅「相对路径不可用」的跨盘场景才会出现） */
  staged?: boolean;
  /** 编译器输出原文（失败时原样回传，契约 C3） */
  output: string;
}

export interface Summary { total: number; passed: number; failed: number; skipped: number }

export type RunFailureReason = 'toolchain-missing' | 'build-failed' | 'no-cases' | 'cancelled';

export interface TestRunResult {
  version: 1;
  cid: string;
  pid: string;
  title: string;
  toolchain: { id: string; label: string; kind: string };
  source: { file: string; hash: string };
  startedAt: string;
  durationMs: number;
  /** 整体是否正常跑完（**不是判定结果**；判定看 summary 与 cases） */
  ok: boolean;
  reason?: RunFailureReason;
  build: BuildResult;
  summary: Summary;
  cases: CaseResult[];
  skipped: SkippedCase[];
  resultFile?: string;
  reportFile?: string;
}

export interface RunnerDeps {
  toolchain: ToolchainDef;
  /** 命令占位符 → 绝对路径（由 wiring 用 `resolveCommands` 解析；引擎不自己查 PATH） */
  resolved: Record<string, string>;
  /** 未解析成功的占位符（非空 = 工具链不可用） */
  missing?: string[];
  /** 探测过的位置（失败时给用户看，避免只说「找不到 g++」） */
  tried?: string[];

  sourceFile: string;
  /** 源文件所在目录（同时作为子进程 cwd，契约 C4） */
  sourceDir: string;
  /** 编译产物与运行临时文件目录 */
  tempDir: string;
  /** 结果产物路径（由 paths 层给出） */
  resultFile: string;
  reportFile: string;

  cases: TestCaseSpec[];
  skipped?: SkippedCase[];
  meta: { cid: string; pid: string; title: string };

  /** 强制重新编译，绕过产物复用 */
  forceRebuild?: boolean;
  isCancelled?: () => boolean;
  log?: (msg: string) => void;
  now?: () => number;
  /** 子进程环境基座（默认 `process.env`，PATH 会被工具链覆盖，契约 C5） */
  baseEnv?: NodeJS.ProcessEnv;
  buildTimeoutMs?: number;

  // ---- 注入点（测试用） ----
  runProcessImpl?: typeof runProcess;
}

/**
 * 路径是否 ASCII 安全。
 *
 * 存在的意义只有一个：MinGW 的 `ld` 在含非 ASCII 的产物路径下会失败（见 `asciiSafeOutput`）。
 */
export function isAsciiSafe(p: string): boolean {
  return !/[^\x00-\x7F]/.test(p);
}

/**
 * 把路径参数表达成相对于 `from` 的相对路径（不可行时返回 undefined）。
 *
 * 这是非 ASCII 产物路径的**主解法**，也是实测出来的：
 * MinGW 的 `ld` 只有在产物路径**写进命令行参数**且含非 ASCII 时才失败 ——
 * 它拿到的是 ANSI 字符串，`3775-新生赛` 被解成乱码，于是报
 * `cannot open output file ...: No such file or directory`（看着像路径不存在，极易误判）。
 *
 * 而相对路径 `temp/main.exe` 本身全是 ASCII，中文只留在子进程的 Unicode cwd 里，
 * 由内核在拼接时处理，不会产生编码损失。本项目布局 `<cid>-<标题>` / `<字母>-<标题>`
 * 目录名含中文是常态，所以这条是主路径，不是兜底。
 *
 * 跨盘或产物不在 `from` 之下时无解，返回 undefined 交给调用方退回 ASCII 中转。
 */
export function relativeArg(from: string, to: string): string | undefined {
  const rel = nodePath.relative(from, to);
  if (!rel || nodePath.isAbsolute(rel) || rel.startsWith('..')) { return undefined; }
  return rel;
}

/**
 * 找一个 ASCII 安全的暂存目录（`%TEMP%` 优先，用户名含中文时退到系统盘根）。
 *
 * 只在**相对路径不可用**（跨盘）时才需要它，见 `relativeArg`。
 *
 * 找不到就返回 undefined —— 那时只能照原路径编译，让编译器如实报错，而不是我们瞎猜。
 */
export function makeAsciiStagingDir(): string | undefined {
  const roots = [
    nodePath.join(os.tmpdir(), 'vsoj-build'),
    nodePath.join(process.env.SystemDrive || process.env.HOMEDRIVE || 'C:', 'vsoj-build'),
  ];
  for (const root of roots) {
    if (!isAsciiSafe(root)) { continue; }
    try {
      fs.mkdirSync(root, { recursive: true });
      return fs.mkdtempSync(nodePath.join(root, nodePath.sep));
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

/** 源文件内容哈希（结果过期判定 D14 的依据） */
export function sha1(text: string | Buffer): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

export class LocalTestRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  private get now(): number { return (this.deps.now ?? Date.now)(); }

  private log(msg: string): void { this.deps.log?.(msg); }

  /** 跑一次完整测试 */
  async run(): Promise<TestRunResult> {
    const startedAt = new Date((this.deps.now ?? Date.now)()).toISOString();
    const t0 = this.now;
    const { toolchain, meta } = this.deps;

    let sourceText = '';
    try {
      sourceText = fs.readFileSync(this.deps.sourceFile, 'utf8');
    } catch { /* 源文件不存在时后面 build 会报错，这里不吞 */ }
    const sourceHash = sha1(sourceText);

    const base: TestRunResult = {
      version: 1,
      cid: meta.cid,
      pid: meta.pid,
      title: meta.title,
      toolchain: { id: toolchain.id, label: toolchain.label, kind: toolchain.kind },
      source: { file: this.deps.sourceFile, hash: sourceHash },
      startedAt,
      durationMs: 0,
      ok: false,
      build: { ok: false, reused: false, durationMs: 0, command: '', runnable: '', output: '' },
      summary: { total: 0, passed: 0, failed: 0, skipped: (this.deps.skipped ?? []).length },
      cases: [],
      skipped: this.deps.skipped ?? [],
    };

    const finish = (r: TestRunResult): TestRunResult => {
      r.durationMs = this.now - t0;
      r.resultFile = this.writeResult(r);
      r.reportFile = this.writeReport(r);
      return r;
    };

    // 1. 工具链不可用 → 直接失败，并把「探测过哪些位置」交出去（本机 g++ 就不在 PATH 里）
    if ((this.deps.missing ?? []).length) {
      base.reason = 'toolchain-missing';
      base.build.output = this.missingMessage();
      this.log(`工具链不可用：${base.build.output}`);
      return finish(base);
    }

    // 2. 没有可用用例
    if (!this.deps.cases.length) {
      base.reason = 'no-cases';
      return finish(base);
    }

    // 3. prepare
    const build = await this.prepare(sourceText);
    base.build = build;
    if (!build.ok) {
      base.reason = 'build-failed';
      return finish(base);
    }

    // 4. 逐用例 run + compare
    const env = buildEnv(toolchain, this.deps.resolved, this.deps.baseEnv ?? process.env);
    const limits = this.limitsFor(toolchain);
    for (const c of this.deps.cases) {
      if (this.deps.isCancelled?.()) {
        base.reason = 'cancelled';
        this.log('已取消，停止后续用例');
        break;
      }
      const caseResult = await this.runCase(c, build.runnable, env, limits);
      base.cases.push(caseResult);
    }

    base.summary.total = base.cases.length;
    base.summary.passed = base.cases.filter(c => c.verdict === 'pass').length;
    base.summary.failed = base.cases.filter(c => c.verdict === 'fail').length;
    base.ok = base.reason === undefined && base.cases.length > 0;
    return finish(base);
  }

  /** 工具链不给可用命令时，把原因与探测位置说清楚 */
  private missingMessage(): string {
    const missing = (this.deps.missing ?? []).join('、');
    const tried = (this.deps.tried ?? []).slice(0, 12);
    const lines = [
      `找不到工具链「${this.deps.toolchain.label}」所需的命令：${missing}`,
      '请在 toolchains.json 里把命令写成绝对路径（本机 g++ 通常不在 PATH 里），例如：',
      '  "commands": { "gpp": ["D:\\\\...\\\\mingw64\\\\bin\\\\g++.exe"] }',
    ];
    if (tried.length) {
      lines.push(`已探测过 ${tried.length} 个位置，例如：${tried.slice(0, 5).join('、')}`);
    }
    return lines.join('\n');
  }

  private limitsFor(def: ToolchainDef): WatchdogLimits {
    return {
      timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: def.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxMemoryBytes: def.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES,
    };
  }

  /**
   * 模板变量。
   *
   * 两套占位符合并成一张表：
   * - **命令占位符**（`{gpp}` / `{javac}` / `{python}`…）来自 `deps.resolved`（已是绝对路径）
   * - **路径占位符**（`{source}` / `{dir}` / `{stem}` / `{ext}` / `{output}` / `{runnable}`）
   *   由当前源文件与用例现场推导
   */
  private templateVars(extra: Record<string, string> = {}): Record<string, string> {
    const source = this.deps.sourceFile;
    return {
      ...this.deps.resolved,
      source,
      dir: this.deps.sourceDir,
      stem: nodePath.basename(source, nodePath.extname(source)),
      ext: nodePath.extname(source).replace(/^\./, ''),
      ...extra,
    };
  }

  /**
   * 准备阶段：解释型工具链**什么都不做**（决策 D2 的核心：差异被关在这里）。
   *
   * 编译型按内容哈希复用产物（决策 D5）：`temp/build.json` 记哈希与产物，
   * 哈希由「源文件内容 + 工具链 id + 编译模板」构成 —— 改回原内容也能正确命中。
   */
  private async prepare(sourceText: string): Promise<BuildResult> {
    const def = this.deps.toolchain;
    const tempDir = this.deps.tempDir;
    fs.mkdirSync(tempDir, { recursive: true });

    if (def.kind === 'interpreted' || !def.compile) {
      return {
        ok: true, reused: true, durationMs: 0,
        command: expandTemplate(def.run, this.templateVars({ runnable: this.deps.sourceFile })).join(' '),
        runnable: this.deps.sourceFile,
        output: '',
      };
    }

    // 产物名固定 ASCII：源文件名是用户可配的（`oj.project.sourceFileName`），
    // 若拿它派生产物名，用户把源文件改成中文名就会重新踩进 ld 的编码坑里。
    const product = nodePath.join(tempDir, PRODUCT_STEM + (IS_WINDOWS ? '.exe' : ''));
    const buildRecord = nodePath.join(tempDir, 'build.json');
    const hash = sha1(`${sourceText}\n--${def.id}--\n${def.compile}`);

    if (!this.deps.forceRebuild) {
      const cached = this.readBuildRecord(buildRecord);
      if (cached && cached.hash === hash && cached.product && fs.existsSync(cached.product)) {
        this.log(`产物复用命中（源文件未变）：${cached.product}`);
        return {
          ok: true, reused: true, durationMs: 0,
          command: cached.command ?? '', runnable: cached.product, output: '',
        };
      }
    }

    // 路径参数用相对路径（cwd 就是题目目录）：命令行里因此不含非 ASCII 字符，
    // MinGW 的 ld 不会再被中文路径搞崩。详见 `relativeArg`。
    // 只有跨盘这种相对路径无解的情形，才退回 ASCII 中转目录编译再拷回 `temp/`。
    let outputArg = product;
    let sourceArg = this.deps.sourceFile;
    let staging: string | undefined;
    if (def.asciiSafeOutput === true) {
      const relOut = relativeArg(this.deps.sourceDir, product);
      const relSrc = relativeArg(this.deps.sourceDir, this.deps.sourceFile);
      if (relOut) {
        outputArg = relOut;
        if (relSrc) { sourceArg = relSrc; }
      } else {
        staging = makeAsciiStagingDir();
        outputArg = staging ? nodePath.join(staging, nodePath.basename(product)) : product;
      }
    }
    const compileTarget = staging ?? product;

    const argv = expandTemplate(def.compile, this.templateVars({ output: outputArg, source: sourceArg }));
    const commandText = argv.join(' ');
    this.log(`编译（cwd=${this.deps.sourceDir}）：${commandText}`);

    const stdoutLog = nodePath.join(tempDir, 'build.stdout.log');
    const stderrLog = nodePath.join(tempDir, 'build.stderr.log');
    const buildLimits: WatchdogLimits = {
      timeoutMs: this.deps.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      maxOutputBytes: BUILD_MAX_OUTPUT_BYTES,
      maxMemoryBytes: 4 * 1024 * 1024 * 1024,
    };

    const outcome = await this.runOutcome({
      command: argv[0], args: argv.slice(1),
      cwd: this.deps.sourceDir,
      env: buildEnv(def, this.deps.resolved, this.deps.baseEnv ?? process.env),
      outFile: stdoutLog, errFile: stderrLog,
      limits: buildLimits,
    });

    const output = [readText(stderrLog), readText(stdoutLog)].filter(Boolean).join('\n').trim();

    let ok = outcome.exitCode === 0 && fs.existsSync(compileTarget);
    let staged = false;
    if (ok && staging) {
      try {
        fs.mkdirSync(nodePath.dirname(product), { recursive: true });
        fs.copyFileSync(compileTarget, product);
        staged = true;
      } catch (e: any) {
        ok = false;
        return {
          ok: false, reused: false, durationMs: outcome.durationMs, command: commandText,
          runnable: product, output: `${output}\n\n产物已编译成功，但复制回 temp/ 失败：${e.message}`,
        };
      }
    }
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 留个目录不致命 */ }
    }

    if (ok) {
      fs.writeFileSync(buildRecord, JSON.stringify({
        hash, toolchainId: def.id, command: commandText, product, at: new Date().toISOString(),
      }, null, 2), 'utf8');
    }

    return {
      ok, reused: false, durationMs: outcome.durationMs, command: commandText,
      runnable: product, output,
      ...(staged ? { staged: true } : {}),
    };
  }

  private readBuildRecord(file: string): { hash?: string; product?: string; command?: string } | undefined {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
  }

  /** 单用例：传入输入/输出文件地址 → 归一化 → 严格比对 */
  private async runCase(
    c: TestCaseSpec,
    runnable: string,
    env: NodeJS.ProcessEnv,
    limits: WatchdogLimits,
  ): Promise<CaseResult> {
    const def = this.deps.toolchain;
    const tempDir = this.deps.tempDir;
    const rawOut = nodePath.join(tempDir, `${c.index}.raw.out`);
    const normOut = nodePath.join(tempDir, `${c.index}.out`);
    const errFile = nodePath.join(tempDir, `${c.index}.err`);

    const argv = expandTemplate(def.run, this.templateVars({ runnable }));
    this.log(`运行用例 ${c.index}：${argv.join(' ')}`);

    const outcome: RunProcessOutcome = await this.runOutcome({
      command: argv[0], args: argv.slice(1),
      cwd: this.deps.sourceDir,
      env,
      inFile: c.inputFile, outFile: rawOut, errFile,
      limits,
    });

    let rawBytes = 0;
    let normalizedBytes = 0;
    try {
      const sizes = writeNormalizedCopy(rawOut, normOut);
      rawBytes = sizes.rawBytes;
      normalizedBytes = sizes.normalizedBytes;
    } catch { /* 输出文件不存在（程序没产出任何东西）→ 视为空输出 */ }

    const cmp = safeCompare(c.expectedFile, normOut);
    const runtime: CaseRuntime = {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      watchdog: outcome.watchdog,
      killReason: outcome.killReason,
      durationMs: outcome.durationMs,
      rawBytes,
      normalizedBytes,
      stderrTail: readErrorTail(errFile),
    };

    return {
      index: c.index,
      verdict: cmp.equal ? 'pass' : 'fail',
      expectedBytes: cmp.expectedBytes,
      actualBytes: cmp.actualBytes,
      runtime,
      diff: cmp.firstDiff ? { ...cmp.firstDiff, description: describeDiff(cmp) } : null,
    };
  }

  private runOutcome(opts: Parameters<typeof runProcess>[0]): Promise<RunProcessOutcome> {
    const impl = this.deps.runProcessImpl ?? runProcess;
    return impl(opts);
  }

  // ============================================================
  // 产物
  // ============================================================

  private writeResult(r: TestRunResult): string | undefined {
    try {
      fs.mkdirSync(nodePath.dirname(this.deps.resultFile), { recursive: true });
      fs.writeFileSync(this.deps.resultFile, `${JSON.stringify(r, null, 2)}\n`, 'utf8');
      return this.deps.resultFile;
    } catch (e: any) {
      this.log(`写 result.json 失败：${e.message}`);
      return undefined;
    }
  }

  private writeReport(r: TestRunResult): string | undefined {
    try {
      fs.mkdirSync(nodePath.dirname(this.deps.reportFile), { recursive: true });
      fs.writeFileSync(this.deps.reportFile, buildReport(r, this.deps), 'utf8');
      return this.deps.reportFile;
    } catch (e: any) {
      this.log(`写 report.md 失败：${e.message}`);
      return undefined;
    }
  }
}

// ============================================================
// 报告（人读，中文）
// ============================================================

function readText(file: string, maxBytes = 8192): string {
  try {
    const buf = fs.readFileSync(file);
    const text = buf.length > maxBytes ? buf.subarray(0, maxBytes).toString('utf8') + '\n…（已截断）' : buf.toString('utf8');
    return text.trim();
  } catch { return ''; }
}

function safeCompare(expectedFile: string, actualFile: string) {
  try {
    return compareFiles(expectedFile, actualFile);
  } catch (e: any) {
    // 期望文件读不到 / 实际输出没产出：都归为「不通过」，但要留下痕迹
    return {
      equal: false, expectedBytes: -1, actualBytes: -1, lengthMismatch: true,
      firstDiff: {
        offset: 0, line: 1, byteColumn: 1, expectedByte: null, actualByte: null,
        description: `无法读取输出用于比较：${e.message}`,
      },
    } as any;
  }
}

/** 生成 report.md */
export function buildReport(r: TestRunResult, deps: RunnerDeps): string {
  const L: string[] = [];
  L.push(`# 本地测试报告 · ${r.title || `${r.cid}-${r.pid}`}`);
  L.push('');
  L.push(`- 题目：\`${r.cid}\` / \`${r.pid}\``);
  L.push(`- 工具链：${r.toolchain.label}（\`${r.toolchain.id}\`，${r.toolchain.kind === 'compiled' ? '编译执行' : '解释执行'}）`);
  L.push(`- 源文件：\`${nodePath.basename(r.source.file)}\``);
  L.push(`- 时间：${r.startedAt}（耗时 ${r.durationMs} ms）`);
  L.push('');

  if (r.reason === 'toolchain-missing') {
    L.push('## 未能开始：工具链不可用');
    L.push('');
    L.push('```');
    L.push(r.build.output);
    L.push('```');
    L.push('');
    return L.join('\n');
  }

  if (r.reason === 'build-failed') {
    L.push('## 未能开始：编译失败');
    L.push('');
    L.push(`命令：\`${r.build.command}\``);
    L.push('');
    L.push('```');
    L.push(r.build.output || '（编译器没有输出）');
    L.push('```');
    L.push('');
    L.push('> 编译失败不进入运行阶段；请先修好编译错误。');
    L.push('');
    return L.join('\n');
  }

  if (r.reason === 'no-cases') {
    L.push('## 没有可用的用例');
    L.push('');
    L.push('`samples/` 里没有「`.in` 与 `.out` 成对」的数据。');
    if (r.skipped.length) {
      L.push('');
      L.push('以下用例因为缺期望输出被跳过：');
      for (const s of r.skipped) { L.push(`- 第 ${s.index} 组：${s.reason}`); }
    }
    L.push('');
    return L.join('\n');
  }

  const verdictText = r.summary.failed === 0 && r.summary.total > 0 ? '全部通过' : `${r.summary.failed} 组不通过`;
  L.push(`## 结论：${verdictText}`);
  L.push('');
  L.push(`共 ${r.summary.total} 组用例，通过 ${r.summary.passed}，不通过 ${r.summary.failed}` +
    (r.summary.skipped ? `，跳过 ${r.summary.skipped}` : '') +
    (r.reason === 'cancelled' ? '（已取消，后续用例未执行）' : ''));
  L.push('');
  L.push(`编译：${r.build.reused ? '复用上次产物（源文件未变）' : `重新编译 ${r.build.durationMs} ms`}`);
  if (r.build.staged) {
    L.push('');
    L.push('> 产物经 ASCII 中转目录编译后拷回 `temp/`：本次相对路径不可用（产物与源文件不在同一盘），改由纯 ASCII 暂存目录编译。');
  }
  L.push('');
  L.push(`- 编译命令：\`${r.build.command}\``);
  L.push('');

  L.push('## 用例明细');
  L.push('');
  L.push('| 用例 | 判定 | 耗时 | 期望字节 | 实际字节 | 运行事实 |');
  L.push('|---|---|---|---|---|---|');
  for (const c of r.cases) {
    L.push(`| ${c.index} | ${c.verdict === 'pass' ? '通过' : '不通过'} | ${c.runtime.durationMs} ms ` +
      `| ${c.expectedBytes} | ${c.actualBytes} | ${runtimeText(c)} |`);
  }
  L.push('');

  const failed = r.cases.filter(c => c.verdict === 'fail');
  if (failed.length) {
    L.push('## 不通过的用例');
    L.push('');
    for (const c of failed) {
      L.push(`### 用例 ${c.index}`);
      L.push('');
      if (c.diff) {
        L.push(`- ${c.diff.description}`);
      }
      if (c.runtime.watchdog) {
        L.push(`- 运行事实：进程树已被终止 —— ${c.runtime.killReason ?? c.runtime.watchdog}`);
      } else if (c.runtime.exitCode !== 0) {
        L.push(`- 运行事实：退出码 ${c.runtime.exitCode}${c.runtime.signal ? `，信号 ${c.runtime.signal}` : ''}`);
      }
      for (const line of expectedActualPreview(deps, c)) { L.push(line); }
      if (c.runtime.stderrTail) {
        L.push('');
        L.push('程序错误输出（stderr 尾部）：');
        L.push('');
        L.push('```');
        L.push(c.runtime.stderrTail);
        L.push('```');
      }
      L.push('');
    }
  }

  if (r.skipped.length) {
    L.push('## 跳过的用例');
    L.push('');
    for (const s of r.skipped) { L.push(`- 第 ${s.index} 组：${s.reason}（不计入通过率）`); }
    L.push('');
  }

  L.push('## 判定口径');
  L.push('');
  L.push('- 严格逐字节比较（先做 `\\r\\n → \\n` 归一化，等价于站点 Linux 判题环境；其余一个字节都不放过）');
  L.push('- 只判「通过 / 不通过」，不做错误分类；退出码、是否被看门狗终止都只作为运行事实记录');
  L.push('');
  return L.join('\n');
}

function runtimeText(c: CaseResult): string {
  if (c.runtime.watchdog) { return `看门狗终止（${c.runtime.watchdog}）`; }
  if (c.runtime.exitCode !== 0) { return `退出码 ${c.runtime.exitCode}`; }
  return '正常结束';
}

function expectedActualPreview(deps: RunnerDeps, c: CaseResult): string[] {
  const out: string[] = [];
  const tempDir = deps.tempDir;
  const normOut = nodePath.join(tempDir, `${c.index}.out`);
  const expected = safeRead(deps.cases.find(x => x.index === c.index)?.expectedFile ?? '');
  const actual = safeRead(normOut);
  if (expected) {
    const p = preview(expected, 1200);
    out.push('', '期望输出：', '', '```', p.text + (p.truncated ? '\n…（已截断）' : ''), '```');
  }
  if (actual) {
    const p = preview(actual, 1200);
    out.push('', '实际输出（归一化后）：', '', '```', p.text + (p.truncated ? '\n…（已截断）' : ''), '```');
  }
  if (!actual) {
    out.push('', '实际输出：（空 —— 程序没有产出任何内容）');
  }
  return out;
}

function safeRead(file: string): Buffer | undefined {
  try { return fs.readFileSync(file); } catch { return undefined; }
}

export { describeByte };
