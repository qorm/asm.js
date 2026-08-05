# C 互操作设计(FFI / 静态库消费 / 库产出)

> 版本:初稿(设计阶段,零运行时代码改动)。
> 目标:为 asm.js 定义与 C 生态协作的完整能力面——①消费 C 动态库(.dylib/.so/.dll)、
> ②消费 C 静态库(.a/.lib)、③把 JS 程序产出为 C 宿主可链接的库(对接 ROADMAP 方向一 L1 系)。
> 输入:2026-07-19 代码侦察五组 + macOS arm64 真机实证四组(产物在 `.agent-work/c-interop-probe/`);
> 本文所有现状事实均来自该输入并以 文件:行号 标注,架构与排期部分为设计决策并逐处注明。
> 铁律:零第三方依赖(明确不引入 libffi);全部改动增量式,不扰动既有五目标产物字节;
> 每阶段门禁 = fixtures 全绿 + 五目标 `gen2 == gen3` 定点回放(macos-arm64 另守
> `gen1 == gen2 == gen3` 字节一致)+ 自编译耗时 ±5% 内。
> 非目标:N-API / `.node` 插件、libffi 级任意签名、struct by-value(初期)、运行期 JIT 代码生成。

---

## 1. 背景与目标

### 1.1 为什么 C 互操作是战略能力

asm.js 的产品形态是零依赖单二进制 AOT 编译器:词法/语法/codegen/汇编器/链接器/GC/运行时全部
手写,产物在 macOS/Linux(arm64+x64)与 Windows x64 五目标自举定点。**零依赖的含义是 asm.js
自身不依赖任何第三方组件即可构建与运行,而不是拒绝用户复用 C 生态。** 用户侧的现实是:

- **系统库**:libz、libcrypto、OS 平台 SDK 的能力都以 C ABI 形式存在于每台目标机器上。asm.js
  运行时的 node shim 目前全部纯 syscall 封装,zlib/crypto 为纯 JS 手写——能用,但每个算法都是
  一笔重造成本(ROADMAP N3 的 zlib/crypto 历程即是例证)。
- **成熟算法库**:sqlite、libpng、数值/编解码库以源码或 .a 形式分发,纯 JS 重写在正确性与
  性能上都不现实。
- **硬件/厂商 SDK**:只提供 C 头文件 + 二进制库,FFI 是唯一接入方式。
- **反向嵌入**:用户已有 C/C++/Rust/Go 宿主程序,需要把 JS 业务逻辑编译成库嵌进去
  (ROADMAP §1 方向一 L1 产品线:`asm.js app.js --emit static|shared`)。

### 1.2 三个方向与总目标

| 方向 | 形态 | 现状一句话(详见 §2) | 承接阶段 |
|---|---|---|---|
| ① 消费 C 动态库 | 编译期经 `.jslib` 声明符号,链接期写 LC_LOAD_DYLIB/DT_NEEDED/import table,加载期由 OS 动态链接器解析 | macOS/Linux-x64/Windows 三条链路均已接线,但实证全部失败或错算(§2.2) | C0 修复 → C3 完善 |
| ② 消费 C 静态库 | `.a` 归档解析 → `.o` 并入 → **重定位** → 符号解析 | 归档/.o 解析骨架在,重定位完全不存在,调用约定错配 | C1 调用层 → C2 重定位 |
| ③ JS 产出库 | `--emit shared|static` → dylib/so/dll/.a + C ABI 包装 | 窄带可用:仅限 double 签名、无运行时 helper 依赖的导出 | C0 修复 → C6(= ROADMAP L1a–L1c) |

总目标:三方向共用一套**类型化声明层(.jslib schema v2)、手写 C ABI 调用层(三平台)、
封送层与 GC 安全层**;动态/静态/产出只是同一调用层在链接层的三种落法。

### 1.3 非目标(明确不做)

- **N-API / `.node` 插件**:README 与 ROADMAP §3.3 已声明出圈,与 AOT 单二进制模型冲突。
- **libffi 级任意签名**:不引入 libffi(零依赖铁律);C ABI 层手写,类型词汇表收敛于
  §3.5 的标量/指针/缓冲子集。
- **struct by-value 传参与返回**(HFA/HVA 分类、sret 内存返回):初期一律以 `ptr` 替代,
  列入远期开放问题(§5.6)。
- **运行期代码生成式 trampoline**(mmap PROT_EXEC 现场生成机器码):与 W^X 及零依赖立场冲突;
  运行期动态加载走数据驱动 trampoline(§3.4 路线 b)。
- **C 异步回调 JS 的一般形态**(C 持有 JS 函数指针、任意线程回跳):初期禁止,例外与协议见 §3.6。

---

## 2. 现状审计

### 2.1 能力三档

**已实现并接线(链路存在,不代表正确)**

