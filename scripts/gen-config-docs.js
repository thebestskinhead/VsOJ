/**
 * 生成 docs/CONFIG.md —— 仓库里那份「随插件发布的配置说明书」。
 *
 * 运行：npm run docs:config
 *
 * 为什么要生成而不是手写：这份文档是**给 AI 读的**，漏一项配置或者写着一个
 * 已经不存在的键，AI 就会照着错的地图去配插件。生成的好处是结构部分直接取自
 * `package.json`，加一项配置就自动多一行；而 `test/config-manual.test.js`
 * 会断言「磁盘上的文件 == 现在生成的结果」，于是它也不可能偷偷过期。
 *
 * 与 MCP 工具 `get_config_manual` 的返回值同源（都走 `renderManual`），
 * 所以「文档说的」与「工具返回的」永远一致。
 */

const fs = require('fs');
const path = require('path');

const M = require('../out/config/manual.js');

const root = path.dirname(__dirname);
const pkgPath = path.join(root, 'package.json');
const outPath = path.join(root, 'docs', 'CONFIG.md');

const catalog = M.buildCatalogFromFile(pkgPath);

if (catalog.missingSemantics.length) {
  console.error('❌ 以下配置项缺少语义说明，说明书会漏信息：');
  for (const k of catalog.missingSemantics) { console.error(`   - ${k}`); }
  console.error('   请到 src/config/manual.ts 的 CONFIG_SEMANTICS 补上。');
  process.exit(1);
}
if (catalog.unknownSemantics.length) {
  console.error('❌ 以下语义条目已无对应配置声明（残留）：');
  for (const k of catalog.unknownSemantics) { console.error(`   - ${k}`); }
  process.exit(1);
}

const text = M.renderManual(catalog, { withHeader: true });

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, text, 'utf8');

console.log(`✅ 已生成 ${path.relative(root, outPath)}`);
console.log(`   配置项 ${catalog.entries.length} 项 · 分组 ${M.CONFIG_GROUPS.length} 个 · ${text.length} 字符`);
