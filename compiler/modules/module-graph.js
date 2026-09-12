// compiler/modules/module-graph.js
// Import path resolution: bare node builtins, relative paths, package.json
// exports/main, and segment folding that does not depend on host path.normalize.
// Extracted from compiler/index.js (P2.c) with zero semantic change.
// These run inside gen1 — hand-written logic only, no regex literals.

import * as path from "path";
import { isBareModuleName, isBareSubpath } from "./cjs-named-exports.js";

export function normalizeNodeModuleName(importSource) {
    if (!importSource) return "";
    return importSource.startsWith("node:") ? importSource.slice(5) : importSource;
}

// [#67] 编译器自身所在目录 <root>。用于当调用方 cwd 不含 runtime/node 时(如从
// /tmp 编译)回退解析 __json_shim/__regexp_shim 及 node 内建 shim。
// gen1(node)下 import.meta.url 为可靠的 file:// 绝对路径;
// 自举二进制形态该值不可靠(codegen 将其装箱为 "file://<sourcePath>/module.js",
// 路径含伪 /module.js 段),但自举链恒从 repo root 运行,下面的 cwd 分支先命中,
// 永不触达此回退,故不依赖其在自举形态下的正确性(此处仅需能编译,不需运行正确)。
let _compilerRootDir = "";
try {
    let _u = import.meta.url;
    if (typeof _u === "string" && _u.indexOf("file://") === 0) _u = _u.slice(7);
    if (_u) _compilerRootDir = path.dirname(path.dirname(path.dirname(_u))); // <root>/compiler/modules/module-graph.js → <root>
} catch (_e) { _compilerRootDir = ""; }

// [#67] 解析 runtime/node 的基目录:优先 cwd(保自举现状——自举从 repo root 跑,
// cwd 正确,gen2==gen3 不破),cwd 无 runtime/node 时才回退编译器自身位置。
export function runtimeNodeBase(pathMod, fsMod) {
    if (fsMod.existsSync(pathMod.resolve(process.cwd(), "runtime/node"))) {
        return process.cwd();
    }
    if (_compilerRootDir && fsMod.existsSync(pathMod.resolve(_compilerRootDir, "runtime/node"))) {
        return _compilerRootDir;
    }
    return process.cwd(); // 兜底:保持旧行为
}

// [PERF] 按编译期缓存:同一 (forRequire, sourcePath, importSource) 的解析结果在一次
// 编译内不变(文件系统快照语义)。省掉每次重复的 path.resolve/normalize/existsSync/
// statSync(每次 import 数个系统调用与一串串操作,自编译实测 resolveImports 簇 ~6.7%)。
// 进程级 Map:CLI 单编译进程天然有界;route B 多次编译共享亦无碍(内容只增)。

const _resolvePathMemo = new Map();

export function resolveModulePath(importSource, sourcePath, nodeShimPath, pathMod, fsMod, forRequire) {
    const memoKey = (forRequire ? "R" : "I") + (sourcePath || "") + "|" + importSource;
    let memoHit = _resolvePathMemo.get(memoKey);
    if (memoHit !== undefined) return memoHit;
    const resolved = resolveModulePathUncached(importSource, sourcePath, nodeShimPath, pathMod, fsMod, forRequire);
    _resolvePathMemo.set(memoKey, resolved);
    return resolved;
}

