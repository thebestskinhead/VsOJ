/**
 * 【测试 · 自定义任务】
 *
 * 四种任务：编译 / 强制重编译 / 本地测试 / 跑一下。
 *
 * 为什么是**自定义 Task 类型**而不是往用户的 tasks.json 写 shell 命令（用户决策）：
 * - shell 任务必须写死命令与路径，而那是**平台相关**的（Windows 要 `.exe`、路径分隔符不同），
 *   一个要发布的插件把「我这台机器的命令」写进用户文件里，换台机器就是垃圾；
 * - 自定义任务的命令在**运行时**由工具链层解析（裸名靠 PATH、绝对路径也行），
 *   于是 Windows / Linux / macOS 同一份定义通吃；
 * - 顺带的好处：用户自己的 `launch.json` 里写 `"preLaunchTask": "oj: 编译当前题目"`
 *   就能把它接进**任何**调试器（cppdbg / CodeLLDB / 别的），我们不必绑任何调试器。
 *
 * 本文件里 `runOjTask` 是纯执行体（只依赖注入 + 一个 TerminalContext），
 * 与 VS Code 的 Task/Provider 解耦 —— 所以它能在 Node 里端到端测（真编译、真运行、真输出）。
 */

import * as vscode from 'vscode';
import { CacheStore } from '../cache/store';
import { buildTestDeps, pickSampleInput } from './wiring';
import { LocalTestRunner, RunnerDeps } from './runner';
import { ProcessTerminal, spawnToTerminal, TerminalContext } from './terminal';

export type OjTaskKind = 'compile' | 'compileForce' | 'test' | 'run';

export interface OjTaskDefinition extends vscode.TaskDefinition {
  type: 'oj';
  task: OjTaskKind;
  /** `run` 用：喂第几组样例 */
  sample?: number;
}

export interface ProblemTarget { cid: string; pid: string; title: string }

export interface OjTaskDeps {
  store: CacheStore;
  workspaceRoot(): string;
  /** 当前该对哪道题动手（题目条目右键 / 已打开的题面） */
  resolveTarget(): ProblemTarget | undefined;
  /** 列出当前题目的样例序号（同步，只读目录） */
  listSamples(target: ProblemTarget): number[];
  log?(msg: string): void;
}

const BASE_LABELS: Record<OjTaskKind, string> = {
  compile: 'oj: 编译当前题目',
  compileForce: 'oj: 强制重新编译',
  test: 'oj: 本地测试',
  run: 'oj: 跑一下',
};

/** 任务显示名（`launch.json` 的 `preLaunchTask` 就是按这个名字匹配的） */
export function taskLabel(def: { task: OjTaskKind; sample?: number }): string {
  return def.task === 'run' && def.sample ? `oj: 跑一下（样例 ${def.sample}）` : BASE_LABELS[def.task];
}

function describeTarget(t: ProblemTarget): string {
  return t.title ? `${t.cid}/${t.pid} · ${t.title}` : `${t.cid}/${t.pid}`;
}

/**
 * 任务执行体：编译 / 测试 / 跑一下。
 *
 * 返回值就是任务退出码（`0` 成功）。**判定结果会反映到退出码**（有样例不通过 → 1），
 * 这样脚本与 CI 能识别；而「跑一下」只要跑完就算成功，程序自己崩了不改任务退出码
 * （那是运行事实，终端里已经写着）。
 */
export async function runOjTask(
  def: { task: OjTaskKind; sample?: number },
  deps: OjTaskDeps,
  ctx: TerminalContext,
): Promise<number> {
  const target = deps.resolveTarget();
  if (!target) {
    ctx.write('找不到要操作的题目：先在侧边栏点开一道题（或先进入一场比赛），再运行这个任务。\n');
    return 1;
  }
  ctx.write(`题目：${describeTarget(target)}\n`);

  const built = await buildTestDeps({
    store: deps.store,
    cid: target.cid,
    pid: target.pid,
    workspaceRoot: deps.workspaceRoot(),
    title: target.title,
    // 「强制重新编译」无视配置；其余按 oj.test.reuseBuild（默认不复用）
    forceRebuild: def.task === 'compileForce' ? true : undefined,
    log: deps.log,
  });
  if (!built.ok) {
    ctx.write(`\n${built.error}\n`);
    return 1;
  }
  for (const n of built.notes) { ctx.write(`提示：${n}\n`); }

  ctx.write(`工具链：${built.def.label}（${built.def.id}）\n`);

  const runner = new LocalTestRunner(built.deps);
  if (def.task === 'compile' || def.task === 'compileForce') {
    return compileOnlyTask(runner, ctx);
  }
  if (def.task === 'test') {
    return testTask(runner, built.deps, ctx);
  }
  return runTask(runner, built.deps, ctx, def.sample ?? 1);
}

/** 编译：只产出可运行文件，不跑样例 */
async function compileOnlyTask(runner: LocalTestRunner, ctx: TerminalContext): Promise<number> {
  const t0 = Date.now();
  const r = await runner.prepareOnly();
  const elapsed = Date.now() - t0;

  if (r.build.command) { ctx.write(`\n$ ${r.build.command}\n`); }
  if (r.build.output) { ctx.write(`${r.build.output}\n`); }
  if (!r.ok) {
    ctx.write(`\n编译失败（${elapsed} ms）。\n`);
    return 1;
  }
  ctx.write(`\n编译成功：${r.build.runnable}\n`);
  ctx.write(`${r.build.reused ? '复用上次产物（源文件未变）' : `用时 ${elapsed} ms`}\n`);
  return 0;
}

