/**
 * 【本地测试 · 工具链配置页】
 *
 * 生效的工具链 = 代码里的内置定义 + 工作区 `toolchains.json` 的覆盖项
 * （同 id 覆盖内置，见 `test/toolchain.ts` 的 `mergeToolchains`）。
 * 手编那份 JSON 不难，难的是**看不出自己写错了什么**：id 打错、命令找不到、
 * 覆盖了内置的哪些字段 —— 这些都要等到本地测试失败才暴露。
 *
 * 这一页把它们摆出来：每条工具链一行（来源、认领的扩展名、命令探测结果），点开可改；
 * 保存时**只把改过的字段写进文件**（契约 C23 的部分覆盖语义），于是内置模板以后的
 * 改进依然能被继承下来。
 *
 * 与本项目其它自绘页面的差别只有一处：这一页要**开脚本**（表单要收集、保存要回传）。
 * 因此拼进 DOM 的内容一律经 `escapeHtml`（契约 C29），页面脚本只读 DOM、不回写 HTML；
 * 唯一的数据注入点是 `#builtin-defaults` 那段 JSON，其中 `<` 被转义成 `\u003c`，
 * 防止内容提前闭合脚本标签。其余约定不变：固定亮色、不引用编辑器主题变量（C11/C30）。
 *
 * 渲染是纯函数（`buildToolchainHtml`），面板只是薄壳：读文件 → 组装模型 → 塞 HTML。
 */

import * as nodePath from 'path';
import * as vscode from 'vscode';
import {
  ToolchainDef, ToolchainKind,
  builtinToolchains, commonSearchDirs, mergeRawDef, mergeToolchains, normalizeDef,
  overriddenFields, parseToolchainsRaw, resolveCommands, serializeUserToolchains,
  toolchainRawShape,
} from '../test/toolchain';
import { escapeHtml } from '../utils/format';

// ─────────────────────────────────────────────────────────────
// 模型
// ─────────────────────────────────────────────────────────────

/** 命令探测结果（与 `test/toolchain.ts` 的 `ResolvedCommands` 同形） */
export interface ProbeView {
  resolved: Record<string, string>;
  missing: string[];
  tried: string[];
}

/** 一条生效的工具链在页面上的样子 */
export interface ToolchainEntryView {
  id: string;
  label: string;
  kind: ToolchainKind;
  extensions: string[];
  commands: Record<string, string[]>;
  compile?: string;
  run: string;
  env?: Record<string, string>;
  pathPrepend?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxMemoryBytes?: number;
  asciiSafeOutput?: boolean;
  /** 内置项：不可删除，只能改（改不了就「恢复默认」） */
  builtin: boolean;
  /** 文件里有这一条（内置项 = 有覆盖；非内置项 = 自定义条目） */
  fromFile: boolean;
  /** 覆盖了内置的哪些字段（细到 `commands.名字`）；非内置项为空 */
  overridden: string[];
  probe: ProbeView;
}

/** 文件里读不出来的条目（原样保留，不在页面上编辑） */
export interface BrokenEntryView { id: string; problems: string[] }

export interface ToolchainPageModel {
  /** `toolchains.json` 的绝对路径 */
  file: string;
  fileExists: boolean;
  /** 文件本身读不懂（JSON 语法错 / 结构不对）→ 页面只允许看与打开，不允许保存 */
  fileBroken: boolean;
  problems: string[];
  brokenEntries: BrokenEntryView[];
  entries: ToolchainEntryView[];
  /** `oj.test.toolchain` 的当前值 */
  selectedId: string;
  /** 全局看门狗阈值（工具链未声明时用它，页面里当占位提示） */
  limits: WatchdogLimitsView;
  searchDirs: string[];
  /** 读不出来的原始条目（保存时原样写回，不静默丢弃用户手写的内容） */
  rawKept: any[];
}

export interface WatchdogLimitsView {
  timeoutMs: number;
  maxOutputBytes: number;
  maxMemoryBytes: number;
}

export interface BuildModelInput {
  file: string;
  /** 文件内容；`undefined` = 文件不存在（此时页面展示纯内置定义） */
  fileText: string | undefined;
  builtin?: ToolchainDef[];
  selectedId?: string;
  searchDirs?: string[];
  limits?: WatchdogLimitsView;
  /** 命令探测（注入以便单测；默认按环境真探测） */
  probe?: (def: ToolchainDef) => ProbeView;
}

const DEFAULT_LIMITS: WatchdogLimitsView = {
  timeoutMs: 10_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxMemoryBytes: 2 * 1024 * 1024 * 1024,
};

function viewOf(def: ToolchainDef, probe: ProbeView): ToolchainEntryView {
  return {
    id: def.id,
    label: def.label,
    kind: def.kind,
    extensions: def.extensions ?? [],
    commands: def.commands ?? {},
    compile: def.compile,
    run: def.run,
    env: def.env,
    pathPrepend: def.pathPrepend,
    timeoutMs: def.timeoutMs,
    maxOutputBytes: def.maxOutputBytes,
    maxMemoryBytes: def.maxMemoryBytes,
    asciiSafeOutput: def.asciiSafeOutput,
    builtin: def.builtin === true,
    fromFile: false,
    overridden: [],
    probe,
  };
}

