// asm.js WebAssembly (wasm32) 后端
// 把 VM 抽象指令翻译为"分段虚拟 CPU"的 wasm 字节码(设计见 docs/WASM_DESIGN.md):
//   • 虚拟寄存器 → 模块级 mutable globals(RET 与 A0 共用,保持 arm64 别名语义)——
//     M3 分段后寄存器状态须跨 wasm 函数(段)存活,globals 即"寄存器堆";GC 根扫描
//     不受影响:S 寄存器照旧由被调方 prologue 压进影子栈、跨 call 的 caller-saved
//     由 codegen 溢出到 FP 槽,GC 只看线性内存,契约与 native 完全一致;
//   • D0-D7 → f64 globals;cmp/fcmp 把操作数存入旗标 globals,jcc 现算关系;
//   • 跳转/调用 = 置 pc global + br 到段内派发 loop(占位立即数由 asm.fixupAll 回填);
//     目标不在本段 → 段内 br_table default 返回蹦床,由蹦床按 pc/SEG_SIZE 路由——
//     调用/返回/异常 unwind/协程切换全是 pc 赋值,天然跨段;
//   • call 把 CODE_BASE+返回标签序号 存入 LR,ret 取回;闭包函数指针同构;
//   • 内存访问走线性内存(地址 i64 计算后 wrap 为 i32);
//   • syscall → 宿主导入 env.__syscall(num, A0..A5) -> RET。

import { Backend } from "./base.js";
import { VReg } from "../vm/registers.js";
import { WASM_CODE_BASE } from "../asm/wasm32.js";

// globals 布局:0=pc(i32),1..25=i64 寄存器,26..33=D0-D7,34/35=浮点旗标(f64)
const LOCAL_PC = 0;
const LOCAL_FA = 24; // 整数比较操作数 A
const LOCAL_FB = 25; // 整数比较操作数 B
const LOCAL_D_BASE = 26; // D0..D7 → 26..33
const LOCAL_FFA = 34; // 浮点比较操作数 A
const LOCAL_FFB = 35; // 浮点比较操作数 B
export const WASM_NUM_I64_GLOBALS = 25;
export const WASM_NUM_F64_GLOBALS = 10;

// wasm 操作码
const OP_UNREACHABLE = 0x00;
const OP_IF = 0x04;
const OP_ELSE = 0x05;
const OP_END = 0x0b;
const OP_BR = 0x0c;
const OP_BR_IF = 0x0d;
const OP_CALL = 0x10;
const OP_GLOBAL_GET = 0x23;
const OP_GLOBAL_SET = 0x24;
const OP_I32_CONST = 0x41;
const OP_I64_CONST = 0x42;
const OP_F64_CONST = 0x44;
const OP_I64_LOAD = 0x29;
const OP_I64_LOAD8_U = 0x31;
const OP_I64_STORE = 0x37;
const OP_I64_STORE8 = 0x3c;
const OP_I32_SUB = 0x6b;
const OP_I32_OR = 0x72;
const OP_I64_EQZ = 0x50;
const OP_I64_EQ = 0x51;
const OP_I64_NE = 0x52;
const OP_I64_LT_S = 0x53;
const OP_I64_LT_U = 0x54;
const OP_I64_GT_S = 0x55;
const OP_I64_GT_U = 0x56;
const OP_I64_LE_S = 0x57;
const OP_I64_LE_U = 0x58;
const OP_I64_GE_S = 0x59;
const OP_I64_GE_U = 0x5a;
const OP_I64_ADD = 0x7c;
const OP_I64_SUB = 0x7d;
const OP_I64_MUL = 0x7e;
const OP_I64_DIV_S = 0x7f;
const OP_I64_REM_S = 0x81;
const OP_I64_AND = 0x83;
const OP_I64_OR = 0x84;
const OP_I64_XOR = 0x85;
const OP_I64_SHL = 0x86;
const OP_I64_SHR_S = 0x87;
const OP_I64_SHR_U = 0x88;
const OP_F64_EQ = 0x61;
const OP_F64_NE = 0x62;
const OP_F64_LT = 0x63;
const OP_F64_GT = 0x64;
const OP_F64_LE = 0x65;
const OP_F64_GE = 0x66;
const OP_F64_ABS = 0x99;
const OP_F64_NEG = 0x9a;
const OP_F64_CEIL = 0x9b;
const OP_F64_FLOOR = 0x9c;
const OP_F64_TRUNC = 0x9d;
const OP_F64_SQRT = 0x9f;
const OP_F64_ADD = 0xa0;
const OP_F64_SUB = 0xa1;
const OP_F64_MUL = 0xa2;
const OP_F64_DIV = 0xa3;
const OP_F64_COPYSIGN = 0xa6;
const OP_I32_WRAP_I64 = 0xa7;
const OP_I64_EXTEND_I32_U = 0xad;
const OP_F32_DEMOTE_F64 = 0xb6;
const OP_F64_CONVERT_I64_S = 0xb9;
const OP_F64_PROMOTE_F32 = 0xbb;
const OP_I32_REINTERPRET_F32 = 0xbc;
const OP_I64_REINTERPRET_F64 = 0xbd;
const OP_F32_REINTERPRET_I32 = 0xbe;
const OP_F64_REINTERPRET_I64 = 0xbf;
const OP_FC_PREFIX = 0xfc;
const OP_FC_I64_TRUNC_SAT_F64_S = 0x06;
const TYPE_VOID = 0x40;
const TYPE_I64 = 0x7e;