/** 本地测试：跑样例 + 逐例判定 */
async function testTask(
  runner: LocalTestRunner,
  deps: RunnerDeps,
  ctx: TerminalContext,
): Promise<number> {
  const t0 = Date.now();
  const r = await runner.run();
  const elapsed = Date.now() - t0;

  if (r.build.command) { ctx.write(`\n$ ${r.build.command}\n`); }
  if (!r.build.ok) {
    if (r.build.output) { ctx.write(`${r.build.output}\n`); }
    ctx.write(`\n编译失败（${elapsed} ms）。\n`);
    return 1;
  }
  if (r.reason === 'no-cases') {
    ctx.write('\n这道题还没有样例：先「初始化本题」抓站点样例，或自己放 samples/1.in、1.out。\n');
    return 1;
  }

  ctx.write(`\n共 ${r.summary.total} 组：通过 ${r.summary.passed}，不通过 ${r.summary.failed}`
    + `${r.summary.skipped ? `，跳过 ${r.summary.skipped}` : ''}\n\n`);

  for (const c of r.cases) {
    const flag = c.verdict === 'pass' ? '通过' : '不通过';
    ctx.write(`用例 ${c.index}  ${flag}  ${c.runtime.durationMs} ms`);
    ctx.write(c.diff ? `\n          ${c.diff.description}\n` : '\n');
  }
  for (const s of r.skipped) {
    ctx.write(`用例 ${s.index}  跳过  ${s.reason}\n`);
  }

  ctx.write(`\n用时 ${elapsed} ms`);
  if (r.reportFile) { ctx.write(`；报告：${r.reportFile}`); }
  ctx.write('\n');

  return r.summary.failed === 0 ? 0 : 1;
}

/**
 * 跑一下：喂样例、实时输出、不判定。
 *
 * 这是本项目**自研的调试入口**：VS Code 自带的调试器（cppdbg）没法把样例文件接到 stdin
 * （启动流程由它自己发 `-exec-run`，launch.json 里根本没有 stdin 字段），
 * 而刷题时九成的「调试」就是「拿样例跑一遍看输出对不对」。
 */
async function runTask(
  runner: LocalTestRunner,
  deps: RunnerDeps,
  ctx: TerminalContext,
  sample: number,
): Promise<number> {
  const prep = await runner.prepareOnly();
  if (!prep.ok) {
    if (prep.build.command) { ctx.write(`\n$ ${prep.build.command}\n`); }
    ctx.write(`\n${prep.message}\n`);
    return 1;
  }

  const inputFile = pickSampleInput(deps, sample);
  if (!inputFile) {
    ctx.write('\n这道题还没有样例：先「初始化本题」抓站点样例，或自己放 samples/1.in。\n');
    return 1;
  }

  ctx.write(`\n$ ${prep.argv.join(' ')}\n`);
  ctx.write(`输入来自 ${inputFile}（不支持手动输入）\n\n`);

  const t0 = Date.now();
  const child = spawnToTerminal({
    argv: prep.argv,
    cwd: prep.cwd,
    env: prep.env,
    inputFile,
    sink: ctx.writeTerminal,
  });
  ctx.attach(child);

  const code = await child.done;
  ctx.write(`\n[退出码 ${code}，用时 ${Date.now() - t0} ms]\n`);
  return 0;
}

/**
 * 注册 `oj` 类型的任务。
 *
 * `provideTasks` 是同步的（VS Code 的 API 如此），所以这里只做「列出来」；
 * 真正的定位与装配发生在任务**开始运行**时（`runOjTask`）——
 * 这样 `preLaunchTask` 引用固定名字时，跑的永远是你当时打开的那道题。
 */
export class OjTaskProvider implements vscode.TaskProvider {
  private readonly emitter = new vscode.EventEmitter<void>();

  /** 当前题目/样例变化时通知 VS Code 重新拉取任务列表 */
  public readonly onDidChangeTasks = this.emitter.event;

  constructor(private readonly deps: OjTaskDeps) {}

  refresh(): void { this.emitter.fire(); }

  provideTasks(): vscode.Task[] {
    const tasks: vscode.Task[] = [
      this.make({ type: 'oj', task: 'compile' }),
      this.make({ type: 'oj', task: 'test' }),
      this.make({ type: 'oj', task: 'compileForce' }),
    ];
    const target = this.deps.resolveTarget();
    if (target) {
      for (const idx of this.deps.listSamples(target)) {
        tasks.push(this.make({ type: 'oj', task: 'run', sample: idx }));
      }
    }
    return tasks;
  }

  /** 用户手写在 tasks.json 里的 `{"type":"oj","task":"test"}` 走这里补全 */
  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as OjTaskDefinition;
    if (!def || def.type !== 'oj' || !def.task) { return undefined; }
    return this.make({ type: 'oj', task: def.task, ...(def.sample ? { sample: def.sample } : {}) });
  }

  private make(def: OjTaskDefinition): vscode.Task {
    return new vscode.Task(
      def,
      vscode.TaskScope.Workspace,
      taskLabel(def),
      'oj',
      // CustomExecution 要求 Thenable<Pseudoterminal>；这里同步构造、立即 resolve
      new vscode.CustomExecution(async () => new ProcessTerminal((ctx) => runOjTask(def, this.deps, ctx))),
    );
  }
}

/** 任务注册句柄：`refresh()` 让「跑一下（样例 N）」跟着当前题目更新 */
export interface OjTasksHandle extends vscode.Disposable {
  refresh(): void;
}

/** 供扩展启动时注册（集中在一处，避免 extension.ts 里再铺一层细节） */
export function registerOjTasks(deps: OjTaskDeps): OjTasksHandle {
  const provider = new OjTaskProvider(deps);
  const sub = vscode.tasks.registerTaskProvider('oj', provider);
  return {
    dispose: () => sub.dispose(),
    refresh: () => provider.refresh(),
  };
}
