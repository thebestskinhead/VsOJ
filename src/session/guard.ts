/**
 * 【会话层 · 失效识别与意图重放】
 *
 * 本模块是**唯一**判定「这次失败到底是不是登录过期」的地方。
 * 其它层（submit / views / webview / mcp）不得自行用字符串或状态码做推断。
 *
 * 判定依据来自 docs/SITE_ANALYSIS.md §5 的实测结论（HUSTOJ 定制版）：
 *   - submit.php 在会话失效时返回 **HTTP 500 且响应体为空**
 *   - problem.php 私有比赛未登录时正文为 `Not Invited!`
 *   - contest.php 无权限时正文为 `不能查看题目` / `尚未开始`
 *   - problem.php 比赛不存在时正文为 `No such Contest!`
 * 其中「HTTP 500 + 空体」是主信号（结构性），字符串仅作辅助（文案可能变）。
 */

/** 失败类型 */
export type FailureKind =
  /** 登录态失效 —— 需要重新登录 */
  | 'SESSION_EXPIRED'
  /** 登录有效但无权限（比赛未开始 / 私有 / 未受邀） */
  | 'NO_PERMISSION'
  /** 比赛或题目不存在 */
  | 'BAD_TARGET'
  /** 验证码错误 —— 重取验证码即可 */
  | 'INVALID_VCODE'
  /** 网络 / 服务端故障 */
  | 'NETWORK'
  /** 无法判定 */
  | 'UNKNOWN';

/** 需要重新登录的失败类型 */
export const RELOGIN_REQUIRED: ReadonlySet<FailureKind> = new Set<FailureKind>(['SESSION_EXPIRED']);

export interface ClassifiedFailure {
  kind: FailureKind;
  /** 面向用户的短提示 */
  message: string;
  /** 原始响应片段（截断），用于诊断与日志 */
  rawSnippet?: string;
  /** HTTP 状态码（如有） */
  status?: number;
}

/** 各类型的默认用户提示 */
const DEFAULT_MESSAGE: Record<FailureKind, string> = {
  SESSION_EXPIRED: '登录已过期，请重新登录后继续',
  NO_PERMISSION: '当前无权限访问该比赛（可能未开始或为私有比赛）',
  BAD_TARGET: '比赛或题目不存在',
  INVALID_VCODE: '验证码错误，请重新输入',
  NETWORK: '网络请求失败，请检查 OJ 服务器是否可达',
  UNKNOWN: '操作失败',
};

const SNIPPET_LIMIT = 500;

function snippet(body: string | undefined): string | undefined {
  if (!body) { return undefined; }
  const s = body.replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET_LIMIT ? `${s.slice(0, SNIPPET_LIMIT)}…` : s;
}

/** 从 HTML 正文判定失败类型（仅在主信号不足时使用） */
export function classifyHtmlBody(body: string | undefined): FailureKind | undefined {
  if (!body) { return undefined; }
  const text = body;

  // 明确要求登录
  if (/Not\s+Invited!/i.test(text)) { return 'NO_PERMISSION'; }
  if (text.includes('不能查看题目') || text.includes('尚未开始')) { return 'NO_PERMISSION'; }
  if (text.includes('No such Contest!') || text.includes('No such Problem!')) { return 'BAD_TARGET'; }

  // 落到了登录页 —— 说明请求被当作未登录处理
  if (looksLikeLoginPage(text)) { return 'SESSION_EXPIRED'; }

  // 验证码相关提示
  if (/验证码/.test(text) && /(错误|不正确|有误|不对)/.test(text)) { return 'INVALID_VCODE'; }
  if (/Invalid\s+(v)?code/i.test(text)) { return 'INVALID_VCODE'; }

  // 站点把未登录的提交请求重定向到登录页
  if (/Please\s+login/i.test(text) || /loginpage\.php/i.test(text)) { return 'SESSION_EXPIRED'; }

  return undefined;
}

/**
 * 判定一段 HTML 是否为 HUSTOJ 的**登录页**。
 *
 * 实测特征（docs/SITE_ANALYSIS.md §5）：
 *   登录页  → 含 `name="user_id"` 输入框 + `vcode.php` 验证码，且**不含** `logout.php`
 *   已登录页 → 含 `logout.php`
 *
 * 这个判定是「提交被重定向到登录页」场景的关键 —— 因为 axios 会自动跟随 302，
 * 调用方拿到的往往是**跟随之后**的登录页正文，而不是 302 本身。
 */
