// asm.js 统一编译器 - 重构版
// 将 JavaScript 源码编译为各平台可执行文件
//
// 模块化结构:
// - core/: 上下文、平台、类型、代码生成
// - expressions/: 表达式编译
// - functions/: 函数和语句编译
// - output/: 库文件、包装器、二进制生成

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
// 显式导入 Buffer：全局 Buffer 在编译产物（gen1）里解析有问题，具名导入才拿到真实类。
import { Buffer } from "node:buffer";
import { execSync, execFileSync } from "child_process";

// 语言前端
import { Lexer, Parser } from "../lang/index.js";
import { analyzeCapturedVariables, analyzeSharedVariables, analyzeTopLevelSharedVariables, analyzeDirectEvalBoxedVars } from "../lang/analysis/closure.js";
import { renameBlockScopedBindings } from "../lang/analysis/blockscope.js";

// 虚拟机和汇编器
import { VirtualMachine, VReg } from "../vm/index.js";
import { ARM64Assembler } from "../asm/arm64.js";
import { X64Assembler } from "../asm/x64.js";
import { Wasm32Assembler } from "../asm/wasm32.js";
import { WASM_STACK_TOP, WASM_ARGV_BASE } from "../binary/wasm.js";

// 运行时
import { AllocatorGenerator, RuntimeGenerator, NumberGenerator, StringConstantsGenerator, AsyncGenerator } from "../runtime/index.js";

// 编译上下文和平台
import { CompileContext, CompileOptions, CompileResult } from "./core/context.js";
import { detectPlatform, getTargetInfo, resolveTarget, listTargets, TARGETS } from "./core/platform.js";

// 编译器模块
import { StatementCompiler } from "./functions/statements.js";
import { ExpressionCompiler } from "./expressions/expressions.js";
import { FunctionCompiler } from "./functions/functions.js";
import { isAsyncFunction } from "./async/index.js";

// 输出模块
import { parseJslibFile, LibraryManager } from "./output/library.js";
import { WrapperGenerator } from "./output/wrapper.js";
import { BinaryOutputGenerator } from "./output/generator.js";

// 静态链接器
import { StaticLinker } from "../binary/static_linker.js";

// 重新导出
export { detectPlatform, getTargetInfo, resolveTarget, listTargets, TARGETS } from "./core/platform.js";
export { CompileContext, CompileOptions, CompileResult } from "./core/context.js";
export { BinaryGenerator, OutputType, pageAlign, align16, align } from "../binary/binary_format.js";
export { parseJslibFile, LibraryManager } from "./output/library.js";

// Box 对象布局：存储被捕获变量的包装对象
const BOX_VALUE_OFFSET = 0;

// [#67] 编译器自身所在目录 <root>。用于当调用方 cwd 不含 runtime/node 时(如从
// /tmp 编译)回退解析 __json_shim/__regexp_shim 及 node 内建 shim。
// gen1(node)下 import.meta.url 为可靠的 file:// 绝对路径(<root>/compiler/index.js);
// 自举二进制形态该值不可靠(codegen 将其装箱为 "file://<sourcePath>/module.js",
// 路径含伪 /module.js 段),但自举链恒从 repo root 运行,下面的 cwd 分支先命中,
// 永不触达此回退,故不依赖其在自举形态下的正确性(此处仅需能编译,不需运行正确)。
let _compilerRootDir = "";
try {
    let _u = import.meta.url;
    if (typeof _u === "string" && _u.indexOf("file://") === 0) _u = _u.slice(7);
    if (_u) _compilerRootDir = path.dirname(path.dirname(_u)); // <root>/compiler/index.js → <root>
} catch (_e) { _compilerRootDir = ""; }

// [#67] 解析 runtime/node 的基目录:优先 cwd(保自举现状——自举从 repo root 跑,
// cwd 正确,gen2==gen3 不破),cwd 无 runtime/node 时才回退编译器自身位置。
function runtimeNodeBase(pathMod, fsMod) {
    if (fsMod.existsSync(pathMod.resolve(process.cwd(), "runtime/node"))) {
        return process.cwd();
    }
    if (_compilerRootDir && fsMod.existsSync(pathMod.resolve(_compilerRootDir, "runtime/node"))) {
        return _compilerRootDir;
    }
    return process.cwd(); // 兜底:保持旧行为
}

