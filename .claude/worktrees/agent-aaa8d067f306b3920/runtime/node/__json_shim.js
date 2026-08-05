// JSON.stringify / JSON.parse 的纯 JS shim(#15 批次3)。
// 接线:compiler/index.js 检测模块源码引用 JSON.stringify/parse 时自动前置
// `import { __JSON_stringify, __JSON_parse } from "__json_shim";`,
// compileCallExpression 把 JSON.stringify(x) 改派为 __JSON_stringify(x)。
// 裸名经 cwd/runtime/node/ 解析(与 fs/path 同机制)。
//
// gen1-safe 纪律(BOOTSTRAP_RULES §1):不用正则、不用 Map 迭代中删除、
// 不用 arr.length=n 截断、字符串只用 charCodeAt/charAt/slice/fromCharCode/+、
// 数组判定用 instanceof Array、数字解析纯算术(不依赖 parseFloat/parseInt)。
// 覆盖:标量/串转义(含 \uXXXX 与控制符)/数组/嵌套对象;undefined/函数按规范
// (对象内跳过、数组内 "null"、顶层返回 undefined)。stringify 支持 replacer
// (函数逐节点 this=holder / 数组键白名单)、space 缩进(数字钳[0,10]/字符串前10)、
// toJSON 协议(节点对象有 function 型 toJSON 先调再序列化);parse 支持 reviver
// (自底向上,返回 undefined 删属性)。未覆盖:循环引用检测(深度 200 兜底防炸栈)。

function __jsonHex4(n) {
    const h = "0123456789abcdef";
    return h.charAt((n >> 12) & 15) + h.charAt((n >> 8) & 15) + h.charAt((n >> 4) & 15) + h.charAt(n & 15);
}

function __jsonQuote(s) {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 34) out += '\\"';
        else if (c === 92) out += "\\\\";
        else if (c === 10) out += "\\n";
        else if (c === 13) out += "\\r";
        else if (c === 9) out += "\\t";
        else if (c === 8) out += "\\b";
        else if (c === 12) out += "\\f";
        else if (c < 32) out += "\\u" + __jsonHex4(c);
        else out += s.charAt(i);
    }
    return out + '"';
}

// 纯 JS 数字→串(不依赖原生浮点转串 —— _floatToString 的 len 头历史性不可靠,
// 见任务 #15 记录;整数走 ""+v 原生路径[已验可靠],小数位提取纯算术,
// 15 位有效数字后截断并去尾零,与 node 在常见值一致、极端值容许偏差)。
function __jsonNum(v) {
    let out = "";
    if (v < 0) { out = "-"; v = -v; }
    let ip = 0;
    // 整数部分(v < 2^53 精确;更大值退化为整数近似,JSON 数字场景可接受)
    ip = v - (v % 1);
    let frac = v - ip;
    // 整数位数字串(避免 ""+浮点;逐位取模,ip===0 时 "0")
    if (ip === 0) {
        out += "0";
    } else {
        let digits = "";
        while (ip >= 1) {
            const d = ip % 10;
            digits = String.fromCharCode(48 + (d - (d % 1))) + digits;
            ip = (ip - d) / 10;
        }
        out += digits;
    }
    if (frac > 0) {
        let fs = "";
        let nz = -1; // 最后一个非零位置
        for (let i = 0; i < 15; i++) {
            frac = frac * 10;
            let d = frac - (frac % 1);
            if (d > 9) d = 9;
            frac = frac - d;
            fs += String.fromCharCode(48 + d);
            if (d !== 0) nz = i;
            if (frac <= 0) break;
        }
        if (nz >= 0) out += "." + fs.slice(0, nz + 1);
    }
    return out;
}

// stringify 运行态(单线程编译/运行模型;__JSON_stringify 进入时保存/退出时恢复,
// 允许 toJSON/replacer 内部再调 JSON.stringify 的重入)。
//   __js_replacer:replacer 函数,或 null
//   __js_proplist:数组白名单去重后的字符串键数组,或 null(表示无白名单)
//   __js_gap:每层缩进单元串("" 表示紧凑输出)
let __js_replacer = null;
let __js_proplist = null;
let __js_gap = "";