export function looksLikeLoginPage(html: string | undefined): boolean {
  if (!html) { return false; }
  const hasLoginForm = /name=["']user_id["']/.test(html) && /vcode\.php/.test(html);
  const hasLogoutMark = /logout\.php/.test(html);
  return hasLoginForm && !hasLogoutMark;
}

/**
 * 分类一次 HTTP 响应。
 *
 * @param status HTTP 状态码
 * @param body   响应体（可能为空字符串 / undefined）
 * @param hint   调用方补充的语义（如 'submit' / 'problem'）
 */
export function classifyHttpResponse(
  status: number,
  body: string | undefined,
  hint?: 'submit' | 'problem' | 'contest' | 'status',
): ClassifiedFailure {
  const raw = snippet(body);
  const empty = !body || body.trim().length === 0;

  // 主信号 1：submit.php 会话失效 → 500 + 空体（实测）
  if (status === 500 && empty && (hint === 'submit' || hint === undefined)) {
    return { kind: 'SESSION_EXPIRED', message: DEFAULT_MESSAGE.SESSION_EXPIRED, status, rawSnippet: raw };
  }

  // 主信号 2：任意 5xx 空体 —— 站点在异常分支上的一致性表现
  if (status >= 500 && empty) {
    return { kind: 'SESSION_EXPIRED', message: DEFAULT_MESSAGE.SESSION_EXPIRED, status, rawSnippet: raw };
  }

  // 注意：这里**不**把裸 302/303 判为失效。
  // HUSTOJ 提交成功后会 302 跳转到 status.php，是否失效取决于 Location 指向 /
  // 跟随后的落点，只有调用方（能拿到 headers 与最终正文）才有足够信息判断；
  // `client.ts` 默认 maxRedirects: 5，裸 302 通常根本不会暴露给分类器。

  // 辅助信号：正文文案
  const byBody = classifyHtmlBody(body);
  if (byBody) {
    return { kind: byBody, message: DEFAULT_MESSAGE[byBody], status, rawSnippet: raw };
  }

  if (status === 403) {
    return { kind: 'NO_PERMISSION', message: DEFAULT_MESSAGE.NO_PERMISSION, status, rawSnippet: raw };
  }
  if (status === 404) {
    return { kind: 'BAD_TARGET', message: DEFAULT_MESSAGE.BAD_TARGET, status, rawSnippet: raw };
  }

  return { kind: 'UNKNOWN', message: `${DEFAULT_MESSAGE.UNKNOWN}（HTTP ${status}）`, status, rawSnippet: raw };
}

/**
 * 分类一个抛出的异常。
 *
 * 兼容两种调用约定：
 *  - `client.ts` 的 `validateStatus: s => s < 500` → 5xx 会抛 axios 错误，需读 `e.response`
 *  - 调用方自行 `validateStatus: () => true` → 直接把响应交给 {@link classifyHttpResponse}
 */
export function classifyThrown(e: unknown): ClassifiedFailure {
  const err = e as {
    response?: { status?: number; data?: unknown };
    code?: string;
    message?: string;
  } | undefined;

  const status = err?.response?.status;
  if (typeof status === 'number') {
    const data = err?.response?.data;
    const body = typeof data === 'string' ? data : (data === undefined ? undefined : JSON.stringify(data));
    return classifyHttpResponse(status, body);
  }

  const code = err?.code || '';
  const msg = err?.message || String(e);

  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code)
    || /timeout/i.test(code)
    || /Network Error/i.test(msg)) {
    return { kind: 'NETWORK', message: `${DEFAULT_MESSAGE.NETWORK}（${msg}）` };
  }

  return { kind: 'UNKNOWN', message: msg, rawSnippet: snippet(msg) };
}

/** 是否需要重新登录（接受 `'OK'` 以便直接传入提交结果类型） */
export function needsRelogin(kind: FailureKind | 'OK'): boolean {
  return kind !== 'OK' && RELOGIN_REQUIRED.has(kind);
}

// ============================================================
// 意图重放
// ============================================================

/** 待重放的用户意图 —— 因登录失效而中断，重新登录后原地继续 */
export type PendingIntentKind =
  /** 提交源码 */
  | 'submit'
  /** 打开某道题的题面 */
  | 'open-problem'
  /** 进入某个比赛（题目列表） */
  | 'enter-contest';

/**
 * 待重放的用户意图。
 *
 * 只记**用户想去哪**（比赛 + 题目，加提交所需的最小信息），不记内容：
 * 源码在重放时重新读盘，避免持有一份已经过期的副本。
 */
export interface PendingIntent {
  kind: PendingIntentKind;
  cid: string;
  /** 题目序号；`enter-contest` 下为空串 */
  pid: string;
  /** 源码文件绝对路径（重放时重新读盘，避免持有过期内容）；仅 `submit` 用 */
  sourceFile?: string;
  /** 期望语言编号（可选，缺省时按文件扩展名推断）；仅 `submit` 用 */
  language?: number;
  /** 记录时间（ISO），超时后自动失效 */
  createdAt: string;
}

/** 意图存储抽象（`vscode.Memento` 兼容，便于测试注入） */
export interface IntentStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const INTENT_KEY = 'oj_pending_intent';
/** 意图有效期：超过视为陈旧，丢弃以免误触发 */
export const INTENT_TTL_MS = 30 * 60 * 1000;

/**
 * 会话守卫：保存「因登录失效而中断的意图」，并在重新登录成功后交还调用方重放。
 *
 * 之所以持久化：用户可能在登录页停留很久，甚至重启 VS Code。
 */
export class SessionGuard {
  private storage: IntentStorage;

  constructor(storage: IntentStorage) {
    this.storage = storage;
  }

  /** 记录一个待重放意图（覆盖旧的） */
  async setPending(intent: Omit<PendingIntent, 'createdAt'>): Promise<PendingIntent> {
    const full: PendingIntent = { ...intent, createdAt: new Date().toISOString() };
    await this.storage.update(INTENT_KEY, full);
    return full;
  }

  /** 读取未过期的待重放意图；已过期则自动清除 */
  async peekPending(): Promise<PendingIntent | undefined> {
    const raw = this.storage.get<PendingIntent>(INTENT_KEY);
    if (!raw) { return undefined; }
    const age = Date.now() - Date.parse(raw.createdAt || '');
    if (!Number.isFinite(age) || age > INTENT_TTL_MS) {
      await this.clearPending();
      return undefined;
    }
    return raw;
  }

  async clearPending(): Promise<void> {
    await this.storage.update(INTENT_KEY, undefined);
  }

  /**
   * 重放：取出意图 → 交给 `handler` 执行 → 无论成败都清除。
   * 返回是否真的重放了（无意图时返回 false）。
   */
  async replay(handler: (intent: PendingIntent) => Promise<void>): Promise<boolean> {
    const intent = await this.peekPending();
    if (!intent) { return false; }
    await this.clearPending();
    await handler(intent);
    return true;
  }
}
