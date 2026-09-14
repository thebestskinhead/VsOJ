/**
 * 写配置：把「AI 想写什么」变成一份**可审查的计划**，再由注入的 IO 落盘。
 *
 * 为什么拆成两步：配置是**会改坏东西**的操作。计划是纯函数（不碰磁盘、不依赖 VS Code），
 * 所以「AI 给的键名打错字了」「值类型不对」「某个 id 根本不存在」这些问题
 * 能在**落盘之前**被测出来并讲清楚 —— 而不是写完让用户自己去发现插件不工作了。
 */

import * as nodePath from 'path';
import {
  ToolchainDef,
  builtinToolchains,
  parseToolchains,
  parseToolchainsRaw,
  serializeUserToolchains,
  mergeToolchains,
  resolveCommands,
  overriddenFields,
} from '../test/toolchain';
import { Catalog, ConfigEntry } from './manual';

export type ConfigScope = 'workspace' | 'global';
export type ToolchainMode = 'merge' | 'replace';

// ============================================================
// 输入 / 现状
// ============================================================

export interface InitConfigInput {
  /** 要写入的 `oj.*` 项。键可带或不带 `oj.` 前缀；值为 `null` 表示「重置回默认」 */
  settings?: Record<string, any>;
  /** 工具链覆盖/新增（AI 探测本机后给出）。只写要覆盖的字段即可 */
  toolchains?: any[];
  /** `merge`（默认）保留文件里已有的其它定义；`replace` 整份重写 */
  toolchainMode?: ToolchainMode;
  /** 写到工作区还是全局（默认工作区） */
  scope?: ConfigScope;
  /** `true` 才真的落盘；省略/false 只预览 */
  apply?: boolean;
}

export interface CurrentConfigState {
  /** 当前**生效**的配置值（id 不带前缀）。缺项视为 undefined */
  settings?: Record<string, any>;
  /** 工具链文件的绝对路径（由调用方解析好；writer 不猜目录） */
  toolchainsFile?: string;
  /** 工具链文件现有内容；不存在则 undefined */
  toolchainsText?: string;
  /** 命令查找用的 PATH 目录（默认取 `process.env.PATH`，测试可注入） */
  pathDirs?: string[];
  /** 文件存在性判定（默认 `fs.existsSync`，测试可注入） */
  exists?: (p: string) => boolean;
}

// ============================================================
// 计划
// ============================================================

export interface SettingChange {
  key: string;
  id: string;
  /** 当前生效值 */
  from: any;
  /** 将要写入的值；`null` 表示重置回默认 */
  to: any;
  changed: boolean;
  /** 值被规范化过（如 `"5000"` → `5000`），必须让调用方看见 */
  warnings: string[];
}

export interface ToolchainPlanEntry {
  id: string;
  action: 'override-builtin' | 'builtin-unchanged' | 'add' | 'update';
  /** 相对内置定义实际动了的字段 */
  fields: string[];
}

export interface CommandResolution {
  name: string;
  ok: boolean;
  path?: string;
}

export interface ToolchainCheck {
  id: string;
  label: string;
  kind: string;
  ok: boolean;
  resolved: CommandResolution[];
  /** 没解析出来的命令名 */
  missing: string[];
  /** 探测过的全部位置 —— 失败时这段才是有用的信息，而不是一句「找不到 g++」 */
  tried: string[];
}

export interface ToolchainsPlan {
  file: string;
  mode: ToolchainMode;
  existed: boolean;
  entries: ToolchainPlanEntry[];
  /** 将要写入的完整文本 */
  content: string;
  /** 写盘前的原文（用于备份与 diff） */
  previous?: string;
  /** 与原文相同则不必写 */
  changed: boolean;
}

export interface ConfigWritePlan {
  scope: ConfigScope;
  apply: boolean;
  settings: SettingChange[];
  toolchains?: ToolchainsPlan;
  /** 用「将要生效的定义」试解析命令：落盘前就知道能不能用 */
  checks: ToolchainCheck[];
  /** 有 error 时**不得落盘** */
  errors: string[];
  warnings: string[];
}

// ============================================================
// 计划：构造
// ============================================================

/** 键名归一化：AI 写 `baseUrl` 或 `oj.baseUrl` 都认 */
export function normalizeSettingKey(raw: string): string {
  const k = String(raw ?? '').trim();
  if (!k) { return k; }
  return k.startsWith('oj.') ? k : `oj.${k}`;
}