// [批次D] 生成器声明判定(本地副本,勿经 async/index.js 再导出链)
function _isGenFuncDecl(node) {
    return node && (node.isGenerator === true || node.generator === true);
}
// [W-24] 函数 arity(规范 length):首个默认值形参/剩余形参**之前**的形参个数。
// 与 compiler/expressions/members.js 的 _fnNameLength 逐字同源——编译期静态解析点与
// 运行期元数据表必须给出同一个数,否则同一函数经不同访问路径读到不同 length。
function _fnArity(expr) {
    const params = (expr && expr.params) || [];
    let n = 0;
    for (let i = 0; i < params.length; i = i + 1) {
        const t = params[i] ? params[i].type : null;
        if (t === "AssignmentPattern" || t === "SpreadElement" || t === "RestElement") break;
        n = n + 1;
    }
    return n;
}
// 裸模块名判定（等价 /^[a-z_][a-z0-9_]*$/）。手写字符检查而非正则字面量——
// 历史上自举编译器不支持 RegexLiteral codegen（现已由 __RE_new shim 路线落地，
// 见 expressions.js RegexLiteral 分支）；此处手写检查更快且无依赖，保留。
// 用于识别 node 内建导入（如 "fs"/"path"/"node:fs"）。
function isBareModuleName(s) {
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
function isBareSubpath(s) {
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
// ESM 语法判定用 sourceHasTopLevelEsmDecl(词法感知,见本文件后部):注释/字符串/
// 模板/正则字面量里的 "export "/"import " 文字不算数——此前的朴素子串扫描
// (cjsHasEsmSyntax)把这些文字当成 ESM,使含它们的合法 CJS 文件被判为非 CJS、
// 不做 CJS 包装,import 之运行期崩 _object_set NULL(Node 照常执行)。
// 裸 require( 调用(排除 obj.require( 与标识符续接)
function cjsHasBareRequire(src) {
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
function looksLikeCjsSource(src) {
    if (!src || src.length === 0) return false;
    if (sourceHasTopLevelEsmDecl(src)) return false;
    return src.indexOf("module.exports") !== -1 ||
        src.indexOf("exports.") !== -1 ||
        src.indexOf("exports[") !== -1 ||
        cjsHasBareRequire(src);
}
// 从 dirname(filePath) 逐级向上找第一个存在的 package.json,当且仅当其 "type"
// 恰为字符串 "commonjs" 时返回 true。链上无 package.json、JSON 解析失败、无
// type 字段或 type 为别的值("module" 等)→ false。每调用走一遍目录链即可
// (模块数有限,不缓存)。用 readModuleSource 同款模块级 fs/path 绑定。
// 自举安全:编译器/运行时模块都在根 package.json(无 type 字段)之下,恒 false。
function nearestPackageJsonExplicitCommonjs(filePath) {
    let dir = path.dirname(filePath);
    while (true) {
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
            return typeVal === "commonjs";
        }
        const parent = path.dirname(dir);
        if (parent === dir) return false; // 到文件系统根仍无 package.json
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
function astHasRealTopLevelEsm(program) {
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
function extractCjsNamedExportKeys(src) {
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
function cjsStringLiteral(s) {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (c === "\\" || c === '"') out += "\\" + c;
        else out += c;
    }
    return out + '"';
}

const UNINITIALIZED_BINDING_SENTINEL = 0x7ff70000deadbeefn;

export class Compiler {
    constructor(target) {
        // 目标目录单一来源:platform.js 的 TARGETS。resolveTarget 在此把别名规范成
        // 正式名,并对未知目标抛 "Unknown target: <name>"——构造阶段即拦截非法目标,
        // 别名(如 darwin-arm64)也能端到端构造,不再「过校验却在构造阶段崩」。
        this.target = resolveTarget(target || "linux-arm64");
        const targetInfo = TARGETS[this.target];

        this.arch = targetInfo.arch;
        this.os = targetInfo.os;

        // 创建汇编器
        this._initAssembler();

        // 创建虚拟机 (VM 内部创建 backend)
        this.vm = new VirtualMachine(this.arch, this.os, this.asm);
        this.ctx = new CompileContext("main");

        // 库管理器
        this.libManager = new LibraryManager();
        this.staticLibs = [];

        this.compiledFiles = new Set();
        // Node.js compatibility module path
        this.nodeShimPath = path.resolve(runtimeNodeBase(path, fs), "runtime/node/index.js");

        // 待处理的函数表达式
        this.pendingFunctions = [];
        this.labelCounter = 0;

        // 输出配置
        this.outputType = "executable";
        this.exports = [];
        this.libraries = [];
        this.libraryPaths = [];
        this.sourcePath = "";
        this.options = {}; // 编译选项
        this.imports = [];
        this._moduleOrder = [];
        this._moduleMetaByAst = new Map();
        this._moduleMetaByPath = new Map();
        this._functionOwners = {};
        this.moduleRegistrySize = 32;
        // [W-35] 本次编译读到的任一模块源码里出现过「\ + p/P」序列(→ 可能用 Unicode
        // 属性转义,须保留 __regexp_shim 的属性表)。**单调**递增、故意不在
        // resetModuleCompilationState 里清:入口文件在 resetModuleCompilationState
        // 之前就被 readModuleSource 读过(compileFile → compile → compileProgram),
        // 清掉会丢掉入口的扫描结果;而残留的 true 只会多留表(保守、安全)。
        this._reUniPropSeen = false;

        // 兼容旧 API
        this.externalLibs = this.libManager.externalLibs;
        this.staticLibs = [];
        this.registeredDylibs = this.libManager.registeredDylibs;
        
        // 确保 C 标准库被链接以支持依赖环境的 pow/sprintf
        if (this.os === "macos") {
             this.libManager.registerDylib("/usr/lib/libSystem.B.dylib");
        } else if (this.os === "linux") {
             this.libManager.registerDylib("libc.so.6");
             this.libManager.registerDylib("libm.so.6");
        }
    }

    _initAssembler() {
        if (this.arch === "arm64") {
            this.asm = new ARM64Assembler();
        } else if (this.arch === "wasm32") {
            this.asm = new Wasm32Assembler();
        } else {
            this.asm = new X64Assembler();
        }
    }

    // ========== 配置方法 ==========

    setSourcePath(sourcePath) {
        this.sourcePath = path.dirname(sourcePath);
    }

    setOutputType(type) {
        this.outputType = type;
    }

    addExport(name) {
        this.exports.push(name);
    }

    addLibrary(name) {
        this.libraries.push(name);
    }

    addLibraryPath(p) {
        this.libraryPaths.push(p);
    }

    setOption(key, value) {
        this.options[key] = value;
    }

    getOption(key) {
        return this.options[key];
    }

    addExternalLib(libInfo) {
        this.libManager.addExternalLib(libInfo);
    }

    addStaticLib(libInfo) {
        this.staticLibs.push(libInfo);
    }

    resetModuleCompilationState() {
        this.compiledFiles = new Set();
        this.imports = [];
        this._moduleOrder = [];
        this._moduleMetaByAst = new Map();
        this._moduleMetaByPath = new Map();
        this._functionOwners = {};
        this.moduleRegistrySize = 32;
        // 模块解析查询缓存(把 O(n²) 线性扫描降为 O(1) 查表;结果不变,只是记忆化)
        this._moduleIndexByPath = null;   // path -> _moduleOrder 下标
        this._moduleIndexByPathLen = -1;  // 建缓存时的 _moduleOrder 长度(变化则重建)
        this._bindingKindCache = new Map();   // moduleAst -> Map<name, kind>
        this._importBindingCache = new Map(); // moduleAst -> Map<localName, binding>
        this._importCacheLen = -1;            // 建缓存时的 imports 长度
        this._propTargetIndex = null;         // "targetModuleIndex:localName" -> [{moduleIndex, exportName, srcIndex}]
    }

    getModuleMeta(moduleAst) {
        return this._moduleMetaByAst.get(moduleAst);
    }

    getModuleMetaByPath(filename) {
        return this._moduleMetaByPath.get(filename);
    }

    createModuleMeta(moduleAst, index) {
        const boxedVars = analyzeTopLevelSharedVariables(moduleAst);
        const moduleBodyFunc = {
            params: [],
            body: {
                type: "BlockStatement",
                body: moduleAst.body.filter((stmt) => stmt.type !== "FunctionDeclaration"),
            },
        };
        const nestedBoxedVars = analyzeSharedVariables(moduleBodyFunc);
        for (const name of nestedBoxedVars) {
            boxedVars.add(name);
        }

        const meta = {
            ast: moduleAst,
            index,
            symbolPrefix: "m" + index,
            functionAliases: {},
            boxedVars,
            mainCapturedVars: {},
            exports: [],
        };
        this._moduleMetaByAst.set(moduleAst, meta);
        if (moduleAst.filename) {
            this._moduleMetaByPath.set(moduleAst.filename, meta);
        }
        return meta;
    }

    getFunctionSymbolForModule(moduleMeta, localName) {
        if (!moduleMeta) return localName;
        // [#32] 双语义守卫:别名恒为字符串。node 下 localName="constructor" 等
        // 会命中 Object.prototype(truthy 的 Function),须视为未分配
        const fa = moduleMeta.functionAliases[localName];
        if (!fa || typeof fa !== "string") {
            moduleMeta.functionAliases[localName] = `${moduleMeta.symbolPrefix}_${localName}`;
        }
        return moduleMeta.functionAliases[localName];
    }

    // [#50] JSON shim 绑定别名注册。readModuleSource 为引用 JSON.stringify/parse 的
    // 模块注入 `import { __JSON_stringify, __JSON_parse } from "__json_shim"`,但对这两个
    // 绑定的引用全是编译期改派(JSON.stringify(x) → __JSON_stringify(x)),源码里没有该
    // 标识符的文本出现 → 闭包分析既不把它并入 boxedVars、functionAliases 也不登记。
    // 结果:模块**顶层**的 JSON.* 经主 ctx 的 hasFunction 恰能解析,但**函数体内**的
    // JSON.*(toJSON/replacer/reviver 回调重入、或任何嵌套函数里的 JSON 调用)在克隆自
    // ownerMeta.functionAliases 的子 ctx 里解析不到绑定 → dispatch 不发调用、返回垃圾
    // (#50 缺陷3 根因)。此处为每个含注入 import 的模块把两个绑定直接别名到 shim 导出的
    // 函数符号,令 hasFunction/getFunctionLabel 在任意作用域都解析为对 _user_<shim符号>
    // 的**直接 call**。不进 boxedVars(不分配全局 box、不发 box 初始化码),故只在真正
    // 编出 JSON.* dispatch 的调用点生效;仅在注释/字符串里出现 "JSON.stringify"(如
    // 编译器自身 index.js 的注入检测串)而从不调用的模块,别名永不被查 → 零码差、
    // 自举定点不变。
    registerJsonShimAliases() {
        let shimMeta = null;
        for (const moduleAst of this._moduleOrder) {
            const fn = moduleAst.filename;
            if (typeof fn === "string" && fn.indexOf("__json_shim.js") !== -1) {
                shimMeta = this.getModuleMeta(moduleAst);
                break;
            }
        }
        if (!shimMeta) return;
        const strSym = this.getFunctionSymbolForModule(shimMeta, "__JSON_stringify");
        const parseSym = this.getFunctionSymbolForModule(shimMeta, "__JSON_parse");
        // [W7-2] raw 族两导出同机理登记;仅被 JSON.rawJSON/JSON.isRawJSON dispatch 的
        // 调用点查阅,不含 raw 文本的模块别名永不被查 → 零码差(与下方注释同一论证)。
        const rawSym = this.getFunctionSymbolForModule(shimMeta, "__JSON_rawJSON");
        const isRawSym = this.getFunctionSymbolForModule(shimMeta, "__JSON_isRawJSON");
        // shim 导出的两个函数必须已在 collectFunctions 登记(否则别名指向空 → getFunction
        // 守卫判假,退化为原行为,不至误发)。
        if (!this.ctx.functions[strSym] || !this.ctx.functions[parseSym]) return;
        if (!this.ctx.functions[rawSym] || !this.ctx.functions[isRawSym]) return;
        for (const moduleAst of this._moduleOrder) {
            const meta = this.getModuleMeta(moduleAst);
            if (meta === shimMeta) continue;
            let hasShimImport = false;
            for (const stmt of moduleAst.body) {
                if (stmt.type === "ImportDeclaration" && stmt.source &&
                    stmt.source.value === "__json_shim") {
                    hasShimImport = true;
                    break;
                }
            }
            if (!hasShimImport) continue;
            if (!meta.functionAliases["__JSON_stringify"]) {
                meta.functionAliases["__JSON_stringify"] = strSym;
            }
            if (!meta.functionAliases["__JSON_parse"]) {
                meta.functionAliases["__JSON_parse"] = parseSym;
            }
            if (!meta.functionAliases["__JSON_rawJSON"]) {
                meta.functionAliases["__JSON_rawJSON"] = rawSym;
            }
            if (!meta.functionAliases["__JSON_isRawJSON"]) {
                meta.functionAliases["__JSON_isRawJSON"] = isRawSym;
            }
        }
    }

    // eval/new Function shim 绑定别名注册(机理同 registerJsonShimAliases)。eval(x)/
    // new Function(body) 的改派是编译期合成 __eval/__makeFunction 调用,源码里无这两个
    // 标识符文本 → 嵌套函数体的子 ctx 解析不到绑定,dispatch 被静默丢弃(返回垃圾/原样)。
    // 为每个含注入 import 的模块把这两个绑定直接别名到 shim 导出符号,令任意作用域都解析
    // 为对 _user_<shim符号> 的直接 call。仅注释/字符串里出现而从不调用的模块零码差。
    registerEvalShimAliases() {
        let shimMeta = null;
        for (const moduleAst of this._moduleOrder) {
            const fn = moduleAst.filename;
            if (typeof fn === "string" && fn.indexOf("__eval_shim.js") !== -1) {
                shimMeta = this.getModuleMeta(moduleAst);
                break;
            }
        }
        if (!shimMeta) return;
        const evalSym = this.getFunctionSymbolForModule(shimMeta, "__eval");
        const mkfnSym = this.getFunctionSymbolForModule(shimMeta, "__makeFunction");
        const evalDirectSym = this.getFunctionSymbolForModule(shimMeta, "__eval_direct");
        if (!this.ctx.functions[evalSym] || !this.ctx.functions[mkfnSym]) return;
        for (const moduleAst of this._moduleOrder) {
            const meta = this.getModuleMeta(moduleAst);
            if (meta === shimMeta) continue;
            let hasShimImport = false;
            for (const stmt of moduleAst.body) {
                if (stmt.type === "ImportDeclaration" && stmt.source &&
                    stmt.source.value === "__eval_shim") {
                    hasShimImport = true;
                    break;
                }
            }
            if (!hasShimImport) continue;
            if (!meta.functionAliases["__eval"]) {
                meta.functionAliases["__eval"] = evalSym;
            }
            if (!meta.functionAliases["__makeFunction"]) {
                meta.functionAliases["__makeFunction"] = mkfnSym;
            }
            // __eval_direct(直接 eval 词法捕获落点):同 __eval 别名到 shim 导出符号。
            if (evalDirectSym && this.ctx.functions[evalDirectSym] && !meta.functionAliases["__eval_direct"]) {
                meta.functionAliases["__eval_direct"] = evalDirectSym;
            }
        }
    }

    // Number 格式化 shim 别名注册(机理同 registerJsonShimAliases):
    // n.toExponential/toPrecision 改派为合成 __NUM_* 调用,源码无该标识符文本,
    // 嵌套作用域子 ctx 解析不到 → 为含注入 import 的模块把绑定别名到 shim 导出符号。
    registerNumberShimAliases() {
        let shimMeta = null;
        for (const moduleAst of this._moduleOrder) {
            const fn = moduleAst.filename;
            if (typeof fn === "string" && fn.indexOf("__number_shim.js") !== -1) {
                shimMeta = this.getModuleMeta(moduleAst);
                break;
            }
        }
        if (!shimMeta) return;
        const expSym = this.getFunctionSymbolForModule(shimMeta, "__NUM_toExponential");
        const preSym = this.getFunctionSymbolForModule(shimMeta, "__NUM_toPrecision");
        const tlsSym = this.getFunctionSymbolForModule(shimMeta, "__NUM_toLocaleString");
        if (!this.ctx.functions[expSym] || !this.ctx.functions[preSym]) return;
        for (const moduleAst of this._moduleOrder) {
            const meta = this.getModuleMeta(moduleAst);
            if (meta === shimMeta) continue;
            let hasShimImport = false;
            for (const stmt of moduleAst.body) {
                if (stmt.type === "ImportDeclaration" && stmt.source &&
                    stmt.source.value === "__number_shim") { hasShimImport = true; break; }
            }
            if (!hasShimImport) continue;
            if (!meta.functionAliases["__NUM_toExponential"]) meta.functionAliases["__NUM_toExponential"] = expSym;
            if (!meta.functionAliases["__NUM_toPrecision"]) meta.functionAliases["__NUM_toPrecision"] = preSym;
            if (tlsSym && this.ctx.functions[tlsSym] && !meta.functionAliases["__NUM_toLocaleString"]) {
                meta.functionAliases["__NUM_toLocaleString"] = tlsSym;
            }
        }
    }

    // Date 本地化 shim 别名注册(机理同 registerNumberShimAliases)。
    registerDateShimAliases() {
        let shimMeta = null;
        for (const moduleAst of this._moduleOrder) {
            const fn = moduleAst.filename;
            if (typeof fn === "string" && fn.indexOf("__date_shim.js") !== -1) {
                shimMeta = this.getModuleMeta(moduleAst);
                break;
            }
        }
        if (!shimMeta) return;
        const names = ["__DATE_toLocaleString", "__DATE_toLocaleDateString", "__DATE_toLocaleTimeString",
                       "__DATE_toUTCString", "__DATE_toDateString"];
        const syms = {};
        for (const nm of names) {
            const sym = this.getFunctionSymbolForModule(shimMeta, nm);
            if (!this.ctx.functions[sym]) return;
            syms[nm] = sym;
        }
        for (const moduleAst of this._moduleOrder) {
            const meta = this.getModuleMeta(moduleAst);
            if (meta === shimMeta) continue;
            let hasShimImport = false;
            for (const stmt of moduleAst.body) {
                if (stmt.type === "ImportDeclaration" && stmt.source &&
                    stmt.source.value === "__date_shim") { hasShimImport = true; break; }
            }
            if (!hasShimImport) continue;
            for (const nm of names) {
                if (!meta.functionAliases[nm]) meta.functionAliases[nm] = syms[nm];
            }
        }
    }

    getFunctionLabel(name) {
        // 安全检查：如果名称不在已注册的函数列表中，返回 null
        // 这可以防止 namespace import（如 AST）被误认为是函数调用
        if (!this.ctx.hasFunction(name)) {
            return null;
        }
        const symbol = this.ctx.getFunctionSymbol(name) || name;
        return "_user_" + symbol;
    }

    withModuleCompileContext(moduleMeta, callback) {
        const savedCtx = this.ctx;
        const savedSourcePath = this.sourcePath;
        const savedModuleAst = this._currentModuleAst;

        const moduleCtx = savedCtx.clone("module_" + moduleMeta.index);
        moduleCtx.locals = {};
        moduleCtx.varTypes = {};
        moduleCtx.varInitExprs = {};
        moduleCtx.stackOffset = 0;
        moduleCtx.scopeDepth = 0;
        moduleCtx.breakLabel = null;
        moduleCtx.continueLabel = null;
        moduleCtx.returnLabel = savedCtx.returnLabel;
        moduleCtx.boxedVars = moduleMeta.boxedVars;
        moduleCtx.mainCapturedVars = Object.assign({}, moduleMeta.mainCapturedVars);
        moduleCtx.functionAliases = Object.assign({}, moduleMeta.functionAliases);

        this.ctx = moduleCtx;
        this.sourcePath = moduleMeta.ast.filename;
        this._currentModuleAst = moduleMeta.ast;

        try {
            return callback(moduleCtx);
        } finally {
            this.ctx = savedCtx;
            this.sourcePath = savedSourcePath;
            this._currentModuleAst = savedModuleAst;
        }
    }

    // ========== 导入处理 ==========

    compileImportLibDeclaration(stmt) {
        let jslibPath = stmt.libPath;
        let libInfo = parseJslibFile(jslibPath, this.sourcePath, this.target);
        if (libInfo) {
            if (!this.libManager.isLibraryLoaded(libInfo.fullPath, libInfo.type)) {
                if (libInfo.type === "static") {
                    this.addStaticLib(libInfo);
                    console.log("Loaded static library: " + libInfo.name);
                } else {
                    this.addExternalLib(libInfo);
                    console.log("Loaded shared library: " + libInfo.name);
                }
                console.log("  Path: " + libInfo.fullPath);
                console.log("  Symbols: " + libInfo.symbols.join(", "));
            }
        }
    }

    // 初始化导入绑定：将导入的标识符绑定到从模块注册表获取的值
    // 这解决了 ImportDeclaration 被跳过时导入绑定未初始化的问题
    compileImportBindingInitialization(stmt) {
        const importSource = stmt.source && stmt.source.value;
        if (!importSource) return;

        const resolvedPath = resolveModulePath(importSource, this.sourcePath, this.nodeShimPath, path, fs);
        if (!resolvedPath) {
            return; // 暂不支持其他类型的导入
        }

        // 找到对应的模块记录
        const currentModuleAst = this._currentModuleAst;
        const importRecord = this.getImportRecordForStatement(currentModuleAst, stmt, resolvedPath);
        if (!importRecord) return;

        const { specifiers } = importRecord.importInfo;

        for (const spec of specifiers) {
            // Handle namespace import: type=ImportNamespaceSpecifier with namespace=true
            const isNamespace = spec.type === "ImportNamespaceSpecifier" || spec.namespace === true;
            if (isNamespace) {
                // import * as x from "module" (namespace import)
                const localName = spec.local && spec.local.name;
                if (!localName) continue;

                // Allocate local slot if not exists (for namespace imports at top level)
                const offset = this.ctx.getLocal(localName);
                const needsBox = this.ctx.boxedVars && this.ctx.boxedVars.has(localName);
                let actualOffset = offset;
                if (!actualOffset && !needsBox) {
                    actualOffset = this.ctx.allocLocal(localName);
                }

                const globalLabel = this.ctx.getMainCapturedVar(localName);
                if (needsBox && !globalLabel) {
                    continue;
                } else if (!needsBox && !actualOffset) {
                    continue;
                }

                // Use resolvedPath to find the actual source module index
                const sourceModuleIndex = this.findModuleIndexByPath(resolvedPath);

                this.vm.movImm(VReg.A0, sourceModuleIndex);
                const nameLabel = this.asm.addString("*");
                this.vm.lea(VReg.A1, nameLabel);
                this.vm.call("_get_module_export");

                if (needsBox) {
                    this.vm.lea(VReg.V2, globalLabel);
                    this.vm.load(VReg.V2, VReg.V2, 0);
                    this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.RET);
                } else {
                    this.vm.store(VReg.FP, actualOffset, VReg.RET);
                }
            } else if (spec.type === "ImportDefaultSpecifier" || spec.default === true) {
                const localName = spec.local && spec.local.name;
                if (!localName) continue;

                const globalLabel = this.ctx.getMainCapturedVar(localName);
                const offset = this.ctx.getLocal(localName);
                const needsBox = this.ctx.boxedVars && this.ctx.boxedVars.has(localName);
                let actualOffset = offset;

                if (!actualOffset && !needsBox) {
                    actualOffset = this.ctx.allocLocal(localName);
                }

                if (needsBox && !globalLabel) {
                    continue;
                } else if (!needsBox && !actualOffset) {
                    continue;
                }

                // Use resolvedPath to find the actual source module index
                const sourceModuleIndex = this.findModuleIndexByPath(resolvedPath);
                const resolvedRef = this.resolveModuleExportReferenceByPath(resolvedPath, "default");

                if (resolvedRef && resolvedRef.kind === "cell") {
                    const sourceLabel = resolvedRef.moduleMeta.mainCapturedVars[resolvedRef.localName];
                    if (sourceLabel) {
                        this.vm.lea(VReg.V2, sourceLabel);
                        this.vm.load(VReg.V2, VReg.V2, 0);
                        if (needsBox) {
                            if (globalLabel) {
                                this.vm.lea(VReg.V1, globalLabel);
                                this.vm.store(VReg.V1, 0, VReg.V2);
                            } else {
                                if (!actualOffset) {
                                    actualOffset = this.ctx.allocLocal(localName);
                                }
                                this.vm.store(VReg.FP, actualOffset, VReg.V2);
                            }
                        } else {
                            this.vm.store(VReg.FP, actualOffset, VReg.V2);
                        }
                        continue;
                    }
                } else if (resolvedRef && resolvedRef.kind === "namespace") {
                    this.loadModuleNamespacePointer(resolvedRef.sourceModuleIndex, VReg.V0);
                    this.vm.emitMaskLoad(VReg.V1);
                    this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                    this.vm.or(VReg.RET, VReg.V0, VReg.V1);

                    if (needsBox) {
                        this.vm.lea(VReg.V2, globalLabel);
                        this.vm.load(VReg.V2, VReg.V2, 0);
                        this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.RET);
                    } else {
                        this.vm.store(VReg.FP, actualOffset, VReg.RET);
                    }
                    continue;
                }

                this.vm.movImm(VReg.A0, sourceModuleIndex);
                const nameLabel = this.asm.addString("default");
                this.vm.lea(VReg.A1, nameLabel);
                this.vm.call("_get_module_export");

                if (needsBox) {
                    this.vm.lea(VReg.V2, globalLabel);
                    this.vm.load(VReg.V2, VReg.V2, 0);
                    this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.RET);
                } else {
                    this.vm.store(VReg.FP, actualOffset, VReg.RET);
                }
            } else if (spec.type === "ImportSpecifier") {
                // import { localName } from "module" (named import)
                const localName = spec.local && spec.local.name;
                const importedName = spec.imported && (spec.imported.name || spec.imported.value);

                if (!localName || !importedName) continue;

                const globalLabel = this.ctx.getMainCapturedVar(localName);
                const offset = this.ctx.getLocal(localName);
                const needsBox = this.ctx.boxedVars && this.ctx.boxedVars.has(localName);
                let actualOffset = offset;

                // Allocate local slot if not exists (for named imports at top level)
                if (!actualOffset && !needsBox) {
                    actualOffset = this.ctx.allocLocal(localName);
                }

                if (needsBox && !globalLabel) {
                    continue;
                } else if (!needsBox && !actualOffset) {
                    continue;
                }

                // Use resolvedPath to find the actual source module index
                const sourceModuleIndex = this.findModuleIndexByPath(resolvedPath);
                const resolvedRef = this.resolveModuleExportReferenceByPath(resolvedPath, importedName);

                if (resolvedRef && resolvedRef.kind === "cell") {
                    const sourceLabel = resolvedRef.moduleMeta.mainCapturedVars[resolvedRef.localName];
                    if (sourceLabel) {
                        this.vm.lea(VReg.V2, sourceLabel);
                        this.vm.load(VReg.V2, VReg.V2, 0);
                        if (needsBox) {
                            if (globalLabel) {
                                this.vm.lea(VReg.V1, globalLabel);
                                this.vm.store(VReg.V1, 0, VReg.V2);
                            } else {
                                if (!actualOffset) {
                                    actualOffset = this.ctx.allocLocal(localName);
                                }
                                this.vm.store(VReg.FP, actualOffset, VReg.V2);
                            }
                        } else {
                            this.vm.store(VReg.FP, actualOffset, VReg.V2);
                        }
                        continue;
                    }
                } else if (resolvedRef && resolvedRef.kind === "namespace") {
                    this.loadModuleNamespacePointer(resolvedRef.sourceModuleIndex, VReg.V0);
                    this.vm.emitMaskLoad(VReg.V1);
                    this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                    this.vm.or(VReg.RET, VReg.V0, VReg.V1);

                    if (needsBox) {
                        this.vm.lea(VReg.V2, globalLabel);
                        this.vm.load(VReg.V2, VReg.V2, 0);
                        this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.RET);
                    } else {
                        this.vm.store(VReg.FP, actualOffset, VReg.RET);
                    }
                    continue;
                }

                this.vm.movImm(VReg.A0, sourceModuleIndex);
                const nameLabel = this.asm.addString(importedName);
                this.vm.lea(VReg.A1, nameLabel);
                this.vm.call("_get_module_export");

                if (needsBox) {
                    this.vm.lea(VReg.V2, globalLabel);
                    this.vm.load(VReg.V2, VReg.V2, 0);
                    this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.RET);
                } else {
                    this.vm.store(VReg.FP, actualOffset, VReg.RET);
                }
            }
        }
    }

    // 查找模块在 moduleOrder 中的索引
    findModuleIndex(moduleAst) {
        if (!this._moduleOrder) return 0;
        for (let i = 0; i < this._moduleOrder.length; i++) {
            if (this._moduleOrder[i] === moduleAst) return i;
        }
        return 0;
    }

    // 根据文件路径查找模块在 moduleOrder 中的索引
    findModuleIndexByPath(resolvedPath) {
        if (!this._moduleOrder) return 0;
        // path -> 下标 索引;_moduleOrder 长度变化时重建(resolveImports 期间会增长)
        if (!this._moduleIndexByPath || this._moduleIndexByPathLen !== this._moduleOrder.length) {
            const idx = new Map();
            for (let i = 0; i < this._moduleOrder.length; i++) {
                const fn = this._moduleOrder[i].filename;
                if (fn !== undefined && !idx.has(fn)) idx.set(fn, i); // 保留首个匹配(与原线性扫一致)
            }
            this._moduleIndexByPath = idx;
            this._moduleIndexByPathLen = this._moduleOrder.length;
        }
        const r = this._moduleIndexByPath.get(resolvedPath);
        return r === undefined ? 0 : r;
    }

    getImportRecordForStatement(moduleAst, stmt, resolvedPath = null) {
        if (!this.imports) return null;
        return this.imports.find(
            (rec) => rec.importInfo &&
                rec.importInfo.stmt === stmt &&
                rec.importInfo.moduleAst === moduleAst &&
                (resolvedPath === null || rec.importInfo.resolvedPath === resolvedPath)
        ) || null;
    }

    getImportBindingForLocal(moduleAst, localName) {
        if (!this.imports || !moduleAst || !localName) return null;
        // per-module 的 localName -> binding 索引(原为 O(imports×specifiers×modules) 每次调用)。
        // imports 长度变化则整体失效重建(resolveImports 期间会增长)。
        if (this._importCacheLen !== this.imports.length) {
            this._importBindingCache = new Map();
            this._importCacheLen = this.imports.length;
        }
        let m = this._importBindingCache.get(moduleAst);
        if (!m) {
            m = new Map();
            for (const rec of this.imports) {
                if (!rec.importInfo || rec.importInfo.moduleAst !== moduleAst) continue;
                const sourceModuleIndex = this.findModuleIndexByPath(rec.importInfo.resolvedPath);
                for (const spec of rec.importInfo.specifiers || []) {
                    const specLocalName = spec.local && spec.local.name;
                    if (!specLocalName || m.has(specLocalName)) continue; // 保留首个匹配
                    const isNamespace = spec.type === "ImportNamespaceSpecifier" || spec.namespace === true;
                    const isDefault = spec.type === "ImportDefaultSpecifier" || spec.default === true;
                    const importedName = isNamespace
                        ? "*"
                        : (isDefault
                            ? "default"
                            : spec.imported && (spec.imported.name || spec.imported.value));
                    m.set(specLocalName, {
                        sourceModuleIndex,
                        resolvedPath: rec.importInfo.resolvedPath,
                        isNamespace,
                        importedName
                    });
                }
            }
            this._importBindingCache.set(moduleAst, m);
        }
        const b = m.get(localName);
        return b === undefined ? null : b;
    }

    getModuleBindingKind(moduleAst, name) {
        if (!moduleAst || !name) return null;
        // per-module 的 name -> kind 索引:首次调用扫一遍 body 建表,之后 O(1)
        // (原为每次调用全扫 body → O(body×names))。moduleAst 在一次编译内不变,故不失效。
        let m = this._bindingKindCache.get(moduleAst);
        if (!m) {
            m = new Map();
            const put = (n, kind) => { if (n && !m.has(n)) m.set(n, kind); }; // 保留首个匹配(body 顺序)
            for (const stmt of moduleAst.body || []) {
                if (stmt.type === "ImportDeclaration") {
                    for (const spec of stmt.specifiers || []) {
                        if (spec.local && spec.local.name) put(spec.local.name, "import");
                    }
                    continue;
                }
                const decl = stmt.type === "ExportDeclaration" && stmt.declaration ? stmt.declaration : stmt;
                if (!decl) continue;
                if (decl.type === "VariableDeclaration") {
                    for (const item of decl.declarations || []) {
                        if (item.id && item.id.type === "Identifier") put(item.id.name, "variable");
                    }
                } else if (decl.type === "FunctionDeclaration" && decl.id) {
                    put(decl.id.name, "function");
                } else if (decl.type === "ClassDeclaration" && decl.id) {
                    put(decl.id.name, "class");
                }
            }
            this._bindingKindCache.set(moduleAst, m);
        }
        const k = m.get(name);
        return k === undefined ? null : k;
    }

    isLiveLocalExportBinding(moduleMeta, localName) {
        return this.getModuleBindingKind(moduleMeta && moduleMeta.ast, localName) === "variable";
    }

    resolveModuleExportReference(moduleMeta, exportName, seen = new Set()) {
        if (!moduleMeta || !exportName) return null;

        const key = `${moduleMeta.index}:${exportName}`;
        if (seen.has(key)) {
            return null;
        }
        seen.add(key);

        const exp = (moduleMeta.exports || []).find((candidate) => candidate.name === exportName);
        if (!exp) {
            return null;
        }

        if (exp.namespace === true && exp.sourceModuleIndex !== undefined) {
            return {
                kind: "namespace",
                sourceModuleIndex: exp.sourceModuleIndex,
                moduleMeta
            };
        }

        if (exp.kind === "reexport" && exp.sourceModuleIndex !== undefined) {
            const sourceAst = this._moduleOrder[exp.sourceModuleIndex];
            const sourceMeta = this.getModuleMeta(sourceAst);
            return this.resolveModuleExportReference(sourceMeta, exp.importedName || exp.name, seen);
        }

        const localName = exp.localName || ((exp.kind === "const" || exp.kind === "local") ? exp.name : null);
        if (localName) {
            const importBinding = this.getImportBindingForLocal(moduleMeta.ast, localName);
            if (importBinding) {
                if (importBinding.isNamespace) {
                    return {
                        kind: "namespace",
                        sourceModuleIndex: importBinding.sourceModuleIndex,
                        moduleMeta
                    };
                }
                const sourceMeta = this.getModuleMetaByPath(importBinding.resolvedPath);
                return this.resolveModuleExportReference(sourceMeta, importBinding.importedName, seen);
            }

            if (this.isLiveLocalExportBinding(moduleMeta, localName)) {
                return {
                    kind: "cell",
                    moduleMeta,
                    localName
                };
            }
        }

        return {
            kind: exp.kind || "value",
            moduleMeta,
            localName
        };
    }

    resolveModuleExportReferenceByPath(resolvedPath, exportName) {
        const moduleMeta = this.getModuleMetaByPath(resolvedPath);
        return this.resolveModuleExportReference(moduleMeta, exportName);
    }

    markLiveModuleBindings() {
        for (const moduleAst of this._moduleOrder) {
            const moduleMeta = this.getModuleMeta(moduleAst);

            for (const exp of moduleMeta.exports || []) {
                const localName = exp.localName || ((exp.kind === "const" || exp.kind === "local") ? exp.name : null);
                if (localName && this.isLiveLocalExportBinding(moduleMeta, localName)) {
                    moduleMeta.boxedVars.add(localName);
                }
            }

            for (const stmt of moduleAst.body || []) {
                if (stmt.type !== "ImportDeclaration") continue;

                const importRecord = this.getImportRecordForStatement(moduleAst, stmt);
                if (!importRecord) continue;

                for (const spec of importRecord.importInfo.specifiers || []) {
                    const isNamespace = spec.type === "ImportNamespaceSpecifier" || spec.namespace === true;
                    const localName = spec.local && spec.local.name;
                    if (!localName) continue;

                    // 对于命名空间导入：如果它被闭包捕获（已在 boxedVars 中），需要分配全局存储位置
                    // 对于普通导入：只有当导入的绑定是 cell 类型时才需要 boxed
                    if (isNamespace) {
                        // 命名空间导入：检查它是否已被闭包分析标记为需要 boxed
                        // 如果是，确保它在 boxedVars 中（analyzeTopLevelSharedVariables 应该已经处理了）
                        // 注意：我们不再强制添加到 boxedVars，因为闭包分析已经处理了
                        continue; // 命名空间导入的 boxedVars 由 analyzeTopLevelSharedVariables 处理
                    }

                    const importedName = (spec.type === "ImportDefaultSpecifier" || spec.default === true)
                        ? "default"
                        : spec.imported && (spec.imported.name || spec.imported.value);


                    if (!importedName) continue;

                    const resolvedRef = this.resolveModuleExportReferenceByPath(importRecord.importInfo.resolvedPath, importedName);
                    if (resolvedRef && resolvedRef.kind === "cell") {
                        moduleMeta.boxedVars.add(localName);
                    }
                }
            }
        }
    }

    getResolvedExportPropagationTargets(sourceModuleMeta, sourceLocalName) {
        if (!sourceModuleMeta || !sourceLocalName || !this._moduleOrder) return [];

        // 反向索引:把「每个模块的每个具名导出 → 其解析到的 cell 目标(模块+localName)」
        // 扫一遍分桶。原实现对每个 (源模块,源名) 都全扫所有模块×导出并逐个 resolve
        // → O(callers × modules × exports)(实测 codegen 阶段最大热点)。建索引后查表 O(1)。
        // codegen 阶段 module exports 已定稿,故整个编译只建一次。
        if (!this._propTargetIndex) {
            const index = new Map();
            for (const moduleAst of this._moduleOrder) {
                const moduleMeta = this.getModuleMeta(moduleAst);
                if (!moduleMeta) continue;
                for (const exp of moduleMeta.exports || []) {
                    if (!exp || exp.kind === "star" || exp.namespace === true) continue;
                    const resolvedRef = this.resolveModuleExportReference(moduleMeta, exp.name);
                    if (!resolvedRef || resolvedRef.kind !== "cell" || !resolvedRef.moduleMeta) continue;
                    const key = `${resolvedRef.moduleMeta.index}:${resolvedRef.localName}`;
                    let arr = index.get(key);
                    if (!arr) { arr = []; index.set(key, arr); }
                    arr.push({ moduleIndex: moduleMeta.index, exportName: exp.name, srcIndex: moduleMeta.index });
                }
            }
            this._propTargetIndex = index;
        }

        const arr = this._propTargetIndex.get(`${sourceModuleMeta.index}:${sourceLocalName}`);
        if (!arr) return [];
        const targets = [];
        const seen = new Set();
        for (const t of arr) {
            if (t.srcIndex === sourceModuleMeta.index) continue; // 原逻辑:跳过自指模块
            const key = `${t.moduleIndex}:${t.exportName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push({ moduleIndex: t.moduleIndex, exportName: t.exportName });
        }
        return targets;
    }

    writeModuleNamespaceExportValueFromStack(moduleIndex, exportName) {
        const vm = this.vm;

        this.loadModuleNamespacePointer(moduleIndex, VReg.V2);
        const keyLabel = this.asm.addString(exportName);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.V2, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.lea(VReg.V1, keyLabel);
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V1, VReg.V0);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.call("_object_set");
    }

    emitUninitializedBindingGuard(name, valueReg = VReg.RET) {
        if (!name) return;

        const vm = this.vm;
        const okLabel = this.ctx.newLabel("binding_ready");
        const tmpReg = valueReg === VReg.V1 ? VReg.V0 : VReg.V1;

        vm.movImm64(tmpReg, UNINITIALIZED_BINDING_SENTINEL);
        vm.cmp(valueReg, tmpReg);
        vm.jne(okLabel);

        // 块级 let/const 经 blockscope.js 改名为 `name$blk$N`,报错信息还原用户名
        let displayName = name;
        const blkCut = typeof name === "string" ? name.indexOf("$blk$") : -1;
        if (blkCut !== -1) displayName = name.slice(0, blkCut);
        const msgLabel = this.asm.addString(`ReferenceError: Cannot access '${displayName}' before initialization`);
        vm.lea(VReg.A0, msgLabel);
        vm.call("_print_str");
        vm.movImm(VReg.A0, 1);
        if (this.arch === "arm64") {
            vm.syscall(this.os === "linux" ? 93 : 1);
        } else {
            vm.syscall(this.os === "linux" ? 60 : 0x2000001);
        }

        vm.label(okLabel);
    }

    syncModuleExportBinding(localName, valueReg = VReg.RET) {
        const moduleMeta = this.getModuleMeta(this._currentModuleAst);
        if (!moduleMeta || !localName) return;

        const namespaceTargets = [];
        const seenTargets = new Set();
        const addNamespaceTarget = (moduleIndex, exportName) => {
            const key = `${moduleIndex}:${exportName}`;
            if (seenTargets.has(key)) return;
            seenTargets.add(key);
            namespaceTargets.push({ moduleIndex, exportName });
        };

        for (const exp of moduleMeta.exports || []) {
            if (exp.kind === "reexport" || exp.kind === "star") continue;
            const exportLocalName = exp.localName || ((exp.kind === "const" || exp.kind === "local") ? exp.name : null);
            if (exportLocalName === localName) {
                addNamespaceTarget(moduleMeta.index, exp.name);
            }
        }

        for (const target of this.getResolvedExportPropagationTargets(moduleMeta, localName)) {
            addNamespaceTarget(target.moduleIndex, target.exportName);
        }

        if (namespaceTargets.length === 0) return;

        const vm = this.vm;
        vm.push(valueReg);
        for (const target of namespaceTargets) {
            this.writeModuleNamespaceExportValueFromStack(target.moduleIndex, target.exportName);
        }
        vm.pop(valueReg);
    }

    isExternalSymbol(name) {
        // 检查动态库
        if (this.libManager.isExternalSymbol(name)) return true;
        // 检查静态库
        for (const lib of this.staticLibs) {
            if (lib.symbols && lib.symbols.includes(name)) {
                return true;
            }
        }
        return false;
    }

    getExternalLibInfo(name) {
        const lib = this.libManager.getLibraryForSymbol(name);
        if (lib) return lib;
        // 检查静态库
        for (const lib of this.staticLibs) {
            if (lib.symbols && lib.symbols.includes(name)) {
                return lib;
            }
        }
        return null;
    }

    registerExternalLib(libInfo) {
        this.libManager.registerDylib(libInfo.fullPath);
    }

    getDylibIndex(dylibPath) {
        return this.libManager.getDylibIndex(dylibPath);
    }

    // ========== 编译流程 ==========

    nextLabelId() {
        return this.labelCounter++;
    }

    parse(source) {
        const lexer = new Lexer(source);
        const parser = new Parser(lexer);
        const ast = parser.parseProgram();
        if (parser.errors && parser.errors.length > 0) {
            throw new Error("Syntax errors:\n  " + parser.errors.join("\n  "));
        }
        // [批次D] 块级作用域前置改名(let/const shadowing + TDZ 标记):
        // 在闭包分析/编译前跑,使所有按名解析的下游消费者天然一致。
        renameBlockScopedBindings(ast);
        return ast;
    }

    compile(source) {
        const ast = this.parse(source);
        // [支柱②] 去虚拟化全图预登记:任何代码发射前,沿 import 图只解析(不发射)登记
        // 全部类——注册表完备,"子类覆写守卫"可证(this.m() 仅在类无已注册子类时去虚拟化)。
        // x64 门:跳过(见 functions.js _devirtualizeCall 注;x64 下 prepass/分析/发射全关)。
        if (this.arch !== "x64") {
            this._devirtPrepass(ast, this.sourcePath || path.resolve("."));
        }

        if (this.outputType === "shared" || this.outputType === "static") {
            this.generateSharedLibraryRuntime();
            this.compileProgramForLibrary(ast);
        } else {
            this.generateEntry();
            this.generateRuntime();
            this.compileProgram(ast);

            if (this.staticLibs && this.staticLibs.length > 0) {
                this.embedStaticLibraries();
            }
        }

        return this.generateExecutable();
    }

    // [支柱②] 沿 import 图只解析不发射,登记全部类声明(_devirtRegisterClass)。
    // 同名类跨模块冲突一律投毒弃表(防跨模块同名类方法错配,v1.5.47 标签冲突同族风险)。
    _devirtPrepass(mainAst, mainPath) {
        if (!this._devirtClasses) this._devirtClasses = {};
        if (!this._devirtPoisoned) this._devirtPoisoned = {};
        const seen = new Set();
        const visit = (ast, filePath) => {
            if (!ast || !ast.body) return;
            for (const stmt of ast.body) {
                if (stmt.type === "ClassDeclaration" && stmt.id && stmt.id.name) {
                    this._devirtRegisterClass(stmt, filePath);
                } else if ((stmt.type === "ImportDeclaration" ||
                            (stmt.type === "ExportNamedDeclaration" && stmt.source) ||
                            (stmt.type === "ExportAllDeclaration" && stmt.source)) && stmt.source) {
                    const spec = stmt.source.value;
                    if (!spec) continue;
                    const resolved = resolveModulePath(spec, path.dirname(filePath), this.nodeShimPath, path, fs);
                    if (resolved && !seen.has(resolved)) {
                        seen.add(resolved);
                        try {
                            const mAst = this.parse(this.readModuleSource(resolved));
                            this._devirtScanShadows(mAst);
                            visit(mAst, resolved);
                        } catch (e) { /* 模块读取/解析失败由编译主路径报告 */ }
                    }
                }
            }
        };
        seen.add(mainPath);
        visit(mainAst, mainPath);
        // 全图实例属性遮蔽扫描(与登记共用同一批已解析 AST 之前按模块各自扫)
        this._devirtScanShadows(mainAst);
    }

    // 全图扫描实例属性遮蔽:任何 `<o>.X = <函数值>` 赋值把 X 记入全局遮蔽集——实例自有
    // 属性优先于原型方法,此类方法名一律拒去虚拟化(防把原型方法标签错当实例覆写值,
    // stream 的 this._read = options.read / r._read = fn 形态)。
    _devirtScanShadows(node) {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) this._devirtScanShadows(node[i]);
            return;
        }
        if (node.type === "AssignmentExpression" && node.left &&
            node.left.type === "MemberExpression" && !node.left.computed &&
            node.left.property && node.left.property.type === "Identifier" &&
            node.right && (node.right.type === "FunctionExpression" ||
                           node.right.type === "ArrowFunctionExpression" ||
                           node.right.type === "Identifier" ||
                           node.right.type === "MemberExpression")) {
            // RHS 为 函数/标识符/成员读 → 可能是函数值(this._read = options.read 形态);
            // 字面量/对象/数组/new/调用结果视为数据值,不遮蔽(保住 this.count=0 等)
            if (!this._devirtShadowed) this._devirtShadowed = {};
            this._devirtShadowed[node.left.property.name] = true;
        }
        for (const k in node) {
            const v = node[k];
            if (v && typeof v === "object") this._devirtScanShadows(v);
        }
    }

    // 登记单个类:方法名(发射期补标签)、父类/子类链、构造器与方法体内的 this.f = new X()
    // 字段类型(同类多次不同类赋值 → 弃字段条目,防分支多形态误判)。
    _devirtRegisterClass(stmt, filePath) {
        const className = stmt.id.name;
        const existing = this._devirtClasses[className];
        if (existing && existing.__file !== filePath) {
            // 跨模块同名类:投毒,拒登记(发射期见此名同样拒)
            this._devirtPoisoned[className] = true;
            delete this._devirtClasses[className];
            return;
        }
        if (this._devirtPoisoned[className]) return;
        const dv = existing || { labelId: null, superName: null, methods: {}, fieldTypes: {}, subClasses: [] };
        dv.__file = filePath;
        dv.superName = (stmt.superClass && stmt.superClass.type === "Identifier") ? stmt.superClass.name : null;
        const scanThisNew = (stmts) => {
            if (!stmts) return;
            for (const st of stmts) {
                const e = st && st.expression;
                if (e && e.type === "AssignmentExpression" && e.operator === "=" &&
                    e.left && e.left.type === "MemberExpression" && !e.left.computed &&
                    e.left.object && e.left.object.type === "ThisExpression" &&
                    e.left.property && e.left.property.type === "Identifier" &&
                    e.right && e.right.type === "NewExpression" &&
                    e.right.callee && e.right.callee.type === "Identifier") {
                    const f = e.left.property.name;
                    const c = e.right.callee.name;
                    if (dv.fieldTypes[f] && dv.fieldTypes[f] !== c) {
                        delete dv.fieldTypes[f]; // 分支多形态(如 _initAssembler)→ 弃条目
                    } else if (!dv.fieldTypes[f]) {
                        dv.fieldTypes[f] = c;
                    }
                }
            }
        };
        for (const m of stmt.body) {
            if (m.type === "MethodDefinition") {
                if (!m.computed && m.key && m.key.type !== "PrivateIdentifier" &&
                    (!m.kind || m.kind === "method")) {
                    const mn = m.key.name || m.key.value;
                    if (mn && mn !== "constructor" && dv.methods[mn] === undefined) {
                        dv.methods[mn] = null; // 标签发射期补
                    }
                }
                if (m.value && m.value.body) scanThisNew(m.value.body.body);
            }
        }
        this._devirtClasses[className] = dv;
        if (dv.superName && this._devirtClasses[dv.superName]) {
            const sc = this._devirtClasses[dv.superName].subClasses;
            if (!sc.includes(className)) sc.push(className);
        }
    }


    // [#15 JSON shim 注入] 模块源码引用 JSON.stringify/parse 时,前置合成 import
    // (裸名 "__json_shim" 经 cwd/runtime/node/ 解析);调用点由
    // compileCallExpression 改派为 __JSON_stringify/__JSON_parse。
    // 用 indexOf 而非正则(本代码在 gen1 运行,§1.6 禁正则)。
    readModuleSource(filePath) {
        // 按 latin1(逐字节)读源,**不用 "utf-8"**。asm.js 字符串是逐字节的(fromCharCode 截为
        // 字节,无法承载真码点)。node 下 "utf-8" 解成码点(你=1 char),而自编译器/出厂产物的
        // readFileSync 忽略 encoding、拿原始字节(你=3 char)→ 字符串常量发射器对二者产不同字节
        // → 出厂编译器把非 ASCII 字面量 mojibake(双重 UTF-8)。两侧统一 latin1 读:词法器见相同
        // 原始 UTF-8 字节,\u/\x 转义经 lexer._cpToUtf8 展开成 UTF-8 字节,发射器逐字节透传
        // (asm/*.js),故源码字面量 UTF-8 字节原样进产物,node/g1 一致且正确、gen1==gen2==gen3。
        // ASCII 不受影响(字节==码点);编译器自身源 ASCII 干净(A 的 0da5ba69)。
        let src = fs.readFileSync(filePath, "latin1");
        // [W-35 Unicode 属性表按需发射] 每读一个模块就扫一遍「\ + p/P」;有则本次编译
        // 保留 __regexp_shim 的 Unicode 属性表(否则 compileProgram 里把表串置空)。
        // shim 自身除外:它的注释里就写着 \p{…}/\P{…},否则永远命中、优化恒不生效。
        // (表体只出现在 shim 里,用户模块的 \p 才是「程序可能用到属性转义」的证据。)
        if (filePath.indexOf("__regexp_shim.js") === -1 && sourceHasPropEscapeText(src)) {
            this._reUniPropSeen = true;
        }
        // CJS 检测在原始源码上(shim 注入会加 import 行、干扰判定)
        const isCjs = looksLikeCjsSource(src);
        // [CJS cyclic require] 记录每个文件是否本地 CJS,供 markCjsRequireCycles
        // 判定「require 环里的本地 CJS 模块」→ 惰性初始化。键用解析后的绝对路径,
        // 与 moduleAst.filename / _requirePath 对齐。
        if (!this._cjsFlags) this._cjsFlags = {};
        this._cjsFlags[filePath] = isCjs;
        // 同时按解析后的绝对路径登记一份:resolveImports 的 type:commonjs 门控以
        // ast.filename(绝对路径)查 _cjsFlags,而入口可能以相对路径传入 readModuleSource。
        // 缺这份绝对键会让“相对路径编译 type:commonjs 下的 CJS 入口”漏命中门控、被合成
        // export 误判为 ESM 而误拒。附加而非替换,markCjsRequireCycles/_requireExportKind
        // 使用的原键不受影响。
        const _absFilePath = path.resolve(filePath);
        if (_absFilePath !== filePath) this._cjsFlags[_absFilePath] = isCjs;
        // structuredClone(x) 在 functions.js 里被脱糖成 JSON.parse(JSON.stringify(x)),
        // 这些 __JSON_* 调用是 codegen 合成的、源码里无 "JSON.*" 文本 → 不会触发下面的
        // 注入,shim 缺失时合成调用静默失效(返回原对象别名,非深拷贝)。故把
        // "structuredClone" 也作为 JSON shim 的注入触发词。
        // [W7-2] 追加触发词 JSON.rawJSON/JSON.isRawJSON;含 raw 族文本的模块改注 4 名
        // import,否则维持原 2 名 —— 既有触发模块注入文本逐字不变(字节中性;全仓无
        // rawJSON 文本,grep 实证零命中)。
        if (filePath.indexOf("__json_shim.js") === -1 &&
            (src.indexOf("JSON.stringify") !== -1 || src.indexOf("JSON.parse") !== -1 ||
             src.indexOf("JSON.rawJSON") !== -1 || src.indexOf("JSON.isRawJSON") !== -1 ||
             src.indexOf("structuredClone") !== -1)) {
            const hasRaw = src.indexOf("JSON.rawJSON") !== -1 ||
                src.indexOf("JSON.isRawJSON") !== -1;
            const inj = hasRaw
                ? 'import { __JSON_stringify, __JSON_parse, __JSON_rawJSON, __JSON_isRawJSON } from "__json_shim";\n'
                : 'import { __JSON_stringify, __JSON_parse } from "__json_shim";\n';
            src = injectShimImport(src, inj);
        }
        // [批次D RegExp shim 注入] 源码含正则字面量或 RegExp 构造调用文本时,前置
        // __regexp_shim 的 import(路线同 JSON shim);二者由 expressions.js 编译为
        // __RE_new 调用,.test/.exec/match/replace 由 functions.js 分派为 __RE_* 调用。
        // 已显式 import __regexp_shim 的模块不重复注入。编译器自身源码刻意无正则字面量
        // 且不含 RegExp 构造文本 → 自举不注入(ASMJS_SHIM_DEBUG=1 可验证)。
        // (检测串拆开拼接,免得本文件自己命中。)
        // 调用形式 `RegExp(p, f)`(无 new,ES 规范等价于 new RegExp)由 functions.js
        // 改派成 __RE_new,但此前无注入触发词 → shim 未链入,构造既不校验也不抛错
        // (RegExp("(", "u") 静默不抛、.exec 全 undefined)。故追加调用形式触发。
        // 不用裸 indexOf("RegExp("):那会命中注释/字符串里的 "RegExp(" 文本(编译器
        // 自身 types.js / functions.js 的注释里就有)以及 myRegExp( 这类标识符后缀,
        // 让完全不用正则的程序白链入整个 regexp shim(纯体积损失)。改为
        // sourceHasRegExpCall:手写扫描(§1.6 禁正则),跳过字符串/模板文本/注释,
        // 只在代码位置按**整词**匹配 RegExp + 空白* + "("。放在 || 末位,故仅当前面
        // 三个廉价触发词都不命中时才扫描(此时源码必无正则字面量,"/" 一律按除法/
        // 注释处理是安全的)。
        const reCtorText = "new Reg" + "Exp(";
        const reEscText = "RegExp" + ".escape";
        if (filePath.indexOf("__regexp_shim.js") === -1 &&
            src.indexOf("__regexp_shim") === -1 &&
            (src.indexOf(reCtorText) !== -1 || src.indexOf(reEscText) !== -1 ||
             sourceHasRegexLiteral(src) || sourceHasRegExpCall(src))) {
            const inj = 'import { __RE_new, __RE_test, __RE_exec, __RE_match, __RE_matchAll, __RE_replace, __RE_split, __RE_escape, __RE_search, __RE_toString } from "__regexp_shim";\n';
            src = injectShimImport(src, inj);
            if (process.env.ASMJS_SHIM_DEBUG) {
                console.error("[shim] regexp shim injected: " + filePath);
            }
        }
        // [方言/Channel shim 注入] 源码含 Channel( 调用文本时前置
        // import { Channel } from "__channel_shim"(路线同 JSON/RegExp shim);用户直接
        // 调用导入绑定,无需调用点改派。(检测串拆开拼接,免得本文件自己命中。)
        const chCtorText = "Chan" + "nel(";
        if (filePath.indexOf("__channel_shim.js") === -1 &&
            src.indexOf("__channel_shim") === -1 &&
            src.indexOf(chCtorText) !== -1) {
            src = injectShimImport(src, 'import { Channel } from "__channel_shim";\n');
        }
        // [eval/new Function shim 注入] 源码引用全局 `eval(` 或 `new Function(` 时前置
        // `import { __eval, __makeFunction } from "__eval_shim"`(路线同 JSON/RegExp shim);
        // 调用点由 compileCallExpression / compileNewExpression 改派到这两个绑定。__eval_shim
        // 内含整个编译器(route B),故只有用 eval 的程序才付代价;编译器自身源码不含
        // `eval(`/`new Function(` → 自举不注入(gate 零影响)。(检测串拆开拼接,免本文件自命中。)
        const evalCallText = "eval" + "(";
        const newFnText = "new Func" + "tion(";
        if (filePath.indexOf("__eval_shim.js") === -1 &&
            src.indexOf("__eval_shim") === -1 &&
            (src.indexOf(evalCallText) !== -1 || src.indexOf(newFnText) !== -1)) {
            const inj = 'import { __eval, __makeFunction, __eval_direct } from "__eval_shim";\n';
            src = injectShimImport(src, inj);
            // [W-35] eval/new Function 的源码在编译期不可见,里面可以有 \p{…};
            // 用 eval 的程序一律保留 Unicode 属性表(保守)。
            this._reUniPropSeen = true;
            if (process.env.ASMJS_SHIM_DEBUG) {
                console.error("[shim] eval shim injected: " + filePath);
            }
        }
        // [Number shim] 源码用 toExponential/toPrecision 方法调用时前置注入 __number_shim
        // (路线同 JSON/eval shim);调用点由 compileCallExpression 改派到 __NUM_* 绑定。
        // 检测串拆开拼接,免本文件/codegen 自身的注释命中而误注入自举产物(gate 零影响)。
        const expMethodText = ".toExp" + "onential(";
        const preMethodText = ".toPre" + "cision(";
        const tlsMethodText = ".toLoca" + "leString(";
        if (filePath.indexOf("__number_shim.js") === -1 &&
            src.indexOf("__number_shim") === -1 &&
            (src.indexOf(expMethodText) !== -1 || src.indexOf(preMethodText) !== -1 ||
             src.indexOf(tlsMethodText) !== -1)) {
            src = injectShimImport(src, 'import { __NUM_toExponential, __NUM_toPrecision, __NUM_toLocaleString } from "__number_shim";\n');
        }
        // [Date shim] 源码用 toLocaleString/toLocaleDateString/toLocaleTimeString 方法时
        // 前置注入 __date_shim(路线同 Number shim);调用点由 compileCallExpression 在
        // 接收者静态 DATE 时改派到 __DATE_* 绑定。检测串拆开拼接,免自举产物误注入(编译器
        // 源无 toLocale* 方法,gate 零影响 → 零足迹)。
        const locStrText = ".toLocale" + "String(";
        const locDateText = ".toLocale" + "DateString(";
        const locTimeText = ".toLocale" + "TimeString(";
        const utcStrText = ".toUTC" + "String(";
        const gmtStrText = ".toGMT" + "String(";
        const dateStrText = ".toDate" + "String(";
        if (filePath.indexOf("__date_shim.js") === -1 &&
            src.indexOf("__date_shim") === -1 &&
            (src.indexOf(locStrText) !== -1 || src.indexOf(locDateText) !== -1 || src.indexOf(locTimeText) !== -1 ||
             src.indexOf(utcStrText) !== -1 || src.indexOf(gmtStrText) !== -1 || src.indexOf(dateStrText) !== -1)) {
            src = injectShimImport(src, 'import { __DATE_toLocaleString, __DATE_toLocaleDateString, __DATE_toLocaleTimeString, __DATE_toUTCString, __DATE_toDateString } from "__date_shim";\n');
        }
        // CommonJS 包裹:注入 module/exports/__filename/__dirname 前导,尾部追加
        // `export default module.exports` 使 CJS 值经 ESM 默认导出通道暴露,
        // require(x) codegen 读取该模块的 default(见 compileCallExpression)。
        if (isCjs) {
            src = this._wrapCjsSource(src, filePath);
        }
        return src;
    }

    _wrapCjsSource(src, filePath) {
        const dir = path.dirname(filePath);
        const pre = "const module = { exports: {} };\n" +
            "let exports = module.exports;\n" +
            "const __filename = " + cjsStringLiteral(filePath) + ";\n" +
            "const __dirname = " + cjsStringLiteral(dir) + ";\n";
        // 具名导出互操作:为 module.exports 的静态键合成 `export const k = module.exports.k`
        // 使 `import { k } from cjs` 与 namespace 都能取到(Node ESM-CJS 互操作行为)。
        let named = "";
        const keys = extractCjsNamedExportKeys(src);
        for (let i = 0; i < keys.length; i++) {
            named += "export const " + keys[i] + " = module.exports." + keys[i] + ";\n";
        }
        const post = "\n;\nexport default module.exports;\n" + named;
        // 尊重 shebang 首行
        if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
            const nl = src.indexOf("\n");
            return src.slice(0, nl + 1) + pre + src.slice(nl + 1) + post;
        }
        return pre + src + post;
    }

    compileFile(inputFile, outputFile) {
        const source = this.readModuleSource(inputFile);
        this.sourcePath = path.resolve(inputFile);

        if (!outputFile) {
            const baseName = path.basename(inputFile, ".js");
            outputFile = baseName + TARGETS[this.target].ext;
        }

        this.outputFileName = outputFile;
        const result = this.compile(source);

        if (result && result.type === "static") {
            const writeResult = this.writeStaticLibrary(result.objectData, outputFile);
            // 生成 jslib 声明文件 (除非禁用)
            if (!this.options.noJslib) {
                this.generateJslibFile(outputFile, "static");
            }
            return writeResult;
        }

        const binary = result;
        // node 下仍走 Buffer.from(原语义);asm.js 自举下直接传字节数组——fs shim 的
        // 数组分支逐字节写,省去 Buffer 构造的 1200 万次复制(12MB 产物),同时绕开
        // 该复制路径上的疑似 length 踩踏(产物尾部多写页对齐的堆邻居字节,见任务 #18)。
        // 判别:asm.js 运行时无 process.release。
        if (process.release) {
            fs.writeFileSync(outputFile, Buffer.from(binary));
        } else {
            fs.writeFileSync(outputFile, binary);
        }
        fs.chmodSync(outputFile, 0o755);

        // [LABEL_MAP] env 门控诊断:导出 label→代码段偏移表(采样剖析符号化用)。
        // 仅 gen0(node)诊断路径;asm.js 自举下 process.env 缺省为空对象不触发。
        if (process.env.LABEL_MAP && this.asm && this.asm.labels && this.asm.labels.forEach) {
            const lines = [];
            this.asm.labels.forEach((off, name) => { lines.push(off + "\t" + name); });
            lines.sort((a, b) => parseInt(a) - parseInt(b));
            fs.writeFileSync(process.env.LABEL_MAP, lines.join("\n") + "\n");
        }

        // 生成 jslib 声明文件 (仅共享库，除非禁用)
        if (this.outputType === "shared" && !this.options.noJslib) {
            this.generateJslibFile(outputFile, "shared");
        }

        return { output: outputFile, size: binary.length };
    }

    // 生成 .jslib 声明文件
    generateJslibFile(outputFile, libType) {
        const baseName = path.basename(outputFile);
        const dirName = path.dirname(outputFile);
        // 去掉 lib 前缀和扩展名得到基础名
        let libName = baseName;
        if (libName.startsWith("lib")) {
            libName = libName.substring(3);
        }
        let dotIdx = libName.lastIndexOf(".");
        if (dotIdx !== -1) {
            libName = libName.substring(0, dotIdx);
        }
        const jslibPath = path.join(dirName, libName + ".jslib");

        // 获取导出的函数列表
        const exportFuncs = this.exports.length > 0 ? this.exports : Object.keys(this.ctx.functions);

        // [layout-determinism] 生成文件的注释用 ASCII(英文):源码内非 ASCII 串字面量在
        // node(UTF-8 解码)与 asm.js(按字节读、不解 UTF-8)间产不同字节 → 自举 g1≠g2。
        const lines = [];
        lines.push(`// ${libName}.jslib - library declaration file`);
        lines.push(`// Auto-generated by asm.js`);
        lines.push(`// Usage: import * from "./${libName}.jslib"`);
        lines.push("");
        lines.push("// Library config");
        lines.push(`export const __lib__ = {`);
        lines.push(`    path: "./${libName}",`);
        if (libType === "static") {
            lines.push(`    type: "static",`);
        }
        lines.push(`};`);
        lines.push("");
        lines.push("// Exported function declarations");
        for (const name of exportFuncs) {
            lines.push(`export function ${name}();`);
        }
        lines.push("");

        fs.writeFileSync(jslibPath, lines.join("\n"));
        console.log(`Generated: ${jslibPath}`);
    }

    // ========== 运行时生成 ==========

    generateRuntime() {
        const allocGen = new AllocatorGenerator(this.vm);
        allocGen.generate();
        const runtimeGen = new RuntimeGenerator(this.vm, this.ctx);
        runtimeGen.generate();
        this.generateDataSection();
    }

    generateDataSection() {
        const numberGen = new NumberGenerator(this.vm, this.ctx);
        numberGen.generateDataSection(this.asm);
    }

    generateSharedLibraryRuntime() {
        // 共享库不需要完整运行时
    }

    // ========== 入口点和程序编译 ==========

    generateEntry() {
        const vm = this.vm;
        vm.label("_start");

        // wasm:无 OS 初始栈——先把影子栈指针置到线性内存里的栈顶(布局常量),
        // 后续 _stack_base 记录/GC 扫描与 native 完全同构。
        if (this.os === "wasi") {
            vm.movImm64(VReg.SP, WASM_STACK_TOP);
        }

        // 记录初始 SP 为 _stack_base（保守 GC 栈根扫描的上界）。
        // 在 prologue 之前取，捕获最高的栈顶；GC 时从当前 SP 扫到此处。
        vm.mov(VReg.V0, VReg.SP);
        vm.lea(VReg.V1, "_stack_base");
        vm.store(VReg.V1, 0, VReg.V0);

        // [M2 / G-M-P] 绑定 P/M 上下文寄存器(arm64 x28 = &_m0_context)。必须在任何
        // 会读 per-M 槽(exception/argc 等)的代码之前 → 放最前(prologue/_heap_init 之前)。
        // 用 V0 作 lea 目标不动 A0/A1(macOS 入口 argc/argv)。GOMAXPROCS=1 唯一 M;
        // 未来线程蹦床(M3)为各 M 绑各自块。x64/wasm 后端 no-op(§3.2 段 TLS 后续)。
        vm.lea(VReg.V0, "_m0_context");
        vm.bindMContext(VReg.V0);

        // [M2 / G-M-P] 初始化 per-M 指针化缓冲。已指针化的执行态槽在 M struct 只存一个指针,
        // 实际缓冲是 M0 静态区;此处把静态缓冲地址写入指针槽(arm64 lea 经 MCTX_PRINT_BUF
        // 重定向落 M struct,x64/wasm 落扁平槽,寻址一致)。须在 x28 绑定后、任何打印前;
        // 缓冲是静态数据,无需堆,故可先于 _heap_init。未来线程蹦床(M3)为各 M 各自 init。
        vm.lea(VReg.V0, "_print_buf_storage");
        vm.lea(VReg.V1, "_print_buf");
        vm.store(VReg.V1, 0, VReg.V0);

        // 保存 OS 传入的 argc 和 argv。
        // macOS (LC_MAIN 入口): argc=A0, argv=A1（寄存器传入）。
        // Linux (ELF 静态 _start): 内核把 argc/argv 放在栈上——入口 SP -> argc，
        //   argv 数组从 SP+8 起，且通用寄存器被清零。若沿用 A0/A1(=0) 会导致
        //   _process_create_argv 解引用 NULL argv → 启动即 SIGSEGV(si_addr=NULL)。
        //   原始 SP 已在上面存入 _stack_base，prologue 后从那里取回。
        vm.prologue(16, []);
        if (this.os === "windows") {
            // PE 入口不经 CRT:RCX/RDX 是垃圾(非 argc/argv)。置 argc=0/argv=NULL,
            // 否则 _process_create_argv 对垃圾指针 strlen → 启动即 page fault。
            // (真实命令行经 GetCommandLineA 在运行时构建 process.argv:
            //  runtime/core/process.js + backend/x64.js GetCommandLineA 调用点。)
            vm.movImm(VReg.A0, 0);
            vm.movImm(VReg.A1, 0);
        }
        if (this.os === "wasi") {
            // 宿主 shim 在调 _start 前按 POSIX 初始栈形状写好递交区(binary/wasm.js
            // WASM_ARGV_BASE):[+0]=argc,[+16..]=argv 指针数组+NULL+envp 数组+NULL+串。
            // 未写(旧宿主)时该页全 0 → argc=0、argv[0]=NULL、envp 空,与 M1 行为一致。
            // envp = argv+(argc+1)*8 的既有约定由该布局天然满足(_process_env_init)。
            vm.movImm64(VReg.V1, WASM_ARGV_BASE);
            vm.load(VReg.A0, VReg.V1, 0);    // argc
            vm.addImm(VReg.A1, VReg.V1, 16); // argv = char* 数组基址
        }
        if (this.os === "linux") {
            vm.lea(VReg.V1, "_stack_base");
            vm.load(VReg.V0, VReg.V1, 0); // V0 = 原始 SP = &argc
            vm.load(VReg.A0, VReg.V0, 0); // argc = [SP]
            vm.addImm(VReg.A1, VReg.V0, 8); // argv = SP + 8 (char** 数组起始)
        }
        vm.store(VReg.SP, 0, VReg.A0); // 保存 argc
        vm.store(VReg.SP, 8, VReg.A1); // 保存 argv

        vm.call("_heap_init");

        // Windows:堆就绪后用 GetCommandLineA 解析真实 argv(cli.js 自举需要 process.argv)。
        // 必须在 _heap_init 之后(_win_build_argv 用 _alloc)、_process_init 之前。
        if (this.os === "windows") {
            vm.call("_win_build_argv");     // RET = argc
            vm.mov(VReg.A0, VReg.RET);
            vm.lea(VReg.V1, "_win_argv_ptr");
            vm.load(VReg.A1, VReg.V1, 0);   // argv 数组基址
            vm.store(VReg.SP, 0, VReg.A0);
            vm.store(VReg.SP, 8, VReg.A1);
        }

        vm.call("_scheduler_init");

        // 初始化 process 对象
        vm.load(VReg.A0, VReg.SP, 0); // argc
        vm.load(VReg.A1, VReg.SP, 8); // argv
        vm.call("_process_init");

        // [函数元数据] 填充 code_ptr→kind 侧表(标签地址运行期经 lea 落表)。
        vm.call("_func_meta_init");

        vm.call("_main");
        // [#74] 同步 main 跑完后:协程调度 + Promise 反应微任务交替泵到定点。
        // 此前各跑一次:drain 里 _promise_resolve 唤醒(_scheduler_spawn)的 await 协程
        // 进就绪队列,但 _scheduler_run 已跑完不再回来 → `await p.then(f)` 的续体被
        // 静默丢弃(exit 0)。改:drain 返回排空数,>0 说明可能有新唤醒/新反应,回去
        // 再泵一轮 scheduler;直到 drain==0(就绪队列此时也必空)。首轮序与旧行为一致。
        // 位置在 _main(含 fs.writeFileSync 写产物)之后 → 不干扰同步写路径。
        vm.label("_exit_pump_loop");
        vm.call("_scheduler_run");
        vm.call("_promise_drain_reactions"); // RET = 排空的反应数
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_exit_pump_loop");
        // 退出前 drain 事件循环（微任务 / setImmediate / setTimeout(0)）
        vm.call("_ev_run");

        // [GC_STATS] env 门控的分配统计:heap 高水位 / GC 次数 / 分配次数 / 末次 GC 存活字节。
        // 仅诊断用,不影响正常构建。META 偏移:HEAP_USED=16, GC_COUNT=184, ALLOC_COUNT=192。
        if (process.env.GC_STATS) {
            const stat = (label, load) => {
                vm.lea(VReg.A0, this.asm.addString(label));
                vm.call("_print_str_no_nl");
                load();
                vm.call("_print_int");
            };
            stat("GCSTATS heap_used=", () => { vm.lea(VReg.V0, "_heap_meta"); vm.load(VReg.A0, VReg.V0, 16); });
            stat("GCSTATS heap_peak=", () => { vm.lea(VReg.V0, "_heap_meta"); vm.load(VReg.A0, VReg.V0, 200); });
            stat("GCSTATS gc_count=", () => { vm.lea(VReg.V0, "_heap_meta"); vm.load(VReg.A0, VReg.V0, 184); });
            stat("GCSTATS alloc_count=", () => { vm.lea(VReg.V0, "_heap_meta"); vm.load(VReg.A0, VReg.V0, 192); });
            stat("GCSTATS live_bytes=", () => { vm.lea(VReg.V0, "_gc_live_bytes"); vm.load(VReg.A0, VReg.V0, 0); });
        }

        vm.movImm(VReg.A0, 0);
        if (this.os === "windows") {
            vm.callWindowsExitProcess();
        } else if (this.os === "wasi") {
            vm.syscall(60); // wasi 号名空间 = linux-x64;宿主 shim 落 proc exit
        } else if (this.arch === "arm64") {
            vm.syscall(this.os === "linux" ? 93 : 1);
        } else {
            vm.syscall(this.os === "linux" ? 60 : 0x2000001);
        }
    }

    // 与 getFunctionLabel 类似，但不受 hasFunction 的
    // "同名捕获变量则不视为函数" 限定影响——用于导出填充/box 预填等
    // 需要拿到"声明本身"的场景（如 JStoCstring 被同模块函数捕获时）。
    getDeclaredFunctionLabel(name) {
        const symbol = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(name)) || name;
        if (this.ctx.functions && this.ctx.functions[symbol]) {
            return "_user_" + symbol;
        }
        return null;
    }

    emitFunctionBindingValue(name, targetReg = VReg.RET) {
        if (!name) return;

        const funcLabel = this.getFunctionLabel(name) || this.getDeclaredFunctionLabel(name);
        if (!funcLabel) {
            // 函数标签不存在，不生成闭包
            return;
        }

        const vm = this.vm;
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);

        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, funcLabel);
        vm.store(VReg.S0, 8, VReg.V1);

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        if (targetReg !== VReg.RET) {
            vm.mov(targetReg, VReg.RET);
        }
    }

    preinitializeModuleFunctionBindings(moduleMeta) {
        if (!moduleMeta) return;

        for (const name of moduleMeta.boxedVars || []) {
            const bindingKind = this.getModuleBindingKind(moduleMeta.ast, name);
            if (bindingKind !== "function" && bindingKind !== "class") {
                continue;
            }

            const label = moduleMeta.mainCapturedVars[name];
            if (!label) continue;

            this.emitFunctionBindingValue(name, VReg.V0);
            this.vm.lea(VReg.V1, label);
            this.vm.load(VReg.V1, VReg.V1, 0);
            this.vm.store(VReg.V1, BOX_VALUE_OFFSET, VReg.V0);
        }
    }

    // Node exposes URL/URLSearchParams as globals (no import needed). asm.js models
    // them as classes in runtime/node/url.js reachable only through an import. When a
    // user program references such a bare global that it hasn't otherwise bound,
    // synthesize `import { <name> } from "<module>"` at the top of the entry AST so the
    // normal import machinery resolves `new URL(...)` etc. Guarded against user
    // shadowing (their own class/function/var/import wins → no injection). The runtime
    // modules involved are not imported by the compiler itself → self-host safe.
    _injectImplicitGlobalImports(ast) {
        if (!ast || !Array.isArray(ast.body)) return;
        const IMPLICIT_GLOBALS = { URL: "url", URLSearchParams: "url", btoa: "util", atob: "util", Buffer: "buffer" };

        // Top-level bindings that would shadow an implicit global.
        const bound = new Set();
        for (const st of ast.body) {
            if (!st) continue;
            if (st.type === "ImportDeclaration") {
                for (const sp of (st.specifiers || [])) {
                    if (sp.local && sp.local.name) bound.add(sp.local.name);
                }
            } else if (st.type === "ClassDeclaration" || st.type === "FunctionDeclaration") {
                if (st.id && st.id.name) bound.add(st.id.name);
            } else if (st.type === "VariableDeclaration") {
                for (const d of (st.declarations || [])) {
                    if (d.id && d.id.type === "Identifier" && d.id.name) bound.add(d.id.name);
                }
            }
        }

        // Which implicit globals are actually referenced as value identifiers?
        const used = new Set();
        const names = Object.keys(IMPLICIT_GLOBALS);
        const walk = (node, parent, key) => {
            if (!node || typeof node !== "object") return;
            if (node.type === "Identifier" && names.indexOf(node.name) !== -1) {
                // Skip non-value positions: non-computed member property, object property
                // key, declaration id (those never denote the global binding).
                const isMemberProp = parent && parent.type === "MemberExpression" &&
                    parent.property === node && !parent.computed;
                const isPropKey = parent && (parent.type === "Property" || parent.type === "ObjectProperty") &&
                    parent.key === node && !parent.computed;
                if (!isMemberProp && !isPropKey) used.add(node.name);
            }
            for (const k in node) {
                if (k === "type" || (k.length && k[0] === "_")) continue;
                const v = node[k];
                if (v && typeof v === "object") {
                    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], node, k); }
                    else walk(v, node, k);
                }
            }
        };
        walk(ast, null, null);

        // Group the injected names by source module, skipping shadowed ones.
        const byModule = {};
        for (const name of names) {
            if (!used.has(name) || bound.has(name)) continue;
            const mod = IMPLICIT_GLOBALS[name];
            (byModule[mod] = byModule[mod] || []).push(name);
        }
        const mods = Object.keys(byModule);
        if (mods.length === 0) return;

        // Prepend a synthetic ImportDeclaration per source module. Build with an
        // explicit index loop and single-arg unshift — asm.js's own compiler does not
        // support `unshift(...spread)` (SpreadElement in a call), and this file is
        // self-compiled, so the synthesis must stay within the supported subset.
        for (let mi = mods.length - 1; mi >= 0; mi--) {
            const mod = mods[mi];
            const specs = [];
            const modNames = byModule[mod];
            for (let ni = 0; ni < modNames.length; ni++) {
                const name = modNames[ni];
                specs.push({
                    type: "ImportSpecifier",
                    local: { type: "Identifier", name },
                    imported: { type: "Identifier", name },
                    default: false,
                    namespace: false,
                });
            }
            ast.body.unshift({
                type: "ImportDeclaration",
                specifiers: specs,
                source: { type: "Literal", value: mod, raw: JSON.stringify(mod) },
            });
        }
    }

    // [W-35 Unicode 属性表按需发射] 程序里没有任何「\ + p/P」文本(见
    // sourceHasPropEscapeText)时,把 __regexp_shim 里那五个属性表的字符串字面量置空
    // ——只删数据,不删代码:表体约 84KB(区间串 __RE_UT 64KB + 四张名字表 20KB),
    // 而任何用正则的程序此前都得整份带上。
    // **失败是响的**:名字表被清空后 __re_uniName 恒返回 -1 → __re_uniResolve 返回 -1
    // → __re_parseProp 走 __re_fail("Invalid property name") → new RegExp/字面量构造
    // 立即抛 SyntaxError,而不是静默匹配失败。(唯一例外见下面的漏网说明。)
    // 漏网(只可能来自编译期不可见的动态模式,如 new RegExp("\\" + "p{L}", "u")):
    //   u 模式 / 无标志 → 构造时抛 SyntaxError: Invalid property name(响);
    //   v 模式          → shim 对未知属性走 __re_unsup(静默不匹配),这是 shim 既有
    //                     行为(v 模式的字符串属性本就未实现),此处不加剧、也无法在
    //                     编译器侧改(shim 归他人所有)。
    // eval/new Function 的动态源码由 readModuleSource 里的 _reUniPropSeen = true 兜住。
    _stripUnicodeTablesIfUnused() {
        if (this._reUniPropSeen) return;
        for (const moduleAst of this._moduleOrder) {
            const fname = moduleAst.filename || "";
            if (fname.indexOf("__regexp_shim.js") === -1) continue;
            const body = moduleAst.body || [];
            for (let i = 0; i < body.length; i++) {
                const stmt = body[i];
                if (!stmt || stmt.type !== "VariableDeclaration") continue;
                const decls = stmt.declarations || [];
                for (let j = 0; j < decls.length; j++) {
                    const d = decls[j];
                    if (!d || !d.id || d.id.type !== "Identifier") continue;
                    if (!isUniTableVarName(d.id.name)) continue;
                    const init = d.init;
                    if (!init || init.type !== "Literal") continue;
                    if (typeof init.value !== "string") continue;
                    init.value = "";
                    init.raw = '""';
                    if (process.env.ASMJS_SHIM_DEBUG) {
                        console.error("[shim] unicode table dropped: " + d.id.name);
                    }
                }
            }
        }
    }

    compileProgram(ast) {
        const vm = this.vm;

        ast.filename = this.sourcePath;
        this.resetModuleCompilationState();
        this.compiledFiles.add(ast.filename);
        this._injectImplicitGlobalImports(ast);
        this.resolveImports(ast, this._moduleOrder);
        // [W-35] 全部模块都读完(_reUniPropSeen 已定型)后才决定 Unicode 属性表的去留。
        // 必须放在 resolveImports 之后:shim 的 import 是前置注入的,shim 模块常常比
        // 用户的其他模块**先**被读到,在 readModuleSource 里就地删表会漏掉后读模块的 \p。
        this._stripUnicodeTablesIfUnused();
        this.moduleRegistrySize = Math.max(1, this._moduleOrder.length);

        this._moduleExportsList = [];

        for (let moduleIdx = 0; moduleIdx < this._moduleOrder.length; moduleIdx++) {
            this.createModuleMeta(this._moduleOrder[moduleIdx], moduleIdx);
        }

        // [W-24] 函数名推断预扫:须在任何函数体发射(→ registerFuncMeta)之前跑完全部模块。
        for (const moduleAst of this._moduleOrder) {
            this._collectFnNameHints(moduleAst);
        }

        for (const moduleAst of this._moduleOrder) {
            this.collectFunctions(moduleAst, this.getModuleMeta(moduleAst));
        }

        // [CJS cyclic require] 找出参与 require 环的本地 CJS 模块并登记惰性初始化函数。
        // 必须在 collectFunctions 之后(functionAliases 就绪)、body 内联之前。
        this.markCjsRequireCycles();

        // [#49/#50] 把「编译器合成的 shim 调用」链接到源模块 _user_ 标签。正则字面量、
        // JSON.* 改派在 codegen 阶段(闭包分析之后)才展开成 __RE_*/__JSON_* 调用,故
        // 从不被闭包捕获;嵌套函数/生成器体里它既非局部槽、非捕获、hasFunction 判否
        // → 调用静默丢弃(生成器内 re.exec 失效、嵌套 toJSON/reviver 回调里 JSON 失效)。
        // 登记导入名进 importer meta 的 functionAliases 使任意作用域解析到直呼标签。
        // 仅限编译器自身不含的 shim → 自举定点零影响。
        this.linkSynthesizedShimImports("__regexp_shim");
        this.registerJsonShimAliases();
        this.registerEvalShimAliases();
        this.registerNumberShimAliases();
        this.registerDateShimAliases();

        for (const moduleAst of this._moduleOrder) {
            const moduleExports = collectModuleExports(moduleAst, this._moduleOrder, this.nodeShimPath, this._moduleExportsList, path, fs);
            this._moduleExportsList.push(moduleExports);
        }
        for (let moduleIdx = 0; moduleIdx < this._moduleOrder.length; moduleIdx++) {
            const moduleAst = this._moduleOrder[moduleIdx];
            const moduleMeta = this.getModuleMeta(moduleAst);
            moduleMeta.exports = this.resolveStarExports(moduleAst, moduleIdx, this._moduleExportsList);
            this._moduleExportsList[moduleIdx] = moduleMeta.exports;
        }

        this.markLiveModuleBindings();

        for (const moduleAst of this._moduleOrder) {
            const moduleMeta = this.getModuleMeta(moduleAst);
            for (const name of moduleMeta.boxedVars) {
                const label = `_main_captured_${moduleMeta.symbolPrefix}_${name}`;
                moduleMeta.mainCapturedVars[name] = label;
                this.asm.addDataLabel(label);
                this.asm.addDataQword(0);
            }
        }

        vm.label("_main");
        vm.beginRecord(); // [P1]
        vm.prologue(8192, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        this.ctx.returnLabel = "_main_return";

        for (const moduleAst of this._moduleOrder) {
            const moduleMeta = this.getModuleMeta(moduleAst);
            for (const name of moduleMeta.boxedVars) {
                const label = moduleMeta.mainCapturedVars[name];
                vm.movImm(VReg.A0, 8);
                vm.call("_alloc");
                // x64: RET 与 V0 同为 RAX，movImm64(V0) 会冲掉刚 alloc 的 box 指针(RET)，
                // 用 V2 存 sentinel；arm64 RET(X0)/V0(X8) 不同，保持 V0 以逐字节不变。
                const sentReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
                vm.movImm64(sentReg, UNINITIALIZED_BINDING_SENTINEL);
                vm.store(VReg.RET, 0, sentReg);
                vm.lea(VReg.V1, label);
                vm.store(VReg.V1, 0, VReg.RET);
            }
        }

        for (let moduleIdx = 0; moduleIdx < this._moduleOrder.length; moduleIdx++) {
            // namespace 对象容量按导出数计算（头 24 + 每属性 16 + 256 余量），
            // 默认 _object_new 只有 62 个属性槽，大模块（如 allocator.js
            // 60+ 个导出）会越界写坏相邻堆对象
            const nsExports = this.getModuleMeta(this._moduleOrder[moduleIdx]).exports || [];
            vm.movImm(VReg.A0, 24 + 16 * nsExports.length + 256);
            vm.call("_object_new_sized");
            vm.mov(VReg.V0, VReg.RET);
            vm.movImm(VReg.V2, moduleIdx);
            vm.shl(VReg.V2, VReg.V2, 3);
            vm.lea(VReg.V1, "_module_registry");
            vm.add(VReg.V1, VReg.V1, VReg.V2);
            vm.store(VReg.V1, 0, VReg.V0);
        }

        for (const moduleAst of this._moduleOrder) {
            const moduleMeta = this.getModuleMeta(moduleAst);
            this.withModuleCompileContext(moduleMeta, () => {
                this.preinitializeModuleFunctionBindings(moduleMeta);
                this.populateModuleNamespace(moduleMeta, { functionsOnly: true });
            });
        }

        // Link all static imports before any module top-level code runs.
        // This gives cyclic function imports a stable value even when an
        // earlier module's top-level side effects call into a later module
        // before that later module reaches its own evaluation pass.
        for (const moduleAst of this._moduleOrder) {
            const moduleMeta = this.getModuleMeta(moduleAst);
            this.withModuleCompileContext(moduleMeta, () => {
                for (const stmt of moduleAst.body) {
                    if (stmt.type === "ImportDeclaration") {
                        this.compileImportBindingInitialization(stmt);
                    }
                }
            });
        }

        for (const moduleAst of this._moduleOrder) {
            const moduleMeta = this.getModuleMeta(moduleAst);
            // [CJS cyclic require] 环内本地 CJS 模块不在此内联执行——其模块体已编成
            // 独立函数 __cjs_init_m<idx>,由首次 require 惰性触发(_cjs_require_lazy)。
            if (moduleMeta.lazyCjs) continue;
            this.withModuleCompileContext(moduleMeta, () => {
                // Refresh imports immediately before evaluation so modules that
                // were already fully initialized can provide their latest
                // namespace values to this module.
                for (const stmt of moduleAst.body) {
                    if (stmt.type === "ImportDeclaration") {
                        this.compileImportBindingInitialization(stmt);
                    }
                }

                // [L4.2 字符串原地拼接] 模块顶层按可扫描"函数"处理:无形参;导出绑定
                // 枚举出来供逃逸门控否决(import 侧可持有别名,顶层变量等价于全局)。
                const _ipExported = new Set();
                for (const _st of moduleAst.body) {
                    if (_st.type !== "ExportDeclaration") continue;
                    const _d = _st.declaration;
                    if (_d && (_d.type === "FunctionDeclaration" || _d.type === "ClassDeclaration")) {
                        if (_d.id && _d.id.name) _ipExported.add(_d.id.name);
                    } else if (_d && _d.declarations) {
                        for (const _dd of _d.declarations) {
                            if (_dd.id && _dd.id.type === "Identifier") _ipExported.add(_dd.id.name);
                        }
                    } else if (_st.isDefault && _d && _d.type === "Identifier") {
                        _ipExported.add(_d.name);
                    }
                    if (_st.specifiers) {
                        for (const _sp of _st.specifiers) {
                            if (_sp.local && _sp.local.name) _ipExported.add(_sp.local.name);
                        }
                    }
                }
                this.ctx._ipExportedNames = _ipExported;
                this.ctx._ipScanRoot = { params: [], body: { type: "BlockStatement", body: moduleAst.body } };
                this.ctx._ipIndex = null;

                for (const stmt of moduleAst.body) {
                    if (stmt.type === "ImportDeclaration") {
                        continue;
                    }
                    if (stmt.type === "ExportDeclaration" && stmt.declaration) {
                        // 导出类与裸类一样需要内联执行（创建类信息对象），
                        // 否则 Parser.prototype / new Parser() 等只能拿到空 stub
                        if (stmt.declaration.type !== "FunctionDeclaration") {
                            this.compileStatement(stmt.declaration);
                        }
                        continue;
                    }
                    if (stmt.type === "ExportDeclaration") {
                        continue;
                    }
                    if (stmt.type !== "FunctionDeclaration") {
                        // ClassDeclaration 需要内联执行：创建类信息对象并存入局部槽，
                        // 供 new/静态成员访问使用（仅注册为函数会得到空实现）。
                        this.compileStatement(stmt);
                    }
                }

                this.populateModuleNamespace(moduleMeta);
            });
        }

        vm.movImm(VReg.RET, 0);
        vm.label("_main_return");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 8192);
        vm.endRecord(); // [P1]

        this.compileUserFunctions();
        this.generatePendingFunctions();
    }

    loadModuleNamespacePointer(moduleIndex, targetReg) {
        const vm = this.vm;
        vm.movImm(targetReg, moduleIndex);
        vm.shl(targetReg, targetReg, 3);
        vm.lea(VReg.V1, "_module_registry");
        vm.add(targetReg, VReg.V1, targetReg);
        vm.load(targetReg, targetReg, 0);
    }

    buildImportSpecMap(moduleAst) {
        const importSpecMap = new Map();
        for (const imp of this.imports || []) {
            if (!imp.importInfo || imp.importInfo.moduleAst !== moduleAst) continue;
            const sourceModuleIndex = this.findModuleIndexByPath(imp.importInfo.resolvedPath);
            for (const spec of imp.importInfo.specifiers || []) {
                const localName = spec.local && spec.local.name;
                if (!localName) continue;
                const isNamespace = spec.type === "ImportNamespaceSpecifier" || spec.namespace === true;
                importSpecMap.set(localName, { sourceModuleIndex, isNamespace });
            }
        }
        return importSpecMap;
    }

    populateModuleNamespace(moduleMeta, options = {}) {
        const vm = this.vm;
        const moduleExports = moduleMeta.exports || [];
        if (moduleExports.length === 0) return;

        const functionsOnly = options.functionsOnly === true;
        const importSpecMap = this.buildImportSpecMap(moduleMeta.ast);

        for (const exp of moduleExports) {
            const exportLocalName = exp.localName || exp.name;
            // export { f } 列表形式的函数/类导出 kind 是 "local"，
            // 必须按声明类型识别，否则既不走函数分支、又没有局部槽，
            // 导出会被静默跳过（namespace 缺项 → 导入方 typeof = number）
            let isFunctionLike = exp.kind === "function" || exp.kind === "class";
            let isClassLike = exp.kind === "class";
            if (!isFunctionLike && (exp.kind === "local" || exp.kind === "const")) {
                const declNode = this.ctx.getFunction && this.ctx.getFunction(exportLocalName);
                if (declNode && declNode.type === "FunctionDeclaration") {
                    isFunctionLike = true;
                } else if (declNode && declNode.type === "ClassDeclaration") {
                    isFunctionLike = true;
                    isClassLike = true;
                }
            } else if (isFunctionLike) {
                const declNode = this.ctx.getFunction && this.ctx.getFunction(exportLocalName);
                if (declNode && declNode.type === "ClassDeclaration") isClassLike = true;
            }
            if (functionsOnly && !isFunctionLike) {
                continue;
            }

            let valueLoaded = false;

            if (isFunctionLike && isClassLike && !functionsOnly) {
                // 类导出：完整填充阶段读取 _classinfo 槽（类声明已执行），
                // 使导入方拿到真实类信息对象（静态成员/prototype 可用）
                const classSymbol = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(exportLocalName)) || exportLocalName;
                vm.lea(VReg.V0, `_classinfo_${classSymbol}`);
                vm.load(VReg.V0, VReg.V0, 0);
                valueLoaded = true;
            } else if (isFunctionLike) {
                const funcLabel = this.getFunctionLabel(exportLocalName) ||
                    this.getDeclaredFunctionLabel(exportLocalName);
                if (funcLabel) {
                    vm.lea(VReg.V0, funcLabel);
                    vm.movImm64(VReg.V1, 0x7fff000000000000n);
                    vm.or(VReg.V0, VReg.V0, VReg.V1);
                    valueLoaded = true;
                } else {
                    // 函数标签不存在，跳过这个导出
                    continue;
                }
            } else if (!functionsOnly && exp.namespace === true && exp.sourceModuleIndex !== undefined) {
                this.loadModuleNamespacePointer(exp.sourceModuleIndex, VReg.V0);
                vm.emitMaskLoad(VReg.V1);
                vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                vm.or(VReg.V0, VReg.V0, VReg.V1);
                valueLoaded = true;
            } else if (!functionsOnly && exp.kind === "expression" && exp.expression) {
                this.compileExpression(exp.expression);
                vm.mov(VReg.V0, VReg.RET);
                valueLoaded = true;
            } else if (!functionsOnly && exp.kind === "reexport" && exp.sourceModuleIndex !== undefined) {
                vm.movImm(VReg.A0, exp.sourceModuleIndex);
                const reexportedName = exp.importedName || exp.name;
                const keyLabel = this.asm.addString(reexportedName);
                vm.lea(VReg.A1, keyLabel);
                vm.call("_get_module_export");
                vm.mov(VReg.V0, VReg.RET);
                valueLoaded = true;
            } else if (!functionsOnly && exp.kind === "reexport") {
                const impSpec = importSpecMap.get(exportLocalName);
                if (impSpec && impSpec.isNamespace) {
                    this.loadModuleNamespacePointer(impSpec.sourceModuleIndex, VReg.V0);
                    vm.emitMaskLoad(VReg.V1);
                    vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                    vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                    vm.or(VReg.V0, VReg.V0, VReg.V1);
                    valueLoaded = true;
                }
            }

            if (!valueLoaded) {
                const globalLabel = this.ctx.getMainCapturedVar(exportLocalName);
                if (globalLabel) {
                    vm.lea(VReg.V0, globalLabel);
                    vm.load(VReg.V0, VReg.V0, 0);
                    vm.load(VReg.V0, VReg.V0, 0);
                    valueLoaded = true;
                } else {
                    const localOffset = this.ctx.getLocal(exportLocalName);
                    if (localOffset !== undefined) {
                        vm.load(VReg.V0, VReg.FP, localOffset);
                        valueLoaded = true;
                    }
                }
            }

            if (!valueLoaded) {
                continue;
            }

            this.loadModuleNamespacePointer(moduleMeta.index, VReg.V2);
            const keyLabel = this.asm.addString(exp.name);
            vm.emitMaskLoad(VReg.V1);
            vm.andMaskReg(VReg.A0, VReg.V2, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffd000000000000n);
            vm.or(VReg.A0, VReg.A0, VReg.V1);
            vm.lea(VReg.V1, keyLabel);
            vm.mov(VReg.A2, VReg.V0);
            vm.movImm64(VReg.V0, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.V1, VReg.V0);
            vm.call("_object_set");
        }
    }


    // Resolve star exports for a module using the complete _moduleExportsList
    // This is called in pass 2 after all modules' exports have been collected
    resolveStarExports(moduleAst, moduleIndex, moduleExportsList) {
        const resolvedExports = [];

        for (const exp of moduleExportsList[moduleIndex]) {
            if (exp.kind === "star") {
                // Star export: resolve by getting all exports from source module
                const sourceModuleIndex = exp.sourceModuleIndex;
                if (moduleExportsList[sourceModuleIndex]) {
                    const sourceExports = moduleExportsList[sourceModuleIndex];
                    for (const srcExp of sourceExports) {
                        // Skip default export and duplicates
                        if (srcExp.name === 'default') continue;
                        if (resolvedExports.find(e => e.name === srcExp.name)) {
                            continue;
                        }
                        // Add as re-export from source module
                        resolvedExports.push({
                            name: srcExp.name,
                            kind: "reexport",
                            sourceModuleIndex: sourceModuleIndex
                        });
                    }
                } else {
                }
            } else {
                resolvedExports.push(exp);
            }
        }

        return resolvedExports;
    }

    // [L2 AOT 子集] 从 import() 参数表达式提取编译期可静态解析的 specifier 字符串,
    // 否则返回 null(运行时 specifier → 归 L2 引擎库)。支持:字符串字面量、静态模板
    // (无插值或插值皆字面量)、静态字符串拼接、const 绑定到字面量。
    _extractStaticSpecifier(e, constEnv) {
        if (!e || typeof e !== "object") return null;
        if (e.type === "Literal" && typeof e.value === "string") return e.value;
        if (e.type === "TemplateLiteral") {
            let s = "";
            const qs = e.quasis || [], ex = e.expressions || [];
            for (let i = 0; i < qs.length; i++) {
                s += (qs[i].value && qs[i].value.cooked) || "";
                if (i < ex.length) {
                    const sub = this._extractStaticSpecifier(ex[i], constEnv);
                    if (sub === null) {
                        // 允许数字/字符串字面量插值
                        if (ex[i].type === "Literal" && (typeof ex[i].value === "string" || typeof ex[i].value === "number")) s += String(ex[i].value);
                        else return null;
                    } else s += sub;
                }
            }
            return s;
        }
        if (e.type === "BinaryExpression" && e.operator === "+") {
            const l = this._extractStaticSpecifier(e.left, constEnv);
            const r = this._extractStaticSpecifier(e.right, constEnv);
            return (l !== null && r !== null) ? l + r : null;
        }
        // const 绑定到字面量:const target = "./x.js"; import(target)
        if (e.type === "Identifier" && constEnv && Object.prototype.hasOwnProperty.call(constEnv, e.name)) {
            return constEnv[e.name];
        }
        return null;
    }

    // [L2 AOT 子集] 递归扫描 AST 里的 import(静态 specifier) 调用:解析目标模块路径、
    // 入模块图(同静态 import),并在该 CallExpression 节点标注 _dynImportPath 供 codegen
    // 读取。收集顶层 const 字面量绑定供 const-binding 形态解析。
    _scanDynamicImports(ast, currentDir, moduleOrder) {
        // 收集顶层 const NAME = "字面量" 供 import(NAME) 解析
        const constEnv = {};
        for (const st of (ast.body || [])) {
            if (st.type === "VariableDeclaration" && st.kind === "const") {
                for (const d of (st.declarations || [])) {
                    if (d.id && d.id.type === "Identifier" && d.init && d.init.type === "Literal" && typeof d.init.value === "string") {
                        constEnv[d.id.name] = d.init.value;
                    }
                }
            }
        }
        const walk = (node) => {
            if (!node || typeof node !== "object") return;
            if (node.type === "CallExpression" && node.callee && node.callee.type === "Identifier" &&
                node.callee.name === "import" && node.arguments && node.arguments.length === 1) {
                const spec = this._extractStaticSpecifier(node.arguments[0], constEnv);
                if (spec !== null) {
                    node._dynImportSpec = spec; // 记录静态 specifier(供 missing 时 reject 用)
                    const resolvedPath = resolveModulePath(spec, currentDir, this.nodeShimPath, path, fs);
                    // 不存在的模块(missing-reject)→ 不入图/不标注 path → codegen 发
                    // rejected Promise(reason = specifier 字符串,对齐 fixture)
                    if (resolvedPath && fs.existsSync(resolvedPath)) {
                        node._dynImportPath = resolvedPath;
                        if (!this.compiledFiles.has(resolvedPath)) {
                            this.compiledFiles.add(resolvedPath);
                            const source = this.readModuleSource(resolvedPath);
                            const moduleAst = this.parse(source);
                            moduleAst.filename = resolvedPath;
                            const oldPath = this.sourcePath;
                            this.sourcePath = resolvedPath;
                            this.resolveImports(moduleAst, moduleOrder);
                            this.sourcePath = oldPath;
                        }
                    }
                }
            }
            for (const k in node) {
                if (k === "type" || (k.length && k[0] === "_")) continue;
                const v = node[k];
                if (v && typeof v === "object") {
                    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i]); }
                    else walk(v);
                }
            }
        };
        walk(ast);
    }

    resolveImports(ast, moduleOrder = []) {
        const modulePath = ast.filename || path.resolve(this.sourcePath || ".");
        const currentDir = fs.statSync(modulePath).isDirectory() ? modulePath : path.dirname(modulePath);

        if (modulePath && !this.compiledFiles.has(modulePath)) {
            this.compiledFiles.add(modulePath);
        }

        // 显式 "type": "commonjs" 的 package.json 下,.js 不得出现真实顶层
        // import/export 声明(Node v25 对这种文件抛 SyntaxError;此前编译器
        // 静默按 ESM 收下)。改在 AST 层判定(astHasRealTopLevelEsm)而非
        // readModuleSource 的文本扫描:注释/字符串里的 "export "/"import "
        // 文字不再误杀合法 CJS 文件。仅对 .js 生效(.mjs/.cjs 不受 package
        // type 约束),且只在最近 package.json 显式声明 "commonjs" 时抛;
        // 无 package.json / 无 type 字段 / type 为别的值都不抛——编译器自身
        // 模块在根 package.json(无 type)之下,自举零影响。
        // !this._cjsFlags[modulePath] 是关键:_wrapCjsSource 会为 CJS 模块
        // 合成真实 `export default module.exports;` 节点,而 _cjsFlags 在
        // 包装前已按原始源码把真 CJS 标为 true,故须排除,否则一切 CJS 模块
        // 在显式 type:commonjs 下都会误报。
        if (modulePath.endsWith(".js") && !this._cjsFlags[modulePath] &&
            nearestPackageJsonExplicitCommonjs(modulePath) && astHasRealTopLevelEsm(ast)) {
            throw new Error("Cannot use ESM import/export in a .js file whose package.json sets \"type\": \"commonjs\": " + modulePath);
        }

        for (const stmt of ast.body) {
            // Handle ImportDeclaration, ExportDeclaration with source (export { x } from "m"),
            // and ExportAllDeclaration (export * from "m")
            const isImportLike = stmt.type === "ImportDeclaration" ||
                stmt.type === "ExportAllDeclaration" ||
                (stmt.type === "ExportDeclaration" && stmt.source);
            if (!isImportLike) continue;

            if (stmt.type === "ExportAllDeclaration") {
                // export * from "module" - handle like an import
                const importSource = stmt.source.value;
                const resolvedPath = resolveModulePath(importSource, currentDir, this.nodeShimPath, path, fs);
                if (!resolvedPath) {
                    continue;
                }

                if (!this.compiledFiles.has(resolvedPath)) {
                    this.compiledFiles.add(resolvedPath);
                    const source = this.readModuleSource(resolvedPath);
                    const moduleAst = this.parse(source);
                    moduleAst.filename = resolvedPath;

                    const oldPath = this.sourcePath;
                    this.sourcePath = resolvedPath;
                    this.resolveImports(moduleAst, moduleOrder);
                    this.sourcePath = oldPath;
                }
                continue;
            }

            // ImportDeclaration or ExportDeclaration with source
            let importSource = stmt.source.value;
            const resolvedPath = resolveModulePath(importSource, currentDir, this.nodeShimPath, path, fs);
            if (!resolvedPath) {
                continue; // 暂不支持其他类型的导入
            }

            // 记录此导入的元信息，用于后续编译时绑定
            const importInfo = {
                specifiers: stmt.specifiers || [],
                source: importSource,
                resolvedPath: resolvedPath,
                isNodeShim: resolvedPath === this.nodeShimPath,
                moduleAst: ast,  // 'ast' is the AST of the module doing the importing - set immediately
                stmt
            };
            this.imports = this.imports || [];
            this.imports.push({ importInfo, fromAst: ast });

            if (!this.compiledFiles.has(resolvedPath)) {
                this.compiledFiles.add(resolvedPath);
                const source = this.readModuleSource(resolvedPath);
                const moduleAst = this.parse(source);
                moduleAst.filename = resolvedPath;

                // 保存当前的 sourcePath 并切换到模块路径，以便递归解析更深层导入
                const oldPath = this.sourcePath;
                this.sourcePath = resolvedPath;
                this.resolveImports(moduleAst, moduleOrder);
                this.sourcePath = oldPath;
            }
        }

        // [L2 AOT 子集] 扫描本模块内的动态 import(静态 specifier),把目标模块也纳入图。
        // 置于静态导入之后、本模块入序之前:被动态导入的依赖先于本模块进入 moduleOrder。
        this._scanDynamicImports(ast, currentDir, moduleOrder);
        this._scanRequires(ast, currentDir, moduleOrder);

        if (!moduleOrder.find((mod) => mod.filename === ast.filename)) {
            moduleOrder.push(ast);
        }
        return moduleOrder;
    }

    // [CJS AOT 子集] 扫描 require(静态 specifier) 调用:解析目标模块、入模块图
    // (依赖先于本模块进 moduleOrder,与 CJS 首个 require 触发的执行序在无环情形一致),
    // 并在 CallExpression 节点标注 _requirePath/_requireKind 供 codegen desugar 成
    // _get_module_export。环形依赖(a<->b)因 AOT 静态执行序与 CJS 惰性序不同,暂不支持。
    _scanRequires(ast, currentDir, moduleOrder) {
        // 顶层 const NAME = "字面量" 供 require(NAME) 解析
        const constEnv = {};
        for (const st of (ast.body || [])) {
            if (st.type === "VariableDeclaration" && st.kind === "const") {
                for (const d of (st.declarations || [])) {
                    if (d.id && d.id.type === "Identifier" && d.init && d.init.type === "Literal" && typeof d.init.value === "string") {
                        constEnv[d.id.name] = d.init.value;
                    }
                }
            }
        }
        const walk = (node) => {
            if (!node || typeof node !== "object") return;
            if (node.type === "CallExpression" && node.callee && node.callee.type === "Identifier" &&
                node.callee.name === "require" && node.arguments && node.arguments.length === 1) {
                const spec = this._extractStaticSpecifier(node.arguments[0], constEnv);
                if (spec !== null) {
                    node._requireCall = true;
                    const resolvedPath = resolveModulePath(spec, currentDir, this.nodeShimPath, path, fs, true);
                    if (resolvedPath && fs.existsSync(resolvedPath)) {
                        node._requirePath = resolvedPath;
                        node._requireKind = this._requireExportKind(resolvedPath, spec);
                        // [CJS cyclic require] 记录 require 依赖边(当前模块 -> 目标),
                        // 供 markCjsRequireCycles 找出环。ast.filename 在此已就绪。
                        if (ast.filename) {
                            if (!this._requireEdges) this._requireEdges = {};
                            const from = ast.filename;
                            if (!this._requireEdges[from]) this._requireEdges[from] = [];
                            if (this._requireEdges[from].indexOf(resolvedPath) === -1) {
                                this._requireEdges[from].push(resolvedPath);
                            }
                        }
                        if (!this.compiledFiles.has(resolvedPath)) {
                            this.compiledFiles.add(resolvedPath);
                            const source = this.readModuleSource(resolvedPath);
                            const moduleAst = this.parse(source);
                            moduleAst.filename = resolvedPath;
                            const oldPath = this.sourcePath;
                            this.sourcePath = resolvedPath;
                            this.resolveImports(moduleAst, moduleOrder);
                            this.sourcePath = oldPath;
                        }
                    }
                }
            }
            for (const k in node) {
                if (k === "type" || (k.length && k[0] === "_")) continue;
                const v = node[k];
                if (v && typeof v === "object") {
                    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i]); }
                    else walk(v);
                }
            }
        };
        walk(ast);
    }

    // [CJS cyclic require] 找出参与 require 环的本地 CJS 模块,标记 meta.lazyCjs 并
    // 为其登记独立的惰性初始化函数 __cjs_init_m<idx>。
    //
    // 默认模型把每个模块体内联进 _main、按拓扑序在同一栈帧顺序执行——真正的 require
    // 环无法交错(a 需要 b 的数据、b 又需要 a 的),且共享帧会互相踩局部槽。Node 的
    // CJS loader 在跑模块体**之前**就把 module.exports 装进缓存,故环内 require 拿到
    // 部分初始化对象。这里对「环内本地 CJS 模块」改用独立帧的初始化函数 + 首次 require
    // 惰性执行(_cjs_require_lazy),在体首 _cjs_publish 发布 module.exports,从而复刻
    // Node 的部分导出/错误缓存语义。非环模块(ESM、无环 CJS)完全不受影响。
    markCjsRequireCycles() {
        const isCjs = (p) => !!(this._cjsFlags && this._cjsFlags[p]);
        // 仅本地 CJS 之间的 require 边构成子图。
        const adj = {};
        if (this._requireEdges) {
            for (const from in this._requireEdges) {
                if (!isCjs(from)) continue;
                for (const to of this._requireEdges[from]) {
                    if (!isCjs(to)) continue;
                    if (!adj[from]) adj[from] = [];
                    if (adj[from].indexOf(to) === -1) adj[from].push(to);
                }
            }
        }
        const reach = (x, target, seen) => {
            if (x === target) return true;
            if (seen[x]) return false;
            seen[x] = true;
            const outs = adj[x] || [];
            for (const m of outs) if (reach(m, target, seen)) return true;
            return false;
        };
        const inCycle = (start) => {
            for (const s of (adj[start] || [])) {
                if (reach(s, start, {})) return true;
            }
            return false;
        };

        for (let idx = 0; idx < this._moduleOrder.length; idx++) {
            const moduleAst = this._moduleOrder[idx];
            const p = moduleAst.filename;
            if (!isCjs(p)) continue;
            if (!inCycle(p)) continue;
            const meta = this.getModuleMeta(moduleAst);
            if (!meta) continue;
            meta.lazyCjs = true;
            this.registerCjsInitFunction(moduleAst, meta, idx);
        }
    }

    // 为惰性 CJS 模块合成并登记初始化函数 __cjs_init_m<idx>。函数体 = 模块的非函数/
    // 非 import/非 export 语句(前两条恒为包裹注入的 `const module={exports:{}}` 与
    // `let exports=module.exports`),体首插入 _cjs_publish(发布部分导出),体尾再发布
    // 一次(捕获 `module.exports = X` 重新赋值),整体包在 try/catch 里:抛错时缓存错误
    // 后重抛。函数经既有函数编译管线获得独立帧(compileUserFunctions),故环内各模块
    // 的局部互不踩踏。
    registerCjsInitFunction(moduleAst, meta, idx) {
        const idLit = () => ({ type: "Literal", value: idx });
        const moduleExportsExpr = () => ({
            type: "MemberExpression", computed: false,
            object: { type: "Identifier", name: "module" },
            property: { type: "Identifier", name: "exports" },
        });
        const publishStmt = () => ({
            type: "ExpressionStatement",
            expression: {
                type: "CallExpression",
                callee: { type: "Identifier", name: "__cjs_publish" },
                arguments: [idLit(), moduleExportsExpr()],
            },
        });

        // 拆分包裹后的模块体:保留 module/exports 声明与真实语句,丢弃 import/export/
        // 函数声明(函数声明由 collectFunctions 单独编成顶层 _user_m<idx>_* 标签)。
        const prelude = [];   // const module=...; let exports=...;
        const bodyStmts = [];
        for (const stmt of moduleAst.body) {
            if (stmt.type === "ImportDeclaration" || stmt.type === "ExportAllDeclaration") continue;
            if (stmt.type === "ExportDeclaration" || stmt.type === "ExportDefaultDeclaration") continue;
            if (stmt.type === "FunctionDeclaration") continue;
            if (prelude.length < 2 && stmt.type === "VariableDeclaration" &&
                stmt.declarations && stmt.declarations[0] && stmt.declarations[0].id &&
                (stmt.declarations[0].id.name === "module" || stmt.declarations[0].id.name === "exports")) {
                prelude.push(stmt);
                continue;
            }
            bodyStmts.push(stmt);
        }

        const tryBody = [];
        for (const s of prelude) tryBody.push(s);
        tryBody.push(publishStmt());          // 体首:发布部分 module.exports
        for (const s of bodyStmts) tryBody.push(s);
        tryBody.push(publishStmt());          // 体尾:捕获 module.exports 重新赋值

        const errName = "__cjs_e";
        const wrapped = {
            type: "TryStatement",
            block: { type: "BlockStatement", body: tryBody },
            handler: {
                type: "CatchClause",
                param: { type: "Identifier", name: errName },
                body: {
                    type: "BlockStatement",
                    body: [
                        {
                            type: "ExpressionStatement",
                            expression: {
                                type: "CallExpression",
                                callee: { type: "Identifier", name: "__cjs_set_error" },
                                arguments: [idLit(), { type: "Identifier", name: errName }],
                            },
                        },
                        { type: "ThrowStatement", argument: { type: "Identifier", name: errName } },
                    ],
                },
            },
            finalizer: null,
        };

        const funcDecl = {
            type: "FunctionDeclaration",
            id: { type: "Identifier", name: "__cjs_init_m" + idx },
            params: [],
            body: { type: "BlockStatement", body: [wrapped] },
        };

        const name = "__cjs_init_m" + idx;
        this.ctx.registerFunction(name, funcDecl);
        // owner 用模块的 functionAliases(解析模块顶层函数引用)但清空 mainCapturedVars,
        // 强制体内顶层局部走函数帧(而非 _main 全局盒),保证环内交错不互踩。
        this._functionOwners[name] = {
            functionAliases: meta.functionAliases,
            mainCapturedVars: {},
            ast: moduleAst,
        };
    }

    // require(spec) 目标应取哪个导出键。目标:令 require("node:X") 与 import X 对齐。
    // - 内建模块:多数取 default(= Node module.exports 形态:path 对象含 sep 属性、
    //   events=EventEmitter 类可 new、os/util/url/assert/... 对象),与 default import 一致。
    //   例外 fs/buffer:asm.js 建模为静态类,但 Node 的 require 暴露为「含命名成员的对象」
    //   (require("fs").writeFileSync、require("buffer").Buffer)→ 用 namespace。
    // - 本地/包:CJS(module.exports)取 default,ESM 取 namespace(按文件内容判定,
    //   node_modules 包可能是 CJS)。
    _requireExportKind(resolvedPath, spec) {
        if (resolvedPath === this.nodeShimPath) return "namespace";
        // 内建 node shim 目录判别须对**绝对/相对**路径都成立:node 下 resolvedPath 是绝对
        // (含前导斜杠 "/…/runtime/node/…"),而自编译产物(g1)的路径解析返回相对
        // ("runtime/node/…",cwd 分歧,A 域)。原用 "/runtime/node/"(带前导斜杠)在 g1
        // 漏判 → 落 looksLikeCjsSource 把 ESM shim(events/util)判 "namespace" → require
        // 返命名空间、`new require("events")()` 崩。改用无前导斜杠子串 "runtime/node/",
        // 两种路径形态一致 → require-kind 决策自编译与 node 逐字节同。
        if (resolvedPath.indexOf("runtime/node/") !== -1) {
            if (resolvedPath.indexOf("runtime/node/fs.js") !== -1 ||
                resolvedPath.indexOf("runtime/node/buffer.js") !== -1) return "namespace";
            return "default";
        }
        let raw = "";
        try { raw = fs.readFileSync(resolvedPath, "utf-8"); } catch (e) { raw = ""; }
        return looksLikeCjsSource(raw) ? "default" : "namespace";
    }

    compileProgramForLibrary(ast) {
        this._collectFnNameHints(ast); // [W-24] 同 compileProgram:发射前预扫函数名
        this.collectFunctions(ast);
        this.compileUserFunctions();
        this.generatePendingFunctions();

        // 生成 C 调用约定包装器
        const wrapperGen = new WrapperGenerator(this);
        wrapperGen.generate(this.exports);
    }

    // [#49] 见 compileProgram 调用点注释。把 shimTag 标识的 shim 模块导出的函数,
    // 按各 importer 的导入说明登记进 importer meta 的 functionAliases → 源模块符号,
    // 让 codegen 阶段合成的 __RE_* 调用在任意作用域解析到 _user_ 直呼标签。
    linkSynthesizedShimImports(shimTag) {
        if (!this.imports) return;
        for (const rec of this.imports) {
            const info = rec && rec.importInfo;
            if (!info || !info.resolvedPath) continue;
            if (info.resolvedPath.indexOf(shimTag) === -1) continue;
            const importerMeta = this.getModuleMeta(info.moduleAst);
            const sourceMeta = this.getModuleMetaByPath(info.resolvedPath);
            if (!importerMeta || !sourceMeta) continue;
            for (const spec of info.specifiers || []) {
                if (spec.type !== "ImportSpecifier") continue;
                const localName = spec.local && spec.local.name;
                const importedName = spec.imported && (spec.imported.name || spec.imported.value);
                if (!localName || !importedName) continue;
                // 仅当源绑定确是函数声明(shim 导出恒为纯函数)
                if (this.getModuleBindingKind(sourceMeta.ast, importedName) !== "function") continue;
                const sourceSymbol = sourceMeta.functionAliases[importedName];
                if (!sourceSymbol || typeof sourceSymbol !== "string") continue;
                // 不覆盖 importer 自己的声明/别名
                if (importerMeta.functionAliases[localName]) continue;
                importerMeta.functionAliases[localName] = sourceSymbol;
            }
        }
    }

    collectFunctions(ast, moduleMeta = null) {
        for (const stmt of ast.body) {
            if (stmt.type === "FunctionDeclaration" && stmt.id) {
                const symbol = moduleMeta ? this.getFunctionSymbolForModule(moduleMeta, stmt.id.name) : stmt.id.name;
                if (symbol === "AST" || symbol === "NodeType") {
                }
                this.ctx.registerFunction(symbol, stmt);
                if (moduleMeta) {
                    this._functionOwners[symbol] = moduleMeta;
                }
            } else if (stmt.type === "ClassDeclaration" && stmt.id) {
                const symbol = moduleMeta ? this.getFunctionSymbolForModule(moduleMeta, stmt.id.name) : stmt.id.name;
                if (symbol === "AST" || symbol === "NodeType") {
                }
                this.ctx.registerFunction(symbol, stmt);
                if (moduleMeta) {
                    this._functionOwners[symbol] = moduleMeta;
                }
            } else if (stmt.type === "ExportDeclaration" && stmt.declaration) {
                const decl = stmt.declaration;
                if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
                    const symbol = moduleMeta ? this.getFunctionSymbolForModule(moduleMeta, decl.id.name) : decl.id.name;
                    if (symbol === "AST" || symbol === "NodeType") {
                    }
                    this.ctx.registerFunction(symbol, decl);
                    if (moduleMeta) {
                        this._functionOwners[symbol] = moduleMeta;
                    }
                    if (!moduleMeta && !this.exports.includes(decl.id.name)) {
                        this.exports.push(decl.id.name);
                    }
                }
            }
        }
    }

    compileUserFunctions() {
        for (const name in this.ctx.functions) {
            this.compileFunction(name, this.ctx.functions[name]);
        }
    }

    compileFunction(name, func) {
        const vm = this.vm;
        const funcLabel = "_user_" + name;
        const returnLabel = funcLabel + "_return";

        if (func.type === "ClassDeclaration") {
            // 类不能按函数体编译（body 是成员列表而非语句块）。
            // 类的真正实现由 compileClassDeclaration 内联生成；
            // 这里只留一个安全 stub：返回 A0 (this)，供旧的
            // getFunctionLabel 回退路径调用时不至于崩溃。
            vm.label(funcLabel);
            vm.prologue(16, []);
            vm.mov(VReg.RET, VReg.A0);
            vm.epilogue([], 16);
            return;
        }

        const isAsync = isAsyncFunction(func);
        const ownerMeta = this._functionOwners[name];

        const savedCtx = this.ctx;
        const savedSourcePath = this.sourcePath;
        const savedModuleAst = this._currentModuleAst;
        this.ctx = savedCtx.clone(name);
        this.ctx.returnLabel = returnLabel;
        this.ctx.inAsyncFunction = isAsync;
        if (ownerMeta) {
            this.ctx.functionAliases = Object.assign({}, ownerMeta.functionAliases);
            this.ctx.mainCapturedVars = Object.assign({}, ownerMeta.mainCapturedVars);
            this.sourcePath = ownerMeta.ast.filename;
            this._currentModuleAst = ownerMeta.ast;
        }

        const boxedVars = analyzeSharedVariables(func);
        // [引擎库·直接 eval 逃逸捕获] 含直接 eval 的函数:把全部局部升级为 box,使调用者与
        // eval 片段闭包共享同一 cell(见 lang/analysis/closure.js analyzeDirectEvalBoxedVars)。
        for (const _n of analyzeDirectEvalBoxedVars(func)) boxedVars.add(_n);
        this.ctx.boxedVars = boxedVars;

        vm.label(funcLabel);
        // [函数元数据] 顶层函数声明:funcLabel(=_user_<name>)即其值的 code_ptr(裸函数指针
        // 脱壳后 = 此标签;闭包路径 func_ptr@8 亦指向此)。登记种类使 async/generator 声明
        // 也被 Object.prototype.toString 正确品牌(此前仅函数表达式登记)。name 取声明名,
        // 使运行期函数值(如作参数传递)的 .name 反射到正确名字。
        this.registerFuncMeta(funcLabel, func, name);
        // [批次D] 顶层生成器声明:标签处先落 stub(建协程+生成器对象即返回),
        // 真正函数体在 <label>_gbody(由 _coroutine_entry 首次 resume 进入)。
        // 顶层声明无闭包,stub 传 A2=0。
        const isGenerator = _isGenFuncDecl(func) && !isAsync;
        const isAsyncGen = _isGenFuncDecl(func) && isAsync;
        // [L4.2 字符串原地拼接] 逃逸门控的函数级扫描根。async/generator 骑协程
        // (协程栈 + 推迟 GC 语义),本期一律不参与;普通函数以 AST 节点为扫描范围。
        this.ctx._ipScanRoot = (isAsync || isGenerator || isAsyncGen) ? null : func;
        this.ctx._ipIndex = null;
        this.ctx.inAsyncGenerator = isAsyncGen;
        if (isGenerator) {
            this.emitGeneratorStub(funcLabel + "_gbody", false);
        } else if (isAsyncGen) {
            // 顶层 async function*：async 生成器 stub
            this.emitAsyncGeneratorStub(funcLabel + "_gbody", false);
        }
        // [P1] async 禁录(S4 跨协程共享,见 closures.js 注);生成器体同理禁录;
        // [批次D] __regexp_shim 模块禁录(x64 晋升错编,见 closures.js 注)
        const p1Skip = typeof this.sourcePath === "string" &&
            this.sourcePath.indexOf("__regexp_shim") !== -1;
        if (!isAsync && !isGenerator && !p1Skip) vm.beginRecord();
        vm.prologue(8192, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        const params = func.params || [];
        const _isCoroBody = isGenerator || isAsyncGen;
        // [gen unwind] 协程体标记:体内 finally 重抛/裸 throw 不可跨栈 _throw_unwind
        // (exc-ctx 帧在调用方栈),须跳 returnLabel 完成协程、pending 保留,由
        // _generator_next/_generator_throw 在调用方栈上传播。
        this.ctx.inCoroBody = _isCoroBody;

        // [#49] `arguments` 对象(数组近似):顶层函数声明同样支持。生成器体经协程栈
        // 由 stub/_gbody 迂回进入,入口约定不同,此路径不建(非门禁用例);其余在具名
        // 参数绑定前构造(emitArgumentsArray 内部存临时槽并末尾恢复 A0..A4)。
        // [argc] 协程体也可建 arguments:_coroutine_entry 已按 CORO_ARGC 快照恢复
        // _call_argc,且按 A0-A4 装实参 —— 与普通函数入口同构。
        const declUsesArguments =
            !params.some((p) =>
                (p.type === "Identifier" && p.name === "arguments") ||
                (p.type === "AssignmentPattern" && p.left && p.left.name === "arguments") ||
                (p.type === "SpreadElement" && p.argument && p.argument.name === "arguments")) &&
            this.functionBodyUsesArguments(func);
        if (declUsesArguments) {
            this.emitArgumentsArray();
        }

        const paramOffsets = [];
        const patternParams = [];
        for (let i = 0; i < params.length && i < 6; i++) {
            const param = params[i];
            let paramName = null;
            let defaultExpr = null;
            if (param.type === "Identifier") {
                paramName = param.name;
            } else if (param.type === "AssignmentPattern" && param.left && param.left.type === "Identifier") {
                // 默认参数：此前被跳过，参数恒读 0
                paramName = param.left.name;
                defaultExpr = param.right;
            } else if (param.type === "SpreadElement" && param.argument && param.argument.type === "Identifier") {
                // 剩余参数 ...rest
                this.emitRestParam(param.argument.name, i);
                continue;
            } else if (this._isPatternParam(param)) {
                // [#47] 解构参数 function f({a,b})/f([a,b])：先把实参落临时槽,
                // 解构延后到全部实参入栈后(见下 patternParams 循环),防 A 寄存器互踩。
                const pat = param.type === "AssignmentPattern" ? param.left : param;
                const dexpr = param.type === "AssignmentPattern" ? param.right : null;
                const pslot = this.ctx.allocLocal(`__parampat_${this.nextLabelId()}`);
                vm.store(VReg.FP, pslot, vm.getArgReg(i));
                patternParams.push({ pat: pat, slot: pslot, dflt: dexpr });
                continue;
            }
            if (!paramName) continue;
            const offset = this.ctx.allocLocal(paramName);
            paramOffsets.push({ name: paramName, offset: offset });
            vm.store(VReg.FP, offset, vm.getArgReg(i));
            if (defaultExpr) {
                // x64: V1/V2 别名 RCX/RDX = A3/A2，此检查会踩掉尚未入槽的后续实参
                // （带默认值的 3+ 参函数丢参 → gen1 编译器行为分歧）；改用 V5/V6(R10/R11)。
                // arm64 保持 V1/V2，产物逐字节不变。
                const chkReg = vm.backend.name === "x64" ? VReg.V5 : VReg.V1;
                const undReg = vm.backend.name === "x64" ? VReg.V6 : VReg.V2;
                const skip = this.ctx.newLabel("defparam_skip");
                vm.load(chkReg, VReg.FP, offset);
                vm.movImm64(undReg, 0x7ffb000000000000n); // JS_UNDEFINED
                vm.cmp(chkReg, undReg);
                vm.jne(skip);
                this.compileExpression(defaultExpr);
                vm.store(VReg.FP, offset, VReg.RET);
                vm.label(skip);
            }
        }

        // [#36] 顶层函数声明也存 __this(A5):此前该路径不落 __this 槽 →
        // 函数声明被当方法/经 call,apply,bind 调用时 this 恒 0(闭包路径早有)
        if (!isAsync) {
            const declThisOff = this.ctx.allocLocal("__this");
            vm.store(VReg.FP, declThisOff, VReg.A5);
        }

        for (let i = 0; i < paramOffsets.length; i++) {
            const param = paramOffsets[i];
            if (boxedVars.has(param.name)) {
                vm.load(VReg.V1, VReg.FP, param.offset);
                vm.push(VReg.V1);
                vm.movImm(VReg.A0, 8);
                vm.call("_alloc");
                vm.store(VReg.FP, param.offset, VReg.RET);
                vm.pop(VReg.V1);
                vm.store(VReg.RET, 0, VReg.V1);
            }
        }

        // [#47] 解构参数:所有实参已落栈,此处安全解构到局部(体内即可引用)。
        for (let i = 0; i < patternParams.length; i++) {
            this.emitParamDestructure(patternParams[i].pat, patternParams[i].slot, patternParams[i].dflt);
        }

        if (func.body) {
            if (func.body.type === "BlockStatement") {
                for (const stmt of func.body.body) {
                    this.compileStatement(stmt);
                }
            } else {
                this.compileExpression(func.body);
            }
        }

        // 函数体自然落底(无显式 return):返回真正的 undefined(0x7FFB),而非裸 int 0
        // ——与显式 `return;` 一致,令返回值可与数值 0 区分(falsy/nullish/=== 语义正确)。
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.label(returnLabel);
        if (isAsync && !isAsyncGen) {
            this.emitAsyncResolveAndReturnFromRet();
        } else {
            // 普通/生成器/async-gen:epilogue(协程体经 _coroutine_entry → _coroutine_return)
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 8192);
        vm.endRecord(); // [P1]
        }
        this.ctx.inAsyncGenerator = false;

        // If this function is exported, store its address into the captured var box
        if (this.exports && this.exports.includes(name)) {
            const capturedLabel = this.ctx.getMainCapturedVar(name);
            if (capturedLabel) {
                // Load box pointer from captured var label
                vm.lea(VReg.V0, capturedLabel);
                vm.load(VReg.V0, VReg.V0, 0);  // V0 = box pointer
                // Get function address and tag as function (0x7FFF)
                vm.lea(VReg.V1, funcLabel);
                vm.movImm64(VReg.V2, 0x7fff000000000000n);
                vm.or(VReg.V1, VReg.V1, VReg.V2);  // V1 = tagged function address
                vm.store(VReg.V0, 0, VReg.V1);  // Store into box
            }
        }

        this.generatePendingFunctions();
        this.ctx = savedCtx;
        this.sourcePath = savedSourcePath;
        this._currentModuleAst = savedModuleAst;
    }

    // ========== 静态库支持 ==========

    embedStaticLibraries() {
        const linker = new StaticLinker();

        for (const lib of this.staticLibs) {
            linker.loadLibrary(lib.fullPath);
        }

        const linked = linker.getLinkedCode();
        const staticCodeBase = this.asm.code.length;

        for (let i = 0; i < linked.code.length; i++) {
            this.asm.code.push(linked.code[i]);
        }

        const dataArray = this.asm.data || this.asm.dataSection;
        if (dataArray && linked.data.length > 0) {
            for (let i = 0; i < linked.data.length; i++) {
                dataArray.push(linked.data[i]);
            }
        }

        for (const [name, offset] of Object.entries(linked.symbols)) {
            const finalOffset = staticCodeBase + offset;
            // labels 是 Map（arm64 一直如此，x64 已对齐）；原对象下标写法在 Map 上
            // 只会挂属性而不进表，静态库符号将解析不到。
            this.asm.labels.set(name, finalOffset);
            if (!name.startsWith("_")) {
                this.asm.labels.set("_" + name, finalOffset);
            }
        }
    }

    writeStaticLibrary(objectData, outputFile) {
        // 用 mkdtempSync 建 0700 私有临时目录(POSIX 下 mkdtempSync 默认 0700)再放 .o,
        // 取代旧实现把可预测文件名(baseName + ".o")直接落在共享 os.tmpdir() 下——同机
        // 用户可预创建/抢注同名 symlink 劫持写入或让 ar 打包进别人控制的内容。目录名唯一,
        // 内部用固定文件名即可;打包完整目录递归清掉。
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asmjs-ar-"));
        const baseName = path.basename(outputFile, ".a");
        const tempObjFile = path.join(tempDir, baseName + ".o");

        try {
            fs.writeFileSync(tempObjFile, Buffer.from(objectData));
            // 用 execFileSync(无 shell)传参,避免把用户可控的输出路径拼进 shell 字符串
            // 造成命令注入(如 outputFile 含 `"; rm -rf ~ #`)。
            execFileSync("ar", ["rcs", outputFile, tempObjFile], { stdio: "pipe" });
            const stats = fs.statSync(outputFile);
            return { output: outputFile, size: stats.size };
        } finally {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {}
        }
    }

    // ========== 函数元数据侧表 ==========
    // 编译器在定义处已知函数是否 async/generator,但运行期闭包只带 magic(0xc105)与
    // func_ptr,无种类信息。闭包头是紧凑布局(magic@0/func_ptr@8/captured@16+),扩头会
    // 撞热路径全字比较与大量 offset-16 捕获读,故改用 code_ptr→kind 侧表:
    //   entry = { code_ptr(=func_ptr,运行期 lea 填)@0, kind@8, name_ptr@16, arity@24 }  (32B/条)
    // 仅 async/generator 函数建条(普通函数缺省品牌 = Function),表随此类函数数增长
    // (自举产物内此类极少)。查表 O(N) 但只在 Object.prototype.toString 冷路径调用。
    // kind: 1=Generator, 2=Async, 3=AsyncGenerator。
    // name: 供运行期函数值 .name 反射(静态访问点已由 _fnNameLength 解析,此表覆盖参数/
    // 成员链等运行时函数值);匿名函数 name="" 不占 name_ptr(其 .name 回落 undefined)。
    // [W-24] arity@24:首个默认/剩余形参**之前**的形参个数(规范 length 语义,与
    // members.js _fnNameLength 的编译期算法逐字同源)。供运行期函数值 .length 反射
    // (读取器 _func_meta_arity)。**布局变更须原子**:改条目宽度必须同时改
    // _func_meta_init / _func_meta_entry 的步长与数据段每条 qword 数(见下方三处)。
    registerFuncMeta(label, expr, nameHint) {
        if (!expr) return;
        const isAsync = isAsyncFunction(expr);
        const isGen = _isGenFuncDecl(expr);
        let kind = 0;
        if (isGen && isAsync) kind = 3;
        else if (isGen) kind = 1;
        else if (isAsync) kind = 2;
        let name = "";
        if (expr.id && expr.id.name) name = expr.id.name;
        else if (typeof nameHint === "string") name = nameHint;
        else if (this._fnNameHints) {
            // [W-24] 匿名函数/箭头:取推断名(ES NamedEvaluation 的廉价子集,见 _collectFnNameHints)
            const h = this._fnNameHints.get(expr);
            if (typeof h === "string") name = h;
        }
        if (kind === 0 && name === "") return; // 匿名普通函数不入表
        if (!this._funcMeta) this._funcMeta = [];
        this._funcMeta.push({ label: label, kind: kind, name: name, arity: _fnArity(expr) });
    }

    // [W-24 函数元数据·名字推断] ES NamedEvaluation 的**廉价确定子集**:把匿名函数/箭头
    // 表达式节点与其绑定名/属性名关联,存入 this._fnNameHints(AST 节点 → 名字),由
    // registerFuncMeta 在无显式 nameHint 时取用。此前 registerFuncMeta 只在顶层函数声明
    // (带 id)与命名函数表达式处拿得到名字,`var f = () => {}` / `{ m(){} }` 一律以
    // name="" 被丢弃 → 运行期 fn.name 反射不到。
    // 覆盖(名字唯一且规范明确):
    //   var/let/const f = <anon fn|arrow>      → "f"
    //   f = <anon fn|arrow>(赋值给标识符)      → "f"
    //   对象字面量 { m(){} } / { m: <anon fn> } → "m"(非计算键、非 get/set)
    //   类 MethodDefinition(非计算键)          → 方法名(登记点尚未接入,提前备好)
    // 不覆盖(名字有歧义或形态特殊,宁缺勿错):计算键 [k](){}、getter/setter(规范名是
    // "get x"/"set x")、export default(名 "default")、解构默认值 ({a = () => {}})。
    _collectFnNameHints(ast) {
        if (!this._fnNameHints) this._fnNameHints = new Map();
        const hints = this._fnNameHints;
        const seen = new Set();
        const isAnonFn = (n) => !!n && typeof n === "object" && !n.id &&
            (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");
        const keyName = (k, computed) => {
            if (computed || !k || typeof k !== "object") return null;
            if (k.type === "Identifier") return k.name;
            if (k.type === "Literal" && (typeof k.value === "string" || typeof k.value === "number")) {
                return String(k.value);
            }
            return null;
        };
        const visit = (node) => {
            if (!node || typeof node !== "object") return;
            if (seen.has(node)) return;
            seen.add(node);
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) visit(node[i]);
                return;
            }
            const t = node.type;
            if (t === "VariableDeclarator") {
                if (node.id && node.id.type === "Identifier" && isAnonFn(node.init)) {
                    hints.set(node.init, node.id.name);
                }
            } else if (t === "AssignmentExpression") {
                if (node.operator === "=" && node.left && node.left.type === "Identifier" &&
                    isAnonFn(node.right)) {
                    hints.set(node.right, node.left.name);
                }
            } else if (t === "Property") {
                if ((!node.kind || node.kind === "init") && isAnonFn(node.value)) {
                    const kn = keyName(node.key, node.computed);
                    if (kn !== null) hints.set(node.value, kn);
                }
            } else if (t === "MethodDefinition") {
                if ((!node.kind || node.kind === "method") && isAnonFn(node.value)) {
                    const kn = keyName(node.key, node.computed);
                    if (kn !== null) hints.set(node.value, kn);
                }
            }
            for (const k in node) {
                if (k === "type" || k === "loc" || k === "start" || k === "end" || k === "filename") continue;
                const v = node[k];
                if (v && typeof v === "object") visit(v);
            }
        };
        visit(ast);
    }

    emitFuncMetaTable() {
        const vm = this.vm;
        const entries = this._funcMeta || [];

        // [W-24 条目布局] 32B/条:code_ptr@0(运行期 lea 填)、kind@8(静态)、name_ptr@16
        // (运行期 lea 填,匿名留 0)、arity@24(静态)。本函数是**唯一**知道该布局的地方——
        // 遍历步长共 2 处(_func_meta_init / _func_meta_entry)、字段读 3 处
        // (_func_meta_find/@8、_func_meta_name/@16、_func_meta_arity/@24)、数据发射 1 处
        // (下方每条 4 个 qword + 空表占位)。改宽度必须六处同改(治理规则 §4:布局变更原子)。
        // 表外无读者:runtime 侧只经 _func_meta_find / _func_meta_name / _func_meta_arity
        // 三个访问器进表,不直接寻址条目。
        //
        // _func_meta_init: 运行期把各函数标签地址填入 code_ptr 槽、名字串地址填入 name_ptr 槽
        // (二者 vaddr 运行期才定,故 lea);kind/arity 已静态写入数据。匿名(name="")的 name_ptr 留 0。
        vm.label("_func_meta_init");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.S0, "_func_meta_table");
        for (let i = 0; i < entries.length; i++) {
            vm.lea(VReg.V1, entries[i].label);
            vm.store(VReg.S0, 0, VReg.V1);      // entry.code_ptr = &label
            if (entries[i].name !== "") {
                vm.lea(VReg.V1, this.asm.addString(entries[i].name));
                vm.store(VReg.S0, 16, VReg.V1); // entry.name_ptr = &name_str
            }
            vm.addImm(VReg.S0, VReg.S0, 32);    // 步长=条目宽度;走指针避免大 offset(§1.7)
        }
        vm.epilogue([VReg.S0], 0);

        // _func_meta_entry(A0=code_ptr) -> RET=entry_ptr(0=未登记)。线性扫描,冷路径。
        vm.label("_func_meta_entry");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.A0);                       // S3 = 目标 code_ptr
        vm.lea(VReg.S0, "_func_meta_count");
        vm.load(VReg.S0, VReg.S0, 0);                   // S0 = count
        vm.lea(VReg.S1, "_func_meta_table");            // S1 = 游标
        vm.movImm(VReg.S2, 0);                          // S2 = i
        vm.label("_fme_loop");
        vm.cmp(VReg.S2, VReg.S0);
        vm.jge("_fme_nf");
        vm.load(VReg.V1, VReg.S1, 0);                   // entry.code_ptr
        vm.cmp(VReg.V1, VReg.S3);
        vm.jeq("_fme_found");
        vm.addImm(VReg.S1, VReg.S1, 32);                // 步长=条目宽度(见上方布局注释)
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_fme_loop");
        vm.label("_fme_found");
        vm.mov(VReg.RET, VReg.S1);                      // RET = entry_ptr
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_fme_nf");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // _func_meta_find(A0=code_ptr) -> RET=kind(0=未登记)。品牌路径(_opts_func)用。
        vm.label("_func_meta_find");
        vm.prologue(0, []);
        vm.call("_func_meta_entry");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fmfind_nf");
        vm.load(VReg.RET, VReg.RET, 8);                 // kind@8
        vm.epilogue([], 0);
        vm.label("_fmfind_nf");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);

        // _func_meta_name(A0=code_ptr) -> RET=name_ptr(裸数据串地址;0=未登记/匿名)。
        vm.label("_func_meta_name");
        vm.prologue(0, []);
        vm.call("_func_meta_entry");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fmname_nf");
        vm.load(VReg.RET, VReg.RET, 16);                // name_ptr@16
        vm.epilogue([], 0);
        vm.label("_fmname_nf");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);

        // [W-24] _func_meta_arity(A0=code_ptr) -> RET=arity(裸整数,>=0);未登记 → -1。
        // 规范 length 语义(首个默认/剩余形参之前的形参数),由 registerFuncMeta 静态算出。
        // 未登记用 -1 而非 0:0 是合法 arity(`function(){}`),调用方必须能区分「无此函数
        // 的元数据」与「arity 就是 0」——前者应给出 undefined,不得编造 0。
        vm.label("_func_meta_arity");
        vm.prologue(0, []);
        vm.call("_func_meta_entry");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fmarity_nf");
        vm.load(VReg.RET, VReg.RET, 24);                // arity@24
        vm.epilogue([], 0);
        vm.label("_fmarity_nf");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([], 0);

        // 数据表(须在 _data_gc_end 之后声明,不入 GC 根扫描:只存 code/data 常量地址,非堆指针)。
        this.asm.addDataLabel("_func_meta_count");
        this.asm.addDataQword(entries.length);
        this.asm.addDataLabel("_func_meta_table");
        if (entries.length === 0) {
            this.asm.addDataQword(0); // 占位使标签取得偏移(空表也须占满一条 = 4 qword)
            this.asm.addDataQword(0);
            this.asm.addDataQword(0);
            this.asm.addDataQword(0);
        } else {
            for (let i = 0; i < entries.length; i++) {
                this.asm.addDataQword(0);                // code_ptr 占位(运行期填)
                this.asm.addDataQword(entries[i].kind);  // kind 静态
                this.asm.addDataQword(0);                // name_ptr 占位(运行期填,匿名留 0)
                this.asm.addDataQword(entries[i].arity); // arity 静态
            }
        }
    }

    // ========== 二进制生成 ==========

    generateExecutable() {
        const allocGen = new AllocatorGenerator(this.vm, {
            moduleRegistrySize: this.moduleRegistrySize
        });
        allocGen.generateDataSection(this.asm);

        // 生成运行时数据段
        const runtimeGen = new RuntimeGenerator(this.vm, this.ctx);
        runtimeGen.generateAsyncDataSection(this.asm);

        // GC 数据段根扫描的终点：置于所有 qword 数据之后、finalize 追加字符串常量之前。
        // 根扫描区间 = [_data_start, _data_gc_end)，覆盖全部 boxed 全局/模块导出/捕获变量。
        this.asm.addDataLabel("_data_gc_end");
        this.asm.addDataQword(0);

        // 函数元数据侧表(code_ptr→kind);置于 _data_gc_end 之后不参与 GC 根扫描。
        this.emitFuncMetaTable();

        this.asm.finalize();

        const generator = new BinaryOutputGenerator(this);

        if (this.outputType === "shared") {
            return generator.generateSharedLibrary();
        } else if (this.outputType === "object") {
            return generator.generateObjectFile();
        } else if (this.outputType === "static") {
            return generator.generateStaticLibrary();
        }

        return generator.generateExecutable();
    }

    // ========== C 调用约定参数编译 ==========

    compileCallArgumentsForCConvention(args) {
        const vm = this.vm;
        const paramCount = Math.min(args.length, 8);
        const tempOffsets = [];

        for (let i = 0; i < paramCount; i++) {
            this.compileExpression(args[i]);
            const tempName = `__temp_arg_${i}_${this.nextLabelId()}`;
            const offset = this.ctx.allocLocal(tempName);
            tempOffsets.push(offset);
            vm.store(VReg.FP, offset, VReg.RET);
        }

        if (this.arch === "arm64") {
            for (let i = 0; i < paramCount; i++) {
                vm.load(VReg.RET, VReg.FP, tempOffsets[i]);
                this.asm.fmovToFloat(i, 0);
            }
        } else {
            for (let i = 0; i < paramCount; i++) {
                vm.load(VReg.RET, VReg.FP, tempOffsets[i]);
                this.asm.movqToXmm(i, 0);
            }
        }
    }

    // 兼容旧 API
    generateCCallingWrappers() {
        const wrapperGen = new WrapperGenerator(this);
        wrapperGen.generateARM64Wrappers(this.exports);
    }

    generateCCallingWrappersX64() {
        const wrapperGen = new WrapperGenerator(this);
        wrapperGen.generateX64Wrappers(this.exports);
    }

    // 添加字符串常量到数据段，返回标签名
    addStringConstant(str) {
        return this.asm.addString(str);
    }
}

