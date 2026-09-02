// asm.js Runtime - Number 格式化 shim(toExponential / toPrecision)
// codegen 把 n.toExponential(f)/n.toPrecision(p) 改派成 __NUM_* 调用(机理同 JSON shim)。
// 纯 JS 实现,借 Math.log10/pow 定位指数、toFixed 做四舍五入,匹配 node 输出。

function _pow10(n) { return Math.pow(10, n); }

// Exact finite-double decimal expansion.  A binary64 value is M * 2^E.  For
// E < 0, M / 2^-E = M * 5^-E / 10^-E, so a small base-10 bignum is enough to
// recover every decimal digit without first rounding through `x / 10^k` or
// the int64-based runtime toFixed implementation.  Limbs are base 10^7 so all
// intermediate products stay exactly representable as JavaScript numbers.
function _decimalMulSmall(a, m) {
    const base = 10000000;
    var carry = 0;
    for (var i = 0; i < a.length; i++) {
        var n = a[i] * m + carry;
        a[i] = n % base;
        carry = Math.floor(n / base);
    }
    while (carry > 0) {
        a.push(carry % base);
        carry = Math.floor(carry / base);
    }
}

function _decimalDigits(a) {
    var s = "" + a[a.length - 1];
    for (var i = a.length - 2; i >= 0; i--) {
        var p = "" + a[i];
        for (var z = p.length; z < 7; z++) s = s + "0";
        s = s + p;
    }
    return s;
}

function _exactDecimal(v) {
    // v is finite and strictly positive here.  Multiplication/division by two
    // is exact for binary64, including the subnormal normalization loop.
    var x = v;
    var e = 0;
    while (x >= 2) { x = x / 2; e = e + 1; }
    while (x < 1) { x = x * 2; e = e - 1; }
    var m = Math.round(x * 4503599627370496); // 2^52; exact integer <= 2^53
    var e2 = e - 52;
    const base = 10000000;
    var limbs = [];
    while (m > 0) {
        var q = Math.floor(m / base);
        limbs.push(m - q * base);
        m = q;
    }
    var scale = 0;
    if (e2 >= 0) {
        for (var i = 0; i < e2; i++) _decimalMulSmall(limbs, 2);
    } else {
        scale = -e2;
        for (var j = 0; j < scale; j++) _decimalMulSmall(limbs, 5);
    }
    return [_decimalDigits(limbs), scale];
}

function _incrementDigits(s) {
    var out = "";
    var carry = 1;
    for (var i = s.length - 1; i >= 0; i--) {
        var d = s.charCodeAt(i) - 48 + carry;
        if (d >= 10) { d = d - 10; carry = 1; }
        else carry = 0;
        out = String.fromCharCode(48 + d) + out;
    }
    if (carry !== 0) out = "1" + out;
    return out;
}

// Return exactly p rounded significant digits and the base-10 exponent of the
// first digit.  ECMAScript breaks an exact halfway tie by choosing the larger
// decimal integer, hence a discarded prefix of 5 is always rounded upward.
function _roundedSignificant(v, p) {
    var exact = _exactDecimal(v);
    var all = exact[0];
    var exp = all.length - exact[1] - 1;
    var digits;
    if (all.length <= p) {
        digits = all;
        while (digits.length < p) digits = digits + "0";
    } else {
        digits = all.slice(0, p);
        if (all.charCodeAt(p) >= 53) {
            digits = _incrementDigits(digits);
            if (digits.length > p) {
                exp = exp + 1;
                digits = digits.slice(0, p);
            }
        }
    }
    return [digits, exp];
}

function _formatExponential(neg, digits, exp) {
    var mant = digits.charAt(0);
    if (digits.length > 1) mant = mant + "." + digits.slice(1);
    var eabs = exp < 0 ? -exp : exp;
    return (neg ? "-" : "") + mant + "e" + (exp < 0 ? "-" : "+") + eabs;
}

function _thisNumberValue(v, method) {
    if (typeof v === "number") return v;
    if (v === Number.prototype || v instanceof Number) return Number(v);
    throw new TypeError("Number.prototype." + method + " requires that 'this' be a Number");
}

