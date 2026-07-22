// asm.js 编译器 - 库文件解析模块
// 解析 .jslib 文件，处理动态库和静态库导入

import * as fs from "fs";
import * as path from "path";

// ---- 手写字符串解析助手（替代正则）----
// 历史上自举编译器不支持 RegexLiteral（现已经 __RE_new shim 路线落地），
// .jslib 解析保留手写字符串扫描（无运行时正则依赖，更快）。
function jsIsSpace(c) {
    return c === " " || c === "\t" || c === "\n" || c === "\r";
}
function jsIsWord(c) {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}
// 提取 key: "value" 里的 value（key 后紧跟冒号，冒号后可空白，值带双引号）。无则 null。
function jslibQuoted(text, key) {
    let m = key + ":";
    let i = text.indexOf(m);
    if (i < 0) return null;
    let j = i + m.length;
    while (j < text.length && jsIsSpace(text[j])) j++;
    if (text[j] !== '"') return null;
    j++;
    let start = j;
    while (j < text.length && text[j] !== '"') j++;
    if (j >= text.length || j === start) return null;
    return text.substring(start, j);
}
// 提取 key: { ... } 里花括号内的内容。无则 null。
function jslibBrace(text, key) {
    let m = key + ":";
    let i = text.indexOf(m);
    if (i < 0) return null;
    let j = i + m.length;
    while (j < text.length && jsIsSpace(text[j])) j++;
    if (text[j] !== "{") return null;
    j++;
    let start = j;
    while (j < text.length && text[j] !== "}") j++;
    if (j >= text.length) return null;
    return text.substring(start, j);
}
// 提取 __lib__ = { ... \n}; 花括号内的内容。无则 null。
function jslibBlock(content) {
    let i = content.indexOf("__lib__");
    if (i < 0) return null;
    let j = i + 7;
    while (j < content.length && jsIsSpace(content[j])) j++;
    if (content[j] !== "=") return null;
    j++;
    while (j < content.length && jsIsSpace(content[j])) j++;
    if (content[j] !== "{") return null;
    j++;
    let end = content.indexOf("\n};", j);
    if (end < 0) return null;
    return content.substring(j, end);
}
// 扫描所有 `export function NAME(` 的 NAME 列表。
function jslibExportFuncs(content) {
    let syms = [];
    let i = 0;
    while (true) {
        i = content.indexOf("export", i);
        if (i < 0) break;
        let j = i + 6;
        if (j >= content.length || !jsIsSpace(content[j])) { i += 6; continue; }
        while (j < content.length && jsIsSpace(content[j])) j++;
        if (content.substr(j, 8) !== "function") { i += 6; continue; }
        j += 8;
        if (j >= content.length || !jsIsSpace(content[j])) { i += 6; continue; }
        while (j < content.length && jsIsSpace(content[j])) j++;
        let nstart = j;
        while (j < content.length && jsIsWord(content[j])) j++;
        if (j === nstart) { i += 6; continue; }
        let name = content.substring(nstart, j);
        while (j < content.length && jsIsSpace(content[j])) j++;
        if (content[j] === "(") syms.push(name);
        i = j;
    }
    return syms;
}

// 根据平台构建动态库名称
export function buildDylibName(libName, target) {
    if (target.includes("macos")) {
        return "lib" + libName + ".dylib";
    } else if (target.includes("linux")) {
        return "lib" + libName + ".so";
    } else if (target.includes("windows")) {
        return libName + ".dll";
    }
    return "lib" + libName + ".dylib";
}

// 根据平台构建静态库名称
export function buildStaticLibName(libName, target) {
    return "lib" + libName + ".a";
}

