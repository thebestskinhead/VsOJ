/**
 * 插件配置说明书 —— 单一真相源。
 *
 * 为什么要有这个文件：本插件的配置分散在三个地方（`package.json` 的声明、
 * `toolchains.json` 的文件格式、以及只有读代码才知道的语义差别），而配置它的人——
 * 越来越多是 AI。让 AI 去啃 `package.json` 只能拿到一句 `markdownDescription`，
 * 讲不清「`cache.ttlSeconds` 和 `cache.staleSeconds` 到底谁管谁」这类语义，
 * 更不知道「产物名固定叫 main.exe」「PATH 不继承外层环境」这些一踩就废的坑。
 *
 * 分工（这是本文件存在的全部理由）：
 *  - **结构**（键名 / 类型 / 默认值 / 枚举）运行时从 `package.json` 生成
 *    → 加一个配置项，说明书自动多一行，**不可能漏**；
 *  - **语义**（用途 / 取值 / 示例 / 坑）写在下面的 {@link CONFIG_SEMANTICS} 里
 *    → 由一致性测试保证「没有配置项缺语义说明」，**也不可能漂**。
 *
 * 两份渲染产物：MCP 工具 `get_config_manual` 的返回值与 `docs/CONFIG.md`
 * 都来自 {@link renderManual}，故永远一致。
 */

// ============================================================
// 语义表
// ============================================================

export interface ConfigSemantic {
  /** 一句话用途 */
  summary: string;
  /** 分组（说明书的排版单位） */
  group: ConfigGroup;
  /** 补充语义：相邻项的区别、为什么这么设计 */
  detail?: string;
  /** 取值约束（枚举 / 范围 / 格式），`package.json` 表达不了的 */
  values?: string;
  /** 典型示例 */
  example?: string;
  /** 坑：设错了会发生什么 */
  pitfall?: string;
  /** 不配就用不了 */
  required?: boolean;
  /** 读取它的函数名 —— 用于自动核对「声明了到底有没有人用」（见 test/config-manual.test.js） */
  getter?: string;
  /** 当前版本声明了但**没有被真正消费**：说明书必须写明，否则 AI 以为改了有用 */
  unused?: boolean;
}

export const CONFIG_GROUPS = [
  '平台接入',
  '会话与登录',
  '缓存与工作区',
  '比赛项目',
  '本地测试',
  'MCP 服务器',
] as const;

export type ConfigGroup = typeof CONFIG_GROUPS[number];

