// Mach-O 64位共享库生成器 (macOS dylib)
// 支持 ARM64 和 x86_64

import { BinaryGenerator, OutputType, pageAlign, align } from "./binary_format.js";

// Mach-O 常量
const MH_MAGIC_64 = 4277009103; // 0xFEEDFACF
const MH_EXECUTE = 2;
const MH_DYLIB = 6; // 动态库
const MH_BUNDLE = 8; // Bundle (插件)
const MH_NOUNDEFS = 1;
const MH_DYLDLINK = 4;
const MH_PIE = 2097152;
const MH_TWOLEVEL = 128;
const MH_NO_REEXPORTED_DYLIBS = 1048576;

// CPU 类型
const CPU_TYPE_X86_64 = 16777223;
const CPU_SUBTYPE_X86_64_ALL = 3;
const CPU_TYPE_ARM64 = 16777228;
const CPU_SUBTYPE_ARM64_ALL = 0;

// Load command 类型
const LC_SEGMENT_64 = 25;
const LC_SYMTAB = 2;
const LC_DYSYMTAB = 11;
const LC_LOAD_DYLINKER = 14;
const LC_LOAD_DYLIB = 12;
const LC_ID_DYLIB = 13; // 动态库标识
const LC_MAIN = 2147483688;
const LC_DYLD_INFO_ONLY = 2147483682;
const LC_UUID = 27;

// 段权限
const VM_PROT_NONE = 0;
const VM_PROT_READ = 1;
const VM_PROT_WRITE = 2;
const VM_PROT_EXECUTE = 4;

// Section 属性
const S_ATTR_PURE_INSTRUCTIONS = 2147483648;
const S_ATTR_SOME_INSTRUCTIONS = 1024;

export class MachODylibGenerator extends BinaryGenerator {
    constructor(arch) {
        super();
        this.arch = arch || "arm64";
        this.baseAddr = 0; // dylib 是位置无关的
        this.pageSize = 16384;
        this.installName = "";
        this.currentVersion = 0x10000; // 1.0.0
        this.compatVersion = 0x10000;
    }

    setInstallName(name) {
        this.installName = name;
    }

    setVersion(current, compat) {
        this.currentVersion = current;
        this.compatVersion = compat || current;
    }

    generate(codeBytes, dataBytes) {
        if (this.outputType === OutputType.SHARED) {
            return this.generateDylib(codeBytes, dataBytes);
        } else {
            return this.generateExecutable(codeBytes, dataBytes);
        }
    }

