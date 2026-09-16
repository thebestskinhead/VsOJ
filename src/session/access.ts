import { classifyHtmlBody } from './guard';
import { OfflineNoCacheError } from '../cache/store';

/**
 * 【会话层 · 访问裁决】
 *
 * 唯一判定「这次取数允不允许、数据从哪来」的地方。
 *
 * ## 为什么必须由本层把关
 *
 * 站点自己**不设防**：公开比赛的 `problem.php` 匿名即渲染完整题面，
 * `contest.php` 列表匿名也能看，`status.php` 匿名可见（docs/SITE_ANALYSIS.md §2）。
 * 也就是说「未登录不给看」在服务端根本不成立，只能由扩展自己在**发请求之前**判 ——
 * 事后看响应体已经晚了，内容已经拿到手、甚至已经渲染出来了。
 *
 * ## 登录态与离线的分工
 *
 * 登录是本机功能的前提；免登录读缓存的许可**只**来自强制离线开关
 * （配置项 `oj.cache.offline` 由用户主动打开）。可达性探测**不能**作为这条授权
 * 的来源：探测只反映网络层「站点通不通」，与「用户有没有登录」毫无关系；把它当成
 * 授权会让一次网络抖动悄悄降级成「脱机模式」，用户最反感的就是这种静默退化。
 *
 * | 登录态 | 强制离线（开关打开） | 其余情况 |
 * |---|---|---|
 * | 未登录 | 读缓存（无缓存则说清「离线且无缓存」） | 拒绝，去登录 |
 * | 已登录 | 读缓存（网络本来就不通） | 正常联网 |
 *
 * 「其余情况」包含**可达但请求失败**的隐式降级：站点抽风时若悄悄拿缓存顶上，
 * 用户会对着缓存写完整段代码、输完验证码点提交，才发现自己根本没登录。
 * 一开始就拦住，比中途打断便宜得多。
 *
 * 已登录用户的缓存降级不受这条限制 —— 他本来就有权限，给他看旧数据是帮忙。
 *
 * ## 与相邻模块的分工
 *
 *  - `session/connectivity.ts` 只回答「站点可不可达」，不判登录
 *  - `session/guard.ts` 只回答「这次失败属于什么性质」
 *  - 本模块回答「**这次访问该不该发生**」，是三者的汇合点
 */

/** 要访问的站点资源。写操作与读操作在离线下的待遇不同 */
export type AccessTarget =
  /** 比赛列表 */
  | 'contest-list'
  /** 某比赛的题目列表 */
  | 'problem-list'
  /** 题面 */
  | 'problem'
  /** 提交状态 */
  | 'status'
  /** 提交答案（写操作） */
  | 'submit';

/** 目标是否为写操作 —— 离线不可能成功，也没有缓存可读 */
export function isWriteTarget(target: AccessTarget): boolean {
  return target === 'submit';
}

/** 这次访问处在哪种态 */
export type AccessMode =
  /** 正常联网 */
  | 'site'
  /** 只能读本地缓存 */
  | 'offline'
  /** 未登录，挡回去登录 */
  | 'login-required';

export type AccessReason =
  /** 未登录 —— 必须登录（与站点是否可达无关） */
  | 'LOGIN_REQUIRED'
  /** 离线，本地也没有这份东西 */
  | 'OFFLINE_NO_CACHE'
  /** 离线下的写操作 */
  | 'OFFLINE_WRITE';

export type AccessVerdict =
  | { kind: 'site' }
  | { kind: 'cache' }
  | { kind: 'deny'; reason: AccessReason };

export interface AccessFacts {
  loggedIn: boolean;
  /** `oj.cache.offline = true` */
  forcedOffline: boolean;
}

/**
 * 判定访问处在哪种态。纯函数。
 *
 * 免登录读缓存的许可**只**来自强制离线开关；可达性探测不参与裁决（它只说明
 * 网络通不通，与登录态无关，绝不能用来放宽未登录的访问）。
 */
export function accessMode(f: AccessFacts): AccessMode {
  if (f.forcedOffline) { return 'offline'; }
  if (f.loggedIn) { return 'site'; }
  return 'login-required';
}

/**
 * 在已知「态」与「本地有没有这份东西」之后给出裁决。纯函数。
 *
 * 拆成两步是为了让调用方**只在必要时才去查缓存**：联网态与未登录态都不需要
 * 知道本地有没有缓存。
 */
export function decideAccess(target: AccessTarget, mode: AccessMode, hasCache: boolean): AccessVerdict {
  if (mode === 'login-required') {
    return { kind: 'deny', reason: 'LOGIN_REQUIRED' };
  }
  if (mode === 'offline') {
    if (isWriteTarget(target)) {
      return { kind: 'deny', reason: 'OFFLINE_WRITE' };
    }
    return hasCache ? { kind: 'cache' } : { kind: 'deny', reason: 'OFFLINE_NO_CACHE' };
  }
  return { kind: 'site' };
}

/** 各拒绝原因的人话 */
export const ACCESS_MESSAGE: Record<AccessReason, string> = {
  LOGIN_REQUIRED: '未登录，请先登录后再访问',
  OFFLINE_NO_CACHE: '离线且本地无缓存，无法获取该内容',
  OFFLINE_WRITE: '离线状态下无法提交',
};

