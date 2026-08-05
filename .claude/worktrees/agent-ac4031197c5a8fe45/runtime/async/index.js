// asm.js 运行时 - 异步支持模块
// 导出协程和 Promise 运行时

export { CoroutineGenerator } from "./coroutine.js";
export { PromiseGenerator } from "./promise.js";

// 异步运行时聚合生成器
import { CoroutineGenerator } from "./coroutine.js";
import { PromiseGenerator } from "./promise.js";

export class AsyncGenerator {
    constructor(vm) {
        this.vm = vm;
        this.coroutineGen = new CoroutineGenerator(vm);
        this.promiseGen = new PromiseGenerator(vm);
    }

    // 生成所有异步运行时函数
    generate() {
        this.coroutineGen.generate();
        this.promiseGen.generate();
    }

    // 生成数据段
    generateDataSection(asm) {
        this.coroutineGen.generateDataSection(asm);
    }
}