/** 键名**不带** `oj.` 前缀，与代码里 `get('x.y')` 一致 */
export const CONFIG_SEMANTICS: Record<string, ConfigSemantic> = {
  // ── 平台接入 ────────────────────────────────────────────────
  baseUrl: {
    group: '平台接入',
    summary: 'OJ 平台的根地址，所有请求的基准',
    required: true,
    detail: '插件不内置任何站点地址（public 插件不能假设你用哪个 OJ）。'
      + '必须是能打开 HUSTOJ 首页的地址；末尾多余的 `/` 会被自动去掉。',
    values: '`http://` 或 `https://` 开头的完整地址，不含路径',
    example: '"http://acm.example.edu.cn"',
    pitfall: '默认值 `http://localhost` 只是占位符，不改它插件等于没配 —— '
      + '表现为列表空白、登录页打不开，而不是报错。',
    getter: 'getBaseUrl',
  },
  defaultLanguage: {
    group: '平台接入',
    summary: '默认提交语言',
    values: '站点 `submit.php` 的语言名，如 `cpp` / `c` / `java` / `python`',
    pitfall: '**当前版本该配置项没有被真正消费**：`getDefaultLanguage()` 没有任何调用方，'
      + '提交页的语言是独立选择的。设它不会有任何效果，别在它上面花时间。',
    unused: true,
    getter: 'getDefaultLanguage',
  },
  autoRefreshStatus: {
    group: '平台接入',
    summary: '（声明为）提交后是否自动刷新判题状态',
    detail: '**当前版本该配置项没有被真正消费**：自动刷新实际由命令 '
      + '`oj.toggleStatusAutoRefresh` 控制一个**运行期内存标志**（`statusPanel.toggleAutoRefresh()`），'
      + '与这个设置无关。',
    pitfall: '设它不会有任何效果。想控制自动刷新请用命令 `oj.toggleStatusAutoRefresh`，'
      + '它只在本次会话内有效。',
    unused: true,
    getter: 'getAutoRefreshStatus',
  },
  statusRefreshInterval: {
    group: '平台接入',
    summary: '判题状态自动刷新的间隔（毫秒）',
    values: '正整数；站点判题通常需要数秒，低于 1000 意义不大',
    example: '5000',
    getter: 'getStatusRefreshInterval',
  },
  statusViewMode: {
    group: '平台接入',
    summary: '判题状态在哪里显示',
    values: '`browser` 外部浏览器 / `webview` 内嵌页面 / `output` 文本表格',
    detail: '`browser` 最完整（站点原样渲染，含样式与交互）；`webview` 在编辑器内不跳窗口；'
      + '`output` 最轻，适合只想扫一眼结果。',
    pitfall: '填了三个之外的值不会报错，会静默按 `browser` 走。',
    getter: 'getStatusViewMode',
  },

  // ── 会话与登录 ──────────────────────────────────────────────
  'session.keepAliveInterval': {
    group: '会话与登录',
    summary: '会话保活心跳间隔（毫秒），`0` 关闭',
    detail: 'HUSTOJ 的登录态会过期；定时发一次轻量请求把会话续上，'
      + '避免「提交到一半发现已登出」。',
    values: '非负整数；`0` = 完全关闭心跳',
    example: '240000（4 分钟）',
    getter: 'getKeepAliveIntervalMs',
  },
  'session.probeInterval': {
    group: '会话与登录',
    summary: '登录态探测间隔（毫秒），`0` 表示仅跟随心跳探测',
    detail: '探测会**真发一个需要登录的请求**来判断登录态，比心跳重，所以默认间隔更长。',
    values: '非负整数；`0` = 不做独立探测',
    example: '600000（10 分钟）',
    getter: 'getSessionProbeIntervalMs',
  },
  'session.autoRelogin': {
    group: '会话与登录',
    summary: '识别到登录失效时自动打开登录页',
    getter: 'getAutoRelogin',
  },
  'session.autoReplaySubmit': {
    group: '会话与登录',
    summary: '重新登录成功后，自动恢复原比赛/题目上下文并回到提交页',
    detail: '配合 `autoRelogin` 形成闭环：登出 → 自动登录 → 回到刚才那题 → 继续提交。',
    getter: 'getAutoReplaySubmit',
  },

  // ── 缓存与工作区 ────────────────────────────────────────────
  'workspace.root': {
    group: '缓存与工作区',
    summary: '本地数据根目录名（相对工作区根）',
    detail: '缓存、比赛项目、工具链配置都放在它下面。空值回退 `.vsoj`。',
    values: '目录名，相对工作区根；建议保持 `.vsoj` 以便加进 `.gitignore`',
    pitfall: '改这里等于换了一个数据根，**旧缓存不会再被读到**（不会迁移）。',
    getter: 'getWorkspaceRootName',
  },
  'cache.enabled': {
    group: '缓存与工作区',
    summary: '是否把比赛 / 题目 / 状态写入本地缓存',
    detail: '关掉后退化为「纯网页客户端」：每次都要联网，但也不会有残留文件。',
    getter: 'isCacheEnabled',
  },
  'cache.ttlSeconds': {
    group: '缓存与工作区',
    summary: '**同步读**的缓存有效期（秒），负数 = 永不过期',
    detail: '管的是「命中且新鲜就直接用，**不发任何请求**」这条快路径，'
      + '用于比赛列表 / 题目列表这类轻量数据。题目详情**不走**它（走 `staleSeconds`）。',
    values: '整数；负数表示永不过期',
    example: '180',
    getter: 'getCacheTtlMs',
  },
  'cache.staleSeconds': {
    group: '缓存与工作区',
    summary: '**异步刷新**的年龄阈值（秒），负数 = 永不过期',
    detail: '与 `ttlSeconds` 分工不同、**不冲突**：这里管的是「先渲染缓存，'
      + '超过这个年龄才在后台重新拉」。题目详情页用的就是它。',
    values: '整数；负数表示永不过期',
    example: '900',
    getter: 'getStaleTtlMs',
  },
  'cache.offline': {
    group: '缓存与工作区',
    summary: '离线模式：只读本地缓存，不发起网络请求',
    detail: '适合断网/机房无网时翻已缓存过的题目。缓存里没有的内容会直接失败，'
      + '不会偷偷联网。',
    getter: 'isOfflineMode',
  },

  // ── 比赛项目 ────────────────────────────────────────────────
  'project.enabled': {
    group: '比赛项目',
    summary: '是否启用「比赛项目」能力（进比赛自动建目录、左右分栏）',
    detail: '关掉后退化为纯网页客户端：**不写盘、不分栏**，题目只在 webview 里看。',
    pitfall: '关掉它之后 `project.*` 其余项与 `test.*` 整套都会失效 ——'
      + '本地测试依赖题目目录里的 `samples/` 与 `main.cpp`。',
    getter: 'isProjectEnabled',
  },
  'project.lazyInit': {
    group: '比赛项目',
    summary: '点开题目时是否自动把该题落到磁盘（懒初始化）',
    detail: '开 = 看哪题建哪题，省磁盘；关 = 进入比赛时一次性预取全部题目。',
    getter: 'isLazyInitEnabled',
  },
  'project.sourceFileName': {
    group: '比赛项目',
    summary: '题目源文件名（不含扩展名的部分要自己带上）',
    example: '"main.cpp"',
    pitfall: '**已存在的主源文件永远不会被覆盖**（这是硬契约），所以改这个值只会影响'
      + '**之后新建**的题目目录，不会重命名已有文件。',
    getter: 'getSourceFileName',
  },
  'project.initEntryVisible': {
    group: '比赛项目',
    summary: '侧边栏是否显示「初始化项目」条目',
    detail: '`false` = 彻底关闭这个入口（不是隐藏按钮而是不注册），界面更干净。',
    getter: 'isInitEntryVisible',
  },

  // ── 本地测试 ────────────────────────────────────────────────
  'test.toolchain': {
    group: '本地测试',
    summary: '使用哪套工具链',
    values: '`auto` = 按源文件扩展名自动匹配；或填 `toolchains.json` 里某个定义的 `id`',
    detail: '内置四套：`cpp-g++` / `c-gcc` / `java` / `python`。'
      + '指定了不存在的 id 会明确报错并列出现有 id（不会静默回退到 auto）。',
    pitfall: '文件扩展名不在任何工具链的 `extensions` 里时，`auto` 会失败并列出可用组合。',
    getter: 'getTestToolchainId',
  },
  'test.toolchainsFile': {
    group: '本地测试',
    summary: '工具链定义文件的位置',
    values: '相对工作区根的路径，或绝对路径',
    example: '".vsoj/toolchains.json"',
    detail: '内置工具链写在代码里、**不需要**在这个文件里重复声明；'
      + '这里只放你的覆盖与新增（同 `id` 覆盖内置，并保留「内置」标记）。',
    getter: 'getToolchainsFile',
  },
  'test.searchDirs': {
    group: '本地测试',
    summary: '额外的命令搜索目录（编译器不在 PATH 时用）',
    values: '目录绝对路径数组',
    example: '["D:\\\\tools\\\\mingw64\\\\bin", "/opt/homebrew/opt/llvm/bin"]',
    detail: '查找顺序：配置里的绝对路径 → PATH → `searchDirs` → 内置通用目录。'
      + '也可以不写这里，直接在 `toolchains.json` 里把命令写成绝对路径。',
    pitfall: '**这是「AI 扫描本机后最该写的地方」**：插件不内置任何个人环境路径，'
      + '编译器不在 PATH 时只有靠它或绝对路径才找得到。',
    getter: 'getTestSearchDirs',
  },
  'test.reuseBuild': {
    group: '本地测试',
    summary: '复用上次的编译产物',
    detail: '默认 **false**（每次重新编译）。开起来后按「源文件内容 + 工具链 + 编译模板」的'
      + '哈希复用，改完再改回去也能命中 —— 是内容哈希而非时间戳。',
    pitfall: '开着它时，改的是**别的文件**（如被 include 的头文件）不会让哈希变化，'
      + '可能跑到旧产物；调试前想要 100% 新鲜就用「强制重新编译」。',
    getter: 'isBuildReuseEnabled',
  },
  'test.timeoutMs': {
    group: '本地测试',
    summary: '单个用例的运行超时（毫秒）',
    detail: '属于「宽松看门狗」：触发只会终止运行并把超时记为**运行事实**，'
      + '判定依旧只看输出文件比对结果。',
    values: '正整数',
    example: '10000',
    pitfall: '调太小会让正常但偏慢的解法（暴力枚举）频繁被砍，看起来像程序有 bug。',
    getter: 'getTestLimits',
  },
  'test.maxOutputBytes': {
    group: '本地测试',
    summary: '单个用例的输出体积上限（字节）',
    detail: '防死循环狂打印把磁盘写爆的那道闸。超出即终止运行。',
    values: '正整数',
    example: '67108864（64 MB）',
    getter: 'getTestLimits',
  },
  'test.maxMemoryBytes': {
    group: '本地测试',
    summary: '单个用例的驻留内存上限（字节）',
    detail: '**这是看门狗不是硬限制**：Windows 没有 cgroup，只能轮询（约 1 秒一次），'
      + '存在误差、也可能误杀。想要精确限制得靠容器/沙箱，不在本插件范围内。',
    values: '正整数',
    example: '2147483648（2 GB）',
    getter: 'getTestLimits',
  },

  // ── MCP 服务器 ──────────────────────────────────────────────
  'mcp.enabled': {
    group: 'MCP 服务器',
    summary: '插件启动时是否自动启动 MCP 服务器',
    detail: 'MCP 是 AI 与本插件交互的通道（AI 靠它读题、跑测试、写配置）。'
      + '也可用状态栏按钮或命令手动启停。',
    getter: 'getMcpEnabled',
  },
  'mcp.port': {
    group: 'MCP 服务器',
    summary: 'MCP 服务器监听端口',
    detail: '只监听 `127.0.0.1`，不对外暴露。',
    example: '9527',
    pitfall: '端口被占用时启动会失败并提示换端口 —— 那时 AI 客户端的 MCP 配置里也要同步改。',
    getter: 'getMcpPort',
  },
};

