// P2/P1 片段编译 + 重定位 —— 把 JS 表达式编成**可执行代码缓冲**(PIC + 运行时符号
// 重定位),供 __engine_exec_raw / __engine_exec_reloc 进程内执行。route B 的
// "parse+compile→可重定位码"半。
//
//   P2 纯常量表达式(40+2 等):自足 PIC,__engine_exec_raw 直接执行。
//   P1 含运行时调用(1+x → _js_add、(2+3)*4 → _number_coerce):加 trampoline,
//      bl→trampoline(同页),addr_slot 由运行时用宿主符号地址填(__engine_exec_reloc)。
//
// 现该函数 build/node 侧跑;route B 终态编译器编入引擎库、运行时调它(P4)。

import { Compiler } from "../compiler/index.js";
import { VReg } from "../vm/index.js";
import { RUNTIME_STRINGS } from "../runtime/core/strings.js";
import { analyzeCapturedVariables } from "../lang/analysis/closure.js";

// 命名运行时字符串常量(label→值):`_str_comma_only`(join 默认分隔符)、
// `_str_length_prop`/`_str_object` 等由内建方法内联 `lea _str_<名>` 引用。片段不跑
// generateRuntime → 这些名从未被 registerRuntimeString 注册/驻留,故 `_str_<名>` 走
// 数字下标路径会 parseInt(名)=NaN→空串(如 `[1,2,3].join()` 分隔符变 "" → "123")。
// 在此按已知值内联(与运行时 raw NUL 结尾 C 串逐字节等价)。
const RUNTIME_STR_BY_LABEL = {};
for (const _k in RUNTIME_STRINGS) RUNTIME_STR_BY_LABEL[RUNTIME_STRINGS[_k].label] = RUNTIME_STRINGS[_k].value;
// 纯数字后缀判别(§1.6 禁正则:逐字符查 '0'..'9')。
function _strLabelIsNumeric(s) {
    if (s.length === 0) return false;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 48 || c > 57) return false; }
    return true;
}

