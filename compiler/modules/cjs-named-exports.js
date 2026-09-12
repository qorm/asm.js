// compiler/modules/cjs-named-exports.js
// Bare-module / CommonJS source classification and named-export key extraction.
// Pure scanners over source text + package.json walk. Extracted from
// compiler/index.js (P2.b) with zero semantic change.
// Hand-written char scans only — these run inside gen1 (no regex literals).

import * as fs from "fs";
import * as path from "path";
import { sourceHasTopLevelEsmDecl } from "./shim-triggers.js";

export function isBareModuleName(s) {
    if (!s || s.length === 0) return false;
    const c0 = s.charCodeAt(0);
    if (!((c0 >= 97 && c0 <= 122) || c0 === 95)) return false; // [a-z_]
    for (let i = 1; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return false; // [a-z0-9_]
    }
    return true;
}
// 裸内建子路径判定（如 "fs/promises"、"stream/web"）：至少两段，每段各为裸名。
// 用于把 node 内建子路径导入映射到 runtime/node/<subpath>.js。首字符必须是
// [a-z_]，故相对（"./"、"../"）与绝对（"/"）路径永不误判为子路径。
export function isBareSubpath(s) {
    if (!s || s.indexOf("/") < 0) return false;
    const parts = s.split("/");
    if (parts.length < 2) return false;
    for (let i = 0; i < parts.length; i++) {
        if (!isBareModuleName(parts[i])) return false;
    }
    return true;
}


