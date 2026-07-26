// asm.js 对象运行时
// 提供对象操作函数

import { VReg } from "../../../vm/registers.js";
import { JS_TAG_STRING_BASE, JS_PAYLOAD_MASK } from "../../core/jsvalue.js";

// 对象内存布局（属性区独立分配，对象头指针稳定、可原地增长）:
// +0:  type (8 bytes) = TYPE_OBJECT (2)
// +8:  属性数量 count (8 bytes)
// +16: __proto__ 指针 (8 bytes)
// +24: capacity (8 bytes) - props 数组当前可容纳的属性数
// +32: props_ptr (8 bytes) - 指向独立分配的属性数组
//      属性数组每个属性: key指针(8) + value(8) = 16 bytes
// 增长：count>=capacity 时另分配 2*capacity 的属性数组、拷贝旧 kv、
//      更新 capacity+props_ptr。对象头地址不变，故所有持有该对象指针的
//      别名（装箱变量/闭包捕获等）保持有效。

const TYPE_OBJECT = 2;
const TYPE_PROXY = 8; // Proxy 对象块:type@0=8, target@8, handler@16(装箱 0x7FFD)。
                      // 独立 type 字节使属性访问快路(cmp==TYPE_OBJECT)自动漏判 → 落
                      // _object_get/_set 冷分支调 handler 陷阱;普通对象访问逐字节不变。
// 非属性容器堆块类型字节(布局与 [count@8, props_ptr@32] 不兼容,通用属性遍历必须绕开):
const TYPE_MAP = 4; // Map:哈希/链表布局
const TYPE_SET = 5; // Set:哈希/链表布局
const TYPE_ARRAY_BUFFER = 12; // ArrayBuffer:[type@0, byteLength@8, data_ptr@16, owner@24]
const TYPE_DATA_VIEW = 14; // DataView:[type@0, data_ptr@8, byteOffset@16, byteLength@24](32B,无 props_ptr)
const TYPE_TA_LO = 0x40; // TypedArray 类型字节区间 [0x40, 0x7f]:[type@0, length@8, 内联元素@16]
const TYPE_TA_HI = 0x7f;
const TYPE_GETTER = 60; // getter 标记对象，见 runtime/core/allocator.js
const TYPE_SYMBOL = 61; // Symbol 标记块，见 runtime/core/allocator.js
const TYPE_SHAPE_DESC = 16; // [shape v2 · T2a] 原型带键形状描述符(堆块):@0 = count|(accessor_free<<63), @8 = keys_ptr
// [#61 P2] 对象头 40→48:尾部加 flags_ptr@40。所有 <40 偏移(0/8/16/24/32)零改,
// 故现有 get/set/ic/delete/keys/for-in/原型链读取全部不动。flags_ptr 惰性平行
// 属性 attrs 数组(capacity 字节,每属性 1 字节),flags_ptr=0 语义 = 全属性默认
// attrs(writable+enumerable+configurable 全 1)。普通赋值/对象字面量/类字段/
// 编译器自身对象全部 flags_ptr=0(不分配 flags 块),逐字节等价 P1 后状态。
const OBJECT_HEADER_SIZE = 56; // type + count + __proto__ + capacity + props_ptr + flags_ptr + shape_ptr@48
const OBJECT_CAP_OFFSET = 24; // capacity 字段偏移
const OBJECT_PROPS_PTR_OFFSET = 32; // props 数组指针偏移
const OBJECT_FLAGS_PTR_OFFSET = 40; // per-property attrs 数组指针偏移(0=全默认 attrs)
const OBJECT_SHAPE_OFFSET = 48; // shape 描述符指针偏移(0=无形状,形状 IC 未启用)
const PROP_SIZE = 16; // key + value

// per-property attribute 位(flags[i] 对应 props_ptr+i*16)
const ATTR_WRITABLE = 1; // bit0
const ATTR_ENUMERABLE = 2; // bit1
const ATTR_CONFIGURABLE = 4; // bit2
const ATTR_DEFAULT = 7; // 普通属性:writable+enumerable+configurable 全 1

