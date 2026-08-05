# asm.js 产品化路线图

> 制定时间: 2026-07-10
> 前置文档: [ES_SUPPORT.md](./ES_SUPPORT.md)、[NODEJS_SUPPORT_ANALYSIS.md](./NODEJS_SUPPORT_ANALYSIS.md)
> 本文档是四个产品方向的总规划:**引擎库化、完整 ES、Node.js 兼容(含包管理)、README 完整化**。
> 铁律: 任何阶段的任何改动,都必须保持五目标 `gen2 == gen3` 自举定点(见 README Self-Hosting)。

> **状态更新(v0.2,2026-07-20)**——本路线图制定于 v1.5.x 时代(2026-07-10),版本号已于 2026-07-19 自 0.1 重新起算(重编号,非回退)。自制定以来多个规划项已落地(详细沿革见 [CHANGELOG.md](../CHANGELOG.md) 的 v0.x 条目与 v1.x 开发档案):
> - **E2/E3(ES)大幅收口**:Proxy/Reflect 基本完整(含 apply/construct 陷阱与不变式)、JSON 全参、属性描述符与 ES 枚举序、async 全形态、迭代协议全站点、typed arrays 完整(构造器全局值,v0.2)、浮点 shortest round-trip(Dragon4)。现状见 [ES_SUPPORT.md](./ES_SUPPORT.md)。
> - **N1/N2(Node)已落地 AOT 子集**:CJS `require`、`node_modules`+`package.json` `exports` 解析、ESM↔CJS 互操作、`process.env`;环形 `require()` 已补齐(fixtures 首次全绿,基线 362/362)。N3 near-node 化与 N4 包验证集仍开放。
> - **L2(引擎库)route B 已打通**:全局 `eval()`/`new Function()` 可在 AOT 程序直用(arm64+x64);**直接 eval 词法作用域捕获已完成**(route B 最后硬里程碑);运行时 specifier `import()` 仍开放。见 [../engine/README.md](../engine/README.md)。
> - **确定性升级**:`gen1==gen2==gen3` 全链字节一致;产物足迹大幅削减。
> - **新增方向**:WebAssembly 目标 `wasm32-wasi`([WASM_DESIGN.md](./WASM_DESIGN.md));并发 Stage-0 `js f(x)` spawn + Channel 方言与 G-M-P 设计([PARALLEL_DESIGN.md](./PARALLEL_DESIGN.md)),对应方向五 C2 的起步。
> - 下方正文保留 2026-07-10 制定时点的表述,阶段表中已完成项以上述为准。

> **并发(方向五 C2)推进到 G-M-P N>2**:共享堆 G-M-P 路线(见 §4.5 补注)已从设计研究执行到真多核——双 M 工作窃取调度(GOMAXPROCS=2)→ per-P 无锁分配(M4)+ STW 安全点(M5)→ 真多 M stop-the-world GC 周期 → 泛化到 N>2(**GOMAXPROCS=3 真 3 线程窃取 + N 路 STW GC**,linux-arm64 Docker 验证)。`GOMAXPROCS=1` 保持字节一致自举定点;跨 M channel 唤醒、非 M0 协调者、x64 段寄存器 TLS 为已知余项。
> - **E4 test262 落地首个基线**:真实 conformance harness(`tests/test262/run.mjs`,含 frontmatter/includes/negative 机制)已上线;当前基线 **20.55%**(stride-5 抽样运行 6462 例 / PASS 1328,TypedArray 区经 v0.2 构造器全局值自 0% 救起)。距 M4 的 ≥80% 目标尚远,作为 M4 进行中的量化锚点。
> - **Node crypto 已到 AES-GCM/SHA-512/HKDF**(密文与派生密钥对 Node 逐字节一致);同期 N3 深度推进还有真实 zlib、async net/HTTP/UDP、streams/child_process 等。
> - **性能(v0.2 新进展)**:静态可解析方法调用的编译期去虚拟化(自编译 −7.5%),对象 shape/隐藏类 IC 专项进行中(docs/SHAPE_IC_DESIGN.md)。
> - 下方正文与 §5 里程碑表仍保留 2026-07-10 制定时点表述;各里程碑实际状态见 §5 表新增「实际状态」列。

## 0. 现状快照(2026-07-10 制定时点)

