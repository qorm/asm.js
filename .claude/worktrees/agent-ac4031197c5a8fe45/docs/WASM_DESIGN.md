# WebAssembly 目标设计（wasm32-wasi）

> 状态:**Milestone 1 已交付**——`node cli.js prog.js --target wasm32-wasi -o prog.wasm && node scripts/wasm_host.mjs prog.wasm`。
> 已实测通过:hello、算术/浮点、字符串方法、数组/对象/闭包、try-catch、生成器、Map/Set、JSON、spread、async/await+Promise(与 native 产物输出逐行一致,含 native 既有怪癖)、**GC 压力**(300×5000 串分配跨多轮回收、存活者正确)、Date.now。性能:GC 压力基准 wasm ≈ 4.5× native 用时(预估带宽 3-10× 内)。自举门与"自举产物编 wasm 逐字节一致"均绿。
> 铁律:全部改动**增量式**(新文件 + `arch === "wasm32"` 分支),不得扰动 5 个 native 目标的产物字节;每次提交后跑自举门 `node cli.js cli.js -o g1 && ./g1 cli.js -o g2 && ./g2 cli.js -o g3`(md5 三代一致)。
> 非目标:编译器自身自举到 wasm(远期);eval/new Function(L2 引擎库不适用 wasm)。

## 1. 架构调研结论(设计输入)

- **后端契约**:codegen 全部经 `vm.*`(vm/index.js)→ `backend/{arm64,x64}.js`(~90 个方法:mov/load/store/算术/位运算/cmp+jcc/prologue/epilogue/call/callIndirect/jmpIndirect/push/pop/syscall/浮点)→ 逐字节写入 `asm.code`。虚拟寄存器 A0-A5 / V0-V7 / S0-S5 / RET / FP / SP / LR;**RET 与 A0 在 arm64 上别名同一物理寄存器**(codegen 依赖此别名,x64 的 RET=V0=RAX 别名由 `backend.name === "x64"` 分支消化)。
- **代码形态**:运行时(runtime/ 手写生成器)与用户代码线性发射进同一 code buffer;函数=标签,`call(label)`/`callIndirect(reg)`;标签间**自由跳转/贯穿(fallthrough)/尾跳**,无结构化控制流;函数指针 = `lea(funcLabel)` 得到的**代码地址存进闭包对象**([S0+8])。hello-world 即携带全量运行时:实测 2477 个标签、~105KB 代码、~26k 条指令。
- **GC**:保守式,根 = 栈区间 `[当前SP, _stack_base)` 逐字扫描 + 数据段 `[_data_start, _data_gc_end)`;S 寄存器值靠 prologue 压栈、跨 call 的 V 寄存器值靠 codegen 溢出到 FP 槽——**只要栈在可扫内存里,GC 机制原样成立**。
- **NaN-boxing**:高 16 位 ∈ [0x7ff8,0x7fff] 为 boxed,payload 48 位指针(数组 44 位);wasm32 地址 < 2³² 天然装得下。指针合法性靠 `vm.ptrFloor`(2 的幂,linux 2²²/macos 2³²,object/index.js 有 floorShift 假设)+ 若干**硬编码 `0x100200000`**(print.js×8 等)区分代码数据段与堆。
- **syscall 面**:vm.syscall(立即数号)/syscallReg;号来自 runtime 内 per-os/arch 内联三元(write/exit/mmap/munmap/mprotect/gettimeofday/clock_gettime)+ runtime/node 的 `getSyscall(name)`(constants.js,运行期查 process.platform)。分配器 mmap 初始预留 28GB(MAP_NORESERVE),增长走 hint 连续扩;非连续则搬迁(已知脆弱)。

## 2. 结论:"单函数虚拟 CPU" 后端(而非逐函数 wasm function)

wasm 是结构化栈机:无任意跳转、无代码地址、无栈内省。把 asm.js 的每个"函数"映射为独立 wasm function(方案 B)会碰四堵墙:标签间贯穿/尾跳无法切函数边界、闭包里的代码地址需换成表索引并改 codegen、S 寄存器跨 call 存活值藏进 wasm locals 令保守 GC 失明、运行时手写汇编到处违反函数边界纪律。

**选定方案 A:整个程序编进一个 wasm 函数,内部用 pc-dispatch 模拟一颗虚拟 CPU。**

- **寄存器 → locals**:A0-A5/V0-V7/S0-S5/FP/SP/LR 各一个 i64 local(RET 复用 A0 的 local,保持 arm64 别名语义);D0-D7 → 8 个 f64 locals;cmp/fcmp 把两操作数存进旗标 locals(fA/fB:i64,dA/dB:f64),jcc 现算关系——比硬件旗标更稳(跨标签仍有效)。单函数内 locals 即"全局寄存器堆",call 是内部跳转,寄存器天然跨调用存活——与真 CPU 同构。
- **控制流**:函数体 = `loop { block×N { br_table(pc) } seg₀ … seg_{N-1} } unreachable`。每个 `vm.label()` 按**定义顺序**分配 pc 序号 i,br_table 第 i 项 depth=i 落到 segᵢ 起点;贯穿=顺序执行。`jmp L` = `pc←idx(L); br <到loop深度>`;条件跳 = `if { pc←…; br depth+1 }`。深度依赖所在 segment,发射期以 5 字节 padded-LEB 占位、finalize 统一回填(与 native fixup 同风格);前向标签的 pc 立即数同法回填。**已实测**:node/V8 对 60,000 层嵌套 block + 60,000 目标 br_table 正常验证执行(hello 规模 2.5k 的 24 倍;V8 br_table 上限 65,520,超限时换两级派发,M3 再说)。
- **call/ret**:`call L` = `LR←retIdx; pc←idx(L); br`,紧随其后定义返回标签;`ret` = `pc←wrap(LR); br`。prologue/epilogue 忠实模拟 arm64(SP-=16 存 FP/LR、成对压 S 寄存器、FP=SP),全部写进线性内存影子栈 → **返回地址、S 寄存器、溢出槽全部落在可扫内存,保守 GC 零改动成立**。
- **代码地址 = CODE_BASE + 标签序号**(CODE_BASE=0x400000):`lea(代码标签)` 物化该值,闭包/间接调用原样工作(`callIndirect`/`jmpIndirect` = `pc←wrap(reg)-CODE_BASE; br`);≥ ptrFloor(wasi 取 0x400000,与 linux 同为 2²²,floorShift 假设不破)。GC 把它当非堆值正确忽略(不落 [heap_base,heap_ptr))。
- **线性内存布局**(binary/wasm.js 定死,入口代码与宿主 shim 共享):
  - `[0, 64K)` 空置(null 守卫);
  - `[64K, 0x1000000)` 影子栈(向下生长,栈顶 `WASM_STACK_TOP=0x1000000`=数据段基址正下方即 `_stack_base` 初值;入口先 `SP←0x1000000`)。**≈16MB**——初始 memory 已覆盖到数据段尾,该整段恒为已提交实存;栈与下方代码序号窗口共址无害(见下)。历史上栈顶=0x400000 只给 4MB,递归 ~600 帧即 OOB trap 而 native 能到 ~1200,故上抬占满至数据段基址,深度 ~2400 追平并超过 native。
  - `[0x400000, 0x1000000)` 代码序号地址空间(纯逻辑值,不占内存);**其实存现充作影子栈**:代码地址(`CODE_BASE+序号`)只作 `pc` 立即数被 `callIndirect`/`jmpIndirect` 消费(`pc←reg-CODE_BASE`),从不作内存地址解引用;栈地址永不被装箱/GC 当指针(堆对象 `≥WASM_HEAP_FLOOR=0x8000000`);两者不做范围比较——故代码地址的数值窗口与栈内存共址安全。
  - `[0x1000000, …)` 数据段(dataVAddr=0x1000000,asm.fixupAll 原机制回填绝对地址);
  - `[0x8000000, …)` 堆 arena(mmap shim 从此处 bump;print.js 等硬编码 `0x100200000` 的"代码数据段上界"在 wasi 分支改用 0x8000000)。
