/**
 * 【本地测试 · 工具链】
 *
 * 把「编译型 / 解释型」的差异关在这一层里。测试引擎（`runner.ts`）只认两个动作：
 *
 *   prepare(toolchain, source, temp)  → 编译型：编译出产物；解释型：**空操作**，返回源文件路径
 *   run(toolchain, runnable, in, out) → 把程序的 stdout 落到「输出文件」
 *
 * 于是引擎代码里不会出现任何语言特判：**新增一门语言 = 往这里加一份 `ToolchainDef`**（契约 C1）。
 *
 * ## 为什么需要它（不是过度设计）
 *
 * 1. 编译型（C/C++/Java）与解释型（Python）在「准备阶段」的行为根本不同，
 *    如果让引擎自己 `if (是 C++) 编译`，那每加一门语言就要改引擎。
 * 2. 用户机器上的工具链位置千差万别（实测本机 g++ 就不在 PATH 里），
 *    所以命令位置必须可配置、可多候选探测（见 `resolveCommands`）。
 * 3. MinGW 编译出的 exe 依赖 `libstdc++-6.dll`（实测不注入 PATH 直接起不来），
 *    所以子进程 PATH 必须从「命令所在目录」推导出来（见 `buildPathEnv`，决策 D4）。
 *
 * 本模块**不依赖 VS Code**，可以脱离运行时装进单测（见 `test/toolchain.test.js`）。
 */

import * as fs from 'fs';
import * as nodePath from 'path';

export type ToolchainKind = 'compiled' | 'interpreted';

/** 看门狗默认阈值（决策 D8；用户要求「比较宽松」） */
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

/** 工具链定义（`toolchains.json` 里的一个元素） */
export interface ToolchainDef {
  id: string;
  label: string;
  kind: ToolchainKind;
  /** 认领的源文件扩展名（小写，含点），如 `['.cpp', '.cc']` */
  extensions: string[];
  /**
   * 命令占位符 → 候选命令名（按序探测）。
   *
   * 内置默认给的是通用命令名（如 `g++`），用户在 `toolchains.json` 里把它换成
   * 绝对路径数组即可（如 `["D:\\usexxx\\gcc\\...\\bin\\g++.exe"]`）——
   * 这是实测必需的能力：本机 g++ 不在 PATH 里。
   */
  commands: Record<string, string[]>;
  /** 编译命令模板（编译型必填；占位符见 `expandTemplate`） */
  compile?: string;
  /** 运行命令模板（必填） */
  run: string;
  /** 显式覆盖的环境变量（最高优先级；`env.PATH` 会完全替换推导结果） */
  env?: Record<string, string>;
  /** 追加到推导结果前面的额外 PATH 目录 */
  pathPrepend?: string[];
  /** 覆盖全局看门狗阈值 */
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxMemoryBytes?: number;
  /**
   * 编译产物**必须落在 ASCII 安全路径**上（实测坑，见下）。
   *
   * 为什么需要这个能力位：本机实测 MinGW-w64 的 `ld` **无法在含中文的路径下创建产物**
   * （`cannot open output file ...\A-A+B问题\temp\main.exe: No such file or directory`，
   * 路径被按 GBK 解释成乱码）；而本项目布局里目录名含中文是常态
   * （`<cid>-<标题>` / `<全局题号>-<标题>`）。同一个源文件只要产物路径是纯 ASCII 就能编译成功，
   * 且产物**放在**中文路径下运行完全正常（Node/Bash 都验证过）——所以只有「写产物」这一步需要绕。
   *
   * 对照实测：javac 往中文目录写 `.class`、python 跑中文路径脚本都正常，
   * 所以这只是部分工具链的能力位，**不是引擎要特判的语言**（契约 C1）。
   */
  asciiSafeOutput?: boolean;
  /** 内置项：不可删除，只能覆盖 */
  builtin?: boolean;
}

