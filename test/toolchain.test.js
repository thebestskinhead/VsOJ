// 工具链模型（test/toolchain.ts）—— 命令解析 / PATH 推导 / JSON 读写
// 运行：node test/toolchain.test.js
//
// 为什么值得测：这一层是「各人机器环境不同」的唯一收敛点。命令找不到、PATH 没推导对，
// 表现都是「所有样例都失败」，而用户根本看不出原因。所以失败时必须把「探测过哪些位置」说清楚。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeChecker } = require('./helpers/stub');
const T = require('../out/test/toolchain.js');

const { check, ok, done } = makeChecker();

// ── 1. 内置默认三套（决策 D1） ─────────────────────────────────────────────
console.log('[1] 内置默认工具链');
const builtin = T.builtinToolchains();
check('内置数量', builtin.length, 4);
check('id 列表', builtin.map(d => d.id), ['cpp-g++', 'c-gcc', 'java', 'python']);
check('全部标记 builtin', builtin.every(d => d.builtin === true), true);
check('编译型数量', builtin.filter(d => d.kind === 'compiled').map(d => d.id), ['cpp-g++', 'c-gcc', 'java']);
check('解释型数量', builtin.filter(d => d.kind === 'interpreted').map(d => d.id), ['python']);
check('c++ 认领 .cpp/.cc', T.matchToolchain(builtin, 'main.cpp').id, 'cpp-g++');
check('扩展名大小写无关', T.matchToolchain(builtin, 'MAIN.CPP').id, 'cpp-g++');
check('py 认领', T.matchToolchain(builtin, 'sol.py').id, 'python');
check('java 认领', T.matchToolchain(builtin, 'Main.java').id, 'java');
check('不认领的扩展名', T.matchToolchain(builtin, 'notes.txt'), undefined);
check('解释型没有 compile', builtin.find(d => d.id === 'python').compile, undefined);
check('compile 为空视为解释型', T.normalizeDef({ id: 'x', extensions: ['.x'], run: '"x" "{runnable}"' }).def.kind, 'interpreted');
check('C/C++ 声明「产物路径须纯 ASCII」（MinGW ld 实测限制；引擎用相对路径满足）',
  [builtin[0].asciiSafeOutput, builtin[1].asciiSafeOutput], [true, true]);
check('Java/Python 不声明该限制（实测它们往中文路径写产物正常）',
  [builtin[2].asciiSafeOutput, builtin[3].asciiSafeOutput], [undefined, undefined]);

// ── 2. 模板展开 ───────────────────────────────────────────────────────────
console.log('\n[2] 命令模板 → argv');
const cpp = builtin[0];
check('引号包住的路径含空格不被拆开',
  T.expandTemplate(cpp.compile, { gpp: 'C:\\Program Files\\gcc\\g++.exe', output: 'D:\\a b\\main.exe', source: 'D:\\a b\\main.cpp' }),
  ['C:\\Program Files\\gcc\\g++.exe', '-O2', '-std=c++17', '-o', 'D:\\a b\\main.exe', 'D:\\a b\\main.cpp']);
check('bare 占位符（java 类名）',
  T.expandTemplate(builtin[2].run, { java: 'java', dir: 'C:\\t', stem: 'Main' }),
  ['java', '-cp', 'C:\\t', 'Main']);
check('未定义的占位符原样保留', T.expandTemplate('"{a}" {zzz}', { a: 'x' }), ['x', '{zzz}']);
check('多个空格与换行折叠', T.expandTemplate('"{a}"\n   "{b}"', { a: 'x', b: 'y' }), ['x', 'y']);

// ── 3. 命令查找（注入桩，不依赖真实文件系统） ──────────────────────────────
console.log('\n[3] 命令查找');
const fakeExists = (set) => (p) => set.has(p);
const winOrPosix = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
check('PATH 命中', !!T.lookupCommand('g++', ['D:\\bin'], fakeExists(new Set([path.join('D:\\bin', winOrPosix('g++'))]))), true);
check('未命中返回 undefined', T.lookupCommand('nope', ['D:\\bin'], fakeExists(new Set())), undefined);
check('空目录不崩', T.lookupCommand('g++', ['', undefined], fakeExists(new Set())), undefined);

// ── 4. resolveCommands：绝对路径 / PATH / searchDirs / missing ─────────────
console.log('\n[4] 命令解析与失败记账');
const absGpp = 'D:\\usexxx\\gcc\\versions\\16.2.0\\mingw64\\bin\\' + winOrPosix('g++');
const r1 = T.resolveCommands(
  { ...cpp, commands: { gpp: [absGpp] } },
  { pathDirs: [], searchDirs: [], exists: fakeExists(new Set([absGpp])) },
);
check('配置里写绝对路径直接命中', r1.resolved.gpp, absGpp);
check('无缺失', r1.missing, []);