- **浮点语义**:`fcvtzs` 用 `i64.trunc_sat_f64_s`(饱和、NaN→0,与 arm64 fcvtzs 完全一致,避免 wasm 默认 trunc 陷阱);fmod 按 arm64 合成(a−trunc(a/b)·b);jflt/jfle/jfgt/jfge→f64.lt/le/gt/ge(unordered 不取,与 blo/bls/bgt/bge 语义逐条核对一致);jnan = fA≠fA ∨ fB≠fB;jne 在 fcmp 后 unordered 取真(f64.ne 的 IEEE 语义天然一致)。单精度对 fmovTo*Single/fcvtd2s/fcvts2d 按组合语义实现(demote/promote/reinterpret)。i64.div_s 除零 trap(x64 idiv 同样 trap,codegen 已有守卫)。
- **syscall → 宿主 import**:`env.__syscall(num:i64, a0..a5:i64) → i64`,返回负 errno(linux 惯例,syscallNegErrno 无需翻译)。**号名空间统一取 linux-x64**(write=1/exit=60/mmap=9/mprotect=10/munmap=11/…),runtime 各 per-os 三元处加 `wasi` 分支;shim 对未知号**响亮报错**(带号与参数),逐个补齐——这是收敛 runtime ~90 处 os/arch 分支泄漏的工作法。mmap shim:arena bump + 按需 `memory.grow`,hint==arena 尾时原地扩(保住分配器的连续增长快路);munmap/mprotect no-op。堆常量 wasi 特化(28GB 预留 → 1GB 级,4GB 线性内存封顶)。
- **模块 writer(binary/wasm.js,零依赖手写)**:sections = type / import(env.__syscall) / function / memory(initial=data 尾页数,max=65536)/ export(memory + `_start`)/ code(单函数体:locals 声明 + 派发骨架 + 各 segment 拼接,标签处插 `end`)/ data(主动段 @0x1000000)。与 ELF/PE writer 同量级(~300 行)。
- **宿主/验证**:node `WebAssembly.instantiate` + `scripts/wasm_host.mjs`(实现 __syscall:write/exit/mmap/…);wasmtime/wabt 系统上不存在,node 即主验证器。M2 可加薄 WASI adapter(fd_write/proc_exit)以兼容 wasmtime。

**代价(诚实账)**:单函数模型牺牲 wasm 原生调用栈与引擎可优化性——每次跳转/调用多一轮 br_table 派发,预估比 native 慢 3-10×;V8 对超大单函数只走 Liftoff/TurboFan 单元,大程序编译慢。这是 v1 的正确取舍:先全语义正确跑通,M3 若需性能再做"分段成多 wasm function + 尾派发 trampoline"或逐函数化(届时闭包代码地址→表索引的迁移已有 CODE_BASE 序号做垫)。

## 3. 集成点清单(全部增量)

| 文件 | 改动 |
|---|---|
| `compiler/core/platform.js` | TARGETS 增 `wasm32-wasi`(os:"wasi", arch:"wasm32", ext:".wasm") |
| `compiler/index.js` | Targets 表同步;`_initAssembler` wasm 分支;构造器跳过 dylib 注册;`generateEntry` wasi 分支(SP/argc/argv/退出);`generateExecutable` → wasm writer |
| `vm/index.js` | `_createBackend` wasm 分支;`ptrFloor` wasi=0x400000n |
| `backend/wasm32.js` **新** | WasmBackend:后端契约全量 → wasm 字节码 |
| `asm/wasm32.js` **新** | Wasm32Assembler:code/labels/fixups/data 契约(addString/addDataLabel/addDataQword/addFloat64/finalize/fixupAll)+ LEB/操作码发射 |
| `binary/wasm.js` **新** | 模块 writer + 布局常量 |
| `compiler/output/generator.js` | `generateExecutable` wasi 分支 |
| `runtime/core/allocator.js` | Syscall 表加 wasi 行(linux-x64 号);wasi 堆常量;getMmapFlags |
| `runtime/core/print.js` 等 syscall 内联点 | `emitWriteCall`/exit/date 等三元加 wasi 分支;`0x100200000` → os 常量 |
| `scripts/wasm_host.mjs` **新** | node 宿主 shim(__syscall 实现 + 运行入口) |

新增源码会进自举闭包(vm/index.js import),须用 asm.js 可编译子集书写,且注意源码增量的定点振荡风险(见 layout-position 备忘)——每提交跑门。

## 3.5 M1 实施纪要(踩坑存档)

