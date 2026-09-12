// asm.js 寄存器 ABI 单源表（RegisterFile）
//
// 目的：把 backend 里散落的「虚拟寄存器 → 物理寄存器」映射与别名硬规
// 收敛到一份可机器检查的契约。backends 从这里构造 regMap；
// tests/vm_abi_contract.mjs 校验 backend 实例与本表一致。
//
// 硬规摘要（历史事故的机器可读形态）：
// - x64: V0 ≡ RET ≡ LR ≡ RAX。写 V0 即写 RET。
// - x64: V1≡A3, V2≡A2, V3≡A4, V4≡A5, V7≡A1（内部统一 SysV）。
// - x64: S5 为栈槽（s5StackOffset），不在 regMap。
// - arm64: V0=X8 与 RET=X0 分离；RET≡A0≡X0。
// - arm64: V0–V7 与 A0–A5 无别名。

import { VReg } from "./registers.js";

export const ARCH_ARM64 = "arm64";
export const ARCH_X64 = "x64";

/** ARM64 物理寄存器编号（与 backend/arm64.js Reg 一致）。 */
export const ARM64_PHYS = {
    X0: 0, X1: 1, X2: 2, X3: 3, X4: 4, X5: 5, X6: 6, X7: 7,
    X8: 8, X9: 9, X10: 10, X11: 11, X12: 12, X13: 13, X14: 14, X15: 15,
    X16: 16, X17: 17, X18: 18,
    X19: 19, X20: 20, X21: 21, X22: 22, X23: 23, X24: 24, X25: 25, X26: 26, X27: 27, X28: 28,
    FP: 29, LR: 30, SP: 31,
};

/** x64 物理寄存器编号（与 backend/x64.js Reg 一致）。 */
export const X64_PHYS = {
    RAX: 0, RCX: 1, RDX: 2, RBX: 3, RSP: 4, RBP: 5, RSI: 6, RDI: 7,
    R8: 8, R9: 9, R10: 10, R11: 11, R12: 12, R13: 13, R14: 14, R15: 15,
};

/**
 * 一目标的完整 ABI 描述。
 * map: VReg 名 → 物理编号（含 special；不含纯栈槽）
 * stackSlots: VReg 名 → 相对 FP 的字节偏移（x64 S5）
 * aliasGroups: 共享同一物理寄存器的 VReg 组（每组至少 2 个才列入）
 * calleeSaved: 应在 prologue 保存的 VReg（S 系）
 * argumentRegs: 调用时按序使用的参数 VReg
 * returnReg: 返回值 VReg
 */
const ARM64_ABI = {
    arch: ARCH_ARM64,
    phys: ARM64_PHYS,
    map: {
        [VReg.V0]: ARM64_PHYS.X8,
        [VReg.V1]: ARM64_PHYS.X9,
        [VReg.V2]: ARM64_PHYS.X10,
        [VReg.V3]: ARM64_PHYS.X11,
        [VReg.V4]: ARM64_PHYS.X12,
        [VReg.V5]: ARM64_PHYS.X13,
        [VReg.V6]: ARM64_PHYS.X14,
        [VReg.V7]: ARM64_PHYS.X15,
        [VReg.S0]: ARM64_PHYS.X19,
        [VReg.S1]: ARM64_PHYS.X20,
        [VReg.S2]: ARM64_PHYS.X21,
        [VReg.S3]: ARM64_PHYS.X22,
        [VReg.S4]: ARM64_PHYS.X23,
        [VReg.S5]: ARM64_PHYS.X24,
        [VReg.A0]: ARM64_PHYS.X0,
        [VReg.A1]: ARM64_PHYS.X1,
        [VReg.A2]: ARM64_PHYS.X2,
        [VReg.A3]: ARM64_PHYS.X3,
        [VReg.A4]: ARM64_PHYS.X4,
        [VReg.A5]: ARM64_PHYS.X5,
        [VReg.RET]: ARM64_PHYS.X0,
        [VReg.FP]: ARM64_PHYS.FP,
        [VReg.SP]: ARM64_PHYS.SP,
        [VReg.LR]: ARM64_PHYS.LR,
    },
    stackSlots: {},
    // RET≡A0（都 X0）；V0=X8 与 RET 分离
    aliasGroups: [
        [VReg.A0, VReg.RET],
    ],
    calleeSaved: [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5],
    argumentRegs: [VReg.A0, VReg.A1, VReg.A2, VReg.A3, VReg.A4, VReg.A5],
    returnReg: VReg.RET,
    notes: [
        "V0=X8 is intentionally distinct from RET=X0.",
        "Temporaries X16/X17 used as assembler scratch; not in this map.",
        "X28 reserved for M-context redirect (G-M-P); not in this map.",
    ],
};

