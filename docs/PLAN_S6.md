# S6 本地测试引擎 + MCP 扩展 — 详细开发计划

> 本计划是 S6 的实施契约。**§2 的 15 条决策全部由用户拍板**（多轮询问工具）；
> §10 单独列出「我按用户授权自行定的默认值」，用户可否决。
>
> 依赖：S5 已把 `samples/*.in|out`、`temp/`、`test/`、源文件在初始化时落位，S6 只是把它们用起来。

---

## 0. 范围

### 0.1 本轮要做

1. **工具链抽象**：把「编译型 / 解释型」的差异关进工具链，测试引擎只认 `prepare` / `run` / `compare` 三个动作。
2. **测试引擎**：编译（或直接解释执行）→ 逐样例把输出落到文件 → 与期望输出**严格逐字节**比较 → 落盘 `result.json` + `report.md`。
3. **工具链配置**：工作区一份 `toolchains.json`（内置三套默认 + 用户自定义），外加一个可视化编辑页。
4. **三个触发入口**：命令面板/右键菜单、VS Code Task、MCP 工具。
5. **结果页**：内置 webview，两级结构（一级状态列表 / 二级单用例明细），固定亮色主题。
6. **MCP 扩展**：`get_problem_assets`、`get_problem_samples`、`run_local_test`。

### 0.2 本轮不做

- **不做内存的精确限制**：Windows 上 Node 无法可靠施加内存上限，只做「宽松看门狗」（§5.4）。
- **不做错误分类**（RE / TLE / CE / MLE）：判定只有「通过 / 不通过」，其余只作为**运行事实**记录。
- **不做 special judge / 浮点容差 / 交互题**。
- **不做保存即测**（watch 模式）：用户明确未选。
- 不做「整场比赛测试面板」（方案 B）——一级只列本次测试的用例；将来若要升级，两级结构不用返工。

---

## 1. 动机

S5 已经在磁盘上准备好了一切（`main.cpp` + `samples/1.in|1.out` + `temp/` + `test/`），
但用户要确认「我这份代码对不对」仍然得自己开命令行编译、自己喂样例、自己肉眼比对。

S6 的目标就是补上这一步：**一键把本地这份源码跑一遍样例，用与站点一致的判定口径告出通过与否**，
并让 AI（MCP 通道）也能跑这条路，形成「AI 改代码 → 本地验证 → 再改」的闭环。

关键约束来自用户：各人机器上的编译环境不同、语言有编译型也有解释型 ——
所以**不能把「编译」写死在引擎里**，必须有一层工具链把它屏蔽掉。

---

## 2. 已确认的决策（共 15 条，全部由用户拍板）

| # | 决策 | 说明 |
|---|---|---|
| D1 | 内置三套默认工具链：**C/C++、Java、Python** | 其余语言用「自定义工具链」补 |
| D2 | 工具链定义放**独立 `toolchains.json`**，并配**可视化编辑页** | 不塞进 `settings.json`（怕设置页膨胀、怕 AI 改坏其他设置） |
| D3 | `toolchains.json` 放**工作区一份** | 路径 `<工作区>/.vsoj/toolchains.json`，跟项目走、可 git、可分享 |
| D4 | 子进程环境：**自动推导 bin 目录 + 覆盖 PATH** | 从命令的绝对路径推导所在 bin 目录，PATH 只含推导结果（+ 用户显式追加项），**不继承**外层 PATH |
| D5 | 编译产物**按源文件内容哈希复用** | 改回去也能命中缓存；跨机器/跨 checkout 稳定 |
| D6 | CRLF 归一化位置｜**用户授权我定** | 见 §5.5：`temp/N.raw.out` 留原始字节，`temp/N.out` 写归一化副本 |
| D7 | 判定**只有「通过 / 不通过」** | 不分类 RE/TLE/CE；运行错误不做任何特殊处理，退出码/耗时/是否被砍只作运行事实记录 |
| D8 | **宽松看门狗**兜死循环与内存泄漏 | 任一闸门触发 → 直接 kill **整个进程树** |
| D9 | 用例范围：**samples/ 全部成对**，跳过「半对」 | 半对 = 只有 `N.in` 没有 `N.out`；跳过并在报告里点名说明 |
| D10 | 触发入口：**命令面板+右键菜单 / VS Code Task / MCP 工具** | 不做保存即测 |
| D11 | MCP 返回题目图片：**只给本地路径** | 不内联 base64 |
| D12 | 结果页 = **内置 webview，两级结构** | 一级：本次测试的用例状态列表；二级：该用例的期望/实际/diff 明细 |
| D13 | 结果页**每次测试都自动弹出/刷新并聚焦** | 全通过也展示；另有开关可改 |
| D14 | 代码改动后旧结果**标为已过期**（不删除） | 结果页与列表都标「代码已改动，结果可能已过期」 |
| D15 | 比对口径：**严格逐字节** | 归一化 CRLF→LF 之后逐字节，一个字节都不放过 |