- **i64.const 的 sleb 编码是 gen1 语义雷区**:自举运行时 BigInt 是 64 位补码位型——无符号大数比较(`0xffff…n > 0x7fff…n` 判假)、产生负数的减法、与计算负数的 `===` 均不可靠。首版 `_wrapS64`(比较+减法)在 node 下正确、在自举产物下发出非法 varint("extra bits")。终版:32 位整数走纯 number sleb;其余**定长 10 字节 sleb64**,按"位型逐 7 位提取 + 每步显式符号回填"实现,只用 `&`/`>>`/`|`/小字面量 `===`,两运行时逐位一致(asm/wasm32.js `sleb`/`patchSleb64`)。验证法:node 产物与自举产物 cmp 逐字节。
- **浮点寄存器号的字符串怪癖**:runtime 少数站点(math.js 等)把 `VReg.V0` 字符串当 fp 寄存器号传;arm64 asm 按 `| fd` 位或把它折到 0(=D0),行为已被依赖。wasm 后端 `_gd/_sd` 以 `fpReg | 0` 保持同一语义。
- 首个非法 varint 即 mmap 的 `fd = 0xffffffffffffffffn`(runtime 有意用全 1 正字面量表示 -1,规避 `-1n` 一元负号 bug)——wasm 后端必须把它按位型落成 i64 的 -1。

## 4. 里程碑

- **M1(已交付)**:`node cli.js hello.js --target wasm32-wasi -o hello.wasm && node scripts/wasm_host.mjs hello.wasm` 输出 `hello`。范围:上表全部管道 + __syscall(write/exit/mmap 族/gettimeofday);argv 置空(仿 windows 入口路径);GC 真跑(压力测试通过)。宿主 shim 双号名空间(linux-x64 canonical + macos-x64 别名容错网),未知号带上下文响亮报错。
- **M2(已交付)**:
  - **argv/env 注入**:宿主 shim 在 `_start` 前按 POSIX 初始栈形状写递交区(`WASM_ARGV_BASE=0x10000`,binary/wasm.js):`[+0]=argc`,`[+16]=argv 指针数组 + NULL + envp 指针数组 + NULL + 串字节`——既有 `_process_env_init` 的 `envp = argv+(argc+1)*8` 约定天然满足,`process.argv`/`process.env` 全通。预算 0x30000,超出砍 env 保 argv;串在 `_process_init` 即被复制进堆,深栈覆写无碍。
  - **process.platform/arch**:wasi 产物为 `"wasi"`/`"wasm32"`(`_str_wasi`/`_str_wasm32` 仅 wasi 目标注入,native 数据段不变)。
  - **constants.js wasi 行**:`getSyscall` 增 wasi 平台块(= linux-x64 canonical:exit 60/write 1/read 0/close 3/open 2/chmod 90/unlink 87/mkdir 83/rmdir 84/getrandom 318);进程类(fork/execve/…)返 -1 走消费方降级。crypto `_entropyBytes` 的 wasi 分支走 getrandom。
  - **宿主 shim fs/random**:open/openat(仅 AT_FDCWD 语义)/read/close/unlink/chmod/mkdir/rmdir 直落 node fs(linux O_* 位 → fs.constants 翻译、常见 errno 粗映射);getrandom → crypto.randomFillSync;write 走真实 fd(>2 落文件);macos 别名网扩到 fs 族。fs.read/writeFileSync、existsSync、unlinkSync、crypto.randomUUID/randomBytes 实测全通。
  - **V8 tier-up 灾难与对策**:巨函数触发 Turboshaft 后台优化的 per-block 变量快照合并(派发 loop 头数千前驱)→ Zone OOM **崩宿主进程**——程序在 Liftoff 下早已正确跑完,崩在后台线程。宿主 shim 以 `--no-wasm-tier-up --no-wasm-dynamic-tiering` 自我重启一次(V8 启动即冻结旗标,`v8.setFlagsFromString` 无效;两个旗标都要,只关前者不够)。Liftoff-only 实测反快(GC 压力基准 53s→45s,省 tier-up 抖动)。风险 #2 的实体化;M3 分段多函数是根治。
  - **typedarray `_typed_array_set` 上界**:wasi 分支以真实 `_heap_ptr` 为上界(照抄硬编码常量会令 unbox 窗口恒空)。**native 侧核验记录**:窗口 `[heap_base, 0x100200000)` 因 heap_base 实测高于常量而疑似恒空 → boxed-Number unbox 分支在 native 等效死代码(被规范浮点快路掩蔽未显症);未动 native 发射语义,留产品侧定夺。
  - **Object.prototype.toString(Date) trap**:`_opts` 派发对 Date 先做 `[Symbol.toStringTag]` 探测,`_object_get` 把 Date 的 `[timestamp@8]` 当属性 count 走垃圾 props——native 上被各处指针守卫吸收未显症,wasm 线性内存边界更严 → OOB trap。wasi 分支在探测前短路 Date 品牌(native 发射不变)。顺带发现(非 wasm,native 同样复现,归引擎白名单):`const t = Object.prototype.toString; t.call(x)` 提取式调用在全平台 exit 1,直呼形式正常。
  - **Object.prototype.toString(TypedArray/ArrayBuffer/DataView) — 同族短路(R2)**:与 Date 同因(非属性堆对象走 `_object_get` 探测)。native 上直接 **SEGV(exit 139)**,wasm 上 TypedArray/ArrayBuffer 误报 `[object Object]`、DataView 直接 OOB trap。wasi 分支在 Date 短路后按类型字节续接:TypedArray `0x40-0x61`(Int8/16/32、BigInt64、Uint8/16/32、BigUint64、Uint8Clamped、Float32/64)、ArrayBuffer `12`、DataView `14`、Promise `11` → 各自规范品牌串(`[object Int32Array]`/`[object Promise]` 等,与 V8 一致)。**BigInt/Symbol 是裸堆指针**(BigInt 类型字节在 `[ptr-16]`、`[ptr+0]` 是 64 位值;Symbol 在用户区),绝不能按 `[S1+0]` 判——否则 `66n` 的值低字节 `0x42` 会被误当 `Int32Array`;故在类型字节判之前先调既有 `_is_bigint`/`_is_symbol`(与 `typeof`/算术同源、可靠)精确短路到 `[object BigInt]`/`[object Symbol]`,BigInt 原本更是直接 OOB trap。跳转与新 `ret` 标签**全部 `vm.platform==="wasi"` 守卫**,native macos-arm64 发射语义不变(自举门 g1==g2==g3 仍单步定点)。native 侧的 SEGV 是引擎前端/运行时既有 bug(`_opts` 非 wasi 路径未加这些守卫),归 Agent ES,本改动未触碰。未覆盖(仍 `[object Object]`/近似):Generator 对象是协程实现、类型字节非 `9`(与 async 协程共用 `10`,贸然判会误伤)故留 `[object Object]`;WeakMap/WeakSet 与 Map/Set 共用类型字节 `4`/`5` 无法区分;`GeneratorFunction`/`AsyncFunction` 走高位 tag 的 `_opts_func`(报 `[object Function]`)。fixture `es/wasm-typedarray-tostring-tag`:native `run:false`(编译即过,规避 SEGV),wasm 经新增 `expectWasm` 覆盖断言全部品牌串。
  - **fixture harness**:`tests/run_fixtures.mjs` 支持 `ASMJS_FIXTURE_WASM=1`(编 wasm32-wasi、经宿主 shim 运行、产物路径与 native 模式隔离);cli.js 增 `asm.js run --wasm <file.js>`(一步编译+运行)。**R2 增** `expectWasm` 字段:wasm 模式下若 fixture 声明之则整体覆盖 `expect`(native 恒忽略),用于 native 崩溃/不适用但 wasm 语义正确的用例(附加纯增、既有 fixture 零影响)。
  - **fixture 通过率**:wasm **277/283**,native 281/283(同一提交)。差集 6:cjs require-cycle ×2(native 同败,既有引擎 bug);os-platform ×2(期望 "darwin",wasi 如实报 "wasi"/"wasm32"——按设计);child-process ×1(wasm 无进程,按设计降级);另 crypto-hash/timers 在满套压力下偶发超时(单独跑恒过,记为 flake)。
  - M2 后仍留:readdirSync/statSync 是 runtime 全平台 stub(非 wasi 特有);堆 1GB 无增长(超出走已知脆弱的重定位路径,_heap_grow hint 连续性在 GC 结构 mmap 后必失配);fork/execve 类不支持(降级);WASI-proper adapter(wasmtime)未做。