// 符号名 → id。**必须与 runtime/core/allocator.js generateEngineSymaddr 的 syms 顺序一致**。
export const SYM_IDS = {
    _number_coerce: 0, _js_add: 1, _valueToStr: 2, _strconcat: 3,
    _object_get_ic: 4, _subscript_get: 5, _math_sqrt: 6,
    // 位运算(& | ^ << >> >>>)、布尔强制(三元/逻辑)、抽象关系比较(非静态 </>)、
    // 常用 Math。新增须与 allocator.js generateEngineSymaddr 同序追加。
    _js_band: 7, _js_bor: 8, _js_bxor: 9, _js_bshl: 10, _js_bshr: 11, _js_bushr: 12,
    _to_boolean: 13, _js_relcmp: 14,
    _math_abs: 15, _math_floor: 16, _math_ceil: 17, _math_round: 18, _math_pow: 19,
    // 宿主**可变**数据全局(共享堆指针):emitNumberCoerceFast 的堆装箱数值判别读
    // _heap_base/_heap_ptr 范围。不可内联快照(宿主分配会改),须运行时重定位到宿主地址。
    _heap_base: 20, _heap_ptr: 21,
    // 抽象相等(动态类型 ==)、数值→字符串(concat 内联数字渲染)。
    _abstract_eq: 22, _floatToString: 23,
    // 分配类:数组/对象字面量(走宿主共享堆,P5 已重定位 _heap_base/_heap_ptr)。
    _array_new_with_size: 24, _array_set: 25, _object_new_sized: 26, _object_define: 27,
    // 长度 / typeof / 装箱字符串 / 数组 join。
    _js_length: 28, _js_box_string: 29, _js_typeof: 30, _array_join: 31, _array_to_string: 32,
    // 常用字符串方法。
    _str_toUpperCase: 33, _str_toLowerCase: 34, _str_slice: 35, _str_indexOf: 36,
    _str_charCodeAt: 37, _str_split: 38, _str_trim: 39, _str_substring: 40,
    _str_repeat: 41, _str_includes: 42, _str_replace: 43,
    _js_unbox: 44, _array_length: 45, _getStrContent: 46, _typeof: 47, _to_int32: 48,
    // 对象属性读的 NO_IC 形态(片段专用):站点回填会写 RX 页(SIGBUS),故片段
    // 里 emitObjectGetIC 走 _object_get + _maybe_getter,无站点写回。见 members.js。
    _object_get: 49, _maybe_getter: 50,
    // 关系比较 < <= > >=(operators.js relHelper;经 _js_relcmp 包装,真运行时 label)。
    _js_lt: 51, _js_le: 52, _js_gt: 53, _js_ge: 54,
    // 更多 Math。
    _math_trunc: 55, _math_cbrt: 56,
    // 更多字符串方法。
    _str_padStart: 57, _str_padEnd: 58, _str_at: 59, _str_charAt: 60,
    _str_startsWith: 61, _str_endsWith: 62, _str_replaceAll: 63,
    // 更多数组方法(无闭包)。_array_push 亦为 Math.hypot 内部所用。
    _array_push: 64, _array_get: 65, _array_reverse: 66, _array_slice: 67,
    _array_includes: 68, _array_indexOf: 69, _array_at: 70, _array_flat: 71,
    // 对数/指数 Math(sin/cos/tan/atan2 编译器未接,非廉价,略)。
    _math_log: 72, _math_log2: 73, _math_log10: 74, _math_exp: 75,
    // 异常展开(split().join() 等含边界抛出路径引用);数值解析 / 转换。
    _throw_unwind: 76, _js_parseInt: 77, _js_parseFloat: 78, _str_to_num: 79,
    // Number.toString(radix) / toFixed;数组 sort 比较;字符串 lastIndexOf;instanceof。
    _is_bigint: 80, _num_toFixed: 81, _strcmp: 82, _str_lastIndexOf: 83, _instanceof: 84,
    // Number.toString(radix);数组 sort/元素写回 _subscript_set。
    _num_toString: 85, _subscript_set: 86,
    // 异常状态全局(HOST_DATA:含边界抛出路径的表达式如 split()/sort() 内联引用
    // adrp _exception_value/_pending;须重定位到宿主地址,与 eval 共享异常状态)。
    _exception_value: 87, _exception_pending: 88,
    // 闭包/回调类(P7:eval 内函数/箭头表达式)。_alloc 建闭包对象;_typed_array_new
    // 为 map/filter 的 TypedArray 分支(普通数组分支不取,但 bl 指令仍内联发射,故须登记)。
    _typed_array_new: 89, _alloc: 90,
    // 闭包调用/回调体内常见:_coroutine_create(闭包调用路径的 async 分支,内联发射)、
    // _strict_eq(=== 动态操作数,如 find(x=>x===2))、_syscall_arg(sort 比较器结果归一)。
    _coroutine_create: 91, _strict_eq: 92, _syscall_arg: 93,
    // 直接闭包调用(IIFE)的 async 分支(dead 但内联发射):建 Promise + 入调度。
    _promise_new: 94, _scheduler_spawn: 95,
    // 闭包捕获外层 eval 局部(如 var k; [..].map(x=>x+k)):捕获变量装箱共享 box。
    // _print_str:捕获 box 的 TDZ 未初始化读错误路径(dead 但内联发射)。
    _box_alloc: 96, _print_str: 97,
    // try/catch 异常上下文链头全局(HOST_DATA:try-enter 压帧/正常退出弹帧读写它,
    // 须重定位到宿主地址,与宿主异常状态共享);for-of 迭代字符串用 _str_codepoint_at。
    _exc_ctx_top: 98, _str_codepoint_at: 99,
    // throw new Error(建 Error 对象):_object_new/_object_set;for-of 迭代器路径的
    // 字符串/Map 分支(数组 for-of 不取,但 bl 指令内联发射):_str_cp_bytes/_map_entries。
    _object_new: 100, _object_set: 101, _str_cp_bytes: 102, _map_entries: 103,
    // 属性键装箱 tag helper(A1 |= STRING_TAG,3 条指令):成员写 `o.k=v`(emitBoxedStringKey
    // 的 _object_set 前)发 `bl _tag_key_a1`;方法调用 `a.push()`(键 box→helper)发
    // `bl _tag_str_a1`。片段捕获对象/数组经成员写/方法变异必经此二者。经蹦床跳宿主 helper
    // (仅碰 A1/V0/V1/LR,无栈,ret 回原调用点),与所有其它符号同法。
    _tag_str_a1: 104, _tag_key_a1: 105,
    // 动态方法调用可调用性校验(`a.push()`/`o.f()` 取属性后 `bl _validate_callable`;
    // 非函数则抛)。片段捕获数组/对象经方法变异必经。
    _validate_callable: 106,
    // 数组变异簇(捕获数组经方法变异:pop/shift/unshift/splice/concat)。均为 array/index.js
    // 恒发射的 live 实现(_array_fill 仅在死 mutate.js,故不登记)。
    _array_pop: 107, _array_shift: 108, _array_unshift: 109, _array_splice: 110,
    _array_concat: 111,
    // 数组结果装箱(map/filter/slice 等返新数组:RET=(RET&PAYLOAD)|ARRAY_TAG)。
    // eval 内数组方法闭包(`[1,2].map(v=>v+1)`)收尾装箱新数组。
    _box_arr_r: 112,
};

// 宿主可变数据全局:引用它们须运行时取宿主地址(不可内联常量)。见 compileFragment
// 的 adrp→ldr-literal 改写。与常量单例(_js_true 等,内联同位型)相对。
export const HOST_DATA = { _heap_base: 1, _heap_ptr: 1, _exception_value: 1, _exception_pending: 1, _exc_ctx_top: 1 };