// obj 是否自有键 k(缺失键读出为数字 0 而非 undefined,故不能靠 obj[k]===undefined
// 判定;须遍历自有键比对。k 来自用户白名单 → 全程 typeof 守卫,不触原型链 [#32])。
function __jsonHasKey(obj, k) {
    for (const kk in obj) {
        if (kk === k) return true;
    }
    return false;
}

// 序列化"已定型"的值(已过 toJSON/replacer),返回串或 undefined(表示跳过/顶层空)。
function __jsonSer(value, indent, depth) {
    if (depth > 200) return '"[Deep]"'; // 循环引用/超深兜底(node 抛 TypeError,此处降级)
    const t = typeof value;
    if (t === "number") {
        // 非有限数(NaN/±Infinity)在 JSON 里一律 null(规范 SerializeJSONProperty)。
        // [#50/#51] 表示无关的非有限检测:NaN(0x7FF0…)/±Infinity 经 _floatToString
        // 打印为 "NaN"/"Infinity"/"-Infinity",而 native NaN-box 下 `value!==value`
        // 恒假(=== 按位)、`value*2===0` 只对 0x7FF8 那支 NaN 成立——NaN 标识符已改
        // 0x7FF0…1(#51,不与 int0 别名),旧位判据失效。改用字符串形判,一劳永逸。
        const __nfs = "" + value;
        if (__nfs === "NaN" || __nfs === "Infinity" || __nfs === "-Infinity") return "null";
        // `"" + value` 现经修复的 _floatToString 精确最短往返,= JSON 数字格式(ES Number::toString);
        // 旧 __jsonNum(15 位截断)不再需要。
        return __nfs;
    }
    if (t === "boolean") return value ? "true" : "false";
    if (t === "string") return __jsonQuote(value);
    if (value === null) return "null";
    if (t === "undefined" || t === "function") return undefined;
    if (value instanceof Array) return __jsonArr(value, indent, depth);
    if (t === "object") return __jsonObj(value, indent, depth);
    return undefined;
}

// SerializeJSONProperty:先 toJSON、再 replacer 函数(this=holder),然后按类型序列化。
// value 由调用方按数字下标/键取好后传入(避免数组的字符串下标访问)。
function __jsonPropV(holder, key, value, indent, depth) {
    // [#50/#62] Date 桥必须先于 toJSON 探测。#62 起 Date 装箱为对象(typeof "object"),
    // 而 Date 堆块仅 16 字节;若先走 `typeof value.toJSON`(=对象属性读 _object_get)会把
    // Date 块当普通对象越界读其 props 指针 → GC churn 下解引用野指针段错误(gcstress2
    // 崩溃根因)。__json_date_iso 按对象头字节==TYPE_DATE 安全判别(真数/普通对象/数组
    // 放过、绝不误判也绝不越界),命中即转 ISO 串,彻底不碰 Date 块的对象读路径。
    let __di = undefined;
    if (typeof value === "number" || (value !== null && typeof value === "object")) {
        __di = __json_date_iso(value);
    }
    if (__di !== undefined) {
        value = __di; // Date → ISO 串(replacer 收到 ISO,与规范 toJSON→replacer 次序一致)
    } else if (value !== null && typeof value === "object" && typeof value.toJSON === "function") {
        value = value.toJSON(key);
    }
    if (__js_replacer !== null) {
        value = __js_replacer.call(holder, key, value);
    }
    return __jsonSer(value, indent, depth);
}

