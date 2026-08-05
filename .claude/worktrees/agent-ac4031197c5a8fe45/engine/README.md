# asm.js 引擎库(L2)—— 运行时编译执行引擎

**独立组件**,不入普通 AOT 二进制、不受 `gen2==gen3` 自举定点约束。为需要**运行时加载/编译任意 JS 代码**的能力(`eval`、`new Function`、运行时 specifier 的动态 `import(变量)`)提供支撑。

## 为什么独立

封闭世界 AOT 单二进制的前提是"编译期确定全部代码、无运行时编译"。`eval`/`new Function`/运行时 import 与此**根本冲突**——它们要在运行时把字符串变成可执行代码。因此引擎作为**独立库**:只有显式使用这些能力的程序才链接它,普通 AOT 程序零负担、自举链不受影响。

## 路线 B(用户选定):编译器常驻

引擎内嵌 **asm.js 编译器本身**(已 self-hosting,编译 JS→native)+ 运行时执行器。`eval(s)` 流程:
1. **parse + compile** `s` → 可重定位机器码(对象文件形态,引用外部 runtime 符号)。
2. **加载**:mmap 一段可执行内存,写入代码,应用重定位。
3. **链接**:把代码里的外部符号(`_js_add`/`_alloc`/GC/…)解析到**宿主进程已有的 runtime**——共享同一堆/GC/事件循环,eval 出的对象与宿主对象互通。
4. **执行**:`callIndirect` 跳入,取回结果(NaN-boxed JSValue)。

关键点:eval 代码**不自带 runtime 副本**,而是链接宿主的。这样 `eval("[1,2,3]").map(...)` 产生的数组就是宿主堆上的真数组。

## 已验证的地基(2026-07-12)

| 基元 | 现状 | 位置 |
|---|---|---|
| 自举编译器(JS→native) | ✅ 可编入库 | `compiler/` `cli.js` |
| 对象文件 + symbol/relocation/extern/undefinedSymbols | ✅ 完整 | `binary/macho_object.js` `elf_object.js` `coff_object.js` |
| 动态库(dylib/so/dll)产出 | ✅ 存在(runtime 需补全) | `binary/*_dylib.js` `pe_dll.js` `--shared` |
| 静态链接器 | ✅ | `binary/static_linker.js` |
| mmap 可执行内存(syscall) | ✅ 可用(堆已用) | `runtime/core/allocator.js`(197/222/9) |
| 间接调用 BLR Xn | ✅ | `backend/arm64.js:468 callIndirect` |

## 阶段规划

- **P0 执行器基元机制 ✅ 已验证(2026-07-12)**:`_engine_smoke_exec`(runtime/core/allocator.js)mmap RW → 写 `mov x0,#42; ret` → mprotect RX → `callIndirect` → 返回 42。`__engine_smoke()` JS 内建可调,实测返 42、gen2==gen3 保持、自举产物同样工作。**关键结论:macOS arm64 禁 RWX(mmap RWX 返 EACCES),但未签名二进制可 mmap RW+mprotect RX(W^X 翻转)执行——无需 MAP_JIT/entitlement/libc,纯 syscall;全新页无需 icache 刷新**(跨页/复用页需补 dc cvau/ic ivau)。这解了原设计标注的 macOS JIT 主坑,route B 机制成立。**下一步 P0.1**:把 smoke 泛化为 `_engine_exec(codeptr, len, ctx)` 接真实代码缓冲 + 移入引擎专属 runtime(勿常驻核心 runtime 膨胀普通二进制)。
- **P1 宿主符号导出 + bl 重定位 ✅ 算术子集已落地(2026-07-12)**:含运行时调用(`_number_coerce`/`_js_add` 等)的表达式 eval 端到端。机制:`compileFragment` 为每个唯一运行时符号加 **trampoline**(`ldr x16,#8`=0x58000050;`br x16`=0xD61F0200;8B addr_slot),把 `bl _sym` 改成 `bl trampoline`(同页在 ±128MB 范围内);运行时 `_engine_reloc_exec` 用 `_engine_symaddr(symId)`(lea 取宿主符号 post-ASLR 地址)填 addr_slot 再执行。`__engine_exec_reloc(fragArr, relocArr)` 驱动(reloc 每条 8B:slotOff+symId)。**实测**:`(2+3)*4`→20、`10*2-3`→17、`2.5*4`→10、`1+2+3+4`→10、`3*3+4*4`→25(全对齐 node),gen2==gen3 保持、自举产物同样工作。符号表:`_number_coerce`/`_js_add`/`_valueToStr`/`_strconcat`/`_object_get_ic`/`_subscript_get`/`_math_sqrt`(allocator generateEngineSymaddr ↔ engine/compile.js SYM_IDS 同步)。**局限/follow-up**:字符串字面量(不同 .data label,`"a"+"b"` 报"非 .data 引用")、`Math.sqrt`(别的 fixup 类型)等需补更多 fixup 类型/data 段处理。
- **P2 片段编译 + PIC 重定位 ✅ 常量子集已落地(2026-07-12)**:`engine/compile.js compileFragmentPIC(source)` = `parse → prologue + compileExpression + epilogue → 取 asm.code` 片段 + 并置 .data 常量到同页 + 改写 leaRipRel 的 ADD imm12(ADRP 保持 imm=0 取 PC 页基址)→ 位置无关可执行缓冲。`__engine_exec_raw(uint8array)` 执行返原始 JSValue。**实测端到端**:`40+2`→42、`100*5`→500、`10-7`→3、`3.14+1`→4.14、`2*3+4*5`→26、`100/8`→12.5(全对齐 node),gen2==gen3 保持。**关键:PIC 重定位极简**——leaRipRel 的 ADRP 已 imm=0(同页),只需把 ADD imm12 设为 .data 在缓冲内的页内偏移(<4096)。**局限**:仅纯常量表达式(单/多 .data 常量、无运行时调用);含 `bl _js_add`/`_number_coerce` 的表达式(如 `1+x`、`(2+3)*4` 的部分折叠)明确报"需 P1"。**下一步 P1**:宿主符号导出 + bl call 重定位,解锁任意表达式。
- **P3 共享堆/GC ✅(实质达成,落地于 P5/P6/P10)**:eval 代码分配走宿主堆;GC 扫描覆盖 eval 栈帧;保守扫兼容。(路径:P5 重定位 `_heap_base`/`_heap_ptr` 使 eval 与宿主共享同一堆指针 → P6 分配类 eval 经宿主符号在宿主堆 bump-alloc;P10 GC 注记确认片段分配触发 GC 时调用者原生帧作保守根被扫、copy-in 值在片段帧内亦被扫,无悬垂。)
- **P4 编译器常驻 ✅ 真运行时 eval 已通(2026-07-12)**:`engine/eval-runtime.js evalExpr(src)` = 运行时调 `compileFragment`(内嵌整个 asm.js 编译器,自举:编译器可编成 native)+ `new Uint8Array` + `__engine_exec_reloc`。**实测**:内嵌编译器的程序运行时 `evalExpr("40+2")`=42、`"100/8"`=12.5、`"7*6"`=42、`"3.14"`=3.14、`"255-13"`=242(全对齐 node),gen2==gen3 保持。**route B 完整管线打通:运行时编译字符串→重定位→进程内执行→取值。** 途中解的坑:(1) **icache flush**——编译器大量分配后 mmap 页 VA 复用,须 dc cvau/ic ivau 刷 I-cache 否则 SIGILL(执行零页 udf),已加 `_engine_iflush` + backend cache 指令;(2) **`new Uint8Array(变量数组)` bug**——原把变量当长度(compileTypedArrayNew 非字面量一律当长度)→ 空数组,已修 `_typed_array_from` 运行时判 array/number;(3) **for-of over Array.from 结果崩**——engine/compile.js 改索引循环规避(asm.js bug,follow-up)。**多常量 + 运行时调用表达式也已通(2026-07-12)**:`(2+3)*4`→20、`(7-2)*(3+1)`→20、`10*2-3`→17、`2*3+4*5`→26 运行时 eval 全对齐 node(含 `_number_coerce` 的 trampoline + 运行时符号重定位在内嵌编译器下打通)。**根因坑**:asm.js 自编译产物里 `obj[missKey]===undefined` 恒假(miss 返 0)、`hasOwnProperty` 返非规范布尔(打印 false 但 `!r`/`===false` 皆假)——compileFragment 的 `trampFor[symId]===undefined` 判存在被坑得不建 trampoline、bl 改写成 `bl 0` 崩;改用 **`key in obj`**(返规范布尔正确)判存在修好。**这俩是真 ES bug(follow-up)**:属性 miss-sentinel(nan-int0 家族)、hasOwnProperty 布尔。**字符串 eval ✅ 已通(2026-07-12)**:compileFragment 支持 `_str_N`(在 asm.strings 数组,非 asm.data)——内容 UTF-8+null 并置同页 + 改写 adrp/add。`"ab"+"cd"`→"abcd"、`"x"+"y"+"z"`→"xyz"、`"a"+"b"+"c"+"d"`→"abcd" 运行时 eval 全对齐 node。**这也证明分配类 eval 工作**(_strconcat 分配堆字符串)——先前误判的"P3 共享 GC 阻"作废:**真根因是 `Array.push(a,b,c,d)` 多参数在自编译产物只 push 第一个参数**(asm.js ES bug)→ relocsToBytes 产 `[80,3]` 而非 `[80,0,0,0,3,0,0,0]` → reloc 读错 → trampoline slot 没填 → `br 0` 崩。改逐字节单参 push 修好。(排除过程还证:mmap 页 ~0x1xxxxxxxx <2^48 无截断、过 _getStrContent floor;非 GC。)**剩余 follow-up**:P3 共享 GC(解锁分配类 eval:字符串/数组/对象);变量/作用域(捕获调用处栈槽);Math 表达式;语句 eval;typed-array-源 new Uint8Array;for-of/Array.from、obj[miss]、hasOwnProperty 三个 ES bug。(**后已解决**:共享堆→P5/P6、变量/作用域捕获→P10、Math 表达式→P5、语句 eval→P7;obj[miss] 返 undefined 而非 0 于 v1.5.13 修复。)

