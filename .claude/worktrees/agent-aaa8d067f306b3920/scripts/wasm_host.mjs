#!/usr/bin/env node
// asm.js wasm 宿主 shim(M2):node 下运行 `--target wasm32-wasi` 产物。
//   node scripts/wasm_host.mjs <program.wasm> [args...]
// 提供 env.__syscall(num, a0..a5) -> i64。号名空间 = linux-x64(设计文档 §2);
// 兼容层同时接受 macos-x64 别名号(0x2000000|n)——runtime 尚存少量 per-os 三元
// 在 wasi 下落 macos 分支,双号名空间让泄漏点先能跑、再逐个收敛。
// 未知号:响亮报错(带号与六参),用于定位 runtime 泄漏点。
// M2:_start 前按 POSIX 初始栈形状把 argv/env 写进递交区(WASM_ARGV_BASE=0x10000,
// 与 binary/wasm.js 一致):[+0]=argc,[+16]=argv 指针数组+NULL+envp 指针数组+NULL+串。
// fs 面:open/openat/read/close/unlink/chmod/mkdir/rmdir 直落 node fs;getrandom 落 crypto。

import fs from "node:fs";
import { randomFillSync } from "node:crypto";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// [M3] 分段模型(每段 ≤256 标签)下 V8 tier-up 稳定且显著更快(GC 基准 45s→35s),
// 缺省放行 V8 默认分层。ASMJS_WASM_LIFTOFF=1 可诊断性钉回 Liftoff-only(M1 巨函数
// 时代 Turboshaft 对数千前驱的派发 loop 头做每块快照合并 → Zone OOM,该模式是当时
// 的强制取舍;V8 启动后冻结旗标,只能带 CLI 旗标自我重启一次,守卫环境变量防递归)。
if (!process.env.ASMJS_WASM_HOST_CHILD && process.env.ASMJS_WASM_LIFTOFF) {
    const self = fileURLToPath(import.meta.url);
    const res = spawnSync(process.execPath, ["--no-wasm-tier-up", "--no-wasm-dynamic-tiering", self, ...process.argv.slice(2)], {
        stdio: "inherit",
        env: { ...process.env, ASMJS_WASM_HOST_CHILD: "1" },
    });
    process.exit(res.status === null ? 134 : res.status);
}

const HEAP_FLOOR = 0x8000000;  // 与 binary/wasm.js WASM_HEAP_FLOOR 一致
const ARGV_BASE = 0x10000;     // 与 binary/wasm.js WASM_ARGV_BASE 一致
const ARGV_REGION_CAP = 0x30000; // 递交区字节预算(超出先砍 env,argv 必保)
const PAGE = 65536;

const file = process.argv[2];
if (!file) {
    console.error("usage: node scripts/wasm_host.mjs <program.wasm> [args...]");
    process.exit(2);
}
const progArgs = process.argv.slice(3);

let memory = null;
let arenaPtr = HEAP_FLOOR;
const trace = !!process.env.ASMJS_WASM_TRACE;

function ensureMemory(byteEnd) {
    const cur = memory.buffer.byteLength;
    if (byteEnd > cur) {
        const pages = Math.ceil((byteEnd - cur) / PAGE);
        memory.grow(pages);
    }
}

function writeI64(addr, value) {
    new DataView(memory.buffer).setBigInt64(addr, BigInt(value), true);
}

// 读 NUL 终止 C 串
function readCString(ptr) {
    const u8 = new Uint8Array(memory.buffer);
    let end = ptr;
    while (end < u8.length && u8[end] !== 0) end++;
    return Buffer.from(memory.buffer, ptr, end - ptr).toString("utf8");
}