// ---- CommonJS(require/module.exports)AOT 子集支持 ----
// 只对「无 ESM import/export 语句、且用到 CJS 标志(module.exports/exports.\/裸
// require())」的文件生效。编译器/运行时自身全部是 ESM,永不命中,故自举零影响。
// ESM 语法判定用 sourceHasTopLevelEsmDecl(词法感知,来自 shim-triggers.js):注释/字符串/
// 模板/正则字面量里的 "export "/"import " 文字不算数——此前的朴素子串扫描
// (cjsHasEsmSyntax)把这些文字当成 ESM,使含它们的合法 CJS 文件被判为非 CJS、
// 不做 CJS 包装,import 之运行期崩 _object_set NULL(Node 照常执行)。
// 裸 require( 调用(排除 obj.require( 与标识符续接)
export function cjsHasBareRequire(src) {
    let idx = src.indexOf("require(");
    while (idx !== -1) {
        const prev = idx > 0 ? src.charCodeAt(idx - 1) : 0;
        const isIdentPrev = (prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) ||
            (prev >= 97 && prev <= 122) || prev === 95 || prev === 36 || prev === 46;
        if (!isIdentPrev) return true;
        idx = src.indexOf("require(", idx + 1);
    }
    return false;
}
export function looksLikeCjsSource(src) {
    if (!src || src.length === 0) return false;
    // 先廉价门控:绝大多数 ESM 模块无这些子串 → 直接否,免 sourceHasTopLevelEsmDecl/
    // cjsHasBareRequire 的整文件扫描(gen1 上 resolve 读 111 模块时很贵)。
    const hasMe = src.indexOf("module.exports") !== -1;
    const hasEd = src.indexOf("exports.") !== -1;
    const hasEb = src.indexOf("exports[") !== -1;
    const hasReq = src.indexOf("require(") !== -1;
    if (!hasMe && !hasEd && !hasEb && !hasReq) return false;
    if (sourceHasTopLevelEsmDecl(src)) return false;
    return hasMe || hasEd || hasEb || cjsHasBareRequire(src);
}
// 从 dirname(filePath) 逐级向上找第一个存在的 package.json,当且仅当其 "type"
// 恰为字符串 "commonjs" 时返回 true。链上无 package.json、JSON 解析失败、无
// type 字段或 type 为别的值("module" 等)→ false。每调用走一遍目录链即可
// (模块数有限,不缓存)。用 readModuleSource 同款模块级 fs/path 绑定。
// 自举安全:编译器/运行时模块都在根 package.json(无 type 字段)之下,恒 false。
// AOT 子集门控:前缀 `require(` / `import(` 后(跳空白)须是字面量引号或 ASCII
// 标识符起首。注释里的 `require(静态` / `动态 import(source)` 等不得开整树扫描。
export function sourceHasCallParenForm(src, prefix) {
    let i = 0;
    const plen = prefix.length;
    while ((i = src.indexOf(prefix, i)) !== -1) {
        let j = i + plen;
        while (j < src.length) {
            const c = src.charCodeAt(j);
            if (c === 32 || c === 9 || c === 10 || c === 13) { j++; continue; }
            break;
        }
        if (j >= src.length) { i += plen; continue; }
        const c = src.charCodeAt(j);
        // " ' ` 或 $/_/A-Z/a-z
        if (c === 34 || c === 39 || c === 96 || c === 36 || c === 95 ||
            (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
        i += plen;
    }
    return false;
}

const _pkgCjsMemo = new Map();
export function nearestPackageJsonExplicitCommonjs(filePath) {
    const startDir = path.dirname(filePath);
    const cached = _pkgCjsMemo.get(startDir);
    if (cached !== undefined) return cached;
    let dir = startDir;
    const walked = [];
    while (true) {
        const hit = _pkgCjsMemo.get(dir);
        if (hit !== undefined) {
            for (let i = 0; i < walked.length; i++) _pkgCjsMemo.set(walked[i], hit);
            return hit;
        }
        walked.push(dir);
        const pkgPath = path.join(dir, "package.json");
        if (fs.existsSync(pkgPath)) {
            let typeVal;
            try {
                typeVal = JSON.parse(fs.readFileSync(pkgPath, "latin1")).type;
            } catch (e) {
                // 损坏的 package.json 不能静默吞掉:Node 对无效配置抛
                // ERR_INVALID_PACKAGE_CONFIG,这里对齐 Node 抛编译错误。
                // 覆盖入口与相对导入路径;经“包说明符”解析到的损坏 package.json 由
                // resolvePackageSpecifier 自己的 catch 先行吞掉(既有行为,该导入被
                // 静默丢弃),到不了这里——那处与 Node 的分歧属既有待办,非本函数职责。
                // 自举安全:根 package.json 是合法 JSON(无 type 字段),
                // 自编译时解析恒成功、走 return typeVal === "commonjs" 得 false,
                // 此 throw 分支不可达。
                const err = new Error("Invalid package config: " + pkgPath);
                err.code = "ERR_INVALID_PACKAGE_CONFIG";
                throw err;
            }
            const result = typeVal === "commonjs";
            for (let i = 0; i < walked.length; i++) _pkgCjsMemo.set(walked[i], result);
            return result;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            for (let i = 0; i < walked.length; i++) _pkgCjsMemo.set(walked[i], false);
            return false; // 到文件系统根仍无 package.json
        }
        dir = parent;
    }
}
// AST 级判定:program.body 顶层是否有真实 import/export 声明。解析器只发三种
// 模块语句:ImportDeclaration、ImportLibDeclaration(.jslib)、统一的
// ExportDeclaration(所有 export 形态);无 ExportNamedDeclaration 等分支类型。
// "__" 前缀排除编译器注入的 shim import(__json_shim、__regexp_shim、
// __channel_shim、__eval_shim、__number_shim、__date_shim)——这些是合成的,
// 不算用户 ESM。与 sourceHasTopLevelEsmDecl(looksLikeCjsSource 用的源码级
// 词法扫描)同源思路,本判定在 AST 层有词法感知:
// 注释/字符串里出现 "export "/"import " 文字不产生声明节点,故不误杀
// 注释里含 "export helper" 的合法 CJS 文件(Node 照常执行)。
// 已知窄边角:用户裸名导入恰以 "__" 开头(如 import x from "__foo")会被一并
// 当作合成 shim 排除而漏拒——极罕见,且不劣于本检查引入前(彼时一切 ESM 均被接受)。
export function astHasRealTopLevelEsm(program) {
    for (const s of program.body) {
        if (s.type === "ExportDeclaration") return true;
        if ((s.type === "ImportDeclaration" || s.type === "ImportLibDeclaration") &&
            !(s.source && s.source.value && s.source.value.indexOf("__") === 0)) return true;
    }
    return false;
}
// 从 CJS 源码静态提取 module.exports 的具名键,供 ESM 具名导入互操作
// (Node 用 cjs-module-lexer 合成具名导出;这里覆盖 fixtures 用到的两种形态:
//  ① module.exports = { k: v, ... } 对象字面量顶层键;② exports.k = / module.exports.k =)。
function _cjsIsIdentStart(cc) {
    return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 95 || cc === 36;
}
function _cjsIsIdentPart(cc) {
    return _cjsIsIdentStart(cc) || (cc >= 48 && cc <= 57);
}
function _cjsIsWs(cc) { return cc === 32 || cc === 9 || cc === 10 || cc === 13; }
function _cjsValidIdent(s) {
    if (!s || s.length === 0) return false;
    if (!_cjsIsIdentStart(s.charCodeAt(0))) return false;
    for (let i = 1; i < s.length; i++) if (!_cjsIsIdentPart(s.charCodeAt(i))) return false;
    return true;
}
export function extractCjsNamedExportKeys(src) {
    const keys = [];
    const seen = {};
    const add = (k) => {
        if (k && k !== "default" && _cjsValidIdent(k) && !seen[k]) { seen[k] = 1; keys.push(k); }
    };
    const n = src.length;
    // ① 对象字面量: module.exports = { ... }
    let me = src.indexOf("module.exports");
    while (me !== -1) {
        let i = me + 14;
        while (i < n && _cjsIsWs(src.charCodeAt(i))) i++;
        if (src.charAt(i) === "=" && src.charAt(i + 1) !== "=") {
            i++;
            while (i < n && _cjsIsWs(src.charCodeAt(i))) i++;
            if (src.charAt(i) === "{") {
                let j = i + 1, depth = 1, expectKey = true;
                while (j < n && depth > 0) {
                    const c = src.charAt(j), cc = src.charCodeAt(j);
                    if (_cjsIsWs(cc)) { j++; continue; }
                    if (c === "/" && src.charAt(j + 1) === "/") { while (j < n && src.charCodeAt(j) !== 10) j++; continue; }
                    if (c === "/" && src.charAt(j + 1) === "*") { j += 2; while (j + 1 < n && !(src.charAt(j) === "*" && src.charAt(j + 1) === "/")) j++; j += 2; continue; }
                    if (c === "{" || c === "[" || c === "(") { depth++; j++; expectKey = false; continue; }
                    if (c === "}" || c === "]" || c === ")") { depth--; j++; continue; }
                    if (c === "," && depth === 1) { expectKey = true; j++; continue; }
                    if (c === '"' || c === "'" || c === "`") {
                        const q = c; let e = j + 1; let str = "";
                        while (e < n) { const d = src.charAt(e); if (d === "\\") { e += 2; continue; } if (d === q) break; str += d; e++; }
                        if (expectKey && depth === 1) {
                            let k = e + 1; while (k < n && _cjsIsWs(src.charCodeAt(k))) k++;
                            if (src.charAt(k) === ":") add(str);
                        }
                        j = e + 1; expectKey = false; continue;
                    }
                    if (expectKey && depth === 1 && _cjsIsIdentStart(cc)) {
                        let e = j, id = "";
                        while (e < n && _cjsIsIdentPart(src.charCodeAt(e))) { id += src.charAt(e); e++; }
                        let k = e; while (k < n && _cjsIsWs(src.charCodeAt(k))) k++;
                        if (src.charAt(k) === ":") add(id);
                        j = e; expectKey = false; continue;
                    }
                    expectKey = false; j++;
                }
            }
        }
        me = src.indexOf("module.exports", me + 14);
    }
    // ② exports.<key> = / module.exports.<key> =
    let ex = src.indexOf("exports.");
    while (ex !== -1) {
        // 排除 module.exports.<key>(前缀 module. 已在 ① 处理,但这里也接受)
        let i = ex + 8;
        let id = "";
        while (i < n && _cjsIsIdentPart(src.charCodeAt(i))) { id += src.charAt(i); i++; }
        let k = i; while (k < n && _cjsIsWs(src.charCodeAt(k))) k++;
        if (src.charAt(k) === "=" && src.charAt(k + 1) !== "=") add(id);
        ex = src.indexOf("exports.", ex + 8);
    }
    return keys;
}

// 双引号字符串字面量转义(路径不含控制字符,处理 \ 与 ")
export function cjsStringLiteral(s) {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (c === "\\" || c === '"') out += "\\" + c;
        else out += c;
    }
    return out + '"';
}