// captureLayout 串解析:`name:off[:b],name:off[:b],...`(off 为调用者帧内 FP 偏移,负整数)。
// 直接 eval 的词法作用域捕获:compileCallExpression 在直接 `eval(x)` 调用点把外层函数的
// 局部名→槽偏移序列化成此串,随调用者 FP 一并传入。空串/undefined → 无捕获(间接 eval 语义)。
// 尾随 `:b` 表示调用者槽已是 **box 指针**(该函数含 eval 帧模型升级,或该名被真闭包捕获):
// copy-in 复用同一 box、copy-out 免回灌(逃逸闭包/调用者后续写经共享 box 联动)。
// §1.6 无正则:split 由 String.split 提供(编译器自身可用)。
function parseCaptureLayout(s) {
    const out = [];
    if (!s || s.length === 0) return out;
    const parts = s.split(",");
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (!p || p.length === 0) continue;
        const ci = p.indexOf(":");
        if (ci < 0) continue;
        const name = p.slice(0, ci);
        const rest = p.slice(ci + 1);
        // rest 形如 "off" 或 "off:b"
        let callerBoxed = false;
        let offStr = rest;
        const ci2 = rest.indexOf(":");
        if (ci2 >= 0) {
            offStr = rest.slice(0, ci2);
            callerBoxed = rest.slice(ci2 + 1) === "b";
        }
        const off = parseInt(offStr, 10);
        if (name.length === 0) continue;
        out.push({ name: name, off: off, callerBoxed: callerBoxed });
    }
    return out;
}

// 直接 eval 词法捕获里,哪些 copy-in 名被"片段内创建的闭包"捕获?这些名的写入若只
// 落闭包私有 box(值快照)就永不回灌调用者槽 —— 必须与普通编译器 rebox-on-capture 同构:
// copy-in 时把调用者值装进堆 box、片段槽存 box 指针、标记 boxedVars,使片段内闭包共享
// **同一** box(compileFunctionExpression 的 outerBoxedVars 分支),写入经 box、copy-out
// 读 box 回灌。返回 { name: true }。capNamesObj 为全部 copy-in 名集合(充当外层作用域)。
function capturesBoxedByInnerClosure(body, capNamesObj) {
    const out = {};
    function visit(node) {
        if (!node || typeof node !== "object") return;
        const t = node.type;
        if (t === "FunctionExpression" || t === "ArrowFunctionExpression" || t === "FunctionDeclaration") {
            // analyzeCapturedVariables 内部已递归处理更深嵌套 → 命中即收集后不再下潜。
            const cap = analyzeCapturedVariables(node, capNamesObj, null);
            for (let i = 0; i < cap.length; i++) out[cap[i]] = true;
            return;
        }
        for (const key in node) {
            if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
            const child = node[key];
            if (child && typeof child === "object") {
                if (Array.isArray(child)) {
                    for (let i = 0; i < child.length; i++) visit(child[i]);
                } else visit(child);
            }
        }
    }
    for (let i = 0; i < body.length; i++) visit(body[i]);
    return out;
}