// 混入编译器模块的方法
Object.assign(Compiler.prototype, StatementCompiler);
Object.assign(Compiler.prototype, ExpressionCompiler);
Object.assign(Compiler.prototype, FunctionCompiler);

// ========== 简化接口 ==========

export function compileFile(inputFile, outputFile, target) {
    target = target || detectPlatform();
    const compiler = new Compiler(target);
    return compiler.compileFile(inputFile, outputFile);
}

function normalizeNodeModuleName(importSource) {
    if (!importSource) return "";
    return importSource.startsWith("node:") ? importSource.slice(5) : importSource;
}

// shim import 前置注入(尊重 shebang 首行)
function injectShimImport(src, inj) {
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { // shebang
        const nl = src.indexOf("\n");
        return src.slice(0, nl + 1) + inj + src.slice(nl + 1);
    }
    return inj + src;
}

// [W-35 Unicode 属性表按需发射] 判断源码里是否出现「反斜杠 + p/P」这两个字符的
// 相邻序列(不区分它出现在正则字面量、字符串字面量还是注释里)。__regexp_shim 的
// Unicode 属性表(__RE_UT 及四张名字表)约 84KB,只有真正用到属性转义的程序才需要;
// 本函数是「是否可能用到」的**保守**判定:宁可误报(白留表,纯体积)也不可漏报。
// 故意不跳字符串/注释、也不做转义配对:
//   /\p{L}/u                → 源码有 \ p             命中
//   new RegExp("\\p{L}","u") → 源码有 \ \ p(后一对) 命中
//   注释里写 \p             → 命中(误报,无害)
// 唯一漏得掉的是把 "\" 与 "p" 分开再拼起来的动态模式(见 readModuleSource 注释)。
// 手写扫描,不用正则(本代码在 gen1 运行,§1.6 禁正则)。
function sourceHasPropEscapeText(src) {
    const n = src.length;
    let i = 0;
    while (i + 1 < n) {
        if (src.charCodeAt(i) === 92) { // '\'
            const c = src.charCodeAt(i + 1);
            if (c === 112 || c === 80) return true; // 'p' / 'P'
        }
        i++;
    }
    return false;
}

