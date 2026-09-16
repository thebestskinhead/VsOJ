/**
 * S6.5 MCP 配置工具 —— 端到端
 *
 * 运行：npm run test:config-tools
 *
 * 这个套件直接走 `McpToolHandler`（MCP 的真实入口），并用一个临时目录模拟工作区：
 * `settings.json` 与 `toolchains.json` 都是真文件，读写之后还用**真实的 loader**
 * （`effectiveToolchains`）读回来确认覆盖生效。
 *
 * 也就是说，这里验证的正是用户要的那句话：「这个肯定不能是人来配了」——
 * AI 读说明书 → 探测本机 → 调 init_config → 配置真的生效。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { installVscodeStub, makeChecker } = require('./helpers/stub');

const WS = path.join(os.tmpdir(), `vsoj-cfg-tools-${process.pid}`);
installVscodeStub({ 'oj.baseUrl': 'http://localhost' }, { workspaceFolder: WS });

const { McpToolHandler } = require('../out/mcp/tools.js');
const { ConfigToolService } = require('../out/config/tools.js');
const M = require('../out/config/manual.js');
const T = require('../out/test/toolchain.js');

const { check, ok, done } = makeChecker();

const root = path.dirname(__dirname);
const pkgPath = path.join(root, 'package.json');
const catalog = M.buildCatalogFromFile(pkgPath);

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

const SETTINGS = path.join(WS, '.vscode', 'settings.json');
const TOOLCHAINS = path.join(WS, '.vsoj', 'toolchains.json');

/** 最小可用的 settings.json 读写（模拟 VS Code 的行为，含 JSONC 里的注释不处理） */
function readSettingsFile() {
  try {
    const obj = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    return obj['oj'] ?? {};
  } catch { return {}; }
}
function writeSettingsFile(patch, scope) {
  const all = (() => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } })();
  if (scope === 'global') { throw new Error('本测试只覆盖工作区作用域'); }
  const oj = all['oj'] ?? {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) { delete oj[k]; } else { oj[k] = v; }
  }
  all['oj'] = oj;
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
}

const service = new ConfigToolService({
  catalog,
  packageJsonPath: pkgPath,
  toolchainsFile: TOOLCHAINS,
  workspaceRoot: WS,
  readSettings: readSettingsFile,
  updateSetting: async (key, value, scope) => {
    writeSettingsFile({ [key.slice(3)]: value }, scope);
  },
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
  writeFile: (p, c) => fs.writeFileSync(p, c, 'utf8'),
  ensureDir: (p) => fs.mkdirSync(p, { recursive: true }),
  backup: (p, c) => { const bp = `${p}.bak`; fs.writeFileSync(bp, c, 'utf8'); return bp; },
});

const handler = new McpToolHandler({}, {}, {}, service);
const textOf = (r) => r.content.map((c) => c.text).join('\n');

