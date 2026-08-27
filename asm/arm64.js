import { ByteBuffer } from "./byte-buffer.js";
import { FixupBuffer, FIXUP_TYPE } from "./fixup-buffer.js";

// ARM64 寄存器
export let Reg = {
    X0: 0,
    X1: 1,
    X2: 2,
    X3: 3,
    X4: 4,
    X5: 5,
    X6: 6,
    X7: 7,
    X8: 8,
    X9: 9,
    X10: 10,
    X11: 11,
    X12: 12,
    X13: 13,
    X14: 14,
    X15: 15,
    X16: 16,
    X17: 17,
    X18: 18,
    X19: 19,
    X20: 20,
    X21: 21,
    X22: 22,
    X23: 23,
    X24: 24,
    X25: 25,
    X26: 26,
    X27: 27,
    X28: 28,
    FP: 29, // Frame Pointer (X29)
    LR: 30, // Link Register (X30)
    SP: 31, // Stack Pointer
    XZR: 31, // Zero Register (same encoding, context dependent)
};

// scratchReg 候选:模块级常量表,避免每次调用分配数组。
const SCRATCH_CANDS = [Reg.X16, Reg.X17, Reg.X9, Reg.X10, Reg.X11, Reg.X12];

const FALLBACK_DATA_LABELS = new Set([
    "_heap_base", "_heap_ptr", "_heap_initialized", "_heap_meta", "_print_buf",
    "_exception_sp", "_exception_stack", "_task_queue_head", "_task_queue_tail",
    "_task_queue", "_newline_char", "_str_uncaught", "_str_object", "_str_undefined",
    "_str_null", "_str_true", "_str_false", "_js_true", "_js_false", "_js_null",
    "_js_undefined", "_str_function", "_str_lbracket", "_str_rbracket", "_str_comma",
    "_str_array", "_str_number", "_str_string", "_str_boolean", "_str_function_type",
    "_str_object_type", "_random_seed"
]);

function isFallbackDataPrefix(labelName) {
    if (!labelName || labelName.length < 6 || labelName.charCodeAt(0) !== 95) return false;
    const c1 = labelName.charCodeAt(1);
    if (c1 === 102) return labelName.startsWith("_float_");
    if (c1 === 103) return labelName.startsWith("_global_");
    if (c1 === 109) return labelName.startsWith("_main_captured_");
    if (c1 === 100) return labelName.startsWith("_data_");
    return false;
}

export class ARM64Assembler {
    constructor() {
        this.code = new ByteBuffer();
        this._byteCode = true;
        this.data = new ByteBuffer();
        this._byteData = true;
        this.strings = [];
        this.labels = new Map();
        this.labelAliases = new Map();
        this.pendingFixups = new FixupBuffer();
        this.codeVAddr = 0;
        this.dataVAddr = 0;
        this.iatVAddr = 0; // Windows IAT 虚拟地址
        this.labelPrefix = "";
        this.externalSymbols = {}; // 外部符号（来自动态库）: name -> {dylib: libIndex, slot: slotIndex}
        this.externalSymbolList = []; // 外部符号列表，按顺序
        this.stubOffsets = {}; // 外部符号的 stub 偏移
        this.gotBaseOffset = 0; // GOT 在数据段的起始偏移
        this.undefinedSymbols = {}; // 未定义符号（静态库中的符号）
        this.undefinedSymbolSet = new Set();
        this.undefinedSymbolList = []; // 未定义符号列表
        this.branchRelocations = []; // 需要重定位的分支指令
        this._fwdB = null; // 前向 B:label → [codeOffset…]，定义时即时回填
        this._stringInternMap = new Map(); // str -> labelIndex
        this._stringLabels = []; // labelIndex -> "_str_N"
        this.dataLabels = [];
    }

    // 注册外部符号，返回符号的槽索引
    registerExternalSymbol(name, dylibIndex) {
        let fullName = "_" + name;
        if (this.externalSymbols[fullName]) {
            return this.externalSymbols[fullName].slot;
        }
        let slotIndex = this.externalSymbolList.length;
        this.externalSymbols[fullName] = { dylib: dylibIndex || 1, slot: slotIndex };
        this.externalSymbolList.push({ name: fullName, dylib: dylibIndex || 1 });
        return slotIndex;
    }

    // 注册未定义符号（来自静态库，链接时解析）
    registerUndefinedSymbol(name) {
        let fullName = "_" + name;
        if (this.undefinedSymbols[fullName]) {
            return;
        }
        this.undefinedSymbols[fullName] = true;
        this.undefinedSymbolSet.add(fullName);
        this.undefinedSymbolList.push(fullName);
    }

    // 检查是否是未定义符号
    // 用 truthy 而非 ===true：自举产物里 obj[missing] 返回裸 0 且 `x===true` 布尔严格
    // 比较不可靠，会漏判外部符号（如 pow）→ 当成 offset 0 代码 label → bl 跳入口崩。
    isUndefinedSymbol(name) {
        return this.undefinedSymbolSet.has(name);
    }

    // 获取分支重定位列表（用于生成 .o 文件）
    getBranchRelocations() {
        return this.branchRelocations;
    }

    // 获取外部符号数量（用于计算 GOT 大小）
    getExternalSymbolCount() {
        return this.externalSymbolList.length;
    }

    // 设置 GOT 在数据段的偏移
    setGotBaseOffset(offset) {
        this.gotBaseOffset = offset;
    }

    setLabelPrefix(prefix) {
        this.labelPrefix = prefix;
    }

    emit32(word) {
        this.code.emit32(word);
    }

    _codeGet(offset) {
        return this._byteCode ? this.code.get(offset) : this.code[offset];
    }

    _codeWrite32(offset, word) {
        if (this._byteCode) {
            this.code.write32(offset, word);
            return;
        }
        this.code[offset] = word & 255;
        this.code[offset + 1] = (word >> 8) & 255;
        this.code[offset + 2] = (word >> 16) & 255;
        this.code[offset + 3] = (word >> 24) & 255;
    }

    currentOffset() {
        return this.code.length;
    }

    scratchReg(a0, a1, a2, a3) {
        // 固定最多 4 个避开寄存器,勿 rest(...avoid) 每次分配数组。
        for (let i = 0; i < SCRATCH_CANDS.length; i++) {
            const c = SCRATCH_CANDS[i];
            if (c === a0 || c === a1 || c === a2 || c === a3) continue;
            return c;
        }
        return Reg.X15;
    }

    label(name) {
        // 如果标签以 _ 开头，说明是全局标签，不加前缀
        let fullName = name;
        if (name.charCodeAt(0) !== 95 && this.labelPrefix !== "") {
            // 前缀通常为空:空判前置,避免每标签一次字符串拼接(自编译 ~26 万标签)
            fullName = this.labelPrefix + name;
        }
        const at = this.code.length;
        this.labels.set(fullName, at);
        // 回填此前对该标签的前向 B(免入 fixup 队列)
        const fwd = this._fwdB;
        if (fwd) {
            const list = fwd.get(fullName);
            if (list) {
                for (let i = 0; i < list.length; i++) {
                    const offset = list[i];
                    const imm26 = ((at - offset) / 4) & 67108863;
                    this._codeWrite32(offset, 335544320 | imm26);
                }
                fwd.delete(fullName);
            }
        }
    }

    resolveLabel(name) {
        const aliases = this.labelAliases;
        if (aliases.size === 0) return name;
        let resolved = name;
        let maxIterations = 10;
        let iterations = 0;
        let next = aliases.get(resolved);
        while (next && iterations < maxIterations) {
            resolved = next;
            iterations = iterations + 1;
            next = aliases.get(resolved);
        }
        return resolved;
    }

    // 热路径:绝大多数标签不是 runtime 串别名。别名仅来自 registerRuntimeString,
    // 键恒 `_str_…` → 非此前缀直接返回,免 Map.get(自编译上百万次 b/bl/lea)。
    _resolveLabelFast(name) {
        const aliases = this.labelAliases;
        if (aliases.size === 0) return name;
        if (name.length < 5 ||
            name.charCodeAt(0) !== 95 || name.charCodeAt(1) !== 115 ||
            name.charCodeAt(2) !== 116 || name.charCodeAt(3) !== 114 ||
            name.charCodeAt(4) !== 95) {
            return name;
        }
        const hit = aliases.get(name);
        if (hit === undefined) return name;
        return this.resolveLabel(name);
    }

    // ==================== 数据移动指令 ====================

    // MOV immediate - 支持完整 64 位立即数
    movImm(rd, imm) {
        if (imm < 0) {
            // 负数用 MOVN
            let inverted = ~imm & 65535;
            let word = 2457862144 | (inverted << 5) | rd; // 0x92800000 MOVN
            this.emit32(word);
            return;
        }

        // MOVZ rd, #imm16, LSL #0
        let imm16 = imm & 65535;
        let word = 3531603968 | (imm16 << 5) | rd; // 0xD2800000
        this.emit32(word);

        // 如果需要更高位，用 MOVK
        let high16 = (imm >> 16) & 65535;
        if (high16 !== 0) {
            let word2 = 4070572032 | (high16 << 5) | rd; // 0xF2A00000 MOVK lsl #16
            this.emit32(word2);
        }

        let high32 = Math.floor(imm / 4294967296) & 65535;
        if (high32 !== 0) {
            let word3 = 4072669184 | (high32 << 5) | rd; // 0xF2C00000 MOVK lsl #32
            this.emit32(word3);
        }

        let high48 = Math.floor(imm / 281474976710656) & 65535;
        if (high48 !== 0) {
            let word4 = 4074766336 | (high48 << 5) | rd; // 0xF2E00000 MOVK lsl #48
            this.emit32(word4);
        }
    }