/** 简单的编辑距离，只为「键名打错字」时给出像样的建议 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m || !n) { return Math.max(m, n); }
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 找最接近的已声明键（大小写差别的优先） */
function suggestKey(id: string, entries: ConfigEntry[]): string | undefined {
  const lower = id.toLowerCase();
  const caseOnly = entries.find((e) => e.id.toLowerCase() === lower);
  if (caseOnly) { return caseOnly.key; }
  let best: { key: string; d: number } | undefined;
  for (const e of entries) {
    const d = editDistance(lower, e.id.toLowerCase());
    if (!best || d < best.d) { best = { key: e.key, d }; }
  }
  return best && best.d <= 3 ? best.key : undefined;
}

/**
 * 按声明类型规范化一个值。
 *
 * 能无损转换的就转（`"5000"` → `5000`）并**记一条 warning** ——
 * 静默转换会让 AI 以为自己写对了，不转又太苛刻（JSON 里数字写成字符串太常见）。
 */
function coerceValue(
  entry: ConfigEntry,
  value: any,
  warnings: string[],
): { ok: true; value: any } | { ok: false; error: string } {
  const t = entry.type;

  if (t === 'string') {
    if (typeof value === 'string') {
      if (entry.enum && !entry.enum.includes(value)) {
        warnings.push(`${entry.key}: 取值 "${value}" 不在声明的枚举内（${entry.enum.join(' / ')}），插件可能静默按默认值处理`);
      }
      return { ok: true, value };
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      warnings.push(`${entry.key}: 期望字符串，已把 ${JSON.stringify(value)} 转成 "${value}"`);
      return { ok: true, value: String(value) };
    }
    return { ok: false, error: `${entry.key}: 期望字符串，收到 ${describeType(value)}` };
  }

  if (t === 'number') {
    if (typeof value === 'number' && isFinite(value)) { return { ok: true, value }; }
    if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) {
      warnings.push(`${entry.key}: 期望数字，已把 "${value}" 转成 ${Number(value)}`);
      return { ok: true, value: Number(value) };
    }
    return { ok: false, error: `${entry.key}: 期望数字，收到 ${JSON.stringify(value)}` };
  }

  if (t === 'boolean') {
    if (typeof value === 'boolean') { return { ok: true, value }; }
    if (value === 'true' || value === 'false') {
      warnings.push(`${entry.key}: 期望布尔，已把 "${value}" 转成 ${value}`);
      return { ok: true, value: value === 'true' };
    }
    return { ok: false, error: `${entry.key}: 期望布尔，收到 ${JSON.stringify(value)}` };
  }

  if (t === 'array') {
    if (Array.isArray(value)) { return { ok: true, value }; }
    if (typeof value === 'string') {
      const list = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      warnings.push(`${entry.key}: 期望数组，已按分隔符拆成 ${list.length} 项`);
      return { ok: true, value: list };
    }
    return { ok: false, error: `${entry.key}: 期望数组，收到 ${describeType(value)}` };
  }

  // 未知类型（package.json 里出现新 type 时不阻断，只提示）
  warnings.push(`${entry.key}: 声明类型 "${t}" 未识别，原样写入`);
  return { ok: true, value };
}

function describeType(v: any): string {
  if (Array.isArray(v)) { return 'array' }
  return v === null ? 'null' : typeof v;
}

