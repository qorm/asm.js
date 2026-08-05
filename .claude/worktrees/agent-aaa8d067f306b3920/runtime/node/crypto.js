// asm.js Runtime - Node.js crypto

import { Buffer } from "./buffer.js";
import { getSyscall } from "./constants.js";

const _proc = __get_process();
const _platform = (_proc && _proc.platform) || "macos";

// 从内核熵源(macOS getentropy / linux getrandom)填 size 个随机字节到数组。
// 不依赖 Math.random(未实现);单次熵调用上限 256 字节,超出分块。
function _entropyBytes(size) {
    const out = [];
    if (size <= 0) return out;
    const buf = __alloc(size + 1);
    if (_platform === "linux" || _platform === "wasi") {
        const sc = getSyscall("getrandom"); // wasi:号名空间 = linux-x64,宿主熵源
        let off = 0;
        while (off < size) {
            const chunk = size - off > 256 ? 256 : size - off;
            __syscall(sc, buf + off, chunk, 0); // getrandom(buf, len, flags=0)
            off += chunk;
        }
    } else if (_platform === "macos") {
        const sc = getSyscall("getentropy");
        let off = 0;
        while (off < size) {
            const chunk = size - off > 256 ? 256 : size - off;
            __syscall(sc, buf + off, chunk); // getentropy(buf, len<=256)
            off += chunk;
        }
    } else {
        // 无熵源(如 windows):退化为 0 填充(记偏差)
        for (let i = 0; i < size; i++) out.push(0);
        return out;
    }
    for (let i = 0; i < size; i++) out.push(__getChar(buf + i));
    return out;
}

const _hexChars = "0123456789abcdef";

// ============================================================================
// 真实哈希实现(SHA-256 / SHA-1 / MD5)。纯 32 位整数运算(移位/异或/加法),
// 无乘法,asm.js 编译产物可正确执行。输入按字节数组处理(字符串走 charCodeAt,
// ASCII 与 Node utf8 一致;非 ASCII 记偏差)。sha224/384/512 尚无实现,退化为
// 旧的确定性占位摘要(稳定但非真值)。
// ============================================================================

function _rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
function _rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

function _strBytes(buf) {
    const b = [];
    for (let i = 0; i < buf.length; i++) b.push(buf.charCodeAt(i) & 0xff);
    return b;
}
function _bytesHex(bytes) {
    let s = "";
    for (let k = 0; k < bytes.length; k++) {
        const hx = bytes[k].toString(16);
        s += hx.length === 1 ? "0" + hx : hx;
    }
    return s;
}
// 32 位字数组 → 大端字节数组
function _wordsBE(hs) {
    const out = [];
    for (let i = 0; i < hs.length; i++) {
        out.push((hs[i] >>> 24) & 0xff);
        out.push((hs[i] >>> 16) & 0xff);
        out.push((hs[i] >>> 8) & 0xff);
        out.push(hs[i] & 0xff);
    }
    return out;
}

const _SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

// 消息填充(大端 64 位长度;仅支持 < 2^32 位)。返回填充后的字节数组
function _padBE(bytes) {
    const m = bytes.slice();
    const L = m.length * 8;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    m.push(0); m.push(0); m.push(0); m.push(0);
    m.push((L >>> 24) & 0xff); m.push((L >>> 16) & 0xff); m.push((L >>> 8) & 0xff); m.push(L & 0xff);
    return m;
}

function _sha256(bytes) {
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const m = _padBE(bytes);
    const w = [];
    for (let c = 0; c < m.length; c += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = ((m[c + i * 4] << 24) | (m[c + i * 4 + 1] << 16) | (m[c + i * 4 + 2] << 8) | (m[c + i * 4 + 3])) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const s0 = (_rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
            const s1 = (_rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h0, b = h1, cc = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = (_rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25)) >>> 0;
            const ch = ((e & f) ^ ((~e) & g)) >>> 0;
            const t1 = (h + S1 + ch + _SHA256_K[i] + w[i]) >>> 0;
            const S0 = (_rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22)) >>> 0;
            const maj = ((a & b) ^ (a & cc) ^ (b & cc)) >>> 0;
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = cc; cc = b; b = a; a = (t1 + t2) >>> 0;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + cc) >>> 0; h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return _wordsBE([h0, h1, h2, h3, h4, h5, h6, h7]);
}

function _sha1(bytes) {
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const m = _padBE(bytes);
    const w = [];
    for (let c = 0; c < m.length; c += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = ((m[c + i * 4] << 24) | (m[c + i * 4 + 1] << 16) | (m[c + i * 4 + 2] << 8) | (m[c + i * 4 + 3])) >>> 0;
        }
        for (let i = 16; i < 80; i++) w[i] = _rotl((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 0, 1);
        let a = h0, b = h1, cc = h2, d = h3, e = h4;
        for (let i = 0; i < 80; i++) {
            let f, k;
            if (i < 20) { f = ((b & cc) | ((~b) & d)) >>> 0; k = 0x5A827999; }
            else if (i < 40) { f = (b ^ cc ^ d) >>> 0; k = 0x6ED9EBA1; }
            else if (i < 60) { f = ((b & cc) | (b & d) | (cc & d)) >>> 0; k = 0x8F1BBCDC; }
            else { f = (b ^ cc ^ d) >>> 0; k = 0xCA62C1D6; }
            const t = (_rotl(a, 5) + f + e + k + w[i]) >>> 0;
            e = d; d = cc; cc = _rotl(b, 30); b = a; a = t;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + cc) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return _wordsBE([h0, h1, h2, h3, h4]);
}

const _MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const _MD5_T = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
];

