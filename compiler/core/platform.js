import process from "node:process";

// asm.js 平台配置和检测
// 支持的目标平台定义

// 单一目标目录:编译器(cli.js / compiler/index.js)统一消费这张表,不再各持一份本地副本。
// 字段:os/arch/ext/dylibExt/desc 为既有字段;release=true 标记五个发布目标(与
// .github/workflows/release.yml 的 `for T in ...` 一致),experimental=true 标记实验性
// 目标。alias 指向正式名,本身不在 listTargets 输出。windows-arm64 尚未实现(无对应
// 后端),已从公开目录移除——不再公开「不可构造」的目标;arm64 Windows 宿主由
// detectPlatform 归到 windows-x64(可经 x64 模拟运行)。
export const TARGETS = {
    // macOS
    "macos-arm64": { os: "macos", arch: "arm64", ext: "", dylibExt: ".dylib", desc: "macOS ARM64 (Apple Silicon)", release: true },
    "macos-x64": { os: "macos", arch: "x64", ext: "", dylibExt: ".dylib", desc: "macOS x86_64", release: true },
    "darwin-arm64": { os: "macos", arch: "arm64", ext: "", dylibExt: ".dylib", desc: "macOS ARM64", alias: "macos-arm64" },
    "darwin-amd64": { os: "macos", arch: "x64", ext: "", dylibExt: ".dylib", desc: "macOS x86_64", alias: "macos-x64" },
    "macos-amd64": { os: "macos", arch: "x64", ext: "", dylibExt: ".dylib", desc: "macOS x86_64", alias: "macos-x64" },

    // Linux
    "linux-arm64": { os: "linux", arch: "arm64", ext: "", dylibExt: ".so", desc: "Linux ARM64", release: true },
    "linux-x64": { os: "linux", arch: "x64", ext: "", dylibExt: ".so", desc: "Linux x86_64", release: true },
    "linux-amd64": { os: "linux", arch: "x64", ext: "", dylibExt: ".so", desc: "Linux x86_64", alias: "linux-x64" },
    "linux-aarch64": { os: "linux", arch: "arm64", ext: "", dylibExt: ".so", desc: "Linux ARM64", alias: "linux-arm64" },

    // Windows(windows-arm64 未实现,已从公开目录移除)
    "windows-x64": { os: "windows", arch: "x64", ext: ".exe", dylibExt: ".dll", desc: "Windows x86_64", release: true },
    "windows-amd64": { os: "windows", arch: "x64", ext: ".exe", dylibExt: ".dll", desc: "Windows x86_64", alias: "windows-x64" },

    // WebAssembly(单巨函数虚拟 CPU 模型,宿主 shim 提供 __syscall;见 docs/WASM_DESIGN.md)
    "wasm32-wasi": { os: "wasi", arch: "wasm32", ext: ".wasm", dylibExt: "", desc: "WebAssembly 32-bit (WASI-style host)", experimental: true },
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
        // windows-arm64 未实现、已移出公开目录:arm64 Windows 宿主归到 windows-x64
        // (可经 x64 模拟运行),避免 detectPlatform 返回一个不可构造的目标。
        return "windows-x64";
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

// 获取真实目标名（解析别名）。未知目标抛 Error("Unknown target: <name>")——
// cli.js 与 Compiler 构造器都依赖这个抛错来在「校验/构造」同一处拦截非法目标,
// 消除「过了校验却在构造阶段崩」的分叉。
export function resolveTarget(targetPlatform) {
    let info = TARGETS[targetPlatform];
    if (!info) {
        throw new Error("Unknown target: " + targetPlatform);
    }
    return info.alias || targetPlatform;
}

// 列出所有非别名目标(按 TARGETS 插入序:五个 release 目标在前、实验性目标在后)。
// 返回值携带 release/experimental 标记,供 cli 与契约测试区分发布/实验目标。
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
                release: !!info.release,
                experimental: !!info.experimental,
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