export function resolveModulePathUncached(importSource, sourcePath, nodeShimPath, pathMod, fsMod, forRequire) {
    if (!importSource) return "";
    const traceImport = typeof process !== "undefined" && process.env && process.env.ASMJS_TRACE_IMPORT === "1";
    if (traceImport) console.log("TRACE_IMPORT_BEGIN", importSource, sourcePath);

    const normalizedSource = normalizeNodeModuleName(importSource);
    // 裸内建模块（单段 "fs" 或子路径 "fs/promises"）。子路径映射到
    // runtime/node/<subpath>.js（如 node:fs/promises → runtime/node/fs/promises.js）。
    if (isBareModuleName(normalizedSource) || isBareSubpath(normalizedSource)) {
        if (traceImport) console.log("TRACE_IMPORT_BUILTIN", normalizedSource);
        const builtinPath = pathMod.resolve(runtimeNodeBase(pathMod, fsMod), "runtime/node", normalizedSource + ".js");
        if (traceImport) console.log("TRACE_IMPORT_PATH", builtinPath, typeof fsMod.existsSync);
        if (fsMod.existsSync(builtinPath)) {
            if (traceImport) console.log("TRACE_IMPORT_HIT", builtinPath);
            return builtinPath;
        }
    }
    // 未知 node: 内建:上面没命中 runtime/node/<name>.js shim 的一律让编译失败。
    // 含两类:① 合法裸名但无 shim(如 "node:notreal");② 连裸名都不是的(如
    // "node:not-real",连字符不过 isBareModuleName,此前会漏到包解析被静默忽略)。
    // Node 自身对此抛 ERR_UNKNOWN_BUILTIN_MODULE;静默放行会让导入绑定消失、
    // 程序带着 undefined 编译通过。已知内建全部在上面返回,此处永不触发。
    // (抛错不进 _resolvePathMemo——memo 只缓存返回值。)
    if (importSource.startsWith("node:")) {
        throw new Error("Unknown node: builtin module '" + importSource + "'");
    }

    if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
        // 非内建裸 specifier → node_modules 包解析(package.json exports/main/module)。
        // 编译器自身裸导入全是内建(上面已解析),故此路径自举永不触发。
        const pkgResolved = resolvePackageSpecifier(importSource, sourcePath, pathMod, fsMod, forRequire === true);
        if (pkgResolved) return normalizePathSegments(pkgResolved);
        // Unknown bare package: fail at compile time (Node ERR_MODULE_NOT_FOUND).
        // Returning "" previously bound the import to undefined and the program
        // compiled successfully (es/unknown-bare-import).
        throw new Error("Cannot find package '" + importSource + "'");
    }

    const absSourcePath = pathMod.resolve(sourcePath || ".");
    if (traceImport) console.log("TRACE_IMPORT_ABS", typeof pathMod.resolve, absSourcePath, typeof absSourcePath, typeof absSourcePath.endsWith);
    // sourcePath 已是目录（resolveImports 传入前做过 dirname）。用 ".js 结尾=文件" 判断，
    // 不用 statSync().isDirectory()——自举运行时该 shim 恒返 false，会把目录再 dirname 一层
    // （"a/compiler"→"a/"）致相对导入丢一段路径（"a/../lang"），模块读空 → gen2 空壳根因。
    let currentDir = absSourcePath;
    if ((absSourcePath.endsWith(".js") || absSourcePath.endsWith(".mjs")) && !pathIsDirectory(fsMod, absSourcePath)) {
        if (traceImport) console.log("TRACE_IMPORT_FILEDIR", absSourcePath, typeof pathMod.dirname);
        currentDir = pathMod.dirname(absSourcePath);
    }

    if (traceImport) console.log("TRACE_IMPORT_ARGS", typeof currentDir, typeof currentDir.startsWith, typeof importSource, typeof importSource.startsWith, currentDir, importSource);
    // Avoid the runtime path shim's variadic `resolve` path here. In a
    // self-hosted compiler a namespace-bound `path.resolve` can lose its
    // Array helper bindings while compiling the module graph (`not a
    // function`); concatenating and folding segments is deterministic and
    // uses only the local resolver primitives.
    let resolvedPath = importSource.startsWith("/")
        ? importSource
        : normalizePathSegments(currentDir + "/" + importSource);
    if (traceImport) console.log("TRACE_IMPORT_REL", resolvedPath, typeof fsMod.existsSync);

    if (!resolvedPath.endsWith(".js") && !fsMod.existsSync(resolvedPath)) {
        if (fsMod.existsSync(resolvedPath + ".js")) {
            resolvedPath += ".js";
        } else if (fsMod.existsSync(pathMod.join(resolvedPath, "index.js"))) {
            resolvedPath = pathMod.join(resolvedPath, "index.js");
        }
    }

    // 规范化去掉 ./ 和 ../，否则同一模块经不同 ././变体路径被当不同文件，compiledFiles 去重
    // 失效 → 循环导入无限递归 → 栈溢出崩(139)。自举 path.resolve 不规范化，这里手动折叠。
    return normalizePathSegments(resolvedPath);
}

// .js/.mjs 结尾的路径一般是文件,但**目录**也可能叫这名(仓库更名 asm.js 后,
// clone 目录即 "asm.js")。node 下 statSync 实辨;native stat 的 isDirectory 恒
// false,用 existsSync(p+"/.") 区分目录与文件,不能再靠后缀启发式 dirname。
export function pathIsDirectory(fsMod, p) {
    try {
        const st = fsMod.statSync(p);
        if (typeof process !== "undefined" && process.env && process.env.ASMJS_TRACE_IMPORT === "1") {
            console.log("TRACE_IMPORT_STAT", p, typeof fsMod.statSync, st && typeof st.isDirectory);
        }
        if (st && typeof st.isDirectory === "function" && st.isDirectory()) return true;
    } catch (e) {
        if (typeof process !== "undefined" && process.env && process.env.ASMJS_TRACE_IMPORT === "1") console.log("TRACE_IMPORT_STAT_ERR", p, e && e.message);
    }
    // native statSync 的 isDirectory 恒 false(把一切当文件)。仓库目录名是 asm.js,
    // 不能靠 ".js 后缀=文件" 再 dirname,否则相对导入丢一层 → gen2 空壳。
    // Unix:目录可 open("dir/."),文件 "file/." 失败。
    try { return !!fsMod.existsSync(p + "/."); } catch (e) { return false; }
}

