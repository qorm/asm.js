import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "node:crypto";

const BUILD_INPUT_DIRS = ["compiler", "runtime", "asm", "backend", "binary", "engine", "lang", "vm"];
const BUILD_INPUT_FILES = ["cli.js", "package.json"];
const CODEGEN_ENV_NAMES = new Set(["NO_IC", "NOCTX", "ALLOC_DBG", "GEN_DBG", "P1_ON", "P1_OFF", "P1_STATS"]);

function sha256(parts) {
    const hash = createHash("sha256");
    for (const part of parts) {
        if (Buffer.isBuffer(part)) hash.update(part);
        else hash.update(String(part));
        hash.update("\n");
    }
    return hash.digest("hex");
}

function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (value && typeof value === "object") {
        const result = {};
        for (const key of Object.keys(value).sort()) result[key] = stableObject(value[key]);
        return result;
    }
    return value;
}

function stableJson(value) {
    return JSON.stringify(stableObject(value));
}

function listFilesRecursive(root, dir, output, excludedDirectories) {
    const absoluteDir = path.resolve(dir);
    if (excludedDirectories && excludedDirectories.some((excluded) =>
        absoluteDir === excluded || absoluteDir.startsWith(excluded + path.sep))) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) listFilesRecursive(root, full, output, excludedDirectories);
        else if (entry.isFile()) output.push({ full, relative: path.relative(root, full) });
    }
}

function listCompilerBuildFiles(repositoryRoot, excludedDirectory) {
    const root = path.resolve(repositoryRoot);
    const excluded = excludedDirectory
        ? ["actions", "entries", "tmp"].map((name) => path.join(path.resolve(excludedDirectory), name))
        : [];
    const files = [];
    for (const dir of BUILD_INPUT_DIRS) listFilesRecursive(root, path.join(root, dir), files, excluded);
    for (const name of BUILD_INPUT_FILES) {
        const full = path.join(root, name);
        if (fs.existsSync(full)) files.push({ full, relative: name });
    }
    files.sort((a, b) => a.relative.localeCompare(b.relative));
    return { root, excludedKey: excludedDirectory ? path.resolve(excludedDirectory) : "", files };
}

function compilerTreeStamp(files) {
    const parts = [];
    for (let i = 0; i < files.length; i++) {
        const st = fs.statSync(files[i].full);
        parts.push(files[i].relative, String(st.size), String(Math.floor(st.mtimeMs)));
    }
    return parts.join("\n");
}

// 内容哈希在改文件后必须变;进程内只按 size+mtime 戳复用,避免 test262
// 每个用例把 compiler/runtime/lang/vm 整树再读一遍(冷编墙钟里可占十几毫秒×2)。
const buildIdMemo = { root: "", excludedKey: "", stamp: "", id: "" };

function codegenEnvironment(env) {
    const result = {};
    for (const name of Object.keys(env).sort()) {
        if (CODEGEN_ENV_NAMES.has(name) || name.startsWith("GC_") ||
            (name.startsWith("ASMJS_") && name !== "ASMJS_CACHE_DIR" &&
             name !== "ASMJS_CACHE" && name !== "ASMJS_CACHE_STATUS_FILE" &&
             name !== "ASMJS_SHIM_DEBUG")) {
            result[name] = env[name];
        }
    }
    return result;
}

function defaultCacheDirectory(env) {
    if (env.ASMJS_CACHE_DIR) return path.resolve(env.ASMJS_CACHE_DIR);
    const base = env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), ".cache");
    return path.join(base, "asm.js", "action-cache-v1");
}

function atomicWriteFile(filename, data, mode) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temp = path.join(path.dirname(filename),
        "." + path.basename(filename) + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2));
    try {
        fs.writeFileSync(temp, data, mode === undefined ? undefined : { mode });
        fs.renameSync(temp, filename);
    } finally {
        try { fs.rmSync(temp, { force: true }); } catch (_) { /* best effort */ }
    }
}