const X64_ABI = {
    arch: ARCH_X64,
    phys: X64_PHYS,
    map: {
        [VReg.V0]: X64_PHYS.RAX,
        [VReg.V1]: X64_PHYS.RCX,
        [VReg.V2]: X64_PHYS.RDX,
        [VReg.V3]: X64_PHYS.R8,
        [VReg.V4]: X64_PHYS.R9,
        [VReg.V5]: X64_PHYS.R10,
        [VReg.V6]: X64_PHYS.R11,
        [VReg.V7]: X64_PHYS.RSI,
        [VReg.S0]: X64_PHYS.RBX,
        [VReg.S1]: X64_PHYS.R12,
        [VReg.S2]: X64_PHYS.R13,
        [VReg.S3]: X64_PHYS.R14,
        [VReg.S4]: X64_PHYS.R15,
        // S5 is a stack slot — absent from map
        [VReg.A0]: X64_PHYS.RDI,
        [VReg.A1]: X64_PHYS.RSI,
        [VReg.A2]: X64_PHYS.RDX,
        [VReg.A3]: X64_PHYS.RCX,
        [VReg.A4]: X64_PHYS.R8,
        [VReg.A5]: X64_PHYS.R9,
        [VReg.RET]: X64_PHYS.RAX,
        [VReg.FP]: X64_PHYS.RBP,
        [VReg.SP]: X64_PHYS.RSP,
        [VReg.LR]: X64_PHYS.RAX,
    },
    stackSlots: {
        [VReg.S5]: -8,
    },
    aliasGroups: [
        [VReg.V0, VReg.RET, VReg.LR], // RAX
        [VReg.V1, VReg.A3],            // RCX
        [VReg.V2, VReg.A2],            // RDX
        [VReg.V3, VReg.A4],            // R8
        [VReg.V4, VReg.A5],            // R9
        [VReg.V7, VReg.A1],            // RSI
    ],
    calleeSaved: [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5],
    argumentRegs: [VReg.A0, VReg.A1, VReg.A2, VReg.A3, VReg.A4, VReg.A5],
    returnReg: VReg.RET,
    notes: [
        "Internal calling convention is always SysV-shaped (A0=RDI..A5=R9).",
        "Win32 shuffle (RCX/RDX/R8/R9) only at kernel32 glue sites.",
        "S5 is stack slot at FP-8; mapReg(S5) must throw.",
        "Writing V0 clobbers RET (same physical RAX).",
    ],
};

const ABIS = {
    [ARCH_ARM64]: ARM64_ABI,
    [ARCH_X64]: X64_ABI,
};

/** 按架构名取 ABI 表。未知架构抛错。 */
export function getAbi(arch) {
    const abi = ABIS[arch];
    if (!abi) throw new Error("Unknown arch for RegisterFile: " + arch);
    return abi;
}

/** 列出支持的架构名。 */
export function listArches() {
    return [ARCH_ARM64, ARCH_X64];
}

/**
 * 两个虚拟寄存器是否共享同一物理寄存器（或同一栈槽）。
 * 用于发射期自查与契约测试。
 */
export function conflict(arch, a, b) {
    const abi = getAbi(arch);
    const pa = abi.map[a];
    const pb = abi.map[b];
    if (pa !== undefined && pb !== undefined && pa === pb) return true;
    const sa = abi.stackSlots[a];
    const sb = abi.stackSlots[b];
    if (sa !== undefined && sb !== undefined && sa === sb) return true;
    return false;
}

