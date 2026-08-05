// COFF 64位可重定位目标文件生成器 - x64
// 用于生成 Windows .obj 文件，可被 lib 工具打包成静态库 .lib

// COFF Machine 类型
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

// Section 特性
const IMAGE_SCN_CNT_CODE = 0x00000020;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;
const IMAGE_SCN_CNT_UNINITIALIZED_DATA = 0x00000080;
const IMAGE_SCN_LNK_NRELOC_OVFL = 0x01000000;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;
const IMAGE_SCN_MEM_WRITE = 0x80000000;
const IMAGE_SCN_ALIGN_1BYTES = 0x00100000;
const IMAGE_SCN_ALIGN_4BYTES = 0x00300000;
const IMAGE_SCN_ALIGN_8BYTES = 0x00400000;
const IMAGE_SCN_ALIGN_16BYTES = 0x00500000;

// 符号类型
const IMAGE_SYM_TYPE_NULL = 0;
const IMAGE_SYM_DTYPE_FUNCTION = 0x20;

// 符号存储类
const IMAGE_SYM_CLASS_EXTERNAL = 2;
const IMAGE_SYM_CLASS_STATIC = 3;
const IMAGE_SYM_CLASS_LABEL = 6;
const IMAGE_SYM_CLASS_FILE = 103;

// 重定位类型 (AMD64)
const IMAGE_REL_AMD64_ADDR64 = 0x0001;
const IMAGE_REL_AMD64_ADDR32 = 0x0002;
const IMAGE_REL_AMD64_ADDR32NB = 0x0003;
const IMAGE_REL_AMD64_REL32 = 0x0004;
const IMAGE_REL_AMD64_REL32_1 = 0x0005;
const IMAGE_REL_AMD64_REL32_2 = 0x0006;
const IMAGE_REL_AMD64_REL32_3 = 0x0007;
const IMAGE_REL_AMD64_REL32_4 = 0x0008;
const IMAGE_REL_AMD64_REL32_5 = 0x0009;
const IMAGE_REL_AMD64_SECTION = 0x000a;
const IMAGE_REL_AMD64_SECREL = 0x000b;

export class COFFObjectGenerator {
    constructor(arch = "x64") {
        this.arch = arch;
        this.buffer = [];
        this.exports = [];
        this.undefinedSymbols = [];
        this.branchRelocations = [];
    }

    setExports(exports) {
        this.exports = exports;
    }

    setUndefinedSymbols(symbols) {
        this.undefinedSymbols = symbols || [];
    }

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

    padTo(offset) {
        while (this.buffer.length < offset) {
            this.write(0);
        }
    }

    align(alignment) {
        while (this.buffer.length % alignment !== 0) {
            this.write(0);
        }
    }

