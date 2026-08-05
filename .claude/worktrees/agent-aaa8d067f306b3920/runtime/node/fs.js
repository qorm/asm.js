// asm.js Runtime - Node.js fs
// Provides file system operations for asm.js compiled binaries

import { JStoCstring, cstringToJS } from "./_string.js";
import { getSyscall } from "./constants.js";

const _proc = __get_process();
const platform = (_proc && _proc.platform) || "macos";
const arch = (_proc && _proc.arch) || "arm64";

// File flags —— 按平台取真值:macOS O_CREAT=0x200/O_TRUNC=0x400/O_APPEND=0x8,
// Linux O_CREAT=0x40/O_TRUNC=0x200/O_APPEND=0x400。此前统一用 Linux 数值:
// macOS 上 0x241 = O_CREAT|O_WRONLY|O_ASYNC,writeFileSync 实际不带 O_TRUNC,
// 覆盖写比旧文件短时会残留旧尾巴(gen2 比 gen1 多出页对齐尾零的"布局悬崖"即此)。
const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2;
const O_CREAT = platform === "macos" ? 0x200 : 0x40;
const O_TRUNC = platform === "macos" ? 0x400 : 0x200;
const O_APPEND = platform === "macos" ? 0x8 : 0x400;

function openFlags(flagStr) {
    if (!flagStr) return O_RDONLY;
    switch (flagStr) {
        case "r": return O_RDONLY;
        case "r+": return O_RDWR;
        case "w": return O_WRONLY | O_CREAT | O_TRUNC;
        case "w+": return O_RDWR | O_CREAT | O_TRUNC;
        case "a": return O_WRONLY | O_CREAT | O_APPEND;
        case "a+": return O_RDWR | O_CREAT | O_APPEND;
        default: return O_RDONLY;
    }
}

class Stats {
    constructor() {
        this.size = 0; this.mtime = new Date(); this.atime = new Date();
        this.ctime = new Date(); this.mode = 0; this.uid = 0;
        this.gid = 0; this.dev = 0; this.ino = 0; this.nlink = 0;
    }
    isFile() { return false; }
    isDirectory() { return false; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}

class Dirent {
    constructor(name, isDir = false, isFile = false) {
        this.name = name;
        this.isDirectory = () => isDir;
        this.isFile = () => isFile;
        this.isBlockDevice = () => false;
        this.isCharacterDevice = () => false;
        this.isFIFO = () => false;
        this.isSymbolicLink = () => false;
        this.isSocket = () => false;
    }
}

class Dir {
    constructor(path) {
        this.path = path;
        this._entries = [];
        this._index = 0;
    }
    read() {
        if (this._index >= this._entries.length) return null;
        return this._entries[this._index++];
    }
    close() {}
    *[Symbol.iterator]() {
        while (true) {
            const e = this.read();
            if (!e) break;
            yield e;
        }
    }
}

function writeCString(str, buf) {
    JStoCstring(str, buf, 65536);
}

class fs {
    static existsSync(p) {
        if (platform === "win32") {
            const pathBuf = __alloc(p.length + 10);
            writeCString(p, pathBuf);
            const fd = __winfs_open(pathBuf, 0);
            if (fd < 0) return false;
            __winfs_close(fd);
            return true;
        }
        let sc = getSyscall("open");
        if (sc < 0) sc = getSyscall("openat");
        if (sc < 0) return true;
        const pathBuf = __alloc(p.length + 10);
        writeCString(p, pathBuf);
        // linux 只有 openat(dirfd, path, flags, mode)：必须前置 AT_FDCWD(-100)，
        // 否则 path 被当 dirfd → 恒失败 → existsSync 对真实存在的文件返回 false。
        let fd;
        if (platform === "linux" && arch === "arm64") {
            fd = __syscall(sc, -100, pathBuf, O_RDONLY, 0);
        } else {
            fd = __syscall(sc, pathBuf, O_RDONLY, 0);
        }
        if (fd >= 0) {
            __syscall(getSyscall("close"), fd);
            return true;
        }
        return false;
    }