| 能力 | 链路 | 备注 |
|---|---|---|
| `--emit shared` | `cli.js:283` → `compileProgramForLibrary`(`compiler/index.js:2516`,WrapperGenerator C ABI 包装)→ `generateSharedLibrary`(`compiler/output/generator.js:178`) | 三平台分支齐全;实证窄带可用(§2.2 实验 C) |
| `--emit static` | `generateStaticLibrary`(`generator.js:349`)→ `writeStaticLibrary`(`index.js:2832`)调系统 `ar rcs`(`index.js:2839`) | 依赖外部 `ar`;产出符号表为空(实验 C) |
| `.jslib` 生成/消费 | 生成:`generateJslibFile`(`index.js:1442`,schema 见 :1467-1477);消费:`import "./*.jslib"`(`lang/parser/modules.js:20/34`)→ `compileImportLibDeclaration`(`index.js:624`)→ `parseJslibFile`(`compiler/output/library.js:101`,纯字符串扫描) | 无类型信息;路径解析有 bug(B6) |
| 动态库消费·macOS | LC_LOAD_DYLIB + `__got` + BIND opcodes + GOT stub:`binary/macho_arm64.js:437-459/152-195`,`asm/arm64.js:1469-1494`,`compiler/functions/functions.js:2309-2312` | ordinal 字段错位(B1),运行即 dyld 报错 |
| 动态库消费·linux-x64 | PT_INTERP + DT_NEEDED + PLT/GOT + R_X86_64_JUMP_SLOT:`binary/elf_dynamic.js:174-494` | 运行期 `pow` 等 libc/libm 调用借此工作(默认注册见 `index.js:298-303`) |
| 动态库消费·Windows | PE import table 机制通用,`addImport` 接受任意 DLL(`binary/pe.js:51-64`) | 调用侧 `baseSlot=5` 硬编码过期(functions.js:2294) |
| 静态库并入通路 | `.jslib` import → `addStaticLib` → `compile()` 时 `embedStaticLibraries`(`index.js:1252-1253`)→ 字节并入(`index.js:2800-2829`) | 仅嵌入;无重定位,调用约定错配(实验 B) |
| 动态库产出·三平台 | Mach-O MH_DYLIB+LC_ID_DYLIB+LC_SYMTAB(`binary/macho_dylib.js:72/277`);ELF ET_DYN+.dynsym+DT_SONAME(`binary/elf_dynamic.js:638/905`);PE DLL+.edata(`binary/pe_dll.js:22/93`) | 三产物均无加载期重定位表(§5.1) |

**骨架存在但未接线 / 半成品**

| 能力 | 位置 | 缺口 |
|---|---|---|
| `--lib` / `--lib-path` CLI | `cli.js:163-168` → `addLibrary/addLibraryPath`(`index.js:330-336`)存入 `this.libraries` | **全仓库无读取者,死代码**(实验 D) |
| `binary/static_linker.js` | ar 归档解析(BSD 长名/GNU 字符串表,:102-177);.o 解析(Mach-O/ELF64/COFF-AMD64) | 不校验 cputype/e_machine;无 thin archive、`/SYM64/`;全量加载(无符号驱动按需提取);**重定位完全不存在**(Mach-O 不读 reloff/nreloc,ELF 不读 SHT_RELA,COFF 显式 TODO :662);弱符号/common 不处理;重复定义静默覆盖;未定义符号无解析无报错;无对齐、无 .rodata/__cstring/.bss |
| `binary/dylib.js` 全套 | DylibConfig/LinkerConfig/SymbolResolver/ExportCollector | 无人使用 |
| 外部符号静态调用路 | `functions.js:2270` 起 | 疑似断路:`getFunctionLabel` 要求 `ctx.hasFunction`,jslib 符号不注册进 `ctx.functions` |
| C 约定参数发射 | `compileCallArgumentsForCConvention`(`index.js:2997-3021`) | 仅 double 经浮点寄存器传参;返回值一律按 double(fmovToInt);无整型/指针/字符串/结构体 |

**不存在**

- 重定位执行器(三格式全部,见上)。
- 运行期动态加载:`dlopen`/`dlsym`/`LoadLibrary`/`GetProcAddress` 全仓零命中。
- rpath:无 LC_RPATH / DT_RPATH / DT_RUNPATH;产出 install_name 固定 `@rpath/<basename>`(`generator.js:196`)。
- Linux arm64 动态消费通路:`elf_dynamic.js` 的 `EM_X86_64`(:267)与 interp(:188)硬编码。
- 封送层与 GC handle/pin API;JS 语言表面无任何 declare/extern/ffi 语法。
- 公开 `asmjs_eval` C ABI 入口:`engine/` 的 asmjsEval/asmjsFunction 是 throw 骨架,eval 实际走 `runtime/node/__eval_shim.js`。

### 2.2 实证结果(2026-07-19,macOS arm64 真机,产物 `.agent-work/c-interop-probe/`)

| 实验 | 内容 | 结果 | 根因 |
|---|---|---|---|
| A | 消费动态库(clang 产 libctest.dylib,.jslib 声明后调用) | ❌ 编译过,运行 `dyld: Symbol not found` | B1:bind ordinal 字段错位 |
| B | 消费静态库(clang -c 产 .o 打成 .a,嵌入并调用) | ❌ 无 reloc 的 .o 嵌入成功,但调用结果乱码;带 PAGE21/PAGEOFF12 reloc 的 .o 同样嵌入但重定位未处理 | B2:调用约定错配;重定位不存在(能力缺口) |
| C | 产出库(`--emit shared` 恒等函数 `js_id`) | ⚠️ 产出 dylib 可被 C 宿主链接调用,实测 `js_id(2.5)=2.5`;但凡需 `_js_add`/`_number_coerce` 等 helper 的导出编译即失败 `Unknown label`;`--emit static` 产出 .a 的 LC_SYMTAB nsyms=0,无法链接 | B4/B3 |
| D | `--lib` / `--lib-path` 消费任意库 | ❌ 产物无任何库引用,死代码证实 | B5 |

### 2.3 六个具体 bug 清单

