// Mach-O 64位可执行文件生成器 - ARM64 动态链接版本
// macOS ARM64 要求动态链接到 libSystem

// Mach-O 常量
let MH_MAGIC_64 = 4277009103; // 0xFEEDFACF
let MH_EXECUTE = 2;
let MH_NOUNDEFS = 1;
let MH_DYLDLINK = 4;
let MH_PIE = 2097152; // 0x200000

// CPU 类型
let CPU_TYPE_ARM64 = 16777228; // 0x0100000C
let CPU_SUBTYPE_ARM64_ALL = 0;

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

export class MachOARM64Generator {
    constructor() {
        this.buffer = [];
        this.baseAddr = 4294967296; // 0x100000000
        this.pageSize = 16384; // 0x4000
        this.externalDylibs = []; // 额外的动态库
        this.externalSymbols = []; // 外部符号: {name, dylibIndex}
    }

    // 添加外部动态库
    addDylib(dylibPath) {
        this.externalDylibs.push(dylibPath);
    }

    // 添加外部符号
    addExternalSymbol(name, dylibIndex) {
        this.externalSymbols.push({ name: name, dylibIndex: dylibIndex });
    }

    // 设置外部符号列表
    setExternalSymbols(symbols) {
        this.externalSymbols = symbols;
    }

    write(byte) {
        // 先取局部再 push(#18 实验兼优化):`this.buffer.push` 是成员 push,编译器
        // 对其发射「push + _object_set 写回成员」——12MB 产物 = 1200 万次属性写回。
        // asm.js 数组头地址稳定(ensure_cap 原地更新 data_ptr),写回本是恒等操作;
        // 局部引用 push 走 Identifier 写回(栈槽),同时作为「成员写回路径踩踏产物
        // 尾部」假说的判别实验(见任务 #18)。
        const b = this.buffer;
        b.push(byte & 255);
    }

    writeBytes(bytes) {
        // length 读一次缓存(#18 假说验证兼无害加固):自举下同一数组 length 作循环
        // 边界反复读取,特定堆布局出现偏大值 → 产物尾部多写页对齐垃圾。写出期间
        // bytes 不变,单次读取与逐轮读取在 node 语义等价。
        // 局部引用直 push,省掉每字节一次 write() 方法调用(16MB 产物 = 1600 万次)。
        const b = this.buffer;
        const n = bytes.length;
        for (let i = 0; i < n; i = i + 1) {
            b.push(bytes[i]);
        }
    }

    write16(value) {
        const b = this.buffer;
        b.push(value & 255, (value >> 8) & 255);
    }

    write32(value) {
        const b = this.buffer;
        b.push(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255);
    }

    write64(value) {
        let low = value & 4294967295;
        let high = Math.floor(value / 4294967296) & 4294967295;
        const b = this.buffer;
        b.push(low & 255, (low >> 8) & 255, (low >> 16) & 255, (low >> 24) & 255,
               high & 255, (high >> 8) & 255, (high >> 16) & 255, (high >> 24) & 255);
    }

    writeString(str, strLen) {
        const b = this.buffer;
        for (let i = 0; i < strLen; i = i + 1) {
            if (i < str.length) {
                b.push(str.charCodeAt(i));
            } else {
                b.push(0);
            }
        }
    }

    writeCString(str) {
        const b = this.buffer;
        for (let i = 0; i < str.length; i = i + 1) {
            b.push(str.charCodeAt(i));
        }
        b.push(0);
    }

    padTo(offset) {
        while (this.buffer.length < offset) {
            this.write(0);
        }
    }

    alignTo(align) {
        while (this.buffer.length % align !== 0) {
            this.write(0);
        }
    }

    // 生成 ULEB128 编码
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

