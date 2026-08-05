// asm.js 值系统 - QuickJS 风格的 NaN-boxing
//
// ==================== 设计原理 ====================
//
// 在 64 位系统上，使用 NaN-boxing 将所有 JS 值编码在单个 64 位中：
//
// IEEE 754 double 格式：
//   [sign:1] [exponent:11] [mantissa:52]
//
// 当 exponent = 0x7FF 且 mantissa != 0 时是 NaN。
// 我们利用 NaN 的 mantissa 空间来编码其他类型。
//
// ==================== 编码方案 ====================
//
// 1. 纯 double (浮点数):
//    - 直接存储 64 位 IEEE 754 值
//    - 只要不是我们的特殊 NaN 模式，就是 double
//
// 2. Tagged values (使用特殊 NaN 模式):
//    - 高 13 位: 0x7FF8 >> 3 = 标识 tagged value
//    - 接下来 3 位: tag (0-7)
//    - 低 48 位: payload (指针或立即值)
//
//    布局: [0x7FF : 12 bits] [1:1 bit] [tag : 3 bits] [payload : 48 bits]
//
// ==================== Tag 定义 ====================
//
// 使用简化的 tag 编码 (3 bits = 8 种类型):
//   0: int32        - payload 是 32 位有符号整数
//   1: boolean      - payload 是 0 或 1
//   2: null         - payload 忽略
//   3: undefined    - payload 忽略
//   4: string       - payload 是 char* 指针
//   5: object       - payload 是对象指针
//   6: array        - payload 是数组指针
//   7: function     - payload 是函数指针

// ==================== 常量定义 ====================

// NaN-boxing 基础
export const JS_TAG_MASK = 0x0007000000000000n; // Tag 位 (bits 48-50)
export const JS_PAYLOAD_MASK = 0x0000ffffffffffffn; // Payload 位 (bits 0-47)

// Tag 值 (左移 48 位后的值)
export const JS_TAG_INT32 = 0;
export const JS_TAG_BOOL = 1;
export const JS_TAG_NULL = 2;
export const JS_TAG_UNDEFINED = 3;
export const JS_TAG_STRING = 4;
export const JS_TAG_OBJECT = 5;
export const JS_TAG_ARRAY = 6;
export const JS_TAG_FUNCTION = 7;

// 预计算的 tag 基础值 (JS_NAN_BOXING_BASE | (tag << 48))
export const JS_TAG_INT32_BASE = 0x7ff8000000000000n; // tag 0
export const JS_TAG_BOOL_BASE = 0x7ff9000000000000n; // tag 1
export const JS_TAG_NULL_BASE = 0x7ffa000000000000n; // tag 2
export const JS_TAG_UNDEFINED_BASE = 0x7ffb000000000000n; // tag 3
export const JS_TAG_STRING_BASE = 0x7ffc000000000000n; // tag 4
export const JS_TAG_OBJECT_BASE = 0x7ffd000000000000n; // tag 5
export const JS_TAG_ARRAY_BASE = 0x7ffe000000000000n; // tag 6
export const JS_TAG_FUNCTION_BASE = 0x7fff000000000000n; // tag 7

// 预定义的特殊值
export const JS_NULL = JS_TAG_NULL_BASE; // 0x7FFA000000000000
export const JS_UNDEFINED = JS_TAG_UNDEFINED_BASE; // 0x7FFB000000000000
export const JS_TRUE = JS_TAG_BOOL_BASE | 1n; // 0x7FF9000000000001
export const JS_FALSE = JS_TAG_BOOL_BASE | 0n; // 0x7FF9000000000000

// ==================== TypedArray 子类型编码 ====================
//
// 对于 JS_TAG_ARRAY，使用 payload 的 bits 44-47 编码子类型：
// - 0 = 普通 Array
// - 1-11 = TypedArray (Int8, Uint8, Uint8C, Int16, Uint16, Int32, Uint32, Float32, Float64, BigInt64, BigUint64)
// - 12 = ArrayBuffer
//
// JSValue 布局: [tag:16][subtype:4][ptr:44]
//
export const JS_ARRAY_SUBTYPE_SHIFT = 44n;
export const JS_ARRAY_SUBTYPE_MASK = 0x0000f00000000000n; // bits 44-47
export const JS_ARRAY_PTR_MASK = 0x00000fffffffffffn; // bits 0-43 (44 bit pointer)

// 获取数组子类型
export function JS_GET_ARRAY_SUBTYPE(v) {
    return Number((v >> JS_ARRAY_SUBTYPE_SHIFT) & 0xfn);
}

// 获取数组指针 (44 位)
export function JS_GET_ARRAY_PTR(v) {
    return v & JS_ARRAY_PTR_MASK;
}

