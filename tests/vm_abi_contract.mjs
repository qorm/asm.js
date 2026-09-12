// tests/vm_abi_contract.mjs
// RegisterFile / backend 寄存器 ABI 契约测试。
//
// 校验：
// 1. ABI 表自身健全（validateAbi）
// 2. backend.regMap 与 RegisterFile 逐键一致（含 x64 S5 栈槽）
// 3. 历史事故硬规的机器断言（x64 V0≡RET、V↔A 别名组完整；arm64 V0 与 RET 分离）
// 4. 负向：故意打歪的 map 必须被 diffBackendRegMap 抓住
//
// 运行：node tests/vm_abi_contract.mjs
// 退出码 0 = 全绿。

import { VReg } from "../vm/registers.js";
import {
    ARCH_ARM64, ARCH_X64,
    ARM64_PHYS, X64_PHYS,
    getAbi, listArches, conflict, aliasSet, validateAbi,
    buildRegMap, diffBackendRegMap,
} from "../vm/register-file.js";
import { ARM64Backend } from "../backend/arm64.js";
import { X64Backend } from "../backend/x64.js";

let failures = 0;
function ok(cond, msg) {
    if (cond) {
        console.log("  PASS  " + msg);
    } else {
        failures++;
        console.error("  FAIL  " + msg);
    }
}

function section(name) {
    console.log("\n== " + name + " ==");
}

// ---------------------------------------------------------------------------
section("validateAbi (table self-check)");
for (const arch of listArches()) {
    const errs = validateAbi(arch);
    ok(errs.length === 0, arch + " ABI table self-check" + (errs.length ? ": " + errs.join("; ") : ""));
}

// ---------------------------------------------------------------------------
section("hard rules: x64 aliases (historical smash class)");
{
    const abi = getAbi(ARCH_X64);
    ok(abi.map[VReg.V0] === X64_PHYS.RAX, "V0 maps to RAX");
    ok(abi.map[VReg.RET] === X64_PHYS.RAX, "RET maps to RAX");
    ok(abi.map[VReg.LR] === X64_PHYS.RAX, "LR maps to RAX (placeholder)");
    ok(conflict(ARCH_X64, VReg.V0, VReg.RET), "conflict(V0,RET) === true");
    ok(conflict(ARCH_X64, VReg.V1, VReg.A3), "conflict(V1,A3) === true");
    ok(conflict(ARCH_X64, VReg.V2, VReg.A2), "conflict(V2,A2) === true");
    ok(conflict(ARCH_X64, VReg.V3, VReg.A4), "conflict(V3,A4) === true");
    ok(conflict(ARCH_X64, VReg.V4, VReg.A5), "conflict(V4,A5) === true");
    ok(conflict(ARCH_X64, VReg.V7, VReg.A1), "conflict(V7,A1) === true");
    ok(!conflict(ARCH_X64, VReg.V0, VReg.A0), "conflict(V0,A0) === false (A0=RDI)");
    ok(!conflict(ARCH_X64, VReg.V5, VReg.A0), "conflict(V5,A0) === false (V5=R10)");
    ok(abi.stackSlots[VReg.S5] === -8, "S5 stack slot is -8");
    ok(abi.map[VReg.S5] === undefined, "S5 absent from regMap");
    const set = aliasSet(ARCH_X64, VReg.V0);
    ok(set.indexOf(VReg.RET) >= 0 && set.indexOf(VReg.LR) >= 0, "aliasSet(V0) contains RET and LR");
}

// ---------------------------------------------------------------------------
section("hard rules: arm64 separation");
{
    const abi = getAbi(ARCH_ARM64);
    ok(abi.map[VReg.V0] === ARM64_PHYS.X8, "V0 maps to X8");
    ok(abi.map[VReg.RET] === ARM64_PHYS.X0, "RET maps to X0");
    ok(abi.map[VReg.A0] === ARM64_PHYS.X0, "A0 maps to X0");
    ok(!conflict(ARCH_ARM64, VReg.V0, VReg.RET), "conflict(V0,RET) === false on arm64");
    ok(conflict(ARCH_ARM64, VReg.A0, VReg.RET), "conflict(A0,RET) === true on arm64");
    ok(abi.map[VReg.S5] === ARM64_PHYS.X24, "S5 maps to X24 (not stack)");
    ok(Object.keys(abi.stackSlots).length === 0, "arm64 has no stack-slot VRegs");
}

// ---------------------------------------------------------------------------
section("backend.regMap matches RegisterFile");
{
    // Minimal dummy assembler; backends only store the ref.
    const dummyAsm = {};
    const arm = new ARM64Backend(dummyAsm, "macos");
    const errs = diffBackendRegMap(ARCH_ARM64, arm.regMap, {});
    ok(errs.length === 0, "ARM64Backend.regMap matches" + (errs.length ? ": " + errs.join("; ") : ""));

    const x64 = new X64Backend(dummyAsm, "linux");
    const s5 = {};
    s5[VReg.S5] = x64.s5StackOffset;
    const xerrs = diffBackendRegMap(ARCH_X64, x64.regMap, s5);
    ok(xerrs.length === 0, "X64Backend.regMap + s5StackOffset match" + (xerrs.length ? ": " + xerrs.join("; ") : ""));
    ok(x64.s5StackOffset === -8, "X64Backend.s5StackOffset === -8");
}

// ---------------------------------------------------------------------------
section("negative: corrupted map is detected");
{
    const bad = buildRegMap(ARCH_X64);
    bad[VReg.V0] = X64_PHYS.RDX; // smash RET's phys
    const errs = diffBackendRegMap(ARCH_X64, bad, {});
    ok(errs.length > 0, "deliberate V0→RDX mismatch is reported");
    ok(errs.some((e) => e.indexOf("V0") >= 0), "error mentions V0");
}

// ---------------------------------------------------------------------------
section("buildRegMap is a copy");
{
    const m1 = buildRegMap(ARCH_ARM64);
    m1[VReg.V0] = 99;
    const m2 = buildRegMap(ARCH_ARM64);
    ok(m2[VReg.V0] === ARM64_PHYS.X8, "mutating buildRegMap result does not poison ABI table");
}

// ---------------------------------------------------------------------------
if (failures === 0) {
    console.log("\nALL ABI CONTRACTS OK");
    process.exit(0);
} else {
    console.error("\nABI CONTRACT FAILURES: " + failures);
    process.exit(1);
}