- **P5 表达式覆盖扩展 ✅(2026-07-15)**:eval 从"算术+字符串"扩到**比较 / 位运算 / 三元 / Math / 混合类型**——`compileFragment` 补三类重定位机制:
  1. **片段内局部分支**(ternary/逻辑/`_js_add` 快路的 `b`/`bcond`/`cbz`/`cbnz`,x64 `jmp`/`jcc`)。fixupAll 才解析,片段切片绕过它 → 按 `c.asm.labels` 的 label→offset 自行回填 PC 相对位移。**x64 坑**:`resolveLabel` 契约与 arm64 相反(x64 直接返数值 offset,arm64 返 label 名再 `labels.get`)——`labelCodeOff` 按架构分支;且 x64 `call` 与 `jmp` 共用 `rel32`,靠"label 非 SYM_IDS 且是本地已定义 label"辨别 call/分支。
  2. **常量单例内联**(`_js_true`/`_js_false`/`_js_null`/`_js_undefined`):位型恒定,直接在片段 .data 内联 8 字节同位型副本(返回值按位等价宿主单例),复用 .data 引用回填路径。比较结果(`5>3`→true)即经此。
  3. **宿主可变数据全局重定位**(`_heap_base`/`_heap_ptr`,共享堆):emitNumberCoerceFast 的堆装箱数值判别读堆指针范围,**不可内联快照**(宿主分配会改)。arm64 把 `adrp Xd,_heap_base; add Xd,…:lo12` 改写成 `ldr Xd,[pc+slot]; nop`,slot 由 `_engine_reloc_exec` 填宿主 `&_heap_base`(symaddr 的 lea),后续 `ldr Xd,[Xd]` 读宿主堆指针值——**这是 P3 共享堆的第一步:eval 与宿主共享同一堆指针**。

  符号表 SYM_IDS 扩到 24 项(位运算 `_js_band/bor/bxor/bshl/bshr/bushr`、`_to_boolean`、`_js_relcmp`、`_math_abs/floor/ceil/round/pow`、`_heap_base/ptr`、`_abstract_eq`、`_floatToString`),与 `generateEngineSymaddr` 严格同序。**arm64 实测**(内嵌编译器运行时 eval,全对齐 node,gen2==gen3 保持):`5>3`=true、`1<<4`=16、`-1>>>28`=15、`true?10:20`=10、`5>3?100:200`=100、`-5+2`=-3、`Math.sqrt(16)`=4、`Math.pow(2,10)`=1024、`(5>3)?Math.sqrt(64):0`=8、`10%3==1?"yes":"no"`="yes"、`"len"+(2+3)`="len5"。**x64**:比较/位运算/三元/字符串 `compileFragment` 已通(局部分支+单例内联双架构);**宿主数据重定位(heap)x64 待做**(`-5+2`/`Math.sqrt` 明确报 "x64 宿主数据重定位未支持(follow-up)"——需把 `lea r64,[rip+disp]` 改 `mov r64,[rip+slot]`,opcode 0x8D→0x8B + slot 运行时填)。**剩余 follow-up**:x64 heap 重定位;变量/作用域(捕获调用处栈槽);语句 eval;数组/对象字面量 eval(依赖更多分配类符号 + GC 扫 eval 帧)。

