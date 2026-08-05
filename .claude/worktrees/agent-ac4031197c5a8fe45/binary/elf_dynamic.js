// ELF 64位动态链接生成器 (Linux x64/arm64)
// 支持生成动态链接可执行文件和共享库 (.so)

// ELF 常量
const ELF_MAGIC = [127, 69, 76, 70]; // \x7FELF
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EV_CURRENT = 1;
const ELFOSABI_SYSV = 0;
const ET_EXEC = 2;
const ET_DYN = 3; // 共享对象
const EM_X86_64 = 62;
const EM_AARCH64 = 183;

// 段类型
const PT_NULL = 0;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const PT_PHDR = 6;
const PT_GNU_STACK = 0x6474e551;

// 段权限
const PF_X = 1;
const PF_W = 2;
const PF_R = 4;

// Dynamic 标签
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_PLTGOT = 3;
const DT_HASH = 4;
const DT_STRTAB = 5;
const DT_SYMTAB = 6;
const DT_RELA = 7;
const DT_RELASZ = 8;
const DT_RELAENT = 9;
const DT_STRSZ = 10;
const DT_SYMENT = 11;
const DT_SONAME = 14;
const DT_PLTREL = 20;
const DT_JMPREL = 23;
const DT_PLTRELSZ = 2;
const DT_FLAGS_1 = 0x6ffffffb;

// Section 类型
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHT_HASH = 5;
const SHT_DYNAMIC = 6;
const SHT_DYNSYM = 11;

// 重定位类型
const R_X86_64_GLOB_DAT = 6;
const R_X86_64_JUMP_SLOT = 7;

// 符号类型
const STB_GLOBAL = 1;
const STT_FUNC = 2;
const STV_DEFAULT = 0;
const SHN_UNDEF = 0;

// Section 标志
const SHF_WRITE = 1;
const SHF_ALLOC = 2;
const SHF_EXECINSTR = 4;

// 输出类型
const OutputType = {
    EXECUTABLE: "executable",
    SHARED: "shared",
};

function align(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}

function pageAlign(value) {
    return align(value, 4096);
}

export class ELF64DynamicGenerator {
    constructor(arch = "x64") {
        this.arch = arch;
        this.buffer = [];
        this.baseAddr = 0x400000;
        this.pageSize = 4096;
        this.outputType = OutputType.EXECUTABLE;
        this.neededLibs = []; // DT_NEEDED 条目
        this.importedSymbols = []; // 导入的符号
        this.gotEntries = []; // GOT 条目
        this.exportedSymbols = []; // 导出的符号（用于共享库）
        this.soname = ""; // 共享库名称
    }

    setOutputType(type) {
        this.outputType = type;
    }

    setSOName(name) {
        this.soname = name;
    }

    addExportedSymbol(name, offset) {
        this.exportedSymbols.push({ name, offset });
    }

    write(byte) {
        this.buffer.push(byte & 255);
    }