    movImm32(rd, imm) {
        this.movImm(rd, imm);
    }
    movImm64(rd, imm) {
        // 支持 BigInt 和普通 Number
        if (typeof imm === "bigint") {
            // 按 16-bit 段：仅一段非零 → 单条 MOVZ（hw=0..3 → LSL 0/16/32/48）；
            // 多段 → 最低非零段 MOVZ，其余 MOVK。MOVZ 已清零整寄存器，勿再发清零 MOVK。
            const c0 = Number(imm & 0xffffn);
            const c1 = Number((imm >> 16n) & 0xffffn);
            const c2 = Number((imm >> 32n) & 0xffffn);
            const c3 = Number((imm >> 48n) & 0xffffn);
            let first = -1;
            if (c0 !== 0) first = 0;
            else if (c1 !== 0) first = 1;
            else if (c2 !== 0) first = 2;
            else if (c3 !== 0) first = 3;
            if (first < 0) {
                this.emit32(3531603968 | rd); // MOVZ rd, #0
                return;
            }
            // 免每调用分配 chunks 数组(自编译大量 tagged 常量 movImm64)
            const firstChunk = first === 0 ? c0 : (first === 1 ? c1 : (first === 2 ? c2 : c3));
            this.emit32(3531603968 | (first << 21) | (firstChunk << 5) | rd);
            for (let hw = first + 1; hw < 4; hw++) {
                const c = hw === 1 ? c1 : (hw === 2 ? c2 : c3);
                if (c !== 0) {
                    this.emit32(4068474880 | (hw << 21) | (c << 5) | rd);
                }
            }
        } else {
            this.movImm(rd, imm);
        }
    }

    // MOV register: MOV rd, rn
    // 如果涉及 SP (31)，使用 ADD rd, rn, #0
    // 否则使用 ORR rd, XZR, rn
    movReg(rd, rn) {
        if (rd === 31 || rn === 31) {
            // ADD rd, rn, #0: 1001 0001 0000 0000 0000 00nn nnnd dddd = 0x91000000
            let word = 2432696320 | (rn << 5) | rd; // 0x91000000
            this.emit32(word);
        } else {
            // ORR rd, XZR, rn: 1010 1010 000r rrrr 0000 0011 111d dddd = 0xAA0003E0
            let word = 2852127712 | (rn << 16) | rd; // 0xAA0003E0 已包含 XZR
            this.emit32(word);
        }
    }

    // ==================== 算术指令 ====================

    addImm(rd, rn, imm) {
        if (imm === undefined) {
            imm = rn;
            rn = rd;
        }
        if (imm < 0) {
            this.subImm(rd, rn, -imm);
            return;
        }
        // ARM64 ADD immediate 只支持 12 位立即数 (0-4095)，
        // 另有 sh=1 形式表示 imm12 << 12（覆盖到 0xFFF000）。
        // 注意: ADD (shifted register) 中寄存器号 31 是 XZR 而非 SP，
        // 所以 SP 参与运算时绝不能走 movImm+addReg 路径。
        if (imm > 4095) {
            const lo12 = imm & 4095;
            const hi12 = (imm >> 12) & 4095;
            if (imm <= 0xffffff) {
                let rsrc = rn;
                if (hi12 !== 0) {
                    // ADD rd, rsrc, #hi12, LSL #12  (sh 位 = bit 22)
                    let word = 2432696320 | (1 << 22) | (hi12 << 10) | (rsrc << 5) | rd;
                    this.emit32(word);
                    rsrc = rd;
                }
                if (lo12 !== 0 || hi12 === 0) {
                    let word = 2432696320 | (lo12 << 10) | (rsrc << 5) | rd;
                    this.emit32(word);
                }
            } else {
                if (rd === 31 || rn === 31) {
                    throw new Error("addImm: immediate too large for SP arithmetic: " + imm);
                }
                const tmp = this.scratchReg(rd, rn);
                this.movImm(tmp, imm);
                this.addReg(rd, rn, tmp);
            }
        } else {
            let imm12 = imm & 4095;
            let word = 2432696320 | (imm12 << 10) | (rn << 5) | rd; // 0x91000000
            this.emit32(word);
        }
    }

    subImm(rd, rn, imm) {
        if (imm === undefined) {
            imm = rn;
            rn = rd;
        }
        if (imm < 0) {
            this.addImm(rd, rn, -imm);
            return;
        }
        // ARM64 SUB immediate 只支持 12 位立即数 (0-4095)，
        // 另有 sh=1 形式表示 imm12 << 12（覆盖到 0xFFF000）。
        // 注意: SUB (shifted register) 中寄存器号 31 是 XZR 而非 SP，
        // 所以 SP 参与运算时绝不能走 movImm+subReg 路径。
        if (imm > 4095) {
            const lo12 = imm & 4095;
            const hi12 = (imm >> 12) & 4095;
            if (imm <= 0xffffff) {
                // 拆成 (hi12 << 12) + lo12 两条立即数指令（对 SP 也合法）
                let rsrc = rn;
                if (hi12 !== 0) {
                    // SUB rd, rsrc, #hi12, LSL #12  (sh 位 = bit 22)
                    let word = 3506438144 | (1 << 22) | (hi12 << 10) | (rsrc << 5) | rd;
                    this.emit32(word);
                    rsrc = rd;
                }
                if (lo12 !== 0 || hi12 === 0) {
                    let word = 3506438144 | (lo12 << 10) | (rsrc << 5) | rd;
                    this.emit32(word);
                }
            } else {
                if (rd === 31 || rn === 31) {
                    throw new Error("subImm: immediate too large for SP arithmetic: " + imm);
                }
                const tmp = this.scratchReg(rd, rn);
                this.movImm(tmp, imm);
                this.subReg(rd, rn, tmp);
            }
        } else {
            let imm12 = imm & 4095;
            let word = 3506438144 | (imm12 << 10) | (rn << 5) | rd; // 0xD1000000
            this.emit32(word);
        }
    }

    addReg(rd, rn, rm) {
        let word = 2332033024 | (rm << 16) | (rn << 5) | rd; // 0x8B000000
        this.emit32(word);
    }

    subReg(rd, rn, rm) {
        let word = 3405774848 | (rm << 16) | (rn << 5) | rd; // 0xCB000000
        this.emit32(word);
    }

    neg(rd, rm) {
        let word = 3405774848 | (rm << 16) | (31 << 5) | rd; // 0xCB0003E0
        this.emit32(word);
    }

    mulReg(rd, rn, rm) {
        let word = 2600500224 | (rm << 16) | (31 << 10) | (rn << 5) | rd; // 0x9B007C00
        this.emit32(word);
    }

    // SDIV: 有符号除法
    sdiv(rd, rn, rm) {
        let word = 2596277248 | (rm << 16) | (3 << 10) | (rn << 5) | rd; // 0x9AC00C00
        this.emit32(word);
    }

    // UDIV: 无符号除法
    udiv(rd, rn, rm) {
        let word = 2596275200 | (rm << 16) | (2 << 10) | (rn << 5) | rd; // 0x9AC00800
        this.emit32(word);
    }

    // MUL rd, rn, rm - 乘法 (rd = rn * rm)
    // 实际上是 MADD rd, rn, rm, XZR
    mul(rd, rn, rm) {
        // MADD: 1001 1011 000 Rm 0 Ra Rn Rd
        // XZR = 31
        // 0x9B007C00 = MADD with bit15=0
        let word = 0x9b007c00 | (rm << 16) | (rn << 5) | rd;
        this.emit32(word);
    }

    msub(rd, rn, rm, ra) {
        let word = 2600501248 | (rm << 16) | (ra << 10) | (rn << 5) | rd; // 0x9B008000
        this.emit32(word);
    }

    idivReg(divisor) {
        // x64 兼容：RAX/divisor -> 商在 RAX，余数在 RDX
        // ARM64：用 X0, X1 代替
        this.sdiv(Reg.X9, Reg.X0, divisor);
        this.msub(Reg.X1, Reg.X9, divisor, Reg.X0);
        this.movReg(Reg.X0, Reg.X9);
    }

    // ==================== 逻辑指令 ====================

    andReg(rd, rn, rm) {
        let word = 2315255808 | (rm << 16) | (rn << 5) | rd; // 0x8A000000
        this.emit32(word);
    }

    // AND immediate (用于 64 位寄存器)
    // 注意: ARM64 的立即数编码很复杂，这里简化处理常用值
    andImm(rd, rn, imm) {
        // 装箱值负载掩码 0x0000FFFFFFFFFFFF(取低 48 位指针、清高 16 位 tag)是合法的
        // ARM64 逻辑(bitmask)立即数:64 位元素、48 连续 1、无旋转 → N=1,immr=0,imms=47。
        // 单条 AND(immediate) 取代 `movImm64(scratch,mask)+andReg`(省 4 insn 的掩码物化)。
        // 仅 clobber rd。只经 VM.andMaskReg 的 arm64 分支到达(x64 分支走 andReg,永不触此)。
        // AND(imm) 64-bit 编码: 0x92000000 | N<<22 | immr<<16 | imms<<10 | Rn<<5 | Rd。
        if ((typeof imm === "bigint" && imm === 0x0000ffffffffffffn) ||
            (typeof imm === "number" && imm === 0x0000ffffffffffff)) {
            const word = (0x92000000 | (1 << 22) | (0 << 16) | (47 << 10) | (rn << 5) | rd) >>> 0;
            this.emit32(word);
            return;
        }
        // 对于 -8 的掩码 (0xFFFFFFFFFFFFFFF8)
        // 简化实现：x = (x + 7) & ~7 等价于 x - (x & 7)
        // 或者更简单：使用 x & ~7 = x - (x % 8) 如果 x >= 0
        if (imm === -8) {
            // 8 字节对齐：add x0, x0, 7; and then clear low 3 bits
            // 方法：计算 x0 % 8，然后从 (x0+7) 减去
            // 简化：使用 ubfx 提取低 3 位，然后减去
            // 或者：直接用 AND with bitmask immediate
            // ARM64 AND immediate 编码复杂，简化为：
            // 1. 使用 LSR + LSL 清除低位
            const tmp = this.scratchReg(rd, rn);
            this.movReg(tmp, rn);
            // x10 = x10 >> 3 (逻辑右移)
            this.lsrImm(tmp, tmp, 3);
            // x10 = x10 << 3 (逻辑左移)
            this.lslImm(rd, tmp, 3);
        } else {
            // 默认: 加载立即数到临时寄存器后 AND
            const tmp = this.scratchReg(rd, rn);
            this.movImm(tmp, imm);
            this.andReg(rd, rn, tmp);
        }
    }

