// asm.js 虚拟指令集定义

export const OpCode = {
    // === 数据移动 ===
    MOV: "mov", // mov dest, src
    MOV_IMM: "mov_imm", // mov dest, #imm
    LOAD: "load", // load dest, [base + offset]
    LOAD_BYTE: "load_byte", // load dest, [base + offset] (8-bit, 零扩展)
    STORE: "store", // store [base + offset], src
    STORE_BYTE: "store_byte", // store [base + offset], src (8-bit)
    LEA: "lea", // lea dest, label (加载地址)

    // === 算术运算 ===
    ADD: "add", // add dest, a, b
    ADD_IMM: "add_imm", // add dest, src, #imm
    SUB: "sub", // sub dest, a, b
    SUB_IMM: "sub_imm", // sub dest, src, #imm
    MUL: "mul", // mul dest, a, b
    DIV: "div", // div dest, a, b (有符号)
    MOD: "mod", // mod dest, a, b
    NEG: "neg", // neg dest (取反)

    // === 位运算 ===
    AND: "and",
    AND_IMM: "and_imm",
    OR: "or",
    OR_IMM: "or_imm",
    XOR: "xor",
    XOR_IMM: "xor_imm",
    NOT: "not", // 按位非
    SHL: "shl", // 左移
    SHL_IMM: "shl_imm",
    SHR: "shr", // 逻辑右移 (无符号)
    SHR_IMM: "shr_imm",
    SAR: "sar", // 算术右移 (有符号)
    SAR_IMM: "sar_imm",

    // === 比较 ===
    CMP: "cmp", // 比较，设置标志
    CMP_IMM: "cmp_imm", // 与立即数比较
    TEST: "test", // 位测试 (AND but only sets flags)
    TEST_IMM: "test_imm",

    // === 跳转 ===
    JMP: "jmp", // 无条件跳转
    JEQ: "jeq", // 相等跳转 (Z=1)
    JNE: "jne", // 不等跳转 (Z=0)
    JLT: "jlt", // 小于跳转 (有符号, N≠V)
    JLE: "jle", // 小于等于 (有符号, Z=1 or N≠V)
    JGT: "jgt", // 大于 (有符号, Z=0 and N=V)
    JGE: "jge", // 大于等于 (有符号, N=V)
    JB: "jb", // 小于 (无符号, C=0)
    JBE: "jbe", // 小于等于 (无符号)
    JA: "ja", // 大于 (无符号)
    JAE: "jae", // 大于等于 (无符号, C=1)

    // === 函数调用 ===
    CALL: "call", // 调用函数
    CALL_INDIRECT: "call_indirect", // 间接调用
    JMP_INDIRECT: "jmp_indirect", // 间接跳转 (不保存返回地址)
    RET: "ret", // 返回
    PROLOGUE: "prologue", // 函数序言
    EPILOGUE: "epilogue", // 函数尾声

    // === 栈操作 ===
    PUSH: "push",
    POP: "pop",

    // === 其他 ===
    LABEL: "label", // 定义标签
    NOP: "nop", // 空操作
    SYSCALL: "syscall", // 系统调用
    CALL_WIN_WRITE: "call_win_write", // Windows WriteConsole
    CALL_WIN_EXIT: "call_win_exit", // Windows ExitProcess
    F2I: "f2i", // 浮点到整数转换 (从 Number 对象提取)

    // === 浮点运算 ===
    FMOV_TO_FLOAT: "fmov_to_float", // 整数寄存器 -> 浮点寄存器 (位模式)
    FMOV_TO_INT: "fmov_to_int", // 浮点寄存器 -> 整数寄存器 (位模式)
    FADD: "fadd", // 浮点加法
    FSUB: "fsub", // 浮点减法
    FMUL: "fmul", // 浮点乘法
    FDIV: "fdiv", // 浮点除法
    FMOD: "fmod", // 浮点取模
    FCVTZS: "fcvtzs", // 浮点转整数 (截断)
    FCMP_ZERO: "fcmp_zero", // 浮点与零比较
    FABS: "fabs", // 浮点绝对值
    FNEG: "fneg", // 浮点取反
    FTRUNC: "ftrunc", // 浮点截断
    FFLOOR: "ffloor", // 浮点向下取整 (floor)
    FCEIL: "fceil", // 浮点向上取整 (ceil)
    FROUND: "fround", // 浮点四舍五入
    SCVTF: "scvtf", // 整数转浮点
    FCVT_D2S: "fcvt_d2s", // 双精度转单精度
    FCVT_S2D: "fcvt_s2d", // 单精度转双精度
    FMOV_TO_INT_SINGLE: "fmov_to_int_single", // 单精度浮点寄存器 -> 整数寄存器 (32位)
    FMOV_TO_FLOAT_SINGLE: "fmov_to_float_single", // 整数寄存器 -> 单精度浮点寄存器
    FCMP: "fcmp", // 浮点比较
    FMOV: "fmov", // 浮点寄存器间移动
};

// 指令类
export class Instruction {
    constructor(op, operands) {
        this.op = op;
        this.operands = operands || [];
    }

    toString() {
        if (this.operands.length === 0) {
            return this.op;
        }
        return this.op + " " + this.operands.join(", ");
    }
}