- **M3(已交付:分段虚拟 CPU)**:巨函数按标签均匀切成 K 段(缺省每段 256 标签),每段一个 wasm 函数、内嵌自己的派发 loop;寄存器堆从 locals 迁到**模块级 mutable globals**(跨段存活);蹦床(导出 `_start`)按 `pc / segSize` 常数除法路由段函数。
  - **为什么不是逐函数化(方案 a)**:`_throw_unwind`(异常跨函数恢复 SP/FP/S 后 `jmpIndirect` 到 catchPC)与协程运行时(generator/async 换栈跳 pc)都是**非局部控制转移**——真 wasm 调用栈无法跳进另一个挂起函数体内(无 setjmp/栈切换)。分段模型下这些仍是 pc 赋值,天然成立;逐函数化被这两者架构性阻断(除非 asyncify 级重写)。
  - **发射不变式**:跳转/调用发射形状不变(置 pc global + br 段内派发);目标不在本段 → 段内 br_table default 返蹦床再路由;段边界任意落在标签处,贯穿由 writer 合成的段尾 `pc←next; return` 续接;br 深度回填改为段内局部(fixupAll 按 labelIdx 与 segSize 折算)。
  - **GC 不变式**:寄存器在 globals,但根扫描契约与 native 全等——S 寄存器由被调方 prologue 压影子栈、跨 call caller-saved 由 codegen 溢出 FP 槽,GC 只看线性内存。异常/协程/生成器/GC 压力全部实测通过。
  - **tier-up 解禁**:段函数 ≤ ~60KB、br_table ≤ 256 目标,Turboshaft 稳定,Zone-OOM 消失 → 宿主 shim 缺省放行 V8 分层(`ASMJS_WASM_LIFTOFF=1` 可诊断性钉回 Liftoff-only)。
  - **段大小扫描**(fib(27)/20M-loop,tiering on,ms):128→109/335,**256→97/269**,384→123/387,512→143/317,1024→325/816(大段撞 Turbofan 优化崖)。缺省定 256(ASMJS_WASM_SEG 仅 node 驱动实验用)。
  - **实测收益(缺省对缺省:M1 巨函数+Liftoff-only → M3 分段256+tiering)**:fib(27) 130→97ms(1.34×),20M 取模循环 562→269ms(2.09×),GC 压力基准 45→35s(1.29×)。对 native 差距收至:fib 6.5×、loop 4.5×、GC 基准 3.0×。注:分段+Liftoff-only 反而比巨函数+Liftoff-only 慢(globals 逐 op 税无优化器兜底,GC 基准 91s)——分段的价值在解禁 tier-up,两者是一揽子。
  - **fixture:wasm 278/283**(高于 M2 的 277 底线;余 5 = cjs×2 native 同败 + platform×2/child-process×1 按设计),native 281/283 不变。自举产物编 wasm 逐字节一致。
  - 后续可选:~~段内寄存器 local 缓存(段入口装载/出口冲刷,收益待估)~~(**R6 实测否决,见下**)、按代码体积切分、浏览器宿主。
