// PE 64位可执行文件生成器 (Windows)
// 所有数值使用十进制

// DOS Header
let MZ_SIGNATURE = [77, 90]; // "MZ"

// PE 常量
let PE_SIGNATURE = [80, 69, 0, 0]; // "PE\0\0"
let IMAGE_FILE_MACHINE_AMD64 = 34404; // 0x8664
let IMAGE_FILE_EXECUTABLE_IMAGE = 2;
let IMAGE_FILE_LARGE_ADDRESS_AWARE = 32;
let IMAGE_SUBSYSTEM_CONSOLE = 3;

// Section 特性
let IMAGE_SCN_CNT_CODE = 32; // 0x00000020
let IMAGE_SCN_CNT_INITIALIZED_DATA = 64; // 0x00000040
let IMAGE_SCN_MEM_EXECUTE = 536870912; // 0x20000000
let IMAGE_SCN_MEM_READ = 1073741824; // 0x40000000
let IMAGE_SCN_MEM_WRITE = 2147483648; // 0x80000000

// Windows API 导入函数索引
export let WinAPI = {
    VirtualAlloc: 0,
    GetStdHandle: 1,
    WriteConsoleA: 2,
    ExitProcess: 3,
    GetSystemTimeAsFileTime: 4,
    // fs 面(自举需要):槽号必须与 compiler/output/generator.js 的 addImport 顺序一致
    CreateFileA: 5,
    ReadFile: 6,
    WriteFile: 7,
    CloseHandle: 8,
    GetCommandLineA: 9, // 命令行(cli.js 自举需要 process.argv)
};

export class PE64Generator {
    constructor() {
        this.buffer = [];
        this.baseAddr = 5368709120; // 0x140000000
        this.imports = []; // 导入函数列表
        this.iatRVA = 0; // Import Address Table RVA
        this.iatRelocations = []; // IAT 重定位列表
    }

    // 设置 IAT 重定位
    setIATRelocations(relocations) {
        this.iatRelocations = relocations || [];
    }

    // 添加导入函数
    addImport(dllName, funcName) {
        let entry = null;
        for (let i = 0; i < this.imports.length; i = i + 1) {
            if (this.imports[i].dll === dllName) {
                entry = this.imports[i];
                break;
            }
        }
        if (entry === null) {
            entry = { dll: dllName, functions: [] };
            this.imports.push(entry);
        }
        entry.functions.push(funcName);
    }