| # | 位置 | 现象 | 根因 |
|---|---|---|---|
| B1 | `binary/macho_arm64.js:158` 读 `sym.dylibIndex \|\| 2`;`asm/arm64.js:118-119` 存 `{ dylib: dylibIndex \|\| 1 }` | 实验 A 运行期 dyld Symbol not found | **字段名错位**:写入侧字段叫 `dylib`,读取侧读 `dylibIndex` → 恒 undefined → ordinal 恒回退默认 2(恰好指向重复注册的 libSystem,`index.js:298-303`),bind 永远落错库 |
| B2 | `index.js:2997-3021`(double-only 发射)+ `functions.js:2270` 起(静态路走内部约定) | 实验 B 调用结果乱码 | **调用约定错配**:静态调用走 asm.js 内部 NaN-boxed 整数寄存器约定(A0-A5),而 C 函数按 AAPCS 读 D0/D1、返回值写 D0;且静态路疑似断路(getFunctionLabel 要求 ctx.hasFunction,jslib 符号不注册进 ctx.functions) |
| B3 | `index.js:2832-2839`(writeStaticLibrary → `ar rcs`) | 实验 C:`--emit static` 产出 .a 无法链接 | **符号表为空**:并入 .o 时 LC_SYMTAB nsyms=0,`ar` 归档无符号索引 |
| B4 | `generateSharedLibraryRuntime` 是空函数(`generator.js:178` 链路) | 实验 C:依赖 helper 的导出编译失败 `Unknown label` | **运行时 helper 未随库产出发射**:导出包装器只编用户函数,`_js_add`/`_number_coerce` 等 helper 无定义体 |
| B5 | `cli.js:163-168` → `index.js:330-336` | 实验 D:`--lib` 无效 | **死代码**:`this.libraries` 存入后全仓无读取者;而 `.jslib` import 通路(`index.js:1252-1253`)是通的,两条入口未汇合 |
| B6 | `compiler/output/library.js:101-104` | `import * from "./ctest.jslib"` 须写 `"../ctest.jslib"` 才命中,失败仅 `console.log("Warning...")` 静默跳过 | **相对路径 base 错**:jslib 相对路径被 join 到**源文件全路径**(而非其所在目录),解析失败又无响亮报错 |

关联已知缺陷(不在实证六项内,随阶段处理):Windows `baseSlot=5` 硬编码过期
(`functions.js:2294`,kernel32 现导入 10 个函数,外部 DLL 的 IAT 槽位全部算错);
Linux arm64 动态通路缺失(`elf_dynamic.js:267/:188` 硬编码 EM_X86_64 与 interp)。

### 2.4 诚实结论

**文档与代码表面上声称的三方向能力,今天实测全部不可用或仅窄带可用**:动态消费死在
一个字段名上(B1),静态消费死在约定错配与缺失的重定位器上(B2),静态产出死在空符号表上
(B3),共享产出只能导出"不碰运行时"的纯 double 函数(B4),`--lib` 是死代码(B5),
而发现这一切的前提是先绕过 jslib 路径解析 bug(B6)。好消息是:绝大多数失败都是**接线级
bug 而非架构性缺陷**——三平台的动态库写出器、ar/.o 解析器、WrapperGenerator 都在,差距集中
在"最后一步的对齐"。C0 阶段(§4)即以修复这 6 个 bug 为全部内容。

---

## 3. 总体架构

### 3.0 分层总览(设计决策)

```
用户 JS 源码 + .jslib(schema v2,类型化签名)
        │  声明层(§3.1):解析签名表,符号注册进 ctx,类型校验编译期完成
        ▼
C ABI 调用层(§3.2):callCFunction 发射路径,三平台参数分类(手写,无 libffi)
        │
        ├─ 链接期声明 ─→ 链接层(§3.3)
        │      ├─ 静态:static_linker.js 重定位执行器 + 段布局 + 符号解析
        │      └─ 动态:BIND/PLT/GOT/IAT 三平台既有写出器(修 B1/baseSlot/Linux-arm64)
        ├─ 运行期声明 ─→ 运行层(§3.4):dlopen/dlsym/LoadLibrary 封装 + 数据驱动 trampoline
        ▼
封送层(§3.5):NaN-box ↔ C 标量/指针/缓冲转换
安全层(§3.6):GC pin API、C 持指针规则、blocking 声明与 STW 协议
```

产出方向(③)复用同一套封送层与 ABI 分类,方向相反(C→JS),见 §3.7 与 §4 C6。

### 3.1 声明层:.jslib schema 演进(设计决策)

> **已被取代(2026-07-19 维护者指令)**:声明格式废弃 .jslib,改为**直接消费 C 头文件(.h)**,
> 见 `docs/C_HEADER_DECLARATION.md`(本节仅作历史记录保留;schema v2 的 signatures 表结构
> 原样成为 .h 解析器的内部产出格式,§3.2 起全部下游设计不受影响)。

**现状 schema**(`index.js:1467-1477` 生成,`library.js:101` 纯字符串扫描):

```js
export const __lib__ = { name: "ctest", version: "1.0", path: "./libctest.dylib" /* type 省缺 "shared" */ };
export function ctest_add();   // 若干无参空体声明行,仅提供符号名
```

问题:无参数/返回值类型 → 编译器只能按 double 处理一切(B2 的直接成因);符号不注册进
`ctx.functions` → 静态路断路。

**schema v2(设计决策)**:`__lib__` 内嵌 `signatures` 表,声明行保留(模块解析依赖其符号清单,
`modules.js:20/34`):

```js
export const __lib__ = {
  name: "z", version: "1.0", path: "/usr/lib/libz.dylib", type: "shared",
  signatures: {
    crc32:         { params: ["u64", "buffer", "u32"], returns: "u64" },
    compressBound: { params: ["u64"], returns: "u64" },
  },
};
export function crc32(crc, buf, len);
export function compressBound(sourceLen);
```

- **类型词汇表**(与 §3.5 封送层共用):`i8/i16/i32/i64/u8/u16/u32/u64/f32/f64/ptr/cstring/buffer/void`;
  `buffer` 是 (ptr,len) 双参数语法糖,展开后按 ptr+u64 走 ABI 分类。
- **可选修饰**:`blocking: true`(§3.6 的 STW 协议)、`variadic: true`(仅 C4 起支持,§3.2)。
- **平滑升级(设计决策)**:无 `signatures` 字段的 v1 jslib 全部参数与返回值按 `f64` 处理——
  与今日 double-only 行为逐义等价,存量 jslib 零迁移;解析器沿用字符串扫描,先提取
  `signatures` 块再扫声明行,不引入 JSON 解析器依赖(asm.js 自举闭包内手写扫描即可)。
- **响亮失败**:jslib 找不到/签名表语法错/类型词未知 → 编译期显式报错(反静默退化原则,
  同时修掉 B6 的静默跳过)。
