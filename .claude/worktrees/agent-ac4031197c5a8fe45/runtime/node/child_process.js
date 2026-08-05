// asm.js Runtime - Node.js child_process
//
// 注意：此文件只在「被 asm.js 编译成 native」时链接;在 gen0(node cli.js)下运行时
// 用的是 Node 真实 child_process。故此处可直接用 __syscall 等 native intrinsic。
//
// execSync/spawnSync（同步子进程捕获）：fork + 临时文件重定向 stdout + execve("/bin/sh",
// ["-c", cmd]) + wait4，父进程读回临时文件内容。
//
// 为何用临时文件而非 pipe：macOS 的 pipe() 系统调用经寄存器(x0/x1)回传两个 fd,而
// __syscall 只取 x0——拿不到写端 fd。改用「子进程 stdout→临时文件、父进程读文件」避开。
//
// 为何 getpid 判子进程：macOS fork 的父子返回值 x0 同为 childpid(仅 x1 flag 区分,
// __syscall 只取 x0),故用 getpid()==forkRet 判定子进程(子进程 getpid==自身 pid==forkRet,
// 父进程 getpid==父 pid≠childpid)。Linux fork/clone 的 x0 正常(0=子/pid=父),直接判。
//
// 原地替换(stdio:inherit)路径仍保留 execve 替换语义(不 fork,输出直达终端)。

import { JStoCstring } from "./_string.js";
import { getSyscall } from "./constants.js";
import { Buffer } from "./buffer.js";

const _proc = __get_process();
const platform = (_proc && _proc.platform) || "macos";
const arch = (_proc && _proc.arch) || "arm64";

// 把 64 位裸指针写入 buf+offset(指针非 float64,不能在 JS 里按字节拆,用 __setPtr 内建)
function _storePtr(buf, offset, val) {
    __setPtr(buf + offset, val);
}

// 分配并写入以 NUL 结尾的 C 字符串,返回缓冲区指针(足够容纳 UTF-8 多字节)
function _cstr(s) {
    const str = String(s);
    const b = __alloc(str.length * 4 + 4);
    JStoCstring(str + "\x00", b, str.length * 4 + 4);
    return b;
}

// ---- 平台感知系统调用小工具 ----

// open(O_WRONLY|O_CREAT|O_TRUNC, 0644) 供子进程重定向;返回 fd(<0 失败)。
// 接受已建好的 pathBuf(fork 前预建,避免子进程侧分配)。
function _openWriteBuf(pathBuf) {
    const flags = platform === "linux" ? 0x241 : 0x601; // O_WRONLY|O_CREAT|O_TRUNC
    if (platform === "linux") return __syscall(getSyscall("openat"), -100, pathBuf, flags, 420);
    return __syscall(getSyscall("open"), pathBuf, flags, 420);
}

// open(O_RDONLY) 供父进程读回;返回 fd。
function _openRead(path) {
    const pathBuf = _cstr(path);
    if (platform === "linux") return __syscall(getSyscall("openat"), -100, pathBuf, 0, 0);
    return __syscall(getSyscall("open"), pathBuf, 0, 0);
}

// dup2(oldfd, newfd)（linux-arm64 无 dup2,用 dup3(...,0)）。
function _dup(oldfd, newfd) {
    if (platform === "linux" && arch === "arm64") return __syscall(getSyscall("dup3"), oldfd, newfd, 0);
    return __syscall(getSyscall("dup2"), oldfd, newfd);
}

// unlink(path)（linux-arm64 用 unlinkat(AT_FDCWD, path, 0)）。
function _unlink(path) {
    const pathBuf = _cstr(path);
    if (platform === "linux" && arch === "arm64") { __syscall(getSyscall("unlinkat"), -100, pathBuf, 0); return; }
    __syscall(getSyscall("unlink"), pathBuf);
}

// fork（linux-arm64 无 fork,用 clone(SIGCHLD=17,...)）。返回值语义见文件头。
function _fork() {
    if (platform === "linux" && arch === "arm64") {
        return __syscall(getSyscall("clone"), 17, 0, 0, 0, 0);
    }
    return __syscall(getSyscall("fork"));
}

// 判定当前是否子进程(见文件头 getpid 说明)。
function _isChild(forkRet) {
    if (platform === "macos") return __syscall(getSyscall("getpid")) === forkRet;
    return forkRet === 0;
}

