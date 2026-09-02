// eval / new Function shim —— 把全局 `eval(str)` 与 `new Function(body)` 接到 route B
// 引擎(运行时编译执行)。引用了 eval/new Function 的模块由 compiler/index.js
// readModuleSource 前置注入 `import { __eval, __makeFunction } from "__eval_shim"`,
// 调用点由 compileCallExpression / compileNewExpression 改派到这里(路线同 __json_shim)。
//
// 注意:import compileFragment 会把**整个 asm.js 编译器**编入产物(route B 设计:只有用
// eval/new Function 的程序才付这个代价)。语义:间接 eval / 全局作用域——不捕获调用处
// 词法作用域(独立里程碑)。

import { compileFragment, relocsToBytes } from "../../engine/compile.js";
import { __RE_new } from "./__regexp_shim.js";

// 宿主 target(编译期常量,如 "macos-x64"/"macos-arm64"/"linux-x64")。片段编码按架构不同,
// eval/new Function 编出的片段必须与运行架构一致,故不能硬编码 arm64。
const HOST_TARGET = __engine_host_target();

// 整段源若是 /pattern/flags 字面量,直接走宿主 __RE_new:compileFragment 不注入
// regexp shim,编出来的 __RE_new 是未定义 → "not a function"(source/value-*.js)。
function __evalRegexpLiteral(x) {
    if (typeof x !== "string" || x.length < 2) return null;
    if (x.charAt(0) !== "/") return null;
    var n = 0;
    while (true) {
        var cc = x.charCodeAt(n);
        if (typeof cc !== "number" || cc !== cc) break;
        n = n + 1;
    }
    if (n < 2) return null;
    var i = 1;
    var slash = -1;
    while (i < n) {
        var ch = x.charAt(i);
        if (ch === "\\") {
            i = i + 2;
            continue;
        }
        if (ch === "/") {
            slash = i;
            break;
        }
        i = i + 1;
    }
    if (slash < 0) return null;
    var flags = x.slice(slash + 1);
    var fi = 0;
    while (fi < flags.length) {
        var f = flags.charAt(fi);
        if ("gimsuyvd".indexOf(f) < 0) return null;
        fi = fi + 1;
    }
    return __RE_new(x.slice(1, slash), flags);
}

// __eval(x):间接 eval。非字符串原样返回(ES 规范);字符串则运行时编译成可重定位片段
// + 进程内执行,返回结果(JSValue,与宿主共享堆)。arm64 片段有 256KB 上限(19 位 PC 相对),
// 超限时 compileFragment 抛清晰错误,原样传播到 eval 调用点。
export function __eval(x) {
    if (typeof x !== "string") return x;
    var reLit = __evalRegexpLiteral(x);
    if (reLit !== null) return reLit;
    const r = compileFragment(x, HOST_TARGET);
    const fragArr = new Uint8Array(r.bytes);
    const relocArr = new Uint8Array(relocsToBytes(r.relocs));
    return __engine_exec_reloc(fragArr, relocArr);
}

// __eval_direct(x, fp, layout):**直接 eval**(词法作用域捕获)。fp = 直接 eval 所在函数的
// 运行时 FP(原始指针,__eval_frame_ptr() 内联取得);layout = "name:off,..."(外层局部名→
// 帧内 FP 偏移,编译期序列化)。compileFragment 据 layout 让片段以 A0=callerFP 执行,入口
// copy-in 调用者槽 → 片段局部、出口 copy-out 写回 → 直接 eval 可读写外层局部(match node)。
// 非字符串实参按 ES 规范原样返回。
export function __eval_direct(x, fp, layout) {
    if (typeof x !== "string") return x;
    var reLit = __evalRegexpLiteral(x);
    if (reLit !== null) return reLit;
    const r = compileFragment(x, HOST_TARGET, layout);
    const fragArr = new Uint8Array(r.bytes);
    const relocArr = new Uint8Array(relocsToBytes(r.relocs));
    return __engine_exec_reloc_fp(fragArr, relocArr, fp);
}