- **P6 分配类 eval ✅ 数组/字符串/typeof(2026-07-16)**:eval 扩到**数组字面量 / 数组方法 / 字符串方法 / typeof / length**——**关键:分配走宿主共享堆**(P5 已重定位 `_heap_base`/`_heap_ptr`,`_array_new_with_size`/`_object_new_sized` 作宿主符号被 trampoline 调,在宿主内 bump-alloc,返回的堆指针宿主可直接用)。符号表 SYM_IDS 扩到 49 项(分配 `_array_new_with_size`/`_array_set`/`_object_new_sized`/`_object_define`、`_js_length`/`_array_length`/`_js_unbox`、`_js_typeof`/`_typeof`、`_array_join`/`_array_to_string`、`_getStrContent`/`_to_int32` + 11 个常用字符串方法),与 `generateEngineSymaddr` 严格同序。**arm64 实测(运行时 eval,全对齐 node,gen2==gen3 保持)**:`[1,2,3].length`=3、`[1,2,3][2]`=3、`[5,10,15].join("-")`="5-10-15"、`"hello".toUpperCase()`="HELLO"、`"hello".slice(1,3)`="el"、`"a,b,c".split(",").length`=3、`"ab".repeat(3)`="ababab"、`"hello".indexOf("l")`=2、`typeof 42`="number"/`typeof "x"`="string"、`"hello world".slice(0,5).toUpperCase()`="HELLO"。**对象字面量属性读 ✅ 已修(2026-07-16)**:根因**双缺陷**。(1) **缺帧内局部栈**——`compileObjectExpression` 把对象指针存 `allocLocal` 槽(FP-56,低于 `CALLEE_SAVED_AREA=48`),而片段旧 prologue 为 `prologue(0,[])` → SP==FP，该槽落在 SP 之下 → 每次 `bl _object_define` 被 callee 自身栈帧覆盖 → 回读得垃圾对象指针 → 属性 miss / ≥3 属性时野指针崩。修:片段 prologue 预留真实帧(`FRAG_FRAME=1024`)且 epilogue 同额释放(**先前 `prologue(1024)` "破坏全部执行" 只因 epilogue 仍留 0，返回时 SP 失衡崩**——不是缺栈以外的问题)。(2) **IC 站点回填写 RX 页**——miss 修好后 `_object_get_ic` 命中，慢路 `store site`(members.js:436)把下标回填到片段页内站点槽，而该页已 mprotect RX(只读)→ **SIGBUS**。修:片段编译置 `c.engineNoIC=true`，`emitObjectGetIC` 改走无站点回填的 `_object_get`+`_maybe_getter`（`process.env` 在编译产物内恒空，故不能靠 `NO_IC` env，用编译器实例标志）；`_object_get`/`_maybe_getter` 加入 SYM_IDS(→51 项)与 `generateEngineSymaddr` 同序。**实测**:`({a:1}).a`=1、`({x:42}).x`=42、`({a:1,b:2,c:3}).c`=3、`({name:"jo"}).name`="jo"、`({a:{b:2}}).a`=[object Object]、`({v:1+2*3}).v`=7 全对齐 node，gen2==gen3 保持。普通 AOT 输出逐字节不变(engineNoIC 仅片段置位)。

- **P7 语句序列 + 局部 var/let/const 绑定 ✅(2026-07-16)**:`compileFragment` 从"单表达式"扩到**语句序列**(indirect-eval 风格,自足作用域,**不捕获外层调用者变量**——那是独立里程碑)。旧约束 `body.length===1 && ExpressionStatement` 放宽为逐句 `compileStatement`;`var`/`let`/`const` 绑定从同一 `FRAG_FRAME` 局部池 `allocLocal` 取槽(与对象/数组临时槽共池,故 P6 的预留帧天然组合);末句 ExpressionStatement 的值留 RET 即片段完成值(末句非表达式则返 undefined)。块级作用域/TDZ 由 `c.parse()` 已跑的 `renameBlockScopedBindings` 处理,下游按名解析天然一致。**实测(运行时 eval,全对齐 node,gen2==gen3 保持)**:`var x=5; x*2`=10、`let a=3; let b=4; a*a+b*b`=25、`var s=0; for(var i=0;i<5;i++) s+=i; s`=10、`1+1; 2+2; 3+3`=6、`const k=7; k+1`=8、`var n=1; while(n<100) n=n*2; n`=128、`let x=10; { let x=20; } x`=10(块级 shadow 正确)、`var arr=[10,20,30]; var s=0; for(...) s+=arr[i]; s`=60。**函数/箭头表达式(闭包)原为边界,已在 P8 解锁**(见下)。

- **P8.1 eval 表面普查 + 廉价补全 ✅(2026-07-16)**:系统对拍 node 扫 eval 表面,把**廉价缺口**批量补齐——绝大多数只是往 SYM_IDS + `generateEngineSymaddr` 追加**真运行时 label**(严格同序)。补:关系比较 `_js_lt/le/gt/ge`;Math `_math_trunc/cbrt/log/log2/log10/exp`(sin/cos/tan/atan2 编译器本身未接 → 运行时干净抛,非崩,不在此列);字符串 `_str_padStart/padEnd/at/charAt/startsWith/endsWith/replaceAll/lastIndexOf`;数组(无闭包)`_array_push/get/reverse/slice/includes/indexOf/at/flat`;解析/转换 `_js_parseInt/parseFloat/_str_to_num`(Number())、`_num_toString`(toString(radix))、`_num_toFixed`、`_is_bigint`、`_strcmp`(sort)、`_subscript_set`、`_instanceof`(Array.isArray)。**两处机制性补**:(1) **异常状态全局入 HOST_DATA**(`_exception_value`/`_exception_pending`)——含边界抛出检查路径的表达式(`split().join()`、`sort()`)内联 `adrp _exception_value`,按 `_heap_base` 同法重定位到宿主地址(与 eval 共享异常状态);(2) **命名运行时字符串常量内联**——`_str_comma_only`(join 默认分隔符)、`_str_length_prop` 等由内建方法 `lea _str_<名>` 引用,但片段不跑 `generateRuntime` → 从未驻留,旧 `_str_N` 处理 `parseInt(名)=NaN→空串`(`[1,2,3].join()` 分隔符变 "" → "123" 错值)。修:按 `RUNTIME_STRINGS` 已知值内联,`_str_N` 数字路径加**纯数字后缀**判别(§1.6 无正则,逐字符查)。**新增对拍通过**(节选,全对齐 node):`'a'<'b'`=true、`Math.hypot(3,4)`=5、`Math.trunc/cbrt/log2`、`'ab'.padStart(4,'x')`=xxab、`'a-b-a'.replaceAll('a','X')`=X-b-X、`[3,2,1].reverse().join('-')`、`[1,2].concat([3,4])`、`.slice/.includes/.indexOf/.at(-1)`、`[[1],[2]].flat()`、`parseInt/parseFloat/Number`、`(255).toString(16)`=ff、`(3.14159).toFixed(2)`、`Array.isArray`、`'a,b,c'.split(',').join('|')`、`[5,3,1,2].sort().join(',')`=1,2,3,5、`[1,2,3].join()`=1,2,3。

