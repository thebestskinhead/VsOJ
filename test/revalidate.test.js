// 重访刷新决策（cache/revalidate.ts）
// 运行：node test/revalidate.test.js
const { makeChecker } = require('./helpers/stub');
const R = require('../out/cache/revalidate.js');

const { check, ok, done } = makeChecker();
const STALE = 900_000;

console.log('[1] planRevisit — 离线模式');
{
  const p = R.planRevisit({ offline: true, hasCache: true, ageMs: 10_000_000, staleMs: STALE });
  check('离线 + 有缓存 → 用缓存', p.source, 'cache');
  check('离线 → 不后台刷新', p.backgroundRefresh, false);
  check('离线 → reason', p.reason, 'offline');

  const p2 = R.planRevisit({ offline: true, hasCache: false, staleMs: STALE });
  check('离线 + 无缓存 → 只能报网络（渲染层降级为「无法获取」）', p2.source, 'network');
  check('离线 + 无缓存 → 不后台刷新', p2.backgroundRefresh, false);
  check('离线 + 无缓存 → reason', p2.reason, 'offline');

  const p3 = R.planRevisit({ offline: true, hasCache: true, ageMs: 0, staleMs: STALE });
  check('离线时新鲜与否都不影响结论', p3.reason, 'offline');
}

console.log('\n[2] planRevisit — 无缓存');
{
  const p = R.planRevisit({ offline: false, hasCache: false, staleMs: STALE });
  check('无缓存 → 走网络', p.source, 'network');
  check('无缓存 → 不后台刷新（首屏就是网络）', p.backgroundRefresh, false);
  check('无缓存 → reason', p.reason, 'no-cache');
}

console.log('\n[3] planRevisit — 缓存新鲜（零请求）');
{
  for (const [age, label] of [[0, '0ms'], [899_999, '899_999ms'], [899_000, '899s']]) {
    const p = R.planRevisit({ offline: false, hasCache: true, ageMs: age, staleMs: STALE });
    check(`${label} → 用缓存`, p.source, 'cache');
    check(`${label} → 不刷新`, p.backgroundRefresh, false);
    check(`${label} → reason`, p.reason, 'fresh');
  }
}

console.log('\n[4] planRevisit — 已过期');
{
  const hit = R.planRevisit({ offline: false, hasCache: true, ageMs: 900_000, staleMs: STALE, reachable: true });
  check('900_000ms + 可达 → 先用缓存', hit.source, 'cache');
  check('900_000ms + 可达 → 后台刷新', hit.backgroundRefresh, true);
  check('900_000ms + 可达 → reason', hit.reason, 'stale');

  const miss = R.planRevisit({ offline: false, hasCache: true, ageMs: 901_000, staleMs: STALE, reachable: false });
  check('过期 + 不可达 → 仍用缓存', miss.source, 'cache');
  check('过期 + 不可达 → 静默不刷新（被动场景不打扰）', miss.backgroundRefresh, false);
  check('过期 + 不可达 → reason', miss.reason, 'unreachable');
}

console.log('\n[5] planRevisit — 永不过期配置');
{
  const p = R.planRevisit({ offline: false, hasCache: true, ageMs: 999_999_999, staleMs: -1 });
  check('staleMs=-1 → 永远新鲜', p.reason, 'fresh');
  check('staleMs=-1 → 不刷新', p.backgroundRefresh, false);
}

console.log('\n[6] resolveRevisitPlan — 只在必要时探测网络');
async function resolveWith(input) {
  let probes = 0;
  const plan = await R.resolveRevisitPlan({
    isOffline: () => !!input.offline,
    hasCache: () => !!input.hasCache,
    ageMs: () => input.ageMs,
    staleMs: () => (input.staleMs === undefined ? STALE : input.staleMs),
    isReachable: async () => { probes += 1; return input.reachable !== false; },
  });
  return { plan, probes };
}

(async () => {
  {
    const { plan, probes } = await resolveWith({ offline: true, hasCache: true, ageMs: 9_999_999 });
    check('离线 → 零探测', probes, 0);
    check('离线 → 用缓存', plan.source, 'cache');
  }
  {
    const { probes } = await resolveWith({ offline: false, hasCache: false });
    check('无缓存 → 零探测（直接走网络）', probes, 0);
  }
  {
    const { plan, probes } = await resolveWith({ offline: false, hasCache: true, ageMs: 1000 });
    check('新鲜 → 零探测', probes, 0);
    check('新鲜 → 用缓存', plan.source, 'cache');
  }
  {
    const { plan, probes } = await resolveWith({ offline: false, hasCache: true, ageMs: 900_001, reachable: true });
    check('过期 → 探测一次', probes, 1);
    check('过期 + 可达 → 后台刷新', plan.backgroundRefresh, true);
  }
  {
    const { plan, probes } = await resolveWith({ offline: false, hasCache: true, ageMs: 900_001, reachable: false });
    check('过期 → 探测一次', probes, 1);
    check('过期 + 不可达 → 静默降级', plan.backgroundRefresh, false);
    check('过期 + 不可达 → reason', plan.reason, 'unreachable');
  }
  {
    const { probes } = await resolveWith({ offline: false, hasCache: true, ageMs: 999_999_999, staleMs: -1 });
    check('永不过期 → 零探测', probes, 0);
  }

  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