- **长期可选项(不做承诺)**:`declare extern function crc32(crc: u64, buf: buffer, len: u32): u64`
  语法糖,糖落点即上述签名表;在 schema v2 稳定前不动 parser。

### 3.2 C ABI 调用层:三平台手写参数分类(设计决策)

不引入 libffi。理由:asm.js 已有三平台手写汇编器与 backend 抽象,C ABI 参数分类是确定性的
寄存器分配问题,引入 libffi 反而带来构建依赖与自举闭包外的黑盒;且类型词汇表已收敛(§3.5),
分类规则是有限的。

| 平台约定 | 整参/指针寄存器 | 浮参寄存器 | 栈规则 | 返回值 |
|---|---|---|---|---|
| SysV x64(linux/macos-x64) | RDI/RSI/RDX/RCX/R8/R9 | XMM0–7 | call 前 RSP 16 对齐;溢出参数右到左压栈 | int/ptr→RAX,f64→XMM0;变参须置 AL=已用向量寄存器数 |
| AAPCS64(macos/linux-arm64) | X0–X7 | D0–D7 | SP 恒 16 对齐;溢出参数走栈 | int/ptr→X0,f64→D0 |
| Win64 | RCX/RDX/R8/R9(与浮参同槽位) | XMM0–3(与整参同槽位) | 调用方预留 32B shadow space + 16 对齐;≥5 参走栈 | int/ptr→RAX,f64→XMM0;FP 变参须 GPR/XMM 双写 |

实现要点(设计决策):

- **独立发射路径** `callCFunction`:不复用内部 `compileCallArguments`。内部约定是 NaN-boxed
  64 位字经 A0-A5(arm64 X0-X5,x64 SysV 序,Win 序)、上限 6 参、返回 X0/RAX、不用浮点
  寄存器传参(§侦察4);C 约定是**裸标量双轨分类**(整参轨/浮参轨各自计数,Win64 单轨同槽)。
