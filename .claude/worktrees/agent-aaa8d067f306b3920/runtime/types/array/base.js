// asm.js 数组运行时 - 基础操作
// push, pop, get, set, length, at, newWithSize

import { VReg } from "../../../vm/registers.js";
import { JS_UNDEFINED } from "../../core/jsvalue.js";

const ARRAY_HEADER_SIZE = 24; // type + length + capacity
const ARRAY_MIN_CAPACITY = 8;

// 数组基础操作 Mixin
export const ArrayBaseMixin = {
    // 数组 push（带容量检查和自动扩容）
    // _array_push(arr_jsvalue, value) -> 数组 JSValue（扩容后可能变化）
    generateArrayPush() {
        const vm = this.vm;

        vm.label("_array_push");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器,老容器记入记忆集;分代 GC 已是缺省)

        // 先保存 value
        vm.mov(VReg.S1, VReg.A1); // S1 = value

        // 然后 unbox 数组
        vm.mov(VReg.A0, VReg.A0);
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET); // S0 = unboxed 数组指针

        // 获取当前长度和容量
        vm.load(VReg.S2, VReg.S0, 0); // length
        vm.load(VReg.S3, VReg.S0, 8); // capacity

        // 检查是否需要扩容: if (length >= capacity)
        vm.cmp(VReg.S2, VReg.S3);
        vm.jlt("_array_push_no_grow");

        // === 需要扩容 ===
        vm.shlImm(VReg.S4, VReg.S3, 1); // newCap = cap * 2

        // 分配新数组: 16 (header) + newCap * 8
        vm.shlImm(VReg.A0, VReg.S4, 3);
        vm.addImm(VReg.A0, VReg.A0, ARRAY_HEADER_SIZE);
        vm.call("_alloc");

        vm.mov(VReg.V0, VReg.RET);
        vm.store(VReg.V0, 0, VReg.S2); // length
        vm.store(VReg.V0, 8, VReg.S4); // newCapacity

        // 复制元素
        vm.movImm(VReg.V2, 0);
        vm.label("_array_push_copy_loop");
        vm.cmp(VReg.V2, VReg.S2);
        vm.jge("_array_push_copy_done");

        vm.shlImm(VReg.V3, VReg.V2, 3);
        vm.addImm(VReg.V3, VReg.V3, ARRAY_HEADER_SIZE);
        vm.add(VReg.V3, VReg.S0, VReg.V3);
        vm.load(VReg.V4, VReg.V3, 0);

        vm.shlImm(VReg.V3, VReg.V2, 3);
        vm.addImm(VReg.V3, VReg.V3, ARRAY_HEADER_SIZE);
        vm.add(VReg.V3, VReg.V0, VReg.V3);
        vm.store(VReg.V3, 0, VReg.V4);

        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_array_push_copy_loop");

        vm.label("_array_push_copy_done");
        vm.mov(VReg.S0, VReg.V0);

        vm.label("_array_push_no_grow");
        // 计算元素偏移: 16 + length * 8
        vm.shlImm(VReg.V0, VReg.S2, 3);
        vm.addImm(VReg.V0, VReg.V0, ARRAY_HEADER_SIZE);
        vm.add(VReg.V0, VReg.S0, VReg.V0);
        vm.store(VReg.V0, 0, VReg.S1);

        // 更新长度
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.store(VReg.S0, 0, VReg.S2);

        // 返回 boxed 数组 JSValue
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_array");

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);
    },

    // 数组 pop
    generateArrayPop() {
        const vm = this.vm;

        vm.label("_array_pop");
        vm.prologue(16, [VReg.S0, VReg.S1]);

        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.S1, VReg.S0, 0);

        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_pop_empty");

        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.store(VReg.S0, 0, VReg.S1);

        vm.shl(VReg.V0, VReg.S1, 3);
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.add(VReg.V0, VReg.S0, VReg.V0);
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_array_pop_empty");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    },

    // 数组 get
    generateArrayGet() {
        const vm = this.vm;

        vm.label("_array_get");
        vm.prologue(16, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S1, VReg.A1);
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET);

        vm.shlImm(VReg.V0, VReg.S1, 3);
        vm.addImm(VReg.V0, VReg.V0, ARRAY_HEADER_SIZE);
        vm.add(VReg.V0, VReg.S0, VReg.V0);
        vm.load(VReg.RET, VReg.V0, 0);

        vm.epilogue([VReg.S0, VReg.S1], 16);
    },

    // 数组 set
    generateArraySet() {
        const vm = this.vm;

        vm.label("_array_set");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器,老容器记入记忆集;分代 GC 已是缺省)

        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);

        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET);

        vm.shl(VReg.V0, VReg.S1, 3);
        vm.addImm(VReg.V0, VReg.V0, ARRAY_HEADER_SIZE);
        vm.add(VReg.V0, VReg.S0, VReg.V0);
        vm.store(VReg.V0, 0, VReg.S2);

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    },

    // 数组长度
    generateArrayLength() {
        const vm = this.vm;

        vm.label("_array_length");
        vm.prologue(0, []);

        vm.call("_js_unbox");
        vm.load(VReg.RET, VReg.RET, 0);

        vm.epilogue([], 0);
    },

    // 数组 at (支持负索引)
    generateArrayAt() {
        const vm = this.vm;

        vm.label("_array_at");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);

        vm.load(VReg.V0, VReg.S0, 0);

        vm.cmpImm(VReg.S1, 0);
        vm.jge("_array_at_positive");
        vm.add(VReg.S1, VReg.V0, VReg.S1);

        vm.label("_array_at_positive");
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_array_at_undefined");
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_array_at_undefined");

        vm.shl(VReg.V1, VReg.S1, 3);
        vm.addImm(VReg.V1, VReg.V1, ARRAY_HEADER_SIZE);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.load(VReg.RET, VReg.V1, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        vm.label("_array_at_undefined");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    },

    // 创建指定大小的数组
    generateArrayNewWithSize() {
        const vm = this.vm;

        vm.label("_array_new_with_size");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0);

        // 计算实际容量: max(size, MIN_CAPACITY)
        vm.movImm(VReg.S3, ARRAY_MIN_CAPACITY);
        vm.cmp(VReg.S0, VReg.S3);
        vm.jge("_array_new_use_size");
        vm.jmp("_array_new_alloc");

        vm.label("_array_new_use_size");
        vm.mov(VReg.S3, VReg.S0);

        vm.label("_array_new_alloc");
        vm.shl(VReg.A0, VReg.S3, 3);
        vm.addImm(VReg.A0, VReg.A0, ARRAY_HEADER_SIZE);
        vm.call("_alloc");

        vm.mov(VReg.S1, VReg.RET);

        vm.store(VReg.S1, 0, VReg.S0);
        vm.store(VReg.S1, 8, VReg.S3);

        // 初始化所有元素为 JS_UNDEFINED
        vm.movImm(VReg.S2, 0);
        vm.movImm64(VReg.V2, JS_UNDEFINED);

        vm.label("_array_new_init_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_array_new_init_done");

        vm.shl(VReg.V0, VReg.S2, 3);
        vm.addImm(VReg.V0, VReg.V0, ARRAY_HEADER_SIZE);
        vm.add(VReg.V1, VReg.S1, VReg.V0);
        vm.store(VReg.V1, 0, VReg.V2);

        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_array_new_init_loop");

        vm.label("_array_new_init_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_box_array");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
    },
};

export { ARRAY_HEADER_SIZE, ARRAY_MIN_CAPACITY };
