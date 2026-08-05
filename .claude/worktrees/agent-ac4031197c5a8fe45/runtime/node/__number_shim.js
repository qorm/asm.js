// asm.js Runtime - Number 格式化 shim(toExponential / toPrecision)
// codegen 把 n.toExponential(f)/n.toPrecision(p) 改派成 __NUM_* 调用(机理同 JSON shim)。
// 纯 JS 实现,借 Math.log10/pow 定位指数、toFixed 做四舍五入,匹配 node 输出。

function _pow10(n) { return Math.pow(10, n); }

export function __NUM_toExponential(v, f) {
    v = Number(v);
    if (v !== v) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    const neg = v < 0;
    let a = neg ? -v : v;
    let exp = 0;
    let mant = a;
    if (a !== 0) {
        exp = Math.floor(Math.log10(a));
        mant = a / _pow10(exp);
        // log10 浮点误差:把尾数归一到 [1,10)
        if (mant >= 10) { mant = mant / 10; exp = exp + 1; }
        else if (mant < 1) { mant = mant * 10; exp = exp - 1; }
    }
    let mantStr;
    if (f === undefined || f === null) {
        mantStr = "" + mant; // 无参:近似最短(asm.js 数字打印为定长)
    } else {
        f = f | 0;
        mantStr = mant.toFixed(f);
        if (Number(mantStr) >= 10) { exp = exp + 1; mant = mant / 10; mantStr = mant.toFixed(f); }
    }
    const eabs = exp < 0 ? -exp : exp;
    return (neg ? "-" : "") + mantStr + "e" + (exp < 0 ? "-" : "+") + eabs;
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
    v = Number(v);
    if (p === undefined || p === null) return "" + v; // 无参 = toString
    p = p | 0;
    if (v !== v) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    const neg = v < 0;
    let a = neg ? -v : v;
    if (a === 0) {
        if (p <= 1) return "0";
        let s = "0.";
        for (let i = 0; i < p - 1; i++) s = s + "0";
        return s;
    }
    let e = Math.floor(Math.log10(a));
    // 校正 log10 浮点误差,使 10^e <= a < 10^(e+1)
    if (_pow10(e) > a) e = e - 1;
    if (_pow10(e + 1) <= a) e = e + 1;
    let out;
    if (e < -6 || e >= p) {
        out = __NUM_toExponential(a, p - 1);
    } else {
        let dec = p - 1 - e;
        if (dec < 0) dec = 0;
        out = a.toFixed(dec);
    }
    return (neg ? "-" : "") + out;
}
