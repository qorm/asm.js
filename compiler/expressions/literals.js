// asm.js 编译器 - 字面量编译
// 编译各类字面量：数字、字符串、布尔值等

import { VReg } from "../../vm/registers.js";

// 将 JavaScript number 转换为 IEEE 754 double 的 64 位整数表示。
// 纯算术实现（不依赖 TypedArray 多视图别名）——自举编译器 gen1 里
// `new Uint8Array(buffer)` 不与 Float64Array 别名共享缓冲、且构造把 buffer 当长度，
// 导致原实现读字节全 0 → 数字全编成 0。对规格化 double 本算法精确：
// 归一化用 *2//2（2 的幂，无精度损失），尾数 = (value-1)*2^52 恰为整数。
function floatToInt64Bits(value) {
    if (value !== value) return 0x7ff0000000000001n; // 与 NaN 标识符同位;勿用 0x7ff8(int0 别名)
    if (value === 0) {
        // 区分 +0 / -0
        return (1 / value === -Infinity) ? 0x8000000000000000n : 0n;
    }
    let sign = 0n;
    if (value < 0) { sign = 0x8000000000000000n; value = -value; }
    if (value === Infinity) return sign | 0x7ff0000000000000n;

    // 归一化：value = m * 2^e, 1 <= m < 2
    // [#25] 指数护栏:真实 double 至多 ~1074 次缩放;越界即病理输入
    // (gen1 语义下 NaN 位≡int 0 装箱,===0 按位假、<1 按值真,*2 塌成真 0
    // 后永不退出——0/0 常量折叠挂死根因)。越界按 0/Inf 兜底,双语义终止。
    let e = 0;
    while (value >= 2) { value = value / 2; e = e + 1; if (e > 1100) return sign | 0x7ff0000000000000n; }
    while (value < 1) { value = value * 2; e = e - 1; if (e < -1100) return sign; }

    let biasedExp = e + 1023;
    if (biasedExp >= 2047) return sign | 0x7ff0000000000000n; // 溢出 Infinity
    if (biasedExp <= 0) {
        // Subnormal payload = original * 2^1074. `value` is the normalized
        // mantissa and original=value*2^e, leaving an exact power-of-two scale.
        let sub = value;
        let shift = e + 1074;
        while (shift > 0) { sub = sub * 2; shift = shift - 1; }
        return sign | BigInt(Math.round(sub));
    }

    // 尾数 52 位：(value-1)*2^52 对规格化 double 恰为整数（无舍入）
    let frac = value - 1;
    let mantNum = Math.round(frac * 4503599627370496); // 2^52
    let mant = BigInt(mantNum);
    if (mant > 4503599627370495n) { // 2^52-1，舍入进位溢出
        mant = 0n;
        biasedExp = biasedExp + 1;
        if (biasedExp >= 2047) return sign | 0x7ff0000000000000n;
    }
    return sign | (BigInt(biasedExp) << 52n) | mant;
}

// 获取数值的 IEEE 754 float64 位模式（供外部使用）
export function getFloat64Bits(value) {
    return floatToInt64Bits(value);
}

