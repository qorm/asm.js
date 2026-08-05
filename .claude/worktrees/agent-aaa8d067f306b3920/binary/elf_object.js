// ELF 64位可重定位目标文件生成器 - x64
// 用于生成 .o 文件，可被 ar 打包成静态库 .a

// ELF 常量
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7FELF
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EV_CURRENT = 1;
const ELFOSABI_SYSV = 0;

// 文件类型
const ET_REL = 1; // 可重定位目标文件

// 机器类型
const EM_X86_64 = 62;
const EM_AARCH64 = 183;

// Section 类型
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_NOBITS = 8;

// Section 标志
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

// 符号绑定
const STB_LOCAL = 0;
const STB_GLOBAL = 1;

// 符号类型
const STT_NOTYPE = 0;
const STT_OBJECT = 1;
const STT_FUNC = 2;
const STT_SECTION = 3;
const STT_FILE = 4;

// 符号可见性
const STV_DEFAULT = 0;

// 特殊 section 索引
const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;

// 重定位类型 (x86_64)
const R_X86_64_PC32 = 2;
const R_X86_64_PLT32 = 4;
const R_X86_64_32S = 11;

// 重定位类型 (aarch64)
const R_AARCH64_CALL26 = 283;
const R_AARCH64_JUMP26 = 282;
const R_AARCH64_ADR_PREL_PG_HI21 = 275;
const R_AARCH64_ADD_ABS_LO12_NC = 277;

export class ELFObjectGenerator {
    constructor(arch = "x64") {
        this.arch = arch;
        this.buffer = [];
        this.exports = [];
        this.undefinedSymbols = [];
        this.branchRelocations = [];
    }

    // 设置要导出的符号
    setExports(exports) {
        this.exports = exports;
    }

    // 设置未定义符号
    setUndefinedSymbols(symbols) {
        this.undefinedSymbols = symbols || [];
    }

    // 设置分支重定位信息
    setBranchRelocations(relocations) {
        this.branchRelocations = relocations || [];
    }

    write(byte) {
        this.buffer.push(byte & 0xff);
    }

    writeBytes(bytes) {
        for (let i = 0; i < bytes.length; i++) {
            this.write(bytes[i]);
        }
    }

    write16(value) {
        this.write(value & 0xff);
        this.write((value >> 8) & 0xff);
    }

    write32(value) {
        this.write(value & 0xff);
        this.write((value >> 8) & 0xff);
        this.write((value >> 16) & 0xff);
        this.write((value >> 24) & 0xff);
    }

    write64(value) {
        const low = value >>> 0;
        const high = Math.floor(value / 0x100000000) >>> 0;
        this.write32(low);
        this.write32(high);
    }

    padTo(offset) {
        while (this.buffer.length < offset) {
            this.write(0);
        }
    }

    // 对齐到指定边界
    align(alignment) {
        while (this.buffer.length % alignment !== 0) {
            this.write(0);
        }
    }

