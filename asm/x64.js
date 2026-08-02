// x86_64 机器码生成器
// 这个模块生成 x86_64 汇编指令的机器码
// 注意：所有数值使用十进制，以兼容 asm.js

// 寄存器编码
export let Reg = {
    RAX: 0,
    RCX: 1,
    RDX: 2,
    RBX: 3,
    RSP: 4,
    RBP: 5,
    RSI: 6,
    RDI: 7,
    R8: 8,
    R9: 9,
    R10: 10,
    R11: 11,
    R12: 12,
    R13: 13,
    R14: 14,
    R15: 15,
    // 8 位寄存器别名（用于 movStoreOffset8 等指令）
    AL: 0, // RAX 低 8 位
    CL: 1, // RCX 低 8 位
    DL: 2, // RDX 低 8 位
    BL: 3, // RBX 低 8 位
    R9B: 9, // R9 低 8 位
};

// x86_64 代码生成器
export class X64Assembler {
    constructor() {
        this.code = [];
        // Map 而非普通对象：与 arm64 汇编器一致。自举产物里普通对象属性是线性查找，
        // 146k+ 标签会让 addLabel/resolveLabel 退化成 O(n)/O(n^2)（gen1-x64 fixup 阶段卡死级别慢）。
        this.labels = new Map();
        this.fixups = [];
        this.dataSection = [];
        // 字符串驻留：数组 + Map 去重表（与 arm64 汇编器一致）。
        // 原 Object.create(null) 普通对象在自举产物里 obj[missing] 返回裸 0 且
        // Object.keys 不可用 → addString 恒返回 0，全部字符串标签失效。
        this.strings = [];
        this._stringInternMap = new Map();
        this.dataLabels = []; // 用于存储数据标签和预分配空间
        // 外部符号支持 (macOS 动态链接)
        this.externalSymbols = {};
        this.externalSymbolList = [];
        this.gotBaseOffset = 0;
        this.stubOffsets = {};
        this.codeVAddr = 0;
        this.dataVAddr = 0;
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

    // 获取外部符号数量
    getExternalSymbolCount() {
        return this.externalSymbolList.length;
    }

    // 设置 GOT 在数据段的偏移
    setGotBaseOffset(offset) {
        this.gotBaseOffset = offset;
    }

    offset() {
        return this.code.length;
    }

    emit(byte) {
        this.code.push(byte & 255);
    }

    emitBytes(bytes) {
        for (let i = 0; i < bytes.length; i = i + 1) {
            this.emit(bytes[i]);
        }
    }

    emitImm32(value) {
        this.emit(value & 255);
        this.emit((value >> 8) & 255);
        this.emit((value >> 16) & 255);
        this.emit((value >> 24) & 255);
    }

    emitImm64(value) {
        if (typeof value === "bigint") {
            // BigInt 版本
            for (let i = 0; i < 8; i++) {
                this.emit(Number((value >> BigInt(i * 8)) & 0xffn));
            }
        } else {
            let low = value & 4294967295;
            let high = Math.floor(value / 4294967296) & 4294967295;
            this.emitImm32(low);
            this.emitImm32(high);
        }
    }

    label(name) {
        this.labels.set(name, this.offset());
    }

    rex(w, r, x, b) {
        let byte = 64;
        if (w) {
            byte = byte | 8;
        }
        if (r) {
            byte = byte | 4;
        }
        if (x) {
            byte = byte | 2;
        }
        if (b) {
            byte = byte | 1;
        }
        return byte;
    }

    modrm(mod, reg, rm) {
        return ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7);
    }

    // MOV reg, imm - 自动选择 32 位或 64 位
    movImm(reg, imm) {
        if (imm >= -2147483648 && imm <= 2147483647) {
            this.movImm32(reg, imm);
        } else {
            this.movImm64(reg, imm);
        }
    }

    movImm64(reg, imm) {
        let rexByte = this.rex(1, 0, 0, reg >= 8);
        this.emit(rexByte);
        this.emit(184 + (reg & 7));
        this.emitImm64(imm);
    }

    movImm32(reg, imm) {
        let rexByte = this.rex(1, 0, 0, reg >= 8);
        this.emit(rexByte);
        this.emit(199);
        this.emit(this.modrm(3, 0, reg & 7));
        this.emitImm32(imm);
    }