- **P8.2 函数/箭头表达式(闭包)✅(2026-07-16)**:eval 内**函数/箭头表达式**打通——数组高阶方法回调、IIFE、捕获、嵌套闭包全可用。原 P7 边界(闭包体 `pendingFunctions`→`generatePendingFunctions` 在 `_main` 后**离线发射** + `lea _fn_N` code-label 引用,片段模型容不下)解法三件套:
  1. **离线体嵌入同片段**:主体 + epilogue 后、切片前调 `c.generatePendingFunctions()`,把各 `_fn_N` 体追加进**同一 `c.asm.code`** 区间(→被切片纳入);其体内 bl/adrp/局部分支 fixup 同在 `fixupArr` → 与主码一同走 trampoline/DATA/局部分支回填。
  2. **code-label lea 重定位**(DATA 新分支):闭包对象 `lea reg,_fn_N` 存函数指针,label 解析为**片段内 code 偏移**(`c.asm.labels` 中且 offset≥cs)→ 按数据引用同法回填 `ADRP imm=0`(同页)+`ADD 页内偏移`;运行时 adrp 取片段页基址 + add = 体的运行时地址,闭包 `callIndirect(blr)` 跳入。
  3. **闭包/回调符号补全**(SYM_IDS→98 项):`_alloc`(建闭包对象)、`_typed_array_new`(map/filter 的 TypedArray 死分支仍内联发射)、`_coroutine_create/_strict_eq/_syscall_arg`(回调体常见)、`_promise_new/_scheduler_spawn`(IIFE async 死分支)、`_box_alloc/_print_str`(捕获外层 eval 局部 + 其 TDZ 死路)。

  **实测(全对齐 node,gen2==gen3 保持)**:`[1,2,3].map(x=>x*2).join(",")`=2,4,6、`filter/reduce/find/some/every/forEach`、`sort((a,b)=>a-b)`、链式 `filter().map()`、`(x=>x+1)(41)`=42(IIFE)、**捕获外层 eval 局部** `var k=10; [1,2,3].map(x=>x+k)`=11,12,13、**嵌套闭包** `[1,2,3].map(x=>[10,20].map(y=>x+y).join('+'))`=11+21;12+22;13+23。**~~边界:arm64 片段须 <4096B(ADRP 同页)~~**(此约束已于 **P9.3 解除**——见下,现支持多页片段至 256KB)。

- **P9 全局 `eval()` / `new Function()` 接线 ✅(2026-07-16)**:普通 asm.js 程序**直接**调 `eval(str)` / `new Function(body)()` 即得运行时编译结果——无需手动 import `evalExpr`。接线机理**完全复刻 JSON/RegExp shim 套路**(gate 安全):
  1. **shim 落点** `runtime/node/__eval_shim.js`:`__eval(x)`(间接 eval;非字符串按 ES 规范原样返回;字符串走 `compileFragment`+`__engine_exec_reloc`)与 `__makeFunction(body)`(把 body 编成片段,返回可调用闭包)。import 它即把**整个编译器**编入(route B 设计,只有用 eval 的程序付代价)。
  2. **注入** `compiler/index.js readModuleSource`:模块源码含 `eval(` 或 `new Function(` 时前置 `import { __eval, __makeFunction } from "__eval_shim"`。**编译器自身源码二者皆无 → 自举永不注入 → gate 零影响**。
  3. **改派**:`compileCallExpression` 把 `eval(x)`→`__eval(x)`(守卫:用户局部/函数遮蔽 `eval` 时尊重用户绑定);`compileNewExpression` 把 `new Function(...argNames, body)`→`__makeFunction([argNames], body)`(末位实参为 body,其余为形参名)。
  4. **别名注册** `registerEvalShimAliases()`(机理同 `registerJsonShimAliases`):把合成的 `__eval`/`__makeFunction` 绑定别名进每个含注入 import 的模块,使**嵌套函数/箭头体内**的 eval 改派也解析得到(否则合成调用在子 ctx 被静默丢弃——JSON shim 同款缺陷)。
  5. **片段支持 `return X`**(`engine/compile.js`):`new Function` 体常见 `return`;把 `ctx.returnLabel` 设为 epilogue 前的 `_frag_return` 汇合点,return 置 RET 后跳来,与 fall-through 完成值共用出口。

  **实测(全对齐 node,gen2==gen3 保持,fixtures 105/31)**:`eval("2+3")`=5、`eval("[1,2,3].map(x=>x*2).join(',')")`=2,4,6、`eval("var x=5; x*x")`=25、`new Function("return 40+2")()`=42、`eval(42)`=42(非字符串透传);**嵌套作用域全通**——`function run(c){return eval(c)}` / 箭头 `()=>eval(...)` / 双层嵌套 / `new Function` 体含数组回调。用户 `function eval(){}` 遮蔽被尊重。**语义/边界**:间接 eval / 全局作用域——**不捕获调用处词法作用域**(独立里程碑,**已于 P10 实现**——见下);片段尺寸上限(P9.3 后为 256KB)经 `eval` 调用点抛**可捕获异常**(catch 后继续执行)。