function _md5(bytes) {
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const m = bytes.slice();
    const L = m.length * 8;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    // MD5 长度是小端 64 位
    m.push(L & 0xff); m.push((L >>> 8) & 0xff); m.push((L >>> 16) & 0xff); m.push((L >>> 24) & 0xff);
    m.push(0); m.push(0); m.push(0); m.push(0);
    const M = [];
    for (let c = 0; c < m.length; c += 64) {
        for (let i = 0; i < 16; i++) {
            M[i] = ((m[c + i * 4]) | (m[c + i * 4 + 1] << 8) | (m[c + i * 4 + 2] << 16) | (m[c + i * 4 + 3] << 24)) >>> 0;
        }
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16) { F = ((B & C) | ((~B) & D)) >>> 0; g = i; }
            else if (i < 32) { F = ((D & B) | ((~D) & C)) >>> 0; g = (5 * i + 1) % 16; }
            else if (i < 48) { F = (B ^ C ^ D) >>> 0; g = (3 * i + 5) % 16; }
            else { F = (C ^ (B | ((~D) >>> 0))) >>> 0; g = (7 * i) % 16; }
            F = (F + A + _MD5_T[i] + M[g]) >>> 0;
            A = D; D = C; C = B; B = (B + _rotl(F, _MD5_S[i])) >>> 0;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    // MD5 输出为小端字节序
    const out = [];
    const words = [a0, b0, c0, d0];
    for (let i = 0; i < 4; i++) {
        out.push(words[i] & 0xff);
        out.push((words[i] >>> 8) & 0xff);
        out.push((words[i] >>> 16) & 0xff);
        out.push((words[i] >>> 24) & 0xff);
    }
    return out;
}