function _toIntegerArgument(v) {
    var n = Number(v);
    if (n !== n || n === 0) return 0;
    if (n === Infinity || n === -Infinity) return n;
    return n < 0 ? Math.ceil(n) : Math.floor(n);
}

function _shortestExponential(v, neg) {
    var s = "" + v;
    var ep = s.indexOf("e");
    if (ep >= 0) {
        var ds = s.slice(0, ep);
        var dot = ds.indexOf(".");
        if (dot >= 0) ds = ds.slice(0, dot) + ds.slice(dot + 1);
        while (ds.length > 1 && ds.charAt(ds.length - 1) === "0") ds = ds.slice(0, ds.length - 1);
        return _formatExponential(neg, ds, Number(s.slice(ep + 1)));
    }
    var dp = s.indexOf(".");
    if (dp < 0) {
        var ids = s;
        while (ids.length > 1 && ids.charAt(ids.length - 1) === "0") ids = ids.slice(0, ids.length - 1);
        return _formatExponential(neg, ids, s.length - 1);
    }
    if (s.charAt(0) !== "0") {
        return _formatExponential(neg, s.slice(0, dp) + s.slice(dp + 1), dp - 1);
    }
    var first = 2;
    while (first < s.length && s.charAt(first) === "0") first = first + 1;
    return _formatExponential(neg, s.slice(first), 1 - first);
}

export function __NUM_toExponential(v, f) {
    v = _thisNumberValue(v, "toExponential");
    var fWasUndefined = f === undefined;
    var fd = fWasUndefined ? 0 : _toIntegerArgument(f);
    if (v !== v) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    if (!fWasUndefined && (fd < 0 || fd > 100)) {
        throw new RangeError("toExponential() argument must be between 0 and 100");
    }
    // The specification tests x < 0, so -0 has no sign in the result.
    const neg = v < 0;
    var a = neg ? -v : v;
    // leftover-arg leftover null is ToInteger(null)=0, not leftover
    // undefined auto-precision. official tointeger-fractiondigits
    // (123.456).toExponential(null) leftover "1.23456e+2" vs "1e+2".
    // leftover-arg 0-arg / leftover undefined still auto.
    if (fWasUndefined) return _shortestExponential(a, neg);
    f = fd;
    if (a === 0) {
        var zeroDigits = "0";
        for (var zi = 0; zi < f; zi++) zeroDigits = zeroDigits + "0";
        return _formatExponential(false, zeroDigits, 0);
    }
    var rounded = _roundedSignificant(a, f + 1);
    return _formatExponential(neg, rounded[0], rounded[1]);
}

export function __NUM_toFixed(v, f) {
    v = _thisNumberValue(v, "toFixed");
    var fd = f === undefined ? 0 : _toIntegerArgument(f);
    if (fd < 0 || fd > 100) {
        throw new RangeError("toFixed() digits argument must be between 0 and 100");
    }
    if (v !== v) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    if (v >= 1000000000000000000000 || v <= -1000000000000000000000) return "" + v;

    const neg = v < 0;
    var a = neg ? -v : v;
    var integerDigits;
    if (a === 0) {
        integerDigits = "0";
    } else {
        var exact = _exactDecimal(a);
        var all = exact[0];
        // round(N * 10^(fd-scale)); keep is the count retained from N.
        var keep = all.length - exact[1] + fd;
        if (keep < 0) {
            integerDigits = "0";
        } else if (keep === 0) {
            integerDigits = all.charCodeAt(0) >= 53 ? "1" : "0";
        } else if (keep >= all.length) {
            integerDigits = all;
            while (integerDigits.length < keep) integerDigits = integerDigits + "0";
        } else {
            integerDigits = all.slice(0, keep);
            if (all.charCodeAt(keep) >= 53) integerDigits = _incrementDigits(integerDigits);
        }
    }
    while (integerDigits.length <= fd) integerDigits = "0" + integerDigits;
    var out;
    if (fd === 0) out = integerDigits;
    else {
        var point = integerDigits.length - fd;
        out = integerDigits.slice(0, point) + "." + integerDigits.slice(point);
    }
    return (neg ? "-" : "") + out;
}

