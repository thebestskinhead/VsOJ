/**
 * 【缓存层 · 刷新执行】
 *
 * 「单题强制刷新」与「全量强制刷新」的执行器。**只执行，不管 UI**。
 *
 * 所有网络与落盘动作都通过 {@link RefresherDeps} 注入，因此可以脱离 VS Code
 * 单测（延续 S2 `SessionKeeper` 的依赖注入做法）。
 *
 * 契约（见 docs/PLAN_S4.md §1）：
 *  - **串行**，一次一题，不并发、不重试（对手写式教学 OJ 友好）
 *  - 单题失败**不中断**全量刷新，最后汇总
 *  - 用户取消时，**已完成的保留**，不回滚（缓存层面无一致性要求）
 */

export interface RefreshOneResult {
  pid: string;
  ok: boolean;
  error?: string;
}

export interface RefreshFailure {
  pid: string;
  error: string;
}

export interface RefreshAllSummary {
  /** 计划刷新的题目数（来自最新题目列表） */
  total: number;
  ok: number;
  failed: RefreshFailure[];
  /** 是否被用户取消 */
  cancelled: boolean;
  /** 题目列表本身是否刷新成功 */
  contestListOk: boolean;
  /** 提交状态是否刷新成功 */
  statusOk: boolean;
}

export interface RefreshProgress {
  /** 1-based，与 total 配套用于显示 `i/N` */
  index: number;
  total: number;
  pid: string;
}

/** 取消令牌（与 VS Code 的 CancellationToken 结构兼容，便于注入） */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

export interface RefresherDeps {
  /** 拉比赛页（题目列表来源） */
  fetchContestHtml: () => Promise<string>;
  /** 拉单个题目页 */
  fetchProblemHtml: (pid: string) => Promise<string>;
  /** 拉状态页 */
  fetchStatusHtml: () => Promise<string>;

  saveContestHtml: (html: string) => Promise<void>;
  saveProblemHtml: (pid: string, html: string) => Promise<void>;
  saveStatusHtml: (html: string) => Promise<void>;

  /** 从比赛页 HTML 解析出 pid 列表（解析属 api/parser 层职责，此处注入） */
  listPids: (contestHtml: string) => string[];

  /** 错误 → 可读文案（通常复用 session/guard 的分类结果） */
  toError: (e: unknown) => string;

  log?: (msg: string) => void;
}

export interface RefreshAllOptions {
  token?: CancellationLike;
  onProgress?: (p: RefreshProgress) => void;
}

export class ProblemRefresher {
  constructor(private deps: RefresherDeps) {}

  /**
   * 单题强制刷新：无视任何新鲜度阈值，直接拉取并覆盖缓存。
   * 失败时由调用方决定如何上报（C10：用户显式点击的刷新必须报错）。
   */
  public async refreshOne(pid: string): Promise<RefreshOneResult> {
    try {
      const html = await this.deps.fetchProblemHtml(pid);
      await this.deps.saveProblemHtml(pid, html);
      this.deps.log?.(`[refresh] 题目 ${pid} 已刷新`);
      return { pid, ok: true };
    } catch (e) {
      const error = this.deps.toError(e);
      this.deps.log?.(`[refresh] 题目 ${pid} 刷新失败：${error}`);
      return { pid, ok: false, error };
    }
  }

  /**
   * 全量强制刷新：题目列表 → 逐题详情（串行）→ 提交状态。
   *
   * 顺序不可颠倒：题目列表先落盘，才能知道要刷哪些题。
   */
  public async refreshAll(opts: RefreshAllOptions = {}): Promise<RefreshAllSummary> {
    const summary: RefreshAllSummary = {
      total: 0,
      ok: 0,
      failed: [],
      cancelled: false,
      contestListOk: false,
      statusOk: false,
    };

    // 1) 题目列表
    let pids: string[] = [];
    try {
      const contestHtml = await this.deps.fetchContestHtml();
      await this.deps.saveContestHtml(contestHtml);
      pids = this.deps.listPids(contestHtml);
      summary.contestListOk = true;
      summary.total = pids.length;
      this.deps.log?.(`[refresh] 题目列表已刷新，共 ${pids.length} 题`);
    } catch (e) {
      this.deps.log?.(`[refresh] 题目列表刷新失败：${this.deps.toError(e)}`);
      return summary;
    }

    // 2) 逐题详情（严格串行）
    for (let i = 0; i < pids.length; i += 1) {
      if (opts.token?.isCancellationRequested) {
        summary.cancelled = true;
        this.deps.log?.(`[refresh] 用户取消，已完成 ${summary.ok}/${pids.length}`);
        break;
      }
      const pid = pids[i];
      opts.onProgress?.({ index: i + 1, total: pids.length, pid });

      const one = await this.refreshOne(pid);
      if (one.ok) {
        summary.ok += 1;
      } else {
        summary.failed.push({ pid, error: one.error ?? '未知错误' });
      }
    }

    // 3) 提交状态（即便中途取消也尝试补上，失败不影响整体结论）
    if (!opts.token?.isCancellationRequested) {
      try {
        const statusHtml = await this.deps.fetchStatusHtml();
        await this.deps.saveStatusHtml(statusHtml);
        summary.statusOk = true;
        this.deps.log?.('[refresh] 提交状态已刷新');
      } catch (e) {
        this.deps.log?.(`[refresh] 提交状态刷新失败：${this.deps.toError(e)}`);
      }
    }

    return summary;
  }
}