/**
 * 内置 + 文件覆盖 + 命令探测 → 页面模型。
 *
 * 坏条目**只记账、不影响别的**：一份写错的 json 不该让整页打不开，
 * 而「哪一条读不出来、为什么」正是用户手编 JSON 时最需要看到的信息。
 */
export function buildToolchainModel(input: BuildModelInput): ToolchainPageModel {
  const builtin = input.builtin ?? builtinToolchains();
  const searchDirs = input.searchDirs ?? commonSearchDirs();
  const probeOf = input.probe ?? ((def: ToolchainDef) => resolveCommands(def, { searchDirs }));

  const base: ToolchainPageModel = {
    file: input.file,
    fileExists: false,
    fileBroken: false,
    problems: [],
    brokenEntries: [],
    entries: [],
    selectedId: input.selectedId ?? 'auto',
    limits: input.limits ?? DEFAULT_LIMITS,
    searchDirs,
    rawKept: [],
  };

  if (input.fileText === undefined) {
    base.entries = builtin.map((d) => viewOf(d, probeOf(d)));
    return base;
  }
  base.fileExists = true;

  const parsedRaw = parseToolchainsRaw(input.fileText);
  if (parsedRaw.problems.length) {
    // 读不懂的文件不敢动：只读展示内置 + 问题，保存按钮在页面上禁用
    base.fileBroken = true;
    base.problems = parsedRaw.problems;
    base.entries = builtin.map((d) => viewOf(d, probeOf(d)));
    return base;
  }

  const builtinById = new Map(builtin.map((b) => [b.id, b]));
  const rawById = new Map<string, any>();
  const parsedDefs: ToolchainDef[] = [];

  for (const item of parsedRaw.raw) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) {
      base.brokenEntries.push({ id: '（缺少 id）', problems: ['缺少 id'] });
      base.rawKept.push(item);
      continue;
    }
    if (rawById.has(id)) {
      base.brokenEntries.push({ id, problems: ['id 重复：同 id 只取第一条，这条被忽略'] });
      base.rawKept.push(item);
      continue;
    }
    const b = builtinById.get(id);
    // 内置项允许只写覆盖字段，所以先拿内置的原始形状垫底再校验
    const candidate = b ? mergeRawDef(toolchainRawShape(b), item) : item;
    const { def, problems } = normalizeDef(candidate);
    if (!def) {
      base.brokenEntries.push({ id, problems });
      base.rawKept.push(item);
      continue;
    }
    parsedDefs.push(def);
    rawById.set(id, item);
  }

  base.entries = mergeToolchains(builtin, parsedDefs).map((d) => {
    const raw = rawById.get(d.id);
    const v = viewOf(d, probeOf(d));
    if (raw) {
      v.fromFile = true;
      if (v.builtin) { v.overridden = overriddenFields(raw, builtin); }
    }
    return v;
  });
  return base;
}

// ─────────────────────────────────────────────────────────────
// 保存计划（纯函数）
// ─────────────────────────────────────────────────────────────

/** 页面回传的一条：字段都是**表单里的文本**，解析与校验全在这一侧做 */
export interface SaveEntryInput {
  id: string;
  builtin: boolean;
  label: string;
  kind: string;
  extensions: string;
  compile: string;
  run: string;
  commands: string;
  env: string;
  pathPrepend: string;
  timeoutMs: string;
  maxOutputBytes: string;
  maxMemoryBytes: string;
  asciiSafeOutput: boolean;
}

export interface SaveAction {
  id: string;
  /** write = 写进文件；remove = 从文件里移除（改成与内置一致，或删掉自定义条目） */
  action: 'write' | 'remove';
  /** 实际写进去的字段（`write` 时） */
  fields: string[];
}

export interface SavePlan {
  ok: boolean;
  problems: string[];
  actions: SaveAction[];
  /** 要写进文件的条目（`ok` 时才可用） */
  entries: any[];
  text: string;
}

function splitList(text: string): string[] {
  return text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

function parseExtensions(text: string): string[] {
  return splitList(text).map((s) => (s.startsWith('.') ? s : `.${s}`).toLowerCase());
}

/** `名字 = 候选1, 候选2` 每行一条 */
function parseCommands(text: string, problems: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) { continue; }
    const eq = s.indexOf('=');
    if (eq < 0) {
      problems.push(`命令「${s}」要写成「名字 = 候选1, 候选2」`);
      continue;
    }
    const name = s.slice(0, eq).trim();
    const list = s.slice(eq + 1).split(',').map((x) => x.trim()).filter(Boolean);
    if (!name || !list.length) {
      problems.push(`命令「${s}」缺少名字或候选`);
      continue;
    }
    out[name] = list;
  }
  return out;
}

/** `KEY=VALUE` 每行一条 */
function parseEnv(text: string, problems: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) { continue; }
    const eq = s.indexOf('=');
    if (eq <= 0) {
      problems.push(`环境变量「${s}」要写成「KEY=VALUE」`);
      continue;
    }
    out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function parseNumber(text: string, label: string, problems: string[]): number | undefined {
  const s = text.trim();
  if (!s) { return undefined; }
  const n = Number(s);
  if (!isFinite(n) || n <= 0) {
    problems.push(`${label}要填正数（留空则用全局默认）`);
    return undefined;
  }
  return n;
}