// __syscall 导入固定为函数索引 0
const SYSCALL_FUNC_INDEX = 0;

export class WasmBackend extends Backend {
    constructor(asm, platform) {
        super(asm);
        this.platform = platform || "wasi";
        this._cmpFloat = false;

        this.localMap = {
            [VReg.A0]: 1,
            [VReg.A1]: 2,
            [VReg.A2]: 3,
            [VReg.A3]: 4,
            [VReg.A4]: 5,
            [VReg.A5]: 6,
            [VReg.V0]: 7,
            [VReg.V1]: 8,
            [VReg.V2]: 9,
            [VReg.V3]: 10,
            [VReg.V4]: 11,
            [VReg.V5]: 12,
            [VReg.V6]: 13,
            [VReg.V7]: 14,
            [VReg.S0]: 15,
            [VReg.S1]: 16,
            [VReg.S2]: 17,
            [VReg.S3]: 18,
            [VReg.S4]: 19,
            [VReg.S5]: 20,
            [VReg.FP]: 21,
            [VReg.SP]: 22,
            [VReg.LR]: 23,
            [VReg.RET]: 1, // RET ≡ A0(arm64 别名语义,codegen 依赖)
        };
    }

    get name() {
        return "wasm32";
    }

    mapReg(vreg) {
        const idx = this.localMap[vreg];
        if (idx === undefined) {
            throw new Error("Unknown virtual register: " + vreg);
        }
        return idx;
    }

    // ==================== 发射原语 ====================

    _g(vreg) {
        this.asm.emit(OP_GLOBAL_GET);
        this.asm.uleb(this.mapReg(vreg));
    }

    _s(vreg) {
        this.asm.emit(OP_GLOBAL_SET);
        this.asm.uleb(this.mapReg(vreg));
    }

    _gl(idx) {
        this.asm.emit(OP_GLOBAL_GET);
        this.asm.uleb(idx);
    }

    _sl(idx) {
        this.asm.emit(OP_GLOBAL_SET);
        this.asm.uleb(idx);
    }

    _i64c(v) {
        this.asm.emit(OP_I64_CONST);
        this.asm.sleb(v);
    }

    _i32c(v) {
        this.asm.emit(OP_I32_CONST);
        this.asm.sleb(v);
    }