- **参数分类表驱动**:三架构共用一份分类算法(输入签名 → 输出"每参数落点:GPR k / FP k /
  栈偏移"),backend 只提供搬寄存器/压栈原语。控制三平台维护成本(§5.2)。
- **栈对齐**:x64 内部约定不保证调用前栈 16 对齐(Windows 胶水显式 `and RSP,-16`,
  `backend/x64.js:1287-1298`);`callCFunction` 在 trampoline prologue 统一对齐并预留
  shadow space/溢出区,与内部约定解耦。
- **返回值分派**:按签名 returns 装箱——`i32/u32`→int32 装箱,`i64/u64/ptr`→BigInt,
  `f64`→unbox 直取,`void`→undefined。替代现状"一律 fmovToInt 当 double"(`index.js:2997-3021`)。
- **变参**:SysV 置 AL、Win64 双写,规则已在表内;**C1 只承诺定参函数**,variadic 随 C4 的
  trampoline 描述符一并交付(printf 族在此之前经 wrapper 函数消费)。
- **工作量估算**:分类算法 ~300 行(共享)+ 每架构 trampoline 发射 ~250-400 行,合计
  约 1200-1500 行编译器源码,全部进自举闭包,须按定点振荡纪律小波次提交。

### 3.3 链接层

**静态(设计决策,`binary/static_linker.js` 演进)**

1. **重定位执行器**——按架构覆盖务实子集(clang -c 常见形态,覆盖即能用,不求全集):

   | 格式 | 必须覆盖的 reloc 类型 |
   |---|---|
   | Mach-O arm64 | ARM64_RELOC_PAGE21、PAGEOFF12、BRANCH26、GOT_LOAD_PAGE21、GOT_LOAD_PAGEOFF12、POINTER_TO_GOT |
   | Mach-O x64 | X86_64_RELOC_BRANCH、SIGNED(/1/2/4)、GOT_LOAD、GOT |
   | ELF aarch64 | R_AARCH64_CALL26、ADR_PREL_PG_HI21、ADD_ABS_LO12_NC、ADRP+LDST 对 |
   | ELF x86_64 | R_X86_64_PC32、PLT32、GOTPCREL、32S |
   | COFF AMD64 | IMAGE_REL_AMD64_REL32、ADDR32、SECREL |

   未覆盖类型 → 响亮报错列出不支持的 reloc,绝不静默错链(现状是 COFF 显式 TODO :662,
   Mach-O/ELF 根本不读)。
2. **段布局补全**:除 `__text/.text` 外接收 `__rodata/.rodata`、`__cstring`、`.bss/common`
   (bss 并入产物数据段零区);符号按基址+value 写 `asm.labels` 的既有机制(`index.js:2800-2829`)
   保留,增加对齐约束。
3. **符号解析**:符号驱动按需提取(替代全量加载);未定义符号先查既有 jslib/动态注册、再查其它
   成员 .o、最终报错清单;弱符号按"有强用强"解析;重复定义诊断(替代静默覆盖);架构校验
   (Mach-O cputype、ELF e_machine、COFF Machine 与目标不符即报错)。
4. **`--lib` 接线(修 B5)**:`this.libraries` 的读取者汇入 `addStaticLib` 通路
   (`index.js:1252-1253`);检索规则:`-lfoo` → 按 `--lib-path` 顺序找
   `libfoo.a`(unix)/`foo.lib`(Windows),与系统链接器惯例一致。

**动态(修复与补全)**

- B1:统一字段名(写读两侧取 `dylibIndex` 或 `dylib` 其一),并加一个"ordinal ≠ 默认 2"的
  双库 fixture 防回归(单库场景恰好掩盖此 bug)。
- Windows:`baseSlot` 改为按实际 kernel32 导入数现算(functions.js:2294 的硬编码 5 过期,
  kernel32 现导入 10 函数),外部 DLL 槽位分配表化。
- Linux arm64:`elf_dynamic.js` 的 EM_X86_64(:267)/interp(:188)硬编码参数化,
  PLT/GOT 代码生成按 aarch64 形态补齐(ADRP+LDR+BR)。
- rpath:消费侧写 LC_RPATH/DT_RUNPATH(`$ORIGIN`/`@loader_path` 相对项),产出侧 install_name
  维持 `@rpath/<basename>`(`generator.js:196`)并在文档写明宿主义务。

### 3.4 运行层:运行期动态加载(设计决策)

现状:`dlopen/dlsym/LoadLibrary/GetProcAddress` 全仓零命中。API 草案(参考 Deno.dlopen /
Bun FFI 的声明式形态,适配 AOT 封闭世界——句柄与符号在 JS 侧是运行期值,签名是数据):

```js
// 内建模块 "ffi",编译期静态 import(AOT 友好,无动态 require)
import { dlopen } from "ffi";
const libz = dlopen("/usr/lib/libz.dylib", {
  crc32: { params: ["u64", "buffer", "u32"], returns: "u64" },
});
const sum = libz.crc32(0n, buf, buf.length);   // bigint 返回
```

两条实现路线(设计决策,两者都要,分工明确):

| 路线 | 机制 | 用于 | 代价 |
|---|---|---|---|
| (a) 专用 trampoline | jslib 符号编译期已知,codegen 为每个符号发射专用参数搬运 + call + 装箱 | 链接期声明(静态/动态,方向①②) | 零运行期开销;类型错误编译期暴露 |
| (b) 数据驱动通用 trampoline | 每架构一段**编译期发射的手写汇编**,运行期读签名描述符(数据段记录:参数类别码序列 + 返回类别),循环搬 GPR/FP/栈后间接调用 | 运行期 dlopen(方向④,符号编译期未知) | 每架构 ~100-150 行 asm 生成器代码;每次调用多一次描述符解释循环 |

**(b) 明确不做运行期机器码生成**:描述符是纯数据,trampoline 本体随产物编译期成型——不碰
mmap(PROT_EXEC)、不违 W^X、不引入任何依赖,与零依赖铁律相容。首版 (b) 只交付同步调用子集
(无回调、无 variadic);签名描述符格式与 (a) 的分类算法共用同一份类型词汇表。

### 3.5 封送层:NaN-box ↔ C(设计决策)

值表示现状:NaN-boxing,高 16 位 0x7FF8 基,bits 48-50 tag,低 48 位 payload
(`runtime/core/jsvalue.js:20-63`)。转换规则:

| C 类型 | JS → C | C → JS |
|---|---|---|
| i32/u32 | ToInt32/ToUint32(ECMA 语义) | int32 装箱 |
| i64/u64 | BigInt 直取位型;number 经 ToInteger 截断(溢出按 64 位回绕,文档化) | BigInt |
| f32/f64 | unbox 直取(f32 经单精度降级) | f64 number |
| ptr | 仅接受 BigInt(位型)或 ArrayBuffer(取 data_ptr) | BigInt(不透明指针) |
| cstring | 堆串**拷贝**一份并显式补 NUL 后传指针(串布局:内容指针=块 user_ptr,长度在块头 content-16,长度权威、NUL 透明,`runtime/types/string/index.js:14-19/400-421`;内嵌 NUL 不报错,C 侧按 C 语义截断,文档化) | 按 NUL 定长拷入新堆串 |
| buffer | ArrayBuffer 取 (data_ptr@+16, byteLength)(32B 头 type\|byteLength\|data_ptr\|owner,`runtime/types/typedarray/index.js:58-75`),展开为两个 ABI 参数 | (ptr,len) → 新 ArrayBuffer(拷贝) |

原则(设计决策):**显式封送优先**——只封送类型词汇表内的值;不自动遍历/封送任意 JS 对象图
(对象图传递=远期 engine 形态话题);所有拷贝方向明确,生命周期规则见 §3.6。

### 3.6 安全层:GC 与并发协议(设计决策)

- **风险实体**:GC 保守 mark-sweep、非移动,根 = 主栈 + 数据段 + 寄存器 spill + 协程栈 + 已 park
  M 的栈(`runtime/core/allocator.js:3311-3366/3398-3428`)。**C 栈与 C 堆上的 JS 指针不被扫描**,
  无 handle/pin API → 长寿命 C 持针会被回收(不移动故不悬垂,但会释放)。
- **pin API(设计决策)**:`_ffi_pin(obj) → handle` / `_ffi_unpin(handle)`:钉住表为数据段登记的
  指针数组(GC 根扫描新增一区,复用 addDataLabel 机制)。非移动 GC 下 pin = 保活即可,无需
  relocating handle,实现是"数组 push + 根区扩张",单 M 下零锁。
- **C 持有 JS 指针规则(用户文档)**:① 调用持续期内裸持合法(buffer/data_ptr 直传即此形态);
  ② 跨调用持有必须 pin;③ C 侧 malloc 内存中的 JS 指针 GC 不可见,违规后果自负(与
  PARALLEL_DESIGN §5 同一立场:运行时自身不受损,用户对象无保证)。
- **阻塞调用与 STW(G-M-P 上线后的协议)**:停点仅在调度环圈首与 `_mcache_refill` 入口
  (`runtime/core/parallel_sched.js:52-54`);长时间 C 调用无 poll → `_stw_begin` 自旋超时返 0
  (:779-815)。协议:`blocking: true` 声明的调用,进入前在当前 M 上下文记录"in-C"状态与栈区间,
  STW 协调者把 in-C 的 M 视同已 park(其堆指针活跃度由"调用参数已全部封送为标量/拷贝"保证——
  故 **blocking 声明仅允许标量/拷贝型签名**,持 buffer 裸针的长调用属规则③违规)。该能力仅
  linux-arm64(G-M-P 现状),单 M 目标无此问题,其余平台 blocking 修饰先解析不生效(文档化)。
- **C 回调 JS**:初期禁止(C 侧函数指针参数类型词暂不提供 closure/funcptr);唯一受控例外=
  "同一 C 调用内同步回调、回调函数是编译期已知的 JS 函数、经 §3.7 导出包装器取地址"——随 C5
  评估,C1-C4 不承诺。

### 3.7 产出方向复用关系(设计决策)

方向③(JS 产出库)是同一调用层的镜像:C→JS 方向,WrapperGenerator
(`compiler/output/wrapper.js:27-99`,现状仅 double 签名、AAPCS/SysV/Win 三种)按签名表生成
C ABI 入口 → 内部解箱/装箱复用 §3.5 封送层;`--emit shared` 产物缺加载期重定位表的问题与
ROADMAP §1.3「PIC/加载期重定位表一处做两处复用」是同一项工作,见 §5.1 展开与 §4 C6。

---

## 4. 分阶段实施计划

工作量参照系:以一名熟悉 codegen/asm/backend 三层、日常以**自编译 cli.js**(定点回放负载)
为回归手段的工程师计,单位人日。每阶段固定门禁:**fixtures 全绿 + 五目标 `gen2 == gen3`
回放 + macos-arm64 `gen1 == gen2 == gen3` 字节一致 + 自编译耗时 ±5%**;新增能力配
`tests/ffi/` 套件(§5.4 矩阵)。

### C0 — 修复层:六个 bug(quick win)

| 内容 | 关键工作 | 工作量 |
|---|---|---|
| B1 bind ordinal 字段错位 | 统一字段名;新增双 dylib fixture(两个不同 ordinal 的库各调一个符号) | 0.5 人日 |
| B6 jslib 相对路径 base | join 到源文件所在目录;找不到即响亮编译错(反静默) | 0.5 人日 |
| B5 `--lib` 死代码 | 读取者汇入 `addStaticLib` 通路;`-lfoo` 检索(§3.3-4) | 1 人日 |
| B3 `--emit static` 空符号表 | 产出 .o 的 LC_SYMTAB/symtab 写出修复,`nm` 可见导出符号 | 1-2 人日 |
| B4 generateSharedLibraryRuntime 空函数 | 共享库产出时随附被依赖的运行时 helper 子集(按导出闭包收集) | 2-3 人日 |
| B2 最小修(仅限 double 通路) | 既有 f64 签名按目标 ABI 走 FP 寄存器传参/取返回(AAPCS D 系、SysV XMM、Win XMM+shadow space);静态路 jslib 符号注册进 ctx 消断路 | 2-3 人日 |

- 前置依赖:无。
- 验收:实验 A–D 四组按附录 §6.1 原命令重跑全绿(A 调通、B 的 double 版结果正确、C 含
  helper 依赖导出可链接、D `--lib` 生效);定点门禁。
- 合计:**6-9 人日**。此阶段后,文档声称的既有能力才真正可用——先于一切新设计落地。

### C1 — 类型化 .jslib + C ABI 调用层

- 内容:schema v2 解析(signatures 表 + 类型词汇表,§3.1);分类算法 + 三架构
  `callCFunction` 发射路径(§3.2);整参/指针/返回值分派;栈对齐与 shadow space。
- 关键工作:分类表驱动共享算法;jslib 符号注册进 `ctx.functions` 带签名;v1 jslib 兼容模式
  (全 f64)fixture。
- 前置:C0(B2 最小修是 C1 的单类型特例)。
- 验收:`tests/ffi/` 首批——macOS arm64 调 libSystem `strlen(cstring)→u64`、`snprintf`(定参
  wrapper)、libm `pow(f64,f64)` 既有路径回归;x64/Win 同组;结果与 C 参考程序逐值一致;门禁。
- 工作量:**15-25 人日**(三架构各一轮真机/CI 校准)。

### C2 — 静态库重定位

- 内容:重定位执行器按 §3.3 表逐架构落地;段布局补全;符号驱动按需提取;弱符号/重复定义/
  架构校验诊断。
- 架构优先级(设计决策):**macOS arm64 先行**(宿主开发机 + 实验 B 已铺底)→ ELF x86_64 →
  ELF aarch64 → Mach-O x64 → COFF AMD64。每架构一个波次,波次间过门禁。
- 前置:C1(调用约定先行,否则重定位对了也算错参数)。
- 验收:clang -c 产出带 PAGE21/PAGEOFF12/BRANCH26 的真实 .o 打成 .a 经 `--lib` 链接调用成功;
  **Tier-2 验证:sqlite3 amalgamation 单文件编 libsqlite3.a,JS 侧 exec `SELECT 1+1` 返回 2**
  (macOS arm64 + linux x64 双平台);未覆盖 reloc 响亮报错 fixture;门禁。
- 工作量:**25-40 人日**(五格式 × 诊断面,逐架构)。

### C3 — 动态库完善

- 内容:Linux arm64 动态消费通路(EM_X86_64/interp 参数化 + aarch64 PLT/GOT);Windows
  baseSlot 现算 + 外部 DLL IAT 槽位表化;rpath(LC_RPATH/DT_RUNPATH,`$ORIGIN`/`@loader_path`)。
- 前置:C0(B1 修后 macOS 通路已通)。
- 验收:三 OS 五目标消费系统库 fixture(linux-arm64 调 libc `strlen`;Windows 调非 kernel32
  的外部 DLL 如 msvcrt `abs`);rpath 相对加载 fixture;门禁。
- 工作量:**10-15 人日**。

### C4 — 运行时动态加载 API

- 内容:dlopen/dlsym/LoadLibrary/GetProcAddress 三平台封装(syscall/IAT 层);`ffi` 内建模块
  与 `dlopen(path, signatures)` API;数据驱动通用 trampoline(§3.4-b)+ variadic(AL 约定)。
- 前置:C1(类型词汇与分类算法复用);C3 不阻塞(运行期加载不依赖链接期通路)。
- 验收:JS 运行期 `dlopen("/usr/lib/libz.dylib")` 调 `crc32` 与 C 参考逐值一致(不预先 --lib);
  Windows `LoadLibrary("msvcrt")` 同组;签名描述符非法响亮报错;门禁。
- 工作量:**15-20 人日**。

### C5 — 封送层与 GC 安全 API

- 内容:pin/unpin API + 根区扩张;`blocking` 声明与 STW 协议(linux-arm64);封送类型全表收尾
  (f32/cstring 回传/buffer 回传);用户文档(C 持针规则、封送语义)。
- 前置:C1;blocking 协议另依赖 G-M-P 现状(linux-arm64 only)。
- 验收:pin 存活测试(C 侧跨调用持针 + 强制 GC 压力,对象存活);未 pin 场景的文档化;
  blocking 标记的 100ms C sleep 与并发 STW 共存冒烟(linux-arm64 Docker);门禁。
- 工作量:**10-15 人日**。

### C6 — 产出方向修复与泛化(= ROADMAP L1a + L1b,预置 L1c)

- 内容:导出签名泛化(突破 double-only,复用 §3.5 封送层,= ROADMAP L1b 值封送);
  `--emit static/shared` 的 helper 闭包收集与符号表(C0 的 B3/B4 在此泛化);C 头文件生成
  (签名 → .h 声明);**PIC/加载期重定位表方案**(与 ROADMAP §1.3 一致:一处做,L1c 动态库与
  L2a 内存执行两处复用,展开见 §5.1)。
- 前置:C1(封送/签名词汇);C0。
- 验收:C 宿主链接 `libapp.dylib`(macOS)+ `libapp.a` + `app.dll` 调用**含 helper 依赖**的
  导出函数(如 `js_add` 走 `_js_add`)返回正确;导出整参/指针签名;五目标产物齐出;门禁。
- 工作量:**20-30 人日**(PIC 方案占大头,见 §5.1)。

**汇总**:C0–C6 ≈ **100-150 人日**(单人 5-7.5 个月量级);C0/C1 是价值密度最高的前两刀
(6-9 + 15-25 人日换来"动态/静态消费真正可用")。

---

## 5. 风险与开放问题

### 5.1 PIC / 加载期重定位表:一处做、两处复用(ROADMAP §1.3 的展开)

三个库产出物今天都没有加载期重定位表:Mach-O 无 LC_DYLD_INFO/rebase(`macho_dylib.js:72/277`),
ELF 无 DT_RELA(`elf_dynamic.js:638/905`),PE 无 .reloc(`pe_dll.js:22/93`)——因为代码生成是
绝对寻址烘焙(fixup 直接写死绝对地址,`asm/arm64.js:1695`)。可执行体靠固定加载基址蒙混,
动态库被 ASLR 重定位即坏。方案(设计决策):**自研定长重定位表 + 启动时自修复**(产物入口/
`__attribute__((constructor))` 等价物遍历表项加 slide),而非平台原生 rebase 格式——理由是同一张
表可被 L2a 内存执行(mmap 到任意基址)原样复用,且格式自控、跨三平台同一实现。代价:codegen
需增加"可重定位发射模式"(每个绝对地址 fixup 同步登记表项),触及 asm.fixupAll 热路径,是 C6
工作量的大头;另一选项是平台原生 rebase(LC_DYLD_INFO/DT_RELA/.reloc 三套),对 L2a 无复用价值,
记为备选否决。风险:若拖延此项,`--emit shared` 只能承诺"加载到首选基址"的窄场景。

### 5.2 手写 ABI 层的三平台维护成本

每新增架构(远期 riscv64 等)都要交一次 ABI 分类税;三平台的边角(Win64 同槽位、AAPCS
variadic 全栈化、SysV AL)易在"能跑"后被遗忘。缓解:分类算法表驱动、backend 只出原语(§3.2);
每平台验收 fixture 同一组语义用例,分歧即 bug;variadic/HFA 等明确列为未支持时的响亮报错
先于静默错值。

### 5.3 保守 GC 与外部内存的边界

pin API 解决了保活,但边界仍有三处开口:① C 侧 buffer 里写入的 JS 指针 GC 不可见(规则③
靠用户纪律);② buffer 裸针交给 C 做**长**调用时,该 ArrayBuffer 必须隐式 pin 到调用返回
(实现:调用帧上登记,trampoline epilogue 摘除);③ owner 字段(`typedarray/index.js:58-75`)
与外部内存的归属语义需要文档化"C 不得 free asm.js 指针"的对称规则。这些都不是机制缺口,
但每一条都值一次真实崩溃。

### 5.4 C 互操作测试矩阵(test262/fixtures 之外)

| 档 | 内容 | 覆盖阶段 |
|---|---|---|
| Tier 0 | 合成 .o(clang -c,各 reloc 类型逐一)+ 合成 dylib | C2 逐架构 |
| Tier 1 | 系统库:libSystem/libc/libm(macOS/Linux)、kernel32/msvcrt(Windows)、libz(crc32/compressBound) | C1/C3/C4 |
| Tier 2 | 单文件静态库:sqlite3 amalgamation、miniz | C2 验收线 |
| Tier 3(远期) | 多文件库:libpng(依赖 zlib,检验跨库符号解析) | C2 之后评估 |

真实库版本漂移由 fixture 锁定平台基线;CI 五目标回放与 fixtures 门禁不变。

### 5.5 与 engine/ 引擎库形态的交互

L2 route B 的 eval(`runtime/node/__eval_shim.js`)在封闭世界假设下**不能声明新外部符号**
(符号与 trampoline 都是编译期产物);但 eval 代码**调用已声明符号**应可行(符号已在二进制内,
trampoline 已发射)——此语义差异须写入引擎库文档,与 ROADMAP L2c"独立可执行产物维持无 eval"
的立场一致。开放问题:engine 形态下 dlopen 的符号可否注册进运行期引擎的符号表(需要 C4 的
描述符机制与引擎符号表打通,C5 之后评估)。

### 5.6 开放问题清单

- variadic 真实支持度:C1 只承诺定参;printf 族经 wrapper 还是等 C4 的 AL/双写,按 C1 验收时
  的真实需求裁定。
- struct by-value(HFA/sret):远期;以 ptr 替代期间的用户心智成本可接受。
- errno/线程局部:C 库 errno 是 TLS,asm.js 无 libc 不代管;G-M-P 下多 M 并发调同一 C 库的
  线程安全性归用户(与 PARALLEL_DESIGN §5 立场一致),但需一条文档声明。
- 回调函数指针类型词(funcptr):C5 评估唯一受控例外形态(§3.6),不承诺一般形态。

---

## 6. 附录

### 6.1 实证验证四实验(2026-07-19,macOS arm64,产物 `.agent-work/c-interop-probe/`)

| 实验 | 原始命令(实录摘要) | 结果摘要 |
|---|---|---|
| A 消费动态库 | `clang -shared -o libctest.dylib ctest.c`;`node cli.js main.js`(main.js 经 `import "./ctest.jslib"` 声明后调用 `ctest_add`) | 编译成功;运行 `dyld[pid]: Symbol not found: _ctest_add` → 退出。根因 B1:bind ordinal 恒落默认 2(重复注册的 libSystem) |
| B 消费静态库 | `clang -c -o stest.o stest.c && ar rcs libstest.a stest.o`;同法制作带全局变量引用(PAGE21/PAGEOFF12 reloc)的第二版;.jslib import 嵌入 | 无 reloc 版:嵌入成功(字节并入),调用返回乱码(B2 约定错配:内部 A 寄存器 vs AAPCS D0/D1);reloc 版:同样嵌入,重定位未处理(地址未修正,静态链接器不读 reloff/nreloc/SHT_RELA) |
| C 产出库 | `node cli.js lib.js --emit shared -o libjsid.dylib`(导出 `js_id` 恒等函数);`clang -o host main.c -L. -ljsid && ./host`;另试含 `1+2` 的 `js_add` 导出与 `--emit static` | `js_id` 窄带通过:C 宿主链接调用 `js_id(2.5)=2.5`;`js_add` 编译失败 `Unknown label: _js_add`(B4);`--emit static` 产出 .a 的 LC_SYMTAB nsyms=0,`nm` 空,链接失败(B3) |
| D `--lib` | `node cli.js main.js --lib ctest --lib-path .` | 编译产物无任何库引用,符号未注册;`this.libraries` 无读取者(B5) |

### 6.2 .jslib schema 对照:现状 vs 演进后(含 libz crc32 完整假想示例)

**现状 schema(v1)**(`index.js:1467-1477` 生成形态):

```js
// libz.jslib(v1:无类型信息,一切按 double)
export const __lib__ = { name: "z", version: "1.0", path: "/usr/lib/libz.dylib" };
export function crc32();
export function compressBound();
```

**演进后 schema(v2,设计决策)**:

```js
// libz.jslib(v2:类型化签名;buffer 展开为 (ptr, len) 两参数)
export const __lib__ = {
  name: "z", version: "1.0", path: "/usr/lib/libz.dylib", type: "shared",
  signatures: {
    crc32:         { params: ["u64", "buffer", "u32"], returns: "u64" },
    compressBound: { params: ["u64"], returns: "u64" },
  },
};
export function crc32(crc, buf, len);
export function compressBound(sourceLen);
```

**JS 侧完整假想示例(C1 落地后应可运行)**:

```js
// main.js — 调用 libz 计算 ArrayBuffer 内容的 crc32
import * as z from "./libz.jslib";

const buf = new ArrayBuffer(5);
const view = new Uint8Array(buf);
view.set([104, 101, 108, 108, 111]);          // "hello"

// u64 参数/返回值经 BigInt;buffer 封送取 (data_ptr@+16, byteLength)
const sum = z.crc32(0n, buf, buf.byteLength);  // → 0x3610a686n
console.log(sum.toString(16));                 // 期望输出 "3610a686"
```

```sh
# C1 验收形态(动态链接期声明):编译即绑定,加载期 dyld 解析
node cli.js main.js -o crcdemo && ./crcdemo
# C4 验收形态(运行期加载,不经 jslib):
#   import { dlopen } from "ffi";
#   const z = dlopen("/usr/lib/libz.dylib", { crc32: { params: ["u64","buffer","u32"], returns: "u64" } });
```

对照要点:v1 的全部参数/返回值按 f64 处理(等价今日行为,存量兼容);v2 的 `buffer` 是
(ptr,len) 语法糖,`cstring`/`ptr` 语义见 §3.5;签名表缺失、类型词未知、符号拼写不符均在
编译期响亮报错(B6 修复后的反静默立场)。

---

## 附:本文引用的实证锚点(便于复核)

- CLI 与库链路:`cli.js:163-168/283`;`compiler/index.js:330-336/624/1252-1253/1442/1467-1477/2516/2800-2829/2832-2839/298-303/2997-3021`;`compiler/output/generator.js:178/196/349`;`compiler/output/library.js:101-104`。
- 静态链接器:`binary/static_linker.js:102-177/662`。
- 动态层:`binary/macho_arm64.js:152-195/437-459`;`binary/macho_dylib.js:72/277`;
  `binary/elf_dynamic.js:174-494/267/188/638/905`;`binary/pe.js:51-64`;`binary/pe_dll.js:22/93`;
  `binary/dylib.js`(未使用);`asm/arm64.js:118-119/1332/1469-1494/1695`;`asm/x64.js:989`;
  `backend/x64.js:1285-1336`;`compiler/functions/functions.js:2270/2294/2309-2312`。
- 值与运行时:`runtime/core/jsvalue.js:20-63`;`runtime/types/string/index.js:14-19/400-421`;
  `runtime/types/typedarray/index.js:58-75`;`runtime/core/allocator.js:3311-3366/3398-3428`;
  `runtime/core/parallel_sched.js:52-54/779-815`;`compiler/output/wrapper.js:27-99`。
- 模块解析:`lang/parser/modules.js:20/34`。
- 实证产物:`.agent-work/c-interop-probe/`(2026-07-19,macOS arm64 真机)。