// [W-35] __regexp_shim 里那几张 Unicode 属性表的变量名(值被整串置空即省掉表体)。
function isUniTableVarName(name) {
    return name === "__RE_UT" || name === "__RE_UN_GC" || name === "__RE_UN_BIN" ||
           name === "__RE_UN_SC" || name === "__RE_UN_SCX";
}

// [批次D] 判断源码是否含正则字面量 token。手写字符扫描(不跑 Lexer 全量、
// 不用正则——本代码在 gen1 运行,§1.6 禁正则):跳过字符串/模板/注释,
// 遇 "/" 时按前一个有效字符判定除法还是正则起始(与 Lexer 的启发式同源),
// 并要求同一行内有闭合 "/"(尊重字符类内的 "/")。宁可误报(多注入一个未用
// shim 无害),不可漏报。
function sourceHasRegexLiteral(src) {
    const n = src.length;
    let i = 0;
    let prevEnd = -1; // 最近一个有效字符下标;-1=开头,-2=字符串字面量结尾(后随 / 是除法)
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { // shebang 行跳过
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 39 || c === 34 || c === 96) { // ' " `
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; } // 转义
                if (d === q) break;
                if (q !== 96 && d === 10) break; // 普通串不跨行
                i++;
            }
            i++;
            prevEnd = -2;
            continue;
        }
        if (c === 47) { // '/'
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) { // 行注释
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) { // 块注释
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            if (regexCanStartAfter(src, prevEnd) && scanRegexLiteralBody(src, i)) {
                return true;
            }
            prevEnd = i; // 除法算符
            i++;
            continue;
        }
        if (c !== 32 && c !== 9 && c !== 13 && c !== 10) prevEnd = i;
        i++;
    }
    return false;
}