    // 地址计算:栈顶留 i32 线性地址。返回应折进 load/store memarg 的静态偏移。
    // 非负偏移折入 wasm 访存指令的 offset 立即数(effective addr = wrap(base)+offset,
    // 与 wrap(base+offset) 对所有 offset≥0 逐位一致,base 恒为 <2³² 的真实地址),
    // 省去 `i64.const offset; i64.add`;负偏移(prologue 配对补位等)保留 i64 加法路径。
    _addr(base, offset) {
        this._g(base);
        if (offset < 0) {
            this._i64c(offset);
            this.asm.emit(OP_I64_ADD);
            this.asm.emit(OP_I32_WRAP_I64);
            return 0;
        }
        this.asm.emit(OP_I32_WRAP_I64);
        return offset;
    }

    // 无条件转移到派发 loop(占位深度,fixupAll 回填);extra=所在额外嵌套层数
    _brDispatch(extra) {
        this.asm.emit(OP_BR);
        this.asm.addBrDepthFixup(extra);
    }

    // pc ← 标签序号(占位)
    _setPc(labelName) {
        this.asm.emit(OP_I32_CONST);
        this.asm.addPcFixup(labelName);
        this._sl(LOCAL_PC);
    }

    _jump(labelName) {
        this._setPc(labelName);
        this._brDispatch(0);
    }

    // 条件跳:pc 先无条件置为目标序号,再依栈顶 i32 条件 br_if 到派发 loop。
    // 【正确性】pc global 只在派发 loop 头(br_table)被读;每条到派发的 br/br_if
    // 之前都显式写 pc,故"未取"分支残留的 pc 目标值在下一次派发前必被覆写、永不被观测
    // ——省去 `if void { … } end` 包裹(每条件跳 -3 字节:0x04 0x40 … 0x0b),且 br_if
    // 比 if+br 更利于 Liftoff。调用方须已把 pc 置好(_setPc)、再压入条件、末尾调用本方法。
    _condBrIf() {
        this.asm.emit(OP_BR_IF);
        this.asm.addBrDepthFixup(0);
    }

    // 整数二元:dest = a <op> b
    _bin(op, dest, a, b) {
        this._g(a);
        this._g(b);
        this.asm.emit(op);
        this._s(dest);
    }

    // 整数立即数二元:dest = src <op> imm
    _binImm(op, dest, src, imm) {
        this._g(src);
        this._i64c(imm);
        this.asm.emit(op);
        this._s(dest);
    }

    // ==================== 数据移动 ====================

    mov(dest, src) {
        if (this.mapReg(dest) === this.mapReg(src)) return;
        this._g(src);
        this._s(dest);
    }

    movImm(dest, imm) {
        this._i64c(imm);
        this._s(dest);
    }

    movImm64(dest, imm) {
        this._i64c(imm);
        this._s(dest);
    }

    load(dest, base, offset) {
        const mo = this._addr(base, offset);
        this.asm.emit(OP_I64_LOAD);
        this.asm.emit(0x03); // align hint 8
        this.asm.uleb(mo);
        this._s(dest);
    }

    loadByte(dest, base, offset) {
        const mo = this._addr(base, offset);
        this.asm.emit(OP_I64_LOAD8_U);
        this.asm.emit(0x00);
        this.asm.uleb(mo);
        this._s(dest);
    }

    store(base, offset, src) {
        const mo = this._addr(base, offset);
        this._g(src);
        this.asm.emit(OP_I64_STORE);
        this.asm.emit(0x03);
        this.asm.uleb(mo);
    }

    storeByte(base, offset, src) {
        const mo = this._addr(base, offset);
        this._g(src);
        this.asm.emit(OP_I64_STORE8);
        this.asm.emit(0x00);
        this.asm.uleb(mo);
    }

    // [SP+offset] ← 0(prologue 配对补位用)
    _storeZero(base, offset) {
        const mo = this._addr(base, offset);
        this._i64c(0);
        this.asm.emit(OP_I64_STORE);
        this.asm.emit(0x03);
        this.asm.uleb(mo);
    }