/** 内置三套默认工具链（决策 D1：C/C++、Java、Python） */
export function builtinToolchains(): ToolchainDef[] {
  return [
    {
      id: 'cpp-g++',
      label: 'C++ (g++)',
      kind: 'compiled',
      extensions: ['.cpp', '.cc', '.cxx', '.c++'],
      commands: { gpp: ['g++'] },
      compile: '"{gpp}" -O2 -std=c++17 -o "{output}" "{source}"',
      run: '"{runnable}"',
      // MinGW 的 ld 写不出「含非 ASCII 的产物路径」（实测），引擎为此改走相对路径（见 runner.ts 的 relativeArg）
      asciiSafeOutput: true,
      builtin: true,
    },
    {
      id: 'c-gcc',
      label: 'C (gcc)',
      kind: 'compiled',
      extensions: ['.c'],
      commands: { gcc: ['gcc'] },
      compile: '"{gcc}" -O2 -std=c17 -o "{output}" "{source}"',
      run: '"{runnable}"',
      asciiSafeOutput: true,
      builtin: true,
    },
    {
      id: 'java',
      label: 'Java (javac/java)',
      kind: 'compiled',
      extensions: ['.java'],
      commands: { javac: ['javac'], java: ['java'] },
      compile: '"{javac}" -encoding UTF-8 -d "{dir}" "{source}"',
      // 类名必须与文件名一致，故用 {stem}（HUSTOJ 的 Java 提交约定类名为 Main）
      run: '"{java}" -cp "{dir}" {stem}',
      builtin: true,
    },
    {
      id: 'python',
      label: 'Python',
      kind: 'interpreted',
      extensions: ['.py'],
      commands: { python: ['python3', 'python', 'py'] },
      run: '"{python}" "{runnable}"',
      builtin: true,
    },
  ];
}

// ============================================================
// 命令查找
// ============================================================

const IS_WINDOWS = process.platform === 'win32';

/**
 * PATH 查找（等价于 `where` / `which`，自己实现以便注入桩做单测）。
 *
 * Windows 上按 `.exe → .cmd → .bat` 顺序试；调用方给的命令名如果自带扩展名，只按原名试。
 */
export function lookupCommand(
  name: string,
  dirs: string[],
  exists: (p: string) => boolean = defaultExists,
): string | undefined {
  const hasExt = /\.[a-z0-9]+$/i.test(name);
  const exts = IS_WINDOWS && !hasExt ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    if (!dir) { continue; }
    for (const ext of exts) {
      const candidate = nodePath.join(dir, name + ext);
      if (exists(candidate)) { return candidate; }
    }
  }
  return undefined;
}

function defaultExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** 判断是否为「带路径的命令」（绝对路径或含目录分隔符），这类不做 PATH 搜索 */
function looksLikePath(cmd: string): boolean {
  return nodePath.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\');
}

/** 命令解析结果 */
export interface ResolvedCommands {
  /** 占位符 → 解析出的绝对路径 */
  resolved: Record<string, string>;
  /** 找不到的占位符 */
  missing: string[];
  /** 探测过的全部位置（用于把失败原因说清楚，而不是只报「找不到 g++」） */
  tried: string[];
}

/**
 * 把「候选命令名」解析成绝对路径。
 *
 * 探测顺序：候选自身的绝对路径（若配置里直接写了路径）→ PATH → `searchDirs`（常见安装目录）。
 */
export function resolveCommands(
  def: ToolchainDef,
  opts: { pathDirs?: string[]; searchDirs?: string[]; exists?: (p: string) => boolean } = {},
): ResolvedCommands {
  const pathDirs = opts.pathDirs ?? (process.env.PATH || '').split(nodePath.delimiter).filter(Boolean);
  const searchDirs = opts.searchDirs ?? [];
  const exists = opts.exists ?? defaultExists;

  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  const tried: string[] = [];

  for (const [key, candidates] of Object.entries(def.commands || {})) {
    let hit: string | undefined;
    for (const cand of candidates) {
      if (!cand) { continue; }
      if (looksLikePath(cand)) {
        tried.push(cand);
        if (exists(cand)) { hit = nodePath.resolve(cand); break; }
        continue;
      }
      for (const dir of pathDirs) { tried.push(nodePath.join(dir, cand)); }
      hit = lookupCommand(cand, pathDirs, exists);
      if (hit) { break; }
      for (const dir of searchDirs) { tried.push(nodePath.join(dir, cand)); }
      hit = lookupCommand(cand, searchDirs, exists);
      if (hit) { break; }
    }
    if (hit) { resolved[key] = hit; } else { missing.push(key); }
  }

  return { resolved, missing, tried };
}

