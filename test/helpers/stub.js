/**
 * 测试公共桩 —— 在 Node 中替代 VS Code 运行时。
 *
 * 用法：
 *   const { installVscodeStub, makeChecker, cleanup } = require('./helpers/stub');
 *   const env = installVscodeStub({ 'oj.baseUrl': 'http://127.0.0.1:1234' });
 *   ... 在 require 业务模块之前完成安装 ...
 */

const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * 安装 `vscode` 模块桩。必须在 require 业务模块之前调用。
 *
 * 配置键**两种写法都认**（`'cache.enabled'` 与 `'oj.cache.enabled'`）：
 * 业务代码走的是 `getConfiguration('oj').get('cache.enabled')`，但测试里带前缀写更接近
 * settings.json 的样子 —— 早先只认无前缀，导致带前缀的配置静默失效（取到默认值），
 * 这种「配置写了却没用上」的假通过最难查。
 */
function installVscodeStub(config = {}, options = {}) {
  const workspaceFolder = options.workspaceFolder
    || path.join(os.tmpdir(), `vsoj-test-ws-${process.pid}`);
  const globalStorage = options.globalStorage
    || path.join(os.tmpdir(), `vsoj-test-gs-${process.pid}`);

  if (options.fresh !== false) {
    fs.rmSync(workspaceFolder, { recursive: true, force: true });
    fs.rmSync(globalStorage, { recursive: true, force: true });
  }
  fs.mkdirSync(workspaceFolder, { recursive: true });
  fs.mkdirSync(globalStorage, { recursive: true });

  const outputChannel = {
    appendLine: () => {}, append: () => {}, clear: () => {},
    show: () => {}, hide: () => {}, dispose: () => {}, replace: () => {},
  };

  // 记录 executeCommand 调用 —— 用于断言 `setContext` 这类「只发命令、没有返回值」
  // 的副作用（早前桩是空函数，导致「上下文没设」这类 bug 无法被测出来）
  const commandLog = [];

  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: workspaceFolder } }],
      getConfiguration: () => ({
        get: (k, d) => {
          if (k in config) { return config[k]; }
          if (`oj.${k}` in config) { return config[`oj.${k}`]; }
          return d;
        },
      }),
      textDocuments: [],
      fs: {
        readFile: (uri) => fs.promises.readFile(uri.fsPath),
      },
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
    window: {
      createOutputChannel: () => outputChannel,
      createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      withProgress: async (_opts, task) => task(
        { report: () => {} },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
      ),
      createWebviewPanel: () => ({
        webview: { postMessage: () => {}, onDidReceiveMessage: () => {}, asWebviewUri: (u) => u },
        onDidDispose: () => {}, reveal: () => {}, dispose: () => {},
      }),
    },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    EventEmitter: class {
      constructor() {
        this._listeners = [];
        // 与真实 API 一致：`event` 是「注册订阅」的函数（不是数组）
        this.event = (listener) => {
          this._listeners.push(listener);
          return { dispose: () => { this._listeners = this._listeners.filter((l) => l !== listener); } };
        };
      }
      fire(value) { for (const l of [...this._listeners]) { l(value); } }
      dispose() { this._listeners = []; }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { One: 1, Two: 2 },
    commands: {
      executeCommand: async (cmd, ...args) => { commandLog.push({ cmd, args }); },
      registerCommand: () => ({ dispose: () => {} }),
    },
    tasks: { registerTaskProvider: () => ({ dispose: () => {} }) },
    Task: class {
      constructor(definition, scope, name, source, execution) {
        this.definition = definition;
        this.scope = scope;
        this.name = name;
        this.source = source;
        this.execution = execution;
      }
    },
    TaskScope: { Global: 1, Workspace: 2 },
    CustomExecution: class {
      constructor(callback) { this.callback = callback; }
    },
    env: { clipboard: { writeText: async () => {} } },
  };

  const origResolve = Module._resolveFilename;
  if (!Module.__vsojPatched) {
    Module.__vsojPatched = true;
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'vscode') { return 'vscode-stub'; }
      return origResolve.call(this, request, ...rest);
    };
  }
  require.cache['vscode-stub'] = {
    id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub,
  };

  return {
    workspaceFolder, globalStorage, vscode: vscodeStub, config, commandLog,
    root: path.dirname(__dirname),
  };
}

/** 极简断言器 */
function makeChecker() {
  const state = { failures: 0, total: 0 };
  const check = (label, actual, expected) => {
    state.total++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) { state.failures++; }
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}${ok ? '' : `  ← 期望 ${JSON.stringify(expected)}`}`);
    return ok;
  };
  const ok = (label, cond) => check(label, !!cond, true);
  const done = () => {
    console.log(state.failures === 0
      ? `\n✅ 全部通过（${state.total} 项断言）`
      : `\n❌ ${state.failures}/${state.total} 项失败`);
    return state.failures === 0;
  };
  return { check, ok, done, state };
}

/** 内存版 Memento（用于 SessionGuard） */
function makeMemoryMemento() {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    update: (k, v) => { if (v === undefined) { map.delete(k); } else { map.set(k, v); } },
    _dump: () => Object.fromEntries(map),
  };
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 造一个访问闸门（`out/session/access.js` 的 AccessGate）。
 *
 * 默认是「已登录 + 跟随真实离线开关」——也就是测试里最常需要的档位：
 * 离线开关是**运行时可变**的（用例中途翻转它），写死会让离线场景假通过。
 * 需要别的档位时按需覆盖。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.loggedIn=true]
 * @param {boolean} [opts.forcedOffline]      指定则写死，不指定则跟随 `oj.cache.offline`
 */
function makeAccessGate(opts = {}) {
  const { AccessGate } = require('../../out/session/access.js');
  const gate = new AccessGate({
    isLoggedIn: opts.isLoggedIn ?? (() => opts.loggedIn !== false),
    // 显式给了 forcedOffline 就写死；没给则跟随真实配置（离线开关是运行时可变项）
    isForcedOffline: opts.isForcedOffline
      ?? (opts.forcedOffline !== undefined
        ? () => !!opts.forcedOffline
        : () => require('../../out/utils/config.js').isOfflineMode()),
    onSessionLost: opts.onSessionLost,
    log: opts.log,
  });
  return { gate };
}

module.exports = {
  installVscodeStub, makeChecker, makeMemoryMemento, cleanup, sleep, makeAccessGate,
};
