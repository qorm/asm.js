// asm.js 编译器 - Math 方法编译
// 从 builtin_methods.js 按功能拆出(2026-07-14):compileMathMethod / emitMinMaxStep /
// compileMathMinMaxSpread / compileMathHypot。方法通过 this 解析,与主 mixin 同一原型。

import { VReg } from "../../vm/index.js";

// Math 方法编译 Mixin
export const BuiltinMathMethodCompiler = {
    // 编译 Math 方法
    compileMathMethod(methodName, args) {
        if (methodName === "floor") {
            if (args.length > 0) {
                this.compileExpression(args[0]);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_math_floor");
            }
            return true;
        }

        if (methodName === "ceil") {
            if (args.length > 0) {
                this.compileExpression(args[0]);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_math_ceil");
            }
            return true;
        }

        if (methodName === "trunc") {
            if (args.length > 0) {
                this.compileExpression(args[0]);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_math_trunc");
            }
            return true;
        }

        if (methodName === "round") {
            if (args.length > 0) {
                this.compileExpression(args[0]);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_math_round");
            }
            return true;
        }

        if (methodName === "abs") {
            if (args.length > 0) {
                this.compileExpression(args[0]);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_math_abs");
            }
            return true;
        }

        if (methodName === "min" || methodName === "max") {
            // 全实参折叠 + NaN 传播 + 0参/空spread 恒等元。
            //  - 0 参:Math.max()→-Infinity、Math.min()→+Infinity(ES 恒等元)。
            //  - 任一实参 NaN → 结果 NaN(fcmp unordered 判 NaN,jnan;不用 x!==x,
            //    见 nan-int0-alias-trap)。NaN 输出用 signaling-NaN 位 0x7FF0…0001,
            //    high16=0x7FF0 < 0x7FF8 → 避开"装箱 int0"标签,打印为 "NaN"。
            //  - spread(Math.max(...arr)):构建 boxed 实参数组后逐元素折叠。
            //  操作数是 float64 位模式,必须用浮点比较(整数 cmp 对负数按位序会反转)。
            const isMin = methodName === "min";
            const hasSpread = args.some((a) => a && a.type === "SpreadElement");
            if (hasSpread) {
                this.compileMathMinMaxSpread(methodName, args);
            } else if (args.length === 0) {
                // 恒等元:min→+Inf(0x7FF0…),max→-Inf(0xFFF0…)
                this.vm.movImm64(VReg.RET, isMin ? 0x7FF0000000000000n : 0xFFF0000000000000n);
            } else if (args.length === 1) {
                this.compileExpression(args[0]);
            } else {
                this.compileExpression(args[0]); // RET = 累加器(首参)
                for (let k = 1; k < args.length; k++) {
                    this.vm.push(VReg.RET);
                    this.compileExpression(args[k]);
                    this.vm.pop(VReg.V1); // V1 = acc, RET = 本参
                    this.emitMinMaxStep(isMin); // RET = min/max(acc, 本参)，含 NaN 传播
                }
            }
            return true;
        }

        // [#33] Math.sign:内联 fcmp 三分支(此前无分派 → 落通用路径崩)。
        //  - NaN 输入 → NaN(fcmp unordered 判定,jnan;NaN 位用 0x7FF0…0001 避标签)。
        //  - ±0 输入 → 原样返回(±0,保号:sign(-0)=-0、sign(+0)=+0)。
        if (methodName === "sign") {
            if (args.length > 0) {
                this.compileExpression(args[0]);
                this.emitNumberCoerceFast(); // 归一化 raw float64,RET = x 位
                const negL = this.ctx.newLabel("msign_neg");
                const posL = this.ctx.newLabel("msign_pos");
                const nanL = this.ctx.newLabel("msign_nan");
                const endL = this.ctx.newLabel("msign_end");
                this.vm.fmovToFloat(0, VReg.RET);
                // NaN 检测:fcmp(x,x) unordered → jnan
                this.vm.fcmp(0, 0);
                this.vm.jnan(nanL);
                this.vm.movImm(VReg.V1, 0);
                this.vm.fmovToFloat(1, VReg.V1);
                this.vm.fcmp(0, 1);
                this.vm.jflt(negL);
                this.vm.jfgt(posL);
                // ±0:RET 已是 x 位(±0.0),原样返回保号
                this.vm.jmp(endL);
                this.vm.label(nanL);
                this.vm.movImm64(VReg.RET, 0x7FF0000000000001n); // NaN(打印为 NaN)
                this.vm.jmp(endL);
                this.vm.label(negL);
                this.vm.movImm64(VReg.RET, 0xbff0000000000000n); // -1.0
                this.vm.jmp(endL);
                this.vm.label(posL);
                this.vm.movImm64(VReg.RET, 0x3ff0000000000000n); // 1.0
                this.vm.label(endL);
            } else {
                this.vm.movImm64(VReg.RET, 0x7FF0000000000001n); // Math.sign() → NaN
            }
            return true;
        }

        // Math.hypot(a,b,...) = sqrt(Σ x²)。构建 boxed 实参数组后逐元素累加平方,末尾 fsqrt。
        if (methodName === "hypot") {
            this.compileMathHypot(args);
            return true;
        }

        // [#58/#64] Math.sqrt/log/cbrt/log2/log10/exp:coerce 成 raw f64 后转运行时
        // helper(A0=位 → RET=位)
        if (methodName === "sqrt" || methodName === "log" || methodName === "cbrt"
            || methodName === "log2" || methodName === "log10" || methodName === "exp"
            || methodName === "expm1" || methodName === "log1p"
            || methodName === "sinh" || methodName === "cosh" || methodName === "tanh"
            // [2026-07-16] 三角/反三角/反双曲/fround/clz32:同契约(coerce→A0 位→helper)。
            || methodName === "sin" || methodName === "cos" || methodName === "tan"
            || methodName === "asin" || methodName === "acos" || methodName === "atan"
            || methodName === "asinh" || methodName === "acosh" || methodName === "atanh"
            || methodName === "fround" || methodName === "clz32") {
            if (args.length > 0) {
                this.compileExpression(args[0]);
                this.emitNumberCoerceFast();
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_math_" + methodName);
                this.emitMathNanNormalize(); // 硬件 NaN(0x7FF8…)→ 可打印 0x7FF0…1
            } else {
                this.vm.movImm64(VReg.RET, 0x7ff0000000000001n); // 无参 → NaN(可打印)
            }
            return true;
        }

        // Math.atan2(y, x):A0=y 位、A1=x 位 → _math_atan2。
        if (methodName === "atan2") {
            if (args.length >= 2) {
                this.compileExpression(args[1]);   // x
                this.emitNumberCoerceFast();
                this.vm.push(VReg.RET);
                this.compileExpression(args[0]);   // y
                this.emitNumberCoerceFast();
                this.vm.mov(VReg.A0, VReg.RET);    // A0 = y
                this.vm.pop(VReg.A1);              // A1 = x
                this.vm.call("_math_atan2");
                this.emitMathNanNormalize(); // 硬件 NaN → 可打印
            } else {
                this.vm.movImm64(VReg.RET, 0x7ff0000000000001n); // 无参 → NaN(可打印)
            }
            return true;
        }

        // [#33] Math.pow(a,b):镜像 ** 运算符路径(此前无分派)
        if (methodName === "pow") {
            if (args.length >= 2) {
                this.compileExpression(args[1]);
                this.emitNumberCoerceFast();
                this.vm.push(VReg.RET); // exp
                this.compileExpression(args[0]);
                this.emitNumberCoerceFast(); // RET = base
                // _math_pow 契约:A0=base 位、A1=exp 位(内部自 fmov;返回 RET=位)
                this.vm.mov(VReg.A0, VReg.RET); // base
                this.vm.pop(VReg.A1); // exp
                this.vm.call("_math_pow");
                this.emitMathNanNormalize(); // 硬件 NaN → 可打印
            } else {
                this.vm.movImm(VReg.RET, 0);
            }
            return true;
        }

        // Math.imul(a,b):32 位整数乘法。ToInt32(a) * ToInt32(b),结果截为有符号 32 位。
        // 无运行时 helper——直接 _to_int32 取两操作数,mul 后掩低 32 位装箱为 int32。
        if (methodName === "imul") {
            if (args.length >= 2) {
                this.compileExpression(args[0]);
                if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_to_int32");          // RET = ToInt32(a)(符号扩展)
                this.vm.push(VReg.RET);
                this.compileExpression(args[1]);
                if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_to_int32");          // RET = ToInt32(b)
                this.vm.pop(VReg.V5);               // V5(R10)=a,避开 x64 A 参别名
                this.vm.mul(VReg.RET, VReg.RET, VReg.V5); // RET = a*b(64 位)
                // 截为有符号 32 位(低 32 位符号扩展),再按规范 boxIntAsNumber → 裸 float64 位。
                // (勿用 0x7FF8 int32-tag 装箱:负值经 &0xFFFFFFFF 掩码后是畸形位型,
                //  多参 console.log 非末位会按无符号 32 位打印,如 -15 → 4294967281。)
                this.vm.shlImm(VReg.RET, VReg.RET, 32);
                this.vm.sarImm(VReg.RET, VReg.RET, 32);
                this.boxIntAsNumber(VReg.RET);
            } else {
                this.vm.movImm(VReg.RET, 0);
                this.boxIntAsNumber(VReg.RET); // 缺参 → 0
            }
            return true;
        }

        return false;
    },

    // Math.min/max 单步折叠:V1 = 累加器(acc),RET = 本元素(elem),两者皆 raw f64 位。
    // 结果(min/max(acc,elem),含 NaN 传播)落 RET。任一为 NaN → RET = 打印友好 NaN 位。
    // NaN 归一(见 nan-int0-alias-trap):硬件浮点运算产的 qNaN 0x7FF8…(及带 payload 的
    // 0x7FF8…N)high16 落 [0x7FF8,0x7FFF],与 NaN-boxing 的装箱 int/bool/... tag 别名 →
    // 被打印/分派当整数(如 Math.sqrt(-1) 打 "0"、Math.exp(NaN) 打 "1")。凡 RET 为 NaN
    // (指数全 1 且尾数非零)统一成可打印 0x7FF0000000000001(high16=0x7FF0 走 raw-float 路,
    // _floatToString 检出 NaN);±Inf(尾数 0)与有限值原样保留。
    emitMathNanNormalize() {
        const vm = this.vm;
        const doneL = this.ctx.newLabel("mnn_done");
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne(doneL);                     // 指数非全 1 → 非 NaN/Inf
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(doneL);                     // 尾数 0 → ±Inf,保留
        vm.movImm64(VReg.RET, 0x7FF0000000000001n); // NaN → 可打印归一
        vm.label(doneL);
    },

    emitMinMaxStep(isMin) {
        const vm = this.vm;
        const id = this.nextLabelId();
        const keepAccL = `_mm_keep_${id}`;
        const nanL = `_mm_nan_${id}`;
        const endL = `_mm_end_${id}`;
        vm.fmovToFloat(0, VReg.V1);  // d0 = acc
        vm.fmovToFloat(1, VReg.RET); // d1 = elem
        // NaN 传播:任一操作数 NaN → 结果 NaN(fcmp unordered → jnan)
        vm.fcmp(1, 1);
        vm.jnan(nanL);               // elem 是 NaN
        vm.fcmp(0, 0);
        vm.jnan(nanL);               // acc 是 NaN
        vm.fcmp(0, 1);
        // min:acc<elem 保留 acc;max:acc>elem 保留 acc;相等/否则 elem 胜(RET 已是 elem)
        if (isMin) {
            vm.jflt(keepAccL);
        } else {
            vm.jfgt(keepAccL);
        }
        // elem 胜(acc 非严格更优)。但 fcmp 视 -0==+0,故相等且为 ±0 时须按 spec 定符号:
        // min 取 -0(任一为 -0),max 取 +0(任一为 +0)。判据:elem 为 ±0(elem<<1==0)时
        // acc 也为 ±0(已比较相等),合并符号位。elem 非零 → 原行为(RET=elem 不变)。
        vm.shlImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne(endL);                // elem 非零 → elem 胜,RET 不变
        if (isMin) {
            vm.or(VReg.V0, VReg.V1, VReg.RET);   // 任一 -0 → 结果 -0
        } else {
            vm.and(VReg.V0, VReg.V1, VReg.RET);  // 任一 +0 → 结果 +0
        }
        vm.movImm64(VReg.V2, 0x8000000000000000n);
        vm.and(VReg.RET, VReg.V0, VReg.V2);      // 仅留符号位 → ±0
        vm.jmp(endL);
        vm.label(keepAccL);
        vm.mov(VReg.RET, VReg.V1);   // acc 胜
        vm.jmp(endL);
        vm.label(nanL);
        vm.movImm64(VReg.RET, 0x7FF0000000000001n); // NaN(high16=0x7FF0,打印 "NaN")
        vm.label(endL);
    },

    // Math.min/max 的 spread 实参路径:构建 boxed 实参数组后逐元素折叠。
    // 累加器初值取恒等元(min→+Inf、max→-Inf),故空数组/0 元素天然得 ±Infinity。
    // 比较用浮点(数字为 raw f64 位),含 NaN 传播(见 emitMinMaxStep)。
    compileMathMinMaxSpread(methodName, args) {
        const vm = this.vm;
        const isMin = methodName === "min";
        // RET = 全部实参组成的 boxed 数组(spread + 普通混合,与调用/数组扩展同构)
        this.compileArrayExpressionWithSpread(args);
        const id = this.nextLabelId();
        const arrOff = this.ctx.allocLocal(`__mmax_arr_${id}`);
        const accOff = this.ctx.allocLocal(`__mmax_acc_${id}`);
        const idxOff = this.ctx.allocLocal(`__mmax_idx_${id}`);
        const lenOff = this.ctx.allocLocal(`__mmax_len_${id}`);
        vm.store(VReg.FP, arrOff, VReg.RET);

        // len = _array_length(arr)
        vm.load(VReg.A0, VReg.FP, arrOff);
        vm.call("_array_length");
        vm.store(VReg.FP, lenOff, VReg.RET);
        // acc = 恒等元(min→+Inf 0x7FF0…,max→-Inf 0xFFF0…)
        vm.movImm64(VReg.V0, isMin ? 0x7FF0000000000000n : 0xFFF0000000000000n);
        vm.store(VReg.FP, accOff, VReg.V0);
        // idx = 0
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.FP, idxOff, VReg.V0);

        const loopL = `_mmax_loop_${id}`;
        const doneL = `_mmax_done_${id}`;
        vm.label(loopL);
        vm.load(VReg.V0, VReg.FP, idxOff);
        vm.load(VReg.V1, VReg.FP, lenOff);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge(doneL);
        // elem = arr[idx]  (RET = boxed elem)
        vm.load(VReg.A0, VReg.FP, arrOff);
        vm.load(VReg.A1, VReg.FP, idxOff);
        vm.call("_array_get");
        // elem → raw f64(ToNumber):字符串 spread `Math.max(..."1234")` 的元素是字符串
        // 字符,须 coerce 成数字(否则 emitMinMaxStep 把字符串位当浮点 → NaN)。数字元素
        // 幂等。
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_number_coerce");
        // V1 = acc, RET = elem(raw f64)→ 折叠(结果落 RET)
        vm.load(VReg.V1, VReg.FP, accOff);
        this.emitMinMaxStep(isMin);
        vm.store(VReg.FP, accOff, VReg.RET);
        // idx++
        vm.load(VReg.V0, VReg.FP, idxOff);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.FP, idxOff, VReg.V0);
        vm.jmp(loopL);
        vm.label(doneL);
        vm.load(VReg.RET, VReg.FP, accOff);
    },

    // Math.hypot(a,b,...) = sqrt(Σ x²)。构建 boxed 实参数组,逐元素累加平方,末尾 fsqrt。
    // 元素为 raw f64 位;结果落 RET(raw f64)。空参 → sqrt(0) = 0(与 node 一致)。
    compileMathHypot(args) {
        const vm = this.vm;
        this.compileArrayExpressionWithSpread(args); // RET = boxed 实参数组
        const id = this.nextLabelId();
        const arrOff = this.ctx.allocLocal(`__hyp_arr_${id}`);
        const idxOff = this.ctx.allocLocal(`__hyp_idx_${id}`);
        const lenOff = this.ctx.allocLocal(`__hyp_len_${id}`);
        const sumOff = this.ctx.allocLocal(`__hyp_sum_${id}`);
        vm.store(VReg.FP, arrOff, VReg.RET);
        vm.load(VReg.A0, VReg.FP, arrOff);
        vm.call("_array_length");
        vm.store(VReg.FP, lenOff, VReg.RET);
        // sum = +0.0(位全零)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.FP, sumOff, VReg.V0);
        // idx = 0
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.FP, idxOff, VReg.V0);
        const loopL = `_hyp_loop_${id}`;
        const doneL = `_hyp_done_${id}`;
        vm.label(loopL);
        vm.load(VReg.V0, VReg.FP, idxOff);
        vm.load(VReg.V1, VReg.FP, lenOff);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge(doneL);
        vm.load(VReg.A0, VReg.FP, arrOff);
        vm.load(VReg.A1, VReg.FP, idxOff);
        vm.call("_array_get");        // RET = elem 位
        vm.fmovToFloat(1, VReg.RET);  // d1 = x
        vm.fmul(1, 1, 1);             // d1 = x*x
        vm.load(VReg.V1, VReg.FP, sumOff);
        vm.fmovToFloat(0, VReg.V1);   // d0 = sum
        vm.fadd(0, 0, 1);             // sum += x*x
        vm.fmovToInt(VReg.V0, 0);
        vm.store(VReg.FP, sumOff, VReg.V0);
        vm.load(VReg.V0, VReg.FP, idxOff);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.FP, idxOff, VReg.V0);
        vm.jmp(loopL);
        vm.label(doneL);
        vm.load(VReg.V1, VReg.FP, sumOff);
        vm.fmovToFloat(0, VReg.V1);
        vm.fsqrt(0, 0);               // sqrt(Σ x²)
        vm.fmovToInt(VReg.RET, 0);
        this.emitMathNanNormalize();  // 任一实参 NaN → sqrt(NaN)=硬件 NaN → 可打印归一
    },
};