| 维度 | 状态 |
|------|------|
| 自举 | ✅ 五目标(macOS/Linux × arm64/x64 + Windows-x64)`gen2 == gen3` 字节级定点 |
| 产物 | 单文件原生可执行(Mach-O/ELF/PE),零第三方依赖、零外部解释器 |
| 性能 | 自编译 240s → ~12s;对 Node 24 分负载:数值 ~2.7×、属性 ~16×、字符串 ~3×、Map 略快(区间线性扫描寄存器分配 + 站点缓存 + ToNumber 快路已落地,2026-07) |
| 内存 | 分代 GC 缺省(已转正:sticky mark-bit minor + Go 式 full 步调 + 64KB span/O(1) 页映射);保守、非移动;自编译峰值 ~1.4GB(分代前 ~2GB) |
| ES | 较大 ES 子集(详见 ES_SUPPORT.md):class/async/解构/模板串/ESM 子集等已通;RegExp 引擎、完整 JSON、Proxy 等未完 |
| Node | Node 风格 shim 子集(fs/path/process/console/os/child_process 部分);无 node_modules 解析、无包生态 |
| 工具链 | `asm.js <file>` 编译、`asm.js run <file>` 直接执行(编译→运行→计时) |

四个方向的依赖关系:

```
GC + 寄存器分配器(性能/可靠性基座,✅ 2026-07-11 收官)
   │
   ├── 方向二:完整 ES ──────┐   (ES 语义是 Node shim 的前置)
   │                        ▼
   │                 方向三:Node.js + 包管理
   │                        │
   ├── 方向一:引擎库化 L1(AOT 库,可与上并行)
   │              └── L2(运行时引擎库,依赖可重入改造)
   │
   └── 方向四:README/文档(已落地,持续同步)
```

---

## 1. 方向一:JS 引擎库(libasmjs)

### 1.1 目标形态

把 asm.js 从「只出可执行文件的编译器」扩展为「其它程序可链接使用的 JS 能力库」。两条产品线,难度递进:

**L1 — AOT 嵌入库**(把某个 JS 程序编译成可链接库)

```
asm.js app.js --emit static  → libapp.a  + asmjs.h
asm.js app.js --emit shared  → libapp.dylib/.so/.dll + asmjs.h
```

宿主程序(C/C++/Rust/Go/Swift)链接后通过 C ABI 调用:

```c
#include "asmjs.h"
int rc = asmjs_main(argc, argv);            // L1a: 整程序入口
asmjs_value r = asmjs_call("add", 2, args); // L1b: 导出函数级调用
```

**L2 — 运行时引擎库**(类 QuickJS 的嵌入式引擎)

编译器本体已经是原生代码(自举产物),把它做成库:宿主在运行时喂 JS 源码,asm.js 在内存中生成机器码并执行:

```c
asmjs_ctx *ctx = asmjs_new();
asmjs_value v = asmjs_eval(ctx, "1 + 2");   // 内存代码生成 + 执行
asmjs_free(ctx);
```

### 1.2 阶段拆解

