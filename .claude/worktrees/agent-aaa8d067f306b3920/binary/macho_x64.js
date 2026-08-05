// Mach-O 64位可执行文件生成器 - x64 动态链接版本
// macOS x64 要求动态链接到 libSystem

// Mach-O 常量
let MH_MAGIC_64 = 4277009103; // 0xFEEDFACF
let MH_EXECUTE = 2;
let MH_NOUNDEFS = 1;
let MH_DYLDLINK = 4;
let MH_PIE = 2097152; // 0x200000

// CPU 类型
let CPU_TYPE_X86_64 = 16777223; // 0x01000007
let CPU_SUBTYPE_X86_64_ALL = 3;

// Load command 类型
let LC_SEGMENT_64 = 25; // 0x19
let LC_SYMTAB = 2;
let LC_DYSYMTAB = 11; // 0x0B
let LC_LOAD_DYLINKER = 14; // 0x0E
let LC_LOAD_DYLIB = 12; // 0x0C
let LC_MAIN = 2147483688; // 0x80000028 (LC_REQ_DYLD | 0x28)
let LC_DYLD_INFO_ONLY = 2147483682; // 0x80000022

// Bind opcodes
let BIND_OPCODE_DONE = 0x00;
let BIND_OPCODE_SET_DYLIB_ORDINAL_IMM = 0x10;
let BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM = 0x40;
let BIND_OPCODE_SET_TYPE_IMM = 0x50;
let BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB = 0x72;
let BIND_OPCODE_DO_BIND = 0x90;

let BIND_TYPE_POINTER = 1;

// 段权限
let VM_PROT_NONE = 0;
let VM_PROT_READ = 1;
let VM_PROT_WRITE = 2;
let VM_PROT_EXECUTE = 4;

// Section 属性
let S_ATTR_PURE_INSTRUCTIONS = 2147483648; // 0x80000000
let S_ATTR_SOME_INSTRUCTIONS = 1024; // 0x00000400
let S_NON_LAZY_SYMBOL_POINTERS = 6; // 非延迟符号指针

export class MachOX64Generator {
    constructor() {
        this.buffer = [];
        this.baseAddr = 4294967296; // 0x100000000
        this.pageSize = 4096; // x64 使用 4KB 页
        this.externalDylibs = [];
        this.externalSymbols = [];
    }

    addDylib(dylibPath) {
        this.externalDylibs.push(dylibPath);
    }

    addExternalSymbol(name, dylibIndex) {
        this.externalSymbols.push({ name: name, dylibIndex: dylibIndex });
    }

    setExternalSymbols(symbols) {
        this.externalSymbols = symbols;
    }

    write(byte) {
        this.buffer.push(byte & 255);
    }

    writeBytes(bytes) {
        for (let i = 0; i < bytes.length; i = i + 1) {
            this.write(bytes[i]);
        }
    }

    write16(value) {
        this.write(value & 255);
        this.write((value >> 8) & 255);
    }

    write32(value) {
        this.write(value & 255);
        this.write((value >> 8) & 255);
        this.write((value >> 16) & 255);
        this.write((value >> 24) & 255);
    }

    write64(value) {
        let low = value & 4294967295;
        let high = Math.floor(value / 4294967296) & 4294967295;
        this.write32(low);
        this.write32(high);
    }

    writeString(str, strLen) {
        for (let i = 0; i < strLen; i = i + 1) {
            if (i < str.length) {
                this.write(str.charCodeAt(i));
            } else {
                this.write(0);
            }
        }
    }

    padTo(offset) {
        while (this.buffer.length < offset) {
            this.write(0);
        }
    }

    encodeULEB128(value) {
        let result = [];
        do {
            let byte = value & 0x7f;
            value = value >>> 7;
            if (value !== 0) {
                byte = byte | 0x80;
            }
            result.push(byte);
        } while (value !== 0);
        return result;
    }