function __jsonArr(arr, indent, depth) {
    const n = arr.length;
    if (n === 0) return "[]";
    const newIndent = indent + __js_gap;
    if (__js_gap === "") {
        let out = "[";
        for (let i = 0; i < n; i++) {
            if (i > 0) out += ",";
            const e = __jsonPropV(arr, "" + i, arr[i], newIndent, depth + 1);
            out += (e === undefined) ? "null" : e;
        }
        return out + "]";
    }
    let out = "[\n";
    for (let i = 0; i < n; i++) {
        if (i > 0) out += ",\n";
        const e = __jsonPropV(arr, "" + i, arr[i], newIndent, depth + 1);
        out += newIndent + ((e === undefined) ? "null" : e);
    }
    return out + "\n" + indent + "]";
}

function __jsonObj(obj, indent, depth) {
    const newIndent = indent + __js_gap;
    const mk = []; // 保留输出的键
    const mv = []; // 对应序列化串
    if (__js_proplist !== null) {
        // 数组白名单:按白名单顺序,仅取对象自有键。
        for (let i = 0; i < __js_proplist.length; i++) {
            const k = __js_proplist[i];
            if (!__jsonHasKey(obj, k)) continue;
            const s = __jsonPropV(obj, k, obj[k], newIndent, depth + 1);
            if (s === undefined) continue;
            mk.push(k);
            mv.push(s);
        }
    } else {
        for (const k in obj) {
            const s = __jsonPropV(obj, k, obj[k], newIndent, depth + 1);
            if (s === undefined) continue; // undefined/函数/symbol 值属性跳过
            mk.push(k);
            mv.push(s);
        }
    }
    const n = mk.length;
    if (n === 0) return "{}";
    if (__js_gap === "") {
        let out = "{";
        for (let i = 0; i < n; i++) {
            if (i > 0) out += ",";
            out += __jsonQuote(mk[i]) + ":" + mv[i];
        }
        return out + "}";
    }
    let out = "{\n";
    for (let i = 0; i < n; i++) {
        if (i > 0) out += ",\n";
        out += newIndent + __jsonQuote(mk[i]) + ": " + mv[i];
    }
    return out + "\n" + indent + "}";
}

// space → 缩进单元串:数字钳 [0,10] 个空格;字符串取前 10 字符;其余 ""。
function __jsonGap(space) {
    const t = typeof space;
    if (t === "number") {
        if (space !== space) return ""; // NaN
        let n = space - (space % 1); // 向零取整(space>=0 即 floor)
        if (n < 1) return "";
        if (n > 10) n = 10;
        let g = "";
        for (let i = 0; i < n; i++) g += " ";
        return g;
    }
    if (t === "string") {
        if (space.length <= 10) return space;
        return space.slice(0, 10);
    }
    return "";
}

export function __JSON_stringify(v, replacer, space) {
    const savedRep = __js_replacer;
    const savedPl = __js_proplist;
    const savedGap = __js_gap;
    __js_replacer = null;
    __js_proplist = null;
    if (typeof replacer === "function") {
        __js_replacer = replacer;
    } else if (replacer instanceof Array) {
        // 键白名单:string/number 项收集去重(number 项 ToString);其余项忽略。
        const pl = [];
        for (let i = 0; i < replacer.length; i++) {
            const item = replacer[i];
            const it = typeof item;
            let key;
            if (it === "string") key = item;
            else if (it === "number") key = "" + item;
            else continue;
            let dup = false;
            for (let j = 0; j < pl.length; j++) {
                if (pl[j] === key) { dup = true; break; }
            }
            if (!dup) pl.push(key);
        }
        __js_proplist = pl;
    }
    __js_gap = __jsonGap(space);
    const holder = {};
    holder[""] = v;
    const result = __jsonPropV(holder, "", v, "", 0);
    __js_replacer = savedRep;
    __js_proplist = savedPl;
    __js_gap = savedGap;
    return result;
}

// ---------------- parse ----------------

function __jsonErr(msg) {
    throw new Error("JSON.parse: " + msg);
}

// 解析器状态经参数/返回值传递:parse 内函数返回 [value, nextPos] 需要多返回——
// 用模块级游标(单线程编译/运行模型,安全)。
let __jp_s = "";
let __jp_i = 0;