| 阶段 | 内容 | 关键工作 | 前置 |
|------|------|----------|------|
| **L1a** | 静态库 + `asmjs_main` 单入口 | `_start` 改造为可调函数(参数从 argv 注入而非内核栈);堆/GC 初始化惰性化(首次调用时 mmap);Mach-O/ELF 增加 `.o`/归档输出路径;符号导出表 | GC 收尾 |
| **L1b** | 导出函数级 C API | `export function` → C 符号;值封送层:NaN-box ↔ C(int64/double/UTF-8 字符串/ArrayBuffer);错误传播(JS 异常 → 错误码) | L1a |
| **L1c** | 动态库 + 全平台 | PIC/重定位改造(现产物为绝对寻址可执行体,动态库需 GOT 或加载期重定位表);五目标 dylib/so/dll 出品与 CI 验证 | L1a |
| **L2a** | 内存执行引擎 | `asmjs_eval`:编译到内存缓冲 → `mmap(PROT_EXEC)` → 跳转执行;W^X 处理(macOS `MAP_JIT` + entitlement、Linux 双映射) | L1b + 可重入改造 |
| **L2b** | 多实例/隔离 | 全局单例(`_heap_meta`、数据标签、模块注册表)→ `asmjs_ctx` 上下文句柄;每实例独立堆与 GC | L2a |
| **L2c** | **JS 语言级 `eval`/`new Function` + 动态 `import()`**(2026-07-10 增补;动态 import 归属 2026-07-11 修正,用户指定) | 引擎库形态下编译器常驻进程内,`eval` 不再与 AOT 冲突:JS 代码里的 `eval(src)` → 引擎内存编译 → 同堆执行;作用域语义分层交付(先 全局作用域 eval/`new Function`,再 直接 eval 的词法作用域捕获——需要编译器为含 eval 的函数关闭寄存器/槽位优化并导出作用域表)。**动态 `import(运行时 specifier)` 同理归此**:运行时加载+编译任意模块需常驻编译器,与 eval 同一能力面（`import(变量)`/`import(拼接)`）。**独立可执行产物(L1/AOT)维持无 eval/无动态 import**——封闭世界是单二进制的前提;二者是引擎库(L2)专属能力,文档须明确两种形态的差异。注:动态 `import("./字面量.js")`（编译期可知 specifier）是 AOT 可做子集（静态链接 + Promise 包装），若需可在 E 系单独实现 | L2a/L2b |

### 1.3 结构性风险

- **全局单例假设遍布运行时**:堆、GC、模块表都是数据段全局标签。L1a 可以容忍(一个进程一个 JS 世界),L2b 必须重构为上下文参数。工作量最大的单项。
- **绝对寻址**:代码生成假定加载基址固定。动态库(L1c)和内存执行(L2a)都需要位置无关或重定位支持——建议一次性做「加载期重定位表」方案,两处复用。
- **macOS JIT 授权**:`MAP_JIT` 需要 entitlement 与签名,分发面向开发者需文档化。
- **自举回归**:`_start` 与初始化改造直接踩自举核心路径,每步都要回放五目标定点。

### 1.4 验收标准

- L1a: C 程序链接 `libapp.a` 后 `asmjs_main` 跑通现有全部 fixtures 语义,产物大小 ≤ 独立可执行 + 100KB。
- L1b: 双向调用(C→JS、JS 回调 C 函数指针)demo + 封送单测。
- L2a: `asmjs_eval` 在三 OS 跑通 ES 子集冒烟集;同一进程串行 eval 1000 次无泄漏(RSS 平台期)。

---

## 2. 方向二:完整 ES 语法支持

现状审计见 [ES_SUPPORT.md](./ES_SUPPORT.md):「较大 ES 子集」,缺口集中在模块语义、若干全局对象、以及"能编译但语义不对"的静默退化。

### 2.1 分层推进

| 批次 | 内容 | 代表项 |
|------|------|--------|
| **E1 语法扫尾** | parser/compiler 还不认的语法 | RegexLiteral 字面量全路径、SpreadElement 剩余场景、getter/setter 完备、labeled statement、`new.target`;`with` 明确列为**非目标** |
| **E2 语义正确性** | 能编译但值不对的静默退化 | `typeof` 全类型正确、原型链完备(`instanceof`/`Object.getPrototypeOf`)、iterator 协议全覆盖(spread/解构/for-of 统一走协议)、装箱边角(qNaN vs boxed-int0)、live binding |
| **E3 内建完备** | 缺失/半残的内建对象 | `JSON.stringify/parse` **主体已落地**(2026-07-10,编译器注入纯 JS shim —— 内建 shim 机制首铺,后续内建复用;余 replacer/reviver/缩进/toJSON)、**自研 RegExp 引擎**(回溯式,先 BMP 后 Unicode)、`Date` 完整、`Number` 打印精度(15 位舍入已落地,余 shortest round-trip 第 16 位边角)、`Proxy/Reflect`(靠后)、`Intl` **非目标** |
| **E4 度量体系** | 从"fixture 绿"升级到行业标尺 | 引入 **test262 子集**跑分(先挑 language/ + built-ins/ 中已实现面),CI 输出通过率仪表盘,README 公布数字 |

