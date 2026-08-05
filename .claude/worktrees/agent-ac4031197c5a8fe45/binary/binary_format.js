// 二进制格式生成器基类
// ELF、Mach-O、PE 格式生成器共用的代码

// 输出类型
export const OutputType = {
    EXECUTABLE: "executable",
    SHARED: "shared",
    OBJECT: "object",
};

// 二进制格式生成器基类
export class BinaryGenerator {
    constructor() {
        this.buffer = [];
        this.baseAddr = 0;
        this.pageSize = 4096;
        this.outputType = OutputType.EXECUTABLE;
        this.exportedSymbols = [];
        this.importedSymbols = [];
        this.importedLibraries = [];
    }

    // 设置输出类型
    setOutputType(type) {
        this.outputType = type;
    }

    // 添加导出符号
    addExportedSymbol(name, offset) {
        this.exportedSymbols.push({ name: name, offset: offset });
    }

    // 添加导入符号
    addImportedSymbol(name, library) {
        this.importedSymbols.push({ name: name, library: library });
    }

    // 添加导入库
    addImportedLibrary(name, path) {
        this.importedLibraries.push({ name: name, path: path });
    }

    // === 基础写入方法 ===

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

    write16BE(value) {
        this.write((value >> 8) & 255);
        this.write(value & 255);
    }

    write32(value) {
        this.write(value & 255);
        this.write((value >> 8) & 255);
        this.write((value >> 16) & 255);
        this.write((value >> 24) & 255);
    }

    write32BE(value) {
        this.write((value >> 24) & 255);
        this.write((value >> 16) & 255);
        this.write((value >> 8) & 255);
        this.write(value & 255);
    }

    write64(value) {
        let low = value & 4294967295;
        let high = Math.floor(value / 4294967296) & 4294967295;
        this.write32(low);
        this.write32(high);
    }

    write64BE(value) {
        let low = value & 4294967295;
        let high = Math.floor(value / 4294967296) & 4294967295;
        this.write32BE(high);
        this.write32BE(low);
    }

    // 写入定长字符串
    writeString(str, strLen) {
        for (let i = 0; i < strLen; i = i + 1) {
            if (i < str.length) {
                this.write(str.charCodeAt(i));
            } else {
                this.write(0);
            }
        }
    }

    // 写入 C 风格字符串 (null 结尾)
    writeCString(str) {
        for (let i = 0; i < str.length; i = i + 1) {
            this.write(str.charCodeAt(i));
        }
        this.write(0);
    }

    // 填充到指定偏移
    padTo(offset) {
        while (this.buffer.length < offset) {
            this.write(0);
        }
    }

    // 对齐到指定边界
    alignTo(align) {
        while (this.buffer.length % align !== 0) {
            this.write(0);
        }
    }

    // 获取当前缓冲区大小
    size() {
        return this.buffer.length;
    }

    // 获取生成的字节数组
    getBytes() {
        return new Uint8Array(this.buffer);
    }

    // === 子类需要实现的方法 ===

    // 获取代码段虚拟地址
    getCodeVAddr() {
        throw new Error("getCodeVAddr must be implemented by subclass");
    }

    // 获取数据段虚拟地址
    getDataVAddr(codeSize) {
        throw new Error("getDataVAddr must be implemented by subclass");
    }

    // 生成二进制文件
    generate(codeBytes, dataBytes) {
        throw new Error("generate must be implemented by subclass");
    }
}

// 页对齐辅助函数
export function pageAlign(value, pageSize) {
    return Math.ceil(value / pageSize) * pageSize;
}

// 16 字节对齐
export function align16(value) {
    return Math.ceil(value / 16) * 16;
}

// 任意对齐
export function align(value, boundary) {
    return Math.ceil(value / boundary) * boundary;
}
