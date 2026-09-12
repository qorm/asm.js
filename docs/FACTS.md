# asm.js 事实源

本文件是版本、门禁、自举与 test262 **口径**的单一事实源。
`plan.md`、`docs/ES_SUPPORT.md`、`docs/NODEJS_SUPPORT_ANALYSIS.md`、
`docs/ROADMAP.md` 里的数字若与本文件冲突，以本文件和仓库内对应机器可读源为准。

核对日期: 2026-09-09

形状 v2 转移表运行时 helper 已生成,加键仍 `shape_ptr=0`(接线会在对象 set 里 `_alloc`,打乱 Channel 协程 golden)。多段堆未做:非连续 `_heap_grow` 改为 exit 75。用户函数帧仍固定 32 KiB(深递归 native 8MB 栈不够,见 es/wasm-deep-recursion)。

## 产品与版本

| 项 | 值 | 权威位置 |
|---|---|---|
| 产品名 | asm.js | `README.md`、`package.json` `name` |
| 版本 | 0.4.5 | `cli.js` `VERSION`、`package.json` `version` |
| 主页 | https://asm.js.cn | `README.md` |

## 门禁

| 项 | 值 | 权威位置 |
|---|---|---|
| fixtures 发现数 | 522（随新 fixture 只增不减） | `scripts/bootstrap-gate.sh` `BASELINE_FIXTURES` |
| fixtures 判定 | FAIL=0、XPASS=0、PASS+XFAIL=发现数 | 同上，runner = `scripts/run-fixtures.mjs` |
| 自举定点 | ARM64 双目标 `gen1==gen2==gen3` 字节一致 | `BOOTSTRAP_RULES.md`、`scripts/bootstrap-gate.sh` |
| x64 定点 | v1.1.0 曾达成，当前回退（布局敏感；devirt 对 x64 关闭） | `README.md` Self-Hosting |
| 定点纪律 | 跑定点链前 `rm -f gen1 gen2 gen3` | `plan.md` 风险表、gate 脚本 |

## test262 口径

**已达成里程碑**（发布门禁仍用这个，直到全集 0/0/0）：官方样本五发布目标同一口径 — 选定 `language/expressions`+`language/statements` + 13 个核心 `built-ins/`，stride=5，每测试一个变体，FAIL=COMPILE_FAIL=CRASH=0 才记该样本 100%。五目标均已 6276/6276（virtreg 后 `--gate`：macos-arm64 / macos-x64 / linux-arm64 / linux-x64 2026-09-08，windows-x64 2026-09-09）。这不是 ES 全部支持。

**全集目标**（未达成，不得称 100%、不得称 ES 全部支持）：ECMA-262 语料 `test/language` + `test/built-ins` + `test/annexB`，stride=1，最终双变体（strict+sloppy），FAIL=COMPILE_FAIL=CRASH=0。可实现面（BigInt、`regexp-v-flag`、`dynamic-import`、`Array.fromAsync` 等）不再从分母剔除，缺什么补什么。仍排除 `intl402/`（ECMA-402，不是 262）和 `staging/`（提案）。全集跑必须 `--no-report`，不得覆盖 stride-5 头条 `last_report.md`。命令：`scripts/test262-corpus.sh`。Date 楔（macos-arm64，`built-ins/Date` stride=1，583/583，FAIL=COMPILE_FAIL=CRASH=0，2026-09-08，`--no-report`）不是官方样本，也不是 ES 全部支持。

负向测试按阶段计分，不核对精确错误构造器。执行按 `--target` 派发（直跑 / Rosetta / Docker / Wine），`t123` 这类无平台后缀的产物不得按宿主平台猜。

| 项 | 值 | 权威位置 |
|---|---|---|
| 官方样本（已达成门禁） | stride=5，默认 SELECTED_DIRS，一变体/测试 | `tests/test262/run.mjs --stride 5 --gate` |
| 头条 macos-arm64 | **6276/6276 = 100%**（FAIL 0、COMPILE_FAIL 0、CRASH 0；2026-09-08 virtreg 后 `--gate`） | `tests/test262/last_report.md` |
| 全集（未达成） | `language`+`built-ins`+`annexB`，stride=1 | `scripts/test262-corpus.sh` |
| 跨平台矩阵 | 见下表；不可跑目标记 SKIP，不记作 100% | `last_report-<target>.md`、`tests/test262/exec-target.mjs` |
| 发布门禁 | 每个可跑发布目标官方样本 FAIL=COMPILE_FAIL=CRASH=0 | `scripts/test262-gate.sh` / `tests/test262/matrix.mjs --stride 5 --gate` |
| 排除（官方样本） | Intl/staging、以及 harness 标为 unsupported 的 feature | `last_report.md` `excludedFeatureCounts` |
| leftover-arg 猎日志 | linux-x64 历史定点修复记录，不是官方 stride-5 报告 | `tests/test262/last_report_linux-x64.md`（下划线） |
| 过期摘要 | `tests/test262/last_run_summary.json` 若落后于 `last_report.md`，勿当头条 | 文件日期 |