/**
 * 通用常见安装目录（仅通用位置，不放任何与本机个人环境相关的路径）。
 *
 * 用户自己的便携环境/多版本目录请写进 `oj.test.searchDirs` 或直接写命令绝对路径。
 */
export function commonSearchDirs(): string[] {
  if (IS_WINDOWS) {
    return [
      'C:\\MinGW\\bin',
      'C:\\mingw64\\bin',
      'C:\\msys64\\mingw64\\bin',
      'C:\\msys64\\ucrt64\\bin',
      'C:\\TDM-GCC-64\\bin',
      'C:\\Program Files\\Java\\bin',
      'C:\\Program Files\\Eclipse Adoptium\\bin',
    ];
  }
  return ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
}

// ============================================================
// 环境（决策 D4：自动推导 bin 目录 + 覆盖 PATH）
// ============================================================

/**
 * 构造子进程 PATH：**只含**「已解析命令所在目录」+ `pathPrepend`，**不继承**外层 PATH。
 *
 * 为什么必须这样：MinGW 的产物依赖同目录的 `libstdc++-6.dll`，实测不注入就起不来（exit 127）；
 * 而从「命令所在目录」推导是最不容易错的来源 —— 编译器在哪，它的运行时就一定在同目录。
 *
 * 若显式配置了 `env.PATH`，则完全采纳用户写的值（逃生口）。
 */
export function buildPathEnv(def: ToolchainDef, resolved: Record<string, string>): string {
  if (def.env && 'PATH' in def.env) { return def.env.PATH; }
  const dirs: string[] = [];
  const seen = new Set<string>();
  const push = (d: string) => {
    const key = IS_WINDOWS ? d.toLowerCase() : d;
    if (d && !seen.has(key)) { seen.add(key); dirs.push(d); }
  };
  for (const cmd of Object.values(resolved)) { push(nodePath.dirname(cmd)); }
  for (const d of def.pathPrepend ?? []) { push(d); }
  return dirs.join(nodePath.delimiter);
}

/** 构造子进程环境：其余变量继承，PATH 按 `buildPathEnv` 覆盖（契约 C5） */
export function buildEnv(
  def: ToolchainDef,
  resolved: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, ...(def.env ?? {}), PATH: buildPathEnv(def, resolved) };
}

// ============================================================
// 模板展开
// ============================================================

/**
 * 命令模板 → argv 数组。
 *
 * 支持 `"` 包住含空格的项（Windows 路径几乎必然含空格），**不做变量展开以外任何解释**：
 * 我们直接走 `spawn` 传 argv、不经 shell，所以 `* ? $ |` 都是普通字符，不存在注入面。
 *
 * 先替换占位符再切分；因此**含空格的占位符值必须在模板里用引号包住**。
 */
export function expandTemplate(template: string, vars: Record<string, string>): string[] {
  const replaced = template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined ? m : v;
  });

  const out: string[] = [];
  let buf = '';
  let quoted = false;
  for (const ch of replaced) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) { out.push(buf); }
  return out;
}

// ============================================================
// 工具链选择与校验
// ============================================================

/** 按源文件扩展名认领工具链（先声明者优先） */
export function matchToolchain(defs: ToolchainDef[], sourceFile: string): ToolchainDef | undefined {
  const ext = nodePath.extname(sourceFile).toLowerCase();
  return defs.find(d => (d.extensions || []).some(e => e.toLowerCase() === ext));
}

/** 单条定义校验结果 */
export interface DefProblem { id: string; problems: string[] }

/**
 * 校验并补全一条定义（来自 JSON 的都要过这里，防止脏配置把引擎带崩）。
 *
 * 容错原则：**坏条目只跳过自己**，不影响其它工具链 —— 一份写错的 json 不该让整个测试功能瘫痪。
 */