    // LSR immediate (逻辑右移)
    lsrImm(rd, rn, shift) {
        // UBFM Xd, Xn, #shift, #63
        // 编码: 1 1 0 1 0 0 1 1 0 1 immr imms Rn Rd
        // immr = shift, imms = 63 for 64-bit
        let immr = shift & 63;
        let imms = 63;
        let word = 0xd3400000 | (immr << 16) | (imms << 10) | (rn << 5) | rd;
        this.emit32(word);
    }

    // LSR register (逻辑右移 - 寄存器)
    lsrReg(rd, rn, rm) {
        // LSRV Xd, Xn, Xm
        // 编码: 1 0 0 1 1 0 1 0 1 1 0 Rm 0 0 1 0 0 1 Rn Rd = 0x9AC02400
        let word = 0x9ac02400 | (rm << 16) | (rn << 5) | rd;
        this.emit32(word);
    }

    // LSL immediate (逻辑左移)
    lslImm(rd, rn, shift) {
        // UBFM Xd, Xn, #(-shift mod 64), #(63-shift)
        // 编码: 1 1 0 1 0 0 1 1 0 1 immr imms Rn Rd
        let immr = (64 - shift) & 63;
        let imms = (63 - shift) & 63;
        let word = 0xd3400000 | (immr << 16) | (imms << 10) | (rn << 5) | rd;
        this.emit32(word);
    }

    // LSL register (逻辑左移 - 寄存器)
    lslReg(rd, rn, rm) {
        // LSLV Xd, Xn, Xm
        // 编码: 1 0 0 1 1 0 1 0 1 1 0 Rm 0 0 1 0 0 0 Rn Rd = 0x9AC02000
        let word = 0x9ac02000 | (rm << 16) | (rn << 5) | rd;
        this.emit32(word);
    }

    // ASR immediate (算术右移 - 保留符号位)
    asrImm(rd, rn, shift) {
        // SBFM Xd, Xn, #shift, #63
        // 编码: 1 0 0 1 0 0 1 1 0 1 immr imms Rn Rd = 0x93400000
        let immr = shift & 63;
        let imms = 63;
        let word = 0x93400000 | (immr << 16) | (imms << 10) | (rn << 5) | rd;
        this.emit32(word);
    }

    // ASR register (算术右移 - 寄存器)
    asrReg(rd, rn, rm) {
        // ASRV Xd, Xn, Xm
        // 编码: 1 0 0 1 1 0 1 0 1 1 0 Rm 0 0 1 0 1 0 Rn Rd = 0x9AC02800
        let word = 0x9ac02800 | (rm << 16) | (rn << 5) | rd;
        this.emit32(word);
    }

    // MVN (按位非): Rd = ~Rm
    mvn(rd, rm) {
        // MVN Xd, Xm = ORN Xd, XZR, Xm
        // 编码: 1 0 1 0 1 0 1 0 0 0 1 Rm 0 0 0 0 0 0 11111 Rd = 0xAA2003E0
        let word = 0xaa2003e0 | (rm << 16) | rd;
        this.emit32(word);
    }

    // NEG (取反): Rd = 0 - Rm
    negReg(rd, rm) {
        // NEG Xd, Xm = SUB Xd, XZR, Xm
        // 编码: 1 1 0 0 1 0 1 1 0 0 0 Rm 0 0 0 0 0 0 11111 Rd = 0xCB0003E0
        let word = 0xcb0003e0 | (rm << 16) | rd;
        this.emit32(word);
    }

    // TST (位测试): Rn AND Rm，只设置标志位
    tst(rn, rm) {
        // TST Xn, Xm = ANDS XZR, Xn, Xm
        // 编码: 1 1 1 0 1 0 1 0 0 0 0 Rm 0 0 0 0 0 0 Rn 11111 = 0xEA00001F
        let word = 0xea00001f | (rm << 16) | (rn << 5);
        this.emit32(word);
    }

    // TST immediate (简化实现)
    tstImm(rn, imm) {
        // 加载立即数到临时寄存器后 TST
        const tmp = this.scratchReg(rn);
        this.movImm(tmp, imm);
        this.tst(rn, tmp);
    }

    // EOR immediate (异或立即数 - 简化实现)
    eorImm(rd, rn, imm) {
        const tmp = this.scratchReg(rd, rn);
        this.movImm(tmp, imm);
        this.eorReg(rd, rn, tmp);
    }

    // BIC (bit clear) rd = rn & ~rm
    bicReg(rd, rn, rm) {
        // BIC X0, X0, X9 = 0x8A290000
        // 编码: 1 0 0 0 1 0 1 0 0 0 1 Rm 0 0 0 0 0 0 Rn Rd
        let word = 2318073856 | (rm << 16) | (rn << 5) | rd; // 0x8A200000
        this.emit32(word);
    }

    orrReg(rd, rn, rm) {
        // ORR (shifted register) 64-bit: sf=1, opc=01, N=0
        // 编码: 1010 1010 000 rm imm6 rn rd = 0xAA000000
        let word = 2852126720 | (rm << 16) | (rn << 5) | rd; // 0xAA000000
        this.emit32(word);
    }

    // ORR immediate (简化实现：使用临时寄存器)
    // 注意：使用 X11 作为临时寄存器，避免和调用代码中可能使用的 X9/X10 冲突
    orrImm(rd, rn, imm) {
        // 特殊情况：imm=0 时 ORR 不改变值，直接返回
        if (imm === 0) {
            if (rd !== rn) {
                this.movReg(rd, rn);
            }
            return;
        }
        // ARM64 ORR immediate 编码复杂，简化为加载立即数后 ORR
        const tmp = this.scratchReg(rd, rn);
        this.movImm(tmp, imm);
        this.orrReg(rd, rn, tmp);
    }

    eorReg(rd, rn, rm) {
        let word = 3388997632 | (rm << 16) | (rn << 5) | rd; // 0xCA000000
        this.emit32(word);
    }

    xorReg(rd, rm) {
        this.eorReg(rd, rd, rm);
    }

    // ==================== 比较指令 ====================

    // Check if immediate fits in 12-bit rotated encoding
    // ARM64 immediate format: 12-bit value rotated by even 0-30 bits
    canEncodeImm(imm) {
        const b = BigInt(imm) & 0xFFFFFFFFFFFFFFFFn;
        if (b === 0n) return true;

        // Check all even rotations 0-30 (ARM64 uses even rotations)
        for (let r = 0; r < 32; r += 2) {
            const rotated = ((b >> BigInt(r)) | (b << BigInt(64 - r))) & 0xFFFFFFFFFFFFFFFFn;
            // `&& rotated >= 0n`：表示无关消歧。rotated 掩到 64 位可含高位，自举产物的
            // BigInt 关系比较改为有符号后，高位值会被当负数 → `<= 0xFFF` 误真;加 `>=0n`
            // 守卫在有符号语义下排除之（gen0/node 恒真，无行为改变）。
            if (rotated <= 0xFFFn && rotated >= 0n) return true;
        }
        return false;
    }

    cmpImm(rn, imm) {
        // For 0, always works
        if (imm === 0) {
            let word = (0xF100001F | (rn << 5)) >>> 0;
            this.emit32(word);
            return;
        }

        // Check if immediate fits in 12-bit rotated encoding
        if (!this.canEncodeImm(imm)) {
            // For -1, use "movn x16, #0" (move negative of 0 = all 1s) + cmpReg
            if (imm === -1) {
                // movn x16, #0 encodes as 0x92800010
                this.emit32(0x92800010);
                this.cmpReg(rn, 16);
                return;
            }

            // For non-encodable immediates, use movImm64 to load full value into X16
            // then compare registers
            this.movImm64(16, BigInt(imm)); // Use X16 as temp register
            this.cmpReg(rn, 16);
            return;
        }

        // Standard case - 12-bit immediate
        let imm12 = Number(BigInt(imm) & 0xFFFn);
        let word = (0xF100001F | (imm12 << 10) | (rn << 5)) >>> 0;
        this.emit32(word);
    }

    cmpReg(rn, rm) {
        let word = 3942645791 | (rm << 16) | (rn << 5); // 0xEB00001F
        this.emit32(word);
    }

    testReg(rn, rm) {
        let word = 3925868575 | (rm << 16) | (rn << 5); // 0xEA00001F
        this.emit32(word);
    }

    // ==================== 浮点指令 (IEEE 754 double) ====================

    // FMOV Dd, Xn - 从通用寄存器移动到浮点寄存器 (64-bit)
    // GPR to FPR: opcode 0x9E670000
    // Dn(4:0) = fd, Xm(9:5) = xn
    fmovToFloat(fd, xn) {
        let word = 0x9e670000 | (xn << 5) | fd;
        this.emit32(word);
    }