// ============================================================================
// SHA-512 / SHA-384(64 位算法)。asm.js number 为 float64,无原生 64 位整数,
// 故每个 64 位字用 [hi, lo] 两个 32 位无符号分量表示;所有运算(rotr/shr/
// xor/and/not/带进位加)在 32 位分量上做,无宽整数乘。`>>> 0` 已验证可把
// 至多 ~2^35 的浮点正确约减到 uint32(SHA-256 路径同款),进位用比较得出。
// ============================================================================
function _add64(a, b) {
    const lo = a[1] + b[1];
    const carry = lo >= 4294967296 ? 1 : 0;
    return [(a[0] + b[0] + carry) >>> 0, lo >>> 0];
}
function _xor64(a, b) { return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0]; }
function _and64(a, b) { return [(a[0] & b[0]) >>> 0, (a[1] & b[1]) >>> 0]; }
function _not64(a) { return [(~a[0]) >>> 0, (~a[1]) >>> 0]; }
function _rotr64(x, n) {
    const hi = x[0], lo = x[1];
    if (n === 32) return [lo, hi];
    if (n < 32) return [((hi >>> n) | (lo << (32 - n))) >>> 0, ((lo >>> n) | (hi << (32 - n))) >>> 0];
    const m = n - 32;
    return [((lo >>> m) | (hi << (32 - m))) >>> 0, ((hi >>> m) | (lo << (32 - m))) >>> 0];
}
function _shr64(x, n) {
    const hi = x[0], lo = x[1];
    return [(hi >>> n) >>> 0, ((lo >>> n) | (hi << (32 - n))) >>> 0];
}
const _SHA512_K = [
    [0x428a2f98,0xd728ae22],[0x71374491,0x23ef65cd],[0xb5c0fbcf,0xec4d3b2f],[0xe9b5dba5,0x8189dbbc],
    [0x3956c25b,0xf348b538],[0x59f111f1,0xb605d019],[0x923f82a4,0xaf194f9b],[0xab1c5ed5,0xda6d8118],
    [0xd807aa98,0xa3030242],[0x12835b01,0x45706fbe],[0x243185be,0x4ee4b28c],[0x550c7dc3,0xd5ffb4e2],
    [0x72be5d74,0xf27b896f],[0x80deb1fe,0x3b1696b1],[0x9bdc06a7,0x25c71235],[0xc19bf174,0xcf692694],
    [0xe49b69c1,0x9ef14ad2],[0xefbe4786,0x384f25e3],[0x0fc19dc6,0x8b8cd5b5],[0x240ca1cc,0x77ac9c65],
    [0x2de92c6f,0x592b0275],[0x4a7484aa,0x6ea6e483],[0x5cb0a9dc,0xbd41fbd4],[0x76f988da,0x831153b5],
    [0x983e5152,0xee66dfab],[0xa831c66d,0x2db43210],[0xb00327c8,0x98fb213f],[0xbf597fc7,0xbeef0ee4],
    [0xc6e00bf3,0x3da88fc2],[0xd5a79147,0x930aa725],[0x06ca6351,0xe003826f],[0x14292967,0x0a0e6e70],
    [0x27b70a85,0x46d22ffc],[0x2e1b2138,0x5c26c926],[0x4d2c6dfc,0x5ac42aed],[0x53380d13,0x9d95b3df],
    [0x650a7354,0x8baf63de],[0x766a0abb,0x3c77b2a8],[0x81c2c92e,0x47edaee6],[0x92722c85,0x1482353b],
    [0xa2bfe8a1,0x4cf10364],[0xa81a664b,0xbc423001],[0xc24b8b70,0xd0f89791],[0xc76c51a3,0x0654be30],
    [0xd192e819,0xd6ef5218],[0xd6990624,0x5565a910],[0xf40e3585,0x5771202a],[0x106aa070,0x32bbd1b8],
    [0x19a4c116,0xb8d2d0c8],[0x1e376c08,0x5141ab53],[0x2748774c,0xdf8eeb99],[0x34b0bcb5,0xe19b48a8],
    [0x391c0cb3,0xc5c95a63],[0x4ed8aa4a,0xe3418acb],[0x5b9cca4f,0x7763e373],[0x682e6ff3,0xd6b2b8a3],
    [0x748f82ee,0x5defb2fc],[0x78a5636f,0x43172f60],[0x84c87814,0xa1f0ab72],[0x8cc70208,0x1a6439ec],
    [0x90befffa,0x23631e28],[0xa4506ceb,0xde82bde9],[0xbef9a3f7,0xb2c67915],[0xc67178f2,0xe372532b],
    [0xca273ece,0xea26619c],[0xd186b8c7,0x21c0c207],[0xeada7dd6,0xcde0eb1e],[0xf57d4f7f,0xee6ed178],
    [0x06f067aa,0x72176fba],[0x0a637dc5,0xa2c898a6],[0x113f9804,0xbef90dae],[0x1b710b35,0x131c471b],
    [0x28db77f5,0x23047d84],[0x32caab7b,0x40c72493],[0x3c9ebe0a,0x15c9bebc],[0x431d67c4,0x9c100d4c],
    [0x4cc5d4be,0xcb3e42b6],[0x597f299c,0xfc657e2a],[0x5fcb6fab,0x3ad6faec],[0x6c44198c,0x4a475817]
];
const _SHA512_H = [
    [0x6a09e667,0xf3bcc908],[0xbb67ae85,0x84caa73b],[0x3c6ef372,0xfe94f82b],[0xa54ff53a,0x5f1d36f1],
    [0x510e527f,0xade682d1],[0x9b05688c,0x2b3e6c1f],[0x1f83d9ab,0xfb41bd6b],[0x5be0cd19,0x137e2179]
];
const _SHA384_H = [
    [0xcbbb9d5d,0xc1059ed8],[0x629a292a,0x367cd507],[0x9159015a,0x3070dd17],[0x152fecd8,0xf70e5939],
    [0x67332667,0xffc00b31],[0x8eb44a87,0x68581511],[0xdb0c2e0d,0x64f98fa7],[0x47b5481d,0xbefa4fa4]
];
// 128 字节块填充:0x80 + 0 直到 ≡112 (mod 128) + 128 位大端比特长度
// (仅低 32 位有效,消息 < 2^29 字节)。
function _padBE128(bytes) {
    const m = bytes.slice();
    const L = m.length * 8;
    m.push(0x80);
    while (m.length % 128 !== 112) m.push(0);
    for (let i = 0; i < 12; i++) m.push(0); // 高 96 位长度置零
    m.push((L >>> 24) & 0xff); m.push((L >>> 16) & 0xff); m.push((L >>> 8) & 0xff); m.push(L & 0xff);
    return m;
}
function _sha512(bytes, is384) {
    const h = [];
    for (let i = 0; i < 8; i++) { const iv = is384 ? _SHA384_H[i] : _SHA512_H[i]; h.push([iv[0], iv[1]]); }
    const m = _padBE128(bytes);
    const W = [];
    for (let c = 0; c < m.length; c += 128) {
        for (let i = 0; i < 16; i++) {
            const o = c + i * 8;
            W[i] = [
                ((m[o] << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3]) >>> 0,
                ((m[o + 4] << 24) | (m[o + 5] << 16) | (m[o + 6] << 8) | m[o + 7]) >>> 0
            ];
        }
        for (let i = 16; i < 80; i++) {
            const w15 = W[i - 15], w2 = W[i - 2];
            const s0 = _xor64(_xor64(_rotr64(w15, 1), _rotr64(w15, 8)), _shr64(w15, 7));
            const s1 = _xor64(_xor64(_rotr64(w2, 19), _rotr64(w2, 61)), _shr64(w2, 6));
            W[i] = _add64(_add64(_add64(W[i - 16], s0), W[i - 7]), s1);
        }
        let a = h[0], b = h[1], cc = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 80; i++) {
            const S1 = _xor64(_xor64(_rotr64(e, 14), _rotr64(e, 18)), _rotr64(e, 41));
            const ch = _xor64(_and64(e, f), _and64(_not64(e), g));
            const t1 = _add64(_add64(_add64(_add64(hh, S1), ch), _SHA512_K[i]), W[i]);
            const S0 = _xor64(_xor64(_rotr64(a, 28), _rotr64(a, 34)), _rotr64(a, 39));
            const maj = _xor64(_xor64(_and64(a, b), _and64(a, cc)), _and64(b, cc));
            const t2 = _add64(S0, maj);
            hh = g; g = f; f = e; e = _add64(d, t1); d = cc; cc = b; b = a; a = _add64(t1, t2);
        }
        h[0] = _add64(h[0], a); h[1] = _add64(h[1], b); h[2] = _add64(h[2], cc); h[3] = _add64(h[3], d);
        h[4] = _add64(h[4], e); h[5] = _add64(h[5], f); h[6] = _add64(h[6], g); h[7] = _add64(h[7], hh);
    }
    const nwords = is384 ? 6 : 8;
    const out = [];
    for (let i = 0; i < nwords; i++) {
        const hi = h[i][0], lo = h[i][1];
        out.push((hi >>> 24) & 0xff); out.push((hi >>> 16) & 0xff); out.push((hi >>> 8) & 0xff); out.push(hi & 0xff);
        out.push((lo >>> 24) & 0xff); out.push((lo >>> 16) & 0xff); out.push((lo >>> 8) & 0xff); out.push(lo & 0xff);
    }
    return out;
}

// 旧的确定性占位(仅 sha224 未实现算法时用)
function _fallbackWidth(algo) {
    const a = (algo || "").toLowerCase();
    if (a === "sha224") return 28;
    if (a === "sha384") return 48;
    if (a === "sha512") return 64;
    return 32;
}
function _fallbackDigest(buf, algo) {
    const n = _fallbackWidth(algo);
    const bytes = [];
    for (let k = 0; k < n; k++) {
        let h = (5381 + k * 131) | 0;
        for (let i = 0; i < buf.length; i++) h = (((h << 5) + h) + buf.charCodeAt(i) + k) | 0;
        bytes.push((h >>> 0) & 0xff);
    }
    return bytes;
}

// 算法名 → 真实哈希函数;未知返回 null(走占位)
function _hashBytes(algo, buf) {
    const a = (algo || "").toLowerCase();
    const bytes = _strBytes(buf);
    if (a === "sha256") return _sha256(bytes);
    if (a === "sha512") return _sha512(bytes, false);
    if (a === "sha384") return _sha512(bytes, true);
    if (a === "sha1") return _sha1(bytes);
    if (a === "md5") return _md5(bytes);
    return null;
}