// 创建 TypedArray 值
export function JS_MKTYPEDARRAY(subtype, ptr) {
    return JS_TAG_ARRAY_BASE | (BigInt(subtype) << JS_ARRAY_SUBTYPE_SHIFT) | (BigInt(ptr) & JS_ARRAY_PTR_MASK);
}

// ==================== 类型检测 ====================

// 检查是否是 double (非 tagged value)
// double 的高 12 位不能是 0x7FF (NaN/Inf pattern)，或者是标准 NaN/Inf
export function JS_VALUE_IS_FLOAT64(v) {
    const high16 = (v >> 48n) & 0xffffn;
    // 如果高 16 位 < 0x7FF8，是普通 double
    // 如果高 16 位 > 0x7FFF，也是普通 double (负数 NaN，不应该出现)
    return high16 < 0x7ff8n;
}

// ==================== 对象布局 ====================
//
// String: 纯 char* (null 结尾的 C 字符串)
//   JSValue 的 payload 直接指向字符数据，无头部
//
// Array:
//   +0: length (int64)
//   +8: capacity (int64)
//   +16: elements[0] (JSValue, 8 bytes)
//   +24: elements[1] (JSValue, 8 bytes)
//   ...
//
// Object(56B 头,见 runtime/types/object/index.js:29):
//   +0: flags_and_size(qword:mark/type/class/size 位域,见 allocator.js:195)
//   +8: count (int64)          +16: __proto__ (指针)
//   +24: capacity (int64)      +32: props_ptr (外置 16B kv 数组:装箱 key + value)
//   +40: flags_ptr             +48: shape_ptr (0=无形状;v1 静态形状 IC)
//
// Function/Closure:
//   +0: code_ptr (指向代码)
//   +8: env_ptr (闭包环境，可为 0)
//   ...

// ==================== 运行时生成器 ====================

import { VReg } from "../../vm/index.js";

