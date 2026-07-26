// asm.js 编译器 - 运算符编译
// 编译二元运算、一元运算、逻辑运算等

import { VReg } from "../../vm/index.js";
import { Type, inferType, isIntType, isFloatType } from "../core/types.js";

const TYPE_FLOAT64 = 29;
const TYPE_NUMBER = 13;

// 将 JavaScript number 转换为 IEEE 754 double 的 64 位整数表示。
// 纯算术实现（不用 ArrayBuffer/Float64Array/BigInt64Array 别名视图）——自举 gen1 里
// 类型化数组别名不共享缓冲，原实现读位全 0/崩 → 负数字面量常量折叠(-1/-808 等)编译即崩。
// 与 literals.js 同实现。
function floatToInt64Bits(value) {
    if (value !== value) return 0x7ff8000000000000n; // NaN
    if (value === 0) {
        return (1 / value === -Infinity) ? 0x8000000000000000n : 0n; // 区分 +0/-0
    }
    let sign = 0n;
    if (value < 0) { sign = 0x8000000000000000n; value = -value; }
    if (value === Infinity) return sign | 0x7ff0000000000000n;
    let e = 0;
    while (value >= 2) { value = value / 2; e = e + 1; if (e > 1100) return sign | 0x7ff0000000000000n; }
    while (value < 1) { value = value * 2; e = e - 1; if (e < -1100) return sign; } // [#25] 护栏,同 literals.js
    let biasedExp = e + 1023;
    if (biasedExp >= 2047) return sign | 0x7ff0000000000000n;
    if (biasedExp <= 0) return sign;
    let frac = value - 1;
    let mantNum = Math.round(frac * 4503599627370496); // 2^52
    let mant = BigInt(mantNum);
    if (mant > 4503599627370495n) {
        mant = 0n;
        biasedExp = biasedExp + 1;
        if (biasedExp >= 2047) return sign | 0x7ff0000000000000n;
    }
    return sign | (BigInt(biasedExp) << 52n) | mant;
}

// 正确的 float64 取反：通过翻转符号位
function negateFloat64Bits(bits) {
    return bits ^ 0x8000000000000000n;
}

