// asm.js 运行时 - Map 支持
// 实现 JavaScript Map 对象：插入序链表 + 哈希桶索引（均摊 O(1) get/has/set/delete）
//
// Map 对象内存布局（48 字节头，头指针稳定，扩容只换 buckets_ptr/bucket_count）:
// +0:  type (8 bytes) = TYPE_MAP (4)
// +8:  size (8 bytes) - 元素数量
// +16: head (8 bytes) - 插入序链表头指针
// +24: tail (8 bytes) - 插入序链表尾指针（O(1) 追加）
// +32: bucket_count (8 bytes) - 桶数量（2 的幂）
// +40: buckets_ptr (8 bytes) - 桶数组指针（每桶 8 字节 = 该桶哈希链头）
//
// 链表节点（32 字节）:
// +0:  key (8 bytes)
// +8:  value (8 bytes)
// +16: next (8 bytes)  - 插入序链
// +24: hnext (8 bytes) - 同桶哈希链
//
// _hash_key 也在此文件生成（Set 复用）。

import { VReg } from "../../../vm/index.js";

const TYPE_MAP = 4;
// 56 字节头(48→56):新增 +48 = weakness 标志(0=Map, 1=WeakMap)。WeakMap/WeakSet 与
// Map/Set 共享 type 字节(4/5),仅此标志区分,供 _object_proto_toString / print 打品牌。
// GC 精确扫描走链表(head@16),不读 +48;打印/类型比较读 type@0——故加此槽零回归。
const MAP_SIZE = 56;
const MAP_NODE_SIZE = 32;
const INIT_BUCKETS = 8;