// 从 process.env 建 envp(KEY=VALUE cstr 数组 + NULL 结尾),令子进程继承环境(PATH 等)。
function _buildEnvp() {
    let keys = [];
    const env = (_proc && _proc.env) || null;
    if (env) { try { keys = Object.keys(env); } catch (e) { keys = []; } }
    const buf = __alloc((keys.length + 1) * 8);
    for (let i = 0; i < keys.length; i++) {
        _storePtr(buf, i * 8, _cstr(keys[i] + "=" + env[keys[i]]));
    }
    _storePtr(buf, keys.length * 8, 0);
    return buf;
}

// 读整个临时文件为字节数组(raw-safe:__getChar 逐字节,不经 _js_add 数值强转),然后 unlink。
function _readAllAndUnlink(path) {
    const bytes = [];
    const fd = _openRead(path);
    if (fd >= 0) {
        const readSc = getSyscall("read");
        const CHUNK = 65536;
        const buf = __alloc(CHUNK);
        while (true) {
            const n = __syscall(readSc, fd, buf, CHUNK);
            if (n <= 0) break;
            for (let i = 0; i < n; i++) bytes.push(__getChar(buf + i));
            if (n < CHUNK) break;
        }
        __syscall(getSyscall("close"), fd);
    }
    _unlink(path);
    return bytes;
}

let _cpCounter = 0;

// 核心:fork + 临时文件重定向 + execve("/bin/sh", [shArgs...]) + wait4 + 读回。
// shArgs = 传给 /bin/sh 的 argv[1..](字符串数组)。返回
// { status(exit code 或 null), signal, stdout:<bytes>, stderr:<bytes> }。
// captureStderr=false 时 stderr 直达终端(execSync 语义);true 时也重定向捕获(spawnSync)。
function _runCapture(shArgs, captureStderr) {
    const forkSc = (platform === "linux" && arch === "arm64") ? getSyscall("clone") : getSyscall("fork");
    const execSc = getSyscall("execve");
    if (forkSc < 0 || execSc < 0) return { status: -1, signal: null, stdout: [], stderr: [] };

    const pid0 = __syscall(getSyscall("getpid"));
    const outPath = "/tmp/asmjs_cp_" + pid0 + "_" + (_cpCounter++) + ".out";
    const errPath = captureStderr ? "/tmp/asmjs_cp_" + pid0 + "_" + (_cpCounter++) + ".err" : null;

    // fork 前预建所有子进程要用的裸缓冲(COW 传给子进程,子进程侧零 JS 分配)。
    const outPathBuf = _cstr(outPath);
    const errPathBuf = errPath ? _cstr(errPath) : 0;
    const shPath = _cstr("/bin/sh");
    // argv = [ /bin/sh, ...shArgs, NULL ]
    const argc = shArgs.length + 1;
    const argv = __alloc((argc + 1) * 8);
    _storePtr(argv, 0, shPath);
    for (let i = 0; i < shArgs.length; i++) {
        _storePtr(argv, (i + 1) * 8, _cstr(String(shArgs[i])));
    }
    _storePtr(argv, argc * 8, 0);
    const envp = _buildEnvp();

    const r = _fork();
    if (r < 0) return { status: -1, signal: null, stdout: [], stderr: [] };

    if (_isChild(r)) {
        // 子进程:重定向 stdout(可选 stderr)到临时文件,execve /bin/sh -c cmd。
        const ofd = _openWriteBuf(outPathBuf);
        if (ofd >= 0) _dup(ofd, 1);
        if (errPathBuf) {
            const efd = _openWriteBuf(errPathBuf);
            if (efd >= 0) _dup(efd, 2);
        }
        __syscall(execSc, shPath, argv, envp);
        __syscall(getSyscall("exit"), 127); // execve 失败
    }

    // 父进程:等子进程结束,读回临时文件。
    const statusBuf = __alloc(16);
    __syscall(getSyscall("wait4"), r, statusBuf, 0, 0);
    const raw = __getChar(statusBuf) | (__getChar(statusBuf + 1) << 8) |
        (__getChar(statusBuf + 2) << 16) | (__getChar(statusBuf + 3) << 24);
    const stdoutBytes = _readAllAndUnlink(outPath);
    const stderrBytes = errPath ? _readAllAndUnlink(errPath) : [];
    const signaled = (raw & 0x7f) !== 0;
    return {
        status: signaled ? null : ((raw >> 8) & 0xff),
        signal: signaled ? (raw & 0x7f) : null,
        stdout: stdoutBytes,
        stderr: stderrBytes,
    };
}

// 字节数组 → 输出:有 encoding(非 "buffer")返字符串,否则返 Buffer(node 默认)。
function _bytesToOutput(bytes, enc) {
    const buf = Buffer.from(bytes);
    if (enc && enc !== "buffer") return buf.toString(enc);
    return buf;
}