    // fmovFromInt - fmovToFloat 的别名（从整数寄存器移动到浮点寄存器）
    fmovFromInt(fd, xn) {
        let word = 0x9e670000 | (xn << 5) | fd;
        this.emit32(word);
    }

    // FMOV Sd, Wn - 从通用寄存器移动到浮点寄存器 (32-bit single)
    fmovToFloatSingle(fd, wn) {
        // 0 0 0 1 1 1 1 0 0 0 1 0 0 1 1 1 0 0 0 0 0 0 Rn Rd = 0x1E270000
        let word = 0x1e270000 | (wn << 5) | fd;
        this.emit32(word);
    }

    // FMOV Xd, Dn - 从浮点寄存器移动到通用寄存器 (64-bit)
    // FPR to GPR: opcode 0x9E660000 (bit 20 = 1)
    // Xd(4:0) = xd, Dn(9:5) = fn
    fmovToInt(xd, fn) {
        let word = 0x9e660000 | (fn << 5) | xd;
        this.emit32(word);
    }

    // FCVTZS Xd, Dn - 将浮点数转换为有符号整数（截断向零）
    // 用于 boxFPAsNumber：将 float 结果转换为整数再存储
    // 编码: 0x1E630000 | (dn << 5) | xd
    f2i(xd, fn) {
        let word = 0x1e630000 | (fn << 5) | xd;
        this.emit32(word);
    }

    // FMOV Wd, Sn - 从单精度浮点寄存器移动到通用寄存器 (32-bit)
    fmovToIntSingle(wd, fn) {
        // 0 0 0 1 1 1 1 0 0 0 1 0 0 1 1 0 0 0 0 0 0 0 Rn Rd = 0x1E260000
        let word = 0x1e260000 | (fn << 5) | wd;
        this.emit32(word);
    }

    // FMOV Dd, Dm - 浮点寄存器之间移动
    fmovReg(fd, fm) {
        // 0 0 0 1 1 1 1 0 0 1 1 0 0 0 0 0 0 1 0 0 0 0 Rm Rd = 0x1E604000
        let word = 0x1e604000 | (fm << 5) | fd;
        this.emit32(word);
    }

    // FCVT - 浮点类型转换
    // from/to: "s" = single (32-bit), "d" = double (64-bit)
    fcvt(fd, fn, from, to) {
        // FCVT Dd, Sn: 0 0 0 1 1 1 1 0 0 0 1 0 0 0 1 0 1 1 0 0 0 0 Rn Rd = 0x1E22C000
        // FCVT Sd, Dn: 0 0 0 1 1 1 1 0 0 1 1 0 0 0 1 0 0 1 0 0 0 0 Rn Rd = 0x1E624000
        let word;
        if (from === "s" && to === "d") {
            // single to double
            word = 0x1e22c000 | (fn << 5) | fd;
        } else if (from === "d" && to === "s") {
            // double to single
            word = 0x1e624000 | (fn << 5) | fd;
        } else {
            throw new Error(`Unsupported FCVT conversion: ${from} -> ${to}`);
        }
        this.emit32(word);
    }

    // LDR Dd, [Xn, #imm] - 加载双精度浮点数
    fldr(fd, xn, offset) {
        // 偏移必须是 8 的倍数，编码时除以 8
        let imm12 = (offset / 8) & 0xfff;
        // 1 1 1 1 1 1 0 1 0 1 imm12 Rn Rt = 0xFD400000
        let word = 0xfd400000 | (imm12 << 10) | (xn << 5) | fd;
        this.emit32(word);
    }

    // STR Dd, [Xn, #imm] - 存储双精度浮点数
    fstr(fd, xn, offset) {
        // 偏移必须是 8 的倍数
        let imm12 = (offset / 8) & 0xfff;
        // 1 1 1 1 1 1 0 1 0 0 imm12 Rn Rt = 0xFD000000
        let word = 0xfd000000 | (imm12 << 10) | (xn << 5) | fd;
        this.emit32(word);
    }

    // FADD Dd, Dn, Dm - 浮点加法
    fadd(fd, fn, fm) {
        // 0 0 0 1 1 1 1 0 0 1 1 Rm 0 0 1 0 1 0 Rn Rd = 0x1E602800
        let word = 0x1e602800 | (fm << 16) | (fn << 5) | fd;
        this.emit32(word);
    }

    // FSUB Dd, Dn, Dm - 浮点减法
    fsub(fd, fn, fm) {
        // 0 0 0 1 1 1 1 0 0 1 1 Rm 0 0 1 1 1 0 Rn Rd = 0x1E603800
        let word = 0x1e603800 | (fm << 16) | (fn << 5) | fd;
        this.emit32(word);
    }

    // FMUL Dd, Dn, Dm - 浮点乘法 (64-bit)
    fmul(fd, fn, fm) {
        // FMUL Dd, Dn, Dm: 0 0 0 1 1 1 1 0 0 1 1 Rm 0 0 0 0 1 0 Rn Rd
        // opcode = 0x1E600800, type bit (bit 10) = 0 for 2-source form
        let word = 0x1e600800 | (fm << 16) | (fn << 5) | fd;
        this.emit32(word);
    }

    // FDIV Dd, Dn, Dm - 浮点除法
    fdiv(fd, fn, fm) {
        // 0 0 0 1 1 1 1 0 0 1 1 Rm 0 0 0 1 1 0 Rn Rd = 0x1E601800
        let word = 0x1e601800 | (fm << 16) | (fn << 5) | fd;
        this.emit32(word);
    }

    // FCVTZS Xd, Dn - 浮点转整数（向零截断）
    fcvtzs(xd, fn) {
        // 1 0 0 1 1 1 1 0 0 1 1 1 1 0 0 0 0 0 0 0 0 0 Rn Rd = 0x9E780000
        let word = 0x9e780000 | (fn << 5) | xd;
        this.emit32(word);
    }

    // SCVTF Dd, Xn - 整数转浮点（有符号）
    scvtf(fd, xn) {
        // 1 0 0 1 1 1 1 0 0 1 1 0 0 0 1 0 0 0 0 0 0 0 Rn Rd = 0x9E620000 (SCVTF.2D)
        let word = 0x9e620000 | (xn << 5) | fd;
        this.emit32(word);
    }

    // FCMP Dn, Dm - 浮点比较
    fcmp(fn, fm) {
        // 0 0 0 1 1 1 1 0 0 1 1 Rm 0 0 1 0 0 0 Rn 0 0 0 0 0 = 0x1E602000
        let word = 0x1e602000 | (fm << 16) | (fn << 5);
        this.emit32(word);
    }

    // FCMPZ Dn, #0.0 - 与零比较
    fcmpZero(fn) {
        // FCMPZ encoding: 0x1E602108 | (Rn << 5) with z-flag at bit 3
        let word = 0x1e602108 | (fn << 5);
        this.emit32(word);
    }

    // FNEG Dd, Dn - 浮点取反
    fneg(fd, fn) {
        // 0 0 0 1 1 1 1 0 0 1 1 0 0 0 0 1 0 1 0 0 0 0 Rn Rd = 0x1E614000
        let word = 0x1e614000 | (fn << 5) | fd;
        this.emit32(word);
    }

    // FABS Dd, Dn - 浮点绝对值
    fabs(fd, fn) {
        // 0 0 0 1 1 1 1 0 0 1 1 0 0 0 0 0 1 1 0 0 0 0 Rn Rd = 0x1E60C000
        let word = 0x1e60c000 | (fn << 5) | fd;
        this.emit32(word);
    }

    // FSQRT Dd, Dn - 浮点平方根
    fsqrt(fd, fn) {
        // 0 0 0 1 1 1 1 0 0 1 1 0 0 0 0 1 1 1 0 0 0 0 Rn Rd = 0x1E61C000
        let word = 0x1e61c000 | (fn << 5) | fd;
        this.emit32(word);
    }

    // FRINTZ Dd, Dn - 浮点向零取整
    frintz(fd, fn) {
        // 0x1E65C000 for rounding toward zero
        let word = 0x1e65c000 | (fn << 5) | fd;
        this.emit32(word);
    }

    // FRINTM Dd, Dn - 浮点向下取整 (floor)
    frintm(fd, fn) {
        // 0x1E654000 for rounding toward -infinity (FRINTM)
        let word = 0x1e654000 | (fn << 5) | fd;
        this.emit32(word);
    }

    // FRINTP Dd, Dn - 浮点向上取整 (ceil)
    frintp(fd, fn) {
        // 0x1E64C000 for rounding toward +infinity
        let word = 0x1e64c000 | (fn << 5) | fd;
        this.emit32(word);
    }

    // FRINTA Dd, Dn - 浮点四舍五入 (ties away from zero)
    frinta(fd, fn) {
        // 0x1E664000 for rounding to nearest, ties away from zero
        let word = 0x1e664000 | (fn << 5) | fd;
        this.emit32(word);
    }

    // ==================== 分支指令 ====================

    b(labelName) {
        let fullName = labelName;
        // charCodeAt(0)===95 → '_'；免造临时串
        if (labelName.charCodeAt(0) !== 95) {
            fullName = this.labelPrefix + labelName;
        }
        fullName = this._resolveLabelFast(fullName);
        const offset = this.code.length;
        // 后向/已定义标签:相对位移与 VAddr 无关,即时编码免入 fixup 队列
        // (自编译 ~200 万条 bl 中绝大部分目标已在 labels 中)。
        const labelOffset = this.labels.get(fullName);
        if (labelOffset !== undefined) {
            const imm26 = ((labelOffset - offset) / 4) & 67108863;
            this.emit32(335544320 | imm26); // 0x14000000 | imm26
            return;
        }
        // 前向 B:记入 _fwdB,等 label() 回填;未定义的在 fixupAll 开头转入 pendingFixups
        if (!this._fwdB) this._fwdB = new Map();
        let list = this._fwdB.get(fullName);
        if (!list) {
            list = [];
            this._fwdB.set(fullName, list);
        }
        list.push(offset);
        this.emit32(335544320); // 0x14000000
    }