export class JSValueGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        this.generateValidateCallable();
        this.generateIsFloat64();
        this.generateGetTag();
        this.generateGetPayload();
        this.generateBoxString();
        this.generateBoxArray();
        this.generateBoxObject();
        this.generateBoxRetHelpers();
        this.generateBoxFunction();
        this.generateUnbox();
        this.generateTypeof();
        this.generateBigIntStub();
        this.generateGetTypeName();
        this.generateTypeofWrapper();
        this.generateInstanceofStub();
    }

    // _js_is_float64(v) -> 1 if double, 0 if boxed
    generateIsFloat64() {
        const vm = this.vm;

        vm.label("_js_is_float64");
        // A0 = JSValue
        // 高 16 位在 [0x7FF8, 0x7FFF] 才是 boxed
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.subImm(VReg.V0, VReg.V0, 0x7ff8);
        vm.cmpImm(VReg.V0, 8);
        vm.jge("_js_is_float64_true"); // Not in [0-7] range
        vm.movImm(VReg.RET, 0);
        vm.ret();
        vm.label("_js_is_float64_true");
        vm.movImm(VReg.RET, 1);
        vm.ret();
    }

    // _js_get_tag(v) -> tag (0-7) or -1 for double
    generateGetTag() {
        const vm = this.vm;

        vm.label("_js_get_tag");
        // A0 = JSValue
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.subImm(VReg.V0, VReg.V0, 0x7ff8);
        vm.cmpImm(VReg.V0, 8);
        vm.jge("_js_get_tag_double"); // Not in [0-7] range
        // 是 boxed value, V0 就是 tag (0-7)
        vm.mov(VReg.RET, VReg.V0);
        vm.ret();
        vm.label("_js_get_tag_double");
        vm.movImm(VReg.RET, -1);
        vm.ret();
    }

    // _js_get_payload(v) -> 48-bit payload
    generateGetPayload() {
        const vm = this.vm;

        vm.label("_js_get_payload");
        // A0 = JSValue
        // 提取低 48 位
        // 使用 V1 避免与 RET 冲突
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        vm.ret();
    }

    // _js_box_string(char_ptr) -> JSValue
    generateBoxString() {
        const vm = this.vm;

        vm.label("_js_box_string");
        // A0 = char* 指针
        // 增加 null 检查
        vm.cmpImm(VReg.A0, 0);
        vm.jne("_js_box_string_safe");
        vm.movImm(VReg.RET, 0); // null -> undefined/null JSValue
        vm.ret();

        vm.label("_js_box_string_safe");
        // 返回 JS_TAG_STRING_BASE | (ptr & PAYLOAD_MASK)
        vm.emitMaskLoad(VReg.V1); // PAYLOAD_MASK
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); // JS_TAG_STRING_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.ret();
    }

    // _js_box_array(array_ptr) -> JSValue
    generateBoxArray() {
        const vm = this.vm;

        vm.label("_js_box_array");
        // A0 = array 指针
        // 使用 V1 避免与 RET(V0) 冲突
        // JSValue 布局: [0x7FFE:16][subtype:4][ptr:44]
        // 普通数组 subtype=0，只保留低 44 位指针
        vm.movImm64(VReg.V1, 0x00000fffffffffffn);
        vm.and(VReg.RET, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n); // JS_TAG_ARRAY_BASE (subtype=0)
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.ret();
    }

    // _js_box_object(obj_ptr) -> JSValue
    generateBoxObject() {
        const vm = this.vm;

        vm.label("_js_box_object");
        // A0 = object 指针
        // 使用 V1 避免与 RET(V0) 冲突
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n); // JS_TAG_OBJECT_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.ret();
    }

    // RET-in-place 装箱助手:对 RET(裸指针)就地打 NaN-box 标签,返回 RET。
    // 供 codegen 把「movImm64(mask);and;movImm64(tag);or」8 条内联序列替换成单条
    // `bl`(arm64)——语义完全相同(仅额外 clobber V1,与内联一致;函数序言恒存 LR)。
    // 覆盖全自举里成千上万处对象/数组装箱,显著缩减产物体积以让出布局余量。
    // [footprint] _validate_callable:合并每处方法/闭包调用前的可调用校验(emitValidateCallableInS0
    // 内联 ~30 insn × 数万站点)。in/out = S0(候选 → 校验后的裸可调用指针);非可调用则抛
    // TypeError("not a function")(不返回)。scratch 用 S4(callee-saved,x64 不与 A 实参寄存器
    // 别名 → 无需旧内联的 x64 push A2/A3 保护);不动 S0 之外的 S1/S2/S3/S5 与 A0-A5,故调用点
    // 后续 dispatch(读 S3=this、置 S1/S2)与已装入的实参不受影响。
    generateValidateCallable() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_validate_callable");
        vm.prologue(0, [VReg.S4]);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_vc_throw");
        vm.mov(VReg.S4, VReg.S0);
        vm.shrImm(VReg.S4, VReg.S4, 48);      // high16
        vm.cmpImm(VReg.S4, 0x7ff8);
        vm.jlt("_vc_raw");                     // high16 < 0x7ff8 → 裸堆指针候选
        vm.cmpImm(VReg.S4, 0x7fff);
        vm.jne("_vc_maybe_proxy");             // tagged 非函数 → 可能是可调用 Proxy
        // tagged 函数(0x7fff):脱壳成裸指针
        vm.movImm64(VReg.S4, MASK);
        vm.and(VReg.S0, VReg.S0, VReg.S4);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_vc_throw");
        vm.epilogue([VReg.S4], 0);
        // [Proxy apply] 装箱对象(0x7FFD)且块 type@0==TYPE_PROXY(8):可调用 Proxy。
        // 合成 24B 闭包块 {CLOSURE_MAGIC@0, _proxy_apply_tramp@8, proxyRaw@16} 返回,
        // 调用点既有 CLOSURE_MAGIC 分派原样把控制交给蹦床(零热路径新增指令)。
        // _alloc 会毁 A0-A5(实参已装好!),先落栈缓冲;S0(proxy raw)callee-saved 跨 _alloc 稳。
        vm.label("_vc_maybe_proxy");
        vm.cmpImm(VReg.S4, 0x7ffd);
        vm.jne("_vc_throw");
        vm.movImm64(VReg.S4, MASK);
        vm.and(VReg.S0, VReg.S0, VReg.S4);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_vc_throw");
        vm.load(VReg.S4, VReg.S0, 0);          // 块类型
        vm.cmpImm(VReg.S4, 8);                 // TYPE_PROXY
        vm.jne("_vc_throw");
        vm.subImm(VReg.SP, VReg.SP, 48);       // A0-A5 落栈(16 对齐:48B)
        vm.store(VReg.SP, 0, VReg.A0);
        vm.store(VReg.SP, 8, VReg.A1);
        vm.store(VReg.SP, 16, VReg.A2);
        vm.store(VReg.SP, 24, VReg.A3);
        vm.store(VReg.SP, 32, VReg.A4);
        vm.store(VReg.SP, 40, VReg.A5);
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");                     // RET = 合成闭包块(S0 proxy 由 _alloc 保)
        vm.movImm(VReg.V1, 0xc105);            // CLOSURE_MAGIC
        vm.store(VReg.RET, 0, VReg.V1);
        vm.lea(VReg.V1, "_proxy_apply_tramp");
        vm.store(VReg.RET, 8, VReg.V1);
        vm.store(VReg.RET, 16, VReg.S0);       // proxy raw
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.load(VReg.A3, VReg.SP, 24);
        vm.load(VReg.A4, VReg.SP, 32);
        vm.load(VReg.A5, VReg.SP, 40);
        vm.addImm(VReg.SP, VReg.SP, 48);
        vm.epilogue([VReg.S4], 0);
        // 裸值:仅当落在 [heap_base, heap_ptr) 才是合法闭包对象
        vm.label("_vc_raw");
        vm.lea(VReg.S4, "_heap_base");
        vm.load(VReg.S4, VReg.S4, 0);
        vm.cmp(VReg.S0, VReg.S4);
        vm.jlt("_vc_throw");
        vm.lea(VReg.S4, "_heap_ptr");
        vm.load(VReg.S4, VReg.S4, 0);
        vm.cmp(VReg.S0, VReg.S4);
        vm.jge("_vc_throw");
        vm.epilogue([VReg.S4], 0);
        vm.label("_vc_throw");
        vm.call("_throw_not_a_function");      // 不返回(_throw_unwind)
        // _throw_not_a_function:置 _exception_value="not a function"、pending=1,跨函数 unwind。
        vm.label("_throw_not_a_function");
        // [test262 S1] 抛真 TypeError 对象(原抛裸字符串 → e instanceof TypeError / e.name 失败)。
        // 构造 boxed "not a function" 消息后委托 _throw_type_error(构造 {name,message,__asmjs_err,cause}
        // 并 _throw_unwind)。bl 不改 SP(arm64),_throw_type_error 自管帧,frameless 调用安全。
        vm.lea(VReg.V0, vm.asm.addString("not a function"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.V0, VReg.V0, VReg.V1); // box 堆串
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_throw_type_error"); // 不返回(_throw_unwind)
    }

    generateBoxRetHelpers() {
        const vm = this.vm;
        // _box_obj_r: RET = (RET & PAYLOAD) | OBJECT_TAG
        vm.label("_box_obj_r");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.ret();
        // _box_arr_r: RET = (RET & PAYLOAD) | ARRAY_TAG
        vm.label("_box_arr_r");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.ret();
        // _tag_str_a1: A1 = A1 | STRING_TAG(数据段 key 指针已洁净高位,无需 and)。
        // 用 V0 作 scratch 与内联序列 `movImm64(V0,tag);or(A1,A1,V0)` 完全一致的 clobber。
        // 覆盖每处属性访问的字符串键装箱(_object_get/_object_set 前),极高频。
        vm.label("_tag_str_a1");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.ret();
        // _tag_key_a1: A1 = A1 | STRING_TAG,但 scratch 用 **V1**(与 emitBoxedStringKey
        // 内联序列 `movImm64(V1,tag); or(A1,A1,V1)` 的 clobber 完全一致 → 逐站点替换是
        // clobber-identical,无需审计 V0/RET 存活)。仅额外 clobber LR(bl),而 key-tag
        // 站点后恒随 _object_get/_object_set 等 call,LR 早已死。覆盖每处属性访问的
        // 字符串键装箱(emitBoxedStringKey 的 A1 路径),极高频。
        vm.label("_tag_key_a1");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.ret();
    }

    // _js_box_function(func_ptr) -> JSValue
    generateBoxFunction() {
        const vm = this.vm;

        vm.label("_js_box_function");
        // A0 = function/closure 指针
        // 使用 V1 避免与 RET(V0) 冲突
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n); // JS_TAG_FUNCTION_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.ret();
    }

    // _js_unbox(v) -> 指针
    // 注意：V0 和 RET 都映射到 X0，所以要避免使用 V0
    // 不再进行符号扩展：用户空间 heap 地址的 bit 47 可能为 1
    // （特别是在某些 QEMU/Docker 环境中），符号扩展会破坏地址
    // 注意：X1 (A1) 不是 callee-saved，但很多调用者依赖 A1 被保留，
    // 所以需要保存 X1 并在返回前恢复
    generateUnbox() {
        const vm = this.vm;

        vm.label("_js_unbox");
        // 保存 X1 (A1) 因为它不是 callee-saved，但可能被调用者使用
        vm.push(VReg.A1);
        // A0 = JSValue
        // 提取 payload (低 48 位)
        // 使用 V1 作为临时寄存器 (已被 push 保存)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        // 恢复 X1 (A1)
        vm.pop(VReg.A1);
        vm.ret();
    }

    // _js_typeof(v) -> 返回指向类型字符串的 JSValue (NaN-boxed string)
    // 标准 typeof 返回值: "undefined", "boolean", "number", "string", "object", "function", "symbol", "bigint"
    generateTypeof() {
        const vm = this.vm;

        vm.label("_js_typeof");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // 保存 JSValue

        const doneLabel = "_js_typeof_done";

        // BigInt 检测（裸堆指针，类型标记 TYPE_BIGINT）——必须在 double 判断前，
        // 因为 BigInt 是裸指针（高16=0 < 0x7FF8 会被误判 number）
        vm.call("_is_bigint"); // A0=S0 已是被测值
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_js_typeof_bigint");
        // Symbol 检测（裸堆指针，用户区 [ptr+0] == TYPE_SYMBOL）——同 BigInt，
        // 必须在 double 判断前（裸指针高16=0 会被误判 number）
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_js_typeof_symbol");
        vm.mov(VReg.A0, VReg.S0); // 恢复 A0（_is_bigint 只读不改，但保险）

        // 类引用/裸闭包检测：类信息对象以「裸」class-info 指针存储（未 NaN-box,
        // 高16=0),type@0 = TYPE_CLOSURE(3)。typeof 若只看高16 会当 number。
        // 判别同 _is_symbol：高16=0、非空、落在 [heap_base, heap_ptr) 且 type@0==3 → "function"。
        // （堆区间守卫使真 double 0.0 / 小 denormal 不会误解引用；只有真堆 type-3 命中。）
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_js_typeof_notclass");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_js_typeof_notclass");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jb("_js_typeof_notclass");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jae("_js_typeof_notclass");
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 3); // TYPE_CLOSURE
        vm.jeq("_js_typeof_function");
        // [bug1] 其余落在堆范围内的「裸」指针（Map=4/Set=5 等未 NaN-box 的堆对象，
        //  高16=0）typeof 应为 "object"，否则会被下方 double 判断误判为 "number"。
        //  以 type@0 ∈ [1,14] 或 TypedArray 区间 [0x40,0x61] 为有效堆对象守卫，
        //  规避真·微小 double 别名进堆区被误判（其 type@0 极少落在这些区间）。
        vm.cmpImm(VReg.V1, 1);
        vm.jb("_js_typeof_notclass");
        vm.cmpImm(VReg.V1, 14);
        vm.jbe("_js_typeof_object");
        vm.cmpImm(VReg.V1, 0x40);
        vm.jb("_js_typeof_notclass");
        vm.cmpImm(VReg.V1, 0x61);
        vm.jbe("_js_typeof_object");
        vm.label("_js_typeof_notclass");

        // 提取高 16 位 (bits 48-63)
        vm.shrImm(VReg.S1, VReg.S0, 48);

        // 检查是否是 double:高 16 位 < 0x7FF8 或 > 0x7FFF(负 double 高位 0x8000+;
        // 曾漏判 → typeof -1.5 得 "object",JSON.stringify 负浮点输出 {},#15 实锤)
        vm.movImm(VReg.V0, 0x7ff8);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jlt("_js_typeof_number");
        vm.movImm(VReg.V0, 0x7fff);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jgt("_js_typeof_number");

        // 计算 tag (高 16 位 - 0x7FF8 = tag 0-7)
        vm.subImm(VReg.V0, VReg.S1, 0x7ff8); // V0 = tag

        // Tag 0: int32 -> "number"
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_js_typeof_number");

        // Tag 1: boolean -> "boolean"
        vm.cmpImm(VReg.V0, 1);
        vm.jeq("_js_typeof_boolean");

        // Tag 2: null -> "object" (JS 历史遗留)
        vm.cmpImm(VReg.V0, 2);
        vm.jeq("_js_typeof_object");

        // Tag 3: undefined -> "undefined"
        vm.cmpImm(VReg.V0, 3);
        vm.jeq("_js_typeof_undefined");

        // Tag 4: string -> "string"
        vm.cmpImm(VReg.V0, 4);
        vm.jeq("_js_typeof_string");

        // Tag 5: object -> "object";Proxy(块 type@0==8)且 target 可调用 → "function"
        vm.cmpImm(VReg.V0, 5);
        vm.jeq("_js_typeof_objproxy");

        // Tag 6: array -> "object"
        vm.cmpImm(VReg.V0, 6);
        vm.jeq("_js_typeof_object");

        // Tag 7: function -> "function"
        vm.cmpImm(VReg.V0, 7);
        vm.jeq("_js_typeof_function");

        // 未知类型 - 默认 "object"
        vm.jmp("_js_typeof_object");

        // Tag 5 细分:Proxy 且 target 可调用(tag 0x7FFF / 裸 type-3 classinfo /
        // 裸闭包 magic)→ "function";其余对象 → "object"。
        vm.label("_js_typeof_objproxy");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_js_typeof_object");
        vm.load(VReg.V0, VReg.V1, 0);
        vm.cmpImm(VReg.V0, 8); // TYPE_PROXY
        vm.jne("_js_typeof_object");
        vm.load(VReg.V1, VReg.V1, 8); // target(存放形态)
        vm.shrImm(VReg.V0, VReg.V1, 48);
        vm.cmpImm(VReg.V0, 0x7fff);
        vm.jeq("_js_typeof_function");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_js_typeof_object");
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_js_typeof_object");
        vm.load(VReg.V0, VReg.V1, 0); // 裸 target:type/magic 判可调用
        vm.cmpImm(VReg.V0, 3);        // TYPE_CLOSURE(classinfo)
        vm.jeq("_js_typeof_function");
        vm.cmpImm(VReg.V0, 0xc105);   // CLOSURE_MAGIC
        vm.jeq("_js_typeof_function");
        vm.cmpImm(VReg.V0, 0xa51c);   // ASYNC_CLOSURE_MAGIC
        vm.jeq("_js_typeof_function");
        vm.jmp("_js_typeof_object");

        // ========== 返回类型字符串 ==========
        vm.label("_js_typeof_number");
        vm.lea(VReg.A0, "_str_number");
        vm.call("_js_box_string");
        vm.jmp(doneLabel);

        vm.label("_js_typeof_bigint");
        vm.lea(VReg.A0, "_str_bigint");
        vm.call("_js_box_string");
        vm.jmp(doneLabel);

        vm.label("_js_typeof_symbol");
        vm.lea(VReg.A0, "_str_symbol_type");
        vm.call("_js_box_string");
        vm.jmp(doneLabel);

        vm.label("_js_typeof_boolean");
        vm.lea(VReg.A0, "_str_boolean");
        vm.call("_js_box_string");
        vm.jmp(doneLabel);

        vm.label("_js_typeof_undefined");
        vm.lea(VReg.A0, "_str_undefined");
        vm.call("_js_box_string");
        vm.jmp(doneLabel);

        vm.label("_js_typeof_string");
        vm.lea(VReg.A0, "_str_string");
        vm.call("_js_box_string");
        vm.jmp(doneLabel);

        vm.label("_js_typeof_object");
        vm.lea(VReg.A0, "_str_object_type");
        vm.call("_js_box_string");
        vm.jmp(doneLabel);

        vm.label("_js_typeof_function");
        vm.lea(VReg.A0, "_str_function_type");
        vm.call("_js_box_string");

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _user_BigInt(v): 为编译器自举提供的 BigInt 桩函数
    // 简单地返回输入值 (JSValue)
    generateBigIntStub() {
        const vm = this.vm;
        vm.label("_user_BigInt");
        vm.mov(VReg.RET, VReg.A0);
        vm.ret();
    }

    // _get_type_name(typeByte) -> 返回详细类型名称字符串 (用于 TypedArray/ArrayBuffer 打印)
    // A0 = 堆块类型字节(TYPE_*_ARRAY 0x40-0x61 / TYPE_ARRAY_BUFFER 12)
    // RET = string pointer (raw, not boxed)
    generateGetTypeName() {
        const vm = this.vm;
        vm.label("_get_type_name");
        vm.prologue(16, [VReg.S0]);
        vm.andImm(VReg.A0, VReg.A0, 0xff);
        const pairs = [
            [0x40, "_str_Int8Array"], [0x41, "_str_Int16Array"], [0x42, "_str_Int32Array"],
            [0x43, "_str_BigInt64Array"], [0x50, "_str_Uint8Array"], [0x51, "_str_Uint16Array"],
            [0x52, "_str_Uint32Array"], [0x53, "_str_BigUint64Array"], [0x54, "_str_Uint8ClampedArray"],
            [0x60, "_str_Float32Array"], [0x61, "_str_Float64Array"], [12, "_str_ArrayBuffer"],
        ];
        for (const [ty, lbl] of pairs) {
            const skip = "_gtn_skip_" + ty.toString(16);
            vm.cmpImm(VReg.A0, ty);
            vm.jne(skip);
            vm.lea(VReg.RET, lbl);
            vm.epilogue([VReg.S0], 16);
            vm.label(skip);
        }
        vm.lea(VReg.RET, "_str_object_type");
        vm.epilogue([VReg.S0], 16);
    }

    // _typeof(v) -> 返回类型字符串（raw pointer，不装箱）
    // 这是 _js_typeof 的包装器，编译器调用这个版本
    // A0 = input JSValue
    // RET = NaN-boxed string
    generateTypeofWrapper() {
        const vm = this.vm;
        vm.label("_typeof");
        // 直接跳转到 _js_typeof，共享同一个函数体
        vm.jmp("_js_typeof");
    }

    // _instanceof(obj, Constructor) -> 返回 true/false (NaN-boxed)
    // A0 = value, A1 = Constructor(内建标识:Array=1、Object=2,见 members.js;
    // 用户类原型链检查未实现,保持 false —— #15 起 Array/Object 语义可用,
    // Array.isArray 也分派到本函数(A1=1))。负 double(高位 0x8000+)天然
    // 匹配不了任何 tag/堆范围 → false ✓。
    generateInstanceofStub() {
        const vm = this.vm;
        // _try_hasinstance(A0=构造器/right, A1=实例/left) -> RET:
        //   若 right 有 function 型 [Symbol.hasInstance],以 (left) 调之(this=right)、结果
        //   经 _to_boolean 归一为装箱布尔返回;否则返回裸 0(哨兵:无 hasInstance,走常规 instanceof)。
        //   right 脱壳成裸指针后传 _object_get(接受高16=0 裸指针,含 classinfo type=3)。
        vm.label("_try_hasinstance");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S2, VReg.A0); // right(构造器)
        vm.mov(VReg.S3, VReg.A1); // left(实例)
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.S0, VReg.S2, VReg.V0); // 裸 right 指针
        // 堆界守卫:非堆对象(数字/内建码/null)→ 无 hasInstance
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1); vm.jlt("_thi_none");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1); vm.jge("_thi_none");
        // well-known Symbol.hasInstance
        vm.lea(VReg.A0, "_symwk_hasInstance");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.hasInstance"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown"); // RET = symbol 键
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);     // 裸 right
        vm.call("_object_get");       // RET = 方法或 undef/0
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);   // function tag
        vm.jne("_thi_none");
        // 调 [Symbol.hasInstance](left)。方法值可能是闭包(magic 0xc105@0,真函数@8,对象字面量
        // 方法)或裸函数指针(类静态方法,label 即入口)——按 magic 分派(同 _aref_invoke_cb)。
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.S0, VReg.S1, VReg.V0); // 脱壳指针
        vm.load(VReg.V0, VReg.S0, 0);      // magic / 首指令字
        vm.movImm(VReg.V1, 0xc105);        // CLOSURE_MAGIC
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_thi_bare");
        vm.load(VReg.V1, VReg.S0, 8);      // 闭包:真函数指针@8,S0 保持闭包
        vm.jmp("_thi_call");
        vm.label("_thi_bare");
        vm.mov(VReg.V1, VReg.S0);          // 裸函数:指针即入口
        vm.movImm(VReg.S0, 0);             // 无闭包
        vm.label("_thi_call");
        vm.mov(VReg.A0, VReg.S3);     // arg0 = 实例
        vm.mov(VReg.A5, VReg.S2);     // this = 构造器
        vm.setCallArgcImm(1, VReg.V0, VReg.V2); // [argc ABI] [Symbol.hasInstance](x)
        vm.callIndirect(VReg.V1);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");       // 归一装箱布尔
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_thi_none");
        vm.movImm(VReg.RET, 0);       // 裸 0 哨兵
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _isarray_ref(A0=value) -> boxed bool。Array.isArray 作一等值(回调/变量)的
        // 引用 wrapper:闭包按 A0=首实参调用,此处补常量 A1=1(Array 类型标识)后
        // 尾跳 _instanceof(其 ret 直返原调用者)。调用位 Array.isArray(x) 不经此
        // (compileCallExpression 静态分派)。
        vm.label("_isarray_ref");
        vm.movImm(VReg.A1, 1);
        vm.jmp("_instanceof");

        vm.label("_instanceof");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        vm.cmpImm(VReg.A1, 1);
        vm.jne("_iof_chk_obj");
        // Array:tag 0x7FFE,或裸堆指针且块 type==1
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7ffe);
        vm.jeq("_iof_true");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_iof_false");
        vm.lea(VReg.V2, "_heap_base");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jlt("_iof_false");
        vm.lea(VReg.V2, "_heap_ptr");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jge("_iof_false");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 1);
        vm.jeq("_iof_true");
        vm.jmp("_iof_false");

        vm.label("_iof_chk_obj");
        vm.cmpImm(VReg.A1, 2);
        vm.jne("_iof_chk_fn");
        // Object:对象/数组 tag、函数 tag(函数亦是对象),或裸堆指针(宽松:堆上复合对象都算)
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7ffd);
        vm.jeq("_iof_true");
        vm.cmpImm(VReg.V1, 0x7ffe);
        vm.jeq("_iof_true");
        vm.cmpImm(VReg.V1, 0x7fff); // [bug8] 函数值(tag 0x7FFF)→ instanceof Object 为真
        vm.jeq("_iof_true");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_iof_false");
        vm.lea(VReg.V2, "_heap_base");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jlt("_iof_false");
        vm.lea(VReg.V2, "_heap_ptr");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jge("_iof_false");
        vm.jmp("_iof_true");

        // [bug8] Function 构造器哨兵(A1==3):函数值 tag 0x7FFF,或裸堆 classinfo(type-3,
        // 类作值)/裸闭包 magic。其余 → false。落在 _iof_user(把 A1 当 classinfo 指针)之前拦下。
        vm.label("_iof_chk_fn");
        vm.cmpImm(VReg.A1, 3);
        vm.jne("_iof_user");
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7fff);
        vm.jeq("_iof_true");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_iof_false");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_iof_false");
        vm.lea(VReg.V2, "_heap_base");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jlt("_iof_false");
        vm.lea(VReg.V2, "_heap_ptr");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jge("_iof_false");
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 3); // TYPE_CLOSURE / classinfo
        vm.jeq("_iof_true");
        vm.cmpImm(VReg.V1, 0xc105); // CLOSURE_MAGIC(裸闭包)
        vm.jeq("_iof_true");
        vm.cmpImm(VReg.V1, 0xa51c); // ASYNC_CLOSURE_MAGIC
        vm.jeq("_iof_true");
        vm.jmp("_iof_false");

        // [#66 Phase1a] 用户类原型链 instanceof。A1 = 裸 classinfo 指针
        // (高16=0、堆内、[+0]==3 FUNCTION);目标 prototype = [[A1+32]+24]。
        // 实例(S0)脱壳后沿 __proto__(@16)上溯,命中目标 → true。纯比较,无 call,
        // 只用 caller-saved V1-V4(x64 别名:V1=RCX/V2=RDX/V3=R8/V4=R9,均无活参),
        // A1 全程不动;prototype 链指针为裸指针,每次解引用前守 [heap_base,heap_ptr)。
        vm.label("_iof_user");
        // A1 必须是裸堆指针(高16=0)
        vm.shrImm(VReg.V1, VReg.A1, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_iof_false");
        vm.lea(VReg.V2, "_heap_base");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.A1, VReg.V2);
        vm.jlt("_iof_false");
        vm.lea(VReg.V2, "_heap_ptr");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.A1, VReg.V2);
        vm.jge("_iof_false");
        // [A1+0] == 3 (FUNCTION/类信息对象)?
        vm.loadByte(VReg.V1, VReg.A1, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_iof_false");
        // 目标 prototype = [[A1+32]+24] (props_ptr → props[1].val 裸 proto)
        vm.load(VReg.V2, VReg.A1, 32);
        vm.load(VReg.V2, VReg.V2, 24);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_iof_false");
        // [#69] 普通函数 instanceof 复用入口:S0=实例、V2=目标 prototype(裸)已就位。
        vm.label("_iof_proto_walk");
        // 实例脱壳:S0 高16 ∈ {0x7FFD,0x7FFE,0} 才是对象,否则 false
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_iof_user_raw");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_iof_user_unbox");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_iof_user_unbox");
        vm.jmp("_iof_false");
        vm.label("_iof_user_unbox");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1); // S0 = 裸实例指针
        vm.label("_iof_user_raw");
        // 守卫裸实例指针在堆内再解引用
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_iof_false");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_iof_false");
        vm.load(VReg.V3, VReg.S0, 16); // cur = 首个 __proto__
        vm.movImm(VReg.V4, 64);        // 防环计数
        vm.label("_iof_user_loop");
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_iof_false");
        vm.cmp(VReg.V3, VReg.V2);
        vm.jeq("_iof_true");
        vm.subImm(VReg.V4, VReg.V4, 1);
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_iof_false");
        // 守卫 cur 在堆内再上溯
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V3, VReg.V1);
        vm.jlt("_iof_false");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V3, VReg.V1);
        vm.jge("_iof_false");
        vm.load(VReg.V3, VReg.V3, 16); // cur = cur.__proto__
        vm.jmp("_iof_user_loop");

        vm.label("_iof_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0], 16);

        vm.label("_iof_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0], 16);

        // [#69] _instanceof_proto(A0=实例, A1=目标 prototype 裸指针) → true/false。
        // 普通函数 new F 挂 __proto__=F.prototype;此处沿实例 __proto__ 链上溯比对,
        // 复用 _iof_proto_walk(与用户类 instanceof 同一防环/堆守卫的上溯逻辑)。
        vm.label("_instanceof_proto");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0); // S0 = 实例
        vm.mov(VReg.V2, VReg.A1); // V2 = 目标 prototype(裸)
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_iof_false"); // 无 prototype(尚无实例)→ false
        vm.jmp("_iof_proto_walk");
    }
}
