// Go $GOROOT/pkg 语义的 toolchain runtime 快照：按 (target, codegenEnv, SYM ABI,
// runtime/asm/backend/vm 源 mtime) 版本化。这不是用户 action-cache——
// ASMJS_CACHE=0 / --no-cache 不得关闭它。命中时跳过 generateEntry/generateRuntime
// 的全量 JS codegen，恢复 assembler 前缀后继续追加 program-specific 后缀。
//
// 不采用 runtime.a 整段拼接：单缓冲 + 最终地址 fixup + 动态 _data_gc_end
// 仍走现有 fixupAll。快照只跳过 runtime codegen，并预解析 runtime→runtime 分支。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ByteBuffer } from "../asm/byte-buffer.js";
import { FixupBuffer } from "../asm/fixup-buffer.js";
import { SYM_NAMES } from "../engine/symbols.js";

const SNAPSHOT_VERSION = 42;
const snapshots = new Map();
const TOOLCHAIN_DIRS = ["runtime", "asm", "backend", "vm", "engine"];
const TOOLCHAIN_FILES = ["compiler/index.js", "compiler/runtime-snapshot.js"];

function clone(value) {
    if (value && value._asmjsByteBuffer && value.clone) return value.clone();
    if (value && value._asmjsFixupBuffer && value.clone) return value.clone();
    if (Array.isArray(value)) return value.map(clone);
    if (value instanceof Map) {
        const out = new Map();
        for (const [key, item] of value) out.set(clone(key), clone(item));
        return out;
    }
    if (value instanceof Set) {
        const out = new Set();
        for (const item of value) out.add(clone(item));
        return out;
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value)) out[key] = clone(value[key]);
        return out;
    }
    return value;
}

function codegenFlags(env) {
    return ["NO_IC", "NOCTX", "ALLOC_DBG", "GEN_DBG", "P1_ON", "P1_OFF", "P1_STATS"]
        .map((name) => name + "=" + (env[name] || "")).join(",");
}

export function runtimeSnapshotKey(compiler, env = process.env) {
    const last = SYM_NAMES.length ? SYM_NAMES[SYM_NAMES.length - 1] : "";
    return SNAPSHOT_VERSION + "|" + compiler.target + "|" + codegenFlags(env) +
        "|" + SYM_NAMES.length + "|" + last;
}

function repositoryRoot() {
    if (fs.existsSync(path.resolve(process.cwd(), "runtime"))) return process.cwd();
    try {
        let url = import.meta.url;
        if (typeof url === "string" && url.indexOf("file://") === 0) url = url.slice(7);
        if (url) return path.dirname(path.dirname(url));
    } catch (_e) { /* import.meta 在自举产物里不可靠 */ }
    return process.cwd();
}

function listFilesRecursive(dir, output, prefix) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const rel = prefix ? prefix + "/" + entry.name : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) listFilesRecursive(full, output, rel);
        else if (entry.isFile()) output.push({ full, relative: rel });
    }
}

function toolchainManifest(root) {
    const files = [];
    for (let i = 0; i < TOOLCHAIN_DIRS.length; i++) {
        listFilesRecursive(path.join(root, TOOLCHAIN_DIRS[i]), files, TOOLCHAIN_DIRS[i]);
    }
    for (let i = 0; i < TOOLCHAIN_FILES.length; i++) {
        const rel = TOOLCHAIN_FILES[i];
        const full = path.join(root, rel);
        if (fs.existsSync(full)) files.push({ full, relative: rel });
    }
    files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
    const lines = [];
    for (let i = 0; i < files.length; i++) {
        const st = fs.statSync(files[i].full);
        lines.push(files[i].relative + "\t" + st.size + "\t" + Math.floor(st.mtimeMs));
    }
    return lines.join("\n");
}

function toolchainDir(env, key) {
    const base = env.ASMJS_TOOLCHAIN_DIR
        ? path.resolve(env.ASMJS_TOOLCHAIN_DIR)
        : path.join(env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), ".cache"),
            "asm.js", "toolchain-runtime-v2");
    // 工具链禁正则字面量(见 assignments.js TDZ 消息同因)。
    let safe = "";
    for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
            c === 46 || c === 95 || c === 45;
        safe += ok ? key.charAt(i) : "_";
    }
    return path.join(base, safe);
}