## test262 跨平台矩阵

执行器：`tests/test262/exec-target.mjs`（`--target` 显式派发；`t123` 不再按文件名猜宿主）。linux-arm64 曾因 ELF `writeBytes` 把 `ByteBuffer` 下标成 `undefined` 写出全 0 文本段（SIGILL）；已改为 `appendToArray`。

| 目标 | 本机执行器 | 官方 stride-5 | 权威报告 |
|---|---|---|---|
| macos-arm64 | 直跑 | **6276/6276 = 100%**（2026-09-08 virtreg 后 `--jobs 8 --gate`） | `last_report.md` |
| macos-x64 | Rosetta 2 | **6276/6276 = 100%**（FAIL 0、COMPILE_FAIL 0、CRASH 0；2026-09-08 virtreg 后 `--jobs 4 --gate`） | `last_report-macos-x64.md` |
| linux-arm64 | Docker `linux/arm64` | **6276/6276 = 100%**（FAIL 0、COMPILE_FAIL 0、CRASH 0；2026-09-08 virtreg 后 `--jobs 8 --gate`） | `last_report-linux-arm64.md` |
| linux-x64 | Docker `linux/amd64` | **6276/6276 = 100%**（FAIL 0、COMPILE_FAIL 0、CRASH 0；2026-09-08 virtreg 后 `--jobs 4 --gate`，docker qemu run timeout 180s） | `last_report-linux-x64.md` |
| windows-x64 | Wine | **6276/6276 = 100%**（FAIL 0、COMPILE_FAIL 0、CRASH 0；2026-09-09 virtreg 后 `--jobs 4 --gate`，每 job 独立 WINEPREFIX，wine run timeout 60s） | `last_report-windows-x64.md` |

virtreg/`_holdExpr` 之后五目标均已复跑官方 stride-5 `--gate`：macos-arm64（2026-09-08 `--jobs 8`）、macos-x64（2026-09-08 `--jobs 4`，Rosetta 60s）、linux-arm64（2026-09-08 `--jobs 8`，含 linux 整数键 `12345678` 不再当数据段串指针）、linux-x64（2026-09-08 `--jobs 4`，qemu 180s：`new Date` 年份 NaN 判别用 V5 而非 V0≡RET；generated `\p{}` Mark 整串扫描约 120s）、windows-x64（2026-09-09 `--jobs 4`，Wine 60s，每 job 独立 WINEPREFIX）。

