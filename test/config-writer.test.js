/**
 * S6.5 写配置 —— 「AI 给错了会怎样」
 *
 * 运行：npm run test:config-writer
 *
 * 配置是**会改坏东西**的操作，而这个功能的调用方是 AI：它可能把键名打错、
 * 把数字写成字符串、把路径写成不存在的目录。所以这里测的不是 happy path，
 * 而是「出错时会不会在**落盘之前**被拦住，并且讲清楚哪里错了」。
 *
 * 计划函数是纯的（不碰磁盘、不依赖 VS Code），落盘副作用全部注入 ——
 * 因此这些都能在纯 Node 里跑，且能用「假 exists」精确构造探测失败的场景。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeChecker } = require('./helpers/stub');

const M = require('../out/config/manual.js');
const W = require('../out/config/writer.js');
const T = require('../out/test/toolchain.js');

const { check, ok, done } = makeChecker();

const root = path.dirname(__dirname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const catalog = M.buildCatalog(pkg);

const TMP = path.join(os.tmpdir(), `vsoj-writer-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const FILE = path.join(TMP, '.vsoj', 'toolchains.json');

/** 默认现状：没有任何配置、没有工具链文件、PATH 里什么都没有 */
const bare = { settings: {}, toolchainsFile: FILE, pathDirs: [] };

