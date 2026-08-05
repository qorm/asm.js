// 静态库链接器
// 将静态库 (.a) 中的代码直接合并到可执行文件中

import * as fs from "fs";

// 把字节数组 [start,end) 转成字符串。原用 arBytesToStr(data, a,b) 展开传参，
// 但自举编译器暂不支持 fromCharCode 的 spread 实参（gen1 里被静默丢弃）→ 改逐字节拼接。
function arBytesToStr(data, start, end) {
    let s = "";
    for (let i = start; i < end; i++) s += String.fromCharCode(data[i]);
    return s;
}

// Mach-O 常量
const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x02;

// Mach-O 符号类型
const N_EXT = 0x01;
const N_SECT = 0x0e;
const N_UNDF = 0x00;

// ELF 常量
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7FELF
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;

// ELF Section 类型
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_NOBITS = 8;

// ELF Section 标志
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

// ELF 符号绑定
const STB_LOCAL = 0;
const STB_GLOBAL = 1;

// ELF 符号类型
const STT_NOTYPE = 0;
const STT_OBJECT = 1;
const STT_FUNC = 2;
const STT_SECTION = 3;

// ELF 符号可见性
const SHN_UNDEF = 0;

export class StaticLinker {
    constructor() {
        this.libraries = []; // 加载的静态库
    }

    // 加载静态库
    loadLibrary(libPath) {
        const data = fs.readFileSync(libPath);
        const members = this.parseArArchive(data);

        for (const member of members) {
            if (member.name.endsWith(".o") || member.name.indexOf(".o") >= 0) {
                // 检测目标文件格式
                const objInfo = this.parseObjectFile(member.data);
                if (objInfo) {
                    objInfo.sourcePath = libPath;
                    this.libraries.push(objInfo);
                }
            }
        }
    }

    // 解析目标文件（自动检测 Mach-O、ELF 或 COFF）
    parseObjectFile(data) {
        if (data.length < 4) return null;

        // 检查 ELF 魔数
        if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) {
            return this.parseELFObject(data);
        }

        // 检查 Mach-O 魔数
        const magic = this.read32(data, 0);
        if (magic === MH_MAGIC_64) {
            return this.parseMachOObject(data);
        }

        // 检查 COFF 魔数 (AMD64)
        const machine = this.read16(data, 0);
        if (machine === 0x8664) {
            // IMAGE_FILE_MACHINE_AMD64
            return this.parseCOFFObject(data);
        }