// ============================================================
// 目录构建（结构来自 package.json，语义来自上表）
// ============================================================

export interface ConfigEntry {
  /** 带前缀的完整键，如 `oj.baseUrl` */
  key: string;
  /** 代码里读的子键名，如 `baseUrl` */
  id: string;
  type: string;
  def: any;
  /** `package.json` 里的 markdownDescription 原文 */
  description: string;
  enum?: any[];
  semantic?: ConfigSemantic;
}

export interface Catalog {
  entries: ConfigEntry[];
  /** 声明了但缺语义说明 —— 说明书会漏信息，测试会红 */
  missingSemantics: string[];
  /** 语义表里有、但 `package.json` 没声明 —— 残留，测试会红 */
  unknownSemantics: string[];
}

/** 从 `package.json` 内容构建配置目录（结构与语义合并） */
export function buildCatalog(pkg: any): Catalog {
  const props: Record<string, any> = pkg?.contributes?.configuration?.properties ?? {};
  const entries: ConfigEntry[] = [];
  const seen = new Set<string>();

  for (const [key, def] of Object.entries(props)) {
    if (!key.startsWith('oj.')) { continue; }
    const id = key.slice(3);
    seen.add(id);
    entries.push({
      key,
      id,
      type: String(def?.type ?? 'unknown'),
      def: def?.default,
      description: String(def?.markdownDescription ?? def?.description ?? ''),
      enum: Array.isArray(def?.enum) ? def.enum : undefined,
      semantic: CONFIG_SEMANTICS[id],
    });
  }

  const missingSemantics = entries.filter((e) => !e.semantic).map((e) => e.key);
  const unknownSemantics = Object.keys(CONFIG_SEMANTICS)
    .filter((id) => !seen.has(id))
    .map((id) => `oj.${id}`);

  return { entries, missingSemantics, unknownSemantics };
}