---

## 3. 本轮新增的实测事实（决定了 §4 与 §5 的若干设计）

1. **本机 g++ 不在 PATH**：MinGW-W64 g++ **16.2.0** 位于
   `D:\usexxx\gcc\versions\16.2.0\mingw64\bin\g++.exe`（便携环境 `use-xxx` 管理，多版本共存）。
   同机还有 java 17、python 3.10/3.11/3.12、go 1.22/1.24、node 20/22，**全部不在 PATH**。
   → 工具链必须支持「绝对路径 / 多版本选择」，不能只依赖 PATH 查找。
2. **MinGW 产物依赖 `libstdc++-6.dll`**：直接把 `main.exe` 交给 `spawn` 会起不来
   （实测 bash 报 `exit=127`）；把 mingw 的 `bin` 目录加进 PATH 后正常输出。
   → 这正是 D4「自动推导 bin 目录」的必要性来源，不是锦上添花。
3. **程序输出的是 CRLF**：实测 `printf("3\n")` 落到文件是 `3\r\n`（C 运行时文本模式转换），
   连 Node 的 `stdio: [in, outFd, errFd]` 重定向也一样。
   → 站点样例是 `\n`（Linux 判题语义），**不做归一化严格逐字节必然 100% 全 WA**。
4. **单次编译约 2.6s**（g++ -O2 编译一个 a+b）。→ D5 的内容哈希复用对日常体验影响很大。
5. `cache/paths.ts` 早已预留 `tempDir` / `testDir` / `testResult` / `testReport`，S6 直接采用。
6. MCP 是 **HTTP server**（默认 9527），`handleToolsCall` 把整个 result 对象原样返回，
   → 新增工具与新增内容类型（如 `image`）只需扩类型，不用改传输层。
7. **MinGW 的 `ld` 无法在含非 ASCII 的产物路径下创建文件**（写实现时被演示脚本炸出来的）：
   `cannot open output file ...\3775-新生赛\A-A+B问题\temp\main.exe: No such file or directory`，
   路径被按 GBK 解释成乱码。对照实测结论：
   - 同一个源文件、产物路径改成纯 ASCII → **编译成功**（说明只是「写产物」这一步的问题）
   - 产物**放在**中文路径下 → **运行完全正常**（Bash 与 Node `spawn` 都验证过）
   - javac 往中文目录写 `.class`、python 跑中文路径脚本 → **都正常**，只有 MinGW 有这个毛病
   
   这条尤其要紧，因为本项目布局里**目录名含中文是常态**（`<cid>-<标题>` / `<字母>-<标题>`），
   而报错长得像「路径不存在」，极容易被误判成代码或配置问题。
   **解法（补测确认）**：让编译时的路径参数走**相对路径**即可根治 ——
   同样的中文目录下 `-o temp/main.exe`（cwd = 题目目录）**编译成功**，
   而 `-o <绝对路径含中文>` 失败。命令行里没有非 ASCII 字符，问题就不存在了（见 §5.9）。

---

## 4. 工具链模型（核心抽象）

### 4.1 接口

```ts
type ToolchainKind = 'compiled' | 'interpreted';

interface ToolchainDef {
  id: string;                 // 'cpp-g++' / 'java' / 'python' / 用户自定义
  label: string;              // 'C++ (g++)'
  kind: ToolchainKind;
  extensions: string[];       // 认领的源文件扩展名，小写含点：['.cpp', '.cc']
  compile?: string;           // 编译命令模板（编译型必填）
  run: string;                // 运行命令模板（两者都必填）
  env?: Record<string, string>;   // 显式覆盖的环境变量（最高优先级）
  pathPrepend?: string[];         // 追加到推导结果前面的 PATH 目录
  timeoutMs?: number;             // 覆盖全局看门狗阈值
  maxOutputBytes?: number;
  maxMemoryBytes?: number;
  asciiSafeOutput?: boolean;      // 声明「本工具链无法在非 ASCII 路径写产物」（见 §5.9）
  builtin?: boolean;              // 内置不可删，只能改
}

/** 工具链对外只暴露两个动作，引擎不需要知道是编译还是解释 */
interface PrepareResult { runnable: string; ok: boolean; log: string; durationMs: number; reused: boolean; }
interface RunResult { exitCode: number | null; watchdog: 'time' | 'size' | 'memory' | null; durationMs: number; outBytes: number; errTail: string; }
```