export class MapGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        const vm = this.vm;

        // ============================================================
        // _map_key_eq(A0, A1) -> RET (JS_TRUE/JS_FALSE):Map/Set 键相等 = SameValueZero。
        // 与 _strict_eq(===) 唯一差异:NaN 键相等(node 用 SameValueZero,NaN 与 NaN 同键)。
        // isNaN(x) 判据:_strict_eq(x,x)==false(唯 NaN 自反不等;装箱 int0 等自反相等,
        // 不误判)。保存/恢复 S0/S1(容器循环活跃寄存器),与 _strict_eq 同契约 → 直接替换其
        // 键比较调用点。(NaN 落桶:canonical NaN 位一致 → _hash_key 同哈希,同桶可寻。)
        // ============================================================
        vm.label("_map_key_eq");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // key1
        vm.mov(VReg.S1, VReg.A1); // key2
        vm.call("_strict_eq");    // 入口 A0/A1 未改
        vm.movImm64(VReg.V1, 0x7ff9000000000001n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_mke_true");
        // 非 === → 仅两者皆 NaN 才 SameValueZero 相等
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S0); vm.call("_strict_eq");
        vm.movImm64(VReg.V1, 0x7ff9000000000001n); vm.cmp(VReg.RET, VReg.V1); vm.jeq("_mke_false"); // key1 非 NaN
        vm.mov(VReg.A0, VReg.S1); vm.mov(VReg.A1, VReg.S1); vm.call("_strict_eq");
        vm.movImm64(VReg.V1, 0x7ff9000000000001n); vm.cmp(VReg.RET, VReg.V1); vm.jeq("_mke_false"); // key2 非 NaN
        vm.label("_mke_true");
        vm.movImm64(VReg.RET, 0x7ff9000000000001n);
        vm.jmp("_mke_done");
        vm.label("_mke_false");
        vm.movImm64(VReg.RET, 0x7ff9000000000000n);
        vm.label("_mke_done");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // ============================================================
        // _hash_key(A0 = jsvalue) -> RET = u64 哈希
        // 必须与 === (_strict_eq) 相容：=== 相等的键必须同哈希。
        //   - 数字 (high16 < 0x7FF8，float64 位)：按 64 位原始值混合。
        //   - 字符串 (high16 == 0x7FFC)：脱壳按内容 FNV-1a（"ab"==="ab" 同哈希）。
        //   - 对象/数组/函数等 tagged (其它高位) / 裸指针：按低 48 位 payload 混合
        //     （=== 对这些按 (tag,payload) 比较，payload 相同→同哈希；不同 tag 同 payload
        //      只是碰撞，桶内仍用 _strict_eq 区分）。
        // ============================================================
        vm.label("_hash_key");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        vm.shrImm(VReg.V0, VReg.S0, 48); // high16
        vm.movImm(VReg.V1, 0x7FFC);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_hash_key_string");

        vm.movImm(VReg.V1, 0x7FF8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_hash_key_mix"); // 数字：直接混合 S0 原始位

        // tagged 非字符串：取低 48 位 payload
        vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
        vm.and(VReg.S0, VReg.S0, VReg.V1);

        vm.label("_hash_key_mix");
        // fmix64（murmur3 finalizer）：把 S0 打散到 RET
        vm.mov(VReg.V0, VReg.S0);
        vm.shrImm(VReg.V1, VReg.V0, 33);
        vm.xor(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm64(VReg.V2, 0xff51afd7ed558ccdn);
        vm.mul(VReg.V0, VReg.V0, VReg.V2);
        vm.shrImm(VReg.V1, VReg.V0, 33);
        vm.xor(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm64(VReg.V2, 0xc4ceb9fe1a85ec53n);
        vm.mul(VReg.V0, VReg.V0, VReg.V2);
        vm.shrImm(VReg.V1, VReg.V0, 33);
        vm.xor(VReg.V0, VReg.V0, VReg.V1);
        vm.mov(VReg.RET, VReg.V0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_hash_key_string");
        // 脱壳取内容指针（null 结尾 C 串，与 _strcmp/_strict_eq 语义一致）
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);            // S0 = content ptr（迭代游标）
        vm.movImm64(VReg.S1, 0xcbf29ce484222325n); // FNV-1a offset basis（S1 = 累加器）
        vm.label("_hash_key_str_loop");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_hash_key_str_done");
        vm.xor(VReg.S1, VReg.S1, VReg.V0);
        vm.movImm64(VReg.V2, 0x100000001b3n);  // FNV prime
        vm.mul(VReg.S1, VReg.S1, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_hash_key_str_loop");
        vm.label("_hash_key_str_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // ============================================================
        // _map_new - 创建空 Map
        // ============================================================
        vm.label("_map_new");
        vm.prologue(16, [VReg.S0]);

        vm.movImm(VReg.A0, MAP_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET); // 立刻保存 map 指针（RET=V0 会被后续覆盖）

        vm.movImm(VReg.V1, TYPE_MAP);
        vm.store(VReg.S0, 0, VReg.V1);  // type
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, 8, VReg.V1);  // size = 0
        vm.store(VReg.S0, 16, VReg.V1); // head = null
        vm.store(VReg.S0, 24, VReg.V1); // tail = null
        vm.movImm(VReg.V1, INIT_BUCKETS);
        vm.store(VReg.S0, 32, VReg.V1); // bucket_count = 8
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, 48, VReg.V1); // weak = 0(默认非 Weak)

        // 分配桶数组：bucket_count * 8 字节
        vm.movImm(VReg.A0, INIT_BUCKETS * 8);
        vm.call("_alloc");
        vm.mov(VReg.V2, VReg.RET);       // 桶数组指针
        vm.store(VReg.S0, 40, VReg.V2);  // buckets_ptr
        // 清零桶数组（_alloc 复用的空闲块可能是脏的）
        vm.movImm(VReg.V3, 0);
        vm.movImm(VReg.V4, 0);
        vm.label("_map_new_zero");
        vm.cmpImm(VReg.V4, INIT_BUCKETS);
        vm.jge("_map_new_zero_done");
        vm.shlImm(VReg.V5, VReg.V4, 3);
        vm.add(VReg.V6, VReg.V2, VReg.V5);
        vm.store(VReg.V6, 0, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.jmp("_map_new_zero");
        vm.label("_map_new_zero_done");

        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 16);

        // ============================================================
        // _collection_mark_weak(A0 = Map/Set) - 置 weakness 标志(+48=1),返回 A0。
        // WeakMap/WeakSet 构造后调用,使 toString/print 区分弱集合(共享 type 字节)。
        // Set 头亦为 56 字节且 +48 同义,故本 helper 通用于两者。
        // ============================================================
        vm.label("_collection_mark_weak");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.A0, 48, VReg.V1);
        vm.mov(VReg.RET, VReg.A0);
        vm.ret();

        // ============================================================
        // _map_rehash(A0 = map) - 扩容：bucket_count 翻倍并重挂所有节点
        // 头对象地址不变，只换 buckets_ptr/bucket_count。
        // ============================================================
        vm.label("_map_rehash");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // map
        vm.load(VReg.V1, VReg.S0, 32); // old bucket_count
        vm.shlImm(VReg.S1, VReg.V1, 1); // new bucket_count = old * 2

        vm.shlImm(VReg.A0, VReg.S1, 3); // new_bc * 8 字节
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET); // 新桶数组指针
        // 清零新桶
        vm.movImm(VReg.V3, 0);
        vm.movImm(VReg.V4, 0);
        vm.label("_map_rehash_zero");
        vm.cmp(VReg.V4, VReg.S1);
        vm.jge("_map_rehash_zero_done");
        vm.shlImm(VReg.V5, VReg.V4, 3);
        vm.add(VReg.V6, VReg.S2, VReg.V5);
        vm.store(VReg.V6, 0, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.jmp("_map_rehash_zero");
        vm.label("_map_rehash_zero_done");

        vm.store(VReg.S0, 32, VReg.S1); // bucket_count = new
        vm.store(VReg.S0, 40, VReg.S2); // buckets_ptr = new

        // 遍历插入序链表（head→next，next@16 不受影响），重挂到新桶
        vm.load(VReg.S3, VReg.S0, 16); // cur = head
        vm.label("_map_rehash_walk");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_map_rehash_done");
        vm.load(VReg.A0, VReg.S3, 0); // node.key
        vm.call("_hash_key");
        vm.mov(VReg.V1, VReg.S1);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.and(VReg.V0, VReg.RET, VReg.V1); // h = hash & (new_bc-1)
        vm.shlImm(VReg.V0, VReg.V0, 3);
        vm.add(VReg.S4, VReg.S2, VReg.V0); // &newbucket[h]
        vm.load(VReg.V1, VReg.S4, 0); // 旧桶链头
        vm.store(VReg.S3, 24, VReg.V1); // node.hnext = 旧桶链头
        vm.store(VReg.S4, 0, VReg.S3); // 桶 = node
        vm.load(VReg.S3, VReg.S3, 16); // cur = node.next（插入序）
        vm.jmp("_map_rehash_walk");
        vm.label("_map_rehash_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ============================================================
        // _map_set(A0 = map, A1 = key, A2 = value)
        // ============================================================
        vm.label("_map_set");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器,老容器记入记忆集;分代 GC 已是缺省)
        vm.mov(VReg.S0, VReg.A0); // map
        vm.mov(VReg.S1, VReg.A1); // key
        vm.mov(VReg.S2, VReg.A2); // value

        // [-0 键规范化] SameValueZero 视 -0≡+0:存 +0(裸 0),令 forEach/迭代/get 产 +0
        // (1/key = +Infinity 而非 -Infinity)。-0 的 float64 位唯一为 0x8000000000000000,
        // high16=0x8000 大于所有 NaN-box tag(≤0x7FFF),不与任何 tagged 值/其它数冲突。
        vm.movImm64(VReg.V1, 0x8000000000000000n);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jne("_map_set_nz_ok");
        vm.movImm(VReg.S1, 0);
        vm.label("_map_set_nz_ok");

        // 计算桶地址
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_hash_key");
        vm.load(VReg.V1, VReg.S0, 32); // bucket_count
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.and(VReg.V0, VReg.RET, VReg.V1); // h
        vm.load(VReg.V2, VReg.S0, 40); // buckets_ptr
        vm.shlImm(VReg.V0, VReg.V0, 3);
        vm.add(VReg.S3, VReg.V2, VReg.V0); // S3 = &bucket[h]
        vm.load(VReg.S4, VReg.S3, 0); // 当前节点

        vm.label("_map_set_walk");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_map_set_insert");
        vm.load(VReg.A0, VReg.S4, 0); // node.key
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_map_key_eq");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_map_set_update");
        vm.load(VReg.S4, VReg.S4, 24); // hnext
        vm.jmp("_map_set_walk");

        vm.label("_map_set_update");
        vm.store(VReg.S4, 8, VReg.S2); // node.value = value
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_map_set_insert");
        vm.movImm(VReg.A0, MAP_NODE_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S5, VReg.RET); // node（保护 RET）
        vm.store(VReg.S5, 0, VReg.S1); // key
        vm.store(VReg.S5, 8, VReg.S2); // value
        // 挂到桶哈希链头
        vm.load(VReg.V1, VReg.S3, 0); // 旧桶链头
        vm.store(VReg.S5, 24, VReg.V1); // node.hnext = 旧桶链头
        vm.store(VReg.S3, 0, VReg.S5); // 桶 = node
        // 追加到插入序链表尾
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S5, 16, VReg.V1); // node.next = null
        vm.load(VReg.V2, VReg.S0, 24); // tail
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_map_set_first");
        vm.store(VReg.V2, 16, VReg.S5); // tail.next = node
        vm.store(VReg.S0, 24, VReg.S5); // tail = node
        vm.jmp("_map_set_sizeinc");
        vm.label("_map_set_first");
        vm.store(VReg.S0, 16, VReg.S5); // head = node
        vm.store(VReg.S0, 24, VReg.S5); // tail = node
        vm.label("_map_set_sizeinc");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S0, 8, VReg.V1); // size++
        // 超载因子检查：size >= bucket_count * 3 / 4 则扩容
        vm.load(VReg.V2, VReg.S0, 32);
        vm.movImm(VReg.V3, 3);
        vm.mul(VReg.V3, VReg.V2, VReg.V3);
        vm.shrImm(VReg.V3, VReg.V3, 2); // threshold = bc*3/4
        vm.cmp(VReg.V1, VReg.V3);
        vm.jlt("_map_set_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_map_rehash");
        vm.label("_map_set_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ============================================================
        // _map_get(A0 = map, A1 = key) -> value 或 undefined(0)
        // ============================================================
        vm.label("_map_get");
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
        vm.load(VReg.S2, VReg.V0, 0); // 当前节点
        vm.label("_map_get_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_map_get_notfound");
        vm.load(VReg.A0, VReg.S2, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_map_key_eq");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_map_get_found");
        vm.load(VReg.S2, VReg.S2, 24); // hnext
        vm.jmp("_map_get_loop");
        vm.label("_map_get_found");
        vm.load(VReg.RET, VReg.S2, 8);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_map_get_notfound");
        // 未命中返回 JS_UNDEFINED(非裸 0)。裸 0 与 float 0.0/装箱 int 0 无法区分,
        // 令 `map.get(缺键)` 打印 0、`=== undefined` 为 false、typeof "number"(应 undefined)。
        // groupBy 内部调用只判命中(high16==0x7ffe),不受 miss 位型改动影响。
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);

        // ============================================================
        // _map_has(A0 = map, A1 = key) -> 1/0
        // ============================================================
        vm.label("_map_has");
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
        vm.label("_map_has_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_map_has_notfound");
        vm.load(VReg.A0, VReg.S2, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_map_key_eq");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_map_has_found");
        vm.load(VReg.S2, VReg.S2, 24);
        vm.jmp("_map_has_loop");
        vm.label("_map_has_found");
        vm.lea(VReg.RET, "_js_true"); // 返回 JS 布尔（供 `+` 拼接/if 使用），非裸 1
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_map_has_notfound");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);

        // ============================================================
        // _map_delete(A0 = map, A1 = key) -> 1(成功)/0(不存在)
        // 从哈希链和插入序链表两处摘除。
        // ============================================================
        vm.label("_map_delete");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // map
        vm.mov(VReg.S1, VReg.A1); // key
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_hash_key");
        vm.load(VReg.V1, VReg.S0, 32);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.V2, VReg.S0, 40);
        vm.shlImm(VReg.V0, VReg.V0, 3);
        vm.add(VReg.S2, VReg.V2, VReg.V0); // S2 = &bucket[h]
        vm.load(VReg.S3, VReg.S2, 0); // cur（哈希链）
        vm.movImm(VReg.S4, 0); // prev（哈希链）= null
        vm.label("_map_del_chain");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_map_del_notfound");
        vm.load(VReg.A0, VReg.S3, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_map_key_eq");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_map_del_found");
        vm.mov(VReg.S4, VReg.S3);
        vm.load(VReg.S3, VReg.S3, 24); // hnext
        vm.jmp("_map_del_chain");

        vm.label("_map_del_found");
        // 摘出哈希链
        vm.load(VReg.V1, VReg.S3, 24); // node.hnext
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_map_del_chain_head");
        vm.store(VReg.S4, 24, VReg.V1); // prev.hnext = node.hnext
        vm.jmp("_map_del_ilist");
        vm.label("_map_del_chain_head");
        vm.store(VReg.S2, 0, VReg.V1); // 桶 = node.hnext
        vm.label("_map_del_ilist");
        // 摘出插入序链表（走 head 用指针相等找前驱）
        vm.load(VReg.S4, VReg.S0, 16); // cur = head
        vm.movImm(VReg.S5, 0); // prevList = null
        vm.label("_map_del_ilist_loop");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_map_del_dec"); // 理论不达
        vm.cmp(VReg.S4, VReg.S3);
        vm.jeq("_map_del_ilist_unlink");
        vm.mov(VReg.S5, VReg.S4);
        vm.load(VReg.S4, VReg.S4, 16); // next
        vm.jmp("_map_del_ilist_loop");
        vm.label("_map_del_ilist_unlink");
        vm.load(VReg.V1, VReg.S3, 16); // node.next
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_map_del_ilist_head");
        vm.store(VReg.S5, 16, VReg.V1); // prevList.next = node.next
        vm.jmp("_map_del_ilist_tail");
        vm.label("_map_del_ilist_head");
        vm.store(VReg.S0, 16, VReg.V1); // head = node.next
        vm.label("_map_del_ilist_tail");
        vm.load(VReg.V2, VReg.S0, 24); // tail
        vm.cmp(VReg.V2, VReg.S3);
        vm.jne("_map_del_dec");
        vm.store(VReg.S0, 24, VReg.S5); // tail = prevList（删的是尾）
        vm.label("_map_del_dec");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S0, 8, VReg.V1);
        // 返回规范 JS 布尔(同 _map_has,非裸 1/0)——Map.prototype.delete 返 boolean。
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_map_del_notfound");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ============================================================
        // _map_clear(A0 = map) - 清空（重置 size/head/tail 并清零桶数组）
        // ============================================================
        vm.label("_map_clear");
        vm.load(VReg.V0, VReg.A0, 32); // bucket_count
        vm.load(VReg.V1, VReg.A0, 40); // buckets_ptr
        vm.movImm(VReg.V2, 0); // 下标
        vm.movImm(VReg.V3, 0);
        vm.label("_map_clear_loop");
        vm.cmp(VReg.V2, VReg.V0);
        vm.jge("_map_clear_done");
        vm.shlImm(VReg.V4, VReg.V2, 3);
        vm.add(VReg.V5, VReg.V1, VReg.V4);
        vm.store(VReg.V5, 0, VReg.V3);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_map_clear_loop");
        vm.label("_map_clear_done");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.A0, 8, VReg.V1); // size = 0
        vm.store(VReg.A0, 16, VReg.V1); // head = null
        vm.store(VReg.A0, 24, VReg.V1); // tail = null
        vm.mov(VReg.RET, VReg.A0);
        vm.ret();

        // _map_size - 获取 Map 大小
        vm.label("_map_size");
        vm.load(VReg.RET, VReg.A0, 8);
        vm.ret();

        // ============================================================
        // _map_keys(A0 = map) -> boxed 真数组[键...]（插入序）
        // _map_values(A0 = map) -> boxed 真数组[值...]
        // 迭代器实为数组:遍历插入序链表(head@16→next@16)把 key@0 / value@8
        // 逐个写入新数组的 data 区。只读遍历,不动桶/不 rehash。
        // _array_new_with_size 的 prologue 存 S0-S3(callee-saved),故循环基址
        // (map/head/array/data_ptr)跨该调用安全;填充循环内无调用,V 寄存器安全。
        // ============================================================
        vm.label("_map_keys");
        vm.movImm(VReg.V0, 0); // 字段偏移:key@0
        vm.jmp("_map_kv_common");
        vm.label("_map_values");
        vm.movImm(VReg.V0, 8); // 字段偏移:value@8
        vm.label("_map_kv_common");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.V0); // S3 = 字段偏移(暂存,跨 array_new 保活)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // S0 = 裸 map 指针
        vm.load(VReg.A0, VReg.S0, 8); // size
        vm.call("_array_new_with_size"); // RET = 裸数组头(S0-S3 保活)
        vm.mov(VReg.S1, VReg.RET); // S1 = 数组头
        vm.load(VReg.S2, VReg.S1, 24); // S2 = data_ptr(填充期不增长)
        vm.mov(VReg.V5, VReg.S3); // V5 = 字段偏移
        vm.load(VReg.S3, VReg.S0, 16); // S3 = cur = map.head
        vm.movImm(VReg.V4, 0); // i
        vm.label("_map_kv_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_map_kv_done");
        vm.add(VReg.V6, VReg.S3, VReg.V5); // &node[字段偏移]
        vm.load(VReg.V0, VReg.V6, 0); // key 或 value
        vm.shlImm(VReg.V1, VReg.V4, 3);
        vm.add(VReg.V2, VReg.S2, VReg.V1);
        vm.store(VReg.V2, 0, VReg.V0); // data[i] = 元素
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.load(VReg.S3, VReg.S3, 16); // cur = node.next
        vm.jmp("_map_kv_loop");
        vm.label("_map_kv_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n); // TAG_ARRAY
        vm.mov(VReg.RET, VReg.S1);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        // ============================================================
        // _map_entries(A0 = map) -> boxed 真数组[[k,v]...]
        // 每个元素是新建的 2 元真数组 [key, value](装箱)。内层 _array_new_with_size
        // 调用只存 S0-S3,故索引/外层头/外层 data_ptr/当前节点全放 S0-S3 跨调用保活;
        // 未处理的链表由 S3(当前节点,在其栈帧内)保守栈扫描保活。
        // ============================================================
        vm.label("_map_entries");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // S0 = 裸 map(跨 array_new 保活)
        vm.load(VReg.A0, VReg.S0, 8); // size
        vm.call("_array_new_with_size"); // RET = 外层数组头
        vm.mov(VReg.S1, VReg.RET); // S1 = 外层头
        vm.load(VReg.S2, VReg.S1, 24); // S2 = 外层 data_ptr
        vm.load(VReg.S3, VReg.S0, 16); // S3 = cur = map.head
        vm.movImm(VReg.S0, 0); // S0 = i(map 指针已不再需要,复用)
        vm.label("_map_entries_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_map_entries_done");
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size"); // RET = 内层 2 元数组头(S0-S3 保活)
        // 内层头/数据指针用 V5/V6(=x64 R10/R11,不与 A/RET 别名);本轮内无调用,
        // V 寄存器安全。禁用 S5:x64 上 S5 是栈槽,作 load/store 基址会经 RAX(=V0)
        // 中转 → 冲掉待存值(entries 在 x64 返回外层数组自身的根因)。
        vm.mov(VReg.V5, VReg.RET); // V5 = 内层头
        vm.load(VReg.V6, VReg.V5, 24); // V6 = 内层 data_ptr
        vm.load(VReg.V0, VReg.S3, 0); // node.key @0
        vm.store(VReg.V6, 0, VReg.V0); // inner[0] = key
        vm.load(VReg.V0, VReg.S3, 8); // node.value @8
        vm.store(VReg.V6, 8, VReg.V0); // inner[1] = value
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.V2, VReg.V5);
        vm.or(VReg.V2, VReg.V2, VReg.V1); // 装箱内层数组
        vm.shlImm(VReg.V3, VReg.S0, 3);
        vm.add(VReg.V4, VReg.S2, VReg.V3);
        vm.store(VReg.V4, 0, VReg.V2); // outer[i] = [k,v]
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.load(VReg.S3, VReg.S3, 16); // cur = node.next
        vm.jmp("_map_entries_loop");
        vm.label("_map_entries_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S1);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 48);

        // ============================================================
        // [ES2024] Map.groupBy(items, cb) -> 裸 Map 指针 (key -> [元素...])
        // 同 Object.groupBy 但结果是 Map(key 为回调原值,任意类型;===/SameValueZero
        // 语义由 _map_has/_map_get/_map_set 内 _strict_eq 提供),分组值是装箱数组。
        // _groupby_invoke2 定义于 ObjectGenerator(标签全局解析,跨生成器可引用)。
        // ============================================================
        const MASK48 = 0x0000ffffffffffffn;
        const TAG_ARRAY = 0x7ffe000000000000n;
        vm.label("_map_groupBy");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // items(boxed 数组)
        vm.mov(VReg.S1, VReg.A1); // cb
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S3, VReg.RET); // length
        vm.call("_map_new");
        vm.mov(VReg.S2, VReg.RET); // 裸 Map
        vm.movImm(VReg.S4, 0); // index

        vm.label("_mgb_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_mgb_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.store(VReg.SP, 0, VReg.RET); // element @ [SP+0]
        vm.mov(VReg.A1, VReg.RET); // element
        vm.mov(VReg.A0, VReg.S1); // cb
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A2, 0); // index number
        vm.call("_groupby_invoke2");
        vm.store(VReg.SP, 8, VReg.RET); // key(回调原值) @ [SP+8]
        // 已有分组?_map_get 未命中返回 0;命中返回装箱数组(high16==0x7ffe)。
        // (勿用 _map_has:它返回装箱布尔 _js_true/_js_false,均非 0。)
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_map_get");
        vm.store(VReg.SP, 16, VReg.RET); // 先落栈:命中即为现存数组;否则即将被新数组覆盖
        // [x64 死表] 用 V3(≠RET)取 high16;勿用 V0(x64 V0==RET==RAX,shr 会毁 RET)。
        vm.shrImm(VReg.V3, VReg.RET, 48);
        vm.cmpImm(VReg.V3, 0x7ffe);
        vm.jeq("_mgb_push"); // 现存数组已在 [SP+16]
        // 新建装箱空数组
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, TAG_ARRAY);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 16, VReg.RET); // arr @ [SP+16](覆盖)
        vm.mov(VReg.A2, VReg.RET); // value
        vm.load(VReg.A1, VReg.SP, 8); // key
        vm.mov(VReg.A0, VReg.S2); // map
        vm.call("_map_set");
        vm.label("_mgb_push");
        vm.load(VReg.A0, VReg.SP, 16);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_array_push");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_mgb_loop");

        vm.label("_mgb_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }
}
