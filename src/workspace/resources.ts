/**
 * 【工作区 · 题目本地资源】
 *
 * 「这道题在本地都有什么、分别放在哪个绝对路径」——一次问清楚，供 MCP 的
 * `get_current_problem` 把**本地路径**一并给出去（决策 D11：图片只给本地路径，
 * 不内联 base64，也不另开一个「读图片」的工具）。
 *
 * 为什么单独一个模块而不是塞进 `mcp/tools.ts`：
 * 路径怎么拼是 `cache/paths` 的事、样例怎么配对是 `test/runner` 的事，
 * 这里只做「把两者拼成一份给 AI 看的清单」，不含任何 vscode 运行时依赖，
 * 因此可以脱离扩展宿主单测（与 `config/wiring.ts` 同一分工）。
 */

import * as fs from 'fs';
import * as nodePath from 'path';
import { CacheStore } from '../cache/store';
import { CachePaths } from '../cache/paths';
import { discoverCases } from '../test/runner';

/** 一组样例在磁盘上的落点 */
export interface ProblemSampleLocal {
  index: number;
  input: string;
  output: string;
  hasInput: boolean;
  hasOutput: boolean;
}

/** 一道题的全部本地资源（全部为绝对路径） */
export interface ProblemLocalResources {
  /** 题目目录 */
  dir: string;
  /** 用户源文件（可能还没建） */
  sourceFile: string;
  sourceFileExists: boolean;
  samplesDir: string;
  assetsDir: string;
  tempDir: string;
  /** 上次本地测试的结果 / 报告 */
  resultFile: string;
  reportFile: string;
  hasResult: boolean;
  /** 样例清单（含「半对」——标注出来，不静默丢掉） */
  samples: ProblemSampleLocal[];
  /** 引擎实际会跑的样例序号（成对的那些） */
  runnableSampleIndexes: number[];
  /** 只有一半、会被跳过的样例 */
  skipped: { index: number; reason: string }[];
  /** 已落盘的题面图片绝对路径（初始化题目时抓取，离线也在） */
  assets: string[];
}

/**
 * 收集一道题的本地资源。
 *
 * 比赛目录还没建立（没在侧边栏进过这场比赛）时返回 `undefined` —— 由调用方
 * 决定给什么文案，避免这里编造一个不存在的路径。
 */
export async function collectProblemResources(opts: {
  store: CacheStore;
  cid: string;
  pid: string;
  /** 源文件名（`oj.sourceFileName`）；由调用方注入，保持本模块零配置依赖 */
  sourceFileName: string;
}): Promise<ProblemLocalResources | undefined> {
  const { store, cid, pid, sourceFileName } = opts;

  const paths = await store.resolveContestDir(cid);
  if (!paths) { return undefined; }

  const samplesDir = paths.samplesDir(pid);
  let files: string[] = [];
  try {
    files = fs.readdirSync(samplesDir);
  } catch {
    files = []; // 还没抓样例
  }

  const { cases, skipped } = discoverCases({
    files,
    inputFile: (i) => CachePaths.sampleIn(samplesDir, i),
    outputFile: (i) => CachePaths.sampleOut(samplesDir, i),
  });
  const present = new Set(files);
  const runnableSampleIndexes = cases.map((c) => c.index).sort((a, b) => a - b);

  // 清单要含「半对」：AI 需要知道「这里有个 3.in 但没有 3.out」，否则会以为样例只有两组
  const allIndexes = [...new Set([...cases.map((c) => c.index), ...skipped.map((s) => s.index)])]
    .sort((a, b) => a - b);
  const samples: ProblemSampleLocal[] = allIndexes.map((index) => ({
    index,
    input: CachePaths.sampleIn(samplesDir, index),
    output: CachePaths.sampleOut(samplesDir, index),
    hasInput: present.has(`${index}.in`),
    hasOutput: present.has(`${index}.out`),
  }));

  const assetsDir = paths.problemAssetsDir(pid);
  const assets = (await store.listProblemAssets(cid, pid))
    .sort()
    .map((name) => nodePath.join(assetsDir, name));

  const sourceFile = paths.mainSource(pid, sourceFileName);

  return {
    dir: paths.problemDir(pid),
    sourceFile,
    sourceFileExists: await store.exists(sourceFile),
    samplesDir,
    assetsDir,
    tempDir: paths.tempDir(pid),
    resultFile: paths.testResult(pid),
    reportFile: paths.testReport(pid),
    hasResult: await store.exists(paths.testResult(pid)),
    samples,
    runnableSampleIndexes,
    skipped,
    assets,
  };
}
