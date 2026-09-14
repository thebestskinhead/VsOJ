/**
 * 【本地测试 · 看门狗】
 *
 * 用户对运行错误的处理原则是「**不进行任何处理，只判断结果的正确性**」，
 * 唯一的例外是：死循环 / 内存泄漏这类会拖垮机器的情况，用一个**比较宽松的看门狗直接 kill**。
 * 本模块就是那道看门狗。
 *
 * ## 三闸（决策 D8）
 *
 * | 闸 | 默认 | 为什么需要 |
 * |---|---|---|
 * | 时间 | 10 s | 死循环；宽松到足够跑完暴力算法 |
 * | 输出体积 | 64 MB | 死循环里 `while(1) cout<<x;` 会把磁盘写爆 |
 * | 内存驻留 | 2 GB | 内存泄漏 / 疯狂 new |
 *
 * 任一闸触发 → **kill 整个进程树**，并把触发原因如实回报（不改变判定逻辑，只是运行事实）。
 *
 * ## 两个实现要点
 *
 * 1. **stdout 直接落到文件描述符**，不走管道：避免 Windows 管道缓冲与大输出死锁，
 *    而且被砍掉时文件里已经有部分输出，能直接展示「跑到哪了」。
 * 2. 内存那一闸是**看门狗，不是限额**：轮询有间隔，不承诺精确（已在 PLAN_S6 §10 声明代价）。
 *
 * 本模块不依赖 VS Code；spawn / 时间 / 探测函数都可注入，便于单测。
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';

export type WatchdogKind = 'time' | 'size' | 'memory';

export interface WatchdogLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxMemoryBytes: number;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 程序的 stdout 落这里（不传则丢弃） */
  outFile?: string;
  /** 程序的 stderr 落这里（不传则丢弃） */
  errFile?: string;
  /** 从这里读输入（不传则给空输入） */
  inFile?: string;
  limits: WatchdogLimits;
  sizePollMs?: number;
  memoryPollMs?: number;
  // ---- 注入点（测试用） ----
  spawnImpl?: typeof spawn;
  killImpl?: (pid: number) => void;
  memoryProbe?: (pid: number) => number | undefined;
  now?: () => number;
}

export interface RunProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** 触发的那道闸；null = 正常结束 */
  watchdog: WatchdogKind | null;
  durationMs: number;
  /** 被砍的原因（人读文案），正常结束时为 undefined */
  killReason?: string;
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * kill **整个进程树**（契约 C8）。
 *
 * 只用 `child.kill()` 会漏掉孙子进程：用户程序里 `system("...")` 或被 shell 拉起来的子进程
 * 会继续占着 CPU，用户看到的是「测试结束了但电脑还在转」。
 */
export function killTree(pid: number): void {
  if (!pid || pid <= 0) { return; }
  if (IS_WINDOWS) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* 进程可能已退出 */ }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
}

/**
 * 默认内存探测：返回进程驻留内存（字节），取不到返回 undefined。
 *
 * Windows 用 `tasklist`（比 wmic 存在性更广），POSIX 读 `/proc/<pid>/statm`。
 */
export function defaultMemoryProbe(pid: number): number | undefined {
  if (!pid) { return undefined; }
  if (IS_WINDOWS) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0 || !r.stdout) { return undefined; }
    // 形如："main.exe","12345","Console","1","1,234 K"
    const m = r.stdout.match(/,\s*"([\d.,]+)\s*K"\s*$/m);
    if (!m) { return undefined; }
    const kb = Number(m[1].replace(/[.,]/g, ''));
    return isFinite(kb) ? kb * 1024 : undefined;
  }
  try {
    const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/);
    const pages = Number(statm[1]);
    return isFinite(pages) ? pages * 4096 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 跑一个进程，带三闸看门狗。
 *
 * 输入输出都以**文件**接入（用户的描述就是「传入输入输出文件地址」）：
 * `stdio = [inFile?, outFile?, errFile?]`，程序对 stdout 的写入直接落到 outFile。
 */