    writeBytes(bytes) {
        for (let i = 0; i < bytes.length; i++) {
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
        let low = value >>> 0;
        let high = Math.floor(value / 0x100000000) >>> 0;
        this.write32(low);
        this.write32(high);
    }

    padTo(offset) {
        while (this.buffer.length < offset) {
            this.write(0);
        }
    }

    // 添加需要链接的动态库
    addNeededLib(libPath) {
        // 提取库名（去掉路径，保留 lib*.so*）
        let libName = libPath;
        let lastSlash = libPath.lastIndexOf("/");
        if (lastSlash >= 0) {
            libName = libPath.substring(lastSlash + 1);
        }
        if (!this.neededLibs.includes(libName)) {
            this.neededLibs.push(libName);
        }
    }

    // 添加导入符号
    addImportedSymbol(name) {
        if (!this.importedSymbols.includes(name)) {
            this.importedSymbols.push(name);
            this.gotEntries.push(name);
        }
    }

    // 生成 ELF 文件
    generate(codeBytes, dataBytes) {
        if (this.outputType === OutputType.SHARED) {
            return this.generateSO(codeBytes, dataBytes);
        }
        return this.generateExecutable(codeBytes, dataBytes);
    }

    // 生成动态链接可执行文件
    generateExecutable(codeBytes, dataBytes) {
        const ELF_HEADER_SIZE = 64;
        const PROG_HEADER_SIZE = 56;
        const SYM_ENTRY_SIZE = 24;
        const RELA_ENTRY_SIZE = 24;
        const DYN_ENTRY_SIZE = 16;

        // 构建字符串表
        let dynstrContent = this._buildDynstr();

        // 计算符号数量（包括 NULL 符号）
        let numSymbols = this.importedSymbols.length + 1;

        // 计算各段大小
        let interpStr = "/lib64/ld-linux-x86-64.so.2\0";
        let interpSize = interpStr.length;

        // .dynsym
        let dynsymSize = numSymbols * SYM_ENTRY_SIZE;

        // .dynstr
        let dynstrSize = dynstrContent.length;

        // .hash (简单哈希表: nbucket, nchain, buckets[], chains[])
        let hashSize = (2 + numSymbols + numSymbols) * 4;

        // .rela.plt (每个导入符号一个重定位条目)
        let relaSize = this.importedSymbols.length * RELA_ENTRY_SIZE;

        // .got.plt (GOT: 3个保留条目 + 每个符号一个)
        let gotSize = (3 + this.importedSymbols.length) * 8;

        // .plt (PLT: 头部16字节 + 每个符号16字节)
        let pltSize = 16 + this.importedSymbols.length * 16;

        // .dynamic
        let numDynEntries = 2 + this.neededLibs.length + 10; // 保守估计
        let dynamicSize = numDynEntries * DYN_ENTRY_SIZE;

        // 布局计算
        let numProgHeaders = 5; // PHDR, INTERP, LOAD(RX), LOAD(RW), DYNAMIC

        let progHeadersOffset = ELF_HEADER_SIZE;
        let progHeadersEnd = progHeadersOffset + numProgHeaders * PROG_HEADER_SIZE;

        // Segment 1: .interp, .hash, .dynsym, .dynstr (RO, in first LOAD)
        let interpOffset = align(progHeadersEnd, 8);
        let hashOffset = align(interpOffset + interpSize, 8);
        let dynsymOffset = align(hashOffset + hashSize, 8);
        let dynstrOffset = align(dynsymOffset + dynsymSize, 8);

        // .rela.plt
        let relaOffset = align(dynstrOffset + dynstrSize, 8);

        // .plt (代码段开始)
        let pltOffset = pageAlign(relaOffset + relaSize);

        // .text
        let textOffset = pltOffset + pltSize;
        let textSize = codeBytes.length;

        // Segment 2: .got.plt, .dynamic, .data (RW)
        let gotOffset = pageAlign(textOffset + textSize);
        let dynamicOffset = gotOffset + gotSize;
        let dataOffset = align(dynamicOffset + dynamicSize, 8);
        let dataSize = dataBytes.length;

        // 计算虚拟地址
        let loadRXVaddr = this.baseAddr;
        let loadRWVaddr = this.baseAddr + gotOffset;

        let interpVaddr = this.baseAddr + interpOffset;
        let hashVaddr = this.baseAddr + hashOffset;
        let dynsymVaddr = this.baseAddr + dynsymOffset;
        let dynstrVaddr = this.baseAddr + dynstrOffset;
        let relaVaddr = this.baseAddr + relaOffset;
        let pltVaddr = this.baseAddr + pltOffset;
        let textVaddr = this.baseAddr + textOffset;
        let gotVaddr = this.baseAddr + gotOffset;
        let dynamicVaddr = this.baseAddr + dynamicOffset;
        let dataVaddr = this.baseAddr + dataOffset;

        let entryPoint = textVaddr; // _start 在 .text 开头

        // ========== 写入 ELF 头 ==========
        this.writeBytes(ELF_MAGIC);
        this.write(ELFCLASS64);
        this.write(ELFDATA2LSB);
        this.write(EV_CURRENT);
        this.write(ELFOSABI_SYSV);
        for (let i = 0; i < 8; i++) this.write(0);

        this.write16(ET_EXEC);
        this.write16(EM_X86_64);
        this.write32(EV_CURRENT);
        this.write64(entryPoint);
        this.write64(progHeadersOffset);
        this.write64(0); // shoff (no section headers)
        this.write32(0); // flags
        this.write16(ELF_HEADER_SIZE);
        this.write16(PROG_HEADER_SIZE);
        this.write16(numProgHeaders);
        this.write16(0); // shentsize
        this.write16(0); // shnum
        this.write16(0); // shstrndx

        // ========== 程序头表 ==========
        // PHDR
        this.write32(PT_PHDR);
        this.write32(PF_R);
        this.write64(progHeadersOffset);
        this.write64(this.baseAddr + progHeadersOffset);
        this.write64(this.baseAddr + progHeadersOffset);
        this.write64(numProgHeaders * PROG_HEADER_SIZE);
        this.write64(numProgHeaders * PROG_HEADER_SIZE);
        this.write64(8);

        // INTERP
        this.write32(PT_INTERP);
        this.write32(PF_R);
        this.write64(interpOffset);
        this.write64(interpVaddr);
        this.write64(interpVaddr);
        this.write64(interpSize); // 包含 null 终止符
        this.write64(interpSize);
        this.write64(1);

        // LOAD (RX) - .interp through .text
        let loadRXFileSize = textOffset + textSize;
        this.write32(PT_LOAD);
        this.write32(PF_R | PF_X);
        this.write64(0);
        this.write64(loadRXVaddr);
        this.write64(loadRXVaddr);
        this.write64(loadRXFileSize);
        this.write64(loadRXFileSize);
        this.write64(this.pageSize);

        // LOAD (RW) - .got.plt through .data
        let loadRWFileSize = dataOffset + dataSize - gotOffset;
        let loadRWMemSize = loadRWFileSize;
        this.write32(PT_LOAD);
        this.write32(PF_R | PF_W);
        this.write64(gotOffset);
        this.write64(loadRWVaddr);
        this.write64(loadRWVaddr);
        this.write64(loadRWFileSize);
        this.write64(loadRWMemSize);
        this.write64(this.pageSize);

        // DYNAMIC
        this.write32(PT_DYNAMIC);
        this.write32(PF_R | PF_W);
        this.write64(dynamicOffset);
        this.write64(dynamicVaddr);
        this.write64(dynamicVaddr);
        this.write64(dynamicSize);
        this.write64(dynamicSize);
        this.write64(8);

        // ========== .interp ==========
        this.padTo(interpOffset);
        for (let i = 0; i < interpStr.length; i++) {
            this.write(interpStr.charCodeAt(i));
        }

        // ========== .hash ==========
        this.padTo(hashOffset);
        this.write32(numSymbols); // nbucket
        this.write32(numSymbols); // nchain
        // buckets
        for (let i = 0; i < numSymbols; i++) {
            this.write32(i); // 简单映射
        }
        // chains (全部指向 STN_UNDEF)
        for (let i = 0; i < numSymbols; i++) {
            this.write32(0);
        }

        // ========== .dynsym ==========
        this.padTo(dynsymOffset);
        // NULL 符号
        for (let i = 0; i < SYM_ENTRY_SIZE; i++) this.write(0);

        // 导入符号
        for (let i = 0; i < this.importedSymbols.length; i++) {
            let sym = this.importedSymbols[i];
            let nameOffset = this._getDynstrOffset(sym);

            this.write32(nameOffset); // st_name
            this.write((STB_GLOBAL << 4) | STT_FUNC); // st_info
            this.write(STV_DEFAULT); // st_other
            this.write16(SHN_UNDEF); // st_shndx
            this.write64(0); // st_value
            this.write64(0); // st_size
        }

        // ========== .dynstr ==========
        this.padTo(dynstrOffset);
        this.writeBytes(dynstrContent);

        // ========== .rela.plt ==========
        this.padTo(relaOffset);
        for (let i = 0; i < this.importedSymbols.length; i++) {
            let gotEntryVaddr = gotVaddr + (3 + i) * 8;
            let symIndex = i + 1; // 跳过 NULL 符号

            // r_info 的格式：高 32 位是符号索引，低 32 位是重定位类型
            // 由于 JavaScript 位运算只支持 32 位，需要分别写入
            this.write64(gotEntryVaddr); // r_offset
            // 写入 r_info：低 32 位是类型，高 32 位是符号索引
            this.write32(R_X86_64_JUMP_SLOT); // 低 32 位：类型
            this.write32(symIndex); // 高 32 位：符号索引
            this.write64(0); // r_addend
        }

        // ========== .plt ==========
        this.padTo(pltOffset);

        // PLT[0] - 解析存根
        // push [GOT+8]
        this.writeBytes([0xff, 0x35]);
        this.write32(gotVaddr + 8 - (pltVaddr + 6)); // RIP-relative
        // jmp [GOT+16]
        this.writeBytes([0xff, 0x25]);
        this.write32(gotVaddr + 16 - (pltVaddr + 12)); // RIP-relative
        // nop padding
        this.writeBytes([0x0f, 0x1f, 0x40, 0x00]);

        // PLT entries
        for (let i = 0; i < this.importedSymbols.length; i++) {
            let pltEntryOffset = pltOffset + 16 + i * 16;
            let gotEntryVaddr = gotVaddr + (3 + i) * 8;
            let pltEntryVaddr = pltVaddr + 16 + i * 16;

            // jmp [GOT entry]
            this.writeBytes([0xff, 0x25]);
            this.write32(gotEntryVaddr - (pltEntryVaddr + 6)); // RIP-relative
            // push index
            this.writeBytes([0x68]);
            this.write32(i);
            // jmp PLT[0]
            this.writeBytes([0xe9]);
            this.write32(pltVaddr - (pltEntryVaddr + 16)); // relative
        }

        // ========== .text ==========
        this.padTo(textOffset);
        this.writeBytes(codeBytes);

        // ========== .got.plt ==========
        this.padTo(gotOffset);
        // GOT[0] = .dynamic address
        this.write64(dynamicVaddr);
        // GOT[1] = 0 (link_map, filled by ld.so)
        this.write64(0);
        // GOT[2] = 0 (resolver, filled by ld.so)
        this.write64(0);
        // GOT entries for each symbol (initially point to PLT push instruction)
        for (let i = 0; i < this.importedSymbols.length; i++) {
            let pltPush = pltVaddr + 16 + i * 16 + 6;
            this.write64(pltPush);
        }

        // ========== .dynamic ==========
        this.padTo(dynamicOffset);

        // DT_NEEDED entries
        for (let i = 0; i < this.neededLibs.length; i++) {
            this.write64(DT_NEEDED);
            this.write64(this._getDynstrOffset(this.neededLibs[i]));
        }

        // DT_HASH
        this.write64(DT_HASH);
        this.write64(hashVaddr);

        // DT_STRTAB
        this.write64(DT_STRTAB);
        this.write64(dynstrVaddr);

        // DT_SYMTAB
        this.write64(DT_SYMTAB);
        this.write64(dynsymVaddr);

        // DT_STRSZ
        this.write64(DT_STRSZ);
        this.write64(dynstrSize);

        // DT_SYMENT
        this.write64(DT_SYMENT);
        this.write64(SYM_ENTRY_SIZE);

        // DT_PLTGOT
        this.write64(DT_PLTGOT);
        this.write64(gotVaddr);

        // DT_PLTRELSZ
        this.write64(DT_PLTRELSZ);
        this.write64(relaSize);

        // DT_PLTREL
        this.write64(DT_PLTREL);
        this.write64(7); // DT_RELA

        // DT_JMPREL
        this.write64(DT_JMPREL);
        this.write64(relaVaddr);

        // DT_NULL
        this.write64(DT_NULL);
        this.write64(0);

        // ========== .data ==========
        this.padTo(dataOffset);
        if (dataBytes.length > 0) {
            this.writeBytes(dataBytes);
        }

        return this.buffer;
    }

    _buildDynstr() {
        let result = [0]; // 开头 null
        this._dynstrOffsets = {};
        this._dynstrOffsets[""] = 0;

        let offset = 1;

        // 添加库名
        for (let i = 0; i < this.neededLibs.length; i++) {
            let name = this.neededLibs[i];
            this._dynstrOffsets[name] = offset;
            for (let j = 0; j < name.length; j++) {
                result.push(name.charCodeAt(j));
            }
            result.push(0);
            offset += name.length + 1;
        }

        // 添加符号名
        for (let i = 0; i < this.importedSymbols.length; i++) {
            let name = this.importedSymbols[i];
            this._dynstrOffsets[name] = offset;
            for (let j = 0; j < name.length; j++) {
                result.push(name.charCodeAt(j));
            }
            result.push(0);
            offset += name.length + 1;
        }

        return result;
    }

    _getDynstrOffset(name) {
        return this._dynstrOffsets[name] || 0;
    }

    // 计算布局（在生成代码前调用）
    calculateLayout(codeSize, dataSize) {
        const ELF_HEADER_SIZE = 64;
        const PROG_HEADER_SIZE = 56;
        const SYM_ENTRY_SIZE = 24;
        const RELA_ENTRY_SIZE = 24;
        const DYN_ENTRY_SIZE = 16;

        // 构建字符串表
        let dynstrContent = this._buildDynstr();

        // 计算符号数量（包括 NULL 符号）
        let numSymbols = this.importedSymbols.length + 1;

        // 计算各段大小
        let interpStr = "/lib64/ld-linux-x86-64.so.2\0";
        let interpSize = interpStr.length;

        // .dynsym
        let dynsymSize = numSymbols * SYM_ENTRY_SIZE;

        // .dynstr
        let dynstrSize = dynstrContent.length;

        // .hash
        let hashSize = (2 + numSymbols + numSymbols) * 4;

        // .rela.plt
        let relaSize = this.importedSymbols.length * RELA_ENTRY_SIZE;

        // .got.plt (GOT: 3个保留条目 + 每个符号一个)
        let gotSize = (3 + this.importedSymbols.length) * 8;

        // .plt
        let pltSize = 16 + this.importedSymbols.length * 16;

        // .dynamic
        let numDynEntries = 2 + this.neededLibs.length + 10;
        let dynamicSize = numDynEntries * DYN_ENTRY_SIZE;

        // 布局计算
        let numProgHeaders = 5;
        let progHeadersOffset = ELF_HEADER_SIZE;
        let progHeadersEnd = progHeadersOffset + numProgHeaders * PROG_HEADER_SIZE;

        let interpOffset = align(progHeadersEnd, 8);
        let hashOffset = align(interpOffset + interpSize, 8);
        let dynsymOffset = align(hashOffset + hashSize, 8);
        let dynstrOffset = align(dynsymOffset + dynsymSize, 8);
        let relaOffset = align(dynstrOffset + dynstrSize, 8);
        let pltOffset = pageAlign(relaOffset + relaSize);
        let textOffset = pltOffset + pltSize;

        // 数据段布局 (和 generate 函数一致)
        let gotOffset = pageAlign(textOffset + codeSize);
        let dynamicOffset = gotOffset + gotSize;
        let dataOffset = align(dynamicOffset + dynamicSize, 8);

        // 存储计算结果
        this._layout = {
            pltOffset: pltOffset,
            textOffset: textOffset,
            pltVaddr: this.baseAddr + pltOffset,
            textVaddr: this.baseAddr + textOffset,
            dataVaddr: this.baseAddr + dataOffset,
        };

        return this._layout;
    }

    getCodeVAddr() {
        if (this._layout) {
            return this._layout.textVaddr;
        }
        // 返回 .text 的虚拟地址
        // 这需要在 generate 之前计算，所以用估算值
        return this.baseAddr + 0x1070; // 估计值 - 更保守
    }

    getDataVAddr(codeSize) {
        if (this._layout) {
            return this._layout.dataVaddr;
        }
        // 估算数据段地址
        let textEnd = 0x1070 + codeSize;
        let dataStart = pageAlign(textEnd);
        return this.baseAddr + dataStart;
    }

    getPltVAddr() {
        if (this._layout) {
            return this._layout.pltVaddr;
        }
        // PLT 虚拟地址
        return this.baseAddr + 0x1000; // 估计值
    }

    // 获取某个符号的 PLT 入口地址
    getPltEntryVAddr(symbolName) {
        let idx = this.importedSymbols.indexOf(symbolName);
        if (idx < 0) return 0;
        return this.getPltVAddr() + 16 + idx * 16;
    }

    // ========== 共享库 (.so) 生成 ==========

    generateSO(codeBytes, dataBytes) {
        this.buffer = [];
        this.baseAddr = 0; // 共享库是位置无关的

        const ELF_HEADER_SIZE = 64;
        const PROG_HEADER_SIZE = 56;
        const SECT_HEADER_SIZE = 64;
        const SYM_ENTRY_SIZE = 24;
        const DYN_ENTRY_SIZE = 16;

        const numProgHeaders = 4;
        const numSections = 8;

        const progHeadersOffset = ELF_HEADER_SIZE;
        const progHeadersSize = numProgHeaders * PROG_HEADER_SIZE;

        // .hash
        const hashOffset = progHeadersOffset + progHeadersSize;
        const numSymbols = this.exportedSymbols.length + 1;
        let hashSize = (2 + numSymbols + numSymbols) * 4;
        hashSize = align(hashSize, 8);

        // .dynsym
        const dynsymOffset = hashOffset + hashSize;
        const dynsymSize = numSymbols * SYM_ENTRY_SIZE;

        // .dynstr
        const dynstrOffset = dynsymOffset + dynsymSize;
        const dynstrContent = this._buildSODynstr();
        const dynstrSize = align(dynstrContent.length, 8);

        // .text
        const textOffset = align(dynstrOffset + dynstrSize, this.pageSize);
        const textSize = codeBytes.length;

        // .dynamic
        const dynamicOffset = align(textOffset + textSize, this.pageSize);
        let numDynEntries = 6;
        if (this.soname) numDynEntries++;
        const dynamicSize = numDynEntries * DYN_ENTRY_SIZE;

        // .data
        const dataOffset = align(dynamicOffset + dynamicSize, 8);
        const dataSize = dataBytes.length;

        // .shstrtab
        const shstrtabOffset = dataOffset + dataSize;
        const shstrtabContent = this._buildShstrtab();
        const shstrtabSize = shstrtabContent.length;

        // Section headers
        const shOffset = align(shstrtabOffset + shstrtabSize, 8);

        // 虚拟地址 = 文件偏移
        const hashVAddr = hashOffset;
        const dynsymVAddr = dynsymOffset;
        const dynstrVAddr = dynstrOffset;
        const textVAddr = textOffset;
        const dynamicVAddr = dynamicOffset;
        const dataVAddr = dataOffset;

        // === ELF Header ===
        this.writeBytes(ELF_MAGIC);
        this.write(ELFCLASS64);
        this.write(ELFDATA2LSB);
        this.write(EV_CURRENT);
        this.write(ELFOSABI_SYSV);
        for (let i = 0; i < 8; i++) this.write(0);

        this.write16(ET_DYN);
        this.write16(this.arch === "arm64" ? EM_AARCH64 : EM_X86_64);
        this.write32(EV_CURRENT);
        this.write64(textVAddr);
        this.write64(progHeadersOffset);
        this.write64(shOffset);
        this.write32(0);
        this.write16(ELF_HEADER_SIZE);
        this.write16(PROG_HEADER_SIZE);
        this.write16(numProgHeaders);
        this.write16(SECT_HEADER_SIZE);
        this.write16(numSections);
        this.write16(numSections - 1);

        // === Program Headers ===
        // PT_PHDR
        this.write32(PT_PHDR);
        this.write32(PF_R);
        this.write64(progHeadersOffset);
        this.write64(progHeadersOffset);
        this.write64(progHeadersOffset);
        this.write64(progHeadersSize);
        this.write64(progHeadersSize);
        this.write64(8);

        // PT_LOAD (RX)
        this.write32(PT_LOAD);
        this.write32(PF_R | PF_X);
        this.write64(0);
        this.write64(0);
        this.write64(0);
        this.write64(textOffset + textSize);
        this.write64(textOffset + textSize);
        this.write64(this.pageSize);

        // PT_DYNAMIC
        this.write32(PT_DYNAMIC);
        this.write32(PF_R | PF_W);
        this.write64(dynamicOffset);
        this.write64(dynamicVAddr);
        this.write64(dynamicVAddr);
        this.write64(dynamicSize);
        this.write64(dynamicSize);
        this.write64(8);

        // PT_LOAD (RW)
        this.write32(PT_LOAD);
        this.write32(PF_R | PF_W);
        this.write64(dynamicOffset);
        this.write64(dynamicVAddr);
        this.write64(dynamicVAddr);
        const rwSize = dataOffset + dataSize - dynamicOffset;
        this.write64(rwSize);
        this.write64(rwSize);
        this.write64(this.pageSize);

        // === .hash ===
        this.padTo(hashOffset);
        this._writeSOHash(numSymbols);

        // === .dynsym ===
        this.padTo(dynsymOffset);
        this._writeSODynsym(textVAddr);

        // === .dynstr ===
        this.padTo(dynstrOffset);
        this.writeBytes(dynstrContent);
        this.padTo(align(dynstrOffset + dynstrContent.length, 8));

        // === .text ===
        this.padTo(textOffset);
        this.writeBytes(codeBytes);

        // === .dynamic ===
        this.padTo(dynamicOffset);
        this._writeSODynamic(hashVAddr, dynsymVAddr, dynstrVAddr, dynstrContent.length);

        // === .data ===
        this.padTo(dataOffset);
        if (dataSize > 0) {
            this.writeBytes(dataBytes);
        }

        // === .shstrtab ===
        this.padTo(shstrtabOffset);
        this.writeBytes(shstrtabContent);

        // === Section Headers ===
        this.padTo(shOffset);
        this._writeSOSectionHeaders(hashOffset, hashSize, hashVAddr, dynsymOffset, dynsymSize, dynsymVAddr, dynstrOffset, dynstrContent.length, dynstrVAddr, textOffset, textSize, textVAddr, dynamicOffset, dynamicSize, dynamicVAddr, dataOffset, dataSize, dataVAddr, shstrtabOffset, shstrtabContent.length);

        // 保存布局信息
        this._layout = {
            textOffset: textOffset,
            textVaddr: textVAddr,
            dataVaddr: dataVAddr,
        };

        return new Uint8Array(this.buffer);
    }

    _buildSODynstr() {
        const result = [0];

        if (this.soname) {
            this._sonameOffset = result.length;
            for (let i = 0; i < this.soname.length; i++) {
                result.push(this.soname.charCodeAt(i));
            }
            result.push(0);
        }

        this._symbolOffsets = {};
        for (const sym of this.exportedSymbols) {
            this._symbolOffsets[sym.name] = result.length;
            for (let i = 0; i < sym.name.length; i++) {
                result.push(sym.name.charCodeAt(i));
            }
            result.push(0);
        }

        return new Uint8Array(result);
    }

    _buildShstrtab() {
        const names = ["", ".hash", ".dynsym", ".dynstr", ".text", ".dynamic", ".data", ".shstrtab"];
        const result = [];
        this._shstrtabOffsets = {};

        for (const name of names) {
            this._shstrtabOffsets[name] = result.length;
            for (let i = 0; i < name.length; i++) {
                result.push(name.charCodeAt(i));
            }
            result.push(0);
        }

        return new Uint8Array(result);
    }

    _elfHash(name) {
        let h = 0;
        for (let i = 0; i < name.length; i++) {
            h = (h << 4) + name.charCodeAt(i);
            const g = h & 0xf0000000;
            if (g !== 0) h ^= g >>> 24;
            h &= ~g;
        }
        return h >>> 0;
    }

    _writeSOHash(numSymbols) {
        const nbucket = numSymbols > 1 ? numSymbols : 1;
        const nchain = numSymbols;
        const buckets = new Array(nbucket).fill(0);
        const chains = new Array(nchain).fill(0);

        for (let i = 0; i < this.exportedSymbols.length; i++) {
            const symIndex = i + 1;
            const sym = this.exportedSymbols[i];
            const hash = this._elfHash(sym.name);
            const bucketIdx = hash % nbucket;
            chains[symIndex] = buckets[bucketIdx];
            buckets[bucketIdx] = symIndex;
        }

        this.write32(nbucket);
        this.write32(nchain);
        for (const b of buckets) this.write32(b);
        for (const c of chains) this.write32(c);
    }

    _writeSODynsym(textVAddr) {
        // NULL 符号
        for (let i = 0; i < 24; i++) this.write(0);

        for (const sym of this.exportedSymbols) {
            const nameOffset = this._symbolOffsets[sym.name];
            this.write32(nameOffset);
            this.write((STB_GLOBAL << 4) | STT_FUNC);
            this.write(0);
            this.write16(4); // .text section index
            this.write64(textVAddr + sym.offset);
            this.write64(0);
        }
    }

    _writeSODynamic(hashVAddr, dynsymVAddr, dynstrVAddr, dynstrSize) {
        this.write64(DT_HASH);
        this.write64(hashVAddr);
        this.write64(DT_STRTAB);
        this.write64(dynstrVAddr);
        this.write64(DT_SYMTAB);
        this.write64(dynsymVAddr);
        this.write64(DT_STRSZ);
        this.write64(dynstrSize);
        this.write64(DT_SYMENT);
        this.write64(24);
        if (this.soname) {
            this.write64(DT_SONAME);
            this.write64(this._sonameOffset);
        }
        this.write64(DT_NULL);
        this.write64(0);
    }

    _writeSOSectionHeaders(hashOffset, hashSize, hashVAddr, dynsymOffset, dynsymSize, dynsymVAddr, dynstrOffset, dynstrSize, dynstrVAddr, textOffset, textSize, textVAddr, dynamicOffset, dynamicSize, dynamicVAddr, dataOffset, dataSize, dataVAddr, shstrtabOffset, shstrtabSize) {
        // NULL
        for (let i = 0; i < 64; i++) this.write(0);

        // .hash
        this._writeSH(this._shstrtabOffsets[".hash"], SHT_HASH, SHF_ALLOC, hashVAddr, hashOffset, hashSize, 2, 0, 4, 4);
        // .dynsym
        this._writeSH(this._shstrtabOffsets[".dynsym"], SHT_DYNSYM, SHF_ALLOC, dynsymVAddr, dynsymOffset, dynsymSize, 3, 1, 8, 24);
        // .dynstr
        this._writeSH(this._shstrtabOffsets[".dynstr"], SHT_STRTAB, SHF_ALLOC, dynstrVAddr, dynstrOffset, dynstrSize, 0, 0, 1, 0);
        // .text
        this._writeSH(this._shstrtabOffsets[".text"], SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR, textVAddr, textOffset, textSize, 0, 0, 16, 0);
        // .dynamic
        this._writeSH(this._shstrtabOffsets[".dynamic"], SHT_DYNAMIC, SHF_ALLOC | SHF_WRITE, dynamicVAddr, dynamicOffset, dynamicSize, 3, 0, 8, 16);
        // .data
        this._writeSH(this._shstrtabOffsets[".data"], SHT_PROGBITS, SHF_ALLOC | SHF_WRITE, dataVAddr, dataOffset, dataSize, 0, 0, 8, 0);
        // .shstrtab
        this._writeSH(this._shstrtabOffsets[".shstrtab"], SHT_STRTAB, 0, 0, shstrtabOffset, shstrtabSize, 0, 0, 1, 0);
    }

    _writeSH(name, type, flags, addr, offset, size, link, info, addralign, entsize) {
        this.write32(name);
        this.write32(type);
        this.write64(flags);
        this.write64(addr);
        this.write64(offset);
        this.write64(size);
        this.write32(link);
        this.write32(info);
        this.write64(addralign);
        this.write64(entsize);
    }

    getSOCodeVAddr() {
        return 0x1000;
    }

    getSODataVAddr(codeSize) {
        return 0x2000 + pageAlign(codeSize, this.pageSize);
    }
}