function captureCompiler(compiler) {
    const asm = {};
    for (const name of Object.keys(compiler.asm)) asm[name] = clone(compiler.asm[name]);
    return {
        asm,
        ctxLabelCounter: compiler.ctx.labelCounter,
        compilerLabelCounter: compiler.labelCounter,
    };
}

function applyCompiler(compiler, snapshot) {
    // 磁盘 decodeSnapshot 把 code 解成 ByteBuffer。arm64 汇编器本身就是
    // ByteBuffer(_byteCode); x64/wasm32 用 number[] 下标读写(fixupAll 写
    // this.code[offset]=…)。若把 ByteBuffer 套上去,下标赋值只变成对象自有
    // 属性,slice()/ELF 导出读不到 —— 产物只剩 displacement 槽,linux-x64
    // 二次编译 _start 前几字节全 0 → 入口即 SIGSEGV。须在覆盖 _byteCode
    // 之前记下活汇编器形态,再把 ByteBuffer 摊回 number[]。
    const wantsByteCode = !!compiler.asm._byteCode;
    for (const name of Object.keys(snapshot.asm)) compiler.asm[name] = clone(snapshot.asm[name]);
    compiler.ctx.labelCounter = snapshot.ctxLabelCounter;
    compiler.labelCounter = snapshot.compilerLabelCounter;
    if (!wantsByteCode && compiler.asm.code && compiler.asm.code._asmjsByteBuffer) {
        const bytes = compiler.asm.code.slice();
        const arr = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes[i];
        compiler.asm.code = arr;
        compiler.asm._byteCode = false;
    }
}

function encodeMeta(snapshot) {
    const asm = {};
    for (const name of Object.keys(snapshot.asm)) {
        if (name === "code" || name === "data") continue;
        const value = snapshot.asm[name];
        if (typeof value === "function") continue;
        if (value && value._asmjsFixupBuffer) {
            asm[name] = { kind: "fixups", items: value.slice() };
            continue;
        }
        if (value instanceof Map) {
            asm[name] = { kind: "Map", entries: Array.from(value.entries()) };
            continue;
        }
        if (value instanceof Set) {
            asm[name] = { kind: "Set", values: Array.from(value.values()) };
            continue;
        }
        asm[name] = { kind: "json", value };
    }
    return {
        version: SNAPSHOT_VERSION,
        ctxLabelCounter: snapshot.ctxLabelCounter,
        compilerLabelCounter: snapshot.compilerLabelCounter,
        asm,
    };
}

function decodeSnapshot(meta, codeBytes, dataBytes) {
    const asm = {};
    asm.code = ByteBuffer.fromBytes(codeBytes);
    asm._byteCode = true;
    const data = [];
    for (let i = 0; i < dataBytes.length; i++) data.push(dataBytes[i]);
    asm.data = data;
    const encoded = meta.asm || {};
    for (const name of Object.keys(encoded)) {
        const item = encoded[name];
        if (!item || !item.kind) continue;
        if (item.kind === "fixups") {
            const buf = new FixupBuffer();
            const items = item.items || [];
            for (let i = 0; i < items.length; i++) buf.push(items[i]);
            asm[name] = buf;
        } else if (item.kind === "Map") {
            asm[name] = new Map(item.entries || []);
        } else if (item.kind === "Set") {
            asm[name] = new Set(item.values || []);
        } else {
            asm[name] = item.value;
        }
    }
    return {
        asm,
        ctxLabelCounter: meta.ctxLabelCounter,
        compilerLabelCounter: meta.compilerLabelCounter,
    };
}

function loadDiskSnapshot(compiler, key, env) {
    if (!process.release) return null;
    const dir = toolchainDir(env, key);
    const manifestPath = path.join(dir, "manifest.txt");
    const metaPath = path.join(dir, "meta.json");
    const codePath = path.join(dir, "code.bin");
    const dataPath = path.join(dir, "data.bin");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(metaPath) ||
        !fs.existsSync(codePath) || !fs.existsSync(dataPath)) return null;
    const expected = toolchainManifest(repositoryRoot());
    const actual = fs.readFileSync(manifestPath, "utf8");
    if (actual !== expected) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (!meta || meta.version !== SNAPSHOT_VERSION) return null;
    const codeBytes = new Uint8Array(fs.readFileSync(codePath));
    const dataBytes = new Uint8Array(fs.readFileSync(dataPath));
    return decodeSnapshot(meta, codeBytes, dataBytes);
}