**编译型**：`prepare` 编译 → `runnable` = 产物路径。
**解释型**：`prepare` 不做任何事 → `runnable` = **源文件路径本身**。

引擎侧代码完全同构 —— 这就是用户要的「屏蔽底层差异」。

### 4.2 命令模板与占位符

| 占位符 | 含义 |
|---|---|
| `{source}` | 源文件绝对路径 |
| `{dir}` | 源文件所在目录（同时是默认 `cwd`） |
| `{stem}` | 源文件名去扩展名（Java 的类名要用它） |
| `{ext}` | 源文件扩展名（不含点） |
| `{output}` | 编译产物绝对路径（`temp/<stem>.exe`） |
| `{runnable}` | 运行阶段的可执行/脚本路径 |

模板用**引号包裹**书写（如 `"{gpp}" -O2 -std=c++17 -o "{output}" "{source}"`），
解析时按引号切分，避免路径含空格时被拆开；**不做 shell 展开**（`spawn` 直接传 argv，不经 shell）。

### 4.3 内置默认三套（D1）

| id | kind | extensions | compile | run | asciiSafeOutput |
|---|---|---|---|---|---|
| `cpp-g++` | compiled | `.cpp .cc .cxx` | `"{gpp}" -O2 -std=c++17 -o "{output}" "{source}"` | `"{runnable}"` | **true** |
| `c-gcc` | compiled | `.c` | `"{gcc}" -O2 -std=c17 -o "{output}" "{source}"` | `"{runnable}"` | **true** |
| `java` | compiled | `.java` | `"{javac}" -encoding UTF-8 -d "{dir}" "{source}"` | `"{java}" -cp "{dir}" {stem}` | — |
| `python` | interpreted | `.py` | — | `"{python}" "{runnable}"` | — |

`{gpp}` / `{gcc}` / `{javac}` / `{java}` / `{python}` 是**命令位置占位符**：
解析顺序为「工具链里显式写的 `commands` 绝对路径 → PATH 查找 → 常见安装目录探测」。

---

## 5. 设计与理由

### 5.1 引擎流程（三步，与用户的描述一一对应）

```
loadSamples(pid)                     → samples/ 全部成对用例（跳过半对并记账）
resolveToolchain(sourceFile)         → 按扩展名认领
prepare(toolchain, source, temp)     → 编译型编译 / 解释型空转（D5 复用）
for each case:
    run(toolchain, runnable, case.in, temp/N.raw.out)   ← 传输入输出文件地址
    normalize(temp/N.raw.out → temp/N.out)
    compare(temp/N.out, case.out)                       ← 严格逐字节（D15）
writeResult(test/result.json, test/report.md)
renderResultPage()                                          ← D12/D13
```

**输入输出都走文件地址**（不是管道）：避开 Windows 管道缓冲区与死锁问题，
被看门狗砍掉时文件里也已留下部分输出，能直接展示「跑到哪了」。

### 5.2 产物复用（D5）

`temp/build.json` 记录 `{hash, toolchainId, compileTemplate, product, at}`；
`hash = sha1(源文件内容 + 工具链 id + compile 模板)`。命中且产物文件仍存在 → 跳过编译（`reused: true`）。
另有「强制重新编译」命令绕过缓存。

### 5.3 判定与「运行事实」的边界（D7）

判定**只看输出比对结果**，两种结论：`pass` / `fail`。
被看门狗终止、非零退出码、崩溃 —— 一律**不改变判定逻辑**，只写进 `report.json` 的 `runtime` 字段
（`exitCode` / `watchdog` / `durationMs` / `errTail`），并在结果页与报告里作为**事实**注明。
理由：用户明确要求「不进行任何处理，只判断结果正确性」，但完全不给事实会让人看不懂为什么不过。

### 5.4 看门狗（D8）—— 三闸，任一触发即 kill 整个进程树

| 闸 | 默认值 | 实现 |
|---|---|---|
| 时间 | 10 s | Node 定时器 → `taskkill /PID <pid> /T /F`（POSIX 用 `process.kill(-pid)`） |
| 输出体积 | 64 MB | 每 500 ms `stat` 输出文件，超阈值即 kill（防死循环狂打印写爆磁盘） |
| 内存驻留 | 2 GB | 每 1 s `tasklist /FI "PID eq X" /FO CSV` 取工作集，超阈值即 kill |

三闸都刻意**宽松**（用户语），目的是兜「死循环 / 内存泄漏」，不是精确复现 OJ 的 ML/TL。
内存那一闸是**看门狗而非限额**：轮询有延迟，不承诺精确。

