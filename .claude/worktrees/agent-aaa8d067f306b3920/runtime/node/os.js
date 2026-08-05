// asm.js Runtime - Node.js os module
// Provides OS utilities

// node os.platform() 用 "darwin"(非 asm.js 内部的 "macos");按实际目标平台派生。
function _plat() { const p = __get_process(); return (p && p.platform) || "macos"; }
export function platform() { const p = _plat(); return p === "macos" ? "darwin" : p; }
export function arch() { const p = __get_process(); return (p && p.arch) || "arm64"; }
export function type() {
    const p = _plat();
    return p === "linux" ? "Linux" : (p === "win32" || p === "windows") ? "Windows_NT" : "Darwin";
}
export function tmpdir() { return "/tmp"; }
export function homedir() { return "/Users/user"; }
export function endianness() { return "LE"; }
export function hostname() { return "asm.js"; }
export function release() { return "1.0.0"; }
export function uptime() { return 0; }
export function loadavg() { return [0, 0, 0]; }
export function totalmem() { return 8589934592; }
export function freemem() { return 4294967296; }
export function cpus() {
    return [{
        model: "virtual", speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
    }];
}
export function getEols() { return ["\n"]; }
export function getPriority(pid) { return 0; }
export function setPriority(pid, priority) {}
export function constants() {
    return { UV_UDP_REUSEADDR: 4, signals: {}, errno: {}, priority: {} };
}
// os.userInfo(): 进程用户信息(posix 形状;无口令数据库访问,给合理占位)
export function userInfo(options) {
    const p = __get_process();
    const home = homedir();
    const uid = (p && typeof p.getuid === "function") ? p.getuid() : 501;
    const gid = (p && typeof p.getgid === "function") ? p.getgid() : 20;
    return {
        uid: uid,
        gid: gid,
        username: "user",
        homedir: home,
        shell: _plat() === "win32" ? null : "/bin/zsh",
    };
}
// os.networkInterfaces(): 至少给出回环接口(无真实枚举)
export function networkInterfaces() {
    return {
        lo0: [
            { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" },
            { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", mac: "00:00:00:00:00:00", internal: true, cidr: "::1/128", scopeid: 0 },
        ],
    };
}
// os.machine() / os.version(): 平台派生占位
export function machine() { return arch() === "arm64" ? "arm64" : "x86_64"; }
export function version() { return "asm.js OS"; }
// os.availableParallelism(): 逻辑 CPU 数(无探测,返回 cpus 长度)
export function availableParallelism() { return cpus().length; }

// os.EOL 是字符串属性(非函数);posix 恒 "\n"(asm.js 路径/平台统一)
export const EOL = "\n";
export const devNull = "/dev/null";

// os object containing all OS utilities as properties
const os = {
    EOL,
    devNull,
    platform,
    arch,
    type,
    tmpdir,
    homedir,
    endianness,
    hostname,
    release,
    uptime,
    loadavg,
    totalmem,
    freemem,
    cpus,
    getEols,
    getPriority,
    setPriority,
    constants,
    userInfo,
    networkInterfaces,
    machine,
    version,
    availableParallelism
};

// Export os as a named export for: import { os } from "os"
// This re-export makes the os object available as a named export
// so that index.js can re-export it and namespace imports work
export { os };

// Also export as default for: import os from "os"
export default os;
