// 配置项一致性 —— package.json 里声明的每个 oj.* 键都必须真的被代码读到
// 运行：node test/config-consistency.test.js
//
// 为什么值得测：声明了却没人读的配置项，用户在设置面板改半天毫无反应；
// 而代码里读了却没声明的键，改起来只能手写 JSON。两类都是真实踩过的坑。
const fs = require('fs');
const path = require('path');
const { makeChecker } = require('./helpers/stub');

const { check, ok, done } = makeChecker();

const root = path.dirname(__dirname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * 收集 src 下所有 ts 源码（拼成一份大文本，够用且快）。
 *
 * **排除 `src/config/manual.ts`**：那是配置说明书的语义表，里面每个配置项都以
 * 引号键名出现（`'test.timeoutMs': { ... }`）。算进来的话，「声明了但没人读」这条
 * 会对**所有**配置项假通过 —— 检查就废了。说明书不是消费方。
 */
function collectSources(dir) {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out += collectSources(p); }
    else if (e.name.endsWith('.ts') && e.name !== 'manual.ts') {
      out += fs.readFileSync(p, 'utf8');
    }
  }
  return out;
}

const sources = collectSources(path.join(root, 'src'));

/** package.json 里的全部 oj.* 配置键（去掉 `oj.` 前缀，因为代码里读的是子键名） */
const declared = Object.keys(pkg.contributes.configuration.properties || {})
  .filter(k => k.startsWith('oj.'))
  .map(k => k.slice(3));

const unread = declared.filter(key => !sources.includes(`'${key}'`) && !sources.includes(`"${key}"`));

console.log(`[1] 声明 -> 读取（共 ${declared.length} 个配置项）`);
check('存在配置声明', declared.length > 0, true);
check('无「声明了但没人读」的配置项', unread, []);

console.log('\n[2] 命令声明 -> 实现（共 '
  + (pkg.contributes.commands || []).length + ' 个命令）');
{
  const commands = (pkg.contributes.commands || []).map(c => c.command);
  const unimplemented = commands.filter(
    c => !sources.includes(`registerCommand('${c}'`) && !sources.includes(`registerCommand("${c}"`),
  );
  // `vscode.openFolder` 之类的内建命令不在本仓库实现，这里只检查 oj.* 前缀
  check('无「声明了但没注册」的 oj 命令',
    unimplemented.filter(c => c.startsWith('oj.')), []);
}

console.log('\n[3] 菜单指向 -> 命令声明');
{
  const menus = pkg.contributes.menus || {};
  const commands = new Set((pkg.contributes.commands || []).map(c => c.command));
  const dangling = [];
  for (const [where, list] of Object.entries(menus)) {
    for (const m of list) {
      if (m.command.startsWith('oj.') && !commands.has(m.command)) {
        dangling.push(`${where}: ${m.command}`);
      }
    }
  }
  check('无悬空菜单项', dangling, []);
}

console.log('\n[4] 视图标识一致');
{
  const views = (pkg.contributes.views || {})['oj-sidebar'] || [];
  const viewIds = views.map(v => v.id);
  ok('声明了 oj.problems 视图', viewIds.includes('oj.problems'));
  ok('声明了 oj.contests 视图', viewIds.includes('oj.contests'));
  // 菜单 when 里出现的视图 id 必须是真实存在的视图
  const menus = JSON.stringify(pkg.contributes.menus || {});
  const referenced = [...menus.matchAll(/view == (oj\.[a-zA-Z.]+)/g)].map(m => m[1]);
  const unknown = [...new Set(referenced)].filter(v => !viewIds.includes(v));
  check('菜单引用的视图都存在', unknown, []);
}

console.log('\n[5] S5 关键配置项的默认值');
{
  const props = pkg.contributes.configuration.properties;
  check('oj.project.enabled 默认开', props['oj.project.enabled'].default, true);
  check('oj.project.lazyInit 默认开（D14）', props['oj.project.lazyInit'].default, true);
  check('oj.project.initEntryVisible 默认开（D2）', props['oj.project.initEntryVisible'].default, true);
  check('源文件名默认 main.cpp（D8）', props['oj.project.sourceFileName'].default, 'main.cpp');
}

console.log('\n[6] MCP 工具声明 -> 分发');
{
  const toolSrc = fs.readFileSync(path.join(root, 'src', 'mcp', 'tools.ts'), 'utf8');
  const names = [...toolSrc.matchAll(/^\s{4}name: '([a-z_]+)',/gm)].map(m => m[1]);
  ok('至少注册了几个工具', names.length >= 3);
  const undispatched = names.filter(n => !toolSrc.includes(`case '${n}':`));
  check('无「注册了但没分发」的工具', undispatched, []);
  ok('配置说明书工具在', names.includes('get_config_manual'));
  ok('初始化配置工具在', names.includes('init_config'));

  // 这两个工具的声明必须真的被接线（否则 AI 调了会说「不可用」）
  const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  ok('extension 里真的构造了配置服务', /buildConfigToolService\s*\(/.test(extSrc));
}

process.exit(done() ? 0 : 1);
