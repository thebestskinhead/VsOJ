// 工具链配置页（src/webview/toolchainWebview.ts）—— 模型组装 / 保存计划 / 渲染约束 / 真落盘读回
// 运行：node test/toolchain-page.test.js
//
// 这一页的难点不在渲染，而在**写回文件的粒度**：内置项只写改动过的字段、改回原样要
// 把覆盖项移除、坏输入整份不落盘。所以这组测试的重心是「计划 → 落盘 → 再用引擎读回」，
// 而不是比对 HTML 字符串 —— 后者只钉死几条不会靠肉眼发现的约束（亮色、转义、坏文件禁存）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installVscodeStub, makeChecker, cleanup } = require('./helpers/stub');

// 必须在 require 业务模块之前装桩（toolchainWebview.ts → vscode）
const env = installVscodeStub();
const T = require('../out/test/toolchain.js');
const P = require('../out/webview/toolchainWebview.js');

const { check, ok, done } = makeChecker();
const BUILTIN = T.builtinToolchains();
const LIMITS = { timeoutMs: 10000, maxOutputBytes: 67108864, maxMemoryBytes: 2147483648 };

const root = path.join(os.tmpdir(), `vsoj-tcpage-${process.pid}`);
const file = path.join(root, '.vsoj', 'toolchains.json');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.dirname(file), { recursive: true });

/** 命令探测的桩：不碰真实 PATH（真探测另有 toolchain.test.js 覆盖） */
const noProbe = (def) => ({ resolved: {}, missing: Object.keys(def.commands || {}), tried: [] });
const writeFile = (text) => fs.writeFileSync(file, text, 'utf8');
const readBack = () => T.effectiveToolchains(file);

