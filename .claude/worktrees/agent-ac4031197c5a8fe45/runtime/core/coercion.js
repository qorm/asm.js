// asm.js 运行时类型强制转换
// JavaScript 值转换函数
// NaN-boxing 方案

import { VReg } from "../../vm/index.js";
import { JS_NULL, JS_UNDEFINED, JS_FALSE, JS_TRUE, JS_TAG_BOOL_BASE, JS_TAG_INT32_BASE, JS_TAG_STRING_BASE, JS_TAG_OBJECT_BASE, JS_TAG_ARRAY_BASE, JS_TAG_FUNCTION_BASE, JS_PAYLOAD_MASK } from "./jsvalue.js";

const TYPE_NUMBER = 13;
const TYPE_FLOAT64 = 29;

export class CoercionGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        this.generateToBoolean();
        this.generateStrToNum();  // Must be before generateAbstractEq which calls _str_to_num
        this.generateNumberCoerce();  // Must be before abstractEq as it may call _str_to_num
        this.generateAbstractEq();
        this.generateStrictEq();
        this.generateToInt32();
        this.generateToUint32();
        this.generateJsAdd();
        this.generateSyscallArg();
        this.generateJsParseInt();
        this.generateBigInt();
        this.generateRelCmp();
        this.generateNaNCanon();
        this.generateBuiltinFns();
    }

    // [nan-int0] _nan_canon(A0=浮点位模式) -> RET:若是正区间别名 NaN(high16∈[0x7FF8,0x7FFF],
    // 硬件 quiet 后的 qNaN,与装箱 int/tag 位别名)则改写成非别名 NaN 0x7ff0000000000001
    // (high16=0x7FF0,打印 "NaN"、===/isNaN 语义正确);否则原样返回。二元浮点 -/*//% 结果
    // 在编译期无法静态排除 NaN 时由 operators.js 调用(委托而非内联,压缩产物足迹)。
    generateNaNCanon() {
        const vm = this.vm;
        vm.label("_nan_canon");
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_nan_canon_keep");   // < 0x7FF8:正有限数 / +Inf(0x7FF0)
        vm.cmpImm(VReg.V1, 0x8000);
        vm.jge("_nan_canon_keep");   // >= 0x8000:负 double(含 -NaN/-Inf,裸 float 打印正确)
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.ret();
        vm.label("_nan_canon_keep");
        vm.mov(VReg.RET, VReg.A0);
        vm.ret();
    }

    // ES 抽象关系比较(<,<=,>,>=)。此前关系运算对字符串操作数把串指针位当 float64
    // fcmp → unordered → 恒 false(`"a"<"b"` 错、编译器 library.js 的 `c>="a"` 亦坏,
    // 仅因 .jslib 解析非自举热路径才没炸)。
    // _js_relcmp(A0=left, A1=right) → RET 原始 int:0=相等、1=left<right、2=left>right、
    // 3=unordered(NaN)。两侧都是 String(tag 0x7FFC)→ 字节词典序(_strcmp);否则各
    // ToNumber(_number_coerce)后浮点比较(任一 NaN → 3)。4 个布尔 wrapper 供编译器调用。
    generateRelCmp() {
        const vm = this.vm;
        vm.label("_js_relcmp");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        // 两侧都是 String?
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_relcmp_num");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_relcmp_num");
        // 都是字符串:_strcmp(左内容, 右内容)→ 字节差
        vm.mov(VReg.A0, VReg.S0); vm.call("_getStrContent"); vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_getStrContent"); vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.call("_strcmp"); // RET = 有符号字节差
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_relcmp_lt");
        vm.jgt("_relcmp_gt");
        vm.movImm(VReg.RET, 0); // 相等
        vm.epilogue([VReg.S0, VReg.S1], 0);
        // 数值路径:各 ToNumber 后 fcmp
        vm.label("_relcmp_num");
        vm.mov(VReg.A0, VReg.S0); vm.call("_number_coerce"); vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_number_coerce");
        vm.fmovToFloat(1, VReg.RET);   // d1 = right
        vm.fmovToFloat(0, VReg.S0);    // d0 = left
        vm.fcmp(0, 0); vm.jnan("_relcmp_unord"); // left NaN
        vm.fcmp(1, 1); vm.jnan("_relcmp_unord"); // right NaN
        vm.fcmp(0, 1);
        vm.jflt("_relcmp_lt");
        vm.jfgt("_relcmp_gt");
        vm.movImm(VReg.RET, 0); // 相等
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_relcmp_lt"); vm.movImm(VReg.RET, 1); vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_relcmp_gt"); vm.movImm(VReg.RET, 2); vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_relcmp_unord"); vm.movImm(VReg.RET, 3); vm.epilogue([VReg.S0, VReg.S1], 0);

        // 4 个布尔 wrapper:call _js_relcmp,按编码返回 _js_true/_js_false。
        // lt:code==1;le:0 或 1;gt:2;ge:0 或 2。unordered(3)对全部为 false。
        const wrap = (label, trueCodes) => {
            vm.label(label);
            vm.prologue(0, []);
            vm.call("_js_relcmp"); // A0/A1 原样透传,RET = code
            const tL = label + "_t", eL = label + "_e";
            for (const c of trueCodes) { vm.cmpImm(VReg.RET, c); vm.jeq(tL); }
            vm.lea(VReg.RET, "_js_false"); vm.load(VReg.RET, VReg.RET, 0);
            vm.jmp(eL);
            vm.label(tL);
            vm.lea(VReg.RET, "_js_true"); vm.load(VReg.RET, VReg.RET, 0);
            vm.label(eL);
            vm.epilogue([], 0);
        };
        wrap("_js_lt", [1]);
        wrap("_js_le", [0, 1]);
        wrap("_js_gt", [2]);
        wrap("_js_ge", [0, 2]);
    }

    // ===== BigInt（64 位）=====
    // 表示：裸 user_ptr（高16=0）；[ptr-16] 低字节 = TYPE_BIGINT(14)；[ptr+0] = 64 位整数值。
    // 自举编译器 asm 层（movImm64/canEncodeImm/cmpImm）依赖它。asm 层 BigInt 均为正 64 位
    // 位模式，故 >> 用逻辑移位、比较用无符号。
    generateBigInt() {
        const vm = this.vm;
        const TYPE_BIGINT = 14;

        vm.label("_bigint_box");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        // x64 上 V0≡RET≡RAX：若把 header 读进 V0 会冲掉 _alloc 返回的指针(RET)，
        // 随后 store(RET,-16,...) 写向被破坏的地址 → 崩。改用 V2(RDX) 存 header。
        // arm64 上 V0(X8)/RET(X0) 不同，仍用 V0 以保持逐字节不变。
        const hdr = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
        vm.load(hdr, VReg.RET, -16);
        vm.movImm64(VReg.V1, 0xffffffffffffff00n);
        vm.and(hdr, hdr, VReg.V1);
        vm.movImm(VReg.V1, TYPE_BIGINT);
        vm.or(hdr, hdr, VReg.V1);
        vm.store(VReg.RET, -16, hdr);
        vm.store(VReg.RET, 0, VReg.S0);
        vm.epilogue([VReg.S0], 16);

        vm.label("_is_bigint");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_is_bigint_no");
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1); vm.jb("_is_bigint_no");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1); vm.jae("_is_bigint_no");
        vm.load(VReg.V0, VReg.S0, -16); vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, TYPE_BIGINT); vm.jne("_is_bigint_no");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 0);
        vm.label("_is_bigint_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);

        vm.label("_to_i64_lenient");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_to_i64_not_bi");
        vm.load(VReg.RET, VReg.S0, 0);
        vm.epilogue([VReg.S0], 16);
        vm.label("_to_i64_not_bi");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_to_int32");
        vm.epilogue([VReg.S0], 16);

        const bitDispatch = (label, biMethod, intMethod, useUint, maskCount) => {
            vm.label(label);
            vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
            vm.mov(VReg.S0, VReg.A0);
            vm.mov(VReg.S1, VReg.A1);
            vm.mov(VReg.A0, VReg.S0); vm.call("_is_bigint");
            vm.cmpImm(VReg.RET, 0); vm.jne(label + "_bi");
            vm.mov(VReg.A0, VReg.S1); vm.call("_is_bigint");
            vm.cmpImm(VReg.RET, 0); vm.jne(label + "_bi");
            const coerce = useUint ? "_to_uint32" : "_to_int32";
            vm.mov(VReg.A0, VReg.S0); vm.call(coerce); vm.mov(VReg.S2, VReg.RET);
            vm.mov(VReg.A0, VReg.S1); vm.call(coerce); vm.mov(VReg.S3, VReg.RET);
            // JS 规范:移位数按 & 31 取模(1<<33 ≡ 1<<1)。此前 64 位裸移位 count≥32
            // 恒清零(截断低 32 位后为 0)。仅移位需要;&/|/^ 共用本 dispatch 不掩。
            if (maskCount) vm.andImm(VReg.S3, VReg.S3, 31);
            vm[intMethod](VReg.RET, VReg.S2, VReg.S3);
            // 结果转成**裸 float64 位**返回（与算术 +-*/% 及数字字面量一致）。
            // 此前打 int32 tag(0x7FF8) → 与 float64 表示不一致：`x&m===0`、`(x>>16)!==0`
            // 等比较全错（_strict_eq 视 tagged 与 float 为不同类型），自举时编译器
            // movImm 的 `if((imm>>16)&65535 !== 0)` 恒为真 → 每条 movImm 多发 movk，
            // gen1 codegen 膨胀且错乱。
            if (useUint) {
                // 无符号 >>>：低 32 位零扩展（值域 0..2^32-1，仍 < 2^63，scvtf 正确）
                vm.movImm64(VReg.V1, 0xFFFFFFFFn); vm.and(VReg.RET, VReg.RET, VReg.V1);
            } else {
                // 有符号 & | ^ << >>：低 32 位符号扩展到 64 位 ((v<<32)>>32 算术)
                vm.shlImm(VReg.RET, VReg.RET, 32);
                vm.sarImm(VReg.RET, VReg.RET, 32);
            }
            vm.scvtf(0, VReg.RET);       // int64 -> float64
            vm.fmovToInt(VReg.RET, 0);   // float64 -> 裸位模式
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
            vm.label(label + "_bi");
            vm.mov(VReg.A0, VReg.S0); vm.call("_to_i64_lenient"); vm.mov(VReg.S2, VReg.RET);
            vm.mov(VReg.A0, VReg.S1); vm.call("_to_i64_lenient"); vm.mov(VReg.S3, VReg.RET);
            vm[biMethod](VReg.RET, VReg.S2, VReg.S3);
            vm.mov(VReg.A0, VReg.RET); vm.call("_bigint_box");
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        };
        bitDispatch("_js_band", "and", "and", false);
        bitDispatch("_js_bor", "or", "or", false);
        bitDispatch("_js_bxor", "xor", "xor", false);
        bitDispatch("_js_bshl", "shl", "shl", false, true);
        bitDispatch("_js_bshr", "shr", "sar", false, true);
        bitDispatch("_js_bushr", "shr", "shr", true, true);

        vm.label("_bigint_not");
        vm.prologue(16, [VReg.S0]);
        vm.call("_to_i64_lenient");
        vm.not(VReg.RET, VReg.RET);
        vm.mov(VReg.A0, VReg.RET); vm.call("_bigint_box");
        vm.epilogue([VReg.S0], 16);

        // 一元负号：0 - i64（裸整数取负，全代皆正确；JS 层 -bigint 在自举产物里坏）。
        vm.label("_bigint_neg");
        vm.prologue(16, [VReg.S0]);
        vm.call("_to_i64_lenient");
        vm.movImm(VReg.V1, 0);
        vm.sub(VReg.RET, VReg.V1, VReg.RET);
        vm.mov(VReg.A0, VReg.RET); vm.call("_bigint_box");
        vm.epilogue([VReg.S0], 16);

        // ===== BigInt 算术分派 - * / % ** =====
        // 仿 bitDispatch：两侧 _is_bigint 双真 → 原生 64 位有符号运算 → _bigint_box；
        // 否则回落浮点（混型/非 bigint，记偏差——标准 bigint±number 应 TypeError）。
        // 仅编译期静态可见 bigint 才路由至此（operators.js 保守守卫），普通数值零扰。
        const bigArith = (label, biOp, floatFn) => {
            vm.label(label);
            vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
            vm.mov(VReg.S0, VReg.A0);
            vm.mov(VReg.S1, VReg.A1);
            vm.mov(VReg.A0, VReg.S0); vm.call("_is_bigint");
            vm.cmpImm(VReg.RET, 0); vm.jeq(label + "_float");
            vm.mov(VReg.A0, VReg.S1); vm.call("_is_bigint");
            vm.cmpImm(VReg.RET, 0); vm.jeq(label + "_float");
            // 双 bigint：取 i64 值
            vm.mov(VReg.A0, VReg.S0); vm.call("_to_i64_lenient"); vm.mov(VReg.S2, VReg.RET);
            vm.mov(VReg.A0, VReg.S1); vm.call("_to_i64_lenient"); vm.mov(VReg.S3, VReg.RET);
            biOp();
            vm.mov(VReg.A0, VReg.RET); vm.call("_bigint_box");
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
            // 浮点回落：双方 _number_coerce → 裸 float64 位 → 浮点运算 → 裸位返回
            vm.label(label + "_float");
            vm.mov(VReg.A0, VReg.S0); vm.call("_number_coerce"); vm.mov(VReg.S2, VReg.RET);
            vm.mov(VReg.A0, VReg.S1); vm.call("_number_coerce"); vm.mov(VReg.S3, VReg.RET);
            floatFn();
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        };
        // 有符号 sub/mul：div 用 sdiv 截断向零(5n/2n=2n、-7n/2n=-3n)，mod 用 srem。
        bigArith("_js_bsub",
            () => vm.sub(VReg.RET, VReg.S2, VReg.S3),
            () => { vm.fmovToFloat(0, VReg.S2); vm.fmovToFloat(1, VReg.S3); vm.fsub(0, 0, 1); vm.fmovToInt(VReg.RET, 0); });
        bigArith("_js_bmul",
            () => vm.mul(VReg.RET, VReg.S2, VReg.S3),
            () => { vm.fmovToFloat(0, VReg.S2); vm.fmovToFloat(1, VReg.S3); vm.fmul(0, 0, 1); vm.fmovToInt(VReg.RET, 0); });
        bigArith("_js_bdiv",
            () => vm.div(VReg.RET, VReg.S2, VReg.S3),
            () => { vm.fmovToFloat(0, VReg.S2); vm.fmovToFloat(1, VReg.S3); vm.fdiv(0, 0, 1); vm.fmovToInt(VReg.RET, 0); });
        bigArith("_js_bmod",
            () => vm.mod(VReg.RET, VReg.S2, VReg.S3),
            () => { vm.fmovToFloat(0, VReg.S2); vm.fmovToFloat(1, VReg.S3); vm.fmod(0, 0, 1); vm.fmovToInt(VReg.RET, 0); });
        // 幂：快速幂（result=1；while exp>0: if exp&1 result*=base; base*=base; exp>>=1）。
        // exp<0（JS BigInt 应 RangeError）→ 循环不进入返回 1n（记偏差）。
        bigArith("_js_bpow",
            () => {
                // S2=base, S3=exp；用 V0=result, V1=exp, V2=base, V3=tmp
                vm.movImm(VReg.V0, 1);           // result = 1
                vm.mov(VReg.V1, VReg.S3);        // exp
                vm.mov(VReg.V2, VReg.S2);        // base
                vm.label("_js_bpow_loop");
                vm.cmpImm(VReg.V1, 0);
                vm.jle("_js_bpow_done");         // exp <= 0 结束
                vm.andImm(VReg.V3, VReg.V1, 1);  // exp & 1
                vm.cmpImm(VReg.V3, 0);
                vm.jeq("_js_bpow_skip");
                vm.mul(VReg.V0, VReg.V0, VReg.V2); // result *= base
                vm.label("_js_bpow_skip");
                vm.mul(VReg.V2, VReg.V2, VReg.V2); // base *= base
                vm.sarImm(VReg.V1, VReg.V1, 1);    // exp >>= 1
                vm.jmp("_js_bpow_loop");
                vm.label("_js_bpow_done");
                vm.mov(VReg.RET, VReg.V0);
            },
            () => { vm.mov(VReg.A0, VReg.S2); vm.mov(VReg.A1, VReg.S3); vm.call("_math_pow"); });

        vm.label("_bigint_to_number");
        vm.prologue(0, [VReg.S0]);
        vm.load(VReg.S0, VReg.A0, 0);
        vm.scvtf(0, VReg.S0);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);

        vm.label("_number_to_bigint");
        vm.prologue(0, [VReg.S0]);
        vm.call("_number_coerce");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.RET, 0);
        vm.mov(VReg.A0, VReg.RET); vm.call("_bigint_box");
        vm.epilogue([VReg.S0], 0);

        vm.label("_to_bigint");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_to_bigint_conv");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 16);
        vm.label("_to_bigint_conv");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_to_bigint");
        vm.epilogue([VReg.S0], 16);

        // 严格相等 ===：双 _is_bigint 守卫（否则盲读 [A1+0]，混型 10n===10 把 number
        // 位当指针野读段错误）。类型不同（一侧非 bigint）→ false（10n===10 → false）。
        vm.label("_bigint_strict_eq");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_bigint_streq_false");
        vm.mov(VReg.A0, VReg.S1); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_bigint_streq_false");
        vm.load(VReg.V0, VReg.S0, 0);
        vm.load(VReg.V1, VReg.S1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_bigint_streq_false");
        vm.lea(VReg.RET, "_js_true"); vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_bigint_streq_false");
        vm.lea(VReg.RET, "_js_false"); vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // BigInt→float 位（供 _abstract_eq 混型相等的数值近似）。bigint→i64→scvtf；
        // 非 bigint→_number_coerce。1n==1 → 1.0==1.0 → true（记偏差：0n==null 等边角错）。
        vm.label("_bi_to_f");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_bi_to_f_num");
        vm.load(VReg.RET, VReg.S0, 0);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0], 16);
        vm.label("_bi_to_f_num");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_coerce");
        vm.epilogue([VReg.S0], 16);

        // 关系比较 < <= > >= → -1/0/1。双 _is_bigint 守卫（否则混型 1n<2 把 number
        // 位当指针野读段错误）。双 bigint 走**有符号** 64 位比较（用户 bigint 有符号，
        // 负 bigint 正确）；asm 层唯一依赖无符号的 canEncodeImm 已加 `>=0n` 守卫消歧
        // （rotated 可含高位，见 asm/arm64.js）。混型→数值近似（记偏差）。
        vm.label("_bigint_cmp");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_bigint_cmp_mixed");
        vm.mov(VReg.A0, VReg.S1); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_bigint_cmp_mixed");
        vm.load(VReg.S0, VReg.S0, 0);
        vm.load(VReg.S1, VReg.S1, 0);
        vm.cmp(VReg.S0, VReg.S1);
        vm.jlt("_bigint_cmp_lt"); // 有符号
        vm.jgt("_bigint_cmp_gt"); // 有符号
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_bigint_cmp_lt");
        vm.movImm64(VReg.RET, 0xffffffffffffffffn);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_bigint_cmp_gt");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        // 混型：1n<2 数值近似——双方 _bi_to_f → fcmp（浮点条件码 jflt/jfgt）
        vm.label("_bigint_cmp_mixed");
        vm.mov(VReg.A0, VReg.S0); vm.call("_bi_to_f"); vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_bi_to_f"); vm.mov(VReg.S1, VReg.RET);
        vm.fmovToFloat(0, VReg.S0);
        vm.fmovToFloat(1, VReg.S1);
        vm.fcmp(0, 1);
        vm.jflt("_bigint_cmp_lt");
        vm.jfgt("_bigint_cmp_gt");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _js_parseInt(A0 = 字符串, A1 = radix JSValue) -> float64 位模式整数
    // 支持前导空白、+/- 符号、radix 2-36、radix=0/undefined 时默认 10（0x 前缀自动 16）。
    // 解析前导整数，遇非法字符即停；无有效数字返回 NaN。自举编译器 parseNumberLiteral
    // 与 lexer 的 \xNN/\uNNNN 转义都依赖它。
    generateJsParseInt() {
        const vm = this.vm;
        vm.label("_js_parseInt");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        // 取字符串内容指针
        vm.push(VReg.A1);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = char*
        vm.pop(VReg.A0);
        vm.call("_to_int32");
        vm.mov(VReg.S1, VReg.RET); // S1 = radix

        // 跳过前导空白
        vm.label("_pi_ws");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 32);
        vm.jeq("_pi_ws_skip");
        vm.cmpImm(VReg.V0, 9);
        vm.jeq("_pi_ws_skip");
        vm.cmpImm(VReg.V0, 10);
        vm.jeq("_pi_ws_skip");
        vm.cmpImm(VReg.V0, 13);
        vm.jeq("_pi_ws_skip");
        vm.jmp("_pi_sign");
        vm.label("_pi_ws_skip");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pi_ws");

        // 符号
        vm.label("_pi_sign");
        vm.movImm(VReg.S3, 1); // S3 = 符号
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 45); // '-'
        vm.jne("_pi_plus");
        vm.movImm(VReg.S3, -1);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pi_radix");
        vm.label("_pi_plus");
        vm.cmpImm(VReg.V0, 43); // '+'
        vm.jne("_pi_radix");
        vm.addImm(VReg.S0, VReg.S0, 1);

        // radix 归一化
        vm.label("_pi_radix");
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_pi_radix16");
        // radix=0：默认 10，若 0x 前缀则 16
        vm.movImm(VReg.S1, 10);
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 48); // '0'
        vm.jne("_pi_digits");
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.cmpImm(VReg.V1, 120); // 'x'
        vm.jeq("_pi_auto16");
        vm.cmpImm(VReg.V1, 88); // 'X'
        vm.jeq("_pi_auto16");
        vm.jmp("_pi_digits");
        vm.label("_pi_auto16");
        vm.movImm(VReg.S1, 16);
        vm.addImm(VReg.S0, VReg.S0, 2);
        vm.jmp("_pi_digits");
        // radix 明确：若为 16 跳过可选 0x
        vm.label("_pi_radix16");
        vm.cmpImm(VReg.S1, 16);
        vm.jne("_pi_digits");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 48);
        vm.jne("_pi_digits");
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.cmpImm(VReg.V1, 120);
        vm.jeq("_pi_skip0x");
        vm.cmpImm(VReg.V1, 88);
        vm.jne("_pi_digits");
        vm.label("_pi_skip0x");
        vm.addImm(VReg.S0, VReg.S0, 2);

        // 解析数字
        vm.label("_pi_digits");
        vm.movImm(VReg.S2, 0); // 结果
        vm.movImm(VReg.S4, 0); // 数字个数
        vm.label("_pi_loop");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        // 计算数字值 V1（非法 → 跳出）
        vm.cmpImm(VReg.V0, 48);
        vm.jlt("_pi_end"); // < '0'
        vm.cmpImm(VReg.V0, 58);
        vm.jge("_pi_upper"); // >= ':'
        vm.subImm(VReg.V1, VReg.V0, 48); // 0-9
        vm.jmp("_pi_got");
        vm.label("_pi_upper");
        vm.cmpImm(VReg.V0, 65);
        vm.jlt("_pi_end"); // < 'A'
        vm.cmpImm(VReg.V0, 91);
        vm.jge("_pi_lower"); // >= '['
        vm.subImm(VReg.V1, VReg.V0, 55); // A-Z → 10-35
        vm.jmp("_pi_got");
        vm.label("_pi_lower");
        vm.cmpImm(VReg.V0, 97);
        vm.jlt("_pi_end"); // < 'a'
        vm.cmpImm(VReg.V0, 123);
        vm.jge("_pi_end"); // >= '{'
        vm.subImm(VReg.V1, VReg.V0, 87); // a-z → 10-35
        vm.label("_pi_got");
        // digit >= radix → 停止
        vm.cmp(VReg.V1, VReg.S1);
        vm.jge("_pi_end");
        // result = result*radix + digit
        vm.mul(VReg.S2, VReg.S2, VReg.S1);
        vm.add(VReg.S2, VReg.S2, VReg.V1);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pi_loop");

        vm.label("_pi_end");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_pi_nan"); // 无有效数字
        vm.scvtf(0, VReg.S2); // FP0 = float(result)
        vm.cmpImm(VReg.S3, -1);
        vm.jne("_pi_conv");
        vm.fneg(0, 0);
        vm.label("_pi_conv");
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        vm.label("_pi_nan");
        // 无有效数字 → NaN。用非别名 NaN 位 0x7FF0…01(canonical 0x7FF8 与装箱 int0 同构会
        // 打印成 0,见 nan-int0)。编译器 parseInt 恒作用于有数字串,不触此路。
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        // parseFloat(str):置宽松位 → _str_to_num(尾部垃圾忽略,解析前缀)→ 复位。
        // parseFloat("3.14px")=3.14、"100%"=100、"42px"=42。纯垃圾/无前导数字 → 沿用
        // _str_to_num 无效路径(与 Number 同,记偏差)。A0=字符串,V0/V1 置位不碰 A0。
        vm.label("_js_parseFloat");
        vm.prologue(16, [VReg.S0]);
        vm.lea(VReg.V0, "_parse_lenient");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);   // 宽松位 = 1
        vm.call("_str_to_num");          // A0 已是字符串
        vm.mov(VReg.S0, VReg.RET);       // 保存结果
        vm.lea(VReg.V0, "_parse_lenient");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);   // 复位
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 16);
    }

    // 内置转换函数的可调用版本（供 filter(Boolean) 等一等函数传递）
    // 调用约定：A0 = 参数（方法回调时 element 在 A0），返回 JSValue
    generateBuiltinFns() {
        const vm = this.vm;

        // _builtin_boolean(x) -> _js_true / _js_false
        vm.label("_builtin_boolean");
        vm.prologue(16, [VReg.S0]);
        vm.call("_to_boolean"); // RET = 0/1
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_builtin_boolean_false");
        vm.movImm64(VReg.RET, JS_TRUE);
        vm.epilogue([VReg.S0], 16);
        vm.label("_builtin_boolean_false");
        vm.movImm64(VReg.RET, JS_FALSE);
        vm.epilogue([VReg.S0], 16);

        // _builtin_number(x) -> 数值（_number_coerce 结果的 float 位）
        vm.label("_builtin_number");
        vm.prologue(16, [VReg.S0]);
        vm.call("_number_coerce");
        vm.epilogue([VReg.S0], 16);

        // _builtin_string(x) -> 装箱字符串
        vm.label("_builtin_string");
        vm.prologue(16, [VReg.S0]);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0], 16);
    }

    /**
     * _syscall_arg: 把 JS 值转换为可直接进内核的 64 位参数
     * - 高16位 == 0: 裸指针/裸整数，直通
     * - 0x7FFC (字符串): 取 payload（内容指针）
     * - 其他 tagged (0x7FF8-0x7FFF): 取 payload
     * - 其余（float64 位模式）: fcvtzs 转整数
     */
    generateSyscallArg() {
        const vm = this.vm;

        vm.label("_syscall_arg");
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_syscall_arg_raw");
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_syscall_arg_float");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jgt("_syscall_arg_float");
        // tagged: 取 payload
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        vm.ret();

        vm.label("_syscall_arg_float");
        vm.fmovToFloat(0, VReg.A0);
        vm.fcvtzs(VReg.RET, 0);
        vm.ret();

        vm.label("_syscall_arg_raw");
        // 裸指针可能是堆上的装箱 Number（NUMBER 类型算术路径会 boxNumber），
        // 此时必须取出数值而不是把指针当整数（曾把指针当 _alloc 尺寸弹飞堆）
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_syscall_arg_raw_ret");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jlt("_syscall_arg_raw_ret");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jge("_syscall_arg_raw_ret");
        vm.load(VReg.V1, VReg.A0, -16);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 13); // TYPE_NUMBER：块内存的是 raw int64，直接取
        vm.jeq("_syscall_arg_heapint");
        vm.cmpImm(VReg.V1, 29); // TYPE_FLOAT64：块内存的是 float64 位，需 fcvtzs
        vm.jeq("_syscall_arg_heapfloat");
        vm.label("_syscall_arg_raw_ret");
        vm.mov(VReg.RET, VReg.A0);
        vm.ret();

        vm.label("_syscall_arg_heapint");
        vm.load(VReg.RET, VReg.A0, -8);
        vm.ret();

        vm.label("_syscall_arg_heapfloat");
        vm.load(VReg.V1, VReg.A0, -8);
        vm.fmovToFloat(0, VReg.V1);
        vm.fcvtzs(VReg.RET, 0);
        vm.ret();

        // _syscall_ptr: 归一化一个**已知是裸地址**的指针参数（__setChar/__getChar 的 ptr）。
        // 与 _syscall_arg 的唯一区别：high16==0 时直接返回原值，绝不把它当堆上的装箱
        // Number 去解引用。_syscall_arg 对裸指针会读 [ptr-16] 类型字节，若恰为 13
        // (TYPE_NUMBER) / 29 (TYPE_FLOAT64) 就误判为装箱数并返回 [ptr-8] → 野指针。
        // 往字节缓冲区写变化的数据（如二进制文件）必然出现 13/29 字节，故必须区分。
        vm.label("_syscall_ptr");
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_syscall_ptr_raw");        // 裸地址：原样返回
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_syscall_ptr_float");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jgt("_syscall_ptr_float");
        // tagged：取 payload
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        vm.ret();

        vm.label("_syscall_ptr_float");
        vm.fmovToFloat(0, VReg.A0);
        vm.fcvtzs(VReg.RET, 0);
        vm.ret();

        vm.label("_syscall_ptr_raw");
        vm.mov(VReg.RET, VReg.A0);
        vm.ret();
    }

    /**
     * _js_add: JS `+` 运算符的运行时动态分派
     * 输入: A0 = JSValue x, A1 = JSValue y
     * 输出: RET = 结果（数值路径返回 raw float64 位；字符串路径返回 0x7FFC 装箱字符串）
     *
     * 规则（简化版 ECMAScript）:
     * - 任一操作数是字符串（0x7FFC 装箱 / 堆字符串裸指针）→ ToString 双方后 _strconcat
     * - 否则 → _number_coerce 双方后浮点加法
     */
    generateJsAdd() {
        const vm = this.vm;

        vm.label("_js_add");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // x
        vm.mov(VReg.S1, VReg.A1); // y

        // [快路] 两侧都明确是 raw double → 直接 fadd,跳过 string/bigint(两次 _is_bigint
        // 调用)/指针整数三段判别。判据:high16 != 0(排 +0.0/裸指针歧义)且 (high16 &
        // 0xfff8) != 0x7ff8(排所有 NaN-box tag:int/bool/undef/str/obj/arr/bigint 箱)。
        // 保守——歧义值(high16=0)与 tag 值落原通用路径,语义不变;数值 reduction
        // (s+a[i]/s+o.x/s+i)命中免全函数分派开销。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_js_add_slow");
        vm.andImm(VReg.V1, VReg.V0, 0xfff8);
        vm.cmpImm(VReg.V1, 0x7ff8);
        vm.jeq("_js_add_slow");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_js_add_slow");
        vm.andImm(VReg.V1, VReg.V0, 0xfff8);
        vm.cmpImm(VReg.V1, 0x7ff8);
        vm.jeq("_js_add_slow");
        vm.fmovToFloat(0, VReg.S0);
        vm.fmovToFloat(1, VReg.S1);
        vm.fadd(0, 0, 1);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_js_add_slow");
        // 对象(0x7FFD)/数组(0x7FFE)操作数先 ToPrimitive(default):对象 valueOf→toString、
        // 数组 → _valueToStr(逗号连接串)。结果(串/数)再走下方常规 string/numeric 分派。
        // 此前对象/数组直接落数值 → NaN(`1+[1,2]`、`{valueOf}+8` 等)。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_js_add_x_not_obj");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_toprimitive");
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_js_add_check_y_prim");
        vm.label("_js_add_x_not_obj");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_js_add_check_y_prim");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_js_add_check_y_prim");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_js_add_y_not_obj");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_toprimitive");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_js_add_slow_strchk");
        vm.label("_js_add_y_not_obj");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_js_add_slow_strchk");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_js_add_slow_strchk");
        // --- x 是字符串? ---
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); // 装箱字符串
        vm.jeq("_js_add_concat");
        vm.cmpImm(VReg.V0, 0);       // 裸指针候选（堆字符串）
        vm.jne("_js_add_check_y");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_js_add_check_y");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_js_add_check_y");
        vm.subImm(VReg.V1, VReg.S0, 16);
        vm.load(VReg.V1, VReg.V1, 0); // user_ptr-16 处是类型
        vm.cmpImm(VReg.V1, 6); // TYPE_STRING
        vm.jeq("_js_add_concat");

        vm.label("_js_add_check_y");
        // --- y 是字符串? ---
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_js_add_concat");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_js_add_numeric");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_js_add_numeric");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jge("_js_add_numeric");
        vm.subImm(VReg.V1, VReg.S1, 16);
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 6);
        vm.jeq("_js_add_concat");

        vm.label("_js_add_numeric");
        // BigInt 双真：两侧都是 bigint → i64 加 → box。必须前置于下方 ptr_int 判断，
        // 否则 bigint 箱（裸 user_ptr）被当指针相加 → "0."（现状 bug）。
        vm.mov(VReg.A0, VReg.S0); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_js_add_num_ptr");
        vm.mov(VReg.A0, VReg.S1); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_js_add_num_ptr");
        vm.load(VReg.V0, VReg.S0, 0); // 左 i64 值（user_ptr+0）
        vm.load(VReg.V1, VReg.S1, 0); // 右 i64 值
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.mov(VReg.A0, VReg.V0); vm.call("_bigint_box");
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_js_add_num_ptr");
        // 指针整数路径：任一侧是裸指针（高16位=0 且 >= 4GB）且不是
        // 堆上的 Number 对象（type 13/29，.length 等路径产出的装箱数），
        // 走整数加法（指针运算 buf+i），绝不能按浮点位处理
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_js_add_check_ptr_y");
        vm.movImm64(VReg.V1, vm.ptrFloor); // 裸指针下界随目标格式(linux 0x400000/macos 0x100000000)
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_js_add_check_ptr_y");
        // 堆 Number 排除
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_js_add_ptr_int");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_js_add_ptr_int");
        vm.load(VReg.V1, VReg.S0, -16);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 13); // TYPE_NUMBER
        vm.jeq("_js_add_check_ptr_y");
        vm.cmpImm(VReg.V1, 29); // TYPE_FLOAT64
        vm.jeq("_js_add_check_ptr_y");
        vm.jmp("_js_add_ptr_int");
        vm.label("_js_add_check_ptr_y");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_js_add_float_path");
        vm.movImm64(VReg.V1, vm.ptrFloor); // 裸指针下界随目标格式(linux 0x400000/macos 0x100000000)
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_js_add_float_path");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_js_add_ptr_int");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jge("_js_add_ptr_int");
        vm.load(VReg.V1, VReg.S1, -16);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 13);
        vm.jeq("_js_add_float_path");
        vm.cmpImm(VReg.V1, 29);
        vm.jeq("_js_add_float_path");
        vm.jmp("_js_add_ptr_int");

        vm.label("_js_add_ptr_int");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_syscall_arg"); // 归一化为整数
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_syscall_arg");
        vm.add(VReg.RET, VReg.S0, VReg.RET);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_js_add_float_path");
        // 数值路径：双方 _number_coerce 后浮点加
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_coerce");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_number_coerce");
        vm.mov(VReg.S1, VReg.RET);
        vm.fmovToFloat(0, VReg.S0);
        vm.fmovToFloat(1, VReg.S1);
        vm.fadd(0, 0, 1);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_js_add_concat");
        // 字符串路径：双方 ToString 后拼接
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strconcat");
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    /**
     * _abstract_eq: 抽象相等比较 (==)
     * 输入: A0 = JSValue x, A1 = JSValue y
     * 输出: RET = JS_TRUE (0x7FF9000000000001) 或 JS_FALSE (0x7FF9000000000002)
     *
     * ECMAScript 抽象相等比较规则:
     * 1. 如果 Type(x) == Type(y),同类型比较
     *    - Number: 浮点比较
     *    - String: 指针比较
     *    - Boolean: 比较原始布尔值
     *    - Null/Undefined: 返回 true
     *    - Object: 引用比较
     * 2. Number == String: 转换 String 为 Number
     * 3. Boolean == 任何: Boolean 转 Number (true=1, false=0)
     * 4. String/Number == Object: Object 转原始值
     */
    generateAbstractEq() {
        const vm = this.vm;

        vm.label("_abstract_eq");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        // 保存参数
        vm.mov(VReg.S0, VReg.A0); // x
        vm.mov(VReg.S1, VReg.A1); // y

        // 1. 如果位模式一致,除了 Float 之外都相等
        // 注意:NaN != NaN 在 JS 中成立
        vm.cmp(VReg.S0, VReg.S1);
        vm.jne("_ae_not_same_bits");

        // 位模式一致,检查是否是 float
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7ff8);
        vm.jge("_ae_same_bits_not_float");

        // 是 float 且位模式一致:检查是否是 NaN
        vm.fmovToFloat(0, VReg.S0);
        vm.fcmp(0, 0); // NaN 检测 (NaN != NaN)
        vm.jeq("_abstract_eq_true");
        vm.jmp("_abstract_eq_false");

        vm.label("_ae_same_bits_not_float");
        vm.jmp("_abstract_eq_true");

        vm.label("_ae_not_same_bits");

        // BigInt 混型相等（==）：任一侧 bigint → 数值近似比较（1n==1 → true）。
        // 必须前置于下方类型分类——bigint 是裸 user_ptr(高16=0),分类器会误判为 Float
        // 而把指针位当浮点读。记偏差：0n==null 等边角与标准不符。
        vm.mov(VReg.A0, VReg.S0); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jne("_ae_bigint_mixed");
        vm.mov(VReg.A0, VReg.S1); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jne("_ae_bigint_mixed");
        vm.jmp("_ae_after_bigint");
        vm.label("_ae_bigint_mixed");
        vm.mov(VReg.A0, VReg.S0); vm.call("_bi_to_f"); vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_bi_to_f"); vm.mov(VReg.S5, VReg.RET);
        vm.fmovToFloat(0, VReg.S4); vm.fmovToFloat(1, VReg.S5);
        vm.fcmp(0, 1);
        vm.jeq("_abstract_eq_true");
        vm.jmp("_abstract_eq_false");
        vm.label("_ae_after_bigint");

        // 2. 识别 x 和 y 的类型
        // S2 = x's type, S3 = y's type

        // --- Get X Type ---
        vm.shrImm(VReg.V0, VReg.S0, 48);
        // Check for String tag FIRST (0x7FFC) before tagged check
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_ae_x_is_string");
        // 负浮点(高16≥0x8000,符号位置位)是 Float,不是 tagged。否则 -0.0/-104 等被误分类
        // → `-0==0` 错判 false、`-104==null` 类误判(镜像 _strict_eq 同修)。
        vm.cmpImm(VReg.V0, 0x8000);
        vm.jge("_ae_x_float_2");
        vm.cmpImm(VReg.V0, 0x7ff8);
        vm.jge("_ae_x_tagged");
        vm.cmpImm(VReg.V0, 0x1000);
        vm.jge("_ae_x_data_ptr");
        vm.movImm(VReg.S2, 0); // Float
        vm.jmp("_ae_x_done");
        vm.label("_ae_x_data_ptr");
        vm.cmpImm(VReg.V0, 0x1002);
        vm.jge("_ae_x_float_2");
        vm.movImm(VReg.S2, 5); // String
        vm.jmp("_ae_x_done");
        vm.label("_ae_x_float_2");
        vm.movImm(VReg.S2, 0); // Float
        vm.jmp("_ae_x_done");
        vm.label("_ae_x_is_string");
        vm.movImm(VReg.S2, 5); // String
        vm.jmp("_ae_x_done");
        vm.label("_ae_x_tagged");
        vm.subImm(VReg.V0, VReg.V0, 0x7ff8);
        vm.addImm(VReg.S2, VReg.V0, 1);
        vm.label("_ae_x_done");

        // --- Get Y Type ---
        vm.shrImm(VReg.V1, VReg.S1, 48);
        // Check for String tag FIRST (0x7FFC) before tagged check
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_ae_y_is_string");
        // 负浮点(高16≥0x8000)是 Float,不是 tagged(同 x 侧修)。
        vm.cmpImm(VReg.V1, 0x8000);
        vm.jge("_ae_y_float_2");
        vm.cmpImm(VReg.V1, 0x7ff8);
        vm.jge("_ae_y_tagged");
        vm.cmpImm(VReg.V1, 0x1000);
        vm.jge("_ae_y_data_ptr");
        vm.movImm(VReg.S3, 0); // Float
        vm.jmp("_ae_y_done");
        vm.label("_ae_y_data_ptr");
        vm.cmpImm(VReg.V1, 0x1002);
        vm.jge("_ae_y_float_2");
        vm.movImm(VReg.S3, 5); // String
        vm.jmp("_ae_y_done");
        vm.label("_ae_y_float_2");
        vm.movImm(VReg.S3, 0); // Float
        vm.jmp("_ae_y_done");
        vm.label("_ae_y_is_string");
        vm.movImm(VReg.S3, 5); // String
        vm.jmp("_ae_y_done");
        vm.label("_ae_y_tagged");
        vm.subImm(VReg.V1, VReg.V1, 0x7ff8);
        vm.addImm(VReg.S3, VReg.V1, 1);
        vm.label("_ae_y_done");

        // Types map: 0:Float, 1:Int32, 2:Bool, 3:Null, 4:Undef, 5:String, 6:Obj, 7:Arr, 8:Func

        // 2. null == undefined
        vm.cmpImm(VReg.S2, 3); // null
        vm.jne("_ae_x_not_null");
        vm.cmpImm(VReg.S3, 4); // y is undef?
        vm.jeq("_abstract_eq_true");
        vm.label("_ae_x_not_null");
        vm.cmpImm(VReg.S2, 4); // x is undef?
        vm.jne("_ae_x_not_undef");
        vm.cmpImm(VReg.S3, 3); // y is null?
        vm.jeq("_abstract_eq_true");
        vm.label("_ae_x_not_undef");

        // 3. String == Number -> Number(String) == Number
        // 类型分派入口:布尔转数后 jmp 回此,让「String==Number」case 重新触发
        // (`""==false` → false 转 Int0 → 回此 → x String 且 y 现为 Number → 转数 → 0==0)。
        vm.label("_ae_type_dispatch");
        // 两侧都是对象类(Obj=6/Arr=7/Func=8):抽象相等即引用相等,不做 ToPrimitive。
        // 位模式已知不同(早已过 _ae_not_same_bits,相同引用在此前返回 true)→ 直接 false。
        // 缺此守卫会对双对象各做 ToPrimitive→串:`{}=={}`→"[object Object]"=="[object Object]"、
        // `[]==[]`→""==""、`[1]==[1]`→"1"=="1" 全误判 true(应 false)。转换后至少一侧
        // 变 String/Number(<6),loop 回入时不再命中本守卫,故只在初始双对象时触发。
        vm.cmpImm(VReg.S2, 6);
        vm.jlt("_ae_not_both_obj");
        vm.cmpImm(VReg.S3, 6);
        vm.jlt("_ae_not_both_obj");
        vm.jmp("_abstract_eq_false");
        vm.label("_ae_not_both_obj");
        // 数组(7)/对象(6) == 原始值:先 ToPrimitive(default)。数组 → _valueToStr(逗号串,类型 5),
        // 对象 → _js_toprimitive(串则 5、否则当 Float 0)。转后 jmp 回本分派让 String==Number 等再触发。
        // (`[]==false`→""==false→0==0、`[1]==1`→"1"==1)。转后 S2/S3 不再是 6/7 → 不重转,收敛。
        vm.cmpImm(VReg.S2, 7); // x is Array
        vm.jne("_ae_x_not_arr");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.S2, 5);
        vm.jmp("_ae_type_dispatch");
        vm.label("_ae_x_not_arr");
        vm.cmpImm(VReg.S3, 7); // y is Array
        vm.jne("_ae_y_not_arr");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.S3, 5);
        vm.jmp("_ae_type_dispatch");
        vm.label("_ae_y_not_arr");
        vm.cmpImm(VReg.S2, 6); // x is Object → _js_toprimitive
        vm.jne("_ae_x_not_obj_p");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_toprimitive");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.S2, 0);          // 默认 Float
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_ae_x_obj_p_done");
        vm.movImm(VReg.S2, 5);          // 结果是串
        vm.label("_ae_x_obj_p_done");
        vm.jmp("_ae_type_dispatch");
        vm.label("_ae_x_not_obj_p");
        vm.cmpImm(VReg.S3, 6); // y is Object
        vm.jne("_ae_y_not_obj_p");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_toprimitive");
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.movImm(VReg.S3, 0);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_ae_y_obj_p_done");
        vm.movImm(VReg.S3, 5);
        vm.label("_ae_y_obj_p_done");
        vm.jmp("_ae_type_dispatch");
        vm.label("_ae_y_not_obj_p");
        vm.cmpImm(VReg.S2, 5); // x is String
        vm.jne("_ae_x_not_str");
        vm.cmpImm(VReg.S3, 2); // y < 2 is Number (Float=0, Int32=1)
        vm.jge("_ae_x_not_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_to_num");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.S2, 0); // x becomes Float
        vm.jmp("_ae_recurse");
        vm.label("_ae_x_not_str");

        // 4. Number == String -> Number == Number(String)
        vm.cmpImm(VReg.S3, 5); // y is String
        vm.jne("_ae_y_not_str");
        vm.cmpImm(VReg.S2, 2); // x < 2 is Number
        vm.jge("_ae_y_not_str");
        // y is String: convert to float using _str_to_num (like case 3)
        vm.mov(VReg.S4, VReg.S0);  // S4 = x JSValue (save x)
        vm.mov(VReg.A0, VReg.S1);  // A0 = y (String JSValue)
        vm.call("_str_to_num");  // RET = float bits
        vm.mov(VReg.S1, VReg.RET); // S1 = float bits of y
        // Convert x: if Int32, extract and convert; if Float, use directly
        vm.cmpImm(VReg.S2, 1);  // check if x is Int32
        vm.jne("_ae_case4_x_is_float");
        // x is Int32: extract low 32 bits
        vm.mov(VReg.S0, VReg.S4);  // S0 = x JSValue
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.and(VReg.V0, VReg.S0, VReg.V0);  // V0 = low 32 bits
        vm.shlImm(VReg.V0, VReg.V0, 32);
        vm.sarImm(VReg.V0, VReg.V0, 32);  // sign-extend
        vm.scvtf(0, VReg.V0);  // FP0 = float(x)
        vm.fmovToInt(VReg.S0, 0);  // S0 = float bits of x
        vm.jmp("_ae_case4_done");
        vm.label("_ae_case4_x_is_float");
        // x is already Float: S0 already contains float bits
        vm.label("_ae_case4_done");
        vm.movImm(VReg.S2, 0);  // x is Float
        vm.movImm(VReg.S3, 0);  // y is Float
        vm.jmp("_ae_recurse");
        vm.label("_ae_y_not_str");

        // 5. Boolean == Any -> Number(Boolean) == Any
        vm.cmpImm(VReg.S2, 2); // x is Boolean
        vm.jne("_ae_x_not_bool");
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V0); // payload 0 or 1
        vm.movImm64(VReg.V1, 0x7ff8000000000000n);
        vm.or(VReg.S0, VReg.V0, VReg.V1); // Box as Int32
        vm.movImm(VReg.S2, 1);
        vm.jmp("_ae_type_dispatch"); // 回分派:另一侧若是 String 需再转数(String==Boolean)
        vm.label("_ae_x_not_bool");

        // 6. Any == Boolean -> Any == Number(Boolean)
        vm.cmpImm(VReg.S3, 2); // y is Boolean
        vm.jne("_ae_y_not_bool");
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V0);
        vm.movImm64(VReg.V1, 0x7ff8000000000000n);
        vm.or(VReg.S1, VReg.V0, VReg.V1); // Box as Int32
        vm.movImm(VReg.S3, 1);
        vm.jmp("_ae_type_dispatch"); // 回分派:另一侧若是 String 需再转数(String==Boolean)
        vm.label("_ae_y_not_bool");

        vm.label("_ae_recurse");
        // 如果类型一致,则进行最终比较
        vm.cmp(VReg.S2, VReg.S3);
        vm.jne("_ae_diff_types_after");

        // 同类型比较
        vm.cmpImm(VReg.S2, 5); // String
        vm.jeq("_ae_cmp_str");
        vm.cmpImm(VReg.S2, 0); // Float
        vm.jeq("_ae_both_float");
        // 其他同类型(位模式比较)
        vm.cmp(VReg.S0, VReg.S1);
        vm.jeq("_abstract_eq_true");
        vm.jmp("_abstract_eq_false");

        vm.label("_ae_diff_types_after");
        // 混合类型: Float vs Int32
        vm.cmpImm(VReg.S2, 0); // x is Float
        vm.jne("_ae_x_not_float_after");
        vm.cmpImm(VReg.S3, 1); // y is Int32
        vm.jeq("_ae_x_float_y_int");
        vm.jmp("_abstract_eq_false");

        vm.label("_ae_x_not_float_after");
        vm.cmpImm(VReg.S2, 1); // x is Int32
        vm.jne("_abstract_eq_false");
        vm.cmpImm(VReg.S3, 0); // y is Float
        vm.jeq("_ae_x_int_y_float");
        vm.jmp("_abstract_eq_false");


        // --- Actual Comparison Workers ---

        vm.label("_ae_both_float");
        vm.fmovToFloat(0, VReg.S0);
        vm.fmovToFloat(1, VReg.S1);
        vm.fcmp(0, 1);
        vm.jeq("_abstract_eq_true");
        vm.jmp("_abstract_eq_false");

        vm.label("_ae_x_float_y_int");
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.and(VReg.V0, VReg.S1, VReg.V0);
        vm.shlImm(VReg.V0, VReg.V0, 32);
        vm.sarImm(VReg.V0, VReg.V0, 32); // Sign-extend int32
        vm.scvtf(1, VReg.V0); // D1 = float(y)
        vm.fmovToFloat(0, VReg.S0);
        vm.fcmp(0, 1);
        vm.jeq("_abstract_eq_true");
        vm.jmp("_abstract_eq_false");

        vm.label("_ae_x_int_y_float");
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.and(VReg.V0, VReg.S0, VReg.V0);
        vm.shlImm(VReg.V0, VReg.V0, 32);
        vm.sarImm(VReg.V0, VReg.V0, 32);
        vm.scvtf(0, VReg.V0); // D0 = float(x)
        vm.fmovToFloat(1, VReg.S1);
        vm.fcmp(0, 1);
        vm.jeq("_abstract_eq_true");
        vm.jmp("_abstract_eq_false");

        vm.label("_ae_cmp_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_unbox");
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_unbox");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_abstract_eq_true");
        vm.jmp("_abstract_eq_false");

        // ========== 返回结果 ==========
        vm.label("_abstract_eq_true");
        vm.movImm64(VReg.RET, JS_TRUE);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);

        vm.label("_abstract_eq_false");
        vm.movImm64(VReg.RET, JS_FALSE);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);
    }

    /**
     * _str_to_num: 将字符串转换为浮点数
     * 输入: A0 = JSValue (string)
     * 输出: RET = float64 位模式
     *
     * 支持格式:
     *   - 整数 ("123", "-456")
     *   - 浮点数 ("3.14")
     *   - 科学计数法 (暂不支持)
     */
    generateStrToNum() {
        const vm = this.vm;

        vm.label("_str_to_num");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.mov(VReg.S0, VReg.A0); // S0 = 输入值

        // 检查是否是 string type (0x7FFC 高位)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.V1, 0x7ffc);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_str_to_num_is_string");

        // 不是 0x7FFC tag,检查是否是 raw data segment pointer
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x1000);
        vm.jeq("_str_to_num_is_data_ptr");
        vm.cmpImm(VReg.V0, 0x1001);
        vm.jeq("_str_to_num_is_data_ptr");
        vm.jmp("_str_to_num_not_string");

        vm.label("_str_to_num_is_string");
        // 提取字符串指针 (低 48 位)
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V0);

        vm.label("_str_to_num_is_data_ptr");
        // S0 保持不变,直接使用

        // 检查 S0 是否为 0 (空指针安全检查)
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_str_to_num_invalid");

        // 跳过空白字符
        vm.label("_str_to_num_skip_ws");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 32); // 空格
        vm.jeq("_str_to_num_skip_char");
        vm.cmpImm(VReg.V0, 9);  // Tab
        vm.jeq("_str_to_num_skip_char");
        vm.cmpImm(VReg.V0, 10); // 换行
        vm.jeq("_str_to_num_skip_char");
        vm.cmpImm(VReg.V0, 13); // 回车
        vm.jeq("_str_to_num_skip_char");
        vm.jmp("_str_to_num_parse_start");

        vm.label("_str_to_num_skip_char");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_str_to_num_skip_ws");

        // 检查符号
        // 寄存器分配:
        // S0 = 字符串指针 (char*)
        // S1 = 符号 (1 = 正, -1 = 负)
        // S2 = 整数部分 (拼接)
        // S3 = 小数部分 (拼接)
        // S4 = 小数位数
        vm.label("_str_to_num_parse_start");
        vm.movImm(VReg.S1, 1); // S1 = 符号 (1 = 正, -1 = 负)
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 45); // '-'
        vm.jne("_str_to_num_check_plus");
        vm.movImm(VReg.S1, -1);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_str_to_num_check_digit");
        // 前置 '+':正号但按 ECMAScript StrNumericLiteral 语法禁非十进制前缀(Number("+0x1")=NaN)。
        // S1 用哨兵 2(非 ±1):apply_sign(判 -1)不取反 → 正;radix 判(仅 S1==1 识别前缀)→ 禁;
        // Infinity 判(判 -1)→ +Infinity。S1 仅被比 1/-1,从不做乘子,故哨兵安全。
        vm.label("_str_to_num_check_plus");
        vm.cmpImm(VReg.V0, 43); // '+'
        vm.jne("_str_to_num_check_digit");
        vm.movImm(VReg.S1, 2);
        vm.addImm(VReg.S0, VReg.S0, 1);

        // 解析整数部分
        vm.label("_str_to_num_check_digit");
        // "Infinity" 字面(可带前置 '-'):Number("Infinity")=Inf、"-Infinity"=-Inf、parseFloat 同。
        // S0 指向首字符;'I' → 试匹配 8 字符,成功即返 ±Inf。
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 73); // 'I'
        vm.jeq("_str_to_num_maybe_inf");
        // [radix] 进制前缀 0x/0X(16)、0o/0O(8)、0b/0B(2)。JS 规范 NonDecimalIntegerLiteral
        // 不允许正负号(Number("-0x1")===NaN),故仅正号(S1==1)时识别前缀,否则落十进制。
        vm.cmpImm(VReg.S1, 1);
        vm.jne("_str_to_num_decimal_init");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 48); // '0'
        vm.jne("_str_to_num_decimal_init");
        vm.loadByte(VReg.V1, VReg.S0, 1); // 第二字符
        vm.movImm(VReg.V3, 16);
        vm.cmpImm(VReg.V1, 120); vm.jeq("_str_to_num_radix_start"); // 'x'
        vm.cmpImm(VReg.V1, 88);  vm.jeq("_str_to_num_radix_start"); // 'X'
        vm.movImm(VReg.V3, 8);
        vm.cmpImm(VReg.V1, 111); vm.jeq("_str_to_num_radix_start"); // 'o'
        vm.cmpImm(VReg.V1, 79);  vm.jeq("_str_to_num_radix_start"); // 'O'
        vm.movImm(VReg.V3, 2);
        vm.cmpImm(VReg.V1, 98);  vm.jeq("_str_to_num_radix_start"); // 'b'
        vm.cmpImm(VReg.V1, 66);  vm.jeq("_str_to_num_radix_start"); // 'B'
        vm.label("_str_to_num_decimal_init");
        vm.movImm(VReg.S2, 0); // S2 = 整数部分
        vm.movImm(VReg.S3, 0); // S3 = 小数部分 (初始化为0)
        vm.movImm(VReg.S4, 0); // S4 = 小数位数 (初始化为0)
        vm.movImm(VReg.S5, 0); // S5 = 科学计数法指数(带符号,0 = 无)
        vm.movImm(VReg.V2, 0); // V2 = digit found flag (0 = no, 1 = yes)
        vm.label("_str_to_num_int_loop");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 48); // '0'
        vm.jlt("_str_to_num_check_dot");
        vm.cmpImm(VReg.V0, 57); // '9'
        vm.jgt("_str_to_num_check_dot");
        // 是数字
        vm.subImm(VReg.V0, VReg.V0, 48); // V0 = digit
        // S2 = S2 * 10 + V0
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.S2, VReg.S2, VReg.V1);
        vm.add(VReg.S2, VReg.S2, VReg.V0);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.movImm(VReg.V2, 1); // Mark: found at least one digit
        vm.jmp("_str_to_num_int_loop");

        // [radix] 进制解析:base 在 V3,S0 指向前缀首字符 '0'。跳过 2 字符前缀后逐位累加,
        // S2 = S2*base + digit(0-9/a-f/A-F,校验 digit<base)。收尾复用 check_trailing。
        vm.label("_str_to_num_radix_start");
        vm.addImm(VReg.S0, VReg.S0, 2); // 跳过 0x/0o/0b
        vm.movImm(VReg.S2, 0);
        vm.movImm(VReg.S3, 0);
        vm.movImm(VReg.S4, 0);
        vm.movImm(VReg.S5, 0); // 指数(radix 无科学计数法,但 finish 会读 S5,须清零)
        vm.movImm(VReg.V2, 0); // 至少一位标志
        vm.label("_str_to_num_radix_loop");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 48); vm.jlt("_str_to_num_radix_end"); // < '0'
        vm.cmpImm(VReg.V0, 57); vm.jgt("_str_to_num_radix_alpha"); // > '9'
        vm.subImm(VReg.V0, VReg.V0, 48); // 0-9
        vm.jmp("_str_to_num_radix_digit");
        vm.label("_str_to_num_radix_alpha");
        vm.cmpImm(VReg.V0, 97); vm.jlt("_str_to_num_radix_upper"); // < 'a'
        vm.cmpImm(VReg.V0, 102); vm.jgt("_str_to_num_radix_end"); // > 'f'
        vm.subImm(VReg.V0, VReg.V0, 87); // 'a'(97)→10
        vm.jmp("_str_to_num_radix_digit");
        vm.label("_str_to_num_radix_upper");
        vm.cmpImm(VReg.V0, 65); vm.jlt("_str_to_num_radix_end"); // < 'A'
        vm.cmpImm(VReg.V0, 70); vm.jgt("_str_to_num_radix_end"); // > 'F'
        vm.subImm(VReg.V0, VReg.V0, 55); // 'A'(65)→10
        vm.label("_str_to_num_radix_digit");
        vm.cmp(VReg.V0, VReg.V3); vm.jge("_str_to_num_radix_end"); // digit >= base → 非法字符,停止
        vm.mul(VReg.S2, VReg.S2, VReg.V3);
        vm.add(VReg.S2, VReg.S2, VReg.V0);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.movImm(VReg.V2, 1);
        vm.jmp("_str_to_num_radix_loop");
        vm.label("_str_to_num_radix_end");
        vm.cmpImm(VReg.V2, 0); // "0x" 无数字 → 无效(NaN)
        vm.jeq("_str_to_num_invalid");
        vm.loadByte(VReg.V0, VReg.S0, 0); // 停止字符,交 trailing 校验(尾空白/结束符)
        vm.jmp("_str_to_num_check_trailing");

        // 检查小数点
        vm.label("_str_to_num_check_dot");
        // 停止字符是 '.' → 解析小数部分(整数部分可空,支持 ".5"=0.5)。
        vm.cmpImm(VReg.V0, 46); // '.'
        vm.jeq("_str_to_num_dot_frac");
        // 非 '.':若整数部分也无数字 → 无效输入(空串/纯空白由 no_digits 归 0)。
        vm.cmpImm(VReg.V2, 0); // V2 = digit found flag
        vm.jeq("_str_to_num_no_digits");
        vm.jmp("_str_to_num_maybe_exp");
        // 有小数点,解析小数部分
        vm.label("_str_to_num_dot_frac");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.movImm(VReg.S3, 0); // S3 = 小数部分
        vm.movImm(VReg.S4, 0); // S4 = 小数位数
        vm.label("_str_to_num_frac_loop");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 48); // '0'
        vm.jlt("_str_to_num_frac_done");
        vm.cmpImm(VReg.V0, 57); // '9'
        vm.jgt("_str_to_num_frac_done");
        // 是数字
        vm.subImm(VReg.V0, VReg.V0, 48); // V0 = digit
        // S3 = S3 * 10 + V0
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.S3, VReg.S3, VReg.V1);
        vm.add(VReg.S3, VReg.S3, VReg.V0);
        vm.addImm(VReg.S4, VReg.S4, 1); // S4 = 小数位数
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_str_to_num_frac_loop");

        // 小数循环结束:至少要有一位数字(整数或小数);仅 "."/".x"(V2==0 且 S4==0)→ 无效。
        // V0 = 停止字符(供 maybe_exp 判 e/E),不改动。
        vm.label("_str_to_num_frac_done");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_str_to_num_maybe_exp"); // 有整数位 → ok
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_str_to_num_invalid");   // "." 无任何数字 → NaN
        // 有小数位、无整数位(".5")→ 继续
        // 科学计数法指数 e/E:整数或小数部分结束后遇 'e'/'E' → 解析可选符号 + 指数数字
        // 到 S5(带符号),供 finish 处按 10^S5 缩放。非 e/E 则原样交尾部校验。
        // V0 = 当前(停止)字符,S0 指向它。
        vm.label("_str_to_num_maybe_exp");
        vm.cmpImm(VReg.V0, 101); // 'e'
        vm.jeq("_str_to_num_do_exp");
        vm.cmpImm(VReg.V0, 69);  // 'E'
        vm.jeq("_str_to_num_do_exp");
        vm.jmp("_str_to_num_check_trailing");
        vm.label("_str_to_num_do_exp");
        vm.addImm(VReg.S0, VReg.S0, 1); // 跳过 e/E
        vm.movImm(VReg.S5, 0);          // 指数幅值
        vm.movImm(VReg.V2, 1);          // 指数符号(1/-1),V2 不被数字循环破坏
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 43); // '+'
        vm.jne("_str_to_num_exp_chk_minus");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_str_to_num_exp_digits");
        vm.label("_str_to_num_exp_chk_minus");
        vm.cmpImm(VReg.V0, 45); // '-'
        vm.jne("_str_to_num_exp_digits");
        vm.movImm(VReg.V2, -1);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.label("_str_to_num_exp_digits");
        vm.movImm(VReg.V3, 0); // 至少一位指数数字标志
        vm.label("_str_to_num_exp_loop");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 48); vm.jlt("_str_to_num_exp_end");
        vm.cmpImm(VReg.V0, 57); vm.jgt("_str_to_num_exp_end");
        vm.subImm(VReg.V0, VReg.V0, 48);
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.S5, VReg.S5, VReg.V1);
        vm.add(VReg.S5, VReg.S5, VReg.V0);
        vm.movImm(VReg.V3, 1);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_str_to_num_exp_loop");
        vm.label("_str_to_num_exp_end");
        vm.cmpImm(VReg.V3, 0);          // 'e' 后无数字(如 "1e") → 无效 NaN
        vm.jeq("_str_to_num_invalid");
        vm.cmpImm(VReg.V2, 0);          // 应用指数符号
        vm.jge("_str_to_num_exp_signed");
        vm.neg(VReg.S5, VReg.S5);
        vm.label("_str_to_num_exp_signed");
        vm.loadByte(VReg.V0, VReg.S0, 0); // 停止字符交尾部校验
        // 继续到 check_trailing

        // 检查尾部字符(无效输入检测)
        // V0 包含第一个非数字字符
        vm.label("_str_to_num_check_trailing");
        // 跳过尾部空白字符
        vm.label("_str_to_num_skip_trailing_ws");
        vm.cmpImm(VReg.V0, 32); // 空格
        vm.jeq("_str_to_num_skip_trail_char");
        vm.cmpImm(VReg.V0, 9);  // Tab
        vm.jeq("_str_to_num_skip_trail_char");
        vm.cmpImm(VReg.V0, 10); // 换行
        vm.jeq("_str_to_num_skip_trail_char");
        vm.cmpImm(VReg.V0, 13); // 回车
        vm.jeq("_str_to_num_skip_trail_char");
        // 不是空白,检查是否是结束符
        vm.cmpImm(VReg.V0, 0); // 结束符
        vm.jeq("_str_to_num_finish"); // 是结束符,有效
        // 尾部有非空白非结束符:严格(Number)→ NaN;宽松(parseFloat)→ 以已解析前缀收尾。
        // 到此已解析出至少一位数字(check_dot 的 V2!=0 守卫在前),故直接 finish 安全。
        vm.lea(VReg.V1, "_parse_lenient");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_str_to_num_finish"); // 宽松模式:忽略尾部垃圾
        vm.jmp("_str_to_num_invalid"); // 严格模式:无效输入

        vm.label("_str_to_num_skip_trail_char");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.jmp("_str_to_num_skip_trailing_ws");

        // 无数字输入处理(空字符串或纯空白)
        vm.label("_str_to_num_no_digits");
        // 检查是否是结束符(空字符串的情况)
        vm.cmpImm(VReg.V0, 0); // 结束符
        vm.jeq("_str_to_num_finish"); // 是结束符,返回 0
        // 检查是否是空白字符(跳过空白后重新检查)
        vm.cmpImm(VReg.V0, 32); // 空格
        vm.jeq("_str_to_num_skip_ws");
        vm.cmpImm(VReg.V0, 9);  // Tab
        vm.jeq("_str_to_num_skip_ws");
        vm.cmpImm(VReg.V0, 10); // 换行
        vm.jeq("_str_to_num_skip_ws");
        vm.cmpImm(VReg.V0, 13); // 回车
        vm.jeq("_str_to_num_skip_ws");
        // 非空白非结束符 = 无效输入
        vm.jmp("_str_to_num_invalid");

        vm.label("_str_to_num_finish");
        // S1 = 符号
        // S2 = 整数部分
        // S3 = 小数部分
        // S4 = 小数位数
        //
        // 结果 = S2 + S3 / (10^S4)
        //
        // 例如 "42.5": S1=1, S2=42, S3=5, S4=1
        //   42 + 5/10 = 42.5
        //
        // 例如 "3.14": S1=1, S2=3, S3=14, S4=2
        //   3 + 14/100 = 3.14
        //
        // 例如 "123": S1=1, S2=123, S3=0, S4=0
        //   123 + 0 = 123

        // 先将整数部分转换为浮点数放到FP0
        vm.scvtf(0, VReg.S2); // FP0 = float(S2 = 整数部分)

        // 检查是否有小数部分 (S4 > 0)。无小数也须经指数缩放(int-only "1e3"),故跳
        // apply_exp 而非直接 apply_sign(否则整数型科学计数法的指数被跳过)。
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_str_to_num_apply_exp");

        // 有小数部分,计算 S3 / (10^S4)
        // 先计算 10^S4 (使用V0作为结果寄存器)
        // V0 = 10^S4
        vm.mov(VReg.V0, VReg.S4); // V0 = 小数位数
        vm.movImm(VReg.V1, 1); // V1 = 1 (10^0 = 1)
        vm.label("_str_to_num_pow10_loop");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_str_to_num_pow10_done");
        vm.movImm(VReg.V2, 10);
        vm.mul(VReg.V1, VReg.V1, VReg.V2);
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_str_to_num_pow10_loop");
        vm.label("_str_to_num_pow10_done");
        // V1 = 10^S4

        // 计算 S3 / V1
        vm.scvtf(1, VReg.S3); // FP1 = float(S3 = 小数部分)
        vm.scvtf(2, VReg.V1); // FP2 = float(V1 = 10^S4)
        vm.fdiv(1, 1, 2); // FP1 = FP1 / FP2 = 小数
        // FP0 = 整数部分, FP1 = 小数部分
        vm.fadd(0, 0, 1); // FP0 = FP0 + FP1 = 整数 + 小数

        // 科学计数法:FP0 *= 10^S5(S5>0 乘、<0 除,循环 |S5| 次)。FP0 此时是幅值,
        // 符号在下方 apply_sign 施加。指数循环用 FP1=10.0,V0=计数,V2=负标志。
        vm.label("_str_to_num_apply_exp");
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_str_to_num_apply_sign");
        vm.mov(VReg.V0, VReg.S5);
        vm.movImm(VReg.V2, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_str_to_num_exp_pos");
        vm.neg(VReg.V0, VReg.V0); // V0 = |exp|
        vm.movImm(VReg.V2, 1);
        vm.label("_str_to_num_exp_pos");
        vm.movImm(VReg.V1, 10);
        vm.scvtf(1, VReg.V1); // FP1 = 10.0
        vm.label("_str_to_num_exp_apply_loop");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_str_to_num_apply_sign");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_str_to_num_exp_apply_div");
        vm.fmul(0, 0, 1); // FP0 *= 10
        vm.jmp("_str_to_num_exp_apply_next");
        vm.label("_str_to_num_exp_apply_div");
        vm.fdiv(0, 0, 1); // FP0 /= 10
        vm.label("_str_to_num_exp_apply_next");
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_str_to_num_exp_apply_loop");

        vm.label("_str_to_num_apply_sign");
        // 应用符号 (S1 = 1 或 -1)
        vm.cmpImm(VReg.S1, -1);
        vm.jne("_str_to_num_convert");
        // 负数,取反
        vm.fneg(0, 0);

        vm.label("_str_to_num_convert");
        vm.fmovToInt(VReg.RET, 0); // RET = float64 bits
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // "Infinity" 匹配:S0 指向 'I'。逐字符校验 nfinity;任一不符 → 落十进制(→invalid NaN)。
        vm.label("_str_to_num_maybe_inf");
        vm.loadByte(VReg.V0, VReg.S0, 1); vm.cmpImm(VReg.V0, 110); vm.jne("_str_to_num_decimal_init"); // 'n'
        vm.loadByte(VReg.V0, VReg.S0, 2); vm.cmpImm(VReg.V0, 102); vm.jne("_str_to_num_decimal_init"); // 'f'
        vm.loadByte(VReg.V0, VReg.S0, 3); vm.cmpImm(VReg.V0, 105); vm.jne("_str_to_num_decimal_init"); // 'i'
        vm.loadByte(VReg.V0, VReg.S0, 4); vm.cmpImm(VReg.V0, 110); vm.jne("_str_to_num_decimal_init"); // 'n'
        vm.loadByte(VReg.V0, VReg.S0, 5); vm.cmpImm(VReg.V0, 105); vm.jne("_str_to_num_decimal_init"); // 'i'
        vm.loadByte(VReg.V0, VReg.S0, 6); vm.cmpImm(VReg.V0, 116); vm.jne("_str_to_num_decimal_init"); // 't'
        vm.loadByte(VReg.V0, VReg.S0, 7); vm.cmpImm(VReg.V0, 121); vm.jne("_str_to_num_decimal_init"); // 'y'
        // 匹配 "Infinity"。S0 += 8,尾部校验(结束/空白/宽松 → 有效,否则 invalid)。
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 0);  vm.jeq("_str_to_num_inf_ret"); // 结束符
        vm.cmpImm(VReg.V0, 32); vm.jeq("_str_to_num_inf_ret"); // 空格
        vm.cmpImm(VReg.V0, 9);  vm.jeq("_str_to_num_inf_ret");
        vm.cmpImm(VReg.V0, 10); vm.jeq("_str_to_num_inf_ret");
        vm.cmpImm(VReg.V0, 13); vm.jeq("_str_to_num_inf_ret");
        vm.lea(VReg.V1, "_parse_lenient"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0); vm.jne("_str_to_num_inf_ret"); // 宽松:忽略尾部
        vm.jmp("_str_to_num_invalid");
        vm.label("_str_to_num_inf_ret");
        vm.cmpImm(VReg.S1, -1);
        vm.jeq("_str_to_num_inf_neg");
        vm.movImm64(VReg.RET, 0x7ff0000000000000n); // +Infinity
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_str_to_num_inf_neg");
        vm.movImm64(VReg.RET, 0xfff0000000000000n); // -Infinity
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_str_to_num_invalid");
        // 无效数字串 → NaN。用非别名 NaN 位 0x7FF0…01(canonical 0x7FF8 与装箱 int0 同构:
        // Number("abc") 会 isNaN=false、打印 0、`"abc"==0` 误真)。编译器只对合法数字串调
        // _str_to_num,不触此路,自举定点不受影响。
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_str_to_num_not_string");
        // 不是字符串,返回 NaN
        vm.movImm64(VReg.RET, 0x7ff8000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    /**
     * _to_boolean: 将任意 JavaScript 值转换为布尔值
     * 输入: A0 = JSValue
     * 输出: RET = 0 (falsy) 或 1 (truthy)
     *
     * NaN-boxing falsy 值:
     * - 0 (float64 +0.0 = 0x0000000000000000)
     * - -0 (float64 -0.0 = 0x8000000000000000)
     * - false (0x7FF9000000000002)
     * - null (0x7FFA000000000000)
     * - undefined (0x7FFB000000000000)
     * - NaN (0x7FF8000000000000 需要特殊处理)
     * - 空字符串 (0x7FFC000000000000 | ptr,长度为 0)
     *
     * 简化实现:检查常见 falsy 值
     */
    generateToBoolean() {
        const vm = this.vm;

        vm.label("_to_boolean");
        vm.prologue(0, [VReg.S0]); // 保存 S0 以便使用

        const falsyLabel = "_to_bool_falsy";

        // 把参数保存到 S0,因为后面会用到 V0-V7 (都是 X0-X7,会覆盖 A0)
        vm.mov(VReg.S0, VReg.A0);

        // 检查 +0.0 (float64 的 0)
        vm.cmpImm(VReg.S0, 0);
        vm.jeq(falsyLabel);

        // 检查 -0.0 (0x8000000000000000)
        vm.movImm64(VReg.V0, 0x8000000000000000n);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq(falsyLabel);

        // 检查 false (0x7FF9000000000002)
        vm.movImm64(VReg.V0, JS_FALSE);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq(falsyLabel);

        // 检查 null (0x7FFA000000000000)
        vm.movImm64(VReg.V0, JS_NULL);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq(falsyLabel);

        // 检查 undefined (0x7FFB000000000000)
        vm.movImm64(VReg.V0, JS_UNDEFINED);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq(falsyLabel);

        // 检查 INT32 类型的 0 (0x7FF8000000000000)
        vm.movImm64(VReg.V0, JS_TAG_INT32_BASE);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq(falsyLabel);

        // 注意: NaN (0x7FF8000000000000) 已经被上面的 INT32_BASE 捕获
        // 其他 NaN-boxed 值 (0x7FF9, 0x7FFA, 0x7FFB, 0x7FFC) 也已在上面处理

        // 但**字面量 NaN**(members.js 发真 IEEE NaN 位 0x7FF0…01,高16=0x7FF0<0x7FF8)
        // 落"原始 double"区,不被 INT32_BASE(0x7FF8)捕获 → 此前误判 truthy
        // (`NaN?:`/`Boolean(NaN)`/`if(NaN)`/`NaN||x` 全错;computed NaN=0x7FF8 侥幸对)。
        // 修:对高16<0x7FF8 的原始 double 做自反 fcmp,NaN(不等自身)→ falsy。
        // Infinity/有限数自反相等 → 不误判;NaN-boxed 标记值(>=0x7FF8)不走此路。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jge("_to_bool_skip_nan");
        vm.fmovToFloat(0, VReg.S0);
        vm.fcmp(0, 0);
        vm.jnan(falsyLabel); // NaN → falsy
        vm.label("_to_bool_skip_nan");

        // 检查数据段字符串指针(非 NaN-boxed 的原始字符串指针)
        // 数据段字符串指针的高16位通常是 0x1000 或 0x1001
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x1000);
        vm.jeq("_to_bool_check_data_str");
        vm.cmpImm(VReg.V0, 0x1001);
        vm.jeq("_to_bool_check_data_str");
        // 也检查值是否看起来像一个合理的地址(小于 0x7FF0)
        // data 段地址在 macOS 上通常是 0x100008xxx，linux 上是 0x40xxxx（ptrFloor 下调）。
        // 上界 0x200000000 保持不变：linux 数据段远低于它、linux 堆(mmap 高地址)远高于它，均不误判。
        vm.movImm64(VReg.V0, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_to_bool_skip_data_str");
        vm.movImm64(VReg.V0, 0x200000000n);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_to_bool_check_data_str");
        vm.label("_to_bool_skip_data_str");

        // 检查 NaN-boxed 空字符串:高 16 位是 0x7FFC
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.V1, 0x7ffc);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_to_bool_truthy"); // 不是字符串,是 truthy

        // 是 NaN-boxed 字符串,检查是否为空：提取低 48 位作为字符串指针。
        // macOS：堆/数据指针 bit47=0，用 shl16;sar16 符号扩展是恒等（无害），保留历史行为。
        // linux-arm64：mmap 堆地址形如 0x0000_ffff_xxxx_xxxx，bit47=1；若符号扩展会把
        //   高 16 位填成 0xffff → 0xffff_ffff_xxxx_xxxx 非法地址 → loadByte 段错误
        //   （表现为 `heapStr && heapStr.m()` 崩）。canonical 用户地址高 16 位本就是 0，
        //   直接用掩码结果即可，故 linux 跳过符号扩展。
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V0);
        if (vm.os !== "linux") {
            vm.shlImm(VReg.V0, VReg.V0, 16);
            vm.sarImm(VReg.V0, VReg.V0, 16);
        }
        vm.jmp("_to_bool_check_str_empty");

        // 数据段字符串检查入口
        vm.label("_to_bool_check_data_str");
        vm.mov(VReg.V0, VReg.S0); // V0 = data segment pointer

        // 检查字符串是否为空
        vm.label("_to_bool_check_str_empty");
        // 加载第一个字节
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(falsyLabel); // 空字符串是 falsy
        // 非空字符串,继续到 truthy

        vm.label("_to_bool_truthy");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 0);

        vm.label(falsyLabel);
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
    }

    /**
     * _number_coerce: 将任意 JavaScript 值转换为数字
     * 输入: A0 = JSValue
     * 输出: RET = float64 位模式的数字
     *
     * ECMAScript ToNumber 转换规则:
     * - undefined → NaN
     * - null → +0
     * - boolean: true → 1, false → 0
     * - number → itself
     * - string → 调用 _str_to_num 转换
     * - symbol → TypeError (简化: 返回 NaN)
     * - bigint → the bigint value (简化: 返回 NaN)
     * - object → ToNumber(ToPrimitive(obj)) (简化: 返回 NaN)
     */
    generateNumberCoerce() {
        const vm = this.vm;

        vm.label("_number_coerce");
        vm.prologue(64, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0);

        // BigInt → 取其 64 位值转 double。_is_bigint 返回值覆盖 A0；S0 callee-saved
        // 且 _is_bigint 会保存恢复，故调用后继续用 S0（不能重读 A0）。
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_num_coerce_not_bigint");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_bigint_to_number");
        vm.epilogue([VReg.S0, VReg.S1], 64);
        vm.label("_num_coerce_not_bigint");

        // 检查是否是 undefined (0x7FFB000000000000)
        vm.movImm64(VReg.V0, JS_UNDEFINED);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq("_num_coerce_undefined");

        // 检查是否是 null (0x7FFA000000000000)
        vm.movImm64(VReg.V0, JS_NULL);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq("_num_coerce_null");

        // 检查是否是 boolean (0x7FF9000000000000 + offset)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.V1, 0x7FF9);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_num_coerce_bool");

        // 检查是否是 int32 (tag 0, bits 48-63 == 0x7FF8)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.V1, 0x7FF8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_num_coerce_int32");

        // 检查是否是堆上的 Number 对象(block_ptr 或 user_ptr)
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_num_coerce_check_string_or_float");

        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_num_coerce_check_string_or_float");

        // 优先按 user_ptr 识别:reg - 16 处是 type,reg - 8 处是 value
        vm.addImm(VReg.V1, VReg.V0, 16);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_num_coerce_heap_check_block");
        vm.subImm(VReg.V1, VReg.S0, 16);
        vm.load(VReg.V2, VReg.V1, 0);
        vm.cmpImm(VReg.V2, TYPE_NUMBER);
        vm.jeq("_num_coerce_heap_number_int_user");
        vm.cmpImm(VReg.V2, TYPE_FLOAT64);
        vm.jeq("_num_coerce_heap_number_float_user");

        vm.label("_num_coerce_heap_check_block");
        vm.load(VReg.V2, VReg.S0, 0);
        vm.cmpImm(VReg.V2, TYPE_NUMBER);
        vm.jeq("_num_coerce_heap_number_int_block");
        vm.cmpImm(VReg.V2, TYPE_FLOAT64);
        vm.jeq("_num_coerce_heap_number_float_block");

        vm.label("_num_coerce_check_string_or_float");
        // 检查是否是 data segment pointer (字符串) - 必须在 float64 检查之前!
        // 因为 data pointer 的高 16 位是 0x1000 或 0x1001,小于 0x7FF8
        // 如果先检查 float64,会错误地将 data pointer 当作 float 处理
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x1000);
        vm.jeq("_num_coerce_string");
        vm.cmpImm(VReg.V0, 0x1001);
        vm.jeq("_num_coerce_string");
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_num_coerce_string");

        // raw float64 的高 16 位不在 [0x7FF8, 0x7FFF] 这个 tagged 区间内。
        // 直接用区间判断,避免依赖带符号/无符号语义不稳定的技巧。
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_num_coerce_float");
        // 装箱对象(0x7FFD):ToNumber via 用户 valueOf(有则调,结果再归一;无则 NaN)。
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_num_coerce_object_valueof");
        // 装箱数组(0x7FFE):ToPrimitive → toString(逗号串)→ 解析。Number([5])=5、Number([1,2])=NaN、
        // Number([])=""→0。此前落 NaN 支路返 canonical → 打印 0。
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_num_coerce_array");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jgt("_num_coerce_float");
        vm.jmp("_num_coerce_nan");

        vm.label("_num_coerce_array");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");            // RET = 逗号连接串(装箱)
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_number_coerce");         // 递归:解析串(空串→0、"5"→5、"1,2"→NaN)
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_object_valueof");
        // Date(块 [+0]=type 7、[+8]=时间戳):ToNumber = 时间戳。**不能走 _object_user_valueof**——
        // Date 堆块仅 16 字节,当普通对象读 props 会越界崩(`d1-d2`/`+date` 段错误根因)。
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.S0, VReg.V1); // V1 = 脱壳块指针
        vm.load(VReg.V0, VReg.V1, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 7);             // TYPE_DATE
        vm.jne("_num_coerce_obj_vo_call");
        vm.load(VReg.RET, VReg.V1, 8);     // 时间戳(float64 位)
        vm.epilogue([VReg.S0, VReg.S1], 64);
        vm.label("_num_coerce_obj_vo_call");
        // [Symbol.toPrimitive] 优先(hint "number"):返回原始值 → 递归 ToNumber;仍是对象则回退 valueOf。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("number"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_call_toprimitive");
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_num_coerce_obj_vo_fallback");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_number_coerce");
        vm.epilogue([VReg.S0, VReg.S1], 64);
        vm.label("_num_coerce_obj_vo_fallback");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_user_valueof");   // RET = valueOf 结果 或 0
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_num_coerce_nan");          // 无 valueOf → NaN
        // 结果若又是对象 → NaN(防 valueOf 返 this 的无限递归);否则递归归一化。
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_num_coerce_nan");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_number_coerce");
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_undefined");
        // undefined → NaN。必须用 0x7ff0000000000001(high16=0x7ff0 的信号 NaN),不能用
        // 0x7ff8000000000000——后者 high16=0x7ff8 恰是 NaN-box int32 tag,与装箱 int 0
        // 别名 → 下游按位当 int 0(ToNumber(undefined) 得 0、1+undefined 得 1,既有 bug)。
        // 0x7ff0…1 是全代码统一的规范 NaN(math.js/members.js NaN 标识符同款),fadd/打印/
        // 比较语义天然正确(见 nan-int0-alias-trap 记忆)。
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_null");
        // null → +0
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_bool");
        // boolean → 1 or 0
        // JS_FALSE = 0x7FF9000000000002 (payload 2) → 应该返回 0
        // JS_TRUE = 0x7FF9000000000001 (payload 1) → 应该返回 1
        // 检查是否是 JS_FALSE (payload = 2)
        vm.movImm64(VReg.V0, JS_FALSE);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq("_num_coerce_false");
        // 否则是 JS_TRUE → 返回 1
        vm.movImm(VReg.RET, 1); // int 1, will be returned as float
        vm.scvtf(0, VReg.RET); // FP0 = float(1)
        vm.fmovToInt(VReg.RET, 0); // RET = float64 bits (1.0)
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_false");
        // false → 0
        vm.movImm(VReg.RET, 0); // int 0
        vm.scvtf(0, VReg.RET); // FP0 = float(0)
        vm.fmovToInt(VReg.RET, 0); // RET = float64 bits (0.0)
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_int32");
        // int32 → 转换为 float
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.V0, VReg.S0, VReg.V1); // V0 = low 32 bits
        // 符号扩展: (V0 << 32) >> 32
        vm.shlImm(VReg.V0, VReg.V0, 32);
        vm.sarImm(VReg.V0, VReg.V0, 32);
        vm.scvtf(0, VReg.V0); // FP0 = float(V0)
        vm.fmovToInt(VReg.RET, 0); // RET = float64 bits
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_heap_number_int_user");
        vm.subImm(VReg.V1, VReg.S0, 8);
        vm.load(VReg.V0, VReg.V1, 0);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_heap_number_float_user");
        vm.subImm(VReg.V1, VReg.S0, 8);
        vm.load(VReg.RET, VReg.V1, 0);
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_heap_number_int_block");
        vm.load(VReg.V0, VReg.S0, 8);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_heap_number_float_block");
        vm.load(VReg.RET, VReg.S0, 8);
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_float");
        // float64 已经是我们需要的格式
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_string");
        // 字符串 → 调用 _str_to_num
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_to_num");
        vm.epilogue([VReg.S0, VReg.S1], 64);

        vm.label("_num_coerce_nan");
        // NaN
        vm.movImm64(VReg.RET, 0x7ff8000000000000n);
        vm.epilogue([VReg.S0, VReg.S1], 64);
    }

    /**
     * _strict_eq: 严格相等比较 (===)
     * 输入: A0 = JSValue x, A1 = JSValue y
     * 输出: RET = JS_TRUE 或 JS_FALSE
     *
     * 规则:
     * 1. 如果类型不同,返回 false
     * 2. 如果类型相同,比较值/引用
     */
    generateStrictEq() {
        const vm = this.vm;

        vm.label("_strict_eq");
        
        // ========== Debug implementation ==========
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        // 保存参数
        vm.mov(VReg.S0, VReg.A0); // x
        vm.mov(VReg.S1, VReg.A1); // y
        
        // 直接比较原始值。位相等时:float NaN 须返 false(NaN!==NaN),其余返 true。
        // 镜像 _abstract_eq(line ~752):此前一律 jeq true 使 NaN===NaN 误判真、
        // Number.isNaN 外的 NaN 自反相等全错。tagged(high16>=0x7FF8,含负浮点简化)
        // 位相等即真;float 位相等经 fcmp 自比较剔除 NaN。
        vm.cmp(VReg.S0, VReg.S1);
        vm.jne("_strict_eq_bits_differ");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7ff8);
        vm.jge("_strict_eq_true"); // tagged(与 _abstract_eq 同款负浮点简化)
        vm.fmovToFloat(0, VReg.S0);
        vm.fcmp(0, 0); // NaN 检测(NaN != NaN)
        vm.jeq("_strict_eq_true"); // 非 NaN → true
        vm.jmp("_strict_eq_false"); // NaN → false
        vm.label("_strict_eq_bits_differ");

        // 如果不相等，检查类型
        // 提取高 16 位。tagged 值 high16 ∈ [0x7FF8, 0x7FFF]；其余都是 float，
        // 包括负数浮点（符号位置位 → high16 ≥ 0x8000）。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.shrImm(VReg.V1, VReg.S1, 48);

        // 旧代码只判 high16 < 0x7FF8 为 float，把负数浮点（high16 ≥ 0x8000）误当 tagged。
        // 于是 -104（double 0xC05A...，payload 低48位=0，tag&7=2）与 null（0x7FFA，tag 2，
        // payload 0）巧合 tag+payload 相等 → `-104 === null` 误判为真。自举时编译器自身的
        // `if (varOffset !== null)`（varOffset 为负栈偏移）恒判假 → gen1 漏发 for-in 键写入等
        // 指令 → 连锁欠生成。修正：high16 < 0x7FF8 或 high16 ≥ 0x8000 都是 float。
        vm.movImm(VReg.V2, 0x7ff8);
        vm.movImm(VReg.V3, 0x8000);
        vm.cmp(VReg.V0, VReg.V2);
        vm.jlt("_strict_eq_x_float");
        vm.cmp(VReg.V0, VReg.V3);
        vm.jge("_strict_eq_x_float");

        // x 是 tagged，检查 y 是否为 float（不同类型 → false）
        vm.cmp(VReg.V1, VReg.V2);
        vm.jlt("_strict_eq_false"); // y 正浮点
        vm.cmp(VReg.V1, VReg.V3);
        vm.jge("_strict_eq_false"); // y 负浮点

        // 两个都是 tagged，比较 tag (high16 & 7)
        vm.andImm(VReg.V0, VReg.V0, 7);
        vm.andImm(VReg.V1, VReg.V1, 7);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_strict_eq_false");

        // Tag 相同，比较 payload
        vm.movImm64(VReg.V2, JS_PAYLOAD_MASK);
        vm.and(VReg.V2, VReg.S0, VReg.V2);
        vm.movImm64(VReg.V3, JS_PAYLOAD_MASK);
        vm.and(VReg.V3, VReg.S1, VReg.V3);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jeq("_strict_eq_true");
        // 字符串按内容比较（同一文本可能来自不同地址：
        // 驻留池 / 运行时注册串 / 堆拼接产物）
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_strict_eq_false");
        // [PERF] 融合比较:堆串(type 6)走 O(1) 长度判等 + memcmp(嵌入 NUL 正确);
        // 数据段串 NUL-walk 早退(语义与旧 _strlen_slow 截断完全一致——数据段串的
        // 长度本就扫到首个 NUL,无新增语义风险)。替代旧 _getStrContent×2+_strcmp
        // (每候选 2×strlen 扫 + memcmp,Map 桶链探测热路径)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET); // c1
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S3, VReg.RET); // c2
        // 双方皆堆串(type 6)判别
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jlt("_seq_str_walk");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jge("_seq_str_walk");
        vm.cmp(VReg.S3, VReg.V0);
        vm.jlt("_seq_str_walk");
        vm.cmp(VReg.S3, VReg.V1);
        vm.jge("_seq_str_walk");
        vm.subImm(VReg.V0, VReg.S2, 16);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 6); // TYPE_STRING
        vm.jne("_seq_str_walk");
        vm.subImm(VReg.V0, VReg.S3, 16);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 6);
        vm.jne("_seq_str_walk");
        // 堆串:长度不等 → false
        vm.subImm(VReg.V0, VReg.S2, 16);
        vm.load(VReg.V2, VReg.V0, 8); // len1
        vm.subImm(VReg.V0, VReg.S3, 16);
        vm.load(VReg.V3, VReg.V0, 8); // len2
        vm.cmp(VReg.V2, VReg.V3);
        vm.jne("_strict_eq_false");
        // 等长:逐字节比对(嵌入 NUL 按长度覆盖,正确)
        vm.movImm(VReg.V0, 0); // i
        vm.label("_seq_str_hcmp");
        vm.cmp(VReg.V0, VReg.V2);
        vm.jge("_strict_eq_true");
        vm.loadByte(VReg.V1, VReg.S2, 0);
        vm.loadByte(VReg.V3, VReg.S3, 0);
        vm.cmp(VReg.V1, VReg.V3);
        vm.jne("_strict_eq_false");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_seq_str_hcmp");
        // 数据段/非堆串:NUL-walk 早退(语义同旧 _strlen_slow 截断)
        vm.label("_seq_str_walk");
        vm.loadByte(VReg.V0, VReg.S2, 0);
        vm.loadByte(VReg.V1, VReg.S3, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_strict_eq_false");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_strict_eq_true");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_seq_str_walk");

        vm.label("_strict_eq_x_float");
        // 两个都是 float，比较原始位
        vm.cmp(VReg.S0, VReg.S1);
        vm.jeq("_strict_eq_true");
        // ±0:-0.0(0x8000…)与 +0.0(0x0)位不同但 === 相等。清符号位后皆为 0 → 都是 ±0.0
        // (字符串/对象/tagged 值清符号位后非 0,不误判)。整数以 float 存,故常规 int0 亦命中。
        vm.movImm64(VReg.V0, 0x7FFFFFFFFFFFFFFFn);
        vm.and(VReg.V1, VReg.S0, VReg.V0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_strict_eq_false");
        vm.and(VReg.V1, VReg.S1, VReg.V0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_strict_eq_true");
        vm.jmp("_strict_eq_false");

        vm.label("_strict_eq_false");
        vm.movImm64(VReg.RET, JS_FALSE);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);

        vm.label("_strict_eq_true");
        vm.movImm64(VReg.RET, JS_TRUE);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);
    }

    /**
     * _to_int32: 将 JSValue 转换为 32 位有符号整数 (ToInt32)
     * 输入: A0 = JSValue
     * 输出: RET = 32 位有符号整数 (符号扩展到 64 位)
     */
    generateToInt32() {
        const vm = this.vm;
        vm.label("_to_int32");
        vm.prologue(32, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);


        // 1. 检查是否已经是 NaN-boxed Int32 (tag 0x7FF8)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.V1, 0x7FF8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_to_int32_not_int32");

        // 是 Int32: 提取低 32 位并符号扩展
        vm.movImm64(VReg.V2, 0xFFFFFFFFn);
        vm.and(VReg.RET, VReg.S0, VReg.V2);
        vm.shlImm(VReg.RET, VReg.RET, 32);
        vm.sarImm(VReg.RET, VReg.RET, 32);
        vm.epilogue([VReg.S0], 32);

        vm.label("_to_int32_not_int32");
        // 2. 调用 _number_coerce 获取 float 模式
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_coerce"); // RET = float bits


        // 将 float64 位模式移动到 FP 寄存器
        vm.fmovToFloat(0, VReg.RET);

        // 检查 NaN/Infinity: 指数部分全 1 (0x7FF)
        vm.shrImm(VReg.V1, VReg.RET, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jeq("_to_int32_zero");

        // FCVTZS: 浮点转有符号整数 (截断)
        vm.fcvtzs(VReg.RET, 0); // RET = (int64)FP0


        // 仅保留低 32 位并符号扩展 (ECMAScript ToInt32 语义)
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.shlImm(VReg.RET, VReg.RET, 32);
        vm.sarImm(VReg.RET, VReg.RET, 32);

        vm.epilogue([VReg.S0], 32);

        vm.label("_to_int32_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 32);
    }

    /**
     * _to_uint32: 将 JSValue 转换为 32 位无符号整数 (ToUint32)
     * 输入: A0 = JSValue
     * 输出: RET = 32 位无符号整数 (零扩展到 64 位)
     */
    generateToUint32() {
        const vm = this.vm;
        vm.label("_to_uint32");
        vm.prologue(32, [VReg.S0]);

        vm.mov(VReg.S0, VReg.A0);
        vm.call("_number_coerce"); // RET = raw float bits

        vm.fmovToFloat(0, VReg.RET);

        // 检查 NaN/Infinity
        vm.shrImm(VReg.V1, VReg.RET, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jeq("_to_uint32_zero");

        // 转为 64 位整数
        vm.fcvtzs(VReg.RET, 0);

        // 取低 32 位 (零扩展)
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);

        vm.epilogue([VReg.S0], 32);

        vm.label("_to_uint32_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 32);
    }
}