- **P9.1 `new Function` 形参 + 健壮性 ✅(2026-07-16;形参路径 2026-07-16 重构)**:`new Function` 支持**具名形参 + 默认/rest 形参 + 函数语义**。**实现:闭包包装**——`__makeFunction(names, body)` 把两者拼成函数表达式源码 `(function(<params>){<body>})`,编成片段并求值,片段结果即一个**真 asm.js 闭包**,直接返回。用户调用它走标准闭包调用约定(`callIndirect` 到片段 mmap 页内的函数体,该页执行后不释放故函数指针恒有效),因此默认参数/rest/解构**全由正常 `compileFunctionBody` 处理**,引擎侧零形参逻辑。(早期版本用"实参穿透 A0..A5 + 片段形参前置"的手工绑定,已被闭包包装取代并回退——后者复用编译器既有形参机制,更简更全。)
  **实测(全对齐 node,gen2==gen3 保持,fixtures 105/31)**:`("a","b","return a+b")(2,3)`=5、`("x","return x*x")(7)`=49、`("a","b","c","return a+b+c")(1,2,3)`=6、`("return 42")()`=42、**默认** `("a","b=10","return a+b")(5)`=15、`("a=1","b=2","return a+b")()`=3、**rest** `("...args","return args.length")(1,2,3)`=3、`("...xs","return xs.reduce((a,b)=>a+b,0)")(1,2,3,4)`=10、**混合** `("a","...rest","return a+'/'+rest.join(',')")(1,2,3)`="1/2,3"、逗号形参 `("a,b","return a*b")(6,7)`=42、复用/传递。**健壮性**:语法错误串 `eval("2 +")`、片段超限均抛**可捕获 JS 异常**(非崩,catch 后续行);number/string/bool/array/object/undefined 六类经宿主往返正确;`new Function` 结果是**真可调用值**(存变量、多次调用、传参给别的函数再调)。**偏差(均为 asm.js 通用函数语义,故 new Function 与其余 asm.js 函数一致而非特例)**:>6 形参只绑前 6 个(asm.js 调用约定 6 寄存器传参、无栈溢出——普通 7 形参函数亦丢第 7 参);无显式 `return` 的函数体返回 **0**(非 undefined;asm.js 函数 fall-through 返 0)。

- **P9.2 eval 语句 / 控制流覆盖 ✅(2026-07-16)**:eval'd 代码内的语句形态大幅补齐。新增 SYM_IDS(真 label,同序;98–103):`_exc_ctx_top`(**HOST_DATA**:try/catch 异常上下文链头全局,try-enter 压帧/正常退出弹帧经 adrp 读写,须重定位到宿主地址)、`_str_codepoint_at`/`_str_cp_bytes`/`_map_entries`(for-of 迭代器的字符串/Map 分支,数组 for-of 不取但内联发射)、`_object_new`/`_object_set`(`throw new Error(...)` 建对象)。**完成值(eval 语义)**:旧逻辑把任何非表达式末句强置 RET=undefined,致 `eval("try{throw 1}catch(e){e+10}")` 返 undefined;改为仅"无值"末句(声明/空/break/continue)置 undefined,控制流语句(if/try/switch/循环/块)保留 asm.js codegen 恒留在 RET 的"最后求值表达式"。**函数声明提升**:顶层 `FunctionDeclaration` 先编,前向调用 `eval("foo(); function foo(){return 1}")`=1 可用。**实测(对齐 node)**:try/catch(=11)、try/finally、`throw new Error` 被 eval 调用方 catch、switch(fallthrough+break+default)、函数声明(含提升)、do-while、带标签 break/continue、for-of(数组+字符串)、for-in、三元/逻辑链、可选链、模板插值。**已知偏差**:`try{}catch{}finally{}` 完成值取 finally 值而非 catch 值(细则,修复须动共享语句 codegen,越界)。

- **P9.3 多页片段(arm64)✅(2026-07-16)**:解除 <4096B 单页上限——旧限来自"强制 ADRP imm=0 同页共置"(数据/代码引用只能命中与 ADRP 指令同一 4KB 页的目标)。改为**逐引用 ADRP 页差计算**:片段缓冲按页对齐 mmap 加载,故页差完全由缓冲内偏移决定 `pageDelta=(addr>>12)-(off>>12)`,写入 ADRP 的 imm21(immlo=bit30:29、immhi=bit23:5),ADD 保持 `addr&0xfff`;同页引用 pageDelta=0 逐位等价旧行为。`_engine_reloc_exec` 的 mmap/mprotect 长度按 `(fragLen+4095)&~4095` 取整(映射足够页)。新上限 256KB(trampoline/HOST_DATA 的 ldr-literal 与 bcond/cbz 局部分支用 19 位 PC 相对 imm=±1MB,256KB 安全余量;超限抛清晰错误)。`FRAG_FRAME` 1024→8192(码尺寸上限解除后,局部槽成深链瓶颈)。**实测(对齐 node,曾报 ">4096B")**:`[1,2,3].map(x=>x*2).map(x=>x+1).map(x=>x*3).map(x=>x-1).join(',')`=8,14,20、8 元素 map/filter/map 链、6 层 map 链;小片段(2+3、`({a:1}).a`)不变。**follow-up**:>256KB 需把 trampoline/HOST_DATA 的 ldr-literal(19 位)换成 ADRP+LDR 双指令(或 GOT 式间接表),再放宽到 bl 的 ±128MB。

