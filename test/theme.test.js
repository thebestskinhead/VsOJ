// 亮色主题约束 —— 扩展自绘的每个页面都必须固定亮色，不跟随编辑器配色
// 运行：node test/theme.test.js
//
// 为什么值得测：webview 里一旦用了 `--vscode-*` 主题变量，用户把 VS Code 切到
// 深色主题后题目页就变成黑底浅字 —— 而题面 HTML 本身来自站点（浅色），混着看很难受。
// 这类回归在浅色主题下肉眼完全看不出来，所以用断言钉死：
//   1) 源码里不许出现任何 `--vscode-*` 主题变量；
//   2) 每个内联页面（`<!DOCTYPE html>` 字面量）都必须声明 `color-scheme: light`；
//   3) 运行时真产出的题目页必须白底深字。
const fs = require('fs');
const path = require('path');
const { installVscodeStub, makeChecker, makeAccessGate } = require('./helpers/stub');

// 必须在 require 业务模块之前装桩（problem.ts → api/client.ts → utils/config.ts 会 import vscode）
installVscodeStub();
const { ProblemService } = require('../out/api/problem.js');

const { check, ok, done } = makeChecker();
const root = path.dirname(__dirname);

/** 收集 src 下所有 ts 源文件路径 */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { collect(p, out); }
    else if (e.name.endsWith('.ts')) { out.push(p); }
  }
  return out;
}

const count = (text, needle) => text.split(needle).length - 1;

// ── 1. 运行时产物：题目详情页 ───────────────────────────────────────────────
console.log('[1] 题目详情页（buildProblemHtml 真产出）');
const svc = new ProblemService(makeAccessGate().gate);
const detail = {
  cid: '3775', pid: '0', title: 'A + B Problem',
  description: '<p>求两数之和。</p>', inputDesc: '两个整数 a b',
  outputDesc: '一个整数', sampleInput: '1 2', sampleOutput: '3',
};
const page = svc.buildProblemHtml(detail, { banner: '本地缓存 · 更新于 1 分钟前', enableRefresh: true });

ok('声明 color-scheme: light', /color-scheme:\s*light/.test(page));
ok('不含 --vscode- 主题变量', !page.includes('--vscode-'));
ok('body 硬编码白底', /body\s*\{[^}]*background:\s*#fff/.test(page));
ok('body 硬编码深字', /body\s*\{[^}]*color:\s*#333/.test(page));

// 信息栏区域不得残留主题色（原先 .oj-bar / button 全靠 --vscode-*）
const barCss = (page.match(/\.oj-bar[\s\S]*?(?=@keyframes)/) || [''])[0];
ok('信息栏区域不含主题变量', !barCss.includes('--vscode-'));
ok('信息栏区域有固定配色', barCss.includes('#f7f7f7') && barCss.includes('#333'));

// ── 2. 静态扫描：整个 src 不许再引用主题变量 ───────────────────────────────
console.log('\n[2] 源码扫描：不得引用编辑器主题变量');
const files = collect(path.join(root, 'src'));
const sources = files.map(f => ({ f, rel: path.relative(root, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));

const themed = sources.filter(s => s.text.includes('--vscode-')).map(s => s.rel);
check('引用 --vscode-* 的文件', themed, []);

// ── 3. 每个内联页面都要自带亮色声明 ────────────────────────────────────────
console.log('\n[3] 内联页面：DOCTYPE 与 color-scheme 一一对应');
const pages = sources
  .map(s => ({ rel: s.rel, docs: count(s.text, '<!DOCTYPE html>'), cs: count(s.text, 'color-scheme'), white: s.text.includes('#fff') }))
  .filter(p => p.docs > 0);

// 题目页 / 登录页 / 账号页 / 提交页 / 本地测试结果页 / 提交结果页 / 工具链配置页 /
// 题目页的加载中与失败兜底、被闸门拒答时的登录提示页 …
check('含内联页面的文件数', pages.length, 8);
check('内联页面总数', pages.reduce((a, p) => a + p.docs, 0), 11);
check('每个页面都有 color-scheme', pages.filter(p => p.cs !== p.docs).map(p => `${p.rel}(${p.docs}/${p.cs})`), []);
check('每个页面都指定了白底', pages.filter(p => !p.white).map(p => p.rel), []);

const okAll = done();
process.exit(okAll ? 0 : 1);
