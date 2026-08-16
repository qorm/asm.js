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
        // 直写 data[]:+0.0 → 装箱 int0(避 hole 哨兵)
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_set_values_store");
        vm.movImm64(VReg.V0, 0x7ff8000000000000n);
        vm.label("_set_values_store");
        vm.shlImm(VReg.V1, VReg.V4, 3);
        vm.add(VReg.V2, VReg.S2, VReg.V1);
        vm.store(VReg.V2, 0, VReg.V0); // data[i] = value
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.load(VReg.S3, VReg.S3, 8); // cur = node.next @8
        vm.jmp("_set_values_loop");
        vm.label("_set_values_done");
        // [test262 Set/prototype/values-iteration-mutable] 惰性迭代器(游标+初始 size
        // 上限):盒回 set → _set_iterator_new(set, 0=values)。
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm(VReg.A1, 0);
        vm.call("_set_iterator_new");
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
        vm.push(VReg.S0); // [SP] = 裸 set(循环里 S0 复用为索引,跨调用保活)
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
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_set_ent_v");
        vm.movImm64(VReg.V0, 0x7ff8000000000000n);
        vm.label("_set_ent_v");
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
        // [test262 Set/prototype/entries] 惰性迭代器 kind 1(entries → [v,v])。
        // 裸 set 在 [SP](循环里 S0 复用为索引,此处从栈取)。
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm(VReg.A1, 1);
        vm.call("_set_iterator_new");
        vm.pop(VReg.V0);
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

        // ---- _set_coerce_arg(A0=任意值) -> 裸 Set 或 SetRecord ----
        // 真 Set → 脱壳裸指针;Map → 键物化为 Set;其余走 GetSetRecord:
        // Get size/has/keys(规范序,不 Call keys)→ 堆块 SetRecord,供组合子按方法
        // 选用 has 或实时迭代 keys(布尔方法不得误触 keys 迭代器;防 SIGSEGV)。
        const TYPE_MAP = 4;
        // SetRecord 堆块:GetSetRecord 缓存,不物化 keys 迭代器。
        // magic 低字节 ≠ TYPE_SET(5),组合子用全字比较区分裸 Set。
        const SETREC_MAGIC = 0x5345545245430001n;
        const SETREC_SIZE = 40; // magic@0 obj@8 size@16 has@24 keys@32
        vm.asm.registerRuntimeString("_str_sz_size", "size");
        vm.asm.registerRuntimeString("_str_sz_has", "has");
        vm.asm.registerRuntimeString("_str_sz_keys", "keys");
        vm.label("_set_coerce_arg");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_sca_raw");
        // 0x7FFD 普通对象 / 0x7FFE 数组(仍为 ES Object,可作 set-like)
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_sca_boxed_obj");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_sca_bad");
        vm.label("_sca_boxed_obj");
        // 装箱对象/数组 → 脱壳验类型字节
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S4, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S4, VReg.V1);
        vm.jlt("_sca_bad");
        vm.loadByte(VReg.V1, VReg.S4, 0);
        vm.cmpImm(VReg.V1, TYPE_SET);
        vm.jeq("_sca_is_set");            // 装箱 Set → 脱壳直返
        vm.cmpImm(VReg.V1, TYPE_MAP);
        vm.jeq("_sca_from_map");          // 装箱 Map → 键物化
        // ---- GetSetRecord(obj) 守卫(size/has/keys)后再尝试物化 ----
        // size: Get → 拒 BigInt → ToNumber → 拒 NaN/负
        vm.lea(VReg.A1, "_str_sz_size");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_sca_bad");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_number_coerce");
        vm.mov(VReg.S2, VReg.RET);
        vm.fmovToFloat(0, VReg.S2);
        vm.fcmp(0, 0);
        vm.jnan("_sca_bad");
        vm.movImm(VReg.V1, 0); // +0.0
        vm.fmovToFloat(1, VReg.V1);
        vm.fcmp(0, 1);
        vm.jflt("_sca_range"); // size < 0 → RangeError(规范 GetSetRecord)
        vm.mov(VReg.S5, VReg.S2); // S5 = ToNumber(size) 浮点位(GetSetRecord 缓存)
        // has 必须可调用
        vm.lea(VReg.A1, "_str_sz_has");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_sca_has_ok");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_sca_bad");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_sca_bad");
        vm.label("_sca_has_ok");
        vm.mov(VReg.S4, VReg.S2); // S4 = has 函数(GetSetRecord 缓存,布尔方法只 Call has)
        // keys 必须可调用(GetSetRecord 只 Get,不 Call;布尔方法不得触发 keys 迭代器)
        vm.lea(VReg.A1, "_str_sz_keys");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_sca_keys_ok");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_sca_bad");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_sca_bad");
        // 归一化裸函数指针为装箱形式
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.S2, VReg.S2, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.S2, VReg.S2, VReg.V1);
        vm.label("_sca_keys_ok");
        // 规范 GetSetRecord:只 Get size/has/keys,不 Call keys。
        // 布尔方法(isSubsetOf/isDisjointFrom)与 difference(this.size≤arg.size)
        // 只用 has;提前物化会误触 keys 迭代器并打乱 mutation-during-iterate。
        vm.movImm(VReg.A0, SETREC_SIZE);
        vm.call("_alloc");
        vm.movImm64(VReg.V5, SETREC_MAGIC);
        vm.store(VReg.RET, 0, VReg.V5);
        vm.store(VReg.RET, 8, VReg.S0);  // [[SetObject]]
        vm.store(VReg.RET, 16, VReg.S5); // [[Size]] ToNumber 浮点位
        vm.store(VReg.RET, 24, VReg.S4); // [[Has]]
        vm.store(VReg.RET, 32, VReg.S2); // [[Keys]] 已缓存,组合子 Call 时不再 Get
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_sca_done");
        vm.label("_sca_is_set");
        vm.mov(VReg.S1, VReg.S4);          // 脱壳后的裸 Set 指针
        vm.jmp("_sca_done");
        // ---- 裸/装箱 Map → 按插入序键物化为新 Set(等价 Map.prototype.keys) ----
        vm.label("_sca_from_map");
        // S4 = 裸 Map 指针(调用方已脱壳或 raw 路径置入)
        vm.call("_set_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.S3, VReg.S4, 16);     // cur = map.head
        vm.label("_sca_map_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_sca_done");
        vm.load(VReg.A1, VReg.S3, 0);      // node.key @0
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_add");
        vm.load(VReg.S3, VReg.S3, 16);     // cur = node.next @16
        vm.jmp("_sca_map_loop");
        vm.label("_sca_raw");
        vm.movImm64(VReg.V1, SET_MASK);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_sca_bad");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_SET);
        vm.jeq("_sca_raw_set");
        vm.cmpImm(VReg.V1, TYPE_MAP);
        vm.jne("_sca_bad");
        vm.mov(VReg.S4, VReg.V0);          // 裸 Map
        vm.jmp("_sca_from_map");
        vm.label("_sca_raw_set");
        vm.mov(VReg.S1, VReg.V0);
        vm.label("_sca_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_sca_bad");
        vm.lea(VReg.A0, vm.asm.addString("Set method argument must be a Set or Set-like object"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48); // 理论不达
        vm.label("_sca_range");
        vm.lea(VReg.A0, vm.asm.addString("Set size must be non-negative"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // ============================================================
        // Set-like 组合子辅助:Call(has/keys)/克隆/按 keys 实时迭代(不预物化)。
        // x64:V5/V6 不别名 A0-A5;setCallArgcImm 用它们以免毁 A0 实参。
        // ============================================================
        const STRTAG = 0x7ffc000000000000n;
        const COMB_SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        const emitStrA1 = (s) => {
            vm.lea(VReg.A1, vm.asm.addString(s));
            vm.movImm64(VReg.V5, STRTAG);
            vm.or(VReg.A1, VReg.A1, VReg.V5);
        };
        const emitIsSetRec = (src, yes, no) => {
            vm.shrImm(VReg.V5, src, 48);
            vm.cmpImm(VReg.V5, 0);
            vm.jne(no);
            vm.cmpImm(src, 0);
            vm.jeq(no);
            vm.lea(VReg.V5, "_heap_base");
            vm.load(VReg.V5, VReg.V5, 0);
            vm.cmp(src, VReg.V5);
            vm.jlt(no);
            vm.lea(VReg.V5, "_heap_ptr");
            vm.load(VReg.V5, VReg.V5, 0);
            vm.cmp(src, VReg.V5);
            vm.jge(no);
            vm.load(VReg.V5, src, 0);
            vm.movImm64(VReg.V6, SETREC_MAGIC);
            vm.cmp(VReg.V5, VReg.V6);
            vm.jeq(yes);
            vm.jmp(no);
        };
        const emitRequireSet = (src, dst, bad) => {
            vm.movImm64(VReg.V5, SET_MASK);
            vm.and(dst, src, VReg.V5);
            vm.movImm64(VReg.V5, vm.ptrFloor);
            vm.cmp(dst, VReg.V5);
            vm.jlt(bad);
            vm.loadByte(VReg.V5, dst, 0);
            vm.cmpImm(VReg.V5, TYPE_SET);
            vm.jne(bad);
        };
        const emitKindDispatch = (pfx, likeL, fastL) => {
            emitIsSetRec(VReg.S1, likeL, pfx + "_notrec");
            vm.label(pfx + "_notrec");
            vm.movImm64(VReg.V5, SET_MASK);
            vm.and(VReg.V6, VReg.S1, VReg.V5);
            vm.movImm64(VReg.V5, vm.ptrFloor);
            vm.cmp(VReg.V6, VReg.V5);
            vm.jlt(pfx + "_coerce");
            vm.loadByte(VReg.V5, VReg.V6, 0);
            vm.cmpImm(VReg.V5, TYPE_SET);
            vm.jne(pfx + "_coerce");
            vm.mov(VReg.S1, VReg.V6);
            vm.jmp(fastL);
            vm.label(pfx + "_coerce");
            vm.mov(VReg.A0, VReg.S5);
            vm.call("_set_coerce_arg");
            vm.mov(VReg.S1, VReg.RET);
            emitIsSetRec(VReg.S1, likeL, pfx + "_co_set");
            vm.label(pfx + "_co_set");
            vm.movImm64(VReg.V5, SET_MASK);
            vm.and(VReg.S1, VReg.S1, VReg.V5);
            vm.loadByte(VReg.V5, VReg.S1, 0);
            vm.cmpImm(VReg.V5, TYPE_SET);
            vm.jeq(fastL);
            vm.jmp("_sca_bad");
        };
        const emitSizeLe = (setS, recS, leL, gtL) => {
            vm.load(VReg.V5, setS, 8);
            vm.scvtf(0, VReg.V5);
            vm.load(VReg.V5, recS, 16);
            vm.fmovToFloat(1, VReg.V5);
            vm.fcmp(0, 1);
            vm.jfle(leL);
            vm.jmp(gtL);
        };
        const emitWalkKeys = (pfx, recS, emitBody) => {
            vm.load(VReg.A0, recS, 32);
            vm.load(VReg.A1, recS, 8);
            vm.call("_spread_call0");
            vm.mov(VReg.S3, VReg.RET);
            vm.shrImm(VReg.V5, VReg.S3, 48);
            vm.cmpImm(VReg.V5, 0x7FFE);
            vm.jeq(pfx + "_arr");
            vm.cmpImm(VReg.V5, 0x7FFD);
            vm.jeq(pfx + "_it");
            vm.cmpImm(VReg.V5, 0);
            vm.jne(pfx + "_bad");
            vm.cmpImm(VReg.S3, 0);
            vm.jeq(pfx + "_bad");
            vm.label(pfx + "_it");
            vm.movImm(VReg.V5, 0);
            vm.store(VReg.SP, 0, VReg.V5);
            vm.mov(VReg.A0, VReg.S3);
            emitStrA1("next");
            vm.call("_object_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_maybe_getter");
            vm.mov(VReg.S4, VReg.RET);
            vm.jmp(pfx + "_step");
            vm.label(pfx + "_arr");
            vm.movImm(VReg.V5, 1);
            vm.store(VReg.SP, 0, VReg.V5);
            vm.movImm(VReg.S4, 0);
            vm.mov(VReg.A0, VReg.S3);
            vm.call("_array_length");
            vm.mov(VReg.S5, VReg.RET);
            vm.label(pfx + "_step");
            vm.load(VReg.V5, VReg.SP, 0);
            vm.cmpImm(VReg.V5, 0);
            vm.jne(pfx + "_arr_step");
            vm.mov(VReg.A0, VReg.S4);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_spread_call0");
            vm.mov(VReg.S5, VReg.RET);
            vm.mov(VReg.A0, VReg.S5);
            emitStrA1("done");
            vm.call("_object_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S5);
            vm.call("_maybe_getter");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_to_boolean");
            vm.cmpImm(VReg.RET, 0);
            vm.jne(pfx + "_done");
            vm.mov(VReg.A0, VReg.S5);
            emitStrA1("value");
            vm.call("_object_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S5);
            vm.call("_maybe_getter");
            vm.mov(VReg.A1, VReg.RET);
            vm.jmp(pfx + "_each");
            vm.label(pfx + "_arr_step");
            vm.cmp(VReg.S4, VReg.S5);
            vm.jge(pfx + "_done");
            vm.mov(VReg.A0, VReg.S3);
            vm.mov(VReg.A1, VReg.S4);
            vm.call("_array_get");
            vm.mov(VReg.A1, VReg.RET);
            vm.addImm(VReg.S4, VReg.S4, 1);
            vm.label(pfx + "_each");
            // A1 是 caller-saved;body 内 _set_has/_set_add 会毁掉它。SP+8 缓存当前 key。
            vm.store(VReg.SP, 8, VReg.A1);
            emitBody();
            vm.jmp(pfx + "_step");
            vm.label(pfx + "_bad");
            vm.lea(VReg.A0, vm.asm.addString("Set method keys() did not return an Object"));
            vm.movImm64(VReg.V5, STRTAG);
            vm.or(VReg.A0, VReg.A0, VReg.V5);
            vm.call("_throw_type_error");
            vm.label(pfx + "_done");
        };
        const emitCopyHead = (srcS, dstS, pfx) => {
            vm.load(VReg.S3, srcS, 16);
            vm.label(pfx);
            vm.cmpImm(VReg.S3, 0);
            vm.jeq(pfx + "_end");
            vm.load(VReg.A1, VReg.S3, 0);
            vm.mov(VReg.A0, dstS);
            vm.call("_set_add");
            vm.load(VReg.S3, VReg.S3, 8);
            vm.jmp(pfx);
            vm.label(pfx + "_end");
        };

        // _set_call1(A0=fn, A1=this, A2=arg) — Call(fn, this, «arg»)
        vm.label("_set_call1");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A0);
        vm.shrImm(VReg.V5, VReg.S3, 48);
        vm.cmpImm(VReg.V5, 0x7fff);
        vm.jne("_sc1_notag");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.S3, VReg.S3, VReg.V5);
        vm.label("_sc1_notag");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_sc1_undef");
        vm.load(VReg.V5, VReg.S3, 0);
        vm.movImm(VReg.V6, 0xc105);
        vm.cmp(VReg.V5, VReg.V6);
        vm.jne("_sc1_bare");
        vm.mov(VReg.S0, VReg.S3);
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_sc1_do");
        vm.label("_sc1_bare");
        vm.movImm(VReg.S0, 0);
        vm.label("_sc1_do");
        vm.setCallArgcImm(1, VReg.V5, VReg.V6);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A5, VReg.S1);
        vm.callIndirect(VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_sc1_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _set_clone(A0=set) -> 新裸 Set(插入序拷贝;供 union/difference 在迭代 keys 前快照)
        vm.label("_set_clone");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_set_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.S2, VReg.S0, 16);
        vm.label("_set_clone_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_clone_done");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_add");
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_set_clone_loop");
        vm.label("_set_clone_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);

        // _set_like_has(A0=setrec, A1=value) -> 1/0 (ToBoolean(Call(has, obj, «v»)))
        vm.label("_set_like_has");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.load(VReg.A0, VReg.S0, 24); // has
        vm.load(VReg.A1, VReg.S0, 8);  // this = [[SetObject]]
        vm.mov(VReg.A2, VReg.S1);      // arg
        vm.call("_set_call1");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        const emitCombPrologue = () => {
            vm.prologue(64, COMB_SAVED);
            vm.mov(VReg.S5, VReg.A1);
            emitRequireSet(VReg.A0, VReg.S0, "_set_comb_badthis");
            vm.mov(VReg.S1, VReg.A1);
        };
        const emitCombRetSet = (src) => {
            vm.mov(VReg.RET, src);
            vm.epilogue(COMB_SAVED, 64);
        };

        vm.label("_set_comb_badthis");
        vm.lea(VReg.A0, vm.asm.addString("Set method called on incompatible receiver"));
        vm.movImm64(VReg.V5, STRTAG);
        vm.or(VReg.A0, VReg.A0, VReg.V5);
        vm.call("_throw_type_error");

        vm.label("_set_bool_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue(COMB_SAVED, 64);
        vm.label("_set_bool_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue(COMB_SAVED, 64);

        // ---- _set_union(A0=a, A1=b) -> 新 Set(a ∪ b) ----
        vm.label("_set_union");
        emitCombPrologue();
        emitKindDispatch("_su", "_set_union_like", "_set_union_fast");
        vm.label("_set_union_fast");
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        emitCopyHead(VReg.S0, VReg.S2, "_set_union_a");
        emitCopyHead(VReg.S1, VReg.S2, "_set_union_b");
        emitCombRetSet(VReg.S2);
        vm.label("_set_union_like");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_set_clone");
        vm.mov(VReg.S2, VReg.RET);
        emitWalkKeys("_su_lk", VReg.S1, () => {
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_set_add");
        });
        emitCombRetSet(VReg.S2);

        // ---- _set_intersection(A0=a, A1=b) -> 新 Set(a ∩ b) ----
        vm.label("_set_intersection");
        emitCombPrologue();
        emitKindDispatch("_si", "_set_int_like", "_set_int_fast");
        vm.label("_set_int_fast");
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.S3, VReg.S0, 16);
        vm.label("_set_int_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_int_done");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_has");
        vm.lea(VReg.V5, "_js_true");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.RET, VReg.V5);
        vm.jne("_set_int_next");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_set_int_next");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_int_loop");
        vm.label("_set_int_done");
        emitCombRetSet(VReg.S2);
        vm.label("_set_int_like");
        emitSizeLe(VReg.S0, VReg.S1, "_si_lk_has", "_si_lk_keys");
        vm.label("_si_lk_has");
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.S3, VReg.S0, 16);
        vm.label("_si_lk_hloop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_si_h_done");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_like_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_si_lk_hnext");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_si_lk_hnext");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_si_lk_hloop");
        vm.label("_si_h_done");
        emitCombRetSet(VReg.S2);
        vm.label("_si_lk_keys");
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        emitWalkKeys("_si_k", VReg.S1, () => {
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_set_has");
            vm.lea(VReg.V5, "_js_true");
            vm.load(VReg.V5, VReg.V5, 0);
            vm.cmp(VReg.RET, VReg.V5);
            vm.jne("_si_k_skip");
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_set_add");
            vm.label("_si_k_skip");
        });
        emitCombRetSet(VReg.S2);

        // ---- _set_difference(A0=a, A1=b) -> 新 Set(a \ b) ----
        vm.label("_set_difference");
        emitCombPrologue();
        emitKindDispatch("_sd", "_set_diff_like", "_set_diff_fast");
        vm.label("_set_diff_fast");
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.S3, VReg.S0, 16);
        vm.label("_set_diff_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_diff_done");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_has");
        vm.lea(VReg.V5, "_js_true");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.RET, VReg.V5);
        vm.jeq("_set_diff_next");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_set_diff_next");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_diff_loop");
        vm.label("_set_diff_done");
        emitCombRetSet(VReg.S2);
        vm.label("_set_diff_like");
        emitSizeLe(VReg.S0, VReg.S1, "_sd_lk_has", "_sd_lk_keys");
        vm.label("_sd_lk_has");
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.S3, VReg.S0, 16);
        vm.label("_sd_lk_hloop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_sd_h_done");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_like_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_sd_lk_hnext");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_sd_lk_hnext");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_sd_lk_hloop");
        vm.label("_sd_h_done");
        emitCombRetSet(VReg.S2);
        vm.label("_sd_lk_keys");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_set_clone");
        vm.mov(VReg.S2, VReg.RET);
        emitWalkKeys("_sd_k", VReg.S1, () => {
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_set_delete");
        });
        emitCombRetSet(VReg.S2);

        // ---- _set_symdiff(A0=a, A1=b) -> 新 Set((a\b) ∪ (b\a)) ----
        vm.label("_set_symdiff");
        emitCombPrologue();
        emitKindDispatch("_ss", "_set_sym_like", "_set_sym_fast");
        vm.label("_set_sym_fast");
        vm.call("_set_new");
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.S3, VReg.S0, 16);
        vm.label("_set_sym_a");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_sym_bstart");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_has");
        vm.lea(VReg.V5, "_js_true");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.RET, VReg.V5);
        vm.jeq("_set_sym_a_next");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_set_sym_a_next");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_sym_a");
        vm.label("_set_sym_bstart");
        vm.load(VReg.S3, VReg.S1, 16);
        vm.label("_set_sym_b");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_set_sym_done");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_set_has");
        vm.lea(VReg.V5, "_js_true");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.RET, VReg.V5);
        vm.jeq("_set_sym_b_next");
        vm.load(VReg.A1, VReg.S3, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_set_add");
        vm.label("_set_sym_b_next");
        vm.load(VReg.S3, VReg.S3, 8);
        vm.jmp("_set_sym_b");
        vm.label("_set_sym_done");
        emitCombRetSet(VReg.S2);
        vm.label("_set_sym_like");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_set_clone");
        vm.mov(VReg.S2, VReg.RET);
        // 规范:SetDataHas(O.[[SetData]], next) 用 live this,不是 result。
        // live 有 → 从 result 删;live 无 → 写入 result(已在则 no-op)。
        emitWalkKeys("_ss_lk", VReg.S1, () => {
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_set_has");
            vm.lea(VReg.V5, "_js_true");
            vm.load(VReg.V5, VReg.V5, 0);
            vm.cmp(VReg.RET, VReg.V5);
            vm.jne("_ss_lk_add");
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_set_delete");
            vm.jmp("_ss_lk_skip");
            vm.label("_ss_lk_add");
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_set_add");
            vm.label("_ss_lk_skip");
        });
        emitCombRetSet(VReg.S2);

        // ---- _set_issubset(A0=a, A1=b) -> a ⊆ b ----
        vm.label("_set_issubset");
        emitCombPrologue();
        emitKindDispatch("_sb", "_set_issub_like", "_set_issub_fast");
        vm.label("_set_issub_fast");
        vm.load(VReg.S2, VReg.S0, 16);
        vm.label("_set_issub_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_bool_true");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_has");
        vm.lea(VReg.V5, "_js_true");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.RET, VReg.V5);
        vm.jne("_set_bool_false");
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_set_issub_loop");
        vm.label("_set_issub_like");
        // this.size > other.size → false; otherwise 只 Call has,永不 Call keys。
        emitSizeLe(VReg.S0, VReg.S1, "_sb_lk_walk", "_set_bool_false");
        vm.label("_sb_lk_walk");
        vm.load(VReg.S2, VReg.S0, 16);
        vm.label("_sb_lk_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_bool_true");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_like_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_set_bool_false");
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_sb_lk_loop");

        // ---- _set_issuperset(A0=a, A1=b) -> a ⊇ b ----
        vm.label("_set_issuperset");
        emitCombPrologue();
        emitKindDispatch("_sp", "_set_issup_like", "_set_issup_fast");
        vm.label("_set_issup_fast");
        vm.load(VReg.S2, VReg.S1, 16);
        vm.label("_set_issup_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_bool_true");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_set_has");
        vm.lea(VReg.V5, "_js_true");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.RET, VReg.V5);
        vm.jne("_set_bool_false");
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_set_issup_loop");
        vm.label("_set_issup_like");
        // if this.size < other.size return false. emitSizeLe: this<=other → need this<other.
        // Compare: scvtf this, fcmp this ? other. jflt → this < other → false.
        vm.load(VReg.V5, VReg.S0, 8);
        vm.scvtf(0, VReg.V5);
        vm.load(VReg.V5, VReg.S1, 16);
        vm.fmovToFloat(1, VReg.V5);
        vm.fcmp(0, 1);
        vm.jflt("_set_bool_false");
        emitWalkKeys("_sp_lk", VReg.S1, () => {
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_set_has");
            vm.lea(VReg.V5, "_js_true");
            vm.load(VReg.V5, VReg.V5, 0);
            vm.cmp(VReg.RET, VReg.V5);
            vm.jne("_sp_lk_miss");
        });
        vm.jmp("_set_bool_true");
        vm.label("_sp_lk_miss");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_iterator_close");
        vm.jmp("_set_bool_false");

        // ---- _set_isdisjoint(A0=a, A1=b) -> a ∩ b == ∅ ----
        vm.label("_set_isdisjoint");
        emitCombPrologue();
        emitKindDispatch("_dj", "_set_disj_like", "_set_disj_fast");
        vm.label("_set_disj_fast");
        vm.load(VReg.S2, VReg.S0, 16);
        vm.label("_set_disj_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_bool_true");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_has");
        vm.lea(VReg.V5, "_js_true");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.RET, VReg.V5);
        vm.jeq("_set_bool_false");
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_set_disj_loop");
        vm.label("_set_disj_like");
        emitSizeLe(VReg.S0, VReg.S1, "_dj_lk_has", "_dj_lk_keys");
        vm.label("_dj_lk_has");
        vm.load(VReg.S2, VReg.S0, 16);
        vm.label("_dj_lk_hloop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_bool_true");
        vm.load(VReg.A1, VReg.S2, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_set_like_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_set_bool_false");
        vm.load(VReg.S2, VReg.S2, 8);
        vm.jmp("_dj_lk_hloop");
        vm.label("_dj_lk_keys");
        emitWalkKeys("_dj_lk", VReg.S1, () => {
            vm.load(VReg.A1, VReg.SP, 8);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_set_has");
            vm.lea(VReg.V5, "_js_true");
            vm.load(VReg.V5, VReg.V5, 0);
            vm.cmp(VReg.RET, VReg.V5);
            vm.jeq("_dj_lk_hit");
        });
        vm.jmp("_set_bool_true");
        vm.label("_dj_lk_hit");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_iterator_close");
        vm.jmp("_set_bool_false");

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
        guarded("_aref_set_union", TYPE_SET, "_set_union", "Method Set.prototype.union called on incompatible receiver ");
        guarded("_aref_set_intersection", TYPE_SET, "_set_intersection", "Method Set.prototype.intersection called on incompatible receiver ");
        guarded("_aref_set_difference", TYPE_SET, "_set_difference", "Method Set.prototype.difference called on incompatible receiver ");
        guarded("_aref_set_symdiff", TYPE_SET, "_set_symdiff", "Method Set.prototype.symmetricDifference called on incompatible receiver ");
        guarded("_aref_set_issubset", TYPE_SET, "_set_issubset", "Method Set.prototype.isSubsetOf called on incompatible receiver ");
        guarded("_aref_set_issuperset", TYPE_SET, "_set_issuperset", "Method Set.prototype.isSupersetOf called on incompatible receiver ");
        guarded("_aref_set_isdisjoint", TYPE_SET, "_set_isdisjoint", "Method Set.prototype.isDisjointFrom called on incompatible receiver ");

        // ============================================================
        // [test262 Set/prototype/values-iteration-mutable] 惰性 Set 迭代器:
        // 游标节点 + 初始 size 上限(创建后新增仍可见;耗尽后恒 done)。节点
        // value@0/next@8。kind: 0=values(=keys), 1=entries([v,v])。
        // 闭包块 48B: +0 magic +8 _set_iter_next +16 set(裸) +24 node(裸)
        //             +32 remaining +40 kind。对象: next 闭包 + Symbol.iterator 自迭代。
        // ============================================================
        vm.label("_set_iterator_new");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S2, VReg.A0); // boxed set
        vm.mov(VReg.S3, VReg.A1); // kind
        vm.call("_object_new");
        vm.mov(VReg.S1, VReg.RET); // obj(裸)
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_set_iter_next");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S2, VReg.V1); // 裸 set
        vm.store(VReg.S0, 16, VReg.V2);
        vm.load(VReg.V1, VReg.V2, 16); // head
        vm.store(VReg.S0, 24, VReg.V1); // node = head
        vm.load(VReg.V1, VReg.V2, 8); // size
        vm.store(VReg.S0, 32, VReg.V1); // remaining = size
        vm.store(VReg.S0, 40, VReg.S3); // kind
        // obj["next"] = 闭包
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S0, VReg.V1);
        vm.call("_object_set");
        // Symbol.iterator 自迭代闭包
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_self");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S0, VReg.V1);
        vm.call("_object_set");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.mov(VReg.RET, VReg.S1);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        vm.label("_set_iter_next");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.S0); // 闭包
        // 活游标语义:node 指针随链表走(创建后新增可见;耗尽后 node=0 恒 done,
        // 再 add 也不复活——ES 迭代器完成即终态)。
        vm.load(VReg.S2, VReg.S0, 24); // node
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_set_iter_done");
        vm.load(VReg.V0, VReg.S2, 8); // next
        vm.store(VReg.S0, 24, VReg.V0);
        vm.load(VReg.S0, VReg.S2, 0); // value(复用 S0)
        vm.load(VReg.V1, VReg.S3, 40); // kind
        vm.cmpImm(VReg.V1, 1);
        vm.jeq("_set_iter_entries");
        // values: value = node.value
        vm.cmpImm(VReg.S0, 0);
        vm.jne("_set_iter_emit");
        vm.movImm64(VReg.S0, 0x7ff8000000000000n);
        vm.jmp("_set_iter_emit");
        vm.label("_set_iter_entries");
        // entries: [v, v]
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_array_set");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.mov(VReg.S0, VReg.S1);
        vm.or(VReg.S0, VReg.S0, VReg.V1);
        vm.label("_set_iter_emit");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.A1, 0x7ff9000000000000n);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_set_iter_done");
        vm.movImm64(VReg.A0, 0x7ffb000000000000n);
        vm.movImm64(VReg.A1, 0x7ff9000000000001n);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }
}
