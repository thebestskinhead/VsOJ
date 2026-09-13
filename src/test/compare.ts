/**
 * 【本地测试 · 输出比较】
 *
 * 判定口径（用户决策 D15）：**严格逐字节**。但不是「原始字节直比」——
 * 中间必须夹一道换行归一化，理由见下。
 *
 * ## 为什么必须归一化换行（实测，不是猜测）
 *
 * Windows 上 C 运行时把 stdout 的 `\n` 转成 `\r\n`：实测 `printf("3\n")` 落到文件是
 * `3\r\n`，连 Node 的 `stdio: [in, outFd, errFd]` 重定向也一样。而站点样例是 Linux 判题的
 * 语义（`\n`）。所以**不归一化的话，正确代码也会 100% 全 WA**。
 *
 * 归一化 ≠ 放宽口径：它是在**模拟线上判题环境**。归一化之后仍然逐字节比，
 * 多余空格、少一个换行、中文全角半角，一个字节都不放过。
 *
 * 归一化只处理**成对**的 `\r\n → \n`，孤立 `\r`（比如进度条）保持原样 —— 那确实是差异。
 *
 * ## 产物约定（决策 D6）
 *
 * - `temp/N.raw.out`：程序吐出的**原始字节**（留着，可自证没篡改程序行为）
 * - `temp/N.out`    ：归一化后的**副本**，比较与展示都用它
 *
 * 本模块不依赖 VS Code，可直接单测。
 */

import * as fs from 'fs';

/** 把 `\r\n` 归一化为 `\n`（孤立 `\r` 不动） */
export function normalizeNewlines(buf: Buffer): Buffer {
  if (buf.length === 0) { return buf; }
  // 快路径：没有 \r 就原样返回，避免大文件白拷一份
  if (buf.indexOf(0x0d) < 0) { return buf; }
  const out = Buffer.allocUnsafe(buf.length);
  let w = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) { continue; }
    out[w++] = b;
  }
  return out.subarray(0, w);
}

/** 首个差异的位置信息 */
export interface FirstDiff {
  /** 归一化后的字节偏移（0 起） */
  offset: number;
  /** 行号（1 起，按 `\n` 分割） */
  line: number;
  /** 该行内第几个字节（1 起） */
  byteColumn: number;
  /** 期望侧该偏移的字节；`null` = 期望到此为止（实际更长） */
  expectedByte: number | null;
  /** 实际侧该偏移的字节；`null` = 实际到此为止（期望更长） */
  actualByte: number | null;
}

export interface CompareResult {
  equal: boolean;
  expectedBytes: number;
  actualBytes: number;
  /** 长度是否不同（两者可以同时是「长度不同」与「字节不同」） */
  lengthMismatch: boolean;
  firstDiff?: FirstDiff;
}

/**
 * 逐字节比较（调用方应保证两侧都已归一化）。
 *
 * 性能取向：先走 `Buffer.equals`，相同就直接返回；不同才定位首个差异 ——
 * 绝大多数用例是通过的，不该为「通过」付出逐字节扫描的成本。
 */
export function compareBytes(expected: Buffer, actual: Buffer): CompareResult {
  const base = {
    expectedBytes: expected.length,
    actualBytes: actual.length,
    lengthMismatch: expected.length !== actual.length,
  };

  if (expected.length === actual.length && Buffer.compare(expected, actual) === 0) {
    return { equal: true, ...base, lengthMismatch: false };
  }

  const min = Math.min(expected.length, actual.length);
  let offset = -1;
  for (let i = 0; i < min; i++) {
    if (expected[i] !== actual[i]) { offset = i; break; }
  }
  // 前缀全同 → 差异就是「长度」，位置落在较短者的末尾
  if (offset < 0) { offset = min; }

  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < Math.min(offset, expected.length); i++) {
    if (expected[i] === 0x0a) { line += 1; lineStart = i + 1; }
  }

  return {
    equal: false,
    ...base,
    firstDiff: {
      offset,
      line,
      byteColumn: offset - lineStart + 1,
      expectedByte: offset < expected.length ? expected[offset] : null,
      actualByte: offset < actual.length ? actual[offset] : null,
    },
  };
}

/** 取某一行（1 起）的文本，去掉行尾换行；越界返回空串 */
export function lineAt(buf: Buffer, line: number): string {
  if (line < 1) { return ''; }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  return (lines[line - 1] ?? '').replace(/\r$/, '');
}

/** 展示用预览：超长截断并标注（报告里绝不能塞进 64MB 的输出） */
export function preview(buf: Buffer, maxBytes = 4096): { text: string; truncated: boolean } {
  if (buf.length <= maxBytes) { return { text: buf.toString('utf8'), truncated: false }; }
  return {
    text: buf.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

/** 可打印化单个字节，用于报告文案（如 `3 (0x33)`、`\n (0x0A)`） */
export function describeByte(b: number | null): string {
  if (b === null) { return '（无，此处已到末尾）'; }
  if (b === 0x0a) { return '\\n (0x0A)'; }
  if (b === 0x0d) { return '\\r (0x0D)'; }
  if (b === 0x20) { return '空格 (0x20)'; }
  if (b === 0x09) { return '\\t (0x09)'; }
  const ch = (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '';
  return ch ? `${ch} (0x${b.toString(16).toUpperCase().padStart(2, '0')})` : `0x${b.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** 一行人类可读的差异摘要（报告与结果页二级页共用） */
export function describeDiff(result: CompareResult): string {
  if (result.equal) { return '输出与期望完全一致'; }
  const d = result.firstDiff!;
  const parts = [
    `首个差异：第 ${d.line} 行第 ${d.byteColumn} 个字节（偏移 ${d.offset}）`,
    `期望 ${describeByte(d.expectedByte)}，实际 ${describeByte(d.actualByte)}`,
  ];
  if (result.lengthMismatch) {
    parts.push(`长度不等：期望 ${result.expectedBytes} 字节，实际 ${result.actualBytes} 字节`);
  }
  return parts.join(' · ');
}

/**
 * 读原始输出 → 写归一化副本（决策 D6）。
 *
 * 「原始留着、副本拿来比」的两份产物就是这个函数落地的：
 * 用户想核对程序真实吐出的字节时看 `.raw.out`，比较与展示一律用归一化后的 `.out`。
 */
export function writeNormalizedCopy(rawFile: string, normalizedFile: string): { rawBytes: number; normalizedBytes: number } {
  const raw = fs.readFileSync(rawFile);
  const norm = normalizeNewlines(raw);
  fs.writeFileSync(normalizedFile, norm);
  return { rawBytes: raw.length, normalizedBytes: norm.length };
}

/** 直接比较两个文件（都已按需归一化） */
export function compareFiles(expectedFile: string, actualFile: string): CompareResult {
  const expected = normalizeNewlines(fs.readFileSync(expectedFile));
  const actual = normalizeNewlines(fs.readFileSync(actualFile));
  return compareBytes(expected, actual);
}
