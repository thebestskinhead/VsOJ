import * as vscode from 'vscode';

/** 用户配置读取 */

export function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('oj');
}

export function getBaseUrl(): string {
  const url = getConfig().get<string>('baseUrl', 'http://localhost');
  return url.replace(/\/+$/, '');
}

export function getStatusViewMode(): 'output' | 'webview' | 'browser' {
  return getConfig().get<'output' | 'webview' | 'browser'>('statusViewMode', 'browser');
}

/**
 * 待判定提交的轮询起始间隔（毫秒）—— output 文本表格与 webview 结果页共用。
 *
 * 站点自己的状态页用 80ms 起步、逐次翻倍；那是页面直连同机 OJ 的量级。
 * 我们每次轮询都要过一层扩展的 HTTP 客户端（可能还套着 WebVPN），
 * 所以起点调宽、并且**始终逐次翻倍封顶**。
 */
export function getStatusPollInterval(): number {
  const raw = getConfig().get<number>('statusPollInterval', 800);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 800;
}

export function getMcpEnabled(): boolean {
  return getConfig().get<boolean>('mcp.enabled', false);
}

export function getMcpPort(): number {
  return getConfig().get<number>('mcp.port', 9527);
}

// ============================================================
// 缓存 / 工作区
// ============================================================

/** 缓存根目录名（相对工作区根）；空值回退 `.vsoj` */
export function getWorkspaceRootName(): string {
  const v = getConfig().get<string>('workspace.root', '.vsoj').trim();
  return v || '.vsoj';
}

export function isCacheEnabled(): boolean {
  return getConfig().get<boolean>('cache.enabled', true);
}

export function isOfflineMode(): boolean {
  return getConfig().get<boolean>('cache.offline', false);
}

/** 缓存 TTL（毫秒）；负数表示永不过期 */
export function getCacheTtlMs(): number {
  const sec = getConfig().get<number>('cache.ttlSeconds', 180);
  return sec < 0 ? -1 : sec * 1000;
}

/**
 * 「异步刷新」阈值（毫秒）——重访题面时，超过该年龄才在后台重新拉取。
 *
 * 与 {@link getCacheTtlMs} 的分工：
 *  - `ttlSeconds`（默认 180s）管**同步读**：命中且新鲜就直接用，不发起任何请求
 *    （用于比赛列表 / 题目列表 / 提交状态这类轻量数据）
 *  - `staleSeconds`（默认 900s）管**异步刷**：先渲染缓存，超过该年龄才后台刷新
 *    （用于题面）
 *
 * 两者不冲突：题面不使用 `ttlSeconds`。
 */
export function getStaleTtlMs(): number {
  const sec = getConfig().get<number>('cache.staleSeconds', 900);
  return sec < 0 ? -1 : sec * 1000;
}

// ============================================================
// 比赛项目（本地工作区）
// ============================================================

/** 是否启用「比赛项目」相关能力（关闭后退化为纯网页客户端：不写盘、不分栏） */
export function isProjectEnabled(): boolean {
  return getConfig().get<boolean>('project.enabled', true);
}

/** 点开题目时是否自动把该题落到磁盘（懒初始化，D14 默认开） */
export function isLazyInitEnabled(): boolean {
  return getConfig().get<boolean>('project.lazyInit', true);
}

/** 题目源文件名（D8 默认 `main.cpp`） */
export function getSourceFileName(): string {
  const v = getConfig().get<string>('project.sourceFileName', 'main.cpp').trim();
  return v || 'main.cpp';
}

// ============================================================
// 本地测试（S6）
// ============================================================

/** 选中的工具链 id；`auto` = 按源文件扩展名自动匹配 */
export function getTestToolchainId(): string {
  const v = getConfig().get<string>('test.toolchain', 'auto').trim();
  return v || 'auto';
}

/** `toolchains.json` 的位置（相对工作区根，或绝对路径） */
export function getToolchainsFile(): string {
  const v = getConfig().get<string>('test.toolchainsFile', '.vsoj/toolchains.json').trim();
  return v || '.vsoj/toolchains.json';
}

/**
 * 额外的命令搜索目录。
 *
 * 内置只搜通用位置（`C:\mingw64\bin`、`/usr/bin`…），本机便携环境/多版本目录写这里，
 * 也可以直接在 toolchains.json 里把命令写成绝对路径。
 */
export function getTestSearchDirs(): string[] {
  const v = getConfig().get<string[]>('test.searchDirs', []) || [];
  return v.filter((x) => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
}

/**
 * 产物复用开关。
 *
 * 默认 **关**（= 每次重新编译）：刷题时「调试到的不是我刚改的代码」比多等两秒难受得多。
 * 开起来后按「源文件内容 + 工具链 + 编译模板」的哈希复用，改回原内容也能命中。
 */
export function isBuildReuseEnabled(): boolean {
  return getConfig().get<boolean>('test.reuseBuild', false) === true;
}

/** 跑完本地测试后的结果页行为 */
export type TestResultPageMode = 'always' | 'onFailure' | 'never';

/**
 * 结果页弹出策略（默认 `always`）。
 *
 * 用户决策：**每次测试都弹**（D13）——刷题时「跑完看不到结果」会让人反复手动开报告。
 * 认不出的值一律退回默认，避免配置写错就静默不弹。
 */
export function getTestResultPageMode(): TestResultPageMode {
  const v = getConfig().get<string>('test.resultPage', 'always');
  return v === 'onFailure' || v === 'never' ? v : 'always';
}

/** 看门狗默认阈值（可被 toolchains.json 里单个工具链的字段覆盖） */
export function getTestLimits(): { timeoutMs: number; maxOutputBytes: number; maxMemoryBytes: number } {
  const cfg = getConfig();
  const num = (key: string, dflt: number): number => {
    const v = cfg.get<number>(key, dflt);
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    timeoutMs: num('test.timeoutMs', 10000),
    maxOutputBytes: num('test.maxOutputBytes', 64 * 1024 * 1024),
    maxMemoryBytes: num('test.maxMemoryBytes', 2 * 1024 * 1024 * 1024),
  };
}

/** 侧边栏「初始化项目」条目是否允许出现（D2；`false` 则彻底关闭） */
export function isInitEntryVisible(): boolean {
  return getConfig().get<boolean>('project.initEntryVisible', true);
}

// ============================================================
// 会话保活
// ============================================================

/** 心跳间隔（毫秒）；0 表示关闭 */
export function getKeepAliveIntervalMs(): number {
  return Math.max(0, getConfig().get<number>('session.keepAliveInterval', 240000));
}

/** 登录态探测间隔（毫秒）；0 表示只跟随心跳探测 */
export function getSessionProbeIntervalMs(): number {
  return Math.max(0, getConfig().get<number>('session.probeInterval', 600000));
}

/** 识别到登录失效时，是否自动打开登录页 */
export function getAutoRelogin(): boolean {
  return getConfig().get<boolean>('session.autoRelogin', true);
}

/** 重新登录成功后，是否自动恢复比赛/题目上下文并回到提交页 */
export function getAutoReplaySubmit(): boolean {
  return getConfig().get<boolean>('session.autoReplaySubmit', true);
}
