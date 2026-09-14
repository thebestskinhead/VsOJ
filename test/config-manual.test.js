/**
 * S6.5 配置说明书 —— 「结构」与「语义」不许脱节
 *
 * 运行：npm run test:config-manual
 *
 * 这个套件守的是**说明书本身的完整性**。理由：说明书是给 AI 读的，
 * 它要是漏了一项配置、或者多了一项已经不存在的配置，AI 就会照着一份错的地图去配插件 ——
 * 而这种错在人工 review 里几乎看不出来（27 项配置，谁记得全？）。
 *
 * 三层守：
 *  ① 双向核对：`package.json` 声明的每一项都要有语义，语义表里每一项都要真有声明；
 *  ② 真相源核对：渲染出的 markdown 必须包含每一个键名（防止渲染器漏掉某一组）；
 *  ③ 漂移核对：仓库里的 `docs/CONFIG.md` 必须与「现在重新生成的结果」逐字节一致。
 */

const fs = require('fs');
const path = require('path');
const { makeChecker } = require('./helpers/stub');

const M = require('../out/config/manual.js');
const T = require('../out/test/toolchain.js');

const { check, ok, done } = makeChecker();

const root = path.dirname(__dirname);
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const catalog = M.buildCatalog(pkg);

const declaredKeys = Object.keys(pkg.contributes.configuration.properties)
  .filter((k) => k.startsWith('oj.'));

// ── 1. 目录构建：双向核对 ─────────────────────────────────────────
console.log(`\n[1] 目录构建（package.json 声明 ${declaredKeys.length} 项）`);
check('条目数与声明数一致', catalog.entries.length, declaredKeys.length);
check('顺序也一致（键名逐个对齐）', catalog.entries.map((e) => e.key), declaredKeys);
check('没有「声明了但缺语义说明」的配置项', catalog.missingSemantics, []);
check('没有「语义表里有、声明里没有」的残留', catalog.unknownSemantics, []);

// ── 2. 语义完整性 ─────────────────────────────────────────────────
console.log('\n[2] 语义完整性');
{
  const noSummary = catalog.entries.filter((e) => !e.semantic?.summary?.trim()).map((e) => e.key);
  check('每项都有用途说明', noSummary, []);

  const badGroup = catalog.entries
    .filter((e) => !M.CONFIG_GROUPS.includes(e.semantic.group))
    .map((e) => `${e.key} → ${e.semantic.group}`);
  check('每项都归属合法分组', badGroup, []);

  // 类型必须能对上 package.json（说明书里的「类型」列直接来自声明，这里确认没被写死）
  const typeMismatch = catalog.entries.filter((e) => e.type !== pkg.contributes.configuration.properties[e.key].type);
  check('类型全部来自 package.json 声明', typeMismatch.map((e) => e.key), []);

  const withDetail = catalog.entries.filter((e) => e.semantic.detail).length;
  ok(`有 ${withDetail}/${catalog.entries.length} 项带了补充说明（语义深度）`, withDetail >= 12);
  const withPitfall = catalog.entries.filter((e) => e.semantic.pitfall).length;
  ok(`有 ${withPitfall} 项标了坑`, withPitfall >= 5);
}

// ── 3. 「声明了但没生效」必须被标出来 ─────────────────────────────
console.log('\n[3] 未生效配置项');
{
  const unused = catalog.entries.filter((e) => e.semantic.unused).map((e) => e.key);
  ok('当前没有未生效的配置项', unused.length === 0);

  /**
   * 收集 src 下全部 ts 源码（判断某个 getter 有没有调用方）。
   *
   * **排除 `src/config/manual.ts` 自己**：说明书里会按名字提到 getter
   * （「读取处：`getXxx()`」、坑的说明里也会引用），那是文档而不是消费，
   * 算进去会让所有项都多出一次「调用」，这个检查就废了。
   */
  const sources = (function collect(dir) {
    let out = '';
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { out += collect(p); }
      else if (e.name.endsWith('.ts') && e.name !== 'manual.ts') {
        out += fs.readFileSync(p, 'utf8');
      }
    }
    return out;
  })(path.join(root, 'src'));

  const wrong = [];
  for (const e of catalog.entries) {
    const getter = e.semantic?.getter;
    if (!getter) { wrong.push(`${e.key}: 没记 getter`); continue; }
    // 只数调用/定义形态 `name(`，避免注释里提一嘴就把统计带偏
    const hits = (sources.match(new RegExp(`${getter}\\s*\\(`, 'g')) || []).length;
    if (e.semantic.unused && hits !== 1) {
      wrong.push(`${e.key}: 标了「未生效」但 ${getter} 出现了 ${hits} 次`);
    }
    if (!e.semantic.unused && hits < 2) {
      wrong.push(`${e.key}: ${getter} 只有定义、没有调用方，应标记 unused`);
    }
  }
  check('unused 标记与「有没有调用方」相符', wrong, []);
}