// compileFragment(source[, target[, captureLayout]]) -> { bytes, relocs }
//   bytes: 位置无关代码 + trampolines + .data(多页至 256KB)。
//   relocs: [{slotOffset, symId}] —— 运行时填 addr_slot;空数组即纯常量(可用 exec_raw)。
//   captureLayout: 直接 eval 词法捕获串(见 parseCaptureLayout);传入时片段以 A0=调用者 FP
//     执行,入口 copy-in 调用者槽 → 片段局部,出口 copy-out 片段局部 → 调用者槽(读写捕获)。
export function compileFragment(source, target, captureLayout) {
    const c = new Compiler(target || "macos-arm64");
    const captures = parseCaptureLayout(captureLayout);
    const ast = c.parse(source);
    if (!ast.body || ast.body.length < 1) {
        throw new Error("engine: 空片段:" + source);
    }
    // 语句序列(indirect-eval 风格,自足作用域):逐句 compileStatement,var/let/const
    // 绑定从同一 FRAG_FRAME 局部池 allocLocal 取槽;末句(通常 ExpressionStatement)的值
    // 留在 RET 即片段结果(compileStatement→ExpressionStatement→compileExpression 恒落 RET)。
    // 不捕获外层调用者变量(那是独立里程碑)。含闭包体的语句(函数声明/逃逸箭头)由下方
    // pending-function 检测拦截报错——arrow 体经 generatePendingFunctions 在片段外发射,
    // 现模型(单段码+SYM_IDS 蹦床)容不下。
    // 架构:arm64 用 asm.pendingFixups(adrp/bl);x64 用 asm.fixups(rip32/rel32)。
    const isX64 = c.arch === "x64";
    const fixupArr = isX64 ? c.asm.fixups : c.asm.pendingFixups;
    const cs = c.asm.code.length;
    const fs = fixupArr.length;
    // 帧内局部槽:对象/数组字面量把临时指针(objTemp/arrOff 等)存 FP-负偏移
    // (allocLocal:FP-CALLEE_SAVED_AREA(48)-8k)。旧代码 prologue(0) 时 SP==FP,
    // 这些槽落在 SP 之下 → 每次 bl(_object_define/_array_push...) 被 callee 自身
    // 栈帧覆盖,回读得垃圾对象指针 → 属性 miss / 野指针崩。故必须为局部预留栈,
    // 且 epilogue 同额释放(仅 prologue 加大而 epilogue 留 0 会使返回时 SP 失衡崩,
    // 是"prologue(1024) 破坏全部执行"的真因)。多页片段解锁后,局部槽(而非码尺寸)成为
    // 瓶颈——深链式方法(每个 map/filter 用多个临时槽)易超 1024。放宽到 8192B(1024 槽,
    // 与普通函数体 prologue 同额),片段跑在宿主大栈上无压力;编译后按实际 stackOffset 越界报错。
    const FRAG_FRAME = 8192;
    // 片段页运行时 mprotect 成 RX(只读+可执行):属性读站点缓存的慢路会把命中
    // 下标回填到站点槽(在片段页内)→ 写只读页 SIGBUS。故片段禁 IC,emitObjectGetIC
    // 改走 _object_get + _maybe_getter(无站点写回)。
    c.engineNoIC = true;
    c.vm.prologue(FRAG_FRAME, []);
    // `return X`(new Function 体常见)由 compileReturnStatement 把值置 RET 再 jmp
    // ctx.returnLabel。片段里把 returnLabel 设成 epilogue 前的汇合点 _frag_return,使
    // return 提前跳出并保留 RET,与正常 fall-through 完成值共用同一出口。
    const fragReturnLabel = "_frag_return";
    c.ctx.returnLabel = fragReturnLabel;

    // ── 直接 eval 词法捕获:copy-in ──────────────────────────────────────────
    // 片段以 A0 = 调用者(直接 eval 所在函数)运行时 FP 执行(见 _engine_reloc_exec_fp)。
    // 把 A0 存入片段局部槽 __evalCallerFP,再为每个捕获变量分配片段局部槽并从
    // [callerFP + off] 拷入(off 为调用者帧内 FP 偏移,负)。之后 c.compileStatement 对这些名
    // 的读写天然解析到片段局部槽(seed c.ctx.locals),出口再 copy-out 写回调用者槽。
    // 这是 copy-in/copy-out 模型:对"直接 eval 读写外层局部后返回"精确匹配 node;不覆盖
    // eval 内创建、逃逸并在 eval 返回后仍改写捕获变量的闭包(边界,见 README follow-up)。
    // 未装箱局部(未被真闭包捕获)才纳入:调用点已滤掉 boxed/优化驻留变量。
    let capSlots = null;
    if (captures.length > 0) {
        // 哪些捕获名被片段内闭包捕获 → 须装箱(rebox-on-capture),否则闭包对捕获变量的
        // 写入落私有 box 快照、永不回灌调用者槽(本里程碑:eval 内非逃逸闭包写回捕获标量)。
        const capNamesObj = {};
        for (let i = 0; i < captures.length; i++) capNamesObj[captures[i].name] = true;
        const boxedByClosure = capturesBoxedByInnerClosure(ast.body, capNamesObj);
        let anyBoxed = false;
        for (const _k in boxedByClosure) { anyBoxed = true; break; }
        // 调用者槽已是 box(`:b`)也须建 boxedVars,片段内对该名读写走 deref。
        for (let i = 0; i < captures.length; i++) { if (captures[i].callerBoxed) { anyBoxed = true; break; } }
        if (anyBoxed && !c.ctx.boxedVars) c.ctx.boxedVars = new Set();

        const fpSlot = c.ctx.allocLocal("__evalCallerFP");
        c.vm.store(VReg.FP, fpSlot, VReg.A0); // 存调用者 FP(A0 由 callIndirect 传入,prologue 不碰)
        capSlots = [];
        for (let i = 0; i < captures.length; i++) {
            const nm = captures[i].name, off = captures[i].off;
            const slot = c.ctx.allocLocal(nm); // seed c.ctx.locals[nm] = 片段局部槽
            const callerBoxed = captures[i].callerBoxed === true;
            // callerBoxed:调用者槽已是 box 指针 → 片段复用同一 box(不新建),
            // copy-out 免回灌(写已直接落共享 box)。否则按片段内闭包捕获判是否新建 box。
            const boxed = callerBoxed || (boxedByClosure[nm] === true);
            capSlots.push({ off: off, slot: slot, boxed: boxed, shared: callerBoxed });
            if (callerBoxed) {
                // 复用调用者 box:直接把调用者槽内的 box 指针拷入片段槽,标 boxedVars。
                c.vm.load(VReg.V1, VReg.FP, fpSlot); // callerFP
                c.vm.load(VReg.V0, VReg.V1, off);    // caller 槽 = box 指针
                c.vm.store(VReg.FP, slot, VReg.V0);  // 片段槽 = 同一 box 指针
                c.ctx.boxedVars.add(nm);
            } else if (boxed) {
                // 装箱 copy-in:box[0] = 调用者槽值;片段槽存 box 指针;标记 boxedVars 使片段内
                // 对该名的读/写走 deref、闭包创建时共享同一 box(见 compileFunctionExpression)。
                c.vm.load(VReg.V1, VReg.FP, fpSlot); // callerFP
                c.vm.load(VReg.V0, VReg.V1, off);    // caller value
                c.vm.push(VReg.V0);                  // 保活于栈(GC 保守扫根),躲过 _box_alloc 分配 GC
                c.vm.call("_box_alloc");             // RET = box 指针(clobbers V0..V2)
                c.vm.pop(VReg.V1);                    // value
                c.vm.store(VReg.RET, 0, VReg.V1);    // box[0] = value
                c.vm.store(VReg.FP, slot, VReg.RET); // 片段槽 = box 指针
                c.ctx.boxedVars.add(nm);
            } else {
                c.vm.load(VReg.V1, VReg.FP, fpSlot); // V1 = callerFP
                c.vm.load(VReg.V0, VReg.V1, off);    // V0 = 调用者槽值
                c.vm.store(VReg.FP, slot, VReg.V0);  // 片段槽 = 值
            }
        }
        c.ctx._evalFpSlot = fpSlot;
    }

    const body = ast.body;
    // 函数声明提升(hoisting):先编译所有顶层 FunctionDeclaration(各自 allocLocal 名字槽
    // + 存闭包),使前向调用 `foo(); function foo(){}` 在 foo() 处已可解析。再按源码序编其余
    // 语句。函数声明无完成值,故末值取"最后一条非函数声明语句"。
    for (let i = 0; i < body.length; i++) {
        if (body[i].type === "FunctionDeclaration") c.compileStatement(body[i]);
    }
    let lastStmt = null;
    for (let i = 0; i < body.length; i++) {
        if (body[i].type === "FunctionDeclaration") continue;
        c.compileStatement(body[i]);
        lastStmt = body[i];
    }
    if (lastStmt === null) lastStmt = body[body.length - 1]; // 全是函数声明 → 完成值 undefined
    // ES 完成值(eval 语义):表达式语句/含表达式的控制流(if/try/switch/循环/块)以
    // "最后求值的表达式"为完成值——asm.js codegen 恒把它留在 RET,故只需**不**覆盖。
    // 仅"无值"末句(声明/空/break/continue)完成值为 undefined,须显式置。
    // (new Function 不经此路径:__eval_shim 把它包装成 `(function(){...})` 表达式片段,
    //  片段求值即真闭包,函数语义/形参绑定全由正常 compileFunctionBody 处理。)
    const NO_VALUE_STMT = {
        VariableDeclaration: 1, FunctionDeclaration: 1, ClassDeclaration: 1,
        EmptyStatement: 1, ImportDeclaration: 1, ImportLibDeclaration: 1,
        BreakStatement: 1, ContinueStatement: 1,
    };
    if (NO_VALUE_STMT[lastStmt.type] === 1) {
        c.vm.lea(VReg.RET, "_js_undefined");
        c.vm.load(VReg.RET, VReg.RET, 0);
    }
    // return 汇合点:提前 return 跳来(RET 已由 compileReturnStatement 置好),
    // fall-through 也落此(RET = 末句值 / undefined)。
    c.vm.label(fragReturnLabel);
    // ── 直接 eval 词法捕获:copy-out ─────────────────────────────────────────
    // 片段完成值已在 RET(fall-through 或 return 汇合于此)。把各捕获片段局部写回调用者槽,
    // 全程用 V0/V1/V3 暂存,V3 保住 RET(完成值)不被覆盖。fpSlot 恒在栈上有效。
    if (capSlots !== null) {
        const fpSlot = c.ctx._evalFpSlot;
        c.vm.mov(VReg.V3, VReg.RET); // 保存完成值
        for (let i = 0; i < capSlots.length; i++) {
            // shared(callerBoxed):调用者槽已是**同一** box 指针,写入 eval 期已直接落该 box,
            // 调用者槽本身不变 → 免回灌(若误回灌 deref 值会覆盖调用者槽的 box 指针 → 毁帧)。
            if (capSlots[i].shared) continue;
            const off = capSlots[i].off, slot = capSlots[i].slot;
            c.vm.load(VReg.V1, VReg.FP, fpSlot); // callerFP
            c.vm.load(VReg.V0, VReg.FP, slot);   // 片段槽(boxed=box 指针 / plain=值)
            if (capSlots[i].boxed) c.vm.load(VReg.V0, VReg.V0, 0); // deref box → 当前值
            c.vm.store(VReg.V1, off, VReg.V0);   // 写回调用者槽
        }
        c.vm.mov(VReg.RET, VReg.V3); // 恢复完成值
    }
    if (c.ctx && (c.ctx.stackOffset + 48) > FRAG_FRAME) {
        throw new Error("engine: 片段局部槽超出预留帧(" + (c.ctx.stackOffset + 48) + ">" + FRAG_FRAME + "):" + source);
    }
    c.vm.epilogue([], FRAG_FRAME);

    // [P7] 函数/箭头表达式:闭包对象靠 `lea _fn_N` 存函数指针,函数体经 pendingFunctions
    // 由 generatePendingFunctions 离线发射(在 epilogue 之后)。在此(切片之前)把它们发射进
    // **同一片段缓冲**——函数体码追加到 c.asm.code(仍在 [cs,末] 区间 → 被切片纳入),其内
    // bl/adrp/局部分支 fixup 也在 fixupArr 内 → 与主码同样走 trampoline/DATA/局部分支回填;
    // `lea _fn_N`(code-label DATA 引用)在下方 DATA 循环解析为片段内偏移(见 code-label 分支)。
    // 全片段须 <4096B(arm64 ADRP 同页):map+闭包+箭头体较大,超限即报错回落。
    if (c.pendingFunctions && c.pendingFunctions.length > 0) {
        c.generatePendingFunctions();
    }

    const code = c.asm.code.slice(cs);
    const fixups = fixupArr.slice(fs);
    // 注:用索引循环而非 for-of。Array.from(asm.data) 的结果在自编译产物里 for-of 会崩
    // (asm.js Array.from+for-of 交互 bug,follow-up);索引遍历规避。
    const strings = c.asm.strings || [];
    const dataLabels = c.asm.dataLabels || [];
    const dataLabelOff = {};
    let data;
    if (isX64) {
        // x64:.data 编译期为空,浮点/常量存于 dataLabels 异构条目
        // ({type:"label"|"byte"|"qword"|"float64"}),offset 在 fixupAll 才物化。
        // 复刻其物化:label→当前长度,byte/qword/float64→推小端字节。
        const ds = [];
        for (let i = 0; i < dataLabels.length; i++) {
            const it = dataLabels[i];
            if (it.type === "label") dataLabelOff[it.name] = ds.length;
            else if (it.type === "byte") ds.push(it.value & 0xff);
            else if (it.type === "qword") { let v = BigInt(it.value); for (let j = 0; j < 8; j++) { ds.push(Number(v & 0xffn)); v = v >> 8n; } }
            else if (it.type === "float64") { let b = it.bits; for (let j = 0; j < 8; j++) { ds.push(Number(b & 0xffn)); b = b >> 8n; } }
        }
        data = ds;
    } else {
        // arm64:.data 已含字节,dataLabels 直接带 {name, offset}。
        data = c.asm.data || [];
        for (let i = 0; i < dataLabels.length; i++) dataLabelOff[dataLabels[i].name] = dataLabels[i].offset;
    }

    const buf = code.slice();
    const relocs = [];
    const w32 = (off, v) => {
        buf[off] = v & 0xff; buf[off + 1] = (v >>> 8) & 0xff;
        buf[off + 2] = (v >>> 16) & 0xff; buf[off + 3] = (v >>> 24) & 0xff;
    };
    // fixup 类型名按架构:CALL(运行时符号)/DATA(.data/字符串引用)。
    // 用 `key in obj` 判存在(asm.js 自编产物 obj[miss]≠undefined、hasOwnProperty 返坏布尔)。
    const CALL = isX64 ? "rel32" : "bl";
    const DATA = isX64 ? "rip32" : "adrp";
    // 片段内局部分支类型(intra-fragment,目标 label 在本片段代码内,offset >= cs)。
    // arm64:b/bcond/cbz/cbnz 独立类型;x64:jmp/jcc 与 call 共用 rel32,靠"label 非
    // SYM_IDS 且是本地已定义 label"辨别(见下)。这些分支 fixupAll 才解析,片段切片绕过了它,
    // 故须在此按 label→offset(c.asm.labels)自行回填 PC 相对位移。
    // label→代码偏移(绝对,c.asm.code 内)。两架构 resolveLabel 契约不同:
    //   arm64:resolveLabel(l) 返回 label **名**,再 labels.get(name) 取 offset。
    //   x64:  resolveLabel(l) 直接返回数值 offset(跟随字符串别名链),未定义返回 undefined。
    const labelCodeOff = (l) => {
        if (!c.asm.labels) return undefined;
        if (isX64) {
            const v = c.asm.resolveLabel ? c.asm.resolveLabel(l) : c.asm.labels.get(l);
            return typeof v === "number" ? v : undefined;
        }
        const rl = c.asm.resolveLabel ? c.asm.resolveLabel(l) : l;
        return c.asm.labels.get(rl);
    };
    // 宿主数据单例(_js_true 等):位型恒定,直接在片段 .data 内联同位型副本(返回值即该
    // 位型,布尔/undefined 按位比较,内联拷贝与宿主单例等价)——复用 .data 引用回填路径,
    // 无需新增运行时数据重定位。
    const SINGLETON = {
        _js_true: 0x7ff9000000000001n, _js_false: 0x7ff9000000000000n,
        _js_null: 0x7ffa000000000000n, _js_undefined: 0x7ffb000000000000n,
    };
    // 某 CALL fixup 是否真为运行时符号调用(x64 下 rel32 也用于本地跳转,须排除)。
    const isRuntimeCall = (fx) => fx.type === CALL &&
        (fx.label in SYM_IDS || !(isX64 && labelCodeOff(fx.label) !== undefined));
    // 某 fixup 是否为片段内局部分支。
    const isLocalBranch = (fx) => {
        if (!isX64) return fx.type === "b" || fx.type === "bcond" || fx.type === "cbz" || fx.type === "cbnz";
        return fx.type === "rel32" && !(fx.label in SYM_IDS) && labelCodeOff(fx.label) !== undefined;
    };

    // ── 运行时符号 trampoline + 改写 CALL(bl/rel32)──
    const trampFor = {};
    for (let fi = 0; fi < fixups.length; fi++) {
        const fx = fixups[fi];
        if (fx.type === DATA) continue;
        if (isLocalBranch(fx)) continue; // 局部分支下方单独回填
        if (!isRuntimeCall(fx)) throw new Error("engine: 未支持的 fixup 类型 " + fx.type + "(label " + fx.label + ")");
        if (!(fx.label in SYM_IDS)) throw new Error("engine: 符号未在 SYM_IDS:" + fx.label);
        const symId = SYM_IDS[fx.label];
        if (!(symId in trampFor)) {
            while (buf.length & 7) buf.push(0);
            const tOff = buf.length;
            if (isX64) {
                // mov rax,[rip+2](48 8B 05 02 00 00 00);jmp rax(FF E0);slot(8B)
                const t = [0x48, 0x8b, 0x05, 0x02, 0x00, 0x00, 0x00, 0xff, 0xe0];
                for (let k = 0; k < t.length; k++) buf.push(t[k]);
                for (let k = 0; k < 8; k++) buf.push(0);
                relocs.push({ slotOffset: tOff + 9, symId });
            } else {
                for (let k = 0; k < 16; k++) buf.push(0);
                w32(tOff, 0x58000050);     // ldr x16, #8
                w32(tOff + 4, 0xd61f0200); // br x16
                relocs.push({ slotOffset: tOff + 8, symId });
            }
            trampFor[symId] = tOff;
        }
        const tOff = trampFor[symId];
        const callOff = fx.offset - cs;
        if (isX64) {
            // rel32(call E8 后 disp @callOff):disp = tOff - (callOff + 4)
            w32(callOff, (tOff - (callOff + 4)) | 0);
        } else {
            const imm26 = ((tOff - callOff) >> 2) & 0x3ffffff;
            w32(callOff, (0x94000000 | imm26) >>> 0);
        }
    }

    // ── 片段内局部分支回填(目标 label 在代码区,不受 trampoline/data 追加影响)──
    for (let fi = 0; fi < fixups.length; fi++) {
        const fx = fixups[fi];
        if (!isLocalBranch(fx)) continue;
        const tgtAbs = labelCodeOff(fx.label);
        if (tgtAbs === undefined) throw new Error("engine: 局部分支未知 label:" + fx.label);
        const tgtBuf = tgtAbs - cs;   // 目标在缓冲内偏移
        const brBuf = fx.offset - cs; // 分支指令在缓冲内偏移
        if (isX64) {
            // jmp/jcc rel32 的 disp32 @brBuf:disp = tgtBuf - (brBuf + 4)
            w32(brBuf, (tgtBuf - (brBuf + 4)) | 0);
        } else {
            const rel4 = (tgtBuf - brBuf) >> 2; // PC 相对,单位 4 字节
            if (fx.type === "b") {
                w32(brBuf, (0x14000000 | (rel4 & 0x3ffffff)) >>> 0);
            } else if (fx.type === "bcond") {
                w32(brBuf, (0x54000000 | ((rel4 & 0x7ffff) << 5) | (fx.cond & 0xf)) >>> 0);
            } else { // cbz/cbnz:rt 保留在占位指令低 5 位
                const rt = buf[brBuf] & 31;
                const op = fx.type === "cbz" ? 0xb4000000 : 0xb5000000;
                w32(brBuf, (op | ((rel4 & 0x7ffff) << 5) | rt) >>> 0);
            }
        }
    }

    // ── .data 常量 + 字符串字面量并置,改写 DATA 引用(adrp/add | rip32)──
    while (buf.length & 7) buf.push(0);
    const dataOff = buf.length;
    for (let i = 0; i < data.length; i++) buf.push(data[i]);
    const strBufOff = {};
    const singletonBufOff = {};
    for (let fi = 0; fi < fixups.length; fi++) {
        const fx = fixups[fi];
        if (fx.type !== DATA) continue;
        // 宿主可变数据全局(共享堆指针):不能内联(宿主分配会改),须运行时取宿主地址。
        // arm64:把 `adrp Xd,_heap_base; add Xd,Xd,:lo12` 改写成 `ldr Xd,[pc+slot]; nop`,
        // slot 由 _engine_reloc_exec 填宿主 &_heap_base(symaddr 的 lea);后续代码 `ldr Xd,[Xd]`
        // 即读宿主堆指针值(共享同一堆)。x64 暂不支持(follow-up),明确报错。
        if (fx.label in HOST_DATA) {
            const off = fx.offset - cs;
            while (buf.length & 7) buf.push(0);
            const slot = buf.length;
            for (let k = 0; k < 8; k++) buf.push(0);
            relocs.push({ slotOffset: slot, symId: SYM_IDS[fx.label] });
            if (isX64) {
                // x64:`lea r64,[rip+disp32]`(48 8D ModRM disp32,fixup.offset=disp32 处)改写成
                // `mov r64,[rip+slot]`(opcode 0x8D→0x8B,ModRM/REX 不变;disp 指向运行时填宿主
                // 地址的 8B 槽)。后续原有 `mov r64,[r64]` 即读宿主堆指针值——与 arm64 ldr-literal
                // 同义。disp = slot − (off+4)(rip 相对下条指令,base 无关)。
                buf[off - 2] = 0x8b;
                w32(off, (slot - (off + 4)) | 0);
            } else {
                // arm64:`adrp Xd,_heap_base; add Xd,Xd,:lo12` 改写成 `ldr Xd,[pc+slot]; nop`。
                const rd = (fx.rd != null ? fx.rd : (buf[off] & 31)) & 31;
                const imm19 = ((slot - off) >> 2) & 0x7ffff;
                w32(off, (0x58000000 | (imm19 << 5) | rd) >>> 0); // ldr Xrd, #(slot-off)
                w32(off + 4, 0xd503201f);                          // nop(原 add 位置)
            }
            continue;
        }
        let addr;
        if (fx.label in dataLabelOff) {
            addr = dataOff + dataLabelOff[fx.label];
        } else if (fx.label in SINGLETON) {
            // 宿主数据单例:内联 8 字节同位型(8 对齐,供 ldr 64 位)。
            if (!(fx.label in singletonBufOff)) {
                while (buf.length & 7) buf.push(0);
                const so = buf.length;
                let v = SINGLETON[fx.label];
                for (let k = 0; k < 8; k++) { buf.push(Number(v & 0xffn)); v = v >> 8n; }
                singletonBufOff[fx.label] = so;
            }
            addr = singletonBufOff[fx.label];
        } else if (fx.label.slice(0, 5) === "_str_") {
            if (!(fx.label in strBufOff)) {
                const suffix = fx.label.slice(5);
                let content;
                if (_strLabelIsNumeric(suffix)) {
                    // `_str_<N>`:表达式字面量,driven from asm.strings 驻留表。
                    content = strings[parseInt(suffix, 10)] || "";
                } else if (fx.label in RUNTIME_STR_BY_LABEL) {
                    // `_str_<名>`:命名运行时字符串常量(内建方法内联引用),按已知值内联。
                    content = RUNTIME_STR_BY_LABEL[fx.label];
                } else {
                    throw new Error("engine: 未知运行时字符串常量:" + fx.label);
                }
                const so = buf.length;
                for (let k = 0; k < content.length; k++) buf.push(content.charCodeAt(k) & 0xff);
                buf.push(0);
                strBufOff[fx.label] = so;
            }
            addr = strBufOff[fx.label];
        } else if (labelCodeOff(fx.label) !== undefined && labelCodeOff(fx.label) >= cs) {
            // [P7] code-label lea:闭包对象存函数指针(`lea reg, _fn_N`),目标是本片段内
            // 离线发射的函数体(generatePendingFunctions 已把它追加进 c.asm.code)。解析为
            // 片段缓冲内偏移(绝对 offset - cs),与数据引用同法回填 ADRP(imm=0 同页)+ADD 页内偏移。
            // 运行时 adrp 取片段页基址 + add 偏移 = 函数体运行时地址,闭包 callIndirect(blr)可跳入。
            addr = labelCodeOff(fx.label) - cs;
        } else {
            throw new Error("engine: 未知 " + DATA + " 标签(非 .data/非 _str_/非片段内 code label):" + fx.label);
        }
        const off = fx.offset - cs;
        if (isX64) {
            // rip32(lea/mov [rip+disp32] 的 disp @off):disp = addr - (off + 4)
            w32(off, (addr - (off + 4)) | 0);
        } else {
            // arm64 leaRipRel:ADRP + ADD 取 target 运行时地址。
            // ADD(off+4)imm12 = target 页内偏移(addr & 0xfff)。
            // ADRP(off)imm21 = target 页 − ADRP 指令页。缓冲随页对齐 mmap 加载,故页差
            // 完全由缓冲内偏移决定:pageDelta = (addr>>12) − (off>>12)——**多页片段跨页 PIC**
            // 的关键(同页时 pageDelta=0,退化回原"imm=0 同页"行为,逐位不变)。imm21 有符号
            // 21 位(±4GB),远超片段尺寸。immlo=bit[30:29],immhi=bit[23:5]。
            const rd = fx.rd || 0;
            w32(off + 4, (0x91000000 | ((addr & 0xfff) << 10) | (rd << 5) | rd) >>> 0);
            const pageDelta = (addr >> 12) - (off >> 12);
            const immlo = pageDelta & 0x3;
            const immhi = (pageDelta >> 2) & 0x7ffff;
            w32(off, (0x90000000 | (immlo << 29) | (immhi << 5) | rd) >>> 0);
        }
    }

    // 多页片段(arm64):ADRP 页差已按缓冲偏移编码(见上),故不再强制 <4096。但 trampoline/
    // HOST_DATA 的 ldr-literal 与 bcond/cbz 局部分支用 19 位 PC 相对 imm(±1MB),故设 256KB
    // 安全上限(远超实际 eval 片段;超限抛清晰错误)。x64 无此限(rip32 ±2GB)。
    if (!isX64 && buf.length > 262144) throw new Error("engine: arm64 片段 >256KB 未支持(19 位 PC 相对上限):" + source);
    return { bytes: buf, relocs };
}

// relocs → 字节缓冲(每条 8B:slotOffset 4B LE + symId 4B LE),供 __engine_exec_reloc。
export function relocsToBytes(relocs) {
    // 注:单参数 push——asm.js 自编译产物里 `arr.push(a,b,c,d)` 多参数只 push 第一个
    // (ES bug,follow-up)。故逐字节 push。
    const out = [];
    for (let i = 0; i < relocs.length; i++) {
        const r = relocs[i];
        const s = r.slotOffset, y = r.symId;
        out.push(s & 0xff); out.push((s >>> 8) & 0xff); out.push((s >>> 16) & 0xff); out.push((s >>> 24) & 0xff);
        out.push(y & 0xff); out.push((y >>> 8) & 0xff); out.push((y >>> 16) & 0xff); out.push((y >>> 24) & 0xff);
    }
    return out;
}