    // 获取函数在 IAT 中的偏移（相对于 IAT 起始）
    getImportSlot(dllName, funcName) {
        let slot = 0;
        for (let i = 0; i < this.imports.length; i = i + 1) {
            let entry = this.imports[i];
            for (let j = 0; j < entry.functions.length; j = j + 1) {
                if (entry.dll === dllName && entry.functions[j] === funcName) {
                    return slot * 8;
                }
                slot = slot + 1;
            }
            slot = slot + 1; // null terminator for each DLL
        }
        return -1;
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

    generate(codeBytes, dataBytes) {
        let DOS_HEADER_SIZE = 64;
        let PE_SIG_SIZE = 4;
        let COFF_HEADER_SIZE = 20;
        let OPTIONAL_HEADER_SIZE = 112 + 16 * 8;
        let SECTION_HEADER_SIZE = 40;

        // 是否有导入表
        let hasImports = this.imports.length > 0;
        let NUM_SECTIONS = hasImports ? 3 : 2;

        let peHeaderOffset = DOS_HEADER_SIZE;
        let optionalHeaderOffset = peHeaderOffset + PE_SIG_SIZE + COFF_HEADER_SIZE;
        let sectionHeadersOffset = optionalHeaderOffset + OPTIONAL_HEADER_SIZE;
        let headersSize = sectionHeadersOffset + NUM_SECTIONS * SECTION_HEADER_SIZE;

        let fileAlignment = 512; // 0x200
        let sectionAlignment = 4096; // 0x1000

        let textRawOffset = Math.ceil(headersSize / fileAlignment) * fileAlignment;
        let textRVA = sectionAlignment;
        let textSize = codeBytes.length;
        let textRawSize = Math.ceil(textSize / fileAlignment) * fileAlignment;
        let textVirtualSize = Math.ceil(textSize / sectionAlignment) * sectionAlignment;

        let dataRawOffset = textRawOffset + textRawSize;
        let dataRVA = textRVA + textVirtualSize;
        let dataSize = dataBytes.length;
        let dataRawSize = dataSize > 0 ? Math.ceil(dataSize / fileAlignment) * fileAlignment : 0;
        let dataVirtualSize = dataSize > 0 ? Math.ceil(dataSize / sectionAlignment) * sectionAlignment : sectionAlignment;

        // .idata section (Import Directory)
        let idataRVA = 0;
        let idataSize = 0;
        let idataRawOffset = 0;
        let idataRawSize = 0;
        let idataVirtualSize = 0;
        let importDirRVA = 0;
        let importDirSize = 0;
        let idataBytes = [];

        if (hasImports) {
            idataRVA = dataRVA + dataVirtualSize;
            this.iatRVA = idataRVA;

            // 构建导入表数据
            // 导入表结构:
            // 1. Import Directory Table (20 bytes per DLL + 20 bytes null terminator)
            // 2. Import Lookup Table / Import Address Table (8 bytes per function + 8 bytes null terminator per DLL)
            // 3. Hint/Name Table (2 bytes hint + name string + null)
            // 4. DLL Name strings

            let numDlls = this.imports.length;
            let totalFunctions = 0;
            for (let i = 0; i < this.imports.length; i = i + 1) {
                totalFunctions = totalFunctions + this.imports[i].functions.length;
            }

            // Import Directory Table 大小: (numDlls + 1) * 20
            let idtSize = (numDlls + 1) * 20;

            // IAT 大小: (totalFunctions + numDlls) * 8 (每个 DLL 有一个 null terminator)
            let iatSize = (totalFunctions + numDlls) * 8;

            // ILT 大小同 IAT
            let iltSize = iatSize;

            // 计算各部分在 .idata 内的偏移
            let idtOffset = 0;
            let iatOffset = idtSize;
            let iltOffset = iatOffset + iatSize;
            let hintNameOffset = iltOffset + iltSize;

            // 先计算 Hint/Name 和 DLL names 的大小
            let hintNames = [];
            let dllNames = [];
            let hintNameTotalSize = 0;

            for (let i = 0; i < this.imports.length; i = i + 1) {
                let entry = this.imports[i];
                dllNames.push(entry.dll);
                for (let j = 0; j < entry.functions.length; j = j + 1) {
                    let func = entry.functions[j];
                    hintNames.push({ name: func, offset: hintNameTotalSize });
                    // 2 bytes hint + name + null + padding to even
                    let entrySize = 2 + func.length + 1;
                    if (entrySize % 2 !== 0) {
                        entrySize = entrySize + 1;
                    }
                    hintNameTotalSize = hintNameTotalSize + entrySize;
                }
            }

            let dllNameOffset = hintNameOffset + hintNameTotalSize;
            let dllNameOffsets = [];
            let dllNameTotalSize = 0;
            for (let i = 0; i < dllNames.length; i = i + 1) {
                dllNameOffsets.push(dllNameTotalSize);
                dllNameTotalSize = dllNameTotalSize + dllNames[i].length + 1;
            }

            idataSize = dllNameOffset + dllNameTotalSize;

            // 现在构建 .idata 字节
            let idata = [];

            // 辅助函数
            let pushByte = function (b) {
                idata.push(b & 255);
            };
            let push16 = function (v) {
                idata.push(v & 255);
                idata.push((v >> 8) & 255);
            };
            let push32 = function (v) {
                idata.push(v & 255);
                idata.push((v >> 8) & 255);
                idata.push((v >> 16) & 255);
                idata.push((v >> 24) & 255);
            };
            let push64 = function (v) {
                let low = v & 4294967295;
                let high = Math.floor(v / 4294967296) & 4294967295;
                push32(low);
                push32(high);
            };
            let pushString = function (s) {
                for (let i = 0; i < s.length; i = i + 1) {
                    idata.push(s.charCodeAt(i));
                }
                idata.push(0);
            };
            let padToLocal = function (offset) {
                while (idata.length < offset) {
                    idata.push(0);
                }
            };

            // 1. Import Directory Table
            let funcIndex = 0;
            for (let i = 0; i < this.imports.length; i = i + 1) {
                let entry = this.imports[i];
                // Import Lookup Table RVA
                push32(idataRVA + iltOffset + funcIndex * 8);
                // TimeDateStamp
                push32(0);
                // ForwarderChain
                push32(0);
                // Name RVA
                push32(idataRVA + dllNameOffset + dllNameOffsets[i]);
                // Import Address Table RVA
                push32(idataRVA + iatOffset + funcIndex * 8);

                funcIndex = funcIndex + entry.functions.length + 1; // +1 for null terminator
            }
            // Null terminator entry
            for (let i = 0; i < 5; i = i + 1) {
                push32(0);
            }

            // 2. IAT (Import Address Table)
            let hintIndex = 0;
            let hintNameCursor = 0;
            for (let i = 0; i < this.imports.length; i = i + 1) {
                let entry = this.imports[i];
                for (let j = 0; j < entry.functions.length; j = j + 1) {
                    let func = entry.functions[j];
                    // Point to Hint/Name entry
                    push64(idataRVA + hintNameOffset + hintNameCursor);
                    // 计算此 hint/name entry 的大小
                    let entrySize = 2 + func.length + 1;
                    if (entrySize % 2 !== 0) {
                        entrySize = entrySize + 1;
                    }
                    hintNameCursor = hintNameCursor + entrySize;
                }
                // Null terminator for this DLL
                push64(0);
            }

            // 3. ILT (Import Lookup Table) - 与 IAT 相同内容
            hintNameCursor = 0;
            for (let i = 0; i < this.imports.length; i = i + 1) {
                let entry = this.imports[i];
                for (let j = 0; j < entry.functions.length; j = j + 1) {
                    let func = entry.functions[j];
                    push64(idataRVA + hintNameOffset + hintNameCursor);
                    let entrySize = 2 + func.length + 1;
                    if (entrySize % 2 !== 0) {
                        entrySize = entrySize + 1;
                    }
                    hintNameCursor = hintNameCursor + entrySize;
                }
                push64(0);
            }

            // 4. Hint/Name Table
            for (let i = 0; i < this.imports.length; i = i + 1) {
                let entry = this.imports[i];
                for (let j = 0; j < entry.functions.length; j = j + 1) {
                    let func = entry.functions[j];
                    push16(0); // Hint (0)
                    pushString(func);
                    // Pad to even boundary
                    if (idata.length % 2 !== 0) {
                        pushByte(0);
                    }
                }
            }

            // 5. DLL Name strings
            for (let i = 0; i < dllNames.length; i = i + 1) {
                pushString(dllNames[i]);
            }

            idataBytes = idata;
            idataSize = idata.length;
            idataRawSize = Math.ceil(idataSize / fileAlignment) * fileAlignment;
            idataVirtualSize = Math.ceil(idataSize / sectionAlignment) * sectionAlignment;
            idataRawOffset = dataRawOffset + dataRawSize;

            importDirRVA = idataRVA;
            importDirSize = (numDlls + 1) * 20;
        }

        let imageSize = hasImports ? idataRVA + idataVirtualSize : dataRVA + dataVirtualSize;
        let entryPointRVA = textRVA;

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
        this.write32(0);
        this.write32(0);
        this.write32(0);
        this.write16(OPTIONAL_HEADER_SIZE);
        this.write16(IMAGE_FILE_EXECUTABLE_IMAGE | IMAGE_FILE_LARGE_ADDRESS_AWARE);

        // Optional Header (PE32+)
        this.write16(523); // 0x20B PE32+
        this.write(14);
        this.write(0);
        this.write32(textSize);
        this.write32(dataSize);
        this.write32(0);
        this.write32(entryPointRVA);
        this.write32(textRVA);

        this.write64(this.baseAddr);
        this.write32(sectionAlignment);
        this.write32(fileAlignment);
        this.write16(6);
        this.write16(0);
        this.write16(0);
        this.write16(0);
        this.write16(6);
        this.write16(0);
        this.write32(0);
        this.write32(imageSize);
        this.write32(textRawOffset);
        this.write32(0);
        this.write16(IMAGE_SUBSYSTEM_CONSOLE);
        this.write16(0);
        this.write64(1048576); // 0x100000
        this.write64(4096);
        this.write64(1048576);
        this.write64(4096);
        this.write32(0);
        this.write32(16);

        // Data directories (16 entries)
        // 0: Export Table
        this.write32(0);
        this.write32(0);
        // 1: Import Table
        this.write32(importDirRVA);
        this.write32(importDirSize);
        // 2-11: Other directories (zeros)
        for (let i = 2; i < 12; i = i + 1) {
            this.write32(0);
            this.write32(0);
        }
        // 12: IAT (Import Address Table)
        if (hasImports) {
            let iatOffset = (this.imports.length + 1) * 20;
            let totalSlots = 0;
            for (let i = 0; i < this.imports.length; i = i + 1) {
                totalSlots = totalSlots + this.imports[i].functions.length + 1;
            }
            this.write32(idataRVA + iatOffset);
            this.write32(totalSlots * 8);
        } else {
            this.write32(0);
            this.write32(0);
        }
        // 13-15: Remaining directories (zeros)
        for (let i = 13; i < 16; i = i + 1) {
            this.write32(0);
            this.write32(0);
        }

        // .text section
        this.writeString(".text", 8);
        this.write32(textSize);
        this.write32(textRVA);
        this.write32(textRawSize);
        this.write32(textRawOffset);
        this.write32(0);
        this.write32(0);
        this.write16(0);
        this.write16(0);
        this.write32(IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE | IMAGE_SCN_MEM_READ);

        // .data section
        this.writeString(".data", 8);
        this.write32(dataSize);
        this.write32(dataRVA);
        this.write32(dataRawSize);
        this.write32(dataRawOffset);
        this.write32(0);
        this.write32(0);
        this.write16(0);
        this.write16(0);
        this.write32(IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE);

        // .idata section (if imports exist)
        if (hasImports) {
            this.writeString(".idata", 8);
            this.write32(idataSize);
            this.write32(idataRVA);
            this.write32(idataRawSize);
            this.write32(idataRawOffset);
            this.write32(0);
            this.write32(0);
            this.write16(0);
            this.write16(0);
            this.write32(IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE);
        }

        // 处理 IAT 重定位
        // 需要先计算 IAT 内各函数的 RVA
        if (hasImports && this.iatRelocations.length > 0) {
            // IAT 位于 idtOffset 之后
            let idtSize = (this.imports.length + 1) * 20;
            let iatStartRVA = idataRVA + idtSize;

            for (let reloc of this.iatRelocations) {
                // 计算 IAT 槽的 RVA
                let slotRVA = iatStartRVA + reloc.slotIndex * 8;
                // 计算 RIP 相对偏移
                // call [rip+disp32] 中，rip 指向 call 指令的下一条指令
                // 代码在 textRVA 处
                let ripAfterCall = textRVA + reloc.offset + 4;
                let disp32 = slotRVA - ripAfterCall;

                // 写入偏移到 codeBytes
                codeBytes[reloc.offset] = disp32 & 0xff;
                codeBytes[reloc.offset + 1] = (disp32 >> 8) & 0xff;
                codeBytes[reloc.offset + 2] = (disp32 >> 16) & 0xff;
                codeBytes[reloc.offset + 3] = (disp32 >> 24) & 0xff;
            }
        }

        // 填充到代码段
        this.padTo(textRawOffset);
        this.writeBytes(codeBytes);

        // 填充到数据段
        if (dataSize > 0) {
            this.padTo(dataRawOffset);
            this.writeBytes(dataBytes);
        }

        // 填充到导入表段
        if (hasImports) {
            this.padTo(idataRawOffset);
            this.writeBytes(idataBytes);
        }

        return this.buffer;
    }

    // 获取 IAT 在运行时的虚拟地址
    getIATVAddr() {
        if (this.iatRVA === 0) {
            return 0;
        }
        // IAT 在 .idata 段开头 + Import Directory Table 之后
        let idtSize = (this.imports.length + 1) * 20;
        return this.baseAddr + this.iatRVA + idtSize;
    }

    getCodeVAddr() {
        return this.baseAddr + 4096;
    }

    getDataVAddr(codeSize) {
        let textVirtualSize = Math.ceil(codeSize / 4096) * 4096;
        return this.baseAddr + 4096 + textVirtualSize;
    }

    // 获取 IAT 槽的 RVA
    // slotIndex: IAT 槽索引 (0=VirtualAlloc, 1=GetStdHandle, 2=WriteConsoleA, 3=ExitProcess)
    getIATSlotRVA(slotIndex) {
        // IAT 位于 .idata section
        // 需要先计算 .idata 的 RVA
        // 这需要知道 .text 和 .data section 的大小
        // 但在调用时我们还不知道...
        //
        // 使用固定的布局：假设在生成时设置
        // 或者返回相对于 IAT 基址的偏移
        //
        // IAT 结构: 每个槽 8 字节
        return this.iatRVA + slotIndex * 8;
    }
}
