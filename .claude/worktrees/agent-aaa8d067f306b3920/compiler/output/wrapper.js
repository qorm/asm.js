// asm.js 编译器 - C 调用约定包装器生成
// 为导出函数生成符合 C ABI 的包装器

import { VReg } from "../../vm/index.js";

// C 调用约定包装器生成器
export class WrapperGenerator {
    constructor(compiler) {
        this.compiler = compiler;
        this.vm = compiler.vm;
        this.asm = compiler.asm;
        this.arch = compiler.arch;
        this.os = compiler.os;
        this.ctx = compiler.ctx;
    }

    // 生成所有导出函数的包装器
    generate(exports) {
        if (this.arch === "arm64") {
            this.generateARM64Wrappers(exports);
        } else if (this.arch === "x64") {
            this.generateX64Wrappers(exports);
        }
    }

    // ARM64 C 调用约定包装器
    generateARM64Wrappers(exports) {
        const vm = this.vm;
        const exportFuncs = exports.length > 0 ? exports : Object.keys(this.ctx.functions);

        for (const name of exportFuncs) {
            const func = this.ctx.functions[name];
            if (!func) continue;

            const paramCount = (func.params || []).length;

            // 包装器标签
            vm.label("_" + name);

            // 保存 LR
            this.asm.stpPre(29, 30, 31, -16);

            // 将浮点参数转换为整数寄存器
            for (let i = 0; i < paramCount && i < 8; i++) {
                this.asm.fmovToInt(i, i);
            }

            // 调用内部函数
            vm.call("_user_" + name);

            // 将返回值从 X0 转换为 D0
            this.asm.fmovToFloat(0, 0);

            // 恢复 LR
            this.asm.ldpPost(29, 30, 31, 16);

            // 返回
            this.asm.ret();
        }
    }

    // x64 C 调用约定包装器
    generateX64Wrappers(exports) {
        const vm = this.vm;
        const exportFuncs = exports.length > 0 ? exports : Object.keys(this.ctx.functions);

        for (const name of exportFuncs) {
            const func = this.ctx.functions[name];
            if (!func) continue;

            const paramCount = (func.params || []).length;

            // 包装器标签
            vm.label("_" + name);

            if (this.os === "windows") {
                // Windows x64 ABI
                const intArgRegs = [1, 2, 8, 9]; // RCX, RDX, R8, R9
                for (let i = 0; i < paramCount && i < 4; i++) {
                    this.asm.movqFromXmm(intArgRegs[i], i);
                }
            } else {
                // System V x64 ABI
                const intArgRegs = [7, 6, 2, 1, 8, 9]; // RDI, RSI, RDX, RCX, R8, R9
                for (let i = 0; i < paramCount && i < 6; i++) {
                    this.asm.movqFromXmm(intArgRegs[i], i);
                }
            }

            // 调用内部函数
            vm.call("_user_" + name);

            // 将返回值从 RAX 转换为 XMM0
            this.asm.movqToXmm(0, 0);

            // 返回
            this.asm.ret();
        }
    }
}