// 折叠路径里的 "." 与 ".."（不依赖 pathMod.normalize，其在自举运行时可能不可靠）
export function normalizePathSegments(p) {
    if (!p) return p;
    const isAbs = p.charAt(0) === "/";
    const parts = p.split("/");
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
            if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
            else if (!isAbs) out.push("..");
        } else {
            out.push(seg);
        }
    }
    let res = out.join("/");
    if (isAbs) res = "/" + res;
    return res || (isAbs ? "/" : ".");
}

// ---- node_modules 包解析(package.json exports/main/module 子集)----
// forRequire=true(CJS require)偏好 require 条件与 main;否则(ESM import)偏好
// import 条件与 module 字段。仅覆盖 fixtures 用到的 exports 形态。
export function resolvePackageSpecifier(spec, sourcePath, pathMod, fsMod, forRequire) {
    // 拆包名 + 子路径(scoped @a/b 取前两段)
    let pkgName, sub;
    if (spec.charCodeAt(0) === 64) { // '@'
        const parts = spec.split("/");
        pkgName = parts[0] + "/" + (parts[1] || "");
        sub = parts.slice(2).join("/");
    } else {
        const slash = spec.indexOf("/");
        if (slash === -1) { pkgName = spec; sub = ""; }
        else { pkgName = spec.slice(0, slash); sub = spec.slice(slash + 1); }
    }
    const subpath = sub ? "./" + sub : ".";

    // 从 sourcePath 起向上找 node_modules/<pkgName>/package.json
    let dir = pathMod.resolve(sourcePath || ".");
    if ((dir.endsWith(".js") || dir.endsWith(".mjs")) && !pathIsDirectory(fsMod, dir)) dir = pathMod.dirname(dir);
    let pkgDir = null;
    while (true) {
        const cand = pathMod.join(dir, "node_modules", pkgName);
        if (fsMod.existsSync(pathMod.join(cand, "package.json"))) { pkgDir = cand; break; }
        const parent = pathMod.dirname(dir);
        if (!parent || parent === dir) break;
        dir = parent;
    }
    if (!pkgDir) return "";

    let pkg;
    try { pkg = JSON.parse(fsMod.readFileSync(pathMod.join(pkgDir, "package.json"), "utf-8")); }
    catch (e) { return ""; }

    let target = null;
    if (pkg.exports !== undefined && pkg.exports !== null) {
        target = resolveExportsField(pkg.exports, subpath, forRequire);
    }
    if (target === null || target === undefined) {
        if (subpath !== ".") {
            target = "./" + sub;
        } else if (forRequire) {
            target = pkg.main || "./index.js";
        } else {
            target = pkg.module || pkg.main || "./index.js";
        }
    }
    if (target === null || target === undefined) return "";

    let resolved = pathMod.resolve(pkgDir, target);
    const isFile = resolved.endsWith(".js") || resolved.endsWith(".mjs") || resolved.endsWith(".cjs");
    if (!isFile && !fsMod.existsSync(resolved)) {
        if (fsMod.existsSync(resolved + ".js")) resolved += ".js";
        else if (fsMod.existsSync(pathMod.join(resolved, "index.js"))) resolved = pathMod.join(resolved, "index.js");
    }
    return resolved;
}

// exports 字段解析。子路径映射(键以 "." 开头,支持精确与单个 "*" 通配)或
// 条件对象(import/require/node/default)。返回相对目标串或 null。
export function resolveExportsField(exp, subpath, forRequire) {
    if (typeof exp === "string") {
        return subpath === "." ? exp : null;
    }
    if (typeof exp !== "object" || exp === null) return null;

    let isSubpathMap = false;
    for (const k in exp) { if (k.charCodeAt(0) === 46) { isSubpathMap = true; break; } } // '.'
    if (isSubpathMap) {
        const direct = exp[subpath];
        if (direct !== undefined) return resolveConditionTarget(direct, forRequire);
        // 通配 "./x/*"
        for (const k in exp) {
            const star = k.indexOf("*");
            if (star === -1) continue;
            const prefix = k.slice(0, star);
            const suffix = k.slice(star + 1);
            if (subpath.length >= prefix.length + suffix.length &&
                subpath.slice(0, prefix.length) === prefix &&
                (suffix === "" || subpath.slice(subpath.length - suffix.length) === suffix)) {
                const mid = subpath.slice(prefix.length, subpath.length - suffix.length);
                const tgt = resolveConditionTarget(exp[k], forRequire);
                if (tgt === null) return null;
                const si = tgt.indexOf("*");
                return si === -1 ? tgt : tgt.slice(0, si) + mid + tgt.slice(si + 1);
            }
        }
        return null;
    }
    // 条件对象(subpath 必为根 ".")
    return subpath === "." ? resolveConditionTarget(exp, forRequire) : null;
}

export function resolveConditionTarget(v, forRequire) {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null) {
        const cond = forRequire ? "require" : "import";
        if (v[cond] !== undefined) return resolveConditionTarget(v[cond], forRequire);
        if (v.node !== undefined) return resolveConditionTarget(v.node, forRequire);
        if (v.default !== undefined) return resolveConditionTarget(v.default, forRequire);
    }
    return null;
}
