// 输出比较（test/compare.ts）—— 换行归一化 + 严格逐字节 + 差异定位
// 运行：node test/compare.test.js
//
// 为什么值得测：判定口径是「严格逐字节」，但只要归一化漏一处（比如把孤立 \r 也吃掉），
// 就会把真实的格式错误判成通过；反过来归一化没做，正确代码会 100% 全 WA。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeChecker } = require('./helpers/stub');
const C = require('../out/test/compare.js');

const { check, ok, done } = makeChecker();
const B = (s) => Buffer.from(s, 'utf8');
const hex = (buf) => buf.toString('hex');

// ── 1. 换行归一化 ─────────────────────────────────────────────────────────
console.log('[1] normalizeNewlines');
check('纯 LF 原样（快路径直接返回同一对象）', C.normalizeNewlines(B('3\n')) === C.normalizeNewlines(B('3\n')), false);
check('纯 LF 内容不变', hex(C.normalizeNewlines(B('a\nb\n'))), hex(B('a\nb\n')));
check('CRLF → LF', hex(C.normalizeNewlines(B('a\r\nb\r\n'))), hex(B('a\nb\n')));
check('混合行尾', hex(C.normalizeNewlines(B('a\r\nb\nc\rd'))), hex(B('a\nb\nc\rd')));
check('孤立 CR 保留（进度条那种）', hex(C.normalizeNewlines(B('50%\r60%\r'))), hex(B('50%\r60%\r')));
check('\\r\\r\\n：只吃紧邻的那个', hex(C.normalizeNewlines(B('a\r\r\n'))), hex(B('a\r\n')));
check('末尾裸 CR 保留', hex(C.normalizeNewlines(B('a\r'))), hex(B('a\r')));
check('空 buffer', hex(C.normalizeNewlines(B(''))), '');
check('二进制内容不炸', hex(C.normalizeNewlines(Buffer.from([0, 0x0d, 0x0a, 0xff]))), '000aff');
check('内容正确时长度按期望缩短', C.normalizeNewlines(B('a\r\n')).length, 2);

// ── 2. 严格逐字节比较 ─────────────────────────────────────────────────────
console.log('\n[2] compareBytes');
let r = C.compareBytes(B('3\n'), B('3\n'));
check('完全相同 → 通过', r.equal, true);
check('通过时不带 firstDiff', r.firstDiff, undefined);

r = C.compareBytes(B('3\n'), B('4\n'));
check('同长度不同字节 → 不通过', r.equal, false);
check('长度标记保持一致', r.lengthMismatch, false);
check('差异定位到第 1 行第 1 字节', [r.firstDiff.line, r.firstDiff.byteColumn, r.firstDiff.offset], [1, 1, 0]);
check('给出两侧字节', [r.firstDiff.expectedByte, r.firstDiff.actualByte].map(b => String.fromCharCode(b)), ['3', '4']);

r = C.compareBytes(B('1 2\n'), B('1 2 \n'));
check('行尾多一个空格 → 不通过（严格口径）', r.equal, false);
check('差异定位到第 1 行第 4 字节', [r.firstDiff.line, r.firstDiff.byteColumn], [1, 4]);
check('期望侧此处是换行', C.describeByte(r.firstDiff.expectedByte), '\\n (0x0A)');

r = C.compareBytes(B('a\n'), B('a\nb\n'));
check('实际更长 → 不通过', r.equal, false);
check('长度不等已标记', r.lengthMismatch, true);
check('差异落在期望末尾（期望侧为 null）', r.firstDiff.expectedByte, null);

r = C.compareBytes(B('a\nb\n'), B('a\n'));
check('实际更短 → 期望侧有字节、实际侧为 null', [r.firstDiff.expectedByte, r.firstDiff.actualByte].map(v => v !== null), [true, false]);

r = C.compareBytes(B('l1\nl2\nl3\n'), B('l1\nl2\nX3\n'));
check('多行文件定位到第 3 行', r.firstDiff.line, 3);
check('列号从该行头算起', r.firstDiff.byteColumn, 1);

