/**
 * 【测试 · 装配】
 *
 * 把「引擎要什么」与「工作区里有什么」接起来：选工具链 → 解析命令 → 发现样例 → 拼路径。
 *
 * 与 `workspace/wiring.ts` 同一分工：策略与执行留在引擎/工具链里，这里只做搬运与查询。
 * 引擎不 import 本模块（契约 C1），所以引擎能脱离 VS Code 单测；而「配置项叫什么、
 * 路径怎么拼」这类随环境而变的事集中在这里，改起来不影响引擎。
 */

import * as fs from 'fs';
import * as nodePath from 'path';
import { CacheStore } from '../cache/store';
import { CachePaths } from '../cache/paths';
import {
  ToolchainDef,
  builtinToolchains,
  commonSearchDirs,
  effectiveToolchains,
  matchToolchain,
  resolveCommands,
} from './toolchain';
import { RunnerDeps, discoverCases } from './runner';
import {
  getSourceFileName,
  getTestLimits,
  getTestSearchDirs,
  getTestToolchainId,
  getToolchainsFile,
  isBuildReuseEnabled,
} from '../utils/config';

export interface BuildTestDepsOptions {
  store: CacheStore;
  cid: string;
  pid: string;
  /** 工作区根（解析 `oj.test.toolchainsFile` 的相对路径用） */
  workspaceRoot: string;
  /** 题目标题（进报告） */
  title?: string;
  /** 强制重新编译；不传则按 `oj.test.reuseBuild`（默认不复用 → 每次都重编） */
  forceRebuild?: boolean;
  /**
   * 要编译的源文件名（默认取 `oj.project.sourceFileName`，通常是 `main.cpp`）。
   *
   * **只能是题目目录内的文件名**（如 `main.cpp`）：带路径分隔符、`..` 或绝对路径一律拒绝 —
   * 编译发生在这一道题的目录里，参数不该成为「让编译器去读别处文件」的通道。
   */
  sourceFileName?: string;
  log?: (msg: string) => void;
}

export type BuildTestDepsResult =
  | { ok: true; deps: RunnerDeps; def: ToolchainDef; notes: string[] }
  | { ok: false; error: string };

/**
 * 选中工具链：配置指定 id 优先，否则按源文件扩展名自动匹配。
 *
 * 单独拎出来是因为它有明确语义、「指定了但不存在」和「自动匹配不到」要给不同的错误文案。
 */
export function selectToolchain(
  defs: ToolchainDef[],
  wantedId: string,
  sourceFile: string,
): ToolchainDef | undefined {
  if (wantedId && wantedId !== 'auto') {
    return defs.find((d) => d.id === wantedId);
  }
  return matchToolchain(defs, sourceFile);
}

/** 相对工作区根的路径（不在其中就照样给绝对路径，方便直接复制） */
function relTo(root: string, p: string): string {
  const r = nodePath.relative(root, p);
  return r && !r.startsWith('..') && !nodePath.isAbsolute(r) ? r : p;
}

/**
 * 参数里的源文件名是否「就是一个文件名」。
 *
 * 拒绝路径分隔符、`..` 与绝对路径（含 Windows 盘符）——`source` 是给 AI/用户用的便利参数，
 * 不该变成「让编译器去读题目录之外文件」的通道。
 */
function isPlainFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') { return false; }
  if (name.includes('/') || name.includes('\\')) { return false; }
  if (nodePath.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) { return false; }
  return true;
}

/**
 * 组装一次测试/运行所需的全部依赖。
 *
 * 返回 `ok:false` 时给的是**可操作**的错误文案（该建哪个文件、该改哪个配置），
 * 而不是抛异常让上层去猜。
 */