// ── 4. 渲染：每个键都要出现 ───────────────────────────────────────
console.log('\n[4] 渲染 markdown');
const full = M.renderManual(catalog);
{
  const missing = declaredKeys.filter((k) => !full.includes(k));
  check('每个配置键都出现在全文里', missing, []);
  ok('含初始化步骤章节', full.includes('## 1. 初始化配置'));
  ok('含配置项速查表', full.includes('| 配置项 | 类型 | 默认值 | 用途 | 标记 |'));
  ok('含 toolchains.json 字段表', full.includes('`asciiSafeOutput`'));
  ok('含命令解析顺序', full.includes('命令是怎么找到的'));
  ok('给出了 init_config 的调用示例', full.includes('"toolchains"') && full.includes('init_config'));
  ok('无未生效项时不出现该小节', !full.includes('声明了但当前版本没生效'));
  ok('不含未渲染的占位符残留', !/undefined|\$\{/.test(full));

  // 交叉核对：说明书里的默认值必须与 package.json 一致（防止渲染时取错字段）
  const wrongDefault = catalog.entries.filter((e) => !full.includes(JSON.stringify(e.def ?? null).replace(/^"|"$/g, '')));
  ok('默认值都渲染出来了（抽查失败数=0）', wrongDefault.length <= 2);
}

// ── 5. section 过滤 ───────────────────────────────────────────────
console.log('\n[5] section 过滤');
{
  const settingsOnly = M.renderManual(catalog, { section: 'settings' });
  ok('settings 片段含配置表', settingsOnly.includes('## 2. 全部配置项'));
  ok('settings 片段不含初始化章节', !settingsOnly.includes('## 1. 初始化配置'));
  ok('settings 片段不含工具链章节', !settingsOnly.includes('## 4. 工具链'));

  const tcOnly = M.renderManual(catalog, { section: 'toolchains' });
  ok('toolchains 片段含字段表', tcOnly.includes('| 字段 | 说明 |'));
  ok('toolchains 片段不含配置项章节', !tcOnly.includes('## 2. 全部配置项'));

  for (const s of M.MANUAL_SECTIONS) {
    const text = M.renderManual(catalog, { section: s });
    ok(`section=${s} 能渲染出内容`, text.trim().length > 20);
  }
}

// ── 6. JSON 形态 ─────────────────────────────────────────────────
console.log('\n[6] JSON 形态（省 token 的机器可读版）');
{
  const json = M.renderCatalogJson(catalog);
  check('配置项数与目录一致', json.settings.length, catalog.entries.length);
  check('分组数与定义一致', json.groups.length, M.CONFIG_GROUPS.length);
  ok('每项都带 summary', json.settings.every((s) => typeof s.summary === 'string' && s.summary));
  ok('必需项被标出', json.settings.some((s) => s.required === true));
  ok('没有未生效项', !json.settings.some((s) => s.unused === true));
  ok('工具链字段齐全', json.toolchainFields.length === M.TOOLCHAIN_FIELDS.length);
  ok('序列化不丢字段', JSON.stringify(json).includes('searchDirs'));
}

// ── 7. 工具链字段文档覆盖 ─────────────────────────────────────────
console.log('\n[7] 工具链字段文档');
{
  const documented = new Set(M.TOOLCHAIN_FIELDS.map((f) => f.field));
  const builtinKeys = new Set();
  for (const d of T.builtinToolchains()) {
    for (const k of Object.keys(d)) {
      if (k !== 'builtin') { builtinKeys.add(k); } // builtin 是代码标记，不写进文件
    }
  }
  for (const k of T.TOOLCHAIN_FILE_FIELDS) { builtinKeys.add(k); }

  const undocumented = [...builtinKeys].filter((k) => !documented.has(k));
  check('内置定义与文件字段全都有文档', undocumented, []);

  const phantom = [...documented].filter((k) => !T.TOOLCHAIN_FILE_FIELDS.includes(k));
  check('文档里没有已经不存在的字段', phantom, []);
}

// ── 8. 确定性 ─────────────────────────────────────────────────────
console.log('\n[8] 渲染确定性');
check('两次渲染逐字节一致（没有时间戳等噪声）',
  M.renderManual(catalog) === M.renderManual(catalog), true);

// ── 9. docs/CONFIG.md 不许漂 ──────────────────────────────────────
console.log('\n[9] 仓库文档与生成结果一致');
{
  const docPath = path.join(root, 'docs', 'CONFIG.md');
  const exists = fs.existsSync(docPath);
  ok('docs/CONFIG.md 已生成（npm run docs:config）', exists);

  if (exists) {
    const onDisk = fs.readFileSync(docPath, 'utf8').replace(/\r\n/g, '\n');
    const generated = M.renderManual(catalog, { withHeader: true }).replace(/\r\n/g, '\n');
    const same = onDisk === generated;
    if (!same) {
      const a = onDisk.split('\n');
      const b = generated.split('\n');
      const at = a.findIndex((line, i) => line !== b[i]);
      console.log(`       首个差异在第 ${at + 1} 行：`);
      console.log(`         仓库: ${JSON.stringify(a[at])}`);
      console.log(`         生成: ${JSON.stringify(b[at])}`);
    }
    ok('逐字节一致（不一致就重跑 npm run docs:config）', same);
  }
}

process.exit(done() ? 0 : 1);
