// Mach-O 64位可重定位目标文件生成器 - ARM64 / x64
// 用于生成 .o 文件，可被 ar 打包成静态库 .a

// Mach-O 常量
const MH_MAGIC_64 = 0xfeedfacf;
const MH_OBJECT = 1; // 可重定位目标文件

// CPU 类型
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_SUBTYPE_ARM64_ALL = 0;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_SUBTYPE_X86_64_ALL = 3;

// Load command 类型
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x02;
const LC_BUILD_VERSION = 0x32;

// Section 类型
const S_REGULAR = 0x00;
const S_ZEROFILL = 0x01;

// Section 属性
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;

// 符号类型
const N_EXT = 0x01; // 外部符号
const N_SECT = 0x0e; // 定义在 section 中
const N_UNDF = 0x00; // 未定义符号

// 重定位类型 (ARM64)
const ARM64_RELOC_UNSIGNED = 0;
const ARM64_RELOC_BRANCH26 = 2;
const ARM64_RELOC_PAGE21 = 3;
const ARM64_RELOC_PAGEOFF12 = 4;

// 重定位类型 (x86_64)
const X86_64_RELOC_UNSIGNED = 0;
const X86_64_RELOC_SIGNED = 1;
const X86_64_RELOC_BRANCH = 2;
const X86_64_RELOC_GOT_LOAD = 3;
const X86_64_RELOC_GOT = 4;
const X86_64_RELOC_SUBTRACTOR = 5;
const X86_64_RELOC_SIGNED_1 = 6;
const X86_64_RELOC_SIGNED_2 = 7;
const X86_64_RELOC_SIGNED_4 = 8;

// 段权限
const VM_PROT_NONE = 0;
const VM_PROT_READ = 1;
const VM_PROT_WRITE = 2;
const VM_PROT_EXECUTE = 4;

export class MachOObjectGenerator {
    constructor(arch = "arm64") {
        this.arch = arch;
        this.buffer = [];
        this.symbols = []; // 符号表
        this.strings = ["\0"]; // 字符串表（第一个是空字符串）
        this.stringOffset = 1;
        this.relocations = []; // 重定位条目
        this.exports = []; // 导出符号名
        this.undefinedSymbols = []; // 未定义符号（需要链接器解析）
    }

    // 设置要导出的符号
    setExports(exports) {
        this.exports = exports;
    }

    // 设置未定义符号（来自静态库）
    setUndefinedSymbols(symbols) {
        this.undefinedSymbols = symbols || [];
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
        const low = value & 0xffffffff;
        const high = Math.floor(value / 0x100000000) & 0xffffffff;
        this.write32(low);
        this.write32(high);
    }

    writeString(str, len) {
        for (let i = 0; i < len; i++) {
            if (i < str.length) {
                this.write(str.charCodeAt(i));
            } else {
                this.write(0);
            }
        }
    }

    writePadding(count) {
        for (let i = 0; i < count; i++) {
            this.write(0);
        }
    }

    // 添加字符串到字符串表，返回偏移
    addString(str) {
        const offset = this.stringOffset;
        this.strings.push(str + "\0");
        this.stringOffset += str.length + 1;
        return offset;
    }

    // 添加符号
    addSymbol(name, section, value, isExternal) {
        const strOffset = this.addString(name);
        this.symbols.push({
            name: name,
            strOffset: strOffset,
            type: N_SECT | (isExternal ? N_EXT : 0),
            sect: section, // 1 = __text, 2 = __data
            desc: 0,
            value: value,
        });
    }

    // 添加未定义符号（需要链接器解析）
    addUndefinedSymbol(name) {
        const strOffset = this.addString(name);
        this.symbols.push({
            name: name,
            strOffset: strOffset,
            type: N_UNDF | N_EXT, // 未定义 + 外部
            sect: 0, // NO_SECT
            desc: 0,
            value: 0,
        });
    }

    // 添加重定位条目
    addRelocation(address, symbolNum, pcrel, length, extern, type) {
        this.relocations.push({
            address: address,
            symbolNum: symbolNum,
            pcrel: pcrel,
            length: length, // 0=byte, 1=word, 2=long, 3=quad
            extern: extern,
            type: type,
        });
    }

    // 8 字节对齐
    align8(size) {
        return Math.ceil(size / 8) * 8;
    }

    // 设置分支重定位信息
    setBranchRelocations(relocations) {
        this.branchRelocations = relocations || [];
    }

