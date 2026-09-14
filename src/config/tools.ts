/**
 * 配置工具的服务层 —— `get_config_manual` 与 `init_config` 的实际逻辑。
 *
 * 与 `McpToolHandler` 分开的理由：这一层不 import `vscode`，
 * 所有副作用（读设置、写设置、读写文件）都从 {@link ConfigToolDeps} 注入，
 * 于是「AI 给错键名会怎样」「路径写错了会不会在预览里就报出来」这类问题
 * 能在纯 Node 里端到端验证，不必启动 VS Code。
 */

import {
  Catalog,
  ManualSection,
  MANUAL_SECTIONS,
  renderCatalogJson,
  renderManual,
  buildCatalog,
  buildCatalogFromFile,
} from './manual';
import {
  ConfigScope,
  InitConfigInput,
  CurrentConfigState,
  planConfigWrite,
  applyConfigWrite,
  ConfigWritePlan,
} from './writer';

export interface ConfigToolDeps {
  /** `package.json` 路径（打包后 `src/` 不在包里，只能运行时读文件） */
  packageJsonPath?: string;
  /** 直接给目录（测试用；给了就不读文件） */
  catalog?: Catalog;
  /** 工具链文件的绝对路径 */
  toolchainsFile: string;
  /** 工作区根；没有打开文件夹时为 undefined（此时写不了工作区设置） */
  workspaceRoot?: string;
  /** 读当前**生效**的配置（id 不带前缀） */
  readSettings(): Record<string, any>;
  /** 写一项设置；`undefined` = 重置为默认 */
  updateSetting(key: string, value: any, scope: ConfigScope): Promise<void>;
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
  ensureDir(path: string): void;
  backup?(path: string, content: string): string | undefined;
  /** 命令探测用的 PATH 目录；默认取 `process.env.PATH` */
  pathDirs?: string[];
  exists?(path: string): boolean;
  /** 落盘时是否备份（默认 true） */
  keepBackup?: boolean;
}

export interface ConfigToolTextResult {
  ok: boolean;
  text: string;
}

export class ConfigToolService {
  private cachedCatalog?: Catalog;

  constructor(private readonly deps: ConfigToolDeps) {}

  /** 惰性构建目录：说明书要反映**装着的那个版本**，而不是编译时的快照 */
  private catalog(): Catalog {
    if (this.cachedCatalog) { return this.cachedCatalog; }
    this.cachedCatalog = this.deps.catalog
      ?? (this.deps.packageJsonPath
        ? buildCatalogFromFile(this.deps.packageJsonPath)
        : buildCatalog({}));
    return this.cachedCatalog;
  }

  /**
   * 读插件配置说明书。
   *
   * 默认给全文（markdown）。`format: 'json'` 给机器可读形态 ——
   * 配置项多的时候 JSON 省 token，但讲不清「为什么」，故 markdown 仍是默认。
   */
  getManual(args: Record<string, any> = {}): ConfigToolTextResult {
    const catalog = this.catalog();
    const rawSection = String(args.section ?? 'all').trim() as ManualSection;
    if (!MANUAL_SECTIONS.includes(rawSection)) {
      return {
        ok: false,
        text: `未知 section "${args.section}"。可选：${MANUAL_SECTIONS.join(' / ')}`,
      };
    }

    if (args.format === 'json') {
      const json = renderCatalogJson(catalog) as any;
      json.section = rawSection;
      if (rawSection !== 'all') {
        // 只留需要的部分，别把全文塞给调用方
        if (rawSection !== 'settings') { delete json.settings; }
        if (rawSection !== 'toolchains') {
          delete json.toolchainFields;
          delete json.commandResolutionOrder;
          delete json.builtinToolchains;
        }
        if (rawSection !== 'files' && rawSection !== 'settings') { delete json.files; }
      }
      return { ok: true, text: JSON.stringify(json, null, 2) };
    }

    return { ok: true, text: renderManual(catalog, { section: rawSection }) };
  }