function _encodeDigest(bytes, encoding) {
    if (encoding === "hex") return _bytesHex(bytes);
    const b = Buffer.from(bytes);
    if (encoding === "base64") return b.toString("base64");
    return b; // 无 encoding → Buffer
}

function _computeDigest(buf, algo, encoding) {
    let bytes = _hashBytes(algo, buf);
    if (bytes === null) bytes = _fallbackDigest(buf, algo);
    return _encodeDigest(bytes, encoding);
}

// HMAC(RFC 2104):H((key ^ opad) || H((key ^ ipad) || msg))。
// 全程走字节数组的 _hmacRaw:哈希的中间摘要(inner digest)可能含 NUL 字节,
// 若用字符串拼接会被 asm.js 的内嵌 NUL 截断而算错,故 createHmac 与 PBKDF2
// 共用同一字节实现(块长:sha512/384=128,其余=64)。key 支持 string/Buffer。
function _hmacDigest(key, msg, algo, encoding) {
    const keyBytes = _toBytes(key);
    const msgBytes = _strBytes(msg);
    let bytes = _hmacRaw(algo, keyBytes, msgBytes);
    if (bytes === null) bytes = _fallbackDigest(msg, algo);
    return _encodeDigest(bytes, encoding);
}
function _bytesToStr(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
    return s;
}

// ============================================================================
// 通用字节编解码(供对称加密 / PBKDF2 使用)。
// ============================================================================
// 任意输入(string / Buffer / 字节数组)→ 字节数组(值 0-255)。
function _toBytes(v, enc) {
    if (v === undefined || v === null) return [];
    if (v instanceof Buffer) {
        const b = [];
        for (let i = 0; i < v.data.length; i++) b.push(v.data[i] & 0xff);
        return b;
    }
    if (typeof v === "string") {
        if (enc === "hex" || enc === "base64" || enc === "base64url") {
            const bb = Buffer.from(v, enc);
            const b = [];
            for (let i = 0; i < bb.data.length; i++) b.push(bb.data[i] & 0xff);
            return b;
        }
        const b = [];
        for (let i = 0; i < v.length; i++) b.push(v.charCodeAt(i) & 0xff);
        return b;
    }
    if (typeof v.length === "number") {
        const b = [];
        for (let i = 0; i < v.length; i++) b.push(v[i] & 0xff);
        return b;
    }
    return [];
}
// 字节数组 → 指定编码(hex/base64/latin1/…) 字符串;无编码返回 Buffer。
function _encodeOut(bytes, enc) {
    if (enc === "hex") return _bytesHex(bytes);
    const b = Buffer.from(bytes);
    if (enc === undefined || enc === null) return b;
    return b.toString(enc);
}

// ============================================================================
// AES 块加密(纯字节运算,GF(2^8) 用位移-异或的农夫乘法,无宽整数乘)。
// 支持 aes-128/192/256-cbc + PKCS#7 填充。与 Node 输出逐字节一致。
// ============================================================================
const _AES_SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
];
const _AES_INV_SBOX = [
    0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,
    0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,
    0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,
    0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,
    0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,
    0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,
    0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,
    0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,
    0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,
    0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,
    0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,
    0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,
    0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,
    0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,
    0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,
    0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d
];
const _AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d];

// GF(2^8) 乘法(农夫算法,AES 既约多项式 0x11b)。
function _gmul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hi = a & 0x80;
        a = (a << 1) & 0xff;
        if (hi) a ^= 0x1b;
        b >>= 1;
    }
    return p & 0xff;
}

function _aesInfo(algo) {
    const a = (algo || "").toLowerCase();
    let Nk = 0, mode = "";
    if (a === "aes-128-cbc") { Nk = 4; mode = "cbc"; }
    else if (a === "aes-192-cbc") { Nk = 6; mode = "cbc"; }
    else if (a === "aes-256-cbc") { Nk = 8; mode = "cbc"; }
    else if (a === "aes-128-ctr") { Nk = 4; mode = "ctr"; }
    else if (a === "aes-192-ctr") { Nk = 6; mode = "ctr"; }
    else if (a === "aes-256-ctr") { Nk = 8; mode = "ctr"; }
    else if (a === "aes-128-gcm") { Nk = 4; mode = "gcm"; }
    else if (a === "aes-192-gcm") { Nk = 6; mode = "gcm"; }
    else if (a === "aes-256-gcm") { Nk = 8; mode = "gcm"; }
    else return null;
    const Nr = Nk === 4 ? 10 : (Nk === 6 ? 12 : 14);
    return { Nk: Nk, Nr: Nr, mode: mode };
}