本轮已修（跨平台 100% 的阻塞项）：linux-arm64 ELF `ByteBuffer` 写出全 0；`obj[Symbol.match]()` CALL 未走 well-known 键；`delete proto[Symbol.toStringTag]` 只删字符串别名；x64 `_ta_ensure_species` 把 RET 写成 1；x64 `_str_static_apply_array` 用 S5 栈槽当长度（`fromCodePoint.apply` 一万参 SIGSEGV）；linux 裸 int 下标 ≥ ptrFloor 被 `_js_prop_key` 当数据段串指针（`o[12345678]` SIGSEGV）；x64 `Number.isSafeInteger` 在 fcmp 后误用有符号 `jle`；x64 `_aref_invoke_cb4` 用 V1≡A3 当 scratch 冲掉 reduce 第四参；x64 for-of TypedArray 用 V0≡RET 覆盖 length 导致零迭代；x64 `_set_entries` 在 `_set_iterator_new` 后 `pop V0` 把迭代器冲成裸 Set；x64 for-of 协议路径 `lea V0,_exc_ctx_top` 冲掉 IteratorValue；x64 for-of `cptnOff` 只在数组快路初始化、break/continue 用 V0 读 close 槽；x64 eval 片段 DATA 标签按内容匹配 `_superinfo_*`。eval/`new Function` `class extends Uint8Array`：route-B 窄路径改为当场 `_ta_dynamic_ctor_ref` 再写 `[[Prototype]]`（不再迷信跨 pop 的 V2/superinfo 槽）；x64 上 `Object.getPrototypeOf(C)===Uint8Array` 且 `new C(4)` 已通。x64 V1≡A3：TA find 的 thisArg、reduce 的 hasInit 须在 MASK 装 V1 之前落入 callee-saved；x64 `store(RET,n,S5)` 经 RAX 中转会冲掉刚 `_alloc` 的 SetRecord；x64 `store(S5,n,V0/RET)` 同样经 RAX 中转，把 Map 节点 empty@32 写成节点指针，插入序链表被迭代器当墓碑跳过（size/get 仍走哈希桶）；x64 `_ta_is_oob` 用 V2≡A2 当 elemSize，RAB 视图 `fill` 的 start 收成 1；x64 `shrImm(V0,RET,48)` 把 species 构造器收成标签 0x7FFF，随后 `load [0x7FFF]` SIGSEGV。x64 后端 `scratchReg` 优先 R11、默认不借 RAX 中转 S5,消灭 `store(RET,n,S5)` / `store(S5,n,V0)` 这一类。V0 不能从 RAX 挪开(分配器同时占用 V0 与 V5 打包块头)。本轮继续:函数入口 A0-A5 快照须在任何 helper/`emitInstallAsyncExcFrame` 之前,ctx 池复用必须清 `_argRegSpill`;`_str_check_regexp` / `_str_getmethod` 之后 / `_emitSymDelegate` 不得用 V0 装 undefined/null 去 cmp 仍活的 RET(x64 V0≡RET,`"".includes(/./)` 恒 false、`@@split` 看起来不存在);哨兵进 V5。`emitRestParam`/`emitCtorRestParam` 必须 `_loadIncomingArg` 读 `_argRegSpill`,不得 `store` 活 A 寄存器(`String.raw({raw:["a","b"]},"X")` 变成 `a1e-323b`)。类构造器入口须 `emitArgRegSnapshot`：`emitCtorRestParam` 的 `_array_push` 会砸 A1，随后 `emitCtorArgumentsArray` 若 `store` 活 A1–A5，`constructor(...a)` 的 `arguments[0]` 变成 1.5e-323。函数 `...rest` 长度按 argc 收，不得在 JS_UNDEFINED 截断（`f(1, undefined, 2)` / `f.apply(null,[1,,2])` 长度为 3）;rest 收集循环的 undefined 哨兵同样用 V5/V6。boxed 路径补 `__isRegExp`;`_iterator_close`/`with` HasBinding/`_ta_slice`/`_proxy_ownkeys_validate` 不得 `shrImm/load V0` 再把 RET 当原值;`_object_rest` 的 MASK 不得放 V4≡A5 跨 call;TA set 同缓冲快照不得 `load V0` 冲掉刚 Get 的元素。`_box_arr_r`/`_box_obj_r` 是 RET-in:arm64 A0≡RET 掩盖 `load A0; call _box_*`,x64 A0=RDI 会把 leftover RAX 装箱(CreateDynamicFunction 参数列表变成元素地址,`new GeneratorFunction('a','b',body).length` 变成 0;identifier-delete / 未解析 typeof 在 eval shim 链入后 leftover 是毒指针,`delete p3` SIGSEGV)。装箱 globalThis 走 `_emitLoadBoxedGlobalThis`(load RET)。装箱后必须 `mov A0,RET` 再交给 `_object_define`(否则 `var o={}` 顶层镜像写 SIGSEGV)。类静态 initializer 的 globalThis 同样 load RET,不得 load V0(arm64 V0≢RET)。`/` `%` 与 unary minus 的 NaN 必须 canon 到 0x7ff0000000000001,不得留下硬件 qNaN 0x7ff8(与 boxed int 0 别名)。`_throw_unwind` 在 x64 上不得 `mov S5`(无 prologue,s5StackOffset 是编译期残值,切 FP 后会打穿 catcher 的 saved S0)。`emitBodyEvalVarSlots` / `emitParamEvalVarSlots` 不得 `movImm64(V0,undef); store(RET,0,V0)`(x64 V0≡RET 把盒指针冲成 undefined,写 0x7FFB 页故障)。`_object_set_proxy` 不得把陷阱入口放 V2 再 `mov A2,value`(x64 V2≡A2,callIndirect 跳到被赋值)。生成器 stub/FDI 探针帧不得继承外层 `_esPool`/`_esDepth`(hold 会盖 `__fdiarg_*`,async-gen 第 4 默认实参变成调用方 leftover);S0 跨 stub helper 走硬件 push。with 简单赋值在 HasBinding 之后须再 HasProperty 才 SetMutableBinding。`_str_re_scan_unicode` / `_str_re_scan_class` 仅 ARM64 发射(叶用真 S5 存区间;x64 S5 是栈槽)。x64 上 `call` 缺失标签会让 eval/`new Function` 产物启动即 SIGSEGV(RIP 在栈上)。P1/LSRA 不对 toolchain 源(compiler/engine/vm/…)和 runtime 生成器(runtime/core|types|async)录制:eval 产物要把整份编译器 AOT 进去,4 路并行会超官方 30s compile(RAB harness 的 `new Function` 子类)。用户函数非空体一律 beginRecord(T* + 线性扫描,不限 for/while;空块/async/生成器除外)。runtime/node 仍录。`obj[Symbol.xxx]=` 在 getMemberPropertyName 折成 `"Symbol.xxx"` 后必须 `_symbol_wellknown` 再 set(否则 concat Get @@isConcatSpreadable 看不见赋值)。`_str_charCodeAt` UTF-16 路径不得 `shrImm(V0,RET,48)`(V0≡RET 把一字串冲成标签,toPrecision 四舍五入失效)。`_emitThisToString` 从 wrapper `__value`/`__number_value`/`__boolean_value` 抽 tag 同样不得 `shrImm(V0,RET,48)`(`new String("hello").split/charAt` 变成空串)。一元 `-` 的 fneg 之后必须 `_nan_canon`(x64 会把 canonical NaN quiet 成 0x7ff8=INT 0)。`delete obj[Symbol.xxx]` 与 SET 一样要删真 well-known 符号再删 `"Symbol.xxx"` 别名。IsRegExp 必须先 Get @@match(getter 可抛),不得先用 `__isRegExp`/TYPE_REGEXP 短路成 TypeError。生成器 FDI stub 不得继承外层 `_argRegSpill`(默认值 `arguments[2]` 会读到脚本 leftover)。`String.fromCodePoint.apply` 不得只认静态 Type.ARRAY(对象属性取出的数组走通用 apply,x64 上 `_cp_to_str` 对非码点抛 Offset/length RangeError,property-escapes `buildString` 全族挂)。`RegExp.prototype.test` 不得走 `__RE_exec` 的整串 `__re_uniSlice`(property-escapes 四个 `\P{}` 别名各拷一遍百万码点补集,x64 SIGSEGV)。async 体入口须先 `emitArgRegSnapshot` 再 `emitInstallAsyncExcFrame`;后者不得 `load V2, coro.promise`(x64 V2≡A2,第三实参变成 Promise)。严格模式 `return` 尾位置 CallExpression（含 `?:`/`&&`/`||`/`??`/逗号右端、catch/finally 内 return）须 PrepareForTailCall：`epilogueKeep` 后 `jmpIndirect(S1)`，不得 `bl`/`call`（100k×16–32 KiB 帧会撑爆 8 MiB 栈；S0/S1 不能活过 epilogue，进 `_tco_env`/`_tco_fn`）。async/生成器体不 TCO。fixtures 522。x64 caller-saved 池不得含 A0–A5 别名(V7≡A1 等),arguments 收集须复用钉死的 `__argreg_*`(否则 mapfn/every 的 arguments[1] 成 1e-323)。P3.1 `analyzeRawFloatVars` 不得用嵌套函数(自托管 compileFragment 里 Function("var x;") 会 not a function)。二元/相等/位运算/逻辑/拼接/赋值/更新/成员写/成员读/模板累加器/调用实参/String·Array·TypedArray·Map·Set·Date·Math 方法暂存走 `_holdExpr` 池(录制期 T*,直发期 FP);with 绑定对象等长寿命槽仍用 FP。调用实参因 RET≡A0 必须先 hold 再装 A0-A4。运行时 tag 派发、通用方法 this、零参 toString/valueOf/toLocaleString 不再把接收者停在 SP。`members.js` 已无硬件 push/pop。`functions.js` 的 hasOwnProperty/parseInt/fromCharCode/assign/import/eval-reloc/super 实参同持。`statements.js`/`async.js` 的 throw/装箱/for-of/catch/计算键/方法形参/await/yield/FDI 同持。类 S0-S2 快照仍走硬件 push/pop(`_holdCalleeSaved3`):LSRA 见 RC_PUSH 才能保住跨嵌套 prologue 的 callee-saved。含 class 的用户函数在类降低前 flush 外层录制。`_esPool` 在 leaveScope 丢过期槽,复用时重绑或丢掉过期 T*。T* 只在仍在录制且 `_tempHomes` 有 home 时用。TA find/reduce 勿硬编码 S1/S2/S3。FFI C 约定实参走同一 hold 池。P3.1:非参数非装箱局部若恒持 raw float64,compileOperandAsFloat 的 Identifier 跳过恒等 coerce(`lang/analysis/rawfloat.js`)。macos-x64 官方 stride-5 在 `--jobs 4` 下 GATE PASS。Rosetta 与 docker/wine 同属模拟器,非 canonical 跑把 run timeout 抬到 60s(virtreg 后 generated `\p{}` 在 10s 下 CRASH timeout)。linux-x64 docker qemu 上 generated `\p{}` 整串扫描 virtreg 后约 120s，60s/120s 预算会 SIGKILL；跨架构 docker（`runner.qemu`）run timeout 抬到 180s 后 GATE PASS。x64 `new Date(y, …)` 的 NaN 判别不得 `shrImm(V0,RET,52)`（V0≡RET 把 1978 冲成指数 0，两位数年份落到 1900）。`Function.prototype.bind` 蹦床拷预绑定参不得 `add(reg, SP, reg)`（ARM64 上 SP 编码成 XZR，从地址 0 读 SIGSEGV；`Function.prototype.bind.call(f, {}, "a","b","c")`）。Proxy `[[Construct]]` 转发不得把 nested Proxy / eval 当 classinfo 读 props_ptr@32（trap 为 null/undefined 时 SIGSEGV）。数组/对象字面量 `__arr_temp_*`/`__obj_temp_*` 按嵌套深度复用（兄弟 `[a,b]`/`{}` 不得各占一槽）；`_main` 仍 8 KiB，property-escapes `ranges: [[…],…]` 或 `sort` 2048 个 `{…}` 会把槽写到 SP 之下。`_validate_callable` 对 TYPE_PROXY 须先 IsCallable(target)，`new Proxy({}, {})()` 否则 SIGBUS。`BigInt.prototype.valueOf` 对非对象 this 不得 MASK 后 `_object_get`（undefined/0 SIGSEGV）。正则 CPS 匹配器须 trampoline（`__re_bounce`）：用户函数帧 16–32 KiB，按重复次数/序列节点原生递归会在 S15.10.2_A1_T1 MarkupSPE 上撑爆 8 MiB 栈；简单原子贪心量词仍走迭代扫描。`parseAtom` 的 look 节点与 `\uNNNN`/`\xNN`（code>127）str 原子须逐步建对象，不得在大函数里用带 call/比较的对象字面量（`new RegExp("(?=a)")` / `"\\u00FF"` 会 `_object_set` A0=0 或 SIGSEGV）。`_objTmpSlots`/`_arrTmpSlots` 是按帧的 FP 偏移，compileFunction / compileFunctionBody / 池化 ctx 必须每函数清空，否则第二个 `{ get x(){} }` 复用上一函数的槽（`RegExp.prototype.flags` rethrow 七个回调 SIGSEGV）。生成器 `next`/`return`/`throw` 在 `CORO_STATUS_RUNNING` 须 TypeError（GeneratorValidate executing），不得对正在跑的同一 coro `_coroutine_resume`（`from-state-executing` SIGSEGV）。Get(WeakMap,"set")/Get(WeakSet,"add") 在 weakness@48 须走 WeakMap/WeakSet.prototype，不得 miss 成内建 `_map_set`（无限 iterator + 覆盖 set 抛错会 15s SIGKILL）。`leaveScope` 回滚 `stackOffset` 须丢掉 `_objTmpSlots`/`_arrTmpSlots`（与 `_esPool` 同口径）：对象字面量 temp 是按帧 FP 偏移，作用域退出后再 `allocLocal` 会把同一槽交给新局部/`_holdExpr`，`compileObjectExpression` 的 shape_ptr@48 若把 boxed 0x7FFD 当裸指针 `str [obj,#48]` 即 SIGSEGV（`Function()` / `compileFragment("(function(){})")` 返回 `{bytes,relocs,functionMeta}`）。shape 写入必须先 MASK 脱壳。`Function.prototype.call/apply` 缺 thisArg（argc=0 的 leftover A0 不是 undefined）以及显式 `null`/`undefined` 须 OrdinaryCallBindThis：非严格 → globalThis，严格保持原值。route-B 片段函数要登记 `_dynamic_fn_meta_add`（不只 generator/async），否则 `_ordinary_bind_this` 当未登记而留下 undefined。形参默认值里的直接 eval：`EvalDeclarationInstantiation` 从 param env（非箭头有 `arguments` 对象）走到 varEnv，`var arguments` 须 SyntaxError；不抛的话 `var arguments = 'param'` 会盖掉 arguments 对象 SIGSEGV。`compileMethodCall` 的 `_ordinary_bind_this` 须追加进 `SYM_NAMES`（append-only ABI），否则 eval 片段方法调用报「符号未在 SYM_IDS」。`static {}` 每块是独立 VariableEnvironment：外层同名 var 已有槽（且在 `preboxedVars`）时须 `allocLocal` 遮蔽并初始化新槽/新 box，不得把未初始化槽当 box 指针 `store`（`static-init-scope-var-open`/`close` TEXT SIGBUS）。`emitHoistedVarInits` 在 `_staticBlockVarEnv` 下对已有槽仍初始化，且不得复用 mainCaptured 外层 box。async generator `throw()` 在 RUNNING / +88 busy 时入队（kind=1），不得 `_coroutine_resume` 活帧；yield 排空队列时注入 `_exception_pending`，完成时 reject +88（可能是 throw 的 Promise 而非本次 next 的 S3）。fixtures 522。Wine 与 4 路 compile worker 同机时,worker 须 nice 10,否则 2s 的 PE 会墙钟超过 60s emulator floor。Wine run timeout 须按 PE 路径 SIGKILL(macOS 上 PE 不在 `wine` 的 process group,只 kill pgid 会留下 96% 空转,`close` 拖到数分钟;`yield/arguments-object-attributes` 曾 runMs=875s)。官方 `--jobs 4` 必须每 job 一个 WINEPREFIX:共享 `~/.wine` 时一只挂住的 PE 会堵 wineserver,把 `unary-minus` 这类 2s 测试也拖过 60s;独立前缀后 GATE PASS。