- **P10 直接 eval 词法作用域捕获 ✅(2026-07-16)**:直接 `eval(str)` 现**读写调用处外层函数的局部变量**——`function f(){let x=10; eval("x=20"); return x}`→20(对齐 node),这是引擎最后一块硬骨头。此前 eval 恒为间接/全局语义(看不见调用者栈槽)。机理:
  1. **调用点分派**(`compiler/functions/functions.js` 直接 eval 分派)——直接 eval(callee 为裸标识符 `eval`,间接形 `(0,eval)`/别名/成员的 callee 非此)把外层函数的**局部名→FP 槽偏移**序列化成 `layoutStr`,连同**调用者运行时 FP**(新内联 builtin `__eval_frame_ptr()` = `mov RET, FP`,内联故取当前帧)传给 `__eval_direct(x, fp, layoutStr)`。装箱(被真闭包捕获)/循环寄存器驻留(rawInt/fpAccum,槽陈旧)变量不纳入;无可捕获局部(全局作用域)时退回 `__eval`(全局语义)。
  2. **copy-in/copy-out 片段**(`engine/compile.js compileFragment` 第三参 `captureLayout`)——片段以 `A0=callerFP` 执行:入口把每个捕获变量从 `[callerFP+off]` 拷入片段局部槽(seed `c.ctx.locals`,故 `c.compileStatement` 对这些名的读写天然解析到片段槽);出口(RET 完成值经 V3 保活)把片段槽写回 `[callerFP+off]`。对"直接 eval 读写外层局部后返回"精确匹配 node。
  3. **传 FP 的执行器**(`runtime/core/allocator.js _engine_reloc_exec_fp`)——同 `_engine_reloc_exec`,额外把 `A4=callerFP` 在跳入片段前置入 `A0`(入口 push 保活,躲过 mmap/memcpy/reloc 对 A 寄存器的冲刷)。builtin `__engine_exec_reloc_fp`。
  4. **shim** `runtime/node/__eval_shim.js __eval_direct(x, fp, layout)`——`compileFragment(x, HOST_TARGET, layout)` + `__engine_exec_reloc_fp`;别名注册/import 注入同 `__eval`(compiler/index.js)。

  **实测(全对齐 node,gen2==gen3 保持,fixtures 293)**:写 `eval("x=20")`=20、读 `eval("x+1")`=8、多变量 `eval("x=x+y")`=15:5、形参捕获 `eval("x=x+100")`=109、eval 后续用变异值 `eval("c=7");c+1`=8、字符串 `eval("name=name+'hn'")`="john"、三变量 `eval("a=b+c")`="5,2,3"、eval 内 `var z=x+40` 不污染读的 x=1、块内 eval `if(true){eval("x=42")}`=42。fixture `tests/fixtures/es/eval-direct-lexical-capture`。
  **GC**:片段分配触发 GC 时,调用者原生帧仍活(保守扫为 GC 根),copy-in 值在片段帧内亦被扫,无悬垂。
  **follow-up 进展(round 2,2026-07-16)**:
  - **(b) 捕获数组/对象经方法/成员变异 ✅**——`let a=[]; eval("a.push(1)")`、`let o={}; eval("o.k=9")` 现**变异经共享堆传播、eval 返回后可见**(对齐 node)。根因:copy-in 拷的是**装箱指针**(数组/对象堆头址),identity 天然保留(`a[0]=9` 早已可用即证);缺的是片段引用的运行时符号未登记 SYM_IDS。补齐:`_tag_str_a1`/`_tag_key_a1`(属性键装箱)、`_validate_callable`(动态方法可调用校验)、数组变异簇 `_array_pop/shift/unshift/splice/concat`,并把 `emitObjectSetIC` 的 NO-IC 分支接上 `engineNoIC`(成员写 `o.k=v` 走无站点回填的 `_object_set`,与读路径 `_object_get` 对称,免写 RX 片段页 SIGBUS)。覆盖 push/pop/shift/unshift/splice/成员改写/新增属性/下标写。fixture `tests/fixtures/es/eval-direct-capture-mutate`。
  - **(a) eval 内闭包捕获被捕获变量——读/同步用例 ✅**——`let base=10; eval("[1,2,3].map(v=>v+base)")`=`[11,12,13]`、`reduce((s,v)=>s+v, acc)` 现对齐 node。闭包在 eval **同步执行期**创建并调用,读片段槽内的 copy-in 值即正确。补 `_box_arr_r`(数组方法返新数组的收尾装箱)。剩余边界见下 round-3。③乘法 `v*2`(需 `_nan_canon`)/`filter`(需 `_typed_array_from`)在 eval 片段内的表达式 codegen 属 ES lane,本轮不动。

  **follow-up 进展(round 3,2026-07-16):eval 内非逃逸闭包写回捕获标量 ✅**——`function f(){let s=0; eval("[1,2,3].forEach(v=>{s=s+v})"); return s}`=6(此前 asm.js=0)。round-2 边界②(闭包**写回**捕获变量)现修:根因是 copy-in 按**值**把调用者槽播种到片段局部,片段内创建的闭包遂捕获片段局部的**私有 box 快照**,写入永不回灌调用者槽。修法与普通编译器 **rebox-on-capture** 同构:
    1. **copy-in 时选择性装箱**(`engine/compile.js capturesBoxedByInnerClosure`)——对片段 AST 跑闭包分析(复用 `lang/analysis/closure.js analyzeCapturedVariables`,以全部 copy-in 名为外层作用域),判出哪些 copy-in 名被**片段内创建的闭包**捕获。这些名 copy-in 时 `_box_alloc` 建堆 box、`box[0]=调用者值`、片段槽存 **box 指针**,并加入 `c.ctx.boxedVars`。
    2. **共享同一 box**——片段内闭包创建时,`compileFunctionExpression` 的 `outerBoxedVars.has(name)` 分支把**既有 box 指针**存进闭包槽(而非另建快照 box),闭包与片段遂共享同一 box;箭头体 `s=s+v` 经 box deref 读写落此共享 box。
    3. **copy-out 读 box**——出口对 boxed 捕获槽先 deref `box[0]` 再写回调用者槽,把闭包同步执行期的写入回灌。
    未被闭包捕获的 copy-in 名仍走原**按值** copy-in/out(逐字节不变),故对既有读/变异用例零回归。实测(全对齐 node):int/string 累加器 forEach 写回、reduce/map 读、双捕获变量、嵌套箭头两级写回、逃逸**读**闭包(`g=eval("(function(){return base})"); g()`=copy-out 值)。fixture `tests/fixtures/es/eval-direct-capture-writeback`。

  **follow-up 进展(round 4,2026-07-16):逃逸闭包 eval 后再改捕获变量 ✅**——`function f(){let base=10; let g=eval("(function(){return base})"); base=20; return g()}`=20(此前 asm.js=10,round-3 边界①)。根因:调用者帧内 `base` 是**普通值槽**(调用者自身编译期未被任何闭包捕获,故非 box),片段闭包 copy-in 时另建私有 box 快照;`base=20` 只写调用者值槽、不触该 box → 逃逸闭包读到 copy-out 时的陈旧快照。修法=**调用者帧模型升级**(保守 box-all):
    1. **含直接 eval 的函数,全部局部升级为 box**(`lang/analysis/closure.js analyzeDirectEvalBoxedVars`——扫本函数体直属的 `eval(...)` 调用,命中则把全部局部/参数名并入 boxedVars;不下潜嵌套函数——其 eval 由该嵌套函数自己的帧模型处理)。集成于顶层函数声明(`compiler/index.js` getFunctionBody)与嵌套函数表达式(`compiler/functions/closures.js`)两处 boxedVars 计算点。这样调用者槽存 **box 指针**,`base=20`/`return base` 皆经 box deref(复用编译器既有 boxed-local codegen,无新机制)。**编译器自身源码无直接 eval → analyzeDirectEvalBoxedVars 恒返空集 → 自举永不触发 → gate 逐字节零影响**(实测 gen2==gen3 byte-identical、产物 15.5MB 不变)。
    2. **调用点 layout 标 `:b`**(`compiler/functions/functions.js` 直接 eval 分派)——boxedVars 里的捕获名现纳入 layout(此前被跳过),尾随 `:b` 表"调用者槽已是 box 指针"。
    3. **片段 copy-in 复用同一 box**(`engine/compile.js` parseCaptureLayout 解析 `:b`;copy-in 对 `:b` 名直接把调用者槽的 box 指针拷入片段槽 + 标 boxedVars,**不新建快照 box**;copy-out 对 `:b` 名 **no-op**——写已直接落共享 box,误回灌 deref 值会覆盖调用者槽的 box 指针毁帧)。调用者与片段闭包遂看**同一 box**:逃逸闭包写、调用者 eval 后续写、闭包重复调用皆联动。
    实测(全对齐 node,gen2==gen3 保持,fixtures 336):逃逸后改(=20)、多次后改(=3)、捕获形参后改(=105)、双变量后改(=10,20)、逃逸**写**闭包+重复调用(=7/6/7)、调用间交错写(=100/200)、**同名变量既被真闭包又被 eval 写**(`let h=()=>x; eval("x=50")`=50/50——此前 eval 看不见真闭包 box,现一并修)、嵌套函数含 eval(=42)、箭头含 eval(=9)。fixture `tests/fixtures/es/eval-direct-capture-escape`。
    **仍存边界(defer,架构级)**:sloppy `var`-in-eval leak(见下 (c))——box-all 无助,因宿主函数源码里根本没有该 var 的槽。
  - **(c) sloppy `var`-in-eval leak 未实现(defer)**——`function f(){eval("var q=99"); return typeof q}` node 返 "number"(var 泄漏到 f 作用域),asm.js 返 "undefined"(片段 var 仅在片段作用域;f 编译期无 q 槽,静态帧模型无处泄漏)。要正确须在直接 eval 调用点为宿主函数**预留动态 var 槽**或改用作用域链对象,属架构级,记明 defer。