    movReg(dst, src) {
        let rexByte = this.rex(1, src >= 8, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(137);
        this.emit(this.modrm(3, src & 7, dst & 7));
    }

    movLoad(dst, srcAddr) {
        let rexByte = this.rex(1, dst >= 8, 0, srcAddr >= 8);
        this.emit(rexByte);
        this.emit(139);
        if ((srcAddr & 7) === 4) {
            this.emit(this.modrm(0, dst & 7, 4));
            this.emit(36);
        } else if ((srcAddr & 7) === 5) {
            this.emit(this.modrm(1, dst & 7, srcAddr & 7));
            this.emit(0);
        } else {
            this.emit(this.modrm(0, dst & 7, srcAddr & 7));
        }
    }

    movStore(dstAddr, src) {
        let rexByte = this.rex(1, src >= 8, 0, dstAddr >= 8);
        this.emit(rexByte);
        this.emit(137);
        if ((dstAddr & 7) === 4) {
            this.emit(this.modrm(0, src & 7, 4));
            this.emit(36);
        } else if ((dstAddr & 7) === 5) {
            this.emit(this.modrm(1, src & 7, dstAddr & 7));
            this.emit(0);
        } else {
            this.emit(this.modrm(0, src & 7, dstAddr & 7));
        }
    }

    // MOV byte ptr [dstAddr], src (store low byte of src register)
    movStoreByte(dstAddr, src) {
        // 对于 RDI/RSI/RBP/RSP 等高 4 个寄存器，需要 REX 前缀才能访问低字节
        // 对于 R8-R15，也需要 REX.B
        let needRex = src >= 4 || dstAddr >= 8;
        if (needRex) {
            this.emit(this.rex(0, src >= 8, 0, dstAddr >= 8));
        }
        this.emit(136); // MOV r/m8, r8 (0x88)
        if ((dstAddr & 7) === 4) {
            this.emit(this.modrm(0, src & 7, 4));
            this.emit(36);
        } else if ((dstAddr & 7) === 5) {
            this.emit(this.modrm(1, src & 7, dstAddr & 7));
            this.emit(0);
        } else {
            this.emit(this.modrm(0, src & 7, dstAddr & 7));
        }
    }

    movLoadOffset(dst, srcAddr, offset) {
        let rexByte = this.rex(1, dst >= 8, 0, srcAddr >= 8);
        this.emit(rexByte);
        this.emit(139);

        if (offset >= -128 && offset <= 127) {
            if ((srcAddr & 7) === 4) {
                this.emit(this.modrm(1, dst & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(1, dst & 7, srcAddr & 7));
            }
            this.emit(offset & 255);
        } else {
            if ((srcAddr & 7) === 4) {
                this.emit(this.modrm(2, dst & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(2, dst & 7, srcAddr & 7));
            }
            this.emitImm32(offset);
        }
    }

    // 存储 8 字节到内存
    movStoreOffset(dstAddr, offset, src) {
        let rexByte = this.rex(1, src >= 8, 0, dstAddr >= 8);
        this.emit(rexByte);
        this.emit(137);

        if (offset >= -128 && offset <= 127) {
            if ((dstAddr & 7) === 4) {
                this.emit(this.modrm(1, src & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(1, src & 7, dstAddr & 7));
            }
            this.emit(offset & 255);
        } else {
            if ((dstAddr & 7) === 4) {
                this.emit(this.modrm(2, src & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(2, src & 7, dstAddr & 7));
            }
            this.emitImm32(offset);
        }
    }

    // 存储 1 字节到内存 (mov byte ptr [addr+offset], src_low8)
    // 注意：src 必须是 RAX, RCX, RDX, RBX, RSI, RDI 或 R8-R15
    movStoreOffset8(dstAddr, offset, src) {
        // 如果使用 RSI, RDI, RBP, RSP (寄存器 4-7)，需要 REX 前缀才能访问低 8 位
        let needsRex = src >= 4 || dstAddr >= 8 || src >= 8;
        if (needsRex) {
            let rexByte = this.rex(0, src >= 8, 0, dstAddr >= 8);
            this.emit(rexByte);
        }
        this.emit(136); // MOV r/m8, r8 的操作码

        if (offset >= -128 && offset <= 127) {
            if ((dstAddr & 7) === 4) {
                this.emit(this.modrm(1, src & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(1, src & 7, dstAddr & 7));
            }
            this.emit(offset & 255);
        } else {
            if ((dstAddr & 7) === 4) {
                this.emit(this.modrm(2, src & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(2, src & 7, dstAddr & 7));
            }
            this.emitImm32(offset);
        }
    }

    // 存储 2 字节到内存 (mov word ptr [addr+offset], src_low16)
    movStoreOffset16(dstAddr, offset, src) {
        this.emit(0x66); // 操作数大小前缀
        let rexByte = this.rex(0, src >= 8, 0, dstAddr >= 8);
        if (rexByte !== 0x40) {
            this.emit(rexByte);
        }
        this.emit(137); // MOV r/m16, r16

        if (offset >= -128 && offset <= 127) {
            if ((dstAddr & 7) === 4) {
                this.emit(this.modrm(1, src & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(1, src & 7, dstAddr & 7));
            }
            this.emit(offset & 255);
        } else {
            if ((dstAddr & 7) === 4) {
                this.emit(this.modrm(2, src & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(2, src & 7, dstAddr & 7));
            }
            this.emitImm32(offset);
        }
    }

    // 存储 4 字节到内存
    movStoreOffset32(dstAddr, offset, src) {
        // 确保 8 字节对齐
        const misalign = this.data.length & 7;
        if (misalign !== 0) {
            const pad = 8 - misalign;
            for (let i = 0; i < pad; i++) {
                this.data.push(0);
            }
        }

        let rexByte = this.rex(0, src >= 8, 0, dstAddr >= 8);
        if (rexByte !== 0x40) {
            this.emit(rexByte);
        }
        this.emit(137); // MOV r/m32, r32

        if (offset >= -128 && offset <= 127) {
            if ((dstAddr & 7) === 4) {
                this.emit(this.modrm(1, src & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(1, src & 7, dstAddr & 7));
            }
            this.emit(offset & 255);
        } else {
            if ((dstAddr & 7) === 4) {
                this.emit(this.modrm(2, src & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(2, src & 7, dstAddr & 7));
            }
            this.emitImm32(offset);
        }
    }

    // 加载 1 字节 (零扩展)
    movLoadOffset8(dst, srcAddr, offset) {
        // MOVZX r64, r/m8: REX.W + 0F B6
        let rexByte = this.rex(1, dst >= 8, 0, srcAddr >= 8);
        this.emit(rexByte);
        this.emit(15); // 0F
        this.emit(182); // B6

        if (offset >= -128 && offset <= 127) {
            if ((srcAddr & 7) === 4) {
                this.emit(this.modrm(1, dst & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(1, dst & 7, srcAddr & 7));
            }
            this.emit(offset & 255);
        } else {
            if ((srcAddr & 7) === 4) {
                this.emit(this.modrm(2, dst & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(2, dst & 7, srcAddr & 7));
            }
            this.emitImm32(offset);
        }
    }

    // 加载 2 字节 (零扩展)
    movLoadOffset16(dst, srcAddr, offset) {
        // MOVZX r64, r/m16: REX.W + 0F B7
        let rexByte = this.rex(1, dst >= 8, 0, srcAddr >= 8);
        this.emit(rexByte);
        this.emit(15); // 0F
        this.emit(183); // B7 (MOVZX r64, r/m16)

        if (offset >= -128 && offset <= 127) {
            if ((srcAddr & 7) === 4) {
                this.emit(this.modrm(1, dst & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(1, dst & 7, srcAddr & 7));
            }
            this.emit(offset & 255);
        } else {
            if ((srcAddr & 7) === 4) {
                this.emit(this.modrm(2, dst & 7, 4));
                this.emit(36);
            } else {
                this.emit(this.modrm(2, dst & 7, srcAddr & 7));
            }
            this.emitImm32(offset);
        }
    }

    leaRipRel(dst, labelName) {
        let rexByte = this.rex(1, dst >= 8, 0, 0);
        this.emit(rexByte);
        this.emit(141);
        this.emit(this.modrm(0, dst & 7, 5));
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rip32",
        });
        this.emitImm32(0);
    }

    // LEA dst, [base+disp] - 计算有效地址
    leaReg(dst, base, disp) {
        let rexByte = this.rex(1, dst >= 8, 0, base >= 8);
        this.emit(rexByte);
        this.emit(141); // LEA opcode
        if (disp === 0 && (base & 7) !== 5) {
            // [base] - no displacement (但 RBP/R13 需要特殊处理)
            this.emit(this.modrm(0, dst & 7, base & 7));
            if ((base & 7) === 4) {
                // RSP/R12 需要 SIB
                this.emit(36); // SIB: scale=0, index=RSP(no index), base=RSP
            }
        } else if (disp >= -128 && disp <= 127) {
            // [base+disp8]
            this.emit(this.modrm(1, dst & 7, base & 7));
            if ((base & 7) === 4) {
                this.emit(36); // SIB
            }
            this.emit(disp & 255);
        } else {
            // [base+disp32]
            this.emit(this.modrm(2, dst & 7, base & 7));
            if ((base & 7) === 4) {
                this.emit(36); // SIB
            }
            this.emitImm32(disp);
        }
    }

    addReg(dst, src) {
        let rexByte = this.rex(1, src >= 8, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(1);
        this.emit(this.modrm(3, src & 7, dst & 7));
    }

    addImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm >= -128 && imm <= 127) {
            this.emit(131);
            this.emit(this.modrm(3, 0, dst & 7));
            this.emit(imm & 255);
        } else {
            this.emit(129);
            this.emit(this.modrm(3, 0, dst & 7));
            this.emitImm32(imm);
        }
    }

    subReg(dst, src) {
        let rexByte = this.rex(1, src >= 8, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(41);
        this.emit(this.modrm(3, src & 7, dst & 7));
    }

    subImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm >= -128 && imm <= 127) {
            this.emit(131);
            this.emit(this.modrm(3, 5, dst & 7));
            this.emit(imm & 255);
        } else {
            this.emit(129);
            this.emit(this.modrm(3, 5, dst & 7));
            this.emitImm32(imm);
        }
    }

    // AND reg, imm
    andImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm >= -128 && imm <= 127) {
            this.emit(131);
            this.emit(this.modrm(3, 4, dst & 7));
            this.emit(imm & 255);
        } else {
            this.emit(129);
            this.emit(this.modrm(3, 4, dst & 7));
            this.emitImm32(imm);
        }
    }

    // AND reg, reg
    andReg(dst, src) {
        let rexByte = this.rex(1, src >= 8, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(0x21); // AND r/m64, r64
        this.emit(this.modrm(3, src & 7, dst & 7));
    }

    // OR reg, reg
    orReg(dst, src) {
        let rexByte = this.rex(1, src >= 8, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(0x09); // OR r/m64, r64
        this.emit(this.modrm(3, src & 7, dst & 7));
    }

    // XOR reg, reg (已存在但可能叫 xorReg)

    // SHL reg, imm - 逻辑左移
    shlImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm === 1) {
            this.emit(209); // 0xD1 - SHL r/m64, 1
            this.emit(this.modrm(3, 4, dst & 7));
        } else {
            this.emit(193); // 0xC1 - SHL r/m64, imm8
            this.emit(this.modrm(3, 4, dst & 7));
            this.emit(imm & 63);
        }
    }

    // SHL reg, CL - 逻辑左移（移位量在 CL 中）
    shlCl(dst) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(0xd3); // SHL r/m64, CL
        this.emit(this.modrm(3, 4, dst & 7));
    }

    // SHL/SHR/SAR qword [rsp], CL —— 栈顶内存移位(后端 dest==RCX 场景的
    // 零寄存器触碰实现;ModRM mod=00 rm=100 需跟 SIB=0x24 表示 [rsp])
    shlClMemRsp() {
        this.emit(0x48);
        this.emit(0xd3);
        this.emit(0x24); // ModRM: mod00, /4, rm=100(SIB)
        this.emit(0x24); // SIB: base=RSP
    }
    shrClMemRsp() {
        this.emit(0x48);
        this.emit(0xd3);
        this.emit(0x2c); // /5
        this.emit(0x24);
    }
    sarClMemRsp() {
        this.emit(0x48);
        this.emit(0xd3);
        this.emit(0x3c); // /7
        this.emit(0x24);
    }

    // SHR reg, imm - 逻辑右移
    shrImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm === 1) {
            this.emit(209); // 0xD1 - SHR r/m64, 1
            this.emit(this.modrm(3, 5, dst & 7));
        } else {
            this.emit(193); // 0xC1 - SHR r/m64, imm8
            this.emit(this.modrm(3, 5, dst & 7));
            this.emit(imm & 63);
        }
    }

    // SHR reg, CL - 逻辑右移（移位量在 CL 中）
    shrCl(dst) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(0xd3); // SHR r/m64, CL
        this.emit(this.modrm(3, 5, dst & 7));
    }

    // SAR reg, imm - 算术右移（保留符号位）
    sarImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm === 1) {
            this.emit(209); // 0xD1 - SAR r/m64, 1
            this.emit(this.modrm(3, 7, dst & 7)); // /7 = SAR
        } else {
            this.emit(193); // 0xC1 - SAR r/m64, imm8
            this.emit(this.modrm(3, 7, dst & 7));
            this.emit(imm & 63);
        }
    }

    // SAR reg, CL - 算术右移（移位量在 CL 中）
    sarCl(dst) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(0xd3); // SAR r/m64, CL
        this.emit(this.modrm(3, 7, dst & 7));
    }

    // NOT reg - 按位非
    not(dst) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(247); // 0xF7
        this.emit(this.modrm(3, 2, dst & 7)); // /2 = NOT
    }