/** 返回与 vreg 共享物理位置的所有 VReg（含自身）。 */
export function aliasSet(arch, vreg) {
    const abi = getAbi(arch);
    const out = [vreg];
    for (const group of abi.aliasGroups) {
        if (group.indexOf(vreg) >= 0) {
            for (const x of group) {
                if (x !== vreg && out.indexOf(x) < 0) out.push(x);
            }
        }
    }
    // stack-slot twin
    if (abi.stackSlots[vreg] !== undefined) {
        const s = abi.stackSlots[vreg];
        const keys = Object.keys(abi.stackSlots);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (k !== vreg && abi.stackSlots[k] === s && out.indexOf(k) < 0) out.push(k);
        }
    }
    return out;
}

/**
 * 校验 ABI 表自身健全：
 * - aliasGroups 内成员必须映射到同一物理/槽
 * - 无重复物理占用（除显式 aliasGroups 与 RET/A0 等约定）
 * - argumentRegs 都在 map 中
 */
export function validateAbi(arch) {
    const abi = getAbi(arch);
    const errors = [];
    const byPhys = {};
    for (const key of Object.keys(abi.map)) {
        const p = abi.map[key];
        if (!byPhys[p]) byPhys[p] = [];
        byPhys[p].push(key);
    }
    // Every multi-occupancy phys must be covered by an aliasGroup (or be documented specials)
    for (const p of Object.keys(byPhys)) {
        const group = byPhys[p];
        if (group.length < 2) continue;
        const covered = abi.aliasGroups.some((g) => {
            const set = {};
            for (let i = 0; i < g.length; i++) set[g[i]] = true;
            return group.every((v) => set[v] === true);
        });
        if (!covered) {
            errors.push(arch + ": phys " + p + " occupied by " + group.join(",") + " not in any aliasGroup");
        }
    }
    for (const g of abi.aliasGroups) {
        const p0 = abi.map[g[0]];
        const s0 = abi.stackSlots[g[0]];
        for (let i = 1; i < g.length; i++) {
            const pi = abi.map[g[i]];
            const si = abi.stackSlots[g[i]];
            if (p0 !== pi && !(s0 !== undefined && s0 === si)) {
                errors.push(arch + ": aliasGroup member " + g[i] + " does not match " + g[0]);
            }
        }
    }
    for (const a of abi.argumentRegs) {
        if (abi.map[a] === undefined && abi.stackSlots[a] === undefined) {
            errors.push(arch + ": argumentRegs missing " + a);
        }
    }
    if (abi.map[abi.returnReg] === undefined) {
        errors.push(arch + ": returnReg not in map");
    }
    return errors;
}

/**
 * 用 ABI 表构造 backend 用的 regMap 对象（浅拷贝）。
 * stackSlots 中的 VReg 不进入 map（由 backend 特判）。
 */
export function buildRegMap(arch) {
    const abi = getAbi(arch);
    const out = {};
    const keys = Object.keys(abi.map);
    for (let i = 0; i < keys.length; i++) {
        out[keys[i]] = abi.map[keys[i]];
    }
    return out;
}

/**
 * 将 backend 实例的 regMap 与本表比对，返回差异描述（空数组=一致）。
 * backend.regMap 键为 VReg 字符串值；本表 map 键同为 VReg 字符串。
 */
export function diffBackendRegMap(arch, backendMap, backendStackSlots) {
    const abi = getAbi(arch);
    const errors = [];
    const expect = abi.map;
    const keys = {};
    for (const k of Object.keys(expect)) keys[k] = true;
    for (const k of Object.keys(backendMap)) keys[k] = true;
    for (const k of Object.keys(keys)) {
        const e = expect[k];
        const a = backendMap[k];
        if (e !== a) {
            errors.push(arch + ": regMap[" + k + "] expect " + e + " got " + a);
        }
    }
    if (backendStackSlots) {
        const sk = {};
        for (const k of Object.keys(abi.stackSlots)) sk[k] = true;
        for (const k of Object.keys(backendStackSlots)) sk[k] = true;
        for (const k of Object.keys(sk)) {
            const e = abi.stackSlots[k];
            const a = backendStackSlots[k];
            if (e !== a) {
                errors.push(arch + ": stackSlot[" + k + "] expect " + e + " got " + a);
            }
        }
    }
    return errors;
}