/** 运行时读真实 `package.json`（打包后 `src/` 不在包里，只能走文件） */
export function buildCatalogFromFile(packageJsonPath: string): Catalog {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = require('fs').readFileSync(packageJsonPath, 'utf8');
  return buildCatalog(JSON.parse(raw));
}

// ============================================================
// 工具链定义文档
// ============================================================

/** `ToolchainDef` 的字段说明（本插件第二处需要 AI 写的地方） */
export const TOOLCHAIN_FIELDS: Array<{ field: string; required?: boolean; desc: string }> = [
  { field: 'id', required: true, desc: '唯一标识。与内置 `id` 相同 = 覆盖内置（保留「内置」标记，不可删）' },
  { field: 'label', desc: '显示名，只用于展示' },
  { field: 'kind', desc: '`compiled` 编译型 / `interpreted` 解释型。不写时按有无 `compile` 自动推断' },
  { field: 'extensions', required: true, desc: '认领哪些源文件扩展名（含点），如 `[".cpp", ".cc"]`' },
  { field: 'commands', required: true, desc: '命令名 → 候选列表。每个候选按「绝对路径 → PATH → searchDirs → 通用目录」解析，第一个存在的胜出' },
  { field: 'compile', desc: '编译命令模板（编译型必需）。占位符：`{source}` `{output}` `{dir}` `{stem}` `{ext}` `{<命令名>}`' },
  { field: 'run', required: true, desc: '运行命令模板。占位符：`{runnable}` `{dir}` `{stem}` 与各命令名' },
  { field: 'env', desc: '额外环境变量。**写了 `env.PATH` 就完全采纳它**（逃生口），不再自动推导' },
  { field: 'pathPrepend', desc: '追加到子进程 PATH 前面的目录（在自动推导之上追加）' },
  { field: 'timeoutMs', desc: '覆盖全局超时' },
  { field: 'maxOutputBytes', desc: '覆盖全局输出上限' },
  { field: 'maxMemoryBytes', desc: '覆盖全局内存看门狗阈值' },
  { field: 'asciiSafeOutput', desc: '声明「传给编译器的产物路径必须纯 ASCII」。MinGW 的 `ld` 实测有这毛病，内置 C/C++ 已声明；Java/Python 不需要' },
];