    generateBindInfo(dataSegmentIndex, gotOffset) {
        let bindInfo = [];

        for (let i = 0; i < this.externalSymbols.length; i++) {
            let sym = this.externalSymbols[i];
            let ordinal = sym.dylibIndex || 1;
            bindInfo.push(BIND_OPCODE_SET_DYLIB_ORDINAL_IMM | ordinal);
            bindInfo.push(BIND_OPCODE_SET_TYPE_IMM | BIND_TYPE_POINTER);
            bindInfo.push(BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM);
            let name = sym.name;
            for (let j = 0; j < name.length; j++) {
                bindInfo.push(name.charCodeAt(j));
            }
            bindInfo.push(0);

            bindInfo.push(BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB | dataSegmentIndex);
            let slotOffset = gotOffset + i * 8;
            let ulebBytes = this.encodeULEB128(slotOffset);
            for (let j = 0; j < ulebBytes.length; j++) {
                bindInfo.push(ulebBytes[j]);
            }

            bindInfo.push(BIND_OPCODE_DO_BIND);
        }

        bindInfo.push(BIND_OPCODE_DONE);
        return bindInfo;
    }

    generate(codeBytes, dataBytes, labels) {
        labels = labels || {};
        let MACH_HEADER_SIZE = 32;
        let LC_SEGMENT_64_SIZE = 72;
        let LC_SECTION_64_SIZE = 80;
        let LC_MAIN_SIZE = 24;
        let LC_DYLD_INFO_SIZE = 48;
        let LC_SYMTAB_SIZE = 24;
        let LC_DYSYMTAB_SIZE = 80;

        let dylinkerPath = "/usr/lib/dyld";
        let dylinkerCmdSize = 12 + dylinkerPath.length + 1;
        dylinkerCmdSize = Math.ceil(dylinkerCmdSize / 8) * 8;

        let dylibPath = "/usr/lib/libSystem.B.dylib";
        let dylibCmdSize = 24 + dylibPath.length + 1;
        dylibCmdSize = Math.ceil(dylibCmdSize / 8) * 8;

        let extraDylibCmdSizes = [];
        let totalExtraDylibSize = 0;
        for (let i = 0; i < this.externalDylibs.length; i++) {
            let path = this.externalDylibs[i];
            let size = 24 + path.length + 1;
            size = Math.ceil(size / 8) * 8;
            extraDylibCmdSizes.push(size);
            totalExtraDylibSize += size;
        }

        let gotSize = this.externalSymbols.length * 8;
        let hasGot = gotSize > 0;
        let numDataSections = hasGot ? 2 : 1;

        let numLoadCommands = 10 + this.externalDylibs.length;
        let loadCommandsSize = LC_SEGMENT_64_SIZE + (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE) + (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE * numDataSections) + LC_SEGMENT_64_SIZE + LC_DYLD_INFO_SIZE + LC_SYMTAB_SIZE + LC_DYSYMTAB_SIZE + dylinkerCmdSize + dylibCmdSize + totalExtraDylibSize + LC_MAIN_SIZE;

        let headerAndCmdsSize = MACH_HEADER_SIZE + loadCommandsSize;
        let codeOffset = Math.ceil(headerAndCmdsSize / 16) * 16;
        let textSize = codeBytes.length;
        let textSegmentFileSize = Math.ceil((codeOffset + textSize) / this.pageSize) * this.pageSize;
        let textSegmentVmSize = textSegmentFileSize;

        let dataFileOffset = textSegmentFileSize;
        let dataVAddr = this.baseAddr + textSegmentFileSize;
        let dataSize = dataBytes.length > 0 ? dataBytes.length : 0;

        let gotOffsetInSegment = Math.ceil(dataSize / 8) * 8;
        let gotFileOffset = dataFileOffset + gotOffsetInSegment;
        let gotVAddr = dataVAddr + gotOffsetInSegment;

        let totalDataSize = gotOffsetInSegment + gotSize;
        let dataSegmentFileSize = totalDataSize > 0 ? Math.ceil(totalDataSize / this.pageSize) * this.pageSize : this.pageSize;
        let dataSegmentVmSize = dataSegmentFileSize;

        let bindInfo = hasGot ? this.generateBindInfo(2, gotOffsetInSegment) : [];
        let bindInfoSize = bindInfo.length;

        let linkeditFileOffset = dataFileOffset + dataSegmentFileSize;
        let linkeditVAddr = dataVAddr + dataSegmentVmSize;
        let linkeditSize = bindInfoSize > 0 ? Math.ceil(bindInfoSize / 8) * 8 : 16;
        let linkeditFileSize = Math.ceil(linkeditSize / this.pageSize) * this.pageSize;

        let bindInfoFileOffset = linkeditFileOffset;

        // 使用 _start 标签作为入口点，如果没有则使用代码开头
        // labels 现在是 Map（与 arm64 一致）
        let startOffset = (labels && labels.get && labels.get("_start") !== undefined) ? labels.get("_start") : 0;
        let entryOffset = codeOffset + startOffset;

        // ===== Mach-O Header =====
        this.write32(MH_MAGIC_64);
        this.write32(CPU_TYPE_X86_64);
        this.write32(CPU_SUBTYPE_X86_64_ALL);
        this.write32(MH_EXECUTE);
        this.write32(numLoadCommands);
        this.write32(loadCommandsSize);
        this.write32(MH_DYLDLINK | MH_PIE);
        this.write32(0);

        // ===== LC_SEGMENT_64: __PAGEZERO =====
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE);
        this.writeString("__PAGEZERO", 16);
        this.write64(0);
        this.write64(this.baseAddr);
        this.write64(0);
        this.write64(0);
        this.write32(VM_PROT_NONE);
        this.write32(VM_PROT_NONE);
        this.write32(0);
        this.write32(0);

