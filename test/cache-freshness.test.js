// 新鲜度判定（cache/freshness.ts）— 纯函数，无需 vscode 桩
// 运行：node test/cache-freshness.test.js
const { makeChecker } = require('./helpers/stub');
const F = require('../out/cache/freshness.js');

const { check, ok, done } = makeChecker();
const NOW = 1_700_000_000_000;

console.log('[1] computeStat');
{
  const s = F.computeStat('/x', undefined, NOW);
  check('文件不存在 → exists=false', s.exists, false);
  check('文件不存在 → mtimeMs undefined', s.mtimeMs, undefined);
  check('文件不存在 → ageMs undefined', s.ageMs, undefined);

  const s2 = F.computeStat('/x', NOW - 5000, NOW);
  check('存在 → exists=true', s2.exists, true);
  check('存在 → ageMs', s2.ageMs, 5000);

  const s3 = F.computeStat('/x', NOW + 9999, NOW);
  check('mtime 在未来 → ageMs 归零（不产生负数）', s3.ageMs, 0);
}

console.log('\n[2] isStale 边界（15 分钟 = 900_000ms）');
const STALE = 900_000;
check('无缓存（undefined）→ 需要更新', F.isStale(undefined, STALE), true);
check('0ms → 新鲜', F.isStale(0, STALE), false);
check('899_999ms → 新鲜', F.isStale(899_999, STALE), false);
check('900_000ms → 过期（边界含）', F.isStale(900_000, STALE), true);
check('900_001ms → 过期', F.isStale(900_001, STALE), true);
check('negative staleMs=-1 → 永不过期', F.isStale(9_999_999_999, -1), false);
check('staleMs=-1 且无缓存 → 仍需要更新', F.isStale(undefined, -1), true);

console.log('\n[3] formatAge');
check('undefined → 未知', F.formatAge(undefined), '未知');
check('0 → 刚刚', F.formatAge(0), '刚刚');
check('59s → 刚刚', F.formatAge(59_000), '刚刚');
check('60s → 1 分钟前', F.formatAge(60_000), '1 分钟前');
check('3min → 3 分钟前', F.formatAge(180_000), '3 分钟前');
check('59min → 59 分钟前', F.formatAge(59 * 60_000), '59 分钟前');
check('60min → 1 小时前', F.formatAge(60 * 60_000), '1 小时前');
check('23h → 23 小时前', F.formatAge(23 * 3_600_000), '23 小时前');
check('24h → 1 天前', F.formatAge(24 * 3_600_000), '1 天前');
check('负数归零 → 刚刚', F.formatAge(-1000), '刚刚');

process.exit(done() ? 0 : 1);