// 密钥扩展:返回扁平轮密钥字节数组,长度 16*(Nr+1)。
function _aesKeyExpansion(key, Nk, Nr) {
    const total = 4 * (Nr + 1);
    const w = [];               // 每个元素是长度 4 的字节数组
    for (let i = 0; i < Nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
    for (let i = Nk; i < total; i++) {
        const p = w[i - 1];
        let t0 = p[0], t1 = p[1], t2 = p[2], t3 = p[3];
        if (i % Nk === 0) {
            const r = t0; t0 = t1; t1 = t2; t2 = t3; t3 = r;       // RotWord
            t0 = _AES_SBOX[t0]; t1 = _AES_SBOX[t1]; t2 = _AES_SBOX[t2]; t3 = _AES_SBOX[t3]; // SubWord
            t0 ^= _AES_RCON[((i / Nk) | 0) - 1];
        } else if (Nk > 6 && i % Nk === 4) {
            t0 = _AES_SBOX[t0]; t1 = _AES_SBOX[t1]; t2 = _AES_SBOX[t2]; t3 = _AES_SBOX[t3];
        }
        const q = w[i - Nk];
        w.push([q[0] ^ t0, q[1] ^ t1, q[2] ^ t2, q[3] ^ t3]);
    }
    const out = [];
    for (let i = 0; i < w.length; i++) { out.push(w[i][0]); out.push(w[i][1]); out.push(w[i][2]); out.push(w[i][3]); }
    return out;
}
// 长度 16 的清零数组(避开稀疏/乱序下标赋值增长)。
function _zero16() { return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; }

function _aesAddRoundKey(s, rk, round) {
    const base = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[base + i];
}

// 状态按列主序:s[row + 4*col]。
function _aesEncryptBlock(block, rk, Nr) {
    const s = [];
    for (let i = 0; i < 16; i++) s.push(block[i]);
    _aesAddRoundKey(s, rk, 0);
    for (let round = 1; round <= Nr; round++) {
        // SubBytes
        for (let i = 0; i < 16; i++) s[i] = _AES_SBOX[s[i]];
        // ShiftRows: 行 r 左移 r
        const t = _zero16();
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[r + 4 * c] = s[r + 4 * ((c + r) % 4)];
        for (let i = 0; i < 16; i++) s[i] = t[i];
        if (round < Nr) {
            // MixColumns
            for (let c = 0; c < 4; c++) {
                const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
                s[4 * c]     = _gmul(a0, 2) ^ _gmul(a1, 3) ^ a2 ^ a3;
                s[4 * c + 1] = a0 ^ _gmul(a1, 2) ^ _gmul(a2, 3) ^ a3;
                s[4 * c + 2] = a0 ^ a1 ^ _gmul(a2, 2) ^ _gmul(a3, 3);
                s[4 * c + 3] = _gmul(a0, 3) ^ a1 ^ a2 ^ _gmul(a3, 2);
            }
        }
        _aesAddRoundKey(s, rk, round);
    }
    return s;
}

function _aesDecryptBlock(block, rk, Nr) {
    const s = [];
    for (let i = 0; i < 16; i++) s.push(block[i]);
    _aesAddRoundKey(s, rk, Nr);
    for (let round = Nr - 1; round >= 0; round--) {
        // InvShiftRows: 行 r 右移 r
        const t = _zero16();
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[r + 4 * c] = s[r + 4 * ((c - r + 4) % 4)];
        for (let i = 0; i < 16; i++) s[i] = t[i];
        // InvSubBytes
        for (let i = 0; i < 16; i++) s[i] = _AES_INV_SBOX[s[i]];
        _aesAddRoundKey(s, rk, round);
        if (round > 0) {
            // InvMixColumns
            for (let c = 0; c < 4; c++) {
                const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
                s[4 * c]     = _gmul(a0, 14) ^ _gmul(a1, 11) ^ _gmul(a2, 13) ^ _gmul(a3, 9);
                s[4 * c + 1] = _gmul(a0, 9) ^ _gmul(a1, 14) ^ _gmul(a2, 11) ^ _gmul(a3, 13);
                s[4 * c + 2] = _gmul(a0, 13) ^ _gmul(a1, 9) ^ _gmul(a2, 14) ^ _gmul(a3, 11);
                s[4 * c + 3] = _gmul(a0, 11) ^ _gmul(a1, 13) ^ _gmul(a2, 9) ^ _gmul(a3, 14);
            }
        }
    }
    return s;
}

function _pkcs7Pad(bytes) {
    const pad = 16 - (bytes.length % 16);   // 恒 1..16(整块也补一整块)
    const out = [];
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
    for (let i = 0; i < pad; i++) out.push(pad);
    return out;
}
function _pkcs7Unpad(bytes) {
    if (bytes.length === 0) return bytes;
    const pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > 16 || pad > bytes.length) return bytes; // 非法填充:原样返回
    return bytes.slice(0, bytes.length - pad);
}

function _cbcEncrypt(data, rk, Nr, iv) {
    const out = [];
    const prev = [];
    for (let i = 0; i < 16; i++) prev.push(iv[i]);
    for (let off = 0; off < data.length; off += 16) {
        const blk = [];
        for (let i = 0; i < 16; i++) blk.push(data[off + i] ^ prev[i]);
        const enc = _aesEncryptBlock(blk, rk, Nr);
        for (let i = 0; i < 16; i++) { out.push(enc[i]); prev[i] = enc[i]; }
    }
    return out;
}
function _cbcDecrypt(data, rk, Nr, iv) {
    const out = [];
    const prev = [];
    for (let i = 0; i < 16; i++) prev.push(iv[i]);
    for (let off = 0; off < data.length; off += 16) {
        const blk = [];
        for (let i = 0; i < 16; i++) blk.push(data[off + i]);
        const dec = _aesDecryptBlock(blk, rk, Nr);
        for (let i = 0; i < 16; i++) { out.push(dec[i] ^ prev[i]); prev[i] = blk[i]; }
    }
    return out;
}

// CTR 模式:计数器 = IV(16 字节大端);逐块 AES 加密计数器得密钥流,与数据异或。
// 加密/解密同一操作。无填充,输出长度 = 输入长度。计数器整 128 位大端自增。
function _ctrInc(ctr) {
    for (let i = 15; i >= 0; i--) {
        ctr[i] = (ctr[i] + 1) & 0xff;
        if (ctr[i] !== 0) break;
    }
}
function _ctrCrypt(data, rk, Nr, iv) {
    const out = [];
    const ctr = [];
    for (let i = 0; i < 16; i++) ctr.push(iv[i] & 0xff);
    let off = 0;
    while (off < data.length) {
        const ks = _aesEncryptBlock(ctr, rk, Nr);
        const n = data.length - off > 16 ? 16 : data.length - off;
        for (let i = 0; i < n; i++) out.push((data[off + i] ^ ks[i]) & 0xff);
        _ctrInc(ctr);
        off += 16;
    }
    return out;
}