function __jpWs() {
    while (__jp_i < __jp_s.length) {
        const c = __jp_s.charCodeAt(__jp_i);
        if (c === 32 || c === 9 || c === 10 || c === 13) __jp_i = __jp_i + 1;
        else break;
    }
}

function __jpHexVal(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    __jsonErr("bad \\u escape");
}

function __jpString() {
    // 进入时 __jp_i 指向开引号
    __jp_i = __jp_i + 1;
    let out = "";
    while (true) {
        if (__jp_i >= __jp_s.length) __jsonErr("unterminated string");
        const c = __jp_s.charCodeAt(__jp_i);
        if (c === 34) { __jp_i = __jp_i + 1; return out; }
        if (c === 92) {
            __jp_i = __jp_i + 1;
            const e = __jp_s.charCodeAt(__jp_i);
            if (e === 34) out += '"';
            else if (e === 92) out += "\\";
            else if (e === 47) out += "/";
            else if (e === 110) out += "\n";
            else if (e === 116) out += "\t";
            else if (e === 114) out += "\r";
            else if (e === 98) out += "\b";
            else if (e === 102) out += "\f";
            else if (e === 117) {
                let code = 0;
                for (let k = 0; k < 4; k++) {
                    __jp_i = __jp_i + 1;
                    code = code * 16 + __jpHexVal(__jp_s.charCodeAt(__jp_i));
                }
                // fromCharCode 是字节级发射 → >127 手工 UTF-8(BMP;代理对未支持)
                if (code < 128) {
                    out += String.fromCharCode(code);
                } else if (code < 2048) {
                    const hi = (code - (code % 64)) / 64;
                    out += String.fromCharCode(192 + hi) + String.fromCharCode(128 + (code % 64));
                } else {
                    const lo = code % 64;
                    const mid = ((code - lo) / 64) % 64;
                    const hi = (code - lo - mid * 64) / 4096;
                    out += String.fromCharCode(224 + hi) + String.fromCharCode(128 + mid) + String.fromCharCode(128 + lo);
                }
            } else __jsonErr("bad escape");
            __jp_i = __jp_i + 1;
        } else {
            out += __jp_s.charAt(__jp_i);
            __jp_i = __jp_i + 1;
        }
    }
}

function __jpNumber() {
    let sign = 1;
    if (__jp_s.charCodeAt(__jp_i) === 45) { sign = -1; __jp_i = __jp_i + 1; }
    let intPart = 0;
    let sawDigit = false;
    while (__jp_i < __jp_s.length) {
        const c = __jp_s.charCodeAt(__jp_i);
        if (c >= 48 && c <= 57) { intPart = intPart * 10 + (c - 48); sawDigit = true; __jp_i = __jp_i + 1; }
        else break;
    }
    if (!sawDigit) __jsonErr("bad number");
    let value = intPart;
    if (__jp_i < __jp_s.length && __jp_s.charCodeAt(__jp_i) === 46) {
        __jp_i = __jp_i + 1;
        let frac = 0;
        let scale = 1;
        while (__jp_i < __jp_s.length) {
            const c = __jp_s.charCodeAt(__jp_i);
            if (c >= 48 && c <= 57) { frac = frac * 10 + (c - 48); scale = scale * 10; __jp_i = __jp_i + 1; }
            else break;
        }
        value = value + frac / scale;
    }
    if (__jp_i < __jp_s.length) {
        const c = __jp_s.charCodeAt(__jp_i);
        if (c === 101 || c === 69) { // e/E
            __jp_i = __jp_i + 1;
            let esign = 1;
            const c2 = __jp_s.charCodeAt(__jp_i);
            if (c2 === 43) __jp_i = __jp_i + 1;
            else if (c2 === 45) { esign = -1; __jp_i = __jp_i + 1; }
            let ex = 0;
            while (__jp_i < __jp_s.length) {
                const c3 = __jp_s.charCodeAt(__jp_i);
                if (c3 >= 48 && c3 <= 57) { ex = ex * 10 + (c3 - 48); __jp_i = __jp_i + 1; }
                else break;
            }
            let p = 1;
            for (let k = 0; k < ex; k++) p = p * 10;
            value = (esign > 0) ? value * p : value / p;
        }
    }
    return sign * value;
}