- **R3(toString-tag 续补 + 覆盖面加固)**:
  - **Generator/AsyncGenerator 对象品牌(已修)**:R2 遗留的两类协程对象。Generator/AsyncGenerator 对象由 `_generator_new`/`_async_generator_new` 建成**普通对象**(`_object_new`,TYPE_OBJECT=2),无独立类型字节(协程本体才是 TYPE_COROUTINE=10,与 async 协程共用,故 R2 判"贸然按类型字节会误伤"是对的——但对象壳另有可靠判别式)。二者恒携内部槽 `obj["__gen_coro"] = coro`;该槽是**可靠判别式**(用户对象几乎不会自造同名槽,与 `__isRegExp` 探测同法)。wasi 分支在 TypedArray 类型字节短路后续接:先 `cmpImm(V0,2)` 仅普通对象进探测(避免对 Map/Set 等浪费 `_object_has`),命中 `__gen_coro` 即生成器,再按是否含 `Symbol.asyncIterator`(仅 async 生成器置)区分 → `[object Generator]`/`[object AsyncGenerator]`(与 V8 一致)。`_object_has` 取 boxed A0、内部脱壳、只用 S0-S3(跨调用保 S0),生成器对象是常规带属性对象,探测安全无 OOB。**全部 `vm.platform==="wasi"` 守卫**:实测 clean vs changed 编译器发射的 native 程序逐字节一致(`_object_proto_toString` native 发射序不变),g1 因编译器自身源码增长而变、但 **g2==g3 单步定点**(`05458a0a…`)。native 上仍报 `[object Object]`(不崩,因生成器对象是真属性对象,`_object_get` 走真 props 无垃圾游走)——归 Agent ES(需 native 侧同加探测或 Symbol.toStringTag 原型)。fixture `es/wasm-generator-tostring-tag`:native `run:false`,wasm `expectWasm` 断言两品牌 + 两负例(普通对象 / 自造 `Symbol.asyncIterator` 非生成器 → 仍 `[object Object]`,证判别式不误伤)。
  - **仍需 native 类型字节改动(归 Agent ES,wasm 侧无可靠判别式)**:① **WeakMap/WeakSet** 在 `compiler/expressions.js` 路由到 `_map_new`/`_set_new`,产物与 Map/Set **逐字节同构**(类型字节 4/5,无 weakness 标志位)——运行期无任何判别式,wasm 报 `[object Map]`/`[object Set]`。修法必须在共享 native 发射侧给对象头加区分位(如高位 flag 或专属类型字节),属 native 发射改动,不在 wasm lane。② **GeneratorFunction/AsyncFunction/AsyncGeneratorFunction**:函数值是闭包 `[magic, func_ptr, …]`,闭包头**不携带"我是生成器/async 函数"元数据**,运行期 `_opts_func`(tag 0x7fff)无从区分 → 均报 `[object Function]`。修法须在 native 侧闭包头加函数种类标志(编译期已知 `isAsync`/`isGenerator`),同属共享发射改动,归 ES lane。
  - **后端覆盖面加固(Target 2)**:Proxy/Reflect、Date 算术、复杂正则(捕获组/全局替换/split/大小写不敏感)、深递归(fib(25)/sum(1000))、TypedArray 数值(Float64/Int32.reduce/Uint8)、错误处理(throw/catch/instanceof)、tagged template(+String.raw)、getter/setter(含 class 私有字段)—— **8 组程序 native-asm.js 与 wasm-asm.js 输出逐条一致(零后端分歧)**。个别 native 与 node 的差异(如 `null.x` 不抛可捕获 TypeError)是**两后端共有**的运行时既有限制,非 wasm 分歧,归 ES lane。
  - **平台名 fixture 收口(Target 3)**:R2 遗留的 `node/builtin-os-platform`、`node/dynamic-import-node-scheme-os` 在 wasm 下期望 `darwin`/`arm64` 而如实报 `wasi`/`wasm32`——`process.platform`/`arch` 是**编译期烘焙进数据段的常量**(`_str_wasi`/`_str_wasm32`),宿主 shim 无从改(非 syscall 查询),故 wasm 侧无 bug、按设计正确。两 fixture 各加 `expectWasm` 断言其诚实输出(native `expect` 不变、恒忽略 `expectWasm`)→ wasm 套 317→**319/325** 通过。余 6 = eval×2(L2 引擎不适用 wasm,按设计)+ child-process×2(无进程,按设计降级)+ cjs require-cycle×2(**native 同败**,既有引擎 bug,非 wasm)。满套偶发单例超时(如 math-clz32-fround、crypto/timers)单独跑恒过,记为 flake。native 套 **323/325**(仅 cjs×2),自举门 g2==g3 单步定点。
- **R4(差分扫荡 + 条件跳 br_if 瘦身)**:
  - **大差分电池 vs native-asm.js(Target 1)**:~60 段程序覆盖 async/await+Promise 链(all/race/微任务序)、生成器+`yield*`+return/throw、Map/Set/WeakMap 迭代与对象键删除、深层 JSON 往返、TypedArray/DataView 读写与共享视图、复杂正则(捕获/全局替换/split/sticky/反向引用)、BigInt 算术(asIntN/幂/位)、类继承+super+私有字段、带标签循环、try/finally 嵌套、tagged template+String.raw、闭包/柯里化、字符串/数组方法、大字符串/大数组/深递归/GC 压力、位运算、浮点精度、Symbol/迭代协议、解构、数字格式化、Proxy/Reflect、getter/setter。**wasm 输出与 native 逐条一致,零后端分歧**。少数"分歧"均**两后端共有**(非 wasm bug):`DataView.setBigInt64/getBigInt64`(native SEGV 139 / wasm OOB trap 134,DataView BigInt 运行时缺口,归 ES lane)、`BigInt64Array` 字面量(两后端 `Cannot mix BigInt` 编译错)、`statSync.size`/`readdirSync`(全平台 runtime stub,恒返 0/[])、`process.platform/arch`(编译期烘焙常量,wasm 如实 `wasi`/`wasm32`,按设计)。
  - **条件跳 `br_if` 瘦身(Target 2)**:所有条件跳原发射 `<cmp>; if void { i32.const pc; global.set 0; br depth } end`——`if`/`end` 包裹每条件跳多耗 3 字节(`0x04 0x40 … 0x0b`)。因 **pc global 只在派发 loop 头(br_table)被读**,且每条到派发的 `br`/`br_if` 之前都显式写 pc,故把 pc **无条件先置目标序号**、再 `br_if` 到派发——"未取"分支残留的 pc 目标值在下一次派发前必被覆写、永不被观测,语义等价。省去 `if`/`end`(每条件跳 −3 字节),且 `br_if` 比 `if+br` 更利于 Liftoff。改点仅 `backend/wasm32.js`(`_jcc`/`jnan` 先 `_setPc` 再 `_condBrIf`;`_condJump`→`_condBrIf`),`extra` 由 1(if 内)降为 0(段体顶层,同 `_jump`)。实测 hello.wasm **340490→333994 字节(−6496,−1.9%)**;branch-heavy 冒烟(if/else-if 链+while+带标签循环)与 native 逐字节一致;cli.js 自身编 wasm 两次逐字节一致(确定性)。
  - **fixture**:新增 `es/wasm-branch-density`(密集 signed/float/NaN 比较 + 带标签 break/continue + 紧数值循环,守卫 `set pc; <cmp>; br_if` 下降路径),native+wasm 输出一致、双模式过。native 套 **333/335**(仅 cjs×2),wasm 稳定 **327**(8 项按设计:eval×3 L2 不适用 + child-process×2 无进程 + net-tcp×1 需真 socket syscall + cjs×2 native 同败;满套另有 1 项轮换超时 flake,单独跑恒过)。自举门 g1 无 segfault、**g2==g3 逐字节一致**(`47eeac76…`)。
  - **net-tcp-loopback 现状记录**:native 用原生 socket/bind/listen/accept syscall 完成单进程环回,wasm 下 `socket` 号在 wasi 分支解析为 -1(runtime os 分支未定义)→ 宿主响亮报错。补齐需在异步-only 的 node 宿主实现**同步** socket/accept/recv(node 无同步 socket API),属大工程,留 M4。