    lea(dest, label) {
        this.asm.emit(OP_I64_CONST);
        this.asm.addAbs64Fixup(label);
        this._s(dest);
    }

    // ==================== 算术 ====================

    add(dest, a, b) { this._bin(OP_I64_ADD, dest, a, b); }
    addImm(dest, src, imm) { this._binImm(OP_I64_ADD, dest, src, imm); }
    sub(dest, a, b) { this._bin(OP_I64_SUB, dest, a, b); }
    subImm(dest, src, imm) { this._binImm(OP_I64_SUB, dest, src, imm); }
    mul(dest, a, b) { this._bin(OP_I64_MUL, dest, a, b); }

    // 除零守卫:arm64 sdiv 除零得 0,wasm div_s 会 trap → 显式对齐 arm64 语义。
    // 溢出守卫:wasm i64.div_s(INT64_MIN, -1) trap("divide result unrepresentable"),
    // 而 arm64 sdiv 回绕得 INT64_MIN。因 a/-1 == -a 对所有 a 成立(INT64_MIN 亦回绕),
    // 除数为 -1 时改算 0-a(i64.sub 回绕、不 trap),与 arm64 逐位一致。
    div(dest, a, b) {
        this._g(b);
        this.asm.emit(OP_I64_EQZ);
        this.asm.emit(OP_IF);
        this.asm.emit(TYPE_I64);
        this._i64c(0);
        this.asm.emit(OP_ELSE);
        this._g(b);
        this._i64c(-1); // number path → 1-byte sleb 0x7f(i64 -1),而非 bigint 的 10 字节定长
        this.asm.emit(OP_I64_EQ);
        this.asm.emit(OP_IF);
        this.asm.emit(TYPE_I64);
        this._i64c(0);
        this._g(a);
        this.asm.emit(OP_I64_SUB);
        this.asm.emit(OP_ELSE);
        this._g(a);
        this._g(b);
        this.asm.emit(OP_I64_DIV_S);
        this.asm.emit(OP_END);
        this.asm.emit(OP_END);
        this._s(dest);
    }

    // 模零守卫:arm64 合成 a-(a/0)*0 = a
    mod(dest, a, b) {
        this._g(b);
        this.asm.emit(OP_I64_EQZ);
        this.asm.emit(OP_IF);
        this.asm.emit(TYPE_I64);
        this._g(a);
        this.asm.emit(OP_ELSE);
        this._g(a);
        this._g(b);
        this.asm.emit(OP_I64_REM_S);
        this.asm.emit(OP_END);
        this._s(dest);
    }

    // ==================== 位运算 ====================

    and(dest, a, b) { this._bin(OP_I64_AND, dest, a, b); }
    andImm(dest, src, imm) { this._binImm(OP_I64_AND, dest, src, imm); }
    or(dest, a, b) { this._bin(OP_I64_OR, dest, a, b); }
    orImm(dest, src, imm) { this._binImm(OP_I64_OR, dest, src, imm); }
    xor(dest, a, b) { this._bin(OP_I64_XOR, dest, a, b); }
    xorImm(dest, src, imm) { this._binImm(OP_I64_XOR, dest, src, imm); }

    _shift(op, dest, src, count) {
        this._g(src);
        if (typeof count === "number") {
            this._i64c(count);
        } else {
            this._g(count);
        }
        this.asm.emit(op);
        this._s(dest);
    }

    shl(dest, src, count) { this._shift(OP_I64_SHL, dest, src, count); }
    shlImm(dest, src, imm) { this._shift(OP_I64_SHL, dest, src, imm); }
    shr(dest, src, count) { this._shift(OP_I64_SHR_U, dest, src, count); }
    shrImm(dest, src, imm) { this._shift(OP_I64_SHR_U, dest, src, imm); }
    sar(dest, src, count) { this._shift(OP_I64_SHR_S, dest, src, count); }
    sarImm(dest, src, imm) { this._shift(OP_I64_SHR_S, dest, src, imm); }

