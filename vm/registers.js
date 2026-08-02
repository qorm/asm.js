// asm.js 虚拟寄存器定义
// 使用虚拟寄存器，由后端映射到真实寄存器

export const VReg = {
    // 通用寄存器 (用于计算)
    // ⚠ x64 约定(硬规):V0≡RET≡LR≡RAX 同一物理寄存器(backend/x64.js regMap)。
    // 禁止把 V0 当独立于 RET 的 scratch:任何写 V0(lea/mov/movImm/load/算术/
    // div/mod 目的…)即同时覆写 RET。RET 存活时须用 V1(≡A3)/V2(≡A2) 等,
    // 并就地论证该点对应 A 系寄存器无活值;`store(V0,…,RET)` 自存与
    // `store(RET,…,V0)` 反形同理禁。arm64 上 V0=X8 与 RET=X0 分离,问题不显。
    V0: "V0", // 返回值/临时(x64:RET 别名,见上硬规)
    // ⚠ x64 V↔A 别名全类(同硬规):V1≡A3 V2≡A2 V3≡A4 V4≡A5 V7≡A1。
    // 凡"V 系写毁时对应 A 系有活值"均属同禁——helper 入口实参未落 S 系前写
    // V1..V4/V7 即毁对应实参(F1 _dataview_get flags、F2 _dataview_set size、
    // F3 _ta_fill end、F4 _ta_copywithin end、_shape_transition_get key 同根因)。
    // 修法:实参先落 S 系再用 V;或改用非实参别名槽(5 参函数 V4≡A5 自由,
    // 4 参函数 V4≡A5 自由;V5=R10/V6=R11 是 x64 add/mul/and/or 的内部
    // scratch,作算术操作数须查 dest==b 形态)。arm64 映射全分离
    // (V0-V7=X8-X15、A0-A5=X0-X5),既往侥幸不显,x64 三目标逐指令暴露。
    V1: "V1", // 临时(x64:≡A3)
    V2: "V2", // 临时(x64:≡A2)
    V3: "V3", // 临时(x64:≡A4)
    V4: "V4", // 临时(x64:≡A5)
    V5: "V5", // 临时(x64:R10,add/mul 内部 scratch)
    V6: "V6", // 临时(x64:R11,add/mul 内部 scratch)
    V7: "V7", // 临时(x64:≡A1)

    // Callee-saved 寄存器 (函数调用时保留)
    S0: "S0", // 保存用
    S1: "S1", // 保存用
    S2: "S2", // 保存用
    S3: "S3", // 保存用
    S4: "S4", // 保存用
    S5: "S5", // 保存用

    // 特殊寄存器
    RET: "RET", // 返回值寄存器 (= V0 的别名)
    FP: "FP", // 帧指针
    SP: "SP", // 栈指针
    LR: "LR", // 链接寄存器 (仅 ARM64 有意义)

    // 参数寄存器 (调用时使用)
    A0: "A0", // 第1个参数
    A1: "A1", // 第2个参数
    A2: "A2", // 第3个参数
    A3: "A3", // 第4个参数
    A4: "A4", // 第5个参数
    A5: "A5", // 第6个参数
};

// 寄存器类型
export const RegType = {
    GENERAL: "general", // 通用
    SAVED: "saved", // Callee-saved
    ARGUMENT: "argument", // 参数传递
    SPECIAL: "special", // 特殊用途
};