// "/" 出现在 prevEnd 之后,能否是正则起始?(值结尾 → 除法;算符/开头 → 正则)
function regexCanStartAfter(src, prevEnd) {
    if (prevEnd === -2) return false; // 字符串字面量之后 → 除法
    if (prevEnd < 0) return true; // 文件开头
    const p = src.charCodeAt(prevEnd);
    if (p === 41 || p === 93 || p === 125) return false; // ) ] } 之后按除法(保守)
    const isIdent = (p >= 48 && p <= 57) || (p >= 65 && p <= 90) ||
        (p >= 97 && p <= 122) || p === 95 || p === 36;
    if (!isIdent) return true; // 运算符、逗号、( [ { ; : ! ? = 等
    // 标识符/数字结尾:仅关键字之后允许正则(return /x/ 等)
    let s = prevEnd;
    while (s > 0) {
        const q = src.charCodeAt(s - 1);
        if ((q >= 48 && q <= 57) || (q >= 65 && q <= 90) ||
            (q >= 97 && q <= 122) || q === 95 || q === 36) s--;
        else break;
    }
    const w0 = src.charCodeAt(s);
    if (w0 >= 48 && w0 <= 57) return false; // 数字字面量 → 除法
    const word = src.slice(s, prevEnd + 1);
    return word === "return" || word === "case" || word === "typeof" ||
        word === "in" || word === "of" || word === "instanceof" ||
        word === "new" || word === "delete" || word === "void" ||
        word === "throw" || word === "do" || word === "else" ||
        word === "yield" || word === "await";
}