export function normalizeDef(raw: any): { def?: ToolchainDef; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') { return { problems: ['不是对象'] }; }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) { problems.push('缺少 id'); }

  const run = typeof raw.run === 'string' ? raw.run.trim() : '';
  if (!run) { problems.push('缺少 run 命令模板'); }

  const compile = typeof raw.compile === 'string' && raw.compile.trim() ? raw.compile.trim() : undefined;
  const kind: ToolchainKind = raw.kind === 'interpreted' || raw.kind === 'compiled'
    ? raw.kind
    : (compile ? 'compiled' : 'interpreted');
  if (kind === 'compiled' && !compile) { problems.push('kind=compiled 但缺少 compile 模板'); }

  const extensions = Array.isArray(raw.extensions)
    ? raw.extensions.filter((e: any) => typeof e === 'string' && e.trim())
      .map((e: string) => (e.trim().startsWith('.') ? e.trim().toLowerCase() : `.${e.trim().toLowerCase()}`))
    : [];
  if (!extensions.length) { problems.push('缺少 extensions（该工具链认领哪些源文件）'); }

  const commands: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw.commands ?? {})) {
    if (Array.isArray(v)) {
      const list = v.filter((x: any) => typeof x === 'string' && x.trim()).map((x: string) => x.trim());
      if (list.length) { commands[k] = list; }
    } else if (typeof v === 'string' && v.trim()) {
      commands[k] = [v.trim()];
    }
  }

  if (problems.length) { return { problems: problems.map(p => `${id || '(无 id)'}: ${p}`) }; }

  return {
    def: {
      id,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
      kind,
      extensions,
      commands,
      compile,
      run,
      env: sanitizeStringMap(raw.env),
      pathPrepend: Array.isArray(raw.pathPrepend)
        ? raw.pathPrepend.filter((x: any) => typeof x === 'string' && x.trim())
        : undefined,
      timeoutMs: positiveOrUndefined(raw.timeoutMs),
      maxOutputBytes: positiveOrUndefined(raw.maxOutputBytes),
      maxMemoryBytes: positiveOrUndefined(raw.maxMemoryBytes),
      asciiSafeOutput: raw.asciiSafeOutput === true ? true : undefined,
      builtin: false,
    },
    problems: [],
  };
}

function positiveOrUndefined(v: any): number | undefined {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : undefined;
}

function sanitizeStringMap(v: any): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') { return undefined; }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') { out[k] = val; }
  }
  return Object.keys(out).length ? out : undefined;
}

// ============================================================
// toolchains.json 读写（决策 D2/D3：工作区一份独立文件）
// ============================================================

/** `toolchains.json` 的磁盘结构 */
export interface ToolchainsFile {
  version: 1;
  toolchains: ToolchainDef[];
}

/** `toolchains.json` 的文件名（放在 `<工作区>/<oj.workspace.root>/` 下） */
export const TOOLCHAINS_FILE_NAME = 'toolchains.json';

/**
 * 合并内置与用户定义（决策 D1 + D2）。
 *
 * 规则：**同 id 用户覆盖内置**（保留 `builtin` 标记，编辑页据此禁止删除），
 * 其余用户定义追加在后。这样「改一下 g++ 路径」不需要抄整份定义。
 */
export function mergeToolchains(builtin: ToolchainDef[], user: ToolchainDef[]): ToolchainDef[] {
  const byId = new Map<string, ToolchainDef>();
  const order: string[] = [];
  for (const b of builtin) { byId.set(b.id, b); order.push(b.id); }
  for (const u of user) {
    const prev = byId.get(u.id);
    if (prev) {
      byId.set(u.id, { ...prev, ...u, builtin: prev.builtin === true });
    } else {
      // 新增项一律不是内置：`builtin` 只可能由代码里的内置定义置真，JSON 改不动它
      byId.set(u.id, { ...u, builtin: false });
      order.push(u.id);
    }
  }
  return order.map(id => byId.get(id)!);
}

