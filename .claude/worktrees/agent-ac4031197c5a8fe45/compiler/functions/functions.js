// asm.js 编译器 - 函数和复合类型编译（聚合模块）
// 导入并组合所有函数相关的编译器

import { VReg } from "../../vm/index.js";
import { Type, inferType } from "../core/types.js";

// 导入拆分的模块
import { BuiltinMethodCompiler } from "./builtin_methods.js";
import { BuiltinMathMethodCompiler } from "./builtin_math.js";
import { BuiltinArrayMethodCompiler } from "./builtin_array_methods.js";
import { BuiltinCollectionMethodCompiler } from "./builtin_collection_methods.js";
import { DataStructureCompiler } from "./data_structures.js";
import { ClosureCompiler } from "./closures.js";
import { ASYNC_CLOSURE_MAGIC, isAsyncFunction, isGeneratorFunction } from "../async/index.js";
import { OperatorCompiler } from "../expressions/operators.js";

// 闭包魔数 - 用于区分普通函数指针和闭包对象
const CLOSURE_MAGIC = 0xc105;

// 方法分派用的方法名表：**必须模块级只建一次**。原先是每次编译方法调用都在函数内重建这些
// 数组字面量——自举编译整个编译器有约十万次方法调用 × 每次重建约十个数组 → 累积数十 GB 瞬时
// 分配（gen1 无 GC 不回收）→ OOM 跑不出 gen2。提到模块级后每个只分配一次。
const HOISTED_STRING_METHODS = ["toUpperCase", "toLowerCase", "charAt", "charCodeAt", "codePointAt", "trim", "slice", "substring", "substr", "indexOf", "concat", "includes", "startsWith", "endsWith", "lastIndexOf", "at", "repeat", "padStart", "padEnd", "split", "trimStart", "trimEnd", "trimLeft", "trimRight", "replace", "replaceAll", "normalize", "localeCompare"];
const HOISTED_ARRAY_METHODS = ["push", "pop", "shift", "unshift", "length", "at", "slice", "indexOf", "includes", "forEach", "map", "filter", "flatMap", "reduce", "reduceRight", "join", "reverse", "concat", "find", "findIndex", "findLast", "findLastIndex", "toSorted", "toReversed", "toSpliced", "with", "some", "every", "fill", "flat", "keys", "values", "entries", "sort", "splice", "lastIndexOf", "copyWithin"];
const HOISTED_ARRAY_ONLY_METHODS = ["push", "pop", "shift", "unshift", "forEach", "map", "filter", "flatMap", "reduce", "reduceRight", "join", "reverse", "find", "findIndex", "findLast", "findLastIndex", "toSorted", "toReversed", "toSpliced", "with", "some", "every", "fill", "flat", "keys", "values", "entries", "sort", "splice", "copyWithin"];
const HOISTED_AMBIGUOUS_ARR_STR = ["slice", "at", "indexOf", "includes", "concat", "lastIndexOf"];
const HOISTED_MAP_METHODS = ["set", "get", "has", "delete", "size", "clear", "forEach", "keys", "values", "entries"];
const HOISTED_SET_METHODS = ["add", "has", "delete", "size", "clear", "forEach", "keys", "values", "entries", "union", "intersection", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom"];
const HOISTED_DATE_METHODS = ["getTime", "toString", "valueOf", "toISOString", "toJSON", "getTimezoneOffset", "getFullYear", "getMonth", "getDate", "getHours", "getMinutes", "getSeconds", "getMilliseconds", "getDay", "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCHours", "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds", "getUTCDay", "setFullYear", "setMonth", "setDate", "setHours", "setMinutes", "setSeconds", "setMilliseconds", "setTime", "setUTCFullYear", "setUTCMonth", "setUTCDate", "setUTCHours", "setUTCMinutes", "setUTCSeconds", "setUTCMilliseconds"];
const HOISTED_DATE_METHODS2 = ["getTime", "toString", "valueOf"];
const HOISTED_REGEXP_METHODS = ["test", "exec"];

// 函数和复合类型编译方法混入 - 聚合所有函数相关的编译器
export const FunctionCompiler = {
    // 从各模块混入方法(builtin 方法按功能拆分为 math/array/collection/string+regexp 四文件)
    ...BuiltinMethodCompiler,
    ...BuiltinMathMethodCompiler,
    ...BuiltinArrayMethodCompiler,
    ...BuiltinCollectionMethodCompiler,
    ...DataStructureCompiler,
    ...ClosureCompiler,
    ...OperatorCompiler,

    // 推断对象类型（用于方法调用分派）
    inferObjectType(obj) {
        const type = inferType(obj, this.ctx);
        switch (type) {
            case Type.MAP:
                return "Map";
            case Type.SET:
                return "Set";
            case Type.DATE:
                return "Date";
            case Type.REGEXP:
                return "RegExp";
            case Type.ARRAY:
                return "Array";
            case Type.TYPED_ARRAY:
                return "TypedArray";
            case Type.ARRAY_BUFFER:
                return "ArrayBuffer";
            case Type.DATA_VIEW:
                return "DataView";
            case Type.OBJECT:
                return "Object";
            case Type.STRING:
                return "String";
            default:
                return "unknown";
        }
    },

    // 判断表达式是否返回布尔值
    isBooleanExpression(expr) {
        // 比较表达式
        if (expr.type === "BinaryExpression") {
            const op = expr.operator;
            if (["<", ">", "<=", ">=", "==", "===", "!=", "!==", "instanceof", "in"].includes(op)) {
                return true;
            }
        }
        // 逻辑非
        if (expr.type === "UnaryExpression" && expr.operator === "!") {
            return true;
        }
        // 方法调用返回布尔值的情况 —— **必须按接收者类型门控**。此前对任意接收者的
        // .has/.delete/.includes/.startsWith/.endsWith/.test 一律判布尔,导致 console.log
        // 里同名用户方法(`{test(){return 42}}`.test()、path.includes()、user.has())的
        // **非布尔**返回值被 console.log 当布尔渲染成 "true"/"false"(值本身正确,仅打印错)。
        // 仅当接收者静态类型匹配对应内建(Map/Set 的 has/delete、Array/String 的 includes、
        // String 的 starts/endsWith、RegExp 的 test)才是布尔;未知/用户对象走通用值打印
        // (布尔值经 tag 仍正确渲染,无回归)。
        if (expr.type === "CallExpression" && expr.callee.type === "MemberExpression" &&
            !expr.callee.computed && expr.callee.property) {
            const methodName = expr.callee.property.name;
            const recvType = inferType(expr.callee.object, this.ctx);
            if ((methodName === "has" || methodName === "delete") &&
                (recvType === Type.MAP || recvType === Type.SET)) return true;
            if (methodName === "includes" &&
                (recvType === Type.ARRAY || recvType === Type.STRING)) return true;
            if ((methodName === "startsWith" || methodName === "endsWith") &&
                recvType === Type.STRING) return true;
            if (methodName === "test" && recvType === Type.REGEXP) return true;
        }
        return false;
    },

    // 编译函数参数 - 先全部压栈，再统一弹出到参数寄存器
    // 这是因为 VReg.RET 和 VReg.A0 都映射到同一个物理寄存器 (X0/RAX)
    compileCallArguments(args) {
        // 含扩展实参 f(...a) / f(x, ...a)：真实参数个数编译期未知，
        // 走"构建实参数组 + 取前 6 个装入 A0..A5"路径（受既有 6 参寄存器上限约束）。
        for (let i = 0; i < args.length; i++) {
            if (args[i] && args[i].type === "SpreadElement") {
                this.compileCallArgumentsWithSpread(args);
                return;
            }
        }

        const argCount = Math.min(args.length, 6);

        // [#56/A3] ES 要求实参左到右求值(可观察副作用序:g(f(1),f(2),f(3)))。
        // 原实现从右往左编译压栈(i:argCount-1→0)→副作用反序。改为左到右求值压栈,
        // 栈顶为最后一个实参,再逆序弹出到 A0..A5 —— 最终寄存器落位不变、指令条数不变,
        // 仅求值/压栈顺序左到右。
        for (let i = 0; i < argCount; i++) {
            this.compileExpression(args[i]);
            this.vm.push(VReg.RET);
        }

        // 栈顶是最后一个实参,逆序弹出到参数寄存器(A0=arg0 在栈底)
        for (let i = argCount - 1; i >= 0; i--) {
            this.vm.pop(this.vm.getArgReg(i));
        }
        // 未提供的形参寄存器清为 JS_UNDEFINED（否则是上次调用的残留值，
        // 导致缺参 typeof 错乱 / Boolean(缺参) 拿到垃圾）。A5 保留给方法 this
        for (let i = argCount; i < 5; i++) {
            this.vm.lea(this.vm.getArgReg(i), "_js_undefined");
            this.vm.load(this.vm.getArgReg(i), this.vm.getArgReg(i), 0);
        }
        // [argc ABI] 调用点最后一步:实参个数写 _call_argc 全局。全部实参已求值完毕,
        // 嵌套调用点的写入不会污染本次(调用点最后写、被调方 prologue 最先读)。
        this.emitSetCallArgc(argCount);
    },

    // [argc ABI] 写实参个数到 _call_argc 全局。argCount 为编译期常数;或传 srcReg
    // (运行时长度寄存器,spread 路径用)。V5/V6 两后端均不别名 A0-A5
    // (arm64 X13/X14、x64 R10/R11),装好的实参寄存器不受扰。
    emitSetCallArgc(argCount, srcReg) {
        this.vm.lea(VReg.V5, "_call_argc");
        if (srcReg) {
            this.vm.store(VReg.V5, 0, srcReg);
        } else {
            this.vm.movImm(VReg.V6, argCount);
            this.vm.store(VReg.V5, 0, VReg.V6);
        }
    },

    // 编译含扩展的调用实参 f(a, ...b, c)
    // 复用数组扩展构建把全部实参展开成一个数组，再按运行时长度把前 6 个
    // 装入 A0..A5（越界的填 JS_UNDEFINED）。受既有 6 参寄存器约定约束：
    // 超过 6 个实参会被截断（与非扩展路径 Math.min(args.length,6) 一致）。
    // 方法调用会在此之后用 A5 覆盖成 this（见 compileMethodCall），语义一致。
    compileCallArgumentsWithSpread(args) {
        // RET = 全部实参组成的 boxed 数组（调用实参与数组元素的扩展语义相同）
        this.compileArrayExpressionWithSpread(args);
        const argsArrOff = this.ctx.allocLocal(`__callsp_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, argsArrOff, VReg.RET);
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_array_length");            // RET = 整数长度
        const lenOff = this.ctx.allocLocal(`__callsp_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOff, VReg.RET);

        // 逆序算出 arg[5..0] 压栈；每个 = (i < len) ? arr[i] : undefined
        for (let i = 5; i >= 0; i--) {
            const id = this.nextLabelId();
            const undefL = `_callsp_undef_${id}`;
            const doneL = `_callsp_done_${id}`;
            this.vm.load(VReg.V0, VReg.FP, lenOff);
            this.vm.cmpImm(VReg.V0, i);
            this.vm.jle(undefL);                  // len <= i → 无此实参
            this.vm.load(VReg.A0, VReg.FP, argsArrOff);
            this.vm.movImm(VReg.A1, i);
            this.vm.call("_array_get");           // RET = arr[i]
            this.vm.jmp(doneL);
            this.vm.label(undefL);
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
            this.vm.label(doneL);
            this.vm.push(VReg.RET);
        }
        // 依次弹出到 A0..A5（栈顶是 arg0）
        for (let i = 0; i < 6; i++) {
            this.vm.pop(this.vm.getArgReg(i));
        }
        // [argc ABI] spread 路径:实参个数为运行时数组长度(裸整数,消费方自行按寄存器上限截断)
        this.vm.load(VReg.V6, VReg.FP, lenOff);
        this.emitSetCallArgc(0, VReg.V6);
    },

    // 编译 async 顶层函数调用
    // 创建协程并返回 Promise
    // 简化版：直接执行函数，将结果包装成 Promise
    compileAsyncFunctionCall(funcName, args) {
        const funcLabel = this.getFunctionLabel(funcName);
        if (!funcLabel) {
            return;
        }
        const vm = this.vm;

        // 真正的 async：创建协程并返回 Promise
        vm.lea(VReg.V1, funcLabel);
        this.compileAsyncCall(VReg.V1, args);
    },

    // 若 reg 是 null(0x7FFA)/undefined(0x7FFB)/0，跳到 label
    // 加载父类信息对象（raw 指针）到 destReg
    emitLoadClassInfo(className, destReg) {
        const declNode = this.ctx.getFunction && this.ctx.getFunction(className);
        // 嵌套/局部类(函数体内 `class D{}`)不进 collectFunctions(仅扫顶层 ast.body),
        // 故 getFunction 查不到——但 compileClassDeclaration 仍为其发射全局 `_classinfo_<sym>`
        // 槽并在声明处运行时写入。缺此识别时 emitLoadClassInfo 落标识符兜底路径,在**父类
        // 构造函数上下文**(super() 所在,D 非其局部)解析到垃圾指针 → `new E()`(E extends D
        // 嵌套)段错误。因此:有全局 classinfo 槽且当前上下文无同名局部绑定 → 读全局槽。
        const rawSym = this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(className);
        // 嵌套/局部类(rawSym === undefined):解析到本声明专属唯一槽(compileClassDeclaration
        // 记入 _nestedClassInfoLabels),避免不同作用域同名类共享 `_classinfo_<名>` 交叉污染。
        // 顶层/别名类:沿用稳定 `_classinfo_<sym>`。
        let infoLabel;
        if (rawSym === undefined || rawSym === null) {
            infoLabel = (this._nestedClassInfoLabels && this._nestedClassInfoLabels[className]) || `_classinfo_${className}`;
        } else {
            infoLabel = `_classinfo_${rawSym}`;
        }
        const hasInfoSlot = this._addedClassInfoLabels && this._addedClassInfoLabels.has(infoLabel);
        const localOff = this.ctx.getLocal && this.ctx.getLocal(className);
        if (((declNode && declNode.type === "ClassDeclaration") || hasInfoSlot) && !localOff) {
            // 本模块声明(顶层或嵌套):从 classinfo 槽读取
            this.vm.lea(destReg, infoLabel);
            this.vm.load(destReg, destReg, 0);
            return;
        }
        // 否则当作标识符/导入绑定编译，得到装箱类信息对象，去 tag 成 raw
        this.compileExpression({ type: "Identifier", name: className });
        this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        this.vm.and(destReg, VReg.RET, VReg.V1);
    },

    // 加载**父类**信息对象(raw 指针)到 destReg,供 super()/super.m()/super.prop 使用。
    // 表达式父类(`extends (expr)`):父类无名字,其 classinfo 已在类声明处求值并存入
    // superInfoLabel 全局,从该全局读取。标识符父类:退回名字路径(emitLoadClassInfo),
    // 与旧实现逐字节一致(superClassExpr 为假)。
    emitLoadSuperClassInfo(destReg) {
        if (this.ctx.superClassExpr && this.ctx.superInfoLabel) {
            this.vm.lea(destReg, this.ctx.superInfoLabel);
            this.vm.load(destReg, destReg, 0);
            return;
        }
        this.emitLoadClassInfo(this.ctx.superClass, destReg);
    },

    // 为**类声明**计算其 classinfo 全局槽标签。顶层/别名类返回稳定 `_classinfo_<sym>`;
    // 嵌套/局部类(getFunctionSymbol===undefined)返回按 labelId 唯一化的 `_classinfo_<名>__<id>`
    // 并登记 _nestedClassInfoLabels[名]=标签,供同作用域引用(emitLoadClassInfo)解析。
    // 由 compileClassDeclaration 顶部调用一次,写入两处 classinfo 槽复用同一返回值。
    _classInfoLabelForDecl(className, labelId) {
        const rawSym = this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(className);
        if (rawSym === undefined || rawSym === null) {
            const label = `_classinfo_${className}__${labelId}`;
            if (!this._nestedClassInfoLabels) this._nestedClassInfoLabels = {};
            this._nestedClassInfoLabels[className] = label;
            return label;
        }
        return `_classinfo_${rawSym}`;
    },

    // [#45] Date.UTC(y, mo?, d?, h?, mi?, s?, ms?) -> UTC 毫秒(number,非 Date 对象)。
    // 与 new Date(y,mo,...)(expressions.js compileNewExpression 的 Date case)同源
    // Hinnant days-from-civil 历法(截断除法 + era 调整,全年代正确、UTC 语义自洽)。
    // 唯一区别:不调用 _date_new_ts 装箱成 Date,而是把毫秒作为裸 float64 数值留在 RET。
    // 缺省(ECMAScript):month=0、day=1、其余=0(year 缺省→NaN,此处不特判)。
    // 结果留在 RET(V0):裸 float64 位模式,即本运行时的 number 表示(同 getTime/new Date ms)。
    emitDateUTCms(args) {
        const dOffs = [];
        for (let di2 = 0; di2 < 7; di2++) {
            dOffs.push(this.ctx.allocLocal(`__dutc_a${di2}_${this.nextLabelId()}`));
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
        // m = mo+1; if (m<=2) y--
        this.vm.load(VReg.V0, VReg.FP, dOffs[1]);
        this.vm.addImm(VReg.V0, VReg.V0, 1); // m
        this.vm.load(VReg.V1, VReg.FP, dOffs[0]); // y
        const dL1 = this.ctx.newLabel("dutc_mgt2");
        this.vm.cmpImm(VReg.V0, 2);
        this.vm.jgt(dL1);
        this.vm.subImm(VReg.V1, VReg.V1, 1);
        this.vm.label(dL1);
        // era = (y>=0 ? y : y-399)/400
        this.vm.mov(VReg.V2, VReg.V1);
        const dL2 = this.ctx.newLabel("dutc_ypos");
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
        const dL3 = this.ctx.newLabel("dutc_mp");
        const dL4 = this.ctx.newLabel("dutc_mpd");
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
        this.vm.fmovToInt(VReg.RET, 0); // RET = 裸 float64 毫秒数值(number)
    },

    emitNullishGuardToLabel(reg, label) {
        const vm = this.vm;
        vm.cmpImm(reg, 0);
        vm.jeq(label);
        vm.mov(VReg.V1, reg);
        vm.shrImm(VReg.V1, VReg.V1, 48);
        vm.cmpImm(VReg.V1, 0x7FFA); // null
        vm.jeq(label);
        vm.cmpImm(VReg.V1, 0x7FFB); // undefined
        vm.jeq(label);
    },

    emitValidateCallableInS0(message = "not a function") {
        const vm = this.vm;
        // [footprint] 合并到运行时 _validate_callable(in/out S0)。两个调用点(方法/闭包调用)
        // 消息均为 "not a function",helper 内硬编码。极高频(数万站点)——每站省 ~30 insn。
        if (message === "not a function") {
            vm.call("_validate_callable");
            return;
        }
        const rawCandidateLabel = this.ctx.newLabel("callable_raw_candidate");
        const doneLabel = this.ctx.newLabel("callable_done");
        const nonCallableLabel = this.ctx.newLabel("callable_type_error");

        // x64: V1==A3(RCX)、V2==A2(RDX)。本函数在实参已装入 A0..A5 之后执行，
        // 用 V1/V2 做暂存会冲掉第3/4实参（或缺参填的 undefined）。x64 上先压栈
        // 保护 A2/A3，doneLabel 处恢复；非法路径直接抛异常不返回，无需平衡。
        // arm64 上 V1/V2(X9/X10) 与 A 寄存器独立，不加指令，输出逐字节不变。
        const guardX64Args = vm.backend.name === "x64";
        if (guardX64Args) {
            vm.push(VReg.A2);
            vm.push(VReg.A3);
        }

        vm.cmpImm(VReg.S0, 0);
        vm.jeq(nonCallableLabel);

        vm.mov(VReg.V1, VReg.S0);
        vm.shrImm(VReg.V1, VReg.V1, 48);
        vm.cmpImm(VReg.V1, 0x7ff8);
        vm.jlt(rawCandidateLabel);

        // Tagged values are callable only when they carry the function tag.
        vm.cmpImm(VReg.V1, 0x7fff);
        vm.jne(nonCallableLabel);
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V2);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq(nonCallableLabel);
        vm.jmp(doneLabel);

        // Raw callable values are allowed only for heap closure objects.
        vm.label(rawCandidateLabel);
        vm.lea(VReg.V2, "_heap_base");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jlt(nonCallableLabel);
        vm.lea(VReg.V2, "_heap_ptr");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jge(nonCallableLabel);
        vm.jmp(doneLabel);

        vm.label(nonCallableLabel);
        this.emitThrowTypeError(message);

        vm.label(doneLabel);
        if (guardX64Args) {
            vm.pop(VReg.A3);
            vm.pop(VReg.A2);
        }
    },

    // 编译闭包调用 - 处理可能是闭包对象或普通函数指针的情况
    // funcReg: 存放函数指针或闭包对象的寄存器
    compileClosureCall(funcReg, args) {
        const vm = this.vm;

        // 保存函数指针/闭包对象到栈
        vm.push(funcReg);

        // 编译参数
        this.compileCallArguments(args);

        // 恢复函数指针/闭包对象到 S0 (callee-saved)
        vm.pop(VReg.S0);

        this.emitValidateCallableInS0("not a function");

        // 检查是否是 async 闭包（magic == 0xA51C）
        const notAsyncLabel = this.ctx.newLabel("not_async");
        const asyncCallLabel = this.ctx.newLabel("async_call");
        const notClosureLabel = this.ctx.newLabel("not_closure");
        const callLabel = this.ctx.newLabel("do_call");

        // 加载第一个 8 字节（magic）到 S1
        vm.load(VReg.S1, VReg.S0, 0);

        // 先检查是否是 async 闭包
        vm.movImm(VReg.S2, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.S1, VReg.S2);
        vm.jeq(asyncCallLabel);

        // 检查是否是普通闭包（magic == 0xC105）
        vm.movImm(VReg.S2, CLOSURE_MAGIC);
        vm.cmp(VReg.S1, VReg.S2);
        vm.jne(notClosureLabel);

        // 是普通闭包对象：加载真正的函数指针到 S1，S0 保持闭包对象指针
        vm.load(VReg.S1, VReg.S0, 8); // func_ptr
        // S0 作为闭包指针传给函数（通过 S0 寄存器）
        vm.jmp(callLabel);

        // async 闭包调用：创建协程 + 返回 Promise
        vm.label(asyncCallLabel);
        this.compileAsyncClosureCall(args);
        // 返回，RET = Promise
        const asyncDoneLabel = this.ctx.newLabel("async_done");
        vm.jmp(asyncDoneLabel);

        vm.label(notClosureLabel);
        // 不是闭包对象：S0 就是函数指针，复制到 S1
        vm.mov(VReg.S1, VReg.S0);
        vm.movImm(VReg.S0, 0); // 清空闭包指针

        vm.label(callLabel);
        // 通过 S1 间接调用（不能用 V6 因为它映射到 X6 = A5+1）
        vm.callIndirect(VReg.S1);

        vm.label(asyncDoneLabel);
    },

    // 编译方法调用 - 类似闭包调用但传递 this
    // funcReg: 存放函数指针或闭包对象的寄存器
    // thisReg: 存放 this 对象的寄存器
    compileMethodCall(funcReg, thisReg, args) {
        const vm = this.vm;

        // 保存 this 和函数指针到栈
        vm.push(thisReg);
        vm.push(funcReg);

        // 编译参数
        this.compileCallArguments(args);

        // 恢复函数指针和 this
        vm.pop(VReg.S0); // 函数指针/闭包
        vm.pop(VReg.S3); // this 对象

        this.emitValidateCallableInS0("not a function");

        // 通过 A5 寄存器传递 this（这是额外的隐藏参数）
        vm.mov(VReg.A5, VReg.S3);

        // 检查是否是闭包
        const notClosureLabel = this.ctx.newLabel("method_not_closure");
        const callLabel = this.ctx.newLabel("method_do_call");

        // 加载 magic
        vm.load(VReg.S1, VReg.S0, 0);
        vm.movImm(VReg.S2, CLOSURE_MAGIC);
        vm.cmp(VReg.S1, VReg.S2);
        vm.jne(notClosureLabel);

        // 是闭包：加载函数指针
        vm.load(VReg.S1, VReg.S0, 8);
        vm.jmp(callLabel);

        vm.label(notClosureLabel);
        // 不是闭包：S0 就是函数指针
        vm.mov(VReg.S1, VReg.S0);
        vm.movImm(VReg.S0, 0);

        vm.label(callLabel);
        vm.callIndirect(VReg.S1);
    },

    // [支柱②] 去虚拟化:推断接收者类名(this→当前类;成员链逐段查字段类型表;
    // 局部 v=new X()→跟踪表),推不出返回 null(落通用路径)。
    // _initAssembler/VM-backend 分支形态:this.asm 与 vm.backend 的类由本编译 target
    // 唯一确定(每次编译单形态)→ 按 arch 特判。
    _devirtReceiverClass(obj) {
        if (!this._devirtClasses) return null;
        if (obj.type === "ThisExpression") {
            return this.ctx.inClass ? this.ctx.className : null;
        }
        if (obj.type === "Identifier") {
            const vt = this.ctx.devirtVarTypes;
            return vt && vt[obj.name] ? vt[obj.name] : null;
        }
        if (obj.type === "MemberExpression" && !obj.computed && obj.property &&
            obj.property.type === "Identifier") {
            const ownerClass = this._devirtReceiverClass(obj.object);
            if (!ownerClass) return null;
            const fname = obj.property.name;
            // arch 特判:_initAssembler/VM._createBackend 分支形态——Compiler.asm 与
            // VirtualMachine.backend 的类由本编译 target 唯一确定(每次编译单形态)。
            if (ownerClass === "Compiler" && fname === "asm" && this.arch) {
                return { arm64: "ARM64Assembler", x64: "X64Assembler", wasm32: "Wasm32Assembler" }[this.arch] || null;
            }
            if (ownerClass === "VirtualMachine" && fname === "backend" && this.arch) {
                return { arm64: "ARM64Backend", x64: "X64Backend", wasm32: "WasmBackend" }[this.arch] || null;
            }
            const dv = this._devirtClasses[ownerClass];
            return dv && dv.fieldTypes[fname] ? dv.fieldTypes[fname] : null;
        }
        return null;
    },

    // 沿继承链解析实例方法(最派生优先,深度上限 20);返回方法标签或 null。
    _devirtResolve(className, methodName) {
        let cur = className;
        let depth = 0;
        while (cur && depth < 20) {
            const dv = this._devirtClasses[cur];
            if (!dv) return null;
            if (dv.methods[methodName]) return dv.methods[methodName];
            cur = dv.superName;
            depth = depth + 1;
        }
        return null;
    },

    // 推断类的已注册子类(递归)若覆写同名方法则 true——接收者可能是子类实例,
    // 直编基类标签会错调,拒去虚拟化。
    _devirtSubclassOverrides(className, methodName) {
        const dv = this._devirtClasses[className];
        if (!dv) return true;
        for (let i = 0; i < dv.subClasses.length; i++) {
            const sdv = this._devirtClasses[dv.subClasses[i]];
            // 预登记表方法值为 null(标签发射期才补)——须按键存在性判定,不能用真值
            if (sdv && sdv.methods[methodName] !== undefined) return true;
            if (sdv && this._devirtSubclassOverrides(dv.subClasses[i], methodName)) return true;
        }
        return false;
    },

    // 去虚拟化调用:接收者只求值一次入槽;args 按方法约定(A0-A4 参、A5=this、S0=0 普通函数,
    // 与 compileMethodCall 的 notClosure 分支一致)。成功返回 true,调用已发射。
    // 守卫语义:精确接收者(局部 v=new X()/字段 f=new X(),类即运行类)无需子类守卫;
    // this 接收者可能是子类实例,须证当前类无已注册覆写子类(预登记全图完备,可证)。
    _devirtualizeCall(obj, methodName, args) {
        // x64 门(2026-07-19):devirt 直编调用在 x64 自举产物里触发 SIGSEGV(macOS/linux-x64
        // 自编译全崩;arm64 双目标定点绿,x64 产物 repro 本身正确)。x64 自举本就有存量
        // 质量债(graceful "Compilation error: undefined"),先把 devirt 对 x64 降级为
        // 基线行为(不 crash),x64 devirt 并入 x64 质量债专项(见 plan.md 风险登记)。
        if (this.vm.arch === "x64") return false;
        const cls = this._devirtReceiverClass(obj);
        if (!cls || (this._devirtPoisoned && this._devirtPoisoned[cls])) return false;
        // 实例属性遮蔽:该方法名曾被函数值赋给实例属性 → 实例值可能遮蔽原型方法,拒去虚拟化
        if (this._devirtShadowed && this._devirtShadowed[methodName]) return false;
        if (obj.type === "ThisExpression" && this._devirtSubclassOverrides(cls, methodName)) return false;
        const label = this._devirtResolve(cls, methodName);
        if (!label) return false;
        const thisSlot = this.ctx.allocLocal(`__dv_this_${this.nextLabelId()}`);
        this.compileExpression(obj);
        this.vm.store(VReg.FP, thisSlot, VReg.RET);
        this.compileCallArguments(args);
        this.vm.load(VReg.A5, VReg.FP, thisSlot);
        this.vm.movImm(VReg.S0, 0);
        this.vm.call(label);
        return true;
    },

    // 编译 async 闭包调用
    // S0 = async 闭包对象
    // 参数已在 A0-A5 寄存器中
    compileAsyncClosureCall(args) {
        const vm = this.vm;

        // S0 = async 闭包对象(裸指针);实参由 compileClosureCall 前置的 compileCallArguments
        // 置入 A0-A4(A0=首参…A4=第 5 参)。closure_ptr 存 callee-saved S0,跨下方多次 call 稳。
        //
        // [修:传参 async 闭包调用崩] 旧实现用裸栈 push A0 + `load A1,SP,8` + `addImm SP,8`
        // 回收。但 push 在 arm64 是 `str,[sp,#-16]!`(16B 步进):`SP,8` 读到 16B 槽的填充
        // 半区(非实参)、`addImm SP,8` 只回收半个槽 → 泄 8B、SP 失衡 → 后续 call 崩。改存
        // 实参到 FP 局部槽,免裸栈偏移,架构无关、无失衡。
        //
        // [多实参透传] 协程实参约定(见 _coroutine_entry):A0=coro+64(首参)、A1-A4=
        // coro+112/120/128/136(CORO_ARG1-4)。_coroutine_create 仅存首参(A1→coro+64)并把
        // CORO_ARG1-4 清零;故次参 2-5 须在 create 后由本调用点回填(镜像生成器 stub 做法,
        // 但用 FP 槽而非裸栈)。最多 5 参(A0-A4;A5 留 this),超出丢弃(记偏差)。
        const argc = args ? Math.min(args.length, 5) : 0;
        // 先把全部实参(A0-A4)暂存到 FP 局部槽——_coroutine_create 会作为 call 冲掉 A 寄存器。
        const argSlots = [];
        for (let i = 0; i < argc; i++) {
            const slot = this.ctx.allocLocal(`__async_arg${i}_${this.nextLabelId()}`);
            vm.store(VReg.FP, slot, vm.getArgReg(i));
            argSlots.push(slot);
        }

        // 组装 _coroutine_create(A0=func_ptr, A1=首参|0, A2=closure_ptr)
        vm.load(VReg.A0, VReg.S0, 8); // func_ptr
        if (argc > 0) {
            vm.load(VReg.A1, VReg.FP, argSlots[0]); // 首参
        } else {
            vm.movImm(VReg.A1, 0);
        }
        vm.mov(VReg.A2, VReg.S0); // closure_ptr
        vm.call("_coroutine_create");
        vm.mov(VReg.S2, VReg.RET); // S2 = 协程

        // 回填次参 2-5 到 CORO_ARG1-4(coro+112/120/128/136)。V1 作 scratch(下无 call 打断)。
        const coroArgOff = [112, 120, 128, 136];
        for (let i = 1; i < argc; i++) {
            vm.load(VReg.V1, VReg.FP, argSlots[i]);
            vm.store(VReg.S2, coroArgOff[i - 1], VReg.V1);
        }

        // 创建 Promise
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S3, VReg.RET); // S3 = Promise

        // 关联协程和 Promise
        vm.store(VReg.S2, 88, VReg.S3); // coro.promise = Promise

        // 将协程加入调度队列
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_scheduler_spawn");

        // 返回 Promise
        vm.mov(VReg.RET, VReg.S3);
    },

    // [单次求值] 把接收者求值一次存合成槽,返回读槽的 Identifier AST。tag 派发各分支
    // (含调用点闭包捕获的 obj)共用此标识符后,副作用接收者(如 `ta.copyWithin(0,1).join()`
    // 的 copyWithin 调用)只执行一次——此前各分支重复求值,变异方法被执行两次
    // (copyWithin 二次拷贝、reverse 反转回滚)结果错误。
    _evalOnceToIdent(obj) {
        const name = `__once_${this.ctx.newLabel("r")}`;
        const off = this.ctx.allocLocal(name);
        this.compileExpression(obj);
        this.vm.store(VReg.FP, off, VReg.RET);
        return { type: "Identifier", name };
    },

    // 运行时按对象头类型字节分派内建 vs 用户方法。
    // 同名同 arity 的集合内建（Map.get/set/has/delete、Set.add）无法与同名用户方法静态区分，
    // 运行时判 obj 头 [0]&0xff==typeByte：命中走 compileBuiltin()，否则走通用用户方法调用。
    emitTagDispatchMethod(obj, prop, args, builtins) {
        // builtins: [{ type: <头字节>, compile: () => <编译该内建路径> }, ...]
        const eLbl = this.ctx.newLabel("tagd_end");
        const bLbls = builtins.map((_, i) => this.ctx.newLabel("tagd_b" + i));
        this.compileExpression(obj);
        this.vm.push(VReg.RET);            // 存 obj（用户方法路径要用）
        this.vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        this.vm.and(VReg.V0, VReg.RET, VReg.V1);  // 脱壳成裸指针
        this.vm.loadByte(VReg.V0, VReg.V0, 0);    // 头部类型字节
        for (let i = 0; i < builtins.length; i++) {
            if (builtins[i].typedArray) {
                // TypedArray 族头字节是范围 0x40-0x61(各元素类型),用 >= 0x40 判别
                // (其余内建类型字节 1/2/4/5/6/7/11 皆 < 0x40,无歧义)。放末位,精确匹配优先。
                // 但**字符串(0x7FFC)的内容首字节('A'=0x41 等)会冒充 TA 类型字节**——
                // 先验 tag,字符串不匹配 TA 分支(落后续分支/用户路径)。
                const notTaL = this.ctx.newLabel("tagd_nota" + i);
                this.vm.load(VReg.V1, VReg.SP, 0);
                this.vm.shrImm(VReg.V1, VReg.V1, 48);
                this.vm.cmpImm(VReg.V1, 0x7FFC);
                this.vm.jeq(notTaL);
                this.vm.cmpImm(VReg.V0, 0x40);
                this.vm.jge(bLbls[i]);
                this.vm.label(notTaL);
            } else {
                this.vm.cmpImm(VReg.V0, builtins[i].type);
                this.vm.jeq(bLbls[i]);
            }
        }
        // 非内建 → 用户方法(obj 在 RET 且栈顶)
        // [A3.5] 用户方法查找走 24B 形状 IC(自有/直接原型双模,getter 已融合);
        // RET 恢复为 obj(x64 上 RET 已被上方类型判别毁掉,统一从栈顶重载)。
        const pn = this.getMemberPropertyName ? this.getMemberPropertyName(prop) : (prop.name || prop.value);
        this.vm.load(VReg.RET, VReg.SP, 0);
        this.emitObjectGetIC(pn);
        this.vm.mov(VReg.V6, VReg.RET);
        this.vm.pop(VReg.V5);
        this.compileMethodCall(VReg.V6, VReg.V5, args);
        this.vm.jmp(eLbl);
        for (let i = 0; i < builtins.length; i++) {
            this.vm.label(bLbls[i]);
            this.vm.pop(VReg.V0); // 丢弃存的 obj（compile 会重新求值 obj）
            builtins[i].compile();
            this.vm.jmp(eLbl);
        }
        this.vm.label(eLbl);
    },

    // [ES2025] Promise.try(fn) —— 同步调 fn(),返回值包成 resolved promise、同步
    // throw 包成 rejected promise。为捕获 fn 的同步异常,在当前函数栈帧内联一个异常帧
    // (布局/压帧序列镜像 compileTryStatement),fn 经 _promise_invoke1 调用(arg=undefined);
    // 体内 throw 无本地 try → _throw_unwind 按链头恢复寄存器跳本帧 catchLabel。正常返回
    // → _Promise_resolve;catch → 读 _exception_value 后 _Promise_reject。
    compilePromiseTry(expr) {
        const vm = this.vm;
        const JS_UNDEFINED = 0x7ffb000000000000n;
        // [#38] 含内联 try 帧的函数放弃槽位晋升(否则 unwind 回滚 S 寄存器会读旧值)
        if (vm._recN >= 0) vm._flushRecordVerbatim();

        // 80B 异常帧(10 槽,取最低偏移基址),压入 tryFrames
        let excFrameOff = 0;
        for (let i = 0; i < 10; i++) {
            excFrameOff = this.ctx.allocLocal(this.ctx.newLabel("__ptryframe"));
        }
        if (!this.ctx.tryFrames) this.ctx.tryFrames = [];
        this.ctx.tryFrames.push(excFrameOff);

        const catchLabel = this.ctx.newLabel("ptry_catch");
        const endLabel = this.ctx.newLabel("ptry_end");
        const savedExceptionLabel = this.ctx.exceptionLabel;

        // 压帧:link=旧链头,快照 catchPC/SP/FP/S0-S5,链头指向本帧
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.FP, excFrameOff + 0, VReg.V1);
        vm.lea(VReg.V1, catchLabel);
        vm.store(VReg.FP, excFrameOff + 8, VReg.V1);
        vm.mov(VReg.V1, VReg.SP);
        vm.store(VReg.FP, excFrameOff + 16, VReg.V1);
        vm.store(VReg.FP, excFrameOff + 24, VReg.FP);
        vm.store(VReg.FP, excFrameOff + 32, VReg.S0);
        vm.store(VReg.FP, excFrameOff + 40, VReg.S1);
        vm.store(VReg.FP, excFrameOff + 48, VReg.S2);
        vm.store(VReg.FP, excFrameOff + 56, VReg.S3);
        vm.store(VReg.FP, excFrameOff + 64, VReg.S4);
        vm.mov(VReg.V1, VReg.S5); // x64 S5 是栈槽,经 mov 取出
        vm.store(VReg.FP, excFrameOff + 72, VReg.V1);
        vm.subImm(VReg.V1, VReg.FP, -excFrameOff);
        vm.store(VReg.V0, 0, VReg.V1);

        // fn 求值 + 调用期间,同步 throw 去 catch
        this.ctx.exceptionLabel = catchLabel;
        if (expr.arguments.length > 0) {
            this.compileExpression(expr.arguments[0]); // RET = fn(boxed)
        } else {
            vm.movImm64(VReg.RET, JS_UNDEFINED);
        }
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm64(VReg.A1, JS_UNDEFINED); // arg = undefined
        vm.call("_promise_invoke1"); // RET = fn() 返回值(抛错则 unwind 到 catchLabel)

        // 正常返回:弹帧后包 resolved
        this.ctx.exceptionLabel = savedExceptionLabel;
        vm.push(VReg.RET);
        this.emitExcCtxRestore(excFrameOff);
        vm.pop(VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_Promise_resolve");
        vm.jmp(endLabel);

        // 异常:弹帧,清 pending,读拒因,包 rejected
        vm.label(catchLabel);
        this.emitExcCtxRestore(excFrameOff);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_exception_value");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_Promise_reject");

        vm.label(endLabel);
        this.ctx.tryFrames.pop();
        this.ctx.exceptionLabel = savedExceptionLabel;
    },

    // 编译函数调用
    compileCallExpression(expr) {
        const callee = expr.callee;

        // Array.isArray(x) → _instanceof(x, 1)(内建 Array 标识;#15)
        if (callee.type === "MemberExpression" && callee.object &&
            callee.object.type === "Identifier" && callee.object.name === "Array" &&
            callee.property &&
            (callee.property.name || callee.property.value) === "isArray") {
            if (expr.arguments.length > 0) {
                this.compileExpression(expr.arguments[0]);
            } else {
                this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
            }
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.movImm(VReg.A1, 1);
            this.vm.call("_instanceof");
            return;
        }

        // TypedArray 静态方法 X.from(src[,fn]) / X.of(...):建普通数组(+可选 map)后
        // _typed_array_from(type, arr) 转成 typed。X 是构造函数名(Int32Array 等)。
        if (callee.type === "MemberExpression" && callee.object &&
            callee.object.type === "Identifier" && callee.property && !callee.computed) {
            const TA_CTOR = { Int8Array: 0x40, Int16Array: 0x41, Int32Array: 0x42,
                BigInt64Array: 0x43, Uint8Array: 0x50, Uint16Array: 0x51, Uint32Array: 0x52,
                BigUint64Array: 0x53, Uint8ClampedArray: 0x54, Float32Array: 0x60, Float64Array: 0x61 };
            const taType = TA_CTOR[callee.object.name];
            const sm = callee.property.name;
            if (taType !== undefined && (sm === "from" || sm === "of")) {
                if (sm === "from") {
                    // Array.from(src[,fn]) → 普通数组;再 _typed_array_from(type, arr)。
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: { type: "Identifier", name: "Array" },
                            property: { type: "Identifier", name: "from" }, computed: false },
                        arguments: expr.arguments,
                    });
                } else {
                    // X.of(a,b,c) → [a,b,c];再 _typed_array_from。
                    this.compileExpression({ type: "ArrayExpression", elements: expr.arguments });
                }
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.movImm(VReg.A0, taType);
                this.vm.call("_typed_array_from");
                return;
            }
        }

        // JSON.stringify/parse → 注入 shim 的导入绑定(compiler/index.js
        // readModuleSource 已为引用 JSON 的模块前置 import)。
        if (callee.type === "MemberExpression" && callee.object &&
            callee.object.type === "Identifier" && callee.object.name === "JSON" &&
            callee.property) {
            const jp = callee.property.name || callee.property.value;
            if (jp === "stringify" || jp === "parse") {
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "__JSON_" + jp },
                    arguments: expr.arguments,
                });
                return;
            }
        }

        // Number 格式化方法 → __number_shim(纯 JS)。改派为 __NUM_*(receiver, arg);
        // import 由 readModuleSource 注入、别名由 registerNumberShimAliases 登记。仅当
        // shim 已导入(hasFunction 命中别名)才改派,否则退化(避免误劫持同名用户方法)。
        if (callee.type === "MemberExpression" && callee.property && !callee.computed && callee.object) {
            const np = callee.property.name || callee.property.value;
            if ((np === "toExponential" || np === "toPrecision") &&
                expr.arguments.length <= 1 &&
                this.ctx.hasFunction && this.ctx.hasFunction("__NUM_" + np)) {
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "__NUM_" + np },
                    arguments: [callee.object].concat(expr.arguments),
                });
                return;
            }
            // toLocaleString 与 toExponential/toPrecision 不同,不是数字专属方法名
            // (Date/数组/字符串亦有),故**仅当接收者静态可判为数字**才改派到数字千分位
            // 格式化 __NUM_toLocaleString;未知/Date/数组接收者不动(不引回归)。仅无参
            // 形态(默认 locale);带 options 参的本地化不支持,退化不改派。
            // (注:此注释刻意不写成 "toLocaleString" 紧跟左括号,免命中 index.js 的注入探针。)
            if (np === "toLocaleString" && expr.arguments.length === 0 &&
                this.ctx.hasFunction && this.ctx.hasFunction("__NUM_toLocaleString") &&
                inferType(callee.object, this.ctx) === Type.NUMBER) {
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "__NUM_toLocaleString" },
                    arguments: [callee.object],
                });
                return;
            }
        }

        // Date 本地化方法 → __date_shim(纯 JS 格式化)。仅接收者静态 DATE 时改派(令
        // Number/Array/String 的同名 toLocaleString 不受影响);分量由 Date getter 静态派发
        // 提取后传入 shim。import 由 readModuleSource 注入、别名由 registerDateShimAliases 登记。
        if (callee.type === "MemberExpression" && callee.property && !callee.computed && callee.object) {
            const dm = callee.property.name || callee.property.value;
            const dateShimMethods = {
                toLocaleString: ["getFullYear", "getMonth", "getDate", "getHours", "getMinutes", "getSeconds"],
                toLocaleDateString: ["getFullYear", "getMonth", "getDate"],
                toLocaleTimeString: ["getHours", "getMinutes", "getSeconds"],
                // toUTCString/toGMTString/toDateString:UTC 分量(确定性);weekday 由 shim
                // 从 y/mo/d 算出,不单传(6 参寄存器上限,7 参会丢第 7 个)。
                toUTCString: ["getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCHours", "getUTCMinutes", "getUTCSeconds"],
                toGMTString: ["getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCHours", "getUTCMinutes", "getUTCSeconds"],
                toDateString: ["getUTCFullYear", "getUTCMonth", "getUTCDate"],
            };
            // toGMTString 与 toUTCString 同实现,复用同一 shim 函数
            const shimFn = dm === "toGMTString" ? "__DATE_toUTCString" : "__DATE_" + dm;
            if (dateShimMethods[dm] &&
                inferType(callee.object, this.ctx) === Type.DATE &&
                this.ctx.hasFunction && this.ctx.hasFunction(shimFn)) {
                const getter = (name) => ({
                    type: "CallExpression",
                    callee: {
                        type: "MemberExpression", computed: false,
                        object: callee.object,
                        property: { type: "Identifier", name: name },
                    },
                    arguments: [],
                });
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: shimFn },
                    arguments: dateShimMethods[dm].map(getter),
                });
                return;
            }
        }

        // eval(x) → route B 引擎:运行时编译执行(__eval_shim 的 import 由 readModuleSource
        // 按"源码含 eval("注入)。仅当 eval 未被用户局部/函数遮蔽时改派(否则尊重用户绑定)。
        // **直接 eval 词法捕获**:此调用点是直接 eval(callee 为裸标识符 eval;间接形
        // `(0,eval)(x)`/别名/成员形的 callee 非 Identifier "eval",天然走全局 __eval 路径)。
        // 把外层函数的局部名→FP 槽偏移序列化成 layoutStr,连同调用者 FP(__eval_frame_ptr())
        // 传给 __eval_direct → 片段 copy-in/copy-out 读写这些槽(见 engine/compile.js)。
        // 装箱(被真闭包捕获)/循环寄存器驻留(rawInt/fpAccum,槽可能陈旧)的变量不纳入捕获。
        // 无可捕获局部(如全局作用域)时 layoutStr 为空 → 退回 __eval(间接/全局语义)。
        if (callee.type === "Identifier" && callee.name === "eval" &&
            !(this.ctx.getLocal && this.ctx.getLocal("eval")) &&
            !(this.ctx.getFunction && this.ctx.getFunction("eval"))) {
            let layoutStr = "";
            if (expr.arguments.length === 1 && this.ctx.locals) {
                const parts = [];
                for (const key in this.ctx.locals) {
                    if (key.length >= 2 && key.charCodeAt(0) === 95 && key.charCodeAt(1) === 95) continue; // 跳过 __ 临时槽
                    const off = this.ctx.getLocal(key);
                    if (!off || typeof off !== "number") continue;
                    if (this.ctx.isRawIntVar && this.ctx.isRawIntVar(key)) continue; // 循环裸 int 驻留:槽可能陈旧
                    if (this.ctx.getFpAccum && this.ctx.getFpAccum(key) > 0) continue; // FP 累加器驻留:同上
                    // 装箱变量(被真闭包捕获,或含 eval 帧模型升级——见 analyzeDirectEvalBoxedVars):
                    // 调用者槽存 box 指针。片段 copy-in **复用同一 box**(不新建值快照)→ eval 内逃逸
                    // 闭包的写、以及调用者 eval 后续对该变量的写,皆经共享 box 联动(逃逸捕获正确)。标 `:b`。
                    const boxed = this.ctx.boxedVars && this.ctx.boxedVars.has(key);
                    parts.push(key + ":" + off + (boxed ? ":b" : ""));
                }
                layoutStr = parts.join(",");
            }
            if (layoutStr.length > 0) {
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "__eval_direct" },
                    arguments: [
                        expr.arguments[0],
                        { type: "CallExpression", callee: { type: "Identifier", name: "__eval_frame_ptr" }, arguments: [] },
                        { type: "Literal", value: layoutStr },
                    ],
                });
                return;
            }
            this.compileExpression({
                type: "CallExpression",
                callee: { type: "Identifier", name: "__eval" },
                arguments: expr.arguments,
            });
            return;
        }

        // RegExp shim 分派(批次D):接收者/实参静态类型为 REGEXP 时改派纯 JS 引擎
        //   re.test(s) → __RE_test(re, s)      re.exec(s) → __RE_exec(re, s)
        //   str.match(re) → __RE_match(str, re) str.replace(re, r) → __RE_replace(str, re, r)
        // (__regexp_shim 的 import 由 readModuleSource 按"源码含正则字面量/RegExp 构造"
        // 注入,与此分派条件一致:REGEXP 类型只能来自正则字面量或 RegExp 构造。)
        if (callee.type === "MemberExpression" && callee.property && !callee.computed) {
            const rn = callee.property.name || callee.property.value;
            if (rn === "test" || rn === "exec") {
                if (inferType(callee.object, this.ctx) === Type.REGEXP) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__RE_" + rn },
                        arguments: [
                            callee.object,
                            expr.arguments.length > 0 ? expr.arguments[0] : { type: "Literal", value: "" },
                        ],
                    });
                    return;
                }
                // [bug4] 接收者静态类型未知(正则作为函数参数/成员链传入,type 推断丢失)
                // 但本模块已注入 regexp shim:运行时判 __isRegExp。真 → __RE_test/exec 引擎;
                // 否则回落通用对象方法派发(用户对象自定义 test/exec 保持原语义)。接收者只
                // 求值一次(存临时槽),两分支复用之——避免副作用重放。
                if (this.ctx.hasFunction && this.ctx.hasFunction("__RE_" + rn)) {
                    const reArg = expr.arguments.length > 0 ? expr.arguments[0] : { type: "Literal", value: "" };
                    const tmpName = `__re_recv_${this.nextLabelId()}`;
                    const tmpOff = this.ctx.allocLocal(tmpName);
                    this.compileExpression(callee.object);
                    this.vm.store(VReg.FP, tmpOff, VReg.RET);
                    const tmpId = { type: "Identifier", name: tmpName };
                    const reDone = this.ctx.newLabel("re_disp_done");
                    const reGeneric = this.ctx.newLabel("re_disp_generic");
                    this.vm.load(VReg.A0, VReg.FP, tmpOff);
                    this.emitBoxedStringKey("__isRegExp", VReg.A1);
                    this.vm.call("_object_get");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_boolean");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jeq(reGeneric);
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__RE_" + rn },
                        arguments: [tmpId, reArg],
                    });
                    this.vm.jmp(reDone);
                    this.vm.label(reGeneric);
                    this.vm.load(VReg.A0, VReg.FP, tmpOff);
                    this.emitBoxedStringKey(rn, VReg.A1);
                    this.vm.call("_object_get");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.FP, tmpOff);
                    this.vm.call("_maybe_getter");
                    this.vm.mov(VReg.V6, VReg.RET);
                    this.vm.load(VReg.V5, VReg.FP, tmpOff);
                    this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
                    this.vm.label(reDone);
                    return;
                }
            } else if (rn === "toString") {
                // re.toString() → __RE_toString(re):"/source/flags"。此前落通用对象
                // toString → "[object Object]"。仅接收者静态 REGEXP 时介入。
                if (inferType(callee.object, this.ctx) === Type.REGEXP) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__RE_toString" },
                        arguments: [callee.object],
                    });
                    return;
                }
            } else if ((rn === "match" || rn === "matchAll" || rn === "replace" || rn === "replaceAll" || rn === "split" || rn === "search") && expr.arguments.length >= 1 &&
                inferType(expr.arguments[0], this.ctx) === Type.REGEXP) {
                if (rn === "search") {
                    // str.search(/re/) → __RE_search(str, re):首个匹配的下标(无 → -1)。
                    // 此前无分派 → 把正则当串成员派发崩。
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__RE_search" },
                        arguments: [callee.object, expr.arguments[0]],
                    });
                    return;
                }
                if (rn === "split") {
                    // str.split(/re/[, limit]) → __RE_split(str, re, limit)。此前落字符串
                    // split,把正则对象当分隔串 getStrContent 读垃圾 → 退化逐字符切。
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__RE_split" },
                        arguments: expr.arguments.length >= 2
                            ? [callee.object, expr.arguments[0], expr.arguments[1]]
                            : [callee.object, expr.arguments[0]],
                    });
                    return;
                }
                if (rn === "match") {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__RE_match" },
                        arguments: [callee.object, expr.arguments[0]],
                    });
                    return;
                }
                if (rn === "matchAll") {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__RE_matchAll" },
                        arguments: [callee.object, expr.arguments[0]],
                    });
                    return;
                }
                if (expr.arguments.length >= 2) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "Identifier", name: "__RE_replace" },
                        arguments: [callee.object, expr.arguments[0], expr.arguments[1]],
                    });
                    return;
                }
            }
        }

        // Object.prototype.hasOwnProperty.call(obj, key) → _object_has(obj, key)
        // (lexer lookupIdent 用这个模式判关键字表)
        if (callee.type === "MemberExpression" && callee.property &&
            (callee.property.name === "call" || callee.property.value === "call") &&
            callee.object && callee.object.type === "MemberExpression") {
            const inner = callee.object; // X.hasOwnProperty
            const innerProp = inner.property && (inner.property.name || inner.property.value);
            if (innerProp === "hasOwnProperty" && expr.arguments.length >= 2) {
                this.compileExpression(expr.arguments[0]); // obj
                this.vm.push(VReg.RET);
                this.compileExpression(expr.arguments[1]); // key
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.pop(VReg.A0);
                this.vm.call("_object_has");
                // _object_has 返回 0/1,转规范 JS bool(lea _js_true/_js_false + load,
                // 同字面量)。此前用立即数 0x7FF9…01/02 是非规范布尔:if/&& 的 ToBoolean
                // 容忍(编译器 lexer 靠此侥幸对),但 !/===/ToNumber 不认。统一修。
                const hf = this.ctx.newLabel("hop_false");
                const he = this.ctx.newLabel("hop_end");
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jeq(hf);
                this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                this.vm.jmp(he);
                this.vm.label(hf);
                this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
                this.vm.label(he);
                return;
            }
        }

        // Object.prototype.toString.call(x) → _object_proto_toString(x)("[object Tag]" 品牌串,
        // 含 Symbol.toStringTag)。识别 X.toString.call 且 X 为 Object.prototype。
        if (callee.type === "MemberExpression" && callee.property &&
            (callee.property.name === "call" || callee.property.value === "call") &&
            callee.object && callee.object.type === "MemberExpression" &&
            callee.object.property && (callee.object.property.name === "toString") &&
            callee.object.object && callee.object.object.type === "MemberExpression" &&
            callee.object.object.property && callee.object.object.property.name === "prototype" &&
            callee.object.object.object && callee.object.object.object.type === "Identifier" &&
            callee.object.object.object.name === "Object") {
            if (expr.arguments.length >= 1) {
                this.compileExpression(expr.arguments[0]);
                this.vm.mov(VReg.A0, VReg.RET);
            } else {
                this.vm.movImm64(VReg.A0, 0x7ffb000000000000n); // undefined
            }
            this.vm.call("_object_proto_toString");
            return;
        }

        // obj.hasOwnProperty(key) 直接方法调用 → _object_has + 规范布尔。
        // asm.js 对象无 Object.prototype 链,直接调会在普通成员派发里属性 miss(→0)
        // 再把 0 当函数调用 → 段错误(missbug 崩点)。与上面 .call 形式同构拦截。
        if (callee.type === "MemberExpression" && !callee.computed && callee.property &&
            callee.property.name === "hasOwnProperty" && expr.arguments.length >= 1) {
            this.compileExpression(callee.object); // obj
            this.vm.push(VReg.RET);
            this.compileExpression(expr.arguments[0]); // key
            this.vm.mov(VReg.A1, VReg.RET);
            this.vm.pop(VReg.A0);
            this.vm.call("_object_has");
            // 规范布尔:lea _js_true/_js_false + load(与字面量同码)。此前用立即数
            // 0x7FF9…01/02 是**非规范**布尔值,typeof 判 boolean 但 !/===/ToNumber 全不认
            // (0x7FF9…02 被当真值、+0 得 1)——运行时算子只识 _js_false 存储的位型。
            const hf2 = this.ctx.newLabel("hop2_false");
            const he2 = this.ctx.newLabel("hop2_end");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(hf2);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
            this.vm.jmp(he2);
            this.vm.label(hf2);
            this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
            this.vm.label(he2);
            return;
        }

        // obj.propertyIsEnumerable(key) → _object_propertyIsEnumerable(查 enumerable 位,已存在)。
        // obj.isPrototypeOf(x) → _is_prototype_of(x 原型链是否含 obj)。二者均返规范布尔。
        if (callee.type === "MemberExpression" && !callee.computed && callee.property &&
            (callee.property.name === "propertyIsEnumerable" || callee.property.name === "isPrototypeOf") &&
            expr.arguments.length >= 1) {
            const rmName = callee.property.name;
            this.compileExpression(callee.object); // 接收者(propIsEnum:obj;isProtoOf:proto)
            this.vm.push(VReg.RET);
            this.compileExpression(expr.arguments[0]); // 参(key / x)
            this.vm.mov(VReg.A1, VReg.RET);
            this.vm.pop(VReg.A0);
            this.vm.call(rmName === "isPrototypeOf" ? "_is_prototype_of" : "_object_propertyIsEnumerable");
            return;
        }

        // super(...args) : 调用父类构造函数，this = 当前 __this
        if (callee.type === "SuperExpression") {
            const superName = this.ctx.superClass;
            const thisOffset = this.ctx.getLocal("__this");
            // 父类是内建 Error 族:无类信息对象/无可调构造函数(new Error 全内联),
            // 直接 callIndirect 到 0 会 SIGSEGV。super(msg) 内联为在 this 上落
            // message/__asmjs_err/name(仿 expressions.js 的 new Error 语义);
            // 子类构造体后续 this.name= 可覆盖。AggregateError(errors, msg):
            // errors=arg0、message=arg1。
            const ERR_TYPES = ["Error", "TypeError", "RangeError", "SyntaxError",
                "ReferenceError", "URIError", "EvalError", "AggregateError"];
            if (superName && thisOffset && ERR_TYPES.indexOf(superName) >= 0) {
                const isAgg = superName === "AggregateError";
                const msgIdx = isAgg ? 1 : 0;
                // errors(仅 AggregateError):this.errors = arg0
                if (isAgg && expr.arguments.length > 0 && expr.arguments[0]) {
                    const eSlot = this.ctx.allocLocal(`__superr_e_${this.nextLabelId()}`);
                    this.compileExpression(expr.arguments[0]);
                    this.vm.store(VReg.FP, eSlot, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, thisOffset);
                    this.emitBoxedStringKey("errors", VReg.A1);
                    this.vm.load(VReg.A2, VReg.FP, eSlot);
                    this.vm.call("_object_set");
                }
                // message = 指定参数(无则空串)
                if (expr.arguments.length > msgIdx && expr.arguments[msgIdx]) {
                    this.compileExpression(expr.arguments[msgIdx]);
                } else {
                    this.vm.lea(VReg.RET, this.asm.addString(""));
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                }
                const msgSlot = this.ctx.allocLocal(`__superr_m_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, msgSlot, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.emitBoxedStringKey("message", VReg.A1);
                this.vm.load(VReg.A2, VReg.FP, msgSlot);
                this.vm.call("_object_set");
                // __asmjs_err = true(instanceof Error 族依赖此标记)
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.emitBoxedStringKey("__asmjs_err", VReg.A1);
                this.vm.movImm64(VReg.A2, 0x7ff9000000000001n); // was lea+load _js const
                this.vm.call("_object_set");
                // name = <ErrorType>(默认;子类构造体 this.name= 覆盖)
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.emitBoxedStringKey("name", VReg.A1);
                this.vm.lea(VReg.A2, this.asm.addString(superName));
                this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                this.vm.or(VReg.A2, VReg.A2, VReg.V1);
                this.vm.call("_object_set");
                // cause:options 参(msgIdx+1;AggregateError 为第 3 参)的 cause 字段
                // (ES2022 super(msg, {cause}))。仅当 options.hasOwnProperty("cause") 才落。
                const optIdx = msgIdx + 1;
                if (expr.arguments.length > optIdx && expr.arguments[optIdx]) {
                    const optSlot = this.ctx.allocLocal(`__superr_o_${this.nextLabelId()}`);
                    this.compileExpression(expr.arguments[optIdx]);
                    this.vm.store(VReg.FP, optSlot, VReg.RET);
                    const noCause = this.ctx.newLabel("superr_nocause");
                    this.vm.load(VReg.A0, VReg.FP, optSlot);
                    this.emitBoxedStringKey("cause", VReg.A1);
                    this.vm.call("_object_has");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jeq(noCause);
                    this.vm.load(VReg.A0, VReg.FP, optSlot);
                    this.emitBoxedStringKey("cause", VReg.A1);
                    this.vm.call("_object_get");
                    const cvSlot = this.ctx.allocLocal(`__superr_cv_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, cvSlot, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, thisOffset);
                    this.emitBoxedStringKey("cause", VReg.A1);
                    this.vm.load(VReg.A2, VReg.FP, cvSlot);
                    this.vm.call("_object_set");
                    this.vm.label(noCause);
                }
                return;
            }
            // 加载父类信息对象 → S1（本模块声明用 classinfo 槽；导入的父类
            // 当标识符编译，拿到 namespace 中的类信息对象，再去 tag；表达式父类走
            // superInfoLabel 全局）
            this.emitLoadSuperClassInfo(VReg.S1);
            this.vm.load(VReg.S2, VReg.S1, 32); // props_ptr
            this.vm.load(VReg.S2, VReg.S2, 8);  // 父 ctor 地址 = props[0].val
            // 参数编入 A1-A5，A0 = this
            if (expr.arguments.some((a) => a && a.type === "SpreadElement")) {
                // super(...args)：展开实参。compileCtorArgsSpread 保存/恢复 S0-S2,
                // S2(父 ctor 地址)被保住,返回后 A1-A5 已装好。
                this.compileCtorArgsSpread(expr.arguments);
            } else {
                const ctorArgRegs = [VReg.A1, VReg.A2, VReg.A3, VReg.A4, VReg.A5];
                const n = Math.min(expr.arguments.length, ctorArgRegs.length);
                this.vm.push(VReg.S2);
                for (let i = 0; i < n; i++) {
                    this.compileExpression(expr.arguments[i]);
                    this.vm.push(VReg.RET);
                }
                for (let i = n - 1; i >= 0; i--) this.vm.pop(ctorArgRegs[i]);
                this.vm.pop(VReg.S2);
                this.emitSetCallArgc(n); // [argc ABI]
            }
            if (thisOffset) this.vm.load(VReg.A0, VReg.FP, thisOffset);
            this.vm.callIndirect(VReg.S2);
            return;
        }

        // super.method(...args) : 调用父类方法，this = 当前 __this。
        // 实例方法:方法在父类 prototype;**静态方法**:方法直接在父类对象上(静态成员键无
        // "static_" 前缀,与实例键同名但存于类对象),故 super.m() 从父类对象本身取。
        if (callee.type === "MemberExpression" && callee.object &&
            callee.object.type === "SuperExpression") {
            const thisOffset = this.ctx.getLocal("__this");
            const methodName = this.getMemberPropertyName(callee.property);
            this.emitLoadSuperClassInfo(VReg.S1);
            if (!this.ctx.inStaticMethod) {
                this.vm.load(VReg.S1, VReg.S1, 32); // props_ptr
                this.vm.load(VReg.S1, VReg.S1, 24); // 父 prototype 对象 (raw) = props[1].val
            } // 静态:S1 已是父类对象(raw),静态方法直接定义其上
            // 从 prototype 取方法（装箱后调 _object_get）
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.A0, VReg.S1, VReg.V1);
            this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
            this.vm.or(VReg.A0, VReg.A0, VReg.V1);
            this.emitBoxedStringKey(methodName, VReg.A1);
            this.vm.call("_object_get");
            this.vm.mov(VReg.V6, VReg.RET);
            if (thisOffset) this.vm.load(VReg.V5, VReg.FP, thisOffset);
            else this.vm.movImm(VReg.V5, 0);
            this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
            return;
        }

        // 可选调用 f?.() / obj.m?.() : 先求被调值，null|undefined 则短路 undefined。
        // 注意 callee 可能是 MemberExpression（obj.m?.()）——被调值是该成员的值，
        // 求值后统一按闭包调用（this 绑定简化：可选调用主要用于 x?.() 形态）。
        if (expr.optional) {
            const skipLabel = this.ctx.newLabel("optcall_skip");
            const endLabel = this.ctx.newLabel("optcall_end");
            this.compileExpression(callee);
            this.emitNullishGuardToLabel(VReg.RET, skipLabel);
            this.vm.mov(VReg.V6, VReg.RET);
            this.compileClosureCall(VReg.V6, expr.arguments);
            this.vm.jmp(endLabel);
            this.vm.label(skipLabel);
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
            this.vm.label(endLabel);
            return;
        }

        // 可选方法调用 obj?.m(args):callee 是可选成员访问(callee.optional)。obj 为
        // null/undefined → 整调用短路 undefined(方法/实参不求值);否则按普通方法调用。
        // 此前落普通派发 → 对 null 求 obj.m 再调用崩(bar?.baz() 崩溃根因)。
        // 非空分支去掉 optional 标记后重新分派——obj 会被重新求值(标识符/简单成员
        // 无副作用;副作用对象表达式双求值,记偏差)。
        if (callee.type === "MemberExpression" && callee.optional) {
            const skipLabel = this.ctx.newLabel("optmcall_skip");
            const endLabel = this.ctx.newLabel("optmcall_end");
            this.compileExpression(callee.object);
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(skipLabel);
            this.vm.mov(VReg.V1, VReg.RET);
            this.vm.shrImm(VReg.V1, VReg.V1, 48);
            this.vm.cmpImm(VReg.V1, 0x7FFA); // null
            this.vm.jeq(skipLabel);
            this.vm.cmpImm(VReg.V1, 0x7FFB); // undefined
            this.vm.jeq(skipLabel);
            callee.optional = false;
            this.compileCallExpression(expr); // 非可选路径重新分派(类型感知方法派发)
            callee.optional = true;           // 复原(AST 可能复用)
            this.vm.jmp(endLabel);
            this.vm.label(skipLabel);
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
            this.vm.label(endLabel);
            return;
        }

        // 内置函数处理
        if (callee.type === "Identifier") {
            // class 不能不带 new 调用:`C()` 应 throw TypeError(此前把类构造器当普通函数
            // 跑,this=undefined/垃圾 → SIGSEGV/SIGABRT)。仅拦用户 ClassDeclaration。
            const _calleeFn = this.ctx.getFunction && this.ctx.getFunction(callee.name);
            if (_calleeFn && _calleeFn.type === "ClassDeclaration") {
                this.emitThrowTypeError("Class constructor cannot be invoked without 'new'");
                return;
            }
            // 内建集合/Promise 构造器 Map/Set/WeakMap/WeakSet/Promise 必须带 new(node:
            // Map()、Promise() 无 new 抛 TypeError)。排除用户局部变量/函数遮蔽同名(极罕见但合法)。
            if (callee.name === "Map" || callee.name === "Set" ||
                callee.name === "WeakMap" || callee.name === "WeakSet" ||
                callee.name === "Promise") {
                const _shadow = _calleeFn ||
                    (this.ctx.getLocal && this.ctx.getLocal(callee.name));
                if (!_shadow) {
                    this.emitThrowTypeError("Constructor " + callee.name + " requires 'new'");
                    return;
                }
            }
            // Array(...) 无 new 与 new Array(...) 同义(ES 规范)。此前 Array(5) 落通用路径
            // 得数字 5(Array 标识符=1 当函数调)。排除用户遮蔽(局部/函数同名)。
            if (callee.name === "Array" &&
                !(this.ctx.getLocal && this.ctx.getLocal("Array")) &&
                !(this.ctx.getFunction && this.ctx.getFunction("Array"))) {
                this.compileNewExpression({
                    type: "NewExpression",
                    callee: { type: "Identifier", name: "Array" },
                    arguments: expr.arguments,
                });
                return;
            }

            // 动态 import(source)。AOT 子集:specifier 编译期可静态解析(字面量/静态
            // 拼接/静态模板/const 绑定字面量)→ resolveImports 已把目标模块入图并在此
            // CallExpression 节点标注 _dynImportPath。desugar 成 resolved Promise 包装
            // 该模块的 namespace(_get_module_export(idx,"*")),与静态 import 共用模块表。
            // 未解析(运行时 specifier=L2 引擎库,或模块不存在)→ rejected Promise。
            if (callee.name === "import") {
                const dynPath = expr._dynImportPath;
                const modIdx = dynPath ? this.findModuleIndexByPath(dynPath) : -1;
                if (dynPath && modIdx >= 0) {
                    // resolved Promise(namespace)
                    this.vm.movImm(VReg.A0, 0);
                    this.vm.call("_promise_new");   // RET = pending promise
                    this.vm.push(VReg.RET);
                    this.vm.push(VReg.RET);          // 存两份(一份出参、一份 A0)
                    this.vm.movImm(VReg.A0, modIdx);
                    this.vm.lea(VReg.A1, this.asm.addString("*"));
                    this.vm.call("_get_module_export"); // RET = namespace 对象
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.pop(VReg.A0);            // A0 = promise
                    this.vm.call("_promise_resolve");
                    this.vm.pop(VReg.RET);           // RET = promise
                } else {
                    // rejected Promise。reason:模块不存在 → specifier 字符串(对齐 node
                    // fixture 简化预期);运行时 specifier(L2 引擎库)→ TypeError 说明。
                    const rejMsg = expr._dynImportSpec != null
                        ? String(expr._dynImportSpec)
                        : "TypeError: dynamic import specifier must be statically resolvable (runtime specifier is L2 engine-lib)";
                    this.vm.movImm(VReg.A0, 0);
                    this.vm.call("_promise_new");
                    this.vm.push(VReg.RET);
                    this.vm.push(VReg.RET);
                    this.vm.lea(VReg.A1, this.asm.addString(rejMsg));
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.A1, VReg.A1, VReg.V1); // 装箱字符串
                    this.vm.pop(VReg.A0);
                    this.vm.call("_promise_reject");
                    this.vm.pop(VReg.RET);
                }
                return;
            }

            // [CJS AOT 子集] require(静态 specifier)。resolveImports/_scanRequires 已
            // 把目标入模块图并在此节点标注 _requirePath/_requireKind。desugar 成
            // _get_module_export(idx, kind):本地 CJS 取 "default"(= module.exports),
            // 内建/ESM 取 "*"(namespace)。未解析(运行时 specifier/缺失)→ undefined。
            if (callee.name === "require" && expr._requireCall) {
                const rp = expr._requirePath;
                const modIdx = rp ? this.findModuleIndexByPath(rp) : -1;
                if (rp && modIdx >= 0) {
                    // [CJS cyclic require] 目标是环内本地 CJS 模块 → 惰性初始化路径:
                    // 首次调用跑其 __cjs_init_m<idx> 体、发布(部分)导出;环内再入拿到
                    // 部分对象;错误被缓存并在重 require 时重抛。见 process.js。
                    const targetMeta = this.getModuleMeta(this._moduleOrder[modIdx]);
                    if (targetMeta && targetMeta.lazyCjs) {
                        this.vm.movImm(VReg.A0, modIdx);
                        this.vm.lea(VReg.A1, "_user___cjs_init_m" + modIdx);
                        this.vm.call("_cjs_require_lazy");
                        return;
                    }
                    this.vm.movImm(VReg.A0, modIdx);
                    const key = expr._requireKind === "default" ? "default" : "*";
                    this.vm.lea(VReg.A1, this.asm.addString(key));
                    this.vm.call("_get_module_export");
                } else {
                    this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined
                }
                return;
            }

            // [CJS cyclic require] 惰性初始化辅助内建(仅由 registerCjsInitFunction
            // 合成注入)。__cjs_publish(idx, val):发布 module.exports 到 _cjs_exports[idx]。
            // __cjs_set_error(idx, val):缓存初始化错误。idx 恒为数字字面量。
            if ((callee.name === "__cjs_publish" || callee.name === "__cjs_set_error") &&
                expr.arguments.length === 2) {
                const idxLit = expr.arguments[0];
                this.compileExpression(expr.arguments[1]); // val -> RET
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.movImm(VReg.A0, idxLit.value | 0);
                this.vm.call(callee.name === "__cjs_publish" ? "_cjs_publish" : "_cjs_set_error");
                return;
            }

            if (callee.name === "print") {
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_print_value");
                }
                return;
            }

            // [引擎库 P0 smoke] __engine_smoke() -> 42(进程内执行 mmap 码验证)。
            // 结果裸 int → float64 位 JS number 供 console.log。
            if (callee.name === "__engine_smoke") {
                this.vm.call("_engine_smoke_exec");
                this.intToFloat64Bits(VReg.RET);
                return;
            }

            // [引擎库 P0.1] __engine_exec(uint8array) -> 执行结果(裸 int → JS number)。
            // arr 是机器码字节 Uint8Array:unbox→block,codeLen=block@8、codePtr=**deref
            // data_ptr@16**。[Design A] TypedArray 布局 [type@0,length@8,data_ptr@16,buffer@24,
            // data@32]——数据非内联于 header+16,须解引用 data_ptr@16 取真数据址(内联=self+32、
            // buffer 视图=buffer.data_ptr+off)。旧 `addImm ...,16` 取到 data_ptr **字段本身**
            // (一个指针)当代码址 → memcpy 复制指针/头字节当机器码 → 执行空/垃圾页 SIGILL。
            if (callee.name === "__engine_exec" && expr.arguments.length > 0) {
                this.compileExpression(expr.arguments[0]);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1); // V0 = block ptr
                this.vm.load(VReg.A1, VReg.V0, 8);        // A1 = length(codeLen)
                this.vm.load(VReg.A0, VReg.V0, 16);       // A0 = 内容(deref data_ptr@16)
                this.vm.call("_engine_exec");
                this.intToFloat64Bits(VReg.RET);
                return;
            }

            // [引擎库 P1] __engine_exec_reloc(fragArr, relocArr) -> 原始 JSValue。
            // fragArr=片段机器码,relocArr=reloc 字节(每条 8B:slotOff 4B LE + symId 4B LE)。
            // 运行时用宿主符号地址填 fragment 的 trampoline addr_slot 后执行(解锁运行时调用)。
            if (callee.name === "__engine_exec_reloc" && expr.arguments.length >= 2) {
                const MASK = 0x0000ffffffffffffn;
                // 先算 relocArr(第二参)→ S 无法用,借栈:先编译 frag、再 reloc
                this.compileExpression(expr.arguments[0]); // fragArr
                this.vm.movImm64(VReg.V1, MASK);
                this.vm.and(VReg.V0, VReg.RET, VReg.V1);
                this.vm.load(VReg.A1, VReg.V0, 8);       // A1 = fragLen
                this.vm.load(VReg.A0, VReg.V0, 16);      // A0 = fragPtr(deref data_ptr@16;见 __engine_exec 注)
                this.vm.push(VReg.A0); this.vm.push(VReg.A1);
                this.compileExpression(expr.arguments[1]); // relocArr
                this.vm.movImm64(VReg.V1, MASK);
                this.vm.and(VReg.V0, VReg.RET, VReg.V1);
                this.vm.load(VReg.A3, VReg.V0, 8);       // A3 = relocByteLen
                this.vm.load(VReg.A2, VReg.V0, 16);      // A2 = relocPtr(deref data_ptr@16)
                this.vm.pop(VReg.A1);                     // A1 = fragLen
                this.vm.pop(VReg.A0);                     // A0 = fragPtr
                this.vm.call("_engine_reloc_exec");
                return;
            }

            // [引擎库 · 直接 eval 词法捕获] __engine_exec_reloc_fp(fragArr, relocArr, fp)。
            // 同 __engine_exec_reloc,额外把 fp(直接 eval 所在函数的运行时 FP,原始指针值)
            // 传入 A4——运行时 _engine_reloc_exec_fp 据此在跳入片段前置 A0=callerFP,片段
            // 入口 copy-in / 出口 copy-out 外层局部(见 engine/compile.js)。fp 先算并 push
            // 保活(compileExpression 会冲刷 A 寄存器),末尾 pop 入 A4。
            if (callee.name === "__engine_exec_reloc_fp" && expr.arguments.length >= 3) {
                const MASK = 0x0000ffffffffffffn;
                this.compileExpression(expr.arguments[2]); // fp(原始指针,不装箱)
                this.vm.push(VReg.RET);                     // 保活 fp
                this.compileExpression(expr.arguments[0]); // fragArr
                this.vm.movImm64(VReg.V1, MASK);
                this.vm.and(VReg.V0, VReg.RET, VReg.V1);
                this.vm.load(VReg.A1, VReg.V0, 8);       // A1 = fragLen
                this.vm.load(VReg.A0, VReg.V0, 16);      // A0 = fragPtr(deref data_ptr@16;见 __engine_exec 注)
                this.vm.push(VReg.A0); this.vm.push(VReg.A1);
                this.compileExpression(expr.arguments[1]); // relocArr
                this.vm.movImm64(VReg.V1, MASK);
                this.vm.and(VReg.V0, VReg.RET, VReg.V1);
                this.vm.load(VReg.A3, VReg.V0, 8);       // A3 = relocByteLen
                this.vm.load(VReg.A2, VReg.V0, 16);      // A2 = relocPtr(deref data_ptr@16)
                this.vm.pop(VReg.A1);                     // A1 = fragLen
                this.vm.pop(VReg.A0);                     // A0 = fragPtr
                this.vm.pop(VReg.A4);                     // A4 = fp(callerFP)
                this.vm.call("_engine_reloc_exec_fp");
                return;
            }

            // [引擎库 · 直接 eval 词法捕获] __eval_frame_ptr():内联发射 `mov RET, FP`——取
            // **当前函数**(直接 eval 所在函数)的运行时 FP。内联(非真调用)故 FP 即调用者帧。
            // 由 compileCallExpression 的直接 eval 分派点合成为实参传入 __eval_direct。
            if (callee.name === "__eval_frame_ptr") {
                this.vm.mov(VReg.RET, VReg.FP);
                return;
            }

            // [引擎库 P2] __engine_exec_raw(uint8array) -> 原始 x0 JSValue。片段返回的
            // 已是 JS 值(如 number 的 float64 位),不做 int→float 转换。
            if (callee.name === "__engine_exec_raw" && expr.arguments.length > 0) {
                this.compileExpression(expr.arguments[0]);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
                this.vm.load(VReg.A1, VReg.V0, 8);
                this.vm.load(VReg.A0, VReg.V0, 16);      // deref data_ptr@16(见 __engine_exec 注)
                this.vm.call("_engine_exec");
                return;
            }

            // [引擎库] __engine_host_target() -> 宿主二进制的 target 串(编译期常量,如
            // "macos-x64"/"macos-arm64"/"linux-x64")。__eval_shim 用它编出与宿主同架构的
            // 片段(片段编码按架构不同,eval/new Function 必须匹配运行架构)。
            if (callee.name === "__engine_host_target") {
                this.compileStringValue(this.target);
                return;
            }

            // 事件循环内建：queueMicrotask 与 node:timers 委托用的 __asmjs_* 桥接函数。
            // 求出第一个参数（回调/句柄）到 A0，调对应运行时函数；返回值在 RET。
            // 事件循环内建。除 node:timers 委托的 __asmjs_* 桥接外,也直接接住裸全局
            // setTimeout/setImmediate/clearTimeout/clearImmediate(Node 全局,无需 import)。
            // 一次性语义:asm.js 无真定时器,回调在退出前 _ev_run drain 时执行(delay 忽略,
            // 取 arguments[0] 回调)。setInterval/clearInterval 不接(无重复计时基建,见 backlog)。
            if (callee.name === "queueMicrotask" || callee.name === "__asmjs_queueMicrotask" ||
                callee.name === "__asmjsNextTick" ||
                callee.name === "__asmjs_setTimeout" || callee.name === "__asmjs_setImmediate" ||
                callee.name === "__asmjs_clearTimer" ||
                callee.name === "setTimeout" || callee.name === "setImmediate" ||
                callee.name === "clearTimeout" || callee.name === "clearImmediate") {
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                } else {
                    this.vm.movImm64(VReg.A0, 0x7ffb000000000000n); // undefined
                }
                const rtFn = (callee.name === "__asmjs_setTimeout" || callee.name === "setTimeout") ? "_ev_set_timeout"
                    : (callee.name === "__asmjs_setImmediate" || callee.name === "setImmediate") ? "_ev_set_immediate"
                    : (callee.name === "__asmjs_clearTimer" || callee.name === "clearTimeout" || callee.name === "clearImmediate") ? "_ev_clear"
                    : "_ev_queue_microtask";
                this.vm.call(rtFn);
                return;
            }

            if (callee.name === "String") {
                // String(x) -> ToString
                if (expr.arguments.length > 0) {
                    // String(/re/) → __RE_toString(re)("/source/flags");_valueToStr 对
                    // 正则对象只得 "[object Object]"。仅静态 REGEXP 介入。
                    if (inferType(expr.arguments[0], this.ctx) === Type.REGEXP) {
                        this.compileExpression({
                            type: "CallExpression",
                            callee: { type: "Identifier", name: "__RE_toString" },
                            arguments: [expr.arguments[0]],
                        });
                        return;
                    }
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_valueToStr");
                } else {
                    this.vm.lea(VReg.A0, "_str_empty");
                    this.vm.call("_js_box_string");
                }
                return;
            }

            if (callee.name === "RegExp") {
                // RegExp(pattern, flags) 作函数调用(无 new)与 new RegExp 等价(ES 规范)。
                // 此前无分派 → 当普通函数调用取到未定义 → 属性全 undefined。→ __RE_new。
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "__RE_new" },
                    arguments: [
                        expr.arguments.length >= 1 ? expr.arguments[0] : { type: "Literal", value: "" },
                        expr.arguments.length >= 2 ? expr.arguments[1] : { type: "Literal", value: "" },
                    ],
                });
                return;
            }

            // __attachRaw(strsArr, rawArr):tagged template 的模板对象——把 raw 数组挂到
            // strings 数组的属性侧表(.raw,经 _closure_prop_set,按裸指针键),并**按站点缓存**
            // 到数据槽 _tmplsite_<id>(GC 根,同 _funcclosure_ 模式):首次执行建 strs+raw 并
            // 挂接,后续复用同一模板对象(node 语义:模板对象每站点恒同;亦免每次调用增注册表节点)。
            // quasis 全是编译期常量串 → 缓存语义安全。返回 strings 数组(装箱)。
            if (callee.name === "__attachRaw" && expr.arguments.length >= 2) {
                const siteId = this.nextLabelId();
                const siteLabel = `_tmplsite_${siteId}`;
                this.asm.addDataLabel(siteLabel);
                this.asm.addDataQword(0);
                const doneL = this.ctx.newLabel("attachraw_done");
                this.vm.lea(VReg.V0, siteLabel);
                this.vm.load(VReg.RET, VReg.V0, 0);
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jne(doneL); // 已缓存 → RET = 模板对象
                // 首次:建 strings 数组
                this.compileExpression(expr.arguments[0]);
                const arStrsOff = this.ctx.allocLocal(`__attachraw_s_${siteId}`);
                this.vm.store(VReg.FP, arStrsOff, VReg.RET);
                // 建 raw 数组
                this.compileExpression(expr.arguments[1]);
                this.vm.mov(VReg.A2, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, arStrsOff);
                this.emitBoxedStringKey("raw", VReg.A1);
                this.vm.call("_closure_prop_set"); // 侧表:strs.raw = rawArr
                this.vm.load(VReg.RET, VReg.FP, arStrsOff);
                this.vm.lea(VReg.V0, siteLabel);
                this.vm.store(VReg.V0, 0, VReg.RET); // 缓存模板对象(数据根 → 常驻)
                this.vm.label(doneL);
                return;
            }

            if (callee.name === "__syscall") {
                const args = expr.arguments;
                // args[0] = 调用号，args[1..] = 系统调用参数（映射到 A0..A4）。
                // 每个值先经 _syscall_arg 归一化（float位->int、字符串->指针），
                // 全部压栈后逆序弹出，避免参数间相互覆盖。
                const n = Math.min(args.length, 6);
                for (let i = 0; i < n; i++) {
                    this.compileExpression(args[i]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_arg");
                    this.vm.push(VReg.RET);
                }
                for (let i = n - 1; i >= 1; i--) {
                    this.vm.pop(this.vm.getArgReg(i - 1));
                }
                if (n > 0) {
                    this.vm.pop(VReg.V1); // 调用号
                    this.vm.syscallReg(VReg.V1);
                }
                // 返回值转标准 JS number（float64 位），供 fd < 0 等比较使用
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__thread_spawn_smoke") {
                // __thread_spawn_smoke(argPtr) -> join 句柄(线程块基址,exact float)或 -1。
                // M3 clone 配方冒烟探针(shim 层原语,非用户 API):起裸 OS 线程跑
                // _thread_smoke_child(argPtr)。仅 linux 目标有真体,其余桩恒返 -1
                // (runtime/core/thread.js;配方 docs/PARALLEL_DESIGN.md §2.1)。
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_ptr"); // 裸指针归一化(不按 Number 解引用)
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A1, 0);
                }
                this.vm.lea(VReg.A0, "_thread_smoke_child");
                this.vm.call("_thread_create_raw");
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__m_bringup_smoke") {
                // __m_bringup_smoke() -> 0 成功 / -1。M3 第二个 M 起跑冒烟探针(shim 层原语,
                // 非用户 API):临时开门 GOMAXPROCS=2 → 起第二个 M(绑 x28 + 进调度环)→ join →
                // 复位。仅 linux 目标有真体,其余桩恒返 -1(runtime/core/m_bringup.js;§4-M3)。
                this.vm.call("_m_bringup_smoke");
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__par_smoke") {
                // __par_smoke() -> 0 成功 / -1。M3 多 M G-M-P 调度冒烟(shim 层原语,非用户 API):
                // 开门 GOMAXPROCS=2 → 建 N 个任务协程派发到 P0 → 起第二个 M 跑 _par_sched_run →
                // 两 M 经 per-P runq/窃取排空 → join → 校验 Σresults==136 → 复位。仅 linux-arm64
                // 有真体(runtime/core/parallel_sched.js;§4-M3),其余桩恒返 -1。
                this.vm.movImm(VReg.A0, 2); // nprocs=2
                this.vm.call("_par_smoke");
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__par_smoke_n") {
                // __par_smoke_n() -> 0/-1。[M6 N>2] GOMAXPROCS=3 调度冒烟:同 _par_smoke 但 nprocs=3
                // → 起 2 个额外 M,三 M 经 per-P runq + 一般化窃取(遍历全部 P)排空。仅 linux-arm64 真体。
                this.vm.movImm(VReg.A0, 3);
                this.vm.call("_par_smoke");
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__par_alloc_smoke") {
                // __par_alloc_smoke() -> 0 成功 / -1。[M4] 多 M 分配安全冒烟(shim 层原语,非
                // 用户 API):GOMAXPROCS=2 + GC-off 下起第二个 M,跑 N 个**分配型**任务(每任务并发
                // `_alloc` 建链表)分布两 M,校验 Σresults==K*136。检验 per-P mcache 无锁分配 +
                // 锁保护 refill 的多 M 安全。仅 linux-arm64 有真体(parallel_sched.js),其余桩返 -1。
                this.vm.call("_par_alloc_smoke");
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__par_stw_smoke") {
                // __par_stw_smoke() -> 0 成功 / -1。[M5] 协作式 safepoint / STW park-resume 冒烟
                // (shim 层原语,非用户 API):GOMAXPROCS=2 + GC-off 下起第二个 M 跑非分配任务,
                // M0 作请求者跑一次 STW 往返(置旗 → 等 M1 在停点 park → 清旗唤醒),再一同排空、
                // join、校验 Σresults==136 且 park 往返被观测。证明停点/park/resume 机制端到端生效
                // (真 STW GC 回收属后续)。仅 linux-arm64 有真体(parallel_sched.js),其余桩返 -1。
                this.vm.call("_par_stw_smoke");
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__par_gc_smoke") {
                // __par_gc_smoke() -> 0 成功 / -1。[M5] 真·多 M STW GC 冒烟(shim 层原语,非用户
                // API):GOMAXPROCS=2 + GC-ON 下 M0 建 keeper 活链表 + 死垃圾、派发分配型任务,预置
                // STW 旗后起第二个 M(首个停点即 park),M0 显式停世界 `_gc_collect`(扩展根扫描含
                // M1 栈)后唤醒、排空、join。校验 keeper 校验和跨 GC 存活 + 任务结果 + gc_count 递增。
                // 证明多 M 停世界收集端到端生效。仅 linux-arm64 有真体(parallel_sched.js),其余桩返 -1。
                this.vm.movImm(VReg.A0, 2); // nprocs=2
                this.vm.call("_par_gc_smoke");
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__par_gc_smoke_n") {
                // __par_gc_smoke_n() -> 0/-1。[M6 N>2] GOMAXPROCS=3 真 STW GC 冒烟:同 _par_gc_smoke
                // 但 nprocs=3 → 起 2 个额外 M,M0 停世界 _gc_collect 的扩展根扫描遍历全部 P 扫 M1+M2
                // g0 栈。校验 keeper 跨 GC 存活 + 任务结果 + gc_count 递增。仅 linux-arm64 真体。
                this.vm.movImm(VReg.A0, 3);
                this.vm.call("_par_gc_smoke");
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__thread_join") {
                // __thread_join(handle) -> 0。阻塞至子线程退出(CLEARTID futex 唤醒)。
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_ptr");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_thread_join");
                } else {
                    this.vm.movImm(VReg.RET, -1);
                }
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__winfs_open" || callee.name === "__winfs_read" ||
                callee.name === "__winfs_write" || callee.name === "__winfs_close") {
                // Windows fs 原语(shim 层):__winfs_open(pathPtr, mode) / __winfs_read(fd, buf, len)
                // / __winfs_write(fd, buf, len) / __winfs_close(fd)。
                // 实参经 _syscall_arg 归一化(float位/装箱->整数,同 __syscall),压栈后逆序
                // 弹出防互踩;返回值转标准 JS number(float64 位)。非 windows 目标运行时
                // 提供恒返 -1 的桩(runtime/core/winfs.js)。
                const winfsLabel = {
                    __winfs_open: "_win_open",
                    __winfs_read: "_win_read",
                    __winfs_write: "_win_write",
                    __winfs_close: "_win_close",
                }[callee.name];
                const wn = Math.min(expr.arguments.length, 3);
                for (let i = 0; i < wn; i++) {
                    this.compileExpression(expr.arguments[i]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_arg");
                    this.vm.push(VReg.RET);
                }
                for (let i = wn - 1; i >= 0; i--) {
                    this.vm.pop(this.vm.getArgReg(i));
                }
                this.vm.call(winfsLabel);
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                return;
            }

            if (callee.name === "__alloc") {
                // __alloc(bytes) -> 裸堆指针（shim 层原语）
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_arg"); // float位/装箱 -> 整数
                    this.vm.mov(VReg.A0, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A0, 16);
                }
                this.vm.call("_alloc");
                return;
            }

            if (callee.name === "__cstr_to_str") {
                // __cstr_to_str(ptr) -> 装箱 JS 字符串（O(n)，一次性建串）。
                // 替掉 cstringToJS 逐字符 += 的 O(n²)——读大文件(index.js 80KB)必需。
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_ptr"); // 归一化指针
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_cstr_to_heap_str");
                } else {
                    this.vm.lea(VReg.RET, "_str_empty");
                    this.vm.call("_js_box_string");
                }
                return;
            }

            if (callee.name === "__getChar") {
                // __getChar(ptr) -> 字节值 (JS number)
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_ptr"); // 归一化指针（不做装箱 Number 解引用）
                    this.vm.loadByte(VReg.RET, VReg.RET, 0);
                    this.vm.scvtf(0, VReg.RET);
                    this.vm.fmovToInt(VReg.RET, 0);
                } else {
                    this.vm.movImm(VReg.RET, 0);
                }
                return;
            }

            if (callee.name === "__setChar") {
                // __setChar(ptr, val)
                if (expr.arguments.length >= 2) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_ptr"); // ptr 归一化：不做装箱 Number 解引用
                    this.vm.push(VReg.RET);
                    this.compileExpression(expr.arguments[1]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_arg");
                    this.vm.pop(VReg.V1);
                    this.vm.storeByte(VReg.V1, 0, VReg.RET);
                }
                this.vm.movImm(VReg.RET, 0);
                return;
            }

            if (callee.name === "__setPtr") {
                // __setPtr(ptr, val) - 把 64 位裸指针/值存到 ptr 处（一次 8 字节 store）。
                // 指针不是 float64，无法在 JS 里按字节拆(% / floor 全崩)，故需此内建。
                // 值同样按裸指针归一化(_syscall_ptr)，不做 Number 解码。
                if (expr.arguments.length >= 2) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_ptr");
                    this.vm.push(VReg.RET);
                    this.compileExpression(expr.arguments[1]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_syscall_ptr");
                    this.vm.pop(VReg.V1);
                    this.vm.store(VReg.V1, 0, VReg.RET);
                }
                this.vm.movImm(VReg.RET, 0);
                return;
            }

            if (callee.name === "__json_date_iso") {
                // [#50] Date→JSON 桥。JSON.stringify 内 Date 值在本运行时呈 typeof "number"
                // (Date 是裸堆指针,高 16 位 0 被 NaN-box 读成极小 double),shim 的 toJSON
                // 协议 typeof value.toJSON==="function" 取不到。此内建对任意值做**安全**判定:
                // 低 48 位落 [_heap_base,_heap_ptr) 且 [ptr+0] 低字节==TYPE_DATE(7) → 调
                // _date_toISOString 返回 ISO 串;否则返回 undefined。真数(3.14/极小 double)
                // 掩码后地址远超堆界 → 判否、绝不解引用。shim 仅在数字分支(typeof==="number")
                // 前对其调用,把 Date 先转成 ISO 串再按字符串序列化。
                const notDate = this.ctx.newLabel("jdi_notdate");
                const doneL = this.ctx.newLabel("jdi_done");
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                } else {
                    this.vm.movImm(VReg.RET, 0);
                }
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V6, VReg.RET, VReg.V1); // 裸指针候选(去高位 tag)
                this.vm.lea(VReg.V0, "_heap_base");
                this.vm.load(VReg.V0, VReg.V0, 0);
                this.vm.cmp(VReg.V6, VReg.V0);
                this.vm.jlt(notDate);
                this.vm.lea(VReg.V0, "_heap_ptr");
                this.vm.load(VReg.V0, VReg.V0, 0);
                this.vm.cmp(VReg.V6, VReg.V0);
                this.vm.jge(notDate);
                this.vm.load(VReg.V0, VReg.V6, 0); // type 字(Date 全 8 字节存 7)
                this.vm.andImm(VReg.V0, VReg.V0, 0xff);
                this.vm.cmpImm(VReg.V0, 7); // TYPE_DATE
                this.vm.jne(notDate);
                this.vm.mov(VReg.A0, VReg.V6);
                this.vm.call("_date_toISOString"); // RET = ISO content 指针(未打 tag)
                // _date_toISOString 返回裸 content 指针(高位 0 → typeof "number"),shim 的
                // __jsonQuote 需 typeof "string"。打 JS_TAG_STRING_BASE(0x7FFC<<48)成标准
                // 字符串值(等价 `""+iso` 的重装箱,但省一次 _strconcat)。
                this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                this.vm.jmp(doneL);
                this.vm.label(notDate);
                this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
                this.vm.label(doneL);
                return;
            }

            if (callee.name === "__get_process") {
                // Returns _process_global. If NULL, returns undefined to prevent crashes.
                // Modules should use: const _proc = __get_process(); if (!_proc) return default;
                this.vm.lea(VReg.V0, "_process_global");
                this.vm.load(VReg.RET, VReg.V0, 0);
                // Check if _process_global is NULL (0)
                // 标签必须唯一：多个模块顶层的 __get_process() 都内联在
                // _main 中，固定标签会重复定义导致跨模块乱跳
                const isNull = this.ctx.newLabel("proc_null");
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jne(isNull);
                // _process_global is NULL — return _js_undefined
                this.vm.lea(VReg.A0, "_js_undefined");
                this.vm.load(VReg.RET, VReg.A0, 0);
                this.vm.label(isNull);
                return;
            }
            // sizeof(Type) 或 sizeof(variable) - 获取类型的字节大小
            if (callee.name === "sizeof") {
                if (expr.arguments.length > 0) {
                    const arg = expr.arguments[0];
                    let size = 8; // 默认 8 字节
                    if (arg.type === "Identifier") {
                        // 类型名到字节数的映射
                        const typeSizes = {
                            Int8: 1,
                            Uint8: 1,
                            Int16: 2,
                            Uint16: 2,
                            Float16: 2,
                            Int32: 4,
                            Uint32: 4,
                            Float32: 4,
                            Int64: 8,
                            Uint64: 8,
                            Float64: 8,
                            Int: 8,
                            Float: 8,
                            Number: 8,
                            Boolean: 1,
                            String: 8,
                            Array: 8,
                            Object: 8,
                            Date: 8,
                            Map: 8,
                            Set: 8,
                            RegExp: 8,
                        };

                        // 首先检查是否是类型名
                        if (typeSizes[arg.name]) {
                            size = typeSizes[arg.name];
                        } else {
                            // 否则检查变量的类型
                            const varType = this.ctx.getVarType ? this.ctx.getVarType(arg.name) : null;
                            if (varType) {
                                // 从类型字符串获取字节数
                                const typeToSize = {
                                    int8: 1,
                                    uint8: 1,
                                    int16: 2,
                                    uint16: 2,
                                    float16: 2,
                                    int32: 4,
                                    uint32: 4,
                                    float32: 4,
                                    int64: 8,
                                    uint64: 8,
                                    float64: 8,
                                    int: 8,
                                    float: 8,
                                    number: 8,
                                    boolean: 1,
                                    string: 8,
                                    array: 8,
                                    object: 8,
                                    Date: 8,
                                    Map: 8,
                                    Set: 8,
                                    RegExp: 8,
                                };
                                size = typeToSize[varType] || 8;
                            }
                        }
                    }
                    this.vm.movImm(VReg.RET, size);
                }
                return;
            }

            // parseInt(str, radix) / parseFloat(str) 全局函数
            if (callee.name === "parseInt") {
                this.compileExpression(expr.arguments[0]);
                this.vm.push(VReg.RET);
                if (expr.arguments.length > 1) {
                    this.compileExpression(expr.arguments[1]);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A1, 0); // radix=0 → 运行时默认 10 / 0x 自动 16
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_js_parseInt");
                return;
            }
            if (callee.name === "parseFloat") {
                // 前导数字前缀解析(尾部非数字字符忽略):parseFloat("3.14px")=3.14。
                // 此前直调 _str_to_num(严格)→ 尾部垃圾判 NaN/0。_js_parseFloat 置宽松位。
                this.compileExpression(expr.arguments[0]);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_js_parseFloat");
                return;
            }
            if (callee.name === "structuredClone" && expr.arguments.length >= 1) {
                // structuredClone(x) —— 近似为 JSON.parse(JSON.stringify(x))(深拷贝 JSON 安全数据:
                // 嵌套对象/数组/基本值)。偏差:丢 undefined 值/函数、Date→ISO 串、Map/Set→{}、
                // 不支持循环引用(未实现真结构化克隆算法)。覆盖最常见的"深拷贝数据"用例。
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "MemberExpression", object: { type: "Identifier", name: "JSON" }, property: { type: "Identifier", name: "parse" }, computed: false },
                    arguments: [{
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: { type: "Identifier", name: "JSON" }, property: { type: "Identifier", name: "stringify" }, computed: false },
                        arguments: [expr.arguments[0]],
                    }],
                });
                return;
            }
            if (callee.name === "isNaN" || callee.name === "isFinite") {
                // 全局 isNaN(x)/isFinite(x):ToNumber(x)(coerce,区别于 Number.isNaN 不 coerce)
                // 后按位型判定(指数全 1 + 尾数非 0 = NaN;指数全 1 + 尾数 0 = ±Inf)。
                const gnm = callee.name;
                if (expr.arguments.length === 0) {
                    this.vm.lea(VReg.RET, gnm === "isNaN" ? "_js_true" : "_js_false");
                    this.vm.load(VReg.RET, VReg.RET, 0);
                    return;
                }
                const gtL = this.ctx.newLabel("gis_t");
                const gfL = this.ctx.newLabel("gis_f");
                const geL = this.ctx.newLabel("gis_e");
                this.compileExpression(expr.arguments[0]);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_number_coerce"); // RET = float64 位(ToNumber)
                this.vm.shrImm(VReg.V2, VReg.RET, 52);
                this.vm.movImm(VReg.V3, 0x7FF);
                this.vm.and(VReg.V2, VReg.V2, VReg.V3);
                this.vm.cmp(VReg.V2, VReg.V3);
                if (gnm === "isFinite") {
                    this.vm.jeq(gfL); // 指数全 1 → Inf/NaN → false
                    this.vm.jmp(gtL);
                } else { // isNaN
                    this.vm.jne(gfL); // 指数非全 1 → 普通数 → false
                    this.vm.movImm64(VReg.V3, 0xFFFFFFFFFFFFFn);
                    this.vm.and(VReg.V3, VReg.RET, VReg.V3);
                    this.vm.cmpImm(VReg.V3, 0);
                    this.vm.jeq(gfL); // 尾数 0 → ±Inf → false
                    this.vm.jmp(gtL);
                }
                this.vm.label(gtL);
                this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                this.vm.jmp(geL);
                this.vm.label(gfL);
                this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
                this.vm.label(geL);
                return;
            }

            // Symbol(desc) —— ES 批次D:裸堆指针 + 用户区 TYPE_SYMBOL 标记块,
            // 每次调用分配新块 → 唯一性/===按指针位天然正确。(new Symbol 应
            // TypeError,未拦截,记偏差)
            if (callee.name === "Symbol") {
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A0, 0);
                }
                this.vm.call("_symbol_new");
                return;
            }

            // BigInt(x) 转换函数
            if (callee.name === "BigInt") {
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_bigint");
                } else {
                    this.vm.movImm(VReg.A0, 0);
                    this.vm.call("_bigint_box");
                }
                return;
            }

            // Number(x), Boolean(x), String(x) 转换函数
            if (callee.name === "Number" || callee.name === "Boolean" || callee.name === "String") {
                const arg = expr.arguments.length > 0 ? expr.arguments[0] : null;

                // Boolean(字面量) 曾在编译期用 `Boolean(arg.value)` 折叠,但该调用在
                // 自举产物(gen2+)里跑的是本运行时的 Boolean() —— 对字面量路径恒返 true,
                // 令 Boolean(0)/Boolean("") 误折叠成 true。删除折叠,统一走下方运行时
                // _to_boolean 路径(对变量/字面量均正确,已实测)。

                // 对于 Number()，如果是数字字面量，直接返回
                if (callee.name === "Number" && arg) {
                    if (arg.type === "Literal" && typeof arg.value === "number") {
                        this.compileExpression(arg);
                        return;
                    }
                    // 对于字符串字面量，调用 _str_to_num 转换
                    if (arg.type === "Literal" && typeof arg.value === "string") {
                        this.compileExpression(arg);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_str_to_num");
                        return;
                    }
                }

                // 对于 String()，如果是字符串字面量，直接返回
                if (callee.name === "String" && arg) {
                    if (arg.type === "Literal" && typeof arg.value === "string") {
                        this.compileExpression(arg);
                        return;
                    }
                }

                // 非字面量参数：编译参数并返回
                if (arg) {
                    this.compileExpression(arg);
                    // 对于 Number()，调用 _number_coerce 进行转换
                    // _number_coerce 正确处理 boolean, null, undefined, string, number
                    if (callee.name === "Number") {
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_number_coerce");
                    }
                    // 对于 Boolean()，调用 _to_boolean 并映射为 JS bool
                    else if (callee.name === "Boolean") {
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_to_boolean"); // RET = 0/1
                        const bfLabel = this.ctx.newLabel("boolean_false");
                        const beLabel = this.ctx.newLabel("boolean_end");
                        this.vm.cmpImm(VReg.RET, 0);
                        this.vm.jeq(bfLabel);
                        this.vm.movImm64(VReg.RET, 0x7FF9000000000001n); // true
                        this.vm.jmp(beLabel);
                        this.vm.label(bfLabel);
                        this.vm.movImm64(VReg.RET, 0x7FF9000000000002n); // false
                        this.vm.label(beLabel);
                    }
                    // 对于 String()，调用 _valueToStr 进行转换
                    // _valueToStr 智能检测类型并转换为字符串
                    if (callee.name === "String") {
                        // 检查参数类型，数组需要特殊处理
                        const argType = inferType(arg, this.ctx);
                        // console.log("DEBUG String() argType:", argType, "arg.type:", arg.type, "arg.operator:", arg.operator);
                        if (argType === Type.ARRAY) {
                            // 数组: 直接调用 _valueToStr，它会调用 _array_to_string
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_valueToStr");
                        } else if (argType === Type.OBJECT) {
                            // 对象: 调用 _js_unbox 获取指针，然后调用 _valueToStr
                            // _valueToStr 会将其转换为 "[object Object]"
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_js_unbox");
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_valueToStr");
                        } else if (argType === Type.STRING) {
                            // 字符串类型: 直接返回，字符串变量已经是数据段指针
                            // 不需要调用 _valueToStr
                            // 注意: 如果需要返回 JS 字符串对象(NaN-boxed)，应该调用 _valueToStr
                            // 但当前 String() 的语义是返回原始字符串值
                        } else if (argType === Type.NUMBER && (arg.type === "Literal" || arg.type === "NumericLiteral") && typeof arg.value === "number" && !Number.isInteger(arg.value)) {
                            // 浮点数字面量: 调用 _floatToString 直接转换
                            // _valueToStr 无法正确处理 raw float bits (会误判为 JSValue)
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_floatToString");
                        } else if (argType === Type.NUMBER && (arg.type === "Literal" || arg.type === "NumericLiteral") && typeof arg.value === "number" && Number.isInteger(arg.value)) {
                            // 整数字面量: 调用 _intToStr
                            // 先从 float bits 提取整数
                            this.vm.fmovToFloat(0, VReg.RET);
                            this.vm.fcvtzs(VReg.A0, 0);
                            this.vm.call("_intToStr");
                        } else if (argType === Type.NUMBER && arg.type === "UnaryExpression" && arg.operator === "-" && arg.argument && typeof arg.argument.value === "number" && !Number.isInteger(arg.argument.value)) {
                            // 负浮点数 UnaryExpression: -x.x
                            // 调用 _floatToString 直接转换
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_floatToString");
                        } else if (argType === Type.NUMBER && arg.type === "UnaryExpression" && arg.operator === "-" && arg.argument && typeof arg.argument.value === "number" && Number.isInteger(arg.argument.value)) {
                            // 负整数 UnaryExpression: -nnn
                            // 调用 _intToStr
                            this.vm.fmovToFloat(0, VReg.RET);
                            this.vm.fcvtzs(VReg.A0, 0);
                            this.vm.call("_intToStr");
                        } else if (argType === Type.NUMBER && arg.type === "Identifier") {
                            // 数字类型变量: 直接调用 _floatToString
                            // _floatToString 正确处理负数和浮点数
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_floatToString");
                        } else {
                            // 其他类型（UNKNOWN等）直接调用 _valueToStr
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_valueToStr");
                        }
                    }
                } else {
                    // 无参数时
                    if (callee.name === "Number") {
                        this.vm.movImm(VReg.RET, 0); // Number() 返回 0
                    } else if (callee.name === "Boolean") {
                        this.vm.movImm64(VReg.RET, 0x7FF9000000000002n); // Boolean() 返回 false
                    } else {
                        // String()
                        this.vm.lea(VReg.RET, "_str_empty");
                    }
                }
                return;
            }

            // 检查是否是用户声明的顶层函数 (function foo() {})
            // 但不能是局部变量（嵌套函数声明会存储到局部变量）
            const localOffset = this.ctx.getLocal(callee.name);
            const globalLabel = this.ctx.getMainCapturedVar(callee.name);
            // 用 falsy 判定而非 ===undefined：合法局部偏移恒为负数、合法 globalLabel 恒为
            // 非空串，故「无」⟺ falsy。自举产物里 obj[missing] 返回裸 0（非 undefined），
            // ===undefined 会判假 → 顶层函数调用被误当局部/捕获而跳过。falsy 判定两代一致。
            if (this.ctx.hasFunction(callee.name) && !localOffset && !globalLabel) {
                const funcDef = this.ctx.getFunction(callee.name);
                const funcLabel = this.getFunctionLabel(callee.name);
                if (!funcLabel) {
                    // 函数标签不存在，跳过这个调用
                    return;
                }

                // 检查是否是 async 函数(async generator 除外:后者像生成器一样正常调用,
                // 运行函数标签处的 async-gen stub 建 async-gen 对象,不走 Promise 化调用)。
                if (isAsyncFunction(funcDef) && !isGeneratorFunction(funcDef)) {
                    // async 函数调用：创建协程并返回 Promise
                    this.compileAsyncFunctionCall(callee.name, expr.arguments);
                    return;
                }

                this.compileCallArguments(expr.arguments);
                this.vm.call(funcLabel);
                return;
            }

            // 检查是否是外部库函数
            if (this.isExternalSymbol && this.isExternalSymbol(callee.name)) {
                // 获取库信息
                const libInfo = this.getExternalLibInfo(callee.name);
                if (libInfo) {
                    if (libInfo.type === "static") {
                        // 静态库：代码已嵌入
                        // asm.js 编译的静态库使用整数寄存器传递参数，直接调用内部函数
                        const funcLabel = this.getFunctionLabel(callee.name);
                        if (funcLabel) {
                            this.compileCallArguments(expr.arguments);
                            this.vm.call(funcLabel);
                        }
                    } else {
                        // 动态库：需要遵循 C 调用约定
                        this.compileCallArgumentsForCConvention(expr.arguments);

                        // 确保库已添加到外部动态库列表
                        this.registerExternalLib(libInfo);

                        if (this.os === "windows") {
                            // Windows: 使用 IAT 间接调用
                            // 计算此符号在 IAT 中的槽位
                            // kernel32.dll 占用 slots 0-3，然后有一个 null 终止符在 slot 4
                            // 所以外部 DLL 的第一个符号从 slot 5 开始
                            const baseSlot = 5; // 跳过 kernel32 的 4 个函数 + 1 个 null 终止符
                            let slotOffset = 0;

                            // 计算此符号在外部库中的位置
                            for (const lib of this.externalLibs || []) {
                                for (const sym of lib.symbols || []) {
                                    if (sym === callee.name) {
                                        // 找到了，slotOffset 是相对于 baseSlot 的偏移
                                        this.asm.callIAT(baseSlot + slotOffset);
                                        break;
                                    }
                                    slotOffset++;
                                }
                            }
                        } else {
                            // macOS/Linux: 注册外部符号（dylib ordinal 从 2 开始，1 是 libSystem）
                            const dylibIndex = this.getDylibIndex(libInfo.fullPath);
                            this.asm.registerExternalSymbol(callee.name, dylibIndex);
                            this.vm.call("_" + callee.name);
                        }

                        // 外部函数返回值在 D0/XMM0 中（浮点），需要转换到 X0/RAX
                        this.vm.fmovToInt(VReg.RET, 0);
                    }
                    return;
                }
            }

            // 检查是否是局部变量（函数表达式或嵌套函数声明）
            if (localOffset) {
                // 检查是否是装箱变量
                const isBoxed = this.ctx.boxedVars && this.ctx.boxedVars.has(callee.name);
                if (isBoxed) {
                    // 装箱变量：先加载 box 指针，再解引用
                    this.vm.load(VReg.V6, VReg.FP, localOffset);
                    this.vm.load(VReg.V6, VReg.V6, 0);
                } else {
                    // 普通变量：直接加载函数指针/闭包对象
                    this.vm.load(VReg.V6, VReg.FP, localOffset);
                }
                // 使用闭包调用机制
                this.compileClosureCall(VReg.V6, expr.arguments);
                return;
            }
        }

        // 处理成员调用 (obj.method())
        if (callee.type === "MemberExpression") {
            const obj = callee.object;
            const prop = callee.property;

            // [支柱② 去虚拟化] 接收者类静态可推(this/字段类型表/局部 new 跟踪)时,
            // 方法调用直编为 direct call——消掉 _object_get 全帧查找(六寄存器 prologue +
            // 防御族 + 自有属性全扫 + 原型链递归)+ validate + callIndirect,自编译主瓶颈。
            // 解析失败一律落既有通用路径(字节不变)。
            if (!callee.computed && prop && prop.type === "Identifier" &&
                this._devirtualizeCall(obj, prop.name, expr.arguments)) {
                return;
            }

            // [#57 B1] Math.<m>.call/apply:内建 Math 方法非一等闭包,直接把接收者
            // 展开为等价的 Math.<m>(...) 编译。
            //   Math.max.call(null, a, b)  → Math.max(a, b)     (弃首参 thisArg)
            //   Math.max.apply(null, arr)  → Math.max(...arr)   (第二参 spread)
            // 其余内建(String.fromCharCode 等)未覆盖,记偏差。
            if (!callee.computed && prop && prop.type === "Identifier" &&
                (prop.name === "call" || prop.name === "apply") &&
                obj.type === "MemberExpression" && !obj.computed &&
                obj.object.type === "Identifier" && obj.object.name === "Math" &&
                !(this.ctx.getLocal && this.ctx.getLocal("Math")) &&
                obj.property.type === "Identifier") {
                const mathMethod = obj.property.name;
                const rest = prop.name === "call"
                    ? expr.arguments.slice(1)
                    : (expr.arguments.length > 1
                        ? [{ type: "SpreadElement", argument: expr.arguments[1] }]
                        : []);
                if (this.compileMathMethod(mathMethod, rest)) {
                    return;
                }
            }

            // console.log / error / warn / info / debug 共用同一打印路径
            // (error/warn 理想上应写 stderr，当前先保证可见性)
            if (obj.type === "Identifier" && obj.name === "console") {
                if (["log", "error", "warn", "info", "debug"].includes(prop.name)) {
                    // 处理多个参数
                    for (let i = 0; i < expr.arguments.length; i++) {
                        const arg = expr.arguments[i];
                        const isLast = i === expr.arguments.length - 1;

                        // console.log(...arr)：运行时按长度逐个打印,元素间空格分隔;
                        // 末参尾随换行,否则空格。此前 SpreadElement 落通用 else→告警+乱码。
                        if (arg.type === "SpreadElement") {
                            this.compileArrayExpressionWithSpread([arg]);
                            const arrOff = this.ctx.allocLocal(`__clsp_arr_${this.nextLabelId()}`);
                            this.vm.store(VReg.FP, arrOff, VReg.RET);
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_array_length");
                            const lenOff = this.ctx.allocLocal(`__clsp_len_${this.nextLabelId()}`);
                            this.vm.store(VReg.FP, lenOff, VReg.RET);
                            const idxOff = this.ctx.allocLocal(`__clsp_idx_${this.nextLabelId()}`);
                            this.vm.movImm(VReg.V0, 0);
                            this.vm.store(VReg.FP, idxOff, VReg.V0);
                            const cid = this.nextLabelId();
                            const loopL = `_clsp_loop_${cid}`;
                            const doneL = `_clsp_done_${cid}`;
                            const nospaceL = `_clsp_nospace_${cid}`;
                            this.vm.label(loopL);
                            this.vm.load(VReg.V0, VReg.FP, idxOff);
                            this.vm.load(VReg.V1, VReg.FP, lenOff);
                            this.vm.cmp(VReg.V0, VReg.V1);
                            this.vm.jge(doneL);
                            this.vm.cmpImm(VReg.V0, 0);
                            this.vm.jeq(nospaceL);
                            this.vm.call("_print_space");
                            this.vm.label(nospaceL);
                            this.vm.load(VReg.A0, VReg.FP, arrOff);
                            this.vm.load(VReg.A1, VReg.FP, idxOff);
                            this.vm.call("_array_get");
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_print_value_no_nl");
                            this.vm.load(VReg.V0, VReg.FP, idxOff);
                            this.vm.addImm(VReg.V0, VReg.V0, 1);
                            this.vm.store(VReg.FP, idxOff, VReg.V0);
                            this.vm.jmp(loopL);
                            this.vm.label(doneL);
                            if (isLast) {
                                this.vm.call("_print_nl");
                            } else {
                                this.vm.call("_print_space");
                            }
                            continue;
                        }

                        // 根据参数类型选择打印方法
                        if (arg.type === "Literal") {
                            if (typeof arg.value === "string") {
                                // 字符串字面量 - compileExpression 返回 NaN-boxed string
                                // 需要先 unbox 得到 char* 指针再传给 _print_str
                                this.compileExpression(arg);
                                this.vm.mov(VReg.A0, VReg.RET);
                                this.vm.call("_js_unbox"); // 提取 char* 指针
                                this.vm.mov(VReg.A0, VReg.RET); // _js_unbox 结果在 RET 中，需要移到 A0
                                if (isLast) {
                                    this.vm.call("_print_str");
                                } else {
                                    this.vm.call("_print_str_no_nl");
                                    this.vm.call("_print_space");
                                }
                            } else if (typeof arg.value === "number") {
                                // 数字字面量 - compileExpression 返回 IEEE 754 位模式
                                // 使用 _print_value 处理，因为它能正确处理原始值
                                this.compileExpression(arg);
                                this.vm.mov(VReg.A0, VReg.RET);
                                if (isLast) {
                                    this.vm.call("_print_value");
                                } else {
                                    this.vm.call("_print_value_no_nl");
                                    this.vm.call("_print_space");
                                }
                            } else if (typeof arg.value === "boolean") {
                                // 布尔字面量 - 打印 "true" 或 "false"
                                if (arg.value) {
                                    this.vm.lea(VReg.A0, "_str_true");
                                } else {
                                    this.vm.lea(VReg.A0, "_str_false");
                                }
                                if (isLast) {
                                    this.vm.call("_print_str");
                                } else {
                                    this.vm.call("_print_str_no_nl");
                                    this.vm.call("_print_space");
                                }
                            } else if (arg.value === null) {
                                // null
                                this.vm.lea(VReg.A0, "_str_null");
                                if (isLast) {
                                    this.vm.call("_print_str");
                                } else {
                                    this.vm.call("_print_str_no_nl");
                                    this.vm.call("_print_space");
                                }
                            } else if (arg.value === undefined) {
                                // undefined
                                this.vm.lea(VReg.A0, "_str_undefined");
                                if (isLast) {
                                    this.vm.call("_print_str");
                                } else {
                                    this.vm.call("_print_str_no_nl");
                                    this.vm.call("_print_space");
                                }
                            } else {
                                // 其他未知字面量
                                this.compileExpression(arg);
                                this.vm.mov(VReg.A0, VReg.RET);
                                if (isLast) {
                                    this.vm.call("_print_value");
                                } else {
                                    this.vm.call("_print_value_no_nl");
                                    this.vm.call("_print_space");
                                }
                            }
                        } else if (arg.type === "Identifier" && arg.name === "undefined") {
                            // undefined 标识符（以防某些解析器这样处理）
                            this.vm.lea(VReg.A0, "_str_undefined");
                            if (isLast) {
                                this.vm.call("_print_str");
                            } else {
                                this.vm.call("_print_str_no_nl");
                                this.vm.call("_print_space");
                            }
                        } else if (arg.type === "Identifier" && (arg.name === "true" || arg.name === "false")) {
                            // true/false 标识符
                            if (arg.name === "true") {
                                this.vm.lea(VReg.A0, "_str_true");
                            } else {
                                this.vm.lea(VReg.A0, "_str_false");
                            }
                            if (isLast) {
                                this.vm.call("_print_str");
                            } else {
                                this.vm.call("_print_str_no_nl");
                                this.vm.call("_print_space");
                            }
                        } else if (arg.type === "Identifier" && arg.name === "NaN") {
                            // NaN - 直接使用字符串方式打印
                            const label = this.asm.addString("NaN");
                            this.vm.lea(VReg.A0, label);
                            if (isLast) {
                                this.vm.call("_print_str");
                            } else {
                                this.vm.call("_print_str_no_nl");
                                this.vm.call("_print_space");
                            }
                        } else if (arg.type === "Identifier" && arg.name === "Infinity") {
                            // Infinity - 直接使用字符串方式打印
                            const label = this.asm.addString("Infinity");
                            this.vm.lea(VReg.A0, label);
                            if (isLast) {
                                this.vm.call("_print_str");
                            } else {
                                this.vm.call("_print_str_no_nl");
                                this.vm.call("_print_space");
                            }
                        } else if (arg.type === "UnaryExpression" && arg.operator === "-" && arg.argument.type === "Identifier" && arg.argument.name === "Infinity") {
                            // -Infinity - 直接使用字符串方式打印
                            const label = this.asm.addString("-Infinity");
                            this.vm.lea(VReg.A0, label);
                            if (isLast) {
                                this.vm.call("_print_str");
                            } else {
                                this.vm.call("_print_str_no_nl");
                                this.vm.call("_print_space");
                            }
                        } else if (arg.type === "UnaryExpression" && arg.operator === "-") {
                            // 负数表达式（如 -2.5）- compileExpression 返回 IEEE 754 位模式
                            // 使用 _print_value 处理，因为它能正确处理原始值
                            this.compileExpression(arg);
                            this.vm.mov(VReg.A0, VReg.RET);
                            if (isLast) {
                                this.vm.call("_print_value");
                            } else {
                                this.vm.call("_print_value_no_nl");
                                this.vm.call("_print_space");
                            }
                        } else if (this.isBooleanExpression(arg)) {
                            // 返回布尔值的表达式 (如 s.has(), m.has(), 比较表达式等)
                            this.compileExpression(arg);
                            this.vm.mov(VReg.A0, VReg.RET);
                            if (isLast) {
                                this.vm.call("_print_bool");
                            } else {
                                this.vm.call("_print_bool_no_nl");
                                this.vm.call("_print_space");
                            }
                        } else {
                            // 其他表达式（变量、函数调用等）
                            // 使用运行时类型检测的 _print_value
                            this.compileExpression(arg);
                            this.vm.mov(VReg.A0, VReg.RET);
                            if (isLast) {
                                this.vm.call("_print_value");
                            } else {
                                this.vm.call("_print_value_no_nl");
                                this.vm.call("_print_space");
                            }
                        }
                    }
                    return;
                }
            }

            // Math 对象方法
            if (obj.type === "Identifier" && obj.name === "Math") {
                if (this.compileMathMethod(prop.name, expr.arguments)) {
                    return;
                }
            }

            // String 静态方法
            if (obj.type === "Identifier" && obj.name === "String") {
                // fromCodePoint 在 BMP(码点 < 0x10000)等价 fromCharCode;astral 需代理对/多字节
                // (asm.js UTF-8 模型),记偏差。此前 fromCodePoint 未实现 → 崩。
                if (prop.name === "fromCharCode" || prop.name === "fromCodePoint") {
                    if (expr.arguments.length === 0) {
                        this.vm.lea(VReg.A0, "_str_empty");
                        this.vm.call("_js_box_string");
                        return;
                    }
                    // 首字符 → 装箱串（RET = acc）
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_char_to_str");
                    // 其余每个 code → _char_to_str 后 _strconcat 累加（多参之前只取首个 → "HI" 得 "H"）
                    for (let ci = 1; ci < expr.arguments.length; ci++) {
                        this.vm.push(VReg.RET);                 // 存 acc
                        this.compileExpression(expr.arguments[ci]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_char_to_str");
                        this.vm.mov(VReg.A1, VReg.RET);         // A1 = 本字符
                        this.vm.pop(VReg.A0);                   // A0 = acc
                        this.vm.call("_strconcat");             // RET = acc + 本字符
                    }
                    return;
                }
            }

            // Symbol 静态方法(批次D):for/keyFor —— 全局注册表(数据段链表头
            // _symbol_registry,节点在堆,按 key 内容比较)
            if (obj.type === "Identifier" && obj.name === "Symbol" && prop && prop.type === "Identifier" &&
                (prop.name === "for" || prop.name === "keyFor")) {
                if (expr.arguments.length > 0) {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A0, 0);
                }
                this.vm.call(prop.name === "for" ? "_symbol_for" : "_symbol_keyfor");
                return;
            }

            // Number 静态分类方法(此前无分派,落通用对象路径返空)。
            // 值的两种表示:裸 float64 位(高16 < 0x7FF8 或 ≥ 0x8000 的负数)、
            // 装箱 int32(高16 == 0x7FF8);其他 box tag(0x7FF9..0x7FFE)一律非数字。
            // 已知局限:本系统 qNaN(0x7FF8000000000000)与装箱 int32 0 位型相同,
            // 运行时算出的 NaN 无法与 0 区分(isNaN 对其返 false)——与全系统 NaN 行为一致。
            if (obj.type === "Identifier" && obj.name === "Number" && prop && prop.type === "Identifier" &&
                (prop.name === "isInteger" || prop.name === "isSafeInteger" ||
                 prop.name === "isFinite" || prop.name === "isNaN")) {
                const nm = prop.name;
                if (expr.arguments.length === 0) {
                    this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
                    return;
                }
                const tL = this.ctx.newLabel("numis_t");
                const fL = this.ctx.newLabel("numis_f");
                const eL = this.ctx.newLabel("numis_e");
                const rawL = this.ctx.newLabel("numis_raw");
                this.compileExpression(expr.arguments[0]); // RET = 值(整段无 call,V1-V3 安全)
                this.vm.shrImm(VReg.V1, VReg.RET, 48); // V1 = 高16
                // 装箱 int32:isNaN → false,其余 → true
                this.vm.cmpImm(VReg.V1, 0x7FF8);
                this.vm.jeq(nm === "isNaN" ? fL : tL);
                // 其他 box tag [0x7FF9,0x7FFE] → false(负浮点高16 ≥ 0x8000 落到 raw)
                this.vm.cmpImm(VReg.V1, 0x7FF9);
                this.vm.jlt(rawL);
                this.vm.cmpImm(VReg.V1, 0x7FFE);
                this.vm.jle(fL);
                this.vm.label(rawL);
                // 裸 float:V2 = 指数位(52-62)
                this.vm.shrImm(VReg.V2, VReg.RET, 52);
                this.vm.movImm(VReg.V3, 0x7FF);
                this.vm.and(VReg.V2, VReg.V2, VReg.V3);
                this.vm.cmp(VReg.V2, VReg.V3);
                if (nm === "isFinite") {
                    this.vm.jeq(fL); // 指数全 1 → Inf/NaN → false
                    this.vm.jmp(tL);
                } else if (nm === "isNaN") {
                    this.vm.jne(fL); // 指数非全 1 → 普通数 → false
                    // 尾数(低 52 位)非 0 → NaN;为 0 → ±Infinity → false
                    this.vm.movImm64(VReg.V3, 0xFFFFFFFFFFFFFn);
                    this.vm.and(VReg.V3, VReg.RET, VReg.V3);
                    this.vm.cmpImm(VReg.V3, 0);
                    this.vm.jeq(fL);
                    this.vm.jmp(tL);
                } else {
                    // isInteger/isSafeInteger:Inf/NaN → false;否则取整回环相等 → true。
                    // 先排除指数全 1,保证 fcmp 不出现 unordered(x64 ucomisd 的 ZF 语义差异)。
                    this.vm.jeq(fL);
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.RET, 0); // RET = trunc(v)
                    this.vm.scvtf(1, VReg.RET);  // d1 = (double)trunc(v)
                    this.vm.fcmp(0, 1);
                    if (nm === "isSafeInteger") {
                        // 安全整数还需 |v| <= 2^53-1(此前 isSafeInteger(2^53)=true 误判)。
                        // d0 仍持原值 v(fcvtzs 只写 RET,未动 d0)。
                        this.vm.jne(fL);            // 非整数 → false
                        this.vm.fabs(0, 0);         // d0 = |v|
                        this.vm.movImm64(VReg.RET, 0x433fffffffffffffn); // (double)(2^53-1)
                        this.vm.fmovToFloat(2, VReg.RET);
                        this.vm.fcmp(0, 2);
                        this.vm.jle(tL);            // |v| <= 2^53-1 → safe
                        this.vm.jmp(fL);
                    } else {
                        this.vm.jeq(tL);
                        this.vm.jmp(fL);
                    }
                }
                this.vm.label(tL);
                this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                this.vm.jmp(eL);
                this.vm.label(fL);
                this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
                this.vm.label(eL);
                return;
            }

            // Number.parseInt / Number.parseFloat ≡ 全局 parseInt / parseFloat（ES2015 别名）
            if (obj.type === "Identifier" && obj.name === "Number" && prop && prop.type === "Identifier" &&
                (prop.name === "parseInt" || prop.name === "parseFloat")) {
                if (prop.name === "parseInt") {
                    this.compileExpression(expr.arguments[0]);
                    this.vm.push(VReg.RET);
                    if (expr.arguments.length > 1) {
                        this.compileExpression(expr.arguments[1]);
                        this.vm.mov(VReg.A1, VReg.RET);
                    } else {
                        this.vm.movImm(VReg.A1, 0);
                    }
                    this.vm.pop(VReg.A0);
                    this.vm.call("_js_parseInt");
                } else {
                    // Number.parseFloat ≡ parseFloat(ES2015):宽松前缀解析。
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_js_parseFloat");
                }
                return;
            }

            // Array 静态方法
            if (obj.type === "Identifier" && obj.name === "Array" && prop && prop.type === "Identifier") {
                // [#35] Array.of(...args) ≡ 参数的数组字面量,直接复用数组表达式编译
                if (prop.name === "of") {
                    this.compileArrayExpression({ type: "ArrayExpression", elements: expr.arguments });
                    return;
                }
                if (prop.name === "isArray") {
                    // Array.isArray(x)：x 的 tag == 0x7ffe 则 true。
                    // 裸标识符 Array 解析为整数 1（构造函数标识），故必须在此拦截，
                    // 否则退化成对整数 1 取 .isArray 成员并调用而段错误。
                    const trueL = this.ctx.newLabel("isarray_true");
                    const endL = this.ctx.newLabel("isarray_end");
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    this.vm.mov(VReg.V0, VReg.RET);
                    this.vm.shrImm(VReg.V0, VReg.V0, 48);
                    this.vm.cmpImm(VReg.V0, 0x7ffe);
                    this.vm.jeq(trueL);
                    this.vm.lea(VReg.V0, "_js_false");
                    this.vm.load(VReg.RET, VReg.V0, 0);
                    this.vm.jmp(endL);
                    this.vm.label(trueL);
                    this.vm.lea(VReg.V0, "_js_true");
                    this.vm.load(VReg.RET, VReg.V0, 0);
                    this.vm.label(endL);
                    return;
                }
                if (prop.name === "from") {
                    // Array.from(x[, mapFn]):数组输入走快路(slice/map);非数组可迭代输入
                    // (生成器/Set/Map/字符串/unknown)脱糖为 [...x] spread 抽干——此前一律
                    // 当数组 slice → 对生成器等越界读段错误(限制注释已过时)。无 mapFn 的
                    // 非数组走 compileExpression([...x])(与 iterator toArray 同,gen2 安全)。
                    if (expr.arguments.length === 0) {
                        this.vm.movImm(VReg.A0, 0);
                        this.vm.call("_array_new_with_size"); // RET = 裸指针
                        this.vm.call("_box_arr_r"); // box->helper
                        return;
                    }
                    const fromArg = expr.arguments[0];
                    const fromType = inferType(fromArg, this.ctx);
                    const fromIsArray = fromType === Type.ARRAY || fromType === Type.TYPED_ARRAY;
                    // 纯对象(非 Array/Set/Map/String/TypedArray)= array-like:按 .length 建 undefined
                    // 数组,再(可选)map。Array.from({length:N}[, fn]) 常用于建区间。此前脱糖 [...x]
                    // 对非可迭代对象返空。偏差:仅按 length 填 undefined,不复制下标属性(记)。
                    if (fromType === Type.OBJECT) {
                        const fid = this.nextLabelId();
                        const objOff = this.ctx.allocLocal(`__afrom_obj_${fid}`);
                        const arrOff = this.ctx.allocLocal(`__afrom_arr_${fid}`);
                        this.compileExpression(fromArg);            // 求值一次
                        this.vm.store(VReg.FP, objOff, VReg.RET);
                        // 运行时先判可迭代:有 Symbol.iterator 方法 → 迭代协议(_array_spread_into);
                        // 否则 array-like → 按 .length 建 undefined 数组。此前一律 array-like,
                        // 令 Array.from(自定义可迭代对象) 返空。
                        const afIterL = this.ctx.newLabel("afrom_iter");
                        const afMapL = this.ctx.newLabel("afrom_map");
                        this.vm.load(VReg.A0, VReg.FP, objOff);
                        this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
                        this.vm.call("_object_get");
                        // 仅当返回值是**函数**(tag 0x7FFF)才当可迭代;miss 返 JS_UNDEFINED(0x7FFB,
                        // 非 0)故不能判 !=0(否则 {length:3} 误入迭代路径 → 无限循环)。
                        this.vm.shrImm(VReg.V0, VReg.RET, 48);
                        this.vm.cmpImm(VReg.V0, 0x7FFF);
                        this.vm.jeq(afIterL);
                        // array-like:len = ToInt(obj.length) → _array_new_undefined
                        this.compileExpression({
                            type: "MemberExpression", computed: false,
                            object: { type: "Identifier", name: `__afrom_obj_${fid}` },
                            property: { type: "Identifier", name: "length" },
                        });
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_to_int32");
                        const lenOff = this.ctx.allocLocal(`__afrom_len_${fid}`);
                        this.vm.store(VReg.FP, lenOff, VReg.RET);     // len(裸 int)
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_array_new_undefined");        // RET = 装箱数组[undefined×len]
                        this.vm.store(VReg.FP, arrOff, VReg.RET);
                        // 复制 array-like 的下标属性 obj[0..len-1] 进数组(填实际值)
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.load(VReg.A1, VReg.FP, objOff);
                        this.vm.load(VReg.A2, VReg.FP, lenOff);
                        this.vm.call("_array_like_copy");
                        this.vm.jmp(afMapL);
                        // 可迭代:空数组 + _array_spread_into 抽干迭代器
                        this.vm.label(afIterL);
                        this.vm.movImm(VReg.A0, 0);
                        this.vm.call("_array_new_with_size");
                        this.vm.call("_box_arr_r"); // box->helper
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.load(VReg.A1, VReg.FP, objOff);
                        this.vm.call("_array_spread_into");          // RET = 填充后的数组
                        this.vm.store(VReg.FP, arrOff, VReg.RET);
                        this.vm.label(afMapL);
                        this.vm.load(VReg.RET, VReg.FP, arrOff);
                        if (expr.arguments.length >= 2) {
                            // Array.from(x, mapFn, thisArg):第 3 参 thisArg 转发给 map 作 this 绑定
                            const mapArgs = expr.arguments.length >= 3 ? [expr.arguments[1], expr.arguments[2]] : [expr.arguments[1]];
                            this.compileArrayMethod({ type: "Identifier", name: `__afrom_arr_${fid}` }, "map", mapArgs);
                        }
                        return;
                    }
                    // Array.from(typedArray[, mapFn]):typed 布局(raw 数据@16)不能落
                    // _array_slice/_array_map(读 data_ptr@24 越块崩)→ 先 _ta_to_array 转普通
                    // 数组,再(可选)对普通数组 map。
                    if (fromType === Type.TYPED_ARRAY) {
                        this.compileExpression(fromArg);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_ta_to_array"); // RET = 装箱普通数组
                        if (expr.arguments.length >= 2) {
                            const fid = this.nextLabelId();
                            const arrOff = this.ctx.allocLocal(`__afromta_${fid}`);
                            this.vm.store(VReg.FP, arrOff, VReg.RET);
                            // 第 3 参 thisArg 转发给 map
                            const mapArgs = expr.arguments.length >= 3 ? [expr.arguments[1], expr.arguments[2]] : [expr.arguments[1]];
                            this.compileArrayMethod({ type: "Identifier", name: `__afromta_${fid}` }, "map", mapArgs);
                        }
                        return;
                    }
                    const fromInput = fromIsArray
                        ? fromArg
                        : { type: "ArrayExpression", elements: [{ type: "SpreadElement", argument: fromArg }] };
                    if (expr.arguments.length >= 2) {
                        // 第 3 参 thisArg 转发给 map 作 this 绑定
                        const mapArgs = expr.arguments.length >= 3 ? [expr.arguments[1], expr.arguments[2]] : [expr.arguments[1]];
                        if (fromIsArray) {
                            this.compileArrayMethod(fromInput, "map", mapArgs);
                        } else {
                            // 非数组可迭代(生成器/Set/字符串等):合成 [...x] spread 直接喂 map 抽干失败
                            // → 空数组。先把 [...x] **物化**到临时数组(同 OBJECT/TYPED_ARRAY 路),
                            // 再对具名临时 map(Array.from(gen, fn[, thisArg]) 此前返 [] 的根因)。
                            const fid = this.nextLabelId();
                            const arrOff = this.ctx.allocLocal(`__afromit_${fid}`);
                            this.compileExpression(fromInput); // [...x] 物化
                            this.vm.store(VReg.FP, arrOff, VReg.RET);
                            this.compileArrayMethod({ type: "Identifier", name: `__afromit_${fid}` }, "map", mapArgs);
                        }
                    } else if (fromIsArray) {
                        this.compileArrayMethod(fromInput, "slice", []);
                    } else {
                        this.compileExpression(fromInput); // [...x]:生成器/Set/字符串等抽干
                    }
                    return;
                }
            }

            // Object 静态方法
            // Reflect.* 静态方法:脱糖为等价的成员访问/赋值/in/delete/Object.keys 等
            // (Reflect 标识符本身在 asm.js 里非真对象;这里只识别 Reflect.<method>(...) 调用形)。
            if (obj.type === "Identifier" && obj.name === "Reflect") {
                const rargs = expr.arguments;
                // Reflect.get(target, key) → target[key]
                if (prop.name === "get" && rargs.length >= 2) {
                    this.compileExpression({ type: "MemberExpression", object: rargs[0], property: rargs[1], computed: true });
                    return;
                }
                // Reflect.set(target, key, value) → (target[key] = value, true)
                if (prop.name === "set" && rargs.length >= 3) {
                    this.compileExpression({
                        type: "AssignmentExpression", operator: "=",
                        left: { type: "MemberExpression", object: rargs[0], property: rargs[1], computed: true },
                        right: rargs[2],
                    });
                    this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                    return;
                }
                // Reflect.has(target, key) → key in target
                if (prop.name === "has" && rargs.length >= 2) {
                    this.compileExpression({ type: "BinaryExpression", operator: "in", left: rargs[1], right: rargs[0] });
                    return;
                }
                // Reflect.deleteProperty(target, key) → (delete target[key], true)
                if (prop.name === "deleteProperty" && rargs.length >= 2) {
                    this.compileExpression({
                        type: "UnaryExpression", operator: "delete", prefix: true,
                        argument: { type: "MemberExpression", object: rargs[0], property: rargs[1], computed: true },
                    });
                    this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                    return;
                }
                // Reflect.ownKeys(target) → Object.keys(target)(近似:无 symbol 键)
                if (prop.name === "ownKeys" && rargs.length >= 1) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "keys" }, computed: false },
                        arguments: [rargs[0]],
                    });
                    return;
                }
                // Reflect.getPrototypeOf(target) → Object.getPrototypeOf(target)
                if (prop.name === "getPrototypeOf" && rargs.length >= 1) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "getPrototypeOf" }, computed: false },
                        arguments: [rargs[0]],
                    });
                    return;
                }
                // Reflect.defineProperty(target, key, desc) → Object.defineProperty(...) 后返 true
                if (prop.name === "defineProperty" && rargs.length >= 3) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "defineProperty" }, computed: false },
                        arguments: [rargs[0], rargs[1], rargs[2]],
                    });
                    this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                    return;
                }
                // Reflect.apply(fn, thisArg, argsArray) → fn.apply(thisArg, argsArray)
                if (prop.name === "apply" && rargs.length >= 2) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: rargs[0], property: { type: "Identifier", name: "apply" }, computed: false },
                        arguments: rargs.length >= 3 ? [rargs[1], rargs[2]] : [rargs[1]],
                    });
                    return;
                }
                // Reflect.construct(target, argsList[, newTarget]) → new target(...argsList)
                // (newTarget 的 prototype 定制不支持;覆盖常见的"用数组做实参 new"用例)
                if (prop.name === "construct" && rargs.length >= 2) {
                    this.compileExpression({
                        type: "NewExpression",
                        callee: rargs[0],
                        arguments: [{ type: "SpreadElement", argument: rargs[1] }],
                    });
                    return;
                }
                // Reflect.getOwnPropertyDescriptor(target, key) → Object.getOwnPropertyDescriptor(target, key)
                if (prop.name === "getOwnPropertyDescriptor" && rargs.length >= 2) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "getOwnPropertyDescriptor" }, computed: false },
                        arguments: [rargs[0], rargs[1]],
                    });
                    return;
                }
                // Reflect.preventExtensions(target) → (Object.preventExtensions(target), true)
                if (prop.name === "preventExtensions" && rargs.length >= 1) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "preventExtensions" }, computed: false },
                        arguments: [rargs[0]],
                    });
                    this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // true
                    return;
                }
                // Reflect.isExtensible(target) → Object.isExtensible(target)
                if (prop.name === "isExtensible" && rargs.length >= 1) {
                    this.compileExpression({
                        type: "CallExpression",
                        callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "isExtensible" }, computed: false },
                        arguments: [rargs[0]],
                    });
                    return;
                }
            }

            if (obj.type === "Identifier" && obj.name === "Object") {
                // Object.is(a, b) —— SameValue。此前未实现 → 调 miss 崩。脱糖为标准 polyfill,
                // 复用已实现的 ===/!==/// (避开 nan-int0 asm):
                //   (a===b) ? (a!==0 || 1/a===1/b) : (a!==a && b!==b)
                // NaN 支路靠 a!==a(字面量 NaN 已修);-0/+0 支路靠 1/a===1/b(±Infinity)。
                // 两实参**只求值一次**落临时局部再以合成标识符引用:否则对象字面量等每次求值
                // 产生新对象,`a!==a` 变 `{}!=={}`(不同引用)→ true → 误入 NaN 支路,
                // 令 `Object.is({},{})`/`Object.is([],[])` 错返 true(应 false)。
                if (prop.name === "is" && expr.arguments.length >= 2) {
                    const aName = `__objis_a_${this.nextLabelId()}`;
                    const bName = `__objis_b_${this.nextLabelId()}`;
                    const aOff = this.ctx.allocLocal(aName);
                    const bOff = this.ctx.allocLocal(bName);
                    this.compileExpression(expr.arguments[0]);
                    this.vm.store(VReg.FP, aOff, VReg.RET);
                    this.compileExpression(expr.arguments[1]);
                    this.vm.store(VReg.FP, bOff, VReg.RET);
                    const a = { type: "Identifier", name: aName };
                    const b = { type: "Identifier", name: bName };
                    // 用 "Literal"(parser 对数字的真实节点型)而非 "NumericLiteral":
                    // 比较/逻辑 codegen 的静态数字快路只认 "Literal",合成 "NumericLiteral"
                    // 时 `a!==0` 走异路 → Object.is(-0,0) 误真(手写等价式正确,合成式错)。
                    const num = (v) => ({ type: "Literal", value: v });
                    const bin = (op, l, r) => ({ type: "BinaryExpression", operator: op, left: l, right: r });
                    this.compileExpression({
                        type: "ConditionalExpression",
                        test: bin("===", a, b),
                        consequent: {
                            type: "LogicalExpression", operator: "||",
                            left: bin("!==", a, num(0)),
                            right: bin("===", bin("/", num(1), a), bin("/", num(1), b)),
                        },
                        alternate: {
                            type: "LogicalExpression", operator: "&&",
                            left: bin("!==", a, a),
                            right: bin("!==", b, b),
                        },
                    });
                    return;
                }
                // [ES2024] Object.groupBy(items, cbFn) -> {key: [元素...]}
                if (prop.name === "groupBy") {
                    if (expr.arguments.length >= 2) {
                        this.compileExpression(expr.arguments[0]); // items
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.arguments[1]); // cb
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.pop(VReg.A0);
                        this.vm.call("_object_groupBy");
                    } else {
                        // 缺参:空对象(装箱)
                        this.vm.call("_object_new");
                        this.vm.call("_box_obj_r"); // box->helper
                    }
                    return;
                }
                if (prop.name === "keys" || prop.name === "getOwnPropertyNames") {
                    // Object.keys(obj) -> array。getOwnPropertyNames 在本简化模型里(所有自有键
                    // 皆可枚举、无 symbol 键)等价 keys;此前未实现 → 调 miss 崩。近似复用 _object_keys。
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_object_keys");
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                if (prop.name === "getOwnPropertySymbols") {
                    // Object.getOwnPropertySymbols(obj) -> 仅 symbol 键数组(Object.keys 的反面)
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_object_getOwnPropertySymbols");
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                if (prop.name === "values") {
                    // Object.values(obj) -> array
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_object_values");
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                if (prop.name === "entries") {
                    // Object.entries(obj) -> [[key, value], ...]
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_object_entries");
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                // [#35] Object.hasOwn(o, k) → 既有 _object_has(不查原型链,语义吻合)
                if (prop.name === "hasOwn") {
                    if (expr.arguments.length >= 2) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.arguments[1]);
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.pop(VReg.A0);
                        this.vm.call("_object_has"); // RET = 0/1
                        // 0/1 → JS 布尔
                        const hoT = this.ctx.newLabel("hasown_t");
                        const hoE = this.ctx.newLabel("hasown_e");
                        this.vm.cmpImm(VReg.RET, 0);
                        this.vm.jne(hoT);
                        this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
                        this.vm.jmp(hoE);
                        this.vm.label(hoT);
                        this.vm.movImm64(VReg.RET, 0x7ff9000000000001n); // was lea+load _js const
                        this.vm.label(hoE);
                    } else {
                        this.vm.movImm64(VReg.RET, 0x7ff9000000000000n); // was lea+load _js const
                    }
                    return;
                }
                // [#61 P1] Object.freeze/seal/preventExtensions —— 对象级冻结位。
                // 接收者求值入 A0,调运行时 helper(返回原对象;非对象接收者不崩,
                // helper 内 tag 守卫直接返回原值)。
                if (prop.name === "freeze" || prop.name === "seal" ||
                    prop.name === "preventExtensions") {
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call(
                            prop.name === "freeze" ? "_object_freeze" :
                            prop.name === "seal" ? "_object_seal" :
                            "_object_preventExtensions"
                        );
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                // [#61 P1] Object.isFrozen/isSealed/isExtensible —— helper 直接返回
                // 装箱布尔(js_true/js_false)。非对象接收者语义由 helper 内守卫处理
                // (isFrozen/isSealed→true、isExtensible→false)。
                if (prop.name === "isFrozen" || prop.name === "isSealed" ||
                    prop.name === "isExtensible") {
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call(
                            prop.name === "isFrozen" ? "_object_isFrozen" :
                            prop.name === "isSealed" ? "_object_isSealed" :
                            "_object_isExtensible"
                        );
                    } else {
                        // 无参:ES Object.isExtensible(undefined) → false,
                        // isFrozen/isSealed(undefined) → true。
                        this.vm.lea(VReg.RET, prop.name === "isExtensible" ? "_js_false" : "_js_true");
                        this.vm.load(VReg.RET, VReg.RET, 0);
                    }
                    return;
                }
                // [#35] Object.fromEntries(entries) —— 内联展开(同 new Map(entries)
                // 模板):_object_new 后逐条 [k,v] _object_set
                if (prop.name === "fromEntries") {
                    if (expr.arguments.length > 0) {
                        // 非静态数组的 entries(Map/Set/生成器/自定义可迭代)先 [...x] 展开成数组
                        // (`[...map]` 现产装箱 [k,v] 对);此前当数组读 _array_length → Map 崩。
                        let feArg = expr.arguments[0];
                        if (inferType(feArg, this.ctx) !== Type.ARRAY) {
                            feArg = { type: "ArrayExpression",
                                elements: [{ type: "SpreadElement", argument: feArg }] };
                        }
                        this.compileExpression(feArg); // boxed entries 数组
                        const feSrc = this.ctx.allocLocal(`__fe_src_${this.nextLabelId()}`);
                        this.vm.store(VReg.FP, feSrc, VReg.RET);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_array_length");
                        const feLen = this.ctx.allocLocal(`__fe_len_${this.nextLabelId()}`);
                        this.vm.store(VReg.FP, feLen, VReg.RET);
                        this.vm.call("_object_new");
                        // 装箱 0x7FFD
                        this.vm.call("_box_obj_r"); // box->helper
                        const feObj = this.ctx.allocLocal(`__fe_obj_${this.nextLabelId()}`);
                        this.vm.store(VReg.FP, feObj, VReg.RET);
                        const feEnt = this.ctx.allocLocal(`__fe_ent_${this.nextLabelId()}`);
                        const feKey = this.ctx.allocLocal(`__fe_key_${this.nextLabelId()}`);
                        const feIdx = this.ctx.allocLocal(`__fe_idx_${this.nextLabelId()}`);
                        this.vm.movImm(VReg.V0, 0);
                        this.vm.store(VReg.FP, feIdx, VReg.V0);
                        const feLoop = this.ctx.newLabel("fe_loop");
                        const feDone = this.ctx.newLabel("fe_done");
                        this.vm.label(feLoop);
                        this.vm.load(VReg.V0, VReg.FP, feIdx);
                        this.vm.load(VReg.V1, VReg.FP, feLen);
                        this.vm.cmp(VReg.V0, VReg.V1);
                        this.vm.jge(feDone);
                        this.vm.load(VReg.A0, VReg.FP, feSrc);
                        this.vm.load(VReg.A1, VReg.FP, feIdx);
                        this.vm.call("_array_get"); // entry [k,v]
                        this.vm.store(VReg.FP, feEnt, VReg.RET);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.movImm(VReg.A1, 0);
                        this.vm.call("_array_get");
                        this.vm.store(VReg.FP, feKey, VReg.RET);
                        // ToPropertyKey:JS 对象键恒字符串,数值键须 ToString(`fromEntries([[2,"b"]])`
                        // 的 2 → 键 "2",故 obj[2]/obj["2"] 命中)。此前把裸数值键喂 _object_set →
                        // 数值位当键存,字符串访问 miss、多数值键相互丢失(keys 只剩一个)。
                        // 非字符串(tag≠0x7FFC)→ _valueToStr 转串;字符串原样。
                        const feKeyStr = this.ctx.newLabel("fe_key_str");
                        this.vm.shrImm(VReg.V1, VReg.RET, 48);
                        this.vm.cmpImm(VReg.V1, 0x7FFC);
                        this.vm.jeq(feKeyStr);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_valueToStr");
                        this.vm.store(VReg.FP, feKey, VReg.RET);
                        this.vm.label(feKeyStr);
                        this.vm.load(VReg.A0, VReg.FP, feEnt);
                        this.vm.movImm(VReg.A1, 1);
                        this.vm.call("_array_get");
                        this.vm.mov(VReg.A2, VReg.RET);
                        this.vm.load(VReg.A1, VReg.FP, feKey);
                        this.vm.load(VReg.A0, VReg.FP, feObj);
                        this.vm.call("_object_set");
                        this.vm.load(VReg.V0, VReg.FP, feIdx);
                        this.vm.addImm(VReg.V0, VReg.V0, 1);
                        this.vm.store(VReg.FP, feIdx, VReg.V0);
                        this.vm.jmp(feLoop);
                        this.vm.label(feDone);
                        this.vm.load(VReg.RET, VReg.FP, feObj);
                    } else {
                        this.vm.call("_object_new");
                        this.vm.call("_box_obj_r"); // box->helper
                    }
                    return;
                }
                if (prop.name === "assign") {
                    // Object.assign(target, ...sources) —— [#28] 逐 source 链式
                    // _object_assign(返回 boxed target,可直接作下一轮 A0);
                    // 原实现只消费第一个 source,第三参起静默丢弃。
                    // 求值顺序:target 先、sources 依次(与 ES 一致)。
                    // [spread] 若 source 含 SpreadElement(Object.assign({}, ...srcs)):
                    // 原逐参路径把 SpreadElement 当单个 source 喂 _object_assign → 丢全部展开源
                    // (返回空/仅 target)。改为:target 落槽,余参经 compileArrayExpressionWithSpread
                    // 建成 sources 数组,运行时逐元素 _object_assign。
                    const asgnHasSpread = expr.arguments.slice(1).some((a) => a && a.type === "SpreadElement");
                    if (asgnHasSpread && expr.arguments.length >= 2) {
                        const tgtOff = this.ctx.allocLocal(`__assign_tgt_${this.nextLabelId()}`);
                        this.compileExpression(expr.arguments[0]);
                        this.vm.store(VReg.FP, tgtOff, VReg.RET);
                        this.compileArrayExpressionWithSpread(expr.arguments.slice(1)); // RET = 源数组(boxed)
                        const srcOff = this.ctx.allocLocal(`__assign_src_${this.nextLabelId()}`);
                        this.vm.store(VReg.FP, srcOff, VReg.RET);
                        const lenOff = this.ctx.allocLocal(`__assign_len_${this.nextLabelId()}`);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_array_length");
                        this.vm.store(VReg.FP, lenOff, VReg.RET);
                        const idxOff = this.ctx.allocLocal(`__assign_idx_${this.nextLabelId()}`);
                        this.vm.movImm(VReg.V0, 0);
                        this.vm.store(VReg.FP, idxOff, VReg.V0);
                        const loopL = this.ctx.newLabel("assign_sp_loop");
                        const doneL = this.ctx.newLabel("assign_sp_done");
                        this.vm.label(loopL);
                        this.vm.load(VReg.V0, VReg.FP, idxOff);
                        this.vm.load(VReg.V1, VReg.FP, lenOff);
                        this.vm.cmp(VReg.V0, VReg.V1);
                        this.vm.jge(doneL);
                        this.vm.load(VReg.A0, VReg.FP, srcOff);
                        this.vm.load(VReg.A1, VReg.FP, idxOff);
                        this.vm.call("_array_get");          // RET = sources[idx]
                        this.vm.mov(VReg.A1, VReg.RET);      // source
                        this.vm.load(VReg.A0, VReg.FP, tgtOff); // target
                        this.vm.call("_object_assign");
                        this.vm.store(VReg.FP, tgtOff, VReg.RET); // 更新 target
                        this.vm.load(VReg.V0, VReg.FP, idxOff);
                        this.vm.addImm(VReg.V0, VReg.V0, 1);
                        this.vm.store(VReg.FP, idxOff, VReg.V0);
                        this.vm.jmp(loopL);
                        this.vm.label(doneL);
                        this.vm.load(VReg.RET, VReg.FP, tgtOff);
                        return;
                    }
                    if (expr.arguments.length >= 2) {
                        this.compileExpression(expr.arguments[0]);
                        for (let ai = 1; ai < expr.arguments.length; ai++) {
                            this.vm.push(VReg.RET); // 当前 target
                            this.compileExpression(expr.arguments[ai]);
                            this.vm.mov(VReg.A1, VReg.RET); // source
                            this.vm.pop(VReg.A0);
                            this.vm.call("_object_assign");
                        }
                    } else if (expr.arguments.length === 1) {
                        this.compileExpression(expr.arguments[0]);
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                if (prop.name === "create") {
                    // Object.create(proto[, descriptors])
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                    } else {
                        this.vm.movImm(VReg.A0, 0);
                    }
                    this.vm.call("_object_create");
                    // 第二参属性描述符(对象字面量):脱糖为 Object.defineProperties(创建对象, descs),
                    // 复用其静态描述符路径(defineProperties 返回目标对象即 create 结果)。
                    if (expr.arguments.length >= 2 && expr.arguments[1] &&
                        expr.arguments[1].type === "ObjectExpression") {
                        const cName = `__ocreate_${this.nextLabelId()}`;
                        this.ctx.allocLocal(cName);
                        this.vm.store(VReg.FP, this.ctx.getLocal(cName), VReg.RET);
                        this.compileExpression({
                            type: "CallExpression",
                            callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "defineProperties" }, computed: false },
                            arguments: [{ type: "Identifier", name: cName }, expr.arguments[1]],
                        });
                    }
                    return;
                }
                if (prop.name === "hasOwn") {
                    // Object.hasOwn(obj, key)
                    if (expr.arguments.length >= 2) {
                        this.compileExpression(expr.arguments[1]);
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.arguments[0]);
                        this.vm.pop(VReg.A1);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_object_has");
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                if (prop.name === "getPrototypeOf") {
                    // Object.getPrototypeOf(obj)
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_object_getPrototypeOf");
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                if (prop.name === "setPrototypeOf") {
                    // Object.setPrototypeOf(obj, proto)
                    if (expr.arguments.length >= 2) {
                        this.compileExpression(expr.arguments[1]);
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.arguments[0]);
                        this.vm.pop(VReg.A1);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_object_setPrototypeOf");
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    return;
                }
                // [#58 B2] Object.defineProperty(obj, key, descriptor)
                //   accessor 描述符 {get,set} → 建 24B TYPE_GETTER 标记 {type@0,getter@8,
                //     setter@16} 经 _object_define 挂属性(复用 _maybe_getter 读取设施);
                //   data 描述符 {value} → 值直接 _object_define。
                //   仅支持 descriptor 为对象字面量(静态可析);动态描述符记偏差。
                if (prop.name === "defineProperty") {
                    const desc = expr.arguments[2];
                    // 求 obj、key 到 FP 槽(闭包/值编译途中可能 GC,保守栈扫描保活)
                    const dpObj = this.ctx.allocLocal(`__dp_obj_${this.nextLabelId()}`);
                    const dpKey = this.ctx.allocLocal(`__dp_key_${this.nextLabelId()}`);
                    if (expr.arguments.length > 0) this.compileExpression(expr.arguments[0]);
                    else this.vm.movImm(VReg.RET, 0);
                    this.vm.store(VReg.FP, dpObj, VReg.RET);
                    if (expr.arguments.length > 1) this.compileExpression(expr.arguments[1]);
                    else this.vm.movImm(VReg.RET, 0);
                    this.vm.store(VReg.FP, dpKey, VReg.RET);

                    // [proxy] 目标运行时为 Proxy(type==8)→ 走 defineProperty 陷阱:整份
                    // 描述符对象求值后交 handler.defineProperty(target,key,desc)。普通对象
                    // (type≠8)落常规静态分解路径,逐字节不变。
                    const dpNormalLabel = this.ctx.newLabel("dp_normal");
                    const dpDoneLabel = this.ctx.newLabel("dp_done");
                    this.vm.load(VReg.RET, VReg.FP, dpObj);
                    this.vm.emitMaskLoad(VReg.V1);
                    this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1); // 裸指针
                    this.vm.cmpImm(VReg.V0, 0);
                    this.vm.jeq(dpNormalLabel);
                    this.vm.loadByte(VReg.V1, VReg.V0, 0);
                    this.vm.cmpImm(VReg.V1, 8); // TYPE_PROXY
                    this.vm.jne(dpNormalLabel);
                    // proxy 分支:求值整份描述符对象 → 陷阱
                    if (desc) this.compileExpression(desc);
                    else this.vm.movImm64(VReg.RET, 0x7ffb000000000000n);
                    this.vm.mov(VReg.A2, VReg.RET); // descObj
                    this.vm.load(VReg.A0, VReg.FP, dpObj);
                    this.vm.load(VReg.A1, VReg.FP, dpKey);
                    this.vm.call("_object_defineProperty_proxy");
                    this.vm.load(VReg.RET, VReg.FP, dpObj);
                    this.vm.jmp(dpDoneLabel);
                    this.vm.label(dpNormalLabel);
                    this._dpDoneLabel = dpDoneLabel; // 供末尾 load 前落 done 标签

                    // 从对象字面量描述符提取 get/set/value 节点 + [#61 P2] attrs
                    // (writable/enumerable/configurable);defineProperty 缺省全 false,
                    // 从布尔字面量提取(非字面量或缺省 → false)。
                    let getterNode = null, setterNode = null, valueNode = null, hasValue = false;
                    let wr = false, en = false, cf = false;
                    if (desc && desc.type === "ObjectExpression") {
                        for (const p of desc.properties) {
                            if (!p.key) continue;
                            const kn = p.key.name || p.key.value;
                            if (kn === "get") getterNode = p.value;
                            else if (kn === "set") setterNode = p.value;
                            else if (kn === "value") { valueNode = p.value; hasValue = true; }
                            else if (kn === "writable") wr = !!(p.value && p.value.type === "Literal" && p.value.value === true);
                            else if (kn === "enumerable") en = !!(p.value && p.value.type === "Literal" && p.value.value === true);
                            else if (kn === "configurable") cf = !!(p.value && p.value.type === "Literal" && p.value.value === true);
                        }
                    }
                    const dpAttr = (wr ? 1 : 0) | (en ? 2 : 0) | (cf ? 4 : 0);

                    if (getterNode || setterNode) {
                        // accessor:24B {TYPE_GETTER@0, getter@8, setter@16}
                        const TYPE_GETTER = 60;
                        const dpMark = this.ctx.allocLocal(`__dp_mark_${this.nextLabelId()}`);
                        this.vm.movImm(VReg.A0, 24);
                        this.vm.call("_alloc");
                        this.vm.store(VReg.FP, dpMark, VReg.RET);
                        this.vm.movImm(VReg.V1, TYPE_GETTER);
                        this.vm.store(VReg.RET, 0, VReg.V1);
                        this.vm.movImm(VReg.V1, 0);
                        this.vm.store(VReg.RET, 8, VReg.V1);
                        this.vm.store(VReg.RET, 16, VReg.V1);
                        if (getterNode) {
                            this.compileExpression(getterNode);       // 装箱闭包
                            this.vm.emitMaskLoad(VReg.V1);
                            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);   // 脱壳裸指针
                            this.vm.load(VReg.V1, VReg.FP, dpMark);
                            this.vm.store(VReg.V1, 8, VReg.V0);
                        }
                        if (setterNode) {
                            this.compileExpression(setterNode);
                            this.vm.emitMaskLoad(VReg.V1);
                            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
                            this.vm.load(VReg.V1, VReg.FP, dpMark);
                            this.vm.store(VReg.V1, 16, VReg.V0);
                        }
                        this.vm.load(VReg.A2, VReg.FP, dpMark);        // value = 标记裸指针
                    } else {
                        // data 描述符:value(缺省 undefined)
                        if (hasValue) {
                            this.compileExpression(valueNode);
                        } else {
                            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
                        }
                        this.vm.mov(VReg.A2, VReg.RET);
                    }
                    this.vm.load(VReg.A0, VReg.FP, dpObj);
                    this.vm.load(VReg.A1, VReg.FP, dpKey);
                    this.vm.call("_object_define");
                    // [#61 P2] 落 per-property attrs(defineProperty 缺省全 false,与普通
                    // 赋值的全 true 相区别)。materialize flags + 置 EXT_HASFLAGS 迫 IC 慢路。
                    this.vm.load(VReg.A0, VReg.FP, dpObj);
                    this.vm.load(VReg.A1, VReg.FP, dpKey);
                    this.vm.movImm(VReg.A2, dpAttr);
                    this.vm.call("_object_set_prop_attr");
                    // defineProperty 返回原对象(proxy 分支在此汇合)
                    this.vm.label(this._dpDoneLabel);
                    this.vm.load(VReg.RET, VReg.FP, dpObj);
                    return;
                }
                // Object.defineProperties(obj, {k1: desc1, k2: desc2, ...}):脱糖为逐 key 的
                // Object.defineProperty 调用序列(复用其静态描述符路径),末位求值 obj 作返回值。
                // 仅支持描述符集合为对象字面量、键静态可析(与 defineProperty 同约束);
                // obj 在每次 defineProperty 里重求值(与用户手写多条 defineProperty 同语义,
                // 对标识符/成员目标正确;副作用型目标会重复求值,记偏差)。
                if (prop.name === "defineProperties" && expr.arguments.length >= 2 &&
                    expr.arguments[1] && expr.arguments[1].type === "ObjectExpression") {
                    const descs = expr.arguments[1];
                    // obj 只求值一次落临时局部,再用同名合成标识符引用——避免对象字面量等
                    // 副作用/非幂等目标被每条 defineProperty 重求值出不同对象。
                    const tmpName = `__defprops_obj_${this.nextLabelId()}`;
                    const tmpOff = this.ctx.allocLocal(tmpName);
                    this.compileExpression(expr.arguments[0]);
                    this.vm.store(VReg.FP, tmpOff, VReg.RET);
                    const objRef = { type: "Identifier", name: tmpName };
                    const dpCallee = {
                        type: "MemberExpression",
                        object: expr.callee.object,
                        property: { type: "Identifier", name: "defineProperty" },
                        computed: false,
                    };
                    const seq = [];
                    for (const p of descs.properties) {
                        if (!p.key || p.computed) continue; // 计算键不静态可析,跳过(记偏差)
                        const keyStr = p.key.name != null ? p.key.name : p.key.value;
                        seq.push({
                            type: "CallExpression",
                            callee: dpCallee,
                            arguments: [objRef, { type: "Literal", value: String(keyStr) }, p.value],
                        });
                    }
                    seq.push(objRef); // 返回原对象
                    this.compileExpression({ type: "SequenceExpression", expressions: seq });
                    return;
                }
                // [#61 P2] Object.getOwnPropertyDescriptor(obj, key)
                if (prop.name === "getOwnPropertyDescriptor") {
                    // [t477/t671] 静态解析:gOPD(<用户函数/内联函数表达式>, "name"|"length")
                    // → 合成规范描述符 {value:<静态>, writable:false, enumerable:false,
                    // configurable:true}(node 语义)。其余走通用运行时路,逐字节不变。
                    if (expr.arguments.length >= 2 &&
                        expr.arguments[1] && expr.arguments[1].type === "Literal" &&
                        (expr.arguments[1].value === "name" || expr.arguments[1].value === "length")) {
                        const gArg0 = expr.arguments[0];
                        let gMeta = null;
                        if (gArg0 && (gArg0.type === "FunctionExpression" ||
                            gArg0.type === "ArrowFunctionExpression" || gArg0.type === "ClassExpression")) {
                            // 内联函数/类表达式:直接从节点取 name/arity(无绑定名则 "")
                            const gp = gArg0.type === "ClassExpression"
                                ? (this._classCtorParams ? this._classCtorParams(gArg0) : [])
                                : (gArg0.params || []);
                            let gAr = 0;
                            for (let gi = 0; gi < gp.length; gi++) {
                                const gt = gp[gi].type;
                                if (gt === "AssignmentPattern" || gt === "SpreadElement" || gt === "RestElement") break;
                                gAr++;
                            }
                            gMeta = { name: (gArg0.id && gArg0.id.name) ? gArg0.id.name : "", length: gAr };
                        } else if (gArg0 && this._fnNameLength) {
                            gMeta = this._fnNameLength(gArg0);
                        }
                        if (gMeta) {
                            const key = expr.arguments[1].value;
                            this.compileExpression({
                                type: "ObjectExpression",
                                properties: [
                                    { key: { type: "Identifier", name: "value" }, kind: "init",
                                      value: key === "name"
                                          ? { type: "Literal", value: gMeta.name }
                                          : { type: "Literal", value: gMeta.length } },
                                    { key: { type: "Identifier", name: "writable" }, kind: "init",
                                      value: { type: "Literal", value: false } },
                                    { key: { type: "Identifier", name: "enumerable" }, kind: "init",
                                      value: { type: "Literal", value: false } },
                                    { key: { type: "Identifier", name: "configurable" }, kind: "init",
                                      value: { type: "Literal", value: true } },
                                ],
                            });
                            return;
                        }
                    }
                    if (expr.arguments.length >= 2) {
                        this.compileExpression(expr.arguments[0]); // obj
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.arguments[1]); // key
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.pop(VReg.A0);
                        this.vm.call("_object_getOwnPropertyDescriptor");
                    } else {
                        this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
                    }
                    return;
                }
                // Object.getOwnPropertyDescriptors(obj):脱糖为
                // Object.fromEntries(Object.keys(obj).map(k => [k, Object.getOwnPropertyDescriptor(obj, k)]))。
                // obj 只求值一次落临时局部,map 箭头以合成标识符引用(闭包捕获)。
                if (prop.name === "getOwnPropertyDescriptors" && expr.arguments.length >= 1) {
                    const oName = `__gopds_${this.nextLabelId()}`;
                    const oOff = this.ctx.allocLocal(oName);
                    this.compileExpression(expr.arguments[0]);
                    this.vm.store(VReg.FP, oOff, VReg.RET);
                    const objRef = { type: "Identifier", name: oName };
                    const kRef = { type: "Identifier", name: "k" };
                    const eRef = { type: "Identifier", name: "e" };
                    const mem = (o, p) => ({ type: "MemberExpression", object: o, property: { type: "Identifier", name: p }, computed: false });
                    const call = (c, a) => ({ type: "CallExpression", callee: c, arguments: a });
                    const OBJ = { type: "Identifier", name: "Object" };
                    // .filter(e => e[1] !== undefined):跳过描述符为 undefined 的键(Proxy 的
                    // getOwnPropertyDescriptor 陷阱返 undefined 时不得进结果,es-compat t717)。
                    // 普通对象自有键描述符恒非 undefined → filter 无操作、逐字节不影响。
                    this.compileExpression(call(mem(OBJ, "fromEntries"), [
                        call(mem(call(mem(call(mem(OBJ, "keys"), [objRef]), "map"), [{
                            type: "ArrowFunctionExpression", params: [kRef], expression: true,
                            body: { type: "ArrayExpression", elements: [kRef, call(mem(OBJ, "getOwnPropertyDescriptor"), [objRef, kRef])] },
                        }]), "filter"), [{
                            type: "ArrowFunctionExpression", params: [eRef], expression: true,
                            body: { type: "BinaryExpression", operator: "!==",
                                left: { type: "MemberExpression", object: eRef, property: { type: "Literal", value: 1 }, computed: true },
                                right: { type: "Identifier", name: "undefined" } },
                        }]),
                    ]));
                    return;
                }
            }

            // Date 静态方法 (Date.now())
            if (obj.type === "Identifier" && obj.name === "Date") {
                if (prop.name === "now") {
                    this.vm.call("_date_now");
                    return;
                }
                // [#45] Date.UTC(y,mo?,d?,...) -> UTC 毫秒(number,非 Date)。同源历法。
                if (prop.name === "UTC") {
                    this.emitDateUTCms(expr.arguments);
                    return;
                }
                // Date.parse(str) -> ms(裸 float number),非法 → NaN
                if (prop.name === "parse") {
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_date_parse_iso");
                    } else {
                        this.vm.movImm64(VReg.RET, 0x7FF8000000000000n); // NaN
                    }
                    return;
                }
            }

            // [ES2024] Map 静态方法 (Map.groupBy)
            if (obj.type === "Identifier" && obj.name === "Map") {
                if (prop.name === "groupBy") {
                    if (expr.arguments.length >= 2) {
                        this.compileExpression(expr.arguments[0]); // items
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.arguments[1]); // cb
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.pop(VReg.A0);
                        this.vm.call("_map_groupBy"); // 返回裸 Map 指针
                    } else {
                        this.vm.call("_map_new");
                    }
                    return;
                }
            }

            // [ES2025] RegExp.escape(str) —— 转义正则元字符。派发到 __regexp_shim
            // 的纯 JS 实现 __RE_escape(路线同 __RE_new);shim import 由 readModuleSource
            // 在源码含 "RegExp.escape" 时注入。
            if (obj.type === "Identifier" && obj.name === "RegExp" &&
                prop.name === "escape") {
                this.compileExpression({
                    type: "CallExpression",
                    callee: { type: "Identifier", name: "__RE_escape" },
                    arguments: [
                        expr.arguments.length >= 1 ? expr.arguments[0] : { type: "Literal", value: "" },
                    ],
                });
                return;
            }

            // Promise 静态方法 (Promise.resolve(), Promise.reject(), Promise.all(), Promise.race(), Promise.allSettled())
            if (obj.type === "Identifier" && obj.name === "Promise") {
                if (prop.name === "resolve") {
                    // Promise.resolve(value) - 创建已 resolved 的 Promise
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_Promise_resolve");
                    return;
                }
                if (prop.name === "reject") {
                    // Promise.reject(reason) - 创建已 rejected 的 Promise
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_Promise_reject");
                    return;
                }
                if (prop.name === "all") {
                    // Promise.all(iterable) - 等待所有 Promise 完成
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_Promise_all");
                    return;
                }
                if (prop.name === "race") {
                    // Promise.race(iterable) - 任意一个 Promise 完成
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_Promise_race");
                    return;
                }
                if (prop.name === "allSettled") {
                    // Promise.allSettled(iterable) - 等待所有 Promise settled
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_Promise_allSettled");
                    return;
                }
                if (prop.name === "any") {
                    // [#35] Promise.any(iterable) —— 首个 fulfilled 胜出
                    if (expr.arguments.length > 0) {
                        this.compileExpression(expr.arguments[0]);
                    } else {
                        this.vm.movImm(VReg.RET, 0);
                    }
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_Promise_any");
                    return;
                }
                if (prop.name === "withResolvers") {
                    // [ES2024] Promise.withResolvers() -> { promise, resolve, reject }
                    this.vm.call("_Promise_withResolvers");
                    return;
                }
                if (prop.name === "try") {
                    // [ES2025] Promise.try(fn):同步调 fn(),返回值/同步 throw 包成
                    // resolved/rejected promise。经内联异常帧捕获同步 throw。
                    this.compilePromiseTry(expr);
                    return;
                }
            }

            // [#35] p.finally(cb):调用 cb() 后透传原 promise
            if (prop && prop.type === "Identifier" && prop.name === "finally" &&
                expr.arguments.length > 0) {
                this.compileExpression(obj);
                this.vm.push(VReg.RET);
                this.compileExpression(expr.arguments[0]);
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.pop(VReg.A0);
                this.vm.call("_promise_finally");
                return;
            }

            // Promise 实例方法
            // p.then(cb) / p.catch(cb)
            if (prop && prop.type === "Identifier" && (prop.name === "then" || prop.name === "catch")) {
                // then(onF, onR):双回调,onF 挂 fulfill 链、onR 挂 reject 链、共享 next。
                if (prop.name === "then" && expr.arguments.length >= 2) {
                    this.compileExpression(obj);
                    this.vm.push(VReg.RET);                  // promise
                    this.compileExpression(expr.arguments[0]);
                    this.vm.push(VReg.RET);                  // onF
                    this.compileExpression(expr.arguments[1]);
                    this.vm.mov(VReg.A2, VReg.RET);          // onR
                    this.vm.pop(VReg.A1);                    // onF
                    this.vm.pop(VReg.A0);                    // promise
                    this.vm.call("_promise_then2");
                    return;
                }
                // 只支持单个回调参数
                if (expr.arguments.length > 0) {
                    // 先编译 promise 对象
                    this.compileExpression(obj);
                    this.vm.push(VReg.RET);

                    // 再编译回调（闭包对象或函数指针）
                    this.compileExpression(expr.arguments[0]);
                    this.vm.mov(VReg.A1, VReg.RET);

                    // 调用运行时
                    this.vm.pop(VReg.A0);
                    if (prop.name === "then") {
                        this.vm.call("_promise_then");
                    } else {
                        this.vm.call("_promise_catch");
                    }
                } else {
                    // 没有回调参数：退化为返回原 promise
                    this.compileExpression(obj);
                }
                return;
            }

            // 零参 valueOf():对基本类型(数字/字符串/布尔/数组/符号)恒等返回接收者;
            // Date 对象 → getTime(时间戳数值);其余对象 → 恒等(默认 valueOf 返回自身)。
            // 此前 valueOf 在 HOISTED_DATE_METHODS 里被无条件当 Date 方法派发,对数字接收者
            // 读 Date 字段 → 段错误((42).valueOf() 崩根因)。
            // (记偏差:用户对象覆写的 valueOf 经显式 .valueOf() 调用不触发,返回对象本身。)
            if (prop.name === "valueOf" && !callee.computed && expr.arguments.length === 0) {
                const voIdLbl = this.ctx.newLabel("valof_id");
                const voEndLbl = this.ctx.newLabel("valof_end");
                this.compileExpression(obj); // RET = 接收者
                // 仅装箱对象(0x7FFD)可能是 Date;其余一律恒等。
                this.vm.shrImm(VReg.V2, VReg.RET, 48);
                this.vm.cmpImm(VReg.V2, 0x7FFD);
                this.vm.jne(voEndLbl); // 非对象 → RET 已是接收者,原样返回
                this.vm.push(VReg.RET); // 存对象(x64 V0==RET)
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
                this.vm.loadByte(VReg.V0, VReg.V0, 0); // 头类型字节
                this.vm.cmpImm(VReg.V0, 7); // TYPE_DATE
                this.vm.jne(voIdLbl);
                this.vm.pop(VReg.A0);
                this.vm.call("_date_getTime"); // Date → 时间戳
                this.vm.jmp(voEndLbl);
                this.vm.label(voIdLbl);
                this.vm.pop(VReg.RET); // 其余对象 → 恒等
                this.vm.label(voEndLbl);
                return;
            }

            // [#42] 零参 toString():运行时 tag 分派。此前只接带 radix 形态,
            // 零参落通用对象方法把 NaN-box double 当指针解引 → 段错误。
            // 数字(含装箱 int/负 double)→ _num_toString(10);字符串恒等;
            // 对象/数组落通用用户方法路径(结构镜像下方 push 的非数组分支)。
            if (prop.name === "toString" && !callee.computed && expr.arguments.length === 0) {
                const tsNumLbl = this.ctx.newLabel("tostr_num");
                const tsStrLbl = this.ctx.newLabel("tostr_str");
                const tsSymLbl = this.ctx.newLabel("tostr_sym");
                const tsBiLbl = this.ctx.newLabel("tostr_bigint");
                const tsEndLbl = this.ctx.newLabel("tostr_end");
                this.compileExpression(obj);
                this.vm.push(VReg.RET); // 存 obj(通用/字符串路径复用;x64 V0==RET)
                this.vm.shrImm(VReg.V2, VReg.RET, 48);
                // Symbol 接收者(裸堆指针 high16==0):运行时 _is_symbol 判别后走
                // _symbol_to_string("Symbol(desc)")。此前 high16==0 落数字路径把
                // 符号裸指针当 double 格式化 → "0"(#65)。
                this.vm.cmpImm(VReg.V2, 0);
                this.vm.jeq(tsSymLbl);
                // 数字 = 高16 ∉ [0x7FF9,0x7FFF](0x7FF8 装箱 int 也是数字;>0x7FFF 为负 double)
                this.vm.cmpImm(VReg.V2, 0x7FF9);
                this.vm.jlt(tsNumLbl);
                this.vm.cmpImm(VReg.V2, 0x7FFF);
                this.vm.jgt(tsNumLbl);
                this.vm.cmpImm(VReg.V2, 0x7FFC);
                this.vm.jeq(tsStrLbl);
                // [#62] Date(装箱 0x7ffd,对象头字节==TYPE_DATE(7))→ ISO 串(_date_toString)。
                // 普通对象/数组落下方通用用户方法。缺此判:装箱 Date 会走通用路径取到
                // undefined toString 再调用而崩(d.toString()/String(d) 段错误根因)。
                // 守门:仅对象 tag(0x7ffd)才可能是装箱 Date 且低48位必是有效堆指针;
                // bool/null/undef(0x7ff9..0x7ffb)低48位是 1/2/3 等小值,无守门直接
                // loadByte 会解引用非法地址段错误(true.toString() 崩根因),故先判 tag。
                const tsDateLbl = this.ctx.newLabel("tostr_date");
                const tsErrLbl = this.ctx.newLabel("tostr_err");
                const tsGenLbl = this.ctx.newLabel("tostr_generic");
                this.vm.cmpImm(VReg.V2, 0x7FFD);
                this.vm.jne(tsGenLbl);
                // [#36] Error 族对象.toString() → "name: message"(否则落通用路径找不到
                // toString 方法而崩)。obj 仍在栈顶,装箱 0x7FFD。
                this.vm.load(VReg.A0, VReg.SP, 0);
                this.vm.call("_is_asmjs_err");
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jne(tsErrLbl);
                this.vm.load(VReg.V0, VReg.SP, 0);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                this.vm.loadByte(VReg.V0, VReg.V0, 0);
                this.vm.cmpImm(VReg.V0, 7);
                this.vm.jeq(tsDateLbl);
                this.vm.label(tsGenLbl);
                // 通用:用户对象方法;若无用户 toString(数组/plain 对象)则回退默认转换。
                {
                    const tsLbl = this.asm.addString("toString");
                    this.vm.load(VReg.A0, VReg.SP, 0);
                    this.vm.lea(VReg.A1, tsLbl);
                    this.vm.call("_tag_str_a1"); // key box->helper
                    this.vm.call("_object_get");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.SP, 0);
                    this.vm.call("_maybe_getter");
                    this.vm.mov(VReg.V6, VReg.RET);
                    // 守卫:_object_get 未取到用户 toString(非函数 tag 0x7FFF)——数组、
                    // plain 对象、无覆写的对象——回退运行时 _valueToStr(数组→"1,2,3"、
                    // 对象→"[object Object]")。此前直接对 miss 值 compileMethodCall → 崩
                    // (`({}).toString()`/`[1,2].toString()` 段错误根因;隐式 `""+o` 走
                    // _valueToStr 故一直正常,掩盖了显式 .toString() 崩)。
                    const tsUserL = this.ctx.newLabel("tostr_user");
                    this.vm.shrImm(VReg.V0, VReg.V6, 48);
                    this.vm.cmpImm(VReg.V0, 0x7FFF);
                    this.vm.jeq(tsUserL);
                    this.vm.pop(VReg.A0); // obj(平衡栈)
                    this.vm.call("_valueToStr");
                    this.vm.jmp(tsEndLbl);
                    this.vm.label(tsUserL);
                    this.vm.pop(VReg.V5);
                    this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
                }
                this.vm.jmp(tsEndLbl);
                this.vm.label(tsDateLbl);
                this.vm.pop(VReg.A0); // 平衡栈(obj)
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1);
                this.vm.call("_date_toString");
                this.vm.jmp(tsEndLbl);
                this.vm.label(tsErrLbl); // [#36] Error 对象 → "name: message"
                this.vm.pop(VReg.A0); // 平衡栈(obj,装箱 0x7FFD)
                this.vm.call("_error_to_str");
                this.vm.jmp(tsEndLbl);
                this.vm.label(tsStrLbl); // 字符串:toString 恒等返回
                this.vm.pop(VReg.RET);
                this.vm.jmp(tsEndLbl);
                this.vm.label(tsNumLbl);
                // 零参用通用数字格式器(int/float 都对,3.5→"3.5");
                // _num_toString 是整数进制格式器,只给带 radix 形态用
                this.vm.pop(VReg.A0);
                this.vm.call("_numberToString");
                this.vm.jmp(tsEndLbl);
                this.vm.label(tsSymLbl); // high16==0:可能是 Symbol/BigInt,运行时确认
                // [#71] BigInt.toString():裸 user_ptr(high16==0),+0 是 64 位值。
                // 此前落数字路径把 bigint 指针当 double 格式化 → "0."。先判 _is_bigint
                // (内部带堆界守卫,非 bigint 返 0),命中则取 64 位值 → _intToStr 十进制串
                // (有符号,负 bigint 亦正确)。再判 symbol,末尾才回落数字路径。
                this.vm.load(VReg.A0, VReg.SP, 0); // obj(仍在栈顶)
                this.vm.call("_is_bigint");
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jne(tsBiLbl);
                this.vm.load(VReg.A0, VReg.SP, 0); // obj
                this.vm.call("_is_symbol");
                this.vm.cmpImm(VReg.RET, 0);
                const tsTaLbl = this.ctx.newLabel("tostr_ta");
                this.vm.jeq(tsTaLbl); // 非 symbol/bigint 的 high16==0 值:先探 TypedArray
                this.vm.pop(VReg.A0);
                this.vm.call("_symbol_to_string");
                this.vm.jmp(tsEndLbl);
                // [#4] TypedArray.toString()(裸堆指针,类型字节 0x40-0x61)→ 逗号连接串
                // (对齐 node "1,2,3")。此前落数字路径把 ta 头指针当 double → 垃圾浮点。
                // 堆界守卫后读类型字节;非 typed 的微小 double 回落数字路径。
                this.vm.label(tsTaLbl);
                this.vm.load(VReg.V0, VReg.SP, 0);
                this.vm.lea(VReg.V1, "_heap_base"); this.vm.load(VReg.V1, VReg.V1, 0);
                this.vm.cmp(VReg.V0, VReg.V1); this.vm.jlt(tsNumLbl);
                this.vm.lea(VReg.V1, "_heap_ptr"); this.vm.load(VReg.V1, VReg.V1, 0);
                this.vm.cmp(VReg.V0, VReg.V1); this.vm.jge(tsNumLbl);
                this.vm.loadByte(VReg.V0, VReg.V0, 0);
                this.vm.cmpImm(VReg.V0, 0x40); this.vm.jlt(tsNumLbl);
                this.vm.cmpImm(VReg.V0, 0x61); this.vm.jgt(tsNumLbl);
                this.vm.pop(VReg.A0); // ta 裸指针
                this.vm.lea(VReg.A1, this.asm.addString(","));
                this.vm.movImm64(VReg.V0, 0x7ffc000000000000n);
                this.vm.or(VReg.A1, VReg.A1, VReg.V0); // 装箱 "," 数据串
                this.vm.call("_ta_join");
                this.vm.jmp(tsEndLbl);
                this.vm.label(tsBiLbl);
                this.vm.pop(VReg.A0);      // bigint ptr(high16 已 0,无需 unbox)
                this.vm.load(VReg.A0, VReg.A0, 0); // 64 位值
                this.vm.call("_intToStr");
                this.vm.label(tsEndLbl);
                return;
            }

            // 根据对象类型推断，调用正确的方法
            const objType = this.inferObjectType(obj);

            // Buffer.concat 是 Buffer 构造器上的静态方法,但 concat 同时在数组/字符串
            // 的歧义方法名表里(HOISTED_AMBIGUOUS_ARR_STR / HOISTED_STRING_METHODS)。
            // 接收者 `Buffer` 静态推断为 unknown,原会被截去走 String.concat → 返空/崩。
            // 与 end/test 同类的方法名撞车:识别字面标识符 `Buffer`(编译器自身只用
            // Buffer.from,不用 Buffer.concat,自举字节不变),让它落通用对象方法路径
            // (与 Buffer.from/alloc 同路),调到 shim 的静态 concat。
            const isBufferConcat = obj.type === "Identifier" && obj.name === "Buffer" &&
                !callee.computed && prop && prop.type === "Identifier" && prop.name === "concat";

            // arr[Symbol.iterator]() -> 一等数组迭代器(kind 0=values)。computed 计算键
            // 归一为字符串 "Symbol.iterator";此前读数组该属性得 undefined → 调 undefined() 崩。
            if (callee.computed && objType === "Array" && prop &&
                prop.type === "MemberExpression" && !prop.computed &&
                prop.object && prop.object.type === "Identifier" && prop.object.name === "Symbol" &&
                prop.property && prop.property.name === "iterator" &&
                !(this.ctx.getLocal && this.ctx.getLocal("Symbol"))) {
                this.compileExpression(obj);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.movImm(VReg.A1, 0);
                this.vm.call("_array_iterator_new");
                return;
            }

            // String 方法 - 优先检查，因为 slice/indexOf 在字符串和数组中都有
            if (objType === "String") {
                const stringMethods = HOISTED_STRING_METHODS;
                if (stringMethods.includes(prop.name)) {
                    if (this.compileStringMethod(obj, prop.name, expr.arguments)) {
                        return;
                    }
                }
            }

            // TypedArray 专属方法:先试 _ta_* 分派(typed 布局 raw 数据@16,落 _array_* 会崩);
            // 未处理(map/filter/forEach/reduce 等基于 _subscript_get 的)委托下方 compileArrayMethod。
            // set/subarray 不在 HOISTED_ARRAY_METHODS(数组无这两法),单列。
            // ArrayBuffer.slice(start?, end?) → _arraybuffer_slice(buf, start, end)(拷贝式新 buffer)。
            // 缺省:start=0、end=byteLength。仅静态 ArrayBuffer 接收者(编译器不用 ArrayBuffer,
            // 自举字节不变)。
            if (objType === "ArrayBuffer" && !callee.computed && prop.name === "slice") {
                const abOff = this.ctx.allocLocal(`__abslice_${this.nextLabelId()}`);
                this.compileExpression(obj);
                this.vm.store(VReg.FP, abOff, VReg.RET);
                // start
                if (expr.arguments.length >= 1) { this.compileExpressionAsInt(expr.arguments[0]); this.vm.mov(VReg.A1, VReg.RET); }
                else this.vm.movImm(VReg.A1, 0);
                // end:缺省 = byteLength
                if (expr.arguments.length >= 2) {
                    this.vm.push(VReg.A1);
                    this.compileExpressionAsInt(expr.arguments[1]);
                    this.vm.mov(VReg.A2, VReg.RET);
                    this.vm.pop(VReg.A1);
                } else {
                    this.vm.load(VReg.A0, VReg.FP, abOff);
                    this.vm.push(VReg.A1);
                    this.vm.call("_arraybuffer_bytelength");
                    this.vm.mov(VReg.A2, VReg.RET);
                    this.vm.pop(VReg.A1);
                }
                this.vm.load(VReg.A0, VReg.FP, abOff);
                this.vm.call("_arraybuffer_slice");
                return;
            }

            // DataView get/set:方法名静态映射为 (size, flags),调通用 _dataview_get/set。
            // flags: bit0=signed, bit1=float。littleEndian(get 第2参 / set 第3参,缺省
            // false=大端)取真值低位(JS_TRUE 低位=1)。仅静态 DataView 接收者。
            if (objType === "DataView" && !callee.computed) {
                const DV_SPEC = {
                    getInt8: [1, 1], getUint8: [1, 0], getInt16: [2, 1], getUint16: [2, 0],
                    getInt32: [4, 1], getUint32: [4, 0], getFloat32: [4, 2], getFloat64: [8, 2],
                    setInt8: [1, 1], setUint8: [1, 0], setInt16: [2, 1], setUint16: [2, 0],
                    setInt32: [4, 1], setUint32: [4, 0], setFloat32: [4, 2], setFloat64: [8, 2],
                };
                const spec = DV_SPEC[prop.name];
                if (spec) {
                    const isSet = prop.name.charAt(0) === "s";
                    const [size, flags] = spec;
                    const fid = this.nextLabelId();
                    const dvOff = this.ctx.allocLocal(`__dv_recv_${fid}`);
                    const boOff = this.ctx.allocLocal(`__dv_bo_${fid}`);
                    this.compileExpression(obj);
                    this.vm.store(VReg.FP, dvOff, VReg.RET);
                    // byteOffset (arg0)
                    if (expr.arguments.length >= 1) this.compileExpressionAsInt(expr.arguments[0]);
                    else this.vm.movImm(VReg.RET, 0);
                    this.vm.store(VReg.FP, boOff, VReg.RET);
                    const leIdx = isSet ? 2 : 1;
                    if (isSet) {
                        const valOff = this.ctx.allocLocal(`__dv_val_${fid}`);
                        this.compileExpression(expr.arguments[1]); // value(装箱数)
                        this.vm.store(VReg.FP, valOff, VReg.RET);
                        // le
                        if (expr.arguments.length > leIdx) {
                            this.compileExpression(expr.arguments[leIdx]);
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_to_boolean");
                            this.vm.andImm(VReg.A5, VReg.RET, 1);
                        } else this.vm.movImm(VReg.A5, 0);
                        this.vm.load(VReg.A0, VReg.FP, dvOff);
                        this.vm.load(VReg.A1, VReg.FP, boOff);
                        this.vm.load(VReg.A2, VReg.FP, valOff);
                        this.vm.movImm(VReg.A3, size);
                        this.vm.movImm(VReg.A4, flags);
                        this.vm.call("_dataview_set");
                    } else {
                        if (expr.arguments.length > leIdx) {
                            this.compileExpression(expr.arguments[leIdx]);
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_to_boolean");
                            this.vm.andImm(VReg.A4, VReg.RET, 1);
                        } else this.vm.movImm(VReg.A4, 0);
                        this.vm.load(VReg.A0, VReg.FP, dvOff);
                        this.vm.load(VReg.A1, VReg.FP, boOff);
                        this.vm.movImm(VReg.A2, size);
                        this.vm.movImm(VReg.A3, flags);
                        this.vm.call("_dataview_get");
                    }
                    return;
                }
            }

            if (objType === "TypedArray" && !callee.computed &&
                (HOISTED_ARRAY_METHODS.includes(prop.name) ||
                 prop.name === "set" || prop.name === "subarray")) {
                if (this.compileTypedArrayMethod(obj, prop.name, expr.arguments)) {
                    return;
                }
            }

            // 数组方法 - Array 和 TypedArray 共享
            // 注意：对于 unknown 类型，includes/indexOf/slice/at 应该由字符串方法处理
            // 因为 "str".includes() 比 [].includes() 更常见
            if (objType === "Array" || objType === "TypedArray") {
                const arrayMethods = HOISTED_ARRAY_METHODS;
                if (arrayMethods.includes(prop.name)) {
                    this.compileArrayMethod(obj, prop.name, expr.arguments);
                    return;
                }
            }

            // unknown 类型（如 o.arr / this.arr 成员数组）：数组独有方法
            // 直接按数组处理（字符串没有这些方法），避免落入通用对象方法
            // 调用把数组当对象、把方法名当键查找而崩溃
            if (objType === "unknown") {
                // n.toString(radix):数字类型推断为 unknown,此前落通用对象成员调用返空。
                // 恰 1 参的 toString 按数字基数转换处理(带参 toString 的用户对象极罕见,
                // 文档化取舍);0 参 toString 保持原路径(对象自定义 toString 常见)。
                if (prop.name === "toString" && !callee.computed && expr.arguments.length === 1) {
                    // 接收者是对象(0x7FFD)且有用户 toString 方法(Buffer/类实例)→ 调用户方法
                    // 传参(如 buf.toString("hex"));否则(数字/bigint)走 radix 路径。此前 1 参
                    // toString 一律当数字+radix → buf.toString("hex") 把 buf 当数、"hex" radix=0 → "0"。
                    const ts1RecvOff = this.ctx.allocLocal(`__ts1_recv_${this.nextLabelId()}`);
                    const ts1RadixL = this.ctx.newLabel("ts1_radix");
                    const ts1EndL = this.ctx.newLabel("ts1_end");
                    this.compileExpression(obj);
                    this.vm.store(VReg.FP, ts1RecvOff, VReg.RET);
                    this.vm.shrImm(VReg.V0, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V0, 0x7FFD);
                    this.vm.jne(ts1RadixL);
                    this.emitBoxedStringKey("toString", VReg.A1);
                    this.vm.load(VReg.A0, VReg.FP, ts1RecvOff);
                    this.vm.call("_object_get");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.FP, ts1RecvOff);
                    this.vm.call("_maybe_getter");
                    this.vm.mov(VReg.V6, VReg.RET);
                    this.vm.shrImm(VReg.V0, VReg.V6, 48);
                    this.vm.cmpImm(VReg.V0, 0x7FFF); // 函数 tag
                    this.vm.jne(ts1RadixL);
                    this.vm.load(VReg.V5, VReg.FP, ts1RecvOff);
                    this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
                    this.vm.jmp(ts1EndL);
                    this.vm.label(ts1RadixL);
                    const biRxLbl = this.ctx.newLabel("ts_radix_nobi");
                    this.vm.load(VReg.RET, VReg.FP, ts1RecvOff);
                    this.vm.push(VReg.RET); // 接收者值(SP+8)
                    this.compileExpression(expr.arguments[0]);
                    if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_int32");
                    this.vm.push(VReg.RET); // radix 裸 int(SP+0;_is_bigint 会冲寄存器)
                    // [#71] BigInt.toString(radix):接收者是裸 user_ptr → 取 64 位值,
                    // 截低 32 位重打 int32 tag(0x7FF8),供 _num_toString 内部 _to_int32
                    // 正确取回(值域限 32 位,超范围 bigint 的非十进制 radix 截断,记偏差)。
                    this.vm.load(VReg.A0, VReg.SP, 8); // 接收者
                    this.vm.call("_is_bigint");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jeq(biRxLbl);
                    this.vm.load(VReg.A0, VReg.SP, 8); // bigint ptr
                    this.vm.load(VReg.A0, VReg.A0, 0); // 64 位值
                    this.vm.movImm64(VReg.V1, 0xFFFFFFFFn);
                    this.vm.and(VReg.A0, VReg.A0, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n);
                    this.vm.or(VReg.A0, VReg.A0, VReg.V1);
                    this.vm.store(VReg.SP, 8, VReg.A0); // 覆盖接收者槽为装箱 int32
                    this.vm.label(biRxLbl);
                    this.vm.pop(VReg.A1); // radix
                    this.vm.pop(VReg.A0); // 接收者(bigint 时已装箱 int32)
                    this.vm.call("_num_toString");
                    this.vm.label(ts1EndL);
                    return;
                }
                // n.toFixed(digits?):方法名数字专属,unknown 接收者直接劫持。
                if (prop.name === "toFixed" && !callee.computed && expr.arguments.length <= 1) {
                    this.compileExpression(obj);
                    if (expr.arguments.length === 1) {
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.arguments[0]);
                        if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_to_int32");
                        this.vm.mov(VReg.A1, VReg.RET); // digits(裸 int)
                        this.vm.pop(VReg.A0);
                    } else {
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.movImm(VReg.A1, 0);
                    }
                    this.vm.call("_num_toFixed");
                    return;
                }
                // forEach/keys/values/entries:数组/Set/Map 三者共有,unknown 接收者
                // (参数/捕获/成员读回的集合)无法静态区分。**运行时按对象头类型字节分派**
                // (TYPE_ARRAY=1/TYPE_MAP=4/TYPE_SET=5),各走对应实现。此前这些方法在
                // HOISTED_ARRAY_ONLY_METHODS 里被无条件当数组 → 函数内 `map.keys()`/
                // `set.forEach()`(接收者 unknown)走数组实现把 Set/Map 当数组读 → 结果错
                // (键返数组索引 [0,1]、forEach 回调收 index/垃圾)。真根因是 dispatch,
                // 与遍历/寄存器无关(compileSetMethod 等对已知类型/顶层一直正确)。
                const sharedCollMethod = prop.name === "forEach" || prop.name === "keys" ||
                    prop.name === "values" || prop.name === "entries";
                if (sharedCollMethod && !callee.computed &&
                    (prop.name !== "forEach" || expr.arguments.length >= 1)) {
                    this.emitTagDispatchMethod(obj, prop, expr.arguments, [
                        { type: 1, compile: () => this.compileArrayMethod(obj, prop.name, expr.arguments) },
                        { type: 4, compile: () => this.compileMapMethod(obj, prop.name, expr.arguments) },
                        { type: 5, compile: () => this.compileSetMethod(obj, prop.name, expr.arguments) },
                        // TypedArray(未静态推断,如闭包内捕获的 ta):先试 compileTypedArrayMethod
                        // (values/entries/keys 经 _ta_to_array 转普通数组,typed 布局元素@16 不能
                        // 落 _array_values/entries),未处理者(forEach)委托数组实现(_subscript_get
                        // 运行时按 tag 处理 typed)。
                        { typedArray: true, compile: () => {
                            if (!this.compileTypedArrayMethod(obj, prop.name, expr.arguments)) {
                                this.compileArrayMethod(obj, prop.name, expr.arguments);
                            }
                        } },
                    ]);
                    return;
                }

                // 数组独有、字符串没有的方法（含 split 结果等 unknown 数组）。
                // join/reverse/sort 等字符串没有，故对 unknown 直接按数组处理，
                // 否则落入通用对象方法把方法名当键查找而崩溃。
                const arrayOnlyMethods = HOISTED_ARRAY_ONLY_METHODS;
                // pop/shift 内建取 0 参：带参时是同名用户方法（如 vm.pop(reg)），
                // 别劫持成 _array_pop（否则把该对象当数组读崩，_generatePad 卡死元凶）。
                const zeroArgMismatch = (prop.name === "pop" || prop.name === "shift") &&
                    expr.arguments.length > 0;
                // push：与 Array.push 同 arity，无法静态区分「数组.push」和「用户对象.push」
                // （如 vm.push(reg) 发射指令）。运行时判 tag：数组(0x7FFE)走 _array_push，
                // 否则走用户方法。这是自举编译器 vm.push 被劫持的根治。
                if (prop.name === "push" && !callee.computed && expr.arguments.length >= 1) {
                    const arrLbl = this.ctx.newLabel("push_arr");
                    const endLbl = this.ctx.newLabel("push_end");
                    this.compileExpression(obj);
                    this.vm.push(VReg.RET);            // 存 obj（用户方法路径要用）
                    this.vm.shrImm(VReg.V0, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V0, 0x7FFE);
                    this.vm.jeq(arrLbl);
                    // 非数组 → 用户方法（obj 在 RET 且栈顶）
                    // x64: V0==RET==RAX，上面 shrImm 已把 RET 毁成 tag 值，
                    // 从栈顶重载 obj（自举编译器 asm.push 发射指令被判 not a function 根因）
                    const pn = this.getMemberPropertyName ? this.getMemberPropertyName(prop) : (prop.name || prop.value);
                    const pLbl = this.asm.addString(pn);
                    if (this.vm.backend.name === "x64") {
                        this.vm.load(VReg.A0, VReg.SP, 0);
                    } else {
                        this.vm.mov(VReg.A0, VReg.RET);
                    }
                    this.vm.lea(VReg.A1, pLbl);
                    this.vm.call("_tag_str_a1"); // key box->helper
                    this.vm.call("_object_get");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.SP, 0);
                    this.vm.call("_maybe_getter");
                    this.vm.mov(VReg.V6, VReg.RET);
                    this.vm.pop(VReg.V5);
                    this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
                    this.vm.jmp(endLbl);
                    this.vm.label(arrLbl);
                    this.vm.pop(VReg.V0); // 丢弃存的 obj（compileArrayMethod 会重新求值 obj）
                    this.compileArrayMethod(obj, "push", expr.arguments);
                    this.vm.label(endLbl);
                    return;
                }
                // join:同 push,与用户对象方法同名无法静态区分(path.join(a,b,c) 曾被
                // 劫持成数组 join 把 path 类对象当数组读 → 坏值/崩)。运行时判 tag:
                // 数组(0x7FFE)走数组 join,否则用户方法。仅拦 ≤1 参(数组 join 至多一个
                // 分隔符;2+ 参必是用户方法,落通用路径)。
                // 静态已知类/函数绑定(如具名类的静态 join)不拦:其静态方法不在
                // _object_get 可见的 props 里,须落通用类静态路径。jRecvIsKnown 内联进
                // 条件靠短路只在 prop.name==="join" 时才查 getFunction(避免每次成员调用
                // 都多查一次表)。
                if (prop.name === "join" && !callee.computed && expr.arguments.length <= 1 &&
                    !(obj.type === "Identifier" && this.ctx.getFunction &&
                      this.ctx.getFunction(obj.name))) {
                    const jArrLbl = this.ctx.newLabel("join_arr");
                    const jTaLbl = this.ctx.newLabel("join_ta");
                    const jUserLbl = this.ctx.newLabel("join_user");
                    const jEndLbl = this.ctx.newLabel("join_end");
                    const objOnce = this._evalOnceToIdent(obj); // 接收者单次求值
                    this.compileExpression(objOnce);
                    this.vm.push(VReg.RET);            // 存 obj(用户方法路径要用)
                    this.vm.shrImm(VReg.V0, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V0, 0x7FFE);
                    this.vm.jeq(jArrLbl);
                    // TypedArray(**裸指针** high16==0 才判头字节 0x40-0x61;0x7FFC 字符串的
                    // 内容首字节('A'=0x41 等)会冒充 TA 类型字节,必须先验 tag)→ _ta_join
                    this.vm.load(VReg.V0, VReg.SP, 0);
                    this.vm.shrImm(VReg.V1, VReg.V0, 48);
                    this.vm.cmpImm(VReg.V1, 0);
                    this.vm.jne(jUserLbl);
                    this.vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
                    this.vm.and(VReg.V0, VReg.V0, VReg.V1);
                    this.vm.loadByte(VReg.V0, VReg.V0, 0);
                    this.vm.cmpImm(VReg.V0, 0x40);
                    this.vm.jge(jTaLbl);
                    this.vm.label(jUserLbl);
                    // 非数组：用户方法(x64: V0==RET 已毁,从栈顶重载;同 push 派发器)
                    const jLbl = this.asm.addString("join");
                    if (this.vm.backend.name === "x64") {
                        this.vm.load(VReg.A0, VReg.SP, 0);
                    } else {
                        this.vm.mov(VReg.A0, VReg.RET);
                    }
                    this.vm.lea(VReg.A1, jLbl);
                    this.vm.call("_tag_str_a1"); // key box->helper
                    this.vm.call("_object_get");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.SP, 0);
                    this.vm.call("_maybe_getter");
                    this.vm.mov(VReg.V6, VReg.RET);
                    this.vm.pop(VReg.V5);
                    this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
                    this.vm.jmp(jEndLbl);
                    this.vm.label(jTaLbl);
                    this.vm.pop(VReg.V0); // 丢弃(compileTypedArrayMethod 重新求值 obj)
                    this.compileTypedArrayMethod(objOnce, "join", expr.arguments);
                    this.vm.jmp(jEndLbl);
                    this.vm.label(jArrLbl);
                    this.vm.pop(VReg.V0); // 丢弃(compileArrayMethod 重新求值 obj)
                    this.compileArrayMethod(objOnce, "join", expr.arguments);
                    this.vm.label(jEndLbl);
                    return;
                }
                // join 整体移出本劫持(非 computed):≤1 参已被上方 tag 派发器接管
                // (数组→数组 join,非数组→用户方法);≥2 参数组 join 不存在,必是用户
                // 方法(path.join(a,b) 曾被劫持当数组读崩)→ 落通用路径;已知类静态
                // join 亦落通用类静态路径。computed obj["join"] 保持旧劫持。
                if (arrayOnlyMethods.includes(prop.name) && !zeroArgMismatch &&
                    !(prop.name === "join" && !callee.computed)) {
                    // 到此接收者静态类型为 unknown(Array 已在上方静态派发、Object 走对象方法
                    // 路径)。运行时判 tag:数组(0x7FFE)→ 数组方法;否则 → 用户对象同名方法
                    // (如 `makeStack()` 返回的 {pop,push,size} 对象)。此前一律当数组 →
                    // `mk().pop()`/`s.push(x)`(s 为函数返回的对象,unknown 型)把对象当数组
                    // 操作 → 段错误。镜像上方 join 的 tag 派发,非 computed 才拦(computed
                    // obj["pop"] 保持)。
                    if (!callee.computed) {
                        // 运行时按对象头类型字节分派:数组(TYPE_ARRAY=1)与 TypedArray(0x40-0x61)
                        // → 数组方法实现(map/filter/reduce/... 内部 _subscript_get/_array_length
                        // 运行时处理 typed 布局);否则(同名用户对象方法)→ 通用方法查找。
                        // 此前仅判装箱 tag 0x7FFE(纯数组),闭包内捕获的 typed array 落用户方法
                        // 路径查 miss → 崩(nested-closure typed forEach/map/filter 段错误根因)。
                        const objOnce = this._evalOnceToIdent(obj); // 接收者单次求值
                        this.emitTagDispatchMethod(objOnce, prop, expr.arguments, [
                            { type: 1, compile: () => this.compileArrayMethod(objOnce, prop.name, expr.arguments) },
                            // TypedArray:先试 TA 专用实现(_ta_fill/slice/join/...),
                            // 未覆盖者(map/filter/reduce 等)回退 typed-aware 数组实现。
                            { typedArray: true, compile: () => {
                                if (!this.compileTypedArrayMethod(objOnce, prop.name, expr.arguments)) {
                                    this.compileArrayMethod(objOnce, prop.name, expr.arguments);
                                }
                            } },
                        ]);
                        return;
                    }
                    this.compileArrayMethod(obj, prop.name, expr.arguments);
                    return;
                }

                // slice/at/indexOf/includes/lastIndexOf/concat：字符串与数组都有，
                // unknown 类型（如 process.argv、o.arr、split 结果再传递）无法静态区分。
                // 运行时判 NaN-box tag：数组(0x7FFE)走数组方法，否则按字符串。
                // 原来一律落字符串 → process.argv.slice(2) 把数组当字符串切 → 返回空
                // （gen1 CLI 从 process.argv.slice(2) 拿不到任何参数的根因）。
                // 仅列有 index.js 生成的 _array_* 运行时的方法（lastIndexOf 的数组版
                // 未接入生成，保持字符串路由，避免未定义标签链接错误）。
                const ambiguousArrStr = HOISTED_AMBIGUOUS_ARR_STR;
                if (ambiguousArrStr.includes(prop.name) && !callee.computed && !isBufferConcat) {
                    // object-tag(0x7FFD) 接收者只对 slice 路由到同名用户方法(regexp
                    // exec/match 结果对象的 .slice,#65)。其余歧义方法(at/indexOf/
                    // includes/concat)保持 baseline 的「非数组→字符串」——自举中它们
                    // 会以 object 接收者到达且必须走原路径,否则 gen2 崩。
                    const routeObj = prop.name === "slice";
                    const arrLbl = this.ctx.newLabel("ambig_arr");
                    const objLbl = this.ctx.newLabel("ambig_obj");
                    const taLbl = this.ctx.newLabel("ambig_ta");
                    const taStrLbl = this.ctx.newLabel("ambig_tastr");
                    const endLbl = this.ctx.newLabel("ambig_end");
                    const objOnce = this._evalOnceToIdent(obj); // 接收者单次求值
                    this.compileExpression(objOnce);           // RET = 接收者（仅判 tag）
                    this.vm.shrImm(VReg.V0, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V0, 0x7FFE);       // 数组 tag
                    this.vm.jeq(arrLbl);
                    if (routeObj) {
                        this.vm.cmpImm(VReg.V0, 0x7FFD);   // 对象 tag → 用户方法
                        this.vm.jeq(objLbl);
                    }
                    // TypedArray(**裸指针** high16==0 才判头字节 0x40-0x61;0x7FFC 字符串的
                    // 内容首字节会冒充 TA 类型字节)→ TA 方法(slice/at/indexOf/includes),
                    // 未覆盖者(lastIndexOf/concat)回退 typed-aware 数组实现;否则维持字符串路由。
                    this.compileExpression(objOnce);
                    this.vm.push(VReg.RET);
                    this.vm.shrImm(VReg.V1, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V1, 0);
                    this.vm.jne(taStrLbl);
                    this.vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
                    this.vm.and(VReg.V0, VReg.RET, VReg.V1);
                    this.vm.loadByte(VReg.V0, VReg.V0, 0);
                    this.vm.cmpImm(VReg.V0, 0x40);
                    this.vm.jge(taLbl);
                    this.vm.label(taStrLbl);
                    this.vm.pop(VReg.V0);
                    // 非数组：按字符串方法处理
                    if (!this.compileStringMethod(objOnce, prop.name, expr.arguments)) {
                        this.compileArrayMethod(objOnce, prop.name, expr.arguments);
                    }
                    this.vm.jmp(endLbl);
                    this.vm.label(taLbl);
                    this.vm.pop(VReg.V0);
                    if (!this.compileTypedArrayMethod(objOnce, prop.name, expr.arguments)) {
                        this.compileArrayMethod(objOnce, prop.name, expr.arguments);
                    }
                    this.vm.jmp(endLbl);
                    this.vm.label(arrLbl);
                    this.compileArrayMethod(objOnce, prop.name, expr.arguments);
                    if (routeObj) {
                        this.vm.jmp(endLbl);
                        // 通用对象方法调用：_object_get 取方法 → _maybe_getter → 调用。
                        this.vm.label(objLbl);
                        const pn = this.getMemberPropertyName ? this.getMemberPropertyName(prop) : (prop.name || prop.value);
                        const pLbl = this.asm.addString(pn);
                        this.compileExpression(objOnce);
                        this.vm.push(VReg.RET);            // this
                        this.vm.load(VReg.A0, VReg.SP, 0);
                        this.vm.lea(VReg.A1, pLbl);
                        this.vm.call("_tag_str_a1"); // key box->helper
                        this.vm.call("_object_get");
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.load(VReg.A1, VReg.SP, 0);
                        this.vm.call("_maybe_getter");
                        this.vm.mov(VReg.V6, VReg.RET);
                        this.vm.pop(VReg.V5);
                        this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
                    }
                    this.vm.label(endLbl);
                    return;
                }
            }

            // Map 方法
            if (objType === "Map") {
                const mapMethods = HOISTED_MAP_METHODS;
                if (mapMethods.includes(prop.name)) {
                    if (this.compileMapMethod(obj, prop.name, expr.arguments)) {
                        return;
                    }
                }
            }

            // Set 方法
            if (objType === "Set") {
                const setMethods = HOISTED_SET_METHODS;
                if (setMethods.includes(prop.name)) {
                    if (this.compileSetMethod(obj, prop.name, expr.arguments)) {
                        return;
                    }
                }
            }

            // Date 方法
            if (objType === "Date") {
                const dateMethods = HOISTED_DATE_METHODS;
                if (dateMethods.includes(prop.name)) {
                    if (this.compileDateMethod(obj, prop.name, expr.arguments)) {
                        return;
                    }
                }
            }

            // RegExp 方法
            if (objType === "RegExp") {
                const regexpMethods = HOISTED_REGEXP_METHODS;
                if (regexpMethods.includes(prop.name)) {
                    if (this.compileRegExpMethod(obj, prop.name, expr.arguments)) {
                        return;
                    }
                }
            }

            // 如果无法确定类型，尝试所有可能的方法（旧的回退逻辑）
            if (objType === "unknown") {
                // String 方法 - 对于未知类型，也尝试字符串方法。
                // 排除 normalize:它既是 String.prototype.normalize(asm.js 字节模型下为
                // 恒等),又是常见对象方法名(path.normalize/url 等)。对 unknown 接收者
                // 强行当字符串会把对象参数原样返回([object Object]),劫持掉真正的对象
                // 方法。已知 String 接收者仍走上面的 String 分支;编译器自身不调 .normalize()。
                const stringMethods = HOISTED_STRING_METHODS;
                if (stringMethods.includes(prop.name) && prop.name !== "normalize" && !isBufferConcat) {
                    if (this.compileStringMethod(obj, prop.name, expr.arguments)) {
                        return;
                    }
                }

                // Map 方法（未知类型回退）。get/set/has/delete 与 Map 内建同名同 arity，
                // 无法静态区分「真 Map」和「同名用户方法」（如 ctx.get(name)）。**运行时判
                // 对象头类型字节（TYPE_MAP=4）**：是 Map 走 _map_xxx，否则走用户方法。
                // （对象头 [0]&0xff：Map=4，普通对象=2。）
                const nArgs = expr.arguments.length;
                // TypedArray 独有方法(subarray;set 的 1 参形态——2 参形态走下方 Map 歧义
                // 点的 typedArray 分支):运行时 TA 头字节判别,否则维持用户方法路径。
                if ((prop.name === "subarray" || (prop.name === "set" && nArgs === 1)) && !callee.computed) {
                    const objOnce = this._evalOnceToIdent(obj); // 接收者单次求值
                    this.emitTagDispatchMethod(objOnce, prop, expr.arguments, [
                        { typedArray: true, compile: () => this.compileTypedArrayMethod(objOnce, prop.name, expr.arguments) },
                    ]);
                    return;
                }
                // get/set 是 Map 独有（TYPE_MAP=4）；has/delete 为 Map+Set 共有
                // （_map_has/_map_delete 按 entry[0] 比较，对 Set 同构布局也成立），故收 [4,5]。
                if ((prop.name === "get" || prop.name === "set") && !callee.computed &&
                    nArgs === (prop.name === "set" ? 2 : 1)) {
                    const objOnce = this._evalOnceToIdent(obj); // 接收者单次求值
                    this.emitTagDispatchMethod(objOnce, prop, expr.arguments, [
                        { type: 4, compile: () => this.compileMapMethod(objOnce, prop.name, expr.arguments) },
                        // TypedArray.set(src, off):TA 头字节分支(2 参形态)
                        { typedArray: true, compile: () => this.compileTypedArrayMethod(objOnce, prop.name, expr.arguments) },
                    ]);
                    return;
                }
                // has/delete 为 Map+Set 共有，各走各的内建（节点布局不同，不能混用）。
                if ((prop.name === "has" || prop.name === "delete") && !callee.computed && nArgs === 1) {
                    this.emitTagDispatchMethod(obj, prop, expr.arguments, [
                        { type: 4, compile: () => this.compileMapMethod(obj, prop.name, expr.arguments) },
                        { type: 5, compile: () => this.compileSetMethod(obj, prop.name, expr.arguments) },
                    ]);
                    return;
                }
                // Map/Set.clear()（0 参）：Map+Set 共有,数组无。unknown 接收者此前落
                // 通用对象方法查 "clear" miss → 崩(`m.clear()` 传参段错误)。运行时按
                // TYPE_MAP=4/TYPE_SET=5 分派,其余走用户方法。
                if (prop.name === "clear" && !callee.computed && nArgs === 0) {
                    this.emitTagDispatchMethod(obj, prop, expr.arguments, [
                        { type: 4, compile: () => this.compileMapMethod(obj, prop.name, expr.arguments) },
                        { type: 5, compile: () => this.compileSetMethod(obj, prop.name, expr.arguments) },
                    ]);
                    return;
                }
                // Set.add：与用户 add(1参) 同名同 arity，运行时按 TYPE_SET(5) 分派。
                if (prop.name === "add" && !callee.computed && nArgs === 1) {
                    this.emitTagDispatchMethod(obj, prop, expr.arguments, [
                        { type: 5, compile: () => this.compileSetMethod(obj, prop.name, expr.arguments) },
                    ]);
                    return;
                }
                // ES2025 Set 组合方法(union/intersection/... 1 参):Set 独有,数组/字符串
                // 无。unknown 接收者此前落通用方法查 miss → 崩。运行时按 TYPE_SET(5) 分派。
                const setCombinators = ["union", "intersection", "difference",
                    "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom"];
                if (setCombinators.includes(prop.name) && !callee.computed && nArgs === 1) {
                    this.emitTagDispatchMethod(obj, prop, expr.arguments, [
                        { type: 5, compile: () => this.compileSetMethod(obj, prop.name, expr.arguments) },
                    ]);
                    return;
                }

                // Date 方法（getTime/toString/valueOf:无歧义或已由上游 0参 toString 拦截,
                // 直接派发,行为不变）
                const dateMethods = HOISTED_DATE_METHODS2;
                if (dateMethods.includes(prop.name)) {
                    if (this.compileDateMethod(obj, prop.name, expr.arguments)) {
                        return;
                    }
                }
                // [#62] 其余 Date 方法(toISOString/getUTCFullYear/setter 等):容器/形参
                // 读回的 Date 静态类型为 unknown,原落通用对象成员调用把方法名当键查找 →
                // 取到 undefined 再调用而崩。改运行时按对象头类型字节 TYPE_DATE(7) 分派:
                // 真 Date 走内建日期方法,否则(同名用户方法)走通用对象方法,不误劫持。
                if (!callee.computed && prop.type === "Identifier" &&
                    HOISTED_DATE_METHODS.includes(prop.name) &&
                    !HOISTED_DATE_METHODS2.includes(prop.name)) {
                    this.emitTagDispatchMethod(obj, prop, expr.arguments, [
                        { type: 7, compile: () => this.compileDateMethod(obj, prop.name, expr.arguments) },
                    ]);
                    return;
                }
            }

            // [#61 P2] obj.propertyIsEnumerable(key) → 运行时读 own 属性 enumerable 位。
            // asm.js 对象无 Object.prototype 链,直接内联到运行时 helper。
            if (prop && prop.type === "Identifier" && !callee.computed &&
                prop.name === "propertyIsEnumerable" && expr.arguments.length >= 1) {
                this.compileExpression(obj);
                this.vm.push(VReg.RET);
                this.compileExpression(expr.arguments[0]);
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.pop(VReg.A0);
                this.vm.call("_object_propertyIsEnumerable");
                return;
            }

            // 通用对象方法调用 - obj.method(args)
            // 获取方法（闭包或函数指针）并传递 this
            this.compileExpression(obj); // obj -> RET
            this.vm.push(VReg.RET); // 保存 obj 作为 this

            // [#36] f.call(t,…)/f.apply(t,arr)/f.bind(t):运行时闭包判别后分派。
            // 命门:vm 对象有名为 call 的用户方法(this.call(a) 是 _replayOp 分派),
            // 非闭包接收者必须原样走通用方法路径——判别靠 magic(0xc105/0xa51c)。
            if (prop && prop.type === "Identifier" && !callee.computed &&
                (prop.name === "call" || prop.name === "apply" || prop.name === "bind")) {
                // 前导(通用方法调用序)已 compile obj 并 push——接管弹栈入槽,
                // 勿重求值(双副作用)、勿早退留悬栈(此前每个 .call 编译点泄 16B
                // 栈 → _main 尾声读错帧,退出段错误的根因)
                const cabFn = this.ctx.allocLocal(`__cab_fn_${this.nextLabelId()}`);
                this.vm.pop(VReg.V1);
                this.vm.store(VReg.FP, cabFn, VReg.V1);
                this.vm.mov(VReg.RET, VReg.V1);
                const cabGen = this.ctx.newLabel("cab_generic");
                const cabClos = this.ctx.newLabel("cab_closure");
                const cabEnd = this.ctx.newLabel("cab_end");
                // 裸 TAG_FUNCTION 值(类方法/普通函数读值 c.m,tag=0x7fff、无闭包头):其
                // 代码指针在 TEXT 段、低于 ptrFloor，旧 magic/ptrFloor 判别误落 cabGen
                // (把 .call 当对象属性找 → undefined,c.m.call/apply/bind 全崩)。tag 命中
                // 即可调,直走 cabClos——compileMethodCall 对闭包(magic 头)与裸指针均正确
                // 分派;真对象(tag 0x7ffd)带用户 .call 仍走下方通用判别不受影响。
                this.vm.shrImm(VReg.V1, VReg.RET, 48);
                this.vm.cmpImm(VReg.V1, 0x7fff);
                this.vm.jeq(cabClos);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
                this.vm.cmpImm(VReg.V0, 0);
                this.vm.jeq(cabGen);
                this.vm.movImm64(VReg.V1, this.vm.ptrFloor);
                this.vm.cmp(VReg.V0, VReg.V1);
                this.vm.jlt(cabGen);
                this.vm.load(VReg.V1, VReg.V0, 0);
                this.vm.cmpImm(VReg.V1, 0xc105);
                this.vm.jeq(cabClos);
                this.vm.cmpImm(VReg.V1, 0xa51c);
                this.vm.jeq(cabClos);
                this.vm.jmp(cabGen);
                this.vm.label(cabClos);
                if (prop.name === "bind") {
                    // 绑定闭包 {magic@0, _bound_tramp@8, target@16, thisArg@24,
                    //  nBound@32(raw int), boundArg0@40, boundArg1@48, …}。
                    // [#57] 预绑定参 f.bind(this, a, b) 在 trampoline 前置到实参再转发。
                    const nBound = expr.arguments.length > 0 ? expr.arguments.length - 1 : 0;
                    const cabT = this.ctx.allocLocal(`__cab_this_${this.nextLabelId()}`);
                    if (expr.arguments.length > 0) this.compileExpression(expr.arguments[0]);
                    else this.vm.movImm(VReg.RET, 0);
                    this.vm.store(VReg.FP, cabT, VReg.RET);
                    // 预绑定参各求值并落 FP 槽(alloc 会毁临时寄存器,先存后填)
                    const boundSlots = [];
                    for (let bi = 0; bi < nBound; bi++) {
                        const s = this.ctx.allocLocal(`__cab_ba_${this.nextLabelId()}`);
                        this.compileExpression(expr.arguments[bi + 1]);
                        this.vm.store(VReg.FP, s, VReg.RET);
                        boundSlots.push(s);
                    }
                    this.vm.movImm(VReg.A0, 40 + nBound * 8);
                    this.vm.call("_alloc");
                    this.vm.movImm(VReg.V1, 0xc105);
                    this.vm.store(VReg.RET, 0, VReg.V1);
                    this.vm.lea(VReg.V1, "_bound_tramp");
                    this.vm.store(VReg.RET, 8, VReg.V1);
                    this.vm.load(VReg.V1, VReg.FP, cabFn);
                    this.vm.store(VReg.RET, 16, VReg.V1);
                    this.vm.load(VReg.V1, VReg.FP, cabT);
                    this.vm.store(VReg.RET, 24, VReg.V1);
                    this.vm.movImm(VReg.V1, nBound);
                    this.vm.store(VReg.RET, 32, VReg.V1);
                    for (let bi = 0; bi < nBound; bi++) {
                        this.vm.load(VReg.V1, VReg.FP, boundSlots[bi]);
                        this.vm.store(VReg.RET, 40 + bi * 8, VReg.V1);
                    }
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_js_box_function");
                } else {
                    // call:this=首参,余参原样;apply:this=首参,第二参数组脱糖为 spread
                    const cabT = this.ctx.allocLocal(`__cab_this_${this.nextLabelId()}`);
                    if (expr.arguments.length > 0) this.compileExpression(expr.arguments[0]);
                    else this.vm.movImm(VReg.RET, 0);
                    this.vm.store(VReg.FP, cabT, VReg.RET);
                    const cabRest = prop.name === "call"
                        ? expr.arguments.slice(1)
                        : (expr.arguments.length > 1
                            ? [{ type: "SpreadElement", argument: expr.arguments[1] }]
                            : []);
                    this.vm.load(VReg.V6, VReg.FP, cabFn);
                    this.vm.load(VReg.V5, VReg.FP, cabT);
                    this.compileMethodCall(VReg.V6, VReg.V5, cabRest);
                }
                this.vm.jmp(cabEnd);
                this.vm.label(cabGen);
                // 非闭包:镜像通用 obj.m(...) 发射(接收者已求值在 cabFn 槽)
                this.vm.load(VReg.A0, VReg.FP, cabFn);
                this.emitBoxedStringKey(prop.name, VReg.A1);
                this.vm.call("_object_get");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.load(VReg.A1, VReg.FP, cabFn);
                this.vm.call("_maybe_getter");
                this.vm.mov(VReg.V6, VReg.RET);
                this.vm.load(VReg.V5, VReg.FP, cabFn);
                this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
                this.vm.label(cabEnd);
                return;
            }

            // 获取方法属性。computed 且键是标识符/表达式（vm[m]）时必须运行时求值 m，
            // 不能把 m 的「名字」当字面属性名（getMemberPropertyName 对 Identifier 会误返回其名）。
            // computed 字符串字面量 vm["and"] 仍取字面值。
            const propName = (callee.computed && prop.type === "Identifier")
                ? null
                : (this.getMemberPropertyName ? this.getMemberPropertyName(prop) : (prop.name || prop.value));
            if (callee.computed && propName === null) {
                // computed 键（obj[expr]()）：运行时求键，_subscript_get 分派
                this.compileExpression(prop);
                this.vm.mov(VReg.A1, VReg.RET); // 键
                this.vm.load(VReg.A0, VReg.SP, 0); // obj (this)
                this.vm.call("_subscript_get"); // 取方法值 -> RET
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.load(VReg.A1, VReg.SP, 0);
                this.vm.call("_maybe_getter");
                this.vm.mov(VReg.V6, VReg.RET);
                this.vm.pop(VReg.V5);
                this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
                return;
            }
            const propLabel = this.asm.addString(propName);
            // [A3.5] 方法查找走 24B 形状 IC(自有/直接原型双模,getter 已融合)——
            // 此前裸 _object_get + _maybe_getter,每次全帧查找 + 原型链递归。
            // (propLabel 保留:addString 驻留副作用维持键注册序,与旧发射一致。)
            this.emitObjectGetIC(propName);

            this.vm.mov(VReg.V6, VReg.RET); // 方法指针/闭包
            this.vm.pop(VReg.V5); // 恢复 obj (this)

            // 使用带 this 的闭包调用
            this.compileMethodCall(VReg.V6, VReg.V5, expr.arguments);
            return;
        }

        // 通用函数调用
        if (callee.type === "Identifier") {
            // with(obj) 内 method() 直接调用:callee 非已知函数/局部时,经 with-read 解析
            // (obj.method)后闭包调用(命中);miss 走词法(未知标识符→undefined→not a function)。
            // 仅活跃 with 作用域触发,普通代码不变。(this=undefined,罕用,记偏差)
            if (this.ctx.withScopes && this.ctx.withScopes.length > 0 && !this._inWithResolve &&
                !this.ctx.hasFunction(callee.name) &&
                !(this.ctx.getLocal && this.ctx.getLocal(callee.name)) &&
                !this.ctx.getMainCapturedVar(callee.name)) {
                this.compileExpression(callee); // with-read → obj[name]
                this.vm.mov(VReg.V6, VReg.RET);
                this.compileClosureCall(VReg.V6, expr.arguments);
                return;
            }
            const globalLabel = this.ctx.getMainCapturedVar(callee.name);
            if (globalLabel) {
                // 如果是主程序中被捕获的变量，使用动态闭包调用
                this.compileExpression(callee);
                this.vm.mov(VReg.V6, VReg.RET);
                this.compileClosureCall(VReg.V6, expr.arguments);
                return;
            }
            // 只有已注册的用户函数才能通过 _user_ 标签调用
            if (this.ctx.hasFunction(callee.name)) {
                const funcLabel = this.getFunctionLabel(callee.name);
                if (funcLabel) {
                    this.compileCallArguments(expr.arguments);
                    this.vm.call(funcLabel);
                }
            }
            // 否则：局部变量通过闭包机制，外部符号通过 IAT，其他标识符被忽略
        } else {
            // 对于间接调用，先计算 callee，然后使用闭包调用机制
            this.compileExpression(callee);
            this.vm.mov(VReg.V6, VReg.RET);
            this.compileClosureCall(VReg.V6, expr.arguments);
        }
    },
};
