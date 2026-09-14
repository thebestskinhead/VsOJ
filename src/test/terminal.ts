/**
 * 【测试 · 终端桥】
 *
 * 把子进程接到 VS Code 的伪终端上。
 *
 * 为什么不让子进程直接继承一个终端：本项目要求**三平台行为一致**。
 * 走 shell 就得分 cmd/bash（引号、重定向、路径分隔符全不一样）；
 * 走真正的 pty 就得引 node-pty 这类原生模块（要编译，插件分发受不了）。
 * 所以这里用 `child_process` 的 pipe，自己把字节写进伪终端 —— 零原生依赖。
 *
 * 代价是程序看到的 stdout 不是 tty（缓冲策略可能不同）。对刷题程序无影响：
 * 它们就是 `cin/cout` 那套，且我们的用例本来就是文件重定向喂进去的。
 */

import * as fs from 'fs';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

/**
 * 伪终端要求换行是 `CRLF`。
 *
 * 只写 `\n` 的话光标不回到行首，输出会变成阶梯状（`a\nb` 渲染成 `a\n   b`）——
 * 这是自己接伪终端时最常见的坑，而且在 Linux 上才看得出来（Windows 的终端更宽容）。
 */
export function toTerminalText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/**
 * 流式转换器：处理「`\r` 与 `\n` 落在两个数据块里」的情况。
 *
 * 直接对每块做 `\r?\n → \r\n` 会把跨块的 CRLF 变成 `\r\r\n`（多一个回车），
 * 表现为偶发的空行 —— 难复现、难查，所以用一个字节的挂起状态解决。
 */
export function makeTerminalWriter(write: (s: string) => void): (data: Buffer | string) => void {
  let pendingCR = false;
  return (data) => {
    let s = typeof data === 'string' ? data : data.toString('utf8');
    if (pendingCR) { s = `\r${s}`; pendingCR = false; }
    if (s.endsWith('\r')) { pendingCR = true; s = s.slice(0, -1); }
    write(s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  };
}

export interface RunningChild {
  /** 子进程退出码（-1 = 起不来） */
  done: Promise<number>;
  kill(): void;
}

/**
 * 起一个子进程，stdout/stderr 实时写进 sink，stdin 直接接样例文件。
 *
 * stdin 用 `fs.open` 的 fd 而不是管道：不需要在 JS 侧搬运输入，
 * 程序读到 EOF 自然结束 —— 而且这正是「不支持手动输入」的实现方式（用户决策）。
 */
export function spawnToTerminal(opts: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 用例输入文件；不给就是空 stdin */
  inputFile?: string;
  /** 只接收**已转成终端文本**的内容 */
  sink: (terminalText: string) => void;
  spawnImpl?: typeof spawn;
}): RunningChild {
  const spawnFn = opts.spawnImpl ?? spawn;
  const [cmd, ...args] = opts.argv;

  let inFd: number | 'ignore' = 'ignore';
  if (opts.inputFile) {
    try {
      inFd = fs.openSync(opts.inputFile, 'r');
    } catch (e: any) {
      opts.sink(toTerminalText(`打不开输入文件 ${opts.inputFile}：${e.message}\n`));
    }
  }

  const child = spawnFn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [inFd as any, 'pipe', 'pipe'],
    windowsHide: true,
  });

  const write = makeTerminalWriter(opts.sink);
  child.stdout?.on('data', (b: Buffer) => write(b));
  child.stderr?.on('data', (b: Buffer) => write(b));

  const closeFd = () => {
    if (typeof inFd === 'number') {
      try { fs.closeSync(inFd); } catch { /* 已关 */ }
      inFd = 'ignore';
    }
  };

  const done = new Promise<number>((resolve) => {
    child.on('error', (e: Error) => {
      opts.sink(toTerminalText(`无法启动：${e.message}\n`));
      closeFd();
      resolve(-1);
    });
    child.on('close', (code: number | null) => {
      closeFd();
      resolve(code ?? -1);
    });
  });

  return {
    done,
    kill: () => { try { child.kill(); } catch { /* 已退出 */ } },
  };
}

/** 任务在终端里的运行环境（写内容、交出子进程以便取消时能杀） */
export interface TerminalContext {
  /** 写一段**逻辑文本**（内部负责 CRLF 转换） */
  write(text: string): void;
  /** 写一段**已经是终端文本**的内容（流式输出用，转换器已经处理过） */
  writeTerminal(terminalText: string): void;
  /** 把正在跑的子进程交给终端：用户关终端时会被杀掉，不留野进程 */
  attach(child: RunningChild): void;
}

/**
 * 任务用的伪终端。
 *
 * VS Code 的 `CustomExecution` 必须配一个 Pseudoterminal —— 这正是「不经过 shell」
 * 的代价，也是收益：命令怎么拼、cwd 是什么、env 注入什么，全由我们的工具链层决定，
 * 三平台完全一致（对照 `ShellExecution`：那才是把平台差异摊给用户）。
 */
export class ProcessTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  private closed = false;
  private running?: RunningChild;

  public readonly onDidWrite = this.writeEmitter.event;
  public readonly onDidClose = this.closeEmitter.event;

  constructor(private readonly run: (ctx: TerminalContext) => Promise<number>) {}

  open(): void {
    const ctx: TerminalContext = {
      write: (text) => this.emit(toTerminalText(text)),
      writeTerminal: (text) => this.emit(text),
      attach: (child) => { this.running = child; },
    };
    void this.run(ctx)
      .then((code) => this.finish(code))
      .catch((e: any) => {
        ctx.write(`\n任务异常：${e?.message ?? e}\n`);
        this.finish(1);
      });
  }

  close(): void {
    this.closed = true;
    this.running?.kill();
  }

  /** 有意留空：输入一律来自样例文件，不支持在终端里敲（用户决策） */
  handleInput(): void { /* no-op */ }

  private emit(text: string): void {
    if (!this.closed) { this.writeEmitter.fire(text); }
  }

  private finish(code: number): void {
    this.closed = true;
    this.closeEmitter.fire(code);
  }
}
