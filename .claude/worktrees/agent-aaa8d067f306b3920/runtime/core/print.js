// asm.js 打印运行时
// 提供输出函数

import { VReg } from "../../vm/registers.js";
import { TYPE_STRING, TYPE_ARRAY, TYPE_OBJECT, TYPE_CLOSURE, TYPE_DATE, TYPE_PROMISE, TYPE_INT8, TYPE_FLOAT64, TYPE_SYMBOL, HEADER_SIZE } from "./allocator.js";
import { TYPE_INT8_ARRAY, TYPE_FLOAT64_ARRAY, TYPE_ARRAY_BUFFER } from "./types.js";

export class PrintGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    // 辅助：调用 write 系统调用或 Windows API
    // A0=fd/unused, A1=buf, A2=len
    emitWriteCall() {
        const vm = this.vm;
        const platform = vm.platform;
        const arch = vm.arch;

        if (platform === "windows") {
            // Windows: 使用 WriteConsoleA
            // 需要先 GetStdHandle(-11) 获取 stdout
            // 参数已在 A1=buf, A2=len
            vm.callWindowsWriteConsole();
        } else if (platform === "wasi") {
            vm.syscall(1); // wasi 号名空间 = linux-x64,宿主 shim 落 write
        } else if (arch === "arm64") {
            vm.syscall(platform === "linux" ? 64 : 4);
        } else {
            vm.syscall(platform === "linux" ? 1 : 0x2000004);
        }
    }

    // 打印字符串（无换行版本，供内部使用）
    generatePrintStringNoNL() {
        const vm = this.vm;

        vm.label("_print_str_no_nl");
        vm.prologue(16, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // str pointer

        // 先计算长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // length

        // write(1, str, len)
        vm.movImm(VReg.A0, 1); // stdout
        vm.mov(VReg.A1, VReg.S0); // str
        vm.mov(VReg.A2, VReg.S1); // len

        this.emitWriteCall();

        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // 打印字符串（带换行）
    generatePrintString() {
        const vm = this.vm;

        vm.label("_print_str");
        vm.prologue(16, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // str pointer

        // 先计算长度
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S1, VReg.RET); // length

        // write(1, str, len)
        vm.movImm(VReg.A0, 1); // stdout
        vm.mov(VReg.A1, VReg.S0); // str
        vm.mov(VReg.A2, VReg.S1); // len

        this.emitWriteCall();

        // 打印换行
        vm.movImm(VReg.V0, 10); // '\n'
        vm.push(VReg.V0);
        vm.movImm(VReg.A0, 1);
        vm.mov(VReg.A1, VReg.SP);
        vm.movImm(VReg.A2, 1);

        this.emitWriteCall();

        vm.pop(VReg.V0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // 打印单个字符
    generatePrintChar() {
        const vm = this.vm;

        vm.label("_print_char");
        vm.prologue(16, [VReg.S0]);

        vm.mov(VReg.S0, VReg.A0); // char code

        // 写入到栈上作为临时缓冲区
        vm.push(VReg.S0);
        
        // 调用 write(1, sp, 1)
        vm.movImm(VReg.A0, 1); // fd = stdout
        vm.mov(VReg.A1, VReg.SP);
        vm.movImm(VReg.A2, 1); // len = 1
        this.emitWriteCall();

        vm.pop(VReg.V0);
        vm.epilogue([VReg.S0], 16);
    }

    // 打印换行
    generatePrintNewline() {
        const vm = this.vm;

        vm.label("_print_nl");
        vm.prologue(16, []);

        vm.movImm(VReg.V0, 10); // '\n'
        vm.push(VReg.V0);
        vm.movImm(VReg.A0, 1);
        vm.mov(VReg.A1, VReg.SP);
        vm.movImm(VReg.A2, 1);

        this.emitWriteCall();

        vm.pop(VReg.V0);
        vm.epilogue([], 16);
    }

    // 打印布尔值 (true/false)
    generatePrintBool() {
        const vm = this.vm;

        vm.label("_print_bool");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        // 检查是否为 _js_false (0x7ff9000000000000)，而不是数值 0
        // _js_false 不是 0，而是一个 NaN-boxed 的布尔值
        // 需要加载 _js_false 的内容 (0x7ff9000000000000)，而不是地址
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.V0, VReg.V0, 0);  // 加载实际的 _js_false 值
        vm.cmp(VReg.S0, VReg.V0);
        const falseLabel = "_print_bool_false";
        vm.jeq(falseLabel);

        // 打印 "true"
        vm.lea(VReg.A0, "_str_true");
        vm.call("_print_str");
        vm.epilogue([VReg.S0], 16);

        vm.label(falseLabel);
        // 打印 "false"
        vm.lea(VReg.A0, "_str_false");
        vm.call("_print_str");
        vm.epilogue([VReg.S0], 16);
    }

    // 打印布尔值（无换行版本）
    generatePrintBoolNoNL() {
        const vm = this.vm;

        vm.label("_print_bool_no_nl");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        // 检查是否为 _js_false (0x7ff9000000000000)，而不是数值 0
        // _js_false 不是 0，而是一个 NaN-boxed 的布尔值
        // 需要加载 _js_false 的内容 (0x7ff9000000000000)，而不是地址
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.V0, VReg.V0, 0);  // 加载实际的 _js_false 值
        vm.cmp(VReg.S0, VReg.V0);
        const falseLabel = "_print_bool_no_nl_false";
        vm.jeq(falseLabel);

        // 打印 "true"
        vm.lea(VReg.A0, "_str_true");
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0], 16);

        vm.label(falseLabel);
        // 打印 "false"
        vm.lea(VReg.A0, "_str_false");
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0], 16);
    }

    // 打印空格
    generatePrintSpace() {
        const vm = this.vm;

        vm.label("_print_space");
        vm.prologue(16, []);

        // 打印空格字符
        vm.movImm(VReg.V0, 32); // ' '
        vm.push(VReg.V0);
        vm.movImm(VReg.A0, 1);
        vm.mov(VReg.A1, VReg.SP);
        vm.movImm(VReg.A2, 1);
        this.emitWriteCall();
        vm.pop(VReg.V0);

        vm.epilogue([], 16);
    }

    // print 函数的包装器（可作为一等公民传递）
    generatePrintWrapper() {
        const vm = this.vm;

        vm.label("_print_wrapper");
        vm.prologue(16, [VReg.S0]);
        // A0 已经是要打印的值
        vm.call("_print_value");
        vm.movImm(VReg.RET, 0); // 返回 undefined
        vm.epilogue([VReg.S0], 16);
    }

    // 统一的值打印函数
    // 支持 NaN-boxing 格式的值打印
    //
    // NaN-boxing 编码:
    //   - 纯 double: 直接是 IEEE 754 浮点数（不是特殊 NaN 模式）
    //   - Tagged value: 高 16 位是 0x7FF8-0x7FFF (tag 0-7)
    //   - Tag 0: int32, Tag 1: bool, Tag 2: null, Tag 3: undefined
    //   - Tag 4: string, Tag 5: object, Tag 6: array, Tag 7: function
    generatePrintValue() {
        const vm = this.vm;

        vm.label("_print_value");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // 保存值

        const doneLabel = "_print_value_done";

        // 负零特判:-0.0 位型恒为 0x8000000000000000(唯一,int 0 是 0x7ff8...、+0.0 全零)。
        // console.log/inspect 下 node 打印 "-0";String/toString/模板/JSON 走 _valueToStr → "0"
        // 不受影响(此路径仅 console 输出)。放最前避免落入 _print_float(输出 "0")。
        vm.movImm(VReg.V1, 1);
        vm.shlImm(VReg.V1, VReg.V1, 63);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jne("_print_value_not_negzero");
        vm.lea(VReg.A0, "_str_negzero");
        vm.call("_print_str");
        vm.jmp(doneLabel);
        vm.label("_print_value_not_negzero");

        // ============ 首先检查是否是堆对象（需要在 NaN-boxed 检查之前）============
        // 堆对象的地址通常在 _heap_base 到 _heap_ptr 范围内
        // 如果不先检查，堆对象会被错误地当作原始浮点数处理
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_value_check_zero_or_nan"); // S0 < heap_base，跳转
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_print_value_check_zero_or_nan"); // S0 >= heap_ptr，跳转

        // 额外检查：如果指针在代码/数据段范围内（< 0x100200000），不是堆对象
        vm.movImm(VReg.V1, vm.platform === "wasi" ? 0x8000000 : 0x100200000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_value_check_zero_or_nan"); // S0 < 0x100200000，不是堆对象

        // 是堆对象：S0 是 user_ptr (block + 16)，需要减去 16 得到 block 指针
        vm.subImm(VReg.S0, VReg.S0, 16);

        // 检查类型
        vm.load(VReg.V2, VReg.S0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);

        vm.cmpImm(VReg.V2, TYPE_ARRAY);
        vm.jeq("_print_value_heap_array");
        vm.cmpImm(VReg.V2, TYPE_OBJECT);
        vm.jeq("_print_value_heap_object");
        vm.cmpImm(VReg.V2, TYPE_CLOSURE);
        vm.jeq("_print_value_heap_function");
        vm.cmpImm(VReg.V2, TYPE_STRING);
        vm.jeq("_print_value_heap_string");
        // BigInt 必须先于下方 [S0+16] 基的 Symbol/Map/Set 判别：bigint 值存于 user+0
        // =[S0+16]，值恰为 4/5(TYPE_MAP/SET)或 61(TYPE_SYMBOL)时会被误判成容器打印
        // （5n^1n=4→"Map(0){}"）。头字节 V2==14 可靠,提前拦截。
        vm.cmpImm(VReg.V2, 14); // TYPE_BIGINT
        vm.jeq("_print_value_heap_bigint");
        // Symbol：类型标记在用户区 +0（S0 此处是 block → 偏移 16）。
        // 置于 TYPE_STRING 之后：堆串 payload 是 content 指针，其 [block+16]
        // 是内容首字，先按 6 匹配掉，"="(0x3D) 开头内容不会误入 symbol 分支。
        vm.load(VReg.V1, VReg.S0, 16);
        vm.cmpImm(VReg.V1, TYPE_SYMBOL);
        vm.jeq("_print_value_heap_symbol");
        // Map/Set:未装箱堆指针,类型在 user+0 = [S0+16](S0=block,同 Symbol 判位)。
        // 前面 [S0+0] 已匹配掉 array/object/string;此处 user_ptr = S0+16。
        vm.load(VReg.V1, VReg.S0, 16);
        vm.cmpImm(VReg.V1, 4); // TYPE_MAP
        vm.jeq("_print_value_map_ub");
        vm.load(VReg.V1, VReg.S0, 16);
        vm.cmpImm(VReg.V1, 5); // TYPE_SET
        vm.jeq("_print_value_set_ub");
        // TypedArray(裸块指针,类型字节在 user+0=[S0+16];[S0+0] 是前一分配尾部不可信)
        // → _print_typedarray "Uint8Array(3) [1, 2, 3]"。此前无 case,落默认对象 → "[object Object]"。
        vm.load(VReg.V1, VReg.S0, 16);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 0x40);
        vm.jlt("_print_value_ta_skip");
        vm.cmpImm(VReg.V1, 0x61);
        vm.jgt("_print_value_ta_skip");
        vm.addImm(VReg.A0, VReg.S0, 16); // ta 指针(type@0)
        vm.call("_print_typedarray");
        vm.call("_print_nl"); // NL 版:元素后补换行
        vm.jmp(doneLabel);
        vm.label("_print_value_ta_skip");
        vm.cmpImm(VReg.V2, TYPE_DATE);
        vm.jeq("_print_value_heap_date");
        // 检查 Number 对象 (TYPE_NUMBER = 13 或 TYPE_FLOAT64 = 29)
        vm.cmpImm(VReg.V2, 13); // TYPE_NUMBER
        vm.jeq("_print_value_heap_number_int");
        vm.cmpImm(VReg.V2, TYPE_FLOAT64);
        vm.jeq("_print_value_heap_number");
        vm.cmpImm(VReg.V2, 14); // TYPE_BIGINT
        vm.jeq("_print_value_heap_bigint");
        // 默认当作对象
        vm.jmp("_print_value_heap_object");

        vm.label("_print_value_heap_number_int");
        vm.load(VReg.A0, VReg.S0, 8); // 加载 raw int64
        vm.call("_print_int");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_number");
        vm.load(VReg.A0, VReg.S0, 8); // 加载 IEEE 754 值
        vm.call("_print_float");
        vm.jmp(doneLabel);

        // BigInt: console.log(10n) → "10n"（对齐 node，带 n 后缀；String/模板不带）。
        // S0 此处是 block 指针（顶部已 -16），64 位值在用户区 +0 = block+16。
        vm.label("_print_value_heap_bigint");
        vm.load(VReg.A0, VReg.S0, 16);
        vm.call("_print_int_no_nl");
        vm.lea(VReg.A0, this.vm.asm.addString("n"));
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_array_ptr");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_array");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_object");
        vm.label("_print_value_heap_object_ptr");
        vm.lea(VReg.A0, "_str_object");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_function");
        vm.lea(VReg.A0, "_str_function");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_string");
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_date");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_date_toISOString");
        // [修真] _date_toISOString 现返回**装箱串**(content|0x7ffc),旧注"直接打印"已过时:
        // _print_str 需裸 char*,直接传装箱值把 0x7ffc… 当地址读 → 空/垃圾。先 _getStrContent 脱壳。
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // Symbol: "Symbol(" + desc + ")" + 换行（S0 = block）
        vm.label("_print_value_heap_symbol");
        vm.lea(VReg.A0, "_str_symbol_open");
        vm.call("_print_str_no_nl");
        vm.load(VReg.A0, VReg.S0, 24); // desc 裸指针（block+16+8；0/垃圾 → 空串）
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");
        vm.lea(VReg.A0, "_str_rparen");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // ============ 检查是否为 0 或处理 NaN-boxed 值 ============
        vm.label("_print_value_check_zero_or_nan");
        vm.cmpImm(VReg.S0, 0);
        vm.jne("_print_value_check_data_str");
        vm.movImm(VReg.A0, 0);
        vm.call("_print_int");
        vm.jmp(doneLabel);

        // 检查是否在数据段范围内（静态字符串向后兼容）
        vm.label("_print_value_check_data_str");
        // 数据段地址范围: _data_start 到 _data_start + 0x100000
        // 如果地址在这个范围内，才认为是数据段字符串
        vm.lea(VReg.V1, "_data_start");
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_value_check_nanboxed");
        vm.lea(VReg.V1, "_data_start");
        vm.addImm(VReg.V1, VReg.V1, 0x100000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_print_value_check_nanboxed");

        // 检查第一个字节是否是可打印字符（ASCII 32-126）或 null（空字符串）
        vm.loadByte(VReg.V1, VReg.S0, 0);
        // \0 (0) 是空字符串的有效首字节（null 终止符）
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_print_value_check_data_str_valid"); // 如果是 \0，跳过 printable 检查
        vm.cmpImm(VReg.V1, 32);
        vm.jlt("_print_value_check_nanboxed");
        vm.cmpImm(VReg.V1, 127);
        vm.jge("_print_value_check_nanboxed");
        vm.label("_print_value_check_data_str_valid");

        // 是数据段字符串
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // ============ 检查是否是 NaN-boxed 值 ============
        vm.label("_print_value_check_nanboxed");
        const notNanBoxedLabel = "_print_value_not_nanboxed";
        const nanBoxedCheckLabel = "_print_value_check_nan_exponent";
        // NaN-boxed 值: 高 16 位必须在 [0x7FF8, 0x7FFF] 范围内 (unsigned)
        vm.mov(VReg.V0, VReg.S0);
        vm.shrImm(VReg.V0, VReg.V0, 48); // 右移 48 位得到高 16 位
        vm.movImm(VReg.V1, 0x7ff8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jb(notNanBoxedLabel); // < 0x7FF8 (unsigned)，不是 NaN-boxed
        vm.movImm(VReg.V1, 0x7fff);
        vm.cmp(VReg.V0, VReg.V1);
        vm.ja(notNanBoxedLabel); // > 0x7FFF (unsigned)，不是 NaN-boxed

        // 到这里，高 16 位在 [0x7FF8, 0x7FFF] 范围内，确定是我们的 NaN-boxed 值
        // 提取 tag 并分发
        vm.mov(VReg.V0, VReg.S0);
        vm.shrImm(VReg.V0, VReg.V0, 48);
        vm.andImm(VReg.V0, VReg.V0, 0x7); // 取低 3 位 = tag
        vm.mov(VReg.S1, VReg.V0); // S1 = tag
        vm.jmp("_print_value_dispatch");

        // 如果是 raw float，在这个 label 之后处理
        vm.label(notNanBoxedLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_float");
        vm.jmp(doneLabel);

        vm.label("_print_value_dispatch");

        // ============ 核心检测逻辑 ============
        // 0x7ff8000000000000 is also the NaN-boxed int32 zero value.
        // Prefer tag dispatch here so bitwise results like (2 & 1) print 0.
        // 高 16 位在 [0x7FF8, 0x7FFF] 范围内是 NaN-boxed
        vm.mov(VReg.V0, VReg.S0);
        vm.shrImm(VReg.V0, VReg.V0, 48); // 右移 48 位得到高 16 位
        vm.subImm(VReg.V1, VReg.V0, 0x7ff8);
        vm.cmpImm(VReg.V1, 8);
        vm.jge(notNanBoxedLabel); // 不在 [0-7] 范围内，说明是原始 double (包括负 double)

        // 是 NaN-boxed 值，V1 现在就是 tag (0-7)
        vm.mov(VReg.S1, VReg.V1); // S1 = tag

        // ============ 是 NaN-boxed 值，提取 tag ============
        // tag 在 bits 48-50 (3 bits)
        vm.mov(VReg.V0, VReg.S0);
        vm.shrImm(VReg.V0, VReg.V0, 48); // 右移 48 位
        vm.andImm(VReg.V0, VReg.V0, 0x7); // 取低 3 位 = tag
        vm.mov(VReg.S1, VReg.V0); // S1 = tag

        // 根据 tag 分发

        // 根据 tag 分发
        // tag 0: int32
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_print_value_int32");

        // tag 1: boolean
        vm.cmpImm(VReg.S1, 1);
        vm.jeq("_print_value_bool");

        // tag 2: null
        vm.cmpImm(VReg.S1, 2);
        vm.jeq("_print_value_null");

        // tag 3: undefined
        vm.cmpImm(VReg.S1, 3);
        vm.jeq("_print_value_undefined");

        // tag 4: string (pointer)
        vm.cmpImm(VReg.S1, 4);
        vm.jeq("_print_value_string_ptr");

        // tag 5: object (pointer)
        vm.cmpImm(VReg.S1, 5);
        vm.jeq("_print_value_object_ptr");

        // tag 6: array (pointer)
        vm.cmpImm(VReg.S1, 6);
        vm.jeq("_print_value_array_ptr");

        // tag 7: function (pointer)
        vm.cmpImm(VReg.S1, 7);
        vm.jeq("_print_value_function_ptr");

        // 未知 tag，打印 [unknown]
        vm.lea(VReg.A0, "_str_unknown");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // ============ Tag 处理分支 ============

        // int32: payload 是 32 位整数
        vm.label("_print_value_int32");
        // 提取低 32 位作为有符号整数
        vm.mov(VReg.A0, VReg.S0);
        // 对于 32 位整数，符号扩展低 32 位
        vm.shl(VReg.A0, VReg.A0, 32);
        vm.sarImm(VReg.A0, VReg.A0, 32); // 算术右移恢复符号
        vm.call("_print_int");
        vm.jmp(doneLabel);

        // boolean: payload 0=false, 1=true
        vm.label("_print_value_bool");
        vm.andImm(VReg.V0, VReg.S0, 1); // 取最低位
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_print_value_false");
        vm.lea(VReg.A0, "_str_true");
        vm.call("_print_str");
        vm.jmp(doneLabel);
        vm.label("_print_value_false");
        vm.lea(VReg.A0, "_str_false");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // null
        vm.label("_print_value_null");
        vm.lea(VReg.A0, "_str_null");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // undefined
        vm.label("_print_value_undefined");
        vm.lea(VReg.A0, "_str_undefined");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // string pointer: 提取 48 位指针
        vm.label("_print_value_string_ptr");
        // payload 是 48 位指针（可能是堆内容指针或数据段指针）
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1); // 提取低 48 位

        // 检查是否是堆字符串：读取 block 头的 type 字段
        // 注意：堆字符串的内容指针 = block + 16，所以 type 在 (A0 - 16) 处
        // 先检查是否在堆范围内
        vm.mov(VReg.V2, VReg.A0); // V2 = 原始指针
        vm.subImm(VReg.V2, VReg.V2, 16); // V2 = block ptr = A0 - 16
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_print_value_str_data_fallback"); // block < heap_base，不是堆对象
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jge("_print_value_str_data_fallback"); // block >= heap_ptr，不是堆对象

        // 在堆范围内，检查 type 字段是否为 TYPE_STRING
        vm.load(VReg.V1, VReg.V2, 0); // V1 = type field at block
        vm.andImm(VReg.V1, VReg.V1, 0xff); // 取低 8 位
        vm.cmpImm(VReg.V1, TYPE_STRING);
        vm.jne("_print_value_str_data_fallback"); // type != TYPE_STRING，不是堆字符串

        // 是堆字符串！A0 是内容指针（block + 16），直接使用
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // 数据段字符串或无效指针
        vm.label("_print_value_str_data_fallback");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // object pointer
        vm.label("_print_value_object_ptr");
        // 分派顺序关键:先 Date(避免下方 _is_asmjs_err 把 Date 当 Error 解引用崩),
        // 再 _is_asmjs_err(Error 族 → "name: message",Error 也是 TYPE_OBJECT,故必须先于
        // 属性打印器,否则打成 { name:.., __asmjs_err:.. }),再普通对象(TYPE_OBJECT → 属性
        // 打印器 "{ k: v }"),否则 → "[object Object]"。
        vm.mov(VReg.V0, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1); // user_ptr
        vm.loadByte(VReg.V2, VReg.V0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);
        vm.cmpImm(VReg.V2, TYPE_DATE);
        vm.jeq("_print_value_heap_date");
        // Map/Set(先于 _is_asmjs_err:它们非属性对象,err 检查/error_to_str 遍历会崩)。
        vm.cmpImm(VReg.V2, 4); // TYPE_MAP
        vm.jeq("_print_value_map");
        vm.cmpImm(VReg.V2, 5); // TYPE_SET
        vm.jeq("_print_value_set");
        // Promise(装箱 0x7FFD,类型字节 11):先于 _is_asmjs_err 短路——promise 非属性对象
        // (布局 [type,status@8,value@16,...]),_is_asmjs_err 遍历会解引用非法 → 段错误
        // (console.log(Promise.resolve(1)) 崩根因)。→ _print_promise "Promise { <state> }"。
        vm.cmpImm(VReg.V2, TYPE_PROMISE);
        vm.jeq("_print_value_promise");
        // [#36] Error 族对象 → "name: message"（console.log(err) 对齐 node）。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_asmjs_err");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_print_value_obj_err");
        // 非 Error:重读类型(_is_asmjs_err 毁 V0/V2),TYPE_OBJECT → 属性打印器,否则占位。
        vm.mov(VReg.V0, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        vm.loadByte(VReg.V2, VReg.V0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);
        vm.cmpImm(VReg.V2, TYPE_OBJECT);
        vm.jeq("_print_value_obj_props");
        vm.jmp("_print_value_object_ptr_plain");
        vm.label("_print_value_obj_err");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_error_to_str"); // RET = 装箱堆串
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent"); // 取裸内容指针供 _print_str
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str");
        vm.jmp(doneLabel);
        vm.label("_print_value_object_ptr_plain");
        // 打印 "[object Object]" 或调用 toString
        vm.lea(VReg.A0, "_str_object");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // 普通对象:属性打印器(无换行)+ 换行。V0 已是 user_ptr。
        vm.label("_print_value_obj_props");
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_print_object_no_nl");
        vm.call("_print_nl");
        vm.jmp(doneLabel);

        // Map/Set:user_ptr = S0 脱壳。打印器 + 换行。
        vm.label("_print_value_map");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_print_map_no_nl");
        vm.call("_print_nl");
        vm.jmp(doneLabel);
        vm.label("_print_value_set");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_print_set_no_nl");
        vm.call("_print_nl");
        vm.jmp(doneLabel);
        // Promise:脱壳 → 裸 promise 块(status@8),_print_promise 自带换行。
        vm.label("_print_value_promise");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_print_promise");
        vm.jmp(doneLabel);

        // 未装箱 Map/Set(第一堆分派):S0=block(user-16),user_ptr = S0+16。
        vm.label("_print_value_map_ub");
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_map_no_nl");
        vm.call("_print_nl");
        vm.jmp(doneLabel);
        vm.label("_print_value_set_ub");
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_set_no_nl");
        vm.call("_print_nl");
        vm.jmp(doneLabel);

        // array pointer
        vm.label("_print_value_array_ptr");
        vm.mov(VReg.A0, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1); // 提取低 48 位
        vm.call("_print_array");
        vm.jmp(doneLabel);

        // function pointer
        vm.label("_print_value_function_ptr");
        vm.lea(VReg.A0, "_str_function");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // ============ 非 NaN-boxed 值 ============
        vm.label(notNanBoxedLabel);
        // 可能是:
        // 1. 纯浮点数 (IEEE 754 double)
        // 2. 原始指针（向后兼容旧代码）
        // 3. 小整数

        // 检查是否为 0
        vm.cmpImm(VReg.S0, 0);
        vm.jne("_print_value_not_zero");
        vm.movImm(VReg.A0, 0);
        vm.call("_print_int");
        vm.jmp(doneLabel);

        vm.label("_print_value_not_zero");

        // 首先检查是否在堆范围内（堆对象有类型标记）
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_value_check_data_segment");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_print_value_check_data_segment");
        // 额外检查：如果是代码/数据段范围内的地址，不是堆对象
        vm.movImm(VReg.V1, vm.platform === "wasi" ? 0x8000000 : 0x100200000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_value_check_data_segment");
        // 是堆对象，检查类型
        vm.load(VReg.V2, VReg.S0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);

        vm.cmpImm(VReg.V2, TYPE_ARRAY);
        vm.jeq("_print_value_heap_array");
        vm.cmpImm(VReg.V2, TYPE_OBJECT);
        vm.jeq("_print_value_heap_object");
        vm.cmpImm(VReg.V2, TYPE_CLOSURE);
        vm.jeq("_print_value_heap_function");
        vm.cmpImm(VReg.V2, TYPE_STRING);
        vm.jeq("_print_value_heap_string");
        vm.cmpImm(VReg.V2, TYPE_DATE);
        vm.jeq("_print_value_heap_date");
        // Map/Set 是**未装箱**堆指针(high16==0),落此堆分派(非上方 nanbox tag5)。
        // _print_value_map/_set 的脱壳 and 对 high16==0 为恒等,单参 console.log(map) 正确。
        vm.cmpImm(VReg.V2, 4); // TYPE_MAP
        vm.jeq("_print_value_map");
        vm.cmpImm(VReg.V2, 5); // TYPE_SET
        vm.jeq("_print_value_set");
        // 检查 Number 对象 (TYPE_NUMBER = 13 或 TYPE_FLOAT64 = 29)
        vm.cmpImm(VReg.V2, 13); // TYPE_NUMBER
        vm.jeq("_print_value_heap_number_int");
        vm.cmpImm(VReg.V2, TYPE_FLOAT64);
        vm.jeq("_print_value_heap_number");
        vm.cmpImm(VReg.V2, 14); // TYPE_BIGINT
        vm.jeq("_print_value_heap_bigint");
        // 默认当作对象
        vm.jmp("_print_value_heap_object");

        vm.label("_print_value_heap_number_int");
        vm.load(VReg.A0, VReg.S0, 8); // 加载 raw int64
        vm.call("_print_int");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_number");
        vm.load(VReg.A0, VReg.S0, 8); // 加载 IEEE 754 值
        vm.call("_print_float");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_array");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_array");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_object");
        vm.label("_print_value_heap_object_ptr_dispatch");
        vm.lea(VReg.A0, "_str_object");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // 统一堆对象打印入口
        vm.label("_print_heap_object");
        vm.lea(VReg.A0, "_str_object");
        vm.call("_print_str");
        vm.ret();

        vm.label("_print_value_heap_function");
        vm.lea(VReg.A0, "_str_function");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_string");
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_heap_date");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_date_toISOString");
        // [修真] _date_toISOString 现返回**装箱串**(content|0x7ffc),旧注"直接打印"已过时:
        // _print_str 需裸 char*,直接传装箱值把 0x7ffc… 当地址读 → 空/垃圾。先 _getStrContent 脱壳。
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // 检查是否在数据段范围内（静态字符串向后兼容）
        // ============ NaN-boxed Tag 检查 ============
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_print_value_check_data_segment"); // 可能是 raw float 或 data ptr

        // 是 tagged value，提取 tag
        vm.subImm(VReg.V1, VReg.V0, 0x7FF8); // V1 = tag

        // Tag 0: Int32
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_print_value_check_bool");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V0);
        vm.call("_print_int");
        vm.jmp(doneLabel);

        vm.label("_print_value_check_bool");
        // Tag 1: Boolean
        vm.cmpImm(VReg.V1, 1);
        vm.jne("_print_value_check_null");
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V0);
        vm.cmpImm(VReg.V0, 1);
        vm.jeq("_print_value_true");
        vm.lea(VReg.A0, "_str_false");
        vm.call("_print_str");
        vm.jmp(doneLabel);
        vm.label("_print_value_true");
        vm.lea(VReg.A0, "_str_true");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_check_null");
        // Tag 2: Null
        vm.cmpImm(VReg.V1, 2);
        vm.jne("_print_value_check_undefined");
        vm.lea(VReg.A0, "_str_null");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_check_undefined");
        // Tag 3: Undefined
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_print_value_check_string");
        vm.lea(VReg.A0, "_str_undefined");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_check_string");
        // Tag 4: String
        vm.cmpImm(VReg.V1, 4);
        vm.jne("_print_value_check_heap");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V0);
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label("_print_value_check_heap");
        // 其他 Heap Objects (5, 6, 7)
        vm.cmpImm(VReg.V1, 5);
        vm.jeq("_print_value_is_heap");
        vm.cmpImm(VReg.V1, 6);
        vm.jeq("_print_value_is_heap");
        vm.cmpImm(VReg.V1, 7);
        vm.jeq("_print_value_is_heap");
        
        vm.jmp("_print_value_check_data_segment");

        vm.label("_print_value_is_heap");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V0);
        vm.call("_print_heap_object");
        vm.jmp(doneLabel);

        vm.label("_print_value_check_data_segment");
        vm.lea(VReg.V1, "_data_start");
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_value_not_heap");
        vm.lea(VReg.V1, "_data_start");
        vm.addImm(VReg.V1, VReg.V1, 0x100000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_print_value_not_heap");
        // 是数据段字符串
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_str");
        vm.jmp(doneLabel);

        // ============ 处理原始浮点数（不是 NaN-boxed）============
        // 这些值是通过常量折叠产生的原始 IEEE 754 位模式
        // 直接作为浮点数打印
        vm.label("_print_value_not_nanboxed");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_float");
        vm.jmp(doneLabel);

        vm.label("_print_value_not_heap");
        // 不在堆范围内，可能是整数或浮点数
        // 检查是否是小整数（-1MB 到 1MB）
        vm.cmpImm(VReg.S0, 0);
        vm.jlt("_print_value_check_neg");
        vm.movImm(VReg.V1, 0x100000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_value_as_int");
        vm.jmp("_print_value_as_float");

        vm.label("_print_value_check_neg");
        vm.movImm(VReg.V1, -0x100000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_print_value_as_int");
        // 大负数，当作浮点数
        vm.jmp("_print_value_as_float");

        vm.label("_print_value_as_int");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_int");
        vm.jmp(doneLabel);

        vm.label("_print_value_as_float");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_float");
        vm.jmp(doneLabel);

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // 打印数组 [1, 2, 3]
    generatePrintArray() {
        const vm = this.vm;

        vm.label("_print_array");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // 数组指针

        // 获取数组长度 (在偏移 8 处)。空数组 → "[]"(node:无括内空格);非空 → "[ … ]"。
        vm.load(VReg.S1, VReg.S0, 8); // length
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_print_array_empty");
        vm.lea(VReg.A0, this.vm.asm.addString("[ "));
        vm.call("_print_str_no_nl");

        // 索引从 0 开始
        vm.movImm(VReg.S2, 0); // index

        const loopLabel = "_print_array_loop";
        const endLabel = "_print_array_end";
        const notFirstLabel = "_print_array_not_first";

        vm.label(loopLabel);
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge(endLabel);

        // 如果不是第一个元素，先打印 ", "
        vm.cmpImm(VReg.S2, 0);
        vm.jeq(notFirstLabel);
        vm.lea(VReg.A0, "_str_comma");
        vm.call("_print_str_no_nl");

        vm.label(notFirstLabel);
        // 获取元素值: array[index] = *(data_ptr(@24) + index * 8)
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.mov(VReg.V0, VReg.S2);
        vm.shl(VReg.V0, VReg.V0, 3); // index * 8
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_print_array_elem_no_nl");

        // 索引加 1
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp(loopLabel);

        vm.label(endLabel);
        // 打印 " ]" 和换行
        vm.lea(VReg.A0, this.vm.asm.addString(" ]"));
        vm.call("_print_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_print_array_empty");
        vm.lea(VReg.A0, this.vm.asm.addString("[]"));
        vm.call("_print_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // _print_array_no_nl(A0 = 裸/脱壳数组 user_ptr):同 _print_array 但收尾不换行。
        // 供多参 console.log 非末位数组、以及数组/对象元素中的嵌套数组递归打印
        // (此前二者落 "[object Object]"/"[Array]"/GC 头误判垃圾)。元素经
        // _print_array_elem_no_nl → 嵌套值再回 _print_value_no_nl,递归收敛。
        vm.label("_print_array_no_nl");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.load(VReg.S1, VReg.S0, 8); // length
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_print_array_nn_empty");
        vm.lea(VReg.A0, this.vm.asm.addString("[ "));
        vm.call("_print_str_no_nl");
        vm.movImm(VReg.S2, 0);
        const loopNN = "_print_array_nn_loop";
        const endNN = "_print_array_nn_end";
        const notFirstNN = "_print_array_nn_not_first";
        vm.label(loopNN);
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge(endNN);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq(notFirstNN);
        vm.lea(VReg.A0, "_str_comma");
        vm.call("_print_str_no_nl");
        vm.label(notFirstNN);
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.mov(VReg.V0, VReg.S2);
        vm.shl(VReg.V0, VReg.V0, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_print_array_elem_no_nl");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp(loopNN);
        vm.label(endNN);
        vm.lea(VReg.A0, this.vm.asm.addString(" ]"));
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_print_array_nn_empty");
        vm.lea(VReg.A0, this.vm.asm.addString("[]"));
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // 数组元素打印（无换行）
    // - 字符串元素：打印带双引号的内容
    // - 其他：复用 _print_value_no_nl
    generatePrintArrayElemNoNL() {
        const vm = this.vm;

        vm.label("_print_array_elem_no_nl");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        const doneLabel = "_print_array_elem_done";
        const checkDataLabel = "_print_array_elem_check_data";
        const isHeapObjLabel = "_print_array_elem_is_heap";
        const isStringLabel = "_print_array_elem_is_string";
        const isDataStringLabel = "_print_array_elem_is_data_string";
        const isRawFloatLabel = "_print_array_elem_raw_float";

        // 未装箱堆指针(Map/Set 等,high16==0 但落 [heap_base, heap_ptr) 且 >=0x100200000)→
        // 委托 _print_value_no_nl(其 untagged 分派认 Map/Set/Symbol/…)。置于 raw-float 判之前:
        // 否则 high16==0 的堆指针落 isRawFloat 打成垃圾整数(容器内 Map/Set 显 "0" 之根)。
        // 装箱值(high16>=0x7FF8)与常规浮点(位型 >> heap_ptr)均不落此区间,不受影响。
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_array_elem_not_heapptr");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_print_array_elem_not_heapptr");
        vm.movImm(VReg.V1, vm.platform === "wasi" ? 0x8000000 : 0x100200000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_print_array_elem_not_heapptr");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_value_no_nl");
        vm.jmp(doneLabel);
        vm.label("_print_array_elem_not_heapptr");

        // 检查是否是原始float（高16位 < 0x7FF8）
        // 原始float不是JSValue，需要特殊处理
        vm.shrImm(VReg.V1, VReg.S0, 48); // V1 = 高16位
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt(isRawFloatLabel);

        // [修真] NaN-boxed 标记值(high16>=0x7FF8):此前经下方 heap 范围判被当"非堆"落
        // checkData,loadByte[S0] 解引用标签巨值(0x7FFx…)→ 段错误
        // (console.log(["a"])/([true])/([null])/([{...}]) 全崩根因)。
        // 0x7FFC 装箱串 → 脱壳后带引号打印(数组元素语义);其余标记(int/bool/null/undef/
        // obj/array/func)→ 委托通用 _print_value_no_nl(其内已全标签分派)。
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_print_array_elem_boxed_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_value_no_nl");
        vm.jmp(doneLabel);
        vm.label("_print_array_elem_boxed_str");
        // 引号 + 内容 + 引号。内容用 _getStrContent(接受装箱串,兼容堆串/数据段串/rope);
        // 勿手取 [S0+16](仅堆串布局,对其它串型取到空 → ["",""])。
        vm.lea(VReg.A0, "_str_quote");
        vm.call("_print_str_no_nl");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");
        vm.lea(VReg.A0, "_str_quote");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        // 0 直接走通用逻辑
        vm.cmpImm(VReg.S0, 0);
        vm.jeq(checkDataLabel);

        // heap_base <= ptr < heap_ptr 才认为是堆对象
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt(checkDataLabel);

        vm.lea(VReg.V2, "_heap_ptr");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jge(checkDataLabel);

        // 额外检查：如果是代码/数据段范围内的地址，不是堆对象
        vm.movImm(VReg.V3, vm.platform === "wasi" ? 0x8000000 : 0x100200000);
        vm.cmp(VReg.S0, VReg.V3);
        vm.jlt(checkDataLabel);

        vm.jmp(isHeapObjLabel);

        vm.label(isHeapObjLabel);
        vm.load(VReg.V2, VReg.S0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);
        vm.movImm(VReg.V3, TYPE_STRING);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jeq(isStringLabel);

        // 非字符串，走通用打印
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_value_no_nl");
        vm.jmp(doneLabel);

        vm.label(isStringLabel);
        // 打印 " + content + " (堆字符串内容在 +16)
        vm.lea(VReg.A0, "_str_quote");
        vm.call("_print_str_no_nl");
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_str_no_nl");
        vm.lea(VReg.A0, "_str_quote");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(checkDataLabel);
        // 数据段字符串：如果首字节在可打印 ASCII 范围内，则按字符串加引号输出
        // 否则退回通用打印
        vm.movImm(VReg.V1, 0x100000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt(isDataStringLabel); // < 1MB 肯定不是数据段字符串，走通用打印

        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 32);
        vm.jlt(isDataStringLabel);
        vm.cmpImm(VReg.V1, 127);
        vm.jge(isDataStringLabel);

        // 看起来像 C 字符串
        vm.lea(VReg.A0, "_str_quote");
        vm.call("_print_str_no_nl");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_str_no_nl");
        vm.lea(VReg.A0, "_str_quote");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(isDataStringLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_value_no_nl");
        vm.jmp(doneLabel);

        // 原始float: 最短往返 _floatToString(A0=raw f64 位 → 装箱串),脱壳取内容打印;
        // 曾用 fcvtzs+_print_int_no_nl 截整数(数组/对象内嵌 0.1→"0"、大数饱和)。
        vm.label(isRawFloatLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_floatToString");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.RET, VReg.V1); // A0 = 内容指针
        vm.call("_print_str_no_nl");

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // 打印 Promise（带换行）
    // A0 = promise 指针
    generatePrintPromise() {
        const vm = this.vm;

        vm.label("_print_promise");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        // status: +8
        vm.load(VReg.S1, VReg.S0, 8);

        const pendingLabel = "_print_promise_pending";
        const fulfilledLabel = "_print_promise_fulfilled";
        const rejectedLabel = "_print_promise_rejected";
        const doneLabel = "_print_promise_done";

        // pending = 0
        vm.cmpImm(VReg.S1, 0);
        vm.jeq(pendingLabel);

        // fulfilled = 1
        vm.cmpImm(VReg.S1, 1);
        vm.jeq(fulfilledLabel);

        // rejected = 2
        vm.cmpImm(VReg.S1, 2);
        vm.jeq(rejectedLabel);

        // unknown -> 当作 pending
        vm.jmp(pendingLabel);

        vm.label(pendingLabel);
        vm.lea(VReg.A0, "_str_promise_pending");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label(fulfilledLabel);
        vm.lea(VReg.A0, "_str_promise_fulfilled_full");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label(rejectedLabel);
        vm.lea(VReg.A0, "_str_promise_rejected_full");
        vm.call("_print_str");
        vm.jmp(doneLabel);

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // 打印 Promise（无换行）
    // A0 = promise 指针
    generatePrintPromiseNoNL() {
        const vm = this.vm;

        vm.label("_print_promise_no_nl");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        vm.load(VReg.S1, VReg.S0, 8); // status

        const pendingLabel = "_print_promise_nl_pending";
        const fulfilledLabel = "_print_promise_nl_fulfilled";
        const rejectedLabel = "_print_promise_nl_rejected";
        const doneLabel = "_print_promise_nl_done";

        vm.cmpImm(VReg.S1, 0);
        vm.jeq(pendingLabel);
        vm.cmpImm(VReg.S1, 1);
        vm.jeq(fulfilledLabel);
        vm.cmpImm(VReg.S1, 2);
        vm.jeq(rejectedLabel);
        vm.jmp(pendingLabel);

        vm.label(pendingLabel);
        vm.lea(VReg.A0, "_str_promise_pending");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(fulfilledLabel);
        vm.lea(VReg.A0, "_str_promise_fulfilled_full");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(rejectedLabel);
        vm.lea(VReg.A0, "_str_promise_rejected_full");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // 打印值（无换行版本，用于数组元素）
    generatePrintValueNoNL() {
        const vm = this.vm;

        vm.label("_print_value_no_nl");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        const notZeroLabel = "_print_vnl_not_zero";
        const doneLabel = "_print_vnl_done";

        // 负零特判(同 _print_value):inspect 嵌套(数组/对象元素)里 -0.0 打印 "-0"。
        vm.movImm(VReg.V1, 1);
        vm.shlImm(VReg.V1, VReg.V1, 63);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jne("_print_vnl_not_negzero");
        vm.lea(VReg.A0, "_str_negzero");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);
        vm.label("_print_vnl_not_negzero");

        // ===== NaN-box 标签分派（与 _print_value 语义对齐）=====
        // 旧实现从不解 NaN-box：0x7FFC|ptr 超过堆上界被当浮点打印成 NaN
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_print_vnl_untagged");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jgt("_print_vnl_untagged");
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_print_vnl_boxed_str");
        vm.cmpImm(VReg.V1, 0x7FF9);
        vm.jeq("_print_vnl_boxed_bool");
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_print_vnl_boxed_null");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_print_vnl_boxed_undef");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_print_vnl_boxed_func");
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jeq("_print_vnl_int_tag");
        // 0x7FFE (数组):脱壳成 user_ptr,递归无换行数组打印(元素/嵌套正确)。
        // 勿落 _print_vnl_untagged:其 subImm 16 读 [user-16] GC 头当类型 → 数组误判
        // 对象/typedarray 垃圾(多参/嵌套数组丢内容、Date 打 "object(40)" 之根)。
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_print_vnl_boxed_array");
        // 0x7FFD (对象):脱壳 user_ptr,读 [user+0] 类型字节。TYPE_OBJECT(2) → 属性打印器;
        // 其余(Date/Map/Set/Promise/Number/Symbol 装箱对象)→ 既有 untagged(保持现状,不崩)。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V2, VReg.S0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);
        vm.cmpImm(VReg.V2, TYPE_OBJECT);
        vm.jeq("_print_vnl_boxed_object");
        vm.cmpImm(VReg.V2, TYPE_DATE);
        vm.jeq("_print_vnl_boxed_date");
        vm.cmpImm(VReg.V2, 4); // TYPE_MAP
        vm.jeq("_print_vnl_boxed_map");
        vm.cmpImm(VReg.V2, 5); // TYPE_SET
        vm.jeq("_print_vnl_boxed_set");
        vm.jmp("_print_vnl_untagged");

        vm.label("_print_vnl_boxed_map");
        vm.mov(VReg.A0, VReg.S0); // user_ptr(已脱壳)
        vm.call("_print_map_no_nl");
        vm.jmp(doneLabel);
        vm.label("_print_vnl_boxed_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_set_no_nl");
        vm.jmp(doneLabel);

        // 未装箱 Map/Set(untagged 路径,S0=block):user_ptr = S0+16。
        vm.label("_print_vnl_map_ub");
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_map_no_nl");
        vm.jmp(doneLabel);
        vm.label("_print_vnl_set_ub");
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_set_no_nl");
        vm.jmp(doneLabel);

        // 数组/对象元素或多参非末位中的 Date → ISO(无换行)。S0 已脱壳,_date_toISOString
        // 需装箱 date,故重打 0x7ffd 标签;返回装箱串再 _getStrContent 脱壳打印。
        vm.label("_print_vnl_boxed_date");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_date_toISOString");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label("_print_vnl_boxed_array");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V1); // user_ptr
        vm.call("_print_array_no_nl");
        vm.jmp(doneLabel);

        // 0x7FFD 普通对象(TYPE_OBJECT @ [user+0]):Error 族 → "name: message"(嵌套/多参
        // 一致,避免泄露 __asmjs_err 内部字段);否则 → 属性打印器 "{ k: v }"。
        // _is_asmjs_err/_error_to_str 吃装箱值,S0 已脱壳故重打 0x7ffd 标签。
        vm.label("_print_vnl_boxed_object");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_is_asmjs_err");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_print_vnl_obj_props");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_error_to_str");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);
        vm.label("_print_vnl_obj_props");
        vm.mov(VReg.A0, VReg.S0); // user_ptr(已脱壳)
        vm.call("_print_object_no_nl");
        vm.jmp(doneLabel);

        vm.label("_print_vnl_boxed_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label("_print_vnl_boxed_bool");
        vm.andImm(VReg.V0, VReg.S0, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_print_vnl_bool_false");
        vm.lea(VReg.A0, "_str_true");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);
        vm.label("_print_vnl_bool_false");
        vm.lea(VReg.A0, "_str_false");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label("_print_vnl_boxed_null");
        vm.lea(VReg.A0, "_str_null");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label("_print_vnl_boxed_undef");
        vm.lea(VReg.A0, "_str_undefined");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label("_print_vnl_boxed_func");
        vm.lea(VReg.A0, "_str_function");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label("_print_vnl_int_tag");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.A0, 0);
        vm.jne("_print_vnl_int_tag_val");
        // payload 0 的 0x7FF8 = 规范 NaN
        vm.lea(VReg.A0, this.vm.asm.addString("NaN"));
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);
        vm.label("_print_vnl_int_tag_val");
        vm.call("_print_int_no_nl");
        vm.jmp(doneLabel);

        vm.label("_print_vnl_untagged");
        const isNumberLabel = "_print_vnl_number";
        const isStringLabel = "_print_vnl_string";
        const isArrayLabel = "_print_vnl_array";
        const isPromiseLabel = "_print_vnl_promise";
        const checkDataStrLabel = "_print_vnl_check_data_str";
        const maybeFloatLabel = "_print_vnl_maybe_float";

        vm.cmpImm(VReg.S0, 0);
        vm.jne(notZeroLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_int_no_nl");
        vm.jmp(doneLabel);

        vm.label(notZeroLabel);
        // 负 double(最高位 1)不可能是指针/tagged(tag 段已在上层筛掉)→ 直接浮点。
        // 曾无此判:有符号 jlt 把负浮点送进数据串路径 → 多参打印先吐位模式整数(#15)。
        vm.cmpImm(VReg.S0, 0);
        vm.jlt(maybeFloatLabel);
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt(checkDataStrLabel);

        // 只有 heap_base <= ptr < heap_ptr 才认为是堆对象；否则很可能是浮点位模式
        vm.lea(VReg.V4, "_heap_ptr");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.cmp(VReg.S0, VReg.V4);
        vm.jge(maybeFloatLabel);

        // 额外检查：如果是代码/数据段范围内的地址，不是堆对象
        vm.movImm(VReg.V1, vm.platform === "wasi" ? 0x8000000 : 0x100200000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt(maybeFloatLabel);

        // ==== FIX: Subtract 16 to get block pointer! ====
        vm.subImm(VReg.S0, VReg.S0, 16);

        // 加载用户数据区的第一个字（类型标记在低 8 位）
        vm.load(VReg.V2, VReg.S0, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);

        vm.movImm(VReg.V3, TYPE_ARRAY);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jeq(isArrayLabel);

        vm.movImm(VReg.V3, TYPE_STRING);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jeq(isStringLabel);

        // BigInt 必须先于下方 [S0+16] 基的 Symbol/Map/Set 判别：bigint 值存 user+0
        // =[S0+16]，值恰为 4/5/61 时会被误判成容器（多参 console.log/数组元素:5n^1n=4
        // →"Map(0){}"）。头字节 V2==14 可靠,提前拦截。
        vm.cmpImm(VReg.V2, 14); // TYPE_BIGINT
        vm.jeq("_print_vnl_bigint");
        // Symbol：类型标记在用户区 +0（S0 已减 16 → 偏移 16）。置于
        // TYPE_STRING 之后（同 _print_value 的判序理由）。
        vm.load(VReg.V3, VReg.S0, 16);
        vm.cmpImm(VReg.V3, TYPE_SYMBOL);
        vm.jeq("_print_vnl_symbol");
        // Map/Set(未装箱堆指针,type @ user+0 = [S0+16]):多参非末位 / 容器元素。user_ptr = S0+16。
        vm.load(VReg.V3, VReg.S0, 16);
        vm.cmpImm(VReg.V3, 4); // TYPE_MAP
        vm.jeq("_print_vnl_map_ub");
        vm.load(VReg.V3, VReg.S0, 16);
        vm.cmpImm(VReg.V3, 5); // TYPE_SET
        vm.jeq("_print_vnl_set_ub");
        // TypedArray(裸块指针,类型字节在 user+0=[S0+16];[S0+0]=前分配尾部不可信)。
        // 置于 Map/Set 后、V2 基的数字判前:可靠命中,避免 [S0+0] 垃圾误判。
        vm.load(VReg.V3, VReg.S0, 16);
        vm.andImm(VReg.V3, VReg.V3, 0xff);
        vm.cmpImm(VReg.V3, 0x40);
        vm.jlt("_print_vnl_ta_no");
        vm.cmpImm(VReg.V3, 0x61);
        vm.jle("_print_vnl_typedarray");
        vm.label("_print_vnl_ta_no");

        vm.movImm(VReg.V3, TYPE_PROMISE);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jeq(isPromiseLabel);

        // BigInt (TYPE_BIGINT=14)：多参 console.log/数组元素显示带 "n" 后缀（对齐 node）
        vm.cmpImm(VReg.V2, 14);
        vm.jeq("_print_vnl_bigint");

        // 检查是否是 Number 带子类型 (TYPE_NUMBER = 13)
        const isNumberSubtypeLabel = "_print_vnl_number_subtype";
        vm.cmpImm(VReg.V2, 13);
        vm.jeq(isNumberSubtypeLabel);

        // (TypedArray 已在上方经可靠 [S0+16] 判别短路到 _print_vnl_typedarray)

        // 检查是否是 Number 类型 (TYPE_INT8=20 到 TYPE_FLOAT64=29)
        const isObjectLabel = "_print_vnl_object";
        vm.movImm(VReg.V3, TYPE_INT8);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jlt(isObjectLabel); // 小于 20，未知类型当作对象
        vm.movImm(VReg.V3, TYPE_FLOAT64);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jgt(isObjectLabel); // 大于 29，未知类型当作对象
        // 是 Number 对象
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_number_no_nl");
        vm.jmp(doneLabel);

        // BigInt：64 位值在 block+16，带 "n" 后缀
        vm.label("_print_vnl_bigint");
        vm.load(VReg.A0, VReg.S0, 16);
        vm.call("_print_int_no_nl");
        vm.lea(VReg.A0, this.vm.asm.addString("n"));
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        // Number 带子类型 (TYPE_NUMBER=13)：打印整数值
        vm.label(isNumberSubtypeLabel);
        vm.load(VReg.A0, VReg.S0, 8); // 加载值
        vm.call("_print_int_no_nl"); // 直接打印整数
        vm.jmp(doneLabel);

        // TypedArray:A0 = ta 指针(user+0=[S0+16],type@0)。
        vm.label("_print_vnl_typedarray");
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_typedarray_no_nl");
        vm.jmp(doneLabel);

        // 其他类型（对象、闭包等）
        vm.label(isObjectLabel);
        vm.lea(VReg.A0, "_str_object");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(isStringLabel);
        // 堆分配字符串: 16 字节头部，内容从 +16 开始
        vm.addImm(VReg.A0, VReg.S0, 16);
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(isArrayLabel);
        // 嵌套数组暂时简化处理
        vm.lea(VReg.A0, "_str_array");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(isPromiseLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_promise_no_nl");
        vm.jmp(doneLabel);

        // Symbol: "Symbol(" + desc + ")"（无换行；S0 = block）
        vm.label("_print_vnl_symbol");
        vm.lea(VReg.A0, "_str_symbol_open");
        vm.call("_print_str_no_nl");
        vm.load(VReg.A0, VReg.S0, 24); // desc 裸指针
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");
        vm.lea(VReg.A0, "_str_rparen");
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        // NaN-boxed value check
        vm.label(checkDataStrLabel);
        // 数据段地址通常很大，如果值 < 1MB 当作数字
        vm.movImm(VReg.V1, 0x100000);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt(isNumberLabel);

        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 32);
        vm.jlt(isNumberLabel);
        vm.cmpImm(VReg.V1, 127);
        vm.jge(isNumberLabel);

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_str_no_nl");
        vm.jmp(doneLabel);

        vm.label(isNumberLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_int_no_nl");

        vm.label(maybeFloatLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_print_float_no_nl");

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // _print_object_no_nl(A0 = 普通对象 user_ptr):打印 "{ k: v, ... }"(空对象 "{}")。
    // 键裸打印(不加引号,近似 node 对合法标识符键的行为);值经 _print_array_elem_no_nl
    // (串加引号、数组/对象递归)。此前所有对象打印落 "[object Object]"。
    // 布局:[type@0, count@8, __proto__@16, capacity@24, props_ptr@32];每属性 16B:
    // [key(装箱串)@0, value@8]。限制:getter 值(裸标记指针)打印为垃圾整数(罕见);
    // 键顺序=插入序(整型键前置的 ES 规范排序未实现,见既有偏差)。
    generatePrintObjectNoNL() {
        const vm = this.vm;
        vm.label("_print_object_no_nl");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);      // user_ptr
        vm.load(VReg.S1, VReg.S0, 8);  // count
        vm.load(VReg.S2, VReg.S0, 32); // props_ptr
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_print_obj_empty");
        vm.lea(VReg.A0, this.vm.asm.addString("{ "));
        vm.call("_print_str_no_nl");
        vm.movImm(VReg.S3, 0);         // index
        vm.label("_print_obj_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_print_obj_close");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_print_obj_nofirst");
        vm.lea(VReg.A0, "_str_comma"); // ", "
        vm.call("_print_str_no_nl");
        vm.label("_print_obj_nofirst");
        // prop 地址 = props_ptr + index*16
        vm.mov(VReg.V0, VReg.S3);
        vm.shlImm(VReg.V0, VReg.V0, 4);
        vm.add(VReg.V0, VReg.S2, VReg.V0);
        // key(装箱串)→ 裸内容 → 打印
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");
        // ": "
        vm.lea(VReg.A0, this.vm.asm.addString(": "));
        vm.call("_print_str_no_nl");
        // value → _print_array_elem_no_nl(串加引号、递归)。从 S2/S3 重算地址(调用毁 V0)
        vm.mov(VReg.V0, VReg.S3);
        vm.shlImm(VReg.V0, VReg.V0, 4);
        vm.add(VReg.V0, VReg.S2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 8);
        vm.call("_print_array_elem_no_nl");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_print_obj_loop");
        vm.label("_print_obj_close");
        vm.lea(VReg.A0, this.vm.asm.addString(" }"));
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);
        vm.label("_print_obj_empty");
        vm.lea(VReg.A0, this.vm.asm.addString("{}"));
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);
    }

    // _print_map_no_nl(A0 = Map user_ptr):打印 "Map(n) { k => v, ... }"(空 "Map(0) {}")。
    // 布局:[type@0, size@8, head@16];节点 [key@0, value@8, next@16]。键/值经
    // _print_array_elem_no_nl(串加引号、递归)。S2=首元素标志(0=首,免前置逗号)。
    generatePrintMapNoNL() {
        const vm = this.vm;
        vm.label("_print_map_no_nl");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.A0, this.vm.asm.addString("Map("));
        vm.call("_print_str_no_nl");
        vm.load(VReg.A0, VReg.S0, 8); // size
        vm.call("_print_int_no_nl");
        vm.load(VReg.S1, VReg.S0, 8); // size(判空)
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_print_map_empty");
        vm.lea(VReg.A0, this.vm.asm.addString(") { "));
        vm.call("_print_str_no_nl");
        vm.load(VReg.S1, VReg.S0, 16); // cur = head
        vm.movImm(VReg.S2, 0);         // first flag
        vm.label("_print_map_loop");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_print_map_close");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_print_map_nocomma");
        vm.lea(VReg.A0, "_str_comma");
        vm.call("_print_str_no_nl");
        vm.label("_print_map_nocomma");
        vm.movImm(VReg.S2, 1);
        vm.load(VReg.A0, VReg.S1, 0);  // key
        vm.call("_print_array_elem_no_nl");
        vm.lea(VReg.A0, this.vm.asm.addString(" => "));
        vm.call("_print_str_no_nl");
        vm.load(VReg.A0, VReg.S1, 8);  // value
        vm.call("_print_array_elem_no_nl");
        vm.load(VReg.S1, VReg.S1, 16); // next
        vm.jmp("_print_map_loop");
        vm.label("_print_map_close");
        vm.lea(VReg.A0, this.vm.asm.addString(" }"));
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_print_map_empty");
        vm.lea(VReg.A0, this.vm.asm.addString(") {}"));
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
    }

    // _print_set_no_nl(A0 = Set user_ptr):打印 "Set(n) { v, ... }"(空 "Set(0) {}")。
    // 布局:[type@0, size@8, head@16];节点 [value@0, next@8]。
    generatePrintSetNoNL() {
        const vm = this.vm;
        vm.label("_print_set_no_nl");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.A0, this.vm.asm.addString("Set("));
        vm.call("_print_str_no_nl");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_print_int_no_nl");
        vm.load(VReg.S1, VReg.S0, 8);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_print_set_empty");
        vm.lea(VReg.A0, this.vm.asm.addString(") { "));
        vm.call("_print_str_no_nl");
        vm.load(VReg.S1, VReg.S0, 16); // cur = head
        vm.movImm(VReg.S2, 0);
        vm.label("_print_set_loop");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_print_set_close");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_print_set_nocomma");
        vm.lea(VReg.A0, "_str_comma");
        vm.call("_print_str_no_nl");
        vm.label("_print_set_nocomma");
        vm.movImm(VReg.S2, 1);
        vm.load(VReg.A0, VReg.S1, 0);  // value
        vm.call("_print_array_elem_no_nl");
        vm.load(VReg.S1, VReg.S1, 8);  // next
        vm.jmp("_print_set_loop");
        vm.label("_print_set_close");
        vm.lea(VReg.A0, this.vm.asm.addString(" }"));
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_print_set_empty");
        vm.lea(VReg.A0, this.vm.asm.addString(") {}"));
        vm.call("_print_str_no_nl");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
    }

    // 打印 TypedArray: "Float64Array(3) [1, 2.5, 3.14]"
    generatePrintTypedArray() {
        const vm = this.vm;

        vm.label("_print_typedarray");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.mov(VReg.S0, VReg.A0); // arr

        // 加载 type 和 length
        vm.load(VReg.S1, VReg.S0, 0); // type
        vm.load(VReg.S2, VReg.S0, 8); // length
        // [Design A] 元素基址改用 data_ptr:S0 = data_ptr - 16(既有寻址从 offset=16 起 base+offset)。
        vm.load(VReg.V0, VReg.S0, 16);
        vm.subImm(VReg.S0, VReg.V0, 16);

        // 根据 type 确定元素大小，存入 S4
        // 1字节: Int8Array(0x40), Uint8Array(0x50), Uint8ClampedArray(0x54)
        // 2字节: Int16Array(0x41), Uint16Array(0x51)
        // 4字节: Int32Array(0x42), Uint32Array(0x52), Float32Array(0x60)
        // 8字节: BigInt64Array(0x43), BigUint64Array(0x53), Float64Array(0x61)
        vm.movImm(VReg.S4, 8); // 默认 8 字节

        // 检查 1 字节类型
        vm.cmpImm(VReg.S1, 0x40); // Int8Array
        vm.jeq("_print_ta_1byte");
        vm.cmpImm(VReg.S1, 0x50); // Uint8Array
        vm.jeq("_print_ta_1byte");
        vm.cmpImm(VReg.S1, 0x54); // Uint8ClampedArray
        vm.jeq("_print_ta_1byte");

        // 检查 2 字节类型
        vm.cmpImm(VReg.S1, 0x41); // Int16Array
        vm.jeq("_print_ta_2byte");
        vm.cmpImm(VReg.S1, 0x51); // Uint16Array
        vm.jeq("_print_ta_2byte");

        // 检查 4 字节类型
        vm.cmpImm(VReg.S1, 0x42); // Int32Array
        vm.jeq("_print_ta_4byte");
        vm.cmpImm(VReg.S1, 0x52); // Uint32Array
        vm.jeq("_print_ta_4byte");
        vm.cmpImm(VReg.S1, 0x60); // Float32Array
        vm.jeq("_print_ta_4byte");

        // 默认 8 字节类型
        vm.jmp("_print_ta_header");

        vm.label("_print_ta_1byte");
        vm.movImm(VReg.S4, 1);
        vm.jmp("_print_ta_header");

        vm.label("_print_ta_2byte");
        vm.movImm(VReg.S4, 2);
        vm.jmp("_print_ta_header");

        vm.label("_print_ta_4byte");
        vm.movImm(VReg.S4, 4);
        vm.jmp("_print_ta_header");

        // 打印类型名称
        vm.label("_print_ta_header");
        vm.mov(VReg.A0, VReg.S1); // S1 = 类型字节
        vm.call("_get_type_name");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_print_str_no_nl");

        // 打印 "(length) ["
        vm.movImm(VReg.A0, 40); // '('
        vm.call("_print_char");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_print_int_no_nl");
        vm.movImm(VReg.A0, 41); // ')'
        vm.call("_print_char");
        vm.movImm(VReg.A0, 32); // ' '
        vm.call("_print_char");
        vm.movImm(VReg.A0, 91); // '['
        vm.call("_print_char");
        // 非空数组:'[' 后补空格(node 格式 "[ 1, 2, 3 ]");空数组保持 "[]"。
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_print_ta_hdr_noopen");
        vm.movImm(VReg.A0, 32); // ' '
        vm.call("_print_char");
        vm.label("_print_ta_hdr_noopen");

        // 打印元素，使用 S3 作为循环计数器，S5 作为当前偏移
        vm.movImm(VReg.S3, 0); // i = 0
        vm.movImm(VReg.S5, 16); // offset = 16 (header size)

        vm.label("_print_ta_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_print_ta_done");

        // 打印逗号分隔符 (除了第一个元素)
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_print_ta_elem");
        vm.lea(VReg.A0, "_str_comma");
        vm.call("_print_str_no_nl");

        vm.label("_print_ta_elem");
        // 计算元素地址: arr + offset
        vm.add(VReg.V0, VReg.S0, VReg.S5);

        // 根据类型选择加载方式并打印
        // Float64Array (0x61): 加载 8 字节，打印浮点
        vm.cmpImm(VReg.S1, 0x61);
        vm.jeq("_print_ta_float64");

        // Float32Array (0x60): 加载 4 字节，打印浮点
        vm.cmpImm(VReg.S1, 0x60);
        vm.jeq("_print_ta_float32");

        // 整数类型：加载字节并组装
        // 1 字节有符号: Int8Array (0x40)
        vm.cmpImm(VReg.S1, 0x40);
        vm.jeq("_print_ta_int8");

        // 1 字节无符号: Uint8Array (0x50), Uint8ClampedArray (0x54)
        vm.cmpImm(VReg.S1, 0x50);
        vm.jeq("_print_ta_uint8");
        vm.cmpImm(VReg.S1, 0x54);
        vm.jeq("_print_ta_uint8");

        // 2 字节有符号: Int16Array (0x41)
        vm.cmpImm(VReg.S1, 0x41);
        vm.jeq("_print_ta_int16");

        // 2 字节无符号: Uint16Array (0x51)
        vm.cmpImm(VReg.S1, 0x51);
        vm.jeq("_print_ta_uint16");

        // 4 字节有符号: Int32Array (0x42)
        vm.cmpImm(VReg.S1, 0x42);
        vm.jeq("_print_ta_int32");

        // 4 字节无符号: Uint32Array (0x52)
        vm.cmpImm(VReg.S1, 0x52);
        vm.jeq("_print_ta_uint32");

        // 8 字节有符号: BigInt64Array (0x43)
        vm.cmpImm(VReg.S1, 0x43);
        vm.jeq("_print_ta_int64");

        // 8 字节无符号: BigUint64Array (0x53) - 默认
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_print_int_no_nl");
        vm.jmp("_print_ta_next");

        // Float64Array
        vm.label("_print_ta_float64");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_print_float_no_nl");
        vm.jmp("_print_ta_next");

        // Float32Array - 加载 4 字节，转换为 double 打印
        vm.label("_print_ta_float32");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.loadByte(VReg.V2, VReg.V0, 1);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V0, 2);
        vm.shl(VReg.V2, VReg.V2, 16);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V0, 3);
        vm.shl(VReg.V2, VReg.V2, 24);
        vm.or(VReg.A0, VReg.V1, VReg.V2);
        vm.call("_print_float32_no_nl");
        vm.jmp("_print_ta_next");

        // Int8Array - 有符号 1 字节
        vm.label("_print_ta_int8");
        vm.loadByte(VReg.A0, VReg.V0, 0);
        // 符号扩展: 如果 bit 7 = 1, 则扩展为负数
        vm.andImm(VReg.V1, VReg.A0, 0x80);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_print_ta_int8_pos");
        // 负数：扩展为 64 位
        vm.orImm(VReg.A0, VReg.A0, -256); // 0xFFFFFFFFFFFFFF00
        vm.label("_print_ta_int8_pos");
        vm.call("_print_int_no_nl");
        vm.jmp("_print_ta_next");

        // Uint8Array - 无符号 1 字节
        vm.label("_print_ta_uint8");
        vm.loadByte(VReg.A0, VReg.V0, 0);
        vm.call("_print_int_no_nl");
        vm.jmp("_print_ta_next");

        // Int16Array - 有符号 2 字节
        vm.label("_print_ta_int16");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.loadByte(VReg.V2, VReg.V0, 1);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.A0, VReg.V1, VReg.V2);
        // 符号扩展
        vm.andImm(VReg.V1, VReg.A0, 0x8000);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_print_ta_int16_pos");
        vm.orImm(VReg.A0, VReg.A0, -65536); // 0xFFFFFFFFFFFF0000
        vm.label("_print_ta_int16_pos");
        vm.call("_print_int_no_nl");
        vm.jmp("_print_ta_next");

        // Uint16Array - 无符号 2 字节
        vm.label("_print_ta_uint16");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.loadByte(VReg.V2, VReg.V0, 1);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.A0, VReg.V1, VReg.V2);
        vm.call("_print_int_no_nl");
        vm.jmp("_print_ta_next");

        // Int32Array - 有符号 4 字节
        vm.label("_print_ta_int32");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.loadByte(VReg.V2, VReg.V0, 1);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V0, 2);
        vm.shl(VReg.V2, VReg.V2, 16);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V0, 3);
        vm.shl(VReg.V2, VReg.V2, 24);
        vm.or(VReg.A0, VReg.V1, VReg.V2);
        // 符号扩展 32->64 位
        vm.shl(VReg.A0, VReg.A0, 32);
        vm.sar(VReg.A0, VReg.A0, 32);
        vm.call("_print_int_no_nl");
        vm.jmp("_print_ta_next");

        // Uint32Array - 无符号 4 字节
        vm.label("_print_ta_uint32");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.loadByte(VReg.V2, VReg.V0, 1);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V0, 2);
        vm.shl(VReg.V2, VReg.V2, 16);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V0, 3);
        vm.shl(VReg.V2, VReg.V2, 24);
        vm.or(VReg.A0, VReg.V1, VReg.V2);
        vm.call("_print_int_no_nl");
        vm.jmp("_print_ta_next");

        // BigInt64Array - 8 字节有符号
        vm.label("_print_ta_int64");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_print_int_no_nl");
        vm.jmp("_print_ta_next");

        // 下一个元素
        vm.label("_print_ta_next");
        vm.addImm(VReg.S3, VReg.S3, 1); // i++
        vm.add(VReg.S5, VReg.S5, VReg.S4); // offset += elemSize
        vm.jmp("_print_ta_loop");

        vm.label("_print_ta_done");
        // 非空:']' 前补空格(node "[ 1, 2, 3 ]");空数组保持 "[]"。
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_print_ta_done_close");
        vm.movImm(VReg.A0, 32); // ' '
        vm.call("_print_char");
        vm.label("_print_ta_done_close");
        // 打印 "]"（无换行;NL 版由调用点补 _print_nl)
        vm.movImm(VReg.A0, 93); // ']'
        vm.call("_print_char");

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // 无换行 TypedArray 打印:与 _print_typedarray 同(全元素),仅省略尾换行。
    // 用于多参 console.log 非末位 / 数组·对象元素嵌套。以往的 "(len) [...]" 缩略式
    // 有长度寄存器(V0 caller-saved)被 _print_char 破坏的隐患,且与 node 不符,已并入完整打印。
    generatePrintTypedArrayNoNL() {
        const vm = this.vm;
        vm.label("_print_typedarray_no_nl");
        vm.jmp("_print_typedarray");
    }

    // 打印 ArrayBuffer: "ArrayBuffer { byteLength: N }"
    generatePrintArrayBuffer() {
        const vm = this.vm;

        vm.label("_print_arraybuffer");
        vm.prologue(16, [VReg.S0]);

        vm.mov(VReg.S0, VReg.A0); // buf

        // 打印 "ArrayBuffer { byteLength: "
        vm.lea(VReg.A0, "_str_ArrayBuffer");
        vm.call("_print_str_no_nl");
        vm.lea(VReg.A0, "_str_arraybuffer_open");
        vm.call("_print_str_no_nl");

        // 打印长度
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_print_int_no_nl");

        // 打印 " }" 和换行
        vm.lea(VReg.A0, "_str_arraybuffer_close");
        vm.call("_print_str_no_nl");
        vm.call("_print_nl");

        vm.epilogue([VReg.S0], 16);
    }


    generate() {
        this.generatePrintStringNoNL();
        this.generatePrintString();
        this.generatePrintNewline();
        this.generatePrintBool();
        this.generatePrintBoolNoNL();
        this.generatePrintSpace();
        this.generatePrintWrapper();
        this.generatePrintValue();
        this.generatePrintArray();
        this.generatePrintArrayElemNoNL();
        this.generatePrintPromise();
        this.generatePrintPromiseNoNL();
        this.generatePrintValueNoNL();
        this.generatePrintObjectNoNL();
        this.generatePrintMapNoNL();
        this.generatePrintSetNoNL();
        this.generatePrintTypedArray();
        this.generatePrintTypedArrayNoNL();
        this.generatePrintArrayBuffer();
        this.generatePrintChar();
    }
}
