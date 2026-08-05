// asm.js 后端基类
// 所有目标平台后端的抽象接口

import { VReg } from "../vm/registers.js";

export class Backend {
    constructor(asm) {
        this.asm = asm;
    }

    // ========== 平台信息 ==========

    // 返回平台名称
    get name() {
        throw new Error("Backend.name must be implemented");
    }

    // 返回指针大小（字节）
    get pointerSize() {
        return 8;
    }

    // ========== 寄存器映射 ==========

    // 虚拟寄存器 -> 物理寄存器
    mapReg(vreg) {
        throw new Error("Backend.mapReg must be implemented");
    }

    // 获取第 n 个参数寄存器（虚拟）
    getArgReg(n) {
        const argRegs = [VReg.A0, VReg.A1, VReg.A2, VReg.A3, VReg.A4, VReg.A5];
        if (n >= argRegs.length) {
            throw new Error("Too many arguments: " + n);
        }
        return argRegs[n];
    }

    // ========== 数据移动 ==========

    mov(dest, src) {
        throw new Error("Backend.mov must be implemented");
    }

    movImm(dest, imm) {
        throw new Error("Backend.movImm must be implemented");
    }

    load(dest, base, offset) {
        throw new Error("Backend.load must be implemented");
    }

    store(base, offset, src) {
        throw new Error("Backend.store must be implemented");
    }

    lea(dest, label) {
        throw new Error("Backend.lea must be implemented");
    }

    // ========== 算术运算 ==========

    add(dest, a, b) {
        throw new Error("Backend.add must be implemented");
    }

    addImm(dest, src, imm) {
        throw new Error("Backend.addImm must be implemented");
    }

    sub(dest, a, b) {
        throw new Error("Backend.sub must be implemented");
    }

    subImm(dest, src, imm) {
        throw new Error("Backend.subImm must be implemented");
    }

    mul(dest, a, b) {
        throw new Error("Backend.mul must be implemented");
    }

    div(dest, a, b) {
        throw new Error("Backend.div must be implemented");
    }

    mod(dest, a, b) {
        throw new Error("Backend.mod must be implemented");
    }

    // ========== 位运算 ==========

    and(dest, a, b) {
        throw new Error("Backend.and must be implemented");
    }

    or(dest, a, b) {
        throw new Error("Backend.or must be implemented");
    }

    xor(dest, a, b) {
        throw new Error("Backend.xor must be implemented");
    }

    shl(dest, src, count) {
        throw new Error("Backend.shl must be implemented");
    }

    shlImm(dest, src, imm) {
        // 默认调用 shl，由子类优化
        this.shl(dest, src, imm);
    }

    shr(dest, src, count) {
        throw new Error("Backend.shr must be implemented");
    }

    // ========== 比较与跳转 ==========

    cmp(a, b) {
        throw new Error("Backend.cmp must be implemented");
    }

    cmpImm(a, imm) {
        throw new Error("Backend.cmpImm must be implemented");
    }

    jmp(label) {
        throw new Error("Backend.jmp must be implemented");
    }

    jeq(label) {
        throw new Error("Backend.jeq must be implemented");
    }

    jne(label) {
        throw new Error("Backend.jne must be implemented");
    }

    jlt(label) {
        throw new Error("Backend.jlt must be implemented");
    }

    jle(label) {
        throw new Error("Backend.jle must be implemented");
    }

    jgt(label) {
        throw new Error("Backend.jgt must be implemented");
    }

    jge(label) {
        throw new Error("Backend.jge must be implemented");
    }

    // ========== 函数调用 ==========

    prologue(stackSize, savedRegs) {
        throw new Error("Backend.prologue must be implemented");
    }

    epilogue(savedRegs) {
        throw new Error("Backend.epilogue must be implemented");
    }

    call(label) {
        throw new Error("Backend.call must be implemented");
    }

    // 间接调用（通过寄存器）
    callIndirect(reg) {
        throw new Error("Backend.callIndirect must be implemented");
    }

    // 间接调用别名
    callReg(reg) {
        return this.callIndirect(reg);
    }

    ret() {
        throw new Error("Backend.ret must be implemented");
    }

    // 设置调用参数
    prepareCall(args) {
        throw new Error("Backend.prepareCall must be implemented");
    }

    // ========== 栈操作 ==========

    push(reg) {
        throw new Error("Backend.push must be implemented");
    }

    pop(reg) {
        throw new Error("Backend.pop must be implemented");
    }

    // ========== 其他 ==========

    label(name) {
        // 标签是潜在跳转目标:使相邻 push/pop 配对窥孔失效(label 不发射字节)
        this._pairPush = null;
        this.asm.label(name);
    }

    nop() {
        // 默认实现：什么都不做
    }

    // ========== 平台特定 ==========

    // 系统调用
    syscall(num) {
        throw new Error("Backend.syscall must be implemented");
    }
}