## 运行时契约（与代码同步的硬数字）

| 项 | 值 | 权威位置 |
|---|---|---|
| 初始堆虚存预留 | 28 GiB（规避 `_heap_grow` 非连续放弃旧段；非容量设计） | `runtime/core/allocator.js` `INITIAL_HEAP_SIZE` |
| 堆增长非连续 | 硬失败（不得覆写 `heap_base` 放弃旧段） | `runtime/core/allocator.js` `_heap_grow` |
| 对象用户头 | 56 B，`shape_ptr@48` | `runtime/core/types.js` `OBJECT_*` |
| 数组用户头 | 32 B，`data_ptr@24` | `runtime/core/types.js` `ARRAY_*` |
| `TYPE_PROXY` | 17（不得与 `TYPE_REGEXP=8` 撞车） | `runtime/core/types.js` |
| 调用 ABI | A0–A4 前五个实参，A5=`this`，溢出进 `_call_argv`（普通 cap 16） | `compiler/functions/functions.js` `compileCallArguments` |

## 文档角色

| 文件 | 角色 |
|---|---|
| 本文件 | 口径与硬数字 |
| `CHANGELOG.md` | 逐版沿革（可含历史 test262 百分比） |
| `README.md` / `README.zh-CN.md` / `website/` | 对外文案；数字必须与本文件一致 |
| `plan.md` | 执行蓝图，不复述动态数字 |
| `docs/ES_SUPPORT.md` | 语言面清单；头部基线过期时以本文件 + CHANGELOG 为准 |
| `docs/NODEJS_SUPPORT_ANALYSIS.md` | Node shim 审计；头部日期过期时以 `runtime/node/` 代码为准 |
| `BOOTSTRAP_RULES.md` | 自举不变量与 gen1-hostile 模式 |
