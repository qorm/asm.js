// asm.js Runtime - Node.js url

export function fileURLToPath(url) {
    if (url && typeof url === "object" && typeof url.href === "string") url = url.href;
    if (typeof url !== "string") return url;
    if (url.length > 7 && url.substring(0, 7) === "file://") {
        let p = url.substring(7);
        // 去掉可能的空 host 前的多余部分:file://host/path → /path(仅取路径段)
        return p;
    }
    return url;
}

// 移除 RFC 3986 点段(./ 与 ../),用于相对 URL 解析
function _removeDotSegments(path) {
    const parts = path.split("/");
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        if (seg === ".") {
            // 丢弃;若是末段需保留尾斜杠
            if (i === parts.length - 1) out.push("");
        } else if (seg === "..") {
            if (out.length > 1) out.pop();
            if (i === parts.length - 1) out.push("");
        } else {
            out.push(seg);
        }
    }
    return out.join("/");
}

// 把相对引用 ref 相对 base(绝对 URL 字符串)解析成绝对 URL 字符串
function _resolveURL(ref, base) {
    if (ref.indexOf("://") > 0) return ref; // ref 本身即绝对
    const b = new URL(base);
    const originPart = b.protocol + "//" + b.host;
    if (ref.length === 0) return base;
    const c0 = ref.charAt(0);
    if (ref.length > 1 && ref.charAt(0) === "/" && ref.charAt(1) === "/") {
        return b.protocol + ref; // 协议相对 //host/path
    }
    if (c0 === "/") return originPart + _removeDotSegments(ref);
    if (c0 === "?") return originPart + b.pathname + ref;
    if (c0 === "#") return originPart + b.pathname + b.search + ref;
    // 相对路径:并入 base 路径目录
    let baseDir = b.pathname;
    const lastSlash = baseDir.lastIndexOf("/");
    baseDir = lastSlash >= 0 ? baseDir.substring(0, lastSlash + 1) : "/";
    let merged = baseDir + ref;
    // 拆出 ref 自带的 search/hash
    return originPart + _removeDotSegments(merged);
}

// pathToFileURL(path): 返回 file: 协议的 URL 实例
export function pathToFileURL(path) {
    let p = String(path);
    if (p.charAt(0) !== "/") p = "/" + p; // 相对路径也给个前导斜杠(近似)
    return new URL("file://" + p);
}

export class URLSearchParams {
    constructor(init) {
        // 内部键值对列表(保序,支持重复键)。init 支持查询串("a=1&b=2",可含前导 "?")
        this._list = [];
        if (typeof init === "string" && init.length > 0) {
            let s = init;
            if (s.charAt(0) === "?") s = s.substring(1);
            if (s.length > 0) {
                const pairs = s.split("&");
                for (let i = 0; i < pairs.length; i++) {
                    const pair = pairs[i];
                    if (pair === "") continue;
                    const idx = pair.indexOf("=");
                    if (idx === -1) this._list.push([_qsDecode(pair), ""]);
                    else this._list.push([_qsDecode(pair.substring(0, idx)), _qsDecode(pair.substring(idx + 1))]);
                }
            }
        } else if (init && typeof init === "object") {
            // init 为键值对数组 [[k,v],...] 或普通对象 {k:v}。用 Array.isArray 判别
            // (asm.js 里普通对象的 .length 返 0,不能用 length 判数组)。
            if (Array.isArray(init)) {
                for (let i = 0; i < init.length; i++) {
                    const p = init[i];
                    if (p) this._list.push([String(p[0]), String(p[1])]);
                }
            } else {
                const ks = Object.keys(init);
                for (let i = 0; i < ks.length; i++) this._list.push([ks[i], String(init[ks[i]])]);
            }
        }
    }
    get size() { return this._list.length; }
    sort() {
        // 按键稳定排序(插入排序,避免依赖 Array.sort 的比较器行为)
        const n = this._list.length;
        for (let i = 1; i < n; i++) {
            const cur = this._list[i];
            let j = i - 1;
            while (j >= 0 && this._list[j][0] > cur[0]) { this._list[j + 1] = this._list[j]; j--; }
            this._list[j + 1] = cur;
        }
    }
    entries() {
        const out = [];
        for (let i = 0; i < this._list.length; i++) out.push([this._list[i][0], this._list[i][1]]);
        return out;
    }
    append(name, value) { this._list.push([String(name), String(value)]); }
    set(name, value) {
        let done = false;
        const out = [];
        for (let i = 0; i < this._list.length; i++) {
            if (this._list[i][0] === name) {
                if (!done) { out.push([String(name), String(value)]); done = true; }
            } else out.push(this._list[i]);
        }
        if (!done) out.push([String(name), String(value)]);
        this._list = out;
    }
    get(name) {
        for (let i = 0; i < this._list.length; i++) if (this._list[i][0] === name) return this._list[i][1];
        return null;
    }
    getAll(name) {
        const out = [];
        for (let i = 0; i < this._list.length; i++) if (this._list[i][0] === name) out.push(this._list[i][1]);
        return out;
    }
    has(name) {
        for (let i = 0; i < this._list.length; i++) if (this._list[i][0] === name) return true;
        return false;
    }
    delete(name) {
        const out = [];
        for (let i = 0; i < this._list.length; i++) if (this._list[i][0] !== name) out.push(this._list[i]);
        this._list = out;
    }
    keys() { const out = []; for (let i = 0; i < this._list.length; i++) out.push(this._list[i][0]); return out; }
    values() { const out = []; for (let i = 0; i < this._list.length; i++) out.push(this._list[i][1]); return out; }
    forEach(cb) { for (let i = 0; i < this._list.length; i++) cb(this._list[i][1], this._list[i][0], this); }
    toString() {
        const parts = [];
        for (let i = 0; i < this._list.length; i++) {
            parts.push(_qsEncode(this._list[i][0]) + "=" + _qsEncode(this._list[i][1]));
        }
        return parts.join("&");
    }
}

