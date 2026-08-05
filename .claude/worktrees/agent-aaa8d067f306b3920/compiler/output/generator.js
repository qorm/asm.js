// asm.js 编译器 - 二进制生成器模块
// 根据目标平台生成可执行文件、共享库或目标文件

import * as path from "path";
import { ELF64Generator } from "../../binary/elf.js";
import { ELF64ARM64Generator } from "../../binary/elf_arm64.js";
import { ELF64DynamicGenerator } from "../../binary/elf_dynamic.js";
import { MachOARM64Generator } from "../../binary/macho_arm64.js";
import { MachOX64Generator } from "../../binary/macho_x64.js";
import { MachODylibGenerator } from "../../binary/macho_dylib.js";
import { MachOObjectGenerator } from "../../binary/macho_object.js";
import { ELFObjectGenerator } from "../../binary/elf_object.js";
import { COFFObjectGenerator } from "../../binary/coff_object.js";
import { PE64Generator } from "../../binary/pe.js";
import { PE64DllGenerator } from "../../binary/pe_dll.js";
import { WasmModuleGenerator, WASM_DATA_BASE } from "../../binary/wasm.js";

// 二进制生成器类
export class BinaryOutputGenerator {
    constructor(compiler) {
        this.compiler = compiler;
        this.asm = compiler.asm;
        this.arch = compiler.arch;
        this.os = compiler.os;
        this.ctx = compiler.ctx;
    }

    // 生成可执行文件
    generateExecutable() {
        if (this.os === "linux") {
            return this.generateLinuxExecutable();
        } else if (this.os === "macos") {
            return this.generateMacOSExecutable();
        } else if (this.os === "windows") {
            return this.generateWindowsExecutable();
        } else if (this.os === "wasi") {
            return this.generateWasmExecutable();
        }
        throw new Error("Unsupported target OS: " + this.os);
    }

    // 生成 WebAssembly 模块
    generateWasmExecutable() {
        const gen = new WasmModuleGenerator();
        this.asm.codeVAddr = 0;
        this.asm.dataVAddr = WASM_DATA_BASE;
        this.asm.fixupAll();
        return gen.generate(this.asm);
    }

    // 生成 Linux ELF 可执行文件
    generateLinuxExecutable() {
        const externalLibs = this.compiler.externalLibs || [];
        const needsDynamicLink = externalLibs.length > 0;

        if (needsDynamicLink) {
            const gen = new ELF64DynamicGenerator(this.arch);

            for (const lib of externalLibs) {
                gen.addNeededLib(lib.path);
                for (const sym of lib.symbols) {
                    gen.addImportedSymbol(sym);
                }
            }

            gen.calculateLayout(this.asm.code.length, this.asm.data.length);

            const codeVAddr = gen.getCodeVAddr();
            const dataVAddr = gen.getDataVAddr(this.asm.code.length);
            this.asm.codeVAddr = codeVAddr;
            this.asm.dataVAddr = dataVAddr;

            // 设置 PLT 入口地址
            for (const sym of gen.importedSymbols) {
                const pltAddr = gen.getPltEntryVAddr(sym);
                this.asm.labels.set("_" + sym, pltAddr);
            }

            this.asm.fixupAll();
            return gen.generate(this.asm.code, this.asm.data);
        } else {
            const gen = this.arch === "arm64" ? new ELF64ARM64Generator() : new ELF64Generator();
            const codeVAddr = gen.getCodeVAddr();
            const dataVAddr = gen.getDataVAddr(this.asm.code.length);
            this.asm.codeVAddr = codeVAddr;
            this.asm.dataVAddr = dataVAddr;
            this.asm.fixupAll();
        return gen.generate(this.asm.code, this.asm.data, this.asm.labels);
        }
    }

    // 生成 macOS Mach-O 可执行文件
    generateMacOSExecutable() {
        const gen = this.arch === "arm64" ? new MachOARM64Generator() : new MachOX64Generator();
        const registeredDylibs = this.compiler.registeredDylibs || [];

        for (const dylibPath of registeredDylibs) {
            gen.addDylib(dylibPath);
        }

        gen.setExternalSymbols(this.asm.externalSymbolList);

        // 设置 GOT 基地址偏移
        const dataSize = this.asm.data.length;
        const gotBaseOffset = Math.ceil(dataSize / 8) * 8;
        this.asm.setGotBaseOffset(gotBaseOffset);

        const codeVAddr = gen.getCodeVAddr();
        const dataVAddr = gen.getDataVAddr(this.asm.code.length);
        this.asm.codeVAddr = codeVAddr;
        this.asm.dataVAddr = dataVAddr;
        this.asm.fixupAll();
        return gen.generate(this.asm.code, this.asm.data, this.asm.labels);
    }

