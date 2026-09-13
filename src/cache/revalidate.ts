import { isStale } from './freshness';

/**
 * 【缓存层 · 重访决策】
 *
 * 打开题目页时「首屏从哪来、要不要后台刷新」的**唯一决策点**。
 *
 * 设计要点：
 *  - 首屏**绝不阻塞在网络**上（这是「离线预览」的核心）；
 *  - 只在「有缓存 + 已过期 + 非离线模式」时才去探测网络（避免无谓探测）；
 *  - 决策与执行分离：本模块只产出 {@link RevisitPlan}，刷新动作由调用方按
 *    `backgroundRefresh` 自行触发（fire-and-forget），因此**可脱离 VS Code 单测**。
 */

/** 首屏数据来源 */
export type RevisitSource = 'cache' | 'network';

/** 决策原因（用于日志与测试断言） */
export type RevisitReason =
  /** 离线模式：只读缓存 */
  | 'offline'
  /** 缓存新鲜：零请求 */
  | 'fresh'
  /** 缓存过期且网络可达：先渲染缓存，后台刷新 */
  | 'stale'
  /** 缓存过期但网络不可达：静默使用缓存（被动场景，不打扰用户） */
  | 'unreachable'
  /** 无缓存：只能走网络 */
  | 'no-cache';

export interface RevisitPlan {
  /** 首屏用什么渲染 */
  source: RevisitSource;
  /** 首屏渲染后是否需要后台刷新 */
  backgroundRefresh: boolean;
  /** 本地是否有可用缓存（离线且无缓存时，渲染层需给出「无法获取」提示） */
  hasCache: boolean;
  /** 缓存年龄（毫秒）；无缓存则 undefined */
  ageMs?: number;
  reason: RevisitReason;
}

export interface RevisitInput {
  offline: boolean;
  hasCache: boolean;
  ageMs?: number;
  /** 异步刷新阈值（毫秒），负数表示永不过期 */
  staleMs: number;
  /** 可达性探测结果；仅当需要时才由调用方提供 */
  reachable?: boolean;
}

/** 纯决策函数（无 IO、无副作用） */
export function planRevisit(input: RevisitInput): RevisitPlan {
  const { offline, hasCache, ageMs, staleMs } = input;

  // 1) 离线模式：不管多旧都吃缓存，绝不联网
  if (offline) {
    return {
      source: hasCache ? 'cache' : 'network',
      backgroundRefresh: false,
      hasCache,
      ageMs,
      reason: 'offline',
    };
  }

  // 2) 无缓存：只能走网络
  if (!hasCache) {
    return { source: 'network', backgroundRefresh: false, hasCache: false, reason: 'no-cache' };
  }

  // 3) 缓存新鲜：零请求
  if (!isStale(ageMs, staleMs)) {
    return { source: 'cache', backgroundRefresh: false, hasCache: true, ageMs, reason: 'fresh' };
  }

  // 4) 过期但不可达：静默降级（被动场景不打扰用户）
  if (input.reachable === false) {
    return { source: 'cache', backgroundRefresh: false, hasCache: true, ageMs, reason: 'unreachable' };
  }

  // 5) 过期且可达：先渲染缓存，再后台刷新
  return { source: 'cache', backgroundRefresh: true, hasCache: true, ageMs, reason: 'stale' };
}

export interface ResolveRevisitDeps {
  isOffline: () => boolean;
  /** 本地是否有题目页缓存 */
  hasCache: () => boolean;
  /** 缓存年龄（毫秒）；无缓存返回 undefined */
  ageMs: () => number | undefined;
  staleMs: () => number;
  isReachable: () => Promise<boolean>;
  log?: (msg: string) => void;
}

/**
 * 决策编排：仅在必要时才探测网络可达性，然后交给 {@link planRevisit}。
 *
 * 注意本函数**不执行刷新** —— 刷新由调用方按 `plan.backgroundRefresh` 决定，
 * 这样才能保证首屏渲染不被网络阻塞。
 */
export async function resolveRevisitPlan(deps: ResolveRevisitDeps): Promise<RevisitPlan> {
  const offline = deps.isOffline();
  const hasCache = deps.hasCache();
  const ageMs = deps.ageMs();
  const staleMs = deps.staleMs();

  // 只有「在线 + 有缓存 + 已过期」才值得探测网络，其余分支不探测
  let reachable: boolean | undefined;
  if (!offline && hasCache && isStale(ageMs, staleMs)) {
    reachable = await deps.isReachable();
  }

  const plan = planRevisit({ offline, hasCache, ageMs, staleMs, reachable });
  deps.log?.(`[revalidate] 决策=${plan.reason} 来源=${plan.source} 后台刷新=${plan.backgroundRefresh} 年龄=${ageMs ?? '—'}ms`);
  return plan;
}