r = C.compareBytes(B('ab\ncd\n'), B('ab\ncX\n'));
check('第 2 行第 2 字节', [r.firstDiff.line, r.firstDiff.byteColumn], [2, 2]);

r = C.compareBytes(B(''), B(''));
check('双空 → 通过', r.equal, true);
r = C.compareBytes(B(''), B('3\n'));
check('空期望 vs 有输出 → 不通过', r.equal, false);
check('差异从偏移 0 开始', r.firstDiff.offset, 0);

// ── 3. 归一化 + 比较的联合语义（决策 D15 的核心用例） ──────────────────────
console.log('\n[3] Windows 程序的 CRLF 输出 vs 站点样例的 LF');
const siteSample = B('3\nhello\n');           // 站点样例（Linux 判题语义）
const winOutput = B('3\r\nhello\r\n');        // 本机程序实际吐出（实测）
check('不归一化会误判为不通过', C.compareBytes(siteSample, winOutput).equal, false);
check('归一化后判为通过',
  C.compareBytes(C.normalizeNewlines(siteSample), C.normalizeNewlines(winOutput)).equal, true);
check('归一化后仍能抓出真实差异',
  C.compareBytes(C.normalizeNewlines(siteSample), C.normalizeNewlines(B('3\r\nHELLO\r\n'))).equal, false);

// ── 4. 文本工具 ───────────────────────────────────────────────────────────
console.log('\n[4] 行提取 / 预览 / 文案');
check('lineAt 取第 2 行', C.lineAt(B('aa\nbb\ncc\n'), 2), 'bb');
check('lineAt 去掉行尾 CR', C.lineAt(B('aa\r\nbb\r\n'), 2), 'bb');
check('lineAt 越界返回空', C.lineAt(B('aa\n'), 9), '');
check('preview 短内容不截断', C.preview(B('abc'), 10), { text: 'abc', truncated: false });
const big = C.preview(B('x'.repeat(100)), 10);
check('preview 超长截断并标注', [big.text.length, big.truncated], [10, true]);
check('describeByte 可打印字符', C.describeByte(0x33), '3 (0x33)');
check('describeByte 空格', C.describeByte(0x20), '空格 (0x20)');
check('describeByte 不可打印', C.describeByte(0x00), '0x00');
check('describeByte null', C.describeByte(null), '（无，此处已到末尾）');
ok('describeDiff 含行号与两侧字节', /第 1 行第 1 个字节/.test(C.describeDiff(C.compareBytes(B('3'), B('4')))));
check('describeDiff 通过时直说', C.describeDiff(C.compareBytes(B('3'), B('3'))), '输出与期望完全一致');

// ── 5. 文件层：原始保留 + 归一化副本 ──────────────────────────────────────
console.log('\n[5] writeNormalizedCopy / compareFiles');
const dir = path.join(os.tmpdir(), `vsoj-compare-${process.pid}`);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const rawFile = path.join(dir, '1.raw.out');
const normFile = path.join(dir, '1.out');
const expFile = path.join(dir, '1.expected.out');
fs.writeFileSync(rawFile, Buffer.from('3\r\nhello\r\n'));
fs.writeFileSync(expFile, Buffer.from('3\nhello\n'));

const sizes = C.writeNormalizedCopy(rawFile, normFile);
check('原始字节数', sizes.rawBytes, 10);
check('归一化后字节数', sizes.normalizedBytes, 8);
check('原始文件一个字节没动（契约 C7）', hex(fs.readFileSync(rawFile)), hex(Buffer.from('3\r\nhello\r\n')));
check('副本是 LF', hex(fs.readFileSync(normFile)), hex(Buffer.from('3\nhello\n')));
check('副本 vs 站点样例 → 通过', C.compareFiles(expFile, normFile).equal, true);

fs.writeFileSync(expFile, Buffer.from('3\nHELLO\n'));
const bad = C.compareFiles(expFile, normFile);
check('副本 vs 不同期望 → 不通过且在正确位置', [bad.equal, bad.firstDiff.line, bad.firstDiff.byteColumn], [false, 2, 1]);

fs.rmSync(dir, { recursive: true, force: true });
process.exit(done() ? 0 : 1);