### 5.5 CRLF 归一化（D6，授权我定）—— 选「归一化副本」

- `temp/N.raw.out`：程序吐出的**原始字节**（想看原生输出时有据可查）
- `temp/N.out`：`\r\n → \n` 归一化后的**副本**，用于比较与展示

理由：① 用户要的是严格逐字节，归一化必须做且必须可解释 —— 保留原始字节才能证明我们没篡改程序行为；
② 展示与给 AI 看的产物里有 `\r` 是纯噪声；③ 只处理 `\r\n → \n`，**不动孤立 `\r`**，不越界。
期望文件同样归一化后再比（用户可能用记事本编辑过 `.out`）。

### 5.6 用例发现（D9）

扫 `samples/*.in` → 排序 → 有配对 `.out` 的进用例表；只有 `.in` 的进 `skipped` 列表，
报告里明确写「第 3 组只有 3.in、缺 3.out，已跳过（不计入通过率）」。

### 5.7 结果产物

- `test/result.json`：机器/AI 用，含 `sourceHash`（供 D14 判过期）、`summary`、逐用例 `cases`、`runtime`。
- `test/report.md`：中文人读，含汇总、逐用例差异摘要、运行事实、工具链与命令原文。

### 5.8 结果页（D12/D13/D14）

- 内置 webview，**沿用既有亮色主题约定**（删 `--vscode-*`、加 `color-scheme: light`、绿系配色、
  状态色用绿/红/琥珀/灰，**无 emoji、无蓝紫**）。
- 两级：一级 = 用例状态列表（状态 + 耗时 + 输出字节），点开 → 二级 = 期望/实际并排 + 首个差异定位。
- 打开时机默认「每次测试都弹」（配置 `oj.test.resultPage` 可改 `always|onFailure|never`）。
- 过期判定：当前源文件哈希 ≠ `result.json.sourceHash` → 顶部标「代码已改动，结果可能已过期」。

**S6.6 实现时定的四条**（都已落进契约）：

1. **零脚本**（C24）：展开用原生 `details/summary`，面板不开 `enableScripts`。
   页面要显示的是**程序输出**，那是不可信内容 —— 能展示，但一行都不该被执行。
2. **与报告同源**（C25）：运行事实与三份内容分别复用引擎的 `runtimeText()` / `casePreviews()`
   （为此把 runner 里原本私有的两个函数抽成导出）。各写一份读取逻辑，迟早在截断上限或
   文案口径上分叉。
3. **全通过不抢焦点**（C26）：这是对 D13「弹出并聚焦」的细化 —— 刷题时用户多半正在改代码，
   页面自己刷新就好；只有失败或没跑起来才值得把光标夺过去。
4. **「没能开始」也要有页面**：缺工具链 / 编译失败 / 没有用例，原先只弹一句警告。
   现在这三种情况各有一屏：缺什么命令、探测过哪些位置、编译器原文、以及「去哪拿样例」。

### 5.9 非 ASCII 产物路径：相对路径为主，跨盘才退回中转（`asciiSafeOutput`）

工具链可声明 `asciiSafeOutput`：**「传给编译器的产物路径必须纯 ASCII」**。
引擎满足它的手段按优先级如下（实测得出，见 §3 事实 7）：

1. **相对路径（主路径）** —— 编译时 `cwd` 本就是题目目录，于是把 `{source}` / `{output}`
   都渲染成相对路径（`main.cpp`、`temp/main.exe`）。命令行里因此**不含任何非 ASCII 字符**，
   中文只存在于子进程的 Unicode cwd 里，由内核拼接，不会有编码损失。
   零成本：不复制、不清理、不依赖 `%TEMP%`。
2. **产物名固定 ASCII** —— 产物恒为 `main(.exe)`，**不派生自源文件名**。
   源文件名是用户可配的（`oj.project.sourceFileName`），派生的话用户改成中文名就会再次踩坑。
3. **ASCII 中转（仅跨盘）** —— 产物与源文件不在同一盘时相对路径无解，
   退回 `%TEMP%\vsoj-build\<随机>` 编译再拷回 `temp/`；`build.staged` 与报告会说明。

**实测边界（这三条决定了上面为什么这样切）**：
- 产物路径**写进命令行**且含非 ASCII → `ld` 失败；换成相对路径 → 成功
- 产物**放在**非 ASCII 路径下**运行** → 完全正常（Bash 与 Node `spawn` 都验证过）
- 源文件路径含非 ASCII → **编译正常**（出事的一直只是「写产物」这一步）

