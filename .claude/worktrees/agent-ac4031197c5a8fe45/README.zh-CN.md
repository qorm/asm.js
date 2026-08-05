# asm.js

> 命名说明:产品正式名称为 **asm.js**(主页 https://asm.js.cn),于 v0.1 公开重初始化(2026-07-19)时由原内部代号 "jsbin" 更名。内部标识符(C API 符号、环境变量)统一使用 `asmjs_*`/`ASMJS_*` 前缀。

[English README](./README.md)

一个把 JavaScript 编译为**独立 ARM64/x64 原生可执行文件**的编译器 —— **零第三方依赖、运行时不需要任何外部解释器**。

## 状态

自举、零依赖的 JavaScript→原生 AOT 编译器(5 目标:macOS/Linux arm64+x64、Windows x64)。最新版 **v0.2.1** — 形状(隐藏类)内联缓存基础设施(对象字面量/类实例静态形状描述符、16 字节双模属性 IC 站点)+ 自举"布局悬崖"根因修复(macOS `writeFileSync` 缺 `O_TRUNC`)——建立在 TypedArray 构造器全局值、静态可解析方法调用的编译期去虚拟化(自编译 −7.5%)、G-M-P N>2 通用工作窃取 + 跨 3 个真线程的 N 路停止世界 GC(linux-arm64)、NUL 透明字符串、AES-GCM 加密、test262 harness、真 zlib / TCP、完整编译器确定性(`gen1==gen2==gen3`)、完整 async 之上。完整版本历史见 **[CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)**。

`asm.js` 已在**两个 ARM64 目标(macOS-ARM64 原生、Linux-ARM64 Docker)上实现自举**:在每个目标上,编译器把自身源码编译成原生二进制,该二进制再次编译编译器,产物**逐字节一致** —— 稳定的自我复现定点(`gen1 == gen2 == gen3`)。x64 三目标(macOS-x64、Linux-x64、Windows-x64)在 v1.1.0 曾达成此定点,当前**不保持**:x64 上完整自编译 CLI 命中一个布局敏感的编译阻塞,正在取证排查(其交叉编译产物仍能正确构建并运行普通程序——五目标平台矩阵绿)。当前支持较大的 ES 子集与有限的 Node 核心 shim 子集;完整 ECMAScript 与完整 Node.js 兼容仍在进行中。

## 现在能做什么

- **ARM64 双目标自举**(macOS-ARM64 原生、Linux-ARM64 Docker):编译器把真实 CLI(`cli.js`)编译成原生二进制;该二进制再编译 `cli.js`,`gen1 == gen2 == gen3` 逐字节一致(稳定定点)。无三方库、无外部解释器。x64 三目标在 v1.1.0 曾达成此定点,当前在完整自编译上回退(布局敏感阻塞排查中;x64 普通程序正确性不受影响)。详见[自举](#自举self-hosting)一节及其中历史结果表。
- 现代 JavaScript 语法:箭头函数、闭包、类(方法/getter/静态)、async/await、Promise、模块、for-of/for-in、try/catch、BigInt、模板字符串、解构
- ESM import/export 流程(通过仓库内 fixtures 验证)
- Node 风格内建:`console`、`process`、`fs`(部分)、`path`、`timers`(部分)、`os`;另有真实 `crypto`(SHA-1/256/512、HMAC、AES-CBC/CTR/GCM、PBKDF2、HKDF)、`zlib`(DEFLATE/gzip)、`net`/`http`/`dgram`、`stream`、`child_process`,均为部分子集;逐模块状态见 [docs/NODEJS_SUPPORT_ANALYSIS.md](./docs/NODEJS_SUPPORT_ANALYSIS.md)
- `JSON.stringify`/`JSON.parse` 全参数(replacer/space/reviver/toJSON;转义含 `\uXXXX`→UTF-8、嵌套结构)—— 以编译器注入的纯 JS shim 实现,其它内建复用该机制
- `instanceof Array/Object`、`Array.isArray`;浮点打印去尾零(常见值与 V8 一致,第 16 位有效数字边角容许偏差)
- 分代垃圾回收器,缺省开启(sticky mark-bit minor + Go 式 full 步调:256MB nursery,堆增长过 live×2 收全堆;保守、非移动)。编译期可退:`GC_FULLONLY=1`(旧 full-only/4GB)、`GC_DISABLE=1`。编译器自编译负载下峰值 RSS 降 ~30%,耗时 ~+5%
- 对受支持程序输出原生可执行文件

## 还不能做什么(已知差距)

- 完整 ECMAScript 覆盖(部分语法/API 未实现;逐版本支持矩阵见 [docs/ES_SUPPORT.md](./docs/ES_SUPPORT.md))
- 完整 Node.js 兼容(核心 shim 仅子集;逐模块 API 状态见 [docs/NODEJS_SUPPORT_ANALYSIS.md](./docs/NODEJS_SUPPORT_ANALYSIS.md))
- 性能:生成代码已有成体系的优化层(区间线性扫描寄存器分配、自验证属性站点缓存、ToNumber 内联快路、比较-分支融合)—— 2026-07 对 Node 24 实测(墙钟,Apple Silicon,输出逐字节一致):数值循环 ~2.7×、属性访问 ~13×、字符串构建 ~3×、Map 存取略快于 Node。优化持续进行

## 优势与局限

对项目现状的诚实评估。各项局限的解决计划见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

### 优势

- **单一静态二进制,零运行时依赖。** 产物是一个原生可执行文件(Mach-O/ELF/PE),不需要解释器、不需要安装 VM、不依赖共享库 —— Go 的部署模型,应用到 JavaScript。
- **经过证明的自举。** 编译器在两个 ARM64 目标上把自身编译到逐字节一致的定点(x64 三目标曾于 v1.1.0 达成,当前回退、排查中)。这是一个强的、可机械验证的正确性声明:编译器自身(~90 个模块)用到的每一个语言特性(闭包、类、ESM 模块、Map/Set、字符串/数组主力方法、fs/path shim)在每次验证中都被端到端锻炼。
- **任意宿主交叉编译。** 任一受支持宿主可产出全部五个目标的二进制;后端与二进制产出层(含 PE/IAT)都在这一个零依赖代码库里。
- **启动快、体积小。** 无 JIT 预热、无快照加载:`main` 毫秒级启动。hello-world 二进制比捆绑 Node/Electron 运行时小几个数量级。
- **全栈可审计。** 词法、语法、编译器、寄存器级代码生成、汇编器、链接器、目标文件写出、GC、运行时库全部为本仓库手写 —— 从 `.js` 源码到可执行字节之间没有任何不透明的第三方层。
- **AOT 友好的语义子集。** 程序在编译期默认是封闭世界 —— 这正是单二进制 AOT 得以成立的前提。(`eval`/`new Function` 为可选项:使用即把进程内引擎库编入产物。)

### 局限

- **是较大的 ES 子集,不是完整 ECMAScript。** 部分内建与边角语义仍不完整(`Intl`、RegExp `\p{…}`/`v` 标志、字符串 UTF-16 码元语义、iterator helpers、内建类子类化);个别构造能编译但行为不正确而非显式报错(正在逐个收敛为编译期显式错误)。见 [docs/ES_SUPPORT.md](./docs/ES_SUPPORT.md)。
- **尚不兼容 Node。** 核心模块 shim 只覆盖子集(`fs`、`path`、`process`、`console`、`os` 及部分其它)。`node_modules`/`package.json`(`exports`)解析与 AOT CommonJS `require` 子集已就位,但真实 npm 包消费尚未验证(环形 `require` 不支持)。见 [docs/NODEJS_SUPPORT_ANALYSIS.md](./docs/NODEJS_SUPPORT_ANALYSIS.md)。
- **性能处于 AOT 档位,分负载差异大。** 2026-07 对 Node 24 实测:数值循环 ~2.7×(优化前 ~14×)、属性访问密集 ~13×(从 ~32× 收窄)、字符串构建 ~3×、Map 操作略快于 Node。要 V8-JIT 级多态属性热循环速度仍不是对的工具;数值/CLI/启动敏感负载差距已收窄到小倍数(asm.js ~2ms 启动 vs Node ~40ms)。已落地杠杆:区间线性扫描寄存器分配、属性站点缓存、ToNumber 内联快路、比较-分支融合;下一杠杆:对象 shape(属性差距)。
- **内存模型为保守式非移动。** 分代 GC(sticky mark-bit minor + Go 式 full 步调,64KB 按类 span + O(1) 页映射)已是缺省;仍为保守/非移动 + 大虚拟地址预留,重负载峰值 RSS 高于成熟运行时(编译器自编译峰值 ~1.4 GB,分代前 ~2 GB)。
- **`eval` 以封闭世界为代价、无 native addon。** 独立二进制默认封闭世界;N-API/`.node` 插件与单二进制模型冲突,不在范围内。全局作用域的 `eval`/`new Function` 现已可用(引擎库 route B:使用它们的程序会把编译器编入产物,见 `engine/README.md`);词法作用域捕获与运行时 specifier 的 `import()` 仍待做(ROADMAP L2c)。
- **未达生产级。** 尚无稳定性承诺与 semver 纪律,主力开发者一人。测试覆盖仍以 fixtures 为主(362/362);test262 符合性 harness 已就位,当前基线为 stride-5 子集(`language/` + 13 个核心 `built-ins/`)1,328 / 6,462 = 20.55%(见 `tests/test262/last_report.md`),数字仍低、正在持续提升。

### 适合与不适合

| 场景 | 适配度 |
|------|--------|
| 以单二进制分发的 CLI 工具 | ✅ 主目标 |
| 启动延迟敏感的短生命周期进程 | ✅ 合适 |
| AOT 预编译的嵌入式 JS 逻辑(规划中的 `--emit lib`) | 🔶 路线图 |
| 长驻计算密集服务 | ❌ 请用 V8/JSC 系运行时 |
| 今天就跑任意 npm 包 | ❌ 还不行(路线图 N 阶段) |
| 动态代码执行(`eval`) | 🔶 仅引擎库形态(ROADMAP L2c) |

## 自举(Self-Hosting)

自举指编译器把**自己的真实 CLI**(`cli.js`)编译成原生可执行文件,该文件再把 `cli.js` 编译一遍,产物**逐字节一致**。自举链:

1. **gen1** — Node 运行编译器,把 `cli.js` 编译为原生二进制
   (`node cli.js cli.js -o gen1 --target <T>`)。这是唯一用到 Node 的一步。
2. **gen2** — `gen1`(无 Node、无三方依赖)把 `cli.js` 编译为 `gen2`。
3. **gen3** — `gen2` 把 `cli.js` 编译为 `gen3`。
4. **定点** — `gen2 == gen3` 逐字节一致:稳定的自我复现编译器。

`gen1 != gen2` 是预期且正常的(Node 运行时与 asm.js 自身运行时在少数库角落不同,约影响 ~11 MB 二进制中的 ~2.4 MB);自举的证明是 `gen2 == gen3` 定点,两个 ARM64 目标达成(x64 三目标 v1.1.0 曾达成,当前回退)。

### 每一代的产生方式

| 代 | 由谁产生 | 命令 | 所用运行时 |
|----|----------|------|------------|
| **gen1** | Node 运行编译器源码 | `node cli.js cli.js -o gen1 --target $T` | Node.js(仅引导种子) |
| **gen2** | `gen1`(原生 asm.js 二进制) | `./gen1 cli.js -o gen2 --target $T` | asm.js 自身运行时 —— 无 Node、无三方依赖 |
| **gen3** | `gen2`(原生 asm.js 二进制) | `./gen2 cli.js -o gen3 --target $T` | asm.js 自身运行时 |

自举证明:`cmp gen2 gen3` → 一致。

### 结果(v1.1.0 定点快照)

> **现状(v1.5.x):** 定点在 **macOS-ARM64**(每次变更复验)与 **Linux-ARM64** 上保持。x64 三目标在 v1.1.0 达成后当前不保持——x64 上完整自编译 `cli.js` 命中布局敏感的编译阻塞(去虚拟化已对 x64 目标关闭,待该阻塞解决后重开)。下表字节数为 v1.1.0 测量值,会漂移。五目标交叉编译与 x64 普通程序正确性仍为绿(`platform_test.sh`)。

下表每行由上述三条命令产生并用 `cmp` 验证。尺寸为 v1.1.0 发布时各目标原生 `cli.js` 编译器的精确字节数(随开发持续漂移;macOS-ARM64 定点每次变更都复验,其余目标在发布时复验)。

| 目标 | 格式 | gen1 (Node→原生) | gen2 (gen1→原生) | gen3 (gen2→原生) | `gen2 == gen3` | 验证环境 |
|------|------|------------------:|------------------:|------------------:|:--------------:|----------|
| macOS-ARM64  | Mach-O arm64  | 12,304,400 | 12,304,400 | 12,304,400 | ✅ | 原生 |
| macOS-x64    | Mach-O x86-64 | 11,051,008 | 11,051,008 | 11,051,008 | ✅ | Rosetta 2 |
| Linux-ARM64  | ELF arm64     | 12,324,361 | 12,324,640 | 12,324,640 | ✅ | Docker `linux/arm64` |
| Linux-x64    | ELF x86-64    | 11,075,035 | 11,075,293 | 11,075,293 | ✅ | Docker `linux/amd64` + Rosetta 2 |
| Windows-x64  | PE32+ x86-64  | 11,071,875 | 11,072,387 | 11,072,387 | ✅ | Wine |

说明:
- **gen1 ≠ gen2 是预期的。** gen1 在 *Node.js* 上运行编译器时产出;gen2/gen3 在 *asm.js 自身运行时*上产出。两个运行时在少数库角落不同,字节流因此不同(部分目标上 gen1 还小几百字节)。证明自举的定点是 `gen2 == gen3`。
- macOS 上 gen1 与 gen2 尺寸相同,但内容不同;尺寸一致是巧合。
- Windows 目标额外锻炼了 PE 产出、kernel32 IAT(`CreateFile`/`ReadFile`/`WriteFile`/`CloseHandle`)以及基于 `GetCommandLineA` 的 `process.argv`。

### 复现

```bash
# 选择目标: macos-arm64 | macos-x64 | linux-arm64 | linux-x64 | windows-x64
T=macos-arm64

# 1) gen1: Node 把真实 CLI (cli.js) 编译为原生二进制
node cli.js cli.js -o gen1 --target $T

# 2) gen2: gen1 编译 cli.js(无 Node、无三方依赖)
./gen1 cli.js -o gen2 --target $T

# 3) gen3: gen2 编译 cli.js
./gen2 cli.js -o gen3 --target $T

# 4) 定点
cmp gen2 gen3 && echo "gen2 == gen3 : $T 上的自举定点"
```

非原生目标请在对应运行时下执行步骤 2–4(Linux 用 Docker、Apple Silicon 上 x64 用 Rosetta 2、Windows 用 Wine)。自举对象是真实 CLI(`cli.js`)编译自身 —— 没有单独的引导驱动程序。

### 自举工程笔记

ARM64 是最初的自举目标;把定点扩展到 x64 与 Windows 目标时暴露了多个只有完整自编译(编译器产出自身 ~11 MB 代码)才会触发的后端/运行时 bug。关键修复:

- **x64 内部调用约定(统一为 SysV)。** x64 后端原先把 Windows 参数映射到 C ABI(`RCX/RDX/R8/R9`),使 `V1–V4` 临时寄存器与 `A0–A3` 参数寄存器别名。共享运行时助手第一条指令 `shr V1, A0, 48` 会毁掉自己的第一个参数 —— 破坏字符串索引、比较与大小写转换。现在所有目标使用同一 SysV 风格内部约定(`A0=RDI … A5=R9`);Win32 ABI 重排只发生在少数 kernel32 调用点。
- **x64 label 分类。** PLT/绝对 vs 相对检测以 `target ≥ codeBase` 为键;`.text` 超过 ~4 MB 后内部 label 触发该阈值被当作绝对地址解析,跳转偏离 ~4 MB。
- **PE IAT 布局。** 导入表 RVA 由 *fixup 前*(空)数据段计算;规模变大后 IAT 落进数据段,`__imp_*` 调用跳进字符串常量。
- **`path` 分隔符。** `path` shim 在 Windows 用 `\`,而整个代码库用 `/` 路径,`dirname("a/b.js")` 返回 `"."`,深层相对导入全断 —— 完整自编译只发现 89 个模块中的 26 个,产物截断到 1 MB。统一为 `/`(Windows 文件 API 也接受)修复了模块发现。
- **Windows `process.argv`。** PE 没有 CRT,`argv` 必须从 `GetCommandLineA` 构造,真实 `cli.js`(从 `argv` 读输入路径)才能引导。
- **保守 GC 与内存布局**(堆增长、对象容量、指针下限)按目标门控,同一份源码在 Mach-O / ELF / PE 及两种页地址约定下都能自举。

所有非 ARM64 修复都按目标门控,ARM64 产物保持逐字节不变;每次变更后五个目标全部重新验证 `gen2 == gen3`。

## 快速开始

```bash
# 把 JavaScript 文件编译为原生可执行文件
node cli.js examples/helloworld.js

# 直接执行(编译→运行→末行打印耗时)
node cli.js run examples/helloworld.js

# 跑测试 fixtures
node tests/run_fixtures.mjs
```

## 项目结构

```
asm.js/
├── cli.js           # 编译器 CLI 入口
├── compiler/        # JavaScript → IR → 汇编 编译器
├── runtime/         # 运行时 shim + GC(console、fs、process、allocator 等)
│   └── node/        # Node 风格 API 实现
├── asm/             # ARM64 与 x64 指令编码
├── binary/          # Mach-O / ELF / PE 目标文件与可执行产出
├── lang/            # 词法 + 语法分析(手写,零三方)
└── tests/
    ├── fixtures/    # ES / 模块 / Node 子集测试用例
    └── test262/     # test262 符合性 harness + 最近报告
```

## 准确表述(Accurate Messaging)

可以说:
- “ARM64 目标自举 / self-hosting”(已验证:`gen1 == gen2 == gen3` 定点;x64 三目标 v1.1.0 曾达成,当前回退排查中)
- “支持较大的 ES 子集”
- “包含有限的 Node 核心 shim 子集”
- “通过仓库 fixtures + 已验证的自编译定点校验”
- “已接入 test262 符合性 harness(首个基线为 stride-5 子集的 20.4%,持续提升中)”

(还)不能说:
- “五目标全部自举”(v1.5.x 起仅 ARM64 双目标)
- “完整 ES 支持”
- “完整 Node 支持”
- “Node 的直接替代品”
- “生产可用”

## 致谢

- **[TC39](https://tc39.es/) 与 [Ecma International](https://ecma-international.org/)** —— 创立并维护 ECMAScript 语言规范(ECMA-262)。本项目实现的是他们数十年精心设计与演进的语言的一个子集。
- **[Node.js 项目](https://nodejs.org/) 与 OpenJS 基金会** —— Node.js 运行时及其 API 设计。asm.js 的核心模块 shim(`fs`、`path`、`process`、`console` 等)遵循 Node.js 开创并标准化的接口,Node.js 本身也是本编译器构建与引导工具链(gen0)的动力。
- **[QuickJS](https://bellard.org/quickjs/)(Fabrice Bellard 及贡献者)** —— 证明了小而完整、自包含的 JavaScript 引擎是可实现的;其设计思想影响了本项目的运行时,包括 NaN-boxing 值表示与紧凑对象布局。
- **[Go](https://go.dev/)(Go Authors)** —— 本项目所追求的编译模型:自举工具链,交叉编译产出单一静态原生可执行文件,全平台无外部运行时依赖。

asm.js 是独立项目,与 Ecma International、TC39、OpenJS 基金会、Node.js 项目、QuickJS 项目或 Go 项目均无隶属或背书关系。