    static chmodSync(p, mode) {
        if (platform === "win32") return; // Windows 无 POSIX 权限位,可执行由扩展名决定
        const pathBuf = __alloc(p.length + 10);
        writeCString(p, pathBuf);
        if (platform === "linux" && arch === "arm64") {
            const sc = getSyscall("fchmodat");
            if (sc >= 0) __syscall(sc, -100, pathBuf, mode, 0); // AT_FDCWD=-100
        } else {
            const sc = getSyscall("chmod");
            if (sc >= 0) __syscall(sc, pathBuf, mode);
        }
    }

    static readFileSync(p, enc) {
        if (platform === "win32") {
            const pathBuf = __alloc(p.length + 10);
            writeCString(p, pathBuf);
            const fd = __winfs_open(pathBuf, 0);
            if (fd < 0) return "";
            const CHUNK = 65536;
            const buf = __alloc(CHUNK + 1);
            let result = "";
            while (true) {
                const n = __winfs_read(fd, buf, CHUNK);
                if (n <= 0) break;
                __setChar(buf + n, 0);
                result = result + __cstr_to_str(buf);
                if (n < CHUNK) break;
            }
            __winfs_close(fd);
            return result;
        }
        let scOpen = getSyscall("open");
        if (scOpen < 0) scOpen = getSyscall("openat");
        const scRead = getSyscall("read");
        const scClose = getSyscall("close");
        if (scOpen < 0 || scRead < 0 || scClose < 0) return "";

        const pathBuf = __alloc(p.length + 10);
        writeCString(p, pathBuf);

        let fd;
        if (platform === "linux" && arch === "arm64") {
            fd = __syscall(scOpen, -100, pathBuf, O_RDONLY, 0);
        } else {
            fd = __syscall(scOpen, pathBuf, O_RDONLY, 0);
        }
        if (fd < 0) return "";

        // 分块读，支持任意大小文件（原固定 65536 buf + 无 null 终止 → >64KB 文件如
        // compiler/index.js(80KB) 被截断、且 cstringToJS 读越界 garbage/O(n²) 崩）。
        // 每块 null 终止后用 __cstr_to_str（O(n) 一次性建串）转换并拼接。
        const CHUNK = 65536;
        const buf = __alloc(CHUNK + 1);
        let result = "";
        while (true) {
            const n = __syscall(scRead, fd, buf, CHUNK);
            if (n <= 0) break;
            __setChar(buf + n, 0); // 在实际读到的字节数处补 null
            result = result + __cstr_to_str(buf);
            if (n < CHUNK) break; // 短读 = EOF
        }
        __syscall(scClose, fd);
        return result;
    }

    static _winWrite(p, data, mode) {
        const pathBuf = __alloc(p.length + 10);
        writeCString(p, pathBuf);
        const fd = __winfs_open(pathBuf, mode);
        if (fd < 0) return;
        if (typeof data === "string") {
            const dataBuf = __alloc(data.length + 1);
            JStoCstring(data, dataBuf, data.length + 1);
            __winfs_write(fd, dataBuf, data.length);
        } else if (data && data.data && typeof data.data.length === "number") {
            const n = data.data.length;
            const dataBuf = __alloc(n + 1);
            for (let i = 0; i < n; i++) __setChar(dataBuf + i, data.data[i]);
            __winfs_write(fd, dataBuf, n);
        } else if (data && typeof data.length === "number") {
            const n = data.length;
            const dataBuf = __alloc(n + 1);
            for (let i = 0; i < n; i++) __setChar(dataBuf + i, data[i]);
            __winfs_write(fd, dataBuf, n);
        }
        __winfs_close(fd);
    }