// 从 "/"(下标 i)起,同一行内是否有形如正则字面量的闭合体
function scanRegexLiteralBody(src, i) {
    const n = src.length;
    let j = i + 1;
    let inClass = false;
    let any = false;
    while (j < n) {
        const c = src.charCodeAt(j);
        if (c === 10) return false; // 正则不跨行
        if (c === 92) { // 转义
            j += 2;
            any = true;
            continue;
        }
        if (c === 91) inClass = true;
        else if (c === 93) inClass = false;
        else if (c === 47 && !inClass) return any; // 闭合(体非空;// 已被注释分支排除)
        any = true;
        j++;
    }
    return false;
}

// 源码是否含**调用形式**的 RegExp(...)(无 new)。手写扫描,不用正则(§1.6);
// 只在「代码位置」按整词匹配,故:
//   - myRegExp( / xRegExp( 不命中(标识符整词读出后比较,天然带词边界);
//   - 注释与字符串/模板文本里的 "RegExp(" 不命中(编译器自身 types.js、
//     functions.js 的中文注释里就有这串,裸 indexOf 会让自举白注入 shim);
//   - 模板替换 ${...} 内部按代码扫(`${RegExp("a")}` 仍命中,漏报比误报更糟)。
// `new RegExp(` 也会命中,但那条路径已被 reCtorText 覆盖,重复无害。
// 调用点仅在源码无正则字面量时才到达(见 readModuleSource 的 || 顺序),故
// "/" 一律按行注释/块注释/除法处理,不必再做正则字面量启发式。
function sourceHasRegExpCall(src) {
    const target = "Reg" + "Exp"; // 拆开拼接:免得本文件自己命中
    const n = src.length;
    let i = 0;
    let inTplText = false;  // 正在扫模板字面量的文本部分(非 ${} 内)
    const tplBrace = [];    // 每层 ${ 起始时的花括号深度,用于识别配对的 }
    let brace = 0;
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { // shebang 行跳过
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (inTplText) {
            if (c === 92) { i += 2; continue; } // 转义
            if (c === 96) { inTplText = false; i++; continue; } // ` 收尾
            if (c === 36 && i + 1 < n && src.charCodeAt(i + 1) === 123) { // ${
                inTplText = false;
                tplBrace.push(brace);
                brace++;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === 96) { inTplText = true; i++; continue; } // 模板起始
        if (c === 39 || c === 34) { // ' "
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; }
                if (d === q) break;
                if (d === 10) break; // 普通串不跨行
                i++;
            }
            i++;
            continue;
        }
        if (c === 47) { // '/'
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) { // 行注释
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) { // 块注释
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            i++; // 除法
            continue;
        }
        if (c === 123) { brace++; i++; continue; }
        if (c === 125) {
            brace--;
            if (tplBrace.length > 0 && tplBrace[tplBrace.length - 1] === brace) {
                tplBrace.pop();
                inTplText = true; // ${} 收尾,回到模板文本
            }
            i++;
            continue;
        }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
            const s = i;
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 36) i++;
                else break;
            }
            if (i - s === target.length && src.slice(s, i) === target) {
                let j = i;
                while (j < n) { // 允许 RegExp ( 之间有空白
                    const w = src.charCodeAt(j);
                    if (w === 32 || w === 9 || w === 13 || w === 10) j++;
                    else break;
                }
                if (j < n && src.charCodeAt(j) === 40) return true;
            }
            continue;
        }
        if (c >= 48 && c <= 57) { // 数字:整体跳过,免得 1e5 之类被拆出标识符
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 46) i++;
                else break;
            }
            continue;
        }
        i++;
    }
    return false;
}