    not(dest, src) {
        this._g(src);
        this._i64c(-1); // number path → 1-byte sleb 0x7f(i64 -1),而非 bigint 的 10 字节定长
        this.asm.emit(OP_I64_XOR);
        this._s(dest);
    }

    neg(dest, src) {
        this._i64c(0);
        this._g(src);
        this.asm.emit(OP_I64_SUB);
        this._s(dest);
    }

    // ==================== 比较(操作数入旗标 locals) ====================

    cmp(a, b) {
        this._g(a);
        this._sl(LOCAL_FA);
        this._g(b);
        this._sl(LOCAL_FB);
        this._cmpFloat = false;
    }

    cmpImm(a, imm) {
        this._g(a);
        this._sl(LOCAL_FA);
        this._i64c(imm);
        this._sl(LOCAL_FB);
        this._cmpFloat = false;
    }

    test(a, b) {
        this._g(a);
        this._g(b);
        this.asm.emit(OP_I64_AND);
        this._sl(LOCAL_FA);
        this._i64c(0);
        this._sl(LOCAL_FB);
        this._cmpFloat = false;
    }

    testImm(a, imm) {
        this._g(a);
        this._i64c(imm);
        this.asm.emit(OP_I64_AND);
        this._sl(LOCAL_FA);
        this._i64c(0);
        this._sl(LOCAL_FB);
        this._cmpFloat = false;
    }

    // 依上一条比较的类型发射关系运算,真则跳。pc 先无条件置目标(见 _condBrIf 正确性注)。
    _jcc(intOp, floatOp, label) {
        this._setPc(label);
        if (this._cmpFloat) {
            this._gl(LOCAL_FFA);
            this._gl(LOCAL_FFB);
            this.asm.emit(floatOp);
        } else {
            this._gl(LOCAL_FA);
            this._gl(LOCAL_FB);
            this.asm.emit(intOp);
        }
        this._condBrIf();
    }

    jmp(label) { this._jump(label); }
    jeq(label) { this._jcc(OP_I64_EQ, OP_F64_EQ, label); }
    jne(label) { this._jcc(OP_I64_NE, OP_F64_NE, label); }
    jlt(label) { this._jcc(OP_I64_LT_S, OP_F64_LT, label); }
    jle(label) { this._jcc(OP_I64_LE_S, OP_F64_LE, label); }
    jgt(label) { this._jcc(OP_I64_GT_S, OP_F64_GT, label); }
    jge(label) { this._jcc(OP_I64_GE_S, OP_F64_GE, label); }
    jb(label) { this._jcc(OP_I64_LT_U, OP_F64_LT, label); }
    jbe(label) { this._jcc(OP_I64_LE_U, OP_F64_LE, label); }
    ja(label) { this._jcc(OP_I64_GT_U, OP_F64_GT, label); }
    jae(label) { this._jcc(OP_I64_GE_U, OP_F64_GE, label); }

    // 浮点比较跳(unordered 不取,与 arm64 blo/bls/bgt/bge 语义一致)
    jflt(label) { this._jcc(OP_I64_LT_S, OP_F64_LT, label); }
    jfle(label) { this._jcc(OP_I64_LE_S, OP_F64_LE, label); }
    jfgt(label) { this._jcc(OP_I64_GT_S, OP_F64_GT, label); }
    jfge(label) { this._jcc(OP_I64_GE_S, OP_F64_GE, label); }

    // 任一操作数 NaN → 跳(x != x)。pc 先无条件置目标(见 _condBrIf 正确性注)。
    jnan(label) {
        this._setPc(label);
        this._gl(LOCAL_FFA);
        this._gl(LOCAL_FFA);
        this.asm.emit(OP_F64_NE);
        this._gl(LOCAL_FFB);
        this._gl(LOCAL_FFB);
        this.asm.emit(OP_F64_NE);
        this.asm.emit(OP_I32_OR);
        this._condBrIf();
    }

