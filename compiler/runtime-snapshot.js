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

// Snapshot contents include the assembler representation and the backend's
// code-generation cursors.  Bump this whenever either shape changes: old
// snapshots are not safe to append to because a restored prefix must be
// indistinguishable from one emitted by a fresh compiler.
// Compiler emitter modules are part of the snapshotted runtime as well.  A
// snapshot built with an older `compiler/functions/*` (or context/expressions)
// can otherwise be restored after those files change, so the self-hosted
// engine executes stale lowering code and bootstrap failures become
// non-reproducible.  Bump the format and include the whole compiler tree in
// the manifest below.
const SNAPSHOT_VERSION = 52;
const snapshots = new Map();
const TOOLCHAIN_DIRS = ["runtime", "asm", "backend", "vm", "engine", "compiler"];
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
    // Every variable below is read while generateEntry()/generateRuntime()
    // emits the snapshotted prefix.  Omitting one lets a diagnostic/GC build
    // reuse a prefix emitted with different instructions or data labels.
    return [
        "NO_IC", "NOCTX", "ALLOC_DBG", "GEN_DBG", "P1_ON", "P1_OFF", "P1_STATS",
        "ASMJS_WASM_SEG", "ASMJS_FULL_FIXUP",
        "GC_SHADOW", "GC_DISABLE", "GC_THRESHOLD", "GC_FULLONLY",
        "GC_SHADOW_BISECT", "GC_DIAG", "GC_POISON", "GC_STATS", "ASMJS_IC_STATS",
    ]
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
    // Keep the directory component short enough for the temporary sibling
    // (`<dir>.tmp-<pid>`) and metadata filenames.  Diagnostic/GC flags make a
    // readable key exceed macOS NAME_MAX; retain a prefix for inspection and a
    // deterministic FNV-1a suffix for collision resistance.
    if (safe.length > 180) {
        let hash = 2166136261;
        for (let i = 0; i < key.length; i++) {
            hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
        }
        safe = safe.slice(0, 160) + "_" + hash.toString(16);
    }
    return path.join(base, safe);
}

function captureCompiler(compiler) {
    const asm = {};
    for (const name of Object.keys(compiler.asm)) asm[name] = clone(compiler.asm[name]);
    // The backend is intentionally not cloned wholesale (it owns the live VM
    // and assembler).  These are the small pieces of mutable codegen state
    // that affect labels, stack homes, or the interpretation of a following
    // instruction.  Keeping the list explicit avoids serialising static ABI
    // maps and makes the snapshot format stable across backend refactors.
    const backendState = {};
    const backend = compiler.vm && compiler.vm.backend;
    const backendFields = ["s5StackOffset", "_fmodSeq", "_cmpFloat", "_pairPush"];
    if (backend) {
        for (const name of backendFields) {
            if (Object.prototype.hasOwnProperty.call(backend, name)) {
                backendState[name] = clone(backend[name]);
            }
        }
    }
    return {
        asm,
        backendState,
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
    const wantsByteData = !!compiler.asm._byteData;
    const hadData = Object.prototype.hasOwnProperty.call(compiler.asm, "data");
    const hadDataSection = Object.prototype.hasOwnProperty.call(compiler.asm, "dataSection");
    const dataSectionAliased = hadData && hadDataSection &&
        compiler.asm.data === compiler.asm.dataSection;
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

    // ARM64 stores data in ByteBuffer, while x64/wasm32 use number[].  Disk
    // snapshots carry a Uint8Array payload and decode it as a plain array;
    // restore the representation expected by the live assembler before the
    // program-specific data labels are appended.  Conversely, don't leave a
    // synthetic `data` property on x64, whose assembler uses dataSection until
    // finalisation.
    if (wantsByteData && compiler.asm.data && !compiler.asm.data._asmjsByteBuffer) {
        compiler.asm.data = ByteBuffer.fromBytes(compiler.asm.data);
        compiler.asm._byteData = true;
    } else if (!wantsByteData && compiler.asm.data && compiler.asm.data._asmjsByteBuffer) {
        const bytes = compiler.asm.data.slice();
        const arr = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes[i];
        compiler.asm.data = arr;
        if (!Object.prototype.hasOwnProperty.call(compiler.asm, "_byteData")) {
            delete compiler.asm._byteData;
        } else {
            compiler.asm._byteData = false;
        }
    }
    if (!hadData && !wantsByteData && Object.prototype.hasOwnProperty.call(compiler.asm, "data") &&
        (!compiler.asm.data || compiler.asm.data.length === 0)) {
        delete compiler.asm.data;
    }
    // Wasm's dataSection is a deliberate alias of data.  clone() breaks that
    // identity, which would make later addData* calls invisible to consumers
    // reading the other name.
    if (dataSectionAliased && compiler.asm.data && compiler.asm.dataSection) {
        compiler.asm.dataSection = compiler.asm.data;
    }

    const backend = compiler.vm && compiler.vm.backend;
    const backendState = snapshot.backendState || {};
    if (backend) {
        for (const name of Object.keys(backendState)) {
            backend[name] = clone(backendState[name]);
        }
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
        backendState: snapshot.backendState || {},
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
        backendState: meta.backendState || {},
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
    // ByteBuffer is array-like only through get()/slice(); Uint8Array.from on
    // it silently produces zeroes because it has no numeric properties.  Use
    // the same byte extraction as the code path so ARM64 data constants survive
    // a disk round-trip as well.
    const data = dataSrc && dataSrc._asmjsByteBuffer && dataSrc.slice
        ? dataSrc.slice()
        : dataSrc instanceof Uint8Array ? dataSrc : Uint8Array.from(dataSrc);
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
    // Native self-hosted CLIs are single-build processes: process.release is
    // absent, so they cannot load/save the disk cache and will never reuse the
    // module-level snapshot before exit. Deep-cloning the full assembler here
    // only exercises self-hosted Map iterator/destructuring while committing
    // gen2, which can recurse until stack exhaustion. _commitRuntimeSnapshot
    // has already resolved runtime fixups and marked the boundary before this
    // call, so skipping the otherwise-dead copy preserves generated output.
    if (!process.release) return;
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
