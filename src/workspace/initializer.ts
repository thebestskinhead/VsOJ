/**
 * 【工作区 · 比赛项目初始化】
 *
 * 把一道题在磁盘上「落地」：原始题面 + 样例 + 题面图片 + 源文件 + `temp/` + `test/`。
 *
 * ## 为什么需要它
 *
 * 目标是 LeetCode 式流程（浏览题目 → 自动切到该题源文件 → 左代码右题目）与一键本地测试，
 * 这两件事都**隐含假设磁盘上有文件**。初始化就是它们的地基，不是可选优化。
 * 详见 `docs/PLAN_S5.md` §1。
 *
 * ## 两条路径，一个入口
 *
 * - **懒初始化**（默认）：用户点开某题 → 只落这一题 → 立即分栏，无确认无等待
 * - **全量预取**：侧边栏「初始化项目」条目 → 对题目列表逐题调用
 *
 * 两条路都走 {@link ProblemInitializer.ensureProblem}，不存在两套逻辑。
 *
 * ## 语义边界（重要）
 *
 * - **增量补齐**：已落盘的题面 / 样例 / 图片**按题面内容对齐**后直接复用不重拉，只补缺失项。
 *   新鲜度**不归这里管** —— 那是 S4 重访刷新的职责，两套机制不重叠。
 *   题集重排后同一序号上的题目换了人，缓存层会把索引按身份重新对齐（见 `cache/store.ts`）。
 * - **绝不覆盖源文件**：`main.cpp` 一旦存在就永不改写，哪怕用户已经写了代码。
 * - **串行、不重试、可取消、失败不中断**：与 S4 `ProblemRefresher` 同一套约定。
 * - 所有网络与落盘动作都通过 {@link ProblemInitDeps} 注入，可脱离 VS Code 单测。
 */

import { ProblemDetail } from '../types';
import { assetFileName } from '../utils/slug';

/**
 * 新建源文件时的最小 C++ 骨架（D20）。
 *
 * 用户明确选择「最小骨架」而非「骨架 + 题目信息注释」，因此这里**不加**任何
 * 注释头 —— 需要的是一份能立刻编译、不用先删注释的空白起点。
 */
export const CPP_SKELETON = [
  '#include <bits/stdc++.h>',
  'using namespace std;',
  '',
  'int main() {',
  '    ios::sync_with_stdio(false);',
  '    cin.tie(nullptr);',
  '',
  '    return 0;',
  '}',
  '',
].join('\n');

/** 题目线索：pid 必填，标题 / 全局题号来自比赛页（拿得到就用，拿不到就现场解析） */
export interface ProblemHint {
  pid: string;
  /** 站点上的全局题号（题目身份的来源，见 `cache/store.ts`） */
  globalId?: string;
  /** 题目标题（仅用于登记与展示；目录名由缓存层按身份推导） */
  title?: string;
}

export interface SampleLike {
  index?: number;
  input: string;
  output: string;
}

export interface ProblemInitDeps {
  // ---- 题面原始 HTML ----
  /**
   * 读已落盘的题面原始 HTML。
   *
   * 契约：**不做 TTL 判定**。初始化问的是「有没有」而不是「新不新」，
   * 新鲜度由 S4 的重访刷新负责。
   */
  readProblemHtml: (pid: string) => Promise<string | undefined>;
  fetchProblemHtml: (pid: string) => Promise<string>;
  saveProblemHtml: (pid: string, html: string) => Promise<void>;

  /** 从原始 HTML 解析结构化详情（解析属 parser 层职责，此处注入） */
  parseDetail: (html: string) => ProblemDetail | null;

  /**
   * 登记 `pid → 目录名` 映射。**必须在写题目文件之前调用**。
   *
   * 目录名由缓存层按**身份**（全局题号，退化到题名）推导并定稿 —— 站点插队 / 删题
   * 会让序号整体平移，用序号定位会把新题写进旧题的目录（见 `cache/store.ts`）。
   * 这里只交身份信息（pid / 全局题号 / 题名），不参与命名决策。
   */
  registerProblem: (entry: { pid: string; globalId?: string; title: string }) => Promise<void>;

  // ---- 样例 ----
  readSamples: (pid: string) => Promise<SampleLike[]>;
  saveSamples: (pid: string, samples: SampleLike[]) => Promise<void>;