        return null;
    }

    // 解析 ar 格式（支持 BSD 和 GNU 格式）
    parseArArchive(data) {
        const members = [];

        // 检查 ar 魔数
        const magic = arBytesToStr(data, 0, 8);
        if (magic !== "!<arch>\n") {
            return members;
        }

        // 检查是否有扩展字符串表 (GNU ar 长文件名)
        let longNames = null;

        let offset = 8;
        while (offset < data.length) {
            // ar header 是 60 字节
            if (offset + 60 > data.length) break;

            let name = arBytesToStr(data, offset, offset + 16).trim();
            const sizeStr = arBytesToStr(data, offset + 48, offset + 58).trim();
            let size = parseInt(sizeStr, 10);

            offset += 60;

            if (isNaN(size) || size <= 0) break;

            // BSD 扩展格式: #1/N 表示文件名长度为 N，紧跟在 header 后面
            let nameLen = 0;
            if (name.startsWith("#1/")) {
                nameLen = parseInt(name.substring(3), 10);
                // 读取实际文件名
                // 去 NUL 填充:用 split/join(不用正则字面量——编译器源码刻意保持
                // 无正则,避免触发 __regexp_shim 注入进自举,见 compiler/index.js)
                name = arBytesToStr(data, offset, offset + nameLen)
                    .split("\0").join("")
                    .trim();
                // 实际内容大小 = size - nameLen
                size = size - nameLen;
                offset += nameLen;
            }
            // GNU ar 格式: // 是扩展字符串表
            else if (name === "//") {
                longNames = arBytesToStr(data, offset, offset + size);
                offset += size;
                if (offset % 2 !== 0) offset++;
                continue;
            }
            // GNU ar 格式: /N 表示从扩展字符串表偏移 N 处读取文件名
            else if (name.startsWith("/") && name !== "/") {
                if (longNames) {
                    const nameOffset = parseInt(name.substring(1), 10);
                    // 从 longNames 中读取直到 / 或 \n
                    let endIdx = nameOffset;
                    while (endIdx < longNames.length && longNames[endIdx] !== "/" && longNames[endIdx] !== "\n") {
                        endIdx++;
                    }
                    name = longNames.substring(nameOffset, endIdx).trim();
                }
            }
            // GNU ar 格式: 文件名以 / 结尾
            else if (name.endsWith("/")) {
                name = name.slice(0, -1);
            }

            // 跳过符号表 (__.SYMDEF / 或 空)
            if (!name.startsWith("__.SYMDEF") && name !== "/" && name.length > 0) {
                const memberData = data.slice(offset, offset + size);
                members.push({ name, data: memberData });
            }

            offset += size;
            // 2 字节对齐
            if (offset % 2 !== 0) offset++;
        }

        return members;
    }

    // 解析 Mach-O 目标文件
    parseMachOObject(data) {
        if (data.length < 32) return null;

        const magic = this.read32(data, 0);
        if (magic !== MH_MAGIC_64) return null;

        const ncmds = this.read32(data, 16);
        const sizeofcmds = this.read32(data, 20);

        let offset = 32; // Mach-O header 大小

        let textOffset = 0,
            textSize = 0;
        let dataOffset = 0,
            dataSize = 0;
        let symtabOffset = 0,
            nsyms = 0;
        let strtabOffset = 0,
            strtabSize = 0;

        // 解析 load commands
        for (let i = 0; i < ncmds; i++) {
            const cmd = this.read32(data, offset);
            const cmdsize = this.read32(data, offset + 4);

            if (cmd === LC_SEGMENT_64) {
                const nsects = this.read32(data, offset + 64);
                let sectOffset = offset + 72;

                for (let j = 0; j < nsects; j++) {
                    const sectname = this.readString(data, sectOffset, 16);
                    const size = Number(this.read64(data, sectOffset + 40));
                    const fileoff = this.read32(data, sectOffset + 48);

                    if (sectname === "__text") {
                        textOffset = fileoff;
                        textSize = size;
                    } else if (sectname === "__data") {
                        dataOffset = fileoff;
                        dataSize = size;
                    }

                    sectOffset += 80;
                }
            } else if (cmd === LC_SYMTAB) {
                symtabOffset = this.read32(data, offset + 8);
                nsyms = this.read32(data, offset + 12);
                strtabOffset = this.read32(data, offset + 16);
                strtabSize = this.read32(data, offset + 20);
            }

            offset += cmdsize;
        }

        // 提取代码和数据
        const code = data.slice(textOffset, textOffset + textSize);
        const objData = dataSize > 0 ? data.slice(dataOffset, dataOffset + dataSize) : new Uint8Array(0);

        // 解析符号表
        const symbols = {};
        const strtab = data.slice(strtabOffset, strtabOffset + strtabSize);

        for (let i = 0; i < nsyms; i++) {
            const symOffset = symtabOffset + i * 16;
            const strx = this.read32(data, symOffset);
            const type = data[symOffset + 4];
            const sect = data[symOffset + 5];
            const value = Number(this.read64(data, symOffset + 8));

            // 读取符号名
            let name = "";
            for (let j = strx; j < strtab.length && strtab[j] !== 0; j++) {
                name += String.fromCharCode(strtab[j]);
            }

            if (name && type & N_SECT) {
                symbols[name] = {
                    value: value,
                    section: sect,
                    external: (type & N_EXT) !== 0,
                };
            }
        }

        return {
            code: code,
            data: objData,
            symbols: symbols,
            textSize: textSize,
            dataSize: dataSize,
        };
    }

    // 解析 ELF 64位目标文件 (Linux)
    parseELFObject(data) {
        if (data.length < 64) return null;

        // 验证 ELF 魔数
        if (data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) {
            return null;
        }

        // 验证是 64 位
        if (data[4] !== ELFCLASS64) return null;

        // 验证小端序
        if (data[5] !== ELFDATA2LSB) return null;

        // ELF header 字段
        // e_shoff: section header table offset (64 位偏移在 offset 40)
        const e_shoff = Number(this.read64(data, 40));
        // e_shentsize: section header entry size (offset 58)
        const e_shentsize = this.read16(data, 58);
        // e_shnum: number of section headers (offset 60)
        const e_shnum = this.read16(data, 60);
        // e_shstrndx: section name string table index (offset 62)
        const e_shstrndx = this.read16(data, 62);

        if (e_shoff === 0 || e_shnum === 0) return null;

        // 读取所有 section headers
        const sections = [];
        for (let i = 0; i < e_shnum; i++) {
            const shOffset = e_shoff + i * e_shentsize;
            sections.push({
                sh_name: this.read32(data, shOffset), // 名称在字符串表中的偏移
                sh_type: this.read32(data, shOffset + 4), // 类型
                sh_flags: Number(this.read64(data, shOffset + 8)), // 标志
                sh_addr: Number(this.read64(data, shOffset + 16)), // 虚拟地址
                sh_offset: Number(this.read64(data, shOffset + 24)), // 文件偏移
                sh_size: Number(this.read64(data, shOffset + 32)), // 大小
                sh_link: this.read32(data, shOffset + 40), // 关联 section
                sh_info: this.read32(data, shOffset + 44), // 额外信息
                sh_addralign: Number(this.read64(data, shOffset + 48)), // 对齐
                sh_entsize: Number(this.read64(data, shOffset + 56)), // 条目大小
            });
        }

        // 获取 section 名称字符串表
        const shstrtab = sections[e_shstrndx];
        const shstrtabData = data.slice(shstrtab.sh_offset, shstrtab.sh_offset + shstrtab.sh_size);

        // 为每个 section 设置名称
        for (const sect of sections) {
            sect.name = this.readStringFromTab(shstrtabData, sect.sh_name);
        }

        // 调试：打印所有 sections

        // 查找 .text, .data, .symtab, .strtab
        let textSection = null;
        let dataSection = null;
        let symtabSection = null;
        let strtabSection = null;

        // 记录所有代码 section 的索引（从 1 开始，0 是 NULL）
        let textSectionIdx = 0;
        let dataSectionIdx = 0;

        for (let i = 0; i < sections.length; i++) {
            const sect = sections[i];
            if (sect.name === ".text") {
                textSection = sect;
                textSectionIdx = i;
            } else if (sect.name === ".data") {
                dataSection = sect;
                dataSectionIdx = i;
            } else if (sect.sh_type === SHT_SYMTAB) {
                symtabSection = sect;
            } else if (sect.name === ".strtab") {
                strtabSection = sect;
            }
        }

        // 提取代码
        let code = new Uint8Array(0);
        let textSize = 0;
        if (textSection) {
            code = data.slice(textSection.sh_offset, textSection.sh_offset + textSection.sh_size);
            textSize = textSection.sh_size;
        }

        // 提取数据
        let objData = new Uint8Array(0);
        let dataSize = 0;
        if (dataSection && dataSection.sh_size > 0) {
            objData = data.slice(dataSection.sh_offset, dataSection.sh_offset + dataSection.sh_size);
            dataSize = dataSection.sh_size;
        }

        // 解析符号表
        const symbols = {};

        if (symtabSection) {
            // 符号表的字符串表索引在 sh_link 中
            const symStrtabIdx = symtabSection.sh_link;
            const symStrtab = sections[symStrtabIdx];
            if (!symStrtab) {
                return { code, data: objData, symbols, textSize, dataSize };
            }

            const strtabData = data.slice(symStrtab.sh_offset, symStrtab.sh_offset + symStrtab.sh_size);
            const symEntrySize = 24; // ELF64 符号表条目大小
            const numSyms = Math.floor(symtabSection.sh_size / symEntrySize);

            // 调试：显示字符串表内容

            for (let i = 0; i < numSyms; i++) {
                const symOffset = symtabSection.sh_offset + i * symEntrySize;

                const st_name = this.read32(data, symOffset);
                const st_info = data[symOffset + 4];
                const st_other = data[symOffset + 5];
                const st_shndx = this.read16(data, symOffset + 6);
                const st_value = Number(this.read64(data, symOffset + 8));
                const st_size = Number(this.read64(data, symOffset + 16));

                // 提取符号类型和绑定
                const bind = st_info >> 4;
                const type = st_info & 0xf;

                // 读取符号名
                const name = this.readStringFromTab(strtabData, st_name);

                // 只处理已定义的符号（不是 SHN_UNDEF）
                if (name && st_shndx !== SHN_UNDEF && st_shndx < 0xff00) {
                    // 确定符号在哪个 section
                    // ELF 使用 section 索引来区分代码和数据
                    let section = 0;
                    if (st_shndx === textSectionIdx) {
                        section = 1; // 代码段（和 Mach-O 保持一致）
                    } else if (st_shndx === dataSectionIdx) {
                        section = 2; // 数据段
                    }

                    if (section > 0 || type === STT_FUNC || type === STT_OBJECT) {
                        symbols[name] = {
                            value: st_value,
                            section: section || (type === STT_FUNC ? 1 : 2),
                            external: bind === STB_GLOBAL,
                            type: type,
                        };
                    }
                }
            }
        }

        return {
            code: code,
            data: objData,
            symbols: symbols,
            textSize: textSize,
            dataSize: dataSize,
        };
    }

    // 从字符串表读取字符串
    readStringFromTab(strtab, offset) {
        if (offset >= strtab.length) return "";
        let str = "";
        for (let i = offset; i < strtab.length && strtab[i] !== 0; i++) {
            str += String.fromCharCode(strtab[i]);
        }
        return str;
    }

    // 查找符号
    findSymbol(name) {
        for (const lib of this.libraries) {
            if (lib.symbols[name]) {
                return { lib, symbol: lib.symbols[name] };
            }
        }
        return null;
    }

    // 获取所有需要链接的库代码
    getLinkedCode() {
        let totalCode = [];
        let totalData = [];
        let symbolOffsets = {};
        let codeOffset = 0;
        let dataOffset = 0;

        for (const lib of this.libraries) {
            // 记录符号的最终偏移
            for (const [name, sym] of Object.entries(lib.symbols)) {
                if (sym.section === 1) {
                    // __text
                    symbolOffsets[name] = codeOffset + sym.value;
                } else if (sym.section === 2) {
                    // __data
                    symbolOffsets[name] = dataOffset + sym.value;
                }
            }

            // 追加代码
            for (let i = 0; i < lib.code.length; i++) {
                totalCode.push(lib.code[i]);
            }
            codeOffset += lib.code.length;

            // 追加数据
            for (let i = 0; i < lib.data.length; i++) {
                totalData.push(lib.data[i]);
            }
            dataOffset += lib.data.length;
        }

        return {
            code: new Uint8Array(totalCode),
            data: new Uint8Array(totalData),
            symbols: symbolOffsets,
        };
    }

    read16(data, offset) {
        return (data[offset] | (data[offset + 1] << 8)) & 0xffff;
    }

    read32(data, offset) {
        return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
    }

    read64(data, offset) {
        const low = this.read32(data, offset);
        const high = this.read32(data, offset + 4);
        return BigInt(low) | (BigInt(high) << 32n);
    }

    readString(data, offset, maxLen) {
        let str = "";
        for (let i = 0; i < maxLen && data[offset + i] !== 0; i++) {
            str += String.fromCharCode(data[offset + i]);
        }
        return str;
    }

    // 解析 COFF 目标文件 (Windows)
    parseCOFFObject(data) {
        // COFF Header: 20 bytes
        const machine = this.read16(data, 0);
        const numberOfSections = this.read16(data, 2);
        const timeDateStamp = this.read32(data, 4);
        const pointerToSymbolTable = this.read32(data, 8);
        const numberOfSymbols = this.read32(data, 12);
        const sizeOfOptionalHeader = this.read16(data, 16);
        const characteristics = this.read16(data, 18);

        if (machine !== 0x8664) {
            // IMAGE_FILE_MACHINE_AMD64
            return null;
        }

        // 解析 Section Headers
        const sectionHeaders = [];
        let sectionHeaderOffset = 20 + sizeOfOptionalHeader;

        for (let i = 0; i < numberOfSections; i++) {
            const name = this.readString(data, sectionHeaderOffset, 8);
            const virtualSize = this.read32(data, sectionHeaderOffset + 8);
            const virtualAddress = this.read32(data, sectionHeaderOffset + 12);
            const sizeOfRawData = this.read32(data, sectionHeaderOffset + 16);
            const pointerToRawData = this.read32(data, sectionHeaderOffset + 20);
            const pointerToRelocations = this.read32(data, sectionHeaderOffset + 24);
            const pointerToLinenumbers = this.read32(data, sectionHeaderOffset + 28);
            const numberOfRelocations = this.read16(data, sectionHeaderOffset + 32);
            const numberOfLinenumbers = this.read16(data, sectionHeaderOffset + 34);
            const sectionCharacteristics = this.read32(data, sectionHeaderOffset + 36);

            sectionHeaders.push({
                name,
                virtualSize,
                virtualAddress,
                sizeOfRawData,
                pointerToRawData,
                pointerToRelocations,
                numberOfRelocations,
                characteristics: sectionCharacteristics,
            });

            sectionHeaderOffset += 40;
        }

        // 找到 .text 和 .data section
        let textSection = null;
        let dataSection = null;
        let textSectionIndex = 0;
        let dataSectionIndex = 0;

        for (let i = 0; i < sectionHeaders.length; i++) {
            const sh = sectionHeaders[i];
            if (sh.name === ".text" || sh.name.startsWith(".text")) {
                textSection = sh;
                textSectionIndex = i + 1; // 1-based
            } else if (sh.name === ".data" || sh.name.startsWith(".data")) {
                dataSection = sh;
                dataSectionIndex = i + 1;
            }
        }

        // 读取代码
        let code = new Uint8Array(0);
        if (textSection && textSection.sizeOfRawData > 0) {
            code = data.slice(textSection.pointerToRawData, textSection.pointerToRawData + textSection.sizeOfRawData);
        }

        // 读取数据
        let dataBytes = new Uint8Array(0);
        if (dataSection && dataSection.sizeOfRawData > 0) {
            dataBytes = data.slice(dataSection.pointerToRawData, dataSection.pointerToRawData + dataSection.sizeOfRawData);
        }

        // 解析字符串表（紧跟在符号表后面）
        const stringTableOffset = pointerToSymbolTable + numberOfSymbols * 18;
        const stringTableSize = this.read32(data, stringTableOffset);

        const getStringFromTable = (offset) => {
            if (offset < 4) return "";
            let str = "";
            let pos = stringTableOffset + offset;
            while (pos < data.length && data[pos] !== 0) {
                str += String.fromCharCode(data[pos]);
                pos++;
            }
            return str;
        };

        // 解析符号表
        const symbols = {};
        let symOffset = pointerToSymbolTable;

        for (let i = 0; i < numberOfSymbols; i++) {
            // 读取符号名
            let symName;
            const nameField1 = this.read32(data, symOffset);
            const nameField2 = this.read32(data, symOffset + 4);

            if (nameField1 === 0) {
                // 长名：nameField2 是字符串表偏移
                symName = getStringFromTable(nameField2);
            } else {
                // 短名：直接读取 8 字节
                symName = this.readString(data, symOffset, 8);
            }

            const value = this.read32(data, symOffset + 8);
            const sectionNumber = this.read16(data, symOffset + 12);
            const type = this.read16(data, symOffset + 14);
            const storageClass = data[symOffset + 16];
            const numberOfAuxSymbols = data[symOffset + 17];

            // 只处理全局符号 (IMAGE_SYM_CLASS_EXTERNAL = 2)
            if (storageClass === 2 && sectionNumber > 0) {
                // 确定是在哪个 section
                let section = 0;
                if (sectionNumber === textSectionIndex) {
                    section = 1; // .text
                } else if (sectionNumber === dataSectionIndex) {
                    section = 2; // .data
                }

                if (section > 0) {
                    symbols[symName] = {
                        value: value,
                        section: section,
                        type: type,
                    };
                }
            }

            symOffset += 18;
            // 跳过辅助符号
            symOffset += numberOfAuxSymbols * 18;
            i += numberOfAuxSymbols;
        }

        return {
            format: "coff",
            code: code,
            data: dataBytes,
            symbols: symbols,
            textRelocations: [], // TODO: 解析重定位
            dataRelocations: [],
        };
    }
}
