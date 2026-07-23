// asm.js 静态类型系统
// 在编译时追踪和检查变量类型

// 类型枚举
export const Type = {
    UNKNOWN: "unknown",
    NUMBER: "number", // 未指定的数字类型（默认 Float64）
    STRING: "string",
    BOOLEAN: "boolean",
    NULL: "null",
    UNDEFINED: "undefined",
    ARRAY: "array",
    OBJECT: "object",
    FUNCTION: "function",
    DATE: "Date",
    MAP: "Map",
    SET: "Set",
    REGEXP: "RegExp",
    TYPED_ARRAY: "TypedArray", // TypedArray (Int8Array, Float64Array 等)
    ARRAY_BUFFER: "ArrayBuffer", // ArrayBuffer(头 type 字节 12)
    DATA_VIEW: "DataView", // DataView(头 type 字节 14)
    BIGINT: "bigint", // 64 位 BigInt（堆装箱，见 runtime/core/coercion.js）
    VOID: "void", // 函数无返回值

    // Number 子类型
    INT8: "int8",
    INT16: "int16",
    INT32: "int32",
    INT64: "int64",
    UINT8: "uint8",
    UINT16: "uint16",
    UINT32: "uint32",
    UINT64: "uint64",
    FLOAT16: "float16",
    FLOAT32: "float32", // Number 默认类型 (IEEE 754 double)
    FLOAT64: "float64",
};

// Number 子类型信息
export const NumberSubtype = {
    Int8: { type: Type.INT8, size: 1, signed: true, isFloat: false },
    Int16: { type: Type.INT16, size: 2, signed: true, isFloat: false },
    Int32: { type: Type.INT32, size: 4, signed: true, isFloat: false },
    Int64: { type: Type.INT64, size: 8, signed: true, isFloat: false },
    Uint8: { type: Type.UINT8, size: 1, signed: false, isFloat: false },
    Uint16: { type: Type.UINT16, size: 2, signed: false, isFloat: false },
    Uint32: { type: Type.UINT32, size: 4, signed: false, isFloat: false },
    Uint64: { type: Type.UINT64, size: 8, signed: false, isFloat: false },
    Float16: { type: Type.FLOAT16, size: 2, signed: true, isFloat: true },
    Float32: { type: Type.FLOAT32, size: 4, signed: true, isFloat: true },
    Float64: { type: Type.FLOAT64, size: 8, signed: true, isFloat: true }, // JS Number = IEEE 754 double
};

// 类型到子类型信息的映射
const TypeToSubtype = {
    [Type.INT8]: NumberSubtype.Int8,
    [Type.INT16]: NumberSubtype.Int16,
    [Type.INT32]: NumberSubtype.Int32,
    [Type.INT64]: NumberSubtype.Int64,
    [Type.UINT8]: NumberSubtype.Uint8,
    [Type.UINT16]: NumberSubtype.Uint16,
    [Type.UINT32]: NumberSubtype.Uint32,
    [Type.UINT64]: NumberSubtype.Uint64,
    [Type.FLOAT16]: NumberSubtype.Float16,
    [Type.FLOAT32]: NumberSubtype.Float32,
    [Type.FLOAT64]: NumberSubtype.Float64,
};

// 判断类型是否是浮点
export function isFloatType(type) {
    const subtype = TypeToSubtype[type];
    if (subtype) return subtype.isFloat;
    // NUMBER 可能是任意浮点类型（Float16/32/64），默认当作浮点处理
    return type === Type.NUMBER;
}

// 判断类型是否是整数
export function isIntType(type) {
    const subtype = TypeToSubtype[type];
    if (subtype) return !subtype.isFloat;
    return false;
}


// 类型兼容性检查
export function isCompatible(from, to) {
    if (from === to) return true;
    if (to === Type.UNKNOWN) return true;
    if (from === Type.UNKNOWN) return true;

    // Number 子类型之间可以互相转换
    if (isIntType(from) && isIntType(to)) return true;
    if (isFloatType(from) && isFloatType(to)) return true;
    if (isIntType(from) && isFloatType(to)) return true;
    if (isFloatType(from) && isIntType(to)) return true; // 会截断

    // null 可以赋值给对象类型
    if (from === Type.NULL && [Type.OBJECT, Type.ARRAY, Type.DATE, Type.MAP, Type.SET, Type.FUNCTION].includes(to)) {
        return true;
    }

    // undefined 可以赋值给任何类型（JavaScript 语义）
    if (from === Type.UNDEFINED) return true;

    return false;
}

