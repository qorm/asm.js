// asm.js 运行时 - 下标访问
// 统一处理 Array 和 TypedArray 的下标访问

import { VReg } from "../../vm/registers.js";
import { TYPE_INT8_ARRAY, TYPE_INT16_ARRAY, TYPE_INT32_ARRAY, TYPE_INT64_ARRAY, TYPE_UINT8_ARRAY, TYPE_UINT16_ARRAY, TYPE_UINT32_ARRAY, TYPE_UINT64_ARRAY, TYPE_UINT8_CLAMPED_ARRAY, TYPE_FLOAT32_ARRAY, TYPE_FLOAT64_ARRAY, NUM_INT8, NUM_INT16, NUM_INT32, NUM_INT64, NUM_UINT8, NUM_UINT16, NUM_UINT32, NUM_UINT64, NUM_UINT8_CLAMPED, NUM_FLOAT32, NUM_FLOAT64 } from "./types.js";

export class SubscriptGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
    }

    // _subscript_get(arr, index) -> value
    // 根据数组类型（Array 或 TypedArray）选择正确的访问方式
    // TypedArray 返回 boxed Number（类型与元素类型匹配）
    generateGet() {
        const vm = this.vm;

        vm.label("_subscript_get");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S1, VReg.A1); // index（先保存）
        // null/undefined 基对象下标读 `null[k]`/`undefined[k]`:抛可捕获 TypeError
        // (镜像 round-4 的静态 `.x` 修复),否则下方 _js_unbox 把小 tagged 值当裸
        // 指针解引用 → 段错误。A0 仍为原始基对象。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); // null
        vm.jeq("_subscript_get_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); // undefined
        vm.jeq("_subscript_get_nullish");
        // 字符串 (0x7FFC)：str[i] 直接 charAt，不走 unbox+对象头路径
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_subscript_get_not_str");
        vm.mov(VReg.S0, VReg.A0); // 保留装箱字符串
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_syscall_arg");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_index_char"); // str[i]:越界返 undefined(非 charAt 的 "")
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        vm.label("_subscript_get_not_str");
        // unbox arr：可能是裸指针或 0x7FFE/0x7FFD 装箱值（_js_unbox 保留 A1）
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET); // arr (裸指针)

        // 加载类型标签
        vm.load(VReg.S3, VReg.S0, 0); // S3 = 完整类型
        vm.andImm(VReg.V0, VReg.S3, 0xff); // V0 = 低 8 位类型

        // [fn props] 闭包(magic 全字 0xc105/0xa51c)→ 闭包属性侧表读(f[sym]/f[k];
        // 低字节 5 与 TYPE_SET 撞,须查全字,先于低字节分派)。
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jeq("_subscript_get_closure");
        vm.movImm(VReg.V1, 0xa51c);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jeq("_subscript_get_closure");
        // 对象：按键查找而非数值下标（obj[key]）
        vm.cmpImm(VReg.V0, 2); // TYPE_OBJECT
        vm.jeq("_subscript_get_object");
        // classinfo(TYPE_FUNCTION=3):类对象是属性容器(count@8/props_ptr@32,布局同对象头),
        // Class[sym]/Class[computedKey] 按对象键读。闭包(magic 0xc105,低字节 5)不匹配 3,
        // 仍走下方数值/普通路径,函数调用与既有用法字节不变。
        vm.cmpImm(VReg.V0, 3);
        vm.jeq("_subscript_get_object");
        // Proxy(TYPE_PROXY=8):proxy[computedKey] 按对象键读,委托 _object_get 冷分支调陷阱。
        vm.cmpImm(VReg.V0, 8);
        vm.jeq("_subscript_get_object");

        // 字符串：str[i] 返回单字符（TYPE_STRING=6）
        vm.cmpImm(VReg.V0, 6);
        vm.jeq("_subscript_get_string");

        // 数组/TypedArray：把键归一化为整数下标
        // （float64 位 -> fcvtzs；tagged -> payload；裸整数直通）
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_syscall_arg");
        vm.mov(VReg.S1, VReg.RET);

        // x64 上 V0≡RET≡RAX，_syscall_arg 的返回值把类型标签冲掉了；
        // 从仍然有效的 S3(=完整类型) 重取低 8 位。arm64(V0=X8) 保持不变。
        if (vm.backend.name === "x64") {
            vm.andImm(VReg.V0, VReg.S3, 0xff);
        }

        // 检查是否是 TypedArray (类型 0x40-0x70)
        vm.cmpImm(VReg.V0, 0x40);
        vm.jlt("_subscript_get_array"); // 小于 0x40，是普通 Array

        // ========== TypedArray 路径 ==========
        // [Design A] 元素基址改用 data_ptr(内联/buffer 视图统一)。既有寻址用 base+16,
        // 故置 S0 = data_ptr - 16,令后续 base+16 恰读 data_ptr。S2 随后被各分支覆写。
        vm.load(VReg.S2, VReg.S0, 16);
        vm.subImm(VReg.S0, VReg.S2, 16);
        // 根据类型选择元素大小和加载方式

        // Int8Array (0x40)
        vm.cmpImm(VReg.V0, TYPE_INT8_ARRAY);
        vm.jne("_subscript_get_check_int16");
        vm.add(VReg.V1, VReg.S0, VReg.S1); // arr + index (1 byte per elem)
        vm.loadByte(VReg.S2, VReg.V1, 16);
        // 符号扩展: 如果 bit7 为 1，则高位填 1
        vm.andImm(VReg.V2, VReg.S2, 0x80);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_subscript_get_int8_pos");
        vm.movImm(VReg.V2, -256);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.label("_subscript_get_int8_pos");
        vm.movImm(VReg.S4, NUM_INT8);
        vm.jmp("_subscript_get_box_int");

        // Int16Array (0x41) - 暂时当 2 字节处理
        vm.label("_subscript_get_check_int16");
        vm.cmpImm(VReg.V0, TYPE_INT16_ARRAY);
        vm.jne("_subscript_get_check_int32");
        vm.shl(VReg.V1, VReg.S1, 1); // index * 2
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        // 加载 2 字节 (低字节 + 高字节)
        vm.loadByte(VReg.S2, VReg.V1, 16);
        vm.loadByte(VReg.V2, VReg.V1, 17);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        // 符号扩展
        vm.andImm(VReg.V2, VReg.S2, 0x8000);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_subscript_get_int16_pos");
        vm.movImm(VReg.V2, -65536);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.label("_subscript_get_int16_pos");
        vm.movImm(VReg.S4, NUM_INT16);
        vm.jmp("_subscript_get_box_int");

        // Int32Array (0x42) - 加载 4 字节
        vm.label("_subscript_get_check_int32");
        vm.cmpImm(VReg.V0, TYPE_INT32_ARRAY);
        vm.jne("_subscript_get_check_int64");
        vm.shl(VReg.V1, VReg.S1, 2); // index * 4
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        // 加载 4 字节 (little-endian)
        vm.loadByte(VReg.S2, VReg.V1, 16);
        vm.loadByte(VReg.V2, VReg.V1, 17);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V1, 18);
        vm.shl(VReg.V2, VReg.V2, 16);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V1, 19);
        vm.shl(VReg.V2, VReg.V2, 24);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        // 32 位符号扩展到 64 位
        vm.andImm(VReg.V2, VReg.S2, 0x80000000);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_subscript_get_int32_pos");
        vm.movImm(VReg.V2, 0xffffffff);
        vm.shl(VReg.V2, VReg.V2, 32);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.label("_subscript_get_int32_pos");
        vm.movImm(VReg.S4, NUM_INT32);
        vm.jmp("_subscript_get_box_int");

        // Int64Array / BigInt64Array (0x43)
        vm.label("_subscript_get_check_int64");
        vm.cmpImm(VReg.V0, TYPE_INT64_ARRAY);
        vm.jne("_subscript_get_check_uint8");
        vm.shl(VReg.V1, VReg.S1, 3); // index * 8
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.load(VReg.S2, VReg.V1, 16);
        vm.movImm(VReg.S4, NUM_INT64);
        vm.jmp("_subscript_get_box_int");

        // Uint8Array (0x50)
        vm.label("_subscript_get_check_uint8");
        vm.cmpImm(VReg.V0, TYPE_UINT8_ARRAY);
        vm.jne("_subscript_get_check_uint16");
        vm.add(VReg.V1, VReg.S0, VReg.S1);
        vm.loadByte(VReg.S2, VReg.V1, 16);
        // loadByte 已经是零扩展
        vm.movImm(VReg.S4, NUM_UINT8);
        vm.jmp("_subscript_get_box_int");

        // Uint16Array (0x51)
        vm.label("_subscript_get_check_uint16");
        vm.cmpImm(VReg.V0, TYPE_UINT16_ARRAY);
        vm.jne("_subscript_get_check_uint32");
        vm.shl(VReg.V1, VReg.S1, 1);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.S2, VReg.V1, 16);
        vm.loadByte(VReg.V2, VReg.V1, 17);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.movImm(VReg.S4, NUM_UINT16);
        vm.jmp("_subscript_get_box_int");

        // Uint32Array (0x52)
        vm.label("_subscript_get_check_uint32");
        vm.cmpImm(VReg.V0, TYPE_UINT32_ARRAY);
        vm.jne("_subscript_get_check_uint64");
        vm.shl(VReg.V1, VReg.S1, 2);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.S2, VReg.V1, 16);
        vm.loadByte(VReg.V2, VReg.V1, 17);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V1, 18);
        vm.shl(VReg.V2, VReg.V2, 16);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V1, 19);
        vm.shl(VReg.V2, VReg.V2, 24);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        // Uint32 自动零扩展到 64 位
        vm.movImm(VReg.S4, NUM_UINT32);
        vm.jmp("_subscript_get_box_int");

        // Uint64Array / BigUint64Array (0x53)
        vm.label("_subscript_get_check_uint64");
        vm.cmpImm(VReg.V0, TYPE_UINT64_ARRAY);
        vm.jne("_subscript_get_check_uint8c");
        vm.shl(VReg.V1, VReg.S1, 3);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.load(VReg.S2, VReg.V1, 16);
        vm.movImm(VReg.S4, NUM_UINT64);
        vm.jmp("_subscript_get_box_int");

        // Uint8ClampedArray (0x54)
        vm.label("_subscript_get_check_uint8c");
        vm.cmpImm(VReg.V0, TYPE_UINT8_CLAMPED_ARRAY);
        vm.jne("_subscript_get_check_float32");
        vm.add(VReg.V1, VReg.S0, VReg.S1);
        vm.loadByte(VReg.S2, VReg.V1, 16);
        vm.movImm(VReg.S4, NUM_UINT8_CLAMPED);
        vm.jmp("_subscript_get_box_int");

        // Float32Array (0x60) - 加载 4 字节并转换
        vm.label("_subscript_get_check_float32");
        vm.cmpImm(VReg.V0, TYPE_FLOAT32_ARRAY);
        vm.jne("_subscript_get_float64");
        vm.shl(VReg.V1, VReg.S1, 2);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        // 加载 4 字节 float32 位模式
        vm.loadByte(VReg.S2, VReg.V1, 16);
        vm.loadByte(VReg.V2, VReg.V1, 17);
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V1, 18);
        vm.shl(VReg.V2, VReg.V2, 16);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V1, 19);
        vm.shl(VReg.V2, VReg.V2, 24);
        vm.or(VReg.S2, VReg.S2, VReg.V2);
        // 使用浮点指令转换 float32 -> float64
        // 将 32 位值移到浮点寄存器，转换，再移回
        vm.fmovToFloatSingle(0, VReg.S2);
        vm.fcvts2d(0, 0); // single to double
        vm.fmovToInt(VReg.S2, 0);
        vm.movImm(VReg.S4, NUM_FLOAT32);
        vm.jmp("_subscript_get_box_float");

        // Float64Array (0x61) - 默认
        vm.label("_subscript_get_float64");
        vm.shl(VReg.V1, VReg.S1, 3);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.load(VReg.S2, VReg.V1, 16);
        vm.movImm(VReg.S4, NUM_FLOAT64);
        vm.jmp("_subscript_get_box_float");

        // Box 整数类型 - 将 raw int 转为 float64 位模式再存储
        vm.label("_subscript_get_box_int");
        // TypedArray 整数元素:转 float64 位后**直接返回 canonical 裸 float64**(NaN-boxing
        // 数字表示,同 _typed_array_get)。原实现分配堆 Number(type@0/value@8)但布局与
        // 消费者(typeof/+/*/print 按 block-16 取类型)不一致 → ta[i] 算术/打印全返垃圾
        // (既有 bug)。裸 float64 无需堆分配,所有数字消费路径天然正确。
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.RET, 0); // RET = float64 位 = canonical JS number
        vm.jmp("_subscript_get_done");

        // TypedArray 浮点元素:S2 已是 float64 位,直接作 canonical 裸 float64 返回
        vm.label("_subscript_get_box_float");
        vm.mov(VReg.RET, VReg.S2);
        vm.jmp("_subscript_get_done");

        // ========== Array 路径 ==========
        // Array 结构: [type:8, length:8, capacity:8, elem0, elem1, ...]
        // 偏移 = 24 + index * 8
        vm.label("_subscript_get_object");
        // [#39] 数值键规范化(o[1] ≡ o["1"],node 语义:对象键恒为字符串)。
        // 字符串键 tag 判别直通(快路零调用);其余交 _js_prop_key 转十进制字符串。
        // _js_prop_key 保 S0-S4(本函数 S0/S1 安全跨越),冲 S5。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_subscript_get_obj_key_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_subscript_get_obj_key_ok");
        // 对象键查找：_object_get(裸对象, 规范化键 JSValue)，命中 getter 自动调用
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        vm.label("_subscript_get_string");
        // str[i]：键归一化为整数下标，调 _str_charAt（S0 是裸堆字符串指针）
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_syscall_arg");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_charAt");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        vm.label("_subscript_get_array");
        // [bug A] 边界检查:index<0 或 >=length → tagged undefined(node 语义;
        // 此前直接越界读堆邻居,`while((v=a[i++])!==undefined)` 垃圾值/死循环)
        vm.load(VReg.V2, VReg.S0, 8); // length
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_subscript_get_arr_oob");
        vm.cmp(VReg.S1, VReg.V2);
        vm.jge("_subscript_get_arr_oob");
        // 元素地址: data_ptr(@24) + index * 8
        vm.load(VReg.V0, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V1, VReg.S1, 3);
        vm.add(VReg.V1, VReg.V0, VReg.V1);
        vm.load(VReg.RET, VReg.V1, 0);

        vm.label("_subscript_get_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
        vm.label("_subscript_get_arr_oob");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        // [fn props] 闭包属性侧表读:f[sym]/f[k]。键经 _js_prop_key 规范化(symbol/数值
        // 与 f.x 写侧同键形),miss 返 undefined。S0=裸闭包,S1=原键。
        vm.label("_subscript_get_closure");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_prop_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        // null/undefined 基对象:把键规范化为字符串后交给 _throw_read_nullish
        // 构造 `Cannot read properties of null|undefined (reading '<k>')` 并 unwind。
        // A0=base(null/undefined), S1=原始键(任意值)。不返回。
        vm.label("_subscript_get_nullish");
        vm.mov(VReg.S0, VReg.A0); // 保住 base 跨 _valueToStr
        vm.mov(VReg.A0, VReg.S1); // 键 -> 字符串(供 message)
        vm.call("_valueToStr");
        vm.mov(VReg.A1, VReg.RET); // 键字符串
        vm.mov(VReg.A0, VReg.S0);  // base
        vm.call("_throw_read_nullish"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64); // 理论不达
    }

    // _subscript_set(arr, index, value)
    // 根据数组类型选择正确的赋值方式
    // 注意: arr 是 boxed JSValue，需要先 unbox
    // value 保持 boxed JSValue 形式存储
    generateSet() {
        const vm = this.vm;

        vm.label("_subscript_set");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器,老容器记入记忆集;分代 GC 已是缺省)

        // 保存 value (JSValue) 到 S2
        vm.mov(VReg.S2, VReg.A2); // value

        // unbox arr: A0 = arr JSValue -> RET = unboxed pointer
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET); // S0 = unboxed array pointer

        vm.mov(VReg.S1, VReg.A1); // S1 = index

        // 加载类型标签 (从 unboxed 指针)
        vm.load(VReg.V0, VReg.S0, 0);
        // [fn props] 闭包(magic 全字 0xc105/0xa51c)→ 闭包属性侧表写(f[sym]=v;低字节 5
        // 与 TYPE_SET 撞,须查全字,先于低字节分派)。
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_subscript_set_closure");
        vm.movImm(VReg.V1, 0xa51c);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_subscript_set_closure");
        vm.andImm(VReg.V0, VReg.V0, 0xff); // 取低 8 位

        // 对象：按键写属性（obj[key] = value）
        vm.cmpImm(VReg.V0, 2); // TYPE_OBJECT
        vm.jeq("_subscript_set_object");
        // classinfo(TYPE_FUNCTION=3):类对象是属性容器,Class[key]=v 按对象键写(同 _subscript_get)。
        // 闭包(magic 低字节 5)不匹配 3,不受影响。
        vm.cmpImm(VReg.V0, 3);
        vm.jeq("_subscript_set_object");
        // Proxy(TYPE_PROXY=8):proxy[computedKey]=v 委托 _object_set 冷分支调 set 陷阱。
        vm.cmpImm(VReg.V0, 8);
        vm.jeq("_subscript_set_object");

        // 数组/TypedArray：把键归一化为整数下标
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_syscall_arg");
        vm.mov(VReg.S1, VReg.RET);

        // x64 上 V0≡RET≡RAX，_syscall_arg 的返回值把类型标签冲掉了；
        // 从仍然有效的 S0(=裸数组指针) 重取类型标签。arm64(V0=X8) 保持不变。
        if (vm.backend.name === "x64") {
            vm.load(VReg.V0, VReg.S0, 0);
            vm.andImm(VReg.V0, VReg.V0, 0xff);
        }

        // 检查是否是 TypedArray (类型 0x40-0x70)
        vm.cmpImm(VReg.V0, 0x40);
        vm.jlt("_subscript_set_array"); // 小于 0x40，是普通 Array

        // TypedArray 路径 - 调用 _typed_array_set 来处理 unboxing
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_typed_array_set");
        vm.jmp("_subscript_set_done");

        // 对象路径
        vm.label("_subscript_set_object");
        // [#39] 数值键规范化(同 _subscript_get_object):字符串键直通,其余转字符串
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_subscript_set_obj_key_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_subscript_set_obj_key_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_subscript_set_array");
        // Array 结构: [type@0, length@8, capacity@16, data_ptr@24] + 独立 data 区。
        // 下标写：index>=capacity 时通过 _array_ensure_cap 原地扩容 data 区
        //（数组头指针不变，复制旧元素、空档补 0），彻底消除越界野写。
        // 负索引 / 异常巨大下标（可能是损坏值或对象式数字键）跳过，防止 OOM。
        // 上限 2^28(268M 元素/~2GB data)：给编译器 this.code 字节缓冲留足头room——
        // 旧的 2^24(16M) 帽会把 __text≥16M 时的 fixup 写(this.code[offset]=byte)静默
        // 丢弃，尾部指令留占位符 bl<self> 死循环 → gen2 挂(16MB self-host cliff 根因)。
        // 仍拦截真正损坏的巨大下标(2^28–2^48)避免 OOM。movImm 仍是单条 MOVZ，不增码。
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_subscript_set_done");
        vm.movImm(VReg.V0, 0x10000000); // 256M 上限(2^28)
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_subscript_set_done");
        // 确保容量 index+1（S0/S1/S2 均为本函数 callee-saved，跨调用保留）
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S1, 1);
        vm.call("_array_ensure_cap");
        // index >= length：逻辑空档 [old_len, index) 须填 **JS_UNDEFINED**(非 0)。
        // _array_ensure_cap 只把容量区补 0；若不覆盖逻辑空档,`a[6]=v`(a 原长 3)后
        // a[4]/a[5] 读作 0(typeof "number"、===undefined 假、join 显 "0" 而非空)。
        // 与 _js_set_length 的 undefined 填空一致。index < length(覆盖已有槽)无空档。
        vm.load(VReg.V3, VReg.S0, 8); // old length
        vm.cmp(VReg.S1, VReg.V3);
        vm.jlt("_sss_no_gap");
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.movImm64(VReg.V4, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.mov(VReg.V2, VReg.V3); // cursor = old_len
        vm.label("_sss_gap_loop");
        vm.cmp(VReg.V2, VReg.S1);
        vm.jge("_sss_gap_done");
        vm.shl(VReg.V0, VReg.V2, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.store(VReg.V0, 0, VReg.V4); // arr[cursor] = undefined
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_sss_gap_loop");
        vm.label("_sss_gap_done");
        // 更新 length = index + 1
        vm.addImm(VReg.V0, VReg.S1, 1);
        vm.store(VReg.S0, 8, VReg.V0);
        vm.label("_sss_no_gap");
        // 存 value 到 index（元素地址 = data_ptr(@24) + index * 8）
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr（增长后可能已更新）
        vm.shl(VReg.V0, VReg.S1, 3); // index * 8
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.store(VReg.V0, 0, VReg.S2);

        vm.label("_subscript_set_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // [fn props] 闭包属性侧表写:f[sym]=v / f[k]=v。键经 _js_prop_key 规范化,
        // 值写入 _closure_prop_set(登记/复用 props 容器)。S0=裸闭包,S1=键,S2=值。
        vm.label("_subscript_set_closure");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET); // 规范化键
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_set");
        vm.mov(VReg.RET, VReg.S2); // 赋值表达式之值
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    generate() {
        this.generateGet();
        this.generateSet();
        this.generateJsLength();
        this.generateJsSetLength();
    }

    // _js_set_length(value, n_int) -> undefined
    // [#63] arr.length = N 的赋值路径。运行时按值形态分派：
    //   - 数组(装箱 0x7FFE / 裸 TYPE_ARRAY=1)：N<=len 截断(只改长度域,余量保留),
    //     N>len 经 _array_ensure_cap 扩容后把 [len,N) 填 JS_UNDEFINED,再置长度=N。
    //   - 其余(对象等)：回退设 "length" 属性(值转 JS number)。
    // 原先 arr.length=N 一律走 _object_set_ic 把数组当哈希对象写坏 → 段错误(#63 变体)。
    generateJsSetLength() {
        const vm = this.vm;
        const JS_UNDEFINED = 0x7ffb000000000000n;

        vm.label("_js_set_length");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // n (裸整数)

        // 按值形态判定是否为数组，取裸数组头到 S0
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);        // 装箱数组
        vm.jeq("_js_set_length_arr_boxed");
        vm.cmpImm(VReg.V0, 0);             // 非 0 高位且非数组箱 → 非数组
        vm.jne("_js_set_length_fallback");
        // 高位为 0：可能是裸堆指针
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_js_set_length_done");     // 空指针：无操作
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.A0, VReg.V0);
        vm.jlt("_js_set_length_fallback");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.A0, VReg.V0);
        vm.jge("_js_set_length_fallback");
        vm.load(VReg.V0, VReg.A0, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 1);             // TYPE_ARRAY
        vm.jne("_js_set_length_fallback");
        vm.mov(VReg.S0, VReg.A0);
        vm.jmp("_js_set_length_do_array");

        vm.label("_js_set_length_arr_boxed");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1);

        vm.label("_js_set_length_do_array");
        vm.load(VReg.V0, VReg.S0, 8);      // 当前 length
        vm.cmp(VReg.S1, VReg.V0);
        vm.jle("_js_set_length_set");      // n <= len：仅截断
        // n > len：扩容到 n，并把 [len, n) 填 undefined
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_ensure_cap");
        vm.load(VReg.V0, VReg.S0, 8);      // len(未变)
        vm.load(VReg.V1, VReg.S0, 24);     // data_ptr(扩容后可能变化)
        vm.movImm64(VReg.V4, JS_UNDEFINED);
        vm.label("_js_set_length_fill");
        vm.cmp(VReg.V0, VReg.S1);
        vm.jge("_js_set_length_set");
        vm.shl(VReg.V2, VReg.V0, 3);
        vm.add(VReg.V3, VReg.V1, VReg.V2);
        vm.store(VReg.V3, 0, VReg.V4);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_js_set_length_fill");

        vm.label("_js_set_length_set");
        vm.store(VReg.S0, 8, VReg.S1);     // length = n

        vm.label("_js_set_length_done");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // 回退：对象.length = n，设 "length" 属性(n 转 JS number)
        vm.label("_js_set_length_fallback");
        vm.scvtf(0, VReg.S1);              // int -> float
        vm.fmovToInt(VReg.A2, 0);          // A2 = number 值(float64 位)
        vm.lea(VReg.V0, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1);  // 装箱字符串键 "length"
        vm.call("_object_set");            // A0=对象(原值,未改),A1=键,A2=值
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _js_length(value) -> 原始整数长度
    // 运行时按值形态分派：数组 -> _array_length，TypedArray -> _typed_array_length，
    // 其余（字符串/未知）-> _str_length
    generateJsLength() {
        const vm = this.vm;

        vm.label("_js_length");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        // 装箱数组 0x7FFE
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_js_length_array_boxed");
        // 装箱字符串 0x7FFC
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_js_length_str");
        // 装箱对象 0x7FFD：读其 "length" 属性（如 Buffer 的 this.length）
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_js_length_object");
        // 裸堆指针：按头部类型分派
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_js_length_str");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_js_length_zero");
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_js_length_str");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_js_length_str");
        // 堆指针：先判是否堆字符串（block 头 [S0-16] 低字节 == 6 = TYPE_STRING）。
        // 字符串把 type 存 block+0（writeStringHeader RMW），数组/对象把 type 标记存 user+0；
        // _alloc 给非字符串块的 block+0 低字节是 (class<<6)&0xff ∈ {0,0x40,0x80,0xC0}，绝不为 6，
        // 故此判定唯一识别堆字符串。若不先查 block 头而读 [S0+0]，会把未装箱字符串(tag 丢失、
        // typeof number)的 content 首字节(如 'd'=0x64)误当类型落入 typed-array 区间 [0x40,0x70]
        // → _typed_array_length 读 content 偏移 8 当长度 → 巨型垃圾长度（自举 finalize 里
        // "darwin-arm64" 等 >=8 字节串致 UTF-8 编码循环失控、2GB 分配、崩溃的根因）。
        vm.load(VReg.V0, VReg.S0, -16);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 6); // TYPE_STRING
        vm.jeq("_js_length_str");
        vm.load(VReg.V0, VReg.S0, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jeq("_js_length_array_raw");
        vm.cmpImm(VReg.V0, 2); // TYPE_OBJECT：裸对象指针，读 "length" 属性
        vm.jeq("_js_length_object");
        vm.cmpImm(VReg.V0, 0x40); // TypedArray 类型区间 [0x40, 0x70]
        vm.jlt("_js_length_str");
        vm.cmpImm(VReg.V0, 0x70);
        vm.jgt("_js_length_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_js_length_array_boxed");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.label("_js_length_array_raw");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_js_length_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_length");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_js_length_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // 对象：读 "length" 属性（S0 = 值，装箱 0x7FFD 或裸对象指针）→ 转原始整数
        vm.label("_js_length_object");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.V0, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1); // 装箱字符串键
        vm.call("_object_get"); // RET = length 属性值（JSValue）
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_number_coerce"); // RET = float64 位
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.RET, 0); // 原始整数
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }
}