// n.toLocaleString():默认 en-US 数字格式 —— 整数部分每 3 位加千分位逗号,
// 小数最多 3 位(四舍五入后去尾随 0)。匹配 node 默认 locale 的常见输出。
// codegen 仅对**静态可判为数字**的接收者改派到这里(inferType===NUMBER),
// Date/数组/未知接收者不改派(避免误劫持非数字的 toLocaleString)。
export function __NUM_toLocaleString(v) {
    v = Number(v);
    if (v !== v) return "NaN";
    // [layout-determinism] U+221E (∞) 用 fromCharCode 构造,避免源码内非 ASCII 串字面量:
    // asm.js 词法按字节读输入(不解 UTF-8),含非 ASCII 的串字面量在 node/asm.js 产不同字节
    // (双重 UTF-8 编码)→ 自举 g1≠g2。fromCharCode(8734) 无 interned 串字面量 → 确定性。
    if (v === Infinity) return String.fromCharCode(8734);
    if (v === -Infinity) return "-" + String.fromCharCode(8734);
    // -0 → "-0"(node 语义);普通 0 → "0"
    let neg;
    if (v === 0) neg = (1 / v) < 0;
    else neg = v < 0;
    let a = neg ? -v : v;
    // 四舍五入到最多 3 位小数,再拆整数/小数部分
    let s = a.toFixed(3);
    let dot = s.indexOf(".");
    let intPart = dot === -1 ? s : s.slice(0, dot);
    let fracPart = dot === -1 ? "" : s.slice(dot + 1);
    // 去小数尾随 0
    while (fracPart.length > 0 && fracPart.charAt(fracPart.length - 1) === "0") {
        fracPart = fracPart.slice(0, fracPart.length - 1);
    }
    // 整数部分加千分位
    let grouped = "";
    let cnt = 0;
    for (let i = intPart.length - 1; i >= 0; i--) {
        grouped = intPart.charAt(i) + grouped;
        cnt = cnt + 1;
        if (cnt % 3 === 0 && i > 0) grouped = "," + grouped;
    }
    let out = grouped;
    if (fracPart.length > 0) out = out + "." + fracPart;
    return (neg ? "-" : "") + out;
}

export function __NUM_toPrecision(v, p) {
    // leftover-arg thisNumberValue TypeError. official this-type-not-number
    // leftover Number() coerce "NaN"/"1" vs TypeError (leftover-arg extract
    // injects shim; leftover-boolean boxing leftover ToNumber vs TypeError).
    // leftover-number boxing Number wrapper still unbox.
    v = _thisNumberValue(v, "toPrecision");
    if (p === undefined) return "" + v;
    p = _toIntegerArgument(p);
    // leftover Inf/NaN this after ToInteger, before range (spec 4 / 7).
    // NaN.toPrecision(0|Infinity) / Infinity.toPrecision(1000) leftover RangeError vs "NaN"/"Infinity".
    if (v !== v) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    // RangeError: precision must be in [1, 100] (ES 21.1.3.7 step 8)
    if (p < 1 || p > 100) {
        throw new RangeError("toPrecision() argument must be between 1 and 100");
    }
    // Spec step 7: If x < 0. IEEE -0 is not < 0, so (-0).toPrecision(p)
    // is "0" / "0.0…" (not "-0"). ToString(-0) stays on the no-arg path.
    const neg = v < 0;
    var a = neg ? -v : v;
    if (a === 0) {
        if (p === 1) return "0";
        var s = "0.";
        for (var i = 0; i < p - 1; i++) s = s + "0";
        return s;
    }
    var rounded = _roundedSignificant(a, p);
    var digits = rounded[0];
    var e = rounded[1];
    var out;
    if (e < -6 || e >= p) {
        out = _formatExponential(false, digits, e);
    } else {
        var point = e + 1;
        if (point <= 0) {
            out = "0.";
            for (var z = 0; z < -point; z++) out = out + "0";
            out = out + digits;
        } else if (point >= digits.length) {
            out = digits;
            for (var z2 = digits.length; z2 < point; z2++) out = out + "0";
        } else {
            out = digits.slice(0, point) + "." + digits.slice(point);
        }
    }
    return (neg ? "-" : "") + out;
}
