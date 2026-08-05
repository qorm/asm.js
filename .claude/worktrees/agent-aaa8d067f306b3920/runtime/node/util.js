// asm.js Runtime - Node.js util
// Provides utility functions for asm.js compiled binaries

// Node 风格单行 inspect(简化):字符串加引号,数组 [ ... ],普通对象 { k: v }。
function _inspect(v, depth, maxDepth) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    const t = typeof v;
    // 先处理 string/boolean/function:function 值走 `instanceof` 会崩(编译器缺陷),
    // 必须在任何 instanceof 之前返回。
    if (t === "string") return "'" + v + "'";
    if (t === "boolean") return String(v);
    if (t === "function") {
        const nm = v.name;
        return (nm && nm.length > 0) ? "[Function: " + nm + "]" : "[Function (anonymous)]";
    }
    // instanceof 须先于 number 分支:asm.js 里 Map/Set/Date 实例 typeof 返回 "number"
    // (类型标记缺陷),否则会被当数字 String() 出垃圾值。真数字/字符串 instanceof 安全返 false。
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Map) {
        const parts = [];
        v.forEach(function (val, key) {
            parts.push(_inspect(key, depth + 1, maxDepth) + " => " + _inspect(val, depth + 1, maxDepth));
        });
        return "Map(" + v.size + ") " + (parts.length ? "{ " + parts.join(", ") + " }" : "{}");
    }
    if (v instanceof Set) {
        const parts = [];
        v.forEach(function (val) { parts.push(_inspect(val, depth + 1, maxDepth)); });
        return "Set(" + v.size + ") " + (parts.length ? "{ " + parts.join(", ") + " }" : "{}");
    }
    if (t === "number") return String(v);
    // 超过 maxDepth 的嵌套显示 [Object]/[Array](node depth 语义)
    if (depth > maxDepth) return Array.isArray(v) ? "[Array]" : "[Object]";
    if (Array.isArray(v)) {
        const parts = [];
        for (let i = 0; i < v.length; i++) parts.push(_inspect(v[i], depth + 1, maxDepth));
        return parts.length ? "[ " + parts.join(", ") + " ]" : "[]";
    }
    if (t === "object") {
        const keys = Object.keys(v);
        const parts = [];
        for (let i = 0; i < keys.length; i++) parts.push(keys[i] + ": " + _inspect(v[keys[i]], depth + 1, maxDepth));
        return parts.length ? "{ " + parts.join(", ") + " }" : "{}";
    }
    return String(v);
}

function _deepStrictEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    const aArr = Array.isArray(a), bArr = Array.isArray(b);
    if (aArr !== bArr) return false;
    if (aArr) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!_deepStrictEqual(a[i], b[i])) return false;
        return true;
    }
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) if (!_deepStrictEqual(a[ak[i]], b[ak[i]])) return false;
    return true;
}