function readJson(filename) {
    try {
        return JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (_) {
        return null;
    }
}

function packageConfigProbes(inputPaths) {
    const probes = new Set();
    for (const inputPath of inputPaths) {
        let dir = path.dirname(path.resolve(inputPath));
        while (true) {
            probes.add(path.join(dir, "package.json"));
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return Array.from(probes).sort();
}

function snapshotFile(filename, suppliedContent) {
    const absolute = path.resolve(filename);
    if (suppliedContent !== undefined) {
        const content = Buffer.isBuffer(suppliedContent)
            ? suppliedContent
            : Buffer.from(String(suppliedContent), "latin1");
        return { path: absolute, exists: true, hash: sha256([content]) };
    }
    try {
        const content = fs.readFileSync(absolute);
        return { path: absolute, exists: true, hash: sha256([content]) };
    } catch (error) {
        if (error && error.code === "ENOENT") return { path: absolute, exists: false, hash: null };
        throw error;
    }
}

function inputsStillMatch(inputs) {
    try {
        for (const input of inputs) {
            // 虚拟入口的内容 hash 已进入 request/action ID；它没有可重读的宿主路径。
            if (input.virtual === true) continue;
            const current = snapshotFile(input.path);
            if (current.exists !== input.exists || current.hash !== input.hash) return false;
        }
        return true;
    } catch (_) {
        return false;
    }
}

function sleepSync(ms) {
    // ActionCache 的公共 API 是同步的；Atomics.wait 避免 busy-loop。
    const cell = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(cell, 0, 0, ms);
}

export function computeCompilerBuildId(repositoryRoot, excludedDirectory) {
    const listed = listCompilerBuildFiles(repositoryRoot, excludedDirectory);
    const stamp = compilerTreeStamp(listed.files);
    if (buildIdMemo.id && buildIdMemo.root === listed.root &&
        buildIdMemo.excludedKey === listed.excludedKey && buildIdMemo.stamp === stamp) {
        return buildIdMemo.id;
    }
    const parts = ["asm.js-compiler-build-v1"];
    for (let i = 0; i < listed.files.length; i++) {
        parts.push(listed.files[i].relative, fs.readFileSync(listed.files[i].full));
    }
    const id = sha256(parts);
    buildIdMemo.root = listed.root;
    buildIdMemo.excludedKey = listed.excludedKey;
    buildIdMemo.stamp = stamp;
    buildIdMemo.id = id;
    return id;
}

export class ActionCache {
    constructor(options = {}) {
        this.repositoryRoot = path.resolve(options.repositoryRoot || process.cwd());
        this.environment = options.environment || process.env;
        this.cacheDirectory = path.resolve(options.cacheDirectory || defaultCacheDirectory(this.environment));
        // LABEL_MAP 是与本次汇编 label 表绑定的旁路产物；缓存二进制无法重建它。
        this.disabled = options.disabled === true || this.environment.ASMJS_CACHE === "0" ||
            !!this.environment.LABEL_MAP;
    }

    get buildId() {
        // 按 size+mtime 戳复用内容哈希;戳变则重读整树。daemon 改源码后下次
        // compile 会因 mtime 变化失效,不会再拿到过期 gen1。
        return computeCompilerBuildId(this.repositoryRoot, this.cacheDirectory);
    }

    _restore(requestKey, options) {
        const actionPath = path.join(this.cacheDirectory, "actions", requestKey + ".json");
        const action = readJson(actionPath);
        if (!action || action.version !== 1 || !inputsStillMatch(action.inputs || [])) return null;
        const entryDir = path.join(this.cacheDirectory, "entries", action.key);
        const artifacts = action.artifacts || [];
        if (artifacts.length !== options.outputFiles.length ||
            !artifacts.every((artifact) => {
                const filename = path.join(entryDir, artifact.file);
                if (!fs.existsSync(filename)) return false;
                if (!artifact.hash) return true;
                return sha256([fs.readFileSync(filename)]) === artifact.hash;
            })) return null;
        for (let i = 0; i < artifacts.length; i++) {
            const content = fs.readFileSync(path.join(entryDir, artifacts[i].file));
            atomicWriteFile(options.outputFiles[i], content, artifacts[i].mode);
            if (artifacts[i].mode !== undefined) fs.chmodSync(options.outputFiles[i], artifacts[i].mode);
        }
        return { hit: true, key: action.key, buildId: this.buildId, requestKey };
    }

    _acquireSingleflight(requestKey, options) {
        const locks = path.join(this.cacheDirectory, "locks");
        const lock = path.join(locks, requestKey);
        fs.mkdirSync(locks, { recursive: true });
        const deadline = Date.now() + Number(this.environment.ASMJS_CACHE_LOCK_TIMEOUT || 120000);
        while (true) {
            try {
                fs.mkdirSync(lock);
                fs.writeFileSync(path.join(lock, "owner"), String(process.pid));
                return { lock, restored: null };
            } catch (error) {
                if (!error || error.code !== "EEXIST") throw error;
                const restored = this._restore(requestKey, options);
                if (restored) return { lock: null, restored };
                try {
                    const age = Date.now() - fs.statSync(lock).mtimeMs;
                    if (age > 120000) {
                        fs.rmSync(lock, { recursive: true, force: true });
                        continue;
                    }
                } catch (_) { /* owner may be publishing/removing */ }
                if (Date.now() >= deadline) {
                    throw new Error("action cache singleflight timeout: " + requestKey);
                }
                sleepSync(10);
            }
        }
    }

    run(options) {
        if (this.disabled) {
            const result = options.compile();
            return { hit: false, disabled: true, key: null, buildId: null, requestKey: null, result };
        }
        const buildId = this.buildId;
        const physicalEntry = snapshotFile(options.inputFile);
        const requestEntry = options.inputIdentity
            ? { identity: String(options.inputIdentity), hash: physicalEntry.hash }
            : physicalEntry;
        const request = {
            version: 1,
            buildId,
            entry: requestEntry,
            target: options.target,
            outputType: options.outputType,
            outputName: options.outputIdentity || path.basename(options.outputFiles[0]),
            compilerOptions: options.compilerOptions || {},
            exports: options.exports || [],
            env: codegenEnvironment(this.environment),
        };
        const requestKey = sha256([stableJson(request)]);

        const restored = this._restore(requestKey, options);
        if (restored) return restored;

        let singleflightLock = null;
        const flight = this._acquireSingleflight(requestKey, options);
        if (flight.restored) return flight.restored;
        singleflightLock = flight.lock;
        // 锁获取前另一个进程可能刚发布完成。
        const restoredAgain = this._restore(requestKey, options);
        if (restoredAgain) {
            fs.rmSync(singleflightLock, { recursive: true, force: true });
            return restoredAgain;
        }

        let result;
        try {
            result = options.compile();
        } catch (error) {
            if (singleflightLock) fs.rmSync(singleflightLock, { recursive: true, force: true });
            throw error;
        }

        const compilerInputs = options.getInputs ? options.getInputs() : [];
        const byPath = new Map();
        for (const input of compilerInputs) {
            if (options.inputIdentity && path.resolve(input.path) === physicalEntry.path) continue;
            const snap = input.exists === false
                ? { path: path.resolve(input.path), exists: false, hash: null }
                : snapshotFile(input.path, input.content);
            byPath.set(snap.path, snap);
        }
        if (options.inputIdentity) {
            byPath.set("virtual:" + options.inputIdentity, {
                path: "virtual:" + String(options.inputIdentity),
                virtual: true,
                exists: true,
                hash: physicalEntry.hash,
            });
        } else if (!byPath.has(physicalEntry.path)) {
            byPath.set(physicalEntry.path, physicalEntry);
        }
        const realInputPaths = Array.from(byPath.values())
            .filter((input) => input.virtual !== true)
            .map((input) => input.path);
        for (const configPath of packageConfigProbes(realInputPaths)) {
            if (!byPath.has(configPath)) byPath.set(configPath, snapshotFile(configPath));
        }
        const inputs = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
        const key = sha256([stableJson({ request, inputs })]);
        const entryDir = path.join(this.cacheDirectory, "entries", key);
        const artifacts = [];

        fs.mkdirSync(path.join(this.cacheDirectory, "tmp"), { recursive: true });
        fs.mkdirSync(path.join(this.cacheDirectory, "entries"), { recursive: true });
        const tempDir = fs.mkdtempSync(path.join(this.cacheDirectory, "tmp", "publish-"));
        try {
            for (let i = 0; i < options.outputFiles.length; i++) {
                const source = options.outputFiles[i];
                const stat = fs.statSync(source);
                const file = "artifact-" + i;
                const content = fs.readFileSync(source);
                fs.writeFileSync(path.join(tempDir, file), content);
                artifacts.push({ file, mode: stat.mode & 0o777, hash: sha256([content]) });
            }
            atomicWriteFile(path.join(tempDir, "metadata.json"),
                stableJson({ version: 1, key, inputs, artifacts }) + "\n", 0o644);
            try {
                fs.renameSync(tempDir, entryDir);
            } catch (error) {
                if (!fs.existsSync(entryDir)) throw error;
                // 同 key 已存在通常表示并发发布；若它损坏/不完整，则逐文件原子修复。
                // 不能仅“目录存在即成功”，否则坏条目会永久 miss。
                for (const artifact of artifacts) {
                    const existing = path.join(entryDir, artifact.file);
                    let valid = false;
                    try {
                        valid = sha256([fs.readFileSync(existing)]) === artifact.hash;
                    } catch (_) { /* repair below */ }
                    if (!valid) {
                        atomicWriteFile(existing,
                            fs.readFileSync(path.join(tempDir, artifact.file)), artifact.mode);
                    }
                }
                atomicWriteFile(path.join(entryDir, "metadata.json"),
                    stableJson({ version: 1, key, inputs, artifacts }) + "\n", 0o644);
            }
        } finally {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        }

        const action = { version: 1, key, inputs, artifacts };
        atomicWriteFile(path.join(this.cacheDirectory, "actions", requestKey + ".json"),
            stableJson(action) + "\n", 0o644);
        if (singleflightLock) fs.rmSync(singleflightLock, { recursive: true, force: true });
        return { hit: false, key, buildId, requestKey, result };
    }
}

export function writeCacheStatus(filename, status) {
    if (!filename) return;
    atomicWriteFile(path.resolve(filename), stableJson(status) + "\n", 0o644);
}