/** 构造计划（纯函数：不碰磁盘、不依赖 VS Code） */
export function planConfigWrite(
  input: InitConfigInput,
  current: CurrentConfigState,
  catalog: Catalog,
): ConfigWritePlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const scope: ConfigScope = input.scope === 'global' ? 'global' : 'workspace';

  // ── 1. settings ────────────────────────────────────────────
  const byKey = new Map(catalog.entries.map((e) => [e.key, e]));
  const settings: SettingChange[] = [];
  const rawSettings = input.settings ?? {};

  if (typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    errors.push('settings 必须是对象（键为 oj.* 配置名）');
  } else {
    for (const [rawKey, rawValue] of Object.entries(rawSettings)) {
      const key = normalizeSettingKey(rawKey);
      let entry = byKey.get(key);

      // 大小写写错很常见（baseurl vs baseUrl），能唯一定位就自动纠正并提示
      if (!entry) {
        const lower = key.slice(3).toLowerCase();
        const hit = catalog.entries.find((e) => e.id.toLowerCase() === lower);
        if (hit) {
          warnings.push(`${rawKey}: 键名大小写有误，已按 ${hit.key} 处理`);
          entry = hit;
        }
      }

      if (!entry) {
        const maybe = suggestKey(key.slice(3), catalog.entries);
        errors.push(`未知配置项 "${rawKey}"${maybe ? ` —— 是不是想写 ${maybe}？` : ''}`);
        continue;
      }

      const localWarnings: string[] = [];
      const from = current.settings?.[entry.id];

      // null = 重置回默认（从 settings.json 里删掉这一项）
      if (rawValue === null) {
        settings.push({
          key: entry.key, id: entry.id, from, to: null,
          changed: from !== undefined, warnings: localWarnings,
        });
        continue;
      }

      const coerced = coerceValue(entry, rawValue, localWarnings);
      if (!coerced.ok) { errors.push(coerced.error); continue; }
      if (coerced.value === undefined) {
        errors.push(`${entry.key}: 值不能是 undefined（要重置请写 null）`);
        continue;
      }

      settings.push({
        key: entry.key,
        id: entry.id,
        from,
        to: coerced.value,
        changed: JSON.stringify(from) !== JSON.stringify(coerced.value),
        warnings: localWarnings,
      });
      warnings.push(...localWarnings);
    }
  }

  // ── 2. toolchains ──────────────────────────────────────────
  let toolchains: ToolchainsPlan | undefined;
  let checks: ToolchainCheck[] = [];
  const mode: ToolchainMode = input.toolchainMode === 'replace' ? 'replace' : 'merge';
  const incoming = input.toolchains;

  if (incoming !== undefined) {
    if (!Array.isArray(incoming)) {
      errors.push('toolchains 必须是数组');
    } else {
      const file = current.toolchainsFile ?? '';
      if (!file) {
        errors.push('缺少工具链文件路径（toolchainsFile）');
      } else {
        const existed = current.toolchainsText !== undefined;
        const { raw: existingRaw, problems: readProblems } = existed
          ? parseToolchainsRaw(current.toolchainsText!)
          : { raw: [] as any[], problems: [] as string[] };
        warnings.push(...readProblems);

        // 条目本身要是有 id；覆盖内置却一个字段都没动等于没写，也拦下来
        const builtinById = new Map(builtinToolchains().map((b) => [b.id, b]));
        for (const [i, item] of incoming.entries()) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push(`toolchains[${i}] 不是对象`);
          } else if (!item.id || typeof item.id !== 'string') {
            errors.push(`toolchains[${i}] 缺少 id`);
          } else if (builtinById.has(item.id) && overriddenFields(item, builtinToolchains()).length === 0) {
            errors.push(
              `toolchains[${i}] (\`${item.id}\`) 没有覆盖任何字段 —— 写它等于没写。`
              + '要改什么就把那个字段写上，例如 `"commands": { "gpp": ["<g++ 绝对路径>"] }`。',
            );
          }
        }

        const merged = mergeRawList(mode === 'replace' ? [] : existingRaw, incoming);
        const content = serializeUserToolchains(merged);

        // 写下去的东西必须能被引擎读回来（部分覆盖此时已由内置定义补全）
        const reparsed = parseToolchains(content);
        for (const p of reparsed.problems) { errors.push(`工具链定义有问题：${p}`); }

        toolchains = {
          file,
          mode,
          existed,
          entries: describeEntries(merged, builtinToolchains()),
          content,
          previous: current.toolchainsText,
          changed: content !== (current.toolchainsText ?? ''),
        };

        // 用「将要生效的定义」试解析命令 —— 这是最有价值的一步：
        // AI 的路径写错了，在预览里就能看到 tried 列表，不用等跑测试才炸
        const effective = mergeToolchains(builtinToolchains(), reparsed.defs);
        const searchDirs = pickPlannedArray(settings, 'test.searchDirs', current.settings);
        checks = effective.map((d) => checkToolchain(d, current, searchDirs));
      }
    }
  }

  return {
    scope,
    apply: input.apply === true,
    settings,
    toolchains,
    checks,
    errors,
    warnings,
  };
}

/** 取「计划里的新值，没有就用当前值」——用于 searchDirs 这类影响探测的参数 */
function pickPlannedArray(
  changes: SettingChange[],
  id: string,
  currentSettings?: Record<string, any>,
): string[] {
  const hit = changes.find((c) => c.id === id);
  const value = hit && hit.to !== null ? hit.to : currentSettings?.[id];
  return Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.trim()) : [];
}

/** 合并 raw 列表：同 id 后者覆盖前者（并保留原有顺序） */
export function mergeRawList(existing: any[], incoming: any[]): any[] {
  const out: any[] = existing.map((x) => ({ ...x }));
  const index = new Map<string, number>();
  out.forEach((x, i) => { if (x && typeof x.id === 'string') { index.set(x.id, i); } });

  for (const item of incoming) {
    const id = item && typeof item.id === 'string' ? item.id : '';
    if (!id) { continue; }
    const at = index.get(id);
    if (at === undefined) {
      index.set(id, out.length);
      out.push({ ...item });
    } else {
      const prev = out[at];
      const next: any = { ...prev, ...item };
      if (prev?.commands || item?.commands) {
        next.commands = { ...(prev?.commands ?? {}), ...(item?.commands ?? {}) };
      }
      out[at] = next;
    }
  }
  return out;
}

