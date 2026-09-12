// asm.js 虚拟寄存器定义
// 使用虚拟寄存器，由后端映射到真实寄存器

export const VReg = {
    // 通用寄存器 (用于计算)
    // x64 14 个可用 GPR,V0 必须留在 RAX(≡RET):分配器同时用 V0 与 V5 打包块头,
    // 不能把 V0 挪到 R10。仍重叠:V0≡RET≡LR、V1≡A3、V2≡A2、V3≡A4、V4≡A5、V7≡A1。
    // 后端 scratchReg 优先 R11,S5 中转禁止默认借 RAX。写 V0 即写 RET;写 V1 即写 A3。
    V0: "V0", // 临时(x64:≡RET=RAX)
    V1: "V1", // 临时(x64:≡A3)
    V2: "V2", // 临时(x64:≡A2)
    V3: "V3", // 临时(x64:≡A4)
    V4: "V4", // 临时(x64:≡A5)
    V5: "V5", // 临时(x64:R10,add/mul 内部 scratch)
    V6: "V6", // 临时(x64:R11,scratchReg 首选)
    V7: "V7", // 临时(x64:≡A1)

    // Callee-saved 寄存器 (函数调用时保留)
    S0: "S0", // 保存用
    S1: "S1", // 保存用
    S2: "S2", // 保存用
    S3: "S3", // 保存用
    S4: "S4", // 保存用
    S5: "S5", // 保存用

    // 特殊寄存器
    RET: "RET", // 返回值(arm64≡A0=X0; x64≡V0=RAX)
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

// 用户函数 LSRA 虚拟临时:"T" + 十进制序号。不进 backend.regMap;
// 仅存在于 beginRecord/endRecord 缓冲,分配后改写为物理 VReg 或 spill home。
export function isTemp(x) {
    if (typeof x !== "string" || x.length < 2 || x.charCodeAt(0) !== 84) return false; // 'T'
    for (let i = 1; i < x.length; i++) {
        const c = x.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
}

export function makeTempName(seq) {
    return "T" + seq;
}

