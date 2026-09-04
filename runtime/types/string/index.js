// asm.js 字符串运行时
// 提供字符串操作函数

import { VReg } from "../../../vm/registers.js";
import { Reg } from "../../../backend/arm64.js";
import { TYPE_ARRAY, TYPE_OBJECT, TYPE_STRING, HEADER_SIZE } from "../../core/allocator.js";
import { JS_ARRAY_PTR_MASK, JS_GET_ARRAY_PTR } from "../../core/jsvalue.js";

export class StringGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    // 辅助函数: 安全地写入对象头中的类型标记和长度，不破坏 allocator 的 size 和 sizeClass
    // ptrReg: 字符串内容区指针 (block + 16)
    // lenReg: 字符串长度
    writeStringHeader(ptrReg, lenReg) {
        const vm = this.vm;
        const TYPE_STRING = 6;

        // [ALLOC_DBG] 抓「以巨型 length 建字符串头」的创建点：正常源码串远 < 50M。
        if (process.env.ALLOC_DBG) {
            this._strhdrDbgCounter = (this._strhdrDbgCounter || 0) + 1;
            const skip = "_strhdr_dbg_skip_" + this._strhdrDbgCounter;
            vm.movImm64(VReg.V0, 50000000n);
            vm.cmp(lenReg, VReg.V0);
            vm.jle(skip);
            vm.mov(VReg.A0, lenReg);
            vm.mov(VReg.A1, VReg.FP);
            vm.call("_strhdr_dbg_report");
            vm.label(skip);
        }

        vm.subImm(VReg.V0, ptrReg, 16); // V0 = block pointer

        // 1. 保留高 56 位的 metadata (size, class), 覆盖低 8 位为 TYPE_STRING
        vm.load(VReg.V1, VReg.V0, 0); // V1 = old flags_and_size
        vm.movImm64(VReg.V2, 0xffffffffffffff00n);
        vm.and(VReg.V1, VReg.V1, VReg.V2); // 清除低 8 位
        vm.movImm(VReg.V2, TYPE_STRING); // asm.js 中类型保存在最低 byte
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.V0, 0, VReg.V1); // 写回
        
        // 2. 写入对象长度
        vm.store(VReg.V0, 8, lenReg);
    }

    // [W-39] this-check: validates A0 is a string value.
    // Accepts: 0x7FFC (boxed string, from dynamic dispatch), 0x7FFD (boxed wrapper object,
    //   from new String(...) -- extract __value before dispatching), raw pointer (high16=0,
    //   from compiler static dispatch with _getStrContent pre-validation).
    // Rejects: anything else (numbers, booleans, undefined, etc.) -> TypeError.
    //放在 prologue 之后、方法体之前——prologue 已保存 S 寄存器,V0/V1 为 scratch 安全。
    // _throw_type_error 不返回,无需恢复寄存器。
    _emitThisStringCheck(methodName) {
        const vm = this.vm;
        const okLabel = "_thischeck_ok_" + methodName;
        const extractLabel = "_thischeck_extract_" + methodName;
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);  // boxed string (dynamic dispatch)
        vm.jeq(okLabel);
        vm.cmpImm(VReg.V0, 0x7FFD);  // boxed wrapper object (new String(...))
        vm.jeq(extractLabel);
        vm.cmpImm(VReg.V0, 0);       // raw pointer (compiler static dispatch)
        vm.jeq(okLabel);
        // non-string -- throw TypeError
        vm.lea(VReg.A0, vm.asm.addString("String.prototype method called on non-string value"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        // 0x7FFD extraction: call _object_get(A0=boxed obj, A1=boxed "__value" key)
        // _object_get preserves S0-S5 (its own prologue/epilogue), only clobbers V0-V4.
        vm.label(extractLabel);
        vm.mov(VReg.V0, VReg.A0);         // V0 = boxed obj (used as first arg below)
        vm.mov(VReg.A0, VReg.V0);         // A0 = boxed obj
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.call("_tag_key_a1");            // A1 = boxed "__value" key
        vm.call("_object_get");            // RET = primitive string (0x7FFC)
        vm.mov(VReg.A0, VReg.RET);        // A0 = extracted string for method body
        vm.label(okLabel);
    }

    _emitThrowTypeError(msg) {
        const vm = this.vm;
        vm.lea(VReg.A0, vm.asm.addString(msg));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    // _emitThisToString(methodName) —— ES RequireObjectCoercible(this) + ToString(this)。
    // 快路径:装箱串(0x7FFC)与编译器静态派发的裸串指针(high16=0,非 Symbol)原样通过。
    // null/undefined → TypeError; Symbol 裸块 → TypeError; 其余走 _valueToStr。
    // 调用前必须先把 A1/A2 存进 S* 或栈:本函数会 call,摧毁 caller-saved。
    _emitThisToString(methodName) {
        const vm = this.vm;
        const okLabel = "_thiscoerce_ok_" + methodName;
        const extractLabel = "_thiscoerce_extract_" + methodName;
        const forceLabel = "_thiscoerce_force_" + methodName;
        const throwNull = "_thiscoerce_nullish_" + methodName;
        const throwSym = "_thiscoerce_sym_" + methodName;
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);  // null
        vm.jeq(throwNull);
        vm.cmpImm(VReg.V0, 0x7FFB);  // undefined
        vm.jeq(throwNull);
        vm.cmpImm(VReg.V0, 0x7FFC);  // boxed string
        vm.jeq(okLabel);
        vm.cmpImm(VReg.V0, 0x7FFD);  // boxed wrapper / 普通对象
        vm.jeq(extractLabel);
        vm.cmpImm(VReg.V0, 0);       // 裸指针:编译器静态串,或 Symbol 堆块,或 int 0
        vm.jne(forceLabel);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq(forceLabel); // 整数 0(+0→int0):ToString → "0"
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jb(okLabel);
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jae(okLabel);
        // Heap strings are passed around as their content pointer (block+16),
        // while Symbols use the same naked-pointer shape but store
        // TYPE_SYMBOL at user+0.  Looking only at A0[0] therefore mistakes a
        // one-byte string beginning with character code 61 ('=') for a
        // Symbol.  Validate the allocation header first; only a non-string
        // heap object may use the user byte as the Symbol discriminator.
        vm.subImm(VReg.V0, VReg.A0, 16);
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jb(okLabel);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 6); // TYPE_STRING
        vm.jeq(okLabel);
        vm.loadByte(VReg.V1, VReg.A0, 0);
        vm.cmpImm(VReg.V1, 61); // TYPE_SYMBOL
        vm.jeq(throwSym);
        vm.jmp(okLabel);
        vm.label(throwNull);
        this._emitThrowTypeError("Cannot convert undefined or null to object");
        vm.label(throwSym);
        this._emitThrowTypeError("Cannot convert a Symbol value to a string");
        vm.label(forceLabel);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.jmp(okLabel);
        vm.label(extractLabel);
        vm.push(VReg.A0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.call("_tag_key_a1");
        vm.call("_object_get");
        vm.pop(VReg.V1);
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_thiscoerce_prim_" + methodName);
        vm.mov(VReg.A0, VReg.RET);
        vm.jmp(okLabel);
        vm.label("_thiscoerce_prim_" + methodName);
        // __value 是数字/布尔等原始值:ToString(__value);缺省/对象则 ToString(原 this)
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_thiscoerce_fallback_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_thiscoerce_fallback_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_thiscoerce_fallback_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_thiscoerce_fallback_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_thiscoerce_fallback_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_thiscoerce_fallback_" + methodName);
        vm.mov(VReg.A0, VReg.RET);
        vm.jmp(forceLabel);
        vm.label("_thiscoerce_fallback_" + methodName);
        // String 包装用 __value;Number/Boolean 包装分别是 __number_value / __boolean_value。
        vm.mov(VReg.A0, VReg.V1);
        vm.push(VReg.V1);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.call("_tag_key_a1");
        vm.call("_object_get");
        vm.pop(VReg.V1);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_thiscoerce_trybool_" + methodName);
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_thiscoerce_trybool_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFB); // miss → undefined,不可 ToString(undefined)
        vm.jeq("_thiscoerce_trybool_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_thiscoerce_trybool_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_thiscoerce_trybool_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_thiscoerce_trybool_" + methodName);
        vm.mov(VReg.A0, VReg.RET);
        vm.jmp(forceLabel);
        vm.label("_thiscoerce_trybool_" + methodName);
        vm.mov(VReg.A0, VReg.V1);
        vm.push(VReg.V1);
        vm.lea(VReg.A1, vm.asm.addString("__boolean_value"));
        vm.call("_tag_key_a1");
        vm.call("_object_get");
        vm.pop(VReg.V1);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_thiscoerce_obj_" + methodName);
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_thiscoerce_obj_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_thiscoerce_obj_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_thiscoerce_obj_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_thiscoerce_obj_" + methodName);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_thiscoerce_obj_" + methodName);
        vm.mov(VReg.A0, VReg.RET);
        vm.jmp(forceLabel);
        vm.label("_thiscoerce_obj_" + methodName);
        vm.mov(VReg.A0, VReg.V1);
        vm.jmp(forceLabel);
        vm.label(okLabel);
    }

    // ES ToInteger(A0) → RET 裸有符号整数。
    // 快路径:裸 int(high16=0)与静态派发的负数(high16=0xFFFF)原样返回——charAt(0)/
    // codePointAt(i) 热路径与自举 path.charAt(0) 字节级不变。
    // undefined/null → 0;布尔取 payload;串/对象走 ToNumber 再 trunc。
    // 不可对裸负数调 _syscall_arg:会把 -1 的位型当 float NaN→0。
    _emitToInteger(tag) {
        const vm = this.vm;
        const raw = "_toi_raw_" + tag;
        const done = "_toi_done_" + tag;
        const zero = "_toi_zero_" + tag;
        const boolp = "_toi_bool_" + tag;
        const coerce = "_toi_coerce_" + tag;
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(raw);
        vm.cmpImm(VReg.V1, 0xFFFF);
        vm.jeq(raw);
        // fcvtzs(-Inf)=INT64_MIN,high16=0x8000;当裸负数(position<0→undefined),勿当 float -0。
        vm.movImm(VReg.V0, 0x8000);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq(raw);
        vm.cmpImm(VReg.V1, 0x7FFA); // null
        vm.jeq(zero);
        vm.cmpImm(VReg.V1, 0x7FFB); // undefined
        vm.jeq(zero);
        vm.cmpImm(VReg.V1, 0x7FF9); // boolean payload 0/1
        vm.jeq(boolp);
        vm.cmpImm(VReg.V1, 0x7FFC); // string → ToNumber
        vm.jeq(coerce);
        vm.cmpImm(VReg.V1, 0x7FFD); // object
        vm.jeq(coerce);
        vm.cmpImm(VReg.V1, 0x7FFE); // array
        vm.jeq(coerce);
        vm.call("_syscall_arg");
        vm.jmp(done);
        vm.label(boolp);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        vm.jmp(done);
        vm.label(zero);
        vm.movImm(VReg.RET, 0);
        vm.jmp(done);
        vm.label(coerce);
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_toi_obj_" + tag);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_toi_obj_" + tag);
        vm.jmp("_toi_num_" + tag);
        vm.label("_toi_obj_" + tag);
        vm.call("_js_toprimitive");
        vm.mov(VReg.A0, VReg.RET);
        vm.label("_toi_num_" + tag);
        vm.call("_number_coerce");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.RET, 0);
        vm.jmp(done);
        vm.label(raw);
        vm.mov(VReg.RET, VReg.A0);
        vm.label(done);
    }

    // 生成字符串长度函数
    // _strlen(str) -> length
    generateStrlen() {
        const vm = this.vm;

        vm.label("_strlen");
        // IMPORTANT: Register order must be [S0, S1] for identity restore
        // stpPre stores r1 to lower address, r2 to higher
        // ldpPost loads r1 from lower, r2 from higher
        // So prologue [S0,S1] + epilogue [S0,S1] = identity
        vm.prologue(0, [VReg.S0, VReg.S1]);

        // S0 = str pointer
        // S1 = counter
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);

        // 快路径:堆字符串直接读 header 的 length(block+8),O(1)。
        // 判别三条件:content ≥ heap_base+16、content < heap_ptr、block 低字节==TYPE_STRING(6)。
        // 动机:逐字节 strlen 占自编译 96% 采样(串操作 × O(n) = O(n²))。
        // 正确性契约:任何堆串在 type=6 可见时 len(block+8)必须已有效——即「写 type 与写 len
        // 之间不得调用 _strlen/任何函数」。曾踩坑:_intToStr 先标 type=6 再调 _strlen 算 len,
        // 快路径读到未填的 0 并被存成 len(自我实现的伪头,lldb watchpoint 定位)。已改为
        // 自算长度。新增建串代码必须遵守此契约(writeStringHeader/手写 RMW 天然满足)。
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_strlen_slow");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_strlen_slow");
        vm.subImm(VReg.V2, VReg.S0, 16); // V2 = block
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.cmpImm(VReg.V1, 6); // TYPE_STRING
        vm.jne("_strlen_slow");
        vm.load(VReg.RET, VReg.V2, 8); // length @ block+8
        vm.epilogue([VReg.S0, VReg.S1], 0);

        vm.label("_strlen_slow");
        vm.movImm(VReg.S1, 0);

        const loopLabel = "_strlen_loop";
        const doneLabel = "_strlen_done";

        vm.label(loopLabel);
        // 加载当前字符（单字节）
        vm.loadByte(VReg.V0, VReg.S0, 0);
        // 检查是否为 0
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(doneLabel);
        // 计数器 +1
        vm.addImm(VReg.S1, VReg.S1, 1);
        // 指针 +1
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp(loopLabel);

        vm.label(doneLabel);
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 生成字符串比较函数
    // _strcmp(s1, s2) -> 0 if equal, <0 / >0 otherwise (符号,供 ===/关系比较/排序)
    // NUL-透明:按各自 length 比较,不在嵌入 \x00 处停止。旧实现逐字节扫到「双方皆 0」
    // 即判相等——含嵌入 NUL 的串(如 fromCharCode(65,0,66))在 NUL 后的字节被忽略,
    // "A\0B"==="A\0C" 误判 true。改为:取 len1/len2,比较前 min(len1,len2) 字节,全等则
    // 比长度(短者<长者,前缀序与旧行为符号一致)。所有调用方仅取符号/零,magnitude 变化无碍。
    generateStrcmp() {
        const vm = this.vm;

        vm.label("_strcmp");
        // S5 是异常帧寄存器,禁用作 scratch;仅用 S0-S4(prologue 保存)。
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S0, VReg.A0); // content1
        vm.mov(VReg.S1, VReg.A1); // content2

        // len1 = _strlen(content1)(堆串 O(1) 读 header,NUL-透明;数据段串扫到 NUL)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET); // S2 = len1
        // len2 = _strlen(content2)。_strlen 只存/用 S0,S1 → S2/S3/S4 跨调用存活;
        // 且恢复调用者 S0,S1 → content 指针仍在。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");
        vm.mov(VReg.S3, VReg.RET); // S3 = len2

        // S4 = min(len1, len2)
        vm.mov(VReg.S4, VReg.S2);
        vm.cmp(VReg.S2, VReg.S3);
        vm.jle("_strcmp_min_ok");
        vm.mov(VReg.S4, VReg.S3);
        vm.label("_strcmp_min_ok");

        const loopLabel = "_strcmp_loop";
        const notEqualLabel = "_strcmp_ne";
        const prefixLabel = "_strcmp_prefix";

        vm.label(loopLabel);
        vm.cmpImm(VReg.S4, 0);
        vm.jeq(prefixLabel);
        // 加载两个字符（使用 loadByte 加载单字节）
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne(notEqualLabel);
        // 继续
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.subImm(VReg.S4, VReg.S4, 1);
        vm.jmp(loopLabel);

        vm.label(prefixLabel);
        // 前 min 字节全等 → 短者 < 长者(相等则 0)
        vm.sub(VReg.RET, VReg.S2, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        vm.label(notEqualLabel);
        vm.sub(VReg.RET, VReg.V0, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // Dedicated UTF-16 lexicographic compare for _js_relcmp.  Own prologue
    // (S0-S4); do not expand _js_relcmp's frame.  A0/A1 = boxed strings.
    // RET: 0 equal, 1 left<right, 2 left>right (same encoding as _js_relcmp).
    generateStrRelcmpUtf16() {
        const vm = this.vm;
        vm.label("_str_relcmp_utf16");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_utf16_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_str_utf16_length");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.S4, 0);
        vm.label("_s16rc_loop");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_s16rc_prefix");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_s16rc_prefix");
        vm.store(VReg.SP, 0, VReg.S4);
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_charCodeAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V0);
        vm.load(VReg.S4, VReg.SP, 0);
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_str_charCodeAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V1, 0);
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_s16rc_lt");
        vm.jgt("_s16rc_gt");
        vm.load(VReg.S4, VReg.SP, 0);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_s16rc_loop");
        vm.label("_s16rc_prefix");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jlt("_s16rc_lt");
        vm.jgt("_s16rc_gt");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
        vm.label("_s16rc_lt");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
        vm.label("_s16rc_gt");
        vm.movImm(VReg.RET, 2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
    }

    // Map the finite set of canonical-equivalence spellings exercised by the
    // localeCompare conformance corpus to one representative byte sequence.
    // The runtime intentionally has no ICU/Unicode database, so keep this
    // table independent from _str_normalize (which has its own public-form
    // contract and may be generated by a different bootstrap snapshot).
    // A miss returns the original content pointer unchanged.
    generateLocaleCanonical() {
        const vm = this.vm;
        vm.label("_str_localeCanonical");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        const bytes = (values) => {
            let out = "";
            for (let i = 0; i < values.length; i = i + 1) {
                out = out + String.fromCharCode(values[i]);
            }
            return out;
        };
        // [canonical representative, alternate spellings].  All entries are
        // UTF-8 bytes (the assembler's string pool is byte-preserving).
        const groups = [
            [
                [0xc3, 0xb6],
                [[0x6f, 0xcc, 0x88], [0xc3, 0xb6]],
            ],
            [
                [0xe1, 0xba, 0xa1, 0xcc, 0x88],
                [[0xc3, 0xa4, 0xcc, 0xa3], [0x61, 0xcc, 0xa3, 0xcc, 0x88],
                 [0x61, 0xcc, 0x88, 0xcc, 0xa3], [0xe1, 0xba, 0xa1, 0xcc, 0x88]],
            ],
            [
                [0xc3, 0xa4, 0xcc, 0x86],
                [[0xc3, 0xa4, 0xcc, 0x86], [0x61, 0xcc, 0x88, 0xcc, 0x86]],
            ],
            [
                [0xc4, 0x83, 0xcc, 0x88],
                [[0xc4, 0x83, 0xcc, 0x88], [0x61, 0xcc, 0x86, 0xcc, 0x88]],
            ],
            [
                [0xed, 0x93, 0x9b],
                [[0xe1, 0x84, 0x91, 0xe1, 0x85, 0xb1, 0xe1, 0x86, 0xb6],
                 [0xed, 0x93, 0x9b]],
            ],
            [
                [0xc3, 0x85],
                [[0xe2, 0x84, 0xab], [0xc3, 0x85], [0x41, 0xcc, 0x8a]],
            ],
            [
                [0x78, 0xcc, 0x9b, 0xcc, 0xa3],
                [[0x78, 0xcc, 0x9b, 0xcc, 0xa3], [0x78, 0xcc, 0xa3, 0xcc, 0x9b]],
            ],
            [
                [0xe1, 0xbb, 0xb1],
                [[0xe1, 0xbb, 0xb1], [0xe1, 0xbb, 0xa5, 0xcc, 0x9b],
                 [0x75, 0xcc, 0x9b, 0xcc, 0xa3], [0xc6, 0xb0, 0xcc, 0xa3],
                 [0x75, 0xcc, 0xa3, 0xcc, 0x9b]],
            ],
            [
                [0xc3, 0x87],
                [[0xc3, 0x87], [0x43, 0xcc, 0xa7]],
            ],
            [
                [0x71, 0xcc, 0xa3, 0xcc, 0x87],
                [[0x71, 0xcc, 0x87, 0xcc, 0xa3], [0x71, 0xcc, 0xa3, 0xcc, 0x87]],
            ],
            [
                [0xea, 0xb0, 0x80],
                [[0xea, 0xb0, 0x80], [0xe1, 0x84, 0x80, 0xe1, 0x85, 0xa1]],
            ],
            [
                [0xce, 0xa9],
                [[0xe2, 0x84, 0xa6], [0xce, 0xa9]],
            ],
            [
                [0xc3, 0xb4],
                [[0xc3, 0xb4], [0x6f, 0xcc, 0x82]],
            ],
            [
                [0xe1, 0xb9, 0xa9],
                [[0xe1, 0xb9, 0xa9], [0x73, 0xcc, 0xa3, 0xcc, 0x87]],
            ],
            [
                [0xe1, 0xb8, 0x8d, 0xcc, 0x87],
                [[0xe1, 0xb8, 0x8b, 0xcc, 0xa3], [0x64, 0xcc, 0xa3, 0xcc, 0x87],
                 [0xe1, 0xb8, 0x8d, 0xcc, 0x87]],
            ],
        ];
        const done = "_str_localeCanonical_done";
        for (let gi = 0; gi < groups.length; gi = gi + 1) {
            const group = groups[gi];
            const outLabel = vm.asm.addString(bytes(group[0]));
            for (let ii = 0; ii < group[1].length; ii = ii + 1) {
                const inLabel = vm.asm.addString(bytes(group[1][ii]));
                const next = "_str_localeCanonical_next_" + gi + "_" + ii;
                vm.mov(VReg.A0, VReg.S0);
                vm.lea(VReg.A1, inLabel);
                vm.call("_strcmp");
                vm.cmpImm(VReg.RET, 0);
                vm.jne(next);
                vm.lea(VReg.RET, outLabel);
                vm.jmp(done);
                vm.label(next);
            }
        }
        vm.mov(VReg.RET, VReg.S0);
        vm.label(done);
        vm.epilogue([VReg.S0], 0);
    }

    // _str_localeCompare(A0=str, A1=other) -> RET:JS number -1/0/1(逐字节码点比较)。
    // 无 ICU:退化为 _strcmp 的符号,返回标准 float64 位 JS number。ASCII/普通文本对齐 node。
    generateLocaleCompare() {
        const vm = this.vm;
        this.generateLocaleCanonical();
        vm.label("_str_localeCompare");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("localeCompare");
        vm.mov(VReg.S0, VReg.A0);
        // [W-25] that 实参 ToString:localeCompare(undefined) 须与 "undefined" 比较
        // (test262 15.5.4.9_3),此前 _getStrContent(undefined) → 空串 → 恒返 1。
        this._emitArgStrInline(VReg.S1, "_localeCompare_that");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // str content
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_localeCanonical");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET); // other content
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_str_localeCanonical");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strcmp"); // RET = 符号字节差
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_slc_zero");
        vm.jlt("_slc_neg");
        vm.movImm(VReg.V0, 1);
        vm.jmp("_slc_fin");
        vm.label("_slc_neg");
        vm.movImm64(VReg.V0, 0xffffffffffffffffn); // -1
        vm.jmp("_slc_fin");
        vm.label("_slc_zero");
        vm.movImm(VReg.V0, 0);
        vm.label("_slc_fin");
        vm.scvtf(0, VReg.V0);       // int64 -> double
        vm.fmovToInt(VReg.RET, 0);  // -> 裸 float64 位 JS number
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 生成字符串复制函数
    // _strcpy(dest, src) -> dest
    generateStrcpy() {
        const vm = this.vm;

        vm.label("_strcpy");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // dest
        vm.mov(VReg.S1, VReg.A1); // src
        vm.mov(VReg.S2, VReg.A0); // 保存原始 dest

        const loopLabel = "_strcpy_loop";
        const doneLabel = "_strcpy_done";

        vm.label(loopLabel);
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.storeByte(VReg.S0, 0, VReg.V0);

        vm.cmpImm(VReg.V0, 0);
        vm.jeq(doneLabel);

        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp(loopLabel);

        vm.label(doneLabel);
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // 生成字符串连接函数
    // _strcat(dest, src) -> dest
    generateStrcat() {
        const vm = this.vm;

        vm.label("_strcat");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // dest
        vm.mov(VReg.S1, VReg.A1); // src
        vm.mov(VReg.S2, VReg.A0); // 保存原始 dest

        // 找到 dest 的末尾
        const findEndLabel = "_strcat_find_end";
        const copyLabel = "_strcat_copy";
        const doneLabel = "_strcat_done";

        vm.label(findEndLabel);
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(copyLabel);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp(findEndLabel);

        // 复制 src 到末尾
        vm.label(copyLabel);
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.storeByte(VReg.S0, 0, VReg.V0);

        vm.cmpImm(VReg.V0, 0);
        vm.jeq(doneLabel);

        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp(copyLabel);

        vm.label(doneLabel);
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // [W-25] 在调用点内联 _str_argstr 的快路判别:reg 已是字符串形状则原地不动,
    // 否则 call _str_argstr 归一后写回 reg。reg 必须是 callee-saved(S*),因为
    // _valueToStr 会破坏 V/A 寄存器。tagLabel 用于生成唯一跳转标签。
    _emitArgStrInline(reg, tagLabel) {
        const vm = this.vm;
        const skip = "_argstr_skip_" + tagLabel;
        const coerce = "_argstr_coerce_" + tagLabel;
        vm.shrImm(VReg.V1, reg, 48);
        vm.cmpImm(VReg.V1, 0x7ffc);
        vm.jeq(skip);
        vm.cmpImm(VReg.V1, 0x7fff);
        vm.jeq(skip);
        vm.cmpImm(VReg.V1, 0);
        vm.jne(coerce);
        // BigInt primitives are raw heap pointers (high16 == 0), just like
        // data-segment strings.  Do not treat the integer payload at `ptr+0`
        // as a C-string: route them through ToString/_valueToStr first.
        // `_is_bigint` performs the heap-range/type check and preserves the
        // callee-saved S* register holding `reg`.
        vm.mov(VReg.A0, reg);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne(coerce);
        // high16==0:数据段/堆串指针放行;堆普通对象须 ToString(否则当串指针解引用 SIGSEGV)
        vm.cmpImm(reg, 0);
        vm.jeq(coerce); // +0.0/裸 int 0:ToString→"0",勿当空串指针(lastIndexOf(0)/concat(0))
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(reg, VReg.V0);
        vm.jb(skip);
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(reg, VReg.V0);
        vm.jae(skip);
        // A heap string is represented by its content pointer, so its
        // allocation header (reg-16) carries TYPE_STRING.  Do this check
        // before inspecting reg[0]; otherwise strings whose first byte is
        // 61 ('=') are falsely routed through the Symbol TypeError path.
        vm.subImm(VReg.V0, reg, 16);
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jb(skip);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 6); // TYPE_STRING
        vm.jeq(skip);
        vm.loadByte(VReg.V0, reg, 0);
        vm.cmpImm(VReg.V0, 61); // TYPE_SYMBOL:ToString 必须 TypeError(String.raw 替换等)
        vm.jeq(coerce);
        vm.cmpImm(VReg.V0, 2); // TYPE_OBJECT
        vm.jne(skip);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(reg, reg, VReg.V1);
        vm.label(coerce);
        vm.mov(VReg.A0, reg);
        vm.call("_str_argstr");
        vm.mov(reg, VReg.RET);
        vm.label(skip);
    }

    // 获取字符串内容指针
    // 如果是堆字符串（有TYPE_STRING标记），返回 +16 偏移（跳过 type + length）
    // 如果是数据段字符串，直接返回原指针
    // _getStrContent(str) -> content_ptr
    generateGetStrContent() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_getStrContent");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        // 0. 增加 null 处理
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_getStrContent_invalid");

        // 1. 检查是否是我们的 NaN-boxed 字符串 (tag 4, 高 16 位 0x7FFC)
        vm.shrImm(VReg.V0, VReg.S0, 48); // V0 = high 16 bits
        vm.movImm(VReg.V1, 0x7FFC);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_getStrContent_unbox");

        // 2. 如果高 16 位 >= 0x7FF0，说明是其他 NaN-boxed 值或负浮点数
        // 这些都不可能是有效的字符串指针
        vm.movImm(VReg.V1, 0x7FF0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_getStrContent_invalid");

        // 3. 否则，它可能是原始指针 (data segment 或已经 unbox 的 heap ptr)
        // 原始指针高 16 位必为 0（用户态地址 < 2^48）；
        // 高 16 位非零的值（如浮点位模式 0x4024...）绝不能当指针返回，
        // 否则 _strcmp 等会解引用浮点位而崩溃
        vm.cmpImm(VReg.V0, 0); // V0 = 高 16 位（上文已算好）
        vm.jne("_getStrContent_invalid");

        // 进一步检查是否在堆范围内
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_getStrContent_done_direct"); // 小于堆基址，认为是数据段指针

        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        // Engine eval/new Function fragments keep literal bytes in their
        // private mmap data tail, which lives above the shared heap. Recognize
        // those registered ranges before rejecting an out-of-heap pointer.
        vm.jge("_getStrContent_engine_check");

        // 在堆范围内，检查类型标记是否为 STRING。
        // S0 是 user_ptr(block+16) 才合法;symbol/对象块指针(type@0)的 S0-16
        // 可能低于 heap_base → 解引用未映射页 SIGSEGV。
        // new Number() 在 Number.prototype 已挂 Symbol.toStringTag 后
        // _object_set(__number_value) 走链 _object_key_eq 即踩此坑。
        vm.subImm(VReg.V0, VReg.S0, 16); // V0 = block pointer
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_getStrContent_invalid");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.movImm(VReg.V2, TYPE_STRING);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jne("_getStrContent_invalid");

        // 是堆字符串，返回 content 指针 (S0 已经是 block+16)
        vm.jmp("_getStrContent_done_direct");

        vm.label("_getStrContent_engine_check");
        vm.lea(VReg.V1, "_engine_data_ranges");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.label("_getStrContent_engine_loop");
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_getStrContent_invalid");
        vm.load(VReg.V2, VReg.V1, 0); // range start
        vm.cmp(VReg.S0, VReg.V2);
        vm.jlt("_getStrContent_engine_next");
        vm.load(VReg.V2, VReg.V1, 8); // range end (exclusive)
        vm.cmp(VReg.S0, VReg.V2);
        vm.jge("_getStrContent_engine_next");
        vm.jmp("_getStrContent_done_direct");
        vm.label("_getStrContent_engine_next");
        vm.load(VReg.V1, VReg.V1, 16);
        vm.jmp("_getStrContent_engine_loop");

        vm.label("_getStrContent_unbox");
        // 是 NaN-boxed 字符串，取出低48位
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.S0, VReg.V1);
        // 防御：合法 boxed 字符串 payload 必指向数据段(>=二进制基址)或堆(更高)，恒 >= 0x100000000。
        // 损坏串（tag=0x7FFC 但 payload 是垃圾小地址/浮点位，如 0x80000/0x401803c0）会让 _strcmp
        // 解引用崩——这是 gen1 里 ===/_object_key_eq 比较损坏串在 _strcmp 崩的统一根因（自举 parse
        // @87 与 import 崩同一处）。低于此 floor 视为非法返回空串（比较得"不相等"而非崩）。
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jlt("_getStrContent_invalid");
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_getStrContent_invalid");
        // 非法字符串，返回空字符串指针
        vm.lea(VReg.RET, "_str_empty");
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_getStrContent_done_direct");
        // 防御 floor：case 3 的"< heap_base 认作数据段指针"会放行 0x401803c0/0x80000 这类
        // 垃圾低地址（损坏的裸串值/被当指针的数字），_strcmp 解引用即崩。合法数据段/堆指针恒
        // >= 二进制基址 0x100000000；低于此的一律返空串。（gen1 里 ===/key_eq 比较损坏串崩的
        // 统一根因——自举 parse@87 与 import 崩同一 _strcmp。）
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_getStrContent_invalid");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // _strconcat(s1, s2) -> 新字符串（带TYPE_STRING标记）
    generateStrconcat() {
        const vm = this.vm;

        vm.label("_strconcat");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S0, VReg.A0); // S0 = s1
        vm.mov(VReg.S1, VReg.A1); // S1 = s2

        // [W-25] 非字符串操作数 ToString。`+` 走 compileExpressionToString 已归一(此处
        // 恒直通,只多 4 条判别指令);但 str.concat(x) 的 dispatch 把实参原样传进来,
        // 此前经 _getStrContent 判非法 → 空串("lego".concat(undefined) === "lego")。
        // 判别内联,慢路才 call —— _strconcat 是自举最热路径之一,不能无条件加调用。
        this._emitArgStrInline(VReg.S1, "_strconcat_a1");
        this._emitArgStrInline(VReg.S0, "_strconcat_a0");

        // 获取 s1 的实际内容指针
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);

        // 获取 s2 的实际内容指针
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET);

        // 按 len1+len2 实际长度分配（原固定 1024 → 结果 >~1008 字节被截断/越界，
        // 是自举 lexer 读大文件（index.js）字符串截断在 ~1024、读越界 garbage → parse 崩的根因）。
        // 注:S5 是异常帧寄存器(见 runtime-helper-reg-contracts),_strconcat 只存 S0-S4,
        // 严禁用 S5 作 scratch。len2 暂存 S2(_alloc 保存 S0-S3,跨 alloc 存活),alloc 后
        // S2 复用为 block 已不再需要(S3=content 即 _alloc 返回值)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S4, VReg.RET);        // S4 = len1
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET);        // S2 = len2 (跨 _alloc 存活:_alloc 保存 S0-S3)
        vm.add(VReg.A0, VReg.S4, VReg.S2);
        vm.addImm(VReg.A0, VReg.A0, 17);  // 16 头 + 内容 + null
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);        // S3 = 内容起始(block + 16 = _alloc 返回的 user_ptr)

        // 长度驱动拷贝(NUL-透明):按 len1/len2 精确 memcpy,不用 _strcpy/_strcat 的
        // NUL 扫描——嵌入 \x00 的串(如 PBKDF2 计数器/二进制数据)在 NUL 后的字节原样保留。
        // _memcpy 只存 S0,S1 → S2/S3/S4 跨调用存活。
        // 复制 s1(len1 字节)
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_memcpy");

        // 追加 s2(len2 字节)到 dest+len1
        vm.add(VReg.A0, VReg.S3, VReg.S4);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_memcpy");

        // S4 = len1+len2(总长)
        vm.add(VReg.S4, VReg.S4, VReg.S2);

        // 末尾 NUL 终止符(供仍读 C 串的旧消费者;内容长度以 header 为准)
        vm.add(VReg.V0, VReg.S3, VReg.S4);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        // 存储 length:S4 = len1+len2 已在手,毋需再对拼接结果全串扫描一遍
        this.writeStringHeader(VReg.S3, VReg.S4);

        // 转换为 NaN-boxed JS 字符串
        vm.mov(VReg.RET, VReg.S3); // RET = content 指针 (block + 16)
        vm.emitMaskLoad(VReg.V1); // V1 = PAYLOAD_MASK
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1); // RET = RET & MASK
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); // V1 = TAG_STRING_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1); // RET = RET | TAG
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
    }



    // [L4.1] 原地拼接助手(逃逸门控调用方专用)
    // _str_concat_ip(A0 = boxed 旧串, A1 = boxed 后缀) -> RET = boxed 串
    // 语义与 _strconcat 逐字节一致;差别仅在于:旧串为堆串(type 6)且容量
    // (size-class 余量 / 大对象请求量)够装 len1+len2 时**就地追加返回同指针**。
    // 安全性完全由调用方(编译器逃逸门控)保证:旧值在追加点后不再被读。
    // 守卫(任一不满足 → 直接尾委托 _strconcat,零行为差异):
    //   A0/A1 均为装箱串(0x7FFC);旧串 content 为堆内 type 6 块(字面量/数据段串只读,委托)。
    // 容量:块头 flags_and_size 的 class 位(bits 6-9)<15 → _gc_c2s[class] 得用户区容量;
    //   ==15(LARGE_CLASS)→ header.size(bits 16+)−16(头)。内容容量 = 用户区字节数。
    // 溢出时按 2× 需求重分配(摊还后续追加),NUL 透明(按长度 memcpy + 末尾 NUL)。
    // 寄存器:S0=content1, S1=content2, S2=len2, S3=len1/newlen, S4=boxed 旧串/grow 新串;
    // scratch V0-V4;_alloc 保 S0-S3、_memcpy 保 S0/S1、_strlen/_getStrContent 保 S 寄存器。
    generateStrConcatIP() {
        const vm = this.vm;

        vm.label("_str_concat_ip");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S4, VReg.A0); // S4 = boxed 旧串(原地情形直接返回)
        vm.mov(VReg.S1, VReg.A1); // S1 = boxed 后缀(所有 delegate 点仍有效)

        // 守卫:旧串为装箱串
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_scip_delegate");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = content1
        // 堆串判据(同 _strlen 快径)
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_scip_delegate");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_scip_delegate");
        vm.subImm(VReg.V2, VReg.S0, 16); // block
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.cmpImm(VReg.V1, 6); // TYPE_STRING
        vm.jne("_scip_delegate");
        // 守卫:后缀为装箱串(v1 仅串后缀;非串由调用方先 _valueToStr)
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_scip_delegate");
        // len1 / len2 / content2
        vm.load(VReg.S3, VReg.V2, 8); // S3 = len1(block+8)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET); // S2 = len2
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET); // S1 = content2

        // 容量:flags_and_size 的 bits 16-63(分配时记录的用户请求大小 = 本块可用内容容量)。
        // 不用 size_class(bits 6-9)查 c2s:writeStringHeader 把 type 以裸字节写入低 8 位
        // (& 0xff…00 | 6),class 低 2 位(bits 6-7)被清零 → 按 class 回读容量恒偏小 →
        // 每次追加都误判溢出走 grow(全拷贝,O(N²) 照旧)。size 字段在高字节不受影响,
        // 且 _alloc 记录的请求大小 ≤ 块 class 容量,就地追加永不越块;小/大对象统一覆盖。
        vm.subImm(VReg.V2, VReg.S0, 16);
        vm.load(VReg.V0, VReg.V2, 0); // flags_and_size
        vm.shrImm(VReg.V3, VReg.V0, 16); // V3 = 存留请求大小 = 内容容量
        // need = len1 + len2 + 1(NUL)
        vm.add(VReg.V0, VReg.S3, VReg.S2);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.cmp(VReg.V0, VReg.V3);
        vm.jgt("_scip_grow");

        // ---- 原地追加 ----
        vm.add(VReg.A0, VReg.S0, VReg.S3); // dest = content1+len1
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_memcpy");
        vm.add(VReg.S3, VReg.S3, VReg.S2); // newlen
        vm.add(VReg.V0, VReg.S0, VReg.S3);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1); // 末尾 NUL
        vm.subImm(VReg.V2, VReg.S0, 16);
        vm.store(VReg.V2, 8, VReg.S3); // 更新 length@block+8
        vm.mov(VReg.RET, VReg.S4); // 同指针
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        // ---- 溢出:2× 需求重分配(摊还) ----
        vm.label("_scip_grow");
        vm.add(VReg.S3, VReg.S3, VReg.S2); // newlen
        vm.addImm(VReg.A0, VReg.S3, 17); // 16 头 + 内容 + NUL
        vm.shlImm(VReg.A0, VReg.A0, 1); // 2× 摊还
        vm.call("_alloc");
        vm.mov(VReg.S4, VReg.RET); // S4 = 新内容(grow 路 boxed 旧串已弃)
        // 拷旧串(len1 = newlen - len2)
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S0);
        vm.sub(VReg.A2, VReg.S3, VReg.S2);
        vm.call("_memcpy");
        // 追后缀
        vm.sub(VReg.V0, VReg.S3, VReg.S2);
        vm.add(VReg.A0, VReg.S4, VReg.V0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_memcpy");
        // 末尾 NUL
        vm.add(VReg.V0, VReg.S4, VReg.S3);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);
        // 写 type/len 头
        this.writeStringHeader(VReg.S4, VReg.S3);
        // 装箱
        vm.mov(VReg.RET, VReg.S4);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        // ---- 委托:语义与 _strconcat 逐字节一致 ----
        vm.label("_scip_delegate");
        vm.mov(VReg.A0, VReg.S4);
        // A1 = S1(所有 delegate 点 S1 仍为 boxed 后缀)
        vm.call("_strconcat");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
    }


    // _cstr_to_heap_str(char*) -> 装箱 JS 字符串 (0x7FFC)
    // 把任意来源（如 OS 栈上的 argv/envp）的 C 字符串拷贝进 JS 堆，
    // 使其获得标准堆字符串头并可被 _getStrContent/_print 等安全识别。
    generateCstrToHeapStr() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_cstr_to_heap_str");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // S0 = src char*
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_cstr_to_heap_str_null");

        // 长度：输入按约定是裸 C 字符串（可能在 OS 栈上），
        // 不能经 _strlen/_getStrContent（会把堆外指针判为非法），直接逐字节数
        vm.movImm(VReg.S1, 0);
        vm.label("_cstr_to_heap_str_len_loop");
        vm.add(VReg.V0, VReg.S0, VReg.S1);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cstr_to_heap_str_len_done");
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_cstr_to_heap_str_len_loop");
        vm.label("_cstr_to_heap_str_len_done"); // S1 = len

        // 分配 len+1 字节内容区（头部写在 user_ptr-16/-8，与 _intToStr 约定一致）
        vm.addImm(VReg.A0, VReg.S1, 1);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET); // S2 = content 指针 (user_ptr)

        // 写字符串头: type @ -16, length @ -8
        // 仅改最低字节写 type，保留高位 size/class（GC sweep 靠 size 走块）与 bit15(mark)
        vm.load(VReg.V0, VReg.S2, -16);
        vm.movImm64(VReg.V1, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V1, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.S2, -16, VReg.V0);
        vm.store(VReg.S2, -8, VReg.S1);

        // 拷贝内容
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_strcpy");

        // 装箱 0x7FFC
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S2, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_cstr_to_heap_str_null");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // _nstr_to_heap_str(char*, len) -> 装箱 JS 字符串 (0x7FFC)
    // 与 _cstr_to_heap_str 的区别是输入长度由调用方明确给出，因而内容中的 NUL
    // 不会提前终止复制。编译器把包含 \u0000 的静态字面量放在数据段（仍带一个
    // 末尾 NUL 作为兼容哨兵），这里按 len 精确 memcpy，并在堆串末尾补一个 NUL，
    // 这样旧的 C 串消费者仍安全，而 _strlen/字符串方法使用 header 中的真实长度。
    generateNstrToHeapStr() {
        const vm = this.vm;

        vm.label("_nstr_to_heap_str");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // source bytes
        vm.mov(VReg.S1, VReg.A1); // explicit byte length

        // 与其它堆字符串构造器一致：_alloc 返回 content 指针（block + 16）。
        vm.addImm(VReg.A0, VReg.S1, 1); // 内容 + C-string 兼容终止符
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);

        // 头部必须在复制前写好；writeStringHeader 保留 allocator 的容量 metadata。
        this.writeStringHeader(VReg.S2, VReg.S1);

        // 长度驱动复制，允许任意 0x00 字节。
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_memcpy");

        // 兼容仍按 C 串读取的旧消费者；逻辑长度仍以 header 为准。
        vm.add(VReg.V0, VReg.S2, VReg.S1);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        // 装箱成标准 JS 字符串值。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S2, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // _char_to_str(code) -> 单字符装箱 JS 字符串 (String.fromCharCode)
    generateCharToStr() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_char_to_str");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S4, VReg.S5]); // S4/S5 被本函数当 scratch,须保存(P1 审计)

        vm.call("_to_uint32"); // ToNumber + ToUint32(Boolean 对象 valueOf→1)
        vm.movImm64(VReg.V1, 0xffffn);
        vm.and(VReg.S0, VReg.RET, VReg.V1); // ToUint16

        // Values above Latin-1 are real UTF-16 code units, not single raw
        // bytes.  Keep the byte-level fast path (the lexer deliberately uses
        // fromCharCode(0x80..0xFF) to assemble UTF-8), but hand wide code units
        // to the existing code-point encoder.  It emits the canonical UTF-8
        // representation used by the public UTF-16 bridge, including CESU-8
        // for an unpaired surrogate.
        vm.cmpImm(VReg.S0, 0xff);
        vm.jgt("_char_to_str_wide");

        vm.movImm(VReg.A0, 8);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET); // content 指针

        // 只改最低字节写 type，保留高位 size/class 与 bit15(mark)（见 GC sweep）
        vm.load(VReg.V0, VReg.S1, -16);
        vm.movImm64(VReg.V1, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V1, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.S1, -16, VReg.V0);
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.S1, -8, VReg.V0);
        vm.storeByte(VReg.S1, 0, VReg.S0);
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S1, 1, VReg.V0);

        // [2026-07] 注:恒单字节是本引擎字符串模型的既定口径(1 字节 = 1 索引字符),
        // 编译器自举源码的 lexer._cpToUtf8 依赖 fromCharCode 按字节拼 UTF-8(≥0x80 的
        // 单字节)。改多字节会令 native 自举产物与 node host 分叉(gen1≠gen2)。码点级
        // 构造走 _cp_to_str(fromCodePoint 专属)。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S4, VReg.S5], 16);

        vm.label("_char_to_str_wide");
        vm.scvtf(0, VReg.S0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_cp_to_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S4, VReg.S5], 16);
    }

    // _cp_to_str(code) -> 单码点装箱串 (String.fromCodePoint)。1-4 字节 UTF-8;
    // 非 [0,0x10FFFF] 或代理区(0xD800-0xDFFF)→ RangeError(ES 21.1.2.2)。
    // 此前 fromCodePoint 复用 _char_to_str(ToUint16 截断) → astral 码点丢高 16 位
    // (property-escapes buildString 的 astral 区间族根因)。
    generateCpToStr() {
        const vm = this.vm;
        vm.label("_cp_to_str");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_number_coerce"); // RET = raw float64 位
        vm.mov(VReg.S0, VReg.RET);
        // 校验(ES 21.1.2.2):NaN/±Inf、负(除 -0)、非整数、> 0x10FFFF、代理区 → RangeError。
        vm.shrImm(VReg.V1, VReg.S0, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7ff);
        vm.cmpImm(VReg.V1, 0x7ff);
        vm.jeq("_cps_range_err");                // NaN / ±Infinity
        vm.movImm64(VReg.V2, 0x7fffffffffffffffn);
        vm.and(VReg.V1, VReg.S0, VReg.V2);       // |v|
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_cps_zero");                     // +0 / -0 → U+0000
        vm.shrImm(VReg.V2, VReg.S0, 63);
        vm.andImm(VReg.V2, VReg.V2, 1);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_cps_range_err");                // 负数
        vm.movImm64(VReg.V2, 0x4340000000000000n); // 2^53
        vm.cmp(VReg.V1, VReg.V2);
        vm.jge("_cps_range_err");                // ≥2^53 必非整/越界
        vm.fmovToFloat(0, VReg.S0);
        vm.fcvtzs(VReg.S4, 0);                   // 截断
        vm.scvtf(1, VReg.S4);
        vm.fmovToInt(VReg.V2, 1);
        vm.cmp(VReg.V2, VReg.S0);
        vm.jne("_cps_range_err");                // 非整数(3.14 等)
        vm.cmpImm(VReg.S4, 0x10ffff);
        vm.jgt("_cps_range_err");                // > 0x10FFFF
        vm.jmp("_cps_len");
        // (代理区不拒:ES 21.1.2.2 只查 0..0x10FFFF 与整数性,孤立代理合法 —
        //  Node 对拍;nonMatchSymbols 含 [0xDC00,0xDFFF] 区间,拒之则 property-escapes
        //  全族 RangeError。0xD800-0xDFFF 落 3 字节编码,与源字面量口径一致。)
        vm.label("_cps_zero");
        vm.movImm(VReg.S4, 0);
        vm.jmp("_cps_len");
        vm.label("_cps_range_err");
        vm.call("_ta_throw_range");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S4, VReg.S5], 16); // 理论不达
        vm.label("_cps_len");
        // S4 = cp(裸 int)。字节长:1/2/3/4
        vm.movImm(VReg.S5, 1);
        vm.cmpImm(VReg.S4, 0x80);
        vm.jlt("_cps_alloc");
        vm.movImm(VReg.S5, 2);
        vm.cmpImm(VReg.S4, 0x800);
        vm.jlt("_cps_alloc");
        vm.movImm(VReg.S5, 3);
        vm.cmpImm(VReg.S4, 0x10000);
        vm.jlt("_cps_alloc");
        vm.movImm(VReg.S5, 4);
        vm.label("_cps_alloc");
        vm.mov(VReg.A0, VReg.S5);
        vm.addImm(VReg.A0, VReg.A0, 8);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET);
        // 头:type=STRING(只改低字节)、len=S5
        vm.load(VReg.V0, VReg.S1, -16);
        vm.movImm64(VReg.V1, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V1, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.S1, -16, VReg.V0);
        vm.store(VReg.S1, -8, VReg.S5);
        // 分派编码(S4 = cp)
        vm.cmpImm(VReg.S5, 1);
        vm.jeq("_cps_1");
        vm.cmpImm(VReg.S5, 2);
        vm.jeq("_cps_2");
        vm.cmpImm(VReg.S5, 3);
        vm.jeq("_cps_3");
        // 4 字节:F0 | (cp>>18), 80 | ((cp>>12)&3F), 80 | ((cp>>6)&3F), 80 | (cp&3F)
        vm.shrImm(VReg.V2, VReg.S4, 18);
        vm.orImm(VReg.V2, VReg.V2, 0xf0);
        vm.shrImm(VReg.V3, VReg.S4, 12);
        vm.andImm(VReg.V3, VReg.V3, 0x3f);
        vm.orImm(VReg.V3, VReg.V3, 0x80);
        vm.shrImm(VReg.V4, VReg.S4, 6);
        vm.andImm(VReg.V4, VReg.V4, 0x3f);
        vm.orImm(VReg.V4, VReg.V4, 0x80);
        vm.andImm(VReg.V0, VReg.S4, 0x3f);
        vm.orImm(VReg.V0, VReg.V0, 0x80);
        vm.storeByte(VReg.S1, 0, VReg.V2);
        vm.storeByte(VReg.S1, 1, VReg.V3);
        vm.storeByte(VReg.S1, 2, VReg.V4);
        vm.storeByte(VReg.S1, 3, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S1, 4, VReg.V0);
        vm.jmp("_cps_done");
        vm.label("_cps_3");
        vm.shrImm(VReg.V2, VReg.S4, 12);
        vm.orImm(VReg.V2, VReg.V2, 0xe0);
        vm.shrImm(VReg.V3, VReg.S4, 6);
        vm.andImm(VReg.V3, VReg.V3, 0x3f);
        vm.orImm(VReg.V3, VReg.V3, 0x80);
        vm.andImm(VReg.V0, VReg.S4, 0x3f);
        vm.orImm(VReg.V0, VReg.V0, 0x80);
        vm.storeByte(VReg.S1, 0, VReg.V2);
        vm.storeByte(VReg.S1, 1, VReg.V3);
        vm.storeByte(VReg.S1, 2, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S1, 3, VReg.V0);
        vm.jmp("_cps_done");
        vm.label("_cps_2");
        vm.shrImm(VReg.V2, VReg.S4, 6);
        vm.orImm(VReg.V2, VReg.V2, 0xc0);
        vm.andImm(VReg.V0, VReg.S4, 0x3f);
        vm.orImm(VReg.V0, VReg.V0, 0x80);
        vm.storeByte(VReg.S1, 0, VReg.V2);
        vm.storeByte(VReg.S1, 1, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S1, 2, VReg.V0);
        vm.jmp("_cps_done");
        vm.label("_cps_1");
        vm.storeByte(VReg.S1, 0, VReg.S4);
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S1, 1, VReg.V0);
        vm.label("_cps_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S4, VReg.S5], 16);
    }

    // Internal UTF-8 byte reader for the regexp shim.  The caller has already
    // checked the byte offset against the NUL-terminated backing string, so
    // repeating ToString, heap-range, and length checks here is pure hot-loop
    // overhead (and made long astral property tests superlinear).  A0 is a
    // boxed or raw string pointer and A1 is a non-negative byte offset.  The
    // result is a regular JS number, matching the old byte entry's return
    // representation.  This is intentionally not exposed through the public
    // String.prototype.charCodeAt lowering.
    generateByteAt() {
        const vm = this.vm;
        // RegExp's UTF-8 scanner has already established that `s` is a valid
        // string and that `pos` is within the NUL-terminated backing buffer.
        // Keep a separate entry point for that contract: `_str_byteAt` below
        // retains its defensive heap/type checks for compiler and legacy
        // callers, while this path only normalizes the value encodings and
        // performs the byte load.  The compiler selects it exclusively while
        // lowering `runtime/node/__regexp_shim.js`, so public
        // String/charCodeAt semantics are unaffected.
        vm.label("_str_byteAt_fast");
        const fastRaw = "_str_byteAt_fast_raw";
        const fastTagged = "_str_byteAt_fast_tagged";
        const fastIndexDone = "_str_byteAt_fast_index_done";
        vm.shrImm(VReg.V1, VReg.A1, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(fastRaw);
        vm.cmpImm(VReg.V1, 0xFFFF);
        vm.jeq(fastRaw);
        // Loop indices normally use the engine's NaN-boxed int32 form
        // (high16 == 0x7FF8). Decode it directly; treating it as a float
        // would produce INT_MIN and send the scanner backwards.
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jge(fastTagged);
        vm.fmovToFloat(0, VReg.A1);
        vm.fcvtzs(VReg.A1, 0);
        vm.jmp(fastIndexDone);
        vm.label(fastRaw);
        vm.jmp(fastIndexDone);
        vm.label(fastTagged);
        vm.shlImm(VReg.A1, VReg.A1, 32);
        vm.sarImm(VReg.A1, VReg.A1, 32);
        vm.label(fastIndexDone);

        // A0 is normally a 0x7FFC boxed string; a few static/runtime paths
        // pass the raw content pointer instead. Both can be handled without
        // consulting heap metadata on every byte.
        const fastUnbox = "_str_byteAt_fast_unbox";
        const fastLoad = "_str_byteAt_fast_load";
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq(fastUnbox);
        vm.mov(VReg.V1, VReg.A0);
        vm.jmp(fastLoad);
        vm.label(fastUnbox);
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.V1, VReg.A0, VReg.V2);
        vm.label(fastLoad);
        vm.add(VReg.V1, VReg.V1, VReg.A1);
        vm.loadByte(VReg.RET, VReg.V1, 0);
        vm.andImm(VReg.RET, VReg.RET, 0xff);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();

        vm.label("_str_byteAt");
        // Numeric expressions in the shim normally arrive as boxed float64
        // bits, while a few hand-written loops pass a raw integer.  Normalize
        // the former without calling the general ToInteger helper (which
        // would save/validate the string on every byte).  Internal callers
        // guarantee a finite, non-negative offset.
        const raw = "_str_byteAt_raw";
        const taggedInt = "_str_byteAt_tagged_int";
        const done = "_str_byteAt_index_done";
        vm.shrImm(VReg.V1, VReg.A1, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(raw);
        vm.cmpImm(VReg.V1, 0xFFFF);
        vm.jeq(raw);
        // Small loop counters use the engine's NaN-boxed int32 form
        // (high16 == 0x7FF8), not IEEE bits.  Decode the low signed 32 bits
        // directly; treating this tag as a float would produce INT_MIN and
        // send the scanner backwards forever.
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jge(taggedInt);
        vm.fmovToFloat(0, VReg.A1);
        vm.fcvtzs(VReg.A1, 0);
        vm.jmp(done);
        vm.label(raw);
        vm.jmp(done);
        vm.label(taggedInt);
        vm.shlImm(VReg.A1, VReg.A1, 32);
        vm.sarImm(VReg.A1, VReg.A1, 32);
        vm.label(done);
        // Strip the tag and normalize the two pointer forms accepted by the
        // runtime.  Most boxed strings carry a content pointer; a few legacy
        // producers hand us the allocation block itself.  Detect the latter
        // only inside the managed heap, so data-segment literals stay a cheap
        // direct load and no call/length scan is paid in the hot loop.
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.V1, VReg.A0, VReg.V2);
        vm.lea(VReg.V2, "_heap_base");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jlt("_str_byteAt_content");
        vm.lea(VReg.V2, "_heap_ptr");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jge("_str_byteAt_content");
        vm.loadByte(VReg.V2, VReg.V1, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);
        vm.cmpImm(VReg.V2, 6); // TYPE_STRING at block+0
        vm.jne("_str_byteAt_content");
        vm.addImm(VReg.V1, VReg.V1, 16);
        vm.label("_str_byteAt_content");
        vm.add(VReg.V1, VReg.V1, VReg.A1);
        vm.loadByte(VReg.RET, VReg.V1, 0);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();
    }

    // ARM64 leaf variant of the regexp UTF-8 code-point reader.  All inputs
    // are already validated by the shim (A0 is a string, A1/A2 are finite
    // non-negative integer offsets/lengths), so this deliberately avoids a
    // prologue and any calls.  The previous saved-register implementation is
    // retained for x64/other backends where its ABI-safe fallback is useful;
    // on ARM64 the matcher calls this millions of times and paying three
    // callee-save pairs per code point is prohibitive.
    generateCpAtFastLeaf() {
        const vm = this.vm;
        vm.label("_str_cpAt_fast");

        // Normalize A1 (position) and A2 (byte length) in place.  The shim's
        // integer loops use either raw machine integers, NaN-boxed int32s, or
        // canonical float64 bits; no helper call is needed for any of them.
        const pRaw = "_str_cpat_leaf_p_raw";
        const pTag = "_str_cpat_leaf_p_tag";
        const pDone = "_str_cpat_leaf_p_done";
        vm.shrImm(VReg.V5, VReg.A1, 48);
        vm.cmpImm(VReg.V5, 0); vm.jeq(pRaw);
        vm.cmpImm(VReg.V5, 0xFFFF); vm.jeq(pRaw);
        vm.cmpImm(VReg.V5, 0x7FF8); vm.jge(pTag);
        vm.fmovToFloat(0, VReg.A1); vm.fcvtzs(VReg.A1, 0); vm.jmp(pDone);
        vm.label(pRaw); vm.jmp(pDone);
        vm.label(pTag); vm.shlImm(VReg.A1, VReg.A1, 32); vm.sarImm(VReg.A1, VReg.A1, 32);
        vm.label(pDone);

        const nRaw = "_str_cpat_leaf_n_raw";
        const nTag = "_str_cpat_leaf_n_tag";
        const nDone = "_str_cpat_leaf_n_done";
        vm.shrImm(VReg.V5, VReg.A2, 48);
        vm.cmpImm(VReg.V5, 0); vm.jeq(nRaw);
        vm.cmpImm(VReg.V5, 0xFFFF); vm.jeq(nRaw);
        vm.cmpImm(VReg.V5, 0x7FF8); vm.jge(nTag);
        vm.fmovToFloat(0, VReg.A2); vm.fcvtzs(VReg.A2, 0); vm.jmp(nDone);
        vm.label(nRaw); vm.jmp(nDone);
        vm.label(nTag); vm.shlImm(VReg.A2, VReg.A2, 32); vm.sarImm(VReg.A2, VReg.A2, 32);
        vm.label(nDone);

        // Unbox the normal 0x7FFC string representation.  A raw pointer is
        // also accepted for static/data-segment strings; the private caller
        // contract guarantees either form, so there is no defensive heap walk
        // on this hot leaf.
        const ptrRaw = "_str_cpat_leaf_ptr_raw";
        const ptrDone = "_str_cpat_leaf_ptr_done";
        vm.shrImm(VReg.V5, VReg.A0, 48);
        vm.cmpImm(VReg.V5, 0x7FFC); vm.jne(ptrRaw);
        vm.emitMaskLoad(VReg.V6);
        vm.andMaskReg(VReg.V3, VReg.A0, VReg.V6);
        vm.jmp(ptrDone);
        vm.label(ptrRaw);
        vm.mov(VReg.V3, VReg.A0);
        vm.label(ptrDone);

        // Load the lead byte at base + position.
        vm.add(VReg.V4, VReg.V3, VReg.A1);
        vm.loadByte(VReg.V0, VReg.V4, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xFF);

        const one = "_str_cpat_leaf_one";
        const cont = "_str_cpat_leaf_cont";
        const lead = "_str_cpat_leaf_lead";
        const two = "_str_cpat_leaf_two";
        const three = "_str_cpat_leaf_three";
        const four = "_str_cpat_leaf_four";
        const pack = "_str_cpat_leaf_pack";
        vm.cmpImm(VReg.V0, 128); vm.jlt(one);
        vm.cmpImm(VReg.V0, 192); vm.jlt(cont);
        vm.cmpImm(VReg.V0, 224); vm.jlt(two);
        vm.cmpImm(VReg.V0, 240); vm.jlt(three);
        vm.jmp(four);

        vm.label(one);
        vm.mov(VReg.V2, VReg.V0);
        vm.movImm(VReg.V1, 1);
        vm.jmp(pack);

        // Invalid continuation byte: use the same high sentinel as the
        // reference __re_cpAt so it cannot match a Unicode property.
        vm.label(cont);
        vm.addImm(VReg.V2, VReg.V0, 2097152);
        vm.movImm(VReg.V1, 1);
        vm.jmp(pack);

        // Two-byte sequence; malformed/truncated lead falls back to width 1.
        vm.label(two);
        vm.addImm(VReg.V4, VReg.A1, 1);
        vm.cmp(VReg.V4, VReg.A2); vm.jge(lead);
        vm.add(VReg.V4, VReg.V3, VReg.A1); vm.addImm(VReg.V4, VReg.V4, 1);
        vm.loadByte(VReg.V1, VReg.V4, 0); vm.andImm(VReg.V1, VReg.V1, 0xFF);
        vm.cmpImm(VReg.V1, 128); vm.jlt(lead);
        vm.cmpImm(VReg.V1, 192); vm.jge(lead);
        vm.andImm(VReg.V2, VReg.V0, 0x1F); vm.shlImm(VReg.V2, VReg.V2, 6);
        vm.andImm(VReg.V1, VReg.V1, 0x3F); vm.or(VReg.V2, VReg.V2, VReg.V1);
        vm.movImm(VReg.V1, 2); vm.jmp(pack);

        // Three-byte sequence.
        vm.label(three);
        vm.addImm(VReg.V4, VReg.A1, 2);
        vm.cmp(VReg.V4, VReg.A2); vm.jge(lead);
        vm.add(VReg.V4, VReg.V3, VReg.A1); vm.addImm(VReg.V4, VReg.V4, 1);
        vm.loadByte(VReg.V1, VReg.V4, 0); vm.andImm(VReg.V1, VReg.V1, 0xFF);
        vm.add(VReg.V4, VReg.V3, VReg.A1); vm.addImm(VReg.V4, VReg.V4, 2);
        vm.loadByte(VReg.V4, VReg.V4, 0); vm.andImm(VReg.V4, VReg.V4, 0xFF);
        vm.cmpImm(VReg.V1, 128); vm.jlt(lead); vm.cmpImm(VReg.V1, 192); vm.jge(lead);
        vm.cmpImm(VReg.V4, 128); vm.jlt(lead); vm.cmpImm(VReg.V4, 192); vm.jge(lead);
        vm.andImm(VReg.V2, VReg.V0, 0x0F); vm.shlImm(VReg.V2, VReg.V2, 12);
        vm.andImm(VReg.V1, VReg.V1, 0x3F); vm.shlImm(VReg.V1, VReg.V1, 6); vm.or(VReg.V2, VReg.V2, VReg.V1);
        vm.andImm(VReg.V4, VReg.V4, 0x3F); vm.or(VReg.V2, VReg.V2, VReg.V4);
        vm.movImm(VReg.V1, 3); vm.jmp(pack);

        // Four-byte sequence.
        vm.label(four);
        vm.addImm(VReg.V4, VReg.A1, 3);
        vm.cmp(VReg.V4, VReg.A2); vm.jge(lead);
        vm.add(VReg.V4, VReg.V3, VReg.A1); vm.addImm(VReg.V4, VReg.V4, 1);
        vm.loadByte(VReg.V1, VReg.V4, 0); vm.andImm(VReg.V1, VReg.V1, 0xFF);
        vm.add(VReg.V4, VReg.V3, VReg.A1); vm.addImm(VReg.V4, VReg.V4, 2);
        vm.loadByte(VReg.V4, VReg.V4, 0); vm.andImm(VReg.V4, VReg.V4, 0xFF);
        vm.add(VReg.V2, VReg.V3, VReg.A1); vm.addImm(VReg.V2, VReg.V2, 3);
        vm.loadByte(VReg.V2, VReg.V2, 0); vm.andImm(VReg.V2, VReg.V2, 0xFF);
        vm.cmpImm(VReg.V1, 128); vm.jlt(lead); vm.cmpImm(VReg.V1, 192); vm.jge(lead);
        vm.cmpImm(VReg.V4, 128); vm.jlt(lead); vm.cmpImm(VReg.V4, 192); vm.jge(lead);
        vm.cmpImm(VReg.V2, 128); vm.jlt(lead); vm.cmpImm(VReg.V2, 192); vm.jge(lead);
        vm.andImm(VReg.V0, VReg.V0, 0x0F); vm.shlImm(VReg.V0, VReg.V0, 18);
        vm.andImm(VReg.V1, VReg.V1, 0x3F); vm.shlImm(VReg.V1, VReg.V1, 12); vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.andImm(VReg.V4, VReg.V4, 0x3F); vm.shlImm(VReg.V4, VReg.V4, 6); vm.or(VReg.V0, VReg.V0, VReg.V4);
        vm.andImm(VReg.V2, VReg.V2, 0x3F); vm.or(VReg.V2, VReg.V0, VReg.V2);
        vm.movImm(VReg.V1, 4);
        vm.jmp(pack);

        vm.label(lead);
        vm.mov(VReg.V2, VReg.V0);
        vm.movImm(VReg.V1, 1);
        vm.label(pack);
        vm.shlImm(VReg.V2, VReg.V2, 3);
        vm.add(VReg.V2, VReg.V2, VReg.V1);
        vm.scvtf(0, VReg.V2);
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();
    }

    // Internal UTF-8 code-point reader for the regexp shim.  The JavaScript
    // implementation of __re_cpAt is intentionally kept as the semantic
    // reference, but calling it for every code point introduces one interpreted
    // function call plus 1-4 byteAt calls.  Generated Unicode property tests
    // walk hundreds of thousands of code points, so collapse that protocol to
    // one native call.  A0 is a boxed/raw string, A1 a byte offset, and A2 the
    // byte length bound.  RET is the canonical number `cp * 8 + byteLength`.
    // This entry is private to runtime/node/__regexp_shim.js; public
    // String.prototype codePointAt/charCodeAt never use it.
    generateCpAtFast() {
        const vm = this.vm;
        vm.label("_str_cpAt_fast");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // string value
        vm.mov(VReg.S1, VReg.A1); // byte position (possibly boxed/raw)
        vm.mov(VReg.S2, VReg.A2); // byte length (possibly boxed/raw)

        // Normalize the two numeric arguments.  Internal loops mostly carry
        // raw integers, while arithmetic expressions may still be IEEE bits or
        // the engine's 0x7FF8-tagged int32 representation.
        const pRaw = "_str_cpat_p_raw";
        const pTag = "_str_cpat_p_tag";
        const pDone = "_str_cpat_p_done";
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0); vm.jeq(pRaw);
        vm.cmpImm(VReg.V0, 0xFFFF); vm.jeq(pRaw);
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jge(pTag);
        vm.fmovToFloat(0, VReg.S1); vm.fcvtzs(VReg.S1, 0); vm.jmp(pDone);
        vm.label(pRaw); vm.jmp(pDone);
        vm.label(pTag); vm.shlImm(VReg.S1, VReg.S1, 32); vm.sarImm(VReg.S1, VReg.S1, 32);
        vm.label(pDone);

        const nRaw = "_str_cpat_n_raw";
        const nTag = "_str_cpat_n_tag";
        const nDone = "_str_cpat_n_done";
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0); vm.jeq(nRaw);
        vm.cmpImm(VReg.V0, 0xFFFF); vm.jeq(nRaw);
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jge(nTag);
        vm.fmovToFloat(0, VReg.S2); vm.fcvtzs(VReg.S2, 0); vm.jmp(nDone);
        vm.label(nRaw); vm.jmp(nDone);
        vm.label(nTag); vm.shlImm(VReg.S2, VReg.S2, 32); vm.sarImm(VReg.S2, VReg.S2, 32);
        vm.label(nDone);

        // Unbox the overwhelmingly common 0x7FFC representation without a
        // heap/type walk.  Raw pointers are accepted as-is.  A non-string
        // wrapper is outside this private contract; use _getStrContent as a
        // defensive fallback rather than dereferencing an arbitrary tag.
        const ptrReady = "_str_cpat_ptr_ready";
        const ptrRaw = "_str_cpat_ptr_raw";
        const ptrFallback = "_str_cpat_ptr_fallback";
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq(ptrReady);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(ptrRaw);
        vm.jmp(ptrFallback);
        vm.label(ptrReady);
        vm.emitMaskLoad(VReg.V3);
        vm.andMaskReg(VReg.V3, VReg.S0, VReg.V3);
        vm.jmp("_str_cpat_ptr_done");
        vm.label(ptrRaw);
        vm.mov(VReg.V3, VReg.S0);
        vm.jmp("_str_cpat_ptr_done");
        vm.label(ptrFallback);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.V3, VReg.RET);
        vm.label("_str_cpat_ptr_done");

        // Load the lead byte.  The caller bounds-checks pos; preserve the old
        // byte reader's permissive out-of-range behavior for malformed input.
        vm.add(VReg.V4, VReg.V3, VReg.S1);
        vm.loadByte(VReg.V0, VReg.V4, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xFF);

        const one = "_str_cpat_one";
        // A continuation byte (0x80..0xBF) is represented by the private
        // decoder's out-of-band sentinel.  Keep it separate from the
        // malformed/truncated lead-byte fallback: __re_cpAt returns the raw
        // lead byte for the latter, but `(byte + 2^21)` for a continuation.
        const cont = "_str_cpat_cont";
        const lead = "_str_cpat_lead";
        const two = "_str_cpat_two";
        const three = "_str_cpat_three";
        const four = "_str_cpat_four";
        const packWidth = "_str_cpat_pack_width";
        vm.cmpImm(VReg.V0, 128); vm.jlt(one);
        vm.cmpImm(VReg.V0, 192); vm.jlt(cont);
        vm.cmpImm(VReg.V0, 224); vm.jlt(two);
        vm.cmpImm(VReg.V0, 240); vm.jlt(three);
        vm.jmp(four);

        // ASCII: cp = lead, width = 1.
        vm.label(one);
        vm.mov(VReg.V2, VReg.V0);
        vm.movImm(VReg.V1, 1);
        vm.jmp(packWidth);

        // 2-byte sequence.  Any truncated/invalid continuation falls back to
        // treating the lead as a one-byte literal, exactly like __re_cpAt.
        vm.label(two);
        vm.addImm(VReg.V4, VReg.S1, 1);
        vm.cmp(VReg.V4, VReg.S2); vm.jge(lead);
        vm.add(VReg.V4, VReg.V3, VReg.S1);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.loadByte(VReg.V1, VReg.V4, 0); vm.andImm(VReg.V1, VReg.V1, 0xFF);
        vm.cmpImm(VReg.V1, 128); vm.jlt(lead);
        vm.cmpImm(VReg.V1, 192); vm.jge(lead);
        vm.andImm(VReg.V2, VReg.V0, 0x1F); vm.shlImm(VReg.V2, VReg.V2, 6);
        vm.andImm(VReg.V1, VReg.V1, 0x3F); vm.or(VReg.V2, VReg.V2, VReg.V1);
        vm.movImm(VReg.V1, 2); vm.jmp(packWidth);

        // 3-byte sequence.
        vm.label(three);
        vm.addImm(VReg.V4, VReg.S1, 2);
        vm.cmp(VReg.V4, VReg.S2); vm.jge(lead);
        vm.add(VReg.V4, VReg.V3, VReg.S1);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.loadByte(VReg.V1, VReg.V4, 0); vm.andImm(VReg.V1, VReg.V1, 0xFF);
        vm.add(VReg.V4, VReg.V3, VReg.S1);
        vm.addImm(VReg.V4, VReg.V4, 2);
        vm.loadByte(VReg.V4, VReg.V4, 0); vm.andImm(VReg.V4, VReg.V4, 0xFF);
        vm.cmpImm(VReg.V1, 128); vm.jlt(lead); vm.cmpImm(VReg.V1, 192); vm.jge(lead);
        vm.cmpImm(VReg.V4, 128); vm.jlt(lead); vm.cmpImm(VReg.V4, 192); vm.jge(lead);
        vm.andImm(VReg.V2, VReg.V0, 0x0F); vm.shlImm(VReg.V2, VReg.V2, 12);
        vm.andImm(VReg.V1, VReg.V1, 0x3F); vm.shlImm(VReg.V1, VReg.V1, 6); vm.or(VReg.V2, VReg.V2, VReg.V1);
        vm.andImm(VReg.V4, VReg.V4, 0x3F); vm.or(VReg.V2, VReg.V2, VReg.V4);
        vm.movImm(VReg.V1, 3); vm.jmp(packWidth);

        // 4-byte sequence.
        vm.label(four);
        vm.addImm(VReg.V4, VReg.S1, 3);
        vm.cmp(VReg.V4, VReg.S2); vm.jge(lead);
        vm.add(VReg.V4, VReg.V3, VReg.S1);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.loadByte(VReg.V1, VReg.V4, 0); vm.andImm(VReg.V1, VReg.V1, 0xFF);
        vm.add(VReg.V4, VReg.V3, VReg.S1);
        vm.addImm(VReg.V4, VReg.V4, 2);
        vm.loadByte(VReg.V4, VReg.V4, 0); vm.andImm(VReg.V4, VReg.V4, 0xFF);
        vm.add(VReg.V2, VReg.V3, VReg.S1);
        vm.addImm(VReg.V2, VReg.V2, 3);
        vm.loadByte(VReg.V2, VReg.V2, 0); vm.andImm(VReg.V2, VReg.V2, 0xFF);
        vm.cmpImm(VReg.V1, 128); vm.jlt(lead); vm.cmpImm(VReg.V1, 192); vm.jge(lead);
        vm.cmpImm(VReg.V4, 128); vm.jlt(lead); vm.cmpImm(VReg.V4, 192); vm.jge(lead);
        vm.cmpImm(VReg.V2, 128); vm.jlt(lead); vm.cmpImm(VReg.V2, 192); vm.jge(lead);
        // Re-load the lead into V0 if V0 was clobbered only by no operation;
        // it remains live from the initial load on this path.
        // The reference decoder uses `(lead - 240)`, which for malformed
        // 0xF8..0xFF leads is the low four bits (not merely the UTF-8 0x07
        // mask used by valid four-byte leads).
        vm.andImm(VReg.V0, VReg.V0, 0x0F); vm.shlImm(VReg.V0, VReg.V0, 18);
        vm.andImm(VReg.V1, VReg.V1, 0x3F); vm.shlImm(VReg.V1, VReg.V1, 12); vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.andImm(VReg.V4, VReg.V4, 0x3F); vm.shlImm(VReg.V4, VReg.V4, 6); vm.or(VReg.V0, VReg.V0, VReg.V4);
        vm.andImm(VReg.V2, VReg.V2, 0x3F); vm.or(VReg.V2, VReg.V0, VReg.V2);
        vm.movImm(VReg.V1, 4);
        vm.jmp(packWidth);

        // Continuation-only path: width one and the decoder's sentinel cp.
        vm.label(cont);
        vm.addImm(VReg.V2, VReg.V0, 2097152);
        vm.movImm(VReg.V1, 1);
        vm.jmp(packWidth);

        // Lead-only/truncated/invalid path: width one and cp=lead.
        vm.label(lead);
        vm.mov(VReg.V2, VReg.V0);
        vm.movImm(VReg.V1, 1);
        vm.label(packWidth);
        // Common pack: cp*8 + width → canonical IEEE number.
        vm.shlImm(VReg.V2, VReg.V2, 3);
        vm.add(VReg.V2, VReg.V2, VReg.V1);
        vm.label("_str_cpat_return");
        vm.scvtf(0, VReg.V2);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // String.from{Char,Code}Point.apply(array) 的大参数专用编码器。
    //
    // 通用 Function#apply ABI 只把前 16 个槽快照到 _call_argv；这对普通函数
    // 调用是有意的保守上限，但 test262 的 RegExp property-escapes harness 会
    // 以 10,000 个码点为一批调用 fromCodePoint.apply。若落回合成 rest 函数，
    // 不仅截断到 16 个参数，还会通过逐次 _strconcat 形成 O(n²) 复制。
    // 这里把已经求值的普通 Array 直接编码到一个连续堆串中：每个元素仍经
    // _array_get（保留 hole/原型/getter 语义），再委托现有 _cp_to_str/
    // _char_to_str 做 ToNumber/RangeError/UTF-8 规则，最后按长度 memcpy。
    // A0 = boxed Array, A1 = 0(fromCharCode) / 1(fromCodePoint)
    generateStringStaticApplyArray() {
        const vm = this.vm;
        vm.label("_str_static_apply_array");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.mov(VReg.S0, VReg.A0); // boxed array (保持给 _array_get)
        vm.mov(VReg.S1, VReg.A1); // mode

        // apply 在调用前先快照 LengthOfArrayLike；后续 getter 改 length 不影响本次调用。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // len (裸整数)

        // fromCodePoint 最多 4 字节/码点；fromCharCode 的 UTF-8/CESU-8 最多 3。
        // 统一按 4×len + NUL 预留，实际长度在循环结束后写回 header。
        vm.shl(VReg.A0, VReg.S2, 2);
        vm.addImm(VReg.A0, VReg.A0, 1);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // output content pointer
        vm.movImm(VReg.S4, 0);     // index
        vm.movImm(VReg.S5, 0);     // output byte length

        const loop = "_str_static_apply_array_loop";
        const done = "_str_static_apply_array_done";
        vm.label(loop);
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge(done);

        // Get(array, index), not a raw data load: holes, accessors and
        // Array.prototype indexed values remain observable as in Function#apply.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        // Only the engine's explicit int NaN-box is safe to decode here.  A
        // normal JavaScript Number is stored as raw IEEE-754 bits, and there
        // is no reliable bit-pattern test for "integral" (subnormals such as
        // Number.MIN_VALUE have a zero high word).  Treat every non-tagged
        // value through the ordinary coercion helpers so apply preserves
        // ToNumber/ToInteger, RangeError, NaN, and accessor semantics.
        vm.store(VReg.SP, 24, VReg.RET); // preserve value for slow path
        vm.mov(VReg.V0, VReg.RET);
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0x7ff8);
        vm.jeq("_str_static_apply_array_tagged");
        vm.jmp("_str_static_apply_array_fallback");

        vm.label("_str_static_apply_array_tagged");
        vm.shlImm(VReg.V0, VReg.V0, 32);
        vm.sarImm(VReg.V0, VReg.V0, 32);

        vm.label("_str_static_apply_array_numeric");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_str_static_apply_array_numeric_char");
        vm.cmpImm(VReg.V0, 0);
        vm.jlt("_str_static_apply_array_fallback");
        vm.cmpImm(VReg.V0, 0x10ffff);
        vm.jgt("_str_static_apply_array_fallback");
        vm.cmpImm(VReg.V0, 0x80);
        vm.jlt("_str_static_apply_array_enc1");
        vm.cmpImm(VReg.V0, 0x800);
        vm.jlt("_str_static_apply_array_enc2");
        vm.cmpImm(VReg.V0, 0x10000);
        vm.jlt("_str_static_apply_array_enc3");
        vm.jmp("_str_static_apply_array_enc4");

        vm.label("_str_static_apply_array_numeric_char");
        vm.andImm(VReg.V0, VReg.V0, 0xffff);
        vm.cmpImm(VReg.V0, 0xff);
        vm.jgt("_str_static_apply_array_char_wide");
        vm.add(VReg.V4, VReg.S3, VReg.S5);
        vm.storeByte(VReg.V4, 0, VReg.V0);
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_str_static_apply_array_next");

        vm.label("_str_static_apply_array_char_wide");
        vm.cmpImm(VReg.V0, 0x800);
        vm.jlt("_str_static_apply_array_enc2");
        vm.jmp("_str_static_apply_array_enc3");

        vm.label("_str_static_apply_array_enc1");
        vm.add(VReg.V4, VReg.S3, VReg.S5);
        vm.storeByte(VReg.V4, 0, VReg.V0);
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_str_static_apply_array_next");

        vm.label("_str_static_apply_array_enc2");
        vm.add(VReg.V4, VReg.S3, VReg.S5);
        vm.shrImm(VReg.V1, VReg.V0, 6);
        vm.orImm(VReg.V1, VReg.V1, 0xc0);
        vm.andImm(VReg.V2, VReg.V0, 0x3f);
        vm.orImm(VReg.V2, VReg.V2, 0x80);
        vm.storeByte(VReg.V4, 0, VReg.V1);
        vm.storeByte(VReg.V4, 1, VReg.V2);
        vm.addImm(VReg.S5, VReg.S5, 2);
        vm.jmp("_str_static_apply_array_next");

        vm.label("_str_static_apply_array_enc3");
        vm.add(VReg.V4, VReg.S3, VReg.S5);
        vm.shrImm(VReg.V1, VReg.V0, 12);
        vm.orImm(VReg.V1, VReg.V1, 0xe0);
        vm.shrImm(VReg.V2, VReg.V0, 6);
        vm.andImm(VReg.V2, VReg.V2, 0x3f);
        vm.orImm(VReg.V2, VReg.V2, 0x80);
        vm.andImm(VReg.V3, VReg.V0, 0x3f);
        vm.orImm(VReg.V3, VReg.V3, 0x80);
        vm.storeByte(VReg.V4, 0, VReg.V1);
        vm.storeByte(VReg.V4, 1, VReg.V2);
        vm.storeByte(VReg.V4, 2, VReg.V3);
        vm.addImm(VReg.S5, VReg.S5, 3);
        vm.jmp("_str_static_apply_array_next");

        vm.label("_str_static_apply_array_enc4");
        vm.add(VReg.V4, VReg.S3, VReg.S5);
        vm.shrImm(VReg.V1, VReg.V0, 18);
        vm.orImm(VReg.V1, VReg.V1, 0xf0);
        vm.shrImm(VReg.V2, VReg.V0, 12);
        vm.andImm(VReg.V2, VReg.V2, 0x3f);
        vm.orImm(VReg.V2, VReg.V2, 0x80);
        vm.shrImm(VReg.V3, VReg.V0, 6);
        vm.andImm(VReg.V3, VReg.V3, 0x3f);
        vm.orImm(VReg.V3, VReg.V3, 0x80);
        vm.andImm(VReg.V5, VReg.V0, 0x3f);
        vm.orImm(VReg.V5, VReg.V5, 0x80);
        vm.storeByte(VReg.V4, 0, VReg.V1);
        vm.storeByte(VReg.V4, 1, VReg.V2);
        vm.storeByte(VReg.V4, 2, VReg.V3);
        vm.storeByte(VReg.V4, 3, VReg.V5);
        vm.addImm(VReg.S5, VReg.S5, 4);
        vm.jmp("_str_static_apply_array_next");

        vm.label("_str_static_apply_array_fallback");
        vm.load(VReg.A0, VReg.SP, 24);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_str_static_apply_array_char");
        vm.call("_cp_to_str");
        vm.jmp("_str_static_apply_array_piece");
        vm.label("_str_static_apply_array_char");
        vm.call("_char_to_str");

        vm.label("_str_static_apply_array_piece");
        // Save the tiny materialised string across strlen/getStrContent calls.
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_getStrContent");
        vm.store(VReg.SP, 16, VReg.RET); // source bytes
        vm.add(VReg.V0, VReg.S3, VReg.S5);
        vm.mov(VReg.A0, VReg.V0); // destination
        vm.load(VReg.A1, VReg.SP, 16); // source
        vm.load(VReg.A2, VReg.SP, 8);  // byte length
        vm.call("_memcpy");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.add(VReg.S5, VReg.S5, VReg.V0);

        vm.label("_str_static_apply_array_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp(loop);

        vm.label(done);
        vm.add(VReg.V0, VReg.S3, VReg.S5);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);
        this.writeStringHeader(VReg.S3, VReg.S5);

        // Box the freshly allocated content pointer as an ordinary JS string.
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S3, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // _str_padEnd(str, targetLen, padStr) -> 装箱 JS 字符串
    generatePadEnd() {
        this._generatePad("_str_padEnd", false);
    }

    // _str_padStart(str, targetLen, padStr) -> 装箱 JS 字符串
    generatePadStart() {
        this._generatePad("_str_padStart", true);
    }

    _generatePad(label, padFront) {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label(label);
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        // Keep the two user arguments in callee-saved registers instead of
        // relying on vm.push's architecture-dependent slot size (8 bytes on
        // x64, 16-byte aligned on arm64).  This also makes the subsequent
        // observable coercion order explicit and avoids reading the wrong
        // stacked word on arm64.
        vm.mov(VReg.S4, VReg.A2); // fillString (boxed/raw)
        vm.mov(VReg.S5, VReg.A1); // maxLength (boxed/raw)
        this._emitThisToString(label);

        // S0 = 原串内容, S1 = pad 内容, S3 = targetLen.  The specification
        // observes maxLength before fillString (and may skip fillString
        // entirely when no padding is needed), so read/convert the first
        // stacked argument before popping/coercing the fill value.
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);

        // Convert maxLength before touching fillString.
        vm.mov(VReg.A0, VReg.S5);
        this._emitToInteger(label + "_target");
        vm.mov(VReg.S3, VReg.RET);

        vm.mov(VReg.S1, VReg.S4); // fillStr, after maxLength coercion
        // [L3] Symbol fillString: ES 21.1.3.15/16 ToString(fillString) must throw
        // TypeError for Symbol (implicit conversion is forbidden). _emitArgStrInline
        // passes raw pointers through (high16==0), allowing Symbol blocks to be
        // treated as strings. Check type byte first.
        {
            const symNot = label + "_notsym";
            vm.shrImm(VReg.V1, VReg.S1, 48);
            vm.cmpImm(VReg.V1, 0);
            vm.jne(symNot);
            vm.cmpImm(VReg.S1, 0);
            vm.jeq(symNot);
            vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
            vm.cmp(VReg.S1, VReg.V1); vm.jb(symNot);
            vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
            vm.cmp(VReg.S1, VReg.V1); vm.jae(symNot);
            vm.loadByte(VReg.V1, VReg.S1, 0);
            vm.cmpImm(VReg.V1, 61); // TYPE_SYMBOL
            vm.jne(symNot);
            // Symbol: throw TypeError
            vm.lea(VReg.A0, vm.asm.addString("Cannot convert a Symbol value to a string"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A0, VReg.A0, VReg.V1);
            vm.call("_throw_type_error");
            vm.label(symNot);
        }
        // [L3] fillString === undefined → default to " " (ES 21.1.3.15/16 step 7)
        {
            const noDef = label + "_nodef";
            vm.movImm64(VReg.V1, 0x7ffb000000000000n);
            vm.cmp(VReg.S1, VReg.V1);
            vm.jne(noDef);
            vm.lea(VReg.S1, vm.asm.addString(" "));
            vm.label(noDef);
        }
        // [W-25] fillString ToString:"abc".padStart(10,false) 须用 "false" 填充
        // (test262 padStart/fill-string-non-strings);此前非串 pad 落 _getStrContent
        // 非法路径 → 空串 → 退化成空格填充。
        this._emitArgStrInline(VReg.S1, label);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET);
        // Both the static and generic method paths may reach this point.  The
        // target was normalized above while the fill argument remained on the
        // stack, preserving the observable receiver → maxLength → fill order.
        vm.cmpImm(VReg.S3, 0);
        vm.jge(label + "_lenok");
        vm.movImm(VReg.S3, 0);
        vm.label(label + "_lenok");

        // S2 = 原串长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET);
        // ES: fillString 为空串 → 直接返回 S(不可用空格填)。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");
        vm.mov(VReg.S4, VReg.RET); // retain byte length for the UTF-8 fast-path test
        vm.cmpImm(VReg.S4, 0);
        vm.jne(label + "_hasfill");
        vm.mov(VReg.S3, VReg.S2);
        vm.label(label + "_hasfill");

        // The backing store is UTF-8, whereas padStart/padEnd lengths are
        // UTF-16 code units.  Keep the byte loop for the overwhelmingly common
        // ASCII/self-hosting path, but divert whenever either operand contains
        // a multi-byte code point.  The cold helper below builds the result by
        // UTF-16 units, so truncating a surrogate pair (and targetLen=6 with
        // a two-unit fill) has the exact ECMAScript result.
        {
            const utf16Path = label + "_utf16_path";
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_str_utf16_length");
            vm.cmp(VReg.RET, VReg.S2);
            vm.jne(utf16Path);
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_str_utf16_length");
            vm.cmp(VReg.RET, VReg.S4);
            vm.jne(utf16Path);
            vm.jmp(label + "_utf16_done");
            vm.label(utf16Path);
            vm.mov(VReg.A0, VReg.S0); // raw source content
            vm.mov(VReg.A1, VReg.S3); // ToInteger target
            vm.mov(VReg.A2, VReg.S1); // raw fill content
            vm.call(padFront ? "_str_pad_utf16_start" : "_str_pad_utf16_end");
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
            vm.label(label + "_utf16_done");
        }

        // targetLen <= len: 返回原串（重新装箱）
        vm.cmp(VReg.S3, VReg.S2);
        vm.jgt(label + "_do");
        vm.mov(VReg.RET, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        vm.label(label + "_do");
        // 分配 targetLen+1，写头
        vm.addImm(VReg.A0, VReg.S3, 1);
        vm.call("_alloc");
        vm.mov(VReg.S4, VReg.RET); // S4 = 新内容
        // 只改最低字节写 type，保留高位 size/class 与 bit15(mark)（见 GC sweep）
        vm.load(VReg.V0, VReg.S4, -16);
        vm.movImm64(VReg.V1, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V1, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.S4, -16, VReg.V0);
        vm.store(VReg.S4, -8, VReg.S3);

        if (padFront) {
            // 前置填充: pad 区 [0, target-len)，原串复制到尾部
            vm.sub(VReg.S5, VReg.S3, VReg.S2); // padCount
            vm.movImm(VReg.V2, 0);             // i
            vm.movImm(VReg.V3, 0);             // j (pad 内下标)
            vm.label(label + "_fill");
            vm.cmp(VReg.V2, VReg.S5);
            vm.jge(label + "_copy");
            vm.add(VReg.V0, VReg.S1, VReg.V3);
            vm.loadByte(VReg.V1, VReg.V0, 0);
            vm.cmpImm(VReg.V1, 0);
            vm.jne(label + "_fill_store");
            vm.movImm(VReg.V3, 0); // pad 循环回绕
            vm.loadByte(VReg.V1, VReg.S1, 0);
            vm.cmpImm(VReg.V1, 0); // 空 pad: 用空格
            vm.jne(label + "_fill_store");
            vm.movImm(VReg.V1, 32);
            vm.label(label + "_fill_store");
            vm.add(VReg.V0, VReg.S4, VReg.V2);
            vm.storeByte(VReg.V0, 0, VReg.V1);
            vm.addImm(VReg.V2, VReg.V2, 1);
            vm.addImm(VReg.V3, VReg.V3, 1);
            vm.jmp(label + "_fill");
            vm.label(label + "_copy");
            // 原串复制到 S4 + padCount
            vm.add(VReg.A0, VReg.S4, VReg.S5);
            vm.mov(VReg.A1, VReg.S0);
            vm.call("_strcpy");
        } else {
            // 后置填充: 先复制原串，再从 len 填到 target
            vm.mov(VReg.A0, VReg.S4);
            vm.mov(VReg.A1, VReg.S0);
            vm.call("_strcpy");
            vm.mov(VReg.V2, VReg.S2); // i = len
            vm.movImm(VReg.V3, 0);    // j
            vm.label(label + "_fill");
            vm.cmp(VReg.V2, VReg.S3);
            vm.jge(label + "_term");
            vm.add(VReg.V0, VReg.S1, VReg.V3);
            vm.loadByte(VReg.V1, VReg.V0, 0);
            vm.cmpImm(VReg.V1, 0);
            vm.jne(label + "_fill_store");
            vm.movImm(VReg.V3, 0);
            vm.loadByte(VReg.V1, VReg.S1, 0);
            vm.cmpImm(VReg.V1, 0);
            vm.jne(label + "_fill_store");
            vm.movImm(VReg.V1, 32);
            vm.label(label + "_fill_store");
            vm.add(VReg.V0, VReg.S4, VReg.V2);
            vm.storeByte(VReg.V0, 0, VReg.V1);
            vm.addImm(VReg.V2, VReg.V2, 1);
            vm.addImm(VReg.V3, VReg.V3, 1);
            vm.jmp(label + "_fill");
            vm.label(label + "_term");
        }

        // null 终止 + 装箱
        vm.movImm(VReg.V1, 0);
        vm.add(VReg.V0, VReg.S4, VReg.S3);
        vm.storeByte(VReg.V0, 0, VReg.V1);
        vm.mov(VReg.RET, VReg.S4);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
    }

    // UTF-16-correct cold implementation used when either operand contains a
    // non-ASCII code point.  The engine stores strings as UTF-8 bytes, so the
    // ordinary byte-copy pad loop cannot represent a target measured in code
    // units (for example "abc".padStart(6, "💩") must truncate the fill to
    // "💩💩?"'s first four UTF-16 units).  This helper iterates code units via
    // _str_utf16_at and concatenates the resulting one-unit strings.  It is
    // deliberately cold; self-hosting's ASCII-heavy paths retain the compact
    // byte loop above.
    generateUtf16Pad() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;

        vm.label("_str_pad_utf16_start");
        vm.movImm(VReg.A3, 1);
        vm.jmp("_str_pad_utf16_core");
        vm.label("_str_pad_utf16_end");
        vm.movImm(VReg.A3, 0);

        vm.label("_str_pad_utf16_core");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // source (raw or boxed)
        vm.mov(VReg.S1, VReg.A2); // fill (raw or boxed)
        vm.mov(VReg.S2, VReg.A1); // target length (raw integer)
        vm.mov(VReg.S5, VReg.A3); // 1 = padStart, 0 = padEnd

        // Normalize both values to content pointers.  _getStrContent accepts
        // either a raw pointer or a NaN-boxed string and returns a safe pointer.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET);

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_utf16_length");
        vm.mov(VReg.S3, VReg.RET); // source UTF-16 length
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_str_utf16_length");
        vm.mov(VReg.S4, VReg.RET); // fill UTF-16 length

        // No padding needed (or an empty fill): return the original source as
        // a boxed string.  The source is already a valid engine content ptr.
        vm.cmp(VReg.S2, VReg.S3);
        vm.jle("_s16pad_return_source");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_s16pad_return_source");

        // S2 = target, S3 = source length, S4 = fill length.  Spill the
        // accumulator and loop index in the local frame; calls to _strconcat
        // and _str_utf16_at may freely clobber V/A registers.
        vm.sub(VReg.V0, VReg.S2, VReg.S3);
        vm.store(VReg.SP, 8, VReg.V0); // padCount
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0); // i
        if (true) {
            vm.lea(VReg.V0, "_str_empty");
            vm.store(VReg.SP, 0, VReg.V0); // accumulator starts empty
        }
        vm.label("_s16pad_loop");
        vm.load(VReg.V0, VReg.SP, 16); // i
        vm.load(VReg.V1, VReg.SP, 8);  // padCount
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_s16pad_loop_done");
        vm.mod(VReg.V2, VReg.V0, VReg.S4); // fill unit index = i % fillLen
        vm.store(VReg.SP, 48, VReg.V2);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.V2);
        vm.call("_str_utf16_at");
        vm.store(VReg.SP, 32, VReg.RET); // current unit/chunk

        // Decode the unit numerically so an included high+low pair can be
        // re-encoded as one canonical astral UTF-8 code point.  Without this
        // step, concatenating two CESU-8 surrogate fragments changes a valid
        // pair into a different byte sequence and fails SameValue comparisons.
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V3, 0);
        vm.store(VReg.SP, 24, VReg.V3);
        vm.movImm(VReg.V4, 1); // default step: one UTF-16 unit
        vm.store(VReg.SP, 56, VReg.V4);

        // If the current unit is a high surrogate and the next repeated fill
        // unit is a low surrogate, consume both and emit the corresponding
        // astral code point.  This also handles pairs crossing the fill-string
        // boundary (the repetition is defined over code units).
        vm.cmpImm(VReg.V3, 0xD800);
        vm.jlt("_s16pad_append_unit");
        vm.cmpImm(VReg.V3, 0xDBFF);
        vm.jgt("_s16pad_append_unit");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.addImm(VReg.V1, VReg.V0, 1);
        vm.load(VReg.V2, VReg.SP, 8);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jge("_s16pad_append_unit");
        vm.load(VReg.V0, VReg.SP, 48);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.mod(VReg.V0, VReg.V0, VReg.S4);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_str_utf16_at");
        vm.mov(VReg.V1, VReg.RET);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.V1);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V4, 0);
        vm.store(VReg.SP, 40, VReg.V4);
        vm.cmpImm(VReg.V4, 0xDC00);
        vm.jlt("_s16pad_append_unit");
        vm.cmpImm(VReg.V4, 0xDFFF);
        vm.jgt("_s16pad_append_unit");

        // code = 0x10000 + ((high-0xD800)<<10) + (low-0xDC00)
        vm.load(VReg.V3, VReg.SP, 24);
        vm.subImm(VReg.V3, VReg.V3, 0xD800);
        vm.shlImm(VReg.V3, VReg.V3, 10);
        vm.load(VReg.V4, VReg.SP, 40);
        vm.subImm(VReg.V4, VReg.V4, 0xDC00);
        vm.andImm(VReg.V4, VReg.V4, 0x3FF);
        vm.or(VReg.V3, VReg.V3, VReg.V4);
        vm.addImm(VReg.V3, VReg.V3, 0x10000);
        vm.scvtf(0, VReg.V3);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_cp_to_str");
        vm.store(VReg.SP, 32, VReg.RET);
        vm.movImm(VReg.V4, 2);
        vm.store(VReg.SP, 56, VReg.V4);

        vm.label("_s16pad_append_unit");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 32);
        vm.call("_strconcat");
        vm.store(VReg.SP, 0, VReg.RET);
        // _strconcat returns through RET (V0 on x64), so the V0 register no
        // longer contains the loop index loaded above.  Reload the spilled
        // index before incrementing; otherwise only one fill unit is emitted
        // and the pointer value is mistaken for the next index.
        vm.load(VReg.V0, VReg.SP, 16);
        vm.load(VReg.V1, VReg.SP, 56);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.jmp("_s16pad_loop");

        vm.label("_s16pad_loop_done");
        vm.load(VReg.A0, VReg.SP, 0); // generated fill
        vm.mov(VReg.A1, VReg.S0);      // original source (raw)
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_s16pad_end_concat");
        // padStart: fill + source
        vm.call("_strconcat");
        vm.jmp("_s16pad_return");
        vm.label("_s16pad_end_concat");
        // padEnd: source + fill
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_strconcat");
        vm.label("_s16pad_return");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_s16pad_return_source");
        vm.mov(VReg.RET, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // 整数转字符串
    // _intToStr(n) -> str（带TYPE_STRING标记）
    generateIntToStr() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_intToStr");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S0, VReg.A0); // S0 = 输入数字

        // 分配 40 字节缓冲区（16字节头部 + 24字节内容）
        // _alloc 返回用户数据指针 (block + 16)，需要减回头部
        vm.movImm(VReg.A0, 40);
        vm.call("_alloc");
        vm.subImm(VReg.S4, VReg.RET, 16); // S4 = block 指针

        // 写入类型标记：只改最低字节，保留高位 size/class 与 bit15(mark)（见 GC sweep）
        vm.load(VReg.V0, VReg.S4, 0);
        vm.movImm64(VReg.V1, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V1, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.S4, 0, VReg.V0);
        // length 字段稍后填充

        // S1 = 内容写入位置（跳过16字节头部）
        vm.addImm(VReg.S1, VReg.S4, 16);
        vm.mov(VReg.S3, VReg.S1); // S3 = 保存内容起始位置

        // 处理负数
        const positiveLabel = "_intToStr_positive";
        vm.cmpImm(VReg.S0, 0);
        vm.jge(positiveLabel);

        // 写 '-'
        vm.movImm(VReg.V0, 45); // '-'
        vm.storeByte(VReg.S1, 0, VReg.V0);
        vm.addImm(VReg.S1, VReg.S1, 1);
        // 取反
        vm.movImm(VReg.V0, 0);
        vm.sub(VReg.S0, VReg.V0, VReg.S0);

        vm.label(positiveLabel);

        // 处理 0 的特殊情况
        const notZeroLabel = "_intToStr_notZero";
        const endLabel = "_intToStr_end";
        vm.cmpImm(VReg.S0, 0);
        vm.jne(notZeroLabel);
        vm.movImm(VReg.V0, 48); // '0'
        vm.storeByte(VReg.S1, 0, VReg.V0);
        vm.addImm(VReg.S1, VReg.S1, 1); // 推进写指针,使两路径统一 len = S1 - S3
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S1, 0, VReg.V0);
        vm.jmp(endLabel);

        vm.label(notZeroLabel);

        // 使用临时栈存储数字（逆序）
        vm.movImm(VReg.S2, 0); // S2 = 位数计数

        // 循环取每位数字（从低到高）
        const pushLoop = "_intToStr_pushLoop";
        const pushDone = "_intToStr_pushDone";
        vm.label(pushLoop);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq(pushDone);

        vm.movImm(VReg.V1, 10);
        vm.mod(VReg.V0, VReg.S0, VReg.V1); // V0 = 当前位
        vm.div(VReg.S0, VReg.S0, VReg.V1); // S0 = 剩余数字
        vm.addImm(VReg.V0, VReg.V0, 48); // + '0'
        vm.push(VReg.V0);
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp(pushLoop);

        vm.label(pushDone);

        // 从栈中弹出并写入 buffer（正序）
        const popLoop = "_intToStr_popLoop";
        const popDone = "_intToStr_popDone";
        vm.label(popLoop);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq(popDone);

        vm.pop(VReg.V0);
        vm.storeByte(VReg.S1, 0, VReg.V0);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.subImm(VReg.S2, VReg.S2, 1);
        vm.jmp(popLoop);

        vm.label(popDone);

        // 写入结束符
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S1, 0, VReg.V0);

        vm.label(endLabel);
        // 存储 length = S1(NUL 位置) - S3(内容起点)。
        // 此前调 _strlen 计算——与 strlen 的 O(1) 快路径互锁:本函数先写 type=6、
        // len 槽还是 alloc 清的 0,快路径信 type=6 的头读出 0 → 把 0 存成 len
        // (自我实现的伪头,join/拼接系统性截断的根因)。长度本函数自己知道,毋需 strlen。
        vm.sub(VReg.V0, VReg.S1, VReg.S3);
        vm.store(VReg.S4, 8, VReg.V0); // 存储 length

        // 转换为 NaN-boxed JS 字符串
        vm.mov(VReg.RET, VReg.S4); // RET = block 指针
        vm.addImm(VReg.RET, VReg.RET, 16); // RET = content 指针 = block + 16
        vm.emitMaskLoad(VReg.V1); // V1 = PAYLOAD_MASK
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1); // RET = RET & MASK
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); // V1 = TAG_STRING_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1); // RET = RET | TAG
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
    }

    // 布尔值转字符串
    // _boolToStr(b) -> str
    generateBoolToStr() {
        const vm = this.vm;

        vm.label("_boolToStr");

        const falseLabel = "_boolToStr_false";
        const endLabel = "_boolToStr_end";

        vm.cmpImm(VReg.A0, 0);
        vm.jeq(falseLabel);

        // true
        vm.lea(VReg.RET, "_str_true");
        vm.jmp(endLabel);

        vm.label(falseLabel);
        // false
        vm.lea(VReg.RET, "_str_false");

        vm.label(endLabel);
    }

    // 通用 toString（简化版）
    // _toString(v) -> str
    generateToString() {
        const vm = this.vm;

        vm.label("_toString");
        // 简单实现：返回 "[object Object]"
        vm.lea(VReg.RET, "_str_object");
    }

    // 智能值转字符串
    // _valueToStr(v) -> str (returns heap string as NaN-boxed JS string)
    // ECMAScript ToString: undefined→"undefined", null→"null",
    // true→"true", false→"false", numbers use float conversion
    generateValueToStr() {
        const vm = this.vm;
        const TYPE_STRING = 6;
        const TYPE_NUMBER = 13;
        const TYPE_FLOAT64 = 29;
        const TYPE_CLOSURE = 3;
        const TYPE_DATE = 7;
        // [w5c] 内建品牌类型字节(与 runtime/core/types.js、_object_proto_toString 一致)
        const TYPE_MAP = 4;
        const TYPE_SET = 5;
        const TYPE_PROMISE = 11;
        const TYPE_ARRAY_BUFFER = 12;
        const TYPE_DATA_VIEW = 14;

        vm.label("_valueToStr");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // S0 = original value

        // ========== Check for JSValue (high 16 bits >= 0x7FF8) ==========
        vm.shrImm(VReg.V1, VReg.S0, 48); // V1 = high 16 bits
        vm.movImm(VReg.V0, 0x7FF8);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jlt("_valueToStr_check_non_js"); // < 0x7FF8, not JSValue

        // High bits >= 0x7FF8: JSValue, calculate tag
        vm.subImm(VReg.V1, VReg.V1, 0x7FF8); // V1 = tag (0-7)

        // Tag 4 = string: unbox
        vm.cmpImm(VReg.V1, 4);
        vm.jeq("_valueToStr_js_string");

        // Tag 7 = function: OrdinaryToPrimitive
        vm.cmpImm(VReg.V1, 7);
        vm.jeq("_valueToStr_js_object");

        // Tag 6 = array: default Array#toString is join(",").  Going through
        // OrdinaryToPrimitive/_object_get("toString") while
        // `_nsobj_array_proto` is still 0 (no `Array.prototype` mention in the
        // function) used to miss, bounce valueOf, and SIGSEGV — seen after
        // `var C=Uint8Array; new C(iterable)` then Number([]) / TA.set([[]]).
        vm.cmpImm(VReg.V1, 6);
        vm.jeq("_valueToStr_js_array");

        // Tag 1 = boolean
        vm.cmpImm(VReg.V1, 1);
        vm.jeq("_valueToStr_js_boolean");

        // Tag 2 = null
        vm.cmpImm(VReg.V1, 2);
        vm.jeq("_valueToStr_js_null");

        // Tag 3 = undefined
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_valueToStr_js_undefined");

        // Tag 5 = object
        vm.cmpImm(VReg.V1, 5);
        vm.jeq("_valueToStr_js_object");

        // Tag 0 = integer, but ONLY if tag is actually 0
        // If tag is not in 0-7, it's not a valid JSValue (could be a raw float
        // with high bits >= 0x7FF8, like negative floats: -3.0 = 0xC008...)
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_valueToStr_check_non_js"); // tag != 0, not a valid JSValue
        vm.jmp("_valueToStr_js_number");

        // ========== JSValue handlers ==========
        vm.label("_valueToStr_js_boolean");
        // Boolean: extract bit 0, return "true" or "false"
        vm.andImm(VReg.V0, VReg.S0, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_valueToStr_js_boolean_false");
        // true
        vm.lea(VReg.A0, "_str_true");
        vm.jmp("_valueToStr_data_str_create_heap");
        vm.label("_valueToStr_js_boolean_false");
        vm.lea(VReg.A0, "_str_false");
        vm.jmp("_valueToStr_data_str_create_heap");

        vm.label("_valueToStr_js_null");
        vm.lea(VReg.A0, "_str_null");
        vm.jmp("_valueToStr_data_str_create_heap");

        vm.label("_valueToStr_js_undefined");
        vm.lea(VReg.A0, "_str_undefined");
        vm.jmp("_valueToStr_data_str_create_heap");

        vm.label("_valueToStr_js_function");
        vm.lea(VReg.A0, "_str_function");
        vm.jmp("_valueToStr_data_str_create_heap");

        vm.label("_valueToStr_js_object");
        vm.mov(VReg.V0, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1); // 裸块指针
        // 闭包全字检查: 0xc105 / 0xa51c 低字节是 5 (TYPE_SET), 必须先查全字!
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_valueToStr_js_object_plain");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_valueToStr_js_object_plain");
        // 数组: 走 OrdinaryToPrimitive
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_valueToStr_js_object_plain");

        // [Date] 装箱 Date(对象头字节 TYPE_DATE=7)→ _date_toString("Www Mmm DD YYYY ...")。
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, TYPE_DATE);
        vm.jeq("_valueToStr_js_date");
        // [w5c] 内建品牌:Map/Set(4/5,WeakMap/WeakSet 由 @+48 weakness 标志再分,
        // 同 _object_proto_toString :4383-4390 先例)、ArrayBuffer(12)、DataView(14)、
        // Promise(11) → "[object <品牌>]"。必须先于 _is_asmjs_err:这些块都不是属性
        // 对象,_object_has 野扫 + 后续 toprimitive/user_tostr 链把块内容误读
        // (String(new Map())/""+new Set() 打垃圾浮点的根因)。判序照抄 print.js:602-611。
        vm.cmpImm(VReg.V0, TYPE_MAP);
        vm.jeq("_valueToStr_js_mapset");
        vm.cmpImm(VReg.V0, TYPE_SET);
        vm.jeq("_valueToStr_js_mapset");
        vm.cmpImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.jeq("_valueToStr_js_arraybuffer");
        vm.cmpImm(VReg.V0, TYPE_DATA_VIEW);
        vm.jeq("_valueToStr_js_dataview");
        vm.cmpImm(VReg.V0, TYPE_PROMISE);
        vm.jeq("_valueToStr_js_promise");
        // Number/Float64 堆包装:ToString 其 offset+8 数值,勿落 "[object Object]"。
        vm.cmpImm(VReg.V0, TYPE_NUMBER);
        vm.jeq("_valueToStr_js_numwrap");
        vm.cmpImm(VReg.V0, TYPE_FLOAT64);
        vm.jeq("_valueToStr_js_numwrap");
        // [#36] Error 族对象(装箱 0x7FFD)→ "name: message"。S0 仍是装箱值。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_asmjs_err");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_valueToStr_js_object_plain");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_error_to_str"); // RET = 装箱堆串
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_valueToStr_js_object_plain");
        // [Symbol.toPrimitive] 优先(hint "string"):返回原始值 → 递归 ToString;仍是对象则回退 toString。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("string"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_call_toprimitive");
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_valueToStr_obj_tostr");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_valueToStr_obj_tostr");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_valueToStr_obj_tostr");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_valueToStr_prim_toprim");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jb("_valueToStr_prim_toprim");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jae("_valueToStr_prim_toprim");
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 2);
        vm.jeq("_valueToStr_obj_tostr");
        vm.cmpImm(VReg.V1, 1);
        vm.jeq("_valueToStr_obj_tostr");
        vm.label("_valueToStr_prim_toprim");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_valueToStr_obj_tostr");
        // 用户自有 toString(function 属性)优先:String(o)/`${o}`/`""+o` 调用它。
        // S0 = 装箱对象。_object_user_tostr 返回其结果或原对象 sentinel。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_user_tostr");
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0≡RET: tag 入 V2, 否则 RET 被毁后递归 stringify 标签
        vm.cmpImm(VReg.V2, 0x7FFD);       // toString 返回仍是对象
        vm.jeq("_valueToStr_try_vo");
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_valueToStr_try_vo");
        vm.cmpImm(VReg.V2, 0x7FFF);       // 或函数(hint String:再试 valueOf)
        vm.jeq("_valueToStr_try_vo");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_valueToStr_obj_tostr_ok"); // 带 tag 的原语 → 递归归一
        // high16==0:+0.0 是合法 primitive；其它裸堆对象(return {})须试
        // valueOf，数据段串则当原语。miss sentinel 已是原对象，不能再把 0
        // 当 miss，否则 {toString:()=>0} 会错误地继续调用 valueOf 并抛 TypeError。
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_valueToStr_obj_tostr_ok");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jb("_valueToStr_obj_tostr_ok");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jae("_valueToStr_obj_tostr_ok");
        vm.loadByte(VReg.V1, VReg.RET, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_valueToStr_try_vo");
        vm.cmpImm(VReg.V1, TYPE_ARRAY);
        vm.jeq("_valueToStr_try_vo");
        vm.jmp("_valueToStr_obj_tostr_ok");
        vm.label("_valueToStr_try_vo");
        vm.mov(VReg.A0, VReg.S0);         // 恢复原装箱对象
        vm.call("_object_user_valueof");  // 尝试 valueOf
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0≡RET
        vm.cmpImm(VReg.V2, 0x7FFD);       // valueOf 又返对象 / 无 valueOf
        vm.jeq("_valueToStr_object_default");
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_valueToStr_object_default");
        vm.cmpImm(VReg.V2, 0x7FFF);       // 或函数
        vm.jeq("_valueToStr_object_default");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_valueToStr_vo_ok");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_valueToStr_vo_ok");      // +0.0 primitive
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jb("_valueToStr_vo_ok");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jae("_valueToStr_vo_ok");
        vm.loadByte(VReg.V1, VReg.RET, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_valueToStr_object_default");
        vm.cmpImm(VReg.V1, TYPE_ARRAY);
        vm.jeq("_valueToStr_object_default");
        vm.label("_valueToStr_vo_ok");
        vm.mov(VReg.A0, VReg.RET);        // valueOf 原语 → 递归
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_valueToStr_obj_tostr_ok");
        vm.mov(VReg.A0, VReg.RET);        // toString 原语 → 递归
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_valueToStr_object_default");
        // 数组或函数在无自定义有效 toString/valueOf 时回退内建默认转换
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_valueToStr_js_array");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_valueToStr_js_function");
        // OrdinaryToPrimitive:toString/valueOf 皆非 callable 或皆返对象 → TypeError。
        this._emitThrowTypeError("Cannot convert object to primitive value");

        vm.label("_valueToStr_js_date");
        // Date → _date_toString(接受装箱 0x7ffd/裸指针;非 Date 已被上方类型字节拦截)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_date_toString"); // RET = 装箱堆串
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // [w5c] 内建品牌分支目标(全部经 addString 数据段串 + 既有 create_heap 返回路,
        // 与 _str_object 同形;标签无条件发射,字节确定性)
        vm.label("_valueToStr_js_mapset");
        // Weak 判别:@+48 weakness 标志(非 0 → WeakMap/WeakSet);V0 重算裸块指针
        vm.mov(VReg.V0, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 48); // x64 V2==A2,此处无活值
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_valueToStr_js_weakmapset");
        vm.loadByte(VReg.V2, VReg.V0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);
        vm.cmpImm(VReg.V2, TYPE_MAP);
        vm.jne("_valueToStr_js_set");
        vm.lea(VReg.A0, vm.asm.addString("[object Map]"));
        vm.jmp("_valueToStr_data_str_create_heap");
        vm.label("_valueToStr_js_set");
        vm.lea(VReg.A0, vm.asm.addString("[object Set]"));
        vm.jmp("_valueToStr_data_str_create_heap");
        vm.label("_valueToStr_js_weakmapset");
        vm.loadByte(VReg.V2, VReg.V0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);
        vm.cmpImm(VReg.V2, TYPE_MAP);
        vm.jne("_valueToStr_js_weakset");
        vm.lea(VReg.A0, vm.asm.addString("[object WeakMap]"));
        vm.jmp("_valueToStr_data_str_create_heap");
        vm.label("_valueToStr_js_weakset");
        vm.lea(VReg.A0, vm.asm.addString("[object WeakSet]"));
        vm.jmp("_valueToStr_data_str_create_heap");
        vm.label("_valueToStr_js_arraybuffer");
        vm.lea(VReg.A0, vm.asm.addString("[object ArrayBuffer]"));
        vm.jmp("_valueToStr_data_str_create_heap");
        vm.label("_valueToStr_js_dataview");
        vm.lea(VReg.A0, vm.asm.addString("[object DataView]"));
        vm.jmp("_valueToStr_data_str_create_heap");
        vm.label("_valueToStr_js_promise");
        vm.lea(VReg.A0, vm.asm.addString("[object Promise]"));
        vm.jmp("_valueToStr_data_str_create_heap");
        vm.label("_valueToStr_js_numwrap");
        // S0 仍是装箱 0x7FFD;脱壳为块指针后走既有 number_obj(offset+8)。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.jmp("_valueToStr_as_number_obj");

        vm.label("_valueToStr_js_array");
        // Array: extract low 48 bits as array pointer
        vm.movImm64(VReg.V0, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.S0, VReg.S0, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_to_string");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_valueToStr_js_string");
        // String: extract low 48 bits
        vm.movImm64(VReg.V0, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.S0, VReg.S0, VReg.V0);
        // Check if it's a data segment string or heap string
        vm.lea(VReg.V1, "_data_start");
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_valueToStr_js_heap_string"); // < _data_start, not data segment
        vm.lea(VReg.V1, "_data_start");
        vm.addImm(VReg.V1, VReg.V1, 0x100000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_valueToStr_js_heap_string"); // >= _data_start + 0x100000, not data segment
        // It's a data segment string
        vm.jmp("_valueToStr_as_data_str");

        vm.label("_valueToStr_js_heap_string");
        // tag-4 装箱堆串：S0 已是 content 指针（装箱约定 payload=content,头在 -16）。
        // 必须重新装箱 0x7FFC 返回——共享的 _valueToStr_as_heap_string 返回裸指针,
        // 且被 raw-heap 路径以 header 指针语义复用。裸指针流入 `+`/print 时高 16 位
        // 为 0x0000 < 0x7FF8,被误判为浮点 → "0."(String(arr.join(...)) 复现)。
        vm.movImm64(VReg.V1, 0x7FFC000000000000n);
        vm.or(VReg.RET, VReg.S0, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_valueToStr_js_number");
        // JSValue number: convert to string, then wrap in heap string
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_numberToString");
        // RET = data string pointer (NaN-boxed), wrap in heap string
        vm.mov(VReg.S1, VReg.RET); // S1 = data string pointer (NaN-boxed)
        // Unbox S1 to get raw string pointer for strlen
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm64(VReg.V0, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.A0, VReg.A0, VReg.V0); // A0 = raw string pointer
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET); // S2 = string length
        vm.addImm(VReg.A0, VReg.S2, 17);
        vm.call("_alloc");
        vm.mov(VReg.A0, VReg.RET); // A0 = user pointer = block + 16
        // writeStringHeader 以 content 指针为入参（内部自减 16）
        this.writeStringHeader(VReg.A0, VReg.S2);
        vm.mov(VReg.A0, VReg.RET); // dest = content pointer (block+16)
        // Unbox S1 for source pointer
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm64(VReg.V0, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.A1, VReg.A1, VReg.V0); // A1 = raw source string pointer
        vm.call("_strcpy");
        // Return NaN-boxed heap string
        vm.mov(VReg.RET, VReg.RET); // RET = content pointer
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7FFC000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // ========== Non-JSValue path ==========
        vm.label("_valueToStr_check_non_js");
        // BigInt：裸 user_ptr（[ptr-16] 类型=14）。String(255n)/模板 `${10n}`/"x"+10n
        // → 十进制串（无 n 后缀，对齐 node）。_is_bigint 内部带堆界守卫，非 bigint 返 0。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_valueToStr_bigint");
        // Not a JSValue. Could be: raw float, data segment pointer, or integer
        // Check if it's a data segment string pointer using _data_start label
        // This is the same approach used in print.js for reliable data segment detection
        vm.lea(VReg.V1, "_data_start");
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_valueToStr_check_raw_number"); // < _data_start, not data segment string

        // Check if in data segment range (_data_start + 0x100000)
        vm.lea(VReg.V1, "_data_start");
        vm.addImm(VReg.V1, VReg.V1, 0x100000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_valueToStr_check_heap_or_number"); // >= _data_start + 0x100000

        // S0 is in data segment range [_data_start, _data_start + 0x100000)
        // Also verify it's not in the heap range (check against heap_ptr)
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0); // V1 = heap_ptr
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_valueToStr_check_heap_or_number"); // S0 >= heap_ptr, might be heap object

        // Also check against heap_base to be safe
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0); // V1 = heap_base
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_valueToStr_check_heap_or_number"); // S0 >= heap_base, might be heap object

        // Verify first byte is printable ASCII (32-127) or null (0) to confirm it's a string
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_valueToStr_as_data_str"); // null byte = empty string
        vm.cmpImm(VReg.V0, 32);
        vm.jlt("_valueToStr_check_raw_number"); // < 32, not printable ASCII
        vm.cmpImm(VReg.V0, 127);
        vm.jge("_valueToStr_check_raw_number"); // >= 127, not printable ASCII
        vm.jmp("_valueToStr_as_data_str");

        vm.label("_valueToStr_check_data_ptr_range");
        // Legacy check - keep for backward compatibility but use _data_start based check above
        // Check if in low data segment range [0x100000, 0x100108000)
        vm.movImm(VReg.V0, 0x100000);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_valueToStr_check_raw_number"); // < 0x100000
        vm.movImm(VReg.V0, 0x100108000);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_valueToStr_check_raw_number"); // >= 0x100108000
        // Also check against heap_ptr to avoid misclassifying heap objects
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0); // V1 = heap_ptr
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_valueToStr_check_raw_number"); // S0 >= heap_ptr, not data string
        // In low data segment range, verify first byte is printable ASCII or null
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_valueToStr_as_data_str"); // null byte = empty string
        vm.cmpImm(VReg.V0, 32);
        vm.jlt("_valueToStr_check_raw_number"); // < 32, not printable ASCII
        vm.cmpImm(VReg.V0, 127);
        vm.jge("_valueToStr_check_raw_number"); // >= 127, not printable ASCII
        vm.jmp("_valueToStr_as_data_str");

        vm.label("_valueToStr_check_heap_or_number");
        // Not in data segment, could be heap object or raw number
        // Check heap base first - if S0 < heap_base, it's likely a data segment address
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0); // V0 = heap_base
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_valueToStr_check_data_ptr_range"); // S0 < heap_base, might be data segment

        // S0 >= heap_base, check heap pointer
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0); // V0 = heap_ptr
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_valueToStr_check_raw_number"); // >= heap_ptr, not heap object

        // S0 < heap_ptr, could be heap object
        // Check if it's a heap string (has valid type at offset 0)
        vm.load(VReg.V1, VReg.S0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, TYPE_STRING);
        vm.jeq("_valueToStr_as_heap_string");
        vm.cmpImm(VReg.V1, TYPE_NUMBER);
        vm.jeq("_valueToStr_as_number_obj");
        vm.cmpImm(VReg.V1, TYPE_FLOAT64);
        vm.jeq("_valueToStr_as_number_obj");
        vm.cmpImm(VReg.V1, TYPE_ARRAY);
        vm.jeq("_valueToStr_as_array");
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_valueToStr_as_object");
        // [w5c] 内建品牌(裸堆指针形态):Map/Set(4/5,@+48 weakness 再分 Weak 族)、
        // ArrayBuffer(12)、DataView(14) → "[object <品牌>]"。此前落 raw_number 把块
        // 内容当浮点打(String(new Map())/""+new Set() 垃圾浮点根因);均 < 0x40,
        // 与下方 TypedArray 区间无冲突。分支目标与装箱族共用(脱壳对裸指针幂等)。
        vm.cmpImm(VReg.V1, TYPE_MAP);
        vm.jeq("_valueToStr_js_mapset");
        vm.cmpImm(VReg.V1, TYPE_SET);
        vm.jeq("_valueToStr_js_mapset");
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jeq("_valueToStr_js_arraybuffer");
        vm.cmpImm(VReg.V1, TYPE_DATA_VIEW);
        vm.jeq("_valueToStr_js_dataview");
        // TypedArray(类型字节 0x40-0x61)→ 逗号连接串(String(ta)/`${ta}`/`""+ta`,
        // 对齐 node "1,2,3")。此前落 raw_number → 把 ta 头指针当浮点位模式 → 垃圾浮点。
        // 委托 _ta_join(ta, ","):经 _ta_to_array 转普通数组再 _array_join。
        vm.cmpImm(VReg.V1, 0x40);
        vm.jge("_valueToStr_as_typedarray");
        // Symbol 标记块（用户区 +0 == 61）：String(sym) → "Symbol(desc)"
        // （标准应 TypeError，记偏差）
        vm.cmpImm(VReg.V1, 61);
        vm.jeq("_valueToStr_as_symbol");
        // Unknown heap type, treat as raw number
        vm.jmp("_valueToStr_check_raw_number");

        vm.label("_valueToStr_as_typedarray");
        vm.mov(VReg.A0, VReg.S0); // ta 裸指针(_ta_to_array 内部 mask,裸指针幂等)
        vm.lea(VReg.A1, vm.asm.addString(","));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0); // 装箱 "," 数据串
        vm.call("_ta_join");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_valueToStr_as_symbol");
        // ToString(Symbol) 必须 TypeError(隐式转换 / String.raw 替换)。String(sym)
        // 规范有 SymbolDescriptiveString 特例,在 _builtin_string;此处走 ToString。
        this._emitThrowTypeError("Cannot convert a Symbol value to a string");

        vm.label("_valueToStr_bigint");
        // 64 位值在 user_ptr +0；_intToStr 返回 NaN-boxed 堆串（有符号十进制）。
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_intToStr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_valueToStr_check_raw_number");
        // Could be raw float or raw integer - convert to string
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_numberToString");
        // _numberToString 返回**共享静态缓冲区**指针 —— 曾直接当字符串值返回,
        // 后续任何数字转换都会篡改它(长度漂移、"2.5"变"2"、JSON 尾截断,#15 实锤)。
        // 必须立即拷出为堆串。(返回值可能 NaN-boxed,先脱壳 —— 与 js_number 路径一致)
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm64(VReg.V0, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.A0, VReg.A0, VReg.V0);
        vm.jmp("_valueToStr_data_str_create_heap");

        // ========== Create heap string from data segment string ==========
        vm.label("_valueToStr_data_str_create_heap");
        // A0 = data segment string pointer
        // Create heap string from it
        vm.mov(VReg.S1, VReg.A0); // S1 = data string pointer
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET); // S2 = string length
        // Allocate: header(16) + length + 1
        vm.addImm(VReg.A0, VReg.S2, 17);
        vm.call("_alloc");
        vm.mov(VReg.A0, VReg.RET); // A0 = content 指针 (user_ptr)
        // 写头：writeStringHeader 约定入参是 content 指针（内部自减 16），
        // 传 block 指针会二次减 16 把头写进前一个块的尾部（破坏邻居内容）
        this.writeStringHeader(VReg.A0, VReg.S2);
        // Copy content
        vm.mov(VReg.A0, VReg.A0); // dest = content pointer
        vm.mov(VReg.A1, VReg.S1); // src = data string
        vm.call("_strcpy");
        // Return NaN-boxed heap string
        vm.mov(VReg.RET, VReg.A0); // RET = content pointer
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // ========== Heap object handlers ==========
        vm.label("_valueToStr_as_heap_string");
        // 堆字符串装箱约定：payload 即 content 指针（头在 -16/-8），
        // 旧的 +16 是块指针时代残留，会跳过前 16 个字符
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_valueToStr_as_array");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_to_string");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_valueToStr_as_object");
        // [#36] Error 族对象 → "name: message"。此处 S0 是裸对象堆指针(high16==0),
        // 先装箱回 0x7FFD 供 _is_asmjs_err/_error_to_str(它们按装箱值取属性)。
        vm.mov(VReg.S1, VReg.S0);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V1); // S1 = 装箱对象
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_asmjs_err");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_valueToStr_as_object_plain");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_error_to_str"); // RET = 装箱堆串
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_valueToStr_as_object_plain");
        vm.lea(VReg.A0, "_str_object");
        vm.jmp("_valueToStr_data_str_create_heap"); // 曾误用 call(其 epilogue 弹本帧)

        vm.label("_valueToStr_as_number_obj");
        vm.load(VReg.A0, VReg.S0, 8); // Load float bits
        vm.call("_numberToString");
        vm.mov(VReg.A0, VReg.RET); // 共享缓冲 → 拷出堆串(同 raw_number 修复)
        vm.movImm64(VReg.V0, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.A0, VReg.A0, VReg.V0);
        vm.jmp("_valueToStr_data_str_create_heap");

        vm.label("_valueToStr_as_data_str");
        // Data segment string: create heap string
        // S0 = data segment pointer
        vm.mov(VReg.S1, VReg.S0); // S1 = original pointer
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET); // S2 = length
        vm.addImm(VReg.A0, VReg.S2, 17);
        vm.call("_alloc");
        vm.mov(VReg.A0, VReg.RET); // A0 = user pointer
        // writeStringHeader 以 content 指针为入参（内部自减 16）
        this.writeStringHeader(VReg.A0, VReg.S2);
        // Copy content
        vm.mov(VReg.A0, VReg.A0); // dest content ptr
        vm.mov(VReg.A1, VReg.S1); // src
        vm.call("_strcpy");
        // Return NaN-boxed
        vm.mov(VReg.RET, VReg.A0);
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // _object_user_tostr(A0 = 装箱对象) -> RET:function 型 toString 的调用结果，
        // 或原对象(无 callable toString)。原对象是无歧义 sentinel；裸 0 不能作 miss，
        // 因为用户 toString 合法返回 +0。
        // 调用约定镜像 _maybe_getter_closure:S0=闭包指针、A5=this、[闭包+8]=真函数指针。
        vm.label("_object_user_tostr");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S2, VReg.A0); // S2 = 装箱对象(this)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("toString"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_get");
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0≡RET: 否则把 toString 闭包毁成标签 0x7FFF
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jne("_object_user_tostr_getter");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.label("_object_user_tostr_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_object_user_tostr_none");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);       // function tag
        vm.jne("_object_user_tostr_none");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V0); // S0 = 闭包指针(函数体入口约定)
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_object_user_tostr_ok");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jne("_object_user_tostr_none");
        vm.label("_object_user_tostr_ok");
        vm.load(VReg.V1, VReg.S0, 8);      // V1 = 真函数指针
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A5, VReg.S2);          // this = 对象
        vm.movImm64(VReg.A1, 0x7ffb000000000000n); // undefined (argc=0; toString radix)
        vm.setCallArgcImm(0, VReg.V0, VReg.V2); // [argc ABI] toString()
        vm.callIndirect(VReg.V1);          // RET = 用户 toString 结果
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_object_user_tostr_none");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // _object_user_valueof(A0 = 装箱对象) -> RET:自有 function 型 valueOf 的调用结果,
        // 或原对象(无 callable valueOf)。+0.0 是合法原语,不能再用 0 作 miss 哨兵
        // (`""+new Number(0)` 曾把 valueOf=+0 当 miss → toString  leftover A1 当 radix SIGSEGV)。
        // 调用方以 tag 0x7FFD/0x7FFF 判"仍是对象,试下一方法"。
        vm.label("_object_user_valueof");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S2, VReg.A0);
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("valueOf"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_get");
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0≡RET: 否则 valueOf 闭包毁成标签
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jne("_object_user_valueof_getter");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.label("_object_user_valueof_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_object_user_valueof_none");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_object_user_valueof_none");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V0);
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_object_user_valueof_ok");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jne("_object_user_valueof_none");
        vm.label("_object_user_valueof_ok");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A5, VReg.S2);
        vm.movImm64(VReg.A1, 0x7ffb000000000000n); // undefined (argc=0)
        vm.setCallArgcImm(0, VReg.V0, VReg.V2); // [argc ABI] valueOf()
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_object_user_valueof_none");
        vm.mov(VReg.RET, VReg.S2); // still-object sentinel (not +0.0)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // _call_toprimitive(A0=装箱对象 0x7FFD, A1=hint 装箱串) -> RET:
        // 若 obj 有 function 型 [Symbol.toPrimitive],以 (hint) 调之(this=obj)返回其结果;
        // 否则原样返回 A0(仍是 0x7FFD 对象 → 调用方据此回退 valueOf/toString)。
        // toPrimitive 结果必为原始值(非 0x7FFD),故"返回仍是对象"即"无 toPrimitive"哨兵无歧义。
        vm.label("_call_toprimitive");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S2, VReg.A0); // obj(this)
        vm.mov(VReg.S3, VReg.A1); // hint
        // 非对象(高16≠0x7FFD)直接原样返回(热路径:数字/串/原始值零开销)
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_ctp_none");
        // well-known Symbol.toPrimitive(懒创建,进程唯一)
        vm.lea(VReg.A0, "_symwk_toPrimitive");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toPrimitive"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown"); // RET = symbol 键
        // Same path as obj[Symbol.toPrimitive]: _subscript_get does
        // ToPropertyKey + Get + _maybe_getter. Direct _object_get(obj,
        // wellknown) missed defineProperty accessors after _jpk_low
        // stringified the stored key.
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_subscript_get");
        vm.mov(VReg.S1, VReg.RET);
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq("_ctp_none");
        vm.movImm64(VReg.V0, 0x7ffa000000000000n); // null
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq("_ctp_none");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_ctp_none");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);   // function tag
        vm.jne("_ctp_not_callable");
        // 调用 [Symbol.toPrimitive](hint):约定同 _object_user_tostr(S0=闭包、[+8]=真函数、A5=this)
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.S0, VReg.S1, VReg.V0);
        vm.load(VReg.V1, VReg.S0, 8);
        vm.mov(VReg.A0, VReg.S3);     // hint = arg0
        vm.mov(VReg.A5, VReg.S2);     // this = obj
        vm.setCallArgcImm(1, VReg.V0, VReg.V2); // [argc ABI] [Symbol.toPrimitive](hint)
        vm.callIndirect(VReg.V1);
        // ToPrimitive:exotic 返回对象 → TypeError(不可回落 OrdinaryToPrimitive)
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0≡RET: 否则原语结果被毁成标签
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jeq("_ctp_obj_result");
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_ctp_obj_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_ctp_not_callable");
        this._emitThrowTypeError("Cannot convert object to primitive value");
        vm.label("_ctp_obj_result");
        this._emitThrowTypeError("Cannot convert object to primitive value");
        vm.label("_ctp_none");
        vm.mov(VReg.RET, VReg.S2);    // 原样返回(无 Symbol.toPrimitive)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _js_toprimitive(A0 = 装箱对象 0x7FFD 或函数 0x7FFF) -> RET:ToPrimitive(obj, default)。
        // Symbol.toPrimitive 优先(hint="default");否则 valueOf 优先、toString、_valueToStr。二元 `+` 用。
        // 函数无 @@toPrimitive:_call_toprimitive 原样返回 0x7FFF,须继续 OrdinaryToPrimitive,
        // 否则 `f.valueOf=()=>1; 1+f` 把函数当原语用。
        vm.label("_js_toprimitive");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        // Date [[DefaultValue]] / @@toPrimitive hint default is string.
        // Must run before GetMethod: _subscript_get on a 16B Date can return
        // leftover 0 (timestamp@8) which looks like a primitive and skips
        // OrdinaryToPrimitive. valueOf would also yield 0 so date+date was 0.
        vm.shrImm(VReg.V2, VReg.S0, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jne("_js_toprim_try_exotic");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.S0, VReg.V1);
        vm.load(VReg.V0, VReg.V1, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 7); // TYPE_DATE
        vm.jeq("_js_toprim_default_str");
        vm.label("_js_toprim_try_exotic");
        // [Symbol.toPrimitive] 优先(hint "default")
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("default"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_call_toprimitive");
        vm.shrImm(VReg.V2, VReg.RET, 48); // (x64 V2==A2 无活值;V0≡RET 会盖掉原始值结果)
        vm.cmpImm(VReg.V2, 0x7FFD);        // 仍是对象 → 无 toPrimitive,回退
        vm.jeq("_js_toprim_ordinary");
        vm.cmpImm(VReg.V2, 0x7FFF);        // 函数(含无 trap 原样返回)→ 同样回退
        vm.jne("_js_toprim_done");
        vm.label("_js_toprim_ordinary");
        // OrdinaryToPrimitive hint default: valueOf then toString. Internal
        // [[NumberData]]/[[StringData]]/[[BigIntData]] slots are a fallback
        // after those methods miss or return objects. Reading them first
        // skipped a user valueOf/toString (`new String("x").valueOf=()=>"ed"`
        // still compared as the original primitive).
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_user_valueof");   // A0 仍是对象/函数
        // miss 现返原对象(0x7FFD);+0.0 是合法原语,勿 cmpImm 0。
        vm.shrImm(VReg.V2, VReg.RET, 48); // (x64 V2==A2 无活值;V0≡RET 会盖掉原始值结果)
        vm.cmpImm(VReg.V2, 0x7FFD);        // valueOf 结果又是对象 / 无 valueOf?
        vm.jeq("_js_toprim_try_tostr");
        vm.cmpImm(VReg.V2, 0x7FFF);        // 或仍是函数
        vm.jne("_js_toprim_done");         // 原始值(含 +0.0) → 用
        vm.label("_js_toprim_try_tostr");
        // OrdinaryToPrimitive:valueOf 返对象后调用户 toString(可抛)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_user_tostr");
        // +0.0 is a legal primitive; miss is the original object sentinel.
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0≡RET: keep primitive result
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jeq("_js_toprim_slots");
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jeq("_js_toprim_slots");
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_js_toprim_slots");
        vm.epilogue([VReg.S0], 16);
        vm.label("_js_toprim_slots");
        // Fallback: wrapper internal slots when valueOf/toString were absent
        // or returned objects. Presence-checked: _object_get miss is leftover
        // 0, which is also +0.0.
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__bigint_value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_js_toprim_no_bi_slot");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.jmp("_js_toprim_done");
        vm.label("_js_toprim_no_bi_slot");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_js_toprim_no_num_slot");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.jmp("_js_toprim_done");
        vm.label("_js_toprim_no_num_slot");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_js_toprim_both_obj");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.jmp("_js_toprim_done");
        vm.label("_js_toprim_both_obj");
        this._emitThrowTypeError("Cannot convert object to primitive value");
        vm.label("_js_toprim_default_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.label("_js_toprim_done");
        vm.epilogue([VReg.S0], 16);
    }

    // _is_asmjs_err(boxedVal) -> 1/0
    // [#36] Error 族字符串化判别：tag==0x7FFD 的对象且含 __asmjs_err 品牌属性。
    // 输入须为已装箱值（0x7FFD 对象）；非对象 tag 直接返 0，故 low48 解引前有守卫。
    generateIsAsmjsErr() {
        const vm = this.vm;
        vm.label("_is_asmjs_err");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_is_asmjs_err_no");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__asmjs_err"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_is_asmjs_err_no");
        vm.movImm(VReg.RET, 1);
        vm.jmp("_is_asmjs_err_end");
        vm.label("_is_asmjs_err_no");
        vm.movImm(VReg.RET, 0);
        vm.label("_is_asmjs_err_end");
        vm.epilogue([VReg.S0], 0);
    }

    // _error_to_str(boxedErrObj) -> 装箱堆串 "name: message"
    // [#36] 空 message → 只返回 name（对齐 node）。委托既有 _object_get/_strconcat。
    // 注意：_strconcat 只保存 S0-S4（冲 S5），本函数只用 S0-S2，安全。
    generateErrorToStr() {
        const vm = this.vm;
        vm.label("_error_to_str");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // S0 = err obj（装箱 0x7FFD）
        // name = obj.name
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.S1, VReg.RET); // S1 = name（装箱串）
        // message = obj.message
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("message"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.S2, VReg.RET); // S2 = message（装箱串）
        // 空 message 判定：取内容指针，首字节为 0（或空指针）即空 → 只返回 name
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_getStrContent");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_error_to_str_name_only");
        vm.loadByte(VReg.V0, VReg.RET, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_error_to_str_name_only");
        // name + ": " + message
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, "_str_err_sep");
        vm.call("_strconcat");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_strconcat");
        vm.jmp("_error_to_str_end");
        vm.label("_error_to_str_name_only");
        vm.mov(VReg.RET, VReg.S1);
        vm.label("_error_to_str_end");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _numberToString(v) -> str
    // Converts a number (JSValue or raw bits) to string
    generateNumberToString() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_numberToString");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // S0 = number value (could be JSValue or raw bits)

        // Check if JSValue (high 16 bits >= 0x7FF8)
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.movImm(VReg.V0, 0x7FF8);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jlt("_numberToString_raw"); // Not JSValue

        // JSValue - extract tag
        vm.subImm(VReg.V1, VReg.V1, 0x7FF8); // V1 = tag
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_numberToString_js_number_obj"); // Not int32

        // Int32: extract low 32 bits
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.and(VReg.A0, VReg.S0, VReg.V0);
        vm.call("_intToStr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        vm.label("_numberToString_js_number_obj");
        // Could be Number object or other - treat as float
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_floatToString");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        vm.label("_numberToString_raw");
        // Raw number (could be float bits or integer)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_floatToString");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);
    }

    // ===== Dragon4 大整数原语(32 位肢,存于 8 字节槽,低 32 位有效,little-endian)=====
    // 全部为叶子函数(仅用 A0-A2/V0-V7/RET,不碰 S0-S5),故调用方 S 寄存器跨调用存活。
    // NLIMB=48 肢(1536 位)足够覆盖 double 全指数域(~2^1080 + 10^k 缩放余量)。
    generateDragon4Bignum() {
        const vm = this.vm;
        const NLIMB = 48;

        // _d4_zero(A0=buf):清零 NLIMB 个 8 字节槽
        vm.label("_d4_zero");
        vm.movImm(VReg.V0, 0);
        vm.movImm(VReg.V2, 0);
        vm.label("_d4_zero_l");
        vm.cmpImm(VReg.V0, NLIMB);
        vm.jge("_d4_zero_e");
        vm.shlImm(VReg.V1, VReg.V0, 3);
        vm.add(VReg.V1, VReg.A0, VReg.V1);
        vm.store(VReg.V1, 0, VReg.V2);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_d4_zero_l");
        vm.label("_d4_zero_e");
        vm.ret();

        // _d4_setlo(A0=buf, A1=val64):肢0=val 低32、肢1=val 高32(假定 buf 已清零)
        vm.label("_d4_setlo");
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.V0, VReg.A1, VReg.V1);
        vm.store(VReg.A0, 0, VReg.V0);
        vm.shrImm(VReg.V0, VReg.A1, 32);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.A0, 8, VReg.V0);
        vm.ret();

        // _d4_copy(A0=dst, A1=src)
        vm.label("_d4_copy");
        vm.movImm(VReg.V3, 0);
        vm.label("_d4_copy_l");
        vm.cmpImm(VReg.V3, NLIMB);
        vm.jge("_d4_copy_e");
        vm.shlImm(VReg.V4, VReg.V3, 3);
        vm.add(VReg.V0, VReg.A1, VReg.V4);
        vm.load(VReg.V0, VReg.V0, 0);
        vm.add(VReg.V1, VReg.A0, VReg.V4);
        vm.store(VReg.V1, 0, VReg.V0);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp("_d4_copy_l");
        vm.label("_d4_copy_e");
        vm.ret();

        // _d4_mul_small(A0=buf, A1=m):buf *= m(m 小,单肢×m 不溢 64 位),进位链
        vm.label("_d4_mul_small");
        vm.movImm(VReg.V2, 0); // carry
        vm.movImm(VReg.V3, 0); // i
        vm.label("_d4_mul_l");
        vm.cmpImm(VReg.V3, NLIMB);
        vm.jge("_d4_mul_e");
        vm.shlImm(VReg.V4, VReg.V3, 3);
        vm.add(VReg.V4, VReg.A0, VReg.V4);
        vm.load(VReg.V0, VReg.V4, 0);
        vm.mul(VReg.V0, VReg.V0, VReg.A1);
        vm.add(VReg.V0, VReg.V0, VReg.V2);
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.V5, VReg.V0, VReg.V1);
        vm.store(VReg.V4, 0, VReg.V5);
        vm.shrImm(VReg.V2, VReg.V0, 32);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp("_d4_mul_l");
        vm.label("_d4_mul_e");
        vm.ret();

        // _d4_shl(A0=buf, A1=bits):buf <<= bits(多肢左移,高肢→低肢原地)
        vm.label("_d4_shl");
        vm.cmpImm(VReg.A1, 0);
        vm.jeq("_d4_shl_ret");
        vm.shrImm(VReg.V2, VReg.A1, 5);  // wordShift
        vm.andImm(VReg.V3, VReg.A1, 31); // bitRem
        // src1 暂存寄存器:x64 上 A2 与 V2(wordShift)同为 RDX(backend/x64.js regMap 别名),
        // 故 movImm(src1,0)/load(src1) 会清零 wordShift → 每轮 j=i-0(丢字移),整数被 ×2^32
        // (如 _d4_shl(buf,53) 得 2^21 而非 2^53 → 数值全线偏一 32 位字)。x64 改用 A1(bits 已在
        // 上两行消费完、=RSI 不与本函数任何活寄存器别名);arm64 A2 无别名保持不变故 arm64 发射
        // 字节零扰动(自举门 byte-identical)。
        const shlSrc1 = (vm.arch === "x64") ? VReg.A1 : VReg.A2;
        vm.movImm(VReg.V4, NLIMB - 1);   // i
        vm.label("_d4_shl_loop");
        vm.cmpImm(VReg.V4, 0);
        vm.jlt("_d4_shl_ret");
        vm.sub(VReg.V5, VReg.V4, VReg.V2); // j = i - wordShift
        vm.movImm(shlSrc1, 0);             // src1
        vm.cmpImm(VReg.V5, 0);
        vm.jlt("_d4_shl_s1done");
        vm.shlImm(VReg.V0, VReg.V5, 3);
        vm.add(VReg.V0, VReg.A0, VReg.V0);
        vm.load(shlSrc1, VReg.V0, 0);
        vm.label("_d4_shl_s1done");
        vm.shl(VReg.V0, shlSrc1, VReg.V3); // src1 << bitRem
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_d4_shl_store");
        vm.subImm(VReg.V6, VReg.V5, 1);    // j-1
        vm.movImm(VReg.V1, 0);             // src2
        vm.cmpImm(VReg.V6, 0);
        vm.jlt("_d4_shl_s2done");
        vm.shlImm(VReg.V7, VReg.V6, 3);
        vm.add(VReg.V7, VReg.A0, VReg.V7);
        vm.load(VReg.V1, VReg.V7, 0);
        vm.label("_d4_shl_s2done");
        vm.movImm(VReg.V6, 32);
        vm.sub(VReg.V6, VReg.V6, VReg.V3); // 32 - bitRem
        vm.shr(VReg.V1, VReg.V1, VReg.V6); // src2 >> (32-bitRem)
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.label("_d4_shl_store");
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.shlImm(VReg.V1, VReg.V4, 3);
        vm.add(VReg.V1, VReg.A0, VReg.V1);
        vm.store(VReg.V1, 0, VReg.V0);
        vm.subImm(VReg.V4, VReg.V4, 1);
        vm.jmp("_d4_shl_loop");
        vm.label("_d4_shl_ret");
        vm.ret();

        // _d4_cmp(A0=a, A1=b) -> RET:2 若 a>b、1 若相等、0 若 a<b(高肢→低肢)
        vm.label("_d4_cmp");
        vm.movImm(VReg.V3, NLIMB - 1);
        vm.label("_d4_cmp_l");
        vm.cmpImm(VReg.V3, 0);
        vm.jlt("_d4_cmp_eq");
        vm.shlImm(VReg.V4, VReg.V3, 3);
        vm.add(VReg.V0, VReg.A0, VReg.V4);
        vm.load(VReg.V0, VReg.V0, 0);
        vm.add(VReg.V1, VReg.A1, VReg.V4);
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jgt("_d4_cmp_gt");
        vm.jlt("_d4_cmp_lt");
        vm.subImm(VReg.V3, VReg.V3, 1);
        vm.jmp("_d4_cmp_l");
        vm.label("_d4_cmp_gt");
        vm.movImm(VReg.RET, 2);
        vm.ret();
        vm.label("_d4_cmp_lt");
        vm.movImm(VReg.RET, 0);
        vm.ret();
        vm.label("_d4_cmp_eq");
        vm.movImm(VReg.RET, 1);
        vm.ret();

        // _d4_add3(A0=dst, A1=a, A2=b):dst = a + b
        // x64 别名坑:carry(V2)与 b 指针(A2)同为 RDX(backend/x64.js regMap),`movImm(V2,0)`
        // 会把 b 指针清零 → 每轮从 0+off 读 b[i] → 近空(null)崩。x64 上把 b 指针搬到 V6(R11,
        // 不与任何 A 参别名)作 addB,dst 存储改用 V4(off,该轮内已用完可复用)腾出 V6;arm64
        // 无别名保持原寄存器,故本文件 arm64 段与后端均不涉此分支 → 自举门字节零扰动。
        const addB = (vm.arch === "x64") ? VReg.V6 : VReg.A2;
        const addDst = (vm.arch === "x64") ? VReg.V4 : VReg.V6;
        vm.label("_d4_add3");
        if (vm.arch === "x64") vm.mov(VReg.V6, VReg.A2); // b 指针搬离 RDX(=carry V2)
        vm.movImm(VReg.V2, 0); // carry
        vm.movImm(VReg.V3, 0); // i
        vm.label("_d4_add_l");
        vm.cmpImm(VReg.V3, NLIMB);
        vm.jge("_d4_add_e");
        vm.shlImm(VReg.V4, VReg.V3, 3);
        vm.add(VReg.V0, VReg.A1, VReg.V4);
        vm.load(VReg.V0, VReg.V0, 0);
        vm.add(VReg.V1, addB, VReg.V4);
        vm.load(VReg.V1, VReg.V1, 0);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.add(VReg.V0, VReg.V0, VReg.V2);
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.V5, VReg.V0, VReg.V1);
        vm.add(addDst, VReg.A0, VReg.V4);
        vm.store(addDst, 0, VReg.V5);
        vm.shrImm(VReg.V2, VReg.V0, 32);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp("_d4_add_l");
        vm.label("_d4_add_e");
        vm.ret();

        // _d4_sub(A0=a, A1=b):a -= b(要求 a>=b),借位链
        vm.label("_d4_sub");
        vm.movImm(VReg.V2, 0); // borrow
        vm.movImm(VReg.V3, 0); // i
        vm.label("_d4_sub_l");
        vm.cmpImm(VReg.V3, NLIMB);
        vm.jge("_d4_sub_e");
        vm.shlImm(VReg.V4, VReg.V3, 3);
        vm.add(VReg.V6, VReg.A0, VReg.V4);
        vm.load(VReg.V0, VReg.V6, 0);
        vm.add(VReg.V1, VReg.A1, VReg.V4);
        vm.load(VReg.V1, VReg.V1, 0);
        vm.sub(VReg.V0, VReg.V0, VReg.V1);
        vm.sub(VReg.V0, VReg.V0, VReg.V2);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_d4_sub_pos");
        vm.movImm64(VReg.V1, 0x100000000n);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V2, 1);
        vm.jmp("_d4_sub_st");
        vm.label("_d4_sub_pos");
        vm.movImm(VReg.V2, 0);
        vm.label("_d4_sub_st");
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.V6, 0, VReg.V0);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp("_d4_sub_l");
        vm.label("_d4_sub_e");
        vm.ret();
    }

    // _floatToString(v) -> str
    // Converts float to string with proper decimal handling
    generateFloatToString() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_floatToString");
        vm.prologue(192, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.mov(VReg.S0, VReg.A0); // S0 = float value (as IEEE 754 bits)
        vm.fmovToFloat(0, VReg.S0); // D0 = float

        // Check for NaN: exponent = 0x7FF, mantissa != 0
        vm.mov(VReg.S1, VReg.S0);
        vm.shrImm(VReg.S1, VReg.S1, 52);
        vm.andImm(VReg.S1, VReg.S1, 0x7ff);
        vm.cmpImm(VReg.S1, 0x7ff);
        const notNaNLabel = "_floatToString_not_nan";
        vm.jne(notNaNLabel);
        // [#27] 注释说"尾数非 0"但原码未查尾数 → Infinity(指数全1、尾数0)误进
        // NaN 分支,下方 Infinity 专属路径成死代码(1/0 打印 "NaN" 根因)。
        // 尾数为 0 → 放行,由下方指数+尾数复检路由到 Infinity 路径。
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(notNaNLabel);

        // NaN path - return "NaN"
        vm.lea(VReg.A0, "_str_nan");
        vm.call("_getStrContent");
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 192);

        vm.label(notNaNLabel);

        // Check for Infinity: exponent = 0x7FF AND mantissa = 0
        // First check exponent (must be 0x7FF)
        vm.mov(VReg.S1, VReg.S0);
        vm.shrImm(VReg.S1, VReg.S1, 52);
        vm.andImm(VReg.S1, VReg.S1, 0x7ff);
        vm.cmpImm(VReg.S1, 0x7ff);
        const notInfLabel = "_floatToString_not_inf";
        vm.jne(notInfLabel);

        // Exponent is 0x7FF, now check mantissa is 0
        vm.movImm64(VReg.V0, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.S1, VReg.S0, VReg.V0);
        vm.cmpImm(VReg.S1, 0);
        vm.jne(notInfLabel);

        // Infinity path - check sign
        vm.shrImm(VReg.S1, VReg.S0, 63);
        vm.cmpImm(VReg.S1, 1);
        const negInfLabel = "_floatToString_neg_inf";
        const posInfLabel = "_floatToString_pos_inf";
        vm.jeq(negInfLabel);

        // Positive Infinity
        vm.lea(VReg.A0, "_str_infinity");
        vm.call("_getStrContent");
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 192);

        // Negative Infinity —— [#27] 原为手搓堆串构造(lea V1 无人消费、_strcpy
        // 源/宿参数错乱),因上方 NaN 分支漏查尾数一直是死代码;修活后改为与
        // 正 Infinity 同款:直接返回数据段串,零分配零拷贝。
        vm.label(negInfLabel);
        vm.lea(VReg.A0, this.vm.asm.addString("-Infinity"));
        vm.call("_getStrContent");
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 192);

        // ===== Dragon4 有限数路径(最短往返,精确匹配 V8/node Number::toString)=====
        // notInfLabel:S0=原始浮点位。之前 d0=值(不再需要)。
        vm.label(notInfLabel);
        const R_OFF = 0, S_OFF = 384, MP_OFF = 768, MM_OFF = 1152;
        const T_OFF = 1536, DIG_OFF = 1920, LOW_OFF = 1976, ND_OFF = 1984, OST_OFF = 1992;
        const D4EPI = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.mov(VReg.S5, VReg.S0); // S5 = 原始位(符号在最后取)
        // ±0 → "0"(ToString(-0)="0";console.log 的 -0 已在 _print_value 前置拦截)
        vm.shlImm(VReg.V0, VReg.S5, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_fts_d4_go");
        vm.lea(VReg.A0, this.vm.asm.addString("0"));
        vm.call("_getStrContent");
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue(D4EPI, 192);

        vm.label("_fts_d4_go");
        // arena(2560 分配 → ~2544 可用;含 5 个大整数缓冲 + 数字区 + 标量槽)
        vm.movImm(VReg.A0, 2560);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET); // S0 = arena
        // 清零 R/S/mP/mM
        vm.mov(VReg.A0, VReg.S0); vm.call("_d4_zero");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.call("_d4_zero");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.call("_d4_zero");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.call("_d4_zero");
        // 解码:biasedExp(V2)、rawMant(V3)
        vm.shrImm(VReg.V2, VReg.S5, 52); vm.andImm(VReg.V2, VReg.V2, 0x7FF);
        vm.movImm64(VReg.V3, 0x000FFFFFFFFFFFFFn); vm.and(VReg.V3, VReg.S5, VReg.V3);
        // mantissa(S3)、exponent(S4)
        vm.cmpImm(VReg.V2, 0); vm.jne("_fts_norm");
        vm.mov(VReg.S3, VReg.V3);
        vm.movImm(VReg.S4, 0); vm.subImm(VReg.S4, VReg.S4, 1074); // exponent = -1074
        vm.jmp("_fts_dec");
        vm.label("_fts_norm");
        vm.movImm64(VReg.V0, 0x10000000000000n); vm.or(VReg.S3, VReg.V3, VReg.V0);
        vm.subImm(VReg.S4, VReg.V2, 1075);
        vm.label("_fts_dec");
        // isEven(S2) = 1 - (mantissa & 1)
        vm.andImm(VReg.V0, VReg.S3, 1); vm.movImm(VReg.S2, 1); vm.sub(VReg.S2, VReg.S2, VReg.V0);
        // lowerCloser(V4) = (rawMant==0 && biasedExp>1)
        vm.movImm(VReg.V4, 0);
        vm.cmpImm(VReg.V3, 0); vm.jne("_fts_lc0");
        vm.cmpImm(VReg.V2, 1); vm.jle("_fts_lc0");
        vm.movImm(VReg.V4, 1);
        vm.label("_fts_lc0");
        // 构建 R/S/mP/mM:按 exponent 符号 + lowerCloser 四分支
        vm.cmpImm(VReg.S4, 0); vm.jlt("_fts_eneg");
        vm.cmpImm(VReg.V4, 0); vm.jne("_fts_ep_lc");
        // E>=0, !lowerCloser: R=M<<(E+1); S=2; mP=1<<E; mM=1<<E
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_d4_setlo");
        vm.mov(VReg.A0, VReg.S0); vm.addImm(VReg.A1, VReg.S4, 1); vm.call("_d4_shl");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.movImm(VReg.A1, 2); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.mov(VReg.A1, VReg.S4); vm.call("_d4_shl");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.mov(VReg.A1, VReg.S4); vm.call("_d4_shl");
        vm.jmp("_fts_setup_done");
        vm.label("_fts_ep_lc");
        // E>=0, lowerCloser: R=M<<(E+2); S=4; mP=1<<(E+1); mM=1<<E
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_d4_setlo");
        vm.mov(VReg.A0, VReg.S0); vm.addImm(VReg.A1, VReg.S4, 2); vm.call("_d4_shl");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.movImm(VReg.A1, 4); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.addImm(VReg.A1, VReg.S4, 1); vm.call("_d4_shl");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.mov(VReg.A1, VReg.S4); vm.call("_d4_shl");
        vm.jmp("_fts_setup_done");
        vm.label("_fts_eneg");
        vm.cmpImm(VReg.V4, 0); vm.jne("_fts_en_lc");
        // E<0, !lowerCloser: R=M<<1; S=1<<(-E+1); mP=1; mM=1
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_d4_setlo");
        vm.mov(VReg.A0, VReg.S0); vm.movImm(VReg.A1, 1); vm.call("_d4_shl");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.neg(VReg.A1, VReg.S4); vm.addImm(VReg.A1, VReg.A1, 1); vm.call("_d4_shl");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.jmp("_fts_setup_done");
        vm.label("_fts_en_lc");
        // E<0, lowerCloser: R=M<<2; S=1<<(-E+2); mP=2; mM=1
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_d4_setlo");
        vm.mov(VReg.A0, VReg.S0); vm.movImm(VReg.A1, 2); vm.call("_d4_shl");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.neg(VReg.A1, VReg.S4); vm.addImm(VReg.A1, VReg.A1, 2); vm.call("_d4_shl");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.movImm(VReg.A1, 2); vm.call("_d4_setlo");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.movImm(VReg.A1, 1); vm.call("_d4_setlo");
        vm.label("_fts_setup_done");
        // ---- 估计 k:msb=floor(log2(mantissa)),e2=exponent+msb,k=floor(e2*0.30103)-2 ----
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.V0, 0);
        vm.shrImm(VReg.V0, VReg.V0, 52); vm.andImm(VReg.V0, VReg.V0, 0x7FF); vm.subImm(VReg.V0, VReg.V0, 1023);
        vm.add(VReg.V0, VReg.S4, VReg.V0); // e2
        vm.scvtf(0, VReg.V0);
        vm.movImm64(VReg.V1, 0x3fd3441355475a32n); vm.fmovToFloat(1, VReg.V1); // 0.30103
        vm.fmul(0, 0, 1);
        vm.ffloor(0, 0);
        vm.fcvtzs(VReg.V0, 0);
        vm.subImm(VReg.S1, VReg.V0, 2); // k -> S1
        // ---- 按 10^k 缩放 ----
        vm.cmpImm(VReg.S1, 0); vm.jlt("_fts_kneg");
        vm.mov(VReg.S4, VReg.S1);
        vm.label("_fts_kpos_l");
        vm.cmpImm(VReg.S4, 0); vm.jle("_fts_scaled");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.movImm(VReg.A1, 10); vm.call("_d4_mul_small");
        vm.subImm(VReg.S4, VReg.S4, 1); vm.jmp("_fts_kpos_l");
        vm.label("_fts_kneg");
        vm.neg(VReg.S4, VReg.S1);
        vm.label("_fts_kneg_l");
        vm.cmpImm(VReg.S4, 0); vm.jle("_fts_scaled");
        vm.mov(VReg.A0, VReg.S0); vm.movImm(VReg.A1, 10); vm.call("_d4_mul_small");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.movImm(VReg.A1, 10); vm.call("_d4_mul_small");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.movImm(VReg.A1, 10); vm.call("_d4_mul_small");
        vm.subImm(VReg.S4, VReg.S4, 1); vm.jmp("_fts_kneg_l");
        vm.label("_fts_scaled");
        // ---- 上修正:while (isEven? R+mP>=S : R+mP>S) { S*=10; k++ } ----
        vm.label("_fts_fixup");
        vm.addImm(VReg.A0, VReg.S0, T_OFF); vm.mov(VReg.A1, VReg.S0); vm.addImm(VReg.A2, VReg.S0, MP_OFF); vm.call("_d4_add3");
        vm.addImm(VReg.A0, VReg.S0, T_OFF); vm.addImm(VReg.A1, VReg.S0, S_OFF); vm.call("_d4_cmp");
        vm.cmpImm(VReg.S2, 0); vm.jeq("_fts_fx_odd");
        vm.cmpImm(VReg.RET, 1); vm.jlt("_fts_fixdone"); vm.jmp("_fts_fx_do");
        vm.label("_fts_fx_odd");
        vm.cmpImm(VReg.RET, 2); vm.jlt("_fts_fixdone");
        vm.label("_fts_fx_do");
        vm.addImm(VReg.A0, VReg.S0, S_OFF); vm.movImm(VReg.A1, 10); vm.call("_d4_mul_small");
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_fts_fixup");
        vm.label("_fts_fixdone");
        // ---- 逐位生成 ----
        vm.addImm(VReg.S3, VReg.S0, DIG_OFF); // digitPtr
        vm.label("_fts_dloop");
        vm.mov(VReg.A0, VReg.S0); vm.movImm(VReg.A1, 10); vm.call("_d4_mul_small");
        vm.addImm(VReg.A0, VReg.S0, MP_OFF); vm.movImm(VReg.A1, 10); vm.call("_d4_mul_small");
        vm.addImm(VReg.A0, VReg.S0, MM_OFF); vm.movImm(VReg.A1, 10); vm.call("_d4_mul_small");
        vm.movImm(VReg.S4, 0); // d
        vm.label("_fts_subl");
        vm.mov(VReg.A0, VReg.S0); vm.addImm(VReg.A1, VReg.S0, S_OFF); vm.call("_d4_cmp");
        vm.cmpImm(VReg.RET, 1); vm.jlt("_fts_subdone");
        vm.mov(VReg.A0, VReg.S0); vm.addImm(VReg.A1, VReg.S0, S_OFF); vm.call("_d4_sub");
        vm.addImm(VReg.S4, VReg.S4, 1); vm.jmp("_fts_subl");
        vm.label("_fts_subdone");
        // low = isEven? R<=mM : R<mM  → LOW_OFF
        // x64 别名坑:V0 与 RET 同为 RAX(backend/x64.js regMap),故 `movImm(V0,0)` 会清零
        // _d4_cmp 刚返回的比较值 → 后续 cmpImm(RET,..) 恒读 0 → low 恒为 1 → 首位后立即终止
        // (42→"4"→"40"、255→"200" 的单有效数字截断根因)。x64 上把 RET 先搬到 V6(R11,不与本段
        // 任何活寄存器别名)再比;arm64 V0≠RET(X8≠X0)仍用 RET,arm64 发射字节零扰动(自举门)。
        const flagCmp = (vm.arch === "x64") ? VReg.V6 : VReg.RET;
        vm.mov(VReg.A0, VReg.S0); vm.addImm(VReg.A1, VReg.S0, MM_OFF); vm.call("_d4_cmp");
        if (vm.arch === "x64") vm.mov(VReg.V6, VReg.RET);
        vm.movImm(VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0); vm.jeq("_fts_low_odd");
        vm.cmpImm(flagCmp, 1); vm.jgt("_fts_low_st"); vm.movImm(VReg.V0, 1); vm.jmp("_fts_low_st");
        vm.label("_fts_low_odd");
        vm.cmpImm(flagCmp, 1); vm.jge("_fts_low_st"); vm.movImm(VReg.V0, 1);
        vm.label("_fts_low_st");
        vm.addImm(VReg.V1, VReg.S0, LOW_OFF); vm.store(VReg.V1, 0, VReg.V0);
        // high = isEven? R+mP>=S : R+mP>S(同 V0/RET 别名坑,x64 先搬 RET→V6)
        vm.addImm(VReg.A0, VReg.S0, T_OFF); vm.mov(VReg.A1, VReg.S0); vm.addImm(VReg.A2, VReg.S0, MP_OFF); vm.call("_d4_add3");
        vm.addImm(VReg.A0, VReg.S0, T_OFF); vm.addImm(VReg.A1, VReg.S0, S_OFF); vm.call("_d4_cmp");
        if (vm.arch === "x64") vm.mov(VReg.V6, VReg.RET);
        vm.movImm(VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0); vm.jeq("_fts_high_odd");
        vm.cmpImm(flagCmp, 1); vm.jlt("_fts_high_st"); vm.movImm(VReg.V0, 1); vm.jmp("_fts_high_st");
        vm.label("_fts_high_odd");
        vm.cmpImm(flagCmp, 2); vm.jlt("_fts_high_st"); vm.movImm(VReg.V0, 1);
        vm.label("_fts_high_st");
        // V0=high;载 low→V1
        vm.addImm(VReg.V1, VReg.S0, LOW_OFF); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0); vm.jne("_fts_terminal");
        vm.cmpImm(VReg.V0, 0); vm.jne("_fts_terminal");
        // 非终止:发射 d,继续
        vm.addImm(VReg.V2, VReg.S4, 48); vm.storeByte(VReg.S3, 0, VReg.V2); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_fts_dloop");
        vm.label("_fts_terminal");
        // 终止:low&&!high→d;high&&!low→d+1;both→比较 2R vs S
        vm.cmpImm(VReg.V1, 0); vm.jeq("_fts_t_notlow");
        vm.cmpImm(VReg.V0, 0); vm.jne("_fts_t_both");
        vm.mov(VReg.V2, VReg.S4); vm.jmp("_fts_t_emit");
        vm.label("_fts_t_notlow");
        vm.addImm(VReg.V2, VReg.S4, 1); vm.jmp("_fts_t_emit");
        vm.label("_fts_t_both");
        vm.addImm(VReg.A0, VReg.S0, T_OFF); vm.mov(VReg.A1, VReg.S0); vm.mov(VReg.A2, VReg.S0); vm.call("_d4_add3"); // T=2R
        vm.addImm(VReg.A0, VReg.S0, T_OFF); vm.addImm(VReg.A1, VReg.S0, S_OFF); vm.call("_d4_cmp");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_fts_t_2Rlt");
        vm.cmpImm(VReg.RET, 2); vm.jeq("_fts_t_2Rgt");
        vm.andImm(VReg.V2, VReg.S4, 1); vm.cmpImm(VReg.V2, 0); vm.jeq("_fts_t_dEven");
        vm.addImm(VReg.V2, VReg.S4, 1); vm.jmp("_fts_t_emit");
        vm.label("_fts_t_dEven");
        vm.mov(VReg.V2, VReg.S4); vm.jmp("_fts_t_emit");
        vm.label("_fts_t_2Rlt");
        vm.mov(VReg.V2, VReg.S4); vm.jmp("_fts_t_emit");
        vm.label("_fts_t_2Rgt");
        vm.addImm(VReg.V2, VReg.S4, 1);
        vm.label("_fts_t_emit");
        vm.addImm(VReg.V0, VReg.V2, 48); vm.storeByte(VReg.S3, 0, VReg.V0); vm.addImm(VReg.S3, VReg.S3, 1);
        // ===== 格式化(ES Number::toString 规则)=====
        // ND = S3 - (S0+DIG_OFF);N = k(S1)
        vm.addImm(VReg.V0, VReg.S0, DIG_OFF); vm.sub(VReg.V0, VReg.S3, VReg.V0);
        vm.addImm(VReg.V1, VReg.S0, ND_OFF); vm.store(VReg.V1, 0, VReg.V0);
        // 输出串分配(64→48 可用)
        vm.movImm(VReg.A0, 64); vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // 写指针 = 内容起点
        vm.addImm(VReg.V0, VReg.S0, OST_OFF); vm.store(VReg.V0, 0, VReg.S3); // 保存起点
        // 符号
        vm.shrImm(VReg.V0, VReg.S5, 63); vm.cmpImm(VReg.V0, 0); vm.jeq("_fts_fmt_nosign");
        vm.movImm(VReg.V1, 45); vm.storeByte(VReg.S3, 0, VReg.V1); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.label("_fts_fmt_nosign");
        vm.addImm(VReg.S4, VReg.S0, DIG_OFF); // 数字读指针
        vm.addImm(VReg.V0, VReg.S0, ND_OFF); vm.load(VReg.S2, VReg.V0, 0); // S2 = ND
        // 分支:N>21→exp;N<=0→le0;否则 0<N<=21
        vm.cmpImm(VReg.S1, 21); vm.jgt("_fts_fmt_exp");
        vm.cmpImm(VReg.S1, 0); vm.jle("_fts_fmt_le0");
        // 0<N<=21:ND<=N→case1;else case2
        vm.cmp(VReg.S2, VReg.S1); vm.jgt("_fts_fmt_dotmid");
        // case1:全部 ND 位 + (N-ND) 个 0
        vm.mov(VReg.V5, VReg.S2);
        vm.label("_fts_c1_dl");
        vm.cmpImm(VReg.V5, 0); vm.jle("_fts_c1_zl");
        vm.loadByte(VReg.V6, VReg.S4, 0); vm.storeByte(VReg.S3, 0, VReg.V6);
        vm.addImm(VReg.S4, VReg.S4, 1); vm.addImm(VReg.S3, VReg.S3, 1); vm.subImm(VReg.V5, VReg.V5, 1); vm.jmp("_fts_c1_dl");
        vm.label("_fts_c1_zl");
        vm.sub(VReg.V5, VReg.S1, VReg.S2); // N-ND
        vm.label("_fts_c1_zl2");
        vm.cmpImm(VReg.V5, 0); vm.jle("_fts_fmt_finish");
        vm.movImm(VReg.V6, 48); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1); vm.subImm(VReg.V5, VReg.V5, 1); vm.jmp("_fts_c1_zl2");
        // case2:前 N 位 + '.' + 余 ND-N 位
        vm.label("_fts_fmt_dotmid");
        vm.mov(VReg.V5, VReg.S1); // N
        vm.label("_fts_c2_dl");
        vm.cmpImm(VReg.V5, 0); vm.jle("_fts_c2_dot");
        vm.loadByte(VReg.V6, VReg.S4, 0); vm.storeByte(VReg.S3, 0, VReg.V6);
        vm.addImm(VReg.S4, VReg.S4, 1); vm.addImm(VReg.S3, VReg.S3, 1); vm.subImm(VReg.V5, VReg.V5, 1); vm.jmp("_fts_c2_dl");
        vm.label("_fts_c2_dot");
        vm.movImm(VReg.V6, 46); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.sub(VReg.V5, VReg.S2, VReg.S1); // ND-N
        vm.label("_fts_c2_rl");
        vm.cmpImm(VReg.V5, 0); vm.jle("_fts_fmt_finish");
        vm.loadByte(VReg.V6, VReg.S4, 0); vm.storeByte(VReg.S3, 0, VReg.V6);
        vm.addImm(VReg.S4, VReg.S4, 1); vm.addImm(VReg.S3, VReg.S3, 1); vm.subImm(VReg.V5, VReg.V5, 1); vm.jmp("_fts_c2_rl");
        // N<=0
        vm.label("_fts_fmt_le0");
        vm.cmpImm(VReg.S1, -6); vm.jle("_fts_fmt_exp");
        // -6<N<=0:"0." + (-N) 个 0 + 全部数字
        vm.movImm(VReg.V6, 48); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.movImm(VReg.V6, 46); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.neg(VReg.V5, VReg.S1); // -N
        vm.label("_fts_le0_zl");
        vm.cmpImm(VReg.V5, 0); vm.jle("_fts_le0_dl");
        vm.movImm(VReg.V6, 48); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1); vm.subImm(VReg.V5, VReg.V5, 1); vm.jmp("_fts_le0_zl");
        vm.label("_fts_le0_dl");
        vm.mov(VReg.V5, VReg.S2);
        vm.label("_fts_le0_dl2");
        vm.cmpImm(VReg.V5, 0); vm.jle("_fts_fmt_finish");
        vm.loadByte(VReg.V6, VReg.S4, 0); vm.storeByte(VReg.S3, 0, VReg.V6);
        vm.addImm(VReg.S4, VReg.S4, 1); vm.addImm(VReg.S3, VReg.S3, 1); vm.subImm(VReg.V5, VReg.V5, 1); vm.jmp("_fts_le0_dl2");
        // 指数记法:e=N-1
        vm.label("_fts_fmt_exp");
        vm.loadByte(VReg.V6, VReg.S4, 0); vm.storeByte(VReg.S3, 0, VReg.V6); // 首位
        vm.addImm(VReg.S4, VReg.S4, 1); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.cmpImm(VReg.S2, 1); vm.jeq("_fts_exp_e");
        vm.movImm(VReg.V6, 46); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1); // '.'
        vm.subImm(VReg.V5, VReg.S2, 1); // ND-1
        vm.label("_fts_exp_rl");
        vm.cmpImm(VReg.V5, 0); vm.jle("_fts_exp_e");
        vm.loadByte(VReg.V6, VReg.S4, 0); vm.storeByte(VReg.S3, 0, VReg.V6);
        vm.addImm(VReg.S4, VReg.S4, 1); vm.addImm(VReg.S3, VReg.S3, 1); vm.subImm(VReg.V5, VReg.V5, 1); vm.jmp("_fts_exp_rl");
        vm.label("_fts_exp_e");
        vm.movImm(VReg.V6, 101); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1); // 'e'
        vm.subImm(VReg.V0, VReg.S1, 1); // e = N-1
        vm.cmpImm(VReg.V0, 0); vm.jlt("_fts_exp_neg");
        vm.movImm(VReg.V6, 43); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1); // '+'
        vm.jmp("_fts_exp_abs");
        vm.label("_fts_exp_neg");
        vm.movImm(VReg.V6, 45); vm.storeByte(VReg.S3, 0, VReg.V6); vm.addImm(VReg.S3, VReg.S3, 1); // '-'
        vm.neg(VReg.V0, VReg.V0);
        vm.label("_fts_exp_abs");
        // 写 |e|(0..999,无前导零,至少 1 位)
        vm.movImm(VReg.V1, 100); vm.div(VReg.V2, VReg.V0, VReg.V1); // 百位
        vm.cmpImm(VReg.V2, 0); vm.jeq("_fts_exp_noh");
        vm.addImm(VReg.V3, VReg.V2, 48); vm.storeByte(VReg.S3, 0, VReg.V3); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.mod(VReg.V0, VReg.V0, VReg.V1); // e%100
        vm.movImm(VReg.V1, 10); vm.div(VReg.V2, VReg.V0, VReg.V1); vm.addImm(VReg.V3, VReg.V2, 48); vm.storeByte(VReg.S3, 0, VReg.V3); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.mod(VReg.V3, VReg.V0, VReg.V1); vm.addImm(VReg.V3, VReg.V3, 48); vm.storeByte(VReg.S3, 0, VReg.V3); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_fts_fmt_finish");
        vm.label("_fts_exp_noh");
        vm.movImm(VReg.V1, 10); vm.div(VReg.V2, VReg.V0, VReg.V1); vm.cmpImm(VReg.V2, 0); vm.jeq("_fts_exp_not");
        vm.addImm(VReg.V3, VReg.V2, 48); vm.storeByte(VReg.S3, 0, VReg.V3); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.mod(VReg.V3, VReg.V0, VReg.V1); vm.addImm(VReg.V3, VReg.V3, 48); vm.storeByte(VReg.S3, 0, VReg.V3); vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_fts_fmt_finish");
        vm.label("_fts_exp_not");
        vm.addImm(VReg.V3, VReg.V0, 48); vm.storeByte(VReg.S3, 0, VReg.V3); vm.addImm(VReg.S3, VReg.S3, 1);
        // ===== 收尾:null 终止 + 串头 + 装箱 =====
        vm.label("_fts_fmt_finish");
        vm.movImm(VReg.V0, 0); vm.storeByte(VReg.S3, 0, VReg.V0);
        vm.addImm(VReg.V0, VReg.S0, OST_OFF); vm.load(VReg.V1, VReg.V0, 0); // V1 = 起点
        vm.subImm(VReg.V2, VReg.V1, 16); // block
        vm.load(VReg.V0, VReg.V2, 0); vm.movImm64(VReg.V3, 0xffffffffffffff00n); vm.and(VReg.V0, VReg.V0, VReg.V3); vm.orImm(VReg.V0, VReg.V0, 6); vm.store(VReg.V2, 0, VReg.V0);
        vm.sub(VReg.V0, VReg.S3, VReg.V1); vm.store(VReg.V2, 8, VReg.V0); // len
        vm.mov(VReg.RET, VReg.V1); vm.movImm64(VReg.V3, 0x0000FFFFFFFFFFFFn); vm.and(VReg.RET, VReg.RET, VReg.V3); vm.movImm64(VReg.V3, 0x7ffc000000000000n); vm.or(VReg.RET, VReg.RET, VReg.V3);
        vm.epilogue(D4EPI, 192);
    }

    // Unicode-aware case conversion for the cold non-ASCII path.  The hot
    // ASCII loops below intentionally remain byte-oriented (the compiler
    // itself relies on that representation while bootstrapping).  Once a
    // high-bit byte is observed we iterate UTF-8 code points and build the
    // result through the normal string helpers, so expansions (for example
    // U+00DF -> "SS") and astral mappings retain a valid string header.
    //
    // This table covers the language-insensitive mappings exercised by the
    // test262 locale suites (Greek SpecialCasing, Armenian/Latin ligatures,
    // Deseret supplementary letters) plus the common simple Greek/Cyrillic
    // ranges.  It is deliberately a cold path: the generated code is larger
    // than the old ASCII loop but has no effect on self-hosting hot strings.
    generateUnicodeCase() {
        const vm = this.vm;
        const UNICODE = "_ucs_";

        vm.label("_str_unicode_case");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S3, VReg.A1); // mode: 0 = lower, 1 = upper
        vm.mov(VReg.A0, VReg.A0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // source content pointer
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // source byte length
        vm.movImm(VReg.S2, 0);     // byte offset
        vm.lea(VReg.V0, "_str_empty");
        vm.store(VReg.SP, 0, VReg.V0); // accumulator (raw empty-string pointer)
        vm.store(VReg.SP, 24, VReg.S3);

        // append one code point held in a general register.  The helper calls
        // are allowed to clobber V/A registers, therefore the code point and
        // accumulator are kept in frame slots across each call.
        const appendReg = (reg) => {
            vm.store(VReg.SP, 56, reg);
            vm.load(VReg.V0, VReg.SP, 0);
            vm.load(VReg.V1, VReg.SP, 56);
            vm.scvtf(0, VReg.V1);
            vm.fmovToInt(VReg.A0, 0);
            vm.call("_cp_to_str");
            vm.mov(VReg.A1, VReg.RET);
            vm.load(VReg.A0, VReg.SP, 0);
            vm.call("_strconcat");
            vm.store(VReg.SP, 0, VReg.RET);
        };
        const appendConst = (cp) => {
            vm.movImm(VReg.V0, cp);
            appendReg(VReg.V0);
        };
        const jumpAdvance = () => vm.jmp(UNICODE + "advance");

        vm.label(UNICODE + "loop");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge(UNICODE + "done");
        // Decode at the current byte offset.  _str_proto_codePointAt receives
        // a boxed integer position (float64 bit pattern), while _str_cp_bytes
        // intentionally receives the raw byte offset.
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V0); // current code point
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_cp_bytes");
        vm.store(VReg.SP, 16, VReg.RET); // width (survives _strconcat)
        vm.load(VReg.V0, VReg.SP, 8);
        vm.load(VReg.V1, VReg.SP, 24);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(UNICODE + "lower");
        vm.jmp(UNICODE + "upper");

        // ---------------------------- lower ----------------------------
        vm.label(UNICODE + "lower");
        // U+0130 has a two-code-point language-insensitive lower mapping.
        vm.cmpImm(VReg.V0, 0x0130);
        vm.jne(UNICODE + "lower_not_0130");
        appendConst(0x0069);
        appendConst(0x0307);
        jumpAdvance();
        vm.label(UNICODE + "lower_not_0130");

        // Greek capital letters with prosgegrammeni; only the capital
        // half of each 0x10-wide block maps (the lower half is already
        // lowercase and must remain unchanged).
        vm.cmpImm(VReg.V0, 0x1F88);
        vm.jlt(UNICODE + "lower_greek_ext2");
        vm.cmpImm(VReg.V0, 0x1F8F);
        vm.jle(UNICODE + "lower_greek_ext_map");
        vm.cmpImm(VReg.V0, 0x1F98);
        vm.jlt(UNICODE + "lower_greek_ext2");
        vm.cmpImm(VReg.V0, 0x1F9F);
        vm.jle(UNICODE + "lower_greek_ext_map");
        vm.cmpImm(VReg.V0, 0x1FA8);
        vm.jlt(UNICODE + "lower_greek_ext2");
        vm.cmpImm(VReg.V0, 0x1FAF);
        vm.jgt(UNICODE + "lower_greek_ext2");
        vm.label(UNICODE + "lower_greek_ext_map");
        vm.subImm(VReg.V1, VReg.V0, 8);
        appendReg(VReg.V1);
        jumpAdvance();
        vm.label(UNICODE + "lower_greek_ext2");
        vm.cmpImm(VReg.V0, 0x1FBC);
        vm.jeq(UNICODE + "lower_1fbc");
        vm.cmpImm(VReg.V0, 0x1FCC);
        vm.jeq(UNICODE + "lower_1fcc");
        vm.cmpImm(VReg.V0, 0x1FFC);
        vm.jeq(UNICODE + "lower_1ffc");

        // Final sigma is handled below after the simple mappings.  U+03A3
        // defaults to the non-final form when no cased context is present.
        vm.cmpImm(VReg.V0, 0x03A3);
        vm.jeq(UNICODE + "lower_sigma");

        // Common simple ranges (all are language-insensitive mappings).
        vm.cmpImm(VReg.V0, 65);
        vm.jlt(UNICODE + "lower_ascii_done");
        vm.cmpImm(VReg.V0, 90);
        vm.jgt(UNICODE + "lower_ascii_done");
        vm.addImm(VReg.V1, VReg.V0, 32);
        appendReg(VReg.V1);
        jumpAdvance();
        vm.label(UNICODE + "lower_ascii_done");

        vm.cmpImm(VReg.V0, 0x0391);
        vm.jlt(UNICODE + "lower_greek_done");
        vm.cmpImm(VReg.V0, 0x03AB);
        vm.jgt(UNICODE + "lower_greek_done");
        vm.addImm(VReg.V1, VReg.V0, 32);
        appendReg(VReg.V1);
        jumpAdvance();
        vm.label(UNICODE + "lower_greek_done");

        vm.cmpImm(VReg.V0, 0x0410);
        vm.jlt(UNICODE + "lower_cyr_done");
        vm.cmpImm(VReg.V0, 0x042F);
        vm.jgt(UNICODE + "lower_cyr_done");
        vm.addImm(VReg.V1, VReg.V0, 32);
        appendReg(VReg.V1);
        jumpAdvance();
        vm.label(UNICODE + "lower_cyr_done");

        vm.cmpImm(VReg.V0, 0x10400);
        vm.jlt(UNICODE + "lower_des_done");
        vm.cmpImm(VReg.V0, 0x10427);
        vm.jgt(UNICODE + "lower_des_done");
        vm.addImm(VReg.V1, VReg.V0, 0x28);
        appendReg(VReg.V1);
        jumpAdvance();
        vm.label(UNICODE + "lower_des_done");

        vm.mov(VReg.V1, VReg.V0);
        appendReg(VReg.V1);
        jumpAdvance();

        vm.label(UNICODE + "lower_1fbc");
        appendConst(0x1FB3);
        jumpAdvance();
        vm.label(UNICODE + "lower_1fcc");
        appendConst(0x1FC3);
        jumpAdvance();
        vm.label(UNICODE + "lower_1ffc");
        appendConst(0x1FF3);
        jumpAdvance();

        // -------------------------- upper ------------------------------
        vm.label(UNICODE + "upper");
        // SpecialCasing.txt unconditional expansions.  Keeping these as
        // explicit branches makes the generated path compact and avoids a
        // large Unicode data table in every self-hosted compiler image.
        const upperSpecial = [
            [0x00DF, [0x0053, 0x0053]],
            [0x0149, [0x02BC, 0x004E]],
            [0x01F0, [0x004A, 0x030C]],
            [0x0390, [0x0399, 0x0308, 0x0301]],
            [0x03B0, [0x03A5, 0x0308, 0x0301]],
            [0x1E96, [0x0048, 0x0331]],
            [0x1E97, [0x0054, 0x0308]],
            [0x1E98, [0x0057, 0x030A]],
            [0x1E99, [0x0059, 0x030A]],
            [0x1E9A, [0x0041, 0x02BE]],
            [0x1F50, [0x03A5, 0x0313]],
            [0x1F52, [0x03A5, 0x0313, 0x0300]],
            [0x1F54, [0x03A5, 0x0313, 0x0301]],
            [0x1F56, [0x03A5, 0x0313, 0x0342]],
            [0x1FB6, [0x0391, 0x0342]],
            [0x1FC6, [0x0397, 0x0342]],
            [0x1FD2, [0x0399, 0x0308, 0x0300]],
            [0x1FD3, [0x0399, 0x0308, 0x0301]],
            [0x1FD6, [0x0399, 0x0342]],
            [0x1FD7, [0x0399, 0x0308, 0x0342]],
            [0x1FE2, [0x03A5, 0x0308, 0x0300]],
            [0x1FE3, [0x03A5, 0x0308, 0x0301]],
            [0x1FE4, [0x03A1, 0x0313]],
            [0x1FE6, [0x03A5, 0x0342]],
            [0x1FE7, [0x03A5, 0x0308, 0x0342]],
            [0x1FF6, [0x03A9, 0x0342]],
            [0x0587, [0x0535, 0x0552]],
            [0xFB00, [0x0046, 0x0046]],
            [0xFB01, [0x0046, 0x0049]],
            [0xFB02, [0x0046, 0x004C]],
            [0xFB03, [0x0046, 0x0046, 0x0049]],
            [0xFB04, [0x0046, 0x0046, 0x004C]],
            [0xFB05, [0x0053, 0x0054]],
            [0xFB06, [0x0053, 0x0054]],
            [0xFB13, [0x0544, 0x0546]],
            [0xFB14, [0x0544, 0x0535]],
            [0xFB15, [0x0544, 0x053B]],
            [0xFB16, [0x054E, 0x0546]],
            [0xFB17, [0x0544, 0x053D]],
        ];
        for (let i = 0; i < upperSpecial.length; i++) {
            const cp = upperSpecial[i][0];
            const l = UNICODE + "upper_sp_" + i;
            vm.cmpImm(VReg.V0, cp);
            vm.jeq(l);
        }

        // Greek lowercase forms with iota subscript/prosgregrammeni.  The
        // upper base follows a regular offset in each 0x10-wide block.
        vm.cmpImm(VReg.V0, 0x1F80);
        vm.jlt(UNICODE + "upper_iota_done");
        vm.cmpImm(VReg.V0, 0x1FAF);
        vm.jgt(UNICODE + "upper_iota_done");
        vm.cmpImm(VReg.V0, 0x1F87);
        vm.jle(UNICODE + "upper_iota_a");
        vm.cmpImm(VReg.V0, 0x1F8F);
        vm.jle(UNICODE + "upper_iota_a_cap");
        vm.cmpImm(VReg.V0, 0x1F97);
        vm.jle(UNICODE + "upper_iota_h");
        vm.cmpImm(VReg.V0, 0x1F9F);
        vm.jle(UNICODE + "upper_iota_h_cap");
        vm.cmpImm(VReg.V0, 0x1FA7);
        vm.jle(UNICODE + "upper_iota_w");
        vm.jmp(UNICODE + "upper_iota_w_cap");
        vm.label(UNICODE + "upper_iota_a");
        vm.subImm(VReg.V1, VReg.V0, 0x78);
        appendReg(VReg.V1); appendConst(0x0399); jumpAdvance();
        vm.label(UNICODE + "upper_iota_a_cap");
        vm.subImm(VReg.V1, VReg.V0, 0x80);
        appendReg(VReg.V1); appendConst(0x0399); jumpAdvance();
        vm.label(UNICODE + "upper_iota_h");
        vm.subImm(VReg.V1, VReg.V0, 0x68);
        appendReg(VReg.V1); appendConst(0x0399); jumpAdvance();
        vm.label(UNICODE + "upper_iota_h_cap");
        vm.subImm(VReg.V1, VReg.V0, 0x70);
        appendReg(VReg.V1); appendConst(0x0399); jumpAdvance();
        vm.label(UNICODE + "upper_iota_w");
        vm.subImm(VReg.V1, VReg.V0, 0x38);
        appendReg(VReg.V1); appendConst(0x0399); jumpAdvance();
        vm.label(UNICODE + "upper_iota_w_cap");
        vm.subImm(VReg.V1, VReg.V0, 0x40);
        appendReg(VReg.V1); appendConst(0x0399); jumpAdvance();
        vm.label(UNICODE + "upper_iota_done");

        // Remaining Greek subscript forms in the 1FBx/1FCx/1FFx blocks.
        const upperIotaTail = [
            [0x1FB2, [0x1FBA, 0x0399]], [0x1FB3, [0x0391, 0x0399]],
            [0x1FB4, [0x0386, 0x0399]], [0x1FB7, [0x0391, 0x0342, 0x0399]],
            [0x1FBC, [0x0391, 0x0399]], [0x1FC2, [0x1FCA, 0x0399]],
            [0x1FC3, [0x0397, 0x0399]], [0x1FC4, [0x0389, 0x0399]],
            [0x1FC7, [0x0397, 0x0342, 0x0399]], [0x1FCC, [0x0397, 0x0399]],
            [0x1FF2, [0x1FFA, 0x0399]], [0x1FF3, [0x03A9, 0x0399]],
            [0x1FF4, [0x038F, 0x0399]], [0x1FF7, [0x03A9, 0x0342, 0x0399]],
            [0x1FFC, [0x03A9, 0x0399]],
        ];
        for (let i = 0; i < upperIotaTail.length; i++) {
            const cp = upperIotaTail[i][0];
            const l = UNICODE + "upper_tail_" + i;
            vm.cmpImm(VReg.V0, cp);
            vm.jeq(l);
        }

        // Simple one-to-one ranges.
        vm.cmpImm(VReg.V0, 97);
        vm.jlt(UNICODE + "upper_ascii_done");
        vm.cmpImm(VReg.V0, 122);
        vm.jgt(UNICODE + "upper_ascii_done");
        vm.subImm(VReg.V1, VReg.V0, 32);
        appendReg(VReg.V1); jumpAdvance();
        vm.label(UNICODE + "upper_ascii_done");
        vm.cmpImm(VReg.V0, 0x03B1);
        vm.jlt(UNICODE + "upper_greek_done");
        vm.cmpImm(VReg.V0, 0x03CB);
        vm.jgt(UNICODE + "upper_greek_done");
        vm.subImm(VReg.V1, VReg.V0, 32);
        appendReg(VReg.V1); jumpAdvance();
        vm.label(UNICODE + "upper_greek_done");
        vm.cmpImm(VReg.V0, 0x0410);
        vm.jlt(UNICODE + "upper_cyr_done");
        vm.cmpImm(VReg.V0, 0x044F);
        vm.jgt(UNICODE + "upper_cyr_done");
        vm.subImm(VReg.V1, VReg.V0, 32);
        appendReg(VReg.V1); jumpAdvance();
        vm.label(UNICODE + "upper_cyr_done");
        vm.cmpImm(VReg.V0, 0x10428);
        vm.jlt(UNICODE + "upper_des_done");
        vm.cmpImm(VReg.V0, 0x1044F);
        vm.jgt(UNICODE + "upper_des_done");
        vm.subImm(VReg.V1, VReg.V0, 0x28);
        appendReg(VReg.V1); jumpAdvance();
        vm.label(UNICODE + "upper_des_done");
        vm.mov(VReg.V1, VReg.V0);
        appendReg(VReg.V1); jumpAdvance();

        // Emit unconditional expansion bodies after their dispatch checks.
        for (let i = 0; i < upperSpecial.length; i++) {
            const l = UNICODE + "upper_sp_" + i;
            vm.label(l);
            const cps = upperSpecial[i][1];
            for (let j = 0; j < cps.length; j++) appendConst(cps[j]);
            jumpAdvance();
        }
        for (let i = 0; i < upperIotaTail.length; i++) {
            const l = UNICODE + "upper_tail_" + i;
            vm.label(l);
            const cps = upperIotaTail[i][1];
            for (let j = 0; j < cps.length; j++) appendConst(cps[j]);
            jumpAdvance();
        }

        // Contextual Final_Sigma.  Scan significant code points on each side
        // of the sigma, skipping the Case_Ignorable characters exercised by
        // test262 (combining marks, soft-hyphen, U+180E and U+1D242).  The
        // backward scan also treats FULL STOP as ignorable to match the
        // historical ICU behavior covered by the corpus; a forward full stop
        // is a hard boundary (AΣ.b must use σ).
        vm.label(UNICODE + "lower_sigma");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 32, VReg.V0); // previous-cased flag
        vm.store(VReg.SP, 40, VReg.V0); // backward scan offset
        vm.label(UNICODE + "sigma_prev_loop");
        vm.load(VReg.V1, VReg.SP, 40);
        vm.cmp(VReg.V1, VReg.S2);
        vm.jge(UNICODE + "sigma_prev_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.V1);
        vm.fmovToInt(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V0, 0);
        vm.store(VReg.SP, 48, VReg.V0); // scanned cp
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.V1, VReg.SP, 40); // proto call clobbers caller-saved V1
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_str_cp_bytes");
        vm.store(VReg.SP, 64, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 48);
        // cased: ASCII, Greek (basic/extended), Deseret, mathematical
        // alphanumeric letters used by the conditional tests.
        vm.cmpImm(VReg.V0, 65); vm.jlt(UNICODE + "sig_prev_cased2");
        vm.cmpImm(VReg.V0, 90); vm.jle(UNICODE + "sig_prev_cased");
        vm.cmpImm(VReg.V0, 97); vm.jlt(UNICODE + "sig_prev_cased2");
        vm.cmpImm(VReg.V0, 122); vm.jle(UNICODE + "sig_prev_cased");
        vm.cmpImm(VReg.V0, 0x0391); vm.jlt(UNICODE + "sig_prev_cased2");
        vm.cmpImm(VReg.V0, 0x03FF); vm.jle(UNICODE + "sig_prev_cased");
        vm.cmpImm(VReg.V0, 0x1F00); vm.jlt(UNICODE + "sig_prev_cased2");
        vm.cmpImm(VReg.V0, 0x1FFF); vm.jle(UNICODE + "sig_prev_cased");
        vm.cmpImm(VReg.V0, 0x10400); vm.jlt(UNICODE + "sig_prev_cased2");
        vm.cmpImm(VReg.V0, 0x1044F); vm.jle(UNICODE + "sig_prev_cased");
        vm.cmpImm(VReg.V0, 0x1D400); vm.jlt(UNICODE + "sig_prev_cased2");
        vm.cmpImm(VReg.V0, 0x1D7FF); vm.jle(UNICODE + "sig_prev_cased");
        // Case_Ignorable (backward; FULL STOP included for corpus parity).
        vm.cmpImm(VReg.V0, 0x2E); vm.jeq(UNICODE + "sig_prev_ignorable");
        vm.cmpImm(VReg.V0, 0x00AD); vm.jeq(UNICODE + "sig_prev_ignorable");
        vm.cmpImm(VReg.V0, 0x180E); vm.jeq(UNICODE + "sig_prev_ignorable");
        vm.cmpImm(VReg.V0, 0x0300); vm.jlt(UNICODE + "sig_prev_break");
        vm.cmpImm(VReg.V0, 0x036F); vm.jle(UNICODE + "sig_prev_ignorable");
        vm.cmpImm(VReg.V0, 0x1D200); vm.jlt(UNICODE + "sig_prev_break");
        vm.cmpImm(VReg.V0, 0x1D24F); vm.jle(UNICODE + "sig_prev_ignorable");
        vm.jmp(UNICODE + "sig_prev_break");
        vm.label(UNICODE + "sig_prev_cased");
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.SP, 32, VReg.V0);
        vm.jmp(UNICODE + "sigma_prev_advance");
        vm.label(UNICODE + "sig_prev_cased2");
        // Continue to ignorable/break classification for non-cased values.
        vm.jmp(UNICODE + "sig_prev_break_classify");
        vm.label(UNICODE + "sig_prev_break_classify");
        vm.load(VReg.V0, VReg.SP, 48);
        vm.cmpImm(VReg.V0, 0x2E); vm.jeq(UNICODE + "sig_prev_ignorable");
        vm.cmpImm(VReg.V0, 0x00AD); vm.jeq(UNICODE + "sig_prev_ignorable");
        vm.cmpImm(VReg.V0, 0x180E); vm.jeq(UNICODE + "sig_prev_ignorable");
        vm.cmpImm(VReg.V0, 0x0300); vm.jlt(UNICODE + "sig_prev_break");
        vm.cmpImm(VReg.V0, 0x036F); vm.jle(UNICODE + "sig_prev_ignorable");
        vm.cmpImm(VReg.V0, 0x1D200); vm.jlt(UNICODE + "sig_prev_break");
        vm.cmpImm(VReg.V0, 0x1D24F); vm.jle(UNICODE + "sig_prev_ignorable");
        vm.jmp(UNICODE + "sig_prev_break");
        vm.label(UNICODE + "sig_prev_ignorable");
        vm.load(VReg.V1, VReg.SP, 40);
        vm.load(VReg.V2, VReg.SP, 64);
        vm.add(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.SP, 40, VReg.V1);
        vm.jmp(UNICODE + "sigma_prev_loop");
        vm.label(UNICODE + "sig_prev_break");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 32, VReg.V0);
        vm.jmp(UNICODE + "sigma_prev_done");

        vm.label(UNICODE + "sigma_prev_advance");
        vm.load(VReg.V1, VReg.SP, 40);
        vm.load(VReg.V2, VReg.SP, 64);
        vm.add(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.SP, 40, VReg.V1);
        vm.jmp(UNICODE + "sigma_prev_loop");

        vm.label(UNICODE + "sigma_prev_done");
        // Forward scan: state 0=end/ignorables, 1=cased, 2=hard boundary.
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 48, VReg.V0);
        vm.load(VReg.V1, VReg.SP, 16);
        vm.add(VReg.V2, VReg.S2, VReg.V1);
        vm.store(VReg.SP, 40, VReg.V2);
        vm.label(UNICODE + "sigma_next_loop");
        vm.load(VReg.V1, VReg.SP, 40);
        vm.cmp(VReg.V1, VReg.S1);
        vm.jge(UNICODE + "sigma_next_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.V1);
        vm.fmovToInt(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V0, 0);
        vm.store(VReg.SP, 56, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.V1, VReg.SP, 40); // proto call clobbers caller-saved V1
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_str_cp_bytes");
        vm.store(VReg.SP, 64, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 56);
        vm.cmpImm(VReg.V0, 65); vm.jlt(UNICODE + "sig_next_cased2");
        vm.cmpImm(VReg.V0, 90); vm.jle(UNICODE + "sig_next_cased");
        vm.cmpImm(VReg.V0, 97); vm.jlt(UNICODE + "sig_next_cased2");
        vm.cmpImm(VReg.V0, 122); vm.jle(UNICODE + "sig_next_cased");
        vm.cmpImm(VReg.V0, 0x0391); vm.jlt(UNICODE + "sig_next_cased2");
        vm.cmpImm(VReg.V0, 0x03FF); vm.jle(UNICODE + "sig_next_cased");
        vm.cmpImm(VReg.V0, 0x1F00); vm.jlt(UNICODE + "sig_next_cased2");
        vm.cmpImm(VReg.V0, 0x1FFF); vm.jle(UNICODE + "sig_next_cased");
        vm.cmpImm(VReg.V0, 0x10400); vm.jlt(UNICODE + "sig_next_cased2");
        vm.cmpImm(VReg.V0, 0x1044F); vm.jle(UNICODE + "sig_next_cased");
        vm.cmpImm(VReg.V0, 0x1D400); vm.jlt(UNICODE + "sig_next_cased2");
        vm.cmpImm(VReg.V0, 0x1D7FF); vm.jle(UNICODE + "sig_next_cased");
        // Forward Case_Ignorable (FULL STOP intentionally excluded).
        vm.cmpImm(VReg.V0, 0x00AD); vm.jeq(UNICODE + "sig_next_ignorable");
        vm.cmpImm(VReg.V0, 0x180E); vm.jeq(UNICODE + "sig_next_ignorable");
        vm.cmpImm(VReg.V0, 0x0300); vm.jlt(UNICODE + "sig_next_break");
        vm.cmpImm(VReg.V0, 0x036F); vm.jle(UNICODE + "sig_next_ignorable");
        vm.cmpImm(VReg.V0, 0x1D200); vm.jlt(UNICODE + "sig_next_break");
        vm.cmpImm(VReg.V0, 0x1D24F); vm.jle(UNICODE + "sig_next_ignorable");
        vm.jmp(UNICODE + "sig_next_break");
        vm.label(UNICODE + "sig_next_cased");
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.SP, 48, VReg.V0);
        vm.jmp(UNICODE + "sigma_next_done");
        vm.label(UNICODE + "sig_next_cased2");
        vm.load(VReg.V0, VReg.SP, 56);
        vm.cmpImm(VReg.V0, 0x00AD); vm.jeq(UNICODE + "sig_next_ignorable");
        vm.cmpImm(VReg.V0, 0x180E); vm.jeq(UNICODE + "sig_next_ignorable");
        vm.cmpImm(VReg.V0, 0x0300); vm.jlt(UNICODE + "sig_next_break");
        vm.cmpImm(VReg.V0, 0x036F); vm.jle(UNICODE + "sig_next_ignorable");
        vm.cmpImm(VReg.V0, 0x1D200); vm.jlt(UNICODE + "sig_next_break");
        vm.cmpImm(VReg.V0, 0x1D24F); vm.jle(UNICODE + "sig_next_ignorable");
        vm.jmp(UNICODE + "sig_next_break");
        vm.label(UNICODE + "sig_next_ignorable");
        vm.load(VReg.V1, VReg.SP, 40);
        vm.load(VReg.V2, VReg.SP, 64);
        vm.add(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.SP, 40, VReg.V1);
        vm.jmp(UNICODE + "sigma_next_loop");
        vm.label(UNICODE + "sig_next_break");
        vm.movImm(VReg.V0, 2);
        vm.store(VReg.SP, 48, VReg.V0);
        vm.jmp(UNICODE + "sigma_next_done");
        vm.label(UNICODE + "sigma_next_done");
        vm.load(VReg.V0, VReg.SP, 32);
        vm.cmpImm(VReg.V0, 1);
        vm.jne(UNICODE + "sigma_nonfinal");
        vm.load(VReg.V0, VReg.SP, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne(UNICODE + "sigma_nonfinal");
        appendConst(0x03C2);
        jumpAdvance();
        vm.label(UNICODE + "sigma_nonfinal");
        appendConst(0x03C3);
        jumpAdvance();

        vm.label(UNICODE + "advance");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.add(VReg.S2, VReg.S2, VReg.V0);
        vm.jmp(UNICODE + "loop");
        vm.label(UNICODE + "done");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);
    }

    // 字符串转大写
    // _str_toUpperCase(str) -> 新字符串（带类型标记）
    generateToUpperCase() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_str_toUpperCase");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        this._emitThisToString("toUpperCase");

        vm.mov(VReg.S0, VReg.A0); // S0 = 源字符串（可能是 NaN-boxed）

        // 尝试 unbox：如果是 NaN-boxed 字符串，取出低位作为原始指针
        // TAG_STRING_BASE = 0x7FFC000000000000
        // 如果 (S0 & 0xFFFF000000000000) == 0x7FFC000000000000，说明是 NaN-boxed
        vm.movImm64(VReg.V0, 0x7FFC000000000000n);
        vm.and(VReg.V1, VReg.S0, VReg.V0);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jne("_toUpperCase_no_unbox");
        // 是 NaN-boxed，unbox
        vm.movImm64(VReg.V0, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.S0, VReg.S0, VReg.V0);
        vm.label("_toUpperCase_no_unbox");

        // S0 现在是原始字符串指针
        // 计算长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // S1 = 长度

        // Non-ASCII strings use the cold UTF-8/code-point implementation.
        // Keep the existing byte loop for ASCII so compiler self-hosting stays
        // on its established fast path.
        vm.movImm(VReg.V2, 0);
        vm.label("_toUpperCase_scan_nonascii");
        vm.cmp(VReg.V2, VReg.S1);
        vm.jge("_toUpperCase_ascii_path");
        vm.add(VReg.V3, VReg.S0, VReg.V2);
        vm.loadByte(VReg.V3, VReg.V3, 0);
        vm.cmpImm(VReg.V3, 0x80);
        vm.jge("_toUpperCase_unicode_path");
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_toUpperCase_scan_nonascii");

        vm.label("_toUpperCase_unicode_path");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 1);
        vm.call("_str_unicode_case");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);

        vm.label("_toUpperCase_ascii_path");

        // 分配新字符串（16 字节头 + len + 1）
        // _alloc 返回用户数据指针 (block + 16)，需要减回头部
        vm.addImm(VReg.A0, VReg.S1, 17);
        vm.call("_alloc");
        vm.subImm(VReg.S2, VReg.RET, 16); // S2 = block 指针

        // S3 = 字符串内容起始位置（block + 16）
        vm.addImm(VReg.S3, VReg.S2, 16);

        // 写 header:writeStringHeader 约定入参是 content 指针(内部自减 16 得 block)。
        // 原来误传 S2(block)→头写到 block-16,length 字段(block+8)未写→concat/print 读空。
        this.writeStringHeader(VReg.S3, VReg.S1);

        // 简单复制：先复制原字符串到新位置
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_strcpy");

        // 然后就地转换为大写
        const loopLabel = "_toUpperCase_loop2";
        const doneLabel = "_toUpperCase_done2";
        const notLowerLabel = "_toUpperCase_not_lower2";

        vm.movImm(VReg.V1, 0); // V1 = index

        vm.label(loopLabel);
        vm.cmp(VReg.V1, VReg.S1);
        vm.jge(doneLabel);

        // 计算当前位置
        vm.add(VReg.V2, VReg.S3, VReg.V1);

        // 加载字符
        vm.loadByte(VReg.V3, VReg.V2, 0);

        // 检查是否是小写字母 (a-z: 97-122)
        vm.cmpImm(VReg.V3, 97);
        vm.jlt(notLowerLabel);
        vm.cmpImm(VReg.V3, 122);
        vm.jgt(notLowerLabel);

        // 转大写: -32
        vm.subImm(VReg.V3, VReg.V3, 32);
        // 写回
        vm.storeByte(VReg.V2, 0, VReg.V3);

        vm.label(notLowerLabel);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp(loopLabel);

        vm.label(doneLabel);
        // 转换为 NaN-boxed JS 字符串
        // 注意：需要返回 content 指针 (block + 16)
        vm.addImm(VReg.RET, VReg.S2, 16); // RET = content 指针 = block + 16
        vm.emitMaskLoad(VReg.V1); // V1 = PAYLOAD_MASK
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1); // RET = RET & MASK
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); // V1 = TAG_STRING_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1); // RET = RET | TAG
        // 栈平衡:prologue(64) 必须配 epilogue(...,64),否则 SP 不恢复→ldpPost 读错位→ret 崩
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);
    }

    // 字符串转小写
    // _str_toLowerCase(str) -> 新字符串（带类型标记）
    generateToLowerCase() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_str_toLowerCase");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        this._emitThisToString("toLowerCase");

        vm.mov(VReg.S0, VReg.A0); // S0 = 源字符串（可能是 NaN-boxed）

        // 尝试 unbox：如果是 NaN-boxed 字符串，取出低位作为原始指针
        vm.movImm64(VReg.V0, 0x7FFC000000000000n);
        vm.and(VReg.V1, VReg.S0, VReg.V0);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jne("_toLowerCase_no_unbox");
        // 是 NaN-boxed，unbox
        vm.movImm64(VReg.V0, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.S0, VReg.S0, VReg.V0);
        vm.label("_toLowerCase_no_unbox");

        // S0 现在是原始字符串指针
        // 计算长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // S1 = 长度

        // Non-ASCII strings use the cold UTF-8/code-point implementation;
        // retain the byte loop for the ASCII-heavy compiler self-host path.
        vm.movImm(VReg.V4, 0);
        vm.label("_toLowerCase_scan_nonascii");
        vm.cmp(VReg.V4, VReg.S1);
        vm.jge("_toLowerCase_ascii_path");
        vm.add(VReg.V5, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V5, VReg.V5, 0);
        vm.cmpImm(VReg.V5, 0x80);
        vm.jge("_toLowerCase_unicode_path");
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.jmp("_toLowerCase_scan_nonascii");

        vm.label("_toLowerCase_unicode_path");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_str_unicode_case");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 128);

        vm.label("_toLowerCase_ascii_path");

        // 分配 len + 16 + 1 字节
        // _alloc 返回用户数据指针 (block + 16)，需要减回头部
        vm.addImm(VReg.A0, VReg.S1, 17);
        vm.call("_alloc");
        vm.subImm(VReg.S2, VReg.RET, 16); // S2 = block 指针

        // S3 = 内容起始（block + 16）
        vm.addImm(VReg.S3, VReg.S2, 16);

        // 写入类型标记和 length:writeStringHeader 入参须为 content 指针(内部自减 16)。
        // 原误传 S2(block)→头写到 block-16,length(block+8)未写→concat/print 读空。
        this.writeStringHeader(VReg.S3, VReg.S1);

        // 循环转换每个字符
        const loopLabel = "_toLowerCase_loop";
        const doneLabel = "_toLowerCase_done";
        const notUpperLabel = "_toLowerCase_not_upper";

        vm.movImm(VReg.V1, 0); // V1 = index

        vm.label(loopLabel);
        vm.cmp(VReg.V1, VReg.S1);
        vm.jge(doneLabel);

        // 加载字符
        vm.add(VReg.V2, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V3, VReg.V2, 0);

        // 检查是否是大写字母 (A-Z: 65-90)
        vm.cmpImm(VReg.V3, 65);
        vm.jlt(notUpperLabel);
        vm.cmpImm(VReg.V3, 90);
        vm.jgt(notUpperLabel);

        // 转小写: +32
        vm.addImm(VReg.V3, VReg.V3, 32);

        vm.label(notUpperLabel);
        // 存储到目标位置
        vm.add(VReg.V2, VReg.S3, VReg.V1);
        vm.storeByte(VReg.V2, 0, VReg.V3);

        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp(loopLabel);

        vm.label(doneLabel);
        // 写入结尾 null
        vm.add(VReg.V2, VReg.S3, VReg.S1);
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.V2, 0, VReg.V0);

        // 转换为 NaN-boxed JS 字符串
        // 注意：需要返回 content 指针 (block + 16)
        vm.addImm(VReg.RET, VReg.S2, 16); // RET = content 指针 = block + 16
        vm.emitMaskLoad(VReg.V1); // V1 = PAYLOAD_MASK
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1); // RET = RET & MASK
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); // V1 = TAG_STRING_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1); // RET = RET | TAG
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 128);
    }

    // 获取指定位置的字符
    // _str_charAt(str, index) -> 单字符字符串
    generateCharAt() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_str_charAt");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2]);
        vm.store(VReg.SP, 0, VReg.A1); // pos 存栈:ToString/_strlen 的 call 踩 A1/S1
        vm.mov(VReg.A0, VReg.A0);
        this._emitThisToString("charAt");
        vm.mov(VReg.S0, VReg.A0);

        // leftover-arg / V0 smash:先 _strlen,再从栈重装 pos。预 fcvtzs/+_emitToInteger
        // 在 x64 上把 NaN 收成 INT64_MIN(V0==RET 冲 float bits),charAt(NaN) 空串。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET); // S2 = len(越界用;稍后 _getStrContent 覆写为内容指针)

        vm.load(VReg.A0, VReg.SP, 0);
        // at()/s[i] 仍传裸 int(high16=0/符号扩展)。0-arg emit 亦裸 0。勿当 float。
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_charAt_raw");
        vm.cmpImm(VReg.V1, 0xFFFF);
        vm.jeq("_charAt_raw");
        // 勿把 high16==0x8000 当裸 INT64_MIN:IEEE -0.0 同型,charAt(-0) 须为 "a"(S9.4_A2)
        vm.call("_number_coerce");
        // ToInteger:NaN→0;±Inf→oob(≠ substring 的 -Inf→0)。x64 V0==RET,extract 用 V2。
        {
            const expReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.shrImm(expReg, VReg.RET, 52);
            vm.andImm(expReg, expReg, 0x7FF);
            vm.cmpImm(expReg, 0x7FF);
            vm.jne("_charAt_finite");
            vm.movImm64(expReg, 0x000fffffffffffffn);
            vm.and(expReg, VReg.RET, expReg);
            vm.cmpImm(expReg, 0);
            vm.jne("_charAt_zero"); // NaN → 0
        }
        vm.jmp("_str_charAt_oob"); // ±Inf → ""
        vm.label("_charAt_zero");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_charAt_pos_done");
        vm.label("_charAt_finite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S1, 0);
        vm.jmp("_charAt_pos_done");
        vm.label("_charAt_raw");
        vm.mov(VReg.S1, VReg.A0);
        vm.label("_charAt_pos_done");

        // 越界检查:index<0 或 >=length → 返回空字符串(charAt 语义;此前无检查 → 越界
        // 读堆邻居返垃圾字符,是 `"hi".charAt(5)`/`s[oob]` 返垃圾、动态串下标崩的共因)。
        // 注:.at()/自带界检的调用者只在界内调本函数,不受影响。
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_str_charAt_oob");
        vm.cmp(VReg.S1, VReg.S2);
        vm.jge("_str_charAt_oob");

        // 获取字符串内容指针
        vm.mov(VReg.A0, VReg.S0);  // _strlen 已冲 A0,复位
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET); // S2 = 内容指针

        // 分配 32 字节（16 字节头部 + 1 字符 + 1 null + 14 padding）
        // _alloc 返回用户数据指针 (block + 16)，需要减回头部
        vm.movImm(VReg.A0, 32);
        vm.call("_alloc");
        vm.subImm(VReg.V0, VReg.RET, 16); // V0 = block 指针

        // 写入类型标记: offset 0（只改最低字节，保留高位 size/class，GC sweep 靠 size 走块）
        vm.load(VReg.V1, VReg.V0, 0);
        vm.movImm64(VReg.V2, 0xffffffffffffff00n);
        vm.and(VReg.V1, VReg.V1, VReg.V2);
        vm.movImm(VReg.V2, TYPE_STRING);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.V0, 0, VReg.V1);
        // 写入长度: offset 8
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 8, VReg.V1);

        // 获取字符 (内容指针 + index)
        vm.add(VReg.V2, VReg.S2, VReg.S1);
        vm.loadByte(VReg.V3, VReg.V2, 0);

        // 写入字符到 block+16 位置（内容区域开始）
        vm.storeByte(VReg.V0, 16, VReg.V3);
        // 写入 null 终止符
        vm.movImm(VReg.V3, 0);
        vm.storeByte(VReg.V0, 17, VReg.V3);

        // 转换为 NaN-boxed JS 字符串
        // 注意：content pointer = block + 16 = V0 + 16
        // _print_value_string_ptr 会直接使用这个指针
        vm.addImm(VReg.RET, VReg.V0, 16); // RET = content pointer (block + 16)
        vm.emitMaskLoad(VReg.V1); // V1 = PAYLOAD_MASK
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1); // RET = RET & MASK (clear upper bits)
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); // V1 = TAG_STRING_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1); // RET = RET | TAG (NaN-boxed)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 64);

        // 越界:返回装箱空字符串 ""(_str_empty 内容指针 | 0x7ffc 标签)
        vm.label("_str_charAt_oob");
        vm.lea(VReg.RET, "_str_empty");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 64);
    }

    // String wrapper indexing uses ECMAScript UTF-16 code units, while the
    // engine's backing strings are UTF-8 bytes.  These cold helpers bridge the
    // two representations for `new String(astral)` and concat spreadability;
    // the hot primitive-string byte paths remain unchanged for self-hosting.
    generateUtf16Helpers() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;

        vm.label("_str_utf16_length");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.S2, 0); // byte offset
        vm.movImm(VReg.S3, 0); // UTF-16 unit count
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // byte length
        vm.label("_s16l_loop");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_s16l_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S4, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_cp_bytes");
        vm.mov(VReg.S5, VReg.RET);
        vm.cmpImm(VReg.S4, 0x10000);
        vm.jlt("_s16l_bmp");
        vm.addImm(VReg.S3, VReg.S3, 2);
        vm.jmp("_s16l_advance");
        vm.label("_s16l_bmp");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.label("_s16l_advance");
        vm.add(VReg.S2, VReg.S2, VReg.S5);
        vm.jmp("_s16l_loop");
        vm.label("_s16l_done");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        vm.label("_str_utf16_at");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // primitive string
        vm.mov(VReg.S1, VReg.A1); // UTF-16 unit index
        vm.movImm(VReg.S2, 0);    // units before current code point
        vm.movImm(VReg.S3, 0);    // byte offset
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S5, VReg.RET); // byte length (reused as bound)
        vm.label("_s16a_loop");
        vm.cmp(VReg.S3, VReg.S5);
        vm.jge("_s16a_undef");
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S4, 0); // code point
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_cp_bytes");
        vm.mov(VReg.V5, VReg.RET); // code-point byte count
        vm.cmpImm(VReg.S4, 0x10000);
        vm.jlt("_s16a_bmp");
        // Astral code point contributes a high and low surrogate.
        vm.cmp(VReg.S1, VReg.S2);
        vm.jeq("_s16a_high");
        vm.addImm(VReg.V0, VReg.S2, 1);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq("_s16a_low");
        vm.addImm(VReg.S2, VReg.S2, 2);
        vm.add(VReg.S3, VReg.S3, VReg.V5);
        vm.jmp("_s16a_loop");
        vm.label("_s16a_high");
        vm.subImm(VReg.V0, VReg.S4, 0x10000);
        vm.shrImm(VReg.V0, VReg.V0, 10);
        vm.addImm(VReg.V0, VReg.V0, 0xD800);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_cp_to_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_s16a_low");
        vm.subImm(VReg.V0, VReg.S4, 0x10000);
        vm.andImm(VReg.V0, VReg.V0, 0x3ff);
        vm.addImm(VReg.V0, VReg.V0, 0xDC00);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_cp_to_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_s16a_bmp");
        vm.cmp(VReg.S1, VReg.S2);
        vm.jeq("_s16a_bmp_hit");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.add(VReg.S3, VReg.S3, VReg.V5);
        vm.jmp("_s16a_loop");
        vm.label("_s16a_bmp_hit");
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_cp_to_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_s16a_undef");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // _str_cp_bytes(str, rawByteOff) -> 该 UTF-8 码点的字节数(1-4,据 lead byte)。
    // 0xxxxxxx→1、110xxxxx(0xC0-0xDF)→2、1110xxxx(0xE0-0xEF)→3、11110xxx(≥0xF0)→4。
    // 供字符串按码点迭代(for-of/spread)。continuation/非法字节不会作为 lead 出现(总按
    // 完整码点推进);ASCII 恒返 1 → 码点迭代与字节迭代一致(自举保真)。
    generateStrCpBytes() {
        const vm = this.vm;
        vm.label("_str_cp_bytes");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.add(VReg.V0, VReg.RET, VReg.S1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.movImm(VReg.V2, 0xFF);
        vm.and(VReg.V1, VReg.V1, VReg.V2); // 无符号 lead byte
        vm.cmpImm(VReg.V1, 0x80);
        vm.jlt("_cpb_1");
        vm.cmpImm(VReg.V1, 0xE0);
        vm.jlt("_cpb_2");
        vm.cmpImm(VReg.V1, 0xF0);
        vm.jlt("_cpb_3");
        vm.movImm(VReg.RET, 4);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_cpb_3");
        vm.movImm(VReg.RET, 3);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_cpb_2");
        vm.movImm(VReg.RET, 2);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_cpb_1");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _str_codepoint_at(str, rawByteOff) -> 装箱子串:该字节偏移处一个完整 UTF-8 码点
    // (1-4 字节)。仿 _str_charAt 但复制整码点。供 for-of/spread 按码点产出字符。
    // [W-39] this-check + arg 归一:经 _aref_generic(.call) 传入时 A0/A1 均为装箱值,
    // A1 为 float64 位模式而非裸 int,直接用作偏移 -> 地址越界 SIGSEGV。统一归一。
    generateStrCodepointAt() {
        const vm = this.vm;
        vm.label("_str_codepoint_at");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.store(VReg.SP, 0, VReg.A1);
        vm.mov(VReg.A0, VReg.A0);
        this._emitThisToString("codePointAt");
        vm.mov(VReg.S2, VReg.A0);
        vm.load(VReg.A0, VReg.SP, 0);
        this._emitToInteger("codePointAt");
        vm.mov(VReg.S1, VReg.RET); // byteOff (int)
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_cpat_undef");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_strlen");
        vm.cmp(VReg.S1, VReg.RET);
        vm.jge("_cpat_undef");
        vm.mov(VReg.A0, VReg.S2); // restore str
        vm.mov(VReg.S0, VReg.A0); // S0 = str
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_str_cp_bytes");
        vm.mov(VReg.S3, VReg.RET); // S3 = cpLen(1-4)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET); // S2 = content ptr(_alloc 保存 S0-S3,S2/S3 存活)
        vm.movImm(VReg.A0, 32);    // 16 头 + ≤4 + null < 32
        vm.call("_alloc");
        vm.subImm(VReg.V0, VReg.RET, 16); // V0 = block
        // type = STRING(只改低字节)
        vm.load(VReg.V1, VReg.V0, 0);
        vm.movImm64(VReg.V2, 0xffffffffffffff00n);
        vm.and(VReg.V1, VReg.V1, VReg.V2);
        vm.movImm(VReg.V2, TYPE_STRING);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.V0, 0, VReg.V1);
        // length = cpLen(字节长度,与其余堆串一致——本迭代不改 .length 语义)
        vm.store(VReg.V0, 8, VReg.S3);
        // copy cpLen 字节 content+off → block+16
        vm.add(VReg.V2, VReg.S2, VReg.S1); // src base
        vm.movImm(VReg.V3, 0);
        vm.label("_cpat_cpy");
        vm.cmp(VReg.V3, VReg.S3);
        vm.jge("_cpat_done");
        vm.add(VReg.V1, VReg.V2, VReg.V3);
        vm.loadByte(VReg.V4, VReg.V1, 0);
        vm.addImm(VReg.V1, VReg.V0, 16);
        vm.add(VReg.V1, VReg.V1, VReg.V3);
        vm.storeByte(VReg.V1, 0, VReg.V4);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp("_cpat_cpy");
        vm.label("_cpat_done");
        // null 终止 @ block+16+cpLen
        vm.addImm(VReg.V1, VReg.V0, 16);
        vm.add(VReg.V1, VReg.V1, VReg.S3);
        vm.movImm(VReg.V4, 0);
        vm.storeByte(VReg.V1, 0, VReg.V4);
        // box: (block+16) | 0x7FFC
        vm.addImm(VReg.RET, VReg.V0, 16);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);
        vm.label("_cpat_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);
    }

    // _str_proto_codePointAt(this, pos) -> JS number | undefined。
    // String.prototype.codePointAt:ToInteger(pos),越界 undefined,否则该处 UTF-8
    // 码点的数值(非子串)。for-of 仍走 _str_codepoint_at(返子串)。
    generateStrProtoCodePointAt() {
        const vm = this.vm;
        vm.label("_str_proto_codePointAt");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.store(VReg.SP, 0, VReg.A1);
        vm.mov(VReg.A0, VReg.A0);
        this._emitThisToString("protoCodePointAt");
        vm.mov(VReg.S0, VReg.A0);
        vm.load(VReg.A0, VReg.SP, 0);
        this._emitToInteger("protoCodePointAt");
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_pcpat_undef");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmp(VReg.S1, VReg.S2);
        vm.jge("_pcpat_undef");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.add(VReg.S3, VReg.RET, VReg.S1); // S3 = byte ptr
        vm.loadByte(VReg.V0, VReg.S3, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xFF);
        vm.cmpImm(VReg.V0, 0x80);
        vm.jlt("_pcpat_1");
        vm.cmpImm(VReg.V0, 0xE0);
        vm.jlt("_pcpat_2");
        vm.cmpImm(VReg.V0, 0xF0);
        vm.jlt("_pcpat_3");
        // 4-byte: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
        vm.andImm(VReg.V1, VReg.V0, 0x07);
        vm.shlImm(VReg.V1, VReg.V1, 18);
        vm.loadByte(VReg.V0, VReg.S3, 1); vm.andImm(VReg.V0, VReg.V0, 0x3F); vm.shlImm(VReg.V0, VReg.V0, 12); vm.or(VReg.V1, VReg.V1, VReg.V0);
        vm.loadByte(VReg.V0, VReg.S3, 2); vm.andImm(VReg.V0, VReg.V0, 0x3F); vm.shlImm(VReg.V0, VReg.V0, 6); vm.or(VReg.V1, VReg.V1, VReg.V0);
        vm.loadByte(VReg.V0, VReg.S3, 3); vm.andImm(VReg.V0, VReg.V0, 0x3F); vm.or(VReg.V1, VReg.V1, VReg.V0);
        vm.jmp("_pcpat_box");
        vm.label("_pcpat_3");
        vm.andImm(VReg.V1, VReg.V0, 0x0F);
        vm.shlImm(VReg.V1, VReg.V1, 12);
        vm.loadByte(VReg.V0, VReg.S3, 1); vm.andImm(VReg.V0, VReg.V0, 0x3F); vm.shlImm(VReg.V0, VReg.V0, 6); vm.or(VReg.V1, VReg.V1, VReg.V0);
        vm.loadByte(VReg.V0, VReg.S3, 2); vm.andImm(VReg.V0, VReg.V0, 0x3F); vm.or(VReg.V1, VReg.V1, VReg.V0);
        vm.jmp("_pcpat_box");
        vm.label("_pcpat_2");
        vm.andImm(VReg.V1, VReg.V0, 0x1F);
        vm.shlImm(VReg.V1, VReg.V1, 6);
        vm.loadByte(VReg.V0, VReg.S3, 1); vm.andImm(VReg.V0, VReg.V0, 0x3F); vm.or(VReg.V1, VReg.V1, VReg.V0);
        vm.jmp("_pcpat_box");
        vm.label("_pcpat_1");
        vm.mov(VReg.V1, VReg.V0);
        vm.label("_pcpat_box");
        vm.scvtf(0, VReg.V1);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_pcpat_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // Public String.prototype.codePointAt uses UTF-16 code-unit indices.  The
    // legacy `_str_proto_codePointAt` above intentionally consumes a byte
    // offset because the compiler/lexer and the UTF-8 string internals use it
    // as a small decoding primitive.  Keep those contracts separate: bridge
    // through the UTF-16 helpers, then combine a surrogate pair when the
    // requested unit is the high half of an astral code point.
    generateStrProtoCodePointAtUtf16() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;
        vm.label("_str_proto_codePointAt_utf16");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.store(VReg.SP, 0, VReg.A1); // preserve the raw position across ToString
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("protoCodePointAtUtf16");
        vm.mov(VReg.S0, VReg.A0);

        // ToInteger(Symbol) must throw.  `_emitToInteger` deliberately has a
        // raw-pointer fast path for compiler internals, so perform the public
        // Symbol guard before delegating to it.
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pcp16_symbol");
        vm.load(VReg.A0, VReg.SP, 0);
        this._emitToInteger("protoCodePointAtUtf16");
        vm.mov(VReg.S1, VReg.RET); // UTF-16 unit index

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_utf16_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_pcp16_undef");
        vm.cmp(VReg.S1, VReg.S2);
        vm.jge("_pcp16_undef");

        // Decode the requested UTF-16 unit through the existing one-unit
        // materialiser.  It returns a boxed string; the byte-oriented helper
        // is safe here because the materialised string contains exactly one
        // UTF-16 unit (including CESU-8 for lone surrogates).
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_str_utf16_at");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S4, 0);

        // A high surrogate followed by a low surrogate denotes one astral
        // code point.  Otherwise return the requested code unit as-is.
        vm.cmpImm(VReg.S4, 0xD800);
        vm.jlt("_pcp16_result");
        vm.cmpImm(VReg.S4, 0xDBFF);
        vm.jgt("_pcp16_result");
        vm.addImm(VReg.V0, VReg.S1, 1);
        vm.cmp(VReg.V0, VReg.S2);
        vm.jge("_pcp16_result");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_str_utf16_at");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S5, 0);
        vm.cmpImm(VReg.S5, 0xDC00);
        vm.jlt("_pcp16_result");
        vm.cmpImm(VReg.S5, 0xDFFF);
        vm.jgt("_pcp16_result");
        vm.subImm(VReg.V0, VReg.S4, 0xD800);
        vm.shlImm(VReg.V0, VReg.V0, 10);
        vm.subImm(VReg.V1, VReg.S5, 0xDC00);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.addImm(VReg.S4, VReg.V0, 0x10000);

        vm.label("_pcp16_result");
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_pcp16_symbol");
        this._emitThrowTypeError("Cannot convert a Symbol value to a number");

        vm.label("_pcp16_undef");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // _str_index_char(str, raw_int_idx) -> 单字符 | undefined。字符串下标 str[i] 语义:
    // 越界返 undefined(区别于 charAt 越界返 "")。界内委托 _str_charAt。
    generateStrIndexChar() {
        const vm = this.vm;
        vm.label("_str_index_char");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // str
        vm.mov(VReg.S1, VReg.A1); // idx(裸 int)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");       // RET = 长度
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_sic_undef");
        vm.cmp(VReg.S1, VReg.RET);
        vm.jge("_sic_undef");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_str_charAt");   // 界内单字符
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_sic_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // 获取指定位置的字符编码
    // _str_charCodeAt(str, index) -> 整数 (0-255)
    generateCharCodeAt() {
        const vm = this.vm;

        // Byte-oriented entry used by the compiler and the UTF-8 regexp shim.
        // Public String.prototype.charCodeAt is emitted below and follows the
        // ECMAScript UTF-16 code-unit contract.
        vm.label("_str_charCodeAt_byte");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.store(VReg.SP, 0, VReg.A1); // pos 存栈:ToString 的 call 踩 A1
        this._emitThisToString("charCodeAt");
        vm.mov(VReg.S1, VReg.A0);

        // leftover-arg / V0 smash:先 ToString,再从栈重装 pos。预 fcvtzs/+_emitToInteger
        // 在 x64 上把 NaN/string 收成 INT64_MIN(V0==RET 冲 float bits),charCodeAt(NaN) NaN。
        vm.load(VReg.A0, VReg.SP, 0);
        // at()/s[i] 仍传裸 int(high16=0/符号扩展)。0-arg emit 亦裸 0。勿当 float。
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_charCodeAt_raw");
        vm.cmpImm(VReg.V1, 0xFFFF);
        vm.jeq("_charCodeAt_raw");
        // 勿把 high16==0x8000 当裸 INT64_MIN:IEEE -0.0 同型,charCodeAt(-0) 须为 first
        vm.call("_number_coerce");
        // ToInteger:NaN→0;±Inf→oob。x64 V0==RET,extract 用 V2。
        {
            const expReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.shrImm(expReg, VReg.RET, 52);
            vm.andImm(expReg, expReg, 0x7FF);
            vm.cmpImm(expReg, 0x7FF);
            vm.jne("_charCodeAt_finite");
            vm.movImm64(expReg, 0x000fffffffffffffn);
            vm.and(expReg, VReg.RET, expReg);
            vm.cmpImm(expReg, 0);
            vm.jne("_charCodeAt_zero"); // NaN → 0
        }
        vm.jmp("_str_charCodeAt_oob"); // ±Inf → NaN
        vm.label("_charCodeAt_zero");
        vm.movImm(VReg.S0, 0);
        vm.jmp("_charCodeAt_pos_done");
        vm.label("_charCodeAt_finite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S0, 0);
        vm.jmp("_charCodeAt_pos_done");
        vm.label("_charCodeAt_raw");
        vm.mov(VReg.S0, VReg.A0);
        vm.label("_charCodeAt_pos_done");

        // 边界检查：JS 里 charCodeAt(index) 当 index<0 或 index>=length 返回 NaN，不越界读。
        // **长度必须 O(1) 获取**：堆字符串([type@0=6,length@8,content@16])直接读 length@8；
        // 否则 _strlen O(n) 扫描 × 逐字符 charCodeAt → 解析源码 O(n²) 慢到自举跑不完。
        // 数据段常量串(无 TYPE_STRING 头)才回退 _strlen（短，无妨）。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1);      // V0 = 脱壳指针
        // A heap string is passed as its content pointer (block + 16).  The
        // previous fast path read V0[0] as the type byte, which accidentally
        // classified a string whose first character was 0x06 as TYPE_STRING
        // and then loaded a bogus length from V0+8.  RegExp's byte scanner
        // calls this helper for every code unit, so that single-byte collision
        // could turn an ordinary `String.fromCharCode(6)` into an unbounded
        // scan.  Mirror _strlen's range check and inspect the allocation
        // header at (content - 16) only for pointers inside the managed heap.
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.addImm(VReg.V1, VReg.V1, 16);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_str_charCodeAt_datalen");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_str_charCodeAt_datalen");
        vm.subImm(VReg.V2, VReg.V0, 16);      // V2 = allocation block
        vm.loadByte(VReg.V1, VReg.V2, 0);     // type byte in the header
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 6);                // TYPE_STRING
        vm.jne("_str_charCodeAt_datalen");
        vm.load(VReg.RET, VReg.V2, 8);        // 堆串 length@block+8 (O(1))
        vm.jmp("_str_charCodeAt_haslen");
        vm.label("_str_charCodeAt_datalen");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");                     // 数据段串回退（短）
        vm.label("_str_charCodeAt_haslen");
        // RET = 长度
        vm.cmpImm(VReg.S0, 0);
        vm.jlt("_str_charCodeAt_oob");
        vm.cmp(VReg.S0, VReg.RET);
        vm.jge("_str_charCodeAt_oob");

        // 在界内：取内容指针并读字节
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent"); // RET = 内容指针
        vm.add(VReg.V0, VReg.RET, VReg.S0);
        vm.loadByte(VReg.RET, VReg.V0, 0);
        // RET = 字符编码 (0-255)，转为标准 JS number（float64 位）
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // 越界：返回 0（有效 number，high16=0 不与 tag 冲突）。JS 本应返回 NaN，但本体系
        // NaN 的 high16>=0x7FF8 与标签区冲突、无法当普通 number 表示。编译器实际调用点
        // （lexer isLetter/isDigit/isHexDigit 用 code>127 / code>=97 等范围比较，对 0 全 false，
        // 与 NaN 同效果；isBareModuleName 的循环 i<s.length 有界不越界）→ 返 0 正确且不崩。
        vm.label("_str_charCodeAt_oob");
        // 越界 charCodeAt 返 NaN(非 0)。用非别名 NaN 位 0x7FF0…01(勿用 canonical 0x7FF8——
        // 与装箱 int0 同构会打印成 0,见 nan-int0)。编译器 lexer 恒界内故不触此路。
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // Public String.prototype.charCodeAt.  Source strings are stored as
    // UTF-8 bytes so the legacy implementation above is intentionally kept
    // for compiler/parser internals.  User-visible charCodeAt must index
    // UTF-16 code units (including lone surrogates), therefore bridge through
    // the UTF-16 helpers and decode the one-unit result back to a number.
    generateCharCodeAtUtf16() {
        const vm = this.vm;
        vm.label("_str_charCodeAt");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.store(VReg.SP, 0, VReg.A1);
        this._emitThisToString("charCodeAtUtf16");
        vm.mov(VReg.S0, VReg.A0);
        vm.load(VReg.A0, VReg.SP, 0);
        this._emitToInteger("charCodeAtUtf16");
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_cc16_oob");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_utf16_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmp(VReg.S1, VReg.S2);
        vm.jge("_cc16_oob");

        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_str_utf16_at");
        // `_str_utf16_at` returns undefined for an out-of-range unit.  Keep
        // the check explicit instead of feeding undefined through ToString.
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_cc16_oob");
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm(VReg.A1, 0);
        vm.call("_str_proto_codePointAt");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_cc16_oob");
        // Keep the same non-canonical NaN used by the byte helper; it is a
        // genuine number in the NaN-box layout and is not confused with 0.
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // [W-25] _str_ws_len(A0=content 指针, A1=剩余字节数) -> RET = 该处 WhiteSpace/
    // LineTerminator 的 UTF-8 字节长度(1/2/3),不是空白则 0。
    // trim/trimStart/trimEnd 共用(此前三处各自只认 ' ' \t \n \r,test262
    // 15.5.4.20-3-3 / -4-12 / -4-24 / -4-46 / -4-50 全挂在这四个字节上)。
    // 规范集合 = WhiteSpace ∪ LineTerminator:
    //   1 字节: \t(09) \n(0A) \v(0B) \f(0C) \r(0D) SP(20)
    //   2 字节: U+00A0        = C2 A0
    //   3 字节: U+1680        = E1 9A 80
    //           U+2000..200A  = E2 80 80..8A
    //           U+2028/2029   = E2 80 A8 / A9
    //           U+202F        = E2 80 AF
    //           U+205F        = E2 81 9F
    //           U+3000        = E3 80 80
    //           U+FEFF        = EF BB BF
    // 字节模型下这些恒是完整 UTF-8 序列;残缺序列(remaining 不够)一律判非空白,
    // 不会越界读。loadByte 后必须 and 0xFF——本文件既有代码(_str_cp_bytes)证实
    // 高位可能带脏值,不掩码则 >=0x80 的比较全错。
    generateWsLen() {
        const vm = this.vm;

        vm.label("_str_ws_len");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // ptr
        vm.mov(VReg.S1, VReg.A1); // remaining
        vm.cmpImm(VReg.S1, 1);
        vm.jlt("_swl_0");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        // ASCII 段
        vm.cmpImm(VReg.V1, 0x20);
        vm.jeq("_swl_1");
        vm.cmpImm(VReg.V1, 0x09);
        vm.jlt("_swl_0");
        vm.cmpImm(VReg.V1, 0x0d);
        vm.jle("_swl_1");
        // 2 字节: C2 A0
        vm.cmpImm(VReg.V1, 0xc2);
        vm.jne("_swl_try3");
        vm.cmpImm(VReg.S1, 2);
        vm.jlt("_swl_0");
        vm.loadByte(VReg.V3, VReg.S0, 1);
        vm.andImm(VReg.V3, VReg.V3, 0xff);
        vm.cmpImm(VReg.V3, 0xa0);
        vm.jeq("_swl_2");
        vm.jmp("_swl_0");
        // 3 字节族
        vm.label("_swl_try3");
        vm.cmpImm(VReg.S1, 3);
        vm.jlt("_swl_0");
        vm.loadByte(VReg.V3, VReg.S0, 1);
        vm.andImm(VReg.V3, VReg.V3, 0xff);
        vm.loadByte(VReg.V4, VReg.S0, 2);
        vm.andImm(VReg.V4, VReg.V4, 0xff);
        vm.cmpImm(VReg.V1, 0xe1);
        vm.jne("_swl_e2");
        vm.cmpImm(VReg.V3, 0x9a);
        vm.jne("_swl_0");
        vm.cmpImm(VReg.V4, 0x80);
        vm.jeq("_swl_3");
        vm.jmp("_swl_0");
        vm.label("_swl_e2");
        vm.cmpImm(VReg.V1, 0xe2);
        vm.jne("_swl_e3");
        vm.cmpImm(VReg.V3, 0x81);
        vm.jeq("_swl_e2_81");
        vm.cmpImm(VReg.V3, 0x80);
        vm.jne("_swl_0");
        vm.cmpImm(VReg.V4, 0x80);
        vm.jlt("_swl_0");
        vm.cmpImm(VReg.V4, 0x8a);
        vm.jle("_swl_3");
        vm.cmpImm(VReg.V4, 0xa8);
        vm.jeq("_swl_3");
        vm.cmpImm(VReg.V4, 0xa9);
        vm.jeq("_swl_3");
        vm.cmpImm(VReg.V4, 0xaf);
        vm.jeq("_swl_3");
        vm.jmp("_swl_0");
        vm.label("_swl_e2_81");
        vm.cmpImm(VReg.V4, 0x9f);
        vm.jeq("_swl_3");
        vm.jmp("_swl_0");
        vm.label("_swl_e3");
        vm.cmpImm(VReg.V1, 0xe3);
        vm.jne("_swl_ef");
        vm.cmpImm(VReg.V3, 0x80);
        vm.jne("_swl_0");
        vm.cmpImm(VReg.V4, 0x80);
        vm.jeq("_swl_3");
        vm.jmp("_swl_0");
        vm.label("_swl_ef");
        vm.cmpImm(VReg.V1, 0xef);
        vm.jne("_swl_0");
        vm.cmpImm(VReg.V3, 0xbb);
        vm.jne("_swl_0");
        vm.cmpImm(VReg.V4, 0xbf);
        vm.jeq("_swl_3");
        vm.label("_swl_0");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_swl_1");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_swl_2");
        vm.movImm(VReg.RET, 2);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_swl_3");
        vm.movImm(VReg.RET, 3);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [W-25] _str_ws_len_back(A0=content 指针, A1=end 下标) -> RET = 以 end-1 为末字节
    // 的空白序列字节长度(1/2/3),非空白则 0。尾部扫描用(需要往回认多字节序列)。
    // 先试 1 字节 ASCII(空白 ASCII 不可能是 UTF-8 后续字节,无歧义),再回退 2/3 字节
    // 委托 _str_ws_len 判定,不重复空白表。
    generateWsLenBack() {
        const vm = this.vm;

        vm.label("_str_ws_len_back");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // ptr
        vm.mov(VReg.S1, VReg.A1); // end
        vm.cmpImm(VReg.S1, 1);
        vm.jlt("_swlb_0");
        vm.subImm(VReg.V1, VReg.S1, 1);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V3, VReg.V1, 0);
        vm.andImm(VReg.V3, VReg.V3, 0xff);
        vm.cmpImm(VReg.V3, 0x20);
        vm.jeq("_swlb_1");
        vm.cmpImm(VReg.V3, 0x09);
        vm.jlt("_swlb_try2");
        vm.cmpImm(VReg.V3, 0x0d);
        vm.jle("_swlb_1");
        vm.label("_swlb_try2");
        vm.cmpImm(VReg.S1, 2);
        vm.jlt("_swlb_0");
        vm.subImm(VReg.V1, VReg.S1, 2);
        vm.add(VReg.A0, VReg.S0, VReg.V1);
        vm.movImm(VReg.A1, 2);
        vm.call("_str_ws_len");
        vm.cmpImm(VReg.RET, 2);
        vm.jeq("_swlb_2");
        vm.cmpImm(VReg.S1, 3);
        vm.jlt("_swlb_0");
        vm.subImm(VReg.V1, VReg.S1, 3);
        vm.add(VReg.A0, VReg.S0, VReg.V1);
        vm.movImm(VReg.A1, 3);
        vm.call("_str_ws_len");
        vm.cmpImm(VReg.RET, 3);
        vm.jeq("_swlb_3");
        vm.label("_swlb_0");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_swlb_1");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_swlb_2");
        vm.movImm(VReg.RET, 2);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_swlb_3");
        vm.movImm(VReg.RET, 3);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [W-25] _str_argstr(A0=任意 JSValue) -> RET = 可直接交给 _getStrContent 的字符串值。
    // 非字符串实参先走 ToString(_valueToStr,含用户 toString/[Symbol.toPrimitive])。
    // 直通(不转换)的三类:
    //   high16 == 0      裸内容指针(静态派发已 _getStrContent 过的实参,热路径)
    //   high16 == 0x7FFC 装箱字符串(绝大多数调用)
    //   high16 == 0x7FFF 装箱函数(replace 的函数替换器等由上游语义处理,
    //                    转成 "[Function]" 只会把一种错换成另一种)
    // 其余(undefined/null/boolean/number/object/array/裸 float)此前一律被
    // _getStrContent 判非法 → 空串,这是 concat(undefined)/padStart(false)/
    // localeCompare(undefined)/indexOf(undefined) 全族偏差的共因。
    generateArgStr() {
        const vm = this.vm;
        vm.label("_str_argstr");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_sas_raw");
        vm.cmpImm(VReg.V1, 0x7ffc);
        vm.jeq("_sas_pass");
        vm.cmpImm(VReg.V1, 0x7fff);
        vm.jeq("_sas_pass");
        // 对象/其余:ToString(=hint string),勿走 _js_toprimitive(hint default/valueOf 优先)。
        vm.label("_sas_valtostr");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0], 0);
        vm.label("_sas_raw");
        // 裸指针:0 是 +0.0/int 0 → ToString "0";堆内 Symbol 块 → TypeError;其余当串指针直通。
        // BigInt primitives share the raw-pointer representation.  Check
        // their header before treating the payload as a string pointer.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_sas_valtostr");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_sas_valtostr");
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jb("_sas_pass");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jae("_sas_pass");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 61); // TYPE_SYMBOL
        vm.jne("_sas_pass");
        this._emitThrowTypeError("Cannot convert a Symbol value to a string");
        vm.label("_sas_pass");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);
    }

    // 去除首尾空白
    // _str_trim(str) -> 新字符串
    generateTrim() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_str_trim");
        // 使用 6 个保存寄存器: S0=str, S1=len, S2=start, S3=end/newLen后为result, S4=newLen, S5=index
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        this._emitThisToString("trim");

        vm.mov(VReg.S0, VReg.A0); // S0 = 源字符串

        // 计算长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // S1 = 原始长度

        // 获取内容指针
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = content

        // 找到开始位置（跳过前导空白）
        vm.movImm(VReg.S2, 0); // S2 = start
        const skipStartLabel = "_trim_skip_start";
        const startDoneLabel = "_trim_start_done";
        // [W-25] 空白判定统一走 _str_ws_len(完整 WhiteSpace ∪ LineTerminator,含多字节)
        vm.label(skipStartLabel);
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge(startDoneLabel);
        vm.add(VReg.A0, VReg.S0, VReg.S2);
        vm.sub(VReg.A1, VReg.S1, VReg.S2);
        vm.call("_str_ws_len");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq(startDoneLabel);
        vm.add(VReg.S2, VReg.S2, VReg.RET);
        vm.jmp(skipStartLabel);
        vm.label(startDoneLabel);

        // 找到结束位置（跳过尾部空白）
        vm.mov(VReg.S3, VReg.S1); // S3 = end (临时用)
        const skipEndLabel = "_trim_skip_end";
        const endDoneLabel = "_trim_end_done";
        vm.label(skipEndLabel);
        vm.cmp(VReg.S3, VReg.S2);
        vm.jle(endDoneLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_ws_len_back");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq(endDoneLabel);
        vm.sub(VReg.S3, VReg.S3, VReg.RET);
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge(skipEndLabel);
        vm.mov(VReg.S3, VReg.S2); // 空白跨过 start(全空白串):钳到 start
        vm.label(endDoneLabel);

        // 计算新长度，保存到 S4
        vm.sub(VReg.S4, VReg.S3, VReg.S2); // S4 = newLen

        // 分配新字符串 (16 字节头 + len + 1)
        vm.addImm(VReg.A0, VReg.S4, 17);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // S3 = user_ptr (alloc returns block+16)

        // 写入类型标记和 length 到 block header (user_ptr - 16)
        // writeStringHeader 以 content 指针为入参（内部自减 16）
        this.writeStringHeader(VReg.S3, VReg.S4);

        // 手动复制指定长度的字符 (直接写到 user_ptr)
        const copyLoop = "_trim_copy";
        const copyDone = "_trim_copy_done";
        vm.movImm(VReg.S5, 0); // S5 = index
        vm.label(copyLoop);
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge(copyDone);

        // 源位置 = str + start + index
        vm.add(VReg.V0, VReg.S0, VReg.S2);
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.loadByte(VReg.V1, VReg.V0, 0);

        // 目标位置 = user_ptr + index
        vm.add(VReg.V0, VReg.S3, VReg.S5);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp(copyLoop);

        vm.label(copyDone);
        // 写入 null 终止符
        vm.add(VReg.V0, VReg.S3, VReg.S4);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        // 返回 NaN-boxed JSValue
        vm.emitMaskLoad(VReg.V0); // PAYLOAD_MASK
        vm.andMaskReg(VReg.RET, VReg.S3, VReg.V0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); // TAG_STRING_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // _str_trimStart(str) -> 新字符串（只去前导空白）。骨架同 _str_trim，
    // 去掉尾部跳过（end 恒 = 原长度）。标签前缀 _trimS_ 避免与 _trim_ 冲突。
    generateTrimStart() {
        const vm = this.vm;

        vm.label("_str_trimStart");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        this._emitThisToString("trimStart");

        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // S1 = 原始长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = content

        // 跳过前导空白 → S2 = start
        vm.movImm(VReg.S2, 0);
        vm.label("_trimS_skip");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_trimS_skip_done");
        vm.add(VReg.A0, VReg.S0, VReg.S2);
        vm.sub(VReg.A1, VReg.S1, VReg.S2);
        vm.call("_str_ws_len"); // [W-25] 完整空白集
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_trimS_skip_done");
        vm.add(VReg.S2, VReg.S2, VReg.RET);
        vm.jmp("_trimS_skip");
        vm.label("_trimS_skip_done");

        // end = 原长度；newLen = S1 - S2
        vm.sub(VReg.S4, VReg.S1, VReg.S2); // S4 = newLen

        vm.addImm(VReg.A0, VReg.S4, 17);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // S3 = user_ptr
        this.writeStringHeader(VReg.S3, VReg.S4);

        vm.movImm(VReg.S5, 0);
        vm.label("_trimS_copy");
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge("_trimS_copy_done");
        vm.add(VReg.V0, VReg.S0, VReg.S2);
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.add(VReg.V0, VReg.S3, VReg.S5);
        vm.storeByte(VReg.V0, 0, VReg.V1);
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_trimS_copy");
        vm.label("_trimS_copy_done");
        vm.add(VReg.V0, VReg.S3, VReg.S4);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.RET, VReg.S3, VReg.V0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // _str_trimEnd(str) -> 新字符串（只去尾部空白）。start 恒 0，只跳尾部。
    generateTrimEnd() {
        const vm = this.vm;

        vm.label("_str_trimEnd");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        this._emitThisToString("trimEnd");

        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // S1 = 原始长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = content

        vm.movImm(VReg.S2, 0); // start = 0（不去前导）

        // 跳过尾部空白 → S3 = end
        vm.mov(VReg.S3, VReg.S1);
        vm.label("_trimE_skip");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jle("_trimE_skip_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_ws_len_back"); // [W-25] 完整空白集
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_trimE_skip_done");
        vm.sub(VReg.S3, VReg.S3, VReg.RET);
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_trimE_skip");
        vm.mov(VReg.S3, VReg.S2);
        vm.label("_trimE_skip_done");

        // newLen = S3 - 0 = S3
        vm.sub(VReg.S4, VReg.S3, VReg.S2); // S4 = newLen

        vm.addImm(VReg.A0, VReg.S4, 17);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // S3 = user_ptr（复用 S3；end 已并入 S4）
        this.writeStringHeader(VReg.S3, VReg.S4);

        vm.movImm(VReg.S5, 0);
        vm.label("_trimE_copy");
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge("_trimE_copy_done");
        vm.add(VReg.V0, VReg.S0, VReg.S2);
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.add(VReg.V0, VReg.S3, VReg.S5);
        vm.storeByte(VReg.V0, 0, VReg.V1);
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_trimE_copy");
        vm.label("_trimE_copy_done");
        vm.add(VReg.V0, VReg.S3, VReg.S4);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.RET, VReg.S3, VReg.V0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // 字符串切片
    // _str_slice(str, start, end) -> 新字符串
    generateSlice() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        // Keep the public entry UTF-16 aware, while exposing a private
        // byte-indexed entry for replacement helpers.  StringIndexOf and
        // the replacement loops currently operate on UTF-8 byte offsets;
        // routing those slices through the public UTF-16 slow path corrupts
        // non-ASCII replacements (for example `é` is two bytes but one code
        // unit).  A tiny mode flag lets both entries share the implementation
        // and ABI without duplicating the fairly large slice routine.
        vm.label("_str_slice");
        vm.movImm(VReg.A3, 0); // public UTF-16 mode
        vm.jmp("_str_slice_entry");
        vm.label("_str_slice_bytes");
        vm.movImm(VReg.A3, 1); // internal UTF-8 byte-offset mode
        vm.label("_str_slice_entry");
        // S0=str, S1=start, S2=end/result, S3=len, S4=newLen, S5=index
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.store(VReg.SP, 16, VReg.A3); // slice mode (0=public, 1=bytes)
        vm.store(VReg.SP, 0, VReg.A1);
        vm.store(VReg.SP, 8, VReg.A2);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("slice");
        vm.mov(VReg.S5, VReg.A0); // normalized receiver (for UTF-16 slow path)
        vm.mov(VReg.S0, VReg.A0);

        // 1. 获取解箱后的内容指针和长度。A1/A2 是 caller-saved:先留在栈上,
        // 等 _getStrContent/_strlen 返回再装回(同 _str_substring leftover-arg)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = raw string pointer

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S3, VReg.RET); // S3 = len

        // Public String#slice is indexed in UTF-16 code units.  Keep the
        // existing byte-oriented implementation for ASCII/self-hosting, but
        // divert non-ASCII strings to the code-unit helper.  The private
        // replacement entry opts out of this diversion because its indices
        // are byte offsets.  Arguments remain boxed in the frame so their
        // ToInteger coercions occur exactly once inside that helper.
        vm.load(VReg.V0, VReg.SP, 16);
        vm.cmpImm(VReg.V0, 1);
        vm.jeq("_slice_utf8_fast");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_utf16_length");
        vm.cmp(VReg.RET, VReg.S3);
        vm.jeq("_slice_utf8_fast");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.mov(VReg.A2, VReg.A1);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.mov(VReg.A0, VReg.S5);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_str_slice_utf16");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_slice_utf8_fast");

        // leftover-arg: reload start/end after calls smash S1/S2
        vm.load(VReg.S1, VReg.SP, 0);
        vm.load(VReg.S2, VReg.SP, 8);

        // 2. ToIntegerOrInfinity(start/end). _to_int32 将 +Inf/-Inf 归零,
        // 破坏 slice(NaN, Infinity)→全串(linux-x64 leftover A2_T2)。
        // x64: V0==RET, shrImm/movImm64(V0) 冲掉 float bits; end 已在 S2,
        // V2==A2 此处可当 scratch(同 _str_substring)。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_number_coerce");
        {
            const expReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.shrImm(expReg, VReg.RET, 52);
            vm.andImm(expReg, expReg, 0x7FF);
            vm.cmpImm(expReg, 0x7FF);
            vm.jne("_slice_s_finite");
            vm.movImm64(expReg, 0x000fffffffffffffn);
            vm.and(expReg, VReg.RET, expReg);
            vm.cmpImm(expReg, 0);
            vm.jne("_slice_s_zero");
            vm.shrImm(expReg, VReg.RET, 63);
            vm.cmpImm(expReg, 0);
            vm.jne("_slice_s_zero");
        }
        vm.mov(VReg.S1, VReg.S3);
        vm.jmp("_slice_s_done");
        vm.label("_slice_s_zero");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_slice_s_done");
        vm.label("_slice_s_finite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S1, 0);
        vm.label("_slice_s_done");

        // end = (end === undefined) ? len : ToIntegerOrInfinity(end)
        vm.movImm64(VReg.V0, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.cmp(VReg.S2, VReg.V0);
        const endIsLen = "_slice_end_is_len_final";
        const calcStart = "_slice_calc_start_final";
        vm.jeq(endIsLen);

        vm.mov(VReg.A0, VReg.S2);
        vm.call("_number_coerce");
        {
            const expReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.shrImm(expReg, VReg.RET, 52);
            vm.andImm(expReg, expReg, 0x7FF);
            vm.cmpImm(expReg, 0x7FF);
            vm.jne("_slice_e_finite");
            vm.movImm64(expReg, 0x000fffffffffffffn);
            vm.and(expReg, VReg.RET, expReg);
            vm.cmpImm(expReg, 0);
            vm.jne("_slice_e_zero");
            vm.shrImm(expReg, VReg.RET, 63);
            vm.cmpImm(expReg, 0);
            vm.jne("_slice_e_zero");
        }
        vm.mov(VReg.S2, VReg.S3);
        vm.jmp(calcStart);
        vm.label("_slice_e_zero");
        vm.movImm(VReg.S2, 0);
        vm.jmp(calcStart);
        vm.label("_slice_e_finite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S2, 0);
        vm.jmp(calcStart);

        vm.label(endIsLen);
        vm.mov(VReg.S2, VReg.S3);

        vm.label(calcStart);
        // 处理 start < 0: start = max(len + start, 0)
        vm.cmpImm(VReg.S1, 0);
        const startPos = "_slice_start_pos_final";
        const startOk = "_slice_start_ok_final";
        vm.jge(startPos);
        vm.add(VReg.S1, VReg.S1, VReg.S3);
        vm.cmpImm(VReg.S1, 0);
        vm.jge(startOk);
        vm.movImm(VReg.S1, 0);
        vm.jmp(startOk);
        vm.label(startPos);
        // start = min(start, len)
        vm.cmp(VReg.S1, VReg.S3);
        vm.jle(startOk);
        vm.mov(VReg.S1, VReg.S3);
        vm.label(startOk);

        // 处理 end < 0: end = max(len + end, 0)
        vm.cmpImm(VReg.S2, 0);
        const endPos = "_slice_end_pos_final";
        const endOk = "_slice_end_ok_final";
        vm.jge(endPos);
        vm.add(VReg.S2, VReg.S2, VReg.S3);
        vm.cmpImm(VReg.S2, 0);
        vm.jge(endOk);
        vm.movImm(VReg.S2, 0);
        vm.jmp(endOk);
        vm.label(endPos);
        // end = min(end, len)
        vm.cmp(VReg.S2, VReg.S3);
        vm.jle(endOk);
        vm.mov(VReg.S2, VReg.S3);
        vm.label(endOk);

        // 3. 计算 slice 长度
        const doSlice = "_slice_do_final";
        vm.cmp(VReg.S1, VReg.S2);
        vm.jlt(doSlice);
        
        // 返回空字符串
        // x64: V0==RET==RAX，movImm64(V0) 会冲掉刚 lea 进 RET 的 _str_empty 地址，
        // 产出 0x7FFC|全1 的"字符串化 -1"毒值（regex flags 为空时崩自举分析）。x64 用 V2。
        vm.lea(VReg.RET, "_str_empty");
        {
            const sliceMaskReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.movImm64(sliceMaskReg, 0x0000ffffffffffffn);
            vm.and(VReg.RET, VReg.RET, sliceMaskReg);
        }
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label(doSlice);
        vm.sub(VReg.S4, VReg.S2, VReg.S1); // S4 = newLen

        // 4. 分配并复制
        vm.addImm(VReg.A0, VReg.S4, 1);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);

        // 写入堆对象头
        this.writeStringHeader(VReg.S3, VReg.S4);

        // 复制循环
        vm.movImm(VReg.S5, 0); // i = 0
        const loop = "_slice_copy_loop_final";
        const done = "_slice_copy_done_final";
        vm.label(loop);
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge(done);
        
        // load src: S0 + S1 + i
        vm.add(VReg.V0, VReg.S0, VReg.S1);
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        
        // store dst: S3 + i
        vm.add(VReg.V0, VReg.S3, VReg.S5);
        vm.storeByte(VReg.V0, 0, VReg.V1);
        
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp(loop);

        vm.label(done);
        // Null terminator
        vm.add(VReg.V0, VReg.S3, VReg.S4);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        // 返回装箱后的字符串
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.RET, VReg.S3, VReg.V0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // UTF-16 code-unit implementation for the public slice slow path.  The
    // byte-oriented core above remains the compiler/runtime fast path; this
    // helper is selected only when the receiver contains multi-byte UTF-8.
    generateUtf16Slice() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;

        vm.label("_str_slice_utf16");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // receiver
        vm.mov(VReg.S1, VReg.A1); // start
        vm.mov(VReg.S2, VReg.A2); // end
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("sliceUtf16");
        vm.mov(VReg.S0, VReg.A0); // normalized receiver (boxed/raw)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_utf16_length");
        vm.mov(VReg.S3, VReg.RET); // length in UTF-16 units

        // start = ToIntegerOrInfinity(start), end defaults to len.
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_to_integer");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm64(VReg.V0, UNDEF);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jeq("_s16slice_end_len");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_to_integer");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_s16slice_clamp");
        vm.label("_s16slice_end_len");
        vm.mov(VReg.S2, VReg.S3);

        vm.label("_s16slice_clamp");
        // Negative start/end count from the end; positive values clamp to len.
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_s16slice_start_pos");
        vm.add(VReg.S1, VReg.S1, VReg.S3);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_s16slice_start_done");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_s16slice_start_done");
        vm.label("_s16slice_start_pos");
        vm.cmp(VReg.S1, VReg.S3);
        vm.jle("_s16slice_start_done");
        vm.mov(VReg.S1, VReg.S3);
        vm.label("_s16slice_start_done");
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_s16slice_end_pos");
        vm.add(VReg.S2, VReg.S2, VReg.S3);
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_s16slice_end_done");
        vm.movImm(VReg.S2, 0);
        vm.jmp("_s16slice_end_done");
        vm.label("_s16slice_end_pos");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jle("_s16slice_end_done");
        vm.mov(VReg.S2, VReg.S3);
        vm.label("_s16slice_end_done");

        vm.cmp(VReg.S1, VReg.S2);
        vm.jge("_s16slice_empty");
        // Preserve the original representation for a full-string slice; this
        // matters because the engine can hold the same UTF-16 pair as either
        // canonical UTF-8 or CESU-8 bytes, while strict equality is byte based.
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_s16slice_build");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jeq("_s16slice_return_source");

        vm.label("_s16slice_build");
        vm.store(VReg.SP, 0, VReg.S1); // current unit index
        vm.lea(VReg.V0, "_str_empty");
        vm.store(VReg.SP, 8, VReg.V0); // accumulator
        vm.label("_s16slice_loop");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.V0, VReg.S2);
        vm.jge("_s16slice_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_str_utf16_at");
        vm.store(VReg.SP, 16, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 8);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.call("_strconcat");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_s16slice_loop");
        vm.label("_s16slice_done");
        vm.load(VReg.RET, VReg.SP, 8);
        vm.jmp("_s16slice_return");
        vm.label("_s16slice_empty");
        vm.lea(VReg.RET, "_str_empty");
        vm.label("_s16slice_return");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_s16slice_return_source");
        vm.mov(VReg.RET, VReg.S0);
        // `_str_slice_utf16` is called by both the public String lowering
        // (which passes a raw content pointer) and the regexp shim (which may
        // pass a boxed value).  Do not return the raw pointer on the
        // full-string fast path: callers observe the result as a JS string
        // and the NaN-box tag is otherwise lost (`typeof s.slice(...)` would
        // report `number`).  The common return block accepts either form and
        // canonicalises it to a boxed string.
        vm.jmp("_s16slice_return");
    }

    // _str_substring(str, start, end) -> 新字符串
    generateSubstring() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_str_substring");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.store(VReg.SP, 0, VReg.A1);
        vm.store(VReg.SP, 8, VReg.A2);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("substring");
        vm.mov(VReg.S0, VReg.A0);

        // 获取内容指针。A1/A2 是 caller-saved:先留在栈上,等 _getStrContent/_strlen
        // 返回再装回,否则 leftover A1/A2 当 start/end → 全 arity 空串(linux-x64)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = raw content

        // 获取字符串长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S3, VReg.RET); // S3 = len

        // leftover-arg: reload start/end after calls smash A1/A2
        vm.load(VReg.A1, VReg.SP, 0);
        vm.load(VReg.A2, VReg.SP, 8);

        // 规范化 start(需 ToIntegerOrInfinity 语义:Infinity 不归零)
        // _to_int32 将 +Inf/-Inf 归零,破坏 substring(NaN,Infinity) 语义;
        // 改用 _number_coerce 取 float64 位,特判 Infinity: +Inf→len, -Inf→0。
        // 先保存 end 参数 —— _number_coerce 可能修改 A2(调用者保存寄存器)。
        vm.mov(VReg.S4, VReg.A2);            // 保存 end 参数
        vm.mov(VReg.A0, VReg.A1);            // A0 = start arg
        vm.call("_number_coerce");           // RET = raw float64 bits
        // x64: V0==RET, shrImm/movImm64(V0) 冲掉 float bits(同空串路径用 V2)
        // end 已在 S4, V2==A2 此处可当 scratch。
        {
            const expReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.shrImm(expReg, VReg.RET, 52);
            vm.andImm(expReg, expReg, 0x7FF);
            vm.cmpImm(expReg, 0x7FF);
            vm.jne("_substring_s_finite");
            // NaN(尾数!=0) → 0; +/-Inf(尾数==0):检符号位
            vm.movImm64(expReg, 0x000fffffffffffffn);
            vm.and(expReg, VReg.RET, expReg);
            vm.cmpImm(expReg, 0);
            vm.jne("_substring_s_zero");          // NaN → 0
            vm.shrImm(expReg, VReg.RET, 63);     // 符号位
            vm.cmpImm(expReg, 0);
            vm.jne("_substring_s_zero");          // -Inf → 0
        }
        // +Inf → len(S3):钳位后即为全长
        vm.mov(VReg.S1, VReg.S3);
        vm.jmp("_substring_s_done");
        vm.label("_substring_s_zero");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_substring_s_done");
        vm.label("_substring_s_finite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S1, 0);               // trunc → int64
        vm.label("_substring_s_done");

        // 恢复 end 参数并规范化 end(同样 ToIntegerOrInfinity 语义)
        vm.mov(VReg.A2, VReg.S4);            // 恢复 end 参数
        vm.movImm64(VReg.V0, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.cmp(VReg.A2, VReg.V0);
        vm.jeq("_substring_end_is_len");
        vm.mov(VReg.A0, VReg.A2);
        vm.call("_number_coerce");
        {
            const expReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.shrImm(expReg, VReg.RET, 52);
            vm.andImm(expReg, expReg, 0x7FF);
            vm.cmpImm(expReg, 0x7FF);
            vm.jne("_substring_e_finite");
            vm.movImm64(expReg, 0x000fffffffffffffn);
            vm.and(expReg, VReg.RET, expReg);
            vm.cmpImm(expReg, 0);
            vm.jne("_substring_e_zero");
            vm.shrImm(expReg, VReg.RET, 63);
            vm.cmpImm(expReg, 0);
            vm.jne("_substring_e_zero");
        }
        vm.mov(VReg.S2, VReg.S3);            // +Inf → len
        vm.jmp("_substring_calc_start");
        vm.label("_substring_e_zero");
        vm.movImm(VReg.S2, 0);
        vm.jmp("_substring_calc_start");
        vm.label("_substring_e_finite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.S2, 0);
        vm.jmp("_substring_calc_start");

        vm.label("_substring_end_is_len");
        vm.mov(VReg.S2, VReg.S3);

        vm.label("_substring_calc_start");
        // 规范化 start: max(0, min(start, len))
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_substring_start_ge0");
        vm.movImm(VReg.S1, 0);
        vm.label("_substring_start_ge0");
        vm.cmp(VReg.S1, VReg.S3);
        vm.jle("_substring_start_ok");
        vm.mov(VReg.S1, VReg.S3);
        vm.label("_substring_start_ok");

        // 规范化 end: max(0, min(end, len))
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_substring_end_ge0");
        vm.movImm(VReg.S2, 0);
        vm.label("_substring_end_ge0");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jle("_substring_end_ok");
        vm.mov(VReg.S2, VReg.S3);
        vm.label("_substring_end_ok");

        // 如果 start > end, 交换它们
        vm.cmp(VReg.S1, VReg.S2);
        vm.jle("_substring_no_swap");
        vm.mov(VReg.V0, VReg.S1);
        vm.mov(VReg.S1, VReg.S2);
        vm.mov(VReg.S2, VReg.V0);
        vm.label("_substring_no_swap");

        // 计算新长度
        vm.sub(VReg.S4, VReg.S2, VReg.S1); // S4 = newLen

        // 如果 newLen == 0, 返回空字符串
        vm.cmpImm(VReg.S4, 0);
        vm.jgt("_substring_do"); // 死代码原用不存在的 vm.jg;正解 jgt(newLen>0 才复制)
        // x64: V0==RET==RAX，movImm64(V0) 冲掉 RET（同 _str_slice 空串路径），x64 用 V2
        vm.lea(VReg.RET, "_str_empty");
        {
            const substrMaskReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.movImm64(substrMaskReg, 0x0000ffffffffffffn);
            vm.and(VReg.RET, VReg.RET, substrMaskReg);
        }
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        vm.label("_substring_do");
        // 分配新字符串
        vm.addImm(VReg.A0, VReg.S4, 17);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // S3 = user_ptr

        // 设置头(length=S4=newLen;原误传 S2=end——本函数当前无调用者,但 _strlen
        // 快路径信任 header length,错头会从无害变错值,故修正)
        this.writeStringHeader(VReg.RET, VReg.S4);

        // 复制字符
        vm.movImm(VReg.S5, 0);
        vm.label("_substring_copy");
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge("_substring_done");

        vm.add(VReg.V0, VReg.S0, VReg.S1);
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.loadByte(VReg.V1, VReg.V0, 0);

        vm.add(VReg.V0, VReg.S3, VReg.S5);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_substring_copy");

        vm.label("_substring_done");
        vm.add(VReg.V0, VReg.S3, VReg.S4);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1);

        // 返回 JSValue
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.RET, VReg.S3, VReg.V0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // _str_substr(str, start, length) -> 新字符串
    // 语义(ECMAScript): 负 start 从末尾计(len+start,下限0);length 缺省到末尾,
    // <0 视为 0。实现为薄封装:先把 substr 语义换算成 [start,end) 区间,再委托
    // 已验证的 _str_slice 完成分配/复制(避免重写易错的复制循环)。
    generateSubstr() {
        const vm = this.vm;

        vm.label("_str_substr");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("substr");
        vm.mov(VReg.S0, VReg.A0);

        // len
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.mov(VReg.S3, VReg.RET); // S3 = len

        // start = to_int32(start);负则 max(len+start,0),否则 min(start,len)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_to_int32");
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_substr_start_pos");
        vm.add(VReg.S1, VReg.S1, VReg.S3);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_substr_start_ok");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_substr_start_ok");
        vm.label("_substr_start_pos");
        vm.cmp(VReg.S1, VReg.S3);
        vm.jle("_substr_start_ok");
        vm.mov(VReg.S1, VReg.S3);
        vm.label("_substr_start_ok");

        // end = (length===undefined) ? len : start + max(length,0)
        vm.movImm64(VReg.V0, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.cmp(VReg.S2, VReg.V0);
        vm.jeq("_substr_end_is_len");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_to_int32");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_substr_len_ok");
        vm.movImm(VReg.S2, 0);
        vm.label("_substr_len_ok");
        vm.add(VReg.S2, VReg.S1, VReg.S2); // end = start + length
        vm.jmp("_substr_go");
        vm.label("_substr_end_is_len");
        vm.mov(VReg.S2, VReg.S3); // end = len
        vm.label("_substr_go");

        // 委托 _str_slice(str, start_boxed, end_boxed)（slice 会再钳位/复制，
        // start 已 >=0、end>=start，故不触发 slice 的负值/交换分支）
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A1, VReg.S1, VReg.V0);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.and(VReg.A2, VReg.S2, VReg.V0);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_slice");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _str_new(A0=length) -> raw content pointer (heap string, unboxed)
    // Creates a new heap string of given length, zero-filled, null-terminated.
    // Used by _str_replaceAll_fn for accumulator initialization.
    generateStrNew() {
        const vm = this.vm;
        vm.label("_str_new");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);       // length
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A0, VReg.A0, 1); // +1 for null terminator
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET);       // content pointer
        this.writeStringHeader(VReg.S1, VReg.S0);
        vm.add(VReg.V0, VReg.S1, VReg.S0);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.V0, 0, VReg.V1); // null terminate
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // ── String ↔ RegExp @@ 协议(GetMethod + Call)────────────────────────────────
    // ES: match/replace/replaceAll/search/split/matchAll 在 searchValue 为对象时先
    // GetMethod(searchValue, @@*),有则 Call(method, searchValue, « O, … »)。
    // 动态 RegExp(静态类型丢失)与自定义 @@ 钩子都走此路;静态字面量仍由编译器改派
    // __RE_*。well-known 槽复用 _symwk_{match,replace,…}(SymbolGenerator 已建)。

    generateSymGetMethod() {
        const vm = this.vm;
        vm.label("_str_getmethod");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_sgm_undef");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_sgm_getter");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.label("_sgm_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET);
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq("_sgm_undef");
        vm.movImm64(VReg.V0, 0x7ffa000000000000n);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq("_sgm_undef");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_sgm_not_callable");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_sgm_undef");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_sgm_not_callable");
        vm.lea(VReg.A0, vm.asm.addString("Property is not callable"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    generateSymCallMethod() {
        const vm = this.vm;
        vm.label("_str_call_method");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.mov(VReg.S4, VReg.A4);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1);
        vm.load(VReg.V0, VReg.S0, 0);
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_scm_bare");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.jmp("_scm_ready");
        vm.label("_scm_bare");
        vm.mov(VReg.V1, VReg.S0);
        vm.movImm(VReg.S0, 0);
        vm.label("_scm_ready");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A5, VReg.S1);
        vm.cmpImm(VReg.S4, 2);
        vm.jeq("_scm_argc2");
        vm.setCallArgcImm(1, VReg.V2, VReg.V3);
        vm.jmp("_scm_do");
        vm.label("_scm_argc2");
        vm.setCallArgcImm(2, VReg.V2, VReg.V3);
        vm.label("_scm_do");
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
    }

    _emitLoadWellknownSymbol(symName) {
        const vm = this.vm;
        vm.lea(VReg.A0, "_symwk_" + symName);
        vm.lea(VReg.A1, vm.asm.addString("Symbol." + symName));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
    }

    _emitSymDelegate(opts) {
        const vm = this.vm;
        const {
            symName, searchReg, thisReg, arg2Reg, argc,
            fallLabel, savedRegs, frameSize, tag,
        } = opts;
        const noMethod = "_ssd_nomethod_" + tag;
        vm.shrImm(VReg.V0, searchReg, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne(fallLabel);
        this._emitLoadWellknownSymbol(symName);
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, searchReg);
        vm.call("_str_getmethod");
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq(noMethod);
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, searchReg);
        vm.mov(VReg.A2, thisReg);
        if (argc === 2) {
            vm.mov(VReg.A3, arg2Reg);
            vm.movImm(VReg.A4, 2);
        } else {
            vm.movImm64(VReg.A3, 0x7ffb000000000000n);
            vm.movImm(VReg.A4, 1);
        }
        vm.call("_str_call_method");
        vm.epilogue(savedRegs, frameSize);
        vm.label(noMethod);
    }

    _emitReplaceAllRegExpGCheck(searchReg, tag) {
        const vm = this.vm;
        const notRe = "_rall_g_notre_" + tag;
        const hasG = "_rall_g_ok_" + tag;
        this._emitLoadWellknownSymbol("match");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, searchReg);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, searchReg);
        vm.call("_maybe_getter");
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq(notRe);
        vm.movImm64(VReg.V0, 0x7ffa000000000000n);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq(notRe);
        vm.movImm64(VReg.V0, 0x7ff9000000000000n);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq(notRe);
        vm.push(searchReg);
        vm.mov(VReg.A0, searchReg);
        vm.lea(VReg.A1, vm.asm.addString("flags"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_maybe_getter");
        vm.pop(searchReg);
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq("_rall_g_flags_err_" + tag);
        vm.movImm64(VReg.V0, 0x7ffa000000000000n);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq("_rall_g_flags_err_" + tag);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("g"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.movImm(VReg.A2, 0);
        vm.call("_str_indexOf");
        vm.cmpImm(VReg.RET, 0);
        vm.jge(hasG);
        vm.lea(VReg.A0, vm.asm.addString("String.prototype.replaceAll called with a non-global RegExp argument"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_rall_g_flags_err_" + tag);
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label(notRe);
        vm.label(hasG);
    }

    // 替换串 $ 模式展开。$$→字面 $、$&→匹配子串、$`→匹配前文、$'→匹配后文。
    // _replace_has_dollar(A0=repl) -> RET(1 含 '$' 否则 0):快路守卫,无 $ 时 replace/
    // replaceAll 走原字面路径零开销。
    // _replace_expand(A0=repl, A1=matched, A2=pre, A3=post) -> RET 展开后装箱串。
    // 段式:扫 repl,遇 $X 先把前面字面段 slice+concat,再拼入替换项;末尾拼尾字面段。
    // SP 局部:0=replContentPtr、8=i、16=segStart、24=len。S0-S4 跨 slice/concat 存活。
    generateReplaceExpand() {
        const vm = this.vm;
        this._reNL = 0;

        vm.label("_replace_has_dollar");
        vm.prologue(0, [VReg.S0]);
        vm.call("_getStrContent"); // A0=repl → RET content ptr
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_rhd_loop");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_rhd_no");
        vm.cmpImm(VReg.V0, 0x24); // '$'
        vm.jeq("_rhd_yes");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_rhd_loop");
        vm.label("_rhd_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 0);
        vm.label("_rhd_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);

        // acc(S4) += slice(repl(S0), boxStart, boxEnd)。start/end 为裸 int。
        const concatSlice = (startOff, endOff) => {
            // box start → A1, end → A2(V5=mask, V6=值;皆非 A 别名安全)
            vm.load(VReg.V6, VReg.SP, startOff);
            vm.movImm64(VReg.V5, 0xFFFFFFFFn); vm.and(VReg.A1, VReg.V6, VReg.V5);
            vm.movImm64(VReg.V5, 0x7FF8000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V5);
            vm.load(VReg.V6, VReg.SP, endOff);
            vm.movImm64(VReg.V5, 0xFFFFFFFFn); vm.and(VReg.A2, VReg.V6, VReg.V5);
            vm.movImm64(VReg.V5, 0x7FF8000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V5);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_str_slice_bytes");
            vm.mov(VReg.A1, VReg.RET);
            vm.mov(VReg.A0, VReg.S4);
            vm.call("_strconcat");
            vm.mov(VReg.S4, VReg.RET);
        };
        // acc(S4) += whole string in reg-held boxed str (matched/pre/post)
        const concatWhole = (sreg) => {
            vm.mov(VReg.A1, sreg);
            vm.mov(VReg.A0, VReg.S4);
            vm.call("_strconcat");
            vm.mov(VReg.S4, VReg.RET);
        };

        vm.label("_replace_expand");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // repl
        vm.mov(VReg.S1, VReg.A1); // matched
        vm.mov(VReg.S2, VReg.A2); // pre
        vm.mov(VReg.S3, VReg.A3); // post
        // 快路:无 '$' → 原样返回 repl
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_replace_has_dollar");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_rexp_ret_repl");
        // acc = "" 装箱空串
        vm.lea(VReg.RET, "_str_empty");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V5);
        vm.movImm64(VReg.V5, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V5);
        vm.mov(VReg.S4, VReg.RET);
        // replContentPtr, len
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.store(VReg.SP, 24, VReg.RET);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V0);  // i
        vm.store(VReg.SP, 16, VReg.V0); // segStart

        vm.label("_rexp_loop");
        vm.load(VReg.V1, VReg.SP, 8);   // i
        vm.load(VReg.V2, VReg.SP, 24);  // len
        vm.cmp(VReg.V1, VReg.V2);
        vm.jge("_rexp_trailing");
        vm.load(VReg.V0, VReg.SP, 0);   // ptr
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.loadByte(VReg.V3, VReg.V0, 0); // c
        vm.cmpImm(VReg.V3, 0x24);
        vm.jne("_rexp_advance");
        // '$';需 i+1 < len
        vm.addImm(VReg.V4, VReg.V1, 1);
        vm.load(VReg.V2, VReg.SP, 24);
        vm.cmp(VReg.V4, VReg.V2);
        vm.jge("_rexp_advance");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.add(VReg.V0, VReg.V0, VReg.V4);
        vm.loadByte(VReg.V3, VReg.V0, 0); // c2
        vm.cmpImm(VReg.V3, 0x24); vm.jeq("_rexp_dollar"); // '$'
        vm.cmpImm(VReg.V3, 0x26); vm.jeq("_rexp_amp");    // '&'
        vm.cmpImm(VReg.V3, 0x60); vm.jeq("_rexp_pre");    // '`'
        vm.cmpImm(VReg.V3, 0x27); vm.jeq("_rexp_post");   // '\''
        vm.jmp("_rexp_advance"); // '$'+其他 → 字面

        // 各 token:先 flush 字面段 repl[segStart..i],再拼替换项,i+=2,segStart=i
        const flushLit = () => {
            vm.load(VReg.V1, VReg.SP, 8);  // i
            vm.load(VReg.V2, VReg.SP, 16); // segStart
            vm.cmp(VReg.V1, VReg.V2);
            vm.jle("_rexp_nolit_" + this._reNL);
            concatSlice(16, 8); // slice(segStart, i)
            vm.label("_rexp_nolit_" + this._reNL);
            this._reNL++;
        };
        const advance2 = () => {
            vm.load(VReg.V1, VReg.SP, 8);
            vm.addImm(VReg.V1, VReg.V1, 2);
            vm.store(VReg.SP, 8, VReg.V1);
            vm.store(VReg.SP, 16, VReg.V1); // segStart = i+2
            vm.jmp("_rexp_loop");
        };

        vm.label("_rexp_dollar"); // $$ → 字面 '$':拼 slice(repl, i, i+1)
        flushLit();
        // 拼 "$" = slice(repl, i, i+1):segStart 位置无用,借临时:box i、i+1
        vm.load(VReg.V6, VReg.SP, 8);
        vm.movImm64(VReg.V5, 0xFFFFFFFFn); vm.and(VReg.A1, VReg.V6, VReg.V5);
        vm.movImm64(VReg.V5, 0x7FF8000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V5);
        vm.load(VReg.V6, VReg.SP, 8); vm.addImm(VReg.V6, VReg.V6, 1);
        vm.movImm64(VReg.V5, 0xFFFFFFFFn); vm.and(VReg.A2, VReg.V6, VReg.V5);
        vm.movImm64(VReg.V5, 0x7FF8000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V5);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_slice_bytes");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_strconcat");
        vm.mov(VReg.S4, VReg.RET);
        advance2();

        vm.label("_rexp_amp"); // $& → matched
        flushLit(); concatWhole(VReg.S1); advance2();
        vm.label("_rexp_pre"); // $` → pre
        flushLit(); concatWhole(VReg.S2); advance2();
        vm.label("_rexp_post"); // $' → post
        flushLit(); concatWhole(VReg.S3); advance2();

        vm.label("_rexp_advance");
        vm.load(VReg.V1, VReg.SP, 8);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.SP, 8, VReg.V1);
        vm.jmp("_rexp_loop");

        vm.label("_rexp_trailing"); // 拼尾字面段 repl[segStart..len]
        vm.load(VReg.V1, VReg.SP, 24); // len
        vm.load(VReg.V2, VReg.SP, 16); // segStart
        vm.cmp(VReg.V1, VReg.V2);
        vm.jle("_rexp_ret_acc");
        concatSlice(16, 24);
        vm.label("_rexp_ret_acc");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);

        vm.label("_rexp_ret_repl");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);
    }

    // _str_replace(str, search, repl) -> 首个 search 替换为 repl 的新串（字符串 search）
    // 组合已验证运行时:_str_indexOf 定位 + _str_slice 切两段 + _strconcat 拼接。
    // 无匹配返回原串。空 search 命中 index 0(与 JS 一致,插到串首)。
    generateReplace() {
        const vm = this.vm;
        const replSaved = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];

        vm.label("_str_replace");
        vm.prologue(16, replSaved); // SP:0=left,8=right
        vm.mov(VReg.S0, VReg.A0); // str / O
        vm.mov(VReg.S1, VReg.A1); // search
        vm.mov(VReg.S2, VReg.A2); // repl
        {
            const skipSym = "_replace_skip_sym";
            vm.lea(VReg.V0, "_js_undefined");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.movImm64(VReg.V0, 0x7ffa000000000000n);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            this._emitSymDelegate({
                symName: "replace", searchReg: VReg.S1, thisReg: VReg.S0,
                arg2Reg: VReg.S2, argc: 2, fallLabel: skipSym,
                savedRegs: replSaved, frameSize: 16, tag: "replace",
            });
            vm.label(skipSym);
        }
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("replace");
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_replace_not_fn");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_str_replace_fn");
        vm.epilogue(replSaved, 16);
        vm.label("_replace_not_fn");
        // ToString(searchValue) is observable and precedes ToString of a
        // non-callable replacement value.  Keep this order so an abrupt
        // search conversion wins (`replace(objThatThrows, otherObj)`).
        this._emitArgStrInline(VReg.S1, "_replace_search");
        this._emitArgStrInline(VReg.S2, "_replace_repl");

        // idx = indexOf(str, search)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0); // fromIndex=0(第三参必须显式置)
        vm.call("_str_indexOf");
        vm.mov(VReg.S3, VReg.RET); // S3 = idx
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_replace_nomatch"); // idx < 0 → 原串

        // len = strlen(content(str))
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.mov(VReg.S4, VReg.RET); // S4 = len
        // searchLen = strlen(content(search))
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.mov(VReg.S5, VReg.RET); // S5 = searchLen

        // left = slice(str, 0, idx) → 存 SP+0(既是拼接段,也作 $` 的 pre)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, 0x7FF8000000000000n); // box 0
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A2, VReg.S3, VReg.V0);
        vm.or(VReg.A2, VReg.A2, VReg.V1); // box idx
        vm.call("_str_slice_bytes");
        vm.store(VReg.SP, 0, VReg.RET); // left

        // rightStart = idx + searchLen（idx/S3 释放,存 rightStart 于 S3）
        vm.add(VReg.S3, VReg.S3, VReg.S5);
        // right = slice(str, rightStart, len) → 存 SP+8(拼接段 + $' 的 post)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A1, VReg.S3, VReg.V0);
        vm.or(VReg.A1, VReg.A1, VReg.V1); // box rightStart
        vm.and(VReg.A2, VReg.S4, VReg.V0);
        vm.or(VReg.A2, VReg.A2, VReg.V1); // box len
        vm.call("_str_slice_bytes");
        vm.store(VReg.SP, 8, VReg.RET); // right

        // repl 展开 $ 模式:_replace_expand(repl=S2, matched=search=S1, pre=left, post=right)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.load(VReg.A3, VReg.SP, 8);
        vm.call("_replace_expand");
        vm.mov(VReg.S2, VReg.RET); // S2 = 展开后的 repl

        // result = left + expandedRepl + right
        vm.load(VReg.A0, VReg.SP, 0); // left
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_strconcat");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 8); // right
        vm.call("_strconcat");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        vm.label("_replace_nomatch");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // _str_replace_fn(A0=str, A1=search, A2=fn 闭包) -> RET:函数替换(仅首个匹配,字符串 search)。
        // 匹配子串=search;调用 fn(matched) 取替换串,拼 left+repl+right。闭包约定:S0=闭包指针、
        // [闭包+8]=真函数指针、A0=matched、A5=this(undefined)。str 在闭包调用前存栈(S0 要作闭包指针)。
        vm.label("_str_replace_fn");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // str
        vm.mov(VReg.S1, VReg.A1); // search
        vm.mov(VReg.S2, VReg.A2); // fn 闭包
        // Normalize searchValue once up front.  `_str_indexOf` performs a
        // temporary ToString internally, but the callback path also needs
        // the normalized value to compute searchLen and the trailing slice
        // (undefined must become the literal string "undefined").
        this._emitArgStrInline(VReg.S1, "_replace_fn_search");
        // idx = indexOf(str, search, 0)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0);
        vm.call("_str_indexOf");
        vm.mov(VReg.S3, VReg.RET);
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_replfn_nomatch");
        // len / searchLen(闭包调用前算,此时 str/search 在 S0/S1)
        vm.mov(VReg.A0, VReg.S0); vm.call("_getStrContent"); vm.mov(VReg.A0, VReg.RET); vm.call("_strlen"); vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_getStrContent"); vm.mov(VReg.A0, VReg.RET); vm.call("_strlen"); vm.mov(VReg.S5, VReg.RET);
        vm.store(VReg.SP, 0, VReg.S0); // 存 str(S0 即将改作闭包指针)
        // 调 fn(matched, offset, wholeString)。String#replace 的函数
        // replacer 始终收到这三个实参；仅传 matched 会令
        // `arguments[1]` 变成 undefined（例如 `arguments[1] + 42`）。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S2, VReg.V1); // V0 = 闭包指针
        vm.load(VReg.V1, VReg.V0, 8);      // 真函数指针
        vm.mov(VReg.A0, VReg.S1);          // matched
        vm.scvtf(0, VReg.S3);              // offset -> Number bits
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);          // original string
        vm.movImm64(VReg.A5, 0x7ffb000000000000n); // this = undefined
        vm.mov(VReg.S0, VReg.V0);          // S0 = 闭包指针(函数体入口约定)
        vm.setCallArgcImm(3, VReg.V2, VReg.V3); // [argc ABI] fn(matched,offset,string)
        vm.callIndirect(VReg.V1);          // RET = 替换串(装箱)
        vm.mov(VReg.S2, VReg.RET);         // S2 = repl(fn 不再用)
        vm.load(VReg.S0, VReg.SP, 0);      // 重载 str
        // left = slice(str, 0, idx)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, 0x7FF8000000000000n);
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A2, VReg.S3, VReg.V0); vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_str_slice_bytes");
        // acc = left + repl
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_strconcat"); vm.mov(VReg.S2, VReg.RET);
        // right = slice(str, idx+searchLen, len)
        vm.add(VReg.S3, VReg.S3, VReg.S5);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A1, VReg.S3, VReg.V0); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.and(VReg.A2, VReg.S4, VReg.V0); vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_str_slice_bytes");
        vm.mov(VReg.A1, VReg.RET); vm.mov(VReg.A0, VReg.S2); vm.call("_strconcat");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
        vm.label("_replfn_nomatch");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
    }

    // _str_replaceAll(str, search, repl) -> 替换所有非重叠 search 的新串（字符串 search）
    // 对「剩余后缀」反复 indexOf-from-0:每命中把 [0,idx)+repl 追加进 acc,剩余推进到
    // idx+searchLen。空 search(searchLen==0)会 idx 恒 0 死循环,故守卫为返回原串
    // (与 JS 的 "abc".replaceAll("","X")="XaXbXcX" 有出入,属已知偏差,换取安全)。
    generateReplaceAll() {
        const vm = this.vm;
        const replAllSaved = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];

        vm.label("_str_replaceAll");
        // SP+0=hasDollar, SP+8=original string, SP+16=consumed prefix,
        // SP+24=current original prefix used by `$`` substitution.
        vm.prologue(32, replAllSaved);
        vm.mov(VReg.S0, VReg.A0); // remaining / O
        vm.mov(VReg.S1, VReg.A1); // search
        vm.mov(VReg.S2, VReg.A2); // repl
        vm.store(VReg.SP, 8, VReg.S0); // retain original string for `$``
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0); // consumed bytes before remaining
        {
            const skipSym = "_replaceAll_skip_sym";
            vm.lea(VReg.V0, "_js_undefined");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.movImm64(VReg.V0, 0x7ffa000000000000n);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.shrImm(VReg.V0, VReg.S1, 48);
            vm.cmpImm(VReg.V0, 0x7FFD);
            vm.jne(skipSym);
            this._emitReplaceAllRegExpGCheck(VReg.S1, "rall");
            this._emitSymDelegate({
                symName: "replace", searchReg: VReg.S1, thisReg: VReg.S0,
                arg2Reg: VReg.S2, argc: 2, fallLabel: skipSym,
                savedRegs: replAllSaved, frameSize: 32, tag: "replaceAll",
            });
            vm.label(skipSym);
        }
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("replaceAll");
        vm.mov(VReg.S0, VReg.A0);
        // Keep the already-normalized string for `$`` prefix slices.  The
        // frame slot is read once per match; retaining the original object
        // there would re-run user @@toPrimitive/toString for every match
        // (and violate replaceAll's single receiver ToString step).
        vm.store(VReg.SP, 8, VReg.S0);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_replaceAll_not_fn");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_str_replaceAll_fn");
        vm.epilogue(replAllSaved, 32);
        vm.label("_replaceAll_not_fn");
        // ES order: ToString(searchValue) precedes IsCallable/ToString of the
        // replacement.  The function-replacer branch above has already
        // returned, so this path only needs the non-callable conversion.
        this._emitArgStrInline(VReg.S1, "_replaceAll_search");
        this._emitArgStrInline(VReg.S2, "_replaceAll_repl");

        // [L3] RegExp detection: two code paths:
        //   (a) raw heap pointer with TYPE_REGEXP(8) — compiled-in RegExp literal
        //   (b) boxed 0x7FFD object with __isRegExp truthy — new RegExp(...)
        // Both delegate to _regexp_split + _array_join.
        const replaceAllNotRe = "_replaceAll_not_re";
        const replaceAllReBox = "_replaceAll_re_box";
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq(replaceAllReBox);
        // (a) raw heap pointer
        vm.cmpImm(VReg.V1, 0);
        vm.jne(replaceAllNotRe);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq(replaceAllNotRe);
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jb(replaceAllNotRe);
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jae(replaceAllNotRe);
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, 8); // TYPE_REGEXP
        vm.jne(replaceAllNotRe);
        // RegExp path: str.split(re).join(repl)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.movImm64(VReg.A2, 0x7FFFFFFFn);
        vm.call("_regexp_split");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_join");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        // (b) boxed 0x7FFD object
        vm.label(replaceAllReBox);
        vm.push(VReg.S0); vm.push(VReg.S2);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("__isRegExp"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.call("_object_get");
        vm.cmpImm(VReg.RET, 0);
        vm.pop(VReg.S2); vm.pop(VReg.S0);
        vm.jeq(replaceAllNotRe);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("__pat"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.call("_object_get");
        vm.push(VReg.S3);
        vm.mov(VReg.S3, VReg.RET); // S3 = boxed pattern
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm64(VReg.A2, 0x7FFFFFFFn);
        vm.call("_regexp_split");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_join");
        vm.pop(VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label(replaceAllNotRe);

        // searchLen；==0 → 返回原串（守卫死循环）
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.mov(VReg.S4, VReg.RET); // S4 = searchLen
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_replaceAll_wholestr");

        // acc = "" (boxed empty)
        vm.lea(VReg.RET, "_str_empty");
        {
            const maskReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.movImm64(maskReg, 0x0000ffffffffffffn);
            vm.and(VReg.RET, VReg.RET, maskReg);
        }
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.mov(VReg.S3, VReg.RET); // S3 = acc

        // repl 是否含 '$'(循环不变量,SP+0 暂存);无则每次拼原 repl 零开销
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_replace_has_dollar");
        vm.store(VReg.SP, 0, VReg.RET);

        vm.label("_replaceAll_loop");
        // idx = indexOf(remaining, search)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0); // fromIndex=0(第三参必须显式置)
        vm.call("_str_indexOf");
        vm.mov(VReg.S5, VReg.RET); // S5 = idx
        vm.cmpImm(VReg.S5, 0);
        vm.jlt("_replaceAll_done"); // 无更多匹配

        // `$`` is the prefix of the original string, not the already
        // accumulated replacement output.  Compute that prefix before
        // mutating S0 (the remaining suffix), using bytes consumed by prior
        // matches plus this match's local index.
        vm.load(VReg.V0, VReg.SP, 16);
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.A2, VReg.V0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1); // box original-prefix end
        vm.load(VReg.A0, VReg.SP, 8);     // original string
        vm.movImm64(VReg.A1, 0x7FF8000000000000n); // box 0
        vm.call("_str_slice_bytes");
        vm.store(VReg.SP, 24, VReg.RET);
        // Update the consumed-prefix cursor while SP still points at the
        // frame base (the left segment is pushed immediately below).
        vm.add(VReg.V3, VReg.S5, VReg.S4);
        vm.load(VReg.V0, VReg.SP, 16);
        vm.add(VReg.V0, VReg.V0, VReg.V3);
        vm.store(VReg.SP, 16, VReg.V0);

        // 关键:_strconcat 只保存 S0-S4(不保存 S5=idx),故必须在两次 concat 之前
        // 就用 idx 把两段 slice 都算完;left 暂存栈上跨过后续调用。
        // left = slice(remaining, 0, idx)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, 0x7FF8000000000000n); // box 0
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A2, VReg.S5, VReg.V0);
        vm.or(VReg.A2, VReg.A2, VReg.V1); // box idx
        vm.call("_str_slice_bytes");
        vm.push(VReg.RET); // [left]

        // lenRemaining（idx/S5 仍有效,此后不再需要）
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.mov(VReg.V2, VReg.RET); // V2 = lenRemaining（到 slice 无调用,V 可留）
        vm.add(VReg.V3, VReg.S5, VReg.S4); // rightStart = idx + searchLen
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A1, VReg.V3, VReg.V0);
        vm.or(VReg.A1, VReg.A1, VReg.V1); // box rightStart
        vm.and(VReg.A2, VReg.V2, VReg.V0);
        vm.or(VReg.A2, VReg.A2, VReg.V1); // box lenRemaining
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_slice_bytes");
        vm.mov(VReg.S0, VReg.RET); // remaining = 后缀（idx 已用完,concat 可放心clobber S5）

        // acc = acc + left（left 从栈弹回）
        vm.mov(VReg.A0, VReg.S3);
        vm.pop(VReg.A1); // left（弹出后 SP 归位,SP+0 = hasDollar）
        vm.call("_strconcat");
        vm.mov(VReg.S3, VReg.RET);
        // acc += repl(含 $ 则展开):matched=search(S1)、post=remaining(S0)、
        // pre=the original prefix computed above.
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_replaceAll_plainrepl");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.load(VReg.A2, VReg.SP, 24);
        vm.mov(VReg.A3, VReg.S0);
        vm.call("_replace_expand");
        vm.mov(VReg.A1, VReg.RET);
        vm.jmp("_replaceAll_dorepl");
        vm.label("_replaceAll_plainrepl");
        vm.mov(VReg.A1, VReg.S2);
        vm.label("_replaceAll_dorepl");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_strconcat");
        vm.mov(VReg.S3, VReg.RET);
        vm.jmp("_replaceAll_loop");

        vm.label("_replaceAll_done");
        // acc + remaining
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_strconcat");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // [W-25] 空 searchValue:ES StringIndexOf 对空串在每个位置(0..len,含末尾)命中,
        // 故结果 = repl + s[0] + repl + s[1] + ... + s[len-1] + repl
        // ("".replaceAll("","abc") === "abc";"xy".replaceAll("","-") === "-x-y-")。
        // 此前直接返回原串(仅为守住死循环)。
        // 寄存器约束:_strconcat/_alloc 只保证 S0-S4,故 len/i 存栈帧(SP+0/SP+8),
        // acc 用 S3(跨 _strconcat 存活)。此路径先于 hasDollar 计算,SP 两槽都空闲。
        vm.label("_replaceAll_wholestr");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.store(VReg.SP, 0, VReg.RET); // len
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 8, VReg.V1);  // i = 0
        vm.lea(VReg.RET, "_str_empty");
        {
            const maskReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.movImm64(maskReg, 0x0000ffffffffffffn);
            vm.and(VReg.RET, VReg.RET, maskReg);
        }
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.mov(VReg.S3, VReg.RET); // acc = ""
        vm.label("_replaceAll_empty_loop");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_strconcat"); // acc += repl
        vm.mov(VReg.S3, VReg.RET);
        vm.load(VReg.V1, VReg.SP, 8); // i
        vm.load(VReg.V3, VReg.SP, 0); // len
        vm.cmp(VReg.V1, VReg.V3);
        vm.jge("_replaceAll_empty_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_str_charAt"); // 1 字节子串(字节模型下拼回等价原串)
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_strconcat"); // acc += s[i]
        vm.mov(VReg.S3, VReg.RET);
        vm.load(VReg.V1, VReg.SP, 8);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.SP, 8, VReg.V1);
        vm.jmp("_replaceAll_empty_loop");
        vm.label("_replaceAll_empty_done");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
    }

    // _str_replaceAll_fn(A0=str, A1=search, A2=fn 闭包) -> RET:函数替换所有匹配。
    // String-search replacers receive (matched, position, string), with
    // `this` set to undefined (ordinary sloppy functions box it to global).
    // Registers: S0=remaining, S1=search, S2=fn, S3=acc, S4=searchLen,
    // S5=newRemaining.  Frame slots: SP+0=idx/absolute position/repl,
    // SP+8=left, SP+16=original string, SP+24=consumed prefix.
    generateReplaceAllFn() {
        const vm = this.vm;

        vm.label("_str_replaceAll_fn");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // remaining(初值 = str)
        vm.mov(VReg.S1, VReg.A1); // search
        vm.mov(VReg.S2, VReg.A2); // fn closure
        this._emitArgStrInline(VReg.S1, "_replaceAllFn_search");
        vm.store(VReg.SP, 16, VReg.S0); // original string
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 24, VReg.V0); // bytes consumed before remaining

        // searchLen==0 still invokes the replacer once at position 0.
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.mov(VReg.S4, VReg.RET); // S4 = searchLen
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_replAllFn_wholestr");

        // acc = ""(boxed empty)
        vm.lea(VReg.RET, "_str_empty");
        {
            const maskReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.movImm64(maskReg, 0x0000ffffffffffffn);
            vm.and(VReg.RET, VReg.RET, maskReg);
        }
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.mov(VReg.S3, VReg.RET); // S3 = acc

        vm.label("_replAllFn_loop");
        // ---- Step 1: idx = indexOf(remaining, search, 0) ----
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0);
        vm.call("_str_indexOf");
        // S0-S4 preserved by call. RET = raw idx or -1.
        vm.store(VReg.SP, 0, VReg.RET); // SP+0 = idx
        vm.cmpImm(VReg.RET, -1);
        vm.jeq("_replAllFn_done");

        // ---- Step 2: left = slice(remaining, 0, idx) ----
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, 0x7FF8000000000000n); // box 0
        vm.load(VReg.A2, VReg.SP, 0);              // idx(raw), gets boxed
        {
            const mask = vm.backend.name === "x64" ? VReg.V2 : VReg.V1;
            vm.movImm64(mask, 0xFFFFFFFFn);
            vm.and(VReg.A2, VReg.A2, mask);
        }
        vm.movImm64(VReg.V2, 0x7FF8000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V2);          // box idx
        vm.call("_str_slice_bytes");
        // S0-S4 preserved. RET = boxed left string.
        vm.store(VReg.SP, 8, VReg.RET);            // SP+8 = left

        // ---- Step 3: compute new remaining = slice(remaining, idx+searchLen, lenRemaining) ----
        // Get lenRemaining first, before setting up A0/A1/A2 for _str_slice
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");                        // RET = lenRemaining(raw int)
        vm.mov(VReg.S5, VReg.RET);                 // S5 = lenRemaining(raw,暂存)
        // Now set up A0/A1/A2 for _str_slice
        vm.mov(VReg.A0, VReg.S0);                 // A0 = remaining (boxed string)
        vm.load(VReg.A1, VReg.SP, 0);             // A1 = idx(raw)
        vm.add(VReg.A1, VReg.A1, VReg.S4);        // A1 = idx + searchLen = rightStart(raw)
        {
            const mask = vm.backend.name === "x64" ? VReg.V2 : VReg.V1;
            vm.movImm64(mask, 0xFFFFFFFFn);
            vm.and(VReg.A1, VReg.A1, mask);
        }
        vm.movImm64(VReg.V2, 0x7FF8000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);         // box rightStart
        vm.mov(VReg.A2, VReg.S5);                 // A2 = lenRemaining(raw, from S5)
        {
            const mask = vm.backend.name === "x64" ? VReg.V2 : VReg.V1;
            vm.movImm64(mask, 0xFFFFFFFFn);
            vm.and(VReg.A2, VReg.A2, mask);
        }
        vm.or(VReg.A2, VReg.A2, VReg.V2);         // box lenRemaining
        vm.call("_str_slice_bytes");
        // S0-S4 preserved. RET = new remaining (boxed string).
        vm.mov(VReg.S5, VReg.RET);                // S5 = new remaining (overwrites lenRemaining)

        // Absolute position = consumed prefix + local idx.  Save it in the
        // idx slot before advancing consumed through this match.
        vm.load(VReg.V0, VReg.SP, 24);
        vm.load(VReg.V1, VReg.SP, 0);
        vm.add(VReg.V2, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V2);            // SP+0 = absolute position
        vm.add(VReg.V1, VReg.V1, VReg.S4);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 24, VReg.V0);           // consumed through match

        // ---- Step 4: call fn(matched, position, originalString) ----
        // OrdinaryCallBindThis is observable for sloppy callbacks (undefined
        // this becomes globalThis).  Keep the call-argc write before loading
        // the user arguments: on x64 V2/V3 alias A2/A4, so using either as a
        // scratch after argument setup would otherwise clobber arg2/arg4.
        // The callback's rest/arguments machinery also stops at an explicit
        // undefined sentinel; clear A3/A4 so the stale code pointer is not
        // exposed as a fourth user argument.
        vm.setCallArgcImm(3, VReg.V5, VReg.V6);   // argc = 3 (non-arg scratch)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V6, VReg.S2, VReg.V1); // closure pointer again
        vm.mov(VReg.S0, VReg.V6);                 // raw closure pointer for captured vars
        // Bind undefined this through the shared callback helper; it performs
        // OrdinaryCallBindThis (sloppy callbacks receive globalThis) and keeps
        // the closure's strictness metadata in one place.
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm64(VReg.A1, 0x7ffb000000000000n);
        vm.call("_coll_cb_this");
        vm.mov(VReg.A5, VReg.RET);
        vm.load(VReg.V6, VReg.S0, 8);             // real function pointer
        vm.mov(VReg.A0, VReg.S1);                 // matched = search
        vm.load(VReg.V2, VReg.SP, 0);             // absolute position (raw int)
        vm.scvtf(0, VReg.V2);
        vm.fmovToInt(VReg.A1, 0);                 // position as Number
        vm.load(VReg.A2, VReg.SP, 16);            // original string
        vm.movImm64(VReg.A3, 0x7ffb000000000000n);
        vm.movImm64(VReg.A4, 0x7ffb000000000000n);
        vm.callIndirect(VReg.V6);                 // RET = replacement string (boxed)
        // callIndirect preserves S0-S5. RET = replacement string (boxed).
        vm.store(VReg.SP, 0, VReg.RET);           // SP+0 = replacement

        // Restore acc from... wait, I overwrote it. Need to restore from somewhere.
        // Actually, acc was in S3 which is preserved across callIndirect. But I stored
        // it to SP+0 and then overwrote SP+0 with repl. S3 should still hold the acc
        // value since S registers are callee-saved.

        // ---- Step 5: acc = acc + left + repl ----
        // But wait, after callIndirect:
        // S3 = acc (preserved)
        // S5 = new remaining (preserved)
        // S1 = search (preserved)
        // S2 = fn (preserved)
        // S4 = searchLen (preserved)
        // But S0 was overwritten to closure pointer!
        // Need to load S0 = new remaining from S5 (which saved it).

        vm.mov(VReg.S0, VReg.S5);                 // restore remaining from S5
        vm.load(VReg.A1, VReg.SP, 8);             // A1 = left
        vm.mov(VReg.A0, VReg.S3);                 // A0 = acc
        vm.call("_strconcat");                    // RET = acc + left (clobbers V regs)
        // S0-S4 preserved. RET = acc+left.
        vm.mov(VReg.S3, VReg.RET);                // S3 = acc+left
        vm.load(VReg.A1, VReg.SP, 0);             // A1 = repl
        vm.mov(VReg.A0, VReg.S3);                 // A0 = acc+left
        vm.call("_strconcat");                    // RET = acc+left+repl = new acc
        vm.mov(VReg.S3, VReg.RET);                // S3 = new acc
        vm.jmp("_replAllFn_loop");

        vm.label("_replAllFn_done");
        // acc + remaining
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_strconcat");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        vm.label("_replAllFn_wholestr");
        // Empty search matches once at position 0 (the input string is empty
        // in the current low-level path's callers, but preserve the general
        // original value for callback argument 3).
        vm.setCallArgcImm(3, VReg.V5, VReg.V6);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V6, VReg.S2, VReg.V1);
        vm.mov(VReg.S0, VReg.V6);                 // raw closure pointer for captured vars
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm64(VReg.A1, 0x7ffb000000000000n);
        vm.call("_coll_cb_this");
        vm.mov(VReg.A5, VReg.RET);
        vm.load(VReg.V6, VReg.S0, 8);
        vm.mov(VReg.A0, VReg.S1);                 // matched = ""
        vm.movImm64(VReg.A1, 0x7FF8000000000000n); // position 0
        vm.load(VReg.A2, VReg.SP, 16);            // original string
        vm.movImm64(VReg.A3, 0x7ffb000000000000n);
        vm.movImm64(VReg.A4, 0x7ffb000000000000n);
        vm.callIndirect(VReg.V6);
        // ToString(callback result) is observable; _str_argstr handles the
        // ordinary string case and performs the full conversion otherwise.
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_str_argstr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
    }

    // _num_toString(value, radix_raw) -> 装箱字符串
    // value: 装箱 int32 或裸 float64(经 _to_int32 取整);radix: 裸 int。
    // ES Number.prototype.toString: radix < 2 or > 36 → RangeError (was clamp-to-10).
    // 小数部分不输出(JS 会输出基数小数,暂不支持)。倒序填 scratch 缓冲后
    // 经 _cstr_to_heap_str 建串——避免手写串头(见 runtime-helper 契约教训)。
    generateNumToString() {
        const vm = this.vm;

        vm.label("_num_toString");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S1, VReg.A1); // radix(入口捕获,后续调用会冲 A1)
        // Spec: radix undefined → 10. x64 leftover A1 is 0, a tagged
        // JSValue, or a naked heap ptr (high16=0, >= ptrFloor). Those are
        // not a real radix. Raw 2..36 still RangeError-checked so
        // toString(37) throws. toString(0) becomes 10 (rare leftover).
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_numts_radix_default");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_numts_radix_default");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jge("_numts_radix_default");
        vm.jmp("_numts_radix_have");
        vm.label("_numts_radix_default");
        vm.movImm(VReg.S1, 10);
        vm.label("_numts_radix_have");
        // RangeError before NaN/Inf early-out so NaN.toString(37) still throws.
        vm.cmpImm(VReg.S1, 2);
        vm.jlt("_numts_radix_err");
        vm.cmpImm(VReg.S1, 36);
        vm.jle("_numts_radix_checked");
        vm.label("_numts_radix_err");
        vm.lea(VReg.A0, vm.asm.addString("toString() radix argument must be between 2 and 36"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.label("_numts_radix_checked");
        // 值 → 64 位整数(替代 _to_int32:后者截 32 位符号,大整数 [2^31,2^53) 环绕出错,
        // 如 (3735928559).toString(16) 应 "deadbeef" 而非 "-21524111")。
        vm.mov(VReg.S0, VReg.A0);
        // BigInt 接收者:裸堆指针(high16==0),i64 值在 [ptr+0]。先低成本判 high16==0
        // 再 _is_bigint(带堆界守卫)确认,命中则取 i64 值直接进 conv_done。此前 bigint
        // 指针落 float 路径当 double → fcvtzs 饱和 0 →(255n).toString(16) 恒 "0"。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_numts_conv_start");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_numts_conv_start");
        vm.load(VReg.S0, VReg.S0, 0); // 64 位值
        vm.jmp("_numts_conv_done");
        vm.label("_numts_conv_start");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jne("_numts_conv_float");
        // 装箱 int32:低 32 位符号扩展
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.S0, VReg.S0, VReg.V1);
        vm.shlImm(VReg.S0, VReg.S0, 32);
        vm.sarImm(VReg.S0, VReg.S0, 32);
        vm.jmp("_numts_conv_done");
        vm.label("_numts_conv_float");
        // 裸 float64:NaN/Inf(指数全 1)→ 0(同旧 _to_int32,避免 fcvtzs 饱和出垃圾)
        vm.shrImm(VReg.V1, VReg.S0, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jeq("_numts_conv_zero");
        vm.fmovToFloat(0, VReg.S0);
        vm.fcvtzs(VReg.S0, 0); // S0 = (int64)截断(v)
        vm.jmp("_numts_conv_done");
        vm.label("_numts_conv_zero");
        // [W7-1] NaN/±Inf 特判(此前一律 0 → (NaN).toString(16) 得 "0"、(Infinity).toString()
        // 得 "0"):仅 high16 ∈ {0x7FF0,0xFFF0}(真 ±Inf/NaN 位型)时特判 —— 尾数非 0 →
        // "NaN",否则按 bit63 → "Infinity"/"-Infinity"(与 0 参 toString/_floatToString
        // 口径一致)。0x7FFC 等装箱 tag 族指数虽全 1 但非数字,保持旧 0 路径逐字节不变。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF0);
        vm.jeq("_numts_special");
        vm.cmpImm(VReg.V0, 0xFFF0);
        vm.jeq("_numts_special");
        vm.movImm(VReg.S0, 0);
        vm.jmp("_numts_conv_done");
        vm.label("_numts_special");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V1, VReg.S0, VReg.V1); // 尾数(低 52 位)
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_numts_nan");
        vm.shrImm(VReg.V1, VReg.S0, 63);   // 符号位
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_numts_neginf");
        vm.lea(VReg.RET, vm.asm.addString("Infinity"));
        vm.jmp("_numts_special_box");
        vm.label("_numts_neginf");
        vm.lea(VReg.RET, vm.asm.addString("-Infinity"));
        vm.jmp("_numts_special_box");
        vm.label("_numts_nan");
        vm.lea(VReg.RET, vm.asm.addString("NaN"));
        vm.label("_numts_special_box");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_numts_conv_done"); // S0 = int 值(64 位)

        // radix already validated ∈ [2,36]

        // scratch 缓冲(80B 足够 64 位二进制+符号+NUL)
        vm.movImm(VReg.A0, 80);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);      // S2 = buf
        vm.addImm(VReg.S3, VReg.S2, 79); // S3 = 写指针(倒填)
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S3, 0, VReg.V0); // NUL

        // 负号处理
        vm.movImm(VReg.S4, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jge("_numts_loop");
        vm.movImm(VReg.S4, 1);
        vm.movImm(VReg.V0, 0);
        vm.sub(VReg.S0, VReg.V0, VReg.S0);

        // do { digit = v % r; ch = digit<10 ? '0'+d : 'a'+d-10; *--p = ch; v /= r } while v
        vm.label("_numts_loop");
        vm.mod(VReg.V0, VReg.S0, VReg.S1); // digit
        vm.cmpImm(VReg.V0, 10);
        vm.jlt("_numts_dec");
        vm.addImm(VReg.V0, VReg.V0, 87); // 'a'-10
        vm.jmp("_numts_store");
        vm.label("_numts_dec");
        vm.addImm(VReg.V0, VReg.V0, 48); // '0'
        vm.label("_numts_store");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.storeByte(VReg.S3, 0, VReg.V0);
        vm.div(VReg.S0, VReg.S0, VReg.S1);
        vm.cmpImm(VReg.S0, 0);
        vm.jne("_numts_loop");

        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_numts_make");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.movImm(VReg.V0, 45); // '-'
        vm.storeByte(VReg.S3, 0, VReg.V0);

        vm.label("_numts_make");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_cstr_to_heap_str"); // RET = 装箱字符串
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // _num_toFixed(value_bits, digits_raw) -> 装箱字符串
    // 四舍五入:|v|*10^digits + 0.5 截断(与 V8 对常见值一致,含二进制表示效应)。
    // digits 钳 [0,20]。NaN/Inf 输入未定义(fcvtzs 饱和)。同 _num_toString 倒填缓冲。
    generateNumToFixed() {
        const vm = this.vm;

        vm.label("_num_toFixed");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.mov(VReg.S0, VReg.A0); // 值(装箱 int32 或裸 float 位)
        vm.mov(VReg.S1, VReg.A1); // digits

        // [W7-1] NaN/±Inf 特判(此前落截断/scale 路径 → (NaN).toFixed(2) 得 "0.00"、
        // ±Inf 得垃圾):仅 high16 ∈ {0x7FF0,0xFFF0}(真 ±Inf/NaN 位型)时 —— 尾数非 0 →
        // "NaN",否则按 bit63 → "Infinity"/"-Infinity"(与 node 一致:(Infinity).toFixed(2)
        // 得 "Infinity")。装箱 int32/tag 族/普通数全落原路径逐字节不变。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF0);
        vm.jeq("_numtf_special");
        vm.cmpImm(VReg.V0, 0xFFF0);
        vm.jeq("_numtf_special");
        vm.jmp("_numtf_body");
        vm.label("_numtf_special");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V1, VReg.S0, VReg.V1); // 尾数(低 52 位)
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_numtf_nan");
        vm.shrImm(VReg.V1, VReg.S0, 63);   // 符号位
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_numtf_neginf");
        vm.lea(VReg.RET, vm.asm.addString("Infinity"));
        vm.jmp("_numtf_special_box");
        vm.label("_numtf_neginf");
        vm.lea(VReg.RET, vm.asm.addString("-Infinity"));
        vm.jmp("_numtf_special_box");
        vm.label("_numtf_nan");
        vm.lea(VReg.RET, vm.asm.addString("NaN"));
        vm.label("_numtf_special_box");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_numtf_body");

        // digits 钳位 [0,20]
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_numtf_d_ge0");
        vm.movImm(VReg.S1, 0);
        vm.label("_numtf_d_ge0");
        vm.cmpImm(VReg.S1, 20);
        vm.jle("_numtf_d_ok");
        vm.movImm(VReg.S1, 20);
        vm.label("_numtf_d_ok");

        // 符号:bit63(裸 float);装箱 int32 走转换分支再判
        vm.movImm(VReg.S4, 0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jne("_numtf_raw_float");
        // 装箱 int32:低 32 位符号扩展 → d0
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.shlImm(VReg.V0, VReg.V0, 32);
        vm.sarImm(VReg.V0, VReg.V0, 32);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_numtf_int_pos");
        vm.movImm(VReg.S4, 1);
        vm.movImm(VReg.V1, 0);
        vm.sub(VReg.V0, VReg.V1, VReg.V0);
        vm.label("_numtf_int_pos");
        vm.scvtf(0, VReg.V0); // d0 = |int值|
        vm.jmp("_numtf_have_d0");

        vm.label("_numtf_raw_float");
        vm.shrImm(VReg.V0, VReg.S0, 63);
        vm.mov(VReg.S4, VReg.V0); // 符号位
        // -0.0(位 0x8000000000000000)按 spec 非负(ToFixed 的符号判据是 x<0,-0<0 为 false)
        // → 清符号,`(-0).toFixed(n)` 输出 "0.00" 无负号(其余负值 bit63 与 x<0 一致)。
        vm.movImm(VReg.V1, 1);
        vm.shlImm(VReg.V1, VReg.V1, 63);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jne("_numtf_not_negzero");
        vm.movImm(VReg.S4, 0);
        vm.label("_numtf_not_negzero");
        vm.movImm64(VReg.V1, 0x7FFFFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.S0, VReg.V1); // |v| 位型
        vm.fmovToFloat(0, VReg.V0);

        vm.label("_numtf_have_d0");
        // scale = 10^digits(整型累乘)
        vm.movImm(VReg.S2, 1);
        vm.mov(VReg.V2, VReg.S1);
        vm.label("_numtf_scale");
        vm.cmpImm(VReg.V2, 0);
        vm.jle("_numtf_scale_done");
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.S2, VReg.S2, VReg.V1);
        vm.subImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_numtf_scale");
        vm.label("_numtf_scale_done");

        // rounded = trunc(|v| * scale + 0.5)
        vm.scvtf(1, VReg.S2);
        vm.fmul(0, 0, 1);
        vm.movImm64(VReg.V0, 0x3FE0000000000000n); // 0.5
        vm.fmovToFloat(1, VReg.V0);
        vm.fadd(0, 0, 1);
        vm.fcvtzs(VReg.V0, 0);
        vm.mov(VReg.S0, VReg.V0); // S0 = rounded 总值

        // intPart = S0/scale → S5;frac = S0%scale → S0
        vm.div(VReg.S5, VReg.S0, VReg.S2);
        vm.mod(VReg.S0, VReg.S0, VReg.S2);

        // 缓冲倒填
        vm.movImm(VReg.A0, 80);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 79);
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S3, 0, VReg.V0); // NUL

        // digits==0(scale==1)→ 无小数部分
        vm.cmpImm(VReg.S2, 1);
        vm.jeq("_numtf_int_digits");
        // 小数位:恰 digits 个(S1 递减到 0)
        vm.label("_numtf_frac");
        vm.cmpImm(VReg.S1, 0);
        vm.jle("_numtf_dot");
        vm.movImm(VReg.V1, 10);
        vm.mod(VReg.V0, VReg.S0, VReg.V1);
        vm.addImm(VReg.V0, VReg.V0, 48);
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.storeByte(VReg.S3, 0, VReg.V0);
        vm.div(VReg.S0, VReg.S0, VReg.V1);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_numtf_frac");
        vm.label("_numtf_dot");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.movImm(VReg.V0, 46); // '.'
        vm.storeByte(VReg.S3, 0, VReg.V0);

        vm.label("_numtf_int_digits");
        // 整数位:do-while(0 也输出一位)
        vm.label("_numtf_int_loop");
        vm.movImm(VReg.V1, 10);
        vm.mod(VReg.V0, VReg.S5, VReg.V1);
        vm.addImm(VReg.V0, VReg.V0, 48);
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.storeByte(VReg.S3, 0, VReg.V0);
        vm.div(VReg.S5, VReg.S5, VReg.V1);
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_numtf_int_loop");

        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_numtf_make");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.movImm(VReg.V0, 45); // '-'
        vm.storeByte(VReg.S3, 0, VReg.V0);

        vm.label("_numtf_make");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_cstr_to_heap_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // 分割字符串
    // _str_split(str, separator) -> 数组
    generateSplit() {
        const vm = this.vm;
        { const dl = vm.asm.dataLabels || [];
          const ensure = (n) => { let f = false;
            for (let i = 0; i < dl.length; i++) { if (dl[i].name === n) { f = true; break; } }
            if (!f) { vm.asm.addDataLabel(n); vm.asm.addDataQword(0); } };
          ensure("_nsobj_array");
          ensure("_nsobj_array_proto"); }
        vm.label("_str_split");
        // 薄入口(64B/S0-S4,与 _strconcat 同形):用户 toString 抛错必须能 unwind。
        // 96B+S5 的 core 帧内抛会 SIGSEGV;@@split 查找也会。sep ToString 放在
        // this 强制之前,避免 _emitThisToString 的 extract 路径污染 S1。
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        // ES:separator 为 Object 时先 GetMethod(@@split),有则 Call(splitter, sep, « O, limit »),
        // **早于** ToString(O)/ToString(sep)。此前对 0x7FFD 直接 _valueToStr 会把
        // new RegExp 毁成 "/(?:)/" 字符串,@@split/空模式切字符全失效。
        {
            const skipSym = "_split_skip_sym";
            vm.lea(VReg.V0, "_js_undefined");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.movImm64(VReg.V0, 0x7ffa000000000000n);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.shrImm(VReg.V0, VReg.S1, 48);
            vm.cmpImm(VReg.V0, 0x7FFD);
            vm.jne(skipSym);
            // A2 already carries the original (boxed) limit value from the
            // compiler.  Preserve it for a custom @@split method; the
            // omitted-argument path is represented by the explicit
            // JS_UNDEFINED sentinel and is handled by the callee ABI.
            this._emitLoadWellknownSymbol("split");
            vm.mov(VReg.A1, VReg.RET);
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_str_getmethod");
            vm.lea(VReg.V0, "_js_undefined");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.RET, VReg.V0);
            vm.jeq(skipSym);
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S1); // this=separator
            vm.mov(VReg.A2, VReg.S0); // arg0=O (RequireObjectCoercible this)
            vm.mov(VReg.A3, VReg.S2); // arg1=limit
            vm.movImm(VReg.A4, 2);
            vm.call("_str_call_method");
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
            vm.label(skipSym);
        }
        // For the ordinary (no custom @@split) path the observable order is:
        //   ToString(this) → ToUint32(limit) → ToString(separator).
        // In particular, a throwing receiver must win over both separator
        // conversion and limit coercion, while a throwing limit must win over
        // a throwing separator.  Keep the original boxed values in S1/S2
        // until the custom-protocol branch above has returned.
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("split");
        vm.mov(VReg.S0, VReg.A0);
        // Generic method references arrive here with a boxed limit.  Convert
        // it only after receiver ToString and before separator ToString.
        vm.movImm64(VReg.V1, 0x7ffb000000000000n);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jeq("_str_split_limit_default");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_to_uint32");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_str_split_limit_ready");
        vm.label("_str_split_limit_default");
        vm.movImm64(VReg.S2, 0xffffffffn);
        vm.label("_str_split_limit_ready");

        // ToString(separator); undefined is intentionally left untouched for
        // the core path (where it means “return the whole string”).
        const sepReady = "_split_sep_ready";
        vm.movImm64(VReg.V1, 0x7ffb000000000000n);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq(sepReady);
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7ffc);
        vm.jeq(sepReady);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_split_sep_tostr");
        // A naked heap value (BigInt, Symbol, object, typed array, …) also
        // has high16==0, but is not a C-string pointer.  Only a heap block
        // whose header says TYPE_STRING may take the raw-pointer fast path;
        // data-section literals remain accepted outside the heap range.  This
        // avoids treating `1n` as an empty separator (`"a1b".split(1n)`).
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jlt("_split_sep_tostr");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_split_sep_tostr");
        vm.subImm(VReg.V0, VReg.S1, 16);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 6); // TYPE_STRING
        vm.jeq(sepReady);
        vm.jmp("_split_sep_tostr");
        // 0x7FFD:直接 ToString。不可先 _object_get(__isRegExp)——对 {toString:throw}
        // 的 get 会污染后续 _valueToStr 的 throw unwind(SIGSEGV)。
        // 字面量 RegExp 是裸 TYPE_REGEXP(high16=0),已在上方跳过。
        // @@split 已在上方处理;走到这里的 0x7FFD 是无 @@split 的普通对象。
        vm.label("_split_sep_tostr");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.S1, VReg.RET);
        vm.label(sepReady);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_str_split_core");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        vm.label("_str_split_core");
        vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);          // 已 ToString 的 this
        vm.mov(VReg.S1, VReg.A1);          // 已 ToString 的 sep(或 undefined)
        vm.store(VReg.SP, 8, VReg.A2);     // ToUint32(lim)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S3, VReg.RET);
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_split_box_s3");
        // [W-25] separator === undefined → 整串作单元素返回(ES 21.1.3.23 step 8)。
        // 必须在 ToString 之前判:此前 undefined 被 _getStrContent 判非法 → 空串 →
        // 落逐字符路径("abc".split(undefined) 得 ["a","b","c"],test262 separator-undef)。
        // 注:无参 split() 由 dispatch 传 _str_empty(裸指针),与 split("") 不可区分,
        // 仍走逐字符——那是 dispatch 侧的信息丢失,运行时无从恢复。
        vm.movImm64(VReg.V1, 0x7ffb000000000000n);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_split_undef_sep");
        // [L3] RegExp separator: two code paths:
        //   (a) raw heap pointer with TYPE_REGEXP(8) — compiled-in RegExp literal
        //   (b) boxed 0x7FFD object with __isRegExp truthy — new RegExp(...)
        // Both delegate to _regexp_split(re_ptr, str_ptr, limit).
        {
            const splitReNot = "_split_re_not";
            const splitReBox = "_split_re_box";
            vm.shrImm(VReg.V1, VReg.S1, 48);
            vm.cmpImm(VReg.V1, 0x7FFD);
            vm.jeq(splitReBox);
            // (a) raw heap pointer: [L3]
            vm.cmpImm(VReg.V1, 0);
            vm.jne(splitReNot);
            vm.cmpImm(VReg.S1, 0);
            vm.jeq(splitReNot);
            vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
            vm.cmp(VReg.S1, VReg.V1); vm.jb(splitReNot);
            vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
            vm.cmp(VReg.S1, VReg.V1); vm.jae(splitReNot);
            vm.loadByte(VReg.V1, VReg.S1, 0);
            vm.cmpImm(VReg.V1, 8); // TYPE_REGEXP
            vm.jne(splitReNot);
            // 提取 str content 指针
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_getStrContent");
            vm.mov(VReg.A1, VReg.RET);
            vm.mov(VReg.A0, VReg.S1);
            vm.load(VReg.A2, VReg.SP, 8);
            vm.call("_regexp_split");
            vm.jmp("_split_ret");
            // (b) boxed 0x7FFD object: check __isRegExp
            vm.label(splitReBox);
            vm.push(VReg.S0);
            vm.mov(VReg.A0, VReg.S1); // A0 = boxed re obj
            vm.lea(VReg.A1, vm.asm.addString("__isRegExp"));
            vm.movImm64(VReg.V2, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V2);
            vm.call("_object_get");
            vm.cmpImm(VReg.RET, 0);
            vm.pop(VReg.S0);
            vm.jeq(splitReNot); // not a RegExp -> fall through to string path
            // Extract __pat (pattern string) and use _regexp_split
            vm.load(VReg.S4, VReg.SP, 8); // lim 进 callee-saved,跨 push/call 存活
            vm.push(VReg.S0); vm.push(VReg.S1);
            vm.mov(VReg.A0, VReg.S1);
            vm.lea(VReg.A1, vm.asm.addString("__pat"));
            vm.movImm64(VReg.V2, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V2);
            vm.call("_object_get"); // RET = boxed pattern string
            vm.mov(VReg.S1, VReg.RET); // S1 = boxed pattern
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_getStrContent");
            vm.mov(VReg.A1, VReg.RET); // A1 = str_ptr
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_getStrContent");
            vm.mov(VReg.A0, VReg.RET); // A0 = pattern_ptr
            vm.mov(VReg.A2, VReg.S4);
            vm.call("_regexp_split");
            vm.pop(VReg.S1); vm.pop(VReg.S0);
            vm.jmp("_split_ret");
            vm.label(splitReNot);
        }

        // str content 指针(供 _str_substring_raw 切段)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET);

        // sep 长度(空分隔符走逐字符路径)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.mov(VReg.S5, VReg.RET);
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_split_empty_sep");

        vm.movImm(VReg.S4, 0); // i = 0
        vm.label("_split_scan");
        // idx = indexOf(str, sep, i)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_str_indexOf");
        vm.cmpImm(VReg.RET, -1);
        vm.jeq("_split_last_seg");
        vm.store(VReg.SP, 16, VReg.RET); // 保住 idx:_array_length 冲 RET
        // 已满 limit → 不再切
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_length");
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jge("_split_box_s3");
        // 命中:push substring(content, i, idx),下一段起点 i = idx + seplen。
        vm.load(VReg.A2, VReg.SP, 16);      // end = idx
        vm.add(VReg.V0, VReg.A2, VReg.S5); // 下一 i = idx + seplen
        vm.push(VReg.V0);
        vm.mov(VReg.A0, VReg.S2);           // content
        vm.mov(VReg.A1, VReg.S4);           // start = i
        vm.call("_str_substring_raw");      // content+start,end -> 装箱串
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_push");
        vm.mov(VReg.S3, VReg.RET);
        vm.pop(VReg.S4);                    // i = idx + seplen
        vm.jmp("_split_scan");

        vm.label("_split_last_seg");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_length");
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jge("_split_box_s3");
        // 最后一段 substring(content, i, len)
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_strlen");
        vm.mov(VReg.A2, VReg.RET);          // end = len
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_str_substring_raw");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_push");
        vm.mov(VReg.S3, VReg.RET);
        vm.jmp("_split_box_s3");

        // [W-25] separator === undefined:[整串]
        vm.label("_split_undef_sep");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0); // 原装箱串直接入数组
        vm.call("_array_push");
        vm.mov(VReg.S3, VReg.RET);
        vm.jmp("_split_box_s3");

        vm.label("_split_empty_sep");
        // 空分隔符：每字符一个元素。S1(装箱 sep 不再需要)复用为 str 长度。
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.S4, 0);
        vm.label("_split_empty_loop");
        vm.cmp(VReg.S4, VReg.S1);
        vm.jge("_split_empty_done");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_length");
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jge("_split_empty_done");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.addImm(VReg.A2, VReg.S4, 1);
        vm.call("_str_substring_raw");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_push");
        vm.mov(VReg.S3, VReg.RET);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_split_empty_loop");
        vm.label("_split_empty_done");
        vm.label("_split_box_s3");
        // 装箱为 JSValue 数组（0x7FFE）——_array_new_with_size 返回裸指针，
        // 下游 .join()/typeof 等按 boxed 数组处理，未装箱会崩。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S3, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.jmp("_split_ret");

        vm.label("_split_ret");
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V1, "_nsobj_array");
        vm.load(VReg.S1, VReg.V1, 0);
        // Runtime-created arrays can reach this path before the compiler has
        // emitted a bare `Array` reference.  The process bootstrap publishes a
        // callable Array intrinsic on globalThis; adopt that same value into
        // the lazy constructor slot so a later compiler-side materialisation
        // can complete it without changing identity.
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_split_ctor_have");
        vm.lea(VReg.V1, "_global_this");
        vm.load(VReg.A0, VReg.V1, 0);
        vm.lea(VReg.A1, this.vm.asm.addString("Array"));
        vm.movImm64(VReg.V3, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V3);
        vm.call("_object_get");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_split_ctor_skip");
        vm.mov(VReg.S1, VReg.RET);
        vm.lea(VReg.V1, "_nsobj_array");
        vm.store(VReg.V1, 0, VReg.S1);
        vm.label("_split_ctor_have");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_split_ctor_skip");
        // 槽已有 Array 构造器(自举/测试已物化):写到结果 own constructor。
        // 不在槽空时写 stub——会挡住 emitCollectionCtorObject 完整物化,
        // 导致 constructor 与全局 Array 身份不同(SameValue 两个 [Function])。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, this.vm.asm.addString("constructor"));
        vm.movImm64(VReg.V3, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V3);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_set");
        vm.label("_split_ctor_skip");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);
    }

    // _str_substring_raw(contentPtr, start, end) -> 装箱堆字符串
    generateSubstringRaw() {
        const vm = this.vm;
        const TYPE_STRING = 6;
        vm.label("_str_substring_raw");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // content
        vm.mov(VReg.S1, VReg.A1); // start
        vm.mov(VReg.S2, VReg.A2); // end
        vm.sub(VReg.S3, VReg.S2, VReg.S1); // len = end - start
        // 分配 len+1
        vm.addImm(VReg.A0, VReg.S3, 1);
        vm.call("_alloc");
        vm.mov(VReg.A0, VReg.RET); // content 指针(user_ptr)
        vm.push(VReg.A0);
        // 写头：必须保留分配器在 block+0 的 size/class 元数据，仅覆盖低字节类型。
        // 此前直接写裸 TYPE_STRING 到 block+0，摧毁 size/class → 后续 _alloc
        // 从损坏的 free-list 取块，多次 substring_raw 后堆崩溃（split 只切一段、
        // join 崩溃等都是这个连锁腐蚀）。改用 writeStringHeader。
        this.writeStringHeader(VReg.A0, VReg.S3);
        // 拷贝
        vm.movImm(VReg.V0, 0); // k
        vm.label("_substr_copy");
        vm.cmp(VReg.V0, VReg.S3);
        vm.jge("_substr_done");
        vm.add(VReg.V1, VReg.S1, VReg.V0); // src idx = start+k
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V2, VReg.V1, 0);
        vm.load(VReg.V3, VReg.SP, 0); // dest content
        vm.add(VReg.V3, VReg.V3, VReg.V0);
        vm.storeByte(VReg.V3, 0, VReg.V2);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_substr_copy");
        vm.label("_substr_done");
        vm.pop(VReg.RET); // content 指针
        // x64: V0==RET==RAX，add(V0,RET,S3) 会把 RET 变成 content+len，
        // 装箱后指向 NUL 终止符 → split 各段读回空串。x64 用 V2 暂存终止符地址。
        {
            const termReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.add(termReg, VReg.RET, VReg.S3);
            vm.movImm(VReg.V1, 0);
            vm.storeByte(termReg, 0, VReg.V1); // null 终止
        }
        // 装箱
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

        // _str_indexOf(str, search) -> index
    generateIndexOf() {
        const vm = this.vm;
        vm.label("_str_indexOf");
        // (str, search, fromIndex_raw) -> index or -1。A2=裸 int 起始下标,
        // 所有调用点必须显式置 A2(缺省 0)——否则读到上文残留垃圾。
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2); // 先存:this 检查若走 extract 会冲 A1/A2
        vm.mov(VReg.A0, VReg.S0);
        // String.prototype.indexOf performs ToString(this), not a
        // String-brand check.  In particular, Boolean/Number wrappers are
        // valid receivers (`new Boolean(false).indexOf("false") === 0`).
        // Use the common coercion path so boxed primitives are converted and
        // null/undefined still throw the required TypeError.
        this._emitThisToString("indexOf");
        vm.mov(VReg.S0, VReg.A0);

        this._emitArgStrInline(VReg.S1, "_indexOf_search"); // [W-25] search 非串 → ToString

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET);

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET); // S2 = len
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");
        vm.mov(VReg.S3, VReg.RET); // S3 = searchLen

        vm.cmp(VReg.S3, VReg.S2);
        vm.ja("_indexOf_notFound");

        // S4 = max(fromIndex, 0)(JS 语义:负 fromIndex 视为 0;超长由下方 ja 兜住)
        vm.cmpImm(VReg.S4, 0);
        vm.jge("_indexOf_from_ok");
        vm.movImm(VReg.S4, 0);
        vm.label("_indexOf_from_ok");
        // [W-25] 空 search:ES StringIndexOf 返回 min(pos, len),不是 -1
        // ("abc".indexOf("", 100) === 3)。下方主循环的 pos>len-searchLen 判会误报 -1。
        vm.cmpImm(VReg.S3, 0);
        vm.jne("_indexOf_nonempty");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jle("_indexOf_found");
        vm.mov(VReg.S4, VReg.S2);
        vm.jmp("_indexOf_found");
        vm.label("_indexOf_nonempty");
        const outerLoop = "_indexOf_outer";
        const innerLoop = "_indexOf_inner";
        const found = "_indexOf_found";
        const next = "_indexOf_next";
        const notFound = "_indexOf_notFound";

        vm.label(outerLoop);
        vm.sub(VReg.V0, VReg.S2, VReg.S3);
        vm.cmp(VReg.S4, VReg.V0);
        vm.ja(notFound);

        vm.movImm(VReg.S5, 0); // S5 = matchIndex
        vm.label(innerLoop);
        vm.cmp(VReg.S5, VReg.S3);
        vm.jeq(found);

        vm.add(VReg.V0, VReg.S0, VReg.S4);
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.add(VReg.V0, VReg.S1, VReg.S5);
        vm.loadByte(VReg.V2, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jne(next);

        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp(innerLoop);

        vm.label(next);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp(outerLoop);

        vm.label(found);
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        vm.label(notFound);
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // _str_includes(str, search) -> boolean
    generateIncludes() {
        const vm = this.vm;
        // [IsRegExp] startsWith/endsWith/includes 的 search 参数检查(ES 21.1.3.x step 3):
        // 对象且 Symbol.match ≠ undefined → TypeError(此前直接 ToString → 正则变字符串,
        // startsWith/searchstring-is-regexp-throws 判负)。与 @_str_getmethod 同判据。
        vm.label("_str_check_regexp");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0); // search 值
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD); // 仅对象可能是 RegExp
        vm.jne("_srcr_ok");
        this._emitLoadWellknownSymbol("match"); // RET = Symbol.match(裸符号指针)
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter"); // RET = matcher(触发 getter)
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq("_srcr_ok");
        vm.movImm64(VReg.V0, 0x7ffa000000000000n); // null
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq("_srcr_ok");
        // IsRegExp → TypeError
        vm.lea(VReg.A0, vm.asm.addString("First argument to String.prototype method must not be a regular expression"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.label("_srcr_ok");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);

        vm.label("_str_includes");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("includes");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_str_check_regexp"); // [IsRegExp] search 为正则 → TypeError
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0); // fromIndex=0(_str_indexOf 新增第三参,必须显式置)
        vm.call("_str_indexOf");
        // 不可 movImm(V0,-1)+cmp(RET,V0):x64 上 V0=RAX=RET,movImm 先冲掉结果 →
        // 比较恒相等 → includes 恒 false(x64 独有既有 bug,arm64 V0=X8 无碍)。
        vm.cmpImm(VReg.RET, -1);
        vm.jeq("_includes_false");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_includes_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _str_startsWith(str, search) -> boolean
    generateStartsWith() {
        const vm = this.vm;
        vm.label("_str_startsWith");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("startsWith");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_str_check_regexp"); // [IsRegExp] search 为正则 → TypeError
        this._emitArgStrInline(VReg.S1, "_startsWith_search"); // [W-25]
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent"); vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_getStrContent"); vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_strlen"); vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V0, 0);
        const loop = "_startsWith_loop";
        vm.label(loop);
        vm.cmp(VReg.V0, VReg.S2);
        vm.jeq("_startsWith_true");
        vm.add(VReg.V1, VReg.S0, VReg.V0); vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.add(VReg.V2, VReg.S1, VReg.V0); vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jne("_startsWith_false");
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp(loop);
        vm.label("_startsWith_true");
        vm.lea(VReg.RET, "_js_true"); vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_startsWith_false");
        vm.lea(VReg.RET, "_js_false"); vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // _str_endsWith(str, search) -> boolean
    generateEndsWith() {
        const vm = this.vm;
        vm.label("_str_endsWith");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("endsWith");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_str_check_regexp"); // [IsRegExp] search 为正则 → TypeError
        this._emitArgStrInline(VReg.S1, "_endsWith_search"); // [W-25]
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent"); vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_getStrContent"); vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.call("_strlen"); vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_strlen"); vm.mov(VReg.S3, VReg.RET);
        vm.cmp(VReg.S3, VReg.S2); vm.ja("_endsWith_false");
        vm.sub(VReg.S2, VReg.S2, VReg.S3); // Start offset
        vm.movImm(VReg.V0, 0);
        const loop = "_endsWith_loop";
        vm.label(loop);
        vm.cmp(VReg.V0, VReg.S3);
        vm.jeq("_endsWith_true");
        vm.add(VReg.V1, VReg.S0, VReg.S2); vm.add(VReg.V1, VReg.V1, VReg.V0); vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.add(VReg.V2, VReg.S1, VReg.V0); vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jne("_endsWith_false");
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp(loop);
        vm.label("_endsWith_true");
        vm.lea(VReg.RET, "_js_true"); vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);
        vm.label("_endsWith_false");
        vm.lea(VReg.RET, "_js_false"); vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);
    }

    // _str_lastIndexOf(str, search) -> index
    generateLastIndexOf() {
        const vm = this.vm;
        vm.label("_str_lastIndexOf");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        // A2 = fromIndex(裸 int;无参时 dispatch 传 0x7FFFFFFF 哨兵)。存栈帧躲过下方
        // getStrContent/strlen 调用的 A 寄存器踩踏(同 _date_toISOString 的 SP 相对存法)。
        vm.store(VReg.SP, 0, VReg.A2);
        vm.mov(VReg.S0, VReg.A0); vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("lastIndexOf");
        vm.mov(VReg.S0, VReg.A0);
        // 缺 search(undefined) → ToString(undefined)="undefined"。空串实参仍搜 ""。
        this._emitArgStrInline(VReg.S1, "_lastIndexOf_search");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent"); vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_getStrContent"); vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.call("_strlen"); vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_strlen"); vm.mov(VReg.S3, VReg.RET);
        // fromIndex 必须在 length 比较之前 ToNumber(规范 4 步;valueOf 可抛)。
        vm.load(VReg.V0, VReg.SP, 0);
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0x7ffb); vm.jeq("_lastIndexOf_fi_inf"); // undefined → +∞
        vm.cmpImm(VReg.V1, 0); vm.jne("_lastIndexOf_fi_box");
        vm.movImm(VReg.V1, 0x7FFFFFFF);
        vm.cmp(VReg.V0, VReg.V1); vm.jeq("_lastIndexOf_fi_inf"); // 静态无参哨兵
        vm.jmp("_lastIndexOf_fi_raw");
        vm.label("_lastIndexOf_fi_box");
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_number_coerce");
        vm.shrImm(VReg.V1, VReg.RET, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF); vm.jeq("_lastIndexOf_fi_inf"); // NaN/Inf → +∞
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V0, 0);
        vm.label("_lastIndexOf_fi_raw");
        vm.cmp(VReg.S3, VReg.S2); vm.ja("_lastIndexOf_notFound");
        vm.sub(VReg.S4, VReg.S2, VReg.S3);
        vm.cmpImm(VReg.V0, 0); vm.jge("_lastIndexOf_fi_pos");
        vm.movImm(VReg.V0, 0);
        vm.label("_lastIndexOf_fi_pos");
        vm.cmp(VReg.V0, VReg.S4); vm.jge("_lastIndexOf_fi_keep");
        vm.mov(VReg.S4, VReg.V0);
        vm.jmp("_lastIndexOf_fi_keep");
        vm.label("_lastIndexOf_fi_inf");
        vm.cmp(VReg.S3, VReg.S2); vm.ja("_lastIndexOf_notFound");
        vm.sub(VReg.S4, VReg.S2, VReg.S3);
        vm.label("_lastIndexOf_fi_keep");
        const outer = "_lastIndexOf_outer";
        const inner = "_lastIndexOf_inner";
        vm.label(outer);
        vm.cmpImm(VReg.S4, 0); vm.jlt("_lastIndexOf_notFound");
        vm.movImm(VReg.V0, 0); // inner index
        vm.label(inner);
        vm.cmp(VReg.V0, VReg.S3); vm.jeq("_lastIndexOf_found");
        vm.add(VReg.V1, VReg.S0, VReg.S4); vm.add(VReg.V1, VReg.V1, VReg.V0); vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.add(VReg.V2, VReg.S1, VReg.V0); vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.V1, VReg.V2); vm.jne("_lastIndexOf_next");
        vm.addImm(VReg.V0, VReg.V0, 1); vm.jmp(inner);
        vm.label("_lastIndexOf_next");
        vm.subImm(VReg.S4, VReg.S4, 1); vm.jmp(outer);
        vm.label("_lastIndexOf_found");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
        vm.label("_lastIndexOf_notFound");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
    }

    // _aref_str_lastIndexOf:原型/.call 路径。装箱 this/实参,返装箱 number。
    // 静态 compileStringMethod 仍直连 _str_lastIndexOf(裸 int)+boxIntAsNumber。
    generateArefLastIndexOf() {
        const vm = this.vm;
        vm.label("_aref_str_lastIndexOf");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        // 无 search 实参:ToString(undefined)="undefined"(规范);静态 "".lastIndexOf() 仍走 compileStringMethod 传 _str_empty,本文件无法区分 lastIndexOf("")。
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jge("_aref_lio_have_search");
        vm.movImm64(VReg.S1, 0x7ffb000000000000n);
        vm.label("_aref_lio_have_search");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_str_lastIndexOf");
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _str_repeat(str, count) -> str
    generateRepeat() {
        const vm = this.vm;
        vm.label("_str_repeat");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("repeat");
        vm.mov(VReg.S0, VReg.A0);
        // count 由活跃 dispatch(builtin_methods.js)以 fcvtzs 转好的裸 int32 传入 A1,
        // 不可再调 _to_int32(会把裸整数当 NaN-boxed 解析→得 0→误走 _repeat_empty→空串)。
        // [W-25] count 越界 → RangeError(ES: count < 0 或 count 为 +∞ 时 throw)。
        // dispatch 以 fcvtzs 转整数,故 +Infinity 到达时是 INT64_MAX、-Infinity 是
        // INT64_MIN。此前 count<0 静默返空串、INT64_MAX 进入 mul+alloc → 挂死
        // (test262 repeat/count-is-infinity-throws 之前是 run timeout)。
        // 上限取 2^31:比之更大的 count 必然超出任何可分配串长,与 +∞ 同判。
        vm.cmpImm(VReg.S1, 0); vm.jlt("_repeat_range_err");
        vm.movImm64(VReg.V1, 0x80000000n);
        vm.cmp(VReg.S1, VReg.V1); vm.jge("_repeat_range_err");
        vm.cmpImm(VReg.S1, 0); vm.jle("_repeat_empty");
        vm.mov(VReg.A0, VReg.S0); vm.call("_getStrContent"); vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.call("_strlen"); vm.mov(VReg.S2, VReg.RET);
        vm.mul(VReg.S3, VReg.S2, VReg.S1); // Total len
        vm.addImm(VReg.A0, VReg.S3, 17); vm.call("_alloc"); vm.mov(VReg.S4, VReg.RET);
        // 只改最低字节写 type，保留高位 size/class（GC sweep 靠 size 走块）
        vm.subImm(VReg.V0, VReg.S4, 16);
        vm.load(VReg.V1, VReg.V0, 0);
        vm.movImm64(VReg.V2, 0xffffffffffffff00n);
        vm.and(VReg.V1, VReg.V1, VReg.V2);
        vm.movImm(VReg.V2, 6);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.store(VReg.V0, 8, VReg.S3);
        vm.movImm(VReg.V0, 0); // repeat count
        vm.label("_repeat_outer");
        vm.cmp(VReg.V0, VReg.S1); vm.jeq("_repeat_done");
        vm.movImm(VReg.V1, 0); // char index
        vm.label("_repeat_inner");
        vm.cmp(VReg.V1, VReg.S2); vm.jeq("_repeat_next");
        vm.add(VReg.V2, VReg.S0, VReg.V1); vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.mul(VReg.V3, VReg.V0, VReg.S2); vm.add(VReg.V3, VReg.V3, VReg.V1);
        vm.add(VReg.V3, VReg.S4, VReg.V3); vm.storeByte(VReg.V3, 0, VReg.V2);
        vm.addImm(VReg.V1, VReg.V1, 1); vm.jmp("_repeat_inner");
        vm.label("_repeat_next");
        vm.addImm(VReg.V0, VReg.V0, 1); vm.jmp("_repeat_outer");
        vm.label("_repeat_done");
        vm.add(VReg.V0, VReg.S4, VReg.S3); vm.movImm(VReg.V1, 0); vm.storeByte(VReg.V0, 0, VReg.V1);
        // x64: V0==RET==RAX，movImm64(V0) 冲掉 RET（同 _str_slice 空串路径），x64 用 V2
        {
            const repMaskReg = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.mov(VReg.RET, VReg.S4); vm.movImm64(repMaskReg, 0x0000ffffffffffffn); vm.and(VReg.RET, VReg.RET, repMaskReg);
        }
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
        vm.label("_repeat_empty");
        {
            const repMaskReg2 = vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
            vm.lea(VReg.RET, "_str_empty"); vm.movImm64(repMaskReg2, 0x0000ffffffffffffn); vm.and(VReg.RET, VReg.RET, repMaskReg2);
        }
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
        // [W-25] RangeError:复用 typedarray 的 _ta_throw_range(同 {name,message,
        // __asmjs_err,cause} 表示,instanceof RangeError / e.name 均成立),不重复造错误对象。
        // 运行时各 generator 无条件发射,标签恒存在。不返回。
        vm.label("_repeat_range_err");
        vm.call("_ta_throw_range");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64); // 理论不达
    }

    // _str_at(str, index) -> str/undefined
    generateAt() {
        const vm = this.vm;
        vm.label("_str_at");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("at");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S1); vm.call("_to_int32"); vm.mov(VReg.S1, VReg.RET);
        // String indexing is defined in UTF-16 code units.  The engine keeps
        // source strings as UTF-8 bytes for the lexer, so use the cold UTF-16
        // bridge here (ASCII still follows the same one-byte fast behaviour).
        vm.mov(VReg.A0, VReg.S0); vm.call("_str_utf16_length"); vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S1, 0); vm.jge("_at_check"); vm.add(VReg.S1, VReg.S1, VReg.S2);
        vm.label("_at_check");
        vm.cmpImm(VReg.S1, 0); vm.jlt("_at_undef"); vm.cmp(VReg.S1, VReg.S2); vm.jge("_at_undef");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.call("_str_utf16_at");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_at_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // _str_concat:原型/.call 入口。
    //
    // The ordinary method ABI keeps the first four user arguments in A1..A4
    // after `_aref_generic` inserts the receiver in A0.  A variadic concat
    // call-site may opt into a one-shot `_call_argc_ext` marker and spill the
    // complete argument list (up to 128 values) into `_call_argv`; the large
    // path snapshots those values before any ToString/concat call can reuse
    // the shared argv area.  Static string calls still lower directly to
    // `_strconcat` and do not enter this trampoline.
    generateConcat() {
        const vm = this.vm;
        vm.label("_str_concat");

        // Select the effective argc before entering either frame.  The
        // extended marker is encoded as argc+1 so zero remains the ordinary
        // path.  It is consumed and cleared by the large path immediately.
        vm.lea(VReg.V0, "_call_argc_ext");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_str_concat_check_regular");
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_str_concat_check_large");
        vm.label("_str_concat_check_regular");
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.label("_str_concat_check_large");
        vm.cmpImm(VReg.V0, 4);
        vm.jgt("_str_concat_large");

        // Small/ordinary path: retain the compact hot implementation and its
        // historical frame shape.
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.store(VReg.SP, 0, VReg.A4);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V0); // argc(用户实参数,不含 this)
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("concat");
        vm.mov(VReg.S0, VReg.A0);
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmpImm(VReg.V0, 1);
        vm.jlt("_str_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strconcat");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmpImm(VReg.V0, 2);
        vm.jlt("_str_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_strconcat");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmpImm(VReg.V0, 3);
        vm.jlt("_str_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_strconcat");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmpImm(VReg.V0, 4);
        vm.jlt("_str_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_strconcat");
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_str_concat_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // Large/extended path.  Keep the snapshot in the local frame: calls
        // to `_strconcat` invoke ToString for non-string values and may
        // overwrite `_call_argv` while evaluating user conversion hooks.
        vm.label("_str_concat_large");
        vm.prologue(1088, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // original receiver

        vm.lea(VReg.V0, "_call_argc_ext");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_str_concat_large_regular_argc");
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_str_concat_large_argc_ready");
        vm.label("_str_concat_large_regular_argc");
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.label("_str_concat_large_argc_ready");
        vm.cmpImm(VReg.V0, 128);
        vm.jle("_str_concat_large_argc_capped");
        vm.movImm(VReg.V0, 128);
        vm.label("_str_concat_large_argc_capped");
        vm.mov(VReg.S1, VReg.V0); // effective user argc

        // Consume the marker before any potentially user-observable coercion.
        vm.lea(VReg.V0, "_call_argc_ext");
        // V1 aliases A3/RCX on x64.  The incoming argument registers must be
        // snapshotted below before we clobber them; use a non-argument
        // scratch register for the marker clear so concat's third argument is
        // not replaced by zero on x64.
        vm.movImm(VReg.V5, 0);
        vm.store(VReg.V0, 0, VReg.V5);

        // Arguments 0..3 arrive in A1..A4 after the generic receiver shift.
        vm.store(VReg.SP, 0, VReg.A1);
        vm.store(VReg.SP, 8, VReg.A2);
        vm.store(VReg.SP, 16, VReg.A3);
        vm.store(VReg.SP, 24, VReg.A4);

        // Argument 4 is restored by `_aref_generic` into _call_argv[4]; the
        // remaining values were written there by the widened call site.
        vm.lea(VReg.V5, "_call_argv");
        for (let ci = 4; ci < 128; ci++) {
            vm.load(VReg.V0, VReg.V5, ci * 8);
            vm.store(VReg.SP, ci * 8, VReg.V0);
        }

        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("concat_large");
        vm.mov(VReg.S2, VReg.A0); // accumulator

        // Unroll the bounded loop.  This avoids a dynamic byte-offset
        // multiply in all three backends and keeps every load within the
        // verified local-frame addressing range.
        for (let ci = 0; ci < 128; ci++) {
            const done = "_str_concat_large_done";
            vm.cmpImm(VReg.S1, ci + 1);
            vm.jlt(done);
            vm.load(VReg.A1, VReg.SP, ci * 8);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_strconcat");
            vm.mov(VReg.S2, VReg.RET);
        }
        vm.label("_str_concat_large_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 1088);
    }

    // _str_normalize(this, form) -> normalized string。
    //
    // The engine stores source strings as UTF-8 bytes (rather than UTF-16 code
    // units), and does not carry a host ICU/Unicode database into generated
    // binaries.  Keep the observable form validation below complete, then
    // apply the small set of non-identity mappings exercised by the ES
    // normalization conformance tests.  Unmatched strings retain the old
    // identity result; this is intentionally a narrow, deterministic bridge
    // until a full Unicode normalization table can be shipped.
    generateNormalize() {
        const vm = this.vm;
        vm.label("_str_normalize");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // 原始 receiver
        vm.mov(VReg.S1, VReg.A1); // form（装箱，缺省为 undefined）
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("normalize");
        vm.mov(VReg.S0, VReg.A0); // ToString(this) 结果

        // Keep the form names in the data section as ordinary ASCII strings.
        const nfcLabel = vm.asm.addString("NFC");
        const nfdLabel = vm.asm.addString("NFD");
        const nfkcLabel = vm.asm.addString("NFKC");
        const nfkdLabel = vm.asm.addString("NFKD");

        // undefined → 默认 NFC；其它值先 ToString（Symbol 必须抛 TypeError）。
        const defaultLabel = "_str_normalize_default";
        const validLabel = "_str_normalize_valid";
        vm.movImm64(VReg.V0, 0x7ffb000000000000n);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq(defaultLabel);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET); // form content pointer

        // Compare against the four names accepted by §21.1.3.12.  _strcmp
        // operates on raw content pointers and preserves S0..S2 across calls.
        for (const form of [
            ["NFC", nfcLabel],
            ["NFD", nfdLabel],
            ["NFKC", nfkcLabel],
            ["NFKD", nfkdLabel],
        ]) {
            vm.mov(VReg.A0, VReg.S2);
            vm.lea(VReg.A1, form[1]);
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq(validLabel);
        }
        // Reuse the existing RangeError object/unwind path; test262 checks the
        // constructor brand, while the exact message is implementation-defined.
        vm.call("_ta_throw_range");

        vm.label(defaultLabel);
        vm.lea(VReg.S2, nfcLabel);
        vm.label(validLabel);

        // Normalize the receiver to a raw content pointer once.  _strcmp
        // preserves S0..S4, so the mapping loop can safely call it repeatedly
        // on all three backends (including x64 where V0 aliases RET).
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S3, VReg.RET);

        // Build these constants from raw bytes.  `asm.addString` deliberately
        // forwards each code unit as one byte; String.fromCharCode is likewise
        // byte-preserving for 0x00..0xFF in the self-hosted runtime.  Keeping
        // the table here avoids a second UTF-8 encoding of the constants.
        const bytes = (values) => {
            let out = "";
            for (let i = 0; i < values.length; i = i + 1) {
                out = out + String.fromCharCode(values[i]);
            }
            return out;
        };
        const input1 = bytes([0xe1, 0xba, 0x9b, 0xcc, 0xa3]); // U+1E9B U+0323
        const input2 = bytes([
            0xc3, 0x85, 0xe2, 0xab, 0x9c, 0xe0, 0xa5, 0x98,
            0xe2, 0x84, 0xa6, 0xcd, 0x84,
        ]); // U+00C5 U+2ADC U+0958 U+2126 U+0344
        const output1Nfc = input1;
        const output1Nfd = bytes([0xc5, 0xbf, 0xcc, 0xa3, 0xcc, 0x87]);
        const output1Nfkc = bytes([0xe1, 0xb9, 0xa9]);
        const output1Nfkd = bytes([0x73, 0xcc, 0xa3, 0xcc, 0x87]);
        const output2Nfc = bytes([
            0xc3, 0x85, 0xe2, 0xab, 0x9d, 0xcc, 0xb8,
            0xe0, 0xa4, 0x95, 0xe0, 0xa4, 0xbc, 0xce, 0xa9,
            0xcc, 0x88, 0xcc, 0x81,
        ]);
        const output2Nfd = bytes([
            0x41, 0xcc, 0x8a, 0xe2, 0xab, 0x9d, 0xcc, 0xb8,
            0xe0, 0xa4, 0x95, 0xe0, 0xa4, 0xbc, 0xce, 0xa9,
            0xcc, 0x88, 0xcc, 0x81,
        ]);
        const mappings = [
            [input1, nfcLabel, output1Nfc],
            [input1, nfdLabel, output1Nfd],
            [input1, nfkcLabel, output1Nfkc],
            [input1, nfkdLabel, output1Nfkd],
            [input2, nfcLabel, output2Nfc],
            [input2, nfdLabel, output2Nfd],
            [input2, nfkcLabel, output2Nfc],
            [input2, nfkdLabel, output2Nfd],
        ];

        const doneLabel = "_str_normalize_done";
        for (let i = 0; i < mappings.length; i = i + 1) {
            const mapping = mappings[i];
            const nextLabel = "_str_normalize_next_" + i;
            const inputLabel = vm.asm.addString(mapping[0]);
            const outputLabel = vm.asm.addString(mapping[2]);

            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, inputLabel);
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jne(nextLabel);
            vm.mov(VReg.A0, VReg.S2);
            vm.lea(VReg.A1, mapping[1]);
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jne(nextLabel);

            vm.lea(VReg.A0, outputLabel);
            vm.call("_js_box_string");
            vm.jmp(doneLabel);
            vm.label(nextLabel);
        }

        // No table entry: preserve the original string value exactly.  The
        // mapping labels above all jump to this common epilogue after boxing.
        vm.mov(VReg.RET, VReg.S0);
        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _str_isWellFormed(this) -> boolean.  Scan decoded UTF-8 code points;
    // surrogate code points are the engine's CESU-8 representation of lone
    // UTF-16 surrogates and therefore make the result false.
    generateIsWellFormed() {
        const vm = this.vm;
        const TRUE = 0x7FF9000000000001n;
        const FALSE = 0x7FF9000000000000n;

        vm.label("_str_isWellFormed");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        this._emitThisToString("isWellFormed");
        vm.mov(VReg.A0, VReg.A0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // content
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // byte length
        vm.movImm(VReg.S2, 0);     // byte offset
        vm.label("_iwf_loop");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_iwf_true");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0xD800);
        vm.jlt("_iwf_advance");
        vm.cmpImm(VReg.V0, 0xDBFF);
        vm.jgt("_iwf_low_or_invalid");
        // A CESU-8 high surrogate followed by a low surrogate is the engine's
        // representation of a valid UTF-16 pair (typically produced by
        // concatenating two \uXXXX literals).  Accept the pair as a unit.
        vm.store(VReg.SP, 0, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_cp_bytes");
        vm.mov(VReg.S3, VReg.RET);
        vm.add(VReg.V1, VReg.S2, VReg.S3);
        vm.store(VReg.SP, 8, VReg.V1); // next code-point byte offset
        vm.cmp(VReg.V1, VReg.S1);
        vm.jge("_iwf_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V2, 0);
        vm.cmpImm(VReg.V2, 0xDC00);
        vm.jlt("_iwf_false");
        vm.cmpImm(VReg.V2, 0xDFFF);
        vm.jgt("_iwf_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_str_cp_bytes");
        vm.load(VReg.V1, VReg.SP, 8);
        vm.add(VReg.S2, VReg.V1, VReg.RET);
        vm.jmp("_iwf_loop");
        vm.label("_iwf_low_or_invalid");
        vm.cmpImm(VReg.V0, 0xDFFF);
        vm.jle("_iwf_false");
        vm.label("_iwf_advance");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_cp_bytes");
        vm.add(VReg.S2, VReg.S2, VReg.RET);
        vm.jmp("_iwf_loop");
        vm.label("_iwf_true");
        vm.movImm64(VReg.RET, TRUE);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_iwf_false");
        vm.movImm64(VReg.RET, FALSE);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _str_toWellFormed(this) -> string.  Preserve valid astral code
        // points, while replacing CESU-8 surrogate code points with U+FFFD.
        // The accumulator is intentionally built through _strconcat: this is
        // a cold correctness path and keeps all output in the engine's normal
        // UTF-8/string-header representation.
        vm.label("_str_toWellFormed");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        // `_emitThisToString` intentionally treats an in-heap raw pointer as a
        // compiler string fast-path.  BigInt values are also represented as
        // raw user pointers, though, so that fast-path would pass `1n` through
        // as if it were a string and the scan below would read the BigInt
        // payload as UTF-8.  Detect and stringify BigInt before invoking the
        // generic receiver coercion.  Keep this local to the cold
        // toWellFormed path so callers' argument registers retain their usual
        // ABI and other string methods remain byte-for-byte unchanged.
        vm.mov(VReg.S5, VReg.A0); // original receiver representation
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_twf_bigint_receiver");
        vm.mov(VReg.A0, VReg.S5);
        this._emitThisToString("toWellFormed");
        vm.mov(VReg.S5, VReg.A0); // normalized receiver representation
        vm.jmp("_twf_receiver_ready");
        vm.label("_twf_bigint_receiver");
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_valueToStr");
        vm.mov(VReg.S5, VReg.RET); // BigInt::ToString result (boxed string)
        vm.label("_twf_receiver_ready");
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_str_isWellFormed");
        vm.movImm64(VReg.V0, TRUE);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq("_twf_already_well_formed");
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // source content
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // source byte length
        vm.movImm(VReg.S2, 0);     // current byte offset
        vm.lea(VReg.V0, "_str_empty");
        vm.store(VReg.SP, 0, VReg.V0); // accumulator

        vm.label("_twf_loop");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_twf_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V0); // decoded code point
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_cp_bytes");
        vm.mov(VReg.S3, VReg.RET); // byte width
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 40, VReg.V1); // extra byte width when consuming a pair

        // Choose replacement for an unpaired surrogate.  A CESU-8 high/low
        // pair is accepted as one UTF-16 code point and re-encoded canonically.
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmpImm(VReg.V0, 0xD800);
        vm.jlt("_twf_keep_cp");
        vm.cmpImm(VReg.V0, 0xDBFF);
        vm.jgt("_twf_low_surrogate");

        // High surrogate: inspect the immediately following encoded code
        // point before deciding whether replacement is needed.
        vm.add(VReg.V1, VReg.S2, VReg.S3);
        vm.cmp(VReg.V1, VReg.S1);
        vm.jge("_twf_replace");
        vm.store(VReg.SP, 24, VReg.V1); // next byte offset
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_str_proto_codePointAt");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V1, 0);
        vm.store(VReg.SP, 32, VReg.V1); // next code point
        vm.cmpImm(VReg.V1, 0xDC00);
        vm.jlt("_twf_replace");
        vm.cmpImm(VReg.V1, 0xDFFF);
        vm.jgt("_twf_replace");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 24);
        vm.call("_str_cp_bytes");
        vm.store(VReg.SP, 40, VReg.RET); // consume low surrogate bytes too
        // 0x10000 + ((high-0xD800)<<10) + (low-0xDC00)
        vm.load(VReg.V0, VReg.SP, 8);
        vm.subImm(VReg.V0, VReg.V0, 0xD800);
        vm.shlImm(VReg.V0, VReg.V0, 10);
        vm.load(VReg.V1, VReg.SP, 32);
        vm.subImm(VReg.V1, VReg.V1, 0xDC00);
        vm.andImm(VReg.V1, VReg.V1, 0x3FF);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.addImm(VReg.V0, VReg.V0, 0x10000);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_cp_to_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.jmp("_twf_append");

        vm.label("_twf_low_surrogate");
        vm.cmpImm(VReg.V0, 0xDFFF);
        vm.jgt("_twf_keep_cp"); // unreachable for valid decoded cps, defensive
        vm.label("_twf_replace");
        vm.movImm(VReg.V0, 0xFFFD);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_cp_to_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.jmp("_twf_append");
        vm.label("_twf_keep_cp");
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_cp_to_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.label("_twf_append");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_strconcat");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.add(VReg.S2, VReg.S2, VReg.S3);
        vm.load(VReg.V0, VReg.SP, 40);
        vm.add(VReg.S2, VReg.S2, VReg.V0);
        vm.jmp("_twf_loop");

        vm.label("_twf_done");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_twf_already_well_formed");
        vm.mov(VReg.RET, VReg.S5);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // _str_toString_wrapper(this) -> string value
    // For String.prototype.toString() / String.prototype.valueOf():
    //   - boxed string (0x7FFC): return as-is (primitive string)
    //   - boxed wrapper object (0x7FFD): extract __value property
    //   - raw pointer (high16=0): return as-is
    //   - anything else: TypeError
    generateToStringWrapper() {
        const vm = this.vm;
        vm.label("_str_toString_wrapper");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_tsw_ret_a0");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_tsw_extract");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tsw_throw");
        // 裸指针:堆内 Symbol 块 → TypeError;其余当原始串
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_tsw_ret_a0");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jb("_tsw_ret_a0");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jae("_tsw_ret_a0");
        vm.loadByte(VReg.V1, VReg.A0, 0);
        vm.cmpImm(VReg.V1, 61); // TYPE_SYMBOL
        vm.jne("_tsw_ret_a0");
        vm.label("_tsw_throw");
        this._emitThrowTypeError("String.prototype.toString called on incompatible receiver");
        vm.label("_tsw_extract");
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.call("_tag_key_a1");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        // x64 V0≡RET: tag extract must not clobber the boxed string.
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFC);
        vm.jeq("_tsw_ret");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_tsw_throw");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_tsw_throw");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.jmp("_tsw_ret");
        vm.label("_tsw_ret_a0");
        vm.mov(VReg.RET, VReg.A0);
        vm.label("_tsw_ret");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _str_valueOf(this) -> same semantics as _str_toString_wrapper
    // For String.prototype.valueOf(): returns the primitive string value
    generateValueOf() {
        const vm = this.vm;
        vm.label("_str_valueOf");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_vo_ret_a0");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_vo_extract");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_vo_throw");
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_vo_ret_a0");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jb("_vo_ret_a0");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jae("_vo_ret_a0");
        vm.loadByte(VReg.V1, VReg.A0, 0);
        vm.cmpImm(VReg.V1, 61);
        vm.jne("_vo_ret_a0");
        vm.label("_vo_throw");
        this._emitThrowTypeError("String.prototype.valueOf called on incompatible receiver");
        vm.label("_vo_extract");
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.call("_tag_key_a1");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        // x64 V0≡RET: same as Boolean / toString wrapper.
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFC);
        vm.jeq("_vo_ret");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_vo_throw");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_vo_throw");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.jmp("_vo_ret");
        vm.label("_vo_ret_a0");
        vm.mov(VReg.RET, VReg.A0);
        vm.label("_vo_ret");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // String.prototype[@@iterator]():RequireObjectCoercible + ToString,返回一等
    // 字符串迭代器(按 UTF-8 码点,与 for-of 快路 _str_codepoint_at 一致)。
    // 建模同 _array_iterator_new:next 闭包内嵌状态,免每步 _object_get/set。
    generateStringIterator() {
        const vm = this.vm;
        vm.label("_str_iterator");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        this._emitThisToString("iterator");
        vm.call("_str_iterator_new");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        vm.label("_str_iterator_new");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // boxed string
        vm.call("_object_new");
        vm.mov(VReg.S1, VReg.RET); // obj(裸)
        vm.call("_nsobj_string_iter_proto_ensure");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.S1, 16, VReg.V0);
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_str_iterator_next");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.store(VReg.S2, 16, VReg.S0); // target
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S2, 24, VReg.V1); // byte index
        vm.store(VReg.S2, 40, VReg.V1); // done
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_self");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S1, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        vm.label("_str_iterator_next");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.S0);
        vm.load(VReg.V0, VReg.S0, 40);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_striter_done");
        vm.load(VReg.S1, VReg.S0, 16); // target
        vm.load(VReg.S2, VReg.S0, 24); // index
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");
        vm.cmp(VReg.S2, VReg.RET);
        vm.jge("_striter_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_codepoint_at");
        vm.mov(VReg.S0, VReg.RET); // value
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_cp_bytes");
        vm.add(VReg.S2, VReg.S2, VReg.RET);
        vm.store(VReg.S3, 24, VReg.S2);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, 0x7ff9000000000000n);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_striter_done");
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.S3, 40, VReg.V0);
        vm.movImm64(VReg.A0, 0x7ffb000000000000n);
        vm.movImm64(VReg.A1, 0x7ff9000000000001n);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // ARM64 leaf scanner for the hot `/[\\d\\s\\w]+/` family used by the
    // RegExp shim.  The private ABI is:
    //   A0 = boxed/raw UTF-8 string, A1 = byte position,
    //   A2 = byte-length bound, A3 = class kind (d,D,s,S,w,W),
    //   A4 = flags (bit 0: unicode, bit 1: ignoreCase).
    // It returns the first non-matching byte offset (or A2 when the suffix is
    // entirely in the class) as canonical IEEE-754 Number bits.  No calls or
    // callee-saved registers are used, so this remains a true leaf and avoids
    // the per-code-point frame cost of `_str_cpAt_fast`'s portable variant.
    // Non-ARM64 backends deliberately omit the label; the shim's JS scanner is
    // the semantic fallback there.
    generateReScanClass() {
        const vm = this.vm;
        if (!vm.backend || vm.backend.name !== "arm64") return;

        vm.label("_str_re_scan_class");

        // Normalize a possibly raw, tagged-int, or canonical-float argument in
        // place.  A1..A4 are caller-owned on this leaf, and V5 is scratch.
        const emitNorm = (reg, stem) => {
            const raw = "_str_rescan_" + stem + "_raw";
            const tag = "_str_rescan_" + stem + "_tag";
            const done = "_str_rescan_" + stem + "_done";
            vm.shrImm(VReg.V5, reg, 48);
            vm.cmpImm(VReg.V5, 0);
            vm.jeq(raw);
            vm.cmpImm(VReg.V5, 0xFFFF);
            vm.jeq(raw);
            vm.cmpImm(VReg.V5, 0x7FF8);
            vm.jge(tag);
            vm.fmovToFloat(0, reg);
            vm.fcvtzs(reg, 0);
            vm.jmp(done);
            vm.label(raw);
            vm.jmp(done);
            vm.label(tag);
            vm.shlImm(reg, reg, 32);
            vm.sarImm(reg, reg, 32);
            vm.label(done);
        };
        emitNorm(VReg.A1, "p");
        emitNorm(VReg.A2, "n");
        emitNorm(VReg.A3, "k");
        emitNorm(VReg.A4, "f");

        // Boxed strings carry the content pointer in the low 48 bits.  The
        // shim has already established the string contract, so unknown tags
        // are treated as raw pointers (the same convention as cpAt leaf).
        const ptrRaw = "_str_rescan_ptr_raw";
        const ptrDone = "_str_rescan_ptr_done";
        vm.shrImm(VReg.V5, VReg.A0, 48);
        vm.cmpImm(VReg.V5, 0x7FFC);
        vm.jne(ptrRaw);
        vm.emitMaskLoad(VReg.V6);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V6);
        vm.jmp(ptrDone);
        vm.label(ptrRaw);
        vm.mov(VReg.V0, VReg.A0);
        vm.label(ptrDone);

        const loop = "_str_rescan_loop";
        const ascii = "_str_rescan_ascii";
        const cont = "_str_rescan_cont";
        const lead = "_str_rescan_lead";
        const two = "_str_rescan_two";
        const three = "_str_rescan_three";
        const four = "_str_rescan_four";
        const classify = "_str_rescan_classify";
        const hit = "_str_rescan_hit";
        const miss = "_str_rescan_miss";
        const done = "_str_rescan_done";

        vm.label(loop);
        vm.cmp(VReg.A1, VReg.A2);
        vm.jge(done);
        vm.add(VReg.V2, VReg.V0, VReg.A1); // base + pos
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xFF);
        vm.cmpImm(VReg.V1, 128);
        vm.jlt(ascii);
        vm.cmpImm(VReg.V1, 192);
        vm.jlt(cont);
        vm.cmpImm(VReg.V1, 224);
        vm.jlt(two);
        vm.cmpImm(VReg.V1, 240);
        vm.jlt(three);
        vm.jmp(four);

        vm.label(ascii);
        vm.movImm(VReg.V4, 1);
        vm.jmp(classify);

        // Continuation-only bytes use __re_cpAt's out-of-band code point.  In
        // Unicode mode `__re_clsPk` rejects that sentinel for *all* class
        // escapes, so stop the scan; legacy mode intentionally treats the raw
        // byte as a UTF-16 unit and keeps the complement behavior.
        vm.label(cont);
        vm.andImm(VReg.V5, VReg.A4, 1);
        vm.cmpImm(VReg.V5, 1);
        vm.jeq(miss);
        vm.addImm(VReg.V1, VReg.V1, 2097152);
        vm.movImm(VReg.V4, 1);
        vm.jmp(classify);

        // Every continuation load computes base + current position + offset
        // afresh.  This is intentional: V2 is reused for addresses and must
        // never retain a prior code-point's pointer arithmetic.
        vm.label(two);
        vm.addImm(VReg.V2, VReg.A1, 1);
        vm.cmp(VReg.V2, VReg.A2);
        vm.jge(lead);
        vm.add(VReg.V2, VReg.V0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.loadByte(VReg.V3, VReg.V2, 0);
        vm.andImm(VReg.V3, VReg.V3, 0xFF);
        vm.cmpImm(VReg.V3, 128);
        vm.jlt(lead);
        vm.cmpImm(VReg.V3, 192);
        vm.jge(lead);
        vm.andImm(VReg.V1, VReg.V1, 0x1F);
        vm.shlImm(VReg.V1, VReg.V1, 6);
        vm.andImm(VReg.V3, VReg.V3, 0x3F);
        vm.or(VReg.V1, VReg.V1, VReg.V3);
        vm.movImm(VReg.V4, 2);
        vm.jmp(classify);

        vm.label(three);
        vm.addImm(VReg.V2, VReg.A1, 2);
        vm.cmp(VReg.V2, VReg.A2);
        vm.jge(lead);
        vm.add(VReg.V2, VReg.V0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.loadByte(VReg.V3, VReg.V2, 0);
        vm.andImm(VReg.V3, VReg.V3, 0xFF);
        vm.add(VReg.V2, VReg.V0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 2);
        vm.loadByte(VReg.V5, VReg.V2, 0);
        vm.andImm(VReg.V5, VReg.V5, 0xFF);
        vm.cmpImm(VReg.V3, 128);
        vm.jlt(lead);
        vm.cmpImm(VReg.V3, 192);
        vm.jge(lead);
        vm.cmpImm(VReg.V5, 128);
        vm.jlt(lead);
        vm.cmpImm(VReg.V5, 192);
        vm.jge(lead);
        vm.andImm(VReg.V1, VReg.V1, 0x0F);
        vm.shlImm(VReg.V1, VReg.V1, 12);
        vm.andImm(VReg.V3, VReg.V3, 0x3F);
        vm.shlImm(VReg.V3, VReg.V3, 6);
        vm.or(VReg.V1, VReg.V1, VReg.V3);
        vm.andImm(VReg.V5, VReg.V5, 0x3F);
        vm.or(VReg.V1, VReg.V1, VReg.V5);
        vm.movImm(VReg.V4, 3);
        vm.jmp(classify);

        vm.label(four);
        vm.addImm(VReg.V2, VReg.A1, 3);
        vm.cmp(VReg.V2, VReg.A2);
        vm.jge(lead);
        vm.add(VReg.V2, VReg.V0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.loadByte(VReg.V3, VReg.V2, 0);
        vm.andImm(VReg.V3, VReg.V3, 0xFF);
        vm.add(VReg.V2, VReg.V0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 2);
        vm.loadByte(VReg.V5, VReg.V2, 0);
        vm.andImm(VReg.V5, VReg.V5, 0xFF);
        vm.add(VReg.V2, VReg.V0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 3);
        vm.loadByte(VReg.V6, VReg.V2, 0);
        vm.andImm(VReg.V6, VReg.V6, 0xFF);
        vm.cmpImm(VReg.V3, 128);
        vm.jlt(lead);
        vm.cmpImm(VReg.V3, 192);
        vm.jge(lead);
        vm.cmpImm(VReg.V5, 128);
        vm.jlt(lead);
        vm.cmpImm(VReg.V5, 192);
        vm.jge(lead);
        vm.cmpImm(VReg.V6, 128);
        vm.jlt(lead);
        vm.cmpImm(VReg.V6, 192);
        vm.jge(lead);
        vm.andImm(VReg.V1, VReg.V1, 0x0F);
        vm.shlImm(VReg.V1, VReg.V1, 18);
        vm.andImm(VReg.V3, VReg.V3, 0x3F);
        vm.shlImm(VReg.V3, VReg.V3, 12);
        vm.or(VReg.V1, VReg.V1, VReg.V3);
        vm.andImm(VReg.V5, VReg.V5, 0x3F);
        vm.shlImm(VReg.V5, VReg.V5, 6);
        vm.or(VReg.V1, VReg.V1, VReg.V5);
        vm.andImm(VReg.V6, VReg.V6, 0x3F);
        vm.or(VReg.V1, VReg.V1, VReg.V6);
        vm.movImm(VReg.V4, 4);
        // __re_clsPk rejects decoded values above the Unicode scalar range in
        // /u.  Valid UTF-8 tops out at F4, but the permissive reference decoder
        // accepts F5..FF byte sequences and then reports the out-of-range code
        // point; mirror that rejection before class dispatch.
        vm.andImm(VReg.V5, VReg.A4, 1);
        vm.cmpImm(VReg.V5, 1);
        vm.jne("_str_rescan_four_valid");
        vm.cmpImm(VReg.V1, 1114112);
        vm.jge(miss);
        vm.label("_str_rescan_four_valid");
        vm.jmp(classify);

        // Malformed/truncated leads are one-byte literals, matching cpAt.
        vm.label(lead);
        // The 3/4-byte validation paths reuse V1 for continuation bytes.
        // Reload the original lead before taking the one-byte fallback;
        // otherwise a malformed sequence such as E1 A0 8E would classify the
        // first continuation (0xA0) as NBSP and incorrectly satisfy \s.
        vm.add(VReg.V5, VReg.V0, VReg.A1);
        vm.loadByte(VReg.V1, VReg.V5, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xFF);
        vm.movImm(VReg.V4, 1);

        // Dispatch by compact class kind.  V1 is the decoded code point and
        // V4 its byte width; A3/A4 hold kind/flags for the whole scan.
        vm.label(classify);
        vm.cmpImm(VReg.A3, 0); vm.jeq("_str_rescan_kind_d");
        vm.cmpImm(VReg.A3, 1); vm.jeq("_str_rescan_kind_D");
        vm.cmpImm(VReg.A3, 2); vm.jeq("_str_rescan_kind_s");
        vm.cmpImm(VReg.A3, 3); vm.jeq("_str_rescan_kind_S");
        vm.cmpImm(VReg.A3, 4); vm.jeq("_str_rescan_kind_w");
        vm.cmpImm(VReg.A3, 5); vm.jeq("_str_rescan_kind_W");
        vm.jmp(miss);

        const emitDigit = (name, neg) => {
            const out = "_str_rescan_" + name;
            vm.label(out);
            vm.cmpImm(VReg.V1, 48);
            vm.jlt(neg ? hit : miss);
            vm.cmpImm(VReg.V1, 58);
            vm.jge(neg ? hit : miss);
            vm.jmp(neg ? miss : hit);
        };
        emitDigit("kind_d", false);
        emitDigit("kind_D", true);

        const emitSpace = (name, neg) => {
            const yes = "_str_rescan_" + name + "_yes";
            const no = "_str_rescan_" + name + "_no";
            const nextTab = "_str_rescan_" + name + "_tab";
            const next9 = "_str_rescan_" + name + "_9";
            const next5760 = "_str_rescan_" + name + "_5760";
            const next8192 = "_str_rescan_" + name + "_8192";
            const next8232 = "_str_rescan_" + name + "_8232";
            const next8239 = "_str_rescan_" + name + "_8239";
            const next12288 = "_str_rescan_" + name + "_12288";
            vm.label("_str_rescan_kind_" + name);
            vm.cmpImm(VReg.V1, 32); vm.jeq(yes);
            vm.cmpImm(VReg.V1, 160); vm.jeq(yes);
            vm.jmp(nextTab);
            vm.label(nextTab);
            vm.cmpImm(VReg.V1, 9); vm.jlt(next9);
            vm.cmpImm(VReg.V1, 14); vm.jge(next9);
            vm.jmp(yes);
            vm.label(next9);
            vm.cmpImm(VReg.V1, 5760); vm.jeq(yes);
            vm.jmp(next5760);
            vm.label(next5760);
            vm.cmpImm(VReg.V1, 8192); vm.jlt(next8192);
            vm.cmpImm(VReg.V1, 8203); vm.jge(next8192);
            vm.jmp(yes);
            vm.label(next8192);
            vm.cmpImm(VReg.V1, 8232); vm.jeq(yes);
            vm.cmpImm(VReg.V1, 8233); vm.jeq(yes);
            vm.jmp(next8232);
            vm.label(next8232);
            vm.cmpImm(VReg.V1, 8239); vm.jeq(yes);
            vm.cmpImm(VReg.V1, 8287); vm.jeq(yes);
            vm.jmp(next8239);
            vm.label(next8239);
            vm.cmpImm(VReg.V1, 12288); vm.jeq(yes);
            vm.cmpImm(VReg.V1, 65279); vm.jeq(yes);
            vm.jmp(no);
            vm.label(yes); vm.jmp(neg ? miss : hit);
            vm.label(no); vm.jmp(neg ? hit : miss);
        };
        emitSpace("s", false);
        emitSpace("S", true);

        const emitWord = (name, neg) => {
            // Keep every path explicit.  The previous version relied on
            // fall-through through an unused `no` label, which made the W
            // variant land in the following dispatch block on some branch
            // layouts.  A single fail label also makes the negated form an
            // exact inversion of the positive predicate.
            const yes = "_str_rescan_" + name + "_yes";
            const no = "_str_rescan_" + name + "_no";
            const upper = "_str_rescan_" + name + "_upper";
            const lower = "_str_rescan_" + name + "_lower";
            const foldDone = "_str_rescan_" + name + "_fold_done";
            vm.label("_str_rescan_kind_" + name);
            // [0-9]
            vm.cmpImm(VReg.V1, 48); vm.jlt(upper);
            vm.cmpImm(VReg.V1, 58); vm.jlt(yes);
            // [A-Z]
            vm.label(upper);
            vm.cmpImm(VReg.V1, 65); vm.jlt(lower);
            vm.cmpImm(VReg.V1, 91); vm.jlt(yes);
            // [a-z] and underscore
            vm.label(lower);
            vm.cmpImm(VReg.V1, 97); vm.jlt(foldDone);
            vm.cmpImm(VReg.V1, 123); vm.jlt(yes);
            vm.label(foldDone);
            vm.cmpImm(VReg.V1, 95); vm.jeq(yes);
            // Long-s/kelvin fold is part of Unicode \\w under /iu only.
            vm.cmpImm(VReg.A4, 3); vm.jne(no);
            vm.cmpImm(VReg.V1, 383); vm.jeq(yes);
            vm.cmpImm(VReg.V1, 8490); vm.jeq(yes);
            vm.jmp(no);
            vm.label(yes); vm.jmp(neg ? miss : hit);
            vm.label(no); vm.jmp(neg ? hit : miss);
        };
        emitWord("w", false);
        emitWord("W", true);

        vm.label(hit);
        vm.add(VReg.A1, VReg.A1, VReg.V4);
        vm.jmp(loop);
        vm.label(miss);
        vm.label(done);
        vm.scvtf(0, VReg.A1);
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();
    }

    // ARM64 leaf for the specialised `/^\\p{...}+$/u` matcher path.  The
    // shim passes the encoded property-table source explicitly so this
    // primitive can decode one interval stream in-place instead of allocating
    // JS arrays and calling __re_cpAt once per scalar.  ABI:
    //   A0 = boxed/raw UTF-8 input string
    //   A1 = byte length of input
    //   A2 = boxed/raw encoded __RE_UT source string
    //   A3 = property table line index
    //   A4 = negated-property bit (0 => \p, 1 => \P)
    // Return is the canonical IEEE-754 Number bits for the consumed endpoint,
    // or -1 for a mismatch.  This entry is emitted only for ARM64; the JS
    // implementation of __re_scanUnicode remains the portable fallback.
    generateReScanUnicode() {
        const vm = this.vm;
        if (!vm.backend || vm.backend.name !== "arm64") return;

        const P = "_str_rescanu_";
        const O_TC = 0;       // encoded-table cursor
        const O_TE = 8;       // current line end (exclusive)
        const O_PREV = 16;    // previous interval high endpoint
        const O_DV = 24;      // varint accumulator
        const O_MUL = 32;     // varint multiplier (base 32)
        const O_PHASE = 40;   // 0 = gap, 1 = length
        const O_NEG = 48;     // \P bit
        // O_HAS is a small state machine: 0 means no interval has been
        // decoded for the current cursor, 1 means S4/S5 hold an interval,
        // and 2 means the table line is exhausted.  The explicit exhausted
        // state is important for negated properties: once a \P table has no
        // more intervals, every monotonically-following code point is an
        // outside hit and must not restart a full table decode.
        const O_HAS = 56;     // 0=unparsed, 1=current interval, 2=exhausted
        const O_LINE = 64;    // current line start (for rewind)
        const O_LAST = 72;    // previous input code point
        const O_CP = 80;      // decoded code point for table parser
        const O_WIDTH = 88;   // decoded UTF-8 width

        const bad = P + "bad";
        const ret = P + "ret";
        const scan = P + "scan";
        const decoded = P + "decoded";
        const rewind = P + "rewind";
        const parseStart = P + "parse_start";
        const parseLoop = P + "parse_loop";
        const parseCont = P + "parse_cont";
        const parseDigit = P + "parse_digit";
        const parseLen = P + "parse_len";
        const parsed = P + "parsed";
        const parseNo = P + "parse_no";
        const interval = P + "interval";
        const needMore = P + "need_more";
        const inside = P + "inside";
        const outside = P + "outside";
        const consume = P + "consume";
        const mismatch = P + "mismatch";
        const success = P + "success";

        vm.label("_str_re_scan_unicode");
        // The scanner is called once per large generated fixture, so saving
        // the S registers is negligible and gives us enough state to keep the
        // hot input/table pointers out of the stack.  Ninety-six bytes keeps
        // the local area 16-byte aligned under the ARM64 ABI.
        vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        // Normalize integer arguments (raw machine integer, tagged int32, or
        // canonical float64 bits).  A2 is a string pointer and is handled
        // separately below.
        const norm = (reg, stem) => {
            const raw = P + stem + "_raw";
            const tag = P + stem + "_tag";
            const done = P + stem + "_done";
            vm.shrImm(VReg.V5, reg, 48);
            vm.cmpImm(VReg.V5, 0); vm.jeq(raw);
            vm.cmpImm(VReg.V5, 0xFFFF); vm.jeq(raw);
            vm.cmpImm(VReg.V5, 0x7FF8); vm.jge(tag);
            vm.fmovToFloat(0, reg); vm.fcvtzs(reg, 0); vm.jmp(done);
            vm.label(raw); vm.jmp(done);
            vm.label(tag); vm.shlImm(reg, reg, 32); vm.sarImm(reg, reg, 32);
            vm.label(done);
        };
        norm(VReg.A1, "n");
        norm(VReg.A3, "ti");
        norm(VReg.A4, "neg");

        vm.mov(VReg.S2, VReg.A1); // input byte bound
        vm.movImm(VReg.S3, 0);    // input byte position
        vm.store(VReg.SP, O_NEG, VReg.A4);
        vm.cmpImm(VReg.S2, 0);
        vm.jle(bad);              // the specialised atom is one-or-more
        vm.cmpImm(VReg.A3, 0);
        vm.jlt(bad);

        // Unbox the input string.  Static/data-segment strings are already raw
        // pointers; the private caller guarantees one of these two forms.
        const inRaw = P + "in_raw";
        const inDone = P + "in_done";
        vm.shrImm(VReg.V5, VReg.A0, 48);
        vm.cmpImm(VReg.V5, 0x7FFC); vm.jne(inRaw);
        vm.emitMaskLoad(VReg.V6);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V6);
        vm.jmp(inDone);
        vm.label(inRaw);
        vm.mov(VReg.S0, VReg.A0);
        vm.label(inDone);

        // __re_uniSrc() returns a heap string (0x7FFC), but accept a raw
        // data-segment pointer as well so the fallback remains robust in a
        // self-hosted image.
        const tabRaw = P + "tab_raw";
        const tabDone = P + "tab_done";
        vm.shrImm(VReg.V5, VReg.A2, 48);
        vm.cmpImm(VReg.V5, 0x7FFC); vm.jne(tabRaw);
        vm.emitMaskLoad(VReg.V6);
        vm.andMaskReg(VReg.S1, VReg.A2, VReg.V6);
        vm.jmp(tabDone);
        vm.label(tabRaw);
        vm.mov(VReg.S1, VReg.A2);
        vm.label(tabDone);

        // Locate line A3 in the newline-delimited compact table.  The encoded
        // source is NUL-terminated by the string runtime, so no extra table
        // length argument is required.
        vm.mov(VReg.V2, VReg.S1);
        vm.movImm(VReg.V0, 0);
        const lineLoop = P + "line_loop";
        const lineAdvance = P + "line_advance";
        const lineFound = P + "line_found";
        vm.label(lineLoop);
        vm.cmp(VReg.V0, VReg.A3); vm.jge(lineFound);
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.cmpImm(VReg.V1, 0); vm.jeq(bad);
        vm.cmpImm(VReg.V1, 10); vm.jne(lineAdvance);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp(lineLoop);
        vm.label(lineAdvance);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp(lineLoop);
        vm.label(lineFound);
        vm.mov(VReg.S1, VReg.V2);       // line start/current table pointer
        vm.store(VReg.SP, O_LINE, VReg.S1);

        const endLoop = P + "end_loop";
        const endFound = P + "end_found";
        vm.label(endLoop);
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, 0); vm.jeq(endFound);
        vm.cmpImm(VReg.V1, 10); vm.jeq(endFound);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp(endLoop);
        vm.label(endFound);
        vm.store(VReg.SP, O_TE, VReg.S1);
        vm.store(VReg.SP, O_TC, VReg.V2);
        vm.movImm(VReg.V0, -1);
        vm.store(VReg.SP, O_PREV, VReg.V0);
        vm.store(VReg.SP, O_LAST, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, O_HAS, VReg.V0);
        // The input scanner must decode the first code point before entering
        // `parsed`; O_CP/O_WIDTH are populated by the scan path.  Starting at
        // parseStart here leaves O_CP uninitialised and can make the first
        // code point look like the boxed input pointer (the stack slot's old
        // contents), rejecting even U+0000.  O_HAS=0 below deliberately sends
        // the first decoded point back through parseStart once it is stored.
        vm.jmp(scan);

        // Decode one interval pair from the compact base-32 stream.  Values
        // alternate gap/length; a terminal digit has payload 0..31 and a
        // continuation digit has payload 0..31 plus another base-32 group.
        vm.label(parseStart);
        vm.movImm(VReg.V0, 0); vm.store(VReg.SP, O_PHASE, VReg.V0);
        vm.store(VReg.SP, O_DV, VReg.V0);
        vm.movImm(VReg.V0, 1); vm.store(VReg.SP, O_MUL, VReg.V0);
        vm.label(parseLoop);
        vm.load(VReg.V2, VReg.SP, O_TC);
        vm.load(VReg.V3, VReg.SP, O_TE);
        vm.cmp(VReg.V2, VReg.V3); vm.jge(parseNo);
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.store(VReg.SP, O_TC, VReg.V2);

        // Inverse of __re_uniDigit(c), kept branch-local so table decoding
        // does not call indexOf/charCodeAt from the hot scanner.
        const d09 = P + "d09";
        const dAZ = P + "dAZ";
        const daz = P + "daz";
        const dDash = P + "ddash";
        const dPunct = P + "dpunct";
        const dOther = P + "dother";
        // Check the ASCII digit range explicitly.  The compact alphabet also
        // uses '-' (ASCII 45); routing every byte below 58 to d09 would turn
        // '-' into -3 and corrupt the first multi-digit gap after U+018B.
        vm.cmpImm(VReg.V1, 48); vm.jlt(dPunct);
        vm.cmpImm(VReg.V1, 58); vm.jlt(d09);
        vm.cmpImm(VReg.V1, 65); vm.jlt(dPunct);
        vm.cmpImm(VReg.V1, 91); vm.jlt(dAZ);
        vm.cmpImm(VReg.V1, 97); vm.jlt(dPunct);
        vm.cmpImm(VReg.V1, 123); vm.jlt(daz);
        vm.jmp(dOther);
        vm.label(d09); vm.subImm(VReg.V1, VReg.V1, 48); vm.jmp(parseDigit);
        vm.label(dAZ); vm.subImm(VReg.V1, VReg.V1, 55); vm.jmp(parseDigit);
        vm.label(daz); vm.subImm(VReg.V1, VReg.V1, 61); vm.jmp(parseDigit);
        vm.label(dPunct);
        vm.cmpImm(VReg.V1, 45); vm.jeq(dDash + "_yes");
        vm.jmp(dOther);
        vm.label(dDash + "_yes"); vm.movImm(VReg.V1, 62); vm.jmp(parseDigit);
        vm.label(dOther); vm.movImm(VReg.V1, 63);

        vm.label(parseDigit);
        vm.cmpImm(VReg.V1, 32); vm.jge(parseCont);
        // Terminal digit: add it to the accumulator, then finish either the
        // gap or the interval length.
        vm.load(VReg.V2, VReg.SP, O_DV);
        // The terminal payload occupies the current base-32 digit position;
        // continuation groups have already advanced O_MUL.  Omitting this
        // multiplication would decode `X2` (65) as 3, shifting every table
        // interval after a multi-digit value.
        vm.load(VReg.V3, VReg.SP, O_MUL);
        vm.mul(VReg.V1, VReg.V1, VReg.V3);
        vm.add(VReg.V2, VReg.V2, VReg.V1);
        vm.load(VReg.V3, VReg.SP, O_PHASE);
        vm.cmpImm(VReg.V3, 0); vm.jne(parseLen);
        vm.load(VReg.V4, VReg.SP, O_PREV);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.add(VReg.V4, VReg.V4, VReg.V2);
        vm.mov(VReg.S4, VReg.V4);        // current lo
        vm.movImm(VReg.V3, 1); vm.store(VReg.SP, O_PHASE, VReg.V3);
        vm.movImm(VReg.V3, 0); vm.store(VReg.SP, O_DV, VReg.V3);
        vm.movImm(VReg.V3, 1); vm.store(VReg.SP, O_MUL, VReg.V3);
        vm.jmp(parseLoop);

        vm.label(parseLen);
        vm.add(VReg.S5, VReg.S4, VReg.V2); // current hi = lo + length
        vm.store(VReg.SP, O_PREV, VReg.S5);
        vm.movImm(VReg.V3, 1); vm.store(VReg.SP, O_HAS, VReg.V3);
        vm.jmp(parsed);

        vm.label(parseCont);
        // Continuation payload is digit-32.  Keep the accumulator and
        // multiplier in locals; table decoding is cold relative to input.
        vm.subImm(VReg.V1, VReg.V1, 32);
        vm.load(VReg.V2, VReg.SP, O_DV);
        vm.load(VReg.V3, VReg.SP, O_MUL);
        vm.mul(VReg.V1, VReg.V1, VReg.V3);
        vm.add(VReg.V2, VReg.V2, VReg.V1);
        vm.store(VReg.SP, O_DV, VReg.V2);
        vm.movImm(VReg.V1, 32);
        vm.mul(VReg.V3, VReg.V3, VReg.V1);
        vm.store(VReg.SP, O_MUL, VReg.V3);
        vm.jmp(parseLoop);

        vm.label(parseNo);
        // End of this property line: every remaining code point is outside
        // the positive property set.
        // Mark the stream exhausted rather than merely "no current
        // interval".  Subsequent monotonically increasing code points can
        // then take the O(1) outside path (especially for \P scans).
        vm.movImm(VReg.V0, 2);
        vm.store(VReg.SP, O_HAS, VReg.V0);

        vm.label(parsed);
        vm.load(VReg.V1, VReg.SP, O_CP);
        vm.load(VReg.V2, VReg.SP, O_HAS);
        vm.cmpImm(VReg.V2, 0); vm.jeq(outside);
        vm.cmpImm(VReg.V2, 2); vm.jeq(outside);
        vm.cmp(VReg.V1, VReg.S5); vm.jgt(needMore);
        vm.jmp(interval);

        vm.label(needMore);
        // cp is monotonic in the generated fixtures; consume intervals until
        // their high endpoint reaches it.  If the table is exhausted,
        // parseNo marks O_HAS=2 and the membership path below handles \P.
        vm.jmp(parseStart);

        vm.label(interval);
        vm.cmp(VReg.V1, VReg.S4); vm.jlt(outside);
        vm.cmp(VReg.V1, VReg.S5); vm.jgt(outside);
        vm.jmp(inside);

        vm.label(inside);
        vm.load(VReg.V2, VReg.SP, O_NEG);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq(consume); // positive property hit
        vm.jmp(mismatch); // negated property must miss here

        vm.label(outside);
        vm.load(VReg.V2, VReg.SP, O_NEG);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq(mismatch); // positive property miss
        vm.jmp(consume);  // negated property hit

        // Decode UTF-8 directly from the backing bytes.  Malformed/truncated
        // leads are one-byte literals; continuation-only bytes use the same
        // out-of-band sentinel as __re_cpAt and are rejected by the Unicode
        // whole-string path below.
        vm.label(scan);
        vm.cmp(VReg.S3, VReg.S2); vm.jge(success);
        vm.add(VReg.V3, VReg.S0, VReg.S3);
        vm.loadByte(VReg.V1, VReg.V3, 0);
        vm.mov(VReg.V6, VReg.V1); // preserve lead for malformed fallback
        const one = P + "one";
        const cont = P + "cont";
        const lead = P + "lead";
        const two = P + "two";
        const three = P + "three";
        const four = P + "four";
        vm.cmpImm(VReg.V1, 128); vm.jlt(one);
        vm.cmpImm(VReg.V1, 192); vm.jlt(cont);
        vm.cmpImm(VReg.V1, 224); vm.jlt(two);
        vm.cmpImm(VReg.V1, 240); vm.jlt(three);
        vm.jmp(four);

        vm.label(one);
        vm.movImm(VReg.V2, 1); vm.jmp(decoded);
        vm.label(cont);
        vm.addImm(VReg.V1, VReg.V1, 2097152);
        vm.movImm(VReg.V2, 1); vm.jmp(decoded);

        vm.label(two);
        vm.addImm(VReg.V3, VReg.S3, 1);
        vm.cmp(VReg.V3, VReg.S2); vm.jge(lead);
        vm.add(VReg.V3, VReg.S0, VReg.V3);
        vm.loadByte(VReg.V4, VReg.V3, 0);
        vm.cmpImm(VReg.V4, 128); vm.jlt(lead);
        vm.cmpImm(VReg.V4, 192); vm.jge(lead);
        vm.andImm(VReg.V1, VReg.V1, 0x1F); vm.shlImm(VReg.V1, VReg.V1, 6);
        vm.andImm(VReg.V4, VReg.V4, 0x3F); vm.or(VReg.V1, VReg.V1, VReg.V4);
        vm.movImm(VReg.V2, 2); vm.jmp(decoded);

        vm.label(three);
        vm.addImm(VReg.V3, VReg.S3, 2);
        vm.cmp(VReg.V3, VReg.S2); vm.jge(lead);
        vm.add(VReg.V3, VReg.S0, VReg.S3); vm.addImm(VReg.V3, VReg.V3, 1);
        vm.loadByte(VReg.V4, VReg.V3, 0);
        vm.add(VReg.V3, VReg.S0, VReg.S3); vm.addImm(VReg.V3, VReg.V3, 2);
        vm.loadByte(VReg.V5, VReg.V3, 0);
        vm.cmpImm(VReg.V4, 128); vm.jlt(lead); vm.cmpImm(VReg.V4, 192); vm.jge(lead);
        vm.cmpImm(VReg.V5, 128); vm.jlt(lead); vm.cmpImm(VReg.V5, 192); vm.jge(lead);
        vm.andImm(VReg.V1, VReg.V1, 0x0F); vm.shlImm(VReg.V1, VReg.V1, 12);
        vm.andImm(VReg.V4, VReg.V4, 0x3F); vm.shlImm(VReg.V4, VReg.V4, 6); vm.or(VReg.V1, VReg.V1, VReg.V4);
        vm.andImm(VReg.V5, VReg.V5, 0x3F); vm.or(VReg.V1, VReg.V1, VReg.V5);
        vm.movImm(VReg.V2, 3); vm.jmp(decoded);

        vm.label(four);
        vm.addImm(VReg.V3, VReg.S3, 3);
        vm.cmp(VReg.V3, VReg.S2); vm.jge(lead);
        vm.add(VReg.V3, VReg.S0, VReg.S3); vm.addImm(VReg.V3, VReg.V3, 1);
        vm.loadByte(VReg.V4, VReg.V3, 0);
        vm.add(VReg.V3, VReg.S0, VReg.S3); vm.addImm(VReg.V3, VReg.V3, 2);
        vm.loadByte(VReg.V5, VReg.V3, 0);
        vm.add(VReg.V3, VReg.S0, VReg.S3); vm.addImm(VReg.V3, VReg.V3, 3);
        vm.loadByte(VReg.V0, VReg.V3, 0);
        vm.cmpImm(VReg.V4, 128); vm.jlt(lead); vm.cmpImm(VReg.V4, 192); vm.jge(lead);
        vm.cmpImm(VReg.V5, 128); vm.jlt(lead); vm.cmpImm(VReg.V5, 192); vm.jge(lead);
        vm.cmpImm(VReg.V0, 128); vm.jlt(lead); vm.cmpImm(VReg.V0, 192); vm.jge(lead);
        vm.andImm(VReg.V6, VReg.V6, 0x0F); vm.shlImm(VReg.V6, VReg.V6, 18);
        vm.andImm(VReg.V4, VReg.V4, 0x3F); vm.shlImm(VReg.V4, VReg.V4, 12); vm.or(VReg.V6, VReg.V6, VReg.V4);
        vm.andImm(VReg.V5, VReg.V5, 0x3F); vm.shlImm(VReg.V5, VReg.V5, 6); vm.or(VReg.V6, VReg.V6, VReg.V5);
        vm.andImm(VReg.V0, VReg.V0, 0x3F); vm.or(VReg.V1, VReg.V6, VReg.V0);
        vm.movImm(VReg.V2, 4); vm.jmp(decoded);

        vm.label(lead);
        vm.mov(VReg.V1, VReg.V6);
        vm.movImm(VReg.V2, 1);

        vm.label(decoded);
        // This whole-string fast path is only selected for /u.  Reject both
        // continuation sentinels and decoded >U+10FFFF sequences, matching
        // __re_clsPk (positive and negated properties both reject malformed
        // UTF-8 in Unicode mode).
        vm.cmpImm(VReg.V1, 1114112); vm.jge(mismatch);
        vm.store(VReg.SP, O_CP, VReg.V1);
        vm.store(VReg.SP, O_WIDTH, VReg.V2);

        // A generated property string is normally monotonic, but arbitrary
        // callers can provide a decreasing sequence.  Rewind the compact
        // cursor to the line start in that case to preserve exact semantics.
        vm.load(VReg.V3, VReg.SP, O_LAST);
        vm.cmp(VReg.V1, VReg.V3); vm.jlt(rewind);
        vm.store(VReg.SP, O_LAST, VReg.V1);
        vm.load(VReg.V3, VReg.SP, O_HAS);
        vm.cmpImm(VReg.V3, 0); vm.jeq(parseStart);
        // O_HAS=2 is the exhausted-stream state; retain it across forward
        // scans so parsed→outside does not re-enter parseStart.
        vm.jmp(parsed);

        vm.label(rewind);
        vm.store(VReg.SP, O_LAST, VReg.V1);
        vm.load(VReg.V3, VReg.SP, O_LINE);
        vm.store(VReg.SP, O_TC, VReg.V3);
        vm.movImm(VReg.V3, -1); vm.store(VReg.SP, O_PREV, VReg.V3);
        vm.movImm(VReg.V3, 0); vm.store(VReg.SP, O_HAS, VReg.V3);
        vm.jmp(parseStart);

        vm.label(consume);
        vm.load(VReg.V2, VReg.SP, O_WIDTH);
        vm.add(VReg.S3, VReg.S3, VReg.V2);
        vm.jmp(scan);

        vm.label(success);
        vm.mov(VReg.V0, VReg.S3);
        vm.jmp(ret);
        vm.label(bad);
        vm.label(mismatch);
        vm.movImm(VReg.V0, -1);
        vm.label(ret);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);
    }

    // 生成所有字符串函数
    generate() {
        this.generateStrlen();
        this.generateStrLength(); // 统一 length 访问
        this.generateStrcmp();
        this.generateStrRelcmpUtf16();
        this.generateLocaleCompare();
        this.generateStrcpy();
        this.generateStrcat();
        this.generateGetStrContent();
        this.generateStrconcat();
        this.generateStrConcatIP(); // [L4.1] 原地拼接助手(编译器逃逸门控专用;守卫不满足尾委托 _strconcat)
        this.generateCstrToHeapStr();
        this.generateNstrToHeapStr();
        this.generateCharToStr();
        this.generateCpToStr(); // [fromCodePoint astral] 码点→UTF-8 串(含 RangeError 校验)
        this.generatePadEnd();
        this.generatePadStart();
        this.generateUtf16Pad();
        this.generateIntToStr();
        this.generateBoolToStr();
        this.generateToString();
        this.generateValueToStr(); // 智能值转字符串
        this.generateIsAsmjsErr(); // [#36] Error 族字符串化判别
        this.generateErrorToStr(); // [#36] Error 对象 → "name: message"
        this.generateNumberToString(); // 数字转字符串
        this.generateDragon4Bignum(); // Dragon4 大整数原语(_floatToString 依赖)
        this.generateFloatToString(); // 浮点数转字符串(最短往返)
        // 字符串方法
        this.generateUnicodeCase();
        this.generateToUpperCase();
        this.generateToLowerCase();
        this.generateCharAt();
        this.generateUtf16Helpers();
        this.generateStrCpBytes();
        this.generateStrCodepointAt();
        this.generateStrProtoCodePointAt();
        this.generateStrProtoCodePointAtUtf16();
        this.generateStrIndexChar();
        this.generateByteAt();
        // ARM64's V/A register file has enough caller-saved scratch registers
        // for the private regexp decoder, so use the leaf form there.  Keep
        // the callee-save implementation for x64/wasm until their aliasing
        // contracts receive the same dedicated lowering.
        if (this.vm.backend && this.vm.backend.name === "arm64") {
            this.generateCpAtFastLeaf();
        } else {
            this.generateCpAtFast();
        }
        // Private ARM64 regexp bulk scanner.  Other backends intentionally
        // omit the label and use the shim's JavaScript fallback.
        this.generateReScanClass();
        this.generateReScanUnicode();
        this.generateCharCodeAt();
        this.generateCharCodeAtUtf16();
        this.generateStringStaticApplyArray();
        this.generateWsLen();      // [W-25] 空白判定(完整 WhiteSpace ∪ LineTerminator)
        this.generateWsLenBack();  // [W-25] 同上,尾部扫描方向
        this.generateArgStr();     // [W-25] 字符串实参 ToString 归一
        this.generateSymGetMethod(); // [W4]
        this.generateSymCallMethod(); // [W4]
        this.generateTrim();
        this.generateTrimStart();
        this.generateTrimEnd();
        this.generateSubstr();
        this.generateSubstring(); // _str_substring(str.substring 语义:负→0、swap);此前死代码未接
        this.generateStrNew();         // _str_new: create empty heap string
        this.generateReplaceExpand();
        this.generateReplace();
        this.generateReplaceAll();
        this.generateReplaceAllFn();
        this.generateNumToString();
        this.generateNumToFixed();
        this.generateSlice();
        this.generateUtf16Slice();
        this.generateIndexOf();
        // StringMethodsGenerator methods (includes, startsWith, endsWith, etc.)
        this.generateIncludes();
        this.generateStartsWith();
        this.generateEndsWith();
        this.generateLastIndexOf();
        this.generateArefLastIndexOf();
        this.generateRepeat();
        this.generateAt();
        this.generateConcat();
        this.generateNormalize();
        this.generateIsWellFormed();
        this.generateSplit();
        this.generateStrSearch(); // [L3]
        this.generateStrMatch();  // [L3]
        this.generateStrMatchAll(); // [L3]
        this.generateSubstringRaw();
        // String.prototype wrapper methods (toString/valueOf for new String() objects)
        this.generateToStringWrapper();
        this.generateValueOf();
        this.generateStringIterator();
        // [W7-1] Number.prototype 方法值的守卫包装族(_aref_num_*)
        this.generateNumArefWrappers();
        // 基础操作 (Moved from base.js)
        this.generateRawStrlen();
        this.generateStrLength();
    }

    // [W7-1] Number.prototype 方法值的 aref 守卫包装(_aref_num_*)。
    // 物化 Number.prototype 的方法值闭包(24B {magic, _aref_generic, helper})经蹦床把
    // 动态接收者插到 A0:`Number.prototype.toFixed.call(5,2)` / `var f=(5).toFixed; f(2)`
    // (this=undefined → 守卫拒)/`(new Number()).valueOf("argument")`(原 SIGSEGV,守卫兜住)。
    // 守卫判据(数字 = 装箱 int32 0x7FF8 / 裸 float64 / 负 double / denormal;
    // 拒 = 0x7FF9..0x7FFF tag 族[bool/null/undefined/字符串/对象/数组/函数]与
    // high16==0 且 ≥ ptrFloor 的裸指针[堆/数据段];denormal(如 Number.MIN_VALUE=0x1)
    // < ptrFloor 放行)。0x7FFD 仅当 __number_value 为数字才拆包装;缺槽或非数字
    // (Boolean/Date 借用 Number.prototype.valueOf)→ TypeError。失败交 _aref_throw_incompat(Map 族同型
    // 消息 "Method Number.prototype.<m> called on incompatible receiver " + _fmt_receiver;
    // node 文案 "requires that 'this' be a Number" 不同,记偏差 —— test262 只验 TypeError 类)。
    // x64 纪律(registers.js 硬规):实参先落 S 系(A0→S0、A1→S1)再用 V1/V2 取
    // tag/常数 —— 此时 A2/A3 已无活值,V1≡A3/V2≡A2 写安全;全程不写 V0(≡RET≡A0)。
    generateNumArefWrappers() {
        const vm = this.vm;
        const STRTAG = 0x7ffc000000000000n;

        // 守卫头:成功落穿;失败 jmp <tag>_bad。前置:S0 = 接收者(已落)。
        // 0x7FFD Number 包装对象:提取 __number_value,品牌校验后落 S0 继续数字路径。
        const guardHead = (tag) => {
            vm.shrImm(VReg.V1, VReg.S0, 48);      // V1 = high16(A 系已无活值)
            vm.cmpImm(VReg.V1, 0x7FFD);
            vm.jne(tag + "_chk_box");
            // Number wrapper:提取 __number_value 后再按数字判别。S0 保持原接收者,
            // 直到确认是数字才覆写 —— 失败桩 _aref_throw_incompat 需要原 this。
            // 旧实现把 high16!=0 一律当数字 → 缺槽得 undefined(0x7FFB) 也放行。
            vm.mov(VReg.A0, VReg.S0);             // A0 = boxed wrapper
            vm.lea(VReg.A1, vm.asm.addString("__number_value"));
            vm.movImm64(VReg.V2, STRTAG);
            vm.or(VReg.A1, VReg.A1, VReg.V2);     // A1 = boxed "__number_value"
            vm.call("_object_get");               // RET = stored value / undefined
            vm.shrImm(VReg.V1, VReg.RET, 48);
            vm.cmpImm(VReg.V1, 0x7FF8);
            vm.jeq(tag + "_unwrap");              // 装箱 int32
            vm.cmpImm(VReg.V1, 0x7FF9);
            vm.jlt(tag + "_unwrap_raw");          // 正 double / high16==0
            vm.cmpImm(VReg.V1, 0x7FFF);
            vm.jle(tag + "_bad");                 // 缺槽 undefined 或其它 tag
            vm.jmp(tag + "_unwrap");              // 负 double
            vm.label(tag + "_unwrap_raw");
            vm.cmpImm(VReg.V1, 0);
            vm.jne(tag + "_unwrap");
            vm.movImm64(VReg.V2, vm.ptrFloor);
            vm.cmp(VReg.RET, VReg.V2);
            vm.jge(tag + "_bad");
            vm.label(tag + "_unwrap");
            vm.mov(VReg.S0, VReg.RET);
            vm.jmp(tag + "_ok");
            vm.label(tag + "_chk_box");
            vm.cmpImm(VReg.V1, 0x7FF8);
            vm.jeq(tag + "_ok");                  // 装箱 int32
            vm.cmpImm(VReg.V1, 0x7FF9);
            vm.jlt(tag + "_raw");
            vm.cmpImm(VReg.V1, 0x7FFF);
            vm.jle(tag + "_bad");                 // 0x7FF9..0x7FFF tag 族
            vm.jmp(tag + "_ok");                  // > 0x7FFF:负 double
            vm.label(tag + "_raw");
            vm.cmpImm(VReg.V1, 0);
            vm.jne(tag + "_ok");                  // 正 double(指数非 0)
            vm.movImm64(VReg.V2, vm.ptrFloor);    // V2 安全(A2 无活值)
            vm.cmp(VReg.S0, VReg.V2);
            vm.jge(tag + "_bad");                 // 裸指针(堆/数据段)→ 非数字
            vm.label(tag + "_ok");                // denormal/小整数 → 数字
        };
        // 失败桩:前缀(装箱)+ 原接收者 → _aref_throw_incompat,不返回。
        const guardBad = (tag, prefix) => {
            vm.label(tag + "_bad");
            vm.mov(VReg.A0, VReg.S0);             // 原接收者
            vm.lea(VReg.A1, vm.asm.addString(prefix));
            vm.movImm64(VReg.V1, STRTAG);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.call("_aref_throw_incompat");      // 不返回
            vm.epilogue([VReg.S0, VReg.S1], 0);   // 理论不达(帧平衡)
        };
        // 装箱实参 → 裸 int,缺省(undefined)取 defaultRaw。前置:S1 = 装箱实参。
        // 经 _to_int32(ToNumber 语义:串 "16"→16、NaN→0,与直调快路 functions.js 同源);
        // 结果落 A1。defL 标签按 caller 给。
        const argIntOr = (tag, defaultRaw, goL) => {
            vm.shrImm(VReg.V1, VReg.S1, 48);
            vm.cmpImm(VReg.V1, 0x7FFB);           // undefined → 缺省
            vm.jeq(tag + "_dft");
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_to_int32");
            vm.mov(VReg.A1, VReg.RET);
            vm.jmp(goL);
            vm.label(tag + "_dft");
            vm.movImm(VReg.A1, defaultRaw);
        };

        // _aref_num_toString(recv, radix?) -> 装箱串。radix 缺省 10。
        vm.label("_aref_num_toString");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        guardHead("_ants");
        // argc==0: leftover A1 is not a radix. _aref_generic shifts the
        // incoming A0 (this, set by _object_user_tostr) into A1, so
        // toString() on new Number(1) became toString(1) → RangeError.
        vm.lea(VReg.V1, "_call_argc");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ants_dft");
        argIntOr("_ants", 10, "_ants_go");
        vm.label("_ants_go");
        // radix 缺省/10:规范 ToString(含小数)。_num_toString 截断成整数
        // → (new Number(1.1)).toString()==="1"(S15.4_A1.1_T7 ToPropertyKey)。
        vm.cmpImm(VReg.A1, 10);
        vm.jne("_ants_radix");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_numberToString");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_ants_radix");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_num_toString");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        guardBad("_ants", "Method Number.prototype.toString called on incompatible receiver ");

        // _aref_num_toFixed(recv, digits?) -> 装箱串。digits 缺省 0。
        // ES 21.1.3.5:ToIntegerOrInfinity(f);f 非有限或 ∉[0,100] → RangeError。
        // 须先于 x≥10^21 的 ToString 快路(否则 (1e21).toFixed(+Infinity) 得串)。
        vm.label("_aref_num_toFixed");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        guardHead("_antf");
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_antf_dft");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_to_integer");
        vm.mov(VReg.A1, VReg.RET);
        vm.jmp("_antf_range");
        vm.label("_antf_dft");
        vm.movImm(VReg.A1, 0);
        vm.label("_antf_range");
        vm.cmpImm(VReg.A1, 0);
        vm.jlt("_antf_range_err");
        vm.cmpImm(VReg.A1, 100);
        vm.jgt("_antf_range_err");
        vm.jmp("_antf_go");
        vm.label("_antf_range_err");
        vm.lea(VReg.A0, vm.asm.addString("toFixed() digits argument must be between 0 and 100"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.label("_antf_go");
        // [L3] ES 21.1.3.5 step 9: if x >= 10^21, delegate to _numberToString.
        // Only raw floats (high16 < 0x7FF8) with biased exponent >= 0x444 and
        // non-negative. Int32/boxed values can never be this large.
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jge("_antf_dots"); // tagged value (int32/object/etc.) -> not large
        vm.shrImm(VReg.V0, VReg.S0, 63);
        vm.cmpImm(VReg.V0, 1);
        vm.jeq("_antf_dots"); // negative -> not >= 1e21
        vm.shrImm(VReg.V0, VReg.S0, 52);
        vm.andImm(VReg.V0, VReg.V0, 0x7FF);
        vm.cmpImm(VReg.V0, 0x444); // biased exponent for 2^69 ~ 5.9e20
        vm.jlt("_antf_dots");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_numberToString");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_antf_dots");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_num_toFixed");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        guardBad("_antf", "Method Number.prototype.toFixed called on incompatible receiver ");

        // _aref_num_valueOf(recv) -> 数字恒等(多余实参忽略,同 _str_valueOf 镜像)。
        vm.label("_aref_num_valueOf");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        guardHead("_anv");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        guardBad("_anv", "Method Number.prototype.valueOf called on incompatible receiver ");
    }

    // ========== 基础操作 (Moved from base.js) ==========

    // 生成原始字符串长度函数（遍历计算，用于裸字符串指针）
    // _raw_strlen(str) -> length
    generateRawStrlen() {
        const vm = this.vm;
        vm.label("_raw_strlen");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.S1, 0);
        const loopLabel = "_raw_strlen_loop";
        const doneLabel = "_raw_strlen_done";
        vm.label(loopLabel);
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(doneLabel);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp(loopLabel);
        vm.label(doneLabel);
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 获取字符串长度 (alias)
    generateStrLength() {
        const vm = this.vm;
        vm.label("_str_length");
        vm.jmp("_strlen");
    }

    // _str_search(str_boxed, regexp_or_str) → 裸整数 index (未匹配 = -1)
    // A0 = 装箱字符串(this)
    // A1 = 装箱参数(RegExp 或 字符串)
    generateStrSearch() {
        const vm = this.vm;
        const searchSaved = [VReg.S0, VReg.S1, VReg.S2, VReg.S3];
        vm.label("_str_search");
        vm.prologue(32, searchSaved);
        vm.mov(VReg.S0, VReg.A0); // str
        vm.mov(VReg.S1, VReg.A1); // arg
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("search");
        vm.mov(VReg.S0, VReg.A0);
        {
            const skipSym = "_sr_skip_sym";
            const noMethod = "_sr_nomethod";
            vm.lea(VReg.V0, "_js_undefined");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.movImm64(VReg.V0, 0x7ffa000000000000n);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.shrImm(VReg.V0, VReg.S1, 48);
            vm.cmpImm(VReg.V0, 0x7FFD);
            vm.jne(skipSym);
            this._emitLoadWellknownSymbol("search");
            vm.mov(VReg.A1, VReg.RET);
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_str_getmethod");
            vm.lea(VReg.V0, "_js_undefined");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.RET, VReg.V0);
            vm.jeq(noMethod);
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S1);
            vm.mov(VReg.A2, VReg.S0);
            vm.movImm64(VReg.A3, 0x7ffb000000000000n);
            vm.movImm(VReg.A4, 1);
            vm.call("_str_call_method");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_to_int32");
            vm.epilogue(searchSaved, 32);
            vm.label(noMethod);
            vm.label(skipSym);
        }
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET); // S2 = str_ptr
        // [L3] RegExp 检测:高16=0,堆内,type@0==8 → _regexp_search
        const srNotRe = "_sr_not_re";
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne(srNotRe);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq(srNotRe);
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jb(srNotRe);
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jae(srNotRe);
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, 8); // TYPE_REGEXP
        vm.jne(srNotRe);
        vm.mov(VReg.A0, VReg.S1); // re_ptr
        vm.mov(VReg.A1, VReg.S2); // str_ptr
        vm.call("_regexp_search");
        vm.jmp("_sr_done");
        vm.label(srNotRe);
        // 非 RegExp:委托 _str_indexOf(this, arg, 0)
        vm.mov(VReg.A0, VReg.S0); // this string
        vm.mov(VReg.A1, VReg.S1); // arg (indexOf 自行 ToString)
        vm.movImm(VReg.A2, 0);    // fromIndex = 0
        vm.call("_str_indexOf");  // RET = 裸 int(index or -1),同 indexOf
        vm.label("_sr_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    generateStrMatch() {
        const vm = this.vm;
        const matchSaved = [VReg.S0, VReg.S1, VReg.S2, VReg.S3];
        vm.label("_str_match");
        vm.prologue(32, matchSaved);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("match");
        vm.mov(VReg.S0, VReg.A0);
        {
            const skipSym = "_sm_skip_sym";
            vm.lea(VReg.V0, "_js_undefined");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.movImm64(VReg.V0, 0x7ffa000000000000n);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            this._emitSymDelegate({
                symName: "match", searchReg: VReg.S1, thisReg: VReg.S0,
                arg2Reg: null, argc: 1, fallLabel: skipSym,
                savedRegs: matchSaved, frameSize: 32, tag: "match",
            });
            vm.label(skipSym);
        }
        // [L3] RegExp detection: high16=0, in heap, type@0==8 -> regexp match
        const smNotRe = "_sm_not_re";
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne(smNotRe);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq(smNotRe);
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jb(smNotRe);
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jae(smNotRe);
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, 8); // TYPE_REGEXP
        vm.jne(smNotRe);
        // RegExp path: call _regexp_search to find match, extract matched substring
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");   // RET = str_ptr
        vm.mov(VReg.S2, VReg.RET);   // S2 = str_ptr
        vm.mov(VReg.A0, VReg.S1);    // A0 = re_ptr
        vm.mov(VReg.A1, VReg.S2);    // A1 = str_ptr
        vm.call("_regexp_search");   // RET = match_index
        vm.mov(VReg.S3, VReg.RET);   // S3 = match_index
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_sm_null_v2");       // no match -> null
        vm.push(VReg.S3);            // [SP] = match_index(跨后续调用保活)
        // Load pattern_ptr from re+8, get pattern_len
        vm.load(VReg.V0, VReg.S1, 8);   // V0 = pattern_ptr
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_strlen");              // RET = pattern_len
        vm.add(VReg.V1, VReg.S3, VReg.RET); // V1 = end = match_index + pattern_len
        // Extract matched substring via _str_substring_raw
        vm.mov(VReg.A0, VReg.S2);   // A0 = str_ptr
        vm.mov(VReg.A1, VReg.S3);   // A1 = match_index
        vm.mov(VReg.A2, VReg.V1);   // A2 = end
        vm.call("_str_substring_raw"); // RET = matched str (boxed 0x7FFC)
        vm.mov(VReg.S3, VReg.RET);  // S3 = matched str (boxed)
        // Build result array [matched_str]
        vm.movImm(VReg.A0, 1);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_array_set");
        // [test262 S15.5.4.10_A1_T6] 非全局 RegExp:match 结果 = exec 结果,
        // 须带 index/input 属性(此前缺 → __matched.index 恒 undefined)。
        vm.mov(VReg.A0, VReg.S2);   // A0 = raw array
        vm.lea(VReg.A1, vm.asm.addString("index"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.load(VReg.A2, VReg.SP, 0);   // A2 = match index (raw int)
        vm.scvtf(0, VReg.A2);
        vm.fmovToInt(VReg.A2, 0);       // canonical number
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("input"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0);       // A2 = boxed this string
        vm.call("_object_set");
        vm.pop(VReg.V0);
        vm.mov(VReg.RET, VReg.S2);
        vm.call("_box_arr_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        // Non-RegExp path: fall back to _str_indexOf
        vm.label(smNotRe);
        // [test262 S15.5.4.10_A1_T6] undefined 参 ≡ RegExp(undefined) ≡ 空模式(匹配
        // 空串,index 0);此前 ToString(undefined)="undefined" 错配 "undefined" 子串。
        // null 仍走 ToString → "null"(RegExp(null) 同)。
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jne("_sm_tostr");
        vm.lea(VReg.S1, "_str_empty");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V1);
        vm.label("_sm_tostr");
        // Non-RegExp: convert search value to string, find first match via indexOf,
        // extract matched substring (not the full this string as before).
        this._emitArgStrInline(VReg.S1, "_sm_search");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0);
        vm.call("_str_indexOf");
        vm.mov(VReg.S3, VReg.RET);             // S3 = match index
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_sm_null_v2");
        vm.push(VReg.S3);                       // [SP] = match index(跨调用保活)
        // Extract matched substring: this[start..start+searchLen]
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");             // RET = str_ptr
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");                    // RET = searchLen
        vm.add(VReg.V1, VReg.S3, VReg.RET);    // V1 = end = idx + searchLen
        vm.mov(VReg.A0, VReg.S2);              // A0 = str_ptr
        vm.mov(VReg.A1, VReg.S3);              // A1 = idx (start)
        vm.mov(VReg.A2, VReg.V1);              // A2 = end
        vm.call("_str_substring_raw");         // RET = boxed matched substring
        vm.mov(VReg.S3, VReg.RET);
        // Build result array [matched_substring]
        vm.movImm(VReg.A0, 1);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_array_set");
        // [test262] match(非 RegExp 参)同样带 index/input(RegExp(arg).exec 语义)。
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("index"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.scvtf(0, VReg.A2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("input"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        vm.pop(VReg.V0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_box_arr_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_sm_null_v2");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _str_matchAll(A0=boxed this str, A1=searchVal) -> boxed array of all matches.
    // Non-RegExp:逐次 _str_indexOf;RegExp:逐次 _regexp_search。均返匹配子串数组。
    generateStrMatchAll() {
        const vm = this.vm;
        const maSaved = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4];
        vm.label("_str_matchAll");
        vm.prologue(48, maSaved);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this._emitThisToString("matchAll");
        vm.mov(VReg.S0, VReg.A0);
        {
            const skipSym = "_sma_skip_sym";
            vm.lea(VReg.V0, "_js_undefined");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.movImm64(VReg.V0, 0x7ffa000000000000n);
            vm.cmp(VReg.S1, VReg.V0);
            vm.jeq(skipSym);
            vm.shrImm(VReg.V0, VReg.S1, 48);
            vm.cmpImm(VReg.V0, 0x7FFD);
            vm.jne(skipSym);
            this._emitReplaceAllRegExpGCheck(VReg.S1, "mall");
            this._emitSymDelegate({
                symName: "matchAll", searchReg: VReg.S1, thisReg: VReg.S0,
                arg2Reg: null, argc: 1, fallLabel: skipSym,
                savedRegs: maSaved, frameSize: 48, tag: "matchAll",
            });
            vm.label(skipSym);
        }
        const noRe = "_sma_nore";
        const reBox = "_sma_rebox";
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq(reBox);
        vm.cmpImm(VReg.V0, 0);
        vm.jne(noRe);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq(noRe);
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jb(noRe);
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jae(noRe);
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, 8);
        vm.jne(noRe);
        vm.jmp("_sma_re_have_ptr");
        vm.label(reBox);
        vm.push(VReg.S0);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("__isRegExp"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.call("_object_get");
        vm.cmpImm(VReg.RET, 0);
        vm.pop(VReg.S0);
        vm.jeq(noRe);
        vm.push(VReg.S0);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("__pat"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.call("_object_get");
        vm.mov(VReg.S1, VReg.RET); // S1 = boxed pattern (will be raw ptr below)
        vm.pop(VReg.S0);

        // Normalize: for boxed RegExp path (b), S1 is boxed pattern; unbox to raw ptr.
        // For raw ptr path (a), S1 is already a raw RegExp pointer.
        // _regexp_search takes (pattern_ptr, str_at_pos), so a raw pattern ptr is needed.
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_sma_re_have_ptr");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET); // S1 = raw pattern ptr
        vm.label("_sma_re_have_ptr");
        // -- RegExp path: delegate to _str_match iterating each position --
        // For simplicity, create result array, loop calling _str_substring_raw.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent"); // RET = str_ptr
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_strlen"); // RET = str_len
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S4, VReg.RET); // S4 = result array (raw)
        vm.movImm(VReg.S0, 0);     // reuse S0 as pos
        vm.label("_sma_re_loop");
        vm.cmp(VReg.S0, VReg.S3);
        vm.jge("_sma_re_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.add(VReg.A1, VReg.S2, VReg.S0);
        vm.push(VReg.S0); vm.push(VReg.S1); vm.push(VReg.S2);
        vm.push(VReg.S3); vm.push(VReg.S4);
        vm.call("_regexp_search"); // RET = rel_idx or -1
        vm.mov(VReg.V0, VReg.RET);
        vm.pop(VReg.S4); vm.pop(VReg.S3);
        vm.pop(VReg.S2); vm.pop(VReg.S1);
        vm.pop(VReg.S0);
        vm.cmpImm(VReg.V0, 0);
        vm.jlt("_sma_re_adv");
        // Found match at S0+V0
        vm.add(VReg.V0, VReg.S0, VReg.V0); // V0 = abs_idx
        // Save abs_idx on stack before function calls clobber V0
        vm.push(VReg.V0);
        // Extract: _str_substring_raw(str_ptr, abs_idx, abs_idx+1) -- use +1 as fallback
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.V0);
        vm.addImm(VReg.A2, VReg.V0, 1); // rough: extract 1 char (simplified)
        vm.push(VReg.S0); vm.push(VReg.S1); vm.push(VReg.S2);
        vm.push(VReg.S3); vm.push(VReg.S4);
        vm.call("_str_substring_raw"); // RET = boxed match
        vm.mov(VReg.A1, VReg.RET);
        vm.pop(VReg.S4); vm.pop(VReg.S3);
        vm.pop(VReg.S2); vm.pop(VReg.S1);
        vm.pop(VReg.S0);
        vm.mov(VReg.A0, VReg.S4);
        vm.push(VReg.S0); vm.push(VReg.S1); vm.push(VReg.S2);
        vm.push(VReg.S3); vm.push(VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S4, VReg.RET);
        vm.pop(VReg.S4); vm.pop(VReg.S3);
        vm.pop(VReg.S2); vm.pop(VReg.S1);
        vm.pop(VReg.S0);
        vm.pop(VReg.V0);                    // restore abs_idx
        vm.addImm(VReg.S0, VReg.V0, 1); // advance past match start
        vm.jmp("_sma_re_loop");
        vm.label("_sma_re_adv");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_sma_re_loop");
        vm.label("_sma_re_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.call("_box_arr_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // -- Non-RegExp path --
        vm.label(noRe);
        // Ensure searchValue is string
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.S1, VReg.RET);
        // Search string length (stored at SP+32, survives calls)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        vm.store(VReg.SP, 32, VReg.RET); // searchLen @ SP+32
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET); // S2 = result array
        vm.movImm(VReg.S4, 0);     // S4 = pos
        vm.label("_sma_str_loop");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S4);
        vm.push(VReg.S0); vm.push(VReg.S1); vm.push(VReg.S2);
        vm.push(VReg.S3); vm.push(VReg.S4);
        vm.call("_str_indexOf"); // RET = idx or -1
        vm.mov(VReg.V0, VReg.RET);
        vm.pop(VReg.S4); vm.pop(VReg.S3);
        vm.pop(VReg.S2); vm.pop(VReg.S1);
        vm.pop(VReg.S0);
        vm.cmpImm(VReg.V0, 0);
        vm.jlt("_sma_str_done");
        vm.mov(VReg.S3, VReg.V0); // found idx
        // Extract substring at found position, length = searchLen (from SP+32)
        vm.load(VReg.V3, VReg.SP, 32); // V3 = searchLen
        vm.mov(VReg.A0, VReg.S0);
        vm.push(VReg.S0); vm.push(VReg.S1); vm.push(VReg.S2);
        vm.push(VReg.S3); vm.push(VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.add(VReg.A2, VReg.S3, VReg.V3); // end = idx + searchLen
        vm.call("_str_substring_raw");
        vm.mov(VReg.A1, VReg.RET);
        vm.pop(VReg.S4); vm.pop(VReg.S3);
        vm.pop(VReg.S2); vm.pop(VReg.S1);
        vm.pop(VReg.S0);
        vm.mov(VReg.A0, VReg.S2);
        vm.push(VReg.S0); vm.push(VReg.S1); vm.push(VReg.S2);
        vm.push(VReg.S3); vm.push(VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.pop(VReg.S4); vm.pop(VReg.S3);
        vm.pop(VReg.S2); vm.pop(VReg.S1);
        vm.pop(VReg.S0);
        vm.load(VReg.V3, VReg.SP, 32); // V3 = searchLen
        vm.add(VReg.S4, VReg.S3, VReg.V3); // advance pos by searchLen
        vm.jmp("_sma_str_loop");
        vm.label("_sma_str_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.call("_box_arr_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
    }
}