    // 生成 Windows PE 可执行文件
    generateWindowsExecutable() {
        const gen = new PE64Generator();

        // 添加标准 Windows API 导入
        gen.addImport("kernel32.dll", "VirtualAlloc");
        gen.addImport("kernel32.dll", "GetStdHandle");
        gen.addImport("kernel32.dll", "WriteConsoleA");
        gen.addImport("kernel32.dll", "ExitProcess");
        gen.addImport("kernel32.dll", "GetSystemTimeAsFileTime");
        // fs 面(槽 5-8,与 binary/pe.js WinAPI 索引一致)
        gen.addImport("kernel32.dll", "CreateFileA");
        gen.addImport("kernel32.dll", "ReadFile");
        gen.addImport("kernel32.dll", "WriteFile");
        gen.addImport("kernel32.dll", "CloseHandle");
        gen.addImport("kernel32.dll", "GetCommandLineA"); // 槽 9:process.argv

        // 添加外部 DLL 导入
        const externalLibs = this.compiler.externalLibs || [];
        for (const lib of externalLibs) {
            const dllName = path.basename(lib.path);
            for (const sym of lib.symbols) {
                gen.addImport(dllName, sym);
            }
        }

        const dataArray = this.asm.dataSection || this.asm.data || [];
        const codeVAddr = gen.getCodeVAddr();
        const dataVAddr = gen.getDataVAddr(this.asm.code.length);
        this.asm.codeVAddr = codeVAddr;
        this.asm.dataVAddr = dataVAddr;

        // 计算 IAT 基址。数据段大小必须用 fixupAll 物化**后**的最终值:字符串常量
        // 在 fixupAll 期间才 push 进 dataSection,此刻 dataArray 尚为空。用空长度会把
        // .idata/IAT 放进数据段中部,大二进制里 __imp_* IAT 引用落到字符串 → 执行崩溃。
        // estimateFinalDataSize() 精确预测最终 dataSection 长度(与 pe.js 实际放置一致)。
        const dataSize = this.asm.estimateFinalDataSize();
        const dataVirtualSize = dataSize > 0 ? Math.ceil(dataSize / 4096) * 4096 : 4096;
        const idataRVA = dataVAddr - gen.baseAddr + dataVirtualSize;

        // 用增量 .add 而非 new Set([...])——自举运行时 Set 的可迭代构造函数
        // 不填充初始元素(new Set(["x"]).size 返 0,全平台既有 bug),会让 numDlls
        // 少算 1 → idtSize 少 20 → 产物 IAT 引用整体偏 20 字节 → 崩溃。.add 计数正确。
        const dllSet = new Set();
        dllSet.add("kernel32.dll");
        for (const lib of externalLibs) {
            dllSet.add(path.basename(lib.path));
        }
        const numDlls = dllSet.size;
        const idtSize = (numDlls + 1) * 20;
        const iatBase = gen.baseAddr + idataRVA + idtSize;

        this.asm.fixupAll(codeVAddr, dataVAddr, iatBase);

        if (this.asm.iatRelocations) {
            gen.setIATRelocations(this.asm.iatRelocations);
        }

        return gen.generate(this.asm.code, dataArray);
    }

    // 生成共享库
    generateSharedLibrary() {
        if (this.os === "macos") {
            return this.generateMacOSDylib();
        } else if (this.os === "linux") {
            return this.generateLinuxSO();
        } else if (this.os === "windows") {
            return this.generateWindowsDLL();
        }
        throw new Error("Shared library not supported for: " + this.os);
    }

    // 生成 macOS dylib
    generateMacOSDylib() {
        const gen = new MachODylibGenerator(this.arch);
        gen.setOutputType("shared");

        if (this.compiler.outputFileName) {
            const baseName = path.basename(this.compiler.outputFileName);
            gen.setInstallName("@rpath/" + baseName);
        }

        const exports = this.compiler.exports;
        const exportFuncs = exports.length > 0 ? exports : Object.keys(this.ctx.functions);

        for (const name of exportFuncs) {
            const wrapperLabel = "_" + name;
            const offset = this.asm.labels.get(wrapperLabel);
            if (offset !== undefined) {
                gen.addExportedSymbol(name, offset);
            }
        }

        const codeVAddr = gen.getCodeVAddr();
        const dataVAddr = gen.getDataVAddr(this.asm.code.length);
        this.asm.codeVAddr = codeVAddr;
        this.asm.dataVAddr = dataVAddr;
        this.asm.fixupAll();

        return gen.generateDylib(this.asm.code, this.asm.data);
    }