- **P10.0 修复:eval 片段字节的 TypedArray 数据指针(2026-07-16)**:eval 全线(含间接/全局 `eval("2+3")`)此前在本构建**执行空页 SIGILL**——根因是 [Design A] TypedArray 布局重构 `[type@0, length@8, data_ptr@16, buffer@24, data@32]` 把数据从"内联于 header+16"移到 `data@32`(经 `data_ptr@16` 间接)。引擎 exec builtins(`__engine_exec`/`__engine_exec_reloc`/`__engine_exec_reloc_fp`/`__engine_exec_raw`)仍按旧布局取 `addImm A, block, 16`——现取到的是 `data_ptr` **字段本身**(一个指针)当代码址 → memcpy 复制指针/头字节当机器码 → 执行空/垃圾页崩。修:改 `load A, block, 16`(解引用 data_ptr@16 取真数据址,内联/buffer 视图统一)。`length@8` 不变(Uint8Array 元素数=字节数)。这解锁了所有 eval,是 P10 捕获里程碑的前置。

## x64 同步 ✅(2026-07-12)

引擎 eval 现**双架构**(arm64 + x64)。`compileFragment(source, target)` 按 `c.arch` 分支;`evalExpr(src, target)` 传宿主架构(x64 宿主必传 `macos-x64`/`linux-x64`,默认 `macos-arm64`)。**实测**(macos-x64 二进制,Rosetta 下):`40+2`=42、`(2+3)*4`=20、`2*3+4*5`=26、`10*2-3`=17、`"ab"+"cd"`="abcd"、`"x"+"y"+"z"`="xyz" 全对齐 node;arm64 回归 + gen2==gen3 定点保持。

x64 三处架构差异(与 arm64 分野):
1. **fixup 容器/类型**:x64 用 `asm.fixups`(`rel32` 调用 / `rip32` 数据),arm64 用 `asm.pendingFixups`(`bl` / `adrp`)。
2. **trampoline**:x64 `mov rax,[rip+2]`(48 8B 05 02 00 00 00)+`jmp rax`(FF E0)+8B slot;call rewrite `disp = tOff-(callOff+4)`。arm64 `ldr x16,#8`+`br x16`。x64 `rip32` disp32 ±2GB,无 arm64 的 4096B 同页约束。
3. **.data 物化时机**:x64 浮点/常量编译期存于 `dataLabels` 异构条目(`{type:"label"|"byte"|"qword"|"float64"}`),offset/字节在 `fixupAll` 才生成——`compileFragment` 须自行复刻物化(label→当前长度、float64→8B 小端);arm64 的 `asm.data` 编译期即含字节、`dataLabels[i].offset` 直接可用。

**根因坑(x64 专属崩)**:`_engine_reloc_exec` 里 `pop V0`(slotOff)在 `_engine_symaddr` 调用后覆盖 RET——因 **x64 V0=RAX=RET 别名**(arm64 V0=X8≠X0 故不炸),导致 slotOff(如 73)被当符号地址写进 trampoline slot → `jmp 73` SIGSEGV。修:call 后 `mov V2, RET` 先存符号地址(x64=RDX/arm64=X10,两架构均≠RET),再 pop/add/store 用 V2。**通用寄存器契约:跨 helper 调用保存返回值须避 V0(x64 别名 RET)**。

### x64 全特性对齐 arm64 ✅(2026-07-16,Rosetta 实测)

x64 补齐到与 arm64 完全对等——**唯一缺口是 HOST_DATA 宿主数据重定位**(共享堆 `_heap_base`/`_heap_ptr`、异常状态 `_exception_value`/`_exception_pending`/`_exc_ctx_top`);闭包 code-label 重定位(x64 rip32 disp 天然处理)、多页(x64 rip32 ±2GB 无页限,guard 本就 `!isX64`)早已可用。

- **HOST_DATA on x64**:arm64 把 `adrp+add` 改写成 `ldr-literal`;x64 等价把 `lea r64,[rip+disp32]`(`48 8D ModRM disp32`)改写成 `mov r64,[rip+slot]`——**opcode 字节 0x8D→0x8B**(lea→mov),disp32 指向片段内追加的 8B 槽(reloc 运行时填宿主符号地址),REX/ModRM 不变;后续原有 `mov r64,[r64]` 即读宿主值(与 arm64 `ldr [Xd]` 同义)。disp = `slot−(off+4)`(rip 相对下条指令,base 无关)。
- **架构自适应的全局 `eval`/`new Function`**:片段编码按架构不同,故不能硬编码目标。新增编译期 builtin `__engine_host_target()` 返回本二进制 target 串(`macos-x64`/`macos-arm64`/`linux-x64`);`__eval_shim` 据此编出与运行架构一致的片段。

**Rosetta 实测(macos-x64 二进制,全对齐 node + arm64 构建)**:堆装箱算术 `-5+2`=-3、`Math.sqrt(16)`=4、数组 join/下标、字符串方法、typeof、对象字面量读、语句序列、**闭包**(map/reduce/嵌套)、try/catch、for-of、switch、函数提升、三元/模板/可选链、长方法链;**全局 `eval()`/`new Function()`**(含 rest/默认形参、嵌套作用域、语法错误可捕获、类型往返)在 macos-x64 二进制上与 arm64 及 node 一致。**x64 局限**:仅 macos-x64 经 Rosetta 实测;linux-x64/windows 编译可过但运行未验证(本环境无法执行)。

### 直接 eval 词法捕获(P10)的 x64 状态(2026-07-16,round 5)

