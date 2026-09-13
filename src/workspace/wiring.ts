/**
 * 【工作区 · 装配】
 *
 * 把 `initializer` 需要的原子动作接到真实实现上（`CacheStore` / `ProblemService` / HTTP 客户端）。
 *
 * 之所以单独一层：`initializer` 刻意只依赖注入进来的函数，好让「初始化策略」能脱离
 * VS Code 单测；而「这些函数到底连到哪里」是易变的接线工作，混在一起会让策略层
 * 被迫跟着存储层一起改。这里只做搬运，不含任何业务判断。
 */

import { CacheStore } from '../cache/store';
import { ProblemService } from '../api/problem';
import { parseProblemDetail } from '../utils/parser';
import { numToLetter } from '../utils/slug';
import { getSourceFileName, isOfflineMode } from '../utils/config';
import { ProblemInitDeps } from './initializer';

export interface BuildInitDepsOptions {
  cid: string;
  store: CacheStore;
  problems: ProblemService;
  /** 拉取题面图片原始二进制（与题面渲染共用同一入口，走会话 cookie） */
  fetchAsset: (url: string) => Promise<Buffer>;
  /** 错误 → 可读文案（复用 extension 的 `describeThrown`，保持措辞一致） */
  toError: (e: unknown) => string;
  log?: (msg: string) => void;
}

/** 取出已定稿的比赛目录路径；未初始化时给出可读错误而不是 `undefined` 崩溃 */
async function requireContestPaths(store: CacheStore, cid: string) {
  const paths = await store.resolveContestDir(cid);
  if (!paths) {
    throw new Error(`比赛 ${cid} 的目录尚未建立（应先调用 registerProblem）`);
  }
  return paths;
}

/**
 * 同步取比赛路径（只拼路径、不做 IO 的三处用它）。
 *
 * 时机保证：`initializer` 只在 `registerProblem` 之后才调 `sourceFile` /
 * `tempDir` / `testDir`，而那一步会刷新 store 的同步快照。
 */
function requirePathsSync(store: CacheStore, cid: string) {
  const paths = store.cachedContestPaths(cid);
  if (!paths) {
    throw new Error(`比赛 ${cid} 的目录尚未建立（应先调用 registerProblem）`);
  }
  return paths;
}

/**
 * 构造某一比赛的初始化依赖集合。
 *
 * 注意 `cid` 在闭包里固定：初始化的粒度是「一场比赛里的某道题」，
 * 换比赛就换一份 deps，避免把 cid 一路透传到每个原子动作上。
 */
export function buildInitDeps(opts: BuildInitDepsOptions): ProblemInitDeps {
  const { cid, store, problems, fetchAsset, toError, log } = opts;
  const sourceName = getSourceFileName();

  return {
    // ---- 题面原始 HTML ----
    // 读盘不看新鲜度：初始化问的是「有没有」，新鲜度归 S4 的重访刷新（C6）
    readProblemHtml: (pid) => store.readProblemHtml(cid, pid),
    fetchProblemHtml: (pid) => problems.fetchProblemHtml(cid, pid),
    saveProblemHtml: async (pid, html) => { await store.writeProblemHtml(cid, pid, html); },

    parseDetail: (html) => parseProblemDetail(html),
    registerProblem: (entry) => store.registerProblem(cid, entry),

    // ---- 样例 ----
    readSamples: (pid) => store.readSamples(cid, pid),
    saveSamples: async (pid, samples) => { await store.writeSamples(cid, pid, samples); },

    // ---- 题面图片 ----
    listAssets: (pid) => store.listProblemAssets(cid, pid),
    fetchAsset,
    saveAsset: async (pid, url, data) => { await store.writeProblemAsset(cid, pid, url, data); },

    // ---- 源文件与目录 ----
    // 这三处只是拼路径，保持同步签名（见 `CacheStore.contestCache` 的说明）
    sourceFile: (pid) => requirePathsSync(store, cid).mainSource(pid, sourceName),
    writeSourceFile: async (pid, content) => {
      const paths = await requireContestPaths(store, cid);
      // 用户产物走 writeUserFile：不受 `oj.cache.enabled` 阻断（D18）
      await store.writeUserFile(paths.mainSource(pid, sourceName), content);
    },
    fileExists: (file) => store.exists(file),
    ensureDir: (dir) => store.ensureDir(dir),
    tempDir: (pid) => requirePathsSync(store, cid).tempDir(pid),
    testDir: (pid) => requirePathsSync(store, cid).testDir(pid),

    // ---- 环境 ----
    isOffline: () => isOfflineMode(),
    toError,
    letterOf: (pid) => numToLetter(parseInt(pid, 10)),
    log,
  };
}