// [#61 P1] 属性描述符 Phase 1 —— 对象级 extensible/sealed/frozen 三位。
// 存 type 字的 byte1(obj+1),语义取反(0=默认可扩展)。
// _object_new 整字写 TYPE_OBJECT(0..2),byte1 天然=0;普通赋值路径永不
// storeByte 到 byte1 → 普通对象逐字节不变。type 读者全用 loadByte@0,不受影响。
const EXT_NONEXT = 1; // bit0: non-extensible(拒新增属性)
const EXT_SEALED = 2; // bit1: sealed(叠加拒删除)
const EXT_FROZEN = 4; // bit2: frozen(叠加拒改写已有值)
// [#61 P2] bit3:对象已 materialize per-property flags(defineProperty 带非默认
// attrs / 精确 freeze-seal)。语义 = "IC 快路必须落慢路细判 per-property 位"。
// IC set 快/慢路都以 byte1≠0 为分流条件,故置本位即强制经 _object_set 的 per-property
// 写守卫。与 EXT_NONEXT/SEALED/FROZEN 正交:isFrozen/isSealed/isExtensible 只按各自
// 专位 andImm 判别,不受 bit3 干扰。
const EXT_HASFLAGS = 8; // bit3: 存在 per-property flags 块
export class ObjectGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        this.generateObjectNew();
        this.generateProxyNew();
        this.generateProxyTrapFn();
        this.generateThrowProxyInvariant();
        this.generateArefObjHelpers(); // [Stage A] Object.prototype 方法引用包装
        this.generateProxyApplyTramp();
        this.generateProxyConstructCall();
        this.generateCompletePropDescriptor();
        this.generateObjectDefinePropertyProxy();
        this.generateFnConstructCall();
        this.generateObjectGet();
        this.generateObjectGetIC();
        this.generateThrowReadNullish();
        this.generateThrowTypeError();
        this.generateObjectSetIC();
        this.generateObjectDelete();
        this.generateMaybeGetter();
        this.generateObjectSet();
        this.generateJsPropKey();
        this.generateObjectKeyEq();
        this.generateObjectHas();
        this.generatePropIn();
        this.generateObjectKeys();
        this.generateObjectGetOwnPropertyNames();
        this.generateObjectGetOwnPropertySymbols();
        this.generateObjectProtoToString();
        this.generateObjectValues();
        this.generateObjectEntries();
        this.generateObjectAssign();
        this.generateObjectRest();
        this.generateObjectCreate();
        this.generateHasOwnProperty();
        this.generateObjectToString();
        this.generateObjectValueOf();
        this.generateGetPrototypeOf();
        this.generateIsPrototypeOf();
        this.generateSetPrototypeOf();
        this.generateObjectFreeze();
        this.generateObjectSeal();
        this.generateObjectPreventExtensions();
        this.generateObjectIsFrozen();
        this.generateObjectIsSealed();
        this.generateObjectIsExtensible();
        // [#61 P2] per-property attributes
        this.generateObjectGrowFlags();
        this.generateObjectEnsureFlags();
        this.generateObjectGetAttr();
        this.generateObjectSetAttr();
        this.generateObjectSetPropAttr();
        this.generateCanonicalArrayIndex();
        this.generateObjectNormalizeOrder();
        this.generateObjectApplyClearAttrs();
        this.generateObjectGetOwnPropertyDescriptor();
        this.generateObjectPropertyIsEnumerable();
        this.generateGroupbyInvoke2();
        this.generateObjectGroupBy();
        this.generateClosurePropsHelpers();
        this.generateShapeTransitions(); // [shape v2 · T0] 转移节点/转移表(惰性,无调用方)
    }

    // [shape v2 · T0] 运行时形状转移基础设施(**惰性:T0 无调用方,无行为变化**)。
    // 设计见 docs/SHAPE_TRANSITIONS_DESIGN.md §3。shape_ptr@48 三态:0=无形状 /
    // 数据段址=静态描述符(v1,仅 key_count 单 qword)/ 堆址=动态转移节点(v2)。
    //
    // 转移节点(堆块 TYPE_SHAPE=15,用户区 48B):
    //   +0 parent_shape  +8 transitions(保留恒 0)  +16 key(boxed 驻留串)
    //   +24 key_count(含本键)  +32 new_index  +40 flags(bit0 MEGAMORPHIC,保留)
    // 转移表(堆块,用户区):+0 capacity(2 的幂) +8 count +16 entries…;entry 24B
    //   {from_shape@0, key@8, to_shape@16};空槽 from==0;开放寻址线性探测;装载因子
    //   0.7 翻倍扩容(rehash,旧表留给 GC);表根锚于数据段 _shape_transition_root。
    // 寄存器契约:helper 存 S0–S3;_alloc 只保 S0–S3(S4 不保——跨 _alloc 活值限 S0–S3,
    // 其余经锚槽/栈保全);V0–V7 纯 scratch。
    generateShapeTransitions() {
        const vm = this.vm;
        const TYPE_SHAPE = 15;

        // ---------- _shape_node_new(A0=parent_shape, A1=boxed_key, A2=new_index) -> RET=节点 ----------
        // key_count = parent.key_count + 1:parent 为堆址(动态节点)读 @24,
        // 数据段址(静态描述符)读 @0 单 qword——堆范围判别同 _strlen 快径习语。
        vm.label("_shape_node_new");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // parent
        vm.mov(VReg.S1, VReg.A1); // key
        vm.mov(VReg.S2, VReg.A2); // new_index
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_snn_static_parent");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_snn_static_parent");
        vm.load(VReg.S3, VReg.S0, 24); // 动态节点:key_count@24
        vm.jmp("_snn_have_kc");
        vm.label("_snn_static_parent");
        vm.load(VReg.S3, VReg.S0, 0);  // 静态描述符:key_count 单 qword@0
        vm.label("_snn_have_kc");
        vm.addImm(VReg.S3, VReg.S3, 1); // S3 = key_count
        vm.movImm(VReg.A0, 48);         // 用户区 48B(_alloc 请求不含 16B 头)
        vm.call("_alloc");              // 保 S0–S3
        vm.mov(VReg.V3, VReg.RET);      // V3 = 节点(此后无 call,V 寄存器安全)
        vm.subImm(VReg.V2, VReg.V3, 16); // block
        vm.movImm(VReg.V1, TYPE_SHAPE);
        vm.storeByte(VReg.V2, 0, VReg.V1); // type 裸字节(同 writeStringHeader 习语;GC 用独立位图)
        vm.store(VReg.V3, 0, VReg.S0);  // parent_shape
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V3, 8, VReg.V0);  // transitions = 0(保留)
        vm.store(VReg.V3, 16, VReg.S1); // key
        vm.store(VReg.V3, 24, VReg.S3); // key_count
        vm.store(VReg.V3, 32, VReg.S2); // new_index
        vm.store(VReg.V3, 40, VReg.V0); // flags = 0
        vm.mov(VReg.RET, VReg.V3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // ---------- _shape_transition_get(A0=from, A1=key) -> RET=to | 0 ----------
        vm.label("_shape_transition_get");
        vm.prologue(16, []);
        vm.lea(VReg.V0, "_shape_transition_root");
        vm.load(VReg.V0, VReg.V0, 0);   // table
        vm.movImm(VReg.RET, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_stg_done");            // 无表 → miss
        vm.load(VReg.V1, VReg.V0, 0);   // cap
        vm.addImm(VReg.V7, VReg.V0, 16); // entries base
        // h = (from>>4) ^ (key>>4);idx = h & (cap-1)
        vm.shrImm(VReg.V2, VReg.A0, 4);
        vm.shrImm(VReg.V3, VReg.A1, 4);
        vm.xor(VReg.V2, VReg.V2, VReg.V3);
        vm.subImm(VReg.V4, VReg.V1, 1);
        vm.and(VReg.V2, VReg.V2, VReg.V4);
        // p = base + idx*24(*24 = <<4 + <<3);end = base + cap*24
        vm.shlImm(VReg.V5, VReg.V2, 4);
        vm.shlImm(VReg.V4, VReg.V2, 3);
        vm.add(VReg.V5, VReg.V5, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V7); // p
        vm.shlImm(VReg.V6, VReg.V1, 4);
        vm.shlImm(VReg.V4, VReg.V1, 3);
        vm.add(VReg.V6, VReg.V6, VReg.V4);
        vm.add(VReg.V6, VReg.V6, VReg.V7); // end
        vm.label("_stg_loop");
        vm.load(VReg.V3, VReg.V5, 0);   // e.from
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_stg_done");            // 空槽 → miss(RET=0)
        vm.cmp(VReg.V3, VReg.A0);
        vm.jne("_stg_next");
        vm.load(VReg.V3, VReg.V5, 8);   // e.key
        vm.cmp(VReg.V3, VReg.A1);
        vm.jne("_stg_next");
        vm.load(VReg.RET, VReg.V5, 16); // e.to — 命中
        vm.jmp("_stg_done");
        vm.label("_stg_next");
        vm.addImm(VReg.V5, VReg.V5, 24);
        vm.cmp(VReg.V5, VReg.V6);
        vm.jlt("_stg_loop");
        vm.mov(VReg.V5, VReg.V7);       // 绕回 base
        vm.jmp("_stg_loop");            // 装载因子 <0.7 → 必有空槽终止
        vm.label("_stg_done");
        vm.epilogue([], 16);

        // ---------- _shape_transition_put(A0=from, A1=key, A2=to) ----------
        // 插入 (from,key)→to;首调惰性建表(cap 16);装载因子 ≥0.7 翻倍 rehash。
        vm.label("_shape_transition_put");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.lea(VReg.V0, "_shape_transition_root");
        vm.load(VReg.V1, VReg.V0, 0);   // table(可能 0)
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_stp_have_table");
        // ---- 惰性建表:cap 16,用户区 16 + 16×24 = 400B ----
        vm.movImm(VReg.A0, 400);
        vm.call("_alloc");              // 保 S0–S3
        vm.mov(VReg.S3, VReg.RET);      // S3 = table
        vm.movImm(VReg.V1, 16);
        vm.store(VReg.S3, 0, VReg.V1);  // capacity
        vm.movImm(VReg.V4, 0);
        vm.store(VReg.S3, 8, VReg.V4);  // count = 0
        vm.addImm(VReg.V2, VReg.S3, 16); // p
        vm.addImm(VReg.V3, VReg.S3, 400); // end
        vm.label("_stp_zero");
        vm.cmp(VReg.V2, VReg.V3);
        vm.jge("_stp_zeroed");
        vm.store(VReg.V2, 0, VReg.V4);  // 清零 entries(V4=0)
        vm.addImm(VReg.V2, VReg.V2, 8);
        vm.jmp("_stp_zero");
        vm.label("_stp_zeroed");
        vm.lea(VReg.V0, "_shape_transition_root");
        vm.store(VReg.V0, 0, VReg.S3);  // 锚槽登记(数据段根 → 表存活)
        vm.mov(VReg.V1, VReg.S3);
        vm.label("_stp_have_table");
        // ---- 探测:命中既存边 → 覆写返回;空槽 → 插入 ----
        vm.load(VReg.V2, VReg.V1, 0);   // cap
        vm.addImm(VReg.V3, VReg.V1, 16); // base
        vm.shrImm(VReg.V4, VReg.S0, 4);
        vm.shrImm(VReg.V5, VReg.S1, 4);
        vm.xor(VReg.V4, VReg.V4, VReg.V5);
        vm.subImm(VReg.V6, VReg.V2, 1);
        vm.and(VReg.V4, VReg.V4, VReg.V6); // idx
        vm.shlImm(VReg.V6, VReg.V4, 4);
        vm.shlImm(VReg.V7, VReg.V4, 3);
        vm.add(VReg.V6, VReg.V6, VReg.V7);
        vm.add(VReg.V6, VReg.V6, VReg.V3); // p
        vm.shlImm(VReg.V0, VReg.V2, 4);
        vm.shlImm(VReg.V7, VReg.V2, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V7);
        vm.add(VReg.V0, VReg.V0, VReg.V3); // end
        vm.label("_stp_probe");
        vm.load(VReg.V7, VReg.V6, 0);   // e.from
        vm.cmpImm(VReg.V7, 0);
        vm.jeq("_stp_insert");          // 空槽
        vm.cmp(VReg.V7, VReg.S0);
        vm.jne("_stp_advance");
        vm.load(VReg.V7, VReg.V6, 8);   // e.key
        vm.cmp(VReg.V7, VReg.S1);
        vm.jeq("_stp_update");          // 既存边
        vm.label("_stp_advance");
        vm.addImm(VReg.V6, VReg.V6, 24);
        vm.cmp(VReg.V6, VReg.V0);
        vm.jlt("_stp_probe");
        vm.mov(VReg.V6, VReg.V3);       // 绕回
        vm.jmp("_stp_probe");
        vm.label("_stp_update");
        vm.store(VReg.V6, 16, VReg.S2);
        vm.jmp("_stp_done");
        vm.label("_stp_insert");
        vm.store(VReg.V6, 0, VReg.S0);
        vm.store(VReg.V6, 8, VReg.S1);
        vm.store(VReg.V6, 16, VReg.S2);
        // ---- count++;count*10 >= cap*7 → 扩容(mul 以移位加法替代) ----
        vm.load(VReg.V4, VReg.V1, 8);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.store(VReg.V1, 8, VReg.V4);
        vm.shlImm(VReg.V5, VReg.V4, 3);
        vm.shlImm(VReg.V6, VReg.V4, 1);
        vm.add(VReg.V5, VReg.V5, VReg.V6); // count*10
        vm.shlImm(VReg.V6, VReg.V2, 3);
        vm.sub(VReg.V6, VReg.V6, VReg.V2); // cap*7
        vm.cmp(VReg.V5, VReg.V6);
        vm.jlt("_stp_done");
        // ---- 扩容:newcap = cap×2,rehash 旧表 → 新表 ----
        // S0–S2 已无需(边已插入旧表);S3 = 旧表(跨 _alloc 存活;旧表经栈上保存的
        // S3 被保守栈扫描钉住,锚槽换指新表后仍存活至 rehash 完)。
        vm.mov(VReg.S3, VReg.V1);       // 旧表 → S3
        vm.load(VReg.V0, VReg.S3, 0);   // oldcap
        vm.shlImm(VReg.V0, VReg.V0, 1); // newcap
        vm.shlImm(VReg.A0, VReg.V0, 4);
        vm.shlImm(VReg.V4, VReg.V0, 3);
        vm.add(VReg.A0, VReg.A0, VReg.V4);
        vm.addImm(VReg.A0, VReg.A0, 16); // 请求 = 16 + newcap*24
        vm.call("_alloc");              // 保 S0–S3;V 寄存器作废
        // x64 上 V0 与 RET 同物理寄存器:RET(新表指针)不得与 V0 运算交错。
        // 先落锚(新表立即经常驻根),再用 V2–V5 写头与清零。
        vm.lea(VReg.V5, "_shape_transition_root");
        vm.store(VReg.V5, 0, VReg.RET); // 锚槽换指新表(旧表靠栈上 S3 存活至 rehash 完)
        vm.load(VReg.V2, VReg.S3, 0);   // oldcap
        vm.shlImm(VReg.V2, VReg.V2, 1); // V2 = newcap
        vm.store(VReg.RET, 0, VReg.V2); // cap
        vm.load(VReg.V3, VReg.S3, 8);   // 旧 count
        vm.store(VReg.RET, 8, VReg.V3);
        // 清零新 entries [16, 16+newcap*24)
        vm.addImm(VReg.V3, VReg.RET, 16); // p
        vm.shlImm(VReg.V4, VReg.V2, 4);
        vm.shlImm(VReg.V5, VReg.V2, 3);
        vm.add(VReg.V4, VReg.V4, VReg.V5);
        vm.add(VReg.V4, VReg.V4, VReg.RET);
        vm.addImm(VReg.V4, VReg.V4, 16); // V4 = end
        vm.movImm(VReg.V5, 0);
        vm.label("_stp_rz_zero");
        vm.cmp(VReg.V3, VReg.V4);
        vm.jge("_stp_rz_zeroed");
        vm.store(VReg.V3, 0, VReg.V5);
        vm.addImm(VReg.V3, VReg.V3, 8);
        vm.jmp("_stp_rz_zero");
        vm.label("_stp_rz_zeroed");
        // ---- rehash:遍历旧 entries,逐条重插新表 ----
        // S0=旧 p,S1=旧 end,S2=新 end;V7 = 新 base(探测绕回基准)
        vm.addImm(VReg.S0, VReg.S3, 16); // 旧 entries 起点
        vm.load(VReg.V1, VReg.S3, 0);    // oldcap
        vm.shlImm(VReg.V2, VReg.V1, 4);
        vm.shlImm(VReg.V3, VReg.V1, 3);
        vm.add(VReg.V2, VReg.V2, VReg.V3);
        vm.add(VReg.V2, VReg.V2, VReg.S3);
        vm.addImm(VReg.S1, VReg.V2, 16); // S1 = 旧 end
        vm.lea(VReg.V7, "_shape_transition_root");
        vm.load(VReg.V7, VReg.V7, 0);    // 新表
        vm.addImm(VReg.V7, VReg.V7, 16); // V7 = 新 base
        vm.lea(VReg.V6, "_shape_transition_root");
        vm.load(VReg.V6, VReg.V6, 0);
        vm.load(VReg.V6, VReg.V6, 0);    // newcap
        vm.shlImm(VReg.V2, VReg.V6, 4);
        vm.shlImm(VReg.V3, VReg.V6, 3);
        vm.add(VReg.V2, VReg.V2, VReg.V3);
        vm.lea(VReg.S2, "_shape_transition_root");
        vm.load(VReg.S2, VReg.S2, 0);
        vm.addImm(VReg.S2, VReg.S2, 16);
        vm.add(VReg.S2, VReg.S2, VReg.V2); // S2 = 新 end
        vm.label("_stp_rh_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_stp_done");
        vm.load(VReg.V0, VReg.S0, 0);   // e.from
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_stp_rh_next");         // 空槽跳过
        vm.load(VReg.V1, VReg.S0, 8);   // e.key
        vm.load(VReg.V2, VReg.S0, 16);  // e.to
        // h = (from>>4)^(key>>4) & (newcap-1) → p
        vm.shrImm(VReg.V3, VReg.V0, 4);
        vm.shrImm(VReg.V4, VReg.V1, 4);
        vm.xor(VReg.V3, VReg.V3, VReg.V4);
        vm.subImm(VReg.V4, VReg.V6, 1);
        vm.and(VReg.V3, VReg.V3, VReg.V4);
        vm.shlImm(VReg.V4, VReg.V3, 4);
        vm.shlImm(VReg.V5, VReg.V3, 3);
        vm.add(VReg.V4, VReg.V4, VReg.V5);
        vm.add(VReg.V4, VReg.V4, VReg.V7); // p
        vm.label("_stp_rh_probe");
        vm.load(VReg.V5, VReg.V4, 0);   // slot.from(新表无删除,rehash 无重复,空槽即落点)
        vm.cmpImm(VReg.V5, 0);
        vm.jeq("_stp_rh_place");
        vm.addImm(VReg.V4, VReg.V4, 24);
        vm.cmp(VReg.V4, VReg.S2);
        vm.jlt("_stp_rh_probe");
        vm.mov(VReg.V4, VReg.V7);       // 绕回新 base
        vm.jmp("_stp_rh_probe");
        vm.label("_stp_rh_place");
        vm.store(VReg.V4, 0, VReg.V0);
        vm.store(VReg.V4, 8, VReg.V1);
        vm.store(VReg.V4, 16, VReg.V2);
        vm.label("_stp_rh_next");
        vm.addImm(VReg.S0, VReg.S0, 24);
        vm.jmp("_stp_rh_loop");
        vm.label("_stp_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // ---------- _shape_edge_count(A0=from) -> RET = 该形状的转移边数 ----------
        // (T1 供 megamorphic 阈值判断;全表扫描——边数小,无删除,线性足够)
        vm.label("_shape_edge_count");
        vm.prologue(16, []);
        vm.lea(VReg.V0, "_shape_transition_root");
        vm.load(VReg.V0, VReg.V0, 0);   // table
        vm.movImm(VReg.RET, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_sec_done");
        vm.load(VReg.V1, VReg.V0, 0);   // cap
        vm.addImm(VReg.V2, VReg.V0, 16); // p
        vm.shlImm(VReg.V3, VReg.V1, 4);
        vm.shlImm(VReg.V4, VReg.V1, 3);
        vm.add(VReg.V3, VReg.V3, VReg.V4);
        vm.add(VReg.V3, VReg.V3, VReg.V0);
        vm.addImm(VReg.V3, VReg.V3, 16); // end
        vm.label("_sec_loop");
        vm.cmp(VReg.V2, VReg.V3);
        vm.jge("_sec_done");
        vm.load(VReg.V4, VReg.V2, 0);   // e.from
        vm.cmp(VReg.V4, VReg.A0);
        vm.jne("_sec_next");
        vm.addImm(VReg.RET, VReg.RET, 1);
        vm.label("_sec_next");
        vm.addImm(VReg.V2, VReg.V2, 24);
        vm.jmp("_sec_loop");
        vm.label("_sec_done");
        vm.epilogue([], 16);
    }

    // ---- 闭包/函数自定义属性侧表(fn.x = 1)----
    // asm.js 函数是闭包/裸函数指针,无属性容器(对象头的 props_ptr@32 / flags_ptr@40)。
    // 侧表:数据段链表头 _closure_props_registry(GC 根,位于 _data_gc_end 前 → 挂的 props
    // 对象与其属性常驻),节点 24B {fn 裸指针键@0, props 对象裸指针@8, next@16}。非移动
    // mark-sweep GC → 裸指针键稳定。语义偏差:得过自定义属性的函数被侧表钉住不回收(有界泄漏,
    // 仅限用过 fn.x 的函数;库常在具名函数上挂属性,量小可接受)。
    generateClosurePropsHelpers() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        const OBJ_TAG = 0x7ffd000000000000n;

        vm.asm.addDataLabel("_closure_props_registry");
        vm.asm.addDataQword(0);

        // _closure_props_find(A0=fn 值) -> props 对象(装箱 0x7FFD)或 _js_undefined。
        vm.label("_closure_props_find");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 fn 指针(键)
        vm.lea(VReg.V1, "_closure_props_registry");
        vm.load(VReg.S1, VReg.V1, 0);
        vm.label("_cpf_loop");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_cpf_miss");
        vm.load(VReg.V0, VReg.S1, 0);
        vm.cmp(VReg.V0, VReg.S0);
        vm.jeq("_cpf_hit");
        vm.load(VReg.S1, VReg.S1, 16);
        vm.jmp("_cpf_loop");
        vm.label("_cpf_hit");
        vm.load(VReg.V0, VReg.S1, 8);
        vm.movImm64(VReg.V1, OBJ_TAG);
        vm.or(VReg.RET, VReg.V0, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_cpf_miss");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _closure_props_ensure(A0=fn 值) -> props 对象(装箱 0x7FFD),缺则 _object_new + 登记节点。
        vm.label("_closure_props_ensure");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // 保存 boxed fn
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_cpe_done"); // 已存在
        vm.call("_object_new"); // RET = 裸 props 对象(_object_new/_alloc 保存 S0/S1)
        vm.mov(VReg.S1, VReg.RET); // 裸 props
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc"); // RET = node
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.store(VReg.RET, 0, VReg.V0); // key = 裸 fn
        vm.store(VReg.RET, 8, VReg.S1); // props 裸
        vm.lea(VReg.V2, "_closure_props_registry");
        vm.load(VReg.V1, VReg.V2, 0);
        vm.store(VReg.RET, 16, VReg.V1); // next = 旧头
        vm.store(VReg.V2, 0, VReg.RET); // 头 = 新节点
        vm.movImm64(VReg.V1, OBJ_TAG);
        vm.or(VReg.RET, VReg.S1, VReg.V1); // 装箱 props
        vm.label("_cpe_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _closure_prop_get(A0=fn, A1=key) -> value / undefined(无 props 或键 miss)。
        // 键 miss 且 key==="name" 时,查函数元数据侧表反射函数名(使运行期函数值——参数/
        // 成员链等——的 fn.name 生效,不止编译期静态可知的访问点)。
        vm.label("_closure_prop_get");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A1); // 保存 key
        vm.mov(VReg.S1, VReg.A0); // 保存 fn(跨 _closure_props_find)
        vm.call("_closure_props_find"); // A0=fn → RET=props/undefined
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpg_miss");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        // 键 miss:若 key==="name" 反射元数据名(否则 undefined)。
        vm.label("_cpg_miss");
        // key 去壳 == addString("name") 地址?(emitBoxedStringKey 经 addString dedup,同址)
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);          // key payload
        vm.lea(VReg.V1, vm.asm.addString("name"));  // "name" 串地址
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_cpg_undef");
        // fn 去壳得闭包/裸函数指针 P;闭包(magic 0xc105/0xa51c)真 code_ptr 在 [P+8],否则 P。
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1);          // V0 = P
        vm.load(VReg.V2, VReg.V0, 0);               // [P]
        vm.cmpImm(VReg.V2, 0xc105); vm.jeq("_cpg_name_clo");
        vm.cmpImm(VReg.V2, 0xa51c); vm.jeq("_cpg_name_clo");
        vm.mov(VReg.A0, VReg.V0);                    // 裸函数指针:code_ptr = P
        vm.jmp("_cpg_name_lk");
        vm.label("_cpg_name_clo");
        vm.load(VReg.A0, VReg.V0, 8);               // 闭包:code_ptr = [P+8]
        vm.label("_cpg_name_lk");
        vm.call("_func_meta_name");                 // RET = name_ptr(0=未登记/匿名)
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cpg_undef");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");                  // RET = 装箱字符串
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_cpg_undef");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _closure_prop_set(A0=fn, A1=key, A2=val) -> val(赋值表达式之值)。
        vm.label("_closure_prop_set");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A1); // key
        vm.mov(VReg.S1, VReg.A2); // val
        vm.call("_closure_props_ensure"); // A0=fn → RET=props(装箱)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_set");
        vm.mov(VReg.RET, VReg.S1); // 返回被赋值
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 创建新对象
    // _object_new() -> obj (raw pointer)
    // _object_new_sized(bytes) -> obj (raw pointer)  按需容量（编译期已知属性数时用）
    generateObjectNew() {
        const vm = this.vm;

        vm.label("_object_new");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        // 默认初始容量 8（属性区可自动增长，无需大固定块）
        vm.movImm(VReg.S1, 8);
        vm.jmp("_object_new_do");

        vm.label("_object_new_sized");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        // A0 = 请求字节数（旧头 24 + 每属性 16）。换算成初始容量，下限 4。
        vm.subImm(VReg.S1, VReg.A0, 24);
        vm.cmpImm(VReg.S1, 64);
        vm.jge("_object_new_sized_cap");
        vm.movImm(VReg.S1, 64);
        vm.label("_object_new_sized_cap");
        vm.shrImm(VReg.S1, VReg.S1, 4); // /16 -> 初始容量

        vm.label("_object_new_do");
        // 分配对象头（56 字节：type/count/proto/capacity/props_ptr/flags_ptr/shape_ptr）
        vm.movImm(VReg.A0, OBJECT_HEADER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        // 分配属性数组：capacity * 16 字节
        vm.mov(VReg.A0, VReg.S1);
        vm.shl(VReg.A0, VReg.A0, 4);
        vm.call("_alloc"); // RET(=V0) = props 数组指针

        // props_ptr 与 capacity 先写（RET 别名 V0，后面 movImm V0 会覆盖它）
        vm.store(VReg.S0, OBJECT_PROPS_PTR_OFFSET, VReg.RET);
        vm.store(VReg.S0, OBJECT_CAP_OFFSET, VReg.S1);
        // 设置类型
        vm.movImm(VReg.V0, TYPE_OBJECT);
        vm.store(VReg.S0, 0, VReg.V0);
        // 初始化属性数量为 0
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.S0, 8, VReg.V0);
        // 初始化 __proto__ 为 0 (null)
        vm.store(VReg.S0, 16, VReg.V0);
        // [#61 P2] flags_ptr@40 = 0(惰性,全默认 attrs)。alloc 不清零,必须显式写。
        vm.store(VReg.S0, OBJECT_FLAGS_PTR_OFFSET, VReg.V0);
        // [A1] shape_ptr@48 = 0(无形状;形状 IC 未启用,占位字段,逐字节等价旧语义)。
        vm.store(VReg.S0, OBJECT_SHAPE_OFFSET, VReg.V0);

        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 对象获取属性
    // _object_get(obj, key) -> value
    generateObjectGet() {
        const vm = this.vm;

        vm.label("_object_get");
        // S4=payload mask、S5=查询 key 首字节:循环内首字节预判用(见 loop 处注释)
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.mov(VReg.S0, VReg.A0); // obj
        vm.mov(VReg.S1, VReg.A1); // key
        
        // 类型检查: 必须是 Object (0x7FFD) / Array (0x7FFE) / 裸堆指针 (高16位=0)
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0); // 裸堆指针（未装箱的对象指针，兼容旧调用点）
        vm.jeq("_object_get_tag_ok");
        vm.cmpImm(VReg.V1, 0x7FFD); // Object
        vm.jeq("_object_get_tag_ok");
        // 函数值(0x7FFF)/数组(0x7FFE):自定义属性经属性侧表(运行时路由)。函数:别名/调用
        // 结果/形参等非静态可知的函数值;数组:tagged template 的 `.raw`(__attachRaw 挂接)。
        // 侧表 miss → undefined(与旧数组行为一致)。冷分支,普通对象/裸指针路径逐字节不变。
        // (数组 .length/下标/方法都由编译器另行分派,不经此路径——按对象头遍历数组会把元素
        // 当键值对读垃圾,故数组绝不落 tag_ok。)
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_object_get_fnprops");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_object_get_fnprops");

        // 非法/非对象类型（数组/字符串/数字…），安全返回 undefined(装箱,非裸 0)
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // 函数值属性读:委托 _closure_prop_get(fn, key)(其内查侧表 → 普通对象 _object_get,
        // 无递归——props 是普通对象)。
        vm.label("_object_get_fnprops");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        vm.label("_object_get_tag_ok");
        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        // 检查 obj 是否为 null
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_get_notfound");
        // 防御 floor：合法对象指针(堆/数据段)恒 >= 二进制基址 0x100000000；垃圾低地址
        // (如 0x280100，被当对象指针的数字/offset/损坏值)读 [obj+8] 即崩。低于则当无此属性。
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_object_get_notfound");

        // Map(type=4)/Set(type=5) 不是属性对象（链表/哈希布局，非 [count@8,props_ptr@32]）。
        // 按对象头遍历会把 bucket_count/size 当 count/props_ptr 读 → 解引用垃圾崩。
        // 它们的方法(get/has/add...)由编译器 tag 分派，不经此路径；任意字符串属性一律 undefined。
        vm.loadByte(VReg.V1, VReg.S0, 0); // type 字节
        vm.cmpImm(VReg.V1, 4);
        vm.jeq("_object_get_notfound");
        vm.cmpImm(VReg.V1, 5);
        vm.jeq("_object_get_notfound");
        // TypedArray(0x40-0x7f)/ArrayBuffer(12) 同理不是属性对象:[length@8,数据@16+],
        // 按对象头遍历会把 length 当 count、props_ptr@32 越块读邻居 → 垃圾解引用崩
        // (2026-07-10 实证:f32.buffer 落此路径,bump 邻居为 0 时静默 undefined,
        // GC 复用后邻居非零 → 确定性崩,任务 #19)。
        vm.cmpImm(VReg.V1, 12);
        vm.jeq("_object_get_notfound");
        // DataView(14):32B 块 [type@0, data_ptr@8, byteOffset@16, byteLength@24],**块尾即 32**,
        // 根本没有 props_ptr@32。按对象头遍历会把 data_ptr 当 count(天文数字)、把块外邻居
        // [dv+32] 当 props_ptr 读 → 阶段A 指针扫立即解引用野指针崩(crash PC
        // _object_get_ptrscan+0xc;test262 built-ins/DataView 的主崩因,dv.byteLength /
        // dv.nonexistent 全中)。走冷分支 _object_get_dataview:byteLength/byteOffset 读内建槽,
        // 其余键 undefined(getInt8 等方法由编译器另行分派,不经此路径)。
        vm.cmpImm(VReg.V1, TYPE_DATA_VIEW);
        vm.jeq("_object_get_dataview");
        // Symbol 标记块(61):不是属性对象(desc 串指针在 +8,按对象头遍历会拿
        // 垃圾 count 越块扫崩)。只支持 .description,其余键 undefined——见
        // _object_get_symbol 冷分支。(类型检查失败分支扩一项,不动命中快路)
        vm.cmpImm(VReg.V1, TYPE_SYMBOL);
        vm.jeq("_object_get_symbol");
        // Proxy(type=8):普通对象快路 cmp==2 已漏判至此冷分支,调 handler.get 陷阱。
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jeq("_object_get_proxy");
        vm.cmpImm(VReg.V1, 0x40);
        vm.jlt("_object_get_ty_ok");
        vm.cmpImm(VReg.V1, 0x7f);
        vm.jle("_object_get_notfound");
        vm.label("_object_get_ty_ok");

        // 加载属性数量
        vm.load(VReg.S2, VReg.S0, 8); // prop count
        vm.movImm(VReg.S3, 0); // index

        const loopLabel = "_object_get_loop";
        const foundLabel = "_object_get_found";
        const notFoundLabel = "_object_get_notfound";
        const checkProtoLabel = "_object_get_check_proto";

        // ===== 阶段A:纯指针扫(P0)。编译期 key 经 addString 驻留(同字面量同地址),
        // 装箱值单条 cmp 即命中 —— 驻留负载(编译器自身/常规程序)零调用零预备。
        // 全 miss(动态构造 key/跨源串)才预备首字节进阶段B(原逻辑)。
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET); // props_ptr
        // 防御:props_ptr 为 NULL 但 count>0 的不一致对象 → 视作无自有属性转原型链
        vm.cmpImm(VReg.V2, 0);
        vm.jeq(checkProtoLabel);
        vm.mov(VReg.V0, VReg.V2); // V0 = 游标(键槽地址)
        vm.shl(VReg.V1, VReg.S2, 4);
        vm.add(VReg.V3, VReg.V2, VReg.V1); // V3 = 键槽终点
        vm.label("_object_get_ptrscan");
        vm.cmp(VReg.V0, VReg.V3);
        vm.jge("_object_get_prep_b");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.S1);
        vm.jeq("_object_get_ptrhit");
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.jmp("_object_get_ptrscan");
        vm.label("_object_get_ptrhit");
        vm.sub(VReg.V0, VReg.V0, VReg.V2);
        vm.shrImm(VReg.S3, VReg.V0, 4); // index
        vm.jmp(foundLabel);

        // ===== 阶段B:首字节预判 + strcmp(原逻辑)=====
        vm.label("_object_get_prep_b");
        vm.movImm(VReg.S3, 0); // index 重置
        vm.movImm64(VReg.S4, 0x0000ffffffffffffn);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.loadByte(VReg.S5, VReg.RET, 0); // 查询 key 首字节(空串/非法→0)

        vm.label(loopLabel);
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge(checkProtoLabel);

        // 计算属性地址: props_ptr + index * PROP_SIZE
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET); // props_ptr
        vm.cmpImm(VReg.V2, 0);
        vm.jeq(checkProtoLabel);
        vm.shl(VReg.V0, VReg.S3, 4); // index * 16
        vm.add(VReg.V0, VReg.V2, VReg.V0);

        // 加载 key
        vm.load(VReg.A0, VReg.V0, 0);
        // 首字节预判:prop key 脱壳后首字节 ≠ 查询 key 首字节 → 必不相等,跳过 call。
        // payload 过小(ptrFloor 之下:损坏/非指针)不预判,交给 key_eq 的防御路径。
        vm.and(VReg.V1, VReg.A0, VReg.S4);
        vm.movImm64(VReg.V2, vm.ptrFloor);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jlt("_object_get_slow_eq");
        vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V1, VReg.S5);
        vm.jne("_object_get_next");
        vm.label("_object_get_slow_eq");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");

        vm.cmpImm(VReg.RET, 0);
        vm.jne(foundLabel);

        vm.label("_object_get_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp(loopLabel);

        vm.label(foundLabel);
        // 加载 value: 属性地址 + 8
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET); // props_ptr
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.RET, VReg.V0, 8);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // 在原型链上查找
        vm.label(checkProtoLabel);
        vm.load(VReg.V0, VReg.S0, 16); // __proto__ (裸指针)
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(notFoundLabel);
        // 将裸指针标记为 JS 对象 (0x7FFD)
        vm.orImm(VReg.A0, VReg.V0, 0x7ffd000000000000);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        vm.label(notFoundLabel);
        // 属性缺失 → 装箱 undefined(0x7FFB…),**非裸 0**。裸 0 令 `obj[k]===undefined`
        // 恒假、`obj[k]??d`/`typeof obj[k]` 全错(0 非 nullish、typeof 得 "number")——
        // 缓存/记忆化/可选字段模式静默失效(`c[n]??(c[n]=f(n))` 返 0)。与 Symbol 冷分支
        // (line 324)、数组下标缺失取齐。
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // 冷分支:接收者是 Symbol 标记块。仅 .description 有意义:
        // 命中返回装箱描述串(无描述 → undefined),其余键一律 undefined。
        vm.label("_object_get_symbol");
        vm.mov(VReg.A0, VReg.S1); // key
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, this.vm.asm.addString("description"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne(notFoundLabel);
        vm.load(VReg.RET, VReg.S0, 8); // desc 裸指针
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_get_symbol_boxstr");
        // 无描述 → 装箱 undefined(打印为 "undefined",匹配 node)
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.jmp("_object_get_symbol_ret");
        vm.label("_object_get_symbol_boxstr");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.label("_object_get_symbol_ret");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // 冷分支:接收者是 DataView 块(S0=裸指针)。只有 byteLength@24 / byteOffset@16 两个
        // 内建槽有意义,其余键一律 undefined(与 node 一致:dv.nonexistent === undefined)。
        // 注:dv.buffer 无法在此还原——DataView 块只存 data_ptr,不持有源 ArrayBuffer 对象,
        // 故落 undefined(记偏差)。方法(getInt8/setFloat64…)由编译器 tag 分派,不到此。
        vm.label("_object_get_dataview");
        vm.mov(VReg.A0, VReg.S1); // 装箱键 → 内容指针
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("byteLength"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_dv_bytelength");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("byteOffset"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_dv_byteoffset");
        vm.jmp(notFoundLabel);
        vm.label("_object_get_dv_bytelength");
        vm.load(VReg.V0, VReg.S0, 24);
        vm.jmp("_object_get_dv_num");
        vm.label("_object_get_dv_byteoffset");
        vm.load(VReg.V0, VReg.S0, 16);
        vm.label("_object_get_dv_num");
        // 裸 int → canonical float64 位模式(与 _ta_bytelength 访问点同一表示)
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // ===== Proxy get 陷阱(冷分支;S0=裸 proxy 指针, S1=装箱键)=====
        vm.label("_object_get_proxy");
        vm.load(VReg.S2, VReg.S0, 8);   // target(装箱)
        vm.load(VReg.S3, VReg.S0, 16);  // handler(装箱)
        // handler.get(handler 是普通对象,type=2,无限递归风险)
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("get"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");         // RET = handler.get(函数 或 undef/0)
        vm.mov(VReg.S4, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S4, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);     // function tag
        vm.jne("_object_get_proxy_fwd");
        // 调 get(target, key, receiver=proxy);_aref_invoke_cb 处理闭包/裸函数分派(this=undefined)
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A2, VReg.S0, VReg.V1); // receiver = 装箱 proxy
        vm.mov(VReg.A0, VReg.S2);          // target
        vm.mov(VReg.A1, VReg.S1);          // key
        vm.mov(VReg.A3, VReg.S4);          // trap fn
        vm.call("_aref_invoke_cb");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_proxy_fwd");
        // 无 get 陷阱 → 转发到 target
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
    }

    // _proxy_new(A0=target 装箱, A1=handler 装箱) -> 装箱 0x7FFD proxy
    // 块布局:type@0=TYPE_PROXY, target@8, handler@16, 其余清零(避免 GC 保守扫垃圾字)。
    generateProxyNew() {
        const vm = this.vm;
        vm.label("_proxy_new");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A0); // target
        vm.mov(VReg.S2, VReg.A1); // handler
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");        // target/handler 在 S 寄存器(prologue 落栈,GC 可见)
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, TYPE_PROXY);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.store(VReg.S0, 8, VReg.S1);   // target
        vm.store(VReg.S0, 16, VReg.S2);  // handler
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, 24, VReg.V1);  // 清零余槽
        vm.store(VReg.S0, 32, VReg.V1);
        vm.store(VReg.S0, 40, VReg.V1);
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.RET, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // _proxy_trap_fn(A0=proxy_raw, A1=trap_name_cstr) -> RET = 陷阱函数(tag 0x7FFF)或 0。
    // 读 handler@16、取 handler[name];是函数则返回,否则返 0(调用方回退转发 target)。
    // 所有 Proxy 描述符陷阱(getOwnPropertyDescriptor/defineProperty/ownKeys/
    // preventExtensions/isExtensible/getPrototypeOf/setPrototypeOf)共用。
    generateProxyTrapFn() {
        const vm = this.vm;
        vm.label("_proxy_trap_fn");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.load(VReg.A0, VReg.A0, 16); // handler(装箱)
        vm.mov(VReg.A1, VReg.A1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1); // 装箱字符串键
        vm.call("_object_get"); // RET = handler[name]
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jne("_ptf_none");
        vm.epilogue([VReg.S0, VReg.S1], 16); // RET = 陷阱函数
        vm.label("_ptf_none");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // [Stage A] Object.prototype 方法引用的包装 helper(经 _aref_generic 蹦床调用,
    // 接收者在 A0):_aref_obj_hasOwn 归一 _object_has 的裸 0/1 为规范 JS bool;
    // _aref_obj_valueOf 即恒等(Object.prototype.valueOf(this) === this)。
    generateArefObjHelpers() {
        const vm = this.vm;
        vm.label("_aref_obj_hasOwn");
        vm.prologue(0, []);
        vm.call("_object_has"); // A0=obj, A1=key 透传;RET=裸 0/1
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aref_oho_false");
        vm.movImm64(VReg.RET, 0x7ff9000000000001n);
        vm.epilogue([], 0);
        vm.label("_aref_oho_false");
        vm.movImm64(VReg.RET, 0x7ff9000000000000n);
        vm.epilogue([], 0);

        vm.label("_aref_obj_valueOf");
        vm.mov(VReg.RET, VReg.A0); // 恒等(叶子,无调用,LR 保持)
        vm.ret();
    }

    // [argc ABI/Proxy apply] _proxy_apply_tramp:可调用 Proxy 的调用蹦床。
    // _validate_callable 对 TYPE_PROXY 值合成闭包块 {CLOSURE_MAGIC@0, 本标签@8,
    // proxyRaw@16},调用点按普通闭包分派进来:S0=合成块、A0-A4=实参、A5=this、
    // _call_argc=实参个数(调用点刚写,新鲜)。
    // 有 handler.apply → trap(target, thisArg, argsArray),this=handler;
    // 无 → 转发调用 target(原实参,argc 透传)。
    generateProxyApplyTramp() {
        const vm = this.vm;
        vm.asm.registerRuntimeString("_str_proxy_apply", "apply");
        vm.label("_proxy_apply_tramp");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.load(VReg.S1, VReg.S0, 16); // S1 = proxy raw
        vm.store(VReg.SP, 0, VReg.A0); // 实参落栈槽
        vm.store(VReg.SP, 8, VReg.A1);
        vm.store(VReg.SP, 16, VReg.A2);
        vm.store(VReg.SP, 24, VReg.A3);
        vm.store(VReg.SP, 32, VReg.A4);
        vm.mov(VReg.S3, VReg.A5);      // S3 = thisArg
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.S4, VReg.V0, 0);  // S4 = argc
        vm.cmpImm(VReg.S4, 5);         // 寄存器窗口截断
        vm.jle("_pat_argc_ok");
        vm.movImm(VReg.S4, 5);
        vm.label("_pat_argc_ok");
        vm.load(VReg.S2, VReg.S1, 8);  // S2 = target(存放时形态,装箱/裸)
        vm.load(VReg.S5, VReg.S1, 16); // S5 = handler(装箱)
        // 实参数组:argc 个(真 undefined 也收)
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.SP, 40, VReg.RET);
        for (let k = 0; k < 5; k++) {
            vm.cmpImm(VReg.S4, k);
            vm.jle("_pat_arr_done");
            vm.load(VReg.A0, VReg.SP, 40);
            vm.load(VReg.A1, VReg.SP, k * 8);
            vm.call("_array_push");
            vm.store(VReg.SP, 40, VReg.RET);
        }
        vm.label("_pat_arr_done");
        // trap = handler.apply(经 _proxy_trap_fn:函数则 0x7FFF,否则 0)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, "_str_proxy_apply");
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pat_forward");
        // trap 调用:A0=target, A1=thisArg, A2=argsArr, this=handler, argc=3
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1); // V0 = trap raw
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_pat_trap_closure");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_pat_trap_closure");
        vm.mov(VReg.V1, VReg.V0);      // 裸函数
        vm.movImm(VReg.S0, 0);
        vm.jmp("_pat_trap_call");
        vm.label("_pat_trap_closure");
        vm.mov(VReg.S0, VReg.V0);
        vm.load(VReg.V1, VReg.V0, 8);
        vm.label("_pat_trap_call");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.load(VReg.A2, VReg.SP, 40);
        vm.mov(VReg.A5, VReg.S5);
        vm.setCallArgcImm(3, VReg.V5, VReg.V6);
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        // 无 apply 陷阱:转发调用 target(原实参/this/argc)
        vm.label("_pat_forward");
        vm.mov(VReg.V0, VReg.S2);
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pat_fwd_raw");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        vm.label("_pat_fwd_raw");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_pat_fwd_throw");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_pat_fwd_closure");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_pat_fwd_closure");
        vm.mov(VReg.V1, VReg.V0);
        vm.movImm(VReg.S0, 0);
        vm.jmp("_pat_fwd_call");
        vm.label("_pat_fwd_closure");
        vm.mov(VReg.S0, VReg.V0);
        vm.load(VReg.V1, VReg.V0, 8);
        vm.label("_pat_fwd_call");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.load(VReg.A3, VReg.SP, 24);
        vm.load(VReg.A4, VReg.SP, 32);
        vm.mov(VReg.A5, VReg.S3);
        vm.lea(VReg.V5, "_call_argc"); // argc 透传(截断后的 S4)
        vm.store(VReg.V5, 0, VReg.S4);
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_pat_fwd_throw");
        vm.call("_throw_not_a_function"); // 不返回
    }

    // [Proxy construct] _proxy_construct_call(A0=proxy raw, A1=实参 boxed 数组) -> RET。
    // 有 handler.construct → trap(target, argsArr, newTarget=装箱 proxy),this=handler;
    // 无 → 转发构造 target(按 classinfo:新建对象、挂原型、实参从数组装 A1-A5、调 ctor)。
    generateProxyConstructCall() {
        const vm = this.vm;
        vm.asm.registerRuntimeString("_str_proxy_construct", "construct");
        vm.asm.registerRuntimeString("_str_pcc_prototype", "prototype");
        vm.label("_proxy_construct_call");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A0);      // S1 = proxy raw
        vm.store(VReg.SP, 0, VReg.A1); // 实参数组(装箱)
        vm.load(VReg.S2, VReg.S1, 8);  // S2 = target(存放形态)
        vm.load(VReg.S5, VReg.S1, 16); // S5 = handler(装箱)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, "_str_proxy_construct");
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pcc_forward");
        // trap 调用:A0=target, A1=argsArr, A2=newTarget(装箱 proxy), this=handler, argc=3
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_pcc_trap_closure");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_pcc_trap_closure");
        vm.mov(VReg.V1, VReg.V0);
        vm.movImm(VReg.S0, 0);
        vm.jmp("_pcc_trap_call");
        vm.label("_pcc_trap_closure");
        vm.mov(VReg.S0, VReg.V0);
        vm.load(VReg.V1, VReg.V0, 8);
        vm.label("_pcc_trap_call");
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.movImm64(VReg.V0, 0x7ffd000000000000n);
        vm.or(VReg.A2, VReg.S1, VReg.V0); // newTarget = 装箱 proxy
        vm.mov(VReg.A5, VReg.S5);
        vm.setCallArgcImm(3, VReg.V5, VReg.V6);
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        // 无 construct 陷阱:转发构造 target(classinfo 语义,镜像 compileUserClassNew)
        vm.label("_pcc_forward");
        vm.mov(VReg.S3, VReg.S2);
        vm.shrImm(VReg.V1, VReg.S3, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pcc_fwd_raw");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S3, VReg.S3, VReg.V1);
        vm.label("_pcc_fwd_raw");     // S3 = target raw(classinfo 或闭包)
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_pcc_fwd_throw");
        // [闭包 target] plain function(magic 0xc105)→ ES5 构造分支(classinfo 布局
        // props_ptr@32 对闭包块是垃圾 → `new Proxy(plainFn,{})` 崩的根因)。
        vm.load(VReg.V1, VReg.S3, 0);
        vm.movImm(VReg.V0, 0xc105);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pcc_fwd_closure");
        vm.call("_object_new");
        vm.mov(VReg.S4, VReg.RET);    // S4 = 新实例(裸)
        vm.load(VReg.V1, VReg.S3, 32); // props_ptr
        vm.load(VReg.V0, VReg.V1, 24); // prototype 对象
        vm.store(VReg.S4, 16, VReg.V0);
        vm.load(VReg.V1, VReg.V1, 8);  // ctor 地址
        vm.mov(VReg.S5, VReg.V1);      // S5 = ctor(handler 不再需要)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);     // S2 = len(target 形态已消费)
        for (let i = 0; i < 5; i++) {
            const undefL = `_pcc_a_undef_${i}`;
            const nextL = `_pcc_a_next_${i}`;
            vm.cmpImm(VReg.S2, i);
            vm.jle(undefL);
            vm.load(VReg.A0, VReg.SP, 0);
            vm.movImm(VReg.A1, i);
            vm.call("_array_get");
            vm.store(VReg.SP, 8 + i * 8, VReg.RET);
            vm.jmp(nextL);
            vm.label(undefL);
            vm.movImm64(VReg.V0, 0x7ffb000000000000n);
            vm.store(VReg.SP, 8 + i * 8, VReg.V0);
            vm.label(nextL);
        }
        vm.load(VReg.A1, VReg.SP, 8);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.load(VReg.A3, VReg.SP, 24);
        vm.load(VReg.A4, VReg.SP, 32);
        vm.load(VReg.A5, VReg.SP, 40);
        vm.mov(VReg.A0, VReg.S4);      // this = 新实例
        vm.lea(VReg.V5, "_call_argc"); // argc = 实参数组长度
        vm.store(VReg.V5, 0, VReg.S2);
        vm.callIndirect(VReg.S5);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1); // 返回装箱实例
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // [闭包 target] ES5 fn-构造转发 → 共享 helper(S2=target 原形态、[SP+0]=argsArr)。
        vm.label("_pcc_fwd_closure");
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_fn_construct_call");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_pcc_fwd_throw");
        vm.call("_throw_not_a_function");
    }

    // _fn_construct_call(A0=fn 值(任意形态), A1=实参 boxed 数组) -> RET = 实例/覆盖对象。
    // 运行时函数值的 ES5 构造语义(镜像 compilePlainFunctionNew):新对象、__proto__ 尽力
    // 取 fn.prototype(闭包属性侧表,miss 保持初值)、形参 A0..A4 从数组装(缺省 undefined)、
    // A5=this(裸)、S0=闭包块(捕获环境约定)、argc=数组长度、显式返回对象/数组则覆盖。
    // 供 compileDynamicNew 闭包分支与 Proxy construct 无陷阱转发共用(spread 统一经数组)。
    generateFnConstructCall() {
        const vm = this.vm;
        vm.label("_fn_construct_call");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A0);      // fn 值(原形态)
        vm.store(VReg.SP, 0, VReg.A1); // argsArr
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S3, VReg.S1, VReg.V1); // S3 = 裸闭包
        vm.call("_object_new");
        vm.mov(VReg.S4, VReg.RET);     // S4 = 新实例(裸)
        vm.load(VReg.S5, VReg.S3, 8);  // S5 = 真函数指针(V1=x64 RCX 与 A3 别名,禁跨装参)
        vm.mov(VReg.A0, VReg.S1);      // fn 原形态(与 fn.x=v 写侧同键形)
        vm.lea(VReg.A1, "_str_pcc_prototype");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_closure_prop_get");  // RET = fn.prototype 或 undefined
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_fcc_noproto");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.S4, 16, VReg.V0);
        vm.label("_fcc_noproto");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);     // S2 = len
        for (let i = 0; i < 5; i++) {
            const undefL = `_fcc_a_undef_${i}`;
            const nextL = `_fcc_a_next_${i}`;
            vm.cmpImm(VReg.S2, i);
            vm.jle(undefL);
            vm.load(VReg.A0, VReg.SP, 0);
            vm.movImm(VReg.A1, i);
            vm.call("_array_get");
            vm.store(VReg.SP, 8 + i * 8, VReg.RET);
            vm.jmp(nextL);
            vm.label(undefL);
            vm.movImm64(VReg.V0, 0x7ffb000000000000n);
            vm.store(VReg.SP, 8 + i * 8, VReg.V0);
            vm.label(nextL);
        }
        vm.load(VReg.A0, VReg.SP, 8);  // plain-fn 约定:形参 A0..A4
        vm.load(VReg.A1, VReg.SP, 16);
        vm.load(VReg.A2, VReg.SP, 24);
        vm.load(VReg.A3, VReg.SP, 32);
        vm.load(VReg.A4, VReg.SP, 40);
        vm.mov(VReg.A5, VReg.S4);      // this = 新实例(裸)
        vm.lea(VReg.V5, "_call_argc");
        vm.store(VReg.V5, 0, VReg.S2);
        vm.mov(VReg.S0, VReg.S3);      // S0 = 闭包块(捕获环境约定)
        vm.callIndirect(VReg.S5);
        // 显式返回对象/数组覆盖,否则返回装箱实例
        vm.mov(VReg.V1, VReg.RET);
        vm.shrImm(VReg.V1, VReg.V1, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_fcc_end");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_fcc_end");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.label("_fcc_end");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // _object_defineProperty_proxy(A0=proxy_boxed, A1=key, A2=descObj) -> RET。
    // 有 defineProperty 陷阱 → handler.defineProperty(target, key, descObj);否则转发
    // target(尽力:仅落 descObj.value,attrs 不逐一转发,记偏差)。编译器在
    // Object.defineProperty(obj,...) 目标运行时为 proxy 时调用。
    generateObjectDefinePropertyProxy() {
        const vm = this.vm;
        vm.label("_object_defineProperty_proxy");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // 裸 proxy
        vm.mov(VReg.S1, VReg.A1); // key
        vm.mov(VReg.S2, VReg.A2); // descObj
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, this.vm.asm.addString("defineProperty"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odpp_fwd");
        vm.mov(VReg.A3, VReg.RET);
        vm.load(VReg.A0, VReg.S0, 8); // target
        vm.mov(VReg.A1, VReg.S1); // key
        vm.mov(VReg.A2, VReg.S2); // descObj
        vm.call("_aref_invoke_cb"); // RET = 陷阱布尔
        // [不变式] 陷阱返 truthy 时校验(t372)。falsy → 直接合规。
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odpp_inv_ok");
        // A:target 不可扩展且该键在 target 上不存在(新增属性)→ 抛。
        vm.load(VReg.A0, VReg.S0, 8); // target
        vm.call("_object_isExtensible");
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_odpp_ckB"); // 可扩展 → 跳过 A,验 B
        vm.load(VReg.A0, VReg.S0, 8); // target
        vm.mov(VReg.A1, VReg.S1); // key
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_odpp_ckB"); // key 已存在 → 非新增,验 B
        vm.call("_throw_proxy_invariant"); // 不可扩展上新增属性 → 抛
        // B:desc.configurable===false,但 target 无该键 或 target 上该键 configurable → 抛
        // (不可配置属性须对应 target 的不可配置自有属性)。
        vm.label("_odpp_ckB");
        vm.mov(VReg.A0, VReg.S2); // descObj
        vm.lea(VReg.A1, this.vm.asm.addString("configurable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.lea(VReg.V1, "_js_false");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_odpp_inv_ok"); // desc.configurable 非 false → 合规
        // desc 要求不可配置:检查 target 的对应描述符
        vm.load(VReg.A0, VReg.S0, 8); // target
        vm.mov(VReg.A1, VReg.S1); // key
        vm.call("_object_getOwnPropertyDescriptor"); // RET = target 描述符 或 undefined
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_odpp_throwB"); // target 无该键 → 抛
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("configurable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.lea(VReg.V1, "_js_false");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_odpp_inv_ok"); // target 该键不可配置 → 合规
        vm.label("_odpp_throwB");
        vm.call("_throw_proxy_invariant");
        vm.label("_odpp_inv_ok");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_odpp_fwd");
        // 无陷阱:尽力把 descObj.value 落到 target
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get"); // RET = descObj.value
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.S0, 8); // target
        vm.mov(VReg.A1, VReg.S1); // key
        vm.call("_object_define");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
    }

    // _throw_proxy_invariant():置异常并跨函数 unwind(同 _throw_not_a_function 模式)。
    // Proxy 陷阱结果违反规范不变式时调用(抛 TypeError 近似:消息串,tests 只需被 catch)。
    generateThrowProxyInvariant() {
        const vm = this.vm;
        vm.label("_throw_proxy_invariant");
        vm.lea(VReg.V1, vm.asm.addString("proxy invariant violation"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.V1, VReg.V1, VReg.V0);
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_throw_unwind");
    }

    // 内部:desc(在 S0)缺 name 字段则补默认值(CompletePropertyDescriptor 用)。
    _emitCpdEnsure(vm, nameStr, defVal) {
        const uid = "_cpd_" + nameStr + "_" + (this._cpdId = (this._cpdId || 0) + 1);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString(nameStr));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne(uid); // 已有 → 跳过
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString(nameStr));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.A2, defVal);
        vm.call("_object_set");
        vm.label(uid);
    }

    // _complete_prop_descriptor(A0=desc_boxed) -> RET=desc:按 ES CompletePropertyDescriptor
    // 补默认字段。data 描述符补 value:undefined/writable:false;accessor 补 get/set:undefined;
    // 两者皆补 enumerable/configurable:false。非对象(如 undefined)原样返回。Proxy 的
    // getOwnPropertyDescriptor 陷阱返回部分描述符后经此补全(令 .writable/.enumerable 有值)。
    generateCompletePropDescriptor() {
        const vm = this.vm;
        const FALSEB = 0x7ff9000000000000n;
        const UNDEF = 0x7ffb000000000000n;
        vm.label("_complete_prop_descriptor");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD); // 仅对象
        vm.jne("_cpd_ret");
        // accessor?(has "get" 或 "set")
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("get"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cpd_accessor");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("set"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cpd_accessor");
        // data 描述符
        this._emitCpdEnsure(vm, "value", UNDEF);
        this._emitCpdEnsure(vm, "writable", FALSEB);
        vm.jmp("_cpd_common");
        vm.label("_cpd_accessor");
        this._emitCpdEnsure(vm, "get", UNDEF);
        this._emitCpdEnsure(vm, "set", UNDEF);
        vm.label("_cpd_common");
        this._emitCpdEnsure(vm, "enumerable", FALSEB);
        this._emitCpdEnsure(vm, "configurable", FALSEB);
        vm.label("_cpd_ret");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // [P2/A3.5] 属性读站点缓存(融合 getter 解包)
    // _object_get_ic(obj, key, site) -> value(getter 已解)
    // site 指向该访问点的数据段 24B 槽 {obj_shape@0, holder@8, index@16}:
    // obj_shape==0 为无形状 legacy 模式(缓存下标 + count/props 防御 + 键自验证);
    // 非 0 为形状模式——holder==0 自有键(形状相等 ⟹ 键序相等,count/props 防御省),
    // holder!=0 直接原型键(原型指针相等 + 键自验证,慢路在自有 miss 后扫直接原型
    // 回填;深原型链不缓存落委托)。键自验证单 cmp 全程保留作安全网。
    // 语义 = _object_get + _maybe_getter 融合;站点只发一个 call。
    // 入口是零 prologue 快路:纯 V 寄存器守卫;命中直接 ret;值为裸堆指针(可能
    // getter 标记)时尾跳 _maybe_getter。
    // 任何守卫不满足落 framed 慢路:自有/直接原型指针扫命中回填站点,否则委托 _object_get。
    // x64 寄存器审计:A1=RSI=V7、A2=RDX=V2 为只读入参,快路 scratch 限 V0/V1/V3/V4。
    generateObjectGetIC() {
        const vm = this.vm;
        // ptrFloor 恰为 2 的幂(macos/windows 2^32,linux 2^22):floor 检查用移位
        const floorShift = vm.ptrFloor === 0x400000n ? 22 : 32;

        vm.label("_object_get_ic");
        // ---- 零 prologue 快路(无栈、无 call;LR/返回地址原样) ----
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_ogic_slow");
        vm.shlImm(VReg.V4, VReg.A0, 16);
        vm.shrImm(VReg.V4, VReg.V4, 16); // V4 = 裸指针(截 payload)
        vm.shrImm(VReg.V1, VReg.V4, floorShift); // null/低地址垃圾 → 0
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ogic_slow");
        vm.loadByte(VReg.V1, VReg.V4, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jne("_ogic_slow");
        // [A3.5] 站点槽 24B {obj_shape@0, holder@8, index@16}。obj_shape==0 →
        // 无形状 legacy 下标路径(同旧语义);非 0 → 形状路径:holder==0 为自有键
        // (形状相等 ⟹ 键序相等,省 count/props 防御),holder!=0 为直接原型键
        // (原型指针相等 + 键自验证;改值型猴子补丁仍能读到最新值,改键/改型
        // 经形状置 0 与键验证双兜底)。键自验证单 cmp 全程保留(实测消除零增益)。
        vm.load(VReg.V3, VReg.A2, 0); // cached obj_shape
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_ogic_shaped");
        // ---- legacy 下标路径(无形状对象,同旧快路) ----
        vm.load(VReg.V3, VReg.A2, 16); // 缓存下标@16
        vm.load(VReg.V1, VReg.V4, 8); // count
        vm.cmp(VReg.V3, VReg.V1);
        vm.jge("_ogic_slow");
        vm.load(VReg.V0, VReg.V4, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ogic_slow");
        vm.shlImm(VReg.V1, VReg.V3, 4);
        vm.add(VReg.V0, VReg.V0, VReg.V1); // 属性地址
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.A1); // 键自验证
        vm.jne("_ogic_slow");
        vm.load(VReg.RET, VReg.V0, 8); // 命中:value
        vm.jmp("_ogic_getter_dispatch");
        // ---- 形状路径(命中省 count/props 防御) ----
        vm.label("_ogic_shaped");
        vm.load(VReg.V1, VReg.V4, OBJECT_SHAPE_OFFSET); // obj shape
        vm.cmp(VReg.V1, VReg.V3);
        vm.jne("_ogic_slow"); // 形状不符 → 慢路重学习
        vm.load(VReg.V3, VReg.A2, 8); // holder(0=自有键)
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_ogic_proto");
        // -- 自有键 --
        vm.load(VReg.V3, VReg.A2, 16); // cached index
        vm.load(VReg.V0, VReg.V4, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V1, VReg.V3, 4);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.A1); // 键自验证
        vm.jne("_ogic_slow");
        vm.load(VReg.RET, VReg.V0, 8); // 命中:value
        vm.jmp("_ogic_getter_dispatch");
        // -- 直接原型键(形状命中后:holder 指针相等 + 键自验证) --
        vm.label("_ogic_proto");
        vm.load(VReg.V1, VReg.V4, 16); // obj.__proto__
        vm.cmp(VReg.V3, VReg.V1);
        vm.jne("_ogic_slow"); // 原型已换(改 proto 本就会置形状 0,此为双保险)
        vm.load(VReg.V3, VReg.A2, 16); // cached index
        vm.load(VReg.V0, VReg.V1, OBJECT_PROPS_PTR_OFFSET); // holder.props
        vm.shlImm(VReg.V3, VReg.V3, 4);
        vm.add(VReg.V0, VReg.V0, VReg.V3);
        vm.load(VReg.V3, VReg.V0, 0);
        vm.cmp(VReg.V3, VReg.A1); // 键自验证(holder 键序变化兜底)
        vm.jne("_ogic_slow");
        vm.load(VReg.RET, VReg.V0, 8); // 命中:value
        vm.label("_ogic_getter_dispatch");
        // getter 解包融合:仅裸堆指针(高16位=0)可能是 getter 标记
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ogic_maybe_getter");
        vm.ret();
        vm.label("_ogic_maybe_getter");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogic_ret"); // 零位原样返回(miss 哨兵与 +0.0 同位,见 _maybe_getter 注)
        vm.mov(VReg.V1, VReg.A0); // this = 原 boxed obj(A0 全程未写)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.V1);
        vm.jmp("_maybe_getter"); // 尾跳:借用本次调用的返回地址
        vm.label("_ogic_ret");
        vm.ret();

        // ---- framed 慢路:自有指针扫 + 回填;miss 委托 _object_get;融合 getter ----
        vm.label("_ogic_slow");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // boxed obj(原样留给委托/getter this)
        vm.mov(VReg.S1, VReg.A1); // boxed key
        vm.mov(VReg.S2, VReg.A2); // site 槽地址

        // 只服务装箱普通对象;其余全部委托
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_ogic_slow_delegate");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V1); // V2 = 裸指针
        vm.shrImm(VReg.V1, VReg.V2, floorShift);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ogic_slow_delegate");
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jne("_ogic_slow_delegate");

        // 自有属性指针扫(P0 驻留 key 单条 cmp)
        vm.load(VReg.S3, VReg.V2, OBJECT_PROPS_PTR_OFFSET); // S3 = props 基址
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_ogic_slow_delegate");
        vm.load(VReg.V3, VReg.V2, 8); // count
        vm.mov(VReg.V0, VReg.S3); // 游标
        vm.shlImm(VReg.V1, VReg.V3, 4);
        vm.add(VReg.V3, VReg.S3, VReg.V1); // 终点
        vm.label("_ogic_slow_scan");
        vm.cmp(VReg.V0, VReg.V3);
        vm.jge("_ogic_slow_proto"); // 自有 miss → 试直接原型缓存(A3.5)
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.S1);
        vm.jeq("_ogic_slow_hit");
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.jmp("_ogic_slow_scan");

        vm.label("_ogic_slow_hit");
        vm.sub(VReg.V1, VReg.V0, VReg.S3);
        vm.shrImm(VReg.V1, VReg.V1, 4); // 下标
        vm.store(VReg.S2, 16, VReg.V1); // 回填站点:下标@16
        vm.movImm(VReg.V3, 0);
        vm.store(VReg.S2, 8, VReg.V3); // holder@8 = 0(自有键)
        // [A2] 回填形状@0(V2=裸对象;0=无形状 → 该站点后续走 legacy 路径)
        vm.load(VReg.V3, VReg.V2, OBJECT_SHAPE_OFFSET);
        vm.store(VReg.S2, 0, VReg.V3);
        vm.load(VReg.RET, VReg.V0, 8);
        vm.jmp("_ogic_slow_getter");

        // ---- [A3.5] 直接原型键:自有 miss 后,仅形状对象扫直接原型并缓存 ----
        // (深原型链 v1 不缓存,落委托;proto 上改值仍能读到——快路每次现读 value)
        vm.label("_ogic_slow_proto");
        vm.load(VReg.V1, VReg.V2, OBJECT_SHAPE_OFFSET);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ogic_slow_delegate"); // 无形状对象不缓存原型命中
        vm.load(VReg.V1, VReg.V2, 16); // proto
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ogic_slow_delegate");
        // proto 恒为 0 或堆对象裸指针(对象头域);floor + type 守卫
        vm.shrImm(VReg.V3, VReg.V1, floorShift);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_ogic_slow_delegate");
        vm.loadByte(VReg.V3, VReg.V1, 0);
        vm.cmpImm(VReg.V3, TYPE_OBJECT);
        vm.jne("_ogic_slow_delegate");
        vm.mov(VReg.S3, VReg.V1); // S3 = proto(自有扫已毕,S3 复用)
        // [shape v2 · T2a] proto 形状为 TYPE_SHAPE_DESC 带键描述符 → 键表单 cmp 查 index
        // (替代 kv 指针追扫):描述符键表 ≡ proto props 键列快照,命中即真;未命中
        // 仅防御性兜底(键列同源,理论必中)。V6 = obj 裸指针(回填 obj_shape 用)。
        // (掩码取独立寄存器:and 的 dest==a 形态有 x64 生产实证,dest==b 无。)
        vm.movImm64(VReg.V7, 0x0000ffffffffffffn);
        vm.and(VReg.V6, VReg.S0, VReg.V7);
        vm.load(VReg.V0, VReg.S3, OBJECT_SHAPE_OFFSET); // proto.shape
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ogic_pkv");                    // 无形状 → kv 扫
        vm.subImm(VReg.V1, VReg.V0, 16);        // 描述符块头
        vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, TYPE_SHAPE_DESC);
        vm.jne("_ogic_pkv");                    // 静态描述符/转移节点 → kv 扫
        vm.load(VReg.V1, VReg.V0, 0);           // count | flags63
        vm.movImm64(VReg.V2, 0x7fffffffffffffffn);
        vm.and(VReg.V1, VReg.V1, VReg.V2);      // count
        vm.load(VReg.V2, VReg.V0, 8);           // keys_ptr
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_ogic_pkv");
        vm.mov(VReg.V0, VReg.V2);               // 游标
        vm.shlImm(VReg.V3, VReg.V1, 3);
        vm.add(VReg.V3, VReg.V2, VReg.V3);      // 终点
        vm.movImm(VReg.V4, 0);                  // index
        vm.label("_ogic_pkey_scan");
        vm.cmp(VReg.V0, VReg.V3);
        vm.jge("_ogic_pkv");
        vm.load(VReg.V5, VReg.V0, 0);
        vm.cmp(VReg.V5, VReg.S1);               // boxed key 驻留指针单 cmp
        vm.jeq("_ogic_pkey_hit");
        vm.addImm(VReg.V0, VReg.V0, 8);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.jmp("_ogic_pkey_scan");
        vm.label("_ogic_pkey_hit");
        // 回填站点 {obj_shape@0, holder=proto@8, index@16} + 取值
        vm.load(VReg.V5, VReg.V6, OBJECT_SHAPE_OFFSET);
        vm.store(VReg.S2, 0, VReg.V5);
        vm.store(VReg.S2, 8, VReg.S3);
        vm.store(VReg.S2, 16, VReg.V4);
        vm.load(VReg.V5, VReg.S3, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V4, VReg.V4, 4);
        vm.add(VReg.V5, VReg.V5, VReg.V4);
        vm.load(VReg.RET, VReg.V5, 8);
        vm.jmp("_ogic_slow_getter");
        vm.label("_ogic_pkv");
        vm.load(VReg.V4, VReg.S3, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_ogic_slow_delegate");
        vm.load(VReg.V3, VReg.S3, 8); // count
        vm.mov(VReg.V0, VReg.V4); // 游标
        vm.shlImm(VReg.V3, VReg.V3, 4);
        vm.add(VReg.V3, VReg.V4, VReg.V3); // 终点
        vm.label("_ogic_pscan");
        vm.cmp(VReg.V0, VReg.V3);
        vm.jge("_ogic_slow_delegate");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.S1);
        vm.jeq("_ogic_phit");
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.jmp("_ogic_pscan");

        vm.label("_ogic_phit");
        vm.sub(VReg.V1, VReg.V0, VReg.V4);
        vm.shrImm(VReg.V1, VReg.V1, 4); // 下标
        vm.store(VReg.S2, 16, VReg.V1); // 回填站点:下标@16
        vm.store(VReg.S2, 8, VReg.S3); // holder@8 = proto(堆指针;站点区属 GC 根,
        // 原型本就近永生,可接受)
        vm.load(VReg.V3, VReg.V2, OBJECT_SHAPE_OFFSET);
        vm.store(VReg.S2, 0, VReg.V3); // obj shape@0(≠0,已守卫)
        vm.load(VReg.RET, VReg.V0, 8);
        vm.jmp("_ogic_slow_getter");

        vm.label("_ogic_slow_delegate");
        // null/undefined 基对象读属性抛可捕获 TypeError(ES: `null.x`/`undefined.x`)。
        // 仅此二 tag 抛;字符串/数值/数组等非普通对象仍按 str[i]/装箱语义委托返 undefined。
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA); vm.jeq("_ogic_throw_nullish"); // null
        vm.cmpImm(VReg.V1, 0x7FFB); vm.jeq("_ogic_throw_nullish"); // undefined
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");

        vm.label("_ogic_slow_getter");
        // getter 解包融合(与快路同判据;this = S0)
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_ogic_slow_ret");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogic_slow_ret");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.label("_ogic_slow_ret");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // null/undefined 基对象读属性:构造真 TypeError 并 unwind(S0=base, S1=boxed key)。
        vm.label("_ogic_throw_nullish");
        vm.mov(VReg.A0, VReg.S0); // base
        vm.mov(VReg.A1, VReg.S1); // boxed key(属性名字符串)
        vm.call("_throw_read_nullish"); // 不返回
    }

    // _throw_read_nullish(A0 = null/undefined 基对象, A1 = boxed 属性名字符串)
    // 构造 `TypeError: Cannot read properties of null|undefined (reading '<prop>')`
    // 普通对象 {name,message,__asmjs_err,cause}(与 emitThrowTypeError 同表示,故
    // `e instanceof TypeError`/`e.name`/`e.message` 成立),置异常槽后 _throw_unwind
    // 跨帧交给最近 try/catch(链空则退出码 1,与未捕获一致)。不返回。
    generateThrowReadNullish() {
        const vm = this.vm;
        const boxStr = (reg) => { // 把 reg 内 cstr 地址标记成堆串(0x7FFC)
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_throw_read_nullish");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // S1 = boxed 属性名
        // 前缀按 null/undefined 选择
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_trn_null");
        vm.lea(VReg.A0, vm.asm.addString("Cannot read properties of undefined (reading '"));
        vm.jmp("_trn_prefix_done");
        vm.label("_trn_null");
        vm.lea(VReg.A0, vm.asm.addString("Cannot read properties of null (reading '"));
        vm.label("_trn_prefix_done");
        vm.call("_cstr_to_heap_str"); // RET = boxed 堆串
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1); // 属性名
        vm.call("_strconcat"); // RET = prefix + name
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("')"));
        boxStr(VReg.A1);
        vm.call("_strconcat"); // RET = 完整 message
        vm.mov(VReg.S0, VReg.RET); // S0 = message
        // 构造 TypeError 普通对象
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET); // S2 = errObj(boxed)
        // name = "TypeError"
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("name")); boxStr(VReg.A1);
        vm.lea(VReg.A2, vm.asm.addString("TypeError")); boxStr(VReg.A2);
        vm.call("_object_set");
        // message
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("message")); boxStr(VReg.A1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        // __asmjs_err = true(instanceof Error 族品牌)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("__asmjs_err")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ff9000000000001n); // boxed true
        vm.call("_object_set");
        // cause = undefined(否则 e.cause 缺属性返 int 0 非 undefined)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("cause")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ffb000000000000n); // undefined
        vm.call("_object_set");
        // 置异常槽并 unwind
        vm.mov(VReg.S3, VReg.S2);
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S3);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_throw_unwind"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16); // 理论不达
    }

    // _throw_type_error(A0 = boxed message 字符串):构造 TypeError {name,message,__asmjs_err,cause}
    // 普通对象(与 _throw_read_nullish 同表示,故 e instanceof TypeError / e.name / e.message 成立),
    // 置异常槽后 _throw_unwind 跨帧交给最近 try/catch。不返回。
    // [test262 S1] 复用原语:_throw_not_a_function / 数组回调守卫 / Object.* 类型守卫等共用。
    generateThrowTypeError() {
        const vm = this.vm;
        const boxStr = (reg) => { // 把 reg 内 cstr 地址标记成堆串(0x7FFC)
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_throw_type_error");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // S0 = boxed message
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET); // S2 = errObj(boxed)
        // name = "TypeError"
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("name")); boxStr(VReg.A1);
        vm.lea(VReg.A2, vm.asm.addString("TypeError")); boxStr(VReg.A2);
        vm.call("_object_set");
        // message
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("message")); boxStr(VReg.A1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        // __asmjs_err = true(instanceof Error 族品牌)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("__asmjs_err")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ff9000000000001n); // boxed true
        vm.call("_object_set");
        // cause = undefined(否则 e.cause 缺属性返 int 0 非 undefined)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("cause")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ffb000000000000n); // undefined
        vm.call("_object_set");
        // 置异常槽并 unwind
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S2);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_throw_unwind"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16); // 理论不达
    }

    // [P2] 属性写站点缓存
    // _object_set_ic(obj, key, value, site)
    // 快路:守卫 + 缓存下标键自验证 → 直写 value → 尾跳 _gc_remember
    // (叶子裸函数,借本次返回地址;写后记录——两点间无分配,STW GC 安全)。
    // 慢路:自有指针扫命中 → 回填站点 + 写 + 屏障;未命中/守卫不满足 → 委托
    // _object_set(追加/增长/屏障自含)。追加后的下标不回填(下次慢路扫到即回填)。
    // RET 语义与 _object_set 同为未定义(现有站点均不消费)。
    // x64 别名:A1=RSI=V7、A2=RDX=V2、A3=RCX=V1 只读,快路 scratch 限 V0/V3/V4。
    generateObjectSetIC() {
        const vm = this.vm;
        const floorShift = vm.ptrFloor === 0x400000n ? 22 : 32;

        vm.label("_object_set_ic");
        // ---- 零 prologue 快路 ----
        vm.shrImm(VReg.V3, VReg.A0, 48);
        vm.cmpImm(VReg.V3, 0x7FFD);
        vm.jne("_osic_slow");
        vm.shlImm(VReg.V4, VReg.A0, 16);
        vm.shrImm(VReg.V4, VReg.V4, 16); // 裸指针
        vm.shrImm(VReg.V3, VReg.V4, floorShift);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_osic_slow");
        vm.loadByte(VReg.V3, VReg.V4, 0);
        vm.cmpImm(VReg.V3, TYPE_OBJECT);
        vm.jne("_osic_slow");
        // [#61 P1] 对象级冻结位守卫:byte1(扩展标志)≠0 才落慢路(慢路细判/委托
        // _object_set 强制)。普通对象 byte1=0 一条 cmp 即过,近零税。
        // x64 别名:scratch 限 V0/V3/V4(A0/A1=V7/A2=V2/A3=V1 为只读入参);V3=R8=A4
        // 非本函数入参,此处安全复用。
        vm.loadByte(VReg.V3, VReg.V4, 1);
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_osic_slow");
        // [A3] 站点槽 16B {cached_shape@0, cached_index@8}:cached_shape==0 走 legacy
        // 下标路径(同旧语义),非 0 走形状路径(形状相等 ⟹ 键序相等,省 count/props
        // 判空;v1 保留键自验证单 cmp 作安全网)。
        vm.load(VReg.V0, VReg.A3, 0); // cached shape
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_osic_shaped");
        // ---- legacy 下标路径(无形状对象) ----
        vm.load(VReg.V0, VReg.A3, 8); // 缓存下标
        vm.load(VReg.V3, VReg.V4, 8); // count
        vm.cmp(VReg.V0, VReg.V3);
        vm.jge("_osic_slow");
        vm.load(VReg.V3, VReg.V4, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_osic_slow");
        vm.shlImm(VReg.V0, VReg.V0, 4);
        vm.add(VReg.V3, VReg.V3, VReg.V0); // 属性地址
        vm.load(VReg.V0, VReg.V3, 0);
        vm.cmp(VReg.V0, VReg.A1); // 键自验证
        vm.jne("_osic_slow");
        vm.jmp("_osic_slot_found");
        // ---- 形状路径(命中省 count/props 防御) ----
        vm.label("_osic_shaped");
        vm.load(VReg.V3, VReg.V4, OBJECT_SHAPE_OFFSET); // obj shape
        vm.cmp(VReg.V3, VReg.V0);
        vm.jne("_osic_slow"); // 形状不符 → 慢路重学习
        vm.load(VReg.V0, VReg.A3, 8); // cached index
        vm.load(VReg.V3, VReg.V4, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.V0, 4);
        vm.add(VReg.V3, VReg.V3, VReg.V0); // 属性地址
        vm.load(VReg.V0, VReg.V3, 0);
        vm.cmp(VReg.V0, VReg.A1); // 键自验证(v1 保留)
        vm.jne("_osic_slow");
        vm.label("_osic_slot_found");
        // [访问器] 旧值为非零裸堆指针（可能 TYPE_GETTER 标记）→ 落慢路细判；
        // 装箱值/0 直写。热路仅 +4 op（load 同缓存行 + 2 cmp）。
        vm.load(VReg.V0, VReg.V3, 8); // 旧值
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_osic_store");
        vm.shrImm(VReg.V4, VReg.V0, 48); // V4(裸 obj 指针)此后不再使用
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_osic_slow");
        vm.label("_osic_store");
        vm.store(VReg.V3, 8, VReg.A2); // 直写 value
        vm.jmp("_gc_remember"); // 尾跳:A0=boxed obj 已就位

        // ---- framed 慢路 ----
        vm.label("_osic_slow");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2); // value
        vm.mov(VReg.S3, VReg.A3); // site
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_osic_delegate");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V1);
        vm.shrImm(VReg.V1, VReg.V2, floorShift);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_osic_delegate");
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jne("_osic_delegate");
        // [#61 P1] 冻结/密封/不可扩展对象一律委托 _object_set(含全部强制点),
        // 避免慢路 _osic_hit 直写绕过冻结守卫。普通对象 byte1=0 一条 cmp 即过。
        vm.loadByte(VReg.V1, VReg.V2, 1);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_osic_delegate");
        vm.load(VReg.V4, VReg.V2, OBJECT_PROPS_PTR_OFFSET); // props 基址
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_osic_delegate");
        vm.load(VReg.V3, VReg.V2, 8); // count
        vm.mov(VReg.V0, VReg.V4); // 游标
        vm.shlImm(VReg.V1, VReg.V3, 4);
        vm.add(VReg.V3, VReg.V4, VReg.V1); // 终点
        vm.label("_osic_scan");
        vm.cmp(VReg.V0, VReg.V3);
        vm.jge("_osic_delegate");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.S1);
        vm.jeq("_osic_hit");
        vm.addImm(VReg.V0, VReg.V0, 16);
        vm.jmp("_osic_scan");

        vm.label("_osic_hit");
        // [A3] 形状先取存 V3(V2=裸对象,下方旧值判别会覆盖 V2;判别 scratch 用 V1
        // 不用 V3——装箱值分支会贯穿到 _osic_hit_plain,V3 须保活到站点回填)
        vm.load(VReg.V3, VReg.V2, OBJECT_SHAPE_OFFSET); // obj shape
        // [访问器] 旧值为非零裸堆指针 → 委托 _object_set（含 setter 分派；罕见路径，
        // 不回填站点——键自验证会让后续快路对该键恒 miss 落慢路，正确性不受影响）
        vm.load(VReg.V2, VReg.V0, 8); // 旧值
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_osic_hit_plain");
        vm.shrImm(VReg.V1, VReg.V2, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_osic_delegate");
        vm.label("_osic_hit_plain");
        vm.sub(VReg.V1, VReg.V0, VReg.V4);
        vm.shrImm(VReg.V1, VReg.V1, 4);
        vm.store(VReg.S3, 8, VReg.V1); // 回填站点:下标@8
        vm.store(VReg.S3, 0, VReg.V3); // [A3] 回填站点:形状@0(V3=_osic_hit 处取,
        // jeq delegate 的访问器分支不达此,形状值在 plain 两路均保活)
        vm.store(VReg.V0, 8, VReg.S2); // 写 value
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_remember");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        vm.label("_osic_delegate");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set"); // 追加/增长/屏障自含
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // [#33] delete obj.key —— _object_delete(obj, key) -> JS_TRUE
    // 命中即把后续 kv 整体下移 16B(保持插入序,Object.keys 枚举序不变),
    // count--。站点缓存无需失效:缓存下标处的 key 变了,get/set IC 的键
    // 自验证必 miss 落慢路。未命中/非普通对象一律返回 true(JS 语义)。
    generateObjectDelete() {
        const vm = this.vm;

        vm.label("_object_delete");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);

        // [#39] 计算键 delete o[k] 数值键规范化(字符串键 tag 判别直通)
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_odel_key_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_odel_key_ok");

        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_odel_tag_ok");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_odel_tag_ok");
        vm.jmp("_odel_true");
        vm.label("_odel_tag_ok");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1); // 脱壳
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_odel_true");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY); // Proxy:冷分支调 handler.deleteProperty
        vm.jeq("_odel_proxy");
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jne("_odel_true");

        vm.load(VReg.S2, VReg.S0, 8); // count
        vm.movImm(VReg.S3, 0); // idx
        vm.label("_odel_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_odel_true");
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_odel_true");
        vm.shlImm(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmp(VReg.A0, VReg.S1); // 驻留键指针快路
        vm.jeq("_odel_hit");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq"); // 内容兜底(动态键)
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_odel_hit");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_odel_loop");

        vm.label("_odel_hit");
        // [#61 P1] 密封/冻结对象拒绝删除属性,返回 **false**(delete 一个不可配置属性
        // 的 sloppy 语义为返 false;此前误返 true)。byte1 & (EXT_SEALED|EXT_FROZEN);
        // preventExtensions 仅置 EXT_NONEXT 不含 SEALED,故仍可删已有属性(符合 ES)。
        // 普通对象 byte1=0 一条 and 即过。
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_SEALED | EXT_FROZEN);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_odel_false");
        // [#61 P2] per-property configurable:false → 拒删,返 **false**(sloppy delete
        // 语义:defineProperty 的不可配置属性不可删)。flags_ptr@40==0(普通对象/字面量/
        // 类)→ 全默认可配置,一条 cmp 即过、逐字节不变;仅 materialize 过 flags 的对象
        // (经 defineProperty/freeze/seal)读 flags[idx]&ATTR_CONFIGURABLE 判别。
        vm.load(VReg.V0, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_odel_cfg_ok");
        vm.add(VReg.V0, VReg.V0, VReg.S3); // &flags[idx]
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.andImm(VReg.V0, VReg.V0, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_odel_false"); // 不可配置 → 不删,返 false
        vm.label("_odel_cfg_ok");
        // 下移 [S3+1..count) 共 (count-1-S3) 条,每条 16B(两个字)
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.mov(VReg.V0, VReg.S3);
        vm.subImm(VReg.V4, VReg.S2, 1); // 尾界 = count-1
        vm.label("_odel_shift");
        vm.cmp(VReg.V0, VReg.V4);
        vm.jge("_odel_shift_done");
        vm.shlImm(VReg.V1, VReg.V0, 4);
        vm.add(VReg.V1, VReg.V2, VReg.V1); // dst
        vm.load(VReg.V3, VReg.V1, 16); // src.key
        vm.store(VReg.V1, 0, VReg.V3);
        vm.load(VReg.V3, VReg.V1, 24); // src.value
        vm.store(VReg.V1, 8, VReg.V3);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_odel_shift");
        vm.label("_odel_shift_done");
        vm.store(VReg.S0, 8, VReg.V4); // count--
        // [A2] 删键:键集合改变,形状失效置 0
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.S0, OBJECT_SHAPE_OFFSET, VReg.V0);
        // [#61 P2] flags 块同步下移(仅当已 materialize)。S3=删除下标、S2=旧 count。
        // 逐字节 flags[i]=flags[i+1] for i in [idx, count-1)。全 V scratch,S 保活。
        vm.load(VReg.V0, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_odel_true");
        vm.add(VReg.V1, VReg.V0, VReg.S3); // &flags[idx] = dst 游标
        vm.subImm(VReg.V4, VReg.S2, 1); // 尾界 = count-1
        vm.mov(VReg.V2, VReg.S3); // i = idx
        vm.label("_odel_fshift");
        vm.cmp(VReg.V2, VReg.V4);
        vm.jge("_odel_true");
        vm.loadByte(VReg.V3, VReg.V1, 1); // flags[i+1]
        vm.storeByte(VReg.V1, 0, VReg.V3); // flags[i] = flags[i+1]
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_odel_fshift");

        vm.label("_odel_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // [#61 P2] 不可配置属性 delete 返回 false(不删除)。
        vm.label("_odel_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // ===== Proxy deleteProperty 陷阱(冷分支;S0=裸 proxy, S1=装箱键)=====
        vm.label("_odel_proxy");
        vm.load(VReg.S2, VReg.S0, 8);   // target(装箱)
        vm.load(VReg.S3, VReg.S0, 16);  // handler(装箱)
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("deleteProperty"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");         // RET = handler.deleteProperty
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jne("_odel_proxy_fwd");
        vm.mov(VReg.A3, VReg.RET);      // callback
        vm.mov(VReg.A0, VReg.S2);       // target
        vm.mov(VReg.A1, VReg.S1);       // key
        vm.lea(VReg.A2, "_js_undefined");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.call("_aref_invoke_cb");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");         // 裸 0/1
        vm.movImm64(VReg.V1, 0x7ff9000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1); // 装箱布尔(同 _object_delete 返回型)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_odel_proxy_fwd");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_delete");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _maybe_getter(value, this) -> value 或 getter 调用结果
    // 属性读取后调用：若 value 是 getter 标记对象
    // (裸堆指针且 [value-16] == TYPE_GETTER)，以 this 调用其函数并返回结果；
    // 否则原样返回 value。
    generateMaybeGetter() {
        const vm = this.vm;

        vm.label("_maybe_getter");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // value
        vm.mov(VReg.S1, VReg.A1); // this

        // 只有裸堆指针才可能是 getter 对象
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_maybe_getter_pass");
        // [bug A 根本障碍,勿再试读侧转换] miss 哨兵裸 0 与存储的 +0.0
        // (raw double 全零位)不可区分——曾把零值短路改成返回 undefined,
        // regexp shim(pos=0)/零值属性全部塌成 undefined。根治需存储侧把
        // raw-double-zero 规范化为装箱 int0 后才能解放哨兵,另案。
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_maybe_getter_pass");
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_maybe_getter_pass");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_maybe_getter_pass");

        // 类型检查: value+0 处是类型字段（标记对象 {type@value+0, getter@value+8,
        // setter@value+16}，存用户区，不占 block+0 分配器 size 头——否则 GC sweep
        // 靠 size 走块会错位、误回收活对象）
        vm.load(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_GETTER);
        vm.jne("_maybe_getter_pass");

        // getter 槽为 0（只 set 访问器）→ 读出 undefined
        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_maybe_getter_undef");

        // 槽值判别：堆闭包（对象字面量路径，{magic 0xc105/0xa51c@0, func@8}）
        // 或裸 TEXT 函数指针（类路径）。堆内且 magic 命中 → S0=闭包(被调方经
        // callee-saved S0 取捕获 box；epilogue 还原)、真函数指针在闭包+8。
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jlt("_maybe_getter_call");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jge("_maybe_getter_call");
        vm.load(VReg.V0, VReg.V1, 0);
        vm.cmpImm(VReg.V0, 0xc105); // CLOSURE_MAGIC
        vm.jeq("_maybe_getter_closure");
        vm.cmpImm(VReg.V0, 0xa51c); // ASYNC_CLOSURE_MAGIC
        vm.jne("_maybe_getter_call");
        vm.label("_maybe_getter_closure");
        vm.mov(VReg.S0, VReg.V1);
        vm.load(VReg.V1, VReg.S0, 8); // 真函数指针

        // 调用 getter: this 走方法约定 (A5)
        vm.label("_maybe_getter_call");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A5, VReg.S1);
        vm.setCallArgcImm(0, VReg.V0, VReg.V2); // [argc ABI] getter()
        vm.callIndirect(VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_maybe_getter_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // tagged undefined
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_maybe_getter_pass");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

    }

    // 对象设置属性
    // _object_set(obj, key, value)    —— 赋值语义：命中/链上访问器走 setter 分派
    // _object_define(obj, key, value) —— 定义语义：永不触发访问器（类方法表/字段、
    //   对象字面量属性用；否则子类 prototype 定义与父类 getter 同名成员会被拦截误吞）。
    //   两入口共享主体，[SP+24] 存 define 标志（本帧局部，跨 call 稳定，同 [SP+16]）。
    generateObjectSet() {
        const vm = this.vm;

        vm.label("_object_define");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.SP, 24, VReg.V0); // define 标志 = 1
        vm.jmp("_object_set_entry");

        vm.label("_object_set");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 24, VReg.V0); // define 标志 = 0

        vm.label("_object_set_entry");
        vm.call("_gc_remember"); // 分代写屏障(A0=容器,老容器记入记忆集;分代 GC 已是缺省)

        vm.mov(VReg.S0, VReg.A0); // obj
        vm.mov(VReg.S1, VReg.A1); // key
        vm.mov(VReg.S2, VReg.A2); // value

        // 类型检查: 必须是 Object (0x7FFD) / Array (0x7FFE) / 裸堆指针 (高16位=0)
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0); // 裸堆指针（未装箱的对象指针，兼容旧调用点）
        vm.jeq("_object_set_tag_ok");
        vm.cmpImm(VReg.V1, 0x7FFD); // Object
        vm.jeq("_object_set_tag_ok");
        // 数组(0x7FFE):绝不落对象头写路径——数组头仅 32 字节(type@0/length@8/capacity@16/
        // data_ptr@24),无 props_ptr@32,按对象头写会把 [S0+32] 当 props_ptr 解引用垃圾 → SIGSEGV
        // (镜像 _object_get 读路径对 0x7FFE 的路由 :629-631)。_object_set_array 内再分:规范
        // 数值索引键(Object.defineProperty(a,"1",…))→ 数组元素写;具名键(a.foo=9)→ 属性侧表。
        vm.cmpImm(VReg.V1, 0x7FFE); // Array
        vm.jeq("_object_set_array");
        // 函数值(0x7FFF):自定义属性写经闭包属性侧表(运行时路由,冷分支;别名/调用结果/
        // 形参等非静态可知的函数值)。普通对象路径逐字节不变。
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_object_set_fnprops");

        // 非法类型，跳过设置
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // 函数值属性写:委托 _closure_prop_set(fn, key, val)(ensure 侧表 → 普通对象 _object_set)。
        vm.label("_object_set_fnprops");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_set");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // 数组具名/索引属性写分派(S0=arr[boxed 0x7FFE 或裸], S1=key, S2=value)。
        // 规范数值索引键(CanonicalNumericIndexString, 如 "1")→ 委托 _subscript_set 做数组
        // 元素写(含 _array_ensure_cap 增长、逻辑空档补 undefined、length 更新);_subscript_set
        // 内部 _js_unbox 容裸/装箱数组,_syscall_arg 对小整数下标走裸路径原样返回。非索引键
        // (a.foo)→ 属性侧表 _object_set_fnprops。_canonical_array_index 仅动 S0/S1(其 prologue
        // 保存并复原),不碰 S2,故 value 跨调用稳定。
        vm.label("_object_set_array");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index"); // RET = idx(0..2^32-2) / -1(非索引)
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_set_fnprops"); // 非索引键 → 属性侧表
        // 先落 A1=下标:RET 与 A0 共物理寄存器(X0),必须在 mov A0 覆盖 X0 前取走下标。
        vm.mov(VReg.A1, VReg.RET);      // 裸整数下标
        vm.mov(VReg.A0, VReg.S0);       // arr
        vm.mov(VReg.A2, VReg.S2);       // value
        vm.call("_subscript_set");
        vm.mov(VReg.RET, VReg.S2);      // 赋值表达式之值
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_object_set_tag_ok");
        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        // 调试：检查对象是否为 NULL
        vm.cmpImm(VReg.S0, 0);
        const objOkLabel = "_object_set_obj_ok";
        vm.jne(objOkLabel);
        
        vm.lea(VReg.A0, this.vm.asm.addString("FATAL: _object_set called with NULL object! (A0=0)\n"));
        vm.call("_print_str");
        vm.movImm(VReg.A0, 1);
        vm.call("_exit");

        vm.label(objOkLabel);

        // 类型字节防御(与 _object_get 同理):Map/Set/TypedArray/ArrayBuffer 不是
        // 属性对象,按对象头写会把 length 当 count、越块写毁邻居 → 静默跳过。
        vm.loadByte(VReg.V1, VReg.S0, 0);
        // 裸指针数组(高16位=0 的裸堆指针,type@0==TYPE_ARRAY==1):同装箱数组(0x7FFE)
        // 走 _object_set_array(索引键→元素写,具名键→侧表)。数组头无 props_ptr@32,
        // 按对象头写解引用垃圾 → SIGSEGV。S0 已脱壳,_subscript_set/_closure_prop_set 均容裸指针。
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jeq("_object_set_array");
        vm.cmpImm(VReg.V1, 4);
        vm.jeq("_object_set_ty_bail");
        vm.cmpImm(VReg.V1, 5);
        vm.jeq("_object_set_ty_bail");
        vm.cmpImm(VReg.V1, 12);
        vm.jeq("_object_set_ty_bail");
        // Symbol 标记块:写属性会把 desc 指针槽当 count 毁块 → 静默跳过
        vm.cmpImm(VReg.V1, TYPE_SYMBOL);
        vm.jeq("_object_set_ty_bail");
        // Proxy(type=8):冷分支调 handler.set 陷阱。
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jeq("_object_set_proxy");
        vm.cmpImm(VReg.V1, 0x40);
        vm.jlt("_object_set_ty_ok");
        vm.cmpImm(VReg.V1, 0x7f);
        vm.jgt("_object_set_ty_ok");
        vm.label("_object_set_ty_bail");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_object_set_ty_ok");

        // 先查找已有属性
        vm.load(VReg.S3, VReg.S0, 8); // prop count
        vm.movImm(VReg.S4, 0); // index

        // 循环外:查询 key 首字节 → [SP+16](S 寄存器全占用,本函数未用 SP 槽;
        // bl/call 不动本帧 SP,槽跨 call 稳定)。预判原理同 _object_get。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.loadByte(VReg.V0, VReg.RET, 0);
        vm.store(VReg.SP, 16, VReg.V0);

        const loopLabel = "_object_set_loop";
        const foundLabel = "_object_set_found";
        const notFoundLabel = "_object_set_notfound";
        const doneLabel = "_object_set_done";

        vm.label(loopLabel);
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge(notFoundLabel);

        // 计算属性地址: props_ptr + index*16
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S4, 4);
        vm.add(VReg.S5, VReg.V2, VReg.V0); // S5 = 属性地址

        // 加载现有 key 并比较
        vm.load(VReg.A0, VReg.S5, 0);
        // 指针相等快路径(P0,同 _object_get):驻留 key 装箱值单条 cmp 即命中
        vm.cmp(VReg.A0, VReg.S1);
        vm.jeq(foundLabel);
        // 首字节预判(同 _object_get):不等 → 必不匹配,跳过 call
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V2, vm.ptrFloor);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jlt("_object_set_slow_eq");
        vm.loadByte(VReg.V1, VReg.V1, 0);
        vm.load(VReg.V2, VReg.SP, 16);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jne("_object_set_next");
        vm.label("_object_set_slow_eq");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");

        vm.cmpImm(VReg.RET, 0);
        vm.jne(foundLabel);

        vm.label("_object_set_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp(loopLabel);

        // 找到已有属性，更新 value（S5 指向旧 props 数组内的属性，未增长，稳定）
        vm.label(foundLabel);
        // [#61 P1] 冻结对象拒绝改写已有属性值(sloppy 静默,asm.js 无 strict)。
        // byte1 & EXT_FROZEN;普通对象 byte1=0 一条 and 即过。seal/preventExtensions
        // 不置 FROZEN 位,故仍可改写已有值(符合 ES 语义)。
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_FROZEN);
        vm.cmpImm(VReg.V0, 0);
        vm.jne(doneLabel);
        // [#73c] [访问器] 旧值为 TYPE_GETTER 标记对象 → setter@16 分派（为 0 则静默
        // 返回）。此检查必须在 writable 守卫之前:访问器属性无 writable 语义,而
        // defineProperty({get,set}) 建标记时 attrs 缺省全 false(writable=0),若先跑
        // writable 守卫会把 o.p=v 当"改写不可写数据属性"静默丢弃 → setter 永不触发
        // (#73c 根因)。非标记(普通数据属性)落 _object_set_wcheck 继续 writable 守卫;
        // define 语义(标志=1)直接覆写,既不分派访问器也不受 attrs 阻。
        vm.load(VReg.V1, VReg.SP, 24);
        vm.cmpImm(VReg.V1, 1);
        vm.jeq("_object_set_plain");
        vm.load(VReg.V0, VReg.S5, 8); // 旧值
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_wcheck");
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_object_set_wcheck"); // 装箱值必非标记对象
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_object_set_wcheck");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_object_set_wcheck");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER);
        vm.jne("_object_set_wcheck");
        // [访问器分派] V0 = 标记对象（own 命中与原型链拦截两路共用入口）
        vm.label("_object_set_acc_dispatch");
        // setter 槽为 0（只 get 访问器）→ 静默返回
        vm.load(VReg.V0, VReg.V0, 16);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(doneLabel);
        // 调 setter：A0=新值（被调方按方法约定从 A0 读第一形参）、A5=this(重新装箱)。
        // 槽值为堆闭包（字面量路径）→ S0=闭包、真函数指针在闭包+8；否则裸 TEXT 指针直调。
        // S0-S5 由 prologue 保存，调用后走 done 经 epilogue 还原。
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A5, VReg.S0, VReg.V1); // this 装箱（x64: A5=R9=V4，此后不碰 V4）
        vm.mov(VReg.A0, VReg.S2);         // 新值
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_object_set_acc_call");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_object_set_acc_call");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        vm.jeq("_object_set_acc_closure");
        vm.cmpImm(VReg.V1, 0xa51c); // ASYNC_CLOSURE_MAGIC
        vm.jne("_object_set_acc_call");
        vm.label("_object_set_acc_closure");
        vm.mov(VReg.S0, VReg.V0);     // S0 = 闭包（epilogue 还原）
        vm.load(VReg.V0, VReg.S0, 8); // 真函数指针
        vm.label("_object_set_acc_call");
        vm.setCallArgcImm(1, VReg.V1, VReg.V2); // [argc ABI] setter(value)
        vm.callIndirect(VReg.V0);
        vm.jmp(doneLabel);

        // [#61 P2] per-property writable 位精确守卫(仅非访问器、非 define 的赋值到此)。
        // flags_ptr@40==0 → 全默认可写,一条 cmp 即过;materialize 后读 flags[S4]&bit0,
        // 清零 → 静默丢弃。S4=命中下标全程保活,仅用 V0 scratch。
        vm.label("_object_set_wcheck");
        vm.load(VReg.V0, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_plain");
        vm.add(VReg.V0, VReg.V0, VReg.S4); // &flags[idx]
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.andImm(VReg.V0, VReg.V0, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(doneLabel);
        vm.label("_object_set_plain");
        vm.store(VReg.S5, 8, VReg.S2);
        vm.jmp(doneLabel);

        // 未找到，添加新属性
        vm.label(notFoundLabel);
        // [访问器] 原型链上的同名访问器拦截写（类实例 setter：标记对象在 prototype
        // 上、实例无此 own 键）。__proto__ 为 0（普通字面量/字典的常态）时一条
        // cmp 即出，追加路径近零税；有原型才查链（_object_get 自带链走+防御，
        // S 寄存器由被调方保存，S1/S2/S3 跨调用仍有效）。
        // define 语义（标志=1）不查链，直接追加 own。
        vm.load(VReg.V0, VReg.SP, 24);
        vm.cmpImm(VReg.V0, 1);
        vm.jeq("_object_set_append");
        vm.load(VReg.V0, VReg.S0, 16); // __proto__
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_append");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.V0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get"); // 原型链查同名键
        vm.mov(VReg.V0, VReg.RET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_append"); // 链上无此键 → 正常追加 own
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_object_set_append"); // 链上是普通数据属性 → own 遮蔽（JS 语义）
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_object_set_append");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_object_set_append");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER);
        vm.jne("_object_set_append");
        vm.jmp("_object_set_acc_dispatch"); // 链上访问器 → setter 分派（this=本对象）

        vm.label("_object_set_append");
        // [#61 P1] non-extensible 对象拒绝新增属性(sloppy 静默)。
        // freeze/seal/preventExtensions 三者都置 EXT_NONEXT,故此一处覆盖全部。
        // 普通对象 byte1=0 一条 and 即过。
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_NONEXT);
        vm.cmpImm(VReg.V0, 0);
        vm.jne(doneLabel);
        // 容量检查：count >= capacity 时增长属性数组
        vm.load(VReg.V0, VReg.S0, OBJECT_CAP_OFFSET); // capacity
        vm.cmp(VReg.S3, VReg.V0);
        vm.jlt("_object_set_have_room");

        // --- 增长：newcap = capacity*2（capacity==0 时取 4）---
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_object_set_grow_dbl");
        vm.movImm(VReg.V0, 4);
        vm.jmp("_object_set_grow_size");
        vm.label("_object_set_grow_dbl");
        vm.shl(VReg.V0, VReg.V0, 1); // *2
        vm.label("_object_set_grow_size");
        // 先把新容量写入对象头（内存稳定），避免依赖跨 _alloc 的寄存器保存
        // （_alloc 只保存 S0-S3，S4/S5 及 caller-saved V 寄存器不保证保留）。
        vm.store(VReg.S0, OBJECT_CAP_OFFSET, VReg.V0);
        vm.shl(VReg.A0, VReg.V0, 4); // newcap*16 字节
        vm.call("_alloc"); // RET(=V0) = 新 props 数组指针
        // RET 别名 V0，而拷贝循环用 V0 当偏移量会覆盖它 —— 先转存到 S5
        // （S5 由本函数 prologue 保存；capacity 已在 _alloc 前写入，故 S5 现可用）。
        vm.mov(VReg.S5, VReg.RET);

        // 逐 8 字节字拷贝旧 kv（count*2 个字）：V1=旧 props_ptr, S5=新 props_ptr
        vm.load(VReg.V1, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.movImm(VReg.V2, 0); // 已拷字数
        vm.shl(VReg.V4, VReg.S3, 1); // 总字数 = count*2
        vm.label("_object_set_grow_copy");
        vm.cmp(VReg.V2, VReg.V4);
        vm.jge("_object_set_grow_copied");
        vm.shl(VReg.V0, VReg.V2, 3); // 字偏移 = idx*8
        vm.add(VReg.A0, VReg.V1, VReg.V0);
        vm.load(VReg.A1, VReg.A0, 0);
        vm.add(VReg.A0, VReg.S5, VReg.V0);
        vm.store(VReg.A0, 0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_object_set_grow_copy");
        vm.label("_object_set_grow_copied");
        // 更新 props_ptr（capacity 已在 _alloc 前写入；对象头地址不变）
        vm.store(VReg.S0, OBJECT_PROPS_PTR_OFFSET, VReg.S5);
        // [#61 P2] flags 块镜像 props 增长(仅当已 materialize)。普通对象 flags_ptr=0
        // 一条 cmp 即跳过,免调用(近零税)。materialize 过的才进 _object_grow_flags
        // (框架式 helper,保存自用 S 寄存器,调用方 S0-S5 不受扰)。S0=obj(raw)、
        // S3=旧 count(尚未 ++);capacity@24 已是 newcap。
        vm.load(VReg.V0, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_have_room");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_object_grow_flags");

        vm.label("_object_set_have_room");
        // [A2] 新增键:键集合改变,形状失效置 0(更新已有键不经此路;字面量/类
        // 构造期的字段追加发生在赋形状之前,置 0 无害)。
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.S0, OBJECT_SHAPE_OFFSET, VReg.V0);
        // 追加新属性：地址 = props_ptr + count*16
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        // 存储 key / value
        vm.store(VReg.V0, 0, VReg.S1);
        vm.store(VReg.V0, 8, VReg.S2);
        // 更新 count
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.store(VReg.S0, 8, VReg.S3);

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ===== Proxy set 陷阱(冷分支;S0=裸 proxy, S1=键, S2=值)=====
        vm.label("_object_set_proxy");
        vm.load(VReg.S3, VReg.S0, 8);   // target(装箱)
        vm.load(VReg.S4, VReg.S0, 16);  // handler(装箱)
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.S5, VReg.S0, VReg.V1); // receiver = 装箱 proxy
        // handler.set:
        vm.mov(VReg.A0, VReg.S4);
        vm.lea(VReg.A1, this.vm.asm.addString("set"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");         // RET = handler.set
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jne("_object_set_proxy_fwd");
        // 调 set(target, key, value, receiver);闭包/裸函数分派(S0=闭包环境, this=handler)
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V2, VReg.RET, VReg.V1); // 脱壳 fn 指针
        vm.load(VReg.V0, VReg.V2, 0);       // magic
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_object_set_proxy_bare");
        vm.mov(VReg.V3, VReg.V2);           // 闭包对象
        vm.load(VReg.V2, VReg.V2, 8);       // 真函数指针
        vm.jmp("_object_set_proxy_call");
        vm.label("_object_set_proxy_bare");
        vm.movImm(VReg.V3, 0);              // 裸函数无闭包
        vm.label("_object_set_proxy_call");
        vm.mov(VReg.A0, VReg.S3);           // target
        vm.mov(VReg.A1, VReg.S1);           // key
        vm.mov(VReg.A2, VReg.S2);           // value
        vm.mov(VReg.A3, VReg.S5);           // receiver
        vm.mov(VReg.A5, VReg.S4);           // this = handler
        vm.mov(VReg.S0, VReg.V3);           // S0 = 闭包环境(proxy 指针已不需)
        vm.setCallArgcImm(4, VReg.V0, VReg.V1); // [argc ABI] set(target,key,value,receiver)
        vm.callIndirect(VReg.V2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_object_set_proxy_fwd");
        // 无 set 陷阱 → 转发 target
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // [#39] 计算键规范化:数值键 → 十进制字符串(node 语义:对象键恒为字符串,
    // o[1] ≡ o["1"])。修前数值键按 NaN-box 位原样存键槽,_object_key_eq 的
    // payload-mask 快路把所有小整数 double(低 48 位全 0 → payload 同为 0)判成
    // 同一键 → 不同数值键读写塌到同一槽(RegExp shim m[g] 塌槽的根因);且与
    // 字符串键 o["1"] 永不相等,双重违反 ES 语义。
    // _js_prop_key(key) -> 规范化键(JSValue)
    //   - 0x7FFC 字符串:原样直通(驻留指针相等快路不受影响)
    //   - 0x7FF8 装箱 int32:payload 低 32 位符号扩展 → _intToStr
    //     (NaN 位与装箱 int 0 同构,按既有 gen1 语义并入 "0")
    //   - 高 16 位 == 0:>= ptrFloor 是遗留裸指针键,原样;否则小裸整数 → _intToStr
    //   - 其余 double 位:整数值(fcvtzs/scvtf 位往返一致)→ _intToStr,
    //     -0.0 并入 "0";非整 → _floatToString(如 o[1.5] → "1.5")
    //   - 0x7FF9-0x7FFB / 0x7FFD-0x7FFF(bool/null/undef/obj/arr/fn):维持原样(既有语义)
    // 寄存器契约:保 S0-S4(自身只用 S0;_intToStr 保 S0-S4、_floatToString 保
    // S0-S5),S5 不保证(_intToStr 内 _alloc 可冲 S5)。scratch 限 V0/V1/V3/V4。
    generateJsPropKey() {
        const vm = this.vm;

        vm.label("_js_prop_key");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC); // 字符串键:直通
        vm.jeq("_jpk_asis");
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_jpk_low"); // 低于 tag 区:raw(高16=0) 或正 double
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jeq("_jpk_int32"); // 装箱 int32
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jgt("_jpk_double"); // > 0x7FFF:负 double(符号位)
        // 0x7FF9-0x7FFB / 0x7FFD-0x7FFF:原样
        vm.label("_jpk_asis");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_low");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_jpk_double"); // 指数非 0 的正 double
        // raw:>= ptrFloor 是指针(遗留裸键),原样;否则小裸整数
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_jpk_asis");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_intToStr");
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_int32");
        // payload 低 32 位符号扩展(payload 语义为 32 位有符号整数)
        vm.shlImm(VReg.V3, VReg.S0, 32);
        vm.sarImm(VReg.V3, VReg.V3, 32);
        vm.mov(VReg.A0, VReg.V3);
        vm.call("_intToStr");
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_double");
        // -0.0(位 0x8000000000000000)并入 "0"(node: o[-0] 键为 "0")
        vm.movImm64(VReg.V1, 0x8000000000000000n);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jeq("_jpk_zero");
        // 位往返判别整数值:fcvtzs 截断 → scvtf 回转 → 位一致即整数
        vm.fmovToFloat(0, VReg.S0);
        vm.fcvtzs(VReg.V3, 0);
        vm.scvtf(0, VReg.V3);
        vm.fmovToInt(VReg.V4, 0);
        vm.cmp(VReg.V4, VReg.S0);
        vm.jne("_jpk_float");
        vm.mov(VReg.A0, VReg.V3);
        vm.call("_intToStr");
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_zero");
        vm.movImm(VReg.A0, 0);
        vm.call("_intToStr");
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_float");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_floatToString");
        vm.epilogue([VReg.S0], 0);
    }

    // _object_key_eq(key1_jsvalue, key2_jsvalue) -> 0/1
    // 比较两个属性键是否相等。
    // 快速路径: payload（去 NaN-box 标签后的指针）相同——字符串常量是驻留的，
    // 同一字面量必然同地址。
    // 慢速路径: 用 _getStrContent 把两个键都解析成内容指针（自动处理
    // 装箱/数据段/堆字符串三种形态），再 _strcmp 逐字节比较。
    // (旧实现把绝对地址当 [0,0x100000) 偏移判断数据段，全部落入按堆字符串
    //  布局比较垃圾"长度"的分支，会随数据段布局漂移产生键假匹配。)
    generateObjectKeyEq() {
        const vm = this.vm;
        vm.label("_object_key_eq");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // key1 (JSValue)
        vm.mov(VReg.S1, VReg.A1); // key2 (JSValue)

        // 快速路径: payload 相同
        vm.movImm64(VReg.V0, JS_PAYLOAD_MASK);
        vm.and(VReg.S2, VReg.S0, VReg.V0);
        vm.and(VReg.S3, VReg.S1, VReg.V0);
        vm.cmp(VReg.S2, VReg.S3);
        vm.jeq("_object_key_eq_true");

        // 慢速路径: 解析内容指针后逐字节比较
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S3, VReg.RET);

        // 双方都解析失败（_getStrContent 对非法输入返回 _str_empty）时
        // 不视为相等，避免非字符串键假匹配
        vm.lea(VReg.V0, "_str_empty");
        vm.cmp(VReg.S2, VReg.V0);
        vm.jne("_object_key_eq_cmp");
        vm.cmp(VReg.S3, VReg.V0);
        vm.jeq("_object_key_eq_false");

        vm.label("_object_key_eq_cmp");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_key_eq_false");

        vm.label("_object_key_eq_true");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_object_key_eq_false");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // 检查对象是否有指定属性（不检查原型链）
    // _object_has(obj, key) -> 0/1
    generateObjectHas() {
        const vm = this.vm;

        vm.label("_object_has");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // obj
        vm.mov(VReg.S1, VReg.A1); // key

        // [#39] hasOwnProperty(k) 数值键规范化(字符串键 tag 判别直通)
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_object_has_key_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_object_has_key_ok");

        // 类型标签守卫:仅对象(0x7FFD)/数组(0x7FFE)/裸堆指针(高16=0)才查属性;
        // 数字/布尔等非容器返回 0(否则脱壳成垃圾地址解引用崩,如 with(非对象) / 误用 hasOwn)。
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_has_tagok");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_object_has_tagok");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_object_has_tagok");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_object_has_tagok");

        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_has_false");

        // 数组(TYPE_ARRAY=1):数值键界内判定(同 _prop_in),对象块布局在数组上
        // 读 props_ptr@32 越界崩(`Object.hasOwn([...],0)`/`arr.hasOwnProperty(0)` 崩根因)。
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jeq("_object_has_idx");
        // TypedArray(0x40-0x7f):[type@0, length@8, 内联元素数据@16],无 props_ptr@32。
        // 按对象头遍历会把 length@8 当 count、把内联元素数据当 props_ptr 读,再把元素
        // **值**当键指针解引用 → 崩(crash PC _object_has_loop+0x18;实证故障地址
        // 0x4044800000000000 就是 float64 41.0 被当地址)。length@8 与数组同语义,故数值键
        // 复用同一 atoi 界内判定:`ta.hasOwnProperty("0")` → true、`("9")`/`("foo")` → false。
        vm.cmpImm(VReg.V0, TYPE_TA_LO);
        vm.jlt("_object_has_notta");
        vm.cmpImm(VReg.V0, TYPE_TA_HI);
        vm.jle("_object_has_idx");
        vm.label("_object_has_notta");
        // 其余非属性容器块(Map/Set/ArrayBuffer/DataView/Symbol):布局与 [count@8, props_ptr@32]
        // 不兼容,按对象头遍历同样解引用垃圾。规范语义是"无此自有属性" → false,不抛。
        // (黑名单与 _object_get 的类型字节守卫逐项取齐,使 has 与 get 语义一致。)
        vm.cmpImm(VReg.V0, TYPE_MAP);
        vm.jeq("_object_has_false");
        vm.cmpImm(VReg.V0, TYPE_SET);
        vm.jeq("_object_has_false");
        vm.cmpImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.jeq("_object_has_false");
        vm.cmpImm(VReg.V0, TYPE_DATA_VIEW);
        vm.jeq("_object_has_false");
        vm.cmpImm(VReg.V0, TYPE_SYMBOL);
        vm.jeq("_object_has_false");
        vm.jmp("_object_has_obj");

        vm.label("_object_has_idx");
        vm.mov(VReg.A0, VReg.S1); // 规范化键(装箱串)→ 内容指针 atoi
        vm.call("_getStrContent");
        vm.mov(VReg.V2, VReg.RET); // 游标
        vm.movImm(VReg.V3, 0);     // idx
        vm.movImm(VReg.S3, 0);     // sawDigit
        vm.label("_object_has_arr_atoi");
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_has_arr_done");
        vm.cmpImm(VReg.V0, 48); // '0'
        vm.jlt("_object_has_false");
        vm.cmpImm(VReg.V0, 57); // '9'
        vm.jgt("_object_has_false");
        vm.subImm(VReg.V0, VReg.V0, 48);
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.V3, VReg.V3, VReg.V1);
        vm.add(VReg.V3, VReg.V3, VReg.V0);
        vm.movImm(VReg.S3, 1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_object_has_arr_atoi");
        vm.label("_object_has_arr_done");
        vm.cmpImm(VReg.S3, 0); // 空/非数字键(含 "length")→ false(记偏差)
        vm.jeq("_object_has_false");
        vm.load(VReg.S2, VReg.S0, 8); // length @ +8
        vm.cmp(VReg.V3, VReg.S2);
        vm.jlt("_object_has_true");
        vm.jmp("_object_has_false");

        vm.label("_object_has_obj");
        vm.load(VReg.S2, VReg.S0, 8); // count
        vm.movImm(VReg.S3, 0);

        vm.label("_object_has_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_object_has_false");

        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);

        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");

        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_has_true");

        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_has_loop");

        vm.label("_object_has_true");
        vm.movImm(VReg.RET, 1);
        // [#35] 存量帧失衡:prologue 为 32 而此处原写 16 → SP 错位,命中 true
        // 即栈损坏(hasOwn/hasOwnProperty 返回 true 的场景挂死/崩溃)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_object_has_false");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // 检查属性是否在对象中（包含原型链检查）
    // _prop_in(obj, key) -> 0/1
    // 用于实现 JavaScript 的 "in" 运算符
    generatePropIn() {
        const vm = this.vm;

        vm.label("_prop_in");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // obj
        vm.mov(VReg.S1, VReg.A1); // key
        
        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        // 检查 obj 是否为 null
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_prop_in_false");

        // [in] 数组(TYPE_ARRAY=1):数值键界内判定 `"i" in arr ≡ 0<=i<length`。
        // 数组块布局 length@8、无 props_ptr;走对象路径会把 length 当 count、把
        // cap/data_ptr 当 props 读 → 崩(`"0" in [...]` SIGSEGV 根因)。先按类型字节分流。
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY); // Proxy:冷分支调 handler.has
        vm.jeq("_prop_in_proxy");
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jeq("_prop_in_idx");
        // TypedArray(0x40-0x7f):同数组按 length@8 界内判定(`"0" in ta` → true)。走对象路径会把
        // 内联元素数据当 props 读、把元素值当键指针解引用 → 崩。与 _object_has 同源守卫。
        vm.cmpImm(VReg.V0, TYPE_TA_LO);
        vm.jlt("_prop_in_notta");
        vm.cmpImm(VReg.V0, TYPE_TA_HI);
        vm.jle("_prop_in_idx");
        vm.label("_prop_in_notta");
        // 其余非属性容器块(Map/Set/ArrayBuffer/DataView/Symbol)→ false(不抛),
        // 黑名单与 _object_get / _object_has 逐项取齐。
        vm.cmpImm(VReg.V0, TYPE_MAP);
        vm.jeq("_prop_in_false");
        vm.cmpImm(VReg.V0, TYPE_SET);
        vm.jeq("_prop_in_false");
        vm.cmpImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.jeq("_prop_in_false");
        vm.cmpImm(VReg.V0, TYPE_DATA_VIEW);
        vm.jeq("_prop_in_false");
        vm.cmpImm(VReg.V0, TYPE_SYMBOL);
        vm.jeq("_prop_in_false");
        vm.jmp("_prop_in_obj");

        vm.label("_prop_in_idx");
        // atoi(key content ptr = S1):全数字键 → idx;否则(含 "length")→ false(记偏差)。
        vm.mov(VReg.V2, VReg.S1); // 游标
        vm.movImm(VReg.V3, 0);    // idx 累加
        vm.movImm(VReg.S3, 0);    // 见到数字标志
        vm.label("_prop_in_arr_atoi");
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_prop_in_arr_done");
        vm.cmpImm(VReg.V0, 48); // '0'
        vm.jlt("_prop_in_false");
        vm.cmpImm(VReg.V0, 57); // '9'
        vm.jgt("_prop_in_false");
        vm.subImm(VReg.V0, VReg.V0, 48);
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.V3, VReg.V3, VReg.V1);
        vm.add(VReg.V3, VReg.V3, VReg.V0);
        vm.movImm(VReg.S3, 1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_prop_in_arr_atoi");
        vm.label("_prop_in_arr_done");
        vm.cmpImm(VReg.S3, 0);   // 空键 "" → false
        vm.jeq("_prop_in_false");
        vm.load(VReg.S2, VReg.S0, 8); // length @ block+8
        vm.cmp(VReg.V3, VReg.S2);
        vm.jlt("_prop_in_true");
        vm.jmp("_prop_in_false");
        vm.label("_prop_in_obj");

        vm.load(VReg.S2, VReg.S0, 8); // count
        vm.movImm(VReg.S3, 0);

        vm.label("_prop_in_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_prop_in_check_proto");

        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);

        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");

        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_true");

        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_prop_in_loop");

        // 在原型链上查找
        vm.label("_prop_in_check_proto");
        vm.load(VReg.V0, VReg.S0, 16); // __proto__
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_prop_in_false");
        // 递归查找原型
        vm.mov(VReg.A0, VReg.V0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_prop_in");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        vm.label("_prop_in_true");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        vm.label("_prop_in_false");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // ===== Proxy has 陷阱(冷分支;S0=裸 proxy, S1=键 content 指针)=====
        vm.label("_prop_in_proxy");
        vm.load(VReg.S2, VReg.S0, 8);   // target(装箱)
        vm.load(VReg.S3, VReg.S0, 16);  // handler(装箱)
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("has"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");         // RET = handler.has
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jne("_prop_in_proxy_fwd");
        // 调 has(target, key);_aref_invoke_cb 分派(this=undefined)
        vm.mov(VReg.A3, VReg.RET);      // callback
        vm.mov(VReg.A0, VReg.S2);       // target
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S1, VReg.V1); // 装箱键(content→string)
        vm.lea(VReg.A2, "_js_undefined");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.call("_aref_invoke_cb");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.andImm(VReg.RET, VReg.RET, 1); // 裸 0/1
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_prop_in_proxy_fwd");
        // 无 has 陷阱 → 转发 (key in target),原型链感知
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_js_unbox");           // target 裸指针
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);       // content 指针(未改)
        vm.call("_prop_in");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
    }

    // Object.keys(obj) -> 返回包含所有键的数组
    // _object_keys(obj) -> array
    generateObjectKeys() {
        const vm = this.vm;

        vm.label("_object_keys");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        // [test262 S1] 类型分派(消 CRASH):非对象目标按规范处理,绝不按 plain 布局解引用
        // count@8/props_ptr(此前 null/数值/数组/串脱壳后读 [垃圾+0] → SIGSEGV)。
        // null/undefined → TypeError;array/string → 索引键 ["0",...];int/bool → 空数组;
        // object(0x7FFD)/function(0x7FFF)/裸指针(classinfo)→ 原路径。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_keys_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_keys_nullish");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_keys_indexed");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_keys_indexed_str");
        // number/bool → 空数组。注意 number 大多是**裸 float 位**(5.0 → high16=0x4014),
        // 不是 0x7FF8 装箱 int——旧"复用空数组路径破坏堆"实为 float 未被分派、掉进 legacy
        // 解引用踩内存(空数组路径本身无辜,bool 实测干净)。判别:0x7FF8(装箱 int/NaN 别名)
        // /0x7FF9(bool)→ 空;0x7FFD(对象)/0x7FFF(函数)→ 原路径;其余 high16≠0 → 裸
        // float → 空;high16==0 且全零 → float +0.0 → 空;high16==0 且非零 → 裸堆指针
        // (Map/Set/classinfo/Symbol)→ 原路径。
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_object_keys_empty");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_object_keys_empty");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_keys_legacy");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_keys_legacy");
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_keys_empty"); // 其余非零 high16 = 裸 float
        vm.cmpImm(VReg.A0, 0); vm.jeq("_object_keys_empty"); // 全零 = +0.0
        vm.label("_object_keys_legacy");

        vm.mov(VReg.S0, VReg.A0); // obj

        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        // Proxy(type=8):有 ownKeys 陷阱 → handler.ownKeys(target) 的键数组;否则转发
        // target 的键(count@8 是 target 指针,不转发会当 count 迭代垃圾崩)。**偏差**:
        // Object.keys 严格应按 getOwnPropertyDescriptor 过滤 enumerable,此处返陷阱全量键
        // (Reflect.ownKeys/getOwnPropertyNames 语义;enumerable 过滤 + 不变式检查推迟)。
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jne("_object_keys_np");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, this.vm.asm.addString("ownKeys"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_proxy_fwd");
        vm.mov(VReg.S1, VReg.RET); // 陷阱函数
        vm.load(VReg.A0, VReg.S0, 8); // target
        vm.lea(VReg.A1, "_js_undefined");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.mov(VReg.A2, VReg.A1);
        vm.mov(VReg.A3, VReg.S1);
        vm.call("_aref_invoke_cb"); // RET = 键数组
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_object_keys_proxy_fwd");
        vm.load(VReg.A0, VReg.S0, 8); // target(装箱)
        vm.call("_object_keys");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_object_keys_np");

        // [enum-order] 枚举前归一到 ES 规范序(整数键升序在前)。S0 保活(归一保 S0-S5)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_normalize_order");

        // 获取属性数量
        vm.load(VReg.S1, VReg.S0, 8); // count

        // 结果数组:只收**可枚举**键 → 用 push(长度随枚举结果,不预分配 count)。
        // [#61 P3] 跳过 enumerable:false(defineProperty)属性;flags_ptr@40==0 → 全默认
        // 可枚举(自举对象恒此路,结果与旧 presize+set 逐元素一致)。
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET); // result array(裸头,push 更新)

        // 遍历属性
        vm.movImm(VReg.S3, 0); // index

        vm.label("_object_keys_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_object_keys_done");

        // 可枚举判别:flags_ptr==0 → 收;否则 flags[idx]&ATTR_ENUMERABLE==0 → 跳过
        vm.load(VReg.V2, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_keys_take");
        vm.add(VReg.V2, VReg.V2, VReg.S3);
        vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.movImm(VReg.V0, ATTR_ENUMERABLE);
        vm.and(VReg.V2, VReg.V2, VReg.V0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_keys_next"); // 不可枚举 → 跳过

        vm.label("_object_keys_take");
        // 获取 key
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.S4, VReg.V0, 0); // key -> S4 保存

        // classinfo(类对象,低字节 type==3)排除:内部槽 __ctor__/prototype(idx 0,1)与
        // 静态方法(值为 function tag 0x7FFF,node 里类方法不可枚举);静态数据字段保留。
        // 普通对象(非 3)不受影响(单 loadByte+cmp)。**偏差**:函数值静态字段(如
        // static h=()=>{})会被当方法排除。
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_object_keys_ci_ok");
        vm.cmpImm(VReg.S3, 2);
        vm.jlt("_object_keys_next"); // __ctor__/prototype
        vm.load(VReg.V1, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.V1, VReg.V1, 8); // value
        vm.shrImm(VReg.V1, VReg.V1, 48);
        vm.cmpImm(VReg.V1, 0x7FFF); // function → 方法,跳过
        vm.jeq("_object_keys_next");
        vm.label("_object_keys_ci_ok");

        // symbol 键排除:Object.keys/values/entries/for-in 不含 symbol 键
        // (symbol 键属 getOwnPropertySymbols)。_is_symbol 保存 S0-S4。
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_keys_next");

        // push 到结果数组
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);

        vm.label("_object_keys_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_keys_loop");

        vm.label("_object_keys_done");
        // 装箱为 0x7FFE 数组 JSValue(_array_new_with_size 返回裸头,不装箱则
        // console.log/JSON.stringify 把裸头高16==0 当对象 → "[object Object]"/0)。
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // ---- [test262 S1] 非对象目标分派处理(入口 high16 分派跳入)----
        // null/undefined → TypeError(ToObject 规范)
        vm.label("_object_keys_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        // number/bool → 空数组(S1=0 走通用索引键构建,即空结果)
        vm.label("_object_keys_empty");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_object_keys_idx_build");

        // array → 索引键 ["0",...,"len-1"]
        vm.label("_object_keys_indexed");
        vm.call("_array_length"); // A0=boxed array → RET=length
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_object_keys_idx_build");
        // string → 索引键(字节长;ASCII = 字符数,非 ASCII 见 UTF-8 偏差)
        vm.label("_object_keys_indexed_str");
        vm.call("_strlen"); // A0=boxed string → RET=byte length
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_object_keys_idx_build");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size"); // 裸结果数组
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0); // i
        vm.label("_object_keys_idx_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_keys_idx_done");
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0); // A0 = i 的 float64 位
        vm.call("_valueToStr"); // RET = boxed 字符串键
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_keys_idx_loop");
        vm.label("_object_keys_idx_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // Object.getOwnPropertyNames(obj) -> array
    // _object_gopn(obj) -> array
    // [test262 S1] 与 _object_keys 的差异仅在 array/string:索引键之外还含 "length"
    // (node: gOPN([a,b]) = ['0','1','length'],gOPN('ab') = ['0','1','length'])。
    // null/undefined → TypeError;对象/函数/裸指针/原语 → 委托 _object_keys
    // (简化模型:所有自有键皆可枚举,gOPN ≡ keys,保持既有近似)。
    generateObjectGetOwnPropertyNames() {
        const vm = this.vm;

        vm.label("_object_gopn");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_gopn_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_gopn_nullish");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_gopn_arr");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_gopn_str");
        vm.call("_object_keys");        // 其余形态:委托(A0 未动)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // null/undefined → TypeError(ToObject 规范)
        vm.label("_object_gopn_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        vm.label("_object_gopn_arr");
        vm.call("_array_length");       // A0=boxed array → RET=length
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_object_gopn_build");
        vm.label("_object_gopn_str");
        vm.call("_strlen");             // A0=boxed string → RET=byte length
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_object_gopn_build");
        // 索引键 ["0",...,"len-1"](同 _object_keys_idx_build)+ 末尾 "length"
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);      // 裸结果数组
        vm.movImm(VReg.S3, 0);          // i
        vm.label("_object_gopn_idx_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_gopn_idx_done");
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0); // A0 = i 的 float64 位
        vm.call("_valueToStr");         // RET = boxed 字符串键
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_gopn_idx_loop");
        vm.label("_object_gopn_idx_done");
        // + "length"(数据段字面量拷进堆并装箱)
        vm.lea(VReg.A0, vm.asm.addString("length"));
        vm.call("_cstr_to_heap_str");   // RET = boxed 堆串
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // Object.prototype.toString.call(x) -> "[object Tag]"(品牌串)。tag 依 x 类型;
    // 对象若有 [Symbol.toStringTag](字符串)则用之。覆盖 node 常见 tag。
    generateObjectProtoToString() {
        const vm = this.vm;
        const ret = (label, s) => { // 分支:A0=数据串标签 → 复制成堆串返回
            vm.label(label);
            vm.lea(VReg.A0, vm.asm.addString(s));
            vm.call("_cstr_to_heap_str");
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        };
        vm.label("_object_proto_toString");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_opts_undef");
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_opts_null");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_opts_array");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_opts_string");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_opts_bool");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_opts_func");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_opts_obj");
        vm.cmpImm(VReg.V0, 0); vm.jeq("_opts_obj"); // 裸堆指针(Map/Set/RegExp/Symbol)
        vm.jmp("_opts_number"); // 装箱 int(0x7FF8)/裸 float → Number

        vm.label("_opts_obj");
        // 脱壳 + 堆界守卫
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.S1, VReg.S0, VReg.V1);
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jlt("_opts_plain");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1); vm.jge("_opts_plain");
        {
            // 非属性堆对象(Date/Promise/TypedArray/ArrayBuffer/DataView/BigInt/Symbol)
            // 按精确判别短路。全平台发射:native 上此前直接落 _object_get/_object_has 探测,
            // 对 TypedArray/ArrayBuffer(头布局非对象)解引 props_ptr 走野指针 → 段错误
            // (Object.prototype.toString.call(new Uint8Array) 崩根因)。wasm 亦同(OOB trap)。
            // BigInt/Symbol 是裸堆指针,头布局与普通对象不同(BigInt 类型字节在
            // [ptr-16]、[ptr+0] 是 64 位值;Symbol 用户区)。绝不能按 [S1+0] 类型字节
            // 判——否则 66n 的值低字节 0x42 会被误当 Int32Array。先用既有精确 helper
            // 判别(与 typeof/算术同源,可靠),命中即短路。
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_is_bigint");
            vm.cmpImm(VReg.RET, 0); vm.jne("_opts_bigint");
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_is_symbol");
            vm.cmpImm(VReg.RET, 0); vm.jne("_opts_symbol");
            // 其余非属性堆对象按类型字节([S1+0])短路。
            vm.loadByte(VReg.V0, VReg.S1, 0);
            vm.andImm(VReg.V0, VReg.V0, 0xff);
            vm.cmpImm(VReg.V0, 7); vm.jeq("_opts_date");        // TYPE_DATE
            vm.cmpImm(VReg.V0, 11); vm.jeq("_opts_promise");    // TYPE_PROMISE
            // TypedArray(0x40-0x61)/ArrayBuffer(12)/DataView(14)
            vm.cmpImm(VReg.V0, 0x40); vm.jeq("_opts_int8array");
            vm.cmpImm(VReg.V0, 0x41); vm.jeq("_opts_int16array");
            vm.cmpImm(VReg.V0, 0x42); vm.jeq("_opts_int32array");
            vm.cmpImm(VReg.V0, 0x43); vm.jeq("_opts_bigint64array");
            vm.cmpImm(VReg.V0, 0x50); vm.jeq("_opts_uint8array");
            vm.cmpImm(VReg.V0, 0x51); vm.jeq("_opts_uint16array");
            vm.cmpImm(VReg.V0, 0x52); vm.jeq("_opts_uint32array");
            vm.cmpImm(VReg.V0, 0x53); vm.jeq("_opts_biguint64array");
            vm.cmpImm(VReg.V0, 0x54); vm.jeq("_opts_uint8clampedarray");
            vm.cmpImm(VReg.V0, 0x60); vm.jeq("_opts_float32array");
            vm.cmpImm(VReg.V0, 0x61); vm.jeq("_opts_float64array");
            vm.cmpImm(VReg.V0, 12); vm.jeq("_opts_arraybuffer"); // TYPE_ARRAY_BUFFER
            vm.cmpImm(VReg.V0, 14); vm.jeq("_opts_dataview");    // TYPE_DATA_VIEW
            // Generator/AsyncGenerator 对象:协程实现,是普通对象(TYPE_OBJECT=2,无独立
            // 类型字节)但携内部槽 "__gen_coro"(_generator_new/_async_generator_new 恒置)。
            // 该槽是可靠判别式;命中则按是否含 "Symbol.asyncIterator"(仅 async 生成器置)
            // 区分 AsyncGenerator。仅 wasi 发射,native 发射序不变。
            vm.cmpImm(VReg.V0, 2); vm.jne("_opts_notgen"); // 仅普通对象可能是生成器
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString("__gen_coro"));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
            vm.call("_object_has");
            vm.cmpImm(VReg.RET, 0); vm.jeq("_opts_notgen");
            // 生成器对象:async?(含 Symbol.asyncIterator → AsyncGenerator)
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString("Symbol.asyncIterator"));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
            vm.call("_object_has");
            vm.cmpImm(VReg.RET, 0); vm.jne("_opts_asyncgenerator");
            vm.jmp("_opts_generator");
            vm.label("_opts_notgen");
        }
        // [Symbol.toStringTag] 优先(字符串则 "[object <tag>]")
        vm.lea(VReg.A0, "_symwk_toStringTag");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); // toStringTag 是字符串?
        vm.jeq("_opts_custom");
        // 内建品牌:按类型字节
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 7); vm.jeq("_opts_date");   // TYPE_DATE
        vm.cmpImm(VReg.V0, 4); vm.jeq("_opts_maybe_weakmap"); // TYPE_MAP(含 WeakMap)
        vm.cmpImm(VReg.V0, 5); vm.jeq("_opts_maybe_weakset"); // TYPE_SET(含 WeakSet)
        // Error 品牌(__asmjs_err)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_asmjs_err");
        vm.cmpImm(VReg.RET, 0); vm.jne("_opts_error");
        // RegExp shim 对象(__isRegExp 属性)
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__isRegExp"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0); vm.jne("_opts_regexp");
        vm.jmp("_opts_plain"); // 其余 → Object

        // custom:"[object " + tag + "]"
        vm.label("_opts_custom");
        vm.lea(VReg.A0, vm.asm.addString("[object "));
        vm.call("_cstr_to_heap_str");
        vm.mov(VReg.A1, VReg.S2); // tag
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strconcat");
        vm.lea(VReg.A1, vm.asm.addString("]"));
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.A1, VReg.A1, VReg.V0);
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_strconcat");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        ret("_opts_undef", "[object Undefined]");
        ret("_opts_null", "[object Null]");
        ret("_opts_array", "[object Array]");
        ret("_opts_string", "[object String]");
        ret("_opts_bool", "[object Boolean]");
        // 函数品牌:查 code_ptr→kind 侧表区分 Generator/Async/AsyncGenerator 函数。
        // S0 = 函数 JSValue(tag 0x7fff);脱壳得闭包/裸函数指针 P。闭包(magic 0xc105/0xa51c)
        // 的真 code_ptr 在 [P+8];裸函数指针 code_ptr = P。_func_meta_find 返回 kind。
        vm.label("_opts_func");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);          // V0 = P
        vm.load(VReg.V1, VReg.V0, 0);               // V1 = [P](闭包 magic 或代码字节)
        vm.cmpImm(VReg.V1, 0xc105); vm.jeq("_opts_func_clo");
        vm.cmpImm(VReg.V1, 0xa51c); vm.jeq("_opts_func_clo");
        vm.mov(VReg.A0, VReg.V0);                   // 裸函数指针:code_ptr = P
        vm.jmp("_opts_func_lk");
        vm.label("_opts_func_clo");
        vm.load(VReg.A0, VReg.V0, 8);               // 闭包:code_ptr = [P+8]
        vm.label("_opts_func_lk");
        vm.call("_func_meta_find");                 // RET = kind
        vm.cmpImm(VReg.RET, 1); vm.jeq("_opts_genfunc");
        vm.cmpImm(VReg.RET, 2); vm.jeq("_opts_asyncfunc");
        vm.cmpImm(VReg.RET, 3); vm.jeq("_opts_asyncgenfunc");
        vm.lea(VReg.A0, vm.asm.addString("[object Function]"));
        vm.call("_cstr_to_heap_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        ret("_opts_genfunc", "[object GeneratorFunction]");
        ret("_opts_asyncfunc", "[object AsyncFunction]");
        ret("_opts_asyncgenfunc", "[object AsyncGeneratorFunction]");
        ret("_opts_number", "[object Number]");
        ret("_opts_date", "[object Date]");
        // Map/Set 头 +48 = weakness 标志(WeakMap/WeakSet 置 1)。S1 = 裸集合指针(type@0)。
        vm.label("_opts_maybe_weakmap");
        vm.load(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0); vm.jne("_opts_weakmap");
        vm.jmp("_opts_map");
        vm.label("_opts_maybe_weakset");
        vm.load(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0); vm.jne("_opts_weakset");
        vm.jmp("_opts_set");
        ret("_opts_map", "[object Map]");
        ret("_opts_set", "[object Set]");
        ret("_opts_weakmap", "[object WeakMap]");
        ret("_opts_weakset", "[object WeakSet]");
        ret("_opts_error", "[object Error]");
        ret("_opts_regexp", "[object RegExp]");
        ret("_opts_plain", "[object Object]");
        {
            // TypedArray/ArrayBuffer/DataView/BigInt/Symbol/Promise 品牌返回(全平台)。
            ret("_opts_int8array", "[object Int8Array]");
            ret("_opts_int16array", "[object Int16Array]");
            ret("_opts_int32array", "[object Int32Array]");
            ret("_opts_bigint64array", "[object BigInt64Array]");
            ret("_opts_uint8array", "[object Uint8Array]");
            ret("_opts_uint16array", "[object Uint16Array]");
            ret("_opts_uint32array", "[object Uint32Array]");
            ret("_opts_biguint64array", "[object BigUint64Array]");
            ret("_opts_uint8clampedarray", "[object Uint8ClampedArray]");
            ret("_opts_float32array", "[object Float32Array]");
            ret("_opts_float64array", "[object Float64Array]");
            ret("_opts_arraybuffer", "[object ArrayBuffer]");
            ret("_opts_dataview", "[object DataView]");
            ret("_opts_bigint", "[object BigInt]");
            ret("_opts_symbol", "[object Symbol]");
            ret("_opts_promise", "[object Promise]");
            ret("_opts_generator", "[object Generator]");
            ret("_opts_asyncgenerator", "[object AsyncGenerator]");
        }
    }

    // Object.getOwnPropertySymbols(obj) -> 仅 symbol 键数组(_object_keys 的反面:
    // 只收 symbol 键;可枚举与否不影响 symbol 键的收集)。
    generateObjectGetOwnPropertySymbols() {
        const vm = this.vm;
        vm.label("_object_getOwnPropertySymbols");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);
        vm.load(VReg.S1, VReg.S0, 8); // count
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0); // index
        vm.label("_ogops_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_ogops_done");
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.S4, VReg.V0, 0); // key
        // 只收 symbol 键:非 symbol → 跳过
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogops_next");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_ogops_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ogops_loop");
        vm.label("_ogops_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // Object.values(obj) -> 返回包含所有值的数组
    // _object_values(obj) -> array
    generateObjectValues() {
        const vm = this.vm;

        vm.label("_object_values");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        // [test262 S1] 类型分派(消 CRASH,判别逻辑详注见 _object_keys):null/undefined
        // → TypeError;array → 元素值副本;string → 单字符串数组;number(裸 float/装箱
        // int)/bool → 空数组;对象/函数/裸堆指针 → 原路径。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_values_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_values_nullish");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_values_indexed");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_values_indexed_str");
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_object_values_empty");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_object_values_empty");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_values_legacy");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_values_legacy");
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_values_empty");
        vm.cmpImm(VReg.A0, 0); vm.jeq("_object_values_empty");
        vm.label("_object_values_legacy");

        vm.mov(VReg.S0, VReg.A0); // obj

        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        // Proxy:转发 target(同 _object_keys)
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jne("_object_values_np");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_object_values");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_object_values_np");
        vm.mov(VReg.A0, VReg.S0); // [enum-order] 归一
        vm.call("_object_normalize_order");
        vm.load(VReg.S1, VReg.S0, 8); // count

        // [#61 P3] 只收可枚举属性值 → push(长度随枚举结果)。flags_ptr==0 → 全默认可枚举。
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);

        vm.movImm(VReg.S3, 0);

        vm.label("_object_values_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_object_values_done");

        // 可枚举判别
        vm.load(VReg.V2, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_values_take");
        vm.add(VReg.V2, VReg.V2, VReg.S3);
        vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.movImm(VReg.V0, ATTR_ENUMERABLE);
        vm.and(VReg.V2, VReg.V2, VReg.V0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_values_next");

        vm.label("_object_values_take");
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.S4, VReg.V0, 8); // value -> S4
        // classinfo 排除:内部槽 idx<2 与方法(值为 function)。普通对象不受影响。
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_object_values_ci_ok");
        vm.cmpImm(VReg.S3, 2);
        vm.jlt("_object_values_next");
        vm.shrImm(VReg.V1, VReg.S4, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_object_values_next");
        vm.label("_object_values_ci_ok");
        // symbol 键排除:key=[propAddr+0];symbol → 跳过(S4 值经 _is_symbol 存活)
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_values_next");

        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);

        vm.label("_object_values_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_values_loop");

        vm.label("_object_values_done");
        // 装箱为 0x7FFE 数组 JSValue(同 _object_keys)。
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // ---- [test262 S1] 非对象目标分派处理(入口 high16 分派跳入)----
        // null/undefined → TypeError(ToObject 规范)
        vm.label("_object_values_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        // array → [a[0],...,a[len-1]] 浅拷贝(独立循环,活值只占 S0-S3,避 S4/S5 跨 _alloc)
        vm.label("_object_values_indexed");
        vm.mov(VReg.S0, VReg.A0);       // boxed array
        vm.call("_array_length");       // RET = length
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);      // 裸结果数组
        vm.movImm(VReg.S3, 0);          // i
        vm.label("_object_values_arr_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_values_idx_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");          // RET = boxed 元素(越界返 undefined,界内不触发)
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);      // A0 裸头 → 返回仍裸头
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_values_arr_loop");

        // string → ['c0','c1',...](字节长;ASCII = 字符数,非 ASCII 见 UTF-8 偏差)
        vm.label("_object_values_indexed_str");
        vm.mov(VReg.S0, VReg.A0);       // boxed string
        vm.call("_strlen");             // RET = byte length
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_object_values_str_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_values_idx_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_charAt");         // RET = boxed 单字符串
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_values_str_loop");

        vm.label("_object_values_idx_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // number/bool → 空数组(装箱)
        vm.label("_object_values_empty");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // Object.entries(obj) -> 返回 [[key, value], ...] 数组
    // _object_entries(obj) -> array
    generateObjectEntries() {
        const vm = this.vm;

        vm.label("_object_entries");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        // [test262 S1] 类型分派(消 CRASH,判别逻辑详注见 _object_keys):null/undefined
        // → TypeError;array → [['0',v0],...];string → [['0','c0'],...];number/bool →
        // 空数组;对象/函数/裸堆指针 → 原路径。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_entries_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_entries_nullish");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_entries_indexed");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_entries_indexed_str");
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_object_entries_empty");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_object_entries_empty");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_entries_legacy");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_entries_legacy");
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_entries_empty");
        vm.cmpImm(VReg.A0, 0); vm.jeq("_object_entries_empty");
        vm.label("_object_entries_legacy");

        vm.mov(VReg.S0, VReg.A0); // obj

        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        // Proxy:转发 target(同 _object_keys)
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jne("_object_entries_np");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_object_entries");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
        vm.label("_object_entries_np");
        vm.mov(VReg.A0, VReg.S0); // [enum-order] 归一
        vm.call("_object_normalize_order");
        vm.load(VReg.S1, VReg.S0, 8); // count

        // [#61 P3] 只收可枚举条目 → push(长度随枚举结果)。flags_ptr==0 → 全默认可枚举。
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);

        vm.movImm(VReg.S3, 0); // index

        vm.label("_object_entries_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_object_entries_done");

        // 可枚举判别:不可枚举 → 跳过
        vm.load(VReg.V2, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_entries_take");
        vm.add(VReg.V2, VReg.V2, VReg.S3);
        vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.movImm(VReg.V0, ATTR_ENUMERABLE);
        vm.and(VReg.V2, VReg.V2, VReg.V0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_entries_next");

        vm.label("_object_entries_take");
        // propAddr = props_ptr + index*16
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);

        // key/value
        vm.load(VReg.S4, VReg.V0, 0);
        vm.load(VReg.S5, VReg.V0, 8);

        // classinfo 排除:内部槽 idx<2 与方法(值 S5 为 function)。普通对象不受影响。
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_object_entries_ci_ok");
        vm.cmpImm(VReg.S3, 2);
        vm.jlt("_object_entries_next");
        vm.shrImm(VReg.V1, VReg.S5, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_object_entries_next");
        vm.label("_object_entries_ci_ok");

        // symbol 键排除:key(S4)是 symbol → 跳过(S5 值/SP 局部经 _is_symbol 存活)
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_entries_next");

        // pair = new Array(2)
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 0, VReg.RET);

        // pair[0] = key
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_array_set");

        // pair[1] = value
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 1);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_array_set");

        // result.push(pair)(内层 [k,v] 也装箱 0x7FFE,否则外层遍历读到裸头 →
        // 嵌套渲染成 "[object Object]"/0)
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);

        vm.label("_object_entries_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_entries_loop");

        vm.label("_object_entries_done");
        // 外层数组装箱(同 _object_keys/values)。
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // ---- [test262 S1] 非对象目标分派处理(入口 high16 分派跳入)----
        // null/undefined → TypeError(ToObject 规范)
        vm.label("_object_entries_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        // array → [['0',a[0]],...]。活值只占 S0-S3 + 栈槽(SP+0=pair 裸头),避 S4/S5 跨
        // _alloc(_alloc 只保 S0-S3);pair 先建再逐槽填,键/值均即取即存不跨分配调用。
        vm.label("_object_entries_indexed");
        vm.mov(VReg.S0, VReg.A0);       // boxed array
        vm.call("_array_length");       // RET = length
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);      // 裸结果数组
        vm.movImm(VReg.S3, 0);          // i
        vm.label("_object_entries_arr_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_entries_idx_done");
        // pair = new Array(2)(先建:后续键/值即取即存,无值跨分配)
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 0, VReg.RET);
        // pair[0] = String(i)(i=0 的 float 位 0x0 在 _valueToStr 走 raw-number 路 → "0",同 _object_keys)
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0);
        vm.call("_valueToStr");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_set");
        // pair[1] = a[i]
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 1);
        vm.call("_array_set");
        // result.push(box(pair))(内层同样装箱 0x7FFE,同对象路径)
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_entries_arr_loop");

        // string → [['0','c0'],...](字节长;ASCII = 字符数,非 ASCII 见 UTF-8 偏差)
        vm.label("_object_entries_indexed_str");
        vm.mov(VReg.S0, VReg.A0);       // boxed string
        vm.call("_strlen");             // RET = byte length
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_object_entries_str_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_entries_idx_done");
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0);
        vm.call("_valueToStr");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_charAt");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 1);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_array_push");
        vm.mov(VReg.S2, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_entries_str_loop");

        vm.label("_object_entries_idx_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // number/bool → 空数组(装箱)
        vm.label("_object_entries_empty");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
    }

    // Object.assign(target, ...sources) -> target
    // 简化版：_object_assign(target, source) -> target
    generateObjectAssign() {
        const vm = this.vm;

        vm.label("_object_assign");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        // [test262 S1] 入口类型守卫(对齐 node,判别逻辑详注见 _object_keys):
        // target null/undefined → TypeError;target number/bool → 原样返回(无包装对象,
        // 偏差:node 返 Number/Boolean 包装);source null/undefined/number/bool → 跳过
        // (返回 target);source string/array → 按索引键拷贝到 target;其余走原路径。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_assign_nullish_tgt");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_assign_nullish_tgt");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_assign_tgt_ok");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_assign_tgt_ok");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_assign_tgt_ok");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_assign_ret_tgt"); // string target:无包装,原样返
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_assign_ret_tgt"); // 裸 float number
        vm.cmpImm(VReg.A0, 0); vm.jeq("_object_assign_ret_tgt"); // +0.0
        // high16==0 且非零 → 裸堆指针 target → 原路径
        vm.label("_object_assign_tgt_ok");
        vm.shrImm(VReg.V0, VReg.A1, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_assign_ret_tgt");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_assign_ret_tgt");
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_object_assign_ret_tgt");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_object_assign_ret_tgt");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_assign_src_str");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_assign_src_arr");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_assign_legacy");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_assign_legacy");
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_assign_ret_tgt"); // 裸 float source
        vm.cmpImm(VReg.A1, 0); vm.jeq("_object_assign_ret_tgt"); // +0.0
        // 裸堆指针 source → 原路径
        vm.label("_object_assign_legacy");

        vm.mov(VReg.S0, VReg.A0); // target
        vm.mov(VReg.S1, VReg.A1); // source
        
        // 指针脱壳 (双向)
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);
        vm.andMaskReg(VReg.S1, VReg.S1, VReg.V4);

        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_object_assign_done");

        vm.load(VReg.S2, VReg.S1, 8); // source count
        vm.movImm(VReg.S3, 0);

        // 防御：source props_ptr 为 NULL（count>0 的不一致对象）→ 遍历读 key 解引用 NULL 崩。
        // 与 _object_get 同款守卫：无 props 数组则视作无自有属性、直接完成。
        vm.load(VReg.V0, VReg.S1, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_assign_done");

        // [enum-order] source 枚举前归一(整数键升序在前)。normalize 保 S0-S5。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_normalize_order");

        vm.label("_object_assign_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_object_assign_done");

        // 获取 source 的 key 和 value（source props_ptr 在 S1 头 @32）
        vm.load(VReg.V2, VReg.S1, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);

        vm.load(VReg.V1, VReg.V0, 0); // key
        vm.load(VReg.V2, VReg.V0, 8); // value

        // 设置到 target
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.V2);
        vm.call("_object_set");

        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_assign_loop");

        vm.label("_object_assign_done");
        // S0 是脱壳后的裸指针（入口 line 处 and MASK）。必须重新装箱为对象 JSValue
        // （0x7FFD），否则返回裸指针（高 16 位=0）：obj.x 成员访问靠 mask 兼容仍可读，但
        // for-in / 变量下标 obj[key] 按 tag 分派（要求 0x7FFD/0x7FFE）会落空 → 返回空。
        // 自举时 `ctx.mainCapturedVars = Object.assign({}, meta.mainCapturedVars)` 得到裸指针，
        // getMainCapturedVar(name) 走变量下标取不到 → 顶层捕获变量全不装箱 → 漏发绑定守卫
        // (~758KB 系统性欠生成)。
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S0, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // ---- [test262 S1] 非对象 target/source 分派处理(入口守卫跳入)----
        // target null/undefined → TypeError(ToObject 规范)
        vm.label("_object_assign_nullish_tgt");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        // 不可拷贝形态 → 原样返回 target(原 boxed 值,tag 不改写)
        vm.label("_object_assign_ret_tgt");
        vm.mov(VReg.RET, VReg.A0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // source string → target[i] = 单字符(node: assign({},'xy') → {0:'x',1:'y'})
        // 活值:S0=boxed target、S1=boxed source、S2=len、S3=i、SP+0=当前键。
        vm.label("_object_assign_src_str");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");             // RET = byte length
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_object_assign_str_loop");
        vm.cmp(VReg.S3, VReg.S2); vm.jge("_object_assign_idx_ret");
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0);
        vm.call("_valueToStr");         // 键 "i"
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_charAt");         // 值 'ci'
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_assign_str_loop");

        // source array → target[i] = a[i](node: assign({},[7,8]) → {0:7,1:8})
        vm.label("_object_assign_src_arr");
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");       // RET = length
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_object_assign_arr_loop");
        vm.cmp(VReg.S3, VReg.S2); vm.jge("_object_assign_idx_ret");
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0);
        vm.call("_valueToStr");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_assign_arr_loop");

        vm.label("_object_assign_idx_ret");
        vm.mov(VReg.RET, VReg.S0);      // 原 boxed target
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // [rest] 对象解构 rest:_object_rest(src, excludedKeysArray) -> 新对象
    // 遍历 src 自有属性,键不在 excluded 数组中的复制入新对象。
    // src = boxed 对象;excluded = JS 数组(元素为 boxed 字符串键,可空)。
    // 全程用栈槽保存循环状态,免依赖被调用 helper 的 S 寄存器保存契约。
    // 栈布局(prologue 80):
    //   +0 src指针  +8 src count  +16 i  +24 excluded指针  +32 excluded长度
    //   +40 result(boxed)  +48 当前key  +56 当前val  +64 j
    generateObjectRest() {
        const vm = this.vm;

        vm.label("_object_rest");
        vm.prologue(80, []);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V4);
        vm.store(VReg.SP, 0, VReg.V0);   // src 指针
        vm.andMaskReg(VReg.V0, VReg.A1, VReg.V4);
        vm.store(VReg.SP, 24, VReg.V0);  // excluded 指针

        vm.call("_object_new");
        vm.store(VReg.SP, 40, VReg.RET); // result (boxed 0x7FFD)

        // src count
        vm.load(VReg.V0, VReg.SP, 0);
        vm.load(VReg.V1, VReg.V0, 8);
        vm.store(VReg.SP, 8, VReg.V1);

        // 守卫:src props_ptr 为 NULL → 无自有属性,直接返回空对象
        vm.load(VReg.V0, VReg.SP, 0);
        vm.load(VReg.V1, VReg.V0, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_rest_done");

        // excluded 长度
        vm.load(VReg.V0, VReg.SP, 24);
        vm.load(VReg.V1, VReg.V0, 8);
        vm.store(VReg.SP, 32, VReg.V1);

        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0);  // i = 0

        vm.label("_object_rest_loop");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_object_rest_done");

        // propAddr = src.props_ptr + i*16
        vm.load(VReg.V2, VReg.SP, 0);
        vm.load(VReg.V2, VReg.V2, OBJECT_PROPS_PTR_OFFSET);
        vm.load(VReg.V0, VReg.SP, 16);
        vm.shl(VReg.V0, VReg.V0, 4);
        vm.add(VReg.V2, VReg.V2, VReg.V0);
        vm.load(VReg.V1, VReg.V2, 0);
        vm.store(VReg.SP, 48, VReg.V1);  // key
        vm.load(VReg.V1, VReg.V2, 8);
        vm.store(VReg.SP, 56, VReg.V1);  // val

        // 内层:j 遍历 excluded,命中则跳过本属性
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 64, VReg.V0);  // j = 0

        vm.label("_object_rest_inner");
        vm.load(VReg.V0, VReg.SP, 64);
        vm.load(VReg.V1, VReg.SP, 32);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_object_rest_keep");

        vm.load(VReg.A0, VReg.SP, 24);   // excluded 数组
        vm.load(VReg.A1, VReg.SP, 64);   // j
        vm.call("_array_get");           // RET = excluded[j]
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 48);   // src key
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_rest_skip");     // 键被排除 → 不复制

        vm.load(VReg.V0, VReg.SP, 64);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 64, VReg.V0);
        vm.jmp("_object_rest_inner");

        vm.label("_object_rest_keep");
        vm.load(VReg.A0, VReg.SP, 40);   // result
        vm.load(VReg.A1, VReg.SP, 48);   // key
        vm.load(VReg.A2, VReg.SP, 56);   // val
        vm.call("_object_set");

        vm.label("_object_rest_skip");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.jmp("_object_rest_loop");

        vm.label("_object_rest_done");
        vm.load(VReg.RET, VReg.SP, 40);
        // [修复] _object_new 返回裸指针(装箱由调用方负责);补 0x7FFD 对象标签,
        // 否则 typeof rest→"number"、JSON.stringify(rest)→0(裸指针高16=0 被当
        // 小 double)。属性访问/Object.keys 兼容裸指针而侥幸工作,掩盖此漏。
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([], 80);
    }

    // Object.create(proto) -> obj
    generateObjectCreate() {
        const vm = this.vm;

        vm.label("_object_create");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // proto
        
        // 指针脱壳 (使用 S2 作为临时，保存到栈后不再使用)
        vm.emitMaskLoad(VReg.S2);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.S2);

        // 创建新对象
        vm.call("_object_new");
        vm.mov(VReg.S1, VReg.RET);

        // 设置 __proto__
        vm.store(VReg.S1, 16, VReg.S0);

        // 将裸指针标记为 JS 对象 (0x7FFD)
        vm.movImm64(VReg.S2, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S1, VReg.S2); // RET = 标记后的对象
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // obj.hasOwnProperty(key) -> boolean
    generateHasOwnProperty() {
        const vm = this.vm;

        vm.label("_hasOwnProperty");
        // 直接调用 _object_has
        vm.jmp("_object_has");
    }

    // Object.getPrototypeOf(obj) -> proto
    generateGetPrototypeOf() {
        const vm = this.vm;

        vm.label("_object_getPrototypeOf");
        vm.prologue(32, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // 保存原始输入
        
        // 类型检查: 必须是 Object (0x7FFD) / Array (0x7FFE) / 裸堆指针 (高16位=0)
        vm.shrImm(VReg.S1, VReg.A0, 48);
        vm.cmpImm(VReg.S1, 0); // 裸堆指针（未装箱的对象指针，兼容旧调用点）
        vm.jeq("_object_getPrototypeOf_tag_ok");
        vm.cmpImm(VReg.S1, 0x7FFD); // Object
        vm.jeq("_object_getPrototypeOf_tag_ok");
        vm.cmpImm(VReg.S1, 0x7FFE); // Array
        vm.jeq("_object_getPrototypeOf_tag_ok");

        // 非法类型，返回 undefined
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_object_getPrototypeOf_tag_ok");
        // 指针脱壳 (使用 S1 作为临时)
        vm.movImm64(VReg.S1, 0x0000ffffffffffffn);
        vm.and(VReg.S1, VReg.A0, VReg.S1); // S1 = 裸指针

        // 空指针防护（裸 0 / 装箱后 payload 为 0 都返回 null）
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_object_getPrototypeOf_null");

        // [proxy] getPrototypeOf 陷阱:handler.getPrototypeOf(target) 或转发 target
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jeq("_gpo_proxy");

        // 加载 __proto__
        vm.load(VReg.RET, VReg.S1, 16); // RET = __proto__ (裸指针)

        // 检查是否为 null
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_getPrototypeOf_null");

        // __proto__ 指向 classinfo(type@0==3=FUNCTION)→ 原样返回裸 classinfo 指针:
        // 类值在本运行时即裸 classinfo(读类名标识符不加 tag),故 `Object.getPrototypeOf(
        // 子类) === 父类` 按指针相等成立;typeof 对裸指针读 type@0==3 得 "function"。
        // 普通原型对象则按对象标记(0x7FFD)。S1(裸输入)此后不再用,借作临时。
        vm.load(VReg.S1, VReg.RET, 0); // type@0
        vm.cmpImm(VReg.S1, 3);
        vm.jeq("_object_getPrototypeOf_fn");
        // 将裸指针标记为 JS 对象 (0x7FFD)
        vm.orImm(VReg.RET, VReg.RET, 0x7ffd000000000000); // RET = 标记后的对象
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_object_getPrototypeOf_fn");
        // RET 已是裸 classinfo 指针,原样返回(与类值表示一致)
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_object_getPrototypeOf_null");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // [proxy] getPrototypeOf 陷阱(S1=裸 proxy)
        vm.label("_gpo_proxy");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("getPrototypeOf"));
        vm.call("_proxy_trap_fn"); // S1 保活(callee 保存)
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gpo_proxy_fwd");
        vm.mov(VReg.A3, VReg.RET);
        vm.load(VReg.A0, VReg.S1, 8); // target
        vm.lea(VReg.A1, "_js_undefined");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.mov(VReg.A2, VReg.A1);
        vm.call("_aref_invoke_cb");
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_gpo_proxy_fwd");
        vm.load(VReg.A0, VReg.S1, 8); // target
        vm.call("_object_getPrototypeOf");
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // _is_prototype_of(A0 = proto, A1 = x) -> js_true/js_false
    // proto.isPrototypeOf(x):x 的原型链(__proto__@16 裸指针链)是否含 proto。
    // x 非对象(非 0x7FFD/裸堆指针)→ false(数组 @16 是 capacity 非 proto,不走)。
    generateIsPrototypeOf() {
        const vm = this.vm;
        vm.label("_is_prototype_of");
        vm.prologue(0, [VReg.S0]);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // S0 = proto 裸指针
        vm.shrImm(VReg.V0, VReg.A1, 48);   // x tag
        vm.cmpImm(VReg.V0, 0x7FFD);        // 装箱对象
        vm.jeq("_ipo_ok");
        vm.cmpImm(VReg.V0, 0);             // 裸堆指针
        vm.jeq("_ipo_ok");
        vm.jmp("_ipo_false");
        vm.label("_ipo_ok");
        // [修] 掩码须经 andMaskReg:arm64 上 emitMaskLoad 是空操作(掩码内含于 AND 立即数),
        // 原裸 and(V0,A1,V1) 在 arm64 读到 V1 垃圾 → V0 野指针 → 链走查 SIGSEGV
        // (isPrototypeOf 全形态崩的根因;x64 物化掩码侥幸正确)。
        vm.andMaskReg(VReg.V0, VReg.A1, VReg.V1); // V0 = x 裸指针(cur)
        vm.label("_ipo_loop");
        vm.load(VReg.V0, VReg.V0, 16);     // cur = cur.__proto__(裸指针)
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ipo_false");
        vm.cmp(VReg.V0, VReg.S0);
        vm.jeq("_ipo_true");
        vm.jmp("_ipo_loop");
        vm.label("_ipo_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_ipo_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
    }

    // Object.setPrototypeOf(obj, proto) -> obj
    generateSetPrototypeOf() {
        const vm = this.vm;

        vm.label("_object_setPrototypeOf");
        vm.prologue(0, []);

        // [#66] A0/A1 皆为装箱值(0x7FFD 对象 / tagged null)。必须脱壳后再 store:
        // 直接 store(A0,16,..) 会写到装箱地址(高位含 tag)→ 野地址 SIGSEGV。
        // tagged null/undefined 的低48位 payload 为 0 → 裸 proto=0(null 原型)。
        // 脱壳后的对象指针须落 [heap_base,heap_ptr) 才写(基元/野值原样返回,
        // ES:setPrototypeOf 基元是 no-op)。V1/V2/V3=RCX/RDX/R8,不与 A0/A1/RET 别名。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.A0, VReg.V1); // V2 = 裸对象指针
        vm.andMaskReg(VReg.V3, VReg.A1, VReg.V1); // V3 = 裸 proto 指针(null/undefined → 0)
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_setPrototypeOf_done");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_object_setPrototypeOf_done");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jge("_object_setPrototypeOf_done");
        vm.store(VReg.V2, 16, VReg.V3);
        // [A2] 原型改写:保守形状置 0(键序未变;读侧形状只管自有键,置 0 无害)
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V2, OBJECT_SHAPE_OFFSET, VReg.V1);

        vm.label("_object_setPrototypeOf_done");
        vm.mov(VReg.RET, VReg.A0); // 返回原始装箱 obj
        vm.epilogue([], 0);
    }

    // obj.toString() -> "[object Object]"
    generateObjectToString() {
        const vm = this.vm;

        vm.label("_object_toString");
        vm.prologue(0, []);
        vm.lea(VReg.RET, "_str_object");
        vm.epilogue([], 0);
    }

    // obj.valueOf() -> obj
    generateObjectValueOf() {
        const vm = this.vm;

        vm.label("_object_valueOf");
        vm.prologue(0, []);
        vm.mov(VReg.RET, VReg.A0);
        vm.epilogue([], 0);
    }

    // [#61 P1] 扩展标志辅助:A0(boxed 接收者)脱壳 → V0=裸对象指针,并守卫
    // "必须是合法 TYPE_OBJECT 堆对象",否则跳 bail(非对象接收者/数组/null/垃圾
    // 地址一律不动 byte1,由调用方返回原值或默认布尔——ES: freeze(5) 返回 5 不崩)。
    // 叶子上下文(仅 A0 入参)复用 V0/V1 scratch:x64 A0=RDI 不被 V0=RAX/V1=RCX
    // 别名,arm64 A0=X0 不被 V0=X8/V1=X9 别名,两平台安全。pfx 保内部标签唯一。
    _extGuard(pfx, bailLabel) {
        const vm = this.vm;
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0); // 裸堆指针(遗留调用点)
        vm.jeq(pfx + "_ds");
        vm.cmpImm(VReg.V1, 0x7FFD); // 装箱对象
        vm.jne(bailLabel);
        vm.label(pfx + "_ds");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1); // V0 = 裸指针
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt(bailLabel); // null/低地址垃圾
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT); // 仅普通对象(数组/Map/TypedArray 等不动)
        vm.jne(bailLabel);
    }

    // _object_apply_clear_attrs(obj_raw, clearMask):materialize flags 后对全属性
    // flags[i] &= ~clearMask。精确 freeze/seal 用。框架式(保 S0-S2)。
    generateObjectApplyClearAttrs() {
        const vm = this.vm;
        vm.label("_object_apply_clear_attrs");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // obj raw
        vm.not(VReg.S1, VReg.A1); // ~clearMask
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_ensure_flags"); // RET = flags_ptr
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.V3, VReg.S0, 8); // count
        vm.movImm(VReg.V0, 0);
        vm.label("_oaca_loop");
        vm.cmp(VReg.V0, VReg.V3);
        vm.jge("_oaca_done");
        vm.add(VReg.V1, VReg.S2, VReg.V0);
        vm.loadByte(VReg.V2, VReg.V1, 0);
        vm.and(VReg.V2, VReg.V2, VReg.S1); // &= ~clearMask
        vm.storeByte(VReg.V1, 0, VReg.V2);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_oaca_loop");
        vm.label("_oaca_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // Object.freeze(obj) -> obj(原对象)。对象级全冻(P1 位保留:FROZEN|SEALED|NONEXT)
    // + [P2] 精确:materialize flags 并对全属性清 writable|configurable(getOwnProperty-
    // Descriptor 可读回 writable:false)。对象级 FROZEN 在 _object_set 仍先行短路。
    generateObjectFreeze() {
        const vm = this.vm;
        vm.label("_object_freeze");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0); // boxed receiver(返回值)
        this._extGuard("_ofrz", "_ofrz_ret");
        vm.mov(VReg.S0, VReg.V0); // raw obj
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.orImm(VReg.V1, VReg.V1, EXT_FROZEN | EXT_SEALED | EXT_NONEXT);
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, ATTR_WRITABLE | ATTR_CONFIGURABLE);
        vm.call("_object_apply_clear_attrs");
        vm.label("_ofrz_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Object.seal(obj) -> obj。对象级 SEALED|NONEXT + [P2] 精确:清全属性 configurable
    // (writable 保留,可改写已有值)。
    generateObjectSeal() {
        const vm = this.vm;
        vm.label("_object_seal");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0);
        this._extGuard("_osl", "_osl_ret");
        vm.mov(VReg.S0, VReg.V0);
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.orImm(VReg.V1, VReg.V1, EXT_SEALED | EXT_NONEXT);
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, ATTR_CONFIGURABLE);
        vm.call("_object_apply_clear_attrs");
        vm.label("_osl_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Object.preventExtensions(obj) -> obj。| NONEXT(仅拒新增,可改写/可删)。
    // [proxy] proxy 有 preventExtensions 陷阱则 handler.preventExtensions(target),否则
    // 转发 target(不变式检查——陷阱返 true 但 target 仍可扩展应抛——推迟)。
    generateObjectPreventExtensions() {
        const vm = this.vm;
        vm.label("_object_preventExtensions");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // boxed 输入(非 proxy 路返回值)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S1, VReg.S0, VReg.V1); // 裸指针
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_opx_normal");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_opx_normal");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jne("_opx_normal");
        // proxy:陷阱分派
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("preventExtensions"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_opx_proxy_fwd");
        vm.mov(VReg.A3, VReg.RET);
        vm.load(VReg.A0, VReg.S1, 8); // target
        vm.lea(VReg.A1, "_js_undefined");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.mov(VReg.A2, VReg.A1);
        vm.call("_aref_invoke_cb"); // RET = 陷阱布尔;返回原 proxy(ES 返 obj)
        // [不变式] 陷阱返 truthy 但 target 仍可扩展 → 抛(t380)。
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_opx_px_ok");
        vm.load(VReg.A0, VReg.S1, 8); // target
        vm.call("_object_isExtensible"); // RET = js_true/js_false
        vm.lea(VReg.V1, "_js_true");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_opx_px_ok"); // target 不可扩展 → 合规
        vm.call("_throw_proxy_invariant");
        vm.label("_opx_px_ok");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_opx_proxy_fwd");
        vm.load(VReg.A0, VReg.S1, 8); // target
        vm.call("_object_preventExtensions");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        // 普通对象路径
        vm.label("_opx_normal");
        vm.mov(VReg.A0, VReg.S0);
        this._extGuard("_opx", "_opx_ret");
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.orImm(VReg.V1, VReg.V1, EXT_NONEXT);
        vm.storeByte(VReg.V0, 1, VReg.V1);
        vm.label("_opx_ret");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // Object.isFrozen(obj) -> js_true/js_false。
    // frozen ⟺ EXT_FROZEN 位;边角:count==0 && non-extensible 的空对象亦为 frozen
    // (ES:无自有属性 → 所有属性 vacuously non-writable/non-configurable)。
    // 非对象接收者(primitive)→ true(ES:primitive 恒 frozen)。
    generateObjectIsFrozen() {
        const vm = this.vm;
        vm.label("_object_isFrozen");
        vm.prologue(0, []);
        this._extGuard("_ifz", "_ifz_true"); // 非对象 → frozen true
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V3, VReg.V1, EXT_FROZEN);
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_ifz_true"); // FROZEN 位置 → true
        // 空对象 + non-extensible → frozen true
        vm.andImm(VReg.V3, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_ifz_false"); // 可扩展 → 非 frozen
        vm.load(VReg.V3, VReg.V0, 8); // count
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_ifz_true"); // 空 + 不可扩展 → frozen
        vm.label("_ifz_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
        vm.label("_ifz_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
    }

    // Object.isSealed(obj) -> js_true/js_false。
    // sealed ⟺ EXT_SEALED 位;边角同 isFrozen:空对象 + non-extensible → true。
    // 非对象接收者 → true。
    generateObjectIsSealed() {
        const vm = this.vm;
        vm.label("_object_isSealed");
        vm.prologue(0, []);
        this._extGuard("_isl", "_isl_true"); // 非对象 → sealed true
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V3, VReg.V1, EXT_SEALED);
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_isl_true");
        vm.andImm(VReg.V3, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_isl_false");
        vm.load(VReg.V3, VReg.V0, 8); // count
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_isl_true");
        vm.label("_isl_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
        vm.label("_isl_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
    }

    // Object.isExtensible(obj) -> js_true/js_false。
    // extensible ⟺ (byte1 & EXT_NONEXT)==0。非对象接收者(primitive)→ false。
    generateObjectIsExtensible() {
        const vm = this.vm;
        vm.label("_object_isExtensible");
        vm.prologue(0, []);
        this._extGuard("_iex", "_iex_false"); // 非对象 → 不可扩展
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_iex_false");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
        vm.label("_iex_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
    }

    // ============ [#61 P2] per-property attributes ============

    // _object_grow_flags(obj_raw, oldcount):props 增长后镜像 flags 块。
    // 仅当已 materialize(flags_ptr≠0)才动作:按 capacity@24(newcap 字节)重分配,
    // 拷贝旧 [0,oldcount) 字节,补 [oldcount,newcap)=ATTR_DEFAULT,更新 flags_ptr@40。
    // 框架式:保存自用 S0-S3,调用方 S0-S5 不受扰(_alloc 只保 S0-S3,已覆盖)。
    generateObjectGrowFlags() {
        const vm = this.vm;
        vm.label("_object_grow_flags");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // obj
        vm.mov(VReg.S1, VReg.A1); // oldcount
        vm.load(VReg.S2, VReg.S0, OBJECT_FLAGS_PTR_OFFSET); // old flags
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_ogf_done"); // 未 materialize
        vm.load(VReg.S3, VReg.S0, OBJECT_CAP_OFFSET); // newcap(字节数)
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_alloc");
        vm.mov(VReg.V0, VReg.RET); // 新 flags 基址(arm64: RET=X0→V0=X8 必须搬)
        // 拷贝旧 [0,oldcount)
        vm.movImm(VReg.V1, 0);
        vm.label("_ogf_copy");
        vm.cmp(VReg.V1, VReg.S1);
        vm.jge("_ogf_copied");
        vm.add(VReg.V2, VReg.S2, VReg.V1);
        vm.loadByte(VReg.V3, VReg.V2, 0);
        vm.add(VReg.V2, VReg.V0, VReg.V1);
        vm.storeByte(VReg.V2, 0, VReg.V3);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_ogf_copy");
        vm.label("_ogf_copied");
        // 补 [oldcount,newcap) = ATTR_DEFAULT
        vm.mov(VReg.V1, VReg.S1);
        vm.label("_ogf_fill");
        vm.cmp(VReg.V1, VReg.S3);
        vm.jge("_ogf_filled");
        vm.add(VReg.V2, VReg.V0, VReg.V1);
        vm.movImm(VReg.V3, ATTR_DEFAULT);
        vm.storeByte(VReg.V2, 0, VReg.V3);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_ogf_fill");
        vm.label("_ogf_filled");
        vm.store(VReg.S0, OBJECT_FLAGS_PTR_OFFSET, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_remember"); // 新 flags 块经 RS→scan_container 标记
        vm.label("_ogf_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _object_ensure_flags(obj_raw) -> flags_ptr。首次 materialize:分配 capacity
    // 字节全填 ATTR_DEFAULT(0x07),写 flags_ptr@40,置 byte1 EXT_HASFLAGS(bit3)
    // 强制 IC 落慢路,gc_remember。已存在则直接返回既有 flags_ptr。
    generateObjectEnsureFlags() {
        const vm = this.vm;
        vm.label("_object_ensure_flags");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.load(VReg.RET, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_oef_done");
        vm.load(VReg.S1, VReg.S0, OBJECT_CAP_OFFSET); // capacity(槽数=字节数)
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_oef_cap_ok");
        vm.movImm(VReg.S1, 4); // 防御:cap==0 → 至少 4
        vm.label("_oef_cap_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET); // flags 块
        vm.movImm(VReg.V0, 0);
        vm.label("_oef_fill");
        vm.cmp(VReg.V0, VReg.S1);
        vm.jge("_oef_filled");
        vm.add(VReg.V1, VReg.S2, VReg.V0);
        vm.movImm(VReg.V2, ATTR_DEFAULT);
        vm.storeByte(VReg.V1, 0, VReg.V2);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_oef_fill");
        vm.label("_oef_filled");
        vm.store(VReg.S0, OBJECT_FLAGS_PTR_OFFSET, VReg.S2);
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.orImm(VReg.V0, VReg.V0, EXT_HASFLAGS);
        vm.storeByte(VReg.S0, 1, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_remember");
        vm.mov(VReg.RET, VReg.S2);
        vm.label("_oef_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _object_get_attr(obj_raw, idx) -> attr byte。flags_ptr==0 → ATTR_DEFAULT。
    // 叶子裸函数;A0/A1 只读入参,V0 scratch(x64 无别名冲突)。
    generateObjectGetAttr() {
        const vm = this.vm;
        vm.label("_object_get_attr");
        vm.prologue(0, []);
        vm.load(VReg.V0, VReg.A0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_oga_default");
        vm.add(VReg.V0, VReg.V0, VReg.A1);
        vm.loadByte(VReg.RET, VReg.V0, 0);
        vm.epilogue([], 0);
        vm.label("_oga_default");
        vm.movImm(VReg.RET, ATTR_DEFAULT);
        vm.epilogue([], 0);
    }

    // _object_set_attr(obj_raw, idx, attrByte):materialize 后写 flags[idx]=attr。
    generateObjectSetAttr() {
        const vm = this.vm;
        vm.label("_object_set_attr");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1); // idx
        vm.mov(VReg.S2, VReg.A2); // attr
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_ensure_flags"); // RET = flags_ptr
        vm.add(VReg.V0, VReg.RET, VReg.S1);
        vm.storeByte(VReg.V0, 0, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _object_set_prop_attr(obj_boxed, key_boxed, attrByte):按键定位 idx 后设 attr。
    // defineProperty 落值(_object_define)后由编译器调用以落非默认 attrs。未命中静默。
    generateObjectSetPropAttr() {
        const vm = this.vm;
        vm.label("_object_set_prop_attr");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S2, VReg.A2); // attr
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // raw obj
        vm.mov(VReg.S1, VReg.A1); // key(boxed)
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_ospa_done");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_ospa_done");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jne("_ospa_done");
        vm.load(VReg.S3, VReg.S0, 8); // count
        vm.movImm(VReg.S4, 0);
        vm.label("_ospa_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_ospa_done");
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ospa_hit");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_ospa_loop");
        vm.label("_ospa_hit");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set_attr");
        vm.label("_ospa_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // _canonical_array_index(key_boxed) -> RET = 规范数组索引值(0..2^32-2)或 -1(非索引)。
    // ES 规范:字符串键当且仅当是 CanonicalNumericIndexString 且在数组索引范围时"整数键"。
    // 判据:非空数字串、无前导零(除单 "0")、全十进制、值 ≤ 4294967294。非字符串键 → -1。
    // 叶子式(仅调 _getStrContent,保 S0/S1);不写 S2-S5(供 _object_normalize_order 跨调用保活)。
    generateCanonicalArrayIndex() {
        const vm = this.vm;
        vm.label("_canonical_array_index");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC); // 字符串 tag
        vm.jne("_cai_no");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent"); // RET = 内容裸指针
        vm.mov(VReg.S1, VReg.RET);
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cai_no"); // 空串
        vm.cmpImm(VReg.V0, 48); // '0'
        vm.jne("_cai_multi");
        // 首字符 '0':仅当整串就是 "0"(下一字节为 NUL)才是索引 0
        vm.loadByte(VReg.V0, VReg.S1, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cai_zero");
        vm.jmp("_cai_no"); // "0..." 前导零
        vm.label("_cai_multi");
        vm.movImm(VReg.V2, 0); // value 累加器
        vm.mov(VReg.V3, VReg.S1); // 游标
        vm.label("_cai_loop");
        vm.loadByte(VReg.V0, VReg.V3, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cai_ret"); // 串尾
        vm.cmpImm(VReg.V0, 48);
        vm.jlt("_cai_no");
        vm.cmpImm(VReg.V0, 57); // '9'
        vm.jgt("_cai_no");
        vm.subImm(VReg.V0, VReg.V0, 48); // 数字
        // 溢出护栏:value>429496729 时 *10 必超 4294967294 且防 64 位环绕
        vm.movImm64(VReg.V1, 429496729n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jgt("_cai_no");
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.V2, VReg.V2, VReg.V1);
        vm.add(VReg.V2, VReg.V2, VReg.V0);
        vm.movImm64(VReg.V1, 4294967294n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jgt("_cai_no");
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp("_cai_loop");
        vm.label("_cai_ret");
        vm.mov(VReg.RET, VReg.V2);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_cai_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_cai_no");
        vm.movImm64(VReg.RET, 0xFFFFFFFFFFFFFFFFn); // -1
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _object_normalize_order(obj_raw):把普通对象(type==2)的属性存储归一到 ES
    // [[OwnPropertyKeys]] 序——整数索引键升序在前、再字符串键插入序。**无缓存位、每次
    // 枚举调用前调它**:先 O(n) 扫描判「是否已有序」(整数键无越序/无落于字符串键之后),
    // 已序则**零改**返回(编译器自身对象全字符串键 → 恒已序 → 不动存储、不改 byte1,
    // 产物逐字节不变);否则重排 props(及 flags 侧表,若已 materialize)到新缓冲并重指。
    // 支持枚举后追加/删除整数键(如 defineProperty("4")/delete+re-add)→ 下次枚举重排。
    // _canonical_array_index 保 S0-S5;仅在重排段调 _alloc(判序段无),S 寄存器管理清晰。
    // 站点(_object_keys/values/entries/assign、for-in codegen)遍历前调用,循环本身不变。
    generateObjectNormalizeOrder() {
        const vm = this.vm;
        const NEG1 = 0xFFFFFFFFFFFFFFFFn;
        vm.label("_object_normalize_order");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // raw obj
        // 仅普通对象(type==2):数组/classinfo/Proxy 布局不同,一律跳过。
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_OBJECT);
        vm.jne("_ono_done");
        vm.load(VReg.S1, VReg.S0, 8); // count
        vm.cmpImm(VReg.S1, 1);
        vm.jle("_ono_done"); // 0/1 属性:恒有序

        // ===== pass 1:判是否需重排(整数键越序 或 落于字符串键之后)=====
        // S2=lastIntVal(-1) S3=sawString(0) S4=idx;[SP+56]=needReorder(0)
        vm.movImm64(VReg.S2, NEG1);
        vm.movImm(VReg.S3, 0);
        vm.movImm(VReg.S4, 0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 56, VReg.V0);
        vm.label("_ono_chk");
        vm.cmp(VReg.S4, VReg.S1);
        vm.jge("_ono_checked");
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0); // key
        vm.call("_canonical_array_index"); // RET=idx/-1;S0-S5 保活
        vm.movImm64(VReg.V1, NEG1);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ono_chk_str"); // 字符串键
        // 整数键:若已见字符串键 → 越序;若 idx < lastIntVal → 越序
        vm.cmpImm(VReg.S3, 0);
        vm.jne("_ono_chk_need");
        vm.cmp(VReg.RET, VReg.S2);
        vm.jlt("_ono_chk_need");
        vm.mov(VReg.S2, VReg.RET); // lastIntVal = idx
        vm.jmp("_ono_chk_next");
        vm.label("_ono_chk_str");
        vm.movImm(VReg.S3, 1); // sawString
        vm.jmp("_ono_chk_next");
        vm.label("_ono_chk_need");
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.SP, 56, VReg.V0);
        vm.label("_ono_chk_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_ono_chk");
        vm.label("_ono_checked");
        vm.load(VReg.V0, VReg.SP, 56);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ono_done"); // 已有序(含无整数键)→ 零改

        // ===== 重排:分配 newProps(+newFlags 若已 materialize)=====
        vm.load(VReg.S2, VReg.S0, OBJECT_CAP_OFFSET); // S2=cap(_alloc 保 S0-S3)
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_ono_cap_ok");
        vm.mov(VReg.S2, VReg.S1);
        vm.label("_ono_cap_ok");
        vm.shlImm(VReg.A0, VReg.S2, 4); // props 字节 = cap*16
        vm.call("_alloc");
        vm.store(VReg.SP, 24, VReg.RET); // newProps
        vm.load(VReg.V0, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.store(VReg.SP, 48, VReg.V0); // oldFlags
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ono_noflags");
        vm.mov(VReg.A0, VReg.S2); // cap 字节
        vm.call("_alloc");
        vm.store(VReg.SP, 32, VReg.RET); // newFlags
        vm.jmp("_ono_flags_done");
        vm.label("_ono_noflags");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 32, VReg.V0); // newFlags=0
        vm.label("_ono_flags_done");
        vm.load(VReg.V0, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.store(VReg.SP, 40, VReg.V0); // oldProps
        vm.movImm(VReg.S4, 0); // outIdx
        vm.movImm64(VReg.S5, NEG1); // lastPlacedVal

        // ---- Phase A:整数键按索引升序 ----
        vm.label("_ono_pa_outer");
        vm.movImm64(VReg.V0, 0x100000000n); // bestVal 哨兵
        vm.store(VReg.SP, 8, VReg.V0);
        vm.movImm64(VReg.V0, NEG1); // bestPropI=-1
        vm.store(VReg.SP, 16, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0); // scanIdx
        vm.label("_ono_pa_scan");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jge("_ono_pa_place");
        vm.load(VReg.V1, VReg.SP, 40); // oldProps
        vm.shlImm(VReg.V2, VReg.V0, 4);
        vm.add(VReg.V1, VReg.V1, VReg.V2);
        vm.load(VReg.A0, VReg.V1, 0); // key
        vm.call("_canonical_array_index");
        vm.load(VReg.V2, VReg.SP, 0); // scanIdx 重载
        vm.movImm64(VReg.V1, NEG1);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ono_pa_next"); // 字符串键
        vm.cmp(VReg.RET, VReg.S5);
        vm.jle("_ono_pa_next"); // 已放置
        vm.load(VReg.V3, VReg.SP, 8); // bestVal
        vm.cmp(VReg.RET, VReg.V3);
        vm.jge("_ono_pa_next");
        vm.store(VReg.SP, 8, VReg.RET); // bestVal=idx
        vm.store(VReg.SP, 16, VReg.V2); // bestPropI=scanIdx
        vm.label("_ono_pa_next");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_ono_pa_scan");
        vm.label("_ono_pa_place");
        vm.load(VReg.V0, VReg.SP, 16); // bestPropI
        vm.movImm64(VReg.V1, NEG1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_ono_pb"); // 无更多整数键
        this._emitOnoCopy(vm); // 复制 oldProps[bestPropI]→newProps[outIdx](含 flags)
        vm.load(VReg.V0, VReg.SP, 8); // bestVal
        vm.mov(VReg.S5, VReg.V0); // lastPlacedVal
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_ono_pa_outer");

        // ---- Phase B:字符串键按插入序 ----
        vm.label("_ono_pb");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.label("_ono_pb_scan");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jge("_ono_pb_done");
        vm.load(VReg.V1, VReg.SP, 40); // oldProps
        vm.shlImm(VReg.V2, VReg.V0, 4);
        vm.add(VReg.V1, VReg.V1, VReg.V2);
        vm.load(VReg.A0, VReg.V1, 0); // key
        vm.call("_canonical_array_index");
        vm.movImm64(VReg.V1, NEG1);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_ono_pb_next"); // 整数键已在 Phase A
        vm.store(VReg.SP, 16, VReg.RET); // 存一下(占位,复用 copy 用 bestPropI 槽)
        vm.load(VReg.V0, VReg.SP, 0); // scanIdx
        vm.store(VReg.SP, 16, VReg.V0); // bestPropI = scanIdx(复用 copy 助手)
        this._emitOnoCopy(vm);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.label("_ono_pb_next");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_ono_pb_scan");
        vm.label("_ono_pb_done");
        // [A2] 整数键重排:键序改变,形状失效置 0
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.S0, OBJECT_SHAPE_OFFSET, VReg.V0);
        // 重指 props_ptr(及 flags_ptr 若重排了 flags),记忆屏障
        vm.load(VReg.V0, VReg.SP, 24); // newProps
        vm.store(VReg.S0, OBJECT_PROPS_PTR_OFFSET, VReg.V0);
        vm.load(VReg.V0, VReg.SP, 32); // newFlags
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ono_norepoint_flags");
        vm.store(VReg.S0, OBJECT_FLAGS_PTR_OFFSET, VReg.V0);
        vm.label("_ono_norepoint_flags");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_remember");
        vm.label("_ono_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // 内部:把 oldProps[bestPropI@SP+16] 的 key/value(16B)复制到 newProps[outIdx=S4],
    // 并把 oldFlags[bestPropI](若 SP+32 newFlags≠0)复制到 newFlags[outIdx]。仅在
    // _object_normalize_order 重排段调用,依赖其 SP 槽约定 + S4=outIdx。
    _emitOnoCopy(vm) {
        const uid = "_onocp_" + (this._onoCopyId = (this._onoCopyId || 0) + 1);
        vm.load(VReg.V0, VReg.SP, 16); // bestPropI
        vm.load(VReg.V1, VReg.SP, 40); // oldProps
        vm.shlImm(VReg.V2, VReg.V0, 4);
        vm.add(VReg.V1, VReg.V1, VReg.V2); // src = &oldProps[bestPropI]
        vm.load(VReg.V2, VReg.SP, 24); // newProps
        vm.shlImm(VReg.V3, VReg.S4, 4);
        vm.add(VReg.V2, VReg.V2, VReg.V3); // dst = &newProps[outIdx]
        vm.load(VReg.V3, VReg.V1, 0);
        vm.store(VReg.V2, 0, VReg.V3); // key
        vm.load(VReg.V3, VReg.V1, 8);
        vm.store(VReg.V2, 8, VReg.V3); // value
        // flags:newFlags[outIdx] = oldFlags[bestPropI](仅当 newFlags≠0)
        vm.load(VReg.V2, VReg.SP, 32); // newFlags
        vm.cmpImm(VReg.V2, 0);
        vm.jeq(uid + "_noflags");
        vm.load(VReg.V1, VReg.SP, 48); // oldFlags
        vm.load(VReg.V0, VReg.SP, 16); // bestPropI
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.loadByte(VReg.V3, VReg.V1, 0);
        vm.add(VReg.V2, VReg.V2, VReg.S4);
        vm.storeByte(VReg.V2, 0, VReg.V3);
        vm.label(uid + "_noflags");
    }

    // 内部:desc[keyName] = <寄存器值>(desc boxed 在 [SP+descSlot])。call 后
    // S 寄存器与 SP 槽稳定(_object_set 保 S0-S5)。srcReg 必须先落 A2,避免被
    // 后续 A1/A0 装载破坏。
    _emitDescSetReg(descSlot, keyName, srcReg) {
        const vm = this.vm;
        vm.mov(VReg.A2, srcReg);
        vm.lea(VReg.A1, this.vm.asm.addString(keyName));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.load(VReg.A0, VReg.SP, descSlot);
        vm.call("_object_set");
    }

    // 内部:desc[keyName] = (attr@[SP+attrSlot] & bitMask) ? js_true : js_false。
    _emitDescSetBool(descSlot, keyName, attrSlot, bitMask) {
        const vm = this.vm;
        const t = "_odesc_" + keyName + "_t";
        const e = "_odesc_" + keyName + "_e";
        vm.load(VReg.V0, VReg.SP, attrSlot);
        vm.andImm(VReg.V0, VReg.V0, bitMask);
        vm.cmpImm(VReg.V0, 0);
        vm.jne(t);
        vm.lea(VReg.A2, "_js_false");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.jmp(e);
        vm.label(t);
        vm.lea(VReg.A2, "_js_true");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.label(e);
        vm.lea(VReg.A1, this.vm.asm.addString(keyName));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.load(VReg.A0, VReg.SP, descSlot);
        vm.call("_object_set");
    }

    // Object.getOwnPropertyDescriptor(obj, key) -> 描述符对象或 undefined。
    // data:{value,writable,enumerable,configurable};accessor(值是 TYPE_GETTER
    // 标记块):{get,set,enumerable,configurable}。未命中/非对象 → undefined。
    // 栈槽:[SP+0]=desc(boxed) [SP+32]=attr。S5=命中 value。
    generateObjectGetOwnPropertyDescriptor() {
        const vm = this.vm;
        vm.label("_object_getOwnPropertyDescriptor");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // obj boxed
        vm.mov(VReg.S1, VReg.A1); // key boxed
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S2, VReg.S0, VReg.V1); // raw obj
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_ogopd_undef");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jlt("_ogopd_undef");
        vm.loadByte(VReg.V1, VReg.S2, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_ogopd_obj");
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jeq("_ogopd_proxy");
        vm.jmp("_ogopd_undef");
        vm.label("_ogopd_obj");
        vm.load(VReg.S3, VReg.S2, 8); // count
        vm.movImm(VReg.S4, 0);
        vm.label("_ogopd_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_ogopd_undef");
        vm.load(VReg.V2, VReg.S2, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ogopd_found");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_ogopd_loop");

        vm.label("_ogopd_found");
        vm.load(VReg.V2, VReg.S2, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.S5, VReg.V0, 8); // value
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_get_attr");
        vm.store(VReg.SP, 32, VReg.RET); // attr
        vm.call("_object_new");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V0); // desc boxed
        // 判 accessor:S5 是 TYPE_GETTER 标记块?
        vm.shrImm(VReg.V0, VReg.S5, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ogopd_data");
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_ogopd_data");
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S5, VReg.V0);
        vm.jlt("_ogopd_data");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S5, VReg.V0);
        vm.jge("_ogopd_data");
        vm.load(VReg.V0, VReg.S5, 0);
        vm.cmpImm(VReg.V0, TYPE_GETTER);
        vm.jne("_ogopd_data");

        // ===== accessor: {get,set,enumerable,configurable} =====
        // getter/setter 槽存裸函数指针(defineProperty 建标记块时脱壳存入),
        // 重装箱为函数 JSValue(| 0x7fff)使 typeof→"function" 且可调用;槽 0→undefined。
        vm.load(VReg.V0, VReg.S5, 8); // getter 裸指针
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ogopd_getundef");
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.jmp("_ogopd_getv");
        vm.label("_ogopd_getundef");
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.label("_ogopd_getv");
        this._emitDescSetReg(0, "get", VReg.V0);
        vm.load(VReg.V0, VReg.S5, 16); // setter 裸指针
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ogopd_setundef");
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.jmp("_ogopd_setv");
        vm.label("_ogopd_setundef");
        vm.lea(VReg.V0, "_js_undefined");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.label("_ogopd_setv");
        this._emitDescSetReg(0, "set", VReg.V0);
        this._emitDescSetBool(0, "enumerable", 32, ATTR_ENUMERABLE);
        this._emitDescSetBool(0, "configurable", 32, ATTR_CONFIGURABLE);
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // ===== data: {value,writable,enumerable,configurable} =====
        vm.label("_ogopd_data");
        this._emitDescSetReg(0, "value", VReg.S5);
        this._emitDescSetBool(0, "writable", 32, ATTR_WRITABLE);
        this._emitDescSetBool(0, "enumerable", 32, ATTR_ENUMERABLE);
        this._emitDescSetBool(0, "configurable", 32, ATTR_CONFIGURABLE);
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        vm.label("_ogopd_undef");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // ===== Proxy getOwnPropertyDescriptor 陷阱(S2=裸 proxy, S1=装箱键)=====
        vm.label("_ogopd_proxy");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("getOwnPropertyDescriptor"));
        vm.call("_proxy_trap_fn"); // RET = 陷阱函数 或 0
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogopd_proxy_fwd");
        // 调 trap(target, key);_aref_invoke_cb(A0=target,A1=key,A2=undef,A3=fn)
        vm.mov(VReg.S3, VReg.RET); // 陷阱函数
        vm.load(VReg.A0, VReg.S2, 8); // target(装箱)
        vm.mov(VReg.A1, VReg.S1); // key
        vm.lea(VReg.A2, "_js_undefined");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.mov(VReg.A3, VReg.S3);
        vm.call("_aref_invoke_cb"); // RET = 陷阱返回的(部分)描述符 或 undefined/falsy
        // 非对象(falsy)→ 不变式检查后返回 undefined
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_ogopd_proxy_undef_inv"); // 陷阱返 falsy → 查不变式
        // 补全描述符(填 writable/enumerable/configurable 等默认)后返回
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_complete_prop_descriptor");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        // [不变式] 陷阱报「无此属性」,但 target 有该键的**不可配置**自有属性 → 抛(t370)。
        vm.label("_ogopd_proxy_undef_inv");
        vm.load(VReg.A0, VReg.S2, 8); // target
        vm.mov(VReg.A1, VReg.S1); // key
        vm.call("_object_getOwnPropertyDescriptor"); // RET = target 描述符 或 undefined
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_ogopd_undef"); // target 无此自有属性 → 合规,返 undefined
        vm.mov(VReg.S3, VReg.RET); // target 描述符
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("configurable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get"); // RET = configurable
        vm.lea(VReg.V1, "_js_false");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_ogopd_undef"); // configurable:true → 合规
        vm.call("_throw_proxy_invariant"); // 不可配置却被报无 → 抛
        vm.label("_ogopd_proxy_fwd");
        // 无陷阱 → 转发 target
        vm.load(VReg.A0, VReg.S2, 8);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // obj.propertyIsEnumerable(key) -> js_true/js_false。own 属性的 enumerable 位;
    // 非 own(或非对象)→ false。
    generateObjectPropertyIsEnumerable() {
        const vm = this.vm;
        vm.label("_object_propertyIsEnumerable");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // raw obj
        vm.mov(VReg.S1, VReg.A1); // key boxed
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_opie_false");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_opie_false");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jne("_opie_false");
        vm.load(VReg.S2, VReg.S0, 8); // count
        vm.movImm(VReg.S3, 0);
        vm.label("_opie_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_opie_false");
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_opie_hit");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_opie_loop");
        vm.label("_opie_hit");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_object_get_attr"); // RET = attr
        vm.andImm(VReg.RET, VReg.RET, ATTR_ENUMERABLE);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_opie_false");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_opie_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // [ES2024] _groupby_invoke2(A0=cb, A1=element, A2=indexNumber) -> RET
    // 以 (element, index) 调用回调(装箱闭包/async 闭包/裸函数指针皆可)。
    // 镜像 _promise_invoke1 的分派,S0 保持为闭包指针供被调方读捕获;this=undefined。
    // 供 _object_groupBy / _map_groupBy 共用。
    generateGroupbyInvoke2() {
        const vm = this.vm;
        const CLOSURE_MAGIC = 0xc105;
        const ASYNC_CLOSURE_MAGIC = 0xa51c;
        const JS_UNDEFINED = 0x7ffb000000000000n;
        vm.label("_groupby_invoke2");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A1); // element
        vm.mov(VReg.S2, VReg.A2); // index number
        vm.call("_js_unbox"); // A0=cb -> RET 裸指针
        vm.mov(VReg.S0, VReg.RET);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_gbi2_undef");
        vm.load(VReg.V1, VReg.S0, 0); // magic
        vm.movImm(VReg.V2, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_gbi2_closure");
        vm.movImm(VReg.V2, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_gbi2_closure");
        // 裸函数指针：func=S0，闭包指针清 0
        vm.mov(VReg.V1, VReg.S0);
        vm.movImm(VReg.S0, 0);
        vm.jmp("_gbi2_call");
        vm.label("_gbi2_closure");
        vm.load(VReg.V1, VReg.S0, 8); // func_ptr，S0 保持为闭包指针
        vm.label("_gbi2_call");
        vm.mov(VReg.A0, VReg.S1); // element
        vm.mov(VReg.A1, VReg.S2); // index
        vm.movImm64(VReg.A5, JS_UNDEFINED); // this = undefined
        vm.setCallArgcImm(2, VReg.V0, VReg.V2); // [argc ABI] callback(elem, idx)
        vm.callIndirect(VReg.V1);
        vm.jmp("_gbi2_done");
        vm.label("_gbi2_undef");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.label("_gbi2_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // [ES2024] Object.groupBy(items, cb) -> boxed 普通对象 {key: [元素...]}
    // items 视作数组(可迭代但仅数组布局);key 经通用值->字符串归一(装箱串键);
    // 分组值是装箱数组。用 _object_new(非 JS {} 字典) 建结果,避免 [#32] 字典污染。
    generateObjectGroupBy() {
        const vm = this.vm;
        const MASK48 = 0x0000ffffffffffffn;
        const TAG_STRING = 0x7ffc000000000000n;
        const TAG_ARRAY = 0x7ffe000000000000n;
        vm.label("_object_groupBy");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // items(boxed 数组)
        vm.mov(VReg.S1, VReg.A1); // cb
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S3, VReg.RET); // length
        // 结果对象(boxed) -> S2
        vm.call("_object_new");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_object");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S4, 0); // index

        vm.label("_ogb_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_ogb_done");
        // element = items[index]
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.store(VReg.SP, 0, VReg.RET); // element @ [SP+0]
        // key = valueToStr(cb(element, index)) 装箱为 0x7ffc 串
        vm.mov(VReg.A1, VReg.RET); // element
        vm.mov(VReg.A0, VReg.S1); // cb
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A2, 0); // index number
        vm.call("_groupby_invoke2");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_valueToStr"); // RET 裸串指针
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 8, VReg.RET); // key @ [SP+8]
        // 已有分组?_object_get 未命中返回 undefined(high16≠0x7ffe)。
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_object_get");
        vm.store(VReg.SP, 16, VReg.RET); // 先落栈:命中则即为现存数组;否则即将被新数组覆盖
        // [x64 死表] 用 V3(≠RET)取 high16;勿用 V0(x64 V0==RET==RAX,shr 会毁 RET)。
        vm.shrImm(VReg.V3, VReg.RET, 48);
        vm.cmpImm(VReg.V3, 0x7ffe);
        vm.jeq("_ogb_push"); // 现存数组已在 [SP+16]
        // 新建装箱空数组
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, TAG_ARRAY);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 16, VReg.RET); // arr @ [SP+16](覆盖)
        vm.mov(VReg.A2, VReg.RET); // value = arr
        vm.load(VReg.A1, VReg.SP, 8); // key
        vm.mov(VReg.A0, VReg.S2); // result
        vm.call("_object_set");
        vm.label("_ogb_push");
        vm.load(VReg.A0, VReg.SP, 16);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_array_push");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_ogb_loop");

        vm.label("_ogb_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }
}
