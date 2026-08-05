// asm.js Runtime - Node.js zlib
// Real DEFLATE/INFLATE (RFC 1951), zlib wrapper (RFC 1950), gzip (RFC 1952).
// Pure 32-bit integer computation (no syscalls) — compiles/runs under asm.js.
//
// Implemented sync APIs with genuine (de)compression + Node interop:
//   inflateSync / inflateRawSync / gunzipSync   (decoder: stored + fixed + dynamic Huffman)
//   deflateSync / deflateRawSync / gzipSync     (encoder: LZ77 + fixed Huffman)
//   crc32 / adler32 checksums
// A asmjs-produced gzip/zlib/raw buffer decompresses in Node and vice-versa.

// NOTE: import Buffer under an alias. Bare `new Buffer(...)` is intercepted by a
// compiler builtin that returns an object without the `.data` byte array, so we
// must reference the real class through the aliased binding `_Buf`.
import { Buffer as _Buf } from "./buffer.js";
import { EventEmitter } from "./events.js";

// ---------------------------------------------------------------------------
// byte normalization
// ---------------------------------------------------------------------------
function _toBytes(input) {
    const b = [];
    if (typeof input === "string") {
        for (let i = 0; i < input.length; i++) b.push(input.charCodeAt(i) & 0xff);
        return b;
    }
    if (input instanceof _Buf) {
        for (let i = 0; i < input.length; i++) b.push(input.data[i] & 0xff);
        return b;
    }
    if (input && input.data && typeof input.length === "number") {
        // Buffer-shaped object whose class identity differs (global Buffer alias).
        for (let i = 0; i < input.length; i++) b.push(input.data[i] & 0xff);
        return b;
    }
    if (input && typeof input.length === "number") {
        for (let i = 0; i < input.length; i++) b.push(input[i] & 0xff);
        return b;
    }
    return b;
}

function _bytesToBuffer(bytes) {
    // Build a Buffer directly from the byte array (avoids re-encoding).
    const buf = new _Buf(0);
    for (let i = 0; i < bytes.length; i++) buf.data.push(bytes[i] & 0xff);
    buf.length = buf.data.length;
    return buf;
}

// ---------------------------------------------------------------------------
// checksums
// ---------------------------------------------------------------------------
let _crcTable = null;
function _crcTableGet() {
    if (_crcTable) return _crcTable;
    const t = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t.push(c >>> 0);
    }
    _crcTable = t;
    return t;
}
function _crc32(bytes) {
    const t = _crcTableGet();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}
function _adler32(bytes) {
    let a = 1, b = 0;
    const MOD = 65521;
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) % MOD;
        b = (b + a) % MOD;
    }
    return (((b << 16) | a) >>> 0);
}

// ---------------------------------------------------------------------------
// bit reader (LSB-first within each byte)
// ---------------------------------------------------------------------------
function _makeReader(bytes) { return { bytes: bytes, pos: 0, bit: 0 }; }
function _readBit(r) {
    const byte = r.pos < r.bytes.length ? r.bytes[r.pos] : 0;
    const v = (byte >> r.bit) & 1;
    r.bit++;
    if (r.bit === 8) { r.bit = 0; r.pos++; }
    return v;
}
function _readBits(r, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= _readBit(r) << i;
    return v;
}