    // 生成目标文件
    generate(codeBytes, dataBytes, labels) {
        const codeSize = codeBytes.length;
        const dataSize = dataBytes.length;

        // 计算各部分大小
        const headerSize = 32; // Mach-O header

        // Load commands
        const segmentCmdSize = 72; // LC_SEGMENT_64
        const sectionSize = 80; // section_64
        const symtabCmdSize = 24; // LC_SYMTAB
        const buildVersionCmdSize = 24; // LC_BUILD_VERSION

        const numSections = dataSize > 0 ? 2 : 1; // __text + __data (if has data)
        const loadCmdsSize = segmentCmdSize + numSections * sectionSize + symtabCmdSize + buildVersionCmdSize;

        // 代码段从 header + load commands 之后开始，对齐到 8 字节
        const textOffset = this.align8(headerSize + loadCmdsSize);
        const textSize = codeSize;

        // 数据段跟在代码段后面
        const dataOffset = textOffset + textSize;

        // 符号表 - 首先添加所有符号以获取索引
        // 跟踪已添加的符号避免重复
        const addedSymbols = new Set();

        // 为导出的函数添加符号
        for (const name of this.exports) {
            if (labels["_user_" + name] !== undefined && !addedSymbols.has("_user_" + name)) {
                // 内部函数
                this.addSymbol("_user_" + name, 1, labels["_user_" + name], true);
                addedSymbols.add("_user_" + name);
            }
            if (labels["_" + name] !== undefined && !addedSymbols.has("_" + name)) {
                // 导出的 wrapper 函数
                this.addSymbol("_" + name, 1, labels["_" + name], true);
                addedSymbols.add("_" + name);
            }
        }

        // 添加 _main 入口点（如果存在且未添加）
        if (labels["_main"] !== undefined && !addedSymbols.has("_main")) {
            this.addSymbol("_main", 1, labels["_main"], true);
            addedSymbols.add("_main");
        }

        // 建立未定义符号到索引的映射
        const undefSymbolIndex = {};
        const firstUndefIndex = this.symbols.length;

        // 添加未定义符号（静态库中的函数）
        for (let i = 0; i < this.undefinedSymbols.length; i++) {
            const name = this.undefinedSymbols[i];
            undefSymbolIndex[name] = firstUndefIndex + i;
            this.addUndefinedSymbol(name);
        }

        // 生成重定位条目
        const relocations = [];
        if (this.branchRelocations) {
            for (const reloc of this.branchRelocations) {
                const symbolIdx = undefSymbolIndex[reloc.symbol];
                if (symbolIdx !== undefined) {
                    if (this.arch === "arm64") {
                        relocations.push({
                            address: reloc.offset,
                            symbolNum: symbolIdx,
                            pcrel: 1, // PC 相对
                            length: 2, // 4 字节
                            extern: 1, // 外部符号
                            type: ARM64_RELOC_BRANCH26,
                        });
                    } else if (this.arch === "x64") {
                        // x86_64 使用 BRANCH 重定位，地址是 call 指令偏移+1 的位置
                        relocations.push({
                            address: reloc.offset,
                            symbolNum: symbolIdx,
                            pcrel: 1, // PC 相对
                            length: 2, // 4 字节 (log2(4) = 2)
                            extern: 1, // 外部符号
                            type: X86_64_RELOC_BRANCH,
                        });
                    }
                }
            }
        }

        // 重定位表
        const textRelocOffset = dataOffset + dataSize;
        const textRelocCount = relocations.length;
        const textRelocSize = textRelocCount * 8; // 每个重定位条目 8 字节

        // 构建字符串表
        const stringTable = this.strings.join("");
        const stringTableSize = stringTable.length;

        const symtabOffset = this.align8(textRelocOffset + textRelocSize);
        const numSymbols = this.symbols.length;
        const symtabSize = numSymbols * 16; // nlist_64 是 16 字节

        const stringTableOffset = symtabOffset + symtabSize;
        const totalSize = stringTableOffset + stringTableSize;

        // === 写入 Mach-O header ===
        this.write32(MH_MAGIC_64); // magic
        if (this.arch === "arm64") {
            this.write32(CPU_TYPE_ARM64); // cputype
            this.write32(CPU_SUBTYPE_ARM64_ALL); // cpusubtype
        } else if (this.arch === "x64") {
            this.write32(CPU_TYPE_X86_64); // cputype
            this.write32(CPU_SUBTYPE_X86_64_ALL); // cpusubtype
        }
        this.write32(MH_OBJECT); // filetype
        this.write32(3); // ncmds (segment + symtab + build_version)
        this.write32(loadCmdsSize); // sizeofcmds
        this.write32(0); // flags
        this.write32(0); // reserved

        // === LC_SEGMENT_64 ===
        this.write32(LC_SEGMENT_64); // cmd
        this.write32(segmentCmdSize + numSections * sectionSize); // cmdsize
        this.writeString("", 16); // segname (空表示匿名段)
        this.write64(0); // vmaddr
        this.write64(textSize + dataSize); // vmsize
        this.write64(textOffset); // fileoff
        this.write64(textSize + dataSize); // filesize
        this.write32(VM_PROT_READ | VM_PROT_WRITE | VM_PROT_EXECUTE); // maxprot
        this.write32(VM_PROT_READ | VM_PROT_WRITE | VM_PROT_EXECUTE); // initprot
        this.write32(numSections); // nsects
        this.write32(0); // flags

        // Section: __text
        this.writeString("__text", 16); // sectname
        this.writeString("__TEXT", 16); // segname
        this.write64(0); // addr
        this.write64(textSize); // size
        this.write32(textOffset); // offset
        this.write32(2); // align (2^2 = 4 字节对齐)
        this.write32(textRelocOffset); // reloff
        this.write32(textRelocCount); // nreloc
        this.write32(S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS); // flags
        this.write32(0); // reserved1
        this.write32(0); // reserved2
        this.write32(0); // reserved3

        // Section: __data (如果有)
        if (dataSize > 0) {
            this.writeString("__data", 16); // sectname
            this.writeString("__DATA", 16); // segname
            this.write64(textSize); // addr (相对于段起始)
            this.write64(dataSize); // size
            this.write32(dataOffset); // offset
            this.write32(3); // align (2^3 = 8 字节对齐)
            this.write32(0); // reloff
            this.write32(0); // nreloc
            this.write32(S_REGULAR); // flags
            this.write32(0); // reserved1
            this.write32(0); // reserved2
            this.write32(0); // reserved3
        }

        // === LC_SYMTAB ===
        this.write32(LC_SYMTAB); // cmd
        this.write32(symtabCmdSize); // cmdsize
        this.write32(symtabOffset); // symoff
        this.write32(numSymbols); // nsyms
        this.write32(stringTableOffset); // stroff
        this.write32(stringTableSize); // strsize

        // === LC_BUILD_VERSION ===
        this.write32(LC_BUILD_VERSION); // cmd
        this.write32(buildVersionCmdSize); // cmdsize
        this.write32(1); // platform (MACOS)
        this.write32(0x000e0000); // minos (14.0)
        this.write32(0x000e0000); // sdk (14.0)
        this.write32(0); // ntools

        // 填充到 textOffset
        while (this.buffer.length < textOffset) {
            this.write(0);
        }

        // === 代码段 ===
        this.writeBytes(codeBytes);

        // === 数据段 ===
        if (dataSize > 0) {
            this.writeBytes(dataBytes);
        }

        // === 重定位表 ===
        for (const reloc of relocations) {
            // Mach-O relocation_info 结构 (8 字节)
            // r_address: 32 位偏移
            this.write32(reloc.address);
            // r_symbolnum (24 位) | r_pcrel (1 位) | r_length (2 位) | r_extern (1 位) | r_type (4 位)
            let info = reloc.symbolNum & 0xffffff;
            info |= (reloc.pcrel & 1) << 24;
            info |= (reloc.length & 3) << 25;
            info |= (reloc.extern & 1) << 27;
            info |= (reloc.type & 0xf) << 28;
            this.write32(info);
        }

        // 填充到 symtabOffset
        while (this.buffer.length < symtabOffset) {
            this.write(0);
        }

        // === 符号表 ===
        for (const sym of this.symbols) {
            this.write32(sym.strOffset); // n_strx
            this.write(sym.type); // n_type
            this.write(sym.sect); // n_sect
            this.write16(sym.desc); // n_desc
            this.write64(sym.value); // n_value
        }

        // === 字符串表 ===
        for (let i = 0; i < stringTable.length; i++) {
            this.write(stringTable.charCodeAt(i));
        }

        return new Uint8Array(this.buffer);
    }
}

// ar 静态库生成器
