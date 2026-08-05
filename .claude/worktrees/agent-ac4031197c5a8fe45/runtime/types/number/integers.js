// asm.js 运行时 - 有符号整数类型
// int8, int16, int32, int64

import { VReg } from "../../../vm/registers.js";
import { TYPE_INT8, TYPE_INT16, TYPE_INT32, TYPE_INT64 } from "./types.js";

export class SignedIntegerGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
        this.arch = vm.arch;
    }

    // 生成 int8 装箱函数
    // 输入: A0 = int8 值
    // 输出: RET = Number 对象指针
    generateBoxInt8() {
        const vm = this.vm;

        vm.label("_box_int8");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        // 符号扩展到 64 位
        vm.shl(VReg.S0, VReg.S0, 56);
        vm.shr(VReg.S0, VReg.S0, 56); // 算术右移

        // 分配 16 字节
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");

        // 写入类型和值
        // 注意：RET 和 V0 在某些架构上是同一个寄存器，
        // 所以先用 V1 存储类型值，避免覆盖 RET
        vm.movImm(VReg.V1, TYPE_INT8);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);

        vm.epilogue([VReg.S0], 16);
    }

    // 生成 int16 装箱函数
    generateBoxInt16() {
        const vm = this.vm;

        vm.label("_box_int16");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        // 符号扩展
        vm.shl(VReg.S0, VReg.S0, 48);
        vm.shr(VReg.S0, VReg.S0, 48);

        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");

        vm.movImm(VReg.V1, TYPE_INT16);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);

        vm.epilogue([VReg.S0], 16);
    }

    // 生成 int32 装箱函数
    generateBoxInt32() {
        const vm = this.vm;

        vm.label("_box_int32");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        // 符号扩展
        vm.shl(VReg.S0, VReg.S0, 32);
        vm.shr(VReg.S0, VReg.S0, 32);

        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");

        vm.movImm(VReg.V1, TYPE_INT32);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);

        vm.epilogue([VReg.S0], 16);
    }

    // 生成 int64 装箱函数
    generateBoxInt64() {
        const vm = this.vm;

        vm.label("_box_int64");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");

        vm.movImm(VReg.V1, TYPE_INT64);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);

        vm.epilogue([VReg.S0], 16);
    }

    // 生成拆箱函数 (通用)
    // 输入: A0 = Number 对象指针
    // 输出: RET = 原始整数值
    generateUnboxInt() {
        const vm = this.vm;

        vm.label("_unbox_int");
        vm.load(VReg.RET, VReg.A0, 8);
        vm.ret();
    }

    // 生成所有有符号整数函数
    generate() {
        this.generateBoxInt8();
        this.generateBoxInt16();
        this.generateBoxInt32();
        this.generateBoxInt64();
        this.generateUnboxInt();
    }
}