    // ==================== 函数调用 ====================

    prologue(stackSize, savedRegs) {
        // 模拟 arm64:压 FP/LR,FP=SP,成对压 callee-saved,再留局部区
        this.subImm(VReg.SP, VReg.SP, 16);
        this.store(VReg.SP, 0, VReg.FP);
        this.store(VReg.SP, 8, VReg.LR);
        this.mov(VReg.FP, VReg.SP);

        const numPairs = Math.ceil(savedRegs.length / 2);
        for (let i = 0; i < numPairs * 2; i += 2) {
            this.subImm(VReg.SP, VReg.SP, 16);
            this.store(VReg.SP, 0, savedRegs[i]);
            if (i + 1 < savedRegs.length) {
                this.store(VReg.SP, 8, savedRegs[i + 1]);
            } else {
                this._storeZero(VReg.SP, 8);
            }
        }

        if (stackSize > 0) {
            this.subImm(VReg.SP, VReg.SP, stackSize);
        }
    }

    epilogue(savedRegs, stackSize) {
        if (stackSize > 0) {
            this.addImm(VReg.SP, VReg.SP, stackSize);
        }

        const numPairs = Math.ceil(savedRegs.length / 2);
        for (let p = numPairs - 1; p >= 0; p--) {
            const i = p * 2;
            this.load(savedRegs[i], VReg.SP, 0);
            if (i + 1 < savedRegs.length) {
                this.load(savedRegs[i + 1], VReg.SP, 8);
            }
            this.addImm(VReg.SP, VReg.SP, 16);
        }

        this.load(VReg.FP, VReg.SP, 0);
        this.load(VReg.LR, VReg.SP, 8);
        this.addImm(VReg.SP, VReg.SP, 16);
        this.ret();
    }

    call(label) {
        const retLabel = this.asm.nextReturnLabel();
        // LR ← CODE_BASE + 返回标签序号
        this.asm.emit(OP_I64_CONST);
        this.asm.addAbs64Fixup(retLabel);
        this._s(VReg.LR);
        this._jump(label);
        this.label(retLabel);
    }

    callIndirect(reg) {
        const retLabel = this.asm.nextReturnLabel();
        this.asm.emit(OP_I64_CONST);
        this.asm.addAbs64Fixup(retLabel);
        // 先算目标 pc 再写 LR:reg 可能就是 LR
        this._g(reg);
        this.asm.emit(OP_I32_WRAP_I64);
        this._i32c(WASM_CODE_BASE);
        this.asm.emit(OP_I32_SUB);
        this._sl(LOCAL_PC);
        this._s(VReg.LR);
        this._brDispatch(0);
        this.label(retLabel);
    }

    jmpIndirect(reg) {
        this._g(reg);
        this.asm.emit(OP_I32_WRAP_I64);
        this._i32c(WASM_CODE_BASE);
        this.asm.emit(OP_I32_SUB);
        this._sl(LOCAL_PC);
        this._brDispatch(0);
    }

    ret() {
        this._g(VReg.LR);
        this.asm.emit(OP_I32_WRAP_I64);
        this._i32c(WASM_CODE_BASE);
        this.asm.emit(OP_I32_SUB);
        this._sl(LOCAL_PC);
        this._brDispatch(0);
    }