// 解析 jslib 文件
export function parseJslibFile(jslibPath, basePath, target) {
    let fullPath = jslibPath;
    if (!path.isAbsolute(jslibPath) && basePath) {
        fullPath = path.join(basePath, jslibPath);
    }

    let content;
    try {
        content = fs.readFileSync(fullPath, "utf-8");
    } catch (e) {
        console.log("Warning: Cannot read jslib file: " + fullPath);
        return null;
    }

    let libInfo = {
        name: "",
        path: "",
        version: "1.0.0",
        symbols: [],
        fullPath: "",
        type: "shared",
    };

    // 解析 __lib__ 对象
    let libContent = jslibBlock(content);
    if (libContent) {
        let nameV = jslibQuoted(libContent, "name");
        let versionV = jslibQuoted(libContent, "version");
        let typeV = jslibQuoted(libContent, "type");
        if (nameV) libInfo.name = nameV;
        if (versionV) libInfo.version = versionV;
        if (typeV) libInfo.type = typeV;

        // 检查 path 是字符串还是对象
        let pathStr = jslibQuoted(libContent, "path");
        let pathObjContent = jslibBrace(libContent, "path");

        if (pathStr) {
            libInfo.path = pathStr;
        } else if (pathObjContent) {
            let os = target.split("-")[0];
            let platformV = jslibQuoted(pathObjContent, os);
            if (platformV) {
                libInfo.path = platformV;
            }
        }
    }

    // 从 path 提取 name
    if (!libInfo.name && libInfo.path) {
        let baseName = path.basename(libInfo.path);
        if (baseName.startsWith("lib")) {
            baseName = baseName.substring(3);
        }
        let extIdx = baseName.lastIndexOf(".");
        if (extIdx > 0) {
            baseName = baseName.substring(0, extIdx);
        }
        libInfo.name = baseName;
    }

    // 解析 export function 声明
    let funcNames = jslibExportFuncs(content);
    for (let fi = 0; fi < funcNames.length; fi++) {
        libInfo.symbols.push(funcNames[fi]);
    }

    // 构建实际的库文件路径
    let jslibDir = path.dirname(fullPath);
    if (libInfo.path) {
        let libPath = libInfo.path;
        let libBasename = path.basename(libPath);

        let hasExt = libBasename.includes(".dylib") || libBasename.includes(".so") || libBasename.includes(".dll") || libBasename.includes(".a");

        if (!hasExt) {
            let libDir = path.dirname(libPath);
            let libName = libBasename;
            if (libName.startsWith("lib")) {
                libName = libName.substring(3);
            }
            let actualFileName;
            if (libInfo.type === "static") {
                actualFileName = buildStaticLibName(libName, target);
            } else {
                actualFileName = buildDylibName(libName, target);
            }
            libInfo.fullPath = path.join(jslibDir, libDir, actualFileName);
        } else {
            if (!path.isAbsolute(libPath)) {
                libInfo.fullPath = path.join(jslibDir, libPath);
            } else {
                libInfo.fullPath = libPath;
            }
        }
    }

    return libInfo;
}

// 库管理器类 - 管理外部库的加载和符号解析
export class LibraryManager {
    constructor() {
        this.externalLibs = []; // 动态库
        this.staticLibs = []; // 静态库
        this.registeredDylibs = []; // 已注册的 dylib 路径
    }

    // 添加外部动态库
    addExternalLib(libInfo) {
        this.externalLibs.push(libInfo);
    }

    // 添加静态库
    addStaticLib(libInfo) {
        this.staticLibs.push(libInfo);
    }

    // 检查符号是否来自外部库
    isExternalSymbol(name) {
        for (const lib of this.externalLibs) {
            if (lib.symbols && lib.symbols.includes(name)) {
                return true;
            }
        }
        for (const lib of this.staticLibs) {
            if (lib.symbols && lib.symbols.includes(name)) {
                return true;
            }
        }
        return false;
    }

    // 获取符号所属的库信息
    getLibraryForSymbol(name) {
        for (const lib of this.externalLibs) {
            if (lib.symbols && lib.symbols.includes(name)) {
                return lib;
            }
        }
        for (const lib of this.staticLibs) {
            if (lib.symbols && lib.symbols.includes(name)) {
                return lib;
            }
        }
        return null;
    }

    // 注册 dylib
    registerDylib(dylibPath) {
        if (!this.registeredDylibs.includes(dylibPath)) {
            this.registeredDylibs.push(dylibPath);
        }
    }

    // 获取 dylib 索引
    getDylibIndex(dylibPath) {
        const idx = this.registeredDylibs.indexOf(dylibPath);
        if (idx >= 0) {
            return idx + 2; // ordinal 从 2 开始（1 是 libSystem）
        }
        return 2;
    }

    // 检查是否已加载指定库
    isLibraryLoaded(fullPath, type) {
        const libs = type === "static" ? this.staticLibs : this.externalLibs;
        for (const lib of libs) {
            if (lib.fullPath === fullPath) {
                return true;
            }
        }
        return false;
    }
}