**引擎侧捕获机制本身已是架构中立、无需"移植"**:调用点分派(`compiler/functions/functions.js` 直接 eval)、`__eval_frame_ptr()`=`mov RET,FP`、执行器 `_engine_reloc_exec_fp`(`runtime/core/allocator.js`,无条件发射)、片段 copy-in/copy-out(`engine/compile.js`,`:b` 装箱布局)、shim `__eval_direct`(`runtime/node/__eval_shim.js`,经 `__engine_host_target()` 编出与运行架构一致片段)——**全部用 VReg VM 抽象与 AST 合成写成,x64/arm64 同码**。arm64 实测通过(`x=10;eval("x=20");return x`→20、对象变异→9、数组 push→2、非逃逸闭包写回→6、逃逸闭包后改→20,均对齐 node)。

**x64 Rosetta 端到端验证本轮受阻于一个既存的、与 eval 无关的 x64 数字→串(Dragon4 `_floatToString`)缺陷簇**——`print(<number>)` 及任何 import eval shim 的程序(内嵌编译器模块初始化会格式化数字)在 x64 上直接崩。根因是 x64 后端/运行时的寄存器别名/临时寄存器冲刷(此缺陷早于本轮所有引擎工作,v1.5.42 即在)。本轮已定位并修复其中三处(见提交):
- 后端 `add/mul/and/or/xor(dst,a,dst)`(dst==b)经 R10 临时法冲刷 R10(=V5)——交换式免临时(`bcf5b209`)。
- Dragon4 `_d4_shl` src1 用 A2 冲刷 wordShift(V2,同 RDX)——整数偏 32 位字(`07872a37`)。
- Dragon4 `_d4_add3` carry(V2)与 b 指针(A2,同 RDX)别名——空指针解引用(`07872a37`)。

修复后 x64 上 `print(<number>)` **不再崩**,单位数/整十百(1/2/5/9/10/100)正确;**仍存**多有效位截断(如 42→"40"、255→"200",Dragon4 逐位循环内至少还有一处 x64 缺陷)+ 运行内嵌编译器做 eval 时另有一处装箱值当指针崩(`addr≈0x7ffd`)。**故直接 eval 词法捕获(及一切 eval)在 x64 上尚未端到端跑通**——阻塞项全在 x64 后端/数字格式化质量层面(本 lane 之外),非 eval 捕获逻辑本身。arm64 自举门保持字节一致(gen2==gen3),fixtures 339,arm64 数字/eval 无回归。**后续(2026-07-17 注)**:上述 x64 阻塞簇已于 **v1.5.49** 修复——Dragon4 多有效位截断(42→"40"、255→"200" 类)与 `addr≈0x7ffd` 装箱值解引用(filter/JSON/for-in SIGSEGV)同属 x64 后端 `V0`/`RET`→`RAX` 寄存器别名问题簇,已按 `vm.arch==="x64"` 门控归位(arm64 发射逐字节不变);Rosetta 下 x64 的数字/filter/map/reduce/JSON/Object.keys/for-in 与 arm64 对齐。CHANGELOG 未记录 eval 捕获在 x64 的端到端复验,x64 自举定点亦仍未达成(剩余下游 x64 缺陷已 mapped for follow-up)。

## 风险 / 待决

- ~~**作用域捕获**:直接 eval 能看见调用处词法作用域~~ **✅ 已实现(P10,2026-07-16)**:调用点序列化名→槽布局 + 传运行时 FP,片段 copy-in/copy-out 读写调用者栈槽。见上 P10 节。剩余 follow-up(均在 P10 follow-up 记明):捕获数组/对象方法变异 ✅(round 2)、eval 内非逃逸闭包写回捕获标量 ✅(round 3)、逃逸闭包 eval 后再改捕获变量 ✅(round 4,含直接 eval 的函数保守 box-all 局部);defer(架构级):sloppy var-leak。
- ~~**W^X / 代码签名**:macOS 对 JIT 内存要 `MAP_JIT` + `pthread_jit_write_protect_np`;需专门处理。~~ **✅ 已被 P0 实测推翻(2026-07-12)**:macOS arm64 虽禁 RWX(mmap RWX 返 EACCES),但未签名二进制可 mmap RW → mprotect RX(W^X 翻转)执行——无需 MAP_JIT/entitlement/libc,纯 syscall;全新页无需 icache 刷新(跨页/复用页须 dc cvau/ic ivau,P4 已补 `_engine_iflush`)。原标注的 macOS JIT 主坑不成立。
- **多架构**:x64/arm64 的重定位类型与 JIT 内存策略不同。**✅ 双架构已落地**(见上"x64 同步"节):trampoline/fixup 容器/.data 物化三处架构分野均按 `c.arch` 分支处理,HOST_DATA 重定位在 x64 以 lea→mov(0x8D→0x8B)改写对齐 arm64;仅 macos-x64 经 Rosetta 实测,linux-x64/windows 编译可过但运行未验证。
- **代码缓存**:同一 `new Function` 体重复 eval 应缓存编译结果。
- **安全**:运行时执行任意代码,仅限受信输入场景(与项目"授权安全测试"边界一致)。

## 现状

(截至 v1.5.52,2026-07-17:fixtures 362/362,gen2==gen3 自举定点保持。)

- **P0–P10 全部完成**:执行器基元(P0)→ 宿主符号重定位 + PIC 片段(P1/P2)→ 共享堆/GC(P3,落地于 P5/P6)→ 编译器常驻真 eval(P4)→ 表达式/分配/语句/闭包覆盖(P5–P8)→ 全局 `eval()`/`new Function()` 接线(P9–P9.3;多页片段上限 256KB)→ **直接 eval 词法作用域捕获**(P10 + round 2–4:捕获对象变异传播、eval 内闭包写回、逃逸闭包与调用者后续写联动)。
- **arm64 + x64 双架构**:片段编译/重定位按 `c.arch` 分支,`__engine_host_target()` 使 shim 编出与运行架构一致的片段;x64 经 Rosetta 实测(直接 eval 捕获的 x64 端到端复验遗留,见上 round 5 节及其后续注)。
- **仍开放**:sloppy `var`-in-eval 泄漏(P10 (c),架构级 defer);**运行时 specifier 的 `import(变量)`**(本引擎动机之一,尚未接线);**eval 编译结果代码缓存**(见上"风险 / 待决")。
- 相邻已交付:**静态 specifier 动态 import**(编译期可解析,非本引擎;见 `docs/ES_SUPPORT.md`、提交 e46f17cd)——那是 AOT 可做子集,不需运行时引擎;本引擎处理**运行时 specifier / eval / new Function**。