(async () => {

// ── 1. 工具已注册，schema 能被客户端接受 ─────────────────────────
console.log('\n[1] 工具注册');
{
  const names = handler.listTools().map((t) => t.name);
  ok('get_config_manual 已注册', names.includes('get_config_manual'));
  ok('init_config 已注册', names.includes('init_config'));
  // 5 个只读/配置类 + 4 个测试工具（compile_problem / run_local_test / add_test_case / get_last_test_result）
  check('工具总数', names.length, 9);

  for (const name of ['get_config_manual', 'init_config']) {
    const t = handler.listTools().find((x) => x.name === name);
    ok(`${name} 有描述`, typeof t.description === 'string' && t.description.length > 40);
    check(`${name} schema 类型是 object`, t.inputSchema.type, 'object');
    ok(`${name} 参数都有 description（客户端可能据此提示）`,
      Object.values(t.inputSchema.properties).every((p) => typeof p.description === 'string' && p.description));
  }

  const manualTool = handler.listTools().find((t) => t.name === 'get_config_manual');
  check('section 参数带枚举', manualTool.inputSchema.properties.section.enum, M.MANUAL_SECTIONS);
  ok('不要求必填参数', manualTool.inputSchema.required.length === 0);
}

// ── 2. 读说明书 ──────────────────────────────────────────────────
console.log('\n[2] get_config_manual');
{
  const r = await handler.callTool('get_config_manual', {});
  const text = textOf(r);
  check('返回一段文本', r.content.length, 1);
  ok('含全部配置键', Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).contributes.configuration.properties)
    .filter((k) => k.startsWith('oj.'))
    .every((k) => text.includes(k)));
  ok('含「给 AI 的操作顺序」', /给 AI 的操作顺序/.test(text));
  ok('含如何探测本机（插件不做，AI 做）', /探测本机/.test(text));

  const quick = textOf(await handler.callTool('get_config_manual', { section: 'quickstart' }));
  ok('quickstart 只给步骤', quick.includes('## 1.') && !quick.includes('## 2. 全部配置项'));
  ok('quickstart 里给了 init_config 的可复制示例', quick.includes('"settings"') && quick.includes('"toolchains"'));

  const json = textOf(await handler.callTool('get_config_manual', { format: 'json' }));
  const parsed = JSON.parse(json);
  check('json 形态可解析且配置项齐全', parsed.settings.length, catalog.entries.length);
  ok('json 形态不夹带解释性正文', !/## /.test(json));

  const jsonQuick = JSON.parse(textOf(await handler.callTool('get_config_manual', { format: 'json', section: 'quickstart' })));
  ok('json + section 会裁掉无关部分（省 token）', jsonQuick.settings === undefined);

  const bad = textOf(await handler.callTool('get_config_manual', { section: 'nope' }));
  ok('未知 section 给出可选项', /可选：/.test(bad));
}

// ── 3. 预览：绝不落盘 ────────────────────────────────────────────
console.log('\n[3] init_config 预览');
{
  const r = await handler.callTool('init_config', {
    settings: { 'oj.baseUrl': 'http://acm.hnust.edu.cn', 'oj.mcp.enabled': true },
    toolchains: [{ id: 'cpp-g++', commands: { gpp: ['D:\\usexxx\\gcc\\bin\\g++.exe'] } }],
  });
  const text = textOf(r);
  ok('标注了「尚未落盘」', /尚未落盘/.test(text));
  ok('说明了怎么落盘', /apply.*true|apply": true/.test(text));
  ok('列出了配置项变更', /oj\.baseUrl/.test(text) && /acm\.hnust\.edu\.cn/.test(text));
  ok('列出了工具链覆盖及字段', /commands\.gpp/.test(text));
  ok('给出了待写入的 JSON', /```json/.test(text));

  check('文件系统上确实什么都没写', fs.existsSync(SETTINGS), false);
  check('toolchains.json 也没写', fs.existsSync(TOOLCHAINS), false);

  ok('命令解析预检列出了探测过的位置', /已探测过/.test(text));
}

// ── 4. 落盘：文件真的变了 ────────────────────────────────────────
console.log('\n[4] init_config 落盘');
{
  const r = await handler.callTool('init_config', {
    settings: { 'oj.baseUrl': 'http://acm.hnust.edu.cn', 'oj.mcp.enabled': true },
    toolchains: [{ id: 'cpp-g++', commands: { gpp: ['D:\\usexxx\\gcc\\bin\\g++.exe'] } }],
    apply: true,
  });
  const text = textOf(r);
  ok('标注了「已写入」', /配置已写入/.test(text));
  ok('配置项标为已写入', /✅ 已写入/.test(text));

  const written = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  check('settings.json 写入了 baseUrl', written.oj.baseUrl, 'http://acm.hnust.edu.cn');
  check('settings.json 写入了 mcp.enabled', written.oj['mcp.enabled'], true);

  // 用真实 loader 读回，确认覆盖生效
  const eff = T.effectiveToolchains(TOOLCHAINS);
  const cpp = eff.defs.find((d) => d.id === 'cpp-g++');
  check('工具链覆盖生效', cpp.commands.gpp, ['D:\\usexxx\\gcc\\bin\\g++.exe']);
  check('其余字段继承内置', cpp.compile, '"{gpp}" -O2 -std=c++17 -o "{output}" "{source}"');
  check('读回无问题', eff.problems, []);
}

// ── 5. 再调一次 = 幂等 ───────────────────────────────────────────
console.log('\n[5] 幂等');
{
  const text = textOf(await handler.callTool('init_config', {
    settings: { 'oj.baseUrl': 'http://acm.hnust.edu.cn', 'oj.mcp.enabled': true },
    toolchains: [{ id: 'cpp-g++', commands: { gpp: ['D:\\usexxx\\gcc\\bin\\g++.exe'] } }],
  }));
  ok('识别出「没有需要变更的内容」', /没有需要变更的内容/.test(text));
  ok('工具链部分也标注不写盘', /与磁盘上的内容一致/.test(text));
}

// ── 6. 键名写错 —— 落盘前拦住 ───────────────────────────────────
console.log('\n[6] 键名写错');
{
  const before = fs.readFileSync(SETTINGS, 'utf8');
  const text = textOf(await handler.callTool('init_config', {
    settings: { 'oj.mcp.Port': 8080, 'oj.baseu': 'http://x' },
    apply: true,
  }));
  ok('标注了计划有错误、不会落盘', /计划有错误，不会落盘/.test(text));
  ok('拼错的键给出了「是不是想写」的建议', /是不是想写 oj\.baseUrl/.test(text));
  ok('大小写写错的键被自动纠正（并留了提醒）', /大小写有误/.test(text) && /oj\.mcp\.port/.test(text));
  check('磁盘未被改动', fs.readFileSync(SETTINGS, 'utf8'), before);
}

// ── 7. 重置回默认 ────────────────────────────────────────────────
console.log('\n[7] 重置');
{
  const text = textOf(await handler.callTool('init_config', {
    settings: { 'oj.mcp.enabled': null },
    apply: true,
  }));
  ok('标为已重置', /已重置/.test(text));
  const written = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  ok('该项已从 settings.json 里删掉', !('mcp.enabled' in (written.oj ?? {})));
  check('其它项不受影响', written.oj.baseUrl, 'http://acm.hnust.edu.cn');
}

// ── 8. 真实编译器的路径能被解析出来 ─────────────────────────────
console.log('\n[8] 真实命令解析（本机）');
{
  const GPP = process.env.VSOJ_TEST_GPP || 'D:\\usexxx\\gcc\\versions\\16.2.0\\mingw64\\bin\\g++.exe';
  if (!fs.existsSync(GPP)) {
    console.log(`  skip 本机没有 ${GPP}，跳过真实解析`);
  } else {
    const text = textOf(await handler.callTool('init_config', {
      toolchains: [{ id: 'cpp-g++', commands: { gpp: [GPP] }, pathPrepend: [path.dirname(GPP)] }],
      apply: true,
    }));
    const cppLine = text.split('\n').find((l) => l.includes('C++ (g++)'));
    ok('cpp-g++ 那条判定为可解析', /^- ✅/.test(cppLine));
    ok('并回报了解析出的绝对路径', cppLine.includes(GPP));
    ok('预检覆盖了全部内置工具链（不只你改的那套）',
      ['C++ (g++)', 'C (gcc)', 'Java', 'Python'].every((l) => text.includes(l)));

    const eff = T.effectiveToolchains(TOOLCHAINS);
    const cpp = eff.defs.find((d) => d.id === 'cpp-g++');
    check('pathPrepend 也写进去了', cpp.pathPrepend, [path.dirname(GPP)]);
  }
}

// ── 9. 备份与坏 JSON 容错 ────────────────────────────────────────
console.log('\n[9] 备份与容错');
{
  const before = fs.readFileSync(TOOLCHAINS, 'utf8');
  const text = textOf(await handler.callTool('init_config', {
    toolchains: [{ id: 'cpp-g++', commands: { gpp: ['D:\\other\\g++.exe'] } }],
    apply: true,
  }));
  ok('说明旧文件已备份', /备份在/.test(text));
  check('备份内容 = 写之前的文件', fs.readFileSync(`${TOOLCHAINS}.bak`, 'utf8'), before);

  fs.writeFileSync(TOOLCHAINS, '{ 坏掉的 json', 'utf8');
  const tolerant = textOf(await handler.callTool('init_config', {
    toolchains: [{ id: 'c-gcc', commands: { gcc: ['D:\\gcc\\bin\\gcc.exe'] } }],
    apply: true,
  }));
  ok('坏 JSON 不阻断（只提醒）', /JSON 解析失败/.test(tolerant));
  ok('并且确实写进去了', /已写入/.test(tolerant));
  const eff = T.effectiveToolchains(TOOLCHAINS);
  ok('读回后 c-gcc 覆盖生效', JSON.stringify(eff.defs.find((d) => d.id === 'c-gcc').commands.gcc) === JSON.stringify(['D:\\gcc\\bin\\gcc.exe']));
}

fs.rmSync(WS, { recursive: true, force: true });
process.exit(done() ? 0 : 1);

})();