    stringToBytes(str) {
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            bytes.push(str.charCodeAt(i));
        }
        return bytes;
    }

    generate(codeBytes, dataBytes, labels) {
        labels = labels || {};

        // COFF Header: 20 字节
        const COFF_HEADER_SIZE = 20;
        const SECTION_HEADER_SIZE = 40;
        const SYMBOL_SIZE = 18;
        const RELOC_SIZE = 10;

        // 确定 section 数量
        const numSections = dataBytes.length > 0 ? 2 : 1;

        // 计算各部分位置
        const sectionHeadersOffset = COFF_HEADER_SIZE;
        const sectionHeadersSize = numSections * SECTION_HEADER_SIZE;

        // 代码段从 section headers 后开始
        const textOffset = sectionHeadersOffset + sectionHeadersSize;
        const textSize = codeBytes.length;

        // 数据段跟在代码段后
        const dataOffset = textOffset + textSize;
        const dataSize = dataBytes.length;

        // 构建符号表
        const { symbols, stringTable, symbolIndices } = this.buildSymbolTable(labels);

        // 构建重定位表
        const relocations = this.buildRelocations(symbolIndices);
        const numTextRelocs = relocations.length;

        // 重定位表位置
        const textRelocOffset = dataOffset + dataSize;
        const textRelocSize = numTextRelocs * RELOC_SIZE;

        // 符号表位置
        const symtabOffset = textRelocOffset + textRelocSize;
        const numSymbols = symbols.length;

        // 字符串表位置（紧跟符号表）
        const stringTableOffset = symtabOffset + numSymbols * SYMBOL_SIZE;

        // === 写入 COFF Header ===
        this.write16(IMAGE_FILE_MACHINE_AMD64); // Machine
        this.write16(numSections); // NumberOfSections
        this.write32(0); // TimeDateStamp
        this.write32(symtabOffset); // PointerToSymbolTable
        this.write32(numSymbols); // NumberOfSymbols
        this.write16(0); // SizeOfOptionalHeader
        this.write16(0); // Characteristics

        // === 写入 Section Headers ===

        // .text section
        this.writeSectionName(".text");
        this.write32(0); // VirtualSize (0 for object files)
        this.write32(0); // VirtualAddress
        this.write32(textSize); // SizeOfRawData
        this.write32(textOffset); // PointerToRawData
        this.write32(numTextRelocs > 0 ? textRelocOffset : 0); // PointerToRelocations
        this.write32(0); // PointerToLinenumbers
        this.write16(numTextRelocs); // NumberOfRelocations
        this.write16(0); // NumberOfLinenumbers
        this.write32(IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE | IMAGE_SCN_MEM_READ | IMAGE_SCN_ALIGN_16BYTES); // Characteristics

        // .data section (if needed)
        if (dataSize > 0) {
            this.writeSectionName(".data");
            this.write32(0); // VirtualSize
            this.write32(0); // VirtualAddress
            this.write32(dataSize); // SizeOfRawData
            this.write32(dataOffset); // PointerToRawData
            this.write32(0); // PointerToRelocations
            this.write32(0); // PointerToLinenumbers
            this.write16(0); // NumberOfRelocations
            this.write16(0); // NumberOfLinenumbers
            this.write32(IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE | IMAGE_SCN_ALIGN_8BYTES); // Characteristics
        }

        // === 写入 .text section data ===
        this.writeBytes(codeBytes);

        // === 写入 .data section data ===
        if (dataSize > 0) {
            this.writeBytes(dataBytes);
        }

        // === 写入重定位表 ===
        for (const reloc of relocations) {
            this.write32(reloc.virtualAddress);
            this.write32(reloc.symbolTableIndex);
            this.write16(reloc.type);
        }

        // === 写入符号表 ===
        for (const sym of symbols) {
            this.writeSymbol(sym);
        }

        // === 写入字符串表 ===
        // 字符串表第一个 4 字节是表的大小
        this.write32(stringTable.length + 4);
        this.writeBytes(stringTable);

        return new Uint8Array(this.buffer);
    }

    writeSectionName(name) {
        // COFF section name 是 8 字节
        // 如果名字 <= 8 字节，直接写入
        // 如果 > 8 字节，需要用 "/offset" 格式引用字符串表
        const bytes = [];
        for (let i = 0; i < 8; i++) {
            bytes.push(i < name.length ? name.charCodeAt(i) : 0);
        }
        this.writeBytes(bytes);
    }

    writeSymbol(sym) {
        // COFF Symbol Entry: 18 bytes
        // 名字字段: 8 bytes (短名或字符串表引用)
        if (sym.name.length <= 8) {
            // 短名：直接写入
            for (let i = 0; i < 8; i++) {
                this.write(i < sym.name.length ? sym.name.charCodeAt(i) : 0);
            }
        } else {
            // 长名：写入 0 + 字符串表偏移
            this.write32(0);
            this.write32(sym.stringTableOffset);
        }
        this.write32(sym.value); // Value
        this.write16(sym.sectionNumber); // SectionNumber (1-based, 0=undefined)
        this.write16(sym.type); // Type
        this.write(sym.storageClass); // StorageClass
        this.write(sym.numberOfAuxSymbols); // NumberOfAuxSymbols
    }

    buildSymbolTable(labels) {
        const symbols = [];
        const stringTableBytes = [];
        let stringTableOffset = 4; // 前 4 字节是大小
        const symbolIndices = {};

        const addToStringTable = (name) => {
            const offset = stringTableOffset;
            for (let i = 0; i < name.length; i++) {
                stringTableBytes.push(name.charCodeAt(i));
            }
            stringTableBytes.push(0);
            stringTableOffset += name.length + 1;
            return offset;
        };

        // Section 符号
        // .text section symbol
        symbols.push({
            name: ".text",
            value: 0,
            sectionNumber: 1,
            type: IMAGE_SYM_TYPE_NULL,
            storageClass: IMAGE_SYM_CLASS_STATIC,
            numberOfAuxSymbols: 0,
            stringTableOffset: 0,
        });

        // .data section symbol (if needed)
        // symbols.push({
        //     name: ".data",
        //     value: 0,
        //     sectionNumber: 2,
        //     type: IMAGE_SYM_TYPE_NULL,
        //     storageClass: IMAGE_SYM_CLASS_STATIC,
        //     numberOfAuxSymbols: 0,
        //     stringTableOffset: 0
        // });

        const addedSymbols = new Set();

        // 为导出的函数添加符号
        for (const name of this.exports) {
            // 内部函数 _user_xxx
            const userLabel = "_user_" + name;
            if (labels[userLabel] !== undefined && !addedSymbols.has(userLabel)) {
                const symName = userLabel;
                const sym = {
                    name: symName,
                    value: labels[userLabel],
                    sectionNumber: 1, // .text
                    type: IMAGE_SYM_DTYPE_FUNCTION,
                    storageClass: IMAGE_SYM_CLASS_EXTERNAL,
                    numberOfAuxSymbols: 0,
                    stringTableOffset: symName.length > 8 ? addToStringTable(symName) : 0,
                };
                symbolIndices[userLabel] = symbols.length;
                symbols.push(sym);
                addedSymbols.add(userLabel);
            }

            // 导出 wrapper _xxx
            const wrapperLabel = "_" + name;
            if (labels[wrapperLabel] !== undefined && !addedSymbols.has(wrapperLabel)) {
                const symName = wrapperLabel;
                const sym = {
                    name: symName,
                    value: labels[wrapperLabel],
                    sectionNumber: 1,
                    type: IMAGE_SYM_DTYPE_FUNCTION,
                    storageClass: IMAGE_SYM_CLASS_EXTERNAL,
                    numberOfAuxSymbols: 0,
                    stringTableOffset: symName.length > 8 ? addToStringTable(symName) : 0,
                };
                symbolIndices[wrapperLabel] = symbols.length;
                symbols.push(sym);
                addedSymbols.add(wrapperLabel);
            }
        }

        // _main
        if (labels["_main"] !== undefined && !addedSymbols.has("_main")) {
            const sym = {
                name: "_main",
                value: labels["_main"],
                sectionNumber: 1,
                type: IMAGE_SYM_DTYPE_FUNCTION,
                storageClass: IMAGE_SYM_CLASS_EXTERNAL,
                numberOfAuxSymbols: 0,
                stringTableOffset: 0,
            };
            symbolIndices["_main"] = symbols.length;
            symbols.push(sym);
            addedSymbols.add("_main");
        }

        // 未定义符号
        for (const name of this.undefinedSymbols) {
            if (!addedSymbols.has(name)) {
                const sym = {
                    name: name,
                    value: 0,
                    sectionNumber: 0, // undefined
                    type: IMAGE_SYM_DTYPE_FUNCTION,
                    storageClass: IMAGE_SYM_CLASS_EXTERNAL,
                    numberOfAuxSymbols: 0,
                    stringTableOffset: name.length > 8 ? addToStringTable(name) : 0,
                };
                symbolIndices[name] = symbols.length;
                symbols.push(sym);
                addedSymbols.add(name);
            }
        }

        return {
            symbols,
            stringTable: stringTableBytes,
            symbolIndices,
        };
    }

    buildRelocations(symbolIndices) {
        const relocations = [];

        for (const reloc of this.branchRelocations) {
            const symIdx = symbolIndices[reloc.symbol];
            if (symIdx !== undefined) {
                relocations.push({
                    virtualAddress: reloc.offset,
                    symbolTableIndex: symIdx,
                    type: IMAGE_REL_AMD64_REL32,
                });
            }
        }

        return relocations;
    }
}