        // ===== LC_SEGMENT_64: __TEXT =====
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE);
        this.writeString("__TEXT", 16);
        this.write64(this.baseAddr);
        this.write64(textSegmentVmSize);
        this.write64(0);
        this.write64(textSegmentFileSize);
        this.write32(VM_PROT_READ | VM_PROT_EXECUTE);
        this.write32(VM_PROT_READ | VM_PROT_EXECUTE);
        this.write32(1);
        this.write32(0);

        // Section: __text
        this.writeString("__text", 16);
        this.writeString("__TEXT", 16);
        this.write64(this.baseAddr + codeOffset);
        this.write64(textSize);
        this.write32(codeOffset);
        this.write32(4);
        this.write32(0);
        this.write32(0);
        this.write32(S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS);
        this.write32(0);
        this.write32(0);
        this.write32(0);

        // ===== LC_SEGMENT_64: __DATA =====
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE * numDataSections);
        this.writeString("__DATA", 16);
        this.write64(dataVAddr);
        this.write64(dataSegmentVmSize);
        this.write64(dataFileOffset);
        this.write64(dataSegmentFileSize);
        this.write32(VM_PROT_READ | VM_PROT_WRITE);
        this.write32(VM_PROT_READ | VM_PROT_WRITE);
        this.write32(numDataSections);
        this.write32(0);

        // Section: __data
        this.writeString("__data", 16);
        this.writeString("__DATA", 16);
        this.write64(dataVAddr);
        this.write64(dataSize);
        this.write32(dataFileOffset);
        this.write32(3);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);

        // Section: __got (如果有)
        if (hasGot) {
            this.writeString("__got", 16);
            this.writeString("__DATA", 16);
            this.write64(gotVAddr);
            this.write64(gotSize);
            this.write32(gotFileOffset);
            this.write32(3);
            this.write32(0);
            this.write32(0);
            this.write32(S_NON_LAZY_SYMBOL_POINTERS);
            this.write32(0);
            this.write32(0);
            this.write32(0);
        }

        // ===== LC_SEGMENT_64: __LINKEDIT =====
        this.write32(LC_SEGMENT_64);
        this.write32(LC_SEGMENT_64_SIZE);
        this.writeString("__LINKEDIT", 16);
        this.write64(linkeditVAddr);
        this.write64(linkeditFileSize);
        this.write64(linkeditFileOffset);
        this.write64(linkeditFileSize);
        this.write32(VM_PROT_READ);
        this.write32(VM_PROT_READ);
        this.write32(0);
        this.write32(0);

        // ===== LC_DYLD_INFO_ONLY =====
        this.write32(LC_DYLD_INFO_ONLY);
        this.write32(LC_DYLD_INFO_SIZE);
        this.write32(0);
        this.write32(0);
        this.write32(bindInfoFileOffset);
        this.write32(bindInfoSize);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);

        // ===== LC_SYMTAB =====
        this.write32(LC_SYMTAB);
        this.write32(LC_SYMTAB_SIZE);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);

        // ===== LC_DYSYMTAB =====
        this.write32(LC_DYSYMTAB);
        this.write32(LC_DYSYMTAB_SIZE);
        for (let i = 0; i < 18; i++) {
            this.write32(0);
        }

        // ===== LC_LOAD_DYLINKER =====
        this.write32(LC_LOAD_DYLINKER);
        this.write32(dylinkerCmdSize);
        this.write32(12);
        this.writeString(dylinkerPath, dylinkerCmdSize - 12);

        // ===== LC_LOAD_DYLIB (libSystem) =====
        this.write32(LC_LOAD_DYLIB);
        this.write32(dylibCmdSize);
        this.write32(24);
        this.write32(2);
        this.write32(65536);
        this.write32(65536);
        this.writeString(dylibPath, dylibCmdSize - 24);

        // ===== 额外的动态库 =====
        for (let i = 0; i < this.externalDylibs.length; i++) {
            let path = this.externalDylibs[i];
            let cmdSize = extraDylibCmdSizes[i];
            this.write32(LC_LOAD_DYLIB);
            this.write32(cmdSize);
            this.write32(24);
            this.write32(2);
            this.write32(65536);
            this.write32(65536);
            this.writeString(path, cmdSize - 24);
        }

        // ===== LC_MAIN =====
        this.write32(LC_MAIN);
        this.write32(LC_MAIN_SIZE);
        this.write64(entryOffset);
        this.write64(0);

        // 填充到代码开始位置
        this.padTo(codeOffset);

        // 写入代码
        this.writeBytes(codeBytes);

        // 填充到数据段
        this.padTo(dataFileOffset);

        // 写入数据
        if (dataBytes.length > 0) {
            this.writeBytes(dataBytes);
        }

        // 填充 GOT 区域（全为 0，由动态链接器填充）
        this.padTo(gotFileOffset);
        for (let i = 0; i < gotSize; i++) {
            this.write(0);
        }

        // 填充到 __LINKEDIT
        this.padTo(linkeditFileOffset);

        // 写入 bind info
        this.writeBytes(bindInfo);

        // 填充到文件末尾
        this.padTo(linkeditFileOffset + linkeditFileSize);

        return this.buffer;
    }

    getEntryPoint() {
        return this.baseAddr;
    }

    getCodeVAddr() {
        // Must match the actual layout computed in generate().
        // Code does NOT necessarily start at pageSize; it starts right after
        // Mach header + load commands, aligned to 16 bytes.
        let MACH_HEADER_SIZE = 32;
        let LC_SEGMENT_64_SIZE = 72;
        let LC_SECTION_64_SIZE = 80;
        let LC_MAIN_SIZE = 24;
        let LC_DYLD_INFO_SIZE = 48;
        let LC_SYMTAB_SIZE = 24;
        let LC_DYSYMTAB_SIZE = 80;

        let dylinkerPath = "/usr/lib/dyld";
        let dylinkerCmdSize = 12 + dylinkerPath.length + 1;
        dylinkerCmdSize = Math.ceil(dylinkerCmdSize / 8) * 8;

        let dylibPath = "/usr/lib/libSystem.B.dylib";
        let dylibCmdSize = 24 + dylibPath.length + 1;
        dylibCmdSize = Math.ceil(dylibCmdSize / 8) * 8;

        let totalExtraDylibSize = 0;
        for (let i = 0; i < this.externalDylibs.length; i++) {
            let path = this.externalDylibs[i];
            let size = 24 + path.length + 1;
            size = Math.ceil(size / 8) * 8;
            totalExtraDylibSize += size;
        }

        let gotSize = this.externalSymbols.length * 8;
        let hasGot = gotSize > 0;
        let numDataSections = hasGot ? 2 : 1;

        let numLoadCommands = 10 + this.externalDylibs.length;
        let loadCommandsSize = LC_SEGMENT_64_SIZE + (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE) + (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE * numDataSections) + LC_SEGMENT_64_SIZE + LC_DYLD_INFO_SIZE + LC_SYMTAB_SIZE + LC_DYSYMTAB_SIZE + dylinkerCmdSize + dylibCmdSize + totalExtraDylibSize + LC_MAIN_SIZE;

        let headerAndCmdsSize = MACH_HEADER_SIZE + loadCommandsSize;
        let codeOffset = Math.ceil(headerAndCmdsSize / 16) * 16;
        return this.baseAddr + codeOffset;
    }

    getDataVAddr(codeSize) {
        // Must match the actual layout computed in generate().
        let codeVAddr = this.getCodeVAddr();
        let codeOffset = codeVAddr - this.baseAddr;
        let textSegmentFileSize = Math.ceil((codeOffset + codeSize) / this.pageSize) * this.pageSize;
        return this.baseAddr + textSegmentFileSize;
    }

    getGotOffset(dataSize) {
        return Math.ceil(dataSize / 8) * 8;
    }
}