// ---------------------------------------------------------------------------
// canonical Huffman decode tables (puff.c style: counts[] + symbols[])
// ---------------------------------------------------------------------------
const _MAXBITS = 15;
function _buildTree(lengths, n) {
    const counts = [];
    for (let i = 0; i <= _MAXBITS; i++) counts.push(0);
    for (let i = 0; i < n; i++) counts[lengths[i]]++;
    // offsets of first symbol for each length
    const offsets = [];
    for (let i = 0; i <= _MAXBITS + 1; i++) offsets.push(0);
    for (let len = 1; len <= _MAXBITS; len++) offsets[len + 1] = offsets[len] + counts[len];
    const symbols = [];
    for (let i = 0; i < n; i++) symbols.push(0);
    for (let sym = 0; sym < n; sym++) {
        if (lengths[sym] !== 0) { symbols[offsets[lengths[sym]]] = sym; offsets[lengths[sym]]++; }
    }
    return { counts: counts, symbols: symbols };
}
function _decodeSym(r, tree) {
    const counts = tree.counts, symbols = tree.symbols;
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= _MAXBITS; len++) {
        code |= _readBit(r);
        const count = counts[len];
        if (code - first < count) return symbols[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// length/distance base + extra-bit tables (RFC 1951 §3.2.5)
// ---------------------------------------------------------------------------
const _lenBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const _lenExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const _distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const _distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// fixed Huffman literal/length code lengths
function _fixedLitTree() {
    const lengths = [];
    for (let i = 0; i < 288; i++) {
        if (i <= 143) lengths.push(8);
        else if (i <= 255) lengths.push(9);
        else if (i <= 279) lengths.push(7);
        else lengths.push(8);
    }
    return _buildTree(lengths, 288);
}
function _fixedDistTree() {
    const lengths = [];
    for (let i = 0; i < 30; i++) lengths.push(5);
    return _buildTree(lengths, 30);
}

function _inflateBlock(r, out, litTree, distTree) {
    while (true) {
        const sym = _decodeSym(r, litTree);
        if (sym === 256) break;
        if (sym < 0) break;
        if (sym < 256) { out.push(sym); continue; }
        const s = sym - 257;
        const len = _lenBase[s] + _readBits(r, _lenExtra[s]);
        const dsym = _decodeSym(r, distTree);
        const dist = _distBase[dsym] + _readBits(r, _distExtra[dsym]);
        let start = out.length - dist;
        for (let i = 0; i < len; i++) out.push(out[start + i]);
    }
}

const _clOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function _readDynamic(r) {
    const hlit = _readBits(r, 5) + 257;
    const hdist = _readBits(r, 5) + 1;
    const hclen = _readBits(r, 4) + 4;
    const clLengths = [];
    for (let i = 0; i < 19; i++) clLengths.push(0);
    for (let i = 0; i < hclen; i++) clLengths[_clOrder[i]] = _readBits(r, 3);
    const clTree = _buildTree(clLengths, 19);
    const lengths = [];
    const total = hlit + hdist;
    let n = 0;
    while (n < total) {
        const sym = _decodeSym(r, clTree);
        if (sym < 16) { lengths.push(sym); n++; }
        else if (sym === 16) {
            const rep = _readBits(r, 2) + 3;
            const prev = lengths[n - 1];
            for (let i = 0; i < rep; i++) { lengths.push(prev); n++; }
        } else if (sym === 17) {
            const rep = _readBits(r, 3) + 3;
            for (let i = 0; i < rep; i++) { lengths.push(0); n++; }
        } else {
            const rep = _readBits(r, 7) + 11;
            for (let i = 0; i < rep; i++) { lengths.push(0); n++; }
        }
    }
    const litLengths = lengths.slice(0, hlit);
    const distLengths = lengths.slice(hlit, hlit + hdist);
    return { litTree: _buildTree(litLengths, hlit), distTree: _buildTree(distLengths, hdist) };
}

// raw DEFLATE decode -> byte array
function _inflateRaw(bytes) {
    const r = _makeReader(bytes);
    const out = [];
    let last = 0;
    while (!last) {
        last = _readBit(r);
        const type = _readBits(r, 2);
        if (type === 0) {
            // stored: align to byte boundary
            if (r.bit !== 0) { r.bit = 0; r.pos++; }
            const len = r.bytes[r.pos] | (r.bytes[r.pos + 1] << 8);
            r.pos += 4; // skip LEN(2) + NLEN(2)
            for (let i = 0; i < len; i++) { out.push(r.bytes[r.pos]); r.pos++; }
        } else if (type === 1) {
            _inflateBlock(r, out, _fixedLitTree(), _fixedDistTree());
        } else if (type === 2) {
            const tbl = _readDynamic(r);
            _inflateBlock(r, out, tbl.litTree, tbl.distTree);
        } else {
            break;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// bit writer (LSB-first)
// ---------------------------------------------------------------------------
function _makeWriter() { return { bytes: [], cur: 0, nbits: 0 }; }
function _writeBits(w, value, n) {
    for (let i = 0; i < n; i++) {
        w.cur |= ((value >> i) & 1) << w.nbits;
        w.nbits++;
        if (w.nbits === 8) { w.bytes.push(w.cur); w.cur = 0; w.nbits = 0; }
    }
}
function _writeHuff(w, code, len) {
    // Huffman codes are emitted MSB-first.
    for (let i = len - 1; i >= 0; i--) {
        w.cur |= ((code >> i) & 1) << w.nbits;
        w.nbits++;
        if (w.nbits === 8) { w.bytes.push(w.cur); w.cur = 0; w.nbits = 0; }
    }
}
function _flushWriter(w) {
    if (w.nbits > 0) { w.bytes.push(w.cur); w.cur = 0; w.nbits = 0; }
}

// fixed Huffman encode helpers (canonical code values)
function _fixedLitLen(sym) {
    if (sym <= 143) return 8;
    if (sym <= 255) return 9;
    if (sym <= 279) return 7;
    return 8;
}
function _fixedLitCode(sym) {
    if (sym <= 143) return 0x30 + sym;
    if (sym <= 255) return 0x190 + (sym - 144);
    if (sym <= 279) return sym - 256;
    return 0xc0 + (sym - 280);
}
function _lengthCode(len) {
    for (let i = 28; i >= 0; i--) {
        if (len >= _lenBase[i]) return { sym: 257 + i, extra: _lenExtra[i], val: len - _lenBase[i] };
    }
    return { sym: 257, extra: 0, val: 0 };
}
function _distCodeOf(dist) {
    for (let i = 29; i >= 0; i--) {
        if (dist >= _distBase[i]) return { sym: i, extra: _distExtra[i], val: dist - _distBase[i] };
    }
    return { sym: 0, extra: 0, val: 0 };
}

// raw DEFLATE encode (single fixed-Huffman final block, greedy LZ77) -> byte array
function _deflateRaw(data) {
    const n = data.length;
    const w = _makeWriter();
    _writeBits(w, 1, 1); // BFINAL = 1
    _writeBits(w, 1, 2); // BTYPE = 01 (fixed Huffman)

    const WSIZE = 32768;
    const HASHSIZE = 32768;
    const head = [];
    for (let i = 0; i < HASHSIZE; i++) head.push(-1);
    const prev = [];
    for (let i = 0; i < n; i++) prev.push(-1);

    let i = 0;
    while (i < n) {
        let bestLen = 0, bestDist = 0;
        if (i + 3 <= n) {
            const h = ((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) & 0x7fff;
            let j = head[h];
            let chain = 128;
            const maxL = (n - i) < 258 ? (n - i) : 258;
            while (j >= 0 && chain > 0) {
                chain--;
                if (i - j > WSIZE) break;
                let l = 0;
                while (l < maxL && data[j + l] === data[i + l]) l++;
                if (l > bestLen) { bestLen = l; bestDist = i - j; if (l >= maxL) break; }
                j = prev[j];
            }
        }
        if (bestLen >= 3) {
            const lc = _lengthCode(bestLen);
            _writeHuff(w, _fixedLitCode(lc.sym), _fixedLitLen(lc.sym));
            if (lc.extra > 0) _writeBits(w, lc.val, lc.extra);
            const dc = _distCodeOf(bestDist);
            _writeHuff(w, dc.sym, 5);
            if (dc.extra > 0) _writeBits(w, dc.val, dc.extra);
            const end = i + bestLen;
            while (i < end) {
                if (i + 3 <= n) {
                    const h2 = ((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) & 0x7fff;
                    prev[i] = head[h2]; head[h2] = i;
                }
                i++;
            }
        } else {
            _writeHuff(w, _fixedLitCode(data[i]), _fixedLitLen(data[i]));
            if (i + 3 <= n) {
                const h3 = ((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) & 0x7fff;
                prev[i] = head[h3]; head[h3] = i;
            }
            i++;
        }
    }
    _writeHuff(w, _fixedLitCode(256), _fixedLitLen(256)); // end of block (symbol 256, 7 bits)
    _flushWriter(w);
    return w.bytes;
}

// ---------------------------------------------------------------------------
// container wrappers
// ---------------------------------------------------------------------------
function _u32le(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
function _u32be(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }

function _gzipBytes(data) {
    const out = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03];
    const body = _deflateRaw(data);
    for (let i = 0; i < body.length; i++) out.push(body[i]);
    const crc = _u32le(_crc32(data));
    for (let i = 0; i < 4; i++) out.push(crc[i]);
    const isize = _u32le((data.length >>> 0));
    for (let i = 0; i < 4; i++) out.push(isize[i]);
    return out;
}
function _gunzipBytes(bytes) {
    // header: magic(2) CM(1) FLG(1) MTIME(4) XFL(1) OS(1) = 10 bytes
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return [];
    const flg = bytes[3];
    let p = 10;
    if (flg & 0x04) { // FEXTRA
        const xlen = bytes[p] | (bytes[p + 1] << 8);
        p += 2 + xlen;
    }
    if (flg & 0x08) { while (p < bytes.length && bytes[p] !== 0) p++; p++; } // FNAME
    if (flg & 0x10) { while (p < bytes.length && bytes[p] !== 0) p++; p++; } // FCOMMENT
    if (flg & 0x02) { p += 2; } // FHCRC
    const body = [];
    for (let i = p; i < bytes.length - 8; i++) body.push(bytes[i]);
    return _inflateRaw(body);
}
function _zlibWrapBytes(data) {
    const out = [0x78, 0x9c]; // CMF=0x78 (32K window), FLG=0x9c (check ok, no dict)
    const body = _deflateRaw(data);
    for (let i = 0; i < body.length; i++) out.push(body[i]);
    const ad = _u32be(_adler32(data));
    for (let i = 0; i < 4; i++) out.push(ad[i]);
    return out;
}
function _zlibUnwrapBytes(bytes) {
    // 2-byte header, deflate body, 4-byte adler32 trailer
    const body = [];
    for (let i = 2; i < bytes.length - 4; i++) body.push(bytes[i]);
    return _inflateRaw(body);
}

// ---------------------------------------------------------------------------
// public sync API
// ---------------------------------------------------------------------------
function deflateRawSync(data, options) { return _bytesToBuffer(_deflateRaw(_toBytes(data))); }
function inflateRawSync(data, options) { return _bytesToBuffer(_inflateRaw(_toBytes(data))); }
function deflateSync(data, options) { return _bytesToBuffer(_zlibWrapBytes(_toBytes(data))); }
function inflateSync(data, options) { return _bytesToBuffer(_zlibUnwrapBytes(_toBytes(data))); }
function gzipSync(data, options) { return _bytesToBuffer(_gzipBytes(_toBytes(data))); }
function gunzipSync(data, options) { return _bytesToBuffer(_gunzipBytes(_toBytes(data))); }
// bytes -> bytes auto-detect (gzip magic vs zlib wrapper); shared by unzipSync
// and the streaming createUnzip().
function _unzipBytes(b) {
    if (b[0] === 0x1f && b[1] === 0x8b) return _gunzipBytes(b);
    return _zlibUnwrapBytes(b);
}
function unzipSync(data, options) { return _bytesToBuffer(_unzipBytes(_toBytes(data))); }

function crc32(data, value) {
    // Node 22+ exposes zlib.crc32(data[, value]); support the seed form.
    const bytes = _toBytes(data);
    if (value === undefined) return _crc32(bytes);
    const t = _crcTableGet();
    let c = (~value) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// Streaming (Transform-style) zlib class built on the sync codecs. write()
// buffers input; end() runs the whole codec once and emits the result as a
// single 'data' chunk followed by 'end'/'finish'/'close' — no event-loop
// plumbing needed (all synchronous). Enough for the common
// `src.pipe(zlib.createGzip()).pipe(dst)` and write/end + 'data'/'end' patterns.
class ZlibStream extends EventEmitter {
    constructor(transform, options) {
        super();
        this._transform = transform;   // fn(byteArray) -> byteArray
        this._buf = [];                // accumulated input bytes
        this._ended = false;
        this.bytesWritten = 0;
        this.bytesRead = 0;
        this.writable = true;
        this.readable = true;
    }
    write(chunk, encoding, cb) {
        if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
        const b = _toBytes(chunk);
        for (let i = 0; i < b.length; i++) this._buf.push(b[i]);
        this.bytesWritten += b.length;
        if (typeof cb === "function") cb();
        return true;
    }
    end(chunk, encoding, cb) {
        if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
        else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
        if (chunk !== undefined && chunk !== null) this.write(chunk);
        if (this._ended) { if (typeof cb === "function") cb(); return this; }
        this._ended = true;
        this.writable = false;
        let out;
        try {
            out = this._transform(this._buf);
        } catch (e) {
            this.emit("error", e);
            return this;
        }
        this.bytesRead = out.length;
        // Emit the whole result as one chunk, then signal completion. Consumers
        // that accumulate 'data' see a single Buffer (avoids the Buffer.concat
        // array-method-dispatch caveat when only one chunk is produced).
        if (out.length > 0) this.emit("data", _bytesToBuffer(out));
        this.readable = false;
        this.emit("end");
        this.emit("finish");
        this.emit("close");
        if (typeof cb === "function") cb();
        return this;
    }
    flush(cb) { if (typeof cb === "function") cb(); return this; }
    destroy(err) { if (err) this.emit("error", err); this.emit("close"); return this; }
    // Forward this stream's output into a writable and end it when we finish.
    // Attach listeners lazily so a `src.pipe(gzip).pipe(dst)` chain wires up
    // before any bytes flow.
    pipe(dest) {
        const self = this;
        this.on("data", function (d) { if (dest && dest.write) dest.write(d); });
        this.on("end", function () { if (dest && dest.end) dest.end(); });
        return dest;
    }
}

function _makeZlibStream(transform, options) { return new ZlibStream(transform, options); }

// callback-style async wrappers (run synchronously, then invoke callback)
function _asyncWrap(fn) {
    return function (data, options, callback) {
        if (typeof options === "function") { callback = options; options = undefined; }
        let result = null, err = null;
        try { result = fn(data, options); } catch (e) { err = e; }
        if (typeof callback === "function") callback(err, result);
    };
}

export const constants = {
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,
    Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
    Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
    Z_DEFLATED: 8,
    DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7
};
export const codes = {
    Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
    "0": "Z_OK", "1": "Z_STREAM_END", "2": "Z_NEED_DICT", "-1": "Z_ERRNO", "-2": "Z_STREAM_ERROR",
    "-3": "Z_DATA_ERROR", "-4": "Z_MEM_ERROR", "-5": "Z_BUF_ERROR", "-6": "Z_VERSION_ERROR"
};

export const zlib = {
    deflateRawSync, inflateRawSync, deflateSync, inflateSync, gzipSync, gunzipSync, unzipSync,
    deflate: _asyncWrap(deflateSync), inflate: _asyncWrap(inflateSync),
    deflateRaw: _asyncWrap(deflateRawSync), inflateRaw: _asyncWrap(inflateRawSync),
    gzip: _asyncWrap(gzipSync), gunzip: _asyncWrap(gunzipSync), unzip: _asyncWrap(unzipSync),
    crc32,
    createGzip(options) { return _makeZlibStream(_gzipBytes, options); },
    createGunzip(options) { return _makeZlibStream(_gunzipBytes, options); },
    createDeflate(options) { return _makeZlibStream(_zlibWrapBytes, options); },
    createInflate(options) { return _makeZlibStream(_zlibUnwrapBytes, options); },
    createDeflateRaw(options) { return _makeZlibStream(_deflateRaw, options); },
    createInflateRaw(options) { return _makeZlibStream(_inflateRaw, options); },
    createUnzip(options) { return _makeZlibStream(_unzipBytes, options); },
    Gzip: ZlibStream, Gunzip: ZlibStream, Deflate: ZlibStream,
    Inflate: ZlibStream, DeflateRaw: ZlibStream, InflateRaw: ZlibStream, Unzip: ZlibStream,
    brotliCompressSync(data) { return _bytesToBuffer(_toBytes(data)); },
    brotliDecompressSync(data) { return _bytesToBuffer(_toBytes(data)); },
    constants,
    codes
};

export {
    deflateRawSync, inflateRawSync, deflateSync, inflateSync, gzipSync, gunzipSync, unzipSync, crc32
};

export default zlib;