    bcond(cond, labelName) {
        // B.cond 的 imm19 只有 ±1MB 范围，代码量超过后 fixup 静默截断
        // 会产生乱跳。统一改为「反条件跳过下一条 + 无条件 B」组合：
        //   b.<inv> +8   (跳过下一条指令，无需 fixup)
        //   b <label>    (imm26, ±128MB)
        // ARM64 条件码约定：cond ^ 1 即反条件 (EQ/NE, LT/GE, GT/LE, ...)
        const inv = cond ^ 1;
        this.emit32(1409286144 | (2 << 5) | inv); // b.<inv> .+8
        this.b(labelName);
    }

    bl(labelName) {
        if (typeof labelName !== "string") {
            throw new Error(`bl: labelName must be a string, got ${typeof labelName}: ${labelName}`);
        }
        let fullName = labelName;
        if (labelName.charCodeAt(0) !== 95) {
            fullName = this.labelPrefix + labelName;
        }
        fullName = this._resolveLabelFast(fullName);
        const offset = this.code.length;
        const labelOffset = this.labels.get(fullName);
        if (labelOffset !== undefined) {
            const imm26 = ((labelOffset - offset) / 4) & 67108863;
            this.emit32(2483027968 | imm26); // 0x94000000 | imm26
            return;
        }
        this.pendingFixups.pushRaw(FIXUP_TYPE.bl, offset, fullName);
        this.emit32(2483027968); // 0x94000000
    }

    call(labelName) {
        this.bl(labelName);
    }
    jmp(labelName) {
        this.b(labelName);
    }

    beq(labelName) {
        this.bcond(0, labelName);
    }
    bne(labelName) {
        this.bcond(1, labelName);
    }
    blt(labelName) {
        this.bcond(11, labelName);
    }
    bge(labelName) {
        this.bcond(10, labelName);
    }
    bgt(labelName) {
        this.bcond(12, labelName);
    }
    ble(labelName) {
        this.bcond(13, labelName);
    }
    // 无符号比较分支
    blo(labelName) {
        // LO (unsigned lower): C=0, condition code = 3
        this.bcond(3, labelName);
    }
    bhs(labelName) {
        // HS (unsigned higher or same): C=1, condition code = 2
        this.bcond(2, labelName);
    }
    bhi(labelName) {
        // HI (unsigned higher): C=1 and Z=0, condition code = 8
        this.bcond(8, labelName);
    }
    bls(labelName) {
        // LS (unsigned lower or same): C=0 or Z=1, condition code = 9
        this.bcond(9, labelName);
    }
    bvs(labelName) {
        // VS (overflow set): V=1, condition code = 6
        // fcmp 后 unordered(任一操作数 NaN)置 V=1 → 用作 NaN 分支
        this.bcond(6, labelName);
    }

    je(labelName) {
        this.beq(labelName);
    }
    jne(labelName) {
        this.bne(labelName);
    }
    jl(labelName) {
        this.blt(labelName);
    }
    jge(labelName) {
        this.bge(labelName);
    }
    jg(labelName) {
        this.bgt(labelName);
    }
    jle(labelName) {
        this.ble(labelName);
    }

    // CBZ - Compare and Branch if Zero
    // CBZ Xt, label
    cbz(rt, labelName) {
        let fullName = labelName;
        if (labelName.charCodeAt(0) !== 95) {
            fullName = this.labelPrefix + labelName;
        }
        if (this.labelAliases.size !== 0) {
            fullName = this._resolveLabelFast(fullName);
        }
        const offset = this.code.length;
        const labelOffset = this.labels.get(fullName);
        if (labelOffset !== undefined) {
            const delta = (labelOffset - offset) / 4;
            if (delta >= -262144 && delta <= 262143) {
                this.emit32(0xb4000000 | ((delta & 524287) << 5) | rt);
                return;
            }
        }
        this.pendingFixups.pushRaw(FIXUP_TYPE.cbz, offset, fullName);
        // CBZ X: 1011010 0 imm19 Rt = 0xB4000000
        this.emit32(0xb4000000 | rt);
    }

    // CBNZ - Compare and Branch if Non-Zero
    // CBNZ Xt, label
    cbnz(rt, labelName) {
        let fullName = labelName;
        if (labelName.charCodeAt(0) !== 95) {
            fullName = this.labelPrefix + labelName;
        }
        if (this.labelAliases.size !== 0) {
            fullName = this._resolveLabelFast(fullName);
        }
        const offset = this.code.length;
        const labelOffset = this.labels.get(fullName);
        if (labelOffset !== undefined) {
            const delta = (labelOffset - offset) / 4;
            if (delta >= -262144 && delta <= 262143) {
                this.emit32(0xb5000000 | ((delta & 524287) << 5) | rt);
                return;
            }
        }
        this.pendingFixups.pushRaw(FIXUP_TYPE.cbnz, offset, fullName);
        // CBNZ X: 1011010 1 imm19 Rt = 0xB5000000
        this.emit32(0xb5000000 | rt);
    }

    // ==================== 原子指令 (用于多线程同步) ====================

    // LDAXR - Load-Acquire Exclusive Register (64-bit)
    // LDAXR Xt, [Xn]
    ldaxr(rt, rn) {
        // 11 001000 0 1 0 11111 1 11111 Rn Rt
        // = 0xC85FFC00 | (rn << 5) | rt
        this.emit32(0xc85ffc00 | (rn << 5) | rt);
    }

    // STXR - Store Exclusive Register (64-bit)
    // STXR Ws, Xt, [Xn]
    // Ws = status (0=success, 1=fail)
    stxr(rs, rt, rn) {
        // 11 001000 0 0 0 Rs 0 11111 Rn Rt
        // = 0xC8007C00 | (rs << 16) | (rn << 5) | rt
        this.emit32(0xc8007c00 | (rs << 16) | (rn << 5) | rt);
    }

    // STLR - Store-Release Register (64-bit)
    // STLR Xt, [Xn]
    stlr(rt, rn) {
        // 11 001000 1 0 0 11111 1 11111 Rn Rt
        // = 0xC89FFC00 | (rn << 5) | rt
        this.emit32(0xc89ffc00 | (rn << 5) | rt);
    }

    // LDAR - Load-Acquire Register (64-bit)
    // LDAR Xt, [Xn]
    ldar(rt, rn) {
        // 11 001000 1 1 0 11111 1 11111 Rn Rt
        // = 0xC8DFFC00 | (rn << 5) | rt
        this.emit32(0xc8dffc00 | (rn << 5) | rt);
    }

    // ==================== [M3] 原子 RMW 原语(LL/SC)====================
    // 多 M 共享槽的自旋锁/原子计数用。仅 linux-arm64 并行调度器发射(见
    // runtime/core/parallel_sched.js);GOMAXPROCS=1 与其它后端从不触达。
    // 编码为 ARMv8 基础独占访问(不依赖 LSE 扩展),qemu/所有 armv8 内核可用。
    // LDAXR Xt, [Xn](load-exclusive + acquire):0xC85FFC00 | (Rn<<5) | Rt
    ldaxr(rt, rn) { this.emit32((0xc85ffc00 | (rn << 5) | rt) >>> 0); }
    // STLXR Ws, Xt, [Xn](store-exclusive + release;Ws=状态,0=成功):
    //   0xC800FC00 | (Rs<<16) | (Rn<<5) | Rt
    stlxr(rs, rt, rn) { this.emit32((0xc800fc00 | (rs << 16) | (rn << 5) | rt) >>> 0); }
    // CLREX:放弃当前独占监视器(CAS 失配路径)。0xD5033F5F
    clrex() { this.emit32(0xd5033f5f); }
    // STLR Xt, [Xn](store-release,自旋锁解锁):0xC89FFC00 | (Rn<<5) | Rt
    stlr(rt, rn) { this.emit32((0xc89ffc00 | (rn << 5) | rt) >>> 0); }

    ret() {
        this.emit32(3596551104); // 0xD65F03C0
    }

    // [引擎库] cache 维护:写码后须刷 D-cache 到统一点 + 失效 I-cache,否则 arm64 可能
    // 执行到陈旧字节(SIGILL)。DC CVAU/IC IVAU/DSB ISH/ISB。rt = 持地址的寄存器号。
    dcCvau(rt) { this.emit32((0xD50B7B20 | (rt & 31)) >>> 0); } // DC CVAU, Xt
    icIvau(rt) { this.emit32((0xD50B7520 | (rt & 31)) >>> 0); } // IC IVAU, Xt
    dsbIsh() { this.emit32(0xD5033B9F); }
    isb() { this.emit32(0xD5033FDF); }

    // BR Xn - 间接跳转到寄存器中的地址
    br(rn) {
        // BR Xn: 0xD61F0000 | (rn << 5)
        let word = 3592355840 | (rn << 5); // 0xD61F0000
        this.emit32(word);
    }

    // BLR Xn - 间接调用寄存器中的地址
    blr(rn) {
        // BLR Xn: 0xD63F0000 | (rn << 5)
        let word = 3594452992 | (rn << 5); // 0xD63F0000
        this.emit32(word);
    }

