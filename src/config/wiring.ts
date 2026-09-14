/**
 * 配置工具的**扩展侧**接线：把 VS Code 的各种 API 收敛成 {@link ConfigToolDeps}。
 *
 * 这一层存在的意义是让 `config/tools.ts` 保持零 `vscode` 依赖 ——
 * 「AI 给错键名会怎样」「写盘前会不会先备份」这些逻辑因此在纯 Node 里就能测，
 * 而这一层薄到只需要人眼扫一遍。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import { ConfigToolService } from './tools';
import { ConfigScope } from './writer';
import { buildCatalogFromFile } from './manual';
import { getToolchainsFile } from '../utils/config';

/** 工具链配置文件位置：绝对路径原样用；相对路径挂工作区根；没工作区就落到 globalStorage */
export function resolveToolchainsFile(
  setting: string,
  workspaceRoot: string | undefined,
  globalStoragePath: string,
): string {
  const v = (setting || '').trim() || '.vsoj/toolchains.json';
  if (nodePath.isAbsolute(v)) { return v; }
  return workspaceRoot
    ? nodePath.join(workspaceRoot, v)
    : nodePath.join(globalStoragePath, 'toolchains.json');
}

/** 备份文件名：与源文件同目录，带时间戳，不覆盖已有备份 */
function backupPathFor(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${file}.bak-${stamp}`;
}

export interface ConfigWiringContext {
  extensionPath: string;
  globalStoragePath: string;
}

/**
 * 构造配置工具服务。
 *
 * `catalog` 与 `readSettings` 共用同一份 `package.json` 解析结果，
 * 保证「说明书里列的项」与「能读到的项」是同一批 —— 不会出现文档有而读不到的键。
 */
export function buildConfigToolService(ctx: ConfigWiringContext): ConfigToolService {
  const packageJsonPath = nodePath.join(ctx.extensionPath, 'package.json');
  let catalog;
  try {
    catalog = buildCatalogFromFile(packageJsonPath);
  } catch {
    catalog = undefined; // 打包异常时退化为空目录，工具仍可用（只能说没什么可配）
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const toolchainsFile = resolveToolchainsFile(
    getToolchainsFile(), workspaceRoot, ctx.globalStoragePath,
  );

  const declaredIds = (catalog?.entries ?? []).map((e) => e.id);

  return new ConfigToolService({
    catalog,
    packageJsonPath,
    toolchainsFile,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    readSettings: () => {
      const cfg = vscode.workspace.getConfiguration('oj');
      const out: Record<string, any> = {};
      for (const id of declaredIds) {
        const v = cfg.get(id);
        if (v !== undefined) { out[id] = v; }
      }
      return out;
    },
    updateSetting: async (key: string, value: any, scope: ConfigScope) => {
      const target = scope === 'global'
        ? vscode.ConfigurationTarget.Global
        : vscode.ConfigurationTarget.Workspace;
      // `undefined` = 删掉这一项，回到 package.json 的默认值
      await vscode.workspace.getConfiguration('oj').update(key.slice(3), value, target);
    },
    readFile: (p) => {
      try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; }
    },
    writeFile: (p, content) => { fs.writeFileSync(p, content, 'utf8'); },
    ensureDir: (p) => { fs.mkdirSync(p, { recursive: true }); },
    backup: (p, previous) => {
      const bp = backupPathFor(p);
      fs.writeFileSync(bp, previous, 'utf8');
      return bp;
    },
  });
}