    static writeFileSync(p, data, enc) {
        if (platform === "win32") {
            fs._winWrite(p, data, 1);
            return;
        }
        let scOpen = getSyscall("open");
        if (scOpen < 0) scOpen = getSyscall("openat");
        const scWrite = getSyscall("write");
        const scClose = getSyscall("close");
        if (scOpen < 0 || scWrite < 0 || scClose < 0) return;

        const flags = platform === "linux" ? 0x241 : O_CREAT | O_WRONLY | O_TRUNC;
        const mode = platform === "linux" ? 0x1FF : 0o644;

        const pathBuf = __alloc(p.length + 10);
        writeCString(p + "\x00", pathBuf);

        let fd;
        if (platform === "linux" && arch === "arm64") {
            fd = __syscall(scOpen, -100, pathBuf, flags, mode);
        } else {
            fd = __syscall(scOpen, pathBuf, flags, mode);
        }
        if (fd < 0) return;

        if (typeof data === "string") {
            const dataBuf = __alloc(data.length + 1);
            JStoCstring(data, dataBuf, data.length + 1);
            __syscall(scWrite, fd, dataBuf, data.length);
        } else if (data && data.data && typeof data.data.length === "number") {
            // Buffer：字节在 .data（数组访问任意属性现已安全返回 undefined）
            const n = data.data.length;
            const dataBuf = __alloc(n + 1);
            for (let i = 0; i < n; i++) __setChar(dataBuf + i, data.data[i]);
            __syscall(scWrite, fd, dataBuf, n);
        } else if (data && typeof data.length === "number") {
            // 字节数组/类数组：逐字节写入原生缓冲区再写
            const n = data.length;
            const dataBuf = __alloc(n + 1);
            for (let i = 0; i < n; i++) __setChar(dataBuf + i, data[i]);
            __syscall(scWrite, fd, dataBuf, n);
        }
        __syscall(scClose, fd);
    }

    static appendFileSync(p, data, enc) {
        // NOTE: 本文件的 O_* 常量现按平台取真值(macOS O_APPEND=0x8 可用)。
        // 追加仍实现为可移植的 read-existing + concatenate + writeFileSync
        // (writeFileSync 现带真 O_TRUNC,旧内容被完整替换,语义严格正确)。
        // appendFileSync is not on the self-host hot path (the compiler never
        // appends), so this cannot affect the bootstrap fixed point.
        let ds;
        if (typeof data === "string") {
            ds = data;
        } else if (data && data.data && typeof data.data.length === "number") {
            const n = data.data.length; let s = "";
            for (let i = 0; i < n; i++) s += String.fromCharCode(data.data[i]);
            ds = s;
        } else if (data && typeof data.length === "number") {
            const n = data.length; let s = "";
            for (let i = 0; i < n; i++) s += String.fromCharCode(data[i]);
            ds = s;
        } else {
            ds = String(data);
        }
        let existing = "";
        try { existing = fs.readFileSync(p, "utf8"); } catch (e) { existing = ""; }
        if (existing === null || existing === undefined) existing = "";
        fs.writeFileSync(p, existing + ds);
    }

    static copyFileSync(src, dest, flags) {
        const data = fs.readFileSync(src);
        if (data) fs.writeFileSync(dest, data);
    }

    static unlinkSync(p) {
        // 实删(2026-07-14):此前是 no-op。用 unlink/unlinkat 系统调用。
        // linux-arm64 无 unlink,走 unlinkat(AT_FDCWD=-100, path, 0);其余(macos/
        // linux-x64)有直 unlink(path)。win32 无桥接,保持 no-op。镜像 existsSync 的
        // pathBuf 构造(__alloc + writeCString)。
        if (platform === "win32") return;
        const useUnlinkat = platform === "linux" && arch === "arm64";
        const sc = getSyscall(useUnlinkat ? "unlinkat" : "unlink");
        if (sc < 0) return;
        const pathBuf = __alloc(p.length + 10);
        writeCString(p, pathBuf);
        // unlinkat 需前置 AT_FDCWD(-100) 与末位 flags(0);unlink 只收 path。
        if (useUnlinkat) __syscall(sc, -100, pathBuf, 0);
        else __syscall(sc, pathBuf);
    }
    static _mkdirOne(p) {
        if (platform === "win32") return;
        const pathBuf = __alloc(p.length + 10);
        writeCString(p + "\x00", pathBuf);
        const mode = 0o777;
        if (platform === "linux" && arch === "arm64") {
            const sc = getSyscall("mkdirat");
            if (sc >= 0) __syscall(sc, -100, pathBuf, mode);
        } else {
            const sc = getSyscall("mkdir");
            if (sc >= 0) __syscall(sc, pathBuf, mode);
        }
    }
    static mkdirSync(p, options) {
        if (platform === "win32") return;
        const recursive = options && options.recursive === true;
        if (recursive) {
            // 逐级创建父目录(已存在的层 mkdir 返 EEXIST,忽略)
            const parts = p.split("/");
            let cur = p.charAt(0) === "/" ? "" : ".";
            for (let i = 0; i < parts.length; i++) {
                if (parts[i] === "") continue;
                cur = cur + "/" + parts[i];
                fs._mkdirOne(cur);
            }
            return;
        }
        fs._mkdirOne(p);
    }
    static rmdirSync(p) {
        if (platform === "win32") return;
        const pathBuf = __alloc(p.length + 10);
        writeCString(p + "\x00", pathBuf);
        if (platform === "linux" && arch === "arm64") {
            const sc = getSyscall("unlinkat");
            if (sc >= 0) __syscall(sc, -100, pathBuf, 0x200); // AT_REMOVEDIR
        } else {
            const sc = getSyscall("rmdir");
            if (sc >= 0) __syscall(sc, pathBuf);
        }
    }
    static readdirSync(p, options) { return []; }