// ---- argv/env 递交区(POSIX 初始栈形状;envp = argv+(argc+1)*8 天然成立) ----
function writeArgvRegion() {
    const args = [file, ...progArgs];
    const envPairs = [];
    for (const k of Object.keys(process.env)) {
        const v = process.env[k];
        if (typeof v === "string") envPairs.push(k + "=" + v);
    }

    const enc = new TextEncoder();
    const argBytes = args.map((s) => enc.encode(s));
    const envBytes = envPairs.map((s) => enc.encode(s));

    // 预算:指针区 + 串区 <= CAP;超出从尾砍 env(argv 必保)
    const ptrBytes = () => 16 + (argBytes.length + 1 + envBytes.length + 1) * 8;
    const strBytes = (list) => list.reduce((n, b) => n + b.length + 1, 0);
    while (envBytes.length > 0 && ptrBytes() + strBytes(argBytes) + strBytes(envBytes) > ARGV_REGION_CAP) {
        envBytes.pop();
    }

    const u8 = new Uint8Array(memory.buffer);
    writeI64(ARGV_BASE, args.length);
    const argvArr = ARGV_BASE + 16;
    const envpArr = argvArr + (argBytes.length + 1) * 8;
    let strPtr = envpArr + (envBytes.length + 1) * 8;
    const put = (arrBase, i, bytes) => {
        writeI64(arrBase + i * 8, strPtr);
        u8.set(bytes, strPtr);
        u8[strPtr + bytes.length] = 0;
        strPtr += bytes.length + 1;
    };
    for (let i = 0; i < argBytes.length; i++) put(argvArr, i, argBytes[i]);
    writeI64(argvArr + argBytes.length * 8, 0); // argv[argc] = NULL
    for (let i = 0; i < envBytes.length; i++) put(envpArr, i, envBytes[i]);
    writeI64(envpArr + envBytes.length * 8, 0); // envp 终止
    if (trace) console.error(`[wasm host] argv=${args.length} env=${envBytes.length} strEnd=0x${strPtr.toString(16)}`);
}

// ---- fs:linux O_* 位 → 宿主 node flags ----
const L_O_CREAT = 0x40, L_O_EXCL = 0x80, L_O_TRUNC = 0x200, L_O_APPEND = 0x400;
function hostFlags(lflags) {
    const c = fs.constants;
    let f = lflags & 2 ? c.O_RDWR : lflags & 1 ? c.O_WRONLY : c.O_RDONLY;
    if (lflags & L_O_CREAT) f |= c.O_CREAT;
    if (lflags & L_O_EXCL) f |= c.O_EXCL;
    if (lflags & L_O_TRUNC) f |= c.O_TRUNC;
    if (lflags & L_O_APPEND) f |= c.O_APPEND;
    return f;
}

function errno(e) {
    // 常见 errno 粗映射(linux 值),其余 -1
    const m = { ENOENT: -2, EACCES: -13, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EBADF: -9, ENOTEMPTY: -39 };
    return BigInt(m[e.code] !== undefined ? m[e.code] : -1);
}

function sysOpen(pathPtr, lflags, mode) {
    const p = readCString(pathPtr);
    try {
        const fd = fs.openSync(p, hostFlags(lflags), mode & 0o7777);
        if (trace) console.error(`[wasm open] ${p} flags=0x${lflags.toString(16)} -> fd ${fd}`);
        return BigInt(fd);
    } catch (e) {
        if (trace) console.error(`[wasm open] ${p} -> ${e.code}`);
        return errno(e);
    }
}

function sysRead(fd, ptr, len) {
    try {
        return BigInt(fs.readSync(fd, new Uint8Array(memory.buffer, ptr, len)));
    } catch (e) {
        return errno(e);
    }
}

function sysWrite(fd, ptr, len) {
    if (len <= 0) return 0n;
    try {
        return BigInt(fs.writeSync(fd, Buffer.from(memory.buffer, ptr, len)));
    } catch (e) {
        return errno(e);
    }
}

function sysClose(fd) {
    if (fd <= 2) return 0n; // 标准流不真关(宿主复用)
    try {
        fs.closeSync(fd);
        return 0n;
    } catch (e) {
        return errno(e);
    }
}

function sysPathOp(fn, pathPtr, arg) {
    const p = readCString(pathPtr);
    try {
        fn(p, arg);
        return 0n;
    } catch (e) {
        return errno(e);
    }
}

function sysMmap(hint, len) {
    // arena bump:hint 恰为 arena 尾时原地给(保住分配器连续增长快路),否则给 arena 尾。
    const base = hint !== 0 && hint === arenaPtr ? hint : arenaPtr;
    const alignedLen = Math.ceil(len / PAGE) * PAGE;
    arenaPtr = base + alignedLen;
    ensureMemory(arenaPtr);
    if (trace) console.error(`[wasm mmap] hint=0x${hint.toString(16)} len=0x${len.toString(16)} -> 0x${base.toString(16)}`);
    return BigInt(base);
}

function sysGettimeofday(ptr) {
    const ms = Date.now();
    writeI64(ptr, Math.floor(ms / 1000));
    writeI64(ptr + 8, (ms % 1000) * 1000);
    return 0n;
}