export async function buildTestDeps(opts: BuildTestDepsOptions): Promise<BuildTestDepsResult> {
  const { store, cid, pid, workspaceRoot } = opts;
  const notes: string[] = [];

  const paths = await store.resolveContestDir(cid);
  if (!paths) {
    return { ok: false, error: `比赛 ${cid} 的工作目录还没建立：先在侧边栏进入这场比赛。` };
  }

  const wantedSource = (opts.sourceFileName ?? '').trim();
  if (wantedSource && !isPlainFileName(wantedSource)) {
    return {
      ok: false,
      error: `source 只能是题目目录内的文件名（如 main.cpp），不能带路径或 ..：${wantedSource}`,
    };
  }
  const sourceFile = paths.mainSource(pid, wantedSource || getSourceFileName());
  if (!(await store.exists(sourceFile))) {
    return {
      ok: false,
      error: `还没写代码：${relTo(workspaceRoot, sourceFile)}\n`
        + '在侧边栏点开这道题会自动建好目录与源文件，也可以直接新建它。',
    };
  }

  // ---- 工具链定义：内置 + 工作区 toolchains.json（同 id 覆盖内置） ----
  const cfgFile = getToolchainsFile();
  const tcFile = nodePath.isAbsolute(cfgFile) ? cfgFile : nodePath.join(workspaceRoot, cfgFile);
  const merged = effectiveToolchains(tcFile);
  for (const p of merged.problems) { notes.push(`${cfgFile}：${p}`); }

  const defs = merged.defs.length ? merged.defs : builtinToolchains();
  const wanted = getTestToolchainId();
  const def = selectToolchain(defs, wanted, sourceFile);
  if (!def) {
    const ext = nodePath.extname(sourceFile);
    const why = wanted === 'auto'
      ? `没有工具链认领 ${ext || '这种文件'}`
      : `oj.test.toolchain 指定的「${wanted}」不存在`;
    return {
      ok: false,
      error: `${why}。\n可用工具链：${defs.map((d) => d.id).join('、')}\n`
        + `改 oj.test.toolchain，或在 ${cfgFile} 里补一条（要带 "extensions"）。`,
    };
  }

  // ---- 全局阈值并进工具链（工具链自己声明的高优先级） ----
  const limits = getTestLimits();
  const effective: ToolchainDef = {
    ...def,
    timeoutMs: def.timeoutMs ?? limits.timeoutMs,
    maxOutputBytes: def.maxOutputBytes ?? limits.maxOutputBytes,
    maxMemoryBytes: def.maxMemoryBytes ?? limits.maxMemoryBytes,
  };

  // ---- 命令解析：绝对路径 → PATH → 配置的 searchDirs → 通用安装目录 ----
  const searchDirs = [...getTestSearchDirs(), ...commonSearchDirs()];
  const { resolved, missing, tried } = resolveCommands(effective, { searchDirs });

  // ---- 样例：samples/ 下的 N.in / N.out ----
  const samplesDir = paths.samplesDir(pid);
  const files = fs.existsSync(samplesDir) ? fs.readdirSync(samplesDir) : [];
  const { cases, skipped } = discoverCases({
    files,
    inputFile: (i) => CachePaths.sampleIn(samplesDir, i),
    outputFile: (i) => CachePaths.sampleOut(samplesDir, i),
  });
  if (!files.length) {
    notes.push('samples/ 还是空的：「初始化这题」会把站点样例抓下来，也可以自己放 1.in / 1.out。');
  }

  const deps: RunnerDeps = {
    toolchain: effective,
    resolved,
    missing,
    tried,
    sourceFile,
    sourceDir: nodePath.dirname(sourceFile),
    tempDir: paths.tempDir(pid),
    resultFile: paths.testResult(pid),
    reportFile: paths.testReport(pid),
    cases,
    skipped,
    meta: { cid, pid, title: opts.title ?? '' },
    // 默认不复用产物：刷题时「跑的不是我刚改的代码」比多等两秒难受得多
    forceRebuild: opts.forceRebuild ?? !isBuildReuseEnabled(),
    baseEnv: process.env,
    log: opts.log,
  };

  return { ok: true, deps, def: effective, notes };
}

/**
 * 「跑一下」用哪组样例当 stdin。
 *
 * 指定序号不存在就退回第 1 组（而不是报错）——手输数据本来就是不许的（用户决策），
 * 那么「选错了序号还给我跑」比「什么都不跑」有用。
 */
export function pickSampleInput(deps: RunnerDeps, index: number): string | undefined {
  const hit = deps.cases.find((c) => c.index === index);
  return (hit ?? deps.cases[0])?.inputFile;
}

/**
 * 列出某题已有的样例序号（用来生成「跑一下（样例 N）」任务）。
 *
 * 用**同步**快照 `store.cachedContestPaths`：任务列表刷新是同步 API，
 * 而这份同步快照的存在理由正是这种「只看目录、不读内容」的场景。
 */
export function listSampleIndexes(store: CacheStore, cid: string, pid: string): number[] {
  const paths = store.cachedContestPaths(cid);
  if (!paths) { return []; }
  try {
    return fs.readdirSync(paths.samplesDir(pid))
      .filter((f) => /^\d+\.in$/.test(f))
      .map((f) => parseInt(f, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
