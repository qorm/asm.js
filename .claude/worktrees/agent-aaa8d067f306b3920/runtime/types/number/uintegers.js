// asm.js 运行时 - 无符号整数类型
// uint8, uint16, uint32, uint64

import { VReg } from "../../../vm/registers.js";
import { TYPE_UINT8, TYPE_UINT16, TYPE_UINT32, TYPE_UINT64 } from "./types.js";

export class UnsignedIntegerGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
        this.arch = vm.arch;
    }

    // 生成 uint8 装箱函数
    generateBoxUint8() {
        const vm = this.vm;

        vm.label("_box_uint8");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        // 零扩展（清除高位）
        vm.andImm(VReg.S0, VReg.S0, 0xff);

        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");

        vm.movImm(VReg.V1, TYPE_UINT8);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);

        vm.epilogue([VReg.S0], 16);
    }

    // 生成 uint16 装箱函数
    generateBoxUint16() {
        const vm = this.vm;

        vm.label("_box_uint16");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        vm.andImm(VReg.S0, VReg.S0, 0xffff);

        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");

        vm.movImm(VReg.V1, TYPE_UINT16);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);

        vm.epilogue([VReg.S0], 16);
    }

    // 生成 uint32 装箱函数
    generateBoxUint32() {
        const vm = this.vm;

        vm.label("_box_uint32");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        // 清除高 32 位
        vm.shl(VReg.S0, VReg.S0, 32);
        vm.shr(VReg.S0, VReg.S0, 32);

        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");

        vm.movImm(VReg.V1, TYPE_UINT32);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);

        vm.epilogue([VReg.S0], 16);
    }

    // 生成 uint64 装箱函数
    generateBoxUint64() {
        const vm = this.vm;

        vm.label("_box_uint64");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");

        vm.movImm(VReg.V1, TYPE_UINT64);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);

        vm.epilogue([VReg.S0], 16);
    }

    // 生成拆箱函数 (复用 _unbox_int)
    // 无符号和有符号整数的拆箱操作相同

    // 生成所有无符号整数函数
    generate() {
        this.generateBoxUint8();
        this.generateBoxUint16();
        this.generateBoxUint32();
        this.generateBoxUint64();
    }
}