function sysClockGettime(clockid, ptr) {
    const ms = Date.now();
    writeI64(ptr, Math.floor(ms / 1000));
    writeI64(ptr + 8, (ms % 1000) * 1000000);
    return 0n;
}

function sysGetrandom(ptr, len) {
    if (len > 0) randomFillSync(new Uint8Array(memory.buffer, ptr, len));
    return BigInt(len);
}

function syscall(num, a0, a1, a2, a3, a4, a5) {
    let n = Number(num);
    // macos-x64 别名号(0x2000000|n)兼容:泄漏点收敛前的容错网
    const MAC = 0x2000000;
    if (n === (MAC | 4)) n = 1;          // write
    else if (n === (MAC | 1)) n = 60;    // exit
    else if (n === (MAC | 3)) n = 0;     // read
    else if (n === (MAC | 5)) n = 2;     // open
    else if (n === (MAC | 6)) n = 3;     // close
    else if (n === (MAC | 10)) n = 87;   // unlink
    else if (n === (MAC | 15)) n = 90;   // chmod
    else if (n === (MAC | 136)) n = 83;  // mkdir
    else if (n === (MAC | 137)) n = 84;  // rmdir
    else if (n === (MAC | 0xc5)) n = 9;  // mmap
    else if (n === (MAC | 0x49)) n = 11; // munmap
    else if (n === (MAC | 74)) n = 10;   // mprotect
    else if (n === (MAC | 0x74)) n = 96; // gettimeofday
    else if (n === (MAC | 500)) n = 318; // getentropy(buf,len):形参前二与 getrandom 同

    if (trace) console.error(`[wasm syscall] ${n}(${a0}, ${a1}, ${a2}, ${a3}, ${a4}, ${a5})`);

    switch (n) {
        case 0: // read(fd, buf, len)
            return sysRead(Number(a0), Number(a1), Number(a2));
        case 1: // write(fd, buf, len)
            return sysWrite(Number(a0), Number(a1), Number(a2));
        case 2: // open(path, flags, mode)
            return sysOpen(Number(a0), Number(a1), Number(a2));
        case 257: // openat(dirfd, path, flags, mode) — 仅 AT_FDCWD 语义
            return sysOpen(Number(a1), Number(a2), Number(a3));
        case 3: // close(fd)
            return sysClose(Number(a0));
        case 87: // unlink(path)
            return sysPathOp((p) => fs.unlinkSync(p), Number(a0));
        case 90: // chmod(path, mode)
            return sysPathOp((p, m) => fs.chmodSync(p, m & 0o7777), Number(a0), Number(a1));
        case 83: // mkdir(path, mode)
            return sysPathOp((p, m) => fs.mkdirSync(p, { mode: m & 0o7777 }), Number(a0), Number(a1));
        case 84: // rmdir(path)
            return sysPathOp((p) => fs.rmdirSync(p), Number(a0));
        case 318: // getrandom(buf, len, flags)
            return sysGetrandom(Number(a0), Number(a1));
        case 9: // mmap(addr, len, prot, flags, fd, off)
            return sysMmap(Number(a0), Number(a1));
        case 10: // mprotect — wasm 无 W^X 概念
        case 11: // munmap — arena 不回收
            return 0n;
        case 60: // exit
        case 231: // exit_group
            process.exit(Number(a0));
            return 0n;
        case 96: // gettimeofday(tv, tz)
            return sysGettimeofday(Number(a0));
        case 228: // clock_gettime(clk, ts)
            return sysClockGettime(Number(a0), Number(a1));
        default:
            throw new Error(
                `asm.js wasm host: unimplemented syscall ${n} (0x${n.toString(16)}) args=[${a0}, ${a1}, ${a2}, ${a3}, ${a4}, ${a5}] — runtime os-branch leak? see docs/WASM_DESIGN.md`
            );
    }
}

const bytes = fs.readFileSync(file);
const t0 = Date.now();
const { instance } = await WebAssembly.instantiate(bytes, {
    env: { __syscall: syscall },
});
memory = instance.exports.memory;
writeArgvRegion();
if (trace) console.error(`[wasm host] instantiated in ${Date.now() - t0}ms, memory=${memory.buffer.byteLength >> 16} pages`);

try {
    instance.exports._start();
} catch (e) {
    // process.exit 在 syscall 里直接退;走到这的是真异常(trap 等)
    console.error("asm.js wasm host: trap:", e && e.message ? e.message : e);
    if (e && e.stack && trace) console.error(e.stack);
    process.exit(134);
}