> 注(2026-07-19 补):E1 行"`with` 明确列为非目标"为制定时点立场,与 [ES_SUPPORT.md](./ES_SUPPORT.md) 已标 ✅ 矛盾——`with` 实际已落地(读/赋值/更新/方法解析,字节门控使非 `with` 代码产物不变),以 ES_SUPPORT.md 为准,此处保留原文备查。E4 已按此行设想落地:test262 harness 已上线,当前基线 20.55%(2026-07-19,见 `tests/test262/last_run_summary.json`)。

### 2.2 工程原则

- 反静默退化:宁可编译期报 `Unhandled ...` 也不生成错值代码(现有若干路径违反,逐个收口)。
- 每个 E2/E3 项都要有"Node 对照"fixture:同一程序 node 与 asm.js 输出逐字节一致。
- RegExp 引擎是 E3 最大单项(预估与分代 GC 同量级),独立立项,先服务 `test()/exec()/match/replace` 主路径。

### 2.3 验收标准

- E1/E2 完成后:fixtures 全绿 + 编译器对不支持语法 100% 显式报错(零静默)。
- E3 完成后:test262 选定子集 ≥ 90%;RegExp 通过自建 200 用例集。
- 每季度 README 的 test262 数字只升不降。

---

## 3. 方向三:Node.js 支持(含包管理)

现状审计见 [NODEJS_SUPPORT_ANALYSIS.md](./NODEJS_SUPPORT_ANALYSIS.md):三层模型——内建模块 shim(部分)、模块解析语义(不完整)、包生态(未实现)。

### 3.1 阶段拆解

| 阶段 | 内容 | 关键工作 |
|------|------|----------|
| **N1 模块解析器** | 与 Node 一致的路径解析 | `node_modules` 逐级向上查找;`package.json` `main`/`exports`(含条件导出 `import`/`require`/`default`);扩展名补全(`.js/.mjs/.cjs/.json`);目录 `index`;`node:` 前缀 |
| **N2 CJS 完整语义** | require 的真语义 | 模块缓存(同路径单实例);循环依赖(部分导出可见);`module.exports` 整体重绑定;ESM↔CJS 互操作(default 包装、`__esModule`);`require(esm)` 错误语义 |
| **N3 内建模块 near-node 化** | shim → 接近 Node 行为 | 优先级:`fs`(sync 全量 + 常用 async/promises)> `path` > `buffer` > `events` > `process` > `os` > `url` > `util` > `stream`(子集)> `child_process`;每个模块建 Node 对照 fixture 集 |
| **N4 包生态验证集** | 真实包回归 | 选 20 个纯 JS 高频包做编译+运行回归:`ms`、`debug`、`minimist`、`semver`、`chalk`、`commander`、`lodash`、`glob`(逐步),作为 CI 门禁 |
| **N5 构建入口** | 包级编译体验 | `asm.js build`:读 `package.json` 入口(`main`/`bin`),整包(含 node_modules 依赖图)编译为单二进制;`--minify-graph` 只打包可达模块 |

### 3.2 包管理立场

**不自研包管理器。** 兼容 npm/pnpm/yarn 安装好的 `node_modules` 磁盘布局(N1 解析器负责消费),`asm.js build` 负责从入口把依赖图 AOT 成单二进制。锁文件、安装、发布全部交给现有生态。

### 3.3 非目标(明确不做)

- native addons(`.node`/N-API)——与 AOT 单二进制模型冲突;
- `worker_threads`/`cluster` 的 Node 完整语义(并行能力由方向五 C2 承接,初期不按 Node API 承诺);
- V8 专属 API(`v8` 模块、完整 `vm` 语义);
- 动态 `require(变量表达式)` 的完整语义(仅支持可静态分析子集,其余编译期报错)。

### 3.4 验收标准

- N1+N2: Node 官方模块解析算法测试向量(自建 ~80 条)全绿;循环依赖 fixture 与 node 输出一致。
- N3: 每模块 Node 对照 fixture ≥ 20 条全绿。
- N4: 20 包验证集编译+运行全绿并进 CI。
- N5: 对一个真实 CLI 包(如 `ms` 的消费 demo)`asm.js build` 出单二进制且行为与 `node` 一致。

---

## 4. 方向四:README 完整化(优劣势描述)

**已落地**(本次):

