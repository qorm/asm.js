// ELF 64位可执行文件生成器 (Linux)
// 所有数值使用十进制

// ELF 常量
let ELF_MAGIC = [127, 69, 76, 70]; // \x7FELF
let ELFCLASS64 = 2;
let ELFDATA2LSB = 1;
let EV_CURRENT = 1;
let ELFOSABI_SYSV = 0;
let ET_EXEC = 2;
let EM_X86_64 = 62;

// 段类型
let PT_LOAD = 1;

// 段权限
let PF_X = 1;
let PF_W = 2;
let PF_R = 4;

export class ELF64Generator {
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
        let ELF_HEADER_SIZE = 64;
        let PROG_HEADER_SIZE = 56;
        let NUM_PROG_HEADERS = 2;

        let progHeadersOffset = ELF_HEADER_SIZE;

        // 代码从 4096 (0x1000) 开始
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
        this.write(ELFCLASS64);
        this.write(ELFDATA2LSB);
        this.write(EV_CURRENT);
        this.write(ELFOSABI_SYSV);
        for (let i = 0; i < 8; i = i + 1) {
            this.write(0);
        }

        this.write16(ET_EXEC);
        this.write16(EM_X86_64);
        this.write32(EV_CURRENT);
        this.write64(this.entryPoint);
        this.write64(progHeadersOffset);
        this.write64(0);
        this.write32(0);
        this.write16(ELF_HEADER_SIZE);
        this.write16(PROG_HEADER_SIZE);
        this.write16(NUM_PROG_HEADERS);
        this.write16(64);
        this.write16(0);
        this.write16(0);

        // Program Header: Code (RX)
        // 首个 PT_LOAD 从 file offset 0 起覆盖 ELF 头+程序头+代码：
        // Rosetta 2 的 Linux ElfMapper 断言 first load segment 必须在
        // file offset 0（ElfMapper.cpp "segment_file_offset == 0"），
        // 原生内核虽接受 offset=4096 的旧布局，但 Docker Desktop (Apple
        // Silicon) 跑 linux/amd64 全走 Rosetta。代码物理偏移与 vaddr
        // 不变（仍在 base+0x1000），仅段起点前移一页，不影响指针下界。
        this.write32(PT_LOAD);
        this.write32(PF_R | PF_X);
        this.write64(0);
        this.write64(this.baseAddr);
        this.write64(this.baseAddr);
        this.write64(codeFileOffset + codeSize);
        this.write64(codeFileOffset + codeSize);
        this.write64(4096);

        // Program Header: Data (RW)
        if (dataSize > 0) {
            this.write32(PT_LOAD);
            this.write32(PF_R | PF_W);
            this.write64(dataFileOffset);
            this.write64(dataVAddr);
            this.write64(dataVAddr);
            this.write64(dataSize);
            this.write64(dataSize);
            this.write64(4096);
        } else {
            for (let i = 0; i < PROG_HEADER_SIZE; i = i + 1) {
                this.write(0);
            }
        }

        // 填充到代码段
        this.padTo(codeFileOffset);
        this.writeBytes(codeBytes);

        // 填充到数据段
        if (dataSize > 0) {
            this.padTo(dataFileOffset);
            this.writeBytes(dataBytes);
        }

        return this.buffer;
    }

    getCodeVAddr() {
        return this.baseAddr + 4096;
    }

    getDataVAddr(codeSize) {
        let dataFileOffset = 4096 + Math.ceil(codeSize / 4096) * 4096;
        return this.baseAddr + dataFileOffset;
    }
}