    prepareCall(args) {
        const argRegs = [VReg.A0, VReg.A1, VReg.A2, VReg.A3, VReg.A4, VReg.A5];
        if (args.length > argRegs.length) {
            throw new Error("wasm prepareCall: too many args: " + args.length);
        }
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg === "number") {
                this.movImm(argRegs[i], arg);
            } else {
                this.mov(argRegs[i], arg);
            }
        }
    }

    // ==================== 栈操作 ====================

    push(reg) {
        this.subImm(VReg.SP, VReg.SP, 16);
        this.store(VReg.SP, 0, reg);
    }

    pop(reg) {
        this.load(reg, VReg.SP, 0);
        this.addImm(VReg.SP, VReg.SP, 16);
    }

    // ==================== 系统调用(宿主导入) ====================

    _emitSyscallArgsAndCall() {
        this._g(VReg.A0);
        this._g(VReg.A1);
        this._g(VReg.A2);
        this._g(VReg.A3);
        this._g(VReg.A4);
        this._g(VReg.A5);
        this.asm.emit(OP_CALL);
        this.asm.uleb(SYSCALL_FUNC_INDEX);
        this._s(VReg.RET);
    }

    syscall(num) {
        this._i64c(num);
        this._emitSyscallArgsAndCall();
    }

    syscallReg(reg) {
        this._g(reg);
        this._emitSyscallArgsAndCall();
    }

    // ==================== 类型转换/浮点 ====================

    // 从 Number 对象([src+8] 为 IEEE754 位型)取整数值
    f2i(dest, src) {
        const mo = this._addr(src, 8);
        this.asm.emit(OP_I64_LOAD);
        this.asm.emit(0x03);
        this.asm.uleb(mo);
        this.asm.emit(OP_F64_REINTERPRET_I64);
        this.asm.emit(OP_FC_PREFIX);
        this.asm.uleb(OP_FC_I64_TRUNC_SAT_F64_S);
        this._s(dest);
    }

    // 浮点寄存器号:个别 runtime 站点传 VReg 字符串(如 "V0"),arm64 asm 按位或把它
    // 折到 0(=D0)且行为已被依赖——此处 |0 保持同一语义。
    _gd(fpReg) {
        this._gl(LOCAL_D_BASE + (fpReg | 0));
    }

    _sd(fpReg) {
        this._sl(LOCAL_D_BASE + (fpReg | 0));
    }

    fmovToFloat(fpReg, gpReg) {
        this._g(gpReg);
        this.asm.emit(OP_F64_REINTERPRET_I64);
        this._sd(fpReg);
    }

    fmovToInt(gpReg, fpReg) {
        this._gd(fpReg);
        this.asm.emit(OP_I64_REINTERPRET_F64);
        this._s(gpReg);
    }

    _fbin(op, fpDest, fpA, fpB) {
        this._gd(fpA);
        this._gd(fpB);
        this.asm.emit(op);
        this._sd(fpDest);
    }

    fadd(fpDest, fpA, fpB) { this._fbin(OP_F64_ADD, fpDest, fpA, fpB); }
    fsub(fpDest, fpA, fpB) { this._fbin(OP_F64_SUB, fpDest, fpA, fpB); }
    fmul(fpDest, fpA, fpB) { this._fbin(OP_F64_MUL, fpDest, fpA, fpB); }
    fdiv(fpDest, fpA, fpB) { this._fbin(OP_F64_DIV, fpDest, fpA, fpB); }

    // 截断转换:trunc_sat 饱和、NaN→0,与 arm64 fcvtzs 一致
    fcvtzs(gpDest, fpSrc) {
        this._gd(fpSrc);
        this.asm.emit(OP_FC_PREFIX);
        this.asm.uleb(OP_FC_I64_TRUNC_SAT_F64_S);
        this._s(gpDest);
    }

    scvtf(fpDest, gpSrc) {
        this._g(gpSrc);
        this.asm.emit(OP_F64_CONVERT_I64_S);
        this._sd(fpDest);
    }

    // a - trunc(a/b)*b(与 arm64 合成序列一致)
    fmod(fpDest, fpA, fpB) {
        this._gd(fpA);
        this._gd(fpA);
        this._gd(fpB);
        this.asm.emit(OP_F64_DIV);
        this.asm.emit(OP_F64_TRUNC);
        this._gd(fpB);
        this.asm.emit(OP_F64_MUL);
        this.asm.emit(OP_F64_SUB);
        this._sd(fpDest);
    }

    fcmpZero(fpReg) {
        this._gd(fpReg);
        this._sl(LOCAL_FFA);
        this.asm.emit(OP_F64_CONST);
        for (let i = 0; i < 8; i++) {
            this.asm.emit(0x00);
        }
        this._sl(LOCAL_FFB);
        this._cmpFloat = true;
    }

    fcmp(fpA, fpB) {
        this._gd(fpA);
        this._sl(LOCAL_FFA);
        this._gd(fpB);
        this._sl(LOCAL_FFB);
        this._cmpFloat = true;
    }

    fmov(fpDest, fpSrc) {
        if (fpDest === fpSrc) return;
        this._gd(fpSrc);
        this._sd(fpDest);
    }

    _funop(op, fpDest, fpSrc) {
        this._gd(fpSrc);
        this.asm.emit(op);
        this._sd(fpDest);
    }

    fabs(fpDest, fpSrc) { this._funop(OP_F64_ABS, fpDest, fpSrc); }
    fneg(fpDest, fpSrc) { this._funop(OP_F64_NEG, fpDest, fpSrc); }
    ftrunc(fpDest, fpSrc) { this._funop(OP_F64_TRUNC, fpDest, fpSrc); }
    ffloor(fpDest, fpSrc) { this._funop(OP_F64_FLOOR, fpDest, fpSrc); }
    fceil(fpDest, fpSrc) { this._funop(OP_F64_CEIL, fpDest, fpSrc); }
    fsqrt(fpDest, fpSrc) { this._funop(OP_F64_SQRT, fpDest, fpSrc); }

    // 四舍五入 ties-away(arm64 frinta):trunc(x + copysign(0.5, x))
    fround(fpDest, fpSrc) {
        this._gd(fpSrc);
        this.asm.emit(OP_F64_CONST);
        // 0.5 的 IEEE754 小端字节
        this.asm.emitBytes([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x3f]);
        this._gd(fpSrc);
        this.asm.emit(OP_F64_COPYSIGN);
        this.asm.emit(OP_F64_ADD);
        this.asm.emit(OP_F64_TRUNC);
        this._sd(fpDest);
    }

    // 双精度 → 单精度(结果仍驻 f64 local,组合语义见设计文档)
    fcvtd2s(fpDest, fpSrc) {
        this._gd(fpSrc);
        this.asm.emit(OP_F32_DEMOTE_F64);
        this.asm.emit(OP_F64_PROMOTE_F32);
        this._sd(fpDest);
    }

    // 单精度 → 双精度(f64 local 已是 promote 后的值,等价复制)
    fcvts2d(fpDest, fpSrc) {
        this.fmov(fpDest, fpSrc);
    }

    fmovToIntSingle(gpDest, fpSrc) {
        this._gd(fpSrc);
        this.asm.emit(OP_F32_DEMOTE_F64);
        this.asm.emit(OP_I32_REINTERPRET_F32);
        this.asm.emit(OP_I64_EXTEND_I32_U);
        this._s(gpDest);
    }

    fmovToFloatSingle(fpDest, gpSrc) {
        this._g(gpSrc);
        this.asm.emit(OP_I32_WRAP_I64);
        this.asm.emit(OP_F32_REINTERPRET_I32);
        this.asm.emit(OP_F64_PROMOTE_F32);
        this._sd(fpDest);
    }

    // ==================== 杂项 ====================

    nop() {
        // 零发射
    }

    // 引擎库 cache 维护:wasm 无需
    dcCvau(reg) {}
    icIvau(reg) {}
    dsbIsh() {}
    isb() {}
    // [M3] wasm 维持单线程语义(§2.4 出圈),并行调度器从不发射这些。
    ldaxr() { throw new Error("[M3] atomic ops unsupported on wasm32 (single-thread)"); }
    stlxr() { throw new Error("[M3] atomic ops unsupported on wasm32 (single-thread)"); }
    clrex() { throw new Error("[M3] atomic ops unsupported on wasm32"); }
    stlr() { throw new Error("[M3] atomic ops unsupported on wasm32"); }
}