  /** 当前状态（预览与落盘都要用） */
  private currentState(): CurrentConfigState {
    return {
      settings: this.deps.readSettings(),
      toolchainsFile: this.deps.toolchainsFile,
      toolchainsText: this.deps.readFile(this.deps.toolchainsFile),
      ...(this.deps.pathDirs ? { pathDirs: this.deps.pathDirs } : {}),
      ...(this.deps.exists ? { exists: this.deps.exists } : {}),
    };
  }

  /**
   * 初始化 / 更新配置。
   *
   * 默认**只预览**（`apply` 未设或为 false）；带 `apply: true` 才落盘，
   * 且计划里有 error 时**一律拒绝落盘** —— 坏配置写下去比不写更糟。
   */
  async initConfig(args: Record<string, any> = {}): Promise<ConfigToolTextResult> {
    const input = (args ?? {}) as InitConfigInput;
    const plan = planConfigWrite(input, this.currentState(), this.catalog());

    // 没打开文件夹时工作区级设置**写不进去**（VS Code 会直接报错）。
    // 与其等落盘时才失败，不如在预览里就说清两条出路。
    if (plan.scope === 'workspace' && this.deps.workspaceRoot === undefined) {
      plan.errors.push(
        '当前没有打开任何文件夹，无法写入「工作区」级设置 —— '
        + '要么先打开一个文件夹，要么改用 `"scope": "global"` 写全局设置。',
      );
    }

    if (!plan.apply || plan.errors.length) {
      return { ok: plan.errors.length === 0, text: renderPlan(plan, 'preview') };
    }

    const applied = await applyConfigWrite(plan, {
      updateSetting: (key, value, scope) => this.deps.updateSetting(key, value, scope),
      writeFile: (p, c) => this.deps.writeFile(p, c),
      ensureDir: (p) => this.deps.ensureDir(p),
      ...(this.deps.backup && this.deps.keepBackup !== false
        ? { backup: (p: string, c: string) => this.deps.backup!(p, c) }
        : {}),
    });

    return {
      ok: applied.applied,
      text: renderPlan(plan, 'applied', applied),
    };
  }
}

// ============================================================
// 渲染（AI 读的就是这段，务必把「下一步怎么做」写清楚）
// ============================================================

interface ApplyLite {
  settingsWritten: string[];
  settingsReset: string[];
  settingsFailed: Array<{ key: string; error: string }>;
  toolchains?: { file: string; written: boolean; backup?: string };
  errors: string[];
}