    generate(codeBytes, dataBytes, labels) {
        labels = labels || {};

        // ELF header: 64 字节
        // Section headers 放在末尾

        const ELF_HEADER_SIZE = 64;
        const SH_ENTRY_SIZE = 64;

        // 构建字符串表
        // Section names: \0, .text, .data, .symtab, .strtab, .shstrtab, .rela.text
        // [layout-determinism] 直接构建字节数组,不用含内嵌 \0 的字符串字面量:asm.js 的字符串
        // 是 NUL 结尾(C-string)语义,`"\0.text\0…"` 被首个 \0 截成空串 → 该数据常量在 node
        // (完整)与 asm.js(空)两侧字节不同 → __data 布局分歧 → 自举 g1≠g2 残差(自举雷区
        // 的最后根因)。逐段 push 字符码 + 显式 0 分隔,node/asm.js 产同字节(且 asm.js 的 ELF
        // shstrtab 此前实为空/损坏,一并修好)。
        const shstrtabBytes = [];
        shstrtabBytes.push(0); // 索引 0: 前导 \0
        const _emitShName = (nm) => {
            for (let k = 0; k < nm.length; k++) shstrtabBytes.push(nm.charCodeAt(k));
            shstrtabBytes.push(0);
        };
        _emitShName(".text");     // 索引 1
        _emitShName(".data");     // 索引 7
        _emitShName(".symtab");   // 索引 13
        _emitShName(".strtab");   // 索引 21
        _emitShName(".shstrtab"); // 索引 29
        _emitShName(".rela.text");// 索引 39

        // Section name 偏移
        const shnameNull = 0;
        const shnameText = 1; // ".text"
        const shnameData = 7; // ".data"
        const shnameSymtab = 13; // ".symtab"
        const shnameStrtab = 21; // ".strtab"
        const shnameShstrtab = 29; // ".shstrtab"
        const shnameRelaText = 39; // ".rela.text"

        // 构建符号表和字符串表
        const { symtab, strtab, localCount, symbolIndices } = this.buildSymbolTable(labels);
        const strtabBytes = new Uint8Array(strtab); // strtab 现为字节数组

        // 构建重定位表
        const relaEntries = this.buildRelocations(symbolIndices);

        // 计算各 section 的位置
        // [ELF Header][.text][.data][.rela.text][.symtab][.strtab][.shstrtab][Section Headers]

        const textOffset = ELF_HEADER_SIZE;
        const textSize = codeBytes.length;

        const dataOffset = textOffset + textSize;
        const dataSize = dataBytes.length;

        // 对齐到 8 字节
        const relaOffset = this.alignValue(dataOffset + dataSize, 8);
        const relaSize = relaEntries.length * 24; // 每个 rela entry 24 字节

        const symtabOffset = relaOffset + relaSize;
        const symtabSize = symtab.length * 24; // 每个符号 24 字节

        const strtabOffset = symtabOffset + symtabSize;
        const strtabSize = strtabBytes.length;

        const shstrtabOffset = strtabOffset + strtabSize;
        const shstrtabSize = shstrtabBytes.length;

        // Section headers 紧跟在 shstrtab 后面，对齐到 8 字节
        const shOffset = this.alignValue(shstrtabOffset + shstrtabSize, 8);

        // Section 数量: NULL, .text, .data, .rela.text, .symtab, .strtab, .shstrtab
        const numSections = 7;
        const shstrtabIdx = 6; // .shstrtab 是第 6 个 section（从 0 开始）

        // === 写入 ELF Header ===

        // e_ident (16 bytes)
        this.writeBytes(ELF_MAGIC); // Magic
        this.write(ELFCLASS64); // 64-bit
        this.write(ELFDATA2LSB); // Little endian
        this.write(EV_CURRENT); // Version
        this.write(ELFOSABI_SYSV); // OS/ABI
        for (let i = 0; i < 8; i++) this.write(0); // Padding

        // e_type
        this.write16(ET_REL);

        // e_machine
        this.write16(this.arch === "arm64" ? EM_AARCH64 : EM_X86_64);

        // e_version
        this.write32(EV_CURRENT);

        // e_entry (可重定位文件无入口点)
        this.write64(0);

        // e_phoff (无 program headers)
        this.write64(0);

        // e_shoff
        this.write64(shOffset);

        // e_flags
        this.write32(0);

        // e_ehsize
        this.write16(ELF_HEADER_SIZE);

        // e_phentsize, e_phnum (无 program headers)
        this.write16(0);
        this.write16(0);

        // e_shentsize
        this.write16(SH_ENTRY_SIZE);

        // e_shnum
        this.write16(numSections);

        // e_shstrndx
        this.write16(shstrtabIdx);

        // === 写入 .text ===
        this.writeBytes(codeBytes);

        // === 写入 .data ===
        this.writeBytes(dataBytes);

        // === 写入 .rela.text (对齐到 8 字节) ===
        this.padTo(relaOffset);
        for (const rela of relaEntries) {
            this.write64(rela.offset); // r_offset
            this.write64(rela.info); // r_info
            this.write64s(rela.addend); // r_addend (signed)
        }

        // === 写入 .symtab ===
        for (const sym of symtab) {
            this.write32(sym.name); // st_name
            this.write(sym.info); // st_info
            this.write(sym.other); // st_other
            this.write16(sym.shndx); // st_shndx
            this.write64(sym.value); // st_value
            this.write64(sym.size); // st_size
        }

        // === 写入 .strtab ===
        this.writeBytes(strtabBytes);

        // === 写入 .shstrtab ===
        this.writeBytes(shstrtabBytes);

        // === 写入 Section Headers (对齐到 8 字节) ===
        this.padTo(shOffset);

        // Section 0: NULL
        this.writeSectionHeader(0, SHT_NULL, 0, 0, 0, 0, 0, 0, 0, 0);

        // Section 1: .text
        this.writeSectionHeader(shnameText, SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR, 0, textOffset, textSize, 0, 0, 16, 0);

        // Section 2: .data
        this.writeSectionHeader(shnameData, SHT_PROGBITS, SHF_ALLOC | SHF_WRITE, 0, dataOffset, dataSize, 0, 0, 8, 0);

        // Section 3: .rela.text
        // sh_link = symtab index (4), sh_info = text section index (1)
        this.writeSectionHeader(shnameRelaText, SHT_RELA, 0, 0, relaOffset, relaSize, 4, 1, 8, 24);

        // Section 4: .symtab
        // sh_link = strtab index (5), sh_info = first global symbol index
        this.writeSectionHeader(shnameSymtab, SHT_SYMTAB, 0, 0, symtabOffset, symtabSize, 5, localCount, 8, 24);

        // Section 5: .strtab
        this.writeSectionHeader(shnameStrtab, SHT_STRTAB, 0, 0, strtabOffset, strtabSize, 0, 0, 1, 0);

        // Section 6: .shstrtab
        this.writeSectionHeader(shnameShstrtab, SHT_STRTAB, 0, 0, shstrtabOffset, shstrtabSize, 0, 0, 1, 0);

        return new Uint8Array(this.buffer);
    }