function _hexVal(c) {
    const cc = c.charCodeAt(0);
    if (cc >= 48 && cc <= 57) return cc - 48;
    if (cc >= 65 && cc <= 70) return cc - 55;
    if (cc >= 97 && cc <= 102) return cc - 87;
    return -1;
}
function _qsDecode(str) {
    let out = "";
    for (let i = 0; i < str.length; i++) {
        const c = str.charAt(i);
        if (c === "+") { out += " "; continue; }
        if (c === "%" && i + 2 < str.length) {
            const h = _hexVal(str.charAt(i + 1)), l = _hexVal(str.charAt(i + 2));
            if (h >= 0 && l >= 0) { out += String.fromCharCode(h * 16 + l); i += 2; continue; }
        }
        out += c;
    }
    return out;
}
const _qsNoEscape = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
function _qsEncode(str) {
    const s = String(str);
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (_qsNoEscape.indexOf(c) !== -1) { out += c; continue; }
        if (c === " ") { out += "+"; continue; }
        const hex = c.charCodeAt(0).toString(16).toUpperCase();
        out += "%" + (hex.length === 1 ? "0" + hex : hex);
    }
    return out;
}

export class URL {
    constructor(url, base) {
        // base 存在且 url 为相对引用时,先解析成绝对 URL
        if (base !== undefined && base !== null && url.indexOf("://") <= 0) {
            const baseStr = (typeof base === "object" && base.href) ? base.href : String(base);
            url = _resolveURL(url, baseStr);
        }
        this.href = url;
        this.protocol = "";
        this.username = "";
        this.password = "";
        this.hostname = "";
        this.port = "";
        this.host = "";
        this.pathname = "";
        this.search = "";
        this.hash = "";

        const protoIdx = url.indexOf("://");
        if (protoIdx > 0) {
            this.protocol = url.substring(0, protoIdx) + ":";
            let rest = url.substring(protoIdx + 3);
            const hashIdx = rest.indexOf("#");
            if (hashIdx >= 0) { this.hash = rest.substring(hashIdx); rest = rest.substring(0, hashIdx); }
            const searchIdx = rest.indexOf("?");
            if (searchIdx >= 0) { this.search = rest.substring(searchIdx); rest = rest.substring(0, searchIdx); }
            let authority;
            const slashIdx = rest.indexOf("/");
            // 无路径段时 node 默认 pathname "/"(特殊 scheme:http/https/ws/ftp/file)
            if (slashIdx >= 0) { authority = rest.substring(0, slashIdx); this.pathname = rest.substring(slashIdx); }
            else { authority = rest; this.pathname = "/"; }
            // userinfo@host
            const atIdx = authority.indexOf("@");
            if (atIdx >= 0) {
                const userinfo = authority.substring(0, atIdx);
                authority = authority.substring(atIdx + 1);
                const colon = userinfo.indexOf(":");
                if (colon >= 0) { this.username = userinfo.substring(0, colon); this.password = userinfo.substring(colon + 1); }
                else this.username = userinfo;
            }
            this.host = authority;
            const portColon = authority.indexOf(":");
            if (portColon >= 0) { this.hostname = authority.substring(0, portColon); this.port = authority.substring(portColon + 1); }
            else { this.hostname = authority; this.port = ""; }
            // RFC 3986 归一:绝对 URL 路径里的 ./ 与 ../ 点段也要消解
            if (this.pathname.indexOf("/.") !== -1) {
                this.pathname = _removeDotSegments(this.pathname);
                this.href = this.protocol + "//" + this.host + this.pathname + this.search + this.hash;
            }
        }
        this.searchParams = new URLSearchParams(this.search);
    }
    get origin() {
        if (!this.protocol) return "null";
        return this.protocol + "//" + this.host;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
}

export { fileURLToPath as _fileURLToPath };
const url = { URL, URLSearchParams, fileURLToPath, pathToFileURL };
export { url };
export default url;
