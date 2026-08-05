// PE 64位 DLL 动态链接库生成器 (Windows)
// 所有数值使用十进制

// DOS Header
let MZ_SIGNATURE = [77, 90]; // "MZ"

// PE 常量
let PE_SIGNATURE = [80, 69, 0, 0]; // "PE\0\0"
let IMAGE_FILE_MACHINE_AMD64 = 34404; // 0x8664
let IMAGE_FILE_EXECUTABLE_IMAGE = 2;
let IMAGE_FILE_LARGE_ADDRESS_AWARE = 32;
let IMAGE_FILE_DLL = 8192; // 0x2000
let IMAGE_SUBSYSTEM_CONSOLE = 3;

// Section 特性
let IMAGE_SCN_CNT_CODE = 32; // 0x00000020
let IMAGE_SCN_CNT_INITIALIZED_DATA = 64; // 0x00000040
let IMAGE_SCN_MEM_EXECUTE = 536870912; // 0x20000000
let IMAGE_SCN_MEM_READ = 1073741824; // 0x40000000
let IMAGE_SCN_MEM_WRITE = 2147483648; // 0x80000000

export class PE64DllGenerator {
    constructor() {
        this.buffer = [];
        this.baseAddr = 5368709120; // 0x140000000
        this.exportedSymbols = [];
    }