    // NEG reg - 取负
    neg(dst) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(247); // 0xF7
        this.emit(this.modrm(3, 3, dst & 7)); // /3 = NEG
    }

    // XOR reg, imm
    xorImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm >= -128 && imm <= 127) {
            this.emit(131); // 0x83
            this.emit(this.modrm(3, 6, dst & 7)); // /6 = XOR
            this.emit(imm & 255);
        } else {
            this.emit(129); // 0x81
            this.emit(this.modrm(3, 6, dst & 7));
            this.emitImm32(imm);
        }
    }

    // OR reg, imm
    orImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm >= -128 && imm <= 127) {
            this.emit(131); // 0x83
            this.emit(this.modrm(3, 1, dst & 7)); // /1 = OR
            this.emit(imm & 255);
        } else {
            this.emit(129); // 0x81
            this.emit(this.modrm(3, 1, dst & 7));
            this.emitImm32(imm);
        }
    }

    // TEST reg, imm
    testImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if ((dst & 7) === 0) {
            // RAX 特殊编码
            this.emit(0xa9); // TEST RAX, imm32
            this.emitImm32(imm);
        } else {
            this.emit(0xf7);
            this.emit(this.modrm(3, 0, dst & 7)); // /0 = TEST
            this.emitImm32(imm);
        }
    }

    imulReg(dst, src) {
        let rexByte = this.rex(1, dst >= 8, 0, src >= 8);
        this.emit(rexByte);
        this.emit(15);
        this.emit(175);
        this.emit(this.modrm(3, dst & 7, src & 7));
    }

    // IMUL dst, src, imm32 - 三操作数立即数乘法
    imulImm(dst, src, imm) {
        let rexByte = this.rex(1, dst >= 8, 0, src >= 8);
        this.emit(rexByte);
        if (imm >= -128 && imm <= 127) {
            this.emit(107); // 0x6B - IMUL r64, r/m64, imm8
            this.emit(this.modrm(3, dst & 7, src & 7));
            this.emit(imm & 255);
        } else {
            this.emit(105); // 0x69 - IMUL r64, r/m64, imm32
            this.emit(this.modrm(3, dst & 7, src & 7));
            this.emitImm32(imm);
        }
    }

    // NEG reg - 取负
    negReg(dst) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(247); // 0xF7
        this.emit(this.modrm(3, 3, dst & 7)); // /3 = NEG
    }

    cqo() {
        this.emit(this.rex(1, 0, 0, 0));
        this.emit(153);
    }

    idivReg(src) {
        let rexByte = this.rex(1, 0, 0, src >= 8);
        this.emit(rexByte);
        this.emit(247);
        this.emit(this.modrm(3, 7, src & 7));
    }

    // IDIV qword [rsp+disp8] —— 除数撞 RAX/RDX 时的栈上内存除数
    // (REX.W F7 /7, ModRM mod=01 rm=100 + SIB[rsp] + disp8)
    idivMemRsp(disp) {
        this.emit(0x48);
        this.emit(0xf7);
        this.emit(0x7c);
        this.emit(0x24);
        this.emit(disp & 0xff);
    }


    cmpReg(dst, src) {
        let rexByte = this.rex(1, src >= 8, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(57);
        this.emit(this.modrm(3, src & 7, dst & 7));
    }

    cmpImm(dst, imm) {
        let rexByte = this.rex(1, 0, 0, dst >= 8);
        this.emit(rexByte);
        if (imm >= -128 && imm <= 127) {
            this.emit(131);
            this.emit(this.modrm(3, 7, dst & 7));
            this.emit(imm & 255);
        } else {
            this.emit(129);
            this.emit(this.modrm(3, 7, dst & 7));
            this.emitImm32(imm);
        }
    }

    testReg(dst, src) {
        let rexByte = this.rex(1, src >= 8, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(133);
        this.emit(this.modrm(3, src & 7, dst & 7));
    }

    jmp(labelName) {
        this.emit(233);
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    je(labelName) {
        this.emit(15);
        this.emit(132);
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    jne(labelName) {
        this.emit(15);
        this.emit(133);
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    jl(labelName) {
        this.emit(15);
        this.emit(140);
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    jle(labelName) {
        this.emit(15);
        this.emit(142);
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    jg(labelName) {
        this.emit(15);
        this.emit(143);
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    // 无符号比较跳转
    // JB - Jump if Below (CF=1, 无符号小于)
    jb(labelName) {
        this.emit(15);
        this.emit(0x82); // JB rel32
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    // JBE - Jump if Below or Equal (CF=1 or ZF=1, 无符号小于等于)
    jbe(labelName) {
        this.emit(15);
        this.emit(0x86); // JBE rel32
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    // JA - Jump if Above (CF=0 and ZF=0, 无符号大于)
    ja(labelName) {
        this.emit(15);
        this.emit(0x87); // JA rel32
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    // JAE - Jump if Above or Equal (CF=0, 无符号大于等于)
    jae(labelName) {
        this.emit(15);
        this.emit(0x83); // JAE rel32
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    // JP - Jump if Parity (PF=1). ucomisd 后 unordered(任一 NaN)置 PF=1。
    jp(labelName) {
        this.emit(15);
        this.emit(0x8a); // 0F 8A rel32
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    // JS - Jump if Sign (SF=1, i.e., negative)
    js(labelName) {
        this.emit(15);
        this.emit(136); // 0x0F 0x88
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    // JNS - Jump if Not Sign (SF=0, i.e., non-negative)
    jns(labelName) {
        this.emit(15);
        this.emit(137); // 0x0F 0x89
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    jge(labelName) {
        this.emit(15);
        this.emit(141);
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    push(reg) {
        if (reg >= 8) {
            this.emit(this.rex(0, 0, 0, 1));
        }
        this.emit(80 + (reg & 7));
    }

    pop(reg) {
        if (reg >= 8) {
            this.emit(this.rex(0, 0, 0, 1));
        }
        this.emit(88 + (reg & 7));
    }

    call(labelName) {
        this.emit(232);
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "rel32",
        });
        this.emitImm32(0);
    }

    callReg(reg) {
        if (reg >= 8) {
            this.emit(this.rex(0, 0, 0, 1));
        }
        this.emit(255);
        this.emit(this.modrm(3, 2, reg & 7));
    }

    // CALL [rip+disp32] - 通过 RIP 相对寻址调用（用于 IAT）
    callRipRel(labelName) {
        // FF 15 disp32: CALL [RIP+disp32]
        this.emit(255);
        this.emit(21); // ModR/M: mod=00, reg=2(CALL), r/m=5(RIP+disp32)
        this.fixups.push({
            offset: this.offset(),
            label: labelName,
            type: "riprel32",
        });
        this.emitImm32(0);
    }

    // JMP reg - 间接跳转到寄存器中的地址
    jmpReg(reg) {
        if (reg >= 8) {
            this.emit(this.rex(0, 0, 0, 1));
        }
        this.emit(255);
        this.emit(this.modrm(3, 4, reg & 7));
    }

    ret() {
        this.emit(195);
    }

    syscall() {
        this.emit(15);
        this.emit(5);
    }

    // Windows IAT 调用
    // call qword ptr [rip + disp32]
    // 需要记录重定位信息，由 PE 生成器处理
    callIAT(slotIndex) {
        // FF 15 xx xx xx xx - call [rip+disp32]
        this.emit(0xff);
        this.emit(0x15);

        // 记录需要重定位的位置
        const relocOffset = this.code.length;

        // 临时写入 0，稍后由 PE 生成器修正
        this.emit(0);
        this.emit(0);
        this.emit(0);
        this.emit(0);

        // 记录 IAT 重定位
        if (!this.iatRelocations) {
            this.iatRelocations = [];
        }
        this.iatRelocations.push({
            offset: relocOffset,
            slotIndex: slotIndex,
        });
    }

    // ==================== 浮点指令 ====================

    // CVTSI2SD xmm, r64 - 整数转双精度浮点
    // F2 REX.W 0F 2A /r
    cvtsi2sd(xmmDest, gpSrc) {
        this.emit(0xf2); // CVTSI2SD 前缀
        let rexByte = this.rex(1, xmmDest >= 8, 0, gpSrc >= 8);
        this.emit(rexByte);
        this.emit(0x0f);
        this.emit(0x2a);
        this.emit(this.modrm(3, xmmDest & 7, gpSrc & 7));
    }

    // ADDSD xmm1, xmm2 - 双精度浮点加法
    // F2 0F 58 /r
    addsd(xmmDest, xmmSrc) {
        this.emit(0xf2);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x58);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // SUBSD xmm1, xmm2 - 双精度浮点减法
    // F2 0F 5C /r
    subsd(xmmDest, xmmSrc) {
        this.emit(0xf2);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x5c);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // MULSD xmm1, xmm2 - 双精度浮点乘法
    // F2 0F 59 /r
    mulsd(xmmDest, xmmSrc) {
        this.emit(0xf2);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x59);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // SQRTSD xmm1, xmm2 - 双精度浮点平方根
    // F2 0F 51 /r
    sqrtsd(xmmDest, xmmSrc) {
        this.emit(0xf2);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x51);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // DIVSD xmm1, xmm2 - 双精度浮点除法
    // F2 0F 5E /r
    divsd(xmmDest, xmmSrc) {
        this.emit(0xf2);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x5e);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // MOVQ r64, xmm - 从 XMM 移动到通用寄存器 (64位位模式)
    // 66 REX.W 0F 7E /r
    movqToGp(gpDest, xmmSrc) {
        this.emit(0x66);
        let rexByte = this.rex(1, xmmSrc >= 8, 0, gpDest >= 8);
        this.emit(rexByte);
        this.emit(0x0f);
        this.emit(0x7e);
        this.emit(this.modrm(3, xmmSrc & 7, gpDest & 7));
    }

    // MOVQ xmm, r64 - 从通用寄存器移动到 XMM (64位位模式)
    // 66 REX.W 0F 6E /r
    movqToXmm(xmmDest, gpSrc) {
        this.emit(0x66);
        let rexByte = this.rex(1, xmmDest >= 8, 0, gpSrc >= 8);
        this.emit(rexByte);
        this.emit(0x0f);
        this.emit(0x6e);
        this.emit(this.modrm(3, xmmDest & 7, gpSrc & 7));
    }

    // MOVD xmm, r32 - 从通用寄存器移动到 XMM (32位)
    // 66 0F 6E /r (不带 REX.W)
    movdToXmm(xmmDest, gpSrc) {
        this.emit(0x66);
        if (xmmDest >= 8 || gpSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, gpSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x6e);
        this.emit(this.modrm(3, xmmDest & 7, gpSrc & 7));
    }

    // CVTSS2SD xmm1, xmm2 - 将单精度浮点转换为双精度浮点
    // F3 0F 5A /r
    cvtss2sd(xmmDest, xmmSrc) {
        this.emit(0xf3);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x5a);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // CVTSD2SS xmm1, xmm2 - 将双精度浮点转换为单精度浮点
    // F2 0F 5A /r
    cvtsd2ss(xmmDest, xmmSrc) {
        this.emit(0xf2);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x5a);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // MOVD r32, xmm - 从 XMM 移动到通用寄存器 (32位)
    // 66 0F 7E /r (不带 REX.W)
    movdFromXmm(gpDest, xmmSrc) {
        this.emit(0x66);
        if (xmmSrc >= 8 || gpDest >= 8) {
            let rexByte = this.rex(0, xmmSrc >= 8, 0, gpDest >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x7e);
        this.emit(this.modrm(3, xmmSrc & 7, gpDest & 7));
    }

    // 别名方法，与 Compiler 中使用的名称匹配
    movqFromXmm(gpDest, xmmSrc) {
        this.movqToGp(gpDest, xmmSrc);
    }

    // MOVSD xmm1, xmm2 - 在 XMM 寄存器之间移动双精度浮点
    // F2 0F 10 /r (movsd xmm, xmm/m64)
    movsd(xmmDest, xmmSrc) {
        this.emit(0xf2);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x10);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // UCOMISD xmm1, xmm2 - 无序比较双精度浮点并设置 EFLAGS
    // 66 0F 2E /r
    ucomisd(xmmSrc1, xmmSrc2) {
        this.emit(0x66);
        if (xmmSrc1 >= 8 || xmmSrc2 >= 8) {
            let rexByte = this.rex(0, xmmSrc1 >= 8, 0, xmmSrc2 >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x2e);
        this.emit(this.modrm(3, xmmSrc1 & 7, xmmSrc2 & 7));
    }

    // XORPD xmm1, xmm2 - XMM 位异或（用于清零）
    // 66 0F 57 /r
    xorpd(xmmDest, xmmSrc) {
        this.emit(0x66);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x57);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // ANDPD xmm1, xmm2 - XMM 位与（用于取绝对值）
    // 66 0F 54 /r
    andpd(xmmDest, xmmSrc) {
        this.emit(0x66);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x54);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
    }

    // ROUNDSD xmm1, xmm2, imm8 - 按指定模式舍入
    // 66 0F 3A 0B /r ib
    // imm8: 0=nearest, 1=floor, 2=ceil, 3=truncate
    roundsd(xmmDest, xmmSrc, imm8) {
        this.emit(0x66);
        if (xmmDest >= 8 || xmmSrc >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, xmmSrc >= 8);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x3a);
        this.emit(0x0b);
        this.emit(this.modrm(3, xmmDest & 7, xmmSrc & 7));
        this.emit(imm8);
    }

    // CVTTSD2SI r64, xmm - 截断转换双精度浮点到整数
    // F2 REX.W 0F 2C /r
    cvttsd2si(gpDest, xmmSrc) {
        this.emit(0xf2);
        let rexByte = this.rex(1, gpDest >= 8, 0, xmmSrc >= 8);
        this.emit(rexByte);
        this.emit(0x0f);
        this.emit(0x2c);
        this.emit(this.modrm(3, gpDest & 7, xmmSrc & 7));
    }

    // MOVSD xmm, m64 - 从内存加载双精度浮点
    // F2 0F 10 /r (with RIP-relative addressing)
    movsdFromMem(xmmDest, label) {
        // 添加 fixup 用于 RIP 相对寻址
        this.emit(0xf2);
        if (xmmDest >= 8) {
            let rexByte = this.rex(0, xmmDest >= 8, 0, 0);
            this.emit(rexByte);
        }
        this.emit(0x0f);
        this.emit(0x10);
        this.emit(this.modrm(0, xmmDest & 7, 5)); // mod=00, r/m=5 = RIP-relative
        // 添加 fixup
        this.fixups.push({
            type: "riprel",
            offset: this.code.length,
            label: label,
            size: 4,
            addend: 0,
        });
        this.emit(0);
        this.emit(0);
        this.emit(0);
        this.emit(0);
    }

    // MOVSD [RSP+offset], xmm - 保存 XMM 到栈
    // F2 0F 11 /r (movsd m64, xmm)
    movsdToStack(offset, xmmSrc) {
        this.emit(0xf2);
        if (xmmSrc >= 8) {
            this.emit(this.rex(0, xmmSrc >= 8, 0, 0));
        }
        this.emit(0x0f);
        this.emit(0x11);
        // ModR/M: mod=01 (disp8) or mod=10 (disp32), reg=xmm, r/m=4 (SIB follows)
        // SIB: scale=0, index=4 (none), base=4 (RSP)
        if (offset >= -128 && offset <= 127) {
            this.emit(this.modrm(1, xmmSrc & 7, 4)); // mod=01 (disp8)
            this.emit(0x24); // SIB: scale=0, index=4, base=4 (RSP)
            this.emit(offset & 0xff);
        } else {
            this.emit(this.modrm(2, xmmSrc & 7, 4)); // mod=10 (disp32)
            this.emit(0x24); // SIB
            this.emitImm32(offset);
        }
    }

    // MOVSD xmm, [RSP+offset] - 从栈加载到 XMM
    // F2 0F 10 /r (movsd xmm, m64)
    movsdFromStack(xmmDest, offset) {
        this.emit(0xf2);
        if (xmmDest >= 8) {
            this.emit(this.rex(0, xmmDest >= 8, 0, 0));
        }
        this.emit(0x0f);
        this.emit(0x10);
        if (offset >= -128 && offset <= 127) {
            this.emit(this.modrm(1, xmmDest & 7, 4)); // mod=01 (disp8)
            this.emit(0x24); // SIB
            this.emit(offset & 0xff);
        } else {
            this.emit(this.modrm(2, xmmDest & 7, 4)); // mod=10 (disp32)
            this.emit(0x24); // SIB
            this.emitImm32(offset);
        }
    }

    nop() {
        this.emit(144);
    }

    xorReg(dst, src) {
        let rexByte = this.rex(1, src >= 8, 0, dst >= 8);
        this.emit(rexByte);
        this.emit(49);
        this.emit(this.modrm(3, src & 7, dst & 7));
    }

    addString(str) {
        if (this._stringInternMap.has(str)) {
            return "_str_" + this._stringInternMap.get(str);
        }
        let labelIndex = this.strings.length;
        this.strings.push(str);
        this._stringInternMap.set(str, labelIndex);
        return "_str_" + labelIndex;
    }

    // 注册运行时字符串，使其与 addString 共享数据
    // runtimeLabel: 运行时使用的标签名（如 "_str_object_type"）
    // value: 字符串值（如 "object"）
    // x64 通过 this.labels 的字符串别名链在 resolveLabel 中解析
    registerRuntimeString(runtimeLabel, value) {
        let actualLabel = this.addString(value);
        // 创建别名：runtimeLabel -> actualLabel（resolveLabel 会跟随字符串链）
        this.labels.set(runtimeLabel, actualLabel);
    }

    // 添加数据标签
    addDataLabel(name) {
        this.dataLabels.push({ type: "label", name: name });
    }

    // 添加单字节数据
    addDataByte(value) {
        this.dataLabels.push({ type: "byte", value: value });
    }

    // 添加 8 字节数据
    addDataQword(value) {
        this.dataLabels.push({ type: "qword", value: value });
    }

    // 添加 64 位浮点数数据（IEEE 754 double）
    addFloat64(value, bits) {
        // 检查是否已存在相同的浮点数（区分 0 和 -0）
        this.floats = this.floats || new Map();
        // 先拆小端字节；用字节序列做 Map key——不能用 value 做 key(Map SameValueZero
        // 把 -0/+0 撞成同一槽:先池化 -0 后 +0 全部读成 -0,x64 Math.max(-0,0)→-0
        // 的根因;arm64/wasm32 均按字节 key);也不用 bits.toString()(自举运行时
        // BigInt.toString 返回空串,见 arm64.js 同段注释)。
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

        // 添加到数据标签
        this.dataLabels.push({ type: "label", name: labelName });
        this.dataLabels.push({ type: "float64", bits: bits });

        return labelName;
    }

    resolveLabel(label) {
        // 解析标签别名
        let value = this.labels.get(label);
        // 如果值是字符串（别名），继续解析
        while (typeof value === "string") {
            value = this.labels.get(value);
        }
        return value;
    }

    fixupAll(codeBase, dataBase, iatBase) {
        // 支持无参数调用，使用类属性
        if (codeBase === undefined) codeBase = this.codeVAddr;
        if (dataBase === undefined) dataBase = this.dataVAddr;

        // 设置数据段起始标签
        this.labels.set("_data_start", dataBase);

        // 首先为字符串数据设置标签（绝对地址）
        let dataOffset = 0;
        for (let si = 0; si < this.strings.length; si = si + 1) {
            let str = this.strings[si];
            let labelName = "_str_" + si;
            this.labels.set(labelName, dataBase + dataOffset);
            // 逐字节透传(& 0xFF),不 UTF-8 重编码——见 arm64.js 同处注释(字符串已是 UTF-8
            // 字节;双重编码致非 ASCII 字面量 mojibake)。char==字节、str.length==字节数,
            // 故 dataOffset 用 str.length 正确。
            for (let i = 0; i < str.length; i = i + 1) {
                this.dataSection.push(str.charCodeAt(i) & 0xff);
            }
            this.dataSection.push(0);
            dataOffset = dataOffset + str.length + 1;
        }

        // 处理数据标签和预分配空间
        for (let i = 0; i < this.dataLabels.length; i = i + 1) {
            let item = this.dataLabels[i];
            if (item.type === "label") {
                this.labels.set(item.name, dataBase + this.dataSection.length);
            } else if (item.type === "byte") {
                this.dataSection.push(item.value & 255);
            } else if (item.type === "qword") {
                let val = BigInt(item.value);
                for (let j = 0; j < 8; j++) {
                    this.dataSection.push(Number(val & 0xffn));
                    val = val >> 8n;
                }
            } else if (item.type === "float64") {
                // 将 BigInt 转换为 8 字节小端序
                let b = item.bits;
                for (let j = 0; j < 8; j++) {
                    this.dataSection.push(Number(b & 0xffn));
                    b = b >> 8n;
                }
            }
        }

        // 修复所有跳转/调用指令
        for (let i = 0; i < this.fixups.length; i = i + 1) {
            let fixup = this.fixups[i];

            // 跳过 GOT stub fixups（在后面单独处理）
            if (fixup.type === "got_stub") continue;

            let targetAddr = this.resolveLabel(fixup.label);

            // IAT 标签特殊处理
            let isIATLabel = fixup.label.startsWith("__imp_");
            if (isIATLabel && iatBase) {
                // IAT 标签格式: __imp_FuncName_Slot
                // 从标签名解析槽号
                let parts = fixup.label.split("_");
                let slotNum = parseInt(parts[parts.length - 1], 10);
                targetAddr = iatBase + slotNum * 8;
            } else if (targetAddr === undefined) {
                console.log("Error: Undefined label: " + fixup.label);
                return;
            }

            // 判断是代码标签还是数据标签
            // 字符串标签已经是绝对地址，代码标签是偏移量
            let originalLabel = fixup.label;
            // 追踪到最终的标签名
            let finalLabel = originalLabel;
            while (typeof this.labels.get(finalLabel) === "string") {
                finalLabel = this.labels.get(finalLabel);
            }

            // 检查是否是 PLT 标签（外部符号）
            // PLT 标签的格式是 _symbolname，其值是一个绝对地址（>= codeBase）。
            // 注意：内部代码标签的值是相对偏移（0..codeSize），远小于 codeBase；
            // 自举时二进制 __text 可达 10MB+，偏移会超过旧阈值 0x400000，故必须
            // 用 codeBase 作为“偏移 vs 绝对地址”的判据，否则大偏移的内部函数会被
            // 误判成 PLT（当成绝对地址）导致 call 目标错位、崩溃。
            // 额外门：codeBase >= 0x100000000。PLT 只存在于 Mach-O/PE（动态链接 stub，
            // 基址 0x100001000/0x140001000，与内部偏移永不重叠）；linux 静态 ELF 无 PLT
            // 且 codeBase 仅 0x401000——文本超 4.2MB 后大偏移内部标签会被 >= codeBase
            // 误判成绝对地址 → rel32 按裸偏移当目标 → 后向 ~4MB 野跳（linux-x64 gen1
            // 编译自身时模块初始化段 SIGSEGV 根因）。
            let isPltLabel = fixup.label.startsWith("_") && !fixup.label.startsWith("_user_") && !fixup.label.startsWith("__") && !fixup.label.startsWith("_global_") && !fixup.label.startsWith("_main_captured_") && targetAddr >= codeBase && codeBase >= 0x100000000;
            // 数据标签也用绝对地址判据。原先的 `this.strings[finalLabel] !== undefined`
            // 是拿“标签名”去查“字符串内容→标签名”表，属误用：自举时编译器源码里
            // 含有形如 "_heap_init" 的字符串字面量，会让同名代码标签被误判成数据。
            // 真正的字符串/数据标签地址一定 >= dataBase（更早已算好），无需该检查。
            let isDataLabel = isIATLabel || targetAddr >= dataBase || fixup.label.startsWith("_global_") || fixup.label.startsWith("_main_captured_");

            let targetAbsAddr;
            if (isDataLabel || isIATLabel || isPltLabel) {
                // 数据标签/IAT标签/PLT标签：已经是绝对地址
                targetAbsAddr = targetAddr;
            } else {
                // 代码标签：需要加上 codeBase
                targetAbsAddr = codeBase + targetAddr;
            }

            // 计算相对地址
            // 指令地址 = codeBase + fixup.offset
            // rel32 = target - (指令地址 + 4)
            let instrAddr = codeBase + fixup.offset;
            let rel = targetAbsAddr - (instrAddr + 4);

            this.code[fixup.offset] = rel & 255;
            this.code[fixup.offset + 1] = (rel >> 8) & 255;
            this.code[fixup.offset + 2] = (rel >> 16) & 255;
            this.code[fixup.offset + 3] = (rel >> 24) & 255;
        }

        // 处理 GOT stub fixups (macOS 动态链接)
        for (let i = 0; i < this.fixups.length; i++) {
            let fixup = this.fixups[i];
            if (fixup.type !== "got_stub") continue;

            let gotSlotOffset = this.gotBaseOffset + fixup.slotIndex * 8;
            let gotSlotAddr = this.dataVAddr + gotSlotOffset;
            let currentAddr = this.codeVAddr + fixup.offset;

            // 计算 RIP-relative 偏移
            // RIP-relative 地址在指令末尾（+7 字节后）
            let ripOffset = gotSlotAddr - (currentAddr + 7);

            // 更新 MOV RAX, [RIP+disp32] 中的 disp32
            this.code[fixup.offset + 3] = ripOffset & 255;
            this.code[fixup.offset + 4] = (ripOffset >> 8) & 255;
            this.code[fixup.offset + 5] = (ripOffset >> 16) & 255;
            this.code[fixup.offset + 6] = (ripOffset >> 24) & 255;
        }
    }

    // 为外部符号生成 stub（在 finalize 时调用）
    finalize() {
        for (let sym in this.externalSymbols) {
            let symInfo = this.externalSymbols[sym];
            let stubOffset = this.code.length;
            this.stubOffsets[sym] = stubOffset;

            // 生成 stub: MOV RAX, [RIP+disp32]; JMP RAX
            // MOV RAX, [RIP+disp32] = 48 8B 05 disp32 (7 bytes)
            // JMP RAX = FF E0 (2 bytes)
            this.fixups.push({
                type: "got_stub",
                offset: this.code.length,
                slotIndex: symInfo.slot,
                symbol: sym,
            });

            // MOV RAX, [RIP+0] - 占位，实际偏移在 fixupAll 时计算
            this.emit(0x48); // REX.W
            this.emit(0x8b); // MOV r64, r/m64
            this.emit(0x05); // ModRM: [RIP+disp32], RAX
            this.emitImm32(0); // disp32 placeholder

            // JMP RAX
            this.emit(0xff); // JMP r/m64
            this.emit(0xe0); // ModRM: RAX

            // 创建标签指向 stub
            this.labels.set(sym, stubOffset);
        }

        // 设置 data 属性以兼容通用接口
        this.data = this.dataSection;
    }

    getCode() {
        return this.code;
    }

    getData() {
        return this.dataSection;
    }

    // 预测 fixupAll 物化后的数据段总字节数(fixupAll 从空 dataSection 起按
    // strings→dataLabels 顺序 push;见上方物化循环)。PE 路径需在 fixupAll **之前**
    // 用它算 .idata/IAT 的 RVA——否则用 fixup 前的空 dataSection 长度会把 IAT 基址
    // 放进数据段中部,大二进制里 __imp_* 调用落到字符串常量 → 执行字符串崩溃。
    // 必须覆盖全部会 push 字节的类型(byte=1/qword=8/float64=8;label 占 0 字节)。
    estimateFinalDataSize() {
        let size = 0;
        for (let si = 0; si < this.strings.length; si = si + 1) {
            size += this.strings[si].length + 1; // null-terminated
        }
        for (let i = 0; i < this.dataLabels.length; i = i + 1) {
            let item = this.dataLabels[i];
            if (item.type === "byte") {
                size += 1;
            } else if (item.type === "qword") {
                size += 8;
            } else if (item.type === "float64") {
                size += 8;
            }
            // "label" 只标位置,占 0 字节
        }
        return size;
    }
}