- 英文 `README.md` 新增 **Strengths & Limitations** 章节:定位(与 Node/Bun/Deno 打包、QuickJS、Go 模型对比)、优势(单二进制/零依赖/自举证明/启动快)、劣势(ES 子集/AOT 档位性能(2026-07 实测分负载 1×~16×)/保守非移动 GC/生态未接入/未产品化),数字全部来自可复现实验。
- 新增 **`README.zh-CN.md`** 中文版,与英文版章节一一对应。

**维护约定**:

- 任何影响 README 数字的变更(自举尺寸表、性能倍数、test262 通过率),中英两份必须同一提交内同步;
- 「Accurate Messaging」清单是对外表述的唯一口径,新能力转正前不得在 README 声称;
- 每完成本路线图一个阶段,同步更新两份 README 的 status 段。

---

## 4.5 方向五:并发能力(2026-07-10 增补,用户指定)

现状:单线程模型。async/await 已有协程调度器(runtime/async/coroutine.js),但事件循环语义不完整;
定时器部分实现;I/O 全部同步 syscall;代码生成无原子指令、无 TLS;堆/GC 为全局单例。

| 阶段 | 内容 | 关键工作 |
|------|------|----------|
| **C1 单线程事件循环收口** | Node 语义的微/宏任务序 | microtask 队列(Promise 回调序与 Node 一致)、`setTimeout/setInterval/setImmediate/queueMicrotask` near-node、进程退出条件(挂起句柄计数);fixture:与 node 输出逐字节对比的时序用例集 |
| **C2 Worker 式并行** | 消息传递、隔离堆 | 每 worker 独立堆+GC(复用 L2b 的上下文化改造 —— 两者是同一笔投资)、线程创建(pthread/CreateThread 三平台)、structured-clone 式消息拷贝;不共享 JS 堆 ⟹ GC 仍单线程/每堆,复杂度可控 |
| **C3 共享内存(远期)** | SharedArrayBuffer/Atomics | 需要 asm 层原子指令(LDXR/STXR、LOCK 前缀)与内存序;仅在 C2 证明需求后启动 |
| **C4 GC 并发(远期)** | 并发标记(Go 蓝本) | 依赖 C2 的线程基建 + #11 屏障;Go 混合屏障为现成设计(见 M0 附注);CLI 场景收益有限,服务器场景(方向三成熟后)再评估 |

> 注(2026-07-19 补):C2 行「每 worker 独立堆+GC(复用 L2b 上下文化改造)」的隔离堆路线**已被取代**——[PARALLEL_DESIGN.md](./PARALLEL_DESIGN.md) 采用共享堆 G-M-P 直达路线(设计明确跳过隔离堆迂回),并已执行到 N>2:per-M 上下文化(arm64 x28 P/M 寄存器)、双 M 窃取调度、per-P 分配 + STW 安全点、多 M STW GC、GOMAXPROCS=3 三线程窃取 + N 路 STW GC(逐步版本沿革见 CHANGELOG v1.x 档案)。上下文化的实际载体是 per-M 上下文而非 L2b 实例句柄;C4 的 STW 停等协议已提前部分变现。

依赖关系:C1 独立可先行(属 ES/Node 语义收口的一部分);C2 与 L2b(多实例上下文)共享同一重构;
C3/C4 严格在 C2 之后。风险:线程 × 保守 GC = 每线程栈根扫描 + 停等协议,是 C2 的主要技术难点。

## 5. 优先级与里程碑

