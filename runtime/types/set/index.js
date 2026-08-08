// asm.js 运行时 - Set 支持
// 实现 JavaScript Set：插入序链表 + 哈希桶索引（均摊 O(1) add/has/delete）
//
// Set 对象内存布局（48 字节头）:
// +0:  type (8 bytes) = TYPE_SET (5)
// +8:  size (8 bytes) - 元素数量
// +16: head (8 bytes) - 插入序链表头指针
// +24: tail (8 bytes) - 插入序链表尾指针
// +32: bucket_count (8 bytes)
// +40: buckets_ptr (8 bytes)
//
// 链表节点（24 字节）—— value@0/next@8 与旧布局保持一致，
// 编译器 for-of 特判（statements.js 按 type==5 走 head@16 / value@0 / next@8）不受影响，
// 仅在尾部追加 hnext@16：
// +0:  value (8 bytes)
// +8:  next (8 bytes)  - 插入序链
// +16: hnext (8 bytes) - 同桶哈希链
//
// 复用 map/index.js 生成的 _hash_key。

import { VReg } from "../../../vm/index.js";

const TYPE_SET = 5;
// 56 字节头(48→56):新增 +48 = weakness 标志(0=Set, 1=WeakSet)。见 map/index.js 说明。
const SET_SIZE = 56;
const SET_NODE_SIZE = 24;
const INIT_BUCKETS = 8;