    generateDylib(codeBytes, dataBytes) {
        const MACH_HEADER_SIZE = 32;
        const LC_SEGMENT_64_SIZE = 72;
        const LC_SECTION_64_SIZE = 80;
        const LC_ID_DYLIB_SIZE = 24; // 基本大小，不含名字
        const LC_SYMTAB_SIZE = 24;
        const LC_DYSYMTAB_SIZE = 80;
        const NLIST_SIZE = 16;

        // 计算 install name 长度（对齐到 8 字节）
        let installName = this.installName || "@rpath/liboutput.dylib";
        let installNameLen = align(installName.length + 1, 8);
        let lcIdDylibSize = LC_ID_DYLIB_SIZE + installNameLen;

        // Load commands:
        // 1. LC_SEGMENT_64 __TEXT (含 __text section)
        // 2. LC_SEGMENT_64 __DATA (含 __data section)
        // 3. LC_SEGMENT_64 __LINKEDIT
        // 4. LC_ID_DYLIB
        // 5. LC_SYMTAB
        // 6. LC_DYSYMTAB

        let numLoadCommands = 6;
        let loadCommandsSize =
            LC_SEGMENT_64_SIZE +
            LC_SECTION_64_SIZE + // __TEXT
            (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE) + // __DATA
            LC_SEGMENT_64_SIZE + // __LINKEDIT
            lcIdDylibSize + // LC_ID_DYLIB
            LC_SYMTAB_SIZE + // LC_SYMTAB
            LC_DYSYMTAB_SIZE; // LC_DYSYMTAB

        let headerAndCmdsSize = MACH_HEADER_SIZE + loadCommandsSize;

        // __TEXT segment
        let textFileOffset = 0;
        let codeOffset = align(headerAndCmdsSize, 16);
        let textSize = codeBytes.length;
        let textSegmentFileSize = pageAlign(codeOffset + textSize, this.pageSize);
        let textSegmentVmSize = textSegmentFileSize;

        // __DATA segment
        let dataFileOffset = textSegmentFileSize;
        let dataSize = dataBytes.length;
        let dataSegmentFileSize = dataSize > 0 ? pageAlign(dataSize, this.pageSize) : 0;
        let dataSegmentVmSize = dataSegmentFileSize;

        // __LINKEDIT segment - 包含符号表和字符串表
        let linkeditFileOffset = dataFileOffset + dataSegmentFileSize;

        // 构建符号表和字符串表 - 传入代码偏移以计算正确的符号地址
        let { symtab, strtab, exportSymbols } = this._buildSymbols(codeOffset);

        let symtabOffset = linkeditFileOffset;
        let symtabSize = symtab.length;
        let strtabOffset = symtabOffset + symtabSize;
        let strtabSize = strtab.length;

        let linkeditSize = symtabSize + strtabSize;
        // filesize 应该是实际数据大小，vmsize 可以页对齐
        let linkeditSegmentFileSize = linkeditSize;
        let linkeditSegmentVmSize = pageAlign(linkeditSize, this.pageSize);

        // === 写入 Mach-O Header ===
        this.write32(MH_MAGIC_64);
        if (this.arch === "arm64") {
            this.write32(CPU_TYPE_ARM64);
            this.write32(CPU_SUBTYPE_ARM64_ALL);
        } else {
            this.write32(CPU_TYPE_X86_64);
            this.write32(CPU_SUBTYPE_X86_64_ALL);
        }
        this.write32(MH_DYLIB);
        this.write32(numLoadCommands);
        this.write32(loadCommandsSize);
        this.write32(MH_NOUNDEFS | MH_DYLDLINK | MH_TWOLEVEL | MH_NO_REEXPORTED_DYLIBS);
        this.write32(0); // reserved

        // === LC_SEGMENT_64: __TEXT ===
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE);
        this.writeString("__TEXT", 16);
        this.write64(0); // vmaddr
        this.write64(textSegmentVmSize);
        this.write64(textFileOffset);
        this.write64(textSegmentFileSize);
        this.write32(VM_PROT_READ | VM_PROT_EXECUTE);
        this.write32(VM_PROT_READ | VM_PROT_EXECUTE);
        this.write32(1); // nsects
        this.write32(0); // flags

        // __text section
        this.writeString("__text", 16);
        this.writeString("__TEXT", 16);
        this.write64(codeOffset); // addr
        this.write64(textSize);
        this.write32(codeOffset); // offset
        this.write32(4); // align = 2^4 = 16
        this.write32(0); // reloff
        this.write32(0); // nreloc
        this.write32(S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS);
        this.write32(0); // reserved1
        this.write32(0); // reserved2
        this.write32(0); // reserved3