性能/可靠性基座已收官(分代 GC #11 ✅ 已转正;寄存器分配器 #12/#29 ✅ 区间线性扫描收官;P3 数值快路 ✅)——性能故事已可讲(num ~2.7×),引擎库化的 GC 依赖已满足。

| 里程碑 | 内容 | 验收 | 实际状态(2026-07-20,v0.2) |
|--------|------|------|------|
| **M0**(✅ 2026-07-10) | 分代 GC 收尾 + 寄存器分配器阶段2 | 已达成:影子自编译 0 MISS;分代转正缺省(RSS −30%);span 页模型 S1;阶段2 实验定论(阶段3 = 每函数 IR 线性扫描) | ✅ 已达成(维持原判) |
| **M1** | E1 语法扫尾 + E4 test262 接入 | 零静默退化;test262 仪表盘上线 | **大部分达成**:test262 harness 已上线(当前基线 20.55%);E1 语法大体扫尾,但基线仍暴露 COMPILE_FAIL 601 例(parser 缺口存量),"零静默退化"未经全量证实 |
| **M2** | N1 解析器 + N2 CJS 语义 | 解析测试向量全绿 | **已达成**:N1/N2 已落地;环形 `require()`(N2 循环依赖语义)已补齐,fixtures 首次全绿 |
| **M3** | L1a 静态库(与 M2 并行) | C 宿主 demo 跑通 | **未启动**:CHANGELOG 无 L1a 对应条目(路线被 L2 route B 与 G-M-P 并发线挤占) |
| **M4** | E2 语义 + E3 JSON/Number;N3 fs/path/buffer/events | test262 子集 ≥ 80% | **进行中**:test262 20.55% ≪ 80% 目标;E2/E3 持续收口(描述符/枚举序/JSON 全参/Dragon4),N3 推进至 streams/child_process/net/crypto 深度 |
| **M5** | RegExp 引擎;N4 包验证集(首批 10 包);L1b/L1c | 10 包全绿;dylib demo | **部分达成**:自研 RegExp 引擎已落地(回溯式,大面完整,余 `\p{}`/`v` 标志等,见 ES_SUPPORT.md);**N4 包验证集与 L1b/L1c 未启动** |
| **M6** | N5 `asm.js build`;E3 收尾;N4 二批 10 包;L2a 预研 | 真实 CLI 包单二进制;test262 ≥ 90% | **大部分未启动**:仅 L2a 预研被 route B 超前覆盖(全局 eval/`new Function` 已打通,直接 eval 词法捕获已完成);**N5、N4(含二批)未启动**,E3 收尾(Date 完整等)仍在进行 |

每个里程碑的固定门禁:`npm run test:fixtures` 全绿 + 五目标 `gen2 == gen3` 回放 + 性能不回退(自编译耗时 ±5% 内)。

### M0 GC 设计参考:Go 运行时(用户指定方向)

Go GC 与本项目约束高度同构(非移动、写屏障、单二进制、无 JIT),按性价比排序可借鉴:

1. **span/size-class 页模型**(Go mspan):堆按 8KB 页组织,每 span 固定 size class,
   `地址→span 元数据` O(1) 查表 → 块起始/块大小解析变 O(1)(取代逐块头行走与起始位图回扫),
   同时根治"块头被破坏则 sweep 失步"一类脆弱性。这是对当前 free-list+头内 size 模型的
   结构性升级,收益最大。
2. **GOGC 式步调**:trigger = live_bytes × (1+GOGC/100)(Go 默认 100 即 2×),替代固定阈值;
   配合已有 live_bytes 统计即可落地,数行改动。
3. **混合写屏障(Yuasa+Dijkstra)**:#11 分代线已有 Dijkstra 风格屏障基建;若未来做并发标记,
   Go 的混合屏障允许栈不重扫,是现成蓝本。
4. **bitmap 精确化路线**:Go 每字有 ptr/scalar 位图(编译期类型信息)。asm.js 运行时布局固定
   (对象/数组/Map 头字段偏移已知),可对**运行时容器**做半精确扫描(只扫指针槽),
   保守扫描仅留给栈/未知区 —— 减少误保留与扫描量。
5. **非目标**:Go 的并发/增量标记(STW 缩短)对 CLI 场景收益低,列为远期;移动/压实与
   保守栈扫描冲突,维持非移动。

## 6. 风险登记

| 风险 | 影响 | 缓解 |
|------|------|------|
| 自举冻结税:每改动都要五目标回放 | 迭代速度 | 已有脚本化回放;CI 化(M1 前) |
| RegExp 引擎工作量低估 | M5 延期 | 独立立项、先主路径后完备;可引 test262 regexp 子集分批 |
| 全局单例重构(L2b)牵动全运行时 | 引擎库化后期 | L1 先行变现;L2 等 GC/寄存器分配器稳定后一次性设计 |
| macOS JIT entitlement/签名 | L2a 分发 | 面向开发者文档化;桌面分发场景再评估 |
| 包生态长尾(polyfill 需求爆炸) | N4 达标难 | 只承诺清单内包;清单准入以"纯 JS、无 addon、高下载量"筛选 |
| 静默退化存量 | 用户信任 | E2 全量收口 + 编译期显式报错原则 |