/** 页面视图 → 页面回传的表单（字段全是文本，解析在校验侧做） */
function inputOf(e, over = {}) {
  return {
    id: e.id,
    builtin: e.builtin,
    label: e.label,
    kind: e.kind,
    extensions: (e.extensions || []).join(' '),
    compile: e.compile || '',
    run: e.run,
    commands: Object.entries(e.commands || {}).map(([k, v]) => `${k} = ${v.join(', ')}`).join('\n'),
    env: Object.entries(e.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    pathPrepend: (e.pathPrepend || []).join('\n'),
    timeoutMs: e.timeoutMs ? String(e.timeoutMs) : '',
    maxOutputBytes: e.maxOutputBytes ? String(e.maxOutputBytes) : '',
    maxMemoryBytes: e.maxMemoryBytes ? String(e.maxMemoryBytes) : '',
    asciiSafeOutput: !!e.asciiSafeOutput,
    ...over,
  };
}

const custom = {
  id: 'rustc', builtin: false, label: 'Rust', kind: 'compiled',
  extensions: '.rs', compile: '"rustc" -O -o "{output}" "{source}"', run: '"{runnable}"',
  commands: 'rustc = rustc', env: '', pathPrepend: '',
  timeoutMs: '', maxOutputBytes: '', maxMemoryBytes: '', asciiSafeOutput: false,
};

// ── 1. 模型组装 ──────────────────────────────────────────────────────────────
console.log('[1] 模型组装');
const m0 = P.buildToolchainModel({ file, fileText: undefined, probe: noProbe });
check('文件不存在时展示内置四套', m0.entries.length, 4);
check('文件不存在', m0.fileExists, false);
check('没有覆盖标记', m0.entries.filter((e) => e.fromFile).length, 0);

const partial = JSON.stringify({
  version: 1,
  toolchains: [{ id: 'cpp-g++', commands: { gpp: ['D:/gcc/bin/g++.exe'] } }],
}, null, 2);
const m1 = P.buildToolchainModel({ file, fileText: partial, probe: noProbe, selectedId: 'cpp-g++' });
const cpp1 = m1.entries.find((e) => e.id === 'cpp-g++');
check('覆盖字段细到命令名', cpp1.overridden, ['commands.gpp']);
check('这条来自文件', cpp1.fromFile, true);
check('仍是内置项（不可删）', cpp1.builtin, true);
check('覆盖后的命令生效', cpp1.commands.gpp, ['D:/gcc/bin/g++.exe']);
check('条目总数不变', m1.entries.length, 4);
check('选中的工具链透传', m1.selectedId, 'cpp-g++');

const java1 = m1.entries.find((e) => e.id === 'java');
check('未被覆盖的条目没有覆盖标记', java1.overridden, []);

// 探测结果进模型（缺什么要能一眼看到）
const probeStub = (def) => ({
  resolved: def.commands.gpp ? { gpp: 'C:\\mingw64\\bin\\g++.exe' } : {},
  missing: def.commands.gpp ? [] : Object.keys(def.commands),
  tried: ['C:\\mingw64\\bin\\g++.exe'],
});
const m2 = P.buildToolchainModel({ file, fileText: undefined, probe: probeStub });
check('就绪的条目没有缺失命令', m2.entries.find((e) => e.id === 'cpp-g++').probe.missing, []);
check('缺失命令按条目列出', m2.entries.find((e) => e.id === 'python').probe.missing, ['python']);

// ── 2. 坏条目与坏文件 ────────────────────────────────────────────────────────
console.log('\n[2] 坏条目 / 坏文件');
const withBad = JSON.stringify({
  version: 1,
  toolchains: [{ id: 'bad-1' }, { id: 'cpp-g++', commands: { gpp: ['x'] } }],
});
const m3 = P.buildToolchainModel({ file, fileText: withBad, probe: noProbe });
check('坏条目被单独记账', m3.brokenEntries.map((b) => b.id), ['bad-1']);
ok('说明缺了什么', m3.brokenEntries[0].problems.join(' ').includes('run'));
check('坏条目原样留着（保存时回写）', m3.rawKept.length, 1);
check('其余条目不受影响', m3.entries.find((e) => e.id === 'cpp-g++').fromFile, true);

const dupText = JSON.stringify({ version: 1, toolchains: [{ id: 'python', run: 'a' }, { id: 'python', run: 'b' }] });
const m4 = P.buildToolchainModel({ file, fileText: dupText, probe: noProbe });
ok('id 重复被记账', m4.brokenEntries.some((b) => b.problems.join().includes('重复')));
check('重复 id 只生效第一条', m4.entries.find((e) => e.id === 'python').run, 'a');

const m5 = P.buildToolchainModel({ file, fileText: '{ 这不是 json', probe: noProbe });
check('坏 JSON → 标记文件不可用', m5.fileBroken, true);
ok('给出解析原因', m5.problems.join(' ').includes('JSON'));
check('坏 JSON 时仍展示内置', m5.entries.length, 4);

// ── 3. 保存计划 ──────────────────────────────────────────────────────────────
console.log('\n[3] 保存计划');
const untouched = P.planToolchainSave(m2.entries.map((e) => inputOf(e)), BUILTIN);
check('没改动就什么都不写', untouched.entries.length, 0);
ok('计划有效', untouched.ok);
check('每条都判定为「无需写入」', untouched.actions.every((a) => a.action === 'remove'), true);

const cpp2 = m2.entries.find((e) => e.id === 'cpp-g++');
const p1 = P.planToolchainSave([inputOf(cpp2, { commands: 'gpp = D:\\gcc\\bin\\g++.exe' })], BUILTIN);
check('只写 id 与被改的 commands', Object.keys(p1.entries[0]), ['id', 'commands']);
check('commands 只写改过的命令名', Object.keys(p1.entries[0].commands), ['gpp']);
check('字段记账细到命令名', p1.actions[0].fields, ['commands.gpp']);
ok('计划有效', p1.ok);

writeFile(p1.text);
const back1 = readBack();
check('落盘后命令立刻生效', back1.defs.find((d) => d.id === 'cpp-g++').commands.gpp, ['D:\\gcc\\bin\\g++.exe']);
check('没写进文件的条目仍用内置值', back1.defs.find((d) => d.id === 'java').commands.javac, ['javac']);
check('覆盖文件里只有那一条', JSON.parse(p1.text).toolchains.length, 1);

// 恢复默认＝把表单填回内置值 → 这条覆盖从文件里移除
const m6 = P.buildToolchainModel({ file, fileText: fs.readFileSync(file, 'utf8'), probe: noProbe });
const cpp6 = m6.entries.find((e) => e.id === 'cpp-g++');
check('读回覆盖', cpp6.overridden, ['commands.gpp']);
const p2 = P.planToolchainSave([inputOf(cpp6, { commands: 'gpp = g++' })], BUILTIN, m6.rawKept);
check('填回内置值 → 判定为移除', p2.actions[0].action, 'remove');
check('文件里不再有这条', JSON.parse(p2.text).toolchains.length, 0);
writeFile(p2.text);
const back2 = readBack();
check('回到内置命令', back2.defs.find((d) => d.id === 'cpp-g++').commands.gpp, ['g++']);

// 自定义条目：整份写入（内置以后加字段也不会影响它）
const p3 = P.planToolchainSave([custom], BUILTIN);
ok('自定义条目可写入', p3.ok);
check('写了完整定义', ['id', 'label', 'kind', 'extensions', 'commands', 'compile', 'run']
  .every((k) => p3.entries[0][k] !== undefined), true);
writeFile(p3.text);
const back3 = readBack();
check('自定义条目出现在生效列表末尾', back3.defs[back3.defs.length - 1].id, 'rustc');
check('生效列表共 5 条', back3.defs.length, 5);
check('自定义条目不是内置（可删）', back3.defs[back3.defs.length - 1].builtin, false);

// 删掉自定义条目＝不再出现在表单里
const p4 = P.planToolchainSave([], BUILTIN);
check('页面没这条就不写进文件', JSON.parse(p4.text).toolchains.length, 0);

// 坏条目原样回写（不静默丢弃用户手写的内容）
const p5 = P.planToolchainSave([custom], BUILTIN, [{ id: 'bad-1', note: '手写的' }]);
ok('坏条目原样保留', JSON.parse(p5.text).toolchains.some((x) => x.id === 'bad-1'));
check('保留的坏条目内容未被加工', JSON.parse(p5.text).toolchains.find((x) => x.id === 'bad-1').note, '手写的');

// ── 4. 坏输入整份不落盘 ──────────────────────────────────────────────────────
console.log('\n[4] 坏输入');
const bad1 = P.planToolchainSave([{ ...custom, extensions: '' }], BUILTIN);
check('缺扩展名 → 不落盘', [bad1.ok, bad1.text], [false, '']);
ok('说明缺 extensions', bad1.problems.join(' ').includes('extensions'));

const bad2 = P.planToolchainSave([{ ...custom, run: '' }], BUILTIN);
ok('缺运行模板 → 说明原因', bad2.problems.join(' ').includes('run'));

const bad3 = P.planToolchainSave([{ ...custom, commands: 'rustc rustc' }], BUILTIN);
ok('命令行格式错 → 说明写法', bad3.problems.some((p) => p.includes('名字 = 候选')));

const bad4 = P.planToolchainSave([{ ...custom, timeoutMs: 'abc' }], BUILTIN);
ok('阈值非数字 → 说明原因', bad4.problems.some((p) => p.includes('超时')));

const bad5 = P.planToolchainSave([{ ...custom, id: '' }], BUILTIN);
ok('缺 id → 说明原因', bad5.problems.some((p) => p.includes('没填 id')));

const bad6 = P.planToolchainSave([custom, { ...custom, label: '另一个' }], BUILTIN);
ok('id 重复 → 说明原因', bad6.problems.some((p) => p.includes('重复')));

const bad7 = P.planToolchainSave([inputOf(m2.entries[0], { compile: '' })], BUILTIN);
ok('编译型缺编译模板 → 说明原因', bad7.problems.some((p) => p.includes('compile')));

const bad8 = P.planToolchainSave([{ ...custom, kind: 'interpreted', compile: '', run: '' }], BUILTIN);
ok('解释型也要求运行模板', bad8.problems.join(' ').includes('run'));

// 部分坏 = 整份不落盘（半份计划写下去比不写更糟）
const bad9 = P.planToolchainSave([custom, { ...custom, id: 'x', extensions: '' }], BUILTIN);
check('一条坏 → 好条目也不落盘', [bad9.ok, bad9.text], [false, '']);

// ── 5. 渲染约束 ──────────────────────────────────────────────────────────────
console.log('\n[5] 渲染');
const html = P.buildToolchainHtml(m1);
ok('固定亮色（不跟随编辑器主题）', html.includes('color-scheme: light'));
ok('不引用编辑器主题变量', !html.includes('--vscode-'));
ok('四条工具链都在页面上', BUILTIN.every((b) => html.includes(`data-id="${b.id}"`)));
ok('标出「覆盖内置」', html.includes('覆盖内置'));
ok('标出被覆盖的字段', html.includes('已覆盖'));
ok('标出当前选用的工具链', html.includes('当前选用'));
ok('开脚本（表单要收集、保存要回传）', html.includes('acquireVsCodeApi'));
ok('含内容安全策略', html.includes('Content-Security-Policy'));
ok('文件路径写出来了', html.includes('.vsoj'));

const mReady = P.buildToolchainModel({ file, fileText: undefined, probe: probeStub });
const htmlReady = P.buildToolchainHtml(mReady);
ok('就绪的条目显示「命令就绪」', htmlReady.includes('命令就绪'));
ok('缺命令的条目把缺谁写出来', /缺 [^<]*python/.test(htmlReady));
ok('汇总里有「几条命令没找到」', htmlReady.includes('条命令没找到'));
ok('探测位置可展开', htmlReady.includes('探测过的'));

const htmlBroken = P.buildToolchainHtml(m5);
ok('坏文件时保存按钮禁用', /data-act="save" disabled/.test(htmlBroken));
ok('坏文件时说明先修 JSON', htmlBroken.includes('页面暂不可保存'));

const htmlBadEntry = P.buildToolchainHtml(m3);
ok('坏条目单独成节', htmlBadEntry.includes('读不出来'));
ok('坏条目说明原样保留', htmlBadEntry.includes('原样保留'));

// 拼进页面的内容必须转义（label / 命令路径都可能来自用户与文件）
const evil = JSON.stringify({
  version: 1,
  toolchains: [{
    id: 'evil', label: '</script><img src=x onerror=alert(1)>',
    kind: 'interpreted', extensions: ['.e'], run: '"{r}"', commands: { r: ['r'] },
  }],
});
const htmlEvil = P.buildToolchainHtml(P.buildToolchainModel({ file, fileText: evil, probe: noProbe }));
ok('label 里的标签被转义', htmlEvil.includes('&lt;/script&gt;&lt;img'));
ok('没有原样落进 DOM', !htmlEvil.includes('<img src=x'));

// 「恢复默认」用的内置默认值数据块：必须是可解析的 JSON，且不能提前闭合脚本标签
const defaults = html.match(/id="builtin-defaults">([\s\S]*?)<\/script>/);
ok('内置默认值数据块存在', !!defaults);
const parsedDefaults = JSON.parse(defaults[1]);
check('数据块含内置四套', Object.keys(parsedDefaults).sort(), ['c-gcc', 'cpp-g++', 'java', 'python']);
check('数据块是纯内置值（不受覆盖影响）', parsedDefaults['cpp-g++'].run, '"{runnable}"');
const htmlEvilDefaults = (() => {
  const evilBuiltin = [{ ...BUILTIN[0], label: '</script>' }];
  const h = P.buildToolchainHtml(
    P.buildToolchainModel({ file, fileText: undefined, builtin: evilBuiltin, probe: noProbe }),
    { builtin: evilBuiltin },
  );
  return (h.match(/id="builtin-defaults">([\s\S]*?)<\/script>/) || [])[1];
})();
ok('数据块里 < 被转义（不会提前闭合脚本标签）', !!htmlEvilDefaults && !htmlEvilDefaults.includes('</script>'));
check('转义后仍是合法 JSON', JSON.parse(htmlEvilDefaults)['cpp-g++'].label, '</script>');

// ── 6. 面板薄壳（保存链路走一遍） ─────────────────────────────────────────────
console.log('\n[6] 面板');
let created = null;
let handler = null;
const posts = [];
env.vscode.window.createWebviewPanel = (type, title, column, options) => {
  created = { type, title, column, options, html: '' };
  return {
    webview: {
      get html() { return created.html; },
      set html(v) { created.html = v; },
      postMessage: (m) => { posts.push(m); },
      onDidReceiveMessage: (fn) => { handler = fn; },
      asWebviewUri: (u) => u,
    },
    onDidDispose: () => {}, reveal: () => {}, dispose: () => {},
  };
};

const wv = new P.ToolchainWebview({
  filePath: () => file,
  readFile: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } },
  writeFile: (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, 'utf8'); },
  openFile: () => {},
  selectedToolchainId: () => 'auto',
  searchDirs: () => [],
  limits: () => LIMITS,
  log: () => {},
});