/** 命令解析顺序（`resolveCommands` 的真实行为，写进说明书以免 AI 反复试错） */
export const COMMAND_RESOLUTION_ORDER = [
  '命令候选本身写成绝对路径且该文件存在',
  '`PATH` 环境变量里的目录（Windows 按 `.exe` → `.cmd` → `.bat` 依次试）',
  '`oj.test.searchDirs` 里的目录（按数组顺序）',
  '内置通用目录（`C:\\mingw64\\bin`、`/usr/bin`、`/opt/homebrew/bin` 等）',
];

/** 子进程 PATH 的构造规则（契约 C5，踩过坑） */
export const PATH_INJECTION_NOTE = '子进程的 `PATH` **不继承外层环境**，只由'
  + '「已解析命令所在目录」+ `pathPrepend` 拼成。原因：MinGW 的产物依赖同目录的 '
  + '`libstdc++-6.dll`，实测不注入就直接 exit 127（表现为「所有样例都失败」）。'
  + '要完全接管就在 `env.PATH` 里写死。';

// ============================================================
// 渲染
// ============================================================

export type ManualSection = 'all' | 'quickstart' | 'settings' | 'toolchains' | 'files' | 'pitfalls';

export const MANUAL_SECTIONS: ManualSection[] = ['all', 'quickstart', 'settings', 'toolchains', 'files', 'pitfalls'];

function fmtDefault(v: any): string {
  if (v === undefined) { return '—'; }
  const s = JSON.stringify(v);
  return `\`${s.length > 40 ? s.slice(0, 37) + '…' : s}\``;
}

/** 全部配置项速查表 */
function renderSettingsTable(entries: ConfigEntry[]): string {
  const rows = entries.map((e) => {
    const sem = e.semantic;
    const flags = [sem?.required ? '**必需**' : '', sem?.unused ? '⚠️ 未生效' : '']
      .filter(Boolean).join(' ');
    return `| \`${e.key}\` | ${e.type} | ${fmtDefault(e.def)} | ${sem?.summary ?? '（缺说明）'} | ${flags} |`;
  });
  return [
    '| 配置项 | 类型 | 默认值 | 用途 | 标记 |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/** 按分组的明细（AI 主要读这一段） */
function renderSettingsDetail(entries: ConfigEntry[]): string {
  const out: string[] = [];
  for (const group of CONFIG_GROUPS) {
    const groupEntries = entries.filter((e) => e.semantic?.group === group);
    if (groupEntries.length === 0) { continue; }
    out.push(`### ${group}`, '');
    for (const e of groupEntries) {
      const sem = e.semantic!;
      out.push(`#### \`${e.key}\``, '');
      out.push(`- **用途**：${sem.summary}`);
      out.push(`- **类型**：\`${e.type}\`｜**默认值**：${fmtDefault(e.def)}`
        + (e.enum ? `｜**可选值**：${e.enum.map((x) => `\`${x}\``).join(' / ')}` : ''));
      if (sem.required) { out.push('- **必需**：不配则核心功能不可用'); }
      if (sem.unused) { out.push('- ⚠️ **当前版本未生效**：声明了但没有代码消费它'); }
      if (sem.values) { out.push(`- **取值**：${sem.values}`); }
      if (sem.detail) { out.push(`- **说明**：${sem.detail}`); }
      if (sem.example) { out.push(`- **示例**：\`${sem.example}\``); }
      if (sem.pitfall) { out.push(`- ⚠️ **坑**：${sem.pitfall}`); }
      if (e.description) { out.push(`- **设置面板原文**：${e.description}`); }
      if (e.semantic?.getter) { out.push(`- **读取处**：\`${e.semantic.getter}()\``); }
      out.push('');
    }
  }
  return out.join('\n');
}

