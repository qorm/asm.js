// asm.js Runtime - Node.js process
// Provides process object for asm.js compiled binaries

import { syscallWrite } from "./_string.js";
import { getSyscall } from "./constants.js";

const _proc = __get_process();
const platform = (_proc && _proc.platform) || "macos";
const arch = (_proc && _proc.arch) || "arm64";

class _process {
    static get platform() { return platform; }
    static get arch() { return arch; }
    static get argv() { return _proc.argv || []; }
    static get argv0() { const a = _proc.argv; return (a && a[0]) || "asm.js"; }
    static get execPath() { const a = _proc.argv; return (a && a[0]) || "/asm.js"; }
    static get env() { return _proc.env || {}; }
    static cwd() { return (_proc && _proc.cwd) || "/"; }
    static chdir(dir) {
        if (_proc.chdir) _proc.chdir(dir);
    }
    static get uid() { return __getuid ? __getuid() : 0; }
    static get gid() { return __getgid ? __getgid() : 0; }
    static get euid() { return 0; }
    static get egid() { return 0; }
    static get pid() { return __getpid ? __getpid() : 1; }
    static get ppid() { return 0; }
    static get version() { return "v18.0.0"; }
    static get versions() {
        return { node: "18.0.0", v8: "10.2.0", uv: "1.0.0" };
    }
    static get config() { return {}; }
    static get features() {
        return {
            inspector: false, debug: false, uv: true, ipv6: true,
            tls_alpn: false, tls_sni: true, tls_ocsp: true, tls: false
        };
    }
    static get release() { return { name: "node" }; }
    static get stderr() {
        return {
            isTTY: false, fd: 2,
            write: (str) => {
                if (str) syscallWrite(2, str, getSyscall);
                return true;
            }
        };
    }
    static get stdin() {
        return { isTTY: false, fd: 0, read: () => null, readable: false };
    }
    static get stdout() {
        return {
            isTTY: false, fd: 1, writable: true,
            write: (str) => {
                if (str) syscallWrite(1, str, getSyscall);
                return true;
            }
        };
    }
    static exit(code) {
        // code 可能是 raw float64 位模式，必须先转成 int32 再进 syscall
        __syscall(getSyscall("exit"), (code | 0));
        while (true) { } // In case syscall doesn't exit
    }
    static kill(pid, signal) { }
    static umask(mask) {
        if (mask === undefined) return 0o022;
        return 0o022;
    }
    static uptime() { return Math.floor(Date.now() / 1000); }
    static hrtime() {
        const ms = Date.now();
        return [Math.floor(ms / 1000), (ms % 1000) * 1000000];
    }
    static hrtimeBigint() { return BigInt(Date.now()) * 1000000n; }
    static memoryUsage() {
        return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
    }
    static memoryUsageRSS() { return 0; }
    static cpuUsage(prev) { return { user: 0, system: 0 }; }
    static resourceUsage() {
        return { user: 0, system: 0, maxRSS: 0, swapped: 0, involuntaryCtxSwitches: 0 };
    }
    static getActiveResourcesInfo() { return []; }
    static binding(name) {
        throw new Error("process.binding is not supported in asm.js");
    }
    static _linkedBinding(name) {
        throw new Error("process._linkedBinding is not supported in asm.js");
    }
    static _events() { return {}; }
    static _rawDebug(...args) { console.error(...args); }
    static _fatalException() { return false; }
    static _exiting = false;
    static get exitCode() { return _process._exitCode || 0; }
    static set exitCode(code) { _process._exitCode = code; }
    static get weakRefId() { return 0; }
    static allowedNodeEnvironmentFlags = new Set();

    // Event emitter methods
    static on(event, listener) { return _process; }
    static once(event, listener) { return _process; }
    static addListener(event, listener) { return _process; }
    static removeListener(event, listener) { return _process; }
    static removeAllListeners(event) { return _process; }
    static setMaxListeners(n) { return _process; }
    static getMaxListeners() { return 10; }
    static listeners(event) { return []; }
    static rawListeners(event) { return []; }
    static emit(event, ...args) { return false; }
    static eventNames() { return []; }
    static listenerCount(type) { return 0; }
    static callbackify() { }

    static nextTick(callback, ...args) {
        __asmjsNextTick?.(() => callback(...args)) || callback(...args);
    }

    static send(message, sendHandle, options, callback) {
        if (callback) callback(null);
        return true;
    }
}

export { _process as process };
export default _process;