writeFile(T.serializeUserToolchains([]));
wv.show();
check('面板类型', created.type, 'ojToolchains');
check('开脚本且保留上下文', [created.options.enableScripts, created.options.retainContextWhenHidden], [true, true]);
ok('首屏渲染出页面', created.html.includes('工具链配置'));
check('isOpen', wv.isOpen, true);

handler({ command: 'save', entries: [custom] });
ok('保存把新条目写进文件', fs.readFileSync(file, 'utf8').includes('rustc'));
ok('保存后页面重渲染（新条目出现在页面上）', created.html.includes('data-id="rustc"'));
ok('保存后给出提示', created.html.includes('已保存'));
check('没有报错消息', posts.filter((m) => m.kind === 'err').length, 0);

posts.length = 0;
handler({ command: 'save', entries: [{ ...custom, extensions: '' }] });
check('坏输入只回提示、不写文件', posts.length, 1);
ok('提示里说明原因', posts[0].text.includes('extensions'));
ok('文件仍是上一次保存的内容', fs.readFileSync(file, 'utf8').includes('rustc'));

handler({ command: 'reload' });
ok('重新加载有提示', created.html.includes('重新加载'));

wv.dispose();
check('dispose 后关闭', wv.isOpen, false);

cleanup(root);
process.exit(done() ? 0 : 1);