  // ---- 题面图片 ----
  /** 已落盘的图片文件名列表（非空即认为已抓取过） */
  listAssets: (pid: string) => Promise<string[]>;
  fetchAsset: (url: string) => Promise<Buffer>;
  saveAsset: (pid: string, url: string, data: Buffer) => Promise<void>;

  // ---- 源文件与目录 ----
  sourceFile: (pid: string) => string;
  /** 写源文件（**不受 `oj.cache.enabled` 影响**：关缓存不该阻止项目初始化） */
  writeSourceFile: (pid: string, content: string) => Promise<void>;
  fileExists: (file: string) => Promise<boolean>;
  ensureDir: (dir: string) => Promise<void>;
  tempDir: (pid: string) => string;
  testDir: (pid: string) => string;

  // ---- 环境 ----
  /** 离线时不发起任何网络请求；缺数据就如实报告，不报错 */
  isOffline: () => boolean;
  /** 错误 → 可读文案（通常复用 `session/guard` 的分类结果） */
  toError: (e: unknown) => string;
  log?: (msg: string) => void;
}

/** 单题初始化的结果 */
export interface EnsureProblemResult {
  pid: string;
  ok: boolean;
  /** 本次是否发起了网络请求（拉题面） */
  fetched: boolean;
  /** 本次是否**新建**了源文件（已存在则为 false） */
  createdSource: boolean;
  /** 本次落盘的题面图片数 */
  assets: number;
  /** 本次落盘的样例组数 */
  samples: number;
  /** 本次因为「已存在」而跳过的项 */
  skipped: string[];
  error?: string;
}

/** 取消令牌（与 VS Code 的 CancellationToken 结构兼容，便于注入） */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

export interface InitProgress {
  /** 1-based，与 total 配套用于显示 `i/N` */
  index: number;
  total: number;
  pid: string;
  /** 该题标题（可能为空） */
  title?: string;
}

export interface InitAllSummary {
  total: number;
  ok: number;
  failed: Array<{ pid: string; error: string }>;
  cancelled: boolean;
  /** 本次新建的源文件数 */
  createdSources: number;
  /** 本次落盘的图片总数 */
  assets: number;
}

export interface InitAllOptions {
  token?: CancellationLike;
  onProgress?: (p: InitProgress) => void;
}

export class ProblemInitializer {
  constructor(private deps: ProblemInitDeps) {}