function __jpLit(word, val) {
    for (let k = 0; k < word.length; k++) {
        if (__jp_s.charCodeAt(__jp_i + k) !== word.charCodeAt(k)) __jsonErr("bad literal");
    }
    __jp_i = __jp_i + word.length;
    return val;
}

function __jpValue(depth) {
    if (depth > 200) __jsonErr("too deep");
    __jpWs();
    if (__jp_i >= __jp_s.length) __jsonErr("unexpected end");
    const c = __jp_s.charCodeAt(__jp_i);
    if (c === 34) return __jpString();
    if (c === 123) { // {
        __jp_i = __jp_i + 1;
        const obj = {};
        __jpWs();
        if (__jp_s.charCodeAt(__jp_i) === 125) { __jp_i = __jp_i + 1; return obj; }
        while (true) {
            __jpWs();
            if (__jp_s.charCodeAt(__jp_i) !== 34) __jsonErr("expected key");
            const k = __jpString();
            __jpWs();
            if (__jp_s.charCodeAt(__jp_i) !== 58) __jsonErr("expected :");
            __jp_i = __jp_i + 1;
            obj[k] = __jpValue(depth + 1);
            __jpWs();
            const d = __jp_s.charCodeAt(__jp_i);
            if (d === 44) { __jp_i = __jp_i + 1; continue; }
            if (d === 125) { __jp_i = __jp_i + 1; return obj; }
            __jsonErr("expected , or }");
        }
    }
    if (c === 91) { // [
        __jp_i = __jp_i + 1;
        const arr = [];
        __jpWs();
        if (__jp_s.charCodeAt(__jp_i) === 93) { __jp_i = __jp_i + 1; return arr; }
        while (true) {
            arr.push(__jpValue(depth + 1));
            __jpWs();
            const d = __jp_s.charCodeAt(__jp_i);
            if (d === 44) { __jp_i = __jp_i + 1; continue; }
            if (d === 93) { __jp_i = __jp_i + 1; return arr; }
            __jsonErr("expected , or ]");
        }
    }
    if (c === 116) return __jpLit("true", true);
    if (c === 102) return __jpLit("false", false);
    if (c === 110) return __jpLit("null", null);
    if (c === 45 || (c >= 48 && c <= 57)) return __jpNumber();
    __jsonErr("unexpected token");
}

// InternalizeJSONProperty:自底向上遍历,对每个 (holder,name,value) 调 reviver
// (this=holder)。子节点先于父节点处理;reviver 返回 undefined 的属性删除
// (数组元素置 undefined,与 node 的空洞在再序列化时同为 "null")。
// value 由调用方取好传入,原地改写容器。reviver 由用户提供 → typeof 守卫。
function __jpInternalize(holder, name, value, reviver) {
    if (value !== null && typeof value === "object") {
        if (value instanceof Array) {
            for (let i = 0; i < value.length; i++) {
                const nv = __jpInternalize(value, "" + i, value[i], reviver);
                value[i] = nv; // undefined 亦写回(空洞语义近似)
            }
        } else {
            // 先快照键,避免遍历中删除键破坏迭代。
            const keys = [];
            for (const k in value) keys.push(k);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                const nv = __jpInternalize(value, k, value[k], reviver);
                if (nv === undefined) delete value[k];
                else value[k] = nv;
            }
        }
    }
    return reviver.call(holder, name, value);
}

export function __JSON_parse(text, reviver) {
    __jp_s = "" + text;
    __jp_i = 0;
    const v = __jpValue(0);
    __jpWs();
    if (__jp_i < __jp_s.length) __jsonErr("trailing garbage");
    if (typeof reviver === "function") {
        const root = {};
        root[""] = v;
        return __jpInternalize(root, "", v, reviver);
    }
    return v;
}