export function execSync(cmd, options) {
    // execSync(cmd):cmd 是完整 shell 命令串 → /bin/sh -c cmd。
    const res = _runCapture(["-c", String(cmd)], false);
    const enc = options && options.encoding;
    const out = _bytesToOutput(res.stdout, enc);
    if (res.status !== 0) {
        // node:非零退出/信号 → 抛错,附 status/signal/stdout/stderr。
        const err = new Error("Command failed: " + cmd);
        err.status = res.status;
        err.signal = res.signal;
        err.stdout = out;
        err.stderr = _bytesToOutput(res.stderr, enc);
        err.pid = 0;
        throw err;
    }
    return out;
}

export function spawnSync(cmd, args, options) {
    // stdio:inherit → 原地 execve 替换(不 fork,输出直达终端;不返回,除非 execve 失败)。
    if (options && options.stdio === "inherit") {
        _execReplace(cmd, args);
        return { status: 0, signal: null, output: [null, "", ""], pid: 0, stdout: null, stderr: null };
    }
    // 非 inherit:spawnSync(file, args) 直接以 file+args 各自独立的 argv 运行(无 shell 重拆分),
    // 但需 PATH 解析。用经典 `sh -c 'exec "$0" "$@"' file arg1 arg2...`:sh 对 $0 做 PATH 解析并
    // exec,$@ 原样作独立实参传入,故实参含空格/元字符不被重解释。fork 捕获 stdout+stderr。
    const argList = args || [];
    const shArgs = ["-c", 'exec "$0" "$@"', String(cmd)];
    for (let i = 0; i < argList.length; i++) shArgs.push(String(argList[i]));
    const res = _runCapture(shArgs, true);
    const enc = options && options.encoding;
    const so = _bytesToOutput(res.stdout, enc);
    const se = _bytesToOutput(res.stderr, enc);
    return {
        status: res.status,
        signal: res.signal,
        pid: 0,
        output: [null, so, se],
        stdout: so,
        stderr: se,
    };
}

// execve 就地替换:成功则不返回(stdio:inherit 专用)。
function _execReplace(cmd, args) {
    const sc = getSyscall("execve");
    if (sc < 0) return;
    const argList = args || [];
    const argc = argList.length + 1;
    const pathBuf = _cstr(cmd);
    const argvBuf = __alloc((argc + 1) * 8);
    _storePtr(argvBuf, 0, pathBuf);
    for (let i = 0; i < argList.length; i++) {
        _storePtr(argvBuf, (i + 1) * 8, _cstr(String(argList[i])));
    }
    _storePtr(argvBuf, argc * 8, 0);
    __syscall(sc, pathBuf, argvBuf, _buildEnvp());
    // 走到这里说明 execve 失败
}

// A minimal Readable-ish stream over a fixed string payload. Plain object (not a
// class) so no stream classes are pulled in. Delivery is driven by the owning
// ChildProcess (see _childProcess) so stdout/stderr flush before 'exit'/'close',
// matching Node's ordering.
function _readableOf(payload) {
    const listeners = {};
    const emit = (ev, a, b) => { const ls = listeners[ev]; if (ls) for (let i = 0; i < ls.length; i++) ls[i](a, b); };
    const s = {
        readable: true,
        _payload: payload,
        on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); return this; },
        once(ev, cb) { const w = (a, b) => { this.removeListener(ev, w); cb(a, b); }; return this.on(ev, w); },
        removeListener(ev, cb) { const ls = listeners[ev]; if (ls) { const i = ls.indexOf(cb); if (i >= 0) ls.splice(i, 1); } return this; },
        emit(ev, a, b) { emit(ev, a, b); return true; },
        setEncoding() { return this; },
        // Flush the whole payload as one 'data' chunk, then 'end'/'close'.
        _deliver() {
            if (this._payload && this._payload.length) emit("data", this._payload);
            emit("end");
            emit("close");
        },
        pipe(dest, opts) {
            opts = opts || {};
            this.on("data", (chunk) => { if (dest.write) dest.write(chunk); });
            if (opts.end !== false) this.on("end", () => { if (dest.end) dest.end(); });
            return dest;
        },
        destroy() { this.readable = false; return this; },
    };
    return s;
}