const r2 = T.resolveCommands(cpp, {
  pathDirs: ['C:\\mingw\\bin'],
  exists: fakeExists(new Set([path.join('C:\\mingw\\bin', winOrPosix('g++'))])),
});
check('PATH 命中', !!r2.resolved.gpp, true);

const r3 = T.resolveCommands(
  { ...cpp, commands: { gpp: ['g++'] } },
  { pathDirs: [], searchDirs: ['D:\\portable\\bin'], exists: fakeExists(new Set([path.join('D:\\portable\\bin', winOrPosix('g++'))])) },
);
check('searchDirs 命中', !!r3.resolved.gpp, true);

const r4 = T.resolveCommands(cpp, { pathDirs: ['C:\\bin'], searchDirs: ['D:\\s'], exists: fakeExists(new Set()) });
check('找不到时记入 missing', r4.missing, ['gpp']);
ok('tried 里留下了探测位置（便于报错引导）', r4.tried.length >= 2);

const javaDef = builtin[2];
const r5 = T.resolveCommands(javaDef, {
  pathDirs: ['C:\\jdk\\bin'],
  exists: fakeExists(new Set([path.join('C:\\jdk\\bin', winOrPosix('javac')), path.join('C:\\jdk\\bin', winOrPosix('java'))])),
});
check('多命令占位符全部解析', Object.keys(r5.resolved).sort(), ['java', 'javac']);

const r6 = T.resolveCommands(
  { id: 'p', label: 'p', kind: 'interpreted', extensions: ['.py'], commands: { python: ['python3', 'python', 'py'] }, run: '"{python}" "{runnable}"' },
  {
    pathDirs: ['C:\\bin'],
    exists: fakeExists(new Set([path.join('C:\\bin', winOrPosix('python'))])),
  },
);
check('候选按序回退到第二个', r6.resolved.python, path.join('C:\\bin', winOrPosix('python')));

// ── 5. PATH 推导（决策 D4：自动推导 + 覆盖） ───────────────────────────────
console.log('\n[5] 子进程 PATH：推导 + 覆盖');
const mingwBin = 'D:\\usexxx\\gcc\\versions\\16.2.0\\mingw64\\bin';
const jdkBin = 'C:\\jdk\\bin';
check('PATH 只含命令所在目录（去重）',
  T.buildPathEnv(cpp, { gpp: path.join(mingwBin, 'g++.exe') }), mingwBin);
check('多命令去重',
  T.buildPathEnv(javaDef, { javac: path.join(jdkBin, 'javac.exe'), java: path.join(jdkBin, 'java.exe') }), jdkBin);
check('pathPrepend 追加在后',
  T.buildPathEnv({ ...cpp, pathPrepend: ['C:\\extra'] }, { gpp: path.join(mingwBin, 'g++.exe') }),
  [mingwBin, 'C:\\extra'].join(path.delimiter));
check('显式 env.PATH 完全覆盖',
  T.buildPathEnv({ ...cpp, env: { PATH: 'C:\\only' } }, { gpp: path.join(mingwBin, 'g++.exe') }), 'C:\\only');

console.log('\n[6] 子进程环境：其余继承、PATH 被替换');
const env = T.buildEnv(cpp, { gpp: path.join(mingwBin, 'g++.exe') }, { SystemRoot: 'C:\\Windows', PATH: 'C:\\should-be-gone' });
check('PATH 已替换（不继承外层）', env.PATH, mingwBin);
check('其余变量继承', env.SystemRoot, 'C:\\Windows');

// ── 7. 脏配置容错 ─────────────────────────────────────────────────────────
console.log('\n[7] 坏定义只跳过自己');
check('缺 run', T.normalizeDef({ id: 'a', extensions: ['.a'] }).problems.length, 1);
check('缺 id', T.normalizeDef({ extensions: ['.a'], run: 'x' }).problems.length, 1);
check('compiled 但缺 compile', T.normalizeDef({ id: 'a', kind: 'compiled', extensions: ['.a'], run: 'x' }).problems.length, 1);
check('扩展名补点并小写', T.normalizeDef({ id: 'a', extensions: ['PY'], run: 'x' }).def.extensions, ['.py']);
check('commands 支持字符串简写', T.normalizeDef({ id: 'a', extensions: ['.a'], run: 'x', commands: { x: 'C:\\x.exe' } }).def.commands.x, ['C:\\x.exe']);
check('阈值必须是正数', T.normalizeDef({ id: 'a', extensions: ['.a'], run: 'x', timeoutMs: -5 }).def.timeoutMs, undefined);
const parsed = T.parseToolchains(JSON.stringify({ version: 1, toolchains: [
  { id: 'good', extensions: ['.x'], run: '"x" "{runnable}"' },
  { id: 'bad' },
] }));
check('好条目保留', parsed.defs.map(d => d.id), ['good']);
check('坏条目记账（缺 run + 缺 extensions）', parsed.problems.length, 2);
check('问题信息带 id 前缀（便于定位是哪一条）', parsed.problems.every(p => p.startsWith('bad')), true);
check('坏 JSON 不抛', T.parseToolchains('{not json').problems.length, 1);

