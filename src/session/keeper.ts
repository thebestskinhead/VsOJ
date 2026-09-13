/**
 * 【会话层 · 保活与探测】
 *
 * 背景（docs/SITE_ANALYSIS.md §6）：
 *   HUSTOJ 的登录态完全绑定 `PHPSESSID`，其会话有效期取决于服务端
 *   `session.gc_maxlifetime`（默认约 24 分钟**空闲**）。判定依据是会话文件
 *   mtime，**任何携带该 `PHPSESSID` 的请求都会刷新 mtime** —— 因此定时发起
 *   一次极轻量请求即可续期，这就是「定时访问页面避免 Cookie 过期」的依据。
 *
 * 设计：
 *   - 心跳（beat）：默认 4 分钟一次，请求 `/csrf.php`（85 B、无副作用）
 *   - 探测（probe）：默认 10 分钟一次，复用 `AuthService.isLoggedIn()`
 *     （判定口径与手动刷新完全一致，不引入第二套标准）
 *   - 心跳连续失败达阈值才触发探测，避免把「网络抖动」误判为「登录过期」
 *
 * 本模块依赖通过 {@link KeeperDeps} 注入，因而是**纯时序逻辑**，可脱离
 * VS Code 运行时用桩测试（见 test/session-keeper.test.js）。
 */

export interface KeeperDeps {
  /** 轻量保活请求；失败应抛异常 */
  beat(): Promise<void>;
  /** 登录态探测；返回是否仍然登录 */
  probe(): Promise<boolean>;
  /** 当前是否应当保活（未登录 / 离线模式下应返回 false） */
  shouldRun(): boolean;
  /** 判定为登录失效时回调（只会在 probe 明确返回 false 时调用） */
  onExpired(reason: 'probe' | 'beat'): void;
  /** 每次心跳/探测结束后回调，用于刷新 UI（状态栏等） */
  onTick?(): void;
  /** 日志 */
  log(message: string): void;
}

export interface SessionStatus {
  running: boolean;
  lastBeatAt?: number;
  lastBeatOk?: boolean;
  lastProbeAt?: number;
  lastProbeOk?: boolean;
  consecutiveBeatFailures: number;
  /** 累计心跳次数（含失败） */
  beatCount: number;
  /** 最近一次错误信息 */
  lastError?: string;
}

export interface KeeperOptions {
  /** 心跳间隔（毫秒），<= 0 表示关闭心跳 */
  keepAliveIntervalMs: number;
  /** 探测间隔（毫秒），<= 0 表示不做定时探测 */
  probeIntervalMs: number;
  /** 心跳连续失败多少次后触发一次探测 */
  failureThreshold?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;

export class SessionKeeper {
  private deps: KeeperDeps;
  private opts: Required<KeeperOptions>;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** 重入保护：上一次心跳/探测未结束时跳过本次 */
  private beating = false;
  private probing = false;

  private status: SessionStatus = {
    running: false,
    consecutiveBeatFailures: 0,
    beatCount: 0,
  };

  /** 记录本实例是否已经上报过失效，避免重复弹窗 */
  private expiredReported = false;

  constructor(deps: KeeperDeps, opts: KeeperOptions) {
    this.deps = deps;
    this.opts = {
      keepAliveIntervalMs: opts.keepAliveIntervalMs,
      probeIntervalMs: opts.probeIntervalMs,
      failureThreshold: opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    };
  }

  get isRunning(): boolean { return this.running; }
  get currentStatus(): Readonly<SessionStatus> { return this.status; }

  /** 启动（重复调用安全） */
  start(): void {
    if (this.running) { return; }
    this.running = true;
    this.status.running = true;
    this.expiredReported = false;

    if (this.opts.keepAliveIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => { void this.beat(); }, this.opts.keepAliveIntervalMs);
      this.deps.log(`[keeper] 心跳已启用，间隔 ${Math.round(this.opts.keepAliveIntervalMs / 1000)}s`);
      // 启动即心跳一次，立刻刷新会话 mtime
      void this.beat();
    } else {
      this.deps.log('[keeper] 心跳已关闭（interval <= 0）');
    }

    if (this.opts.probeIntervalMs > 0) {
      this.probeTimer = setInterval(() => { void this.probeNow(); }, this.opts.probeIntervalMs);
      this.deps.log(`[keeper] 登录态探测已启用，间隔 ${Math.round(this.opts.probeIntervalMs / 1000)}s`);
    }
  }

  /** 停止（重复调用安全） */
  stop(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = undefined; }
    this.running = false;
    this.status.running = false;
    this.deps.log('[keeper] 已停止');
  }

  /** 配置变更后重启（读取新的间隔） */
  restart(opts: KeeperOptions): void {
    this.stop();
    this.opts = {
      keepAliveIntervalMs: opts.keepAliveIntervalMs,
      probeIntervalMs: opts.probeIntervalMs,
      failureThreshold: opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    };
    if (this.deps.shouldRun()) { this.start(); }
  }

  /**
   * 立即心跳一次。
   * 心跳失败只在**连续失败达阈值**时才升级为探测，避免网络抖动误报。
   */
  async beat(): Promise<boolean> {
    if (!this.running || this.beating) { return false; }
    if (!this.deps.shouldRun()) { return false; }

    this.beating = true;
    try {
      await this.deps.beat();
      this.status.beatCount++;
      this.status.lastBeatAt = Date.now();
      this.status.lastBeatOk = true;
      this.status.consecutiveBeatFailures = 0;
      this.status.lastError = undefined;
      return true;
    } catch (e: any) {
      this.status.beatCount++;
      this.status.lastBeatAt = Date.now();
      this.status.lastBeatOk = false;
      this.status.consecutiveBeatFailures++;
      this.status.lastError = e?.message || String(e);
      this.deps.log(`[keeper] 心跳失败（连续 ${this.status.consecutiveBeatFailures} 次）: ${this.status.lastError}`);
      if (this.status.consecutiveBeatFailures >= this.opts.failureThreshold) {
        this.deps.log('[keeper] 心跳连续失败达阈值，升级为登录态探测');
        await this.probeNow();
      }
      return false;
    } finally {
      this.beating = false;
      this.deps.onTick?.();
    }
  }

  /** 立即探测登录态。只有 probe 明确返回 false 才判定失效。 */
  async probeNow(): Promise<boolean> {
    if (this.probing) { return this.status.lastProbeOk ?? true; }
    if (!this.deps.shouldRun()) { return false; }

    this.probing = true;
    try {
      const ok = await this.deps.probe();
      this.status.lastProbeAt = Date.now();
      this.status.lastProbeOk = ok;
      if (ok) {
        this.status.consecutiveBeatFailures = 0;
        this.expiredReported = false;
      } else if (!this.expiredReported) {
        this.expiredReported = true;
        this.status.lastError = '登录态已失效';
        this.deps.log('[keeper] 探测确认登录已失效');
        this.deps.onExpired('probe');
      }
      return ok;
    } catch (e: any) {
      // 探测本身失败（网络问题）不判定为登录失效
      this.status.lastProbeAt = Date.now();
      this.status.lastProbeOk = undefined;
      this.status.lastError = e?.message || String(e);
      this.deps.log(`[keeper] 探测请求异常，暂不判定失效: ${this.status.lastError}`);
      return this.status.lastProbeOk ?? true;
    } finally {
      this.probing = false;
      this.deps.onTick?.();
    }
  }

  /** 状态快照（供状态栏与命令展示） */
  snapshot(): SessionStatus {
    return { ...this.status, running: this.running };
  }

  dispose(): void {
    this.stop();
  }
}
