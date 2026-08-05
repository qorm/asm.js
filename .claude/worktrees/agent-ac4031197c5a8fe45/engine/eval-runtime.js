// P4 编译器常驻 —— 运行时 eval。把 compileFragment(内含 asm.js 编译器)编入本程序,
// 运行时对字符串调它产可执行字节 + 运行时符号重定位 + 进程内执行。route B 终态:
// 真 `eval(表达式字符串)`,无外部工具、无运行时依赖。
//
// 注意:import compileFragment 会把**整个 asm.js 编译器**编入产物(自举:编译器可编成
// native)。产物大但自洽;只有用 eval 的程序才付这个代价。

import { compileFragment, relocsToBytes } from "./compile.js";

// evalExpr(src[, target]) -> 表达式求值结果(JSValue)。target 必须匹配宿主二进制架构
// (arm64/x64 的片段编码不同),默认 macos-arm64。x64 宿主须传 "macos-x64"/"linux-x64"。
// 覆盖:常量 + 算术 + 比较/位运算/三元/逻辑 + Math + 字符串拼接/方法 + 数组字面量/方法/
// 索引/length + typeof(分配走宿主共享堆)。未覆盖:对象字面量属性读(IC 站点回填撞 RX 页)、
// 变量/作用域、语句 eval —— 见 README.md follow-up。
export function evalExpr(src, target) {
    const r = compileFragment(src, target || "macos-arm64");
    const fragArr = new Uint8Array(r.bytes);
    const relocArr = new Uint8Array(relocsToBytes(r.relocs));
    return __engine_exec_reloc(fragArr, relocArr);
}