// 运算符编译方法混入
export const OperatorCompiler = {
    // 从 Number 对象中解包数值到寄存器
    // 输入: reg 包含 Number 对象指针
    // 输出: reg 包含 float64 位模式
    // 注：TYPE_NUMBER 和 TYPE_FLOAT64 的 offset 8 都是 float64 位模式
    // 注意：reg 可能是 block 指针或 user_ptr (block + 16)
    //     - 如果是 block 指针：从 reg + 8 加载
    //     - 如果是 user_ptr：从 reg - 8 加载
    unboxNumber(reg) {
        // 数字对象既可能以 block_ptr 形式出现，也可能以 user_ptr
        // (block + 16) 形式出现。旧逻辑通过 heap_base+0x1000 猜测
        // user_ptr，会把早期分配的 Number 对象误判成 block_ptr。
        // 这里改成直接检查对象头 type。
        const checkBlockLabel = this.ctx.newLabel("unbox_check_block");
        const isBlockLabel = this.ctx.newLabel("unbox_block");
        const isUserPtrLabel = this.ctx.newLabel("unbox_userptr");
        const notNumberLabel = this.ctx.newLabel("unbox_not_number");
        const doneLabel = this.ctx.newLabel("unbox_done");

        // 保存原始值
        this.vm.mov(VReg.V1, reg);

        // 检查是否在堆范围内：heap_base <= reg < heap_ptr
        this.vm.lea(VReg.V2, "_heap_base");
        this.vm.load(VReg.V2, VReg.V2, 0);
        this.vm.cmp(reg, VReg.V2);
        this.vm.jlt(doneLabel); // < heap_base，raw value，不需要 unbox

        this.vm.lea(VReg.V2, "_heap_ptr");
        this.vm.load(VReg.V2, VReg.V2, 0);
        this.vm.cmp(reg, VReg.V2);
        this.vm.jge(doneLabel); // >= heap_ptr，不是 user_ptr，raw value

        // 优先按 user_ptr 尝试：如果 reg - 16 位置的 type 是 Number，
        // 那它就是 user_ptr，value 位于 reg - 8。
        this.vm.lea(VReg.V2, "_heap_base");
        this.vm.load(VReg.V2, VReg.V2, 0);
        this.vm.addImm(VReg.V0, VReg.V2, 16);
        this.vm.cmp(VReg.V1, VReg.V0);
        this.vm.jlt(checkBlockLabel);
        this.vm.subImm(VReg.V0, VReg.V1, 16);
        this.vm.load(VReg.V3, VReg.V0, 0);
        this.vm.cmpImm(VReg.V3, TYPE_NUMBER);
        this.vm.jeq(isUserPtrLabel);
        this.vm.cmpImm(VReg.V3, TYPE_FLOAT64);
        this.vm.jeq(isUserPtrLabel);

        // 再按 block_ptr 检查：如果 reg + 0 的 type 是 Number，
        // value 位于 reg + 8。
        this.vm.label(checkBlockLabel);
        this.vm.load(VReg.V3, VReg.V1, 0);
        this.vm.cmpImm(VReg.V3, TYPE_NUMBER);
        this.vm.jeq(isBlockLabel);
        this.vm.cmpImm(VReg.V3, TYPE_FLOAT64);
        this.vm.jeq(isBlockLabel);
        this.vm.jmp(notNumberLabel);

        this.vm.label(isBlockLabel);
        this.vm.load(reg, VReg.V1, 8);
        this.vm.jmp(doneLabel);

        this.vm.label(isUserPtrLabel);
        this.vm.subImm(VReg.V0, VReg.V1, 8);
        this.vm.load(reg, VReg.V0, 0);
        this.vm.jmp(doneLabel);

        // 堆对象但不是 Number：按 JS ToNumber 的简化语义回退成 NaN，
        // 避免把裸指针当成 float 位模式继续传播。
        this.vm.label(notNumberLabel);
        this.vm.movImm64(reg, 0x7ff8000000000000n);

        this.vm.label(doneLabel);
    },

    // 将 float64 位模式包装成 Number 对象
    // 输入: valueReg 包含 float64 位模式
    // 输出: RET 包含 Number 对象指针
    boxNumber(valueReg) {
        // 保存值到 S0（因为 _alloc 会改变 caller-saved 寄存器）
        this.vm.mov(VReg.S0, valueReg);

        // 分配 16 字节
        this.vm.movImm(VReg.A0, 16);
        this.vm.call("_alloc");
        // RET 现在是用户数据指针 (block + 16)

        // 获取 block 指针：RET = user_ptr - 16 = block
        this.vm.subImm(VReg.RET, VReg.RET, 16);

        // 写入类型标记和值到 block 指针
        this.vm.movImm(VReg.V1, TYPE_FLOAT64);
        this.vm.store(VReg.RET, 0, VReg.V1);   // type at block+0
        this.vm.store(VReg.RET, 8, VReg.S0);   // value at block+8

        // 恢复 RET 为用户数据指针 (block + 16)
        this.vm.addImm(VReg.RET, VReg.RET, 16);
    },

    // 将 int64（寄存器中的整数值）按 JS Number 语义装箱成 Number 对象
    // 输入: intReg 包含 int64 整数值
    // 输出: RET 包含 Number 对象指针（user_ptr = block + 16，用于 _print_value 等）
    // 说明：内部会覆盖 intReg 的值
    boxIntAsNumber(intReg) {
        // 整数按 JS Number 语义返回**裸 float64 位**（与数字字面量、算术结果一致）。
        // 此前装箱成堆 Number 对象，令 indexOf/length 等返回堆指针，`idx === 1` 恒 false、
        // 表示不一致。裸浮点位（高16<0x7FF8 被 NaN-boxing 当 double）令 ===/+/显示全对。
        this.vm.scvtf(0, intReg);       // 有符号整数 → 浮点
        this.vm.fmovToInt(VReg.RET, 0);  // 浮点位模式 → RET
    },

    // 将 int64（寄存器中的整数值）转换为 float64 位模式（不装箱）
    // 输入: intReg 包含 int64 整数值
    // 输出: intReg 变为 float64 位模式（仍在整数寄存器里）
    // 用途：算术运算前把整数字面量转换成浮点位模式
    intToFloat64Bits(intReg) {
        this.vm.scvtf(0, intReg);
        this.vm.fmovToInt(intReg, 0);
    },

    // 将浮点寄存器 fpIndex 中的结果按 JS Number 语义装箱成 Number 对象
    // 输入: fpIndex (0/1/...) 指定 FP 寄存器
    // 输出: RET 为 Number 对象指针
    // 使用 fmovToInt 复制 float 位模式（不转换），然后用 boxNumber 存储
    boxFPAsNumber(fpIndex = 0) {
        // fmovToInt 将 FP 寄存器的位模式复制到整数寄存器（不转换）
        // 例如: fmovToInt x0, d0 将 d0 的 IEEE 754 位模式原样复制到 x0
        this.vm.fmovToInt(VReg.RET, fpIndex);
        this.boxNumber(VReg.RET);
    },

    // 将 Number 对象转换为整数（用于数组下标等）
    // 输入: srcReg 为 Number 对象指针
    // 输出: destReg 为 int64 整数值
    numberToInt(destReg, srcReg) {
        this.vm.f2i(destReg, srcReg);
    },

    // in-place 版本：直接把 reg 的 Number 对象转换为 int64
    numberToIntInPlace(reg) {
        this.vm.f2i(reg, reg);
    },

    // 检测表达式是否为整数类型
    isIntExpression(expr) {
        const type = inferType(expr, this.ctx);
        return isIntType(type);
    },

    // 编译表达式作为整数（用于 int 类型上下文）
    compileExpressionAsInt(expr) {
        // 对于整数字面量，直接使用整数值
        if ((expr.type === "Literal" || expr.type === "NumericLiteral") && typeof expr.value === "number") {
            this.compileIntLiteral(expr.value);
            return;
        }
        // [解箱①] 裸 int 驻留变量:slot 已是裸 int,直接 load,免 _to_int32 调用
        if (expr.type === "Identifier" && this.ctx.isRawIntVar(expr.name)) {
            const off = this.ctx.getLocal(expr.name);
            if (off) { this.vm.load(VReg.RET, VReg.FP, off); return; }
        }
        // 对于二元表达式，递归处理
        if (expr.type === "BinaryExpression") {
            const op = expr.operator;
            if (["+", "-", "*", "/", "%"].includes(op)) {
                this.compileExpressionAsInt(expr.right);
                this.vm.push(VReg.RET);
                this.compileExpressionAsInt(expr.left);
                this.vm.pop(VReg.V1);

                switch (op) {
                    case "+":
                        this.vm.add(VReg.RET, VReg.RET, VReg.V1);
                        break;
                    case "-":
                        this.vm.sub(VReg.RET, VReg.RET, VReg.V1);
                        break;
                    case "*":
                        this.vm.mul(VReg.RET, VReg.RET, VReg.V1);
                        break;
                    case "/":
                        this.vm.div(VReg.RET, VReg.RET, VReg.V1);
                        break;
                    case "%":
                        this.vm.mod(VReg.RET, VReg.RET, VReg.V1);
                        break;
                }
                return;
            }
        }
        // 其他情况正常编译后归一化为裸 int32。此前直接留浮点位模式,非字面量索引
        // (变量 / -1 这类 UnaryExpression)被当整数用 → arr.at(-1)/slice(-2) 等把 float
        // 位当下标读 → 越界返 undefined。_to_int32 对装箱 int 与裸 float 均正确转裸有符号 int。
        this.compileExpression(expr);
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_int32");
    },

    // 编译二元表达式
    compileBinaryExpression(expr) {
        const op = expr.operator;

        // 常量折叠：两个字面量运算在编译时计算
        const leftLit = expr.left.type === "Literal" || expr.left.type === "NumericLiteral";
        const rightLit = expr.right.type === "Literal" || expr.right.type === "NumericLiteral";
        if (leftLit && rightLit && typeof expr.left.value === "number" && typeof expr.right.value === "number") {
            let result;
            const a = expr.left.value;
            const b = expr.right.value;
            switch (op) {
                case "+":
                    result = a + b;
                    break;
                case "-":
                    result = a - b;
                    break;
                case "*":
                    result = a * b;
                    break;
                case "/":
                    result = a / b;
                    break;
                case "%":
                    result = a % b;
                    break;
                case "<":
                    result = a < b;
                    break;
                case "<=":
                    result = a <= b;
                    break;
                case ">":
                    result = a > b;
                    break;
                case ">=":
                    result = a >= b;
                    break;
                case "==":
                    result = a == b;
                    break;
                case "===":
                    result = a === b;
                    break;
                case "!=":
                    result = a != b;
                    break;
                case "!==":
                    result = a !== b;
                    break;
                case "**":
                    result = a ** b;
                    break;
                default:
                    result = null;
            }
            // [#25] 非有限结果(NaN/±Inf)不折叠:NaN 与 NaN-boxing 冲突,且自举侧
            // 字面量发射对非有限值发散(gen1 编译含 0/0 的源码挂死)。留给运行时
            // 算术路径产生正确位模式。检测用 result-result!==0(NaN/±Inf 均真;
            // 不能用 ===Infinity——Infinity 标识符在 asm.js 里编译为 0)。
            if (result !== null && typeof result === "number" &&
                (result !== result || result - result !== 0 ||
                 (result !== 0 && result * 2 === 0))) {
                // 第三子句是 gen1 语义下的 NaN 判别:NaN 位≡int 0 装箱,
                // ===0 按位为假而数值坍缩为 0(node 下由前两子句覆盖,此式恒假)
                result = null;
            }
            if (result !== null) {
                if (typeof result === "boolean") {
                    // 返回 JS 布尔值 _js_true 或 _js_false
                    const boolLabel = result ? "_js_true" : "_js_false";
                    this.vm.lea(VReg.RET, boolLabel);
                    this.vm.load(VReg.RET, VReg.RET, 0);
                } else if (typeof result === "string") {
                    // 字符串折叠结果("" + 2.5 之类)按串字面量发射——曾误走
                    // compileNumericLiteral 把 "2.5" 编成数字 2.5(#15 实锤)
                    this.compileExpression({ type: "StringLiteral", value: result });
                } else {
                    this.compileNumericLiteral(result);
                }
                return;
            }
        }

        // [NaN 静态折叠] 算术运算中编译期可见的 NaN 操作数(undefined 字面量 / NaN 标识符)
        // 使结果恒 NaN。直接发打印友好 NaN 0x7ff0000000000001,**跳过 fadd/fmul/fdiv**——
        // 硬件浮点运算会把输入 NaN 规范成 qNaN 0x7ff8000000000000,与装箱 int0 位别名 →
        // 打印成 0、=== 错(见 nan-int0-alias-trap)。仅纯算术命中:`+` 另需两侧非 string/
        // array/object(那是拼接,undefined 参与拼接产 "undefined" 子串,不是 NaN)。
        const isStaticNaN = (e) =>
            (e && e.type === "Literal" && e.value === undefined) ||
            (e && e.type === "Identifier" && e.name === "NaN");
        if (["-", "*", "/", "%"].indexOf(op) >= 0 &&
            (isStaticNaN(expr.left) || isStaticNaN(expr.right))) {
            this.vm.movImm64(VReg.RET, 0x7ff0000000000001n);
            return;
        }

        // 字符串连接处理
        // 注意: JavaScript 的 + 运算符在以下情况进行字符串连接:
        // 1. 任一操作数是字符串
        // 2. 任一操作数是对象 (包括函数/闭包),需要 ToPrimitive 转换为字符串
        // 3. 任一操作数是复杂表达式 (CallExpression, MemberExpression) 返回 UNKNOWN
        // 注意: 简单变量 (Identifier) 即使类型是 UNKNOWN 也使用数值运算,
        // 因为局部变量通常是数值类型
        if (op === "+") {
            const leftType = inferType(expr.left, this.ctx);
            const rightType = inferType(expr.right, this.ctx);
            // 任一侧静态是字符串 → 定拼接,但**另一侧非数组/对象**时才走 compileStringConcat
            // (它不做 valueOf、且对混合组合有 bug)。数组/对象参与(即便另一侧是串,如
            // `{valueOf}+'x'` 应 "42x")一律移交运行时 _js_add 做完整 ToPrimitive(default)。
            const hasObjArr = leftType === Type.ARRAY || rightType === Type.ARRAY ||
                leftType === Type.OBJECT || rightType === Type.OBJECT;
            if ((leftType === Type.STRING || rightType === Type.STRING) && !hasObjArr) {
                this.compileStringConcat(expr);
                return;
            }
            // 非拼接的 `+` 里静态 NaN 操作数 → 结果 NaN(同上,跳过 fadd 规范化)
            if (isStaticNaN(expr.left) || isStaticNaN(expr.right)) {
                this.vm.movImm64(VReg.RET, 0x7ff0000000000001n);
                return;
            }
            // UNKNOWN 类型：编译期无法判断是数值加法还是字符串拼接，
            // 交给运行时 _js_add 动态分派（任一侧是字符串则 ToString+拼接，
            // 否则 _number_coerce 后浮点加法）。
            // BIGINT 也走 _js_add（内部双 _is_bigint → i64 加；否则回落）。
            // 否则 10n+5n 两侧静态 BIGINT 会绕过动态分派落浮点得 "0."。
            // ARRAY/OBJECT 也走 _js_add(其内 ToPrimitive:数组→逗号串、对象→valueOf/toString)。
            if (leftType === Type.UNKNOWN || rightType === Type.UNKNOWN ||
                leftType === Type.BIGINT || rightType === Type.BIGINT ||
                leftType === Type.ARRAY || rightType === Type.ARRAY ||
                leftType === Type.OBJECT || rightType === Type.OBJECT) {
                this.compileExpression(expr.left);
                this.vm.push(VReg.RET);
                this.compileExpression(expr.right);
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.pop(VReg.A0);
                this.vm.call("_js_add");
                return;
            }
        }

        // 位运算：交给运行时分派（任一侧 BigInt → 64 位运算返回 BigInt；否则 ToInt32
        // 32 位运算返回 int32）。必须在 compileOperandAsFloat 之前处理，否则 BigInt
        // 操作数会被转成 float 破坏。
        const bitwiseFns = { "&": "_js_band", "|": "_js_bor", "^": "_js_bxor",
            "<<": "_js_bshl", ">>": "_js_bshr", ">>>": "_js_bushr" };
        if (bitwiseFns[op]) {
            this.compileExpression(expr.right);
            this.vm.push(VReg.RET);
            this.compileExpression(expr.left);
            this.vm.mov(VReg.A0, VReg.RET); // left
            this.vm.pop(VReg.A1); // right
            this.vm.call(bitwiseFns[op]);
            return;
        }

        // BigInt 比较：任一侧静态可见 BigInt（字面量或推断 BIGINT）时介入，
        // 避免扰动普通数值/字符串比较的热路径。
        const isBigLit = (e) => e && e.type === "Literal" && typeof e.value === "bigint";
        const isBigOperand = (e) => isBigLit(e) || inferType(e, this.ctx) === Type.BIGINT;
        const cmpBig = { "===": "seq", "!==": "sne", "==": "aeq", "!=": "ane",
            "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };
        if (cmpBig[op] && (isBigOperand(expr.left) || isBigOperand(expr.right))) {
            this.compileExpression(expr.right);
            this.vm.push(VReg.RET);
            this.compileExpression(expr.left);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.pop(VReg.A1);
            const kind = cmpBig[op];
            const setTrue = () => { this.vm.lea(VReg.RET, "_js_true"); this.vm.load(VReg.RET, VReg.RET, 0); };
            const setFalse = () => { this.vm.lea(VReg.RET, "_js_false"); this.vm.load(VReg.RET, VReg.RET, 0); };
            // 与 _js_true 比对后取反（!==/!= 用）
            const negate = () => {
                const t = this.ctx.newLabel("bneg_t");
                const e2 = this.ctx.newLabel("bneg_e");
                this.vm.lea(VReg.V1, "_js_true"); this.vm.load(VReg.V1, VReg.V1, 0);
                this.vm.cmp(VReg.RET, VReg.V1);
                this.vm.jeq(t);
                setTrue(); this.vm.jmp(e2);
                this.vm.label(t); setFalse();
                this.vm.label(e2);
            };
            if (kind === "seq") {
                // === 严格：类型敏感（10n===10 → false），双 _is_bigint 守卫
                this.vm.call("_bigint_strict_eq");
            } else if (kind === "sne") {
                this.vm.call("_bigint_strict_eq"); negate();
            } else if (kind === "aeq") {
                // == 抽象：混型数值近似（1n==1 → true）
                this.vm.call("_abstract_eq");
            } else if (kind === "ane") {
                this.vm.call("_abstract_eq"); negate();
            } else {
                this.vm.call("_bigint_cmp"); // RET = -1/0/1（正 bigint 无符号；负 bigint 记偏差）
                const jmp = { "lt": "jlt", "le": "jle", "gt": "jgt", "ge": "jge" }[kind];
                this.vm.cmpImm(VReg.RET, 0);
                const t = this.ctx.newLabel("bcmp_t");
                const e2 = this.ctx.newLabel("bcmp_e");
                this.vm[jmp](t);
                setFalse(); this.vm.jmp(e2);
                this.vm.label(t); setTrue();
                this.vm.label(e2);
            }
            return;
        }

        // BigInt 算术 - * / % **：保守守卫——仅静态可见 bigint（字面量或推断 BIGINT）
        // 时编译两侧为 JSValue 调 _js_b*，普通数值零扰（定点命脉）。helper 内部双
        // _is_bigint 守卫，非 bigint 回落浮点。`+` 已走 _js_add 无需在此处理。
        const arithBig = { "-": "_js_bsub", "*": "_js_bmul", "/": "_js_bdiv", "%": "_js_bmod", "**": "_js_bpow" };
        if (arithBig[op] && (isBigOperand(expr.left) || isBigOperand(expr.right))) {
            this.compileExpression(expr.right);
            this.vm.push(VReg.RET);
            this.compileExpression(expr.left);
            this.vm.mov(VReg.A0, VReg.RET); // left
            this.vm.pop(VReg.A1); // right
            this.vm.call(arithBig[op]);
            return;
        }

        // 字符串关系比较(<,<=,>,>=):任一操作数静态类型为 STRING → 走抽象关系比较
        // helper(内部按运行时 tag 判两侧是否都串:都串走字节词典序 _strcmp,否则 ToNumber
        // 数值比较,故语义恒正确)。此前一律 fcmp 把串指针位当 float64 → unordered → 恒
        // false(`"a"<"b"` 错)。保守只拦静态可见 STRING,不动数值/unknown 比较(自举热
        // 路径命脉,字节定点)。镜像上方 bigint 关系比较的拦截结构。
        const relHelper = { "<": "_js_lt", "<=": "_js_le", ">": "_js_gt", ">=": "_js_ge" };
        // 静态可证数值(int 表达式或推断 NUMBER/INT/FLOAT)的操作数不会是字符串,保持
        // 内联 fcmp 快路(自举热路径命脉,字节定点)。任一操作数**非**静态数值(STRING/
        // UNKNOWN,如函数参数、sort 比较器的 a/b)→ 走 helper(运行时 tag 判两侧是否都串,
        // 语义恒正确)。这样 `(a,b)=>a<b` 的字符串比较器也修好。
        const staticNumeric = (n) => {
            if (this.isIntExpression(n)) return true;
            const t = inferType(n, this.ctx);
            return isIntType(t) || isFloatType(t) || t === Type.NUMBER;
        };
        if (relHelper[op] && !(staticNumeric(expr.left) && staticNumeric(expr.right))) {
            this.compileExpression(expr.right);
            this.vm.push(VReg.RET);
            this.compileExpression(expr.left);
            this.vm.mov(VReg.A0, VReg.RET); // left
            this.vm.pop(VReg.A1);           // right
            this.vm.call(relHelper[op]);
            return;
        }

        // 检测是否为 int 类型运算
        let isIntOp = this.isIntExpression(expr.left) && this.isIntExpression(expr.right);
        // [解箱①] 裸 int 驻留变量与整数字面量(或另一裸 int 变量)的关系比较:强制走整数
        // 比较,避免 induction 变量的循环条件 `i < N` 退回浮点 fcmp(N 字面量默认推断
        // 为 NUMBER 非 int)。仅限关系运算(<,<=,>,>=):值比较,对正负 int64 语义正确;
        // 不含 ==/=== —— 位相等语义 + NaN≡int0 别名(见 nan-int0-alias-trap)另论。
        if (!isIntOp && ["<", "<=", ">", ">="].indexOf(op) >= 0) {
            const isIntLit = (n) => (n.type === "Literal" || n.type === "NumericLiteral") && typeof n.value === "number" && n.value === Math.floor(n.value);
            const isRawId = (n) => n.type === "Identifier" && this.ctx.isRawIntVar(n.name);
            if ((isRawId(expr.left) && (isIntLit(expr.right) || isRawId(expr.right))) ||
                (isRawId(expr.right) && isIntLit(expr.left))) {
                isIntOp = true;
            }
        }

        // 对于 +, -, *, / 运算，根据类型选择浮点或整数运算
        // 注意: / 和 % 必须使用浮点运算，因为 JS 总是返回浮点数
        const isArithOp = ["+", "-", "*", "/"].includes(op);
        // 判断是否为需要浮点运算的操作（即使操作数是整数）
        const needsFloatDiv = ["/", "%"].includes(op);

        if (isIntOp && !needsFloatDiv) {
            // int 类型：使用整数运算
            this.compileExpressionAsInt(expr.right);
            this.vm.push(VReg.RET);
            this.compileExpressionAsInt(expr.left);
            this.vm.pop(VReg.V1);

            // 注:compileBinaryExpression 是**装箱值**入口(int 上下文另走
            // compileExpressionAsInt 的独立递归,line 206)。故 +/-/* 的裸 int 结果必须
            // intToFloat64Bits 装回 float64 JSValue,否则裸 int(如 16)被消费者按 NaN-boxing
            // 位型解释成极小 denormal ≈ 0(`push(i*i)`/`x=i*i`/`yield i*i` 全渲染成 "0.")。
            // 此前仅 `i` 单侧出现的算式因另一操作数(字面量/参数)推断为 NUMBER→isIntOp 假→
            // 浮点路径装箱而幸免;`i*i`/`i+i`(两侧同为裸 int 归纳变量)才命中裸 int 未装箱。
            switch (op) {
                case "+":
                    this.vm.add(VReg.RET, VReg.RET, VReg.V1);
                    this.intToFloat64Bits(VReg.RET);
                    return;
                case "-":
                    this.vm.sub(VReg.RET, VReg.RET, VReg.V1);
                    this.intToFloat64Bits(VReg.RET);
                    return;
                case "*":
                    this.vm.mul(VReg.RET, VReg.RET, VReg.V1);
                    this.intToFloat64Bits(VReg.RET);
                    return;
                case "/":
                    this.vm.div(VReg.RET, VReg.RET, VReg.V1);
                    this.intToFloat64Bits(VReg.RET);
                    return;
                case "%":
                    this.vm.mod(VReg.RET, VReg.RET, VReg.V1);
                    this.intToFloat64Bits(VReg.RET);
                    return;
                // 比较运算也用整数比较
                case "<":
                    this.compileComparison("jlt", false, expr);
                    return;
                case "<=":
                    this.compileComparison("jle", false, expr);
                    return;
                case ">":
                    this.compileComparison("jgt", false, expr);
                    return;
                case ">=":
                    this.compileComparison("jge", false, expr);
                    return;
                case "==":
                    // 抽象相等：调用运行时函数
                    this.vm.mov(VReg.A0, VReg.RET); // 左操作数
                    this.vm.mov(VReg.A1, VReg.V1); // 右操作数
                    this.vm.call("_abstract_eq");
                    return;
                case "===":
                    this.compileComparison("jeq", false, expr);
                    return;
                case "!=":
                case "!==":
                    this.compileComparison("jne", false, expr);
                    return;
            }
        }

        // 辅助函数：编译操作数为 float64 位模式
        // 由于变量类型可能在运行时改变（如整数变量被赋值为 Number 对象），
        // 我们需要更保守的策略
        const compileOperandAsFloat = (operand) => {
            const opType = inferType(operand, this.ctx);

            // 对于字面量，可以安全地使用静态类型
            if (operand.type === "Literal" || operand.type === "NumericLiteral") {
                if (isIntType(opType)) {
                    // 整数字面量：直接转换为 float64 位模式
                    this.compileExpressionAsInt(operand);
                    this.intToFloat64Bits(VReg.RET);
                    return;
                } else if (opType === Type.BOOLEAN) {
                    // 布尔字面量：先转为整数，再转 float
                    // compileExpression 返回 JSValue boolean，转为整数后转 float
                    this.compileExpression(operand);
                    // 提取布尔值的实际位 (0 或 1)
                    // JSValue boolean: true = 0x7FF9000000000001, false = 0x7FF9000000000002
                    // 提取最低位: and V1, RET, #1
                    this.vm.andImm(VReg.V1, VReg.RET, 1);
                    // V1 现在是 0 或 1，转为 float64
                    this.intToFloat64Bits(VReg.V1);
                    this.vm.mov(VReg.RET, VReg.V1);
                    return;
                } else if (opType === Type.NULL) {
                    // null 字面量：ToNumber(null) = 0
                    // 返回 float64 0.0
                    this.vm.movImm(VReg.RET, 0);  // RET = 0
                    this.intToFloat64Bits(VReg.RET);  // 转为 0.0 的 float64 位模式
                    return;
                } else if (opType === Type.UNDEFINED) {
                    // undefined 字面量：ToNumber(undefined) = NaN
                    // 直接发打印友好的 NaN 位 0x7FF0…0001(high16=0x7FF0<避开 int0 标签,
                    // 打印 "NaN")。原用 floatToInt64Bits(NaN):其 `value !== value` NaN 守卫
                    // 在 asm.js 语义下按位为假(NaN≡int0 别名),自编译时(gen1+)返回的不是
                    // 0x7FF8 而是归一化垃圾 → 与 node(gen0)分歧 → 自举振荡。硬编码消歧。
                    this.vm.movImm64(VReg.RET, 0x7FF0000000000001n);
                    return;
                } else if (opType === Type.STRING) {
                    // 字符串字面量：需要转换为数字
                    // compileExpression 返回字符串指针
                    this.compileExpression(operand);
                    // 调用 _number_coerce 将字符串转换为数字
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_number_coerce");
                    return;
                } else {
                    // 非整数字面量（如 1.0）：compileExpression 已经返回原始 float 位模式
                    // 不要调用 unboxNumber，因为 raw bits 不是 Number 对象指针！
                    this.compileExpression(operand);
                    return;
                }
            }

            // 数组/对象字面量等作算术操作数:ToPrimitive/ToNumber via _number_coerce
            // (它对数组→逗号串→解析、对象→valueOf/toString 均已处理)。此前落末尾
            // unboxNumber(当 Number 对象指针解引用)→ `[5]*2`/`({}).x*2` 得垃圾/串。
            if (opType === Type.ARRAY || opType === Type.OBJECT) {
                this.compileExpression(operand);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_number_coerce");
                return;
            }

            // 对于标识符，检查是否是未装箱的变量
            // 无论标识符最终落成 raw float、int32 JSValue 还是 heap Number，
            // 统一交给 _number_coerce 归一化，避免这里继续猜表示形态。
            if (operand.type === "Identifier") {
                // [解箱①] 裸 int 驻留变量:slot 是裸 int,直接 load 后 int→float64 位
                if (this.ctx.isRawIntVar(operand.name)) {
                    const off = this.ctx.getLocal(operand.name);
                    if (off) {
                        this.vm.load(VReg.RET, VReg.FP, off);
                        this.intToFloat64Bits(VReg.RET);
                        return;
                    }
                }
                this.compileExpression(operand);
                this.emitNumberCoerceFast(); // [P3.1] 内联快路守卫
                return;
            }

            // 对于一元表达式，检查是否是返回 raw bits 的情况
            // 统一走 _number_coerce，兼容 raw float、布尔、Number 对象等输入。
            if (operand.type === "UnaryExpression") {
                this.compileExpression(operand);
                this.emitNumberCoerceFast(); // [P3.1]
                return;
            }

            // 对于二元表达式，当前实现可能返回 raw float bits，也可能返回 heap Number。
            // [P3.0] 编译路径确定返回 raw float64 位模式(NaN-boxing 下即 JSValue)时,
            // _number_coerce 是恒等调用,消除(num 循环每迭代省一次 call,PERF_PLAN P3):
            //   / 和 % 无条件走浮点路径(int/int 也是,needsFloatDiv);
            //   - 和 * 推断 FLOAT64 即浮点路径(ARRAY 等参与也经操作数 coerce 得 NaN raw);
            //   + 另须两侧都是数值类型——ARRAY/OBJECT 参与会路由字符串拼接返回指针,
            //     而 && / || 推断返回左类型、值可为右侧任意类型,故不在消除集内。
            if (operand.type === "BinaryExpression") {
                this.compileExpression(operand);
                const bop = operand.operator;
                // int 算术路径(+,-,* 两操作数皆 int)现由 compileBinaryExpression 的 isIntOp
                // 分支**装箱**成 float64 位(不再裸 int),RET 即 float64 位模式 = 该数值,
                // 无需再转。此前这里的 intToFloat64Bits 在装箱修复后变**双重转换**:把装箱
                // float64 当整数再转 → `i*i-2*i`(此操作数走浮点路径,`i*i` 经此)得 i*i 位模式。
                if (["+", "-", "*"].indexOf(bop) >= 0 && this.isIntExpression(operand)) {
                    return;
                }
                let rawFloat = (bop === "/" || bop === "%");
                if (!rawFloat && (bop === "-" || bop === "*")) {
                    rawFloat = inferType(operand, this.ctx) === Type.FLOAT64;
                }
                if (!rawFloat && bop === "+") {
                    const lt = inferType(operand.left, this.ctx);
                    const rt = inferType(operand.right, this.ctx);
                    const numTy = (t) => t === Type.FLOAT64 || isIntType(t);
                    rawFloat = numTy(lt) && numTy(rt) &&
                        inferType(operand, this.ctx) === Type.FLOAT64;
                }
                if (rawFloat) {
                    return;
                }
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_number_coerce");
                return;
            }

            // 函数调用返回值的表示也不稳定，统一交给运行时转换。
            if (operand.type === "CallExpression") {
                this.compileExpression(operand);
                this.emitNumberCoerceFast(); // [P3.1]
                return;
            }

            // 对于成员表达式（数组元素、对象属性），返回值是原始值
            // 需要调用 _number_coerce 正确转换为数字
            if (operand.type === "MemberExpression") {
                this.compileExpression(operand);
                this.emitNumberCoerceFast(); // [P3.1]
                return;
            }

            // 其他表达式(NewExpression 如 `new Date()`、条件/逻辑/模板等):走 _number_coerce
            // 通用 ToNumber。此前 unboxNumber 假设是 Number 对象指针,对 Date/数组/对象等
            // 误解引用(`new Date()-new Date()` 得 NaN/崩)。_number_coerce 覆盖全表示。
            this.compileExpression(operand);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_number_coerce");
        };

        // 辅助函数：编译操作数为 JSValue（用于抽象相等比较）
        // 需要返回proper JSValue: int32 (tag 0), string (0x7FFC | ptr), float (raw bits), etc.
        const compileOperandAsJSValue = (operand) => {
            const opType = inferType(operand, this.ctx);

            // 对于 NumericLiteral，始终编译为 int32 JSValue
            // 这确保 == 比较时类型一致
            if (operand.type === "NumericLiteral") {
                // 整数字面量：编译为 int32 JSValue (tag 0)
                // int32 JSValue = 0x7FF8000000000000 | value
                this.compileExpressionAsInt(operand); // RET = value (raw int)
                // Box as int32 JSValue
                // x64: V0==RET==RAX，movImm64(V0) 会冲掉 RET 里的原始整数；x64 用 V2
                {
                    const tagReg = this.vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
                    this.vm.movImm64(tagReg, 0x7FF8000000000000n);
                    this.vm.or(VReg.RET, tagReg, VReg.RET);
                }
                return;
            }

            // 对于其他字面量，根据类型处理
            if (operand.type === "Literal") {
                if (isIntType(opType) || opType === Type.FLOAT32 || opType === Type.FLOAT64) {
                    // 整数字面量：编译为 int32 JSValue (tag 0)
                    // int32 JSValue = 0x7FF8000000000000 | value
                    this.compileExpressionAsInt(operand); // RET = value (raw int)
                    // Box as int32 JSValue
                    // x64: V0==RET==RAX，movImm64(V0) 会冲掉 RET 里的原始整数；x64 用 V2
                    {
                        const tagReg = this.vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
                        this.vm.movImm64(tagReg, 0x7FF8000000000000n);
                        this.vm.or(VReg.RET, tagReg, VReg.RET);
                    }
                    return;
                } else {
                    // 浮点字面量：返回 raw float bits
                    this.compileExpression(operand);
                    return;
                }
            }

            // 对于标识符
            if (operand.type === "Identifier") {
                // 变量直接编译为 JSValue
                // 注意：不要在这里调用 _number_coerce！
                // _abstract_eq 会自动处理类型转换（如 Number == String）
                // 如果在这里调用 _number_coerce，会把字符串转换为 NaN，
                // 导致 _abstract_eq 无法正确处理 String == String 等情况
                this.compileExpression(operand);
                return;
            }

            // 对于一元表达式
            if (operand.type === "UnaryExpression") {
                this.compileExpression(operand);
                return;
            }

            // 对于二元表达式
            if (operand.type === "BinaryExpression") {
                this.compileExpression(operand);
                return;
            }

            // 对于其他表达式
            this.compileExpression(operand);
        };

        // 非整数类型的 == 和 != 需要使用 JSValue 抽象相等比较
        if (op === "==" || op === "!=") {
            // 编译右操作数为 JSValue
            compileOperandAsJSValue(expr.right);
            this.vm.push(VReg.RET);
            // 编译左操作数为 JSValue
            compileOperandAsJSValue(expr.left);
            this.vm.pop(VReg.V1);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.mov(VReg.A1, VReg.V1);
            this.vm.call("_abstract_eq");
            // `!=` 是 `==` 的取反。此前对 `!=` 直接返回 _abstract_eq 结果**未取反**——
            // `x != null` 等恒返 `x == null`(倒置),破坏 `arr.filter(x=>x!=null)` 等常见
            // 惯用法(`!==` 走 _strict_eq 另路故未暴露)。_abstract_eq 返规范
            // JS_TRUE(0x…01)/JS_FALSE(0x…00),XOR 低位精确翻转。
            if (op === "!=") this.vm.xorImm(VReg.RET, VReg.RET, 1);
            return;
        }

        // instanceof:操作数必须原样(JSValue)编译 —— 曾落入下方浮点强转路径,
        // 变量左操作数(装箱数组等)被 f2i 毁掉 → 恒 false(字面量恰走保箱子路径
        // 才侥幸为 true,#15 实锤)。右操作数 Array/Object 经 members.js 编译为
        // 内建标识 1/2,用户类为类信息对象(原型链检查未实现 → false)。
        // [#36] e instanceof Error 族:编译期内联——对象 tag + __asmjs_err 标记,
        // 具体类再比 name(_strict_eq 内容比较);Error 基类命中所有子类 ✓
        if (op === "instanceof" && expr.right && expr.right.type === "Identifier" &&
            ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
             "URIError", "EvalError", "AggregateError"].includes(expr.right.name)) {
            const errName = expr.right.name;
            const eiF = this.ctx.newLabel("einst_f");
            const eiEnd = this.ctx.newLabel("einst_end");
            const eiSlot = this.ctx.allocLocal(`__einst_${this.nextLabelId()}`);
            compileOperandAsJSValue(expr.left);
            this.vm.store(VReg.FP, eiSlot, VReg.RET);
            this.vm.shrImm(VReg.V1, VReg.RET, 48);
            this.vm.cmpImm(VReg.V1, 0x7FFD);
            this.vm.jne(eiF);
            this.vm.load(VReg.A0, VReg.FP, eiSlot);
            this.emitBoxedStringKey("__asmjs_err", VReg.A1);
            this.vm.call("_object_has");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(eiF);
            if (errName !== "Error") {
                this.vm.load(VReg.A0, VReg.FP, eiSlot);
                this.emitBoxedStringKey("name", VReg.A1);
                this.vm.call("_object_get");
                this.vm.mov(VReg.A0, VReg.RET);
                this.emitBoxedStringKey(errName, VReg.A1);
                this.vm.call("_strict_eq");
                this.vm.movImm64(VReg.V1, 0x7ff9000000000001n); // JS_TRUE
                this.vm.cmp(VReg.RET, VReg.V1);
                this.vm.jne(eiF);
            }
            this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
            this.vm.jmp(eiEnd);
            this.vm.label(eiF);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
            this.vm.label(eiEnd);
            return;
        }

        // [#66 Phase1b] RegExp instanceof:RegExp 是纯 JS shim 对象(__RE_new 造,
        // type 字节=TYPE_OBJECT 而非 TYPE_REGEXP),靠品牌属性 __isRegExp 判定
        // (仿 Error 族 __asmjs_err):tag 0x7FFD + _object_has "__isRegExp"。
        if (op === "instanceof" && expr.right && expr.right.type === "Identifier" &&
            expr.right.name === "RegExp") {
            const riF = this.ctx.newLabel("rinst_f");
            const riEnd = this.ctx.newLabel("rinst_end");
            const riSlot = this.ctx.allocLocal(`__rinst_${this.nextLabelId()}`);
            compileOperandAsJSValue(expr.left);
            this.vm.store(VReg.FP, riSlot, VReg.RET);
            this.vm.shrImm(VReg.V1, VReg.RET, 48);
            this.vm.cmpImm(VReg.V1, 0x7FFD);
            this.vm.jne(riF);
            // 必须是普通属性对象(type 字节==TYPE_OBJECT 2)才可安全 _object_has:
            // Date(7)/其它 0x7FFD 装箱的原生结构非属性对象,直接 has 会误读头字段。
            this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
            this.vm.and(VReg.V2, VReg.RET, VReg.V1);
            this.vm.lea(VReg.V1, "_heap_base");
            this.vm.load(VReg.V1, VReg.V1, 0);
            this.vm.cmp(VReg.V2, VReg.V1);
            this.vm.jlt(riF);
            this.vm.lea(VReg.V1, "_heap_ptr");
            this.vm.load(VReg.V1, VReg.V1, 0);
            this.vm.cmp(VReg.V2, VReg.V1);
            this.vm.jge(riF);
            this.vm.load(VReg.V1, VReg.V2, 0);
            this.vm.andImm(VReg.V1, VReg.V1, 0xff);
            this.vm.cmpImm(VReg.V1, 2); // TYPE_OBJECT
            this.vm.jne(riF);
            this.vm.load(VReg.A0, VReg.FP, riSlot);
            this.emitBoxedStringKey("__isRegExp", VReg.A1);
            this.vm.call("_object_has");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(riF);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
            this.vm.jmp(riEnd);
            this.vm.label(riF);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
            this.vm.label(riEnd);
            return;
        }

        // [#66 Phase1b] 内建 instanceof:Date/Map/Set/Promise —— 编译期内联
        // tag 字节比较。实例低 48 位掩出裸指针候选,守 [heap_base,heap_ptr) 再读
        // [ptr+0] 低字节 == 目标 TYPE。兼容 0x7FFD 装箱(Date/Promise)与裸
        // 堆指针(Map/Set,高16=0)两种呈现:掩码对二者皆得裸指针;真数/null 掩码后
        // 越堆界 → false,绝不解引用(仿 __json_date_iso functions.js:954-967)。
        // 类型映射用显式 === 链而非 {} 查表:用户标识符做字典键有原型链污染风险
        // (gen1 #32,见 members.js Symbol 常量注)——曾用 hasOwnProperty.call 自举后
        // 恒真、把用户类/Object instanceof 误路由进本路径塌 false。
        let biWantType = 0;
        if (op === "instanceof" && expr.right && expr.right.type === "Identifier") {
            const bn = expr.right.name;
            if (bn === "Date") biWantType = 7;
            else if (bn === "Map") biWantType = 4;
            else if (bn === "Set") biWantType = 5;
            else if (bn === "Promise") biWantType = 11;
            // TypedArray 族:实例头 type 字节即各自 TYPE(0x40-0x61)。x instanceof Int8Array
            // 仅当 type 字节精确相等(与 Date/Map 同法,heap 界内读 [ptr+0] 低字节)。
            else if (bn === "Int8Array") biWantType = 0x40;
            else if (bn === "Int16Array") biWantType = 0x41;
            else if (bn === "Int32Array") biWantType = 0x42;
            else if (bn === "BigInt64Array") biWantType = 0x43;
            else if (bn === "Uint8Array") biWantType = 0x50;
            else if (bn === "Uint16Array") biWantType = 0x51;
            else if (bn === "Uint32Array") biWantType = 0x52;
            else if (bn === "BigUint64Array") biWantType = 0x53;
            else if (bn === "Uint8ClampedArray") biWantType = 0x54;
            else if (bn === "Float32Array") biWantType = 0x60;
            else if (bn === "Float64Array") biWantType = 0x61;
        }
        if (biWantType !== 0) {
            const wantType = biWantType;
            const biF = this.ctx.newLabel("binst_f");
            const biEnd = this.ctx.newLabel("binst_end");
            compileOperandAsJSValue(expr.left);
            this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
            this.vm.and(VReg.V2, VReg.RET, VReg.V1); // 裸指针候选(去高位 tag)
            this.vm.lea(VReg.V1, "_heap_base");
            this.vm.load(VReg.V1, VReg.V1, 0);
            this.vm.cmp(VReg.V2, VReg.V1);
            this.vm.jlt(biF);
            this.vm.lea(VReg.V1, "_heap_ptr");
            this.vm.load(VReg.V1, VReg.V1, 0);
            this.vm.cmp(VReg.V2, VReg.V1);
            this.vm.jge(biF);
            this.vm.load(VReg.V1, VReg.V2, 0); // type 字(全 8 字节存 TYPE)
            this.vm.andImm(VReg.V1, VReg.V1, 0xff);
            this.vm.cmpImm(VReg.V1, wantType);
            this.vm.jne(biF);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
            this.vm.jmp(biEnd);
            this.vm.label(biF);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
            this.vm.label(biEnd);
            return;
        }

        // [#69/#66] x instanceof F,F 为普通函数声明:F 作值是闭包 {0xc105,label}
        // (非 classinfo),泛型 _instanceof 塌 false。改沿实例 __proto__ 链比对 F 的
        // prototype(new F 惰性建、存 _funcproto_<sym>),委托运行时 _instanceof_proto。
        if (op === "instanceof" && expr.right && expr.right.type === "Identifier") {
            const rDecl = this.ctx.getFunction ? this.ctx.getFunction(expr.right.name) : null;
            if (rDecl && rDecl.type === "FunctionDeclaration") {
                const sym = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(expr.right.name)) ||
                    expr.right.name;
                const protoLabel = this.ensureFuncProtoSlot(sym);
                compileOperandAsJSValue(expr.left); // RET = 实例
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.lea(VReg.A1, protoLabel);
                this.vm.load(VReg.A1, VReg.A1, 0); // A1 = F.prototype(裸,无则 0)
                this.vm.call("_instanceof_proto");
                return;
            }
        }

        if (op === "instanceof") {
            // [Symbol.hasInstance] 优先:right 定义了则以 right[Symbol.hasInstance](left) 定夺;
            // 否则(哨兵裸 0)回退常规原型链 _instanceof。用户类/对象经此路径,内建族在上方快路。
            const iofROff = this.ctx.allocLocal(`__iof_r_${this.nextLabelId()}`);
            const iofLOff = this.ctx.allocLocal(`__iof_l_${this.nextLabelId()}`);
            const iofDone = this.ctx.newLabel("iof_hasinst_done");
            compileOperandAsJSValue(expr.right);
            this.vm.store(VReg.FP, iofROff, VReg.RET);
            compileOperandAsJSValue(expr.left);
            this.vm.store(VReg.FP, iofLOff, VReg.RET);
            this.vm.load(VReg.A0, VReg.FP, iofROff); // right
            this.vm.load(VReg.A1, VReg.FP, iofLOff); // left
            this.vm.call("_try_hasinstance");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jne(iofDone); // 非 0 → 装箱布尔结果
            this.vm.load(VReg.A0, VReg.FP, iofLOff); // 左:实例
            this.vm.load(VReg.A1, VReg.FP, iofROff); // 右:构造器标识
            this.vm.call("_instanceof");
            this.vm.label(iofDone);
            return;
        }

        // "key" in obj：操作数必须原样(JSValue)编译。此前落到下方浮点强转路径,
        // 字符串 key 被转成 NaN → getStrContent 解引用 tag(0x7ff8)崩。此处提前处理:
        // RET=key、V1=obj,取 key content + obj 裸指针调 _prop_in,再把裸 0/1 装箱布尔。
        if (op === "in") {
            // obj 裸指针先算好压栈(getStrContent/js_unbox 会 clobber 临时寄存器 V1/A1,
            // 故用栈暂存,_prop_in 前才把 A0/A1 装好)。
            compileOperandAsJSValue(expr.right); // obj → RET
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_js_unbox");
            this.vm.push(VReg.RET); // 栈: [obj 裸指针]
            const inLeftIsPrivate = expr.left.type === "PrivateIdentifier" ||
                (expr.left.type === "Identifier" && expr.left.name && expr.left.name.charAt(0) === "#");
            const inResultReady = this.ctx.newLabel("in_result_ready");
            if (inLeftIsPrivate) {
                // [ES2022] #x in o:私有字段存在性检查。表达式位的 `#x` 解析为 Identifier
                // (name="#x")或 PrivateIdentifier;键 = manglePrivateName("#x")= "#ClassName#x"
                // (与 this.#x 访问端一致的存储键),直接查 _prop_in。
                this.emitBoxedStringKey(this.manglePrivateName(expr.left.name), VReg.A0);
                this.vm.call("_getStrContent");
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.pop(VReg.A0);
                this.vm.call("_prop_in");
            } else {
                compileOperandAsJSValue(expr.left); // key → RET(装箱)
                const inKeyOff = this.ctx.allocLocal(`__in_key_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, inKeyOff, VReg.RET);
                // symbol 键:按身份判存在,走 _object_has(装箱键 + _object_key_eq,与 hasOwn
                // 一致)。此前 _getStrContent(symbol)+_prop_in 逐字节比 → `sym in o` 恒 false。
                // (own-only:继承的 symbol 键极罕见,记偏差)
                this.vm.load(VReg.A0, VReg.FP, inKeyOff);
                this.vm.call("_is_symbol");
                this.vm.cmpImm(VReg.RET, 0);
                const inSymKey = this.ctx.newLabel("in_symkey");
                this.vm.jne(inSymKey);
                // 非 symbol:原字符串内容路径(数值键规范化 + 原型链感知 _prop_in)
                this.vm.load(VReg.A0, VReg.FP, inKeyOff);
                this.vm.call("_js_prop_key"); // [#39] 数值键规范化(1 in o ≡ "1" in o)
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_getStrContent");
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.pop(VReg.A0);
                this.vm.call("_prop_in");
                this.vm.jmp(inResultReady);
                this.vm.label(inSymKey);
                this.vm.pop(VReg.A0); // obj 裸指针
                this.vm.load(VReg.A1, VReg.FP, inKeyOff); // 装箱 symbol 键
                this.vm.call("_object_has");
            }
            this.vm.label(inResultReady);
            const inTrue = this.ctx.newLabel("in_true");
            const inEnd = this.ctx.newLabel("in_end");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jne(inTrue);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
            this.vm.jmp(inEnd);
            this.vm.label(inTrue);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
            this.vm.label(inEnd);
            return;
        }

        // [#41] 相等类比较(==/===/!=/!==)必须在浮点预编译**之前**分派:
        // 这四个分支用 compileOperandAsJSValue 自含编译操作数,若走到下方
        // compileOperandAsFloat 预编译再进 case 重编,操作数被求值两次——
        // `while ((m = re.exec(s)) !== null)` 每轮吃掉两个匹配、
        // `if (f() === x)` 调 f 两次(副作用重放,长期潜伏)。
        if (op === "==" || op === "===" || op === "!=" || op === "!==") {
            compileOperandAsJSValue(expr.right);
            this.vm.push(VReg.RET);
            compileOperandAsJSValue(expr.left);
            this.vm.pop(VReg.V1);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.mov(VReg.A1, VReg.V1);
            this.vm.call(op === "==" || op === "!=" ? "_abstract_eq" : "_strict_eq");
            if (op === "==" || op === "===") return;
            // != / !==:对相等结果取反。
            // x64: V0==RET==RAX,movImm64(V0) 会先冲掉相等调用的返回值 → 恒 true;
            // x64 用 V2 暂存掩码,arm64 保持 V0。
            {
                const neqMaskReg = this.vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
                this.vm.movImm64(neqMaskReg, 0x0000ffffffffffffn);
                this.vm.and(neqMaskReg, VReg.RET, neqMaskReg); // = payload
                this.vm.cmpImm(neqMaskReg, 1); // payload == 1 即相等为 true
            }
            const neqIsFalseLabel = this.ctx.newLabel("neq_isfalse");
            const neqEndLabel = this.ctx.newLabel("neq_end");
            this.vm.jeq(neqIsFalseLabel); // 相等为 true → 取反返回 false
            this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
            this.vm.jmp(neqEndLabel);
            this.vm.label(neqIsFalseLabel);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
            this.vm.label(neqEndLabel);
            return;
        }

        // [nan-int0] NaN 结果规范化只在可能产生 NaN 时发射(操作数非纯数值:字符串/对象/
        // unknown 等 ToNumber 可得 NaN)。两侧均静态数值(int/float)时结果不会是别名 NaN
        // (0/0、Inf-Inf 走既有 deferred),跳过以保数值热循环零开销。
        const numTy = (t) => t === Type.FLOAT64 || isIntType(t);
        const mightBeNaN = !(numTy(inferType(expr.left, this.ctx)) &&
                             numTy(inferType(expr.right, this.ctx)));

        // 先计算右操作数，保存到栈
        compileOperandAsFloat(expr.right);
        this.vm.push(VReg.RET);

        // 计算左操作数
        compileOperandAsFloat(expr.left);
        this.vm.pop(VReg.V1);

        // 对于算术运算，使用浮点指令
        if (isArithOp) {
            // 使用 VM 的统一浮点接口，不再区分 arm64/x64
            this.vm.fmovToFloat(0, VReg.RET); // FP0 = left
            this.vm.fmovToFloat(1, VReg.V1); // FP1 = right

            switch (op) {
                case "+":
                    this.vm.fadd(0, 0, 1);
                    break;
                case "-":
                    this.vm.fsub(0, 0, 1);
                    break;
                case "*":
                    this.vm.fmul(0, 0, 1);
                    break;
                case "/":
                    this.vm.fdiv(0, 0, 1);
                    break;
            }

            // 结果用**裸 float64 位**返回（与数字字面量表示一致）。此前装箱成堆 Number 对象
            // 导致表示不一致：`a*2` 得堆 Number 而字面量得裸浮点位，令 ===/+/显示/下标全乱
            // （a*2 → r+0=0、r===6 得对象）。裸浮点位（高16<0x7FF8）会被 NaN-boxing 当 double，
            // _print_value/_js_add/=== 等一致正确。
            this.vm.fmovToInt(VReg.RET, 0);
            if (mightBeNaN) this.emitNaNCanon();
            return;
        }

        // 位运算等使用整数运算
        switch (expr.operator) {
            case "+":
                this.vm.add(VReg.RET, VReg.RET, VReg.V1);
                this.boxNumber(VReg.RET);
                break;
            case "-":
                this.vm.sub(VReg.RET, VReg.RET, VReg.V1);
                this.boxNumber(VReg.RET);
                break;
            case "*":
                this.vm.mul(VReg.RET, VReg.RET, VReg.V1);
                this.boxNumber(VReg.RET);
                break;
            case "/":
                this.vm.div(VReg.RET, VReg.RET, VReg.V1);
                this.boxNumber(VReg.RET);
                break;
            case "%":
                // 浮点取模: a % b = a - trunc(a / b) * b
                if (!isIntOp) {
                    // 使用 VM 的统一接口
                    this.vm.fmovToFloat(0, VReg.RET); // FP0 = left
                    this.vm.fmovToFloat(1, VReg.V1); // FP1 = right
                    this.vm.fmod(0, 0, 1); // FP0 = FP0 % FP1
                    // 结果用**裸 float64 位**返回，与 `/` 及数字字面量表示一致。
                    // 此前 boxFPAsNumber 装箱成堆 Number 对象，导致 `x%8 === 5`、
                    // `len%8 !== 0` 等比较全错（堆 Number ≠ 裸浮点/int），
                    // 自举时 alignTo 的 `while (buf.length % 8 !== 0)` 死循环。
                    this.vm.fmovToInt(VReg.RET, 0);
                    if (mightBeNaN) this.emitNaNCanon();
                    break;
                }
                this.vm.mod(VReg.RET, VReg.RET, VReg.V1);
                this.boxNumber(VReg.RET);
                break;
                case "&":
                case "|":
                case "^":
                case "<<":
                case ">>":
                case ">>>":
                    {
                        // 位运算：需要 ToInt32/ToUint32 强制转换
                        const isUnsigned = expr.operator === ">>>";
                        const coerceFunc = isUnsigned ? "_to_uint32" : "_to_int32";

                        // Coerce both operands to Int32/Uint32
                        // left is in RET, right is in V1 (both are JSValues)
                        this.vm.mov(VReg.S2, VReg.RET); // S2 = left JSValue
                        this.vm.mov(VReg.S3, VReg.V1);  // S3 = right JSValue

                        // Coerce left
                        this.vm.mov(VReg.A0, VReg.S2);
                        this.vm.call(coerceFunc);
                        this.vm.mov(VReg.S2, VReg.RET); // S2 = left int32/uint32

                        // Coerce right
                        this.vm.mov(VReg.A0, VReg.S3);
                        this.vm.call(coerceFunc);
                        this.vm.mov(VReg.V1, VReg.RET); // V1 = right int32/uint32
                        this.vm.mov(VReg.V0, VReg.S2);  // V0 = left int32/uint32

                        // JS 规范:移位数按 & 31 取模(1<<33 ≡ 1<<1)。此前 64 位裸移位
                        // 后截断低 32 位 → count≥32 恒 0。仅移位需要;&/|/^ 共用本块不掩。
                        if (expr.operator === "<<" || expr.operator === ">>" || expr.operator === ">>>") {
                            this.vm.andImm(VReg.V1, VReg.V1, 31);
                        }

                        switch (expr.operator) {
                            case "&": this.vm.and(VReg.RET, VReg.V0, VReg.V1); break;
                            case "|": this.vm.or(VReg.RET, VReg.V0, VReg.V1); break;
                            case "^": this.vm.xor(VReg.RET, VReg.V0, VReg.V1); break;
                            case "<<": this.vm.shl(VReg.RET, VReg.V0, VReg.V1); break;
                            case ">>": this.vm.sar(VReg.RET, VReg.V0, VReg.V1); break; // 算术右移
                            case ">>>": this.vm.shr(VReg.RET, VReg.V0, VReg.V1); break; // 逻辑右移
                        }

                        // 将结果装箱为 int32 JSValue (tag 0)
                        this.vm.movImm64(VReg.V1, 0xFFFFFFFFn);
                        this.vm.and(VReg.RET, VReg.RET, VReg.V1); // 确保只有低 32 位
                        this.vm.movImm64(VReg.V1, 0x7FF8000000000000n); // JS_TAG_INT32_BASE
                        this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                    }
                    break;
            case "<":
                this.compileComparison("jlt", true, expr);
                break;
            case "<=":
                this.compileComparison("jle", true, expr);
                break;
            case ">":
                this.compileComparison("jgt", true, expr);
                break;
            case ">=":
                this.compileComparison("jge", true, expr);
                break;
            // [#41] ==/===/!=/!== 已在浮点预编译之前分派(见上方早退块),
            // 到不了这里——曾经的 case 在此处重编操作数造成副作用双求值。
            case "instanceof":
                // 左操作数在 RET，右操作数在 V1
                // 调用 _instanceof 运行时函数
                this.vm.mov(VReg.A0, VReg.RET); // 左操作数（实例）
                this.vm.mov(VReg.A1, VReg.V1); // 右操作数（构造函数）
                this.vm.call("_instanceof");
                break;
            case "in":
                // 检查属性是否在对象中: "prop" in obj
                // 左操作数在 RET（属性名，JSValue），右操作数在 V1（对象）
                // _prop_in 参数顺序: (obj, key) 并检查原型链
                // obj 需要是 unboxed 指针，key 需要是内容指针
                this.vm.mov(VReg.A0, VReg.RET); // A0 = key JSValue
                this.vm.call("_getStrContent"); // RET = content pointer
                this.vm.mov(VReg.A1, VReg.RET); // A1 = key content pointer
                this.vm.mov(VReg.A0, VReg.V1); // A0 = object JSValue
                this.vm.call("_js_unbox"); // RET = object pointer
                this.vm.mov(VReg.A0, VReg.RET); // A0 = object pointer
                this.vm.call("_prop_in");
                break; // 注：in 已在上方提前处理(原样操作数),此 case 不再可达
            case "**":
                // 幂运算: left ** right
                // [#33] _math_pow 契约是 A0=base/A1=exp 位模式(内部自 fmov)——
                // 原码预装 FP0/FP1 而 A0/A1 垃圾,非折叠操作数的 ** 一直是坏的
                // (2**10 能过纯因常量折叠)。
                this.vm.mov(VReg.A0, VReg.RET); // base(RET=left)
                this.vm.mov(VReg.A1, VReg.V1);  // exp
                this.vm.call("_math_pow");      // 返回 RET = float64 位
                break;
            default:
                console.warn("Unhandled binary operator:", expr.operator);
        }
    },

    // [P3.1] ToNumber 内联快路守卫:RET=任意 JSValue → RET=float64 位。
    // 与 _number_coerce 逐分支等价:高16位∈[0x7FF8,0x8000) 为 NaN-box 标签区
    // (undefined/null/bool/int/串/对象/数组)→ 调 coerce;值∈[heap_base,heap_ptr)
    // 为裸堆指针(堆 Number/BigInt 对象)→ 调 coerce;其余即 raw double 直用
    // (正常正 double 位 ≥2^52 远高于堆地址,负 double 高16位 ≥0x8000)。
    // 热路径 4-9 条内联指令替代 call+prologue+内部 _is_bigint 调用。
    // [nan-int0] 二元浮点 -/*//% 的结果若是 NaN,硬件会规范成 qNaN 0x7ff8…(quiet 位置位),
    // 其 high16∈[0x7FF8,0x7FFF] 与装箱 int/tag 位别名 → 打印成低32位整数、===/isNaN 全错
    // (`"abc"-1` 得 1 = 0x7ff8000000000001 别名 boxed-int1)。命中 NaN 分支时改写成非别名
    // NaN 0x7ff0000000000001(high16=0x7FF0 非 tag,打印 "NaN"、语义正确)。仅在编译期无法
    // 静态排除 NaN(操作数非纯数值)时发射,数值热循环零开销。
    emitNaNCanon() {
        // 委托运行时 _nan_canon(每站点仅 mov+call,压缩产物;非数值热路径,调用开销可忽略)。
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_nan_canon");
    },

    emitNumberCoerceFast() {
        const vm = this.vm;
        const doneL = this.ctx.newLabel("ncf_done");
        const heapL = this.ctx.newLabel("ncf_heap");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt(heapL); // 正 double 或裸堆指针区
        vm.cmpImm(VReg.V1, 0x8000);
        vm.jge(doneL); // 负 double → raw
        vm.mov(VReg.A0, VReg.RET); // 标签区 → 慢路
        vm.call("_number_coerce");
        vm.jmp(doneL);
        vm.label(heapL);
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jlt(doneL); // < heap_base → raw double
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jge(doneL); // ≥ heap_ptr → raw double
        vm.mov(VReg.A0, VReg.RET); // 堆内 → 可能堆 Number/BigInt,慢路
        vm.call("_number_coerce");
        vm.label(doneL);
    },

    // 编译比较运算
    // [P3.0] 融合模式:statements 侧把 {node, falseLabel} 放在 this._fuseCondJump,
    // 仅当 fuseNode 与之身份相等(防内层嵌套比较误消费)时,直接按 flags 条件跳转,
    // 跳过布尔物化 + _to_boolean 三段式。保持与原码同向的跳转结构(j<cond> 续行;
    // jmp falseLabel)而不倒置条件——倒置在 fcmp unordered(NaN)下两平台条件码
    // 语义均会翻错。未消费(常量折叠/==/BigInt/字符串路由)由调用方回退。
    compileComparison(jumpOp, useFloat = false, fuseNode = null) {
        const fuse = this._fuseCondJump;
        if (fuse && fuseNode !== null && fuse.node === fuseNode) {
            this._fuseCondJump = null;
            fuse.fused = true;
            const contLabel = this.ctx.newLabel("cmp_cont");
            if (useFloat) {
                this.vm.fmovToFloat(0, VReg.RET);
                this.vm.fmovToFloat(1, VReg.V1);
                this.vm.fcmp(0, 1);
                const fj = { jlt: "jflt", jle: "jfle", jgt: "jfgt", jge: "jfge" }[jumpOp] || jumpOp;
                this.vm[fj](contLabel);
            } else {
                this.vm.cmp(VReg.RET, VReg.V1);
                this.vm[jumpOp](contLabel);
            }
            this.vm.jmp(fuse.falseLabel);
            this.vm.label(contLabel);
            return;
        }

        const trueLabel = this.ctx.newLabel("cmp_true");
        const endLabel = this.ctx.newLabel("cmp_end");

        if (useFloat) {
            // 操作数是 float64 位模式：必须用浮点比较。整数 cmp 对负数（符号位在高位）
            // 按位序比较是错的——`-296 >= -256` 会得 true（自举 backend 的 offset>=-256
            // 路径选择误判 → 大函数 locals 载/存槽错乱、数字比较普遍出错的根因）。
            // FCMP 后有符号条件码 lt/le/gt/ge 对有序比较正确。
            this.vm.fmovToFloat(0, VReg.RET);
            this.vm.fmovToFloat(1, VReg.V1);
            this.vm.fcmp(0, 1);
            // 浮点比较后的条件跳转必须用浮点专用跳转：x64 的 ucomisd 只设置
            // CF/ZF/PF（无符号风格标志），有符号 jl/jg 读的 SF/OF 被清零会全错；
            // 需要 jb/ja 等无符号跳转。arm64 上浮点跳转映射到与整数相同的 blt/bgt，
            // 保持字节不变。eq/ne 用 ZF，无需区分。
            const floatJump = { jlt: "jflt", jle: "jfle", jgt: "jfgt", jge: "jfge" }[jumpOp] || jumpOp;
            this.vm[floatJump](trueLabel);
        } else {
            this.vm.cmp(VReg.RET, VReg.V1);
            this.vm[jumpOp](trueLabel);
        }
        // 比较结果为 false，返回 _js_false
        this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
        this.vm.jmp(endLabel);
        this.vm.label(trueLabel);
        // 比较结果为 true，返回 _js_true
        this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
        this.vm.label(endLabel);
    },

    // 编译逻辑表达式 (&&, ||)
    compileLogicalExpression(expr) {
        const endLabel = this.ctx.newLabel("logical_end");
        const rightLabel = this.ctx.newLabel("logical_right");

        // 编译左操作数
        this.compileExpression(expr.left);

        if (expr.operator === "&&") {
            // x && y：x 为假值 → 返回 x（短路），否则返回 y。
            // 用完整 ToBoolean（undefined/null/0/""/false/NaN 都为假）
            this.vm.push(VReg.RET);         // 保留左值
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_to_boolean");    // RET = 0/1
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.pop(VReg.RET);          // 恢复左值
            this.vm.jeq(endLabel);          // 假 → 返回左值
            this.compileExpression(expr.right);
        } else if (expr.operator === "||") {
            // x || y：x 为真值 → 返回 x（短路），否则返回 y
            this.vm.push(VReg.RET);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_to_boolean");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.pop(VReg.RET);
            this.vm.jne(endLabel);          // 真 → 返回左值
            this.compileExpression(expr.right);
        } else if (expr.operator === "??") {
            // x ?? y：x 为 null/undefined → 返回 y，否则返回 x
            // [#70] 数值 0.0 位模式=裸 0，与 null 标识符发射的裸 0(members.js
            // movImm RET,0)运行时不可分辨。若左值编译期已知为数值类型(NUMBER/
            // 整型/浮点子类型),它绝不 nullish(数值永不为 null/undefined)→ 跳过
            // 运行时空值判定直接返回左值,避免把 `0 ?? x` 误判为 nullish。仅
            // 非数值/未知类型左值才走运行时裸-0=null 兜底(保 `null ?? x` 正确)。
            const leftType = inferType(expr.left, this.ctx);
            if (isIntType(leftType) || isFloatType(leftType)) {
                // 数值型左值:非 nullish,RET 已持左值,直落 endLabel
                this.vm.jmp(endLabel);
            } else {
                const useRightLabel = this.ctx.newLabel("nullish_right");
                this.vm.mov(VReg.V1, VReg.RET);
                this.vm.shrImm(VReg.V1, VReg.V1, 48);
                this.vm.cmpImm(VReg.V1, 0x7FFA); // null
                this.vm.jeq(useRightLabel);
                this.vm.cmpImm(VReg.V1, 0x7FFB); // undefined
                this.vm.jeq(useRightLabel);
                // [2026-07-14] 移除此前的 `cmpImm(RET,0)→null` 裸-0 兜底:null 现恒发
                // tagged 0x7FFA(见 members.js),裸 0 只可能是数值 0.0 → 绝不 nullish。
                // 旧检查把 `0 ?? x`(参数/未知类型的数值 0,位=裸 0)误判成 nullish。
                this.vm.jmp(endLabel);           // 非空 → 返回左值
                this.vm.label(useRightLabel);
                this.compileExpression(expr.right);
            }
        }

        this.vm.label(endLabel);
    },

    // 编译一元表达式
    compileUnaryExpression(expr) {
        // [#33] delete obj.prop / obj["k"] / obj[expr] —— 原先无 case 静默 no-op。
        // 走 _object_delete(移位保序,count--;IC 键自验证天然自愈)。
        // delete 普通变量/数组下标(稀疏洞语义)不支持 → 直接返回 true。
        if (expr.operator === "delete") {
            const darg = expr.argument;
            if (darg && darg.type === "MemberExpression") {
                const dName = !darg.computed
                    ? this.getMemberPropertyName(darg.property)
                    : ((darg.property.type === "Literal" || darg.property.type === "StringLiteral") &&
                       typeof darg.property.value === "string" ? String(darg.property.value) : null);
                if (dName !== null) {
                    this.compileExpression(darg.object);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.emitBoxedStringKey(dName, VReg.A1);
                    this.vm.call("_object_delete");
                    return;
                }
                // 动态键:_object_key_eq 内容比较兜底
                this.compileExpression(darg.property);
                this.vm.push(VReg.RET);
                this.compileExpression(darg.object);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.pop(VReg.A1);
                this.vm.call("_object_delete");
                return;
            }
            this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
            return;
        }
        // 负数字面量的常量折叠：直接使用预计算的否定 bits
        // 这样可以避免运行时 FNEG 指令的问题
        if (expr.operator === "-" && (expr.argument.type === "Literal" || expr.argument.type === "NumericLiteral") && typeof expr.argument.value === "number") {
            const posValue = expr.argument.value;
            const posBits = floatToInt64Bits(posValue);
            const negBits = negateFloat64Bits(posBits);
            // 直接调用 addFloat64 使用预计算的 bits
            const label = this.asm.addFloat64(-posValue, negBits);
            this.vm.lea(VReg.RET, label);
            this.vm.load(VReg.RET, VReg.RET, 0);
            return;
        }

        // 负 BigInt 字面量：编译内层字面量装箱正 bigint，再走运行时 i64 取负（_bigint_neg）。
        // 关键：不能在编译期算 -value——shipped 编译器(gen1)执行本 fold 时其一元负号作用于
        // BigInt 会坏（见 allocator.js:340）。运行时 helper 用裸 i64 sub，全代皆正确。
        // 否则落浮点 fneg 把 bigint 指针位当 double 取负得 -0.。
        if (expr.operator === "-" && (expr.argument.type === "Literal" || expr.argument.type === "NumericLiteral") && typeof expr.argument.value === "bigint") {
            this.compileExpression(expr.argument);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_bigint_neg");
            return;
        }

        // 常量折叠：typeof 数字字面量 = "number"
        if (expr.operator === "typeof" && (expr.argument.type === "Literal" || expr.argument.type === "NumericLiteral") && typeof expr.argument.value === "number") {
            const label = this.asm.addString("number");
            this.vm.lea(VReg.A0, label);
            this.vm.call("_js_box_string");
            return;
        }

        // 常量折叠：typeof 负数字面量 = "number" (typeof -17)
        if (expr.operator === "typeof" && expr.argument.type === "UnaryExpression" &&
            expr.argument.operator === "-" && (expr.argument.argument.type === "Literal" || expr.argument.argument.type === "NumericLiteral") &&
            typeof expr.argument.argument.value === "number") {
            const label = this.asm.addString("number");
            this.vm.lea(VReg.A0, label);
            this.vm.call("_js_box_string");
            return;
        }
        // [typeof 未解析名] 编译器完全解析不到的裸标识符 → 规范要求 typeof 返回
        // "undefined"(unresolvable reference 唯一不抛的上下文)。不这样做的话
        // compileIdentifier 兜底发裸 0,_typeof 把它判成 "number",
        // `typeof Float16Array !== "undefined"` 等特性探测恒真 → 垃圾值被当构造器
        // 使用 → SIGSEGV。判定见 members.js isUnresolvableIdentifier:已声明变量
        // (哪怕值就是 0)、内建名、成员/调用路径支持的全局名一律不走这里。
        if (expr.operator === "typeof" && expr.argument.type === "Identifier" &&
            this.isUnresolvableIdentifier && this.isUnresolvableIdentifier(expr.argument)) {
            const undefLabel = this.asm.addString("undefined");
            this.vm.lea(VReg.A0, undefLabel);
            this.vm.call("_js_box_string");
            return;
        }

        // !字面量 曾编译期用 `Boolean(val)` 折叠,但自举产物里该调用走本运行时 Boolean()
        // —— 对字面量恒 true → !0/!""/!null 误折叠成 false。删除折叠,统一走下方运行时
        // case "!"(_to_boolean),对变量/字面量均正确(!!var 已实测正确)。

        // 常量折叠：!标识符字面量 (undefined, NaN, Infinity)
        if (expr.operator === "!" && expr.argument.type === "Identifier") {
            if (expr.argument.name === "undefined" || expr.argument.name === "NaN") {
                // !undefined = true, !NaN = true
                this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                return;
            }
            if (expr.argument.name === "Infinity") {
                // !Infinity = false
                this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
                return;
            }
        }

        this.compileExpression(expr.argument);

        switch (expr.operator) {
            case "-":
                // BigInt 变量取负（-x，x 推断 BIGINT）：走运行时 i64 取负（浮点 fneg
                // 会把 bigint 指针位当 double 得 -0.）。字面量 -42n 已在上方常量折叠。
                if (inferType(expr.argument, this.ctx) === Type.BIGINT) {
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_bigint_neg");
                    break;
                }
                // 检查是否是整数类型
                if (this.isIntExpression(expr)) {
                    // 整数类型：使用整数运算
                    this.vm.mov(VReg.V1, VReg.RET);
                    this.vm.movImm(VReg.RET, 0);
                    this.vm.sub(VReg.RET, VReg.RET, VReg.V1);
                } else {
                    // 非数值(字符串/UNKNOWN)操作数先 ToNumber:此前直接 fmovToFloat 把串
                    // 指针位当 double → `-"7"`=NaN。数值类型保快路(免 coerce,护自举热路径/定点)。
                    const negT = inferType(expr.argument, this.ctx);
                    if (negT !== Type.FLOAT64 && negT !== Type.NUMBER && !isIntType(negT)) {
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_number_coerce");
                    }
                    // 浮点类型：使用浮点运算
                    // 将位模式移到浮点寄存器
                    this.vm.fmovToFloat(0, VReg.RET);
                    // 浮点取负
                    this.vm.fneg(0, 0);
                    // 移回整数寄存器
                    this.vm.fmovToInt(VReg.RET, 0);
                }
                break;
            case "!": {
                // NOT 操作符：返回 JS 布尔值 _js_false 或 _js_true
                // 需要正确处理所有 falsy 值: false, 0, -0, "", null, undefined, NaN
                // 使用 _to_boolean 运行时函数进行转换
                const notTruthyLabel = this.ctx.newLabel("not_truthy");
                const notEndLabel = this.ctx.newLabel("not_end");
                // 调用 _to_boolean: A0 = value, returns 0 (falsy) or 1 (truthy)
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_to_boolean");
                // RET = 0 (falsy) or 1 (truthy)
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jne(notTruthyLabel);
                // Value is falsy (RET==0), !falsy = true
                this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                this.vm.jmp(notEndLabel);
                // Value is truthy (RET==1), !truthy = false
                this.vm.label(notTruthyLabel);
                this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
                this.vm.label(notEndLabel);
                break;
            }
            case "~":
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_to_int32");
                // RET = ToInt32(x)
                this.vm.not(VReg.RET, VReg.RET);
                // 低 32 位符号扩展到 64 位有符号,再转 float64 JS number。此前 and 0xFFFFFFFF +
                // int32-tag 装箱得**无符号** 0xFFFFFFFA=4294967290(String(~5)/~5===-6/Math.abs 全错)。
                // 镜像 bitDispatch 的有符号收尾((v<<32)>>32 算术 + scvtf)。
                this.vm.shlImm(VReg.RET, VReg.RET, 32);
                this.vm.sarImm(VReg.RET, VReg.RET, 32);
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                break;
            case "+":
                // 一元加号：将值转换为数字（调用 _number_coerce 正确处理所有类型）
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_number_coerce");
                break;
            case "typeof":
                // 注意：参数表达式已在 switch 之前的 compileExpression 中编译，结果在 RET 中
                // 直接调用 _typeof 即可（RET 已经是我们要检查的值）
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_typeof");
                break;
            case "void":
                // void 运算符：计算表达式但返回 undefined
                // 先计算表达式（已经在 RET 中）
                // 然后返回 undefined
                // 加载 undefined 值到 RET
                this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
                break;
        }
    },

    // 编译条件表达式 a ? b : c
    compileConditionalExpression(expr) {
        const elseLabel = this.ctx.newLabel("cond_else");
        const endLabel = this.ctx.newLabel("cond_end");

        this.compileExpression(expr.test);
        // 用 _to_boolean 求真值（见 compileIfStatement）：`& 1` 对对象/数组/数字误判
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jeq(elseLabel);

        this.compileExpression(expr.consequent);
        this.vm.jmp(endLabel);

        this.vm.label(elseLabel);
        this.compileExpression(expr.alternate);

        this.vm.label(endLabel);
    },

    // 编译字符串连接
    compileStringConcat(expr) {
        // [#59] 严格左到右求值：先完全求值左操作数（含其副作用），再求右操作数。
        // 原码先编译右侧再左侧 → `fd()+","+d` 里普通变量 d 在同级调用 fd() 之前被读，
        // 得旧值（node 下 fd() 先跑改 d 再读）。改为左先压栈、右后压栈，
        // 弹栈时右在栈顶。_strconcat 契约不变（A0=left, A1=right）。
        // 编译左侧，转换为字符串
        this.compileExpressionToString(expr.left);
        this.vm.push(VReg.RET);

        // 编译右侧，转换为字符串
        this.compileExpressionToString(expr.right);
        this.vm.push(VReg.RET);

        // 弹出右侧到 A1（栈顶），左侧到 A0 (_strconcat expects A0=left, A1=right)
        this.vm.pop(VReg.A1);
        this.vm.pop(VReg.A0);
        // [L4.2 字符串原地拼接] 逃逸门控命中且本拼接即门控的 `s + E`(左侧为同名简单变量):
        // 发 _str_concat_ip(旧串为堆串且容量足 → 就地追加返同指针;守卫不满足则尾委托
        // _strconcat,逐字节等价)。名字守卫防嵌套拼接误命中(s + (a + b) 的内层 left=a)。
        const _ipVar = this.ctx._ipConcatVar;
        if (_ipVar && expr.left.type === "Identifier" && expr.left.name === _ipVar) {
            this.vm.call("_str_concat_ip");
        } else {
            this.vm.call("_strconcat");
        }
        // 结果按约定留在 RET；这里绝不能再 push（不配对的 push 会让
        // 栈错位 16 字节，epilogue 恢复到错误的 FP/LR 导致控制流损坏）
    },

    // 编译表达式并转换为字符串
    compileExpressionToString(expr) {
        let type = inferType(expr, this.ctx);

        // 对于 MemberExpression，尝试从对象字面量推断属性类型
        if (type === Type.UNKNOWN && expr.type === "MemberExpression") {
            const propType = this.inferMemberPropertyType(expr);
            if (propType !== Type.UNKNOWN) {
                type = propType;
            }
        }

        if (type === Type.STRING) {
            // 已经是字符串
            this.compileExpression(expr);
        } else if (type === Type.INT64 || type === Type.INT32 || isIntType(type) || type === Type.FLOAT64 || type === Type.NUMBER) {
            // 数字转字符串
            // 注意：compileExpression 对于 NumericLiteral 返回 raw float64 bits，
            // 对于变量/其他表达式返回 Number 对象指针（需要从 offset 8 加载）
            // 对于 BinaryExpression，算术运算返回 raw 数值（int 或 float），不是指针
            this.compileExpression(expr);
            // 检查是否是 NumericLiteral - 直接返回 float64 bits，不需要 load
            if (expr.type === "NumericLiteral" || expr.type === "Literal") {
                // NumericLiteral: RET 已经是 float64 bits
                // 非安全整数(小数 或 |v|>=2^53,含需指数记法的 >=1e21)→ 最短往返 _floatToString;
                // 安全整数保留 _intToStr(与编译器自编译逐字节一致,不扰确定性)。
                // 曾以 !Number.isInteger 分派:1e21 等大整数落 _intToStr 经 fcvtzs 饱和成
                // INT64_MAX,且 >=1e21 本应指数记法。
                if (typeof expr.value === "number" && !Number.isSafeInteger(expr.value)) {
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_floatToString");
                } else {
                    // 安全整数：调用 _intToStr
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.A0, 0);
                    this.vm.call("_intToStr");
                }
            } else if (expr.type === "BinaryExpression") {
                // BinaryExpression 现由 compileBinaryExpression 统一返回**装箱 JSValue**
                // (isIntOp 的 +/-/* 已补 intToFloat64Bits,见上文;比较/位运算/浮点算术本就
                // 装箱)。故此处走通用 _valueToStr——它按运行时表示正确渲染整数值/小数。
                // 【历史坑】旧代码对 isIntType 再 intToFloat64Bits(假定 RET 是裸 int),在
                // isIntOp 装箱修复后变成**双重转换**:把装箱 float64 位当整数再转 → `"x"+(i*i)`
                // 打印 float64 位模式的十进制(如 1.0→4607182418800017408)。删之。
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_valueToStr");
            } else {
                // 变量/成员访问等：编译期无法确定运行时表示（可能是 NaN-boxed
                // 整数、原始浮点位、或堆 Number 对象指针）。此前假定「Number 对象
                // 指针 + offset 8」会把 NaN-boxed/原始值当指针解引用而崩溃
                // （"x=" + n、"L=" + s.length 等）。改走运行时通用转换器
                // _valueToStr，它对上述所有表示都能正确处理。
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_valueToStr");
            }
        } else if (type === Type.BOOLEAN) {
            // 布尔值转字符串：走 _valueToStr（_boolToStr 返回裸数据段指针非堆字符串，
            // _strconcat 会当对象 → "[object Object]"；且 _boolToStr 判 ==0 对 JS_FALSE 也误判）。
            this.compileExpression(expr);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_valueToStr");
        } else {
            // 默认/UNKNOWN：对象属性访问可能返回 UNKNOWN
            // 调用运行时 _valueToStr 智能检测类型
            this.compileExpression(expr);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_valueToStr");
        }
    },

    // 推断 MemberExpression 属性类型
    inferMemberPropertyType(expr) {
        // 检查对象是否是标识符（变量）
        if (expr.object.type !== "Identifier") {
            return Type.UNKNOWN;
        }

        const objName = expr.object.name;
        const propName = expr.property.name || expr.property.value;

        // 检查变量的初始化表达式
        if (this.ctx.varInitExprs && this.ctx.varInitExprs[objName]) {
            const initExpr = this.ctx.varInitExprs[objName];
            if (initExpr.type === "ObjectExpression") {
                // 在对象字面量中查找属性
                for (const prop of initExpr.properties) {
                    // 扩展属性 { ...src } 无 key，跳过类型推断
                    if (!prop || !prop.key) continue;
                    const key = prop.key.name || prop.key.value;
                    if (key === propName) {
                        return inferType(prop.value, this.ctx);
                    }
                }
            }
        }

        return Type.UNKNOWN;
    },
};