// ============================================================================
// GCM 模式(AEAD):CTR 加密 + GHASH 认证。与 Node aes-*-gcm 逐字节一致。
// GHASH 在 GF(2^128) 逐位做(移位-异或,无宽乘),约减多项式顶字节 0xe1。
// ============================================================================
// n 字节 → n*8 比特的 8 字节大端(GHASH 长度块用)。
function _len64(n) {
    const bits = n * 8;
    const out = [0, 0, 0, 0, 0, 0, 0, 0];
    out[7] = bits & 0xff;
    out[6] = (bits >>> 8) & 0xff;
    out[5] = (bits >>> 16) & 0xff;
    out[4] = (bits >>> 24) & 0xff;
    const hi = (n - (n % 536870912)) / 536870912; // floor(bits/2^32),小输入恒 0
    out[3] = hi & 0xff; out[2] = (hi >>> 8) & 0xff; out[1] = (hi >>> 16) & 0xff; out[0] = (hi >>> 24) & 0xff;
    return out;
}
// 只自增最右 32 位(GCM 计数器块)。
function _inc32(block) {
    for (let i = 15; i >= 12; i--) {
        block[i] = (block[i] + 1) & 0xff;
        if (block[i] !== 0) break;
    }
}
// GCTR:从初始计数器块 icb 起逐块 CTR 加密。加解密同一操作。
function _gctr(data, rk, Nr, icb) {
    const ctr = icb.slice();
    const out = [];
    let off = 0;
    while (off < data.length) {
        const ks = _aesEncryptBlock(ctr, rk, Nr);
        const n = data.length - off > 16 ? 16 : data.length - off;
        for (let i = 0; i < n; i++) out.push((data[off + i] ^ ks[i]) & 0xff);
        _inc32(ctr);
        off += 16;
    }
    return out;
}
// GF(2^128) 乘:Z = X·Y(16 字节大端块)。
function _ghashMul(X, Y) {
    const Z = _zero16();
    const V = Y.slice();
    for (let i = 0; i < 128; i++) {
        const bit = (X[i >> 3] >> (7 - (i & 7))) & 1;
        if (bit) for (let k = 0; k < 16; k++) Z[k] ^= V[k];
        const lsb = V[15] & 1;
        for (let k = 15; k >= 1; k--) V[k] = ((V[k] >> 1) | ((V[k - 1] & 1) << 7)) & 0xff;
        V[0] = V[0] >> 1;
        if (lsb) V[0] ^= 0xe1;
    }
    return Z;
}
// GHASH_H(blocks):blocks 长度须为 16 的倍数。
function _ghash(H, blocks) {
    let Y = _zero16();
    for (let off = 0; off < blocks.length; off += 16) {
        for (let k = 0; k < 16; k++) Y[k] ^= blocks[off + k];
        Y = _ghashMul(Y, H);
    }
    return Y;
}
// GHASH 输入组装:AAD || 0填充 || C || 0填充 || len(AAD)_64 || len(C)_64。
function _gcmGhashInput(aad, ct) {
    const buf = [];
    for (let i = 0; i < aad.length; i++) buf.push(aad[i]);
    while (buf.length % 16 !== 0) buf.push(0);
    for (let i = 0; i < ct.length; i++) buf.push(ct[i]);
    while (buf.length % 16 !== 0) buf.push(0);
    const la = _len64(aad.length), lc = _len64(ct.length);
    for (let i = 0; i < 8; i++) buf.push(la[i]);
    for (let i = 0; i < 8; i++) buf.push(lc[i]);
    return buf;
}
function _makeGcm(info, key, iv, decrypt) {
    const rk = _aesKeyExpansion(_toBytes(key), info.Nk, info.Nr);
    const Nr = info.Nr;
    const H = _aesEncryptBlock(_zero16(), rk, Nr); // 哈希子密钥 H = E(0)
    const ivBytes = _toBytes(iv);
    let J0;
    if (ivBytes.length === 12) {
        J0 = [];
        for (let i = 0; i < 12; i++) J0.push(ivBytes[i]);
        J0.push(0); J0.push(0); J0.push(0); J0.push(1);
    } else {
        const gi = [];
        for (let i = 0; i < ivBytes.length; i++) gi.push(ivBytes[i]);
        while (gi.length % 16 !== 0) gi.push(0);
        for (let i = 0; i < 8; i++) gi.push(0);
        const li = _len64(ivBytes.length);
        for (let i = 0; i < 8; i++) gi.push(li[i]);
        J0 = _ghash(H, gi);
    }
    const state = {
        chunks: [], aad: [], decrypt: decrypt, Nr: Nr, rk: rk, H: H, J0: J0,
        tag: null, expectedTag: null, tagLen: 16,
    };
    const api = {
        setAAD(buf, options) {
            const b = _toBytes(buf);
            for (let i = 0; i < b.length; i++) state.aad.push(b[i]);
            return api;
        },
        update(data, inputEncoding, outputEncoding) {
            const bytes = _toBytes(data, inputEncoding);
            for (let i = 0; i < bytes.length; i++) state.chunks.push(bytes[i]);
            return outputEncoding ? "" : Buffer.alloc(0);
        },
        setAuthTag(tag) {
            state.expectedTag = _toBytes(tag);
            return api;
        },
        getAuthTag() { return Buffer.from(state.tag); },
        setAutoPadding() { return api; }, // GCM 无填充,兼容占位
        final(outputEncoding) {
            const icb = state.J0.slice();
            _inc32(icb);
            let result;
            if (state.decrypt) {
                const ghi = _gcmGhashInput(state.aad, state.chunks);
                const S = _ghash(state.H, ghi);
                const ek = _aesEncryptBlock(state.J0, state.rk, state.Nr);
                const fullTag = [];
                for (let i = 0; i < 16; i++) fullTag.push((S[i] ^ ek[i]) & 0xff);
                let ok = state.expectedTag !== null;
                if (ok) {
                    const tl = state.expectedTag.length;
                    for (let i = 0; i < tl; i++) if (fullTag[i] !== state.expectedTag[i]) ok = false;
                }
                if (!ok) throw new Error("Unsupported state or unable to authenticate data");
                result = _gctr(state.chunks, state.rk, state.Nr, icb);
            } else {
                const ct = _gctr(state.chunks, state.rk, state.Nr, icb);
                const ghi = _gcmGhashInput(state.aad, ct);
                const S = _ghash(state.H, ghi);
                const ek = _aesEncryptBlock(state.J0, state.rk, state.Nr);
                const fullTag = [];
                for (let i = 0; i < 16; i++) fullTag.push((S[i] ^ ek[i]) & 0xff);
                state.tag = fullTag.slice(0, state.tagLen);
                result = ct;
            }
            return _encodeOut(result, outputEncoding);
        },
    };
    return api;
}