// 从 "/"(下标 i)起跳过正则字面量体,返回闭合 "/" 之后的下标;同一行内无合法
// 闭合(或体为空)返回 -1。规则与 scanRegexLiteralBody 一一对应(后者只判有无、
// 本函数给出终点,供 sourceHasTopLevelEsmDecl 整体跳过正则)。
function skipRegexLiteralBody(src, i) {
    const n = src.length;
    let j = i + 1;
    let inClass = false;
    let any = false;
    while (j < n) {
        const c = src.charCodeAt(j);
        if (c === 10) return -1; // 正则不跨行
        if (c === 92) { j += 2; any = true; continue; } // 转义
        if (c === 91) inClass = true;
        else if (c === 93) inClass = false;
        else if (c === 47 && !inClass) return any ? j + 1 : -1; // 闭合(体非空)
        any = true;
        j++;
    }
    return -1;
}

// [CJS 误判修复] 词法感知判定:源码在**真实代码位置**是否含顶层 import/export
// 声明关键字。looksLikeCjsSource 的 ESM 判据,取代朴素子串扫描:注释/字符串/
// 模板文本/正则字面量里的 "export "/"import " 文字不算数(那些文字曾使合法 CJS
// 文件被误判为非 CJS、不做 CJS 包装,import 之运行期崩
// "FATAL: _object_set called with NULL object";Node 照常执行)。
// 手写字符扫描(§1.6 禁正则;本代码在 gen1 运行),状态机与 sourceHasRegExpCall
// 同源:字符串/模板/注释整体跳过,模板 ${} 用 tplBrace 栈归位,"/" 按
// regexCanStartAfter 启发式区分正则起始与除法。
// 语义与原扫描对齐、仅剔除字面量内误报(保守:拿不准的一律维持原判定):
//   export:花括号深度 0、前一有效字符非 "."(排除 x.export)、紧随字符
//     ∈ {空白, {, *}(export 声明的全部合法续接;export: 标签/var export 等
//     保留字误用在 Node 同为 SyntaxError,判 ESM 不算误拒);
//   import:深度 0、前一有效字符非 "."、同行前方只有空白(与原 "\nimport "
//     行首锚定一致)、跳过空白后下一字符非 "(" 非 "."(排除动态 import() 与
//     import.meta;import"x" 副作用导入仍算声明)。
// 深度 > 0 的 import/export 声明在合法 JS 中不存在;对象字面量 { export: 1 }、
// 类方法 export(){} 由深度自然排除。
// 已知偏差(与原扫描同错或更准,不劣化):非 ASCII 字节紧邻的 "export" 子串仍
// 可能误判(同原扫描);")" 之后的正则按除法处理(regexCanStartAfter 保守分支,
// 与本编译器解析器自身对 ")" 后 "/" 的处理一致,不引入新分歧)。
function sourceHasTopLevelEsmDecl(src) {
    const n = src.length;
    let i = 0;
    let inTplText = false;  // 正在扫模板字面量的文本部分(非 ${} 内)
    const tplBrace = [];    // 每层 ${ 起始时的花括号深度,用于识别配对的 }
    let brace = 0;
    let prevEnd = -1; // 最近一个有效字符下标;-1=开头,-2=字符串/模板/正则结尾
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { // shebang 行跳过
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (inTplText) {
            if (c === 92) { i += 2; continue; } // 转义
            if (c === 96) { inTplText = false; prevEnd = -2; i++; continue; } // ` 收尾
            if (c === 36 && i + 1 < n && src.charCodeAt(i + 1) === 123) { // ${
                inTplText = false;
                tplBrace.push(brace);
                brace++;
                i += 2;
                prevEnd = i - 1; // ${ 的 "{" 是有效字符(其后 / 按正则起始)
                continue;
            }
            i++;
            continue;
        }
        if (c === 96) { inTplText = true; i++; continue; } // 模板起始
        if (c === 39 || c === 34) { // ' "
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; }
                if (d === q) break;
                if (d === 10) break; // 普通串不跨行
                i++;
            }
            i++;
            prevEnd = -2;
            continue;
        }
        if (c === 47) { // '/'
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) { // 行注释
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) { // 块注释
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            const reEnd = regexCanStartAfter(src, prevEnd) ? skipRegexLiteralBody(src, i) : -1;
            if (reEnd > 0) { // 正则字面量:连同 flags 整体跳过
                i = reEnd;
                while (i < n) {
                    const f = src.charCodeAt(i);
                    if ((f >= 97 && f <= 122) || (f >= 65 && f <= 90)) i++;
                    else break;
                }
                prevEnd = -2;
                continue;
            }
            prevEnd = i; // 除法算符
            i++;
            continue;
        }
        if (c === 123) { brace++; prevEnd = i; i++; continue; }
        if (c === 125) {
            brace--;
            if (tplBrace.length > 0 && tplBrace[tplBrace.length - 1] === brace) {
                tplBrace.pop();
                inTplText = true; // ${} 收尾,回到模板文本
            }
            prevEnd = i;
            i++;
            continue;
        }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
            const s = i;
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 36) i++;
                else break;
            }
            if (brace === 0 && i - s === 6) {
                const prevCh = prevEnd >= 0 ? src.charCodeAt(prevEnd) : 0;
                if (prevCh !== 46) { // 非 x.export / x.import 成员访问
                    const word = src.slice(s, i);
                    if (word === "export") {
                        const f = i < n ? src.charCodeAt(i) : 0;
                        // export 声明的合法续接:空白 { *(export: 标签等排除)
                        if (f === 32 || f === 9 || f === 10 || f === 13 ||
                            f === 123 || f === 42) return true;
                    } else if (word === "import") {
                        // 行首锚定(与原 "\nimport " 语义一致):同行前方只有空白
                        let ls = s - 1;
                        let lineStart = true;
                        while (ls >= 0) {
                            const w = src.charCodeAt(ls);
                            if (w === 10) break;
                            if (w === 32 || w === 9 || w === 13) { ls--; continue; }
                            lineStart = false;
                            break;
                        }
                        if (lineStart) {
                            let j = i;
                            while (j < n) { // import 与下一 token 间允许空白
                                const w = src.charCodeAt(j);
                                if (w === 32 || w === 9 || w === 13 || w === 10) j++;
                                else break;
                            }
                            const f = j < n ? src.charCodeAt(j) : 0;
                            if (f !== 40 && f !== 46) return true; // 非 import( / import.
                        }
                    }
                }
            }
            prevEnd = i - 1;
            continue;
        }
        if (c >= 48 && c <= 57) { // 数字:整体跳过,免得 1e5 之类被拆出标识符
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 46) i++;
                else break;
            }
            prevEnd = i - 1;
            continue;
        }
        if (c !== 32 && c !== 9 && c !== 13 && c !== 10) prevEnd = i;
        i++;
    }
    return false;
}