    // 生成 bind info
    generateBindInfo(dataSegmentIndex, gotOffset) {
        let bindInfo = [];

        for (let i = 0; i < this.externalSymbols.length; i++) {
            let sym = this.externalSymbols[i];
            // SET_DYLIB_ORDINAL_IMM: dylib ordinal (libSystem = 1, 额外库从 2 开始)
            let ordinal = sym.dylibIndex || 2;
            bindInfo.push(BIND_OPCODE_SET_DYLIB_ORDINAL_IMM | ordinal);

            // SET_TYPE_IMM: BIND_TYPE_POINTER
            bindInfo.push(BIND_OPCODE_SET_TYPE_IMM | BIND_TYPE_POINTER);

            // SET_SYMBOL_TRAILING_FLAGS_IMM
            bindInfo.push(BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM);
            // 写入符号名（以 null 结尾）
            let name = sym.name;
            for (let j = 0; j < name.length; j++) {
                bindInfo.push(name.charCodeAt(j));
            }
            bindInfo.push(0);

            // SET_SEGMENT_AND_OFFSET_ULEB: segment index + offset
            bindInfo.push(BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB | dataSegmentIndex);
            let slotOffset = gotOffset + i * 8;
            let ulebBytes = this.encodeULEB128(slotOffset);
            for (let j = 0; j < ulebBytes.length; j++) {
                bindInfo.push(ulebBytes[j]);
            }

            // DO_BIND
            bindInfo.push(BIND_OPCODE_DO_BIND);
        }

        // DONE
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

        // dylinker 路径
        let dylinkerPath = "/usr/lib/dyld";
        let dylinkerCmdSize = 12 + dylinkerPath.length + 1;
        dylinkerCmdSize = Math.ceil(dylinkerCmdSize / 8) * 8;

        // libSystem dylib 路径
        let dylibPath = "/usr/lib/libSystem.B.dylib";
        let dylibCmdSize = 24 + dylibPath.length + 1;
        dylibCmdSize = Math.ceil(dylibCmdSize / 8) * 8;

        // 计算额外动态库的 load command 大小
        let extraDylibCmdSizes = [];
        let totalExtraDylibSize = 0;
        for (let i = 0; i < this.externalDylibs.length; i++) {
            let path = this.externalDylibs[i];
            let size = 24 + path.length + 1;
            size = Math.ceil(size / 8) * 8;
            extraDylibCmdSizes.push(size);
            totalExtraDylibSize += size;
        }

        // GOT 相关计算
        let gotSize = this.externalSymbols.length * 8;
        let hasGot = gotSize > 0;
        let numDataSections = hasGot ? 2 : 1; // __data + __got (如果有)

        // Load commands 计算
        let numLoadCommands = 10 + this.externalDylibs.length;
        let loadCommandsSize =
            LC_SEGMENT_64_SIZE + // __PAGEZERO
            (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE) + // __TEXT
            (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE * numDataSections) + // __DATA
            LC_SEGMENT_64_SIZE + // __LINKEDIT
            LC_DYLD_INFO_SIZE +
            LC_SYMTAB_SIZE +
            LC_DYSYMTAB_SIZE +
            dylinkerCmdSize +
            dylibCmdSize +
            totalExtraDylibSize +
            LC_MAIN_SIZE;

        let headerAndCmdsSize = MACH_HEADER_SIZE + loadCommandsSize;

        // 代码偏移：对齐到 16 字节
        let codeOffset = Math.ceil(headerAndCmdsSize / 16) * 16;
        let textSize = codeBytes.length;
        let textSegmentFileSize = Math.ceil((codeOffset + textSize) / this.pageSize) * this.pageSize;
        let textSegmentVmSize = textSegmentFileSize;

        // __DATA segment
        let dataFileOffset = textSegmentFileSize;
        let dataVAddr = this.baseAddr + textSegmentFileSize;
        let dataSize = dataBytes.length > 0 ? dataBytes.length : 0;

        // GOT 紧跟在 data 后面，必须 8 字节对齐
        let gotOffsetInSegment = Math.ceil(dataSize / 8) * 8; // GOT 在 DATA 段内的偏移
        let gotFileOffset = dataFileOffset + gotOffsetInSegment;
        let gotVAddr = dataVAddr + gotOffsetInSegment;

        let totalDataSize = gotOffsetInSegment + gotSize;
        let dataSegmentFileSize = totalDataSize > 0 ? Math.ceil(totalDataSize / this.pageSize) * this.pageSize : this.pageSize;
        let dataSegmentVmSize = dataSegmentFileSize;

        // 生成 bind info
        let bindInfo = hasGot ? this.generateBindInfo(2, gotOffsetInSegment) : []; // segment index 2 = __DATA
        let bindInfoSize = bindInfo.length;

        // __LINKEDIT segment
        let linkeditFileOffset = dataFileOffset + dataSegmentFileSize;
        let linkeditVAddr = dataVAddr + dataSegmentVmSize;
        let linkeditSize = bindInfoSize > 0 ? Math.ceil(bindInfoSize / 8) * 8 : 16;
        let linkeditFileSize = Math.ceil(linkeditSize / this.pageSize) * this.pageSize;

        let bindInfoFileOffset = linkeditFileOffset;

        // 使用 _start 标签作为入口点，如果没有则使用代码开头
        let startOffset = (labels && labels.get("_start") !== undefined) ? labels.get("_start") : 0;
        let entryOffset = codeOffset + startOffset; // 相对于 __TEXT 段开始的偏移

        // ===== Mach-O Header =====
        this.write32(MH_MAGIC_64);
        this.write32(CPU_TYPE_ARM64);
        this.write32(CPU_SUBTYPE_ARM64_ALL);
        this.write32(MH_EXECUTE);
        this.write32(numLoadCommands);
        this.write32(loadCommandsSize);
        this.write32(MH_DYLDLINK | MH_PIE); // 移除 MH_NOUNDEFS，因为有未定义符号
        this.write32(0); // reserved

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

        // __text section
        this.writeString("__text", 16);
        this.writeString("__TEXT", 16);
        this.write64(this.baseAddr + codeOffset);
        this.write64(textSize);
        this.write32(codeOffset);
        this.write32(4); // align 2^4 = 16
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
        this.write64(totalDataSize > 0 ? totalDataSize : 0);
        this.write32(VM_PROT_READ | VM_PROT_WRITE);
        this.write32(VM_PROT_READ | VM_PROT_WRITE);
        this.write32(numDataSections);
        this.write32(0);

        // __data section
        this.writeString("__data", 16);
        this.writeString("__DATA", 16);
        this.write64(dataVAddr);
        this.write64(dataSize);
        this.write32(dataFileOffset);
        this.write32(4);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write32(0);

        // __got section (如果有外部符号)
        if (hasGot) {
            this.writeString("__got", 16);
            this.writeString("__DATA", 16);
            this.write64(gotVAddr);
            this.write64(gotSize);
            this.write32(gotFileOffset);
            this.write32(3); // align 2^3 = 8
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
        this.write64(linkeditSize);
        this.write32(VM_PROT_READ);
        this.write32(VM_PROT_READ);
        this.write32(0);
        this.write32(0);

        // ===== LC_DYLD_INFO_ONLY =====
        this.write32(LC_DYLD_INFO_ONLY);
        this.write32(LC_DYLD_INFO_SIZE);
        this.write32(0); // rebase_off
        this.write32(0); // rebase_size
        this.write32(bindInfoSize > 0 ? bindInfoFileOffset : 0); // bind_off
        this.write32(bindInfoSize); // bind_size
        this.write32(0); // weak_bind_off
        this.write32(0); // weak_bind_size
        this.write32(0); // lazy_bind_off
        this.write32(0); // lazy_bind_size
        this.write32(0); // export_off
        this.write32(0); // export_size

        // ===== LC_SYMTAB =====
        this.write32(LC_SYMTAB);
        this.write32(LC_SYMTAB_SIZE);
        this.write32(0); // symoff
        this.write32(0); // nsyms
        this.write32(0); // stroff
        this.write32(0); // strsize

        // ===== LC_DYSYMTAB =====
        this.write32(LC_DYSYMTAB);
        this.write32(LC_DYSYMTAB_SIZE);
        this.write32(0); // ilocalsym
        this.write32(0); // nlocalsym
        this.write32(0); // iextdefsym
        this.write32(0); // nextdefsym
        this.write32(0); // iundefsym
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

        // ===== LC_LOAD_DYLINKER =====
        this.write32(LC_LOAD_DYLINKER);
        this.write32(dylinkerCmdSize);
        this.write32(12); // name offset
        this.writeCString(dylinkerPath);
        this.alignTo(8);

        // ===== LC_LOAD_DYLIB (libSystem) =====
        this.write32(LC_LOAD_DYLIB);
        this.write32(dylibCmdSize);
        this.write32(24); // name offset
        this.write32(2); // timestamp
        this.write32(65536); // current_version
        this.write32(65536); // compatibility_version
        this.writeCString(dylibPath);
        this.alignTo(8);

        // ===== LC_LOAD_DYLIB (external dylibs) =====
        for (let i = 0; i < this.externalDylibs.length; i++) {
            let extPath = this.externalDylibs[i];
            let extCmdSize = extraDylibCmdSizes[i];
            this.write32(LC_LOAD_DYLIB);
            this.write32(extCmdSize);
            this.write32(24); // name offset
            this.write32(2); // timestamp
            this.write32(65536); // current_version
            this.write32(65536); // compatibility_version
            this.writeCString(extPath);
            this.alignTo(8);
        }

        // ===== LC_MAIN =====
        this.write32(LC_MAIN);
        this.write32(LC_MAIN_SIZE);
        this.write64(entryOffset); // entryoff (相对于 __TEXT 开始)
        this.write64(0); // stacksize (0 = 默认)

        // ===== 填充到代码偏移 =====
        this.padTo(codeOffset);
        this.writeBytes(codeBytes);

        // ===== 填充到数据段 =====
        this.padTo(dataFileOffset);
        if (dataSize > 0) {
            this.writeBytes(dataBytes);
        }

        // ===== GOT section (全部初始化为 0，由 dyld 填充) =====
        if (hasGot) {
            this.padTo(gotFileOffset);
            for (let i = 0; i < gotSize; i++) {
                this.write(0);
            }
        }

        // ===== 填充到 __LINKEDIT =====
        this.padTo(linkeditFileOffset);

        // 写入 bind info
        if (bindInfoSize > 0) {
            this.writeBytes(bindInfo);
        }

        // 填充到 linkedit 结束
        this.padTo(linkeditFileOffset + linkeditSize);

        const result = this.buffer;
        return result;
    }

    getCodeVAddr() {
        let MACH_HEADER_SIZE = 32;
        let LC_SEGMENT_64_SIZE = 72;
        let LC_SECTION_64_SIZE = 80;
        let LC_MAIN_SIZE = 24;
        let LC_DYLD_INFO_SIZE = 48;
        let LC_SYMTAB_SIZE = 24;
        let LC_DYSYMTAB_SIZE = 80;

        let dylinkerPath = "/usr/lib/dyld";
        let dylinkerCmdSize = Math.ceil((12 + dylinkerPath.length + 1) / 8) * 8;
        let dylibPath = "/usr/lib/libSystem.B.dylib";
        let dylibCmdSize = Math.ceil((24 + dylibPath.length + 1) / 8) * 8;

        // 计算额外动态库大小
        let totalExtraDylibSize = 0;
        for (let i = 0; i < this.externalDylibs.length; i++) {
            let path = this.externalDylibs[i];
            let size = Math.ceil((24 + path.length + 1) / 8) * 8;
            totalExtraDylibSize += size;
        }

        let hasGot = this.externalSymbols.length > 0;
        let numDataSections = hasGot ? 2 : 1;

        let loadCommandsSize = LC_SEGMENT_64_SIZE + (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE) + (LC_SEGMENT_64_SIZE + LC_SECTION_64_SIZE * numDataSections) + LC_SEGMENT_64_SIZE + LC_DYLD_INFO_SIZE + LC_SYMTAB_SIZE + LC_DYSYMTAB_SIZE + dylinkerCmdSize + dylibCmdSize + totalExtraDylibSize + LC_MAIN_SIZE;

        let headerAndCmdsSize = MACH_HEADER_SIZE + loadCommandsSize;
        let codeOffset = Math.ceil(headerAndCmdsSize / 16) * 16;
        return this.baseAddr + codeOffset;
    }

    getDataVAddr(codeSize) {
        let codeVAddr = this.getCodeVAddr();
        let codeOffset = codeVAddr - this.baseAddr;
        let textSegmentFileSize = Math.ceil((codeOffset + codeSize) / this.pageSize) * this.pageSize;
        return this.baseAddr + textSegmentFileSize;
    }

    // 获取 GOT 在数据段的偏移（8 字节对齐）
    getGotOffset(dataSize) {
        // GOT 必须 8 字节对齐
        return Math.ceil(dataSize / 8) * 8;
    }
}
