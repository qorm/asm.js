// asm.js Runtime - Node.js Buffer
// Provides Buffer class for asm.js compiled binaries

// 十六进制字符 → 值(0-15),非法返 -1
function _hexVal(cc) {
    if (cc >= 48 && cc <= 57) return cc - 48;       // 0-9
    if (cc >= 65 && cc <= 70) return cc - 55;       // A-F
    if (cc >= 97 && cc <= 102) return cc - 87;      // a-f
    return -1;
}

export class Buffer {
    constructor(data, encoding, offset, length) {
        // 全用显式循环：避开 new Array(runtimeN)（运行时 N 会变 1 元素）、
        // .fill、扩展运算符（SpreadElement 未实现）、箭头 map。
        this.data = [];
        if (typeof data === "number") {
            for (let i = 0; i < data; i++) this.data.push(0);
        } else if (typeof data === "string") {
            if (encoding === "hex") {
                for (let i = 0; i + 1 < data.length; i += 2) {
                    const hi = _hexVal(data.charCodeAt(i)), lo = _hexVal(data.charCodeAt(i + 1));
                    if (hi < 0 || lo < 0) break;
                    this.data.push(hi * 16 + lo);
                }
            } else if (encoding === "base64" || encoding === "base64url") {
                const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                let acc = 0, bits = 0;
                for (let i = 0; i < data.length; i++) {
                    let c = data.charAt(i);
                    if (c === "=") break;
                    // base64url:'-'→'+'、'_'→'/'
                    if (c === "-") c = "+";
                    else if (c === "_") c = "/";
                    const v = B64.indexOf(c);
                    if (v < 0) continue;
                    acc = (acc << 6) | v; bits += 6;
                    if (bits >= 8) { bits -= 8; this.data.push((acc >> bits) & 0xff); }
                }
            } else {
                for (let i = 0; i < data.length; i++) this.data.push(data.charCodeAt(i));
            }
        } else if (data instanceof Buffer) {
            // 另一个 Buffer：字节在 .data
            for (let i = 0; i < data.data.length; i++) this.data.push(data.data[i]);
        } else if (data && typeof data.length === "number") {
            // 数组/类数组：直接按下标读（不要访问数组的任意属性，会崩）
            for (let i = 0; i < data.length; i++) this.data.push(data[i]);
        }
        this.length = this.data.length;
    }

    static from(data, encoding, offset, length) {
        return new Buffer(data, encoding, offset, length);
    }

    static alloc(size, fill, encoding) {
        const b = new Buffer(size);
        // fill:数字按字节填;字符串按其 charCode 循环填(node 语义)
        if (fill !== undefined && fill !== null && fill !== 0) {
            if (typeof fill === "number") {
                for (let i = 0; i < size; i++) b.data[i] = fill & 0xff;
            } else if (typeof fill === "string" && fill.length > 0) {
                for (let i = 0; i < size; i++) b.data[i] = fill.charCodeAt(i % fill.length);
            }
        }
        return b;
    }

    static isBuffer(obj) {
        return obj instanceof Buffer;
    }

    static isEncoding(encoding) {
        return ["utf8", "ascii", "latin1", "base64", "hex", "ucs2", "utf16le"].includes(encoding);
    }

    // Buffer.compare(a, b):字典序比较,返回 -1/0/1
    static compare(a, b) {
        const la = a.length, lb = b.length;
        const n = la < lb ? la : lb;
        for (let i = 0; i < n; i++) {
            if (a.data[i] < b.data[i]) return -1;
            if (a.data[i] > b.data[i]) return 1;
        }
        if (la < lb) return -1;
        if (la > lb) return 1;
        return 0;
    }

    // Buffer.byteLength(value, encoding): 字节长度。asm.js 字节模型下字符串按
    // charCode 逐字节(ASCII 与 Node utf8 一致;非 ASCII 记偏差);Buffer/类数组取 length。
    static byteLength(value, encoding) {
        if (typeof value === "string") return value.length;
        if (value instanceof Buffer) return value.length;
        if (value && typeof value.length === "number") return value.length;
        return 0;
    }

    static concat(buffers, totalLength) {
        // 索引循环(勿 for-of:运行时可迭代协议对 Buffer 数组不稳,曾致 concat 返空)
        let len = 0;
        for (let k = 0; k < buffers.length; k++) len += buffers[k].length;
        const result = new Buffer(len);
        let pos = 0;
        for (let k = 0; k < buffers.length; k++) {
            const b = buffers[k];
            for (let i = 0; i < b.length; i++) { result.data[pos] = b.data[i]; pos++; }
        }
        result.length = result.data.length;
        return result;
    }