  /**
   * 确保一道题在磁盘上完整落地（幂等）。
   *
   * 顺序不可调换：**先登记目录名，再写文件** —— 否则 `problemDir(pid)` 只能退化成
   * 数字 pid，等标题拿到后再改名会让已写入的 `raw/` 变成孤儿目录。
   *
   * 调用方须保证题目索引已按**最新列表**对齐（`fetchProblemList` 会顺带做），
   * 否则身份判定拿的是旧映射，题集重排后仍会把旧缓存当成新题的。
   */
  public async ensureProblem(hint: ProblemHint | string): Promise<EnsureProblemResult> {
    const { pid, globalId, title: hintTitle } = normalizeHint(hint);
    const result: EnsureProblemResult = {
      pid, ok: false, fetched: false, createdSource: false,
      assets: 0, samples: 0, skipped: [],
    };

    try {
      // 1) 题面原始 HTML：有就复用，没有才联网
      let html = await this.deps.readProblemHtml(pid);
      if (html) {
        result.skipped.push('题面（已有缓存）');
      } else {
        if (this.deps.isOffline()) {
          result.error = '离线且无本地缓存';
          this.deps.log?.(`[init] 题目 ${pid} 跳过：${result.error}`);
          return result;
        }
        html = await this.deps.fetchProblemHtml(pid);
        result.fetched = true;
      }

      // 2) 解析 + 登记身份（写任何文件之前；目录名由缓存层按身份推导并定稿）
      const detail = this.deps.parseDetail(html);
      const title = (detail?.title || hintTitle || '').trim();
      await this.deps.registerProblem({ pid, ...(globalId ? { globalId } : {}), title });

      // 3) 题面落盘
      if (result.fetched) {
        await this.deps.saveProblemHtml(pid, html);
      }

      // 4) 样例：**以题面为权威**（站点固定单组）。
      //    只判"有没有"是不够的：题集重排后同一目录里的样例可能属于别的题，
      //    拿错的期望输出比对会让本地测试得出错误的"通过"。
      if (detail && (detail.sampleInput || '') !== '') {
        const existing = await this.deps.readSamples(pid);
        const aligned = existing.length === 1
          && (existing[0].input ?? '').trim() === (detail.sampleInput ?? '').trim()
          && (existing[0].output ?? '').trim() === (detail.sampleOutput ?? '').trim();
        if (aligned) {
          result.skipped.push('样例（与题面一致）');
        } else {
          await this.deps.saveSamples(pid, [{ input: detail.sampleInput, output: detail.sampleOutput }]);
          result.samples = 1;
        }
      } else if (detail) {
        result.skipped.push('样例（题面未给出）');
      }

      // 5) 题面图片：按题面引用的 URL 集合**补齐缺失的**（已抓过的不重复下载）
      const urls = collectImageUrls(html);
      if (urls.length > 0 && !this.deps.isOffline()) {
        const have = new Set(await this.deps.listAssets(pid));
        const missing = urls.filter(u => !have.has(assetFileName(u)));
        if (missing.length === 0) {
          result.skipped.push(`图片（题面引用的 ${urls.length} 个都在本地）`);
        }
        for (const url of missing) {
          try {
            const buf = await this.deps.fetchAsset(url);
            await this.deps.saveAsset(pid, url, buf);
            result.assets += 1;
          } catch (e) {
            this.deps.log?.(`[init] 图片抓取失败 ${url}：${this.deps.toError(e)}`);
          }
        }
      }

      // 6) 源文件：**已存在绝不覆盖**（C6）
      const src = this.deps.sourceFile(pid);
      if (await this.deps.fileExists(src)) {
        result.skipped.push('源文件（已存在，不覆盖）');
      } else {
        await this.deps.writeSourceFile(pid, CPP_SKELETON);
        result.createdSource = true;
      }

      // 7) temp/ 与 test/ 落位（不写任何产物，S6 才产出）
      await this.deps.ensureDir(this.deps.tempDir(pid));
      await this.deps.ensureDir(this.deps.testDir(pid));

      result.ok = true;
      this.deps.log?.(`[init] 题目 ${pid} 就绪${result.fetched ? '（本次联网）' : '（全部命中本地）'}`);
      return result;
    } catch (e) {
      result.error = this.deps.toError(e);
      this.deps.log?.(`[init] 题目 ${pid} 初始化失败：${result.error}`);
      return result;
    }
  }

  /**
   * 全量初始化：对题目列表逐题 {@link ensureProblem}。
   *
   * **串行、不重试、可取消、单题失败不中断**（C9/C10）。取消后已完成的题**保留**。
   */
  public async initializeContest(hints: Array<ProblemHint | string>, opts: InitAllOptions = {}): Promise<InitAllSummary> {
    const list = hints.map(normalizeHint);
    const summary: InitAllSummary = {
      total: list.length, ok: 0, failed: [], cancelled: false, createdSources: 0, assets: 0,
    };

    for (let i = 0; i < list.length; i += 1) {
      if (opts.token?.isCancellationRequested) {
        summary.cancelled = true;
        this.deps.log?.(`[init] 用户取消，已完成 ${summary.ok}/${list.length}`);
        break;
      }
      const hint = list[i];
      opts.onProgress?.({ index: i + 1, total: list.length, pid: hint.pid, title: hint.title });

      const one = await this.ensureProblem(hint);
      if (one.ok) {
        summary.ok += 1;
        if (one.createdSource) { summary.createdSources += 1; }
        summary.assets += one.assets;
      } else {
        summary.failed.push({ pid: hint.pid, error: one.error ?? '未知错误' });
      }
    }

    return summary;
  }
}

/** 题面中的相对路径图片（只认站点内路径，页脚脚本里的绝对 URL 不抓） */
const IMG_SRC_RE = /<img\s+[^>]*src=["'](\/[^"']+)["'][^>]*>/gi;

export function collectImageUrls(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of (html || '').matchAll(IMG_SRC_RE)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

function normalizeHint(hint: ProblemHint | string): ProblemHint {
  return typeof hint === 'string' ? { pid: hint } : hint;
}