    // 生成 Linux .so
    generateLinuxSO() {
        const gen = new ELF64DynamicGenerator(this.arch);
        gen.setOutputType("shared");

        if (this.compiler.outputFileName) {
            const baseName = path.basename(this.compiler.outputFileName);
            gen.setSOName(baseName);
        }

        const exports = this.compiler.exports;
        const exportFuncs = exports.length > 0 ? exports : Object.keys(this.ctx.functions);

        for (const name of exportFuncs) {
            const wrapperLabel = "_" + name;
            const offset = this.asm.labels.get(wrapperLabel);
            if (offset !== undefined) {
                gen.addExportedSymbol(name, offset);
            }
        }

        const codeVAddr = gen.getSOCodeVAddr();
        const dataVAddr = gen.getSODataVAddr(this.asm.code.length);
        this.asm.codeVAddr = codeVAddr;
        this.asm.dataVAddr = dataVAddr;
        this.asm.fixupAll();

        return gen.generate(this.asm.code, this.asm.data);
    }

    // 生成 Windows DLL
    generateWindowsDLL() {
        const gen = new PE64DllGenerator();

        let dllName = "library.dll";
        if (this.compiler.outputFileName) {
            dllName = path.basename(this.compiler.outputFileName);
        }

        const exports = this.compiler.exports;
        const exportFuncs = exports.length > 0 ? exports : Object.keys(this.ctx.functions);

        for (const name of exportFuncs) {
            const wrapperLabel = "_" + name;
            const offset = this.asm.labels.get(wrapperLabel);
            if (offset !== undefined) {
                gen.addExportedSymbol(name, offset);
            }
        }

        const codeVAddr = gen.getCodeVAddr();
        const dataVAddr = gen.getDataVAddr(this.asm.code.length);
        this.asm.codeVAddr = codeVAddr;
        this.asm.dataVAddr = dataVAddr;
        this.asm.fixupAll();

        return gen.generate(this.asm.code, this.asm.data, null, dllName);
    }

    // 生成目标文件
    generateObjectFile() {
        const exports = this.compiler.exports;
        const exportFuncs = exports.length > 0 ? exports : Object.keys(this.ctx.functions);

        if (this.os === "macos") {
            return this.generateMachOObject(exportFuncs);
        } else if (this.os === "linux") {
            return this.generateELFObject(exportFuncs);
        } else if (this.os === "windows") {
            return this.generateCOFFObject(exportFuncs);
        }
        throw new Error("Object file not supported for: " + this.os);
    }

    generateMachOObject(exportFuncs) {
        const gen = new MachOObjectGenerator(this.arch);
        gen.setExports(exportFuncs);

        if (this.asm.undefinedSymbolList?.length > 0) {
            gen.setUndefinedSymbols(this.asm.undefinedSymbolList);
        }
        if (this.asm.branchRelocations?.length > 0) {
            gen.setBranchRelocations(this.asm.branchRelocations);
        }

        this.asm.codeVAddr = 0;
        this.asm.dataVAddr = this.asm.code.length;
        this.asm.fixupAll();

        return gen.generate(this.asm.code, this.asm.data, this.asm.labels);
    }

    generateELFObject(exportFuncs) {
        const gen = new ELFObjectGenerator(this.arch);
        gen.setExports(exportFuncs);

        if (this.asm.undefinedSymbolList?.length > 0) {
            gen.setUndefinedSymbols(this.asm.undefinedSymbolList);
        }
        if (this.asm.branchRelocations?.length > 0) {
            gen.setBranchRelocations(this.asm.branchRelocations);
        }

        this.asm.codeVAddr = 0;
        this.asm.dataVAddr = this.asm.code.length;
        this.asm.fixupAll();

        return gen.generate(this.asm.code, this.asm.data, this.asm.labels);
    }

    generateCOFFObject(exportFuncs) {
        const gen = new COFFObjectGenerator(this.arch);
        gen.setExports(exportFuncs);

        if (this.asm.undefinedSymbolList?.length > 0) {
            gen.setUndefinedSymbols(this.asm.undefinedSymbolList);
        }
        if (this.asm.branchRelocations?.length > 0) {
            gen.setBranchRelocations(this.asm.branchRelocations);
        }

        this.asm.codeVAddr = 0;
        this.asm.dataVAddr = this.asm.code.length;
        this.asm.fixupAll();

        const dataArray = this.asm.dataSection || this.asm.data || [];
        return gen.generate(this.asm.code, dataArray, this.asm.labels);
    }

    // 生成静态库（返回目标文件数据）
    generateStaticLibrary() {
        const objectData = this.generateObjectFile();
        return {
            type: "static",
            objectData: objectData,
            outputPath: this.compiler.outputFileName,
        };
    }
}
