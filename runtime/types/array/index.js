// asm.js 数组运行时
// 提供数组操作函数
//
// 数组内存布局（元素区独立分配，数组头指针稳定、可原地增长）:
//   offset 0:  type (8 bytes) - TYPE_ARRAY = 1
//   offset 8:  length (8 bytes) - 当前元素数量
//   offset 16: capacity (8 bytes) - data 区当前可容纳的元素数
//   offset 24: data_ptr (8 bytes) - 指向独立分配的元素数组，元素 i 在 [data_ptr + i*8]
//
// 增长：length>=capacity 时另分配 2*capacity 的 data 区、拷贝旧元素、
//   更新 capacity+data_ptr。数组头地址不变，故所有持有该数组指针的
//   别名（跨函数参数、装箱变量、闭包捕获等）都看到增长后的元素与长度。
//
// 最小容量: MIN_CAPACITY = 8
// 扩容策略: newCap = oldCap * 2

import { VReg } from "../../../vm/registers.js";
import { TYPE_STRING, HEADER_SIZE } from "../../core/allocator.js";

const ARRAY_HEADER_SIZE = 32; // type + length + capacity + data_ptr
const ARRAY_MIN_CAPACITY = 8;

export class ArrayGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    // 确保 data 区容量 >= needed，不足则重分配 data 区并拷贝旧元素。
    // 数组头指针保持不变（只更新头中的 capacity@16 与 data_ptr@24）。
    // _array_ensure_cap(raw_arr_ptr, needed)
    generateArrayEnsureCap() {
        const vm = this.vm;

        vm.label("_array_ensure_cap");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S0, VReg.A0); // 数组头（裸指针）
        vm.mov(VReg.S1, VReg.A1); // needed

        vm.load(VReg.V0, VReg.S0, 16); // capacity
        vm.cmp(VReg.V0, VReg.S1);
        vm.jge("_array_ensure_cap_done"); // cap >= needed，无需增长

        // newCap = cap * 2
        vm.shl(VReg.S2, VReg.V0, 1);
        // newCap < needed → newCap = needed
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_array_ensure_cap_min");
        vm.mov(VReg.S2, VReg.S1);
        vm.label("_array_ensure_cap_min");
        // newCap < MIN → newCap = MIN
        vm.movImm(VReg.V0, ARRAY_MIN_CAPACITY);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_array_ensure_cap_alloc");
        vm.mov(VReg.S2, VReg.V0);

        vm.label("_array_ensure_cap_alloc");
        // [ALLOC_DBG] 巨型增长 dump：newCap*8 > 1GB 时打印数组头，定位是 length/capacity 被冲还是 arr 指针错。
        if (process.env.ALLOC_DBG) {
            vm.shl(VReg.V0, VReg.S2, 3);
            vm.movImm64(VReg.V1, 0x40000000n);
            vm.cmp(VReg.V0, VReg.V1);
            vm.jle("_array_ensure_cap_dbgok");
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S1);
            vm.call("_array_dbg_report");
            vm.label("_array_ensure_cap_dbgok");
        }
        // 分配新 data 区: newCap * 8
        vm.shl(VReg.A0, VReg.S2, 3);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // 新 data 区

        // 拷贝旧元素（length 个）: 旧 data_ptr@24 → 新 data 区
        vm.load(VReg.S4, VReg.S0, 24); // 旧 data_ptr
        vm.load(VReg.V0, VReg.S0, 8);  // length
        vm.movImm(VReg.V1, 0);         // i
        vm.label("_array_ensure_cap_copy");
        vm.cmp(VReg.V1, VReg.V0);
        vm.jge("_array_ensure_cap_copied");
        vm.shl(VReg.V2, VReg.V1, 3);
        vm.add(VReg.V3, VReg.S4, VReg.V2);
        vm.load(VReg.V4, VReg.V3, 0);
        vm.add(VReg.V3, VReg.S3, VReg.V2);
        vm.store(VReg.V3, 0, VReg.V4);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_array_ensure_cap_copy");

        vm.label("_array_ensure_cap_copied");
        // 零填充 [length, newCap)（V1 现等于 length）
        vm.label("_array_ensure_cap_zero");
        vm.cmp(VReg.V1, VReg.S2);
        vm.jge("_array_ensure_cap_zdone");
        vm.shl(VReg.V2, VReg.V1, 3);
        vm.add(VReg.V3, VReg.S3, VReg.V2);
        vm.movImm(VReg.V4, 0);
        vm.store(VReg.V3, 0, VReg.V4);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_array_ensure_cap_zero");

        vm.label("_array_ensure_cap_zdone");
        // 更新数组头（头地址不变）
        vm.store(VReg.S0, 16, VReg.S2); // capacity
        vm.store(VReg.S0, 24, VReg.S3); // data_ptr

        vm.label("_array_ensure_cap_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
    }

    // 数组 push（原地增长，数组头指针不变）
    // _array_push(arr, value) -> 同一数组 JSValue（保留原 tag，兼容旧调用点）
    generateArrayPush() {
        const vm = this.vm;

        vm.label("_array_push");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器,老容器记入记忆集;分代 GC 已是缺省)

        vm.mov(VReg.S2, VReg.A0); // 原始 JSValue（保留 tag）
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = 数组头（裸指针）
        vm.mov(VReg.S1, VReg.A1); // value

        // 确保容量 length+1（不足则原地增长 data 区）
        vm.load(VReg.V0, VReg.S0, 8); // length
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.V0, 1);
        vm.call("_array_ensure_cap");

        // +0.0 → 装箱 int0(与 hole 哨兵 0 区分);-0 保留
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_array_push_store");
        vm.movImm64(VReg.S1, 0x7ff8000000000000n);
        vm.label("_array_push_store");

        // oldLen;跨 setter 保活
        vm.load(VReg.V0, VReg.S0, 8);
        vm.store(VReg.SP, 0, VReg.V0);

        // [L2] Array.prototype 数值索引访问器(push mid-freeze/nonwritable 簇):
        // 命中 setter → 分派且不建 own;未命中 → 稠密写。仅 push 冷查,不税下标热路径。
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_array_push_dense");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_object_get"); // 返 TYPE_GETTER 标记块(不调 getter)
        vm.mov(VReg.V0, VReg.RET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_array_push_dense");
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_array_push_dense");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_array_push_dense");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_array_push_dense");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 60); // TYPE_GETTER
        vm.jne("_array_push_dense");
        vm.load(VReg.V0, VReg.V0, 16); // setter
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_array_push_after_elem"); // set:undefined → 不写 own
        vm.mov(VReg.A5, VReg.S2); // this = 原装箱数组
        vm.mov(VReg.A0, VReg.S1); // value
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_array_push_acc_call");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_array_push_acc_call");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_array_push_acc_cl");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jne("_array_push_acc_call");
        vm.label("_array_push_acc_cl");
        vm.store(VReg.SP, 8, VReg.S0); // 保 arr(oldLen 在 SP+0)
        vm.mov(VReg.S0, VReg.V0);
        vm.load(VReg.V0, VReg.S0, 8);
        vm.setCallArgcImm(1, VReg.V1, VReg.V2);
        vm.callIndirect(VReg.V0);
        vm.load(VReg.S0, VReg.SP, 8);
        vm.jmp("_array_push_after_elem");
        vm.label("_array_push_acc_call");
        vm.setCallArgcImm(1, VReg.V1, VReg.V2);
        vm.callIndirect(VReg.V0);
        vm.jmp("_array_push_after_elem");

        vm.label("_array_push_dense");
        vm.load(VReg.V0, VReg.SP, 0);  // oldLen
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V2, VReg.V0, 3);
        vm.add(VReg.V2, VReg.V1, VReg.V2);
        vm.store(VReg.V2, 0, VReg.S1); // data[length] = value

        vm.label("_array_push_after_elem");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        // Set(O,"length",newLen,true):frozen/non-writable → TypeError
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_array_setlength_throw");

        // 返回同一数组头，保留原 JSValue 的高 16 位 tag
        vm.movImm64(VReg.V4, 0xffff000000000000n);
        vm.and(VReg.V4, VReg.S2, VReg.V4);
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.RET, VReg.S0, VReg.V5);
        vm.or(VReg.RET, VReg.RET, VReg.V4);

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // 数组 pop
    // _array_pop(arr) -> value
    // ES: Get(O, len-1)(含原型链) → DeleteProperty → Set(length,len-1,true)。
    generateArrayPop() {
        const vm = this.vm;

        vm.label("_array_pop");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S2, VReg.A0); // 装箱数组(跨 Get)
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = 裸头

        vm.load(VReg.S1, VReg.S0, 8); // length
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_pop_empty");

        vm.subImm(VReg.S1, VReg.S1, 1); // idx = len-1
        // Get(O, idx) 含 Array.prototype 继承(不可只读稠密槽)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 0, VReg.RET); // 保返回值

        // Delete own index → 写 hole(侧表 delete 忽略;稠密槽清 0)
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.load(VReg.V2, VReg.S0, 16); // capacity
        vm.cmp(VReg.S1, VReg.V2);
        vm.jge("_array_pop_setlen"); // 稀疏超 capacity:无稠密槽
        vm.shl(VReg.V0, VReg.S1, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1); // hole

        vm.label("_array_pop_setlen");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_setlength_throw"); // Set(length, idx, true)
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        vm.label("_array_pop_empty");
        // ES:len==0 → Set(O,"length",+0,true) 后返 undefined(frozen → TypeError)
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_setlength_throw");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // _array_setlength_throw(A0=装箱/裸数组, A1=裸新长度):Set(O,"length",n,true)。
    // ARR_LEN_NONWRITABLE(byte1 bit0,freeze/define writable:false) → TypeError;否则写 length@8。
    generateArraySetLengthThrow() {
        const vm = this.vm;
        vm.label("_array_setlength_throw");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // n
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // 裸头
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, 1); // ARR_LEN_NONWRITABLE
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_aslt_ok");
        vm.lea(VReg.A0, vm.asm.addString("Cannot assign to read only property 'length'"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.label("_aslt_ok");
        vm.store(VReg.S0, 8, VReg.S1);
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 数组 get
    // _array_get(arr, index) -> value
    generateArrayGet() {
        const vm = this.vm;

        vm.label("_array_get");
        vm.prologue(0, [VReg.S0]);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr

        // [bug A] 边界检查:index<0 或 >=length → tagged undefined(node 语义;
        // 此前直接越界读堆邻居——`while((v=a[i++])!==undefined)` 垃圾值/死循环根因)
        vm.load(VReg.V2, VReg.S0, 8); // length
        vm.cmpImm(VReg.A1, 0);
        vm.jlt("_array_get_oob");
        vm.cmp(VReg.A1, VReg.V2);
        vm.jge("_array_get_oob");

        // 元素地址: data_ptr + index * 8
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V0, VReg.A1, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.RET, VReg.V0, 0);
        // 真 hole:槽==0 → Array.prototype [[Get]];装箱 int0(规范化后的 +0)→ 浮点 0
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_array_get_proto");
        vm.movImm64(VReg.V1, 0x7ff8000000000000n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_array_get_done");
        vm.movImm(VReg.RET, 0); // float +0.0
        vm.label("_array_get_done");
        vm.epilogue([VReg.S0], 0);
        vm.label("_array_get_oob");
        // >=length / <0:仍可能命中原型(仅 <0 直接 undefined)
        vm.cmpImm(VReg.A1, 0);
        vm.jlt("_array_get_undef");
        vm.label("_array_get_proto");
        // A0 可能已是裸/装箱;统一经 _agen_get_idx 走完整 Get(含原型)
        // 但 _array_get 常被内部以裸+裸 index 调用——改用内联原型读避免递归。
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_array_get_undef");
        vm.push(VReg.A0); // 保 receiver
        vm.push(VReg.A1); // 保 index
        vm.scvtf(0, VReg.A1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.pop(VReg.A1); // index (discard for getter this)
        vm.pop(VReg.V1); // receiver
        // this = 装箱数组
        vm.shrImm(VReg.V2, VReg.V1, 48);
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_array_get_proto_this");
        vm.movImm64(VReg.V2, 0x7ffe000000000000n);
        vm.or(VReg.V1, VReg.V1, VReg.V2);
        vm.label("_array_get_proto_this");
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0], 0);
        vm.label("_array_get_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.epilogue([VReg.S0], 0);
    }

    // 数组 set
    // _array_set(arr, index, value)
    generateArraySet() {
        const vm = this.vm;

        vm.label("_array_set");
        vm.prologue(0, [VReg.S0]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器,老容器记入记忆集;分代 GC 已是缺省)

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr

        // +0.0(全零位)与 hole 哨兵 0 同位 → 规范为装箱 int0;-0 保留(0x8000…)
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_array_set_store");
        vm.movImm64(VReg.A2, 0x7ff8000000000000n);
        vm.label("_array_set_store");

        // 元素地址: data_ptr + index * 8
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V0, VReg.A1, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.store(VReg.V0, 0, VReg.A2);

        vm.epilogue([VReg.S0], 0);
    }

    // 数组长度
    // _array_length(arr) -> length
    generateArrayLength() {
        const vm = this.vm;

        vm.label("_array_length");
        vm.prologue(0, []);

        vm.movImm64(VReg.V4, 0x0000ffffffffffffn);
        vm.and(VReg.V4, VReg.A0, VReg.V4); // V4 = arr unboxed
        vm.load(VReg.RET, VReg.V4, 8);

        vm.epilogue([], 0);
    }

    // 数组 at (支持负索引)
    // _array_at(arr, index) -> value
    generateArrayAt() {
        const vm = this.vm;

        vm.label("_array_at");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr
        vm.mov(VReg.S1, VReg.A1); // index

        // 获取长度
        vm.load(VReg.V0, VReg.S0, 8);

        // 检查索引是否为负
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_array_at_positive");

        // 负索引: index = length + index
        vm.add(VReg.S1, VReg.V0, VReg.S1);

        vm.label("_array_at_positive");
        // 检查边界: index < 0 || index >= length
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_array_at_undefined");
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_array_at_undefined");

        // 元素地址: data_ptr + index * 8
        vm.load(VReg.V0, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V1, VReg.S1, 3);
        vm.add(VReg.V1, VReg.V0, VReg.V1);
        vm.load(VReg.RET, VReg.V1, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_array_at_undefined"); // hole → undefined
        vm.movImm64(VReg.V0, 0x7ff8000000000000n);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jne("_array_at_done");
        vm.movImm(VReg.RET, 0); // 装箱 int0 → float +0
        vm.label("_array_at_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        vm.label("_array_at_undefined");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // tagged undefined(此前裸 0 → 越界打印 0)
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 数组 indexOf
    // _array_indexOf(arr, value) -> index or -1
    // 支持 Number 对象的值比较和原始 float64 直接比较
    generateArrayIndexOf() {
        const vm = this.vm;
        const TYPE_INT8 = 20;
        const TYPE_FLOAT64 = 29;

        vm.label("_array_indexOf");
        // (arr, value, fromIndex_raw) -> index or -1。A2=裸 int 起始下标,调用点必须显式置。
        // 注意:编译器 indexOf 快路先 `_js_unbox` 再调本 helper → A0 可能是裸指针。
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S4, VReg.A0); // arr(可能裸/装箱)
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_array_indexOf_have_box");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S4, VReg.S4, VReg.V1); // 裸 → 装箱,供 `_agen_has/get_idx`
        vm.label("_array_indexOf_have_box");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S4, VReg.V4); // S0 = arr raw(长度)
        vm.mov(VReg.S1, VReg.A1); // value to find
        vm.mov(VReg.S2, VReg.A2); // i = fromIndex(入口即捕获;x64 V2 别名 A2,须在 V2 使用前)

        // 搜索值是 NaN → 恒 -1(indexOf 用 ===,NaN 不等于任何值含自身;includes 才用 SameValueZero)。
        // NaN 判据:高16==0x7FF0(标识符 NaN 区,排 NaN-box tag ≥0x7FF8)且低 48 位非 0(排 +Inf)。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FF0);
        vm.jne("_array_indexOf_not_nan_search");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.S1, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_array_indexOf_notfound"); // 尾数非0 → NaN → -1
        vm.label("_array_indexOf_not_nan_search");

        // 获取长度
        vm.load(VReg.S3, VReg.S0, 8);

        // 负 fromIndex: i = max(length + fromIndex, 0)(JS 语义)
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_array_indexOf_from_ok");
        vm.add(VReg.S2, VReg.S3, VReg.S2);
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_array_indexOf_from_ok");
        vm.movImm(VReg.S2, 0);
        vm.label("_array_indexOf_from_ok");

        vm.label("_array_indexOf_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_array_indexOf_notfound");

        // HasProperty+Get 活读(继承 hole / own accessor)
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_array_indexOf_next");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_get_idx");
        vm.mov(VReg.V1, VReg.RET);

        // 第一步：直接指针比较(快路:interned 串/同 bits/同指针)
        vm.cmp(VReg.V1, VReg.S1);
        vm.jeq("_array_indexOf_found");

        // 第二步:=== 语义严格相等。
        vm.mov(VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1); // JS_TRUE 低位=1
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_array_indexOf_found");

        vm.label("_array_indexOf_next");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_array_indexOf_loop");

        vm.label("_array_indexOf_found");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        vm.label("_array_indexOf_notfound");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // 数组 lastIndexOf
    // _array_lastIndexOf(arr, value) -> 最后匹配下标 or -1（从末尾向前扫）
    // 值比较逻辑同 indexOf(裸指针相等 + Number 对象数值相等);此前无此运行时,
    // 数组字面量 .lastIndexOf 静态判定为数组 → 调 _array_lastIndexOf 链接期崩。
    generateArrayLastIndexOf() {
        const vm = this.vm;
        const TYPE_INT8 = 20;
        const TYPE_FLOAT64 = 29;

        vm.label("_array_lastIndexOf");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S4, VReg.A0); // arr(可能裸/装箱;编译器同 indexOf 会先 unbox)
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_array_lastIndexOf_have_box");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S4, VReg.S4, VReg.V1);
        vm.label("_array_lastIndexOf_have_box");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S4, VReg.V4); // S0 = arr raw
        vm.mov(VReg.S1, VReg.A1);          // value
        vm.load(VReg.S3, VReg.S0, 8);      // len
        // i = 起始下标:A2=fromIndex(负→len+from;钳到 [.., len-1];INT_MAX 哨兵→len-1)。
        vm.mov(VReg.S2, VReg.A2);
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_array_lastIndexOf_clamp_hi");
        vm.add(VReg.S2, VReg.S2, VReg.S3);  // 负:len + fromIndex
        vm.label("_array_lastIndexOf_clamp_hi");
        vm.subImm(VReg.V0, VReg.S3, 1);     // len - 1
        vm.cmp(VReg.S2, VReg.V0);
        vm.jle("_array_lastIndexOf_start");
        vm.mov(VReg.S2, VReg.V0);           // 钳到 len-1
        vm.label("_array_lastIndexOf_start");

        vm.label("_array_lastIndexOf_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jlt("_array_lastIndexOf_notfound"); // i < 0

        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_array_lastIndexOf_next");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_get_idx");
        vm.mov(VReg.V1, VReg.RET);

        vm.cmp(VReg.V1, VReg.S1);          // 快路:指针相等
        vm.jeq("_array_lastIndexOf_found");

        // === 语义严格相等(串按内容,split/动态串指针各异须内容比)。同 _array_indexOf。
        vm.mov(VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_array_lastIndexOf_found");

        vm.label("_array_lastIndexOf_next");
        vm.subImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_array_lastIndexOf_loop");

        vm.label("_array_lastIndexOf_found");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        vm.label("_array_lastIndexOf_notfound");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // 数组 includes
    // _array_includes(arr, value) -> 0 or 1
    // 支持 Number 对象的值比较和原始 float64 直接比较
    generateArrayIncludes() {
        const vm = this.vm;
        const TYPE_INT8 = 20;
        const TYPE_FLOAT64 = 29;

        vm.label("_array_includes");
        // (arr, value, fromIndex_raw) -> 0/1。A2=裸 int 起始下标,调用点必须显式置。
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr
        vm.mov(VReg.S1, VReg.A1); // value to find
        vm.mov(VReg.S2, VReg.A2); // i = fromIndex(入口即捕获;x64 V2 别名 A2,须在 V2 使用前)

        // 获取长度
        vm.load(VReg.S3, VReg.S0, 8);

        // 负 fromIndex: i = max(length + fromIndex, 0)(JS 语义,与 indexOf 一致)
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_array_includes_from_ok");
        vm.add(VReg.S2, VReg.S3, VReg.S2);
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_array_includes_from_ok");
        vm.movImm(VReg.S2, 0);
        vm.label("_array_includes_from_ok");

        // 预先检查 value 是否是 Number 对象
        vm.movImm(VReg.S4, 0); // S4 = 0 表示未知/原始值类型
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_includes_loop");
        // 检查是否是原始 float64（非 NaN-boxing）
        vm.shrImm(VReg.V0, VReg.S1, 48); // V0 = 高 16 位
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_array_includes_loop"); // 原始 float，使用直接比较
        // 字符串（0x7FFC）：走内容比较循环，绝不能当 Number 对象解引用
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_array_includes_str_loop");
        // tagged（含 int32 tag 0x7FF8 本身）都不是裸堆 Number 对象——jge 让 0x7FF8(int32)
        // 也走直接比较循环，否则会落到下面 load[S1,0] 把装箱 int32 当指针解引用崩。
        // （裸堆指针 Number 对象 high16=0，已在上面 jlt 分流到 loop，不经此处。）
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jge("_array_includes_loop");
        // 否则尝试作为 Number 对象处理（裸堆指针）
        vm.load(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, TYPE_INT8);
        vm.jlt("_array_includes_loop");
        vm.cmpImm(VReg.V0, TYPE_FLOAT64);
        vm.jgt("_array_includes_loop");
        vm.load(VReg.S4, VReg.S1, 8); // S4 = Number 对象的值

        vm.label("_array_includes_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_array_includes_false");

        // 元素地址: data_ptr + i * 8
        vm.load(VReg.V0, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V1, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V1, VReg.V0, 0);

        // [hole] 槽 0 = 逻辑洞;Get 得 undefined。includes 用 SameValueZero(Get(k), search)
        // → `[,,,].includes(undefined)===true`(写路径已把 +0 规范为装箱 int0,洞≠真 0)。
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_array_includes_have");
        vm.movImm64(VReg.V1, 0x7ffb000000000000n); // undefined
        vm.label("_array_includes_have");

        // 直接指针比较(含 hole→undefined 与 search===undefined)
        vm.cmp(VReg.V1, VReg.S1);
        vm.jeq("_array_includes_true");

        // Number 值比较（S4 != 0 表示 search value 是 Number 对象）
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_array_includes_next");
        // hole 已归一为 undefined,不再当裸指针解引用
        vm.shrImm(VReg.V2, VReg.V1, 48);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_array_includes_next");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.cmpImm(VReg.V2, TYPE_INT8);
        vm.jlt("_array_includes_next");
        vm.cmpImm(VReg.V2, TYPE_FLOAT64);
        vm.jgt("_array_includes_next");
        vm.load(VReg.V3, VReg.V1, 8);
        vm.cmp(VReg.V3, VReg.S4);
        vm.jeq("_array_includes_true");

        vm.label("_array_includes_next");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_array_includes_loop");

        vm.label("_array_includes_true");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // 字符串搜索：逐元素用 _object_key_eq（内容比较，兼容驻留/堆串）
        vm.label("_array_includes_str_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_array_includes_false");
        vm.load(VReg.V0, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V1, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.A0, VReg.V0, 0); // 元素
        // 只对字符串元素比较（高16位 0x7FFC）
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_array_includes_str_next");
        vm.mov(VReg.A1, VReg.S1);
        vm.push(VReg.S2); vm.push(VReg.S3);
        vm.call("_object_key_eq"); // RET = 0/1（内容相等）
        vm.pop(VReg.S3); vm.pop(VReg.S2);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_array_includes_true");
        vm.label("_array_includes_str_next");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_array_includes_str_loop");

        vm.label("_array_includes_false");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // 数组 slice (简化版)
    // _array_slice(arr, start, end) -> new array
    // end = -1 表示到末尾
    generateArraySlice() {
        const vm = this.vm;

        vm.label("_array_slice");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr (unbox)
        vm.mov(VReg.S1, VReg.A1); // start
        vm.mov(VReg.S2, VReg.A2); // end

        // 核心修复: 对 start 和 end 进行 unbox (如果是 JSValue)
        const checkEnd = "_array_slice_unbox_end";
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.movImm(VReg.V1, 0x7ff8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne(checkEnd);
        vm.and(VReg.S1, VReg.S1, VReg.V4); // unbox start

        vm.label(checkEnd);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_array_slice_check_default");
        vm.and(VReg.S2, VReg.S2, VReg.V4); // unbox end

        vm.label("_array_slice_check_default");
        // 获取原数组长度 (在 S0+8)
        vm.load(VReg.V0, VReg.S0, 8);

        // 负 start 归一化: start < 0 → max(length + start, 0)。
        // 此前不处理 → arr.slice(-2) 从 arr[-2] 起复制 → 头部乱码 + 长度算错。
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_array_slice_start_ok");
        vm.add(VReg.S1, VReg.V0, VReg.S1); // length + start
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_array_slice_start_ok");
        vm.movImm(VReg.S1, 0);
        vm.label("_array_slice_start_ok");

        // end 归一:<0 → max(len+end, 0);否则 min(end, len)(V0=length)。
        // 此前只把 -1 当"到末尾"哨兵、无负 end 归一 → slice(0,-2) 算成负 newLen 得空、
        // slice(x,-1) 误当"到末尾"。改:负 end 按 len+end,"到末尾"哨兵改用 INT_MAX
        // (>=len → clamp 到 len),二者不再冲突。
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_array_slice_end_upper");
        vm.add(VReg.S2, VReg.V0, VReg.S2); // len + end
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_array_slice_calc");
        vm.movImm(VReg.S2, 0);
        vm.jmp("_array_slice_calc");
        vm.label("_array_slice_end_upper");
        vm.cmp(VReg.S2, VReg.V0);
        vm.jle("_array_slice_calc");
        vm.mov(VReg.S2, VReg.V0); // clamp to len(含 INT_MAX 到末尾哨兵)

        vm.label("_array_slice_calc");
        // 计算新数组长度: newLen = end - start
        vm.sub(VReg.S3, VReg.S2, VReg.S1); // S3 = newLen

        // 边界保护: 确保 newLen 在合理范围内 [0, 1M]
        vm.cmpImm(VReg.S3, 0);
        vm.jle("_array_slice_empty");

        vm.movImm(VReg.V0, 1024 * 1024);
        vm.cmp(VReg.S3, VReg.V0);
        vm.jgt("_array_slice_empty"); // 防护异常计算

        // 用运行时封装创建新数组（自动分配头 + data 区、length=newLen）
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S4, VReg.RET); // S4 = 新数组头（裸指针）

        // 复制元素，用 S2 作为循环变量 (原 end 不再需要)
        vm.movImm(VReg.S2, 0); // i = 0
        vm.label("_array_slice_copy");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_array_slice_done");

        // src: src_data_ptr + (start + i) * 8
        vm.load(VReg.V0, VReg.S0, 24); // src data_ptr
        vm.add(VReg.V1, VReg.S1, VReg.S2);
        vm.shl(VReg.V1, VReg.V1, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0); // V2 = src element

        // dst: new_data_ptr + i * 8
        vm.load(VReg.V0, VReg.S4, 24); // new data_ptr
        vm.shl(VReg.V1, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.V0, 0, VReg.V2);

        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_array_slice_copy");

        vm.label("_array_slice_done");
        // 返回 NaN-boxed 指针
        vm.mov(VReg.RET, VReg.S4);
        vm.movImm64(VReg.V4, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V4);
        vm.movImm64(VReg.V4, 0x7FFE000000000000n); // TAG_ARRAY_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);

        // 空数组
        vm.label("_array_slice_empty");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        // 返回 NaN-boxed 指针
        vm.movImm64(VReg.V4, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.RET, VReg.RET, VReg.V4);
        vm.movImm64(VReg.V4, 0x7FFE000000000000n); // TAG_ARRAY_BASE
        vm.or(VReg.RET, VReg.RET, VReg.V4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);
    }

    // [#73b] arr.with(idx, val) 非破坏更新
    // _array_with(A0=arr boxed, A1=idx int, A2=val) -> boxed 新数组
    // 全拷贝(_array_slice 0..end)→ 归一负 idx → copy[idx]=val → 返回副本。
    // 越界不抛 RangeError(直接写,值域内的 idx 无碍;记偏差)。
    generateArrayWith() {
        const vm = this.vm;

        vm.label("_array_with");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = 裸原数组
        vm.mov(VReg.S1, VReg.A1);          // S1 = idx
        vm.mov(VReg.S2, VReg.A2);          // S2 = val

        // 归一负 idx: idx<0 → idx+length
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_array_with_pos");
        vm.load(VReg.V0, VReg.S0, 8);      // length
        vm.add(VReg.S1, VReg.S1, VReg.V0);
        vm.label("_array_with_pos");

        // 全拷贝(_array_slice 返回 boxed 0x7FFE,S0-S3 由其 prologue 保活)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.movImm(VReg.A2, 2147483647);
        vm.call("_array_slice");
        vm.mov(VReg.S3, VReg.RET);         // S3 = 副本(boxed)

        // copy[idx] = val（_array_set 自行 mask,接受 boxed）
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_array_set");

        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
    }

    // 创建指定大小的数组
    // [底层A] _array_ctor_call - 裸 `Array` 作值调用(如 `var A=Array; A(3)`)。
    // 规范:Array(...) 无 new 合法(数字=长度/元素表)。本入口保守抛 "requires 'new'"
    // (同 Map/Set 模式)——`Array(...)`/`new Array(...)` 语法快路先命中不经此;值路径
    // 调用属边缘用例,列偏差。
    generateArrayCtorCall() {
        const vm = this.vm;
        vm.label("_array_ctor_call");
        vm.prologue(16, [VReg.S0]);
        vm.lea(VReg.A0, vm.asm.addString("Constructor Array requires 'new'"));
        vm.call("_js_box_string");      // RET = 装箱堆串
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error");   // 不返回
        vm.epilogue([VReg.S0], 16);     // 理论不达
    }

    // _array_new_with_size(size) -> array (裸数组头指针)
    // 数组布局: [type(8), length(8), capacity(8), data_ptr(8)] + 独立 data 区
    generateArrayNewWithSize() {
        const vm = this.vm;

        vm.label("_array_new_with_size");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // size (初始长度)

        // 计算实际容量: max(size, MIN_CAPACITY)
        vm.movImm(VReg.S3, ARRAY_MIN_CAPACITY);
        vm.cmp(VReg.S0, VReg.S3);
        vm.jlt("_array_new_cap_done"); // size < MIN → capacity = MIN
        vm.mov(VReg.S3, VReg.S0);       // capacity = size
        vm.label("_array_new_cap_done");

        // 分配数组头（32 字节）
        vm.movImm(VReg.A0, ARRAY_HEADER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET); // S1 = 数组头

        // 分配 data 区（capacity * 8）
        vm.shl(VReg.A0, VReg.S3, 3);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET); // S2 = data 区

        // 写入头字段
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.S1, 0, VReg.V0);   // type = TYPE_ARRAY
        vm.store(VReg.S1, 8, VReg.S0);   // length = size
        vm.store(VReg.S1, 16, VReg.S3);  // capacity
        vm.store(VReg.S1, 24, VReg.S2);  // data_ptr

        // 初始化 data 区所有元素为 0 (undefined)，遍历到 capacity
        vm.movImm(VReg.V1, 0); // counter
        vm.label("_array_new_init_loop");
        vm.cmp(VReg.V1, VReg.S3);
        vm.jge("_array_new_init_done");
        vm.shl(VReg.V2, VReg.V1, 3);
        vm.add(VReg.V2, VReg.S2, VReg.V2);
        vm.movImm(VReg.V3, 0);
        vm.store(VReg.V2, 0, VReg.V3);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_array_new_init_loop");

        vm.label("_array_new_init_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // _array_new_undefined(A0 = 长度 len) -> 装箱数组,len 个装箱 undefined(0x7FFB)。
        // Array.from({length:N}) 用:此前非数组输入脱糖 [...x],array-like {length} 非可迭代 → 空。
        // 负 len 钳 0。fill 循环无调用,array 指针在 S0 跨循环稳定,无 GC 顾虑。
        vm.label("_array_new_undefined");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0);           // len
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_anu_len_ok");
        vm.movImm(VReg.S1, 0);
        vm.label("_anu_len_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_new_with_size");    // RET = 裸数组头(data 已置 0)
        vm.mov(VReg.S0, VReg.RET);          // S0 = 裸数组指针
        vm.load(VReg.V2, VReg.S0, 24);      // V2 = data_ptr
        vm.movImm(VReg.V1, 0);              // i
        vm.movImm64(VReg.V4, 0x7ffb000000000000n); // undefined
        vm.label("_anu_fill");
        vm.cmp(VReg.V1, VReg.S1);
        vm.jge("_anu_done");
        vm.shl(VReg.V3, VReg.V1, 3);
        vm.add(VReg.V3, VReg.V2, VReg.V3);
        vm.store(VReg.V3, 0, VReg.V4);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_anu_fill");
        vm.label("_anu_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n); // 装箱数组 tag
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // 数组 toString - 将数组转换为字符串（元素用 "," 连接）
    // _array_to_string(arr) -> str
    // 注意：返回的是堆上的新字符串，不是数据段指针
    generateArrayToString() {
        const vm = this.vm;

        vm.label("_array_to_string");
        // [#46] 委托给寄存器安全的 _array_join(A0, ",")。
        // 旧实现把结果缓冲区留在 S4、循环索引留在 S3,跨每个元素的 _valueToStr 调用——
        // 但 _valueToStr 只保存 S0-S2、其内部 _alloc 只保存 S0-S3,S4(及 S3)会被 clobber
        // → 缓冲区基址丢失,String([...]).length==0、嵌套数组元素渲染空(#46)。
        // _array_join 已在内层 _valueToStr/_js_box_string 调用前后 push/pop S3/S4,是唯一
        // 寄存器安全的元素序列化路径;嵌套数组元素经 _valueToStr→_array_to_string 递归
        // 自然终止(标量元素不再递归)。A0 可为 boxed 或裸数组指针(_array_join 自行 mask
        // 低48)。此处未建 prologue → tail-jmp:_array_join 自建栈帧并直接返回本函数调用者。
        vm.lea(VReg.A1, "_str_comma_only");
        vm.jmp("_array_join");

        // ==== 以下为旧的自建缓冲实现,已不可达(tail-jmp 上方)。保留以最小化 diff。 ====
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        // A0 是 JSValue (boxed array pointer)，需要解包
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // S0 = 原始数组指针

        // 获取数组长度
        vm.load(VReg.S1, VReg.S0, 8); // S1 = length

        // 处理空数组的情况 - 直接返回空字符串
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_to_string_empty");

        // 分配结果字符串的临时缓冲区
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.V0, 12);
        vm.mul(VReg.A0, VReg.A0, VReg.V0);
        vm.addImm(VReg.A0, VReg.A0, 32); // 16(header) + estimated content
        vm.call("_alloc");
        vm.mov(VReg.S4, VReg.RET); // S4 = 结果缓冲区起始 (block + 16)

        // S2 = 当前写入位置 (从内容区开始, S4 = block + 16)
        vm.mov(VReg.S2, VReg.S4);
        // S3 = 元素索引
        vm.movImm(VReg.S3, 0);

        // 跳到循环开始处理元素
        vm.jmp("_array_to_string_loop");

        const loopLabel = "_array_to_string_loop";
        const endLabel = "_array_to_string_end";
        const skipCommaLabel = "_array_to_string_skip_comma";

        vm.label(loopLabel);
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge(endLabel);

        // 如果不是第一个元素，先写 ","
        vm.cmpImm(VReg.S3, 0);
        vm.jeq(skipCommaLabel);
        vm.movImm(VReg.V0, 44); // ','
        vm.storeByte(VReg.S2, 0, VReg.V0);
        vm.addImm(VReg.S2, VReg.S2, 1);

        vm.label(skipCommaLabel);
        // 获取元素: arr[index] = *(data_ptr + index * 8)
        vm.load(VReg.V0, VReg.S0, 24); // data_ptr
        vm.mov(VReg.V1, VReg.S3);
        vm.shl(VReg.V1, VReg.V1, 3); // index * 8
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.A0, VReg.V0, 0); // A0 = 元素值

        // [array join/toString 语义] null(0x7FFA)/undefined(0x7FFB) 元素渲染为空串
        // (逗号已在上方写入,跳过元素内容即得 "1,,2")。此前走 _valueToStr → "null"/"undefined"。
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_array_to_string_skip_elem");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_array_to_string_skip_elem");

        // 检查是否是JSValue（高16位 >= 0x7FF8）
        // JSValue需要特殊处理：调用 _valueToStr 转换
        vm.shrImm(VReg.V1, VReg.A0, 48); // V1 = 高16位
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jge("_array_to_string_jsvalue");

        // 高16位 < 0x7FF8：不是JSValue，可能是原始float或数据段指针
        // 先检查是否是数据段字符串指针 (地址在 0x100008000 - 0x100108000 范围内)
        vm.movImm(VReg.V1, 0x100008000);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jlt("_array_to_string_float");  // < 0x100008000，不是数据段字符串
        vm.addImm(VReg.V1, VReg.V1, 0x100000); // V1 = 0x100108000
        vm.cmp(VReg.A0, VReg.V1);
        vm.jge("_array_to_string_float");  // >= 0x100108000，不是数据段字符串
        // 是数据段字符串指针：调用 _valueToStr 进行转换
        vm.call("_valueToStr");
        // RET = 元素字符串指针（NaN-boxed JS字符串）
        // 跳转到公共处理逻辑进行解包
        vm.jmp("_array_to_string_jsvalue_unbox");

        // 原始float处理：最短往返 _floatToString(A0=raw f64 位 → 装箱串);
        // 曾用 fcvtzs+_intToStr 截整数(0.1→"0"、大数饱和)。
        vm.label("_array_to_string_float");
        vm.call("_floatToString");
        // RET = NaN-boxed JS string pointer
        // 需要解包并加16得到content指针
        vm.shrImm(VReg.V1, VReg.RET, 48);  // V1 = 高16位
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_array_to_string_int_check_other");
        // 是堆字符串：解包并加16得到content指针
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.addImm(VReg.RET, VReg.RET, 16);
        vm.jmp("_array_to_string_str_ready");
        // 其他类型（不应发生）
        vm.label("_array_to_string_int_check_other");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.addImm(VReg.RET, VReg.RET, 16);
        vm.jmp("_array_to_string_str_ready");

        // JSValue 或堆对象处理：调用 _valueToStr
        vm.label("_array_to_string_jsvalue");
        vm.call("_valueToStr");
        // RET = 元素字符串指针（可能是 NaN-boxed JS字符串）
        vm.label("_array_to_string_jsvalue_unbox");
        // 解包：检查 boxed 值的高 16 位来确定类型
        vm.shrImm(VReg.V1, VReg.RET, 48);  // V1 = 高16位
        // 0x7FFC = 堆字符串 tag
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_array_to_string_jsvalue_check_data");
        // 是堆字符串：_valueToStr已经返回content指针（unboxed user_ptr），不需要偏移
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.jmp("_array_to_string_str_ready");
        // 0x7FFD = 数据段字符串 tag（已经是content指针，不需要加偏移）
        vm.label("_array_to_string_jsvalue_check_data");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_array_to_string_jsvalue_check_other");
        // 是数据段字符串：解包
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.jmp("_array_to_string_str_ready");
        // 其他类型：直接解包
        vm.label("_array_to_string_jsvalue_check_other");
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_array_to_string_str_ready");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);

        vm.label("_array_to_string_str_ready");

        // 将元素字符串复制到结果缓冲区
        // 先保存字符串指针，因为 _strlen 会覆盖 RET
        vm.mov(VReg.V1, VReg.RET); // V1 = 源指针（保存）
        // 调用 _strlen 获取元素字符串长度
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strlen");
        // V0 = 元素字符串长度

        // 复制元素字符串到结果缓冲区
        const copyLoopLabel = "_array_to_string_copy_loop";
        const copyDoneLabel = "_array_to_string_copy_done";
        vm.mov(VReg.V2, VReg.S2);   // V2 = 目标指针
        vm.movImm(VReg.V3, 0);       // V3 = 计数器

        vm.label(copyLoopLabel);
        vm.cmp(VReg.V3, VReg.V0);
        vm.jge(copyDoneLabel);
        vm.loadByte(VReg.V4, VReg.V1, 0);
        vm.storeByte(VReg.V2, 0, VReg.V4);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp(copyLoopLabel);

        vm.label(copyDoneLabel);
        // 更新写入位置
        vm.add(VReg.S2, VReg.S2, VReg.V0);

        // null/undefined 元素跳到此:不写内容(逗号已写),直接进下一元素
        vm.label("_array_to_string_skip_elem");
        // 索引加 1
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp(loopLabel);

        vm.label(endLabel);
        // 写入字符串结束符
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S2, 0, VReg.V0);

        // 保存 S4 到 S0（因为 _strlen 会覆盖某些寄存器）
        vm.mov(VReg.S0, VReg.S4);  // S0 = S4 = 内容起始位置
        // 调用 _strlen
        vm.mov(VReg.A0, VReg.S4); // A0 = 内容起始位置
        vm.call("_strlen");       // RET = 实际长度
        vm.mov(VReg.S1, VReg.RET); // S1 = 长度(V0==RET 于 x64,写头运算会覆盖,先存 S1)

        // 设置 string 对象头: block = S0 - 16
        // 只改最低字节写 type，保留高位 size/class 与 bit15(mark)（GC sweep 靠 size 走块）
        vm.subImm(VReg.V1, VReg.S0, 16);  // V1 = block
        vm.load(VReg.V0, VReg.V1, 0);
        vm.movImm64(VReg.V2, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V2);
        vm.movImm(VReg.V2, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V2);
        vm.store(VReg.V1, 0, VReg.V0);     // *(block + 0) = type（保 size）
        // length @ block+8:此前算了长度却从未写入 → _strlen 快路径(信任 type=6 的头)
        // 会读到 _alloc 残留垃圾。慢路径时代无害,快路径必须补上。
        vm.store(VReg.V1, 8, VReg.S1);

        // 返回 NaN-boxed **content 指针**（堆字符串装箱约定:payload 即 content 指针,
        // 头在 -16/-8）。原先返回 block 指针 → 消费方按 content 读会跳过 16 字节头 →
        // String([...])/嵌套数组元素渲染空(#46)。S0 此刻 = content(=S4=block+16)。
        vm.mov(VReg.RET, VReg.S0);  // RET = content 指针
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);  // RET = content & mask
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);   // RET = (content & mask) | tag
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
        // epilogue 生成 ret，所以永远不会执行到这里

        // 空数组返回空字符串（返回正确的字符串对象）
        vm.label("_array_to_string_empty");
        // 分配字符串对象: HEADER_SIZE(16) + 1(内容) = 17, 对齐到8字节 = 24
        vm.movImm(VReg.A0, HEADER_SIZE + 1);
        vm.call("_alloc");
        // 检查分配是否成功
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_array_to_string_empty_fail");
        // RET = user_ptr = block + 16
        // 需要在 block + 0 存储 type, block + 8 存储 length, block + 16 存储内容
        // 保存 user_ptr 到 S0（因为后续操作会用到 V0/V1）
        vm.mov(VReg.S0, VReg.RET);  // S0 = user_ptr
        vm.subImm(VReg.V1, VReg.RET, HEADER_SIZE);  // V1 = block = user_ptr - 16
        // 只改最低字节写 type，保留高位 size/class 与 bit15(mark)（GC sweep 靠 size 走块）
        vm.load(VReg.V0, VReg.V1, 0);
        vm.movImm64(VReg.V2, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V2);
        vm.movImm(VReg.V2, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V2);
        vm.store(VReg.V1, 0, VReg.V0);     // *(block + 0) = type（保 size）
        vm.movImm(VReg.V0, 0);             // V0 = 0 (length) - 注意：会覆盖RET，但S0已保存
        vm.store(VReg.V1, 8, VReg.V0);     // *(block + 8) = length
        vm.storeByte(VReg.S0, 0, VReg.V0); // *(user_ptr + 0) = null terminator
        // 返回 NaN-boxed **content 指针**（S0 = user_ptr = block+16,与主路径一致约定）
        vm.mov(VReg.RET, VReg.S0);  // RET = content 指针
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);  // RET = content & mask
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);   // RET = (content & mask) | tag
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        vm.label("_array_to_string_empty_fail");
        // 分配失败，返回空指针
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
        // 注意：epilogue 生成 ret，所以永远不会执行到这里
    }

    // 数组连接（用于实现 spread [...arr]）
    // _array_concat(target, source) -> target
    generateArrayConcat() {
        const vm = this.vm;

        vm.label("_array_concat");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // target (JSValue)
        vm.mov(VReg.S1, VReg.A1); // source (JSValue)

        // 解包 source 获取长度
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S2, VReg.S1, VReg.V4); // S2 = source ptr
        vm.load(VReg.S3, VReg.S2, 8); // S3 = source length

        // 遍历并 push
        vm.movImm(VReg.S2, 0); // index = 0
        const loopLabel = "_array_concat_loop";
        const doneLabel = "_array_concat_done";

        vm.label(loopLabel);
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge(doneLabel);

        // 获取元素: _array_get(source, index)
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_get");

        // push 到目标: _array_push(target, value)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.RET);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET); // 更新 target (指针稳定，但保留返回值)

        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp(loopLabel);

        vm.label(doneLabel);
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // 数组 join - arr.join(sep) -> 装箱字符串
    // A0 = 装箱数组, A1 = 分隔符（装箱字符串）
    generateArrayJoin() {
        const vm = this.vm;

        vm.label("_array_join");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        // ES:separator undefined → ","。另:_array_to_string 等入口 lea 裸
        // _str_comma_only(高16=0),须装箱 0x7FFC,否则 _strconcat 把裸指针当非串 → 空结果
        // (fixture builtin-statics map(Object.keys).join 回归)。
        // 保 recv 于栈(勿仅靠 S0:sep ToString 链可能毁 callee-saved 约定外的暂存)
        vm.store(VReg.SP, 40, VReg.A0);
        vm.shrImm(VReg.V0, VReg.A1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_array_join_sep_comma");
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_array_join_sep_ready");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_array_join_sep_tostr");
        vm.cmpImm(VReg.A1, 0);
        vm.jeq("_array_join_sep_comma");
        // 裸数据段/堆串指针 → 装箱
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.jmp("_array_join_sep_ready");
        vm.label("_array_join_sep_tostr");
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");
        vm.mov(VReg.A1, VReg.RET);
        vm.jmp("_array_join_sep_ready");
        vm.label("_array_join_sep_comma");
        vm.lea(VReg.A1, "_str_comma_only");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.label("_array_join_sep_ready");
        vm.load(VReg.A0, VReg.SP, 40); // 恢复 recv
        // _array_to_string 可能传入裸数组指针(高16=0);_agen_* 要装箱 0x7FFE
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_array_join_recv_ok");
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_array_join_recv_ok");
        vm.movImm64(VReg.V0, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V0);
        vm.label("_array_join_recv_ok");
        vm.mov(VReg.S3, VReg.A0); // boxed recv(跨 Get)
        vm.mov(VReg.S1, VReg.A1); // boxed sep
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET); // length (ToLength)
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_array_join_empty");
        // elem[0] via Get(含原型);null/undefined → 空串
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_arr_elem_boxed_str");
        vm.store(VReg.SP, 0, VReg.RET); // acc
        vm.movImm(VReg.S4, 1);
        vm.label("_array_join_loop");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_array_join_done");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strconcat");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.push(VReg.S4);
        vm.call("_arr_elem_boxed_str");
        vm.pop(VReg.S4);
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_strconcat");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_array_join_loop");
        vm.label("_array_join_done");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        vm.label("_array_join_empty");
        vm.lea(VReg.A0, "_str_empty");
        vm.call("_js_box_string");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        // 元素值 → 装箱字符串;null(0x7FFA)/undefined(0x7FFB) → 空串(Array join 语义)。
        // 洞 Get 已得 undefined;装箱 int0 → _valueToStr → "0"。
        vm.label("_arr_elem_boxed_str");
        vm.prologue(16, []);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_arr_elem_boxed_str_empty");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_arr_elem_boxed_str_empty");
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");
        vm.epilogue([], 16);
        vm.label("_arr_elem_boxed_str_empty");
        vm.lea(VReg.A0, "_str_empty");
        vm.call("_js_box_string");
        vm.epilogue([], 16);
    }

    // 数组 reverse（原地反转，返回同一数组引用）
    // _array_reverse(arr) -> arr
    // 布局:脱壳 & 0x0000ffffffffffffn;length@8;data_ptr@24;元素 data_ptr+i*8
    generateArrayReverse() {
        const vm = this.vm;

        vm.label("_array_reverse");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr（脱壳）
        vm.load(VReg.S3, VReg.S0, 8);      // S3 = length
        vm.subImm(VReg.S3, VReg.S3, 1);    // j = length - 1
        vm.load(VReg.S1, VReg.S0, 24);     // S1 = data_ptr
        vm.movImm(VReg.S2, 0);             // i = 0

        vm.label("_array_reverse_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_array_reverse_done");     // i >= j -> 结束

        // addr_i = data_ptr + i*8
        vm.shl(VReg.V0, VReg.S2, 3);
        vm.add(VReg.V0, VReg.S1, VReg.V0);
        // addr_j = data_ptr + j*8
        vm.shl(VReg.V1, VReg.S3, 3);
        vm.add(VReg.V1, VReg.S1, VReg.V1);
        // 交换 mem[addr_i] 与 mem[addr_j]
        vm.load(VReg.S4, VReg.V0, 0);      // tmp_i
        vm.load(VReg.V2, VReg.V1, 0);      // tmp_j
        vm.store(VReg.V0, 0, VReg.V2);     // mem[addr_i] = tmp_j
        vm.store(VReg.V1, 0, VReg.S4);     // mem[addr_j] = tmp_i
        // i++, j--
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_array_reverse_loop");

        vm.label("_array_reverse_done");
        vm.mov(VReg.RET, VReg.A0);         // 返回装箱数组引用
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // Array.prototype.sort 运行时。编译器快路曾一次读 length 后冒泡,getter/setter
    // 改 length 时后续按下标野读 → SIGSEGV(precise-getter/setter-appends/pops)。
    // 此处每轮重读 length、取值/交换前做 j+1<live 检查;增长不追(以首次 length 封顶),
    // 避免 setter push 把冒泡变成无限扩容。比较语义对齐原快路:undefined 沉底,
    // 有 comparefn 则调用,否则 ToString+strcmp。
    // 读走稠密 _array_get:accessor getter 的 this 未装箱,`this.foo` 具名 miss
    // 在 L1 object 原型回落上 SIGSEGV。写走 _subscript_set 以触发 setter。
    // 真 hole/`in`/delete/accessor this 需 L1 object,本波不做。
    generateArraySort() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;

        // _asort_compare(A0=a, A1=b, A2=comparefn) -> RET 符号整数。
        // >0 表示 a 应排在 b 之后(冒泡交换)。comparefn===undefined → 默认字典序。
        vm.label("_asort_compare");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // a
        vm.mov(VReg.S1, VReg.A1); // b
        vm.mov(VReg.S2, VReg.A2); // comparefn
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_asort_a_def");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_asort_cmp_zero");
        vm.movImm(VReg.RET, 1); // a undefined, b 有值 → a 沉底
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_asort_cmp_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_asort_a_def");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_asort_both_def");
        vm.movImm(VReg.RET, -1); // b undefined → 保持在右
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_asort_both_def");
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_asort_dflt");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm64(VReg.A2, UNDEF);
        vm.mov(VReg.A3, VReg.S2);
        vm.call("_aref_invoke_cb");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_syscall_arg");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_asort_dflt");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");
        vm.store(VReg.SP, 0, VReg.RET); // sa(独立堆串,避免 _valueToStr 缓冲互覆)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.A1, VReg.RET, VReg.V4);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.andMaskReg(VReg.A0, VReg.V0, VReg.V4);
        vm.call("_strcmp");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        // _array_sort(A0=arr) / _array_sort_cmp(A0=arr, A1=comparefn) → arr
        vm.label("_array_sort");
        vm.movImm64(VReg.A1, UNDEF);
        vm.label("_array_sort_cmp");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // comparefn
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // initialLen(封顶,不追增长)
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_asort_cbok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length
        vm.label("_asort_cbok");
        vm.cmpImm(VReg.S2, 2);
        vm.jlt("_asort_done");
        vm.movImm(VReg.S3, 0); // i
        vm.label("_asort_outer");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S5, VReg.RET); // live
        vm.cmpImm(VReg.S5, 2);
        vm.jlt("_asort_done");
        vm.mov(VReg.V1, VReg.S5);
        vm.cmp(VReg.V1, VReg.S2);
        vm.jle("_asort_lim_ok");
        vm.mov(VReg.V1, VReg.S2);
        vm.label("_asort_lim_ok");
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jge("_asort_done");
        vm.movImm(VReg.S4, 0); // j
        vm.label("_asort_inner");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S5, VReg.RET);
        vm.addImm(VReg.V0, VReg.S4, 1);
        vm.cmp(VReg.V0, VReg.S5);
        vm.jge("_asort_inner_end");
        vm.cmp(VReg.V0, VReg.S2);
        vm.jge("_asort_inner_end");
        // 稠密 get:accessor 路径(_subscript_get→side_elem)会在 getter 里
        // `this.foo` 具名 miss 上 SIGSEGV(L1 object 原型回落未做)。P0 先停崩。
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.store(VReg.SP, 0, VReg.RET); // a
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S5, VReg.RET);
        vm.addImm(VReg.V0, VReg.S4, 1);
        vm.cmp(VReg.V0, VReg.S5);
        vm.jge("_asort_inner_end");
        vm.cmp(VReg.V0, VReg.S2);
        vm.jge("_asort_inner_end");
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S4, 1);
        vm.call("_array_get");
        vm.store(VReg.SP, 8, VReg.RET); // b
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_asort_compare");
        vm.cmpImm(VReg.RET, 0);
        vm.jle("_asort_noswap");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S5, VReg.RET);
        vm.addImm(VReg.V0, VReg.S4, 1);
        vm.cmp(VReg.V0, VReg.S5);
        vm.jge("_asort_inner_end");
        vm.cmp(VReg.V0, VReg.S2);
        vm.jge("_asort_inner_end");
        // 写走 _subscript_set:触发 setter(this.foo=v),否则测例事后读
        // array[2] getter 的 this.foo 具名 miss 仍 SIGSEGV。
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_subscript_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S5, VReg.RET);
        vm.addImm(VReg.V0, VReg.S4, 1);
        vm.cmp(VReg.V0, VReg.S5);
        vm.jge("_asort_inner_end");
        vm.cmp(VReg.V0, VReg.S2);
        vm.jge("_asort_inner_end");
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S4, 1);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.call("_subscript_set");
        vm.label("_asort_noswap");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_asort_inner");
        vm.label("_asort_inner_end");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_asort_done");
        vm.jmp("_asort_outer");
        vm.label("_asort_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
    }

    // _array_shift(A0 = boxed 数组) -> 移除并返回首元素(空则 undefined)。
    // ES:Get(0)(含原型) → 左移 Has/Get/Set/Delete → length--。
    // 不可密读 data[0]:装箱 int0 与字面 0(float) 位不等(S15.4.4.9_A1.2);洞须原型 Get(A4)。
    generateArrayShift() {
        const vm = this.vm;
        vm.label("_array_shift");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.A0); // boxed recv
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // 裸头
        vm.load(VReg.S1, VReg.S0, 8); // length
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_shift_empty");
        // first = Get(O, 0) —— 经 _agen_get_idx(洞→原型;装箱 int0→float +0)
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 0, VReg.RET); // 保 first
        // k = 1 .. len-1: Has(k)? Set(k-1, Get(k)) : Delete(k-1)
        vm.movImm(VReg.S2, 1);
        vm.label("_array_shift_loop");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_array_shift_tail");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_array_shift_del");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.subImm(VReg.A1, VReg.S2, 1);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_subscript_set");
        vm.jmp("_array_shift_next");
        vm.label("_array_shift_del");
        vm.subImm(VReg.A1, VReg.S2, 1);
        // 稠密洞:清槽 0;侧表经 _object_delete
        vm.load(VReg.V1, VReg.S0, 24);
        vm.load(VReg.V2, VReg.S0, 16); // capacity
        vm.subImm(VReg.V0, VReg.S2, 1);
        vm.cmp(VReg.V0, VReg.V2);
        vm.jge("_array_shift_del_side");
        vm.shl(VReg.V3, VReg.V0, 3);
        vm.add(VReg.V3, VReg.V1, VReg.V3);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V3, 0, VReg.V1);
        vm.label("_array_shift_del_side");
        vm.subImm(VReg.V0, VReg.S2, 1);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_object_delete");
        vm.label("_array_shift_next");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_array_shift_loop");
        vm.label("_array_shift_tail");
        // Delete(len-1)
        vm.subImm(VReg.S2, VReg.S1, 1);
        vm.load(VReg.V1, VReg.S0, 24);
        vm.load(VReg.V2, VReg.S0, 16);
        vm.cmp(VReg.S2, VReg.V2);
        vm.jge("_array_shift_tail_side");
        vm.shl(VReg.V0, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_array_shift_tail_side");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_object_delete");
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_setlength_throw"); // Set(length, len-1, true)
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_array_shift_empty");
        // ES:len==0 → Set(O,"length",+0,true) 后返 undefined(frozen → TypeError)
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_setlength_throw");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _array_unshift(A0 = boxed 数组, A1 = value) -> 新长度(JS number)。
    // ES:从高到低若 HasProperty(k-1) 则 Set(k, Get(k-1)) 否则 Delete(k);再 Set(0,value)。
    // +0 须规范为装箱 int0(不可写 hole 哨兵 0)。
    generateArrayUnshift() {
        const vm = this.vm;
        vm.label("_array_unshift");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.call("_gc_remember");
        vm.mov(VReg.S3, VReg.A0);          // S3 = boxed recv
        vm.mov(VReg.S2, VReg.A1);          // S2 = value
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_au_val_ok");
        vm.movImm64(VReg.S2, 0x7ff8000000000000n); // +0 → 装箱 int0(非 hole)
        vm.label("_au_val_ok");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S3, VReg.V4); // S0 = 裸头
        vm.load(VReg.S1, VReg.S0, 8);      // S1 = length
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S1, 1);
        vm.call("_array_ensure_cap");
        // i = length; while i >= 1
        vm.store(VReg.SP, 0, VReg.S1);
        vm.label("_au_loop");
        vm.load(VReg.V1, VReg.SP, 0); // i
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_au_insert");
        vm.subImm(VReg.A1, VReg.V1, 1); // from = i-1
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_au_del");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.subImm(VReg.A1, VReg.V1, 1);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 0); // to = i
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_set");
        vm.jmp("_au_next");
        vm.label("_au_del");
        // DeleteProperty(to=i):稠密槽写 hole
        vm.load(VReg.V1, VReg.SP, 0); // i
        vm.load(VReg.V0, VReg.S0, 16); // capacity
        vm.cmp(VReg.V1, VReg.V0);
        vm.jge("_au_next");
        vm.load(VReg.V0, VReg.S0, 24);
        vm.shl(VReg.V2, VReg.V1, 3);
        vm.add(VReg.V2, VReg.V0, VReg.V2);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V2, 0, VReg.V0);
        vm.label("_au_next");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.SP, 0, VReg.V1);
        vm.jmp("_au_loop");
        vm.label("_au_insert");
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_array_set");
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.store(VReg.S0, 8, VReg.S1);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _array_splice(A0=boxed arr, A1=start(raw int), A2=delCount(raw int),
    //               A3=boxed itemsArr) -> boxed removed 数组。原地:
    // removed=_array_slice(start,start+del);ensure_cap(newLen);尾段双向移位到
    // [start+itemsLen, newLen);拷 items 入 [start,start+itemsLen);length=newLen。
    // S0=raw arr / S1=start / S2=delCount / S3=raw itemsArr / S4=removed(持久),
    // len/itemsLen/data_ptr 按需从头 reload(减寄存器压力)。
    generateArraySplice() {
        const vm = this.vm;
        vm.label("_array_splice");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器;splice 把 young 插入项写入可能为 old 的数组)
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // raw arr
        vm.mov(VReg.S1, VReg.A1);          // start
        vm.mov(VReg.S2, VReg.A2);          // delCount
        vm.andMaskReg(VReg.S3, VReg.A3, VReg.V4); // raw itemsArr
        vm.load(VReg.V0, VReg.S0, 8);      // V0 = len
        // 规范化 start:负则 +len,钳 [0,len]
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_sp_start_pos");
        vm.add(VReg.S1, VReg.S1, VReg.V0);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_sp_start_clamped");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_sp_start_clamped");
        vm.label("_sp_start_pos");
        vm.cmp(VReg.S1, VReg.V0);
        vm.jle("_sp_start_clamped");
        vm.mov(VReg.S1, VReg.V0);
        vm.label("_sp_start_clamped");
        // 规范化 delCount:钳 [0, len-start]
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_sp_del_nonneg");
        vm.movImm(VReg.S2, 0);
        vm.label("_sp_del_nonneg");
        vm.sub(VReg.V1, VReg.V0, VReg.S1); // len-start
        vm.cmp(VReg.S2, VReg.V1);
        vm.jle("_sp_del_ok");
        vm.mov(VReg.S2, VReg.V1);
        vm.label("_sp_del_ok");
        // removed = _array_slice(boxed arr, start, start+del)
        vm.movImm64(VReg.V4, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V4);
        vm.mov(VReg.A1, VReg.S1);
        vm.add(VReg.A2, VReg.S1, VReg.S2);
        vm.call("_array_slice");
        vm.mov(VReg.S4, VReg.RET);         // S4 = removed(boxed)
        // ensure_cap(raw arr, newLen=len-del+itemsLen)
        vm.load(VReg.V0, VReg.S0, 8);      // len
        vm.load(VReg.V1, VReg.S3, 8);      // itemsLen
        vm.sub(VReg.V2, VReg.V0, VReg.S2); // len-del
        vm.add(VReg.V2, VReg.V2, VReg.V1); // newLen
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V2);
        vm.call("_array_ensure_cap");
        // 尾段移位:src=[start+del, len) → dst=[start+itemsLen, ...)
        vm.load(VReg.V0, VReg.S0, 24);     // data_ptr(扩容后)
        vm.load(VReg.V1, VReg.S0, 8);      // len(原,ensure_cap 不改 length)
        vm.sub(VReg.V2, VReg.V1, VReg.S1);
        vm.sub(VReg.V2, VReg.V2, VReg.S2); // V2 = tailCount = len-start-del
        vm.load(VReg.V3, VReg.S3, 8);      // V3 = itemsLen(持久到 items 拷贝)
        vm.cmp(VReg.V3, VReg.S2);
        vm.jlt("_sp_move_lo");
        // itemsLen >= delCount:从高到低(dst>src 防覆盖)。j = tailCount-1 .. 0
        vm.subImm(VReg.V2, VReg.V2, 1);
        vm.label("_sp_move_hi");
        vm.cmpImm(VReg.V2, 0);
        vm.jlt("_sp_move_done");
        vm.add(VReg.V4, VReg.S1, VReg.S2); // start+del
        vm.add(VReg.V4, VReg.V4, VReg.V2); // +j
        vm.shl(VReg.V4, VReg.V4, 3);
        vm.add(VReg.V4, VReg.V0, VReg.V4);
        vm.load(VReg.V5, VReg.V4, 0);      // src val
        vm.add(VReg.V4, VReg.S1, VReg.V3); // start+itemsLen
        vm.add(VReg.V4, VReg.V4, VReg.V2); // +j
        vm.shl(VReg.V4, VReg.V4, 3);
        vm.add(VReg.V4, VReg.V0, VReg.V4);
        vm.store(VReg.V4, 0, VReg.V5);
        vm.subImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_sp_move_hi");
        // itemsLen < delCount:从低到高。j = 0 .. tailCount-1
        vm.label("_sp_move_lo");
        vm.mov(VReg.V1, VReg.V2);          // V1 = tailCount
        vm.movImm(VReg.V2, 0);             // j
        vm.label("_sp_move_lo_loop");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jge("_sp_move_done");
        vm.add(VReg.V4, VReg.S1, VReg.S2);
        vm.add(VReg.V4, VReg.V4, VReg.V2);
        vm.shl(VReg.V4, VReg.V4, 3);
        vm.add(VReg.V4, VReg.V0, VReg.V4);
        vm.load(VReg.V5, VReg.V4, 0);
        vm.add(VReg.V4, VReg.S1, VReg.V3);
        vm.add(VReg.V4, VReg.V4, VReg.V2);
        vm.shl(VReg.V4, VReg.V4, 3);
        vm.add(VReg.V4, VReg.V0, VReg.V4);
        vm.store(VReg.V4, 0, VReg.V5);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_sp_move_lo_loop");
        vm.label("_sp_move_done");
        // 拷 items 入 [start, start+itemsLen):arrData[start+k] = itemsData[k]
        vm.load(VReg.V1, VReg.S3, 24);     // itemsArr data_ptr
        vm.movImm(VReg.V2, 0);             // k
        vm.label("_sp_items");
        vm.cmp(VReg.V2, VReg.V3);          // V3 = itemsLen
        vm.jge("_sp_items_done");
        vm.shl(VReg.V4, VReg.V2, 3);
        vm.add(VReg.V4, VReg.V1, VReg.V4);
        vm.load(VReg.V5, VReg.V4, 0);      // itemsData[k]
        vm.add(VReg.V4, VReg.S1, VReg.V2); // start+k
        vm.shl(VReg.V4, VReg.V4, 3);
        vm.add(VReg.V4, VReg.V0, VReg.V4);
        vm.store(VReg.V4, 0, VReg.V5);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_sp_items");
        vm.label("_sp_items_done");
        // length = newLen = len - del + itemsLen
        vm.load(VReg.V1, VReg.S0, 8);
        vm.sub(VReg.V1, VReg.V1, VReg.S2);
        vm.add(VReg.V1, VReg.V1, VReg.V3);
        vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.RET, VReg.S4);         // 返回 removed
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // _array_toSpliced(A0=boxed arr, A1=start, A2=delCount, A3=boxed itemsArr) -> 新数组
    // [ES2023] 非破坏 splice:全拷贝副本 → 对副本 splice → 返回副本(不改原数组、
    // 返回值是修改后的副本而非 removed)。复用 _array_slice(全拷贝)+ _array_splice。
    generateArrayToSpliced() {
        const vm = this.vm;
        vm.label("_array_toSpliced");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1);          // start
        vm.mov(VReg.S2, VReg.A2);          // delCount
        vm.mov(VReg.S3, VReg.A3);          // itemsArr
        // copy = _array_slice(arr, 0, -1)(全拷贝,同 toReversed/toSorted)
        vm.movImm(VReg.A1, 0);
        vm.movImm(VReg.A2, 2147483647);
        vm.call("_array_slice");           // RET = boxed 副本
        vm.mov(VReg.S0, VReg.RET);         // S0 = 副本
        // 对副本 splice(丢弃 removed)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.mov(VReg.A3, VReg.S3);
        vm.call("_array_splice");
        vm.mov(VReg.RET, VReg.S0);         // 返回副本
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // 数组 flat(深度 1)
    // _array_flat(arr_boxed) -> 新数组(boxed)。元素是数组(tag 0x7FFE)则展开一层,
    // 否则原样追加。深度 >1 / Infinity 暂不支持(按 1 处理)。复用 _array_push 增长。
    generateArrayFlat() {
        const vm = this.vm;

        vm.label("_array_flat");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr(裸)
        vm.load(VReg.S3, VReg.S0, 8);      // S3 = len
        vm.movImm(VReg.S1, 0);             // i = 0

        // result = 空数组(boxed)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size"); // RET = 裸指针
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S2, VReg.RET, VReg.V4);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S2, VReg.S2, VReg.V1); // S2 = result(boxed)

        vm.label("_array_flat_loop");
        vm.cmp(VReg.S1, VReg.S3);
        vm.jge("_array_flat_done");

        // elem = data[i]
        vm.load(VReg.V0, VReg.S0, 24);
        vm.shl(VReg.V1, VReg.S1, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.S4, VReg.V0, 0); // S4 = elem(boxed)

        // 元素是数组?
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_array_flat_inner");

        // 非数组:result.push(elem)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_array_flat_next");

        vm.label("_array_flat_inner");
        // 展开一层:for j < elemLen: result.push(elemData[j])
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S4, VReg.S4, VReg.V4); // S4 = elem(裸)
        vm.movImm(VReg.S5, 0);             // j = 0
        vm.label("_array_flat_inner_loop");
        vm.load(VReg.V0, VReg.S4, 8);      // elemLen(每轮重载,S4 稳定)
        vm.cmp(VReg.S5, VReg.V0);
        vm.jge("_array_flat_next");
        vm.load(VReg.V0, VReg.S4, 24);
        vm.shl(VReg.V1, VReg.S5, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.A1, VReg.V0, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_array_flat_inner_loop");

        vm.label("_array_flat_next");
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_array_flat_loop");

        vm.label("_array_flat_done");
        vm.mov(VReg.RET, VReg.S2); // 已装箱
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // [#44] _spread_call0(A0 = fn(可迭代协议的方法值,通常 0x7fff 装箱函数或堆闭包),
    //   A1 = this) -> RET。零实参调用(iterator/next 均无参),this 走方法约定(A5),
    //   实参 0 位填 undefined。堆闭包 [magic 0xc105@0, func@8] → S0=闭包(被调方经
    //   callee-saved S0 取捕获,如 _generator_next 从 S0+16 读 coro);裸函数指针直调。
    generateSpreadCall0() {
        const vm = this.vm;
        vm.label("_spread_call0");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // this
        // 装箱函数(高16位==0x7fff)→ 脱壳;否则按裸指针候选
        vm.mov(VReg.V0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.V0, 48);
        vm.cmpImm(VReg.V0, 0x7fff);
        vm.jne("_spread_call0_notagged");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1);
        vm.label("_spread_call0_notagged");
        vm.mov(VReg.S0, VReg.A0); // S0 = fn 指针(闭包或裸函数)
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_spread_call0_undef");
        vm.load(VReg.V0, VReg.S0, 0); // magic
        vm.movImm(VReg.V1, 0xc105);   // CLOSURE_MAGIC
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_spread_call0_bare");
        vm.load(VReg.V1, VReg.S0, 8);  // 闭包:真函数指针在 +8,S0 保持=闭包
        vm.jmp("_spread_call0_docall");
        vm.label("_spread_call0_bare");
        vm.mov(VReg.V1, VReg.S0);      // 裸函数指针
        vm.movImm(VReg.S0, 0);
        vm.label("_spread_call0_docall");
        vm.movImm64(VReg.A0, 0x7ffb000000000000n); // 实参0 = undefined
        vm.mov(VReg.A5, VReg.S1);      // this
        vm.setCallArgcImm(0, VReg.V0, VReg.V2); // [argc ABI] 无用户实参
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_spread_call0_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // [#44] _array_spread_into(A0 = arr(裸数组头或boxed), A1 = src) -> RET = arr。
    // 把可迭代 src 的元素依次 _array_push 进 arr。Set/Map 直接遍历插入序链表;
    // 其余(生成器对象/自定义可迭代)走 Symbol.iterator().next() 协议。字符串/数组
    // 源不应到这(编译器已内联快路)。纯 S 寄存器状态(无 FP 槽)→ 不受晋升器影响;
    // 运行时 asm gen0/gen1 逐字节一致,故 node 编译产物验证即代表 gen1 行为。
    //
    // _array_spread_into_n(..., A2=maxN):最多取 maxN 个元素;若迭代器未耗尽则
    // IteratorClose(供数组解构 `[x]=infiniteIter` 等,避免抽干超时)。
    generateArraySpreadInto() {
        const vm = this.vm;
        const TYPE_MAP = 4;
        const TYPE_SET = 5;
        vm.label("_array_spread_into");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // arr(每次 push 后更新)
        vm.mov(VReg.S1, VReg.A1); // src(boxed)
        vm.movImm(VReg.S5, -1); // 不限个数
        vm.jmp("_array_spread_into_body");

        vm.label("_array_spread_into_n");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S5, VReg.A2); // 剩余可取个数

        vm.label("_array_spread_into_body");
        // type 字节
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1); // V0 = 裸块指针
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_SET);
        vm.jeq("_array_spread_set");
        vm.cmpImm(VReg.V1, TYPE_MAP);
        vm.jeq("_array_spread_map");
        vm.jmp("_array_spread_iter");

        // ---- Set: head@16, node value@0/next@8 ----
        vm.label("_array_spread_set");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.S2, VReg.V0, 16); // node = head
        vm.label("_array_spread_set_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_array_spread_done");
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_array_spread_done"); // 限量已满
        vm.load(VReg.A1, VReg.S2, 0);  // value
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.S2, VReg.S2, 8);  // next
        vm.cmpImm(VReg.S5, 0);
        vm.jlt("_array_spread_set_loop"); // 不限
        vm.subImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_array_spread_set_loop");

        // ---- Map: head@16, node key@0/value@8/next@16;每条目 push [k,v] ----
        vm.label("_array_spread_map");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.S2, VReg.V0, 16); // node = head
        vm.label("_array_spread_map_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_array_spread_done");
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_array_spread_done");
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size"); // RET = 裸头(type=1 有效)
        vm.mov(VReg.S3, VReg.RET);        // pair
        vm.load(VReg.A2, VReg.S2, 0);     // key
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_set");
        vm.load(VReg.A2, VReg.S2, 8);     // value
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 1);
        vm.call("_array_set");
        // pair 装箱成 0x7FFE 数组值再 push——否则元素是**裸数组指针**(high16==0),
        // 后续对 [...map] 的元素调方法(如 `e.join("=")`)按未装箱值派发崩。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S3, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1); // 装箱 pair
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.S2, VReg.S2, 16);    // next
        vm.cmpImm(VReg.S5, 0);
        vm.jlt("_array_spread_map_loop");
        vm.subImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_array_spread_map_loop");

        // ---- generic: obj[Symbol.iterator]().next() 循环 ----
        vm.label("_array_spread_iter");
        // itfn = _object_get(src, "Symbol.iterator")
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        // Symbol.iterator 必须是函数(tag 0x7FFF)才可迭代;miss 返 JS_UNDEFINED(0x7FFB,非 0)
        // → 旧 cmpImm 0 判不出 → 非可迭代对象(如 {length:3})落 _spread_call0(undefined) 崩/挂。
        vm.shrImm(VReg.V2, VReg.RET, 48); // (x64 V2==A2 无活值;V0≡RET 会盖掉下方待调的迭代 fn)
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jne("_array_spread_done");
        // iter = itfn.call(src)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_spread_call0");
        vm.mov(VReg.S2, VReg.RET); // iter
        vm.label("_array_spread_iter_loop");
        // nextfn = _object_get(iter, "next")
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.shrImm(VReg.V2, VReg.RET, 48); // (x64 V2==A2 无活值;V0≡RET 会盖掉下方待调的 next fn)
        vm.cmpImm(VReg.V2, 0x7FFF); // next 须是函数
        vm.jne("_array_spread_done");
        // res = nextfn.call(iter)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_spread_call0");
        vm.mov(VReg.S3, VReg.RET); // res = {value, done}
        // if (toBoolean(res.done)) done
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("done"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        // [test262 S1] getter 解包:res.done 可能是访问器属性
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_maybe_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_array_spread_done");
        // arr = push(arr, res.value)
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        // [test262 S1] getter 解包:res.value 可能是访问器属性(如 IteratorValue 的 getter 抛错)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_maybe_getter");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        // 限量:取满后 IteratorClose(未 done)再退出
        vm.cmpImm(VReg.S5, 0);
        vm.jlt("_array_spread_iter_loop"); // 不限
        vm.subImm(VReg.S5, VReg.S5, 1);
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_array_spread_iter_loop");
        vm.mov(VReg.A0, VReg.S2); // iter
        vm.call("_iterator_close");
        vm.jmp("_array_spread_done");

        vm.label("_array_spread_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // _array_spread_into_map(A0=arr, A1=src, A2=callback, A3=thisArg?) -> RET=arr
    // 把可迭代 src 的元素依次经 callback(el,i,arr) 映射后 _array_push 进 arr。
    // A3=thisArg(可选;0 哨兵→undefined)。与 _array_spread_into 同循环结构,
    // 但在 push 前调用 callback。用于 Array.from(iterator, mapFn) 的迭代+映射交叠。
    generateArraySpreadIntoMap() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;
        vm.label("_array_spread_into_map");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // src(boxed)
        vm.mov(VReg.S2, VReg.A2); // callback
        // thisArg:A3==0 哨兵→UNDEF(Array.from 编译器缺省);其余原样(含真 UNDEF)
        vm.cmpImm(VReg.A3, 0);
        vm.jne("_asimap_this_ok");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_asimap_this_ok");
        vm.store(VReg.SP, 0, VReg.A3); // thisArg → [SP+0](跨循环保活)
        // Symbol.iterator 获取
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_asimap_done");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_spread_call0");
        vm.mov(VReg.S3, VReg.RET); // iter
        vm.movImm(VReg.S4, 0);     // index

        vm.label("_asimap_loop");
        // nextfn = iter.next
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_asimap_done");
        // res = nextfn.call(iter)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_spread_call0");
        vm.mov(VReg.S5, VReg.RET); // res
        // if done → exit
        vm.mov(VReg.A0, VReg.S5);
        vm.lea(VReg.A1, vm.asm.addString("done"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_maybe_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_asimap_done");
        // value = res.value
        vm.mov(VReg.A0, VReg.S5);
        vm.lea(VReg.A1, vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_maybe_getter");
        // mapped = callback(value, index, arr) with this=thisArg
        vm.mov(VReg.A0, VReg.RET); // value
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A1, 0);  // index as number
        vm.mov(VReg.A2, VReg.S0);  // arr
        vm.mov(VReg.A3, VReg.S2);  // callback
        vm.load(VReg.A4, VReg.SP, 0); // thisArg
        vm.call("_aref_invoke_cbt");
        // push mapped
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_asimap_loop");

        vm.label("_asimap_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // [Stage A 内置方法引用] 蹦床:数组/字符串方法作一等值(`const f=arr.push`、
    // `arr.map`)是闭包 {magic@0=0xc105, fnptr@8=_aref_generic, helper@16=<运行时 helper 标签>}。
    // 经 `.call(recv,args)`/方法调用进入时:S0=裸闭包、A5=this(接收者)、A0-A4=用户实参。
    // 把接收者插到 A0、用户实参上移一位,尾调 helper(recv, args...)。方法引用**不绑定**接收者
    // (与 ES 一致:`arr.push` 即 Array.prototype.push,this 由调用点提供);故仅一个蹦床服务
    // 所有 helper 型方法,helper 标签由闭包 @16 携带。helper 只读它需要的实参,多余的忽略。
    generateArefGeneric() {
        const vm = this.vm;
        vm.label("_aref_generic");
        vm.prologue(0, []); // 仅存 FP/LR(要 call)
        vm.load(VReg.V6, VReg.S0, 16); // V6 = helper 标签指针(S0=裸闭包)
        // 用户实参上移一位、A0=接收者(高→低,避免踩踏)
        vm.mov(VReg.A4, VReg.A3);
        vm.mov(VReg.A3, VReg.A2);
        vm.mov(VReg.A2, VReg.A1);
        vm.mov(VReg.A1, VReg.A0);
        vm.mov(VReg.A0, VReg.A5); // A0 = this(接收者)
        vm.callIndirect(VReg.V6); // helper(recv, args...);RET=结果
        vm.epilogue([], 0);
    }

    // [Stage A Batch 2b] 需**裸 int** 下标/fromIndex 的方法引用 wrapper。generic 蹦床传的是
    // **装箱**实参(缺参为 JS_UNDEFINED),而 _array_at/_str_charAt/*_indexOf 等 helper 要裸 int。
    // 表项指向这些 wrapper(而非 helper 本身),wrapper 把装箱下标转裸 int(缺省 0)再调真 helper。
    generateArefIntWrappers() {
        const vm = this.vm;
        // 装箱实参 → 裸 int(undefined→0)。A0=boxed → RET=裸 int。
        vm.label("_aref_argint");
        vm.prologue(0, []);
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7ffb); // JS_UNDEFINED
        vm.jeq("_aref_argint_zero");
        vm.call("_syscall_arg"); // A0(装箱)→ RET 裸 int
        vm.epilogue([], 0);
        vm.label("_aref_argint_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);

        // _aref_fromindex(A0=boxed) → ToInteger 裸 int(undefined→0)。
        // 与 _aref_argint/_to_int32 不同:串/对象走 _number_coerce(+Inf/-Inf 保留哨兵),
        // +Inf→INT64_MAX(indexOf 中 n≥len 立即 -1)、-Inf→INT64_MIN(归一到 0)、NaN→0。
        // 供 indexOf/includes fromIndex(禁把 "Infinity" 当串指针截 int)。
        vm.label("_aref_fromindex");
        vm.prologue(0, []);
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7ffb); // undefined
        vm.jeq("_aref_fromindex_zero");
        vm.call("_number_coerce"); // RET = float64 位
        vm.shrImm(VReg.V1, VReg.RET, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jne("_aref_fromindex_finite");
        // NaN 或 ±Inf:尾数非 0 → NaN → 0;符号位区分 ±Inf
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V1, VReg.RET, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_aref_fromindex_zero"); // NaN
        vm.shrImm(VReg.V1, VReg.RET, 63);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_aref_fromindex_ninf");
        vm.movImm64(VReg.RET, 0x7FFFFFFFFFFFFFFFn); // +Inf 哨兵
        vm.epilogue([], 0);
        vm.label("_aref_fromindex_ninf");
        vm.movImm64(VReg.RET, 0x8000000000000000n); // -Inf → 后续 max(len+n,0)=0
        vm.epilogue([], 0);
        vm.label("_aref_fromindex_finite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.RET, 0); // 向零截断(ToInteger)
        vm.epilogue([], 0);
        vm.label("_aref_fromindex_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);

        // 装箱实参 → 裸 int,缺省(undefined)取 A1(裸)。A0=boxed, A1=default_raw → RET。
        vm.label("_aref_argint_d");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A1); // default
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7ffb); // undefined
        vm.jeq("_aref_argint_d_def");
        vm.call("_syscall_arg"); // A0 → RET 裸 int
        vm.epilogue([VReg.S0], 0);
        vm.label("_aref_argint_d_def");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);

        // arr.slice([start[, end]]):start 缺省 0、end 缺省 INT_MAX(_array_slice 的"到末尾"哨兵)。
        // A0=arr, A1=boxed start, A2=boxed end → _array_slice(arr, 裸 start, 裸 end)。
        vm.label("_aref_arr_slice");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // boxed start
        vm.mov(VReg.S2, VReg.A2); // boxed end
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_aref_argint_d");
        vm.mov(VReg.S1, VReg.RET); // 裸 start
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 2147483647); // INT_MAX
        vm.call("_aref_argint_d");
        vm.mov(VReg.S2, VReg.RET); // 裸 end
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_array_slice");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // arr.at(idx):A0=arr, A1=boxed idx → _array_at(arr, 裸 idx)
        vm.label("_aref_arr_at");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_aref_argint");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_at");
        vm.epilogue([VReg.S0], 0);

        // str.charAt(idx):A0=str, A1=boxed idx → _str_charAt(str, 裸 idx)
        vm.label("_aref_str_charAt");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_aref_argint");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_charAt");
        vm.epilogue([VReg.S0], 0);

        // arr.indexOf(value[, from]):A0=arr, A1=value(装箱透传), A2=boxed from → 装箱数字。
        // ES:ToLength 后若 len==0 立即 -1,再 ToInteger(fromIndex)——空数组不得调 from.valueOf。
        vm.label("_aref_arr_indexOf");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // value
        vm.mov(VReg.S2, VReg.A2); // boxed from
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aref_arr_indexOf_empty");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_aref_fromindex");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_indexOf"); // RET = 裸 int 下标/-1
        vm.scvtf(0, VReg.RET);      // 裸 int → 装箱 float64 数字(同静态派发出口)
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_aref_arr_indexOf_empty");
        vm.movImm(VReg.RET, -1);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // str.indexOf(search[, from]):A0=str, A1=search(装箱透传), A2=boxed from → 裸 from(缺省0)
        vm.label("_aref_str_indexOf");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.A2);
        vm.call("_aref_argint");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_indexOf"); // RET = 裸 int 下标/-1
        vm.scvtf(0, VReg.RET);    // 裸 int → 装箱 float64 数字
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [Stage A Batch 3] 回调型方法引用(forEach/map/filter…)运行时实现。静态派发把回调内联
    // 展开、无运行时 helper;方法引用需真 helper 驱动回调,故新写。_aref_invoke_cb 是共享的
    // 回调调用器(镜像 _spread_call0 的 magic 派发,但传 3 个实参 element/index/array)。
    generateArefCallbackMethods() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;

        // 调用回调:A0=arg0(element), A1=arg1(index), A2=arg2(array), A3=callback → RET=回调返回值。
        // 装箱函数脱壳→magic 判闭包(fnptr@8,S0=闭包)/裸函数(S0=0)。
        // _aref_invoke_cb:强制 this=undefined(A4←UNDEF 后落入 cbt)——兼容 Proxy/Set/Map
        // 等既有调用方(不设 A4)。_aref_invoke_cbt:A4=thisArg → A5(Array 回调规范路径)。
        vm.label("_aref_invoke_cb");
        vm.movImm64(VReg.A4, UNDEF); // 兼容入口:忽略调用方残留 A4
        vm.label("_aref_invoke_cbt");
        vm.prologue(0, [VReg.S0]); // 保存 S0(闭包会占用;调用者的 S0 须还原)
        vm.mov(VReg.V6, VReg.A3);
        // [C1] callback 可调用守卫(镜像 _validate_callable 判据):装箱函数(0x7FFF)/
        // 装箱对象(0x7FFD,可调用 Proxy 候选,下方 magic/TYPE_PROXY 分派)直通;
        // 裸值(high16==0)须落 [heap_base,heap_ptr)(闭包块候选);其余(null/undefined/
        // 数字/字符串/布尔)→ _throw_not_a_function(真 TypeError)。此前 null 的
        // payload 0 直接 load [0] SIGSEGV(filter.call(obj,null) 崩根因)。
        // 寄存器纪律:必须在 emitMaskLoad(V1) 前判 tag(x64 V1==RCX==A3,mask 装载
        // 会冲掉装箱 callback);scratch 只用 V0(入口无活 RET)与 V5(两后端均不
        // 别名 A0-A5),不碰已装好的回调实参 A0-A2。
        // V5 暂存原始 tag(guard 期写入,后续 _aref_icb_bare 用其判 0x7FFD 不可调用)。
        vm.shrImm(VReg.V0, VReg.V6, 48);
        vm.mov(VReg.V5, VReg.V0);        // V5 = 原始 tag
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_aref_icb_callable");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_aref_icb_callable");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_aref_icb_notfn");
        vm.lea(VReg.V5, "_heap_base");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.V6, VReg.V5);
        vm.jlt("_aref_icb_notfn");
        vm.lea(VReg.V5, "_heap_ptr");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.V6, VReg.V5);
        vm.jlt("_aref_icb_callable");
        vm.label("_aref_icb_notfn");
        vm.call("_throw_not_a_function"); // 不返回(_throw_unwind)
        vm.label("_aref_icb_callable");
        // 无条件掩码脱壳:装箱函数(0x7FFF)/装箱 Proxy(0x7FFD)去 tag;裸指针高16=0 恒等。
        // 此前仅 0x7FFF 脱壳 → 装箱 proxy 带 tag 解引用 [V6+0] 直接段错([1].map(proxy) 崩)。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V6, VReg.V6, VReg.V1);
        vm.load(VReg.V0, VReg.V6, 0); // magic
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_aref_icb_notcl");
        vm.mov(VReg.S0, VReg.V6);      // 闭包对象 → S0
        vm.load(VReg.V6, VReg.V6, 8);  // 真函数指针
        vm.jmp("_aref_icb_do");
        vm.label("_aref_icb_notcl");
        // [Proxy 回调] 可调用 Proxy(type@0==8)→ _validate_callable 合成闭包块
        // {0xc105, tramp, proxyRaw}(in/out=S0,A0-A2 实参保持)→ 按闭包分派。
        vm.cmpImm(VReg.V0, 8); // TYPE_PROXY
        vm.jne("_aref_icb_bare");
        vm.mov(VReg.S0, VReg.V6);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n); // _validate_callable 要求装箱形态
        vm.or(VReg.S0, VReg.S0, VReg.V1);
        vm.call("_validate_callable"); // S0 → 合成闭包块
        vm.load(VReg.V6, VReg.S0, 8);  // tramp 地址
        vm.jmp("_aref_icb_do");
        vm.label("_aref_icb_bare");
        // [boxed-obj guard] magic 非 closure 且 type 非 proxy:若原 tag=0x7FFD 则不可调用。
        // 此前 0x7FFD Object(如 new Object())经 _aref_icb_callable 通过后,在 bare 路被当
        // 裸函数指针 callIndirect → 对堆对象头执行 → SIGBUS(arr.map(new Object()) 崩根因)。
        vm.cmpImm(VReg.V5, 0x7FFD);
        vm.jeq("_aref_icb_notfn");
        vm.movImm(VReg.S0, 0);          // 裸函数:无闭包
        vm.label("_aref_icb_do");
        // [D1 L3b OrdinaryCallBindThis] thisArg===undefined 时:
        //   callee 非严格 → this = globalThis(装箱);严格 → 保持 undefined。
        // 无条件绑 _global_this 会打回 onlyStrict/自有 "use strict" 已 PASS 的
        // forEach/15.4.4.18-5-1-s。严格位来自 _func_meta kind bit8(closures 盖章)。
        // V6=code_ptr(闭包已脱壳到真 fnptr;裸函数即自身)。A0-A2 实参须跨查表/装箱存活。
        vm.movImm64(VReg.V0, UNDEF);
        vm.cmp(VReg.A4, VReg.V0);
        vm.jne("_aref_icb_this_ready");
        vm.subImm(VReg.SP, VReg.SP, 32); // A0/A1/A2/V6
        vm.store(VReg.SP, 0, VReg.A0);
        vm.store(VReg.SP, 8, VReg.A1);
        vm.store(VReg.SP, 16, VReg.A2);
        vm.store(VReg.SP, 24, VReg.V6);
        vm.mov(VReg.A0, VReg.V6);
        vm.call("_func_meta_strict"); // RET = 0|1
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_aref_icb_this_strict"); // 严格 → 恢复后 A4 仍 UNDEF
        // 非严格:装箱 _global_this → A4
        vm.lea(VReg.V0, "_global_this");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.call("_box_obj_r"); // RET = 0x7FFD-tagged
        vm.mov(VReg.A4, VReg.RET);
        vm.load(VReg.V6, VReg.SP, 24);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.addImm(VReg.SP, VReg.SP, 32);
        vm.jmp("_aref_icb_this_ready");
        vm.label("_aref_icb_this_strict");
        vm.load(VReg.V6, VReg.SP, 24);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.addImm(VReg.SP, VReg.SP, 32);
        // A4 保持 UNDEF
        vm.label("_aref_icb_this_ready");
        vm.mov(VReg.A5, VReg.A4);       // this = thisArg(cbt 传入;cb 入口已置 UNDEF;或 global)
        vm.setCallArgcImm(3, VReg.V0, VReg.V1); // [argc ABI] callback(elem, idx, arr)
        vm.callIndirect(VReg.V6);       // callback(A0,A1,A2)
        vm.epilogue([VReg.S0], 0);

        // _aref_require_cb(A0=callback):IsCallable 检(须在 Length/ToLength 之后调用)。
        // 不调用回调。此前 0x7FFD 一律放行 → [].map({})/Array.from([],{}) 空长不抛
        // (规范要求 IsCallable 在循环前)。现与 _aref_invoke_cb / _validate_callable
        // 对齐:0x7FFF 直通;0x7FFD 仅 CLOSURE_MAGIC/ASYNC_CLOSURE/TYPE_PROXY/TYPE_CLOSURE;
        // 裸堆指针落 [heap_base,heap_ptr);其余 TypeError。
        vm.label("_aref_require_cb");
        vm.prologue(0, []);
        vm.mov(VReg.V6, VReg.A0);
        vm.shrImm(VReg.V0, VReg.V6, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_aref_req_ok");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_aref_req_raw");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.V6, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_aref_req_bad");
        vm.load(VReg.V0, VReg.V1, 0); // magic 全字或 type@0
        vm.movImm(VReg.V2, 0xc105); // CLOSURE_MAGIC
        vm.cmp(VReg.V0, VReg.V2);
        vm.jeq("_aref_req_ok");
        vm.movImm(VReg.V2, 0xa51c); // ASYNC_CLOSURE_MAGIC
        vm.cmp(VReg.V0, VReg.V2);
        vm.jeq("_aref_req_ok");
        vm.loadByte(VReg.V0, VReg.V1, 0);
        vm.cmpImm(VReg.V0, 8); // TYPE_PROXY
        vm.jeq("_aref_req_ok");
        vm.cmpImm(VReg.V0, 3); // TYPE_CLOSURE (classinfo)
        vm.jeq("_aref_req_ok");
        vm.jmp("_aref_req_bad");
        vm.label("_aref_req_raw");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_aref_req_bad");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V6, VReg.V1);
        vm.jlt("_aref_req_bad");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V6, VReg.V1);
        vm.jge("_aref_req_bad");
        // 裸堆块须真可调用:CLOSURE_MAGIC / ASYNC / TYPE_CLOSURE。
        // 此前任意堆指针放行 → Symbol(TYPE_SYMBOL=61) 被当 callable
        // (Array.from([], Symbol()) 不抛)。
        vm.load(VReg.V0, VReg.V6, 0);
        vm.movImm(VReg.V2, 0xc105);
        vm.cmp(VReg.V0, VReg.V2);
        vm.jeq("_aref_req_ok");
        vm.movImm(VReg.V2, 0xa51c);
        vm.cmp(VReg.V0, VReg.V2);
        vm.jeq("_aref_req_ok");
        vm.loadByte(VReg.V0, VReg.V6, 0);
        vm.cmpImm(VReg.V0, 3); // TYPE_CLOSURE
        vm.jeq("_aref_req_ok");
        vm.jmp("_aref_req_bad");
        vm.label("_aref_req_bad");
        vm.call("_throw_not_a_function");
        vm.label("_aref_req_ok");
        vm.epilogue([], 0);

        // _iterator_close(A0=iterator_boxed):for-of 提前 break 的 IteratorClose——若 iterator
        // 有 return() 方法则以 this=iterator 无参调用(结果忽略);无则空操作。单一定点 helper
        // (每个 for-of 只发一条 call,不内联方法调用 → 自举安全)。magic 分派同 _aref_invoke_cb,
        // 但 this=iterator(A5)。
        vm.label("_iterator_close");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0);        // iterator(this)
        vm.lea(VReg.A1, vm.asm.addString("return"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_get");          // RET = iterator.return
        // [accessor] GetMethod 语义:return 若是 accessor(getter)须先触发
        // (iterator-close-non-throw-get-method-is-null 的 returnGets 计数),再判可调用。
        // 此前裸 _object_get 不触发 getter → getter 恒不跑,计数为 0 判负。
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");        // RET = 触发 getter 后的值(非访问器原样)
        vm.mov(VReg.V6, VReg.RET);
        vm.shrImm(VReg.V0, VReg.V6, 48);
        vm.cmpImm(VReg.V0, 0x7fff);      // 装箱函数?
        vm.jne("_itc_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V6, VReg.V6, VReg.V1); // 脱壳
        vm.load(VReg.V0, VReg.V6, 0);    // magic
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_itc_bare");
        vm.mov(VReg.S0, VReg.V6);         // 闭包对象 → S0
        vm.load(VReg.V6, VReg.V6, 8);     // 真函数指针
        vm.jmp("_itc_do");
        vm.label("_itc_bare");
        vm.movImm(VReg.S0, 0);            // 裸函数:无闭包
        vm.label("_itc_do");
        vm.mov(VReg.A5, VReg.S1);         // this = iterator
        vm.callIndirect(VReg.V6);         // iterator.return()
        vm.label("_itc_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // arr.forEach(cb[, thisArg]):A0=arr(boxed), A1=callback → undefined。逐元素调 cb(element, i, arr)。
        // GC:arr/cb 存 callee-saved(prologue 落栈,GC 扫栈可见);i/length 是裸 int;无增长结果。
        // _array_forEach_rt(A0=arr, A1=cb, A2=origRecv?0) — thisArg=undefined(兼容 TA/expressions)
        // _array_forEach_rt_t(..., A3=thisArg)
        vm.label("_array_forEach_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_forEach_rt_t");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // arr(boxed)
        vm.mov(VReg.S1, VReg.A1); // callback
        vm.mov(VReg.S4, VReg.A2); // origRecv(0=arr)
        vm.mov(VReg.S5, VReg.A3); // thisArg
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // length(裸 int)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.movImm(VReg.S3, 0);     // i
        vm.label("_fe_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_fe_done");
        // HasProperty+Get 活读(继承 hole / own accessor)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fe_skip");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx"); // RET = element(boxed)
        vm.mov(VReg.A0, VReg.RET); // arg0 = element
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);  // arg1 = 装箱 index
        // 第三参:优先用原始 receiver(泛型 .call 保留身份),否则用数组自身。
        vm.mov(VReg.A2, VReg.S4);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_fe_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);  // 兜底:数组自身
        vm.label("_fe_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);  // callback
        vm.mov(VReg.A4, VReg.S5);  // thisArg
        vm.call("_aref_invoke_cbt");
        vm.label("_fe_skip");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_fe_loop");
        vm.label("_fe_done");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // arr.map(cb[, thisArg]) → 新数组[cb(el,i,arr)];holes 保留(预分配 len,仅对存在下标 Set)。
        // _array_map_rt(A0=arr, A1=cb, A2=origRecv?0)
        // _array_map_rt_t(..., A3=thisArg)
        // A2 可选:原始 receiver(泛型 .call 保留三参身份);A2==0 → 用 arr 兜底。
        vm.label("_array_map_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_map_rt_t");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S5, VReg.A2); // origRecv(0=arr)
        vm.store(VReg.SP, 0, VReg.A3); // thisArg → [SP+0]
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_new_with_size"); // 预分配 len,holes 保持 0
        vm.mov(VReg.S4, VReg.RET); // result(裸头)
        vm.movImm(VReg.S3, 0);
        vm.label("_map_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_map_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_map_skip"); // hole / absent
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S5);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_map_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);
        vm.label("_map_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);
        vm.load(VReg.A4, VReg.SP, 0); // thisArg
        vm.call("_aref_invoke_cbt"); // RET = mapped
        vm.mov(VReg.A2, VReg.RET); // value
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_set");
        vm.label("_map_skip");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_map_loop");
        vm.label("_map_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1); // 装箱 0x7FFE
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // arr.filter(cb[, thisArg]) → 新数组[cb 真值的 el]。
        // _array_filter_rt(A0=arr, A1=cb, A2=origRecv?0)
        // _array_filter_rt_t(..., A3=thisArg)
        vm.label("_array_filter_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_filter_rt_t");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S5, VReg.A2); // origRecv(0=arr)
        vm.store(VReg.SP, 8, VReg.A3); // thisArg → [SP+8](SP+0 留给 element)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S4, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_filt_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_filt_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_filt_skip"); // hole / absent
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 0, VReg.RET); // 存 element(跨回调保活)
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S5);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_filt_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);
        vm.label("_filt_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);
        vm.load(VReg.A4, VReg.SP, 8); // thisArg
        vm.call("_aref_invoke_cbt"); // RET = 谓词结果
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_filt_skip");
        vm.load(VReg.A1, VReg.SP, 0); // element
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S4, VReg.RET);
        vm.label("_filt_skip");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_filt_loop");
        vm.label("_filt_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // arr.some(cb[, thisArg]) → 任一 cb 真值 → true,否则 false(短路)。无结果数组。
        // _array_some_rt(A0=arr, A1=cb, A2=origRecv?0)
        // _array_some_rt_t(..., A3=thisArg)
        vm.label("_array_some_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_some_rt_t");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2); // origRecv(0=arr)
        vm.mov(VReg.S5, VReg.A3); // thisArg
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.movImm(VReg.S3, 0);
        vm.label("_some_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_some_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_some_skip");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_some_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);
        vm.label("_some_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_some_true");
        vm.label("_some_skip");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_some_loop");
        vm.label("_some_true");
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_some_false");
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // arr.every(cb[, thisArg]) → 全部 cb 真值 → true,否则 false(短路)。holes 跳过(空洞视为通过)。
        // _array_every_rt(A0=arr, A1=cb, A2=origRecv?0)
        // _array_every_rt_t(..., A3=thisArg)
        vm.label("_array_every_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_every_rt_t");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2); // origRecv(0=arr)
        vm.mov(VReg.S5, VReg.A3); // thisArg
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.movImm(VReg.S3, 0);
        vm.label("_every_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_every_true");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_every_skip");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_every_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);
        vm.label("_every_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_every_false");
        vm.label("_every_skip");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_every_loop");
        vm.label("_every_true");
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_every_false");
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // 4 实参回调调用器(reduce 用):A0-A3=cb 实参(acc,cur,idx,arr), A4=callback → RET。
        // 同 _aref_invoke_cb 的 magic 派发,唯 callback 在 A4(A0-A3 留给回调实参)。
        vm.label("_aref_invoke_cb4");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.V6, VReg.A4);
        // [C1] callback 可调用守卫,同 _aref_invoke_cb(x64 纪律:V1==A3 是回调实参 arr,
        // 绝不可作 scratch;tag 判在 mask 装载前,scratch 只用 V0/V5)。
        // V5 暂存原始 tag,后续 _aref_icb4_bare 用其判 0x7FFD 不可调用。
        vm.shrImm(VReg.V0, VReg.V6, 48);
        vm.mov(VReg.V5, VReg.V0);        // V5 = 原始 tag
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_aref_icb4_callable");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_aref_icb4_callable");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_aref_icb4_notfn");
        vm.lea(VReg.V5, "_heap_base");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.V6, VReg.V5);
        vm.jlt("_aref_icb4_notfn");
        vm.lea(VReg.V5, "_heap_ptr");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.V6, VReg.V5);
        vm.jlt("_aref_icb4_callable");
        vm.label("_aref_icb4_notfn");
        vm.call("_throw_not_a_function"); // 不返回(_throw_unwind)
        vm.label("_aref_icb4_callable");
        // 无条件掩码脱壳(同 _aref_invoke_cb:装箱 proxy 0x7FFD 需去 tag)
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V6, VReg.V6, VReg.V1);
        vm.load(VReg.V0, VReg.V6, 0);
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_aref_icb4_notcl");
        vm.mov(VReg.S0, VReg.V6);
        vm.load(VReg.V6, VReg.V6, 8);
        vm.jmp("_aref_icb4_do");
        vm.label("_aref_icb4_notcl");
        vm.cmpImm(VReg.V0, 8); // TYPE_PROXY → 合成闭包块(A0-A3 实参保持)
        vm.jne("_aref_icb4_bare");
        vm.mov(VReg.S0, VReg.V6);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n); // 装箱形态(见 _aref_invoke_cb 注)
        vm.or(VReg.S0, VReg.S0, VReg.V1);
        vm.call("_validate_callable");
        vm.load(VReg.V6, VReg.S0, 8);
        vm.jmp("_aref_icb4_do");
        vm.label("_aref_icb4_bare");
        // [boxed-obj guard] 同 _aref_invoke_cb:非 closure/非 proxy 的 0x7FFD 对象不可调用。
        vm.cmpImm(VReg.V5, 0x7FFD);
        vm.jeq("_aref_icb4_notfn");
        vm.movImm(VReg.S0, 0);
        vm.label("_aref_icb4_do");
        vm.movImm64(VReg.A5, UNDEF);
        vm.setCallArgcImm(4, VReg.V0, VReg.V1); // [argc ABI] callback(acc, cur, idx, arr)
        vm.callIndirect(VReg.V6);
        vm.epilogue([VReg.S0], 0);

        // arr.reduce(cb[, seed]):A0=arr, A1=cb, A2=seed(缺省 JS_UNDEFINED)。seed 须在
        // _array_length(冲 A2)前存入 S4。无 seed(S4===undefined)→ acc=首个存在元素、i 从 1;
        // 有 seed → acc=seed、i 从 0。空数组(len==0)且无 seed → TypeError(ES 23.1.3.24 step 5)。
        // 已知偏差:显式传 undefined 作 seed 与缺参不可区分,同样抛。
        // HasProperty 经 `_agen_has_idx`(含原型链);全 hole 且无 seed → TypeError。
        // acc(S4)callee-saved(落栈,GC 扫栈可见)跨回调保活。回调 cb(acc,cur,idx,arr)。
        // _array_reduce_rt(A0=arr, A1=cb, A2=seed, A3=origRecv?0)
        // A3 可选:原始 receiver(泛型 .call 保留四参身份);A3==0 → 用 arr 兜底。
        vm.label("_array_reduce_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2); // seed(先存,_array_length 会冲 A2)
        vm.mov(VReg.S5, VReg.A3); // S5 = origRecv(0=arr)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7ffb); // seed===undefined?
        vm.jeq("_reduce_noseed");
        vm.movImm(VReg.S3, 0); // 有 seed:i=0
        vm.jmp("_reduce_loop");
        vm.label("_reduce_noseed");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_reduce_empty");
        vm.movImm(VReg.S3, 0);
        vm.label("_reduce_find_first");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_reduce_allhole"); // 全 absent
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_reduce_got_first");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_reduce_find_first");
        vm.label("_reduce_got_first");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.S4, VReg.RET); // acc=first present
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.label("_reduce_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_reduce_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_reduce_skip");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A1, VReg.RET); // cur=element
        vm.mov(VReg.A0, VReg.S4);  // acc
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A2, 0);  // idx boxed
        // 第四参:优先用原始 receiver(泛型 .call 保留身份),否则用数组自身。
        vm.mov(VReg.A3, VReg.S5);
        vm.cmpImm(VReg.A3, 0);
        vm.jne("_reduce_cb_has_orig");
        vm.mov(VReg.A3, VReg.S0); // 兜底:数组自身
        vm.label("_reduce_cb_has_orig");
        vm.mov(VReg.A4, VReg.S1);  // callback
        vm.call("_aref_invoke_cb4");
        vm.mov(VReg.S4, VReg.RET); // acc=result
        vm.label("_reduce_skip");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_reduce_loop");
        vm.label("_reduce_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_reduce_empty");
        // len==0 且无 seed → TypeError(ES 23.1.3.24 step 5)
        vm.lea(VReg.A0, vm.asm.addString("Reduce of empty array with no initial value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0); // 理论不达
        // 全 absent(含原型)且无 seed → TypeError(与 agen live / ES 对齐)
        vm.label("_reduce_allhole");
        vm.jmp("_reduce_empty");

        // arr.reduceRight(cb[, seed]):从末尾向前。无 seed → acc=首个存在元素、i 再向前;
        // 有 seed → acc=seed、i 从 len-1。i<0 结束。HasProperty 经 `_agen_has_idx`。
        // _array_reduceRight_rt(A0=arr, A1=cb, A2=seed, A3=origRecv?0)
        // A3 可选:原始 receiver(泛型 .call 保留四参身份);A3==0 → 用 arr 兜底。
        vm.label("_array_reduceRight_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2);
        vm.mov(VReg.S5, VReg.A3); // S5 = origRecv(0=arr)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7ffb);
        vm.jeq("_rredr_noseed");
        vm.subImm(VReg.S3, VReg.S2, 1); // 有 seed:i=len-1
        vm.jmp("_rredr_loop");
        vm.label("_rredr_noseed");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_rredr_empty");
        vm.subImm(VReg.S3, VReg.S2, 1);
        vm.label("_rredr_find_first");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_rredr_allhole"); // 全 absent
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_rredr_got_first");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_rredr_find_first");
        vm.label("_rredr_got_first");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.S4, VReg.RET); // acc=first present from right
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.label("_rredr_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_rredr_done"); // i<0
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_rredr_skip");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A2, 0);
        // 第四参:优先用原始 receiver(泛型 .call 保留身份),否则用数组自身。
        vm.mov(VReg.A3, VReg.S5);
        vm.cmpImm(VReg.A3, 0);
        vm.jne("_rredr_cb_has_orig");
        vm.mov(VReg.A3, VReg.S0); // 兜底:数组自身
        vm.label("_rredr_cb_has_orig");
        vm.mov(VReg.A4, VReg.S1);
        vm.call("_aref_invoke_cb4");
        vm.mov(VReg.S4, VReg.RET);
        vm.label("_rredr_skip");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_rredr_loop");
        vm.label("_rredr_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_rredr_empty");
        // len==0 且无 seed → TypeError(ES 23.1.3.25 step 5)
        vm.lea(VReg.A0, vm.asm.addString("Reduce of empty array with no initial value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0); // 理论不达
        vm.label("_rredr_allhole");
        vm.jmp("_rredr_empty");
    }

    // [test262 S1 泛型数组方法] `Array.prototype.<m>.call(recv, ...)` 的运行时分派层。
    // ES 要求数组方法泛型(对任何 length+索引元素对象工作);jsbin 既有实现假设真数组
    // (0x7FFE)直读缓冲,非数组 this 即 SIGSEGV。守卫分派:真数组恒等直通既有
    // _array_*_rt/_aref_arr_* 快路(一字节不改);字符串/类数组对象先经 _agen_norm
    // 快照成真数组再同路委托。全部为**新增** helper,不触碰任何编译器依赖的共享热路径。
    // 回调方法(every/some/map/…)非数组路径已改活读(HasProperty+_subscript_get,
    // 第三参=原 receiver,变异可见,holes 跳过)。非回调仍经 _agen_norm 快照。
        // 已知偏差:length 走 int32 截断;flatMap 仍快照;真数组 holes 经槽==0 跳过
        // (哨兵 0=+0 已在写路径规范为装箱 int0);find/findIndex 访洞不跳。
        // thisArg 经 _aref_invoke_cbt / _array_*_rt_t 传递。
    generateAgenGeneric() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;
        const boxStr = (reg) => { // cstr 地址 → 装箱字符串(0x7FFC)
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(reg, reg, VReg.V1);
        };

        // _agen_setlength_throw(A0=recv, A2=boxed newLen):Set(O,"length",V,true)。
        // 字符串/函数 exotic length 恒不可写 → TypeError;其余走 _object_set_strict。
        vm.label("_agen_setlength_throw");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A2); // value
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); // string primitive
        vm.jeq("_agen_slt_throw");
        vm.cmpImm(VReg.V0, 0x7FFF); // function
        vm.jeq("_agen_slt_throw");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_set_strict");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_slt_throw");
        vm.lea(VReg.A0, vm.asm.addString("Cannot assign to read only property 'length'"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _agen_toobject(A0=recv) -> RET boxed object-or-string。
        // null/undefined → TypeError; bool/number 原始值 → Boolean/Number wrapper;
        // 字符串/数组/对象/函数/裸堆指针 → 恒等。供泛型 ToObject(this)。
        vm.label("_agen_toobject");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); // null
        vm.jeq("_agen_toobj_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); // undefined
        vm.jeq("_agen_toobj_nullish");
        vm.cmpImm(VReg.V0, 0x7FF9); // boolean
        vm.jeq("_agen_toobj_bool");
        vm.cmpImm(VReg.V0, 0x7FFC); // string
        vm.jeq("_agen_toobj_id");
        vm.cmpImm(VReg.V0, 0x7FFD); // object
        vm.jeq("_agen_toobj_id");
        vm.cmpImm(VReg.V0, 0x7FFE); // array
        vm.jeq("_agen_toobj_id");
        vm.cmpImm(VReg.V0, 0x7FFF); // function
        vm.jeq("_agen_toobj_id");
        vm.cmpImm(VReg.V0, 0x7FF8); // tagged int
        vm.jeq("_agen_toobj_num");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_agen_toobj_hip0");
        // 其余高16(<0x7FF8 正浮点/NaN,或 >0x7FFF 负浮点)→ Number wrapper
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_agen_toobj_num");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jgt("_agen_toobj_num");
        vm.jmp("_agen_toobj_id");
        vm.label("_agen_toobj_hip0");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_agen_toobj_num"); // +0.0
        vm.jmp("_agen_toobj_id"); // 裸堆指针
        vm.label("_agen_toobj_bool");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_boolean_new");
        vm.epilogue([VReg.S0], 0);
        vm.label("_agen_toobj_num");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_new");
        vm.epilogue([VReg.S0], 0);
        vm.label("_agen_toobj_id");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_agen_toobj_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Array.prototype method called on null or undefined"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0], 0);

        // _agen_norm(A0=recv boxed) -> boxed 真数组。
        // 真数组:恒等返回(快路,3 条指令)。null/undefined:抛 TypeError。
        // 字符串:len=_strlen;对象(0x7FFD):len=ToLength(this.length)。
        // 数字/布尔:先 ToObject 成 wrapper 再读 length/下标。
        // 元素逐索引经 _subscript_get(recv, boxed_i) 读取(对象键规范化/字符串 charAt
        // /typed 布局均由其内部处理),push 进新真数组。
        vm.label("_agen_norm");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_norm_slow");
        vm.mov(VReg.RET, VReg.A0); // 真数组:恒等
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_agen_norm_slow");
        // TypedArray 接收者(裸堆指针,类型字节 [0x40,0x7f]):没有 length 属性容器,
        // 走下方对象路径会得 len=0 → 泛型 `Array.prototype.slice/at/…​.call(ta)` 全空。
        // 取 _ta_to_array 快照(逐元素 canonical 数字)交给普通数组实现。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_norm_notta");
        vm.movImm64(VReg.V2, vm.ptrFloor);
        vm.cmp(VReg.A0, VReg.V2);
        vm.jlt("_agen_norm_notta");
        vm.loadByte(VReg.V3, VReg.A0, 0);
        vm.cmpImm(VReg.V3, 0x40);
        vm.jlt("_agen_norm_notta");
        vm.cmpImm(VReg.V3, 0x7f);
        vm.jgt("_agen_norm_notta");
        vm.call("_ta_to_array"); // A0=ta → RET = 装箱普通数组
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_agen_norm_notta");
        vm.call("_agen_toobject"); // nullish TypeError; num/bool → wrapper
        vm.mov(VReg.S0, VReg.RET); // recv (可能已装箱)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); // 字符串
        vm.jne("_agen_norm_objlen");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen"); // A0=recv → RET=裸 len(_strlen 内部 _getStrContent 兼容装箱)
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_agen_norm_lenok");
        vm.label("_agen_norm_objlen");
        vm.cmpImm(VReg.V0, 0x7FFD); // 仅对象走 length 属性读;其余 len=0
        vm.jne("_agen_norm_len0");
        // [Number wrapper guard] 脱壳查类型字节:仅 TYPE_OBJECT(2)/TYPE_CLOSURE(3)/
        // TYPE_PROXY(8) 是属性容器(有 props_ptr 可遍历),可安全调用 _object_get;
        // 其余 0x7FFD 对象(Date=7/Promise=11/DataView=14 等)直接 len=0,
        // 避免 _object_get 冷分支对非属性布局解引用 proto@16 崩(SIGSEGV)。
        vm.movImm64(VReg.V2, 0x0000ffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V2); // V2 = 裸对象指针
        vm.loadByte(VReg.V3, VReg.V2, 0);  // V3 = 类型字节
        vm.cmpImm(VReg.V3, 2);             // TYPE_OBJECT
        vm.jeq("_agen_norm_objlen_ok");
        vm.cmpImm(VReg.V3, 3);             // TYPE_CLOSURE (classinfo)
        vm.jeq("_agen_norm_objlen_ok");
        vm.cmpImm(VReg.V3, 8);             // TYPE_PROXY
        vm.jeq("_agen_norm_objlen_ok");
        // [Number wrapper / Boolean wrapper] TYPE_OBJECT(=2) → length 读走 _object_get;
        // 含 Number 包装对象、Boolean 包装对象、普通对象、{} 字面量。其余类型(含裸指针
        // 高16=0 但 type 非 2/3/8 的损坏值)一律 len=0。
        vm.jmp("_agen_norm_len0");
        vm.label("_agen_norm_objlen_ok");
        // _object_get 已支持装箱 proto 原型链遍历(obj/index.js L1593-1614,识别
        // 高16位!0 为装箱值并直接用作递归 A0),旧 guard 反而将正常对象的 length
        // 截断为 0 → 回调型泛型方法(如 Array.prototype.reduceRight.call(obj))
        // 迭代零次 → 测试断言 !="true"。
        vm.label("_agen_norm_objlen_get");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        boxStr(VReg.A1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter"); // RET = boxed length 值
        // x64 陷阱:V0==RET==RAX,tag 检查必须用 V2(否则冲掉 boxed length)
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFB); // undefined → 0
        vm.jeq("_agen_norm_len0");
        // [I3] length 是 Symbol → ToNumber(Symbol) abrupt,抛 TypeError。_to_int32 不处理
        // Symbol(裸堆指针走 _number_coerce 直接 SIGSEGV);此前 findIndex 等未暴露成值读取,
        // 本路径不可达,暴露后 test262 return-abrupt-from-this-length-as-symbol 触雷,就地拦。
        vm.mov(VReg.S3, VReg.RET);  // 存 boxed length(_is_symbol 毁 A0/RET)
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_symbol");      // RET = 0/1
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_norm_len_sym");
        vm.mov(VReg.A0, VReg.S3);   // 还原 length
        vm.call("_to_int32"); // boxed → 裸 int32(ToLength 近似)
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_agen_norm_lenok"); // 负 → 0
        vm.label("_agen_norm_len0");
        vm.movImm(VReg.S1, 0);
        vm.label("_agen_norm_lenok");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET); // result(callee-saved,落栈 GC 可见)
        vm.movImm(VReg.S3, 0); // i
        vm.label("_agen_norm_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_agen_norm_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0); // boxed 数字下标
        vm.call("_subscript_get"); // RET = 元素(boxed;miss → undefined)
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push"); // 可能扩容重分配 → 回写 S2
        vm.mov(VReg.S2, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_agen_norm_loop");
        vm.label("_agen_norm_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S2, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1); // 归一化装箱
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_agen_norm_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Array.prototype method called on null or undefined"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0); // 理论不达
        vm.label("_agen_norm_len_sym");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert a Symbol value to a number"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0); // 理论不达

        // _agen_tolength(A0=recv boxed) -> RET 裸 length(int32 近似 ToLength)。
        // null/undefined → TypeError; Symbol length → TypeError; 字符串→strlen;
        // 真数组→_array_length; 属性容器对象→ToLength(length); 数字/布尔先 ToObject。
        // 与 _agen_norm 长度分支同源,供回调活读路径在不物化快照数组的前提下取 length。
        // 注意:本 helper 不回写装箱后的 receiver;调用方须先 `_agen_toobject` 更新 S0。
        vm.label("_agen_tolength");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.call("_agen_toobject"); // nullish TypeError; num/bool → wrapper
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); // 字符串
        vm.jne("_agen_tol_obj");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_tol_obj");
        vm.cmpImm(VReg.V0, 0x7FFE); // 真数组或 TypedArray
        vm.jne("_agen_tol_notarr");
        // 仅 TYPE_ARRAY 用 _array_length；TypedArray 走属性 length（含 resizable）
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V1, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jne("_agen_tol_notarr");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_tol_notarr");
        // 函数(0x7FFF)可作 array-like(侧表存 length/下标);走 _object_get("length")。
        // 此前仅认 0x7FFD → Function 接收者 len=0 → indexOf 恒 -1。
        // TypedArray 亦由此取 length（resizable / OOB 由 getter 抛 RangeError）。
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_agen_tol_get");
        // TypedArray 值是**裸堆指针**(高16=0):此前落 _agen_tol_zero → 泛型
        // `Array.prototype.map.call(ta, …)` / indexOf / join 全部当 len=0 空转
        // (test262 harness 的 compareArray.format 正是这条路 → 断言消息里 TA 一律印 "[]")。
        // TA 布局 [type@0, length@8, 内联元素@16] 与 length@8 同址,直接读。
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_tol_notraw");
        vm.movImm64(VReg.V2, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V2);
        vm.jlt("_agen_tol_zero");
        vm.loadByte(VReg.V3, VReg.S0, 0);
        vm.cmpImm(VReg.V3, 1); // TYPE_ARRAY(裸数组头)
        vm.jeq("_agen_tol_arr_raw");
        vm.cmpImm(VReg.V3, 0x40);
        vm.jlt("_agen_tol_notraw");
        vm.cmpImm(VReg.V3, 0x7f);
        vm.jgt("_agen_tol_notraw");
        vm.load(VReg.RET, VReg.S0, 8); // TypedArray length
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_tol_arr_raw");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_tol_notraw");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_agen_tol_zero");
        vm.movImm64(VReg.V2, 0x0000ffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V2);
        vm.loadByte(VReg.V3, VReg.V2, 0);
        vm.cmpImm(VReg.V3, 2); // TYPE_OBJECT
        vm.jeq("_agen_tol_get");
        vm.cmpImm(VReg.V3, 3); // TYPE_CLOSURE
        vm.jeq("_agen_tol_get");
        vm.cmpImm(VReg.V3, 8); // TYPE_PROXY
        vm.jeq("_agen_tol_get");
        vm.jmp("_agen_tol_zero");
        vm.label("_agen_tol_get");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        boxStr(VReg.A1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFB);
        vm.jeq("_agen_tol_zero");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_tol_sym");
        // ToLength:Inf→2^53-1、NaN/-Inf→0;禁 _to_int32(其把 Inf 归 0 → every/indexOf 空转)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_number_coerce");
        vm.shrImm(VReg.V1, VReg.RET, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jeq("_agen_tol_nonfinite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.RET, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_agen_tol_clamp");
        vm.movImm(VReg.RET, 0);
        vm.label("_agen_tol_clamp");
        // ToLength:min(n, 2^53-1)
        vm.movImm64(VReg.V0, 9007199254740991n);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jle("_agen_tol_ok");
        vm.mov(VReg.RET, VReg.V0);
        vm.label("_agen_tol_ok");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_tol_nonfinite");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V1, VReg.RET, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_agen_tol_zero"); // NaN
        vm.shrImm(VReg.V1, VReg.RET, 63);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_agen_tol_zero"); // -Inf
        vm.movImm64(VReg.RET, 9007199254740991n); // +Inf → 2^53-1
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_tol_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_tol_sym");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert a Symbol value to a number"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _agen_has_idx(A0=boxed recv, A1=bare index) -> RET 0/1
        // HasProperty 近似:真数组走稠密槽+侧表 accessor+Array.prototype;
        // String 包装(__value)按界内恒 true;其余走 _prop_in(原型链+setter-only)。
        // 不可用 _object_has:其对 setter-only/部分原型索引会假阴性 → 误跳 hole。
        // 不可委托 `_prop_in` 的 TYPE_ARRAY 支路(仅稠密 hole,不看侧表/原型)。
        vm.label("_agen_has_idx");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // bare idx
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE); // 真数组或 TypedArray
        vm.jne("_agen_has_idx_not_arrtag");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V1, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jeq("_agen_has_arr");
        // TypedArray HasProperty:走下方 _prop_in 通用路径（勿读 Array data@24）
        vm.jmp("_agen_has_idx_prop_in");
        vm.label("_agen_has_idx_not_arrtag");
        vm.cmpImm(VReg.V0, 0x7FFC); // 原始字符串
        vm.jeq("_agen_has_yes");
        // String 包装:自有 __value
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        boxStr(VReg.A1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_has_yes");
        vm.label("_agen_has_idx_prop_in");
        // _prop_in(rawObj, keyContent)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_unbox");
        vm.mov(VReg.S2, VReg.RET); // raw obj
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_prop_in");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_has_arr");
        // Array exotic HasProperty(integer index):越界→false;否则 own 稠密/侧表再原型。
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S2, VReg.S0, VReg.V4); // raw arr
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_agen_has_no");
        vm.load(VReg.V0, VReg.S2, 8); // length
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_agen_has_no");
        // 稠密槽!=0 → present
        vm.load(VReg.V1, VReg.S2, 24); // data_ptr
        vm.shl(VReg.V2, VReg.S1, 3);
        vm.add(VReg.V2, VReg.V1, VReg.V2);
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_agen_has_yes");
        // 侧表 accessor / setter-only(须传裸指针;装箱 0x7FFE 会让 _closure_props_find miss)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_side_elem_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_has_yes");
        // 兜底: _object_has 自有(含侧表,不依赖 ARR_HAS_SIDETABLE 热位)
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); // boxed arr(_object_has 认 0x7FFE)
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_has_yes");
        // Array.prototype(及更上) — `_prop_in` 对 TYPE_OBJECT 走原型链
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_agen_has_no");
        vm.call("_js_unbox");
        vm.mov(VReg.S2, VReg.RET);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_prop_in");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_has_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_has_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // _agen_get_idx(A0=boxed recv, A1=bare index) -> boxed 元素。
        // 活读 Get:真数组=侧表 accessor → 稠密 → Array.prototype([[Get]] this=数组);
        // 原始串/String 包装走 _str_index_char;其余 _subscript_get。
        vm.label("_agen_get_idx");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // bare idx
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_get_idx_not_arrtag");
        // 0x7FFE = 真 Array 或 TypedArray；仅 type@0==TYPE_ARRAY 走稠密/侧表
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V1, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jeq("_agen_get_arr");
        vm.jmp("_agen_get_sub"); // TypedArray → _subscript_get（含 bounds/detach）
        vm.label("_agen_get_idx_not_arrtag");
        vm.cmpImm(VReg.V0, 0x7FFC); // 原始字符串
        vm.jeq("_agen_get_str");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_agen_get_sub");
        // String 包装? 自有 __value
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        boxStr(VReg.A1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_get_sub");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        boxStr(VReg.A1);
        vm.call("_object_get");
        vm.mov(VReg.S2, VReg.RET); // __value (boxed str)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_str_index_char");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_get_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_str_index_char");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_get_arr");
        // 侧表优先(defineProperty accessor / setter-only → undefined);传裸指针
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S2, VReg.S0, VReg.V4); // raw
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_side_elem_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_get_arr_dense");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_side_elem_get"); // this 已 boxArrThis
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_get_arr_dense");
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_agen_get_arr_undef");
        vm.load(VReg.V0, VReg.S2, 8);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_agen_get_arr_undef");
        vm.load(VReg.V1, VReg.S2, 24);
        vm.shl(VReg.V2, VReg.S1, 3);
        vm.add(VReg.V2, VReg.V1, VReg.V2);
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_agen_get_arr_own_or_proto"); // hole → 自有侧表兜底或原型
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_get_arr_own_or_proto");
        // 稠密 hole 但可能是 setter-only 自有: [[Get]] → undefined(不走原型)
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_get_arr_undef"); // own setter-only / 侧表已由上方 miss → undefined
        vm.label("_agen_get_arr_proto");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_agen_get_arr_undef");
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET); // boxed key
        vm.mov(VReg.A0, VReg.S2); // Array.prototype
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0); // this = 装箱数组 receiver
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_get_arr_undef");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_get_sub");
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A1, 0);
        vm.call("_subscript_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // 回调型两参(recv, cb[, thisArg])泛型 wrapper:
        // 真数组 → _array_*_rt_t(A2=0,A3=thisArg); 非数组 → 活读(_agen_tolength + Get)。
        // forEach/map/filter/some/every:HasProperty 跳 hole;find/findIndex:ES 用 Get 访洞(传 undefined)。
        // 第三参保留原始 receiver,回调期间变异可见。
        // A2=thisArg(方法引用/`.call` 经 _aref_generic 上移后落此;缺省为 UNDEF)。
        // flatMap 仍走快照(展开语义复杂,低 FAIL 簇)。
        const _cb2Live = [
            // [label, rt_t, kind] kind: foreach|map|filter|some|every|find|findIndex|findLast|findLastIndex
            ["_agen_forEach", "_array_forEach_rt_t", "foreach"],
            ["_agen_map", "_array_map_rt_t", "map"],
            ["_agen_filter", "_array_filter_rt_t", "filter"],
            ["_agen_some", "_array_some_rt_t", "some"],
            ["_agen_every", "_array_every_rt_t", "every"],
            ["_agen_find", "_array_find_rt_t", "find"],
            ["_agen_findIndex", "_array_findIndex_rt_t", "findIndex"],
            ["_agen_findLast", "_array_findLast_rt_t", "findLast"],
            ["_agen_findLastIndex", "_array_findLastIndex_rt_t", "findLastIndex"],
        ];
        for (let ci = 0; ci < _cb2Live.length; ci++) {
            const label = _cb2Live[ci][0];
            const target = _cb2Live[ci][1];
            const kind = _cb2Live[ci][2];
            const liveLbl = "__" + label + "_live";
            const loopLbl = "__" + label + "_loop";
            const nextLbl = "__" + label + "_next";
            const doneLbl = "__" + label + "_done";
            const skipHasLbl = "__" + label + "_skiphas";
            const hasOkLbl = "__" + label + "_hasok";
            const trueArr = "__" + label + "_tarr";
            const visitHoles = (kind === "find" || kind === "findIndex" || kind === "findLast" || kind === "findLastIndex");
            const reverse = (kind === "findLast" || kind === "findLastIndex");

            vm.label(label);
            // map/filter 需要结果数组(S4)+elem 槽;find/findLast 需要 elem 槽;S5=thisArg 一律保存
            const needSlot = (kind === "filter" || kind === "find" || kind === "findLast" || kind === "map");
            const saved = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
            const frame = needSlot ? 16 : 0;
            vm.prologue(frame, saved);
            vm.mov(VReg.S0, VReg.A0); // recv
            vm.mov(VReg.S1, VReg.A1); // cb
            vm.mov(VReg.S5, VReg.A2); // thisArg
            vm.shrImm(VReg.V0, VReg.S0, 48);
            vm.cmpImm(VReg.V0, 0x7FFE);
            vm.jeq(trueArr);
            // --- live non-array path (ToObject 原始 this) ---
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_agen_toobject");
            vm.mov(VReg.S0, VReg.RET);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_agen_tolength");
            vm.mov(VReg.S2, VReg.RET); // len
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_aref_require_cb"); // IsCallable after ToLength (ES)
            if (kind === "map") {
                vm.mov(VReg.A0, VReg.S2);
                vm.call("_array_new_with_size"); // 预分配 len,holes 保持 0
                vm.mov(VReg.S4, VReg.RET); // result bare
            } else if (kind === "filter") {
                vm.movImm(VReg.A0, 0);
                vm.call("_array_new_with_size");
                vm.mov(VReg.S4, VReg.RET);
            }
            if (reverse) {
                vm.subImm(VReg.S3, VReg.S2, 1); // i = len-1
            } else {
                vm.movImm(VReg.S3, 0); // i
            }
            vm.label(loopLbl);
            if (reverse) {
                vm.cmpImm(VReg.S3, 0);
                vm.jlt(doneLbl);
            } else {
                vm.cmp(VReg.S3, VReg.S2);
                vm.jge(doneLbl);
            }
            if (!visitHoles) {
                // HasProperty: _agen_has_idx(字符串/String 包装/原型链/setter-only)
                vm.mov(VReg.A0, VReg.S0);
                vm.mov(VReg.A1, VReg.S3);
                vm.call("_agen_has_idx");
                vm.cmpImm(VReg.RET, 0);
                vm.jeq(nextLbl);
            }
            // live Get: _agen_get_idx(原型链/accessor/String)
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_agen_get_idx");
            if (kind === "filter" || kind === "find" || kind === "findLast") {
                vm.store(VReg.SP, 0, VReg.RET); // 保活 element
            }
            vm.mov(VReg.A0, VReg.RET);
            vm.scvtf(0, VReg.S3);
            vm.fmovToInt(VReg.A1, 0);
            vm.mov(VReg.A2, VReg.S0); // 第三参 = 原始 receiver
            vm.mov(VReg.A3, VReg.S1);
            vm.mov(VReg.A4, VReg.S5); // thisArg
            vm.call("_aref_invoke_cbt");
            if (kind === "foreach") {
                // 忽略返回值
            } else if (kind === "some") {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");
                vm.cmpImm(VReg.RET, 0);
                vm.jne("__" + label + "_true");
            } else if (kind === "every") {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");
                vm.cmpImm(VReg.RET, 0);
                vm.jeq("__" + label + "_false");
            } else if (kind === "map") {
                // result[i] = mapped (保留 holes:仅对存在下标 Set)
                vm.mov(VReg.A2, VReg.RET); // value
                vm.emitMaskLoad(VReg.V1);
                vm.andMaskReg(VReg.A0, VReg.S4, VReg.V1);
                vm.movImm64(VReg.V1, 0x7ffe000000000000n);
                vm.or(VReg.A0, VReg.A0, VReg.V1); // boxed result
                vm.mov(VReg.A1, VReg.S3); // bare index
                vm.call("_array_set");
            } else if (kind === "filter") {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");
                vm.cmpImm(VReg.RET, 0);
                vm.jeq(nextLbl);
                vm.load(VReg.A1, VReg.SP, 0);
                vm.mov(VReg.A0, VReg.S4);
                vm.call("_array_push");
                vm.mov(VReg.S4, VReg.RET);
            } else if (kind === "find" || kind === "findLast") {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");
                vm.cmpImm(VReg.RET, 0);
                vm.jne("__" + label + "_found");
            } else if (kind === "findIndex" || kind === "findLastIndex") {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");
                vm.cmpImm(VReg.RET, 0);
                vm.jne("__" + label + "_found");
            }
            vm.label(nextLbl);
            if (reverse) {
                vm.subImm(VReg.S3, VReg.S3, 1);
            } else {
                vm.addImm(VReg.S3, VReg.S3, 1);
            }
            vm.jmp(loopLbl);
            vm.label(doneLbl);
            if (kind === "foreach") {
                vm.movImm64(VReg.RET, UNDEF);
            } else if (kind === "some") {
                vm.lea(VReg.V0, "_js_false");
                vm.load(VReg.RET, VReg.V0, 0);
            } else if (kind === "every") {
                vm.lea(VReg.V0, "_js_true");
                vm.load(VReg.RET, VReg.V0, 0);
            } else if (kind === "map" || kind === "filter") {
                vm.emitMaskLoad(VReg.V1);
                vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
                vm.movImm64(VReg.V1, 0x7ffe000000000000n);
                vm.or(VReg.RET, VReg.RET, VReg.V1);
            } else if (kind === "find" || kind === "findLast") {
                vm.movImm64(VReg.RET, UNDEF);
            } else if (kind === "findIndex" || kind === "findLastIndex") {
                vm.movImm(VReg.S3, -1);
                vm.scvtf(0, VReg.S3);
                vm.fmovToInt(VReg.RET, 0);
            }
            vm.epilogue(saved, frame);
            if (kind === "some") {
                vm.label("__" + label + "_true");
                vm.lea(VReg.V0, "_js_true");
                vm.load(VReg.RET, VReg.V0, 0);
                vm.epilogue(saved, frame);
            } else if (kind === "every") {
                vm.label("__" + label + "_false");
                vm.lea(VReg.V0, "_js_false");
                vm.load(VReg.RET, VReg.V0, 0);
                vm.epilogue(saved, frame);
            } else if (kind === "find" || kind === "findLast") {
                vm.label("__" + label + "_found");
                vm.load(VReg.RET, VReg.SP, 0);
                vm.epilogue(saved, frame);
            } else if (kind === "findIndex" || kind === "findLastIndex") {
                vm.label("__" + label + "_found");
                vm.scvtf(0, VReg.S3);
                vm.fmovToInt(VReg.RET, 0);
                vm.epilogue(saved, frame);
            }
            // true array fast path
            vm.label(trueArr);
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S1);
            vm.movImm(VReg.A2, 0); // origRecv=0 → 用 arr
            vm.mov(VReg.A3, VReg.S5); // thisArg
            vm.call(target);
            vm.epilogue(saved, frame);
        }

        // flatMap: 仍走快照 norm(展开一层;活读收益低);A2=thisArg 透传
        vm.label("_agen_flatMap");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A0); // recv
        vm.mov(VReg.S0, VReg.A1); // cb
        vm.mov(VReg.S2, VReg.A2); // thisArg
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("__agen_flatMap_norm");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.movImm(VReg.A2, 0);
        vm.mov(VReg.A3, VReg.S2);
        vm.call("_array_flatMap_rt_t");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("__agen_flatMap_norm");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_agen_norm");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1); // origRecv = 原始 recv
        vm.mov(VReg.A3, VReg.S2); // thisArg
        vm.call("_array_flatMap_rt_t");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // 回调+seed 三参(recv, cb, seed):reduce/reduceRight — 非数组活读+跳 hole
        const _cb3Live = [
            ["_agen_reduce", "_array_reduce_rt", false],
            ["_agen_reduceRight", "_array_reduceRight_rt", true],
        ];
        for (let ci = 0; ci < _cb3Live.length; ci++) {
            const label = _cb3Live[ci][0];
            const target = _cb3Live[ci][1];
            const right = _cb3Live[ci][2];
            const liveLbl = "__" + label + "_live";
            const loopLbl = "__" + label + "_loop";
            const nextLbl = "__" + label + "_next";
            const doneLbl = "__" + label + "_done";
            const noseedLbl = "__" + label + "_noseed";
            const emptyLbl = "__" + label + "_empty";
            const skipHasLbl = "__" + label + "_skiphas";
            const hasOkLbl = "__" + label + "_hasok";
            const trueArr = "__" + label + "_tarr";
            const initLoop = "__" + label + "_initloop";
            const initNext = "__" + label + "_initnext";

            vm.label(label);
            vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
            vm.mov(VReg.S0, VReg.A0); // recv
            vm.mov(VReg.S1, VReg.A1); // cb
            vm.mov(VReg.S4, VReg.A2); // seed (maybe undef)
            vm.shrImm(VReg.V0, VReg.S0, 48);
            vm.cmpImm(VReg.V0, 0x7FFE);
            vm.jeq(trueArr);
            // live (ToObject 原始 this)
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_agen_toobject");
            vm.mov(VReg.S0, VReg.RET);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_agen_tolength");
            vm.mov(VReg.S2, VReg.RET); // len
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_aref_require_cb"); // IsCallable after ToLength (ES)
            vm.shrImm(VReg.V0, VReg.S4, 48);
            vm.cmpImm(VReg.V0, 0x7FFB); // seed === undefined?
            vm.jeq(noseedLbl);
            if (right) {
                vm.subImm(VReg.S3, VReg.S2, 1); // i = len-1
            } else {
                vm.movImm(VReg.S3, 0);
            }
            vm.jmp(loopLbl);
            vm.label(noseedLbl);
            vm.cmpImm(VReg.S2, 0);
            vm.jeq(emptyLbl);
            // 找第一个存在的元素作 acc
            if (right) {
                vm.subImm(VReg.S3, VReg.S2, 1);
            } else {
                vm.movImm(VReg.S3, 0);
            }
            vm.label(initLoop);
            if (right) {
                vm.cmpImm(VReg.S3, 0);
                vm.jlt(emptyLbl);
            } else {
                vm.cmp(VReg.S3, VReg.S2);
                vm.jge(emptyLbl);
            }
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_agen_has_idx");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq(initNext);
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_agen_get_idx");
            vm.mov(VReg.S4, VReg.RET); // acc
            if (right) {
                vm.subImm(VReg.S3, VReg.S3, 1);
            } else {
                vm.addImm(VReg.S3, VReg.S3, 1);
            }
            vm.jmp(loopLbl);
            vm.label(initNext);
            if (right) {
                vm.subImm(VReg.S3, VReg.S3, 1);
            } else {
                vm.addImm(VReg.S3, VReg.S3, 1);
            }
            vm.jmp(initLoop);
            vm.label(loopLbl);
            if (right) {
                vm.cmpImm(VReg.S3, 0);
                vm.jlt(doneLbl);
            } else {
                vm.cmp(VReg.S3, VReg.S2);
                vm.jge(doneLbl);
            }
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_agen_has_idx");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq(nextLbl);
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_agen_get_idx");
            vm.mov(VReg.A1, VReg.RET); // cur
            vm.mov(VReg.A0, VReg.S4);  // acc
            vm.scvtf(0, VReg.S3);
            vm.fmovToInt(VReg.A2, 0);  // idx
            vm.mov(VReg.A3, VReg.S0);  // orig recv
            vm.mov(VReg.A4, VReg.S1);  // cb
            vm.call("_aref_invoke_cb4");
            vm.mov(VReg.S4, VReg.RET);
            vm.label(nextLbl);
            if (right) {
                vm.subImm(VReg.S3, VReg.S3, 1);
            } else {
                vm.addImm(VReg.S3, VReg.S3, 1);
            }
            vm.jmp(loopLbl);
            vm.label(doneLbl);
            vm.mov(VReg.RET, VReg.S4);
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
            vm.label(emptyLbl);
            // len==0(或全 hole)且无 seed → TypeError(ES 23.1.3.24/25 step 5)
            vm.lea(VReg.A0, vm.asm.addString("Reduce of empty array with no initial value"));
            boxStr(VReg.A0);
            vm.call("_throw_type_error"); // 不返回
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0); // 理论不达
            vm.label(trueArr);
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S1);
            vm.mov(VReg.A2, VReg.S4);
            vm.movImm(VReg.A3, 0);
            vm.call(target);
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        }

        // (旧 _cb2Fast/_cb3Fast norm 委托已由上方 live 路径替代)

        // _agen_indexOf(A0=recv, A1=value, A2=boxed from) → boxed 数字。
        // 统一活读(含真数组):ToObject+ToLength;len==0 立即 -1;再 ToInteger(from)+HasProperty+Get+===。
        // 复用 _agen_has_idx/_agen_get_idx(侧表 accessor/Array.prototype/String)。
        vm.label("_agen_indexOf");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // value
        vm.mov(VReg.S4, VReg.A2); // boxed from
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_agen_indexOf_miss"); // len==0:不得 ToInteger(from)
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_aref_fromindex"); // from 缺省 0;+Inf 哨兵 ≥ len → miss
        vm.mov(VReg.S3, VReg.RET); // i
        // 负 fromIndex: i = max(len + from, 0)
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_agen_indexOf_from_ok");
        vm.add(VReg.S3, VReg.S2, VReg.S3);
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_agen_indexOf_from_ok");
        vm.movImm(VReg.S3, 0);
        vm.label("_agen_indexOf_from_ok");
        vm.label("_agen_indexOf_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_agen_indexOf_miss");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_indexOf_next");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_indexOf_hit");
        vm.label("_agen_indexOf_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_agen_indexOf_loop");
        vm.label("_agen_indexOf_hit");
        vm.mov(VReg.RET, VReg.S3);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_agen_indexOf_miss");
        vm.movImm(VReg.RET, -1);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // _agen_lastIndexOf(A0=recv, A1=value, A2=boxed from) → boxed 数字。
        // 统一活读(含真数组):从 min(from,len-1) 向前 HasProperty+Get+===。
        vm.label("_agen_lastIndexOf");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // value
        vm.mov(VReg.S4, VReg.A2); // boxed from
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_agen_lastIndexOf_miss");
        vm.mov(VReg.A0, VReg.S4);
        vm.movImm(VReg.A1, 2147483647);
        vm.call("_aref_argint_d"); // from 缺省 INT_MAX
        vm.mov(VReg.S3, VReg.RET); // i
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_agen_lastIndexOf_clamp_hi");
        vm.add(VReg.S3, VReg.S3, VReg.S2); // 负: len+from
        vm.label("_agen_lastIndexOf_clamp_hi");
        vm.subImm(VReg.V0, VReg.S2, 1); // len-1
        vm.cmp(VReg.S3, VReg.V0);
        vm.jle("_agen_lastIndexOf_loop");
        vm.mov(VReg.S3, VReg.V0);
        vm.label("_agen_lastIndexOf_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_agen_lastIndexOf_miss");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_lastIndexOf_next");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_lastIndexOf_hit");
        vm.label("_agen_lastIndexOf_next");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_agen_lastIndexOf_loop");
        vm.label("_agen_lastIndexOf_hit");
        vm.mov(VReg.RET, VReg.S3);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_agen_lastIndexOf_miss");
        vm.movImm(VReg.RET, -1);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // _agen_includes(A0=recv, A1=value, A2=boxed from) → JS bool。
        vm.label("_agen_includes");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A1);
        vm.mov(VReg.S1, VReg.A2);
        vm.call("_agen_norm");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_argint"); // boxed from → 裸(缺省 0)
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_includes"); // 裸 0/1
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_includes_true");
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_includes_true");
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // _agen_join(A0=recv, A1=sep) → 字符串。sep undefined → ",";类数组活读(禁 norm)。
        vm.label("_agen_join");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // sep
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_agen_join_sep_ok");
        vm.lea(VReg.S1, "_str_comma_only");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V0);
        vm.label("_agen_join_sep_ok");
        // TypedArray 接收者(裸堆指针,类型字节 [0x40,0x7f]):typed 布局元素内联在 @16,
        // _array_join 按 data_ptr@24 读 → `Array.prototype.join.call(ta)` 恒得空串。
        // 委托 typed 专用 _ta_join(test262 用它拼断言消息,也是 toString/toLocaleString 的底)。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_join_notta");
        vm.movImm64(VReg.V4, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V4);
        vm.jlt("_agen_join_notta");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 0x40);
        vm.jlt("_agen_join_notta");
        vm.cmpImm(VReg.V0, 0x7f);
        vm.jgt("_agen_join_notta");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_ta_join");
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_agen_join_notta");
        // 真数组 → _array_join;类数组 → 活读拼串
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_join_live");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_join_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_join");
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_agen_join_live");
        // 复用 _array_join 的 Get 路径:临时要求 recv 走 Get——对类数组亦可用
        // _array_join 现以 _agen_get_idx,对对象 recv 可行。直接调。
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_join");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _agen_slice(A0=recv, A1=boxed start, A2=boxed end) → 新数组。
        vm.label("_agen_slice");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A1);
        vm.mov(VReg.S1, VReg.A2);
        vm.call("_agen_norm");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_aref_arr_slice");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _agen_at(A0=recv, A1=boxed idx) → 元素。
        vm.label("_agen_at");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A1);
        vm.call("_agen_norm");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_aref_arr_at");
        vm.epilogue([VReg.S0], 0);

        // Simple wrapper generators for methods that take 0 args + receiver.
        // Tag guard: 0x7FFE receiver skips _agen_norm (fast path for true arrays);
        // non-array receiver (e.g. via .call()) gets normalized first.
        const agen0 = (label, target) => {
            const fastLabel = "__agen0_native_" + label;
            vm.label(label);
            vm.prologue(0, [VReg.S0]);
            vm.shrImm(VReg.V0, VReg.A0, 48);
            vm.movImm(VReg.V1, 0x7FFE);
            vm.cmp(VReg.V0, VReg.V1);
            vm.jeq(fastLabel);             // already a boxed array, skip norm
            vm.call("_agen_norm");
            vm.mov(VReg.A0, VReg.RET);
            vm.label(fastLabel);
            vm.call(target);
            vm.epilogue([VReg.S0], 0);
        };
        // 1 arg + receiver
        const agen1 = (label, target) => {
            const fastLabel = "__agen1_native_" + label;
            vm.label(label);
            vm.prologue(0, [VReg.S0]);
            vm.mov(VReg.S0, VReg.A1);
            vm.shrImm(VReg.V0, VReg.A0, 48);
            vm.movImm(VReg.V1, 0x7FFE);
            vm.cmp(VReg.V0, VReg.V1);
            vm.jeq(fastLabel);             // already a boxed array, skip norm
            vm.call("_agen_norm");
            vm.mov(VReg.A0, VReg.RET);
            vm.label(fastLabel);
            vm.mov(VReg.A1, VReg.S0);
            vm.call(target);
            vm.epilogue([VReg.S0], 0);
        };
        agen0("_agen_reverse", "_array_reverse");

        // ES2023 非破坏:toReversed / toSorted / with —— 先快照再变副本。
        // 真数组:_array_slice 全拷贝;类数组:_agen_norm 快照。
        vm.label("_agen_toReversed");
        vm.prologue(0, [VReg.S0]);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_torev_norm");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_torev_norm");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V4);
        vm.movImm(VReg.A1, 0);
        vm.movImm(VReg.A2, 2147483647);
        vm.call("_array_slice");
        vm.jmp("_agen_torev_rev");
        vm.label("_agen_torev_norm");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_norm");
        vm.label("_agen_torev_rev");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_array_reverse");
        vm.epilogue([VReg.S0], 0);

        vm.label("_agen_toSorted");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // comparefn | undefined
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_tosort_norm");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_tosort_norm");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V4);
        vm.movImm(VReg.A1, 0);
        vm.movImm(VReg.A2, 2147483647);
        vm.call("_array_slice");
        vm.jmp("_agen_tosort_do");
        vm.label("_agen_tosort_norm");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_norm");
        vm.label("_agen_tosort_do");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_sort_cmp");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _agen_with(A0=recv, A1=boxed idx, A2=val)
        vm.label("_agen_with");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_with_norm");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_with_norm");
        vm.jmp("_agen_with_do");
        vm.label("_agen_with_norm");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_norm");
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_agen_with_do");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_to_int32");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_array_with");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // _agen_toSpliced(A0=recv, A1=start, A2=delCount, A3..=items via argc 有限)
        // 简化:norm/快照后委托 _array_toSpliced;items 仅 A3 单槽(与 compile 截断同形)。
        vm.label("_agen_toSpliced");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_tosplice_norm");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_tosplice_norm");
        vm.jmp("_agen_tosplice_do");
        vm.label("_agen_tosplice_norm");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_norm");
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_agen_tosplice_do");
        // start/delCount:缺省 undefined → ToInteger 0;A1/A2 可能已是装箱
        vm.mov(VReg.A0, VReg.S1);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_agen_tosplice_s1");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_agen_tosplice_s2");
        vm.label("_agen_tosplice_s1");
        vm.call("_to_int32");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_agen_tosplice_s2");
        vm.mov(VReg.A0, VReg.S2);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_agen_tosplice_d1");
        vm.movImm(VReg.S2, 0);
        vm.jmp("_agen_tosplice_call");
        vm.label("_agen_tosplice_d1");
        vm.call("_to_int32");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_agen_tosplice_call");
        // items:无参 → 空数组
        vm.shrImm(VReg.V0, VReg.S3, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_agen_tosplice_items");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.S3, VReg.RET);
        vm.label("_agen_tosplice_items");
        // 单值非数组 → 包成单元素数组(compile 路径同形简化:直接当 itemsArr 若已是数组)
        vm.shrImm(VReg.V0, VReg.S3, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_agen_tosplice_go");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_push");
        vm.mov(VReg.S3, VReg.RET);
        vm.label("_agen_tosplice_go");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.mov(VReg.A3, VReg.S3);
        vm.call("_array_toSpliced");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // _agen_shift:真数组 → _array_shift;类数组活读左移(禁 _agen_norm 快照)。
        vm.label("_agen_shift");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_shift_live");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_shift_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_shift");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_agen_shift_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S1, VReg.RET); // len
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_agen_shift_undef");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 16, VReg.RET); // first
        vm.movImm(VReg.S2, 1);
        vm.label("_agen_sh_loop");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_agen_sh_tail");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_sh_del");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.subImm(VReg.V0, VReg.S2, 1);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_subscript_set");
        vm.jmp("_agen_sh_next");
        vm.label("_agen_sh_del");
        vm.subImm(VReg.V0, VReg.S2, 1);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        vm.label("_agen_sh_next");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_agen_sh_loop");
        vm.label("_agen_sh_tail");
        vm.subImm(VReg.S2, VReg.S1, 1);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw");
        vm.load(VReg.RET, VReg.SP, 16);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_agen_shift_undef");
        // ES:len==0 → Set(O,"length",0,true) 后返 undefined(A2_T1 / frozen TypeError)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.V0, 0);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _agen_pop:真数组 → _array_pop;类数组活读 Get/Delete/Set length(不快照)。
        vm.label("_agen_pop");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_pop_live");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_pop_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_pop");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_agen_pop_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_agen_pop_undef");
        vm.subImm(VReg.S1, VReg.S1, 1); // idx
        vm.store(VReg.SP, 8, VReg.S1); // 保 idx(跨 get/delete/_js_prop_key)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 0, VReg.RET); // value
        vm.load(VReg.S1, VReg.SP, 8);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        vm.load(VReg.S1, VReg.SP, 8); // idx
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_agen_pop_undef");
        // ES:len==0 → Set(O,"length",0,true) 后返 undefined(frozen → TypeError)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.V0, 0);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        // _agen_unshift:真数组 → _array_unshift;类数组活读右移+Set(0)+length。
        vm.label("_agen_unshift");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // value
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_unshift_live");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_unshift_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_unshift");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_agen_unshift_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.store(VReg.SP, 0, VReg.S2); // i = len
        vm.label("_agen_un_loop");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_agen_un_insert");
        vm.subImm(VReg.A1, VReg.V1, 1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_un_del");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.subImm(VReg.A1, VReg.V1, 1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.V1, VReg.SP, 0);
        vm.scvtf(0, VReg.V1);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_subscript_set");
        vm.jmp("_agen_un_next");
        vm.label("_agen_un_del");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.scvtf(0, VReg.V1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        vm.label("_agen_un_next");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.SP, 0, VReg.V1);
        vm.jmp("_agen_un_loop");
        vm.label("_agen_un_insert");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.V0, 0);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_subscript_set");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_object_set");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // [I3] 内建数组方法一等值(方法值读取)的运行时 helper。全部 _aref_generic-safe:
    // 接收者在 A0(boxed 真数组,实例值读取派发前已 tag 0x7FFE 守卫;泛型 .call 经
    // _agen_* 先 norm 成真数组再委托),用户实参上移到 A1..。回调型镜像 _array_*_rt
    // (运行时驱动回调 _aref_invoke_cb);flat/fill/copyWithin/迭代器为非回调型。
    // 新增 helper 不触碰任何既有共享热路径 → 直调字节不变。
    generateArefI3Methods() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;
        const BOXARR = 0x7ffe000000000000n;

        // arr.find(cb[, thisArg]) -> 命中元素(boxed)或 undefined(短路)。element 存栈槽 [SP+0]
        // (GC 扫栈可见)以跨回调保活、命中时返回。镜像 _array_filter_rt 的栈槽手法。
        // ES:用 Get 非 HasProperty → 洞也回调(传 undefined);不跳 hole。
        // _array_find_rt(A0=arr, A1=cb, A2=origRecv?0)
        // _array_find_rt_t(..., A3=thisArg)
        vm.label("_array_find_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_find_rt_t");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // cb
        vm.mov(VReg.S4, VReg.A2); // origRecv(0=arr)
        vm.mov(VReg.S5, VReg.A3); // thisArg
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.movImm(VReg.S3, 0);     // i
        vm.label("_find_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_find_undef");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");     // RET = element
        vm.store(VReg.SP, 0, VReg.RET); // 跨回调保活
        vm.mov(VReg.A0, VReg.RET); // arg0 = element
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);  // arg1 = 装箱 index
        vm.mov(VReg.A2, VReg.S4);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_find_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);  // arg2 = arr
        vm.label("_find_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);  // cb
        vm.mov(VReg.A4, VReg.S5);  // thisArg
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_find_found");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_find_loop");
        vm.label("_find_found");
        vm.load(VReg.RET, VReg.SP, 0); // 返回命中元素
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
        vm.label("_find_undef");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // findLast:从 len-1 向下,语义同 find(洞也回调)
        vm.label("_array_findLast_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_findLast_rt_t");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2);
        vm.mov(VReg.S5, VReg.A3);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb");
        vm.subImm(VReg.S3, VReg.S2, 1); // i = len-1
        vm.label("_findL_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_findL_undef");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_findL_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);
        vm.label("_findL_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_findL_found");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_findL_loop");
        vm.label("_findL_found");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
        vm.label("_findL_undef");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // findLastIndex
        vm.label("_array_findLastIndex_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_findLastIndex_rt_t");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2);
        vm.mov(VReg.S5, VReg.A3);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb");
        vm.subImm(VReg.S3, VReg.S2, 1);
        vm.label("_findLi_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_findLi_neg");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_findLi_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);
        vm.label("_findLi_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_findLi_box");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_findLi_loop");
        vm.label("_findLi_neg");
        vm.movImm(VReg.S3, -1);
        vm.label("_findLi_box");
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // arr.findIndex(cb[, thisArg]) -> 命中下标(装箱数字)或 -1(短路)。
        // _array_findIndex_rt(A0=arr, A1=cb, A2=origRecv?0)
        // _array_findIndex_rt_t(..., A3=thisArg)
        vm.label("_array_findIndex_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_findIndex_rt_t");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2); // origRecv(0=arr)
        vm.mov(VReg.S5, VReg.A3); // thisArg
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.movImm(VReg.S3, 0);
        vm.label("_findi_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_findi_neg");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET); // element
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_findi_cb_has_orig");
        vm.mov(VReg.A2, VReg.S0);
        vm.label("_findi_cb_has_orig");
        vm.mov(VReg.A3, VReg.S1);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_findi_box");      // S3 = 命中下标
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_findi_loop");
        vm.label("_findi_neg");
        vm.movImm(VReg.S3, -1);
        vm.label("_findi_box");
        vm.scvtf(0, VReg.S3);      // 装箱数字(同静态派发出口)
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // arr.flatMap(cb[, thisArg]) -> 新数组:cb(el,i,arr) 返回数组则展开一层、否则原样追加。
        // 结果(S4)裸头存 callee-saved,每轮 _array_push 回写;内层数组(S5)与循环变量 j
        // (栈槽 [SP+0])跨 _array_push 保活(GC 扫栈可见;_array_push 仅增长目标 data 区,
        // 不搬移内层对象,同 _array_flat 的内层展开纪律)。
        // _array_flatMap_rt / _array_flatMap_rt_t(A3=thisArg)
        vm.label("_array_flatMap_rt");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_array_flatMap_rt_t");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.store(VReg.SP, 8, VReg.A3); // thisArg → [SP+8]
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S4, VReg.RET); // result(裸头)
        vm.movImm(VReg.S3, 0);     // i
        vm.label("_fm_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_fm_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);
        vm.mov(VReg.A3, VReg.S1);
        vm.load(VReg.A4, VReg.SP, 8); // thisArg
        vm.call("_aref_invoke_cbt"); // RET = mapped
        vm.mov(VReg.S5, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S5, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_fm_push_one");
        // mapped 是数组:展开一层
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S5, VReg.S5, VReg.V4); // S5 = 内层(裸)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0); // j = 0
        vm.label("_fm_inner");
        vm.load(VReg.V0, VReg.S5, 8);      // 内层 len(每轮重载,S5 稳定)
        vm.load(VReg.V1, VReg.SP, 0);      // j
        vm.cmp(VReg.V1, VReg.V0);
        vm.jge("_fm_next");
        vm.load(VReg.V0, VReg.S5, 24);
        vm.shl(VReg.V2, VReg.V1, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V2);
        vm.load(VReg.A1, VReg.V0, 0);      // 内层元素
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S4, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);     // j++
        vm.jmp("_fm_inner");
        vm.label("_fm_push_one");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_array_push");
        vm.mov(VReg.S4, VReg.RET);
        vm.label("_fm_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_fm_loop");
        vm.label("_fm_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, BOXARR);
        vm.or(VReg.RET, VReg.RET, VReg.V1); // 装箱 0x7FFE
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // arr.flat(depth=1) -> 新数组。循环 _array_flat(深度 1)depth 次。depth 缺省
        // (undefined)→ 1;非数字经 _to_int32;depth<=0 → 返回原数组(记偏差:未浅拷贝)。
        vm.label("_array_flat_rt");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // arr(boxed)
        vm.shrImm(VReg.V0, VReg.A1, 48);
        vm.cmpImm(VReg.V0, 0x7ffb); // depth undefined?
        vm.jne("_flatrt_hasdepth");
        vm.movImm(VReg.S1, 1);
        vm.jmp("_flatrt_depthok");
        vm.label("_flatrt_hasdepth");
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_to_int32");       // 装箱 depth → 裸 int
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_flatrt_depthok");
        vm.label("_flatrt_loop");
        vm.cmpImm(VReg.S1, 0);
        vm.jle("_flatrt_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_flat");     // boxed arr → boxed 新数组
        vm.mov(VReg.S0, VReg.RET);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_flatrt_loop");
        vm.label("_flatrt_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _aref_relidx(A0=装箱 idx 或 undefined, A1=裸 len, A2=裸 default) -> 裸归一下标。
        // idx 缺省(undefined)→ default(调用方保证 default∈[0,len]);否则 ToInt32 后
        // ES 相对下标归一:负数 +len,仍负 → 0;>len → len。供 fill/copyWithin 复用。
        vm.label("_aref_relidx");
        vm.prologue(0, [VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A1); // len
        vm.mov(VReg.S2, VReg.A2); // default
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7ffb);
        vm.jne("_relidx_have");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S1, VReg.S2], 0);
        vm.label("_relidx_have");
        vm.call("_to_int32");      // A0=装箱 idx → RET 裸
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_relidx_pos");
        vm.add(VReg.RET, VReg.RET, VReg.S1); // += len
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_relidx_pos");
        vm.movImm(VReg.RET, 0);
        vm.label("_relidx_pos");
        vm.cmp(VReg.RET, VReg.S1);
        vm.jle("_relidx_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.label("_relidx_done");
        vm.epilogue([VReg.S1, VReg.S2], 0);

        // arr.fill(value, start=0, end=len) -> 原地填 value,返回接收者。
        vm.label("_array_fill_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // value
        vm.mov(VReg.S3, VReg.A2); // 装箱 start
        vm.mov(VReg.S4, VReg.A3); // 装箱 end
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.movImm(VReg.A2, 0);     // start 缺省 0
        vm.call("_aref_relidx");
        vm.mov(VReg.S3, VReg.RET); // start
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A2, VReg.S2);  // end 缺省 len
        vm.call("_aref_relidx");
        vm.mov(VReg.S4, VReg.RET); // end
        vm.label("_fill_loop");
        vm.cmp(VReg.S3, VReg.S4);
        vm.jge("_fill_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_array_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_fill_loop");
        vm.label("_fill_done");
        vm.mov(VReg.RET, VReg.S0); // 返回接收者(boxed)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // arr.copyWithin(target, start=0, end=len) -> 原地拷贝 [start,end) 到 target,
        // 返回接收者。count=min(end-start, len-target);重叠按方向复制避自覆盖。
        // 镜像 compileArrayCopyWithin 的内联逻辑,状态落栈槽(callee-saved 不够)。
        vm.label("_array_copyWithin_rt");
        // 栈帧须 16 对齐(arm64 bl 要求):5 槽 40B → 补足 48B([SP+40] 闲置)。
        vm.prologue(48, [VReg.S0, VReg.S1]);
        vm.store(VReg.SP, 0, VReg.A1);  // [0] 装箱 target(后覆写为 tgt)
        vm.store(VReg.SP, 8, VReg.A2);  // [8] 装箱 start(后覆写为 from)
        vm.store(VReg.SP, 16, VReg.A3); // [16] 装箱 end(后覆写为 count)
        vm.mov(VReg.S0, VReg.A0);       // arr
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET);      // len
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0);
        vm.call("_aref_relidx");
        vm.store(VReg.SP, 0, VReg.RET); // [0]=tgt
        vm.load(VReg.A0, VReg.SP, 8);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0);
        vm.call("_aref_relidx");
        vm.store(VReg.SP, 8, VReg.RET); // [8]=from
        vm.load(VReg.A0, VReg.SP, 16);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S1);       // end 缺省 len
        vm.call("_aref_relidx");        // RET=end
        vm.load(VReg.V0, VReg.SP, 8);   // from
        vm.sub(VReg.V0, VReg.RET, VReg.V0); // V0 = end-from
        vm.load(VReg.V1, VReg.SP, 0);   // tgt
        vm.sub(VReg.V1, VReg.S1, VReg.V1);  // V1 = len-tgt
        vm.cmp(VReg.V1, VReg.V0);
        vm.jle("_cw_cnt");              // V1<=V0 → count=V1
        vm.mov(VReg.V1, VReg.V0);       // 否则 count=V0
        vm.label("_cw_cnt");
        vm.store(VReg.SP, 16, VReg.V1); // [16]=count
        vm.cmpImm(VReg.V1, 0);
        vm.jle("_cw_done");
        vm.load(VReg.V0, VReg.SP, 8);   // from
        vm.add(VReg.V0, VReg.V0, VReg.V1); // V0 = fc = from+count
        vm.load(VReg.V2, VReg.SP, 8);   // from
        vm.load(VReg.V3, VReg.SP, 0);   // tgt
        vm.cmp(VReg.V2, VReg.V3);
        vm.jge("_cw_fwd");              // from>=tgt → 前向
        vm.cmp(VReg.V3, VReg.V0);
        vm.jge("_cw_fwd");              // tgt>=fc → 前向
        // 后向:to=tgt+count-1; from=fc-1; step=-1
        vm.load(VReg.V3, VReg.SP, 0);   // tgt
        vm.add(VReg.V3, VReg.V3, VReg.V1);
        vm.subImm(VReg.V3, VReg.V3, 1);
        vm.store(VReg.SP, 24, VReg.V3); // [24]=to
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 8, VReg.V0);  // [8]=from(fc-1)
        vm.movImm(VReg.V3, -1);
        vm.store(VReg.SP, 32, VReg.V3); // [32]=step
        vm.jmp("_cw_copy");
        vm.label("_cw_fwd");
        vm.load(VReg.V3, VReg.SP, 0);   // tgt
        vm.store(VReg.SP, 24, VReg.V3); // to=tgt
        vm.movImm(VReg.V3, 1);
        vm.store(VReg.SP, 32, VReg.V3); // step=+1
        vm.label("_cw_copy");
        vm.label("_cw_loop");
        vm.load(VReg.V0, VReg.SP, 16);  // count
        vm.cmpImm(VReg.V0, 0);
        vm.jle("_cw_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 8);   // from
        vm.call("_array_get");          // RET = val
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 24);  // to
        vm.call("_array_set");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.load(VReg.V1, VReg.SP, 32);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 8, VReg.V0);  // from+=step
        vm.load(VReg.V0, VReg.SP, 24);
        vm.load(VReg.V1, VReg.SP, 32);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 24, VReg.V0); // to+=step
        vm.load(VReg.V0, VReg.SP, 16);
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 16, VReg.V0); // count--
        vm.jmp("_cw_loop");
        vm.label("_cw_done");
        vm.mov(VReg.RET, VReg.S0);      // 返回接收者
        vm.epilogue([VReg.S0, VReg.S1], 48);

        // _concat_append(A0=result, A1=item) -> result:item 是数组则逐元素并入(手动展开,
        // 同 _array_flat 内层循环;不走 dormant 的 _array_concat),否则 _array_push 单元素。
        // result 标签随 _array_push 保持。内层裸指针(S1)与 j(S2)跨 _array_push 保活。
        vm.label("_concat_append");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_ccat_one");
        // 数组:展开一层 push
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S1, VReg.S1, VReg.V4); // S1 = 内层(裸)
        vm.movImm(VReg.S2, 0);                    // j
        vm.label("_ccat_loop");
        vm.load(VReg.V0, VReg.S1, 8);             // 内层 len(每轮重载,S1 稳定)
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_ccat_done");
        vm.load(VReg.V0, VReg.S1, 24);
        vm.shl(VReg.V1, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.A1, VReg.V0, 0);             // 内层元素
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_ccat_loop");
        vm.label("_ccat_one");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.S1, VReg.A1); // 非数组:item 原样(重取 A1,S1 未被 mask)
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_ccat_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // arr.concat(a, b, ...) -> 新数组。变参:实参个数读 _call_argc(调用点写、runtime
        // helper 不改写),截断到 4(蹦床仅移位 A0-A3)。result = _array_slice(recv 全拷贝)
        // 后逐个 _concat_append 实参。A1-A4 先存栈(随后的 call 会毁)。
        vm.label("_array_concat_rt");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.S1, VReg.V0, 0);   // argc(须在任何 call 前读)
        vm.cmpImm(VReg.S1, 4);
        vm.jle("_concat_argc_ok");
        vm.movImm(VReg.S1, 4);
        vm.label("_concat_argc_ok");
        vm.store(VReg.SP, 0, VReg.A1);
        vm.store(VReg.SP, 8, VReg.A2);
        vm.store(VReg.SP, 16, VReg.A3);
        vm.store(VReg.SP, 24, VReg.A4);
        // result = recv 全拷贝(_array_slice 0..INT_MAX,boxed)
        vm.movImm(VReg.A1, 0);
        vm.movImm(VReg.A2, 2147483647);
        vm.call("_array_slice");        // A0=recv(未动)→ boxed 副本
        vm.mov(VReg.S0, VReg.RET);      // result
        vm.cmpImm(VReg.S1, 1);
        vm.jlt("_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_concat_append");
        vm.mov(VReg.S0, VReg.RET);
        vm.cmpImm(VReg.S1, 2);
        vm.jlt("_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_concat_append");
        vm.mov(VReg.S0, VReg.RET);
        vm.cmpImm(VReg.S1, 3);
        vm.jlt("_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.call("_concat_append");
        vm.mov(VReg.S0, VReg.RET);
        vm.cmpImm(VReg.S1, 4);
        vm.jlt("_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 24);
        vm.call("_concat_append");
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_concat_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        // ---- 泛型(.call 非数组接收者)norm 委托层 ----
        // flat: _agen_flat(A0=recv, A1=depth)
        vm.label("_agen_flat");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A1);
        vm.call("_agen_norm");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_array_flat_rt");
        vm.epilogue([VReg.S0], 0);

        // fill: _agen_fill(A0=recv, A1=value, A2=start, A3=end)。变异落快照(记偏差,
        // 同既有 _agen_* 的快照语义)。
        vm.label("_agen_fill");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A1);
        vm.mov(VReg.S1, VReg.A2);
        vm.mov(VReg.S2, VReg.A3);
        vm.call("_agen_norm");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.mov(VReg.A3, VReg.S2);
        vm.call("_array_fill_rt");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // copyWithin: _agen_copyWithin(A0=recv, A1=target, A2=start, A3=end)。
        vm.label("_agen_copyWithin");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A1);
        vm.mov(VReg.S1, VReg.A2);
        vm.mov(VReg.S2, VReg.A3);
        vm.call("_agen_norm");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.mov(VReg.A3, VReg.S2);
        vm.call("_array_copyWithin_rt");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // concat 泛型:_agen_concat(A0=recv, A1..A4)。IsConcatSpreadable 缺省时普通对象
        // **不**展开(整对象作一元件);真数组/显式 spreadable 展开。禁止 _agen_norm:
        // norm 会把无索引对象快照成 [] → `({}).concat()` 得 [] 而非 [obj]。
        // argc 读 _call_argc(方法值由调用点写;编译器 fallback 须 emitSetCallArgc)。
        vm.label("_agen_concat");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.mov(VReg.S4, VReg.A4);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0); // argc
        vm.call("_agen_toobject");
        vm.store(VReg.SP, 8, VReg.RET); // recv(ToObject)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r"); // 须装箱: _array_push 保留入参 tag；裸头 → toString 成 Object
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_concat_append_item"); // this: ICS 缺省不展开
        vm.mov(VReg.S0, VReg.RET); // result
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jlt("_agen_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_concat_append_item");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 2);
        vm.jlt("_agen_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_concat_append_item");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 3);
        vm.jlt("_agen_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_concat_append_item");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 4);
        vm.jlt("_agen_concat_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_concat_append_item");
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_agen_concat_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // sort 泛型:_agen_sort(A0=recv, A1=comparefn|undefined) → this。
        // 真数组直通 _array_sort_cmp;array-like 活读 ToLength+Get/Set 写回 this。
        vm.label("_agen_sort");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // comparefn
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_sort_live");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_sort_cmp");
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_agen_sort_live");
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET); // recv
        // 复用真数组排序核:先快照成稠密数组、排序、再写回索引+length。
        // 对无 accessor/Proxy 的普通 array-like(S15.4.4.11_A3_T2)语义正确且零回退。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_norm");
        vm.store(VReg.SP, 0, VReg.RET); // snapshot arr
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_sort_cmp");
        // 写回:for i in 0..len: Set(recv,i,arr[i]); Set(recv,"length",len)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET); // len
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V0); // i
        vm.label("_agen_sort_wb_loop");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jge("_agen_sort_wb_len");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_subscript_set");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 8, VReg.V0);
        vm.jmp("_agen_sort_wb_loop");
        vm.label("_agen_sort_wb_len");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_object_set");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // splice 泛型方法值入口:_agen_splice(A0=recv, A1=start, A2=delCount, A3/A4=items…)
        // 按 _call_argc 把 A3.. 打成 items 数组后落 _agen_splice_items。
        vm.label("_agen_splice");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.mov(VReg.S4, VReg.A4);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0); // argc
        // items = []
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 3);
        vm.jlt("_agen_splice_pack_done");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_push");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 4);
        vm.jlt("_agen_splice_pack_done");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.label("_agen_splice_pack_done");
        // argc<2 → delCount 缺省(undefined sentinel)
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 2);
        vm.jge("_agen_splice_del_ok");
        vm.movImm64(VReg.S2, 0x7ffb000000000000n); // undefined → delete to end
        vm.label("_agen_splice_del_ok");
        vm.cmpImm(VReg.V0, 1);
        vm.jge("_agen_splice_start_ok");
        vm.movImm(VReg.S1, 0); // start 缺省 0(裸;下方 _to_int32 认 0)
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.S1, 0);
        vm.label("_agen_splice_start_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.load(VReg.A3, VReg.SP, 8);
        vm.call("_agen_splice_items");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // splice 打包入口:_agen_splice_items(A0=recv, A1=start boxed, A2=del boxed,
        // A3=itemsArr boxed|0) → removed。真数组 → _array_splice_rt;否则活读写回 this。
        vm.label("_agen_splice_items");
        vm.prologue(80, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET); // recv
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_splice_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.mov(VReg.A3, VReg.S3);
        vm.call("_array_splice_rt");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 80);

        // ---- array-like 活读 splice ----
        // SP: 0 recv, 8 start, 16 del, 24 items, 32 len, 40 actualStart,
        //     48 actualDel, 56 itemCount, 64 removed, 72 k
        vm.label("_agen_splice_live");
        vm.store(VReg.SP, 0, VReg.S0);
        vm.store(VReg.SP, 8, VReg.S1);
        vm.store(VReg.SP, 16, VReg.S2);
        // itemsArr: 0 → 空数组
        vm.cmpImm(VReg.S3, 0);
        vm.jne("_aspl_items_ok");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S3, VReg.RET);
        vm.label("_aspl_items_ok");
        vm.store(VReg.SP, 24, VReg.S3);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.store(VReg.SP, 32, VReg.RET); // len
        // start = ToInteger; 负 +len 钳 [0,len]
        vm.load(VReg.A0, VReg.SP, 8);
        vm.call("_to_int32");
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.S4, VReg.SP, 32); // len
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_aspl_start_pos");
        vm.add(VReg.S1, VReg.S1, VReg.S4);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_aspl_start_clamp");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_aspl_start_clamp");
        vm.label("_aspl_start_pos");
        vm.cmp(VReg.S1, VReg.S4);
        vm.jle("_aspl_start_clamp");
        vm.mov(VReg.S1, VReg.S4);
        vm.label("_aspl_start_clamp");
        vm.store(VReg.SP, 40, VReg.S1); // actualStart
        // delCount: undefined → len-start; else ToInteger 钳 [0,len-start]
        vm.load(VReg.A0, VReg.SP, 16);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_aspl_del_max");
        vm.call("_to_int32");
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_aspl_del_nn");
        vm.movImm(VReg.RET, 0);
        vm.label("_aspl_del_nn");
        vm.load(VReg.S4, VReg.SP, 32);
        vm.load(VReg.S1, VReg.SP, 40);
        vm.sub(VReg.V1, VReg.S4, VReg.S1); // len-start
        vm.cmp(VReg.RET, VReg.V1);
        vm.jle("_aspl_del_ok");
        vm.mov(VReg.RET, VReg.V1);
        vm.jmp("_aspl_del_ok");
        vm.label("_aspl_del_max");
        vm.load(VReg.S4, VReg.SP, 32);
        vm.load(VReg.S1, VReg.SP, 40);
        vm.sub(VReg.RET, VReg.S4, VReg.S1);
        vm.label("_aspl_del_ok");
        vm.store(VReg.SP, 48, VReg.RET); // actualDel
        // itemCount
        vm.load(VReg.A0, VReg.SP, 24);
        vm.call("_array_length");
        vm.store(VReg.SP, 56, VReg.RET);
        // removed = new Array; copy Get(recv, start+k)
        vm.load(VReg.A0, VReg.SP, 48);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 64, VReg.RET);
        vm.movImm(VReg.S5, 0); // k
        vm.label("_aspl_rem_loop");
        vm.load(VReg.V0, VReg.SP, 48);
        vm.cmp(VReg.S5, VReg.V0);
        vm.jge("_aspl_rem_done");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V1, VReg.SP, 40);
        vm.add(VReg.A1, VReg.V1, VReg.S5);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 64);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_array_set");
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_aspl_rem_loop");
        vm.label("_aspl_rem_done");
        // SP+72 作游标 k;newLen 在收尾重算。
        vm.load(VReg.S4, VReg.SP, 56); // itemCount
        vm.load(VReg.S5, VReg.SP, 48); // actualDel
        vm.cmp(VReg.S4, VReg.S5);
        vm.jlt("_aspl_shrink");
        vm.jeq("_aspl_insert");
        // itemCount > actualDel: 自高向低挪尾段
        vm.load(VReg.V0, VReg.SP, 32);
        vm.sub(VReg.V0, VReg.V0, VReg.S5);
        vm.subImm(VReg.V0, VReg.V0, 1); // k = len-del-1
        vm.store(VReg.SP, 72, VReg.V0);
        vm.label("_aspl_grow_loop");
        vm.load(VReg.V0, VReg.SP, 72); // k
        vm.load(VReg.V1, VReg.SP, 40); // actualStart
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_aspl_insert");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V1, VReg.SP, 48); // actualDel
        vm.add(VReg.A1, VReg.V0, VReg.V1); // from = k+del
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 56); // itemCount
        vm.add(VReg.A1, VReg.V0, VReg.V1); // to = k+itemCount
        vm.call("_subscript_set");
        vm.load(VReg.V0, VReg.SP, 72);
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 72, VReg.V0);
        vm.jmp("_aspl_grow_loop");

        vm.label("_aspl_shrink");
        // k = actualStart .. len-actualDel-1: Set(k+itemCount, Get(k+del))
        vm.load(VReg.V0, VReg.SP, 40);
        vm.store(VReg.SP, 72, VReg.V0); // k = actualStart
        vm.label("_aspl_shrink_loop");
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 32);
        vm.load(VReg.V2, VReg.SP, 48);
        vm.sub(VReg.V1, VReg.V1, VReg.V2); // len-del
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_aspl_shrink_del");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V1, VReg.SP, 48);
        vm.add(VReg.A1, VReg.V0, VReg.V1); // from
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 56);
        vm.add(VReg.A1, VReg.V0, VReg.V1); // to
        vm.call("_subscript_set");
        vm.load(VReg.V0, VReg.SP, 72);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 72, VReg.V0);
        vm.jmp("_aspl_shrink_loop");
        vm.label("_aspl_shrink_del");
        // delete k = newLen .. len-1 where newLen = len-del+itemCount
        vm.load(VReg.V0, VReg.SP, 32);
        vm.load(VReg.V1, VReg.SP, 48);
        vm.sub(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 56);
        vm.add(VReg.V0, VReg.V0, VReg.V1); // newLen
        vm.store(VReg.SP, 72, VReg.V0); // k = newLen
        vm.label("_aspl_del_loop");
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 32);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_aspl_insert");
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_object_delete");
        vm.load(VReg.V0, VReg.SP, 72);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 72, VReg.V0);
        vm.jmp("_aspl_del_loop");

        vm.label("_aspl_insert");
        vm.movImm(VReg.S5, 0);
        vm.label("_aspl_ins_loop");
        vm.load(VReg.V0, VReg.SP, 56);
        vm.cmp(VReg.S5, VReg.V0);
        vm.jge("_aspl_set_len");
        vm.load(VReg.A0, VReg.SP, 24);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 40);
        vm.add(VReg.A1, VReg.V0, VReg.S5);
        vm.call("_subscript_set");
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_aspl_ins_loop");
        vm.label("_aspl_set_len");
        vm.load(VReg.V0, VReg.SP, 32);
        vm.load(VReg.V1, VReg.SP, 48);
        vm.sub(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 56);
        vm.add(VReg.S5, VReg.V0, VReg.V1); // newLen
        vm.load(VReg.A0, VReg.SP, 0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.scvtf(0, VReg.S5);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_object_set");
        vm.load(VReg.RET, VReg.SP, 64); // removed（建时为裸头）
        vm.call("_box_arr_r"); // 返回值须为 0x7FFE，否则 toString → [object Object]
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 80);

        // 运行时 splice:从实参归一化后委托 _array_splice。
        // A0=recv(boxed), A1-A3=实参(boxed),items 从 _call_argc 的 argc-3 取。
        // A1(start)/A2(delCount) → _to_int32 归一化为裸 int；A3(itemsArr) → unbox 为裸指针。
        vm.label("_array_splice_rt");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);          // recv
        // start → int32
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_to_int32");
        vm.mov(VReg.S1, VReg.RET);          // start(raw int)
        // delCount → int32; sentinel (undefined/0) → 大哨兵
        vm.mov(VReg.A0, VReg.A2);
        vm.shrImm(VReg.V0, VReg.A2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);        // undefined
        vm.jeq("_sprt_del_max");
        vm.call("_to_int32");
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_sprt_del_ok");
        vm.label("_sprt_del_max");
        vm.movImm(VReg.RET, 0x7fffffff);
        vm.label("_sprt_del_ok");
        vm.mov(VReg.S2, VReg.RET);          // delCount(raw int)
        // itemsArr → unbox to raw
        vm.cmpImm(VReg.A3, 0);
        vm.jne("_sprt_items_unbox");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S3, VReg.RET);
        vm.jmp("_sprt_go");
        vm.label("_sprt_items_unbox");
        vm.mov(VReg.A0, VReg.A3);
        vm.call("_js_unbox");
        vm.mov(VReg.S3, VReg.RET);          // itemsArr(raw)
        vm.label("_sprt_go");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.mov(VReg.A3, VReg.S3);
        vm.call("_array_splice");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // 迭代器泛型:_agen_<kind>(A0=recv) -> norm 后 _array_iterator_new(norm, kind)。
        const agenIt = [["_agen_values", 0], ["_agen_keys", 1], ["_agen_entries", 2]];
        for (const [label, kind] of agenIt) {
            vm.label(label);
            vm.prologue(0, []);
            vm.call("_agen_norm");
            vm.mov(VReg.A0, VReg.RET);
            vm.movImm(VReg.A1, kind);
            vm.call("_array_iterator_new");
            vm.epilogue([], 0);
        }
    }

    generate() {
        this.generateArefGeneric();
        this.generateArefIntWrappers();
        this.generateArefCallbackMethods();
        this.generateAgenGeneric();
        this.generateArefI3Methods();
        this.generateSpreadCall0();
        this.generateArraySpreadInto();
        this.generateArraySpreadIntoMap();
        this.generateArrayEnsureCap();
        this.generateArrayPush();
        this.generateArrayPop();
        this.generateArraySetLengthThrow();
        this.generateArrayGet();
        this.generateArraySet();
        this.generateArrayLength();
        this.generateArrayAt();
        this.generateArrayIndexOf();
        this.generateArrayLastIndexOf();
        this.generateArrayIncludes();
        this.generateArraySlice();
        this.generateArrayNewWithSize();
        this.generateArrayCtorCall();
        this.generateArrayWith();
        this.generateArrayToString();
        this.generateArrayConcat();
        this.generateArrayJoin();
        this.generateArrayReverse();
        this.generateArraySort();
        this.generateArrayShift();
        this.generateArrayUnshift();
        this.generateArraySplice();
        this.generateArrayToSpliced();
        this.generateArrayFlat();
        this.generateArrayKeys();
        this.generateArrayEntries();
        this.generateArrayIterator();
        this.generateArrayIteratorNext();
        this.generateArrayLikeCopy();
        this.generateGetThis();
        this.generateArraySpeciesCheck();
        this.generateIsConcatSpreadable();
        this.generateConcatAppendItem();
        this.generateArrayFromRef();
        this.generateArrayOfRef();
    }

    // _array_from_ref(A0=src boxed, A1=mapFn boxed) -> boxed array。
    // Array.from 作一等值(变量/回调)的运行时 helper:静态方法闭包经 _aref_static_tramp
    // 分派到本 helper。src 是 tagged 数组(0x7FFE)时快路 copy+map;否则走 spread 收迭代器。
    generateArrayFromRef() {
        const vm = this.vm;
        vm.label("_array_from_ref");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // S0 = src (boxed)
        vm.mov(VReg.S1, VReg.A1); // S1 = mapFn (boxed, 可能 undefined/垃圾)

        // 数组快路:src 是 0x7FFE tagged → _array_slice 全拷贝
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_afr_spread");

        // 快路:src 是数组,拷贝全部元素(_array_slice 需裸头,内部自行 box 0x7FFE 返回)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_unbox");
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm(VReg.A1, 0);
        vm.movImm(VReg.A2, 2147483647);
        vm.call("_array_slice"); // RET = boxed 0x7FFE 副本
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_afr_map");

        // spread 慢路:非数组源 → _array_spread_into 收迭代器/Set/Map
        vm.label("_afr_spread");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r"); // RET = boxed 空数组
        vm.mov(VReg.S2, VReg.RET); // S2 = result (boxed)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_array_spread_into"); // RET = result (boxed)
        vm.mov(VReg.S2, VReg.RET);

        // mapFn 映射阶段:undefined → 跳过;其余须 IsCallable,否则 TypeError;
        // callable → _array_map_rt(result, mapFn)。此前非 0x7FFF 静默跳过 →
        // Array.from([], {}) 不抛(规范 22.1.2.1 step 3a)。
        vm.label("_afr_map");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB); // undefined → 无 mapping
        vm.jeq("_afr_done");
        // 缺省实参:A1 未传时可能是垃圾/0;把「无第二参」也当 undefined。
        // _aref_static_tramp 对缺省参常填 UNDEF;此处再兜底 0。
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_afr_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable(mapfn) or throw
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_map_rt"); // RET = boxed mapped array
        vm.mov(VReg.S2, VReg.RET);

        vm.label("_afr_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // _array_of_ref: Array.of 作一等值的运行时 helper。
    // 变参:闭包经 _aref_static_tramp 分派,A0..A4=实参(boxed),_call_argc=个数。
    // 创建新数组、按序填入各实参、返回装箱 0x7FFE。
    generateArrayOfRef() {
        const vm = this.vm;
        vm.label("_array_of_ref");
        // 栈帧:local(48) + S0/S1/S2/S3/S4/S5 (48) = 96,对齐到 16 边界 OK
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        // 保存实参到 callee-saved S 寄存器(跨后续 call 保活;S 由 epilogue 恢复)
        vm.mov(VReg.S1, VReg.A0); // arg0
        vm.mov(VReg.S2, VReg.A1); // arg1
        vm.mov(VReg.S3, VReg.A2); // arg2
        vm.mov(VReg.S4, VReg.A3); // arg3
        vm.mov(VReg.S5, VReg.A4); // arg4

        // 读实参个数入栈槽 SP+0(SP=S 寄存器跨 call 保活)
        vm.lea(VReg.V1, "_call_argc");
        vm.load(VReg.V2, VReg.V1, 0); // V2 = argc(临时)
        // 钳 argc 到 [0,5](寄存器窗口)
        vm.movImm(VReg.V3, 5);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jle("_aof_argc_ok");
        vm.mov(VReg.V2, VReg.V3);
        vm.label("_aof_argc_ok");
        vm.store(VReg.SP, 0, VReg.V2); // argc → [SP+0](local 槽,跨 call 保活)

        // 创建空数组:S0 = result(boxed)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.S0, VReg.RET);

        // 逐实参 push 进结果数组(Unroll 5 个分支,堆栈 argc 判界)
        // argc >= 1 → push arg0
        vm.load(VReg.V0, VReg.SP, 0); // argc
        vm.movImm(VReg.V1, 1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_aof_done");
        vm.mov(VReg.A1, VReg.S1); // arg0
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");     // clobbers V regs, S0-S5 存活
        vm.mov(VReg.S0, VReg.RET);
        // argc >= 2 → push arg1
        vm.load(VReg.V0, VReg.SP, 0);
        vm.movImm(VReg.V1, 2);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_aof_done");
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        // argc >= 3 → push arg2
        vm.load(VReg.V0, VReg.SP, 0);
        vm.movImm(VReg.V1, 3);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_aof_done");
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        // argc >= 4 → push arg3
        vm.load(VReg.V0, VReg.SP, 0);
        vm.movImm(VReg.V1, 4);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_aof_done");
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        // argc >= 5 → push arg4
        vm.load(VReg.V0, VReg.SP, 0);
        vm.movImm(VReg.V1, 5);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_aof_done");
        vm.mov(VReg.A1, VReg.S5);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);

        vm.label("_aof_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // 一等数组迭代器(`arr.values()`/`.keys()`/`.entries()`/`arr[Symbol.iterator]()`)。
    // 建模同生成器对象:普通对象带 "next" 闭包 [0xc105, _array_iterator_next, 状态] 与
    // "Symbol.iterator" 闭包 [0xc105, _generator_self](返回 this → 自迭代,for-of/展开/
    // Array.from 走通用协议分支)。迭代状态全放 next 闭包块内(免每步 _object_get/set):
    //   next 闭包(40B): +0 magic  +8 _array_iterator_next  +16 target(boxed 数组)
    //                    +24 index(裸 int,原地自增)       +32 kind(0=values,1=keys,2=entries)
    // _array_iterator_new(A0=boxed 数组, A1=kind 裸 int) -> boxed 迭代器对象。
    generateArrayIterator() {
        const vm = this.vm;
        vm.label("_array_iterator_new");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // boxed 数组
        vm.mov(VReg.S3, VReg.A1); // kind
        // 迭代器对象
        vm.call("_object_new");
        vm.mov(VReg.S1, VReg.RET); // obj(裸)
        // next 闭包块(48B;+40 done 旗标——耗尽即终态,Node 对拍)
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_array_iterator_next");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.store(VReg.S2, 16, VReg.S0); // target(boxed 数组)
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S2, 24, VReg.V1); // index = 0
        vm.store(VReg.S2, 32, VReg.S3); // kind
        vm.store(VReg.S2, 40, VReg.V1); // done = 0
        // obj["next"] = 闭包(函数 tag 0x7fff)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");
        // Symbol.iterator 闭包 [magic, _generator_self](复用:返回 this)
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_self");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");
        // 返回 boxed 对象
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S1, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _array_iterator_next: 闭包约定 S0=闭包裸指针, A0=arg(忽略), A5=this。
    // 读 [S0+16]=target/[S0+24]=index/[S0+32]=kind;index>=len → {undefined,true};
    // 否则按 kind 造 value,index 自增回写 [S0+24],→ {value,false}。
    generateArrayIteratorNext() {
        const vm = this.vm;
        vm.label("_array_iterator_next");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.S0); // 保住闭包指针(后续 call 会覆 S0? 否——callee 存 S0;仍显式留一份)
        // [test262 keys/values/entries iteration-mutable] 耗尽即终态:done 旗标置位后
        // 再 push 也不复活(Node 对拍;此前每次现读 live len → 耗尽后 push 会多产出)。
        vm.load(VReg.V0, VReg.S0, 40); // done
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_arriter_done");
        vm.load(VReg.S1, VReg.S0, 16); // target(boxed 数组)
        vm.load(VReg.S2, VReg.S0, 24); // index(裸 int)
        // len
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length"); // RET = len(裸 int)
        vm.cmp(VReg.S2, VReg.RET);
        vm.jge("_arriter_done");
        // 未耗尽:先把 index 自增回写(用回 S3=闭包)
        vm.addImm(VReg.V1, VReg.S2, 1);
        vm.store(VReg.S3, 24, VReg.V1);
        // 按 kind 造 value
        vm.load(VReg.V0, VReg.S3, 32); // kind
        vm.cmpImm(VReg.V0, 1); vm.jeq("_arriter_keys");
        vm.cmpImm(VReg.V0, 2); vm.jeq("_arriter_entries");
        // kind 0 values: value = target[index]
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.jmp("_arriter_emit");
        // kind 1 keys: value = index(裸 float64 位,禁 int-tag 避 nan-int0)
        vm.label("_arriter_keys");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A0, 0);
        vm.jmp("_arriter_emit");
        // kind 2 entries: value = [index, target[index]](装箱 0x7FFE)
        vm.label("_arriter_entries");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_get");
        vm.mov(VReg.S0, VReg.RET); // v(复用 S0:后续无需闭包指针)
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S1, VReg.RET); // pair(裸头)
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_array_set"); // pair[0] = index
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_array_set"); // pair[1] = v
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.A0, VReg.S1);
        vm.or(VReg.A0, VReg.A0, VReg.V1); // boxed pair
        // fallthrough emit
        vm.label("_arriter_emit");
        vm.movImm64(VReg.A1, 0x7ff9000000000000n); // done = false
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        // 耗尽:{value: undefined, done: true}(置 done 旗标 → 终态)
        vm.label("_arriter_done");
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.S3, 40, VReg.V0); // done = 1
        vm.movImm64(VReg.A0, 0x7ffb000000000000n); // undefined
        vm.movImm64(VReg.A1, 0x7ff9000000000001n); // true
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _array_like_copy(A0=boxed arr, A1=boxed array-like obj, A2=len) -> boxed arr
    // 把 array-like 对象的下标属性 obj[0..len-1] 复制进已建好的数组 arr(供 Array.from
    // 的 array-like 路径填实际值;此前仅按 length 填 undefined,丢下标属性)。
    // 走 _subscript_get(obj, i)(对象按数字键查找,与 JS obj[i] 同)+ _array_set;
    // 二者均 callee-save 干净,S0-S3 跨调用存活。
    generateArrayLikeCopy() {
        const vm = this.vm;
        vm.label("_array_like_copy");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);          // arr (boxed)
        vm.mov(VReg.S1, VReg.A1);          // obj (boxed)
        vm.mov(VReg.S2, VReg.A2);          // len
        vm.movImm(VReg.S3, 0);             // i
        vm.label("_alc_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_alc_done");
        // val = obj[i]  (i 小整数:裸值即合法装箱 int32 JSValue,tag 0)
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_subscript_get");
        // arr[i] = val
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_alc_loop");
        vm.label("_alc_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
    }

    // _array_keys(A0=boxed array) -> boxed [0,1,...,len-1]
    // asm.js 把数组迭代器建模为即时数组(与 values() 落接收者、Object.keys 同策)。
    generateArrayKeys() {
        const vm = this.vm;
        vm.label("_array_keys");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);         // boxed arr
        vm.call("_array_length");         // RET = len(裸 int),内部 mask A0
        vm.mov(VReg.S1, VReg.RET);        // len
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);        // result(裸头)
        vm.movImm(VReg.S3, 0);            // i
        vm.label("_array_keys_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_array_keys_done");
        // result[i] = i 按 JS Number 裸 float64 位(scvtf+fmovToInt,与数字字面量一致)。
        // **禁用 int-tag 0x7FF8**:装箱 int 0 与 canonical NaN 位同构 → console.log 渲染
        // 成 NaN(见 nan-int0 别名陷阱)。float 0.0 位=0 不撞 NaN。
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_array_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_array_keys_loop");
        vm.label("_array_keys_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1); // 外层数组装箱 0x7FFE
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
    }

    // _array_entries(A0=boxed array) -> boxed [[0,v0],[1,v1],...]
    // 内层 [i,v] 对也装箱 0x7FFE(否则外层遍历读裸头 → 嵌套渲染成 0),同 _object_entries。
    generateArrayEntries() {
        const vm = this.vm;
        vm.label("_array_entries");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);         // boxed arr(留给 _array_get)
        vm.call("_array_length");         // RET = len
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);        // result(裸头)
        vm.movImm(VReg.S3, 0);            // i
        vm.label("_array_entries_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_array_entries_done");
        // v = _array_get(boxed arr, i)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET);        // v(boxed)
        // pair = new Array(2)
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 0, VReg.RET);   // pair(裸头)
        // pair[0] = i 按裸 float64 位(禁 int-tag,避 nan-int0 别名,同 _array_keys)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_array_set");
        // pair[1] = v
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 1);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_array_set");
        // result[i] = boxed pair
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_array_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_array_entries_loop");
        vm.label("_array_entries_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
    }
    // [底层A] _get_this(): species getter helper - returns this (A5).
    generateGetThis() {
        const vm = this.vm;
        vm.label("_get_this");
        vm.prologue(0, []);
        vm.mov(VReg.RET, VReg.A5);
        vm.epilogue([], 0);
    }


    // _array_species_check(A0=recv boxed) -> 0 (default) / 1 (non-default species)
    generateArraySpeciesCheck() {
        const vm = this.vm;
        vm.label("_array_species_check");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.A1, "_str_constructor_prop");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_get");
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_asc_default");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_asc_default");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_asc_default");
        vm.lea(VReg.A0, "_symwk_species");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.species"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.movImm64(VReg.V0, 0x7ffd000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        // Species === Array constructor itself -> default
        // (the @@species getter returns _get_this, so Array[Symbol.species]===Array
        //  which is the default. Without this check all default arrays fall to
        //  the agen slow path.)
        vm.lea(VReg.V0, "_nsobj_array");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jeq("_asc_default");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_asc_default");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_asc_default");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_asc_default");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_asc_default");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // _is_concat_spreadable(A0=O boxed) -> 0/1 (not spreadable / spreadable)
    // Implements IsConcatSpreadable(O):
    //   1. If Type(O) is not Object, return false.
    //   2. Let spreadable be Get(O, @@isConcatSpreadable).
    //   3. If spreadable is not undefined, return ToBoolean(spreadable).
    //   4. Return IsArray(O) (tag 0x7FFE).
    generateIsConcatSpreadable() {
        const vm = this.vm;

        vm.label("_is_concat_spreadable");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        // Step 1: Type(O) is not Object → false
        // Only heap objects (0x7FFD/0x7FFE/0x7FFF) and bare heap pointers are objects.
        // Tagged primitives (boolean 0x7FF9, string 0x7FFC, null 0x7FFA, undefined 0x7FFB,
        // int32 0x7FF8) are NOT objects.
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_icsp_obj");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_icsp_obj");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_icsp_obj");
        vm.cmpImm(VReg.V0, 0); vm.jne("_icsp_false");    // tagged primitive → false
        vm.cmpImm(VReg.S0, 0); vm.jeq("_icsp_false");    // null pointer
        // bare heap pointer: verify in heap range
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_icsp_false");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_icsp_false");
        vm.jmp("_icsp_obj");

        // Step 2: spreadable = Get(O, @@isConcatSpreadable)（须触发 accessor）
        vm.label("_icsp_obj");
        vm.lea(VReg.A0, "_symwk_isConcatSpreadable");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.isConcatSpreadable"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);          // A1 = raw symbol pointer (tag 0)
        vm.mov(VReg.A0, VReg.S0);           // A0 = original object value (boxed)
        vm.call("_object_get");              // RET = O[@@isConcatSpreadable]（标记块可能）
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");            // 触发 getter；抛错向上传

        // Step 3: If spreadable is not undefined, return ToBoolean(spreadable)
        vm.movImm64(VReg.V1, 0x7ffb000000000000n); // undefined
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_icsp_isarray");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // Step 4: Return IsArray(O) → check tag 0x7FFE
        vm.label("_icsp_isarray");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.RET, 0);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_icsp_done");
        vm.movImm(VReg.RET, 1);
        vm.label("_icsp_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        vm.label("_icsp_false");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _concat_append_item(acc, item) -> newAcc
    // Appends item to accumulator respecting IsConcatSpreadable.
    // If !IsConcatSpreadable(item): push item as single element.
    // If IsConcatSpreadable(item): spread elements via _subscript_get.
    generateConcatAppendItem() {
        const vm = this.vm;

        vm.label("_concat_append_item");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // acc
        vm.mov(VReg.S1, VReg.A1); // item

        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_concat_spreadable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ccai_one");

        // Spreadable: LengthOfArrayLike(item)=ToLength(Get(length))（禁 _to_int32:
        // MAX_SAFE_INTEGER→−1 会跳过循环、吞毒索引 getter）。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET);

        vm.movImm(VReg.S3, 0);
        vm.label("_ccai_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_ccai_done");

        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_subscript_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);

        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ccai_loop");

        vm.label("_ccai_one");
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);

        vm.label("_ccai_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }
}