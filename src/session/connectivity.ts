/**
 * 【会话层 · 网络可达性】
 *
 * 只回答一个问题：**现在能不能访问 OJ 站点**。
 *
 * 与 `session/guard.ts` 的分工务必分清：
 *  - `guard` 判定「这次请求失败属于什么性质」（登录失效 / 无权限 / 网络…）
 *  - 本模块只做「可达性」探测，**不作为登录态判据**，也不解读响应状态码
 *
 * 判定口径：**只要拿到了 HTTP 响应就算可达**，即使是 4xx/5xx。
 * 因此调用方提供的 `ping` 必须使用 `validateStatus: () => true`，
 * 只在网络层真正失败（DNS / 连接拒绝 / 超时）时才抛错。
 */

export interface ConnectivityDeps {
  /** 实际探测。选用最小、无副作用的端点（本站为 `/csrf.php`，约 85 字节） */
  ping: () => Promise<void>;
  now?: () => number;
  /** 结果缓存时长（毫秒），默认 30_000 —— 避免用户连点若干题目时重复探测 */
  ttlMs?: number;
  log?: (msg: string) => void;
}

export interface ConnectivitySnapshot {
  lastProbeAt?: number;
  lastOk?: boolean;
  /** 真实发起探测的次数（不含缓存命中） */
  probeCount: number;
  /** 命中结果缓存的次数 */
  cachedHitCount: number;
}

export class ConnectivityProbe {
  private deps: ConnectivityDeps;
  private lastProbeAt = 0;
  private lastOk?: boolean;
  private probeCount = 0;
  private cachedHitCount = 0;
  /** 并发合并：同一时刻只允许一个探测在飞 */
  private inflight?: Promise<boolean>;

  constructor(deps: ConnectivityDeps) {
    this.deps = deps;
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get ttlMs(): number {
    return this.deps.ttlMs ?? 30_000;
  }

  /**
   * 站点是否可达。
   * @param force 忽略结果缓存，强制重新探测
   */
  public async isReachable(force: boolean = false): Promise<boolean> {
    if (!force && this.lastOk !== undefined && this.now - this.lastProbeAt < this.ttlMs) {
      this.cachedHitCount += 1;
      return this.lastOk;
    }

    if (this.inflight) { return this.inflight; }

    this.inflight = this.runProbe().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async runProbe(): Promise<boolean> {
    let ok = false;
    try {
      await this.deps.ping();
      ok = true;
    } catch (e: any) {
      ok = false;
      this.deps.log?.(`[connectivity] 探测失败：${e?.message ?? e}`);
    }
    this.lastOk = ok;
    this.lastProbeAt = this.now;
    this.probeCount += 1;
    if (ok) { this.deps.log?.('[connectivity] 站点可达'); }
    return ok;
  }

  /** 作废结果缓存（例如配置变更、或刚发生过一次网络失败） */
  public invalidate(): void {
    this.lastOk = undefined;
    this.lastProbeAt = 0;
  }

  public snapshot(): ConnectivitySnapshot {
    return {
      lastProbeAt: this.lastProbeAt || undefined,
      lastOk: this.lastOk,
      probeCount: this.probeCount,
      cachedHitCount: this.cachedHitCount,
    };
  }
}