function renderPlan(
  plan: ConfigWritePlan,
  mode: 'preview' | 'applied',
  applied?: ApplyLite,
): string {
  const L: string[] = [];
  const changed = plan.settings.filter((s) => s.changed);

  L.push(mode === 'preview' ? '# 配置预览（**尚未落盘**）' : '# 配置已写入');
  L.push('');

  if (mode === 'preview') {
    if (plan.errors.length) {
      L.push('❌ **计划有错误，不会落盘。** 改完这些再调用一次：');
      L.push('');
      for (const e of plan.errors) { L.push(`- ${e}`); }
      L.push('');
    } else if (changed.length === 0 && !plan.toolchains?.changed) {
      L.push('没有需要变更的内容（当前配置已经与请求一致）。');
      L.push('');
    } else {
      L.push('确认无误后，用**同样的参数**加 `"apply": true` 再调一次即可落盘。');
      L.push('');
    }
  }

  // ── 配置项 ─────────────────────────────────────────────────
  L.push(`## 配置项（作用域：${plan.scope === 'global' ? '全局 User' : '当前工作区'}）`);
  L.push('');
  if (!plan.settings.length) {
    L.push('（本次未提交任何配置项）');
  } else {
    L.push('| 配置项 | 当前生效值 | 将写入 | 状态 |');
    L.push('|---|---|---|---|');
    for (const s of plan.settings) {
      const status = mode === 'applied'
        ? (applied?.settingsFailed.some((f) => f.key === s.key) ? '❌ 写入失败'
          : s.to === null ? '✅ 已重置' : s.changed ? '✅ 已写入' : '— 无变化')
        : s.to === null ? '重置为默认' : s.changed ? '**变更**' : '无变化';
      L.push(`| \`${s.key}\` | ${fmt(s.from)} | ${s.to === null ? '（重置为默认）' : fmt(s.to)} | ${status} |`);
    }
  }
  L.push('');

  // ── 工具链 ─────────────────────────────────────────────────
  if (plan.toolchains) {
    const tc = plan.toolchains;
    L.push(`## 工具链（\`${tc.file}\`）`);
    L.push('');
    const actionText: Record<string, string> = {
      'override-builtin': '覆盖内置',
      'builtin-unchanged': '与内置相同（等于没改）',
      add: '新增',
      update: '更新',
    };
    if (tc.entries.length) {
      for (const e of tc.entries) {
        const fields = e.fields.length ? `：${e.fields.map((f) => `\`${f}\``).join('、')}` : '';
        L.push(`- \`${e.id}\` — ${actionText[e.action] ?? e.action}${fields}`);
      }
    } else {
      L.push('（文件将为空：没有任何覆盖项）');
    }
    L.push('');
    if (tc.changed) {
      L.push('写入内容：');
      L.push('');
      L.push('```json');
      L.push(tc.content.trimEnd());
      L.push('```');
      L.push('');
      if (mode === 'applied' && applied?.toolchains) {
        L.push(applied.toolchains.written
          ? `✅ 已写入${applied.toolchains.backup ? `（旧文件备份在 \`${applied.toolchains.backup}\`）` : ''}`
          : '⏭ 内容无变化，未写盘');
        L.push('');
      }
    } else {
      L.push('（与磁盘上的内容一致，不会写盘）');
      L.push('');
    }
  } else if (mode === 'preview' && !plan.errors.length) {
    L.push('## 工具链');
    L.push('');
    L.push('（本次未提交 `toolchains`，`.vsoj/toolchains.json` 保持原样）');
    L.push('');
  }

  // ── 命令解析 ───────────────────────────────────────────────
  if (plan.checks.length) {
    L.push(`## 命令解析（用${mode === 'applied' ? '当前' : '将要'}生效的定义实探）`);
    L.push('');
    for (const c of plan.checks) {
      const head = c.ok ? '✅' : '❌';
      const cmds = c.resolved
        .map((r) => (r.ok ? `\`${r.name}\` → ${r.path}` : `\`${r.name}\` 未找到`))
        .join('；');
      L.push(`- ${head} **${c.label}** (\`${c.id}\`, ${c.kind}) — ${cmds}`);
      if (!c.ok && c.tried.length) {
        L.push('  <br>已探测过：');
        for (const t of c.tried.slice(0, 12)) { L.push(`  - \`${t}\``); }
        if (c.tried.length > 12) { L.push(`  - …另有 ${c.tried.length - 12} 处`); }
      }
    }
    L.push('');
    const failed = plan.checks.filter((c) => !c.ok);
    if (failed.length) {
      L.push('> 未解析到的工具链**跑测试时才会失败**。两种修法：把命令写成绝对路径，'
        + '或把所在目录加进 `oj.test.searchDirs`。插件不内置任何个人环境路径，'
        + '所以这一步需要先探测本机（`g++ --version`、问用户、找常见安装目录）。');
      L.push('');
    }
  }

  // ── 警告 / 错误 ────────────────────────────────────────────
  if (plan.warnings.length) {
    L.push('## ⚠️ 提醒（不影响落盘）');
    L.push('');
    for (const w of plan.warnings) { L.push(`- ${w}`); }
    L.push('');
  }
  if (mode === 'applied' && applied?.errors.length) {
    L.push('## ❌ 落盘时的错误');
    L.push('');
    for (const e of applied.errors) { L.push(`- ${e}`); }
    L.push('');
  }

  return L.join('\n');
}

function fmt(v: any): string {
  if (v === undefined) { return '`（未设置，用默认值）`'; }
  const s = JSON.stringify(v);
  return `\`${s && s.length > 60 ? s.slice(0, 57) + '…' : s}\``;
}