- **R5(访存偏移折入 memarg + 尺寸续瘦)**:
  - **load/store 偏移折入 memarg 立即数(Target 1)**:原 `_addr(base, offset)` 恒发射 `global.get base; i64.const offset; i64.add; i32.wrap_i64`,访存指令 memarg 偏移恒 0(`0x03 0x00`)。wasm 访存指令自带 `offset` 立即数(uleb u32,effective addr = i32地址 + offset)。**非负偏移(结构字段/数组元素/prologue 正槽,占绝大多数)改折入 memarg**:`global.get base; i32.wrap_i64; <load/store> align offset`,省去 `i64.const offset; i64.add`(约 −3 字节/访存)。正确性:`wrap(base)+offset ≡ wrap(base+offset)`(mod 2³²)对 offset≥0 且 base<2³²(真实线性地址)逐位成立;唯一差别是溢出 2³² 时 memarg trap 而旧路回绕,但合法访存(base 为堆/栈/数据真实地址、offset 为小字段偏移)永不溢出,行为一致。**负偏移(堆对象头 `obj-16`/`obj-8`,string/coercion/typeof 走)保留 i64.add 路径**(memarg 偏移无符号)。改点仅 `backend/wasm32.js`(`_addr` 返回应折偏移,`load`/`loadByte`/`store`/`storeByte`/`_storeZero`/`f2i` 以 `asm.uleb(mo)` 写 memarg)。实测 hello.wasm **336573→323089 字节(−13484,−4.0%)**;cli.js 编 wasm 44375111→44147247(−227864,大程序数据段主导故占比小);cli.js 编 wasm 两次逐字节一致(确定性)。
  - **fixture**:新增 `es/wasm-memarg-offsets`(多静态偏移的对象/数组/字符串/TypedArray 读写 + typeof/串接的堆头负偏移路径),native+wasm 逐字节一致、双模式过。native 套 **340/342**(仅 cjs×2),自举门 g1 无 segfault、**g2==g3 逐字节一致**(`ee4c80d1…`)。
  - **-1 常量走 number sleb(Target 2)**:`not`(`~`)与 `div` 的 -1 除数守卫原发射 `_i64c(0n - 1n)`——bigint 值恒走 `sleb` 的定长 10 字节路径(gen1 护栏:任何 bigint 都不做范围判、直接 padded)。改为 number 字面量 `-1` → 走 `sleb` number 路径压成 1 字节(`0x7f`,i64 值同为 -1)。负 number 字面量经该路径已被 `_addr` 的 `-8`/`-16` 偏移证实 gen1 安全(非 bigint 运算,无 §3.5 的补码比较雷)。改点仅 `backend/wasm32.js` 两处常量;每 `not`/`div` 站点省 9 字节。hello.wasm **323089→322765(−324)**;`~`/整数除法 native 与 wasm 输出逐条一致;自举门 **g2==g3**(`09071404…`)、wasm 套 331/342(+1 为新 fixture 双模式过,余 11 按设计不变)。
  - **br/br_if 深度立即数自适应窄占位(Target 3)**:opcode 字节直方图(hello,`total code≈314KB`)显示 `global.get/set` 各约 20%(2 字节/条,结构性不可压),而 `br`(6.3%)+`br_if`(4.1%)的深度立即数恒发 **5 字节 padded uleb**。但 br 深度 = 段内到派发 loop 的层数,恒 **≤ segSize-1+extra**——由编译期常量 `segSize`(缺省 256)封顶,与可达数十万的 pc 标签序号(须 5 字节)本质不同。故按 `segSize` 自适应取刚够的 uleb 宽度(`brPadBytes = ulebLen(segSize+2)`,缺省 → **2 字节**),替代恒 5 字节,每 br/br_if 省 3 字节(非最小 LEB 合法且 ≤ u32 上限,V8 接受)。改点仅 `asm/wasm32.js`(`emitPadN`/`patchUlebN`/`addBrDepthFixup`/fixupAll br 分支);`pc`/`a64` 占位不变。gen1 恒 segSize=256 → brPadBytes=2,确定性不变。实测 hello.wasm **322765→306438(−16327,−5.1%)**;cli.js 编 wasm 44147247→42192465(−1954782,−4.4%,大程序 br 深度全 ≤255 仍 2 字节正确)、两次逐字节一致;自举门 g1 无 segfault、**g2==g3 逐字节一致**(`9572318c…`)、wasm 套 331/342 不变。
  - **fixture**:新增 `es/wasm-br-depth`(150-case switch + 60-臂 else-if + 带标签嵌套循环,单函数内制造 >127 的 br 深度,强制走窄占位的完整 2 字节),native+wasm 逐字节一致、双模式过。
  - **a64 地址占位 10→5 字节(Target 4)**:`lea`(闭包/函数指针)与 `call`/`callIndirect` 的返回地址常量走 `addAbs64Fixup`,原发 **10 字节 padded sleb64**。但所有 a64 值 = 数据段地址(`dataVAddr+off` < 4GB 线性内存)或 `CODE_BASE+标签序号`(< 2³²),**恒 < 2³²**——由 wasm32 32 位地址空间硬不变式封顶。5 字节 sleb(35 位有符号)足容任意 < 2³⁴ 正值,故占位缩到 5 字节,每 a64 省 5 字节。改点仅 `asm/wasm32.js`(`patchSleb64`→泛化的 `patchSlebW`;`addAbs64Fixup` 用 `emitPad5`;fixupAll a64 分支 `patchSlebW(...,5)`)。实测 hello.wasm **306438→294153(−12285,−4.0%)**;cli.js 编 wasm 42192465→**37439805(−4752660,−11.3%**,闭包密集程序 a64 占比高)、两次逐字节一致;**wasm 宿主跑 cli.js.wasm 自编 helloworld → 产物与 native cli.js 逐字节一致**(全 cli.js 规模的 lea/call/间接调用端到端正确)。自举门 g1 无 segfault、**g2==g3**(`0dca0d23…`)、wasm 套 332/343 不变。fixture 新增 `es/wasm-code-address`(闭包函数指针 + 高阶派发 + 深/互递归返回地址 + 派发表)。
  - **R5 累计**:hello.wasm **336573→294153(−42420,−12.6%)**(四项:memarg 折叠 −4.0% + -1 常量 −0.1% + br 深度窄占位 −5.1% + a64 窄占位 −4.0%);cli.js 编 wasm 44375111→**37439805(−15.6%**)。`global.get/set` 占 ~40% 代码字节为结构性下限(每条 2 字节,locals 化亦 2 字节无增益),纯尺寸的低风险易得占位/常量项至此基本收敛;后续大幅下探需段内寄存器 local 缓存(perf 向,收益待估)或两遍发射窄化 pc 序号占位(风险较高)。round-4 结论仍成立:后端对 native 零正确性分歧;R5 为纯尺寸/编码收敛,未新增任何 wasm-only 语义。
