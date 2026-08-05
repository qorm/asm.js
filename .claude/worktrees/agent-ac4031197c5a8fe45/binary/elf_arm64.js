// ELF 64位可执行文件生成器 (Linux ARM64)
// 所有数值使用十进制

// ELF 常量
const ELF_MAGIC = [127, 69, 76, 70]; // \x7FELF
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EV_CURRENT = 1;
const ELFOSABI_SYSV = 0;
const ET_EXEC = 2;
const EM_AARCH64 = 183; // ARM64 架构

// 段类型
const PT_LOAD = 1;

// 段权限
const PF_X = 1;
const PF_W = 2;
const PF_R = 4;

export class ELF64ARM64Generator {
    constructor() {
        this.buffer = [];
        this.entryPoint = 0;
        this.baseAddr = 4194304; // 0x400000
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

    padTo(offset) {
        while (this.buffer.length < offset) {
            this.write(0);
        }
    }

    generate(codeBytes, dataBytes) {
        const ELF_HEADER_SIZE = 64;
        const PROG_HEADER_SIZE = 56;
        const NUM_PROG_HEADERS = 2;

        let progHeadersOffset = ELF_HEADER_SIZE;

        // 代码从 4096 (0x1000) 开始，ARM64 使用 4K 页
        let codeFileOffset = 4096;
        let codeVAddr = this.baseAddr + codeFileOffset;
        let codeSize = codeBytes.length;

        // 数据段页对齐
        let dataFileOffset = codeFileOffset + Math.ceil(codeSize / 4096) * 4096;
        let dataVAddr = this.baseAddr + dataFileOffset;
        let dataSize = dataBytes.length;

        this.entryPoint = codeVAddr;

        // ELF Header
        this.writeBytes(ELF_MAGIC);
        this.write(ELFCLASS64); // EI_CLASS: 64-bit
        this.write(ELFDATA2LSB); // EI_DATA: Little endian
        this.write(EV_CURRENT); // EI_VERSION
        this.write(ELFOSABI_SYSV); // EI_OSABI
        for (let i = 0; i < 8; i = i + 1) {
            this.write(0); // EI_PAD
        }

        this.write16(ET_EXEC); // e_type: Executable
        this.write16(EM_AARCH64); // e_machine: ARM64
        this.write32(EV_CURRENT); // e_version
        this.write64(this.entryPoint); // e_entry
        this.write64(progHeadersOffset); // e_phoff
        this.write64(0); // e_shoff: No section headers
        this.write32(0); // e_flags
        this.write16(ELF_HEADER_SIZE); // e_ehsize
        this.write16(PROG_HEADER_SIZE); // e_phentsize
        this.write16(NUM_PROG_HEADERS); // e_phnum
        this.write16(0); // e_shentsize
        this.write16(0); // e_shnum
        this.write16(0); // e_shstrndx

        // Program Header 1: Code segment (R+X)
        this.write32(PT_LOAD); // p_type
        this.write32(PF_R | PF_X); // p_flags
        this.write64(codeFileOffset); // p_offset
        this.write64(codeVAddr); // p_vaddr
        this.write64(codeVAddr); // p_paddr
        this.write64(codeSize); // p_filesz
        this.write64(codeSize); // p_memsz
        this.write64(4096); // p_align

        // Program Header 2: Data segment (R+W)
        this.write32(PT_LOAD); // p_type
        this.write32(PF_R | PF_W); // p_flags
        this.write64(dataFileOffset); // p_offset
        this.write64(dataVAddr); // p_vaddr
        this.write64(dataVAddr); // p_paddr
        this.write64(dataSize); // p_filesz
        this.write64(dataSize + 65536); // p_memsz (extra for BSS/heap)
        this.write64(4096); // p_align

        // 填充到代码段开始
        this.padTo(codeFileOffset);

        // 写入代码
        this.writeBytes(codeBytes);

        // 填充到数据段开始
        this.padTo(dataFileOffset);

        // 写入数据
        this.writeBytes(dataBytes);

        return this.buffer;
    }

    getEntryPoint() {
        return this.entryPoint;
    }

    getCodeVAddr() {
        return this.baseAddr + 4096;
    }

    getDataVAddr(codeSize) {
        // 数据段从代码段之后的下一个页对齐位置开始
        let codeFileOffset = 4096;
        let dataFileOffset = codeFileOffset + Math.ceil(codeSize / 4096) * 4096;
        return this.baseAddr + dataFileOffset;
    }
}