// ── 8. 内置 + 用户覆盖合并（决策 D1/D2） ───────────────────────────────────
console.log('\n[8] 合并：同 id 覆盖内置');
const merged = T.mergeToolchains(builtin, [
  { id: 'cpp-g++', label: 'C++ (便携)', kind: 'compiled', extensions: ['.cpp'], commands: { gpp: [absGpp] }, compile: '"x"', run: '"x"' },
  { id: 'ruby', label: 'Ruby', kind: 'interpreted', extensions: ['.rb'], commands: { ruby: ['ruby'] }, run: '"{python}" "{runnable}"' },
]);
check('数量（覆盖 + 新增）', merged.length, 5);
check('内置 id 顺序不变', merged.slice(0, 4).map(d => d.id), ['cpp-g++', 'c-gcc', 'java', 'python']);
check('覆盖生效', merged[0].commands.gpp, [absGpp]);
check('覆盖后仍标记 builtin（编辑页据此禁删）', merged[0].builtin, true);
check('新增项在尾部且非 builtin', merged[4].builtin, false);

// ── 9. 文件读写往返（决策 D3：工作区一份） ─────────────────────────────────
console.log('\n[9] toolchains.json 读写');
const dir = path.join(os.tmpdir(), `vsoj-toolchain-${process.pid}`);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, T.TOOLCHAINS_FILE_NAME);

const miss = T.effectiveToolchains(file);
check('文件不存在时仍是内置三套', miss.defs.length, 4);
check('文件不存在时 fileExists=false', miss.fileExists, false);

fs.writeFileSync(file, T.serializeToolchains([
  { id: 'cpp-g++', label: 'C++', kind: 'compiled', extensions: ['.cpp'], commands: { gpp: [absGpp] }, compile: '"x"', run: '"x"' },
]), 'utf8');
const hit = T.effectiveToolchains(file);
check('文件存在时被识别', hit.fileExists, true);
check('覆盖生效且总数不变', hit.defs.length, 4);
check('g++ 路径被覆盖', hit.defs[0].commands.gpp, [absGpp]);

const roundTrip = T.parseToolchains(T.serializeToolchains(builtin)).defs;
check('序列化→解析往返 id 不变', roundTrip.map(d => d.id), builtin.map(d => d.id));
check('往返后 compile 保留', roundTrip[0].compile, builtin[0].compile);
check('往返不写 builtin 字段（由代码补）', 'builtin' in JSON.parse(T.serializeToolchains(builtin)).toolchains[0], false);
check('asciiSafeOutput 序列化往返保留',
  T.parseToolchains(T.serializeToolchains([builtin[0]])).defs[0].asciiSafeOutput, true);
check('未声明的工具链不会被凭空写上 asciiSafeOutput',
  T.parseToolchains(T.serializeToolchains([builtin[3]])).defs[0].asciiSafeOutput, undefined);

fs.writeFileSync(file, '{ broken', 'utf8');
const broken = T.effectiveToolchains(file);
check('坏文件不致命，回退内置', broken.defs.length, 4);
ok('坏文件给出 problem', broken.problems.length === 1);

// ── 10. 真实环境（本机便携 g++） ───────────────────────────────────────────
console.log('\n[10] 真实环境解析');
const realGpp = process.env.VSOJ_TEST_GPP
  || 'D:\\usexxx\\gcc\\versions\\16.2.0\\mingw64\\bin\\g++.exe';
if (fs.existsSync(realGpp)) {
  const r = T.resolveCommands({ ...cpp, commands: { gpp: [realGpp] } }, { pathDirs: [], exists: (p) => fs.existsSync(p) });
  check('本机 g++ 解析成功', r.resolved.gpp, realGpp);
  check('推导出的 PATH 即其所在 bin 目录', T.buildPathEnv(cpp, r.resolved), path.dirname(realGpp));
  ok('该目录下确实有 libstdc++-6.dll（PATH 推导的必要性来源）', fs.existsSync(path.join(path.dirname(realGpp), 'libstdc++-6.dll')));
} else {
  console.log(`  skip  本机未找到 g++（${realGpp}），用 VSOJ_TEST_GPP 指定后可启用本组断言`);
}

fs.rmSync(dir, { recursive: true, force: true });
process.exit(done() ? 0 : 1);