/** 说明每条定义相对内置是「覆盖 / 新增 / 没动」，以及动了哪些字段 */
function describeEntries(rawList: any[], builtin: ToolchainDef[]): ToolchainPlanEntry[] {
  const byId = new Map(builtin.map((b) => [b.id, b]));
  return rawList
    .filter((x) => x && typeof x.id === 'string')
    .map((raw) => {
      const fields = overriddenFields(raw, builtin);
      if (!byId.has(raw.id)) { return { id: raw.id, action: 'add' as const, fields }; }
      return {
        id: raw.id,
        action: fields.length ? ('override-builtin' as const) : ('builtin-unchanged' as const),
        fields,
      };
    });
}

/** 解析一套工具链的命令，回报解析结果与「试过哪些位置」 */
export function checkToolchain(
  def: ToolchainDef,
  current: CurrentConfigState,
  searchDirs: string[] = [],
): ToolchainCheck {
  const pathDirs = current.pathDirs ?? splitPath(process.env.PATH);
  const resolved = resolveCommands(def, {
    pathDirs,
    searchDirs,
    ...(current.exists ? { exists: current.exists } : {}),
  });
  const names = Object.keys(def.commands ?? {});
  const rows: CommandResolution[] = names.map((name) => ({
    name,
    ok: !!resolved.resolved[name],
    path: resolved.resolved[name],
  }));
  return {
    id: def.id,
    label: def.label ?? def.id,
    kind: def.kind,
    ok: rows.length > 0 && rows.every((r) => r.ok),
    resolved: rows,
    missing: resolved.missing,
    tried: resolved.tried,
  };
}

/** PATH 字符串 → 目录数组 */
export function splitPath(value: string | undefined): string[] {
  if (!value) { return []; }
  return value.split(nodePath.delimiter).filter((d) => d && d.trim());
}

// ============================================================
// 落盘（副作用全部注入，便于单测）
// ============================================================

export interface ConfigWriteIo {
  /** 写一项设置（`undefined` = 重置为默认） */
  updateSetting(key: string, value: any, scope: ConfigScope): Promise<void>;
  readFile?(p: string): string | undefined;
  writeFile(p: string, content: string): void;
  ensureDir(p: string): void;
  /** 覆盖前的备份；返回备份路径（没有旧文件时返回 undefined） */
  backup?(p: string, content: string): string | undefined;
}

export interface ApplyConfigResult {
  applied: boolean;
  settingsWritten: string[];
  settingsReset: string[];
  settingsFailed: Array<{ key: string; error: string }>;
  toolchains?: { file: string; written: boolean; backup?: string };
  errors: string[];
}

/**
 * 执行计划。**有 error 时拒绝落盘**（返回 applied:false），
 * 因为那份计划写下去就是坏的配置 —— 预览里已经告诉调用方哪里错了。
 */
export async function applyConfigWrite(
  plan: ConfigWritePlan,
  io: ConfigWriteIo,
): Promise<ApplyConfigResult> {
  const result: ApplyConfigResult = {
    applied: false,
    settingsWritten: [],
    settingsReset: [],
    settingsFailed: [],
    errors: [...plan.errors],
  };

  if (plan.errors.length) {
    result.errors.push('计划存在错误，已拒绝落盘（改完再看一次预览）');
    return result;
  }
  if (!plan.apply) {
    result.errors.push('未设置 apply=true，本次只做了预览');
    return result;
  }

  for (const change of plan.settings) {
    if (!change.changed) { continue; }
    try {
      // to === null → 删掉这一项，让它回到 package.json 的默认值
      await io.updateSetting(change.key, change.to === null ? undefined : change.to, plan.scope);
      if (change.to === null) { result.settingsReset.push(change.key); }
      else { result.settingsWritten.push(change.key); }
    } catch (e: any) {
      result.settingsFailed.push({ key: change.key, error: e?.message ?? String(e) });
    }
  }

  if (plan.toolchains && plan.toolchains.changed) {
    const tc = plan.toolchains;
    try {
      io.ensureDir(nodePath.dirname(tc.file));
      const backup = tc.previous !== undefined && io.backup
        ? io.backup(tc.file, tc.previous)
        : undefined;
      io.writeFile(tc.file, tc.content);
      result.toolchains = { file: tc.file, written: true, ...(backup ? { backup } : {}) };
    } catch (e: any) {
      result.toolchains = { file: tc.file, written: false };
      result.errors.push(`写入工具链文件失败：${e?.message ?? e}`);
    }
  } else if (plan.toolchains) {
    result.toolchains = { file: plan.toolchains.file, written: false };
  }

  result.applied = result.errors.length === 0;
  return result;
}
