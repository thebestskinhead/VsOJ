/**
 * 【工作区 · 打开源码】
 *
 * 「左代码右题目」里「左代码」那一半：把该题的源文件开到 `ViewColumn.One`。
 *
 * 之所以单独成模块而不是写在 `extension.ts` 的闭包里：这里的核心是**复用判定**
 * （文件已经在编辑器里可见时不能动它），那是一条容易写错、又完全可单测的规则。
 * 见 `test/open-source.test.js`。
 */

/** 打开源码所需的外部动作 */
export interface OpenSourceDeps {
  /** 当前可见的 `file:` 文档绝对路径列表 */
  visibleFilePaths: () => string[];
  /** 打开并定位到左栏 */
  openAndReveal: (file: string) => Promise<void>;
}

export type OpenSourceOutcome =
  /** 打开了新标签 */
  | 'opened'
  /** 文件已可见，什么都没做（D9：不抢用户已有的位置） */
  | 'reused'
  /** 文件不存在（未初始化 / 初始化失败），无从打开 */
  | 'missing';

/**
 * 把源文件开到左栏。
 *
 * 复用优先（D9「不强制重建、不抢已有位置」）：
 * 只要该文件已经可见就**什么都不做** —— 用户可能已经把它拖到别的栏位、
 * 或正在里面编辑，强行 `showTextDocument` 会把它拽回左栏并打断操作。
 *
 * @param file 源文件绝对路径；`undefined` 表示拿不到路径（比赛目录未建立）
 */
export async function openSourceInLeftColumn(
  file: string | undefined,
  exists: boolean,
  deps: OpenSourceDeps,
): Promise<OpenSourceOutcome> {
  if (!file || !exists) { return 'missing'; }
  if (deps.visibleFilePaths().includes(file)) { return 'reused'; }
  await deps.openAndReveal(file);
  return 'opened';
}