export const util = {
    format(...args) {
        if (!args.length) return "";
        const fmt = args[0];
        if (typeof fmt !== "string") return String(fmt);
        let i = 1;
        // 手写 %s/%d/... 扫描(不用正则字面量——避免触发 __regexp_shim 注入,
        // 且 shim 的 replace 不支持函数替换参数,见 compiler/index.js)
        let out = "";
        let j = 0;
        while (j < fmt.length) {
            const ch = fmt.charAt(j);
            if (ch === "%" && j + 1 < fmt.length && "sdifjoOc".indexOf(fmt.charAt(j + 1)) !== -1) {
                const match = fmt.slice(j, j + 2);
                j += 2;
                if (i >= args.length) { out += match; continue; }
                const arg = args[i++];
                switch (match) {
                    case "%s": out += (arg !== null && typeof arg === "object") ? _inspect(arg, 0, 2) : String(arg); break;
                    case "%d": out += Number(arg); break;
                    case "%i": out += parseInt(arg); break;
                    case "%f": out += parseFloat(arg); break;
                    case "%j": try { out += JSON.stringify(arg); } catch { out += "[Circular]"; } break;
                    case "%o": case "%O": out += String(arg); break;
                    case "%c": break;
                    default: out += match;
                }
                continue;
            }
            out += ch;
            j++;
        }
        // 剩余未消费的参数按空格追加(Node 行为):字符串原样,其余走 inspect。
        while (i < args.length) {
            out += " ";
            const a = args[i++];
            out += typeof a === "string" ? a : _inspect(a, 0, 2);
        }
        return out;
    },

    // inspect(obj, options?) —— options.depth(默认 2,null=无限)决定嵌套展开层数。
    // 也兼容旧签名 inspect(obj, showHidden, depth)。
    inspect(obj, options, depth3) {
        let maxDepth = 2;
        if (options && typeof options === "object" && options.depth !== undefined) {
            maxDepth = options.depth === null ? 1000000000 : options.depth;
        } else if (typeof depth3 === "number") {
            maxDepth = depth3;
        }
        return _inspect(obj, 0, maxDepth);
    },
    isArray: (obj) => Array.isArray(obj),

    promisify(fn) {
        // 回调式 (…args, cb(err, result)) → 返回 Promise 的函数
        return function (...args) {
            return new Promise((resolve, reject) => {
                fn(...args, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        };
    },
    // promisify 的逆:Promise 返回式 → 回调式 (…args, cb(err, result))。
    callbackify(fn) {
        return function (...args) {
            const cb = args[args.length - 1];
            const rest = args.slice(0, args.length - 1);
            Promise.resolve(fn(...rest)).then(
                (val) => cb(null, val),
                (err) => cb(err)
            );
        };
    },

    isDeepStrictEqual(a, b) { return _deepStrictEqual(a, b); },

    types: {
        isArray: (obj) => Array.isArray(obj),
        isBoolean: (obj) => typeof obj === "boolean",
        isNativeError: (obj) => obj instanceof Error,
        isBuffer: (obj) => obj instanceof Buffer,
        isDate: (obj) => obj instanceof Date,
        isError: (obj) => obj instanceof Error,
        isFunction: (obj) => typeof obj === "function",
        isNull: (obj) => obj === null,
        isNullOrUndefined: (obj) => obj === null || obj === undefined,
        isNumber: (obj) => typeof obj === "number",
        isObject: (obj) => typeof obj === "object",
        isPrimitive: (obj) => obj === null || (typeof obj !== "object" && typeof obj !== "function"),
        isString: (obj) => typeof obj === "string",
        isSymbol: (obj) => typeof obj === "symbol",
        isUndefined: (obj) => obj === undefined,
        isRegExp: (obj) => obj instanceof RegExp,
        isBigInt: (obj) => typeof obj === "bigint",
        isPromise: (obj) => obj instanceof Promise,
        isMap: (obj) => obj instanceof Map,
        isSet: (obj) => obj instanceof Set,
        isWeakMap: (obj) => obj instanceof WeakMap,
        isWeakSet: (obj) => obj instanceof WeakSet
    },

    _extend: (target, source) => Object.assign(target, source),

    inherits: (ctor, superCtor) => {
        ctor.super_ = superCtor;
        Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
    },

    debuglog: () => () => {},
    debug: () => {},
    deprecate: (fn, msg) => fn,
    getSystemErrorMap: () => new Map(),
    getSystemErrorName: () => "",
    isArrayBuffer: () => false,
    isAsyncFunction: () => false,
    isBigInt64Array: () => false,
    isBigUint64Array: () => false,
    isBoxedPrimitive: () => false,
    isDataView: () => false,
    isExternal: () => false,
    isFloat32Array: () => false,
    isFloat64Array: () => false,
    isGeneratorFunction: () => false,
    isInt32Array: () => false,
    isInt8Array: () => false,
    isInt16Array: () => false,
    isMap: () => false,
    isMapIterator: () => false,
    isNativeError: () => false,
    isPromise: (obj) => obj instanceof Promise,
    isProxy: () => false,
    isSet: () => false,
    isSetIterator: () => false,
    isSharedArrayBuffer: () => false,
    isTypedArray: () => false,
    isUint32Array: () => false,
    isUint8Array: () => false,
    isUint8ClampedArray: () => false,
    isWeakMap: () => false,
    isWeakSet: () => false,
    toUSVInteger: (val) => Math.floor(val) >>> 0
};

export const sys = util; // deprecated alias

// Top-level named exports mirroring Node's `require("util")` shape. asm.js's
// require() currently returns the module namespace (see backlog: _requireKind
// dynamic-field divergence in the self-compiled compiler), so the public API
// must live at top level — not nested inside the `util` object — for
// `require("util").format` etc. to resolve. Methods are `this`-free (they close
// over module-local _inspect/_deepStrictEqual), so binding them as consts is safe.
export const format = util.format;
export const inspect = util.inspect;
export const promisify = util.promisify;
export const callbackify = util.callbackify;
export const isDeepStrictEqual = util.isDeepStrictEqual;
export const isArray = util.isArray;
export const inherits = util.inherits;
export const deprecate = util.deprecate;
export const debuglog = util.debuglog;
export const debug = util.debug;
export const _extend = util._extend;
export const getSystemErrorMap = util.getSystemErrorMap;
export const getSystemErrorName = util.getSystemErrorName;
export const types = util.types;

// Web-platform base64 globals (btoa/atob). Node exposes these as globals with no
// import; asm.js wires the bare identifiers via implicit-global injection
// (compiler/index.js _injectImplicitGlobalImports) to these exports. Housed here
// because util.js is not imported by the compiler → self-host-safe (unlike
// buffer.js which is on the layout-cliff import set). Latin1/binary-string
// semantics, matching HTML btoa/atob.
const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function btoa(input) {
    const s = String(input);
    let out = "";
    for (let i = 0; i < s.length; i += 3) {
        const b0 = s.charCodeAt(i) & 0xff;
        const has1 = i + 1 < s.length, has2 = i + 2 < s.length;
        const b1 = has1 ? s.charCodeAt(i + 1) & 0xff : 0;
        const b2 = has2 ? s.charCodeAt(i + 2) & 0xff : 0;
        out += _B64.charAt(b0 >> 2);
        out += _B64.charAt(((b0 & 3) << 4) | (b1 >> 4));
        out += has1 ? _B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=";
        out += has2 ? _B64.charAt(b2 & 63) : "=";
    }
    return out;
}
export function atob(input) {
    const s = String(input);
    let out = "";
    let acc = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (c === "=") break;
        const v = _B64.indexOf(c);
        if (v < 0) continue;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
    }
    return out;
}

export default util;
