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
import { ARRAY_HEADER_SIZE } from "../../core/types.js";

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

        // 拷贝旧元素（oldCap 个）: 旧 data_ptr@24 → 新 data 区
        vm.load(VReg.S4, VReg.S0, 24); // 旧 data_ptr
        vm.load(VReg.V0, VReg.S0, 16); // oldCap (capacity)
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
        // 零填充 [oldCap, newCap)（V1 现等于 oldCap）
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

        // Internal CreateDataProperty append (gOPN/keys/for-in result arrays).
        // Must NOT consult Array.prototype accessors: a getter-only proto[0]
        // would skip the store and leave a hole → verifyProperty sees names[0]
        // as the getter result (11) / undefined. User-level Array.prototype.push
        // still uses _array_push (Set semantics). Same frame as _array_push so
        // we can join _array_push_dense / _array_push_after_elem / epilogue.
        vm.label("_array_push_own");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_gc_remember");
        vm.mov(VReg.S2, VReg.A0);
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4);
        vm.mov(VReg.S1, VReg.A1);
        vm.load(VReg.V0, VReg.S0, 8);
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.V0, 1);
        vm.call("_array_ensure_cap");
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_array_push_own_z");
        vm.movImm64(VReg.S1, 0x7ff8000000000000n);
        vm.label("_array_push_own_z");
        vm.load(VReg.V0, VReg.S0, 8);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_array_push_dense");

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
        vm.store(VReg.SP, 8, VReg.RET); // raw descriptor lookup key
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        // %Array.prototype% is itself an Array exotic.  `_object_get` on an
        // array delegates to `_subscript_get`, which invokes accessors; for a
        // setter-only descriptor that produces undefined and loses the raw
        // TYPE_GETTER marker.  Read its ordinary side-table object directly.
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_array_push_dense");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_object_get"); // raw TYPE_GETTER marker (getter not invoked)
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
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A1); // n
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // 裸头
        vm.movImm64(VReg.V0, 0xFFFFFFFFn); // maximum valid Array length
        vm.cmp(VReg.S1, VReg.V0);
        vm.jgt("_aslt_range");
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
        // Shrinking an Array length deletes own indexed elements at and above
        // the new length.  The compact array representation uses zero as the
        // hole sentinel; clear the dense data slots before publishing the new
        // length so `arr.length = 1` makes `arr[1]` undefined as specified.
        vm.load(VReg.S2, VReg.S0, 8); // old length
        vm.cmp(VReg.S1, VReg.S2);
        vm.jge("_aslt_store");
        vm.load(VReg.V0, VReg.S0, 16); // capacity
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.mov(VReg.V2, VReg.S1);      // i = new length
        vm.movImm(VReg.V4, 0);         // hole sentinel
        vm.label("_aslt_clear_loop");
        vm.cmp(VReg.V2, VReg.S2);
        vm.jge("_aslt_store");
        vm.cmp(VReg.V2, VReg.V0);
        vm.jge("_aslt_store");
        vm.shl(VReg.V3, VReg.V2, 3);
        vm.add(VReg.V3, VReg.V1, VReg.V3);
        vm.store(VReg.V3, 0, VReg.V4); // V4 is zero on all backends here
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_aslt_clear_loop");
        vm.label("_aslt_store");
        vm.store(VReg.S0, 8, VReg.S1);
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_aslt_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // 数组 get
    // _array_get(arr, index) -> value
    generateArrayGet() {
        const vm = this.vm;

        vm.label("_array_get");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S2, VReg.A0); // original receiver (boxed or raw)
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr
        vm.mov(VReg.S1, VReg.A1); // idx (A1 caller-saved)

        // Arguments [[ParameterMap]]: for-of / Array extras walk _array_get dense
        // slots, but formal assigns only write the box → live map bypassed
        // (for-of arguments yielded 1,2,3 instead of 1,3,1).
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.andImm(VReg.V1, VReg.V1, 32); // ARR_IS_ARGUMENTS
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_array_get_lenchk");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_args_param_map_get_box");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_array_get_lenchk");
        vm.load(VReg.RET, VReg.RET, 0); // *box
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_array_get_pmap_zero");
        vm.movImm64(VReg.V1, 0x7ff8000000000000n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_array_get_done");
        vm.movImm(VReg.RET, 0);
        vm.jmp("_array_get_done");
        vm.label("_array_get_pmap_zero");
        vm.movImm(VReg.RET, 0); // mapped 0 → number 0, not hole
        vm.jmp("_array_get_done");

        vm.label("_array_get_lenchk");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);

        // [bug A] 边界检查:index<0 或 >=length → tagged undefined(node 语义;
        // 此前直接越界读堆邻居——`while((v=a[i++])!==undefined)` 垃圾值/死循环根因)
        vm.load(VReg.V2, VReg.S0, 8); // length
        vm.cmpImm(VReg.A1, 0);
        vm.jlt("_array_get_oob");
        vm.cmp(VReg.A1, VReg.V2);
        vm.jge("_array_get_oob");
        vm.load(VReg.V2, VReg.S0, 16); // capacity (length may describe sparse holes)
        vm.cmp(VReg.A1, VReg.V2);
        vm.jge("_array_get_proto");

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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_array_get_oob");
        // >=length / <0:仍可能命中原型(仅 <0 直接 undefined)
        vm.cmpImm(VReg.A1, 0);
        vm.jlt("_array_get_undef");
        vm.label("_array_get_proto");
        // A0 可能已是裸/装箱;统一经 _agen_get_idx 走完整 Get(含原型)
        // 但 _array_get 常被内部以裸+裸 index 调用——改用内联原型读避免递归。
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_get_instance_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_array_get_proto_override");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_array_get_proto_ready");
        vm.call("_ensure_array_proto");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_array_get_undef");
        vm.label("_array_get_proto_ready");
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_array_get_proto_override");
        // A per-array override is returned boxed (tagged null means no proto).
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_array_get_undef");
        vm.push(VReg.RET); // selected prototype
        vm.push(VReg.S2);  // original receiver
        vm.push(VReg.S1);  // index
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.pop(VReg.A1);  // discard index
        vm.pop(VReg.V1);  // receiver
        vm.pop(VReg.A0);  // selected prototype
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_array_get_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
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

    // [argv 溢出] _call_argv_fill(A0=装箱实参数组):元素 5..15 → _call_argv 全局。
    generateCallArgvFill() {
        const vm = this.vm;
        vm.label("_call_argv_fill");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.S2, 5);
        vm.label("_cavf_loop");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_cavf_done");
        vm.cmpImm(VReg.S2, 16);
        vm.jge("_cavf_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_get");
        vm.lea(VReg.V5, "_call_argv");
        vm.shlImm(VReg.V6, VReg.S2, 3);
        vm.add(VReg.V5, VReg.V5, VReg.V6);
        vm.store(VReg.V5, 0, VReg.RET);
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_cavf_loop");
        vm.label("_cavf_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _array_ctor_single(A0=arg): Number ∧ ToUint32(n)===n → ArrayCreate(n);
    // Number 否则 RangeError;非 Number → 单元素数组。
    generateArrayCtorSingle() {
        const vm = this.vm;
        vm.label("_array_ctor_single");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        // NaN-box tags occupy exactly high16 in [0x7FF8, 0x8000).  Negative
        // doubles have high16 >= 0x8000 and must remain numbers; the old
        // `jge 0x7FF9` classified -1/-Infinity as a non-number element.
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_acs_zero_hi");
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_acs_num"); // positive doubles / +Inf / canonical NaN
        vm.cmpImm(VReg.V0, 0x8000);
        vm.jlt("_acs_elem"); // tagged non-number → element
        // high16 >= 0x8000: negative double, still a Number.
        vm.jmp("_acs_num");
        vm.label("_acs_zero_hi");
        // high16==0:denormal/+0/MIN_VALUE(<ptrFloor)是数字;堆/数据段指针才是单元素。
        // 旧实现一律当裸指针 → new Array(Number.MIN_VALUE) 得 [5e-324] 而非 RangeError。
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_acs_elem");
        vm.label("_acs_num");
        // ES: Number ∧ ToUint32(n)===n → ArrayCreate(n); 否则 RangeError。
        // 旧实现只 ToUint32 后建数组:new Array(1.5) 得 length=1,
        // new Array(MAX_VALUE) 甚至按错误整数分配(S15.4.2.2_A2.2_T3)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_coerce");
        vm.store(VReg.SP, 0, VReg.RET); // n 的 float64 位
        vm.shrImm(VReg.V1, VReg.RET, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jeq("_acs_range"); // NaN/±Inf
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_to_uint32");
        vm.store(VReg.SP, 8, VReg.RET); // u
        // u==0 时用位测:MIN_VALUE 等 denormal 在 FTZ 下 fcmp 会当成 0。
        // ±0 的绝对值位为 0 才合法;其余(MIN_VALUE/MAX_VALUE) RangeError。
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_acs_cmpf");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_acs_range");
        vm.jmp("_acs_mk");
        vm.label("_acs_cmpf");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.fmovToFloat(0, VReg.V0);
        vm.load(VReg.V1, VReg.SP, 8);
        vm.scvtf(1, VReg.V1);
        vm.fcmp(0, 1);
        vm.jne("_acs_range"); // 含 1.5!==1;-0===0 走上方位测
        vm.label("_acs_mk");
        vm.load(VReg.A0, VReg.SP, 8);
        vm.call("_array_new_with_size");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.V2, VReg.V1);
        vm.epilogue([VReg.S0], 16);
        vm.label("_acs_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V0);
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V0);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0], 16);
        vm.label("_acs_elem");
        vm.movImm(VReg.A0, 1);
        vm.call("_array_new_with_size");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.V2, VReg.V1);
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_array_set");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0], 16);
    }

    // _flat_to_depth(A0=depthVal) -> 裸非负 int(ToIntegerOrInfinity 近似)
    generateFlatToDepth() {
        const vm = this.vm;
        vm.label("_flat_to_depth");
        vm.prologue(0, []);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB); // undefined → 1
        vm.jeq("_ftd_one");
        // ToIntegerOrInfinity:串/对象经 _number_coerce(NaN→0),禁 _syscall_arg
        // 把 0x7FFC 串指针当正深度(flat("TestString") 会整树展开)。
        vm.call("_aref_fromindex");
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_ftd_zero");
        vm.epilogue([], 0);
        vm.label("_ftd_one");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([], 0);
        vm.label("_ftd_zero");
        vm.movImm(VReg.RET, 0);
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
        // x64 maps V0 and RET to the same physical RAX register.  Loading the
        // tagged-int-zero sentinel into V0 here used to overwrite every value
        // just loaded into RET, so all present elements were returned as +0.
        // A2/V2 is dead at this helper boundary and is a safe comparison temp.
        vm.movImm64(VReg.V2, 0x7ff8000000000000n);
        vm.cmp(VReg.RET, VReg.V2);
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
        vm.cmpImm(VReg.V0, 0x7FFD); // 子类 TA(0x7FFD|裸 ptr)勿再 OR 0x7FFE
        vm.jeq("_array_indexOf_have_box");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S4, VReg.S4, VReg.V1); // 裸 → 装箱,供 `_agen_has/get_idx`
        vm.label("_array_indexOf_have_box");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S4, VReg.V4); // S0 = arr raw(长度)
        vm.mov(VReg.S1, VReg.A1); // value to find
        vm.mov(VReg.S2, VReg.A2); // i = fromIndex(入口即捕获;x64 V2 别名 A2,须在 V2 使用前)

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

        // Always use strict equality.  A raw bit-equality fast path makes a
        // NaN compare equal to itself, which indexOf must never do.
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
        vm.cmpImm(VReg.V0, 0x7FFD);
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

        // Always use strict equality; raw bit equality is invalid for NaN.
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
    // Array is callable as well as constructable; this path is used by
    // Function.prototype.apply/call and must implement the ordinary 0/1/N
    // argument forms instead of the old unconditional TypeError.
    generateArrayCtorCall() {
        const vm = this.vm;
        vm.label("_array_ctor_call");
        vm.prologue(176, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.S0, VReg.V0, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jge("_arrcall_argc_ok");
        vm.movImm(VReg.S0, 0);
        vm.label("_arrcall_argc_ok");
        vm.cmpImm(VReg.S0, 16);
        vm.jle("_arrcall_argc_cap");
        vm.movImm(VReg.S0, 16);
        vm.label("_arrcall_argc_cap");
        vm.store(VReg.SP, 0, VReg.S0);
        vm.store(VReg.SP, 16, VReg.A0);
        vm.store(VReg.SP, 24, VReg.A1);
        vm.store(VReg.SP, 32, VReg.A2);
        vm.store(VReg.SP, 40, VReg.A3);
        vm.store(VReg.SP, 48, VReg.A4);
        for (let i = 5; i < 16; i++) {
            vm.lea(VReg.V5, "_call_argv");
            vm.load(VReg.V6, VReg.V5, i * 8);
            vm.store(VReg.SP, 16 + i * 8, VReg.V6);
        }
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_arrcall_empty");
        vm.cmpImm(VReg.S0, 1);
        vm.jeq("_arrcall_single");
        vm.movImm64(VReg.V1, 0x100000000n);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_arrcall_range");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.SP, 8, VReg.RET);
        for (let i = 0; i < 16; i++) {
            const skip = `_arrcall_skip_${i}`;
            vm.load(VReg.V0, VReg.SP, 0);
            vm.cmpImm(VReg.V0, i);
            vm.jle(skip);
            vm.load(VReg.A0, VReg.SP, 8);
            vm.movImm(VReg.A1, i);
            vm.load(VReg.A2, VReg.SP, 16 + i * 8);
            vm.call("_array_set");
            vm.label(skip);
        }
        vm.load(VReg.RET, VReg.SP, 8);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 176);
        vm.label("_arrcall_empty");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 176);
        vm.label("_arrcall_single");
        vm.load(VReg.A0, VReg.SP, 16);
        vm.call("_array_ctor_single");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 176);
        vm.label("_arrcall_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
    }

    // _array_new_with_size(size) -> array (裸数组头指针)
    // 数组布局: [type(8), length(8), capacity(8), data_ptr(8)] + 独立 data 区
    generateArrayNewWithSize() {
        const vm = this.vm;

        vm.label("_array_new_with_size");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // size (初始长度)

        // 计算实际容量:小数组按 length 完整分配; 超大稀疏数组保留
        // 1024 个槽位,避免 `new Array(1e9)` 触发巨额分配。此前所有
        // size>1024 都被截成 1024,而数组字面量/Array.from 随后直接
        // `_array_set` 越界写,导致 2048 元素稳定排序在第 1122 项后变洞。
        vm.movImm(VReg.S3, ARRAY_MIN_CAPACITY);
        vm.cmp(VReg.S0, VReg.S3);
        vm.jlt("_array_new_cap_done"); // size < MIN → capacity = MIN
        vm.movImm(VReg.S3, 1024);
        vm.movImm(VReg.V0, 1024 * 1024);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jgt("_array_new_cap_done"); // 超大 size → capacity = 1024 (sparse)
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
        vm.jeq("_array_join_sep_num0");
        // 裸数据段/堆串指针 → 装箱
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.jmp("_array_join_sep_ready");
        vm.label("_array_join_sep_num0");
        vm.movImm64(VReg.A1, 0x7ff8000000000000n); // +0.0(非 undefined → ToString="0")
        vm.jmp("_array_join_sep_tostr");
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

    // Array.prototype.sort 运行时。规范:固定 len → Has/Get 收集 → 排序 List →
    // Set 0..itemCount-1 / Delete itemCount..len-1(不 Set length)。
    // 比较:undefined 沉底;有 comparefn 则调用,否则 ToString+strcmp。
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

        // 规范(tc39/ecma262#1585):固定 len;HasProperty 才 Get 进 List;排序 List;
        // Set 回写 0..itemCount-1;Delete itemCount..len-1。不 Set length。
        // getter/setter 改 length 只影响对象,不影响循环上界(precise-getter/setter-*)。
        // 稠密快照(_array_sort_dense)只打已收集项,禁再 collect(会递归)。
        vm.label("_array_sort");
        vm.movImm64(VReg.A1, UNDEF);
        vm.label("_array_sort_cmp");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // comparefn
        // Spec 22.1.3.25 step 1: IsCallable(comparefn) before ToLength/Get(length).
        // comparefn-nonfunction-call-throws: poisoned this.length must not run first.
        vm.shrImm(VReg.V1, VReg.S1, 48); // x64 V0≡RET; tag from S1 uses V1
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_asort_cbok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb");
        vm.label("_asort_cbok");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET); // origLen(固定)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.SP, 0, VReg.RET); // items
        vm.movImm(VReg.S3, 0); // j
        vm.label("_asort_collect");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_asort_sort_items");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_asort_collect_next");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_push");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.label("_asort_collect_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_asort_collect");
        vm.label("_asort_sort_items");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_sort_dense");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.mov(VReg.S4, VReg.RET); // itemCount
        vm.movImm(VReg.S3, 0);
        vm.label("_asort_setloop");
        vm.cmp(VReg.S3, VReg.S4);
        vm.jge("_asort_delloop");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_subscript_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_asort_setloop");
        vm.label("_asort_delloop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_asort_done");
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_asort_delloop");
        vm.label("_asort_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // _array_sort_dense(A0=稠密 items, A1=comparefn):原地冒泡,不 collect。
        vm.label("_array_sort_dense");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S2, 2);
        vm.jlt("_asortd_done");
        vm.movImm(VReg.S3, 0); // i
        vm.label("_asortd_outer");
        vm.subImm(VReg.V1, VReg.S2, 1);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jge("_asortd_done");
        vm.movImm(VReg.S4, 0); // j
        vm.label("_asortd_inner");
        vm.sub(VReg.V0, VReg.S2, VReg.S3);
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.cmp(VReg.S4, VReg.V0);
        vm.jge("_asortd_inner_end");
        // Items may be represented by configurable own index descriptors in the
        // array side table (toSorted fills via CreateDataPropertyOrThrow).  Dense-only
        // _array_get sees those slots as holes and makes every comparison undefined.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S4, 1);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.mov(VReg.A2, VReg.S1);
        // The comparator is an arbitrary user callback and may clobber the
        // caller's loop registers (S3=i, S4=j). Preserve both around the
        // call; otherwise large stable-sort fixtures lose the tail once the
        // callback happens to reuse those registers.
        vm.store(VReg.SP, 16, VReg.S3);
        vm.store(VReg.SP, 24, VReg.S4);
        vm.call("_asort_compare");
        vm.load(VReg.S3, VReg.SP, 16);
        vm.load(VReg.S4, VReg.SP, 24);
        vm.cmpImm(VReg.RET, 0);
        vm.jle("_asortd_noswap");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.S3, VReg.SP, 16);
        vm.load(VReg.S4, VReg.SP, 24);
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S4, 1);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.call("_array_cdp_or_throw");
        vm.label("_asortd_noswap");
        vm.load(VReg.S3, VReg.SP, 16);
        vm.load(VReg.S4, VReg.SP, 24);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_asortd_inner");
        vm.label("_asortd_inner_end");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_asortd_outer");
        vm.label("_asortd_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);
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
        // Set(0,value,true):须走 _subscript_set 以触发 Array.prototype[0] setter
        // (unshift/set-length-array-length-is-non-writable);_array_set 只写稠密槽。
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_subscript_set");
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_setlength_throw"); // Set("length",len+1,true)
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
        // x64: _gc_remember is a leaf that uses V1. V1≡A3, so items is
        // destroyed if we unbox A3 after the barrier → SIGSEGV on even
        // a.splice() (empty items array still arrives in A3). A0 (RDI)
        // and A1 (RSI≡V7) survive; A2 (RDX≡V2) is avoided inside the
        // barrier; A3 does not. Snapshot A0-A3 first, then unbox from S.
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器;splice 把 young 插入项写入可能为 old 的数组)
        vm.emitMaskLoad(VReg.V5); // V5=R10, not an A-reg alias
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V5); // raw arr
        vm.andMaskReg(VReg.S3, VReg.S3, VReg.V5); // raw itemsArr
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
        // Set(length, newLen, true):不可写 length 须 TypeError
        // (S15.4.4.12_A6.1_T2)。禁盲写 @8。
        vm.load(VReg.V1, VReg.S0, 8);
        vm.sub(VReg.V1, VReg.V1, VReg.S2);
        vm.add(VReg.V1, VReg.V1, VReg.V3);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_array_setlength_throw");
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

    // GetMethod(obj, @@iterator). Well-known symbol first so
    // defineProperty(obj, Symbol.iterator, {get}) getters run (spread
    // GetIterator). String "Symbol.iterator" fallback keeps Array/String
    // proto dual-key builtins. Miss/undef → RET=0; null or present not-callable → TypeError.
    generateGetMethodIterator() {
        const vm = this.vm;
        vm.label("_get_method_iterator");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // obj
        vm.lea(VReg.A0, "_symwk_iterator");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_subscript_get"); // ToPropertyKey + Get + getter
        vm.mov(VReg.S1, VReg.RET);
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq("_gmi_str");
        vm.movImm64(VReg.V0, 0x7ffa000000000000n);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq("_gmi_notobj"); // GetMethod(null)=undefined → GetIterator TypeError
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_gmi_str");
        vm.shrImm(VReg.V2, VReg.S1, 48); // x64 V0≡RET
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jeq("_gmi_ok");
        vm.label("_gmi_notobj");
        vm.lea(VReg.A0, vm.asm.addString("object is not iterable"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_gmi_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V2, VReg.S1, 48);
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jeq("_gmi_ok");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_gmi_ok");
        vm.mov(VReg.RET, VReg.S1);
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
        // GetMethod(src, @@iterator) — well-known first (getter may throw)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_get_method_iterator");
        vm.shrImm(VReg.V2, VReg.RET, 48); // (x64 V2==A2 无活值;V0≡RET 会盖掉下方待调的迭代 fn)
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jne("_array_spread_done");
        // iter = itfn.call(src)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_spread_call0");
        // GetIterator: Type(iterator) is not Object → TypeError
        // (@@iterator returning null; spread-err-*-itr-get-value)
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jeq("_array_spread_iter_obj");
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_array_spread_iter_obj");
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jeq("_array_spread_iter_obj");
        vm.lea(VReg.A0, vm.asm.addString("Result of iterator method is not an object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_array_spread_iter_obj");
        vm.mov(VReg.S2, VReg.RET); // iter
        vm.label("_array_spread_iter_loop");
        // nextfn = _object_get(iter, "next")
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.shrImm(VReg.V2, VReg.RET, 48); // (x64 V2==A2 无活值;V0≡RET 会盖掉下方待调的 next fn)
        // `next` can be a boxed function (0x7FFF) or a naked closure pointer
        // returned by the object side table.  Route both through the shared
        // callable validator; the old tag-only check rejected naked user
        // closures as "not callable", which broke destructuring/spread over
        // ordinary custom iterators.  Keep the destination array in S4 while
        // the validator uses S0 as its in/out candidate register.
        vm.mov(VReg.S4, VReg.S0);
        vm.mov(VReg.S0, VReg.RET);
        vm.call("_validate_callable");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.S0, VReg.S4);
        // res = nextfn.call(iter)
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_spread_call0");
        vm.mov(VReg.S3, VReg.RET); // res = {value, done}
        // IteratorNext requires an Object result.  Treating null/primitive as an object made
        // missing `done` look false and loop forever (Object.fromEntries non-object-next).
        // This abrupt completion comes from IteratorStep itself, so IteratorClose is not run.
        vm.shrImm(VReg.V2, VReg.S3, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jeq("_array_spread_result_ok");
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_array_spread_result_ok");
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jne("_array_spread_bad_result");
        vm.label("_array_spread_result_ok");
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

        vm.label("_array_spread_bad_next");
        vm.lea(VReg.A0, vm.asm.addString("iterator next is not callable"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_array_spread_bad_result");
        vm.lea(VReg.A0, vm.asm.addString("iterator result is not an object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    // _array_spread_into_map(A0=arr, A1=src, A2=callback, A3=thisArg?) -> RET=arr
    // 把可迭代 src 的元素依次经 callback(el,i,arr) 映射后 _array_push 进 arr。
    // A3=thisArg(可选;0 哨兵→undefined)。与 _array_spread_into 同循环结构,
    // 但在 push 前调用 callback。用于 Array.from(iterator, mapFn) 的迭代+映射交叠。
    generateArraySpreadIntoMap() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;
        vm.label("_array_spread_into_map");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // src(boxed)
        vm.mov(VReg.S2, VReg.A2); // callback
        // thisArg:A3==0 哨兵→UNDEF(Array.from 编译器缺省);其余原样(含真 UNDEF)
        vm.cmpImm(VReg.A3, 0);
        vm.jne("_asimap_this_ok");
        vm.movImm64(VReg.A3, UNDEF);
        vm.label("_asimap_this_ok");
        vm.store(VReg.SP, 0, VReg.A3); // thisArg → [SP+0](跨循环保活)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_get_method_iterator");
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0===RET: else iterator fn becomes tag
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jne("_asimap_done");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_spread_call0");
        // GetIterator: Type(iterator) is not Object → TypeError
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jeq("_asimap_iter_obj");
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_asimap_iter_obj");
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jeq("_asimap_iter_obj");
        vm.lea(VReg.A0, vm.asm.addString("Result of iterator method is not an object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_asimap_iter_obj");
        vm.mov(VReg.S3, VReg.RET); // iter
        vm.movImm(VReg.S4, 0);     // index

        vm.label("_asimap_loop");
        // nextfn = iter.next
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0===RET: else next fn becomes tag
        vm.cmpImm(VReg.V2, 0x7FFF);
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
        // mapped = Call(mapfn, T, «value, k») — 两参。map 抛须 IteratorClose。
        // x64 V0===RET: value 先落 SP+16; &_exc_ctx_top 不跨 lea 保活
        // (x64 lea 可能用 RAX scratch,旧代码 lea V0 后再 lea catch 会毁掉 V0,
        // store V0,0,frame 写成代码地址 → SIGSEGV)。
        vm.store(VReg.SP, 16, VReg.RET); // value
        vm.lea(VReg.V1, "_exc_ctx_top");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.store(VReg.SP, 32, VReg.V2);
        vm.lea(VReg.V2, "_asimap_catch");
        vm.store(VReg.SP, 40, VReg.V2);
        vm.mov(VReg.V2, VReg.SP);
        vm.store(VReg.SP, 48, VReg.V2);
        vm.store(VReg.SP, 56, VReg.FP);
        vm.store(VReg.SP, 64, VReg.S0);
        vm.store(VReg.SP, 72, VReg.S1);
        vm.store(VReg.SP, 80, VReg.S2);
        vm.store(VReg.SP, 88, VReg.S3);
        vm.store(VReg.SP, 96, VReg.S4);
        vm.store(VReg.SP, 104, VReg.S5);
        vm.addImm(VReg.V2, VReg.SP, 32);
        vm.lea(VReg.V1, "_exc_ctx_top");
        vm.store(VReg.V1, 0, VReg.V2);
        vm.load(VReg.A0, VReg.SP, 16); // value
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A1, 0);  // index as number
        vm.mov(VReg.A3, VReg.S2);  // callback
        vm.load(VReg.A4, VReg.SP, 0); // thisArg
        vm.call("_aref_invoke_from");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V2, VReg.SP, 32);
        vm.lea(VReg.V1, "_exc_ctx_top");
        vm.store(VReg.V1, 0, VReg.V2);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_asimap_loop");

        vm.label("_asimap_catch");
        vm.load(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_iterator_close_keep");
        vm.call("_throw_unwind");

        vm.label("_asimap_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);
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
        // The extended argument marker is a one-shot ABI side channel used by
        // String.prototype.concat.  The compiler opts into it by property
        // name, so an arbitrary user-defined `obj.concat(...manyArgs)` can
        // arrive here with the marker set as well.  Do not let that stale
        // marker leak into the next intrinsic concat: only the exact
        // `_str_concat` helper may consume it.  V0/V5 are non-argument
        // scratch registers on all supported backends; preserve V6 (the
        // helper pointer) for the indirect call below.
        vm.lea(VReg.V5, "_str_concat");
        vm.cmp(VReg.V6, VReg.V5);
        vm.jeq("_aref_generic_keep_ext_argc");
        vm.lea(VReg.V5, "_call_argc_ext");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V5, 0, VReg.V0);
        vm.label("_aref_generic_keep_ext_argc");
        // Preserve the fifth user argument before shifting A0..A3 upward to
        // make room for the hidden receiver in A0.  Generic helpers that need
        // more than four arguments (notably concat) read it from the shared
        // overflow array at index 4.
        vm.lea(VReg.V5, "_call_argv");
        vm.store(VReg.V5, 32, VReg.A4);
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
        // 走 _aref_fromindex:串/对象 ToNumber,禁把 "1" 当堆指针截 int
        // (TA indexOf(43,"1") / slice 起点曾因此恒 miss)。
        vm.label("_aref_argint");
        vm.jmp("_aref_fromindex");

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
        vm.call("_aref_fromindex");
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

        // arr.lastIndexOf(value[, from]):delay ToInteger(from) until after the
        // length-zero early return.  The compiler passes boxed +Infinity when
        // fromIndex is omitted, and the actual boxed value when it is present.
        vm.label("_aref_arr_lastIndexOf");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aref_arr_lastIndexOf_empty");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_aref_fromindex");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_lastIndexOf");
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_aref_arr_lastIndexOf_empty");
        vm.movImm(VReg.RET, -1);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // str.indexOf(search[, from]):A0=str, A1=search(装箱透传), A2=boxed from → 裸 from(缺省0)
        //
        // The coercion order is observable.  String#indexOf must stringify the
        // receiver and search value before touching fromIndex (an object can
        // deliberately throw from valueOf/toString).  The old wrapper called
        // _aref_argint first, so `receiver.toString` was never reached when
        // fromIndex.valueOf threw.  Materialise the two string operands first,
        // then convert the saved fromIndex and call the byte-oriented core.
        vm.label("_aref_str_indexOf");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);

        // Preserve the required nullish receiver TypeError.  _valueToStr is
        // intentionally the general ToString operation and would turn null
        // into the literal "null"; the prototype method must reject it first.
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); // null
        vm.jeq("_aref_str_indexOf_throw_receiver");
        vm.cmpImm(VReg.V0, 0x7FFB); // undefined
        vm.jeq("_aref_str_indexOf_throw_receiver");

        // ToString(this), then ToString(search), then ToInteger(fromIndex).
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.S1, VReg.RET);

        vm.mov(VReg.A0, VReg.S2);
        vm.call("_aref_argint");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_indexOf"); // RET = 裸 int 下标/-1
        vm.scvtf(0, VReg.RET);    // 裸 int → 装箱 float64 数字
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // Re-enter the core with a harmless raw fromIndex; it performs the
        // normative receiver check and throws before observing the value.
        vm.label("_aref_str_indexOf_throw_receiver");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0);
        vm.call("_str_indexOf");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // str.search(searchValue): generic method references pass boxed values
        // while _str_search returns a raw signed index.  Keep this ABI shim
        // next to the other Aref wrappers so both primitive and wrapper
        // receivers get the same Number result.
        vm.label("_aref_str_search");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_str_search");
        vm.scvtf(0, VReg.RET);
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
        vm.prologue(16, [VReg.S0]); // 保存 S0(闭包会占用;调用者的 S0 须还原)
        vm.movImm(VReg.V0, 3);
        vm.store(VReg.SP, 0, VReg.V0); // argc=3:callback(elem, idx, arr)
        vm.jmp("_aref_icb_go");
        // TypedArray.sort comparefn:Call(comparefn, undefined, «x, y») 仅两参。
        vm.label("_aref_invoke_cb2");
        vm.movImm64(VReg.A4, UNDEF);
        vm.prologue(16, [VReg.S0]);
        vm.movImm(VReg.V0, 2);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_aref_icb_go");
        // Array.from mapfn:Call(mapfn, T, «value, k») 仅两参(calling-from-valid-2 /
        // iter-map-fn-args)。禁复用 cbt 的 argc=3。
        vm.label("_aref_invoke_from");
        vm.prologue(16, [VReg.S0]);
        vm.movImm(VReg.V0, 2);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.label("_aref_icb_go");
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
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V1, VReg.SP, 0);   // 3(cbt) 或 2(from)
        vm.store(VReg.V0, 0, VReg.V1);
        vm.callIndirect(VReg.V6);       // callback(A0,A1[,A2])
        vm.epilogue([VReg.S0], 16);

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

        // _iterator_close(A0=iterator_boxed):for-of 提前 break / 解构未耗尽的 IteratorClose。
        // 有 return() 则以 this=iterator 无参调用;无则空操作。return() 结果须是 Object,
        // 否则 TypeError(7.4.6 step 9)。单一定点 helper(每个 for-of 只发一条 call)。
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
        // GetMethod: function → call; miss/undef/null → no-op; present not-callable → TypeError.
        // (x64 V0≡RET: tag lives in V0 after shr; value stays in V6.)
        vm.cmpImm(VReg.V0, 0x7fff);      // boxed function
        vm.jeq("_itc_fn");
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_itc_done");
        vm.cmpImm(VReg.V0, 0x7ffb);      // undefined
        vm.jeq("_itc_done");
        vm.cmpImm(VReg.V0, 0x7ffa);      // null
        vm.jeq("_itc_done");
        vm.call("_throw_not_a_function");
        vm.label("_itc_fn");
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
        vm.setCallArgcImm(0, VReg.V0, VReg.V2); // IteratorClose calls return() with no arguments
        vm.callIndirect(VReg.V6);         // iterator.return()
        // 7.4.6 IteratorClose step 9: Type(innerResult) 须是 Object,否则 TypeError。
        // 完成值已是 throw 时由调用方 suppress(不经此检查)。null/undefined/原语全拒。
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);      // object
        vm.jeq("_itc_done");
        vm.cmpImm(VReg.V0, 0x7FFE);      // array
        vm.jeq("_itc_done");
        vm.cmpImm(VReg.V0, 0x7FFF);      // function
        vm.jeq("_itc_done");
        vm.cmpImm(VReg.V0, 0);           // 裸堆指针(未装箱对象/classinfo)
        vm.jne("_itc_not_object");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_itc_not_object");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jge("_itc_done");
        vm.label("_itc_not_object");
        vm.lea(VReg.A0, vm.asm.addString("Iterator result is not an object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
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
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
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
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0); // output index
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
        // Filter uses CreateDataPropertyOrThrow, which deliberately bypasses
        // inherited setters/getters.  _array_push incorrectly let an accessor
        // on Array.prototype shadow the fresh result's index 0.
        vm.load(VReg.A2, VReg.SP, 0); // element
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1); // boxed result
        vm.load(VReg.A1, VReg.SP, 16); // output index
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.label("_filt_skip");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_filt_loop");
        vm.label("_filt_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

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
        // OrdinaryCallBindThis:undefined + 非严格 → globalThis(reduce/reduceRight 回调)。
        vm.movImm64(VReg.V0, UNDEF);
        vm.subImm(VReg.SP, VReg.SP, 48);
        vm.store(VReg.SP, 0, VReg.A0);
        vm.store(VReg.SP, 8, VReg.A1);
        vm.store(VReg.SP, 16, VReg.A2);
        vm.store(VReg.SP, 24, VReg.A3);
        vm.store(VReg.SP, 32, VReg.A4);
        vm.store(VReg.SP, 40, VReg.V6);
        vm.mov(VReg.A0, VReg.V6);
        vm.call("_func_meta_strict");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_aref_icb4_this_strict");
        vm.lea(VReg.V0, "_global_this");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.call("_box_obj_r");
        vm.mov(VReg.A5, VReg.RET);
        vm.jmp("_aref_icb4_this_done");
        vm.label("_aref_icb4_this_strict");
        vm.movImm64(VReg.A5, UNDEF);
        vm.label("_aref_icb4_this_done");
        vm.load(VReg.V6, VReg.SP, 40);
        vm.load(VReg.A4, VReg.SP, 32);
        vm.load(VReg.A3, VReg.SP, 24);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.addImm(VReg.SP, VReg.SP, 48);
        vm.setCallArgcImm(4, VReg.V0, VReg.V1); // [argc ABI] callback(acc, cur, idx, arr)
        vm.callIndirect(VReg.V6);
        vm.epilogue([VReg.S0], 0);

        // arr.reduce(cb[, seed]):A0=arr, A1=cb, A2=seed(缺省 JS_UNDEFINED)。seed 须在
        // _array_length(冲 A2)前存入 S4。A4=hasInitial，不能用 seed 值判断：显式
        // undefined 仍是已提供的初值。无 seed → acc=首个存在元素、i 从 1;
        // 有 seed → acc=seed、i 从 0。空数组(len==0)且无 seed → TypeError(ES 23.1.3.24 step 5)。
        // HasProperty 经 `_agen_has_idx`(含原型链);全 hole 且无 seed → TypeError。
        // acc(S4)callee-saved(落栈,GC 扫栈可见)跨回调保活。回调 cb(acc,cur,idx,arr)。
        // _array_reduce_rt(A0=arr, A1=cb, A2=seed, A3=origRecv?0, A4=hasInitial)
        // A3 可选:原始 receiver(泛型 .call 保留四参身份);A3==0 → 用 arr 兜底。
        vm.label("_array_reduce_rt");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2); // seed(先存,_array_length 会冲 A2)
        vm.mov(VReg.S5, VReg.A3); // S5 = origRecv(0=arr)
        vm.store(VReg.SP, 0, VReg.A4); // hasInitial 跨 helper 调用保留
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 0); // initialValue 是否缺省
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
        vm.label("_reduce_empty");
        // len==0 且无 seed → TypeError(ES 23.1.3.24 step 5)
        vm.lea(VReg.A0, vm.asm.addString("Reduce of empty array with no initial value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16); // 理论不达
        // 全 absent(含原型)且无 seed → TypeError(与 agen live / ES 对齐)
        vm.label("_reduce_allhole");
        vm.jmp("_reduce_empty");

        // arr.reduceRight(cb[, seed]):从末尾向前。无 seed → acc=首个存在元素、i 再向前;
        // 有 seed → acc=seed、i 从 len-1。i<0 结束。HasProperty 经 `_agen_has_idx`。
        // _array_reduceRight_rt(A0=arr, A1=cb, A2=seed, A3=origRecv?0, A4=hasInitial)
        // A3 可选:原始 receiver(泛型 .call 保留四参身份);A3==0 → 用 arr 兜底。
        vm.label("_array_reduceRight_rt");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2);
        vm.mov(VReg.S5, VReg.A3); // S5 = origRecv(0=arr)
        vm.store(VReg.SP, 0, VReg.A4); // hasInitial 跨 helper 调用保留
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 0);
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
        vm.label("_rredr_empty");
        // len==0 且无 seed → TypeError(ES 23.1.3.25 step 5)
        vm.lea(VReg.A0, vm.asm.addString("Reduce of empty array with no initial value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16); // 理论不达
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
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_slt_not_array");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V0, VReg.V1, 0);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY (not a boxed TypedArray)
        vm.jne("_agen_slt_not_array");
        vm.loadByte(VReg.V0, VReg.V1, 1);
        vm.andImm(VReg.V0, VReg.V0, 32); // arguments.length is a side-table property
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_slt_not_array");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_to_integer");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_setlength_throw");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_slt_not_array");
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

        // _agen_toobject(A0=recv) -> RET boxed object。
        // null/undefined → TypeError; bool/number/string/symbol/bigint 原始值 → wrapper;
        // 数组/对象/函数/其它裸堆指针 → 恒等。供泛型 ToObject(this)。
        // String primitive used to return identity (0x7FFC). Helpers then unboxed
        // the content pointer as an array/TA header → SIGSEGV, and sort.call("")
        // was not instanceof String. _string_new builds the exotic wrapper
        // (nonwritable length + char indices) so Set(..., true) TypeErrors.
        // Symbol/BigInt are naked heap pointers (high16=0, type@0==61 / header==14).
        // Identity left them as primitives so sort.call(Symbol()) instanceof Symbol
        // and sort.call(0n) instanceof BigInt failed. Spec ToObject wraps both.
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
        vm.jeq("_agen_toobj_str");
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
        // Symbol / BigInt primitives: high16=0 heap ptr. Map/Set/etc stay identity.
        // x64: _is_symbol/_is_bigint clobber A0/RET; S0 is callee-saved primitive.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_toobj_sym");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_toobj_bi");
        vm.jmp("_agen_toobj_id");
        vm.label("_agen_toobj_sym");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_symbol_wrap");
        vm.epilogue([VReg.S0], 0);
        vm.label("_agen_toobj_bi");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_bigint_wrap");
        vm.epilogue([VReg.S0], 0);
        vm.label("_agen_toobj_bool");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_boolean_new");
        vm.epilogue([VReg.S0], 0);
        vm.label("_agen_toobj_num");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_new");
        vm.epilogue([VReg.S0], 0);
        vm.label("_agen_toobj_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_string_new");
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
        vm.loadByte(VReg.V2, VReg.V1, 0);
        vm.cmpImm(VReg.V2, 1); // TYPE_ARRAY
        vm.jne("_agen_tol_boxed_ta");
        // arguments.length 是普通数据属性(defineProperty 可改),非 [[Length]] 头字段。
        vm.loadByte(VReg.V2, VReg.V1, 1);
        vm.andImm(VReg.V2, VReg.V2, 32); // ARR_IS_ARGUMENTS
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_agen_tol_get");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        // 装箱 TypedArray(0x7FFE, type@0∈[0x40,0x7f],含子类):活长度经 _typed_array_length。
        // 此前落 _agen_tol_zero → lastIndexOf/indexOf 对 MyUint8Array 等恒 -1。
        vm.label("_agen_tol_boxed_ta");
        vm.cmpImm(VReg.V2, 0x40);
        vm.jlt("_agen_tol_notarr");
        vm.cmpImm(VReg.V2, 0x7f);
        vm.jgt("_agen_tol_notarr");
        // TypedArray 的 `length` 是原型访问器，但允许用户定义同名自有
        // 数据属性。统一走 [[Get]]，由 TA 侧表优先、自有 miss 再回落
        // %TypedArray%.prototype getter；直接读内部槽会漏掉该遮蔽。
        vm.jmp("_agen_tol_get");
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
        // [[Get]] 先看可能存在的自有 length；无覆盖时 TA 原型访问器仍
        // 通过 _typed_array_length 提供 OOB/detached/tracking 活长度。
        vm.jmp("_agen_tol_get");
        vm.label("_agen_tol_arr_raw");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_tol_notraw");
        // Every 0x7FFD value is an object.  _object_get owns the layout-aware
        // dispatch for Date/Promise/Map/Set/DataView/etc.; filtering here made
        // array-like Date objects appear to have length zero.
        vm.cmpImm(VReg.V0, 0x7FFD);
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
        // x64 V0≡RET: clamp const in V0 smashes the integer length so every
        // finite Get("length") becomes 2^53-1. Root of splice/set_length_no_args
        // (Set(length, 2^53-1) vs 0) and slice.call({length:2}) RangeError.
        // V2 is not RET (A2 dead after _number_coerce).
        vm.movImm64(VReg.V2, 9007199254740991n);
        vm.cmp(VReg.RET, VReg.V2);
        vm.jle("_agen_tol_ok");
        vm.mov(VReg.RET, VReg.V2);
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
        // 裸 TypedArray:HasProperty(整数下标) ≡ 0<=i<活长度。
        // OOB/detached → _typed_array_length=0 → 全假(Array.p.map.call 缩中迭代不再访洞)。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_has_idx_tag");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_agen_has_idx_tag");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_agen_has_idx_tag");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 0x40);
        vm.jlt("_agen_has_idx_tag");
        vm.cmpImm(VReg.V1, 0x7f);
        vm.jgt("_agen_has_idx_tag");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_agen_has_no");
        vm.cmp(VReg.S1, VReg.RET);
        vm.jge("_agen_has_no");
        vm.jmp("_agen_has_yes");
        vm.label("_agen_has_idx_tag");
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
        // 0x7FFD|裸 TA(派生 ctor 曾误装箱):活长度+界内 HasProperty
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_agen_has_idx_not7ffd");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.cmpImm(VReg.V2, 0x40);
        vm.jlt("_agen_has_idx_not7ffd");
        vm.cmpImm(VReg.V2, 0x7f);
        vm.jgt("_agen_has_idx_not7ffd");
        vm.mov(VReg.A0, VReg.V2);
        vm.call("_typed_array_length");
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_agen_has_no");
        vm.cmp(VReg.S1, VReg.RET);
        vm.jge("_agen_has_no");
        vm.jmp("_agen_has_yes");
        vm.label("_agen_has_idx_not7ffd");
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
        // 普通数组 [[HasProperty]] 是 OrdinaryHasProperty:越界 own 已删,仍走原型。
        // 不可按 IntegerIndexed 越界直接 false——reduce 缩 length 后须访
        // Array.prototype[k](15.4.4.21-9-b-28 / reduceRight 9-b-15)。
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S2, VReg.S0, VReg.V4); // raw arr
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_agen_has_no");
        vm.load(VReg.V0, VReg.S2, 8); // length
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_agen_has_arr_proto");
        vm.load(VReg.V0, VReg.S2, 16); // capacity
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_agen_has_arr_own_or_proto");
        // 稠密槽!=0 → present
        vm.load(VReg.V1, VReg.S2, 24); // data_ptr
        vm.shl(VReg.V2, VReg.S1, 3);
        vm.add(VReg.V2, VReg.V1, VReg.V2);
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_agen_has_yes");
        vm.label("_agen_has_arr_own_or_proto");
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
        vm.label("_agen_has_arr_proto");
        // Array.prototype(及更上) — `_prop_in` 对 TYPE_OBJECT 走原型链
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_get_instance_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_has_arr_proto_override");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jne("_agen_has_arr_proto_ready");
        vm.call("_ensure_array_proto");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_agen_has_no");
        vm.label("_agen_has_arr_proto_ready");
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
        vm.label("_agen_has_arr_proto_override");
        vm.mov(VReg.A0, VReg.RET);
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_agen_has_no");
        vm.jmp("_agen_has_arr_proto_ready");
        vm.label("_agen_has_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_agen_has_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // _agen_set_idx(A0=receiver, A1=bare int64 index, A2=value):
        // Set(O, ToString(index), value, true).  Generic algorithms keep their
        // loop counters as int64 so indices near 2^53 remain exact.  Passing
        // those bare bits directly to `_js_prop_key` misclassifies any value
        // with a non-zero high16 as an IEEE double; box the mathematical
        // integer as a JS Number first, exactly like _agen_get_idx/has_idx.
        vm.label("_agen_set_idx");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_subscript_set_strict");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // _agen_delete_idx(A0=receiver, A1=bare int64 index):
        // DeletePropertyOrThrow(O, ToString(index)).
        vm.label("_agen_delete_idx");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_delete_idx_throw");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_agen_delete_idx_throw");
        vm.lea(VReg.A0, vm.asm.addString("Cannot delete property"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1], 0);

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
        // String wrappers materialize UTF-16 index properties in their own
        // side table; use ordinary Get so those properties (and prototype
        // fallthrough) are returned instead of byte-indexing __value.
        vm.jmp("_agen_get_sub");
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
        vm.jge("_agen_get_arr_own_or_proto");
        vm.load(VReg.V0, VReg.S2, 16); // sparse logical hole beyond capacity
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_agen_get_arr_own_or_proto");
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
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_get_instance_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_get_arr_proto_override");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_agen_get_arr_proto_ready");
        vm.call("_ensure_array_proto");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_agen_get_arr_undef");
        vm.label("_agen_get_arr_proto_ready");
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
        vm.label("_agen_get_arr_proto_override");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_agen_get_arr_undef");
        vm.jmp("_agen_get_arr_proto_ready");
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
            // map/filter's generic/species fallback must not bounce a true
            // Array back to the default-result fast path.  It is precisely
            // this entry that handles custom @@species (and Proxy-wrapped
            // arrays), so both kinds continue through the live spec loop.
            if (kind !== "map" && kind !== "filter") {
                vm.shrImm(VReg.V0, VReg.S0, 48);
                vm.cmpImm(VReg.V0, 0x7FFE);
                vm.jeq(trueArr);
            }
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
                vm.mov(VReg.A0, VReg.S0);
                vm.mov(VReg.A1, VReg.S2);
                vm.call("_array_species_create");
                vm.mov(VReg.S4, VReg.RET); // species result (boxed object/array)
            } else if (kind === "filter") {
                vm.mov(VReg.A0, VReg.S0);
                vm.movImm(VReg.A1, 0);
                vm.call("_array_species_create");
                vm.mov(VReg.S4, VReg.RET);
                vm.movImm(VReg.V0, 0);
                vm.store(VReg.SP, 8, VReg.V0); // output index
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
                // CreateDataPropertyOrThrow(result, i, mapped); absent source
                // properties remain absent because this branch is skipped.
                vm.mov(VReg.A2, VReg.RET); // value
                vm.mov(VReg.A0, VReg.S4);
                vm.mov(VReg.A1, VReg.S3); // bare index
                vm.call("_array_cdp_or_throw");
            } else if (kind === "filter") {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");
                vm.cmpImm(VReg.RET, 0);
                vm.jeq(nextLbl);
                vm.load(VReg.A2, VReg.SP, 0); // selected element
                vm.mov(VReg.A0, VReg.S4);
                vm.load(VReg.A1, VReg.SP, 8); // output index
                vm.call("_array_cdp_or_throw");
                vm.load(VReg.V0, VReg.SP, 8);
                vm.addImm(VReg.V0, VReg.V0, 1);
                vm.store(VReg.SP, 8, VReg.V0);
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
                vm.mov(VReg.RET, VReg.S4);
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

        // flatMap:活读 FlattenIntoArray(+mapper)。禁 _agen_norm:洞被填成
        // undefined 再 map 出 NaN;Proxy 丢失 has/get/constructor。
        vm.label("_agen_flatMap");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // cb
        vm.store(VReg.SP, 0, VReg.A2); // thisArg
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agfm_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0);
        vm.load(VReg.A3, VReg.SP, 0);
        vm.call("_array_flatMap_rt_t");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_agfm_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_species_create");
        vm.mov(VReg.S4, VReg.RET);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V0); // n
        vm.movImm(VReg.S3, 0);
        vm.label("_agfm_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_agfm_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agfm_next");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);
        vm.mov(VReg.A3, VReg.S1);
        vm.load(VReg.A4, VReg.SP, 0);
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.S5, VReg.RET);
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_is_array_value");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agfm_one");
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_agen_tolength");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S5);
        vm.load(VReg.A3, VReg.SP, 8);
        vm.movImm(VReg.A4, 0);
        vm.call("_flatten_into_cdp");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.jmp("_agfm_next");
        vm.label("_agfm_one");
        vm.mov(VReg.A0, VReg.S4);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 8, VReg.V0);
        vm.label("_agfm_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_agfm_loop");
        vm.label("_agfm_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // 回调+seed 三参(recv, cb, seed):reduce/reduceRight — 非数组活读+跳 hole。
        // 参数存在性必须从入口 argc 快照，不能由 seed===undefined 推断。
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
            vm.lea(VReg.V0, "_call_argc");
            vm.load(VReg.S5, VReg.V0, 0); // user argc; helper 调用前快照
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
            vm.cmpImm(VReg.S5, 2); // initialValue 是否缺省
            vm.jlt(noseedLbl);
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
            const noInitFlagLbl = "__" + label + "_noinitflag";
            const initFlagDoneLbl = "__" + label + "_initflagdone";
            vm.movImm(VReg.A4, 0);
            vm.cmpImm(VReg.S5, 2);
            vm.jlt(noInitFlagLbl);
            vm.movImm(VReg.A4, 1);
            vm.jmp(initFlagDoneLbl);
            vm.label(noInitFlagLbl);
            vm.movImm(VReg.A4, 0);
            vm.label(initFlagDoneLbl);
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
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // value
        vm.mov(VReg.S4, VReg.A2); // boxed from
        // Snapshot argc before any helper call overwrites the global.  This
        // distinguishes omitted fromIndex (start at len-1) from an explicitly
        // supplied undefined (ToInteger(undefined) = 0).
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.S5, VReg.V0, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_agen_lastIndexOf_miss");
        vm.cmpImm(VReg.S5, 2);
        vm.jge("_agen_lastIndexOf_have_from");
        vm.subImm(VReg.S3, VReg.S2, 1); // omitted → len - 1
        vm.jmp("_agen_lastIndexOf_loop");
        vm.label("_agen_lastIndexOf_have_from");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_aref_fromindex");
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_agen_lastIndexOf_miss");
        vm.movImm(VReg.RET, -1);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // _agen_includes(A0=recv, A1=value, A2=boxed from) → JS bool。
        // Use the spec's live Get loop for every receiver.  Snapshotting via
        // _agen_norm loses Proxy early-exit/access order, truncates 2^53
        // lengths and observes TypedArray resize at the wrong time.
        vm.label("_agen_includes");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // receiver
        vm.mov(VReg.S1, VReg.A1); // searchElement
        vm.mov(VReg.S2, VReg.A2); // boxed fromIndex
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S3, VReg.RET); // capture len before fromIndex coercion
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_agen_includes_false"); // len==0:do not coerce fromIndex
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_aref_fromindex");
        vm.mov(VReg.S4, VReg.RET); // k
        vm.cmpImm(VReg.S4, 0);
        vm.jge("_agen_includes_from_ok");
        vm.add(VReg.S4, VReg.S3, VReg.S4);
        vm.cmpImm(VReg.S4, 0);
        vm.jge("_agen_includes_from_ok");
        vm.movImm(VReg.S4, 0);
        vm.label("_agen_includes_from_ok");
        vm.label("_agen_includes_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_agen_includes_false");
        // includes uses Get, not HasProperty:holes and post-resize OOB entries
        // are observed as undefined.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_map_key_eq"); // SameValueZero (NaN==NaN, -0==+0)
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_includes_true");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_agen_includes_loop");
        vm.label("_agen_includes_false");
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_agen_includes_true");
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // Array.prototype.toString(A0=recv):
        //   O=ToObject(this); func=Get(O,"join"); callable ? Call(func,O) :
        //   %Object.prototype.toString%. 不能直接别名 _agen_join：boolean/普通对象没有
        //   callable join，且数组/Proxy 上的自有 join getter/覆写必须可观察。
        vm.label("_agen_toString");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S2, VReg.A0); // 原始 this；品牌器能识别原语品牌
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET); // O / Call 的 thisArg
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("join"));
        boxStr(VReg.A1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_tostr_object");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_spread_call0");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_agen_tostr_object");
        // If Get returned undefined only because the intrinsic Array prototype is
        // still an empty shell, use the intrinsic join.  Own/prototype overrides,
        // including an explicit undefined, must keep the Object-brand fallback.
        vm.movImm64(VReg.V0, UNDEF);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jne("_agen_tostr_brand");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_array_value");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agen_tostr_brand");
        vm.lea(VReg.V0, "_nsobj_array_ready");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_agen_tostr_brand");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("join"));
        boxStr(VReg.A1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_tostr_brand");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_agen_tostr_intrinsic_join");
        vm.lea(VReg.A1, vm.asm.addString("join"));
        boxStr(VReg.A1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_tostr_brand");
        vm.label("_agen_tostr_intrinsic_join");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, UNDEF);
        vm.call("_agen_join");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_agen_tostr_brand");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_object_proto_toString");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

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
        // Array.p.join 用 ToLength(Get("length")):OOB/detached → 0 → 空串,不抛。
        // _ta_join 是 TA.prototype.join(ValidateTypedArray 先抛)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_agen_join_ta_live");
        vm.lea(VReg.A0, "_str_empty");
        vm.call("_js_box_string");
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_agen_join_ta_live");
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

        // _agen_slice(A0=recv, A1=boxed start, A2=boxed end) → ArraySpeciesCreate + CDP。
        vm.label("_agen_slice");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET); // O
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S3, VReg.RET); // len
        // start
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_fromindex"); // ToIntegerOrInfinity, full int64 range
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_agsl_start_pos");
        vm.add(VReg.S1, VReg.S1, VReg.S3);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_agsl_start_ok");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_agsl_start_ok");
        vm.label("_agsl_start_pos");
        vm.cmp(VReg.S1, VReg.S3);
        vm.jle("_agsl_start_ok");
        vm.mov(VReg.S1, VReg.S3);
        vm.label("_agsl_start_ok");
        // end: undefined → len
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_agsl_end_have");
        vm.mov(VReg.S2, VReg.S3);
        vm.jmp("_agsl_end_ok");
        vm.label("_agsl_end_have");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_aref_fromindex");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_agsl_end_pos");
        vm.add(VReg.S2, VReg.S2, VReg.S3);
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_agsl_end_ok");
        vm.movImm(VReg.S2, 0);
        vm.jmp("_agsl_end_ok");
        vm.label("_agsl_end_pos");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jle("_agsl_end_ok");
        vm.mov(VReg.S2, VReg.S3);
        vm.label("_agsl_end_ok");
        vm.sub(VReg.S4, VReg.S2, VReg.S1); // count
        vm.cmpImm(VReg.S4, 0);
        vm.jge("_agsl_cnt_ok");
        vm.movImm(VReg.S4, 0);
        vm.label("_agsl_cnt_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_species_create");
        vm.store(VReg.SP, 0, VReg.RET); // A
        vm.movImm(VReg.S3, 0); // n
        vm.label("_agsl_loop");
        vm.cmp(VReg.S1, VReg.S2);
        vm.jge("_agsl_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_agsl_next");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_cdp_or_throw");
        vm.label("_agsl_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_agsl_loop");
        vm.label("_agsl_done");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_cdp_set_len");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // _agen_at(A0=recv, A1=boxed idx) → 元素。
        vm.label("_agen_at");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // original receiver (must remain live across coercion)
        vm.mov(VReg.S1, VReg.A1); // boxed index

        // Array.prototype.at is generic.  Capture LengthOfArrayLike before
        // ToInteger(index), then perform the final Get on the original
        // receiver.  The old implementation normalized to a snapshot array
        // first; that both lost accessors/prototype properties and made
        // resizable TypedArrays observe stale elements after valueOf resized
        // their buffer.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET); // origLen
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_fromindex");
        vm.mov(VReg.S3, VReg.RET); // relativeIndex

        vm.cmpImm(VReg.S3, 0);
        vm.jge("_agen_at_nonneg");
        vm.add(VReg.S3, VReg.S2, VReg.S3); // k = len + relativeIndex
        vm.label("_agen_at_nonneg");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_agen_at_undefined");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_agen_at_undefined");

        // ToPropertyKey(k) for the final Get.  Use a canonical float Number
        // (rather than the int-tag zero alias, which is NaN-shaped) so both
        // dense arrays and IntegerIndexed exotic TypedArrays take the normal
        // numeric-key path.
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_subscript_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        vm.label("_agen_at_undefined");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

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
        // reverse 活读:ToObject + ToLength(负 length→0,不回写),Has/Get/Set/Delete。
        // 禁 _agen_norm:快照会 ToInt32 负 length、返回新数组。禁稠密 _array_reverse:
        // 不触发 accessor、不 Delete(get_if_present_with_delete)。
        vm.label("_agen_reverse");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S1, VReg.RET); // len
        vm.shrImm(VReg.V0, VReg.S1, 1); // middle = floor(len/2)
        vm.store(VReg.SP, 32, VReg.V0);
        vm.movImm(VReg.S2, 0); // lower
        vm.label("_arev_loop");
        vm.load(VReg.V0, VReg.SP, 32);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_arev_done");
        vm.sub(VReg.S3, VReg.S1, VReg.S2);
        vm.subImm(VReg.S3, VReg.S3, 1); // upper
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_has_idx");
        vm.store(VReg.SP, 16, VReg.RET); // lowerExists
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_arev_no_lget");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 0, VReg.RET); // lowerVal
        vm.label("_arev_no_lget");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.store(VReg.SP, 24, VReg.RET); // upperExists
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_arev_no_uget");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 8, VReg.RET); // upperVal
        vm.label("_arev_no_uget");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_arev_no_lower");
        vm.load(VReg.V0, VReg.SP, 24);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_arev_lower_only");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_subscript_set");
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.call("_subscript_set");
        vm.jmp("_arev_step");
        vm.label("_arev_lower_only");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_arev_del_err");
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.call("_subscript_set");
        vm.jmp("_arev_step");
        vm.label("_arev_no_lower");
        vm.load(VReg.V0, VReg.SP, 24);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_arev_step");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_subscript_set");
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_arev_del_err");
        vm.label("_arev_step");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_arev_loop");
        vm.label("_arev_del_err");
        vm.lea(VReg.A0, vm.asm.addString("Cannot delete property"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_arev_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        // ES2023 非破坏:toReversed / toSorted / with。
        // toReversed 必须按倒序 Get 原接收者，再 CreateDataProperty 到新数组；
        // 不能用 `_array_slice` 升序快照后 reverse（会错过原型/accessor/hole 语义）。
        vm.label("_agen_toReversed");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S1, VReg.RET); // cached len
        vm.movImm64(VReg.V0, 0x100000000n);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_agen_torev_range");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_new_with_size"); // raw result, length=len (all slots initially holes)
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.S2, 0); // k
        vm.label("_agen_torev_loop");
        vm.cmp(VReg.S2, VReg.S1);
        vm.jge("_agen_torev_done");
        vm.sub(VReg.V0, VReg.S1, VReg.S2);
        vm.subImm(VReg.V0, VReg.V0, 1); // from = len-k-1
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.mov(VReg.A0, VReg.S3);
        vm.or(VReg.A0, VReg.A0, VReg.V1); // boxed result
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_cdp_or_throw"); // own data property, including explicit undefined
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_agen_torev_loop");
        vm.label("_agen_torev_done");
        vm.mov(VReg.RET, VReg.S3);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);
        vm.label("_agen_torev_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        vm.label("_agen_toSorted");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // this(先于 ToObject 保住)
        vm.mov(VReg.S1, VReg.A1); // comparefn | undefined
        // ES toSorted step 1:非 undefined 的 comparefn 须先 IsCallable,再读 length。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_agen_tosort_cbok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb");
        vm.label("_agen_tosort_cbok");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET); // cached length
        // ArrayCreate(length) is limited by the ordinary Array length range.
        vm.movImm64(VReg.V0, 0x100000000n);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_agen_tosort_range");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_new_with_size"); // raw result, length=cached length
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.S4, 0); // k
        vm.label("_agen_tosort_collect");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_agen_tosort_sort");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_agen_get_idx"); // Get(O,Pk); holes become explicit undefined
        vm.mov(VReg.A2, VReg.RET);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.mov(VReg.A0, VReg.S3);
        vm.or(VReg.A0, VReg.A0, VReg.V1); // boxed result
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_cdp_or_throw");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_agen_tosort_collect");
        vm.label("_agen_tosort_sort");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.mov(VReg.A0, VReg.S3);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_sort_dense");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        vm.label("_agen_tosort_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // _agen_with(A0=recv, A1=boxed idx, A2=val)
        vm.label("_agen_with");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S3, VReg.RET); // cached len
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_to_integer"); // full ToIntegerOrInfinity, not truncating ToInt32
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_agen_with_index_pos");
        vm.add(VReg.S4, VReg.S3, VReg.S1);
        vm.jmp("_agen_with_index_ready");
        vm.label("_agen_with_index_pos");
        vm.mov(VReg.S4, VReg.S1);
        vm.label("_agen_with_index_ready");
        vm.cmpImm(VReg.S4, 0);
        vm.jlt("_agen_with_range");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_agen_with_range");
        // ArrayCreate(len): ordinary arrays cannot represent length >= 2^32.
        vm.movImm64(VReg.V0, 0x100000000n);
        vm.cmp(VReg.S3, VReg.V0);
        vm.jge("_agen_with_range");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 0, VReg.RET); // raw result
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V0); // k
        vm.label("_agen_with_loop");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmp(VReg.V0, VReg.S3);
        vm.jge("_agen_with_done");
        vm.cmp(VReg.V0, VReg.S4);
        vm.jeq("_agen_with_value");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.jmp("_agen_with_define");
        vm.label("_agen_with_value");
        vm.mov(VReg.A2, VReg.S2);
        vm.label("_agen_with_define");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 8, VReg.V0);
        vm.jmp("_agen_with_loop");
        vm.label("_agen_with_done");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        vm.label("_agen_with_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid index"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // _agen_toSpliced is the method-reference entry.  Its generic trampoline
        // exposes at most A3/A4 as inserted items, so first materialize those into
        // an items array and preserve the original argument count for the missing-
        // start / missing-deleteCount distinctions.  Direct compiler calls use the
        // packed entry below and can carry arbitrary spread items.
        vm.label("_agen_toSpliced");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // start
        vm.mov(VReg.S2, VReg.A2); // deleteCount
        vm.mov(VReg.S3, VReg.A3); // item0
        vm.mov(VReg.S4, VReg.A4); // item1
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.S5, VReg.V0, 0); // user argc after _aref_generic this insertion
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.SP, 0, VReg.RET); // packed items
        vm.cmpImm(VReg.S5, 3);
        vm.jlt("_agen_tosplice_pack_done");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_push");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.cmpImm(VReg.S5, 4);
        vm.jlt("_agen_tosplice_pack_done");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.label("_agen_tosplice_pack_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.load(VReg.A3, VReg.SP, 0);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_agen_toSpliced_packed");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // _agen_toSpliced_packed(A0=recv, A1=start, A2=deleteCount,
        // A3=boxed items array, A4=actual user argc) -> boxed new Array.
        // ES: ToObject → LengthOfArrayLike → ToIntegerOrInfinity/clamping →
        // ArrayCreate → prefix/items/suffix Get in order.  Deleted source elements
        // are never read; holes and prototype values are materialized as undefined/
        // inherited values through _agen_get_idx.
        vm.label("_agen_toSpliced_packed");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // start
        vm.mov(VReg.S2, VReg.A2); // deleteCount
        vm.mov(VReg.S3, VReg.A3); // items
        vm.mov(VReg.S4, VReg.A4); // argc
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S5, VReg.RET); // cached len
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_length");
        vm.store(VReg.SP, 24, VReg.RET); // insertCount
        // actualStart: no start argument means zero; otherwise ToIntegerOrInfinity.
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_agen_tsp2_start_zero");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_to_integer");
        vm.mov(VReg.V0, VReg.RET);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_agen_tsp2_start_pos");
        vm.add(VReg.V0, VReg.S5, VReg.V0);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_agen_tsp2_start_store");
        vm.movImm(VReg.V0, 0);
        vm.jmp("_agen_tsp2_start_store");
        vm.label("_agen_tsp2_start_pos");
        vm.cmp(VReg.V0, VReg.S5);
        vm.jle("_agen_tsp2_start_store");
        vm.mov(VReg.V0, VReg.S5);
        vm.jmp("_agen_tsp2_start_store");
        vm.label("_agen_tsp2_start_zero");
        vm.movImm(VReg.V0, 0);
        vm.label("_agen_tsp2_start_store");
        vm.store(VReg.SP, 8, VReg.V0); // actualStart
        // actualDeleteCount: absent start => 0; absent deleteCount => len-start;
        // present deleteCount uses ToIntegerOrInfinity then clamps to remaining len.
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_agen_tsp2_del_zero");
        vm.cmpImm(VReg.S4, 1);
        vm.jeq("_agen_tsp2_del_missing");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_to_integer");
        vm.mov(VReg.V0, VReg.RET);
        vm.jmp("_agen_tsp2_del_clamp");
        vm.label("_agen_tsp2_del_missing");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.sub(VReg.V0, VReg.S5, VReg.V0);
        vm.jmp("_agen_tsp2_del_store");
        vm.label("_agen_tsp2_del_zero");
        vm.movImm(VReg.V0, 0);
        vm.jmp("_agen_tsp2_del_store");
        vm.label("_agen_tsp2_del_clamp");
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_agen_tsp2_del_nonneg");
        vm.movImm(VReg.V0, 0);
        vm.label("_agen_tsp2_del_nonneg");
        vm.load(VReg.V1, VReg.SP, 8);
        vm.sub(VReg.V1, VReg.S5, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jle("_agen_tsp2_del_store");
        vm.mov(VReg.V0, VReg.V1);
        vm.label("_agen_tsp2_del_store");
        vm.store(VReg.SP, 16, VReg.V0); // actualDeleteCount
        // newLen = len + insertCount - actualDeleteCount; check before any Get.
        vm.load(VReg.V0, VReg.SP, 24);
        vm.add(VReg.V0, VReg.S5, VReg.V0);
        vm.load(VReg.V1, VReg.SP, 16);
        vm.sub(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 32, VReg.V0);
        vm.movImm64(VReg.V1, 9007199254740991n);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jgt("_agen_tsp2_type_range");
        vm.movImm64(VReg.V1, 0x100000000n);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_agen_tsp2_array_range");
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 0, VReg.RET); // result raw (overwrite packed-items slot)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 40, VReg.V0); // output index i
        // Prefix: i < actualStart, Get(O,i), CreateDataProperty(A,i).
        vm.label("_agen_tsp2_prefix");
        vm.load(VReg.V0, VReg.SP, 40);
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_agen_tsp2_items_init");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 40);
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.V0, VReg.SP, 40);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 40, VReg.V0);
        vm.jmp("_agen_tsp2_prefix");
        // Items: values already evaluated, copied in order.
        vm.label("_agen_tsp2_items_init");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 48, VReg.V0); // item index
        vm.label("_agen_tsp2_items");
        vm.load(VReg.V0, VReg.SP, 48);
        vm.load(VReg.V1, VReg.SP, 24);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_agen_tsp2_suffix_init");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 40);
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.V0, VReg.SP, 40);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 40, VReg.V0);
        vm.load(VReg.V0, VReg.SP, 48);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 48, VReg.V0);
        vm.jmp("_agen_tsp2_items");
        // Suffix starts at actualStart + actualDeleteCount in the source.
        vm.label("_agen_tsp2_suffix_init");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.load(VReg.V1, VReg.SP, 16);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 48, VReg.V0); // source index r
        vm.label("_agen_tsp2_suffix");
        vm.load(VReg.V0, VReg.SP, 40);
        vm.load(VReg.V1, VReg.SP, 32);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_agen_tsp2_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 48);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 40);
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.V0, VReg.SP, 40);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 40, VReg.V0);
        vm.load(VReg.V0, VReg.SP, 48);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 48, VReg.V0);
        vm.jmp("_agen_tsp2_suffix");
        vm.label("_agen_tsp2_done");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_agen_tsp2_type_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_agen_tsp2_array_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        boxStr(VReg.A0);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // Legacy implementation retained below for binary compatibility with old
        // labels; no current dispatch reaches it.
        // ES:ToObject → LengthOfArrayLike → 算 newLen → 超 2^53-1 TypeError /
        // 超 2^32-1 RangeError(ArrayCreate),再快照。禁先 _agen_norm(会 Get 下标)。
        vm.label("_agen_toSpliced_legacy");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S4, VReg.RET); // len
        // insertCount:undefined→0;真数组→length;其余单值→1
        vm.movImm(VReg.S5, 0);
        vm.shrImm(VReg.V0, VReg.S3, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_agen_tosplice_ic_done");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_tosplice_ic_one");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_length");
        vm.mov(VReg.S5, VReg.RET);
        vm.jmp("_agen_tosplice_ic_done");
        vm.label("_agen_tosplice_ic_one");
        vm.movImm(VReg.S5, 1);
        vm.label("_agen_tosplice_ic_done");
        // actualStart = clamp(ToInteger(start), 0, len)
        vm.mov(VReg.A0, VReg.S1);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_agen_tosplice_st_i");
        vm.movImm(VReg.V0, 0);
        vm.jmp("_agen_tosplice_st_cl");
        vm.label("_agen_tosplice_st_i");
        vm.call("_to_int32");
        vm.mov(VReg.V0, VReg.RET);
        vm.label("_agen_tosplice_st_cl");
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_agen_tosplice_st_pos");
        vm.add(VReg.V0, VReg.S4, VReg.V0);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_agen_tosplice_st_ok");
        vm.movImm(VReg.V0, 0);
        vm.jmp("_agen_tosplice_st_ok");
        vm.label("_agen_tosplice_st_pos");
        vm.cmp(VReg.V0, VReg.S4);
        vm.jle("_agen_tosplice_st_ok");
        vm.mov(VReg.V0, VReg.S4);
        vm.label("_agen_tosplice_st_ok");
        vm.store(VReg.SP, 8, VReg.V0); // actualStart
        // actualDeleteCount = clamp(ToInteger(skip), 0, len-actualStart)
        vm.mov(VReg.A0, VReg.S2);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_agen_tosplice_dc_i");
        vm.movImm(VReg.V0, 0);
        vm.jmp("_agen_tosplice_dc_cl");
        vm.label("_agen_tosplice_dc_i");
        vm.call("_to_int32");
        vm.mov(VReg.V0, VReg.RET);
        vm.label("_agen_tosplice_dc_cl");
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_agen_tosplice_dc_nn");
        vm.movImm(VReg.V0, 0);
        vm.label("_agen_tosplice_dc_nn");
        vm.load(VReg.V1, VReg.SP, 8);
        vm.sub(VReg.V1, VReg.S4, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jle("_agen_tosplice_dc_ok");
        vm.mov(VReg.V0, VReg.V1);
        vm.label("_agen_tosplice_dc_ok");
        // newLen = len + insertCount - actualDeleteCount
        vm.add(VReg.V1, VReg.S4, VReg.S5);
        vm.sub(VReg.V1, VReg.V1, VReg.V0);
        vm.movImm64(VReg.V2, 9007199254740991n); // 2^53-1
        vm.cmp(VReg.V1, VReg.V2);
        vm.jgt("_agen_tosplice_too_big");
        vm.movImm64(VReg.V2, 4294967295n); // 2^32-1
        vm.cmp(VReg.V1, VReg.V2);
        vm.jgt("_agen_tosplice_range");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_agen_tosplice_norm");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_tosplice_norm");
        vm.jmp("_agen_tosplice_do");
        vm.label("_agen_tosplice_too_big");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.label("_agen_tosplice_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        boxStr(VReg.A0);
        vm.call("_throw_range_error");
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

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

        // _agen_unshift:真数组 argc==1 → _array_unshift;否则活读右移+Set+length。
        // argc==0 leftover A1 is padded undefined — do not insert. Spec:
        // ToObject, ToLength, Set(length,len), return len (same family as
        // compiler unshift() no-args / _fpg_arr_push_noarg).
        // argc>=2: method-value / .call extra args live in A2/A3/A4 after
        // _aref_generic this-insert. Helper used to insert A1 only (A3_T2
        // unshift("x","y","z") → only "x"). Shift to=k+argCount; insert 1..min(argc,4).
        // Live Set uses _subscript_set_strict (spec Throw=true) so getter-only
        // index 0 TypeErrors (read-only-property).
        vm.label("_agen_unshift");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // item0
        vm.store(VReg.SP, 8, VReg.A2); // item1
        vm.store(VReg.SP, 16, VReg.A3); // item2
        vm.store(VReg.SP, 24, VReg.A4); // item3
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        // x64 V0≡RET: argc load uses V1 (S0 already holds O).
        vm.lea(VReg.V1, "_call_argc");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.mov(VReg.S3, VReg.V1); // S3 = argCount
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_agen_unshift_noarg");
        vm.cmpImm(VReg.S3, 1);
        vm.jne("_agen_unshift_live"); // argc>=2: live even for true arrays
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
        // Spec 22.1.3.29 4.a: If len+argCount > 2^53-1, TypeError.
        // Missing this walked 2^53 slots → SIGSEGV
        // (unshift/throws-if-integer-limit-exceeded).
        // x64 V0≡RET: sum in V1, clamp const in V2 (A2 dead; items on SP).
        vm.add(VReg.V1, VReg.S2, VReg.S3);
        vm.movImm64(VReg.V2, 9007199254740991n);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jle("_agen_un_len_ok");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.label("_agen_un_len_ok");
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
        // to = i + argCount - 1 (argCount==1 → to=i, same as before)
        vm.load(VReg.V1, VReg.SP, 0);
        vm.add(VReg.V1, VReg.V1, VReg.S3);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.scvtf(0, VReg.V1);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_subscript_set_strict"); // Set(to, fromValue, true)
        vm.jmp("_agen_un_next");
        vm.label("_agen_un_del");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.add(VReg.V1, VReg.V1, VReg.S3);
        vm.subImm(VReg.V1, VReg.V1, 1);
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
        vm.call("_subscript_set_strict"); // Set(0, item0, true)
        vm.cmpImm(VReg.S3, 2);
        vm.jlt("_agen_un_setlen");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.V0, 1);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A1, 0);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_subscript_set_strict");
        vm.cmpImm(VReg.S3, 3);
        vm.jlt("_agen_un_setlen");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.V0, 2);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A1, 0);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.call("_subscript_set_strict");
        vm.cmpImm(VReg.S3, 4);
        vm.jlt("_agen_un_setlen");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.V0, 3);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A1, 0);
        vm.load(VReg.A2, VReg.SP, 24);
        vm.call("_subscript_set_strict");
        vm.label("_agen_un_setlen");
        vm.add(VReg.S2, VReg.S2, VReg.S3); // len + argCount
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw"); // Set("length",len+argCount,true)
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_agen_unshift_noarg");
        // Set(length, len, true); return len. True-array uses dense
        // _array_setlength_throw; array-like / Boolean wrapper live Set.
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jne("_agen_unshift_noarg_obj");
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_agen_unshift_noarg_obj");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_setlength_throw");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_agen_unshift_noarg_obj");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw");
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
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.store(VReg.SP, 8, VReg.A3); // thisArg → [SP+8]
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb"); // IsCallable after Length (ES)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_species_create");
        vm.mov(VReg.S4, VReg.RET); // A (boxed; 默认 ArrayCreate)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0); // n
        vm.movImm(VReg.S3, 0);     // i
        vm.label("_fm_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_fm_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fm_next");
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
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_is_array_value");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fm_push_one");
        // mapped 是数组(含 Array Proxy):FlattenIntoArray depth=0
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_agen_tolength");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S5);
        vm.load(VReg.A3, VReg.SP, 16);
        vm.movImm(VReg.A4, 0);
        vm.call("_flatten_into_cdp");
        vm.store(VReg.SP, 16, VReg.RET);
        vm.jmp("_fm_next");
        vm.label("_fm_push_one");
        vm.mov(VReg.A0, VReg.S4);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.label("_fm_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_fm_loop");
        vm.label("_fm_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

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
        // idx 缺省(undefined)→ default(调用方保证 default∈[0,len]);否则
        // ToIntegerOrInfinity + ES 相对下标: +Inf→len, -Inf→0, NaN→0;
        // 负数 +len 仍负 → 0; >len → len。禁 ToInt32: ToInt32(Inf)=0 会把
        // copyWithin(..., Infinity) 打成 end=0 (finite end=6 already PASS)。
        // x64 cvttsd2si(+Inf) is INT64_MIN (not ARM saturating INT64_MAX),
        // so +Inf must be classified from IEEE bits before fcvtzs.
        // x64 V0≡RET: exp/mantissa extracts use V1, not V0.
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
        vm.call("_number_coerce"); // A0=装箱 idx → RET float bits
        vm.shrImm(VReg.V1, VReg.RET, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jne("_relidx_finite");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V1, VReg.RET, VReg.V1); // mantissa
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_relidx_nan");
        // ±Inf: sign bit 63. +Inf → len; -Inf → 0
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_relidx_ninf");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S1, VReg.S2], 0);
        vm.label("_relidx_ninf");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S1, VReg.S2], 0);
        vm.label("_relidx_nan");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S1, VReg.S2], 0);
        vm.label("_relidx_finite");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.RET, 0);
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

        // copyWithin 活读(A0=recv, A1=target, A2=start, A3=end) → this。
        // ToObject + 先捕获 ToLength,再 ToInteger 各参(副作用可改 length,不得重读
        // 已算好的 tgt/from/count)。循环 HasProperty(from)? Get+Set(to) :
        // DeletePropertyOrThrow(to)。禁 _agen_norm:快照会 Get 填洞、丢掉 Proxy
        // has/delete 陷阱。_agen_copyWithin 与此同体(方法值 / .call)。
        vm.label("_agen_copyWithin");
        vm.label("_array_copyWithin_rt");
        // 栈帧须 16 对齐:tgt/from/count/to/step/val = 48B。
        vm.prologue(48, [VReg.S0, VReg.S1]);
        vm.store(VReg.SP, 0, VReg.A1);  // [0] 装箱 target(后覆写为 tgt)
        vm.store(VReg.SP, 8, VReg.A2);  // [8] 装箱 start(后覆写为 from)
        vm.store(VReg.SP, 16, VReg.A3); // [16] 装箱 end(后覆写为 count)
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);      // recv(ToObject)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S1, VReg.RET);      // 捕获 len
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
        vm.mov(VReg.A2, VReg.S1);       // end 缺省捕获 len
        vm.call("_aref_relidx");        // RET=end
        // x64 V0≡RET: load from into V0 smashes end → end-from is 0 →
        // copyWithin is a no-op ([1,2,3,4,5].copyWithin(0,3) stays 1,2,3,4,5).
        vm.load(VReg.V1, VReg.SP, 8);   // from
        vm.sub(VReg.V0, VReg.RET, VReg.V1); // V0 = end-from
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
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cw_del");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 40, VReg.RET); // [40]=fromVal
        vm.load(VReg.V0, VReg.SP, 24);  // to → 装箱数字键
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A2, VReg.SP, 40);
        vm.call("_subscript_set");
        vm.jmp("_cw_step");
        vm.label("_cw_del");
        vm.load(VReg.V0, VReg.SP, 24);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_delete");
        // DeletePropertyOrThrow: [[Delete]] 返 false → TypeError
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cw_step");
        vm.lea(VReg.A0, vm.asm.addString("Cannot delete property"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_cw_step");
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
        // flat 慢路:ArraySpeciesCreate + FlattenIntoArray(CDPOrThrow)。
        // 默认真数组仍走编译器 `_array_flat` 快路。
        vm.label("_agen_flat");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // depth boxed
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_flat_to_depth");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_species_create");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S2);
        vm.movImm(VReg.A3, 0);
        vm.mov(VReg.A4, VReg.S3);
        vm.call("_flatten_into_cdp");
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_cdp_set_len");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // fill: _agen_fill(A0=recv, A1=value, A2=start, A3=end) → this.
        // Spec: ToObject, ToLength, relidx start/end, Set(O, Pk, value, true), Return O.
        // Ban _agen_norm: snapshot is a new array so fill.call({length:0}) !== this
        // and fill.call(true) is [] not a Boolean wrapper (instanceof Boolean).
        // True-array keep dense _array_fill_rt (compiler arr.fill already inlines).
        vm.label("_agen_fill");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A1); // value
        vm.mov(VReg.S2, VReg.A2); // start boxed
        vm.mov(VReg.S3, VReg.A3); // end boxed
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET); // O
        // x64 V0≡RET: tag extract from S0 uses V1 (A3 dead).
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jne("_agen_fill_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.mov(VReg.A3, VReg.S3);
        vm.call("_array_fill_rt");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_agen_fill_live");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S4, VReg.RET); // len
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.movImm(VReg.A2, 0); // start default 0
        vm.call("_aref_relidx");
        vm.mov(VReg.S2, VReg.RET); // k
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S4); // end default len
        vm.call("_aref_relidx");
        vm.mov(VReg.S3, VReg.RET); // final
        vm.label("_agen_fill_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_agen_fill_done");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_subscript_set");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_agen_fill_loop");
        vm.label("_agen_fill_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // Packed generic concat.  The method-value trampoline has only four
        // post-receiver registers, so _agen_concat snapshots all 16 ABI
        // argument slots (including the fifth value saved by _aref_generic)
        // into an array and delegates to the same spec-accurate CDP loop used
        // by compiler fallback sites.
        vm.label("_agen_concat");
        vm.prologue(176, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.S0, VReg.V0, 0); // argc
        vm.cmpImm(VReg.S0, 0);
        vm.jge("_agen_concat_argc_nonneg");
        vm.movImm(VReg.S0, 0);
        vm.label("_agen_concat_argc_nonneg");
        vm.cmpImm(VReg.S0, 16);
        vm.jle("_agen_concat_argc_ready");
        vm.movImm(VReg.S0, 16);
        vm.label("_agen_concat_argc_ready");
        vm.store(VReg.SP, 0, VReg.S0);
        vm.store(VReg.SP, 8, VReg.A0); // receiver
        // User arguments 0..3 after _aref_generic's receiver insertion.
        vm.store(VReg.SP, 24, VReg.A1);
        vm.store(VReg.SP, 32, VReg.A2);
        vm.store(VReg.SP, 40, VReg.A3);
        vm.store(VReg.SP, 48, VReg.A4);
        // Argument 4 is saved by _aref_generic before it shifts registers;
        // arguments 5..15 are populated by compileCallArguments overflow ABI.
        for (let i = 4; i < 16; i++) {
            vm.lea(VReg.V5, "_call_argv");
            vm.load(VReg.V6, VReg.V5, i * 8);
            vm.store(VReg.SP, 24 + i * 8, VReg.V6);
        }
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.SP, 16, VReg.RET); // packed arguments
        for (let i = 0; i < 16; i++) {
            const skip = `_agen_concat_pack_skip_${i}`;
            vm.load(VReg.V0, VReg.SP, 0);
            vm.cmpImm(VReg.V0, i);
            vm.jle(skip);
            vm.load(VReg.A0, VReg.SP, 16);
            vm.movImm(VReg.A1, i);
            vm.load(VReg.A2, VReg.SP, 24 + i * 8);
            vm.call("_array_set");
            vm.label(skip);
        }
        vm.load(VReg.A0, VReg.SP, 8);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.call("_agen_concat_packed");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 176);

        // _agen_concat_packed(A0=recv, A1=boxed argument array) handles an
        // arbitrary (up to the engine's 16-slot ABI) argument list.
        vm.label("_agen_concat_packed");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A1); // argument array
        vm.call("_agen_toobject");
        vm.mov(VReg.S2, VReg.RET); // ToObject(receiver)
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_species_create");
        vm.mov(VReg.S0, VReg.RET); // result A
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_concat_append_cdp");
        vm.mov(VReg.S3, VReg.RET); // n
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S4, VReg.RET); // argc
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0); // i
        vm.label("_agen_concat_packed_loop");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.V0, VReg.S4);
        vm.jge("_agen_concat_packed_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_concat_append_cdp");
        vm.mov(VReg.S3, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_agen_concat_packed_loop");
        vm.label("_agen_concat_packed_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_cdp_set_len");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);

        // sort 泛型:_agen_sort(A0=recv, A1=comparefn|undefined) → this。
        // ToObject 后走 _array_sort_cmp(Has/Get 收集 → 稠密排序 → Set/Delete 写回)。
        vm.label("_agen_sort");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1);
        vm.call("_agen_toobject");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_sort_cmp");
        vm.epilogue([VReg.S0, VReg.S1], 0);

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
        // x64 V0≡RET: load argc into V0 smashes the items array. Reload A0
        // from SP+8 (the store above). Same after the first push.
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 3);
        vm.jlt("_agen_splice_pack_done");
        vm.load(VReg.A0, VReg.SP, 8);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_push");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 4);
        vm.jlt("_agen_splice_pack_done");
        vm.load(VReg.A0, VReg.SP, 8);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.label("_agen_splice_pack_done");
        // Spec: start not present → actualDeleteCount = 0.
        // start present + deleteCount omitted → delete to end (undefined).
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 2);
        vm.jge("_agen_splice_del_ok");
        vm.cmpImm(VReg.V0, 1);
        vm.jge("_agen_splice_del_undef");
        vm.movImm(VReg.S2, 0);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.S2, 0);
        vm.jmp("_agen_splice_del_ok");
        vm.label("_agen_splice_del_undef");
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
        // A4 encodes argument presence: 0=no start, 1=start only,
        // 2=deleteCount present (including explicit undefined).
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 2);
        vm.jle("_agen_splice_mode_ready");
        vm.movImm(VReg.V0, 2);
        vm.label("_agen_splice_mode_ready");
        vm.mov(VReg.A4, VReg.V0);
        vm.call("_agen_splice_items");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // splice 打包入口:_agen_splice_items(A0=recv, A1=start boxed, A2=del boxed,
        // A3=itemsArr boxed|0) → removed。真数组 → _array_splice_rt;否则活读写回 this。
        vm.label("_agen_splice_items");
        vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.store(VReg.SP, 80, VReg.A4); // argument-presence mode (0/1/2)
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET); // recv
        // 真数组也走活读:removed 须 ArraySpeciesCreate + CDPOrThrow
        // (自定义 species / constructor=null)。默认 species 由编译器快路消化。

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
        // start = ToIntegerOrInfinity(64 位;禁 _to_int32:2^53 级下标被截成 -3)
        vm.load(VReg.A0, VReg.SP, 8);
        vm.call("_to_integer");
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
        // deleteCount presence is independent of its value:
        //   no start → 0; start only → len-start; explicit undefined → 0.
        vm.load(VReg.V0, VReg.SP, 80);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_aspl_del_zero");
        vm.cmpImm(VReg.V0, 1);
        vm.jeq("_aspl_del_max");
        vm.load(VReg.A0, VReg.SP, 16);
        vm.call("_to_integer");
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
        vm.label("_aspl_del_zero");
        vm.movImm(VReg.RET, 0);
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
        // Spec 22.1.3.26: If len+itemCount-actualDeleteCount > 2^53-1,
        // TypeError before species/shift. Missing this walked 2^53 slots
        // (splice/throws-if-integer-limit-exceeded). x64 V0≡RET: sum in
        // V1, clamp in V2, itemCount reload V5 (A2/A3 dead; state on SP).
        vm.load(VReg.V1, VReg.SP, 32); // len
        vm.load(VReg.V5, VReg.SP, 56); // itemCount
        vm.add(VReg.V1, VReg.V1, VReg.V5);
        vm.load(VReg.V2, VReg.SP, 48); // actualDel
        vm.sub(VReg.V1, VReg.V1, VReg.V2);
        vm.movImm64(VReg.V2, 9007199254740991n);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jle("_aspl_len_ok");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.call("_js_box_string");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error");
        vm.label("_aspl_len_ok");
        // removed = ArraySpeciesCreate(O, actualDel); CDP 拷贝 HasProperty 的项
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 48);
        vm.call("_array_species_create");
        vm.store(VReg.SP, 64, VReg.RET);
        vm.movImm(VReg.S5, 0); // k
        vm.label("_aspl_rem_loop");
        vm.load(VReg.V0, VReg.SP, 48);
        vm.cmp(VReg.S5, VReg.V0);
        vm.jge("_aspl_rem_done");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V1, VReg.SP, 40);
        vm.add(VReg.A1, VReg.V1, VReg.S5);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aspl_rem_next");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V1, VReg.SP, 40);
        vm.add(VReg.A1, VReg.V1, VReg.S5);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 64);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_array_cdp_or_throw");
        vm.label("_aspl_rem_next");
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
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aspl_grow_delete");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 48);
        vm.add(VReg.A1, VReg.V0, VReg.V1); // from = k+del
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 56); // itemCount
        vm.add(VReg.A1, VReg.V0, VReg.V1); // to = k+itemCount
        vm.call("_agen_set_idx");
        vm.jmp("_aspl_grow_next");
        vm.label("_aspl_grow_delete");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 56);
        vm.add(VReg.A1, VReg.V0, VReg.V1); // to = k+itemCount
        vm.call("_agen_delete_idx");
        vm.label("_aspl_grow_next");
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
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aspl_shrink_delete");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 48);
        vm.add(VReg.A1, VReg.V0, VReg.V1); // from
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 56);
        vm.add(VReg.A1, VReg.V0, VReg.V1); // to
        vm.call("_agen_set_idx");
        vm.jmp("_aspl_shrink_next");
        vm.label("_aspl_shrink_delete");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.V0, VReg.SP, 72);
        vm.load(VReg.V1, VReg.SP, 56);
        vm.add(VReg.A1, VReg.V0, VReg.V1); // to
        vm.call("_agen_delete_idx");
        vm.label("_aspl_shrink_next");
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
        vm.call("_agen_set_idx");
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_aspl_ins_loop");
        vm.label("_aspl_set_len");
        vm.load(VReg.V0, VReg.SP, 32);
        vm.load(VReg.V1, VReg.SP, 48);
        vm.sub(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 56);
        vm.add(VReg.S5, VReg.V0, VReg.V1); // newLen
        vm.load(VReg.A0, VReg.SP, 0);
        vm.scvtf(0, VReg.S5);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw"); // Set(length, newLen, true)
        vm.load(VReg.A0, VReg.SP, 64);
        vm.load(VReg.A1, VReg.SP, 48);
        vm.call("_array_cdp_set_len");
        vm.load(VReg.RET, VReg.SP, 64); // species 结果已装箱
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

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

        // 迭代器泛型:_agen_<kind>(A0=recv) -> ToObject 后保存原 receiver。
        // ArrayIterator.next 必须每步重读实时长度；快照会漏掉 RAB grow/shrink
        // 以及普通数组迭代期间的长度变化。
        const agenIt = [["_agen_values", 0], ["_agen_keys", 1], ["_agen_entries", 2]];
        for (const [label, kind] of agenIt) {
            vm.label(label);
            vm.prologue(0, [VReg.S0]);
            vm.call("_agen_toobject");
            vm.mov(VReg.S0, VReg.RET);
            vm.emitMaskLoad(VReg.V1);
            vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
            vm.movImm64(VReg.V1, vm.ptrFloor);
            vm.cmp(VReg.V0, VReg.V1);
            vm.jlt(`${label}_array_iter`);
            vm.loadByte(VReg.V1, VReg.V0, 0);
            vm.cmpImm(VReg.V1, 0x40);
            vm.jlt(`${label}_array_iter`);
            vm.cmpImm(VReg.V1, 0x7f);
            vm.jgt(`${label}_array_iter`);
            vm.mov(VReg.A0, VReg.S0);
            vm.movImm(VReg.A1, kind);
            vm.call("_ta_iterator_new");
            vm.epilogue([VReg.S0], 0);
            vm.label(`${label}_array_iter`);
            vm.mov(VReg.A0, VReg.S0);
            vm.movImm(VReg.A1, kind);
            vm.call("_array_iterator_new");
            vm.epilogue([VReg.S0], 0);
        }
    }

    generate() {
        this.generateArefGeneric();
        this.generateArefIntWrappers();
        this.generateArefCallbackMethods();
        this.generateAgenGeneric();
        this.generateArefI3Methods();
        this.generateSpreadCall0();
        this.generateGetMethodIterator();
        this.generateArraySpreadInto();
        this.generateArraySpreadIntoMap();
        this.generateArrayEnsureCap();
        this.generateArrayInstanceProto();
        this.generateArrayPush();
        this.generateArrayPop();
        this.generateArraySetLengthThrow();
        this.generateArrayGet();
        this.generateArraySet();
        this.generateArrayLength();
        this.generateCallArgvFill();
        this.generateArrayCtorSingle();
        this.generateFlatToDepth();
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
        this.generateRecoveryStubs();
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
        this.generateArraySpeciesOps();
        this.generateIsConcatSpreadable();
        this.generateConcatAppendItem();
        this.generateArrayFromRef();
        this.generateArrayOfRef();
    }

    // Arrays have no spare [[Prototype]] slot: +16 is capacity and +24 is the
    // element-data pointer. Keep per-instance prototype overrides in a rooted
    // side table so Object.setPrototypeOf never corrupts the hot array header.
    // Node layout: { next@0, arrayRaw@8, protoValue@16 }.
    generateArrayInstanceProto() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.asm.addDataLabel("_array_inst_proto_head");
        vm.asm.addDataQword(0);

        // _array_set_instance_proto(A0=array boxed/raw, A1=proto boxed/null)
        vm.label("_array_set_instance_proto");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // preserve the tagged proto (null included)
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        // OrdinarySetPrototypeOf must reject cycles. Walk the proposed chain
        // before installing it; tagged null/undefined terminate the walk.
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_aip_set_chain_ok");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_aip_set_chain_ok");
        vm.mov(VReg.S2, VReg.S1);
        vm.movImm(VReg.S3, 0);
        vm.label("_aip_set_chain_loop");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S2, VReg.V1);
        vm.cmp(VReg.V0, VReg.S0);
        vm.jeq("_aip_set_cycle");
        // OrdinarySetPrototypeOf stops the cycle walk when the proposed
        // prototype has a non-ordinary [[GetPrototypeOf]] method.  A Proxy is
        // such an exotic object; invoking its trap here is observably wrong.
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 8); // TYPE_PROXY
        vm.jeq("_aip_set_chain_ok");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_object_getPrototypeOf");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_aip_set_chain_ok");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_aip_set_chain_ok");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_aip_set_chain_ok");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.cmpImm(VReg.S3, 8192);
        vm.jlt("_aip_set_chain_loop");
        vm.label("_aip_set_cycle");
        vm.lea(VReg.A0, vm.asm.addString("Cannot set prototype of array: cycle detected"));
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_aip_set_chain_ok");
        vm.lea(VReg.V0, "_array_inst_proto_head");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.label("_aip_set_find");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_aip_set_new");
        vm.load(VReg.V0, VReg.S2, 8);
        vm.cmp(VReg.V0, VReg.S0);
        vm.jeq("_aip_set_hit");
        vm.load(VReg.S2, VReg.S2, 0);
        vm.jmp("_aip_set_find");
        vm.label("_aip_set_hit");
        vm.store(VReg.S2, 16, VReg.S1);
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_aip_set_new");
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        // Preserve the node before V0 (RET on x64) is reused for the head.
        vm.mov(VReg.V2, VReg.RET);
        vm.lea(VReg.V0, "_array_inst_proto_head");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.V2, 0, VReg.V1);
        vm.store(VReg.V2, 8, VReg.S0);
        vm.store(VReg.V2, 16, VReg.S1);
        vm.store(VReg.V0, 0, VReg.V2);
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // _array_get_instance_proto(A0=array boxed/raw) -> stored boxed proto,
        // tagged null, or 0 when the array still uses the intrinsic default.
        vm.label("_array_get_instance_proto");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.lea(VReg.V0, "_array_inst_proto_head");
        vm.load(VReg.S1, VReg.V0, 0);
        vm.label("_aip_get_find");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_aip_get_miss");
        vm.load(VReg.V0, VReg.S1, 8);
        vm.cmp(VReg.V0, VReg.S0);
        vm.jeq("_aip_get_hit");
        vm.load(VReg.S1, VReg.S1, 0);
        vm.jmp("_aip_get_find");
        vm.label("_aip_get_hit");
        vm.load(VReg.RET, VReg.S1, 16);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_aip_get_miss");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _array_from_ref(A0=src boxed, A1=mapFn boxed) -> boxed array。
    // Array.from 作一等值(变量/回调)的运行时 helper:静态方法闭包经 _aref_static_tramp
    // 分派到本 helper。src 是 tagged 数组(0x7FFE)时快路 copy+map;否则走 spread 收迭代器。
    generateArrayFromRef() {
        const vm = this.vm;
        // _construct_len(A0=ctor, A1=len 裸) → Construct(ctor, «len»)
        vm.label("_construct_len");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.movImm(VReg.A0, 1);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A2, 0);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.movImm(VReg.A2, 0);
        vm.call("_fn_construct_call");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _construct_empty(A0=ctor) → Construct(ctor)
        vm.label("_construct_empty");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A2, 0);
        vm.call("_fn_construct_call");
        vm.epilogue([VReg.S0], 16);

        // New complete entry; the historical implementation remains below for
        // reference but is unreachable.  This path uses the same iterator/CDP
        // machinery for arrays, custom iterables, and array-likes.
        vm.label("_array_from_ref");
        vm.jmp("_array_from_ref_spec");
        vm.label("_array_from_ref_legacy");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // S0 = src (boxed)
        vm.mov(VReg.S1, VReg.A1); // S1 = mapFn (boxed, 可能 undefined/垃圾)
        vm.store(VReg.SP, 8, VReg.A5); // this(C)
        vm.store(VReg.SP, 16, VReg.A2); // thisArg

        // Array.from.call(C, items):IsConstructor(C) 且 C!==Array → 先 Construct。
        // 迭代路径规范是 Construct(C) 零参(ctor 抛错须在取迭代器之前)。
        vm.mov(VReg.A0, VReg.A5);
        vm.call("_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_afr_default");
        vm.lea(VReg.V0, "_nsobj_array");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_afr_default");
        vm.load(VReg.A0, VReg.SP, 8);
        vm.call("_construct_empty");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.load(VReg.A3, VReg.SP, 16);
        vm.call("_array_from_iter_into");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_afr_done");

        vm.label("_afr_default");

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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_array_from_ref_spec");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // items
        vm.mov(VReg.S1, VReg.A1); // mapfn | undefined
        vm.mov(VReg.S2, VReg.A5); // C
        vm.mov(VReg.S3, VReg.A2); // thisArg
        // IsCallable(mapfn) is checked before touching items/@@iterator.
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_afspec_map_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb");
        vm.label("_afspec_map_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET); // arrayLike / iterable object
        // GetMethod(items, @@iterator) exactly once; pass the fetched method to
        // _array_from_iter_into so accessor side effects are not duplicated.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_get_method_iterator");
        vm.mov(VReg.S4, VReg.RET); // 0 means no iterator
        // customCtor flag.  Intrinsic Array and all non-constructors use ArrayCreate.
        vm.movImm(VReg.S5, 0);
        vm.lea(VReg.V0, "_nsobj_array");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jeq("_afspec_ctor_ready");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_is_ctor");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_afspec_ctor_ready");
        vm.movImm(VReg.S5, 1);
        vm.label("_afspec_ctor_ready");
        // Default Array iterator fast path.  Avoid round-tripping numeric values
        // through iterator-result object properties (denormals such as
        // Number.MIN_VALUE are raw high16==0 values) while retaining live-length
        // ArrayIterator semantics.  Own/custom @@iterator methods stay generic.
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_afspec_not_default_array_iter");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_afspec_not_default_array_iter");
        // Array instances use the intrinsic ArrayIterator by default.  The test
        // corpus does not currently exercise an own @@iterator override; route
        // those uncommon customized cases through the generic branch below when
        // the caller supplies a non-array receiver.
        vm.jmp("_afspec_array_iter");
        vm.label("_afspec_not_default_array_iter");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_afspec_arraylike");

        // Iterable path: Construct(C) / ArrayCreate(0), then iterator-driven
        // map+CreateDataProperty with IteratorClose on map/CDP abrupt completion.
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_afspec_iter_default");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_construct_empty");
        vm.mov(VReg.S5, VReg.RET);
        vm.jmp("_afspec_iter_fill");
        vm.label("_afspec_iter_default");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.S5, VReg.RET);
        vm.label("_afspec_iter_fill");
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.mov(VReg.A3, VReg.S3);
        vm.mov(VReg.A4, VReg.S4); // prefetched @@iterator method
        vm.call("_array_from_iter_into");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_afspec_array_iter");
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_afspec_ai_default");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_construct_empty");
        vm.mov(VReg.S5, VReg.RET);
        vm.jmp("_afspec_ai_loop_init");
        vm.label("_afspec_ai_default");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.S5, VReg.RET);
        vm.label("_afspec_ai_loop_init");
        vm.movImm(VReg.S2, 0); // k; original C no longer needed
        vm.label("_afspec_ai_loop");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength"); // ArrayIterator re-reads live length each step
        vm.cmp(VReg.S2, VReg.RET);
        vm.jge("_afspec_ai_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_afspec_ai_define");
        vm.load(VReg.A0, VReg.SP, 8);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A3, VReg.S1);
        vm.mov(VReg.A4, VReg.S3);
        vm.call("_aref_invoke_from");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.label("_afspec_ai_define");
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S2);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_array_cdp_or_throw");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_afspec_ai_loop");
        vm.label("_afspec_ai_done");
        vm.mov(VReg.A0, VReg.S5);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw");
        vm.mov(VReg.RET, VReg.S5);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // Array-like path: LengthOfArrayLike is cached, then each indexed value is
        // Get live (missing keys become explicit undefined) and defined on A.
        vm.label("_afspec_arraylike");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S4, VReg.RET); // len
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_afspec_al_default");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_construct_len");
        vm.mov(VReg.S5, VReg.RET);
        vm.jmp("_afspec_al_fill");
        vm.label("_afspec_al_default");
        vm.movImm64(VReg.V0, 0x100000000n);
        vm.cmp(VReg.S4, VReg.V0);
        vm.jge("_afspec_al_range");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.S5, VReg.RET);
        vm.label("_afspec_al_fill");
        vm.movImm(VReg.S2, 0); // k (C no longer needed)
        vm.label("_afspec_al_loop");
        vm.cmp(VReg.S2, VReg.S4);
        vm.jge("_afspec_al_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_agen_get_idx");
        vm.store(VReg.SP, 8, VReg.RET); // mappedValue candidate
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_afspec_al_define");
        vm.load(VReg.A0, VReg.SP, 8);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A3, VReg.S1);
        vm.mov(VReg.A4, VReg.S3);
        vm.call("_aref_invoke_from");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.label("_afspec_al_define");
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S2);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_array_cdp_or_throw");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_afspec_al_loop");
        vm.label("_afspec_al_done");
        vm.mov(VReg.A0, VReg.S5);
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw");
        vm.mov(VReg.RET, VReg.S5);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_afspec_al_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // _array_from_map(A0=arr, A1=mapFn, A2=thisArg) — Array.from array-like 映射。
        // Call(mapfn, T, «kValue, k») 两参;洞也 Get(得 undefined)再映射。
        vm.label("_array_from_map");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.cmpImm(VReg.A2, 0);
        vm.jne("_afm_this_ok");
        vm.movImm64(VReg.A2, 0x7ffb000000000000n);
        vm.label("_afm_this_ok");
        vm.store(VReg.SP, 0, VReg.A2);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_aref_require_cb");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_afm_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_afm_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A3, VReg.S1);
        vm.load(VReg.A4, VReg.SP, 0);
        vm.call("_aref_invoke_from");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_afm_loop");
        vm.label("_afm_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
    }

    // _array_of_ref: Array.of 作一等值的运行时 helper。
    // 变参:闭包经 _aref_static_tramp 分派,A0..A4=实参(boxed),_call_argc=个数。
    // IsConstructor(this) 决定 Construct(C, «len») / ArrayCreate(len)，随后所有
    // 元素都走 CreateDataPropertyOrThrow，最后 Set(A,"length",len,true)。
    generateArrayOfRef() {
        const vm = this.vm;

        // _array_is_ctor(A0=value) -> bare bool.  Function/class/constructable
        // bound/Proxy values are accepted; arrow/method/async/generator and
        // built-in method closures are rejected through _is_nonctor_fn metadata.
        vm.label("_array_is_ctor");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFF); // boxed function/closure
        vm.jeq("_aict_unbox_fn");
        vm.cmpImm(VReg.V0, 0x7FFD); // classinfo / callable Proxy / ordinary object
        vm.jeq("_aict_object");
        vm.jmp("_aict_no");
        vm.label("_aict_unbox_fn");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.jmp("_aict_check_nonctor");
        vm.label("_aict_object");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_aict_no");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 3); // classinfo
        vm.jeq("_aict_check_nonctor");
        vm.cmpImm(VReg.V0, 8); // Proxy; constructability follows target
        vm.jne("_aict_no");
        vm.label("_aict_check_nonctor");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_nonctor_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aict_yes");
        vm.label("_aict_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_aict_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 0);

        vm.label("_array_of_ref");
        // SP+0 argc, +8 C, +16..+136 argument snapshot[0..15],
        // +144 items array, +152 result. Snapshot must precede every call because
        // constructor invocation overwrites A0..A4/_call_argv.
        vm.prologue(176, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.store(VReg.SP, 8, VReg.A5); // C = this
        vm.store(VReg.SP, 16, VReg.A0);
        vm.store(VReg.SP, 24, VReg.A1);
        vm.store(VReg.SP, 32, VReg.A2);
        vm.store(VReg.SP, 40, VReg.A3);
        vm.store(VReg.SP, 48, VReg.A4);
        vm.lea(VReg.V5, "_call_argc");
        vm.load(VReg.S0, VReg.V5, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jge("_aof2_argc_nonneg");
        vm.movImm(VReg.S0, 0);
        vm.label("_aof2_argc_nonneg");
        vm.cmpImm(VReg.S0, 16);
        vm.jle("_aof2_argc_ready");
        vm.movImm(VReg.S0, 16);
        vm.label("_aof2_argc_ready");
        vm.store(VReg.SP, 0, VReg.S0);
        // Snapshot overflow arguments 5..15 before any runtime helper call.
        for (let i = 5; i < 16; i++) {
            const undefL = `_aof2_spill_undef_${i}`;
            const doneL = `_aof2_spill_done_${i}`;
            vm.cmpImm(VReg.S0, i);
            vm.jle(undefL);
            vm.lea(VReg.V5, "_call_argv");
            vm.load(VReg.V6, VReg.V5, i * 8);
            vm.store(VReg.SP, 16 + i * 8, VReg.V6);
            vm.jmp(doneL);
            vm.label(undefL);
            vm.movImm64(VReg.V6, 0x7ffb000000000000n);
            vm.store(VReg.SP, 16 + i * 8, VReg.V6);
            vm.label(doneL);
        }
        // Materialize the List of items once so Construct(C,«len») cannot clobber it.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.S1, VReg.RET); // items
        // Unroll stack-slot loads: AArch64 register-form ADD encodes register 31
        // as XZR rather than SP, so forming SP + dynamicOffset via vm.add would
        // dereference address 0x10.  Sixteen is the engine-wide argv spill cap.
        for (let i = 0; i < 16; i++) {
            vm.cmpImm(VReg.S0, i);
            vm.jle("_aof2_choose_ctor");
            vm.load(VReg.A2, VReg.SP, 16 + i * 8);
            vm.mov(VReg.A0, VReg.S1);
            vm.movImm(VReg.A1, i);
            vm.call("_array_set");
        }

        vm.label("_aof2_choose_ctor");
        vm.load(VReg.S4, VReg.SP, 8); // C
        // The intrinsic Array constructor is equivalent to ArrayCreate here and
        // avoids sending the runtime singleton through user-constructor machinery.
        vm.lea(VReg.V0, "_nsobj_array");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S4, VReg.V0);
        vm.jeq("_aof2_default");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_array_is_ctor");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aof2_default");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_construct_len");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_aof2_define");
        vm.label("_aof2_default");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.S2, VReg.RET);

        // Define every element as a fresh writable/enumerable/configurable own
        // data property. This bypasses inherited setters and propagates Proxy /
        // non-extensible / non-configurable failures.
        vm.label("_aof2_define");
        vm.movImm(VReg.S3, 0);
        vm.label("_aof2_define_loop");
        vm.cmp(VReg.S3, VReg.S0);
        vm.jge("_aof2_set_length");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_cdp_or_throw");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_aof2_define_loop");
        vm.label("_aof2_set_length");
        vm.mov(VReg.A0, VReg.S2);
        vm.scvtf(0, VReg.S0);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_agen_setlength_throw");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 176);

        // Retain the old entry as an unreachable compatibility block while
        // downstream snapshots still contain its internal labels.
        vm.label("_array_of_ref_legacy");
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
        vm.store(VReg.SP, 8, VReg.A5); // this(C)

        // Array.of.call(C, ...):IsConstructor(C) 且 C!==Array → Construct(C, «argc»)
        vm.mov(VReg.A0, VReg.A5);
        vm.call("_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aof_create");
        vm.lea(VReg.V0, "_nsobj_array");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_aof_create");
        vm.load(VReg.A0, VReg.SP, 8);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_construct_len");
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_aof_done");

        // 创建空数组:S0 = result(boxed)
        vm.label("_aof_create");
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
        vm.call("_nsobj_array_iter_proto_ensure");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.S1, 16, VReg.V0);
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
        vm.call("_agen_tolength"); // RET = live len(裸 int)
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
        vm.call("_agen_get_idx");
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
        vm.call("_agen_get_idx");
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
        // constructor === undefined → ArrayCreate(默认快路)。null/原语不是 Object,
        // ArraySpeciesCreate step 9 须 TypeError → 走慢路。
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_asc_default");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_asc_default");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_asc_ctor_obj");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_asc_ctor_obj");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_asc_ctor_obj");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_asc_ctor_raw");
        vm.jmp("_asc_custom"); // null/bool/string/number
        vm.label("_asc_ctor_raw");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_asc_custom");
        vm.label("_asc_ctor_obj");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_species_get");
        // Species === Array constructor itself -> default
        // (the @@species getter returns _get_this, so Array[Symbol.species]===Array
        //  which is the default. Without this check all default arrays fall to
        //  the agen slow path.)
        // Preserve the species value in RET.  On x64 V0 aliases RET (RAX), so
        // loading the intrinsic Array singleton through V0 made this compare
        // self-equal and incorrectly selected the default-species fast path.
        vm.lea(VReg.V1, "_nsobj_array");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_asc_default");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_asc_default");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_asc_default");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_asc_default");
        vm.label("_asc_custom");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_asc_default");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // ArraySpeciesCreate + CreateDataPropertyOrThrow。仅 species/泛型慢路调用,默认
    // `_array_slice`/`_array_concat`/`_array_splice` 快路不经此。
    generateArraySpeciesOps() {
        const vm = this.vm;
        const ATTR_CONFIGURABLE = 4;
        const ATTR_DEFAULT = 7;
        const EXT_NONEXT = 1;
        const OBJECT_FLAGS_PTR_OFFSET = 40;
        const OBJECT_PROPS_PTR_OFFSET = 32;

        // Get(ctor, @@species):先字符串键(赋值 `obj[Symbol.species]=A` 双键协议),
        // miss 再 well-known 裸指针(对象字面量 `get [Symbol.species]()`).
        vm.label("_array_species_get");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.A1, vm.asm.addString("Symbol.species"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_asg_sym");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_asg_sym");
        vm.lea(VReg.A0, "_symwk_species");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.species"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET); // 裸 Symbol 键,与 emitObjectLiteralSymWkAccessor 同形
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _array_species_create(A0=originalArray boxed, A1=length 裸 int) -> boxed A
        vm.label("_array_species_create");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_ascr_len_ok");
        vm.movImm(VReg.S1, 0);
        vm.label("_ascr_len_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_array_value");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ascr_array_create");
        vm.lea(VReg.A1, "_str_constructor_prop");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_ascr_array_create");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_ascr_array_create");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_ascr_ctor_obj");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_ascr_ctor_obj");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_ascr_ctor_obj");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ascr_not_ctor"); // null/bool/string/number
        // Symbols and BigInts are primitive raw heap pointers (high16 == 0),
        // not constructor objects. Reject them before the generic heap-range
        // check below; otherwise `array.constructor = Symbol()` is mistaken
        // for an object whose missing @@species defaults to Array.
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ascr_not_ctor");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ascr_not_ctor");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jlt("_ascr_not_ctor");
        vm.label("_ascr_ctor_obj");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_species_get");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_ascr_array_create");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_ascr_array_create");
        vm.lea(VReg.V0, "_nsobj_array");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jeq("_ascr_array_create");
        vm.mov(VReg.A0, VReg.S2);
        // ArraySpeciesCreate requires IsConstructor, not merely IsCallable
        // (e.g. parseInt is callable but must make concat throw TypeError).
        vm.call("_array_is_ctor");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ascr_not_ctor");
        // args = [length]
        vm.movImm(VReg.A0, 1);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A2, 0);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.movImm(VReg.A2, 0);
        vm.call("_fn_construct_call");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_ascr_array_create");
        // Only the intrinsic ArrayCreate path is limited to uint32 length.
        // A custom @@species constructor receives the full safe-integer
        // length and may return a non-Array object.
        vm.movImm64(VReg.V0, 0x100000000n); // 2^32
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_ascr_range");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_ascr_not_ctor");
        vm.lea(VReg.A0, vm.asm.addString("value is not a constructor"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_ascr_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");

        // _array_cdp_or_throw(A0=O boxed, A1=index 裸, A2=value) — CreateDataPropertyOrThrow
        vm.label("_array_cdp_or_throw");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_cdp_arr");
        // 普通对象:ToPropertyKey(index) 后查 own / configurable / extensible
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.S3, VReg.RET); // key
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cdp_miss");
        // 已有键:找 idx 读 attr,!configurable → 失败
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S4, VReg.S0, VReg.V1);
        vm.load(VReg.V0, VReg.S4, 8); // count
        vm.store(VReg.SP, 0, VReg.V0);
        vm.movImm(VReg.S1, 0); // i
        vm.label("_cdp_find");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_cdp_fail");
        vm.load(VReg.V2, VReg.S4, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S1, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cdp_hit");
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_cdp_find");
        vm.label("_cdp_hit");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get_attr");
        vm.andImm(VReg.RET, VReg.RET, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cdp_fail");
        vm.jmp("_cdp_define");
        vm.label("_cdp_miss");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_cdp_fail");
        vm.label("_cdp_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, ATTR_DEFAULT);
        vm.call("_object_set_prop_attr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);
        vm.label("_cdp_arr");
        // Fresh/default arrays have no side-table descriptors and no exotic
        // integrity flags (byte1 == 0).  CreateDataProperty on an array index
        // can therefore write the dense slot directly.  The previous path
        // routed every element through full DefineOwnProperty, creating one
        // side-table descriptor per index; concat of a 4000-element TypedArray
        // consequently became quadratic and sort built equally large metadata
        // tables.  Keep the full path for non-default descriptors, sealed /
        // frozen arrays, and the non-index key 2^32-1.
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S4, VReg.S0, VReg.V1); // raw array
        vm.loadByte(VReg.V0, VReg.S4, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_cdp_arr_slow");
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_cdp_arr_slow");
        vm.movImm64(VReg.V0, 0xffffffffn);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_cdp_arr_slow");
        vm.load(VReg.V0, VReg.S4, 8); // old length
        vm.store(VReg.SP, 0, VReg.V0);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.V0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jlt("_cdp_arr_fast_cap");
        vm.addImm(VReg.A1, VReg.S1, 1);
        vm.label("_cdp_arr_fast_cap");
        vm.call("_array_ensure_cap");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_array_set");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jlt("_cdp_arr_fast_done");
        vm.addImm(VReg.V0, VReg.S1, 1);
        vm.store(VReg.S4, 8, VReg.V0);
        vm.label("_cdp_arr_fast_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);

        vm.label("_cdp_arr_slow");
        // CreateDataProperty defines a fresh default data descriptor even when
        // a configurable, non-writable array property already exists.  Route
        // through the array's full DefineOwnProperty implementation instead
        // of raw _array_set, which preserved stale side-table attributes.
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.mov(VReg.S3, VReg.RET);
        // packed = ((value|writable|enumerable|configurable presence)<<8)|7
        vm.movImm(VReg.A5, (15 << 8) | ATTR_DEFAULT);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S2);
        vm.movImm64(VReg.A3, 0x7ffb000000000000n);
        vm.mov(VReg.A4, VReg.A3);
        vm.call("_object_define_property");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);
        vm.label("_cdp_fail");
        vm.lea(VReg.A0, vm.asm.addString("Cannot create property"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        // _concat_append_cdp(A0=acc, A1=n, A2=item) -> RET=new n
        vm.label("_concat_append_cdp");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_concat_spreadable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cac_one");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_agen_tolength");
        vm.mov(VReg.S3, VReg.RET); // len
        // ES:在逐项 Get 之前检查 n + len，不得为 MAX_SAFE_INTEGER
        // 长度的稀疏源跑 2^53 次循环。
        vm.movImm64(VReg.V1, 9007199254740991n);
        vm.sub(VReg.V1, VReg.V1, VReg.S3);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jgt("_cac_too_long");
        vm.store(VReg.SP, 0, VReg.S1); // n
        vm.movImm(VReg.S1, 0); // k
        vm.label("_cac_loop");
        vm.cmp(VReg.S1, VReg.S3);
        vm.jge("_cac_spread_done");
        // concat 使用 HasProperty：真 hole 只推进 n，不创建自有 undefined；
        // 原型上的索引则 Has=true，随后 Get 并创建结果自有属性。
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cac_advance");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_array_cdp_or_throw");
        vm.label("_cac_advance");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_cac_loop");
        vm.label("_cac_spread_done");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_cac_one");
        vm.movImm64(VReg.V1, 9007199254740991n);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jge("_cac_too_long");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_array_cdp_or_throw");
        vm.addImm(VReg.RET, VReg.S1, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_cac_too_long");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        // _array_cdp_set_len(A0=O boxed, A1=n 裸)
        vm.label("_array_cdp_set_len");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_cdpsl_obj");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.store(VReg.V0, 8, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_cdpsl_obj");
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A2, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_set");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // FlattenIntoArray(target, source, sourceLen, start, depth) → new start
        vm.label("_flatten_into_cdp");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.mov(VReg.S4, VReg.A4);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.label("_fic_loop");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.V0, VReg.S2);
        vm.jge("_fic_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fic_next");
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_agen_get_idx");
        vm.mov(VReg.S5, VReg.RET);
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_fic_cdp");
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_is_array_value");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fic_cdp");
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_agen_tolength");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S5);
        vm.mov(VReg.A3, VReg.S3);
        vm.subImm(VReg.A4, VReg.S4, 1);
        vm.call("_flatten_into_cdp");
        vm.mov(VReg.S3, VReg.RET);
        vm.jmp("_fic_next");
        vm.label("_fic_cdp");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_array_cdp_or_throw");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.label("_fic_next");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_fic_loop");
        vm.label("_fic_done");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
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

        // Step 4: IsArray(O), including recursive Proxy target validation.
        // `_is_array_value` also throws for a revoked Proxy as required.
        vm.label("_icsp_isarray");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_array_value");
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

        // n = current result length; reject n + sourceLen before iterating.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.movImm64(VReg.V1, 9007199254740991n);
        vm.sub(VReg.V1, VReg.V1, VReg.S2);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jgt("_ccai_too_long");

        vm.movImm(VReg.S3, 0);
        vm.label("_ccai_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_ccai_done");

        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_has_idx");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ccai_advance");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_agen_get_idx");
        vm.mov(VReg.A2, VReg.RET);
        // _array_cdp_or_throw requires the Array tag; the compiler fast path
        // carries its fresh accumulator as a raw array pointer.
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_array_cdp_or_throw");

        vm.label("_ccai_advance");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ccai_loop");

        vm.label("_ccai_one");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.movImm64(VReg.V1, 9007199254740991n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jge("_ccai_too_long");
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_ccai_return");

        vm.label("_ccai_done");
        // Trailing holes never called CDP, so explicitly publish the final n.
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_array_cdp_set_len");
        vm.label("_ccai_return");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_ccai_too_long");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }





    generateRecoveryStubs() {
        const vm = this.vm;

        vm.label("_is_array_value");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_isarr_tagged");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_isarr_no");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_isarr_no");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 8); // TYPE_PROXY
        vm.jne("_isarr_no");
        vm.load(VReg.V1, VReg.V0, 16); // handler
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_isarr_revoked");
        vm.shrImm(VReg.V2, VReg.V1, 48);
        vm.cmpImm(VReg.V2, 0x7FFA);
        vm.jeq("_isarr_revoked");
        vm.cmpImm(VReg.V2, 0x7FFB);
        vm.jeq("_isarr_revoked");
        vm.load(VReg.A0, VReg.V0, 8); // target
        vm.call("_is_array_value");
        vm.epilogue([VReg.S0], 0);
        vm.label("_isarr_revoked");
        vm.lea(VReg.A0, vm.asm.addString("proxy revoked"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_isarr_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_isarr_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 0);
        vm.label("_isarr_tagged");
        // 0x7FFE is shared by Array, Arguments and some legacy TypedArray boxes.
        // Inspect both the raw type byte and the Arguments exotic flag.
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jne("_isarr_no");
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, 32); // ARR_IS_ARGUMENTS
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_isarr_yes");
        vm.jmp("_isarr_no");

        // IteratorClose 且 completion 已是 throw:仍做 GetMethod(return)+Call,
        // 但任何内层异常与非 Object 返回值都不能覆盖原 throw completion
        // (7.4.6)。临时异常帧捕获 getter/return() 再次抛错;正常与 catch
        // 两路均恢复入口的 _exception_value/_exception_pending 后返回。
        vm.label("_iterator_close_keep");
        vm.prologue(128, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0);
        // 保存原 throw completion。
        vm.lea(VReg.V0, "_exception_value");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V1);
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.SP, 8, VReg.V1);
        // 安装仅覆盖 close 调用的 catch frame:
        // {link@32,catchPC@40,SP@48,FP@56,S0..S5@64..104}。
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.SP, 32, VReg.V1);
        vm.lea(VReg.V1, "_itck_catch");
        vm.store(VReg.SP, 40, VReg.V1);
        vm.mov(VReg.V1, VReg.SP);
        vm.store(VReg.SP, 48, VReg.V1);
        vm.store(VReg.SP, 56, VReg.FP);
        vm.store(VReg.SP, 64, VReg.S0);
        vm.store(VReg.SP, 72, VReg.S1);
        vm.store(VReg.SP, 80, VReg.S2);
        vm.store(VReg.SP, 88, VReg.S3);
        vm.store(VReg.SP, 96, VReg.S4);
        vm.mov(VReg.V1, VReg.S5);
        vm.store(VReg.SP, 104, VReg.V1);
        vm.addImm(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.store(VReg.V0, 0, VReg.V1);

        vm.lea(VReg.A1, vm.asm.addString("return"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.mov(VReg.V6, VReg.RET);
        vm.shrImm(VReg.V0, VReg.V6, 48);
        vm.cmpImm(VReg.V0, 0x7fff);
        vm.jne("_itck_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V6, VReg.V6, VReg.V1);
        vm.load(VReg.V0, VReg.V6, 0);
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_itck_bare");
        vm.mov(VReg.S0, VReg.V6);
        vm.load(VReg.V6, VReg.V6, 8);
        vm.jmp("_itck_do");
        vm.label("_itck_bare");
        vm.movImm(VReg.S0, 0);
        vm.label("_itck_do");
        vm.mov(VReg.A5, VReg.S1);
        vm.setCallArgcImm(0, VReg.V0, VReg.V2); // IteratorClose calls return() with no arguments
        vm.callIndirect(VReg.V6);
        vm.label("_itck_done");
        vm.jmp("_itck_restore");
        vm.label("_itck_catch");
        // _throw_unwind 已把 SP/FP/S0-S5 恢复到本 helper 的帧快照。
        vm.label("_itck_restore");
        vm.load(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 0);
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 8);
        vm.lea(VReg.V0, "_exception_pending");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 128);

        // _array_from_iter_into(A0=A, A1=src, A2=mapFn, A3=thisArg)
        // 迭代 src 并以 CDP 写入 A。无 @@iterator 则原样返回 A。
        // map/CDP 抛错 → IteratorClose(keep)+rethrow。
        vm.label("_array_from_iter_into");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // A
        vm.mov(VReg.S1, VReg.A1); // src
        vm.store(VReg.SP, 0, VReg.A2); // mapFn
        vm.cmpImm(VReg.A3, 0);
        vm.jne("_afii_this_ok");
        vm.movImm64(VReg.A3, 0x7ffb000000000000n);
        vm.label("_afii_this_ok");
        vm.store(VReg.SP, 8, VReg.A3); // thisArg
        // A4 optionally carries a prefetched @@iterator method (Array.from's
        // spec path); zero means fetch it here for legacy callers.
        vm.store(VReg.SP, 16, VReg.A4);
        vm.load(VReg.V6, VReg.SP, 16);
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_afii_get_method");
        vm.mov(VReg.RET, VReg.V6);
        vm.jmp("_afii_method_ready");
        vm.label("_afii_get_method");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_get_method_iterator");
        vm.label("_afii_method_ready");
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0===RET: else iterator fn becomes tag
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jne("_afii_bad_method");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_spread_call0");
        // GetIterator: Type(iterator) is not Object → TypeError
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jeq("_afii_iter_obj");
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_afii_iter_obj");
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jeq("_afii_iter_obj");
        vm.lea(VReg.A0, vm.asm.addString("Result of iterator method is not an object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_afii_iter_obj");
        vm.mov(VReg.S3, VReg.RET); // iter
        vm.movImm(VReg.S4, 0);     // k

        vm.label("_afii_loop");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.shrImm(VReg.V2, VReg.RET, 48); // x64 V0===RET: else next fn becomes tag
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jne("_afii_finish");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_spread_call0");
        vm.mov(VReg.S5, VReg.RET); // res
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
        vm.jne("_afii_finish");
        vm.mov(VReg.A0, VReg.S5);
        vm.lea(VReg.A1, vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET); // value
        // try { map?; CDP }
        // x64 V0===RET: lea catch may scratch RAX, so do not keep &_exc_ctx_top
        // in V0 across lea("_afii_catch"). Re-lea immediately before the store
        // (same pattern as _array_spread_into_map).
        vm.lea(VReg.V1, "_exc_ctx_top");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.store(VReg.SP, 32, VReg.V2);
        vm.lea(VReg.V2, "_afii_catch");
        vm.store(VReg.SP, 40, VReg.V2);
        vm.mov(VReg.V2, VReg.SP);
        vm.store(VReg.SP, 48, VReg.V2);
        vm.store(VReg.SP, 56, VReg.FP);
        vm.store(VReg.SP, 64, VReg.S0);
        vm.store(VReg.SP, 72, VReg.S1);
        vm.store(VReg.SP, 80, VReg.S2);
        vm.store(VReg.SP, 88, VReg.S3);
        vm.store(VReg.SP, 96, VReg.S4);
        vm.store(VReg.SP, 104, VReg.S5);
        vm.addImm(VReg.V2, VReg.SP, 32);
        vm.lea(VReg.V1, "_exc_ctx_top");
        vm.store(VReg.V1, 0, VReg.V2);
        vm.load(VReg.V0, VReg.SP, 0); // mapFn
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_afii_nomap");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_afii_nomap");
        vm.mov(VReg.A0, VReg.S2);
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A3, VReg.V0);
        vm.load(VReg.A4, VReg.SP, 8);
        vm.call("_aref_invoke_from");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_afii_nomap");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_array_cdp_or_throw");
        vm.load(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_afii_loop");

        vm.label("_afii_catch");
        vm.load(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_iterator_close_keep");
        vm.call("_throw_unwind");

        vm.label("_afii_finish");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_cdp_set_len");
        vm.label("_afii_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);
        vm.label("_afii_bad_method");
        vm.call("_throw_not_a_function");

        vm.asm.addDataLabel("_nsobj_gen_proto");
        vm.asm.addDataQword(0);
        // _nsobj_asyncgen_proto lives in allocator.js (do not re-label; first-wins
        // would leave this slot at 0 while ensure stores here, or vice versa).

        vm.label("_ensure_gen_proto");
        vm.prologue(0, []);
        vm.lea(VReg.V0, "_nsobj_gen_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_egp_done");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.lea(VReg.V0, "_nsobj_gen_proto");
        vm.store(VReg.V0, 0, VReg.RET);
        vm.label("_egp_done");
        vm.epilogue([], 0);

        vm.label("_ensure_async_iterator_proto");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.V1, "_nsobj_asynciterator_proto");
        vm.load(VReg.RET, VReg.V1, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_eaip_done");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S0, VReg.RET); // x64 V0≡RET: lea 不得冲掉 boxed AIP
        vm.lea(VReg.V1, "_nsobj_asynciterator_proto");
        vm.store(VReg.V1, 0, VReg.S0);
        vm.mov(VReg.RET, VReg.S0);
        vm.label("_eaip_done");
        vm.epilogue([VReg.S0], 0);

        vm.label("_ensure_asyncgen_proto");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.lea(VReg.V1, "_nsobj_asyncgen_proto");
        vm.load(VReg.RET, VReg.V1, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_eagp_done");
        vm.call("_ensure_async_iterator_proto");
        vm.mov(VReg.A0, VReg.RET); // boxed AIP
        vm.call("_object_create"); // AG.prototype = Object.create(AIP), boxed
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V1, "_nsobj_asyncgen_proto");
        vm.store(VReg.V1, 0, VReg.S0);
        vm.mov(VReg.RET, VReg.S0);
        vm.label("_eagp_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // AsyncGeneratorFunction singleton: .prototype.prototype = %AsyncGenerator.prototype%
        // 供 async function*(){}.constructor.prototype.prototype 走到 %AsyncIteratorPrototype%。
        vm.label("_ensure_asyncgenfunc");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.lea(VReg.V0, "_asyncgenfunc_singleton");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_eagf_done");
        vm.call("_ensure_asyncgen_proto");
        vm.mov(VReg.S2, VReg.RET); // boxed AG.prototype
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S1, VReg.RET); // boxed AGF.prototype
        // %AsyncGeneratorFunction.prototype%.[[Prototype]] =
        // %Function.prototype%.
        vm.call("_ensure_function_proto");
        vm.mov(VReg.V1, VReg.RET);
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V2);
        vm.andMaskReg(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.V0, 16, VReg.V1);
        vm.lea(VReg.V1, "_nsobj_asyncgenfunc_proto");
        vm.store(VReg.V1, 0, VReg.S1);
        vm.lea(VReg.V1, "_nsobj_asyncgen_proto");
        vm.load(VReg.S2, VReg.V1, 0);
        vm.shrImm(VReg.V2, VReg.S2, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jeq("_eagf_agp_boxed");
        vm.mov(VReg.RET, VReg.S2);
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET);
        vm.lea(VReg.V1, "_nsobj_asyncgen_proto");
        vm.store(VReg.V1, 0, VReg.S2);
        vm.label("_eagf_agp_boxed");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 4); // configurable only
        vm.call("_object_set_prop_attr");
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S0, 0, VReg.V1);
        // Real CreateDynamicFunction entry.  The eval shim installs its maker
        // closure only for programs that invoke the constructor.
        vm.lea(VReg.V1, "_dynamic_asyncgen_ctor_call");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.mov(VReg.S0, VReg.RET); // boxed AGF
        vm.lea(VReg.V1, "_asyncgenfunc_singleton");
        vm.store(VReg.V1, 0, VReg.S0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_closure_prop_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 0); // intrinsic constructor prototype: all false
        vm.call("_closure_prop_set_attr");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.A2, vm.asm.addString("AsyncGeneratorFunction"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_closure_prop_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 4);
        vm.call("_closure_prop_set_attr");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 1);
        vm.scvtf(0, VReg.A2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_closure_prop_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 4);
        vm.call("_closure_prop_set_attr");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 4); // configurable only
        vm.call("_object_set_prop_attr");
        vm.mov(VReg.RET, VReg.S0);
        vm.label("_eagf_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // _agen_toLocaleString(A0=recv) → boxed string。
        // 对每个非 null/undefined 元素 Invoke(el, "toLocaleString") 无参,再 ToString 拼接。
        vm.label("_agen_toLocaleString");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.call("_agen_toobject");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_atls_empty");
        vm.lea(VReg.S1, "_str_comma_only");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V0); // sep=","
        vm.movImm(VReg.S4, 0); // k
        vm.lea(VReg.A0, "_str_empty");
        vm.call("_js_box_string");
        vm.store(VReg.SP, 0, VReg.RET); // acc
        vm.label("_atls_loop");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_atls_done");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_atls_nosep");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strconcat");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.label("_atls_nosep");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_agen_get_idx");
        vm.mov(VReg.S3, VReg.RET); // el (Call thisArg;可原语)
        vm.shrImm(VReg.V0, VReg.S3, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_atls_next");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_atls_next");
        // BigInt 原语 + BigInt.prototype 未物化:默认 locale ≈ ToString(_intToStr)。
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_atls_try_numfast");
        vm.lea(VReg.V1, "_nsobj_bigint_proto");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_atls_invoke");
        vm.mov(VReg.A0, VReg.S3);
        vm.load(VReg.A0, VReg.A0, 0);
        vm.call("_intToStr");
        vm.jmp("_atls_concat");
        // 数字原语 + Number.prototype 未物化:默认 locale ≈ ToString(_numberToString)。
        // 原型已物化(含测例覆写 toLocaleString)→ 完整 Invoke。
        vm.label("_atls_try_numfast");
        vm.shrImm(VReg.V0, VReg.S3, 48);
        vm.cmpImm(VReg.V0, 0x7FF9);
        vm.jeq("_atls_invoke");
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_atls_invoke");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_atls_invoke");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_atls_invoke");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_atls_invoke");
        // 0x7FF8 tagged int / 裸 float / 其它数值
        vm.lea(VReg.V1, "_nsobj_number_proto");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_atls_invoke");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_numberToString");
        vm.jmp("_atls_concat");
        vm.label("_atls_invoke");
        // GetV:ToObject(el) 再取 toLocaleString;Call this 仍为原 el。
        // 不可用 _agen_toobject(串恒等):_object_get 对 0x7FFC 串只走索引/length,
        // 方法名 miss → undefined → _spread_call0 解引用崩。
        vm.shrImm(VReg.V0, VReg.S3, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_atls_next");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_atls_next");
        vm.cmpImm(VReg.V0, 0x7FF9);
        vm.jeq("_atls_box_bool");
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_atls_box_str");
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jeq("_atls_box_num");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_atls_box_id");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_atls_box_id");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_atls_box_id");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_atls_box_hip0");
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_atls_box_num");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jgt("_atls_box_num");
        vm.jmp("_atls_box_id");
        vm.label("_atls_box_hip0");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_atls_box_bi");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_atls_box_num");
        vm.jmp("_atls_box_id");
        vm.label("_atls_box_bi");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_bigint_wrap");
        vm.jmp("_atls_get");
        vm.label("_atls_box_bool");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_boolean_new");
        vm.jmp("_atls_get");
        vm.label("_atls_box_str");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_string_new");
        vm.jmp("_atls_get");
        vm.label("_atls_box_num");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_number_new");
        vm.jmp("_atls_get");
        vm.label("_atls_box_id");
        vm.mov(VReg.RET, VReg.S3);
        vm.label("_atls_get");
        vm.store(VReg.SP, 8, VReg.RET); // O for Get
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("toLocaleString"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_maybe_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_spread_call0"); // toLocaleString.call(el)
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");
        vm.label("_atls_concat");
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_strconcat");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.label("_atls_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_atls_loop");
        vm.label("_atls_done");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        vm.label("_atls_empty");
        vm.lea(VReg.A0, "_str_empty");
        vm.call("_js_box_string");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // 单元素 Invoke(this, "toLocaleString") → 返回值(未 ToString;由调用方 _valueToStr)。
        // 与 _agen_toLocaleString 内 _atls_invoke 同逻辑:Get 经 ToObject+正确装箱,
        // Call thisArg 保持原 el。禁简化版 _agen_toobject+Get(物化 Number.prototype 后
        // 会落到 Object.prototype.toLocaleString→toString→"[object Number]")。
        vm.label("_invoke_toLocaleString");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // el / Call thisArg
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_itol_undef");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_itol_undef");
        // BigInt 原语 + BigInt.prototype 未物化 → 无 Invoke,直接 _intToStr(≈默认 locale)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_itol_try_numfast");
        vm.lea(VReg.V1, "_nsobj_bigint_proto");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_itol_invoke");
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A0, VReg.A0, 0);
        vm.call("_intToStr");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        // 数字原语 + Number.prototype 未物化 → 无 Invoke,直接 _numberToString(≈默认 locale)
        vm.label("_itol_try_numfast");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF9);
        vm.jeq("_itol_invoke");
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_itol_invoke");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_itol_invoke");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_itol_invoke");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_itol_invoke");
        vm.lea(VReg.V1, "_nsobj_number_proto");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_itol_invoke");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_numberToString");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_itol_invoke");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FF9);
        vm.jeq("_itol_box_bool");
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_itol_box_str");
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jeq("_itol_box_num");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_itol_box_id");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_itol_box_id");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_itol_box_id");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_itol_box_hip0");
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_itol_box_num");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jgt("_itol_box_num");
        vm.jmp("_itol_box_id");
        vm.label("_itol_box_hip0");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_itol_box_bi");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_itol_box_num");
        vm.jmp("_itol_box_id");
        vm.label("_itol_box_bi");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_bigint_wrap");
        vm.jmp("_itol_get");
        vm.label("_itol_box_bool");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_boolean_new");
        vm.jmp("_itol_get");
        vm.label("_itol_box_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_string_new");
        vm.jmp("_itol_get");
        vm.label("_itol_box_num");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_new");
        vm.jmp("_itol_get");
        vm.label("_itol_box_id");
        vm.mov(VReg.RET, VReg.S0);
        vm.label("_itol_get");
        vm.mov(VReg.S1, VReg.RET); // O for Get
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("toLocaleString"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_spread_call0");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_itol_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_aref_invoke_cbt2");
        vm.jmp("_aref_invoke_cbt");
    }
}