    static statSync(p) {
        const s = new Stats();
        s.isFile = () => true;
        return s;
    }

    static lstatSync(p) { return fs.statSync(p); }
    static accessSync(p, mode) { return fs.existsSync(p) ? 0 : -1; }

    static openSync(p, flags, mode) {
        let scOpen = getSyscall("open");
        if (scOpen < 0) scOpen = getSyscall("openat");
        if (scOpen < 0) return -1;
        const pathBuf = __alloc(p.length + 10);
        writeCString(p + "\x00", pathBuf);
        // 勿命名局部为 openFlags：会遮蔽同名模块函数并在 RHS 自引用（TDZ）→ 调用崩。
        const resolvedFlags = typeof flags === "string" ? openFlags(flags) : flags;
        const fileMode = mode || (platform === "linux" ? 0x1FF : 0o644);
        if (platform === "linux" && arch === "arm64") {
            return __syscall(scOpen, -100, pathBuf, resolvedFlags, fileMode);
        }
        return __syscall(scOpen, pathBuf, resolvedFlags, fileMode);
    }

    static closeSync(fd) { __syscall(getSyscall("close"), fd); }

    static readSync(fd, buffer, offset, length, position) {
        return __syscall(getSyscall("read"), fd, buffer, length);
    }

    static writeSync(fd, buffer, offset, length, position) {
        if (typeof buffer === "string") {
            const buf = __alloc(buffer.length + 1);
            JStoCstring(buffer, buf, buffer.length + 1);
            return __syscall(getSyscall("write"), fd, buf, buffer.length);
        }
        return __syscall(getSyscall("write"), fd, buffer, length || 0);
    }

