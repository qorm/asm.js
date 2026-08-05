// 动态库/静态库支持
// 提供动态库编译选项和链接器接口

import { OutputType } from "./binary_format.js";

// 动态库编译配置
export class DylibConfig {
    constructor() {
        this.name = "output"; // 库名称
        this.installName = null; // macOS: install name, Linux: soname
        this.version = "1.0.0"; // 版本号
        this.exports = []; // 导出的符号列表
        this.imports = []; // 导入的库列表
    }

    setName(name) {
        this.name = name;
        return this;
    }

    setInstallName(installName) {
        this.installName = installName;
        return this;
    }

    setVersion(version) {
        this.version = version;
        return this;
    }

    addExport(name) {
        this.exports.push(name);
        return this;
    }

    addImport(libName, symbols) {
        this.imports.push({
            library: libName,
            symbols: symbols || [],
        });
        return this;
    }

    // 获取平台相关的文件扩展名
    getExtension(platform) {
        if (platform === "macos" || platform === "macos-arm64" || platform === "macos-x64") {
            return ".dylib";
        } else if (platform === "windows" || platform === "windows-x64") {
            return ".dll";
        } else {
            return ".so";
        }
    }

    // 获取静态库扩展名
    getStaticExtension(platform) {
        if (platform === "windows" || platform === "windows-x64") {
            return ".lib";
        } else {
            return ".a";
        }
    }

    // 获取平台相关的 install name
    getInstallName(platform) {
        if (this.installName) {
            return this.installName;
        }
        let ext = this.getExtension(platform);
        if (platform.startsWith("macos")) {
            return "@rpath/lib" + this.name + ext;
        } else if (platform.startsWith("windows")) {
            return this.name + ext;
        } else {
            return "lib" + this.name + ext;
        }
    }

    // 解析版本字符串为数字
    parseVersion() {
        let parts = this.version.split(".");
        let major = parseInt(parts[0] || "1") || 1;
        let minor = parseInt(parts[1] || "0") || 0;
        let patch = parseInt(parts[2] || "0") || 0;
        return (major << 16) | (minor << 8) | patch;
    }
}

// 静态库配置
export class StaticLibConfig {
    constructor() {
        this.name = "output";
        this.objects = []; // 要包含的目标文件
        this.exports = []; // 导出的符号列表
    }

    setName(name) {
        this.name = name;
        return this;
    }

    addObject(path) {
        this.objects.push(path);
        return this;
    }

    addExport(name) {
        this.exports.push(name);
        return this;
    }

    // 获取静态库文件名
    getFilename(platform) {
        if (platform.startsWith("windows")) {
            return this.name + ".lib";
        } else {
            return "lib" + this.name + ".a";
        }
    }
}

// 动态库链接器配置
export class LinkerConfig {
    constructor() {
        this.libraries = []; // 要链接的库
        this.libraryPaths = []; // 库搜索路径
        this.rpath = []; // 运行时搜索路径
        this.staticLibraries = []; // 静态库
    }

    addLibrary(name, path) {
        this.libraries.push({ name: name, path: path || null });
        return this;
    }

    addStaticLibrary(name, path) {
        this.staticLibraries.push({ name: name, path: path });
        return this;
    }

    addLibraryPath(path) {
        this.libraryPaths.push(path);
        return this;
    }

    addRpath(path) {
        this.rpath.push(path);
        return this;
    }

    // 查找库文件
    findLibrary(name, platform) {
        let ext = platform.startsWith("macos") ? ".dylib" : platform.startsWith("windows") ? ".dll" : ".so";

        for (let searchPath of this.libraryPaths) {
            let fullPath = searchPath + "/lib" + name + ext;
            // 实际使用时需要检查文件是否存在
            return fullPath;
        }
        return null;
    }
}

// 符号解析器 - 用于解析外部符号引用
export class SymbolResolver {
    constructor() {
        this.symbols = {}; // 已知符号映射
        this.unresolved = []; // 未解析符号
        this.libraries = {}; // 库 -> 符号列表
    }

    // 注册库提供的符号
    registerLibrary(libName, symbols) {
        this.libraries[libName] = symbols;
        for (let i = 0; i < symbols.length; i++) {
            this.symbols[symbols[i]] = {
                library: libName,
                resolved: false,
            };
        }
    }

    // 标记符号为已使用
    useSymbol(name) {
        if (this.symbols[name]) {
            this.symbols[name].resolved = true;
            return true;
        }
        this.unresolved.push(name);
        return false;
    }

    // 获取需要链接的库列表
    getRequiredLibraries() {
        let libs = {};
        for (let name in this.symbols) {
            let sym = this.symbols[name];
            if (sym.resolved) {
                libs[sym.library] = true;
            }
        }
        return Object.keys(libs);
    }

    // 获取未解析的符号
    getUnresolvedSymbols() {
        return this.unresolved;
    }
}

// 导出符号收集器 - 从 AST 中收集要导出的符号
export class ExportCollector {
    constructor() {
        this.exports = [];
    }

    // 从 AST 收集导出声明
    collectFromAST(ast) {
        for (let i = 0; i < ast.body.length; i++) {
            let stmt = ast.body[i];
            if (stmt.type === "ExportDeclaration" || stmt.type === "ExportNamedDeclaration") {
                this._collectExport(stmt);
            } else if (stmt.type === "ExportDefaultDeclaration") {
                this._collectDefaultExport(stmt);
            }
        }
        return this.exports;
    }

    _collectExport(stmt) {
        if (stmt.declaration) {
            if (stmt.declaration.type === "FunctionDeclaration") {
                this.exports.push({
                    name: stmt.declaration.id.name,
                    type: "function",
                    isDefault: false,
                });
            } else if (stmt.declaration.type === "VariableDeclaration") {
                for (let i = 0; i < stmt.declaration.declarations.length; i++) {
                    let decl = stmt.declaration.declarations[i];
                    this.exports.push({
                        name: decl.id.name,
                        type: "variable",
                        isDefault: false,
                    });
                }
            }
        }

        if (stmt.specifiers) {
            for (let i = 0; i < stmt.specifiers.length; i++) {
                let spec = stmt.specifiers[i];
                this.exports.push({
                    name: spec.exported ? spec.exported.name : spec.local.name,
                    localName: spec.local.name,
                    type: "reference",
                    isDefault: false,
                });
            }
        }
    }

    _collectDefaultExport(stmt) {
        if (stmt.declaration) {
            if (stmt.declaration.type === "FunctionDeclaration" && stmt.declaration.id) {
                this.exports.push({
                    name: stmt.declaration.id.name,
                    type: "function",
                    isDefault: true,
                });
            } else if (stmt.declaration.type === "Identifier") {
                this.exports.push({
                    name: stmt.declaration.name,
                    type: "reference",
                    isDefault: true,
                });
            }
        }
    }
}

// 创建动态库编译器配置
export function createDylibCompilerOptions(config, target) {
    return {
        outputType: OutputType.SHARED,
        target: target,
        exports: config.exports,
        installName: config.getInstallName(target),
        version: config.parseVersion(),
    };
}

// 创建静态库编译器配置
export function createStaticLibCompilerOptions(config, target) {
    return {
        outputType: OutputType.OBJECT,
        target: target,
        exports: config.exports,
        isStaticLib: true,
    };
}