export function runProcess(opts: RunProcessOptions): Promise<RunProcessOutcome> {
  const now = opts.now ?? (() => Date.now());
  const spawnFn = opts.spawnImpl ?? spawn;
  const killFn = opts.killImpl ?? killTree;
  const probe = opts.memoryProbe ?? defaultMemoryProbe;
  const sizePollMs = opts.sizePollMs ?? 500;
  const memoryPollMs = opts.memoryPollMs ?? 1000;

  const started = now();
  const opened: number[] = [];
  const openFor = (file: string | undefined, flags: string): number | 'ignore' => {
    if (!file) { return 'ignore'; }
    const fd = fs.openSync(file, flags);
    opened.push(fd);
    return fd;
  };

  let inFd: number | 'ignore' = 'ignore';
  let outFd: number | 'ignore' = 'ignore';
  let errFd: number | 'ignore' = 'ignore';
  try {
    inFd = openFor(opts.inFile, 'r');
    outFd = openFor(opts.outFile, 'w');
    errFd = openFor(opts.errFile, 'w');
  } catch (e: any) {
    for (const fd of opened) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return Promise.resolve({
      exitCode: null, signal: null, watchdog: null,
      durationMs: now() - started,
      killReason: `无法打开输入/输出文件：${e.message}`,
    });
  }

  return new Promise<RunProcessOutcome>((resolve) => {
    let settled = false;
    let watchdog: WatchdogKind | null = null;
    let killReason: string | undefined;
    let timeTimer: NodeJS.Timeout | undefined;
    let sizeTimer: NodeJS.Timeout | undefined;
    let memTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeTimer) { clearTimeout(timeTimer); }
      if (sizeTimer) { clearInterval(sizeTimer); }
      if (memTimer) { clearInterval(memTimer); }
      for (const fd of opened) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [inFd as any, outFd as any, errFd as any],
        windowsHide: true,
        // POSIX 上自成进程组，才能整组 kill；Windows 靠 taskkill /T
        detached: !IS_WINDOWS,
      });
    } catch (e: any) {
      cleanup();
      resolve({
        exitCode: null, signal: null, watchdog: null,
        durationMs: now() - started,
        killReason: `无法启动程序：${e.message}`,
      });
      return;
    }

    const pid = child.pid ?? 0;

    const trip = (kind: WatchdogKind, reason: string) => {
      if (watchdog) { return; }
      watchdog = kind;
      killReason = reason;
      killFn(pid);
    };

    timeTimer = setTimeout(() => {
      trip('time', `运行超过 ${opts.limits.timeoutMs} ms 仍未结束`);
    }, opts.limits.timeoutMs);
    if (timeTimer.unref) { timeTimer.unref(); }

    sizeTimer = setInterval(() => {
      if (!opts.outFile) { return; }
      try {
        const size = fs.statSync(opts.outFile).size;
        if (size > opts.limits.maxOutputBytes) {
          trip('size', `输出超过 ${opts.limits.maxOutputBytes} 字节（疑似死循环狂打印）`);
        }
      } catch { /* 文件还没建/已被杀 */ }
    }, sizePollMs);
    if (sizeTimer.unref) { sizeTimer.unref(); }

    memTimer = setInterval(() => {
      const used = probe(pid);
      if (used !== undefined && used > opts.limits.maxMemoryBytes) {
        trip('memory', `内存占用超过 ${opts.limits.maxMemoryBytes} 字节（疑似内存泄漏）`);
      }
    }, memoryPollMs);
    if (memTimer.unref) { memTimer.unref(); }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) { return; }
      settled = true;
      cleanup();
      resolve({
        exitCode, signal, watchdog,
        durationMs: now() - started,
        killReason,
      });
    };

    child.on('error', (e: any) => {
      if (!killReason) { killReason = `启动失败：${e.message}`; }
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** 读取错误输出尾部（给报告用；不让 64MB 的 stderr 直接进报告） */
export function readErrorTail(errFile: string, maxBytes = 2000): string {
  try {
    const buf = fs.readFileSync(errFile);
    if (buf.length <= maxBytes) { return buf.toString('utf8'); }
    return `…（前面省略 ${buf.length - maxBytes} 字节）\n${buf.subarray(buf.length - maxBytes).toString('utf8')}`;
  } catch {
    return '';
  }
}