/**
 * 访问被拒 —— 需要登录（或重新登录）。
 *
 * 与 `OfflineNoCacheError` 分开的理由相同：上层要能区分「你去登录就能解决」
 * 和「现在就是拿不到」，否则会讲成一句与事实不符的「加载失败」。
 */
export class LoginRequiredError extends Error {
  public readonly code = 'LOGIN_REQUIRED';
  /** 触发拒绝的目标，供上层挑选文案 */
  public readonly target: AccessTarget;

  constructor(target: AccessTarget, message?: string) {
    super(message ?? ACCESS_MESSAGE.LOGIN_REQUIRED);
    this.name = 'LoginRequiredError';
    this.target = target;
  }
}

/** 离线且无缓存的写操作 —— 语义上是「离线不可能」，不是「缺数据」 */
export class OfflineWriteError extends Error {
  public readonly code = 'OFFLINE_WRITE';

  constructor() {
    super(ACCESS_MESSAGE.OFFLINE_WRITE);
    this.name = 'OfflineWriteError';
  }
}

/** 被拒绝时统一按原因抛出（成功裁决返回 null） */
export function throwIfDenied(verdict: AccessVerdict, target: AccessTarget): void {
  if (verdict.kind !== 'deny') { return; }
  if (verdict.reason === 'LOGIN_REQUIRED') { throw new LoginRequiredError(target); }
  if (verdict.reason === 'OFFLINE_WRITE') { throw new OfflineWriteError(); }
  throw new OfflineNoCacheError(OFFLINE_TARGET_NAME[target]);
}

/** `OfflineNoCacheError` 的 `target` 文案（离线时拿不到什么） */
const OFFLINE_TARGET_NAME: Record<AccessTarget, string> = {
  'contest-list': '比赛列表',
  'problem-list': '题目列表',
  problem: '题目内容',
  status: '提交状态',
  submit: '提交入口',
};

export interface AccessGateDeps {
  /** 本机记录的登录态 */
  isLoggedIn(): boolean;
  /** `oj.cache.offline` */
  isForcedOffline(): boolean;
  /**
   * 请求响应体表明会话已在服务端失效时回调。
   *
   * 由闸门统一广播，避免每个 service 各写一遍「降级登录态 + 关面板 + 弹提示」。
   */
  onSessionLost?(reason: string): void;
  log?(message: string): void;
}

/**
 * 访问闸门。
 *
 * 取数前 `check()`，拿到响应后 `noteResponse()` —— 这两处就是全部接缝，
 * 凡是向站点取数的地方都从这里走，不再各自判登录态。
 */
export class AccessGate {
  private deps: AccessGateDeps;
  /** 已就「会话失效」广播过、还没等到重新登录 —— 避免每个在途请求各弹一次 */
  private sessionLostReported = false;

  constructor(deps: AccessGateDeps) {
    this.deps = deps;
  }

  /**
   * 裁决一次访问。
   *
   * @param probeCache 本地有没有这份内容。**只在离线态下才会被调用** ——
   *                   联网态与未登录态都不需要知道，省一次文件系统探查。
   */
  public async check(target: AccessTarget, probeCache: () => boolean | Promise<boolean>): Promise<AccessVerdict> {
    const loggedIn = this.deps.isLoggedIn();
    const forcedOffline = this.deps.isForcedOffline();

    const mode = accessMode({ loggedIn, forcedOffline });
    if (mode !== 'offline') {
      return decideAccess(target, mode, false);
    }
    return decideAccess(target, mode, await probeCache());
  }

  /**
   * 核对一次响应体：站点是否把这次请求当成未登录处理了。
   *
   * 登录态在本机是**缓存**的，服务端那边可能早已作废（HUSTOJ 会话按空闲时间回收，
   * 见 docs/SITE_ANALYSIS.md §6）。这个函数就是那条「读时校验」：一旦响应露出
   * 登录页特征，立刻把本机登录态降级并广播，避免用户继续对着缓存写代码。
   *
   * @returns 是否判定为会话失效
   */
  public noteResponse(html: unknown): boolean {
    if (typeof html !== 'string' || !html) { return false; }
    if (classifyHtmlBody(html) !== 'SESSION_EXPIRED') { return false; }
    this.reportSessionLost('响应被站点当作未登录处理');
    return true;
  }

  private reportSessionLost(reason: string): void {
    if (this.sessionLostReported) { return; }
    this.sessionLostReported = true;
    this.deps.log?.(`[access] 判定会话失效：${reason}`);
    this.deps.onSessionLost?.(reason);
  }

  /** 重新登录成功后调用：允许下一次会话失效再广播一次 */
  public sessionRenewed(): void {
    this.sessionLostReported = false;
  }

  /** 当前是否处于已登录态（只读，供 service 判断「登录态是否已失效」） */
  public isLoggedIn(): boolean {
    return this.deps.isLoggedIn();
  }

  /** 由 service 在「站点把本应授权的请求判为未授权」时调用，对齐会话失效状态并广播 */
  public noteSessionLost(reason: string): void {
    this.reportSessionLost(reason);
  }

  /** 当前是否已判定会话失效（未重新登录） */
  public get sessionLost(): boolean {
    return this.sessionLostReported;
  }
}