function renderQuickstart(entries: ConfigEntry[]): string {
  const required = entries.filter((e) => e.semantic?.required).map((e) => `\`${e.key}\``);
  return [
    '## 1. 初始化配置（给 AI 的操作顺序）',
    '',
    '配置本插件的正确姿势是**先读说明书、再由 AI 探测本机、最后调工具写进去**，'
      + '而不是让用户去设置面板里逐个找。三步：',
    '',
    '### 第 1 步：读说明书',
    '',
    '调 MCP 工具 `get_config_manual`（`section` 可只取需要的部分：'
      + '`quickstart` / `settings` / `toolchains` / `files` / `pitfalls`）。',
    '',
    '### 第 2 步：探测本机（这一步插件不做，由 AI 自己扫）',
    '',
    '插件**不内置任何个人环境路径**，也不会扫盘找编译器 —— 那是 AI 的活：',
    '',
    '1. 先试 `PATH` 里有没有：`g++ --version` / `python --version` / `javac -version`；',
    '2. 没有就问用户 / 找常见的便携环境与包管理器目录'
      + '（MSYS2、MinGW、LLVM、Visual Studio、conda、scoop/choco、homebrew）；',
    '3. 找到**可执行文件的绝对路径**，写进下面第 3 步的 `toolchains`。',
    '',
    '### 第 3 步：写进配置',
    '',
    '调 MCP 工具 `init_config`。**默认只预览不落盘**（`apply` 省略或 `false`），'
      + '返回「当前生效值 → 将要写入的值 + 探测/解析结果」；确认无误后再带 `apply: true` 落盘'
      + '（覆盖旧文件前会自动备份）。',
    '',
    '最小可用的一次调用（把 `baseUrl` 与编译器路径换成真实值）：',
    '',
    '```json',
    '{',
    '  "settings": { "oj.baseUrl": "http://acm.example.edu.cn", "oj.mcp.enabled": true },',
    '  "toolchains": [',
    '    {',
    '      "id": "cpp-g++",',
    '      "commands": { "gpp": ["D:\\\\tools\\\\mingw64\\\\bin\\\\g++.exe"] },',
    '      "pathPrepend": ["D:\\\\tools\\\\mingw64\\\\bin"]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '注意 `toolchains` 里**只写要覆盖的字段**，同 `id` 的其余字段继承内置（不必抄一遍命令模板）。',
    '',
    `**必需项**：${required.length ? required.join('、') : '（无）'}。`,
    '其余配置项都有合理默认值，不需要在初始化时全部写一遍。',
    '',
  ].join('\n');
}

function renderSettingsSection(entries: ConfigEntry[]): string {
  return [
    '## 2. 全部配置项',
    '',
    `共 ${entries.length} 项。**结构**（键名 / 类型 / 默认值）由 \`package.json\` 生成，`
      + '**语义**（取值 / 示例 / 坑）来自 `src/config/manual.ts`，两者由一致性测试保证不脱节。',
    '',
    renderSettingsTable(entries),
    '',
    '### 明细',
    '',
    renderSettingsDetail(entries),
  ].join('\n');
}

function renderFilesSection(): string {
  return [
    '## 3. 配置文件放在哪',
    '',
    '| 文件 | 位置 | 谁写 | 说明 |',
    '|---|---|---|---|',
    '| 插件设置 | 工作区 `.vscode/settings.json`（或全局 User settings） | AI（`init_config`）或用户 | `oj.*` 全部配置项 |',
    '| 工具链定义 | `.vsoj/toolchains.json`（可配 `oj.test.toolchainsFile` 改） | AI / 用户 | 只放覆盖与新增，内置四套在代码里 |',
    '| 本地数据 | `.vsoj/`（可配 `oj.workspace.root` 改） | 插件 | 缓存、比赛项目、题目目录 |',
    '| 题目工作目录 | `<工作区>/<cid>-<标题>/problems/<字母>-<标题>/` | 插件 | 该题的 `main.cpp` / `samples/` / `temp/` / `test/` |',
    '',
    '**优先级**：工作区设置 > 全局 User 设置 > `package.json` 里的默认值。',
    '`init_config` 默认写**工作区**级（`scope` 可用 `global` 改成全局）。',
    '',
    '`.vsoj/toolchains.json` 的形状：',
    '',
    '```json',
    '{',
    '  "toolchains": [',
    '    { "id": "cpp-g++", "commands": { "gpp": ["D:\\\\tools\\\\mingw64\\\\bin\\\\g++.exe"] } }',
    '  ]',
    '}',
    '```',
    '',
    '坏 JSON 或坏条目**不会让测试功能整体瘫痪**：解析器只记账并跳过，'
      + '`init_config` 的预览里会把问题列出来。',
    '',
  ].join('\n');
}