// 从 AST 节点推断类型
export function inferType(node, ctx) {
    if (!node) return Type.UNDEFINED;

    switch (node.type) {
        case "NumericLiteral":
        case "Literal":
            if (typeof node.value === "number") {
                // 统一所有数字为 NUMBER 类型
                // 因为我们在运行时使用 Number 对象存储所有数值
                return Type.NUMBER;
            }
            if (typeof node.value === "bigint") return Type.BIGINT;
            if (typeof node.value === "string") return Type.STRING;
            if (typeof node.value === "boolean") return Type.BOOLEAN;
            if (node.value === null) return Type.NULL;
            if (node.value === undefined) return Type.UNDEFINED;
            if (node.value instanceof RegExp) return Type.REGEXP;
            return Type.UNKNOWN;

        case "StringLiteral":
            return Type.STRING;

        case "RegexLiteral":
            // /pattern/flags —— 编译为 __RE_new(..) shim 对象,但静态类型仍是 REGEXP,
            // 供 .test/.exec/str.match/str.replace 的编译期分派(见 functions.js)。
            return Type.REGEXP;

        case "BooleanLiteral":
            return Type.BOOLEAN;

        case "NullLiteral":
            return Type.NULL;

        case "ArrayExpression":
            return Type.ARRAY;

        case "ObjectExpression":
            return Type.OBJECT;

        case "FunctionExpression":
        case "ArrowFunctionExpression":
            return Type.FUNCTION;

        case "Identifier":
            if (node.name === "undefined") return Type.UNDEFINED;
            // 从上下文获取变量类型
            if (ctx && ctx.getVarType) {
                return ctx.getVarType(node.name) || Type.UNKNOWN;
            }
            return Type.UNKNOWN;

        case "NewExpression":
            // new Date(), new Int32() 等
            if (node.callee && node.callee.type === "Identifier") {
                switch (node.callee.name) {
                    case "Int":
                        return Type.INT64; // Int 是 Int64 的别名
                    case "Float":
                    case "Number":
                        return Type.NUMBER;
                    case "String":
                        return Type.STRING;
                    case "Boolean":
                        return Type.BOOLEAN;
                    case "Array":
                        return Type.ARRAY;
                    case "Object":
                        return Type.OBJECT;
                    case "Date":
                        return Type.DATE;
                    case "WeakMap": // WeakMap 路由到 Map(基础操作同),类型推断同 Map
                    case "Map":
                        return Type.MAP;
                    case "WeakSet": // WeakSet 路由到 Set
                    case "Set":
                        return Type.SET;
                    case "RegExp":
                        return Type.REGEXP;
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
                        return Type.TYPED_ARRAY;
                    case "ArrayBuffer":
                        return Type.ARRAY_BUFFER;
                    case "DataView":
                        return Type.DATA_VIEW;
                    // Number 子类型（语法: new Int8() 实际类型: Number.Int8）
                    case "Int8":
                        return Type.INT8;
                    case "Int16":
                        return Type.INT16;
                    case "Int32":
                        return Type.INT32;
                    case "Int64":
                        return Type.INT64;
                    case "Uint8":
                        return Type.UINT8;
                    case "Uint16":
                        return Type.UINT16;
                    case "Uint32":
                        return Type.UINT32;
                    case "Uint64":
                        return Type.UINT64;
                    case "Float16":
                        return Type.FLOAT16;
                    case "Float32":
                        return Type.FLOAT32;
                    case "Float64":
                        return Type.FLOAT64;
                }
            }
            // callee 是普通变量/参数(非已注册函数绑定):产物类型运行时才定
            // (TA=Int8Array 等构造器闭包经 _ta_construct 产 TA/AB 实例)——给 UNKNOWN 让
            // 成员调用走运行时 tag 分派;此前一律 OBJECT,TA 实例落通用对象路径方法查无。
            if (node.callee && node.callee.type === "Identifier" && ctx && ctx.hasFunction &&
                !ctx.hasFunction(node.callee.name)) {
                return Type.UNKNOWN;
            }
            return Type.OBJECT;

        case "MemberExpression":
            // 成员访问：尝试从对象字面量中推断属性类型
            // 检查对象是否是一个已知变量，其值是对象字面量
            if (node.object && node.object.type === "Identifier" && ctx) {
                const varName = node.object.name;
                // 尝试获取变量的初始值类型信息
                if (ctx.varInitTypes && ctx.varInitTypes[varName]) {
                    const objType = ctx.varInitTypes[varName];
                    if (objType && objType.properties && node.property) {
                        const propName = node.property.name || (node.property.value && String(node.property.value));
                        if (propName && objType.properties[propName]) {
                            return objType.properties[propName];
                        }
                    }
                }
            }
            // 特殊属性处理
            if (node.property && node.property.type === "Identifier") {
                const propName = node.property.name;
                if (propName === "length") {
                    // .length 运行时返回标准 JS number（float64 位），
                    // 标 INT64 会走整数路径把浮点位当整数运算
                    return Type.NUMBER;
                }
                // TypedArray.buffer 返回 ArrayBuffer(链式 .byteLength 才能派发)。
                if (propName === "buffer" && inferType(node.object, ctx) === Type.TYPED_ARRAY) {
                    return Type.ARRAY_BUFFER;
                }
            }
            return Type.UNKNOWN;

        case "CallExpression":
            // 函数调用的返回类型
            // __RE_new(正则 shim 构造)/ RegExp(..) 作函数调用(无 new,codegen 脱糖到
            // __RE_new)均返回 RegExp shim 对象 → 静态 REGEXP(令 RegExp("x").test() 等
            // 方法分派命中 shim)。
            if (node.callee && node.callee.type === "Identifier" &&
                (node.callee.name === "__RE_new" || node.callee.name === "RegExp")) {
                return Type.REGEXP;
            }
            // 特殊处理已知返回类型的函数
            if (node.callee && node.callee.type === "MemberExpression") {
                const obj = node.callee.object;
                const prop = node.callee.property;
                // Object.keys(), Object.values(), Object.entries() 返回数组
                if (obj && obj.type === "Identifier" && obj.name === "Object" && prop) {
                    const methodName = prop.name || prop.value;
                    if (methodName === "keys" || methodName === "values" || methodName === "entries") {
                        return Type.ARRAY;
                    }
                }
                // TypedArray 静态 X.from(...) / X.of(...) 返回 typed array。
                if (obj && obj.type === "Identifier" && prop) {
                    const TA_NAMES = { Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1,
                        Int16Array: 1, Uint16Array: 1, Int32Array: 1, Uint32Array: 1,
                        Float32Array: 1, BigInt64Array: 1, BigUint64Array: 1, Float64Array: 1 };
                    const mn = prop.name || prop.value;
                    if (TA_NAMES[obj.name] && (mn === "from" || mn === "of")) {
                        return Type.TYPED_ARRAY;
                    }
                }
                // Array 方法返回类型
                // reverse/sort/fill 原地变更但返回同一数组，链式 .join() 等需推得 ARRAY，
                // 否则落 unknown 分支丢失 reverse 副作用（arr.reverse().join() 得原序）。
                // splice(→删除的数组)/toSpliced/toSorted/toReversed/with/copyWithin 也返数组;
                // 缺 splice 时 `arr.splice(i,n).join()` 推 UNKNOWN → 链式 join 走运行时派发对
                // 变量接收者的 splice 结果误判(得原数组 length)。
                const arrayMethods = ["slice", "concat", "filter", "map", "flat", "flatMap", "reverse", "sort", "fill",
                    "splice", "toSpliced", "toSorted", "toReversed", "with", "copyWithin"];
                if (prop && arrayMethods.includes(prop.name)) {
                    // 如果对象是数组，这些方法也返回数组
                    const objType = inferType(obj, ctx);
                    if (objType === Type.ARRAY) {
                        return Type.ARRAY;
                    }
                }
                // TypedArray 的 map/filter/slice/subarray/fill 返回同类 typed array(map 经
                // compileArrayMap 建 typed;filter 经 compileArrayFilter 末尾 _typed_array_from
                // 转同型;slice/subarray/fill 经 _ta_*)。缺此则链式 `ta.map(..).join()` 把
                // typed 结果推 UNKNOWN → .join 落 _array_* 读 data_ptr@24 越块崩。
                if (prop) {
                    const taReturns = ["map", "filter", "slice", "subarray", "fill", "reverse", "sort"];
                    if (taReturns.includes(prop.name) && inferType(obj, ctx) === Type.TYPED_ARRAY) {
                        return Type.TYPED_ARRAY;
                    }
                    // ArrayBuffer.slice() 返回新 ArrayBuffer(链式 .byteLength 才能派发)。
                    if (prop.name === "slice" && inferType(obj, ctx) === Type.ARRAY_BUFFER) {
                        return Type.ARRAY_BUFFER;
                    }
                }
            }
            return Type.UNKNOWN;

        case "BinaryExpression":
            return inferBinaryType(node, ctx);

        case "UnaryExpression":
            if (node.operator === "!") return Type.BOOLEAN;
            if (node.operator === "typeof") return Type.STRING;
            if (node.operator === "-" || node.operator === "+") {
                // 一元 +/- 是 ToNumber:非数值操作数(字符串/布尔/null/UNKNOWN)结果恒 NUMBER。
                // 数值(含 bigint)保留操作数类型——护裸 int 驻留/自举热路径/`-bigint`。
                // 此前一律返操作数类型 → `+"7"`/`-"7"` 误判 STRING,拼接把 float 位当串指针 → 空。
                const at = inferType(node.argument, ctx);
                if (isIntType(at) || at === Type.FLOAT64 || at === Type.NUMBER || at === Type.BIGINT) return at;
                return Type.NUMBER;
            }
            return Type.UNKNOWN;

        case "ConditionalExpression":
            // 三元表达式：取两个分支的公共类型
            const conseqType = inferType(node.consequent, ctx);
            const altType = inferType(node.alternate, ctx);
            if (conseqType === altType) return conseqType;
            if (isCompatible(conseqType, altType)) return altType;
            if (isCompatible(altType, conseqType)) return conseqType;
            return Type.UNKNOWN;

        default:
            return Type.UNKNOWN;
    }
}

