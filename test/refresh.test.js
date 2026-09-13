// 刷新执行器（cache/refresher.ts）— 全部依赖注入，无需 vscode 桩
// 运行：node test/refresh.test.js
const { makeChecker, sleep } = require('./helpers/stub');
const { ProblemRefresher } = require('../out/cache/refresher.js');

const { check, ok, done } = makeChecker();

const CONTEST_HTML = '<html><h3>校级赛</h3><table id="problemset"></table></html>';

/** 造一个可编程的假环境 */
function makeEnv(opts = {}) {
  const log = [];
  const saved = { contest: [], problems: [], status: [] };
  const failPids = new Set(opts.failPids || []);
  let concurrent = 0;
  let peakConcurrent = 0;

  const deps = {
    fetchContestHtml: async () => {
      if (opts.contestFails) { throw new Error('比赛页 500'); }
      return CONTEST_HTML;
    },
    fetchProblemHtml: async (pid) => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await sleep(5);
      concurrent -= 1;
      if (failPids.has(pid)) { throw new Error(`题目 ${pid} 超时`); }
      return `<html>page-${pid}</html>`;
    },
    fetchStatusHtml: async () => {
      if (opts.statusFails) { throw new Error('状态页 500'); }
      return '<html>status</html>';
    },
    saveContestHtml: async (html) => { saved.contest.push(html); },
    saveProblemHtml: async (pid, html) => { saved.problems.push([pid, html]); },
    saveStatusHtml: async (html) => { saved.status.push(html); },
    listPids: () => (opts.pids || ['0', '1', '2']),
    toError: (e) => (e && e.message) || String(e),
    log: (m) => log.push(m),
  };

  return { deps, saved, log, stats: () => ({ peakConcurrent }) };
}

(async () => {
  console.log('[1] refreshOne — 单题强制刷新');
  {
    const env = makeEnv();
    const r = new ProblemRefresher(env.deps);
    const res = await r.refreshOne('0');
    check('成功', res.ok, true);
    check('返回 pid', res.pid, '0');
    check('已落盘', env.saved.problems, [['0', '<html>page-0</html>']]);
  }
  {
    const env = makeEnv({ failPids: ['1'] });
    const r = new ProblemRefresher(env.deps);
    const res = await r.refreshOne('1');
    check('失败时 ok=false', res.ok, false);
    check('失败时带错误文案（C10：显式动作必须可见）', res.error, '题目 1 超时');
    check('失败不抛异常', typeof res.pid, 'string');
  }

  console.log('\n[2] refreshAll — 全成功');
  {
    const env = makeEnv({ pids: ['0', '1', '2'] });
    const r = new ProblemRefresher(env.deps);
    const progress = [];
    const s = await r.refreshAll({ onProgress: (p) => progress.push(`${p.index}/${p.total}@${p.pid}`) });
    check('total', s.total, 3);
    check('ok', s.ok, 3);
    check('failed 为空', s.failed, []);
    check('cancelled', s.cancelled, false);
    check('contestListOk', s.contestListOk, true);
    check('statusOk', s.statusOk, true);
    check('进度顺序与 i/N', progress, ['1/3@0', '2/3@1', '3/3@2']);
    check('落盘顺序 = pid 顺序', env.saved.problems.map(p => p[0]), ['0', '1', '2']);
    check('状态最后落盘', env.saved.status.length, 1);
  }

  console.log('\n[3] refreshAll — 串行（峰值并发为 1）');
  {
    const env = makeEnv({ pids: ['0', '1', '2', '3', '4'] });
    const r = new ProblemRefresher(env.deps);
    await r.refreshAll();
    check('峰值并发度', env.stats().peakConcurrent, 1);
  }

  console.log('\n[4] refreshAll — 题目列表失败即中止');
  {
    const env = makeEnv({ contestFails: true });
    const r = new ProblemRefresher(env.deps);
    const s = await r.refreshAll();
    check('contestListOk=false', s.contestListOk, false);
    check('total=0', s.total, 0);
    check('未刷任何题', env.saved.problems.length, 0);
    check('未刷状态', env.saved.status.length, 0);
  }

  console.log('\n[5] refreshAll — 部分题目失败（汇总但不中断）');
  {
    const env = makeEnv({ pids: ['0', '1', '2', '3'], failPids: ['1', '3'] });
    const r = new ProblemRefresher(env.deps);
    const s = await r.refreshAll();
    check('total', s.total, 4);
    check('ok', s.ok, 2);
    check('失败题号', s.failed.map(f => f.pid), ['1', '3']);
    check('失败原因被记录', s.failed[0].error, '题目 1 超时');
    check('状态仍继续刷新', s.statusOk, true);
    check('未取消', s.cancelled, false);
  }

  console.log('\n[6] refreshAll — 中途取消（已完成保留，不回滚）');
  {
    const env = makeEnv({ pids: ['0', '1', '2', '3', '4'] });
    const r = new ProblemRefresher(env.deps);
    const token = { isCancellationRequested: false };
    const seen = [];
    const s = await r.refreshAll({
      token,
      onProgress: (p) => { seen.push(p.pid); if (p.index === 2) { token.isCancellationRequested = true; } },
    });
    check('cancelled=true', s.cancelled, true);
    check('已完成的保留（2 题）', s.ok, 2);
    check('已落盘不删除', env.saved.problems.map(p => p[0]), ['0', '1']);
    check('取消后不再继续', seen, ['0', '1']);
    check('取消后状态也不刷', s.statusOk, false);
  }

  console.log('\n[7] refreshAll — 状态页失败不影响题目刷新结论');
  {
    const env = makeEnv({ pids: ['0', '1'], statusFails: true });
    const r = new ProblemRefresher(env.deps);
    const s = await r.refreshAll();
    check('题目全成功', s.ok, 2);
    check('statusOk=false', s.statusOk, false);
    check('contestListOk 仍为 true', s.contestListOk, true);
  }

  console.log('\n[8] refreshAll — 空比赛（0 道题）');
  {
    const env = makeEnv({ pids: [] });
    const r = new ProblemRefresher(env.deps);
    const s = await r.refreshAll();
    check('total=0', s.total, 0);
    check('ok=0', s.ok, 0);
    check('未报失败', s.failed, []);
    ok('仍获取状态页', s.statusOk === true);
  }

  process.exit(done() ? 0 : 1);
})().catch(e => { console.error('❌ 异常:', e); process.exit(2); });