function saveDiskSnapshot(compiler, key, snapshot, env) {
    if (!process.release) return;
    const dir = toolchainDir(env, key);
    fs.mkdirSync(dir, { recursive: true });
    const code = snapshot.asm.code && snapshot.asm.code.slice
        ? snapshot.asm.code.slice()
        : new Uint8Array(0);
    const dataSrc = snapshot.asm.data || [];
    const data = dataSrc instanceof Uint8Array ? dataSrc : Uint8Array.from(dataSrc);
    const tmp = dir + ".tmp-" + process.pid;
    fs.mkdirSync(tmp, { recursive: true });
    try {
        fs.writeFileSync(path.join(tmp, "manifest.txt"), toolchainManifest(repositoryRoot()));
        fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify(encodeMeta(snapshot)));
        fs.writeFileSync(path.join(tmp, "code.bin"), Buffer.from(code));
        fs.writeFileSync(path.join(tmp, "data.bin"), Buffer.from(data));
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* 首次写入无旧目录 */ }
        fs.renameSync(tmp, dir);
    } catch (_e) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e2) { /* best effort */ }
    }
}

export function restoreRuntimeSnapshot(compiler, key) {
    let snapshot = snapshots.get(key);
    if (!snapshot) {
        try { snapshot = loadDiskSnapshot(compiler, key, process.env); }
        catch (_e) { snapshot = null; }
        if (snapshot) snapshots.set(key, snapshot);
    }
    if (!snapshot) return false;
    applyCompiler(compiler, snapshot);
    return true;
}

export function saveRuntimeSnapshot(compiler, key) {
    const snapshot = captureCompiler(compiler);
    snapshots.set(key, snapshot);
    try { saveDiskSnapshot(compiler, key, snapshot, process.env); }
    catch (_e) { /* 磁盘失败不影响本次编译 */ }
}

export function resolveRuntimeCodeFixups(asm) {
    if (!asm.pendingFixups || !asm.resolveLabel) return;
    const getCode = (offset) => asm.code && asm.code._asmjsByteBuffer
        ? asm.code.get(offset) : asm.code[offset];
    const write32 = (offset, word) => {
        if (asm.code && asm.code._asmjsByteBuffer) {
            asm.code.write32(offset, word);
            return;
        }
        asm.code[offset] = word & 255;
        asm.code[offset + 1] = (word >> 8) & 255;
        asm.code[offset + 2] = (word >> 16) & 255;
        asm.code[offset + 3] = (word >> 24) & 255;
    };
    const packedFixups = !!asm.pendingFixups._asmjsFixupBuffer;
    const fixups = packedFixups ? asm.pendingFixups.slice() : asm.pendingFixups;
    const remaining = packedFixups ? new asm.pendingFixups.constructor() : [];
    for (const fixup of fixups) {
        if (fixup.type !== "b" && fixup.type !== "bl" &&
            fixup.type !== "cbz" && fixup.type !== "cbnz" && fixup.type !== "adr") {
            remaining.push(fixup);
            continue;
        }
        const target = asm.labels.get(asm.resolveLabel(fixup.label));
        if (target === undefined) {
            remaining.push(fixup);
            continue;
        }
        const delta = target - fixup.offset;
        let word;
        if (fixup.type === "b" || fixup.type === "bl") {
            word = (fixup.type === "bl" ? 2483027968 : 335544320) |
                ((delta / 4) & 67108863);
        } else if (fixup.type === "cbz" || fixup.type === "cbnz") {
            const rt = getCode(fixup.offset) & 31;
            word = (fixup.type === "cbz" ? 0xb4000000 : 0xb5000000) |
                (((delta / 4) & 524287) << 5) | rt;
        } else {
            const adrDelta = target - (fixup.offset + 4);
            word = 0x10000000 | (((adrDelta >> 2) & 524287) << 5) |
                ((adrDelta & 3) << 22) | (getCode(fixup.offset) & 31);
        }
        write32(fixup.offset, word);
    }
    asm.pendingFixups = remaining;
}

export function markRuntimeBoundary(asm) {
    if (!asm) return;
    asm._runtimeCodeEnd = asm.code ? asm.code.length : 0;
    asm._runtimeDataEnd = asm.data ? asm.data.length : 0;
    asm._runtimeFixupCount = asm.pendingFixups ? asm.pendingFixups.length : 0;
}

export function clearRuntimeSnapshots() {
    snapshots.clear();
}