function renderToolchainsSection(): string {
  const fieldRows = TOOLCHAIN_FIELDS.map(
    (f) => `| \`${f.field}\`${f.required ? ' **必需**' : ''} | ${f.desc} |`,
  );
  return [
    '## 4. 工具链（本地测试的语言差异都关在这里）',
    '',
    '测试引擎对语言**一无所知**：它只做三件事 —— `prepare`（交给工具链）、'
      + '`run`（传入输入/输出文件地址）、`compare`（比输出文件）。'
      + '编译型与解释型的区别全由工具链定义吸收。',
    '',
    '### 内置四套',
    '',
    '| id | label | 认领扩展名 | 类型 |',
    '|---|---|---|---|',
    '| `cpp-g++` | C++ (g++) | `.cpp .cc .cxx .c++` | 编译型（`asciiSafeOutput`） |',
    '| `c-gcc` | C (gcc) | `.c` | 编译型（`asciiSafeOutput`） |',
    '| `java` | Java (javac/java) | `.java` | 编译型 |',
    '| `python` | Python | `.py` | 解释型 |',
    '',
    '### 字段',
    '',
    '| 字段 | 说明 |',
    '|---|---|',
    ...fieldRows,
    '',
    '### 命令是怎么找到的（顺序）',
    '',
    ...COMMAND_RESOLUTION_ORDER.map((s, i) => `${i + 1}. ${s}`),
    '',
    '> **PATH 注入**：' + PATH_INJECTION_NOTE,
    '',
    '### 固定约定（写死，别试图绕）',
    '',
    '- **产物名固定为 `main(.exe)`**，不派生自源文件名 —— 源文件名用户可配、可能含中文，'
      + '派生会重新踩到下面的坑。',
    '- **产物落在题目目录的 `temp/`**，报告与 `test/result.json` 也写在 `test/`。',
    '- **非 ASCII 路径**：Windows 上 MinGW 的 `ld` 无法在含中文的产物路径下创建文件'
      + '（`cannot open output file ...: No such file or directory`）。'
      + '引擎用**相对路径**根治（命令行里因此不含任何非 ASCII 字符）；'
      + '声明了 `asciiSafeOutput` 的工具链才会走这条路径，跨盘等无解情况才退回 ASCII 中转目录。',
    '- **用例发现**：`samples/` 下按序号成对的 `N.in` / `N.out` 全跑；'
      + '只有 `N.in` 没有 `N.out` 的「半对」会跳过并在报告里点名（不静默忽略）。',
    '- **判定只有通过 / 不通过**：退出码、耗时、是否被看门狗砍都只是**运行事实**，不参与判定。',
    '',
    '### 新增一套语言',
    '',
    '在 `.vsoj/toolchains.json` 里加一个 `id` 不在内置列表里的定义即可，例如：',
    '',
    '```json',
    '{',
    '  "toolchains": [',
    '    {',
    '      "id": "go",',
    '      "label": "Go",',
    '      "extensions": [".go"],',
    '      "commands": { "go": ["go"] },',
    '      "compile": "\\"{go}\\" build -o \\"{output}\\" \\"{source}\\"",',
    '      "run": "\\"{runnable}\\""',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '写完把 `oj.test.toolchain` 设为 `"go"`（或保持 `auto` 让它按扩展名匹配）。',
    '',
  ].join('\n');
}

function renderPitfalls(entries: ConfigEntry[]): string {
  const pitfalls = entries.filter((e) => e.semantic?.pitfall);
  const unused = entries.filter((e) => e.semantic?.unused);
  return [
    '## 5. 常见坑（都是踩过的）',
    '',
    ...pitfalls.map((e) => `- **\`${e.key}\`**：${e.semantic!.pitfall}`),
    '',
    '### 声明了但当前版本没生效',
    '',
    unused.length
      ? unused.map((e) => `- \`${e.key}\`：${e.semantic!.summary}`).join('\n')
      : '（无）',
    '',
    '这些项在设置面板里看得到、改了也没反应。列出来是为了**不让人以为是配置写错了**。',
    '',
  ].join('\n');
}

export interface RenderOptions {
  /** 只渲染某一部分，默认全部 */
  section?: ManualSection;
  /** 自定义生成时间戳行；不传则不写时间（保证断言可比较） */
  generatedAt?: string;
  /** 是否带「本文件自动生成」的头部（`docs/CONFIG.md` 要，MCP 返回值不要） */
  withHeader?: boolean;
}