    write(string, offset, length, encoding) {
        for (let i = 0; i < string.length && i < length; i++) {
            this.data[offset + i] = string.charCodeAt(i);
        }
        return string.length;
    }

    toString(encoding, start, end) {
        if (encoding === "hex") {
            let s = "";
            for (let i = (start || 0); i < (end || this.length); i++) {
                const hex = this.data[i].toString(16);
                s += hex.length === 1 ? "0" + hex : hex;
            }
            return s;
        }
        if (encoding === "base64" || encoding === "base64url") {
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let s = "";
            const en = (end === undefined || end === null) ? this.length : end;
            for (let i = (start || 0); i < en; i += 3) {
                const rem = en - i;
                const b1 = this.data[i];
                const b2 = rem > 1 ? this.data[i + 1] : 0;
                const b3 = rem > 2 ? this.data[i + 2] : 0;
                s += chars[b1 >> 2] + chars[((b1 & 3) << 4) | (b2 >> 4)];
                s += rem > 1 ? chars[((b2 & 15) << 2) | (b3 >> 6)] : "=";
                s += rem > 2 ? chars[b3 & 63] : "=";
            }
            if (encoding === "base64url") {
                // base64url:'+'→'-'、'/'→'_'、去填充 '='
                let out = "";
                for (let i = 0; i < s.length; i++) {
                    const c = s.charAt(i);
                    if (c === "=") continue;
                    if (c === "+") out += "-";
                    else if (c === "/") out += "_";
                    else out += c;
                }
                return out;
            }
            return s;
        }
        return this.data.slice(start || 0, end || this.length).map(b => String.fromCharCode(b)).join("");
    }

    equals(other) {
        if (this.length !== other.length) return false;
        for (let i = 0; i < this.length; i++) {
            if (this.data[i] !== other.data[i]) return false;
        }
        return true;
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
        let ts = targetStart || 0; // 勿直接 targetStart++:undefined++ → NaN，拷贝全丢
        const ss = sourceStart || 0;
        const se = sourceEnd === undefined || sourceEnd === null ? this.length : sourceEnd;
        let n = 0;
        for (let i = ss; i < se; i++) { target.data[ts] = this.data[i]; ts++; n++; }
        if (target.length !== undefined && ts > target.data.length) target.length = target.data.length;
        return n;
    }

    fill(value, offset, end, encoding) {
        for (let i = offset || 0; i < (end || this.length); i++) {
            this.data[i] = typeof value === "number" ? value : value.charCodeAt(0);
        }
        return this;
    }

    toJSON() {
        const arr = [];
        for (let i = 0; i < this.length; i++) arr.push(this.data[i]);
        return { type: "Buffer", data: arr };
    }

    values() {
        const self = this;
        let i = 0;
        return {
            next() {
                if (i >= self.length) return { done: true, value: undefined };
                return { done: false, value: self.data[i++] };
            },
            [Symbol.iterator]() { return this; }
        };
    }
    keys() {
        const self = this;
        let i = 0;
        return {
            next() {
                if (i >= self.length) return { done: true, value: undefined };
                return { done: false, value: i++ };
            },
            [Symbol.iterator]() { return this; }
        };
    }
    entries() {
        const self = this;
        let i = 0;
        return {
            next() {
                if (i >= self.length) return { done: true, value: undefined };
                const idx = i++;
                return { done: false, value: [idx, self.data[idx]] };
            },
            [Symbol.iterator]() { return this; }
        };
    }

    // 变长无符号/有符号整数读写(byteLength 1..6);用算术避免 32 位溢出
    writeUIntLE(value, offset, byteLength) {
        let v = value;
        for (let i = 0; i < byteLength; i++) { this.data[offset + i] = v % 256; v = Math.floor(v / 256); }
        return offset + byteLength;
    }
    writeUIntBE(value, offset, byteLength) {
        let v = value;
        for (let i = byteLength - 1; i >= 0; i--) { this.data[offset + i] = v % 256; v = Math.floor(v / 256); }
        return offset + byteLength;
    }
    writeIntLE(value, offset, byteLength) {
        let v = value < 0 ? value + Math.pow(2, 8 * byteLength) : value;
        return this.writeUIntLE(v, offset, byteLength);
    }
    writeIntBE(value, offset, byteLength) {
        let v = value < 0 ? value + Math.pow(2, 8 * byteLength) : value;
        return this.writeUIntBE(v, offset, byteLength);
    }
    readUIntLE(offset, byteLength) {
        let val = 0, mul = 1;
        for (let i = 0; i < byteLength; i++) { val += this.data[offset + i] * mul; mul *= 256; }
        return val;
    }
    readUIntBE(offset, byteLength) {
        let val = 0;
        for (let i = 0; i < byteLength; i++) { val = val * 256 + this.data[offset + i]; }
        return val;
    }
    readIntLE(offset, byteLength) {
        let val = this.readUIntLE(offset, byteLength);
        const max = Math.pow(2, 8 * byteLength);
        if (val >= max / 2) val -= max;
        return val;
    }
    readIntBE(offset, byteLength) {
        let val = this.readUIntBE(offset, byteLength);
        const max = Math.pow(2, 8 * byteLength);
        if (val >= max / 2) val -= max;
        return val;
    }