**为什么用声明式能力位而不是在引擎里判语言**：引擎依旧零语言特判（契约 C1）。
Java/Python 不声明该位（它们往中文路径写产物本来就正常，已实测）。

### 5.10 「跑一下」—— 自研的调试入口（用户决策）

刷题时九成的「调试」其实是「拿样例跑一遍，看输出对不对」。而这条路用 VS Code 自带调试器走不通：

- cppdbg **不是**自己启动程序，它通过 MI 协议驱动 gdb，**「启动程序」那条命令（`-exec-run`）由它自己发**；
  `launch.json` 的 schema 里根本没有 stdin 字段（只有 `program`/`args`/`cwd`/`env`/`externalConsole`）；
- `run < 1.in` 是 gdb 自己的语法，cppdbg 不会替你带上；硬塞只能靠 `miDebuggerArgs` 挂 gdb 脚本，
  而它随后还会再发一次 `-exec-run`，行为不可控；
- 退一步说，就算绕过去了，绑定调试器还意味着要为三个平台分别适配（gdb / lldb / cpptools 各自不同）——
  代价与收益完全不成比例。

所以本项目的调试入口是**自研的**，并且只提供两条**平台无关**的通道（用户决策）：

| 通道 | 形态 | 说明 |
|---|---|---|
| **自定义任务** | `type: oj` 的任务：编译 / 本地测试 / 强制重新编译 / 跑一下 | 命令由工具链层**运行时**解析，同一份定义三平台通吃；终端里实时输出 |
| **MCP 工具** | 让 AI 自己编译、跑样例、读结果 | 见 S6.6 |

实现要点：

1. **不经过 shell**：`child_process` + pipe，自己把字节写进 `CustomExecution` 的 Pseudoterminal。
   走 shell 就要分 cmd/bash（引号、重定向、分隔符全不同），走真 pty 就要引 node-pty（原生模块要编译）。
2. **换行必须是 CRLF**：伪终端里只写 `
` 光标不回行首，输出会变阶梯状 ——
   而且这个坑**在 Windows 上不明显、在 Linux 上才暴露**，所以由 `makeTerminalWriter` 统一处理，
   并专门处理「`\r` 与 `\n` 落在两个数据块」的情况（否则会偶发多出一个空行）。
3. **输入只来自样例文件**：`stdin` 直接接 `fs.open` 的 fd，不支持在终端里手敲（用户决策）。
   程序读到 EOF 自然结束，也不需要 JS 侧搬运输入。
4. **关终端 = 杀子进程**：`close()` 会杀掉正在跑的子进程，不留野进程占 CPU。
5. **「跑一下」不判定**：结束只报告退出码与耗时。有样例不通过**不**改变「跑一下」的退出码，
   而「本地测试」的退出码会反映判定结果（有失败 → 1），便于脚本与 CI 识别。
6. **与测试共用一个产物**：`prepareOnly()` 与 `run()` 走同一个 `prepare`，
   所以「跑一下」和「本地测试」用的必定是同一个二进制，不会出现「测试过了但跑一下是旧的」。

---

### 5.11 配置说明书与 AI 初始化（用户追加需求）

用户的诉求：**「这个肯定不能是人来配了」** —— 工具链、baseUrl 这些不该让用户去设置面板里翻；
并且要求「在 MCP 中接入一个工具，专门读取插件的各种配置说明，并提供一个初始化配置方法，写进 md 文档」。

三条口径由用户当场拍板：

| 项 | 用户的说法 | 落地含义 |
|---|---|---|
| 说明书性质 | 「这个是插件内部的说明书，用于给 AI 自行编辑插件的」「会随插件发布的，只读」 | 说明书是**给 AI 读的产品文档**，随插件发布、不做成可编辑内容 |
| 探测谁来做 | 「这个就让 AI 自行扫描了」 | 插件**不扫盘、不内置任何个人环境路径**；探测是 AI 的活，插件只负责写 |
| 写盘权限 | 「写进配置，给 AI 决定」 | 工具**真的写配置**，值由 AI 决定 |

**两个 MCP 工具**

| 工具 | 作用 |
|---|---|
| `get_config_manual` | 返回配置说明书。`section` 可只取一节；`format: json` 给机器可读版省 token |
| `init_config` | 写配置。**默认只预览**，`apply: true` 才落盘；有 error 时拒绝落盘 |

**单一真相源**（这是「不会过期」的关键）

- **结构**（键名 / 类型 / 默认值 / 枚举）运行时从 `package.json` 的 `contributes.configuration` 生成
  → 加一个配置项，说明书自动多一行，**不可能漏**；