/**
 * 把一份定义摊平回「原始形状」（与 {@link serializeToolchains} 的字段集一致）。
 *
 * 用途：做**部分覆盖**的补全基准 —— 用户只写 `{id:'cpp-g++', commands:{...}}` 时，
 * 需要拿内置定义的原始形状垫底才能通过 `normalizeDef` 的必填校验。
 */
export function toolchainRawShape(d: ToolchainDef): any {
  return {
    id: d.id,
    label: d.label,
    kind: d.kind,
    extensions: d.extensions,
    commands: d.commands,
    ...(d.compile ? { compile: d.compile } : {}),
    run: d.run,
    ...(d.env ? { env: d.env } : {}),
    ...(d.pathPrepend ? { pathPrepend: d.pathPrepend } : {}),
    ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
    ...(d.maxOutputBytes ? { maxOutputBytes: d.maxOutputBytes } : {}),
    ...(d.maxMemoryBytes ? { maxMemoryBytes: d.maxMemoryBytes } : {}),
    ...(d.asciiSafeOutput ? { asciiSafeOutput: true } : {}),
  };
}

/**
 * 覆盖合并：`patch` 里有值就用 `patch`，否则沿用 `base`。
 *
 * `commands` **按命令名逐个合并**而不是整体替换 —— 否则覆盖 `java` 会把 `javac` 弄丢。
 * 显式写 `undefined` 视为「不改」（JSON 里也写不出 undefined，这是为了防 JS 侧误传）。
 */
export function mergeRawDef(base: any, patch: any): any {
  const out: any = { ...base, ...patch };
  if (base?.commands || patch?.commands) {
    out.commands = { ...(base?.commands ?? {}), ...(patch?.commands ?? {}) };
  }
  for (const k of Object.keys(base ?? {})) {
    if (out[k] === undefined) { out[k] = base[k]; }
  }
  return out;
}

/**
 * 用户这份覆盖**实际动了哪些字段**（供编辑页/写配置时汇报，避免「改了但没说清」）。
 *
 * `commands` 会细到命令名（`commands.gpp`），因为「只换 g++ 路径」正是最常见的一种覆盖。
 * 非内置 `id` 返回它写了的所有字段。
 */
export function overriddenFields(raw: any, builtin: ToolchainDef[]): string[] {
  if (!raw || typeof raw !== 'object') { return []; }
  const base = builtin.find(b => b.id === raw.id);
  if (!base) { return Object.keys(raw).filter(k => raw[k] !== undefined); }

  const shape: any = toolchainRawShape(base);
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) { continue; }
    if (k === 'commands') {
      const names = Object.keys(v as any).filter(
        (c) => JSON.stringify((v as any)[c]) !== JSON.stringify(shape.commands?.[c]),
      );
      if (names.length) { out.push(...names.map((c) => `commands.${c}`)); }
      continue;
    }
    if (JSON.stringify(v) !== JSON.stringify(shape[k])) { out.push(k); }
  }
  return out;
}

/** 读出文件里的**原始条目**（不校验、不补全），供写配置时原样保留用户已有的其它定义 */
export function parseToolchainsRaw(text: string): { raw: any[]; problems: string[] } {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    return { raw: [], problems: [`JSON 解析失败：${e.message}`] };
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.toolchains;
  if (!Array.isArray(list)) { return { raw: [], problems: ['缺少 toolchains 数组'] }; }
  return { raw: list.filter((x: any) => x && typeof x === 'object'), problems: [] };
}

/**
 * 解析磁盘内容（坏 JSON / 坏条目都只记账，不抛）。
 *
 * **部分覆盖**：`id` 与内置相同但只写了一部分字段时，以内置定义为底补全后再校验。
 * 这样「只改一下 g++ 路径」的写法才真的能用 —— 否则 `normalizeDef` 的必填项
 * （`run` / `extensions`）会把这种最自然的写法判成坏条目丢掉。
 * 非内置 `id` 仍按完整定义校验（`extensions` 与 `run` 必填）。
 */