/** 内存 IO，记录每个动作 */
function makeIo() {
  const calls = { settings: [], files: [], dirs: [], backups: [] };
  return {
    calls,
    io: {
      updateSetting: async (key, value, scope) => { calls.settings.push({ key, value, scope }); },
      writeFile: (p, c) => { calls.files.push({ p, c }); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8'); },
      ensureDir: (p) => { calls.dirs.push(p); fs.mkdirSync(p, { recursive: true }); },
      backup: (p, c) => { const bp = `${p}.bak`; calls.backups.push({ p, c }); fs.writeFileSync(bp, c, 'utf8'); return bp; },
    },
  };
}

(async () => {

// ── 1. 配置项：正常写入与「当前值 → 新值」 ────────────────────────
console.log('\n[1] 配置项计划');
{
  const plan = W.planConfigWrite(
    { settings: { 'oj.baseUrl': 'http://acm.example.edu.cn', 'oj.mcp.enabled': true } },
    { ...bare, settings: { baseUrl: 'http://localhost', 'mcp.enabled': false } },
    catalog,
  );
  check('无错误', plan.errors, []);
  check('两项都要写', plan.settings.length, 2);
  check('记录了当前值', plan.settings[0].from, 'http://localhost');
  check('记录了新值', plan.settings[0].to, 'http://acm.example.edu.cn');
  check('都判定为有变化', plan.settings.map((s) => s.changed), [true, true]);
  check('默认作用域是工作区', plan.scope, 'workspace');
  check('默认不落盘', plan.apply, false);
}

// ── 2. 键名前缀可省 / 大小写写错能纠正 ───────────────────────────
console.log('\n[2] 键名容错');
{
  const plan = W.planConfigWrite(
    { settings: { baseUrl: 'http://a.b', 'oj.mcp.port': 9527 } },
    bare, catalog,
  );
  check('不带 oj. 前缀也认，且归一化成完整键', plan.settings.map((s) => s.key), ['oj.baseUrl', 'oj.mcp.port']);
  check('无错误', plan.errors, []);

  const cased = W.planConfigWrite({ settings: { 'oj.baseurl': 'http://a.b' } }, bare, catalog);
  check('大小写写错被纠正到正确的键', cased.settings.map((s) => s.key), ['oj.baseUrl']);
  ok('并且留下了提示（不是静默改）', cased.warnings.some((w) => /大小写/.test(w)));
}

// ── 3. 未知键必须被拦住并给出建议 ────────────────────────────────
console.log('\n[3] 未知键');
{
  const plan = W.planConfigWrite({ settings: { 'oj.mcp.Prot': 9527 } }, bare, catalog);
  ok('报错', plan.errors.length === 1);
  ok('给出了「是不是想写」的建议', /是不是想写 oj\.mcp\.port/.test(plan.errors[0]));

  const far = W.planConfigWrite({ settings: { 'oj.zzzzzzzz': 1 } }, bare, catalog);
  ok('差太远时只报未知、不瞎猜', !/是不是想写/.test(far.errors[0]));
  check('坏计划里不会混入该项', far.settings.length, 0);
}

// ── 4. 类型校验：能无损转的转 + 提示，转不了的报错 ───────────────
console.log('\n[4] 类型校验');
{
  const plan = W.planConfigWrite(
    { settings: { 'oj.test.timeoutMs': '15000', 'oj.mcp.enabled': 'true', 'oj.test.searchDirs': 'D:\\a, D:\\b' } },
    bare, catalog,
  );
  check('数字字符串被转成数字', plan.settings[0].to, 15000);
  check('布尔字符串被转成布尔', plan.settings[1].to, true);
  check('逗号分隔字符串被拆成数组', plan.settings[2].to, ['D:\\a', 'D:\\b']);
  check('三种转换各记一条提示', plan.warnings.length, 3);
  check('无错误', plan.errors, []);

  const bad = W.planConfigWrite(
    { settings: { 'oj.test.timeoutMs': '很快', 'oj.mcp.enabled': { a: 1 } } },
    bare, catalog,
  );
  check('数字项写非数字 → 报错', bad.errors.length, 2);
  ok('错误信息带上期望类型', /期望数字/.test(bad.errors[0]) && /期望布尔/.test(bad.errors[1]));
}

// ── 5. 枚举外的值只提醒不拦（插件本来就静默回退） ─────────────────
console.log('\n[5] 枚举提醒');
{
  const plan = W.planConfigWrite({ settings: { 'oj.statusViewMode': 'webviews' } }, bare, catalog);
  check('不报错（插件的真实行为是静默回退）', plan.errors, []);
  ok('但明确提醒了', plan.warnings.some((w) => /不在声明的枚举内/.test(w)));
}

// ── 6. null = 重置回默认 ─────────────────────────────────────────
console.log('\n[6] 重置');
{
  const plan = W.planConfigWrite(
    { settings: { 'oj.baseUrl': null } },
    { ...bare, settings: { baseUrl: 'http://old.example' } }, catalog,
  );
  check('无错误', plan.errors, []);
  check('to 记为 null', plan.settings[0].to, null);
  ok('判定为有变化', plan.settings[0].changed);

  const ioEnv = makeIo();
  await W.applyConfigWrite(plan, ioEnv.io).catch(() => {});
  const applied = await W.applyConfigWrite({ ...plan, apply: true }, ioEnv.io);
  ok('落盘时用 undefined 表示删除该项', ioEnv.calls.settings[0].value === undefined);
  check('被计为「已重置」', applied.settingsReset, ['oj.baseUrl']);
}

// ── 7. 未变化的不写 ──────────────────────────────────────────────
console.log('\n[7] 幂等');
{
  const plan = W.planConfigWrite(
    { settings: { 'oj.mcp.port': 9527 } },
    { ...bare, settings: { 'mcp.port': 9527 } }, catalog,
  );
  ok('同值判定为无变化', plan.settings[0].changed === false);
  const ioEnv = makeIo();
  const applied = await W.applyConfigWrite({ ...plan, apply: true }, ioEnv.io);
  check('没有发出写设置的调用', ioEnv.calls.settings.length, 0);
  ok('落盘结果算成功', applied.applied);
}

// ── 8. 部分覆盖：只写要改的字段（本轮修掉的真问题） ───────────────
console.log('\n[8] 工具链部分覆盖');
{
  const content = T.serializeUserToolchains([
    { id: 'cpp-g++', commands: { gpp: ['D:\\tools\\mingw64\\bin\\g++.exe'] } },
  ]);
  const parsed = T.parseToolchains(content);
  check('不再被当成坏条目丢弃', parsed.defs.length, 1);
  check('没有报缺 run / 缺 extensions', parsed.problems, []);
  check('只写了覆盖字段', Object.keys(JSON.parse(content).toolchains[0]).sort(), ['commands', 'id']);

  const effective = T.mergeToolchains(T.builtinToolchains(), parsed.defs);
  const cpp = effective.find((d) => d.id === 'cpp-g++');
  check('命令被覆盖', cpp.commands.gpp, ['D:\\tools\\mingw64\\bin\\g++.exe']);
  check('扩展名继承内置', cpp.extensions, ['.cpp', '.cc', '.cxx', '.c++']);
  check('编译模板继承内置', cpp.compile, '"{gpp}" -O2 -std=c++17 -o "{output}" "{source}"');
  check('能力位继承内置', cpp.asciiSafeOutput, true);
  check('仍是内置项（不可删）', cpp.builtin, true);
  check('覆盖字段被如实报出', T.overriddenFields(JSON.parse(content).toolchains[0], T.builtinToolchains()), ['commands.gpp']);

  // commands 必须按命令名合并，否则覆盖 java 会把 javac 弄丢
  const javaContent = T.serializeUserToolchains([
    { id: 'java', commands: { java: ['D:\\jdk\\bin\\java.exe'] } },
  ]);
  const javaDef = T.mergeToolchains(T.builtinToolchains(), T.parseToolchains(javaContent).defs)
    .find((d) => d.id === 'java');
  ok('javac 没被覆盖弄丢', Array.isArray(javaDef.commands.javac) && javaDef.commands.javac.length === 1);
  check('java 被换掉', javaDef.commands.java, ['D:\\jdk\\bin\\java.exe']);

  // 非内置 id 仍要求完整定义
  const partialNew = T.parseToolchains(T.serializeUserToolchains([{ id: 'go', commands: { go: ['go'] } }]));
  check('非内置 id 只写 commands → 仍报缺 run/extensions', partialNew.problems.length, 2);
  ok('并且问题里带了 id', partialNew.problems.every((p) => p.startsWith('go')));
}

// ── 9. 工具链计划：新增 / 覆盖 / 保留已有 ────────────────────────
console.log('\n[9] 工具链计划');
{
  const existing = T.serializeUserToolchains([{ id: 'ruby', extensions: ['.rb'], run: 'ruby {runnable}' }]);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, existing, 'utf8');

  const plan = W.planConfigWrite(
    { toolchains: [{ id: 'cpp-g++', commands: { gpp: ['D:\\gcc\\bin\\g++.exe'] } }] },
    { ...bare, toolchainsText: existing }, catalog,
  );
  check('无错误', plan.errors, []);
  ok('合并模式下保留了已有的 ruby 定义', /ruby/.test(plan.toolchains.content));
  ok('也写入了 cpp-g++ 的覆盖', /cpp-g\+\+/.test(plan.toolchains.content));
  check('标记了文件原有内容', plan.toolchains.existed, true);
  check('判定为有变化', plan.toolchains.changed, true);

  const actions = plan.toolchains.entries.map((e) => `${e.id}:${e.action}`);
  check('动作分类正确', actions.sort(), ['cpp-g++:override-builtin', 'ruby:add']);

  const replace = W.planConfigWrite(
    { toolchains: [{ id: 'cpp-g++', commands: { gpp: ['X'] } }], toolchainMode: 'replace' },
    { ...bare, toolchainsText: existing }, catalog,
  );
  ok('replace 模式清掉了 ruby', !/ruby/.test(replace.toolchains.content));
}

// ── 10. 命令解析：落盘前就知道能不能跑 ───────────────────────────
console.log('\n[10] 命令解析预检');
{
  const fakeExists = (p) => /g\+\+\.exe$/i.test(p);
  const withHit = W.planConfigWrite(
    { toolchains: [{ id: 'cpp-g++', commands: { gpp: ['D:\\gcc\\bin\\g++.exe'] } }] },
    { ...bare, exists: fakeExists }, catalog,
  );
  const cpp = withHit.checks.find((c) => c.id === 'cpp-g++');
  ok('路径存在时判定为可解析', cpp.ok);
  check('回报了解析到的路径', cpp.resolved[0].path, 'D:\\gcc\\bin\\g++.exe');

  const withMiss = W.planConfigWrite(
    { toolchains: [{ id: 'python', commands: { python: ['D:\\nope\\python.exe'] } }] },
    { ...bare, exists: () => false }, catalog,
  );
  const py = withMiss.checks.find((c) => c.id === 'python');
  ok('路径不存在时判定为不可解析', py.ok === false);
  ok('并回报了探测过的位置（这才是可用的报错）', py.tried.length >= 1);
  ok('探测位置里包含候选名', py.tried.some((t) => /python/.test(t)));

  // searchDirs 若本次一并写入，预检必须用**新值**而不是现值
  const withSearch = W.planConfigWrite(
    { settings: { 'oj.test.searchDirs': ['D:\\gcc\\bin'] }, toolchains: [{ id: 'cpp-g++', commands: { gpp: ['g++'] } }] },
    { ...bare, exists: (p) => p === path.join('D:\\gcc\\bin', 'g++.exe') }, catalog,
  );
  const viaSearch = withSearch.checks.find((c) => c.id === 'cpp-g++');
  ok('预检用的是本次要写入的 searchDirs（不是旧值）', viaSearch.ok);
}

// ── 11. 坏工具链定义被拦住 ───────────────────────────────────────
console.log('\n[11] 坏定义');
{
  const noId = W.planConfigWrite({ toolchains: [{ commands: { gpp: ['X'] } }] }, bare, catalog);
  check('缺 id 的条目报错', noId.errors.length, 1);
  ok('错误信息说明是第几项', /toolchains\[0\]/.test(noId.errors[0]));

  const emptyOverride = W.planConfigWrite({ toolchains: [{ id: 'cpp-g++' }] }, bare, catalog);
  ok('只写 id、一个字段都没覆盖 → 报错（等于没写）',
    emptyOverride.errors.some((e) => /没有覆盖任何字段/.test(e)));
  ok('并且告诉它该怎么写', /commands/.test(emptyOverride.errors.join('\n')));

  const notArray = W.planConfigWrite({ toolchains: { id: 'x' } }, bare, catalog);
  ok('toolchains 不是数组 → 报错', notArray.errors.some((e) => /必须是数组/.test(e)));

  const badDefinition = W.planConfigWrite(
    { toolchains: [{ id: 'go', commands: { go: ['go'] } }] },
    { ...bare, exists: () => false }, catalog,
  );
  ok('非内置定义不完整 → 报错并指出缺什么', badDefinition.errors.some((e) => /缺少 run/.test(e)));
}

// ── 12. 无工作区时写不了工作区设置 ───────────────────────────────
console.log('\n[12] 无工作区');
{
  const plan = W.planConfigWrite({ settings: { 'oj.baseUrl': 'http://a.b' } }, bare, catalog);
  ok('计划本身没有错', plan.errors.length === 0);
  const ioEnv = makeIo();
  const svc = new (require('../out/config/tools.js').ConfigToolService)({
    catalog, toolchainsFile: FILE, // 注意：不传 workspaceRoot
    readSettings: () => ({}),
    updateSetting: ioEnv.io.updateSetting,
    readFile: () => undefined,
    writeFile: ioEnv.io.writeFile,
    ensureDir: ioEnv.io.ensureDir,
  });
  const r = await svc.initConfig({ settings: { 'oj.baseUrl': 'http://a.b' }, apply: true });
  ok('拒绝落盘', r.ok === false);
  ok('并说清两条出路（打开文件夹 / 用 global）', /打开一个文件夹/.test(r.text) && /global/.test(r.text));
  check('确实没写任何东西', ioEnv.calls.settings.length, 0);
}

// ── 13. 有错误时拒绝落盘 ─────────────────────────────────────────
console.log('\n[13] 拒绝落盘');
{
  const plan = W.planConfigWrite({ settings: { 'oj.nope': 1 } }, bare, catalog);
  const ioEnv = makeIo();
  const r = await W.applyConfigWrite({ ...plan, apply: true }, ioEnv.io);
  check('未落盘', r.applied, false);
  check('没有任何写入动作', ioEnv.calls.settings.length + ioEnv.calls.files.length, 0);
  ok('说明了原因', r.errors.some((e) => /拒绝落盘/.test(e)));
}

// ── 14. 落盘 + 备份 + 读回验证（真文件） ─────────────────────────
console.log('\n[14] 落盘与备份');
{
  const previous = T.serializeUserToolchains([{ id: 'ruby', extensions: ['.rb'], run: 'ruby {runnable}' }]);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, previous, 'utf8');

  const plan = W.planConfigWrite(
    {
      settings: { 'oj.test.toolchain': 'cpp-g++' },
      toolchains: [{ id: 'cpp-g++', commands: { gpp: ['D:\\gcc\\bin\\g++.exe'] }, pathPrepend: ['D:\\gcc\\bin'] }],
      apply: true,
    },
    { ...bare, toolchainsText: previous, exists: () => false }, catalog,
  );
  const ioEnv = makeIo();
  const r = await W.applyConfigWrite(plan, ioEnv.io);

  check('落盘成功', r.applied, true);
  check('写了一项设置', r.settingsWritten, ['oj.test.toolchain']);
  ok('工具链文件已写', r.toolchains.written);
  ok('旧文件被备份', fs.existsSync(`${FILE}.bak`));
  check('备份内容 = 写之前的原文', fs.readFileSync(`${FILE}.bak`, 'utf8'), previous);

  // 读回：走真实的 loader，确认覆盖真的生效
  const eff = T.effectiveToolchains(FILE);
  const cpp = eff.defs.find((d) => d.id === 'cpp-g++');
  check('读回后命令是覆盖后的路径', cpp.commands.gpp, ['D:\\gcc\\bin\\g++.exe']);
  check('读回后扩展名仍来自内置', cpp.extensions.length, 4);
  ok('ruby 定义还在（merge 语义）', eff.defs.some((d) => d.id === 'ruby'));
  check('读回无问题', eff.problems, []);
  ok('文件里没有 builtin 字段（不该写进用户文件）', !/builtin/.test(fs.readFileSync(FILE, 'utf8')));
  ok('文件里没有把内置的完整模板抄一遍', !/std=c\+\+17/.test(fs.readFileSync(FILE, 'utf8')));
}

// ── 15. 坏 JSON 不会让功能瘫痪 ───────────────────────────────────
console.log('\n[15] 坏 JSON 容错');
{
  const plan = W.planConfigWrite(
    { toolchains: [{ id: 'cpp-g++', commands: { gpp: ['X'] } }] },
    { ...bare, toolchainsText: '{ 这不是 JSON' }, catalog,
  );
  check('仍然能算出计划（不抛）', plan.errors, []);
  ok('并提醒原文件解析失败', plan.warnings.some((w) => /JSON 解析失败/.test(w)));
  ok('新内容仍是合法 JSON', (() => { try { JSON.parse(plan.toolchains.content); return true; } catch { return false; } })());
}

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(done() ? 0 : 1);

})();