- **语义**（用途 / 取值 / 示例 / 坑）写在 `src/config/manual.ts` 的 `CONFIG_SEMANTICS` 里；
- 一致性测试双向核对：声明了必须有语义、有语义必须有声明 → **不可能漂**。

`docs/CONFIG.md` 由 `npm run docs:config` 从同一份真相源渲染，而测试断言
「磁盘上的文件 == 现在生成的结果」—— 于是仓库文档、MCP 工具返回值、插件真实行为三者一致。

**`init_config` 的几处设计取舍**

1. **预览优先**：配置是「会改坏东西」的操作，而调用方是 AI。计划函数是纯的
   （不碰磁盘、不依赖 VS Code），所以「键名打错」「类型不对」「定义非法」都能在**落盘之前**被测出来。
   有 error 时 `applyConfigWrite` 直接拒绝执行。
2. **键名容错但必须留痕**：省 `oj.` 前缀、大小写写错都能自动纠正，但**记一条提醒**；
   拼错太多则报错并给出「是不是想写 X」的建议（编辑距离 ≤3）。静默纠正不可接受 ——
   那会让 AI 以为自己写对了。
3. **`null` = 重置回默认**（从 `settings.json` 里删掉该项），而不是写个 `null` 进去。
4. **工具链只写覆盖字段**：写进文件的只有 AI 给的字段，其余留给内置定义在读取时补全，
   于是内置模板以后改进能自动继承，不会被文件里的旧副本挡住。
   > 为此**修掉了一个既有缺陷**：`normalizeDef` 要求 `run` / `extensions` 必填，
   > 导致「只改 g++ 路径」这种最自然的写法会被当成坏条目丢掉。现在 `parseToolchains`
   > 会先以内置定义为底补全再校验（非内置 `id` 仍要求完整定义）。
5. **落盘前预检命令**：用「将要生效的定义」实探一遍命令能否解析，
   失败时把**探测过的位置**列出来 —— AI 的路径写错了，在预览里就能看见，
   不用等跑测试才炸。
6. **备份**：覆盖 `toolchains.json` 前自动备份（带时间戳，不覆盖已有备份）。
7. **没打开文件夹时**明确拒绝写「工作区」级设置，并给出两条出路（打开文件夹 / 用 `global`），
   而不是等 VS Code 抛一句难懂的话。

**顺带发现的两个死配置**（说明书里如实标出，`unused: true`）

| 配置项 | 情况 |
|---|---|
| `oj.defaultLanguage` | `getDefaultLanguage()` 全项目没有任何调用方，提交页语言是独立选择的 |
| `oj.autoRefreshStatus` | 自动刷新实际由命令 `oj.toggleStatusAutoRefresh` 控制一个**运行期内存标志**，与该设置无关 |

> 这两条都是新加的一致性断言抓出来的：它数「读取函数的调用次数」，
> 只有定义没有调用方的就判为未生效。原有的 `config-consistency` 只在源码里找键名字符串，
> 抓不到「有 getter 但没人用」这种 —— 两种检查互补。
> 同时把 `src/config/manual.ts` 从这两处源码扫描里排除：说明书会按名字提到配置键与 getter，
> 那是文档不是消费，算进去会让检查假通过。

---

## 6. 阶段切分（每阶段一次 commit + 独立可验证测试套件）

| 阶段 | 内容 | 交付物 | 测试 |
|---|---|---|---|
| S6.0 ✅ | 工具链模型、内置三套、命令解析与 PATH 推导、JSON 读写 | `src/test/toolchain.ts` | `test/toolchain.test.js`（65） |
| S6.1 ✅ | 严格比较器：LF 归一化、逐字节、首个差异定位（行/列/hex） | `src/test/compare.ts` | `test/compare.test.js`（49） |
| S6.2 ✅ | 引擎：prepare/run/看门狗/产物复用/结果落盘，**纯 Node 可跑** | `src/test/runner.ts`、`src/test/watchdog.ts` | `test/runner.test.js`（66，真实 g++ 端到端） |
| S6.2.1 ✅ | 中文路径根治：编译路径参数改相对路径（删掉「必须中转」的绕路） | `src/test/runner.ts` | `test/runner.test.js`（70） |
| S6.3 ✅ | 接线层：7 个配置项、选工具链、发现样例、命令与右键菜单 | `src/test/wiring.ts`、`extension.ts`、`package.json` | `test/test-wiring.test.js`（44） |
| S6.4 ✅ | 自定义任务（`oj` 类型）+ 终端桥：编译 / 本地测试 / 强制重编译 / **跑一下** | `src/test/tasks.ts`、`src/test/terminal.ts` | `test/tasks.test.js`（43，真实 g++ 端到端） |
| S6.5 ✅ | **配置说明书 + AI 初始化工具**（用户追加）：`get_config_manual` / `init_config`，说明书生成与漂移断言 | `src/config/manual.ts`、`writer.ts`、`tools.ts`、`wiring.ts`、`scripts/gen-config-docs.js` | `test/config-manual.test.js`（44）、`test/config-writer.test.js`（85）、`test/config-tools.test.js`（54） |
| S6.6 ✅ | 结果页 webview：两级明细、过期标记、零脚本、全通过不抢焦点 | `src/webview/testResultWebview.ts`（+ `runner.ts` 抽出 `casePreviews` / `runtimeText` 供报告与页面共用） | `test/test-result-page.test.js`（61） |
| S6.7 | MCP 三工具：编译 / 本地测试 / 读最近结果 + 读题目图片 | `src/mcp/tools.ts`、`server.ts` | `test/mcp-test-tools.test.js` |
| S6.8 | 工具链可视化编辑页 + macOS 内存探测回退 + 文档收口 | `src/webview/toolchainWebview.ts` 等 | `test/toolchain-page.test.js` |