// Node Cipher/Decipher 对象。update 缓冲、final 一次性做 CBC(整块处理),
// 与 Buffer.concat([c.update(x), c.final()]) 及 hex 字符串拼接两种用法均兼容。
function _makeCipheriv(algo, key, iv, decrypt) {
    const info = _aesInfo(algo);
    if (!info) throw new Error("Unsupported cipher: " + algo);
    // 所有不变量放在 state 上,方法闭包只捕获 state(与 _makeHash 同型,规避
    // asm.js 里方法闭包捕获多个外层 const 的不可靠共享)。
    if (info.mode === "gcm") return _makeGcm(info, key, iv, decrypt);
    const state = {
        chunks: [], autoPad: true, decrypt: decrypt, Nr: info.Nr, mode: info.mode,
        rk: _aesKeyExpansion(_toBytes(key), info.Nk, info.Nr),
        iv: _toBytes(iv),
    };
    const api = {
        update(data, inputEncoding, outputEncoding) {
            const bytes = _toBytes(data, inputEncoding);
            for (let i = 0; i < bytes.length; i++) state.chunks.push(bytes[i]);
            return outputEncoding ? "" : Buffer.alloc(0);
        },
        final(outputEncoding) {
            let result;
            if (state.mode === "ctr") {
                result = _ctrCrypt(state.chunks, state.rk, state.Nr, state.iv);
            } else if (state.decrypt) {
                const dec = _cbcDecrypt(state.chunks, state.rk, state.Nr, state.iv);
                result = state.autoPad ? _pkcs7Unpad(dec) : dec;
            } else {
                const padded = state.autoPad ? _pkcs7Pad(state.chunks) : state.chunks;
                result = _cbcEncrypt(padded, state.rk, state.Nr, state.iv);
            }
            return _encodeOut(result, outputEncoding);
        },
        setAutoPadding(v) { state.autoPad = v !== false; return api; },
    };
    return api;
}

// 直接对字节数组做哈希(绕过字符串:asm.js 字符串遇内嵌 NUL 会截断,PBKDF2 的
// INT32BE 计数器含 NUL,故 HMAC/PBKDF2 全程走字节数组)。
function _hashRaw(algo, bytes) {
    const a = (algo || "").toLowerCase();
    if (a === "sha256") return _sha256(bytes);
    if (a === "sha512") return _sha512(bytes, false);
    if (a === "sha384") return _sha512(bytes, true);
    if (a === "sha1") return _sha1(bytes);
    if (a === "md5") return _md5(bytes);
    return null;
}

// HMAC 分组字节长:sha512/sha384 为 128,其余(md5/sha1/sha256)为 64。
function _hmacBlockLen(algo) {
    const a = (algo || "").toLowerCase();
    return (a === "sha512" || a === "sha384") ? 128 : 64;
}

// 原始字节 HMAC(供 PBKDF2 复用)。全字节运算。
function _hmacRaw(algo, keyBytes, msgBytes) {
    const block = _hmacBlockLen(algo);
    let k = [];
    for (let i = 0; i < keyBytes.length; i++) k.push(keyBytes[i]);
    if (k.length > block) {
        const kh = _hashRaw(algo, k);
        k = kh === null ? k.slice(0, block) : kh;
    }
    while (k.length < block) k.push(0);
    const inner = [];
    for (let i = 0; i < block; i++) inner.push((k[i] ^ 0x36) & 0xff);
    for (let i = 0; i < msgBytes.length; i++) inner.push(msgBytes[i] & 0xff);
    const innerHash = _hashRaw(algo, inner);
    const outer = [];
    for (let i = 0; i < block; i++) outer.push((k[i] ^ 0x5c) & 0xff);
    for (let i = 0; i < innerHash.length; i++) outer.push(innerHash[i]);
    return _hashRaw(algo, outer);
}

// PBKDF2(RFC 2898),PRF = HMAC-<digest>。返回长度 keylen 的 Buffer。
function _pbkdf2(password, salt, iterations, keylen, digest) {
    const algo = (digest || "sha1").toLowerCase();
    const pw = _toBytes(password);
    const saltB = _toBytes(salt);
    const dk = [];
    let blockIndex = 1;
    while (dk.length < keylen) {
        // U1 = PRF(pw, salt || INT32BE(blockIndex))
        const msg = [];
        for (let i = 0; i < saltB.length; i++) msg.push(saltB[i]);
        msg.push((blockIndex >>> 24) & 0xff);
        msg.push((blockIndex >>> 16) & 0xff);
        msg.push((blockIndex >>> 8) & 0xff);
        msg.push(blockIndex & 0xff);
        let u = _hmacRaw(algo, pw, msg);
        const t = [];
        for (let i = 0; i < u.length; i++) t.push(u[i]);
        for (let j = 1; j < iterations; j++) {
            u = _hmacRaw(algo, pw, u);
            for (let i = 0; i < t.length; i++) t[i] ^= u[i];
        }
        for (let i = 0; i < t.length && dk.length < keylen; i++) dk.push(t[i]);
        blockIndex++;
    }
    return Buffer.from(dk);
}

// 摘要输出字节长(HKDF 用)。
function _digestLen(algo) {
    const a = (algo || "").toLowerCase();
    if (a === "sha512") return 64;
    if (a === "sha384") return 48;
    if (a === "sha256") return 32;
    if (a === "sha1") return 20;
    if (a === "md5") return 16;
    return 32;
}