// 推断二元表达式的结果类型
function inferBinaryType(node, ctx) {
    const op = node.operator;
    const leftType = inferType(node.left, ctx);
    const rightType = inferType(node.right, ctx);

    // 比较运算符返回 boolean
    if (["<", "<=", ">", ">=", "==", "===", "!=", "!=="].includes(op)) {
        return Type.BOOLEAN;
    }

    // 逻辑运算符
    if (["&&", "||"].includes(op)) {
        // 返回操作数类型
        return leftType;
    }

    // 算术运算符
    if (["+", "-", "*", "/", "%"].includes(op)) {
        // 字符串拼接
        if (op === "+" && (leftType === Type.STRING || rightType === Type.STRING)) {
            return Type.STRING;
        }
        // `+` 有数组参与:ToPrimitive(数组)→逗号串 → 结果恒 STRING(`[1,2]+3`="1,23")。
        // 若推成 NUMBER,嵌套进外层拼接时 compileExpressionToString 会把运行时的串当数值编 → NaN。
        if (op === "+" && (leftType === Type.ARRAY || rightType === Type.ARRAY)) {
            return Type.STRING;
        }
        // `+` 有对象参与:ToPrimitive(对象)可能 valueOf(数)或 toString(串),不定 → UNKNOWN
        // (走运行时 _js_add / compileExpressionToString 的 _valueToStr 通用路径)。
        if (op === "+" && (leftType === Type.OBJECT || rightType === Type.OBJECT)) {
            return Type.UNKNOWN;
        }
        // `+` 任一侧类型未知：运行时可能是字符串拼接或数值加法，不能推成 NUMBER，
        // 否则嵌套在更大拼接里的 `this.p + x`(未知操作数)被 compileExpressionToString
        // 当数值编译 → 两字符串裸整数相加得 0（`this.X + param + "_" + N` 塌成 "0_N"，
        // 正是 newLabel 的 `labelPrefix + prefix + "_" + counter` 被编成 "0_1" 的根因）。
        if (op === "+" && (leftType === Type.UNKNOWN || rightType === Type.UNKNOWN)) {
            return Type.UNKNOWN;
        }
        // 整数运算保持整数（除了除法）
        if (isIntType(leftType) && isIntType(rightType)) {
            if (op === "/") return Type.FLOAT64; // 除法可能产生浮点
            return Type.INT64;
        }
        // 有浮点数参与则结果是浮点
        if (isFloatType(leftType) || isFloatType(rightType)) {
            return Type.FLOAT64;
        }
        return Type.NUMBER;
    }

    // 位运算符：结果现以**裸 float64 位**返回（与算术一致，见 coercion.js bitDispatch），
    // 故类型是 NUMBER 而非 INT64——否则 `"x=" + (a & b)` 走整数转字符串路径把
    // float64 位当整数打印（如 4096 打成 0x40B0...=4661225614328463360）。
    if (["&", "|", "^", "<<", ">>", ">>>"].includes(op)) {
        return Type.NUMBER;
    }

    return Type.UNKNOWN;
}

// 获取类型的可读名称
export function typeName(type) {
    return type || "unknown";
}

// 类型错误
export class TypeError extends Error {
    constructor(message, node) {
        super(message);
        this.name = "TypeError";
        this.node = node;
    }
}