    slice(start, end) {
        const st = start || 0;
        const en = (end === undefined || end === null) ? this.length : end;
        return new Buffer(this.data.slice(st, en));
    }

    subarray(start, end) {
        return this.slice(start, end);
    }

    compare(other) {
        for (let i = 0; i < Math.min(this.length, other.length); i++) {
            if (this.data[i] < other.data[i]) return -1;
            if (this.data[i] > other.data[i]) return 1;
        }
        return this.length - other.length;
    }

    swap16() {
        for (let i = 0; i < this.length; i += 2) {
            const tmp = this.data[i];
            this.data[i] = this.data[i + 1];
            this.data[i + 1] = tmp;
        }
        return this;
    }

    swap32() {
        for (let i = 0; i < this.length; i += 4) {
            const tmp = this.data[i];
            this.data[i] = this.data[i + 3];
            this.data[i + 3] = tmp;
            const tmp2 = this.data[i + 1];
            this.data[i + 1] = this.data[i + 2];
            this.data[i + 2] = tmp2;
        }
        return this;
    }

    swap64() { return this.swap32(); }

    writeUInt8(value, offset) { this.data[offset] = value & 0xff; }
    writeUInt16LE(value, offset) { this.data[offset] = value & 0xff; this.data[offset + 1] = (value >> 8) & 0xff; }
    writeUInt16BE(value, offset) { this.data[offset] = (value >> 8) & 0xff; this.data[offset + 1] = value & 0xff; }
    writeUInt32LE(value, offset) { for (let i = 0; i < 4; i++) this.data[offset + i] = (value >> (i * 8)) & 0xff; }
    writeUInt32BE(value, offset) { for (let i = 0; i < 4; i++) this.data[offset + 3 - i] = (value >> (i * 8)) & 0xff; }
    writeInt8(value, offset) { this.writeUInt8(value, offset); }
    writeInt16LE(value, offset) { this.writeUInt16LE(value, offset); }
    writeInt16BE(value, offset) { this.writeUInt16BE(value, offset); }
    writeInt32LE(value, offset) { this.writeUInt32LE(value, offset); }
    writeInt32BE(value, offset) { this.writeUInt32BE(value, offset); }

    readUInt8(offset) { return this.data[offset]; }
    readUInt16LE(offset) { return this.data[offset] | (this.data[offset + 1] << 8); }
    readUInt16BE(offset) { return (this.data[offset] << 8) | this.data[offset + 1]; }
    readUInt32LE(offset) { return this.data[offset] | (this.data[offset + 1] << 8) | (this.data[offset + 2] << 16) | (this.data[offset + 3] << 24); }
    readUInt32BE(offset) { return (this.data[offset] << 24) | (this.data[offset + 1] << 16) | (this.data[offset + 2] << 8) | this.data[offset + 3]; }
    readInt8(offset) { const v = this.data[offset]; return v < 128 ? v : v - 256; }
    readInt16LE(offset) { const v = this.readUInt16LE(offset); return v < 32768 ? v : v - 65536; }
    readInt16BE(offset) { const v = this.readUInt16BE(offset); return v < 32768 ? v : v - 65536; }
    readInt32LE(offset) { const v = this.readUInt32LE(offset); return v < 2147483648 ? v : v - 4294967296; }
    readInt32BE(offset) { const v = this.readUInt32BE(offset); return v < 2147483648 ? v : v - 4294967296; }

    [Symbol.iterator]() {
        let i = 0;
        return {
            next: () => {
                if (i >= this.length) return { done: true };
                return { done: false, value: this.data[i++] };
            }
        };
    }
}

export default Buffer;