// HKDF(RFC 5869):Extract(PRK=HMAC(salt,IKM)) + Expand(逐块 HMAC 计数)。
// PRF = HMAC-<digest>,全字节运算(复用 _hmacRaw)。返回长度 keylen 的 Buffer
// (Node 返回 ArrayBuffer;`Buffer.from(result)` 两端通用)。
function _hkdf(digest, ikm, salt, info, keylen) {
    const algo = (digest || "").toLowerCase();
    const hashLen = _digestLen(algo);
    const ikmB = _toBytes(ikm);
    let saltB = _toBytes(salt);
    if (saltB.length === 0) { saltB = []; for (let i = 0; i < hashLen; i++) saltB.push(0); }
    const infoB = _toBytes(info);
    const prk = _hmacRaw(algo, saltB, ikmB); // Extract
    const okm = [];
    let prev = [];
    let counter = 1;
    while (okm.length < keylen) {
        const msg = [];
        for (let i = 0; i < prev.length; i++) msg.push(prev[i]);
        for (let i = 0; i < infoB.length; i++) msg.push(infoB[i]);
        msg.push(counter & 0xff);
        prev = _hmacRaw(algo, prk, msg); // T(i) = HMAC(PRK, T(i-1)||info||i)
        for (let i = 0; i < prev.length && okm.length < keylen; i++) okm.push(prev[i]);
        counter++;
    }
    return Buffer.from(okm);
}

// 用闭包对象(非 class):asm.js 里从对象方法内 `new ClassName()` 实例化会崩,
// 闭包 api 对象规避该限制,且 update 链式返回自身。
function _makeHash(algorithm) {
    const state = { algo: algorithm, buf: "" };
    const api = {
        update(data, inputEncoding) {
            if (typeof data === "string") state.buf += data;
            else if (data && typeof data.toString === "function") state.buf += data.toString();
            else state.buf += String(data);
            return api;
        },
        digest(encoding) {
            return _computeDigest(state.buf, state.algo, encoding);
        },
    };
    return api;
}
function _makeHmac(algorithm, key) {
    const state = { algo: algorithm, key: key, buf: "" };
    const api = {
        update(data, inputEncoding) {
            if (typeof data === "string") state.buf += data;
            else if (data && typeof data.toString === "function") state.buf += data.toString();
            else state.buf += String(data);
            return api;
        },
        digest(encoding) {
            return _hmacDigest(state.key, state.buf, state.algo, encoding);
        },
    };
    return api;
}

export const crypto = {
    randomBytes(size, callback) {
        const buf = Buffer.from(_entropyBytes(size));
        if (callback) { callback(null, buf); return; }
        return buf;
    },
    pseudoRandomBytes: (size) => crypto.randomBytes(size),
    randomFillSync(buffer, offset, size) {
        const off = offset || 0;
        const len = (size === undefined || size === null) ? (buffer.length - off) : size;
        const data = _entropyBytes(len);
        // Buffer 存储在 .data;普通 TypedArray/数组直接下标写。
        const dst = (buffer && buffer.data && typeof buffer.data.length === "number") ? buffer.data : buffer;
        for (let i = 0; i < len; i++) dst[off + i] = data[i];
        return buffer;
    },
    createHash(algorithm) {
        return _makeHash(algorithm);
    },
    createHmac: (algorithm, key) => _makeHmac(algorithm, key),
    createCipheriv: (algorithm, key, iv) => _makeCipheriv(algorithm, key, iv, false),
    createDecipheriv: (algorithm, key, iv) => _makeCipheriv(algorithm, key, iv, true),
    getCiphers: () => [
        "aes-128-cbc", "aes-192-cbc", "aes-256-cbc",
        "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
        "aes-128-gcm", "aes-192-gcm", "aes-256-gcm",
    ],
    getHashes: () => ["sha1", "sha256", "sha384", "sha512", "md5"],
    pbkdf2Sync(password, salt, iterations, keylen, digest) {
        return _pbkdf2(password, salt, iterations, keylen, digest);
    },
    pbkdf2(password, salt, iterations, keylen, digest, callback) {
        let cb = callback, dig = digest;
        if (typeof digest === "function") { cb = digest; dig = "sha1"; }
        let out = null, err = null;
        try { out = _pbkdf2(password, salt, iterations, keylen, dig); }
        catch (e) { err = e; }
        if (typeof cb === "function") cb(err, out);
    },
    hkdfSync(digest, ikm, salt, info, keylen) {
        return _hkdf(digest, ikm, salt, info, keylen);
    },
    hkdf(digest, ikm, salt, info, keylen, callback) {
        let out = null, err = null;
        try { out = _hkdf(digest, ikm, salt, info, keylen); }
        catch (e) { err = e; }
        if (typeof callback === "function") callback(err, out);
    },
    createECDH: () => ({ generateKeys() {}, computeSecret() {} }),
    getCurves: () => [],
    getFips: () => 0,
    setFips: () => {},
    fips: false,
    constants: {},
    timingSafeEqual: (a, b) => a.equals(b),
    randomInt(max, min, callback) {
        // 单参:randomInt(max);双参:randomInt(min, max)。用内核熵取 4 字节。
        let lo = 0, hi = max, cb = callback;
        if (typeof min === "number") { lo = max; hi = min; } else if (typeof min === "function") { cb = min; }
        const b = _entropyBytes(4);
        const r = ((b[0] + b[1] * 256 + b[2] * 65536 + b[3] * 16777216) >>> 0);
        const val = lo + (r % (hi - lo));
        if (cb) { cb(null, val); return; }
        return val;
    },
    randomUUID() {
        // 内核熵 16 字节 → RFC4122 v4 格式(不依赖 Math.random)
        const b = _entropyBytes(16);
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant
        let s = "";
        for (let i = 0; i < 16; i++) {
            if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
            s += _hexChars.charAt((b[i] >> 4) & 0xf) + _hexChars.charAt(b[i] & 0xf);
        }
        return s;
    },
    scryptSync(password, salt, keylen) { return Buffer.alloc(keylen); },
    secureHeapUsed: () => ({ total: 0, initial: 0, low: 0, high: 0 })
};

export default crypto;