// [PERF] 按编译期缓存:同一 (forRequire, sourcePath, importSource) 的解析结果在一次
// 编译内不变(文件系统快照语义)。省掉每次重复的 path.resolve/normalize/existsSync/
// statSync(每次 import 数个系统调用与一串串操作,自编译实测 resolveImports 簇 ~6.7%)。
// 进程级 Map:CLI 单编译进程天然有界;route B 多次编译共享亦无碍(内容只增)。
const _resolvePathMemo = new Map();

function resolveModulePath(importSource, sourcePath, nodeShimPath, pathMod, fsMod, forRequire) {
    const memoKey = (forRequire ? "R" : "I") + (sourcePath || "") + "|" + importSource;
    let memoHit = _resolvePathMemo.get(memoKey);
    if (memoHit !== undefined) return memoHit;
    const resolved = resolveModulePathUncached(importSource, sourcePath, nodeShimPath, pathMod, fsMod, forRequire);
    _resolvePathMemo.set(memoKey, resolved);
    return resolved;
}

function resolveModulePathUncached(importSource, sourcePath, nodeShimPath, pathMod, fsMod, forRequire) {
    if (!importSource) return "";

    const normalizedSource = normalizeNodeModuleName(importSource);
    // 裸内建模块（单段 "fs" 或子路径 "fs/promises"）。子路径映射到
    // runtime/node/<subpath>.js（如 node:fs/promises → runtime/node/fs/promises.js）。
    if (isBareModuleName(normalizedSource) || isBareSubpath(normalizedSource)) {
        const builtinPath = pathMod.resolve(runtimeNodeBase(pathMod, fsMod), "runtime/node", normalizedSource + ".js");
        if (fsMod.existsSync(builtinPath)) {
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
        return "";
    }

    const absSourcePath = pathMod.resolve(sourcePath || ".");
    // sourcePath 已是目录（resolveImports 传入前做过 dirname）。用 ".js 结尾=文件" 判断，
    // 不用 statSync().isDirectory()——自举运行时该 shim 恒返 false，会把目录再 dirname 一层
    // （"a/compiler"→"a/"）致相对导入丢一段路径（"a/../lang"），模块读空 → gen2 空壳根因。
    let currentDir = absSourcePath;
    if ((absSourcePath.endsWith(".js") || absSourcePath.endsWith(".mjs")) && !pathIsDirectory(fsMod, absSourcePath)) {
        currentDir = pathMod.dirname(absSourcePath);
    }

    let resolvedPath = importSource.startsWith("/")
        ? importSource
        : pathMod.resolve(currentDir, importSource);

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
// clone 目录即 "asm.js")。node 下 statSync 实辨;自举运行时该 shim 恒返 false,
// 调用方退回原后缀启发式(行为与旧版一致)。
function pathIsDirectory(fsMod, p) {
    try { return fsMod.statSync(p).isDirectory() === true; } catch (e) { return false; }
}

// 折叠路径里的 "." 与 ".."（不依赖 pathMod.normalize，其在自举运行时可能不可靠）
function normalizePathSegments(p) {
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
function resolvePackageSpecifier(spec, sourcePath, pathMod, fsMod, forRequire) {
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
function resolveExportsField(exp, subpath, forRequire) {
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

function resolveConditionTarget(v, forRequire) {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null) {
        const cond = forRequire ? "require" : "import";
        if (v[cond] !== undefined) return resolveConditionTarget(v[cond], forRequire);
        if (v.node !== undefined) return resolveConditionTarget(v.node, forRequire);
        if (v.default !== undefined) return resolveConditionTarget(v.default, forRequire);
    }
    return null;
}

// Collect all export names from a module AST
// If _moduleOrder and _moduleExportsList are provided, resolve export * from other modules
function collectModuleExports(moduleAst, _moduleOrder = null, _nodeShimPath = null, _moduleExportsList = null, _path = null, _fs = null) {
    const exports = [];

    for (const stmt of moduleAst.body) {
        // Debug: log all statement types for index.js
        if (moduleAst.filename && moduleAst.filename.includes('index.js') && moduleAst.filename.includes('runtime/node')) {
        }
        if (stmt.type === "ExportDeclaration" && stmt.declaration) {
            const decl = stmt.declaration;
            if (stmt.default) {
                if (decl.type === "FunctionDeclaration") {
                    exports.push({ name: "default", kind: "function", localName: decl.id && decl.id.name });
                } else if (decl.type === "ClassDeclaration") {
                    exports.push({ name: "default", kind: "class", localName: decl.id && decl.id.name });
                } else if (decl.type === "Identifier") {
                    exports.push({ name: "default", kind: "local", localName: decl.name });
                } else {
                    exports.push({ name: "default", kind: "expression", expression: decl });
                }
            } else if (decl.type === "VariableDeclaration") {
                for (const decl2 of decl.declarations) {
                    if (decl2.id && decl2.id.type === "Identifier") {
                        exports.push({ name: decl2.id.name, kind: "const", localName: decl2.id.name });
                    }
                }
            } else if (decl.type === "FunctionDeclaration") {
                exports.push({ name: decl.id.name, kind: "function" });
            } else if (decl.type === "ClassDeclaration") {
                exports.push({ name: decl.id.name, kind: "class" });
            } else if (decl.type === "Identifier") {
                exports.push({ name: decl.name, kind: "reexport" });
            }
        } else if (stmt.type === "ExportDeclaration" && !stmt.declaration && stmt.specifiers) {
            if (Array.isArray(stmt.specifiers)) {
                // Check for export * from "module" (empty specifiers array in asm.js's parser)
                if (stmt.specifiers.length === 0 && stmt.source) {
                    // This is export * from "module"
                    const sourcePath = stmt.source.value;
                    if (sourcePath && _moduleOrder && _nodeShimPath) {
                        // Resolve the source module index
                        let resolvedPath = resolveModulePath(sourcePath, moduleAst.filename, _nodeShimPath, _path, _fs);

                        // Find the module index
                        let sourceModuleIndex = -1;
                        for (let i = 0; i < _moduleOrder.length; i++) {
                            if (_moduleOrder[i].filename === resolvedPath) {
                                sourceModuleIndex = i;
                                break;
                            }
                        }

                        if (sourceModuleIndex >= 0 && _moduleExportsList && _moduleExportsList[sourceModuleIndex]) {
                            // Resolve star export by getting exports from source module
                            const sourceExports = _moduleExportsList[sourceModuleIndex];
                            for (const exp of sourceExports) {
                                // Skip default export and duplicates
                                if (exp.name === 'default') continue;
                                if (exports.find(e => e.name === exp.name)) {
                                    continue;
                                }
                                exports.push({
                                    name: exp.name,
                                    kind: "reexport",
                                    sourceModuleIndex: sourceModuleIndex
                                });
                            }
                        } else if (sourceModuleIndex >= 0) {
                            // Source module not yet processed - defer
                            exports.push({
                                name: "*",
                                source: sourcePath,
                                resolvedPath: resolvedPath,
                                sourceModuleIndex: sourceModuleIndex,
                                kind: "star"
                            });
                        } else {
                        }
                    }
                } else {
                    // Regular export with specifiers
                    let sourceModuleIndex = undefined;
                    if (stmt.source && _moduleOrder && _nodeShimPath) {
                        const resolvedPath = resolveModulePath(stmt.source.value, moduleAst.filename, _nodeShimPath, _path, _fs);
                        const sourceAst = _moduleOrder.find((mod) => mod.filename === resolvedPath);
                        if (sourceAst) {
                            sourceModuleIndex = _moduleOrder.indexOf(sourceAst);
                        }
                    }

                    for (const spec of stmt.specifiers) {
                        if (spec.exported) {
                            const isReexportFromModule = !!stmt.source;
                            const localName = spec.local && (spec.local.name || spec.local.value);
                            exports.push({
                                name: spec.exported.name || spec.exported.value,
                                kind: isReexportFromModule ? "reexport" : "local",
                                localName,
                                importedName: localName,
                                sourceModuleIndex,
                                namespace: spec.namespace === true
                            });
                        }
                    }
                }
            }
        } else if (stmt.type === "ExportAllDeclaration") {
            // export * from "./os.js"
            const sourcePath = stmt.source ? stmt.source.value : null;
            if (sourcePath && _moduleOrder && _nodeShimPath) {
                // Resolve the source module index
                const resolvedPath = resolveModulePath(sourcePath, moduleAst.filename, _nodeShimPath, _path, _fs);

                // Find the module index
                let sourceModuleIndex = -1;
                for (let i = 0; i < _moduleOrder.length; i++) {
                    if (_moduleOrder[i].filename === resolvedPath) {
                        sourceModuleIndex = i;
                        break;
                    }
                }

                if (sourceModuleIndex >= 0 && _moduleExportsList && _moduleExportsList[sourceModuleIndex]) {
                    // Resolve star export by getting exports from source module
                    // _moduleExportsList[sourceModuleIndex] is available if source module was already processed
                    const sourceExports = _moduleExportsList[sourceModuleIndex];
                    for (const exp of sourceExports) {
                        // Skip default export and duplicates
                        if (exp.name === 'default') continue;
                        if (exports.find(e => e.name === exp.name)) {
                            continue;
                        }
                        exports.push({
                            name: exp.name,
                            kind: "reexport",
                            sourceModuleIndex: sourceModuleIndex
                        });
                    }
                } else if (sourceModuleIndex >= 0) {
                    // Source module not yet processed - this shouldn't happen in normal flow
                    exports.push({
                        name: "*",
                        source: sourcePath,
                        resolvedPath: resolvedPath,
                        sourceModuleIndex: sourceModuleIndex,
                        kind: "star"
                    });
                } else {
                }
            }
        }
    }
    return exports;
}