/** 渲染说明书。MCP 工具返回值与 `docs/CONFIG.md` 都走这里 → 两边永远一致。 */
export function renderManual(catalog: Catalog, opts: RenderOptions = {}): string {
  const section = opts.section ?? 'all';
  const entries = catalog.entries;
  const parts: string[] = [];

  if (opts.withHeader) {
    parts.push(
      '# VsOJ 配置说明书',
      '',
      '> 本文件由 `npm run docs:config` 生成，**请勿手改**。',
      '> 生成源：`package.json`（键名/类型/默认值）+ `src/config/manual.ts`（语义）。',
      '> 与 MCP 工具 `get_config_manual` 的返回值同源，因此不会出现「文档说的和插件做的不一样」。',
      '',
      '这是**给 AI 读的插件说明书**：AI 靠它知道本插件能配什么、怎么配、以及哪里一踩就废，',
      '进而自行完成配置（探测本机 → 调 `init_config` 落盘）。',
      '',
    );
    if (opts.generatedAt) { parts.push(`生成时间：${opts.generatedAt}`, ''); }
  }

  const want = (s: ManualSection) => section === 'all' || section === s;

  if (want('quickstart')) { parts.push(renderQuickstart(entries), ''); }
  if (want('settings')) { parts.push(renderSettingsSection(entries), ''); }
  if (want('files')) { parts.push(renderFilesSection(), ''); }
  if (want('toolchains')) { parts.push(renderToolchainsSection(), ''); }
  if (want('pitfalls')) { parts.push(renderPitfalls(entries), ''); }

  if (catalog.missingSemantics.length || catalog.unknownSemantics.length) {
    parts.push(
      '## 附：说明书自身的完整性问题',
      '',
      catalog.missingSemantics.length
        ? `- 以下配置项**缺少语义说明**（只能给出键名与默认值）：${catalog.missingSemantics.join('、')}`
        : '',
      catalog.unknownSemantics.length
        ? `- 以下语义条目**已无对应配置项声明**：${catalog.unknownSemantics.join('、')}`
        : '',
      '',
    );
  }

  // 注意别把 `''` 滤掉：那些空行正是 markdown 的段落分隔，
  // 早先版本用 `filter(p => p !== '')`「顺手清理」，结果标题和正文全挤在一起了。
  // 只把连续 3 个以上换行折成 2 个（多余的视觉空行），再保证结尾恰好一个换行。
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** 机器可读形态（`format: "json"` 时用，省 token） */
export function renderCatalogJson(catalog: Catalog): object {
  return {
    sections: MANUAL_SECTIONS,
    configCount: catalog.entries.length,
    groups: CONFIG_GROUPS,
    settings: catalog.entries.map((e) => ({
      key: e.key,
      type: e.type,
      default: e.def,
      ...(e.enum ? { enum: e.enum } : {}),
      summary: e.semantic?.summary ?? null,
      ...(e.semantic?.group ? { group: e.semantic.group } : {}),
      ...(e.semantic?.values ? { values: e.semantic.values } : {}),
      ...(e.semantic?.detail ? { detail: e.semantic.detail } : {}),
      ...(e.semantic?.example ? { example: e.semantic.example } : {}),
      ...(e.semantic?.pitfall ? { pitfall: e.semantic.pitfall } : {}),
      ...(e.semantic?.required ? { required: true } : {}),
      ...(e.semantic?.unused ? { unused: true } : {}),
    })),
    toolchainFields: TOOLCHAIN_FIELDS,
    commandResolutionOrder: COMMAND_RESOLUTION_ORDER,
    files: [
      { path: '.vscode/settings.json', holds: 'oj.* 全部配置项', writtenBy: 'init_config / 用户' },
      { path: '.vsoj/toolchains.json', holds: '工具链覆盖与新增', writtenBy: 'init_config / 用户' },
      { path: '.vsoj/', holds: '缓存与比赛项目数据', writtenBy: '插件' },
    ],
    builtinToolchains: [
      { id: 'cpp-g++', label: 'C++ (g++)', extensions: ['.cpp', '.cc', '.cxx', '.c++'], kind: 'compiled' },
      { id: 'c-gcc', label: 'C (gcc)', extensions: ['.c'], kind: 'compiled' },
      { id: 'java', label: 'Java (javac/java)', extensions: ['.java'], kind: 'compiled' },
      { id: 'python', label: 'Python', extensions: ['.py'], kind: 'interpreted' },
    ],
  };
}