    // 调用 IAT 中的函数 (Windows)
    // slotIndex: IAT 槽索引 (0=VirtualAlloc, 1=GetStdHandle, 2=WriteConsoleA, 3=ExitProcess)
    callIAT(slotIndex) {
        // 生成 ADRP + LDR + BLR 序列
        this.pendingFixups.pushRaw(FIXUP_TYPE.iat_stub, this.code.length, undefined, { slotIndex: slotIndex });
        // ADRP X16, <iat_page> - 占位符
        this.emit32(2415919120); // 0x90000010
        // LDR X16, [X16, #offset] - 占位符
        this.emit32(4181721360); // 0xF9400210
        // BLR X16
        this.emit32(3594453504); // 0xD63F0200
    }

    // ==================== 内存访问指令 ====================

    // STP pre-indexed: STP Xt1, Xt2, [Xn, #imm]!
    // 基础编码: 0xA9800000
    stpPre(rt1, rt2, rn, offset) {
        let imm7 = Math.floor(offset / 8) & 127;
        let word = 2843738112 | (imm7 << 15) | (rt2 << 10) | (rn << 5) | rt1; // 0xA9800000
        this.emit32(word);
    }

    // STP signed offset: STP Xt1, Xt2, [Xn, #imm]
    // 基础编码: 0xA9000000
    stp(rt1, rt2, rn, offset) {
        let imm7 = Math.floor(offset / 8) & 127;
        let word = 2835349504 | (imm7 << 15) | (rt2 << 10) | (rn << 5) | rt1; // 0xA9000000
        this.emit32(word);
    }

    // LDP post-indexed: LDP Xt1, Xt2, [Xn], #imm
    // 基础编码: 0xA8C00000
    ldpPost(rt1, rt2, rn, offset) {
        let imm7 = Math.floor(offset / 8) & 127;
        let word = 2831155200 | (imm7 << 15) | (rt2 << 10) | (rn << 5) | rt1; // 0xA8C00000
        this.emit32(word);
    }

    // LDP signed offset: LDP Xt1, Xt2, [Xn, #imm]
    // 基础编码: 0xA9400000
    ldp(rt1, rt2, rn, offset) {
        let imm7 = Math.floor(offset / 8) & 127;
        let word = 2839543808 | (imm7 << 15) | (rt2 << 10) | (rn << 5) | rt1; // 0xA9400000
        this.emit32(word);
    }

    // LDP pre-indexed: LDP Xt1, Xt2, [Xn, #imm]!
    // 基础编码: 0xA9C00000
    ldpPre(rt1, rt2, rn, offset) {
        let imm7 = Math.floor(offset / 8) & 127;
        let word = 2841737216 | (imm7 << 15) | (rt2 << 10) | (rn << 5) | rt1; // 0xA9C00000
        this.emit32(word);
    }

    str(rt, rn, offset) {
        let imm12 = Math.floor(offset / 8) & 4095;
        let word = 4177526784 | (imm12 << 10) | (rn << 5) | rt; // 0xF9000000
        this.emit32(word);
    }

    ldr(rt, rn, offset) {
        let imm12 = (offset / 8) & 4095;
        let word = 4181721088 | (imm12 << 10) | (rn << 5) | rt; // 0xF9400000
        this.emit32(word);
    }

    // STUR (store with unscaled offset)
    stur(rt, rn, offset) {
        let imm9 = offset & 511;
        let word = 4161798144 | (imm9 << 12) | (rn << 5) | rt; // 0xF8000000
        this.emit32(word);
    }

    // LDUR (load with unscaled offset)
    ldur(rt, rn, offset) {
        let imm9 = offset & 511;
        let word = 4164943872 | (imm9 << 12) | (rn << 5) | rt; // 0xF8400000
        this.emit32(word);
    }

    // STR pre-indexed: STR Xt, [Xn, #imm]! (immediate post-index)
    // 基础编码: 0xF8000800
    strPre(rt, rn, offset) {
        let imm9 = offset & 511;
        let word = 4160759808 | (imm9 << 12) | (rn << 5) | rt; // 0xF8000800
        this.emit32(word);
    }

    // LDR post-indexed: LDR Xt, [Xn], #imm
    // 基础编码: 0xF8400800
    ldrPost(rt, rn, offset) {
        let imm9 = offset & 511;
        let word = 4164984832 | (imm9 << 12) | (rn << 5) | rt; // 0xF8400800
        this.emit32(word);
    }

    strb(rt, rn, offset) {
        let imm12 = offset & 4095;
        let word = 956301312 | (imm12 << 10) | (rn << 5) | rt; // 0x39000000
        this.emit32(word);
    }

    // STRH (store halfword, 2 bytes)
    strh(rt, rn, offset) {
        // STRH Wt, [Xn, #imm]
        // 编码: 0x79000000 | (imm12 << 10) | (rn << 5) | rt
        // imm12 = offset / 2
        let imm12 = (offset >> 1) & 4095;
        let word = 0x79000000 | (imm12 << 10) | (rn << 5) | rt;
        this.emit32(word);
    }

    // LDRH (load halfword, 2 bytes, zero-extend)
    ldrh(rt, rn, offset) {
        // LDRH Wt, [Xn, #imm]
        // 编码: 0x79400000 | (imm12 << 10) | (rn << 5) | rt
        // imm12 = offset / 2
        let imm12 = (offset >> 1) & 4095;
        let word = 0x79400000 | (imm12 << 10) | (rn << 5) | rt;
        this.emit32(word);
    }

    ldrb(rt, rn, offset) {
        let imm12 = offset & 4095;
        let word = 0x39400000 | (imm12 << 10) | (rn << 5) | rt; // LDRB Wt, [Xn, #imm]
        this.emit32(word);
    }

    // STR Wt / LDR Wt (4 字节)。backend load32/store32 调用。
    // 对齐正偏移走 unsigned scaled;[-256,255] 未对齐/负偏移走 STUR/LDUR。
    strw(rt, rn, offset) {
        if (offset >= 0 && (offset & 3) === 0 && offset < 16384) {
            const imm12 = (offset >> 2) & 4095;
            this.emit32((0xB9000000 | (imm12 << 10) | (rn << 5) | rt) >>> 0);
            return;
        }
        const imm9 = offset & 511;
        this.emit32((0xB8000000 | (imm9 << 12) | (rn << 5) | rt) >>> 0);
    }

    ldrw(rt, rn, offset) {
        if (offset >= 0 && (offset & 3) === 0 && offset < 16384) {
            const imm12 = (offset >> 2) & 4095;
            this.emit32((0xB9400000 | (imm12 << 10) | (rn << 5) | rt) >>> 0);
            return;
        }
        const imm9 = offset & 511;
        this.emit32((0xB8400000 | (imm9 << 12) | (rn << 5) | rt) >>> 0);
    }

    // LDURB (load byte with unscaled offset)
    ldurb(rt, rn, offset) {
        let imm9 = offset & 511;
        let word = 0x38400000 | (imm9 << 12) | (rn << 5) | rt;
        this.emit32(word);
    }

    // LDRB with register offset: LDRB Wt, [Xn, Xm]
    ldrbReg(rt, rn, rm) {
        // LDRB Wt, [Xn, Xm, LSL #0]
        // 编码: 0011 1000 011 Rm option S 10 Rn Rt
        // option=011 (LSL), S=0
        // 0x38606800 | rm << 16 | rn << 5 | rt
        let word = 945907712 | (rm << 16) | (rn << 5) | rt; // 0x38616800
        this.emit32(word);
    }

    // STURB (store byte with unscaled offset)
    sturb(rt, rn, offset) {
        let imm9 = offset & 511;
        let word = 939524096 | (imm9 << 12) | (rn << 5) | rt; // 0x38000000
        this.emit32(word);
    }

    // STRB with register offset: STRB Wt, [Xn, Xm]
    strbReg(rt, rn, rm) {
        // STRB Wt, [Xn, Xm, LSL #0]
        // 编码: 0011 1000 001 Rm option S 10 Rn Rt
        // option=011 (LSL), S=0
        // 0x38206800 | rm << 16 | rn << 5 | rt
        let word = 941647872 | (rm << 16) | (rn << 5) | rt; // 0x38206800
        this.emit32(word);
    }

    movStoreOffset(base, offset, src) {
        if (offset < 0) {
            this.stur(src, base, offset);
        } else {
            this.str(src, base, offset);
        }
    }

    movLoadOffset(dest, base, offset) {
        if (offset < 0) {
            this.ldur(dest, base, offset);
        } else {
            this.ldr(dest, base, offset);
        }
    }

    movStoreOffset8(base, offset, src) {
        if (offset < 0) {
            this.sturb(src, base, offset);
        } else {
            this.strb(src, base, offset);
        }
    }

    push(rt1, rt2) {
        if (rt2 === undefined || rt2 === rt1) {
            // 单寄存器 push: str rt1, [sp, #-16]!
            // 0xF81F0FE0 = 4162654176 for x0
            // 基础编码: F8 1F 0F E0 (对于 rt=0, rn=SP=31)
            // STR pre-index: 11 111000 00 0 imm9 11 Rn Rt
            // imm9 = -16 的 9 位补码 = 0x1F0 = 496
            let imm9 = -16 & 511; // 0x1F0
            let word = 4160749568 | (imm9 << 12) | (3 << 10) | (31 << 5) | rt1;
            // 0xF8000000 | (0x1F0 << 12) | (3 << 10) | (31 << 5) | rt1
            // = 0xF8000000 | 0x001F0000 | 0x00000C00 | 0x000003E0 | rt1
            // = 0xF81F0FE0 | rt1
            this.emit32(word);
        } else {
            this.stpPre(rt1, rt2, Reg.SP, -16);
        }
    }

