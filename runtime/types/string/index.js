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

    // _str_localeCompare(A0=str, A1=other) -> RET:JS number -1/0/1(逐字节码点比较)。
    // 无 ICU:退化为 _strcmp 的符号,返回标准 float64 位 JS number。ASCII/普通文本对齐 node。
    generateLocaleCompare() {
        const vm = this.vm;
        vm.label("_str_localeCompare");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        this._emitThisStringCheck("localeCompare");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        // [W-25] that 实参 ToString:localeCompare(undefined) 须与 "undefined" 比较
        // (test262 15.5.4.9_3),此前 _getStrContent(undefined) → 空串 → 恒返 1。
        this._emitArgStrInline(VReg.S1, "_localeCompare_that");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // str content
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET); // other content
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
        vm.shrImm(VReg.V1, reg, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(skip);
        vm.cmpImm(VReg.V1, 0x7ffc);
        vm.jeq(skip);
        vm.cmpImm(VReg.V1, 0x7fff);
        vm.jeq(skip);
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
        vm.jge("_getStrContent_invalid"); // 超出堆当前边界，非法指针

        // 在堆范围内，检查类型标记是否为 STRING
        vm.subImm(VReg.V0, VReg.S0, 16); // V0 = block pointer
        vm.load(VReg.V1, VReg.V0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.movImm(VReg.V2, TYPE_STRING);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jne("_getStrContent_invalid");

        // 是堆字符串，返回 content 指针 (S0 已经是 block+16)
        vm.jmp("_getStrContent_done_direct");

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

    // _char_to_str(code) -> 单字符装箱 JS 字符串 (String.fromCharCode)
    generateCharToStr() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_char_to_str");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S4, VReg.S5]); // S4/S5 被本函数当 scratch,须保存(P1 审计)

        vm.call("_syscall_arg"); // 归一化 code 为整数
        vm.mov(VReg.S0, VReg.RET);

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

        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S4, VReg.S5], 16);
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
        this._emitThisStringCheck(label);

        // S0 = 原串内容, S1 = pad 内容, S3 = targetLen
        vm.push(VReg.A1);
        vm.push(VReg.A2);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);
        vm.pop(VReg.S1); // padStr(原样,先 ToString 再取内容)
        // [W-25] fillString ToString:"abc".padStart(10,false) 须用 "false" 填充
        // (test262 padStart/fill-string-non-strings);此前非串 pad 落 _getStrContent
        // 非法路径 → 空串 → 退化成空格填充。
        this._emitArgStrInline(VReg.S1, label);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET);
        vm.pop(VReg.A0); // targetLen
        vm.call("_syscall_arg"); // 归一化为整数
        vm.mov(VReg.S3, VReg.RET);

        // S2 = 原串长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET);

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

        // Tag 7 = function: return "[Function]"
        vm.cmpImm(VReg.V1, 7);
        vm.jeq("_valueToStr_js_function");

        // Tag 6 = array: unbox and call _array_to_string
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
        // [Date] 装箱 Date(对象头字节 TYPE_DATE=7)→ _date_toString("Www Mmm DD YYYY ...")。
        // 必须先于 _is_asmjs_err:16B Date 块被当 Error 品牌遍历即野扫(判序照抄
        // print.js:591-617 既有先例;String(d)/""+d/`${d}` 对 Date 全崩根因)。
        vm.mov(VReg.V0, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1); // 裸块指针
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
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_valueToStr_obj_tostr");
        // 用户自有 toString(function 属性)优先:String(o)/`${o}`/`""+o` 调用它。
        // S0 = 装箱对象。_object_user_tostr 返回其结果(装箱串)或 0(无自定义 toString)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_user_tostr");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_valueToStr_object_default");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32); // 有用户 toString → 直接返回
        vm.label("_valueToStr_object_default");
        vm.lea(VReg.A0, "_str_object");
        vm.jmp("_valueToStr_data_str_create_heap");

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
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_symbol_to_string"); // RET = boxed 堆串
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

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

        // _object_user_tostr(A0 = 装箱对象) -> RET:自有 function 型 toString 的调用结果
        // (装箱串),或 0(无自定义 toString,调用方用默认 "[object Object]")。
        // 调用约定镜像 _maybe_getter_closure:S0=闭包指针、A5=this、[闭包+8]=真函数指针。
        vm.label("_object_user_tostr");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S2, VReg.A0); // S2 = 装箱对象(this)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, "_str_key_toString");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0); // 装箱 "toString" 键
        vm.call("_object_get");           // RET = toString 值(miss→0/undef)
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);       // function tag
        vm.jne("_object_user_tostr_none");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V0); // S0 = 闭包指针(函数体入口约定)
        vm.load(VReg.V1, VReg.S0, 8);      // V1 = 真函数指针
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A5, VReg.S2);          // this = 对象
        vm.setCallArgcImm(0, VReg.V0, VReg.V2); // [argc ABI] toString()
        vm.callIndirect(VReg.V1);          // RET = 用户 toString 结果
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_object_user_tostr_none");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // _object_user_valueof(A0 = 装箱对象) -> RET:自有 function 型 valueOf 的调用结果,
        // 或 0(无)。ToNumber(obj) via _number_coerce 用。约定同 _object_user_tostr。
        vm.label("_object_user_valueof");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S2, VReg.A0);
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, "_str_key_valueOf");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_get");
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_object_user_valueof_none");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V0);
        vm.load(VReg.V1, VReg.S0, 8);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A5, VReg.S2);
        vm.setCallArgcImm(0, VReg.V0, VReg.V2); // [argc ABI] valueOf()
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_object_user_valueof_none");
        vm.movImm(VReg.RET, 0);
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
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_object_get");       // RET = 方法或 undef/0
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);   // function tag
        vm.jne("_ctp_none");
        // 调用 [Symbol.toPrimitive](hint):约定同 _object_user_tostr(S0=闭包、[+8]=真函数、A5=this)
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.S0, VReg.S1, VReg.V0);
        vm.load(VReg.V1, VReg.S0, 8);
        vm.mov(VReg.A0, VReg.S3);     // hint = arg0
        vm.mov(VReg.A5, VReg.S2);     // this = obj
        vm.setCallArgcImm(1, VReg.V0, VReg.V2); // [argc ABI] [Symbol.toPrimitive](hint)
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_ctp_none");
        vm.mov(VReg.RET, VReg.S2);    // 原样返回(无 Symbol.toPrimitive)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _js_toprimitive(A0 = 装箱对象 0x7FFD) -> RET:ToPrimitive(obj, default)。
        // Symbol.toPrimitive 优先(hint="default");否则 valueOf 优先、toString、"[object Object]"。二元 `+` 用。
        vm.label("_js_toprimitive");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        // [Symbol.toPrimitive] 优先(hint "default")
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("default"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_call_toprimitive");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);        // 仍是对象 → 无 toPrimitive,回退
        vm.jne("_js_toprim_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_user_valueof");   // A0 仍是对象
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_js_toprim_try_tostr");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);        // valueOf 结果又是对象?
        vm.jne("_js_toprim_done");         // 原始值 → 用
        vm.label("_js_toprim_try_tostr");
        // toString 步:委托 _valueToStr —— 覆盖 Error("name: message")、有用户 toString、
        // 数组、否则 "[object Object]"(此前仅 _object_user_tostr+默认,Error+"" 得 "[object Object]")。
        // 至此已确认无 Symbol.toPrimitive(前置 default 检查未命中),_valueToStr 内的 string
        // 检查冗余但无害。
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

    // 字符串转大写
    // _str_toUpperCase(str) -> 新字符串（带类型标记）
    generateToUpperCase() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_str_toUpperCase");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        this._emitThisStringCheck("toUpperCase");

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
        this._emitThisStringCheck("toLowerCase");

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
        this._emitThisStringCheck("charAt");

        vm.mov(VReg.S0, VReg.A0); // S0 = 原始字符串指针
        vm.mov(VReg.S1, VReg.A1); // S1 = index

        // 越界检查:index<0 或 >=length → 返回空字符串(charAt 语义;此前无检查 → 越界
        // 读堆邻居返垃圾字符,是 `"hi".charAt(5)`/`s[oob]` 返垃圾、动态串下标崩的共因)。
        // 注:.at()/自带界检的调用者只在界内调本函数,不受影响。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");        // RET = 长度
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_str_charAt_oob");
        vm.cmp(VReg.S1, VReg.RET);
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
    generateStrCodepointAt() {
        const vm = this.vm;
        vm.label("_str_codepoint_at");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // str
        vm.mov(VReg.S1, VReg.A1); // byteOff
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

        vm.label("_str_charCodeAt");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        this._emitThisStringCheck("charCodeAt");

        // 索引可能是 raw float64 位模式，先归一化为整数
        vm.push(VReg.A0);
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_syscall_arg");
        vm.mov(VReg.S0, VReg.RET); // S0 = index (int)
        vm.pop(VReg.A0);
        vm.mov(VReg.S1, VReg.A0);  // S1 = 字符串指针（跨 _strlen/_getStrContent 保留）

        // 边界检查：JS 里 charCodeAt(index) 当 index<0 或 index>=length 返回 NaN，不越界读。
        // **长度必须 O(1) 获取**：堆字符串([type@0=6,length@8,content@16])直接读 length@8；
        // 否则 _strlen O(n) 扫描 × 逐字符 charCodeAt → 解析源码 O(n²) 慢到自举跑不完。
        // 数据段常量串(无 TYPE_STRING 头)才回退 _strlen（短，无妨）。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1);      // V0 = 脱壳指针
        vm.loadByte(VReg.V1, VReg.V0, 0);       // type 字节
        vm.cmpImm(VReg.V1, 6);                  // TYPE_STRING
        vm.jne("_str_charCodeAt_datalen");
        vm.load(VReg.RET, VReg.V0, 8);          // 堆串 length@8 (O(1))
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
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // 越界：返回 0（有效 number，high16=0 不与 tag 冲突）。JS 本应返回 NaN，但本体系
        // NaN 的 high16>=0x7FF8 与标签区冲突、无法当普通 number 表示。编译器实际调用点
        // （lexer isLetter/isDigit/isHexDigit 用 code>127 / code>=97 等范围比较，对 0 全 false，
        // 与 NaN 同效果；isBareModuleName 的循环 i<s.length 有界不越界）→ 返 0 正确且不崩。
        vm.label("_str_charCodeAt_oob");
        // 越界 charCodeAt 返 NaN(非 0)。用非别名 NaN 位 0x7FF0…01(勿用 canonical 0x7FF8——
        // 与装箱 int0 同构会打印成 0,见 nan-int0)。编译器 lexer 恒界内故不触此路。
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1], 0);
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
        vm.jeq("_sas_pass");
        vm.cmpImm(VReg.V1, 0x7ffc);
        vm.jeq("_sas_pass");
        vm.cmpImm(VReg.V1, 0x7fff);
        vm.jeq("_sas_pass");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0], 0);
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
        this._emitThisStringCheck("trim");

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
        this._emitThisStringCheck("trimStart");

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
        this._emitThisStringCheck("trimEnd");

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

        vm.label("_str_slice");
        // S0=str, S1=start, S2=end/result, S3=len, S4=newLen, S5=index
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        this._emitThisStringCheck("slice");

        vm.mov(VReg.S0, VReg.A0); // S0 = str (Original JSValue)
        vm.mov(VReg.S1, VReg.A1); // S1 = start (JSValue)
        vm.mov(VReg.S2, VReg.A2); // S2 = end (JSValue)

        // 1. 获取解箱后的内容指针和长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = raw string pointer

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S3, VReg.RET); // S3 = len

        // 2. 规范化索引 (S1=start, S2=end)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_to_int32");
        vm.mov(VReg.S1, VReg.RET);

        // end = (end === undefined) ? len : ToInt32(end)
        vm.movImm64(VReg.V0, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.cmp(VReg.S2, VReg.V0);
        const endIsLen = "_slice_end_is_len_final";
        const calcStart = "_slice_calc_start_final";
        vm.jeq(endIsLen);
        
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_to_int32");
        vm.mov(VReg.S2, VReg.RET);

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

    // _str_substring(str, start, end) -> 新字符串
    generateSubstring() {
        const vm = this.vm;
        const TYPE_STRING = 6;

        vm.label("_str_substring");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        this._emitThisStringCheck("substring");

        vm.mov(VReg.S0, VReg.A0); // str

        // 获取内容指针
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET); // S0 = raw content

        // 获取字符串长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S3, VReg.RET); // S3 = len

        // 规范化参数
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_to_int32");
        vm.mov(VReg.S1, VReg.RET); // S1 = start

        vm.movImm64(VReg.V0, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.cmp(VReg.A2, VReg.V0);
        vm.jeq("_substring_end_is_len");
        
        vm.mov(VReg.A0, VReg.A2);
        vm.call("_to_int32");
        vm.mov(VReg.S2, VReg.RET); // S2 = end
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
        this._emitThisStringCheck("substr");

        vm.mov(VReg.S0, VReg.A0); // str (装箱)
        vm.mov(VReg.S1, VReg.A1); // start (boxed)
        vm.mov(VReg.S2, VReg.A2); // length (boxed 或 JS_UNDEFINED)

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
            vm.call("_str_slice");
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
        vm.call("_str_slice");
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

        vm.label("_str_replace");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]); // SP:0=left,8=right
        vm.mov(VReg.S0, VReg.A0); // str
        vm.mov(VReg.S1, VReg.A1); // search
        vm.mov(VReg.S2, VReg.A2); // repl
        // [W-25] repl ToString(函数替换器由 _str_argstr 直通,仍交上游 _str_replace_fn):
        // "undefined".replace("e", undefined) 须得 "undundefinedfined"。
        this._emitArgStrInline(VReg.S2, "_replace_repl");
        // search 也必须在此归一:下方 searchLen 走 _getStrContent,而 _str_indexOf 内部
        // 已自带 ToString——两处不一致会算出错位的 searchLen 并切错串。
        this._emitArgStrInline(VReg.S1, "_replace_search");

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
        vm.call("_str_slice");
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
        vm.call("_str_slice");
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
        // 调 fn(matched=search)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S2, VReg.V1); // V0 = 闭包指针
        vm.load(VReg.V1, VReg.V0, 8);      // 真函数指针
        vm.mov(VReg.A0, VReg.S1);          // matched
        vm.movImm64(VReg.A5, 0x7ffb000000000000n); // this = undefined
        vm.mov(VReg.S0, VReg.V0);          // S0 = 闭包指针(函数体入口约定)
        vm.setCallArgcImm(1, VReg.V2, VReg.V3); // [argc ABI] fn(matched)
        vm.callIndirect(VReg.V1);          // RET = 替换串(装箱)
        vm.mov(VReg.S2, VReg.RET);         // S2 = repl(fn 不再用)
        vm.load(VReg.S0, VReg.SP, 0);      // 重载 str
        // left = slice(str, 0, idx)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, 0x7FF8000000000000n);
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A2, VReg.S3, VReg.V0); vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_str_slice");
        // acc = left + repl
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_strconcat"); vm.mov(VReg.S2, VReg.RET);
        // right = slice(str, idx+searchLen, len)
        vm.add(VReg.S3, VReg.S3, VReg.S5);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A1, VReg.S3, VReg.V0); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.and(VReg.A2, VReg.S4, VReg.V0); vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_str_slice");
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

        vm.label("_str_replaceAll");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]); // SP+0=hasDollar
        vm.mov(VReg.S0, VReg.A0); // remaining（初值 = str）
        vm.mov(VReg.S1, VReg.A1); // search
        vm.mov(VReg.S2, VReg.A2); // repl
        this._emitArgStrInline(VReg.S2, "_replaceAll_repl");   // [W-25] repl ToString
        this._emitArgStrInline(VReg.S1, "_replaceAll_search"); // [W-25] search 同上(与 indexOf 一致)

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

        // 关键:_strconcat 只保存 S0-S4(不保存 S5=idx),故必须在两次 concat 之前
        // 就用 idx 把两段 slice 都算完;left 暂存栈上跨过后续调用。
        // left = slice(remaining, 0, idx)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, 0x7FF8000000000000n); // box 0
        vm.movImm64(VReg.V0, 0xFFFFFFFFn);
        vm.movImm64(VReg.V1, 0x7FF8000000000000n);
        vm.and(VReg.A2, VReg.S5, VReg.V0);
        vm.or(VReg.A2, VReg.A2, VReg.V1); // box idx
        vm.call("_str_slice");
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
        vm.call("_str_slice");
        vm.mov(VReg.S0, VReg.RET); // remaining = 后缀（idx 已用完,concat 可放心clobber S5）

        // acc = acc + left（left 从栈弹回）
        vm.mov(VReg.A0, VReg.S3);
        vm.pop(VReg.A1); // left（弹出后 SP 归位,SP+0 = hasDollar）
        vm.call("_strconcat");
        vm.mov(VReg.S3, VReg.RET);
        // acc += repl(含 $ 则展开):matched=search(S1)、post=remaining(S0)、pre≈acc(S3,尽力)
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_replaceAll_plainrepl");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S3);
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
    }

    // _num_toString(value, radix_raw) -> 装箱字符串
    // value: 装箱 int32 或裸 float64(经 _to_int32 取整);radix: 裸 int(2..36,非法回退 10)。
    // 小数部分不输出(JS 会输出基数小数,暂不支持)。倒序填 scratch 缓冲后
    // 经 _cstr_to_heap_str 建串——避免手写串头(见 runtime-helper 契约教训)。
    generateNumToString() {
        const vm = this.vm;

        vm.label("_num_toString");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S1, VReg.A1); // radix(入口捕获,后续调用会冲 A1)
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
        vm.movImm(VReg.S0, 0);
        vm.label("_numts_conv_done"); // S0 = int 值(64 位)

        // radix 钳位:<2 或 >36 → 10
        vm.cmpImm(VReg.S1, 2);
        vm.jlt("_numts_radix_dft");
        vm.cmpImm(VReg.S1, 36);
        vm.jle("_numts_radix_ok");
        vm.label("_numts_radix_dft");
        vm.movImm(VReg.S1, 10);
        vm.label("_numts_radix_ok");

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

        vm.label("_str_split");
        vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        this._emitThisStringCheck("split");

        // S0 = 装箱 str, S1 = 装箱 sep, S2 = str content 指针, S3 = 结果数组(装箱),
        // S4 = 段起点 i(绝对下标), S5 = sep 长度。
        // 多字符分隔符复用 _str_indexOf(已支持多字符+fromIndex),逐段定位切分——
        // 旧实现只比对 sep 首字节,"a\r\nb".split("\r\n") 误按 "\r" 切。
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);

        // 结果数组(空,动态 push)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S3, VReg.RET); // 装箱数组

        // [W-25] separator === undefined → 整串作单元素返回(ES 21.1.3.23 step 8)。
        // 必须在 ToString 之前判:此前 undefined 被 _getStrContent 判非法 → 空串 →
        // 落逐字符路径("abc".split(undefined) 得 ["a","b","c"],test262 separator-undef)。
        // 注:无参 split() 由 dispatch 传 _str_empty(裸指针),与 split("") 不可区分,
        // 仍走逐字符——那是 dispatch 侧的信息丢失,运行时无从恢复。
        vm.movImm64(VReg.V1, 0x7ffb000000000000n);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_split_undef_sep");
        // 其余非串 separator 走 ToString(split(null) → "null"、split(1) → "1")
        this._emitArgStrInline(VReg.S1, "_split_sep");

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
        // 命中:push substring(content, i, idx),下一段起点 i = idx + seplen。
        // 先把 idx 取入 A2(substring 的 end),再算 idx+seplen 暂存栈(跨调用)。
        vm.mov(VReg.A2, VReg.RET);          // end = idx
        vm.add(VReg.V0, VReg.RET, VReg.S5); // 下一 i = idx + seplen
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
        // 装箱为 JSValue 数组（0x7FFE）——_array_new_with_size 返回裸指针，
        // 下游 .join()/typeof 等按 boxed 数组处理，未装箱会崩。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        // [W-25] separator === undefined:[整串]
        vm.label("_split_undef_sep");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0); // 原装箱串直接入数组
        vm.call("_array_push");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        vm.label("_split_empty_sep");
        // 空分隔符：每字符一个元素。S1(装箱 sep 不再需要)复用为 str 长度。
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.S4, 0);
        vm.label("_split_empty_loop");
        vm.cmp(VReg.S4, VReg.S1);
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
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S3, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
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
        this._emitThisStringCheck("indexOf");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2); // S4 = fromIndex(入口即捕获,后续调用会冲 A2)

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
        vm.label("_str_includes");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        this._emitThisStringCheck("includes");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
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
        this._emitThisStringCheck("startsWith");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
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
        this._emitThisStringCheck("endsWith");
        vm.mov(VReg.S0, VReg.A0); vm.mov(VReg.S1, VReg.A1);
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
        this._emitArgStrInline(VReg.S1, "_lastIndexOf_search"); // [W-25]
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent"); vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_getStrContent"); vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.call("_strlen"); vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1); vm.call("_strlen"); vm.mov(VReg.S3, VReg.RET);
        vm.cmp(VReg.S3, VReg.S2); vm.ja("_lastIndexOf_notFound");
        vm.sub(VReg.S4, VReg.S2, VReg.S3); // Start index (S4) = strlen - searchlen
        // fromIndex 钳位:负 → 0;再 S4 = min(S4, fromIndex)(从 <=fromIndex 处向前搜)。
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 0); vm.jge("_lastIndexOf_fi_pos");
        vm.movImm(VReg.V0, 0);
        vm.label("_lastIndexOf_fi_pos");
        vm.cmp(VReg.V0, VReg.S4); vm.jge("_lastIndexOf_fi_keep");
        vm.mov(VReg.S4, VReg.V0);
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

    // _str_repeat(str, count) -> str
    generateRepeat() {
        const vm = this.vm;
        vm.label("_str_repeat");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        this._emitThisStringCheck("repeat");
        vm.mov(VReg.S0, VReg.A0); vm.mov(VReg.S1, VReg.A1);
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
        this._emitThisStringCheck("at");
        vm.mov(VReg.S0, VReg.A0); vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S1); vm.call("_to_int32"); vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.call("_strlen"); vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S1, 0); vm.jge("_at_check"); vm.add(VReg.S1, VReg.S1, VReg.S2);
        vm.label("_at_check");
        vm.cmpImm(VReg.S1, 0); vm.jlt("_at_undef"); vm.cmp(VReg.S1, VReg.S2); vm.jge("_at_undef");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.call("_str_charAt");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_at_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // _str_concat(str1, str2) -> str
    generateConcat() {
        const vm = this.vm;
        vm.label("_str_concat");
        // this-check: A0 must be装箱字符串(0x7FFC)或裸指针(高16位=0)
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_concat_this_ok");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_concat_this_ok");
        vm.lea(VReg.A0, vm.asm.addString("String.prototype method called on non-string value"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_concat_this_ok");
        vm.jmp("_strconcat");
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
        vm.jeq("_tsw_ret_primitive");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_tsw_extract");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tsw_ret_primitive");
        // TypeError for non-string/non-wrapper values (e.g., String.prototype.toString.call(5))
        vm.lea(VReg.A0, vm.asm.addString("String.prototype method called on non-string value"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        // 0x7FFD: extract __value property from wrapper object
        vm.label("_tsw_extract");
        vm.mov(VReg.V0, VReg.A0);         // V0 = boxed wrapper object
        vm.mov(VReg.A0, VReg.V0);         // A0 = boxed obj (first arg to _object_get)
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.call("_tag_key_a1");            // A1 = boxed "__value" key
        vm.call("_object_get");            // RET = primitive string (0x7FFC)
        vm.label("_tsw_ret_primitive");
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
        vm.jeq("_vo_ret_primitive");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_vo_extract");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_vo_ret_primitive");
        vm.lea(VReg.A0, vm.asm.addString("String.prototype method called on non-string value"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_vo_extract");
        vm.mov(VReg.V0, VReg.A0);
        vm.mov(VReg.A0, VReg.V0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.call("_tag_key_a1");            // A1 = boxed "__value" key
        vm.call("_object_get");
        vm.label("_vo_ret_primitive");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 生成所有字符串函数
    generate() {
        this.generateStrlen();
        this.generateStrLength(); // 统一 length 访问
        this.generateStrcmp();
        this.generateLocaleCompare();
        this.generateStrcpy();
        this.generateStrcat();
        this.generateGetStrContent();
        this.generateStrconcat();
        this.generateStrConcatIP(); // [L4.1] 原地拼接助手(编译器逃逸门控专用;守卫不满足尾委托 _strconcat)
        this.generateCstrToHeapStr();
        this.generateCharToStr();
        this.generatePadEnd();
        this.generatePadStart();
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
        this.generateToUpperCase();
        this.generateToLowerCase();
        this.generateCharAt();
        this.generateStrCpBytes();
        this.generateStrCodepointAt();
        this.generateStrIndexChar();
        this.generateCharCodeAt();
        this.generateWsLen();      // [W-25] 空白判定(完整 WhiteSpace ∪ LineTerminator)
        this.generateWsLenBack();  // [W-25] 同上,尾部扫描方向
        this.generateArgStr();     // [W-25] 字符串实参 ToString 归一
        this.generateTrim();
        this.generateTrimStart();
        this.generateTrimEnd();
        this.generateSubstr();
        this.generateSubstring(); // _str_substring(str.substring 语义:负→0、swap);此前死代码未接
        this.generateReplaceExpand();
        this.generateReplace();
        this.generateReplaceAll();
        this.generateNumToString();
        this.generateNumToFixed();
        this.generateSlice();
        this.generateIndexOf();
        // StringMethodsGenerator methods (includes, startsWith, endsWith, etc.)
        this.generateIncludes();
        this.generateStartsWith();
        this.generateEndsWith();
        this.generateLastIndexOf();
        this.generateRepeat();
        this.generateAt();
        this.generateConcat();
        this.generateSplit();
        this.generateSubstringRaw();
        // String.prototype wrapper methods (toString/valueOf for new String() objects)
        this.generateToStringWrapper();
        this.generateValueOf();
        // 基础操作 (Moved from base.js)
        this.generateRawStrlen();
        this.generateStrLength();
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
}