---

## 7. 行为契约（验收依据）

- **C1** 引擎不出现「编译」字样以外的语言特判：新增语言只需加一份 `ToolchainDef`，不改引擎代码。
- **C2** `prepare` 对解释型工具链是空操作，`runnable` = 源文件路径；对编译型返回产物路径。
- **C3** 编译失败 = `prepare.ok=false`，**原样回传编译器 stderr**，不进入 run 阶段，不产出 `result.json` 的用例结论。
- **C4** 子进程 `cwd` = 源文件所在目录（题目目录）；输入输出**以文件路径**传入。
- **C5** 子进程 PATH = 推导出的 bin 目录（+ `pathPrepend` + `env.PATH`），**不继承**外层 PATH（D4）。
- **C6** 判定只有 `pass` / `fail`；`runtime` 事实不参与判定。
- **C7** 比较是**归一化后严格逐字节**；`temp/N.raw.out` 必须保留原始字节。
- **C8** 看门狗 kill 的是**整个进程树**，不允许残留子进程。
- **C9** 复用命中时不得重新编译，且 `result.json` 必须标 `build.reused=true`。
- **C10** 「半对」用例必须出现在报告的 skipped 列表里，不得静默忽略。
- **C11** 结果页不引用任何 `--vscode-*` 主题变量（沿用 S5.8 的亮色约定，由 `theme.test.js` 守住）。
- **C12** 代码改动后旧结果标记为**已过期**而非删除（D14）。
- **C13** 写文件仅限题目目录内的 `temp/` 与 `test/`；不碰 `samples/`、不碰用户源文件。
- **C14** 声明了 `asciiSafeOutput` 的工具链，**传给编译器的产物路径必须纯 ASCII**：
  优先相对路径；不可用（跨盘）时才走 ASCII 中转，且产物最终必须落在 `temp/`（中转目录要清理）。
- **C16** 编译产物的文件名固定为 `main(.exe)`，**不得派生自源文件名**（源文件名用户可配、可能含中文）。
- **C17** 任务与运行器**不得生成平台相关的命令**并写入用户文件（不写 `.vscode/tasks.json` 的 shell 命令）：
  命令一律在运行时由工具链层解析，保证同一份定义在 Windows / Linux / macOS 都成立。
- **C18** 写进伪终端的内容必须是 CRLF；流式输出要处理「`\r` 与 `\n` 分属两个数据块」。
- **C19** 「跑一下」的输入只来自样例文件，不提供手动输入；关闭终端必须杀掉正在跑的子进程。
- **C20** 配置说明书的结构部分**必须**来自 `package.json` 声明，不得手写；
  语义部分必须让每个配置项都有条目（双向核对由 `test/config-manual.test.js` 保证）。
- **C21** `docs/CONFIG.md` 必须与 `renderManual()` 的结果逐字节一致（`npm run docs:config` 重新生成）。
- **C22** `init_config` 在计划存在 error 时**不得落盘**；覆盖已有文件前**必须**备份；
  值的自动转换与键名的自动纠正**必须**留下可见提示，不得静默处理。
- **C23** 部分覆盖：`id` 与内置相同的条目，读取时以内置定义为底补全后再校验；
  写回文件时**只写覆盖字段**。非内置 `id` 仍要求完整定义。
- **C15** 引擎不得出现任何语言名判断：语言差异只能体现为 `ToolchainDef` 里的声明
  （`kind` / 命令模板 / 能力位）。