    pop(rt1, rt2) {
        if (rt2 === undefined || rt2 === rt1) {
            // 单寄存器 pop: ldr rt1, [sp], #16
            // 0xF84107E0 = 4164986848 for x0
            // LDR post-index: 11 111000 01 0 imm9 01 Rn Rt
            // imm9 = 16 = 0x010
            let imm9 = 16 & 511;
            let word = 4164943872 | (imm9 << 12) | (1 << 10) | (31 << 5) | rt1;
            // 0xF8400000 | (0x010 << 12) | (1 << 10) | (31 << 5) | rt1
            // = 0xF8400000 | 0x00010000 | 0x00000400 | 0x000003E0 | rt1
            // = 0xF84107E0 | rt1
            this.emit32(word);
        } else {
            this.ldpPost(rt1, rt2, Reg.SP, 16);
        }
    }

    // ==================== 地址加载指令 ====================

    adr(rd, labelName) {
        let fullName = labelName;
        if (labelName.charCodeAt(0) !== 95) {
            fullName = this.labelPrefix + labelName;
        }
        this.pendingFixups.pushRaw(FIXUP_TYPE.adr, this.code.length, fullName);
        this.emit32(0x10000000 | rd); // ADR opcode
    }

    adrp(rd, labelName) {
        let fullName = labelName;
        if (labelName.charCodeAt(0) !== 95) {
            fullName = this.labelPrefix + labelName;
        }
        this.pendingFixups.pushRaw(FIXUP_TYPE.adrp, this.code.length, fullName);
        this.emit32(2415919104 | rd); // 0x90000000
    }

    leaRipRel(rd, labelName) {
        // Use ADRP + ADD instead of ADR for better compatibility
        // ADRP: Xd = page of label
        // ADD: Xd = Xd + offset within page
        let fullName = labelName;
        if (labelName.charCodeAt(0) !== 95) {
            fullName = this.labelPrefix + labelName;
        }
        this.pendingFixups.pushRaw(FIXUP_TYPE.adrp, this.code.length, fullName, rd);
        this.emit32(2415919104 | rd); // 0x90000000 | rd (ADRP)
        this.emit32(0x91000000 | (rd << 5) | rd); // ADD Xd, Xd, #0
    }

    // ==================== 系统调用 ====================

    svc(imm) {
        let word = 3556769793 | ((imm & 65535) << 5); // 0xD4000001
        this.emit32(word);
    }

    syscall() {
        this.svc(128); // macOS: SVC #0x80
    }

    // macOS BSD 系统调用错误约定:失败时置进位标志(C)、X0=正 errno。紧跟 svc 之后
    // 发 CSNEG x0,x0,x0,CC:进位清(成功)→ x0 不变;进位置(失败)→ x0 = -x0(负 errno)。
    // 使返回值统一为 Linux 风格(负=错误),让 `fd < 0` 判定在 macOS 也正确。
    // 编码:CSNEG(64位) 基址 0xDA800400,cond=CC(0b0011)<<12 → 0xDA803400。
    syscallNegErrno() {
        this.emit32(0xDA803400);
    }

    // ==================== 数据段操作 ====================

    // 注册运行时字符串，使其与 addString 共享数据
    // runtimeLabel: 运行时使用的标签名（如 "_str_object_type"）
    // value: 字符串值（如 "object"）
    registerRuntimeString(runtimeLabel, value) {
        // 单次查找(has+get 两次全串哈希→一次;驻留热路径)
        let labelIndex = this._stringInternMap.get(value);
        if (labelIndex !== undefined) {
            let actualLabel = this._stringLabels[labelIndex];
            // 创建别名：runtimeLabel -> actualLabel
            this.labelAliases.set(runtimeLabel, actualLabel);
            return;
        }
        // 值不存在，添加新字符串
        labelIndex = this.strings.length;
        let actualLabel = "_str_" + labelIndex;
        this.strings.push(value);
        this._stringLabels.push(actualLabel);
        this._stringInternMap.set(value, labelIndex);
        // 创建别名
        this.labelAliases.set(runtimeLabel, actualLabel);
    }

    addString(str) {
        // 单次查找(has+get 两次全串哈希→一次;驻留热路径)
        let labelIndex = this._stringInternMap.get(str);
        if (labelIndex !== undefined) {
            return this._stringLabels[labelIndex];
        }
        // 新字符串，添加到列表
        labelIndex = this.strings.length;
        let labelName = "_str_" + labelIndex;
        this.strings.push(str);
        this._stringLabels.push(labelName);
        this._stringInternMap.set(str, labelIndex);
        return labelName;
    }

    // 添加数据标签
    addDataLabel(name) {
        this.dataLabels = this.dataLabels || [];
        this._dataLabelNameSet = this._dataLabelNameSet || new Set();
        this._dataLabelNameSet.add(name);
        this.dataLabels.push({ name: name, offset: -1 });
    }

    // 添加单字节数据
    addDataByte(value) {
        if (this.dataLabels && this.dataLabels.length > 0) {
            let lastLabel = this.dataLabels[this.dataLabels.length - 1];
            if (lastLabel.offset === -1) {
                lastLabel.offset = this.data.length;
            }
        }
        this.data.push(value & 255);
    }

    // 添加 8 字节数据
    addDataQword(value) {
        // 确保 8 字节对齐（arm64 对未对齐的 64-bit load/store 可能 SIGBUS）
        const misalign = this.data.length & 7;
        if (misalign !== 0) {
            const pad = 8 - misalign;
            for (let i = 0; i < pad; i++) {
                this.data.push(0);
            }
        }

        if (this.dataLabels && this.dataLabels.length > 0) {
            let lastLabel = this.dataLabels[this.dataLabels.length - 1];
            if (lastLabel.offset === -1) {
                lastLabel.offset = this.data.length;
            }
        }
        if (typeof value === "bigint") {
            let val = value;
            for (let i = 0; i < 8; i++) {
                this.data.push(Number(val & 0xffn));
                val = val >> 8n;
            }
            return;
        }
        if (value >= 0 && value <= 0xFFFFFFFF) {
            const lo = value >>> 0;
            this.data.push(lo & 255, (lo >>> 8) & 255, (lo >>> 16) & 255, (lo >>> 24) & 255);
            this.data.push(0, 0, 0, 0);
            return;
        }
        if (value < 0 && value >= -0x80000000) {
            const lo = value | 0;
            this.data.push(lo & 255, (lo >>> 8) & 255, (lo >>> 16) & 255, (lo >>> 24) & 255);
            this.data.push(255, 255, 255, 255);
            return;
        }
        let val = BigInt(value);
        for (let i = 0; i < 8; i++) {
            this.data.push(Number(val & 0xffn));
            val = val >> 8n;
        }
    }

    // 添加 64 位浮点数数据（IEEE 754 double）
    addFloat64(value, bits) {
        // 检查是否已存在相同的浮点数（区分 0 和 -0）
        this.floats = this.floats || new Map();
        // 先拆小端字节；用字节序列做 Map key（不用 bits.toString()——BigInt.toString
        // 在自举运行时返回空串 → 所有浮点 key 撞成一个 → 全部数字塌成第一个常量）。
        let b = bits;
        const bytes = [];
        for (let i = 0; i < 8; i++) {
            bytes.push(Number(b & 0xffn));
            b = b >> 8n;
        }
        const key = bytes.join(",");
        if (this.floats.has(key)) {
            return this.floats.get(key);
        }

        let labelIndex = this.floats.size;
        let labelName = "_float_" + labelIndex;
        this.floats.set(key, labelName);

        // 设置数据标签
        this.dataLabels = this.dataLabels || [];
        this.dataLabels.push({ name: labelName, offset: this.data.length });

        // 写入 8 字节小端序
        for (let i = 0; i < 8; i++) {
            this.data.push(bytes[i]);
        }

        return labelName;
    }

    finalize() {
        // 为外部符号生成 stub
        // stub 通过 ADRP+LDR 从 GOT 加载地址，然后 BR 跳转
        // GOT 在数据段，地址由动态链接器填充
        for (let sym in this.externalSymbols) {
            let symInfo = this.externalSymbols[sym];
            let stubOffset = this.code.length;
            this.stubOffsets[sym] = stubOffset;

            // 注意：gotBaseOffset 可能还没设置，所以只保存 slot 索引
            // gotSlotOffset 会在 fixupAll 时计算

            // 生成 stub 代码，使用 ADRP + LDR
            // 实际地址需要在 fixupAll 时根据 dataVAddr 计算
            // 这里先生成占位符
            this.pendingFixups.pushRaw(FIXUP_TYPE.got_stub, this.code.length, undefined, { slotIndex: symInfo.slot });
            // ADRP X16, <got_page>  - 占位
            this.emit32(0x90000010);
            // LDR X16, [X16, <got_offset>]  - 占位
            this.emit32(0xf9400210);
            // BR X16
            this.emit32(0xd61f0200);

            // 创建标签指向 stub
            this.labels.set(sym, stubOffset);
        }

        // 先处理字符串
        this._dataLabelSet = this._dataLabelSet || new Set();
        for (let i = 0; i < this.strings.length; i = i + 1) {
            let labelName = this._stringLabels[i] || ("_str_" + i);
            this.labels.set(labelName, this.data.length);
            this._dataLabelSet.add(labelName);  // Mark as data label so fixup resolves to dataVAddr
            let str = this.strings[i];
            // 逐字节透传字符串常量到 this.data(charCode & 0xFF),**不 UTF-8 重编码**。
            // 字符串在词法阶段已是 UTF-8 字节序列:源码按 latin1(逐字节)读入(见 compiler
            // readModuleSource),非 ASCII 原始字符即其 UTF-8 字节;\u/\x 转义由 lexer 的
            // _cpToUtf8 展开成 UTF-8 字节。若此处再 UTF-8 编码一次 → 双重编码 mojibake
            // (`你好`→`ä½ å¥½`),这正是出厂/自编译器对含 CJK/emoji/重音字面量的用户程序
            // 全乱码的根因。逐字节透传令 UTF-8 字节原样进产物 → node/g1 一致且正确;ASCII
            // (< 0x80)透传即原样。不用 Buffer.from(...)[j](gen1 Buffer shim 的 buf[j] 取不到)。
            // Node: latin1 一字节一字符,codePointAt 即字节。native: s[j]/.length 是
            // UTF-16(每次从串头扫 → 长串 O(n²));charCodeAt 才是 O(1) 字节,扫到 NaN 停。
            if (process.release) {
                for (let j = 0; j < str.length; j = j + 1) {
                    this.data.push(str.codePointAt(j) & 0xff);
                }
            } else {
                let j = 0;
                while (true) {
                    const cc = str.charCodeAt(j);
                    if (cc !== cc) break;
                    this.data.push(cc & 0xff);
                    j = j + 1;
                }
            }
            this.data.push(0);
        }

        // 处理数据标签
        if (this.dataLabels) {
            this._dataLabelSet = this._dataLabelSet || new Set();
            for (let i = 0; i < this.dataLabels.length; i = i + 1) {
                let dl = this.dataLabels[i];
                if (dl.offset >= 0) {
                    this.labels.set(dl.name, dl.offset);
                    this._dataLabelSet.add(dl.name);
                }
            }
        }

    }

