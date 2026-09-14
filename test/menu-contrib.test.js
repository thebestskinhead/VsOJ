// 菜单贡献点一致性 —— package.json 里 menus / submenus / views 之间必须自洽
// 运行：node test/menu-contrib.test.js
//
// 为什么值得测：菜单是个「沉默」的地方。引用了不存在的命令，VS Code 不会报错，
// 只是那一项**永远不显示**；`when` 里写了拼错的视图 id，按钮整个消失。
// 这类问题在打包安装后才发现，本地却毫无提示 —— 所以在这里把引用关系全查一遍。
const fs = require('fs');
const path = require('path');
const { makeChecker } = require('./helpers/stub');

const { check, ok, done } = makeChecker();

const root = path.dirname(__dirname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const menus = pkg.contributes.menus || {};
const submenus = pkg.contributes.submenus || [];
const commands = (pkg.contributes.commands || []).map((c) => c.command);
const views = Object.values(pkg.contributes.views || {}).flat().map((v) => v.id);

/** 摊平所有菜单区里的项（含 submenu 自己的菜单区） */
const allItems = Object.entries(menus).flatMap(([where, items]) => (items || []).map((it) => ({ where, ...it })));

console.log(`[1] 命令引用（菜单区 ${Object.keys(menus).length} 个，菜单项 ${allItems.length} 条）`);
check('存在命令声明', commands.length > 0, true);
check('存在菜单项', allItems.length > 0, true);

const cmdItems = allItems.filter((it) => it.command);
const undeclared = [...new Set(cmdItems.map((it) => it.command))].filter((c) => !commands.includes(c));
check('菜单引用的命令都已声明', undeclared, []);

const kb = (pkg.contributes.keybindings || []).map((k) => k.command);
const kbUndeclared = [...new Set(kb)].filter((c) => !commands.includes(c));
check('快捷键引用的命令都已声明', kbUndeclared, []);

console.log('\n[2] 下拉子菜单');
const subIds = submenus.map((s) => s.id);
check('id 不重复', subIds.length, new Set(subIds).size);

const refs = allItems.filter((it) => it.submenu).map((it) => it.submenu);
const badRefs = refs.filter((r) => !subIds.includes(r));
check('每个 submenu 引用都有定义', badRefs, []);

const deadSubs = subIds.filter((id) => !refs.includes(id));
check('没有「定义了却没人挂」的下拉', deadSubs, []);

const badLabel = submenus.filter((s) => !s.label || typeof s.label !== 'string');
check('每个下拉都有标签', badLabel.map((s) => s.id), []);

const badIcon = submenus.filter((s) => !/^\$\([a-z0-9-]+\)$/.test(s.icon || ''));
check('下拉图标是 codicon 写法', badIcon.map((s) => s.id), []);

const badArea = subIds.filter((id) => !Array.isArray(menus[id]) || menus[id].length === 0);
check('每个下拉都有菜单项', badArea, []);

console.log('\n[3] 视图 id 与挂载位置');
const viewRefs = [...new Set(allItems.map((it) => (it.when || '').match(/view == (\S+)/)?.[1]).filter(Boolean))];
const badViews = viewRefs.filter((v) => !views.includes(v));
check('when 里的视图 id 都存在', badViews, []);
ok('至少覆盖两个视图', viewRefs.length >= 2);

const titleSub = (menus['view/title'] || []).find((it) => it.submenu);
ok('下拉挂在 view/title 上', !!titleSub);
check('下拉挂的视图', titleSub && titleSub.when, 'view == oj.problems');
ok('下拉带排序位（排在标题栏按钮最前）', /navigation@0$/.test((titleSub && titleSub.group) || ''));

console.log('\n[4] 下拉内容');
const menu = menus['oj.problemMenu'] || [];
check('下拉项顺序', menu.map((it) => it.command),
  ['oj.submit', 'oj.test.run', 'oj.test.compile', 'oj.test.compileForce']);
check('每项都分组（顺序稳定）', menu.filter((it) => !it.group).length, 0);

console.log('\n[5] 未打开题目时的提示');
const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const warn = '[OJ] 请先打开一道题（在侧边栏的题目列表里点开，或打开这道题的题面）。';
check('统一提示出现次数', extSrc.split(warn).length - 1, 3);
check('旧文案已清除', /请先进入比赛并选择题目/.test(extSrc), false);
ok('提交缺源文件时另有提示', extSrc.includes('请先打开这道题的源代码文件'));

process.exit(done() ? 0 : 1);