// __makeFunction(names, body):new Function(...argNames, body) 的落点。names 是形参名字符串
// 数组,body 是函数体源。把两者**包装成函数表达式源码** `(function(<params>){<body>})`,编成
// 片段并求值——片段结果即一个**真 asm.js 闭包**(默认参数/rest/超 6 形参的栈溢出全由正常
// compileFunctionBody 处理),直接返回。用户调用它走标准闭包调用约定(callIndirect 到片段页
// 内的函数体),无需手工载参。片段 mmap 页执行后不释放,故闭包函数指针恒有效。
export function __makeFunction(names, body) {
    const _traceClass = typeof process !== "undefined" && process.env && process.env.ASMJS_TRACE_CLASS === "1";
    if (_traceClass) console.log("MF_ENTER", names && names.length, body && body.length);
    if (typeof print === "function") print("MF_BEGIN");
    // A caught exception must not poison the next dynamic compilation.  The
    // host exception channel is normally cleared by catch dispatch, but route
    // B can be entered immediately after a caught native helper error (the
    // test262 well-known-intrinsics probe does exactly this).
    __engine_clear_pending_exception();
    const src = typeof body === "string" ? body : "";
    // 形参串:各字符串实参本身可含逗号(new Function("a,b","...") 合法),原样拼接为形参列表
    // (默认值/rest/解构由 parser 处理,无需在此拆分)。
    const params = [];
    for (let i = 0; i < names.length; i++) {
        if (typeof names[i] === "string") params.push(names[i]);
    }
    const wrapped = "(function(" + params.join(",") + "){" + src + "})";
    const r = compileFragment(wrapped, HOST_TARGET);
    if (_traceClass) console.log("MF_COMPILED", r && r.bytes && r.bytes.length, r && r.relocs && r.relocs.length);
    if (typeof print === "function") print("MF_COMPILED");
    const fragArr = new Uint8Array(r.bytes);
    const relocArr = new Uint8Array(relocsToBytes(r.relocs));
    const fn = __engine_exec_reloc(fragArr, relocArr);
    if (_traceClass) console.log("MF_EXEC", typeof fn);
    if (typeof print === "function") print("MF_EXEC:" + String(fn));
    // 片段函数的 func_meta 不在宿主进程表 → gOPD(fn,"length") 恒 undefined
    // (15.2.3.3-4-187)。按形参列表粗算 arity 并 DefineOwnProperty 落侧表。
    var arity = 0;
    if (params.length > 0) {
        var joined = params.join(",");
        if (joined.length > 0) {
            arity = 1;
            for (var ci = 0; ci < joined.length; ci++) {
                if (joined.charAt(ci) === ",") arity = arity + 1;
            }
        }
    }
    Object.defineProperty(fn, "length", {
        value: arity,
        writable: false,
        enumerable: false,
        configurable: true,
    });
    if (typeof print === "function") print("MF_END");
    return fn;
}

// CreateDynamicFunction for the three specialised intrinsic constructors.
// `kind` is 1=generator, 2=async, 3=async-generator and `args` is the boxed
// argument list assembled by the native constructor trampoline.  Keeping the
// parser/compiler in this JS shim gives these constructors the same syntax,
// default/rest parameter, and early-error behaviour as new Function.
export function __makeFunctionKind(kind, args, newTarget) {
    __engine_clear_pending_exception();
    const list = [];
    const n = Array.isArray(args) ? args.length : 0;
    for (let i = 0; i < n; i++) list.push(args[i]);
    const body = list.length > 0 ? String(list[list.length - 1]) : "";
    const params = [];
    for (let i = 0; i + 1 < list.length; i++) params.push(list[i]);
    const psrc = params.map((x) => String(x)).join(",");
    let prefix = "function";
    if (kind === 1) prefix = "function*";
    else if (kind === 2) prefix = "async function";
    else if (kind === 3) prefix = "async function*";
    const wrapped = "(" + prefix + " anonymous(" + psrc + "){" + body + "})";
    const r = compileFragment(wrapped, HOST_TARGET);
    const fragArr = new Uint8Array(r.bytes);
    const relocArr = new Uint8Array(relocsToBytes(r.relocs));
    const fn = __engine_exec_reloc(fragArr, relocArr);
    const fm = r.functionMeta;
    const arity = fm && typeof fm.arity === "number" ? fm.arity :
        (params.length > 0 ? 1 + psrc.split(",").length - 1 : 0);
    // Dynamic functions receive the standard anonymous name and the same
    // configurable, non-enumerable, non-writable name/length descriptors as
    // the spec's CreateDynamicFunction operation.
    Object.defineProperty(fn, "name", {
        value: "anonymous", writable: false, enumerable: false, configurable: true,
    });
    Object.defineProperty(fn, "length", {
        value: arity, writable: false, enumerable: false, configurable: true,
    });
    // GetPrototypeFromConstructor(NewTarget, fallbackProto).  Fragment
    // closures have no spare inline [[Prototype]] slot, so persist the exact
    // result in their dynamic metadata node.  Calls (rather than Construct)
    // have undefined NewTarget and already use the intrinsic fallback.
    if (newTarget !== undefined) {
        let proto = newTarget.prototype;
        const protoType = typeof proto;
        if (proto === null || (protoType !== "object" && protoType !== "function")) {
            proto = Object.getPrototypeOf(fn);
        }
        __engine_set_dynamic_function_proto(fn, proto);
    }
    return fn;
}

// The three native intrinsic constructor singletons dispatch through this
// maker.  Registration is a no-op for programs whose source never triggers
// the eval shim import.
__engine_set_dynamic_fn_maker(__makeFunctionKind, __makeFunctionKind, __makeFunctionKind);
