// asm.js 运行时导出
// 统一导出所有运行时组件

// 核心组件
export { AllocatorGenerator } from "./core/allocator.js";
export * from "./core/allocator.js";
export { PrintGenerator } from "./core/print.js";
export { RUNTIME_STRINGS, StringConstantsGenerator } from "./core/strings.js";
export { JSValueGenerator } from "./core/jsvalue.js";
export { MathGenerator } from "./core/math.js";
export { CoercionGenerator } from "./core/coercion.js";
export { WinFsGenerator } from "./core/winfs.js";

// 类型运行时 - Number (包含所有数值子类型)
export { NumberGenerator } from "./types/number/index.js";
export * from "./types/number/types.js"; // 导出所有 Number 类型常量
// 类型运行时 - 其他类型
export { StringGenerator } from "./types/string/index.js";
export { ArrayGenerator } from "./types/array/index.js";
export { TypedArrayGenerator, ArrayBufferGenerator } from "./types/typedarray/index.js";
export * from "./types/typedarray/index.js"; // 导出 TypedArray 类型常量
export { ObjectGenerator } from "./types/object/index.js";
export { SymbolGenerator } from "./types/symbol/index.js";
export { MapGenerator } from "./types/map/index.js";
export { SetGenerator } from "./types/set/index.js";
export { DateGenerator } from "./types/date/index.js";
export { RegExpGenerator } from "./types/regexp/index.js";
export { BooleanGenerator } from "./types/boolean/index.js";

// 运算符
export { TypeofGenerator } from "./operators/typeof.js";

// 下标访问
export { SubscriptGenerator } from "./core/subscript.js";

// 异步运行时
export { AsyncGenerator, CoroutineGenerator, PromiseGenerator } from "./async/index.js";

// 统一运行时生成器
import { NumberGenerator } from "./types/number/index.js";
import { StringGenerator } from "./types/string/index.js";
import { ArrayGenerator } from "./types/array/index.js";
import { TypedArrayGenerator, ArrayBufferGenerator } from "./types/typedarray/index.js";
import { ObjectGenerator } from "./types/object/index.js";
import { SymbolGenerator } from "./types/symbol/index.js";
import { MapGenerator } from "./types/map/index.js";
import { SetGenerator } from "./types/set/index.js";
import { DateGenerator } from "./types/date/index.js";
import { RegExpGenerator } from "./types/regexp/index.js";
import { BooleanGenerator } from "./types/boolean/index.js";
import { PrintGenerator } from "./core/print.js";
import { SubscriptGenerator } from "./core/subscript.js";
import { TypeofGenerator } from "./operators/typeof.js";
import { AsyncGenerator } from "./async/index.js";
import { JSValueGenerator } from "./core/jsvalue.js";
import { MathGenerator } from "./core/math.js";
import { CoercionGenerator } from "./core/coercion.js";

import { ProcessGenerator } from "./core/process.js";
import { WinFsGenerator } from "./core/winfs.js";
import { ThreadGenerator } from "./core/thread.js";
import { MBringupGenerator } from "./core/m_bringup.js";
import { ParallelSchedGenerator } from "./core/parallel_sched.js";

export class RuntimeGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
        // 目标 os/arch 以 vm 为准（VirtualMachine 由 Compiler 用 targetInfo 构造，权威）。
        // ctx.os/ctx.arch 从未被设置(CompileContext 裸构造) → 恒 undefined → 旧代码退化成
        // "macos"，使 _process_exit_fn 等按 this.os 选系统调用号的运行时在 linux 目标上发错号、
        // 且 _process_exit_fn 无 ret 会 fall-through → process.exit segfault。改用 vm 修复。
        this.os = vm.os || ctx.os || "macos";
        this.arch = vm.arch || ctx.arch || "arm64";
        // 类型生成器
        this.numberGen = new NumberGenerator(vm, ctx);
        this.stringGen = new StringGenerator(vm);
        this.arrayGen = new ArrayGenerator(vm);
        this.typedArrayGen = new TypedArrayGenerator(vm, ctx);
        this.arrayBufferGen = new ArrayBufferGenerator(vm, ctx);
        this.objectGen = new ObjectGenerator(vm);
        this.symbolGen = new SymbolGenerator(vm);
        this.mapGen = new MapGenerator(vm);
        this.setGen = new SetGenerator(vm);
        this.dateGen = new DateGenerator(vm);
        this.regexpGen = new RegExpGenerator(vm);
        this.booleanGen = new BooleanGenerator(vm);
        // 核心生成器
        this.jsvalueGen = new JSValueGenerator(vm, ctx);
        this.printGen = new PrintGenerator(vm);
        this.subscriptGen = new SubscriptGenerator(vm, ctx);
        this.typeofGen = new TypeofGenerator(vm);
        this.mathGen = new MathGenerator(vm);
        this.coercionGen = new CoercionGenerator(vm);
        this.processGen = new ProcessGenerator(vm, ctx, this.os, this.arch);
        // Windows fs 面(其它平台为桩)
        this.winFsGen = new WinFsGenerator(vm);
        // 裸 OS 线程原语(M3 预研;linux 真体,其余桩,无用户 API 接线)
        this.threadGen = new ThreadGenerator(vm);
        // 第二个 M 起跑管线(M3 预研;GOMAXPROCS 门控,默认关;linux 真体,其余桩)
        this.mBringupGen = new MBringupGenerator(vm);
        // 多 M G-M-P 调度器(M3;per-P runq/全局队列/窃取/futex;linux-arm64 真体,其余桩)
        this.parallelSchedGen = new ParallelSchedGenerator(vm);
        // 异步运行时
        this.asyncGen = new AsyncGenerator(vm);
    }

    // 生成所有运行时函数
    generate() {
        // 类型
        this.numberGen.generate();
        this.stringGen.generate();
        this.arrayGen.generate();
        this.typedArrayGen.generate();
        this.arrayBufferGen.generate();
        this.objectGen.generate();
        this.symbolGen.generate();
        this.mapGen.generate();
        this.setGen.generate();
        this.dateGen.generate();
        this.regexpGen.generate();
        this.booleanGen.generate();
        // 核心
        this.jsvalueGen.generate();
        this.printGen.generate();
        this.subscriptGen.generate();
        this.typeofGen.generate();
        this.mathGen.generate();
        this.coercionGen.generate();
        this.processGen.generate();
        this.winFsGen.generate();
        this.threadGen.generate();
        this.mBringupGen.generate();
        this.parallelSchedGen.generate();
        // 异步
        this.asyncGen.generate();
    }

    // 生成异步运行时数据段
    generateAsyncDataSection(asm) {
        this.asyncGen.generateDataSection(asm);
        this.processGen.generateDataSection(asm);
        this.mBringupGen.generateDataSection(asm); // _gomaxprocs 门(默认 1)
        this.parallelSchedGen.generateDataSection(asm); // P 数组/全局队列/计数/冒烟结果
    }
}