- **R6(段内寄存器 local 缓存:实测否决 + 根因)**:
  - **动机**:round-5 结论 `global.get/set` 占 ~40% 代码字节为尺寸结构性下限,进一步下探须转 perf 向——把热虚拟寄存器缓存进 wasm locals(V8 对 locals 远比 memory-backed globals 易做寄存器分配)。M3 曾把此列为"后续可选"。
  - **实现(已验证正确、GC 安全,但回退未落地)**:镜像式全缓存——每个段函数声明 25×i64 + 10×f64 locals 镜像 globals 1..35(local idx = global idx − 1),**入口一次性 `global.get→local.set` 装载、出口一次性 `local.get→global.set` 冲刷**(两条出段路径——br_table default 跳 block_exit、末切片贯穿落出 loop——汇合于 `end block_exit` 之后,单份冲刷即覆盖);段内所有寄存器访问改发 `local.get/set`。**pc(global 0)不镜像**(派发 loop 的 br_table 读、跳转写,须留 global 供跨段路由)。正确性:locals 是 globals 的纯镜像,任何寄存器/旗标经跨段控制转移的数据流都被冲刷/装载保全,与全 globals 版逐语义等价(跨段转移必经段函数返回→蹦床→目标段入口,冲刷/装载成对)。**GC 安全**:保守 GC 只扫线性内存;跨 call 存活的堆指针由 codegen 溢出到影子栈/FP 槽的 `store` 完成,而 store 源现读 local(当前值)→ 溢出值正确,GC 契约不变;非移动式 mark-sweep,locals 内指针 GC 后仍有效。实测三基准输出逐字节正确(loop/fib/pure-loop 结果对)。
  - **实测:全面回归,决定不落地**(best-of-3 墙钟,含 ~60ms node 启动;缺省分层 = 出货配置):
    | 基准 | 缺省 baseline→cached | Liftoff-only baseline→cached |
    |---|---|---|
    | pure loop(i+1,50M) | 787→1150ms(**+46%**) | 1612→4310ms(**+167%**) |
    | loop(s+i%7,20M) | 357→467ms(**+31%**) | 712→1909ms(**+168%**) |
    | fib(30) | 422→487ms(**+15%**) | 1210→2178ms(**+80%**) |
    | strbuild(O(N²) 串接) | 12.4s → **2min 未完**(严重) | — |
    尺寸亦微涨(loop.wasm 296433→300977,+1.5%,来自每段装载/冲刷 + locals 声明)。**无一工作负载改善。**
  - **根因(为何此模型下寄存器缓存必亏)**:
    1. **寄存器堆 = CPU 状态,必须在每个段边界全量保全**。分段虚拟 CPU 里,跨段控制转移语义上只是一次"跳转",转移前后 25+10 个寄存器/旗标必须逐位一致。缓存进 per-段 locals 后,**每次出段须全量冲刷(35 store)、每次入段须全量装载(35 load)**——180 条额外 global 访存/次边界穿越。这不是可省的簿记,是 CPU 状态语义的硬要求。
    2. **段边界穿越是**逐迭代**高频**,而非罕见。算术/比较等 op 派发到的 runtime helper 散布在**别的段**(hello 规模程序 ~16 段;用户循环体调早段 helper),故即便"纯" `i+1` 循环也**每迭代跨段**。实测每迭代净增 ~55ns ≈ 180 条 global 访存的开销——与穿越频率线性吻合。
    3. **V8 段内已自会寄存器化热 globals**。TurboFan 对段函数内无别名的热 global 本就做寄存器分配,段内几无可省;新增的 45 个 locals 反增寄存器压力/循环头状态合并成本(Liftoff 无优化器兜底,故 +167% 最惨)。
  - **结论**:段内寄存器缓存**正确且 GC 忠实,但在分段派发模型下是决定性 perf 回归**,不落地(代码已回退,本条为存档否决)。真正的 perf 杠杆在**降低单次跨段派发成本或频率**(如尾调用直连段函数省蹦床往返、或按调用局部性排布函数使热 callee 与 caller 同段),而非寄存器缓存;二者均属较大结构改动(尾调用 `return_call_indirect` 有签名/边界检查开销、且现蹦床已用 br_table+**直接** call,收益待微基准先判;函数排布触 layout-position 定点振荡风险),留后续轮次评估。native 自举门 g1 无 segfault、**g2==g3=`e4e1106e…`**(本轮零 native 代码改动,恒等)。