    fixupAll() {
        // 清除之前的重定位记录（避免重复调用导致重复）
        this.branchRelocations = [];

        // 未回填的前向 B(外部/未定义标签)转入 fixup 队列
        const fwd = this._fwdB;
        if (fwd && fwd.size !== 0) {
            const names = [];
            fwd.forEach(function (_list, name) { names.push(name); });
            for (let ni = 0; ni < names.length; ni++) {
                const name = names[ni];
                const list = fwd.get(name);
                for (let i = 0; i < list.length; i++) {
                    this.pendingFixups.pushRaw(FIXUP_TYPE.b, list[i], name);
                }
            }
            this._fwdB = null;
        }

        // 设置数据段起始标签（偏移量为 0，因为它是数据段的开头）
        this.labels.set("_data_start", 0);
        const dataSet = this._dataLabelSet || (this._dataLabelSet = new Set());
        dataSet.add("_data_start");
        for (const name of FALLBACK_DATA_LABELS) dataSet.add(name);

        const buf = this.pendingFixups;
        const n = buf.length;
        const labels = this.labels;
        const undefSet = this.undefinedSymbolSet;
        const hasUndef = undefSet.size !== 0;
        const codeVAddr = this.codeVAddr;
        const dataVAddr = this.dataVAddr;
        const PAGE = 4096;
        const hasAliases = this.labelAliases.size !== 0;
        const packed = !buf.nativeObjects;
        const typeChunks = buf.typeChunks;
        const offsetChunks = buf.offsetChunks;
        const rdChunks = buf.rdChunks;
        const condChunks = buf.condChunks;
        const slotChunks = buf.slotChunks;
        const labelArr = buf.labels;
        const CHUNK_BITS = 20;
        const CHUNK_MASK = 1048575;

        for (let i = 0; i < n; i = i + 1) {
            let type, offset, slotIndex, cond, packedRd, labelRaw;
            if (packed) {
                const chunk = i >> CHUNK_BITS;
                const within = i & CHUNK_MASK;
                type = typeChunks[chunk][within];
                offset = offsetChunks[chunk][within];
                slotIndex = slotChunks[chunk][within];
                cond = condChunks[chunk][within];
                packedRd = rdChunks[chunk][within];
                labelRaw = labelArr[i];
            } else {
                // 自举:直读 item 字段(pushRaw 已填 typeCode),免 typeCodeAt/字符串表。
                const item = buf.items[i];
                type = item.typeCode;
                offset = item.offset;
                slotIndex = typeof item.slotIndex === "number" ? item.slotIndex >>> 0 : 0xFFFFFFFF;
                cond = typeof item.cond === "number" ? item.cond : 255;
                packedRd = typeof item.rd === "number" ? item.rd : 255;
                labelRaw = item.label;
            }

            if (type === FIXUP_TYPE.iat_stub) {
                let iatSlotAddr = this.iatVAddr + slotIndex * 8;
                let currentAddr = codeVAddr + offset;
                let currentPage = currentAddr - (currentAddr % PAGE);
                let targetPage = iatSlotAddr - (iatSlotAddr % PAGE);
                let pageOffset = (targetPage - currentPage) / PAGE;
                let immlo = pageOffset & 3;
                let immhi = (pageOffset >> 2) & 524287;
                let adrpWord = 2415919104 | (immlo << 29) | (immhi << 5) | 16;
                this._codeWrite32(offset, adrpWord);
                let pageInOffset = iatSlotAddr - targetPage;
                let imm12 = Math.floor(pageInOffset / 8) & 4095;
                let ldrWord = 4181721088 | (imm12 << 10) | (16 << 5) | 16;
                this._codeWrite32(offset + 4, ldrWord);
                continue;
            }

            if (type === FIXUP_TYPE.got_stub) {
                let gotSlotOffset = this.gotBaseOffset + slotIndex * 8;
                let gotSlotAddr = dataVAddr + gotSlotOffset;
                let currentAddr = codeVAddr + offset;
                let currentPage = currentAddr - (currentAddr % PAGE);
                let targetPage = gotSlotAddr - (gotSlotAddr % PAGE);
                let pageOffset = (targetPage - currentPage) / PAGE;
                let immlo = pageOffset & 3;
                let immhi = (pageOffset >> 2) & 524287;
                let adrpWord = 2415919104 | (immlo << 29) | (immhi << 5) | 16;
                this._codeWrite32(offset, adrpWord);
                let pageInOffset = gotSlotAddr - targetPage;
                let imm12 = Math.floor(pageInOffset / 8) & 4095;
                let ldrWord = 4181721088 | (imm12 << 10) | (16 << 5) | 16;
                this._codeWrite32(offset + 4, ldrWord);
                continue;
            }

            // 无别名时免 resolve;有别名时绝大多数标签仍 miss,一次 get 即过。
            // (曾试 `_str_<ident>` 门控跳过 Map.get:1.4M 次 charCodeAt 在 gen1 上
            // 不比 Map miss 便宜,已撤回。)
            let labelName = labelRaw;
            if (hasAliases) {
                const hit = this.labelAliases.get(labelRaw);
                if (hit !== undefined) labelName = this.resolveLabel(labelRaw);
            }
            // _map_get 缺键返 JS_UNDEFINED,0 是合法代码偏移。Node/native 都只 get 一次。
            let labelOffset = labels.get(labelName);
            if (labelOffset === undefined) {
                // 可执行链接通常无 undef 集;空集时免 has。
                if (hasUndef && undefSet.has(labelName)) {
                    if (type === FIXUP_TYPE.bl) {
                        this.branchRelocations.push({
                            offset: offset,
                            symbol: labelName,
                            type: "ARM64_RELOC_BRANCH26",
                        });
                    }
                    continue;
                }
                throw new Error("ERROR: Unknown label: " + labelRaw + " (resolved: " + labelName + ")");
            }

            const isDataLabel = dataSet.has(labelName) || isFallbackDataPrefix(labelName);
            let targetAddr = isDataLabel ? dataVAddr + labelOffset : codeVAddr + labelOffset;
            let currentAddr = codeVAddr + offset;

            if (type === FIXUP_TYPE.b || type === FIXUP_TYPE.bl) {
                let imm26 = ((targetAddr - currentAddr) / 4) & 67108863;
                let opcode = type === FIXUP_TYPE.bl ? 2483027968 : 335544320;
                this._codeWrite32(offset, opcode | imm26);
            } else if (type === FIXUP_TYPE.bcond) {
                let imm19 = ((targetAddr - currentAddr) / 4) & 524287;
                this._codeWrite32(offset, 1409286144 | (imm19 << 5) | cond);
            } else if (type === FIXUP_TYPE.adr) {
                let adrOff = targetAddr - (currentAddr + 4);
                let immlo = adrOff & 3;
                let immhi = (adrOff >> 2) & 524287;
                let rd = this._codeGet(offset) & 31;
                this._codeWrite32(offset, 0x10000000 | (immhi << 5) | (immlo << 22) | rd);
            } else if (type === FIXUP_TYPE.adrp) {
                // 页对齐:用 % 代替 Math.floor(x/PAGE)*PAGE(自举下 floor/除法更重)。
                let currentPage = currentAddr - (currentAddr % PAGE);
                let targetPage = targetAddr - (targetAddr % PAGE);
                let pageOffset = (targetPage - currentPage) / PAGE;
                let immlo = pageOffset & 3;
                let immhi = (pageOffset >> 2) & 524287;
                let rd = packedRd === 255 ? (this._codeGet(offset) & 31) : packedRd;
                let adrpWord = (0x90000000 + (immhi << 5) + (immlo << 29) + rd) >>> 0;
                this._codeWrite32(offset, adrpWord);
                let addImm = (targetAddr - targetPage) & 4095;
                let addWord = (0x91000000 + (addImm << 10) + (rd << 5) + rd) >>> 0;
                this._codeWrite32(offset + 4, addWord);
            } else if (type === FIXUP_TYPE.cbz || type === FIXUP_TYPE.cbnz) {
                let imm19 = ((targetAddr - currentAddr) / 4) & 524287;
                let rt = this._codeGet(offset) & 31;
                let opcode = type === FIXUP_TYPE.cbz ? 0xb4000000 : 0xb5000000;
                this._codeWrite32(offset, opcode | (imm19 << 5) | rt);
            }
        }
    }

    getCode() {
        return this.code;
    }
    getData() {
        return this.data;
    }
}