    // 为了与其他生成器保持一致的接口
    addExportedSymbol(name, offset) {
        this.exportedSymbols.push({ name: name, offset: offset });
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

    writeNullTerminated(str) {
        for (let i = 0; i < str.length; i = i + 1) {
            this.write(str.charCodeAt(i));
        }
        this.write(0);
    }

    padTo(offset) {
        while (this.buffer.length < offset) {
            this.write(0);
        }
    }

    alignTo(alignment) {
        while (this.buffer.length % alignment !== 0) {
            this.write(0);
        }
    }

    // 计算导出表数据
    buildExportData(exports, dllName, textRVA) {
        // exports: [{name: "funcName", offset: 123}, ...]
        // 返回: {data: bytes, size: number}

        let numExports = exports.length;

        // 导出目录表大小: 40 字节
        // 地址表: numExports * 4 字节
        // 名称指针表: numExports * 4 字节
        // 序号表: numExports * 2 字节
        // DLL 名称字符串
        // 函数名称字符串数组

        // 首先计算所有字符串偏移
        let exportDirSize = 40;
        let addressTableOffset = exportDirSize;
        let addressTableSize = numExports * 4;
        let namePointerTableOffset = addressTableOffset + addressTableSize;
        let namePointerTableSize = numExports * 4;
        let ordinalTableOffset = namePointerTableOffset + namePointerTableSize;
        let ordinalTableSize = numExports * 2;
        // 序号表后需要对齐到 4 字节边界，以便字符串从 4 字节对齐位置开始
        // 如果导出数量是奇数，序号表大小为奇数*2，需要额外 2 字节对齐
        if (numExports % 2 !== 0) {
            ordinalTableSize = ordinalTableSize + 2;
        }
        let stringsOffset = ordinalTableOffset + ordinalTableSize;

        // 计算字符串总大小
        let dllNameOffset = stringsOffset;
        let dllNameSize = dllName.length + 1;
        let funcNamesStart = dllNameOffset + dllNameSize;

        // 按名称排序（PE导出表要求按名称字母顺序排序）
        let sortedExports = [];
        for (let i = 0; i < exports.length; i = i + 1) {
            sortedExports.push(exports[i]);
        }
        // 简单冒泡排序
        for (let i = 0; i < sortedExports.length - 1; i = i + 1) {
            for (let j = 0; j < sortedExports.length - 1 - i; j = j + 1) {
                if (sortedExports[j].name > sortedExports[j + 1].name) {
                    let temp = sortedExports[j];
                    sortedExports[j] = sortedExports[j + 1];
                    sortedExports[j + 1] = temp;
                }
            }
        }

        // 计算每个函数名的偏移
        let funcNameOffsets = [];
        let currentOffset = funcNamesStart;
        for (let i = 0; i < sortedExports.length; i = i + 1) {
            funcNameOffsets.push(currentOffset);
            currentOffset = currentOffset + sortedExports[i].name.length + 1;
        }

        let totalSize = currentOffset;

        // 构建导出数据
        let data = [];

        // 导出目录表 (40 bytes)
        // Characteristics (4)
        pushDword(data, 0);
        // TimeDateStamp (4)
        pushDword(data, 0);
        // MajorVersion (2)
        pushWord(data, 0);
        // MinorVersion (2)
        pushWord(data, 0);
        // Name RVA (4) - 指向 DLL 名称
        pushDword(data, dllNameOffset); // 将在外部加上 section RVA
        // Base (4) - 序号基值
        pushDword(data, 1);
        // NumberOfFunctions (4)
        pushDword(data, numExports);
        // NumberOfNames (4)
        pushDword(data, numExports);
        // AddressOfFunctions RVA (4)
        pushDword(data, addressTableOffset);
        // AddressOfNames RVA (4)
        pushDword(data, namePointerTableOffset);
        // AddressOfNameOrdinals RVA (4)
        pushDword(data, ordinalTableOffset);

        // 地址表 (Export Address Table)
        for (let i = 0; i < sortedExports.length; i = i + 1) {
            // RVA of function
            pushDword(data, textRVA + sortedExports[i].offset);
        }

        // 名称指针表 (Export Name Pointer Table)
        for (let i = 0; i < sortedExports.length; i = i + 1) {
            pushDword(data, funcNameOffsets[i]);
        }

        // 序号表 (Export Ordinal Table)
        for (let i = 0; i < sortedExports.length; i = i + 1) {
            pushWord(data, i);
        }
        // 对齐
        if (sortedExports.length % 2 !== 0) {
            pushWord(data, 0);
        }

        // DLL 名称字符串
        for (let i = 0; i < dllName.length; i = i + 1) {
            data.push(dllName.charCodeAt(i));
        }
        data.push(0);

        // 函数名称字符串
        for (let i = 0; i < sortedExports.length; i = i + 1) {
            let name = sortedExports[i].name;
            for (let j = 0; j < name.length; j = j + 1) {
                data.push(name.charCodeAt(j));
            }
            data.push(0);
        }

        return { data: data, size: totalSize };
    }

    generate(codeBytes, dataBytes, exports, dllName) {
        // exports: [{name: "funcName", offset: 123}, ...]
        // 如果没有传入 exports，使用 addExportedSymbol 添加的符号
        if (!exports || exports.length === 0) {
            exports = this.exportedSymbols;
        }
        if (!dllName) {
            dllName = "output.dll";
        }

        let DOS_HEADER_SIZE = 64;
        let PE_SIG_SIZE = 4;
        let COFF_HEADER_SIZE = 20;
        let OPTIONAL_HEADER_SIZE = 112 + 16 * 8;
        let SECTION_HEADER_SIZE = 40;
        let NUM_SECTIONS = 3; // .text, .data, .edata

        let peHeaderOffset = DOS_HEADER_SIZE;
        let optionalHeaderOffset = peHeaderOffset + PE_SIG_SIZE + COFF_HEADER_SIZE;
        let sectionHeadersOffset = optionalHeaderOffset + OPTIONAL_HEADER_SIZE;
        let headersSize = sectionHeadersOffset + NUM_SECTIONS * SECTION_HEADER_SIZE;

        let fileAlignment = 512; // 0x200
        let sectionAlignment = 4096; // 0x1000

        // .text section
        let textRawOffset = Math.ceil(headersSize / fileAlignment) * fileAlignment;
        let textRVA = sectionAlignment;
        let textSize = codeBytes.length;
        let textRawSize = Math.ceil(textSize / fileAlignment) * fileAlignment;
        let textVirtualSize = Math.ceil(textSize / sectionAlignment) * sectionAlignment;

        // .data section
        let dataRawOffset = textRawOffset + textRawSize;
        let dataRVA = textRVA + textVirtualSize;
        let dataSize = dataBytes.length;
        let dataRawSize = dataSize > 0 ? Math.ceil(dataSize / fileAlignment) * fileAlignment : fileAlignment;
        let dataVirtualSize = dataSize > 0 ? Math.ceil(dataSize / sectionAlignment) * sectionAlignment : sectionAlignment;

        // .edata section (导出表)
        let edataRawOffset = dataRawOffset + dataRawSize;
        let edataRVA = dataRVA + dataVirtualSize;

        // 构建导出表数据
        let exportData = this.buildExportData(exports, dllName, textRVA);
        let edataSize = exportData.size;
        let edataRawSize = Math.ceil(edataSize / fileAlignment) * fileAlignment;
        let edataVirtualSize = Math.ceil(edataSize / sectionAlignment) * sectionAlignment;

        // 更新导出表中的 RVA (加上 section base)
        let edataBytes = exportData.data;
        // 修正 Name RVA (offset 12)
        let nameRVA = edataRVA + readDword(edataBytes, 12);
        writeDword(edataBytes, 12, nameRVA);
        // 修正 AddressOfFunctions RVA (offset 28)
        let addrFuncsRVA = edataRVA + readDword(edataBytes, 28);
        writeDword(edataBytes, 28, addrFuncsRVA);
        // 修正 AddressOfNames RVA (offset 32)
        let addrNamesRVA = edataRVA + readDword(edataBytes, 32);
        writeDword(edataBytes, 32, addrNamesRVA);
        // 修正 AddressOfNameOrdinals RVA (offset 36)
        let addrOrdsRVA = edataRVA + readDword(edataBytes, 36);
        writeDword(edataBytes, 36, addrOrdsRVA);

        // 修正名称指针表中的 RVA
        let numExports = exports.length;
        let namePointerTableOffset = 40 + numExports * 4;
        for (let i = 0; i < numExports; i = i + 1) {
            let offset = namePointerTableOffset + i * 4;
            let rva = edataRVA + readDword(edataBytes, offset);
            writeDword(edataBytes, offset, rva);
        }

        let imageSize = edataRVA + edataVirtualSize;
        let entryPointRVA = 0; // DLL 不需要入口点

        // DOS Header
        this.writeBytes(MZ_SIGNATURE);
        this.write16(144);
        this.write16(3);
        this.write16(0);
        this.write16(4);
        this.write16(0);
        this.write16(65535);
        this.write16(0);
        this.write16(184);
        this.write16(0);
        this.write16(0);
        this.write16(0);
        this.write16(64);
        this.write16(0);
        for (let i = 0; i < 4; i = i + 1) {
            this.write16(0);
        }
        this.write16(0);
        this.write16(0);
        for (let i = 0; i < 10; i = i + 1) {
            this.write16(0);
        }
        this.write32(peHeaderOffset);

        // PE Signature
        this.writeBytes(PE_SIGNATURE);

        // COFF Header
        this.write16(IMAGE_FILE_MACHINE_AMD64);
        this.write16(NUM_SECTIONS);
        this.write32(0); // TimeDateStamp
        this.write32(0); // PointerToSymbolTable
        this.write32(0); // NumberOfSymbols
        this.write16(OPTIONAL_HEADER_SIZE);
        // Characteristics: EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE | DLL
        this.write16(IMAGE_FILE_EXECUTABLE_IMAGE | IMAGE_FILE_LARGE_ADDRESS_AWARE | IMAGE_FILE_DLL);

        // Optional Header (PE32+)
        this.write16(523); // 0x20B PE32+
        this.write(14); // MajorLinkerVersion
        this.write(0); // MinorLinkerVersion
        this.write32(textSize); // SizeOfCode
        this.write32(dataSize + edataSize); // SizeOfInitializedData
        this.write32(0); // SizeOfUninitializedData
        this.write32(entryPointRVA); // AddressOfEntryPoint
        this.write32(textRVA); // BaseOfCode

        this.write64(this.baseAddr); // ImageBase
        this.write32(sectionAlignment); // SectionAlignment
        this.write32(fileAlignment); // FileAlignment
        this.write16(6); // MajorOperatingSystemVersion
        this.write16(0);
        this.write16(0); // MajorImageVersion
        this.write16(0);
        this.write16(6); // MajorSubsystemVersion
        this.write16(0);
        this.write32(0); // Win32VersionValue
        this.write32(imageSize); // SizeOfImage
        this.write32(textRawOffset); // SizeOfHeaders
        this.write32(0); // CheckSum
        this.write16(IMAGE_SUBSYSTEM_CONSOLE);
        this.write16(0); // DllCharacteristics
        this.write64(1048576); // SizeOfStackReserve (0x100000)
        this.write64(4096); // SizeOfStackCommit
        this.write64(1048576); // SizeOfHeapReserve
        this.write64(4096); // SizeOfHeapCommit
        this.write32(0); // LoaderFlags
        this.write32(16); // NumberOfRvaAndSizes

        // Data directories (16 个)
        // 0: Export Table
        this.write32(edataRVA); // RVA
        this.write32(edataSize); // Size
        // 1: Import Table
        this.write32(0);
        this.write32(0);
        // 2-15: 其他表
        for (let i = 2; i < 16; i = i + 1) {
            this.write32(0);
            this.write32(0);
        }

        // .text section header
        this.writeString(".text", 8);
        this.write32(textSize); // VirtualSize
        this.write32(textRVA); // VirtualAddress
        this.write32(textRawSize); // SizeOfRawData
        this.write32(textRawOffset); // PointerToRawData
        this.write32(0); // PointerToRelocations
        this.write32(0); // PointerToLinenumbers
        this.write16(0); // NumberOfRelocations
        this.write16(0); // NumberOfLinenumbers
        this.write32(IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE | IMAGE_SCN_MEM_READ);

        // .data section header
        this.writeString(".data", 8);
        this.write32(dataSize > 0 ? dataSize : 1); // VirtualSize
        this.write32(dataRVA); // VirtualAddress
        this.write32(dataRawSize); // SizeOfRawData
        this.write32(dataRawOffset); // PointerToRawData
        this.write32(0);
        this.write32(0);
        this.write16(0);
        this.write16(0);
        this.write32(IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE);

        // .edata section header (导出表)
        this.writeString(".edata", 8);
        this.write32(edataSize); // VirtualSize
        this.write32(edataRVA); // VirtualAddress
        this.write32(edataRawSize); // SizeOfRawData
        this.write32(edataRawOffset); // PointerToRawData
        this.write32(0);
        this.write32(0);
        this.write16(0);
        this.write16(0);
        this.write32(IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ);

        // 填充到代码段
        this.padTo(textRawOffset);
        this.writeBytes(codeBytes);

        // 填充到数据段
        this.padTo(dataRawOffset);
        if (dataSize > 0) {
            this.writeBytes(dataBytes);
        }

        // 填充到导出表段
        this.padTo(edataRawOffset);
        this.writeBytes(edataBytes);

        // 填充到文件对齐
        let totalSize = edataRawOffset + edataRawSize;
        this.padTo(totalSize);

        return this.buffer;
    }

    getCodeVAddr() {
        return this.baseAddr + 4096; // 0x140001000
    }

    getDataVAddr(codeSize) {
        let textVirtualSize = Math.ceil(codeSize / 4096) * 4096;
        return this.baseAddr + 4096 + textVirtualSize;
    }
}

// 辅助函数
function pushWord(arr, value) {
    arr.push(value & 255);
    arr.push((value >> 8) & 255);
}

function pushDword(arr, value) {
    arr.push(value & 255);
    arr.push((value >> 8) & 255);
    arr.push((value >> 16) & 255);
    arr.push((value >> 24) & 255);
}

function readDword(arr, offset) {
    return arr[offset] | (arr[offset + 1] << 8) | (arr[offset + 2] << 16) | (arr[offset + 3] << 24);
}

function writeDword(arr, offset, value) {
    arr[offset] = value & 255;
    arr[offset + 1] = (value >> 8) & 255;
    arr[offset + 2] = (value >> 16) & 255;
    arr[offset + 3] = (value >> 24) & 255;
}