- **R7(尾调用段路由:微基准实测否决 + 根因)**:
  - **动机**:R6 把跨段派发成本列为"真正的 perf 杠杆"、并把尾调用直连段函数(`return_call_indirect` 替蹦床往返)列为"收益待微基准先判"的候选。本轮先做**隔离微基准估算 payoff**(与 R6 寄存器缓存同法:先量再决),再定夺是否做大改。
  - **两派发模型对比(合成微基准,`scratchpad/microbench2.mjs`,不触编译器)**:忠实复刻分段虚拟 CPU 的段体结构(`block_exit{ loop{ block×n{ br_table(pc-first) } 切片 } }`),`segSize=1` 令**每次跳转都跨段**以隔离纯单次穿越成本;工作负载 = seg0 热循环每迭代派发到 helper 段再返回(2 穿越/迭代,仿紧算术循环调 runtime helper 段);段数 K∈{3,16,64,256} 扫描以检验大蹦床 br_table 是否偏袒 O(1) 的 `return_call_indirect`。**模型 A(现行蹦床)**:段 br_table default 返蹦床 → 蹦床 `pc/segSize` 二级 br_table → **直接** `call` 段函数。**模型 B(尾调用)**:段出口 `global.get pc; i32.div_u; return_call_indirect (table[seg])`,段间直接尾调用、无蹦床往返;加 table(id4)+element(id9)段、funcref 表 K 项。两模型输出经 JS 参考逐位核对一致(`s=1249999975000000`)。
  - **实测(node v24.14,best-of-6 墙钟,ratio=tramp/tail,>1 即尾调用更慢)**:

    | 段数 K | 缺省分层(出货配置)tramp/tail | Liftoff-only tramp/tail |
    |---|---|---|
    | 3   | 95.6/164.9ms = **0.580×** | 324.0/285.3ms = 1.136× |
    | 16  | 91.9/166.6ms = **0.552×** | 345.7/307.7ms = 1.123× |
    | 64  | 90.2/166.5ms = **0.542×** | 343.5/316.7ms = 1.085× |
    | 256 | 93.1/166.1ms = **0.560×** | 340.9/291.4ms = 1.170× |

    **缺省分层(= 出货配置,M3 已解禁 tiering、整体比 Liftoff-only 快 ~3×)下尾调用恒 0.54–0.58×,即慢 ~75–85%**,且与段数 K 无关(蹦床 br_table 是 O(1) 跳表、大 K 不劣化,故"大程序偏袒 O(1) 尾调用"的假说被证伪)。Liftoff-only 下尾调用反小胜 ~9–17%(免去 return-后-call 往返),但**出货不会为这点小胜牺牲 tiering 的 3× 大头**,故此小胜无实际价值。
  - **根因(为何尾调用在出货配置必亏)**:
    1. **TurboFan 把蹦床的 `br_table → 直接 call` 编成紧凑跳表 + 直接调用点**,可跨函数内联/优化到极致;`return_call_indirect` 是**经 funcref 表的间接调用**,带**运行期签名类型校验 + 表边界检查**,击穿这些优化且无法同样内联。二级派发在优化器下反而是优势而非负担。
    2. **现行穿越已极廉**:缺省分层下蹦床往返实测 ~0.9ns/穿越(50M×2 穿越 ≈ 90ms)——已逼近计算式 goto/间接分支的硬下限。真实代码每穿越夹带更多实活,穿越占比更小;R6 所谓"剩余 perf 杠杆"在出货配置下**其实已被 TurboFan 收敛掉**,余量甚微,尾调用只会把它做坏。
    3. 真实编译器 `segSize=256`,**绝大多数跳转在段内**(段内 br_table,零函数边界穿越);仅跨段跳转付蹦床成本。合成用 `segSize=1` 已是穿越成本的**上界**,真实占比更低——负面结论只会更强。(实测参照:真实 `20M %7 循环` wasm 出货配置 ~430ms/`fib(27)` ~130ms 墙钟含 ~60ms node 启动,与 M3 记录同量级,佐证穿越已非主导成本。)
  - **对候选 2(调用局部性函数排布/内联小 helper 段)的判定**:同属"降穿越频率"方向,但 AOT 无 profile 数据判热边、且重排标签发射会扰动确定性布局(触 `layout-position` 定点振荡备忘的雷),风险高、收益投机、且需 profiling 基建;M3 的 segSize 扫描(128/256/512/1024,256 最优、更大撞 Turbofan 优化崖)已把"穿越频率 vs 段编译成本"调到最优,此方向无易得增量。**不盲目原型**。
  - **结论**:尾调用段路由**正确、GC 忠实、可用**(node v24 确认支持 `return_call_indirect`),但在**出货的分层配置下是决定性 perf 回归**(−75~85%),不落地(仅合成微基准,零编译器代码改动)。与 R6 寄存器缓存否决同构:分段虚拟 CPU 的派发骨架在 TurboFan 下已高度优化,结构性"改进"多为负和。R5 的尺寸收敛 + R6/R7 的 perf 否决共同表明:**当前后端在正确性、尺寸、出货性能三维已基本收敛**,进一步下探需换模型(逐函数化受 §M3 的非局部控制转移架构性阻断)而非微调派发。native 自举门 g1 无 segfault、**g2==g3=g1=`db3c5741…`**(本轮零 native/后端代码改动,恒等);微基准脚本存档于 scratchpad,不入库。

工作量:M1 ≈ 新增 ~1200 行 + 触点改动 ~150 行;M2 ≈ +400 行。

## 5. Top 3 风险

1. **runtime os/arch 分支泄漏**(~90 处):wasi 下三元 else 落到 macos/x64 路径,发出错误 syscall 号或错误地址常量。缓解:shim 未知号即刻带上下文报错;`0x100200000` 族集中改经常量;M2 冒烟集扫尾。
2. **单函数规模与引擎极限**:V8 单函数体上限 ~7.65MB、br_table 65,520 目标;大用户程序(数万标签)编译慢。缓解:已实测 60k 标签可行;超限走两级派发;M1 规模(2.5k 标签,~350KB 体)裕量充足。
3. **分配器 wasm 化假设**:28GB 预留不可行、增长非连续即搬迁(已知脆弱)、4GB 封顶。缓解:wasi 堆常量特化(初始 1GB 级、OS 惰性提交)+ arena shim 保证 hint 连续;超 4GB 程序明确不支持(文档化)。

## 6. 验证协议

每次提交:① 自举门 g1==g2==g3(md5);② `node cli.js tests/…/hello.js --target wasm32-wasi` + 宿主 shim 运行核对输出;③ 既有 native 快速冒烟(examples/hello 级)。基线(改动前):g1=g2=g3 = `50023db08fbef11278789664d1ad228d`。