export function parseToolchains(
  text: string,
  builtin: ToolchainDef[] = builtinToolchains(),
): { defs: ToolchainDef[]; problems: string[] } {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    return { defs: [], problems: [`JSON 解析失败：${e.message}`] };
  }
  const list = Array.isArray(raw) ? raw : raw?.toolchains;
  if (!Array.isArray(list)) { return { defs: [], problems: ['缺少 toolchains 数组'] }; }

  const builtinById = new Map(builtin.map((b) => [b.id, b]));
  const defs: ToolchainDef[] = [];
  const problems: string[] = [];
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const base = builtinById.get(id);
    const candidate = base && item && typeof item === 'object'
      ? mergeRawDef(toolchainRawShape(base), item)
      : item;
    const { def, problems: p } = normalizeDef(candidate);
    if (def) { defs.push(def); }
    if (p.length) { problems.push(...p); }
  }
  return { defs, problems };
}

/** 序列化（给编辑页/手工编辑用；键顺序固定，便于 diff） */
export function serializeToolchains(defs: ToolchainDef[]): string {
  const clean = defs.map(d => ({
    id: d.id,
    label: d.label,
    kind: d.kind,
    extensions: d.extensions,
    commands: d.commands,
    ...(d.compile ? { compile: d.compile } : {}),
    run: d.run,
    ...(d.env ? { env: d.env } : {}),
    ...(d.pathPrepend ? { pathPrepend: d.pathPrepend } : {}),
    ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
    ...(d.maxOutputBytes ? { maxOutputBytes: d.maxOutputBytes } : {}),
    ...(d.maxMemoryBytes ? { maxMemoryBytes: d.maxMemoryBytes } : {}),
    ...(d.asciiSafeOutput ? { asciiSafeOutput: true } : {}),
  }));
  return `${JSON.stringify({ version: 1, toolchains: clean }, null, 2)}\n`;
}

/** `toolchains.json` 里允许出现的字段（顺序即写出顺序） */
export const TOOLCHAIN_FILE_FIELDS = [
  'id', 'label', 'kind', 'extensions', 'commands', 'compile', 'run',
  'env', 'pathPrepend', 'timeoutMs', 'maxOutputBytes', 'maxMemoryBytes', 'asciiSafeOutput',
] as const;

/**
 * 序列化**用户定义**（只保留写了的字段）。
 *
 * 与 {@link serializeToolchains} 的区别：那个用于「把完整定义摊平」（编辑页场景），
 * 这个用于写回覆盖文件 —— 只写覆盖项，其余字段留给内置定义在读取时补全，
 * 于是内置模板以后改进（比如 `-std=c++20`）能自动被继承，不会被文件里的旧副本挡住。
 */
export function serializeUserToolchains(rawList: any[]): string {
  const out: any[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') { continue; }
    const clean: any = {};
    for (const k of TOOLCHAIN_FILE_FIELDS) {
      const v = (item as any)[k];
      if (v === undefined || v === null || v === '') { continue; }
      if (Array.isArray(v) && v.length === 0) { continue; }
      if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) { continue; }
      if (k === 'asciiSafeOutput' && v !== true) { continue; }
      clean[k] = v;
    }
    if (clean.id) { out.push(clean); }
  }
  return `${JSON.stringify({ version: 1, toolchains: out }, null, 2)}\n`;
}

/**
 * 载入工作区工具链：**只读用户的覆盖项**，内置默认永远来自代码（不被文件污染）。
 *
 * 文件不存在 / 读失败 → 视为「用户没有任何覆盖」，返回空列表而不是报错：
 * 没配过工具链的人应该开箱可用内置三套。
 */
export function loadUserToolchains(file: string): { defs: ToolchainDef[]; problems: string[]; exists: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { defs: [], problems: [], exists: false };
  }
  const { defs, problems } = parseToolchains(text);
  return { defs, problems, exists: true };
}

/** 一次性拿到「生效的工具链列表」 */
export function effectiveToolchains(file: string): { defs: ToolchainDef[]; problems: string[]; fileExists: boolean } {
  const user = loadUserToolchains(file);
  return {
    defs: mergeToolchains(builtinToolchains(), user.defs),
    problems: user.problems,
    fileExists: user.exists,
  };
}