    // createWriteStream / createReadStream return lightweight EventEmitter-like
    // stream objects (plain objects, not `class` instances) that actually move
    // data via the compiled event loop (queueMicrotask drain). They are kept
    // dependency-free — importing runtime/node/stream.js here would pull stream
    // classes into the compiler's own module graph (cli.js imports fs), which
    // is a self-host hazard, so a minimal inline implementation is used.
    static createWriteStream(p, options) {
        options = options || {};
        // Start fresh unless appending (flags 'a'). writeFileSync does not
        // truncate a pre-existing longer file on every target, so unlink first
        // to guarantee a clean file, then create it empty.
        const append = options.flags === "a" || options.flags === "as";
        if (!append) {
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
            try { fs.writeFileSync(p, ""); } catch (e) {}
        }
        const listeners = {};
        const emit = (ev, a) => { const ls = listeners[ev]; if (ls) for (let i = 0; i < ls.length; i++) ls[i](a); };
        const s = {
            writable: true,
            bytesWritten: 0,
            path: p,
            on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); return this; },
            once(ev, cb) { const w = (a) => { this.removeListener(ev, w); cb(a); }; return this.on(ev, w); },
            removeListener(ev, cb) { const ls = listeners[ev]; if (ls) { const i = ls.indexOf(cb); if (i >= 0) ls.splice(i, 1); } return this; },
            emit(ev, a) { emit(ev, a); return true; },
            write(data, enc, cb) {
                if (typeof enc === "function") { cb = enc; }
                fs.appendFileSync(p, data);
                this.bytesWritten += (data && data.length) ? data.length : 0;
                if (cb) queueMicrotask(() => cb(null));
                return true;
            },
            end(data, enc, cb) {
                if (typeof data === "function") { cb = data; data = null; }
                else if (typeof enc === "function") { cb = enc; }
                if (data !== null && data !== undefined) this.write(data);
                this.writable = false;
                const self = this;
                queueMicrotask(() => { emit("finish"); emit("close"); if (cb) cb(); });
                return this;
            },
            destroy() { this.writable = false; return this; },
        };
        return s;
    }

    static createReadStream(p, options) {
        options = options || {};
        const encoding = options.encoding || null;
        const listeners = {};
        const emit = (ev, a) => { const ls = listeners[ev]; if (ls) for (let i = 0; i < ls.length; i++) ls[i](a); };
        let started = false;
        const s = {
            readable: true,
            path: p,
            on(ev, cb) {
                (listeners[ev] || (listeners[ev] = [])).push(cb);
                if (ev === "data") this._start();
                return this;
            },
            once(ev, cb) { const w = (a) => { this.removeListener(ev, w); cb(a); }; return this.on(ev, w); },
            removeListener(ev, cb) { const ls = listeners[ev]; if (ls) { const i = ls.indexOf(cb); if (i >= 0) ls.splice(i, 1); } return this; },
            emit(ev, a) { emit(ev, a); return true; },
            _start() {
                if (started) return;
                started = true;
                const self = this;
                queueMicrotask(() => {
                    let data;
                    try { data = fs.readFileSync(p, encoding); }
                    catch (e) { emit("error", e); return; }
                    if (data === null || data === undefined) { emit("error", new Error("ENOENT: " + p)); return; }
                    // Chunk by highWaterMark when set; otherwise deliver whole.
                    const hwm = options.highWaterMark || 0;
                    if (hwm > 0 && data.length > hwm) {
                        let off = 0;
                        const pump = () => {
                            if (off >= data.length) { emit("end"); emit("close"); return; }
                            const chunk = data.slice(off, off + hwm);
                            off += hwm;
                            emit("data", chunk);
                            queueMicrotask(pump);
                        };
                        pump();
                    } else {
                        emit("data", data);
                        emit("end");
                        emit("close");
                    }
                });
            },
            pipe(dest, opts) {
                opts = opts || {};
                this.on("data", (chunk) => { dest.write(chunk); });
                if (opts.end !== false) this.on("end", () => { if (dest.end) dest.end(); });
                return dest;
            },
            destroy() { this.readable = false; return this; },
            close() { this.readable = false; },
        };
        return s;
    }
}

// 具名导出：cli.js / compiler 使用 `import { readFileSync, ... } from "fs"`
// 以及 `import * as fs` 后按名访问，namespace 必须能直接命中这些方法
export function existsSync(p) { return fs.existsSync(p); }
export function readFileSync(p, enc) { return fs.readFileSync(p, enc); }
export function writeFileSync(p, data, enc) { return fs.writeFileSync(p, data, enc); }
export function chmodSync(p, mode) { return fs.chmodSync(p, mode); }
export function appendFileSync(p, data, enc) { return fs.appendFileSync(p, data, enc); }
export function copyFileSync(src, dest, flags) { return fs.copyFileSync(src, dest, flags); }
export function unlinkSync(p) { return fs.unlinkSync(p); }
export function mkdirSync(p, options) { return fs.mkdirSync(p, options); }
export function rmdirSync(p) { return fs.rmdirSync(p); }
export function readdirSync(p, options) { return fs.readdirSync(p, options); }
export function statSync(p) { return fs.statSync(p); }
export function lstatSync(p) { return fs.lstatSync(p); }
export function accessSync(p, mode) { return fs.accessSync(p, mode); }
export function openSync(p, flags, mode) { return fs.openSync(p, flags, mode); }
export function closeSync(fd) { return fs.closeSync(fd); }
export function readSync(fd, buffer, offset, length, position) { return fs.readSync(fd, buffer, offset, length, position); }
export function writeSync(fd, buffer, offset, length, position) { return fs.writeSync(fd, buffer, offset, length, position); }

export { fs, Stats, Dirent, Dir };
export default fs;