/**
 * 表单 → 工具链定义。
 *
 * 内置项：先把内置的原始形状摊平，再用表单覆盖，最后走 `normalizeDef` ——
 * 于是「只改了命令路径」这种最自然的用法能被正确接受。
 */
function defOf(input: SaveEntryInput, base: ToolchainDef | undefined, problems: string[]): ToolchainDef | undefined {
  const draft: any = base ? toolchainRawShape(base) : {};
  draft.id = input.id.trim();
  draft.label = input.label.trim() || draft.id;
  draft.kind = input.kind === 'interpreted' ? 'interpreted' : 'compiled';
  draft.extensions = parseExtensions(input.extensions);
  draft.commands = parseCommands(input.commands, problems);
  draft.compile = input.compile.trim() || undefined;
  draft.run = input.run.trim();
  if (input.env.trim()) { draft.env = parseEnv(input.env, problems); } else if (!base) { draft.env = undefined; }
  if (input.pathPrepend.trim()) { draft.pathPrepend = input.pathPrepend.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
  else if (!base) { draft.pathPrepend = undefined; }
  draft.timeoutMs = parseNumber(input.timeoutMs, '超时', problems);
  draft.maxOutputBytes = parseNumber(input.maxOutputBytes, '输出上限', problems);
  draft.maxMemoryBytes = parseNumber(input.maxMemoryBytes, '内存上限', problems);
  draft.asciiSafeOutput = input.asciiSafeOutput ? true : undefined;

  const { def, problems: p } = normalizeDef(draft);
  problems.push(...p.map((x) => x.replace(/^\(无 id\): /, '')));
  return def;
}

/** 生效值与内置形状的差异字段（`commands` 细到命令名，与 `overriddenFields` 同一口径） */
function diffFields(def: ToolchainDef, base: ToolchainDef): { patch: any; fields: string[] } {
  const full: any = toolchainRawShape(def);
  const shape: any = toolchainRawShape(base);
  const patch: any = {};
  const fields: string[] = [];

  for (const [k, v] of Object.entries(full)) {
    if (k === 'commands') { continue; }
    if (JSON.stringify(v) !== JSON.stringify(shape[k])) {
      patch[k] = v;
      fields.push(k);
    }
  }

  if (full.commands) {
    const cmdPatch: Record<string, string[]> = {};
    for (const [name, list] of Object.entries(full.commands as Record<string, string[]>)) {
      if (JSON.stringify(list) !== JSON.stringify(shape.commands?.[name])) {
        cmdPatch[name] = list;
        fields.push(`commands.${name}`);
      }
    }
    if (Object.keys(cmdPatch).length) { patch.commands = cmdPatch; }
  }
  return { patch, fields };
}

/**
 * 表单 → 要落盘的内容。
 *
 * 两种情况写文件：内置项改动过（只写改动字段）、自定义条目（写完整定义）；
 * 内置项改回与内置一致 → **从文件里移除**（这正是「恢复默认」的落点，
 * 也让内置模板以后的改进重新生效）。
 *
 * 有任何一条不合法就**整份不落盘**（契约 C22）—— 半份计划写下去比不写更糟。
 */
export function planToolchainSave(
  inputs: SaveEntryInput[],
  builtin: ToolchainDef[] = builtinToolchains(),
  keepRaw: any[] = [],
): SavePlan {
  const problems: string[] = [];
  const actions: SaveAction[] = [];
  const writes: any[] = [];
  const builtinById = new Map(builtin.map((b) => [b.id, b]));
  const seen = new Set<string>();

  for (const input of inputs) {
    const id = input.id.trim();
    if (!id) {
      problems.push('有一条工具链没填 id');
      continue;
    }
    if (seen.has(id)) {
      problems.push(`id 重复：${id}`);
      continue;
    }
    seen.add(id);

    const base = input.builtin ? builtinById.get(id) : undefined;
    const def = defOf(input, base, problems);
    if (!def) { continue; }

    if (base) {
      const { patch, fields } = diffFields(def, base);
      if (!fields.length) {
        actions.push({ id, action: 'remove', fields: [] });
      } else {
        // 只写覆盖字段：`id` 必须有，其余留给内置定义在读取时补全
        writes.push({ id, ...patch });
        actions.push({ id, action: 'write', fields });
      }
    } else {
      const full: any = toolchainRawShape(def);
      writes.push(full);
      actions.push({ id, action: 'write', fields: ['(完整定义)'] });
    }
  }

  const ok = problems.length === 0;
  return {
    ok,
    problems,
    actions,
    entries: ok ? [...writes, ...keepRaw] : [],
    text: ok ? serializeFile([...writes, ...keepRaw]) : '',
  };
}

/**
 * 写文件。
 *
 * `writes` 本身已经是「只含改动字段」的最小集，不需要再过滤空值；而 `keepRaw`
 * （文件里读不出来的原始条目）必须**逐字段原样**写回 —— `serializeUserToolchains`
 * 会按字段白名单过滤，把用户手写的未知字段吃掉，所以这条路径不走它。
 */
function serializeFile(entries: any[]): string {
  return `${JSON.stringify({ version: 1, toolchains: entries }, null, 2)}\n`;
}

// ─────────────────────────────────────────────────────────────
// 渲染（纯函数）
// ─────────────────────────────────────────────────────────────

export interface HtmlOptions {
  /** 顶部提示条（保存成功之类） */
  notice?: { text: string; kind: 'ok' | 'err' | '' };
  /** 拿来做「恢复默认」基准的内置定义（默认就是代码里的内置四套） */
  builtin?: ToolchainDef[];
}

function commandsText(cmds: Record<string, string[]>): string {
  return Object.entries(cmds ?? {})
    .map(([name, list]) => `${name} = ${(list ?? []).join(', ')}`)
    .join('\n');
}

function envText(env?: Record<string, string>): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

function numText(n?: number): string {
  return n === undefined ? '' : String(n);
}

interface FieldOpts {
  wide?: boolean;
  overridden?: boolean;
  type?: string;
  placeholder?: string;
  readonly?: boolean;
  hint?: string;
}

function field(label: string, name: string, value: string, opts: FieldOpts = {}): string {
  const cls = opts.wide ? 'f wide' : 'f';
  const ov = opts.overridden ? '<span class="ov">已覆盖</span>' : '';
  const attrs = [
    `type="${opts.type ?? 'text'}"`,
    `data-field="${name}"`,
    `value="${escapeHtml(value)}"`,
    opts.placeholder ? `placeholder="${escapeHtml(opts.placeholder)}"` : '',
    opts.readonly ? 'readonly' : '',
  ].filter(Boolean).join(' ');
  return `<label class="${cls}"><span class="k">${escapeHtml(label)}${ov}</span>`
    + `<input ${attrs}>`
    + (opts.hint ? `<span class="tip">${escapeHtml(opts.hint)}</span>` : '')
    + '</label>';
}

function area(label: string, name: string, value: string, opts: FieldOpts = {}): string {
  const cls = opts.wide ? 'f wide' : 'f';
  const ov = opts.overridden ? '<span class="ov">已覆盖</span>' : '';
  const ph = opts.placeholder ? ` placeholder="${escapeHtml(opts.placeholder)}"` : '';
  return `<label class="${cls}"><span class="k">${escapeHtml(label)}${ov}</span>`
    + `<textarea data-field="${name}" rows="3"${ph}>${escapeHtml(value)}</textarea>`
    + (opts.hint ? `<span class="tip">${escapeHtml(opts.hint)}</span>` : '')
    + '</label>';
}

/** 来源徽章：内置 / 覆盖 / 自定义 */
function sourceBadge(e: ToolchainEntryView): string {
  if (!e.builtin) { return '<span class="badge self">自定义</span>'; }
  return e.fromFile && e.overridden.length
    ? '<span class="badge over">覆盖内置</span>'
    : '<span class="badge builtin">内置</span>';
}

/** 探测徽章：命令齐 / 缺哪个 */
function probeBadge(e: ToolchainEntryView): string {
  const missing = e.probe.missing ?? [];
  return missing.length
    ? `<span class="badge bad">缺 ${escapeHtml(missing.join('、'))}</span>`
    : '<span class="badge ok">命令就绪</span>';
}

function probeHtml(e: ToolchainEntryView): string {
  const missing = e.probe.missing ?? [];
  const resolved = Object.entries(e.probe.resolved ?? {});
  const tried = e.probe.tried ?? [];

  const rows = resolved
    .map(([k, v]) => `<li><code>${escapeHtml(k)}</code> → <code>${escapeHtml(v)}</code></li>`)
    .join('');
  const miss = missing
    .map((k) => `<li class="miss"><code>${escapeHtml(k)}</code> 没找到</li>`)
    .join('');

  const triedHtml = tried.length
    ? `<details class="tried"><summary>探测过的 ${tried.length} 个位置</summary><pre>${escapeHtml(tried.join('\n'))}</pre></details>`
    : '';

  return `<div class="probe">
    <div class="sub">命令</div>
    ${resolved.length || missing.length ? `<ul class="cmds">${rows}${miss}</ul>` : '<p class="tip">这条没有声明命令占位符。</p>'}
    ${missing.length ? `<p class="tip">装好对应工具，把安装目录加进 <code>oj.test.searchDirs</code>，或把候选直接写成绝对路径。</p>` : ''}
    ${triedHtml}
  </div>`;
}

function entryHtml(e: ToolchainEntryView, m: ToolchainPageModel): string {
  const ov = (f: string) => e.overridden.includes(f);
  // 命令的覆盖标记记到具体命令名（`commands.gpp`），所以这里要按前缀判
  const cmdOverridden = e.overridden.some((f) => f === 'commands' || f.startsWith('commands.'));
  const sel = m.selectedId === e.id
    ? '<span class="badge sel">当前选用</span>'
    : '';
  const isSel = m.selectedId !== 'auto' && m.selectedId === e.id;
  const head = [
    sourceBadge(e),
    '<b>' + escapeHtml(e.label) + '</b>',
    '<code>' + escapeHtml(e.id) + '</code>',
    '<span class="ext">' + escapeHtml(e.extensions.join(' ')) + '</span>',
    probeBadge(e),
    sel,
  ].join(' ');

  const acts = [
    e.builtin
      ? `<button data-act="revert"${e.fromFile ? '' : ' disabled'} title="把表单恢复成内置定义，保存后这条覆盖会被移除">恢复默认</button>`
      : '<button data-act="remove" title="从 toolchains.json 里删掉这条">删除</button>',
  ].join('');

  return `<details class="card" data-id="${escapeHtml(e.id)}" data-builtin="${e.builtin ? 1 : 0}"${isSel ? ' open' : ''}>
  <summary>${head}</summary>
  <div class="body">
    ${probeHtml(e)}
    <div class="grid">
      ${field('id', 'id', e.id, { readonly: true, hint: '要换 id 请删掉后新增一条' })}
      ${field('名称', 'label', e.label)}
      <label class="f"><span class="k">类型${ov('kind') ? '<span class="ov">已覆盖</span>' : ''}</span>
        <select data-field="kind">
          <option value="compiled"${e.kind === 'compiled' ? ' selected' : ''}>编译型</option>
          <option value="interpreted"${e.kind === 'interpreted' ? ' selected' : ''}>解释型</option>
        </select>
        <span class="tip">编译型需要编译命令模板</span>
      </label>
      ${field('认领的扩展名', 'extensions', e.extensions.join(' '), { overridden: ov('extensions'), hint: '空格分隔，如 .cpp .cc' })}
    </div>
    <div class="grid">
      ${field('编译命令模板', 'compile', e.compile ?? '', { overridden: ov('compile'), wide: true, placeholder: '解释型留空' })}
      ${field('运行命令模板', 'run', e.run, { overridden: ov('run'), wide: true })}
      ${area('命令', 'commands', commandsText(e.commands), {
        overridden: cmdOverridden, wide: true,
        placeholder: '每行一条：gpp = g++, D:\\mingw64\\bin\\g++.exe',
        hint: '候选按顺序探测；写绝对路径就只会用它',
      })}
      ${area('环境变量', 'env', envText(e.env), {
        overridden: ov('env'), wide: true, placeholder: '每行一条：KEY=VALUE', hint: '会覆盖继承来的同名变量',
      })}
      ${area('额外 PATH 目录', 'pathPrepend', (e.pathPrepend ?? []).join('\n'), {
        overridden: ov('pathPrepend'), wide: true, placeholder: '每行一个目录', hint: '追加在自动推导出的目录之后',
      })}
    </div>
    <div class="grid">
      ${field('超时（毫秒）', 'timeoutMs', numText(e.timeoutMs), { overridden: ov('timeoutMs'), type: 'number', placeholder: String(m.limits.timeoutMs) })}
      ${field('输出上限（字节）', 'maxOutputBytes', numText(e.maxOutputBytes), { overridden: ov('maxOutputBytes'), type: 'number', placeholder: String(m.limits.maxOutputBytes) })}
      ${field('内存上限（字节）', 'maxMemoryBytes', numText(e.maxMemoryBytes), { overridden: ov('maxMemoryBytes'), type: 'number', placeholder: String(m.limits.maxMemoryBytes) })}
      <label class="f chk"><span class="k">产物走 ASCII 安全路径${ov('asciiSafeOutput') ? '<span class="ov">已覆盖</span>' : ''}</span>
        <input type="checkbox" data-field="asciiSafeOutput"${e.asciiSafeOutput ? ' checked' : ''}>
        <span class="tip">编译器写不出非 ASCII 产物路径时勾上（MinGW 的 ld 就是这样）</span>
      </label>
    </div>
    <div class="acts">${acts}</div>
  </div>
</details>`;
}

/** 新建卡片的模板（脚本克隆它；内容固定，不含任何数据） */
function blankTemplateHtml(): string {
  return `<template id="tpl">
  <details class="card" data-id="" data-builtin="0">
    <summary><span class="badge self">新增</span> <b>新工具链</b> <span class="tip">填好 id 与扩展名后保存</span></summary>
    <div class="body">
      <div class="grid">
        <label class="f"><span class="k">id</span><input type="text" data-field="id" value="" placeholder="如 rustc"></label>
        <label class="f"><span class="k">名称</span><input type="text" data-field="label" value=""></label>
        <label class="f"><span class="k">类型</span><select data-field="kind"><option value="compiled">编译型</option><option value="interpreted">解释型</option></select></label>
        <label class="f"><span class="k">认领的扩展名</span><input type="text" data-field="extensions" value="" placeholder=".rs"></label>
      </div>
      <div class="grid">
        <label class="f wide"><span class="k">编译命令模板</span><input type="text" data-field="compile" value="" placeholder="解释型留空"></label>
        <label class="f wide"><span class="k">运行命令模板</span><input type="text" data-field="run" value="" placeholder="{runnable}"></label>
        <label class="f wide"><span class="k">命令</span><textarea data-field="commands" rows="3" placeholder="rustc = rustc"></textarea></label>
        <label class="f wide"><span class="k">环境变量</span><textarea data-field="env" rows="2" placeholder="每行一条：KEY=VALUE"></textarea></label>
        <label class="f wide"><span class="k">额外 PATH 目录</span><textarea data-field="pathPrepend" rows="2" placeholder="每行一个目录"></textarea></label>
      </div>
      <div class="grid">
        <label class="f"><span class="k">超时（毫秒）</span><input type="number" data-field="timeoutMs" value=""></label>
        <label class="f"><span class="k">输出上限（字节）</span><input type="number" data-field="maxOutputBytes" value=""></label>
        <label class="f"><span class="k">内存上限（字节）</span><input type="number" data-field="maxMemoryBytes" value=""></label>
        <label class="f chk"><span class="k">产物走 ASCII 安全路径</span><input type="checkbox" data-field="asciiSafeOutput"></label>
      </div>
      <div class="acts"><button data-act="remove">删除</button></div>
    </div>
  </details>
</template>`;
}

/** 内置定义的默认形状（「恢复默认」用；`<` 转义防提前闭合脚本标签） */
function defaultsJson(builtin: ToolchainDef[]): string {
  const map: Record<string, any> = {};
  for (const b of builtin) { map[b.id] = toolchainRawShape(b); }
  return JSON.stringify(map).replace(/</g, '\\u003c');
}

function noticeHtml(opts: HtmlOptions): string {
  const n = opts.notice;
  if (!n || !n.text) { return '<div id="notice" class="notice"></div>'; }
  const cls = n.kind === 'err' ? 'notice err' : n.kind === 'ok' ? 'notice ok' : 'notice';
  return `<div id="notice" class="${cls}">${escapeHtml(n.text)}</div>`;
}

/**
 * 整页 HTML。
 *
 * 亮色固定、不引用编辑器主题变量（契约 C11/C30）；页面脚本只读表单、不回写 HTML，
 * 所有数据都经 `escapeHtml` 落在属性值或文本里。
 */
export function buildToolchainHtml(m: ToolchainPageModel, opts: HtmlOptions = {}): string {
  const builtin = opts.builtin ?? builtinToolchains();
  const broken = m.brokenEntries.length
    ? `<section class="panel bad">
        <h3>文件里这几条读不出来（已原样保留，不会被覆盖）</h3>
        <ul>${m.brokenEntries.map((b) => `<li><code>${escapeHtml(b.id)}</code>：${escapeHtml(b.problems.join('；'))}</li>`).join('')}</ul>
        <p class="tip">在编辑器里改好它们，或删掉后从这里新增。</p>
      </section>`
    : '';

  const fileProblems = m.problems.length
    ? `<section class="panel bad">
        <h3>这个文件读不懂，页面暂不可保存</h3>
        <ul>${m.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        <p class="tip">先修好 JSON 语法再回到这里；期间 <code>toolchains.json</code> 不会被改写。</p>
      </section>`
    : '';

  const missingCount = m.entries.filter((e) => (e.probe.missing ?? []).length).length;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html { color-scheme: light; }
  body { margin: 0; padding: 18px 20px 60px; background: #fff; color: #333;
         font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.6; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  h3 { font-size: 14px; margin: 0 0 8px; }
  code, pre, textarea, input, select { font-family: Consolas, "Courier New", monospace; }
  .meta { color: #666; margin-bottom: 12px; }
  .meta code { color: #333; }
  .notice { display: none; margin: 10px 0; padding: 7px 12px; border-radius: 3px; }
  .notice.ok { display: block; background: #e8f5e9; color: #2e7d32; border-left: 4px solid #43a047; }
  .notice.err { display: block; background: #fdecea; color: #c62828; border-left: 4px solid #e53935; white-space: pre-wrap; }
  .panel { margin: 12px 0; padding: 12px 14px; background: #fafafa; border: 1px solid #e6e6e6; border-radius: 4px; }
  .panel.bad { background: #fff8f8; border-color: #f0c8c8; }
  .panel ul { margin: 0 0 0 18px; padding: 0; }
  .tip { color: #777; font-size: 12px; }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
         padding: 10px 0; background: #fff; border-bottom: 1px solid #eee; }
  .bar .tip { margin-left: 4px; }
  button { padding: 4px 12px; font-size: 13px; color: #333; background: #f5f5f5;
           border: 1px solid #ccc; border-radius: 3px; cursor: pointer; }
  button:hover:not(:disabled) { background: #ececec; }
  button:disabled { color: #aaa; cursor: default; }
  button.primary { color: #fff; background: #2e7d32; border-color: #2e7d32; font-weight: 600; }
  button.primary:hover:not(:disabled) { background: #276b2a; }
  .card { margin: 10px 0; background: #fff; border: 1px solid #e6e6e6; border-radius: 4px; }
  .card > summary { cursor: pointer; padding: 9px 12px; }
  .card > summary b { margin-right: 8px; }
  .card > summary .ext { color: #666; margin-right: 8px; }
  .badge { display: inline-block; padding: 1px 8px; margin-right: 8px; border-radius: 3px;
           font-size: 12px; font-weight: 600; }
  .badge.builtin { background: #eee; color: #555; }
  .badge.over { background: #fff3e0; color: #b26a00; }
  .badge.self { background: #e8f5e9; color: #2e7d32; }
  .badge.ok { background: #e8f5e9; color: #2e7d32; }
  .badge.bad { background: #fdecea; color: #c62828; }
  .badge.sel { background: #e3f2fd; color: #1565c0; }
  .body { padding: 4px 12px 14px; border-top: 1px dashed #e6e6e6; }
  .probe { margin: 10px 0; }
  .sub { color: #777; font-size: 12px; margin-bottom: 4px; }
  .cmds { margin: 0 0 6px 18px; padding: 0; }
  .cmds .miss { color: #c62828; }
  .tried { margin-top: 6px; color: #777; font-size: 12px; }
  .tried pre { margin: 6px 0 0; padding: 8px 10px; background: #f7f7f7; border: 1px solid #e6e6e6;
               border-radius: 3px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .grid { display: flex; flex-wrap: wrap; gap: 10px 14px; margin-top: 10px; }
  .f { display: flex; flex-direction: column; flex: 1 1 220px; min-width: 180px; }
  .f.wide { flex-basis: 100%; }
  .f .k { color: #555; font-size: 12px; margin-bottom: 3px; }
  .f input, .f select, .f textarea { padding: 4px 6px; font-size: 13px; color: #333; background: #fff;
        border: 1px solid #ccc; border-radius: 3px; }
  .f input[readonly] { color: #777; background: #f7f7f7; }
  .f textarea { resize: vertical; }
  .f.chk { flex-direction: row; align-items: center; gap: 6px; }
  .f.chk .k { margin: 0; }
  .f .ov { margin-left: 6px; padding: 0 5px; background: #fff3e0; color: #b26a00;
           border-radius: 2px; font-size: 11px; font-weight: 600; }
  .f .tip { margin-top: 3px; color: #999; font-size: 11px; }
  .acts { margin-top: 12px; }
  .acts button { margin-right: 8px; }
</style></head>
<body>
  <h1>工具链配置</h1>
  <div class="meta">
    文件 <code>${escapeHtml(m.file)}</code>
    ${m.fileExists ? '' : '（还没有这个文件，保存后才会创建）'}
    · 选用 <code>oj.test.toolchain = ${escapeHtml(m.selectedId)}</code>
    ${missingCount ? ` · <span class="badge bad">${missingCount} 条命令没找到</span>` : ''}
  </div>
  ${noticeHtml(opts)}
  ${fileProblems}
  ${broken}

  <div class="bar">
    <button class="primary" data-act="save"${m.fileBroken ? ' disabled' : ''}>保存</button>
    <button data-act="reload">重新加载</button>
    <button data-act="open">打开文件</button>
    <button data-act="add">新增工具链</button>
    <span class="tip">保存时只把改过的字段写进文件，其余沿用内置定义。</span>
  </div>

  <section id="list">
    ${m.entries.map((e) => entryHtml(e, m)).join('')}
  </section>

  <script type="application/json" id="builtin-defaults">${defaultsJson(builtin)}</script>
  ${blankTemplateHtml()}

<script>
(function () {
  var vscode = acquireVsCodeApi();
  var list = document.getElementById('list');
  var noticeEl = document.getElementById('notice');

  function notice(text, kind) {
    if (!noticeEl) { return; }
    noticeEl.className = kind === 'err' ? 'notice err' : kind === 'ok' ? 'notice ok' : 'notice';
    noticeEl.textContent = text || '';
  }

  function cards() {
    return Array.prototype.slice.call(document.querySelectorAll('details.card'));
  }

  function val(card, name) {
    var el = card.querySelector('[data-field="' + name + '"]');
    if (!el) { return ''; }
    return el.type === 'checkbox' ? '' : el.value;
  }

  function checked(card, name) {
    var el = card.querySelector('[data-field="' + name + '"]');
    return !!(el && el.checked);
  }

  function collect() {
    return cards().map(function (card) {
      return {
        id: val(card, 'id'),
        builtin: card.getAttribute('data-builtin') === '1',
        label: val(card, 'label'),
        kind: val(card, 'kind'),
        extensions: val(card, 'extensions'),
        compile: val(card, 'compile'),
        run: val(card, 'run'),
        commands: val(card, 'commands'),
        env: val(card, 'env'),
        pathPrepend: val(card, 'pathPrepend'),
        timeoutMs: val(card, 'timeoutMs'),
        maxOutputBytes: val(card, 'maxOutputBytes'),
        maxMemoryBytes: val(card, 'maxMemoryBytes'),
        asciiSafeOutput: checked(card, 'asciiSafeOutput')
      };
    });
  }

  function setVal(card, name, value) {
    var el = card.querySelector('[data-field="' + name + '"]');
    if (!el) { return; }
    if (el.type === 'checkbox') { el.checked = !!value; } else { el.value = value == null ? '' : String(value); }
  }

  // 恢复默认＝把表单填回内置定义；保存时与内置一致的那些字段不会写进文件
  function revert(card) {
    var defaults = {};
    try { defaults = JSON.parse(document.getElementById('builtin-defaults').textContent) || {}; } catch (e) { defaults = {}; }
    var d = defaults[card.getAttribute('data-id')];
    if (!d) { notice('这条没有内置默认值', 'err'); return; }
    setVal(card, 'label', d.label);
    setVal(card, 'kind', d.kind);
    setVal(card, 'extensions', (d.extensions || []).join(' '));
    setVal(card, 'compile', d.compile || '');
    setVal(card, 'run', d.run || '');
    var cmds = [];
    var cm = d.commands || {};
    Object.keys(cm).forEach(function (k) { cmds.push(k + ' = ' + cm[k].join(', ')); });
    setVal(card, 'commands', cmds.join('\\n'));
    var envs = [];
    var ev = d.env || {};
    Object.keys(ev).forEach(function (k) { envs.push(k + '=' + ev[k]); });
    setVal(card, 'env', envs.join('\\n'));
    setVal(card, 'pathPrepend', (d.pathPrepend || []).join('\\n'));
    setVal(card, 'timeoutMs', d.timeoutMs || '');
    setVal(card, 'maxOutputBytes', d.maxOutputBytes || '');
    setVal(card, 'maxMemoryBytes', d.maxMemoryBytes || '');
    setVal(card, 'asciiSafeOutput', !!d.asciiSafeOutput);
    notice('已填回内置定义，保存后这条覆盖会被移除', 'ok');
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || el.disabled) { return; }
    var act = el.getAttribute('data-act');
    if (act === 'save') { vscode.postMessage({ command: 'save', entries: collect() }); }
    else if (act === 'reload') { vscode.postMessage({ command: 'reload' }); }
    else if (act === 'open') { vscode.postMessage({ command: 'open' }); }
    else if (act === 'add') {
      var tpl = document.getElementById('tpl');
      var node = tpl.content.firstElementChild.cloneNode(true);
      list.appendChild(node);
      node.open = true;
      var idEl = node.querySelector('[data-field="id"]');
      if (idEl) { idEl.focus(); }
      node.scrollIntoView({ block: 'nearest' });
    } else if (act === 'remove') {
      var card = el.closest('details.card');
      if (card) { card.parentNode.removeChild(card); }
    } else if (act === 'revert') {
      revert(el.closest('details.card'));
    }
  });

  window.addEventListener('message', function (ev) {
    var m = ev.data || {};
    if (m.command === 'notice') { notice(m.text, m.kind); }
  });

  // 整页重设后回到原来的位置（保存会重渲染，不记住位置就得重新翻）
  var KEY = 'vsoj-toolchain-scroll';
  var y = sessionStorage.getItem(KEY);
  if (y) { window.scrollTo(0, parseInt(y, 10) || 0); sessionStorage.removeItem(KEY); }
  window.addEventListener('scroll', function () {
    sessionStorage.setItem(KEY, String(window.scrollY || 0));
  }, { passive: true });
})();
</script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// 面板（薄壳）
// ─────────────────────────────────────────────────────────────

export interface ToolchainWebviewDeps {
  /** `toolchains.json` 的绝对路径（由 `oj.test.toolchainsFile` 决定） */
  filePath: () => string;
  /** 读文件；不存在返回 undefined */
  readFile: (file: string) => string | undefined;
  /** 写文件（负责建目录） */
  writeFile: (file: string, text: string) => void;
  /** 在编辑器里打开文件 */
  openFile: (file: string) => void;
  selectedToolchainId: () => string;
  searchDirs: () => string[];
  limits: () => WatchdogLimitsView;
  log?: (msg: string) => void;
}

export class ToolchainWebview {
  private panel: vscode.WebviewPanel | undefined;
  private rawKept: any[] = [];

  constructor(private deps: ToolchainWebviewDeps) {}

  /** 打开（或聚焦）配置页 */
  show(): void {
    if (this.panel) {
      this.render();
      this.panel.reveal(vscode.ViewColumn.Two);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'ojToolchains',
      '工具链配置',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
      // 表单要收集、保存要回传 → 这是本项目第二个开脚本的自绘页面（内容全部经 escapeHtml）
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.onDidReceiveMessage((msg: any) => this.onMessage(msg));
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.render();
  }

  get isOpen(): boolean { return !!this.panel; }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private render(notice?: { text: string; kind: 'ok' | 'err' | '' }): void {
    if (!this.panel) { return; }
    const file = this.deps.filePath();
    const model = buildToolchainModel({
      file,
      fileText: this.deps.readFile(file),
      selectedId: this.deps.selectedToolchainId(),
      searchDirs: this.deps.searchDirs(),
      limits: this.deps.limits(),
    });
    this.rawKept = model.rawKept;
    this.panel.webview.html = buildToolchainHtml(model, { notice });
  }

  private onMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') { return; }
    if (msg.command === 'save') { this.save(msg.entries ?? []); return; }
    if (msg.command === 'reload') { this.render({ text: '已按文件内容重新加载', kind: 'ok' }); return; }
    if (msg.command === 'open') { this.deps.openFile(this.deps.filePath()); return; }
  }

  private save(entries: SaveEntryInput[]): void {
    const file = this.deps.filePath();
    const plan = planToolchainSave(entries, builtinToolchains(), this.rawKept);
    if (!plan.ok) {
      this.post({ command: 'notice', kind: 'err', text: `没保存，先修好这几处：\n${plan.problems.join('\n')}` });
      return;
    }
    try {
      this.deps.writeFile(file, plan.text);
    } catch (e: any) {
      this.post({ command: 'notice', kind: 'err', text: `写文件失败：${e.message}` });
      return;
    }
    const wrote = plan.actions.filter((a) => a.action === 'write').length;
    const removed = plan.actions.filter((a) => a.action === 'remove').length;
    const parts = [
      wrote ? `写入 ${wrote} 条` : '',
      removed ? `移除 ${removed} 条覆盖` : '',
    ].filter(Boolean).join('，') || '没有变化';
    this.render({ text: `已保存（${parts}）：${nodePath.basename(file)}`, kind: 'ok' });
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel?.webview.postMessage(msg);
  }
}
