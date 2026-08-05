// eval / new Function shim —— 把全局 `eval(str)` 与 `new Function(body)` 接到 route B
// 引擎(运行时编译执行)。引用了 eval/new Function 的模块由 compiler/index.js
// readModuleSource 前置注入 `import { __eval, __makeFunction } from "__eval_shim"`,
// 调用点由 compileCallExpression / compileNewExpression 改派到这里(路线同 __json_shim)。
//
// 注意:import compileFragment 会把**整个 asm.js 编译器**编入产物(route B 设计:只有用
// eval/new Function 的程序才付这个代价)。语义:间接 eval / 全局作用域——不捕获调用处
// 词法作用域(独立里程碑)。

import { compileFragment, relocsToBytes } from "../../engine/compile.js";

// 宿主 target(编译期常量,如 "macos-x64"/"macos-arm64"/"linux-x64")。片段编码按架构不同,
// eval/new Function 编出的片段必须与运行架构一致,故不能硬编码 arm64。
const HOST_TARGET = __engine_host_target();

// __eval(x):间接 eval。非字符串原样返回(ES 规范);字符串则运行时编译成可重定位片段
// + 进程内执行,返回结果(JSValue,与宿主共享堆)。arm64 片段有 256KB 上限(19 位 PC 相对),
// 超限时 compileFragment 抛清晰错误,原样传播到 eval 调用点。
export function __eval(x) {
    if (typeof x !== "string") return x;
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
    const src = typeof body === "string" ? body : "";
    // 形参串:各字符串实参本身可含逗号(new Function("a,b","...") 合法),原样拼接为形参列表
    // (默认值/rest/解构由 parser 处理,无需在此拆分)。
    const params = [];
    for (let i = 0; i < names.length; i++) {
        if (typeof names[i] === "string") params.push(names[i]);
    }
    const wrapped = "(function(" + params.join(",") + "){" + src + "})";
    const r = compileFragment(wrapped, HOST_TARGET);
    const fragArr = new Uint8Array(r.bytes);
    const relocArr = new Uint8Array(relocsToBytes(r.relocs));
    return __engine_exec_reloc(fragArr, relocArr);
}
