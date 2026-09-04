// asm.js 编译器 - 表达式编译（聚合模块）
// 导入并组合所有表达式相关的编译器

import { VReg } from "../../vm/registers.js";
import { Type, inferType } from "../core/types.js";

// 实参列表是否含 SpreadElement。热路径勿用 args.some(箭头)——gen1 上每次分配闭包很贵。
export function argsHasSpread(args, start) {
    if (!args) return false;
    const i0 = start || 0;
    for (let i = i0; i < args.length; i++) {
        const a = args[i];
        if (a && a.type === "SpreadElement") return true;
    }
    return false;
}

// 构造器/调用装载用寄存器表:模块级只建一次(勿在每次 new/call 里 new 数组)。
const CTOR_ARG_REGS_A0 = [VReg.A0, VReg.A1, VReg.A2, VReg.A3, VReg.A4];
const CTOR_ARG_REGS_A1 = [VReg.A1, VReg.A2, VReg.A3, VReg.A4, VReg.A5];


// number → IEEE 754 float32 位模式。纯算术实现(不依赖 TypedArray 多视图别名),
// 与 literals.js 的 floatToInt64Bits 同一模式:归一化用 *2//2(2 的幂无精度损失)。
// Math.round 对 (value-1)*2^23 实现 f64→f32 舍入(半值进位与 IEEE 偶舍差异仅限
// 精确平局,字面量编译场景可忽略)。返回无符号 32 位整数值。
function floatToF32Bits(value) {
    value = Number(value);
    if (value !== value) return 0x7fc00000; // NaN
    if (value === 0) {
        return (1 / value === -Infinity) ? 0x80000000 : 0; // ±0
    }
    let sign = 0;
    if (value < 0) { sign = 0x80000000; value = -value; }
    if (value === Infinity) return sign + 0x7f800000;
    // 归一化: value = m * 2^e, 1 <= m < 2
    let e = 0;
    while (value >= 2) { value = value / 2; e = e + 1; }
    while (value < 1) { value = value * 2; e = e - 1; }
    let biasedExp = e + 127;
    if (biasedExp >= 255) return sign + 0x7f800000; // 上溢 → Infinity
    if (biasedExp <= 0) {
        // 次正规: mant = round(m * 2^(biasedExp+22)),m∈[1,2)(2 的幂缩放无损)
        let k = biasedExp + 22;
        let scaled = value;
        while (k > 0) { scaled = scaled * 2; k = k - 1; }
        while (k < 0) { scaled = scaled / 2; k = k + 1; }
        let mant = Math.round(scaled);
        if (mant >= 8388608) return sign + 8388608; // 舍入进位到最小规格化
        return sign + mant;
    }
    let mant = Math.round((value - 1) * 8388608); // 2^23
    if (mant > 8388607) { // 舍入进位
        mant = 0;
        biasedExp = biasedExp + 1;
        if (biasedExp >= 255) return sign + 0x7f800000;
    }
    return sign + biasedExp * 8388608 + mant;
}

// 导入拆分的模块
import { LiteralCompiler, parseStringNumericLiteral } from "./literals.js";
import { OperatorCompiler } from "./operators.js";
import { AssignmentCompiler } from "./assignments.js";
import { MemberCompiler } from "./members.js";
import { DataStructureCompiler } from "../functions/data_structures.js";
import { AsyncCompiler } from "../async/index.js";

