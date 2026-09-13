/**
 * 【缓存层 · 新鲜度】
 *
 * 纯粹的「缓存有多旧 / 算不算过期」判定，**不依赖 VS Code、不做 IO**。
 * 所有时间基准都是缓存文件的 mtime = 上次成功从网络同步的时间。
 *
 * 之所以独立成模块：这套判定既被「重访决策」用，也被「题目页信息栏」用，
 * 两处必须同口径；而且它值得被单独测透（边界值、负数、无缓存）。
 */

/** 缓存文件的年龄快照 */
export interface CacheStat {
  path: string;
  /** 文件是否存在 */
  exists: boolean;
  /** 文件 mtime（毫秒时间戳）；不存在则 undefined */
  mtimeMs?: number;
  /** 距今毫秒数；不存在则 undefined */
  ageMs?: number;
}

/** 构造年龄快照（`mtimeMs` 为 undefined 表示文件不存在） */
export function computeStat(path: string, mtimeMs: number | undefined, now: number): CacheStat {
  if (mtimeMs === undefined) {
    return { path, exists: false };
  }
  return {
    path,
    exists: true,
    mtimeMs,
    ageMs: Math.max(0, now - mtimeMs),
  };
}

/**
 * 是否已超过「异步刷新」阈值。
 *
 * - `staleMs < 0` → 永不过期（配置项填负数时的语义）
 * - `ageMs` 未定义（无缓存）→ 视为需要更新
 * - 边界取「含」：ageMs >= staleMs 即过期（900_000ms 恰好 15 分钟 → 过期）
 */
export function isStale(ageMs: number | undefined, staleMs: number): boolean {
  if (ageMs === undefined) { return true; }
  if (staleMs < 0) { return false; }
  return ageMs >= staleMs;
}

/**
 * 人类可读的时长：`刚刚` / `3 分钟前` / `2 小时前` / `1 天前`。
 * 用于题目页信息栏的「更新于 X」。
 */
export function formatAge(ageMs: number | undefined): string {
  if (ageMs === undefined) { return '未知'; }
  const sec = Math.max(0, Math.floor(ageMs / 1000));
  if (sec < 60) { return '刚刚'; }
  const min = Math.floor(sec / 60);
  if (min < 60) { return `${min} 分钟前`; }
  const hour = Math.floor(min / 60);
  if (hour < 24) { return `${hour} 小时前`; }
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}