// Lexer string literals are stored as byte-preserving UTF-8 strings so the
// native and self-hosted compilers emit identical bytes.  Before asking the
// host to parse a known StringNumericLiteral, map ECMAScript's Unicode white
// space (whether represented as a real code unit or its UTF-8 byte sequence)
// to ASCII space.  Internal spaces still make the numeric literal invalid;
// only the host Number parser performs the actual grammar/rounding work.
export function parseStringNumericLiteral(value) {
    var out = "";
    for (var i = 0; i < value.length; i++) {
        var c = value.charCodeAt(i);
        var isSingle = c === 0x00A0 || c === 0x1680 ||
            (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 ||
            c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
        if (isSingle) { out = out + " "; continue; }
        var c1 = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
        var c2 = i + 2 < value.length ? value.charCodeAt(i + 2) : -1;
        if (c === 0xC2 && c1 === 0xA0) { out = out + " "; i = i + 1; continue; }
        if (c === 0xE1 && c1 === 0x9A && c2 === 0x80) { out = out + " "; i = i + 2; continue; }
        if (c === 0xE2 && c1 === 0x80 &&
            ((c2 >= 0x80 && c2 <= 0x8A) || c2 === 0xA8 || c2 === 0xA9 || c2 === 0xAF)) {
            out = out + " "; i = i + 2; continue;
        }
        if (c === 0xE2 && c1 === 0x81 && c2 === 0x9F) { out = out + " "; i = i + 2; continue; }
        if (c === 0xE3 && c1 === 0x80 && c2 === 0x80) { out = out + " "; i = i + 2; continue; }
        if (c === 0xEF && c1 === 0xBB && c2 === 0xBF) { out = out + " "; i = i + 2; continue; }
        out = out + value.charAt(i);
    }
    return Number(out);
}

// 直接从 bits 创建数字字面量（用于常量折叠等优化）
export function compileNumericLiteralWithBits(value, bits, asm, vm) {
    // 立即数装入，避免数据池 lea+load/_float_* adrp
    vm.movImm64(VReg.RET, bits);
}

// 字面量编译方法混入
export const LiteralCompiler = {
    // 编译字面量
    compileLiteral(expr) {
        let value = expr.value;
        if (typeof value === "number") {
            // JavaScript 所有数字都是 IEEE 754 double
            // 统一使用浮点表示，以确保 _print_float 等函数能正确工作
            this.compileNumericLiteral(value);
        } else if (typeof value === "string") {
            this.compileStringValue(value);
        } else if (typeof value === "boolean") {
            // 使用 NaN-boxing 格式的布尔值
            this.vm.movImm64(VReg.RET, value ? 0x7ff9000000000001n : 0x7ff9000000000000n);
        } else if (value === null) {
            // 使用 NaN-boxing 格式的 null
            this.vm.movImm64(VReg.RET, 0x7ffa000000000000n); // was lea+load _js const
        } else if (value === undefined) {
            // 使用 NaN-boxing 格式的 undefined
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
        } else if (typeof value === "bigint") {
            // BigInt 字面量：把 64 位值装入寄存器再装箱为堆 BigInt。
            // 编译期（gen0）已有真 BigInt，movImm64 直接拆分发射 movz/movk。
            // 截断到 64 位（自举编译器的 BigInt 常量均 ≤64 位）。
            const v64 = value & 0xffffffffffffffffn;
            this.vm.movImm64(VReg.A0, v64);
            this.vm.call("_bigint_box");
        } else {
            this.vm.movImm(VReg.RET, 0);
        }
    },

    // 编译数字字面量（直接使用 IEEE 754 double 格式）
    // 在 NaN-boxing 系统中，纯 double 值直接作为 64 位值存储
    compileNumericLiteral(value) {
        this.vm.movImm64(VReg.RET, floatToInt64Bits(value));
    },

    // 编译整数字面量（用于 int 类型上下文，无头部）
    compileIntLiteral(value) {
        this.vm.movImm(VReg.RET, Math.trunc(value));
    },

    // 编译原始数字值（不带头部，用于内部优化）
    compileRawNumericLiteral(value) {
        this.vm.movImm64(VReg.RET, floatToInt64Bits(value));
    },

    // 编译字符串字面量
    compileStringLiteral(expr) {
        this.compileStringValue(expr.value);
    },

    // 编译字符串值
    compileStringValue(str) {
        const label = this.asm.addString(str);
        // 数据段是 C 串:_strlen 扫到 NUL 即停。含嵌入 0 字节的字面量
        // (如 "\u0000")必须拷进带 length 头的堆串,否则 /\x00/.exec("\u0000") 对空输入。
        // 用 charCodeAt===0 探测，显式区分嵌入 NUL 与普通 C 串终止符。
        let hasNul = false;
        for (let ni = 0; ni < str.length; ni = ni + 1) {
            if (str.charCodeAt(ni) === 0) { hasNul = true; break; }
        }
        if (hasNul) {
            this.vm.lea(VReg.A0, label);
            this.vm.movImm(VReg.A1, str.length);
            this.vm.call("_nstr_to_heap_str");
            return;
        }
        this.vm.lea(VReg.RET, label);
        // [m120] 出线打 STRING_TAG(见 _tag_str_r),免每站 movImm64 大立即数
        this.vm.call("_tag_str_r");
    },

    // 编译模板字符串
    compileTemplateLiteral(expr) {
        const quasis = expr.quasis || [];
        const expressions = expr.expressions || [];

        // 简单情况：没有表达式，只有静态字符串
        if (quasis.length === 1 && expressions.length === 0) {
            this.compileStringValue(quasis[0].value.cooked || quasis[0].value.raw);
            return;
        }

        // 复杂情况：有表达式需要插值
        // 从第一个 quasi 开始构建结果字符串
        if (quasis.length > 0) {
            this.compileStringValue(quasis[0].value.cooked || quasis[0].value.raw);
        } else {
            // 空字符串
            this.compileStringValue("");
        }

        // 交替连接表达式和后续的 quasi。
        // 累加器存 FP 局部而非 push——这样插值表达式在「干净的栈」上编译，
        // 避免像成员自增 `${this.n++}`（内部用 SP 相对存取）在已 push 累加器的
        // 栈上运行时错位野写 _object_set(NULL)。
        for (let i = 0; i < expressions.length; i++) {
            const accSlot = this.ctx.allocLocal(`__tmpl_acc_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, accSlot, VReg.RET);

            // 编译表达式并转换为字符串（栈干净）
            this.compileExpressionToString(expressions[i]);
            this.vm.mov(VReg.A1, VReg.RET);
            this.vm.load(VReg.A0, VReg.FP, accSlot);
            this.vm.call("_strconcat");

            // 如果有下一个 quasi 且不为空，继续连接
            if (i + 1 < quasis.length) {
                const nextQuasi = quasis[i + 1].value.cooked || quasis[i + 1].value.raw;
                if (nextQuasi.length > 0) {
                    const accSlot2 = this.ctx.allocLocal(`__tmpl_acc2_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, accSlot2, VReg.RET);
                    this.compileStringValue(nextQuasi);
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, accSlot2);
                    this.vm.call("_strconcat");
                }
            }
        }
    },
};
