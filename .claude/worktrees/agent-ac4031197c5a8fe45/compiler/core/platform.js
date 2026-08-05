import process from "node:process";

// asm.js 平台配置和检测
// 支持的目标平台定义

export const TARGETS = {
    // macOS
    "macos-arm64": { os: "macos", arch: "arm64", ext: "", dylibExt: ".dylib", desc: "macOS ARM64 (Apple Silicon)" },
    "macos-x64": { os: "macos", arch: "x64", ext: "", dylibExt: ".dylib", desc: "macOS x86_64" },
    "darwin-arm64": { os: "macos", arch: "arm64", ext: "", dylibExt: ".dylib", desc: "macOS ARM64", alias: "macos-arm64" },
    "darwin-amd64": { os: "macos", arch: "x64", ext: "", dylibExt: ".dylib", desc: "macOS x86_64", alias: "macos-x64" },
    "macos-amd64": { os: "macos", arch: "x64", ext: "", dylibExt: ".dylib", desc: "macOS x86_64", alias: "macos-x64" },

    // Linux
    "linux-arm64": { os: "linux", arch: "arm64", ext: "", dylibExt: ".so", desc: "Linux ARM64" },
    "linux-x64": { os: "linux", arch: "x64", ext: "", dylibExt: ".so", desc: "Linux x86_64" },
    "linux-amd64": { os: "linux", arch: "x64", ext: "", dylibExt: ".so", desc: "Linux x86_64", alias: "linux-x64" },
    "linux-aarch64": { os: "linux", arch: "arm64", ext: "", dylibExt: ".so", desc: "Linux ARM64", alias: "linux-arm64" },

    // Windows
    "windows-arm64": { os: "windows", arch: "arm64", ext: ".exe", dylibExt: ".dll", desc: "Windows ARM64" },
    "windows-x64": { os: "windows", arch: "x64", ext: ".exe", dylibExt: ".dll", desc: "Windows x86_64" },
    "windows-amd64": { os: "windows", arch: "x64", ext: ".exe", dylibExt: ".dll", desc: "Windows x86_64", alias: "windows-x64" },

    // WebAssembly(单巨函数虚拟 CPU 模型,宿主 shim 提供 __syscall;见 docs/WASM_DESIGN.md)
    "wasm32-wasi": { os: "wasi", arch: "wasm32", ext: ".wasm", dylibExt: "", desc: "WebAssembly 32-bit (WASI-style host)" },
};

// 检测当前平台
export function detectPlatform() {
    let platform = process.platform;
    let arch = process.arch;

    if (platform === "linux") {
        if (arch === "arm64" || arch === "aarch64") {
            return "linux-arm64";
        } else {
            return "linux-x64";
        }
    } else if (platform === "darwin" || platform === "macos") {
        if (arch === "arm64") {
            return "macos-arm64";
        } else {
            return "macos-x64";
        }
    } else if (platform === "win32") {
        if (arch === "arm64") {
            return "windows-arm64";
        } else {
            return "windows-x64";
        }
    }

    return "linux-x64"; // 默认
}

// 获取目标平台的 OS

// 获取目标平台的架构

// 获取目标平台信息
export function getTargetInfo(targetPlatform) {
    let info = TARGETS[targetPlatform];
    if (!info) {
        return null;
    }
    let resolved = info.alias ? TARGETS[info.alias] : info;
    return {
        name: info.alias || targetPlatform,
        os: resolved.os,
        arch: resolved.arch,
        ext: resolved.ext,
        dylibExt: resolved.dylibExt,
        desc: resolved.desc,
        isAlias: !!info.alias,
    };
}

// 获取真实目标名（解析别名）
export function resolveTarget(targetPlatform) {
    let info = TARGETS[targetPlatform];
    if (!info) {
        return null;
    }
    return info.alias || targetPlatform;
}

// 列出所有非别名目标
export function listTargets() {
    let result = [];
    for (let name in TARGETS) {
        let info = TARGETS[name];
        if (!info.alias) {
            result.push({
                name: name,
                os: info.os,
                arch: info.arch,
                desc: info.desc,
            });
        }
    }
    return result;
}

// 获取当前平台对应的系统调用号

// 获取 mmap 标志
export function getMmapFlags(target) {
    let info = getTargetInfo(target);
    if (!info) return 0x22;

    // MAP_ANONYMOUS | MAP_PRIVATE
    return info.os === "linux" ? 0x22 : 0x1002;
}