    writeSectionHeader(name, type, flags, addr, offset, size, link, info, addralign, entsize) {
        this.write32(name); // sh_name
        this.write32(type); // sh_type
        this.write64(flags); // sh_flags
        this.write64(addr); // sh_addr
        this.write64(offset); // sh_offset
        this.write64(size); // sh_size
        this.write32(link); // sh_link
        this.write32(info); // sh_info
        this.write64(addralign); // sh_addralign
        this.write64(entsize); // sh_entsize
    }

    // 写入有符号 64 位整数
    write64s(value) {
        // 处理负数
        if (value < 0) {
            // 转换为补码形式
            const low = value >>> 0;
            const high = Math.floor(value / 0x100000000) >>> 0;
            this.write32(low);
            this.write32(high);
        } else {
            this.write64(value);
        }
    }

    buildSymbolTable(labels) {
        const symtab = [];
        // [layout-determinism] 字节数组构建,不用含内嵌 \0 的字符串字面量:asm.js 的字符串是
        // NUL 结尾(C-string)语义,"\0" 常量被截成空串 → 两侧字节分歧 → 自举 g1≠g2 残差。
        const strtab = [0]; // ELF 字符串表首字节为 NUL(空串);后续每个符号名 + 0 分隔
        let strtabOffset = 1;
        const symbolIndices = {}; // name -> symbol index

        // 符号 0: NULL
        symtab.push({
            name: 0,
            info: 0,
            other: 0,
            shndx: SHN_UNDEF,
            value: 0,
            size: 0,
        });

        // 符号 1: .text section
        symtab.push({
            name: 0,
            info: (STB_LOCAL << 4) | STT_SECTION,
            other: STV_DEFAULT,
            shndx: 1, // .text section index
            value: 0,
            size: 0,
        });

        // 符号 2: .data section
        symtab.push({
            name: 0,
            info: (STB_LOCAL << 4) | STT_SECTION,
            other: STV_DEFAULT,
            shndx: 2, // .data section index
            value: 0,
            size: 0,
        });

        let localCount = 3; // 已有 3 个 local 符号

        // 收集所有导出符号（全局）
        const globalSymbols = [];
        const addedSymbols = new Set();

        // 处理导出的函数
        for (const name of this.exports) {
            // 首先尝试查找 _user_xxx 形式的内部函数
            const userSymName = "_user_" + name;
            if (labels[userSymName] !== undefined && !addedSymbols.has(userSymName)) {
                globalSymbols.push({ name: userSymName, offset: labels[userSymName], type: STT_FUNC });
                addedSymbols.add(userSymName);
            }

            // 然后尝试查找 _xxx 形式的 wrapper 函数
            const symName = "_" + name;
            if (labels[symName] !== undefined && !addedSymbols.has(symName)) {
                globalSymbols.push({ name: symName, offset: labels[symName], type: STT_FUNC });
                addedSymbols.add(symName);
            }
        }

        // 处理未定义符号
        for (const name of this.undefinedSymbols) {
            const symName = name.startsWith("_") ? name : "_" + name;
            if (!addedSymbols.has(symName)) {
                globalSymbols.push({ name: symName, offset: 0, type: STT_NOTYPE, undef: true });
                addedSymbols.add(symName);
            }
        }

        // 添加全局符号到符号表
        for (const sym of globalSymbols) {
            const nameOffset = strtabOffset;
            for (let ci = 0; ci < sym.name.length; ci++) strtab.push(sym.name.charCodeAt(ci));
            strtab.push(0);
            strtabOffset += sym.name.length + 1;

            symbolIndices[sym.name] = symtab.length;

            symtab.push({
                name: nameOffset,
                info: (STB_GLOBAL << 4) | sym.type,
                other: STV_DEFAULT,
                shndx: sym.undef ? SHN_UNDEF : 1, // .text or undefined
                value: sym.offset,
                size: 0,
            });
        }

        return {
            symtab,
            strtab: strtab, // 字节数组(见上;不再 join 含 NUL 的串)
            localCount,
            symbolIndices,
        };
    }

    buildRelocations(symbolIndices) {
        const relaEntries = [];

        for (const reloc of this.branchRelocations) {
            const symName = reloc.symbol.startsWith("_") ? reloc.symbol : "_" + reloc.symbol;
            const symIdx = symbolIndices[symName];

            if (symIdx !== undefined) {
                let type;
                let addend = reloc.addend || 0;

                if (this.arch === "arm64") {
                    // ARM64 重定位
                    type = R_AARCH64_CALL26;
                } else {
                    // x64 重定位: 对于调用使用 PLT32
                    type = R_X86_64_PLT32;
                    addend = -4; // x64 call 指令的 addend
                }

                relaEntries.push({
                    offset: reloc.offset,
                    info: (BigInt(symIdx) << 32n) | BigInt(type),
                    addend: addend,
                });
            }
        }

        return relaEntries;
    }

    stringToBytes(str) {
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            bytes.push(str.charCodeAt(i));
        }
        return new Uint8Array(bytes);
    }

    alignValue(value, alignment) {
        return Math.ceil(value / alignment) * alignment;
    }
}