        // === LC_SEGMENT_64: __DATA ===
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE);
        this.writeString("__DATA", 16);
        this.write64(textSegmentVmSize); // vmaddr
        this.write64(dataSegmentVmSize);
        this.write64(dataFileOffset);
        this.write64(dataSegmentFileSize);
        this.write32(VM_PROT_READ | VM_PROT_WRITE);
        this.write32(VM_PROT_READ | VM_PROT_WRITE);
        this.write32(1); // nsects
        this.write32(0); // flags

        // __data section
        this.writeString("__data", 16);
        this.writeString("__DATA", 16);
        this.write64(textSegmentVmSize); // addr
        this.write64(dataSize);
        this.write32(dataFileOffset); // offset
        this.write32(3); // align = 2^3 = 8
        this.write32(0); // reloff
        this.write32(0); // nreloc
        this.write32(0); // flags
        this.write32(0); // reserved1
        this.write32(0); // reserved2
        this.write32(0); // reserved3

        // === LC_SEGMENT_64: __LINKEDIT ===
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE);
        this.writeString("__LINKEDIT", 16);
        this.write64(textSegmentVmSize + dataSegmentVmSize); // vmaddr
        this.write64(linkeditSegmentVmSize);
        this.write64(linkeditFileOffset);
        this.write64(linkeditSegmentFileSize);
        this.write32(VM_PROT_READ);
        this.write32(VM_PROT_READ);
        this.write32(0); // nsects
        this.write32(0); // flags

        // === LC_ID_DYLIB ===
        this.write32(LC_ID_DYLIB);
        this.write32(lcIdDylibSize);
        this.write32(24); // name offset (从 load command 开始)
        this.write32(0); // timestamp
        this.write32(this.currentVersion);
        this.write32(this.compatVersion);
        this.writeString(installName, installNameLen);

        // === LC_SYMTAB ===
        this.write32(LC_SYMTAB);
        this.write32(LC_SYMTAB_SIZE);
        this.write32(symtabOffset); // symoff
        this.write32(exportSymbols.length); // nsyms
        this.write32(strtabOffset); // stroff
        this.write32(strtabSize); // strsize

        // === LC_DYSYMTAB ===
        this.write32(LC_DYSYMTAB);
        this.write32(LC_DYSYMTAB_SIZE);
        this.write32(0); // ilocalsym
        this.write32(0); // nlocalsym
        this.write32(0); // iextdefsym
        this.write32(exportSymbols.length); // nextdefsym
        this.write32(exportSymbols.length); // iundefsym
        this.write32(0); // nundefsym
        this.write32(0); // tocoff
        this.write32(0); // ntoc
        this.write32(0); // modtaboff
        this.write32(0); // nmodtab
        this.write32(0); // extrefsymoff
        this.write32(0); // nextrefsyms
        this.write32(0); // indirectsymoff
        this.write32(0); // nindirectsyms
        this.write32(0); // extreloff
        this.write32(0); // nextrel
        this.write32(0); // locreloff
        this.write32(0); // nlocrel

        // === 写入代码 ===
        this.padTo(codeOffset);
        this.writeBytes(codeBytes);

        // === 写入数据 ===
        if (dataSize > 0) {
            this.padTo(dataFileOffset);
            this.writeBytes(dataBytes);
        }

        // === 写入符号表 ===
        this.padTo(symtabOffset);
        this.writeBytes(symtab);

        // === 写入字符串表 ===
        this.padTo(strtabOffset);
        this.writeBytes(strtab);

        return this.buffer;
    }

    _buildSymbols(codeOffset) {
        const N_EXT = 0x01;
        const N_SECT = 0x0e;
        const NLIST_SIZE = 16;

        let strtab = [0]; // 空字符串在开头
        let symtab = [];
        let exportSymbols = [];

        // 为每个导出符号创建 nlist 条目
        for (let i = 0; i < this.exportedSymbols.length; i++) {
            let sym = this.exportedSymbols[i];
            let nameOffset = strtab.length;

            // 添加带下划线前缀的名字到字符串表
            let name = "_" + sym.name;
            for (let j = 0; j < name.length; j++) {
                strtab.push(name.charCodeAt(j));
            }
            strtab.push(0);

            // 创建 nlist_64 条目
            // n_strx (4 bytes)
            symtab.push(nameOffset & 0xff);
            symtab.push((nameOffset >> 8) & 0xff);
            symtab.push((nameOffset >> 16) & 0xff);
            symtab.push((nameOffset >> 24) & 0xff);
            // n_type (1 byte) - N_EXT | N_SECT
            symtab.push(N_EXT | N_SECT);
            // n_sect (1 byte) - 1 for __text
            symtab.push(1);
            // n_desc (2 bytes)
            symtab.push(0);
            symtab.push(0);
            // n_value (8 bytes) - 符号的虚拟地址 = codeOffset + 函数偏移
            // 使用 BigInt 避免 JavaScript 32 位位运算限制
            let value = BigInt(codeOffset + sym.offset);
            for (let j = 0; j < 8; j++) {
                symtab.push(Number((value >> BigInt(j * 8)) & BigInt(0xff)));
            }

            exportSymbols.push(sym);
        }

        return { symtab, strtab, exportSymbols };
    }

    generateExecutable(codeBytes, dataBytes) {
        // 使用现有的 MachOARM64Generator 逻辑
        // 这里简化实现，直接返回基本的可执行文件

        const MACH_HEADER_SIZE = 32;
        const LC_SEGMENT_64_SIZE = 72;
        const LC_SECTION_64_SIZE = 80;
        const LC_MAIN_SIZE = 24;

        let baseAddr = 4294967296; // 0x100000000

        let numLoadCommands = 4;
        let loadCommandsSize =
            LC_SEGMENT_64_SIZE + // __PAGEZERO
            (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE) + // __TEXT
            (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE) + // __DATA
            LC_MAIN_SIZE;

        let headerAndCmdsSize = MACH_HEADER_SIZE + loadCommandsSize;
        let codeOffset = align(headerAndCmdsSize, 16);
        let textSize = codeBytes.length;
        let textSegmentFileSize = pageAlign(codeOffset + textSize, this.pageSize);

        let dataFileOffset = textSegmentFileSize;
        let dataSize = dataBytes.length;
        let dataSegmentFileSize = dataSize > 0 ? pageAlign(dataSize, this.pageSize) : 0;

        // Header
        this.write32(MH_MAGIC_64);
        if (this.arch === "arm64") {
            this.write32(CPU_TYPE_ARM64);
            this.write32(CPU_SUBTYPE_ARM64_ALL);
        } else {
            this.write32(CPU_TYPE_X86_64);
            this.write32(CPU_SUBTYPE_X86_64_ALL);
        }
        this.write32(MH_EXECUTE);
        this.write32(numLoadCommands);
        this.write32(loadCommandsSize);
        this.write32(MH_NOUNDEFS | MH_DYLDLINK | MH_PIE);
        this.write32(0);

        // __PAGEZERO
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE);
        this.writeString("__PAGEZERO", 16);
        this.write64(0);
        this.write64(baseAddr);
        this.write64(0);
        this.write64(0);
        this.write32(VM_PROT_NONE);
        this.write32(VM_PROT_NONE);
        this.write32(0);
        this.write32(0);

        // __TEXT
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE);
        this.writeString("__TEXT", 16);
        this.write64(baseAddr);
        this.write64(textSegmentFileSize);
        this.write64(0);
        this.write64(textSegmentFileSize);
        this.write32(VM_PROT_READ | VM_PROT_EXECUTE);
        this.write32(VM_PROT_READ | VM_PROT_EXECUTE);
        this.write32(1);
        this.write32(0);

        // __text section
        this.writeString("__text", 16);
        this.writeString("__TEXT", 16);
        this.write64(baseAddr + codeOffset);
        this.write64(textSize);
        this.write32(codeOffset);
        this.write32(4);
        this.write32(0);
        this.write32(0);
        this.write32(S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS);
        this.write32(0);
        this.write32(0);
        this.write32(0);

        // __DATA
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE);
        this.writeString("__DATA", 16);
        this.write64(baseAddr + textSegmentFileSize);
        this.write64(dataSegmentFileSize);
        this.write64(dataFileOffset);
        this.write64(dataSegmentFileSize);
        this.write32(VM_PROT_READ | VM_PROT_WRITE);
        this.write32(VM_PROT_READ | VM_PROT_WRITE);
        this.write32(1);
        this.write32(0);

        // __data section
        this.writeString("__data", 16);
        this.writeString("__DATA", 16);
        this.write64(baseAddr + textSegmentFileSize);
        this.write64(dataSize);
        this.write32(dataFileOffset);
        this.write32(3);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);

        // LC_MAIN
        this.write32(LC_MAIN);
        this.write32(LC_MAIN_SIZE);
        this.write64(codeOffset); // entry offset
        this.write64(0); // stack size

        // 代码
        this.padTo(codeOffset);
        this.writeBytes(codeBytes);

        // 数据
        if (dataSize > 0) {
            this.padTo(dataFileOffset);
            this.writeBytes(dataBytes);
        }

        return this.buffer;
    }

    getCodeVAddr() {
        const MACH_HEADER_SIZE = 32;
        let baseSize = MACH_HEADER_SIZE + 500; // 估算 load commands 大小
        return align(baseSize, 16);
    }

    getDataVAddr(codeSize) {
        let codeOffset = this.getCodeVAddr();
        return pageAlign(codeOffset + codeSize, this.pageSize);
    }
}