// 表达式编译方法混入 - 聚合所有表达式相关的编译器
export const ExpressionCompiler = {
    // 从各模块混入方法
    ...LiteralCompiler,
    ...OperatorCompiler,
    ...AssignmentCompiler,
    ...MemberCompiler,
    ...DataStructureCompiler,
    ...AsyncCompiler,

    // 编译表达式（根据目标类型选择编译方式）
    compileExpressionWithType(expr, targetType) {
        // 统一使用 compileExpression，让所有数值都成为 Number 对象
        // 这确保了类型系统的一致性，避免混合整数/Number 对象的问题
        this.compileExpression(expr);
    },

    // 编译表达式
    compileExpression(expr) {
        if (!expr) {
            // 返回默认值 0 (JS_FALSE/null 等的底码)
            this.vm.movImm(VReg.RET, 0);
            return;
        }
        switch (expr.type) {
            case "Literal":
                this.compileLiteral(expr);
                break;
            case "Identifier":
                this.compileIdentifier(expr);
                break;
            case "BinaryExpression":
                this.compileBinaryExpression(expr);
                break;
            case "LogicalExpression":
                this.compileLogicalExpression(expr);
                break;
            case "UnaryExpression":
                this.compileUnaryExpression(expr);
                break;
            case "AssignmentExpression":
                this.compileAssignmentExpression(expr);
                break;
            case "CallExpression":
                this.compileCallExpression(expr);
                break;
            case "MemberExpression":
                this.compileMemberExpression(expr);
                break;
            case "ThisExpression":
                this.compileThisExpression(expr);
                break;

            case "__WithPrecomputed":
                // with 赋值合成节点:值已求值到帧槽,直接装入 RET(复用普通赋值全逻辑,免 RHS 重求值)
                this.vm.load(VReg.RET, VReg.FP, expr.slot);
                break;
            case "NumericLiteral":
                this.compileNumericLiteral(expr.value);
                break;
            case "StringLiteral":
                this.compileStringLiteral(expr);
                break;
            case "BooleanLiteral":
                // 使用 NaN-boxing 格式的布尔值
                this.vm.movImm64(VReg.RET, expr.value ? 0x7ff9000000000001n : 0x7ff9000000000000n);
                break;
            case "NullLiteral":
                // 使用 NaN-boxing 格式的 null
                this.vm.movImm64(VReg.RET, 0x7ffa000000000000n); // was lea+load _js const
                break;
            case "UpdateExpression":
                this.compileUpdateExpression(expr);
                break;
            case "ArrayExpression":
                this.compileArrayExpression(expr);
                break;
            case "ObjectExpression":
                this.compileObjectExpression(expr);
                break;
            case "ConditionalExpression":
                this.compileConditionalExpression(expr);
                break;
            case "FunctionExpression":
            case "ArrowFunctionExpression":
                this.compileFunctionExpression(expr);
                break;
            case "TemplateLiteral":
                this.compileTemplateLiteral(expr);
                break;
            case "NewExpression":
                this.compileNewExpression(expr);
                break;
            case "AwaitExpression":
                this.compileAwaitExpression(expr);
                break;
            case "__YsaTakeReturn": {
                // yield* return 注入标志(全局)。x64 V0≡RET:lea 后再 load RET 会冲掉地址,
                // store 前必须重新 lea。
                const took = this.ctx.newLabel("ysa_took");
                const done = this.ctx.newLabel("ysa_take_done");
                this.vm.lea(VReg.V1, "_agen_raw_yield");
                this.vm.load(VReg.RET, VReg.V1, 0);
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jne(took);
                this.vm.movImm(VReg.RET, 0);
                this.vm.jmp(done);
                this.vm.label(took);
                this.vm.lea(VReg.V1, "_agen_raw_yield");
                this.vm.movImm(VReg.V2, 0);
                this.vm.store(VReg.V1, 0, VReg.V2);
                this.vm.movImm(VReg.RET, 1);
                this.vm.label(done);
                break;
            }
            case "__CallWithThis":
                // yield* 缓存的 [[NextMethod]] / throw / return:Call(fn, this, args)
                // 不经 fn.call(…),避免 class 方法里 Function.prototype.call 分派丢参。
                this.compileExpression(expr.calleeFn);
                this.vm.push(VReg.RET);
                this.compileExpression(expr.thisArg);
                this.vm.push(VReg.RET);
                this.vm.pop(VReg.V5);
                this.vm.pop(VReg.V6);
                this.compileMethodCall(VReg.V6, VReg.V5, expr.callArgs || []);
                break;
            case "YieldExpression":
                // [批次D] 生成器 yield
                this.compileYieldExpression(expr);
                break;
            case "SuperExpression":
                // 裸 super 作 MemberExpression.object 求值时 ≡ GetThisBinding（未初始化抛 ReferenceError）。
                // 真实 [[HomeObject]]/原型链取属性由 super.x / super[x] / super() 专用路径处理。
                this.compileThisExpression(expr);
                break;
            case "MetaProperty":
                this.compileMetaProperty(expr);
                break;
            case "SequenceExpression":
                // (a, b, c) —— 依次求值，结果为最后一个表达式的值
                {
                    const seq = expr.expressions || [];
                    if (seq.length === 0) {
                        this.vm.movImm(VReg.RET, 0);
                    } else {
                        for (let si = 0; si < seq.length; si++) {
                            this.compileExpression(seq[si]);
                        }
                    }
                }
                break;
            case "RegexLiteral":
                // /pattern/flags → __RE_new(pattern, flags)(纯 JS shim,__regexp_shim 由
                // readModuleSource 注入 import;路线同 JSON shim)。shim 对象是普通对象
                // {source, flags, lastIndex, ...},.test/.exec 由 compileCallExpression
                // 按静态类型 REGEXP 分派到 __RE_test/__RE_exec。
                // 编译器自身源码刻意不用正则字面量(见 index.js 注释),故不影响自举。
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "__RE_new" },
                    arguments: [
                        { type: "Literal", value: expr.pattern || "" },
                        { type: "Literal", value: expr.flags || "" },
                    ],
                });
                break;
            case "ClassDeclaration":
            case "ClassExpression":
                // 类表达式 `const C = class D {...}` / `class {...}`:内联生成类(与声明同路径,
                // 绑定类名的局部槽,使体内自引用 typeof D 可解析),再把类值(读类名标识符)留 RET
                // 供外层绑定。匿名的合成名由 parser 赋。
                this.compileClassExpression(expr);
                break;
            default:
                console.warn("Unhandled expression type:", expr.type);
                this.vm.movImm(VReg.RET, 0);
        }
    },

    // 类表达式编译:内联执行类声明(建类信息对象 + classScope 名绑定 + 静态字段/块)。
    // compileClassDeclaration 对 ClassExpression 在 leaveScope 前把类值写入 RET,
    // 不可再 Identifier 读名(外层同名 var 已恢复)。
    compileClassExpression(expr) {
        this.compileClassDeclaration(expr, true);
    },

    // 编译 new 表达式
    // 支持 new Int(x), new Float(x), new Array(...), new Date() 等
    compileNewExpression(expr) {
        // 支持 Number.Int32 等子类型
        if (expr.callee && expr.callee.type === "MemberExpression") {
            const obj = expr.callee.object;
            const prop = expr.callee.property;
            const numberSubtype = prop && prop.type === "Identifier" &&
                (prop.name === "Int8" || prop.name === "Int16" || prop.name === "Int32" ||
                 prop.name === "Int64" || prop.name === "Uint8" || prop.name === "Uint16" ||
                 prop.name === "Uint32" || prop.name === "Uint64" || prop.name === "Float16" ||
                 prop.name === "Float32" || prop.name === "Float64");
            if (obj.type === "Identifier" && obj.name === "Number" && numberSubtype) {
                const subtypeName = prop.name;
                const args = expr.arguments || [];
                this.compileNumberSubtype(subtypeName, args);
                return;
            }

            // 支持 new AST.Identifier(...)
            this.compileExpression(expr.callee);
            this.vm.mov(VReg.V6, VReg.RET); // V6 = 构造函数对象
            this.compileDynamicNew(VReg.V6, expr.arguments || []);
            return;
        }

        if (!expr.callee || expr.callee.type !== "Identifier") {
            // 复杂 callee(`new (expr)(...)`,如 new (new Proxy(...))() / new (cond?A:B)()):
            // 求值 callee 后走值路径 compileDynamicNew(与 MemberExpression 同法;含 Proxy
            // construct 检测)。此前发 RET=0("暂不支持"),new 结果恒 0。
            if (expr.callee) {
                this.compileExpression(expr.callee);
                this.vm.mov(VReg.V6, VReg.RET); // V6 = 构造函数值
                this.compileDynamicNew(VReg.V6, expr.arguments || []);
                return;
            }
            this.vm.movImm(VReg.RET, 0);
            return;
        }

        const typeName = expr.callee.name;
        const args = expr.arguments || [];

        switch (typeName) {
            case "Int":
                // new Int(value) - 返回整数值
                if (args.length > 0) {
                    this.compileExpressionAsInt(args[0]);
                } else {
                    this.vm.movImm(VReg.RET, 0);
                }
                break;

            case "Boolean": {
                // new Boolean(x) → same order as new String / Object(bool):
                // materialize ctor+proto first, then _boolean_new (sets __proto__
                // from _nsobj_boolean_proto). The old "call _boolean_new then
                // emitBooleanProtoObject then store(V1,16,RET)" epilogue SIGSEGV
                // on x64: emit* after the wrapper is live, plus a redundant proto
                // store. Object(false) already used this order and worked.
                this.emitBooleanCtorObject();
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                } else {
                    this.vm.movImm64(VReg.RET, 0x7FF9000000000000n); // false
                }
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_boolean_new"); // RET = boxed wrapper (0x7FFD)
                break;
            }

            case "Float":
            case "Number":
                // new Number(x) → same order as new String / Object(0):
                // emitNumberCtorObject first, then _number_new. Runtime already
                // sets wrapper.__proto__ from _nsobj_number_proto. The old
                // post-call emitNumberProtoObject + store(V1,16,RET) SIGSEGV on
                // linux-x64 (4-405 / 4-581). Object(0) already used this order.
                this.emitNumberCtorObject();
                if (args.length > 0) {
                    const numberArg = args[0];
                    if (numberArg.type === "Literal" && typeof numberArg.value === "string") {
                        // Match the Number("literal") call fast path: parsing a known
                        // StringNumericLiteral at compile time avoids the runtime decimal
                        // accumulator's long-mantissa rounding loss.  _number_new still
                        // performs its normal wrapper allocation and prototype setup.
                        const parsed = parseStringNumericLiteral(numberArg.value);
                        this.compileNumericLiteral(parsed);
                    } else {
                        this.compileExpression(numberArg);
                    }
                } else {
                    this.vm.movImm(VReg.RET, 0);
                }
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_number_new"); // RET = boxed wrapper (0x7FFD)
                break;

            case "String": {
                // new String(x) → 与 Object("str") / assign ToObject 同形(_string_new):
                // __value + length + UTF-16 索引自有键(gOPN new String("abc") = 0,1,2,length)
                // 须先物化 String 单例+proto.constructor:否则 `new String()` 早于标识符
                // String 时 _ensure_string_proto 无 constructor → 读到 Object.prototype.constructor,
                // `__str.constructor !== String`(S15.5.2.1_A1_T2)。
                this.emitStringCtorObject();
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_valueToStr");
                } else {
                    this.vm.lea(VReg.RET, this.asm.addString(""));
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                }
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_string_new");
                break;
            }

            // Number 子类型 - 整数
            case "Int8":
            case "Int16":
            case "Int32":
            case "Int64":
            case "Uint8":
            case "Uint16":
            case "Uint32":
            case "Uint64":
            // Number 子类型 - 浮点
            case "Float16":
            case "Float32":
            case "Float64":
                this.compileNumberSubtype(typeName, args);
                break;

            case "Array":
                // Ensure Array ctor emitted once for proto chain lookups.
                if (this.emitArrayCtorObject) this.emitArrayCtorObject();
                // new Array(len) 或 new Array(a, b, c)
                if (args.length === 0) {
                    // 空数组
                    this.compileArrayExpression({ elements: [] });
                } else if (args.length === 1) {
                    // 单参:Number ∧ ToUint32(n)===n → ArrayCreate;Number 否则 RangeError;
                    // 非 Number → 单元素数组。字面量整数快路;其余走 _array_ctor_single。
                    const lit = args[0];
                    if ((lit.type === "Literal" || lit.type === "NumericLiteral") &&
                        typeof lit.value === "number" &&
                        lit.value === (lit.value >>> 0) && lit.value >= 0) {
                        this.vm.movImm(VReg.A0, lit.value >>> 0);
                        this.vm.call("_array_new_with_size");
                        this.vm.emitMaskLoad(VReg.V1);
                        this.vm.andMaskReg(VReg.V2, VReg.RET, VReg.V1);
                        this.vm.movImm64(VReg.V1, 0x7ffe000000000000n);
                        this.vm.or(VReg.RET, VReg.V2, VReg.V1);
                    } else {
                        this.compileExpression(args[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_array_ctor_single");
                    }
                } else {
                    // new Array(a, b, c) - 等同于 [a, b, c]
                    this.compileArrayExpression({ elements: args });
                }
                break;

            case "Object": {
                // new Object(x) ≡ Object(x)(ToObject);无参 → {}。此前一律空对象
                // → new Object("s").valueOf() 丢原串(S15.2.4.4_A1_T3)。
                if (args.length === 0) {
                    this.compileObjectExpression({ properties: [] });
                    break;
                }
                // 复用 Object(x) 调用路径(同 ToObject)
                this.compileCallExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "Object" },
                    arguments: args,
                });
                break;
            }

            case "Symbol":
                // %Symbol% has [[Call]] but deliberately no [[Construct]]. Evaluate
                // arguments before reporting the failed construction attempt.
                for (let si = 0; si < args.length; si++) this.compileExpression(args[si]);
                this.emitThrowTypeError("Symbol is not a constructor");
                break;

            case "Promise":
                // new Promise(executor) - executor 收到 resolve/reject 闭包
                if (this.emitPromiseCtorObject) this.emitPromiseCtorObject();
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A0, 0);
                }
                this.vm.call("_promise_new");
                break;

            case "Date":
                // new Date() - 创建 Date 对象
                // [L1] 物化 Date.prototype 方法槽：否则仅 `new Date`+Object 路径接收者
                // （推断为 Object）经 `_object_get_date_side` 读空 `_nsobj_date_proto`
                // → getFullYear 等恒 undefined（S15.2.2.1_A2_T5）。与 new Array 同形。
                if (this.emitDateCtorObject) this.emitDateCtorObject();
                if (args.length >= 2) {
                    // [#35] new Date(y, mo, d?, h?, mi?, s?, ms?) —— Hinnant
                    // days-from-civil 历法(截断除法与 era 调整契合,全年代正确)。
                    // 本运行时按 UTC 语义自洽(getFullYear 等走同一 UTC 历法)。
                    const dOffs = [];
                    for (let di2 = 0; di2 < 7; di2++) {
                        dOffs.push(this.ctx.allocLocal(`__date_a${di2}_${this.nextLabelId()}`));
                        if (di2 < args.length) {
                            this.compileExpression(args[di2]);
                            this.emitNumberCoerceFast();
                            this.vm.fmovToFloat(0, VReg.RET);
                            this.vm.fcvtzs(VReg.RET, 0);
                        } else {
                            this.vm.movImm(VReg.RET, di2 === 2 ? 1 : 0); // 缺省日=1,余 0
                        }
                        this.vm.store(VReg.FP, dOffs[di2], VReg.RET);
                    }
                    // [ES MakeDate] 两位数年份:0<=y<=99 → y+1900(new Date(95,0,1)=1995)。
                    // 作用于原始年份实参,先于下方 m<=2 的 y-- 历法调整。
                    {
                        const dy2 = this.ctx.newLabel("date_2digit_year_skip");
                        this.vm.load(VReg.V0, VReg.FP, dOffs[0]);
                        this.vm.cmpImm(VReg.V0, 0);
                        this.vm.jlt(dy2);
                        this.vm.cmpImm(VReg.V0, 99);
                        this.vm.jgt(dy2);
                        this.vm.addImm(VReg.V0, VReg.V0, 1900);
                        this.vm.store(VReg.FP, dOffs[0], VReg.V0);
                        this.vm.label(dy2);
                    }
                    // m = mo+1; if (m<=2) y--
                    this.vm.load(VReg.V0, VReg.FP, dOffs[1]);
                    this.vm.addImm(VReg.V0, VReg.V0, 1); // m
                    this.vm.load(VReg.V1, VReg.FP, dOffs[0]); // y
                    const dL1 = this.ctx.newLabel("date_mgt2");
                    this.vm.cmpImm(VReg.V0, 2);
                    this.vm.jgt(dL1);
                    this.vm.subImm(VReg.V1, VReg.V1, 1);
                    this.vm.label(dL1);
                    // era = (y>=0 ? y : y-399)/400
                    this.vm.mov(VReg.V2, VReg.V1);
                    const dL2 = this.ctx.newLabel("date_ypos");
                    this.vm.cmpImm(VReg.V2, 0);
                    this.vm.jge(dL2);
                    this.vm.subImm(VReg.V2, VReg.V2, 399);
                    this.vm.label(dL2);
                    this.vm.movImm(VReg.V3, 400);
                    this.vm.div(VReg.V4, VReg.V2, VReg.V3); // era
                    // yoe = y - era*400
                    this.vm.movImm(VReg.V3, 400);
                    this.vm.mul(VReg.V2, VReg.V4, VReg.V3);
                    this.vm.sub(VReg.V1, VReg.V1, VReg.V2); // yoe
                    // mp = m + (m>2 ? -3 : 9)
                    const dL3 = this.ctx.newLabel("date_mp");
                    const dL4 = this.ctx.newLabel("date_mpd");
                    this.vm.cmpImm(VReg.V0, 2);
                    this.vm.jgt(dL3);
                    this.vm.addImm(VReg.V0, VReg.V0, 9);
                    this.vm.jmp(dL4);
                    this.vm.label(dL3);
                    this.vm.subImm(VReg.V0, VReg.V0, 3);
                    this.vm.label(dL4);
                    // doy = (153*mp+2)/5 + d - 1
                    this.vm.movImm(VReg.V3, 153);
                    this.vm.mul(VReg.V0, VReg.V0, VReg.V3);
                    this.vm.addImm(VReg.V0, VReg.V0, 2);
                    this.vm.movImm(VReg.V3, 5);
                    this.vm.div(VReg.V0, VReg.V0, VReg.V3);
                    this.vm.load(VReg.V3, VReg.FP, dOffs[2]);
                    this.vm.add(VReg.V0, VReg.V0, VReg.V3);
                    this.vm.subImm(VReg.V0, VReg.V0, 1); // doy
                    // doe = yoe*365 + yoe/4 - yoe/100 + doy
                    this.vm.movImm(VReg.V3, 365);
                    this.vm.mul(VReg.V2, VReg.V1, VReg.V3);
                    this.vm.movImm(VReg.V3, 4);
                    this.vm.div(VReg.V3, VReg.V1, VReg.V3);
                    this.vm.add(VReg.V2, VReg.V2, VReg.V3);
                    this.vm.movImm(VReg.V3, 100);
                    this.vm.div(VReg.V3, VReg.V1, VReg.V3);
                    this.vm.sub(VReg.V2, VReg.V2, VReg.V3);
                    this.vm.add(VReg.V2, VReg.V2, VReg.V0); // doe
                    // days = era*146097 + doe - 719468
                    this.vm.movImm(VReg.V3, 146097);
                    this.vm.mul(VReg.V4, VReg.V4, VReg.V3);
                    this.vm.add(VReg.V2, VReg.V2, VReg.V4);
                    this.vm.movImm(VReg.V3, 719468);
                    this.vm.sub(VReg.V2, VReg.V2, VReg.V3); // days
                    // ms = ((days*24 + h)*60 + mi)*60000 + s*1000 + msArg
                    this.vm.movImm(VReg.V3, 24);
                    this.vm.mul(VReg.V2, VReg.V2, VReg.V3);
                    this.vm.load(VReg.V3, VReg.FP, dOffs[3]);
                    this.vm.add(VReg.V2, VReg.V2, VReg.V3);
                    this.vm.movImm(VReg.V3, 60);
                    this.vm.mul(VReg.V2, VReg.V2, VReg.V3);
                    this.vm.load(VReg.V3, VReg.FP, dOffs[4]);
                    this.vm.add(VReg.V2, VReg.V2, VReg.V3);
                    this.vm.movImm(VReg.V3, 60000);
                    this.vm.mul(VReg.V2, VReg.V2, VReg.V3);
                    this.vm.load(VReg.V3, VReg.FP, dOffs[5]);
                    this.vm.movImm(VReg.V4, 1000);
                    this.vm.mul(VReg.V3, VReg.V3, VReg.V4);
                    this.vm.add(VReg.V2, VReg.V2, VReg.V3);
                    this.vm.load(VReg.V3, VReg.FP, dOffs[6]);
                    this.vm.add(VReg.V2, VReg.V2, VReg.V3); // ms(整数)
                    this.vm.scvtf(0, VReg.V2);
                    this.vm.fmovToInt(VReg.A0, 0); // raw float ms
                    this.vm.call("_date_new_ts"); // 不做 0→now 特判(1970-01-01/纪元正确)
                } else if (args.length > 0) {
                    const arg = args[0];
                    // 检查是否是字符串字面量
                    if (arg.type === "StringLiteral" || (arg.type === "Literal" && typeof arg.value === "string")) {
                        // new Date("ISO-string") - 从字符串创建
                        this.compileExpression(arg);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_date_new_from_string");
                    } else {
                        // new Date(value) - ToPrimitive(default), then String
                        // parse or ToNumber timestamp.  The runtime helper
                        // keeps the evaluated argument alive and ensures it is
                        // evaluated only once (objects may run user getters).
                        this.compileExpression(arg);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_date_new_single");
                    }
                } else {
                    // new Date() - 传入 0，让 _date_new 获取当前时间
                    this.vm.movImm(VReg.A0, 0);
                    this.vm.call("_date_new");
                }
                break;

            case "WeakMap": // WeakMap 路由到 Map:基础操作 set/get/has/delete 同,weakness
                            // 是 GC 优化非可观察语义;此前无分派 → new WeakMap() 崩(退出 1)。
            case "Map":
                // new Map(iterable?):物化原型(Get(map,"set") / @@toStringTag),再
                // _map_new + 可选 _map_construct_fill(Call adder,懒迭代,IteratorClose)。
                this.emitMapCtorObject();
                this.emitArrayCtorObject();
                this.vm.call("_map_new");
                if (args.length >= 1) {
                    const collOff = this.ctx.allocLocal(`__mapnew_coll_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, collOff, VReg.RET);
                    this.compileExpression(args[0]);
                    const skipL = this.ctx.newLabel("mapnew_skipfill");
                    const endL = this.ctx.newLabel("mapnew_end");
                    this.vm.shrImm(VReg.V2, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V2, 0x7FFA); this.vm.jeq(skipL);
                    this.vm.cmpImm(VReg.V2, 0x7FFB); this.vm.jeq(skipL);
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, collOff);
                    this.vm.call("_map_construct_fill");
                    this.vm.jmp(endL);
                    this.vm.label(skipL);
                    this.vm.load(VReg.RET, VReg.FP, collOff);
                    this.vm.label(endL);
                }
                if (typeName === "WeakMap") {
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_collection_mark_weak");
                }
                break;

            case "WeakSet":
            case "Set":
                this.emitSetCtorObject();
                this.emitArrayCtorObject();
                this.vm.call("_set_new");
                if (args.length >= 1) {
                    const scollOff = this.ctx.allocLocal(`__setnew_coll_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, scollOff, VReg.RET);
                    this.compileExpression(args[0]);
                    const skipL = this.ctx.newLabel("setnew_skipfill");
                    const endL = this.ctx.newLabel("setnew_end");
                    this.vm.shrImm(VReg.V2, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V2, 0x7FFA); this.vm.jeq(skipL);
                    this.vm.cmpImm(VReg.V2, 0x7FFB); this.vm.jeq(skipL);
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, scollOff);
                    this.vm.call("_set_construct_fill");
                    this.vm.jmp(endL);
                    this.vm.label(skipL);
                    this.vm.load(VReg.RET, VReg.FP, scollOff);
                    this.vm.label(endL);
                }
                if (typeName === "WeakSet") {
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_collection_mark_weak");
                }
                break;

            case "Proxy":
                // new Proxy(target, handler):target/handler 求值后建 proxy 块(type=8)。
                // 缺参 = undefined;_proxy_new 对非 Object 抛 TypeError(ProxyCreate)。
                // get/set/has 陷阱在 _object_get/_object_set/_prop_in 冷分支调 handler。
                // (独立 case,避开 WeakMap→Map / WeakSet→Set 的 fall-through 链)
                {
                    const proxyTOff = this.ctx.allocLocal(`__proxynew_t_${this.nextLabelId()}`);
                    if (args.length >= 1) {
                        this.compileExpression(args[0]);
                    } else {
                        this.vm.movImm64(VReg.RET, 0x7ffb000000000000n);
                    }
                    this.vm.store(VReg.FP, proxyTOff, VReg.RET);
                    if (args.length >= 2) {
                        this.compileExpression(args[1]);
                        this.vm.mov(VReg.A1, VReg.RET);
                    } else {
                        this.vm.movImm64(VReg.A1, 0x7ffb000000000000n);
                    }
                    this.vm.load(VReg.A0, VReg.FP, proxyTOff);
                    this.vm.call("_proxy_new");
                }
                break;

            case "WeakRef": {
                // new WeakRef(target):Type(target) 须为 Object。实例暂为普通对象
                // (无自有键),供 Object.seal/freeze 的 SetIntegrityLevel;deref 另案。
                if (args.length === 0) {
                    this.emitThrowTypeError("WeakRef: target must be an object");
                    break;
                }
                this.compileExpression(args[0]);
                const wrOk = this.ctx.newLabel("weakref_tgt_ok");
                this.vm.shrImm(VReg.V0, VReg.RET, 48);
                this.vm.cmpImm(VReg.V0, 0x7FFD); this.vm.jeq(wrOk);
                this.vm.cmpImm(VReg.V0, 0x7FFE); this.vm.jeq(wrOk);
                this.vm.cmpImm(VReg.V0, 0x7FFF); this.vm.jeq(wrOk);
                this.emitThrowTypeError("WeakRef: target must be an object");
                this.vm.label(wrOk);
                this.vm.call("_object_new");
                this.vm.call("_box_obj_r");
                break;
            }

            case "FinalizationRegistry": {
                // new FinalizationRegistry(cleanup):cleanup 须可调用。实例暂为普通对象。
                if (args.length === 0) {
                    this.emitThrowTypeError("FinalizationRegistry: cleanup must be callable");
                    break;
                }
                this.compileExpression(args[0]);
                const frOk = this.ctx.newLabel("fr_cb_ok");
                this.vm.shrImm(VReg.V0, VReg.RET, 48);
                this.vm.cmpImm(VReg.V0, 0x7FFF);
                this.vm.jeq(frOk);
                this.emitThrowTypeError("FinalizationRegistry: cleanup must be callable");
                this.vm.label(frOk);
                this.vm.call("_object_new");
                this.vm.call("_box_obj_r");
                break;
            }

            case "RegExp":
                // RegExp 构造(pattern, flags) → __RE_new(pattern, flags)(纯 JS shim,
                // 路线同正则字面量,见 compileExpression 的 RegexLiteral case)。
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "__RE_new" },
                    arguments: [
                        args.length >= 1 ? args[0] : { type: "Literal", value: "" },
                        args.length >= 2 ? args[1] : { type: "Literal", value: "" },
                        { type: "Literal", value: 0 },
                    ],
                });
                break;

            case "Error":
            case "TypeError":
            case "RangeError":
            case "SyntaxError":
            case "ReferenceError":
            case "URIError":
            case "EvalError":
            case "AggregateError": {
                // [#36] Error 族:普通对象 {name, message, __asmjs_err:true}。
                // 原为返回 undefined(throw new Error 后 catch 到 0、.message 崩)。
                // instanceof 依赖 __asmjs_err 标记(Error)与 name 串比对(具体类)。
                const errObj = this.ctx.allocLocal(`__err_${this.nextLabelId()}`);
                // AggregateError(errors, message):message 是第 2 参,errors 是第 1 参;
                // 其余 Error 族 message 是第 1 参。先求 errors(若有)存槽,再求 message。
                const isAggErr = typeName === "AggregateError";
                const msgArgIdx = isAggErr ? 1 : 0;
                let aggErrSlot = null;
                if (isAggErr && args.length > 0) {
                    aggErrSlot = this.ctx.allocLocal(`__aggerrs_${this.nextLabelId()}`);
                    this.compileExpression(args[0]); // errors 可迭代(先求值,防副作用序)
                    this.vm.store(VReg.FP, aggErrSlot, VReg.RET);
                }
                if (args.length > msgArgIdx) {
                    this.compileExpression(args[msgArgIdx]); // message
                    // undefined → ""、非串 → ToString(规范 Error 构造的 message 语义)
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_error_msg_norm");
                } else {
                    this.vm.lea(VReg.RET, this.asm.addString(""));
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                }
                const errMsg = this.ctx.allocLocal(`__errmsg_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, errMsg, VReg.RET);
                this.vm.call("_object_new");
                this.vm.call("_box_obj_r"); // box->helper
                this.vm.store(VReg.FP, errObj, VReg.RET);
                // name
                this.vm.mov(VReg.A0, VReg.RET);
                this.emitBoxedStringKey("name", VReg.A1);
                this.vm.lea(VReg.A2, this.asm.addString(typeName));
                this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                this.vm.or(VReg.A2, VReg.A2, VReg.V1);
                this.vm.call("_object_set");
                // message
                this.vm.load(VReg.A0, VReg.FP, errObj);
                this.emitBoxedStringKey("message", VReg.A1);
                this.vm.load(VReg.A2, VReg.FP, errMsg);
                this.vm.call("_object_set");
                // instanceof 标记(非 enumerable:勿进 Object.keys,否则 defineProperties
                // 以 Error 作 Properties 会把品牌布尔当描述符 → TypeError,15.2.3.7-5-a-16)
                this.vm.load(VReg.A0, VReg.FP, errObj);
                this.emitBoxedStringKey("__asmjs_err", VReg.A1);
                this.vm.movImm64(VReg.A2, 0x7ff9000000000001n); // was lea+load _js const
                this.vm.call("_object_set");
                this.vm.load(VReg.A0, VReg.FP, errObj);
                this.emitBoxedStringKey("__asmjs_err", VReg.A1);
                this.vm.movImm(VReg.A2, 5); // writable|configurable, !enumerable
                this.vm.call("_object_set_prop_attr");
                // AggregateError.errors = 第 1 参可迭代(node 语义;缺失则空数组)
                if (isAggErr) {
                    this.vm.load(VReg.A0, VReg.FP, errObj);
                    this.emitBoxedStringKey("errors", VReg.A1);
                    if (aggErrSlot != null) {
                        this.vm.load(VReg.A2, VReg.FP, aggErrSlot);
                    } else {
                        this.vm.movImm(VReg.A0, 0);
                        this.vm.call("_array_new_with_size");
                        this.vm.call("_box_arr_r");
                        this.vm.mov(VReg.A2, VReg.RET);
                        this.vm.load(VReg.A0, VReg.FP, errObj);
                        this.emitBoxedStringKey("errors", VReg.A1);
                    }
                    this.vm.call("_object_set");
                }
                // cause:仅当 options 自有 "cause" 时 InstallErrorCause(ES2022)。
                // 此前恒落 cause:undefined 自有键 → Object.keys(Error) 污染 defineProperties。
                const optIdx = typeName === "AggregateError" ? 2 : 1;
                if (args.length > optIdx) {
                    const optSlot = this.ctx.allocLocal(`__erropt_${this.nextLabelId()}`);
                    this.compileExpression(args[optIdx]); // options
                    this.vm.store(VReg.FP, optSlot, VReg.RET);
                    const noCauseLbl = this.ctx.newLabel("err_nocause");
                    this.vm.load(VReg.A0, VReg.FP, optSlot);
                    this.emitBoxedStringKey("cause", VReg.A1);
                    this.vm.call("_error_opt_has_cause");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jeq(noCauseLbl);
                    this.vm.load(VReg.A0, VReg.FP, optSlot);
                    this.emitBoxedStringKey("cause", VReg.A1);
                    this.vm.call("_object_get");
                    const causeSlot = this.ctx.allocLocal(`__errcause_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, causeSlot, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, errObj);
                    this.emitBoxedStringKey("cause", VReg.A1);
                    this.vm.load(VReg.A2, VReg.FP, causeSlot);
                    this.vm.call("_object_set");
                    this.vm.label(noCauseLbl);
                }
                // [[Prototype]] = Error.prototype / TypeError.prototype …
                // (defineProperty(Error.prototype,"prop") 继承;getPrototypeOf===Error.prototype)
                if (this.emitErrorCtorRef) {
                    this.emitErrorCtorRef(typeName);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.emitBoxedStringKey("prototype", VReg.A1);
                    this.vm.call("_closure_prop_get");
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, errObj);
                    this.vm.call("_object_setPrototypeOf");
                }
                this.vm.load(VReg.RET, VReg.FP, errObj);
                break;
            }

            // TypedArray 类型
            case "Int8Array":
            case "Uint8Array":
            case "Uint8ClampedArray":
            case "Int16Array":
            case "Uint16Array":
            case "Int32Array":
            case "Uint32Array":
            case "BigInt64Array":
            case "BigUint64Array":
            case "Float32Array":
            case "Float64Array":
                this.compileTypedArrayNew(typeName, args);
                break;
            
            case "ArrayBuffer":
                // new ArrayBuffer(byteLength[, {maxByteLength}]):给了 maxByteLength 即
                // resizable buffer(一次按 max 分配,resize 只改 byteLength)。
                if (args.length > 1 && args[1]) {
                    const abLenOff = this.ctx.allocLocal(`__ab_len_${this.nextLabelId()}`);
                    if (args.length > 0) { this.compileExpressionAsInt(args[0]); } else { this.vm.movImm(VReg.RET, 0); }
                    this.vm.store(VReg.FP, abLenOff, VReg.RET);
                    this.compileExpression(args[1]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.lea(VReg.A1, this.addStringConstant("maxByteLength"));
                    this.vm.call("_tag_str_a1");
                    this.vm.call("_object_get");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_int32");
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, abLenOff);
                    this.vm.call("_arraybuffer_new_max");
                    break;
                }
                // new ArrayBuffer(byteLength)
                if (args.length > 0) {
                    this.compileExpressionAsInt(args[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A0, 0);
                }
                this.vm.call("_arraybuffer_new");
                break;

            case "DataView": {
                // new DataView(buffer, byteOffset=0, byteLength=buffer.byteLength-byteOffset)
                const dvBufOff = this.ctx.allocLocal(`__dv_buf_${this.nextLabelId()}`);
                const dvOffOff = this.ctx.allocLocal(`__dv_off_${this.nextLabelId()}`);
                this.compileExpression(args[0]);           // buffer
                this.vm.store(VReg.FP, dvBufOff, VReg.RET);
                if (args.length >= 2) { this.compileExpressionAsInt(args[1]); }
                else { this.vm.movImm(VReg.RET, 0); }
                this.vm.store(VReg.FP, dvOffOff, VReg.RET); // byteOffset
                if (args.length >= 3) {
                    this.compileExpressionAsInt(args[2]);
                    this.vm.mov(VReg.A2, VReg.RET);
                } else {
                    // byteLength = buffer.byteLength - byteOffset
                    this.vm.load(VReg.A0, VReg.FP, dvBufOff);
                    this.vm.call("_arraybuffer_bytelength");
                    this.vm.load(VReg.V1, VReg.FP, dvOffOff);
                    this.vm.sub(VReg.A2, VReg.RET, VReg.V1);
                }
                this.vm.load(VReg.A0, VReg.FP, dvBufOff);
                this.vm.load(VReg.A1, VReg.FP, dvOffOff);
                this.vm.call("_dataview_new");
                break;
            }

            case "Function": {
                // new Function(...argNames, body) → __makeFunction([argNames], body)(route B
                // 引擎:把 body 编成带具名形参的片段并返回可调用闭包;__eval_shim 的 import 由
                // readModuleSource 按"源码含 new Function("注入)。仅当 Function 未被用户局部/
                // 函数遮蔽时改派。末位实参为 body,其余为形参名(前 6 个绑定)。
                const shadowed = (this.ctx.getLocal && this.ctx.getLocal("Function")) ||
                    (this.ctx.getFunction && this.ctx.getFunction("Function"));
                if (!shadowed && !this.engineNoIC &&
                    this.getFunctionLabel && this.getFunctionLabel("__makeFunction")) {
                    const bodyArg = args.length > 0 ? args[args.length - 1]
                        : { type: "Literal", value: "" };
                    const nameArgs = [];
                    for (let ni = 0; ni < args.length - 1; ni++) nameArgs.push(args[ni]);
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__makeFunction" },
                        arguments: [
                            { type: "ArrayExpression", elements: nameArgs },
                            bodyArg,
                        ],
                    });
                    break;
                }
                if (!shadowed && this.engineNoIC) {
                    // Eval fragments cannot import __makeFunction. The host
                    // eval shim registers CreateDynamicFunction on
                    // `_dynamic_function_maker`.
                    this.compileCallArguments(args);
                    this.vm.call("_dynamic_function_ctor_call");
                    break;
                }
                this.compileUserClassNew(typeName, args);
                break;
            }

            case "Math": {
                // Math 是命名空间对象,无 [[Construct]]。`new Math` 此前落到
                // compileUserClassNew("Math") 当用户类,不抛 TypeError。
                const mathShadowed = (this.ctx.getLocal && this.ctx.getLocal("Math")) ||
                    (this.ctx.getFunction && this.ctx.getFunction("Math")) ||
                    (this.ctx.getMainCapturedVar && this.ctx.getMainCapturedVar("Math"));
                if (!mathShadowed) {
                    this.compileExpression(expr.callee);
                    this.vm.mov(VReg.V6, VReg.RET);
                    this.compileDynamicNew(VReg.V6, args);
                    break;
                }
            }
            // shadowed Math 落入 default
            default: {
                // [#69] 普通函数(非 class)用 new:ES5 构造器语义,专路处理(this 在 A5,
                // 与 class 的 A0 约定不同,见 index.js #36)。带展开实参退回旧路。
                const declNode = this.ctx.getFunction ? this.ctx.getFunction(typeName) : null;
                // 局部绑定(形参/变量,非本作用域 class 声明槽)**遮蔽**同名全局函数/类
                // (`function mk2(K,…){new K(…)}` 撞顶层 `class K`:此前把形参里的闭包按
                // classinfo 布局解 → 崩/错绑)。有遮蔽局部或无声明的局部/捕获值 → 值路径
                // compileDynamicNew(标识符读经通用路径,装箱/捕获/TDZ 语义一致;其内按块
                // 类型运行时分派 classinfo/闭包/Proxy)。
                // 字典读须 hasOwnProperty 守卫(原型链污染铁律:类名撞 Object.prototype
                // 成员时裸读在 node/自编译器分歧 → 编译产物-only 分歧)。
                // 导入绑定除外:imported class 的 new 保持既有 compileUserClassNew 路径。
                // (决定性:node 把导入名放局部槽而 g1 不放——若按 getLocal 路由,node 编
                // 68 站点 dynamic / g1 编 0 站点 → gen1≠gen2 编译产物分歧,实测定位。)
                const isImportBinding = !!(this.getImportBindingForLocal && this._currentModuleAst &&
                    this.getImportBindingForLocal(this._currentModuleAst, typeName));
                const shadowingLocal = !isImportBinding && this.ctx.getLocal(typeName) &&
                    !(this.ctx.localDeclaredClasses &&
                      Object.prototype.hasOwnProperty.call(this.ctx.localDeclaredClasses, typeName));
                if (shadowingLocal ||
                    (!isImportBinding && !declNode &&
                     (this.ctx.getLocal(typeName) || this.ctx.getMainCapturedVar(typeName)))) {
                    this.compileExpression(expr.callee);
                    this.vm.mov(VReg.V6, VReg.RET);
                    this.compileDynamicNew(VReg.V6, args);
                } else if (declNode && declNode.type === "FunctionDeclaration") {
                    // 展开实参现由 compilePlainFunctionNew 内部处理(A0..A4 + A5=this)。
                    this.compilePlainFunctionNew(typeName, args, declNode);
                } else if (declNode && declNode.type === "ClassDeclaration") {
                    this.compileUserClassNew(typeName, args);
                } else {
                    // 未解析标识符须先 GetValue:未声明 `new x` 抛 ReferenceError,
                    // 不能走 compileUserClassNew 当类构造(会变成 TypeError / 空对象)。
                    this.compileExpression(expr.callee);
                    this.vm.mov(VReg.V6, VReg.RET);
                    this.compileDynamicNew(VReg.V6, args);
                }
                break;
            }
        }
    },

    // [#69] 惰性声明函数 prototype 全局槽 _funcproto_<symbol>(qword,初值 0);
    // 与 _classinfo_ 同法在 _data_gc_end 前追加 → 落 GC 根扫描区,挂其上的对象不回收。
    ensureFuncProtoSlot(symbol) {
        const label = "_funcproto_" + symbol;
        if (!this._addedFuncProtoLabels) this._addedFuncProtoLabels = new Set();
        if (!this._addedFuncProtoLabels.has(label)) {
            this.asm.addDataLabel(label);
            this.asm.addDataQword(0);
            this._addedFuncProtoLabels.add(label);
        }
        return label;
    },

    // 惰性声明函数的 memoized 闭包全局槽 _funcclosure_<symbol>(qword,初值 0,GC 根)。
    // 函数声明作值此前每次引用都新 alloc 闭包 → 指针身份不稳(`f===f` 为 false),且闭包属性
    // 侧表(按裸指针键)对声明函数失效。改为首次建、存槽、后续复用同一闭包 → 稳定身份。
    ensureFuncClosureSlot(symbol) {
        const label = "_funcclosure_" + symbol;
        if (!this._addedFuncClosureLabels) this._addedFuncClosureLabels = new Set();
        if (!this._addedFuncClosureLabels.has(label)) {
            this.asm.addDataLabel(label);
            this.asm.addDataQword(0);
            this._addedFuncClosureLabels.add(label);
        }
        return label;
    },

    // [W-B B2] 用户函数 F.prototype 解析(惰性,与 `F.prototype` 属性读返回**同一**对象)。
    // 发射:确保 _funcclosure_<sym> memoized 闭包(与 compileIdentifier 函数声明作值同法,
    // 稳定身份 `F===F`),调 _closure_prop_get(fn,"prototype") → 运行时 _cpg_miss 惰性建
    // prototype 对象并回填 fn.prototype 闭包属性 → RET = 裸 prototype(未建/undefined → 0)。
    // 于是 `new F()`、`F.prototype.x` 读、`f instanceof F` 三路统一到同一 prototype 对象。
    // S0 保持(调用方持有实例);S1 作 scratch。
    emitUserFuncProtoRef(funcName, symbol) {
        const funcLabel = this.getFunctionLabel(funcName);
        const slotLabel = this.ensureFuncClosureSlot(symbol);
        const haveCloL = this.ctx.newLabel("fnproto_clo_have");
        // 1. 确保 memoized 闭包 → RET = 装箱 fn
        this.vm.lea(VReg.V0, slotLabel);
        this.vm.load(VReg.RET, VReg.V0, 0);
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(haveCloL);
        this.vm.movImm(VReg.A0, 16);
        this.vm.call("_alloc");
        this.vm.mov(VReg.S1, VReg.RET);
        this.vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        this.vm.store(VReg.S1, 0, VReg.V1);
        this.vm.lea(VReg.V1, funcLabel);
        this.vm.store(VReg.S1, 8, VReg.V1);
        this.vm.mov(VReg.A0, VReg.S1);
        this.vm.call("_js_box_function"); // RET = 装箱
        this.vm.lea(VReg.V1, slotLabel);
        this.vm.store(VReg.V1, 0, VReg.RET);
        this.vm.label(haveCloL);
        // 2. F.prototype = _closure_prop_get(fn, "prototype")
        this.vm.mov(VReg.A0, VReg.RET);
        this.emitBoxedStringKey("prototype", VReg.A1);
        this.vm.call("_closure_prop_get"); // RET = 装箱 proto / undefined
        // 3. 仅对象可作为 [[Prototype]];否则 0,由 new 路径回落到 Object.prototype.
        const protoObjL = this.ctx.newLabel("fnproto_isobj");
        const protoDoneL = this.ctx.newLabel("fnproto_done");
        this.vm.shrImm(VReg.V1, VReg.RET, 48);
        this.vm.cmpImm(VReg.V1, 0x7FFD);
        this.vm.jeq(protoObjL);
        this.vm.cmpImm(VReg.V1, 0x7FFE);
        this.vm.jeq(protoObjL);
        this.vm.cmpImm(VReg.V1, 0x7FFF);
        this.vm.jeq(protoObjL);
        this.vm.movImm(VReg.RET, 0);
        this.vm.jmp(protoDoneL);
        this.vm.label(protoObjL);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        this.vm.label(protoDoneL);
    },

    // [#69] 普通函数 new F(args):建对象→__proto__=F.prototype(惰性,经闭包属性侧表,
    // 与 `F.prototype` 读同一对象)→以对象为 this 跑函数体(形参 A0.. / this 在 A5)→
    // 显式返回对象则覆盖,否则返回该对象。不动 class 路径(compileUserClassNew,this 在 A0)。
    compilePlainFunctionNew(funcName, args, funcNode) {
        const funcLabel = this.getFunctionLabel(funcName);
        if (!funcLabel) { this.vm.movImm(VReg.RET, 0); return; }
        // function*/async function 无 [[Construct]]:`new g()` 须 TypeError
        // (statements/generators/invoke-as-constructor)。表达式形态走闭包
        // _fn_construct_call 的 _func_meta_nonctor;声明形态走本专路。
        if (funcNode && (funcNode.isGenerator === true || funcNode.generator === true ||
            funcNode.async === true || funcNode.isAsync === true)) {
            this.vm.lea(VReg.A0, this.asm.addString("value is not a constructor"));
            this.vm.call("_js_box_string");
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_throw_type_error");
            return;
        }
        const symbol = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(funcName)) || funcName;

        // 1. 新实例对象(先裸写 __proto__,再装箱 0x7FFD —— 与 Construct 返回值
        //    SameValue,`function C(){ t=this } (new C())===t`)。
        this.vm.call("_object_new");
        this.vm.mov(VReg.S0, VReg.RET);

        // 2. __proto__ = F.prototype(惰性,经闭包属性侧表 _closure_prop_get → 与
        //    `F.prototype` 属性读返回**同一**对象,`F.prototype.x=1; (new F()).x` 成立;
        //    且 `F.prototype.constructor` 由 _cpg_miss 落 → `(new F()).constructor===F`)。
        //    裸指针存储,__proto__ 链按裸指针解读(同 class props[1].val)。
        this.emitUserFuncProtoRef(funcName, symbol); // RET = 裸 F.prototype(S1 scratch)
        const haveProtoL = this.ctx.newLabel("fnnew_have_proto");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(haveProtoL);
        this.vm.call("_object_proto_ensure");
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        this.vm.label(haveProtoL);
        this.vm.store(VReg.S0, 16, VReg.RET);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        this.vm.or(VReg.S0, VReg.S0, VReg.V1);

        // 3. 备参:形参 A0..A4、this 在 A5(见 index.js [#36])。展开实参走专用
        //    helper(运行时按数组长度装 A0..A4);否则逐个求值压栈,再逆序弹回
        //    (避免互踩),缺省填 undefined,最后置 A5=this(已装箱)。
        if (argsHasSpread(args)) {
            this.compilePlainCtorArgsSpread(args); // 装 A0..A4 + A5=this,S0 保持
        } else {
            const argRegs = CTOR_ARG_REGS_A0;
            const argCount = Math.min(args.length, 16);
            this.vm.push(VReg.S0);
            for (let i = 0; i < argCount; i++) {
                this.compileExpression(args[i]);
                this.vm.push(VReg.RET);
            }
            // [argv 溢出] 第 6 个及以后的实参 → _call_argv(被调方 prologue 快照)
            for (let i = argCount - 1; i >= 0; i--) {
                if (i < argRegs.length) this.vm.pop(argRegs[i]);
                else {
                    this.vm.pop(VReg.V6);
                    this.vm.lea(VReg.V5, "_call_argv");
                    this.vm.store(VReg.V5, i * 8, VReg.V6);
                }
            }
            this.vm.pop(VReg.S0);
            for (let i = argCount; i < argRegs.length; i++) {
                this.vm.movImm64(argRegs[i], 0x7ffb000000000000n);
            }
            this.vm.mov(VReg.A5, VReg.S0);
            this.emitSetCallArgc(args.length > 16 ? 16 : args.length); // [argc ABI]
        }
        // NewTarget = boxed F (same memo slot as identifier `F`).
        // emitSetCallArgc just wrote undefined; overwrite after args are live.
        {
            const slotLabel = this.ensureFuncClosureSlot(symbol);
            this.vm.lea(VReg.V5, slotLabel);
            this.vm.load(VReg.V6, VReg.V5, 0);
            this.emitSetNewTargetFromReg(VReg.V6);
        }
        this.vm.call(funcLabel);

        // 4. 返回:显式返回对象/数组/TypedArray(tag 0x7ffd/0x7ffe 或裸 TA)覆盖,
        // 否则返回实例(S0 已装箱)。
        const retEnd = this.ctx.newLabel("fnnew_end");
        const useThis = this.ctx.newLabel("fnnew_use_this");
        this.vm.mov(VReg.V1, VReg.RET);
        this.vm.shrImm(VReg.V1, VReg.V1, 48);
        this.vm.cmpImm(VReg.V1, 0x7ffd);
        this.vm.jeq(retEnd);
        this.vm.cmpImm(VReg.V1, 0x7ffe);
        this.vm.jeq(retEnd);
        this.vm.cmpImm(VReg.V1, 0x7fff);
        this.vm.jeq(retEnd);
        // 裸 TypedArray(high16=0, type@0 ∈ [0x40,0x61]) / DataView(14) / AB(12)
        this.vm.cmpImm(VReg.V1, 0);
        this.vm.jne(useThis);
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jeq(useThis);
        this.vm.loadByte(VReg.V1, VReg.RET, 0); // 勿用 V0:x64 V0≡RET
        this.vm.cmpImm(VReg.V1, 4); // TYPE_MAP
        this.vm.jeq(retEnd);
        this.vm.cmpImm(VReg.V1, 5); // TYPE_SET
        this.vm.jeq(retEnd);
        this.vm.cmpImm(VReg.V1, 12); // TYPE_ARRAY_BUFFER
        this.vm.jeq(retEnd);
        this.vm.cmpImm(VReg.V1, 14); // TYPE_DATA_VIEW
        this.vm.jeq(retEnd);
        this.vm.cmpImm(VReg.V1, 0x40);
        this.vm.jlt(useThis);
        this.vm.cmpImm(VReg.V1, 0x61);
        this.vm.jle(retEnd);
        this.vm.label(useThis);
        this.vm.mov(VReg.RET, VReg.S0);
        this.vm.label(retEnd);
    },

    /**
     * 编译用户定义的类实例化 new ClassName(args)
     * 类信息对象结构:
     *   +0: type (TYPE_CLOSURE = 3)
     *   +8: constructor 地址
     *   +16: prototype 对象地址
     */
    // [A2] 类实例静态形状:解析 ClassDeclaration 计算实例键数(继承链展平),
    // 合格则发射/复用形状描述符(内容仅 key_count——IC 只做地址身份比较)。
    // 不合格(类未注册/表达式父类/链断裂/环)返回 null → 不赋形状(shape 恒 0)。
    _classShapeSite(className) {
        if (!this._shapeClsMemo) this._shapeClsMemo = new Map();
        const cls = this.ctx.getFunction && this.ctx.getFunction(className);
        const memo = this._shapeClsMemo.get(className);
        if (memo && memo.node === cls) return memo.site;
        const keyCount = this._classShapeKeyCount(cls, {}, new Set());
        let site = null;
        if (keyCount !== null) {
            // className 来自已解析的标识符/内部改名，本身可安全作为汇编 Map label。
            // 避免 native 自举运行时的 RegExp.replace 错把局部值污染成 `_shape_cls_`。
            const label = `_shape_cls_${String(className)}__${this.nextLabelId()}`;
            this.asm.addDataLabel(label);
            this.asm.addDataQword(keyCount);
            site = { label: label, keyCount: keyCount };
        }
        this._shapeClsMemo.set(className, { node: cls, site: site });
        return site;
    },

    // 实例键数 = 链上公有静态名(重名去重:子类遮蔽父类字段只占一键)
    //          + 私有字段/构造体私有赋值(带 initializer 或赋值语句才建键,mangle 前缀不撞)
    //          + 计算键字段(带 initializer;键名未知但计数确定)。
    // 覆盖两种建键形态:字段声明(emitCtorFieldInits 规则)与构造体顶层 this.x= 赋值
    // (super() 之后;条件块内赋值不扫,count 运行时校验会正确拒绝)。
    _classShapeKeyCount(cls, seen, pubNames) {
        if (!cls || cls.type !== "ClassDeclaration" || !Array.isArray(cls.body)) return null;
        const idName = cls.id && cls.id.name;
        if (idName) { if (seen[idName]) return null; seen[idName] = true; }
        let own = 0;
        const pubBefore = pubNames.size;
        for (const member of cls.body) {
            if (member.type !== "PropertyDefinition" || member.static) continue;
            if (!member.value) continue; // 无 initializer 不建键
            if (member.key && member.key.type === "PrivateIdentifier") { own++; continue; }
            const cfRuntimeKey = member.computed && member.key &&
                member.key.type !== "Literal" && member.key.type !== "StringLiteral" &&
                member.key.type !== "NumericLiteral";
            if (cfRuntimeKey) { own++; continue; } // 计算键:计数确定,键名运行时
            const nm = (member.key && (member.key.name || member.key.value));
            if (nm == null) continue; // 与 emitCtorFieldInits 的 continue 一致
            pubNames.add(String(nm));
        }
        let ctor = null;
        for (const member of cls.body) {
            if (member.type === "MethodDefinition" && member.kind === "constructor") { ctor = member; break; }
        }
        if (ctor && ctor.value && ctor.value.body && Array.isArray(ctor.value.body.body)) {
            let afterSuper = !cls.superClass;
            for (const st of ctor.value.body.body) {
                if (!st || st.type !== "ExpressionStatement" || !st.expression) continue;
                const e = st.expression;
                if (e.type === "CallExpression" && e.callee && e.callee.type === "SuperExpression") { afterSuper = true; continue; }
                if (!afterSuper) continue;
                if (e.type === "AssignmentExpression" && e.operator === "=" &&
                    e.left && e.left.type === "MemberExpression" && !e.left.computed &&
                    e.left.object && e.left.object.type === "ThisExpression") {
                    if (e.left.property.type === "Identifier") pubNames.add(e.left.property.name);
                    else if (e.left.property.type === "PrivateIdentifier") own++;
                }
            }
        }
        own += pubNames.size - pubBefore;
        if (cls.superClass) {
            if (cls.superClass.type !== "Identifier") return null; // 表达式父类:键数不可知
            const scls = this.ctx.getFunction && this.ctx.getFunction(cls.superClass.name);
            const superCount = this._classShapeKeyCount(scls, seen, pubNames);
            if (superCount === null) return null;
            own += superCount;
        }
        return own;
    },

    compileUserClassNew(className, args) {
        const offset = this.ctx.getLocal(className);
        const globalLabel = this.ctx.getMainCapturedVar(className);

        // [非构造器守卫·静态名] 名字在**任何**位置都解析不到时,下面最末的兜底会静默地
        // "构造"出一个空对象并返回 —— `new Float16Array(8)` / `new Zork()` 于是悄悄
        // 成功,后续对该空对象的操作再以离奇方式失败。改为抛可捕获的 TypeError:
        // 规范这里其实是 ReferenceError,但运行时只有 _throw_type_error 原语(本次改动
        // 不碰 runtime/),抛 TypeError 至少让错误可见、可 try/catch —— 记偏差。
        // 判别复用 typeof 的同一把尺子 isUnresolvableIdentifier(members.js):内建名
        // (Boolean/Number/String/Symbol/Date/…)与 TA 族一律**不**算未解析 —— 它们的
        // `new` 靠这条静默兜底得到一个空对象,test262 里 `var y = new Boolean(true);
        // (false || y) !== y` 之类恒等比较正因此通过,收紧会反向回归(实测 -5)。
        // 判别全在编译期完成,解析得到的名一条指令都不多发。
        if (this.isUnresolvableIdentifier &&
            this.isUnresolvableIdentifier({ type: "Identifier", name: className }) &&
            !this.getFunctionLabel(className)) {
            this.vm.lea(VReg.A0, this.asm.addString("value is not a constructor"));
            this.vm.call("_js_box_string");
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_throw_type_error"); // 不返回
            return;
        }

        // 1. 分配实例对象（新布局：属性区独立分配、可自动增长，头字段已初始化）
        this.vm.call("_object_new");
        this.vm.mov(VReg.S0, VReg.RET); // S0 = 新对象（裸指针）

        // 顶层类被箭头/函数表达式闭包引用时按**装箱变量**捕获:该局部槽存 box 指针、
        // 真值(装箱 classinfo)在 [box+0];而本作用域 `class L{}` 声明的类槽直存裸
        // classinfo(见 compileClassDeclaration 的 classOffset 存储)。二者都可能落
        // boxedVars(同名局部类也可能因内层捕获被标记),故 boxedVars 不足以判别——须
        // 排除**本地声明类**(localDeclaredClasses)后,才对捕获的装箱类槽多解一层 box。
        // 漏这层 → 把 box 指针当裸 classinfo 解 props_ptr@32 → 段错误(闭包体内 new
        // 顶层类崩的根因)。
        const capturedBoxedClass = !!(offset &&
            this.ctx.boxedVars && this.ctx.boxedVars.has(className));

        if (offset || globalLabel) {
            if (offset) {
                // 类在局部变量中，加载类信息对象（捕获的装箱类须多解一层 box）
                this.vm.load(VReg.S1, VReg.FP, offset); // S1 = 类信息对象 / box 指针
                if (capturedBoxedClass) {
                    this.vm.load(VReg.S1, VReg.S1, 0); // box → 装箱 classinfo 值
                    // 脱 tag:装箱 classinfo 为 `0x7fff|裸指针`,剥 tag 得裸 classinfo。
                    this.vm.emitMaskLoad(VReg.V1);
                    this.vm.andMaskReg(VReg.S1, VReg.S1, VReg.V1);
                }
            } else {
                // 类在主程序被捕获变量中，通过全局标签访问
                this.vm.lea(VReg.S1, globalLabel);
                this.vm.load(VReg.S1, VReg.S1, 0); // 加载 box 指针
                this.vm.load(VReg.S1, VReg.S1, 0); // 加载类信息对象
            }

            // [Proxy construct] 值为 Proxy(块 type@0==8)→ 构造走 construct 陷阱蹦床。
            // 须在解 props_ptr 前判别(proxy 块无 classinfo 布局)。局部槽里 proxy 是装箱
            // 0x7FFD,读类型前先掩码取裸副本(V0);裸 classinfo(高16=0)掩码是恒等,不受扰。
            // 实参统一经数组求值一次(compileArrayExpressionWithSpread,兼容 spread)。
            const newProxyEndL = this.ctx.newLabel("unew_pxend");
            {
                const notProxyL = this.ctx.newLabel("unew_notpx");
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1); // V0 = 去 tag 候选
                this.vm.cmpImm(VReg.V0, 0);
                this.vm.jeq(notProxyL);
                this.vm.load(VReg.V1, VReg.V0, 0);
                this.vm.cmpImm(VReg.V1, 8); // TYPE_PROXY
                this.vm.jne(notProxyL);
                const pSlot = this.ctx.allocLocal(`__unewpx_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, pSlot, VReg.V0);
                this.compileArrayExpressionWithSpread(args); // RET = 实参 boxed 数组
                this.vm.mov(VReg.A1, VReg.RET); // 先取 RET(与 A0 同物理寄存器 X0/RAX!)
                this.vm.load(VReg.A0, VReg.FP, pSlot);
                this.vm.call("_proxy_construct_call");
                this.vm.jmp(newProxyEndL);
                this.vm.label(notProxyL);
            }
            // 类信息对象新布局见 compileClassDeclaration:
            // props=[S1+32]; ctor=props[0].val=[props+8]; prototype对象=props[1].val=[props+24]
            this.vm.load(VReg.V1, VReg.S1, 32); // props_ptr
            // 获取 prototype 并设置到新对象的 __proto__
            this.vm.load(VReg.V0, VReg.V1, 24); // prototype 对象
            this.vm.store(VReg.S0, 16, VReg.V0); // 存储到对象的 __proto__ 槽位

            // 获取构造函数地址
            this.vm.load(VReg.S2, VReg.V1, 8); // S2 = constructor 地址

            // 构造函数调用约定: A0 = this, 参数依次在 A1-A5
            // 先保存 S0/S1/S2（参数表达式可能覆盖它们），
            // 再逐个编译参数压栈，最后逆序弹出到 A5..A1
            if (argsHasSpread(args)) {
                // new F(...args)：展开实参（此前 SpreadElement 落 default → 告警且丢参）
                this.compileCtorArgsSpread(args);
            } else {
                // 未提供的构造函数实参填 JS_UNDEFINED，使被调用方默认参数生效
                this.compileCtorArgsToRegs(args, [VReg.S0, VReg.S1, VReg.S2], true);
            }

            // 重新设置 A0 = this
            this.vm.mov(VReg.A0, VReg.S0);
            // x64/LSRA: user ctor prologue may not restore S0 (heavy body after
            // super()+fields). Stash the allocated instance on THIS frame.
            const unewInst = this.ctx.allocLocal(`__unew_inst_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, unewInst, VReg.S0);

            // NewTarget = same naked classinfo identifier `C` returns.
            this.vm.mov(VReg.V6, VReg.S1);
            this.emitSetNewTargetFromReg(VReg.V6);
            // 间接调用构造函数
            this.vm.callIndirect(VReg.S2);
            this.vm.load(VReg.S0, VReg.FP, unewInst);

            // [A2] 类实例形状:ctor 返回后校验实例 count==key_count 才赋形状描述符
            // (ctor 体加/删声明外键则不符,留 0 安全退化;IC 键自验证兜底)。
            const clsShape = this._classShapeSite(className);
            if (clsShape) {
                const unewNoShpL = this.ctx.newLabel("unew_noshape");
                // x64 V0≡RET: ctor return (boxed this) must survive this check.
                this.vm.load(VReg.V2, VReg.S0, 8);
                this.vm.cmpImm(VReg.V2, clsShape.keyCount);
                this.vm.jne(unewNoShpL);
                this.vm.lea(VReg.V2, clsShape.label);
                this.vm.store(VReg.S0, 48, VReg.V2);
                this.vm.label(unewNoShpL);
            }

            // 返回:构造器显式返回对象/数组/TypedArray/ArrayBuffer 则用之(super→_ta_construct
            // 产裸 TA/AB,high16=0+type∈[0x40,0x61] 或 TYPE_ARRAY_BUFFER=12);否则回落初始实例 S0 装箱 0x7ffd。
            {
                const keepL = this.ctx.newLabel("unew_keep_ret");
                const doneL = this.ctx.newLabel("unew_ret_done");
                this.vm.shrImm(VReg.V1, VReg.RET, 48);
                this.vm.cmpImm(VReg.V1, 0x7ffd);
                this.vm.jeq(keepL);
                this.vm.cmpImm(VReg.V1, 0x7ffe);
                this.vm.jeq(keepL);
                this.vm.cmpImm(VReg.V1, 0x7fff);
                this.vm.jeq(keepL);
                this.vm.cmpImm(VReg.V1, 0);
                this.vm.jne(doneL); // 非对象类返回值 → 用 S0
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jeq(doneL);
                this.vm.loadByte(VReg.V1, VReg.RET, 0); // 勿用 V0:x64 V0≡RET
                this.vm.cmpImm(VReg.V1, 4); // TYPE_MAP
                this.vm.jeq(keepL);
                this.vm.cmpImm(VReg.V1, 5); // TYPE_SET
                this.vm.jeq(keepL);
                this.vm.cmpImm(VReg.V1, 12); // TYPE_ARRAY_BUFFER(super→_ta_construct)
                this.vm.jeq(keepL);
                this.vm.cmpImm(VReg.V1, 14); // TYPE_DATA_VIEW
                this.vm.jeq(keepL);
                this.vm.cmpImm(VReg.V1, 0x40);
                this.vm.jlt(doneL);
                this.vm.cmpImm(VReg.V1, 0x61);
                this.vm.jgt(doneL);
                this.vm.jmp(keepL);
                this.vm.label(doneL);
                this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                this.vm.or(VReg.RET, VReg.S0, VReg.V1);
                this.vm.label(keepL);
            }
            this.vm.label(newProxyEndL); // [Proxy construct] 蹦床返回汇合点(RET 已是结果)
        } else {
            // 类不在局部变量/捕获 box 中（函数体内 new 顶层类）：
            // 从 _classinfo_<symbol> 全局槽取类信息对象，走完整构造路径
            const classSymbol2 = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(className)) || className;
            const isKnownClass = this.ctx.getFunction && this.ctx.getFunction(className) &&
                this.ctx.getFunction(className).type === "ClassDeclaration";
            if (isKnownClass) {
                this.vm.lea(VReg.S1, `_classinfo_${classSymbol2}`);
                this.vm.load(VReg.S1, VReg.S1, 0); // S1 = 类信息对象

                // 获取 prototype 并设置 __proto__（新布局：经 props_ptr 读取）
                this.vm.load(VReg.V1, VReg.S1, 32); // props_ptr
                this.vm.load(VReg.V0, VReg.V1, 24); // prototype 对象 = props[1].val
                this.vm.store(VReg.S0, 16, VReg.V0);
                this.vm.load(VReg.S2, VReg.V1, 8); // ctor = props[0].val

                if (argsHasSpread(args)) {
                    this.compileCtorArgsSpread(args);
                } else {
                    this.compileCtorArgsToRegs(args, [VReg.S0, VReg.S1, VReg.S2], false);
                }
                this.vm.mov(VReg.A0, VReg.S0);
                const unewInst2 = this.ctx.allocLocal(`__unew_inst2_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, unewInst2, VReg.S0);
                this.vm.mov(VReg.V6, VReg.S1);
                this.emitSetNewTargetFromReg(VReg.V6);
                this.vm.callIndirect(VReg.S2);
                this.vm.load(VReg.S0, VReg.FP, unewInst2);
                // [A2] 类实例形状(同主分支):count==key_count 校验后赋形状描述符
                const clsShape2 = this._classShapeSite(className);
                if (clsShape2) {
                    const unewNoShpL2 = this.ctx.newLabel("unew_noshape");
                    this.vm.load(VReg.V2, VReg.S0, 8);
                    this.vm.cmpImm(VReg.V2, clsShape2.keyCount);
                    this.vm.jne(unewNoShpL2);
                    this.vm.lea(VReg.V2, clsShape2.label);
                    this.vm.store(VReg.S0, 48, VReg.V2);
                    this.vm.label(unewNoShpL2);
                }
                // 同主分支:保留 ctor 返回的对象/数组/TypedArray
                {
                    const keepL = this.ctx.newLabel("unew2_keep_ret");
                    const doneL = this.ctx.newLabel("unew2_ret_done");
                    this.vm.shrImm(VReg.V1, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V1, 0x7ffd);
                    this.vm.jeq(keepL);
                    this.vm.cmpImm(VReg.V1, 0x7ffe);
                    this.vm.jeq(keepL);
                    this.vm.cmpImm(VReg.V1, 0x7fff);
                    this.vm.jeq(keepL);
                    this.vm.cmpImm(VReg.V1, 0);
                    this.vm.jne(doneL);
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jeq(doneL);
                    this.vm.loadByte(VReg.V1, VReg.RET, 0); // 勿用 V0:x64 V0≡RET
                    this.vm.cmpImm(VReg.V1, 4); // TYPE_MAP
                    this.vm.jeq(keepL);
                    this.vm.cmpImm(VReg.V1, 5); // TYPE_SET
                    this.vm.jeq(keepL);
                    this.vm.cmpImm(VReg.V1, 12); // TYPE_ARRAY_BUFFER
                    this.vm.jeq(keepL);
                    this.vm.cmpImm(VReg.V1, 14); // TYPE_DATA_VIEW
                    this.vm.jeq(keepL);
                    this.vm.cmpImm(VReg.V1, 0x40);
                    this.vm.jlt(doneL);
                    this.vm.cmpImm(VReg.V1, 0x61);
                    this.vm.jgt(doneL);
                    this.vm.jmp(keepL);
                    this.vm.label(doneL);
                    this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                    this.vm.or(VReg.RET, VReg.S0, VReg.V1);
                    this.vm.label(keepL);
                }
                return;
            }

            // 类不在局部变量中，尝试直接调用全局标签
            // 构造函数调用约定: A0 = this, 参数依次在 A1-A5
            if (argsHasSpread(args)) {
                this.compileCtorArgsSpread(args);
            } else {
                this.compileCtorArgsToRegs(args, [VReg.S0, VReg.S1], false);
            }

            // 重新设置 A0 = this
            this.vm.mov(VReg.A0, VReg.S0);

            // 调用全局类构造函数
            // 注意：这里需要在 collectFunctions 中注册类
            const funcLabel = this.getFunctionLabel(className);
            if (funcLabel) {
                const classSymbolFb = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(className)) || className;
                this.vm.lea(VReg.S1, `_classinfo_${classSymbolFb}`);
                this.vm.load(VReg.S1, VReg.S1, 0);
                this.vm.call(funcLabel);
            }

            // 返回新对象（标记为 JS 对象）
            this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
            this.vm.or(VReg.RET, VReg.S0, VReg.V1);
        }
    },

    // 非展开 new C(args):A0=this,实参装 A1..A5。saveRegs 跨实参求值压栈保活
    // (通常 S0=this / S1=classinfo / S2=ctor)。padUndefined 时未提供的 A 槽填
    // JS_UNDEFINED,使默认参数生效。d2bcc0d 抽出调用点但漏了本方法 → new/class
    // 全 COMPILE_FAIL(this.compileCtorArgsToRegs is not a function)。
    compileCtorArgsToRegs(args, saveRegs, padUndefined) {
        const ctorArgRegs = CTOR_ARG_REGS_A1;
        const n = (args && args.length) || 0;
        const ctorArgCount = n < ctorArgRegs.length ? n : ctorArgRegs.length;
        for (let i = 0; i < saveRegs.length; i++) this.vm.push(saveRegs[i]);
        for (let i = 0; i < ctorArgCount; i++) {
            this.compileExpression(args[i]);
            this.vm.push(VReg.RET);
        }
        for (let i = ctorArgCount - 1; i >= 0; i--) this.vm.pop(ctorArgRegs[i]);
        for (let i = saveRegs.length - 1; i >= 0; i--) this.vm.pop(saveRegs[i]);
        if (padUndefined) {
            for (let i = ctorArgCount; i < ctorArgRegs.length; i++) {
                this.vm.movImm64(ctorArgRegs[i], 0x7ffb000000000000n);
            }
        }
        this.emitSetCallArgc(ctorArgCount);
    },

    // new F(...args)：构造函数含展开实参。约定 A0=this、实参在 A1-A5,故先存 S0/S1/S2,
    // 用 compileArrayExpressionWithSpread 把全部实参(展开+普通)构建成 boxed 数组,再按运行时
    // 长度把前 5 个装入 A1..A5(越界填 JS_UNDEFINED),最后恢复 S0/S1/S2。受既有 5 参寄存器约束
    // (与非展开路径一致)。镜像 compileCallArgumentsWithSpread,但从 A1 起(A0 留给 this)。
    compileCtorArgsSpread(args) {
        const ctorArgRegs = CTOR_ARG_REGS_A1;
        this.vm.push(VReg.S0);
        this.vm.push(VReg.S1);
        this.vm.push(VReg.S2);

        // RET = 全部实参组成的 boxed 数组
        this.compileArrayExpressionWithSpread(args);
        const argsArrOff = this.ctx.allocLocal(`__ctorsp_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, argsArrOff, VReg.RET);
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_array_length"); // RET = 整数长度
        const lenOff = this.ctx.allocLocal(`__ctorsp_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOff, VReg.RET);

        // 逆序算出 arg[4..0] 压栈；每个 = (i < len) ? arr[i] : undefined
        for (let i = 4; i >= 0; i--) {
            const id = this.nextLabelId();
            const undefL = `_ctorsp_undef_${id}`;
            const doneL = `_ctorsp_done_${id}`;
            this.vm.load(VReg.V0, VReg.FP, lenOff);
            this.vm.cmpImm(VReg.V0, i);
            this.vm.jle(undefL); // len <= i → 无此实参
            this.vm.load(VReg.A0, VReg.FP, argsArrOff);
            this.vm.movImm(VReg.A1, i);
            this.vm.call("_array_get"); // RET = arr[i]
            this.vm.jmp(doneL);
            this.vm.label(undefL);
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
            this.vm.label(doneL);
            this.vm.push(VReg.RET);
        }
        // [argv 溢出] 实参 5..15 从实参数组填 _call_argv(须在装 A1..A5 之前:helper 用 A0)
        this.vm.load(VReg.A0, VReg.FP, argsArrOff);
        this.vm.call("_call_argv_fill");
        // 依次弹出到 A1..A5（栈顶是 arg0）
        for (let i = 0; i < 5; i++) {
            this.vm.pop(ctorArgRegs[i]);
        }
        this.vm.pop(VReg.S2);
        this.vm.pop(VReg.S1);
        this.vm.pop(VReg.S0);
        // [argc ABI] 构造 spread:实参个数为运行时数组长度
        this.vm.load(VReg.V6, VReg.FP, lenOff);
        this.emitSetCallArgc(0, VReg.V6);
    },

    // Unpack a boxed arguments array (already evaluated) into A1..A5 + _call_argv.
    // EvaluateNew: ArgumentListEvaluation runs before IsConstructor; compileDynamicNew
    // therefore cannot compileCtorArgsToRegs (would re-eval) on the classinfo path.
    emitCtorArgRegsFromArray(argsArrOff) {
        const ctorArgRegs = CTOR_ARG_REGS_A1;
        this.vm.push(VReg.S0);
        this.vm.push(VReg.S1);
        this.vm.push(VReg.S2);
        this.vm.load(VReg.A0, VReg.FP, argsArrOff);
        this.vm.call("_array_length");
        const lenOff = this.ctx.allocLocal(`__dnewal_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOff, VReg.RET);
        for (let i = 4; i >= 0; i--) {
            const id = this.nextLabelId();
            const undefL = `_dnewal_undef_${id}`;
            const doneL = `_dnewal_done_${id}`;
            this.vm.load(VReg.V1, VReg.FP, lenOff); // V1 not V0: x64 V0===RET
            this.vm.cmpImm(VReg.V1, i);
            this.vm.jle(undefL);
            this.vm.load(VReg.A0, VReg.FP, argsArrOff);
            this.vm.movImm(VReg.A1, i);
            this.vm.call("_array_get");
            this.vm.jmp(doneL);
            this.vm.label(undefL);
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            this.vm.label(doneL);
            this.vm.push(VReg.RET);
        }
        this.vm.load(VReg.A0, VReg.FP, argsArrOff);
        this.vm.call("_call_argv_fill");
        for (let i = 0; i < 5; i++) this.vm.pop(ctorArgRegs[i]);
        this.vm.pop(VReg.S2);
        this.vm.pop(VReg.S1);
        this.vm.pop(VReg.S0);
        this.vm.load(VReg.V6, VReg.FP, lenOff);
        this.emitSetCallArgc(0, VReg.V6);
    },

    // 普通函数 new F(...args) 的展开实参:ES5 约定形参在 A0..A4、this 在 A5(见
    // compilePlainFunctionNew)。与类版(A1..A5,this=A0)不同,故单独一版。进入时
    // S0=this(新实例,裸指针);返回后 A0..A4 已装好实参、A5=this、S0 保持不变。
    compilePlainCtorArgsSpread(args) {
        const argRegs = CTOR_ARG_REGS_A0;
        this.vm.push(VReg.S0); // 保 this 跨实参求值/辅助调用
        // RET = 全部实参组成的 boxed 数组
        this.compileArrayExpressionWithSpread(args);
        const argsArrOff = this.ctx.allocLocal(`__pctorsp_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, argsArrOff, VReg.RET);
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_array_length"); // RET = 整数长度
        const lenOff = this.ctx.allocLocal(`__pctorsp_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOff, VReg.RET);
        // 逆序算出 arg[4..0] 压栈;每个 = (i < len) ? arr[i] : undefined
        for (let i = 4; i >= 0; i--) {
            const id = this.nextLabelId();
            const undefL = `_pctorsp_undef_${id}`;
            const doneL = `_pctorsp_done_${id}`;
            this.vm.load(VReg.V0, VReg.FP, lenOff);
            this.vm.cmpImm(VReg.V0, i);
            this.vm.jle(undefL);
            this.vm.load(VReg.A0, VReg.FP, argsArrOff);
            this.vm.movImm(VReg.A1, i);
            this.vm.call("_array_get"); // RET = arr[i]
            this.vm.jmp(doneL);
            this.vm.label(undefL);
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
            this.vm.label(doneL);
            this.vm.push(VReg.RET);
        }
        this.vm.load(VReg.A0, VReg.FP, argsArrOff);
        this.vm.call("_call_argv_fill");
        // 依次弹出到 A0..A4(栈顶是 arg0)
        for (let i = 0; i < 5; i++) {
            this.vm.pop(argRegs[i]);
        }
        this.vm.pop(VReg.S0); // 恢复 this
        this.vm.mov(VReg.A5, VReg.S0); // this 在 A5
        // [argc ABI] 普通函数构造 spread:实参个数为运行时数组长度
        this.vm.load(VReg.V6, VReg.FP, lenOff);
        this.emitSetCallArgc(0, VReg.V6);
    },

    /**
     * 编译 Number 子类型，如 new Number.Int32(value)
     * @param {string} subtypeName - 子类型名称 (Int8, Int16, Int32, Int64, Uint8, ...)
     * @param {Array} args - 构造函数参数
     */
    compileNumberSubtype(subtypeName, args) {
        // 无参数时默认值为 0
        if (args.length === 0) {
            this.vm.movImm(VReg.RET, 0);
            return;
        }

        // 根据子类型选择编译方式
        switch (subtypeName) {
            // 整数类型：直接使用整数编译
            case "Int8":
            case "Int16":
            case "Int32":
            case "Int64":
            case "Uint8":
            case "Uint16":
            case "Uint32":
            case "Uint64":
                this.compileExpressionAsInt(args[0]);
                break;

            // 浮点类型：使用浮点编译
            case "Float16":
            case "Float32":
            case "Float64":
                this.compileExpression(args[0]);
                break;

            default:
                throw new Error(`Unknown Number subtype: ${subtypeName}`);
        }
    },

    /**
     * 编译 TypedArray 构造函数调用
     * @param {string} typeName - TypedArray 类型名称 (Int8Array, Float64Array 等)
     * @param {Array} args - 构造函数参数
     */
    compileTypedArrayNew(typeName, args) {
        // TypedArray 类型映射 (直接使用 TYPE_*_ARRAY 常量)
        const TYPED_ARRAY_TYPES = {
            Int8Array: 0x40, // TYPE_INT8_ARRAY
            Int16Array: 0x41, // TYPE_INT16_ARRAY
            Int32Array: 0x42, // TYPE_INT32_ARRAY
            BigInt64Array: 0x43, // TYPE_INT64_ARRAY
            Uint8Array: 0x50, // TYPE_UINT8_ARRAY
            Uint16Array: 0x51, // TYPE_UINT16_ARRAY
            Uint32Array: 0x52, // TYPE_UINT32_ARRAY
            BigUint64Array: 0x53, // TYPE_UINT64_ARRAY
            Uint8ClampedArray: 0x54, // TYPE_UINT8_CLAMPED_ARRAY
            Float32Array: 0x60, // TYPE_FLOAT32_ARRAY
            Float64Array: 0x61, // TYPE_FLOAT64_ARRAY
        };

        // 元素大小映射
        const ELEM_SIZES = {
            Int8Array: 1,
            Uint8Array: 1,
            Uint8ClampedArray: 1,
            Int16Array: 2,
            Uint16Array: 2,
            Int32Array: 4,
            Uint32Array: 4,
            Float32Array: 4,
            BigInt64Array: 8,
            BigUint64Array: 8,
            Float64Array: 8,
        };

        const arrayType = TYPED_ARRAY_TYPES[typeName];
        const elemSize = ELEM_SIZES[typeName] || 8;
        if (!arrayType) {
            throw new Error(`Unknown TypedArray type: ${typeName}`);
        }

        // 检查参数类型
        if (args.length > 0 && args[0].type === "ArrayExpression") {
            // 参数是数组字面量: new Float64Array([1, 2, 3])
            const elements = args[0].elements;
            const length = elements.length;

            // 辅助函数：获取元素的数值（处理 Literal 和 UnaryExpression）
            const getElementValue = (elem) => {
                if (!elem) return 0; // hole
                if (elem.type === "Literal") {
                    return elem.value;
                } else if (elem.type === "UnaryExpression" && elem.operator === "-") {
                    // 负数: -N
                    if (elem.argument.type === "Literal") {
                        return -elem.argument.value;
                    }
                } else if (elem.type === "UnaryExpression" && elem.operator === "+") {
                    // 正数: +N
                    if (elem.argument.type === "Literal") {
                        return +elem.argument.value;
                    }
                } else if (elem.type === "Identifier") {
                    // 特殊标识符 NaN / Infinity / undefined
                    if (elem.name === "NaN") return NaN;
                    if (elem.name === "Infinity") return Infinity;
                    if (elem.name === "undefined") return undefined;
                }
                return 0; // 仅 const 路径使用
            };
            const isConstTaElem = (elem) => {
                if (!elem) return true;
                if (elem.type === "Literal" && typeof elem.value === "number") return true;
                if (elem.type === "UnaryExpression" && (elem.operator === "-" || elem.operator === "+") &&
                    elem.argument && elem.argument.type === "Literal" &&
                    typeof elem.argument.value === "number") return true;
                if (elem.type === "Identifier" &&
                    (elem.name === "NaN" || elem.name === "Infinity" || elem.name === "undefined")) return true;
                return false;
            };
            // 含变量/调用的字面量不能按 0 填:new FA([aNaN]) 会把 NaN 编成 0,
            // controls[i] !== controls[i] 恒假(fill-values-conversion consistent-nan)。
            let allConst = true;
            for (let ci = 0; ci < elements.length; ci++) {
                if (!isConstTaElem(elements[ci])) { allConst = false; break; }
            }
            if (!allConst) {
                this.compileExpression(args[0]);
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.movImm(VReg.A0, arrayType);
                this.vm.call("_typed_array_from");
                return;
            }

            // 先创建 TypedArray
            this.vm.movImm(VReg.A0, arrayType);
            this.vm.movImm(VReg.A1, length);
            this.vm.call("_typed_array_new");
            this.vm.push(VReg.RET); // 保存 TypedArray 指针到栈

            // 填充元素 - 根据元素大小存储
            for (let i = 0; i < length; i++) {
                const offset = 32 + i * elemSize; // [Design A] 32B 头,内联数据从 +32 起
                const value = getElementValue(elements[i]);

                if (elemSize === 8) {
                    // 8 字节：使用 raw float64 位模式
                    this.compileRawNumericLiteral(value);
                    this.vm.load(VReg.V1, VReg.SP, 0);
                    this.vm.store(VReg.V1, offset, VReg.RET);
                } else if (typeName === "Float32Array") {
                    // Float32Array: 转换为 32 位浮点位模式(纯算术,gen1-safe)。
                    // 原 `new Uint32Array(f32.buffer)` 是 §1.1 多视图别名违规(P2-4):
                    // gen1 无 .buffer 支持 → 落通用 _object_get 把 TypedArray 当对象、
                    // props_ptr@+32 越块读邻居 —— bump 时代读 0 静默错值,GC 复用后读到
                    // 邻居数据 → 确定性崩(2026-07-10 布局运气毁堆的真正根因,任务 #19)。
                    const bits = floatToF32Bits(value);
                    this.vm.load(VReg.V1, VReg.SP, 0);
                    this.vm.movImm(VReg.V0, bits);
                    this.vm.storeByte(VReg.V1, offset, VReg.V0);
                    this.vm.shr(VReg.V2, VReg.V0, 8);
                    this.vm.storeByte(VReg.V1, offset + 1, VReg.V2);
                    this.vm.shr(VReg.V2, VReg.V0, 16);
                    this.vm.storeByte(VReg.V1, offset + 2, VReg.V2);
                    this.vm.shr(VReg.V2, VReg.V0, 24);
                    this.vm.storeByte(VReg.V1, offset + 3, VReg.V2);
                } else if (elemSize === 4) {
                    // Int32Array/Uint32Array: 使用 32 位整数
                    // 使用 >>> 0 确保无符号，然后取各字节
                    const intVal = Math.trunc(value) >>> 0;
                    this.vm.load(VReg.V1, VReg.SP, 0);
                    this.vm.movImm(VReg.V0, intVal);
                    this.vm.storeByte(VReg.V1, offset, VReg.V0);
                    this.vm.shr(VReg.V2, VReg.V0, 8);
                    this.vm.storeByte(VReg.V1, offset + 1, VReg.V2);
                    this.vm.shr(VReg.V2, VReg.V0, 16);
                    this.vm.storeByte(VReg.V1, offset + 2, VReg.V2);
                    this.vm.shr(VReg.V2, VReg.V0, 24);
                    this.vm.storeByte(VReg.V1, offset + 3, VReg.V2);
                } else if (elemSize === 2) {
                    // 2 字节
                    this.vm.load(VReg.V1, VReg.SP, 0);
                    this.vm.movImm(VReg.V0, Math.trunc(value) & 0xffff);
                    this.vm.storeByte(VReg.V1, offset, VReg.V0);
                    this.vm.shr(VReg.V2, VReg.V0, 8);
                    this.vm.storeByte(VReg.V1, offset + 1, VReg.V2);
                } else {
                    // 1 字节。Uint8ClampedArray:钳制到 [0,255](node 语义:饱和,非环绕);
                    // 其余 1 字节类型(Int8/Uint8)按 &0xff 环绕。截断向零,与运行时
                    // _typed_array_set 一致(编译期字面量填充,值已知)。
                    let byteVal;
                    if (typeName === "Uint8ClampedArray") {
                        const t = Math.trunc(value);
                        byteVal = t < 0 ? 0 : (t > 255 ? 255 : t);
                    } else {
                        byteVal = Math.trunc(value) & 0xff;
                    }
                    this.vm.load(VReg.V1, VReg.SP, 0);
                    this.vm.movImm(VReg.V0, byteVal);
                    this.vm.storeByte(VReg.V1, offset, VReg.V0);
                }
            }

            this.vm.pop(VReg.RET); // 弹出 TypedArray 指针作为返回值
        } else if (args.length > 0 && args[0].type === "Literal" && typeof args[0].value === "number") {
            // 参数是数字字面量长度: new Float64Array(10)
            this.compileExpressionAsInt(args[0]);
            this.vm.mov(VReg.A1, VReg.RET); // length
            this.vm.movImm(VReg.A0, arrayType);
            this.vm.call("_typed_array_new");
        } else if (args.length > 0 && inferType(args[0], this.ctx) === Type.ARRAY_BUFFER) {
            // [Design A] new TypedArray(buffer[, byteOffset[, length]]) — 视图,共享 buffer 字节。
            // length 缺省 = (buffer.byteLength - byteOffset) / elemSize(elemSize 恒 2 的幂 → 移位)。
            const log2elem = { 1: 0, 2: 1, 4: 2, 8: 3 }[elemSize];
            const bufOff = this.ctx.allocLocal(`__tav_buf_${this.nextLabelId()}`);
            const boOff = this.ctx.allocLocal(`__tav_bo_${this.nextLabelId()}`);
            this.compileExpression(args[0]);          // buffer
            this.vm.store(VReg.FP, bufOff, VReg.RET);
            if (args.length >= 2) { this.compileExpressionAsInt(args[1]); }
            else { this.vm.movImm(VReg.RET, 0); }
            this.vm.store(VReg.FP, boOff, VReg.RET);   // byteOffset
            const autoLen = args.length < 3;
            if (!autoLen) {
                this.compileExpressionAsInt(args[2]);
                this.vm.mov(VReg.A3, VReg.RET);        // length
            } else {
                this.vm.load(VReg.A0, VReg.FP, bufOff);
                this.vm.call("_arraybuffer_bytelength"); // RET = byteLength
                this.vm.load(VReg.V1, VReg.FP, boOff);
                this.vm.sub(VReg.RET, VReg.RET, VReg.V1); // byteLength - byteOffset
                this.vm.shrImm(VReg.A3, VReg.RET, log2elem); // / elemSize
            }
            this.vm.load(VReg.A1, VReg.FP, bufOff);    // buffer
            this.vm.load(VReg.A2, VReg.FP, boOff);     // byteOffset
            this.vm.movImm(VReg.A0, arrayType);        // type
            this.vm.call("_typed_array_view");
            // 缺省长度 = length-tracking 视图:登记到跟踪表,buffer.resize 后长度跟随。
            if (autoLen) {
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.load(VReg.A1, VReg.FP, bufOff);
                this.vm.load(VReg.A2, VReg.FP, boOff);
                this.vm.movImm(VReg.A3, elemSize);
                this.vm.call("_ta_track_add");         // RET 原样返回视图
            }
        } else if (args.length >= 2) {
            // arg0 静态非 AB 但 argc≥2 → 仍可能是 new TA(buf,off,len);运行时判别,
            // 勿把 buf 单独送 _typed_array_from(会丢 off/len 并误登记 length-tracking)。
            const log2elem = { 1: 0, 2: 1, 4: 2, 8: 3 }[elemSize];
            const id = this.nextLabelId();
            const fromL = `_tavdyn_${id}_from`;
            const doneL = `_tavdyn_${id}_done`;
            const bufOff = this.ctx.allocLocal(`__tav_buf_${id}`);
            const boOff = this.ctx.allocLocal(`__tav_bo_${id}`);
            const autoLen = args.length < 3;
            this.compileExpression(args[0]);
            this.vm.store(VReg.FP, bufOff, VReg.RET);
            this.vm.load(VReg.V0, VReg.FP, bufOff);
            this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
            this.vm.and(VReg.V0, VReg.V0, VReg.V1);
            this.vm.cmpImm(VReg.V0, 4095);
            this.vm.jle(fromL);
            this.vm.loadByte(VReg.V1, VReg.V0, 0);
            this.vm.cmpImm(VReg.V1, 12); // TYPE_ARRAY_BUFFER
            this.vm.jne(fromL);
            if (args.length >= 2) { this.compileExpressionAsInt(args[1]); }
            else { this.vm.movImm(VReg.RET, 0); }
            this.vm.store(VReg.FP, boOff, VReg.RET);
            if (!autoLen) {
                this.compileExpressionAsInt(args[2]);
                this.vm.mov(VReg.A3, VReg.RET);
            } else {
                this.vm.load(VReg.A0, VReg.FP, bufOff);
                this.vm.call("_arraybuffer_bytelength");
                this.vm.load(VReg.V1, VReg.FP, boOff);
                this.vm.sub(VReg.RET, VReg.RET, VReg.V1);
                this.vm.shrImm(VReg.A3, VReg.RET, log2elem);
            }
            this.vm.load(VReg.A1, VReg.FP, bufOff);
            this.vm.load(VReg.A2, VReg.FP, boOff);
            this.vm.movImm(VReg.A0, arrayType);
            this.vm.call("_typed_array_view");
            if (autoLen) {
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.load(VReg.A1, VReg.FP, bufOff);
                this.vm.load(VReg.A2, VReg.FP, boOff);
                this.vm.movImm(VReg.A3, elemSize);
                this.vm.call("_ta_track_add");
            }
            this.vm.jmp(doneL);
            this.vm.label(fromL);
            this.vm.load(VReg.RET, VReg.FP, bufOff);
            if (inferType(args[0], this.ctx) === Type.TYPED_ARRAY) {
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_ta_to_array");
            }
            this.vm.mov(VReg.A1, VReg.RET);
            this.vm.movImm(VReg.A0, arrayType);
            this.vm.call("_typed_array_from");
            this.vm.label(doneL);
        } else if (args.length > 0) {
            // 变量/表达式参数:运行时判数组(拷贝元素)还是数字(当长度)。原一律当长度 →
            // `new Uint8Array(变量数组)` 把数组误当长度 → 空数组(bug,引擎库 P4 blocker)。
            this.compileExpression(args[0]);
            // 源是 TypedArray(裸指针,非 0x7FFE):_typed_array_from 只认 0x7FFE 数组,否则当
            // 长度 → 把 typed 指针当巨长度 OOM。静态可知时先 _ta_to_array 转普通数组(0x7FFE)。
            if (inferType(args[0], this.ctx) === Type.TYPED_ARRAY) {
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_ta_to_array");
            }
            this.vm.mov(VReg.A1, VReg.RET);       // srcArg(boxed)
            this.vm.movImm(VReg.A0, arrayType);
            this.vm.call("_typed_array_from");
        } else {
            // 无参数: new Float64Array()
            this.vm.movImm(VReg.A0, arrayType);
            this.vm.movImm(VReg.A1, 0);
            this.vm.call("_typed_array_new");
        }
    },

    // TypedArray 专属方法分派(typed-array-specific,my lane)。typed 布局是 raw 数据@16,
    // 与普通数组 data_ptr@24 不同 → join/indexOf/slice/fill 等落 _array_* 会读 data_ptr 越块崩。
    // 故转换/原地方法改走 _ta_* 运行时。返回 true=已处理;false=委托 compileArrayMethod
    // (map/filter/forEach/reduce/some/every/find 等基于 _subscript_get 的方法已 typed-aware)。
    // 参数约定镜像 compileArrayMethod 各 case。
    // TypedArray 回调型方法:活读 TA(禁 toArr 快照),resize/OOB→undefined。
    // rtLabel 映射到 _ta_forEach/_ta_every/_ta_some;find* 走 _tam_find_core。
    emitTaCbDelegate(obj, args, rtLabel) {
        const vm = this.vm;
        const id = this.nextLabelId();
        const taSlot = this.ctx.allocLocal(`__tacb_ta_${id}`);
        const cbSlot = this.ctx.allocLocal(`__tacb_fn_${id}`);
        const thisSlot = this.ctx.allocLocal(`__tacb_this_${id}`);
        this.compileExpression(obj);
        vm.store(VReg.FP, taSlot, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_tam_throw_if_detached");
        if (args.length >= 1 && args[0]) {
            this.compileExpression(args[0]);
        } else {
            vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined → needFn 抛
        }
        vm.store(VReg.FP, cbSlot, VReg.RET);
        if (args.length >= 2 && args[1]) {
            this.compileExpression(args[1]);
        } else {
            vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined
        }
        vm.store(VReg.FP, thisSlot, VReg.RET);
        vm.load(VReg.A0, VReg.FP, cbSlot);
        vm.call("_ta_need_fn");
        vm.load(VReg.A0, VReg.FP, taSlot);
        vm.load(VReg.A1, VReg.FP, cbSlot);
        vm.load(VReg.A2, VReg.FP, thisSlot);
        const live = {
            "_array_forEach_rt_t": "_ta_forEach",
            "_array_every_rt_t": "_ta_every",
            "_array_some_rt_t": "_ta_some",
        }[rtLabel];
        if (live) {
            vm.call(live);
            return;
        }
        // find/findIndex 等:回落仍走原 rt(调用方应改走 find_core)
        vm.load(VReg.A2, VReg.FP, taSlot);
        vm.load(VReg.A3, VReg.FP, thisSlot);
        vm.call("_ta_to_array");
        vm.load(VReg.A1, VReg.FP, cbSlot);
        vm.load(VReg.A2, VReg.FP, taSlot);
        vm.load(VReg.A3, VReg.FP, thisSlot);
        vm.mov(VReg.A0, VReg.RET);
        vm.call(rtLabel);
    },

    compileTypedArrayMethod(obj, name, args) {
        const vm = this.vm;
        if (name === "join") {
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            if (args.length > 0) { this.compileExpression(args[0]); vm.mov(VReg.A1, VReg.RET); }
            else {
                vm.lea(VReg.A1, "_str_comma_only");
                vm.movImm64(VReg.V0, 0x7ffc000000000000n);
                vm.or(VReg.A1, VReg.A1, VReg.V0);
            }
            vm.pop(VReg.A0);
            vm.call("_ta_join");
            return true;
        }
        if (name === "indexOf" || name === "includes") {
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached"); // ValidateTypedArray 在 ToInteger(fromIndex) 之前
            if (args.length >= 1) {
                this.compileExpression(args[0]);
            } else {
                vm.movImm64(VReg.RET, 0x7ffb000000000000n); // 缺省 searchElement = undefined
            }
            vm.mov(VReg.A1, VReg.RET);
            // fromIndex:装箱传入;indexOf 在 _ta_indexof 内捕 origLen 后再 ToInteger。
            // includes 仍走旧约定(裸 int,缺省 0)。
            if (name === "indexOf") {
                if (args.length >= 2) {
                    vm.push(VReg.A1);
                    this.compileExpression(args[1]);
                    vm.mov(VReg.A2, VReg.RET);
                    vm.pop(VReg.A1);
                } else {
                    vm.movImm64(VReg.A2, 0x7ffb000000000000n);
                }
                vm.pop(VReg.A0);
                vm.call("_ta_indexof");
                this.boxIntAsNumber(VReg.RET);
            } else {
                if (args.length >= 2) {
                    vm.push(VReg.A1);
                    this.compileExpression(args[1]);
                    vm.mov(VReg.A2, VReg.RET);
                    vm.pop(VReg.A1);
                } else {
                    vm.movImm64(VReg.A2, 0x7ffb000000000000n);
                }
                vm.pop(VReg.A0);
                vm.call("_ta_includes");
                const tL = `_ta_inc_t_${this.nextLabelId()}`, dL = `_ta_inc_d_${this.nextLabelId()}`;
                vm.cmpImm(VReg.RET, 0); vm.jne(tL);
                vm.movImm64(VReg.RET, 0x7ff9000000000000n); vm.jmp(dL);
                vm.label(tL); vm.movImm64(VReg.RET, 0x7ff9000000000001n);
                vm.label(dL);
            }
            return true;
        }
        if (name === "at") {
            if (args.length === 0) return true;
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_validate");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_typed_array_length");    // origLen(coerce 前)
            vm.push(VReg.RET);
            this.compileExpressionAsInt(args[0]);
            vm.mov(VReg.A2, VReg.RET);
            vm.pop(VReg.A1);
            vm.pop(VReg.A0);
            vm.call("_ta_at");
            return true;
        }
        if (name === "slice" || name === "subarray") {
            // slice 拷贝;subarray 是**共享 buffer 的视图**(_ta_subarray 经 _ta_buffer +
            // _typed_array_view 建真视图,byteOffset = src.byteOffset + begin*elemSize)。
            // slice:ValidateTypedArray 在 ToInteger(start/end) 之前;装箱 start/end 交给
            // _ta_slice(内部先捕 srcLength 再 ToInteger,以正确处理 mid-coerce resize)。
            // subarray:装箱 start/end 交给 _ta_subarray(内部先捕 srcLength 再 ToInteger,
            // 以正确处理 mid-coerce resize;OOB 视图 len=0 允许空 subarray)。
            this.compileExpression(obj);
            vm.push(VReg.RET);
            if (name === "slice") {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_tam_throw_if_detached");
                if (args.length >= 1) { this.compileExpression(args[0]); }
                else vm.movImm64(VReg.RET, 0x7ffb000000000000n);
                vm.push(VReg.RET);
                if (args.length >= 2) { this.compileExpression(args[1]); }
                else vm.movImm64(VReg.RET, 0x7ffb000000000000n);
                vm.mov(VReg.A2, VReg.RET);
                vm.pop(VReg.A1);
                vm.pop(VReg.A0);
                vm.call("_ta_slice");
                return true;
            }
            if (args.length >= 1) { this.compileExpression(args[0]); }
            else vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            vm.push(VReg.RET);
            if (args.length >= 2) { this.compileExpression(args[1]); }
            else vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            vm.mov(VReg.A2, VReg.RET);
            vm.pop(VReg.A1);
            vm.pop(VReg.A0);
            vm.call("_ta_subarray");
            return true;
        }
        if (name === "fill") {
            if (args.length === 0) return true;
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            vm.call("_tam_throw_if_immutable_write");
            this.compileExpression(args[0]);
            vm.mov(VReg.A1, VReg.RET); // value(装箱)
            if (args.length >= 2) {
                vm.push(VReg.A1);
                this.compileExpression(args[1]);
                vm.mov(VReg.A0, VReg.RET);
                vm.movImm(VReg.A1, 0);
                vm.call("_aref_argint_d");
                vm.mov(VReg.A2, VReg.RET);
                vm.pop(VReg.A1);
            } else vm.movImm(VReg.A2, 0);
            if (args.length >= 3) {
                vm.push(VReg.A1); vm.push(VReg.A2);
                this.compileExpression(args[2]);
                vm.mov(VReg.A0, VReg.RET);
                vm.movImm(VReg.A1, 2147483647);
                vm.call("_aref_argint_d");
                vm.mov(VReg.A3, VReg.RET);
                vm.pop(VReg.A2); vm.pop(VReg.A1);
            } else vm.movImm(VReg.A3, 2147483647);
            vm.pop(VReg.A0);
            vm.call("_ta_fill");
            return true;
        }
        if (name === "copyWithin") {
            // ta.copyWithin(target, start?, end?):原地 memmove。委托 _ta_copywithin
            // (typed 布局感知)。落 compileArrayMethod 会按 data_ptr@24 读 typed 布局崩。
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            vm.call("_tam_throw_if_immutable_write");
            if (args.length >= 1) { this.compileExpression(args[0]); }
            else vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            vm.push(VReg.RET);
            if (args.length >= 2) { this.compileExpression(args[1]); }
            else vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            vm.push(VReg.RET);
            if (args.length >= 3) { this.compileExpression(args[2]); }
            else vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            vm.mov(VReg.A3, VReg.RET);
            vm.pop(VReg.A2);
            vm.pop(VReg.A1);
            vm.pop(VReg.A0);
            vm.call("_ta_copywithin");
            return true;
        }
        if (name === "set") {
            if (args.length === 0) return true;
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            vm.call("_tam_throw_if_immutable_write");
            this.compileExpression(args[0]);
            vm.mov(VReg.A1, VReg.RET); // src(装箱数组)
            // offset 保持装箱: _ta_set 内做 ToIntegerOrInfinity
            // (compileExpressionAsInt 会把 -Infinity 收成 0,丢 RangeError)
            if (args.length >= 2) { vm.push(VReg.A1); this.compileExpression(args[1]); vm.mov(VReg.A2, VReg.RET); vm.pop(VReg.A1); }
            else vm.movImm64(VReg.A2, 0x7FFB000000000000n); // undefined → 0
            vm.pop(VReg.A0);
            vm.call("_ta_set");
            return true;
        }
        if (name === "reverse" || name === "sort") {
            // reverse:原地反转。sort:原地升序——**比较函数现已支持**(_ta_sort_cmp:undefined
            // 走既有数值插入排序,否则 validate-callable 后按 ToNumber(cmp(a,b)) 定序)。
            // 此前从不编译 args[0],传入的比较函数被静默忽略。
            this.compileExpression(obj);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            vm.call("_tam_throw_if_immutable_write");
            if (name === "sort") {
                vm.push(VReg.A0);
                if (args.length >= 1) { this.compileExpression(args[0]); vm.mov(VReg.A1, VReg.RET); }
                else vm.movImm64(VReg.A1, 0x7FFB000000000000n); // undefined → 数值序
                vm.pop(VReg.A0);
                vm.call("_ta_sort_cmp");
                return true;
            }
            vm.call("_ta_reverse");
            return true;
        }
        if (name === "toReversed" || name === "toSorted") {
            // TypedArrayCreateSameType(忽略 species) + 拷贝 + 原地 reverse/sort。
            this.compileExpression(obj);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_ta_clone_same_type");
            vm.mov(VReg.A0, VReg.RET);
            if (name === "toReversed") {
                vm.call("_ta_reverse");
            } else {
                if (args.length >= 1) {
                    vm.push(VReg.A0);
                    this.compileExpression(args[0]);
                    vm.mov(VReg.A1, VReg.RET);
                    vm.pop(VReg.A0);
                } else {
                    vm.movImm64(VReg.A1, 0x7ffb000000000000n);
                }
                vm.call("_ta_sort_cmp");
            }
            return true;
        }
        if (name === "with") {
            if (args.length < 2) return true;
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            this.compileExpression(args[0]);
            vm.push(VReg.RET); // boxed index
            this.compileExpression(args[1]);
            vm.mov(VReg.A2, VReg.RET); // boxed value
            vm.pop(VReg.A1);
            vm.pop(VReg.A0);
            vm.call("_ta_with");
            return true;
        }
        // 迭代器:values/entries/keys → 真 TypedArray 迭代器(活读;OOB→TypeError)。
        if (name === "values" || name === "entries" || name === "keys") {
            this.compileExpression(obj);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            vm.movImm(VReg.A1, name === "values" ? 0 : name === "keys" ? 1 : 2);
            vm.call("_ta_iterator_new");
            return true;
        }
        // ---- 回调型方法:转普通数组后委托 _array_*_rt ----
        // 此前 return false 让 compileArrayMethod 接手,后者按 data_ptr@24 解引用 typed 布局
        // → map/filter 结果全错、find/findIndex 返回垃圾、forEach 段错。
        // 修复:先 _ta_to_array 得装箱普通数组,再调 _array_*_rt(与 _tam_* 包装器同构)。
        // 注意:所有实参(callback 等)须 push 落栈后才调 _ta_to_array,因 A1..A7 caller-saved。
        if (name === "toString" || name === "toLocaleString") {
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            vm.pop(VReg.A0);
            if (name === "toLocaleString") {
                vm.call("_ta_to_array");
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_agen_toLocaleString");
                return true;
            }
            vm.lea(VReg.A1, "_str_comma_only");
            vm.movImm64(VReg.V0, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V0);
            vm.call("_ta_join");
            return true;
        }
        if (name === "forEach") {
            this.emitTaCbDelegate(obj, args, "_array_forEach_rt_t");
            return true;
        }
        if ((name === "map" || name === "filter") && args.length >= 1) {
            // 走运行时 _tam_map/_tam_filter:TypedArraySpeciesCreate 顺序与自定义
            // @@species 由那两条路径统一处理(此前 _typed_array_from 跳过 species)。
            const mid = this.nextLabelId();
            const mTa = this.ctx.allocLocal(`__tam_ta_${mid}`);
            const mCb = this.ctx.allocLocal(`__tam_fn_${mid}`);
            const mThis = this.ctx.allocLocal(`__tam_this_${mid}`);
            this.compileExpression(obj);
            vm.store(VReg.FP, mTa, VReg.RET);
            this.compileExpression(args[0]);
            vm.store(VReg.FP, mCb, VReg.RET);
            if (args.length >= 2 && args[1]) {
                this.compileExpression(args[1]);
            } else {
                vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            }
            vm.store(VReg.FP, mThis, VReg.RET);
            vm.load(VReg.A0, VReg.FP, mTa);
            vm.load(VReg.A1, VReg.FP, mCb);
            vm.load(VReg.A2, VReg.FP, mThis);
            vm.call(name === "filter" ? "_tam_filter" : "_tam_map");
            return true;
        }
        if (name === "flatMap" && args.length >= 1) {
            // TypedArray 无 flatMap;保留旧路径防遗漏调用点。
            const mid = this.nextLabelId();
            const mTa = this.ctx.allocLocal(`__tam_ta_${mid}`);
            const mCb = this.ctx.allocLocal(`__tam_fn_${mid}`);
            const mThis = this.ctx.allocLocal(`__tam_this_${mid}`);
            const mType = this.ctx.allocLocal(`__tam_ty_${mid}`);
            this.compileExpression(obj);
            vm.store(VReg.FP, mTa, VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            vm.load(VReg.RET, VReg.FP, mTa);
            vm.loadByte(VReg.V5, VReg.RET, 0);
            vm.store(VReg.FP, mType, VReg.V5);
            this.compileExpression(args[0]);
            vm.store(VReg.FP, mCb, VReg.RET);
            if (args.length >= 2 && args[1]) {
                this.compileExpression(args[1]);
            } else {
                vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            }
            vm.store(VReg.FP, mThis, VReg.RET);
            vm.load(VReg.A0, VReg.FP, mCb);
            vm.call("_ta_need_fn");
            vm.load(VReg.A0, VReg.FP, mTa);
            vm.call("_ta_to_array");
            vm.load(VReg.A1, VReg.FP, mCb);
            vm.load(VReg.A2, VReg.FP, mTa);
            vm.load(VReg.A3, VReg.FP, mThis);
            vm.call("_array_flatMap_rt");
            vm.mov(VReg.A1, VReg.RET);
            vm.load(VReg.A0, VReg.FP, mType);
            vm.call("_typed_array_from");
            return true;
        }
        if (name === "flat") {
            if (args.length === 0) return true;
            this.compileExpression(obj);
            vm.push(VReg.RET);                    // [sp] = boxed ta
            vm.loadByte(VReg.V5, VReg.RET, 0);    // V5 = type byte
            vm.push(VReg.V5);                     // [sp] = type byte, [sp+8] = boxed ta
            vm.pop(VReg.V5);                      // V5 = type byte(restore)
            vm.pop(VReg.A0);                      // A0 = boxed ta
            vm.push(VReg.V5);                     // [sp] = type byte(save across call)
            vm.call("_ta_to_array");              // RET = boxed regular array
            vm.mov(VReg.A0, VReg.RET);            // A0 = boxed arr
            if (args.length >= 1) {
                vm.push(VReg.RET);                // [sp] = boxed arr
                this.compileExpression(args[0]);  // RET = depth(boxed number)
                vm.mov(VReg.A1, VReg.RET);        // A1 = depth(_array_flat_rt 内部 _to_int32 处理)
                vm.pop(VReg.A0);                  // A0 = boxed arr
            } else {
                vm.movImm64(VReg.A1, 0x7ffb000000000000n); // undefined → 默认 depth=1
            }
            vm.call("_array_flat_rt");
            vm.pop(VReg.V5);                      // V5 = type byte
            vm.mov(VReg.A1, VReg.RET);            // A1 = boxed result array
            vm.mov(VReg.A0, VReg.V5);             // A0 = type byte
            vm.call("_typed_array_from");
            return true;
        }
        if (name === "some" || name === "every") {
            this.emitTaCbDelegate(obj, args,
                name === "some" ? "_array_some_rt_t" : "_array_every_rt_t");
            return true;
        }
        if (name === "reduce" || name === "reduceRight") {
            if (args.length === 0) {
                // 无参:ValidateTypedArray + IsCallable(undefined)→TypeError
                this.compileExpression(obj);
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_tam_throw_if_detached");
                vm.movImm64(VReg.A0, 0x7ffb000000000000n);
                vm.call("_ta_need_fn");
                return true;
            }
            // 此前这段栈操作是坏的:有 initialValue 时把 init **pop 两次**(第二次把回调
            // 当 init 取走,继而 A0/A1 全错位);无 init 时 `_ta_to_array` 收到的 A0 是回调。
            // 结果 `ta.reduce(cb)` 跳进垃圾地址。重排为:实参全部落栈 → 校验可调用 →
            // 只在跨调用点把值压栈保活。
            const hasInit = args.length >= 2;
            this.compileExpression(obj);
            vm.push(VReg.RET);                    // ta
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            this.compileExpression(args[0]);
            vm.push(VReg.RET);                    // cb
            if (hasInit) {
                this.compileExpression(args[1]);
                vm.push(VReg.RET);                // init(实参求值序在校验可调用之前)
                vm.pop(VReg.A2);
            }
            vm.pop(VReg.A1);                      // A1 = cb
            vm.pop(VReg.A0);                      // A0 = ta
            vm.push(VReg.A0);                     // ta 保活
            if (hasInit) vm.push(VReg.A2);        // init 保活
            vm.push(VReg.A1);                     // cb 保活
            vm.mov(VReg.A0, VReg.A1);
            vm.call("_ta_need_fn");               // validate callable(TypeError if not)
            vm.pop(VReg.A1);                      // cb
            if (hasInit) vm.pop(VReg.A2); else vm.movImm64(VReg.A2, 0x7ffb000000000000n);
            if (hasInit) vm.movImm(VReg.A3, 1); else vm.movImm(VReg.A3, 0);
            vm.pop(VReg.A0);                      // ta
            vm.call(name === "reduce" ? "_ta_reduce" : "_ta_reduceRight");
            return true;
        }
        if (name === "find" || name === "findIndex" || name === "findLast" || name === "findLastIndex") {
            this.compileExpression(obj);
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_tam_throw_if_detached");
            if (args.length >= 1 && args[0]) {
                this.compileExpression(args[0]);
            } else {
                vm.movImm64(VReg.RET, 0x7ffb000000000000n);
            }
            vm.push(VReg.RET);
            if (args.length >= 2 && args[1]) {
                this.compileExpression(args[1]);
                vm.mov(VReg.A3, VReg.RET);
            } else {
                vm.movImm64(VReg.A3, 0x7ffb000000000000n);
            }
            vm.pop(VReg.A1);
            vm.pop(VReg.A0);
            vm.mov(VReg.S1, VReg.A0);
            vm.mov(VReg.S2, VReg.A1);
            vm.mov(VReg.S3, VReg.A3);
            vm.mov(VReg.A0, VReg.A1);
            vm.call("_ta_need_fn");
            vm.mov(VReg.A0, VReg.S1);
            vm.mov(VReg.A1, VReg.S2);
            const mode = name === "find" ? 0
                : name === "findIndex" ? 1
                : name === "findLast" ? 2 : 3;
            vm.movImm(VReg.A2, mode);
            vm.mov(VReg.A3, VReg.S3);
            vm.call("_tam_find_core");
            return true;
        }
        return false; // 剩余未识别方法:走 compileArrayMethod 通用路径
    },

    /**
     * 编译动态 new（如 new (expr)(args) 或 new obj.method()）
     * @param {number} constructorReg - 存储构造函数闭包/类对象的寄存器
     * @param {Array} args - 构造函数参数
     */
    compileDynamicNew(constructorReg, args, newTargetOff) {
        // constructorReg 通常是 caller-saved 临时寄存器（V6=X14），下面的 _alloc
        // 调用会破坏它，之后再读 @48/@32 就是解引用垃圾 → 崩溃（new AST.Program()
        // 等命名空间成员实例化）。先存入 callee-saved S1，跨 _alloc 与参数求值都安全。
        // 同时去标签：命名空间成员成员访问可能返回装箱指针，裸指针 mask 后不变。
        // [闭包 new] 原值(装箱形态)也存槽:闭包分支的 _closure_prop_get 按原值键查
        // props 侧表(与 fn.x=v 写侧同键形)。
        const dnFnValSlot = this.ctx.allocLocal(`__dnew_fnval_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, dnFnValSlot, constructorReg);
        // S1 mask is after ArgumentListEvaluation: args smash V0===RET / constructorReg.

        // IsConstructor(newTarget) when explicit (Reflect.construct 3-arg).
        // isConstructor(f) is Reflect.construct(function(){}, [], f): target is
        // a plain constructor, so the _aref_* guard on the *target* never fires.
        // Synthesized builtins (JSON.rawJSON, Object.create, Math.abs, …) must
        // still reject as newTarget. _is_nonctor_fn now treats _aref_generic /
        // _aref_static_tramp as non-constructors.
        if (newTargetOff != null && newTargetOff !== undefined) {
            const ntOkL = this.ctx.newLabel("dnew_nt_ok");
            this.vm.load(VReg.A0, VReg.FP, newTargetOff);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1);
            this.vm.call("_is_nonctor_fn");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(ntOkL);
            this.vm.lea(VReg.A0, this.asm.addString("value is not a constructor"));
            this.vm.call("_js_box_string");
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_throw_type_error");
            this.vm.label(ntOkL);
        }

        // EvaluateNew: ArgumentListEvaluation BEFORE IsConstructor
        // (ctorExpr-isCtor-after-args-eval). Pin ctor in FP first; reload S1 after.
        const dnArgsSlot = this.ctx.allocLocal(`__dnew_args_${this.nextLabelId()}`);
        this.compileArrayExpressionWithSpread(args);
        this.vm.store(VReg.FP, dnArgsSlot, VReg.RET);
        this.vm.load(VReg.V6, VReg.FP, dnFnValSlot);
        this.vm.movImm64(VReg.V7, 0x0000ffffffffffffn);
        this.vm.and(VReg.S1, VReg.V6, VReg.V7);

        // Reject primitive constructor values before any Proxy/closure/class
        // layout probe dereferences the masked payload.  A tagged Boolean true
        // becomes address 1 after masking; the old late guard therefore
        // SIGSEGVed in `new true` at load [S1] instead of throwing TypeError.
        // ArgumentListEvaluation has already completed above, preserving the
        // required observable evaluation order.
        {
            const ptrOk = this.ctx.newLabel("dnew_ptr_ok");
            const ptrBad = this.ctx.newLabel("dnew_ptr_bad");
            this.vm.load(VReg.V1, VReg.FP, dnFnValSlot);
            this.vm.shrImm(VReg.V1, VReg.V1, 48);
            this.vm.cmpImm(VReg.V1, 0x7FFD); // object/classinfo
            this.vm.jeq(ptrOk);
            this.vm.cmpImm(VReg.V1, 0x7FFF); // function/closure
            this.vm.jeq(ptrOk);
            this.vm.cmpImm(VReg.V1, 0);      // raw heap/code pointer
            this.vm.jne(ptrBad);
            this.vm.movImm64(VReg.V2, this.vm.ptrFloor);
            this.vm.cmp(VReg.S1, VReg.V2);
            this.vm.jge(ptrOk);
            this.vm.label(ptrBad);
            this.vm.lea(VReg.A0, this.asm.addString("value is not a constructor"));
            this.vm.call("_js_box_string");
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_throw_type_error"); // does not return
            this.vm.label(ptrOk);
        }

        // [Proxy construct] 值为 Proxy(块 type@0==8)→ 构造走 construct 陷阱蹦床
        // (须在解 props_ptr 前判别;S1 已去 tag)。
        const dynNewProxyEndL = this.ctx.newLabel("dnew_pxend");
        {
            const notProxyL = this.ctx.newLabel("dnew_notpx");
            this.vm.cmpImm(VReg.S1, 0);
            this.vm.jeq(notProxyL);
            this.vm.load(VReg.V1, VReg.S1, 0);
            this.vm.cmpImm(VReg.V1, 8); // TYPE_PROXY
            this.vm.jne(notProxyL);
            const pSlot = this.ctx.allocLocal(`__dnewpx_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, pSlot, VReg.S1);
            this.vm.load(VReg.RET, VReg.FP, dnArgsSlot); // RET = 实参 boxed 数组
            this.vm.mov(VReg.A1, VReg.RET); // 先取 RET(与 A0 同物理寄存器 X0/RAX!)
            this.vm.load(VReg.A0, VReg.FP, pSlot);
            this.vm.call("_proxy_construct_call");
            this.vm.jmp(dynNewProxyEndL);
            this.vm.label(notProxyL);
        }

        // [闭包 new] 值为闭包(magic 0xc105)——运行时函数值(参数/变量/陷阱实参里的
        // plain function)。此前按 classinfo 布局读 props_ptr@32 = 解引用垃圾 → 崩
        // (`function mk(C){return new C();}` / construct 陷阱内 `new t()` 的根因)。
        // ES5 构造语义走运行时 `_fn_construct_call(fn 值, argsArr)`(实参统一经
        // compileArrayExpressionWithSpread 数组求值 → spread 天然支持)。
        {
            const notClosureL = this.ctx.newLabel("dnew_notcl");
            this.vm.cmpImm(VReg.S1, 0);
            this.vm.jeq(notClosureL);
            this.vm.load(VReg.V1, VReg.S1, 0);
            this.vm.movImm(VReg.V0, 0xc105); // CLOSURE_MAGIC
            this.vm.cmp(VReg.V1, VReg.V0);
            this.vm.jne(notClosureL);
            // [TA/AB 构造器闭包] fnptr==_ta_ctor_tramp → _ta_construct 专用转发
            // (无实例语义,RET 即蹦床产的 TA/ArrayBuffer 指针;否则走 _fn_construct_call
            // 会把蹦床返回值丢弃、返回空实例对象)。
            const dnewNotTa = this.ctx.newLabel("dnew_notta");
            this.vm.load(VReg.V1, VReg.S1, 8);
            this.vm.lea(VReg.V0, "_ta_ctor_tramp");
            this.vm.cmp(VReg.V1, VReg.V0);
            this.vm.jne(dnewNotTa);
            {
                const constructL = this.ctx.newLabel("dnew_ta_construct");
                const typeSlot = this.ctx.allocLocal(`__dnew_ta_ty_${this.nextLabelId()}`);
                // 1-arg TA: match static `new Uint8Array(x)` — evaluate the
                // already-built args[0] then `_typed_array_from`. Keep type in
                // an FP slot across `_array_get`.
                this.vm.load(VReg.A0, VReg.FP, dnArgsSlot);
                this.vm.call("_array_length");
                this.vm.cmpImm(VReg.RET, 1);
                this.vm.jne(constructL);
                this.vm.load(VReg.V0, VReg.FP, dnFnValSlot);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                this.vm.load(VReg.V1, VReg.V0, 16);
                this.vm.cmpImm(VReg.V1, 0x70);
                this.vm.jeq(constructL);
                this.vm.store(VReg.FP, typeSlot, VReg.V1);
                this.vm.load(VReg.A0, VReg.FP, dnArgsSlot);
                this.vm.movImm(VReg.A1, 0);
                this.vm.call("_array_get");
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.movImm(VReg.V0, 0);
                this.vm.store(VReg.FP, dnArgsSlot, VReg.V0);
                this.vm.load(VReg.A0, VReg.FP, typeSlot);
                this.vm.call("_typed_array_from");
                this.vm.jmp(dynNewProxyEndL);
                this.vm.label(constructL);
            }
            this.vm.load(VReg.RET, VReg.FP, dnArgsSlot);
            this.vm.mov(VReg.A1, VReg.RET);
            this.vm.load(VReg.A0, VReg.FP, dnFnValSlot);
            this.vm.call("_ta_construct");
            this.vm.jmp(dynNewProxyEndL);
            // [非构造器守卫] built-in method closures (fnptr==_aref_generic or
            // _aref_static_tramp) are not constructable per ES spec. Throw TypeError
            // to fix not-a-constructor tests.
            this.vm.label(dnewNotTa);
            const dnewConstructable = this.ctx.newLabel("dnew_constructable");
            // Dynamic generator/async functions carry non-constructor status
            // in the host metadata side table.  Check it at the language
            // EvaluateNew seam so the normal exception context catches the
            // TypeError (throwing from inside _fn_construct_call bypassed that
            // seam and corrupted the helper's native frame).
            this.vm.mov(VReg.A0, VReg.S1);
            this.vm.call("_is_nonctor_fn");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jne("_dnew_not_ctor_throw");
            this.vm.load(VReg.V1, VReg.S1, 8); // restore fnptr clobbered by helper
            this.vm.lea(VReg.V0, "_aref_generic");
            this.vm.cmp(VReg.V1, VReg.V0);
            this.vm.jeq("_dnew_not_ctor_throw");
            this.vm.lea(VReg.V0, "_aref_static_tramp");
            this.vm.cmp(VReg.V1, VReg.V0);
            this.vm.jne(dnewConstructable);
            this.vm.label("_dnew_not_ctor_throw");
            this.vm.lea(VReg.A0, this.asm.addString("value is not a constructor"));
            this.vm.call("_js_box_string");
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_throw_type_error"); // does not return
            this.vm.label(dnewConstructable);
            // Promise validates the executor before
            // GetPrototypeFromConstructor(NewTarget).  Generic
            // _fn_construct_call reads newTarget.prototype first, so an empty
            // args list with a poisoned newTarget prototype exposed the getter
            // instead of throwing the required executor TypeError.
            const dnewNotPromiseCtor = this.ctx.newLabel("dnew_not_promise_ctor");
            this.vm.load(VReg.V1, VReg.S1, 8);
            this.vm.lea(VReg.V0, "_promise_ctor_call");
            this.vm.cmp(VReg.V1, VReg.V0);
            this.vm.jne(dnewNotPromiseCtor);
            this.vm.load(VReg.A0, VReg.FP, dnArgsSlot);
            this.vm.movImm(VReg.A1, 0);
            this.vm.call("_array_get");
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_pnpc_is_callable");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jne(dnewNotPromiseCtor);
            this.vm.lea(VReg.A0, this.asm.addString("Promise executor is not callable"));
            this.vm.call("_js_box_string");
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_throw_type_error");
            this.vm.label(dnewNotPromiseCtor);
            this.vm.load(VReg.RET, VReg.FP, dnArgsSlot); // RET = 实参 boxed 数组
            this.vm.mov(VReg.A1, VReg.RET); // 先取 RET(与 A0 同物理寄存器 X0/RAX!)
            this.vm.load(VReg.A0, VReg.FP, dnFnValSlot);
            if (newTargetOff != null && newTargetOff !== undefined) {
                this.vm.load(VReg.A2, VReg.FP, newTargetOff);
            } else {
                this.vm.movImm(VReg.A2, 0);
            }
            this.vm.call("_fn_construct_call");
            this.vm.jmp(dynNewProxyEndL);
            this.vm.label(notClosureL);
        }

        // [非构造器守卫] 走到这里的值只可能按**类信息对象**布局解释(下面直接
        // `ldr [S1,#32]` 取 props_ptr)。此前对 NULL / 数字 / 字符串 / undefined 等
        // 非法构造器一律照读 → 解引用野地址 SIGSEGV(test262 里 `new <garbage>()`
        // 的崩溃点 _dnew_notcl)。类信息值只有两种合法位形:裸指针(高16位为 0,
        // 如 _classinfo_X 槽)与装箱对象 0x7FFD;闭包/Proxy 已在上面各自分流。
        // 其余一律抛可捕获的 TypeError(与 _throw_read_nullish 同表示 →
        // `e instanceof TypeError` / `e.constructor.name === "TypeError"` 成立)。
        // 消息用固定串(asm.addString 驻留)——按调用位拼接 callee 源文本会给字符串池
        // 增加几十条,可能推动自举产物越过 16KB 页界触发既有布局非确定性。
        {
            const ctorTagOkL = this.ctx.newLabel("dnew_ctortag_ok");
            const ctorBadL = this.ctx.newLabel("dnew_ctorbad");
            this.vm.cmpImm(VReg.S1, 0);
            this.vm.jeq(ctorBadL);
            this.vm.load(VReg.V1, VReg.FP, dnFnValSlot); // 原始(带 tag)值
            this.vm.shrImm(VReg.V1, VReg.V1, 48);
            this.vm.cmpImm(VReg.V1, 0); // 裸指针
            this.vm.jeq(ctorTagOkL);
            this.vm.cmpImm(VReg.V1, 0x7ffd); // 装箱对象
            this.vm.jeq(ctorTagOkL);
            this.vm.label(ctorBadL);
            this.vm.lea(VReg.A0, this.asm.addString("value is not a constructor"));
            this.vm.call("_js_box_string");
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_throw_type_error"); // 不返回
            // Tag OK: verify type byte is classinfo (3). Regular objects (type=2)
            // like Object.prototype are not constructors.
            this.vm.label(ctorTagOkL);
            this.vm.loadByte(VReg.V1, VReg.S1, 0);
            this.vm.cmpImm(VReg.V1, 3); // TYPE_CLOSURE (classinfo)
            this.vm.jne(ctorBadL);
        }

        // 1. 分配新对象（新布局：属性区独立分配、可自动增长）
        this.vm.call("_object_new");
        this.vm.mov(VReg.S0, VReg.RET); // S0 = 新对象

        // 2/3. 设置 prototype 与构造函数（类信息新布局：经 props_ptr 读取）
        this.vm.load(VReg.V1, VReg.S1, 32); // props_ptr
        this.vm.load(VReg.V0, VReg.V1, 24); // prototype 对象 = props[1].val
        this.vm.store(VReg.S0, 16, VReg.V0);
        this.vm.load(VReg.S2, VReg.V1, 8); // ctor = props[0].val

        // 4. 准备参数（构造函数约定: A0 = this, 参数在 A1-A5）
        // 未提供的构造函数实参填 JS_UNDEFINED，使被调用方默认参数生效
        this.emitCtorArgRegsFromArray(dnArgsSlot);

        // 5. 调用构造函数 (A0 = this)
        this.vm.mov(VReg.A0, VReg.S0);
        // NewTarget: explicit (Reflect.construct 3-arg) or the constructor value.
        if (newTargetOff != null && newTargetOff !== undefined) {
            this.vm.load(VReg.V6, VReg.FP, newTargetOff);
        } else {
            this.vm.load(VReg.V6, VReg.FP, dnFnValSlot);
        }
        this.emitSetNewTargetFromReg(VReg.V6);
        this.vm.callIndirect(VReg.S2);

        // 6. 返回:构造器显式返回对象/数组/TypedArray 则用之(super→_ta_construct
        // 产裸 TA;new Function 子类经本路径 `new M(...)`),否则回落初始实例 S0
        // 装箱 0x7ffd(for-in 等要求 tag∈{0x7ffd,0x7ffe})。
        {
            const keepL = this.ctx.newLabel("dnew_keep_ret");
            const doneL = this.ctx.newLabel("dnew_ret_done");
            this.vm.shrImm(VReg.V1, VReg.RET, 48);
            this.vm.cmpImm(VReg.V1, 0x7ffd);
            this.vm.jeq(keepL);
            this.vm.cmpImm(VReg.V1, 0x7ffe);
            this.vm.jeq(keepL);
            this.vm.cmpImm(VReg.V1, 0x7fff);
            this.vm.jeq(keepL);
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jne(doneL);
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(doneL);
            this.vm.loadByte(VReg.V1, VReg.RET, 0); // 勿用 V0:x64 V0≡RET
            this.vm.cmpImm(VReg.V1, 4); // TYPE_MAP
            this.vm.jeq(keepL);
            this.vm.cmpImm(VReg.V1, 5); // TYPE_SET
            this.vm.jeq(keepL);
            this.vm.cmpImm(VReg.V1, 12); // TYPE_ARRAY_BUFFER
            this.vm.jeq(keepL);
            this.vm.cmpImm(VReg.V1, 14); // TYPE_DATA_VIEW
            this.vm.jeq(keepL);
            this.vm.cmpImm(VReg.V1, 0x40);
            this.vm.jlt(doneL);
            this.vm.cmpImm(VReg.V1, 0x61);
            this.vm.jgt(doneL);
            this.vm.jmp(keepL);
            this.vm.label(doneL);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.RET, VReg.S0, VReg.V1);
            this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
            this.vm.or(VReg.RET, VReg.RET, VReg.V1);
            this.vm.label(keepL);
        }
        this.vm.label(dynNewProxyEndL); // [Proxy construct] 蹦床返回汇合点
    },
};