- **C24** 结果页**零脚本**：不开 `enableScripts`、不注册消息通道。页面里的程序输出是不可信内容，
  只能被展示，不能被执行（容器标签用 `details/summary` 展开，不靠 JS）。
- **C25** 结果页的文案与内容读取**必须与 `report.md` 同源**：运行事实用 `runtimeText()`、
  输入/期望/实际用 `casePreviews()`，不得在视图层另写一份读取与截断逻辑。
- **C26** 结果页的弹出与聚焦由 `oj.test.resultPage` 决定（`always` / `onFailure` / `never`）；
  **全通过时不抢焦点**（页面照常刷新），只有失败或没跑起来才把焦点夺过去。

---

## 8. 测试策略

与前几个阶段一致：**脱离 VS Code 运行时**（`vscode` 桩 + 本地 HTTP 服务器）。
S6 的优势是引擎本身不依赖 vscode，所以可以做**真端到端**：

- 用真实的 `D:\usexxx\gcc\...\g++.exe` 编译真实的 `main.cpp`，跑真实样例，比对真实字节 —— 全链路无 mock；
- 覆盖：正确代码（全通过）、差一字节（定位到行列）、死循环（看门狗时间闸）、
  狂打印（体积闸）、读不到输入（半对跳过）、编译报错（C3）、两次运行的复用命中（C9）、
  CRLF 输入输出归一化（C7）、PATH 覆盖后 MinGW 产物仍能启动（C5，实测过的那条）。

工具链路径通过环境变量注入（如 `VSOJ_TEST_GPP`），**找不到编译器时该套用例降级为 skip 并显式说明**，
不伪装成通过。

---

## 9. 需要改动的文件清单

**新增**

- `src/test/toolchain.ts`、`src/test/compare.ts`、`src/test/runner.ts`、`src/test/watchdog.ts`
- `src/test/wiring.ts`（S6.3）、`src/test/taskTemplate.ts`（S6.6 未做，任务模板直接写在 `src/test/tasks.ts` 里）
- `src/webview/testResultWebview.ts`（S6.6）、`src/webview/toolchainWebview.ts`（S6.8）
- `src/utils/testConfig.ts`（**未拆**：`config.ts` 停在 190 行，先不为了「避免膨胀」而拆）
- `test/{toolchain,compare,runner,test-wiring,test-result-page,mcp-test-tools,task-template,toolchain-page}.test.js`

**修改**

- `src/utils/config.ts`（或新增 testConfig.ts）｜`src/mcp/tools.ts`、`src/mcp/server.ts`
- `src/extension.ts`（命令注册、右键菜单）｜`package.json`（配置项 / 命令 / 菜单 / tasks 模板）
- `README.md`、`docs/PROGRESS.md`、`docs/ARCHITECTURE.md`

---

## 10. 决策状态

**用户拍板（15 条）**：D1–D15，见 §2。全部经询问工具逐条确认。

**我按用户授权自行定的默认值（可否决）**：

| 项 | 我定的值 | 依据 |
|---|---|---|
| CRLF 归一化位置 | 归一化副本（raw 保留） | 用户答「自行判断」，理由见 §5.5 |
| 看门狗默认值 | 10 s / 64 MB / 2 GB | 用户答「比较宽松的看门狗」 |
| 编译参数 | C++ `-O2 -std=c++17`；C `-O2 -std=c17`；Java `-encoding UTF-8` | 与 HUSTOJ 常见判题参数对齐 |
| 结果页开关默认 | `oj.test.resultPage = always` | 用户答「每次测试都弹」 |
| 报告双份 | `result.json`（机器读）+ `report.md`（人读，中文） | 沿用 S5 产物风格 |
| 命令模板占位符 | `{source} {dir} {stem} {ext} {output} {runnable}` | 让 Java 类名、Python 脚本各有表达方式 |

**已知代价（提前说明）**

1. **PATH 覆盖（D4）**：不继承外层 PATH，若某个程序的运行依赖系统 PATH 里的东西会找不到 ——
   可在该工具链的 `env.PATH` 里显式补回。
2. **内存闸是看门狗不是限额**：1 s 轮询有延迟，一个瞬间暴涨的进程可能在两次轮询之间就吃掉大量内存。
3. **方案 A 的一级不跨题**：想要「整场比赛哪道题没过」的一览，得等升级到方案 B。
4. **ASCII 中转依赖 `%TEMP%` 可写且为纯 ASCII 路径**：若用户名本身含中文，
   回退到 `%SystemDrive%\vsoj-build`；两者都不可用时按原路径编译并如实报错，不静默降级。