export class SetGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        const vm = this.vm;

        // ============================================================
        // _set_new - 创建空 Set
        // ============================================================
        vm.label("_set_new");
        vm.prologue(16, [VReg.S0]);

        vm.movImm(VReg.A0, SET_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);

        vm.movImm(VReg.V1, TYPE_SET);
        vm.store(VReg.S0, 0, VReg.V1);  // type
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, 8, VReg.V1);  // size = 0
        vm.store(VReg.S0, 16, VReg.V1); // head = null
        vm.store(VReg.S0, 24, VReg.V1); // tail = null
        vm.movImm(VReg.V1, INIT_BUCKETS);
        vm.store(VReg.S0, 32, VReg.V1); // bucket_count = 8
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, 48, VReg.V1); // weak = 0(默认非 Weak)

        vm.movImm(VReg.A0, INIT_BUCKETS * 8);
        vm.call("_alloc");
        vm.mov(VReg.V2, VReg.RET);
        vm.store(VReg.S0, 40, VReg.V2); // buckets_ptr
        vm.movImm(VReg.V3, 0);
        vm.movImm(VReg.V4, 0);
        vm.label("_set_new_zero");
        vm.cmpImm(VReg.V4, INIT_BUCKETS);
        vm.jge("_set_new_zero_done");
        vm.shlImm(VReg.V5, VReg.V4, 3);
        vm.add(VReg.V6, VReg.V2, VReg.V5);
        vm.store(VReg.V6, 0, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.jmp("_set_new_zero");
        vm.label("_set_new_zero_done");

        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 16);

        // ============================================================
        // _set_rehash(A0 = set) - 扩容
        // ============================================================
        vm.label("_set_rehash");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.load(VReg.V1, VReg.S0, 32);
        vm.shlImm(VReg.S1, VReg.V1, 1); // new bucket_count

        vm.shlImm(VReg.A0, VReg.S1, 3);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V3, 0);
        vm.movImm(VReg.V4, 0);
        vm.label("_set_rehash_zero");
        vm.cmp(VReg.V4, VReg.S1);
        vm.jge("_set_rehash_zero_done");
        vm.shlImm(VReg.V5, VReg.V4, 3);
        vm.add(VReg.V6, VReg.S2, VReg.V5);
        vm.store(VReg.V6, 0, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.jmp("_set_rehash_zero");
        vm.label("_set_rehash_zero_done");

        vm.store(VReg.S0, 32, VReg.S1);
        vm.store(VReg.S0, 40, VReg.S2);

        vm.load(VReg.S3, VReg.S0, 16); // cur = head
        vm.label("_set_rehash_walk");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_rehash_done");
        vm.load(VReg.A0, VReg.S3, 0); // node.value
        vm.call("_hash_key");
        vm.mov(VReg.V1, VReg.S1);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.shlImm(VReg.V0, VReg.V0, 3);
        vm.add(VReg.S4, VReg.S2, VReg.V0);
        vm.load(VReg.V1, VReg.S4, 0);
        vm.store(VReg.S3, 16, VReg.V1); // node.hnext = 旧桶链头
        vm.store(VReg.S4, 0, VReg.S3);
        vm.load(VReg.S3, VReg.S3, 8); // next（插入序）
        vm.jmp("_set_rehash_walk");
        vm.label("_set_rehash_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ============================================================
        // _set_add(A0 = set, A1 = value)
        // ============================================================
        vm.label("_set_add");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器,老容器记入记忆集;分代 GC 已是缺省)
        vm.mov(VReg.S0, VReg.A0); // set
        vm.mov(VReg.S1, VReg.A1); // value

        // [-0 键规范化] SameValueZero 视 -0≡+0:存 +0(裸 0),令 forEach/迭代/has 产 +0
        // (1/value = +Infinity)。-0 唯一位 0x8000000000000000,high16 大于所有 tag,不冲突。
        vm.movImm64(VReg.V1, 0x8000000000000000n);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jne("_set_add_nz_ok");
        vm.movImm(VReg.S1, 0);
        vm.label("_set_add_nz_ok");

        vm.mov(VReg.A0, VReg.S1);
        vm.call("_hash_key");
        vm.load(VReg.V1, VReg.S0, 32);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.V2, VReg.S0, 40);
        vm.shlImm(VReg.V0, VReg.V0, 3);
        vm.add(VReg.S3, VReg.V2, VReg.V0); // S3 = &bucket[h]
        vm.load(VReg.S4, VReg.S3, 0);

        vm.label("_set_add_walk");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_set_add_insert");
        vm.load(VReg.A0, VReg.S4, 0); // node.value
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_map_key_eq");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_set_add_found");
        vm.load(VReg.S4, VReg.S4, 16); // hnext
        vm.jmp("_set_add_walk");

        vm.label("_set_add_found");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_set_add_insert");
        vm.movImm(VReg.A0, SET_NODE_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S5, VReg.RET);
        vm.store(VReg.S5, 0, VReg.S1); // value
        // 挂到桶哈希链头
        vm.load(VReg.V1, VReg.S3, 0);
        vm.store(VReg.S5, 16, VReg.V1); // node.hnext = 旧桶链头
        vm.store(VReg.S3, 0, VReg.S5);
        // 追加到插入序链表尾
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S5, 8, VReg.V1); // node.next = null
        vm.load(VReg.V2, VReg.S0, 24); // tail
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_set_add_first");
        vm.store(VReg.V2, 8, VReg.S5); // tail.next = node
        vm.store(VReg.S0, 24, VReg.S5); // tail = node
        vm.jmp("_set_add_sizeinc");
        vm.label("_set_add_first");
        vm.store(VReg.S0, 16, VReg.S5); // head = node
        vm.store(VReg.S0, 24, VReg.S5); // tail = node
        vm.label("_set_add_sizeinc");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S0, 8, VReg.V1); // size++
        vm.load(VReg.V2, VReg.S0, 32);
        vm.movImm(VReg.V3, 3);
        vm.mul(VReg.V3, VReg.V2, VReg.V3);
        vm.shrImm(VReg.V3, VReg.V3, 2);
        vm.cmp(VReg.V1, VReg.V3);
        vm.jlt("_set_add_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_set_rehash");
        vm.label("_set_add_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ============================================================
        // _set_has(A0 = set, A1 = value) -> 1/0
        // ============================================================
        vm.label("_set_has");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_hash_key");
        vm.load(VReg.V1, VReg.S0, 32);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.V2, VReg.S0, 40);
        vm.shlImm(VReg.V0, VReg.V0, 3);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.S2, VReg.V0, 0);
        vm.label("_set_has_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_has_notfound");
        vm.load(VReg.A0, VReg.S2, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_map_key_eq");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_set_has_found");
        vm.load(VReg.S2, VReg.S2, 16); // hnext
        vm.jmp("_set_has_loop");
        vm.label("_set_has_found");
        vm.lea(VReg.RET, "_js_true"); // 返回 JS 布尔（供 `+` 拼接/if 使用），非裸 1
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_set_has_notfound");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);

        // ============================================================
        // _set_delete(A0 = set, A1 = value) -> 1/0
        // ============================================================
        vm.label("_set_delete");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_hash_key");
        vm.load(VReg.V1, VReg.S0, 32);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.V2, VReg.S0, 40);
        vm.shlImm(VReg.V0, VReg.V0, 3);
        vm.add(VReg.S2, VReg.V2, VReg.V0); // S2 = &bucket[h]
        vm.load(VReg.S3, VReg.S2, 0); // cur（哈希链）
        vm.movImm(VReg.S4, 0); // prev（哈希链）
        vm.label("_set_del_chain");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_del_notfound");
        vm.load(VReg.A0, VReg.S3, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_map_key_eq");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_set_del_found");
        vm.mov(VReg.S4, VReg.S3);
        vm.load(VReg.S3, VReg.S3, 16); // hnext
        vm.jmp("_set_del_chain");

        vm.label("_set_del_found");
        vm.load(VReg.V1, VReg.S3, 16); // node.hnext
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_set_del_chain_head");
        vm.store(VReg.S4, 16, VReg.V1); // prev.hnext = node.hnext
        vm.jmp("_set_del_ilist");
        vm.label("_set_del_chain_head");
        vm.store(VReg.S2, 0, VReg.V1);
        vm.label("_set_del_ilist");
        vm.load(VReg.S4, VReg.S0, 16); // cur = head
        vm.movImm(VReg.S5, 0); // prevList
        vm.label("_set_del_ilist_loop");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_set_del_dec");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jeq("_set_del_ilist_unlink");
        vm.mov(VReg.S5, VReg.S4);
        vm.load(VReg.S4, VReg.S4, 8); // next
        vm.jmp("_set_del_ilist_loop");
        vm.label("_set_del_ilist_unlink");
        vm.load(VReg.V1, VReg.S3, 8); // node.next
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_set_del_ilist_head");
        vm.store(VReg.S5, 8, VReg.V1); // prevList.next = node.next
        vm.jmp("_set_del_ilist_tail");
        vm.label("_set_del_ilist_head");
        vm.store(VReg.S0, 16, VReg.V1); // head = node.next
        vm.label("_set_del_ilist_tail");
        vm.load(VReg.V2, VReg.S0, 24);
        vm.cmp(VReg.V2, VReg.S3);
        vm.jne("_set_del_dec");
        vm.store(VReg.S0, 24, VReg.S5); // tail = prevList
        vm.label("_set_del_dec");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S0, 8, VReg.V1);
        // 返回规范 JS 布尔(同 _set_has,非裸 1/0)——Set.prototype.delete 返 boolean:
        // 是否删除了成员。此前返裸 1/0,typeof 为 number 且裸 0 被误解释为真值。
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_set_del_notfound");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // _set_size - 获取 Set 大小
        vm.label("_set_size");
        vm.load(VReg.RET, VReg.A0, 8);
        vm.ret();

        // ============================================================
        // _set_values(A0 = set) -> boxed 真数组[值...]（插入序）
        // Set.keys()/.values() 语义相同(都产出值)。节点 value@0/next@8。
        // 只读遍历插入序链表,写入新数组 data 区。填充循环内无调用。
        // ============================================================
        vm.label("_set_values");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // S0 = 裸 set 指针
        vm.load(VReg.A0, VReg.S0, 8); // size
        vm.call("_array_new_with_size"); // RET = 裸数组头(S0-S3 保活)
        vm.mov(VReg.S1, VReg.RET); // S1 = 数组头
        vm.load(VReg.S2, VReg.S1, 24); // S2 = data_ptr
        vm.load(VReg.S3, VReg.S0, 16); // S3 = cur = set.head
        vm.movImm(VReg.V4, 0); // i
        vm.label("_set_values_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_values_done");
        vm.load(VReg.V0, VReg.S3, 0); // node.value @0
        vm.shlImm(VReg.V1, VReg.V4, 3);
        vm.add(VReg.V2, VReg.S2, VReg.V1);
        vm.store(VReg.V2, 0, VReg.V0); // data[i] = value
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.load(VReg.S3, VReg.S3, 8); // cur = node.next @8
        vm.jmp("_set_values_loop");
        vm.label("_set_values_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n); // TAG_ARRAY
        vm.mov(VReg.RET, VReg.S1);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        // ============================================================
        // _set_entries(A0 = set) -> boxed 真数组[[v,v]...]
        // Set.entries() 每元素为 [value, value](与 JS 语义一致)。
        // 内层 _array_new_with_size 只存 S0-S3,循环状态放 S0-S3 跨调用保活。
        // ============================================================
        vm.label("_set_entries");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // S0 = 裸 set
        vm.load(VReg.A0, VReg.S0, 8); // size
        vm.call("_array_new_with_size"); // RET = 外层数组头
        vm.mov(VReg.S1, VReg.RET); // S1 = 外层头
        vm.load(VReg.S2, VReg.S1, 24); // S2 = 外层 data_ptr
        vm.load(VReg.S3, VReg.S0, 16); // S3 = cur = set.head
        vm.movImm(VReg.S0, 0); // S0 = i
        vm.label("_set_entries_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_entries_done");
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size"); // RET = 内层 2 元数组
        // 内层头/数据指针用 V5/V6(避开 x64 S5 栈槽经 RAX 中转冲值的坑,同 _map_entries)。
        vm.mov(VReg.V5, VReg.RET); // V5 = 内层头
        vm.load(VReg.V6, VReg.V5, 24); // V6 = 内层 data_ptr
        vm.load(VReg.V0, VReg.S3, 0); // node.value @0
        vm.store(VReg.V6, 0, VReg.V0); // inner[0] = value
        vm.store(VReg.V6, 8, VReg.V0); // inner[1] = value
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.V2, VReg.V5);
        vm.or(VReg.V2, VReg.V2, VReg.V1); // 装箱内层
        vm.shlImm(VReg.V3, VReg.S0, 3);
        vm.add(VReg.V4, VReg.S2, VReg.V3);
        vm.store(VReg.V4, 0, VReg.V2); // outer[i] = [v,v]
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.load(VReg.S3, VReg.S3, 8); // cur = node.next @8
        vm.jmp("_set_entries_loop");
        vm.label("_set_entries_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S1);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        // ============================================================
        // _set_clear(A0 = set) - 清空（重置 size/head/tail 并清零桶数组）
        // ============================================================
        vm.label("_set_clear");
        vm.load(VReg.V0, VReg.A0, 32); // bucket_count
        vm.load(VReg.V1, VReg.A0, 40); // buckets_ptr
        vm.movImm(VReg.V2, 0);
        vm.movImm(VReg.V3, 0);
        vm.label("_set_clear_loop");
        vm.cmp(VReg.V2, VReg.V0);
        vm.jge("_set_clear_done");
        vm.shlImm(VReg.V4, VReg.V2, 3);
        vm.add(VReg.V5, VReg.V1, VReg.V4);
        vm.store(VReg.V5, 0, VReg.V3);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_set_clear_loop");
        vm.label("_set_clear_done");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.A0, 8, VReg.V1); // size = 0
        vm.store(VReg.A0, 16, VReg.V1); // head = null
        vm.store(VReg.A0, 24, VReg.V1); // tail = null
        vm.mov(VReg.RET, VReg.A0);
        vm.ret();

        // ============================================================
        // ES2025 Set 组合方法（只读遍历源集,建新集或判定布尔）
        //
        // 寄存器约定回顾（跨调用保活契约）:
        //   _set_new  只保存 S0（S1..S5 不触碰→天然保活）
        //   _set_add  保存 S0..S5（全部保活）
        //   _set_has  只保存 S0..S2（S3..S5 不触碰→天然保活）
        // 因此:游标放 S3 可同时穿越 _set_add(存)与 _set_has(不碰)；
        //       a/b/新集放 S0/S1/S2 也穿越 _set_add;穿越 _set_has 时 S0..S2 被保存。
        // 入口 A0/A1 可能是 boxed（高 16 位 tag）或裸指针；统一用 0x0000ffff.. 掩码脱壳，
        // 对裸指针为幺等。结果新集沿用 _set_new 语义返回裸指针（与 `new Set()` 一致）。
        // 布尔结果返回 _js_true/_js_false 单例（供 if / `+` 拼接）。
        // ============================================================
        const SET_MASK = 0x0000ffffffffffffn;

        // ---- _set_coerce_arg(A0=任意值) -> 裸 Set 指针(非 Set → TypeError) ----
        // Set ES2025 组合方法(intersection/union/...)的第二个实参可能是装箱 Set-like
        // 对象而非裸 Set 指针;原 helper 直接解引用裸指针 → SIGSEGV。此 helper 做品牌
        // 守卫:已为裸 Set→ 直返;装箱 Set 对象(0x7FFD 且 TYPE_SET)→ 脱壳返;
        // Set-like 对象→ 先按迭代器协议造新 Set(逐 keys 值 add),再返;
        // 其余 → TypeError。_set_coerce_arg_do_add 复用于 _set_union 内参。
        vm.asm.registerRuntimeString("_str_sz_size", "size");
        vm.asm.registerRuntimeString("_str_sz_has", "has");
        vm.asm.registerRuntimeString("_str_sz_keys", "keys");
        vm.label("_set_coerce_arg");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_sca_raw");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_sca_bad");
        // 装箱对象 → 脱壳验类型字节
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S4, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S4, VReg.V1);
        vm.jlt("_sca_bad");
        vm.loadByte(VReg.V1, VReg.S4, 0);
        vm.cmpImm(VReg.V1, TYPE_SET);
        vm.jeq("_sca_is_set");            // 装箱 Set → 脱壳直返
        // 非 Set 装箱对象:取 keys 迭代并 add 到新 Set
        vm.call("_set_new");
        vm.mov(VReg.S1, VReg.RET);         // S1 = 新裸 Set
        vm.lea(VReg.A1, "_str_sz_keys");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);          // 候选对象
        vm.call("_object_get"); // RET = keys(函数/undefined)
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);        // 函数 TAG
        vm.jeq("_sca_call_keys");
        vm.cmpImm(VReg.V0, 0);             // 裸函数指针
        vm.jne("_sca_not_iter");           // keys 不可调用 → 放弃(返回空集)
        // 归一化裸函数指针为装箱形式
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S2, VReg.S2, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.S2, VReg.S2, VReg.V1);
        vm.label("_sca_call_keys");
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_sca_not_iter");
        // 用 _aref_invoke_cb 调 keys(0 参);传 A0=接收者 A3=keys,压空哨兵作 element
        vm.movImm64(VReg.A0, 0x7ffb000000000000n); // undefined 占位 element
        vm.movImm64(VReg.A1, 0x7ffb000000000000n); // undefined 占位 idx
        vm.mov(VReg.A2, VReg.S0);          // 数组占位 = 候选对象
        vm.mov(VReg.A3, VReg.S2);          // keys 函数
        vm.call("_aref_invoke_cb");        // RET = keys() 返回值(迭代器数组)
        vm.mov(VReg.S3, VReg.RET);         // S3 = 迭代器数组(装箱)
        vm.shrImm(VReg.V0, VReg.S3, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_sca_not_iter");           // 返回值非数组 → 放弃
        // 遍历迭代器数组,逐值 _set_add
        vm.movImm(VReg.S4, 0);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_length");
        vm.mov(VReg.S5, VReg.RET);
        vm.label("_sca_loop");
        vm.cmp(VReg.S4, VReg.S5);
        vm.jge("_sca_done");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_add");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_sca_loop");
        vm.label("_sca_not_iter");         // keys 不可用 → 返回空集
        vm.jmp("_sca_done");
        vm.label("_sca_is_set");
        vm.mov(VReg.S1, VReg.S4);          // 脱壳后的裸 Set 指针
        vm.jmp("_sca_done");
        vm.label("_sca_raw");
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_sca_bad");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_SET);
        vm.jne("_sca_bad");
        vm.mov(VReg.S1, VReg.V0);
        vm.label("_sca_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_sca_bad");
        vm.lea(VReg.A0, vm.asm.addString("Set method argument must be a Set or Set-like object"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32); // 理论不达

        // ---- _set_union(A0=a, A1=b) -> 新 Set(a ∪ b) ----
        vm.label("_set_union");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // S0 = a
        vm.and(VReg.S1, VReg.A1, VReg.V1); // S1 = b
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);         // S2 = 新集（裸）
        vm.load(VReg.S3, VReg.S0, 16);     // cur = a.head
        vm.label("_set_union_a");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_union_bstart");
        vm.load(VReg.A1, VReg.S3, 0);      // value
        vm.mov(VReg.A0, VReg.S2);          // 新集
        vm.call("_set_add");
        vm.load(VReg.S3, VReg.S3, 8);      // cur = node.next
        vm.jmp("_set_union_a");
        vm.label("_set_union_bstart");
        vm.load(VReg.S3, VReg.S1, 16);     // cur = b.head
        vm.label("_set_union_b");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_union_done");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_union_b");
        vm.label("_set_union_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ---- _set_intersection(A0=a, A1=b) -> 新 Set(a ∩ b) ----
        vm.label("_set_intersection");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.and(VReg.S1, VReg.A1, VReg.V1);
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.S3, VReg.S0, 16);     // cur = a.head
        vm.label("_set_int_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_int_done");
        vm.load(VReg.A1, VReg.S3, 0);      // value
        vm.mov(VReg.A0, VReg.S1);          // b
        vm.call("_set_has");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_set_int_next");           // b 不含 → 跳过
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_set_int_next");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_int_loop");
        vm.label("_set_int_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ---- _set_difference(A0=a, A1=b) -> 新 Set(a \ b) ----
        vm.label("_set_difference");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.and(VReg.S1, VReg.A1, VReg.V1);
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.S3, VReg.S0, 16);     // cur = a.head
        vm.label("_set_diff_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_diff_done");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S1);          // b
        vm.call("_set_has");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_set_diff_next");          // b 含 → 跳过
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_set_diff_next");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_diff_loop");
        vm.label("_set_diff_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ---- _set_symdiff(A0=a, A1=b) -> 新 Set((a\b) ∪ (b\a)) ----
        vm.label("_set_symdiff");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.and(VReg.S1, VReg.A1, VReg.V1);
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        // 相 A：a 中不在 b 的
        vm.load(VReg.S3, VReg.S0, 16);
        vm.label("_set_sym_a");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_sym_bstart");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S1);          // b
        vm.call("_set_has");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_set_sym_a_next");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_set_sym_a_next");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_sym_a");
        // 相 B：b 中不在 a 的
        vm.label("_set_sym_bstart");
        vm.load(VReg.S3, VReg.S1, 16);
        vm.label("_set_sym_b");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_sym_done");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S0);          // a
        vm.call("_set_has");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_set_sym_b_next");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_set_sym_b_next");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_sym_b");
        vm.label("_set_sym_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ---- _set_issubset(A0=a, A1=b) -> a ⊆ b ? _js_true : _js_false ----
        // 游标 S2:_set_has 保存 S0..S2 → 保活。
        vm.label("_set_issubset");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // a
        vm.and(VReg.S1, VReg.A1, VReg.V1); // b
        vm.load(VReg.S2, VReg.S0, 16);     // cur = a.head
        vm.label("_set_issub_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_issub_true");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S1);          // b
        vm.call("_set_has");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_set_issub_false");        // b 不含某元素 → 非子集
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_set_issub_loop");
        vm.label("_set_issub_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_set_issub_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);

        // ---- _set_issuperset(A0=a, A1=b) -> a ⊇ b（即 b ⊆ a）----
        vm.label("_set_issuperset");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // a
        vm.and(VReg.S1, VReg.A1, VReg.V1); // b
        vm.load(VReg.S2, VReg.S1, 16);     // cur = b.head
        vm.label("_set_issup_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_issup_true");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S0);          // a
        vm.call("_set_has");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_set_issup_false");
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_set_issup_loop");
        vm.label("_set_issup_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_set_issup_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);

        // ---- _set_isdisjoint(A0=a, A1=b) -> a ∩ b == ∅ ？----
        vm.label("_set_isdisjoint");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // a
        vm.and(VReg.S1, VReg.A1, VReg.V1); // b
        vm.load(VReg.S2, VReg.S0, 16);     // cur = a.head
        vm.label("_set_disj_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_disj_true");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S1);          // b
        vm.call("_set_has");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_set_disj_false");         // 有公共元素 → 非不相交
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_set_disj_loop");
        vm.label("_set_disj_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_set_disj_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);

        // ============================================================
        // [I2 一等值] Set.prototype 方法值闭包用的 _aref_generic 安全 wrapper 族。
        // 蹦床把 this 插 A0、实参上移一位后尾调 helper(契约同 map/index.js 同名族注)。
        // size getter 复用 map 文件的 _aref_coll_size(Map/Set 头同布局,标签全局解析)。
        // ============================================================

        // _aref_set_clear(A0 = set) -> undefined(规范返 undefined;_set_clear 返 set)。
        // [I2 红队] 头部内联品牌守卫(形态与 map/index.js guardHead 一致)。
        vm.label("_aref_set_clear");
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_asc_chk");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_asc_bad");
        vm.label("_asc_chk");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5);
        vm.movImm64(VReg.V5, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V5);
        vm.jlt("_asc_bad");
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, TYPE_SET);
        vm.jne("_asc_bad");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5);
        vm.load(VReg.V0, VReg.V0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_asc_bad");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_set_clear");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.epilogue([VReg.S0], 16);
        vm.label("_asc_bad");
        vm.lea(VReg.A1, vm.asm.addString("Method Set.prototype.clear called on incompatible receiver "));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.jmp("_aref_throw_incompat");

        // _aref_set_forEach(A0 = set, A1 = callback, A2 = thisArg[忽略,记偏差]) ->
        // undefined。节点布局 value@0/next@8;cb(value, value, set)(Set 语义同值两传,
        // 与 compileSetForEach 一致)。循环态/GC 契约镜像 _aref_map_forEach。
        // [I2 红队] 头部内联品牌守卫。
        vm.label("_aref_set_forEach");
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_asfe_chk");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_asfe_bad");
        vm.label("_asfe_chk");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5);
        vm.movImm64(VReg.V5, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V5);
        vm.jlt("_asfe_bad");
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, TYPE_SET);
        vm.jne("_asfe_bad");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5);
        vm.load(VReg.V0, VReg.V0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_asfe_bad");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // S0 = 裸 set
        vm.mov(VReg.S1, VReg.A1);                 // S1 = callback
        vm.load(VReg.S2, VReg.S0, 16);            // S2 = cur = head
        vm.label("_asfe_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_asfe_done");
        vm.load(VReg.A0, VReg.S2, 0);   // arg0 = value
        vm.load(VReg.A1, VReg.S2, 0);   // arg1 = value(第二传)
        vm.mov(VReg.A2, VReg.S0);       // arg2 = set
        vm.mov(VReg.A3, VReg.S1);       // callback
        vm.call("_aref_invoke_cb");
        vm.load(VReg.S2, VReg.S2, 8);   // cur = node.next@8
        vm.jmp("_asfe_loop");
        vm.label("_asfe_done");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_asfe_bad");
        vm.lea(VReg.A1, vm.asm.addString("Method Set.prototype.forEach called on incompatible receiver "));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.jmp("_aref_throw_incompat");

        // _set_ctor_call - `Set()` 不带 new(经值路径调用)→ TypeError
        // (规范 24.2.1.1:Constructor Set requires 'new')。
        vm.label("_set_ctor_call");
        vm.prologue(16, [VReg.S0]);
        vm.lea(VReg.A0, vm.asm.addString("Constructor Set requires 'new'"));
        vm.call("_js_box_string");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error");   // 不返回
        vm.epilogue([VReg.S0], 16);     // 理论不达

        // ============================================================
        // [I2 红队] 接收者品牌守卫薄壳(契约/寄存器纪律/消息形状见 map/index.js
        // 同名守卫组注;_aref_throw_incompat 定义于 map 文件,标签全局解析)。
        // keys 无独立壳:成员表经别名机制让 keys 与 values 共享同一方法值闭包
        // (规范同一性 Set.prototype.keys === Set.prototype.values)。
        // ============================================================
        // [I2 红队 F3] 原型单例槽运行时无条件登记(同 map 文件 _nsobj_map_proto 注)。
        vm.asm.addDataLabel("_nsobj_set_proto");
        vm.asm.addDataQword(0);
        const STRTAG_I2 = 0x7ffc000000000000n;
        const guardHead = (tag, typeByte) => {
            vm.shrImm(VReg.V0, VReg.A0, 48);
            vm.cmpImm(VReg.V0, 0);
            vm.jeq(tag + "_chk");
            vm.cmpImm(VReg.V0, 0x7FFD);
            vm.jne(tag + "_bad");
            vm.label(tag + "_chk");
            vm.emitMaskLoad(VReg.V5);
            vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5); // V0 = 裸指针
            vm.movImm64(VReg.V5, vm.ptrFloor);
            vm.cmp(VReg.V0, VReg.V5);
            vm.jlt(tag + "_bad");
            vm.loadByte(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, typeByte);
            vm.jne(tag + "_bad");
            vm.emitMaskLoad(VReg.V5);
            vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5);
            vm.load(VReg.V0, VReg.V0, 48);            // weakness 标志
            vm.cmpImm(VReg.V0, 0);
            vm.jne(tag + "_bad");
        };
        const guardBad = (tag, prefix) => {
            vm.label(tag + "_bad");
            vm.lea(VReg.A1, vm.asm.addString(prefix));
            vm.movImm64(VReg.V1, STRTAG_I2);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.jmp("_aref_throw_incompat");
        };
        const guarded = (label, typeByte, helper, prefix) => {
            vm.label(label);
            guardHead(label, typeByte);
            vm.jmp(helper);
            guardBad(label, prefix);
        };
        guarded("_aref_set_add", TYPE_SET, "_set_add", "Method Set.prototype.add called on incompatible receiver ");
        guarded("_aref_set_has", TYPE_SET, "_set_has", "Method Set.prototype.has called on incompatible receiver ");
        guarded("_aref_set_delete", TYPE_SET, "_set_delete", "Method Set.prototype.delete called on incompatible receiver ");
        // keys 的错误消息也用 "values"(Node:keys 即 values 同一函数,取其 name)
        guarded("_aref_set_values", TYPE_SET, "_set_values", "Method Set.prototype.values called on incompatible receiver ");
        guarded("_aref_set_entries", TYPE_SET, "_set_entries", "Method Set.prototype.entries called on incompatible receiver ");
        guarded("_aref_set_size", TYPE_SET, "_aref_coll_size", "Method get Set.prototype.size called on incompatible receiver ");
    }
}
