// asm.js Runtime - Node.js querystring (basic subset)

// 百分号解码:%XX -> 字符,'+' -> 空格。字节模型下按 charCode 处理。
function _hexVal(c) {
    const cc = c.charCodeAt(0);
    if (cc >= 48 && cc <= 57) return cc - 48;        // 0-9
    if (cc >= 65 && cc <= 70) return cc - 55;        // A-F
    if (cc >= 97 && cc <= 102) return cc - 87;       // a-f
    return -1;
}
// 百分号解码;plusToSpace 时把 '+' 视作空格。node 的公开 unescape 不转 '+'(等价
// decodeURIComponent),只有 parse 在解码值/键时把 '+' 当空格。
function _decode(str, plusToSpace) {
    let out = "";
    for (let i = 0; i < str.length; i++) {
        const c = str.charAt(i);
        if (plusToSpace && c === "+") { out += " "; continue; }
        if (c === "%" && i + 2 < str.length + 1) {
            const h = _hexVal(str.charAt(i + 1));
            const l = _hexVal(str.charAt(i + 2));
            if (h >= 0 && l >= 0) { out += String.fromCharCode(h * 16 + l); i += 2; continue; }
        }
        out += c;
    }
    return out;
}
export function unescape(str) { return _decode(str, false); }

const _noEscape = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
export function escape(str) {
    const s = String(str);
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (_noEscape.indexOf(c) !== -1) { out += c; continue; }
        const cc = c.charCodeAt(0);
        const hex = cc.toString(16).toUpperCase();
        out += "%" + (hex.length === 1 ? "0" + hex : hex);
    }
    return out;
}

// parse("a=1&b=2") -> { a: "1", b: "2" }。重复键聚合为数组。
export function parse(str, sep, eq) {
    const result = {};
    if (!str || typeof str !== "string") return result;
    const pairSep = sep || "&";
    const kvSep = eq || "=";
    const pairs = str.split(pairSep);
    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        if (pair === "") continue;
        const idx = pair.indexOf(kvSep);
        let key, val;
        if (idx === -1) { key = _decode(pair, true); val = ""; }
        else { key = _decode(pair.slice(0, idx), true); val = _decode(pair.slice(idx + kvSep.length), true); }
        if (result[key] === undefined) {
            result[key] = val;
        } else if (Array.isArray(result[key])) {
            result[key].push(val);
        } else {
            result[key] = [result[key], val];
        }
    }
    return result;
}

// stringify({a:1,b:2}) -> "a=1&b=2"。数组值展开为重复键。
export function stringify(obj, sep, eq) {
    if (!obj || typeof obj !== "object") return "";
    const pairSep = sep || "&";
    const kvSep = eq || "=";
    const keys = Object.keys(obj);
    const parts = [];
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const val = obj[key];
        const ek = escape(key);
        if (Array.isArray(val)) {
            for (let j = 0; j < val.length; j++) parts.push(ek + kvSep + escape(String(val[j])));
        } else {
            parts.push(ek + kvSep + escape(val === undefined || val === null ? "" : String(val)));
        }
    }
    return parts.join(pairSep);
}

// Node 别名
export const decode = parse;
export const encode = stringify;

const querystring = { parse, stringify, escape, unescape, decode, encode };
export { querystring };
export default querystring;