// Build a ChildProcess-like object from a completed synchronous capture.
// NOTE: asm.js has no true asynchronous subprocess — the command is run
// synchronously (fork + wait) inside spawn()/exec(); its stdout/stderr are then
// replayed as streams and 'exit'/'close' fire on a later microtask, so listeners
// registered right after the call still receive the events. A single ordered
// microtask flushes stdout, then stderr, then the child's 'exit'/'close' (so
// data always precedes exit, as in Node). stdin cannot feed an already-finished
// process, so child.stdin.write is a no-op.
function _childProcess(res, enc) {
    const listeners = {};
    const emit = (ev, a, b) => { const ls = listeners[ev]; if (ls) for (let i = 0; i < ls.length; i++) ls[i](a, b); };
    // The stdout/stderr streams always deliver decoded strings (Buffer chunks
    // would require String(Buffer) at the consumer, which is unreliable here).
    const so = _bytesToOutput(res.stdout, "utf8");
    const se = _bytesToOutput(res.stderr, "utf8");
    const stdout = _readableOf(so);
    const stderr = _readableOf(se);
    const child = {
        pid: res.pid || 0,
        exitCode: res.status,
        signalCode: res.signal || null,
        killed: false,
        stdout: stdout,
        stderr: stderr,
        stdin: { write() { return false; }, end() {}, on() { return this; }, once() { return this; } },
        on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); return this; },
        once(ev, cb) { const w = (a, b) => { const ls = listeners[ev]; if (ls) { const i = ls.indexOf(w); if (i >= 0) ls.splice(i, 1); } cb(a, b); }; return this.on(ev, w); },
        removeListener(ev, cb) { const ls = listeners[ev]; if (ls) { const i = ls.indexOf(cb); if (i >= 0) ls.splice(i, 1); } return this; },
        emit(ev, a, b) { emit(ev, a, b); return true; },
        kill() { this.killed = true; return true; },
        unref() { return this; },
        ref() { return this; },
    };
    // Flush output first, then fire exit/close — one ordered microtask.
    queueMicrotask(() => {
        stdout._deliver();
        stderr._deliver();
        emit("exit", res.status, res.signal || null);
        emit("close", res.status, res.signal || null);
    });
    return child;
}

// spawn(command, args?, options?) -> ChildProcess.
export function spawn(command, args, options) {
    if (args && !Array.isArray(args)) { options = args; args = []; }
    args = args || [];
    options = options || {};
    let res;
    if (options.shell) {
        // shell:true -> run "command args..." through /bin/sh -c.
        let line = String(command);
        for (let i = 0; i < args.length; i++) line += " " + String(args[i]);
        res = _runCapture(["-c", line], true);
    } else {
        const shArgs = ["-c", 'exec "$0" "$@"', String(command)];
        for (let i = 0; i < args.length; i++) shArgs.push(String(args[i]));
        res = _runCapture(shArgs, true);
    }
    return _childProcess(res, options.encoding);
}

// exec(command, options?, callback) -> ChildProcess; callback(err, stdout, stderr).
export function exec(command, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    options = options || {};
    const res = _runCapture(["-c", String(command)], true);
    const enc = options.encoding;
    const child = _childProcess(res, enc);
    if (typeof callback === "function") {
        // Node's exec() resolves stdout/stderr as strings unless encoding is
        // "buffer"; decode to utf8 by default (also avoids String(Buffer)).
        const cbEnc = (enc && enc !== "buffer") ? enc : "utf8";
        const so = _bytesToOutput(res.stdout, cbEnc);
        const se = _bytesToOutput(res.stderr, cbEnc);
        queueMicrotask(() => {
            let err = null;
            if (res.status !== 0) {
                err = new Error("Command failed: " + command);
                err.code = res.status;
                err.signal = res.signal || null;
                err.killed = false;
            }
            callback(err, so, se);
        });
    }
    return child;
}

// execFile(file, args?, options?, callback): like exec but no shell splitting.
export function execFile(file, args, options, callback) {
    if (typeof args === "function") { callback = args; args = []; options = {}; }
    else if (typeof options === "function") { callback = options; options = {}; }
    args = args || [];
    options = options || {};
    const shArgs = ["-c", 'exec "$0" "$@"', String(file)];
    for (let i = 0; i < args.length; i++) shArgs.push(String(args[i]));
    const res = _runCapture(shArgs, true);
    const enc = options.encoding;
    const child = _childProcess(res, enc);
    if (typeof callback === "function") {
        const cbEnc = (enc && enc !== "buffer") ? enc : "utf8";
        const so = _bytesToOutput(res.stdout, cbEnc);
        const se = _bytesToOutput(res.stderr, cbEnc);
        queueMicrotask(() => {
            let err = null;
            if (res.status !== 0) { err = new Error("Command failed: " + file); err.code = res.status; }
            callback(err, so, se);
        });
    }
    return child;
}

export function execFileSync(file, args, options) {
    return spawnSync(file, args || [], options).stdout;
}

export default { execSync, spawnSync, exec, execFile, execFileSync, spawn };
