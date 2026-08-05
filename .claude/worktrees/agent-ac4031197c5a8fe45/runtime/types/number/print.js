// asm.js 运行时 - Number 打印功能
// 统一的数值打印函数，支持所有 Number 子类型

import { VReg } from "../../../vm/registers.js";
import { StringConstantsGenerator } from "../../core/strings.js";
import { TYPE_INT8, TYPE_INT16, TYPE_INT32, TYPE_INT64, TYPE_UINT8, TYPE_UINT16, TYPE_UINT32, TYPE_UINT64, TYPE_FLOAT32, TYPE_FLOAT64, isIntegerType, isFloatType } from "./types.js";

export class NumberPrintGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
        this.arch = vm.arch;
        this.os = vm.platform;
    }

    // 生成 write 系统调用
    emitWriteCall() {
        if (this.os === "windows") {
            this.vm.callWindowsWriteConsole();
        } else if (this.os === "wasi") {
            this.vm.syscall(1); // wasi 号名空间 = linux-x64
        } else if (this.arch === "arm64") {
            this.vm.syscall(this.os === "linux" ? 64 : 4);
        } else {
            this.vm.syscall(this.os === "linux" ? 1 : 0x2000004);
        }
    }

    // 生成带换行的整数打印函数
    generatePrintInt() {
        const vm = this.vm;

        vm.label("_print_int");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.S1, "_print_buf");
        vm.load(VReg.S1, VReg.S1, 0); // [M2] 解引用 per-M 指针 → 缓冲基址
        vm.addImm(VReg.S1, VReg.S1, 20);
        vm.movImm(VReg.V1, 10);
        vm.storeByte(VReg.S1, 0, VReg.V1);

        vm.movImm(VReg.S2, 0);

        const notNegLabel = this.ctx.newLabel("print_not_neg");
        vm.cmpImm(VReg.S0, 0);
        vm.jge(notNegLabel);
        vm.movImm(VReg.S2, 1);
        vm.movImm(VReg.V0, 0);
        vm.sub(VReg.S0, VReg.V0, VReg.S0);
        vm.label(notNegLabel);

        const loopLabel = this.ctx.newLabel("print_loop");
        vm.label(loopLabel);
        vm.movImm(VReg.V1, 10);
        vm.div(VReg.V2, VReg.S0, VReg.V1);
        vm.mul(VReg.V3, VReg.V2, VReg.V1);
        vm.sub(VReg.V4, VReg.S0, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.storeByte(VReg.S1, 0, VReg.V4);
        vm.mov(VReg.S0, VReg.V2);
        vm.cmpImm(VReg.S0, 0);
        vm.jne(loopLabel);

        const noMinusLabel = this.ctx.newLabel("print_no_minus");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq(noMinusLabel);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.movImm(VReg.V0, 45);
        vm.storeByte(VReg.S1, 0, VReg.V0);
        vm.label(noMinusLabel);

        vm.movImm(VReg.A0, 1);
        vm.lea(VReg.V2, "_print_buf");
        vm.load(VReg.V2, VReg.V2, 0); // [M2] 解引用 per-M 指针 → 缓冲基址
        vm.addImm(VReg.V2, VReg.V2, 21);
        vm.sub(VReg.A2, VReg.V2, VReg.S1);
        vm.mov(VReg.A1, VReg.S1);

        this.emitWriteCall();
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 64);
    }

    generatePrintIntNoNL() {
        const vm = this.vm;

        vm.label("_print_int_no_nl");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.S1, "_print_buf");
        vm.load(VReg.S1, VReg.S1, 0); // [M2] 解引用 per-M 指针 → 缓冲基址
        vm.addImm(VReg.S1, VReg.S1, 20);

        vm.movImm(VReg.S2, 0);

        const notNegLabel = this.ctx.newLabel("print_nonl_not_neg");
        vm.cmpImm(VReg.S0, 0);
        vm.jge(notNegLabel);
        vm.movImm(VReg.S2, 1);
        vm.movImm(VReg.V0, 0);
        vm.sub(VReg.S0, VReg.V0, VReg.S0);
        vm.label(notNegLabel);

        const loopLabel = this.ctx.newLabel("print_nonl_loop");
        vm.label(loopLabel);
        vm.movImm(VReg.V1, 10);
        vm.div(VReg.V2, VReg.S0, VReg.V1);
        vm.mul(VReg.V3, VReg.V2, VReg.V1);
        vm.sub(VReg.V4, VReg.S0, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.storeByte(VReg.S1, 0, VReg.V4);
        vm.mov(VReg.S0, VReg.V2);
        vm.cmpImm(VReg.S0, 0);
        vm.jne(loopLabel);

        const noMinusLabel = this.ctx.newLabel("print_nonl_no_minus");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq(noMinusLabel);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.movImm(VReg.V0, 45);
        vm.storeByte(VReg.S1, 0, VReg.V0);
        vm.label(noMinusLabel);

        vm.movImm(VReg.A0, 1);
        vm.lea(VReg.V2, "_print_buf");
        vm.load(VReg.V2, VReg.V2, 0); // [M2] 解引用 per-M 指针 → 缓冲基址
        vm.addImm(VReg.V2, VReg.V2, 20);
        vm.sub(VReg.A2, VReg.V2, VReg.S1);
        vm.mov(VReg.A1, VReg.S1);

        this.emitWriteCall();
        
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 64);
    }

    // 浮点数打印函数
    // 浮点数打印:委托 _floatToString(NaN/±Infinity/整数值/去尾零逻辑单源,
    // 旧手搓位数打印固定输出 17 位小数 —— "3.50000000000000000",#15 精度项)
    generatePrintFloat() {
        const vm = this.vm;

        vm.label("_print_float");
        vm.prologue(0, [VReg.S0]);
        vm.call("_floatToString"); // A0 = IEEE754 位 → 装箱堆串
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str");
        vm.epilogue([VReg.S0], 0);
    }

    generatePrintFloatNoNL() {
        const vm = this.vm;

        vm.label("_print_float_no_nl");
        vm.prologue(0, [VReg.S0]);
        vm.call("_floatToString");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0], 0);
    }

    generatePrintFloat32NoNL() {
        const vm = this.vm;

        vm.label("_print_float32_no_nl");
        vm.prologue(16, [VReg.S0]);

        vm.mov(VReg.S0, VReg.A0);

        vm.fmovToFloatSingle(0, VReg.S0);
        vm.fcvts2d(0, 0);
        vm.fmovToInt(VReg.A0, 0);

        vm.call("_print_float_no_nl");

        vm.epilogue([VReg.S0], 16);
    }

    generatePrintNumber() {
        const vm = this.vm;

        vm.label("_print_number");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        vm.load(VReg.S1, VReg.S0, 0);
        vm.load(VReg.A0, VReg.S0, 8);

        const isFloatLabel = "_print_number_float";
        const isIntLabel = "_print_number_int";
        const doneLabel = "_print_number_done";

        vm.cmpImm(VReg.S1, 13);
        vm.jeq(isFloatLabel);

        vm.cmpImm(VReg.S1, TYPE_INT8);
        vm.jlt(isFloatLabel);
        vm.cmpImm(VReg.S1, TYPE_FLOAT32);
        vm.jlt(isIntLabel);

        vm.label(isFloatLabel);
        vm.call("_print_float");
        vm.jmp(doneLabel);

        vm.label(isIntLabel);
        vm.call("_print_int");

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    generatePrintNumberNoNL() {
        const vm = this.vm;

        vm.label("_print_number_no_nl");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        vm.load(VReg.S1, VReg.S0, 0);
        vm.load(VReg.A0, VReg.S0, 8);

        const isFloatLabel = "_print_number_nonl_float";
        const isIntLabel = "_print_number_nonl_int";
        const doneLabel = "_print_number_nonl_done";

        vm.cmpImm(VReg.S1, 13);
        vm.jeq(isFloatLabel);

        vm.cmpImm(VReg.S1, TYPE_INT8);
        vm.jlt(isFloatLabel);
        vm.cmpImm(VReg.S1, TYPE_FLOAT32);
        vm.jlt(isIntLabel);

        vm.label(isFloatLabel);
        vm.call("_print_float_no_nl");
        vm.jmp(doneLabel);

        vm.label(isIntLabel);
        vm.call("_print_int_no_nl");

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // 打印 16 进制数 (64位)
    generatePrintHex() {
        const vm = this.vm;

        vm.label("_print_hex");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // 待打印的值

        // 打印 "0x"
        vm.movImm(VReg.A0, 48); // '0'
        vm.call("_print_char");
        vm.movImm(VReg.A0, 120); // 'x'
        vm.call("_print_char");

        // 使用 _print_buf (偏移 20 处开始)
        vm.lea(VReg.S1, "_print_buf");
        vm.load(VReg.S1, VReg.S1, 0); // [M2] 解引用 per-M 指针 → 缓冲基址
        vm.addImm(VReg.S1, VReg.S1, 16); // 16 位 16 进制

        vm.movImm(VReg.S2, 16); // 计数器
        const loopLabel = this.ctx.newLabel("print_hex_loop");
        vm.label(loopLabel);
        
        vm.andImm(VReg.V0, VReg.S0, 0xF); // 取最后 4 位
        vm.cmpImm(VReg.V0, 10);
        const letterLabel = this.ctx.newLabel("print_hex_letter");
        vm.jge(letterLabel);
        vm.addImm(VReg.V0, VReg.V0, 48); // '0'-'9'
        vm.jmp("_print_hex_store");
        
        vm.label(letterLabel);
        vm.addImm(VReg.V0, VReg.V0, 87); // 'a'-'f' (97 - 10)
        
        vm.label("_print_hex_store");
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.storeByte(VReg.S1, 0, VReg.V0);
        
        vm.shrImm(VReg.S0, VReg.S0, 4); // 右移 4 位
        vm.subImm(VReg.S2, VReg.S2, 1);
        vm.cmpImm(VReg.S2, 0);
        vm.jne(loopLabel);

        // 打印生成的 16 位字符串
        vm.movImm(VReg.A0, 1); // stdout
        vm.mov(VReg.A1, VReg.S1); // buf
        vm.movImm(VReg.A2, 16); // len
        this.emitWriteCall();

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);
    }

    generate() {
        this.generatePrintInt();
        this.generatePrintIntNoNL();
        this.generatePrintHex();
        this.generatePrintFloat();
        this.generatePrintFloatNoNL();
        this.generatePrintFloat32NoNL();
        this.generatePrintNumber();
        this.generatePrintNumberNoNL();
    }

    generateDataSection(asm) {
        const strGen = new StringConstantsGenerator(asm);
        strGen.generatePrintBuffer();
        strGen.generateAll();
    }
}
